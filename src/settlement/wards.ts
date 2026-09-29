import { eastAsian } from './culture'
import { imperialPalace, royalPalace } from './palaces'
import { eastCompound } from './compose/chinese'
import { westChurch } from './compose/church'
import { westCastle } from './compose/castle'
import { emitArea, clearOf, clipWater, hashAt, isFree, mark, northOf, placeable, rngAt, type CorridorTag, type Ctx } from './ctx'
import { addRoad } from './roads'
import { chord, clipConvex,
  area,
  bboxOf,
  centroid,
  circlePoly,
  clipHalf,
  dist,
  insetConvex,
  localBox,
  inscribedRect,
  obb,
  pointInPoly,
  rect,
  rot,
  segDist,
  splitConvex,
  type P,
  type Poly,
} from './geom'
import { householdsOf, institutionOf } from './people'
import { dwelling } from './undo'
import type { Building, BuildingKind, Ward } from './types'

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
  /** 地块形态：连排（默认，临街建满）、独院（房子退后、带园子）、合院（四面围合的院落）、作坊（大工棚 + 堆场） */
  form?: 'row' | 'detached' | 'court' | 'works'
  /** 临街房屋后面再盖一栋后屋 / 工棚的概率（院落深处，密的地方多） */
  back?: number
  backKind?: BuildingKind
  /** 层数上限（贫民窟、郊区的房子矮） */
  floors?: number
}

const DENS: Record<string, Dens> = {
  merchant: { maxA: 230, minA: 60, alley: 2.4, alleyP: 0.3, depth: 22, fill: 0.97, irr: 0.55 },
  market: { maxA: 180, minA: 50, alley: 2.4, alleyP: 0.4, depth: 14, fill: 0.97, irr: 0.6 },
  common: { maxA: 170, minA: 45, alley: 2, alleyP: 0.35, depth: 17, fill: 0.94, irr: 0.8 },
  craft: { maxA: 250, minA: 60, alley: 2.6, alleyP: 0.3, depth: 19, fill: 0.9, irr: 0.7 },
  slum: { maxA: 75, minA: 22, alley: 1.6, alleyP: 0.55, depth: 14, fill: 0.92, irr: 1.25, back: 0.75, floors: 1 },
  harbor: { maxA: 480, minA: 110, alley: 3.2, alleyP: 0.45, depth: 24, fill: 0.86, irr: 0.35, kind: 'large', floors: 3 },
  suburb: { maxA: 240, minA: 60, alley: 2.4, alleyP: 0.25, depth: 14, fill: 0.72, irr: 0.9, floors: 2 },
  // —— 按密度档的变体（片区密度见 scale.ts 的 densityOf）——
  // 民居：密的是窄面宽、三四层的连排楼，后院再盖后屋（大杂院）；疏的是退后临街、带菜园与果树的独院
  common_high: { maxA: 105, minA: 35, alley: 1.8, alleyP: 0.5, depth: 15, fill: 0.99, irr: 0.6, back: 0.7 },
  common_low: { maxA: 440, minA: 170, alley: 2.4, alleyP: 0.15, depth: 12, fill: 0.92, irr: 0.7, form: 'detached' },
  // 商业：密的是整条街的铺面楼、后面是货仓；疏的是四面围合的客栈、货栈大院
  merchant_high: { maxA: 160, minA: 50, alley: 2.2, alleyP: 0.35, depth: 18, fill: 1, irr: 0.45, back: 0.55, backKind: 'shed' },
  merchant_low: { maxA: 760, minA: 300, alley: 3, alleyP: 0.3, depth: 22, fill: 0.95, irr: 0.35, form: 'court' },
  market_high: { maxA: 120, minA: 40, alley: 2.2, alleyP: 0.45, depth: 12, fill: 1, irr: 0.5, back: 0.3, backKind: 'shed' },
  market_low: { maxA: 700, minA: 280, alley: 3, alleyP: 0.3, depth: 20, fill: 0.95, irr: 0.35, form: 'court' },
  // 工匠：密的是临街作坊、院里挤满工棚；疏的是大工棚、围起来的堆场（木料、石料、晾晒）
  craft_high: { maxA: 170, minA: 55, alley: 2.4, alleyP: 0.4, depth: 15, fill: 0.97, irr: 0.6, back: 0.85, backKind: 'shed' },
  craft_low: { maxA: 950, minA: 340, alley: 3.2, alleyP: 0.3, depth: 24, fill: 0.9, irr: 0.4, form: 'works' },
  // 村落宅地的参数与人口无关（连续成长时已有的宅地不重切）；村子大小由户数预算决定盖多少
  village: { maxA: 400, minA: 115, alley: 0, alleyP: 0, depth: 13, fill: 0.76, irr: 1.0, floors: 2 },
  hamlet: { maxA: 700, minA: 160, alley: 0, alleyP: 0, depth: 12, fill: 0.5, irr: 1.0, floors: 2 },
}

interface Lot {
  poly: Poly
  /** 临街边（在街区边界或小巷边上）的序号 */
  front: number[]
}

type Seg = [P, P]


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

interface Front {
  a: P
  b: P
  /** 沿街方向 */
  u: P
  /** 指向地块内部的法向 */
  n: P
  L: number
  /** 拐角地块：两条不平行的临街边 */
  corner: boolean
}

/** 地块最长的临街边 */
function frontOf(lot: Lot): Front | null {
  const { poly, front } = lot
  if (!front.length) return null
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
  const corner = front.some((i) => {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const ex = (q[0] - p[0]) / (dist(p, q) || 1)
    const ey = (q[1] - p[1]) / (dist(p, q) || 1)
    return Math.abs(ex * nx + ey * ny) > 0.5
  })
  return { a, b, u: [dx / L, dy / L], n: [nx, ny], L, corner }
}

/**
 * 地块 → 房屋：只保留临街进深，后部留作院子。
 * 斜切出来的三角形、梯形地块不直接当房子：取沿临街边摆放、贴着街的内接矩形。
 */
function lotBuilding(lot: Lot, depth: number): Poly | null {
  const f = frontOf(lot)
  if (!f) return null
  const { a, u, n } = f
  // 拐角地块整块建满
  if (f.corner) return inscribedRect(lot.poly, u, { v: n, minSide: 3.5 })
  const out = clipHalf(lot.poly, [a[0] + n[0] * depth, a[1] + n[1] * depth], n)
  if (out.length < 3) return null
  const r = inscribedRect(out, u, { v: n, minSide: 3.5 })
  return r && area(r) > 12 ? r : null
}

/** 临街房屋之后的后院：从临街边往里 from 米以外的部分 */
function rearOf(lot: Lot, from: number): Poly | null {
  const f = frontOf(lot)
  if (!f) return null
  const q = clipHalf(lot.poly, [f.a[0] + f.n[0] * from, f.a[1] + f.n[1] * from], [-f.n[0], -f.n[1]])
  return q.length >= 3 && area(q) > 20 ? q : null
}

function squareUp(orig: Poly, q: Poly): Poly | null {
  if (q.length === 4 && area(q) > area(orig) * 0.995) return q
  const u: P = [orig[1][0] - orig[0][0], orig[1][1] - orig[0][1]]
  return inscribedRect(q, u, {
    minSide: 3.5,
    bands: [
      [0, 1],
      [0, 0.85],
      [0.15, 1],
      [0, 0.7],
      [0.3, 1],
      [0.1, 0.9],
    ],
  })
}

/**
 * 放一座建筑：压水、碰路或压到已有实体就不放。pad 为离道路 / 城墙走廊的余量。
 * 所有建筑都经这里落地，占地登记由此保证互不重叠。
 */
/**
 * 宅地的"入住签"：按 16 米见方的格子取位置哈希，同一个院子、挨着的几户一起决定盖不盖
 * （院子不会只盖一半，房子也成簇出现）；占用率升高只会多盖。
 */
function occupied(ctx: Ctx, poly: Poly) {
  const c = centroid(poly)
  const g = 16
  const ox = ctx.MW / 2
  const oy = ctx.MH / 2
  return hashAt(ctx, [ox + Math.floor((c[0] - ox) / g) * g, oy + Math.floor((c[1] - oy) / g) * g], 'ward.occupied')
}


/**
 * 民居的层数与住户数，按所在片区的密度档（位置哈希定，同一栋房子在任何规模下一样高）：
 * 西式疏档一两层、中档两层为主、密档二至四层（三层以上楼上一层一户）；
 * 东方的院落以平房为主，密档临街有些两层的铺面楼（院里每座屋子就是一户）。
 */
function storeys(ctx: Ctx, poly: Poly, cap = Infinity): { floors: number; units: number } {
  const h = hashAt(ctx, centroid(poly), 'ward.storeys')
  const d = ctx.wardDensity
  if (eastAsian(ctx.p.culture)) {
    // 院里每座屋子一般住一户；疏档的大宅是一家人住好几座（只有约四成算一户），密档的两层铺面楼住两户
    if (ctx.estate) return { floors: 1, units: h < 0.4 ? 1 : 0 }
    const floors = Math.min(cap, d === 'high' && h < 0.45 ? 2 : 1)
    return { floors, units: floors }
  }
  const floors = Math.min(cap, d === 'high' ? 2 + (h < 0.55 ? 1 : 0) + (h < 0.12 ? 1 : 0) : d === 'mid' ? 2 + (h < 0.2 ? 1 : 0) : 1 + (h < 0.45 ? 1 : 0))
  // 三层以上：底层是铺面 / 作坊，楼上一层住一户；特别大的楼按约 150 m² 一户
  const units = floors >= 3 ? Math.max(floors - 1, Math.round((area(poly) * floors) / 150)) : 1
  return { floors, units }
}

/**
 * 记下一栋建筑：色调按位置取哈希，屋脊顺着长轴（extra 可改屋脊、定层数与住户）。
 * 色调不从随机数流里取：盖不盖得上会随人口变，取了就会让同一片区后面的房子全部错位。
 */
function record(ctx: Ctx, poly: Poly, kind: BuildingKind, extra?: Partial<Building>) {
  const b = obb(poly)
  // 民居记下各户的营生与口数（不算城里人口的 units 为 0，没有住户）；寺院的僧房、兵营与城堡的厅堂住集体户
  let households = extra?.households
  if (!households) households = dwelling(kind) && (extra?.units ?? 1) > 0 ? householdsOf(ctx, poly, extra?.units ?? 1, extra?.floors ?? 1) : institutionOf(ctx, poly, kind, extra?.floors ?? 1)
  ctx.out.buildings.push({ poly, kind, tone: hashAt(ctx, b.center, 'building.tone'), ridge: Math.atan2(b.axis[1], b.axis[0]), ...extra, ...(households.length ? { households } : {}) })
}

export function addBuilding(ctx: Ctx, poly: Poly, kind: BuildingKind = 'house', pad = 0, floorCap = Infinity): boolean {
  // 民居预算用完：不再盖住户（人口已够目标）；占用率不到的宅地空着（按位置哈希，占用率升高只会多盖）
  if (dwelling(kind) && !ctx.uncounted && (ctx.houseBudget <= 0 || ctx.wardQuota <= 0 || occupied(ctx, poly) >= ctx.wardFill)) return false
  if (!isFree(ctx, poly, { pad })) return false
  let extra: Partial<Building> | undefined
  if (dwelling(kind) && ctx.uncounted) extra = { floors: 1, units: 0 }
  else if (dwelling(kind)) {
    extra = storeys(ctx, poly, floorCap)
    ctx.houseBudget -= extra.units!
    ctx.wardQuota -= extra.units!
  }
  record(ctx, poly, kind, extra)
  ctx.occ.add(poly)
  return true
}

/**
 * 直接落地一栋按规划摆的建筑（城郭、宫室、宅院的厢房）：不占民居预算、不看占用率，只让开水面、走廊与已有的东西。
 * o 是 isFree 的选项，extra 定层数、住户（厢房只占地不住人）或屋脊。
 */
export function place(ctx: Ctx, poly: Poly, kind: BuildingKind, o: { pad?: number; tags?: CorridorTag[] } = {}, extra?: Partial<Building>): boolean {
  if (!isFree(ctx, poly, o)) return false
  // 不算人口的（宫殿里的殿舍、城外的村子）：没给住户数的记 0
  if (dwelling(kind) && ctx.uncounted && extra?.units === undefined) extra = { floors: 1, ...extra, units: 0 }
  record(ctx, poly, kind, extra)
  ctx.occ.add(poly)
  return true
}

/** 一组部件（中殿、耳堂、后殿）要么全部放下，要么一个都不放；部件之间允许相交 */
export function addGroup(ctx: Ctx, parts: [Poly, BuildingKind][], pad: number): boolean {
  for (const [p] of parts) if (!isFree(ctx, p, { pad })) return false
  for (const [p, kind] of parts) {
    // 不算人口的（城外的村子、宫殿）：不占民居预算，住户记 0
    if (dwelling(kind) && ctx.uncounted) record(ctx, p, kind, { floors: 1, units: 0 })
    else {
      if (dwelling(kind)) {
        ctx.houseBudget--
        ctx.wardQuota--
      }
      record(ctx, p, kind)
    }
  }
  for (const [p] of parts) ctx.occ.add(p)
  return true
}

/**
 * 在区域里给特殊建筑找个能落地的位置：先放中心，再沿长轴、短轴偏移，都不行就逐级缩小。
 * make(中心, 缩放) 生成候选，ok 判定能否落地。
 */
export function fit<T>(zone: Poly, make: (c: P, s: number) => T | null, ok: (t: T) => boolean, scales = [1, 0.85, 0.7, 0.55]): T | null {
  if (zone.length < 3) return null
  const b = obb(zone)
  const c = centroid(zone)
  const across: P = [-b.axis[1], b.axis[0]]
  const offs = [
    [0, 0],
    [0.15, 0],
    [-0.15, 0],
    [0, 0.15],
    [0, -0.15],
    [0.28, 0],
    [-0.28, 0],
    [0.15, 0.18],
    [-0.15, -0.18],
    [0.15, -0.18],
    [-0.15, 0.18],
  ]
  for (const s of scales)
    for (const [du, dv] of offs) {
      const q: P = [c[0] + b.axis[0] * du * b.len + across[0] * dv * b.wid, c[1] + b.axis[1] * du * b.len + across[1] * dv * b.wid]
      if (!pointInPoly(q, zone)) continue
      const t = make(q, s)
      if (t && ok(t)) return t
    }
  return null
}

export const inside = (poly: Poly, zone: Poly) => poly.every((v) => pointInPoly(v, zone))

/** 码头：不碰路桥与城墙，不压别的码头与船 */
export function addPier(ctx: Ctx, pier: Poly): boolean {
  if (ctx.corridors.hitsPoly(pier, 1, ['road', 'wall'])) return false
  if (ctx.occ.overlaps(pier, 2)) return false
  ctx.out.piers.push(pier)
  ctx.occ.add(pier)
  return true
}

/** 船：整条船都在水里，不压桥、码头与别的船 */
export function addBoat(ctx: Ctx, p: P, angle: number, len: number): boolean {
  const u: P = [Math.cos(angle), Math.sin(angle)]
  const hull = rect(p, u, len, len * 0.36)
  if (hull.some((v) => ctx.T.waterAt(v) > -1)) return false
  if (ctx.corridors.hitsPoly(hull, 1, ['road'])) return false
  if (ctx.occ.overlaps(hull, 0.8)) return false
  ctx.out.boats.push({ p, angle, len })
  ctx.occ.add(hull)
  return true
}

function overlaps(poly: Poly, zones: Poly[]) {
  for (const z of zones) {
    if (pointInPoly(centroid(poly), z)) return true
    for (const v of poly) if (pointInPoly(v, z)) return true
    for (const v of z) if (pointInPoly(v, poly)) return true
  }
  return false
}

/** 有密度档变体的片区（见 DENS 里的 *_high / *_low） */
const TIERED = new Set(['common', 'merchant', 'market', 'craft'])

/** 候选房屋落地：略缩一圈、让开道路与水面，被裁过的取回矩形 */
function put(ctx: Ctx, b: Poly, kind: BuildingKind, floorCap?: number): boolean {
  const q0 = insetConvex(b, 0.2)
  if (q0.length < 3) return false
  const clipped = placeable(ctx, q0)
  const q = clipped && squareUp(q0, clipped)
  if (!q || area(q) < 12) return false
  return addBuilding(ctx, q, kind, 0, floorCap)
}

/** 普通街区：切地块、建临街房屋，院落里偶尔种树。形态与地块大小随片区的密度档 */
export function urban(ctx: Ctx, block: Poly, densKey: string, reserve: Poly[] = [], nearRoad = Infinity) {
  const tier = `${densKey}_${ctx.wardDensity}`
  const o = TIERED.has(densKey) && DENS[tier] ? DENS[tier] : DENS[densKey]
  const wardRng = ctx.rng
  const lots = subdivide(ctx, block, o)
  for (const lot of lots) {
    if (reserve.length && overlaps(lot.poly, reserve)) continue
    const c = centroid(lot.poly)
    // 每块宅地用自己的随机数流（按位置）：别的宅地盖没盖上（占用率、预算随人口变）不会让这块跟着重排
    const rng = (ctx.rng = rngAt(ctx, c, 'ward.lot'))
    // 郊区与村落：只沿路建房
    if (nearRoad < Infinity && ctx.corridors.gap(c) > nearRoad) {
      if (rng.next() < 0.18) scatterTrees(ctx, insetConvex(lot.poly, 2), 0.004, 2.5, 4.5)
      continue
    }
    if (densKey === 'village' || densKey === 'hamlet') {
      const nb = ctx.out.buildings.length
      if (rng.next() < o.fill) farmstead(ctx, lot)
      else if (rng.next() < 0.4) scatterTrees(ctx, insetConvex(lot.poly, 2), 0.004, 2.5, 4.5)
      // 没盖上农舍的宅地（不临路、太窄，或空着）：是屋旁的菜园、小块草场，不是一片光地
      if (ctx.out.buildings.length === nb) croft(ctx, lot.poly)
      continue
    }
    if (o.form === 'detached' || o.form === 'court' || o.form === 'works') {
      if (rng.next() < o.fill) (o.form === 'detached' ? detached : o.form === 'court' ? courtyard : works)(ctx, lot, o)
      continue
    }
    const depth = o.depth * (0.75 + rng.next() * 0.5)
    let b = rng.next() < o.fill ? lotBuilding(lot, depth) : null
    // 院落深处偶有后屋、作坊
    if (!b && !lot.front.length && nearRoad === Infinity && rng.next() < (o.back ?? 0.3)) {
      const bb = obb(lot.poly)
      if (bb.wid > 5)
        b = inscribedRect(lot.poly, bb.axis, {
          minSide: 3.5,
          bands: [
            [0.2, 0.8],
            [0.15, 0.85],
            [0.25, 0.75],
          ],
        })
    }
    if (!b) {
      if (!lot.front.length && area(lot.poly) > 60 && rng.next() < 0.35) scatterTrees(ctx, insetConvex(lot.poly, 1.5), 0.01, 2, 3.5)
      continue
    }
    if (!put(ctx, b, o.kind ?? (area(b) > 420 ? 'large' : 'house'), o.floors)) continue
    // 临街房屋后面的后屋 / 工棚：密的街坊里后院也盖满（大杂院、作坊院）
    if (o.back && lot.front.length && nearRoad === Infinity && rng.next() < o.back) {
      const f = frontOf(lot)
      const rear = f && !f.corner ? rearOf(lot, depth + 2.2) : null
      const r = rear && inscribedRect(rear, f!.u, { v: f!.n, minSide: 3.5 })
      if (r && area(r) > 16) put(ctx, area(r) > 140 ? shrink(r, Math.sqrt(140 / area(r))) : r, o.backKind ?? 'house', o.floors)
    }
  }
  ctx.rng = wardRng
}

/** 村里空着的宅地：菜园（让开道路、水与已有的房子） */
function croft(ctx: Ctx, poly: Poly) {
  const g = placeable(ctx, insetConvex(poly, 0.8), 1.5)
  if (!g || g.length < 3 || area(g) < 50 || ctx.occ.overlaps(g)) return
  emitArea(ctx, 'greens', g, 'garden')
  if (ctx.rng.next() < 0.5) scatterTrees(ctx, insetConvex(g, 1.5), 0.004, 2, 3.2)
}

/** 以形心为中心缩放 */
function shrink(poly: Poly, k: number): Poly {
  const c = centroid(poly)
  return poly.map((v) => [c[0] + (v[0] - c[0]) * k, c[1] + (v[1] - c[1]) * k] as P)
}

/** 独院：房子退后临街一段，四周篱笆，屋后菜园果树，偶有柴棚 */
function detached(ctx: Ctx, lot: Lot, o: Dens) {
  const f = frontOf(lot)
  if (!f || f.L < 10) return
  const rng = ctx.rng
  const { a, b, u, n } = f
  const w = Math.min(f.L * 0.65, 8 + rng.next() * 5)
  const dep = 7 + rng.next() * 3
  const set = 2 + rng.next() * 3
  const slide = (rng.next() - 0.5) * Math.max(0, f.L - w) * 0.7
  const hc: P = [(a[0] + b[0]) / 2 + u[0] * slide + n[0] * (set + dep / 2), (a[1] + b[1]) / 2 + u[1] * slide + n[1] * (set + dep / 2)]
  const house = rect(hc, u, w, dep)
  if (!house.every((v) => pointInPoly(v, lot.poly)) || !put(ctx, house, 'house', o.floors)) return
  const yard = ctx.corridors.clip(insetConvex(lot.poly, 0.6))
  if (yard && yard.length >= 3 && area(yard) > 80) emitArea(ctx, 'enclosures', yard)
  const rear = rearOf(lot, set + dep + 2)
  if (rear && area(rear) > 60) {
    const g = placeable(ctx, insetConvex(rear, 1.2))
    if (g && area(g) > 40) {
      emitArea(ctx, 'greens', g, 'garden')
      scatterTrees(ctx, g, 0.006, 2, 3.5)
    }
  }
  if (rng.next() < 0.35) {
    const sg = slide > 0 ? -1 : 1
    const sc: P = [hc[0] + u[0] * (w / 2 + 3.5) * sg, hc[1] + u[1] * (w / 2 + 3.5) * sg]
    const shed = rect(sc, u, 3.5 + rng.next(), 4.5 + rng.next() * 1.5)
    if (shed.every((v) => pointInPoly(v, lot.poly))) put(ctx, shed, 'shed')
  }
}

/** 合院：临街正屋（住家、铺面），两厢与后进是库房，中间一方院子（客栈、货栈、行商大院） */
function courtyard(ctx: Ctx, lot: Lot, o: Dens) {
  const f = frontOf(lot)
  if (!f) return
  const r = inscribedRect(lot.poly, f.u, { v: f.n, minSide: 14 })
  if (!r) {
    const b = lotBuilding(lot, o.depth * 0.6)
    if (b) put(ctx, b, 'house', o.floors)
    return
  }
  const { u0, u1, v0, v1, box } = localBox(r, f.u, f.n)
  const t = Math.min(7, (u1 - u0) * 0.25, (v1 - v0) * 0.25)
  if (!put(ctx, box(u0, u1, v0, v0 + t), 'large', o.floors)) return
  put(ctx, box(u0, u1, v1 - t, v1), 'shed')
  put(ctx, box(u0, u0 + t, v0 + t + 0.6, v1 - t - 0.6), 'shed')
  if (ctx.rng.next() < 0.7) put(ctx, box(u1 - t, u1, v0 + t + 0.6, v1 - t - 0.6), 'shed')
  emitArea(ctx, 'greens', box(u0 + t, u1 - t, v0 + t, v1 - t), 'courtyard')
}

/** 作坊：临街一间师傅的住屋，后面一座大工棚，院墙围起的堆场里散着料棚、晾架 */
function works(ctx: Ctx, lot: Lot, o: Dens) {
  const f = frontOf(lot)
  if (!f || f.L < 12) return
  const rng = ctx.rng
  const { a, b, u, n } = f
  const side = rng.next() < 0.5 ? -1 : 1
  const w = Math.min(10, f.L * 0.4)
  const hc: P = [(a[0] + b[0]) / 2 + u[0] * side * (f.L / 2 - w / 2 - 1) + n[0] * 4.5, (a[1] + b[1]) / 2 + u[1] * side * (f.L / 2 - w / 2 - 1) + n[1] * 4.5]
  const house = rect(hc, u, w, 7)
  if (!house.every((v) => pointInPoly(v, lot.poly)) || !put(ctx, house, 'house', o.floors)) return
  const yard = ctx.corridors.clip(insetConvex(lot.poly, 0.6))
  if (yard && yard.length >= 3 && area(yard) > 120) emitArea(ctx, 'enclosures', yard)
  const rear = rearOf(lot, 11)
  const hall = rear && inscribedRect(rear, u, { v: n, minSide: 8 })
  if (hall) put(ctx, area(hall) > 380 ? shrink(hall, Math.sqrt(380 / area(hall))) : hall, 'shed')
  // 料棚、晾架：沿临街一侧的空地上几座小棚
  for (let k = 0; k < 3; k++) {
    if (rng.next() < 0.35) continue
    const t = (rng.next() - 0.5) * f.L * 0.7
    const d = 5 + rng.next() * 6
    const q: P = [(a[0] + b[0]) / 2 + u[0] * t + n[0] * d, (a[1] + b[1]) / 2 + u[1] * t + n[1] * d]
    const s = rect(q, rng.next() < 0.5 ? u : n, 5 + rng.next() * 3, 2.5 + rng.next())
    if (s.every((v) => pointInPoly(v, lot.poly))) put(ctx, s, 'shed')
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
  if (ctx.style.farmstead?.(ctx, poly, a, n)) return
  const len = Math.min(L * 0.7, 9 + rng.next() * 5)
  const dep = 6 + rng.next() * 2.5
  const slide = (rng.next() - 0.5) * Math.max(0, L - len) * 0.6
  const m: P = [(a[0] + b[0]) / 2 + u[0] * slide, (a[1] + b[1]) / 2 + u[1] * slide]
  const hc: P = [m[0] + n[0] * (2.5 + dep / 2), m[1] + n[1] * (2.5 + dep / 2)]
  const house = rect(hc, u, len, dep)
  if (!house.every((v) => pointInPoly(v, poly)) || !addBuilding(ctx, house, 'house')) return
  if (rng.next() < 0.65) {
    const side = rng.next() < 0.5
    const bl = 7 + rng.next() * 4
    const bw = 5 + rng.next() * 1.5
    const sg = slide > 0 ? -1 : 1
    const bc: P = side
      ? [hc[0] + u[0] * (len / 2 + bw / 2 + 2) * sg, hc[1] + u[1] * (len / 2 + bw / 2 + 2) * sg]
      : [hc[0] + n[0] * (dep / 2 + bw / 2 + 4), hc[1] + n[1] * (dep / 2 + bw / 2 + 4)]
    const barn = side ? rect([bc[0] + n[0] * 2, bc[1] + n[1] * 2], n, bl, bw) : rect(bc, u, bl, bw)
    if (barn.every((v) => pointInPoly(v, poly))) addBuilding(ctx, barn, 'shed')
  }
  // 院子：以主屋为准的规整矩形（前临路，后带菜园），裁到宅地里，再让开道路与城墙
  if (rng.next() < 0.8) {
    const yw = Math.max(len + 10, 18 + rng.next() * 6)
    const yd = dep + 12 + rng.next() * 8
    const yc: P = [m[0] + n[0] * (1.2 + yd / 2), m[1] + n[1] * (1.2 + yd / 2)]
    const raw = clipConvex(rect(yc, u, yw, yd), insetConvex(poly, 0.8))
    const yard = raw.length >= 3 ? ctx.corridors.clip(raw) : null
    if (yard && yard.length >= 3 && area(yard) > 120) emitArea(ctx, 'enclosures', yard)
  }
  if (rng.next() < 0.6) scatterTrees(ctx, clipHalf(insetConvex(poly, 2), [hc[0] + n[0] * (dep / 2 + 3), hc[1] + n[1] * (dep / 2 + 3)], [-n[0], -n[1]]), 0.003, 2.2, 3.6)
}

/**
 * 在区域里按密度（棵 / 平方米）撒树（grid：用哪一张网格，野地的林子与院里、田边的树各用一张，砍了林子开出的地上种的树不在原处）。树位钉在世界坐标的一张 6 米网格上：每格一个候选点，
 * 位置、树冠大小与"门槛"都按格子的位置取哈希，格子的门槛低于这里的密度才种。
 * 于是同一棵树在任何规模下都在同一个地方：片区的边界挪一点只增减边上的几棵，密度升高只多种、不挪动已有的。
 */
export function scatterTrees(ctx: Ctx, poly: Poly, density: number, r0: number, r1: number, grid = 'tree') {
  if (poly.length < 3 || density <= 0) return
  const s = TREE_CELL
  const p0 = density * s * s
  const ox = ctx.MW / 2
  const oy = ctx.MH / 2
  const [x0, y0, x1, y1] = bboxOf(poly)
  for (let j = Math.floor((y0 - oy) / s); j <= Math.floor((y1 - oy) / s); j++)
    for (let i = Math.floor((x0 - ox) / s); i <= Math.floor((x1 - ox) / s); i++) {
      const cell: P = [ox + i * s, oy + j * s]
      if (hashAt(ctx, cell, `${grid}.gate`) >= p0) continue
      const p: P = [cell[0] + hashAt(ctx, cell, `${grid}.x`) * s, cell[1] + hashAt(ctx, cell, `${grid}.y`) * s]
      if (!pointInPoly(p, poly)) continue
      plantTree(ctx, p, r0 + hashAt(ctx, cell, `${grid}.r`) * (r1 - r0))
    }
}
/** 撒树的网格（米）：最密的撒法（约 0.02 棵 / 平方米）每格也不到一棵 */
const TREE_CELL = 6

/** 种一棵树：离水、不上路、树冠不压房子；种上了返回 true */
export function plantTree(ctx: Ctx, p: P, r: number) {
  if (ctx.T.waterAt(p) < 2 || ctx.corridors.hits(p, 1) || ctx.occ.hitsPoint(p, r * 0.5)) return false
  ctx.out.trees.push({ p, r })
  return true
}

// —————————————————————— 各类片区 ——————————————————————

/** 广场 / 市场：stallFactor 放大摊位数（商贸城的大市场） */
export function plaza(ctx: Ctx, _ward: Ward, block: Poly, stallFactor = 1) {
  const rng = ctx.rng
  // 铺装直接连着街面，但不压城墙
  const pave = ctx.corridors.clip(clipWater(ctx, block, 1) ?? block, ['wall']) ?? block
  emitArea(ctx, 'plazas', pave)
  const c = centroid(pave)
  const reserve: Poly[] = []
  // 市政厅 / 鼓楼
  const size = ctx.p.size
  if (size === 'town' || size === 'city') {
    const b = obb(pave)
    const L = Math.min(b.len * 0.42, size === 'city' ? 34 : 24)
    const east = eastAsian(ctx.p.culture)
    const hall = fit(
      pave,
      (q, s) => (east ? rect(q, [1, 0], 14 * s, 14 * s) : rect(q, b.axis, L * s, L * 0.5 * s)),
      (h) => inside(h, pave) && isFree(ctx, h, { pad: 1 }),
      [1, 0.8, 0.65],
    )
    if (hall && addBuilding(ctx, hall, east ? 'tower' : 'hall', 1)) {
      reserve.push(hall)
      mark(ctx, centroid(hall), 'market')
    }
    // 摊位：只摆在铺装内侧，不上街
    const stalls = Math.round((size === 'city' ? 26 : 12) * stallFactor)
    const inner = insetConvex(pave, 4)
    for (let k = 0, t = 0; k < stalls && t < stalls * 8 && inner.length >= 3; t++) {
      const p: P = [c[0] + (rng.next() - 0.5) * b.len * 0.8, c[1] + (rng.next() - 0.5) * b.len * 0.8]
      const s = rect(p, b.axis, 3 + rng.next() * 2, 2.2 + rng.next())
      if (!inside(s, inner) || overlaps(s, reserve)) continue
      if (!addBuilding(ctx, s, 'shed', 0.8)) continue
      reserve.push(rect(p, b.axis, 7, 5.5))
      k++
    }
  }
  // 城镇以上：广场中心是喷泉，再立一两尊雕像；村里是一口井
  if (size === 'town' || size === 'city') {
    if (!ctx.occ.hitsPoint(c, 4)) {
      ctx.out.landmarks.push({ p: c, kind: 'fountain' })
      ctx.occ.add(circlePoly(c, 3.5, 10))
    }
    for (let k = 0; k < 6; k++) {
      const a = hashAt(ctx, c, 'plaza.statue.a', k) * Math.PI * 2
      const rr = 8 + hashAt(ctx, c, 'plaza.statue.r', k) * 10
      const q: P = [c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]
      if (!pointInPoly(q, pave) || ctx.occ.hitsPoint(q, 2) || ctx.corridors.hits(q, 1)) continue
      ctx.out.landmarks.push({ p: q, kind: 'statue' })
      ctx.occ.add(circlePoly(q, 1.4, 8))
      if (hashAt(ctx, q, 'plaza.statue.stop') < 0.5) break
    }
  } else ctx.out.landmarks.push({ p: [c[0] - 6, c[1] + 8], kind: 'well' })
}

export function temple(ctx: Ctx, _ward: Ward, block: Poly) {
  const inner = insetConvex(block, 10)
  if (inner.length < 3) return urban(ctx, block, 'common')
  // 西式：教堂按平面语法拼（compose/church.ts）
  if (!eastAsian(ctx.p.culture)) {
    westChurch(ctx, block, inner)
    return
  }
  const reserve: Poly[] = []
  // 合成的大寺（grand）：整块地盘都是寺域（寺林、塔院），不再填街坊
  const grand = ctx.tier === 'grand'
  const comp = eastCompound(ctx, grand ? insetConvex(block, 4) : inner, 'temple')
  if (comp) reserve.push(comp)
  // 合成的大寺：自己的名字（不耗主随机数），按大地标标注
  if (ctx.tier === 'grand') ctx.out.landmarks.push({ p: centroid(inner), name: ctx.namer.sacred('grandTemple', `${Math.round(centroid(inner)[0])},${Math.round(centroid(inner)[1])}`), kind: 'temple', major: true })
  else mark(ctx, centroid(inner), 'temple')
  // 外圈仍是街坊；大寺四周是寺林
  if (grand) scatterTrees(ctx, insetConvex(block, 3), 0.004, 2.5, 5)
  else urban(ctx, block, 'common', reserve)
}

/** 墓碑成排：沿 axis 方向按墓园自身的范围排布，每块都必须完整落在墓园内（离围墙留一点空） */
export function graves(ctx: Ctx, zone: Poly, axis: P) {
  const rng = ctx.rng
  emitArea(ctx, 'greens', zone, 'cemetery')
  const inner = insetConvex(zone, 1.2)
  if (inner.length < 3) return
  const across: P = [-axis[1], axis[0]]
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (const p of zone) {
    const u = p[0] * axis[0] + p[1] * axis[1]
    const v = p[0] * across[0] + p[1] * across[1]
    u0 = Math.min(u0, u)
    u1 = Math.max(u1, u)
    v0 = Math.min(v0, v)
    v1 = Math.max(v1, v)
  }
  for (let u = u0 + 2.5; u < u1 - 1.5; u += 3.2)
    for (let v = v0 + 2.5; v < v1 - 1.5; v += 4.2) {
      if (rng.next() < 0.25) continue
      const p: P = [axis[0] * u + across[0] * v, axis[1] * u + across[1] * v]
      const g = rect(p, across, 1.9, 0.9)
      if (inside(g, inner)) addBuilding(ctx, g, 'shed')
    }
}

export function cemetery(ctx: Ctx, ward: Ward, block: Poly) {
  // 墓园按道路、河岸裁齐，围墙沿裁剪后的边界
  const zone = placeable(ctx, insetConvex(block, 3), 3, 0.4)
  if (!zone || zone.length < 3 || area(zone) < 300) return
  const b = obb(zone)
  const chapel = fit(zone, (q, s) => rect(q, b.axis, 12 * s, 7 * s), (h) => inside(h, zone) && isFree(ctx, h, { pad: 1 }), [1, 0.8])
  if (chapel) addBuilding(ctx, chapel, eastAsian(ctx.p.culture) ? 'hall' : 'temple', 1)
  graves(ctx, zone, b.axis)
  emitArea(ctx, 'enclosures', zone)
  scatterTrees(ctx, zone, 0.002, 3, 5)
  void ward
}

/** 城堡 / 衙署：幕墙、角楼、主楼与沿墙的附属建筑 */
export function castle(ctx: Ctx, ward: Ward, block: Poly) {
  // 幕墙不能被街道穿过、不能顶到城墙：碰到就往里收（斜切过一角的路沿路裁掉），收不下就不建城堡
  let curtain: Poly | null = null
  for (const d of [4, 8, 12]) {
    const w = clipWater(ctx, insetConvex(block, d), 4)
    const q = w && clearOf(ctx, w, ['road', 'river', 'wall'])
    if (q && q.length >= 3 && area(q) > 900 && !ctx.corridors.hitsPoly(q, 1, ['road', 'river', 'wall'])) {
      curtain = q
      break
    }
  }
  if (!curtain) return urban(ctx, block, 'common')
  const c = centroid(curtain)
  // 都城：城堡的位置是皇宫、王宫
  const royal = !!ctx.p.capital
  ctx.out.landmarks.push({ p: c, name: royal ? ctx.namer.palace() : ctx.namer.landmark('castle', ctx.p.magic), kind: 'castle' })
  if (eastAsian(ctx.p.culture)) {
    if (royal && imperialPalace(ctx, curtain)) return
    if (!eastCompound(ctx, curtain, 'palace')) eastWard(ctx, block, true)
    return
  }
  if (royal && royalPalace(ctx, curtain)) return
  // 西式城堡：按城堡的语法拼（compose/castle.ts）
  westCastle(ctx, curtain)
  // 堡外的片区剩余部分
  void ward
}

export function noble(ctx: Ctx, ward: Ward, block: Poly) {
  const rng = ctx.rng
  const lots = subdivide(ctx, block, { maxA: ctx.p.size === 'city' ? 1500 : 1000, minA: 350, alley: 0, alleyP: 0, depth: 20, fill: 1, irr: 0.5 })
  for (const lot of lots) {
    const encl = placeable(ctx, insetConvex(lot.poly, 0.8), 3)
    if (!encl || encl.length < 3) continue
    if (eastAsian(ctx.p.culture)) {
      siheyuan(ctx, encl)
      continue
    }
    emitArea(ctx, 'enclosures', encl)
    emitArea(ctx, 'greens', encl, 'garden')
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
    const hl = b.len * (0.4 + rng.next() * 0.15)
    const hw = b.wid * (0.35 + rng.next() * 0.1)
    for (const s of [1, 0.8, 0.62]) {
      const house = rect(hc, b.axis, hl * s, hw * s)
      if (inside(house, encl) && addBuilding(ctx, house, 'large', 0.5)) break
    }
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
    if (!addPier(ctx, pier)) continue
    placed.push(q)
    const n: P = [-g[1], g[0]]
    for (const sd of [-1, 1])
      if (rng.next() < 0.75) {
        const t = 0.35 + rng.next() * 0.5
        const len = seaSide ? 12 + rng.next() * 10 : 7 + rng.next() * 3
        const off = (seaSide ? 6 : 4) / 2 + len * 0.18 + 1.2
        const bp: P = [q[0] - g[0] * (L + w) * t + n[0] * off * sd, q[1] - g[1] * (L + w) * t + n[1] * off * sd]
        addBoat(ctx, bp, Math.atan2(-g[1], -g[0]), len)
      }
  }
  if (placed.length) mark(ctx, placed[0], 'harbor')
}

/** 奇观片区：法师塔与魔法阵 / 宗门与仙阁 */
export function magicWard(ctx: Ctx, _ward: Ward, block: Poly) {
  const g = clipWater(ctx, insetConvex(block, 3), 3)
  if (!g || g.length < 3) return
  const c = centroid(g)
  mark(ctx, c, 'magic')
  if (eastAsian(ctx.p.culture)) {
    if (eastCompound(ctx, g, 'sect')) ctx.out.wonders.push({ p: [c[0], c[1]], r: 10, kind: 'spring' })
    else eastWard(ctx, block, false)
    return
  }
  // 魔法阵连同石柱一整圈都不能压路、压水
  const r0 = Math.min(34, Math.sqrt(area(g)) * 0.32)
  const spot = fit(g, (q, s) => ({ q, r: r0 * s }), (t) => inside(circlePoly(t.q, t.r * 1.2, 16), g) && isFree(ctx, circlePoly(t.q, t.r * 1.2, 16), { pad: 1 }), [1, 0.85, 0.7, 0.55])
  if (!spot) return urban(ctx, block, 'common')
  const { q: mc, r } = spot
  emitArea(ctx, 'greens', g, 'garden')
  ctx.out.wonders.push({ p: mc, r, kind: 'circle' })
  addBuilding(ctx, circlePoly(mc, r * 0.28, 20), 'magic')
  // 围绕的石柱
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    addBuilding(ctx, circlePoly([mc[0] + Math.cos(a) * r * 1.12, mc[1] + Math.sin(a) * r * 1.12], 1.2, 8), 'shed')
  }
  // 整个魔法阵登记为占地：树与房屋都绕开
  ctx.occ.add(circlePoly(mc, r * 1.2, 16))
  // 先盖房再种树，树就不会被房子压住
  urban(ctx, block, 'common', [circlePoly(mc, r * 1.4, 16)])
  scatterTrees(ctx, g, 0.003, 3, 5)
}

// —————————————————————— 东方：院落 ——————————————————————


/**
 * 四合院：正房坐北朝南，东西厢房，南侧倒座与院门。
 * 院落顺着地块摆：在地块的两条主轴里取最接近正北的方向当"北"，斜地块上的院子也跟着斜。
 */
export function siheyuan(ctx: Ctx, lot: Poly) {
  const N = northOf(ctx).n
  const ob = obb(lot)
  const axes: P[] = [ob.axis, [-ob.axis[0], -ob.axis[1]], [-ob.axis[1], ob.axis[0]], [ob.axis[1], -ob.axis[0]]]
  let n = axes[0]
  for (const a of axes) if (a[0] * N[0] + a[1] * N[1] > n[0] * N[0] + n[1] * N[1]) n = a
  const e: P = [-n[1], n[0]]
  // 斜地块上的院子也取成矩形（院墙规整），只要不比原地块小太多
  const sq = inscribedRect(lot, e, { v: n, minSide: 8 })
  if (sq && area(sq) > area(lot) * 0.25) lot = sq
  const { u0, u1, v0, v1, box } = localBox(lot, e, n)
  const w = u1 - u0
  const h = v1 - v0
  // 院墙等到至少放下一座房子再画，免得留下空框
  let built = 0
  const wall = () => built === 1 && emitArea(ctx, 'enclosures', lot)
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
    if (q.length < 3) return
    // 被地块斜边切过的屋子重新取成顺院落方向的矩形
    const r = q.length === 4 && area(q) > area(p) * 0.995 ? q : inscribedRect(q, e, { v: n, minSide: 3, bands: [[0, 1], [0, 0.8], [0.2, 1], [0.1, 0.9]] })
    if (r && area(r) > 10 && addBuilding(ctx, r, kind)) {
      built++
      wall()
    }
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

/** 东式大型院落群（宫城、寺观、宗门）：按骨架与元素池拼，见 compose/chinese.ts */
export { eastCompound }

/** 东式里坊：坊内十字街分成四块，每块排布院落 */
export function eastWard(ctx: Ctx, block: Poly, rich: boolean, nearRoad = Infinity) {
  const { n, e } = northOf(ctx)
  const c = centroid(block)
  const cross = ctx.p.size === 'city' ? 5 : 3.5
  const quads: Poly[] = []
  for (const a of splitConvex(block, c, n, cross)) for (const b of splitConvex(a, c, e, cross)) if (b.length >= 3) quads.push(b)
  // 密度档：密的是一进的小院挤成大杂院、胡同多；疏的是多进大宅，后面带园子
  const d = rich ? 'low' : ctx.wardDensity
  const maxA = rich ? 900 : d === 'high' ? 230 : d === 'low' ? 1100 : ctx.p.size === 'city' ? 520 : 600
  const minA = d === 'high' ? 90 : 160
  const alleyP = d === 'high' ? 0.6 : 0.35
  for (const q of quads) {
    const lots = subdivide(ctx, q, { maxA, minA, alley: 2.2, alleyP, depth: 30, fill: 1, irr: 0.25 })
    for (const lot of lots) {
      if (nearRoad < Infinity && ctx.corridors.gap(centroid(lot.poly)) > nearRoad) {
        if (ctx.rng.next() < 0.15) scatterTrees(ctx, insetConvex(lot.poly, 2), 0.004, 2.5, 4)
        continue
      }
      if (ctx.rng.next() < (d === 'high' ? 0.02 : 0.06)) {
        const g = placeable(ctx, insetConvex(lot.poly, 1))
        if (g) scatterTrees(ctx, g, 0.008, 2.5, 4)
        continue
      }
      let l = placeable(ctx, insetConvex(lot.poly, 0.5))
      if (!l || area(l) < 60) continue
      // 疏档的大宅：沿长轴切出后园（花木、假山池沼一类）；宅子盖起来了才有园子
      let garden: Poly | null = null
      if (d === 'low' && area(l) > 750 && ctx.rng.next() < 0.55) {
        const ob = obb(l)
        const cut: P = [ob.center[0] + ob.axis[0] * ob.len * 0.15, ob.center[1] + ob.axis[1] * ob.len * 0.15]
        const [p1, p2] = splitConvex(l, cut, [-ob.axis[1], ob.axis[0]], 1.5)
        const [home, yard] = area(p1) > area(p2) ? [p1, p2] : [p2, p1]
        if (home.length >= 3 && yard.length >= 3 && area(yard) > 120) {
          l = home
          garden = yard
        }
      }
      const n0 = ctx.out.buildings.length
      ctx.estate = d === 'low'
      siheyuan(ctx, l)
      ctx.estate = false
      const g = garden && ctx.out.buildings.length > n0 ? insetConvex(garden, 1) : null
      if (g && g.length >= 3) {
        emitArea(ctx, 'greens', g, 'garden')
        emitArea(ctx, 'enclosures', garden!)
        scatterTrees(ctx, g, 0.01, 2, 3.5)
      }
    }
  }
}

/** 东式市：密集的店铺 */
/**
 * 东方的市（唐长安的东西市）：四周市墙；大市由"井"字街分成九区，当中是市署（管市的衙门与市楼），
 * 其余各区沿街是一排排按行成列的肆（铺面），靠里是邸店（货栈兼客舍）；中等的市是十字街分四区、
 * 路口立市楼；小市不分区，一圈铺面围着当中的市楼。铺面与邸店不住人（不占民居名额），所以市总是满的。
 */
export function eastMarket(ctx: Ctx, block: Poly) {
  const { n, e } = northOf(ctx)
  const wall = placeable(ctx, insetConvex(block, 1.5), 2, 0.4)
  if (!wall || area(wall) < 500) return urban(ctx, block, 'market')
  emitArea(ctx, 'enclosures', wall)
  const { u0, u1, v0, v1, at, box } = localBox(wall, e, n)
  const A = area(wall)
  const k = A > 9000 ? 3 : A > 2500 ? 2 : 1
  const lane = k === 3 ? 6 : 5
  const cut = (lo: number, hi: number) => Array.from({ length: k + 1 }, (_, i) => lo + ((hi - lo) * i) / k)
  const us = cut(u0, u1)
  const vs = cut(v0, v1)
  // 街：两横两纵（井字）或一横一纵（十字），截到市墙里
  for (const u of us.slice(1, -1)) {
    const c = chord(wall, n, e, u)
    if (c) addRoad(ctx, { line: [at(u, c[0]), at(u, c[1])], width: lane, kind: 'lane' }, 0.6)
  }
  for (const v of vs.slice(1, -1)) {
    const c = chord(wall, e, n, v)
    if (c) addRoad(ctx, { line: [at(c[0], v), at(c[1], v)], width: lane, kind: 'lane' }, 0.6)
  }
  const cu = (u0 + u1) / 2
  const cv = (v0 + v1) / 2
  // 市楼：九区的市楼在市署里（下面盖）；其余立在市的正中（十字路口、或一圈铺面当中的小场子）
  if (k < 3) {
    const t = Math.min(5, (u1 - u0) * 0.08, (v1 - v0) * 0.08)
    const sq = box(cu - t - 5, cu + t + 5, cv - t - 5, cv + t + 5)
    if (sq.every((q) => pointInPoly(q, wall))) {
      emitArea(ctx, 'plazas', sq)
      ctx.occ.add(sq)
      place(ctx, box(cu - t, cu + t, cv - t, cv + t), 'tower', { tags: ['river', 'wall'] })
    }
  }
  mark(ctx, at(cu, cv), 'market')
  const shop = (poly: Poly) => place(ctx, poly, 'large', { pad: 0.3 }, { floors: 1, units: 0 })
  const g = lane / 2 + 1.5
  const rh = ctx.rng
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      const [a0, a1, b0, b1] = [us[i] + (i ? g : 1.5), us[i + 1] - (i < k - 1 ? g : 1.5), vs[j] + (j ? g : 1.5), vs[j + 1] - (j < k - 1 ? g : 1.5)]
      if (a1 - a0 < 10 || b1 - b0 < 10) continue
      const cell = clipConvex(box(a0, a1, b0, b1), wall)
      if (cell.length < 3 || area(cell) < 100) continue
      if (k === 3 && i === 1 && j === 1) {
        // 市署：铺装的院子，北面正厅，当中市楼
        emitArea(ctx, 'plazas', cell)
        const mu = (a0 + a1) / 2
        const hw = Math.min(14, (a1 - a0) * 0.35)
        place(ctx, box(mu - hw, mu + hw, b1 - Math.min(12, (b1 - b0) * 0.3), b1 - 2), 'civic', { pad: 0.5 })
        const t = Math.min(6, (a1 - a0) * 0.14)
        place(ctx, box(mu - t, mu + t, (b0 + b1) / 2 - t, (b0 + b1) / 2 + t), 'tower', { pad: 0.5 })
        continue
      }
      // 肆：沿这一区的每条边排一圈铺面（面宽 5 ~ 7 米、进深至多 8 米，一间挨一间，朝着街）
      const d = Math.min(8, Math.sqrt(area(cell)) * 0.22)
      const cc = centroid(cell)
      for (let m = 0; m < cell.length; m++) {
        const p = cell[m]
        const q = cell[(m + 1) % cell.length]
        const L = dist(p, q)
        if (L < 6) continue
        const u: P = [(q[0] - p[0]) / L, (q[1] - p[1]) / L]
        let nn: P = [-u[1], u[0]]
        if ((cc[0] - p[0]) * nn[0] + (cc[1] - p[1]) * nn[1] < 0) nn = [-nn[0], -nn[1]]
        for (let s = 1; s + 4 < L - 1; ) {
          const w = Math.min(5 + rh.next() * 2, L - 1 - s)
          const mid: P = [p[0] + u[0] * (s + w / 2) + nn[0] * (d / 2 + 0.3), p[1] + u[1] * (s + w / 2) + nn[1] * (d / 2 + 0.3)]
          const piece = rect(mid, u, w - 0.4, d)
          if (piece.every((v) => pointInPoly(v, cell))) shop(piece)
          s += w
        }
      }
      // 邸店：里面一两座大货栈，其余是堆货的场院
      const yard = insetConvex(cell, d + 3)
      if (yard.length >= 3 && area(yard) > 120) {
        const b = obb(yard)
        const parts = b.len > b.wid * 1.6 && rh.next() < 0.7 ? splitConvex(yard, b.center, [-b.axis[1], b.axis[0]], 3) : [yard]
        for (const part of parts) {
          const r = part.length >= 3 ? insetConvex(part, 1 + rh.next() * 2) : []
          if (r.length >= 3 && area(r) > 60) shop(r)
        }
      }
    }
}

export { DENS }
