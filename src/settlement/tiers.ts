import { clamp } from '../gen/util'
import { emitArea, hashAt, isFree, memo, type Ctx } from './ctx'
import type { FeatureEnv, FeatureId } from './features'
import { add, area, bboxOf, centroid, circlePoly, convexOverlap, dist, insetConvex, obb, pointInPoly, rect, type P, type Poly } from './geom'
import { isVillage } from './scale'
import type { Building, BuildingKind, Culture, Tier, Wall, Ward } from './types'
import { addGroup, inside, place, plantTree } from './wards'
import { attempt, checkpoint, clearYards, demolish, dwelling, removable, rollback, type Checkpoint } from './undo'
import { westChurch } from './compose/church'
import { placeMosque } from './plans/medina'
import { park } from './parks'
import { villageShrine } from './styles/wa'
import { addWall, connectDoor } from './walls'

/**
 * 地标的规模档（见 types.ts 的 Tier）：神社、寺观、教堂、园林、城堡都可大可小。
 * - grand：由相邻几块片区合成（选址见 zoning.ts，盖法由各地标按 ctx.tier 放大：大社的长参道与摄社、
 *   朝圣大教堂的回廊院与教士围地、猎苑与离宫、同心城）。这里只给出"多大可能、合几块、喜欢什么地形"
 * - small：占片区的一角，四周照常是人家——村社、堂区教堂、街心花园、街区清真寺、祠堂、设防庄园
 * - micro：占一户的宅地，拆掉那户的房子——路边的祠（ほこら）与小鸟居、土地庙、路边的礼拜龛 / 十字架、
 *   施水亭、口袋花园、塔楼民居
 * small 与 micro 在每块住人的片区盖好之后撒进去（wardExtras），数量随住户与文明：和风的祠最多，
 * 西式约几百户一座堂区教堂。取舍都按位置哈希（片区中心、房子中心），人口变了已有的不挪；
 * 拆掉的人家退回民居预算（后面的片区多盖几户），人口仍对得上目标。
 */

// —————————————————————— grand：合成的大地标 ——————————————————————

const sm01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * 第一座寺社 / 园林 / 城堡是 grand 的可能：随城的规模（按最终人口，城长大到门槛后一直是 grand），
 * 都城、奇幻城（圣地）、要塞城、依山临水各加一些。都城的城堡是宫殿，不走这里（离宫是 grand 的园林）。
 */
export function grandChance(ctx: Ctx, id: FeatureId, e: FeatureEnv): number {
  const pop = ctx.p.population
  const s = sm01(3000, 16000, pop)
  switch (id) {
    // 合成的大地标是一城之宝，多数城没有
    case 'temple':
      return s * (0.14 + (e.capital ? 0.12 : 0) + (e.fn === 'magic' ? 0.12 : 0) + (e.hills ? 0.05 : 0))
    case 'park':
      return s * (0.1 + (e.capital ? 0.2 : 0) + (e.fn === 'magic' ? 0.05 : 0) + (e.river || e.coast ? 0.04 : 0))
    case 'castle':
      return e.capital || !e.walled ? 0 : sm01(1500, 9000, pop) * (0.1 + (e.fn === 'fortress' ? 0.3 : 0) + (e.hills ? 0.08 : 0))
  }
  return 0
}

/** 合几块片区 */
export function grandSize(ctx: Ctx, id: FeatureId): number {
  const pop = ctx.p.population
  if (id === 'park') return pop > 24000 ? 5 : pop > 9000 ? 4 : 3
  return pop > 20000 ? 4 : 3
}

// —————————————————————— small 与 micro ——————————————————————

/** 各文明多少户一座：micro（路边的祠、神龛）、small（村社、堂区教堂、祠堂、街区清真寺） */
const RATE: Record<Culture, { micro: number; small: number }> = {
  wa: { micro: 26, small: 200 },
  eastern: { micro: 55, small: 280 },
  western: { micro: 95, small: 300 },
  islamic: { micro: 85, small: 170 },
}
/** 口袋花园（城镇）、塔楼民居（乡下）：多少户一处 */
const GARDEN_RATE = 320
const TOWER_RATE: Record<Culture, number> = { western: 90, eastern: 110, islamic: 100, wa: Infinity }

/**
 * 撒 small / micro 要拆掉的住户约占几成（祠、礼拜龛占一户，村社、堂区教堂占片区一角约六七户）：
 * 占用率按这个多留一点余量（见 generate.ts 的 occupancy），拆掉的住户退回预算后外围还有地方盖，人口仍对得上
 */
export const tierReserve = (c: Culture) => 1 + 1.4 / RATE[c].micro + 8 / RATE[c].small + 1 / GARDEN_RATE

/** 这次生成里撒下的 small / micro（间距检查、统计用） */
export interface TierRecord {
  kind: string
  tier: Tier
  p: P
}
export const tierLog = (ctx: Ctx) => memo(ctx, 'tiers', () => {
  const list: TierRecord[] = []
  if (tierTrace.on) tierTrace.list = list
  return list
})
/** 调试：打开后记下最近一次生成撒下的 small / micro 与名所（统计分布用） */
export const tierTrace = { on: false, list: [] as TierRecord[] }

/** 乡下的片区（城外的村子、村落里的农家）：设防庄园、塔楼民居、路边十字架在这里 */
const ruralWard = (ctx: Ctx, ward: Ward) => !ward.inner || ward.type === 'farm' || ward.type === 'suburb' || isVillage(ctx.p.size)

/**
 * 一块住人的片区盖好之后：按住户数撒 small（占片区一角）与 micro（占一户宅地）。
 * s 是片区开盖前的检查点：只动本片区自己盖的东西。
 */
export function wardExtras(ctx: Ctx, ward: Ward, block: Poly, s: Checkpoint) {
  const b0 = s.len.get('buildings')!
  const mine = ctx.out.buildings.slice(b0).filter(dwelling)
  if (!mine.length) return
  const cult = ctx.p.culture
  const rate = RATE[cult]
  // 村里的人家不算城里的人口（units 为 0），按一栋一户算
  const hh = mine.reduce((n, b) => n + Math.max(1, b.units ?? 1), 0)
  const rural = ruralWard(ctx, ward)
  const c = centroid(ward.poly)
  // micro 的候选先记下（small 盖上去的厢房、拆掉的人家都不算）
  const cands = mine.map((b) => ({ b, c: centroid(b.poly) }))
  // —— small：片区中心的哈希定"这块有没有" ——
  const pSmall = Math.min(0.85, hh / rate.small)
  if (hashAt(ctx, snap(ctx, c), 'tiers.small') < pSmall) {
    const kind = smallKind(ctx, c, rural)
    const gap = kind === 'garden' ? 160 : cult === 'wa' ? 150 : 220
    if (kind && !tierLog(ctx).some((r) => r.tier === 'small' && r.kind === kind && dist(r.p, c) < gap)) smallAt(ctx, ward, block, s, kind)
  }
  // —— micro：片区里按以地图中心对齐的格点撒（和风 28 米一格，别处 40 米），每格按格点的哈希定有没有、是什么，
  // 落在离格点最近的一户上。城长大时同一格总在同一处附近（房子挪了几米，祠也只挪几米） ——
  const town = !rural && !isVillage(ctx.p.size)
  const alive = new Set(ctx.out.buildings.slice(b0))
  const g = cult === 'wa' ? 28 : 40
  const pts = cells(ctx, block, g)
  if (!pts.length) return
  const per = hh / pts.length
  const pm = per / rate.micro
  const pg = town ? per / GARDEN_RATE : 0
  const pt = rural ? per / TOWER_RATE[cult] : 0
  const used = new Set<Building>()
  for (const q of pts) {
    const h = hashAt(ctx, q, 'tiers.micro')
    const kind: MicroKind | null = h < pm ? 'shrine' : h < pm + pg ? 'garden' : h < pm + pg + pt ? 'tower' : null
    if (!kind) continue
    let best: (typeof cands)[number] | null = null
    for (const x of cands) if (alive.has(x.b) && !used.has(x.b) && dist(x.c, q) < g * 0.7 && (!best || dist(x.c, q) < dist(best.c, q))) best = x
    if (!best) continue
    const gap = kind === 'shrine' ? (cult === 'wa' ? 24 : 36) : kind === 'garden' ? 100 : 140
    if (tierLog(ctx).some((r) => r.tier === 'micro' && r.kind === kind && dist(r.p, best!.c) < gap)) continue
    used.add(best.b)
    microAt(ctx, best.b, kind, b0)
  }
}

/** 片区里以地图中心对齐、g 米一格的格点（格点按位置哈希抖动一点） */
function cells(ctx: Ctx, block: Poly, g: number): P[] {
  const [x0, y0, x1, y1] = bboxOf(block)
  const ox = ctx.MW / 2
  const oy = ctx.MH / 2
  const out: P[] = []
  for (let x = ox + Math.floor((x0 - ox) / g) * g; x <= x1; x += g)
    for (let y = oy + Math.floor((y0 - oy) / g) * g; y <= y1; y += g) {
      const q: P = [x + (hashAt(ctx, [x, y], 'tiers.cell.x') - 0.5) * g * 0.5, y + (hashAt(ctx, [x, y], 'tiers.cell.y') - 0.5) * g * 0.5]
      if (pointInPoly(q, block)) out.push(q)
    }
  return out
}

/** 位置取到 40 米的粗格（与 siteDice 一样）：片区边界挪几米，抽签不变 */
function snap(ctx: Ctx, q: P): P {
  const g = 40
  const ox = ctx.MW / 2
  const oy = ctx.MH / 2
  return [ox + Math.round((q[0] - ox) / g) * g, oy + Math.round((q[1] - oy) / g) * g]
}

type SmallKind = 'shrine' | 'church' | 'ci' | 'masjid' | 'garden' | 'manor'
type MicroKind = 'shrine' | 'garden' | 'tower'

function smallKind(ctx: Ctx, c: P, rural: boolean): SmallKind | null {
  const h = hashAt(ctx, snap(ctx, c), 'tiers.smallKind')
  const town = !isVillage(ctx.p.size)
  switch (ctx.p.culture) {
    case 'wa':
      return rural ? (h < 0.88 ? 'shrine' : 'manor') : h < 0.78 || !town ? 'shrine' : 'garden'
    case 'western':
      return rural ? (h < 0.72 ? 'church' : 'manor') : h < 0.62 || !town ? 'church' : 'garden'
    case 'eastern':
      return rural ? (h < 0.75 ? 'ci' : 'manor') : h < 0.7 || !town ? 'ci' : 'garden'
    case 'islamic':
      return rural ? (h < 0.8 ? 'masjid' : 'manor') : h < 0.72 || !town ? 'masjid' : 'garden'
  }
}

// —————————————————————— small ——————————————————————

/** 各种 small 占多大（沿街面宽 × 进深） */
const SMALL_SIZE: Record<SmallKind, [number, number]> = {
  shrine: [26, 36],
  church: [24, 38],
  ci: [20, 27],
  masjid: [24, 27],
  garden: [26, 28],
  manor: [26, 26],
}

/**
 * 在片区里找一块沿街的地（面宽 w × 进深 d）：只压着本片区刚盖的普通房子（拆掉），不压路、水、别的建筑。
 * 返回地块与正面（朝街）的方向。
 */
function smallSite(ctx: Ctx, block: Poly, s: Checkpoint, w: number, d: number): { poly: Poly; front: P } | null {
  const zone = insetConvex(block, 0.5)
  if (zone.length < 3 || area(zone) < w * d * 1.2) return null
  const b0 = s.len.get('buildings')!
  const byPoly = new Map(ctx.out.buildings.slice(b0).map((b) => [b.poly, b]))
  const ob = obb(zone)
  const axes: P[] = [ob.axis, [-ob.axis[1], ob.axis[0]]]
  // 候选：片区里 5 米一格的格点 × 两个朝向 × 两档大小；离路近的先试（正对街），再按位置哈希
  const cands: { q: P; u: P; k: number; key: number }[] = []
  const [x0, y0, x1, y1] = bboxOf(zone)
  const step = 5
  const ox = ctx.MW / 2
  const oy = ctx.MH / 2
  for (let x = ox + Math.ceil((x0 - ox) / step) * step; x <= x1; x += step)
    for (let y = oy + Math.ceil((y0 - oy) / step) * step; y <= y1; y += step) {
      const q: P = [x, y]
      if (!pointInPoly(q, zone)) continue
      const g = ctx.corridors.gap(q)
      for (const k of [1, 0.82]) for (const u of axes) cands.push({ q, u, k, key: Math.abs(g - (d * k) / 2 - 2) * 0.05 + hashAt(ctx, q, 'tiers.smallSite') * 0.5 + (1 - k) * 3 })
    }
  cands.sort((a, b) => a.key - b.key)
  for (const cd of cands.slice(0, 400)) {
    const poly = rect(cd.q, cd.u, w * cd.k, d * cd.k)
    if (!inside(poly, zone) || poly.some((v) => ctx.T.waterAt(v) < 3) || ctx.T.slopeAt(cd.q) > 0.5) continue
    if (ctx.corridors.hitsPoly(poly, 0.3)) continue
    const hit = ctx.occ.query(bboxOf(poly)).filter((q) => convexOverlap(q, poly))
    // 只拆本片区刚盖的普通房子
    if (!hit.every((q) => byPoly.has(q) && removable(byPoly.get(q)!))) continue
    // 正面：进深方向的两头里离路近的那头（朝街）
    const n: P = [-cd.u[1], cd.u[0]]
    const fr: P[] = [n, [-n[0], -n[1]]]
    const front = fr.reduce((a, b) => (ctx.corridors.gap(add(cd.q, b, (d * cd.k) / 2 + 3)) < ctx.corridors.gap(add(cd.q, a, (d * cd.k) / 2 + 3)) ? b : a))
    // 拆掉地块里本片区刚盖的房子（住户退回民居预算）、院墙、园地与树
    const gone = new Set(hit)
    demolish(ctx, (b) => gone.has(b.poly), b0)
    clearYards(ctx, poly, { from: s })
    return { poly, front }
  }
  return null
}

function smallAt(ctx: Ctx, ward: Ward, block: Poly, s: Checkpoint, kind: SmallKind) {
  const [w, d] = SMALL_SIZE[kind]
  // 盖不成就连拆掉的人家一起撤回
  const cp = checkpoint(ctx)
  const site = smallSite(ctx, block, s, w, d)
  if (!site) return
  const { poly, front } = site
  const c = centroid(poly)
  const key = `${Math.round(c[0])},${Math.round(c[1])}`
  const tier0 = ctx.tier
  ctx.tier = 'small'
  let ok = false
  try {
    switch (kind) {
      case 'shrine':
        ok = !!villageShrine(ctx, poly, front, key)
        break
      case 'church':
        ok = westChurch(ctx, poly, insetConvex(poly, 2.5), { fill: false, key })
        break
      case 'ci':
        ok = ancestralHall(ctx, poly, front, key)
        break
      case 'masjid': {
        const m = placeMosque(ctx, insetConvex(poly, 1), poly, 26, 22, false)
        if (m) ctx.out.landmarks.push({ p: centroid(m), name: ctx.namer.sacred('masjid', key), kind: 'temple' })
        ok = !!m
        break
      }
      case 'garden': {
        const g0 = ctx.out.greens.length
        park(ctx, ward, poly)
        ok = ctx.out.greens.length > g0
        break
      }
      case 'manor':
        ok = manor(ctx, poly, front, key)
        break
    }
  } finally {
    ctx.tier = tier0
  }
  if (ok) tierLog(ctx).push({ kind, tier: 'small', p: c })
  else rollback(ctx, cp)
}

/** 祠堂 / 小庙（东方的 small）：一圈院墙，门屋、正堂、两厢，院里一棵树 */
function ancestralHall(ctx: Ctx, poly: Poly, front: P, key: string): boolean {
  const c = centroid(poly)
  const f: P = [-front[0], -front[1]]
  const l: P = [-f[1], f[0]]
  const b = obb(poly)
  const W = Math.min(b.len, b.wid) - 3
  const D = Math.max(b.len, b.wid) - 3
  const at = (a: number, s: number): P => [c[0] + f[0] * a + l[0] * s, c[1] + f[1] * a + l[1] * s]
  const box = (a0: number, a1: number, s0: number, s1: number): Poly => [at(a0, s0), at(a1, s0), at(a1, s1), at(a0, s1)]
  const wall = box(-D / 2, D / 2, -W / 2, W / 2)
  const parts: [Poly, BuildingKind][] = [
    [box(-D / 2 + 0.5, -D / 2 + 5, -W * 0.22, W * 0.22), 'hall'],
    [box(D / 2 - 9.5, D / 2 - 0.8, -W * 0.36, W * 0.36), 'temple'],
    [box(-D / 2 + 8, D / 2 - 12, -W / 2 + 0.6, -W / 2 + 4.6), 'hall'],
    [box(-D / 2 + 8, D / 2 - 12, W / 2 - 4.6, W / 2 - 0.6), 'hall'],
  ]
  if (!parts.every(([p]) => inside(p, wall) && isFree(ctx, p, { pad: 0.3 }))) return false
  addGroup(ctx, parts, 0.3)
  const main = ctx.out.buildings[ctx.out.buildings.length - 3]
  main.role = '祠堂'
  emitArea(ctx, 'enclosures', wall)
  emitArea(ctx, 'plazas', box(-D / 2 + 5.5, D / 2 - 10, -W / 2 + 5, W / 2 - 5))
  plantTree(ctx, at(0, 0), 3.2)
  ctx.out.landmarks.push({ p: at(D / 2 - 5, 0), name: ctx.namer.sacred(isVillage(ctx.p.size) || ctx.p.size === 'town' ? 'tudi' : 'villageShrine', key), kind: 'shrine' })
  return true
}

/**
 * 设防庄园（small 的城堡）：一圈小围墙（四角的塔或碉楼），当中一座塔楼、一座厅，门朝路。
 * 西式是塔楼庄园（tower house 与它的 barmkin），东方是土堡，和风是馆（土垒与板屋），伊斯兰是四角碉楼的堡（qasr / tighremt）。
 */
function manor(ctx: Ctx, poly: Poly, front: P, key: string): boolean {
  const cult = ctx.p.culture
  const c = centroid(poly)
  const f: P = [-front[0], -front[1]]
  const l: P = [-f[1], f[0]]
  const S = Math.min(obb(poly).len, obb(poly).wid) - 4
  const at = (a: number, s: number): P => [c[0] + f[0] * a + l[0] * s, c[1] + f[1] * a + l[1] * s]
  const box = (a0: number, a1: number, s0: number, s1: number): Poly => [at(a0, s0), at(a1, s0), at(a1, s1), at(a0, s1)]
  const h = S / 2
  const parts: [Poly, BuildingKind][] =
    cult === 'wa'
      ? [
          [box(h * 0.05, h * 0.8, -h * 0.55, h * 0.35), 'hall'],
          [box(-h * 0.5, -h * 0.05, h * 0.2, h * 0.75), 'shed'],
        ]
      : cult === 'eastern'
        ? [
            [box(h * 0.25, h * 0.85, -h * 0.6, h * 0.6), 'hall'],
            [box(-h * 0.6, h * 0.1, -h * 0.85, -h * 0.5), 'house'],
            [box(-h * 0.6, h * 0.1, h * 0.5, h * 0.85), 'house'],
          ]
        : [
            [box(h * 0.2, h * 0.2 + 8.5, -h * 0.7, -h * 0.7 + 8.5), 'keep'],
            [box(h * 0.3, h * 0.85, -h * 0.05, h * 0.75), 'hall'],
          ]
  if (!parts.every(([p]) => isFree(ctx, p, { pad: 0.5 }))) return false
  // 围墙：一圈，正面当中留门
  const corners = [at(-h, -h), at(h, -h), at(h, h), at(-h, h)]
  const g0 = at(-h, -2.2)
  const g1 = at(-h, 2.2)
  const loop: P[] = [g1, corners[3], corners[2], corners[1], corners[0], g0]
  const solid = loop.map((_, i) => i !== loop.length - 1)
  const towers = cult === 'wa' ? [] : cult === 'eastern' ? [corners[1], corners[3]] : corners
  const thick = cult === 'western' || cult === 'islamic' ? 1.8 : 2.2
  const wall: Wall = { loop, solid, towers, gates: [], kind: cult === 'wa' ? 'palisade' : 'stone', thickness: thick }
  for (let i = 0; i < loop.length; i++) if (solid[i] && ctx.corridors.hitsPoly([loop[i], loop[(i + 1) % loop.length]], thick / 2 + 0.3, ['road', 'river', 'wall'])) return false
  for (const [p, k] of parts) place(ctx, p, k, { pad: 0.5 }, dwelling({ kind: k } as Building) ? { floors: 1, units: 0 } : { role: k === 'keep' ? (cult === 'islamic' ? '碉楼' : '塔楼') : undefined })
  addWall(ctx, wall, 'compound')
  // 门口接上路
  connectDoor(ctx, wall, at(-h, 0))
  ctx.occ.add(box(-h, h, -h, h))
  emitArea(ctx, 'plazas', box(-h + 1.5, h - 1.5, -h + 1.5, h - 1.5))
  if (cult === 'wa') for (let k = 0; k < 8; k++) plantTree(ctx, at(h + 3, (k / 7 - 0.5) * S), 2.4)
  ctx.out.landmarks.push({ p: c, name: ctx.namer.sacred('manor', key), kind: 'shrine' })
  return true
}

// —————————————————————— micro ——————————————————————

/** 房子正面（朝最近的路）：房子的四个方向里离路最近的那个 */
function faceOf(ctx: Ctx, poly: Poly): P {
  const b = obb(poly)
  const c = b.center
  const dirs: P[] = [b.axis, [-b.axis[0], -b.axis[1]], [-b.axis[1], b.axis[0]], [b.axis[1], -b.axis[0]]]
  let best = dirs[0]
  let bg = Infinity
  for (const d of dirs) {
    const g = ctx.corridors.gap(add(c, d, 6))
    if (g < bg) {
      bg = g
      best = d
    }
  }
  return best
}

/** 拆掉一户（退回民居预算）、在原地盖 micro：盖不成就整个撤回，那户放回原处 */
function microAt(ctx: Ctx, b: Building, kind: MicroKind, from: number) {
  const c = centroid(b.poly)
  const d = faceOf(ctx, b.poly)
  const cp = checkpoint(ctx)
  if (!demolish(ctx, (x) => x === b, from).length) return
  if (microBuild(ctx, b, c, d, kind)) tierLog(ctx).push({ kind, tier: 'micro', p: c })
  else rollback(ctx, cp)
}

/**
 * 城外大路边的一处 micro（路口的十字架、村口的道祖神与祠、路边的土地庙、山坡上圣徒的库巴）：c 是位置，d 朝路。
 * 放不下返回 false（什么都不留）。
 */
export function waysideAt(ctx: Ctx, c: P, d: P): boolean {
  const ok = attempt(ctx, () => microBuild(ctx, { poly: rect(c, d, 6, 6), kind: 'house', tone: 0, ridge: 0 }, c, d, 'shrine', true))
  if (ok) tierLog(ctx).push({ kind: 'wayside', tier: 'micro', p: c })
  return ok
}

function microBuild(ctx: Ctx, b: Building, c: P, d: P, kind: MicroKind, outside = false): boolean {
  const cult = ctx.p.culture
  const l: P = [-d[1], d[0]]
  const at = (a: number, s: number): P => [c[0] + d[0] * a + l[0] * s, c[1] + d[1] * a + l[1] * s]
  const ob = obb(b.poly)
  const room = Math.min(ob.len, ob.wid)
  const put = (poly: Poly, kind: BuildingKind, role?: string) => place(ctx, poly, kind, { pad: 0.2 }, role ? { role } : undefined)
  switch (kind) {
    case 'shrine': {
      if (cult === 'wa') {
        // 祠（ほこら）：小小的一间，前面一座小鸟居，背后一棵神木
        if (!put(rect(at(-1, 0), d, 2.2, 1.9), 'temple', '祠')) return false
        put(rect(at(1.9, 0), d, 0.45, 2.6), 'torii')
        plantTree(ctx, at(-4, 0.5), 2.6)
        return true
      }
      if (cult === 'eastern') {
        // 土地庙：一间小庙、门前一方小坪
        if (!put(rect(at(-0.8, 0), d, 3, 3.2), 'temple', '土地庙')) return false
        const fore = rect(at(1.8, 0), d, 2, 3.2)
        if (isFree(ctx, fore, { pad: 0.1 })) emitArea(ctx, 'plazas', fore)
        plantTree(ctx, at(-3.5, 2.5), 3)
        return true
      }
      if (cult === 'islamic') {
        // 城外：圣徒的墓（库巴，koubba），白色的小穹顶，旁边一棵树
        if (outside) {
          if (!put(circlePoly(c, 2.8, 10), 'temple', '圣徒墓（库巴）')) return false
          plantTree(ctx, at(-4, 2), 3)
          return true
        }
        // 施水亭（sabil）：街角的小亭，路人取水
        return put(rect(c, d, clamp(room * 0.7, 3.2, 4.5), clamp(room * 0.7, 3.2, 4.5)), 'civic', '施水亭（萨比勒）')
      }
      // 西式：城里是临街的礼拜龛（小小的路边礼拜堂），乡下是路边的十字架与一棵椴树
      if (outside || ruralRole(ctx, c)) {
        const pad = rect(at(0.5, 0), d, 4, 4)
        if (!isFree(ctx, pad, { pad: 0.1 })) return false
        emitArea(ctx, 'plazas', pad)
        // 石十字：一竖一横（两块可以相交，一起落地）
        if (addGroup(ctx, [[rect(at(0.4, 0), d, 3, 0.7), 'tower'], [rect(at(0.9, 0), d, 0.7, 2), 'tower']], 0.1))
          for (const x of ctx.out.buildings.slice(-2)) x.role = '路边十字架'
        plantTree(ctx, at(-2.5, 1.5), 3.2)
        return true
      }
      return put(rect(at(0.5, 0), d, 3.4, 2.6), 'temple', '路边礼拜龛')
    }
    case 'garden': {
      // 口袋花园：房子原来的地方铺成一小块绿地，几棵树，当中一口井或一座雕像
      const g = circlePoly(c, clamp(room * 0.75, 4, 8), 12)
      if (!isFree(ctx, g, { pad: 0.2, tags: ['road', 'river', 'wall'] })) return false
      emitArea(ctx, 'greens', g, 'park')
      ctx.out.landmarks.push({ p: c, kind: cult === 'western' || cult === 'islamic' ? 'fountain' : 'well' })
      ctx.occ.add(circlePoly(c, 2, 8))
      for (let k = 0; k < 3; k++) {
        const a = hashAt(ctx, c, 'tiers.garden.tree', k) * Math.PI * 2
        plantTree(ctx, add(c, [Math.cos(a), Math.sin(a)], clamp(room * 0.5, 3, 6)), 2.2)
      }
      return true
    }
    case 'tower': {
      // 塔楼民居：一座方塔住人（边境的 tower house、碉楼、burj），旁边一道小院墙
      const s = cult === 'western' ? 7.5 : 6
      return put(rect(c, ob.axis, s, s), 'tower', cult === 'western' ? '塔楼民居' : '碉楼')
    }
  }
}

/** 这户在乡下（城外、村里）：看它所在的片区 */
function ruralRole(ctx: Ctx, c: P): boolean {
  if (isVillage(ctx.p.size)) return true
  const w = ctx.out.wards.find((w) => pointInPoly(c, w.poly))
  return !w || !w.inner || w.type === 'farm' || w.type === 'suburb'
}
