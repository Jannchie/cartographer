import * as THREE from 'three'
import type { Life } from '../../settlement/history'
import type { Settlement } from '../../settlement/types'
import { LIFE_GLSL } from './buildingShader'

/**
 * 夜里的灯火：干道沿线与桥头的街灯、城门两侧的火把（窗灯在建筑着色器里）。
 *
 * 每盏灯画两样东西，都是加色混合的实例化四边形，不是真的光源：
 * - 光点：朝向镜头的一小团（灯芯加一圈光晕），远看缩到两个像素为止，整城的夜景里是一串串细小的亮点；
 * - 光斑：贴着地面的一片暖色（按地形的坡度倾斜），把灯下的路面照亮一圈。
 * 亮度随 uNight（黄昏亮起、破晓熄灭）；生卒随所属的路、桥、城墙，与体块用同一组成长 uniform。
 * 不投影、不写深度：阴影、表面高度场与环境光遮蔽都看不见它们。
 */

type Uniforms = Record<string, THREE.IUniform>

/** 街灯的间距（米）与离路边的距离 */
const SPACING = 58
const CURB = 0.9
/** 灯的上限（超大的城也不必更多） */
const MAX_LAMPS = 4000

const VERT = /* glsl */ `
  ${LIFE_GLSL}
  attribute vec4 aLamp;
  attribute vec3 aNrm;
  attribute vec2 aLampLife;
  uniform float uNight;
  uniform float uMeter;
  uniform float uPool;
  uniform float uMinNdc;
  varying vec2 vQ;
  varying float vKind;
  varying float vI;
  void main() {
    float lk = lifeK(aLampLife) * uNight;
    vQ = position.xy;
    vKind = aLamp.w;
    if (uPool > 0.5) {
      // 光斑：在地面的切平面里铺开（法线取地形的坡度），略高于地面
      vec3 n = normalize(aNrm);
      vec3 t = normalize(cross(n, vec3(0.0, 0.0, 1.0)));
      vec3 b = cross(n, t);
      float R = mix(11.0, 13.0, aLamp.w);
      vec3 p = aLamp.xyz + n * 0.35 + (t * position.x + b * position.y) * R;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      vI = lk;
    } else {
      // 光点：街灯高 4.4 米，城门的火把高一些；远看不小于两个像素（放大的同时压暗，不至于一片亮斑）
      vec4 mv = modelViewMatrix * vec4(aLamp.x, aLamp.y + mix(4.4, 5.8, aLamp.w), aLamp.z, 1.0);
      float size = mix(1.5, 2.1, aLamp.w) * uMeter;
      float ndc = size * projectionMatrix[1][1] / max(-mv.z, 1e-4);
      float s = max(1.0, uMinNdc / ndc);
      mv.xy += position.xy * size * s;
      gl_Position = projectionMatrix * mv;
      vI = lk / pow(s, 1.3);
    }
    if (lk <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  uniform float uPool;
  varying vec2 vQ;
  varying float vKind;
  varying float vI;
  void main() {
    float r2 = dot(vQ, vQ);
    if (r2 > 1.0) discard;
    vec3 warm = mix(vec3(1.0, 0.68, 0.34), vec3(1.0, 0.5, 0.18), vKind);
    float a = uPool > 0.5 ? pow(1.0 - r2, 2.2) * 0.055 : exp(-r2 * 30.0) * 5.0 + pow(1.0 - sqrt(r2), 3.0) * 0.16;
    // 加色：alpha 不动（场景缓冲的 alpha 是沙盘的覆盖率）
    gl_FragColor = vec4(warm * a * vI, 0.0);
  }
`

/**
 * 灯的位置（聚落米坐标）：沿主路每隔一段、左右交替；桥的两头；城门两侧。
 * 街灯只立在有房子的地段（城外的大路上没有）。返回实例数据 (x, 地面高, z, 种类) 与生卒、地面法线
 */
function lampSites(st: Settlement, life: Map<object, Life>, H: (x: number, z: number) => number) {
  const lamp: number[] = []
  const lives: number[] = []
  const nrm: number[] = []
  // 建筑的粗格网（40 米一格）：判断一处是不是"有房子的地段"
  const G = 40
  const gw = Math.ceil(st.width / G)
  const gh = Math.ceil(st.height / G)
  const occ = new Uint8Array(gw * gh)
  for (const b of st.buildings) {
    const p = b.poly[0]
    const i = Math.min(gw - 1, Math.max(0, Math.floor(p[0] / G)))
    const j = Math.min(gh - 1, Math.max(0, Math.floor(p[1] / G)))
    if (occ[j * gw + i] < 255) occ[j * gw + i]++
  }
  const built = (x: number, z: number) => {
    const ci = Math.floor(x / G)
    const cj = Math.floor(z / G)
    let n = 0
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) if (i >= 0 && j >= 0 && i < gw && j < gh) n += occ[j * gw + i]
    return n >= 4
  }
  const add = (x: number, z: number, kind: number, l: Life | undefined) => {
    if (lamp.length / 4 >= MAX_LAMPS || x < 2 || z < 2 || x > st.width - 2 || z > st.height - 2) return
    const y = H(x, z)
    lamp.push(x, y, z, kind)
    lives.push(l?.born ?? 0, l && l.died !== Infinity ? l.died : 3e38)
    const e = 3
    nrm.push(H(x - e, z) - H(x + e, z), 2 * e, H(x, z - e) - H(x, z + e))
  }
  for (const r of st.roads) {
    if (r.kind !== 'highway' && r.kind !== 'main') continue
    const l = life.get(r)
    let acc = SPACING / 2
    let side = 1
    for (let k = 0; k < r.line.length - 1; k++) {
      const [x0, z0] = r.line[k]
      const [x1, z1] = r.line[k + 1]
      const len = Math.hypot(x1 - x0, z1 - z0)
      if (len < 1e-3) continue
      const nx = -(z1 - z0) / len
      const nz = (x1 - x0) / len
      while (acc < len) {
        const t = acc / len
        const off = (r.width / 2 + CURB) * side
        const x = x0 + (x1 - x0) * t + nx * off
        const z = z0 + (z1 - z0) * t + nz * off
        if (built(x, z)) add(x, z, 0, l)
        side = -side
        acc += SPACING
      }
      acc -= len
    }
  }
  for (const c of st.crossings) {
    if (c.kind !== 'bridge') continue
    const l = life.get(c)
    add(c.a[0], c.a[1], 0, l)
    add(c.b[0], c.b[1], 0, l)
  }
  for (const w of st.walls) {
    const l = life.get(w)
    for (const g of w.gates) {
      // 门洞两侧、城内城外两面各一对（angle 是穿门的方向；门墩沿墙的方向排在两旁）
      const ux = Math.cos(g.angle)
      const uz = Math.sin(g.angle)
      for (const s of [-1, 1]) for (const f of [-1, 1]) add(g.p[0] - uz * 4.5 * s + ux * 7 * f, g.p[1] + ux * 4.5 * s + uz * 7 * f, 1, l)
    }
  }
  return { lamp: new Float32Array(lamp), lives: new Float32Array(lives), nrm: new Float32Array(nrm), count: lamp.length / 4 }
}

/**
 * 灯火层：一个组（光斑在下、光点在上），加进城市组里随它缩放。
 * u 为共享的 uniform：成长（uPop、uPrev、uT）、昼夜（uNight）、尺度（uMeter）与光点的最小尺寸（uMinNdc，两个像素在裁剪空间里的高度）
 */
export function createTownLights(st: Settlement, life: Map<object, Life>, H: (x: number, z: number) => number, u: Uniforms) {
  const sites = lampSites(st, life, H)
  const group = new THREE.Group()
  if (!sites.count) return group
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  g.setAttribute('aLamp', new THREE.InstancedBufferAttribute(sites.lamp, 4))
  g.setAttribute('aLampLife', new THREE.InstancedBufferAttribute(sites.lives, 2))
  g.setAttribute('aNrm', new THREE.InstancedBufferAttribute(sites.nrm, 3))
  g.instanceCount = sites.count
  for (const pool of [1, 0]) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...u, uPool: { value: pool } },
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // 光斑贴着地面：往镜头方向让一点，不与地形打架
      polygonOffset: pool === 1,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    const m = new THREE.Mesh(g, mat)
    // 位置在着色器里由实例属性给出
    m.frustumCulled = false
    m.renderOrder = pool ? 4 : 5
    group.add(m)
  }
  return group
}
