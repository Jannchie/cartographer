import * as THREE from 'three'
import { NOISE_GLSL } from './glsl'
import { BAKED_GLSL } from './bake'
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
  uBaked: { value: THREE.Texture | null }
  uGSize: { value: THREE.Vector2 }
  uBMapSize: { value: THREE.Vector2 }
  uColorSize: { value: THREE.Vector2 }
  uMaskSize: { value: THREE.Vector2 }
}

/** 顶点着色器：高度、坡度、侵蚀值都取自烘焙纹理（一次采样） */
const VERTEX_HEIGHT = /* glsl */ `
  vec4 B = bakedAt(position.xz);
  float hC = B.x;
  vErosion = B.w;
  vec3 objectNormal = normalize(vec3(-B.y * uVScale, 1.0, -B.z * uVScale));
`

function injectVertex(sh: THREE.WebGLProgramParametersWithUniforms, withNormal: boolean) {
  sh.vertexShader = sh.vertexShader.replace(
    '#include <common>',
    `#include <common>\nuniform float uVScale;\n${BAKED_GLSL}\nvarying vec3 vWorld;\nvarying float vErosion;`,
  )
  if (withNormal) sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', VERTEX_HEIGHT)
  // 深度材质的顶点着色器里没有法线段，高度在这里取
  sh.vertexShader = sh.vertexShader
    .replace(
      '#include <begin_vertex>',
      (withNormal ? '' : 'float hC = bakedAt(position.xz).x;\n') + 'vec3 transformed = vec3(position.x, hC * uVScale, position.z);',
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
    uBaked: { value: null },
    uGSize: { value: new THREE.Vector2(1, 1) },
    uBMapSize: { value: mapSize },
    uColorSize: { value: new THREE.Vector2((color.image as { width: number }).width, (color.image as { height: number }).height) },
    uMaskSize: { value: new THREE.Vector2(hSize.x, hSize.y) },
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
varying float vErosion;
${NOISE_GLSL}
${HEIGHT_GLSL}
float gAO;
float gLod1;
float gLod2;
vec4 gMask;
uniform vec2 uColorSize;
uniform vec2 uMaskSize;
vec2 sharpUv(vec2 uv, vec2 size, vec2 warp) {
  vec2 st = uv * size - 0.5 + warp;
  vec2 i = floor(st);
  vec2 f = fract(st);
  f = smoothstep(0.22, 0.78, f);
  return (i + f + 0.5) / size;
}
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
`,
      )
      .replace(
        '#include <map_fragment>',
        `
vec2 P = vWorld.xz;
// 锐化扭曲采样：噪声推开采样点、再把纹素间的线性插值收窄，
// 低分辨率的群系色与遮罩在任意放大倍率下都呈现清晰而不规则的自然边界
vec2 wv = vec2(fbm3(P * 7.0), fbm3(P * 7.0 + 31.7)) - 0.5;
vec2 gdx = dFdx(vMapUv);
vec2 gdy = dFdy(vMapUv);
// 连续的颜色只做扭曲（不锐化，避免把渐变变成台阶）；分类遮罩才锐化
vec4 texel = textureGrad(map, vMapUv + wv * 1.8 / uColorSize, gdx, gdy);
vec3 base = texel.rgb;
gMask = textureGrad(uMask, sharpUv(vMapUv, uMaskSize, wv * 1.1), gdx, gdy);
gAO = gMask.a;
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
  // 草地与灌丛的细斑驳（幅度小、频率高，远处淡出）
  float patchy = fbm3(P * 11.0);
  col *= 0.95 + 0.1 * mix(0.5, patchy, gLod1);
  // 近景细节：草丛/灌丛的颗粒与细碎明暗，按屏幕导数逐级淡出，远处不闪烁
  float g1 = fbm3(P * 42.0 + 3.1);
  float g2 = vnoise(P * 150.0) * 0.6 + vnoise(P * 380.0) * 0.4;
  float gLod3 = 1.0 - smoothstep(0.002, 0.008, fw);
  col *= (0.93 + 0.14 * mix(0.5, g1, gLod2)) * (0.95 + 0.1 * mix(0.5, g2, gLod3));
  // 草地里零星的深色灌丛点
  float bush = smoothstep(0.72, 0.8, vnoise(P * 95.0 + 17.0)) * gLod2 * (1.0 - gMask.r) * (1.0 - gMask.b * 0.7);
  col *= 1.0 - bush * 0.35;
  // 树冠
  float f = gMask.r;
  if (f > 0.01) {
    vec3 Ls = normalize(uSun);
    // 单株树冠 + 近景细冠；远处淡出为均匀的林冠色，不再出现大块斑
    float s1 = crownShade(crownCell(P * 16.0), Ls, 0.6);
    float s2 = crownShade(crownCell(P * 44.0), Ls, 0.56);
    float crown = mix(0.8, s1, gLod1 * 0.8) * mix(0.9, s2, gLod2 * 0.7);
    vec3 leaf = base * mix(vec3(0.74, 0.8, 0.72), vec3(1.14, 1.16, 1.02), clamp(crown * 0.95, 0.0, 1.0));
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
  // 风化：冲沟暗、刃脊亮，山地越陡越明显
  float mnt = smoothstep(0.12, 0.45, slope) * smoothstep(0.2, 1.2, hKm);
  col *= mix(1.0, mix(0.7, 1.12, smoothstep(0.15, 0.85, vErosion)), mnt);
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
  vec3 dW = vec3(0.0);
  // 逐像素风化法线：沿当前坡向的细冲沟（相当于一张程序化的侵蚀法线贴图）
  vec3 wN = normalize(inverseTransformDirection(normal, viewMatrix));
  float st = 1.0 - wN.y;
  float mk = smoothstep(0.08, 0.4, st) * smoothstep(0.15, 0.8, vWorld.y / uVScale) * gLod1;
  if (mk > 0.001) {
    vec2 gW = -wN.xz / max(wN.y, 0.25);
    vec3 er = erosionNoise(Q, gW, 3, 9.0);
    dW += vec3(-er.y, 0.0, -er.z) * 0.0032 * mk * uDetail;
  }
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
