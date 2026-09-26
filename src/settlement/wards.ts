import { clipWater, placeable, type Ctx } from './ctx'
import {
  area,
  centroid,
  circlePoly,
  clipHalf,
  dist,
  insetConvex,
  obb,
  pointInPoly,
  rect,
  segDist,
  splitConvex,
  type P,
  type Poly,
} from './geom'
import type { BuildingKind, Ward } from './types'

/** 地块细分参数 */
interface Dens {
  /** 地块目标面积上限 / 下限（m²） */
  maxA: number
  minA: number
  /** 小巷宽与出现概率 */
  alley: number
  alleyP: number
  /** 临街进深（米）：更深的部分留作后院 */
  depth: number
  /** 建房概率 */
  fill: number
  /** 切分的不规则程度 */
  irr: number
  kind?: BuildingKind
}

const DENS: Record<string, Dens> = {
  merchant: { maxA: 230, minA: 60, alley: 2.4, alleyP: 0.3, depth: 22, fill: 0.97, irr: 0.55 },
  market: { maxA: 180, minA: 50, alley: 2.4, alleyP: 0.4, depth: 14, fill: 0.97, irr: 0.6 },
  common: { maxA: 170, minA: 45, alley: 2, alleyP: 0.35, depth: 17, fill: 0.94, irr: 0.8 },
  craft: { maxA: 250, minA: 60, alley: 2.6, alleyP: 0.3, depth: 19, fill: 0.9, irr: 0.7 },
  slum: { maxA: 75, minA: 22, alley: 1.6, alleyP: 0.55, depth: 14, fill: 0.92, irr: 1.25 },
  harbor: { maxA: 480, minA: 110, alley: 3.2, alleyP: 0.45, depth: 24, fill: 0.86, irr: 0.35, kind: 'large' },
  suburb: { maxA: 240, minA: 60, alley: 2.4, alleyP: 0.25, depth: 14, fill: 0.72, irr: 0.9 },
  village: { maxA: 520, minA: 140, alley: 0, alleyP: 0, depth: 13, fill: 0.62, irr: 1.0 },
  hamlet: { maxA: 700, minA: 160, alley: 0, alleyP: 0, depth: 12, fill: 0.5, irr: 1.0 },
}

interface Lot {
  poly: Poly
  /** 临街边（在街区边界或小巷边上）的序号 */
  front: number[]
}

type Seg = [P, P]

const rot = (v: P, a: number): P => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)]

/** 多边形上落在直线 (o, n) 上的边 */
function edgesOnLine(poly: Poly, o: P, n: P): Seg[] {
  const out: Seg[] = []
  const side = (p: P) => Math.abs((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1])
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if (side(a) < 1e-4 && side(b) < 1e-4) out.push([a, b])
  }
  return out
}

/**
 * 递归二分街区：每次沿最小外接矩形的长轴垂直切开，面积大时留出小巷。
 * 返回地块及其临街边；不临街的地块是院落内部。
 */
export function subdivide(ctx: Ctx, block: Poly, o: Dens): Lot[] {
  const rng = ctx.rng
  const fronts: Seg[] = block.map((p, i) => [p, block[(i + 1) % block.length]] as Seg)
  const lots: Poly[] = []
  const rec = (poly: Poly, depth: number) => {
    const a = area(poly)
    const target = o.maxA * (0.55 + rng.next() * 0.9)
    const b = obb(poly)
    // 过于细长的地块继续切，即使面积已经够小
    if ((a < target && b.len < b.wid * 3.2) || depth > 16 || a < o.minA * 1.6) {
      lots.push(poly)
      return
    }
    const jit = (rng.next() - 0.5) * 0.4 * o.irr
    const dir = rot([-b.axis[1], b.axis[0]], jit)
    const t = (rng.next() - 0.5) * 0.36 * o.irr
    const c: P = [b.center[0] + b.axis[0] * t * b.len, b.center[1] + b.axis[1] * t * b.len]
    const gap = a > o.maxA * 5 && rng.next() < o.alleyP ? o.alley : 0
    const [p1, p2] = splitConvex(poly, c, dir, gap)
    if (gap > 0) {
      const L = Math.hypot(dir[0], dir[1])
      const n: P = [-dir[1] / L, dir[0] / L]
      fronts.push(...edgesOnLine(p1, [c[0] - n[0] * gap / 2, c[1] - n[1] * gap / 2], n))
      fronts.push(...edgesOnLine(p2, [c[0] + n[0] * gap / 2, c[1] + n[1] * gap / 2], n))
    }
    for (const q of [p1, p2]) if (q.length >= 3 && area(q) > o.minA * 0.4) rec(q, depth + 1)
  }
  rec(block, 0)
  return lots.map((poly) => {
    const front: number[] = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      if (dist(a, b) < 0.8) continue
      const m: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      if (fronts.some(([s0, s1]) => segDist(m, s0, s1).d < 0.35)) front.push(i)
    }
    return { poly, front }
  })
}

/** 地块 → 房屋：只保留临街进深，后部留作院子 */
function lotBuilding(lot: Lot, depth: number): Poly | null {
  const { poly, front } = lot
  if (!front.length) return null
  // 取最长的临街边
  let fi = front[0]
  let fl = 0
  for (const i of front) {
    const l = dist(poly[i], poly[(i + 1) % poly.length])
    if (l > fl) {
      fl = l
      fi = i
    }
  }
  const a = poly[fi]
  const b = poly[(fi + 1) % poly.length]
  const c = centroid(poly)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L = Math.hypot(dx, dy)
  let nx = -dy / L
  let ny = dx / L
  if ((c[0] - a[0]) * nx + (c[1] - a[1]) * ny < 0) {
    nx = -nx
    ny = -ny
  }
  // 拐角地块（两条不平行的临街边）整块建满
  const corner = front.some((i) => {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const ex = (q[0] - p[0]) / (dist(p, q) || 1)
    const ey = (q[1] - p[1]) / (dist(p, q) || 1)
    return Math.abs(ex * nx + ey * ny) > 0.5
  })
  if (corner) return poly
  const out = clipHalf(poly, [a[0] + nx * depth, a[1] + ny * depth], [nx, ny])
  return out.length >= 3 && area(out) > 12 ? out : null
}

function addBuilding(ctx: Ctx, poly: Poly, kind: BuildingKind = 'house') {
  const b = obb(poly)
  ctx.out.buildings.push({ poly, kind, tone: ctx.rng.next(), ridge: Math.atan2(b.axis[1], b.axis[0]) })
}

function overlaps(poly: Poly, zones: Poly[]) {
  for (const z of zones) {
    if (pointInPoly(centroid(poly), z)) return true
    for (const v of poly) if (pointInPoly(v, z)) return true
    for (const v of z) if (pointInPoly(v, poly)) return true
  }
  return false
}

/** 普通街区：切地块、建临街房屋，院落里偶尔种树 */
export function urban(ctx: Ctx, block: Poly, densKey: string, reserve: Poly[] = [], nearRoad = Infinity) {
  const base = DENS[densKey]
  const rng = ctx.rng
  const o = { ...base }
  const lots = subdivide(ctx, block, o)
  for (const lot of lots) {
    if (reserve.length && overlaps(lot.poly, reserve)) continue
    const c = centroid(lot.poly)
    // 郊区与村落：只沿路建房
    if (nearRoad < Infinity && ctx.corridors.gap(c) > nearRoad) {
      if (rng.next() < 0.18) scatterTrees(ctx, insetConvex(lot.poly, 2), 0.004, 2.5, 4.5)
      continue
    }
    if (densKey === 'village' || densKey === 'hamlet') {
      if (rng.next() < o.fill) farmstead(ctx, lot)
      else if (rng.next() < 0.4) scatterTrees(ctx, insetConvex(lot.poly, 2), 0.004, 2.5, 4.5)
      continue
    }
    let b = rng.next() < o.fill ? lotBuilding(lot, o.depth * (0.75 + rng.next() * 0.5)) : null
    // 院落深处偶有后屋、作坊
    if (!b && !lot.front.length && nearRoad === Infinity && rng.next() < (densKey === 'slum' ? 0.75 : 0.3)) {
      const bb = obb(lot.poly)
      if (bb.wid > 5) b = rect(bb.center, bb.axis, bb.len * 0.6, bb.wid * 0.6)
    }
    if (!b) {
      if (!lot.front.length && area(lot.poly) > 60 && rng.next() < 0.35) scatterTrees(ctx, insetConvex(lot.poly, 1.5), 0.01, 2, 3.5)
      continue
    }
    b = insetConvex(b, 0.2)
    if (b.length < 3) continue
    const q = placeable(ctx, b)
    if (!q || area(q) < 14) continue
    addBuilding(ctx, q, o.kind ?? (area(q) > 420 ? 'large' : 'house'))
  }
}

/** 农舍：临路的正屋、屋后或屋侧的谷仓，篱笆围起的院子与果树 */
function farmstead(ctx: Ctx, lot: Lot) {
  const rng = ctx.rng
  const { poly, front } = lot
  if (!front.length) return
  let fi = front[0]
  for (const i of front) if (dist(poly[i], poly[(i + 1) % poly.length]) > dist(poly[fi], poly[(fi + 1) % poly.length])) fi = i
  const a = poly[fi]
  const b = poly[(fi + 1) % poly.length]
  const L = dist(a, b)
  if (L < 9) return
  const u: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  const c0 = centroid(poly)
  let n: P = [-u[1], u[0]]
  if ((c0[0] - a[0]) * n[0] + (c0[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]]
  if (ctx.p.culture === 'eastern') {
    // 东方农家：小院，正房坐北
    const yard = clipHalf(poly, [a[0] + n[0] * 26, a[1] + n[1] * 26], n)
    const q = yard.length >= 3 ? placeable(ctx, insetConvex(yard, 1)) : null
    if (q && area(q) > 80) siheyuan(ctx, q)
    return
  }
  const len = Math.min(L * 0.7, 9 + rng.next() * 5)
  const dep = 6 + rng.next() * 2.5
  const slide = (rng.next() - 0.5) * Math.max(0, L - len) * 0.6
  const m: P = [(a[0] + b[0]) / 2 + u[0] * slide, (a[1] + b[1]) / 2 + u[1] * slide]
  const hc: P = [m[0] + n[0] * (2.5 + dep / 2), m[1] + n[1] * (2.5 + dep / 2)]
  const house = placeable(ctx, rect(hc, u, len, dep))
  if (!house || !house.every((v) => pointInPoly(v, poly))) return
  addBuilding(ctx, house, 'house')
  if (rng.next() < 0.65) {
    const side = rng.next() < 0.5
    const bl = 7 + rng.next() * 4
    const bw = 5 + rng.next() * 1.5
    const sg = slide > 0 ? -1 : 1
    const bc: P = side
      ? [hc[0] + u[0] * (len / 2 + bw / 2 + 2) * sg, hc[1] + u[1] * (len / 2 + bw / 2 + 2) * sg]
      : [hc[0] + n[0] * (dep / 2 + bw / 2 + 4), hc[1] + n[1] * (dep / 2 + bw / 2 + 4)]
    const barn = placeable(ctx, side ? rect([bc[0] + n[0] * 2, bc[1] + n[1] * 2], n, bl, bw) : rect(bc, u, bl, bw))
    if (barn && barn.every((v) => pointInPoly(v, poly))) addBuilding(ctx, barn, 'shed')
  }
  const fence = insetConvex(poly, 0.8)
  if (fence.length >= 3 && rng.next() < 0.55) ctx.out.enclosures.push(fence)
  if (rng.next() < 0.6) scatterTrees(ctx, clipHalf(insetConvex(poly, 2), [hc[0] + n[0] * (dep / 2 + 3), hc[1] + n[1] * (dep / 2 + 3)], [-n[0], -n[1]]), 0.003, 2.2, 3.6)
}

export function scatterTrees(ctx: Ctx, poly: Poly, density: number, r0: number, r1: number) {
  if (poly.length < 3) return
  const rng = ctx.rng
  const n = Math.round(area(poly) * density * (0.6 + rng.next() * 0.8))
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of poly) {
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  for (let k = 0, placed = 0; k < n * 4 && placed < n; k++) {
    const p: P = [x0 + rng.next() * (x1 - x0), y0 + rng.next() * (y1 - y0)]
    if (!pointInPoly(p, poly)) continue
    if (ctx.T.waterAt(p) < 2 || ctx.corridors.hits(p, 1)) continue
    ctx.out.trees.push({ p, r: r0 + rng.next() * (r1 - r0) })
    placed++
  }
}

// —————————————————————— 各类片区 ——————————————————————

export function plaza(ctx: Ctx, _ward: Ward, block: Poly) {
  const rng = ctx.rng
  const pave = clipWater(ctx, block, 1) ?? block
  ctx.out.plazas.push(pave)
  const c = centroid(pave)
  const reserve: Poly[] = []
  // 市政厅 / 鼓楼
  const size = ctx.p.size
  if (size === 'town' || size === 'city') {
    const b = obb(pave)
    const L = Math.min(b.len * 0.42, size === 'city' ? 34 : 24)
    const Wd = L * 0.5
    const hc: P = [c[0] + b.axis[1] * b.wid * 0.2, c[1] - b.axis[0] * b.wid * 0.2]
    const hall = ctx.p.culture === 'eastern' ? rect(c, [1, 0], 14, 14) : rect(hc, b.axis, L, Wd)
    if (placeable(ctx, hall)) {
      addBuilding(ctx, hall, ctx.p.culture === 'eastern' ? 'tower' : 'hall')
      reserve.push(hall)
      ctx.out.landmarks.push({ p: centroid(hall), name: ctx.namer.landmark('market', ctx.p.magic), kind: 'market' })
    }
    // 摊位
    const stalls = size === 'city' ? 26 : 12
    for (let k = 0, t = 0; k < stalls && t < stalls * 8; t++) {
      const p: P = [c[0] + (rng.next() - 0.5) * b.len * 0.8, c[1] + (rng.next() - 0.5) * b.len * 0.8]
      const s = rect(p, b.axis, 3 + rng.next() * 2, 2.2 + rng.next())
      if (!s.every((v) => pointInPoly(v, insetConvex(pave, 4)))) continue
      if (overlaps(s, reserve)) continue
      reserve.push(insetConvex(rect(p, b.axis, 7, 5.5), 0))
      addBuilding(ctx, s, 'shed')
      k++
    }
  }
  ctx.out.landmarks.push({ p: [c[0] - 6, c[1] + 8], name: '井', kind: 'well' })
}

export function temple(ctx: Ctx, _ward: Ward, block: Poly) {
  const rng = ctx.rng
  const inner = insetConvex(block, 10)
  if (inner.length < 3) return urban(ctx, block, 'common')
  const b = obb(inner)
  const c = centroid(inner)
  const big = ctx.p.size === 'city'
  const reserve: Poly[] = []
  if (ctx.p.culture === 'eastern') {
    const comp = eastCompound(ctx, inner, 'temple')
    if (comp) reserve.push(comp)
  } else {
    // 大教堂：东西向的中殿 + 耳堂 + 半圆后殿（尽量朝东）
    const east: P = Math.abs(b.axis[0]) > 0.5 ? (b.axis[0] > 0 ? b.axis : [-b.axis[0], -b.axis[1]]) : b.axis
    const L = Math.min(b.len * 0.78, big ? 78 : 46)
    const Wn = L * 0.27
    const parts: Poly[] = []
    parts.push(rect(c, east, L, Wn))
    const tc: P = [c[0] + east[0] * L * 0.18, c[1] + east[1] * L * 0.18]
    parts.push(rect(tc, east, Wn * 0.95, Wn * 2.25))
    const ac: P = [c[0] + east[0] * L * 0.5, c[1] + east[1] * L * 0.5]
    const apse = circlePoly(ac, Wn * 0.5, 14).filter((p) => (p[0] - ac[0]) * east[0] + (p[1] - ac[1]) * east[1] >= -0.01)
    parts.push(apse)
    if (big) {
      // 西立面双塔
      for (const s of [-1, 1]) {
        const w: P = [c[0] - east[0] * L * 0.5 + east[1] * s * Wn * 0.42, c[1] - east[1] * L * 0.5 - east[0] * s * Wn * 0.42]
        parts.push(rect(w, east, Wn * 0.4, Wn * 0.4))
      }
    }
    const zone = rect(c, east, L + 18, Wn * 2.25 + 18)
    reserve.push(zone)
    for (const q of parts) addBuilding(ctx, q, 'temple')
    // 教堂前的广场与墓园
    ctx.out.plazas.push(insetConvex(rect([c[0] - east[0] * (L * 0.5 + 8), c[1] - east[1] * (L * 0.5 + 8)], east, 16, Wn * 2), 0))
    const yard = insetConvex(block, 3)
    graves(ctx, rect([c[0] + east[1] * Wn * 1.9, c[1] - east[0] * Wn * 1.9], east, L * 0.7, Wn * 1.2), east)
    if (yard.length >= 3) scatterTrees(ctx, rect([c[0] - east[1] * Wn * 1.9, c[1] + east[0] * Wn * 1.9], east, L * 0.7, Wn * 1.1), 0.006, 2.5, 4)
  }
  ctx.out.landmarks.push({ p: c, name: ctx.namer.landmark('temple', ctx.p.magic), kind: 'temple' })
  // 外圈仍是街坊
  urban(ctx, block, 'common', reserve)
  void rng
}

function graves(ctx: Ctx, zone: Poly, axis: P) {
  const b = obb(zone)
  const rng = ctx.rng
  ctx.out.greens.push({ poly: zone, kind: 'cemetery' })
  const across: P = [-axis[1], axis[0]]
  for (let u = -b.len / 2 + 3; u < b.len / 2 - 2; u += 3.2)
    for (let v = -b.wid / 2 + 3; v < b.wid / 2 - 2; v += 4.2) {
      if (rng.next() < 0.25) continue
      const p: P = [b.center[0] + axis[0] * u + across[0] * v, b.center[1] + axis[1] * u + across[1] * v]
      addBuilding(ctx, rect(p, across, 1.9, 0.9), 'shed')
    }
}

export function cemetery(ctx: Ctx, ward: Ward, block: Poly) {
  const zone = clipWater(ctx, insetConvex(block, 3), 3)
  if (!zone || zone.length < 3) return
  const b = obb(zone)
  graves(ctx, zone, b.axis)
  ctx.out.enclosures.push(zone)
  const chapel = rect(b.center, b.axis, 12, 7)
  addBuilding(ctx, chapel, ctx.p.culture === 'eastern' ? 'hall' : 'temple')
  scatterTrees(ctx, zone, 0.002, 3, 5)
  void ward
}

export function park(ctx: Ctx, ward: Ward, block: Poly) {
  const g = clipWater(ctx, insetConvex(block, 2), 2)
  if (!g || g.length < 3) return
  ctx.out.greens.push({ poly: g, kind: 'park' })
  const c = centroid(g)
  const b = obb(g)
  // 小径：从各边中点通向中心
  for (let i = 0; i < g.length; i++) {
    if (ctx.rng.next() < 0.4) continue
    const a = g[i]
    const e = g[(i + 1) % g.length]
    const m: P = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2]
    const mid: P = [(m[0] + c[0]) / 2 + (ctx.rng.next() - 0.5) * 12, (m[1] + c[1]) / 2 + (ctx.rng.next() - 0.5) * 12]
    ctx.out.roads.push({ line: [m, mid, c], width: 2.2, kind: 'path' })
  }
  if (ctx.p.culture === 'eastern') addBuilding(ctx, rect(c, b.axis, 9, 6), 'pagoda')
  else ctx.out.landmarks.push({ p: c, name: '', kind: 'well' })
  scatterTrees(ctx, g, 0.006, 2.5, 5.5)
  if (ctx.rng.next() < 0.6) ctx.out.landmarks.push({ p: c, name: ctx.namer.landmark('park', ctx.p.magic), kind: 'shrine' })
  void ward
}

/** 城堡 / 衙署：幕墙、角楼、主楼与沿墙的附属建筑 */
export function castle(ctx: Ctx, ward: Ward, block: Poly) {
  const rng = ctx.rng
  const curtain = clipWater(ctx, insetConvex(block, 4), 4)
  if (!curtain || curtain.length < 3) return urban(ctx, block, 'common')
  const c = centroid(curtain)
  ctx.out.landmarks.push({ p: c, name: ctx.namer.landmark('castle', ctx.p.magic), kind: 'castle' })
  if (ctx.p.culture === 'eastern') {
    if (!eastCompound(ctx, curtain, 'palace')) eastWard(ctx, block, true)
    return
  }
  ctx.out.plazas.push(curtain)
  // 幕墙作为一圈"城墙"
  const toCenter: P = [ctx.center[0] - c[0], ctx.center[1] - c[1]]
  let gi = 0
  let gd = -Infinity
  for (let i = 0; i < curtain.length; i++) {
    const a = curtain[i]
    const e = curtain[(i + 1) % curtain.length]
    const m: P = [(a[0] + e[0]) / 2 - c[0], (a[1] + e[1]) / 2 - c[1]]
    const s = (m[0] * toCenter[0] + m[1] * toCenter[1]) / (Math.hypot(...m) || 1)
    if (s > gd && dist(a, e) > 14) {
      gd = s
      gi = i
    }
  }
  const ga = curtain[gi]
  const gb = curtain[(gi + 1) % curtain.length]
  const gp: P = [(ga[0] + gb[0]) / 2, (ga[1] + gb[1]) / 2]
  ctx.out.walls.push({
    loop: curtain,
    solid: curtain.map(() => true),
    towers: curtain.slice(),
    gates: [{ p: gp, angle: Math.atan2(gb[1] - ga[1], gb[0] - ga[0]) + Math.PI / 2 }],
    kind: 'stone',
    thickness: 3.2,
  })
  // 主楼
  const b = obb(curtain)
  const away: P = [c[0] - toCenter[0] / (Math.hypot(...toCenter) || 1) * b.wid * 0.12, c[1] - toCenter[1] / (Math.hypot(...toCenter) || 1) * b.wid * 0.12]
  const ks = Math.min(24, Math.sqrt(area(curtain)) * 0.3)
  addBuilding(ctx, rect(away, b.axis, ks, ks * (0.8 + rng.next() * 0.3)), 'keep')
  // 沿墙的附属建筑
  const inner = insetConvex(curtain, 2.5)
  for (let i = 0; i < inner.length; i++) {
    if (i === gi || rng.next() < 0.35) continue
    const a = inner[i]
    const e = inner[(i + 1) % inner.length]
    const L = dist(a, e)
    if (L < 16) continue
    const t0 = 0.15 + rng.next() * 0.2
    const t1 = 0.65 + rng.next() * 0.2
    const u: P = [(e[0] - a[0]) / L, (e[1] - a[1]) / L]
    const n: P = [-u[1], u[0]]
    const s = (c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] > 0 ? 1 : -1
    const d = 7 + rng.next() * 3
    const mid: P = [a[0] + u[0] * L * ((t0 + t1) / 2) + n[0] * s * d / 2, a[1] + u[1] * L * ((t0 + t1) / 2) + n[1] * s * d / 2]
    addBuilding(ctx, rect(mid, u, L * (t1 - t0), d), 'hall')
  }
  // 堡外的片区剩余部分
  void ward
}

export function noble(ctx: Ctx, ward: Ward, block: Poly) {
  const rng = ctx.rng
  const lots = subdivide(ctx, block, { maxA: ctx.p.size === 'city' ? 1500 : 1000, minA: 350, alley: 0, alleyP: 0, depth: 20, fill: 1, irr: 0.5 })
  for (const lot of lots) {
    const encl = placeable(ctx, insetConvex(lot.poly, 0.8), 3)
    if (!encl || encl.length < 3) continue
    if (ctx.p.culture === 'eastern') {
      siheyuan(ctx, encl)
      continue
    }
    ctx.out.enclosures.push(encl)
    ctx.out.greens.push({ poly: encl, kind: 'garden' })
    const b = obb(encl)
    // 宅邸靠临街一侧
    let shift: P = [0, 0]
    if (lot.front.length) {
      const i = lot.front[0]
      const a = lot.poly[i]
      const e = lot.poly[(i + 1) % lot.poly.length]
      const m: P = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2]
      shift = [(m[0] - b.center[0]) * 0.35, (m[1] - b.center[1]) * 0.35]
    }
    const hc: P = [b.center[0] + shift[0], b.center[1] + shift[1]]
    const house = rect(hc, b.axis, b.len * (0.4 + rng.next() * 0.15), b.wid * (0.35 + rng.next() * 0.1))
    const clipped = insetConvex(house, 0)
    if (clipped.every((v) => pointInPoly(v, encl))) addBuilding(ctx, clipped, 'large')
    scatterTrees(ctx, insetConvex(encl, 2), 0.004, 2.5, 4.5)
  }
  void ward
}

export function harbor(ctx: Ctx, ward: Ward, block: Poly) {
  urban(ctx, block, 'harbor')
  // 码头：从岸边垂直伸入水中
  const rng = ctx.rng
  const seaSide = ctx.p.coast
  const L0 = seaSide ? 34 : 12
  const pts: P[] = []
  const per = ward.poly
  for (let i = 0; i < per.length; i++) {
    const a = per[i]
    const e = per[(i + 1) % per.length]
    const n = Math.ceil(dist(a, e) / 6)
    for (let k = 0; k < n; k++) pts.push([a[0] + ((e[0] - a[0]) * k) / n, a[1] + ((e[1] - a[1]) * k) / n])
  }
  const placed: P[] = []
  for (const q of pts) {
    const w = ctx.T.waterAt(q)
    if (w > 2 || w < -6) continue
    if (placed.some((x) => dist(x, q) < (seaSide ? 34 : 26))) continue
    const g = ctx.T.waterGrad(q)
    const L = L0 * (0.7 + rng.next() * 0.6)
    const end: P = [q[0] - g[0] * (L + w), q[1] - g[1] * (L + w)]
    if (ctx.T.waterAt(end) > -3) continue
    if (seaSide && !ctx.T.seaAt(end)) continue
    const mid: P = [(q[0] + end[0]) / 2, (q[1] + end[1]) / 2]
    const pier = rect(mid, [-g[0], -g[1]], L + w + 3, seaSide ? 6 : 4)
    if (ctx.corridors.hits(mid, 2)) continue
    ctx.out.piers.push(pier)
    placed.push(q)
    const n: P = [-g[1], g[0]]
    for (const sd of [-1, 1])
      if (rng.next() < 0.75) {
        const t = 0.35 + rng.next() * 0.5
        const bp: P = [q[0] - g[0] * (L + w) * t + n[0] * (seaSide ? 8 : 5) * sd, q[1] - g[1] * (L + w) * t + n[1] * (seaSide ? 8 : 5) * sd]
        if (ctx.T.waterAt(bp) < -2) ctx.out.boats.push({ p: bp, angle: Math.atan2(-g[1], -g[0]), len: seaSide ? 12 + rng.next() * 10 : 7 + rng.next() * 3 })
      }
  }
  if (placed.length) ctx.out.landmarks.push({ p: placed[0], name: ctx.namer.landmark('harbor', ctx.p.magic), kind: 'harbor' })
}

/** 奇观片区：法师塔与魔法阵 / 宗门与仙阁 */
export function magicWard(ctx: Ctx, _ward: Ward, block: Poly) {
  const g = clipWater(ctx, insetConvex(block, 3), 3)
  if (!g || g.length < 3) return
  const c = centroid(g)
  ctx.out.landmarks.push({ p: c, name: ctx.namer.landmark('magic', ctx.p.magic), kind: 'magic' })
  if (ctx.p.culture === 'eastern') {
    if (eastCompound(ctx, g, 'sect')) ctx.out.wonders.push({ p: [c[0], c[1]], r: 10, kind: 'spring' })
    else eastWard(ctx, block, false)
    return
  }
  ctx.out.greens.push({ poly: g, kind: 'garden' })
  const r = Math.min(34, Math.sqrt(area(g)) * 0.32)
  ctx.out.wonders.push({ p: c, r, kind: 'circle' })
  addBuilding(ctx, circlePoly(c, r * 0.28, 20), 'magic')
  // 围绕的石柱
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    addBuilding(ctx, circlePoly([c[0] + Math.cos(a) * r * 1.12, c[1] + Math.sin(a) * r * 1.12], 1.2, 8), 'shed')
  }
  scatterTrees(ctx, g, 0.003, 3, 5)
  urban(ctx, block, 'common', [circlePoly(c, r * 1.4, 16)])
}

// —————————————————————— 东方：院落 ——————————————————————

/** 当前布局的"北"方向（东式城市按网格朝向） */
function northOf(ctx: Ctx): { n: P; e: P } {
  const a = ctx.gridAngle
  return { n: [Math.sin(a), -Math.cos(a)], e: [Math.cos(a), Math.sin(a)] }
}

function localBox(poly: Poly, e: P, n: P) {
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (const p of poly) {
    const u = p[0] * e[0] + p[1] * e[1]
    const v = p[0] * n[0] + p[1] * n[1]
    u0 = Math.min(u0, u)
    u1 = Math.max(u1, u)
    v0 = Math.min(v0, v)
    v1 = Math.max(v1, v)
  }
  const at = (u: number, v: number): P => [e[0] * u + n[0] * v, e[1] * u + n[1] * v]
  const box = (ua: number, ub: number, va: number, vb: number): Poly => [at(ua, va), at(ub, va), at(ub, vb), at(ua, vb)]
  return { u0, u1, v0, v1, box }
}

/** 四合院：正房坐北朝南，东西厢房，南侧倒座与院门 */
export function siheyuan(ctx: Ctx, lot: Poly) {
  const { n, e } = northOf(ctx)
  const { u0, u1, v0, v1, box } = localBox(lot, e, n)
  const w = u1 - u0
  const h = v1 - v0
  ctx.out.enclosures.push(lot)
  const put = (p: Poly, kind: BuildingKind = 'house') => {
    let q: Poly = p
    for (let i = 0; i < lot.length && q.length >= 3; i++) {
      const a = lot[i]
      const b = lot[(i + 1) % lot.length]
      const c = centroid(lot)
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const L = Math.hypot(dx, dy) || 1
      let nx = -dy / L
      let ny = dx / L
      if ((c[0] - a[0]) * nx + (c[1] - a[1]) * ny < 0) {
        nx = -nx
        ny = -ny
      }
      q = clipHalf(q, [a[0] + nx * 0.6, a[1] + ny * 0.6], [-nx, -ny])
    }
    if (q.length >= 3 && area(q) > 10) addBuilding(ctx, q, kind)
  }
  const m = 0.6
  if (w * h < 260 || w < 11 || h < 11) {
    put(box(u0 + m, u1 - m, v1 - Math.min(h * 0.55, 8), v1 - m))
    return
  }
  const d1 = Math.min(9, h * 0.3)
  put(box(u0 + w * 0.12, u1 - w * 0.12, v1 - d1, v1 - m), w * h > 700 ? 'large' : 'house')
  const d2 = Math.min(6, w * 0.24)
  const top = v1 - d1 - 1.5
  const bot = v0 + Math.max(4.5, h * 0.22)
  if (top - bot > 5) {
    put(box(u1 - m - d2, u1 - m, bot, top))
    put(box(u0 + m, u0 + m + d2, bot, top))
  }
  if (h > 20) put(box(u0 + w * 0.08, u1 - w * 0.3, v0 + m, v0 + m + 4))
  if (h > 34 && w > 18) scatterTrees(ctx, box(u0 + d2 + 2, u1 - d2 - 2, bot + 1, top - 1), 0.004, 2, 3)
}

/** 东式大型院落群：宫城、寺观、宗门。沿南北中轴布置殿宇 */
export function eastCompound(ctx: Ctx, area0: Poly, kind: 'palace' | 'temple' | 'sect'): Poly | null {
  const { n, e } = northOf(ctx)
  const { u0, u1, v0, v1, box } = localBox(area0, e, n)
  const w = u1 - u0
  const h = v1 - v0
  const uc = (u0 + u1) / 2
  // 取包围盒内一个居中的矩形院落
  const cw = Math.min(w * 0.9, kind === 'palace' ? 170 : 90)
  const ch = Math.min(h * 0.9, kind === 'palace' ? 190 : 110)
  const vc = (v0 + v1) / 2
  const court = box(uc - cw / 2, uc + cw / 2, vc - ch / 2, vc + ch / 2)
  // 院落压到水上就不建
  const probe: P[] = [...court, centroid(court)]
  for (let k = 0; k < 4; k++) probe.push([(court[k][0] + court[(k + 1) % 4][0]) / 2, (court[k][1] + court[(k + 1) % 4][1]) / 2])
  if (probe.some((q) => ctx.T.waterAt(q) < 3)) return null
  const encl = court
  if (!encl.every((p) => pointInPoly(p, area0))) {
    // 退回到片区内缩
    ctx.out.enclosures.push(area0)
  } else ctx.out.enclosures.push(encl)
  ctx.out.plazas.push(encl)
  const halls = kind === 'palace' ? 4 : 3
  const put = (p: Poly, k: BuildingKind) => {
    if (p.every((q) => pointInPoly(q, area0))) addBuilding(ctx, p, k)
  }
  // 中轴殿宇：由南向北渐大
  for (let i = 0; i < halls; i++) {
    const t = (i + 0.7) / (halls + 0.4)
    const v = vc - ch / 2 + ch * t
    const bw = cw * (0.28 + 0.22 * (i / (halls - 1 || 1)))
    const bd = Math.min(ch * 0.12, 8 + i * 3)
    put(box(uc - bw / 2, uc + bw / 2, v - bd / 2, v + bd / 2), i === 0 ? 'hall' : kind === 'palace' ? 'keep' : 'temple')
  }
  // 山门
  put(box(uc - cw * 0.12, uc + cw * 0.12, vc - ch / 2 + 1, vc - ch / 2 + 6), 'hall')
  // 两侧廊庑
  put(box(uc - cw / 2 + 1, uc - cw / 2 + 5, vc - ch * 0.35, vc + ch * 0.38), 'house')
  put(box(uc + cw / 2 - 5, uc + cw / 2 - 1, vc - ch * 0.35, vc + ch * 0.38), 'house')
  if (kind !== 'palace') {
    // 塔
    const pt = box(uc + cw * 0.22 - 4, uc + cw * 0.22 + 4, vc + ch * 0.28 - 4, vc + ch * 0.28 + 4)
    put(pt, 'pagoda')
  }
  return box(uc - cw / 2 - 4, uc + cw / 2 + 4, vc - ch / 2 - 4, vc + ch / 2 + 4)
}

/** 东式里坊：坊内十字街分成四块，每块排布院落 */
export function eastWard(ctx: Ctx, block: Poly, rich: boolean, nearRoad = Infinity) {
  const { n, e } = northOf(ctx)
  const c = centroid(block)
  const cross = ctx.p.size === 'city' ? 5 : 3.5
  const quads: Poly[] = []
  for (const a of splitConvex(block, c, n, cross)) for (const b of splitConvex(a, c, e, cross)) if (b.length >= 3) quads.push(b)
  const maxA = rich ? 900 : ctx.p.size === 'city' ? 520 : 600
  for (const q of quads) {
    const lots = subdivide(ctx, q, { maxA, minA: 160, alley: 2.2, alleyP: 0.35, depth: 30, fill: 1, irr: 0.25 })
    for (const lot of lots) {
      if (nearRoad < Infinity && ctx.corridors.gap(centroid(lot.poly)) > nearRoad) {
        if (ctx.rng.next() < 0.15) scatterTrees(ctx, insetConvex(lot.poly, 2), 0.004, 2.5, 4)
        continue
      }
      if (ctx.rng.next() < 0.06) {
        const g = placeable(ctx, insetConvex(lot.poly, 1))
        if (g) scatterTrees(ctx, g, 0.008, 2.5, 4)
        continue
      }
      const l = placeable(ctx, insetConvex(lot.poly, 0.5))
      if (!l || area(l) < 60) continue
      siheyuan(ctx, l)
    }
  }
}

/** 东式市：密集的店铺 */
export function eastMarket(ctx: Ctx, block: Poly) {
  const { n, e } = northOf(ctx)
  const c = centroid(block)
  const reserve = [rect(c, e, 18, 18)]
  const sq = rect(c, e, 26, 26)
  if (sq.every((q) => ctx.T.waterAt(q) > 3)) {
    ctx.out.plazas.push(sq)
    addBuilding(ctx, rect(c, e, 12, 12), 'tower')
  }
  const parts: Poly[] = []
  for (const a of splitConvex(block, c, n, 8)) for (const b of splitConvex(a, c, e, 8)) if (b.length >= 3) parts.push(b)
  for (const p of parts) urban(ctx, p, 'market', reserve)
}

export { DENS }
