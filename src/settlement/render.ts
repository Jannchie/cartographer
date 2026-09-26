import { contours, simplify, type Ring } from '../render/atlas/svg/contour'
import { DisplayList, type Fill, type Stroke } from '../render/atlas/svg/displayList'
import { blur } from '../gen/util'
import { centroid, circlePoly, dist, obb, pointAt, polylineLength, type P, type Poly } from './geom'
import { settleTheme, type SettleStyleId, type SettleTheme } from './themes'
import type { BuildingKind, Settlement } from './types'

export interface SettleOpts {
  labels: boolean
  contours: boolean
}

const SIZE_ZH = { hamlet: '小村', village: '村镇', town: '城镇', city: '城市' }

/**
 * 聚落地图 → 矢量显示列表（与世界纸图共用 DisplayList：预览、PNG 与 SVG 导出一致）。
 * 坐标：米 × S = 页面像素。
 */
export function buildSettlementVector(st: Settlement, style: SettleStyleId, opts: SettleOpts, measurer: CanvasRenderingContext2D): DisplayList {
  const th = settleTheme(style)
  const S = 1900 / st.width
  const M = 44
  const MW = Math.round(st.width * S)
  const MH = Math.round(st.height * S)
  const list = new DisplayList(MW + M * 2, MH + M * 2, M, MW, MH)
  const R = new Painter(list, S, th)
  hatchPatterns(list, th)

  // 纸
  list.path('page', `M0 0H${list.width}V${list.height}H0Z`, { fill: { color: th.paper, alpha: 1 } })
  R.rect(th.ground)
  terrainLayers(R, st, th, opts)
  for (const f of st.fields) R.poly(f.poly, { color: pick(th.fields[f.kind], f.tone), alpha: 1 })
  furrows(R, st, th)
  for (const g of st.greens) R.poly(g.poly, { color: th.green[g.kind], alpha: 1 }, g.kind === 'cemetery' ? { color: th.ink, alpha: 0.35, width: 0.5 } : undefined)
  urbanGround(R, st, th)
  waterLayers(R, st, th)
  wonderGlow(R, st, th)
  roadsOuter(R, st, th)
  innerStreets(R, st, th)
  crossingLayers(R, st, th)
  for (const p of st.piers) R.poly(p, { color: th.plaza, alpha: 1 }, { color: th.ink, alpha: 0.8, width: 0.7 })
  boatLayers(R, st, th)
  enclosureLayers(R, st, th)
  buildingLayers(R, st, th)
  wallLayers(R, st, th)
  treeLayers(R, st, th)
  wonderLayers(R, st, th)
  if (opts.labels) labelLayers(R, st, th, measurer)
  furniture(list, st, th, S, M, MW, MH, measurer)
  return list
}

const pick = <T>(arr: T[], t: number) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))]
const f1 = (v: number) => (Math.round(v * 10) / 10).toString()

class Painter {
  constructor(
    readonly list: DisplayList,
    readonly S: number,
    readonly th: SettleTheme,
  ) {}

  polyD(poly: Poly) {
    if (poly.length < 3) return ''
    const S = this.S
    let d = `M${f1(poly[0][0] * S)} ${f1(poly[0][1] * S)}`
    for (let i = 1; i < poly.length; i++) d += `L${f1(poly[i][0] * S)} ${f1(poly[i][1] * S)}`
    return d + 'Z'
  }

  lineD(line: P[]) {
    if (line.length < 2) return ''
    const S = this.S
    let d = `M${f1(line[0][0] * S)} ${f1(line[0][1] * S)}`
    for (let i = 1; i < line.length; i++) d += `L${f1(line[i][0] * S)} ${f1(line[i][1] * S)}`
    return d
  }

  circleD(c: P, r: number) {
    const S = this.S
    const x = c[0] * S
    const y = c[1] * S
    const rr = r * S
    return `M${f1(x + rr)} ${f1(y)}A${f1(rr)} ${f1(rr)} 0 1 1 ${f1(x - rr)} ${f1(y)}A${f1(rr)} ${f1(rr)} 0 1 1 ${f1(x + rr)} ${f1(y)}Z`
  }

  fillOf(color: string, alpha = 1): Fill {
    return color.startsWith('url(') ? { pattern: color.slice(5, -1), alpha } : { color, alpha }
  }

  poly(poly: Poly, fill?: { color: string; alpha: number }, stroke?: { color: string; alpha: number; width: number; dash?: number[] }) {
    const d = this.polyD(poly)
    if (!d) return
    this.list.path('map', d, {
      fill: fill ? this.fillOf(fill.color, fill.alpha) : undefined,
      stroke: stroke ? { ...stroke, width: stroke.width, join: 'round', cap: 'round' } : undefined,
    })
  }

  /** 同样式的一批多边形合成一条路径 */
  polys(polys: Poly[], fill?: Fill, stroke?: Stroke) {
    const d = polys.map((p) => this.polyD(p)).join('')
    if (d) this.list.path('map', d, { fill, stroke })
  }

  lines(lines: P[][], stroke: Stroke) {
    const d = lines.map((l) => this.lineD(l)).join('')
    if (d) this.list.path('map', d, { stroke })
  }

  rect(color: string) {
    const w = this.list.MW
    const h = this.list.MH
    this.list.path('map', `M-4 -4L${w + 4} -4L${w + 4} ${h + 4}L-4 ${h + 4}Z`, { fill: this.fillOf(color) })
  }

  /** 地形栅格的等值区（场 ≥ level） */
  field(field: Float32Array, W: number, H: number, cell: number, level: number, fill: Fill | null, stroke?: Stroke, smooth = true) {
    const rings = contours(field, W, H, level, !stroke || !!fill)
    const d = ringsD(rings, cell * this.S, !!fill || !stroke, smooth)
    if (d) this.list.path('map', d, { fill: fill ? { ...fill, rule: 'evenodd' } : undefined, stroke })
  }
}

/** 环（格坐标，格点 = 节点）→ 路径，中点二次贝塞尔平滑 */
function ringsD(rings: Ring[], k: number, closed: boolean, smooth: boolean) {
  const parts: string[] = []
  const f = (v: number) => f1(v * k)
  for (const raw of rings) {
    const r = simplify(raw, 0.3)
    const n = r.length / 2
    if (n < 3) continue
    const isClosed = closed || Math.hypot(r[0] - r[(n - 1) * 2], r[1] - r[(n - 1) * 2 + 1]) < 1.01
    if (!smooth) {
      let d = `M${f(r[0])} ${f(r[1])}`
      for (let i = 1; i < n; i++) d += `L${f(r[i * 2])} ${f(r[i * 2 + 1])}`
      parts.push(isClosed ? d + 'Z' : d)
      continue
    }
    const mid = (i: number, j: number, c: 0 | 1) => (r[i * 2 + c] + r[j * 2 + c]) / 2
    if (isClosed) {
      let d = `M${f(mid(0, 1, 0))} ${f(mid(0, 1, 1))}`
      for (let i = 1; i <= n; i++) {
        const a = i % n
        const b = (i + 1) % n
        d += `Q${f(r[a * 2])} ${f(r[a * 2 + 1])} ${f(mid(a, b, 0))} ${f(mid(a, b, 1))}`
      }
      parts.push(d + 'Z')
    } else {
      let d = `M${f(r[0])} ${f(r[1])}`
      for (let i = 1; i < n - 1; i++) d += `Q${f(r[i * 2])} ${f(r[i * 2 + 1])} ${f(mid(i, i + 1, 0))} ${f(mid(i, i + 1, 1))}`
      parts.push(d + `L${f(r[(n - 1) * 2])} ${f(r[(n - 1) * 2 + 1])}`)
    }
  }
  return parts.join('')
}

function hatchPatterns(list: DisplayList, th: SettleTheme) {
  if (!th.hatch) return
  const make = (id: string, step: number, cross: boolean) => {
    const s = step
    const svg =
      `<rect width="${s}" height="${s}" fill="${th.ground}"/>` +
      `<path d="M0 ${s}L${s} 0M${-s / 2} ${s / 2}L${s / 2} ${-s / 2}M${s / 2} ${s * 1.5}L${s * 1.5} ${s / 2}" stroke="${th.hatch}" stroke-width="0.7"/>` +
      (cross ? `<path d="M0 0L${s} ${s}" stroke="${th.hatch}" stroke-width="0.6"/>` : '')
    list.patterns.set(id, {
      w: s,
      h: s,
      svg,
      tile: () => {
        const c = document.createElement('canvas')
        const k = 4
        c.width = c.height = Math.round(s * k)
        const g = c.getContext('2d')!
        g.fillStyle = th.ground
        g.fillRect(0, 0, c.width, c.height)
        g.strokeStyle = th.hatch!
        g.lineWidth = 0.7 * k
        g.beginPath()
        g.moveTo(0, s * k)
        g.lineTo(s * k, 0)
        g.moveTo((-s / 2) * k, (s / 2) * k)
        g.lineTo((s / 2) * k, (-s / 2) * k)
        g.moveTo((s / 2) * k, s * 1.5 * k)
        g.lineTo(s * 1.5 * k, (s / 2) * k)
        if (cross) {
          g.moveTo(0, 0)
          g.lineTo(s * k, s * k)
        }
        g.stroke()
        return c
      },
    })
  }
  make('hatch', 2.6, false)
  make('hatch2', 2.2, true)
}

// —————————————————————— 地形与水 ——————————————————————

function terrainLayers(R: Painter, st: Settlement, th: SettleTheme, opts: SettleOpts) {
  const { W, H, cell, height, water } = st.terrain
  // 晕渲（西北光）
  const dark = new Float32Array(W * H)
  const light = new Float32Array(W * H)
  const z = 1.1
  for (let j = 1; j < H - 1; j++)
    for (let i = 1; i < W - 1; i++) {
      const k = j * W + i
      if (water[k] < 0) {
        dark[k] = light[k] = -1
        continue
      }
      const nx = (-(height[k + 1] - height[k - 1]) / (2 * cell)) * z
      const ny = (-(height[k + W] - height[k - W]) / (2 * cell)) * z
      const inv = 1 / Math.hypot(nx, ny, 1)
      const l = ((nx * -0.6 + ny * -0.6 + 0.53) * inv) / 0.53
      dark[k] = 1 - l
      light[k] = l - 1
    }
  blur(dark, W, H, 1, 2)
  blur(light, W, H, 1, 2)
  for (const t of [0.07, 0.15, 0.25, 0.37, 0.5]) R.field(dark, W, H, cell, t, { color: th.shade.color, alpha: th.shade.alpha })
  if (th.shade.light > 0) for (const t of [0.03, 0.08]) R.field(light, W, H, cell, t, { color: '#ffffff', alpha: th.shade.light * 0.5 })
  if (!opts.contours || !th.contour) return
  // 等高线：按高差选等高距，陆上才画
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < W * H; k++)
    if (water[k] > 0) {
      lo = Math.min(lo, height[k])
      hi = Math.max(hi, height[k])
    }
  const range = hi - lo
  const step = range < 12 ? 1 : range < 30 ? 2 : range < 70 ? 5 : range < 160 ? 10 : 20
  const land = new Float32Array(W * H)
  for (let k = 0; k < W * H; k++) land[k] = water[k] < 0 ? -999 : height[k]
  const c = th.contour
  for (let h = Math.ceil(lo / step) * step; h < hi; h += step) {
    if (h <= 0) continue
    const idx = Math.round(h / step) % 5 === 0
    R.field(land, W, H, cell, h, null, { color: c.color, alpha: c.alpha * (idx ? 1.4 : 0.8), width: c.width * (idx ? 1.5 : 1), cap: 'round', join: 'round' })
  }
}

function waterLayers(R: Painter, st: Settlement, th: SettleTheme) {
  const { W, H, cell, water } = st.terrain
  const wet = new Float32Array(W * H)
  for (let k = 0; k < W * H; k++) wet[k] = -water[k]
  R.field(wet, W, H, cell, 0, { color: th.water, alpha: 1 })
  R.field(wet, W, H, cell, 22, { color: th.waterDeep, alpha: 1 })
  // 水线：离岸越远越淡
  const lines = [2.2, 5, 9, 15]
  lines.forEach((d, i) => R.field(wet, W, H, cell, d, null, { color: th.waterLine.color, alpha: th.waterLine.alpha[i], width: 0.6, cap: 'round', join: 'round' }))
  R.field(wet, W, H, cell, 0, null, { color: th.ink, alpha: 0.75, width: 0.9, cap: 'round', join: 'round' })
  // 版画风格的水面横纹
  if (th.id === 'ink') {
    const S = R.S
    const d: string[] = []
    for (let y = 3; y < st.height; y += 3.2)
      for (let x = 0; x < st.width; ) {
        while (x < st.width && water[Math.round(y / cell) * W + Math.round(x / cell)] > -3) x += 1.5
        const x0 = x
        while (x < st.width && water[Math.round(y / cell) * W + Math.round(x / cell)] <= -3) x += 1.5
        if (x - x0 > 3) d.push(`M${f1(x0 * S)} ${f1(y * S)}H${f1((x - 1.5) * S)}`)
      }
    R.list.path('map', d.join(''), { stroke: { color: th.ink, alpha: 0.5, width: 0.45 } })
  }
}

// —————————————————————— 田与林 ——————————————————————

/** 凸多边形内的平行线（Cyrus–Beck 裁剪） */
function hatchLines(poly: Poly, angle: number, step: number): P[][] {
  const u: P = [Math.cos(angle), Math.sin(angle)]
  const v: P = [-u[1], u[0]]
  let v0 = Infinity
  let v1 = -Infinity
  for (const p of poly) {
    const t = p[0] * v[0] + p[1] * v[1]
    v0 = Math.min(v0, t)
    v1 = Math.max(v1, t)
  }
  const c = centroid(poly)
  const out: P[][] = []
  for (let t = v0 + step / 2; t < v1; t += step) {
    // 直线：p = o + s·u，其中 o 在法向坐标 t 处
    const off = t - (c[0] * v[0] + c[1] * v[1])
    const o: P = [c[0] + v[0] * off, c[1] + v[1] * off]
    let s0 = -1e6
    let s1 = 1e6
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const ex = b[0] - a[0]
      const ey = b[1] - a[1]
      // 内侧判定用中心
      let nx = -ey
      let ny = ex
      if ((c[0] - a[0]) * nx + (c[1] - a[1]) * ny < 0) {
        nx = -nx
        ny = -ny
      }
      const den = u[0] * nx + u[1] * ny
      const num = (o[0] - a[0]) * nx + (o[1] - a[1]) * ny
      if (Math.abs(den) < 1e-9) {
        if (num < 0) s1 = -1e7
        continue
      }
      const s = -num / den
      if (den > 0) s0 = Math.max(s0, s)
      else s1 = Math.min(s1, s)
    }
    if (s1 - s0 > 1) out.push([[o[0] + u[0] * (s0 + 0.6), o[1] + u[1] * (s0 + 0.6)], [o[0] + u[0] * (s1 - 0.6), o[1] + u[1] * (s1 - 0.6)]])
  }
  return out
}

function furrows(R: Painter, st: Settlement, th: SettleTheme) {
  const lines: P[][] = []
  const bunds: Poly[] = []
  const vine: P[][] = []
  for (const f of st.fields) {
    if (f.kind === 'crop') lines.push(...hatchLines(f.poly, f.angle, 3.4))
    else if (f.kind === 'vineyard') vine.push(...hatchLines(f.poly, f.angle, 2.4))
    else if (f.kind === 'paddy') bunds.push(f.poly)
  }
  R.lines(lines, { color: th.furrow.color, alpha: th.furrow.alpha, width: 0.4 })
  R.lines(vine, { color: th.furrow.color, alpha: th.furrow.alpha * 1.4, width: 0.6, dash: [1.2, 1.4] })
  R.polys(bunds, undefined, { color: th.furrow.color, alpha: th.furrow.alpha * 1.6, width: 0.7 })
  // 田块边界
  R.polys(
    st.fields.filter((f) => f.kind !== 'paddy').map((f) => f.poly),
    undefined,
    { color: th.furrow.color, alpha: th.furrow.alpha * 1.3, width: 0.5 },
  )
}

function treeLayers(R: Painter, st: Settlement, th: SettleTheme) {
  if (!st.trees.length) return
  const S = R.S
  // 投影 → 树冠 → 暗面
  const sorted = [...st.trees].sort((a, b) => a.p[1] - b.p[1])
  if (th.id === 'color') R.list.path('map', sorted.map((t) => R.circleD([t.p[0] + t.r * 0.35, t.p[1] + t.r * 0.35], t.r)).join(''), { fill: { color: 'rgb(40,50,30)', alpha: 0.25 } })
  R.list.path('map', sorted.map((t) => R.circleD(t.p, t.r)).join(''), {
    fill: { color: th.tree.fill, alpha: 1 },
    stroke: th.tree.stroke ? { color: th.tree.stroke, alpha: 0.8, width: 0.6 } : undefined,
  })
  // 暗面：右下的月牙
  const d = sorted
    .map((t) => {
      const r = t.r * S
      const x = t.p[0] * S
      const y = t.p[1] * S
      const a0 = -0.35
      const a1 = Math.PI * 0.85
      const sx = x + Math.cos(a0) * r
      const sy = y + Math.sin(a0) * r
      const ex = x + Math.cos(a1) * r
      const ey = y + Math.sin(a1) * r
      return `M${f1(sx)} ${f1(sy)}A${f1(r)} ${f1(r)} 0 0 1 ${f1(ex)} ${f1(ey)}Q${f1(x + r * 0.25)} ${f1(y + r * 0.2)} ${f1(sx)} ${f1(sy)}Z`
    })
    .join('')
  R.list.path('map', d, { fill: { color: th.tree.dark, alpha: th.id === 'ink' ? 0.45 : th.id === 'blueprint' ? 0.7 : 0.55 } })
}

// —————————————————————— 道路与城区 ——————————————————————

function roadsOuter(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  const outer = st.roads.filter((r) => r.kind === 'highway' || r.kind === 'lane')
  const casing = th.road.casing
  if (casing)
    for (const r of outer) R.lines([r.line], { color: casing, alpha: 0.9, width: (r.width + 1.6) * S, cap: 'round', join: 'round' })
  for (const r of outer) R.lines([r.line], { color: th.road.fill, alpha: 1, width: r.width * S, cap: 'round', join: 'round' })
  for (const r of st.roads.filter((r) => r.kind === 'path')) R.lines([r.line], { color: th.road.fill, alpha: 0.9, width: Math.max(1, r.width * S), cap: 'round', join: 'round', dash: th.id === 'parchment' ? undefined : undefined })
  for (const r of st.roads.filter((r) => r.kind === 'stair')) {
    R.lines([r.line], { color: casing ?? th.ink, alpha: 0.8, width: (r.width + 1) * S, cap: 'round', join: 'round' })
    R.lines([r.line], { color: th.road.fill, alpha: 1, width: r.width * S, cap: 'round', join: 'round' })
    // 台阶横纹
    const L = polylineLength(r.line)
    const ticks: P[][] = []
    for (let s = 2; s < L; s += 3) {
      const { p, angle } = pointAt(r.line, s)
      const n: P = [-Math.sin(angle) * r.width * 0.5, Math.cos(angle) * r.width * 0.5]
      ticks.push([[p[0] - n[0], p[1] - n[1]], [p[0] + n[0], p[1] + n[1]]])
    }
    R.lines(ticks, { color: th.ink, alpha: 0.45, width: 0.4 })
  }
}

function urbanGround(R: Painter, st: Settlement, th: SettleTheme) {
  const inner = st.wards.filter((w) => w.inner && w.type !== 'water')
  // 城内的地面先铺成街道色，再铺街区（院落）色：两者之间的缝就是街巷
  R.polys(inner.map((w) => w.poly), { color: th.street, alpha: 1 })
  R.polys(st.blocks, { color: th.yard, alpha: 1 }, th.id === 'ink' || th.id === 'blueprint' ? { color: th.ink, alpha: 0.35, width: 0.4 } : undefined)
  for (const g of st.greens.filter((g) => g.kind !== 'cemetery')) R.poly(g.poly, { color: th.green[g.kind], alpha: 1 })
  R.polys(st.plazas, { color: th.plaza, alpha: 1 }, { color: th.ink, alpha: 0.25, width: 0.4 })
}

/** 城内主街与街道（压在街区上，保证连续）、公园小径 */
function innerStreets(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  const main = st.roads.filter((r) => r.kind === 'main' || r.kind === 'street')
  if (th.road.casing) for (const r of main) R.lines([r.line], { color: th.road.casing, alpha: 0.35, width: (r.width + 1) * S, cap: 'round', join: 'round' })
  for (const r of main) R.lines([r.line], { color: th.street, alpha: 1, width: r.width * S, cap: 'round', join: 'round' })
  // 公园小径
  for (const r of st.roads.filter((r) => r.kind === 'path')) R.lines([r.line], { color: th.plaza, alpha: 1, width: Math.max(1, r.width * S), cap: 'round', join: 'round' })
}

function crossingLayers(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  for (const c of st.crossings) {
    const L = dist(c.a, c.b)
    const u: P = [(c.b[0] - c.a[0]) / L, (c.b[1] - c.a[1]) / L]
    const n: P = [-u[1], u[0]]
    if (c.kind === 'bridge') {
      const w = c.width / 2
      const ext = 2
      const a: P = [c.a[0] - u[0] * ext, c.a[1] - u[1] * ext]
      const b: P = [c.b[0] + u[0] * ext, c.b[1] + u[1] * ext]
      const deck: Poly = [
        [a[0] + n[0] * w, a[1] + n[1] * w],
        [b[0] + n[0] * w, b[1] + n[1] * w],
        [b[0] - n[0] * w, b[1] - n[1] * w],
        [a[0] - n[0] * w, a[1] - n[1] * w],
      ]
      if (th.shadow) R.poly(deck.map(([x, y]) => [x + 1.5, y + 1.5] as P), { color: th.shadow, alpha: 1 })
      R.poly(deck, { color: th.road.fill, alpha: 1 })
      // 护栏
      R.lines(
        [
          [deck[0], deck[1]],
          [deck[3], deck[2]],
        ],
        { color: th.ink, alpha: 0.9, width: 1.1 * Math.max(0.8, S * 0.8), cap: 'round' },
      )
      // 桥墩
      const piers = Math.max(0, Math.floor(L / 14))
      const ticks: P[][] = []
      for (let k = 1; k <= piers; k++) {
        const q: P = [c.a[0] + u[0] * (L * k) / (piers + 1), c.a[1] + u[1] * (L * k) / (piers + 1)]
        ticks.push([[q[0] + n[0] * (w + 1.4), q[1] + n[1] * (w + 1.4)], [q[0] + n[0] * (w + 0.1), q[1] + n[1] * (w + 0.1)]])
        ticks.push([[q[0] - n[0] * (w + 1.4), q[1] - n[1] * (w + 1.4)], [q[0] - n[0] * (w + 0.1), q[1] - n[1] * (w + 0.1)]])
      }
      R.lines(ticks, { color: th.ink, alpha: 0.9, width: 1.2 })
    } else if (c.kind === 'ferry') {
      R.lines([[c.a, c.b]], { color: th.ink, alpha: 0.7, width: 0.9, dash: [4, 3] })
      // 渡船
      const m: P = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]
      const boat: Poly = [
        [m[0] - u[0] * 5, m[1] - u[1] * 5],
        [m[0] + n[0] * 2, m[1] + n[1] * 2],
        [m[0] + u[0] * 5, m[1] + u[1] * 5],
        [m[0] - n[0] * 2, m[1] - n[1] * 2],
      ]
      R.poly(
        boat.map((p) => [p[0], p[1]] as P),
        { color: th.buildings('western').shed[0], alpha: 1 },
        { color: th.ink, alpha: 1, width: 0.8 },
      )
      // 两岸的小码头
      for (const e of [c.a, c.b]) {
        const s = e === c.a ? 1 : -1
        const q: P = [e[0] + u[0] * 3 * s, e[1] + u[1] * 3 * s]
        R.poly(
          [
            [q[0] + n[0] * 2 - u[0] * 4 * s, q[1] + n[1] * 2 - u[1] * 4 * s],
            [q[0] + n[0] * 2 + u[0] * 3 * s, q[1] + n[1] * 2 + u[1] * 3 * s],
            [q[0] - n[0] * 2 + u[0] * 3 * s, q[1] - n[1] * 2 + u[1] * 3 * s],
            [q[0] - n[0] * 2 - u[0] * 4 * s, q[1] - n[1] * 2 - u[1] * 4 * s],
          ],
          { color: th.plaza, alpha: 1 },
          { color: th.ink, alpha: 0.8, width: 0.6 },
        )
      }
    } else {
      // 浅滩：踏石
      const stones: string[] = []
      for (let s = 1.5; s < L; s += 2.6) stones.push(R.circleD([c.a[0] + u[0] * s + n[0] * ((s * 7) % 3 - 1.5) * 0.4, c.a[1] + u[1] * s + n[1] * ((s * 7) % 3 - 1.5) * 0.4], 0.8))
      R.list.path('map', stones.join(''), { fill: { color: th.plaza, alpha: 1 }, stroke: { color: th.ink, alpha: 0.7, width: 0.5 } })
    }
  }
}

function boatLayers(R: Painter, st: Settlement, th: SettleTheme) {
  if (!st.boats.length) return
  const hulls: Poly[] = []
  const masts: P[][] = []
  for (const b of st.boats) {
    const u: P = [Math.cos(b.angle), Math.sin(b.angle)]
    const v: P = [-u[1], u[0]]
    const L = b.len / 2
    const w = b.len * 0.17
    const at = (x: number, y: number): P => [b.p[0] + u[0] * x + v[0] * y, b.p[1] + u[1] * x + v[1] * y]
    hulls.push([at(L, 0), at(L * 0.35, w), at(-L * 0.8, w * 0.85), at(-L, 0), at(-L * 0.8, -w * 0.85), at(L * 0.35, -w)])
    if (b.len > 10) masts.push([at(L * 0.1, -w * 1.9), at(L * 0.1, w * 1.9)])
  }
  if (th.shadow) R.polys(hulls.map((h) => h.map(([x, y]) => [x + 1, y + 1] as P)), { color: th.shadow, alpha: 1 })
  R.polys(hulls, { color: th.buildings('western').shed[0], alpha: 1 }, { color: th.ink, alpha: 1, width: 0.7, join: 'round' })
  R.lines(masts, { color: th.ink, alpha: 0.9, width: 1.1, cap: 'round' })
}

function enclosureLayers(R: Painter, st: Settlement, th: SettleTheme) {
  if (!st.enclosures.length) return
  R.polys(st.enclosures, undefined, { color: th.ink, alpha: 0.7, width: Math.max(0.6, 0.7 * R.S), join: 'round' })
}

const KIND_ORDER: BuildingKind[] = ['shed', 'house', 'large', 'hall', 'temple', 'pagoda', 'keep', 'tower', 'magic']

function buildingLayers(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  const pal = th.buildings(st.params.culture)
  if (th.shadow) {
    const off = 1.6
    R.polys(
      st.buildings.filter((b) => b.kind !== 'shed').map((b) => b.poly.map(([x, y]) => [x + off, y + off] as P)),
      { color: th.shadow, alpha: 1 },
    )
  }
  const sw = th.buildingStroke.width * Math.min(1.4, Math.max(0.6, S * 0.7))
  for (const kind of KIND_ORDER) {
    const bs = st.buildings.filter((b) => b.kind === kind)
    if (!bs.length) continue
    const colors = pal[kind]
    for (let c = 0; c < colors.length; c++) {
      const group = bs.filter((b) => Math.min(colors.length - 1, Math.floor(b.tone * colors.length)) === c)
      R.polys(
        group.map((b) => b.poly),
        R.fillOf(colors[c]),
        { color: th.buildingStroke.color, alpha: 1, width: kind === 'shed' ? sw * 0.6 : kind === 'keep' || kind === 'temple' ? sw * 1.3 : sw, join: 'round' },
      )
    }
  }
  // 屋脊与戗脊：矩形房屋画成四坡顶
  if (th.roofLines) {
    const lines: P[][] = []
    for (const b of st.buildings) {
      if (b.kind === 'shed' || b.poly.length !== 4) continue
      const o = obb(b.poly)
      if (o.wid < 3) continue
      const h = Math.max(0, o.len / 2 - o.wid / 2)
      const a: P = [o.center[0] - o.axis[0] * h, o.center[1] - o.axis[1] * h]
      const e: P = [o.center[0] + o.axis[0] * h, o.center[1] + o.axis[1] * h]
      lines.push([a, e])
      // 戗脊：脊端连向最近的两个角
      for (const end of [a, e]) {
        const near = [...b.poly].sort((p, q) => dist(p, end) - dist(q, end)).slice(0, 2)
        for (const q of near) lines.push([end, q])
      }
    }
    R.lines(lines, { color: th.roofLines, alpha: 1, width: 0.45 * Math.min(1.5, S), cap: 'round' })
  }
  // 塔与法师塔：同心圆
  for (const b of st.buildings.filter((b) => b.kind === 'magic' || b.kind === 'pagoda')) {
    const c = centroid(b.poly)
    const r = Math.sqrt(Math.abs(areaOf(b.poly)) / Math.PI)
    R.list.path('map', R.circleD(c, r * 0.55) + R.circleD(c, r * 0.22), { stroke: { color: th.buildingStroke.color, alpha: 0.8, width: sw * 0.8 } })
  }
}

function areaOf(p: Poly) {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    a += p[i][0] * q[1] - q[0] * p[i][1]
  }
  return a / 2
}

function wallLayers(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  for (const w of st.walls) {
    const n = w.loop.length
    // 实心墙段（城门处断开）
    const runs: P[][] = []
    let cur: P[] = []
    const gateGap = w.kind === 'stone' ? 7 : 5
    for (let i = 0; i < n; i++) {
      const a = w.loop[i]
      const b = w.loop[(i + 1) % n]
      if (!w.solid[i]) {
        if (cur.length > 1) runs.push(cur)
        cur = []
        continue
      }
      if (!cur.length) cur.push(a)
      // 门洞
      const g = w.gates.find((g) => dist(g.p, b) < 0.5)
      const g0 = w.gates.find((g) => dist(g.p, a) < 0.5)
      if (g0 && cur.length === 1) {
        const L = dist(a, b)
        const t = Math.min(0.45, gateGap / L)
        cur = [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]]
      }
      if (g) {
        const L = dist(a, b)
        const t = Math.max(0.55, 1 - gateGap / L)
        cur.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        runs.push(cur)
        cur = []
        continue
      }
      cur.push(b)
    }
    if (cur.length > 1) runs.push(cur)
    const tw = w.thickness * S
    R.lines(runs, { color: w.kind === 'stone' ? th.wall.stroke : th.ink, alpha: 1, width: tw + 1.6, cap: 'butt', join: 'miter' })
    R.lines(runs, { color: th.wall.fill, alpha: 1, width: Math.max(0.6, tw - 1.2), cap: 'butt', join: 'miter' })
    if (w.kind === 'palisade') R.lines(runs, { color: th.ink, alpha: 0.8, width: tw * 0.6, dash: [0.9 * S, 0.9 * S] })
    // 塔楼
    const tr = w.kind === 'stone' ? w.thickness * 1.25 : w.thickness * 1.3
    const towers = w.towers.map((t) => (w.kind === 'stone' ? R.circleD(t, tr) : R.polyD(circlePoly(t, tr, 4, Math.PI / 4)))).join('')
    R.list.path('map', towers, { fill: { color: th.wall.fill, alpha: 1 }, stroke: { color: th.wall.stroke, alpha: 1, width: 1 } })
    // 城门楼：门洞两侧的方墩
    for (const g of w.gates) {
      const u: P = [Math.cos(g.angle), Math.sin(g.angle)]
      const v: P = [-u[1], u[0]]
      const s = w.kind === 'stone' ? 1 : 0.7
      for (const side of [-1, 1]) {
        const c: P = [g.p[0] + v[0] * (gateGap + 2.5 * s) * side, g.p[1] + v[1] * (gateGap + 2.5 * s) * side]
        const q: Poly = [
          [c[0] - u[0] * 5 * s - v[0] * 3 * s, c[1] - u[1] * 5 * s - v[1] * 3 * s],
          [c[0] + u[0] * 5 * s - v[0] * 3 * s, c[1] + u[1] * 5 * s - v[1] * 3 * s],
          [c[0] + u[0] * 5 * s + v[0] * 3 * s, c[1] + u[1] * 5 * s + v[1] * 3 * s],
          [c[0] - u[0] * 5 * s + v[0] * 3 * s, c[1] - u[1] * 5 * s + v[1] * 3 * s],
        ]
        R.poly(q, { color: th.wall.fill, alpha: 1 }, { color: th.wall.stroke, alpha: 1, width: 1 })
      }
    }
  }
}

// —————————————————————— 奇观 ——————————————————————

function wonderGlow(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  for (const w of st.wonders) {
    if (w.kind === 'leyline' && w.line) {
      R.lines([w.line], { color: th.magic, alpha: 0.1, width: 16 * S, cap: 'round', join: 'round' })
      R.lines([w.line], { color: th.magic, alpha: 0.18, width: 6 * S, cap: 'round', join: 'round' })
      R.lines([w.line], { color: th.magic, alpha: 0.7, width: 0.9, dash: [6, 4], cap: 'round' })
    }
  }
}

function wonderLayers(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  for (const w of st.wonders) {
    if (w.kind === 'circle') {
      const c = w.p
      R.list.path('map', R.circleD(c, w.r * 1.15), { fill: { color: th.magic, alpha: 0.08 } })
      R.list.path('map', R.circleD(c, w.r) + R.circleD(c, w.r * 0.86), { stroke: { color: th.magic, alpha: 0.85, width: 1 } })
      // 七芒星
      const pts: P[] = []
      for (let k = 0; k < 7; k++) {
        const a = -Math.PI / 2 + ((k * 3) % 7) * ((Math.PI * 2) / 7)
        pts.push([c[0] + Math.cos(a) * w.r * 0.86, c[1] + Math.sin(a) * w.r * 0.86])
      }
      R.poly(pts, undefined, { color: th.magic, alpha: 0.75, width: 0.8 })
      // 符文刻度
      const ticks: P[][] = []
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2
        const r0 = w.r * 0.88
        const r1 = w.r * (k % 3 === 0 ? 0.98 : 0.94)
        ticks.push([[c[0] + Math.cos(a) * r0, c[1] + Math.sin(a) * r0], [c[0] + Math.cos(a) * r1, c[1] + Math.sin(a) * r1]])
      }
      R.lines(ticks, { color: th.magic, alpha: 0.8, width: 0.6 })
    } else if (w.kind === 'spring') {
      R.list.path('map', R.circleD(w.p, w.r * 1.8), { fill: { color: th.magic, alpha: 0.1 } })
      R.list.path('map', R.circleD(w.p, w.r), { fill: { color: th.water, alpha: 1 }, stroke: { color: th.ink, alpha: 0.8, width: 0.8 } })
      R.list.path('map', R.circleD(w.p, w.r * 1.35) + R.circleD(w.p, w.r * 1.6), { stroke: { color: th.magic, alpha: 0.5, width: 0.6, dash: [2, 2] } })
    } else if (w.kind === 'isle') {
      // 浮空岛：地面上的投影 + 岛体（边缘崖壁）+ 岛上的塔
      const c = w.p
      const blob = (r: number, seed: number): Poly => {
        const out: Poly = []
        for (let k = 0; k < 28; k++) {
          const a = (k / 28) * Math.PI * 2
          const rr = r * (1 + 0.16 * Math.sin(a * 3 + seed) + 0.08 * Math.sin(a * 7 + seed * 2))
          out.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr * 0.8])
        }
        return out
      }
      R.poly(
        blob(w.r * 0.95, 1).map(([x, y]) => [x + w.r * 0.5, y + w.r * 0.9] as P),
        { color: '#000000', alpha: 0.12 },
      )
      const top = blob(w.r, 1)
      R.poly(
        top.map(([x, y]) => [x, y + w.r * 0.22] as P),
        { color: th.wall.fill, alpha: 1 },
        { color: th.ink, alpha: 1, width: 1 },
      )
      R.poly(top, { color: th.green.park, alpha: 1 }, { color: th.ink, alpha: 1, width: 1.1 })
      const tower = circlePoly(c, w.r * 0.16, 16)
      R.poly(tower, { color: th.buildings(st.params.culture).magic[0], alpha: 1 }, { color: th.ink, alpha: 1, width: 1 })
      const trees: string[] = []
      for (let k = 0; k < 7; k++) {
        const a = k * 2.3
        trees.push(R.circleD([c[0] + Math.cos(a) * w.r * 0.6, c[1] + Math.sin(a) * w.r * 0.45], w.r * 0.09))
      }
      R.list.path('map', trees.join(''), { fill: { color: th.tree.fill, alpha: 1 }, stroke: { color: th.tree.dark, alpha: 0.8, width: 0.6 } })
      void S
    }
  }
}

// —————————————————————— 注记 ——————————————————————

type Box = [number, number, number, number]
const overlap = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

function labelLayers(R: Painter, st: Settlement, th: SettleTheme, measurer: CanvasRenderingContext2D) {
  const S = R.S
  const list = R.list
  const placed: Box[] = []
  // 标题框的保留区
  placed.push([0, 0, 460, 140])
  placed.push([list.MW - 150, list.MH - 70, list.MW, list.MH])
  placed.push([list.MW - 90, 0, list.MW, 110])
  const fontOf = (kind: string) => {
    const f = th.font
    switch (kind) {
      case 'water':
        return `italic 500 26px ${f.label}`
      case 'river':
        return `italic 500 17px ${f.label}`
      case 'district':
        return `600 15px ${f.label}`
      case 'street':
        return `400 11px ${f.label}`
      case 'hill':
        return `600 17px ${f.label}`
      default:
        return `600 12.5px ${f.label}`
    }
  }
  const colorOf = (kind: string) => (kind === 'water' || kind === 'river' ? th.label.water : kind === 'district' ? th.label.district : th.label.color)
  const halo = (t: string, x: number, y: number, font: string, m?: [number, number, number, number, number, number], w = 3.2) => {
    list.text('map', { t, x, y, font, align: 'middle', baseline: 'central', stroke: { color: th.label.halo, alpha: 0.85, width: w }, m, opacity: 1, bbox: [x - 200, y - 40, x + 200, y + 40] })
  }
  const text = (t: string, x: number, y: number, font: string, color: string, m?: [number, number, number, number, number, number]) => {
    list.text('map', { t, x, y, font, align: 'middle', baseline: 'central', fill: { color, alpha: 1 }, m, opacity: 1, bbox: [x - 200, y - 40, x + 200, y + 40] })
  }
  const labels = [...st.labels].sort((a, b) => b.weight - a.weight)
  for (const l of labels) {
    const font = fontOf(l.kind)
    measurer.font = font
    const color = colorOf(l.kind)
    const size = parseFloat(font.match(/([\d.]+)px/)![1])
    const spacing = l.kind === 'district' ? 4 : l.kind === 'water' ? 8 : l.kind === 'river' ? 5 : 1
    if (l.path) {
      // 沿路径逐字排布
      const path = l.path.map(([x, y]) => [x * S, y * S] as P)
      const chars = [...l.text]
      const widths = chars.map((c) => measurer.measureText(c).width + spacing)
      const total = widths.reduce((a, b) => a + b, 0)
      const L = polylineLength(path)
      if (L < total + 10) continue
      // 路径方向：保证文字不倒置
      let pp = path
      const mid = pointAt(path, L / 2)
      if (Math.cos(mid.angle) < 0) pp = [...path].reverse()
      // 选几个起点，挑不冲突的
      let ok = false
      for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) {
        let s = L * f - total / 2
        if (s < 0 || s + total > L) continue
        const boxes: Box[] = []
        const glyphs: { c: string; p: P; a: number }[] = []
        for (let i = 0; i < chars.length; i++) {
          const g = pointAt(pp, s + widths[i] / 2)
          glyphs.push({ c: chars[i], p: g.p, a: g.angle })
          boxes.push([g.p[0] - size * 0.6, g.p[1] - size * 0.6, g.p[0] + size * 0.6, g.p[1] + size * 0.6])
          s += widths[i]
        }
        if (boxes.some((b) => placed.some((q) => overlap(b, q)))) continue
        // 过弯太急的不放
        let bend = 0
        for (let i = 1; i < glyphs.length; i++) {
          let d = Math.abs(glyphs[i].a - glyphs[i - 1].a)
          if (d > Math.PI) d = Math.PI * 2 - d
          bend = Math.max(bend, d)
        }
        if (bend > 0.6) continue
        placed.push(...boxes)
        for (const g of glyphs) {
          const c = Math.cos(g.a)
          const sn = Math.sin(g.a)
          const m: [number, number, number, number, number, number] = [c, sn, -sn, c, g.p[0], g.p[1]]
          halo(g.c, 0, 0, font, m, l.kind === 'street' ? 2.6 : 3.4)
        }
        for (const g of glyphs) {
          const c = Math.cos(g.a)
          const sn = Math.sin(g.a)
          text(g.c, 0, 0, font, color, [c, sn, -sn, c, g.p[0], g.p[1]])
        }
        ok = true
        break
      }
      void ok
      continue
    }
    const x = l.p[0] * S
    let y = l.p[1] * S
    if (l.kind === 'landmark') y -= 13
    const chars = [...l.text]
    const w = chars.reduce((s, c) => s + measurer.measureText(c).width + spacing, -spacing)
    const box: Box = [x - w / 2 - 3, y - size * 0.75, x + w / 2 + 3, y + size * 0.75 + (l.sub ? size : 0)]
    if (placed.some((q) => overlap(box, q))) continue
    placed.push(box)
    if (x < 10 || y < 10 || x > list.MW - 10 || y > list.MH - 10) continue
    // 字距：逐字放置
    let cx = x - w / 2
    const glyphs: { c: string; x: number }[] = []
    for (const c of chars) {
      const cw = measurer.measureText(c).width
      glyphs.push({ c, x: cx + cw / 2 })
      cx += cw + spacing
    }
    for (const g of glyphs) halo(g.c, g.x, y, font, undefined, l.kind === 'water' ? 0 : 3.4)
    for (const g of glyphs) text(g.c, g.x, y, font, color)
    if (l.sub) {
      const sf = `400 10px ${th.font.label}`
      halo(l.sub, x, y + size, sf)
      text(l.sub, x, y + size, sf, color)
    }
  }
  // 地标的小圆点
  const dots: string[] = []
  for (const l of st.landmarks) if (l.kind === 'well') dots.push(R.circleD(l.p, 1.6))
  if (dots.length) list.path('map', dots.join(''), { fill: { color: th.water, alpha: 1 }, stroke: { color: th.ink, alpha: 0.9, width: 0.8 } })
}

// —————————————————————— 图廓 ——————————————————————

function furniture(list: DisplayList, st: Settlement, th: SettleTheme, S: number, M: number, MW: number, MH: number, measurer: CanvasRenderingContext2D) {
  const ink = th.frame
  // 图框：内细外粗
  list.path('page', `M${M} ${M}H${M + MW}V${M + MH}H${M}Z`, { stroke: { color: ink, alpha: 1, width: 1.4 } })
  list.path('page', `M${M - 8} ${M - 8}H${M + MW + 8}V${M + MH + 8}H${M - 8}Z`, { stroke: { color: ink, alpha: 1, width: 2.6 } })
  // 标题框
  const tx = M + 22
  const ty = M + 22
  const zhFont = st.params.culture === 'eastern' && th.id !== 'blueprint' ? `400 44px "Ma Shan Zheng", ${th.font.label}` : `600 40px ${th.font.label}`
  measurer.font = zhFont
  const tw = Math.max(measurer.measureText(st.nameZh).width, 200)
  const bw = tw + 60
  const bh = 104
  list.path('page', `M${tx} ${ty}h${bw}v${bh}h${-bw}Z`, { fill: { color: th.paper, alpha: 0.9 }, stroke: { color: ink, alpha: 1, width: 1.2 } })
  list.path('page', `M${tx + 4} ${ty + 4}h${bw - 8}v${bh - 8}h${-(bw - 8)}Z`, { stroke: { color: ink, alpha: 0.6, width: 0.6 } })
  list.text('page', { t: st.nameZh, x: tx + bw / 2, y: ty + 44, font: zhFont, align: 'middle', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: [tx, ty, tx + bw, ty + bh] })
  const sub = `${st.name} · ${SIZE_ZH[st.params.size]} · 约 ${st.stats.population.toLocaleString()} 人`
  list.text('page', { t: sub, x: tx + bw / 2, y: ty + 80, font: `italic 400 14px ${th.font.italic.replace(/^italic /, '')}`, align: 'middle', baseline: 'central', fill: { color: th.label.color, alpha: 0.85 }, opacity: 1, bbox: [tx, ty, tx + bw, ty + bh] })
  // 比例尺
  const niceM = [20, 25, 50, 100, 200, 250, 500][[20, 25, 50, 100, 200, 250, 500].findIndex((m) => m * S > 120)] ?? 500
  const len = niceM * S
  const sx = M + MW - len - 30
  const sy = M + MH - 30
  list.path('page', `M${sx - 10} ${sy - 22}h${len + 30}v${38}h${-(len + 30)}Z`, { fill: { color: th.paper, alpha: 0.85 } })
  for (let k = 0; k < 4; k++) list.path('page', `M${sx + (len * k) / 4} ${sy}h${len / 4}v5h${-len / 4}Z`, { fill: { color: k % 2 ? th.paper : ink, alpha: 1 }, stroke: { color: ink, alpha: 1, width: 0.8 } })
  for (const [k, t] of [
    [0, '0'],
    [1, `${niceM} m`],
  ] as const)
    list.text('page', { t, x: sx + len * k, y: sy - 9, font: `400 11px ${th.font.label}`, align: 'middle', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: [sx - 20, sy - 20, sx + len + 20, sy] })
  // 指北针
  const nx = M + MW - 50
  const ny = M + 58
  list.path('page', `M${nx} ${ny - 30}L${nx + 9} ${ny + 8}L${nx} ${ny + 2}Z`, { fill: { color: ink, alpha: 1 } })
  list.path('page', `M${nx} ${ny - 30}L${nx - 9} ${ny + 8}L${nx} ${ny + 2}Z`, { fill: { color: th.paper, alpha: 1 }, stroke: { color: ink, alpha: 1, width: 1 } })
  list.path('page', `M${nx + 16} ${ny - 4}A16 16 0 1 1 ${nx - 16} ${ny - 4}A16 16 0 1 1 ${nx + 16} ${ny - 4}Z`, { stroke: { color: ink, alpha: 0.6, width: 0.8 } })
  list.text('page', { t: 'N', x: nx, y: ny - 42, font: `600 14px ${th.font.title}`, align: 'middle', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: [nx - 10, ny - 52, nx + 10, ny - 32] })
}

/** 字体加载：中文按实际用到的字取子集 */
export async function ensureSettleFonts(st: Settlement, style: SettleStyleId) {
  const th = settleTheme(style)
  const text = [st.nameZh, st.name, ...st.labels.map((l) => l.text + (l.sub ?? '')), '城镇市村约人'].join('')
  const fams = new Set<string>()
  for (const f of [th.font.title, th.font.label]) for (const x of f.split(',')) if (x.includes('"')) fams.add(x.trim().replace(/^italic /, ''))
  if (st.params.culture === 'eastern') fams.add('"Ma Shan Zheng"')
  const loads: Promise<unknown>[] = []
  for (const fam of fams) for (const w of ['400', '600', 'italic 400']) loads.push(document.fonts.load(`${w} 20px ${fam}`, text))
  try {
    await Promise.all(loads)
  } catch {
    // 字体加载失败回退系统字体
  }
}
