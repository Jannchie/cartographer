import * as THREE from 'three'
import { FS_VERT, FullscreenPass } from '../aerial/fullscreen'

/**
 * 沙盘的表面高度场：自正上方把会投影的一切（体块、城墙、树、地形）渲染成一张深度图，读回 CPU。
 *
 * 用途：镜头避障（镜头不得低于"包络"）、视线与表面求交（缩放的锚点、注记的遮挡）。
 * 从渲染结果取高度而不读网格数据：体块的成长升降、树的实例位置都在顶点着色器里，
 * 只有画出来才是此刻的样子；别的模块往城市组里加什么网格，这里都不必知道。
 *
 * 两张表（沙盘单位，世界坐标的 y）：
 * - raw：格内最高的表面，向外保守扩了约一格（细墙不会从格点之间漏掉）；
 * - env：raw 的锥形包络 max(raw(q) − 坡度·|p − q|)。镜头的最低高度取它：离墙越近必须越高，
 *   高度约束随位置连续变化，镜头贴着建筑移动时是滑上屋顶而不是跳上去。
 */

/** 包络的坡度（高度 / 水平距离）：越陡，镜头能贴得离墙越近 */
const SLOPE = 2.4

const MAX_FRAG = /* glsl */ `
  uniform sampler2D uDepth;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    // 高分辨率深度图里 4×4 邻域的最高处（深度最小），写成 16 位
    float d = 1.0;
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      d = min(d, texture2D(uDepth, vUv + (vec2(float(i), float(j)) - 1.5) * uTexel).r);
    }
    float v = floor((1.0 - d) * 65535.0 + 0.5);
    float hi = floor(v / 256.0);
    gl_FragColor = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
  }
`

export interface HeightFieldSpec {
  /** 高度场覆盖的范围（世界坐标，含沙盘四周的一圈桌面） */
  x0: number
  z0: number
  x1: number
  z1: number
  /** 高度范围：floor 是没有任何表面处的高度（桌面），top 高于一切表面 */
  floor: number
  top: number
  /** 沙盘本体的范围与其中的最低表面（水面）：水下的地形按水面算 */
  inner: { x0: number; z0: number; x1: number; z1: number; level: number }
  /** 格距的目标（世界单位） */
  cell: number
}

export class HeightField {
  ready = false
  private raw = new Float32Array(0)
  private env = new Float32Array(0)
  private nx = 0
  private nz = 0
  private spec: HeightFieldSpec = { x0: 0, z0: 0, x1: 1, z1: 1, floor: 0, top: 1, inner: { x0: 0, z0: 0, x1: 1, z1: 1, level: 0 }, cell: 1 }
  private cx = 1
  private cz = 1
  private fs = new FullscreenPass()
  private mat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: MAX_FRAG,
    uniforms: { uDepth: { value: null }, uTexel: { value: new THREE.Vector2() } },
    depthTest: false,
    depthWrite: false,
  })
  private depthMat = new THREE.MeshDepthMaterial()
  private cam = new THREE.OrthographicCamera()
  private job = 0

  /** 作废（换城时）：约束退回到只有地形与桌面 */
  clear() {
    this.ready = false
    this.job++
  }

  /**
   * 重新烘焙：把 roots 里会投影的网格自上而下画一遍，异步读回。
   * 期间旧的高度场照常可用；读回来时若又有新的烘焙开始，这一次作废
   */
  async bake(renderer: THREE.WebGLRenderer, roots: THREE.Object3D[], spec: HeightFieldSpec) {
    const job = ++this.job
    const maxTex = renderer.capabilities.maxTextureSize
    const w = spec.x1 - spec.x0
    const d = spec.z1 - spec.z0
    const nx = Math.max(64, Math.min(2048, Math.round(w / spec.cell)))
    const nz = Math.max(64, Math.min(2048, Math.round((nx * d) / w)))
    const up = Math.min(2, Math.floor(maxTex / Math.max(nx, nz)))
    const hi = new THREE.WebGLRenderTarget(nx * up, nz * up, { depthBuffer: true })
    hi.depthTexture = new THREE.DepthTexture(nx * up, nz * up, THREE.UnsignedIntType)
    const lo = new THREE.WebGLRenderTarget(nx, nz, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })

    // 正上方的正交相机：画面右 = +x，画面上 = −z
    const cam = this.cam
    cam.left = -w / 2
    cam.right = w / 2
    cam.top = d / 2
    cam.bottom = -d / 2
    cam.near = 0
    cam.far = spec.top - spec.floor
    cam.up.set(0, 0, -1)
    cam.position.set((spec.x0 + spec.x1) / 2, spec.top, (spec.z0 + spec.z1) / 2)
    cam.lookAt(cam.position.x, spec.floor, cam.position.z)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()

    // 只画会投影的网格，换上各自的深度材质（成长升降、树的实例位置都在里面）
    const swapped: { m: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = []
    const hidden: THREE.Object3D[] = []
    for (const root of roots) {
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh && !(o as THREE.Line).isLine && !(o as THREE.Points).isPoints) return
        if (!m.isMesh || !m.castShadow || !m.visible) {
          if (o.visible) {
            o.visible = false
            hidden.push(o)
          }
          return
        }
        swapped.push({ m, mat: m.material })
        m.material = m.customDepthMaterial ?? this.depthMat
      })
    }
    const prevTarget = renderer.getRenderTarget()
    const prevAuto = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(hi)
    renderer.clear()
    // 逐个根节点画（不是 Scene：不带灯光，不触发阴影通道）
    for (const root of roots) renderer.render(root, cam)
    renderer.autoClear = prevAuto
    for (const s of swapped) s.m.material = s.mat
    for (const o of hidden) o.visible = true

    this.mat.uniforms.uDepth.value = hi.depthTexture
    this.mat.uniforms.uTexel.value.set(1 / (nx * up), 1 / (nz * up))
    this.fs.render(renderer, this.mat, lo)
    renderer.setRenderTarget(prevTarget)

    const px = new Uint8Array(nx * nz * 4)
    try {
      await renderer.readRenderTargetPixelsAsync(lo, 0, 0, nx, nz, px)
    } catch {
      // 上下文丢失等：保留旧的高度场
      hi.depthTexture.dispose()
      hi.dispose()
      lo.dispose()
      return
    }
    hi.depthTexture.dispose()
    hi.dispose()
    lo.dispose()
    if (job !== this.job) return

    const raw = new Float32Array(nx * nz)
    const range = spec.top - spec.floor
    const cx = w / nx
    const cz = d / nz
    const inn = spec.inner
    for (let r = 0; r < nz; r++) {
      // 读回的行自下而上：第 0 行是 z 最大的一行
      const j = nz - 1 - r
      const z = spec.z0 + (j + 0.5) * cz
      const inZ = z > inn.z0 && z < inn.z1
      for (let i = 0; i < nx; i++) {
        const k = (r * nx + i) * 4
        let y = spec.floor + ((px[k] * 256 + px[k + 1]) / 65535) * range
        if (inZ) {
          const x = spec.x0 + (i + 0.5) * cx
          if (x > inn.x0 && x < inn.x1 && y < inn.level) y = inn.level
        }
        raw[j * nx + i] = y
      }
    }
    // 锥形包络：正反各扫一遍（倒角距离变换的做法），每格取自己与已扫过的邻格降一格坡度后的较大者
    const env = raw.slice()
    const sx = SLOPE * cx
    const sz = SLOPE * cz
    const sd = SLOPE * Math.hypot(cx, cz)
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        let v = env[k]
        if (i > 0) v = Math.max(v, env[k - 1] - sx)
        if (j > 0) {
          v = Math.max(v, env[k - nx] - sz)
          if (i > 0) v = Math.max(v, env[k - nx - 1] - sd)
          if (i < nx - 1) v = Math.max(v, env[k - nx + 1] - sd)
        }
        env[k] = v
      }
    }
    for (let j = nz - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i
        let v = env[k]
        if (i < nx - 1) v = Math.max(v, env[k + 1] - sx)
        if (j < nz - 1) {
          v = Math.max(v, env[k + nx] - sz)
          if (i < nx - 1) v = Math.max(v, env[k + nx + 1] - sd)
          if (i > 0) v = Math.max(v, env[k + nx - 1] - sd)
        }
        env[k] = v
      }
    }
    this.raw = raw
    this.env = env
    this.nx = nx
    this.nz = nz
    this.cx = cx
    this.cz = cz
    this.spec = spec
    this.ready = true
  }

  /** (x, z) 处的表面高度（最近格；范围外是桌面） */
  surface(x: number, z: number): number {
    const s = this.spec
    if (!this.ready) return s.floor
    const i = Math.floor((x - s.x0) / this.cx)
    const j = Math.floor((z - s.z0) / this.cz)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return s.floor
    return this.raw[j * this.nx + i]
  }

  /** (x, z) 周围半径 r 内最高的表面（注记放在地标的顶上） */
  peak(x: number, z: number, r: number): number {
    const s = this.spec
    if (!this.ready) return s.floor
    const i0 = Math.max(0, Math.floor((x - r - s.x0) / this.cx))
    const i1 = Math.min(this.nx - 1, Math.floor((x + r - s.x0) / this.cx))
    const j0 = Math.max(0, Math.floor((z - r - s.z0) / this.cz))
    const j1 = Math.min(this.nz - 1, Math.floor((z + r - s.z0) / this.cz))
    let y = s.floor
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) y = Math.max(y, this.raw[j * this.nx + i])
    return y
  }

  /** 镜头在 (x, z) 处的最低高度（包络，双线性；范围外是桌面） */
  ceiling(x: number, z: number): number {
    const s = this.spec
    if (!this.ready) return s.floor
    const fx = Math.min(this.nx - 1, Math.max(0, (x - s.x0) / this.cx - 0.5))
    const fz = Math.min(this.nz - 1, Math.max(0, (z - s.z0) / this.cz - 0.5))
    const i = Math.min(this.nx - 2, Math.floor(fx))
    const j = Math.min(this.nz - 2, Math.floor(fz))
    const u = fx - i
    const v = fz - j
    const e = this.env
    const k = j * this.nx + i
    const y = (e[k] * (1 - u) + e[k + 1] * u) * (1 - v) + (e[k + this.nx] * (1 - u) + e[k + this.nx + 1] * u) * v
    // 范围外按到边界的距离沿坡度落到桌面
    const out = Math.max(s.x0 - x, x - s.x1, s.z0 - z, z - s.z1, 0)
    return Math.max(s.floor, y - out * SLOPE)
  }

  /**
   * 视线与表面求交：自 o 沿单位方向 d 步进（水平每步不超过约一格），返回参数 t；tMax 内没有碰到返回 −1。
   * stride：步长的倍数（注记的遮挡判断不必逐格，取大些省时间）
   */
  raycast(o: THREE.Vector3, d: THREE.Vector3, tMax: number, stride = 1): number {
    if (!this.ready) return -1
    const s = this.spec
    // 先裁到高度场的包围盒
    let t0 = 0
    let t1 = tMax
    const slab = (p: number, v: number, lo: number, hi: number) => {
      if (Math.abs(v) < 1e-9) return p >= lo && p <= hi
      let a = (lo - p) / v
      let b = (hi - p) / v
      if (a > b) [a, b] = [b, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, b)
      return t0 <= t1
    }
    if (!slab(o.x, d.x, s.x0, s.x1) || !slab(o.z, d.z, s.z0, s.z1) || !slab(o.y, d.y, s.floor, s.top + 1e3)) return -1
    const hl = Math.hypot(d.x, d.z)
    const step = Math.min((0.7 * stride * Math.min(this.cx, this.cz)) / Math.max(hl, 1e-4), (s.top - s.floor) / 6 / Math.max(Math.abs(d.y), 1e-4))
    const above = (t: number) => o.y + d.y * t - this.surface(o.x + d.x * t, o.z + d.z * t)
    let prev = t0
    if (above(prev) <= 0) return prev
    for (let t = t0 + step; ; t += step) {
      const tt = Math.min(t, t1)
      if (above(tt) <= 0) {
        let a = prev
        let b = tt
        for (let k = 0; k < 8; k++) {
          const m = (a + b) / 2
          if (above(m) > 0) a = m
          else b = m
        }
        return b
      }
      if (tt >= t1) return -1
      prev = tt
    }
  }

  dispose() {
    this.job++
    this.mat.dispose()
    this.depthMat.dispose()
    this.fs.dispose()
    this.raw = this.env = new Float32Array(0)
    this.ready = false
  }
}
