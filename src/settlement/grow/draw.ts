import * as dmath from '../../gen/dmath'
import { hash3, hashString } from '../../gen/rng'
import { at, box, type Frame, type P, type Poly } from '../geom'
import type { Building, BuildingKind, Crossing, Field, Road, Settlement } from '../types'
import type { GrowLot, GrowP, GrowState } from './api'
import { ROAD_WIDTH, USES, WAY_ID, manualBlocker, naturalHook, settleParams, terrainOf, useOf, type Blocker } from './core'

// 生长状态 → cartographer 的 Settlement，交给 buildSettlementVector 画（纯函数，不碰 DOM）。
// 盖好的住处、铺子、公家、村心 → buildings（对不上的用途用 shed / hall / large 加 role 文字代画：料场、工棚、作坊……），
// 田 → fields，路 → roads（路过水的地方架一座桥）。在建的不进 buildings，由调用方另外叠；空着的地不画。
// 每块地上的样子（屋子的大小、朝向、退让、靠哪一侧，棚子、院墙、菜园、树）按地块 id 的哈希各不相同：同一块地每次画出来都一样。
// 住处照一次成形的生成器里疏档街坊的一户（wards.ts 的 detached）的样子摆：屋子贴着街、靠宅地的一侧，屋后是院子。
// 没有：片区、街区底色、院墙、注记（wards / blocks / labels 都是空的）。

export interface DrawOpts {
  /** 田的种类（和风、东方用 paddy 水田；默认 crop） */
  fieldKind?: Field['kind']
  /**
   * 自然生长的状态只画地形和手动的东西，不画规划（也就用不着规划）：规划还没算好时先给一张看（见 natural.ts 的 naturalReady）。
   * 图名是种子，不是规划起的名字
   */
  bare?: boolean
}

/** 每户几口人（只用于 stats.population） */
const PER_HOUSEHOLD = 5

/** 地块的用途文字（悬停说明里的 role） */
const ROLE: Record<string, string> = { center: '村心', shop: '作坊', public: '公所', yard: '料场' }

/** 地块的框：临街一角、沿街方向、进深方向、面宽、进深 */
function frame(l: GrowLot) {
  const [p0, p1, , p3] = l.poly
  const fw = dmath.hypot(p1[0] - p0[0], p1[1] - p0[1])
  const fd = dmath.hypot(p3[0] - p0[0], p3[1] - p0[1])
  const u: P = [(p1[0] - p0[0]) / fw, (p1[1] - p0[1]) / fw]
  const n: P = [(p3[0] - p0[0]) / fd, (p3[1] - p0[1]) / fd]
  // 标架的两轴：a 沿街、b 进深（不一定是沿街方向转 90°，所以不用 frameAt）
  const F: Frame = { o: p0, f: u, l: n }
  return { fw, fd, at: (a: number, b: number): P => at(F, a, b), box: (a0: number, a1: number, b0: number, b1: number): Poly => box(F, a0, a1, b0, b1), angle: dmath.atan2(u[1], u[0]) }
}

const inset = (l: GrowLot, d: number) => {
  const f = frame(l)
  return f.box(d, f.fw - d, d, f.fd - d)
}

export function toSettlement(state: GrowState, o: DrawOpts = {}): Settlement {
  if (!state.plan) return fromLots(state, o)
  return o.bare ? handLayer(state, manualBlocker(state), o) : composed(state, o)
}

/** 自然生长的状态里手动的那一层（手动铺的路、手动摆的地块，底下是地形）。只跟手动的东西、地形有关：没变就是同一张 */
function handLayer(state: GrowState, block: Blocker | null, o: DrawOpts): Settlement {
  const T = terrainOf(state)
  if (!handMemo || handMemo.block !== block || handMemo.field !== o.fieldKind || handMemo.T !== T)
    handMemo = { block, field: o.fieldKind, T, st: fromLots({ ...state, lots: state.lots.filter((l) => l.ref === undefined), roads: state.roads.filter((r) => r.id < WAY_ID) }, o) }
  return handMemo.st
}

/**
 * 自然生长的聚落：规划的成长史在这一刻的样子（见 natural.ts），上面叠手动铺的路、手动摆的地块。
 * 手动的优先：规划里的房子、田、院墙、绿地、树落在手动的地块、路上的不画，规划的路里贴着手动的路走的那几段不画（规划那一层给的时候已经去掉）。
 * 没变的东西每次都是同一个对象（规划的东西来自成长史，手动的那一层、修剪过的路都记着）：调用方只重画变了的地方（见 history.ts 的 changedBoxes）
 */
function composed(state: GrowState, o: DrawOpts): Settlement {
  const block = manualBlocker(state)
  const plan = naturalHook('draw')(state, block)
  if (!block) return plan
  // 规划的那一刻、手动的东西、田的画法都没变：还是上次那张（调用方凭同一个对象知道不用重画）
  if (last && last.plan === plan && last.block === block && last.field === o.fieldKind) return last.out
  // 手动的那一层：规划往前走时不重画
  const hand = handLayer(state, block, o)
  // 规划里的各样东西压没压到：查过的记着（快照之间东西是同一个对象）
  let hit = covered.get(block)
  if (!hit) covered.set(block, (hit = new WeakMap()))
  const seen = hit
  const clear = <X extends object>(xs: X[], test: (x: X) => boolean) =>
    xs.filter((x) => {
      let v = seen.get(x)
      if (v === undefined) seen.set(x, (v = test(x)))
      return !v
    })
  const poly = (q: P[]) => block.poly(q as GrowP[])
  const out: Settlement = {
    ...plan,
    buildings: [...clear(plan.buildings, (b) => poly(b.poly)), ...hand.buildings],
    fields: [...clear(plan.fields, (f) => poly(f.poly)), ...hand.fields],
    greens: [...clear(plan.greens, (g) => poly(g.poly)), ...hand.greens],
    enclosures: [...clear(plan.enclosures, poly), ...hand.enclosures],
    plazas: [...plan.plazas, ...hand.plazas],
    trees: [...clear(plan.trees, (t) => block.point(t.p as GrowP, t.r)), ...hand.trees],
    roads: [...plan.roads, ...hand.roads],
    crossings: [...plan.crossings, ...hand.crossings],
    stats: {
      ...plan.stats,
      buildings: plan.stats.buildings + hand.stats.buildings,
      houses: plan.stats.houses + hand.stats.houses,
      households: plan.stats.households + hand.stats.households,
      population: plan.stats.population + hand.stats.population,
    },
  }
  last = { plan, block, field: o.fieldKind, out }
  return out
}
/** 最近合成的一张、最近画的手动的那一层、各个 Blocker 查过的东西（见 composed） */
let last: { plan: Settlement; block: Blocker; field: DrawOpts['fieldKind']; out: Settlement } | null = null
let handMemo: { block: Blocker | null; field: DrawOpts['fieldKind']; T: object; st: Settlement } | null = null
const covered = new WeakMap<Blocker, WeakMap<object, boolean>>()

/** 沿路摆的地块、手动铺的路 → 聚落（没有规划的状态整个是它；有规划的状态里只是手动的那一层） */
function fromLots(state: GrowState, o: DrawOpts): Settlement {
  const T = terrainOf(state)
  const buildings: Building[] = []
  const fields: Field[] = []
  const greens: Settlement['greens'] = []
  const plazas: Poly[] = []
  const enclosures: Poly[] = []
  const trees: Settlement['trees'] = []
  const tone = (l: GrowLot, k = 0) => hash3(l.id, k, 91)
  const house = (l: GrowLot, kind: BuildingKind, poly: Poly, extra: Partial<Building> = {}) => {
    const role = ROLE[l.use]
    buildings.push({ poly, kind, tone: tone(l), ridge: frame(l).angle, ...(role ? { role } : {}), ...extra })
  }
  // 住处按主人分组：一户的头一块地上盖房，其余的是园子
  const homes = new Map<string, GrowLot[]>()
  const solo: GrowLot[] = []
  for (const l of state.lots) {
    // 住处一类：home 和不认得的用途（和选址时的归类一样）
    if (l.state !== 'built' || useOf(l.use) !== USES.home) continue
    if (l.owner === undefined) solo.push(l)
    else (homes.get(l.owner) ?? homes.set(l.owner, []).get(l.owner)!).push(l)
  }
  let households = 0
  /** 一块地上的后院：屋后到地块尽头，给菜园、树、棚子用（a0 ~ a1 沿街、b0 ~ b1 进深） */
  const backyard = (l: GrowLot, f: ReturnType<typeof frame>, b0: number, withShed: boolean) => {
    const r = (k: number) => tone(l, k)
    let a0 = 1.5
    let a1 = f.fw - 1.5
    // 柴棚：后院尽头的一角
    if (withShed) {
      const sw = 3 + 1.5 * r(12)
      const sd = 3.5 + 2 * r(13)
      const left = r(17) < 0.5
      house(l, 'shed', left ? f.box(1.2, 1.2 + sw, f.fd - 1.2 - sd, f.fd - 1.2) : f.box(f.fw - 1.2 - sw, f.fw - 1.2, f.fd - 1.2 - sd, f.fd - 1.2), { role: '柴棚' })
      if (left) a0 = sw + 2.5
      else a1 = f.fw - sw - 2.5
    }
    const b1 = f.fd - 1.5
    if (b1 - b0 < 4) return
    if (r(15) < 0.6) greens.push({ poly: f.box(a0, a1, b0, b1), kind: 'garden' })
    const count = Math.floor(r(16) * 3.2)
    for (let k = 0; k < count; k++) trees.push({ p: f.at(a0 + 1 + (a1 - a0 - 2) * r(20 + k), b0 + 1 + (b1 - b0 - 2) * r(24 + k)), r: 1.8 + 1.4 * r(28 + k) })
  }
  const homeOf = (group: GrowLot[]) => {
    households++
    const [main, ...rest] = [...group].sort((a, b) => a.id - b.id)
    const f = frame(main)
    const n = group.length
    const r = (k: number) => tone(main, k)
    if (n >= 4) {
      // 四块以上：大宅，院子围起来，屋后一间厢房
      const w = 13 + 3 * r(4)
      const d = 10 + 2.5 * r(5)
      house(main, 'large', f.box((f.fw - w) / 2, (f.fw + w) / 2, 2, 2 + d), { floors: 2, units: 1 })
      enclosures.push(inset(main, 0.8))
      backyard(main, f, 2 + d + 1.5, false)
    } else {
      // 一块地：平房；两三块：大一点的两层。屋子贴着街、靠宅地的一侧（另一侧留一条进后院的过道），少数退后留出前院、少数山墙朝街
      const big = n >= 2
      const gable = !big && r(3) < 0.22
      const w = gable ? 5.5 + 1.5 * r(4) : (big ? 10 : 6.5) + 4 * r(4)
      const d = gable ? 8 + 3 * r(5) : (big ? 8 : 6) + 2.5 * r(5)
      const set = r(6) < 0.18 ? 2.5 + 2.5 * r(7) : 0.5 + 0.9 * r(7)
      const side = r(8) < 0.5 ? -1 : 1
      const cx = f.fw / 2 + side * Math.max(0, (f.fw - w) / 2 - 1.2) * (0.35 + 0.65 * r(9))
      house(main, 'house', f.box(cx - w / 2, cx + w / 2, set, set + d), { floors: big || r(10) < 0.2 ? 2 : 1, units: 1, ...(gable ? { ridge: f.angle + Math.PI / 2 } : {}) })
      if (r(14) < 0.55) enclosures.push(inset(main, 0.8))
      backyard(main, f, set + d + 1.5, r(11) < 0.45)
    }
    // 一户多出来的地：菜园，有的种几棵果树、有的盖一间仓房
    for (const g of rest) {
      const gf = frame(g)
      const q = (k: number) => tone(g, k)
      if (q(3) < 0.3) {
        house(g, 'shed', gf.box(2, 2 + 6 + 3 * q(4), 2, 2 + 4.5 + 1.5 * q(5)), { role: '仓房' })
        greens.push({ poly: gf.box(1, gf.fw - 1, 9.5, gf.fd - 1), kind: 'garden' })
      } else greens.push({ poly: inset(g, 1), kind: 'garden' })
      if (q(6) < 0.5) for (let k = 0; k < 4; k++) trees.push({ p: gf.at(4 + (gf.fw - 8) * q(10 + k), 11 + (gf.fd - 14) * q(14 + k)), r: 2 + 1.2 * q(18 + k) })
    }
  }
  for (const g of homes.values()) homeOf(g)
  for (const l of solo) homeOf([l])

  /** 田的种类：一片田（同一个主人）种一样的；大多是这种文明的主粮（水田 / 旱地），少数是菜地、牧场、果园、草场 */
  const base = o.fieldKind ?? 'crop'
  const fieldKind = (l: GrowLot): Field['kind'] => {
    const v = l.owner === undefined ? hash3(l.id, 3, 91) * 0.8 : hash3(hashString(l.owner), 3, 91)
    return v < 0.7 ? base : v < 0.82 ? (base === 'crop' ? 'pasture' : 'crop') : v < 0.92 ? 'orchard' : 'meadow'
  }
  for (const l of state.lots) {
    if (l.state !== 'built') continue
    const f = frame(l)
    const r = (k: number) => tone(l, k)
    if (l.use === 'field') fields.push({ poly: inset(l, 0.5), angle: f.angle, kind: fieldKind(l), tone: tone(l) })
    else if (l.use === 'shop') {
      // 铺子、作坊：屋子贴着街，有的两层；屋后一间库房，有的院墙围起来
      const w = 9 + 6 * r(3)
      const d = 8 + 3 * r(4)
      const set = 0.6 + 0.8 * r(5)
      const cx = f.fw / 2 + (r(6) - 0.5) * Math.max(0, f.fw - w - 2)
      house(l, 'large', f.box(cx - w / 2, cx + w / 2, set, set + d), { floors: r(7) < 0.4 ? 2 : 1 })
      if (r(8) < 0.5) {
        const sw = 5 + 3 * r(9)
        const left = r(10) < 0.5
        house(l, 'shed', left ? f.box(1.2, 1.2 + sw, f.fd - 5.5, f.fd - 1.2) : f.box(f.fw - 1.2 - sw, f.fw - 1.2, f.fd - 5.5, f.fd - 1.2), { role: '库房' })
      }
      if (r(11) < 0.35) enclosures.push(inset(l, 0.8))
    } else if (l.use === 'public') {
      // 公所：退后留出门前的一块空场，屋后两棵树
      const w = 12 + 4 * r(3)
      const d = 9 + 3 * r(4)
      const set = 4 + 2 * r(5)
      house(l, 'hall', f.box((f.fw - w) / 2, (f.fw + w) / 2, set, set + d))
      if (r(6) < 0.6) plazas.push(f.box(1, f.fw - 1, 0.5, set - 0.5))
      if (r(7) < 0.7) for (const a of [3, f.fw - 3]) trees.push({ p: f.at(a, f.fd - 2.5), r: 2.2 + r(8) })
    } else if (l.use === 'yard') {
      // 料场、工棚：一块围起来的堆场，靠里一到三间棚子，大小、位置各不一样
      enclosures.push(inset(l, 0.8))
      const count = 1 + Math.floor(r(3) * 3)
      const slot = (f.fw - 3) / count
      for (let k = 0; k < count; k++) {
        const sw = Math.min(slot - 1, 4 + 3.5 * r(4 + k))
        const sd = 4 + 3 * r(8 + k)
        const a0 = 1.5 + slot * k + (slot - sw) * r(12 + k)
        const back = r(16 + k) < 0.75
        house(l, 'shed', back ? f.box(a0, a0 + sw, f.fd - 1.5 - sd, f.fd - 1.5) : f.box(a0, a0 + sw, 2, 2 + sd))
      }
    } else if (l.use === 'center') {
      plazas.push(inset(l, 1))
      house(l, 'civic', f.box(f.fw / 2 - 5, f.fw / 2 + 5, f.fd - 9, f.fd - 2))
    }
  }

  // 圆头：一段一段铺的路首尾相接、几条交在一点时接头是圆滑的
  const roads: Road[] = state.roads.map((r) => ({ line: r.pts, width: ROAD_WIDTH[r.kind], kind: r.kind, roundEnds: true }))
  // 路过水的地方架桥：沿路每 2 米看一下，下水的那一段两头各多出 2 米
  const crossings: Crossing[] = []
  for (const r of state.roads) {
    const pts: P[] = []
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]
      const b = r.pts[i + 1]
      const n = Math.max(1, Math.ceil(dmath.hypot(b[0] - a[0], b[1] - a[1]) / 2))
      for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
    }
    pts.push(r.pts[r.pts.length - 1])
    let start = -1
    pts.forEach((q, k) => {
      const wet = T.waterAt(q) < 0 && !T.seaAt(q)
      if (wet && start < 0) start = k
      if ((!wet || k === pts.length - 1) && start >= 0) {
        const a = pts[Math.max(0, start - 1)]
        const b = pts[Math.min(pts.length - 1, k)]
        crossings.push({ a, b, width: ROAD_WIDTH[r.kind] + 1, kind: 'bridge' })
        start = -1
      }
    })
  }

  const population = Math.round(households * PER_HOUSEHOLD)
  return {
    params: settleParams(state.seed, state.terrain, population),
    // 没有地名：图题写种子
    name: state.seed,
    nameZh: state.seed,
    nameJa: state.seed,
    width: state.size[0],
    height: state.size[1],
    terrain: T.terrain,
    river: T.river ? { line: T.river.line, hw: T.river.hw, name: { zh: '', en: '', ja: '' } } : null,
    sea: null,
    roads,
    crossings,
    walls: [],
    wards: [],
    blocks: [],
    buildings,
    enclosures,
    plazas,
    greens,
    parkParts: [],
    fields,
    trees,
    piers: [],
    boats: [],
    wonders: [],
    landmarks: [],
    labels: [],
    stats: { buildings: buildings.length, houses: households, households, population, area: state.size[0] * state.size[1], ms: 0 },
  }
}
