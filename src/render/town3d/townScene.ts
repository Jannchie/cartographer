import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { P } from '../../settlement/geom'
import { snapshot, type SettlementHistory } from '../../settlement/history'
import type { SettleStyleId } from '../../settlement/themes'
import type { MapLabel, Settlement } from '../../settlement/types'
import { lang } from '../../i18n'
import { isTypingTarget } from '../../ui/keys'
import { PostPipeline } from '../aerial/post'
import { GpuTimer } from '../aerial/gpuTimer'
import { QUALITIES, type Look, type QualityId } from '../aerial/looks'
import { Diorama } from '../aerial/diorama'
import { daylight, type Daylight } from '../aerial/daylight'
import { NOISE_GLSL } from '../aerial/glsl'
import { LIFE_GLSL, patchBuilding } from './buildingShader'
import { heightSampler, type TownBuild } from './massing'
import type { TownChunk } from './mesh'
import { GroundPainter, createGroundMaterial, createWaterMaterial, skirtGeometries, terrainGeometry, waterTexture } from './ground'
import { WATER_LEVEL } from './relief'
import type { TreeKind, TreeSet } from './vegetation'

/**
 * 聚落沙盘：成长史中出现过的全部体块与树一次建好（见 massing.ts，在 Worker 里构建），
 * 地面是二维渲染器的地面层贴图，外面是世界沙盘的胡桃木底座、昼夜光照与后期管线。
 *
 * 成长：每个顶点（树为每个实例）带生卒，着色器按人口 uPop 收起尚未建成或已拆除的体块；
 * 人口从 uPrev 变到 uPop 时，新建的从地基升起、拆除的沉下（uT 0 → 1），地面贴图按节流重画。
 *
 * 按需渲染：镜头移动、阻尼、按键导航、成长过渡与静止后的时间累积期间逐帧渲染，
 * 累积收敛后停止请求动画帧，静止时不占用 GPU。
 * 坐标：聚落米坐标（x 东、z 南）整体缩放到 100 单位宽、居中，世界沙盘按这个尺度调好的常数（底座、霾、阴影）直接可用。
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

type Uniforms = Record<string, THREE.IUniform>

/** 树：实例属性 aTree (x, 地面高, z, 冠径)、aTreeLife；uShape (横向, 竖向, 抬高) 按冠径缩放，颜色按位置哈希 */
function patchTree(mat: THREE.Material, u: Uniforms, shape: THREE.Vector3, tint: THREE.Color, depth: boolean) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, { uShape: { value: shape }, uTint: { value: tint } })
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${LIFE_GLSL}\n${NOISE_GLSL}\nattribute vec4 aTree;\nattribute vec2 aTreeLife;\nuniform vec3 uShape;\nuniform vec3 uTint;\nvarying vec3 vTint;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float lk = lifeK(aTreeLife);
        float h = hash12(aTree.xz);
        float r = aTree.w * lk * (0.9 + 0.2 * h);
        transformed = vec3(position.x * uShape.x, position.y * uShape.y + uShape.z, position.z * uShape.x) * r + aTree.xyz;
        if (lk <= 0.0) transformed = vec3(0.0);
        vTint = uTint * (0.75 + 0.5 * hash12(aTree.zx + 3.7));`,
      )
    if (depth) return
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vTint;')
  }
  mat.customProgramCacheKey = () => `town-tree-${depth ? 'd' : 'c'}`
}

/** 各树形的树冠几何与比例（冠径为 1 时）：横向半径、竖向半径、中心离地 */
const TREE_SHAPE: Record<TreeKind, { geo: () => THREE.BufferGeometry; shape: [number, number, number]; tint: string }> = {
  broadleaf: { geo: () => new THREE.IcosahedronGeometry(1, 0), shape: [0.85, 0.8, 0.85], tint: '#4d6b24' },
  conifer: { geo: () => new THREE.ConeGeometry(1, 1, 7, 1, true), shape: [0.7, 2.4, 1.2], tint: '#2f4d26' },
  columnar: { geo: () => new THREE.OctahedronGeometry(1, 0), shape: [0.42, 1.25, 1.25], tint: '#35522a' },
}

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
  private controls: OrbitControls
  private sun = new THREE.DirectionalLight(0xfff1dc, 3.1)
  private hemi = new THREE.HemisphereLight(0xc4d7ea, 0x5b4a3a, 0.9)
  private post = new PostPipeline()
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
  private chunks: THREE.Mesh[] = []
  private groundU: ReturnType<typeof createGroundMaterial>['uniforms'] | null = null
  private painter: GroundPainter
  private groundTex: THREE.CanvasTexture
  private detailTex: THREE.CanvasTexture
  private style: SettleStyleId = 'color'
  /** 高清块：米坐标的中心与边长；dirty 时（地面重画后）需要重新栅格化 */
  private detail = { x: 0, z: 0, size: 0, dirty: false }
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
  private labelLayer: HTMLDivElement
  private labelEls: { el: HTMLDivElement; pos: THREE.Vector3; w: number; h: number; weight: number }[] = []
  private labelsDirty = true
  private perf: { el: HTMLDivElement; frames: number; t0: number } | null = null
  private navHeld = new Set<string>()
  private navFast = false
  private lastFrame = 0
  private lastMove = 0
  private detailTimer = 0
  private motionScale = 1
  private lastScale = 0
  /** 阴影相机的覆盖范围（沙盘单位）：随镜头收缩，近景时阴影更细 */
  private shadowBox = { x: 0, z: 0, r: 0 }
  private pointer: { x: number; y: number; dirty: boolean } | null = null
  private focusPoint: THREE.Vector3 | null = null
  private focusDist = 0
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private tmp = new THREE.Vector3()
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
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.maxDistance = 240
    this.controls.screenSpacePanning = false
    this.controls.zoomToCursor = true

    this.sun.castShadow = true
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 400
    this.scene.add(this.sun, this.sun.target, this.hemi, this.city)
    this.diorama = new Diorama(this.renderer)
    this.scene.add(this.diorama.group)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()

    const maxTex = this.renderer.capabilities.maxTextureSize
    this.painter = new GroundPainter(maxTex)
    this.groundTex = new THREE.CanvasTexture(this.painter.base)
    this.groundTex.colorSpace = THREE.SRGBColorSpace
    this.groundTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    this.detailTex = new THREE.CanvasTexture(this.painter.detail)
    this.detailTex.colorSpace = THREE.SRGBColorSpace
    this.detailTex.anisotropy = this.groundTex.anisotropy
    this.detailTex.generateMipmaps = false
    this.detailTex.minFilter = THREE.LinearFilter

    this.bldMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 })
    patchBuilding(this.bldMat, this.u, false)
    this.bldDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    patchBuilding(this.bldDepth, this.u, true)

    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'labels3d'
    container.appendChild(this.labelLayer)

    new ResizeObserver(() => this.resize()).observe(container)
    this.applyQuality()
    this.post.setLook(this.opts.look)
    this.applyDaylight()

    const el = this.renderer.domElement
    const kick = () => this.invalidate(false)
    this.controls.addEventListener('change', kick)
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
    el.addEventListener('wheel', kick, { passive: true })
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return
      this.pointer = { x: e.clientX, y: e.clientY, dirty: true }
      kick()
    })
    el.addEventListener('pointerleave', () => {
      this.pointer = null
      this.focusPoint = null
      kick()
    })
    // 动态分辨率：移动中的帧按实测 GPU 耗时调节缩放
    this.timer.onFrame = (ms, scale) => {
      if (scale > 0) this.adaptScale(ms, scale)
    }
    const onKey = (e: KeyboardEvent) => {
      this.navFast = e.shiftKey
      if (!this.active || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e)) return
      if (e.key === 'p' || e.key === 'P') return this.togglePerf()
      const k = navKey(e)
      if (!k) return
      e.preventDefault()
      this.navHeld.add(k)
      kick()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      this.navFast = e.shiftKey
      const k = navKey(e)
      if (k) this.navHeld.delete(k)
    }
    const onBlur = () => this.navHeld.clear()
    // 页面卸下（刷新、离开）时主动交还 WebGL 上下文，免得浏览器累积到上限后丢失别的上下文；从往返缓存回来时恢复
    const onHide = () => this.renderer.forceContextLoss()
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return
      this.renderer.forceContextRestore()
      this.renderer.shadowMap.needsUpdate = true
      this.invalidate()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pagehide', onHide)
    window.addEventListener('pageshow', onShow)
    this.disposers.push(() => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('pageshow', onShow)
    })
  }

  /** 舞台可见（聚落模块的沙盘模式）时才渲染 */
  setActive(on: boolean) {
    if (this.active === on) return
    this.active = on
    if (on) this.invalidate()
    else this.navHeld.clear()
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
    for (const t of build.trees) if (t.count) this.city.add(this.treeMesh(t))

    // 地面与水
    const gm = createGroundMaterial(this.groundTex, this.detailTex)
    const ground = new THREE.Mesh(terrainGeometry(build.terrain), gm.mat)
    ground.receiveShadow = true
    ground.castShadow = true
    this.groundU = gm.uniforms
    this.city.add(ground)
    const field = waterTexture(hist.st, build.terrain)
    const wm = createWaterMaterial(field, this.env, { w: W, h: D })
    const water = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2).translate(W / 2, WATER_LEVEL, D / 2), wm.mat)
    water.receiveShadow = true
    water.renderOrder = 2
    water.userData.field = field
    this.city.add(water)

    // 剖面与底座：岩层底在最低地表之下约 3 单位
    const base = Math.min(lo * this.K, -0.3) - 3
    const sk = skirtGeometries(hist.st, this.H, this.K, base)
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
    // 镜头：最近到单栋房子（约 12 米）
    this.controls.minDistance = Math.max(0.12, 12 * this.K)

    this.shadowBox.r = 0
    this.renderer.shadowMap.needsUpdate = true
    // 着色器在后台并行编译（KHR_parallel_shader_compile），首帧不因同步编译卡住主线程
    this.ready = false
    await this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined)
    if (this.hist !== hist) return
    this.ready = true
    this.paintGround(pop, st)
    this.setLabels(st.labels)
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

  private treeMesh(t: TreeSet) {
    const s = TREE_SHAPE[t.kind]
    // 只留位置并合并共用顶点：平面着色的法线在片元里由导数求出，顶点着色器的调用数降到约五分之一
    const raw = s.geo()
    raw.deleteAttribute('normal')
    raw.deleteAttribute('uv')
    const src = mergeVertices(raw)
    raw.dispose()
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', src.getAttribute('position'))
    g.setIndex(src.index)
    const ib = new THREE.InstancedInterleavedBuffer(t.data, 6)
    g.setAttribute('aTree', new THREE.InterleavedBufferAttribute(ib, 4, 0))
    g.setAttribute('aTreeLife', new THREE.InterleavedBufferAttribute(ib, 2, 4))
    g.instanceCount = t.count
    const shape = new THREE.Vector3(...s.shape)
    const tint = new THREE.Color(s.tint)
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, flatShading: true })
    patchTree(mat, this.u, shape, tint, false)
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    patchTree(depth, this.u, shape, tint, true)
    const m = new THREE.Mesh(g, mat)
    m.customDepthMaterial = depth
    m.castShadow = m.receiveShadow = true
    // 位置在着色器里由实例属性给出：包围球按不到，不做视锥裁剪
    m.frustumCulled = false
    m.userData.depth = depth
    return m
  }

  private clearTown() {
    for (const c of [...this.city.children]) {
      this.city.remove(c)
      if (c.userData.field) (c.userData.field as THREE.Texture).dispose()
      if (c.userData.depth) (c.userData.depth as THREE.Material).dispose()
      const m = c as THREE.Mesh
      if (c.userData.shared) m.geometry.dispose()
      else if (m.material === this.bldMat) m.geometry.dispose()
      else deep(c)
    }
    this.chunks = []
    this.groundU = null
    this.hist = null
    clearTimeout(this.paint.timer)
    this.paint = { busy: false, next: -1, shown: -1, cost: 0, timer: 0 }
    this.detail = { x: 0, z: 0, size: 0, dirty: false }
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
    this.renderer.shadowMap.needsUpdate = true
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
      this.onSnapshot?.(st)
      if (this.paint.next !== this.paint.shown) this.requestPaint(this.paint.next)
    }, wait)
  }

  private paintGround(pop: number, st: Settlement) {
    const t0 = performance.now()
    const r = this.painter.paintBase(st, this.style)
    if (r.resized) this.groundTex.dispose()
    this.groundTex.needsUpdate = true
    this.paint.shown = pop
    this.paint.cost = performance.now() - t0
    this.detail.dirty = true
    this.invalidate()
  }

  /** 注记：片区名与大地标（随人口：那时还没有的不标） */
  setLabels(labels: MapLabel[]) {
    this.labelLayer.innerHTML = ''
    this.labelEls = []
    const keep = labels.filter((l) => l.kind === 'district' || l.kind === 'landmark').sort((a, b) => b.weight - a.weight)
    for (const l of keep.slice(0, 80)) {
      const el = document.createElement('div')
      el.className = `l3 l3-${l.kind}`
      el.textContent = l.text[lang]
      const y = this.H(l.p[0], l.p[1]) + (l.kind === 'landmark' ? 18 : 6)
      const pos = new THREE.Vector3(l.p[0], y, l.p[1]).multiplyScalar(this.K).add(this.city.position)
      this.labelLayer.appendChild(el)
      this.labelEls.push({ el, pos, w: 0, h: 0, weight: l.weight })
    }
    for (const l of this.labelEls) {
      l.w = l.el.offsetWidth
      l.h = l.el.offsetHeight
    }
    this.labelLayer.style.display = this.opts.labels ? '' : 'none'
    this.labelsDirty = true
    this.invalidate(false)
  }

  /** 铭牌（换语言时） */
  setTitle(title: { name: string; sub: string }) {
    if (!this.hist) return
    this.diorama.build({ SX, SZ: this.SZ, title: title.name, subtitle: title.sub })
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
    if (o.labels !== undefined) {
      this.labelLayer.style.display = this.opts.labels ? '' : 'none'
      this.labelsDirty = true
    }
    if (o.shadowSoftness !== undefined) this.applyShadowSoft()
    if (o.stage !== undefined) this.diorama.stage.visible = this.opts.stage
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
    const size = Math.min(q.shadowMap, cap.maxTextureSize)
    const sh = this.sun.shadow
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size)
      sh.map?.dispose()
      sh.map = null
      this.shadowBox.r = 0
      this.renderer.shadowMap.needsUpdate = true
    }
    this.applyShadowSoft()
    this.resize()
  }

  /** 阴影软硬：PCF 半径以纹素计（按 4096 贴图归一，换画质时软硬不变） */
  private applyShadowSoft() {
    this.sun.shadow.radius = Math.max(1, (this.opts.shadowSoftness * this.dl.shadowSoft * this.sun.shadow.mapSize.x) / 4096)
    this.post.reset()
  }

  /** 按时刻铺开光照：主光（日 / 月）、天光、展厅背景、霾、曝光、窗灯 */
  private applyDaylight() {
    const dl = daylight(this.opts.timeOfDay, this.opts.sunAzimuth, this.opts.sunElevation)
    this.dl = dl
    this.sun.color.copy(dl.keyColor)
    this.sun.intensity = dl.keyIntensity
    this.hemi.color.copy(dl.hemiSky)
    this.hemi.groundColor.copy(dl.hemiGround)
    this.hemi.intensity = dl.hemiIntensity
    this.diorama.setLight(dl.light, new THREE.Color().copy(dl.keyColor).multiplyScalar(dl.moonKey ? 0.25 * dl.moonUp : dl.sunFade))
    this.diorama.setSky(dl.night, dl.stars, dl.moonDir, dl.moonUp, dl.twilight)
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
    this.applyShadowSoft()
    this.placeSun()
    this.renderer.shadowMap.needsUpdate = true
  }

  /** 主光与阴影相机：以阴影范围的中心为靶，覆盖半径 r */
  private placeSun() {
    const b = this.shadowBox
    const r = b.r || 70
    this.sun.target.position.set(b.x, 0, b.z)
    this.sun.position.copy(this.dl.keyDir).multiplyScalar(150).add(this.sun.target.position)
    const sc = this.sun.shadow.camera
    sc.left = sc.bottom = -r
    sc.right = sc.top = r
    sc.updateProjectionMatrix()
    // 法线偏移随纹素大小：近景细阴影不浮，远景不漏光
    const texel = (2 * r) / this.sun.shadow.mapSize.x
    this.sun.shadow.normalBias = texel * 1.2
    this.sun.shadow.bias = -0.00015
    this.sun.target.updateMatrixWorld()
  }

  /** 阴影范围随镜头：拉近时只覆盖视点附近（贴图纹素随之变细），整城可见时覆盖全城 */
  private fitShadow() {
    const t = this.controls.target
    const dist = this.camera.position.distanceTo(t)
    const full = Math.hypot(SX, this.SZ) / 2 + 2
    let r = Math.min(full, Math.max(2.5, dist * 1.4))
    let x = t.x
    let z = t.z
    if (r > full * 0.7) {
      r = full
      x = 0
      z = 0
    }
    const b = this.shadowBox
    if (b.r && Math.abs(Math.log(r / b.r)) < 0.25 && Math.hypot(x - b.x, z - b.z) < b.r * 0.25) return
    Object.assign(b, { x, z, r })
    this.placeSun()
    this.renderer.shadowMap.needsUpdate = true
    this.post.reset()
  }

  // —— 帧循环 ——
  private loop = (now: number) => {
    this.raf = 0
    if (!this.active || !this.ready) return
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0
    this.lastFrame = now
    let busy = this.keyNav(Math.min(dt, 0.05))
    if (this.controls.update()) busy = true
    // 成长过渡
    if (this.u.uT.value < 1) {
      const k = Math.min(1, (performance.now() - this.riseAt) / 1000 / this.riseDur)
      this.u.uT.value = k * k * (3 - 2 * k)
      this.renderer.shadowMap.needsUpdate = true
      this.post.reset()
      busy = true
    }
    const moved = this.post.cameraChanged(this.camera)
    if (moved) {
      this.lastMove = performance.now()
      // 停稳后再醒一次，栅格化地面高清块
      clearTimeout(this.detailTimer)
      this.detailTimer = window.setTimeout(() => this.invalidate(false), DETAIL_IDLE + 50)
    }
    this.fitShadow()
    this.updateNear()
    // 停稳后才栅格化视点附近的地面高清块
    if (!moved && !busy && !this.held && performance.now() - this.lastMove > DETAIL_IDLE) this.updateDetail()
    this.renderFrame(moved)
    this.updateLabels()
    if (this.perf) this.perfTick()
    // 累积收敛后停下（静止时不占用 GPU）
    const settling = this.post.samples < this.quality.accumulate
    const pendingFocus = !!this.pointer?.dirty
    // 这一帧里可能已经有人 invalidate 过（对焦收敛、高清块）：只排一个，否则每帧多一条循环，越积越多
    if (busy || moved || settling || pendingFocus || this.navHeld.size) {
      if (!this.raf) this.raf = requestAnimationFrame(this.loop)
    } else if (!this.raf) this.lastFrame = 0
  }

  /** 近平面随镜头距离：拉近到单栋房子时不被裁掉，远看时深度精度够用 */
  private updateNear() {
    const d = this.camera.position.distanceTo(this.controls.target)
    const near = Math.min(1, Math.max(0.004, d * 0.02))
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.1) {
      this.camera.near = near
      this.camera.updateProjectionMatrix()
    }
  }

  private renderFrame(moved: boolean) {
    const cam = this.camera
    if (this.pointer && moved) this.pointer.dirty = true
    if (this.pointer?.dirty && !moved) {
      this.focusPoint = this.pickPoint(this.pointer.x, this.pointer.y)
      this.pointer.dirty = false
    }
    const fp = this.focusPoint ?? this.controls.target
    const dir = cam.getWorldDirection(this.tmp.set(0, 0, 0)).clone()
    const want = Math.max(cam.near * 4, fp.clone().sub(cam.position).dot(dir))
    const prev = this.focusDist
    this.focusDist = prev > 0 && !moved ? prev + (want - prev) * 0.25 : want
    if (Math.abs(this.focusDist - want) > want * 0.002 && this.opts.dof > 0) this.invalidate(false)
    const aperture = this.opts.dof * 22 * Math.min(1.8, Math.sqrt(60 / this.focusDist))
    const scale = moved ? this.motionScale : 1
    this.lastScale = moved ? scale : 0
    this.timer.frameStart()
    this.timer.tag = this.lastScale
    this.post.render(this.renderer, this.scene, cam, this.focusDist, aperture, null, this.timer, scale)
    this.timer.frameEnd()
  }

  /** 按一帧移动中的实测耗时调节缩放（同世界沙盘，目标 60 fps） */
  private adaptScale(ms: number, scale: number) {
    const want = scale * Math.sqrt((1000 / 60) * 0.88 / Math.max(ms, 0.1))
    const k = want < this.motionScale ? 0.5 : 0.15
    this.motionScale = Math.min(1, Math.max(this.quality.minScale, this.motionScale + (want - this.motionScale) * k))
  }

  private navTmp = { offset: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(), move: new THREE.Vector3(), sph: new THREE.Spherical() }
  /** 键盘导航（同世界沙盘）：返回这一帧是否动了 */
  private keyNav(dt: number) {
    const held = this.navHeld
    if (!held.size || !dt) return held.size > 0
    const cam = this.camera
    const target = this.controls.target
    const { offset, fwd, right, move, sph } = this.navTmp
    offset.copy(cam.position).sub(target)
    const dist = offset.length()
    const fast = this.navFast ? 3 : 1
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
    return true
  }

  /**
   * 地面高清块：镜头离地近时，以视点为中心把地面层另栅格化一块（2048 见方），
   * 边长约为观察距离的 2.2 倍；移出一定范围、缩放明显或地面重画后重新栅格化
   */
  private updateDetail() {
    const u = this.groundU
    if (!u || !this.hist) return
    const W = this.hist.st.width
    const D = this.hist.st.height
    const dist = this.camera.position.distanceTo(this.controls.target) / this.K
    const size = Math.min(1400, Math.max(120, dist * 2.2))
    // 高清块比整幅贴图清楚不了多少时不用
    if (size > Math.max(W, D) * 0.45) {
      if (u.uDetailRect.value.z) {
        u.uDetailRect.value.set(0, 0, 0, 0)
        this.detail.size = 0
        this.invalidate()
      }
      return
    }
    // 中心取视点：绕视点转动时不必重画
    const t = this.controls.target
    const cx = (t.x - this.city.position.x) / this.K
    const cz = (t.z - this.city.position.z) / this.K
    const d = this.detail
    if (!d.dirty && d.size && Math.hypot(cx - d.x, cz - d.z) < d.size * 0.18 && Math.abs(Math.log(size / d.size)) < 0.3) return
    const x0 = cx - size / 2
    const z0 = cz - size / 2
    if (!this.painter.paintDetail(x0, z0, size)) return
    this.detailTex.needsUpdate = true
    u.uDetailRect.value.set(x0, z0, 1 / size, 1 / size)
    Object.assign(d, { x: cx, z: cz, size, dirty: false })
    this.post.reset()
  }

  // —— 注记 ——
  private labelView = new THREE.Matrix4()
  private labelBoxes: number[] = []
  private updateLabels() {
    if (!this.opts.labels || !this.labelEls.length) return
    const cam = this.camera
    if (!this.labelsDirty && this.labelView.equals(cam.matrixWorld)) return
    this.labelsDirty = false
    this.labelView.copy(cam.matrixWorld)
    const wpx = this.container.clientWidth
    const hpx = this.container.clientHeight
    const boxes = this.labelBoxes
    boxes.length = 0
    const dist = cam.position.distanceTo(this.controls.target)
    for (const l of this.labelEls) {
      this.tmp.copy(l.pos).project(cam)
      // 远看只标片区，拉近再标地标
      const vis = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.05 && Math.abs(this.tmp.y) < 1.05 && (l.el.classList.contains('l3-district') || dist < 45)
      if (!vis) {
        l.el.style.opacity = '0'
        continue
      }
      const x = (this.tmp.x * 0.5 + 0.5) * wpx
      const y = (-this.tmp.y * 0.5 + 0.5) * hpx
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
      l.el.style.opacity = '1'
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`
    }
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

  /** 对焦点：指针下的地面（世界坐标） */
  private pickPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const p = this.pick(clientX, clientY)
    if (!p) return null
    return new THREE.Vector3(p.q[0], this.H(p.q[0], p.q[1]), p.q[1]).applyMatrix4(this.city.matrixWorld)
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
    this.labelsDirty = true
    this.invalidate()
  }

  resetCamera() {
    this.camera.position.set(0, 58, 84)
    this.controls.target.set(0, 0, 0)
    this.controls.update()
    this.invalidate()
  }

  /** 导出：当前画面（等累积收敛后的那一帧） */
  snapshot(): string {
    const q = this.quality.accumulate
    for (let i = this.post.samples; i < q; i++) this.renderFrame(false)
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.detailTimer)
    this.clearTown()
    for (const d of this.disposers) d()
    this.post.dispose()
    this.diorama.dispose()
    this.bldMat.dispose()
    this.bldDepth.dispose()
    this.groundTex.dispose()
    this.detailTex.dispose()
    this.env.dispose()
    this.painter.dispose()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.labelLayer.remove()
  }
}
