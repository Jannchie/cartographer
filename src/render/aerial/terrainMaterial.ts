import * as THREE from 'three'
import { NOISE_GLSL } from './glsl'
import { BAKED_GLSL } from './bake'
import { HEIGHT_GLSL } from './heightGLSL'

export interface TerrainUniforms {
  uMask: { value: THREE.Texture }
  uMask2: { value: THREE.Texture }
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
  uBOrigin: { value: THREE.Vector2 }
  /** 视口高清块 (中心 x, 中心 z, 边长, 是否启用) */
  uPatch: { value: THREE.Vector4 }
  uColorSize: { value: THREE.Vector2 }
  uMaskSize: { value: THREE.Vector2 }
}

/** 顶点着色器：高度、坡度、侵蚀值都取自烘焙纹理（一次采样） */
const VERTEX_HEIGHT = /* glsl */ `
  vec4 B = bakedAt(pXZ);
  float hC = B.x;
  vErosion = B.w;
  vec3 objectNormal = normalize(vec3(-B.y * uVScale, 1.0, -B.z * uVScale));
`

/**
 * 顶点：粗网格的 position 就是世界坐标；高清块的 position 是 [0,1]² 的局部网格，
 * 由 uPatch 映射到世界，贴图坐标也按世界坐标重算。
 */
function injectVertex(sh: THREE.WebGLProgramParametersWithUniforms, withNormal: boolean, isPatch = false) {
  sh.vertexShader = sh.vertexShader.replace(
    '#include <common>',
    `#include <common>\nuniform float uVScale;\nuniform vec4 uPatch;\nuniform vec2 uMapSize;\nuniform vec2 uHSize;\n${BAKED_GLSL}\nvarying vec3 vWorld;\nvarying float vErosion;`,
  )
  sh.vertexShader = sh.vertexShader.replace(
    '#include <uv_vertex>',
    isPatch
      ? `vec2 pXZ = uPatch.xy + (position.xz - 0.5) * uPatch.z;
float skirt = position.y;
#include <uv_vertex>
vec2 tUv = ((pXZ / uMapSize + 0.5) * (uHSize - 1.0) + 0.5) / uHSize;
vMapUv = tUv;
vRoughnessMapUv = tUv;`
      : 'vec2 pXZ = position.xz;\n#include <uv_vertex>',
  )
  if (withNormal) sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', VERTEX_HEIGHT)
  // 深度材质的顶点着色器里没有法线段，高度在这里取
  sh.vertexShader = sh.vertexShader
    .replace(
      '#include <begin_vertex>',
      (withNormal ? '' : 'float hC = bakedAt(pXZ).x;\n') +
        'vec3 transformed = vec3(pXZ.x, hC * uVScale, pXZ.y);' +
        (isPatch ? '\ntransformed.y -= skirt * 0.03;' : ''),
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
  mask2: THREE.Texture,
  height: THREE.Texture,
  hSize: THREE.Vector2,
  mapSize: THREE.Vector2,
  vScale: number,
) {
  const mat = new THREE.MeshStandardMaterial({ map: color, roughnessMap: rough, roughness: 1, metalness: 0 })
  const uniforms: TerrainUniforms = {
    uMask: { value: mask },
    uMask2: { value: mask2 },
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
    uBOrigin: { value: new THREE.Vector2(0, 0) },
    uPatch: { value: new THREE.Vector4(0, 0, 0, 0) },
  }
  const compile = (u: TerrainUniforms, isPatch: boolean) => (sh: THREE.WebGLProgramParametersWithUniforms) => {
    Object.assign(sh.uniforms, u)
    injectVertex(sh, true, isPatch)
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <clipping_planes_fragment>',
        isPatch
          ? // 高清块超出沙盘的部分不画
            `#include <clipping_planes_fragment>
if (abs(vWorld.x) > uMapSize.x * 0.5 || abs(vWorld.z) > uMapSize.y * 0.5) discard;`
          : // 粗网格让出高清块覆盖的区域；接缝由高清块四周向下的裙边遮住（不用深度偏移，否则浅水岸线会随镜头跳动）
            `#include <clipping_planes_fragment>
if (uPatch.w > 0.5 && all(lessThan(abs(vWorld.xz - uPatch.xy), vec2(uPatch.z * 0.5 - 0.004)))) discard;`,
      )
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorld;
uniform sampler2D uMask;
uniform sampler2D uMask2;
uniform float uVScale;
uniform sampler2D uCloud;
uniform vec4 uCloudRect;
uniform float uCloudY;
uniform float uCloudOn;
uniform vec3 uSun;
uniform float uDetail;
uniform vec4 uPatch;
varying float vErosion;
${NOISE_GLSL}
${HEIGHT_GLSL}
float gAO;
float gLod1;
float gLod2;
vec4 gMask;
vec4 gMask2;
float gDune;
vec3 gEr;
float gErK;
float gPlainK;
uniform vec2 uColorSize;
uniform vec2 uMaskSize;
/** 三次 B 样条采样（4 次双线性采样合成）：放大后没有双线性插值的格子感 */
vec4 texBicubic(sampler2D t, vec2 uv, vec2 size, vec2 gx, vec2 gy) {
  vec2 st = uv * size - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / size;
  vec2 h1 = (i + 1.0 + w3 / g1 + 0.5) / size;
  return g0.y * (g0.x * textureGrad(t, h0, gx, gy) + g1.x * textureGrad(t, vec2(h1.x, h0.y), gx, gy))
       + g1.y * (g0.x * textureGrad(t, vec2(h0.x, h1.y), gx, gy) + g1.x * textureGrad(t, h1, gx, gy));
}
/**
 * 覆盖度 → 清晰而不规则的边界：与噪声阈值比较（不贴着纹素网格），
 * 远处像素覆盖大时退回平滑的覆盖度，避免闪烁。
 */
float organic(float cover, float n, float lod) {
  float th = 0.06 + 0.88 * n;
  return mix(cover, smoothstep(th - 0.12, th + 0.12, cover), lod);
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
/** 树冠格（带每格随机数）：返回 (像素相对树心的偏移.xy, 距离, 该树的随机数) */
vec4 crownCell2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 9.0;
  vec2 off = vec2(0.0);
  float hid = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(hash12(i + g), hash12(i + g + 19.19)) * 0.9 + 0.05;
    vec2 v = f - (g + o);
    float dd = dot(v, v);
    if (dd < d) { d = dd; off = v; hid = hash12(i + g + 7.7); }
  }
  return vec4(off, sqrt(d), hid);
}
/** 不规则树冠：每棵大小不同，轮廓起伏，冠内有叶团明暗 */
float crownShade2(vec4 c, vec3 L) {
  float r = 0.3 + 0.3 * c.w;
  float ang = atan(c.y, c.x);
  float rr = r * (0.86 + 0.1 * sin(ang * 5.0 + c.w * 40.0) + 0.06 * sin(ang * 9.0 + c.w * 17.0));
  if (c.z > rr) return 0.45 + 0.1 * c.w;
  vec2 q = c.xy / rr;
  vec3 n = normalize(vec3(q.x, sqrt(max(0.0, 1.0 - dot(q, q))) * 1.1, q.y));
  float lobes = vnoise(c.xy * 9.0 + c.w * 31.0);
  return (0.5 + 0.75 * max(dot(n, L), 0.0)) * (0.82 + 0.3 * lobes);
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
vec4 texel = texBicubic(map, vMapUv + wv * 0.9 / uColorSize, uColorSize, gdx, gdy);
vec3 base = texel.rgb;
gMask = texBicubic(uMask, vMapUv + wv * 1.1 / uMaskSize, uMaskSize, gdx, gdy);
gAO = gMask.a;
gMask2 = texBicubic(uMask2, vMapUv + wv * 1.1 / uMaskSize, uMaskSize, gdx, gdy);
gDune = 0.0;
// LOD：像素覆盖的世界尺寸越大，高频细节越弱
float fw = length(fwidth(P));
gLod1 = 1.0 - smoothstep(0.02, 0.07, fw);
gLod2 = 1.0 - smoothstep(0.006, 0.025, fw);
// 类别边界（森林 / 沙地 / 旱地 / 湿地 / 盐壳）按噪声阈值成形，放大后是自然的不规则轮廓
{
  float edgeLod = 1.0 - smoothstep(0.006, 0.04, fw);
  float nEdge = fbm3(P * 14.0 + wv * 3.0);
  gMask.r = organic(gMask.r, nEdge, edgeLod);
  gMask.b = organic(gMask.b, fbm3(P * 11.0 + 9.1), edgeLod);
  gMask2.b = organic(gMask2.b, nEdge, edgeLod);
  gMask2.a = organic(gMask2.a, fbm3(P * 13.0 + 2.2), edgeLod);
}
float hKm = vWorld.y / uVScale;
vec3 wN0 = normalize(inverseTransformDirection(normalize(vNormal), viewMatrix));
float slope = 1.0 - wN0.y;
// 顺坡的细冲沟（侵蚀噪声）：颜色与法线共用一次计算
gErK = smoothstep(0.08, 0.4, slope) * smoothstep(0.15, 0.8, hKm) * gLod1;
// 平原：坡度很小，按坡向单位化后驱动，得到顺坡汇集的细小汇水沟
gPlainK = (1.0 - smoothstep(0.06, 0.2, slope)) * smoothstep(0.003, 0.03, hKm) * gLod1;
vec2 gg = -wN0.xz / max(wN0.y, 0.25);
vec2 gdir = gg / max(length(gg), 1e-5);
vec2 gIn = mix(gdir * 0.6, gg, smoothstep(0.08, 0.3, slope));
gEr = (gErK > 0.001 || gPlainK > 0.001) ? erosionNoise(P, gIn, 3, 9.0) : vec3(0.5, 0.0, 0.0);
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
  vec4 m2 = gMask2;
  // 草地斑驳只画在缓坡上：坡面上的软边色斑像水渍
  float nonF = (1.0 - gMask.r) * (1.0 - gMask.b * 0.6) * (1.0 - smoothstep(0.12, 0.3, slope));
  // 草地上大小不一的枯黄斑与深绿斑（扭曲噪声，形状自然）
  float dry = smoothstep(0.52, 0.78, fbm3(P * 2.3 + wv * 3.0 + 13.0));
  float lush = smoothstep(0.55, 0.8, fbm3(P * 3.7 - wv * 2.0 + 71.0));
  col = mix(col, col * vec3(1.3, 1.12, 0.62), dry * nonF * (1.0 - m2.r) * 0.75);
  col = mix(col, col * vec3(0.72, 0.9, 0.72), lush * nonF * 0.55);
  // 中尺度的草甸斑驳：土壤水分的细碎差异
  float mott = fbm3(P * 9.0 + wv * 2.5 + 29.0);
  col *= mix(vec3(1.0), mix(0.86, 1.12, mott) * mix(vec3(1.0), vec3(1.06, 1.02, 0.9), mott), nonF * gLod1);
  // 灌丛：成片分布的小灌木团，受光面亮、背光面暗
  float shrubZone = smoothstep(0.45, 0.75, fbm3(P * 5.0 + 3.3)) * nonF;
  if (shrubZone * gLod2 > 0.01) {
    vec3 sc = crownCell(P * 110.0);
    float inS = 1.0 - smoothstep(0.24, 0.3, sc.z);
    float sd = crownShade(sc, normalize(uSun), 0.3);
    col = mix(col, col * vec3(0.62, 0.72, 0.56) * (0.7 + 0.5 * sd), inS * shrubZone * gLod2 * 0.8);
  }
  // 河岸：沿河谷的茂密湿润植被
  col = mix(col, col * vec3(0.72, 0.9, 0.7), m2.r * (1.0 - gMask.b * 0.5) * 0.65);
  // 湿地：星罗棋布的小水塘
  float pn = vnoise(P * 55.0 + 5.0) * 0.7 + vnoise(P * 140.0) * 0.3;
  float pond = smoothstep(0.76, 0.79, pn) * smoothstep(0.5, 0.9, m2.b) * gLod1;
  // 水塘：映出天光的灰蓝水面，外圈一道深绿的水生植被
  float reed = smoothstep(0.7, 0.76, pn) * smoothstep(0.5, 0.9, m2.b) * gLod1;
  col = mix(col, col * vec3(0.7, 0.85, 0.7), reed * 0.6);
  col = mix(col, vec3(0.1, 0.15, 0.18), pond * 0.85);
  // 平原汇水细沟：沟里湿润、植被更深更绿（沙地与雪地不画）
  float rill = 1.0 - smoothstep(0.1, 0.55, gEr.x);
  col = mix(col, col * vec3(0.7, 0.86, 0.68), rill * gPlainK * (1.0 - gMask.g) * 0.85);
  col *= mix(1.0, 0.86 + 0.26 * smoothstep(0.3, 0.9, gEr.x), gPlainK);
  // 树冠
  float f = gMask.r;
  if (f > 0.01) {
    vec3 Ls = normalize(uSun);
    // 单株树冠 + 近景细冠；远处淡出为均匀的林冠色，不再出现大块斑
    float s1 = crownShade2(crownCell2(P * 16.0), Ls);
    float s2 = crownShade2(crownCell2(P * 44.0 + 3.1), Ls);
    float crown = mix(0.8, s1, gLod1 * 0.8) * mix(0.9, s2, gLod2 * 0.7);
    vec3 leaf = base * mix(vec3(0.74, 0.8, 0.72), vec3(1.14, 1.16, 1.02), clamp(crown * 0.95, 0.0, 1.0));
    leaf *= mix(vec3(0.95, 1.0, 0.92), vec3(1.05, 1.02, 0.85), fbm3(P * 3.1 + 7.0));
    // 林相：浅黄绿的阔叶林斑块与深青的针叶林斑块交错
    leaf *= mix(vec3(1.0), vec3(1.16, 1.12, 0.82), smoothstep(0.52, 0.76, fbm3(P * 4.5 + wv * 2.0 + 11.0)));
    leaf *= mix(vec3(1.0), vec3(0.76, 0.86, 0.9), smoothstep(0.55, 0.8, fbm3(P * 3.7 - wv * 2.0 + 23.0)));
    // 林间空地：密林里露出的草甸
    float glade = 1.0 - smoothstep(0.2, 0.28, fbm3(P * 3.3 + wv * 2.5 + 50.0));
    col = mix(col, leaf, f * (1.0 - glade * 0.85));
  }
  // 旱地：红褐与灰黄的土色斑，风成细纹
  float a = gMask.b;
  if (a > 0.01) {
    float dune = sin(P.x * 45.0 + fbm3(P * 3.0) * 9.0) * 0.5 + 0.5;
    vec3 soil = base * mix(vec3(1.02, 0.96, 0.9), vec3(0.94, 0.9, 0.86), fbm3(P * 4.0)) * (0.95 + 0.08 * dune * gLod1);
    col = mix(col, soil, a * 0.8);
    // 沙海：橙黄色的沙丘区（沙脊的明暗在法线阶段）
    gDune = smoothstep(0.6, 0.9, a) * smoothstep(0.25, 0.55, gMask.g) * (1.0 - smoothstep(0.08, 0.2, slope)) * smoothstep(0.02, 0.1, hKm);
    col = mix(col, pow(vec3(0.86, 0.67, 0.44), vec3(2.2)) * (0.92 + 0.12 * fbm3(P * 6.0)), gDune * 0.45);
    // 砾漠：平地上深色的荒漠漆斑（坡面不画，否则像水渍）
    float rocky = a * (1.0 - gDune) * (1.0 - smoothstep(0.04, 0.12, slope));
    float varn = smoothstep(0.55, 0.75, fbm3(P * 7.0 + wv * 4.0));
    col = mix(col, col * vec3(0.78, 0.7, 0.64), varn * rocky * 0.4);
  }
  // 农田：城镇周边的田块拼布。按大区换朝向，砖式错缝的长条田，田间是树篱；
  // 近看有犁沟，远处淡出为深浅不一的色块
  float farm = gMask2.g * (1.0 - smoothstep(0.1, 0.22, slope)) * (1.0 - smoothstep(0.3, 0.6, gMask.g)) * (1.0 - gMask.b * 0.7);
  if (farm > 0.02) {
    // 大区（庄园）：蜂窝分区，每区一个朝向与田块尺寸
    vec4 est = crownCell2(P * 2.2 + wv * 0.6);
    // 远处：田块小于像素，退成按大区起伏的均匀色调（逐田块的计算整个跳过）
    vec3 fieldCol = mix(vec3(0.36, 0.38, 0.17), vec3(0.46, 0.4, 0.2), est.w);
    float keep = 0.55;
    if (gLod1 > 0.01) {
      float ang = est.w * 3.14159;
      mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
      vec2 q = rot * P * (26.0 + 14.0 * est.w);
      // 长条田：行高 1，行内按哈希错缝切成长短不一的段
      float row = floor(q.y);
      float xo = q.x * 0.45 + hash12(vec2(row, est.w * 91.0)) * 7.0;
      vec2 fid = vec2(floor(xo), row) + est.w * 53.0;
      vec2 fl = vec2(fract(xo), fract(q.y));
      float h = hash12(fid);
      float h2 = hash12(fid + 17.3);
      // 作物：金黄麦田、青绿作物、浅绿牧场、褐色休耕、深色新翻地
      vec3 crop = h < 0.26 ? vec3(0.62, 0.5, 0.2) : h < 0.52 ? vec3(0.24, 0.34, 0.1) : h < 0.72 ? vec3(0.34, 0.42, 0.17) : h < 0.88 ? vec3(0.42, 0.36, 0.2) : vec3(0.27, 0.21, 0.12);
      crop *= 0.88 + 0.24 * h2;
      // 犁沟与作物行：沿田块长边的细纹
      float furrow = 0.5 + 0.5 * sin((fl.y + h2) * 6.2832 * (5.0 + floor(h2 * 4.0)));
      crop *= 1.0 - 0.14 * furrow * gLod3;
      // 树篱：田埂上的深绿细线（按屏幕导数定宽，远处淡出）
      vec2 edge = min(fl, 1.0 - fl) / max(fwidth(vec2(xo, q.y)), vec2(1e-4));
      float hedge = (1.0 - smoothstep(0.6, 1.6, min(edge.x, edge.y))) * gLod2;
      fieldCol = mix(fieldCol, mix(crop, vec3(0.1, 0.16, 0.06), hedge * 0.75), gLod1);
      // 边缘田块零散：农田度低的地方只开垦一部分
      keep = mix(0.55, smoothstep(h2 * 0.8, h2 * 0.8 + 0.15, farm * 1.2), gLod1);
    }
    // 保留一点底色的明暗，免得和地形脱节
    float lumB = dot(col, vec3(0.3, 0.59, 0.11));
    fieldCol *= 0.75 + 0.5 * smoothstep(0.05, 0.3, lumB);
    // 与周围地表同一个色调，拼布不显得突兀
    fieldCol = mix(fieldCol, col * vec3(1.05, 1.02, 0.9), 0.25);
    col = mix(col, fieldCol, smoothstep(0.02, 0.35, farm) * keep * 0.85);
  }
  // 盐壳：白色结皮，龟裂成多边形，边缘是褐色泥滩
  float sf = gMask2.a;
  if (sf > 0.02) {
    vec3 crust = pow(vec3(0.9, 0.88, 0.84), vec3(2.2)) * (0.9 + 0.1 * fbm3(P * 20.0));
    float crack = max(1.0 - smoothstep(0.0, 0.035, abs(vnoise(P * 70.0) - 0.5)), 1.0 - smoothstep(0.0, 0.035, abs(vnoise(P * 70.0 * mat2(0.8, -0.6, 0.6, 0.8) + 9.0) - 0.5)));
    crust *= 1.0 - crack * 0.3 * gLod2;
    col = mix(col, col * vec3(0.8, 0.72, 0.62), smoothstep(0.05, 0.35, sf) * 0.6);
    col = mix(col, crust, smoothstep(0.35, 0.75, sf));
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
  // 岩性：不同山体偏暖（砂岩、红层）或偏冷（花岗岩、板岩）
  rock *= mix(vec3(1.08, 0.94, 0.82), vec3(0.9, 0.95, 1.03), fbm3(P * 0.7 + 40.0));
  // 陡坡上岩石与植被斑驳相间，只有近乎垂直的崖壁才整片裸露
  // 露岩跟着侵蚀结构走：刃脊与陡崖露岩，冲沟里留着土和植被
  float rk = smoothstep(0.42, 0.72, slope + (vErosion - 0.5) * 0.45 + (fbm3(P * 8.0) - 0.5) * 0.1) * (1.0 - gMask.r * 0.4);
  // 雪上不画岩
  float snowy = smoothstep(0.75, 0.9, min(base.r, min(base.g, base.b)));
  col = mix(col, rock, rk * (1.0 - snowy) * 0.9);
  // 风化：冲沟暗、刃脊亮，山地越陡越明显
  float mnt = smoothstep(0.12, 0.45, slope) * smoothstep(0.2, 1.2, hKm);
  col *= mix(1.0, mix(0.78, 1.12, smoothstep(0.15, 0.85, vErosion)), mnt);
  // 近景：沟暗脊亮的顺坡冲刷纹，取代被放大的低分辨率底色斑
  col *= mix(1.0, 0.76 + 0.44 * smoothstep(0.15, 0.85, gEr.x), gErK);
}
col *= mix(1.0, gAO, 0.5);
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
  if (gErK > 0.001) dW += vec3(-gEr.y, 0.0, -gEr.z) * 0.0032 * gErK * uDetail;
  if (gPlainK > 0.001) dW += vec3(-gEr.y, 0.0, -gEr.z) * 0.0022 * gPlainK * uDetail;
  // 沙丘：迎风缓坡、背风陡坡的新月形沙脊，沙脊随区域风向弯曲
  if (gDune > 0.01 && fw < 0.012) {
    // 盛行风向全图一致（随位置变化的风向会让相位绕成同心环）
    vec2 wd = vec2(0.85, 0.53);
    vec2 wp = vec2(-wd.y, wd.x);
    // 横向沙脊：大体垂直风向、沿脊线蜿蜒；脊高沿脊线起伏，断续处成新月形
    float along = dot(Q, wp);
    float u = dot(Q, wd) * 24.0 + (fbm3(Q * 1.6) - 0.5) * 3.0 + sin(along * 38.0 + fbm3(Q * 4.0) * 3.0) * 0.18;
    float c = fract(u);
    // 迎风缓坡、背风陡坡，脊顶圆滑
    float dh = mix(1.0 / 0.72, -1.0 / 0.28, smoothstep(0.66, 0.78, c)) * smoothstep(0.0, 0.08, c);
    float A = 0.0014 * (0.35 + 0.65 * smoothstep(0.2, 0.8, vnoise(vec2(along * 20.0, floor(u) * 1.7))));
    float dl = 1.0 - smoothstep(0.004, 0.012, fw);
    dW -= vec3(wd.x, 0.0, wd.y) * A * 24.0 * dh * gDune * dl;
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
  mat.customProgramCacheKey = () => 'terrain'
  mat.onBeforeCompile = compile(uniforms, false)
  /** 视口高清块的材质：共用贴图与大部分 uniform，只换烘焙纹理与映射 */
  const makePatch = (baked: THREE.Texture, N: number) => {
    const pm = new THREE.MeshStandardMaterial({ map: color, roughnessMap: rough, roughness: 1, metalness: 0 })
    const pu: TerrainUniforms = {
      ...uniforms,
      uBaked: { value: baked },
      uGSize: { value: new THREE.Vector2(N, N) },
      uBMapSize: { value: new THREE.Vector2(1, 1) },
      uBOrigin: { value: new THREE.Vector2() },
    }
    pm.customProgramCacheKey = () => 'terrain-patch'
    pm.onBeforeCompile = compile(pu, true)
    return { mat: pm, uniforms: pu }
  }
  // 阴影深度材质：同样的顶点位移，否则阴影与地形错位
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  depth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    injectVertex(sh, false)
  }
  return { mat, uniforms, depth, makePatch }
}
