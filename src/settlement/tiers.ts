import { clamp } from '../gen/util'
import { cultures } from './culture'
import { emitArea, hashAt, isFree, memo, type Ctx } from './ctx'
import type { FeatureEnv, FeatureId } from './features'
import { add, area, bboxOf, centroid, circlePoly, convexOverlap, dist, insetConvex, obb, pointInPoly, rect, type P, type Poly } from './geom'
import { isVillage } from './scale'
import type { Building, BuildingKind, Culture, Tier, Wall, Ward } from './types'
import { inside, place, plantTree } from './wards'
import { attempt, checkpoint, clearYards, demolish, dwelling, removable, rollback, type Checkpoint } from './undo'
import { park } from './parks'
import { addWall, connectDoor } from './walls'
import * as dmath from '../gen/dmath'

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
 *
 * 这里是撒的规矩（多少户一座、落在哪、拆哪户）与各文明共用的两种（街心花园、设防庄园的围墙）；
 * 各文明自己的 small（村社、堂区教堂、祠堂、街区清真寺）与 micro（路边的祠、神龛）怎么盖，
 * 写在文明定义的 tiers 里（CultureTiers）。
 */

/** 文明自己的 small：占片区一角的宗教小地标 */
export interface SmallLandmark {
  /** 种类名（间距检查、统计用） */
  kind: string
  /** 占多大：沿街面宽 × 进深（米） */
  size: [number, number]
  /** 抽到它的份额：乡下（其余是设防庄园）、城里（其余是街心花园；村落里总是它） */
  rural: number
  town: number
  /** 在地块上盖：front 是正面（朝街）的方向，key 是取名用的位置键；盖不成返回 false（调用方整个撤回） */
  build(ctx: Ctx, poly: Poly, front: P, key: string): boolean
}

/** 设防庄园（small 的城堡）的样式：一圈小围墙，门朝路 */
export interface ManorForm {
  /** 围墙里的建筑：h 是院子的半边长，box(a0, a1, s0, s1) 给出"进深 a、横向 s"范围的矩形（a 向里为正） */
  parts(h: number, box: (a0: number, a1: number, s0: number, s1: number) => Poly): [Poly, BuildingKind][]
  /** 角上的塔：四角都有、只在一条对角线上、没有 */
  towers: 'all' | 'diagonal' | 'none'
  /** 围墙：厚度（米）与做法（石墙、木栅土垒） */
  thick: number
  wall: Wall['kind']
  /** 主楼（parts 里的 keep）的叫法 */
  keepRole?: string
  /** 围墙背后种一排树 */
  treeRow?: boolean
}

/** micro 的落脚处：一户宅地（城里）或大路边的一小块地（城外） */
export interface MicroSite {
  /** 中心、朝路的方向 */
  c: P
  d: P
  /** 局部坐标：a 朝路为正，s 向左为正 */
  at(a: number, s: number): P
  /** 宅地的短边（米） */
  room: number
  /** 在城外的大路边（而不是拆了一户人家腾出的宅地） */
  outside: boolean
  /** 这一处在乡下（城外、村里） */
  rural(): boolean
  /** 放一栋小建筑（不压路、水、别的建筑才放得下） */
  put(poly: Poly, kind: BuildingKind, role?: string): boolean
}

/** 文明定义里规模档的部分 */
export interface CultureTiers {
  /** 多少户一座：micro（路边的祠、神龛）、small（村社、堂区教堂、祠堂、街区清真寺） */
  rate: { micro: number; small: number }
  /** micro 按多大的格点撒（米，缺省 40）；同类的 small、同类的祠之间至少隔多远（米，缺省 220、36） */
  microCell?: number
  smallGap?: number
  shrineGap?: number
  small: SmallLandmark
  manor: ManorForm
  /** 占一户宅地的祠、神龛、路边的十字架（micro）；放不下返回 false */
  wayside(ctx: Ctx, site: MicroSite): boolean
  /** 口袋花园当中是喷泉还是井 */
  pocketGarden: 'fountain' | 'well'
  /** 塔楼民居：乡下多少户一座、边长（米）与叫法；不给就没有 */
  towerHouse?: { rate: number; size: number; role: string }
}

/** 塔楼庄园的布置：一座方塔（keep）、一座厅 */
export const keepManor: ManorForm['parts'] = (h, box) => [
  [box(h * 0.2, h * 0.2 + 8.5, -h * 0.7, -h * 0.7 + 8.5), 'keep'],
  [box(h * 0.3, h * 0.85, -h * 0.05, h * 0.75), 'hall'],
]

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

/** 口袋花园（城镇）：多少户一处 */
const GARDEN_RATE = 320
/** 文明没有另给时：micro 的格距，同类 small、同类祠的最小间距（米） */
const MICRO_CELL = 40
const SMALL_GAP = 220
const SHRINE_GAP = 36

/**
 * 撒 small / micro 要拆掉的住户约占几成（祠、礼拜龛占一户，村社、堂区教堂占片区一角约六七户）：
 * 占用率按这个多留一点余量（见 generate.ts 的 occupancy），拆掉的住户退回预算后外围还有地方盖，人口仍对得上
 */
export function tierReserve(c: Culture) {
  const rate = cultures.get(c).tiers.rate
  return 1 + 1.4 / rate.micro + 8 / rate.small + 1 / GARDEN_RATE
}

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
  const tiers = cultures.get(ctx.p.culture).tiers
  const rate = tiers.rate
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
    const gap = kind === 'garden' ? 160 : (tiers.smallGap ?? SMALL_GAP)
    if (kind && !tierLog(ctx).some((r) => r.tier === 'small' && r.kind === kind && dist(r.p, c) < gap)) smallAt(ctx, ward, block, s, kind)
  }
  // —— micro：片区里按以地图中心对齐的格点撒（格距随文明：和风 28 米一格，别处 40 米），每格按格点的哈希定有没有、是什么，
  // 落在离格点最近的一户上。城长大时同一格总在同一处附近（房子挪了几米，祠也只挪几米） ——
  const town = !rural && !isVillage(ctx.p.size)
  const alive = new Set(ctx.out.buildings.slice(b0))
  const g = tiers.microCell ?? MICRO_CELL
  const pts = cells(ctx, block, g)
  if (!pts.length) return
  const per = hh / pts.length
  const pm = per / rate.micro
  const pg = town ? per / GARDEN_RATE : 0
  const pt = rural && tiers.towerHouse ? per / tiers.towerHouse.rate : 0
  const used = new Set<Building>()
  for (const q of pts) {
    const h = hashAt(ctx, q, 'tiers.micro')
    const kind: MicroKind | null = h < pm ? 'shrine' : h < pm + pg ? 'garden' : h < pm + pg + pt ? 'tower' : null
    if (!kind) continue
    let best: (typeof cands)[number] | null = null
    for (const x of cands) if (alive.has(x.b) && !used.has(x.b) && dist(x.c, q) < g * 0.7 && (!best || dist(x.c, q) < dist(best.c, q))) best = x
    if (!best) continue
    const gap = kind === 'shrine' ? (tiers.shrineGap ?? SHRINE_GAP) : kind === 'garden' ? 100 : 140
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

/** small 的种类：文明自己的那一种（SmallLandmark.kind），或共用的街心花园、设防庄园 */
type SmallKind = string
type MicroKind = 'shrine' | 'garden' | 'tower'

function smallKind(ctx: Ctx, c: P, rural: boolean): SmallKind | null {
  const h = hashAt(ctx, snap(ctx, c), 'tiers.smallKind')
  const town = !isVillage(ctx.p.size)
  const own = cultures.get(ctx.p.culture).tiers.small
  return rural ? (h < own.rural ? own.kind : 'manor') : h < own.town || !town ? own.kind : 'garden'
}

// —————————————————————— small ——————————————————————

/** 共用的两种 small 占多大（沿街面宽 × 进深）；文明自己的那一种见 SmallLandmark.size */
const SMALL_SIZE: Record<'garden' | 'manor', [number, number]> = {
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
  const own = cultures.get(ctx.p.culture).tiers.small
  const [w, d] = kind === 'garden' || kind === 'manor' ? SMALL_SIZE[kind] : own.size
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
      case 'garden': {
        const g0 = ctx.out.greens.length
        park(ctx, ward, poly)
        ok = ctx.out.greens.length > g0
        break
      }
      case 'manor':
        ok = manor(ctx, poly, front, key)
        break
      default:
        ok = own.build(ctx, poly, front, key)
    }
  } finally {
    ctx.tier = tier0
  }
  if (ok) tierLog(ctx).push({ kind, tier: 'small', p: c })
  else rollback(ctx, cp)
}

/**
 * 设防庄园（small 的城堡）：一圈小围墙（四角的塔或碉楼），当中一座塔楼、一座厅，门朝路。
 * 样式随文明（ManorForm）：西式是塔楼庄园（tower house 与它的 barmkin），东方是土堡，和风是馆（土垒与板屋），
 * 伊斯兰是四角碉楼的堡（qasr / tighremt）。
 */
function manor(ctx: Ctx, poly: Poly, front: P, key: string): boolean {
  const form = cultures.get(ctx.p.culture).tiers.manor
  const c = centroid(poly)
  const f: P = [-front[0], -front[1]]
  const l: P = [-f[1], f[0]]
  const S = Math.min(obb(poly).len, obb(poly).wid) - 4
  const at = (a: number, s: number): P => [c[0] + f[0] * a + l[0] * s, c[1] + f[1] * a + l[1] * s]
  const box = (a0: number, a1: number, s0: number, s1: number): Poly => [at(a0, s0), at(a1, s0), at(a1, s1), at(a0, s1)]
  const h = S / 2
  const parts = form.parts(h, box)
  if (!parts.every(([p]) => isFree(ctx, p, { pad: 0.5 }))) return false
  // 围墙：一圈，正面当中留门
  const corners = [at(-h, -h), at(h, -h), at(h, h), at(-h, h)]
  const g0 = at(-h, -2.2)
  const g1 = at(-h, 2.2)
  const loop: P[] = [g1, corners[3], corners[2], corners[1], corners[0], g0]
  const solid = loop.map((_, i) => i !== loop.length - 1)
  const towers = form.towers === 'none' ? [] : form.towers === 'diagonal' ? [corners[1], corners[3]] : corners
  const thick = form.thick
  const wall: Wall = { loop, solid, towers, gates: [], kind: form.wall, thickness: thick }
  for (let i = 0; i < loop.length; i++) if (solid[i] && ctx.corridors.hitsPoly([loop[i], loop[(i + 1) % loop.length]], thick / 2 + 0.3, ['road', 'river', 'wall'])) return false
  for (const [p, k] of parts) place(ctx, p, k, { pad: 0.5 }, dwelling({ kind: k } as Building) ? { floors: 1, units: 0 } : { role: k === 'keep' ? form.keepRole : undefined })
  addWall(ctx, wall, 'compound')
  // 门口接上路
  connectDoor(ctx, wall, at(-h, 0))
  ctx.occ.add(box(-h, h, -h, h))
  emitArea(ctx, 'plazas', box(-h + 1.5, h - 1.5, -h + 1.5, h - 1.5))
  if (form.treeRow) for (let k = 0; k < 8; k++) plantTree(ctx, at(h + 3, (k / 7 - 0.5) * S), 2.4)
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
  const tiers = cultures.get(ctx.p.culture).tiers
  const l: P = [-d[1], d[0]]
  const at = (a: number, s: number): P => [c[0] + d[0] * a + l[0] * s, c[1] + d[1] * a + l[1] * s]
  const ob = obb(b.poly)
  const room = Math.min(ob.len, ob.wid)
  const put = (poly: Poly, kind: BuildingKind, role?: string) => place(ctx, poly, kind, { pad: 0.2 }, role ? { role } : undefined)
  switch (kind) {
    case 'shrine':
      // 祠、土地庙、施水亭、礼拜龛与路边的十字架：各文明自己盖
      return tiers.wayside(ctx, { c, d, at, room, outside, rural: () => ruralRole(ctx, c), put })
    case 'garden': {
      // 口袋花园：房子原来的地方铺成一小块绿地，几棵树，当中一口井或一座雕像
      const g = circlePoly(c, clamp(room * 0.75, 4, 8), 12)
      if (!isFree(ctx, g, { pad: 0.2, tags: ['road', 'river', 'wall'] })) return false
      emitArea(ctx, 'greens', g, 'park')
      ctx.out.landmarks.push({ p: c, kind: tiers.pocketGarden })
      ctx.occ.add(circlePoly(c, 2, 8))
      for (let k = 0; k < 3; k++) {
        const a = hashAt(ctx, c, 'tiers.garden.tree', k) * Math.PI * 2
        plantTree(ctx, add(c, [dmath.cos(a), dmath.sin(a)], clamp(room * 0.5, 3, 6)), 2.2)
      }
      return true
    }
    case 'tower': {
      // 塔楼民居：一座方塔住人（边境的 tower house、碉楼、burj），旁边一道小院墙
      const tower = tiers.towerHouse
      return !!tower && put(rect(c, ob.axis, tower.size, tower.size), 'tower', tower.role)
    }
  }
}

/** 这户在乡下（城外、村里）：看它所在的片区 */
function ruralRole(ctx: Ctx, c: P): boolean {
  if (isVillage(ctx.p.size)) return true
  const w = ctx.out.wards.find((w) => pointInPoly(c, w.poly))
  return !w || !w.inner || w.type === 'farm' || w.type === 'suburb'
}
