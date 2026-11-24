import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { P } from '../../settlement/geom'
import { snapshot, type SettlementHistory } from '../../settlement/history'
import type { SettleStyleId } from '../../settlement/themes'
import type { MapLabel, Settlement } from '../../settlement/types'
import { isTypingTarget } from '../../ui/keys'
import { PostPipeline } from '../aerial/post'
import { GpuTimer } from '../aerial/gpuTimer'
import { QUALITIES, type Look, type QualityId } from '../aerial/looks'
import { Diorama } from '../aerial/diorama'
import { daylight, type Daylight } from '../aerial/daylight'
import { FocusProbe } from '../aerial/focusProbe'
import { CameraTour, type TourPoi } from '../aerial/tour'
import { patchBuilding } from './buildingShader'
import { heightSampler, type TownBuild } from './massing'
import type { TownChunk } from './mesh'
import { TownGround, skirtGeometries } from './ground'
import { WATER_LEVEL } from './relief'
import { TreeLayer } from './treeLayer'
import { CameraRig } from './cameraRig'
import { HeightField } from './heightField'
import { SunShadows } from './sunShadows'
import { TownLabels } from './labels'
import { createTownLights } from './townLights'

/**
 * 聚落沙盘：成长史中出现过的全部体块与树一次建好（见 massing.ts，在 Worker 里构建），
 * 地面是二维渲染器的地面层贴图，外面是世界沙盘的胡桃木底座、昼夜光照与后期管线。
 *
 * 成长：每个顶点（树为每个实例）带生卒，着色器按人口 uPop 收起尚未建成或已拆除的体块；
 * 人口从 uPrev 变到 uPop 时，新建的从地基升起、拆除的沉下（uT 0 → 1），地面贴图按节流重画。
 *
 * 舞台（与场景里具体有哪些网格无关的部分）各在一个模块里：
 * - 镜头（cameraRig.ts）：缩放到光标、视点落地、避障、边界、键盘；
 * - 表面高度场（heightField.ts）：自上而下画一遍读回，供镜头避障、缩放锚点与注记遮挡；
 * - 主光与三级阴影（sunShadows.ts）；
 * - 注记（labels.ts）、夜里的灯火（townLights.ts）；
 * - 自动运镜（aerial/tour.ts，与世界沙盘共用）：题材取自地标，镜头高度以表面高度场的包络为底；
 * - 后期（aerial/post.ts，与世界沙盘共用）：环境光遮蔽、空气透视、景深、时间累积、泛光、调色；
 *   对焦距离取自场景深度（aerial/focusProbe.ts）：对在画面上指针所指（没有指针时为画面中心）看到的表面上。
 *
 * 按需渲染：镜头移动、阻尼、按键导航、成长过渡、对焦缓动与静止后的时间累积期间逐帧渲染，
 * 累积收敛后停止请求动画帧，静止时不占用 GPU。
 * 坐标：聚落米坐标（x 东、z 南）整体缩放到 100 单位宽、居中，世界沙盘按这个尺度调好的常数（底座、霾）直接可用。
 */

export interface Town3DOptions {
  /** 时刻（小时 0~24）与正午太阳的方位、高度（同世界沙盘） */
  timeOfDay: number
  sunAzimuth: number
  sunElevation: number
  /** 空气感：远景霾与低空薄雾 */
  haze: boolean
  /** 移轴景深强度 0~1 */
  dof: number
  /** 展台：桌面与展厅背景 */
  stage: boolean
  /** 片区名、地标名的注记 */
  labels: boolean
  quality: QualityId
  shadowSoftness: number
  look: Look
}

const SX = 100
/** 成长过渡的时长（秒） */
const RISE = 0.45
/** 镜头停稳多久（毫秒）后才重画地面高清块：栅格化与上传要上百毫秒，转动、缩放中的短暂停顿不能触发 */
const DETAIL_IDLE = 350
/** 对焦缓动的时间常数（秒） */
const FOCUS_TAU = 0.12
/** 被主光照亮的地面的平均反照率（线性色）：算地面反弹光用，不必跟地面贴图逐像素一致 */
const GROUND_BOUNCE = new THREE.Color().setRGB(0.3, 0.27, 0.19)
/** 展厅背景墙亮带向上衰减的尺度（仰角的正弦） */
const COVE_FALL = 0.17

const deep = (o: THREE.Object3D) =>
  o.traverse((c) => {
    const m = c as THREE.Mesh
    if (!m.isMesh) return
    m.geometry.dispose()
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (const x of mats) x.dispose()
  })

export class TownScene {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(40, 1, 0.05, 3000)
  private rig: CameraRig
  private shadows: SunShadows
  private hemi = new THREE.HemisphereLight(0xc4d7ea, 0x5b4a3a, 0.9)
  /** 环境光的水平分量（一阶球谐）：朝太阳一侧的墙比背着太阳的墙亮、暖，背光的几面墙不再是同一个亮度 */
  private fill = new THREE.LightProbe()
  private post = new PostPipeline()
  private probe: FocusProbe | null = null
  private diorama: Diorama
  private timer: GpuTimer
  private env: THREE.Texture
  private dl: Daylight
  /** 城市组：米坐标，整体缩放 K、平移到中心 */
  private city = new THREE.Group()
  private K = 1
  private SZ = 62.5
  private hist: SettlementHistory | null = null
  private H: (x: number, z: number) => number = () => 0
  private hRange: [number, number] = [0, 0]
  private field = new HeightField()
  private chunks: THREE.Mesh[] = []
  /** 地面：贴图、高清块与每座城的地形、水面网格 */
  private ground: TownGround
  private trees: TreeLayer | null = null
  private style: SettleStyleId = 'color'
  /** 指针按着（拖动中，即使这一帧没动也不算停下） */
  private held = false
  /** 共享的 uniform：成长与夜里的窗灯 */
  private u = {
    uPop: { value: 0 },
    uPrev: { value: 0 },
    uT: { value: 1 },
    uNight: { value: 0 },
    uStorey: { value: 3.1 },
    /** 场景单位 / 米（凹凸的高度换算成场景单位） */
    uMeter: { value: 1 },
    /** 窗与门的样式：0 西式、1 东方、2 和式、3 伊斯兰 */
    uCulture: { value: 0 },
    /** 灯火的光点最小的尺寸：两个像素在裁剪空间里的高度（随画布） */
    uMinNdc: { value: 0.004 },
  }
  private bldMat: THREE.MeshStandardMaterial
  private bldDepth: THREE.MeshDepthMaterial
  /** 成长过渡：开始时刻（performance.now），0 表示没有在过渡 */
  private riseAt = 0
  private riseDur = RISE
  /** 地面贴图：正在画的人口、下一个要画的人口、上次重画的耗时 */
  private paint = { busy: false, next: -1, shown: -1, cost: 0, timer: 0 }
  private opts: Town3DOptions
  private raf = 0
  private active = false
  /** 换城时等着色器编译完再渲染 */
  private ready = true
  private labels: TownLabels
  private lights: THREE.Group | null = null
  private tour: CameraTour
  private tourFade: HTMLDivElement
  private pois: TourPoi[] = []
  /** 自动运镜开始 / 结束时通知界面 */
  onTourChange: ((on: boolean) => void) | null = null
  private perf: { el: HTMLDivElement; frames: number; t0: number } | null = null
  private lastFrame = 0
  private lastMove = 0
  private detailTimer = 0
  private bakeTimer = 0
  private motionScale = 1
  private lastScale = 0
  /** 指针在画面上的位置（鼠标悬停、拖动时）：对焦在它所指的表面上；没有时对在画面中心 */
  private pointer: { x: number; y: number } | null = null
  /** 对焦：当前距离、是否要重新测距、下一帧是否直接到位（换机位、换城） */
  private focus = { dist: 0, dirty: true, snap: true }
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private tmpColor = new THREE.Color()
  private disposers: (() => void)[] = []
  /** 地面贴图重画后（新的人口快照）通知界面：统计与悬停探针用这个快照 */
  onSnapshot: ((s: Settlement) => void) | null = null

  constructor(
    private container: HTMLElement,
    opts: Town3DOptions,
  ) {
    this.opts = { ...opts, look: { ...opts.look } }
    this.dl = daylight(opts.timeOfDay, opts.sunAzimuth, opts.sunElevation)
    // 抗锯齿在后期管线里做；保留绘制缓冲：按需渲染停下后画面留在画布上，导出图片直接读
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true })
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.setClearColor(0x000000, 0)
    this.timer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext)
    container.appendChild(this.renderer.domElement)

    this.camera.position.set(0, 58, 84)
    this.rig = new CameraRig(this.camera, this.renderer.domElement, () => this.invalidate(false))
    this.shadows = new SunShadows(this.scene)
    this.scene.add(this.hemi, this.fill, this.city)
    this.diorama = new Diorama(this.renderer)
    this.scene.add(this.diorama.group)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    // 读回浮点像素要这个扩展；没有时对焦退回到轨道中心
    if (this.renderer.extensions.has('EXT_color_buffer_float')) this.probe = new FocusProbe(this.post.sceneRT.depthTexture!)

    this.ground = new TownGround(this.renderer)

    this.bldMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 })
    patchBuilding(this.bldMat, this.u, false)
    this.bldDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    patchBuilding(this.bldDepth, this.u, true)

    this.labels = new TownLabels(container)
    this.tourFade = document.createElement('div')
    this.tourFade.className = 'tour-fade'
    container.appendChild(this.tourFade)
    const self = this
    this.tour = new CameraTour({
      SX,
      get SZ() {
        return self.SZ
      },
      // 镜头的高度以包络为底：贴近地标时越过屋顶、树冠，而不只是地形
      heightAt: (x, z) => Math.max(self.field.ceiling(x, z), 0),
      get pois() {
        return self.pois
      },
      // 世界沙盘的镜头距离按 100 单位宽调的：换算到环绕半径约百米
      get scale() {
        return Math.min(1, Math.max(0.3, 18 * self.K))
      },
    })
    // 用户一动镜头，运镜就让出
    this.rig.onUserInput = () => this.stopTour()

    new ResizeObserver(() => this.resize()).observe(container)
    this.applyQuality()
    this.post.setLook(this.opts.look)
    this.applyDaylight()

    const el = this.renderer.domElement
    const kick = () => this.invalidate(false)
    el.addEventListener('pointerdown', () => {
      this.lastMove = performance.now()
      this.held = true
      kick()
    })
    const release = () => {
      if (!this.held) return
      this.held = false
      this.lastMove = performance.now()
      kick()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    this.disposers.push(() => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    })
    el.addEventListener('pointermove', (e) => {
      // 触摸没有"悬停"：手指离开后对焦回到画面中心
      if (e.pointerType !== 'mouse') return
      this.pointer = { x: e.clientX, y: e.clientY }
      this.focus.dirty = true
      kick()
    })
    el.addEventListener('pointerleave', () => {
      this.pointer = null
      this.focus.dirty = true
      kick()
    })
    // 动态分辨率：移动中的帧按实测 GPU 耗时调节缩放
    this.timer.onFrame = (ms, scale) => {
      if (scale > 0) this.adaptScale(ms, scale)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!this.active || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e)) return
      if (e.key === 'p' || e.key === 'P') this.togglePerf()
      else if (e.key === 't' || e.key === 'T') this.toggleTour()
      else if (this.tour.active && (e.key === 'n' || e.key === 'N')) this.tour.next()
      else if (this.tour.active && e.key === 'Escape') this.stopTour()
    }
    // 页面卸下（刷新、离开）时主动交还 WebGL 上下文，免得浏览器累积到上限后丢失别的上下文；从往返缓存回来时恢复
    const onHide = () => this.renderer.forceContextLoss()
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) this.renderer.forceContextRestore()
    }
    // 上下文丢失（显卡驱动重置、标签页太多被回收）：拦下默认行为才会有恢复事件；恢复后贴图与缓冲由 three.js 重新上传，
    // 这里把阴影贴图、表面高度场这些"画出来的"重画一遍
    const onLost = (e: Event) => e.preventDefault()
    const onRestored = () => {
      this.shadows.invalidate()
      this.post.reset()
      this.scheduleBake(0)
      this.invalidate()
    }
    el.addEventListener('webglcontextlost', onLost)
    el.addEventListener('webglcontextrestored', onRestored)
    window.addEventListener('keydown', onKey)
    window.addEventListener('pagehide', onHide)
    window.addEventListener('pageshow', onShow)
    this.disposers.push(() => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('pageshow', onShow)
    })
  }

  /** 舞台可见（聚落模块的沙盘模式）时才渲染 */
  setActive(on: boolean) {
    if (this.active === on) return
    this.active = on
    this.rig.enabled = on
    if (on) this.invalidate()
    else {
      this.rig.clearKeys()
      this.stopTour()
    }
  }

  /** 请求重画；reset 时丢掉累积的历史（场景本身变了） */
  invalidate(reset = true) {
    if (reset) this.post.reset()
    if (!this.raf && this.active) this.raf = requestAnimationFrame(this.loop)
  }

  // —— 内容 ——
  /**
   * 换一座城：体块与树（Worker 构建好的数组）、地形网格、地面贴图、水面、剖面与底座。
   * pop：时间轴上的当前人口；st：该人口的快照。
   * 网格在这一轮装好；着色器编译完后再画地面贴图（大城约百毫秒），主线程不连着卡两段；画完时兑现
   */
  async setTown(hist: SettlementHistory, build: TownBuild, st: Settlement, pop: number, style: SettleStyleId, title: { name: string; sub: string }) {
    this.clearTown()
    this.hist = hist
    this.style = style
    const W = hist.st.width
    const D = hist.st.height
    this.K = SX / W
    this.SZ = D * this.K
    this.city.scale.setScalar(this.K)
    this.city.position.set(-SX / 2, 0, -this.SZ / 2)
    this.city.updateMatrixWorld(true)
    this.H = heightSampler(hist.st.terrain)
    const h = hist.st.terrain.height
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < h.length; i++) {
      if (h[i] < lo) lo = h[i]
      if (h[i] > hi) hi = h[i]
    }
    this.hRange = [lo, hi]
    const culture = hist.st.params.culture
    this.u.uStorey.value = culture === 'western' || culture === 'islamic' ? 3.1 : 3.4
    this.u.uCulture.value = ['western', 'eastern', 'wa', 'islamic'].indexOf(culture)
    this.u.uMeter.value = this.K
    this.u.uPop.value = this.u.uPrev.value = pop
    this.u.uT.value = 1

    // 体块
    for (const c of build.chunks) this.chunks.push(this.chunkMesh(c))
    this.city.add(...this.chunks)
    // 树
    this.trees = new TreeLayer(build.trees, this.u)
    this.city.add(this.trees.group)
    // 灯火（街灯、城门的火把；夜里才画）
    this.lights = createTownLights(hist.st, hist.life, this.H, this.u)
    this.lights.visible = this.u.uNight.value > 0
    this.city.add(this.lights)

    // 地面与水
    this.city.add(...this.ground.build(hist.st, build.terrain, this.u, this.K))

    // 剖面与底座：岩层底在最低地表之下约 3 单位
    const base = Math.min(lo * this.K, -0.3) - 3
    const sk = skirtGeometries(build.terrain.rim, this.K, base)
    const rock = new THREE.Mesh(sk.rock, this.diorama.strata.mat)
    rock.castShadow = rock.receiveShadow = true
    rock.userData.shared = true
    this.city.add(rock)
    if (sk.sea) {
      const sea = new THREE.Mesh(sk.sea, this.diorama.seaSection.mat)
      sea.renderOrder = 3
      sea.userData.shared = true
      this.city.add(sea)
    }
    this.diorama.build({ SX, SZ: this.SZ, title: title.name, subtitle: title.sub })
    this.diorama.setBase(base)
    this.post.comp.uniforms.uBox.value.set(-SX / 2, -this.SZ / 2, SX / 2, this.SZ / 2)

    // 舞台按这座城的尺度：镜头的活动范围、阴影的范围与半影、遮蔽的取样半径
    const floor = this.diorama.tableY
    const hx = SX / 2
    const hz = this.SZ / 2
    this.rig.setWorld({
      ground: (x, z) => (Math.abs(x) <= hx && Math.abs(z) <= hz ? Math.max(WATER_LEVEL, this.H((x + hx) / this.K, (z + hz) / this.K)) * this.K : floor),
      field: this.field,
      hx,
      hz,
      floor,
      K: this.K,
    })
    // 高处留出最高的塔、阁（约 90 米）
    this.shadows.setExtent(hx, hz, floor, (hi + 90) * this.K, this.K)
    this.applyShadowSoft()
    this.post.setAO({ radius: 3.2 * this.K, intensity: 1, amount: 0.85 })
    this.focus.snap = true

    this.shadows.invalidate()
    // 着色器在后台并行编译（KHR_parallel_shader_compile），首帧不因同步编译卡住主线程
    this.ready = false
    await this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined)
    if (this.hist !== hist) return
    this.ready = true
    this.paintGround(pop, st)
    this.setLabels(st.labels)
    this.setPois(st)
    this.scheduleBake(0)
  }

  private chunkMesh(c: TownChunk) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(c.pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(c.nrm, 3, true))
    const ib = new THREE.InterleavedBuffer(c.col, 4)
    g.setAttribute('color', new THREE.InterleavedBufferAttribute(ib, 3, 0, true))
    g.setAttribute('aFace', new THREE.InterleavedBufferAttribute(ib, 1, 3, true))
    g.setAttribute('aLife', new THREE.BufferAttribute(c.life, 3))
    g.setAttribute('aUv', new THREE.BufferAttribute(c.uv, 3))
    const [x0, y0, z0, x1, y1, z1] = c.box
    g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1))
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
    const m = new THREE.Mesh(g, this.bldMat)
    m.customDepthMaterial = this.bldDepth
    m.castShadow = m.receiveShadow = true
    m.userData.ids = c.ids
    m.userData.life = c.life
    return m
  }

  private clearTown() {
    if (this.trees) {
      this.city.remove(this.trees.group)
      this.trees.dispose()
      this.trees = null
    }
    for (const c of [...this.city.children]) {
      this.city.remove(c)
      if (c.userData.field) (c.userData.field as THREE.Texture).dispose()
      if (c.userData.depth) (c.userData.depth as THREE.Material).dispose()
      const m = c as THREE.Mesh
      if (c.userData.shared) m.geometry.dispose()
      else if (m.material === this.bldMat) m.geometry.dispose()
      else deep(c)
    }
    this.stopTour()
    this.chunks = []
    this.ground.forget()
    this.lights = null
    this.pois = []
    this.hist = null
    this.field.clear()
    this.rig.setWorld(null)
    clearTimeout(this.paint.timer)
    clearTimeout(this.bakeTimer)
    this.bakeTimer = 0
    this.paint = { busy: false, next: -1, shown: -1, cost: 0, timer: 0 }
  }

  /**
   * 时间轴上的人口变了：体块与树在 dur 秒内升起 / 沉下，地面贴图按节流重画（拖动、回放时只画最新的那个人口）
   */
  setPopulation(pop: number, dur = RISE) {
    if (!this.hist || pop === this.u.uPop.value) return
    // 上一段过渡还没走完：从当前的样子接着走（没升完的新建筑直接到位）
    this.u.uPrev.value = this.u.uPop.value
    this.u.uPop.value = pop
    this.u.uT.value = 0
    this.riseAt = performance.now()
    this.riseDur = Math.max(0.05, dur)
    this.shadows.invalidate()
    this.invalidate()
    this.requestPaint(pop)
  }

  /** 地面贴图的风格（二维地图风格之一） */
  setGroundStyle(style: SettleStyleId) {
    if (style === this.style) return
    this.style = style
    if (!this.hist) return
    this.paint.shown = -1
    this.requestPaint(this.u.uPop.value)
  }

  private requestPaint(pop: number) {
    this.paint.next = pop
    if (this.paint.busy || this.paint.timer) return
    // 两次重画之间至少隔开上次耗时的两倍：大城的回放里主线程留出时间给动画
    const wait = Math.max(30, this.paint.cost * 2)
    this.paint.timer = window.setTimeout(() => {
      this.paint.timer = 0
      const p = this.paint.next
      if (!this.hist || p === this.paint.shown) return
      this.paint.busy = true
      const st = snapshot(this.hist, p)
      this.paintGround(p, st)
      this.paint.busy = false
      this.setLabels(st.labels)
      this.setPois(st)
      this.onSnapshot?.(st)
      if (this.paint.next !== this.paint.shown) this.requestPaint(this.paint.next)
    }, wait)
  }

  private paintGround(pop: number, st: Settlement) {
    this.paint.cost = this.ground.paint(st, this.style)
    this.paint.shown = pop
    this.invalidate()
  }

  /**
   * 表面高度场重新烘焙（镜头避障、缩放锚点、注记遮挡用）：换城后立即，人口变化后等成长过渡走完、
   * 时间轴停下一会儿再做（回放、拖动期间每帧都在变，沿用旧的）
   */
  private scheduleBake(delay: number) {
    clearTimeout(this.bakeTimer)
    this.bakeTimer = window.setTimeout(() => {
      this.bakeTimer = 0
      const hist = this.hist
      if (!hist || !this.ready) return
      if (this.u.uT.value < 1) return this.scheduleBake(200)
      const m = 8
      const hx = SX / 2
      const hz = this.SZ / 2
      const floor = this.diorama.tableY
      void this.field
        .bake(this.renderer, [this.city], {
          x0: -hx - m,
          z0: -hz - m,
          x1: hx + m,
          z1: hz + m,
          floor,
          top: (this.hRange[1] + 100) * this.K + 1,
          inner: { x0: -hx, z0: -hz, x1: hx, z1: hz, level: WATER_LEVEL * this.K },
          cell: 1.5 * this.K,
        })
        .then(() => {
          if (this.hist !== hist) return
          this.labels.anchor(this.field, this.K)
          this.focus.dirty = true
          this.invalidate(false)
        })
    }, delay)
  }

  /** 注记：片区名与大地标（随人口：那时还没有的不标） */
  setLabels(labels: MapLabel[]) {
    this.labels.set(labels, (x, z) => ({ x: x * this.K + this.city.position.x, y: Math.max(WATER_LEVEL, this.H(x, z)) * this.K, z: z * this.K + this.city.position.z }))
    this.labels.anchor(this.field, this.K)
    this.labels.setVisible(this.opts.labels)
    this.invalidate(false)
  }

  /** 铭牌（换语言时） */
  setTitle(title: { name: string; sub: string }) {
    if (!this.hist) return
    this.diorama.build({ SX, SZ: this.SZ, title: title.name, subtitle: title.sub })
    this.shadows.invalidate()
    this.invalidate()
  }

  // —— 选项 ——
  setOptions(o: Partial<Town3DOptions>) {
    const prev = this.opts
    this.opts = { ...this.opts, ...o }
    if (o.quality !== undefined && o.quality !== prev.quality) this.applyQuality()
    if (o.look) {
      this.post.setLook(this.opts.look)
      this.invalidate(false)
    }
    if (o.labels !== undefined) this.labels.setVisible(this.opts.labels)
    if (o.shadowSoftness !== undefined) this.applyShadowSoft()
    if (o.stage !== undefined) this.diorama.stage.visible = this.opts.stage
    if (o.dof !== undefined) this.focus.dirty = true
    if (o.timeOfDay !== undefined || o.sunAzimuth !== undefined || o.sunElevation !== undefined || o.haze !== undefined) this.applyDaylight()
    this.invalidate(!o.look)
  }

  private get quality() {
    return QUALITIES.find((x) => x.id === this.opts.quality)!.q
  }

  private applyQuality() {
    const q = this.quality
    const cap = this.renderer.capabilities
    this.renderer.setPixelRatio(Math.min(q.pixelRatio, window.devicePixelRatio))
    this.post.setQuality(q, cap.maxSamples)
    this.shadows.setSize(Math.min(q.shadowMap, cap.maxTextureSize))
    this.applyShadowSoft()
    this.resize()
  }

  /** 阴影软硬：半影宽度按实地尺寸（滑杆每一档约 0.1 米；月光更柔） */
  private applyShadowSoft() {
    this.shadows.setPenumbra(this.opts.shadowSoftness * this.dl.shadowSoft * 0.1 * this.K)
    this.post.reset()
  }

  /** 按时刻铺开光照：主光（日 / 月）、天光与地面反弹、展厅背景、霾、曝光、窗灯 */
  private applyDaylight() {
    const dl = daylight(this.opts.timeOfDay, this.opts.sunAzimuth, this.opts.sunElevation)
    this.dl = dl
    const sun = this.shadows.sun
    sun.color.copy(dl.keyColor)
    sun.intensity = dl.keyIntensity
    this.shadows.setDirection(dl.keyDir)
    // 天光：半球光的"地面"一侧补上被主光照亮的地面的反弹（屋檐底下、墙的暗面主要靠它照亮，带地面的暖色）
    const up = Math.max(0, dl.keyDir.y)
    const bounce = this.tmpColor.copy(dl.keyColor).multiply(GROUND_BOUNCE).multiplyScalar((dl.keyIntensity * up * 0.55) / Math.max(dl.hemiIntensity, 1e-3))
    this.hemi.color.copy(dl.hemiSky)
    this.hemi.groundColor.copy(dl.hemiGround).add(bounce)
    this.hemi.intensity = dl.hemiIntensity
    // 环境光的水平梯度：朝主光方位的一侧多一点暖光，背面少一点（变冷、变暗）
    const hz = Math.hypot(dl.keyDir.x, dl.keyDir.z) || 1
    const amp = dl.keyIntensity * 0.045 * (0.4 + 0.6 * up)
    const sh = this.fill.sh.coefficients
    for (const c of sh) c.set(0, 0, 0)
    // 一阶球谐的三个系数依次对应法线的 y、z、x（见 three.js 的 shGetIrradianceAt），系数 1.0233 倍即辐照度
    sh[2].set(dl.keyColor.r, dl.keyColor.g * 0.86, dl.keyColor.b * 0.62).multiplyScalar((amp * dl.keyDir.z) / hz / 1.023328)
    sh[3].set(dl.keyColor.r, dl.keyColor.g * 0.86, dl.keyColor.b * 0.62).multiplyScalar((amp * dl.keyDir.x) / hz / 1.023328)
    this.diorama.setLight(dl.light, new THREE.Color().copy(dl.keyColor).multiplyScalar(dl.moonKey ? 0.25 * dl.moonUp : dl.sunFade))
    this.diorama.setSky(dl.night, dl.stars, dl.moonDir, dl.moonUp, dl.twilight)
    // 展厅背景墙：亮带取天色（去掉大半饱和度、压暗），顶上是暗灰（夜里是深藏青的星空）；日出日落时太阳方位上一团暖光
    const hc = new THREE.Color().copy(dl.skyHorizon)
    const l = 0.2126 * hc.r + 0.7152 * hc.g + 0.0722 * hc.b
    hc.lerp(this.tmpColor.setRGB(l, l, l), 0.6).multiplyScalar(0.26)
    hc.r = Math.max(hc.r, 0.0032)
    hc.g = Math.max(hc.g, 0.0042)
    hc.b = Math.max(hc.b, 0.0095)
    const top = new THREE.Color().setRGB(0.011, 0.011, 0.0125).lerp(this.tmpColor.setRGB(0.0016, 0.0024, 0.0065), dl.night)
    const glow = new THREE.Color().copy(dl.keyColor).multiplyScalar(dl.moonKey ? 0 : dl.sunFade * (1 - Math.min(1, Math.max(0, dl.sunEl / 20))) * 0.22)
    this.diorama.setCove(hc, top, COVE_FALL, dl.sunDir, glow)
    const c = this.post.comp.uniforms
    c.uSun.value.copy(dl.keyDir)
    c.uSunColor.value.copy(dl.hazeSun)
    c.uHaze.value.copy(dl.skyHorizon).multiplyScalar(0.9)
    // 霾按沙盘单位，与世界沙盘一致；低空薄雾贴着地面，比世界沙盘薄（聚落尺度上不该有大片雾）
    c.uFogHeight.value = 0.2
    c.uHazeDensity.value = this.opts.haze ? 0.0022 : 0
    c.uFogDensity.value = this.opts.haze ? 0.02 : 0
    this.post.setExposureComp(dl.exposure, dl.night)
    this.u.uNight.value = dl.cityLights
    if (this.lights) this.lights.visible = dl.cityLights > 0
    this.applyShadowSoft()
    this.shadows.invalidate()
  }

  // —— 帧循环 ——
  private loop = (now: number) => {
    this.raf = 0
    if (!this.active || !this.ready) return
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0
    this.lastFrame = now
    let busy: boolean
    if (this.tour.active) {
      // 运镜接管镜头；约束照常（视点落地、近平面、不进建筑）
      this.tour.update(dt, this.camera, this.rig.target)
      this.rig.constrain(dt)
      this.tourFade.style.opacity = String(this.tour.fade)
      busy = true
    } else busy = this.rig.update(Math.min(dt, 0.05))
    // 成长过渡
    if (this.u.uT.value < 1) {
      const k = Math.min(1, (performance.now() - this.riseAt) / 1000 / this.riseDur)
      this.u.uT.value = k * k * (3 - 2 * k)
      this.shadows.invalidate()
      this.post.reset()
      this.focus.dirty = true
      busy = true
      // 过渡走完后表面高度场要重新烘焙（等时间轴停稳）
      if (k >= 1) this.scheduleBake(400)
    }
    const moved = this.post.cameraChanged(this.camera)
    if (moved) {
      this.lastMove = performance.now()
      this.focus.dirty = true
      // 停稳后再醒一次，栅格化地面高清块
      clearTimeout(this.detailTimer)
      this.detailTimer = window.setTimeout(() => this.invalidate(false), DETAIL_IDLE + 50)
    }
    this.shadows.fit(this.rig.target, this.rig.distance)
    // 停稳后才栅格化视点附近的地面高清块
    if (!moved && !busy && !this.held && performance.now() - this.lastMove > DETAIL_IDLE) this.updateDetail()
    const focusing = this.renderFrame(moved, dt)
    this.labels.update(this.camera, this.rig.distance, this.field, this.K)
    if (this.perf) this.perfTick()
    // 累积收敛后停下（静止时不占用 GPU）
    const settling = this.post.samples < this.quality.accumulate
    // 这一帧里可能已经有人 invalidate 过（测距回来、高清块）：只排一个，否则每帧多一条循环，越积越多
    if (busy || moved || settling || focusing || this.rig.moving) {
      if (!this.raf) this.raf = requestAnimationFrame(this.loop)
    } else if (!this.raf) this.lastFrame = 0
  }

  /** 测距的位置（画面坐标 0~1，原点在左下）：指针所指，没有指针时为画面中心 */
  private focusUv(): [number, number] {
    if (!this.pointer) return [0.5, 0.5]
    const r = this.renderer.domElement.getBoundingClientRect()
    return [Math.min(1, Math.max(0, (this.pointer.x - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (this.pointer.y - r.top) / r.height))]
  }

  /** 这一刻该对在多远：测距读数；那里没有表面（背景）或还没有读数时取轨道中心 */
  private focusWant() {
    const v = this.probe?.value ?? 0
    return Math.max(this.camera.near * 2, v > 0 ? v : this.rig.distance)
  }

  /**
   * 渲染一帧。对焦距离向测距读数缓动（按屈光度，远近变化的观感均匀），返回对焦是否还没到位（需要下一帧）。
   * still：导出时用，不缓动也不再测距
   */
  private renderFrame(moved: boolean, dt: number, still = false): boolean {
    const cam = this.camera
    const f = this.focus
    const dof = this.opts.dof > 0
    const want = this.focusWant()
    if (!still) {
      if (!this.probe) f.dirty = false
      if (f.snap || !(f.dist > 0)) {
        // 直接到位：等这次测距的读数回来为止
        f.dist = want
        if (!f.dirty && !this.probe?.pending) f.snap = false
      } else {
        const k = 1 - Math.exp(-Math.max(dt, 1 / 120) / FOCUS_TAU)
        f.dist = 1 / (1 / f.dist + (1 / want - 1 / f.dist) * k)
        if (Math.abs(f.dist - want) < want * 0.0015) f.dist = want
      }
    }
    // 光圈：远看时随对焦距离收小（整城的移轴微缩感，弥散圆不至于铺满画面）；
    // 贴近到百米以内再收一些——眼前就是主体，前后景的虚化要克制
    const meters = f.dist / this.K
    const aperture = this.opts.dof * 22 * Math.min(1.8, Math.sqrt(60 / f.dist)) * (0.5 + 0.5 * Math.min(1, meters / 160))
    const scale = moved ? this.motionScale : 1
    this.lastScale = moved ? scale : 0
    this.trees?.update(cam)
    this.shadows.setFrame(moved ? 0 : this.post.samples)
    if (this.shadows.flush(this.renderer)) this.post.reset()
    this.timer.frameStart()
    this.timer.tag = this.lastScale
    this.post.render(this.renderer, this.scene, cam, f.dist, aperture, null, this.timer, scale)
    this.timer.frameEnd()
    if (still) return false
    // 场景深度是这一帧的：指针、镜头、内容变了就再测一次，结果异步回来时唤醒循环
    if (dof && this.probe && f.dirty) {
      const [u, v] = this.focusUv()
      if (this.probe.request(this.renderer, cam, u, v, this.post.sub, 0.022, () => this.invalidate(false))) f.dirty = false
    }
    // 读数还没回来、或还没缓动到位：继续出帧
    return dof && (f.dirty || f.snap || f.dist !== want || !!this.probe?.pending)
  }

  /** 按一帧移动中的实测耗时调节缩放（同世界沙盘，目标 60 fps） */
  private adaptScale(ms: number, scale: number) {
    const want = scale * Math.sqrt((1000 / 60) * 0.88 / Math.max(ms, 0.1))
    const k = want < this.motionScale ? 0.5 : 0.15
    this.motionScale = Math.min(1, Math.max(this.quality.minScale, this.motionScale + (want - this.motionScale) * k))
  }

  /** 地面高清块跟着视点（镜头停稳后）：一次画一级，还有没画的再醒一帧接着画 */
  private updateDetail() {
    if (!this.hist) return
    const t = this.rig.target
    const dist = this.rig.distance / this.K
    const r = this.ground.focus((t.x - this.city.position.x) / this.K, (t.z - this.city.position.z) / this.K, dist)
    if (r.changed) this.post.reset()
    if (r.pending) this.invalidate(false)
  }

  // —— 自动运镜 ——
  /** 运镜的题材：这一刻的地标（城堡、寺观、市场、港口、城门），换算到世界坐标 */
  private setPois(st: Settlement) {
    const KIND: Record<string, [string, number]> = { castle: ['capital', 2.4], temple: ['city', 2], market: ['city', 1.8], harbor: ['coast', 1.6], magic: ['city', 1.4], gate: ['peak', 0.9] }
    const out: TourPoi[] = []
    for (const l of st.landmarks) {
      const k = KIND[l.kind]
      if (!k) continue
      out.push({ x: l.p[0] * this.K + this.city.position.x, z: l.p[1] * this.K + this.city.position.z, kind: k[0], weight: k[1] * (l.major ? 1.6 : 1) })
    }
    this.pois = out.length ? out : [{ x: 0, z: 0, kind: 'city', weight: 1 }]
  }

  startTour() {
    if (!this.hist || !this.ready || this.tour.active) return
    this.pointer = null
    this.focus.dirty = true
    this.tour.start(this.camera, this.rig.target)
    this.onTourChange?.(true)
    this.invalidate(false)
  }

  stopTour() {
    if (!this.tour.active) return
    this.tour.stop()
    this.tourFade.style.opacity = '0'
    this.onTourChange?.(false)
    this.invalidate(false)
  }

  toggleTour() {
    if (this.tour.active) this.stopTour()
    else this.startTour()
  }

  // —— 拾取 ——
  /**
   * 屏幕坐标 → 聚落米坐标：先找视线最先碰到的、此刻存在的建筑，再沿视线在地形上步进求交，取近的那个。
   * building 为 st.buildings（成长史）中的下标
   */
  pick(clientX: number, clientY: number): { q: P; building: number } | null {
    if (!this.hist) return null
    const r = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.camera)
    const g = this.groundHit(this.ray.ray)
    let best = g ? { d: g.d, q: [g.x, g.z] as P, building: -1 } : null
    const pop = this.u.uPop.value
    for (const hit of this.ray.intersectObjects(this.chunks, false)) {
      if (best && hit.distance >= best.d) break
      const m = hit.object as THREE.Mesh
      const i = hit.faceIndex ?? -1
      const life = m.userData.life as Float32Array
      const born = life[i * 9]
      const died = life[i * 9 + 1]
      if (pop < born || pop >= died) continue
      const p = this.city.worldToLocal(hit.point.clone())
      best = { d: hit.distance, q: [p.x, p.z], building: (m.userData.ids as Int32Array)[i] }
      break
    }
    return best && { q: best.q, building: best.building }
  }

  /** 视线与地形（米坐标的高度场）求交：粗步进 + 二分 */
  private groundHit(ray: THREE.Ray): { x: number; z: number; d: number } | null {
    if (!this.hist) return null
    const inv = this.city.matrixWorld.clone().invert()
    const o = ray.origin.clone().applyMatrix4(inv)
    const d = ray.direction.clone().transformDirection(inv)
    if (d.y >= 0) return null
    const W = this.hist.st.width
    const D = this.hist.st.height
    const top = this.hRange[1] + 2
    let t = Math.max(0, (top - o.y) / d.y)
    const step = this.hist.st.terrain.cell * 0.8
    const h = (t: number) => {
      const x = o.x + d.x * t
      const z = o.z + d.z * t
      return o.y + d.y * t - Math.max(WATER_LEVEL, this.H(x, z))
    }
    for (let k = 0; k < 6000; k++) {
      const x = o.x + d.x * t
      const z = o.z + d.z * t
      const y = o.y + d.y * t
      if (y < this.hRange[0] - 2) return null
      if (x >= 0 && z >= 0 && x <= W && z <= D && h(t) <= 0) {
        let a = Math.max(0, t - step)
        let b = t
        for (let i = 0; i < 10; i++) {
          const m = (a + b) / 2
          if (h(m) > 0) a = m
          else b = m
        }
        const p = new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b)
        return { x: p.x, z: p.z, d: p.applyMatrix4(this.city.matrixWorld).distanceTo(ray.origin) }
      }
      t += step
    }
    return null
  }

  // —— 其他 ——
  private togglePerf() {
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
    this.invalidate(false)
  }

  private perfTick() {
    const pf = this.perf!
    pf.frames++
    const now = performance.now()
    if (now - pf.t0 < 500) return
    const c = this.renderer.domElement
    const tm = this.timer
    const info = this.renderer.info.render
    const rows = [...tm.ms].filter(([, v]) => v >= 0.05).map(([k, v]) => `${k.padEnd(8, '　')} ${v.toFixed(2).padStart(6)} ms`)
    pf.el.textContent = [
      `${((pf.frames * 1000) / (now - pf.t0)).toFixed(0)} fps · ${c.width}×${c.height} · 移动缩放 ${this.motionScale.toFixed(2)}`,
      `绘制 ${info.calls} 次 · ${(info.triangles / 1000).toFixed(0)}k 三角形 · 地面重画 ${this.paint.cost.toFixed(0)} ms`,
      ...(tm.supported ? [`GPU ${tm.total.toFixed(1)} ms`, ...rows] : ['GPU n/a']),
    ].join('\n')
    pf.frames = 0
    pf.t0 = now
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    // 隐藏时报 0×0：保留现有渲染目标
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    const pr = this.renderer.getPixelRatio()
    this.post.setSize(Math.round(w * pr), Math.round(h * pr))
    this.renderer.domElement.style.width = w + 'px'
    this.renderer.domElement.style.height = h + 'px'
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
    this.u.uMinNdc.value = 4 / Math.max(1, Math.round(h * pr))
    this.labels.invalidate()
    this.focus.dirty = true
    this.invalidate()
  }

  resetCamera() {
    this.stopTour()
    this.rig.reset()
    this.focus.snap = true
    this.invalidate()
  }

  /**
   * 摆好镜头：视点 (x, z) 为聚落米坐标（落在地表上），dist 为镜头到视点的距离（米），
   * azimuth 为方位角（度，0 为镜头在视点正南、向北看，90 为在正东），pitch 为俯角（度，90 为正俯视）。
   * 镜头的约束照常生效：给的机位在建筑里、贴着地面时，实际的机位会被抬高
   */
  setView(v: { x: number; z: number; dist: number; azimuth: number; pitch: number }) {
    this.stopTour()
    this.rig.setView({
      x: v.x * this.K + this.city.position.x,
      z: v.z * this.K + this.city.position.z,
      dist: v.dist * this.K,
      azimuth: (v.azimuth * Math.PI) / 180,
      pitch: (v.pitch * Math.PI) / 180,
    })
    this.focus.snap = true
    this.lastMove = 0
    this.invalidate()
  }

  /**
   * 实测移动中一帧的耗时（毫秒，含阴影重画与后期，每帧等 GPU 画完）：镜头绕视点小幅转动 frames 帧取平均。
   * 每帧强制重新拟合并重画近、中两级阴影（平移、缩放时的最坏情况）；all 时连全城一级也重画（成长过渡期间）。
   * 调试与性能对比用（scripts/town3d.ts）
   */
  measure(frames = 40, all = false): { ms: number; calls: number; triangles: number } {
    const gl = this.renderer.getContext()
    const t = this.rig.target
    const off = this.camera.position.clone().sub(t)
    const axis = new THREE.Vector3(0, 1, 0)
    let calls = 0
    let triangles = 0
    const px = new Uint8Array(4)
    const info = this.renderer.info
    // 一帧里有阴影、场景与后期的多次绘制：统计整帧的绘制次数与三角形数
    info.autoReset = false
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        this.camera.position.copy(off).applyAxisAngle(axis, Math.sin((i / n) * Math.PI * 2) * 0.05).add(t)
        this.camera.lookAt(t)
        this.camera.updateMatrixWorld()
        this.shadows.fit(t, off.length(), true)
        if (all) this.shadows.invalidate()
        info.reset()
        this.renderFrame(true, 1 / 60)
        calls = info.render.calls
        triangles = info.render.triangles
        // 读回一个像素：等 GPU 把这一帧画完（finish 在 ANGLE 上不阻塞）
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      }
    }
    run(6)
    const t0 = performance.now()
    run(frames)
    const ms = (performance.now() - t0) / frames
    info.autoReset = true
    this.camera.position.copy(off).add(t)
    this.camera.lookAt(t)
    this.invalidate()
    return { ms, calls, triangles }
  }

  /** 镜头与对焦的现状（米）：调试与截图脚本用 */
  stats() {
    const p = this.camera.position
    return {
      focus: this.focus.dist / this.K,
      probe: (this.probe?.value ?? 0) / this.K,
      orbit: this.rig.distance / this.K,
      height: (p.y - this.rig.target.y) / this.K,
      near: this.camera.near / this.K,
      field: this.field.ready,
    }
  }

  /** 导出：当前画面（等累积收敛后的那一帧）。对焦先同步测一次，不依赖帧循环已经跑到位 */
  snapshot(): string {
    const q = this.quality.accumulate
    if (this.probe && this.opts.dof > 0) {
      this.camera.updateMatrixWorld()
      this.post.cameraChanged(this.camera)
      this.renderFrame(false, 0, true)
      const [u, v] = this.focusUv()
      const d = this.probe.read(this.renderer, this.camera, u, v, this.post.sub, 0.022)
      this.focus.dist = Math.max(this.camera.near * 2, d > 0 ? d : this.rig.distance)
      this.focus.dirty = this.focus.snap = false
      this.post.reset()
    }
    for (let i = this.post.samples; i < q; i++) this.renderFrame(false, 0, true)
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.detailTimer)
    this.clearTown()
    for (const d of this.disposers) d()
    this.post.dispose()
    this.probe?.dispose()
    this.field.dispose()
    this.shadows.dispose()
    this.diorama.dispose()
    this.bldMat.dispose()
    this.bldDepth.dispose()
    this.env.dispose()
    this.ground.dispose()
    this.rig.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.labels.dispose()
    this.tourFade.remove()
  }
}
