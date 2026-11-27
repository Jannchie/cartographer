import * as dmath from '../../gen/dmath'
import { hash3 } from '../../gen/rng'
import { at, box, type Frame, type P, type Poly } from '../geom'
import type { Building, BuildingKind, Crossing, Field, Road, Settlement } from '../types'
import type { GrowLot, GrowState } from './api'
import { ROAD_WIDTH, USES, settleParams, terrainOf, useOf } from './core'

// 生长状态 → cartographer 的 Settlement，交给 buildSettlementVector 画（纯函数，不碰 DOM）。
// 盖好的住处、铺子、公家、村心 → buildings（对不上的用途用 shed / hall / large 加 role 文字代画：料场、工棚、作坊……），
// 田 → fields，路 → roads（路过水的地方架一座桥）。在建的不进 buildings，由调用方另外叠；空着的地不画。
// 没有：片区、街区底色、院墙、注记（wards / blocks / labels 都是空的）。

export interface DrawOpts {
  /** 田的种类（和风、东方用 paddy 水田；默认 crop） */
  fieldKind?: Field['kind']
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
  const homeOf = (group: GrowLot[]) => {
    households++
    const [main, ...rest] = [...group].sort((a, b) => a.id - b.id)
    const f = frame(main)
    const n = group.length
    // 一块地：平房；两三块：大一点的两层；四块以上：大宅，院子围起来
    const [w, d, kind, floors] = n >= 4 ? [15, 12, 'large', 2] : n >= 2 ? [12, 9, 'house', 2] : [9, 7, 'house', 1]
    house(main, kind as BuildingKind, f.box((f.fw - w) / 2, (f.fw + w) / 2, 2, 2 + d), { floors: floors as number, units: 1 })
    if (n >= 4) enclosures.push(inset(main, 0.8))
    for (const g of rest) greens.push({ poly: inset(g, 1), kind: 'garden' })
    trees.push({ p: f.at(f.fw * (0.2 + 0.6 * tone(main, 1)), f.fd - 3), r: 2.2 + tone(main, 2) })
  }
  for (const g of homes.values()) homeOf(g)
  for (const l of solo) homeOf([l])

  for (const l of state.lots) {
    if (l.state !== 'built') continue
    const f = frame(l)
    if (l.use === 'field') fields.push({ poly: inset(l, 0.5), angle: f.angle, kind: o.fieldKind ?? 'crop', tone: tone(l) })
    else if (l.use === 'shop') house(l, 'large', f.box(f.fw / 2 - 6, f.fw / 2 + 6, 2, 12), { floors: 1 })
    else if (l.use === 'public') house(l, 'hall', f.box(f.fw / 2 - 7, f.fw / 2 + 7, 2.5, 12.5))
    else if (l.use === 'yard') {
      // 料场、工棚：一块围起来的堆场，靠里两间棚子
      enclosures.push(inset(l, 0.8))
      house(l, 'shed', f.box(2, 8, f.fd - 8, f.fd - 2))
      house(l, 'shed', f.box(f.fw - 9, f.fw - 2, f.fd - 7, f.fd - 2))
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
    name: '',
    nameZh: '',
    nameJa: '',
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
