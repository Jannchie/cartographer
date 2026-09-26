/**
 * 录制型 Canvas2D：实现地图叠加层用到的那部分 CanvasRenderingContext2D 接口，
 * 每次 fill / stroke / fillText 输出一个 SVG 元素。于是河流、符号、注记、罗盘、图框等
 * 现有的绘制代码无需改动，就能同时产出位图和矢量图。
 */

type M = [number, number, number, number, number, number]

interface State {
  m: M
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  lineCap: string
  lineJoin: string
  dash: number[]
  alpha: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  clip: string | null
  composite: string
}

const num = (v: number) => (Math.round(v * 100) / 100).toString()

function mul(a: M, b: M): M {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 把 rgba()/rgb()/#hex 拆成颜色 + 不透明度（SVG 1.1 查看器不认 rgba） */
function color(c: string): [string, number] {
  const m = c.match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/)
  if (m) return [`rgb(${Math.round(+m[1])},${Math.round(+m[2])},${Math.round(+m[3])})`, +m[4]]
  return [c, 1]
}

export class SvgContext {
  private out: (string | { d: string[]; a: string })[] = []
  private defs: string[] = []
  private stack: State[] = []
  private st: State = {
    m: [1, 0, 0, 1, 0, 0],
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    dash: [],
    alpha: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    clip: null,
    composite: 'source-over',
  }
  private path: string[] = []
  /** 上一个 path 元素的样式签名，相同则合并 d，减小体积 */
  private last: { d: string[]; a: string } | null = null
  private clipId = 0
  /** 用于 measureText 的真实画布 */
  private measurer: CanvasRenderingContext2D

  constructor(measurer: CanvasRenderingContext2D) {
    this.measurer = measurer
  }

  // —— 状态属性 ——
  get fillStyle() {
    return this.st.fillStyle
  }
  set fillStyle(v: string) {
    this.st.fillStyle = v
  }
  get strokeStyle() {
    return this.st.strokeStyle
  }
  set strokeStyle(v: string) {
    this.st.strokeStyle = v
  }
  get lineWidth() {
    return this.st.lineWidth
  }
  set lineWidth(v: number) {
    this.st.lineWidth = v
  }
  set lineCap(v: string) {
    this.st.lineCap = v
  }
  set lineJoin(v: string) {
    this.st.lineJoin = v
  }
  get globalAlpha() {
    return this.st.alpha
  }
  set globalAlpha(v: number) {
    this.st.alpha = v
  }
  set globalCompositeOperation(v: string) {
    this.st.composite = v
  }
  get font() {
    return this.st.font
  }
  set font(v: string) {
    this.st.font = v
  }
  set textAlign(v: CanvasTextAlign) {
    this.st.textAlign = v
  }
  set textBaseline(v: CanvasTextBaseline) {
    this.st.textBaseline = v
  }
  setLineDash(d: number[]) {
    this.st.dash = [...d]
  }

  save() {
    this.stack.push({ ...this.st, m: [...this.st.m] as M, dash: [...this.st.dash] })
  }
  restore() {
    const s = this.stack.pop()
    if (s) this.st = s
  }
  translate(x: number, y: number) {
    this.st.m = mul(this.st.m, [1, 0, 0, 1, x, y])
  }
  rotate(a: number) {
    const c = Math.cos(a)
    const s = Math.sin(a)
    this.st.m = mul(this.st.m, [c, s, -s, c, 0, 0])
  }
  scale(x: number, y: number) {
    this.st.m = mul(this.st.m, [x, 0, 0, y, 0, 0])
  }

  // —— 路径 ——
  beginPath() {
    this.path = []
  }
  moveTo(x: number, y: number) {
    this.path.push(`M${num(x)} ${num(y)}`)
  }
  lineTo(x: number, y: number) {
    this.path.push(`L${num(x)} ${num(y)}`)
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    this.path.push(`Q${num(cx)} ${num(cy)} ${num(x)} ${num(y)}`)
  }
  closePath() {
    this.path.push('Z')
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path.push(`M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}Z`)
  }
  arc(x: number, y: number, r: number, a0: number, a1: number) {
    const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6
    if (full) {
      this.path.push(`M${num(x + r)} ${num(y)}A${num(r)} ${num(r)} 0 1 1 ${num(x - r)} ${num(y)}A${num(r)} ${num(r)} 0 1 1 ${num(x + r)} ${num(y)}`)
      return
    }
    const sx = x + Math.cos(a0) * r
    const sy = y + Math.sin(a0) * r
    const ex = x + Math.cos(a1) * r
    const ey = y + Math.sin(a1) * r
    const large = a1 - a0 > Math.PI ? 1 : 0
    this.path.push(`${this.path.length ? 'L' : 'M'}${num(sx)} ${num(sy)}A${num(r)} ${num(r)} 0 ${large} 1 ${num(ex)} ${num(ey)}`)
  }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number) {
    if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6 && rot === 0) {
      this.path.push(`M${num(x + rx)} ${num(y)}A${num(rx)} ${num(ry)} 0 1 1 ${num(x - rx)} ${num(y)}A${num(rx)} ${num(ry)} 0 1 1 ${num(x + rx)} ${num(y)}`)
    }
  }

  private attrs(): string {
    const m = this.st.m
    let a = ''
    if (!(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)) a += ` transform="matrix(${m.map(num).join(' ')})"`
    if (this.st.alpha < 1) a += ` opacity="${num(this.st.alpha)}"`
    if (this.st.clip) a += ` clip-path="url(#${this.st.clip})"`
    return a
  }

  private emitPath(attrs: string) {
    const d = this.path.join('')
    const last = this.out[this.out.length - 1]
    if (this.last && last === this.last && this.last.a === attrs) {
      this.last.d.push(d)
      return
    }
    this.last = { d: [d], a: attrs }
    this.out.push(this.last)
  }

  fill() {
    if (this.st.composite !== 'source-over' || !this.path.length) return
    const [c, o] = color(this.st.fillStyle)
    this.emitPath(` fill="${c}"${o < 1 ? ` fill-opacity="${num(o)}"` : ''}${this.attrs()}`)
  }
  stroke() {
    if (this.st.composite !== 'source-over' || !this.path.length) return
    const [c, o] = color(this.st.strokeStyle)
    let a = ` stroke="${c}" stroke-width="${num(this.st.lineWidth)}"`
    if (o < 1) a += ` stroke-opacity="${num(o)}"`
    if (this.st.lineCap !== 'butt') a += ` stroke-linecap="${this.st.lineCap}"`
    if (this.st.lineJoin !== 'miter') a += ` stroke-linejoin="${this.st.lineJoin}"`
    if (this.st.dash.length) a += ` stroke-dasharray="${this.st.dash.map(num).join(' ')}"`
    this.emitPath(` fill="none"${a}${this.attrs()}`)
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.beginPath()
    this.rect(x, y, w, h)
    this.fill()
    this.beginPath()
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    this.beginPath()
    this.rect(x, y, w, h)
    this.stroke()
    this.beginPath()
  }
  clip() {
    const id = `c${++this.clipId}`
    const m = this.st.m
    this.defs.push(`<clipPath id="${id}"><path d="${this.path.join('')}" transform="matrix(${m.map(num).join(' ')})"/></clipPath>`)
    this.st.clip = id
  }

  // —— 文字 ——
  measureText(t: string) {
    this.measurer.font = this.st.font
    return this.measurer.measureText(t)
  }
  private text(t: string, x: number, y: number, paint: string) {
    const anchor = this.st.textAlign === 'center' ? 'middle' : this.st.textAlign === 'right' || this.st.textAlign === 'end' ? 'end' : 'start'
    const bl = this.st.textBaseline
    const base = bl === 'middle' ? 'central' : bl === 'top' || bl === 'hanging' ? 'hanging' : bl === 'bottom' ? 'text-after-edge' : 'auto'
    this.out.push(
      `<text x="${num(x)}" y="${num(y)}" style="font:${esc(this.st.font)}" text-anchor="${anchor}"${base !== 'auto' ? ` dominant-baseline="${base}"` : ''} ${paint}${this.attrs()}>${esc(t)}</text>`,
    )
  }
  fillText(t: string, x: number, y: number) {
    const [c, o] = color(this.st.fillStyle)
    this.text(t, x, y, `fill="${c}"${o < 1 ? ` fill-opacity="${num(o)}"` : ''}`)
  }
  strokeText(t: string, x: number, y: number) {
    const [c, o] = color(this.st.strokeStyle)
    this.text(
      t,
      x,
      y,
      `fill="none" stroke="${c}" stroke-width="${num(this.st.lineWidth)}" stroke-linejoin="round"${o < 1 ? ` stroke-opacity="${num(o)}"` : ''}`,
    )
  }

  // —— 直接写入原始 SVG ——
  raw(s: string) {
    this.out.push(s)
  }
  def(s: string) {
    this.defs.push(s)
  }
  get currentClip() {
    return this.st.clip
  }

  toString(width: number, height: number, head = '') {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      head +
      `<defs>${this.defs.join('')}</defs>` +
      this.out.map((o) => (typeof o === 'string' ? o : `<path d="${o.d.join('')}"${o.a}/>`)).join('\n') +
      `</svg>`
    )
  }
}
