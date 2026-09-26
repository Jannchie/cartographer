import type { DisplayList } from './displayList'

/**
 * 矢量纸图查看器（两级"瓦片"）：
 * - 底图：整张图预先栅格化一次（最长边 ≤ 4096 px），缩放倍率不超过它的精度时直接由 GPU 缩放
 * - 细节层：视口大小的画布，放大到超出底图精度时，停手后只重绘与视口相交的矢量指令
 * 拖动/缩放过程中两层都用 CSS 变换跟随，所以交互始终流畅；停下后细节层按矢量重绘，任意倍率清晰。
 */
export class AtlasViewer {
  private base = document.createElement('canvas')
  private detail = document.createElement('canvas')
  private list: DisplayList | null = null
  private baseScale = 1
  /** 细节层上次绘制时的视图 */
  private drawn: { k: number; x: number; y: number } | null = null
  private timer = 0
  view = { x: 0, y: 0, k: 1 }

  constructor(private host: HTMLElement) {
    for (const c of [this.base, this.detail]) {
      c.style.position = 'absolute'
      c.style.left = '0'
      c.style.top = '0'
      c.style.transformOrigin = '0 0'
      host.appendChild(c)
    }
    this.base.style.boxShadow = '0 18px 60px rgba(0, 0, 0, 0.45)'
    this.detail.style.pointerEvents = 'none'
    new ResizeObserver(() => this.scheduleDetail(0)).observe(host)
  }

  get size() {
    return this.list ? { width: this.list.width, height: this.list.height } : null
  }

  setList(list: DisplayList) {
    this.list = list
    this.baseScale = Math.min(3, 4096 / Math.max(list.width, list.height))
    this.base.width = Math.round(list.width * this.baseScale)
    this.base.height = Math.round(list.height * this.baseScale)
    const ctx = this.base.getContext('2d')!
    ctx.clearRect(0, 0, this.base.width, this.base.height)
    list.render(ctx, this.baseScale, 0, 0)
    this.base.style.width = list.width + 'px'
    this.base.style.height = list.height + 'px'
    this.drawn = null
    this.detail.style.visibility = 'hidden'
    this.apply()
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
      this.detail.style.visibility = 'hidden'
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
    this.list.render(ctx, k * dpr, x * dpr, y * dpr)
    this.drawn = { x, y, k }
    this.detail.style.transform = 'none'
    this.detail.style.visibility = 'visible'
  }
}
