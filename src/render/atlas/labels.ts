import type { Label, World } from '../../gen/types'
import { REALM_COLORS, type Theme } from './styles'

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

type Kind = Label['kind'] | 'realm'

/** 带避让的注记排布：按重要度依次放置，放不下就在附近换位，再不行就舍弃 */
export class LabelLayer {
  private placed: Box[] = []
  constructor(
    private ctx: CanvasRenderingContext2D,
    private world: World,
    private S: number,
    private theme: Theme,
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

  style(kind: Kind, weight: number): TextStyle {
    const L = this.theme.labels
    const k = this.S / 2
    const zh = L.zh
    const vertical = L.vertical.includes(kind)
    const caps = L.caps && !zh
    const f = (style: string, size: number, fam: string) => ({ font: `${style} ${size * k}px ${fam}`, size: size * k })
    const base = (o: ReturnType<typeof f>, color: string, spacing: number, upper: boolean, halo = true): TextStyle => ({
      ...o,
      color,
      spacing: zh ? Math.max(0.12, spacing * 0.6) : spacing,
      upper: upper && caps,
      vertical,
      halo,
    })
    const it = zh ? '' : 'italic'
    switch (kind) {
      case 'ocean':
        return base(f(`${it} 500`, zh ? 34 : 30, L.display), L.water, 0.42, true, false)
      case 'sea':
        return base(f(`${it} 500`, zh ? 20 : 19, zh ? L.display : L.text), L.water, 0.25, false, false)
      case 'continent':
        return base(f('600', Math.min(40, 22 + weight / 9000) * (zh ? 1.1 : 1), L.display), L.land, 0.55, true, false)
      case 'realm':
        return base(f('600', Math.min(30, 15 + weight / 5000) * (zh ? 1.15 : 1), L.display), L.land, 0.35, true, true)
      case 'island':
        return base(f('500', weight > 2500 ? 16 : 13, L.text), L.land, 0.12, false)
      case 'range':
        return base(f(`${it} 600`, zh ? 17 : 14.5, zh ? L.display : L.text), L.range, 0.36, true)
      case 'basin':
      case 'desert':
      case 'forest':
        return base(f(`${it} 500`, 15, L.text), L.region, 0.22, false)
      case 'lake':
        return base(f(`${it} 500`, 12.5, L.text), L.water, 0.05, false)
      case 'capital':
        return base(f('700', 15.5, L.text), L.city, 0.04, false)
      default:
        return base(f('500', 13.5, L.text), L.city, 0.03, false)
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

  /** 画一段注记；place 为真时做碰撞检测并登记；water 要求整段落在水面上 */
  text(raw: string, x: number, y: number, angle: number, st: TextStyle, place = true, color?: string, water = false): boolean {
    const ctx = this.ctx
    const k = this.S / 2
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
      box = { x0: x - bw / 2 - 3, y0: y - total / 2 - 3, x1: x + bw / 2 + 3, y1: y + total / 2 + 3 }
    } else {
      total = widths.reduce((a, b) => a + b, 0) + sp * (chars.length - 1)
      const c = Math.abs(Math.cos(angle))
      const s = Math.abs(Math.sin(angle))
      const bw = total * c + st.size * s
      const bh = total * s + st.size * c
      box = { x0: x - bw / 2 - 3, y0: y - bh / 2 - 3, x1: x + bw / 2 + 3, y1: y + bh / 2 + 3 }
    }
    if (place && (this.hit(box) || !this.inside(box))) return false
    if (water && !this.allWater(box)) return false
    ctx.save()
    ctx.translate(x, y)
    if (!st.vertical) ctx.rotate(angle)
    ctx.textBaseline = 'middle'
    ctx.textAlign = st.vertical ? 'center' : 'left'
    const draw = (ch: string, cx: number, cy: number) => {
      if (st.halo) {
        ctx.lineWidth = 3.2 * k
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
    if (place) this.placed.push(box)
    return true
  }

  /** 城市：符号 + 四方位择一放字 */
  city(l: Label, realmCapital: boolean) {
    const ctx = this.ctx
    const k = this.S / 2
    const S = this.S
    const st = this.style(l.kind, l.weight)
    const x = l.x * S
    const y = l.y * S
    const big = l.kind === 'capital' || realmCapital
    const r = (big ? 4.2 : 2.6) * k
    const dot = { x0: x - r - 1, y0: y - r - 1, x1: x + r + 1, y1: y + r + 1 }
    if (this.hit(dot)) return
    const name = this.theme.labels.zh ? l.zh : l.name
    ctx.font = st.font
    const tw = [...name].reduce((a, ch) => a + ctx.measureText(ch).width, 0) + st.spacing * st.size * (name.length - 1)
    const size = st.size
    const cands = [
      [x + r + 4 * k + tw / 2, y],
      [x - r - 4 * k - tw / 2, y],
      [x, y - r - size * 0.75],
      [x, y + r + size * 0.75],
    ]
    const hs = { ...st, vertical: false }
    for (const [cx, cy] of cands) {
      const box = { x0: cx - tw / 2 - 2, y0: cy - size / 2 - 2, x1: cx + tw / 2 + 2, y1: cy + size / 2 + 2 }
      if (this.hit(box) || !this.inside(box)) continue
      this.placed.push(dot)
      this.text(name, cx, cy, 0, big ? { ...hs, font: hs.font.replace(/^\d+|^500/, '700') } : hs, true)
      this.marker(x, y, r, big)
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

  /** 按类型优先级排布全部注记 */
  all() {
    const { world, S, theme } = this
    const k = S / 2
    const zh = theme.labels.zh
    const order: Kind[] = ['ocean', 'realm', 'continent', 'capital', 'range', 'sea', 'city', 'island', 'lake', 'desert', 'basin', 'forest']
    const capitals = new Set(theme.realms ? world.realms.map((r) => r.capital) : [])
    type Item = { kind: Kind; weight: number; label?: Label; realm?: number }
    const items: Item[] = world.labels.map((l) => ({ kind: l.kind, weight: l.weight, label: l }))
    if (theme.realms) world.realms.forEach((r, i) => items.push({ kind: 'realm', weight: r.area, realm: i }))
    // 政区图上大陆名让位给国名
    const list = items
      .filter((it) => !(theme.realms && it.kind === 'continent'))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.weight - a.weight)
    for (const it of list) {
      if (it.kind === 'realm') {
        const r = world.realms[it.realm!]
        const st = this.style('realm', r.area)
        const c = REALM_COLORS[r.color]
        const col = `rgb(${c.map((v) => Math.round(v * 0.42)).join(',')})`
        const name = zh ? r.zh : r.name
        for (const [ox, oy] of [[0, 0], [0, -30 * k], [0, 30 * k], [-50 * k, 0], [50 * k, 0]]) {
          if (world.realm[Math.round(r.y + oy / S) * world.W + Math.round(r.x + ox / S)] !== it.realm) continue
          if (this.text(name, r.x * S + ox, r.y * S + oy, 0, st, true, col)) break
        }
        continue
      }
      const l = it.label!
      if (l.kind === 'city' || l.kind === 'capital') {
        this.city(l, capitals.has(world.labels.indexOf(l)))
        continue
      }
      const st = this.style(l.kind, l.weight)
      const name = zh ? l.zh : l.name
      const r = Math.max(30 * k, Math.min(120 * k, l.span * S * 0.25))
      const offs = [[0, 0], [0, -r * 0.5], [0, r * 0.5], [-r, 0], [r, 0], [-r, -r * 0.6], [r, r * 0.6], [r, -r * 0.6], [-r, r * 0.6], [-2 * r, 0], [2 * r, 0], [0, -r], [0, r]]
      const water = l.kind === 'ocean' || l.kind === 'sea'
      for (const [ox, oy] of offs) {
        const i = Math.round(l.y + oy / S) * world.W + Math.round(l.x + ox / S)
        if (water && !(world.elevation[i] < 0)) continue
        if (this.text(name, l.x * S + ox, l.y * S + oy, st.vertical ? 0 : l.angle, st, true, undefined, water)) break
      }
    }
  }
}
