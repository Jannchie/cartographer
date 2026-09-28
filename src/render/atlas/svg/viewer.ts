import type { DisplayList } from './displayList'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}
/** 图框内框离舞台四边的最小距离 */
export interface Inset {
  t: number
  r: number
  b: number
  l: number
}
/**
 * 图框模式：图廓（纸边、图框、标题、比例尺、指北针、图例）不随地图缩放，拖动缩放只动图框里的地图。
 * 图框内框 = 舞台可用区（去掉 inset）与地图当前屏幕范围的交集：放大时铺满舞台，缩小时贴着地图收拢，
 * 周围不留空白。make(w, h, box, k) 按舞台宽高、内框 box 与当前缩放倍率 k 画出整层图廓。
 */
/** 底图的投影（不在图框模式时） */
const SHADOW = '0 18px 60px rgba(0, 0, 0, 0.45)'

export type Chrome = (w: number, h: number, box: Box, k: number) => DisplayList

/**
 * 矢量纸图查看器（两级"瓦片"）：
 * - 底图：整张图预先栅格化一次（最长边 ≤ 4096 px），缩放倍率不超过它的精度时直接由 GPU 缩放
 * - 细节层：视口大小的画布，放大到超出底图精度时，停手后只重绘与视口相交的矢量指令
 * 拖动/缩放过程中两层都用 CSS 变换跟随，所以交互始终流畅；停下后细节层按矢量重绘，任意倍率清晰。
 */
export class AtlasViewer {
  private base = document.createElement('canvas')
  private detail = document.createElement('canvas')
  /** 地图层的容器：图框模式下按图框内框裁切 */
  private wrap = document.createElement('div')
  private chromeCanvas = document.createElement('canvas')
  private chrome: Chrome | null = null
  private inset: Inset = { t: 0, r: 0, b: 0, l: 0 }
  private chromeRaf = 0
  private list: DisplayList | null = null
  private baseScale = 1
  /** 细节层上次绘制时的视图 */
  private drawn: { k: number; x: number; y: number } | null = null
  private timer = 0
  view = { x: 0, y: 0, k: 1 }

  constructor(private host: HTMLElement) {
    this.wrap.style.position = 'absolute'
    this.wrap.style.inset = '0'
    host.appendChild(this.wrap)
    for (const c of [this.base, this.detail]) {
      c.style.position = 'absolute'
      c.style.left = '0'
      c.style.top = '0'
      c.style.transformOrigin = '0 0'
      this.wrap.appendChild(c)
    }
    this.base.style.boxShadow = SHADOW
    this.detail.style.pointerEvents = 'none'
    const cc = this.chromeCanvas
    cc.style.position = 'absolute'
    cc.style.left = '0'
    cc.style.top = '0'
    cc.style.pointerEvents = 'none'
    cc.style.display = 'none'
    host.appendChild(cc)
    new ResizeObserver(() => {
      this.drawChrome()
      this.scheduleDetail(0)
    }).observe(host)
  }

  /** 开关图框模式；backdrop 是图框里、地图范围以外的底色 */
  setChrome(make: Chrome | null, backdrop = 'transparent', inset: Inset = { t: 0, r: 0, b: 0, l: 0 }) {
    this.inset = inset
    // 进出图框模式时底图要重画（图框模式下底图不含图廓）
    const toggled = !!make !== !!this.chrome
    this.chrome = make
    this.wrap.style.background = make ? backdrop : ''
    this.base.style.boxShadow = make ? 'none' : SHADOW
    this.chromeCanvas.style.display = make ? 'block' : 'none'
    if (!make) this.wrap.style.clipPath = ''
    if (toggled) {
      this.rasterBase()
      this.drawn = null
      this.scheduleDetail(0)
    }
    this.drawChrome()
  }

  /** 图廓里的内容变了（悬停读数……）：下一帧重画图廓层 */
  refreshChrome() {
    if (this.chrome && !this.chromeRaf)
      this.chromeRaf = requestAnimationFrame(() => {
        this.chromeRaf = 0
        this.drawChrome()
      })
  }

  /** 图框内框最大能占的区域（舞台坐标；适配视图用）；不在图框模式时是整个舞台 */
  inner(): Box {
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (!this.chrome) return { x: 0, y: 0, w, h }
    const s = this.inset
    return { x: s.l, y: s.t, w: Math.max(40, w - s.l - s.r), h: Math.max(40, h - s.t - s.b) }
  }

  /** 当前的图框内框（舞台坐标；悬停探测只认框里的点）；不在图框模式时是整个舞台 */
  frame(): Box {
    return this.chrome ? this.frameBox() : this.inner()
  }

  /** 当前的图框内框：可用区与地图屏幕范围的交集（地图被拖出去、交集太小时用整个可用区） */
  private frameBox(): Box {
    const max = this.inner()
    const list = this.list
    if (!list) return max
    const { x, y, k } = this.view
    const x0 = Math.max(max.x, x + list.M * k)
    const y0 = Math.max(max.y, y + list.M * k)
    const x1 = Math.min(max.x + max.w, x + (list.M + list.MW) * k)
    const y1 = Math.min(max.y + max.h, y + (list.M + list.MH) * k)
    if (x1 - x0 < 120 || y1 - y0 < 120) return max
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  /** 图廓层：舞台大小的画布，按当前倍率现画（比例尺跟着缩放变） */
  private drawChrome() {
    if (!this.chrome) return
    const dpr = window.devicePixelRatio || 1
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (!w || !h) return
    const box = this.frameBox()
    const list = this.chrome(w, h, box, this.view.k)
    const cc = this.chromeCanvas
    // 重设宽高会重新分配整块画布：只在舞台尺寸变了时做，平时清空重画
    const cw = Math.round(w * dpr)
    const ch = Math.round(h * dpr)
    if (cc.width !== cw || cc.height !== ch) {
      cc.width = cw
      cc.height = ch
      cc.style.width = w + 'px'
      cc.style.height = h + 'px'
    }
    const ctx = cc.getContext('2d')!
    ctx.clearRect(0, 0, cc.width, cc.height)
    list.render(ctx, dpr, 0, 0)
    // 地图只露在图框内框里
    this.wrap.style.clipPath = `inset(${box.y}px ${w - box.x - box.w}px ${h - box.y - box.h}px ${box.x}px)`
  }

  get size() {
    return this.list ? { width: this.list.width, height: this.list.height } : null
  }

  setList(list: DisplayList) {
    // 列表建好后不再变：同一份列表（从缓存取回、切回 2D）不必把整张底图重新栅格化
    if (list === this.list) return
    this.list = list
    this.rasterBase()
    this.drawn = null
    this.detail.style.display = 'none'
    this.drawChrome()
    this.apply()
  }

  /** 底图：整张栅格化一次（图框模式下只画地图层，图廓另画） */
  private rasterBase() {
    const list = this.list
    if (!list) return
    this.baseScale = Math.min(3, 4096 / Math.max(list.width, list.height))
    this.base.width = Math.round(list.width * this.baseScale)
    this.base.height = Math.round(list.height * this.baseScale)
    const ctx = this.base.getContext('2d')!
    ctx.clearRect(0, 0, this.base.width, this.base.height)
    list.render(ctx, this.baseScale, 0, 0, this.chrome ? 'map' : undefined)
    this.base.style.width = list.width + 'px'
    this.base.style.height = list.height + 'px'
  }

  /** 按导出分辨率整张栅格化（PNG 导出用） */
  rasterize(scale: number): HTMLCanvasElement {
    const c = document.createElement('canvas')
    if (!this.list) return c
    c.width = Math.round(this.list.width * scale)
    c.height = Math.round(this.list.height * scale)
    this.list.render(c.getContext('2d')!, scale, 0, 0)
    return c
  }

  setView(x: number, y: number, k: number) {
    this.view = { x, y, k }
    this.apply()
  }

  private apply() {
    const { x, y, k } = this.view
    this.base.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    if (this.drawn) {
      // 细节层按绘制时的视图做相对变换，保持对齐
      const r = k / this.drawn.k
      this.detail.style.transform = `translate(${x - this.drawn.x * r}px, ${y - this.drawn.y * r}px) scale(${r})`
    }
    // 比例尺跟着倍率变、缩小时图框跟着地图收拢
    this.refreshChrome()
    this.scheduleDetail(160)
  }

  private scheduleDetail(delay: number) {
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.drawDetail(), delay)
  }

  private drawDetail() {
    if (!this.list) return
    const dpr = window.devicePixelRatio || 1
    const { x, y, k } = this.view
    // 底图精度足够时不需要细节层
    if (k * dpr <= this.baseScale * 1.05) {
      this.detail.style.display = 'none'
      this.drawn = null
      return
    }
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    this.detail.width = Math.round(w * dpr)
    this.detail.height = Math.round(h * dpr)
    this.detail.style.width = w + 'px'
    this.detail.style.height = h + 'px'
    const ctx = this.detail.getContext('2d')!
    ctx.clearRect(0, 0, this.detail.width, this.detail.height)
    this.list.render(ctx, k * dpr, x * dpr, y * dpr, this.chrome ? 'map' : undefined)
    this.drawn = { x, y, k }
    this.detail.style.transform = 'none'
    this.detail.style.display = 'block'
  }
}
