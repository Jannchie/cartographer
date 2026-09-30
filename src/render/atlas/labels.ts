import type { Label, World } from '../../gen/types'
import { areaMember, cellAt, rangeCells, type Area } from '../../gen/areas'
import { bboxOf, chaikin } from '../../settlement/geom'
import { cjkFont, lang, placeName } from '../../i18n'
import { GLYPH_R, HALO_RATIO, LABEL_PAD, labelPx, logT } from './labelSize'
import { REALM_COLORS, type Theme } from './styles'
import { polyCrossings, polylineOf, rasterArea, rasterPoly, type AreaMask } from './svg/displayList'
import { labelCtx } from './svg/recorder'

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface TextStyle {
  font: string
  size: number
  color: string
  spacing: number
  upper: boolean
  vertical: boolean
  halo: boolean
}

type Kind = Label['kind'] | 'realm' | 'bay'

/** 世界图注记按设计字号显示时的倍率（显示列表的 labelK）：S = 2 时页面 1:1 */
export const atlasLabelK = (S: number) => 2 / S

/** 带避让的注记排布：按重要度依次放置，放不下就在附近换位，再不行就舍弃 */
/** 默认不描边的注记：大字直接压在浅色底图上 */
const NO_HALO = ['ocean', 'sea', 'bay', 'continent']

export class LabelLayer {
  private placed: Box[] = []
  constructor(
    private ctx: CanvasRenderingContext2D,
    private world: World,
    private S: number,
    private theme: Theme,
    /** 有名字的区域：给了就按区域排大陆、海、湾、湖这些地名 */
    private areaList?: Area[],
  ) {}

  reserve(b: Box) {
    this.placed.push(b)
  }

  private hit(b: Box) {
    return this.placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0)
  }

  private inside(b: Box) {
    const MW = this.world.W * this.S
    const MH = this.world.H * this.S
    return b.x0 > 4 && b.y0 > 4 && b.x1 < MW - 4 && b.y1 < MH - 4
  }

  /** 规模排在前四分之一的城市的 weight 下限（城市名分两级） */
  private cityCut?: number

  /**
   * 注记的字体：字号取字号体系的级别（见 labelSize），面状的按占全图的面积比在两级之间按对数插值；
   * 城市按规模分级：首都 > 国都 > 大城 > 其余（国都加粗）。页面字号 = 设计字号 ÷ atlasLabelK(S)
   */
  style(kind: Kind, weight: number, realmCapital = false): TextStyle {
    const L = this.theme.labels
    const labelK = atlasLabelK(this.S)
    // 中文、日文：可竖排，不用斜体、不大写，字距收紧，字号略缩（见 CJK_SCALE）；字体后面接对应语言的 CJK 字体
    const zh = lang !== 'en'
    const vertical = zh && L.vertical.includes(kind)
    const caps = L.caps && !zh
    const f = (style: string, tier: number, fam: string) => {
      const size = labelPx(tier, zh, labelK)
      return { font: `${style} ${size}px ${fam}, ${cjkFont(lang)}`, size }
    }
    const halo = !(L.noHalo ?? NO_HALO).includes(kind)
    const base = (o: ReturnType<typeof f>, color: string, spacing: number, upper: boolean): TextStyle => ({
      ...o,
      color,
      spacing: zh ? Math.max(0.12, spacing * 0.6) : spacing,
      upper: upper && caps,
      vertical,
      halo,
    })
    const it = zh ? '' : 'italic'
    // 占全图的面积比
    const share = weight / (this.world.W * this.world.H)
    switch (kind) {
      case 'ocean':
        return base(f(`${it} 500`, 6, L.display), L.water, 0.42, true)
      case 'sea':
        return base(f(`${it} 500`, 3, zh ? L.display : L.text), L.water, 0.25, false)
      case 'bay':
        return base(f(`${it} 500`, 1, zh ? L.display : L.text), L.water, 0.18, false)
      case 'continent':
        return base(f('600', 4 + 3 * logT(share, 0.02, 0.25), L.display), L.land, 0.55, true)
      case 'realm':
        return base(f('600', 2 + 3 * logT(share, 0.004, 0.08), L.display), L.land, 0.35, true)
      case 'island':
        return base(f('500', 1.5 * logT(share, 0.0005, 0.02), L.text), L.land, 0.12, false)
      case 'range':
        return base(f(`${it} 600`, 1, zh ? L.display : L.text), L.range, 0.36, true)
      case 'basin':
      case 'desert':
      case 'forest':
        return base(f(`${it} 500`, 1, L.text), L.region, 0.22, false)
      case 'lake':
        return base(f(`${it} 500`, 0, L.text), L.water, 0.05, false)
      case 'capital':
        return base(f('700', 2, L.text), L.city, 0.04, false)
      default: {
        if (this.cityCut === undefined) {
          const ws = this.world.labels.filter((l) => l.kind === 'city').map((l) => l.weight).sort((a, b) => b - a)
          this.cityCut = ws.length ? ws[Math.floor((ws.length - 1) / 4)] : Infinity
        }
        return base(f(realmCapital ? '700' : '500', realmCapital ? 1.5 : weight >= this.cityCut ? 1 : 0, L.text), L.city, 0.03, false)
      }
    }
  }

  /** 水域注记的外接框内是否全为水面（抽样检查） */
  private allWater(b: Box) {
    const { world, S } = this
    for (let t = 0; t <= 6; t++) {
      for (const yy of [b.y0 + 3, (b.y0 + b.y1) / 2, b.y1 - 3]) {
        const x = Math.round((b.x0 + ((b.x1 - b.x0) * t) / 6) / S)
        const y = Math.round(yy / S)
        const i = Math.min(world.H - 1, Math.max(0, y)) * world.W + Math.min(world.W - 1, Math.max(0, x))
        if (world.elevation[i] > 0) return false
      }
    }
    return true
  }

  /**
   * 画一段注记；place 为真时做碰撞检测并登记；water 要求整段落在水面上。
   * anchor：注记的锚点（缺省是字的中心），查看器放大时注记以它为中心保持屏幕大小；城市名以城市符号为锚点，放大时不离开符号
   */
  text(raw: string, x: number, y: number, angle: number, st: TextStyle, place = true, color?: string, water = false, anchor?: [number, number], area?: AreaMask): boolean {
    const ctx = this.ctx
    const pad = LABEL_PAD * st.size
    ctx.font = st.font
    const t = st.upper ? raw.toUpperCase() : raw
    const chars = [...t]
    const sp = st.spacing * st.size
    const widths = chars.map((ch) => ctx.measureText(ch).width)
    let box: Box
    let total: number
    if (st.vertical) {
      total = chars.length * st.size + sp * (chars.length - 1)
      const bw = st.size
      box = { x0: x - bw / 2 - pad, y0: y - total / 2 - pad, x1: x + bw / 2 + pad, y1: y + total / 2 + pad }
    } else {
      total = widths.reduce((a, b) => a + b, 0) + sp * (chars.length - 1)
      const c = Math.abs(Math.cos(angle))
      const s = Math.abs(Math.sin(angle))
      const bw = total * c + st.size * s
      const bh = total * s + st.size * c
      box = { x0: x - bw / 2 - pad, y0: y - bh / 2 - pad, x1: x + bw / 2 + pad, y1: y + bh / 2 + pad }
    }
    if (place && (this.hit(box) || !this.inside(box))) return false
    if (water && !this.allWater(box)) return false
    ctx.save()
    ctx.translate(x, y)
    // 矢量记录时整条注记共用一个锚点（查看器放大时注记以它为中心保持屏幕大小）；位图上下文没有这个方法
    labelCtx(ctx).beginLabel?.(anchor ? anchor[0] - x : 0, anchor ? anchor[1] - y : 0, area && { mask: area, w: box.x1 - box.x0, h: box.y1 - box.y0 })
    if (!st.vertical) ctx.rotate(angle)
    ctx.textBaseline = 'middle'
    ctx.textAlign = st.vertical ? 'center' : 'left'
    const draw = (ch: string, cx: number, cy: number) => {
      if (st.halo) {
        ctx.lineWidth = HALO_RATIO * st.size
        ctx.strokeStyle = this.theme.labels.halo
        ctx.lineJoin = 'round'
        ctx.strokeText(ch, cx, cy)
      }
      ctx.fillStyle = color ?? st.color
      ctx.fillText(ch, cx, cy)
    }
    if (st.vertical) {
      let cy = -total / 2 + st.size / 2
      for (const ch of chars) {
        draw(ch, 0, cy)
        cy += st.size + sp
      }
    } else {
      let cx = -total / 2
      for (let i = 0; i < chars.length; i++) {
        draw(chars[i], cx, 0)
        cx += widths[i] + sp
      }
    }
    ctx.restore()
    labelCtx(ctx).endLabel?.()
    if (place) this.placed.push(box)
    return true
  }

  /**
   * 山脊线：高地格按主轴切片，每片取按高度平方加权的横向位置（贴着山脊走），平滑后用 Chaikin 细分成顺滑的折线（格坐标）。
   * 太短、太碎的返回 null（照直排）
   */
  private spine(cells: number[]): [number, number][] | null {
    if (cells.length < 30) return null
    const W = this.world.W
    const e = this.world.elevation
    let sw = 0
    let mx = 0
    let my = 0
    for (const c of cells) {
      const w = Math.max(0.05, e[c])
      sw += w
      mx += w * (c % W)
      my += w * Math.floor(c / W)
    }
    mx /= sw
    my /= sw
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (const c of cells) {
      const w = Math.max(0.05, e[c])
      const x = (c % W) - mx
      const y = Math.floor(c / W) - my
      sxx += w * x * x
      syy += w * y * y
      sxy += w * x * y
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const ux = Math.cos(ang)
    const uy = Math.sin(ang)
    let u0 = Infinity
    let u1 = -Infinity
    for (const c of cells) {
      const u = ((c % W) - mx) * ux + (Math.floor(c / W) - my) * uy
      if (u < u0) u0 = u
      if (u > u1) u1 = u
    }
    const len = u1 - u0
    if (len < 12) return null
    const K = Math.max(6, Math.min(40, Math.round(len / 6)))
    const bin = len / K
    const bw = new Float64Array(K)
    const bv = new Float64Array(K)
    for (const c of cells) {
      const x = (c % W) - mx
      const y = Math.floor(c / W) - my
      const k = Math.min(K - 1, Math.floor((x * ux + y * uy - u0) / bin))
      const w = Math.max(0.05, e[c]) ** 2
      bw[k] += w
      bv[k] += w * (-x * uy + y * ux)
    }
    let pts: [number, number][] = []
    for (let k = 0; k < K; k++) if (bw[k] > 0) pts.push([u0 + (k + 0.5) * bin, bv[k] / bw[k]])
    if (pts.length < 4) return null
    // 横向位置平滑三遍（两端不动）
    for (let pass = 0; pass < 3; pass++) pts = pts.map((p, i) => (i && i < pts.length - 1 ? [p[0], (pts[i - 1][1] + 2 * p[1] + pts[i + 1][1]) / 4] : p))
    return chaikin(
      pts.map(([u, v]) => [mx + u * ux - v * uy, my + u * uy + v * ux]),
      2,
    )
  }

  /** 区域多边形里的陆地格 */
  private polyCells(a: Area): number[] {
    const { W, H, elevation } = this.world
    const [x0, y0, x1, y1] = bboxOf(a.poly)
    const out: number[] = []
    const cross: number[] = []
    const xa = Math.max(0, Math.ceil(x0))
    const xb = Math.min(W - 1, Math.floor(x1))
    // 逐行求一次多边形的交点，按奇偶规则扫过去（与逐格 inPoly 相同）
    for (let y = Math.max(0, Math.ceil(y0)); y <= Math.min(H - 1, Math.floor(y1)); y++) {
      const n = polyCrossings(a.poly, y, cross).length
      let k = 0
      for (let x = xa; x <= xb; x++) {
        while (k < n && cross[k] <= x) k++
        if (k === n) break
        if ((n - k) & 1 && elevation[y * W + x] > 0) out.push(y * W + x)
      }
    }
    return out
  }

  /**
   * 沿曲线逐字排一条注记（山脉名顺着山脊走）：字距放宽到铺开山脉的一部分。
   * 英文字随曲线转；中日文字保持直立，只是排在曲线上（横向的山从左往右读，纵向的从上往下读）。
   * 查看器里放大后原位置不在视口里时，整条注记顺着山脊滑进露出来的那一段（见 displayList 的 slideAlong）。
   * line 是像素坐标；放不下、弯得太急返回 false
   */
  curved(raw: string, line: [number, number][], st: TextStyle): boolean {
    const ctx = this.ctx
    ctx.font = st.font
    const chars = [...(st.upper ? raw.toUpperCase() : raw)]
    const n = chars.length
    const up = lang !== 'en'
    const size = st.size
    const adv = chars.map((ch) => (up ? size : ctx.measureText(ch).width))
    const natural = adv.reduce((a, b) => a + b, 0)
    // 读的方向：英文保证不倒置；中日文横向从左往右、纵向从上往下
    const [sx, sy] = line[0]
    const [ex, ey] = line[line.length - 1]
    const flip = up ? (Math.abs(ex - sx) >= Math.abs(ey - sy) ? ex < sx : ey < sy) : ex < sx
    const pl = flip ? [...line].reverse() : line
    const path = polylineOf(pl)
    const L = path.length
    if (L < natural * 1.05 + size) return false
    const pointAt = (s: number) => path.at(s).p
    const gap = n > 1 ? Math.max(st.spacing * size, Math.min(size * 1.6, (Math.min(L * 0.7, natural * 2.4) - natural) / (n - 1))) : 0
    const total = natural + gap * (n - 1)
    if (total > L) return false
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) {
      const s0 = L * f - total / 2
      if (s0 < 0 || s0 + total > L) continue
      const glyphs: { ch: string; at: number; p: [number, number]; a: number }[] = []
      let s = s0
      for (let i = 0; i < n; i++) {
        const at = s + adv[i] / 2
        const a0 = pointAt(at - adv[i] / 2)
        const a1 = pointAt(at + adv[i] / 2)
        glyphs.push({ ch: chars[i], at, p: pointAt(at), a: up ? 0 : Math.atan2(a1[1] - a0[1], a1[0] - a0[0]) })
        s += adv[i] + gap
      }
      let bend = 0
      for (let i = 1; i < n; i++) bend = Math.max(bend, Math.abs(glyphs[i].a - glyphs[i - 1].a))
      if (bend > 0.5) continue
      const r = size * (GLYPH_R + LABEL_PAD)
      const boxes = glyphs.map(({ p }) => ({ x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r }))
      if (boxes.some((b) => this.hit(b) || !this.inside(b))) continue
      const mid = pointAt(s0 + total / 2)
      labelCtx(ctx).beginLabel?.(mid[0], mid[1], undefined, { line: pl, c: s0 + total / 2, up, slide: true })
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      for (const g of glyphs) {
        ctx.save()
        ctx.translate(g.p[0], g.p[1])
        ctx.rotate(g.a)
        labelCtx(ctx).glyphAt?.(g.at)
        if (st.halo) {
          ctx.lineWidth = HALO_RATIO * size
          ctx.strokeStyle = this.theme.labels.halo
          ctx.lineJoin = 'round'
          ctx.strokeText(g.ch, 0, 0)
        }
        ctx.fillStyle = st.color
        ctx.fillText(g.ch, 0, 0)
        ctx.restore()
      }
      labelCtx(ctx).endLabel?.()
      this.placed.push(...boxes)
      return true
    }
    return false
  }

  /** 城市：符号 + 四方位择一放字 */
  city(l: Label, realmCapital: boolean) {
    const ctx = this.ctx
    const k = this.S / 2
    const S = this.S
    const st = this.style(l.kind, l.weight, realmCapital)
    const x = l.x * S
    const y = l.y * S
    const big = l.kind === 'capital' || realmCapital
    const r = (big ? 4.2 : 2.6) * k
    const dot = { x0: x - r - 1, y0: y - r - 1, x1: x + r + 1, y1: y + r + 1 }
    if (this.hit(dot)) return
    const name = placeName(l)
    ctx.font = st.font
    const tw = [...name].reduce((a, ch) => a + ctx.measureText(ch).width, 0) + st.spacing * st.size * (name.length - 1)
    const size = st.size
    // 字与符号的间距、碰撞留白都随字号
    const gap = size * 0.3
    const pad = LABEL_PAD * size
    const cands = [
      [x + r + gap + tw / 2, y],
      [x - r - gap - tw / 2, y],
      [x, y - r - size * 0.75],
      [x, y + r + size * 0.75],
    ]
    const hs = { ...st, vertical: false }
    for (const [cx, cy] of cands) {
      const box = { x0: cx - tw / 2 - pad, y0: cy - size / 2 - pad, x1: cx + tw / 2 + pad, y1: cy + size / 2 + pad }
      if (this.hit(box) || !this.inside(box)) continue
      this.placed.push(dot)
      this.text(name, cx, cy, 0, hs, true, undefined, false, [x, y])
      // 城市符号与城市名同一个锚点：放大时一起保持屏幕大小
      labelCtx(ctx).beginLabel?.(x, y)
      this.marker(x, y, r, big)
      labelCtx(ctx).endLabel?.()
      return
    }
  }

  private marker(x: number, y: number, r: number, big: boolean) {
    const ctx = this.ctx
    const k = this.S / 2
    const ink = this.theme.labels.city
    const paper = this.theme.labels.halo
    ctx.save()
    ctx.lineWidth = 1.2 * k
    ctx.strokeStyle = ink
    ctx.fillStyle = ink
    switch (this.theme.labels.city_marker) {
      case 'castle': {
        // 城堡：带垛口的小塔
        const w = r * 1.1
        const h = r * (big ? 2.1 : 1.6)
        ctx.fillStyle = paper
        ctx.beginPath()
        ctx.rect(x - w, y - h * 0.6, w * 2, h)
        ctx.fill()
        ctx.stroke()
        ctx.beginPath()
        for (let t = 0; t < 3; t++) ctx.rect(x - w + t * w * 0.8, y - h * 0.6 - r * 0.5, w * 0.4, r * 0.5)
        ctx.fillStyle = ink
        ctx.fill()
        if (big) {
          ctx.beginPath()
          ctx.moveTo(x, y - h * 0.6 - r * 0.5)
          ctx.lineTo(x, y - h * 1.3)
          ctx.lineTo(x + r, y - h * 1.15)
          ctx.lineTo(x, y - h)
          ctx.stroke()
        }
        break
      }
      case 'square': {
        const s = big ? r * 1.2 : r * 0.9
        ctx.fillStyle = paper
        ctx.fillRect(x - s, y - s, s * 2, s * 2)
        ctx.strokeRect(x - s, y - s, s * 2, s * 2)
        if (big) ctx.strokeRect(x - s * 0.5, y - s * 0.5, s, s)
        break
      }
      case 'star':
        if (big) {
          ctx.beginPath()
          for (let t = 0; t < 10; t++) {
            const a = -Math.PI / 2 + (t * Math.PI) / 5
            const rr = t % 2 ? r * 0.5 : r * 1.35
            ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr)
          }
          ctx.closePath()
          ctx.fillStyle = '#7a2f2f'
          ctx.fill()
          ctx.strokeStyle = paper
          ctx.lineWidth = 0.8 * k
          ctx.stroke()
          break
        }
      // 普通城市与 dot 相同
      // falls through
      default:
        if (big) {
          ctx.fillStyle = paper
          ctx.beginPath()
          ctx.arc(x, y, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
          ctx.fillStyle = ink
          ctx.beginPath()
          ctx.arc(x, y, r * 0.45, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.strokeStyle = paper
          ctx.beginPath()
          ctx.arc(x, y, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        }
    }
    ctx.restore()
  }

  /**
   * 面状注记标的区域（查看器放大后原位置不在视口里时，注记挪到区域露出来的那一角，见 TextItem.area）：
   * 有名字的区域（大陆、海、湾、湖、地形区……，见 gen/areas）取多边形里、且是区域本体的格子；国名是国土。
   * 不属于任何区域的注记不挪。位图 4 格一取样
   */
  private areas() {
    const { world, S } = this
    const { W, H } = world
    const cell = 4 * S
    const cache = new Map<object, AreaMask>()
    return (it: { kind: Kind; realm?: number; area?: Area }): AreaMask | undefined => {
      const key = it.area ?? (it.kind === 'realm' ? world.realms[it.realm!] : null)
      if (!key) return undefined
      const hit = cache.get(key)
      if (hit) return hit
      let m: AreaMask
      if (it.area) {
        // 区域：多边形里、且是区域本体（水域只算海面或湖面，陆地只算陆地）的格子
        const a = it.area
        const member = areaMember(world, a.kind)
        const [x0, y0, x1, y1] = bboxOf(a.poly)
        m = rasterPoly(
          [(x0 + 0.5) * S, (y0 + 0.5) * S, (x1 + 0.5) * S, (y1 + 0.5) * S],
          cell,
          a.poly,
          (v) => v / S - 0.5,
          (gx, gy) => member(cellAt(world, gx, gy)),
        )
      } else m = rasterArea([0, 0, W * S, H * S], cell, (x, y) => world.realm[Math.min(H - 1, Math.floor(y / S)) * W + Math.min(W - 1, Math.floor(x / S))] === it.realm)
      cache.set(key, m)
      return m
    }
  }

  /** 按类型优先级排布全部注记 */
  all() {
    const { world, S, theme } = this
    const k = S / 2
    const order: Kind[] = ['ocean', 'realm', 'continent', 'capital', 'range', 'sea', 'city', 'island', 'bay', 'lake', 'desert', 'basin', 'forest']
    const capitals = new Set(theme.realms ? world.realms.map((r) => r.capital) : [])
    type Item = { kind: Kind; weight: number; label?: Label; realm?: number; area?: Area }
    // 由区域推出来的地名按区域画（名字、位置可能改过）；其余照原注记
    const areas = this.areaList ?? []
    const covered = new Set(areas.map((a) => a.label).filter((i): i is number => i !== undefined))
    const items: Item[] = world.labels.filter((_, i) => !covered.has(i)).map((l) => ({ kind: l.kind, weight: l.weight, label: l }))
    for (const a of areas) {
      const src = a.label !== undefined ? world.labels[a.label] : undefined
      const label: Label = {
        kind: a.kind === 'bay' ? 'sea' : a.kind,
        name: a.name,
        zh: a.zh,
        ja: a.ja,
        x: a.at[0],
        y: a.at[1],
        angle: src?.angle ?? 0,
        weight: src?.weight ?? a.cells,
        span: src?.span ?? Math.sqrt(a.cells) * 1.2,
      }
      items.push({ kind: a.kind, weight: label.weight, label, area: a })
    }
    if (theme.realms) world.realms.forEach((r, i) => items.push({ kind: 'realm', weight: r.area, realm: i }))
    // 政区图上大陆名让位给国名
    const list = items
      .filter((it) => !(theme.realms && it.kind === 'continent'))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.weight - a.weight)
    const areaOf = labelCtx(this.ctx).beginLabel ? this.areas() : () => undefined
    for (const it of list) {
      if (it.kind === 'realm') {
        const r = world.realms[it.realm!]
        const st = this.style('realm', r.area)
        const c = REALM_COLORS[r.color]
        const col = `rgb(${c.map((v) => Math.round(v * 0.42)).join(',')})`
        const name = placeName(r)
        for (const [ox, oy] of [[0, 0], [0, -30 * k], [0, 30 * k], [-50 * k, 0], [50 * k, 0]]) {
          if (world.realm[Math.round(r.y + oy / S) * world.W + Math.round(r.x + ox / S)] !== it.realm) continue
          if (this.text(name, r.x * S + ox, r.y * S + oy, 0, st, true, col, false, undefined, areaOf(it))) break
        }
        continue
      }
      const l = it.label!
      if (l.kind === 'city' || l.kind === 'capital') {
        this.city(l, capitals.has(world.labels.indexOf(l)))
        continue
      }
      const st = this.style(it.kind, l.weight)
      const name = placeName(l)
      if (it.kind === 'range') {
        // 山脉名顺着山脊排；山太短、弯得太急或放不下时照直排
        const line = this.spine(it.area ? this.polyCells(it.area) : rangeCells(world, l))
        if (line && this.curved(name, line.map(([x, y]) => [x * S, y * S] as [number, number]), st)) continue
      }
      const r = Math.max(30 * k, Math.min(120 * k, l.span * S * 0.25))
      const offs = [[0, 0], [0, -r * 0.5], [0, r * 0.5], [-r, 0], [r, 0], [-r, -r * 0.6], [r, r * 0.6], [r, -r * 0.6], [-r, r * 0.6], [-2 * r, 0], [2 * r, 0], [0, -r], [0, r]]
      const water = l.kind === 'ocean' || l.kind === 'sea'
      for (const [ox, oy] of offs) {
        const i = Math.round(l.y + oy / S) * world.W + Math.round(l.x + ox / S)
        if (water && !(world.elevation[i] < 0)) continue
        if (this.text(name, l.x * S + ox, l.y * S + oy, st.vertical ? 0 : l.angle, st, true, undefined, water, undefined, areaOf(it))) break
      }
    }
  }
}

