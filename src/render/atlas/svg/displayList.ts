/**
 * 矢量显示列表：纸图的全部绘制指令（路径、文字）+ 样式 + 包围盒。
 * - toSVG()：序列化为 SVG，用于导出
 * - render()：只绘制与视口相交的指令到 Canvas，用于任意倍率的清晰预览
 * 同一份列表，预览与导出完全一致。
 */

export type BBox = [number, number, number, number]
export type Matrix = [number, number, number, number, number, number]

export interface Fill {
  color?: string
  pattern?: string
  gradient?: string
  alpha: number
  rule?: 'evenodd' | 'nonzero'
}

export interface Stroke {
  color: string
  alpha: number
  width: number
  dash?: number[]
  cap?: CanvasLineCap
  join?: CanvasLineJoin
}

export interface PathItem {
  k: 'path'
  d: string
  fill?: Fill
  stroke?: Stroke
  m?: Matrix
  clip?: string
  filter?: string
  opacity: number
  bbox: BBox
  p2d?: Path2D
  /** 画的倍率小于它时不画（缩小时细得看不见的细节：树的投影、暗面） */
  minScale?: number
  /** 注记的符号（城市标记）：与注记一起画在注记层、以这个锚点保持屏幕大小（见 TextItem.g） */
  g?: [number, number]
}

export interface TextItem {
  k: 'text'
  t: string
  x: number
  y: number
  font: string
  align: 'start' | 'middle' | 'end'
  baseline: 'auto' | 'central' | 'hanging' | 'text-after-edge'
  fill?: { color: string; alpha: number }
  stroke?: { color: string; alpha: number; width: number }
  m?: Matrix
  opacity: number
  bbox: BBox
  /**
   * 注记的锚点（段坐标）：查看器里注记保持屏幕大小时，整条注记以它为中心缩放（逐字排布的注记各字共用一个，字距不散）。
   * 缺省是这个字自己的位置
   */
  g?: [number, number]
  /**
   * 沿路径逐字排布的注记（街名、河名）：所在的路径（段坐标）、整条注记的中点与这个字在路径上的弧长位置。
   * 注记保持屏幕大小时，字沿原路径重新定位（离中点的弧长按比例缩短），不是整体缩向一点——注记仍贴着它标的那段路。
   * up：字保持直立、只是排在路径上（中日文山脉名），不随路径转。
   * slide：原位置不在视口里时，整条注记沿路径滑到露出来的那一段（山脉名顺着山脊挪进视口），见 slideAlong
   */
  along?: LabelAlong
  /** 面状注记（海、大陆、片区）标的区域：原位置不在视口里时，挪到区域露出来的那一角（见 LabelArea） */
  area?: LabelArea
  /** 可省略的注记（测深数字这类）：见 LabelOptional */
  optional?: LabelOptional
}

/**
 * 可省略的注记：在查看器里排在其余注记之后，按 rank 从小到大见缝插针，压到已画的就这一帧不画。
 * zoom：屏幕上每页面像素至少这么多 CSS 像素时才参与（放大后才出现的加密层）；大于 0 的只在查看器里出现，导出与整页绘制不含
 */
export interface LabelOptional {
  rank: number
  zoom: number
}

/** 沿路径逐字排布的注记里一个字的位置（见 TextItem.along） */
export interface LabelAlong {
  line: [number, number][]
  c: number
  at: number
  up?: boolean
  slide?: boolean
}

/** 可滑动的沿路径注记：路径，整条注记的半长与字的半径（段坐标） */
interface Curve {
  path: Polyline
  half: number
  r: number
}

/** 注记层一帧里各组共用的状态（见 renderLabels） */
interface LabelFrame {
  scale: number
  /** 露出来的范围（让出边距，挪位、滑动在这里面找地方） */
  v: BBox
  /** 视口（裁剪用） */
  view: BBox
  moved: Map<LabelArea, [number, number] | null>
  slid: Map<[number, number][], number>
  curves: Map<[number, number][], Curve>
  /** 登记一组画了的注记的包围盒 */
  take: (b: BBox) => void
}

/** 一条注记的全部绘制项（见 DisplayList.collectGroups）；fs：其中最小的字号（段坐标） */
interface LabelGroup {
  items: (TextItem | PathItem)[]
  fs: number
  /** 可省略的注记（组里任何一项带 optional 即是）；box：整组包围盒（快速剔除视口外的） */
  optional?: LabelOptional
  box?: BBox
}

/** 区域的位图（段坐标）：格子 (i, j) 覆盖 [x0 + i·cell, x0 + (i+1)·cell) × [y0 + j·cell, …) */
export interface AreaMask {
  x0: number
  y0: number
  cell: number
  w: number
  h: number
  bits: Uint8Array
}
/** 面状注记的区域与注记本身的宽高（段坐标、原大）；同一条注记的各字共用一个对象 */
export interface LabelArea {
  mask: AreaMask
  w: number
  h: number
}

/** 按格子中心取样把区域画成位图（bb 是区域的包围盒） */
export function rasterArea(bb: BBox, cell: number, inside: (x: number, y: number) => boolean): AreaMask {
  const w = Math.max(1, Math.ceil((bb[2] - bb[0]) / cell))
  const h = Math.max(1, Math.ceil((bb[3] - bb[1]) / cell))
  const bits = new Uint8Array(w * h)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) bits[j * w + i] = inside(bb[0] + (i + 0.5) * cell, bb[1] + (j + 0.5) * cell) ? 1 : 0
  return { x0: bb[0], y0: bb[1], cell, w, h, bits }
}

/**
 * 多边形在水平线 y 上的交点横坐标（升序，写进 out）。交点公式与奇偶规则的逐点判定（inPoly、pointInPoly）逐位相同：
 * 点 (x, y) 在多边形内 ⇔ 大于 x 的交点个数为奇数
 */
export function polyCrossings(poly: readonly (readonly [number, number])[], y: number, out: number[]): number[] {
  out.length = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    if (yi > y !== yj > y) out.push(((xj - xi) * (y - yi)) / (yj - yi) + xi)
  }
  return out.sort((a, b) => a - b)
}

/**
 * rasterArea 的多边形版：格子中心换算到多边形坐标（to，两轴同一换算）后在多边形内（奇偶规则）、且 member 成立的格子。
 * 逐行求一次交点再按列扫过去，结果与逐格调用 inPoly 相同；member 只对多边形内的格子求值
 */
export function rasterPoly(
  bb: BBox,
  cell: number,
  poly: readonly (readonly [number, number])[],
  to: (v: number) => number = (v) => v,
  member?: (x: number, y: number) => boolean,
): AreaMask {
  const w = Math.max(1, Math.ceil((bb[2] - bb[0]) / cell))
  const h = Math.max(1, Math.ceil((bb[3] - bb[1]) / cell))
  const bits = new Uint8Array(w * h)
  const xs = new Float64Array(w)
  for (let i = 0; i < w; i++) xs[i] = to(bb[0] + (i + 0.5) * cell)
  const cross: number[] = []
  for (let j = 0; j < h; j++) {
    const y = to(bb[1] + (j + 0.5) * cell)
    polyCrossings(poly, y, cross)
    const n = cross.length
    if (n === 0) continue
    // k：≤ x 的交点个数（xs 随 i 递增）
    let k = 0
    for (let i = 0; i < w; i++) {
      const x = xs[i]
      while (k < n && cross[k] <= x) k++
      if (k === n) break
      if ((n - k) & 1 && (!member || member(x, y))) bits[j * w + i] = 1
    }
  }
  return { x0: bb[0], y0: bb[1], cell, w, h, bits }
}

export type Item = PathItem | TextItem

export interface Segment {
  /** page：整张纸的坐标；map：地图框内坐标（平移 M 并裁剪到地图框） */
  space: 'page' | 'map'
  /** 画在地图框里的图廓件（标题、指北针、比例尺、图例）：整页导出时照画，图框模式下由图廓层另画，地图层跳过 */
  furniture?: boolean
  items: Item[]
}

export interface PatternDef {
  w: number
  h: number
  /** SVG 中 <pattern> 的内部内容 */
  svg: string
  /** Canvas 用的图块 */
  tile: () => CanvasImageSource
}

export interface GradientDef {
  svg: string
  /** 在单位包围盒空间（0..1）里创建渐变 */
  make: (ctx: CanvasRenderingContext2D) => CanvasGradient
}

const num = (v: number) => (Math.round(v * 100) / 100).toString()
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 解析 SVG 路径数据的包围盒（绝对坐标命令 M L H V Q C A Z 与相对 h v） */
export function pathBBox(d: string): BBox {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (x: number, y: number, r = 0) => {
    if (x - r < x0) x0 = x - r
    if (y - r < y0) y0 = y - r
    if (x + r > x1) x1 = x + r
    if (y + r > y1) y1 = y + r
  }
  let cx = 0
  let cy = 0
  // 单遍扫描：命令字母切段，段内按空白/逗号切出数字（大路径可达数 MB，正则+split 太慢）
  const n: number[] = []
  let c = ''
  let tok = -1
  // 数字快速路径：[-]整数[.小数]，尾数 < 2^53 且小数位 ≤ 22 时 M/10^k 正确舍入，与 Number() 逐位相同
  let mant = 0
  let frac = -1
  let neg = false
  let fast = true
  let digits = false
  const L = d.length
  for (let i = 0; i <= L; i++) {
    const ch = i < L ? d.charCodeAt(i) : 0
    const isCmd = i === L || CMD[ch] === 1
    const isSep = ch === 32 || ch === 44 || (ch >= 9 && ch <= 13)
    if (isCmd || isSep) {
      if (tok >= 0) {
        n.push(fast && digits && frac <= 22 ? (neg ? -1 : 1) * (mant / POW10[frac < 0 ? 0 : frac]) : Number(d.slice(tok, i)))
        tok = -1
      }
      if (!isCmd) continue
    } else {
      if (tok < 0) {
        tok = i
        mant = 0
        frac = -1
        neg = false
        fast = true
        digits = false
        if (ch === 45) {
          neg = true
          continue
        }
      }
      if (ch >= 48 && ch <= 57) {
        digits = true
        mant = mant * 10 + (ch - 48)
        if (frac >= 0) frac++
        if (mant > 9007199254740991) fast = false
      } else if (ch === 46 && frac < 0) frac = 0
      else fast = false
      continue
    }
    if (c) flush(c)
    c = i < L ? d[i] : ''
    n.length = 0
  }
  if (x0 === Infinity) return [0, 0, 0, 0]
  return [x0, y0, x1, y1]

  function flush(c: string) {
    switch (c) {
      case 'M':
      case 'L':
      case 'T':
        for (let i = 0; i + 1 < n.length; i += 2) add((cx = n[i]), (cy = n[i + 1]))
        break
      case 'H':
        for (const v of n) add((cx = v), cy)
        break
      case 'V':
        for (const v of n) add(cx, (cy = v))
        break
      case 'h':
        for (const v of n) add((cx += v), cy)
        break
      case 'v':
        for (const v of n) add(cx, (cy += v))
        break
      case 'Q':
        for (let i = 0; i + 3 < n.length; i += 4) {
          add(n[i], n[i + 1])
          add((cx = n[i + 2]), (cy = n[i + 3]))
        }
        break
      case 'C':
        for (let i = 0; i + 5 < n.length; i += 6) {
          add(n[i], n[i + 1])
          add(n[i + 2], n[i + 3])
          add((cx = n[i + 4]), (cy = n[i + 5]))
        }
        break
      case 'A':
        for (let i = 0; i + 6 < n.length; i += 7) {
          const r = Math.max(n[i], n[i + 1])
          add(cx, cy, r)
          add((cx = n[i + 5]), (cy = n[i + 6]), r)
        }
        break
    }
  }
}
const CMD = new Uint8Array(128)
for (const ch of 'MLHVQCATZmlhvz') CMD[ch.charCodeAt(0)] = 1
const POW10 = Array.from({ length: 23 }, (_, k) => Number('1e' + k))

export function transformBBox(b: BBox, m?: Matrix): BBox {
  if (!m) return b
  const pts = [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[0], b[3]],
    [b[2], b[3]],
  ]
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    const X = m[0] * x + m[2] * y + m[4]
    const Y = m[1] * x + m[3] * y + m[5]
    x0 = Math.min(x0, X)
    y0 = Math.min(y0, Y)
    x1 = Math.max(x1, X)
    y1 = Math.max(y1, Y)
  }
  return [x0, y0, x1, y1]
}

function expand(b: BBox, r: number): BBox {
  return [b[0] - r, b[1] - r, b[2] + r, b[3] + r]
}

export class DisplayList {
  segments: Segment[] = []
  clips = new Map<string, { d: string; m?: Matrix; rule: CanvasFillRule; p2d?: Path2D }>()
  patterns = new Map<string, PatternDef>()
  gradients = new Map<string, GradientDef>()
  filters = new Map<string, string>()
  head = ''
  /** 为真时新写入的指令归入图廓件段（见 Segment.furniture） */
  furniture = false
  /** 注记按设计字号显示时的倍率（每页面像素多少 CSS 像素）：地图注记的页面字号 = 设计字号 ÷ labelK（见 labelSize） */
  labelK = 1
  private patternCache = new Map<string, CanvasPattern>()
  /** 沿路径可滑动的注记：路径的累计弧长、整条注记的半长与字的半径（段坐标，首次画注记时统计） */
  private curves: Map<[number, number][], Curve> | null = null

  constructor(
    readonly width: number,
    readonly height: number,
    readonly M: number,
    readonly MW: number,
    readonly MH: number,
  ) {}

  segment(space: 'page' | 'map') {
    const last = this.segments[this.segments.length - 1]
    if (last && last.space === space && !!last.furniture === this.furniture) return last
    const s: Segment = this.furniture ? { space, furniture: true, items: [] } : { space, items: [] }
    this.segments.push(s)
    return s
  }

  /** bbox：调用方已知的路径包围盒（大批树冠、房屋拼成的长路径省掉逐字解析）；不给就从 d 里解析 */
  path(space: 'page' | 'map', d: string, o: Omit<PathItem, 'k' | 'd' | 'bbox' | 'opacity'> & { opacity?: number }, bbox?: BBox) {
    const item = DisplayList.item(d, o, bbox)
    if (item) this.segment(space).items.push(item)
    return item
  }

  /** 只生成绘制项、不放进列表（调用方记下来跨帧复用，见 path） */
  static item(d: string, o: Omit<PathItem, 'k' | 'd' | 'bbox' | 'opacity'> & { opacity?: number }, bbox?: BBox): PathItem | undefined {
    if (!d) return
    const bb = transformBBox(bbox ?? pathBBox(d), o.m)
    return { k: 'path', d, opacity: 1, ...o, bbox: expand(bb, (o.stroke?.width ?? 0) * 2 + 1) }
  }

  text(space: 'page' | 'map', item: Omit<TextItem, 'k'>) {
    // bbox 与 path 一样按局部坐标给出：带变换（沿路逐字排布的注记）时换算到图面，视口裁剪才不会误删
    this.segment(space).items.push({ k: 'text', ...item, bbox: transformBBox(item.bbox, item.m) })
  }

  // —————————————————— SVG ——————————————————
  toSVG(): string {
    const out: string[] = []
    const defs: string[] = []
    for (const [id, c] of this.clips)
      defs.push(`<clipPath id="${id}"><path d="${c.d}" clip-rule="${c.rule}"${c.m ? ` transform="matrix(${c.m.map(num).join(' ')})"` : ''}/></clipPath>`)
    for (const [id, p] of this.patterns) defs.push(`<pattern id="${id}" width="${num(p.w)}" height="${num(p.h)}" patternUnits="userSpaceOnUse">${p.svg}</pattern>`)
    for (const g of this.gradients.values()) defs.push(g.svg)
    for (const f of this.filters.values()) defs.push(f)
    defs.push(`<clipPath id="mapclip"><rect x="0" y="0" width="${this.MW}" height="${this.MH}"/></clipPath>`)
    // 相邻的同空间段（图廓件段与地图段）合成一组
    this.segments.forEach((seg, i) => {
      if (seg.space === 'map' && this.segments[i - 1]?.space !== 'map') out.push(`<g transform="translate(${this.M} ${this.M})" clip-path="url(#mapclip)">`)
      for (const it of seg.items) if (it.k === 'path' || !it.optional?.zoom) out.push(it.k === 'path' ? svgPath(it) : svgText(it))
      if (seg.space === 'map' && this.segments[i + 1]?.space !== 'map') out.push('</g>')
    })
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">` +
      this.head +
      `<defs>${defs.join('')}</defs>` +
      out.join('\n') +
      `</svg>`
    )
  }

  // —————————————————— Canvas ——————————————————
  /**
   * 绘制到 Canvas：scale 为页面像素 → 画布像素的缩放，(ox, oy) 为页面原点在画布上的位置。
   * 只绘制包围盒与画布可见区相交的指令；only 给出时只画这一层（图框模式下地图与图廓分开画）。
   * mapText 为假时不画地图里的注记（查看器把它们另画在注记层上，见 renderLabels）。
   */
  render(ctx: CanvasRenderingContext2D, scale: number, ox: number, oy: number, only?: 'page' | 'map', mapText = true) {
    const cw = ctx.canvas.width
    const ch = ctx.canvas.height
    // 可见区（页面坐标）
    const vx0 = -ox / scale
    const vy0 = -oy / scale
    const vx1 = (cw - ox) / scale
    const vy1 = (ch - oy) / scale
    ctx.save()
    ctx.setTransform(scale, 0, 0, scale, ox, oy)
    this.resetText()
    for (const seg of this.segments) {
      if (only && seg.space !== only) continue
      if (only === 'map' && seg.furniture) continue
      const dx = seg.space === 'map' ? this.M : 0
      ctx.save()
      if (seg.space === 'map') {
        ctx.translate(this.M, this.M)
        ctx.beginPath()
        ctx.rect(0, 0, this.MW, this.MH)
        ctx.clip()
      }
      const x0 = vx0 - dx
      const y0 = vy0 - dx
      const x1 = vx1 - dx
      const y1 = vy1 - dx
      // 地图里的注记（字与带锚点的符号）由注记层画
      const overlay = !mapText && seg.space === 'map' && !seg.furniture
      for (const it of seg.items) {
        const b = it.bbox
        if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue
        if (overlay && (it.k === 'text' || it.g)) continue
        if (it.k === 'text') {
          if (!it.optional?.zoom) this.drawText(ctx, it)
        } else if (scale >= (it.minScale ?? 0)) {
          // 铺满全图的长路径：只画与视口相交的格子（整张画时格子太碎，直接画整条）
          const parts = it.d.length > SPLIT_LEN && (x1 - x0) * (y1 - y0) < (b[2] - b[0]) * (b[3] - b[1]) * 0.5 ? partsOf(it) : null
          if (!parts) this.drawPath(ctx, it)
          else {
            // 可见的格子合成一条路径画一次：与整条路径的填充、描边完全相同（相邻子路径之间没有接缝，半透明的不会重叠加深）
            const p2d = new Path2D()
            let n = 0
            for (const q of parts) {
              const c = q.bbox
              if (c[2] < x0 || c[0] > x1 || c[3] < y0 || c[1] > y1) continue
              p2d.addPath((q.p2d ??= new Path2D(q.d)))
              n++
            }
            if (n) this.drawPath(ctx, { ...it, p2d })
          }
        }
      }
      ctx.restore()
      this.resetText()
    }
    ctx.restore()
  }

  /**
   * 只画地图里的注记（连同带锚点的符号），每条注记以锚点为中心再缩放 s 倍（相对地图；查看器按字号体系算出，见 AtlasViewer.drawLabels）。
   * 参数与 render 相同（整张页面坐标 → 画布）。
   * s ≤ 1 时注记比排布时小，彼此不会压到；s > 1 时按排布时的优先顺序占位，压到已画注记的这一帧不画（放大地图后再出现）。
   * minPx：屏幕上的最小字号（画布像素）；缩放后仍低于它的注记（附注、测深数字）单独放大到它，同样不压已画的注记。
   */
  renderLabels(ctx: CanvasRenderingContext2D, scale: number, ox: number, oy: number, s: number, vis?: BBox, minPx = 0, dpr = 1) {
    const cw = ctx.canvas.width
    const ch = ctx.canvas.height
    const x0 = -ox / scale - this.M
    const y0 = -oy / scale - this.M
    const x1 = (cw - ox) / scale - this.M
    const y1 = (ch - oy) / scale - this.M
    // 真正露出来的范围（段坐标）：图框模式下只有图框内框看得见；四周让出 10 个屏幕像素，挪过来的注记不贴边
    const pad = 10 * (cw / Math.max(1, ctx.canvas.clientWidth || cw)) / scale
    const v: BBox = vis
      ? [(vis[0] - ox) / scale - this.M + pad, (vis[1] - oy) / scale - this.M + pad, (vis[2] - ox) / scale - this.M - pad, (vis[3] - oy) / scale - this.M - pad]
      : [x0 + pad, y0 + pad, x1 - pad, y1 - pad]
    // 面状注记这一帧挪多少（同一条注记算一次）；null：露出来的一角放不下，照原位置画
    const frame: LabelFrame = {
      scale,
      v,
      view: [x0, y0, x1, y1],
      // 面状注记这一帧挪多少（同一条注记算一次）；null：露出来的一角放不下，照原位置画
      moved: new Map(),
      // 沿路径滑动的注记这一帧的中点弧长（同一条注记算一次）
      slid: new Map(),
      curves: this.curves ?? (this.curves = this.collectCurves()),
      take: () => {},
    }
    ctx.save()
    ctx.setTransform(scale, 0, 0, scale, ox, oy)
    ctx.translate(this.M, this.M)
    ctx.beginPath()
    ctx.rect(0, 0, this.MW, this.MH)
    ctx.clip()
    this.resetText()
    // 每条注记（同一锚点的字、晕边与符号）一组，整组一起缩放、一起占位
    const groups = this.groups ?? (this.groups = this.collectGroups())
    // 已画注记的包围盒按视口的 32 × 32 网格登记，查重叠只看相交的格子；跨格太多的大框另放一处，每次都查
    const cell = Math.max(x1 - x0, y1 - y0) / 32 || 1
    const grid = new Map<number, BBox[]>()
    const big: BBox[] = []
    const overlap = (b: BBox, q: BBox) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]
    const cellsOf = (b: BBox) => {
      const i0 = Math.floor((b[0] - x0) / cell)
      const i1 = Math.floor((b[2] - x0) / cell)
      const j0 = Math.floor((b[1] - y0) / cell)
      const j1 = Math.floor((b[3] - y0) / cell)
      if (i1 - i0 > 64 || j1 - j0 > 64) return null
      const keys: number[] = []
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) keys.push(j * 4096 + i)
      return keys
    }
    frame.take = (b) => {
      const keys = cellsOf(b)
      if (!keys) big.push(b)
      else for (const k of keys) (grid.get(k) ?? grid.set(k, []).get(k)!).push(b)
    }
    const hits = (b: BBox) => {
      if (big.some((q) => overlap(b, q))) return true
      const keys = cellsOf(b)
      if (!keys) return [...grid.values()].some((bs) => bs.some((q) => overlap(b, q)))
      return keys.some((k) => grid.get(k)?.some((q) => overlap(b, q)))
    }
    // 各组的缩放：统一的 s，缩放后仍低于下限的单独放大到下限
    const scaleOf = (g: LabelGroup) => (minPx > 0 && g.fs * scale * s < minPx * 0.999 ? minPx / (g.fs * scale) : s)
    // 不比排布时大的组彼此压不到，直接画；其余按排布时的优先顺序占位（地名先占，附注这类小字后排）
    const grown: [LabelGroup, number][] = []
    for (const g of groups) {
      if (g.optional) continue
      const gs = scaleOf(g)
      if (gs > 1.0001) grown.push([g, gs])
      else this.drawGroup(ctx, g, gs, frame)
    }
    for (const [g, gs] of grown) this.drawGroup(ctx, g, gs, frame, hits)
    // 可省略的注记最后按 rank 占位：还没放大到它那一层的、整组在视口外的先跳过（这类注记数量多，逐组细算太费）
    const css = scale / dpr
    for (const g of this.optionals!) {
      if (css < g.optional!.zoom) continue
      const gs = scaleOf(g)
      const b = g.box!
      const pad = Math.max(b[2] - b[0], b[3] - b[1]) * Math.max(1, gs)
      if (b[2] + pad < x0 || b[0] - pad > x1 || b[3] + pad < y0 || b[1] - pad > y1) continue
      this.drawGroup(ctx, g, gs, frame, hits)
    }
    ctx.restore()
  }

  /** 注记分组（按锚点；沿路径的按路径；都没有的各自一组），顺序即排布时的优先顺序 */
  private groups: LabelGroup[] | null = null
  /** 可省略的组，按 rank 从小到大 */
  private optionals: LabelGroup[] | null = null
  private collectGroups(): LabelGroup[] {
    const out: LabelGroup[] = []
    const byKey = new Map<unknown, LabelGroup>()
    for (const seg of this.segments) {
      if (seg.space !== 'map' || seg.furniture) continue
      for (const it of seg.items) {
        if (it.k !== 'text' && !it.g) continue
        const key = it.k === 'text' && it.along ? it.along.line : it.g ? `${it.g[0]},${it.g[1]}` : it
        let g = byKey.get(key)
        if (!g) {
          byKey.set(key, (g = { items: [], fs: Infinity }))
          out.push(g)
        }
        g.items.push(it)
        const b = it.bbox
        g.box = g.box ? [Math.min(g.box[0], b[0]), Math.min(g.box[1], b[1]), Math.max(g.box[2], b[2]), Math.max(g.box[3], b[3])] : [b[0], b[1], b[2], b[3]]
        if (it.k === 'text') {
          g.fs = Math.min(g.fs, parseFloat(/([\d.]+)px/.exec(it.font)?.[1] ?? '12'))
          if (it.optional) g.optional = it.optional
        }
      }
    }
    for (const g of out) if (!Number.isFinite(g.fs)) g.fs = 12
    this.optionals = out.filter((g) => g.optional).sort((a, b) => a.optional!.rank - b.optional!.rank)
    return out
  }

  /**
   * 画一组注记：整组以锚点为中心缩放 s 倍（沿路径的字沿路径重排，面状注记挪进露出来的一角）。
   * 算出整组的紧包围盒登记到 taken；给了 hits 时先检查，压到已画的注记就整组不画
   */
  private drawGroup(ctx: CanvasRenderingContext2D, g: LabelGroup, s: number, frame: LabelFrame, hits?: (b: BBox) => boolean) {
    const { v, scale, moved, slid, curves } = frame
    const [x0, y0, x1, y1] = frame.view
    const plan: (() => void)[] = []
    const box: BBox = [Infinity, Infinity, -Infinity, -Infinity]
    const grow = (a: number, b: number, c: number, d: number) => {
      box[0] = Math.min(box[0], a)
      box[1] = Math.min(box[1], b)
      box[2] = Math.max(box[2], c)
      box[3] = Math.max(box[3], d)
    }
    const fs = g.fs
    for (const it of g.items) {
      const b = it.bbox
      if (it.k !== 'text') {
        // 注记的符号（带锚点的路径）
        const [gx, gy] = it.g!
        const bb: BBox = [gx + (b[0] - gx) * s, gy + (b[1] - gy) * s, gx + (b[2] - gx) * s, gy + (b[3] - gy) * s]
        grow(...bb)
        if (bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1) continue
        plan.push(() => {
          ctx.save()
          ctx.translate(gx, gy)
          ctx.scale(s, s)
          ctx.translate(-gx, -gy)
          this.drawPath(ctx, it)
          ctx.restore()
        })
        continue
      }
      // 紧包围盒的半宽、半高（记录时的包围盒左右各留了几像素、上下留了一个多字高）
      const hw0 = Math.max(fs * 0.3, (b[2] - b[0]) / 2 - 3)
      const hh0 = Math.max(fs * 0.3, (b[3] - b[1]) / 2 - fs * 0.65)
      if (it.along && (s !== 1 || it.along.slide)) {
        // 沿路径的字挪到新位置再裁剪（包围盒按字自己的大小缩放）
        const a = it.along
        let mid = a.c
        if (a.slide) {
          let m = slid.get(a.line)
          if (m === undefined) {
            const cv = curves.get(a.line)!
            slid.set(a.line, (m = slideAlong(cv.path, a.c, cv.half * s, cv.r * s, v)))
          }
          mid = m
        }
        const q = polylineOf(a.line).at(mid + (a.at - a.c) * s)
        const p = q.p
        const angle = a.up ? 0 : q.angle
        const hw = ((b[2] - b[0]) / 2) * s
        const hh = ((b[3] - b[1]) / 2) * s
        const r = fs * 0.55 * s
        grow(p[0] - r, p[1] - r, p[0] + r, p[1] + r)
        if (p[0] + hw < x0 || p[0] - hw > x1 || p[1] + hh < y0 || p[1] - hh > y1) continue
        const c = Math.cos(angle) * s
        const sn = Math.sin(angle) * s
        plan.push(() => this.drawText(ctx, { ...it, m: [c, sn, -sn, c, p[0], p[1]] }))
        continue
      }
      const [gx, gy] = it.g ?? anchorOf(it)
      let dx = 0
      let dy = 0
      if (it.area) {
        const key = it.area
        let d = moved.get(key)
        if (d === undefined) moved.set(key, (d = placeLabel(key, gx, gy, s, v, scale)))
        if (d) [dx, dy] = d
      }
      const cx = (b[0] + b[2]) / 2
      const cy = (b[1] + b[3]) / 2
      grow(gx + dx + (cx - hw0 - gx) * s, gy + dy + (cy - hh0 - gy) * s, gx + dx + (cx + hw0 - gx) * s, gy + dy + (cy + hh0 - gy) * s)
      // 包围盒同样以锚点为中心缩放（挪了的一并平移）后再裁剪
      if (gx + dx + (b[2] - gx) * s < x0 || gx + dx + (b[0] - gx) * s > x1 || gy + dy + (b[3] - gy) * s < y0 || gy + dy + (b[1] - gy) * s > y1) continue
      if (s === 1 && !dx && !dy) {
        plan.push(() => this.drawText(ctx, it))
        continue
      }
      plan.push(() =>
        this.saved(ctx, () => {
          ctx.translate(dx, dy)
          ctx.translate(gx, gy)
          ctx.scale(s, s)
          ctx.translate(-gx, -gy)
          this.drawText(ctx, it)
        }),
      )
    }
    if (!plan.length) return
    if (hits && hits(box)) return
    frame.take(box)
    for (const f of plan) f()
  }

  private collectCurves() {
    const out = new Map<[number, number][], Curve>()
    for (const seg of this.segments)
      for (const it of seg.items) {
        if (it.k !== 'text' || !it.along?.slide) continue
        const a = it.along
        let cv = out.get(a.line)
        if (!cv) out.set(a.line, (cv = { path: polylineOf(a.line), half: 0, r: 0 }))
        const b = it.bbox
        cv.half = Math.max(cv.half, Math.abs(a.at - a.c))
        cv.r = Math.max(cv.r, (b[2] - b[0]) / 2, (b[3] - b[1]) / 2)
      }
    return out
  }

  private drawPath(ctx: CanvasRenderingContext2D, it: PathItem) {
    if (!it.p2d) it.p2d = new Path2D(it.d)
    ctx.save()
    if (it.clip) {
      const c = this.clips.get(it.clip)
      if (c) {
        if (!c.p2d) c.p2d = new Path2D(c.d)
        if (c.m) ctx.transform(...c.m)
        ctx.clip(c.p2d, c.rule)
        if (c.m) {
          const inv = new DOMMatrix(c.m).inverse()
          ctx.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f)
        }
      }
    }
    if (it.m) ctx.transform(...it.m)
    const f = it.fill
    if (f) {
      ctx.globalAlpha = it.opacity * f.alpha
      if (f.gradient) {
        const g = this.gradients.get(f.gradient)
        if (g) {
          const b = pathBBox(it.d)
          ctx.save()
          ctx.clip(it.p2d, f.rule ?? 'nonzero')
          ctx.translate(b[0], b[1])
          ctx.scale(b[2] - b[0], b[3] - b[1])
          ctx.fillStyle = g.make(ctx)
          ctx.fillRect(0, 0, 1, 1)
          ctx.restore()
        }
      } else {
        if (f.pattern) {
          const p = this.canvasPattern(ctx, f.pattern)
          if (p) ctx.fillStyle = p
        } else ctx.fillStyle = f.color!
        ctx.fill(it.p2d, f.rule ?? 'nonzero')
      }
    }
    const s = it.stroke
    if (s) {
      ctx.globalAlpha = it.opacity * s.alpha
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.lineCap = s.cap ?? 'butt'
      ctx.lineJoin = s.join ?? 'miter'
      ctx.setLineDash(s.dash ?? [])
      ctx.stroke(it.p2d)
    }
    ctx.restore()
  }

  /**
   * 画布上当前的字体、对齐、基线（drawText 只在变了时才设，赋值要解析字体串，逐字设很慢）。
   * null：不知道（每一遍绘制开头、以及包着 drawText 的 save/restore 之后按快照复原）
   */
  private tf: string | null = null
  private ta: CanvasTextAlign | null = null
  private tb: CanvasTextBaseline | null = null
  private resetText() {
    this.tf = this.ta = this.tb = null
  }

  /** 在 save/restore 里画 f：restore 把画布的字体状态复原到 save 之前，缓存也一样复原 */
  private saved(ctx: CanvasRenderingContext2D, f: () => void) {
    const { tf, ta, tb } = this
    ctx.save()
    f()
    ctx.restore()
    this.tf = tf
    this.ta = ta
    this.tb = tb
  }

  /** 画一条字。没有变换矩阵时不 save/restore：设到的状态都是每条字自己要设的，整遍绘制外面有 save/restore 兜着 */
  private drawText(ctx: CanvasRenderingContext2D, it: TextItem) {
    if (it.m) {
      const m = it.m
      this.saved(ctx, () => {
        ctx.transform(...m)
        this.paintText(ctx, it)
      })
    } else this.paintText(ctx, it)
  }

  private paintText(ctx: CanvasRenderingContext2D, it: TextItem) {
    if (this.tf !== it.font) ctx.font = this.tf = it.font
    const align: CanvasTextAlign = it.align === 'middle' ? 'center' : it.align === 'end' ? 'right' : 'left'
    if (this.ta !== align) ctx.textAlign = this.ta = align
    const base: CanvasTextBaseline = it.baseline === 'central' ? 'middle' : it.baseline === 'hanging' ? 'top' : it.baseline === 'text-after-edge' ? 'bottom' : 'alphabetic'
    if (this.tb !== base) ctx.textBaseline = this.tb = base
    if (it.stroke) {
      ctx.globalAlpha = it.opacity * it.stroke.alpha
      ctx.strokeStyle = it.stroke.color
      ctx.lineWidth = it.stroke.width
      ctx.lineJoin = 'round'
      ctx.strokeText(it.t, it.x, it.y)
    }
    if (it.fill) {
      ctx.globalAlpha = it.opacity * it.fill.alpha
      ctx.fillStyle = it.fill.color
      ctx.fillText(it.t, it.x, it.y)
    }
  }

  private canvasPattern(ctx: CanvasRenderingContext2D, id: string) {
    let p = this.patternCache.get(id)
    if (p) return p
    const def = this.patterns.get(id)
    if (!def) return null
    const tile = def.tile()
    p = ctx.createPattern(tile, 'repeat') ?? undefined
    if (!p) return null
    const tw = (tile as HTMLCanvasElement).width
    const th = (tile as HTMLCanvasElement).height
    p.setTransform(new DOMMatrix().scale(def.w / tw, def.h / th))
    this.patternCache.set(id, p)
    return p
  }
}

/**
 * 超长路径的空间切分（只用于 Canvas 绘制）：房屋、树冠、阴影、晕渲短线、等高线这类图层，
 * 同一画法的成千上万个子路径被拼成一整条路径。放大后视口只露出一角，整条路径仍要全部处理，视口裁剪对它无效。
 * 按子路径的中心把它们分进 SPLIT_CELL 见方的格子，绘制时把与视口相交的格子合成一条路径画一次。
 * 奇偶填充（靠同一路径里的子路径挖洞）、渐变（按整条路径的包围盒铺色）、带裁剪的不切。
 * 切分结果按路径长度缓存（绘制记录器会往最后一条路径后面追加，长度变了就重切）
 */
const SPLIT_LEN = 20000
const SPLIT_CELL = 96
const partCache = new WeakMap<PathItem, { len: number; parts: PathItem[] | null }>()
function partsOf(it: PathItem): PathItem[] | null {
  const hit = partCache.get(it)
  if (hit && hit.len === it.d.length) return hit.parts
  const parts = splitPath(it)
  partCache.set(it, { len: it.d.length, parts })
  return parts
}
function splitPath(it: PathItem): PathItem[] | null {
  const d = it.d
  if (it.fill?.rule === 'evenodd' || it.fill?.gradient || it.clip || d.includes('m')) return null
  // 子路径从每个 M 开始（除 h、v、l 这几个相对于当前点的命令外都是绝对坐标，子路径彼此独立）
  const starts: number[] = []
  for (let i = d.indexOf('M'); i >= 0; i = d.indexOf('M', i + 1)) starts.push(i)
  if (starts.length < 2) return null
  const cells = new Map<string, { d: string[]; bb: BBox }>()
  for (let j = 0; j < starts.length; j++) {
    const sub = d.slice(starts[j], j + 1 < starts.length ? starts[j + 1] : d.length)
    const b = pathBBox(sub)
    const key = `${Math.floor((b[0] + b[2]) / 2 / SPLIT_CELL)},${Math.floor((b[1] + b[3]) / 2 / SPLIT_CELL)}`
    const c = cells.get(key)
    if (!c) cells.set(key, { d: [sub], bb: b })
    else {
      c.d.push(sub)
      c.bb = [Math.min(c.bb[0], b[0]), Math.min(c.bb[1], b[1]), Math.max(c.bb[2], b[2]), Math.max(c.bb[3], b[3])]
    }
  }
  if (cells.size < 2) return null
  const r = (it.stroke?.width ?? 0) * 2 + 1
  return [...cells.values()].map((c) => {
    const bb = transformBBox(c.bb, it.m)
    return { ...it, d: c.d.join(''), bbox: expand(bb, r), p2d: undefined }
  })
}

/** 面状注记上次挪到的位置（段坐标）：还放得下就不动，拖动平移时注记不跟着视口乱跳 */
const lastSpot = new WeakMap<LabelArea, [number, number]>()

/** 以 (x, y) 为中心、半宽 hw 半高 hh 的框整个在 v 里、盖住的位图格子都在区域里 */
function fits(m: AreaMask, x: number, y: number, hw: number, hh: number, v: BBox) {
  if (x - hw < v[0] || x + hw > v[2] || y - hh < v[1] || y + hh > v[3]) return false
  const i0 = Math.floor((x - hw - m.x0) / m.cell)
  const i1 = Math.floor((x + hw - m.x0) / m.cell)
  const j0 = Math.floor((y - hh - m.y0) / m.cell)
  const j1 = Math.floor((y + hh - m.y0) / m.cell)
  if (i0 < 0 || j0 < 0 || i1 >= m.w || j1 >= m.h) return false
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!m.bits[j * m.w + i]) return false
  return true
}

/**
 * 面状注记在这一帧的平移：取"整条放得下"（整条在 v 里、盖住的位图格子都在区域里）的位置里离原位置最近的那个。
 * - 原位置放得下就不动；只被视口挡住时把原位置夹进视口——平移时注记顺着视口边连续滑动，原位置回到视口里也连续滑回去
 * - 夹进来的位置被区域挡住（那一段海太窄、片区拐了弯）才去附近找最近的放得下的点，这时才可能跳；
 *   上一帧的位置仍放得下、又不比新找的远出太多时留在原地，免得来回跳
 * 露出来的部分哪里都放不下时返回 null（照原位置画，露多少算多少）
 */
function placeLabel(A: LabelArea, gx: number, gy: number, s: number, v: BBox, scale: number): [number, number] | null {
  const hw = (A.w * s) / 2
  const hh = (A.h * s) / 2
  const m = A.mask
  // 原位置整条露着：不动（排版时定好的位置，不再按区域检查——片区名常比片区还宽）
  if (gx - hw >= v[0] && gx + hw <= v[2] && gy - hh >= v[1] && gy + hh <= v[3]) return remember(A, gx, gy, gx, gy)
  if (v[2] - v[0] < hw * 2 || v[3] - v[1] < hh * 2) return forget(A)
  // 区域里最宽敞处也放不下、区域根本不在视口里：不必找
  const room = roomOf(m)
  if (room.max * m.cell < Math.min(hw, hh)) return forget(A)
  const o = room.box
  if (o[2] < v[0] || o[0] > v[2] || o[3] < v[1] || o[1] > v[3]) return forget(A)
  const cx = Math.min(v[2] - hw, Math.max(v[0] + hw, gx))
  const cy = Math.min(v[3] - hh, Math.max(v[1] + hh, gy))
  if (fits(m, cx, cy, hw, hh, v)) return remember(A, cx, cy, gx, gy)
  const found = nearestFit(m, cx, cy, hw, hh, v, scale)
  if (!found) return forget(A)
  const prev = lastSpot.get(A)
  if (prev && fits(m, prev[0], prev[1], hw, hh, v) && Math.hypot(prev[0] - cx, prev[1] - cy) <= Math.hypot(found[0] - cx, found[1] - cy) + 40 / scale)
    return [prev[0] - gx, prev[1] - gy]
  return remember(A, found[0], found[1], gx, gy)
}
function remember(A: LabelArea, x: number, y: number, gx: number, gy: number): [number, number] {
  lastSpot.set(A, [x, y])
  return [x - gx, y - gy]
}
function forget(A: LabelArea) {
  lastSpot.delete(A)
  return null
}

/**
 * 离 (cx, cy) 最近的放得下的点：先按粗格（格子钉在段坐标上，半个字高、至少 16 个屏幕像素）一圈圈往外找，
 * 找到后在它周围按 3 个屏幕像素的细格再找一遍最近的
 */
function nearestFit(m: AreaMask, cx: number, cy: number, hw: number, hh: number, v: BBox, scale: number): [number, number] | null {
  const C = Math.max(hh, 16 / scale)
  // 以一点为中心放得下，那一点离区域外至少有半宽、半高里较小的那个（距离场先筛，省掉多数 fits）
  const room = roomOf(m)
  const need = Math.min(hw, hh) / m.cell - 1
  const roomy = (x: number, y: number) => {
    const i = Math.floor((x - m.x0) / m.cell)
    const j = Math.floor((y - m.y0) / m.cell)
    return i >= 0 && j >= 0 && i < m.w && j < m.h && room.d[j * m.w + i] >= need
  }
  const i0 = Math.round(cx / C)
  const j0 = Math.round(cy / C)
  // 最远找到视口与区域（实际占据的范围）交集的对角
  const o = room.box
  const ix0 = Math.max(v[0], o[0])
  const iy0 = Math.max(v[1], o[1])
  const ix1 = Math.min(v[2], o[2])
  const iy1 = Math.min(v[3], o[3])
  if (ix1 - ix0 < hw * 2 || iy1 - iy0 < hh * 2) return null
  // 最多找 48 圈：再远的就是另一处了，跳过去反而突兀
  const R = Math.min(48, Math.ceil(Math.max(Math.abs(ix0 - cx), Math.abs(ix1 - cx), Math.abs(iy0 - cy), Math.abs(iy1 - cy)) / C) + 1)
  let best: [number, number] | null = null
  let bd = Infinity
  for (let r = 0; r <= R; r++) {
    // 这一圈最近也有 (r - 1)·C 远：已经找到更近的就不用再往外
    if (best && (r - 1) * C > bd) break
    for (let j = j0 - r; j <= j0 + r; j++)
      for (let i = i0 - r; i <= i0 + r; i++) {
        if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue
        const x = i * C
        const y = j * C
        const d = Math.hypot(x - cx, y - cy)
        if (d < bd && roomy(x, y) && fits(m, x, y, hw, hh, v)) {
          bd = d
          best = [x, y]
        }
      }
  }
  if (!best) return null
  // 细找：粗格点周围一格之内
  const F = 3 / scale
  const [bx, by] = best
  for (let y = by - C; y <= by + C; y += F)
    for (let x = bx - C; x <= bx + C; x += F) {
      const d = Math.hypot(x - cx, y - cy)
      if (d < bd && roomy(x, y) && fits(m, x, y, hw, hh, v)) {
        bd = d
        best = [x, y]
      }
    }
  return best
}

/** 区域位图的距离场（格，离区域外多远，8 邻域倒角距离）、最大值与区域实际占据的范围（段坐标）：每个区域算一次 */
const rooms = new WeakMap<AreaMask, { d: Float32Array; max: number; box: BBox }>()
function roomOf(m: AreaMask) {
  let r = rooms.get(m)
  if (r) return r
  const { w, h, bits } = m
  const d = new Float32Array(w * h)
  const D = Math.SQRT2
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i
      if (!bits[k]) continue
      let x = Math.min(i, j) + 1
      if (i > 0) x = Math.min(x, d[k - 1] + 1)
      if (j > 0) {
        x = Math.min(x, d[k - w] + 1)
        if (i > 0) x = Math.min(x, d[k - w - 1] + D)
        if (i + 1 < w) x = Math.min(x, d[k - w + 1] + D)
      }
      d[k] = x
    }
  let max = 0
  let bi0 = w
  let bj0 = h
  let bi1 = -1
  let bj1 = -1
  for (let j = h - 1; j >= 0; j--)
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i
      if (!bits[k]) continue
      if (i < bi0) bi0 = i
      if (i > bi1) bi1 = i
      if (j < bj0) bj0 = j
      if (j > bj1) bj1 = j
      let x = Math.min(d[k], w - i, h - j)
      if (i + 1 < w) x = Math.min(x, d[k + 1] + 1)
      if (j + 1 < h) {
        x = Math.min(x, d[k + w] + 1)
        if (i + 1 < w) x = Math.min(x, d[k + w + 1] + D)
        if (i > 0) x = Math.min(x, d[k + w - 1] + D)
      }
      d[k] = x
      if (x > max) max = x
    }
  const c = m.cell
  const box: BBox = bi1 < 0 ? [0, 0, -1, -1] : [m.x0 + bi0 * c, m.y0 + bj0 * c, m.x0 + (bi1 + 1) * c, m.y0 + (bj1 + 1) * c]
  rooms.set(m, (r = { d, max, box }))
  return r
}

/**
 * 沿路径滑动的注记这一帧的中点弧长：路径上整段 [c' − half, c' + half] 都在视口里（字的半径 r 让出边）的 c' 中离原来的 c 最近的那个。
 * 原位置放得下就不动；平移时连续滑动，只有露出来的那段路径断开或放不下时才跳。哪里都放不下时照原位置
 */
function slideAlong(path: Polyline, c: number, half: number, r: number, v: BBox): number {
  const L = path.length
  if (2 * half >= L) return c
  const n = Math.min(600, Math.max(40, Math.ceil(L / Math.max(1, half / 8))))
  const ds = L / n
  const x0 = v[0] + r
  const y0 = v[1] + r
  const x1 = v[2] - r
  const y1 = v[3] - r
  let best = c
  let bd = Infinity
  let run = -1
  for (let k = 0; k <= n + 1; k++) {
    let ok = false
    if (k <= n) {
      const [px, py] = path.at(k * ds).p
      ok = px >= x0 && px <= x1 && py >= y0 && py <= y1
    }
    if (ok && run < 0) run = k
    if (!ok && run >= 0) {
      // 一段连续可见的路径 [run, k − 1]：中点可取 [起点 + half, 终点 − half]
      const lo = run * ds + half
      const hi = (k - 1) * ds - half
      if (hi >= lo) {
        const p = Math.max(lo, Math.min(hi, c))
        const d = Math.abs(p - c)
        if (d < bd) {
          bd = d
          best = p
        }
      }
      run = -1
    }
  }
  return best
}

/** 折线的累计弧长与按弧长取点（二分查找）：沿路径的注记每帧逐字取点，同一条折线只建一次（见 polylineOf） */
export class Polyline {
  readonly cum: Float64Array
  constructor(readonly line: [number, number][]) {
    const cum = new Float64Array(line.length)
    for (let i = 1; i < line.length; i++) cum[i] = cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
    this.cum = cum
  }
  get length() {
    return this.cum[this.cum.length - 1] ?? 0
  }
  /** 弧长 s 处的点与切线方向（夹到两端） */
  at(s: number): { p: [number, number]; angle: number } {
    const { line, cum } = this
    if (line.length < 2) return { p: line[0], angle: 0 }
    let lo = 1
    let hi = line.length - 1
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (cum[m] < s) lo = m + 1
      else hi = m
    }
    const a = line[lo - 1]
    const b = line[lo]
    const t = Math.max(0, Math.min(1, (s - cum[lo - 1]) / (cum[lo] - cum[lo - 1] || 1)))
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) }
  }
}
const polylines = new WeakMap<[number, number][], Polyline>()
export function polylineOf(line: [number, number][]): Polyline {
  let p = polylines.get(line)
  if (!p) polylines.set(line, (p = new Polyline(line)))
  return p
}

/** 文字自己的位置（段坐标）：带变换的换算过去 */
function anchorOf(it: TextItem): [number, number] {
  const m = it.m
  return m ? [m[0] * it.x + m[2] * it.y + m[4], m[1] * it.x + m[3] * it.y + m[5]] : [it.x, it.y]
}

function paintAttrs(prefix: 'fill' | 'stroke', color: string, alpha: number) {
  return ` ${prefix}="${color}"${alpha < 1 ? ` ${prefix}-opacity="${num(alpha)}"` : ''}`
}

function svgPath(it: PathItem): string {
  let a = ''
  if (it.fill) {
    const f = it.fill
    const c = f.pattern ? `url(#${f.pattern})` : f.gradient ? `url(#${f.gradient})` : f.color!
    a += paintAttrs('fill', c, f.alpha)
    if (f.rule === 'evenodd') a += ' fill-rule="evenodd"'
  } else a += ' fill="none"'
  if (it.stroke) {
    const s = it.stroke
    a += paintAttrs('stroke', s.color, s.alpha) + ` stroke-width="${num(s.width)}"`
    if (s.cap && s.cap !== 'butt') a += ` stroke-linecap="${s.cap}"`
    if (s.join && s.join !== 'miter') a += ` stroke-linejoin="${s.join}"`
    if (s.dash && s.dash.length) a += ` stroke-dasharray="${s.dash.map(num).join(' ')}"`
  }
  if (it.m) a += ` transform="matrix(${it.m.map(num).join(' ')})"`
  if (it.opacity < 1) a += ` opacity="${num(it.opacity)}"`
  if (it.clip) a += ` clip-path="url(#${it.clip})"`
  if (it.filter) a += ` filter="url(#${it.filter})"`
  return `<path d="${it.d}"${a}/>`
}

function svgText(it: TextItem): string {
  let a = ` x="${num(it.x)}" y="${num(it.y)}" style="font:${esc(it.font)}" text-anchor="${it.align}"`
  if (it.baseline !== 'auto') a += ` dominant-baseline="${it.baseline}"`
  if (it.stroke) a += ` fill="none"` + paintAttrs('stroke', it.stroke.color, it.stroke.alpha) + ` stroke-width="${num(it.stroke.width)}" stroke-linejoin="round"`
  else if (it.fill) a += paintAttrs('fill', it.fill.color, it.fill.alpha)
  if (it.m) a += ` transform="matrix(${it.m.map(num).join(' ')})"`
  if (it.opacity < 1) a += ` opacity="${num(it.opacity)}"`
  return `<text${a}>${esc(it.t)}</text>`
}
