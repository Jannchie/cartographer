/**
 * 遮挡符号的分层合批。
 * 每个符号由若干笔（底色、暗面、排线、轮廓……）按序叠成，逐个画时相邻两笔样式不同，
 * 位图要逐笔 fill / stroke，矢量列表也合并不了，几万个符号就是几万条指令。
 * 这里先把每个符号的笔画录下来，按包围盒的遮叠关系分层：
 * 符号的层 = 先画且与它相交的符号的最大层 + 1。同层符号互不相交，同样式的笔可以并成一条路径；
 * 各层从低到高画，相交的两个符号先后次序不变，画面与逐个绘制相同（只有抗锯齿边缘的个别像素有细微出入）。
 */

/** 符号绘制函数用到的那部分 Canvas 接口 */
export interface Pen {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  globalAlpha: number
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  closePath(): void
  fill(): void
  stroke(): void
}

const MOVE = 0
const LINE = 1
const QUAD = 2
const CLOSE = 3

/** 一笔：样式 + 路径（操作码与坐标交错的扁平数组） */
interface Op {
  key: string
  fill: boolean
  style: string
  width: number
  alpha: number
  cmd: number[]
}

interface Glyph {
  ops: Op[]
  /** 包围盒（含描边半宽） */
  x0: number
  y0: number
  x1: number
  y1: number
}

export class GlyphBatch implements Pen {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  globalAlpha: number
  private glyphs: Glyph[] = []
  private cur: Glyph | null = null
  private cmd: number[] = []
  private x0 = Infinity
  private y0 = Infinity
  private x1 = -Infinity
  private y1 = -Infinity

  /** 初始样式取自目标画布，与直接画在它上面时一致 */
  constructor(ctx: Pen) {
    this.fillStyle = ctx.fillStyle as string
    this.strokeStyle = ctx.strokeStyle as string
    this.lineWidth = ctx.lineWidth
    this.globalAlpha = ctx.globalAlpha
  }

  /** 开始录一个新符号 */
  begin() {
    this.end()
    this.cur = { ops: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  }
  private end() {
    const g = this.cur
    if (g?.ops.length) this.glyphs.push(g)
    this.cur = null
  }

  private pt(x: number, y: number) {
    if (x < this.x0) this.x0 = x
    if (x > this.x1) this.x1 = x
    if (y < this.y0) this.y0 = y
    if (y > this.y1) this.y1 = y
  }
  beginPath() {
    this.cmd = []
    this.x0 = this.y0 = Infinity
    this.x1 = this.y1 = -Infinity
  }
  moveTo(x: number, y: number) {
    this.cmd.push(MOVE, x, y)
    this.pt(x, y)
  }
  lineTo(x: number, y: number) {
    this.cmd.push(LINE, x, y)
    this.pt(x, y)
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    // 二次曲线落在控制点的凸包内，控制点计入包围盒即可
    this.cmd.push(QUAD, cx, cy, x, y)
    this.pt(cx, cy)
    this.pt(x, y)
  }
  closePath() {
    this.cmd.push(CLOSE)
  }
  private op(fill: boolean) {
    const g = this.cur
    if (!g || !this.cmd.length) return
    const style = (fill ? this.fillStyle : this.strokeStyle) as string
    const width = fill ? 0 : this.lineWidth
    const alpha = this.globalAlpha
    g.ops.push({ key: `${fill ? 'f' : 's'}|${style}|${width}|${alpha}`, fill, style, width, alpha, cmd: this.cmd })
    // 同一条路径可能先填后描（fill 之后再 stroke），命令数组共用、不再改写
    this.cmd = this.cmd.slice()
    const r = width / 2
    g.x0 = Math.min(g.x0, this.x0 - r)
    g.y0 = Math.min(g.y0, this.y0 - r)
    g.x1 = Math.max(g.x1, this.x1 + r)
    g.y1 = Math.max(g.y1, this.y1 + r)
  }
  fill() {
    this.op(true)
  }
  stroke() {
    this.op(false)
  }

  /**
   * 分层合批画到 ctx 上。
   * band：按绘制次序把符号切成连续的几段，每段底边的纵向跨度不超过 band（ctx 的像素），段内分层合批、各段依次画。
   * 段是绘制序列里连续的一截，段与段之间的先后不变；符号按纵坐标排序，一段就是一条横带，
   * 合并出的路径只覆盖这条横带，放大后视口之外的整条跳过（全图一层会让每条路径都铺满全图）。
   * gap：判定相交时两包围盒之间至少要空出的距离（ctx 的像素），免得两个符号的抗锯齿边缘落在同一像素里。
   */
  flush(ctx: Pen, band = 64, gap = 2) {
    this.end()
    const gs = this.glyphs
    this.glyphs = []
    for (let i = 0; i < gs.length; ) {
      let j = i + 1
      while (j < gs.length && gs[j].y1 - gs[i].y1 < band) j++
      const chunk = gs.slice(i, j)
      const layer = assignLayers(chunk, gap / 2)
      const byLayer: Glyph[][] = []
      chunk.forEach((g, q) => (byLayer[layer[q]] ??= []).push(g))
      for (const L of byLayer) if (L) drawLayer(ctx, L)
      i = j
    }
  }
}

/** 按绘制次序给每个符号定层：网格索引找先画且相交（包围盒各向外扩 pad）的符号 */
function assignLayers(gs: Glyph[], pad: number) {
  let size = 0
  for (const g of gs) size += Math.max(g.x1 - g.x0, g.y1 - g.y0)
  size = Math.max(1, size / gs.length + 2 * pad)
  const grid = new Map<number, number[]>()
  const layer = new Int32Array(gs.length)
  const seen = new Int32Array(gs.length).fill(-1)
  gs.forEach((g, i) => {
    const x0 = g.x0 - pad
    const y0 = g.y0 - pad
    const x1 = g.x1 + pad
    const y1 = g.y1 + pad
    const cx0 = Math.floor(x0 / size)
    const cy0 = Math.floor(y0 / size)
    const cx1 = Math.floor(x1 / size)
    const cy1 = Math.floor(y1 / size)
    let l = 0
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cx * 65536 + cy
        const list = grid.get(key)
        if (list) {
          for (const j of list) {
            if (seen[j] === i) continue
            seen[j] = i
            const h = gs[j]
            if (layer[j] + 1 > l && h.x0 - pad < x1 && h.x1 + pad > x0 && h.y0 - pad < y1 && h.y1 + pad > y0) l = layer[j] + 1
          }
          list.push(i)
        } else grid.set(key, [i])
      }
    }
    layer[i] = l
  })
  return layer
}

/**
 * 同层符号互不相交，只需保持每个符号自身的笔序：
 * 每一步在各符号的"下一笔"里取样式相同且最多的一组，并成一条路径画掉，直到画完
 */
function drawLayer(ctx: Pen, gs: Glyph[]) {
  const next = new Int32Array(gs.length)
  const heads = new Map<string, number[]>()
  const push = (i: number) => {
    const op = gs[i].ops[next[i]]
    if (!op) return
    const l = heads.get(op.key)
    if (l) l.push(i)
    else heads.set(op.key, [i])
  }
  for (let i = 0; i < gs.length; i++) push(i)
  while (heads.size) {
    let key = ''
    let best: number[] = []
    for (const [k, l] of heads) if (l.length > best.length) (key = k), (best = l)
    heads.delete(key)
    const op = gs[best[0]].ops[next[best[0]]]
    ctx.globalAlpha = op.alpha
    if (op.fill) ctx.fillStyle = op.style
    else {
      ctx.strokeStyle = op.style
      ctx.lineWidth = op.width
    }
    ctx.beginPath()
    for (const i of best) replay(ctx, gs[i].ops[next[i]].cmd)
    if (op.fill) ctx.fill()
    else ctx.stroke()
    for (const i of best) {
      next[i]++
      push(i)
    }
  }
}

function replay(ctx: Pen, c: number[]) {
  for (let i = 0; i < c.length; ) {
    switch (c[i]) {
      case MOVE:
        ctx.moveTo(c[i + 1], c[i + 2])
        i += 3
        break
      case LINE:
        ctx.lineTo(c[i + 1], c[i + 2])
        i += 3
        break
      case QUAD:
        ctx.quadraticCurveTo(c[i + 1], c[i + 2], c[i + 3], c[i + 4])
        i += 5
        break
      default:
        ctx.closePath()
        i += 1
    }
  }
}
