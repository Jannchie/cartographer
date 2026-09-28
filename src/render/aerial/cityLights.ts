import * as THREE from 'three'
import type { World } from '../../gen/types'

/**
 * 夜里的城市灯火：每座城市一簇暖色光点（都城最大最密），沿道路零星散着村落的灯，
 * 再给每座城市垫一团很淡的大光晕（城市上空被照亮的薄雾）。
 * 两个 THREE.Points（灯点、光晕各一次绘制），加法混合、不写深度，只在 level > 0 时画。
 * 光晕不做深度测试（点精灵只有一个深度，贴地时会被近处地面切出一道硬边），拉近到很大时淡出。
 * 每盏灯有自己的点亮阈值：黄昏时大城市先亮、小村后亮，破晓时次第熄灭。
 */

const VERT = /* glsl */ `
  uniform float uLevel;
  uniform float uPx;
  attribute float aSize;
  attribute float aBright;
  attribute float aSeed;
  attribute float aHalo;
  varying float vB;
  varying float vHalo;
  varying float vWarm;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // 点亮阈值：aSeed 小的先亮
    float on = smoothstep(aSeed * 0.7, aSeed * 0.7 + 0.3, uLevel);
    // 世界尺寸 → 像素；太小时保底 2 像素，亮度按面积折算（远看不会一片刺眼的亮点）
    float px = aSize * projectionMatrix[1][1] * uPx * 0.5 / max(-mv.z, 1e-3);
    float minPx = aHalo > 0.5 ? 0.0 : 3.0;
    float sz = clamp(px, minPx, aHalo > 0.5 ? 400.0 : 40.0);
    vB = aBright * on * (aHalo > 0.5 ? 1.0 - smoothstep(120.0, 320.0, px) : min(1.0, max(px * px / 9.0, 0.35)));
    gl_PointSize = sz;
    vHalo = aHalo;
    vWarm = fract(aSeed * 7.13);
    if (vB <= 0.0 || sz < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  varying float vB;
  varying float vHalo;
  varying float vWarm;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r2 = dot(q, q) * 4.0;
    if (r2 > 1.0) discard;
    vec3 warm = mix(vec3(1.0, 0.42, 0.1), vec3(1.0, 0.66, 0.32), vWarm);
    float i = vHalo > 0.5
      ? (1.0 - r2) * (1.0 - r2) * 0.5
      : exp(-r2 * 12.0) * 3.0 + exp(-r2 * 3.0) * 0.4;
    gl_FragColor = vec4(warm * i * vB, 0.0);
  }
`

/** 可复现的伪随机 */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface LightsPlacement {
  SX: number
  SZ: number
  /** 渲染地表的真实高度（世界单位） */
  height: (x: number, z: number) => number
}

export class CityLights {
  /** 加进场景的对象：灯点 + 光晕 */
  readonly object = new THREE.Group()
  private points: THREE.Points
  private halos: THREE.Points
  readonly mat: THREE.ShaderMaterial
  private haloMat: THREE.ShaderMaterial

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uLevel: { value: 0 }, uPx: { value: 1000 } },
      transparent: true,
      depthWrite: false,
      // 颜色相加，alpha 保持（沙盘外背景透明，不能被灯光改掉覆盖度）
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    })
    this.haloMat = this.mat.clone()
    this.haloMat.uniforms = this.mat.uniforms
    this.haloMat.depthTest = false
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.mat)
    this.halos = new THREE.Points(new THREE.BufferGeometry(), this.haloMat)
    for (const p of [this.points, this.halos]) {
      p.frustumCulled = false
      // 画在水面（renderOrder 2）与海水剖面之后
      p.renderOrder = 5
    }
    this.object.add(this.halos, this.points)
    this.object.visible = false
  }

  /** 灯火的点亮程度 0~1 */
  set level(v: number) {
    this.mat.uniforms.uLevel.value = v
    this.object.visible = v > 0.001
  }

  /** 渲染视口的像素高度（动态分辨率时随之变化） */
  set viewportHeight(h: number) {
    this.mat.uniforms.uPx.value = h
  }

  build(world: World, p: LightsPlacement) {
    const { W, H, elevation } = world
    let seed = 7
    for (const ch of world.params.seed) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
    const rand = rng(seed)
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-6, rand()))) * Math.cos(Math.PI * 2 * rand())
    const toX = (x: number) => (x / (W - 1) - 0.5) * p.SX
    const toZ = (y: number) => (y / (H - 1) - 0.5) * p.SZ
    const land = (x: number, z: number) => {
      const gx = Math.round((x / p.SX + 0.5) * (W - 1))
      const gy = Math.round((z / p.SZ + 0.5) * (H - 1))
      if (gx < 0 || gy < 0 || gx >= W || gy >= H) return false
      return elevation[gy * W + gx] > 0.002
    }
    const pos: number[] = []
    const size: number[] = []
    const bright: number[] = []
    const seeds: number[] = []
    const halo: number[] = []
    const add = (x: number, z: number, s: number, b: number, sd: number, h = 0, lift = 0.025) => {
      pos.push(x, p.height(x, z) + lift, z)
      size.push(s)
      bright.push(b)
      seeds.push(sd)
      halo.push(h)
    }
    // 城市：中心密、向外稀的一簇（外围沿几条放射的街道拉长）
    const cities = world.labels.filter((l) => l.kind === 'capital' || l.kind === 'city')
    for (const l of cities) {
      const cap = l.kind === 'capital'
      const cx = toX(l.x)
      const cz = toZ(l.y)
      if (!land(cx, cz)) continue
      const R = cap ? 0.42 : 0.2 + Math.min(0.12, Math.max(0, l.weight - 3000) / 4000)
      const n = cap ? 90 : Math.round(26 + Math.min(24, Math.max(0, l.weight - 3000) / 20))
      const arms = 3 + Math.floor(rand() * 3)
      const a0 = rand() * Math.PI * 2
      // 大城市先亮
      const order = cap ? 0.05 : 0.2 + rand() * 0.2
      for (let i = 0; i < n; i++) {
        let x: number
        let z: number
        if (i % 4 === 3) {
          // 街道：沿放射方向拉长
          const a = a0 + (Math.floor(rand() * arms) / arms) * Math.PI * 2 + gauss() * 0.12
          const d = R * (0.4 + rand() * 1.5)
          x = cx + Math.cos(a) * d
          z = cz + Math.sin(a) * d
        } else {
          x = cx + gauss() * R * 0.45
          z = cz + gauss() * R * 0.45
        }
        if (!land(x, z)) continue
        const core = Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (R * R * 0.3))
        add(x, z, 0.045 + 0.035 * rand() + 0.03 * core, (0.5 + 0.9 * rand()) * (0.6 + 0.8 * core) * (cap ? 1.25 : 1), order + rand() * 0.25)
      }
      // 城市上空的光晕：悬在城市上方（贴地的话会被近处的地面切掉一半）
      add(cx, cz, R * (cap ? 7 : 6), cap ? 0.14 : 0.09, order, 1, R * 1.2)
    }
    // 道路沿线：零星的村落
    for (const r of world.roads ?? []) {
      if (r.kind === 'sea') continue
      const m = r.pts.length / 2
      let acc = 0
      for (let i = 1; i < m; i++) {
        const x0 = toX(r.pts[i * 2 - 2])
        const z0 = toZ(r.pts[i * 2 - 1])
        const x1 = toX(r.pts[i * 2])
        const z1 = toZ(r.pts[i * 2 + 1])
        const seg = Math.hypot(x1 - x0, z1 - z0)
        acc += seg
        const gap = r.kind === 'major' ? 0.9 : 1.3
        while (acc > gap) {
          acc -= gap * (0.6 + rand() * 0.8)
          if (rand() > 0.55) continue
          const f = rand()
          const vx = x0 + (x1 - x0) * f
          const vz = z0 + (z1 - z0) * f
          const k = 1 + Math.floor(rand() * 4)
          const sd = 0.45 + rand() * 0.45
          for (let j = 0; j < k; j++) {
            const x = vx + gauss() * 0.06
            const z = vz + gauss() * 0.06
            if (land(x, z)) add(x, z, 0.035 + 0.02 * rand(), 0.35 + 0.5 * rand(), sd + rand() * 0.08)
          }
        }
      }
    }
    const geo = (want: number) => {
      const idx = halo.map((h, i) => (h === want ? i : -1)).filter((i) => i >= 0)
      const pick = (a: number[], n: number) => idx.flatMap((i) => a.slice(i * n, i * n + n))
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pick(pos, 3), 3))
      g.setAttribute('aSize', new THREE.Float32BufferAttribute(pick(size, 1), 1))
      g.setAttribute('aBright', new THREE.Float32BufferAttribute(pick(bright, 1), 1))
      g.setAttribute('aSeed', new THREE.Float32BufferAttribute(pick(seeds, 1), 1))
      g.setAttribute('aHalo', new THREE.Float32BufferAttribute(pick(halo, 1), 1))
      return g
    }
    this.points.geometry.dispose()
    this.points.geometry = geo(0)
    this.halos.geometry.dispose()
    this.halos.geometry = geo(1)
  }

  dispose() {
    this.points.geometry.dispose()
    this.halos.geometry.dispose()
    this.mat.dispose()
    this.haloMat.dispose()
  }
}
