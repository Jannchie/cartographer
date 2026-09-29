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
  private patternCache = new Map<string, CanvasPattern>()

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
    if (!d) return
    const bb = transformBBox(bbox ?? pathBBox(d), o.m)
    const item: PathItem = { k: 'path', d, opacity: 1, ...o, bbox: expand(bb, (o.stroke?.width ?? 0) * 2 + 1) }
    this.segment(space).items.push(item)
    return item
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
      for (const it of seg.items) out.push(it.k === 'path' ? svgPath(it) : svgText(it))
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
   */
  render(ctx: CanvasRenderingContext2D, scale: number, ox: number, oy: number, only?: 'page' | 'map') {
    const cw = ctx.canvas.width
    const ch = ctx.canvas.height
    // 可见区（页面坐标）
    const vx0 = -ox / scale
    const vy0 = -oy / scale
    const vx1 = (cw - ox) / scale
    const vy1 = (ch - oy) / scale
    ctx.save()
    ctx.setTransform(scale, 0, 0, scale, ox, oy)
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
      for (const it of seg.items) {
        const b = it.bbox
        if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue
        if (it.k === 'path' && it.minScale !== undefined && scale < it.minScale) continue
        if (it.k === 'path') this.drawPath(ctx, it)
        else this.drawText(ctx, it)
      }
      ctx.restore()
    }
    ctx.restore()
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

  private drawText(ctx: CanvasRenderingContext2D, it: TextItem) {
    ctx.save()
    if (it.m) ctx.transform(...it.m)
    ctx.font = it.font
    ctx.textAlign = it.align === 'middle' ? 'center' : it.align === 'end' ? 'right' : 'left'
    ctx.textBaseline = it.baseline === 'central' ? 'middle' : it.baseline === 'hanging' ? 'top' : it.baseline === 'text-after-edge' ? 'bottom' : 'alphabetic'
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
    ctx.restore()
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
