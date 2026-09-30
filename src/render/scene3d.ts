import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { reliefKm, type Label, type World } from '../gen/types'
import { buildDetailMask, buildMaterialMask } from './aerial/mask'
import { createTerrainMaterial, type TerrainUniforms } from './aerial/terrainMaterial'
import { VolumetricClouds } from './aerial/volumetric'
import { PostPipeline } from './aerial/post'
import { GpuTimer } from './aerial/gpuTimer'
import { CameraTour, type TourPoi } from './aerial/tour'
import { QUALITIES, type Look, type QualityId } from './aerial/looks'
import { Diorama } from './aerial/diorama'
import { TerrainBake } from './aerial/bake'
import { RoadMask } from './aerial/roads3d'
import { buildBridges } from './aerial/bridges'
import { placeName, t, worldTitle } from '../i18n'
import { createRiverMesh, RiverCarve } from './aerial/rivers3d'
import type { SmoothRiver } from './rivers'
import { createRiverWaterMaterial, createWaterMaterial } from './water'
import { isTypingTarget } from '../ui/keys'
import { daylight, type Daylight } from './aerial/daylight'
import { CityLights } from './aerial/cityLights'

export interface View3DOptions {
  exaggeration: number
  labels: boolean
  /** 正午时太阳的方位（整条日轨随之旋转） */
  sunAzimuth: number
  /** 正午时太阳的高度（日轨的最高点） */
  sunElevation: number
  /** 时刻（小时 0~24）：12 点即正午，太阳在 (sunAzimuth, sunElevation) */
  timeOfDay: number
  /** 昼夜循环：时刻自动前进（一整天约 dayLength 秒） */
  dayCycle: boolean
  /** 空气感：远景霾与低空薄雾 */
  haze: boolean
  clouds: boolean
  /** 移轴景深强度 0~1（0 关闭）：对焦在旋转中心，前后虚化出微缩模型感 */
  dof: number
  /** 展台：桌面与展厅背景（关掉时沙盘浮在页面上） */
  stage: boolean
  /** 道路与航线 */
  roads: boolean
  /** 画质档位：像素比、MSAA、阴影贴图、云的步进、泛光、累积帧数 */
  quality: QualityId
  /** 阴影柔和度（按 4096 阴影贴图的纹素计，换画质时软硬不变） */
  shadowSoftness: number
  /** 成片观感：调色与胶片模拟 */
  look: Look
}

/** 云里远处的淡出（空气透视） */
const CLOUD_FOG = 0.0036

const SX = 100
/** 昼夜循环中主光方向转过这么多（弧度）才重画阴影贴图（约 0.6°） */
const SHADOW_STEP = 0.0105

/** 3D 视图的导航键 → 动作（大小写、Shift 改出的 + / _ 都算同一个键） */
const NAV_KEYS: Record<string, string> = {
  ArrowUp: 'forward',
  w: 'forward',
  ArrowDown: 'back',
  s: 'back',
  ArrowLeft: 'left',
  a: 'left',
  ArrowRight: 'right',
  d: 'right',
  q: 'turnLeft',
  e: 'turnRight',
  PageUp: 'tiltUp',
  PageDown: 'tiltDown',
  '+': 'zoomIn',
  '=': 'zoomIn',
  '-': 'zoomOut',
  _: 'zoomOut',
}
const navKey = (e: KeyboardEvent): string | undefined => NAV_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key]

/**
 * 3D 立体沙盘：地形网格 + 水面 + 河流 + 侧面剖面，
 * 光照带实时阴影，太阳方位与高度可调。
 */
export class Scene3D {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  private sun: THREE.DirectionalLight
  private hemi: THREE.HemisphereLight
  private group = new THREE.Group()
  private world: World | null = null
  private terrain: THREE.Mesh | null = null
  private water: THREE.Mesh | null = null
  private waterMat: THREE.ShaderMaterial | null = null
  private heightTex: THREE.DataTexture | null = null
  private tempTex: THREE.DataTexture | null = null
  private maskTex: THREE.DataTexture | null = null
  private mask2Tex: THREE.DataTexture | null = null
  private terrainU: TerrainUniforms | null = null
  /** 视口高清块：镜头拉近时在视口附近烘焙更细的地形并用更密的网格绘制 */
  private patch: {
    bake: TerrainBake
    mesh: THREE.Mesh
    u: TerrainUniforms
    cx: number
    cz: number
    S: number
    vs: number
  } | null = null
  private clouds: VolumetricClouds | null = null
  private post = new PostPipeline()
  private diorama: Diorama
  /** 对焦点（世界坐标）：鼠标指向的地面；为空时对焦旋转中心 */
  private focusPoint: THREE.Vector3 | null = null
  private focusDist = 0
  /** 鼠标在画布上的位置（离开画布为空）；dirty 表示需要重新取焦点 */
  private pointer: { x: number; y: number; dirty: boolean } | null = null
  private pickRay = new THREE.Raycaster()
  private pickNdc = new THREE.Vector2()
  /** 高清块网格（与世界无关，首次用到时建一次） */
  private patchGeo: THREE.BufferGeometry | null = null
  private bake: TerrainBake | null = null
  private riverMat: THREE.ShaderMaterial | null = null
  private carve: RiverCarve | null = null
  private roadMask: RoadMask | null = null
  private riverList: SmoothRiver[] = []
  private lastInteract = 0
  /** 按住的导航键（见 keyNav） */
  private navHeld = new Set<string>()
  private navFast = false
  private frame = 0
  /** 性能读数（按 P 开关）：帧率、GPU 耗时（EXT_disjoint_timer_query_webgl2） */
  private perf: { el: HTMLDivElement; frames: number; t0: number } | null = null
  /** 动态分辨率：镜头移动时的渲染缩放（按 GPU 耗时调节）；lastScale 为上一帧移动时用的缩放，静止为 0 */
  private motionScale = 1
  private lastScale = 0
  private lastFrameAt = 0
  /** 显示器刷新间隔（毫秒），由 rAF 间隔估计 */
  private refreshMs = 1000 / 60
  private rafDeltas: number[] = []
  private lastRaf = 0
  private lastRaf2 = 0
  /** 自动运镜（巡览） */
  private tour: CameraTour
  private tourFade: HTMLDivElement
  /** 巡览开始 / 停止时通知界面 */
  onTourChange: ((on: boolean) => void) | null = null
  /** 逐 pass 的 GPU 耗时，性能读数打开时才计时 */
  private timer: GpuTimer
  /** 当前时刻的光照（太阳、月亮、天色、曝光…），见 aerial/daylight.ts */
  private dl: Daylight
  /** 夜里的城市灯火 */
  private lights = new CityLights()
  /** 上次重画阴影贴图时的主光方向（昼夜循环时按角度节流） */
  private shadowDir = new THREE.Vector3()
  private shadowMoon = false
  /** 昼夜循环：一整天的秒数 */
  dayLength = 60
  /** 昼夜循环推进时刻时通知界面（约 10 次每秒） */
  onTimeChange: ((h: number) => void) | null = null
  private lastTimeNotify = 0
  private clock = new THREE.Clock()
  private opts: View3DOptions
  private labelLayer: HTMLDivElement
  private labelEls: { el: HTMLDivElement; pos: THREE.Vector3; kind: string; w: number; h: number; src: Label }[] = []
  private raf = 0
  private SZ = 62.5
  active = true

  constructor(private container: HTMLElement, opts: View3DOptions) {
    this.opts = { ...opts }
    this.dl = daylight(this.opts.timeOfDay, this.opts.sunAzimuth, this.opts.sunElevation)
    // 抗锯齿在后期管线的 MSAA 场景目标与时间累积里做，画布本身不需要
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true })
    // 色调映射与调色在后期管线的终合成里做
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.shadowMap.enabled = true
    // 地形是静态的：阴影只在太阳或地形变化时重绘
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.setClearColor(0x000000, 0)
    this.timer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 6000)
    this.camera.position.set(0, 50, 60)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.07
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.minDistance = 3
    this.controls.maxDistance = 260
    this.controls.screenSpacePanning = false
    this.controls.zoomToCursor = true

    this.sun = new THREE.DirectionalLight(0xfff1dc, 3.1)
    this.sun.castShadow = true
    const sc = this.sun.shadow.camera
    sc.left = -70
    sc.right = 70
    sc.top = 70
    sc.bottom = -70
    sc.near = 1
    sc.far = 400
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.04
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)
    this.hemi = new THREE.HemisphereLight(0xc4d7ea, 0x5b4a3a, 0.9)
    this.scene.add(this.hemi)
    this.scene.add(this.group)
    this.diorama = new Diorama(this.renderer)
    this.scene.add(this.diorama.group)
    this.scene.add(this.lights.object)

    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'labels3d'
    container.appendChild(this.labelLayer)
    // 巡览：切镜时的淡出淡入遮罩
    this.tourFade = document.createElement('div')
    this.tourFade.className = 'tour-fade'
    container.appendChild(this.tourFade)
    const self = this
    this.tour = new CameraTour({
      SX,
      get SZ() {
        return self.SZ
      },
      heightAt: (x, z) => (this.world ? this.heightAt(x, z) : 0),
      get pois() {
        return self.tourPois()
      },
    })

    new ResizeObserver(() => this.resize()).observe(container)
    this.applyQuality()
    this.post.setLook(this.opts.look)
    this.updateSun()
    // 交互检测：镜头静止 1.5 秒后降到 30 fps（水波、云的缓慢变化看不出差别）
    const touch = () => (this.lastInteract = performance.now())
    // 巡览中用户一动鼠标（拖、滚轮）就交还手动控制
    const takeOver = () => this.tour.active && this.stopTour()
    this.renderer.domElement.addEventListener('pointerdown', takeOver)
    this.renderer.domElement.addEventListener('wheel', takeOver, { passive: true })
    // 镜头的变化由后期管线自己比对矩阵发现，这里只管降帧
    this.controls.addEventListener('change', touch)
    this.renderer.domElement.addEventListener('pointerdown', touch)
    this.renderer.domElement.addEventListener('wheel', touch, { passive: true })
    // 对焦跟随鼠标：悬停处的地面就是焦点；拖动时焦点不跟着跑，离开画布回到旋转中心
    this.renderer.domElement.addEventListener('pointermove', (e) => {
      if (e.buttons || this.tour.active) return
      this.pointer = { x: e.clientX, y: e.clientY, dirty: true }
    })
    this.renderer.domElement.addEventListener('pointerleave', () => {
      this.pointer = null
      this.focusPoint = null
    })
    // 动态分辨率：移动中的帧按实测 GPU 耗时调节缩放，目标是显示器刷新间隔
    this.timer.onFrame = (ms, scale) => {
      if (scale > 0) this.adaptScale(ms, scale)
    }
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop)
      this.trackRefresh(now)
      if (!this.active) return
      const dt = this.lastRaf2 ? (now - this.lastRaf2) / 1000 : 0
      this.lastRaf2 = now
      if (this.opts.dayCycle && this.world) this.advanceTime(Math.min(dt, 0.1), now)
      if (this.tour.active) {
        // 运镜接管镜头；焦点跟着镜头的主体
        this.tour.update(dt, this.camera, this.controls.target)
        this.focusPoint = this.tour.subject
        this.tourFade.style.opacity = String(this.tour.fade)
        this.lastInteract = performance.now()
      } else {
        this.keyNav(Math.min(dt, 0.05))
        this.controls.update()
      }
      this.frame++
      if (performance.now() - this.lastInteract > 1500 && this.frame % 2) return
      const pf = this.perf
      // 没有 GPU 计时扩展时退回用帧间隔估计（包含了 CPU 与等待，偏保守）
      if (!this.timer.supported && this.lastScale > 0 && this.lastFrameAt) this.adaptScale(now - this.lastFrameAt, this.lastScale)
      this.lastFrameAt = now
      this.timer.frameStart()
      const t = this.clock.getElapsedTime()
      if (this.waterMat) this.waterMat.uniforms.uTime.value = t
      if (this.clouds) this.clouds.time = t
      this.diorama.time = t
      this.timer.begin('高清块烘焙')
      this.updatePatch()
      this.renderFrame()
      this.timer.frameEnd()
      if (pf) {
        pf.frames++
        const now = performance.now()
        if (now - pf.t0 > 500) {
          const fps = (pf.frames * 1000) / (now - pf.t0)
          const c = this.renderer.domElement
          const tm = this.timer
          const rows = [...tm.ms].filter(([, v]) => v >= 0.05).map(([k, v]) => `${k.padEnd(8, '　')} ${v.toFixed(2).padStart(6)} ms`)
          pf.el.textContent = [`${fps.toFixed(0)} fps · ${c.width}×${c.height} · 刷新 ${(1000 / this.refreshMs).toFixed(0)} Hz · 移动缩放 ${this.motionScale.toFixed(2)}`, ...(tm.supported ? [`GPU ${tm.total.toFixed(1)} ms`, ...rows] : ['GPU n/a'])].join('\n')
          pf.frames = 0
          pf.t0 = now
        }
      }
      this.updateLabels()
    }
    this.raf = requestAnimationFrame(loop)
    window.addEventListener('keydown', (e) => {
      this.navFast = e.shiftKey
      if (!this.active || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e)) return
      if (e.key === 'p' || e.key === 'P') this.togglePerf()
      else if (e.key === 't' || e.key === 'T') this.toggleTour()
      else if (this.tour.active && (e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N')) this.tour.next()
      else if (this.tour.active && e.key === 'Escape') this.stopTour()
      else {
        const k = navKey(e)
        if (!k) return
        e.preventDefault()
        // 巡览中按导航键：交还手动控制
        if (this.tour.active) this.stopTour()
        this.navHeld.add(k)
        this.lastInteract = performance.now()
      }
    })
    window.addEventListener('keyup', (e) => {
      this.navFast = e.shiftKey
      const k = navKey(e)
      if (k) this.navHeld.delete(k)
    })
    window.addEventListener('blur', () => this.navHeld.clear())
  }

  /**
   * 键盘导航（每帧按住的键推进一步）：方向键 / WASD 沿地面平移（前后按镜头朝向），Q / E 绕目标转，
   * PageUp / PageDown 抬高、压低视角，+ / − 推近拉远。速度随镜头距离，按住 Shift 三倍
   */
  /** keyNav 每帧复用的临时量 */
  private navTmp = { offset: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(), move: new THREE.Vector3(), sph: new THREE.Spherical() }
  private keyNav(dt: number) {
    const held = this.navHeld
    if (!held.size || !dt) return
    const cam = this.camera
    const target = this.controls.target
    const { offset, fwd, right, move, sph } = this.navTmp
    offset.copy(cam.position).sub(target)
    const dist = offset.length()
    const fast = this.navFast ? 3 : 1
    // 平移：前方向是镜头朝向在地面上的投影
    fwd.set(-offset.x, 0, -offset.z).normalize()
    right.set(-fwd.z, 0, fwd.x)
    move.set(0, 0, 0)
    if (held.has('forward')) move.add(fwd)
    if (held.has('back')) move.sub(fwd)
    if (held.has('right')) move.add(right)
    if (held.has('left')) move.sub(right)
    if (move.lengthSq()) {
      move.normalize().multiplyScalar(dist * 0.9 * fast * dt)
      target.add(move)
      cam.position.add(move)
    }
    // 旋转、俯仰、推拉：在目标周围的球坐标里改
    sph.setFromVector3(offset)
    const turn = (+held.has('turnLeft') - +held.has('turnRight')) * 1.2 * fast * dt
    const tilt = (+held.has('tiltDown') - +held.has('tiltUp')) * 0.8 * fast * dt
    const zoom = +held.has('zoomOut') - +held.has('zoomIn')
    if (turn || tilt || zoom) {
      sph.theta += turn
      sph.phi = Math.min(this.controls.maxPolarAngle, Math.max(0.05, sph.phi + tilt))
      sph.radius = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, sph.radius * Math.exp(zoom * 1.4 * fast * dt)))
      cam.position.copy(target).add(move.setFromSpherical(sph))
    }
    cam.lookAt(target)
    this.lastInteract = performance.now()
  }

  // —— 昼夜 ——
  /**
   * 设定时刻（小时，0~24 循环）并立即更新全部光照：阴影贴图重画、累积重来，没有任何平滑。
   * 离线逐帧截图时用：setTimeOfDay(h) 之后渲染的第一帧就是这个时刻。
   */
  setTimeOfDay(h: number) {
    this.opts.timeOfDay = ((h % 24) + 24) % 24
    this.updateSun()
    this.onTimeChange?.(this.opts.timeOfDay)
  }

  get timeOfDay() {
    return this.opts.timeOfDay
  }

  /** 昼夜循环推进一帧：光照每帧更新，阴影按角度节流，累积不打断（上限之后是滑动平均，缓慢的光照变化不拖影） */
  private advanceTime(dt: number, now: number) {
    this.opts.timeOfDay = (this.opts.timeOfDay + (dt * 24) / this.dayLength) % 24
    this.applyDaylight(false)
    if (now - this.lastTimeNotify > 100) {
      this.lastTimeNotify = now
      this.onTimeChange?.(this.opts.timeOfDay)
    }
  }

  // —— 巡览 ——
  startTour() {
    if (!this.world || this.tour.active) return
    this.pointer = null
    this.tour.start(this.camera, this.controls.target)
    this.onTourChange?.(true)
  }
  stopTour() {
    if (!this.tour.active) return
    this.tour.stop()
    this.tourFade.style.opacity = '0'
    this.focusPoint = null
    // 从当前画面无缝交还：OrbitControls 按当前镜头与目标重新计算
    this.controls.update()
    this.onTourChange?.(false)
  }
  toggleTour() {
    if (this.tour.active) this.stopTour()
    else this.startTour()
  }

  /** 世界格网坐标 → 场景的 x / z */
  private toX(x: number) {
    return (x / (this.world!.W - 1) - 0.5) * SX
  }
  private toZ(y: number) {
    return (y / (this.world!.H - 1) - 0.5) * this.SZ
  }

  /**
   * 巡览的题材：都城与大城、山脉、湖、大岛、大陆，加上地形兴趣点。
   * 每个世界（及其注记）算一次：巡览每帧都会读，且"最近拍过"的判断靠对象同一性。
   */
  private poiCache: { labels: World['labels']; pois: TourPoi[] } | null = null
  private tourPois(): TourPoi[] {
    const w = this.world
    if (!w) return []
    if (this.poiCache?.labels === w.labels) return this.poiCache.pois
    const toX = (x: number) => this.toX(x)
    const toZ = (y: number) => this.toZ(y)
    const out: TourPoi[] = []
    const cities = w.labels.filter((l) => l.kind === 'capital' || l.kind === 'city').sort((a, b) => b.weight - a.weight)
    for (const l of cities.slice(0, 10)) out.push({ x: toX(l.x), z: toZ(l.y), kind: l.kind, weight: l.kind === 'capital' ? 60 : 12 })
    for (const l of w.labels) {
      if (l.kind === 'range') out.push({ x: toX(l.x), z: toZ(l.y), kind: 'range', weight: 30, angle: l.angle })
      else if (l.kind === 'lake' && l.weight > 60) out.push({ x: toX(l.x), z: toZ(l.y), kind: 'lake', weight: 10 })
      else if (l.kind === 'island' && l.weight > 800) out.push({ x: toX(l.x), z: toZ(l.y), kind: 'island', weight: 8 })
      else if (l.kind === 'continent') out.push({ x: toX(l.x), z: toZ(l.y), kind: 'continent', weight: 20 })
    }
    out.push(...this.terrainPois())
    const pois: TourPoi[] = out.length ? out : [{ x: 0, z: 0, kind: 'continent', weight: 1 }]
    this.poiCache = { labels: w.labels, pois }
    return pois
  }

  /**
   * 地形上的兴趣点：按窗口统计局部落差（险峻山地）与海陆交错程度（峡湾、群岛、曲折海岸），
   * 取得分最高、彼此隔开的若干处。
   */
  private terrainPois(): TourPoi[] {
    const w = this.world!
    const { W, H, elevation: e, flow } = w
    const step = Math.max(8, Math.round(W / 96))
    const win = step * 2
    const cands: { x: number; y: number; relief: number; coast: number; river: number }[] = []
    // 离地图边缘太近的不要：镜头朝哪边拍都会带到沙盘外的虚空
    const edge = Math.round(W * 0.09)
    for (let y = Math.max(win, edge); y < H - Math.max(win, edge); y += step)
      for (let x = Math.max(win, edge); x < W - Math.max(win, edge); x += step) {
        let lo = Infinity
        let hi = -Infinity
        let land = 0
        let n = 0
        let fl = 0
        for (let dy = -win; dy <= win; dy += 2)
          for (let dx = -win; dx <= win; dx += 2) {
            const i = (y + dy) * W + x + dx
            const h = e[i]
            if (h < lo) lo = h
            if (h > hi) hi = h
            if (h > 0) land++
            if (flow[i] > fl) fl = flow[i]
            n++
          }
        const lf = land / n
        if (lf < 0.15) continue
        cands.push({ x, y, relief: Math.max(0, hi) - Math.max(0, lo), coast: lf < 0.85 ? 1 - Math.abs(lf - 0.5) * 2 : 0, river: Math.log1p(fl) })
      }
    const score = (c: (typeof cands)[number]) => c.relief * 1.2 + c.coast * 1.1 + c.river * 0.05
    cands.sort((a, b) => score(b) - score(a))
    const picked: typeof cands = []
    const gap = W / 9
    for (const c of cands) {
      if (picked.length >= 24) break
      if (picked.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < gap)) continue
      picked.push(c)
    }
    return picked.map((c) => ({
      x: this.toX(c.x),
      z: this.toZ(c.y),
      kind: c.relief * 1.2 >= c.coast * 1.1 ? 'peak' : 'coast',
      weight: 18 + score(c) * 22,
    }))
  }

  togglePerf() {
    if (this.perf) {
      this.perf.el.remove()
      this.perf = null
      this.timer.detail = false
      return
    }
    const el = document.createElement('div')
    el.className = 'perf'
    el.textContent = '…'
    this.container.appendChild(el)
    this.timer.detail = true
    this.timer.ms.clear()
    this.perf = { el, frames: 0, t0: performance.now() }
  }

  get vScale() {
    const w = this.world
    if (!w) return 0.5
    return (SX / (w.W * reliefKm(w))) * this.opts.exaggeration
  }

  private viewDir = new THREE.Vector3()
  /** 场景 → 云 → 空气透视合成 → 景深 → 累积 → 泛光与调色（见 aerial/post.ts） */
  private renderFrame() {
    const cam = this.camera
    const moved = this.post.cameraChanged(cam)
    cam.getWorldDirection(this.viewDir)
    // 重新取焦点：鼠标移动后，或镜头停下后（运动中焦点跟着镜头平移，不逐帧步进高度场）
    if (this.pointer && moved) this.pointer.dirty = true
    if (this.pointer?.dirty && !moved && this.world) {
      this.focusPoint = this.pickWorld(this.pointer.x, this.pointer.y)
      this.pointer.dirty = false
    }
    const fp = this.focusPoint ?? this.controls.target
    const want = Math.max(cam.near * 4, this.tmp.copy(fp).sub(cam.position).dot(this.viewDir))
    // 换焦点时平滑追过去（像手动拉焦）；镜头在动时直接跟上，不拖泥带水
    const prevFocus = this.focusDist
    this.focusDist = prevFocus > 0 && !moved ? prevFocus + (want - prevFocus) * 0.18 : want
    const focus = this.focusDist
    // 焦点越近弥散圆越大（固定镜头拍更小的物体），拉近时微缩感更强
    const aperture = this.opts.dof * 22 * Math.min(1.8, Math.sqrt(60 / focus))
    // 移动中缩小渲染，静止时全分辨率累积成片
    const scale = moved ? this.motionScale : 1
    this.lastScale = moved ? scale : 0
    this.timer.tag = this.lastScale
    this.lights.viewportHeight = this.container.clientHeight * this.renderer.getPixelRatio() * scale
    this.post.render(this.renderer, this.scene, cam, focus, aperture, this.opts.clouds ? this.clouds : null, this.timer, scale)
  }

  /** 显示器刷新间隔：rAF 间隔的低分位数（渲染慢时间隔会变长，但总有空闲帧反映真实刷新率） */
  private trackRefresh(now: number) {
    if (this.lastRaf) this.rafDeltas.push(now - this.lastRaf)
    this.lastRaf = now
    if (this.rafDeltas.length < 90) return
    const d = this.rafDeltas.sort((a, b) => a - b)[Math.floor(this.rafDeltas.length * 0.1)]
    this.rafDeltas.length = 0
    this.refreshMs = Math.min(1000 / 30, Math.max(1000 / 240, d))
  }

  /** 按一帧移动中的实测耗时调节缩放：像素数与缩放平方成正比，留 12% 余量 */
  private adaptScale(ms: number, scale: number) {
    // 巡览是持续运动：以 60 fps 为目标，画面优先
    const target = (this.tour.active ? Math.max(this.refreshMs, 1000 / 60) : this.refreshMs) * 0.88
    const want = scale * Math.sqrt(target / Math.max(ms, 0.1))
    const min = this.quality.minScale
    // 超时就快降，有余量时慢升，避免来回抖
    const k = want < this.motionScale ? 0.5 : 0.15
    this.motionScale = Math.min(1, Math.max(min, this.motionScale + (want - this.motionScale) * k))
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    // 模块隐藏（v-show）时报 0×0：保留现有渲染目标，切回来不必整套重建
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    const pr = this.renderer.getPixelRatio()
    this.clouds?.setSize(Math.round(w * pr), Math.round(h * pr))
    this.post.setSize(Math.round(w * pr), Math.round(h * pr))
    this.labelsDirty = true
    this.renderer.domElement.style.width = w + 'px'
    this.renderer.domElement.style.height = h + 'px'
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }

  setOptions(o: Partial<View3DOptions>) {
    const prev = this.opts
    this.opts = { ...this.opts, ...o }
    if (o.exaggeration !== undefined && o.exaggeration !== prev.exaggeration && this.world) this.rebuildGeometry()
    if (o.labels !== undefined) {
      this.labelLayer.style.display = this.opts.labels ? '' : 'none'
      this.labelsDirty = true
    }
    if (o.quality !== undefined && o.quality !== prev.quality) this.applyQuality()
    if (o.shadowSoftness !== undefined) this.applyShadow()
    // 观感只在终合成里生效：不打断累积
    if (o.look) {
      this.post.setLook(this.opts.look)
      this.lastInteract = performance.now()
    }
    // 地名是 DOM、观感是终合成，其余选项都改变场景本身
    if (Object.keys(o).some((k) => k !== 'labels' && k !== 'look')) {
      this.lastInteract = performance.now()
      this.applyLook()
    }
  }

  private get quality() {
    return QUALITIES.find((x) => x.id === this.opts.quality)!.q
  }

  /** 画质档位：像素比、MSAA、阴影贴图、云、泛光、累积 */
  private applyQuality() {
    const q = this.quality
    const cap = this.renderer.capabilities
    this.renderer.setPixelRatio(Math.min(q.pixelRatio, window.devicePixelRatio))
    this.post.setQuality(q, cap.maxSamples)
    const size = Math.min(q.shadowMap, cap.maxTextureSize)
    const sh = this.sun.shadow
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size)
      sh.map?.dispose()
      sh.map = null
      this.renderer.shadowMap.needsUpdate = true
    }
    if (this.clouds) {
      this.clouds.march.uniforms.uSteps.value = q.cloudSteps
      this.clouds.scale = q.cloudScale
    }
    this.applyShadow()
    this.resize()
  }

  /** 阴影软硬：PCF 半径以纹素计，按阴影贴图尺寸换算成同样的世界尺度。只影响采样，不必重画阴影贴图 */
  private applyShadow() {
    // 月光的阴影更柔
    this.sun.shadow.radius = Math.max(1, (this.opts.shadowSoftness * this.dl.shadowSoft * this.sun.shadow.mapSize.x) / 4096)
    this.post.reset()
  }

  /** 云层、空气感、展台开关与光照 */
  private applyLook() {
    this.diorama.stage.visible = this.opts.stage
    const roadsOn = this.opts.roads && !!this.roadMask ? 1 : 0
    // 桥投影：显隐变了才重画阴影贴图
    for (const c of this.group.children)
      if (c.userData.bridge && c.visible !== !!roadsOn) {
        c.visible = !!roadsOn
        this.renderer.shadowMap.needsUpdate = true
      }
    if (this.terrainU) this.terrainU.uRoadOn.value = roadsOn
    if (this.waterMat) this.waterMat.uniforms.uRoadOn.value = roadsOn
    const cloudsOn = this.opts.clouds && !!this.clouds
    if (this.terrainU) this.terrainU.uCloudOn.value = cloudsOn ? 1 : 0
    if (this.waterMat) this.waterMat.uniforms.uCloudOn.value = cloudsOn ? 1 : 0
    this.updateSun()
  }

  /** 光照变了（时刻、太阳、天色、空气感）：阴影与累积的历史都要重来 */
  private updateSun() {
    this.applyDaylight(true)
  }

  /**
   * 按当前时刻铺开整套光照（aerial/daylight.ts 算好的数值分发给各个材质）。
   * immediate：累积重来，主光方向有任何变化都立即重画阴影贴图；昼夜循环逐帧推进时为 false——
   * 阴影只在主光转过 SHADOW_STEP 或日月交接时重画，累积不打断。
   * 阴影贴图只取决于主光方向与投影物（地形、剖面、底座、桥），
   * 霾、云、景深、展台、阴影软硬等选项不改变它，不重画。
   */
  private applyDaylight(immediate: boolean) {
    const dl = daylight(this.opts.timeOfDay, this.opts.sunAzimuth, this.opts.sunElevation)
    const softChanged = dl.shadowSoft !== this.dl.shadowSoft
    this.dl = dl
    const d = dl.keyDir
    if (dl.moonKey !== this.shadowMoon || (immediate ? !this.shadowDir.equals(d) : this.shadowDir.angleTo(d) > SHADOW_STEP)) {
      this.renderer.shadowMap.needsUpdate = true
      this.shadowDir.copy(d)
      this.shadowMoon = dl.moonKey
    }
    if (immediate) this.post.reset()
    if (softChanged) this.sun.shadow.radius = Math.max(1, (this.opts.shadowSoftness * dl.shadowSoft * this.sun.shadow.mapSize.x) / 4096)
    // 主光：白天是太阳，夜里是月亮（同一盏投影的平行光）
    this.sun.position.copy(d).multiplyScalar(150)
    this.sun.target.position.set(0, 0, 0)
    this.sun.color.copy(dl.keyColor)
    this.sun.intensity = dl.keyIntensity
    this.hemi.color.copy(dl.hemiSky)
    this.hemi.groundColor.copy(dl.hemiGround)
    this.hemi.intensity = dl.hemiIntensity
    // 水面的高光：太阳，或夜里月亮的一道碎银
    const glint = dl.moonKey ? 0.22 * dl.moonUp : 1
    if (this.waterMat) {
      const u = this.waterMat.uniforms
      u.uSunDir.value.copy(d)
      u.uSunColor.value.copy(dl.keyColor).multiplyScalar(glint)
      u.uLight.value = dl.light
      u.uSkyTop.value.copy(dl.skyTop)
      u.uSkyHorizon.value.copy(dl.skyHorizon)
    }
    this.diorama.setLight(dl.light, this.tmpColor.copy(dl.keyColor).multiplyScalar(dl.moonKey ? 0.25 * dl.moonUp : dl.sunFade))
    this.diorama.setSky(dl.night, dl.stars, dl.moonDir, dl.moonUp, dl.twilight)
    if (this.terrainU) {
      this.terrainU.uSun.value.copy(d)
      this.terrainU.uNightGlow.value = dl.cityLights
    }
    if (this.clouds) {
      const u = this.clouds.march.uniforms
      u.uSun.value.copy(d)
      u.uSunColor.value.copy(dl.cloudSun)
      u.uSkyTop.value.copy(dl.skyTop)
      u.uSkyHorizon.value.copy(dl.skyHorizon)
      u.uFogColor.value.copy(dl.skyHorizon)
      u.uFogDensity.value = this.opts.haze ? CLOUD_FOG : 0
    }
    // 空气感：霾色随天空，顺光方向有太阳（月亮）散射光晕；低空薄雾高度约 0.9 km
    const c = this.post.comp.uniforms
    c.uSun.value.copy(d)
    c.uSunColor.value.copy(dl.hazeSun)
    c.uHaze.value.copy(dl.skyHorizon).multiplyScalar(0.9)
    c.uFogHeight.value = this.vScale * 0.9
    c.uHazeDensity.value = this.opts.haze ? 0.0026 : 0
    c.uFogDensity.value = this.opts.haze ? 0.035 : 0
    // 夜里提亮曝光（只在终合成，不打断累积）
    this.post.setExposureComp(dl.exposure, dl.night)
    this.lights.level = dl.cityLights
  }
  private tmpColor = new THREE.Color()
  /** 最近一次烘焙的地表高度采样（读回按块缓存，重建几何前一直有效） */
  private bakedFn: ((x: number, z: number) => number) | null = null

  setWorld(world: World, color: HTMLCanvasElement, rough: HTMLCanvasElement, rivers: SmoothRiver[] = []) {
    this.stopTour()
    this.riverList = rivers
    this.world = world
    this.SZ = (SX * world.H) / world.W
    // 清理旧对象
    for (const c of [...this.group.children]) {
      this.group.remove(c)
      c.traverse((o) => {
        const m = o as THREE.Mesh
        // 高清块网格与世界无关，跨世界复用
        if (m.geometry !== this.patchGeo) m.geometry?.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
    }
    this.heightTex?.dispose()
    // 烘焙器绑着旧世界的高度纹理：网格尺寸相同也不能复用
    this.bake?.dispose()
    this.bake = null
    // 水面材质随世界重建，河流材质跟着重建
    this.riverMat = null

    const { W, H } = world
    const ht = new THREE.DataTexture(world.elevation, W, H, THREE.RedFormat, THREE.FloatType)
    ht.magFilter = THREE.LinearFilter
    ht.minFilter = THREE.LinearFilter
    ht.flipY = false
    ht.needsUpdate = true
    this.heightTex = ht
    this.tempTex?.dispose()
    const tt = new THREE.DataTexture(world.temperature, W, H, THREE.RedFormat, THREE.FloatType)
    tt.magFilter = THREE.LinearFilter
    tt.minFilter = THREE.LinearFilter
    tt.needsUpdate = true
    this.tempTex = tt

    const colorTex = new THREE.CanvasTexture(color)
    colorTex.colorSpace = THREE.SRGBColorSpace
    colorTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    colorTex.flipY = false
    const roughTex = new THREE.CanvasTexture(rough)
    roughTex.flipY = false
    this.maskTex?.dispose()
    const mk = new THREE.DataTexture(buildMaterialMask(world), W, H, THREE.RGBAFormat, THREE.UnsignedByteType)
    mk.magFilter = THREE.LinearFilter
    mk.minFilter = THREE.LinearFilter
    mk.needsUpdate = true
    this.maskTex = mk
    this.mask2Tex?.dispose()
    const mk2 = new THREE.DataTexture(buildDetailMask(world), W, H, THREE.RGBAFormat, THREE.UnsignedByteType)
    mk2.magFilter = THREE.LinearFilter
    mk2.minFilter = THREE.LinearFilter
    mk2.needsUpdate = true
    this.mask2Tex = mk2
    const hSize = new THREE.Vector2(W, H)
    const { mat, uniforms, depth, makePatch } = createTerrainMaterial(colorTex, roughTex, mk, mk2, ht, hSize, new THREE.Vector2(SX, this.SZ), this.vScale)
    this.terrainU = uniforms
    this.patch?.bake.dispose()
    {
      const bake = new TerrainBake(PATCH_N, PATCH_N, ht, hSize, new THREE.Vector2(SX, this.SZ))
      const pm = makePatch(bake.rt.texture, PATCH_N)
      this.patchGeo ??= patchGeometry(PATCH_N)
      const mesh = new THREE.Mesh(this.patchGeo, pm.mat)
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.visible = false
      this.group.add(mesh)
      this.patch = { bake, mesh, u: pm.uniforms, cx: 0, cz: 0, S: 0, vs: 0 }
      uniforms.uPatch.value.set(0, 0, 0, 0)
    }
    this.terrain = new THREE.Mesh(new THREE.BufferGeometry(), mat)
    this.terrain.customDepthMaterial = depth
    this.terrain.castShadow = true
    this.terrain.receiveShadow = true
    this.group.add(this.terrain)

    this.waterMat = createWaterMaterial(ht, tt, colorTex, this.vScale, new THREE.Vector2(SX, this.SZ), hSize)
    // 道路遮罩与垂直夸张无关，每个世界画一次
    this.roadMask?.dispose()
    this.roadMask = new RoadMask(W, H, new THREE.Vector2(SX, this.SZ))
    this.roadMask.render(this.renderer, world, new THREE.Vector2(SX, this.SZ))
    uniforms.uRoads.value = this.roadMask.rt.texture
    this.waterMat.uniforms.uRoads.value = this.roadMask.rt.texture
    this.water = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMat)
    this.water.renderOrder = 2
    this.group.add(this.water)
    this.post.comp.uniforms.uBox.value.set(-SX / 2, -this.SZ / 2, SX / 2, this.SZ / 2)
    this.buildNameplate()

    this.rebuildGeometry()
    this.updateSun()
    this.applyLook()
    this.buildLabels()
  }

  private buildClouds() {
    const w = this.world!
    this.clouds?.dispose()
    let seed = 0
    for (const ch of w.params.seed) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
    // 积云：云底约 1.6 km、云顶约 4.5 km（随垂直夸张一起缩放）
    const base = this.vScale * 1.6 + 0.4
    const top = this.vScale * 4.5 + 0.9
    this.clouds = new VolumetricClouds(seed, SX, this.SZ, base, top, 0.28, this.post.sceneRT.depthTexture!)
    this.clouds.march.uniforms.uSteps.value = this.quality.cloudSteps
    this.clouds.scale = this.quality.cloudScale
    const pr = this.renderer.getPixelRatio()
    this.clouds.setSize(Math.round(this.container.clientWidth * pr), Math.round(this.container.clientHeight * pr))
    for (const u of [this.terrainU!, this.waterMat!.uniforms as unknown as TerrainUniforms]) {
      u.uCloud.value = this.clouds.coverage
      u.uCloudRect.value.copy(this.clouds.rect)
      u.uCloudY.value = base + (top - base) * 0.25
    }
  }

  private rebuildGeometry() {
    const w = this.world!
    const vs = this.vScale
    this.terrain!.geometry.dispose()
    this.terrain!.geometry = this.terrainGeometry(w, vs)
    // 烘焙高度/坡度/侵蚀（换世界或改垂直夸张时）
    const { GW, GH } = this.gridDims(w)
    if (!this.bake || this.bake.GW !== GW || this.bake.GH !== GH) {
      this.bake?.dispose()
      this.bake = new TerrainBake(GW, GH, this.heightTex!, new THREE.Vector2(w.W, w.H), new THREE.Vector2(SX, this.SZ))
    }
    // 河流：先建网格并渲染河谷下切图，烘焙时从地形里减去
    for (const c of [...this.group.children]) if (c.userData.river) {
      this.group.remove(c)
      ;(c as THREE.Mesh).geometry.dispose()
    }
    if (!this.riverMat) this.riverMat = createRiverWaterMaterial(this.waterMat!)
    const rv = createRiverMesh(w, this.riverList, SX, this.SZ, this.riverMat)
    rv.mesh.userData.river = true
    this.group.add(rv.mesh)
    this.carve?.dispose()
    this.carve = new RiverCarve(w.W, w.H, new THREE.Vector2(SX, this.SZ))
    this.carve.render(this.renderer, rv.carveGeometry)
    rv.carveGeometry.dispose()
    const ct = this.carve.rt
    this.bake.setCarve(ct.texture, ct.width, ct.height)
    this.patch?.bake.setCarve(ct.texture, ct.width, ct.height)
    this.waterMat!.uniforms.uCarve.value = ct.texture
    this.bake.bake(this.renderer, vs)
    // 桥：道路过河处，高度读烘焙好的真实地表（随垂直夸张重建）
    for (const c of [...this.group.children]) if (c.userData.bridge) {
      this.group.remove(c)
      const m = c as THREE.Mesh
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
    const baked = this.bakedHeight()
    this.bakedFn = baked
    const bridges = buildBridges(w, this.riverList, SX, this.SZ, baked)
    if (bridges) {
      bridges.userData.bridge = true
      this.group.add(bridges)
    }
    for (const u of [this.terrainU!, this.waterMat!.uniforms as unknown as TerrainUniforms]) {
      u.uBaked.value = this.bake.rt.texture
      u.uGSize.value.set(GW, GH)
    }
    this.renderer.shadowMap.needsUpdate = true
    this.water!.geometry.dispose()
    this.water!.geometry = this.waterGeometry(w, vs)
    this.waterMat!.uniforms.uVScale.value = vs
    this.terrainU!.uVScale.value = vs
    // 侧面剖面
    for (const c of [...this.group.children]) if (c.userData.skirt) {
      this.group.remove(c)
      ;(c as THREE.Mesh).geometry.dispose()
    }
    // 岩层剖面底面随垂直夸张变化，底座与桌面跟着平移
    const base = -4.8 * vs - 1.2
    this.group.add(...this.skirts(w, vs, base))
    this.diorama.setBase(base)
    for (const l of this.labelEls) l.pos.y = this.labelY(l.kind, l.pos.x, l.pos.z)
    this.labelsDirty = true
    // 城市灯火钉在真实地表上（随垂直夸张重建）
    this.lights.build(w, { SX, SZ: this.SZ, height: baked })
    this.buildClouds()
    this.applyLook()
  }

  /** 世界坐标 → 格坐标 */
  private toCell(x: number, z: number) {
    const w = this.world!
    return { gx: (x / SX + 0.5) * (w.W - 1), gy: (z / this.SZ + 0.5) * (w.H - 1) }
  }

  /**
   * 视口高清块：镜头静止后，若离地够近，就以视线落点附近为中心烘焙一块
   * 边长约为观察距离 1.5 倍的高清地形（侵蚀噪声多 1~3 层）；镜头移出一定范围或缩放明显时重新烘焙。
   */
  private updatePatch() {
    const p = this.patch
    const u = this.terrainU
    if (!p || !u || !this.world) return
    const dist = this.camera.position.distanceTo(this.controls.target)
    if (dist > 26) {
      if (p.mesh.visible) {
        p.mesh.visible = false
        u.uPatch.value.w = 0
      }
      return
    }
    // 交互中不重烘焙，停下来再换
    if (performance.now() - this.lastInteract < 180) return
    const t = this.controls.target
    const c = this.camera.position
    // 中心略偏向镜头：画面下半部分（离镜头更近）最需要细节
    const cx = t.x + (c.x - t.x) * 0.35
    const cz = t.z + (c.z - t.z) * 0.35
    const S = Math.min(32, Math.max(2.5, dist * 1.5))
    const vs = this.vScale
    if (p.mesh.visible && p.vs === vs && Math.hypot(cx - p.cx, cz - p.cz) < p.S * 0.15 && Math.abs(Math.log(S / p.S)) < 0.25) return
    const oct = S < 5 ? 7 : S < 12 ? 6 : 5
    p.bake.setRegion(cx, cz, S, S, oct)
    p.bake.bake(this.renderer, vs)
    p.u.uBOrigin.value.set(cx, cz)
    p.u.uBMapSize.value.set(S, S)
    u.uPatch.value.set(cx, cz, S, 1)
    this.post.reset()
    Object.assign(p, { cx, cz, S, vs })
    p.mesh.visible = true
  }

  /**
   * 渲染地形的真实高度（世界单位）：读 GPU 烘焙纹理（含 B 样条、侵蚀位移与河谷下切）。
   * 按 32×32 纹素分块按需读回并缓存，桥只集中在少数几处，读回量很小。
   */
  private bakedHeight() {
    const bake = this.bake!
    const { GW, GH } = bake
    const vs = this.vScale
    const T = 32
    const tiles = new Map<number, { d: Float32Array; x0: number; y0: number; w: number }>()
    const texel = (i: number, j: number) => {
      i = Math.min(GW - 1, Math.max(0, i))
      j = Math.min(GH - 1, Math.max(0, j))
      const tx = Math.floor(i / T)
      const ty = Math.floor(j / T)
      const key = ty * 4096 + tx
      let tile = tiles.get(key)
      if (!tile) {
        const x0 = tx * T
        const y0 = ty * T
        const w = Math.min(T, GW - x0)
        const h = Math.min(T, GH - y0)
        const d = new Float32Array(w * h * 4)
        this.renderer.readRenderTargetPixels(bake.rt, x0, y0, w, h, d)
        tile = { d, x0, y0, w }
        tiles.set(key, tile)
      }
      return tile.d[((j - tile.y0) * tile.w + (i - tile.x0)) * 4]
    }
    return (x: number, z: number) => {
      const fx = (x / SX + 0.5) * (GW - 1)
      const fy = (z / this.SZ + 0.5) * (GH - 1)
      const i = Math.floor(fx)
      const j = Math.floor(fy)
      const u = fx - i
      const v = fy - j
      const h = (texel(i, j) * (1 - u) + texel(i + 1, j) * u) * (1 - v) + (texel(i, j + 1) * (1 - u) + texel(i + 1, j + 1) * u) * v
      return h * vs
    }
  }

  heightAt(x: number, z: number): number {
    const w = this.world!
    const { gx, gy } = this.toCell(x, z)
    const x0 = Math.max(0, Math.min(w.W - 2, Math.floor(gx)))
    const y0 = Math.max(0, Math.min(w.H - 2, Math.floor(gy)))
    const fx = Math.min(1, Math.max(0, gx - x0))
    const fy = Math.min(1, Math.max(0, gy - y0))
    const e = w.elevation
    const i = y0 * w.W + x0
    const h = (e[i] * (1 - fx) + e[i + 1] * fx) * (1 - fy) + (e[i + w.W] * (1 - fx) + e[i + w.W + 1] * fx) * fy
    return h * this.vScale
  }

  /**
   * 地形网格：比高度图更密（约 2 倍），高度与法线都在顶点着色器里由
   * 双三次插值 + 亚网格细节求得，这里只给平面坐标和贴图坐标。
   */
  private gridDims(w: World) {
    const d = Math.min(2, Math.sqrt(3.2e6 / (w.W * w.H)))
    return { GW: Math.round((w.W - 1) * d) + 1, GH: Math.round((w.H - 1) * d) + 1 }
  }

  /**
   * 地形网格：烘焙纹理分辨率的一半（三角形 1/4）。法线在片元里逐像素取自烘焙纹理，
   * 网格疏密只影响轮廓与视差（亚像素级）；原先三角形比像素还小，光栅化和 2×2 像素块着色白白浪费。
   */
  private meshDims(w: World) {
    const { GW, GH } = this.gridDims(w)
    return { GW: Math.round((GW - 1) / 2) + 1, GH: Math.round((GH - 1) / 2) + 1 }
  }

  private terrainGeometry(w: World, _vs: number) {
    const { W, H } = w
    const { GW, GH } = this.meshDims(w)
    const pos = new Float32Array(GW * GH * 3)
    const uv = new Float32Array(GW * GH * 2)
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const i = y * GW + x
        const fx = x / (GW - 1)
        const fy = y / (GH - 1)
        pos[i * 3] = (fx - 0.5) * SX
        pos[i * 3 + 2] = (fy - 0.5) * this.SZ
        // 与高度图纹素中心对齐
        uv[i * 2] = (fx * (W - 1) + 0.5) / W
        uv[i * 2 + 1] = (fy * (H - 1) + 0.5) / H
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    // 占位法线（真正的法线在顶点着色器里求）：没有 normal 属性时 three 会退化为平面着色
    const nor = new Int8Array(GW * GH * 3)
    for (let i = 0; i < GW * GH; i++) nor[i * 3 + 1] = 127
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true))
    g.setIndex(gridIndex(GW, GH))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.hypot(SX, this.SZ))
    return g
  }

  /** 水面网格：海洋为 0，湖泊为湖面；陆地深埋地下（片元着色器按水深丢弃） */
  private waterGeometry(w: World, vs: number) {
    const step = 2
    const { W, H, water } = w
    const GW = Math.ceil((W - 1) / step) + 1
    const GH = Math.ceil((H - 1) / step) + 1
    const pos = new Float32Array(GW * GH * 3)
    const uv = new Float32Array(GW * GH * 2)
    const dx = SX / (W - 1)
    const dz = this.SZ / (H - 1)
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const cx = Math.min(W - 1, gx * step)
        const cy = Math.min(H - 1, gy * step)
        let lv = -Infinity
        for (let oy = -2; oy <= 2; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            const x = cx + ox, y = cy + oy
            if (x < 0 || y < 0 || x >= W || y >= H) continue
            const v = water[y * W + x]
            if (!Number.isNaN(v) && v > lv) lv = v
          }
        }
        const k = gy * GW + gx
        pos[k * 3] = cx * dx - SX / 2
        pos[k * 3 + 1] = lv === -Infinity ? -40 : lv * vs
        pos[k * 3 + 2] = cy * dz - this.SZ / 2
        uv[k * 2] = cx / (W - 1)
        uv[k * 2 + 1] = cy / (H - 1)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(gridIndex(GW, GH))
    g.computeBoundingSphere()
    return g
  }

  /** 沙盘四周的剖面：岩层 + 海水截面（aTop 为该列地表 / 海床高度），岩层底面在 base */
  private skirts(w: World, vs: number, base: number): THREE.Object3D[] {
    const { W, H, elevation: e } = w
    const rockPos: number[] = []
    const rockTop: number[] = []
    const seaPos: number[] = []
    const seaTop: number[] = []
    const edges: [number, number][][] = [
      Array.from({ length: W }, (_, x) => [x, 0]),
      Array.from({ length: W }, (_, x) => [W - 1 - x, H - 1]),
      Array.from({ length: H }, (_, y) => [0, H - 1 - y]),
      Array.from({ length: H }, (_, y) => [W - 1, y]),
    ]
    const dx = SX / (W - 1)
    const dz = this.SZ / (H - 1)
    for (const edge of edges) {
      for (let k = 0; k < edge.length - 1; k++) {
        const [x0, y0] = edge[k]
        const [x1, y1] = edge[k + 1]
        const X0 = x0 * dx - SX / 2, Z0 = y0 * dz - this.SZ / 2
        const X1 = x1 * dx - SX / 2, Z1 = y1 * dz - this.SZ / 2
        const h0 = e[y0 * W + x0] * vs
        const h1 = e[y1 * W + x1] * vs
        quad(rockPos, rockTop, [X0, h0, Z0], [X1, h1, Z1], [X1, base, Z1], [X0, base, Z0], h0, h1)
        if (h0 < 0 || h1 < 0) {
          quad(seaPos, seaTop, [X0, 0, Z0], [X1, 0, Z1], [X1, Math.min(h1, 0), Z1], [X0, Math.min(h0, 0), Z0], h0, h1)
        }
      }
    }
    const mk = (p: number[], top: number[], mat: THREE.Material) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
      g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1))
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, mat)
      m.userData.skirt = true
      return m
    }
    const rock = mk(rockPos, rockTop, this.diorama.strata.mat)
    rock.castShadow = true
    rock.receiveShadow = true
    const sea = mk(seaPos, seaTop, this.diorama.seaSection.mat)
    sea.renderOrder = 3
    return [rock, sea]
  }

  /** 地点被编辑后重建 3D 地名 */
  /** 语言切换：地名与铭牌换成新语言 */
  refreshLanguage() {
    if (!this.world) return
    this.buildLabels()
    this.buildNameplate()
    this.diorama.setBase(-4.8 * this.vScale - 1.2)
    this.post.reset()
  }

  private buildNameplate() {
    const w = this.world!
    this.diorama.build({
      SX,
      SZ: this.SZ,
      title: worldTitle(w),
      subtitle: t('{km} 公里 · 种子 {seed}', { km: Math.round(w.W * w.kmPerCell).toLocaleString('en-US'), seed: w.params.seed }),
    })
  }

  /** 地面数据不变、只有名字变了（改命名）：换地名层与铭牌，不重建地形、水面、云 */
  setNames(world: World) {
    this.world = world
    this.refreshLanguage()
  }

  refreshLabels() {
    if (!this.world) return
    this.buildLabels()
    // 地点增删、挪动后灯火跟着走
    if (this.bakedFn) this.lights.build(this.world, { SX, SZ: this.SZ, height: this.bakedFn })
  }

  /** 只改了某个地点的名字：换那一个地名的文字，不重建整层 */
  renameLabel(l: Label) {
    const e = this.labelEls.find((x) => x.src === l)
    if (!e) return
    e.el.textContent = placeName(l)
    e.w = e.el.offsetWidth
    e.h = e.el.offsetHeight
    this.labelsDirty = true
  }

  private buildLabels() {
    const w = this.world!
    this.labelLayer.innerHTML = ''
    this.labelEls = []
    const kinds = new Set(['continent', 'island', 'ocean', 'sea', 'range', 'city', 'capital', 'lake'])
    const sorted = [...w.labels].filter((l) => kinds.has(l.kind)).sort((a, b) => b.weight - a.weight)
    for (const l of sorted.slice(0, 60)) {
      if (l.kind === 'island' && l.weight < 800) continue
      const el = document.createElement('div')
      el.className = `l3 l3-${l.kind}`
      el.textContent = placeName(l)
      const x = this.toX(l.x)
      const z = this.toZ(l.y)
      const pos = new THREE.Vector3(x, this.labelY(l.kind, x, z), z)
      this.labelLayer.appendChild(el)
      this.labelEls.push({ el, pos, kind: l.kind, w: 0, h: 0, src: l })
    }
    for (const l of this.labelEls) {
      l.w = l.el.offsetWidth
      l.h = l.el.offsetHeight
    }
    this.labelLayer.style.display = this.opts.labels ? '' : 'none'
    this.labelsDirty = true
  }

  /** 地名锚点高度：城镇标点钉在地面上，海名贴海面，山脉、大陆等区域名悬在上空 */
  private labelY(kind: string, x: number, z: number) {
    if (kind === 'ocean' || kind === 'sea') return 0.3
    if (kind === 'city' || kind === 'capital') return this.heightAt(x, z) + 0.01
    return this.heightAt(x, z) + 0.6
  }

  private tmp = new THREE.Vector3()
  /** 地名层需要重排（地名增删改、锚点高度、尺寸、开关变了）；否则只在镜头动了时重排 */
  private labelsDirty = true
  private labelView = new THREE.Matrix4()
  private labelProj = new THREE.Matrix4()
  private labelDist = -1
  /** 已放下的地名框，每 4 个数一个 [x0, y0, x1, y1] */
  private labelBoxes: number[] = []
  private updateLabels() {
    if (!this.opts.labels || !this.labelEls.length) return
    const cam = this.camera
    const dist = cam.position.distanceTo(this.controls.target)
    if (!this.labelsDirty && dist === this.labelDist && this.labelView.equals(cam.matrixWorld) && this.labelProj.equals(cam.projectionMatrix)) return
    this.labelsDirty = false
    this.labelDist = dist
    this.labelView.copy(cam.matrixWorld)
    this.labelProj.copy(cam.projectionMatrix)
    const wpx = this.container.clientWidth
    const hpx = this.container.clientHeight
    const boxes = this.labelBoxes
    boxes.length = 0
    for (const l of this.labelEls) {
      this.tmp.copy(l.pos).project(this.camera)
      const vis = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1
      // 按缩放层级显隐：远看只显示大地名，近看显示城市
      const minor = l.kind === 'city' || l.kind === 'lake' || l.kind === 'island'
      const show = vis && (!minor || dist < 70) && !(l.kind === 'continent' && dist < 18)
      l.el.style.opacity = show ? '1' : '0'
      if (!show) continue
      const x = (this.tmp.x * 0.5 + 0.5) * wpx
      const y = (-this.tmp.y * 0.5 + 0.5) * hpx
      // 与更重要的地名重叠则隐藏
      const b0 = x - l.w / 2 - 4
      const b1 = y - l.h - 2
      const b2 = x + l.w / 2 + 4
      const b3 = y + 2
      let hit = false
      for (let q = 0; q < boxes.length; q += 4) {
        if (b0 < boxes[q + 2] && b2 > boxes[q] && b1 < boxes[q + 3] && b3 > boxes[q + 1]) {
          hit = true
          break
        }
      }
      if (hit) {
        l.el.style.opacity = '0'
        continue
      }
      boxes.push(b0, b1, b2, b3)
      const dot = l.kind === 'capital' ? 3.5 : l.kind === 'city' ? 2.5 : 0
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${(y + dot).toFixed(1)}px) translate(-50%, -100%)`
    }
  }

  /** 屏幕坐标 → 格坐标 */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const p = this.pickWorld(clientX, clientY)
    if (!p) return null
    const { gx, gy } = this.toCell(p.x, p.z)
    return { x: Math.round(gx), y: Math.round(gy) }
  }

  /** 屏幕坐标 → 地表（海面）上的世界坐标（沿视线在高度场上步进求交） */
  pickWorld(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.world) return null
    const r = this.renderer.domElement.getBoundingClientRect()
    this.pickNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    const ray = this.pickRay
    ray.setFromCamera(this.pickNdc, this.camera)
    const o = ray.ray.origin
    const d = ray.ray.direction
    if (d.y >= 0) return null
    const top = 8 * this.vScale
    let t = Math.max(0, (top - o.y) / d.y)
    const step = 0.08
    for (let k = 0; k < 4000; k++) {
      const x = o.x + d.x * t
      const y = o.y + d.y * t
      const z = o.z + d.z * t
      if (Math.abs(x) > SX / 2 || Math.abs(z) > this.SZ / 2) {
        if (y < -10) return null
        t += step
        continue
      }
      const h = Math.max(0, this.heightAt(x, z))
      if (y <= h) return new THREE.Vector3(x, h, z)
      t += step
    }
    return null
  }

  resetCamera() {
    this.camera.position.set(0, 50, 60)
    this.controls.target.set(0, 0, 0)
  }

  snapshot(): string {
    this.renderFrame()
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
  }
}

/** 高清块网格分辨率 */
const PATCH_N = 513

/**
 * 高清块：[0,1]² 的规则网格（顶点着色器按 uPatch 映射到世界），
 * 四周再加一圈向下的裙边（position.y = 1 的顶点下沉），遮住与粗网格之间的细缝。
 */
function patchGeometry(N: number) {
  const R = 4 * (N - 1)
  const ring = new Uint32Array(R)
  let r = 0
  for (let x = 0; x < N; x++) ring[r++] = x
  for (let y = 1; y < N; y++) ring[r++] = y * N + N - 1
  for (let x = N - 2; x >= 0; x--) ring[r++] = (N - 1) * N + x
  for (let y = N - 2; y > 0; y--) ring[r++] = y * N
  const total = N * N + R
  const pos = new Float32Array(total * 3)
  const uv = new Float32Array(total * 2)
  const nor = new Int8Array(total * 3)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x
      pos[i * 3] = x / (N - 1)
      pos[i * 3 + 2] = y / (N - 1)
    }
  }
  for (let k = 0; k < R; k++) {
    const src = ring[k]
    const i = N * N + k
    pos[i * 3] = pos[src * 3]
    pos[i * 3 + 1] = 1
    pos[i * 3 + 2] = pos[src * 3 + 2]
  }
  for (let i = 0; i < total; i++) nor[i * 3 + 1] = 127
  const grid = gridIndex(N, N).array as Uint32Array
  const idx = new Uint32Array(grid.length + R * 12)
  idx.set(grid)
  let j = grid.length
  for (let k = 0; k < R; k++) {
    const k1 = k + 1 === R ? 0 : k + 1
    const a = ring[k]
    const b = ring[k1]
    const a2 = N * N + k
    const b2 = N * N + k1
    // 两面都连：裙边从哪一侧看都不透
    idx[j++] = a
    idx[j++] = b
    idx[j++] = a2
    idx[j++] = b
    idx[j++] = b2
    idx[j++] = a2
    idx[j++] = a
    idx[j++] = a2
    idx[j++] = b
    idx[j++] = b
    idx[j++] = a2
    idx[j++] = b2
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
}

function gridIndex(W: number, H: number) {
  const idx = new Uint32Array((W - 1) * (H - 1) * 6)
  let k = 0
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = y * W + x
      const b = a + 1
      const c = a + W
      const d = c + 1
      idx[k++] = a
      idx[k++] = c
      idx[k++] = b
      idx[k++] = b
      idx[k++] = c
      idx[k++] = d
    }
  }
  return new THREE.BufferAttribute(idx, 1)
}

function quad(pos: number[], top: number[], a: number[], b: number[], c: number[], d: number[], ta: number, tb: number) {
  pos.push(...a, ...b, ...c, ...a, ...c, ...d)
  top.push(ta, tb, tb, ta, tb, ta)
}
