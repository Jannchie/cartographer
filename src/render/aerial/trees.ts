import * as THREE from 'three'
import { Biome, type World } from '../../gen/types'
import { riverThreshold } from '../../gen/world'
import { vnoise } from '../atlas/fields'
import { BAKED_GLSL } from './bake'
import type { TerrainUniforms } from './terrainMaterial'

/**
 * 植被：按森林遮罩在林区里撒几十万棵单株树（针叶 / 阔叶 / 热带伞冠三种）。
 *  - 每棵树是一张朝向相机的面片，树形在片元里逐像素求解：
 *    阔叶是由一簇簇叶团组成的起伏球冠，针叶是按视角把"圆锥 + 底面椭圆"投影出来的层叠塔形，
 *    热带树是扁平伞冠；法线按树冠形体解析求出，接入场景的日光、天光与阴影。
 *    细节与屏幕像素一样精细，而每棵树只有 4 个顶点。
 *  - 实例只存 (x, z, 尺寸, 种子) 与颜色，高度在顶点着色器里取烘焙地形，永远贴地；
 *  - 按区块做视距 LOD：远处由地表的程序化树冠承担，拉近后单株树逐渐长出来；
 *  - 每棵树带一块沿太阳反方向拉长的接触阴影，贴在地形上。
 */

const CX = 16
const CZ = 10
/** 视距淡入：uNear 内全部显示，uFar 外全部隐藏（每棵树有随机阈值，渐隐而不是整片跳变） */
const NEAR = 6
const FAR = 15
const MAX_TREES = 900_000

type Species = 0 | 1 | 2 // 针叶 / 阔叶 / 热带伞冠

interface Chunk {
  x0: number
  x1: number
  z0: number
  z1: number
  maxE: number
  meshes: THREE.Mesh[]
}

export class Forest {
  readonly group = new THREE.Group()
  private chunks: Chunk[] = []
  private mats: THREE.MeshStandardMaterial[]
  private blobMat: THREE.ShaderMaterial
  private u: TerrainUniforms
  private lod = { uNear: { value: NEAR }, uFar: { value: FAR } }
  private blobStrength = { value: 0.4 }
  private quad = quadGeometry()

  constructor(world: World, mask: Uint8Array, color: HTMLCanvasElement, SX: number, SZ: number, terrainU: TerrainUniforms) {
    this.u = terrainU
    this.mats = [0, 1, 2].map((s) => this.createTreeMaterial(s as Species))
    this.blobMat = this.createBlobMaterial()
    const data = scatter(world, mask, color, SX, SZ)
    for (let cz = 0; cz < CZ; cz++) {
      for (let cx = 0; cx < CX; cx++) {
        const c = data.chunks[cz * CX + cx]
        const chunk: Chunk = {
          x0: (cx / CX - 0.5) * SX,
          x1: ((cx + 1) / CX - 0.5) * SX,
          z0: (cz / CZ - 0.5) * SZ,
          z1: ((cz + 1) / CZ - 0.5) * SZ,
          maxE: c.maxE,
          meshes: [],
        }
        const r = Math.hypot(chunk.x1 - chunk.x0, chunk.z1 - chunk.z0) / 2
        const sphere = new THREE.Sphere(new THREE.Vector3((chunk.x0 + chunk.x1) / 2, 0, (chunk.z0 + chunk.z1) / 2), r + 12)
        for (let s = 0; s < 3; s++) {
          const n = c.count[s]
          if (!n) continue
          const iData = new THREE.InstancedBufferAttribute(Float32Array.from(c.data[s]), 4)
          const iCol = new THREE.InstancedBufferAttribute(Uint8Array.from(c.col[s]), 4, true)
          const tm = new THREE.Mesh(instanced(this.quad, n, { iData, iCol }, sphere), this.mats[s])
          tm.receiveShadow = true
          const bm = new THREE.Mesh(instanced(this.quad, n, { iData }, sphere), this.blobMat)
          bm.renderOrder = 1
          chunk.meshes.push(tm, bm)
          this.group.add(tm, bm)
        }
        if (chunk.meshes.length) this.chunks.push(chunk)
      }
    }
  }

  /** 每帧：按相机到区块包围盒的距离开关区块（超出视距的区块整批不画） */
  update(camera: THREE.Camera) {
    if (!this.group.visible) return
    const p = camera.position
    const vs = this.u.uVScale.value
    const far = this.lod.uFar.value + 1
    for (const c of this.chunks) {
      const dx = Math.max(c.x0 - p.x, 0, p.x - c.x1)
      const dz = Math.max(c.z0 - p.z, 0, p.z - c.z1)
      const dy = Math.max(0, p.y - c.maxE * vs)
      const on = dx * dx + dy * dy + dz * dz < far * far
      for (const m of c.meshes) m.visible = on
    }
  }

  /** 太阳变化：接触阴影随日照强度增减 */
  setSunStrength(k: number) {
    this.blobStrength.value = 0.42 * k
  }

  dispose() {
    for (const c of this.chunks) for (const m of c.meshes) m.geometry.dispose()
    this.quad.dispose()
    for (const m of this.mats) m.dispose()
    this.blobMat.dispose()
  }

  private createTreeMaterial(species: Species) {
    // alphaToCoverage：配合多重采样，树冠边缘平滑而不是锯齿
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, alphaToCoverage: true })
    const u = this.u
    // 三个树种共用同一个 onBeforeCompile 源码，缓存键必须区分，否则会复用同一个着色器程序
    mat.customProgramCacheKey = () => `tree${species}`
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {
        uBaked: u.uBaked,
        uGSize: u.uGSize,
        uBMapSize: u.uBMapSize,
        uVScale: u.uVScale,
        uSun: u.uSun,
        uCloud: u.uCloud,
        uCloudRect: u.uCloudRect,
        uCloudY: u.uCloudY,
        uCloudOn: u.uCloudOn,
        ...this.lod,
      })
      sh.defines = { ...sh.defines, SPECIES: species }
      sh.vertexShader = sh.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 iData;
attribute vec4 iCol;
uniform float uVScale;
uniform float uNear;
uniform float uFar;
${BAKED_GLSL}
${INSTANCE_GLSL}
${CROWN_PARAMS}
vec3 crownBounds(vec2 pitch) {
#if SPECIES == 0
  float by = 0.14 * pitch.x;
  return vec3(0.34, by - 0.3 * pitch.y - 0.02, max(pitch.x, by + 0.3 * pitch.y) + 0.02);
#else
  float ry = sqrt(CR_V * CR_V * pitch.x * pitch.x + CR_R * CR_R * pitch.y * pitch.y) * 1.06;
  return vec3(CR_R * 1.06, min(-0.02, CR_H * pitch.x - ry), CR_H * pitch.x + ry);
#endif
}
varying vec2 vQ;
varying vec2 vPitch;
varying float vSeed;
varying vec3 vTreeCol;
varying vec3 vWorldT;`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 G = treeGround(iData);
float h = iData.z * treeFade(iData, G);
// 面片沿相机的右、上方向展开（观察空间基向量在世界中的表示）
vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
vec3 toCam = normalize(cameraPosition - G);
// 俯仰：世界竖直方向在屏幕上的投影长度 cosφ，水平圆的压扁比 sinφ
float sinP = clamp(toCam.y, 0.05, 1.0);
vPitch = vec2(sqrt(1.0 - sinP * sinP), sinP);
// 面片按当前俯仰贴合树形的投影范围，减少被丢弃的像素
vec3 qb = crownBounds(vPitch);
vQ = vec2(position.x * qb.x, mix(qb.y, qb.z, position.y));
vSeed = iData.w;
// 往相机方向推半个树高，避免面片下沿插进坡地
vec3 transformed = G + (camR * vQ.x + camU * vQ.y) * h + toCam * h * 0.5;
vWorldT = transformed;
vTreeCol = pow(iCol.rgb, vec3(2.2));`,
        )
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec2 vQ;
varying vec2 vPitch;
varying float vSeed;
varying vec3 vTreeCol;
varying vec3 vWorldT;
uniform sampler2D uCloud;
uniform vec4 uCloudRect;
uniform float uCloudY;
uniform float uCloudOn;
uniform vec3 uSun;
${CROWN_PARAMS}
${CROWN_GLSL}`,
        )
        .replace(
          '#include <color_fragment>',
          `vec3 gTreeN;
float gCov;
vec3 alb = treeShade(vQ, vPitch, vSeed, vTreeCol, gTreeN, gCov);
if (gCov <= 0.001) discard;
diffuseColor = vec4(alb, gCov);`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `float faceDirection = 1.0;
vec3 normal = gTreeN;
vec3 nonPerturbedNormal = normal;`,
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
if (uCloudOn > 0.5) {
  vec3 L = normalize(uSun);
  vec2 cp = vWorldT.xz + L.xz / max(L.y, 0.08) * (uCloudY - vWorldT.y);
  float cd = texture2D(uCloud, (cp - uCloudRect.xy) / uCloudRect.zw).r;
  float cs = 1.0 - 0.72 * smoothstep(0.05, 0.6, cd);
  reflectedLight.directDiffuse *= cs;
  reflectedLight.directSpecular *= cs;
}`,
        )
    }
    return mat
  }

  private createBlobMaterial() {
    const u = this.u
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: {
        uBaked: u.uBaked,
        uGSize: u.uGSize,
        uBMapSize: u.uBMapSize,
        uVScale: u.uVScale,
        uSun: u.uSun,
        uStrength: this.blobStrength,
        ...this.lod,
      },
      vertexShader: /* glsl */ `
        attribute vec4 iData;
        uniform float uVScale;
        uniform float uNear;
        uniform float uFar;
        uniform vec3 uSun;
        ${BAKED_GLSL}
        ${INSTANCE_GLSL}
        varying vec2 vC;
        void main() {
          vec3 g = treeGround(iData);
          float sc = iData.z * treeFade(iData, g);
          // 影子沿太阳反方向偏移、拉长；太阳越低影子越长
          vec3 L = normalize(uSun);
          float horiz = max(length(L.xz), 1e-3);
          vec2 dir = -L.xz / horiz;
          float len = clamp(horiz / max(L.y, 0.2), 0.15, 3.0);
          vec2 perp = vec2(-dir.y, dir.x);
          vC = vec2(position.x, position.y * 2.0 - 1.0);
          vec2 q = dir * (vC.y * (0.3 + 0.18 * len) + 0.4 * len) + perp * vC.x * 0.3;
          vec2 xz = iData.xy + q * sc;
          float y = max(bakedAt(xz).x, 0.0) * uVScale + 0.001;
          gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
          if (sc < 1e-5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        varying vec2 vC;
        void main() {
          float a = 1.0 - smoothstep(0.2, 1.0, length(vC));
          if (a <= 0.0) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, uStrength * a);
        }
      `,
    })
  }
}

/** 树与接触阴影共用：地面位置与视距淡出 */
const INSTANCE_GLSL = /* glsl */ `
vec3 treeGround(vec4 d) {
  return vec3(d.x, max(bakedAt(d.xy).x, 0.0) * uVScale, d.y);
}
float treeFade(vec4 d, vec3 g) {
  float r0 = mix(uNear, uFar, fract(d.w * 7.31) * 0.75);
  return 1.0 - smoothstep(r0, r0 + (uFar - uNear) * 0.25, distance(cameraPosition, g));
}
`

/** 阔叶 / 热带树冠：水平半径、中心高度、竖直半径（树高为单位） */
const CROWN_PARAMS = /* glsl */ `
#if SPECIES == 1
#define CR_R 0.36
#define CR_H 0.62
#define CR_V 0.36
#else
#define CR_R 0.44
#define CR_H 0.8
#define CR_V 0.15
#endif
`

/**
 * 逐像素树形。q：面片坐标（树高为单位，地面点为原点，x 右 y 上）；
 * pitch = (cosφ, sinφ)。输出反照率、观察空间法线 n 与覆盖度 cov（0 为树外）。
 */
const CROWN_GLSL = /* glsl */ `
vec2 th2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
/** 叶团：Voronoi 格，返回 (像素相对叶团中心的偏移.xy, 与相邻叶团的间隙) */
vec3 leafClumps(vec2 p, float seed) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  vec2 o1 = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = g + th2(i + g + seed) * 0.8 + 0.1 - f;
    float d = dot(o, o);
    if (d < d1) { d2 = d1; d1 = d; o1 = o; }
    else if (d < d2) d2 = d;
  }
  return vec3(-o1, sqrt(d2) - sqrt(d1));
}
/** 覆盖度：带符号距离 → 抗锯齿的 0..1 */
float cover(float sd) {
  return clamp(sd / max(fwidth(sd), 1e-5) + 0.5, 0.0, 1.0);
}
vec3 treeShade(vec2 q, vec2 pitch, float seed, vec3 col, out vec3 n, out float cov) {
  vec3 upV = vec3(0.0, pitch.x, pitch.y); // 世界竖直方向在观察空间
  float s1 = seed * 61.7, s2 = seed * 23.3;
  vec3 alb = col;
  cov = 0.0;
  // 每像素覆盖多少树高：树只有十几个像素高时不再算细叶簇
  float detail = 1.0 - smoothstep(0.03, 0.07, fwidth(q.y));
  n = upV;
#if SPECIES == 0
  // 针叶：顶点 (0, cosφ)，底面是半径 r 的水平圆（投影为椭圆），层层下垂的枝层
  float r = 0.3;
  float by = 0.14 * pitch.x;
  float t = (q.y - by) / max(pitch.x - by, 1e-3);
  float tier = fract(t * 4.5 + seed * 3.0);
  float w = r * (1.0 - t) * (0.7 + 0.3 * (1.0 - tier));
  w *= 1.0 + 0.12 * (th2(vec2(floor(t * 4.5 + seed * 3.0), s1)).x - 0.5);
  float sdT = (t >= 0.0 && t <= 1.0) ? (w - abs(q.x)) : -1.0;
  // 俯视时底面像一颗星：枝条向外放射
  vec2 e = vec2(q.x, (q.y - by) / max(pitch.y, 0.05));
  float ang = atan(e.y, e.x);
  float rs = r * (0.82 + 0.16 * sin(ang * 9.0 + s1) * sin(ang * 4.0 + s2));
  float sdE = (rs - length(e)) * min(1.0, pitch.y * 1.5);
  float sd = max(sdT, sdE);
  cov = cover(sd);
  // 法线：锥面（侧看）与伞面（俯看）按哪部分在外来取
  float sx = clamp(q.x / max(w, 1e-3), -1.0, 1.0);
  vec3 nT = normalize(vec3(sx * 0.85, 0.35 + 0.55 * (1.0 - tier), sqrt(max(0.0, 1.0 - sx * sx)) * 0.7));
  vec2 ep = e / r;
  vec3 nE = normalize(vec3(ep.x * 0.8, ep.y * 0.8 * pitch.y, 1.0) + upV);
  n = normalize(mix(nE, nT, step(sdE, sdT)) + upV * 0.25);
  float ao = mix(0.55, 1.05, 1.0 - tier) * mix(0.75, 1.0, clamp(t + 0.3, 0.0, 1.0));
  // 针叶的细密颗粒
  if (detail > 0.0) {
    vec3 cl = leafClumps(q * 38.0, s2);
    ao *= mix(1.0, 0.8 + 0.35 * smoothstep(0.0, 0.5, cl.z), detail);
  }
  alb = col * ao;
#else
  float R = CR_R, hc = CR_H, Rv = CR_V;
  float lobes = SPECIES == 1 ? 3.2 : 3.8;
  // 树冠：椭球投影（竖直半径随俯仰变化）
  float ry = sqrt(Rv * Rv * pitch.x * pitch.x + R * R * pitch.y * pitch.y);
  vec2 c = vec2(0.0, hc * pitch.x);
  vec2 p = (q - c) / vec2(R, ry);
  vec3 cl = leafClumps(p * lobes, s1);
  float ang = atan(p.y, p.x);
  float rr = 0.88 + 0.06 * sin(ang * 5.0 + s1) + 0.04 * sin(ang * 11.0 + s2);
  // 叶团让轮廓起伏：外圈按叶团中心距离收缩
  float d = length(p);
  float lump = smoothstep(0.55, 1.0, d) * (length(cl.xy) - 0.35) * 0.35;
  float sd = (rr - d - lump) * R;
  // 树干：树冠下方一小段
  float trunkTop = (hc - Rv * 0.6) * pitch.x;
  float sdTrunk = min(0.028 - abs(q.x), min(q.y + 0.02, trunkTop - q.y));
  cov = max(cover(sd), cover(sdTrunk));
  if (sd > sdTrunk) {
    vec2 np = p / rr;
    vec3 n0 = vec3(np, sqrt(max(0.0, 1.0 - dot(np, np))));
    #if SPECIES == 2
    n0 = normalize(mix(n0, upV, 0.45));
    #endif
    // 每个叶团是一个小凸包：法线向叶团中心外翻，叶团之间的缝更暗
    vec3 nb = vec3(cl.xy * 1.2, 0.0);
    n = normalize(n0 + nb * 0.6 + upV * 0.3);
    float ao = mix(0.5, 1.0, smoothstep(0.0, 0.45, cl.z));
    ao *= mix(0.7, 1.05, smoothstep(-1.0, 0.7, p.y));
    // 叶团内再细分一层小叶簇
    if (detail > 0.0) {
      vec3 cl2 = leafClumps(p * lobes * 3.1, s2);
      ao *= mix(1.0, 0.85 + 0.25 * smoothstep(0.0, 0.4, cl2.z), detail);
      n = normalize(n + vec3(cl2.xy * 0.25 * detail, 0.0));
    }
    alb = col * ao * (0.94 + 0.12 * th2(floor(p * lobes) + s2).x);
  } else {
    alb = vec3(0.07, 0.05, 0.035);
    n = normalize(vec3(q.x / 0.028, 0.0, 1.0));
  }
#endif
  return alb;
}
`

/** 单位面片：x ∈ [-1, 1]，y ∈ [0, 1]（顶点着色器按树种映射到面片范围） */
function quadGeometry() {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

function instanced(
  base: THREE.BufferGeometry,
  n: number,
  inst: Record<string, THREE.InstancedBufferAttribute>,
  sphere: THREE.Sphere,
) {
  const g = new THREE.InstancedBufferGeometry()
  g.setIndex(base.index)
  for (const [k, a] of Object.entries(base.attributes)) g.setAttribute(k, a)
  for (const [k, a] of Object.entries(inst)) g.setAttribute(k, a)
  g.instanceCount = n
  g.boundingSphere = sphere
  return g
}

// —— 散布 ——

function scatter(world: World, mask: Uint8Array, color: HTMLCanvasElement, SX: number, SZ: number) {
  const { W, H, biome, elevation: e, temperature: T, water, flow } = world
  const chunks = Array.from({ length: CX * CZ }, () => ({
    data: [[], [], []] as number[][],
    col: [[], [], []] as number[][],
    count: [0, 0, 0],
    maxE: 0,
  }))
  const cw = color.width
  const ch = color.height
  const px = color.getContext('2d')!.getImageData(0, 0, cw, ch).data
  const thr = riverThreshold(W)
  let seed = 0x9e3779b9
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const forestAt = (x: number, y: number) => {
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(x)))
    const y0 = Math.max(0, Math.min(H - 2, Math.floor(y)))
    const fx = x - x0
    const fy = y - y0
    const m = (xx: number, yy: number) => mask[(yy * W + xx) * 4] / 255
    return (m(x0, y0) * (1 - fx) + m(x0 + 1, y0) * fx) * (1 - fy) + (m(x0, y0 + 1) * (1 - fx) + m(x0 + 1, y0 + 1) * fx) * fy
  }
  const PER_CELL = 10
  let total = 0
  for (let y = 1; y < H - 1 && total < MAX_TREES; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (e[i] <= 0.003 || mask[i * 4] < 6) continue
      if (!Number.isNaN(water[i])) continue // 湖面
      if (flow[i] > thr) continue // 河道
      const sl = Math.hypot(e[i + 1] - e[i - 1], e[i + W] - e[i - W]) / (2 * world.kmPerCell)
      const slopeK = 1 - Math.min(1, sl * 2.5)
      if (slopeK <= 0) continue
      // 林线：高处树变矮、变稀
      const alt = e[i] > 1.5 ? Math.max(0, 1 - (e[i] - 1.5) * 0.6) : 1
      const mix = speciesMix(biome[i], T[i])
      for (let k = 0; k < PER_CELL; k++) {
        const gx = x + rnd() - 0.5
        const gy = y + rnd() - 0.5
        // 成簇分布：两层值噪声调制，林中有空地、林缘参差
        const clump = Math.min(1, Math.max(0, 0.35 + 1.0 * (0.65 * vnoise(gx, gy, 4.5) + 0.35 * vnoise(gx + 91, gy - 37, 1.4))))
        if (rnd() > forestAt(gx, gy) * clump * slopeK * (0.35 + 0.65 * alt)) continue
        const r = rnd()
        const s: Species = r < mix[0] ? 0 : r < mix[0] + mix[1] ? 1 : 2
        const wx = (gx / (W - 1) - 0.5) * SX
        const wz = (gy / (H - 1) - 0.5) * SZ
        const size = SIZE[s][0] + rnd() * SIZE[s][1]
        const c = chunks[Math.min(CZ - 1, Math.floor((gy / (H - 1)) * CZ)) * CX + Math.min(CX - 1, Math.floor((gx / (W - 1)) * CX))]
        c.data[s].push(wx, wz, size * (0.55 + 0.45 * alt), rnd())
        // 颜色取地表贴图同一位置，保证与远处的林冠色一致；再加单株色差
        const pi = (Math.min(ch - 1, Math.floor((gy / H) * ch)) * cw + Math.min(cw - 1, Math.floor((gx / W) * cw))) * 4
        const tint = TINT[s]
        const v = 0.82 + rnd() * 0.36
        const warm = (rnd() - 0.5) * 0.12
        c.col[s].push(
          Math.min(255, px[pi] * tint[0] * v * (1 + warm)),
          Math.min(255, px[pi + 1] * tint[1] * v),
          Math.min(255, px[pi + 2] * tint[2] * v * (1 - warm)),
          255,
        )
        c.count[s]++
        c.maxE = Math.max(c.maxE, e[i])
        total++
      }
    }
  }
  return { chunks, total }
}

/** 树高（世界单位）：[最小, 随机增量] */
const SIZE: [number, number][] = [
  [0.056, 0.03],
  [0.048, 0.022],
  [0.056, 0.032],
]
/** 相对地表色的色调：针叶偏暗偏青，热带偏黄绿 */
const TINT: [number, number, number][] = [
  [0.95, 1.06, 1.0],
  [1.2, 1.28, 1.02],
  [1.16, 1.28, 0.98],
]

/** 群系 → [针叶, 阔叶, 热带] 比例；寒冷处一律针叶 */
function speciesMix(b: number, t: number): [number, number, number] {
  if (t < 1.5) return [1, 0, 0]
  switch (b) {
    case Biome.Taiga:
      return [1, 0, 0]
    case Biome.TemperateRainforest:
      return [0.65, 0.35, 0]
    case Biome.TemperateForest:
      return t < 7 ? [0.5, 0.5, 0] : [0.2, 0.8, 0]
    case Biome.TropicalSeasonalForest:
      return [0, 0.55, 0.45]
    case Biome.TropicalRainforest:
      return [0, 0.35, 0.65]
    case Biome.Savanna:
      return [0, 0.25, 0.75]
    default:
      return [0.15, 0.85, 0]
  }
}

