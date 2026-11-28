import * as THREE from 'three'
import { GpuTimer } from './gpuTimer'

/**
 * 三维视图（世界沙盘、聚落沙盘）共用的画布底座：渲染器的配置、画布随容器调整、
 * 移动中渲染缩放的自适应、性能读数浮层。两个场景的渲染循环不同（持续出帧、按需出帧），各自调用这些部件。
 */

/**
 * 建渲染器并挂进容器。抗锯齿在后期管线的 MSAA 场景目标与时间累积里做，色调映射与调色在终合成里做，画布本身都不需要；
 * 保留绘制缓冲：按需渲染停下后画面留在画布上，导出图片直接读。阴影贴图只在太阳或场景变化时重画（由场景置 needsUpdate）
 */
export function createCanvasRenderer(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true })
  renderer.toneMapping = THREE.NoToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.autoUpdate = false
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x000000, 0)
  const timer = new GpuTimer(renderer.getContext() as WebGL2RenderingContext)
  container.appendChild(renderer.domElement)
  return { renderer, timer }
}

/**
 * 画布按容器尺寸调整（像素比事先设好），相机跟着换宽高比。返回渲染目标的物理像素尺寸与像素比；
 * 容器隐藏（v-show 时报 0×0）时什么也不做、返回 null：保留现有渲染目标，切回来不必整套重建
 */
export function fitCanvas(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, container: HTMLElement): { w: number; h: number; pr: number } | null {
  const w = container.clientWidth
  const h = container.clientHeight
  if (w === 0 || h === 0) return null
  renderer.setSize(w, h, false)
  const pr = renderer.getPixelRatio()
  renderer.domElement.style.width = w + 'px'
  renderer.domElement.style.height = h + 'px'
  camera.aspect = w / Math.max(1, h)
  camera.updateProjectionMatrix()
  return { w: Math.round(w * pr), h: Math.round(h * pr), pr }
}

/**
 * 移动中的渲染缩放：按一帧的实测耗时 ms（那一帧用的缩放是 scale）向目标帧时 targetMs 靠拢，留 12% 余量。
 * 像素数与缩放的平方成正比；超时就快降、有余量时慢升，避免来回抖。结果在 [minScale, 1] 之间
 */
export function adaptMotionScale(current: number, ms: number, scale: number, targetMs: number, minScale: number): number {
  const want = scale * Math.sqrt((targetMs * 0.88) / Math.max(ms, 0.1))
  const k = want < current ? 0.5 : 0.15
  return Math.min(1, Math.max(minScale, current + (want - current) * k))
}

/** 性能读数浮层（P 键开关）：每半秒刷新一次帧率、画布尺寸与各 pass 的 GPU 耗时 */
export class PerfOverlay {
  private el: HTMLDivElement | null = null
  private frames = 0
  private t0 = 0

  constructor(
    private container: HTMLElement,
    private timer: GpuTimer,
  ) {}

  /** 移走浮层（场景释放时） */
  dispose() {
    this.el?.remove()
    this.el = null
  }

  /** 打开或关上；打开时 GPU 计时改为逐 pass */
  toggle() {
    if (this.el) {
      this.el.remove()
      this.el = null
      this.timer.detail = false
      return
    }
    const el = document.createElement('div')
    el.className = 'perf'
    el.textContent = '…'
    this.container.appendChild(el)
    this.el = el
    this.timer.detail = true
    this.timer.ms.clear()
    this.frames = 0
    this.t0 = performance.now()
  }

  /** 每出一帧调用一次。head：第一行在帧率与画布尺寸之后的说明；extra：GPU 读数之前另加的行 */
  tick(canvas: HTMLCanvasElement, head: () => string, extra: () => string[] = () => []) {
    if (!this.el) return
    this.frames++
    const now = performance.now()
    if (now - this.t0 < 500) return
    const tm = this.timer
    const rows = [...tm.ms].filter(([, v]) => v >= 0.05).map(([k, v]) => `${k.padEnd(8, '　')} ${v.toFixed(2).padStart(6)} ms`)
    this.el.textContent = [
      `${((this.frames * 1000) / (now - this.t0)).toFixed(0)} fps · ${canvas.width}×${canvas.height}${head()}`,
      ...extra(),
      ...(tm.supported ? [`GPU ${tm.total.toFixed(1)} ms`, ...rows] : ['GPU n/a']),
    ].join('\n')
    this.frames = 0
    this.t0 = now
  }
}

const navTmp = { offset: new THREE.Vector3(), fwd: new THREE.Vector3(), move: new THREE.Vector3(), sph: new THREE.Spherical() }

/**
 * 键盘导航的一步（按键由 render/keys.ts 的 navKey 映射成动作，held 是按住的那些）：
 * 前后左右沿镜头朝向在地面上的投影平移视点与镜头，速度与视距成正比；左转右转、俯仰在视点周围的球坐标里改，
 * 俯角限制在 polar 之间。fast（按住 Shift）时三倍速。推拉不在这里做（两个场景的缩放方式不同）：
 * 返回推拉的方向，+1 拉远、-1 推近、0 不动。不调 lookAt
 */
export function keyNavStep(held: ReadonlySet<string>, cam: THREE.Camera, target: THREE.Vector3, dt: number, fast: boolean, polar: readonly [number, number]): number {
  const { offset, fwd, move, sph } = navTmp
  offset.copy(cam.position).sub(target)
  const k = fast ? 3 : 1
  fwd.set(-offset.x, 0, -offset.z).normalize()
  move.set(0, 0, 0)
  if (held.has('forward')) move.add(fwd)
  if (held.has('back')) move.sub(fwd)
  const side = +held.has('right') - +held.has('left')
  move.x -= fwd.z * side
  move.z += fwd.x * side
  if (move.lengthSq()) {
    move.normalize().multiplyScalar(offset.length() * 0.9 * k * dt)
    target.add(move)
    cam.position.add(move)
  }
  const turn = (+held.has('turnLeft') - +held.has('turnRight')) * 1.2 * k * dt
  const tilt = (+held.has('tiltDown') - +held.has('tiltUp')) * 0.8 * k * dt
  if (turn || tilt) {
    sph.setFromVector3(offset)
    sph.theta += turn
    sph.phi = Math.min(polar[1], Math.max(polar[0], sph.phi + tilt))
    cam.position.setFromSpherical(sph).add(target)
  }
  return +held.has('zoomOut') - +held.has('zoomIn')
}
