import { dwelling } from '../undo'
import { clamp } from '../../gen/util'
import { emitArea, hashAt, isFree, placeable, wardRng, memo, type Ctx } from '../ctx'
import { FEATURE, type FeatureId } from '../features'
import { area, centroid, circlePoly, dist, insetConvex, orient, segDist, type P, type Poly } from '../geom'
import type { Tri, Ward, WardType } from '../types'
import { addBuilding, addGroup, urban } from '../wards'
import { RESIDENTIAL } from './common'
import type { CityPlan, PlanRoad, PlanZone } from './types'
import * as dmath from '../../gen/dmath'

/**
 * 罗马营寨城（castrum / colonia，缩到地图的尺度）：
 * - 扑克牌形的矩形城墙（四角圆滑），长宽比约 1.2 ~ 1.5，墙内一圈顺城街（via sagularis）；
 * - 南北大街（cardo）与东西大街（decumanus）十字相交、四端各开一座城门，比其余街道宽；
 * - 其余是等宽街道围成的方整街区（insulae）；
 * - 城心那一格是广场（forum），大街从它的两条边上经过，十字路口就在广场的一角：
 *   方格的街道线落在站点的中线上，城心站点只能是一格的中心，于是让交点错开半格（朝哪个角按种子定），
 *   城墙围着交点（南北大街居中，东西大街两侧可差一排）。广场背离东西大街的一头是主神庙，隔着南北大街是浴场；
 * - 规划强度低时只是城心的营寨，墙外是有机生长的中世纪城郊；强度 1 时整座城都是方格；
 * - 大街没有干道经过的一端也开城门，门外接一段路。
 */

/** 街区的间距（米）：沿 u（东西大街方向）× 沿 v（南北大街方向，长轴） */
const PU = 72
const PV = 84
/** 顺城街中线到城墙的距离、城墙圆角半径 */
const GAP = 12
const CORNER = 30

/**
 * 营寨的方格：交点 X 在城心旁半格（su、sv 为 ±1），南北大街是 u = xu，东西大街是 v = xv；
 * 第 i 列街区在 u = xu + i·PU 与 xu + (i+1)·PU 之间（第 j 排同理），营寨占 i0..i1 列、j0..j1 排，外沿就是顺城街。
 * 东西大街两侧的排数可以差一排（营寨的前营、后营本来就不等长），长宽比才调得细；多出的一排在广场、神庙那一侧。
 * 临海时整座营寨按 z.shift 往岸上挪整数格（格点仍以城心为原点，人口变化时已有街区不动）；
 * 交点两侧至少各留一格，广场那格总在墙里，大街也不会贴着城墙。
 */
interface Grid {
  su: number
  sv: number
  xu: number
  xv: number
  i0: number
  i1: number
  j0: number
  j1: number
}

function grid(ctx: Ctx, z: Pick<PlanZone, 'R' | 'shift'>): Grid {
  const su = hashAt(ctx, ctx.center, 'castrum.flipU') < 0.5 ? 1 : -1
  const sv = hashAt(ctx, ctx.center, 'castrum.flipV') < 0.5 ? 1 : -1
  // 长宽比 1.2 ~ 1.5，面积与规划区的圆相当
  const ratio = 1.2 + hashAt(ctx, ctx.center, 'castrum.ratio') * 0.3
  // 营寨住满时比按平均密度估的更密（老城的街区多是高密度档）：强度低时面积收小一些
  const k = 0.6 + 0.4 * strength(ctx)
  const au = Math.sqrt((Math.PI * z.R * z.R * k) / (4 * ratio))
  const nu = Math.max(1, Math.round(au / PU))
  const rows = Math.max(3, Math.round((Math.max(au * ratio, nu * PU * 1.2) * 2) / PV))
  const near = Math.ceil(rows / 2)
  const [n0, n1] = sv > 0 ? [near, rows - near] : [rows - near, near]
  const ou = clamp(Math.round(z.shift[0] / PU), 1 - nu, nu - 1)
  const ov = clamp(Math.round(z.shift[1] / PV), 1 - n1, n0 - 1)
  return { su, sv, xu: (su * PU) / 2, xv: (sv * PV) / 2, i0: ou - nu, i1: ou + nu - 1, j0: ov - n0, j1: ov + n1 - 1 }
}

/** 顺城街（d = 0）或城墙（d = GAP）的四至 */
function bounds(g: Grid, d: number) {
  return { u0: g.xu + g.i0 * PU - d, u1: g.xu + (g.i1 + 1) * PU + d, v0: g.xv + g.j0 * PV - d, v1: g.xv + (g.j1 + 1) * PV + d }
}

/** 局部坐标里的圆角矩形 */
function roundRect(z: Pick<PlanZone, 'fromUV'>, b: ReturnType<typeof bounds>, r: number, n = 6): P[] {
  const corners: [number, number, number][] = [
    [b.u1 - r, b.v1 - r, 0],
    [b.u0 + r, b.v1 - r, 0.5],
    [b.u0 + r, b.v0 + r, 1],
    [b.u1 - r, b.v0 + r, 1.5],
  ]
  const out: P[] = []
  for (const [cu, cv, a0] of corners)
    for (let k = 0; k <= n; k++) {
      const a = (a0 + k / (n * 2)) * Math.PI
      out.push(z.fromUV(cu + dmath.cos(a) * r, cv + dmath.sin(a) * r))
    }
  return out
}

/** 片区所在的格（i 沿 u、j 沿 v；城心那一格是 (fi, fj)） */
function cellOf(g: Grid, uv: P): [number, number] {
  return [Math.floor((uv[0] - g.xu) / PU), Math.floor((uv[1] - g.xv) / PV)]
}
const forumCell = (g: Grid): [number, number] => [g.su > 0 ? -1 : 0, g.sv > 0 ? -1 : 0]

/** 四座城门的方向（u、v 上的 ±1） */
const SIDES: P[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** 大街上某一端城门的位置 */
function gateAt(z: PlanZone, g: Grid, s: P): P {
  const b = bounds(g, GAP)
  return z.fromUV(s[0] ? (s[0] > 0 ? b.u1 : b.u0) : g.xu, s[1] ? (s[1] > 0 ? b.v1 : b.v0) : g.xv)
}

/** 已经有干道出去的城门（每座城只记一次） */
export const castrum: CityPlan = {
  id: 'castrum',
  outline(ctx, z) {
    return roundRect(z, bounds(grid(ctx, z), GAP), CORNER)
  },
  sites(ctx, z) {
    // 每个街区一个站点；墙外再多一圈，使墙内最外一排街区的外沿正好是顺城街
    const g = grid(ctx, z)
    const out: P[] = []
    for (let j = g.j0 - 1; j <= g.j1 + 1; j++)
      for (let i = g.i0 - 1; i <= g.i1 + 1; i++) out.push(z.fromUV(g.xu + (i + 0.5) * PU, g.xv + (j + 0.5) * PV))
    return out
  },
  streets(ctx, z) {
    const g = grid(ctx, z)
    const b = bounds(g, 0)
    const w = bounds(g, GAP + 6)
    const main = ctx.cfg.main + 2
    const street = ctx.cfg.lane + 1
    const out: PlanRoad[] = []
    // 顺城街：沿城墙内侧一圈
    const ring = roundRect(z, b, Math.max(6, CORNER - GAP))
    out.push({ line: [...ring, ring[0]], width: street + 0.5, kind: 'street', named: true })
    // 街区之间的街；大街从城门到城门
    for (let k = g.i0 + 1; k <= g.i1; k++) {
      const u = g.xu + k * PU
      out.push(k ? { line: [z.fromUV(u, b.v0), z.fromUV(u, b.v1)], width: street, kind: 'street' } : { line: [z.fromUV(u, w.v0), z.fromUV(u, w.v1)], width: main, kind: 'main', named: true })
    }
    for (let k = g.j0 + 1; k <= g.j1; k++) {
      const v = g.xv + k * PV
      out.push(k ? { line: [z.fromUV(b.u0, v), z.fromUV(b.u1, v)], width: street, kind: 'street' } : { line: [z.fromUV(w.u0, v), z.fromUV(w.u1, v)], width: main, kind: 'main', named: true })
    }
    // 没有干道经过的城门也开出来，门外接一段路
    for (const s of openGates(ctx, z, g)) out.push({ line: s, width: street + 1, kind: 'street' })
    return out
  },
  exit(ctx, z, dir) {
    // 按干道原本的方向走最近的一座城门；那座门已经有干道、而另一座也差不多顺路时改走另一座，四门尽量都有路
    const g = grid(ctx, z)
    const used = memo(ctx, 'castrum.sides', () => new Set<number>())
    const [du, dv] = z.toUV([z.c[0] + dmath.cos(dir), z.c[1] + dmath.sin(dir)])
    const a = dmath.atan2(dv, du)
    const off = (s: P) => {
      const d = Math.abs(dmath.atan2(s[1], s[0]) - a) % (Math.PI * 2)
      return Math.min(d, Math.PI * 2 - d)
    }
    const order = SIDES.map((s, k) => [off(s), k] as const).sort((p, q) => p[0] - q[0])
    const k = used.has(order[0][1]) && !used.has(order[1][1]) && order[1][0] < 1.2 ? order[1][1] : order[0][1]
    used.add(k)
    const s = SIDES[k]
    // 从大街的交点出发，沿大街出城门
    const pts: P[] = []
    for (let t = 0; t < z.R * 4; t += 5) {
      const q = z.fromUV(g.xu + s[0] * t, g.xv + s[1] * t)
      pts.push(q)
      if (!z.contains(q)) break
    }
    return pts
  },
  assign(ctx, z, lots) {
    const g = grid(ctx, z)
    const [fi, fj] = forumCell(g)
    // 只在墙里的街区里点名（墙外那一圈站点不算）
    const within = (i: number, j: number) => i >= g.i0 && i <= g.i1 && j >= g.j0 && j <= g.j1
    const at = (i: number, j: number) =>
      within(i, j)
        ? lots.find((l) => {
            const [a, b] = cellOf(g, l.uv)
            return a === i && b === j
          })
        : undefined
    const set = (i: number, j: number, t: WardType) => {
      const l = at(i, j)
      if (l) l.type = t
    }
    // 城心：广场（商贸城是大市场，魔法城的主塔不动）
    const c = at(fi, fj)
    if (c && c.type !== 'magic' && c.type !== 'market') c.type = 'plaza'
    // 广场背离东西大街的一头是主神庙，隔着南北大街是浴场（按商人区的档次盖周围）
    set(fi, fj - g.sv, 'temple')
    if (g.i1 - g.i0 >= 3 || g.j1 - g.j0 >= 4) set(fi + g.su, fj, 'merchant')
  },
  build(ctx, ward, block, z) {
    const g = grid(ctx, z)
    return settled(ctx, z, g).has(ward) || special(ctx, z, g, ward, block)
  },
  wall(ctx, z) {
    return roundRect(z, bounds(grid(ctx, z), GAP), CORNER)
  },
}

/** 城心旁的广场、神庙、浴场（西式）；返回 false 用通用填法 */
function special(ctx: Ctx, z: PlanZone, g: Grid, ward: Ward, block: Poly): boolean {
  const [fi, fj] = forumCell(g)
  const [i, j] = cellOf(g, z.toUV(centroid(block)))
  const cell = cellFrame(z, g, i, j, ctx.corridors.clip(block) ?? block)
  if (i === fi && j === fj && (ward.type === 'plaza' || ward.type === 'market')) return forum(ctx, cell, ward.type === 'market' || ctx.p.function === 'trade')
  if (i === fi && j === fj - g.sv && ward.type === 'temple') return capitolium(ctx, cell, block)
  if (i === fi + g.su && j === fj && ward.type === 'merchant') return baths(ctx, cell, block)
  return false
}

/** 按街区盖满的片区 */
/**
 * 营寨是建城时一次划好的：墙里的住宅街区先住满（由城心往外，按营寨的方框量远近），其余的人口才去有机的城郊。
 * 框架按离城心的直线距离由近到远盖房，长方的营寨两端会空着、墙外却先长出房子，所以第一次填规划片区时
 * 先把墙里的住宅街区按顺序盖满（每块照常用自己的随机数流与密度档，占用率取满），用掉的户数不超过
 * 规划强度那一份；没轮到的街区留给通用填法，与城郊一起按距离渐变。返回已经盖好的片区。
 */
function settled(ctx: Ctx, z: PlanZone, g: Grid): Set<Ward> {
  const got = ctx.memo.get('castrum.settled') as Set<Ward> | undefined
  if (got) return got
  const done = new Set<Ward>()
  ctx.memo.set('castrum.settled', done)
  const b = bounds(g, 0)
  const cu = (b.u0 + b.u1) / 2
  const cv = (b.v0 + b.v1) / 2
  const reach = (w: Ward) => {
    const [u, v] = z.toUV(centroid(w.poly))
    return Math.max(Math.abs(u - cu) / (b.u1 - cu), Math.abs(v - cv) / (b.v1 - cv))
  }
  const wards = ctx.out.wards.filter((w) => w.inner && RESIDENTIAL.has(w.type) && reach(w) < 1).sort((p, q) => reach(p) - reach(q))
  const keep = { rng: ctx.rng, fill: ctx.wardFill, dens: ctx.wardDensity, type: ctx.wardType, budget: ctx.houseBudget }
  ctx.houseBudget = Math.round(keep.budget * strength(ctx))
  const rest = keep.budget - ctx.houseBudget
  for (const w of wards) {
    if (ctx.houseBudget <= 0) break
    const block = insetConvex(w.poly, ctx.cfg.lane / 2 + 0.4)
    if (block.length < 3) continue
    ctx.rng = wardRng(ctx, centroid(w.poly))
    ctx.wardFill = 1
    ctx.wardDensity = w.density ?? 'mid'
    ctx.wardType = w.type
    const nb = ctx.out.buildings.length
    const own = special(ctx, z, g, w, block)
    if (!own) FEATURE[w.type as FeatureId].build!(ctx, w, block, ctx.env)
    // 一户也没盖上（多半是水边、陡坡）：留给通用填法，照常会改作菜园
    if (own || ctx.out.buildings.slice(nb).some(dwelling)) done.add(w)
  }
  ctx.houseBudget = Math.max(0, ctx.houseBudget) + rest
  ctx.rng = keep.rng
  ctx.wardFill = keep.fill
  ctx.wardDensity = keep.dens
  ctx.wardType = keep.type
  return done
}

const strength = (ctx: Ctx) => ctx.p.planStrength!

/**
 * 一格的局部坐标 (a, w)：w 背离东西大街（广场 → 神庙的方向），a 背离南北大街；
 * a0..a1 × w0..w1 是片区（已让出街面）的范围。
 */
interface Cell {
  pt(a: number, w: number): P
  box(a0: number, a1: number, w0: number, w1: number): Poly
  a0: number
  a1: number
  w0: number
  w1: number
}

function cellFrame(z: PlanZone, g: Grid, i: number, j: number, block: Poly): Cell {
  const cu = g.xu + (i + 0.5) * PU
  const cv = g.xv + (j + 0.5) * PV
  const pt = (a: number, w: number) => z.fromUV(cu - g.su * a, cv - g.sv * w)
  const aw = block.map((q) => {
    const [u, v] = z.toUV(q)
    return [(cu - u) * g.su, (cv - v) * g.sv] as P
  })
  return {
    pt,
    box: (a0, a1, w0, w1) => orient([pt(a0, w0), pt(a1, w0), pt(a1, w1), pt(a0, w1)]),
    a0: Math.min(...aw.map((q) => q[0])),
    a1: Math.max(...aw.map((q) => q[0])),
    w0: Math.min(...aw.map((q) => q[1])),
    w1: Math.max(...aw.map((q) => q[1])),
  }
}

/** 按位置从候选里挑一个名字 */
function pick(ctx: Ctx, q: P, tag: string, pool: [string, string, string][]): Tri {
  const [zh, en, ja] = pool[Math.floor(hashAt(ctx, q, tag) * pool.length) % pool.length]
  return { zh, en, ja }
}

/**
 * 广场（forum）：整格铺装；背离南北大街的长边是会堂（basilica），沿南北大街一侧是柱廊，
 * 中间立雕像；商贸城的广场上摆满摊位。
 */
function forum(ctx: Ctx, c: Cell, stalls: boolean): boolean {
  const { a0, a1, w0, w1 } = c
  if (a1 - a0 < 30 || w1 - w0 < 30) return false
  const pave = ctx.corridors.clip(c.box(a0, a1, w0, w1), ['wall']) ?? c.box(a0, a1, w0, w1)
  emitArea(ctx, 'plazas', pave)
  const big = ctx.p.size === 'city'
  const depth = big ? 16 : 12
  const basilica = c.box(a1 - depth - 1, a1 - 1, w0 + 5, w1 - 5)
  if (addBuilding(ctx, basilica, 'hall', 0.5)) {
    ctx.out.landmarks.push({ p: centroid(basilica), name: pick(ctx, centroid(basilica), 'castrum.name.basilica', BASILICA), kind: 'guild' })
    // 会堂前的柱廊
    addBuilding(ctx, c.box(a1 - depth - 5, a1 - depth - 2.5, w0 + 5, w1 - 5), 'civic', 0.3)
  }
  addBuilding(ctx, c.box(a0 + 1, a0 + 3.5, w0 + 5, w1 - 5), 'civic', 0.3)
  // 雕像立在铺装中间（让开柱廊与会堂）
  const mid = (a0 + 3.5 + a1 - depth - 5) / 2
  const q = c.pt(mid, (w0 + w1) / 2)
  if (!ctx.occ.hitsPoint(q, 3)) {
    ctx.out.landmarks.push({ p: q, kind: 'statue' })
    ctx.occ.add(circlePoly(q, 1.6, 8))
  }
  if (stalls) {
    const rng = ctx.rng
    for (let k = 0, t = 0; k < (big ? 18 : 10) && t < 200; t++) {
      const sa = a0 + 6 + rng.next() * (a1 - depth - a0 - 14)
      const sw = w0 + 6 + rng.next() * (w1 - w0 - 12)
      const s = c.box(sa, sa + 2.4 + rng.next(), sw, sw + 3 + rng.next() * 2)
      if (addBuilding(ctx, s, 'shed', 1.5)) k++
    }
  }
  return true
}

/**
 * 主神庙：整格围成神域，神庙坐在后部、正面朝向广场（高台上的内殿 + 稍窄的前廊），
 * 前面是铺装的庭院与祭坛，两侧柱廊。
 */
function capitolium(ctx: Ctx, c: Cell, block: Poly): boolean {
  const { a0, a1, w0, w1 } = c
  const wa = a1 - a0
  const ww = w1 - w0
  if (wa < 30 || ww < 34) return false
  const big = ctx.p.size === 'city'
  const W = Math.min(big ? 24 : 19, wa * 0.4)
  const L = Math.min(big ? 40 : 32, ww * 0.55)
  const am = (a0 + a1) / 2
  const back = w1 - 5
  const front = back - L
  const cella = c.box(am - W / 2, am + W / 2, front + L * 0.38, back)
  const porch = c.box(am - W * 0.44, am + W * 0.44, front, front + L * 0.4)
  if (!addGroup(ctx, [[cella, 'temple'], [porch, 'temple']], 1)) return false
  const wall = placeable(ctx, insetConvex(block, 1.5), 2, 0.4)
  if (wall && area(wall) > 400) emitArea(ctx, 'enclosures', wall)
  const court = c.box(a0 + 2.5, a1 - 2.5, w0 + 2.5, front - 0.5)
  if (isFree(ctx, court, { tags: ['wall', 'river'] })) emitArea(ctx, 'plazas', court)
  // 祭坛
  const aw = (w0 + front) / 2
  addBuilding(ctx, c.box(am - 1.8, am + 1.8, aw - 1.8, aw + 1.8), 'shed', 0.5)
  // 两侧柱廊
  for (const [p0, p1] of [
    [a0 + 2.5, a0 + 5],
    [a1 - 5, a1 - 2.5],
  ])
    addBuilding(ctx, c.box(p0, p1, w0 + 4, w1 - 4), 'civic', 0.3)
  ctx.out.landmarks.push({ p: centroid(cella), name: pick(ctx, centroid(cella), 'castrum.name.temple', TEMPLE), kind: 'temple' })
  return true
}

/**
 * 浴场：临东西大街的一头是柱廊围着的运动场（palaestra），后面一排浴厅（冷水、温水、热水厅），
 * 热水厅后面凸出半圆的后殿；片区其余的地方照常是街区。
 */
function baths(ctx: Ctx, c: Cell, block: Poly): boolean {
  const { a0, a1, w0, w1 } = c
  const big = ctx.p.size === 'city'
  const W = Math.min(big ? 40 : 30, a1 - a0 - 8)
  const L = Math.min(big ? 56 : 42, w1 - w0 - 8)
  if (W < 22 || L < 30) return false
  const am = (a0 + a1) / 2
  const s0 = w0 + 2
  const hall0 = s0 + L * 0.48
  const hallW = W * 0.9
  const apse = circlePoly(c.pt(am, s0 + L - 7), 6.5, 16).filter((q) => dist(q, c.pt(am, s0)) >= dist(c.pt(am, s0 + L - 7), c.pt(am, s0)) - 0.01)
  const parts: [Poly, 'hall' | 'civic'][] = [
    [c.box(am - hallW / 2, am + hallW / 2, hall0, s0 + L - 7), 'hall'],
    [apse, 'hall'],
    [c.box(am - W / 2, am - W / 2 + 3, s0, hall0 - 1), 'civic'],
    [c.box(am + W / 2 - 3, am + W / 2, s0, hall0 - 1), 'civic'],
  ]
  if (!addGroup(ctx, parts, 0.8)) return false
  const court = c.box(am - W / 2 + 3.5, am + W / 2 - 3.5, s0, hall0 - 1)
  emitArea(ctx, 'plazas', court)
  const foot = c.box(am - W / 2 - 1, am + W / 2 + 1, s0 - 1, s0 + L + 1)
  ctx.occ.add(foot)
  ctx.out.landmarks.push({ p: centroid(parts[0][0]), name: pick(ctx, centroid(foot), 'castrum.name.baths', BATHS), kind: 'guild' })
  urban(ctx, block, 'merchant', [foot])
  return true
}

const BASILICA: [string, string, string][] = [
  ['会堂', 'The Basilica', 'バシリカ'],
  ['议事会堂', 'Basilica of the Council', '議事会堂'],
  ['法庭会堂', 'Basilica of Justice', '法廷会堂'],
]
/** 主神庙：卡皮托利三神庙，或献给某位神祇 */
const TEMPLE: [string, string, string][] = [
  ['卡皮托利神庙', 'The Capitolium', 'カピトリウム'],
  ['朱庇特神庙', 'Temple of Jupiter', 'ユピテル神殿'],
  ['密涅瓦神庙', 'Temple of Minerva', 'ミネルウァ神殿'],
  ['玛尔斯神庙', 'Temple of Mars', 'マルス神殿'],
]
const BATHS: [string, string, string][] = [
  ['公共浴场', 'The Thermae', '公衆浴場'],
  ['大浴场', 'The Great Baths', '大浴場'],
]

/**
 * 没有干道经过的大街尽头也开城门（营寨城四门齐全）：在已经修好的城墙上补门洞、拆掉挡门的塔、护城河上架桥，
 * 返回门外接出去的一段路。
 */
function openGates(ctx: Ctx, z: PlanZone, g: Grid): P[][] {
  const wall = ctx.cityWalls.length === 1 ? ctx.cityWalls[0] : null
  if (!wall) return []
  const roads: P[][] = []
  for (const s of SIDES) {
    const gp = gateAt(z, g, s)
    if (wall.gates.some((q) => dist(q.p, gp) < 25)) continue
    const n = wall.loop.length
    let k = -1
    for (let i = 0; i < n && k < 0; i++) if (wall.solid[i] && segDist(gp, wall.loop[i], wall.loop[(i + 1) % n]).d < 1) k = i
    if (k < 0) continue
    wall.loop.splice(k + 1, 0, gp)
    wall.solid.splice(k + 1, 0, true)
    const out = z.fromUV(z.toUV(gp)[0] + s[0] * PU, z.toUV(gp)[1] + s[1] * PV)
    const angle = dmath.atan2(out[1] - gp[1], out[0] - gp[0])
    wall.gates.push({ p: gp, angle })
    wall.towers = wall.towers.filter((t) => dist(t, gp) > 16)
    ctx.out.landmarks.push({ p: gp, name: ctx.namer.gate(angle), kind: 'gate' })
    if (wall.moat) {
      let best: P | null = null
      let bd = 40
      for (const r of wall.moat.runs)
        for (let i = 0; i + 1 < r.length; i++) {
          const h = segDist(gp, r[i], r[i + 1])
          if (h.d < bd) {
            bd = h.d
            best = [r[i][0] + (r[i + 1][0] - r[i][0]) * h.t, r[i][1] + (r[i + 1][1] - r[i][1]) * h.t]
          }
        }
      if (best) wall.moat.bridges.push({ p: best, angle })
    }
    roads.push([gp, out])
  }
  return roads
}
