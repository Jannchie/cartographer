import * as THREE from 'three'
import { NOISE_GLSL } from './glsl'
import { HEIGHT_GLSL } from './heightGLSL'

export interface TerrainUniforms {
  uMask: { value: THREE.Texture }
  uVScale: { value: number }
  uCloud: { value: THREE.Texture | null }
  uCloudRect: { value: THREE.Vector4 }
  uCloudY: { value: number }
  uCloudOn: { value: number }
  uSun: { value: THREE.Vector3 }
  uDetail: { value: number }
  uHeight: { value: THREE.Texture }
  uHSize: { value: THREE.Vector2 }
  uMapSize: { value: THREE.Vector2 }
  uDetailKm: { value: number }
}

/** 顶点着色器：高度在 GPU 上由双三次插值 + 亚网格细节求得，法线用有限差分 */
const VERTEX_HEIGHT = /* glsl */ `
  vec2 xzP = position.xz;
  float eN = uMapSize.x / (uHSize.x - 1.0) * 0.35;
  float hC = terrainHeight(xzP);
  float hX = terrainHeight(xzP + vec2(eN, 0.0));
  float hZ = terrainHeight(xzP + vec2(0.0, eN));
  vec3 objectNormal = normalize(vec3(-(hX - hC) * uVScale / eN, 1.0, -(hZ - hC) * uVScale / eN));
`

function injectVertex(sh: THREE.WebGLProgramParametersWithUniforms, withNormal: boolean) {
  sh.vertexShader = sh.vertexShader.replace(
    '#include <common>',
    `#include <common>\nuniform float uVScale;\n${NOISE_GLSL}\n${HEIGHT_GLSL}\nvarying vec3 vWorld;`,
  )
  if (withNormal) sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', VERTEX_HEIGHT)
  // 深度材质的顶点着色器里没有法线段，高度在这里求
  sh.vertexShader = sh.vertexShader
    .replace(
      '#include <begin_vertex>',
      (withNormal ? '' : 'float hC = terrainHeight(position.xz);\n') + 'vec3 transformed = vec3(position.x, hC * uVScale, position.z);',
    )
    .replace('#include <project_vertex>', '#include <project_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
}

/**
 * 地表材质：在 MeshStandardMaterial 上注入程序化细节，保留 three 的光照、阴影与雾。
 * - 树冠：蜂窝噪声画出一团团树冠与林间暗隙，按屏幕导数做 LOD 防闪烁
 * - 岩石：按世界法线坡度出现，带层理纹
 * - 沙滩 / 湿沙 / 旱地：由遮罩贴图控制
 * - 细节法线：微地形起伏，让低角度阳光下有真实的颗粒感
 * - 地平线 AO 与云影
 */
export function createTerrainMaterial(
  color: THREE.Texture,
  rough: THREE.Texture,
  mask: THREE.Texture,
  height: THREE.Texture,
  hSize: THREE.Vector2,
  mapSize: THREE.Vector2,
  vScale: number,
) {
  const mat = new THREE.MeshStandardMaterial({ map: color, roughnessMap: rough, roughness: 1, metalness: 0 })
  const uniforms: TerrainUniforms = {
    uMask: { value: mask },
    uVScale: { value: vScale },
    uCloud: { value: null },
    uCloudRect: { value: new THREE.Vector4(-100, -100, 200, 200) },
    uCloudY: { value: 3 },
    uCloudOn: { value: 0 },
    uSun: { value: new THREE.Vector3(0.5, 0.6, 0.3) },
    uDetail: { value: 1 },
    uHeight: { value: height },
    uHSize: { value: hSize },
    uMapSize: { value: mapSize },
    uDetailKm: { value: 1 },
  }
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    injectVertex(sh, true)
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorld;
uniform sampler2D uMask;
uniform float uVScale;
uniform sampler2D uCloud;
uniform vec4 uCloudRect;
uniform float uCloudY;
uniform float uCloudOn;
uniform vec3 uSun;
uniform float uDetail;
${NOISE_GLSL}
float gAO;
float gLod1;
float gLod2;
vec4 gMask;
/** 树冠格：返回 (像素相对树心的偏移.xy, 距离) */
vec3 crownCell(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 9.0;
  vec2 off = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(hash12(i + g), hash12(i + g + 19.19)) * 0.8 + 0.1;
    vec2 v = f - (g + o);
    float dd = dot(v, v);
    if (dd < d) { d = dd; off = v; }
  }
  return vec3(off, sqrt(d));
}
/** 把每棵树当成半球：受光面亮、背光面与树间空隙暗 */
float crownShade(vec3 c, vec3 L, float r) {
  if (c.z > r) return 0.42;
  vec3 n = normalize(vec3(c.x, sqrt(r * r - c.z * c.z) * 1.1, c.y));
  return 0.5 + 0.75 * max(dot(n, L), 0.0);
}
float detailH(vec2 p, vec4 m) {
  float h = fbm3(p * 5.0) * 0.5;
  // 树冠的鼓包
  h += (1.0 - smoothstep(0.1, 0.8, cells(p * 34.0))) * m.r * 0.5 * gLod2;
  h += (1.0 - smoothstep(0.15, 0.9, cells(p * 11.0))) * m.r * 0.35 * gLod1;
  return h;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `
vec4 texel = texture2D(map, vMapUv);
vec3 base = texel.rgb;
gMask = texture2D(uMask, vMapUv);
gAO = gMask.a;
vec2 P = vWorld.xz;
// LOD：像素覆盖的世界尺寸越大，高频细节越弱
float fw = length(fwidth(P));
gLod1 = 1.0 - smoothstep(0.02, 0.07, fw);
gLod2 = 1.0 - smoothstep(0.006, 0.025, fw);
float hKm = vWorld.y / uVScale;
vec3 wN0 = normalize(inverseTransformDirection(normalize(vNormal), viewMatrix));
float slope = 1.0 - wN0.y;
vec3 col = base;
if (hKm > 0.0) {
  // 大尺度色相起伏
  float hue = fbm3(P * 0.9);
  col *= mix(vec3(0.9, 0.95, 0.9), vec3(1.06, 1.0, 0.9), hue);
  float lum = dot(col, vec3(0.3, 0.59, 0.11));
  col = mix(vec3(lum), col, 0.86);
  // 草地与灌丛的斑驳
  float patchy = fbm3(P * 7.0);
  col *= 0.88 + 0.24 * mix(0.5, patchy, gLod1);
  // 树冠
  float f = gMask.r;
  if (f > 0.01) {
    vec3 Ls = normalize(uSun);
    // 三个尺度的树冠：林冠团块、单株树冠、近景细冠
    float s0 = crownShade(crownCell(P * 4.0), Ls, 0.62);
    float s1 = crownShade(crownCell(P * 13.0), Ls, 0.58);
    float s2 = crownShade(crownCell(P * 40.0), Ls, 0.55);
    float gLod0 = 1.0 - smoothstep(0.06, 0.2, fw);
    float crown = mix(0.85, s0, gLod0 * 0.6) * mix(0.85, s1, gLod1) * mix(0.9, s2, gLod2);
    vec3 leaf = base * mix(vec3(0.6, 0.68, 0.58), vec3(1.25, 1.28, 1.08), clamp(crown * 0.9, 0.0, 1.0));
    leaf *= mix(vec3(0.95, 1.0, 0.92), vec3(1.05, 1.02, 0.85), fbm3(P * 3.1 + 7.0));
    col = mix(col, leaf, f);
  }
  // 旱地：红褐与灰黄的土色斑，风成细纹
  float a = gMask.b;
  if (a > 0.01) {
    float dune = sin(P.x * 45.0 + fbm3(P * 3.0) * 9.0) * 0.5 + 0.5;
    vec3 soil = base * mix(vec3(1.02, 0.96, 0.9), vec3(0.94, 0.9, 0.86), fbm3(P * 4.0)) * (0.95 + 0.08 * dune * gLod1);
    col = mix(col, soil, a * 0.8);
  }
  // 沙滩与湿沙
  float s = gMask.g;
  vec3 sand = vec3(0.84, 0.75, 0.58) * (0.93 + 0.12 * fbm3(P * 20.0));
  vec3 wet = vec3(0.6, 0.55, 0.45);
  sand = mix(wet, sand, smoothstep(0.0015, 0.012, hKm));
  col = mix(col, sand, smoothstep(0.45, 0.9, s) * (1.0 - smoothstep(0.3, 0.5, slope)));
  // 岩石：陡坡露出基岩，带层理
  // 三平面投影：陡崖上的纹理不被拉伸
  vec3 bw = pow(abs(wN0), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z);
  float rn = fbm3(vWorld.zy * 9.0) * bw.x + fbm3(vWorld.xz * 9.0) * bw.y + fbm3(vWorld.xy * 9.0) * bw.z;
  float cr = (1.0 - smoothstep(0.0, 0.08, abs(vnoise(vWorld.xz * 14.0 + vWorld.y * 6.0) - 0.5))) * gLod1;
  float strata = sin(vWorld.y * 70.0 + rn * 6.0) * 0.5 + 0.5;
  vec3 rock = mix(vec3(0.44, 0.41, 0.37), vec3(0.68, 0.64, 0.58), rn) * (0.82 + 0.25 * strata * gLod1) * (1.0 - cr * 0.35);
  // 陡坡上岩石与植被斑驳相间，只有近乎垂直的崖壁才整片裸露
  float rk = smoothstep(0.5, 0.82, slope + (fbm3(P * 8.0) - 0.5) * 0.35) * (1.0 - gMask.r * 0.4);
  // 雪上不画岩
  float snowy = smoothstep(0.75, 0.9, min(base.r, min(base.g, base.b)));
  col = mix(col, rock, rk * (1.0 - snowy) * 0.9);
}
col *= mix(1.0, gAO, 0.85);
diffuseColor.rgb *= col;
`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (vWorld.y > 0.0 && uDetail > 0.0) {
  vec2 Q = vWorld.xz;
  float e = 0.004;
  float h0 = detailH(Q, gMask);
  float hx = detailH(Q + vec2(e, 0.0), gMask);
  float hz = detailH(Q + vec2(0.0, e), gMask);
  vec3 dW = vec3(-(hx - h0) / e, 0.0, -(hz - h0) / e) * 0.012 * uDetail;
  normal = normalize(normal + (viewMatrix * vec4(dW, 0.0)).xyz);
}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
if (uCloudOn > 0.5) {
  vec3 L = normalize(uSun);
  vec2 cp = vWorld.xz + L.xz / max(L.y, 0.08) * (uCloudY - vWorld.y);
  float cd = texture2D(uCloud, (cp - uCloudRect.xy) / uCloudRect.zw).r;
  float cs = 1.0 - 0.72 * smoothstep(0.05, 0.6, cd);
  reflectedLight.directDiffuse *= cs;
  reflectedLight.directSpecular *= cs;
}
reflectedLight.indirectDiffuse *= mix(1.0, gAO, 0.6);`,
      )
  }
  // 阴影深度材质：同样的顶点位移，否则阴影与地形错位
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  depth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    injectVertex(sh, false)
  }
  return { mat, uniforms, depth }
}
