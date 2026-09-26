import type { DisplayList, Matrix } from './displayList'
import { pathBBox, transformBBox } from './displayList'

/**
 * 录制型 Canvas2D：实现地图叠加层用到的那部分 CanvasRenderingContext2D 接口，
 * 每次 fill / stroke / fillText 生成一条显示列表指令。于是河流、符号、注记、罗盘、
 * 图框等现有的绘制代码无需改动，就能同时产出位图与矢量。
 */

interface State {
  m: Matrix
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  dash: number[]
  alpha: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  composite: string
}

const num = (v: number) => (Math.round(v * 100) / 100).toString()

function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

/** 把 rgba()/rgb()/#hex 拆成颜色 + 不透明度 */
function color(c: string): [string, number] {
  const m = c.match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/)
  if (m) return [`rgb(${Math.round(+m[1])},${Math.round(+m[2])},${Math.round(+m[3])})`, +m[4]]
  return [c, 1]
}

const isIdentity = (m: Matrix) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0

export class Recorder {
  /** 当前写入的坐标空间 */
  space: 'page' | 'map' = 'map'
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
    composite: 'source-over',
  }
  private path: string[] = []

  constructor(
    private list: DisplayList,
    private measurer: CanvasRenderingContext2D,
  ) {}

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
  set lineCap(v: CanvasLineCap) {
    this.st.lineCap = v
  }
  set lineJoin(v: CanvasLineJoin) {
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
    this.stack.push({ ...this.st, m: [...this.st.m] as Matrix, dash: [...this.st.dash] })
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

  // —— 路径（全部用绝对坐标，便于求包围盒） ——
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
    this.path.push(`M${num(x)} ${num(y)}L${num(x + w)} ${num(y)}L${num(x + w)} ${num(y + h)}L${num(x)} ${num(y + h)}Z`)
  }
  arc(x: number, y: number, r: number, a0: number, a1: number) {
    if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6) {
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
  clip() {
    // 叠加层的绘制代码不使用裁剪
  }

  private get m(): Matrix | undefined {
    return isIdentity(this.st.m) ? undefined : ([...this.st.m] as Matrix)
  }

  /** 与上一条指令样式完全相同则合并路径，减小体积、加快绘制 */
  private emit(fill: boolean) {
    if (this.st.composite !== 'source-over' || !this.path.length) return
    const d = this.path.join('')
    const m = this.m
    const seg = this.list.segment(this.space)
    const last = seg.items[seg.items.length - 1]
    const [c, a] = color(fill ? this.st.fillStyle : this.st.strokeStyle)
    const fillP = fill ? { color: c, alpha: a } : undefined
    const strokeP = fill
      ? undefined
      : { color: c, alpha: a, width: this.st.lineWidth, dash: this.st.dash.length ? [...this.st.dash] : undefined, cap: this.st.lineCap, join: this.st.lineJoin }
    const sig = JSON.stringify([fillP, strokeP, m, this.st.alpha])
    if (last && last.k === 'path' && (last as unknown as { sig?: string }).sig === sig) {
      last.d += d
      const b = transformBBox(pathBBox(d), m)
      const r = (strokeP?.width ?? 0) * 2 + 1
      last.bbox = [Math.min(last.bbox[0], b[0] - r), Math.min(last.bbox[1], b[1] - r), Math.max(last.bbox[2], b[2] + r), Math.max(last.bbox[3], b[3] + r)]
      last.p2d = undefined
      return
    }
    const it = this.list.path(this.space, d, { fill: fillP, stroke: strokeP, m, opacity: this.st.alpha })
    if (it) (it as unknown as { sig?: string }).sig = sig
  }

  fill() {
    this.emit(true)
  }
  stroke() {
    this.emit(false)
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

  // —— 文字 ——
  measureText(t: string) {
    this.measurer.font = this.st.font
    return this.measurer.measureText(t)
  }
  private text(t: string, x: number, y: number, stroke: boolean) {
    const align = this.st.textAlign === 'center' ? 'middle' : this.st.textAlign === 'right' || this.st.textAlign === 'end' ? 'end' : 'start'
    const bl = this.st.textBaseline
    const baseline = bl === 'middle' ? 'central' : bl === 'top' || bl === 'hanging' ? 'hanging' : bl === 'bottom' ? 'text-after-edge' : 'auto'
    // 估算包围盒
    this.measurer.font = this.st.font
    const w = this.measurer.measureText(t).width
    const size = parseFloat(this.st.font.match(/([\d.]+)px/)?.[1] ?? '12')
    const bx0 = align === 'middle' ? x - w / 2 : align === 'end' ? x - w : x
    const bb = transformBBox([bx0 - 4, y - size * 1.2, bx0 + w + 4, y + size * 1.2], this.m)
    const [c, a] = color(stroke ? this.st.strokeStyle : this.st.fillStyle)
    this.list.text(this.space, {
      t,
      x,
      y,
      font: this.st.font,
      align,
      baseline,
      fill: stroke ? undefined : { color: c, alpha: a },
      stroke: stroke ? { color: c, alpha: a, width: this.st.lineWidth } : undefined,
      m: this.m,
      opacity: this.st.alpha,
      bbox: bb,
    })
  }
  fillText(t: string, x: number, y: number) {
    this.text(t, x, y, false)
  }
  strokeText(t: string, x: number, y: number) {
    this.text(t, x, y, true)
  }
}
