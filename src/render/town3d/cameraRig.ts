import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { isTypingTarget, navKey } from '../keys'
import { keyNavStep } from '../aerial/stage'
import { smoother } from '../aerial/tour'
import type { HeightField } from './heightField'

/**
 * 聚落沙盘的镜头：OrbitControls 管拖动（转动、平移、双指），其余在这里：
 *
 * - 滚轮缩放：以光标所指的表面为锚点做相似变换（锚点留在光标下），缩放量按指数滑行，不一格一格地跳；
 *   推近以到锚点的距离为限，不会一头扎进墙里。
 * - 视点落地：每帧把轨道中心移到视线与地面的交点（沿视线移动，画面不变）。
 *   平移越过起伏的地形、缩放到屋顶之后，转动的支点始终是画面中心看到的那块地面。
 * - 避障：镜头不得低于表面高度场的包络（见 heightField.ts）加一段余量，被挡时绕视点抬高俯角。
 *   包络随位置连续变化，镜头贴近建筑时是沿着墙滑上屋顶；近平面按余量取，余量之内没有几何体。
 * - 边界：视点不出沙盘四周一小圈，沙盘拖不出画面。
 * - 键盘：方向键 / WASD 平移，Q / E 转，PageUp / PageDown 俯仰，+ / − 缩放，Home 回到全景，Shift 加速。
 * - 双击：飞到所指的位置并推近。
 */

export interface RigWorld {
  /** 地面（地形与水面）的高度，世界坐标；沙盘范围外返回桌面高度 */
  ground(x: number, z: number): number
  field: HeightField
  /** 沙盘的半宽、半深（世界单位）与桌面高度 */
  hx: number
  hz: number
  floor: number
  /** 世界单位 / 米 */
  K: number
}

export interface RigView {
  /** 视点（世界坐标，落在地面上）、镜头到视点的距离、方位角与俯角（弧度） */
  x: number
  z: number
  dist: number
  azimuth: number
  pitch: number
}

/** 视点可以超出沙盘边缘的距离（世界单位） */
const PAN_MARGIN = 0.5
/** 镜头到轨道中心的最近距离、滚轮推近时到锚点的最近距离（米） */
const MIN_ORBIT = 10
const MIN_APPROACH = 10
const MAX_DIST = 240
/** 俯角下限对应的极角：接近平视，实际的下限由避障的离地余量决定 */
const MAX_POLAR = Math.PI * 0.492
const MIN_POLAR = 0.02
/** 镜头前方这段距离（米）内的视线不得被挡 */
const BLOCK_NEAR = 30


export class CameraRig {
  readonly controls: OrbitControls
  /** 是否响应键盘（舞台可见时） */
  enabled = false
  /** 用户动了镜头（拖动、滚轮、按键、双击）：自动运镜据此让出 */
  onUserInput: (() => void) | null = null
  private world: RigWorld | null = null
  /** 待滑行的缩放量（对数，正为拉远）与锚点 */
  private zoom = { log: 0, anchor: null as THREE.Vector3 | null, x: -1, y: -1 }
  private held = new Set<string>()
  private fast = false
  private flight: { t: number; dur: number; t0: THREE.Vector3; t1: THREE.Vector3; o0: THREE.Vector3; o1: THREE.Vector3 } | null = null
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private v = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), sph: new THREE.Spherical() }
  private disposers: (() => void)[] = []

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private wake: () => void,
  ) {
    // 滚轮先于 OrbitControls 接手（同一元素上按注册顺序触发）：它自带的缩放不平滑，贴近时会穿过光标下的建筑
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1
      // 触控板的捏合（带 ctrl）给的量很小
      const d = Math.max(-240, Math.min(240, e.deltaY * unit)) * (e.ctrlKey ? 4 : 1)
      const z = this.zoom
      if (!z.anchor || Math.hypot(e.clientX - z.x, e.clientY - z.y) > 3) {
        z.anchor = this.anchorAt(e.clientX, e.clientY)
        z.x = e.clientX
        z.y = e.clientY
      }
      z.log += d * 0.0011
      this.flight = null
      this.onUserInput?.()
      this.wake()
    }
    dom.addEventListener('wheel', onWheel, { passive: false })
    this.controls = new OrbitControls(camera, dom)
    const c = this.controls
    c.enableDamping = true
    c.dampingFactor = 0.09
    c.maxPolarAngle = MAX_POLAR
    c.minPolarAngle = MIN_POLAR
    c.maxDistance = MAX_DIST
    c.screenSpacePanning = false
    // 双指缩放仍由它处理（向双指中点推近）
    c.zoomToCursor = true
    c.addEventListener('change', this.wake)
    const onStart = () => {
      this.flight = null
      this.zoom.anchor = null
      this.onUserInput?.()
    }
    c.addEventListener('start', onStart)
    const onDbl = (e: MouseEvent) => {
      const p = this.anchorAt(e.clientX, e.clientY)
      if (!p || !this.world) return
      this.onUserInput?.()
      const off = this.camera.position.clone().sub(c.target)
      const r = off.length()
      this.flight = {
        t: 0,
        dur: 0.7,
        t0: c.target.clone(),
        t1: p,
        o0: off.clone(),
        o1: off.multiplyScalar(Math.max(MIN_ORBIT * this.world.K * 1.6, r * 0.42) / r),
      }
      this.zoom.log = 0
      this.wake()
    }
    dom.addEventListener('dblclick', onDbl)
    const onKey = (e: KeyboardEvent) => {
      this.fast = e.shiftKey
      if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e)) return
      if (e.key === 'Home') {
        e.preventDefault()
        this.onUserInput?.()
        this.reset(true)
        return
      }
      const k = navKey(e)
      if (!k) return
      e.preventDefault()
      this.held.add(k)
      this.flight = null
      this.onUserInput?.()
      this.wake()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      this.fast = e.shiftKey
      const k = navKey(e)
      if (k) this.held.delete(k)
    }
    const onBlur = () => this.held.clear()
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    this.disposers.push(() => {
      dom.removeEventListener('wheel', onWheel)
      dom.removeEventListener('dblclick', onDbl)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    })
  }

  get target() {
    return this.controls.target
  }

  /** 镜头到轨道中心的距离（世界单位） */
  get distance() {
    return this.camera.position.distanceTo(this.controls.target)
  }

  /** 有按键按着、缩放在滑行或正在飞行 */
  get moving() {
    return this.held.size > 0 || this.zoom.log !== 0 || !!this.flight
  }

  /** 镜头离周围表面的余量（世界单位）：近平面、对焦的下限据此取 */
  get clearance() {
    const w = this.world
    if (!w) return 0.05
    return Math.min(4, Math.max(1.2, (this.distance / w.K) * 0.045)) * w.K
  }

  setWorld(w: RigWorld | null) {
    this.world = w
    // 最近距离由这里自己管（带缓动）；控件里的下限只防止双指缩到零
    if (w) this.controls.minDistance = MIN_ORBIT * w.K * 0.5
    this.zoom.anchor = null
    this.zoom.log = 0
    this.flight = null
  }

  clearKeys() {
    this.held.clear()
  }

  /** 回到全景；animate 时飞过去 */
  reset(animate = false) {
    const t1 = new THREE.Vector3(0, 0, 0)
    const o1 = new THREE.Vector3(0, 58, 84)
    if (animate && this.world) {
      this.flight = { t: 0, dur: 0.9, t0: this.controls.target.clone(), t1, o0: this.camera.position.clone().sub(this.controls.target), o1 }
      this.zoom.log = 0
    } else {
      this.flight = null
      this.controls.target.copy(t1)
      this.camera.position.copy(o1)
      this.camera.lookAt(t1)
    }
    this.wake()
  }

  setView(v: RigView) {
    const w = this.world
    const t = this.controls.target
    t.set(v.x, w ? w.ground(v.x, v.z) : 0, v.z)
    const phi = Math.min(MAX_POLAR, Math.max(MIN_POLAR, Math.PI / 2 - v.pitch))
    const r = Math.min(MAX_DIST, Math.max(w ? MIN_ORBIT * w.K * 0.5 : 0.1, v.dist))
    this.camera.position.setFromSphericalCoords(r, phi, v.azimuth).add(t)
    this.camera.lookAt(t)
    this.flight = null
    this.zoom.log = 0
    this.zoom.anchor = null
    this.wake()
  }

  /**
   * 推进一帧：按键、飞行、拖动的阻尼、缩放滑行，然后施加约束。返回是否还在动（需要下一帧）
   */
  update(dt: number): boolean {
    let busy = this.keyNav(dt)
    if (this.stepFlight(dt)) busy = true
    else if (this.controls.update()) busy = true
    if (this.stepZoom(dt)) busy = true
    this.constrain(dt)
    return busy
  }

  /** 只施加约束（自动运镜接管时用） */
  constrain(dt: number) {
    const w = this.world
    const cam = this.camera
    const t = this.controls.target
    if (!w) return
    const { a: dir, b: tmp, sph } = this.v
    // 边界
    const mx = w.hx + PAN_MARGIN
    const mz = w.hz + PAN_MARGIN
    const dx = Math.min(mx, Math.max(-mx, t.x)) - t.x
    const dz = Math.min(mz, Math.max(-mz, t.z)) - t.z
    if (dx || dz) {
      t.x += dx
      t.z += dz
      cam.position.x += dx
      cam.position.z += dz
    }
    // 视点落地：轨道中心取视线与地面的交点（沿视线移动，画面不变）
    dir.copy(t).sub(cam.position)
    let r = dir.length()
    dir.divideScalar(r)
    if (dir.y < -0.035) {
      const hit = this.hitGround(cam.position, dir, MAX_DIST)
      if (hit > 0) {
        r = hit
        t.copy(cam.position).addScaledVector(dir, r)
      }
    }
    // 最近距离：缓缓退到位（轨道中心跳到近处的坡上时不至于一下弹开）
    const minR = MIN_ORBIT * w.K
    if (r < minR) {
      const back = (minR - r) * (dt > 0 ? 1 - Math.exp(-dt * 10) : 1)
      cam.position.addScaledVector(dir, -back)
      r += back
    }
    // 避障：低于包络加余量时，绕视点抬高俯角；连视点正上方都被挡（视点在高塔脚下）就再拉远
    const clear = this.clearance
    const need = (x: number, z: number) => Math.max(w.field.ceiling(x, z), w.ground(x, z)) + clear
    // 镜头前方近处被挡（贴着一棵树冠、一堵墙）：画面被糊满，也算没让开。远处的遮挡是正常的透视，不管
    const los = this.v.c
    const blocked = (q: THREE.Vector3) => {
      los.copy(t).sub(q)
      const L = los.length()
      if (L < 1e-6) return false
      los.divideScalar(L)
      return w.field.raycast(q, los, Math.min(L * 0.3, BLOCK_NEAR * w.K), 2) > 0
    }
    const p = cam.position
    if (p.y < need(p.x, p.z) || blocked(p)) {
      sph.setFromVector3(tmp.copy(p).sub(t))
      const at = (phi: number) => {
        tmp.setFromSphericalCoords(sph.radius, phi, sph.theta).add(t)
        const h = tmp.y - need(tmp.x, tmp.z)
        return h >= 0 && blocked(tmp) ? -1e-3 : h
      }
      let hi = sph.phi
      let lo = hi
      let ok = false
      while (lo > MIN_POLAR) {
        lo = Math.max(MIN_POLAR, lo - 0.012)
        if (at(lo) >= 0) {
          ok = true
          break
        }
        hi = lo
      }
      if (ok) {
        for (let k = 0; k < 10; k++) {
          const m = (lo + hi) / 2
          if (at(m) >= 0) lo = m
          else hi = m
        }
        sph.phi = lo
      } else {
        sph.phi = MIN_POLAR
        sph.radius = Math.max(sph.radius, need(t.x, t.z) - t.y + clear)
      }
      p.setFromSphericalCoords(sph.radius, sph.phi, sph.theta).add(t)
    }
    cam.lookAt(t)
    // 近平面：余量之内没有几何体；远看时取大些，深度精度更好
    const near = Math.min(1, Math.max(0.2 * w.K, Math.min(0.3 * clear, 0.02 * r)))
    if (Math.abs(near - cam.near) > cam.near * 0.08) {
      cam.near = near
      cam.updateProjectionMatrix()
    }
  }

  /** 屏幕坐标所指的表面点（世界坐标）：先求与表面高度场的交点，没有就取地面 */
  anchorAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const w = this.world
    if (!w) return null
    const rc = this.dom.getBoundingClientRect()
    this.ndc.set(((clientX - rc.left) / rc.width) * 2 - 1, -((clientY - rc.top) / rc.height) * 2 + 1)
    this.camera.updateMatrixWorld()
    this.ray.setFromCamera(this.ndc, this.camera)
    const { origin, direction } = this.ray.ray
    let t = w.field.raycast(origin, direction, MAX_DIST * 3)
    if (t < 0) t = this.hitGround(origin, direction, MAX_DIST * 3)
    // 指着天：取与轨道中心等距的一点
    if (t < 0) t = this.distance
    return origin.clone().addScaledVector(direction, t)
  }

  /** 视线与地面（地形、水面；沙盘外是桌面）求交：步长随距离放大，再二分 */
  private hitGround(o: THREE.Vector3, d: THREE.Vector3, tMax: number): number {
    const w = this.world!
    const above = (t: number) => o.y + d.y * t - w.ground(o.x + d.x * t, o.z + d.z * t)
    if (above(0) <= 0) return 0
    let prev = 0
    let t = 0
    while (t < tMax) {
      t = Math.min(tMax, t + Math.max(0.05, t * 0.03))
      if (above(t) <= 0) {
        let a = prev
        let b = t
        for (let k = 0; k < 10; k++) {
          const m = (a + b) / 2
          if (above(m) > 0) a = m
          else b = m
        }
        return b
      }
      prev = t
    }
    return -1
  }

  private stepZoom(dt: number): boolean {
    const z = this.zoom
    if (z.log === 0) return false
    const w = this.world
    const cam = this.camera
    const t = this.controls.target
    let step = z.log * (1 - Math.exp(-Math.max(dt, 1 / 240) * 13))
    if (Math.abs(z.log - step) < 2e-4) step = z.log
    z.log -= step
    const P = z.anchor ?? t
    const K = w?.K ?? 1
    let s = Math.exp(step)
    if (s < 1) {
      // 推近：以到锚点的距离为限
      const d = cam.position.distanceTo(P)
      s = Math.max(s, Math.min(1, (MIN_APPROACH * K) / Math.max(d, 1e-6)))
    } else {
      s = Math.min(s, Math.max(1, MAX_DIST / cam.position.distanceTo(t)))
    }
    if (s === 1) {
      z.log = 0
      return false
    }
    cam.position.sub(P).multiplyScalar(s).add(P)
    if (P !== t) t.sub(P).multiplyScalar(s).add(P)
    return true
  }

  private stepFlight(dt: number): boolean {
    const f = this.flight
    if (!f) return false
    f.t = Math.min(1, f.t + dt / f.dur)
    const k = smoother(f.t)
    const t = this.controls.target
    t.lerpVectors(f.t0, f.t1, k)
    // 距离按对数插值（推近、拉远的速度感均匀），方向按球面插值
    const r0 = f.o0.length()
    const r1 = f.o1.length()
    const { b: tmp, c: tmp2 } = this.v
    tmp.copy(f.o0).divideScalar(r0)
    tmp2.copy(f.o1).divideScalar(r1)
    tmp.lerp(tmp2, k).normalize()
    this.camera.position.copy(t).addScaledVector(tmp, r0 * Math.pow(r1 / r0, k))
    this.camera.lookAt(t)
    if (f.t >= 1) this.flight = null
    return true
  }

  /** 键盘导航：返回是否有键按着 */
  private keyNav(dt: number): boolean {
    const held = this.held
    if (!held.size) return false
    if (!dt) return true
    // 平移、旋转、俯仰见 keyNavStep；缩放走滑行
    const zoom = keyNavStep(held, this.camera, this.controls.target, dt, this.fast, [MIN_POLAR, MAX_POLAR])
    if (zoom) {
      this.zoom.anchor = null
      this.zoom.log += zoom * 1.5 * (this.fast ? 3 : 1) * dt
    }
    this.camera.lookAt(this.controls.target)
    return true
  }

  dispose() {
    for (const d of this.disposers) d()
    this.controls.removeEventListener('change', this.wake)
    this.controls.dispose()
  }
}
