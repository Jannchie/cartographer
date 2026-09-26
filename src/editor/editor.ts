import type { Label, World, WorldEdits } from '../gen/types'
import { cjkFont, lang, placeName, t } from '../i18n'
import { ELEV_RAMP, RAIN_RAMP, REGION_COLORS, TEMP_RAMP, floodLand, isolines, rampColor, type IsoGroup, type Ramp } from './layers'

/**
 * 世界编辑视图：专题底图 + 编辑增量 + 地点，支持
 *  - 地形画笔（抬升 / 下沉 / 抹平）：改的是侵蚀前的"地形意图"，松手后重新演算侵蚀、水系与气候；
 *  - 气候画笔（升温 / 降温 / 增雨 / 减雨）；
 *  - 大洲：点选陆块建立大洲，画笔加入 / 移出；
 *  - 地点：选中后改名、改类型、拖动、删除，或点击空白处新增。
 * 底图随画笔切换：地形 → 分层设色 + 等高线，气温 / 降水 → 热力图 + 等值线，大洲 → 区域着色。
 */

export type EditTool = 'select' | 'raise' | 'lower' | 'smooth' | 'warm' | 'cool' | 'wet' | 'dry' | 'place' | 'region' | 'regionAdd' | 'regionErase'
export type EditView = 'relief' | 'elevation' | 'temperature' | 'rain' | 'regions'

export interface EditorCallbacks {
  /** 一笔画完（或地点增删改完）：kind 决定需要重算到哪一步 */
  onCommit: (kind: 'terrain' | 'climate' | 'labels' | 'regions') => void
  /** 一笔开始前：用于撤销 */
  onBeforeEdit: () => void
  onSelect: (label: Label | null) => void
  onRegionSelect: (id: number) => void
}

/** 每种画笔默认对应的底图 */
const TOOL_VIEW: Record<EditTool, EditView> = {
  select: 'relief',
  place: 'relief',
  raise: 'elevation',
  lower: 'elevation',
  smooth: 'elevation',
  warm: 'temperature',
  cool: 'temperature',
  wet: 'rain',
  dry: 'rain',
  region: 'regions',
  regionAdd: 'regions',
  regionErase: 'regions',
}

/** 每种地点在编辑图上的样式 */
const KIND_STYLE: Record<Label['kind'], { font: string; color: string; dot?: number }> = {
  capital: { font: '600 13px', color: '#fff', dot: 4.5 },
  city: { font: '500 12px', color: '#f1ede4', dot: 3 },
  continent: { font: '600 17px', color: 'rgba(255,255,255,0.9)' },
  island: { font: 'italic 12px', color: 'rgba(255,255,255,0.85)' },
  ocean: { font: 'italic 15px', color: 'rgba(200,225,240,0.85)' },
  sea: { font: 'italic 13px', color: 'rgba(200,225,240,0.85)' },
  lake: { font: 'italic 11px', color: 'rgba(210,235,245,0.9)' },
  range: { font: 'italic 12px', color: 'rgba(250,235,215,0.9)' },
  basin: { font: 'italic 11px', color: 'rgba(250,235,215,0.8)' },
  desert: { font: 'italic 11px', color: 'rgba(250,235,215,0.8)' },
  forest: { font: 'italic 11px', color: 'rgba(225,245,215,0.85)' },
}

/** 图例：配色带与刻度 */
const LEGENDS: Partial<Record<EditView, { title: string; ramp: Ramp; ticks: [number, string][]; min: number; max: number }>> = {
  elevation: { title: '海拔', ramp: ELEV_RAMP, min: -4, max: 5, ticks: [[-4, '-4 km'], [0, '0'], [2, '2'], [5, '5 km']] },
  temperature: { title: '年均温', ramp: TEMP_RAMP, min: -30, max: 35, ticks: [[-30, '-30°'], [0, '0°'], [15, '15°'], [35, '35 °C']] },
  rain: { title: '年降水', ramp: RAIN_RAMP, min: 0, max: 4000, ticks: [[0, '0'], [1000, '1000'], [2000, '2000'], [4000, '4000 mm']] },
}

export class EditorView {
  readonly canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d')!
  private legend = document.createElement('div')
  private world: World | null = null
  private edits: WorldEdits = {}
  /** 生成当前世界时用的编辑（预览只叠加之后新画的部分） */
  private genEdits: WorldEdits = {}
  /** 底图：W×H 像素，放大绘制 */
  private base = document.createElement('canvas')
  private baseCtx = this.base.getContext('2d')!
  private color: ImageData | null = null
  /** 编辑增量 / 区域叠色 */
  private over = document.createElement('canvas')
  private overCtx = this.over.getContext('2d')!
  private iso: IsoGroup[] = []
  private isoTimer = 0
  private view = { x: 0, y: 0, k: 1 }
  private raf = 0
  private mouse = { x: -1, y: -1, inside: false }
  private drag: { mode: 'pan' | 'paint' | 'move'; x: number; y: number; vx: number; vy: number; label?: Label } | null = null
  private dirty = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 }
  tool: EditTool = 'select'
  /** 手动指定的底图；null 表示随画笔自动切换 */
  viewOverride: EditView | null = null
  brush = { radius: 18, strength: 0.5 }
  selected: Label | null = null
  selectedRegion = -1
  showNames = true

  constructor(
    private container: HTMLElement,
    private cb: EditorCallbacks,
  ) {
    container.appendChild(this.canvas)
    this.canvas.className = 'editor-canvas'
    this.legend.className = 'edit-legend'
    container.appendChild(this.legend)
    new ResizeObserver(() => this.resize()).observe(container)
    this.bind()
  }

  get viewMode(): EditView {
    return this.viewOverride ?? TOOL_VIEW[this.tool]
  }

  /**
   * 换世界或演算完成后调用；edits 是主线程持有的同一个对象（原地修改），
   * genEdits 是生成这个世界时发给 Worker 的那份。
   */
  setWorld(world: World, color: HTMLCanvasElement, edits: WorldEdits, genEdits: WorldEdits) {
    const first = !this.world || this.world.W !== world.W || this.world.H !== world.H
    const selIdx = this.selected && this.world ? this.world.labels.indexOf(this.selected) : -1
    this.world = world
    this.edits = edits
    this.genEdits = genEdits
    const { W, H } = world
    // 地表色缩到 W×H，与高度图一一对应，方便局部重算
    const tmp = document.createElement('canvas')
    tmp.width = W
    tmp.height = H
    const tc = tmp.getContext('2d')!
    tc.drawImage(color, 0, 0, W, H)
    this.color = tc.getImageData(0, 0, W, H)
    this.base.width = this.over.width = W
    this.base.height = this.over.height = H
    if (first) this.fit()
    // 地点被重新生成（固定后是同一份列表的副本），按下标找回选中项
    if (this.selected) {
      const l = selIdx >= 0 ? world.labels[selIdx] : undefined
      if (l && l.name === this.selected.name) this.selected = l
      else this.select(null)
    }
    this.full()
  }

  /** 编辑数据被外部替换（撤销、清除、打开项目、自动划分）后重画 */
  refreshEdits(edits: WorldEdits) {
    this.edits = edits
    this.full()
  }

  setTool(t: EditTool) {
    const before = this.viewMode
    this.tool = t
    if (this.viewMode !== before) this.full()
    else this.draw()
  }

  setView(v: EditView | null) {
    this.viewOverride = v
    this.full()
  }

  fit() {
    if (!this.world) return
    const cw = this.container.clientWidth
    const ch = this.container.clientHeight
    const k = Math.min((cw - 60) / this.world.W, (ch - 90) / this.world.H)
    this.view = { k, x: (cw - this.world.W * k) / 2, y: (ch - this.world.H * k) / 2 + 16 }
    this.draw()
  }

  select(l: Label | null) {
    this.selected = l
    this.cb.onSelect(l)
    this.draw()
  }

  selectRegion(id: number) {
    this.selectedRegion = id
    this.cb.onRegionSelect(id)
    this.full()
  }

  /** 屏幕坐标 → 格坐标 */
  toCell(sx: number, sy: number) {
    return { x: (sx - this.view.x) / this.view.k, y: (sy - this.view.y) / this.view.k }
  }

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio)
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'
    this.draw()
  }

  /** 整幅重算底图、叠色、等值线与图例 */
  private full() {
    if (!this.world) return
    this.markDirty(0, 0, this.world.W - 1, this.world.H - 1)
    this.refresh()
    this.updateLegend()
    this.draw()
  }

  private markDirty(x0: number, y0: number, x1: number, y1: number) {
    const d = this.dirty
    d.x0 = Math.min(d.x0, x0)
    d.y0 = Math.min(d.y0, y0)
    d.x1 = Math.max(d.x1, x1)
    d.y1 = Math.max(d.y1, y1)
  }

  /** 当前高度 = 世界高度 + 上次演算之后新增的地形编辑 */
  private liveElevation(): Float32Array {
    const w = this.world!
    const t = this.edits.terrain
    const g = this.genEdits.terrain
    if (!t) return w.elevation
    const out = new Float32Array(w.elevation)
    for (let i = 0; i < out.length; i++) out[i] += t[i] - (g ? g[i] : 0)
    return out
  }

  private liveField(kind: 'temp' | 'rain'): Float32Array {
    const w = this.world!
    const base = kind === 'temp' ? w.temperature : w.precipitation
    const a = this.edits[kind]
    const g = this.genEdits[kind]
    if (!a) return base
    const out = new Float32Array(base)
    for (let i = 0; i < out.length; i++) {
      const d = a[i] - (g ? g[i] : 0)
      out[i] = kind === 'temp' ? out[i] + d : out[i] * Math.exp(d)
    }
    return out
  }

  /** 重算脏矩形里的底图与叠色 */
  private refresh() {
    const w = this.world
    const c = this.color
    const d = this.dirty
    if (!w || !c || d.x1 < d.x0) return
    const { W, H, elevation: e0 } = w
    const mode = this.viewMode
    const x0 = Math.max(0, d.x0 - 1)
    const y0 = Math.max(0, d.y0 - 1)
    const x1 = Math.min(W - 1, d.x1 + 1)
    const y1 = Math.min(H - 1, d.y1 + 1)
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const img = this.baseCtx.createImageData(bw, bh)
    const ov = this.overCtx.createImageData(bw, bh)
    const t = this.edits.terrain
    const gt = this.genEdits.terrain
    const hAt = (x: number, y: number) => {
      const i = Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))
      return e0[i] + (t ? t[i] - (gt ? gt[i] : 0) : 0)
    }
    const tp = this.edits.temp
    const gtp = this.genEdits.temp
    const rn = this.edits.rain
    const grn = this.genEdits.rain
    const regions = this.edits.regions
    const k = 22 / w.kmPerCell
    const rgb = [0, 0, 0]
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x
        const h = hAt(x, y)
        const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * k
        const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * k
        // 西北光照的山体阴影
        const sh = h > 0 ? Math.max(0.35, Math.min(1.35, 1 + (-dx * 0.7 - dy * 0.7) / Math.sqrt(1 + dx * dx + dy * dy))) : 1
        const o = ((y - y0) * bw + (x - x0)) * 4
        let r: number
        let g: number
        let b: number
        let s = sh
        if (mode === 'elevation') {
          rampColor(ELEV_RAMP, h, rgb)
          s = 0.72 + 0.28 * sh
        } else if (mode === 'temperature') {
          rampColor(TEMP_RAMP, w.temperature[i] + (tp ? tp[i] - (gtp ? gtp[i] : 0) : 0), rgb)
          s = h > 0 ? 0.85 + 0.15 * sh : 0.78
        } else if (mode === 'rain') {
          if (h > 0) {
            rampColor(RAIN_RAMP, w.precipitation[i] * Math.exp(rn ? rn[i] - (grn ? grn[i] : 0) : 0), rgb)
            s = 0.85 + 0.15 * sh
          } else {
            rgb[0] = 38
            rgb[1] = 52
            rgb[2] = 66
            s = 1
          }
        } else {
          rgb[0] = c.data[i * 4]
          rgb[1] = c.data[i * 4 + 1]
          rgb[2] = c.data[i * 4 + 2]
          // 画笔把海里抬出陆地、把陆地压成海时，底色跟着变
          if (e0[i] <= 0 && h > 0) [rgb[0], rgb[1], rgb[2]] = [150, 160, 110]
          else if (e0[i] > 0 && h <= 0) [rgb[0], rgb[1], rgb[2]] = [60, 110, 150]
          if (mode === 'regions') {
            // 淡化，让区域色更醒目
            const l = (rgb[0] + rgb[1] + rgb[2]) / 3
            rgb[0] = l + (rgb[0] - l) * 0.35
            rgb[1] = l + (rgb[1] - l) * 0.35
            rgb[2] = l + (rgb[2] - l) * 0.35
          }
        }
        r = rgb[0] * s
        g = rgb[1] * s
        b = rgb[2] * s
        img.data[o] = r
        img.data[o + 1] = g
        img.data[o + 2] = b
        img.data[o + 3] = 255
        // 叠色
        let cr = 0
        let cg = 0
        let cb = 0
        let ca = 0
        const add = (rr: number, gg: number, bb: number, a: number) => {
          if (a <= 0) return
          cr = (cr * ca + rr * a) / (ca + a)
          cg = (cg * ca + gg * a) / (ca + a)
          cb = (cb * ca + bb * a) / (ca + a)
          ca = Math.min(1, ca + a)
        }
        if (mode === 'regions') {
          const id = regions ? regions[i] : -1
          if (id >= 0) {
            const col = REGION_COLORS[id % REGION_COLORS.length]
            const border = x > 0 && x < W - 1 && y > 0 && y < H - 1 && (regions![i - 1] !== id || regions![i + 1] !== id || regions![i - W] !== id || regions![i + W] !== id)
            const a = border ? 0.95 : id === this.selectedRegion ? 0.55 : 0.32
            add(col[0], col[1], col[2], a)
          }
        } else if (mode === 'relief') {
          // 地貌底图上用叠色标出编辑：地形红抬蓝压，气温橙 / 青，降水绿 / 褐
          if (t && t[i] !== 0) add(t[i] > 0 ? 235 : 70, t[i] > 0 ? 90 : 140, t[i] > 0 ? 60 : 235, Math.min(0.5, 0.08 + Math.abs(t[i]) * 2))
          if (tp && tp[i] !== 0) add(tp[i] > 0 ? 255 : 80, tp[i] > 0 ? 160 : 210, tp[i] > 0 ? 40 : 255, Math.min(0.45, 0.08 + Math.abs(tp[i]) / 10))
          if (rn && rn[i] !== 0) add(rn[i] > 0 ? 60 : 190, rn[i] > 0 ? 200 : 140, rn[i] > 0 ? 110 : 60, Math.min(0.45, 0.08 + Math.abs(rn[i]) / 1.2))
        }
        ov.data[o] = cr
        ov.data[o + 1] = cg
        ov.data[o + 2] = cb
        ov.data[o + 3] = ca * 255
      }
    }
    this.baseCtx.putImageData(img, x0, y0)
    this.overCtx.putImageData(ov, x0, y0)
    this.dirty = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 }
    this.scheduleIso()
  }

  /** 等值线较慢：画笔停顿后再算（期间沿用旧线） */
  private scheduleIso() {
    clearTimeout(this.isoTimer)
    this.isoTimer = window.setTimeout(() => {
      this.iso = this.computeIso()
      this.draw()
    }, this.drag ? 400 : 60)
  }

  private computeIso(): IsoGroup[] {
    const w = this.world
    if (!w) return []
    const { W, H } = w
    const mode = this.viewMode
    if (mode === 'elevation') {
      const f = this.liveElevation()
      const lv: [number, string, number][] = []
      for (const d of [-4, -3, -2, -1, -0.2]) lv.push([d, 'rgba(10,30,55,0.45)', 0.7])
      lv.push([0.0005, 'rgba(15,20,25,0.95)', 1.3])
      for (let h = 0.25; h <= 7; h += 0.25) {
        const major = Math.abs(h - Math.round(h)) < 1e-6
        lv.push([h, major ? 'rgba(55,35,20,0.8)' : 'rgba(55,35,20,0.38)', major ? 1.1 : 0.6])
      }
      return isolines(f, W, H, lv)
    }
    if (mode === 'temperature') {
      const f = this.liveField('temp')
      const lv: [number, string, number][] = []
      for (let t = -30; t <= 35; t += 5) lv.push([t, t === 0 ? 'rgba(20,40,90,0.85)' : 'rgba(40,30,30,0.35)', t === 0 ? 1.3 : 0.7])
      const out = isolines(f, W, H, lv)
      out.push(...isolines(this.liveElevation(), W, H, [[0.0005, 'rgba(15,20,25,0.7)', 1]]))
      return out
    }
    if (mode === 'rain') {
      const f = this.liveField('rain')
      // 海上不画等降水量线
      const e = this.liveElevation()
      const g = new Float32Array(f)
      for (let i = 0; i < g.length; i++) if (e[i] <= 0) g[i] = -1
      const lv: [number, string, number][] = [250, 500, 1000, 1500, 2000, 3000].map((v) => [v, v === 1000 ? 'rgba(20,50,40,0.75)' : 'rgba(30,40,30,0.4)', v === 1000 ? 1.2 : 0.7])
      const out = isolines(g, W, H, lv)
      out.push(...isolines(e, W, H, [[0.0005, 'rgba(210,225,235,0.6)', 1]]))
      return out
    }
    return []
  }

  private updateLegend() {
    const lg = LEGENDS[this.viewMode]
    if (!lg) {
      this.legend.style.display = 'none'
      return
    }
    this.legend.style.display = ''
    const stops = lg.ramp
      .filter(([v]) => v >= lg.min - 1e-6 && v <= lg.max + 1e-6)
      .map(([v, r, g, b]) => `rgb(${r},${g},${b}) ${(((v - lg.min) / (lg.max - lg.min)) * 100).toFixed(1)}%`)
      .join(',')
    this.legend.innerHTML =
      `<div class="lg-title">${t(lg.title)}</div><div class="lg-bar" style="background:linear-gradient(to right,${stops})"></div>` +
      `<div class="lg-ticks">${lg.ticks.map(([v, t]) => `<span style="left:${((v - lg.min) / (lg.max - lg.min)) * 100}%">${t}</span>`).join('')}</div>`
  }

  draw() {
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(() => this.render())
  }

  private render() {
    const ctx = this.ctx
    const dpr = this.canvas.width / Math.max(1, this.container.clientWidth)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const w = this.world
    if (!w) return
    const { x, y, k } = this.view
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = k < 3
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.base, x, y, w.W * k, w.H * k)
    ctx.drawImage(this.over, x, y, w.W * k, w.H * k)
    // 等值线（格坐标的矢量路径，放大也清晰）
    if (this.iso.length) {
      ctx.save()
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y)
      ctx.lineJoin = 'round'
      for (const g of this.iso) {
        ctx.strokeStyle = g.color
        ctx.lineWidth = g.width / k
        ctx.stroke(g.path)
      }
      ctx.restore()
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth = 1
    ctx.strokeRect(x - 0.5, y - 0.5, w.W * k + 1, w.H * k + 1)
    // 地点
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const regionMode = this.viewMode === 'regions'
    for (const l of w.labels) {
      // 大洲视图只显示大洲名；其余视图照常
      if (regionMode && l.kind !== 'continent') continue
      const st = KIND_STYLE[l.kind]
      const sx = x + l.x * k
      const sy = y + l.y * k
      const sel = l === this.selected
      if (st.dot) {
        ctx.beginPath()
        ctx.arc(sx, sy, st.dot, 0, Math.PI * 2)
        ctx.fillStyle = l.kind === 'capital' ? '#1b1b1b' : '#f4f1ea'
        ctx.fill()
        ctx.lineWidth = l.kind === 'capital' ? 2 : 1.2
        ctx.strokeStyle = l.kind === 'capital' ? '#f4f1ea' : '#1b1b1b'
        ctx.stroke()
      }
      if (this.showNames || sel || regionMode) {
        ctx.font = `${st.font} ${cjkFont(lang)}`
        const text = placeName(l)
        const ty = st.dot ? sy - st.dot - 9 : sy
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'
        ctx.strokeText(text, sx, ty)
        ctx.fillStyle = sel ? '#ffd27a' : st.color
        ctx.fillText(text, sx, ty)
      }
      if (sel) {
        ctx.beginPath()
        ctx.arc(sx, sy, 10, 0, Math.PI * 2)
        ctx.strokeStyle = '#ffd27a'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
    // 画笔光标
    if (this.mouse.inside && this.isBrush()) {
      ctx.beginPath()
      ctx.arc(this.mouse.x, this.mouse.y, this.brush.radius * k, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.lineWidth = 1.2
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(this.mouse.x, this.mouse.y, this.brush.radius * k * 0.5, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'
      ctx.stroke()
    }
  }

  private isBrush() {
    return this.tool !== 'select' && this.tool !== 'place' && this.tool !== 'region'
  }

  /** 屏幕点附近的地点（像素距离 14 以内，取最近） */
  hitLabel(sx: number, sy: number): Label | null {
    const w = this.world
    if (!w) return null
    let best: Label | null = null
    let bd = 14
    for (const l of w.labels) {
      const d = Math.hypot(this.view.x + l.x * this.view.k - sx, this.view.y + l.y * this.view.k - sy)
      if (d < bd) {
        bd = d
        best = l
      }
    }
    return best
  }

  /** 当前（含未演算的地形编辑）的陆地掩码 */
  landMask(): Uint8Array {
    const e = this.liveElevation()
    const m = new Uint8Array(e.length)
    for (let i = 0; i < e.length; i++) m[i] = e[i] > 0 ? 1 : 0
    return m
  }

  /** 大洲工具：点选陆块。已有大洲则选中；否则把这片连通陆地（未归属的部分）建成新大洲 */
  private pickRegion(sx: number, sy: number) {
    const w = this.world
    if (!w) return
    const c = this.toCell(sx, sy)
    const cx = Math.floor(c.x)
    const cy = Math.floor(c.y)
    if (cx < 0 || cy < 0 || cx >= w.W || cy >= w.H) return
    const i = cy * w.W + cx
    const regions = this.edits.regions
    if (regions && regions[i] >= 0) {
      this.selectRegion(regions[i])
      return
    }
    const land = this.landMask()
    if (!land[i]) {
      this.selectRegion(-1)
      return
    }
    this.cb.onBeforeEdit()
    const reg = this.edits.regions ?? new Int16Array(w.W * w.H).fill(-1)
    this.edits.regions = reg
    const meta = (this.edits.regionMeta ??= [])
    const id = meta.length
    meta.push({ name: 'Nova Terra', zh: '新大洲', ja: 'ノヴァ・テラ' })
    for (const j of floodLand(land, reg, w.W, w.H, i, -1)) reg[j] = id
    this.selectRegion(id)
    this.cb.onCommit('regions')
  }

  private stamp(sx: number, sy: number, dt: number) {
    const w = this.world
    if (!w) return
    const { W, H } = w
    const N = W * H
    const c = this.toCell(sx, sy)
    const R = this.brush.radius
    const x0 = Math.max(0, Math.floor(c.x - R))
    const x1 = Math.min(W - 1, Math.ceil(c.x + R))
    const y0 = Math.max(0, Math.floor(c.y - R))
    const y1 = Math.min(H - 1, Math.ceil(c.y + R))
    if (x1 < x0 || y1 < y0) return
    const tool = this.tool
    if (tool === 'regionAdd' || tool === 'regionErase') {
      const reg = this.edits.regions
      const sel = this.selectedRegion
      if (!reg || sel < 0) return
      const e = w.elevation
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if ((x - c.x) ** 2 + (y - c.y) ** 2 >= R * R) continue
          const i = y * W + x
          if (tool === 'regionAdd' && e[i] > 0) reg[i] = sel
          else if (tool === 'regionErase' && reg[i] === sel) reg[i] = -1
        }
      }
      this.markDirty(x0, y0, x1, y1)
      this.refresh()
      this.draw()
      return
    }
    // 按时间积分：强度 1 时地形每秒约 ±3 km、气温 ±20 °C、降水倍率 e^±2
    const s = this.brush.strength * Math.min(0.1, dt)
    const key: 'terrain' | 'temp' | 'rain' = tool === 'raise' || tool === 'lower' || tool === 'smooth' ? 'terrain' : tool === 'warm' || tool === 'cool' ? 'temp' : 'rain'
    let arr = this.edits[key]
    if (!arr || arr.length !== N) arr = this.edits[key] = new Float32Array(N)
    const e = w.elevation
    const g = this.genEdits.terrain
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = ((x - c.x) ** 2 + (y - c.y) ** 2) / (R * R)
        if (d2 >= 1) continue
        // 平滑的钟形衰减
        const f = (1 - d2) * (1 - d2)
        const i = y * W + x
        switch (tool) {
          case 'raise':
            arr[i] += 3 * s * f
            break
          case 'lower':
            arr[i] -= 3 * s * f
            break
          case 'smooth': {
            // 向邻域平均靠拢（作用在当前高度上）
            let sum = 0
            let n = 0
            for (let oy = -2; oy <= 2; oy++) {
              for (let ox = -2; ox <= 2; ox++) {
                const xx = Math.min(W - 1, Math.max(0, x + ox * 2))
                const yy = Math.min(H - 1, Math.max(0, y + oy * 2))
                const j = yy * W + xx
                sum += e[j] + arr[j] - (g ? g[j] : 0)
                n++
              }
            }
            const cur = e[i] + arr[i] - (g ? g[i] : 0)
            arr[i] += (sum / n - cur) * Math.min(1, 12 * s * f)
            break
          }
          case 'warm':
            arr[i] += 20 * s * f
            break
          case 'cool':
            arr[i] -= 20 * s * f
            break
          case 'wet':
            arr[i] += 2 * s * f
            break
          case 'dry':
            arr[i] -= 2 * s * f
            break
        }
      }
    }
    if (key === 'terrain') this.edits.terrainRev = (this.edits.terrainRev ?? 0) + 1
    this.markDirty(x0, y0, x1, y1)
    this.refresh()
    this.draw()
  }

  private bind() {
    const el = this.canvas
    let last = 0
    let paintTimer = 0
    const pos = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener('pointerdown', (e) => {
      const p = pos(e)
      this.mouse = { x: p.x, y: p.y, inside: true }
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // 合成事件没有活动指针，忽略
      }
      // 右键、中键或按住 Shift：平移
      if (e.button !== 0 || e.shiftKey) {
        this.drag = { mode: 'pan', x: p.x, y: p.y, vx: this.view.x, vy: this.view.y }
        return
      }
      if (this.tool === 'region') {
        this.pickRegion(p.x, p.y)
        this.drag = { mode: 'pan', x: p.x, y: p.y, vx: this.view.x, vy: this.view.y }
        return
      }
      if (this.isBrush()) {
        if ((this.tool === 'regionAdd' || this.tool === 'regionErase') && this.selectedRegion < 0) return
        this.cb.onBeforeEdit()
        this.drag = { mode: 'paint', x: p.x, y: p.y, vx: 0, vy: 0 }
        last = performance.now()
        this.stamp(p.x, p.y, 0.03)
        // 按住不动也持续起作用
        const tick = () => {
          if (this.drag?.mode !== 'paint') return
          const now = performance.now()
          if (this.tool !== 'regionAdd' && this.tool !== 'regionErase') this.stamp(this.mouse.x, this.mouse.y, (now - last) / 1000)
          last = now
          paintTimer = window.setTimeout(tick, 33)
        }
        paintTimer = window.setTimeout(tick, 33)
        return
      }
      const hit = this.hitLabel(p.x, p.y)
      if (this.tool === 'place' && !hit) {
        const w = this.world
        if (!w) return
        const c = this.toCell(p.x, p.y)
        if (c.x < 0 || c.y < 0 || c.x >= w.W || c.y >= w.H) return
        this.cb.onBeforeEdit()
        const l: Label = { kind: 'city', name: 'New Town', zh: '新地点', ja: 'ニュータウン', x: c.x, y: c.y, angle: 0, weight: 50, span: 0 }
        w.labels.push(l)
        this.select(l)
        this.cb.onCommit('labels')
        return
      }
      if (hit) {
        this.select(hit)
        this.cb.onBeforeEdit()
        this.drag = { mode: 'move', x: p.x, y: p.y, vx: hit.x, vy: hit.y, label: hit }
      } else {
        this.select(null)
        this.drag = { mode: 'pan', x: p.x, y: p.y, vx: this.view.x, vy: this.view.y }
      }
    })
    el.addEventListener('pointermove', (e) => {
      const p = pos(e)
      this.mouse = { x: p.x, y: p.y, inside: true }
      const d = this.drag
      if (d?.mode === 'paint') {
        // 沿路径补笔：从上一笔起累计路程，每隔约 1/4 画笔半径落一笔（快拖、慢拖效果一致）
        const step = Math.max(2, this.brush.radius * this.view.k * 0.25)
        let len = Math.hypot(p.x - d.x, p.y - d.y)
        while (len >= step) {
          d.x += ((p.x - d.x) * step) / len
          d.y += ((p.y - d.y) * step) / len
          this.stamp(d.x, d.y, 0.02)
          len -= step
        }
      } else if (d?.mode === 'pan') {
        this.view.x = d.vx + p.x - d.x
        this.view.y = d.vy + p.y - d.y
      } else if (d?.mode === 'move' && d.label) {
        d.label.x = d.vx + (p.x - d.x) / this.view.k
        d.label.y = d.vy + (p.y - d.y) / this.view.k
      }
      this.draw()
    })
    const end = () => {
      const d = this.drag
      this.drag = null
      clearTimeout(paintTimer)
      if (!d) return
      if (d.mode === 'paint') {
        const t = this.tool
        this.cb.onCommit(t === 'raise' || t === 'lower' || t === 'smooth' ? 'terrain' : t === 'regionAdd' || t === 'regionErase' ? 'regions' : 'climate')
        this.scheduleIso()
      } else if (d.mode === 'move' && d.label && (d.label.x !== d.vx || d.label.y !== d.vy)) this.cb.onCommit('labels')
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('pointerleave', () => {
      this.mouse.inside = false
      this.draw()
    })
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const p = pos(e)
        // Alt + 滚轮：调画笔大小
        if (e.altKey && this.isBrush()) {
          this.brush.radius = Math.min(120, Math.max(2, this.brush.radius * Math.exp(-e.deltaY * 0.002)))
          this.draw()
          return
        }
        const f = Math.exp(-e.deltaY * 0.0015)
        const nk = Math.min(40, Math.max(0.2, this.view.k * f))
        this.view.x = p.x - ((p.x - this.view.x) * nk) / this.view.k
        this.view.y = p.y - ((p.y - this.view.y) * nk) / this.view.k
        this.view.k = nk
        this.draw()
      },
      { passive: false },
    )
    el.addEventListener('dblclick', () => this.tool === 'select' && !this.selected && this.fit())
  }
}
