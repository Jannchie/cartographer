import type { Label, World, WorldEdits } from '../gen/types'

/**
 * 世界编辑视图：俯视的地形底图 + 编辑增量叠色 + 地点，支持
 *  - 地形画笔（抬升 / 下沉 / 抹平）：改的是侵蚀前的"地形意图"，松手后重新演算侵蚀、水系与气候；
 *  - 气候画笔（升温 / 降温 / 增雨 / 减雨）；
 *  - 地点：选中后改名、改类型、拖动、删除，或点击空白处新增。
 * 画笔实时预览：编辑增量叠色 + 按"高度 + 增量"重算的山体阴影。
 */

export type EditTool = 'select' | 'raise' | 'lower' | 'smooth' | 'warm' | 'cool' | 'wet' | 'dry' | 'place'

export interface EditorCallbacks {
  /** 一笔画完（或地点增删改完）：kind 决定需要重算到哪一步 */
  onCommit: (kind: 'terrain' | 'climate' | 'labels') => void
  /** 一笔开始前：用于撤销 */
  onBeforeEdit: () => void
  onSelect: (label: Label | null) => void
}

/** 每种地点在编辑图上的样式 */
const KIND_STYLE: Record<Label['kind'], { font: string; color: string; dot?: number }> = {
  capital: { font: '600 13px', color: '#fff', dot: 4.5 },
  city: { font: '500 12px', color: '#f1ede4', dot: 3 },
  continent: { font: '600 16px', color: 'rgba(255,255,255,0.8)' },
  island: { font: 'italic 12px', color: 'rgba(255,255,255,0.85)' },
  ocean: { font: 'italic 15px', color: 'rgba(200,225,240,0.85)' },
  sea: { font: 'italic 13px', color: 'rgba(200,225,240,0.85)' },
  lake: { font: 'italic 11px', color: 'rgba(210,235,245,0.9)' },
  range: { font: 'italic 12px', color: 'rgba(250,235,215,0.9)' },
  basin: { font: 'italic 11px', color: 'rgba(250,235,215,0.8)' },
  desert: { font: 'italic 11px', color: 'rgba(250,235,215,0.8)' },
  forest: { font: 'italic 11px', color: 'rgba(225,245,215,0.85)' },
}

export class EditorView {
  readonly canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d')!
  private world: World | null = null
  private edits: WorldEdits = {}
  /** 底图：地表色 × 山体阴影（W×H 像素，放大绘制） */
  private base = document.createElement('canvas')
  private baseCtx = this.base.getContext('2d')!
  private color: ImageData | null = null
  /** 编辑增量叠色 */
  private over = document.createElement('canvas')
  private overCtx = this.over.getContext('2d')!
  private view = { x: 0, y: 0, k: 1 }
  private raf = 0
  private mouse = { x: -1, y: -1, inside: false }
  private drag: { mode: 'pan' | 'paint' | 'move'; x: number; y: number; vx: number; vy: number; label?: Label } | null = null
  private dirty = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 }
  tool: EditTool = 'select'
  brush = { radius: 18, strength: 0.5 }
  selected: Label | null = null
  showNames = true

  constructor(
    private container: HTMLElement,
    private cb: EditorCallbacks,
  ) {
    container.appendChild(this.canvas)
    this.canvas.className = 'editor-canvas'
    new ResizeObserver(() => this.resize()).observe(container)
    this.bind()
  }

  /** 换世界或演算完成后调用；edits 是主线程持有的同一个对象（原地修改） */
  setWorld(world: World, color: HTMLCanvasElement, edits: WorldEdits) {
    const first = !this.world || this.world.W !== world.W || this.world.H !== world.H
    this.world = world
    this.edits = edits
    const { W, H } = world
    // 地表色缩到 W×H，与高度图一一对应，方便局部重算阴影
    const tmp = document.createElement('canvas')
    tmp.width = W
    tmp.height = H
    const tc = tmp.getContext('2d')!
    tc.drawImage(color, 0, 0, W, H)
    this.color = tc.getImageData(0, 0, W, H)
    this.base.width = this.over.width = W
    this.base.height = this.over.height = H
    this.markDirty(0, 0, W - 1, H - 1)
    this.refresh()
    if (first) this.fit()
    if (this.selected && !world.labels.includes(this.selected)) this.select(null)
    this.draw()
  }

  /** 编辑数据被外部替换（撤销、清除、打开项目）后重画 */
  refreshEdits(edits: WorldEdits) {
    this.edits = edits
    if (!this.world) return
    this.markDirty(0, 0, this.world.W - 1, this.world.H - 1)
    this.refresh()
    this.draw()
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

  private markDirty(x0: number, y0: number, x1: number, y1: number) {
    const d = this.dirty
    d.x0 = Math.min(d.x0, x0)
    d.y0 = Math.min(d.y0, y0)
    d.x1 = Math.max(d.x1, x1)
    d.y1 = Math.max(d.y1, y1)
  }

  /** 重算脏矩形里的底图（阴影按"高度 + 地形增量"）与增量叠色 */
  private refresh() {
    const w = this.world
    const c = this.color
    const d = this.dirty
    if (!w || !c || d.x1 < d.x0) return
    const { W, H, elevation: e } = w
    const t = this.edits.terrain
    const x0 = Math.max(0, d.x0 - 1)
    const y0 = Math.max(0, d.y0 - 1)
    const x1 = Math.min(W - 1, d.x1 + 1)
    const y1 = Math.min(H - 1, d.y1 + 1)
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const img = this.baseCtx.createImageData(bw, bh)
    const ov = this.overCtx.createImageData(bw, bh)
    const hAt = (x: number, y: number) => {
      const i = Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))
      return e[i] + (t ? t[i] : 0)
    }
    const k = 22 / w.kmPerCell
    const tp = this.edits.temp
    const rn = this.edits.rain
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x
        const h = hAt(x, y)
        const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * k
        const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * k
        // 西北光照的山体阴影
        const sh = h > 0 ? Math.max(0.35, Math.min(1.35, 1 + (-dx * 0.7 - dy * 0.7) / Math.sqrt(1 + dx * dx + dy * dy))) : 1
        const o = ((y - y0) * bw + (x - x0)) * 4
        let r = c.data[i * 4]
        let g = c.data[i * 4 + 1]
        let b = c.data[i * 4 + 2]
        // 画笔把海里抬出陆地、把陆地压成海时，底色跟着变
        const orig = e[i]
        if (orig <= 0 && h > 0) [r, g, b] = [150, 160, 110]
        else if (orig > 0 && h <= 0) [r, g, b] = [60, 110, 150]
        img.data[o] = r * sh
        img.data[o + 1] = g * sh
        img.data[o + 2] = b * sh
        img.data[o + 3] = 255
        // 增量叠色：地形红（抬）蓝（压），气温橙/青，降水绿/褐
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
        if (t && t[i] !== 0) add(t[i] > 0 ? 235 : 70, t[i] > 0 ? 90 : 140, t[i] > 0 ? 60 : 235, Math.min(0.5, 0.08 + Math.abs(t[i]) * 2))
        if (tp && tp[i] !== 0) add(tp[i] > 0 ? 255 : 80, tp[i] > 0 ? 160 : 210, tp[i] > 0 ? 40 : 255, Math.min(0.45, 0.08 + Math.abs(tp[i]) / 10))
        if (rn && rn[i] !== 0) add(rn[i] > 0 ? 60 : 190, rn[i] > 0 ? 200 : 140, rn[i] > 0 ? 110 : 60, Math.min(0.45, 0.08 + Math.abs(rn[i]) / 1.2))
        ov.data[o] = cr
        ov.data[o + 1] = cg
        ov.data[o + 2] = cb
        ov.data[o + 3] = ca * 255
      }
    }
    this.baseCtx.putImageData(img, x0, y0)
    this.overCtx.putImageData(ov, x0, y0)
    this.dirty = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 }
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
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth = 1
    ctx.strokeRect(x - 0.5, y - 0.5, w.W * k + 1, w.H * k + 1)
    // 地点
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const l of w.labels) {
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
      if (this.showNames || sel) {
        ctx.font = `${st.font} 'Noto Serif SC', serif`
        const text = l.zh || l.name
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
    return this.tool !== 'select' && this.tool !== 'place'
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

  private stamp(sx: number, sy: number, dt: number) {
    const w = this.world
    if (!w) return
    const { W, H } = w
    const N = W * H
    const c = this.toCell(sx, sy)
    const R = this.brush.radius
    // 按时间积分：强度 1 时地形每秒约 ±3 km、气温 ±20 °C、降水倍率 e^±2
    const s = this.brush.strength * Math.min(0.1, dt)
    const tool = this.tool
    const key: 'terrain' | 'temp' | 'rain' = tool === 'raise' || tool === 'lower' || tool === 'smooth' ? 'terrain' : tool === 'warm' || tool === 'cool' ? 'temp' : 'rain'
    let arr = this.edits[key]
    if (!arr || arr.length !== N) arr = this.edits[key] = new Float32Array(N)
    const x0 = Math.max(0, Math.floor(c.x - R))
    const x1 = Math.min(W - 1, Math.ceil(c.x + R))
    const y0 = Math.max(0, Math.floor(c.y - R))
    const y1 = Math.min(H - 1, Math.ceil(c.y + R))
    if (x1 < x0 || y1 < y0) return
    const e = w.elevation
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
            // 向邻域平均靠拢（作用在"高度 + 增量"上）
            let sum = 0
            let n = 0
            for (let oy = -2; oy <= 2; oy++) {
              for (let ox = -2; ox <= 2; ox++) {
                const xx = Math.min(W - 1, Math.max(0, x + ox * 2))
                const yy = Math.min(H - 1, Math.max(0, y + oy * 2))
                const j = yy * W + xx
                sum += e[j] + arr[j]
                n++
              }
            }
            const cur = e[i] + arr[i]
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
      // 右键或中键、或按住空格：平移
      if (e.button !== 0 || e.shiftKey) {
        this.drag = { mode: 'pan', x: p.x, y: p.y, vx: this.view.x, vy: this.view.y }
        return
      }
      if (this.isBrush()) {
        this.cb.onBeforeEdit()
        this.drag = { mode: 'paint', x: p.x, y: p.y, vx: 0, vy: 0 }
        last = performance.now()
        this.stamp(p.x, p.y, 0.03)
        // 按住不动也持续起作用
        const tick = () => {
          if (this.drag?.mode !== 'paint') return
          const now = performance.now()
          this.stamp(this.mouse.x, this.mouse.y, (now - last) / 1000)
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
        const l: Label = { kind: 'city', name: 'New Town', zh: '新地点', x: c.x, y: c.y, angle: 0, weight: 50, span: 0 }
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
        this.cb.onCommit(t === 'raise' || t === 'lower' || t === 'smooth' ? 'terrain' : 'climate')
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
