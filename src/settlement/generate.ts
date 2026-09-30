import { RNG, hashString } from '../gen/rng'
import { contours, simplify } from '../render/atlas/svg/contour'
import { dryArea, emitArea, Corridors, Occupancy, SUB_WEIGHT, whereOf, centerDist, clipWater, placeable, hashAt, gridFrame, inCity, mainCore, squareness, seedRng, wardRng, type Core, mark, type Ctx } from './ctx'
import { FEATURE, FEATURES, featureEnv, resolveCounts, type FeatureId } from './features'
import { placeLandmarks, zoneLots, type Lot } from './zoning'
import { PATCH, POP_OF_SIZE, densityScore, densityTier, farmPerHa, wardRate, isVillage, fullPerHa, housesPerHa, planPopOf, scaleOf, townShare } from './scale'
import {
  area,
  centroid,
  chaikin,
  circlePoly,
  dist,
  bboxOf,
  growConvex,
  insetConvex,
  pointAt,
  pointInPoly,
  polylineDist,
  lerpP,
  polylineLength,
  obb,
  rect,
  segDist,
  segIntersect,
  signedArea,
  segPolyDist,
  LineIndex,
  resample,
  type P,
  type Poly,
} from './geom'
import { addWall, bastioned, cleanLoop, fromF32, gateStreets, insetLoop, simplifyLoop, smoothRoute, toF32, wallFromLoop } from './walls'
import { fixWet, nearestRoad, roadCorridor, through, tidyRoads, trimDangling, wetRuns } from './roads'
import { STYLES } from './styles'
import { CULTURE_INFO, eastAsian, planFits } from './culture'
import { ruralExtras } from './rural'
import { tierReserve, wardExtras } from './tiers'
import { checkpoint, demolish, drop, rollback } from './undo'
import { sacredSites } from './sacred'
import { PLANS } from './plans'
import type { PlanLot, PlanZone } from './plans/types'
import { buildPatches, crossings, farm, type FarmGroup, latticeStreets, radialStreets, sharedEdge, spacing, vegetation, wild, type Patch } from './outer'
import { SettleNamer } from './names'
import { buildTerrain, landPieces, levelTerrain, routeOnTerrain, terrainKey } from './terrain'
import { DEFAULT_SETTLEMENT, LAYOUT_DEFAULT, type Building, type Wall, type Crossing, type Density, type Landmark, type Road, type MapLabel, type Tri, type Tree, type Field, same, type Settlement, type SettlementParams, type Ward, type WardType } from './types'
import { addBoat, addPier, eastCompound, fit, plaza, scatterTrees, urban } from './wards'
import { calibrateTrades, perHome, residentsOf } from './people'
import { groupForm, outMark, overlaps, piece, schedule, snapshot, stamp, statsOf, type Form, type HistoryState, type Piece, type SettlementHistory } from './history'
import * as dmath from '../gen/dmath'

/**
 * 规模与画幅：规模档位由人口推出，结构参数按人口连续插值；地图范围按要住下的人口铺开。
 * 不必生成就能算出（成长动画先用它定下各帧共用的画幅）。
 */
function scaled(input: SettlementParams) {
  // 规模档位由人口推出；结构参数按人口连续插值
  const target = input.population ?? POP_OF_SIZE[input.size]
  const sc = scaleOf(target)
  const p: SettlementParams = {
    ...input,
    size: sc.size,
    function: input.function ?? 'balanced',
    counts: input.counts ?? {},
    regularity: input.regularity ?? LAYOUT_DEFAULT.regularity,
    radial: input.radial ?? LAYOUT_DEFAULT.radial,
    spread: input.spread ?? DEFAULT_SETTLEMENT.spread,
    farmland: input.farmland ?? DEFAULT_SETTLEMENT.farmland,
    planStrength: Math.min(1, Math.max(0, input.planStrength ?? DEFAULT_SETTLEMENT.planStrength!)),
    walls: input.walls === 'auto' && !CULTURE_INFO[input.culture].autoWalls && input.function !== 'fortress' ? 'none' : input.walls,
  }
  const cfg = { ...sc.cfg }
  // 干道、大路的路宽按规划的规模（成长动画里是最终的人口）：路一开始就按全城修好，
  // 城市长大时不会一档档拓宽、把沿街的房子和地标切掉重盖
  const planned0 = scaleOf(planPopOf(input)).cfg
  cfg.main = Math.max(cfg.main, planned0.main)
  cfg.highway = Math.max(cfg.highway, planned0.highway)
  // 商贸城：干道更宽、对外道路更多
  if (p.function === 'trade') {
    cfg.main *= 1.6
    cfg.highway *= 1.25
    cfg.roads = [cfg.roads[0] + 1, cfg.roads[1] + 1]
  }
  // 副中心离得远（卫星城）时地图放大，放得下隔着田野的几座城
  const env0 = featureEnv(p)
  const subN = env0.big ? resolveCounts(p, env0).subcenter : 0
  // 城区要多大由目标户数定（人口 ÷ 平均每户口数，见 people.ts 的 perHome）：户数 ÷ 每公顷户数 = 需要的城区面积，折成片区数（片区网格、城区半径、
  // 地图范围都按它铺开）；经验片区数偏少时（大村、规整的东方城）随之放大
  const households = Math.round(target / perHome(p.culture))
  // 城墙按规划容量修：地图要放得下现在这道墙（它能容纳的人口比现在多）
  const planned = wallStages(p).at(-1)?.cap ?? 0
  const needInner = innerFor(p, Math.max(target, planned))
  const room = Math.sqrt(Math.max(1, needInner / cfg.inner))
  cfg.inner = Math.max(cfg.inner, needInner)
  const grow = (subN ? 1 + 0.45 * p.spread * p.spread : 1) * room
  // 取整到 20 米：地形网格（5 米）与寻路网格（10 米）都对齐地图中心（世界原点）
  const extent: [number, number] = [Math.round((sc.extent[0] * grow) / 20) * 20, Math.round((sc.extent[1] * grow) / 20) * 20]
  return { p, cfg, extent, households }
}

/** 这组参数生成的地图范围（米） */
export const settlementExtent = (input: SettlementParams) => scaled(input).extent

/**
 * 一座人口为 input.population 的聚落：就是它成长史的最后一刻（与成长动画的最后一帧是同一座城）。
 * 只要最后一刻，城外早已开垦、并进城区的田野不必盖出来（见 HistoryState.lazy）
 */
export function generateSettlement(input: SettlementParams): Settlement {
  const t0 = performance.now()
  const st = snapshot(generateHistory(input, { lazy: true }), input.population ?? POP_OF_SIZE[input.size])
  st.stats.ms = performance.now() - t0
  return st
}

/**
 * 一座城长到 input.population 人的成长史（见 history.ts）：每样东西带着生卒，任一人口时的地图用 snapshot 取。
 * 成长动画只生成一次，逐帧取快照
 */
export function generateHistory(input: SettlementParams, o: { lazy?: boolean } = {}): SettlementHistory {
  const { st, history: h } = build(input, o.lazy)
  // 最终状态之外、只在历史上出现过的东西并进来（快照按生卒挑）
  const all = { ...st } as Settlement
  const past = new Map<string, object[]>()
  for (const { key, item } of h.past) (past.get(key) ?? past.set(key, []).get(key)!).push(item)
  for (const [key, items] of past) (all as any)[key] = [...((all as any)[key] as object[]), ...items]
  // 从没出现过的（出生前就被拆掉的）不要
  for (const k of Object.keys(all) as (keyof Settlement)[]) {
    const a = all[k]
    if (!Array.isArray(a)) continue
    ;(all as any)[k] = (a as object[]).filter((x) => {
      const l = h.life.get(x)
      return !l || l.born < l.died
    })
  }
  return { st: all, life: h.life, until: st.params.population }
}

function build(input: SettlementParams, lazy = false): { st: Settlement; history: HistoryState } {
  const t0 = performance.now()
  const { p, cfg, households, extent: own } = scaled(input)
  // 画幅至少是 minExtent（成长动画各帧用同一个画幅，城在原地长大）
  const min = input.minExtent
  const extent: [number, number] = min ? [Math.max(own[0], min[0]), Math.max(own[1], min[1])] : own
  // 随机数只由种子与文明定（不含规模档位）：同一个种子换人口，地形与骨架不变
  const rng = new RNG(hashString(`${p.seed}|${p.culture}`))
  // 地形用自己的随机数流（见 terrainKey）；这里照样分出一支，后面的随机数不变
  rng.fork()
  const T = buildTerrain(p, extent)
  const [MW, MH] = extent
  const namer = new SettleNamer(p.seed, p.culture, !!T.coast)
  const ctx: Ctx = {
    p,
    rng: rng.fork(),
    T,
    cfg,
    namer,
    MW,
    MH,
    center: [MW / 2, MH / 2],
    Rin: 0,
    seedHash: hashString(`${p.seed}|${p.culture}`),
    style: STYLES[p.culture],
    memo: new Map(),
    density: new Map(),
    uncounted: false,
    estate: false,
    cores: [],
    cityWalls: [],
    // 民居预算：目标人口折成户数，盖满就不再盖（见 addBuilding）
    houseBudget: households,
    wardFill: 1,
    wardQuota: Infinity,
    wardTown: true,
    wardDensity: 'mid',
    wardType: 'common',
    tier: 'standard',
    history: { life: new Map(), past: [], sources: [], countPop: countPopper(p, p.walls !== 'none'), lazy },
    gridAngle: 0,
    // 要素环境与数量要等知道是否设防后才能定（见下方），这里先占位
    env: featureEnv(p),
    counts: {} as Ctx['counts'],
    corridors: new Corridors(),
    occ: new Occupancy(),
    dropped: [],
    out: {
      roads: [],
      crossings: [],
      walls: [],
      wards: [],
      blocks: [],
      buildings: [],
      enclosures: [],
      plazas: [],
      greens: [],
      parkParts: [],
      fields: [],
      trees: [],
      piers: [],
      boats: [],
      wonders: [],
      landmarks: [],
      labels: [],
    },
  }
  ctx.Rin = Math.sqrt((cfg.inner * 0.87 * cfg.patch * cfg.patch) / Math.PI)
  ctx.center = pickCenter(ctx)
  const arterials = routeArterials(ctx)

  const stages = wallStages(p)
  const walled = stages.length ? stages[stages.length - 1].kind : null
  // 要素数量要知道是否设防（城堡、兵营只在有城墙时自动出现）
  ctx.env = featureEnv(p, !!walled)
  ctx.counts = resolveCounts(p, ctx.env)
  // 副都心：沿干道离城心一段距离处另起中心，相邻的副中心之间修干道相连
  // 按时出现的副中心取自"城市一路长下去会有的"那一串（位置按各自出现时的城区大小定，与现在的人口无关），
  // 还没出现的几个只参与片区剖分；手动要的比按人口该有的多时另排
  const nSub = ctx.env.big ? ctx.counts.subcenter : 0
  // 任何规模都先算好（村子也按它们划片区）：成镇的那一刻不会因为多了这几个站点而整片重划
  const natural = pickSubcenters(ctx, arterials, Math.max(MAX_SUB, nSub), (k) => SUB_BIRTH * (k + 1))
  const onTime = nSub <= Math.floor(p.population / SUB_BIRTH)
  ctx.cores = [mainCore(ctx), ...(onTime ? natural.slice(0, nSub) : pickSubcenters(ctx, arterials, nSub))]
  ctx.layoutCores = onTime ? [...ctx.cores, ...natural.slice(nSub)] : ctx.cores
  arterials.push(...linkSubcenters(ctx, arterials))
  // 城市形制：规划区（里坊、营寨城……）与干道在规划区里改走规划的大街
  ctx.plan = setupPlan(ctx)
  if (ctx.plan) planArterials(ctx, arterials)
  // 布局只有一条流程：有机 / 方格 / 放射由规整度与放射度连续混合
  layoutOrganic(ctx, arterials, stages)
  // 地标建筑（酒馆、传送门……）插进填好的街坊
  placeLandmarks(ctx)
  // 城外的磨坊、风车、刑场、砖窑、灯塔（成长史里从一开始就有）
  const hm = outMark(ctx)
  ruralExtras(ctx)
  magicExtras(ctx)
  // 名所：千本鸟居、海上鸟居、奥宫、神桥、山寺、山上的修道院、岩上的城……（按地形挑地方，见 sacred.ts）
  sacredSites(ctx)
  stamp(ctx, hm, 0)
  clearFieldsUnder(ctx, ctx.out.buildings.slice(hm.lens.get('buildings')))
  // 聚落名等桥、渡口定下再取：有桥才叫"某某桥"
  const cross = ctx.out.crossings
  const crossing = cross.some((c) => c.kind === 'bridge') ? 'bridge' : cross.some((c) => c.kind === 'ferry') ? 'ferry' : cross.length ? 'ford' : null
  // 都城按城市取名：人口多少都不叫某某村、某某镇
  const town = namer.settlement(p.capital ? 'city' : p.size, p.coast, p.river, crossing)
  const riverName = T.river ? namer.river() : null
  const seaName = T.coast ? namer.sea() : null
  labels(ctx, riverName, seaName)
  stampLabels(ctx)
  joinRoadEnds(ctx)
  clearRoadTrees(ctx)
  // 各户的营生按全城的职业构成校准（只改混住片区里的户，见 people.ts）
  calibrateTrades(ctx.out.buildings, p)

  const st: Settlement = {
    params: p,
    name: p.name || town.en,
    nameZh: p.nameZh || town.zh,
    // 继承自世界地图时三种写法都有；只给了中文名时日文借用它（汉字日文也读得通）
    nameJa: p.nameJa || p.nameZh || p.name || town.ja,
    width: MW,
    height: MH,
    terrain: T.terrain,
    river: T.river && riverName ? { ...T.river, name: riverName } : null,
    sea: T.coast && seaName ? { name: seaName, p: seaPoint(ctx) } : null,
    ...ctx.out,
    stats: { ...statsOf(ctx.out.buildings, ctx.out.wards, p.culture), ms: performance.now() - t0 },
  }
  return { st, history: ctx.history }
}

/**
 * 成长史：城外一开始就有的房子（磨坊、山寺……在片区之后才放）底下，后来开垦的田不铺（田整块不要）
 */
function clearFieldsUnder(ctx: Ctx, buildings: Building[]) {
  const h = ctx.history
  const solid = buildings.map((b) => piece('buildings', b))
  for (const f of [...ctx.out.fields, ...h.past.filter((x) => x.key === 'fields').map((x) => x.item as Field)]) {
    const fp = piece('fields', f)
    if (!solid.some((b) => overlaps(b, fp))) continue
    const l = h.life.get(f)
    if (l) l.died = l.born
    else h.life.set(f, { born: 0, died: 0 })
  }
}

/**
 * 成长史：路（每档路宽一段）修起来时，路面上的树那时砍掉。田野、荒地是按那时还没有的街巷铺的（见 historyWards），
 * 林子会压在后来的路上；田画在路下面，不用管
 */
function clearRoadTrees(ctx: Ctx) {
  const h = ctx.history
  const G = 16
  const trees = [...ctx.out.trees, ...h.past.filter((x) => x.key === 'trees').map((x) => x.item as Tree)]
  const grid = new Map<string, Tree[]>()
  for (const t of trees) {
    const k = `${Math.floor(t.p[0] / G)},${Math.floor(t.p[1] / G)}`
    let g = grid.get(k)
    if (!g) grid.set(k, (g = []))
    g.push(t)
  }
  const roads = [...ctx.out.roads, ...h.past.filter((x) => x.key === 'roads').map((x) => x.item as Road)]
  for (const r of roads) {
    const rl = h.life.get(r) ?? { born: 0, died: Infinity }
    const reach = r.width / 2 + 0.5
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1]
      const b = r.line[i]
      for (let y = Math.floor((Math.min(a[1], b[1]) - reach) / G); y <= Math.floor((Math.max(a[1], b[1]) + reach) / G); y++)
        for (let x = Math.floor((Math.min(a[0], b[0]) - reach) / G); x <= Math.floor((Math.max(a[0], b[0]) + reach) / G); x++)
          for (const t of grid.get(`${x},${y}`) ?? []) {
            let l = h.life.get(t)
            if (l && !(l.born < rl.died && rl.born < l.died)) continue
            if (polylineDist(t.p, [a, b]) >= reach) continue
            if (!l) h.life.set(t, (l = { born: 0, died: Infinity }))
            l.died = Math.max(l.born, rl.born)
          }
    }
  }
}

/**
 * 成长史：注记随它标的东西出现——片区名随那块片区现在的样子，地标、地点名随最近的地标，街名随最近的路；
 * 图题、河、海、山一直都在
 */
function stampLabels(ctx: Ctx) {
  const h = ctx.history
  const bornOf = (x: object | undefined) => (x ? (h.life.get(x)?.born ?? 0) : 0)
  for (const l of ctx.out.labels) {
    if (h.life.has(l)) continue
    let born = 0
    if (l.kind === 'district') born = bornOf(ctx.out.wards.find((w) => pointInPoly(l.p, w.poly)))
    else if (l.kind === 'landmark' || l.kind === 'poi') {
      let best: object | undefined
      let bd = 40
      for (const m of ctx.out.landmarks) {
        const d = dist(m.p, l.p)
        if (d < bd) {
          bd = d
          best = m
        }
      }
      born = bornOf(best)
    } else if (l.kind === 'street') {
      let best: object | undefined
      let bd = Infinity
      for (const r of ctx.out.roads) {
        const d = polylineDist(l.p, r.line)
        if (d < bd) {
          bd = d
          best = r
        }
      }
      born = bornOf(best)
    }
    h.life.set(l, { born, died: Infinity })
  }
}

/** 第 k 个（从 0 数）某种要素出现时的人口：按一串人口下的自动数量（手动数量随人口按比例出现，见 zoneLots） */
function countPopper(p: SettlementParams, walled: boolean) {
  const grid: number[] = []
  for (let t = 20; t < p.population; t *= 1.04) grid.push(t)
  grid.push(p.population)
  const counts = grid.map((t) => {
    const q = { ...p, population: t }
    return resolveCounts(q, featureEnv(q, walled))
  })
  return (id: string, k: number) => {
    const j = counts.findIndex((c) => (c[id as FeatureId] ?? 0) > k)
    return j < 0 ? p.population : grid[j]
  }
}

// —————————————————————— 选址与干道 ——————————————————————

/** 在地图中部找一块平坦、离水适中（便于取水与渡河）的地方作为中心 */
function pickCenter(ctx: Ctx): P {
  const { T, MW, MH, p } = ctx
  // 在地图中心附近固定半径内找（半径、候选点都与地图大小无关，各规模的城心是同一处）
  const rng = seedRng(ctx, 'center')
  let best: P = [MW / 2, MH / 2]
  let bs = Infinity
  const R = 450
  for (let k = 0; k < 500; k++) {
    const a = rng.next() * Math.PI * 2
    const r = Math.sqrt(rng.next()) * R * 0.32
    const q: P = [MW / 2 + dmath.cos(a) * r, MH / 2 + dmath.sin(a) * r]
    const w = T.waterAt(q)
    if (w < ctx.cfg.patch * 0.45) continue
    let s = T.slopeAt(q) * 40 + (r / R) * 2.5
    if (p.river || p.coast) s += Math.abs(w - ctx.cfg.patch * 1.1) / (ctx.cfg.patch * 1.5)
    // 依山：稍微往高处靠，但别上山
    if (p.hills) s += Math.abs(T.heightAt(q) - 14) * 0.01
    if (s < bs) {
      bs = s
      best = q
    }
  }
  return best
}

function borderPoint(ctx: Ctx, a: number): P {
  const { MW, MH, center: c } = ctx
  const dx = dmath.cos(a)
  const dy = dmath.sin(a)
  let t = Infinity
  if (dx > 1e-6) t = Math.min(t, (MW - 2 - c[0]) / dx)
  if (dx < -1e-6) t = Math.min(t, (2 - c[0]) / dx)
  if (dy > 1e-6) t = Math.min(t, (MH - 2 - c[1]) / dy)
  if (dy < -1e-6) t = Math.min(t, (2 - c[1]) / dy)
  return [c[0] + dx * t, c[1] + dy * t]
}

/**
 * 干道只取决于地形、画幅、城心、条数与布局：成长动画、拖人口时逐帧生成，这些一般不变，
 * 记下最近几次的结果直接取用（寻路是生成里最慢的几步之一）。取出的是副本，调用方可以随意改
 */
const arterialMemo = new Map<string, { roads: P[][]; slots: number[]; gridAngle: number }>()
function routeArterials(ctx: Ctx): P[][] {
  const { p } = ctx
  const key = JSON.stringify([
    terrainKey(p), p.river, p.coast, p.hills, p.relief, p.coastDir, p.riverDir, p.hillDir,
    p.regularity, p.radial, ctx.MW, ctx.MH, ctx.center, ctx.cfg.roads,
  ])
  let hit = arterialMemo.get(key)
  if (!hit) {
    const { roads, slots } = routeArterialsRaw(ctx)
    hit = { roads, slots, gridAngle: ctx.gridAngle }
    if (arterialMemo.size >= 8) arterialMemo.delete(arterialMemo.keys().next().value!)
    arterialMemo.set(key, hit)
  }
  ctx.gridAngle = hit.gridAngle
  const roads = hit.roads.map((l) => l.map((q) => [q[0], q[1]] as P))
  // 成长史：第 k 条干道在干道条数长到 k + 1 时开通
  roads.forEach((line, j) => ctx.history.sources.push({ line, born: roadOpenPop(p, hit!.slots[j]) }))
  return roads
}

/** 干道条数（随人口，见 scale.ts 的 roads；商贸城多一条） */
const roadCount = (p: SettlementParams, pop: number) => {
  const r = scaleOf(pop).cfg.roads
  const extra = p.function === 'trade' ? 1 : 0
  return Math.min(8, Math.round(r[0] + extra + (r[1] - r[0]) * 0.5))
}
/** 第 k 条（从 0 数）干道开通时的人口 */
function roadOpenPop(p: SettlementParams, k: number) {
  for (let t = 20; t < p.population; t *= 1.04) if (roadCount(p, t) > k) return t
  return p.population
}

/** 由中心通往地图边缘的干道：沿地形寻路，后修的路尽量并入已有的路。slots：每条路是第几条开通的 */
function routeArterialsRaw(ctx: Ctx): { roads: P[][]; slots: number[] } {
  const { T, cfg, MW, MH } = ctx
  // 干道方向是固定的 8 个槽位（由种子定），按"先对穿、再十字、再斜向"的顺序启用：
  // 聚落长大时已有的干道不变，只是多开几条
  const rng = seedRng(ctx, 'arterials')
  const K = Math.min(8, Math.round(cfg.roads[0] + (cfg.roads[1] - cfg.roads[0]) * 0.5))
  const a0 = rng.next() * Math.PI * 2
  const SLOTS = [0, 4, 2, 6, 1, 5, 3, 7]
  const jitter = SLOTS.map(() => (rng.next() - 0.5) * 0.7)
  const retry = SLOTS.map(() => rng.next())
  // 方格的朝向取第一条干道的方向（按 90° 对称折到 ±45° 内，东式院落据此坐北朝南）
  const q = Math.PI / 2
  ctx.gridAngle = a0 - Math.round(a0 / q) * q
  // 越偏方格，干道出城方向越贴近方格的四条轴线
  const axis = squareness(ctx.p)
  const toAxis = (a: number) => a + (ctx.gridAngle + Math.round((a - ctx.gridAngle) / q) * q - a) * axis
  const roads: P[][] = []
  const slots: number[] = []
  // 10 米一格：与地图中心（世界原点）对齐，各规模下标记位置一致
  const cell = 10
  const GW = Math.ceil(MW / cell) + 1
  const GH = Math.ceil(MH / cell) + 1
  const used = new Uint8Array(GW * GH)
  const bias = (q: P) => (used[Math.min(GH - 1, Math.round(q[1] / cell)) * GW + Math.min(GW - 1, Math.round(q[0] / cell))] ? 0.45 : 1)
  for (let k = 0; k < K; k++) {
    const slot = SLOTS[k]
    // 槽位本身的方向：路标点沿它走（与地图边界落不落水、重试几次无关）
    const dir = toAxis(a0 + (slot / 8) * Math.PI * 2 + jitter[slot])
    let target: P | null = null
    for (let tries = 0; tries < 12 && !target; tries++) {
      const side = retry[slot] < 0.5 ? 1 : -1
      const a = toAxis(a0 + (slot / 8) * Math.PI * 2 + jitter[slot]) + (tries ? (tries % 2 ? side : -side) * Math.ceil(tries / 2) * 0.22 : 0)
      const q = borderPoint(ctx, a)
      if (T.waterAt(q) > 12 && T.heightAt(q) < 120) target = q
    }
    if (!target) continue
    // 先依次经过固定半径上的路标点，再到地图边界；每段各自寻路：
    // 地图变大只是在外头接长，城附近的路线不变
    const reach = dist(target, ctx.center)
    const stops: P[] = [ctx.center]
    for (const r of WAYPOINTS) {
      if (r >= reach - 60) break
      stops.push(dryNear(ctx, [ctx.center[0] + dmath.cos(dir) * r, ctx.center[1] + dmath.sin(dir) * r]))
    }
    stops.push(target)
    let raw: P[] = []
    for (let k = 0; k + 1 < stops.length; k++) {
      const seg = routeOnTerrain(T, stops[k], stops[k + 1], { water: 14, slope: 1, bias })
      if (seg.length < 2) {
        raw = []
        break
      }
      const sm = straighten(smoothRoute(seg, 4, T), ctx.p.regularity)
      raw.push(...(raw.length ? sm.slice(1) : sm))
    }
    if (raw.length < 2) continue
    for (const q of resample(raw, cell / 2)) {
      const i = Math.round(q[0] / cell)
      const j = Math.round(q[1] / cell)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = i + dx
          const y = j + dy
          if (x >= 0 && y >= 0 && x < GW && y < GH) used[y * GW + x] = 1
        }
    }
    roads.push(raw)
    slots.push(k)
  }
  return { roads, slots }
}

/** 干道路标点离城心的半径（米） */
const WAYPOINTS = [120, 250, 500, 1000, 2000, 4000]

/** 路标点落水时，沿同一半径左右挪到最近的旱地（挪法只看位置，与地图大小无关） */
function dryNear(ctx: Ctx, q: P): P {
  const c = ctx.center
  const r = dist(q, c)
  const a0 = dmath.atan2(q[1] - c[1], q[0] - c[0])
  for (let k = 0; k < 24; k++) {
    const a = a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.06
    const p: P = [c[0] + dmath.cos(a) * r, c[1] + dmath.sin(a) * r]
    if (ctx.T.waterAt(p) > 12) return p
  }
  return q
}

/** 规整度越高，干道越直：按容差简化折线（Douglas-Peucker），弯道收成几段直街 */
function straighten(line: P[], r: number): P[] {
  const tol = r * r * 26
  if (tol < 0.5 || line.length < 3) return line
  // 重新加密，后续沿路布点、裁剪都按均匀的折线处理
  return resample(fromF32(simplify(toF32(line), tol)), 4)
}

/** 第 k 个副中心大约在城市长到 SUB_BIRTH × k 人时出现（features.ts 里副中心的自动数量按同样的人口算） */
const SUB_BIRTH = 16000
/** 自动出现的副中心最多几个（features.ts 里 subcenter 的 auto 上限） */
const MAX_SUB = 4

/** 一代城墙：修建时的人口、规划能容纳的人口、（现在的）材质 */
interface WallStage {
  pop: number
  cap: number
  kind: 'stone' | 'palisade'
}

/**
 * 历代城墙。规模以下没有城墙；到 first 人时修第一道，只圈住那时已经盖起来的城区（留一点余量 WALL_SLACK，
 * 不预先圈一大片空地）。城市接着长，先在城门外沿路长出关厢；人口到 wallNext 倍时修更大的一圈，
 * 把关厢包进来——但只扩这一次：再往后城市就在墙外长成大片城区与关厢（墙外有建筑群是常态），城墙圈着的是老城。
 * 材质随城市变富原地升级：人口过了 stone，现有的那圈木栅改成石墙（位置不变）。
 * 只返回已经修起来的。
 */
const WALL_SLACK = 1.12
const WALL_SLACK_SMALL = 1.5
/** 隔多久扩墙：小城长到约 2.2 倍才扩，大城长得慢一些就扩（1.45 倍） */
const wallNext = (pop: number) => Math.min(2.25, Math.max(1.45, 2.25 - 0.36 * dmath.log2(pop / 1200)))
function wallStages(p: SettlementParams): WallStage[] {
  if (p.walls === 'none') return []
  const fort = p.function === 'fortress'
  const first = fort ? 400 : 1200
  const stone = fort ? 800 : 2500
  const out: WallStage[] = []
  // 最多两道：第一道和一次扩建；之后不再扩墙，城市在墙外长成大片城区与关厢
  for (let pop = first; pop <= p.population && out.length < 2; pop = pop * wallNext(pop)) {
    // 被下一道取代时的人口（最新一道就是现在）
    const until = Math.min(p.population, pop * wallNext(pop))
    const kind = p.walls === 'stone' || p.walls === 'palisade' ? p.walls : until >= stone ? 'stone' : 'palisade'
    // 村镇的木栅圈着菜园、场院，比城区宽裕些；城市的墙贴着城区
    out.push({ pop, cap: pop * (pop < 3000 ? WALL_SLACK_SMALL : WALL_SLACK), kind })
  }
  // 明确要求了木栅 / 石墙的小村：人口还不到自动筑墙的门槛，也照样围上一圈（圈住现在的村子）
  if (!out.length && (p.walls === 'stone' || p.walls === 'palisade')) out.push({ pop: p.population, cap: p.population, kind: p.walls })
  return out
}

// —————————————————————— 有机布局 ——————————————————————

/** 住下 pop 人需要的城内片区数（户数 ÷ 每公顷户数，折成片区；不少于档位的经验值） */
function innerFor(p: SettlementParams, pop: number) {
  const need = Math.round(((pop / perHome(p.culture)) / housesPerHa({ ...p, population: pop })) * 10000 / (0.87 * PATCH * PATCH * 0.9))
  return Math.max(scaleOf(pop).cfg.inner, need)
}
/** 人口为 pop 时的城区半径估计 */
const rinFor = (p: SettlementParams, pop: number) => Math.sqrt((innerFor(p, pop) * 0.87 * PATCH * PATCH) / Math.PI)

/**
 * 第 k 个副中心出现时的人口（与 growInner 里副中心开始生长的时刻一致）：按 SUB_BIRTH 一个个出现，
 * 与现在的人口无关（城市长大时早先的副中心不会提前或推迟出现）；手动要的比按人口该有的多时，
 * 多出的几个在最后一个按时出现的之后、到现在之间均匀排开
 */
function subBirth(p: SettlementParams, k: number, n: number) {
  const due = Math.min(n, Math.floor(p.population / SUB_BIRTH))
  if (k < due) return SUB_BIRTH * (k + 1)
  const base = SUB_BIRTH * due
  return base + ((p.population - base) * (k - due + 1)) / (n - due + 1)
}

/**
 * 副中心选址，按"出生时"定：第 k 个副中心在城市长到 subBirth 人时出现，离城心多远、自己多大
 * 都按那时的城区半径算；候选只取最早两条干道上的点与城心周围一圈，打分的扰动按位置取。
 * 先出现的定下后不再变，后出现的只在它们之后挑——城市继续长大时副中心不会搬家。
 * 距离随 spread：0 时约 0.7 ~ 1.0 个城区半径（与主城粘连成一片），1 时 1.5 ~ 2 个（隔着田野的卫星城）。
 * 每个副中心的方格朝向取所在干道的走向，各片城区的街网于是各有方向。
 */
function pickSubcenters(ctx: Ctx, arterials: P[][], n: number, birth = (k: number) => subBirth(ctx.p, k, n)): Core[] {
  const { T, cfg, center: c, p } = ctx
  const fold = (a: number) => a - Math.round(a / (Math.PI / 2)) * (Math.PI / 2)
  const s = p.spread * p.spread
  const out: (Core & { a: number })[] = []
  for (let k = 0; k < n; k++) {
    const Rb = rinFor(p, birth(k))
    const R = Rb * (0.55 - 0.1 * p.spread)
    const d0 = Rb * (0.7 + 0.8 * s)
    const d1 = Rb * (1.0 + 1.0 * s)
    const m = R * 1.2
    const good = (q: P) => T.waterAt(q) > cfg.patch * 0.45 && T.slopeAt(q) < 0.15 && q[0] > m && q[1] > m && q[0] < ctx.MW - m && q[1] < ctx.MH - m
    const cands: { p: P; a: number; angle: number; score: number }[] = []
    for (const road of arterials.slice(0, 2))
      for (let i = 1; i + 1 < road.length; i++) {
        const q = road[i]
        const d = dist(q, c)
        if (d < d0 || d > d1 || !good(q)) continue
        const along = dmath.atan2(road[i + 1][1] - road[i - 1][1], road[i + 1][0] - road[i - 1][0])
        cands.push({ p: q, a: dmath.atan2(q[1] - c[1], q[0] - c[0]), angle: fold(along), score: 1 + hashAt(ctx, q, 'sub.road', k) * 0.3 })
      }
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2
      const r = (d0 + d1) / 2
      const q: P = [c[0] + dmath.cos(a) * r, c[1] + dmath.sin(a) * r]
      if (good(q)) cands.push({ p: q, a, angle: fold(hashAt(ctx, q, 'sub.ring.angle') * Math.PI), score: hashAt(ctx, q, 'sub.ring', k) * 0.3 })
    }
    // 与已有副中心的方位差越大越好，其次偏好干道上的点
    let best: (typeof cands)[number] | null = null
    let bs = -Infinity
    for (const cd of cands) {
      if (out.some((o) => dist(o.c, cd.p) < (o.R + R) * 1.6)) continue
      let gap = Math.PI
      for (const o of out) {
        let da = Math.abs(cd.a - o.a) % (Math.PI * 2)
        if (da > Math.PI) da = Math.PI * 2 - da
        gap = Math.min(gap, da)
      }
      const sc = gap * 2 + cd.score
      if (sc > bs) {
        bs = sc
        best = cd
      }
    }
    if (!best) break
    // 离得越远的卫星城"引力"越弱，主城仍是最大的一片
    out.push({ c: best.p, angle: best.angle, R, k: SUB_WEIGHT + 0.4 * p.spread, a: best.a })
  }
  return out.map(({ a: _a, ...core }) => core)
}

/** 相邻副中心（按方位排序后相邻、夹角不大）之间沿地形修一条干道，城市圈由此连成网 */
function linkSubcenters(ctx: Ctx, arterials: P[][]): P[][] {
  const subs = ctx.cores
    .slice(1)
    .map((k) => k.c)
    .sort((a, b) => dmath.atan2(a[1] - ctx.center[1], a[0] - ctx.center[0]) - dmath.atan2(b[1] - ctx.center[1], b[0] - ctx.center[0]))
  if (subs.length < 2) return []
  // 10 米一格：与地图中心（世界原点）对齐，各规模下标记位置一致
  const cell = 10
  const GW = Math.ceil(ctx.MW / cell) + 1
  const used = new Uint8Array(GW * (Math.ceil(ctx.MH / cell) + 1))
  for (const r of arterials) for (const q of resample(r, cell / 2)) used[Math.round(q[1] / cell) * GW + Math.round(q[0] / cell)] = 1
  const bias = (q: P) => (used[Math.round(q[1] / cell) * GW + Math.round(q[0] / cell)] ? 0.5 : 1)
  const out: P[][] = []
  for (let i = 0; i < subs.length; i++) {
    if (subs.length === 2 && i === 1) break
    const a = subs[i]
    const b = subs[(i + 1) % subs.length]
    const aa = dmath.atan2(a[1] - ctx.center[1], a[0] - ctx.center[0])
    const ab = dmath.atan2(b[1] - ctx.center[1], b[0] - ctx.center[0])
    let da = Math.abs(aa - ab)
    if (da > Math.PI) da = Math.PI * 2 - da
    if (da > Math.PI * 0.75) continue
    const raw = routeOnTerrain(ctx.T, a, b, { water: 14, slope: 1, bias })
    if (raw.length < 2) continue
    const line = straighten(smoothRoute(raw, 4, ctx.T), ctx.p.regularity)
    out.push(line)
    // 成长史：两个副中心都出现了才修
    const birth = (q: P) => {
      const k = ctx.cores.findIndex((c) => c.c === q)
      return k > 0 ? subBirth(ctx.p, k - 1, ctx.cores.length - 1) : 0
    }
    ctx.history.sources.push({ line, born: Math.max(birth(a), birth(b)) })
  }
  return out
}

/** 城区的生长历史：片区加入的先后，与加入后累计能住的户数 */
interface Growth {
  order: number[]
  cum: number[]
  /** 生长时留的余量（容量 = 户数 × margin） */
  margin: number
  /** 各片区的"年龄"：加入时的名义累计容量 ÷ 现在的规划容量，0 是老城 */
  ages: Map<number, number>
  /**
   * 各片区加入城区时的人口：按与现在人口无关的名义密度（城镇的平均户数 / 公顷）累计生长顺序，
   * 同一块地在任何规模下都算出同一个值。街巷宽、片区功能都按它回放城市的历史
   */
  joinPop: Map<number, number>
  /** 各片区加入城区时的街巷宽（米）：老城的巷子窄、后来辟的街区宽，城市长大时已有的街坊不跟着拓宽 */
  lanes: Map<number, number>
}

function growInner(ctx: Ctx, patches: Patch[], plannedPop: number, arterials: P[][]): Growth {
  const { T, cfg } = ctx
  const typical = cfg.patch * cfg.patch * 0.87
  const dist = layoutDist(ctx, arterials)
  // 已经出现的核心数：副中心出现之前，城区不朝它那边提前长（否则同一段早年的城区随现在有没有副中心而变）
  let born = 1
  const cost = (i: number) => {
    const q = patches[i].site
    // 规划区是建城时的底子：先于有机的外城加入，片区再大也不算"稀疏"
    if (patches[i].planned || patches[i].palace !== undefined) return dist(q, born) * 0.3 * (1 + T.slopeAt(q) * 5)
    // 过大的片区（稀疏处的 Voronoi 单元）不适合作城区
    const big = Math.max(1, area(patches[i].poly) / typical)
    return dist(q, born) * (1 + T.slopeAt(q) * 5) * (0.85 + hashAt(ctx, q, 'grow.cost') * 0.3) * big
  }
  // 主中心与各副中心是种子（它们是前 1 + k 个片区）
  const seeds = ctx.cores.map((_, i) => i)
  const seen = new Set<number>(seeds)
  const front: [number, number][] = []
  const push = (i: number) => {
    for (const j of patches[i].nb) {
      if (seen.has(j)) continue
      seen.add(j)
      if (patches[j].land < 0.45 || (!patches[j].planned && patches[j].palace === undefined && area(patches[j].poly) > typical * 2.6)) continue
      front.push([cost(j), j])
    }
  }
  // 按容量生长：累计"陆地面积 × 每公顷户数"，够住下目标户数（留一点余量）就停；
  // 片区数只作上限（地形逼仄时不无限长下去）
  // 城区长到住得下现在的人口；有城墙时长到城墙规划的容量（墙内先是稀疏的）
  const model = capacityModel(ctx, patches, arterials, ctx.p.population)
  const margin = model.margin
  // 撒祠、村社要拆的几户也留出地方（见 tiers.ts 的 tierReserve）
  const need = Math.max(ctx.houseBudget, plannedPop / perHome(ctx.p.culture)) * margin * tierReserve(ctx.p.culture)
  const ages = new Map<number, number>()
  // 历史上各时刻（与现在的人口无关的一串固定人口）要的城区也都要圈进来：城市变密以后同样的人住得下更少的地，
  // 但已经辟成城区的地不会退回田野——城区是历代城区的并集，只扩不缩
  // L：够住下那时的人口时城区有几块片区（按生长顺序数），成长史按它定各片区加入的时刻
  const history: { x: number; model: ReturnType<typeof capacityModel>; need: number; cap: number; L?: number }[] = []
  const xs: number[] = []
  for (let x = HISTORY_FROM; x < ctx.p.population; x *= HISTORY_STEP) xs.push(x)
  xs.push(ctx.p.population)
  for (const x of xs) {
    const m = x === ctx.p.population ? model : capacityModel(ctx, patches, arterials, x)
    history.push({ x, model: m, need: (x / perHome(ctx.p.culture)) * m.margin * tierReserve(ctx.p.culture), cap: 0 })
  }
  const capacity = (i: number) => {
    const { c, age, d, s } = model.add(i)
    ages.set(i, age)
    if (patches[i].density === undefined) {
      patches[i].density = d
      patches[i].score = s
    }
    for (const h of history) {
      h.cap += h.model === model ? c : h.model.add(i).c
      if (h.L === undefined && h.cap >= h.need) h.L = order.length + 1
    }
    return c
  }
  let cap = 0
  const order: number[] = []
  const cum: number[] = []
  const seed = (i: number) => {
    patches[i].inner = true
    cap += capacity(i)
    order.push(i)
    cum.push(cap)
    push(i)
  }
  // 主中心先长；第 k 个副中心在城市长到约 SUB_BIRTH × k 人时才另起（与自动数量的规则一致），
  // 早年的城区与城墙里没有它们
  const per = perHome(ctx.p.culture)
  const births = seeds.slice(1).map((i, k) => ({ i, at: (subBirth(ctx.p, k, seeds.length - 1) / per) * margin }))
  seed(seeds[0])
  let n = 1
  for (;;) {
    while (births.length && cap >= births[0].at) {
      born++
      // 新核心出现：前沿上的片区按新的远近重排
      for (const e of front) e[0] = cost(e[1])
      seed(births.shift()!.i)
      n++
    }
    if (!((cap < need || history.some((h) => h.cap < h.need)) && n < cfg.inner * (ctx.env.big ? 4 : 8) && front.length)) break
    front.sort((a, b) => a[0] - b[0])
    const [, j] = front.shift()!
    patches[j].inner = true
    cap += capacity(j)
    order.push(j)
    cum.push(cap)
    n++
    push(j)
  }
  for (const b of births) seed(b.i)
  // 填洞：四周全是城区的片区也并进来
  for (const pa of patches) if (!pa.inner && pa.land >= 0.5 && pa.nb.length && pa.nb.every((j) => patches[j].inner)) pa.inner = true
  const joinPop = new Map<number, number>()
  const lanes = new Map<number, number>()
  // 各片区加入的时刻按"那时的人口要多少片区"（按那时的密度：村子时候是零散的农家，一块地住不了几户）。
  // 第 k 块在够住下 x 人要的片区数 L 数到它时加入，两个取样之间按对数插值；副中心在它出现的时刻
  {
    order.forEach((i, k) => {
      const j = history.findIndex((h) => (h.L ?? Infinity) >= k + 1)
      // 取样里没有哪个时刻要到这么多片区（生长到了地形的尽头）：到现在也还没加入
      if (j < 0 || history[j].L === undefined) return
      const h = history[j]
      const prev = history[j - 1]
      const t = !prev ? (h.x * (k + 1)) / h.L! : prev.x * dmath.pow(h.x / prev.x, (k + 1 - prev.L!) / Math.max(1, h.L! - prev.L!))
      joinPop.set(i, t)
    })
    ctx.cores.forEach((_, k) => joinPop.set(seeds[k], k ? subBirth(ctx.p, k - 1, seeds.length - 1) : 0))
    // 四周都加入以后就成了洞、被并进城区：加入的时刻取"轮到它"与"成了洞"里早的那个
    patches.forEach((pa, i) => {
      if (pa.land < 0.5 || !pa.nb.length || !pa.nb.every((j) => joinPop.has(j))) return
      const hole = Math.max(...pa.nb.map((j) => joinPop.get(j)!))
      if (hole < (joinPop.get(i) ?? Infinity)) joinPop.set(i, hole)
    })
  }
  for (const [i, at] of joinPop) lanes.set(i, Math.min(cfg.lane, scaleOf(at).cfg.lane))
  return { order, cum, margin, ages, joinPop, lanes }
}

/**
 * 城区生长的余量：小城镇片区少、占用率的软边缘占比大，要多留；大城市留一点就够（余量多了外围会长出一大圈空着的疏档片区）。
 * 在 6000 ~ 16000 人之间按对数人口连续收窄：一刀切的话，跨过分界时要的城区突然变小，外围的片区整片消失
 */
function growMargin(pop: number) {
  const t = (a: number, b: number) => Math.min(1, Math.max(0, dmath.log(pop / a) / dmath.log(b / a)))
  return 1.35 - 0.05 * t(1500, 6000) - 0.24 * t(6000, 16000)
}

/**
 * 人口为 pop 时各片区能住的户数，按生长顺序依次对片区调用 add：
 * - 密度档看那时的城区多大、片区多老（年龄 = 加入时的名义累计容量 ÷ 那时的规划容量，0 是老城）、离干道多近；
 * - 城镇按民居片区盖满的实测容量，村落按平均；
 * - 特殊片区（广场、市集、寺庙、墓地、城堡……）各占一整块、几乎不住人：最早加入的那几块算作没有容量。
 * 现在的城区用现在的人口；历代城墙用修墙时的人口——同一道墙圈住的片区才不随城市后来长大而变。
 */
function capacityModel(ctx: Ctx, patches: Patch[], arterials: P[][], pop: number) {
  const { p, cfg } = ctx
  const now = pop === p.population
  const at: SettlementParams = now ? p : { ...p, population: pop }
  const margin = growMargin(pop)
  // 那时的城区半径：各片区是街坊还是农家按它定（与盖房时同一个判定，见 wardTown）
  const Rin = rinFor(p, pop)
  const counts = now ? ctx.counts : resolveCounts(at, featureEnv(at, wallStages(at).length > 0))
  // 那时已经出现的核心（主中心与副中心）
  const cores = 1 + ctx.cores.slice(1).filter((_, k) => subBirth(p, k, ctx.cores.length - 1) <= pop).length
  let special = cores + FEATURES.filter((f) => f.form === 'ward' && !LIVED.has(f.id)).reduce((s, f) => s + (counts[f.id] ?? 0), 0)
  // 名义容量把特殊片区也当作一块中档民居
  const perPatch = (cfg.patch * cfg.patch * 0.87 * fullPerHa(p.culture, 'common', 'mid') * RESIDENTIAL) / 10000
  const hh = Math.max(1, (pop / perHome(p.culture)) * margin + special * perPatch)
  let nominal = 0
  return {
    margin,
    add(i: number): { c: number; age: number; d: Density; s: number } {
      const age = nominal / hh
      const { d, s } = densityAt(ctx, patches[i].site, age, arterials, pop)
      // 街坊按民居片区盖满的实测容量，农家按零散农家的
      const t = wardTown(ctx, patches[i].site, pop, Rin)
      const c = (area(patches[i].poly) * patches[i].land * mixRate(farmPerHa(p.culture), wardRate(p.culture, 'common', pop, s) * RESIDENTIAL, t)) / 10000
      nominal += c
      if (special > 0) {
        special--
        return { c: 0, age, d, s }
      }
      return { c, age, d, s }
    },
  }
}

/**
 * 这块城区片区在人口为 pop 时成了几分街坊（0 是零散的农家，>0 按街坊切地块）：片区的位置哈希低于这里的街坊占比
 * （见 scale.ts 的 townShare）就开始成街坊，占比再高出 TOWN_RAMP 时住满。占比随人口只升不降，一块地一旦成了街坊就一直是，
 * 住户从农家的几户一点点添到街坊的户数；村 → 镇 → 城没有分界上的整体改盖
 */
function wardTown(ctx: Ctx, q: P, pop: number, Rin: number) {
  return Math.min(1, Math.max(0, (townShare(pop, centerDist(ctx, q) / Math.max(1, Rin)) - hashAt(ctx, q, 'ward.town')) / TOWN_RAMP))
}
const TOWN_RAMP = 0.25
/** 片区每公顷住多少户：农家与街坊按成街坊的程度 t 混合（t 为 0 是农家） */
const mixRate = (farm: number, town: number, t: number) => (t > 0 ? farm + (town - farm) * t : farm)

/**
 * 成长史：人口为 t 时城区的半径（到那时为止加入城区的片区面积折成等面积的圆）。
 * 街坊 / 农家按离城心的远近（相对这个半径）定：城的边上是街坊，再往外零散的农家才多
 */
function joinedRadius(patches: Patch[], growth: Growth) {
  const js = [...growth.joinPop].sort((a, b) => a[1] - b[1])
  const ts: number[] = []
  const rs: number[] = []
  let acc = 0
  for (const [i, t] of js) {
    acc += area(patches[i].poly) * patches[i].land
    ts.push(t)
    rs.push(Math.sqrt(acc / Math.PI))
  }
  return (t: number) => {
    let lo = 0
    let hi = ts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ts[mid] <= t) lo = mid + 1
      else hi = mid
    }
    return Math.max(PATCH, lo ? rs[lo - 1] : 0)
  }
}

/** 城区历史的取样：从 HISTORY_FROM 人起每长 HISTORY_STEP 倍取一个时刻（固定的一串人口，各规模下取的是同一批） */
const HISTORY_FROM = 60
const HISTORY_STEP = 1.4

/** 住人片区（民居、商人、工匠……）的容量折扣：街角的水井、小广场、零星空地 */
const RESIDENTIAL = 0.95
/** 住人的成片片区；其余按片区放的要素（广场、寺庙、城堡……）几乎不住人 */
const LIVED = new Set<FeatureId>(['merchant', 'craft', 'slum'])

/** 片区的密度档：年龄、离对外干道多近、平滑噪声（见 scale.ts 的 densityOf） */
function densityAt(ctx: Ctx, q: P, age: number, arterials: P[][], pop = ctx.p.population): { d: Density; s: number } {
  // 离干道多近与位置噪声只看位置：记下来，按历代人口重估密度时不必重算。
  // 不放 ctx.memo：memo 每次检查点都要整张遍历、回滚时还要复制，这张表在大城里有上千项
  // 先按站点数组本身查，查不到再按坐标串（坐标相同的另一个数组）
  const bySite = (ctx.densityBySite ??= new WeakMap())
  let f = bySite.get(q)
  if (!f) {
    const key = `${q[0]},${q[1]}`
    f = ctx.density.get(key)
    if (!f) {
      let gap = Infinity
      for (const r of arterials) gap = Math.min(gap, polylineDist(q, r))
      f = [dmath.exp(-gap / (ctx.cfg.patch * 0.8)), smoothNoise(ctx, q, 240, 'density')]
      ctx.density.set(key, f)
    }
    bySite.set(q, f)
  }
  const s = densityScore(age, f[0], f[1])
  return { d: densityTier(pop, s), s }
}

/**
 * 填洞、城墙圈进来的片区补上密度档（按相邻片区里最晚加入的算年龄）；再按功能修正：
 * 贵族宅第是疏的，贫民窟是密的，市集至少是中档（商人区的疏档是客栈、货栈大院）。
 */
function settleDensity(ctx: Ctx, patches: Patch[], g: Growth, arterials: P[][]) {
  patches.forEach((pa) => {
    if (!pa.inner) {
      pa.density = 'low'
      return
    }
    if (pa.density === undefined) {
      const { d, s } = densityAt(ctx, pa.site, Math.max(0, ...pa.nb.map((j) => g.ages.get(j) ?? 0)), arterials)
      pa.density = d
      pa.score = s
    }
    if (pa.type === 'noble') pa.density = 'low'
    else if (pa.type === 'slum') pa.density = 'high'
    else if (pa.type === 'market' && pa.density === 'low') pa.density = 'mid'
  })
}

/**
 * 布局距离：离最近核心的距离，在各核心自己的方格坐标里量——方格时用切比雪夫距离（等距线是方的），
 * 有机、放射时用欧氏距离（圆的），中间按方格程度混合；副中心按其权重放大。城区生长与盖房的渐变都用它。
 */
function layoutDist(ctx: Ctx, arterials: P[][]) {
  const sq = squareness(ctx.p)
  const frames = ctx.cores.map((c) => ({ f: gridFrame(c), k: c.k }))
  // 沿对外干道长：离干道越近越"近"，城区沿大路伸出触角（大城的轮廓是星形而不是圆，村子是沿路的街村）。
  // 与规模无关：生长的先后在村 → 镇的分界上不重排
  const pull = 0.5
  const reach = ctx.cfg.patch * 2.2
  // 大片的起伏（越往外越明显，大城的外围起伏大）：轮廓有凸有凹，不是一个圆。
  // 按距离而不按人口放大：同一块地的远近在任何规模下都一样，城区生长的先后才不随现在的人口重排
  const r8 = rinFor(ctx.p, 8000)
  const wobAt = (d: number) => 0.35 + 0.35 * Math.min(1, Math.max(0, dmath.log2(Math.max(1, d / r8)) / 1.5))
  const shape = ctx.plan ? planShape(ctx.plan.z) : null
  return (q: P, cores = frames.length) => {
    let d = Infinity
    frames.slice(0, cores).forEach(({ f, k }, i) => {
      // 有规划区时主城心按规划区的形状量远近（轮廓上处处等远）：城区顺着规划区由内往外住满，外城也随之展开
      if (i === 0 && shape) {
        d = Math.min(d, shape(q) * k)
        return
      }
      const [u, v] = f.toUV(q)
      const cheb = Math.max(Math.abs(u), Math.abs(v)) * 1.12
      d = Math.min(d, (dmath.hypot(u, v) * (1 - sq) + cheb * sq) * k)
    })
    let gap = Infinity
    for (const r of arterials) gap = Math.min(gap, polylineDist(q, r))
    return d * (1 - pull * dmath.exp(-gap / reach)) * (1 + (smoothNoise(ctx, q, 260, 'layout.shape') - 0.5) * wobAt(d))
  }
}

/**
 * 按规划区形状的距离：沿各方向把"到城心的距离"按轮廓的远近缩放到等面积圆的半径，
 * 规划区的轮廓上处处相等（长方形的营寨两端不再比中段"远"）。
 */
function planShape(z: PlanZone): (q: P) => number {
  const N = 180
  const rim: number[] = []
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2
    const far: P = [z.c[0] + dmath.cos(a) * 1e5, z.c[1] + dmath.sin(a) * 1e5]
    let r = 0
    for (let i = 0; i < z.poly.length; i++) {
      const hit = segIntersect(z.c, far, z.poly[i], z.poly[(i + 1) % z.poly.length])
      if (hit && hit.t >= 0 && hit.u >= 0 && hit.u <= 1) r = Math.max(r, hit.t * 1e5)
    }
    rim.push(r)
  }
  const Req = Math.sqrt(Math.abs(area(z.poly)) / Math.PI)
  return (q) => {
    const dx = q[0] - z.c[0]
    const dy = q[1] - z.c[1]
    const t = (((dmath.atan2(dy, dx) / (Math.PI * 2)) % 1) + 1) % 1 * N
    const k0 = Math.floor(t) % N
    const f = t - Math.floor(t)
    const r = rim[k0] * (1 - f) + rim[(k0 + 1) % N] * f
    return (dmath.hypot(dx, dy) * Req) / Math.max(1, r)
  }
}

/** 平滑的位置噪声（0 ~ 1）：scale 米一格的格点值按位置哈希，双线性插值 */
function smoothNoise(ctx: Ctx, q: P, scale: number, tag: string) {
  const ox = ctx.MW / 2
  const oy = ctx.MH / 2
  const fx = (q[0] - ox) / scale
  const fy = (q[1] - oy) / scale
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const at = (i: number, j: number) => hashAt(ctx, [ox + i * scale, oy + j * scale], tag)
  const sx = tx * tx * (3 - 2 * tx)
  const sy = ty * ty * (3 - 2 * ty)
  return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy
}

/**
 * 各片区按布局的远近（方格布局下等距线是方的），再叠一层平滑噪声和逐块扰动：外围有进有出，不是完美的同心渐变。
 * 城外的片区按它由近到远盖
 */
function layoutDistances(ctx: Ctx, patches: Patch[]): number[] {
  const ld = layoutDist(ctx, ctx.out.roads.filter((r) => r.kind === 'main' || r.kind === 'highway').map((r) => r.line))
  // 城越大，边缘的起伏越大
  const wob = ctx.env.big ? 0.5 + 0.3 * Math.min(1, dmath.log2(Math.max(1, ctx.p.population / 8000)) / 3) : 0.5
  return patches.map((pa) => ld(pa.site) * (1 + (smoothNoise(ctx, pa.site, 220, 'occupancy') - 0.5) * wob) + (hashAt(ctx, pa.site, 'occupancy.jitter') - 0.5) * ctx.cfg.patch)
}


/** 人口为 pop 时的城区（生长顺序的前缀，再填上四周都是城区的洞） */
function innerAt(ctx: Ctx, patches: Patch[], g: Growth, pop: number, arterials: P[][]): boolean[] {
  // 容量按那时的人口算（密度、特殊片区都是那时的）：现在的城市更密，但当年的城区还是那么大。
  // 城区只扩不缩：取那之前历代（同 growInner 的取样）要的城区里最大的，后修的墙不会比先修的小
  let L = 0
  const xs: number[] = []
  for (let x = HISTORY_FROM; x < pop; x *= HISTORY_STEP) xs.push(x)
  xs.push(pop)
  for (const x of xs) {
    const model = capacityModel(ctx, patches, arterials, x)
    const need = (x / perHome(ctx.p.culture)) * model.margin
    let cap = 0
    let k = 0
    while (k < g.order.length && cap < need) cap += model.add(g.order[k++]).c
    L = Math.max(L, k)
  }
  const set = patches.map(() => false)
  for (let k = 0; k < L; k++) set[g.order[k]] = true
  patches.forEach((pa, i) => {
    if (!set[i] && pa.land >= 0.5 && pa.nb.length && pa.nb.every((j) => set[j])) set[i] = true
  })
  return set
}

/**
 * 城墙变形：规整度越高，轮廓越接近方格坐标下的矩形（放射度 0）或圆（放射度 1），中间两者混合。
 * 先把轮廓加密，再让每个点沿"核心 → 该点"的方向移向目标形状（按墙所围的核心的方格朝向）。
 */
function morphWall(ctx: Ctx, loop: P[], core: Core, shared: boolean): P[] {
  // 几个核心连成一片的城市圈不是一个整齐的方城或圆城：变形减弱，免得把别的核心的城区切到墙外
  const w = dmath.pow(ctx.p.regularity, 1.3) * (shared ? 0.35 : 1)
  if (w < 0.02) return loop
  const g = ctx.p.radial
  const c = core.c
  const grid = gridFrame(core)
  const dense = resample([...loop, loop[0]], 10).slice(0, -1)
  // 目标尺寸：面积与原轮廓相近的矩形（按原轮廓在两条轴上的伸展比例）与圆
  let hu = 0
  let hv = 0
  let rr = 0
  for (const q of dense) {
    const [u, v] = grid.toUV(q)
    hu += Math.abs(u)
    hv += Math.abs(v)
    rr += dmath.hypot(u, v)
  }
  hu = (hu / dense.length) * 1.25
  hv = (hv / dense.length) * 1.25
  rr /= dense.length
  const out = dense.map((v) => {
    const dx = v[0] - c[0]
    const dy = v[1] - c[1]
    const L = dmath.hypot(dx, dy) || 1
    const [gu, gv] = grid.toUV(v)
    const u = gu / L
    const vv = gv / L
    const tr = Math.min(Math.abs(u) > 1e-6 ? hu / Math.abs(u) : Infinity, Math.abs(vv) > 1e-6 ? hv / Math.abs(vv) : Infinity)
    const t = tr * (1 - g) + rr * g
    const target: P = [c[0] + (dx / L) * t, c[1] + (dy / L) * t]
    return [v[0] + (target[0] - v[0]) * w, v[1] + (target[1] - v[1]) * w] as P
  })
  return simplifyLoop(out, 3)
}

/** 折线各点留不留：连续落水超过 maxWet 米的一段（顺着河走，不是横穿）不留，短的横穿留着（架桥） */
function dryMask(ctx: Ctx, line: P[], maxWet: number): boolean[] {
  const wet = line.map((q) => ctx.T.waterAt(q) < 0.5)
  const keep = wet.map(() => true)
  for (let i = 0; i < line.length; ) {
    if (!wet[i]) {
      i++
      continue
    }
    let j = i
    while (j < line.length && wet[j]) j++
    if (polylineLength(line.slice(i, j)) > maxWet) for (let k = i; k < j; k++) keep[k] = false
    i = j
  }
  return keep
}

/** 折线按 keep 切成几段，只留满足的部分（至少两个点） */
function splitBy(line: P[], keep: (q: P, i: number) => boolean): P[][] {
  const out: P[][] = []
  let cur: P[] = []
  for (let i = 0; i < line.length; i++) {
    const q = line[i]
    if (keep(q, i)) cur.push(q)
    else {
      if (cur.length > 1) out.push(cur)
      cur = []
    }
  }
  if (cur.length > 1) out.push(cur)
  return out
}

/**
 * 残墙：把旧墙按约 110 米分段，每段按位置哈希决定留不留（留下的比例 keep），留下的段画成城墙、
 * 两端与中间设塔，不开城门。段的划分与取舍都按位置，城继续长大时同一段残墙不会忽隐忽现。只留 within 的部分。
 */
function wallRemnant(ctx: Ctx, loop: P[], keep: number, stage: number, within: (q: P) => boolean) {
  const pts = resample([...loop, loop[0]], 10).slice(0, -1)
  const n = pts.length
  if (n < 6) return
  const seg = 11
  const inside = pts.map(within)
  const solid = pts.map((q, i) => {
    const mid = pts[(Math.floor(i / seg) * seg + (seg >> 1)) % n]
    return hashAt(ctx, mid, 'wall.remnant', stage) < keep && ctx.T.waterAt(q) > 2 && inside[i] && inside[(i + 1) % n]
  })
  if (!solid.some(Boolean)) return
  const towers: P[] = []
  for (let i = 0; i < n; i++) {
    const a = solid[(i - 1 + n) % n]
    const b = solid[i]
    if ((a !== b && (a || b)) || (b && i % 5 === 0)) towers.push(pts[i])
  }
  addWall(ctx, { loop: pts, solid, towers, gates: [], kind: 'stone', thickness: 4 }, 'remnant')
}

/** 把一组片区栅格化、减去海面，追踪外轮廓，简化后向规整形状变形；只要里面有核心的轮廓（每片城区一道） */
function wallLoops(ctx: Ctx, patches: Patch[], set: boolean[], pop: number): P[][] {
  const { MW, MH, T } = ctx
  // 只用来估大致外形（城墙最后贴着片区边界走），8 米一格足够
  const rc = 8
  const W = Math.ceil(MW / rc)
  const H = Math.ceil(MH / rc)
  const mask = new Float32Array(W * H)
  patches.forEach((pa, k) => {
    if (!set[k]) return
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const v of pa.poly) {
      x0 = Math.min(x0, v[0])
      y0 = Math.min(y0, v[1])
      x1 = Math.max(x1, v[0])
      y1 = Math.max(y1, v[1])
    }
    for (let j = Math.max(0, Math.floor(y0 / rc)); j <= Math.min(H - 1, Math.ceil(y1 / rc)); j++)
      for (let i = Math.max(0, Math.floor(x0 / rc)); i <= Math.min(W - 1, Math.ceil(x1 / rc)); i++) {
        const q: P = [(i + 0.5) * rc, (j + 0.5) * rc]
        if (pointInPoly(q, pa.poly) && !T.seaAt(q)) mask[j * W + i] = 1
      }
  })
  const rings = contours(mask, W, H, 0.5, true).map((r) => fromF32(simplify(r, 7 / rc)).map(([x, y]) => [(x + 0.5) * rc, (y + 0.5) * rc] as P))
  const loops: P[][] = []
  for (let simp of rings) {
    if (simp.length > 3 && dist(simp[0], simp[simp.length - 1]) < 1) simp.pop()
    if (simp.length < 3) continue
    const inside = ctx.cores.filter((c) => pointInPoly(c.c, simp))
    if (!inside.length) continue
    // 先把片区轮廓的锯齿磨成圆润的外廓；规整时再向矩形（方格）或圆形（放射）收拢；最后整理成一段段直墙。
    // 曲折度（wallBend）：0 是这圈平顺的外廓，1 贴着片区之间的街走（中心落在外廓里的片区合起来的外边界），中间按各方向的远近插值
    const target = morphWall(ctx, smoothLoop(simp), inside[0], inside.length > 1)
    const bend = ctx.p.wallBend ?? DEFAULT_SETTLEMENT.wallBend
    const along = bend > 0 ? patchOutline(patches, target, inside.map((c) => c.c)) : null
    const loop = along ? (bend >= 1 ? along : bendLoop(target, along, bend)) : target
    // 墙段的长短按修墙时的规模（不按现在的）：同一道墙在城市长大以后还是原来的样子
    loops.push(cleanLoop(loop, scaleOf(pop).size === 'city' ? 14 : 10))
  }
  return loops
}

/**
 * 一组片区（中心落在 target 里、陆地为主的，再填上四周都在里面的洞）合起来的外边界：
 * 各片区的边里，没有被另一块同组片区共用的就是外边界，首尾相接成环；取包含核心的那一环。
 */
function patchOutline(patches: Patch[], target: P[], cores: P[]): P[] | null {
  const inSet = patches.map((pa) => pa.land >= 0.45 && pointInPoly(pa.site, target))
  patches.forEach((pa, i) => {
    if (!inSet[i] && pa.land >= 0.45 && pa.nb.length && pa.nb.every((j) => inSet[j])) inSet[i] = true
  })
  const hit = outlines(patches.filter((_, i) => inSet[i]).map((pa) => pa.poly))
    .filter((l) => cores.some((c) => pointInPoly(c, l)))
    .sort((a, b) => area(b) - area(a))
  return hit[0] ? simplifyLoop(hit[0], 3) : null
}

/** 几块相邻多边形（Voronoi 片区，公共边的顶点重合）合起来的外轮廓：内部的公共边两两抵消 */
function outlines(polys: Poly[]): P[][] {
  const key = (q: P) => `${Math.round(q[0] * 2)},${Math.round(q[1] * 2)}`
  const edges = new Map<string, { a: P; b: P }>()
  for (const pl of polys) {
    const poly = signedArea(pl) > 0 ? pl : [...pl].reverse()
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]
      const b = poly[(k + 1) % poly.length]
      const ka = key(a)
      const kb = key(b)
      if (ka === kb) continue
      // 同一条边被两块同组片区以相反方向用到：内部边，抵消
      const rev = `${kb}|${ka}`
      if (edges.has(rev)) edges.delete(rev)
      else edges.set(`${ka}|${kb}`, { a, b })
    }
  }
  const next = new Map<string, { a: P; b: P }>()
  for (const [k, e] of edges) next.set(k.split('|')[0], e)
  const loops: P[][] = []
  const used = new Set<string>()
  for (const start of next.keys()) {
    if (used.has(start)) continue
    const loop: P[] = []
    for (let k: string | undefined = start; k && !used.has(k); ) {
      used.add(k)
      const e = next.get(k)
      if (!e) break
      loop.push(e.a)
      k = key(e.b)
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

/**
 * 两圈轮廓之间：从 a 的形心往外看，各方向取两圈最远交点的半径按 t 插值（0 是 a，1 是 b）。
 * 方向取得密（2 度一个），b 的折角大体保留
 */
function bendLoop(a: P[], b: P[], t: number): P[] {
  const c = centroid(a)
  const N = 180
  const far = (loop: P[], d: P) => {
    let r = 0
    for (let i = 0; i < loop.length; i++) {
      const hit = segIntersect(c, [c[0] + d[0] * 1e5, c[1] + d[1] * 1e5], loop[i], loop[(i + 1) % loop.length])
      if (hit && hit.u >= 0 && hit.u <= 1 && hit.t >= 0) r = Math.max(r, hit.t * 1e5)
    }
    return r
  }
  const out: P[] = []
  for (let k = 0; k < N; k++) {
    const ang = (k / N) * Math.PI * 2
    const d: P = [dmath.cos(ang), dmath.sin(ang)]
    const ra = far(a, d)
    const rb = far(b, d) || ra
    const r = ra + (rb - ra) * t
    out.push([c[0] + d[0] * r, c[1] + d[1] * r])
  }
  return simplifyLoop(out, 1.5)
}

/**
 * 城墙外廓：从轮廓的形心往外看，每个方向取轮廓最远的交点作半径，只留最平缓的几个起伏（傅里叶低通），
 * 再略放大到罩住绝大部分轮廓。于是城墙是一条圆润的曲线，折成约 50 米一段的直墙，不随片区边界凹凹凸凸。
 */
function smoothLoop(loop: P[]): P[] {
  const c = centroid(loop)
  const N = 144
  const rs: number[] = []
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2
    const d: P = [dmath.cos(a), dmath.sin(a)]
    let far = 0
    for (let i = 0; i < loop.length; i++) {
      const hit = segIntersect(c, [c[0] + d[0] * 1e5, c[1] + d[1] * 1e5], loop[i], loop[(i + 1) % loop.length])
      if (hit && hit.u >= 0 && hit.u <= 1 && hit.t >= 0) far = Math.max(far, hit.t * 1e5)
    }
    rs.push(far)
  }
  const K = 3
  const low = rs.map((_, j) => {
    let v = rs.reduce((a, b) => a + b, 0) / N
    for (let h = 1; h <= K; h++) {
      let ca = 0
      let sa = 0
      rs.forEach((r, k) => {
        const t = (k / N) * Math.PI * 2 * h
        ca += r * dmath.cos(t)
        sa += r * dmath.sin(t)
      })
      const t = (j / N) * Math.PI * 2 * h
      v += ((2 * ca) / N) * dmath.cos(t) + ((2 * sa) / N) * dmath.sin(t)
    }
    return Math.max(1, v)
  })
  // 放大到罩住约九成的方向（剩下的尖角留在墙外，是关厢）
  const ratios = rs.map((r, k) => r / low[k]).sort((a, b) => a - b)
  const f = Math.min(1.15, Math.max(1, ratios[Math.floor(N * 0.9)]))
  const mean = low.reduce((a, b) => a + b, 0) / N
  const n = Math.max(12, Math.round((Math.PI * 2 * mean * f) / 50))
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    const k = (i / n) * N
    const k0 = Math.floor(k) % N
    const r = (low[k0] * (1 - (k - Math.floor(k))) + low[(k0 + 1) % N] * (k - Math.floor(k))) * f
    return [c[0] + dmath.cos(a) * r, c[1] + dmath.sin(a) * r] as P
  })
}

/**
 * 历代城墙。每一道圈的是它规划能容纳的城区（生长顺序的前缀，按规划人口）：
 * - 最新的一道是城墙（城门、塔楼、瓮城；要塞是棱堡）。城市长出城墙后，先在城外沿路长出关厢，
 *   到下一代才修更大的新墙把它们圈进来；
 * - 刚被超过的上一道石墙留作内城墙（仍有城门）：任何时候最多两道完整的城墙（外城与内城）；
 * - 更早的拆掉，原址是一圈环城大道；紧挨着的那一代留几段残墙，再早的只剩路（木栅被取代后直接成路）。
 */
function buildWalls(ctx: Ctx, patches: Patch[], growth: Growth, stages: WallStage[], arterials: P[][]) {
  const sets = stages.map((st) => innerAt(ctx, patches, growth, st.cap, arterials))
  const size = (set: boolean[]) => set.filter(Boolean).length
  // 形制自带的城墙（里坊的方形外郭……）：按规划一次筑成，只有这一道
  const planned = stages.length ? ctx.plan?.def.wall?.(ctx, ctx.plan.z) : null
  // 形制不修城墙（返回空的轮廓，如城下町）
  if (planned && !planned.length) return
  // 最外一道石墙挖不挖护城河：形制说了算，否则看文明，要塞城都挖，别的城大多挖
  const moatFor = (st: WallStage) => st.kind === 'stone' && (ctx.plan?.def.moat ?? (CULTURE_INFO[ctx.p.culture].moat || ctx.p.function === 'fortress' || hashAt(ctx, ctx.center, 'wall.moat') < 0.65))
  if (planned) {
    const st = stages[stages.length - 1]
    const m = outMark(ctx)
    ctx.cityWalls.push(wallFromLoop(ctx, planned, st.kind, arterials, { barbicans: ctx.counts.barbican, moat: moatFor(st) }))
    stamp(ctx, m, st.pop)
  }
  // 城区没怎么长（地形逼仄）：和下一道几乎重合的旧墙不画
  const drawn = (k: number) => k === stages.length - 1 || size(sets[k]) < size(sets[k + 1]) * 0.85
  const loopsBy = planned ? [] : stages.map((st, k) => (drawn(k) ? wallLoops(ctx, patches, sets[k], st.pop) : []))
  // 旧墙（内城墙、残墙与环城路）只留在新墙里面的部分：跑到新墙外面、或贴着新墙的那段，修新墙时已经拆掉或并进了新墙
  const outerLoops = (loopsBy[stages.length - 1] ?? []).map((L) => [...L, L[0]])
  const within = (q: P) => outerLoops.some((L) => pointInPoly(q, L) && polylineDist(q, L) > 15)
  if (!planned) stages.forEach((st, k) => {
    const last = k === stages.length - 1
    if (!drawn(k)) return
    const age = stages.length - 1 - k
    // 上一道留作内城，或拆了筑环城大道、留几段残墙（见 CultureInfo.innerWall）
    const keep = last || (CULTURE_INFO[ctx.p.culture].innerWall && st.kind === 'stone' && age === 1)
    // 成长史：这道墙修起来的时刻（之前几道与它几乎重合、没单画的，就是它原地升级前的样子：从最早那道起就有），
    // 与被下一道取代（拆掉筑路、留残墙）的时刻
    let from = k
    while (from > 0 && !drawn(from - 1)) from--
    const built = stages[from].pop
    const next = stages[k + 1]?.pop ?? Infinity
    for (const loop of loopsBy[k]) {
      const m = outMark(ctx)
      if (!keep) {
        // 拆掉以前它是一道完整的城墙：另修一道只记在历史里（走廊留着：老墙原址后来是环城路与空地，不盖房子）
        wallFromLoop(ctx, loop, st.kind, arterials, { moat: moatFor(st) })
        for (const [key, n] of m.lens) {
          const a = ctx.out[key] as object[]
          for (const item of a.splice(n)) {
            ctx.history.life.set(item, { born: built, died: next })
            ctx.history.past.push({ key, item })
          }
        }
      }
      if (!keep) {
        // 拆墙筑路：环城大道沿旧墙内侧走；石墙还留下几段残墙（越早拆的留得越少）
        const stone = st.kind === 'stone'
        const ring = simplifyLoop(stone ? insetLoop(loop, 10) : loop, 6)
        for (const land of landPieces(ctx.T, [...ring, ring[0]])) {
          const line = resample(land, 4)
          const dry = dryMask(ctx, line, 40)
          for (const piece of splitBy(line, (q, i) => dry[i] && within(q))) ctx.out.roads.push({ line: piece, width: stone ? ctx.cfg.main : ctx.cfg.lane + 1, kind: stone ? 'main' : 'street', name: stone ? ctx.namer.street('main') : undefined })
        }
        if (stone && age <= 2) wallRemnant(ctx, loop, age === 1 ? 0.3 : 0.12, k, within)
        stamp(ctx, m, next)
        continue
      }
      const barbicans = last ? ctx.counts.barbican : 0
      // 护城河：最外一道石墙才有；东方的城、要塞都挖，西式约三分之二
      const moat = last && moatFor(st)
      if (ctx.p.function === 'fortress' && st.kind === 'stone' && last) {
        // 要塞：棱堡城墙 + 墙内一圈顺城环路
        const sc = ctx.cfg.patch / 96
        ctx.cityWalls.push(wallFromLoop(ctx, bastioned(loop, sc), st.kind, arterials, { bastions: true, barbicans, moat }))
        const ring = insetLoop(simplifyLoop(loop, 18 * sc), 16 * sc)
        for (const piece of landPieces(ctx.T, [...ring, ring[0]])) ctx.out.roads.push({ line: piece, width: ctx.cfg.lane + 1, kind: 'street' })
      } else {
        // 保留下来的内城墙：跑到新墙外面（或贴着新墙）的那段修新墙时已拆掉
        ctx.cityWalls.push(wallFromLoop(ctx, loop, st.kind, arterials, { barbicans, moat, keep: last ? undefined : within }))
      }
      stamp(ctx, m, built)
    }
  })
  // 墙变形后墙内新圈进来的陆上片区算城内（方城的四角不留空）；墙外已经长出来的关厢仍是城区
  const outer = ctx.cityWalls.map((w) => w.loop)
  for (const pa of patches.slice(ctx.cores.length)) {
    if (!pa.inner && pa.land >= 0.5 && (pa.planned || area(pa.poly) < ctx.cfg.patch * ctx.cfg.patch * 2.6) && outer.some((l) => pointInPoly(centroid(pa.poly), l))) pa.inner = true
  }
}

// —————————————————————— 城市形制 ——————————————————————

/**
 * 规划区：中心是城心，尺度按"规划强度 × 人口"需要的城区面积（形制可以再放大，规划常比当时的城区大）。
 * 村落没有规划。规划区的方格朝向也成为主城心的方格朝向（区外有机生长的街坊跟着对齐）。
 */
function setupPlan(ctx: Ctx): Ctx['plan'] {
  const id = ctx.p.plan ?? 'organic'
  // 形制跟着文明走：别的文明的形制（西方的城选了城下町）按有机生长
  if (id === 'organic' || isVillage(ctx.p.size) || !planFits(ctx.p.culture, id)) return undefined
  const def = PLANS[id]
  if (!def) return undefined
  const s = ctx.p.planStrength!
  const R = rinFor(ctx.p, Math.max(1500, planPopOf(ctx.p) * s)) * (def.scale ?? 1)
  const angle = def.angle?.(ctx) ?? ctx.cores[0].angle
  ctx.cores[0].angle = angle
  ctx.gridAngle = angle - Math.round(angle / (Math.PI / 2)) * (Math.PI / 2)
  const f = gridFrame({ c: ctx.center, angle })
  const base = { c: ctx.center, angle, toUV: f.toUV, fromUV: f.fromUV, R, shift: coastShift(ctx, f, R) }
  const poly = def.outline(ctx, base)
  const contains = (q: P) => pointInPoly(q, poly)
  // 形制里没有的要素：当作手动数量 0（片区选址按参数重新推算数量，也读得到）
  if (def.exclude?.length) {
    ctx.p = { ...ctx.p, counts: { ...ctx.p.counts, ...Object.fromEntries(def.exclude.map((id) => [id, 0])) } }
    for (const id of def.exclude) ctx.counts[id] = 0
  }
  // 落进规划区的副中心会打乱规划的街坊：规划区里只有一个中心
  ctx.cores = ctx.cores.filter((c, i) => i === 0 || !contains(c.c))
  ctx.layoutCores = ctx.layoutCores?.filter((c, i) => i === 0 || !contains(c.c))
  return { def, z: { ...base, poly, contains } }
}

/**
 * 临海时规划范围的偏移：沿八个方向（四条轴与四条对角线，探到方城的角 1.42 R）量城心到海岸的距离，
 * 海岸在某一侧的投影不到 R，就把范围往反方向挪出这个差额（每条轴最多 0.8 R，城心仍在范围里、靠海的一边）。
 */
function coastShift(ctx: Ctx, f: ReturnType<typeof gridFrame>, R: number): P {
  if (!ctx.T.coast) return [0, 0]
  const need = { u: [0, 0], v: [0, 0] }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    const du = Math.round(dmath.cos(a) * 1e6) / 1e6
    const dv = Math.round(dmath.sin(a) * 1e6) / 1e6
    const far = R * (k % 2 ? 1.42 : 1)
    let t = Infinity
    for (let s = 0; s < far; s += 10)
      if (ctx.T.seaAt(f.fromUV(du * s, dv * s))) {
        t = s
        break
      }
    if (!Number.isFinite(t)) continue
    // 海岸在各轴上的投影不到 R 的差额
    if (du) need.u[du > 0 ? 0 : 1] = Math.max(need.u[du > 0 ? 0 : 1], R - t * Math.abs(du))
    if (dv) need.v[dv > 0 ? 0 : 1] = Math.max(need.v[dv > 0 ? 0 : 1], R - t * Math.abs(dv))
  }
  const clamp = (x: number) => Math.max(-0.8 * R, Math.min(0.8 * R, x))
  return [clamp(need.u[1] - need.u[0]), clamp(need.v[1] - need.v[0])]
}

/**
 * 干道在规划区里改走规划的大街：按干道原本的出城方向，由形制给出从城心到规划区边上的一段（终点是城门），
 * 再从那里按地形接回原来的路线（离开规划区一段以后的那一点）。
 */
function planArterials(ctx: Ctx, arterials: P[][]) {
  const { def, z } = ctx.plan!
  const T = ctx.T
  // 出城路线（含出规划区后顺着大街直走的一段）有没有下海；过河不算（桥）
  const wet = (line: P[]) => resample(line, 4).some((q) => T.seaAt(q))
  const extend = (trunk: P[]): P[] => {
    const [p0, p1] = [trunk[trunk.length - 2], trunk[trunk.length - 1]]
    const L = dist(p0, p1) || 1
    return [...trunk, [p1[0] + ((p1[0] - p0[0]) / L) * 30, p1[1] + ((p1[1] - p0[1]) / L) * 30]]
  }
  // 接回原路线时绕开规划区（不斜穿规划好的街坊）
  const bias = (q: P) => (z.contains(q) ? 6 : 1)
  for (let a = 0; a < arterials.length; a++) {
    const raw = arterials[a]
    const k = raw.findIndex((q) => !z.contains(q))
    if (k < 0) continue
    const dir = dmath.atan2(raw[k][1] - z.c[1], raw[k][0] - z.c[0])
    // 形制按原方向给出城路线；下了海（城临海、规划区一角在海上）就依次换左、右、反方向的城门
    let trunk: P[] = []
    for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const t = def.exit(ctx, z, dir + turn)
      if (t.length < 2) continue
      const e = extend(t)
      if (!wet(e)) {
        trunk = e
        break
      }
    }
    // 哪个方向都下海：原方向的路截到入海之前
    if (!trunk.length) {
      const t = def.exit(ctx, z, dir)
      const pts = t.length > 1 ? resample(t, 4) : []
      const cut = pts.findIndex((q) => T.seaAt(q))
      trunk = cut < 0 ? pts : pts.slice(0, Math.max(0, cut - 2))
    }
    // 形制不给出城路线（或一出城就是海）：干道从规划区边上起算，不穿过规划区（不直穿城堡、宫城）
    if (trunk.length < 2) {
      arterials[a] = raw.slice(k)
      continue
    }
    const end = trunk[trunk.length - 1]
    let j = k
    while (j < raw.length - 1 && (z.contains(raw[j]) || dist(raw[j], raw[k]) < 90)) j++
    // 起终点落在同一个寻路格里时寻路给不出路线：直接连上
    const found = routeOnTerrain(T, end, raw[j], { water: 14, slope: 1, bias })
    const link = found.length < 2 ? [end, raw[j]] : smoothRoute(found, 4, T)
    arterials[a] = [...trunk, ...link.slice(1), ...raw.slice(j + 1)]
  }
}

/** 城心片区是什么：按规模与功效（魔法城是主塔，商贸城是大市场），数量从对应要素里扣 */
function centerType(ctx: Ctx): WardType {
  const { p, counts } = ctx
  if (isVillage(p.size)) return 'park'
  const take = (id: FeatureId, t: WardType) => {
    counts[id]--
    return t
  }
  if (p.function === 'magic' && counts.magic > 0) return take('magic', 'magic')
  if (p.function === 'trade' && counts.market > 0) return take('market', 'market')
  return 'plaza'
}

function assignWards(ctx: Ctx, patches: Patch[], growth: Growth) {
  const { p, T } = ctx
  const small = isVillage(p.size)
  patches[0].type = centerType(ctx)
  // 副中心：各有一处广场；商贸城轮流是市集（数量从对应要素里扣）
  ctx.cores.slice(1).forEach((_, k) => {
    const pa = patches[k + 1]
    if (ctx.p.function === 'trade' && k % 2 === 0 && ctx.counts.market > 0) {
      ctx.counts.market--
      pa.type = 'market'
    } else {
      if (ctx.counts.plaza > 0) ctx.counts.plaza--
      pa.type = 'plaza'
    }
  })
  // 形制预定的功能（宫城、东西市、广场……）；其余的交给通用选址
  const plan = ctx.plan
  if (plan?.def.assign) {
    const ids = patches.map((_, i) => i).filter((i) => patches[i].planned)
    const planLots: PlanLot[] = ids.map((i) => ({ poly: patches[i].poly, site: patches[i].site, uv: plan.z.toUV(patches[i].site), type: patches[i].type, inner: patches[i].inner }))
    plan.def.assign(ctx, plan.z, planLots)
    // 形制点名要有的片区（宫城、东西市……）即使城还没长到那里也建起来
    ids.forEach((i, k) => {
      if (!planLots[k].type || planLots[k].type === patches[i].type) return
      patches[i].type = planLots[k].type
      patches[i].inner = true
    })
    // 形制合成的宫城（里坊都城居中的几坊）：以第一块为主片区
    const pal = ids.filter((_, k) => planLots[k].palace)
    for (const i of pal) patches[i].palace = pal[0]
  }
  // 城内片区交给通用选址（城心是第 0 个候选）
  const idx = patches.map((_, i) => i).filter((i) => patches[i].inner)
  const pos = new Map(idx.map((i, k) => [i, k]))
  // 生长历史：每块地加入城区时的人口（洞按四周都加入的时刻，见 Growth.joinPop）；
  // 城墙圈进来、生长还没轮到的空地算作还没加入，不放要素
  const when = (i: number) => growth.joinPop.get(i) ?? Infinity
  const lots: Lot[] = idx.map((i) => ({
    poly: patches[i].poly,
    site: patches[i].site,
    nb: patches[i].nb.filter((j) => pos.has(j)).map((j) => pos.get(j)!),
    deg: patches[i].nb.length,
    joinedAt: when(i),
    type: patches[i].type,
  }))
  // 累计户数 → 那时的人口
  zoneLots(ctx, lots, pos.get(0) ?? -1, (pop) => pop)
  lots.forEach((l, k) => {
    patches[idx[k]].type = l.type
    if (l.palace !== undefined) patches[idx[k]].palace = idx[l.palace]
    if (l.grand) patches[idx[k]].grand = true
    patches[idx[k]].foundPop = l.foundPop
  })
  // 城外
  const veg = vegetation(ctx)
  for (let i = 0; i < patches.length; i++) {
    const pa = patches[i]
    if (pa.inner) continue
    if (pa.land < 0.35) {
      pa.type = 'water'
      continue
    }
    // 离最近的核心：卫星城周围也有城郊与农田
    const d = centerDist(ctx, pa.site)
    const g = ctx.corridors.gap(pa.site)
    const nearTown = d < ctx.Rin * (small ? 1.8 : 2.1)
    if (!small && nearTown && g < spacing(ctx, pa.site) * 0.75 && T.slopeAt(pa.site) < 0.25) pa.type = 'suburb'
    // 缓坡也算农地（farm 里按坡度改作牧场），陡坡留作野地
    // 农田范围（farmland 0 ~ 1）：0 只在城边一圈，1 一直铺到很远；其余是草地、林地
    else if (p.farms && veg.farm && T.slopeAt(pa.site) < 0.2 && d < ctx.Rin * (1.3 + (small ? 4.5 : 3.2) * p.farmland) * (0.8 + hashAt(ctx, pa.site, 'ward.farm') * 0.5)) pa.type = 'farm'
    else pa.type = 'wild'
  }
}

function layoutOrganic(ctx: Ctx, arterials: P[][], stages: WallStage[]) {
  const { p, T, cfg } = ctx
  // 规整度带来的街道：方格直街与环形 / 辐条街按放射度混合；片区沿它们两侧布点，街坊随之对齐
  // 每个核心各有一套，只留离它最近的那部分
  const plan = ctx.plan
  // 都城的宫城（没有形制时；形制有自己的宫城、城堡）：布局之初就在城心旁划出一块，不布街巷
  const pz = p.capital && !plan && p.size !== 'hamlet' && p.size !== 'village' ? palaceZone(ctx, arterials) : null
  const reserved = (q: P) => !!plan?.z.contains(q) || !!pz?.keepOut(q)
  const streets = (p.size === 'hamlet' ? [] : (ctx.layoutCores ?? ctx.cores).flatMap((c, i) => [...latticeStreets(ctx, c, i), ...radialStreets(ctx, c, i)])).filter((l) => !l.some(reserved))
  // 片区沿干道成对布点（路落在片区边界上）只用最早的两条干道：任何规模都有这两条。
  // 人口多了才开的干道不再改动片区剖分，直接穿过已有的街坊（像后来新修的路），老城的片区才不会整片重排
  // 规划区：形制给的固定站点切出方正的街坊，区里不再随机布点（落水的、与核心重合的站点丢掉）
  const planSites = plan ? plan.def.sites(ctx, plan.z).filter((q) => T.waterAt(q) > 3 && ctx.cores.every((c) => dist(c.c, q) > 1)) : []
  const patches = buildPatches(ctx, [...arterials.slice(0, 2), ...streets], plan || pz ? reserved : undefined, [...planSites, ...(pz?.sites ?? [])])
  if (plan) {
    for (let k = 0; k < planSites.length; k++) patches[ctx.cores.length + k].planned = true
    if (plan.z.contains(ctx.cores[0].c)) patches[0].planned = true
  }
  // 宫城的几块片区：一开始就是城区里的宫城（主片区是第一块）
  if (pz) {
    const first = ctx.cores.length + planSites.length
    for (let k = 0; k < pz.sites.length; k++) {
      patches[first + k].palace = first
      patches[first + k].type = 'castle'
    }
  }
  const growth = growInner(ctx, patches, stages.at(-1)?.cap ?? 0, arterials)
  if (stages.length) buildWalls(ctx, patches, growth, stages, arterials)
  else ctx.plan?.def.facade?.(ctx, ctx.plan.z)
  // —— 道路 ——
  // 城内：落在城区片区里，或在城墙之内（墙外的关厢也是城区）；不按随人口变化的半径，老街的路宽才不会跟着变
  const innerPolys = patches.filter((pa) => pa.inner).map((pa) => pa.poly)
  const inside = (q: P) => innerPolys.some((poly) => pointInPoly(q, poly)) || (ctx.cityWalls.length > 0 && inCity(ctx, q))
  arterials.forEach((road) => {
    // 过水段先整条理顺（直线过桥、顺河的截掉，见 fixWet），再分城内段（主街）、城外段（大路）：
    // 分界落在过水段上时挪到上岸处，桥整座归城内段，不会两头各自止于水中
    const inners: P[][] = []
    const outers: P[][] = []
    for (const r of fixWet({ line: road, width: cfg.highway, kind: 'highway' }, T)) {
      const line = r.line
      let k = line.findIndex((q) => !inside(q))
      if (k < 0) k = line.length
      // 整理过的线是 2 米一点（没过水的原样返回，不必挪）
      if (r.line !== road) for (const [s, e] of wetRuns(line, T)) if (k >= s && k < e) k = e
      inners.push(line.slice(0, Math.min(line.length, k + 1)))
      outers.push(line.slice(Math.max(0, k)))
    }
    const small = isVillage(p.size)
    const main = inners.filter((l) => l.length > 1)
    // 路名给城内最长的一段（每条干道只取一次名）
    const name = main.length && p.size !== 'hamlet' ? ctx.namer.street(small ? 'street' : 'main') : undefined
    const longest = main.reduce<P[] | null>((a, l) => (!a || polylineLength(l) > polylineLength(a) ? l : a), null)
    for (const line of main) ctx.out.roads.push({ line, width: ctx.plan?.def.mainWidth ?? cfg.main, kind: 'main', name: line === longest ? name : undefined })
    for (const line of outers) if (line.length > 1) ctx.out.roads.push({ line, width: cfg.highway, kind: 'highway' })
  })
  // 规划的街道（大街、坊间街……）
  if (plan)
    for (const r of plan.def.streets(ctx, plan.z))
      for (const piece of landPieces(T, r.line))
        if (piece.length > 1) ctx.out.roads.push({ line: piece, width: r.width, kind: r.kind, name: r.named ? ctx.namer.street(r.kind === 'main' ? 'main' : 'street') : undefined })
  // 村落：片区之间的边就是巷道，但只修需要的：从干道出发往外长，每个片区接上一条，再补几条成环
  // 方格直街只保留城内（墙内）的段
  for (const st of streets) if (inside(st[0]) && inside(st[st.length - 1])) ctx.out.roads.push({ line: st, width: cfg.lane + 1, kind: 'street' })
  extraBridges(ctx, inside)
  // 栈桥与通往栈桥的小路要在盖房之前定下，房子才会让开
  if (p.coast && (isVillage(p.size))) jetties(ctx)
  // 各自生成的道路并成一张路网：去掉平行重叠的段、断头接到已有道路上、同一处只架一座桥
  ctx.out.roads = tidyRoads(ctx.out.roads, T)
  for (const r of ctx.out.roads) roadCorridor(ctx, r)
  if (T.river) ctx.corridors.add(T.river.line, 0, 'river')

  // —— 片区 ——
  assignWards(ctx, patches, growth)
  settleDensity(ctx, patches, growth, arterials)
  const veg = vegetation(ctx)
  const small = isVillage(p.size)
  const baseRng = ctx.rng
  const layoutD = layoutDistances(ctx, patches)
  // 村巷：通往加入城区时还是零散农家的片区（城长大以后这些巷子还在；什么时候修见 stampRoads）
  const joinedR = joinedRadius(patches, growth)
  const lanesFor = (i: number) => {
    const J = growth.joinPop.get(i)
    return J !== undefined && patches[i].inner && wardTown(ctx, patches[i].site, J, joinedR(J)) === 0
  }
  {
    const old = new Set(ctx.out.roads)
    villageLanes(ctx, patches, arterials, lanesFor)
    // 新修的巷子也并进路网（与干道重叠的段落去掉），只给新增的段登记走廊
    ctx.out.roads = tidyRoads(ctx.out.roads, T)
    for (const r of ctx.out.roads) if (!old.has(r)) roadCorridor(ctx, r)
  }
  // 路网定了（最后一次整理之后）再架桥
  crossings(ctx)
  // 先把城内（墙内）的片区由近到远盖满，再盖城郊与田间：民居预算用完时，
  // 少掉的是城外零散的房子，而不是墙根下留出一圈空地
  // 城外的村庄（农户聚居在村里，每天出村种田）
  const villages = pickVillages(ctx, patches)
  const fields = farmGroups(ctx, patches, (i) => patches[i].type === 'farm' && !patches[i].inner && !villages.centers.has(i) && !villages.members.has(i))
  // 都城的宫城先定好地盘（主片区下标 → 盖宫殿的矩形）：同一座宫城的几块片区谁先轮到都知道宫城合没合成
  const palaces = new Map<number, Poly>()
  patches.forEach((pa, i) => {
    const site = pa.palace === i ? palaceSite(ctx, patches, i, !pa.grand) : null
    if (site) palaces.set(i, site)
  })
  const wards: Ward[] = patches.map((pa) => ({ poly: pa.poly, type: pa.type ?? 'wild', inner: pa.inner, density: pa.inner ? pa.density : undefined, ...(pa.grand ? { tier: 'grand' as const } : {}) }))
  // 城区按加入城区的先后盖（填洞、城墙圈进来的排在相邻片区里最晚加入的之后）：民居预算用完时截掉的总是最新辟的片区，
  // 城市长大时多出的预算也只落在新片区上——按远近排的话，新加入却离得近的片区会抢走预算，外围老片区的房子整片消失。
  // 城外（城郊、田间）按布局距离，与占用率同一套：截掉的是布局意义上最外围的
  const joined = new Map(growth.order.map((i, k) => [i, k]))
  const joinRank = (i: number) => joined.get(i) ?? Math.max(0, ...patches[i].nb.map((j) => joined.get(j) ?? 0)) + 0.5
  const order = patches.map((pa, i) => [pa.inner ? joinRank(i) : 1e6 + layoutD[i], i] as const).sort((a, b) => a[0] - b[0])
  const S: WardStage = { patches, wards, growth, fields, villages, palaces, veg, small }
  // 各片区按形态时间线盖、按人口调度（见 historyWards）；水面、画面外多铺的一圈城外片区不盖
  const walk = order.map(([, i]) => i).filter((i) => wards[i].type !== 'water' && !(patches[i].poly.every((v) => v[0] < 0 || v[1] < 0 || v[0] > ctx.MW || v[1] > ctx.MH) && !patches[i].inner))
  const opened = historyWards(ctx, S, walk, arterials)
  joinRoadEnds(ctx)
  // 路等沿线的地真有人住了（片区开张）才修
  stampRoads(ctx, patches, (i) => opened.get(i) ?? Infinity)
  ctx.tier = 'standard'
  ctx.rng = baseRng
  ctx.wardPop = undefined
  ctx.wardTown = true
  ctx.wardQuota = Infinity
  ctx.wardFill = 1
  ctx.wardDensity = 'mid'
  ctx.wardType = 'common'
  // 城堡、宫城、卫城的门在各自盖好时就接上了路（见 walls.ts 的 connectGates）
  if (ctx.plan?.def.avenueTrees !== false) avenueTrees(ctx)
  nameDistricts(ctx)
}

/** 盖片区要用的整城信息（布局阶段定下的） */
interface WardStage {
  patches: Patch[]
  wards: Ward[]
  growth: Growth
  /** 并成一片的农田 */
  fields: Map<number, FarmGroup>
  villages: { centers: Set<number>; members: Set<number> }
  /** 都城宫城的地盘（主片区下标 → 盖宫殿的矩形） */
  palaces: Map<number, Poly>
  veg: ReturnType<typeof vegetation>
  /** 村落级（档位） */
  small: boolean
}

/** 片区去掉四周街巷、田埂以后的可盖范围（按 ctx.wardTown：街坊四周都是街巷） */
function wardBlock(ctx: Ctx, S: WardStage, i: number): Poly | null {
  const pa = S.patches[i]
  const rng = ctx.rng
  // 街巷宽按片区加入城区时（填洞、城墙圈进来的按相邻片区里最宽的）
  const laneW = S.growth.lanes.get(i) ?? Math.max(0, ...pa.nb.map((j) => S.growth.lanes.get(j) ?? 0))
  const lane = pa.inner ? (laneW || ctx.cfg.lane) / 2 + rng.next() * 0.8 : 2
  // 街坊四周都是街巷；零散农家、城外的田地与城郊，片区边界大多不是路：只有真修了路的边才让出路面，
  // 其余只留一道细缝（田埂、篱笆）。并成一片的农田之间也只是一道田埂
  const group = S.fields.get(i)
  const insets = pa.poly.map((v, k) => {
    const d = lane * (0.8 + rng.next() * 0.4)
    const w = pa.poly[(k + 1) % pa.poly.length]
    const mid: P = [(v[0] + w[0]) / 2, (v[1] + w[1]) / 2]
    const mate = group?.seams.some(([a, b]) => segDist(mid, a, b).d < 0.5)
    if (ctx.wardTown && !mate) return d
    return ctx.corridors.hits(mid, 0.5) ? d : mate ? 0 : 0.6
  })
  const block = insetConvex(pa.poly, insets)
  return block.length < 3 ? null : block
}

/**
 * 按片区的类型盖一块片区（ctx 的随机数流、密度档、街坊 / 农家等已由调用方设好，见 historyWards 的 buildForm）。
 * 路边的祠、神龛（wardExtras）另按时间安排
 */
function buildWardForm(ctx: Ctx, S: WardStage, i: number, ward: Ward, block: Poly) {
  const { p } = ctx
  const plan = ctx.plan
  const pa = S.patches[i]
  const type = ward.type
  if (pa.inner) {
    const b = clipWater(ctx, block, 1.5)
    if (b) ctx.out.blocks.push(b)
  }
  // 都城的宫城：几块片区合起来，轮到主片区时一次盖好（宫殿占其中最大的矩形，其余是御苑），别的几块跳过
  if (pa.palace !== undefined) {
    if (pa.palace !== i) {
      // 宫城没能合成一片（主片区照原样盖宫殿）：这几块是御苑
      if (!S.palaces.has(pa.palace)) FEATURE.park.build!(ctx, ward, block, ctx.env)
      return
    }
    block = S.palaces.get(i) ?? block
  }
  // 合成的大地标：按 grand 档盖（大社、朝圣大教堂、大园囿、同心城）
  ctx.tier = pa.grand && pa.palace === i && S.palaces.has(i) ? 'grand' : 'standard'
  // 规划片区的专属填法（坊墙、十字街……）
  if (pa.planned && pa.inner && plan?.def.build?.(ctx, ward, block, plan.z)) return
  // 其余按文明自己的样式盖（和风的町家、伊斯兰的内院住宅……），没有的用通用填法
  const styled = () => !!ctx.style.buildWard?.(ctx, ward, block)
  // 都城的宫殿：殿宇、厢房都不是民居（不占住户名额、不算人口），名额用完也照样盖
  const royal = type === 'castle' && !!p.capital
  if (royal) ctx.uncounted = true
  switch (type) {
    case 'plaza':
      if (!styled()) plaza(ctx, ward, block)
      break
    case 'park':
      if (S.small) villageGreen(ctx, block)
      else if (!styled()) FEATURE.park.build!(ctx, ward, block, ctx.env)
      break
    case 'suburb': {
      if (!styled()) urban(ctx, block, 'suburb', [], 26)
      break
    }
    case 'farm':
      if (S.villages.centers.has(i) || S.villages.members.has(i)) {
        // 城外的村子：村中是公地与水井，周围几块地是村舍；村民不算城里的人口
        ctx.uncounted = true
        if (S.villages.centers.has(i)) {
          villageGreen(ctx, block)
          ward.name ??= ctx.namer.town('village', false, false)
        } else {
          urban(ctx, block, 'village', [])
        }
        ctx.uncounted = false
      } else farm(ctx, block, S.veg, S.fields.get(i))
      break
    case 'wild':
      wild(ctx, block, S.veg)
      break
    default:
      // 文明有自己的盖法先用它；否则商贸城的城心是摊位更多的大市场
      if (!styled()) {
        if (i === 0 && type === 'market') plaza(ctx, ward, block, 2.5)
        else (FEATURE[type as FeatureId] ?? FEATURE.common).build!(ctx, ward, block, ctx.env)
      }
  }
  if (royal) ctx.uncounted = false
}

/**
 * 路的端头差几米没接上别的路（布路时各自让开了房子、街坊的边、路口）：顺着来的方向延长到最近那条路的中心线上。
 * 只接 JOIN_GAP 米以内、不往回拐的；延长的一段压到房子、水面或城墙就不接。
 * 布完片区（按时间切段之前）接一遍，之后加的路（城门街……）在最后再接一遍
 */
const JOIN_GAP = 8
function joinRoadEnds(ctx: Ctx) {
  const clear = (a: P, b: P) => {
    const n = Math.ceil(dist(a, b))
    for (let k = 1; k <= n; k++) {
      const q = lerpP(a, b, k / n)
      if (ctx.occ.hitsPoint(q, 0) || ctx.T.waterAt(q) < 1 || ctx.corridors.hits(q, 0, ['wall'])) return false
    }
    return true
  }
  for (const r of ctx.out.roads) {
    if (r.kind === 'stair' || r.line.length < 2) continue
    for (const head of [true, false]) {
      const e = head ? r.line[0] : r.line[r.line.length - 1]
      const prev = head ? r.line[1] : r.line[r.line.length - 2]
      // 最近的别的路：净距不到 0.3 米就是接上了
      const hit = nearestRoad(ctx, e, JOIN_GAP, (o) => o !== r && o.kind !== 'stair')
      if (!hit || hit.gap < 0.3) continue
      const best = hit.p
      // 不往回拐：延长的方向与路来的方向夹角不到 120°（再大就拐出一个钩）
      const ux = e[0] - prev[0]
      const uy = e[1] - prev[1]
      const vx = best[0] - e[0]
      const vy = best[1] - e[1]
      if (ux * vx + uy * vy < -0.5 * dmath.hypot(ux, uy) * dmath.hypot(vx, vy)) continue
      if (!clear(e, best)) continue
      if (head) r.line.unshift(best)
      else r.line.push(best)
    }
  }
}

/**
 * 成长史：路网定下以后给路定生卒（城墙那里修的环城路、城门街已经定过）：
 * - 城外的大路：它那条干道开通时；
 * - 城内的主街：沿路的地并进城区时（最早的那处）才是主街，在那之前这段是干道开通时就有的大路；
 * - 街巷：沿路的地大多并进城区时（取中位数）。
 * 沿路的地按最近的片区站点算（Voronoi：落在谁的片区里就离谁的站点最近，片区边上的巷子取两边早的那块）
 */
function stampRoads(ctx: Ctx, patches: Patch[], openAt: (i: number) => number) {
  const h = ctx.history
  const G = 60
  const grid = new Map<string, number[]>()
  patches.forEach((pa, i) => {
    const k = `${Math.floor(pa.site[0] / G)},${Math.floor(pa.site[1] / G)}`
    ;(grid.get(k) ?? grid.set(k, []).get(k)!).push(i)
  })
  const joinAt = (q: P) => {
    const cx = Math.floor(q[0] / G)
    const cy = Math.floor(q[1] / G)
    let best = -1
    let bd = Infinity
    let second = -1
    let sd = Infinity
    for (let r = 1; r <= 4 && (best < 0 || r <= 2); r++)
      for (let y = cy - r; y <= cy + r; y++)
        for (let x = cx - r; x <= cx + r; x++)
          for (const i of grid.get(`${x},${y}`) ?? []) {
            const d = dist(patches[i].site, q)
            if (d < bd) {
              second = best
              sd = bd
              best = i
              bd = d
            } else if (d < sd && i !== best) {
              second = i
              sd = d
            }
          }
    const jp = (i: number) => (i >= 0 ? openAt(i) : Infinity)
    // 片区边上（到两个站点差不多远）：两边早的那块
    return second >= 0 && sd - bd < 2 ? Math.min(jp(best), jp(second)) : jp(best)
  }
  const sourceBorn = (line: P[]) => {
    const mid = line[Math.floor(line.length / 2)]
    let b = Infinity
    for (const s of h.sources) if (polylineDist(mid, s.line) < 6) b = Math.min(b, s.born)
    return b
  }
  const add: Road[] = []
  const keep: Road[] = []
  const P = ctx.p.population
  // 路宽随那时的规模（村里的巷子窄，城大了大路、主街一档档拓宽）：每档一段，前一档拆了后一档接上。
  // 房子一直按最宽时的路让开（走廊按现在的路宽登记），拓宽不会切到房子
  const trade = ctx.p.function === 'trade'
  const widthAt = (kind: Road['kind'], t: number, w0: number) => {
    const c = scaleOf(Math.max(30, t)).cfg
    if (kind === 'highway') return Math.min(w0, Math.round(c.highway * (trade ? 1.25 : 1) * 2) / 2)
    if (kind === 'main') return ctx.plan?.def.mainWidth ?? Math.min(w0, Math.round(c.main * (trade ? 1.6 : 1) * 2) / 2)
    if (kind === 'street') return Math.min(w0, c.lane + 1)
    return Math.min(w0, c.lane)
  }
  const emit = (r: Road, born: number, died = Infinity) => {
    const phases: { t: number; w: number }[] = []
    for (let t = born; t < Math.min(died, P * 1.0001); t = Math.max(t * 1.04, t + 1)) {
      const w = widthAt(r.kind, t, r.width)
      if (!phases.length || phases.at(-1)!.w !== w) phases.push({ t, w })
    }
    if (!phases.length) phases.push({ t: born, w: r.width })
    phases.forEach((ph, k) => {
      const road: Road = k === phases.length - 1 && ph.w === r.width ? r : { ...r, width: ph.w, name: k === phases.length - 1 ? r.name : undefined }
      const until = phases[k + 1]?.t ?? died
      h.life.set(road, { born: ph.t, died: until })
      // 现在（人口 P 时）还在的进最终状态，别的只在历史里
      if (ph.t <= P && P < until) keep.push(road)
      else add.push(road)
    })
  }
  // 路按沿线逐段：一段路在它两头的地都并进城区时才修（主街在那之前若是干道，先是大路）
  const pieces = (r: Road) => {
    const line = resample(r.line, 10)
    const at = line.map(joinAt)
    // 两头是路口（常伸进别的路里，见 joinRoadEnds）：跟着这条路本身，不按路口那边的地
    if (at.length > 2) {
      at[0] = at[1]
      at[at.length - 1] = at[at.length - 2]
    }
    const out: { line: P[]; born: number }[] = []
    for (let k = 0; k + 1 < line.length; k++) {
      const b = Math.max(at[k], at[k + 1])
      const last = out.at(-1)
      // 相近的时刻（差不到一成）并成一段
      if (last && (last.born === b || (Number.isFinite(b) && Number.isFinite(last.born) && Math.max(b, last.born) / Math.min(b, last.born) < 1.1))) {
        last.line.push(line[k + 1])
        last.born = Math.max(last.born, b)
      } else out.push({ line: [line[k], line[k + 1]], born: b })
    }
    return out
  }
  for (const r of ctx.out.roads) {
    if (h.life.has(r)) {
      keep.push(r)
      continue
    }
    const src = sourceBorn(r.line)
    if (r.kind === 'highway') {
      const js = resample(r.line, 12).map(joinAt).filter(Number.isFinite)
      emit(r, Number.isFinite(src) ? src : js.length ? Math.min(...js) : 0)
      continue
    }
    if (r.kind !== 'main' && r.kind !== 'street' && r.kind !== 'lane') {
      h.life.set(r, { born: Number.isFinite(src) ? src : 0, died: Infinity })
      keep.push(r)
      continue
    }
    pieces(r).forEach((pc, k) => {
      const born = r.kind === 'main' && Number.isFinite(src) ? Math.max(src, pc.born) : pc.born
      // 还没修的段（沿线的地到现在也没并进城区）不要
      if (!Number.isFinite(born)) return
      emit({ ...r, line: pc.line, name: k === 0 ? r.name : undefined }, born)
      // 成主街之前是干道开通时就有的大路
      if (r.kind === 'main' && Number.isFinite(src) && src < born) emit({ line: pc.line, width: ctx.cfg.highway, kind: 'highway' }, src, born)
    })
  }
  ctx.out.roads = keep
  for (const r of add) h.past.push({ key: 'roads', item: r })
  // 桥、渡口：随它压着的路
  for (const c of ctx.out.crossings) {
    if (h.life.has(c)) continue
    const m: P = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]
    let born = 0
    let bd = Infinity
    for (const r of ctx.out.roads) {
      const d = polylineDist(m, r.line)
      if (d < bd) {
        bd = d
        born = h.life.get(r)?.born ?? 0
      }
    }
    h.life.set(c, { born, died: Infinity })
  }
}

/** 成长史里一个形态的设定（见 historyWards） */
interface FormSpec {
  start: number
  type: WardType
  inner: boolean
  whole: boolean
  rebuild: boolean
  town: boolean
  tier: Density
}
const TIER_RANK: Record<Density, number> = { low: 0, mid: 1, high: 2 }
/** 住人的片区类型（按户入住）；别的特殊片区整片一次建成 */
const LIVED_TYPES = new Set<WardType>(['common', 'merchant', 'craft', 'slum', 'noble'])
/** 翻建时新一档的房子在开始后多久里陆续可以盖（按开始时人口的比例） */
const REBUILD_SPAN = 0.6
/** 新辟的街坊里各户入住的先后错开多少（按加入时人口的比例） */
const JOIN_SPREAD = 0.5

/**
 * 成长史里的片区（代替单次生成的片区循环）：
 * 1. 各片区的形态时间线：加入城区前是田野或荒地；加入后是民居，零散农家 → 疏 → 中 → 密（随街坊占比、密度档升级，只升不降），
 *    定下功能（zoneLots 的 foundPop）后是那种片区；城外的片区从头到尾是一个样（城郊在城镇够大后才辟）；
 * 2. 每个形态按它开始那一刻的规模盖满一套（在检查点里盖，截下来再撤回）；
 * 3. 调度（见 history.ts 的 schedule）定各样东西的生卒；最终状态（现在人口时还在的）写回 ctx.out，
 *    别的记进 ctx.history.past。路边的祠、神龛按片区住到七成的时刻撒
 */
function historyWards(ctx: Ctx, S: WardStage, walk: number[], arterials: P[][]): Map<number, number> {
  const { p } = ctx
  const h = ctx.history
  const P = p.population
  const grid: number[] = []
  for (let t = 30; t < P; t *= 1.08) grid.push(t)
  grid.push(P)
  // 各时刻各片区的密度档（容量模型按那时的人口）
  const dens = grid.map((t) => {
    const m = capacityModel(ctx, S.patches, arterials, t)
    const a: Density[] = []
    for (const i of S.growth.order) a[i] = m.add(i).d
    return a
  })
  const densAt = (i: number, t: number) => {
    const j = grid.findIndex((g) => g >= t)
    return dens[j < 0 ? grid.length - 1 : j][i] ?? 'low'
  }
  const byType = (type: WardType, d: Density): Density => (type === 'noble' ? 'low' : type === 'slum' ? 'high' : type === 'market' && d === 'low' ? 'mid' : d)
  // 城外的地：种得了田就是田，否则是荒地（与 assignWards 同一条规则，按现在的城区半径）
  // 农田随城区向外开垦：离城心在"城区半径 × 系数"以内的地才种（与 assignWards 同一条规则，半径取那时的城区）。
  // 小村时只有村边一圈田，城大了田才铺得远；开垦之前是荒地
  const farmStart = (pa: Patch): number | undefined => {
    if (!p.farms || !S.veg.farm || ctx.T.slopeAt(pa.site) >= 0.2) return undefined
    const d = centerDist(ctx, pa.site)
    const k = 0.8 + hashAt(ctx, pa.site, 'ward.farm') * 0.5
    return grid.find((t) => d < joinedR(t) * (1.3 + (isVillage(scaleOf(t).size) ? 4.5 : 3.2) * p.farmland) * k)
  }
  const nCores = ctx.cores.length
  const joinedR = joinedRadius(S.patches, S.growth)
  const foundOf = (i: number, J: number) => S.patches[i].foundPop ?? (i === 0 ? 0 : i < nCores ? subBirth(p, i - 1, nCores - 1) : J)
  const specsOf = (i: number): FormSpec[] => {
    const pa = S.patches[i]
    const T = S.wards[i].type
    const J = pa.inner ? S.growth.joinPop.get(i) : undefined
    // 加入城区（或现在）之前：先是荒地，开垦以后是田
    const wildSpec: FormSpec = { start: 0, type: 'wild', inner: false, whole: true, rebuild: false, town: false, tier: 'low' }
    const tf = farmStart(pa)
    const preOf = (until: number): FormSpec[] => (tf !== undefined && tf < until ? [wildSpec, { ...wildSpec, start: tf, type: 'farm' }] : [wildSpec])
    if (J === undefined) {
      // 城外，或城墙圈进来、生长还没轮到的空地
      if (T === 'suburb') {
        const d = centerDist(ctx, pa.site)
        const ts = grid.find((t) => t >= 1500 && d < rinFor(p, t) * 2.1) ?? P
        return [...preOf(ts), { start: ts, type: 'suburb', inner: false, whole: false, rebuild: false, town: false, tier: 'low' }]
      }
      // 城外的田：开垦之前是荒地（村子、荒地从头就是那样）
      if (!pa.inner && T === 'farm' && !S.villages.centers.has(i) && !S.villages.members.has(i)) return tf !== undefined && tf > 0 ? [wildSpec, { ...wildSpec, start: tf, type: 'farm' }] : [{ ...wildSpec, type: 'farm' }]
      return pa.inner ? preOf(P) : [{ ...wildSpec, type: T }]
    }
    const out: FormSpec[] = i < nCores ? [] : preOf(J)
    const F = foundOf(i, J)
    const lived = LIVED_TYPES.has(T)
    const end = lived ? P : F
    // 民居：加入时起，每个取样时刻看它是不是街坊、什么密度档，变了就翻建成新的一档
    let last: FormSpec | null = null
    for (const t of [J, ...grid.filter((g) => g > J && g <= end)]) {
      if (t >= end && !lived) break
      const kind: WardType = lived && t >= F ? T : 'common'
      const town = (last?.town ?? false) || wardTown(ctx, pa.site, t, joinedR(t)) > 0
      let tier = byType(kind, densAt(i, t))
      if (last && last.type === kind && TIER_RANK[last.tier] > TIER_RANK[tier]) tier = last.tier
      // 零散的农家不分密度档（盖法一样），成了街坊以后密度档变了才翻建
      if (last && last.type === kind && last.town === town && (last.tier === tier || !town)) continue
      const spec: FormSpec = { start: t, type: kind, inner: true, whole: false, rebuild: !!last, town, tier }
      out.push(spec)
      last = spec
    }
    if (!lived) out.push({ start: Math.max(F, J), type: T, inner: true, whole: true, rebuild: false, town: true, tier: byType(T, densAt(i, Math.max(F, J))) })
    return out
  }
  // 田野、荒地只让开一开始就有的东西（干道与河）：将来的城墙、街巷那时还没有，不预先留出一道缝
  const early = new Corridors()
  for (const src of h.sources) early.add(src.line, ctx.cfg.highway / 2 + 1.5, 'road')
  if (ctx.T.river) early.add(ctx.T.river.line, 0, 'river')
  // 按设定盖一套：规模取开始那一刻的（城外的田野、荒地按现在的）
  const p0 = ctx.p
  const Rin0 = ctx.Rin
  const small0 = S.small
  const buildForm = (i: number, sp: FormSpec): Form => {
    const pa = S.patches[i]
    const pop = sp.inner || !sp.whole ? Math.max(30, sp.start) : P
    const keep = { inner: pa.inner, density: pa.density, budget: ctx.houseBudget }
    ctx.p = pop === P ? p0 : { ...p0, population: pop, size: scaleOf(pop).size }
    ctx.Rin = pop === P ? Rin0 : rinFor(p0, pop)
    S.small = isVillage(ctx.p.size)
    pa.inner = sp.inner
    pa.density = sp.tier
    ctx.rng = wardRng(ctx, pa.site)
    ctx.wardFill = 1
    ctx.wardQuota = Infinity
    ctx.houseBudget = Infinity
    ctx.wardPop = pa.foundPop
    ctx.wardDensity = sp.tier
    ctx.wardType = sp.type
    ctx.wardTown = sp.town
    const rural = sp.inner && !sp.whole && !sp.town
    const ward: Ward = { poly: pa.poly, type: sp.type, inner: sp.inner, density: sp.inner ? sp.tier : undefined, ...(rural ? { rural } : {}), ...(pa.grand && sp.type === S.wards[i].type ? { tier: 'grand' as const } : {}) }
    const pieces: Piece[] = [piece('wards', ward)]
    const late = ctx.corridors
    if (!sp.inner && (sp.type === 'farm' || sp.type === 'wild')) ctx.corridors = early
    const block = wardBlock(ctx, S, i)
    if (block) {
      const cp = checkpoint(ctx)
      buildWardForm(ctx, S, i, ward, block)
      // 零散农家的片区没有街坊底（地面还是田野）
      for (const [k, n] of cp.len) if (!(rural && k === 'blocks')) for (const item of (ctx.out[k] as object[]).slice(n)) pieces.push(piece(k, item, k === 'buildings' ? residentsOf(item as Building, p.culture) : 0))
      rollback(ctx, cp)
    }
    ctx.corridors = late
    ctx.p = p0
    ctx.Rin = Rin0
    S.small = small0
    pa.inner = keep.inner
    pa.density = keep.density
    ctx.houseBudget = keep.budget
    const f: Form = { patch: i, start: sp.start, whole: sp.whole, rebuild: sp.rebuild, rural, pieces, base: [], groups: [], closed: false }
    if (sp.whole) f.base.push(...pieces)
    else {
      // 街坊底（片区本身）一开始就有，房子一户户来
      const J = sp.start
      const rest: Form = { ...f, pieces: pieces.slice(1), base: [], groups: [] }
      groupForm(
        ctx,
        rest,
        (hh) => (sp.rebuild ? J * (1 + REBUILD_SPAN * hh) : J),
        (hh) => (sp.rebuild ? J * (1 + REBUILD_SPAN * hh) : J * (1 + JOIN_SPREAD * hh)),
      )
      f.base.push(pieces[0], ...rest.base)
      f.groups = rest.groups
      for (const g of f.groups) g.form = f
    }
    return f
  }
  const forms: Form[] = []
  const formsOf = new Map<number, Form[]>()
  // 城外整片的形态（田野、荒地、城外的村子）先放个占位（只有片区本身）：大城里有三成形态从来没出现过，
  // 不必先盖一遍。调度完只盖出现过的（单次生成只要最后还在的）
  const later = new Map<Form, FormSpec>()
  const placeholder = (i: number, sp: FormSpec): Form => {
    const ward: Ward = { poly: S.patches[i].poly, type: sp.type, inner: false }
    const w = piece('wards', ward)
    const f: Form = { patch: i, start: sp.start, whole: true, rebuild: false, pieces: [w], base: [w], groups: [], closed: false }
    later.set(f, sp)
    return f
  }
  for (const i of walk) {
    const fs = specsOf(i).map((sp) => (sp.whole && !sp.inner ? placeholder(i, sp) : buildForm(i, sp)))
    forms.push(...fs)
    formsOf.set(i, fs)
  }
  // 按人口补足：各户的口数不一（大宅人多、陋屋人少，见 people.ts）
  const demand = (t: number) => t
  let life = schedule(forms, { from: 30, until: P, demand })
  if (!h.lazy) {
    // 成长史：出现过的占位盖成真的，再整个调度一遍（里面的田、树会被后来进来的农户压掉，要和别的形态一起按时间排）
    for (const [f, sp] of later) {
      const l = life.get(f.pieces[0])
      if (!l || l.born >= l.died) continue
      const real = buildForm(f.patch, sp)
      f.pieces = real.pieces
      f.base = real.base
      later.delete(f)
    }
    life = schedule(forms, { from: 30, until: P, demand })
  } else for (const [f, sp] of later) {
    const l = life.get(f.pieces[0])
    if (!l || l.died !== Infinity) continue
    const real = buildForm(f.patch, sp)
    // 片区本身用占位的那个（调度记的是它），盖的时候定下的名字（城外的村名）抄过来
    Object.assign(f.pieces[0].item, real.pieces[0].item)
    // 片区里后来盖的房子压着的树、菜园不要（调度时它们会被拆掉）
    const homes = formsOf.get(f.patch)!.flatMap((g) => (g === f ? [] : g.pieces)).filter((x) => x.key === 'buildings' && life.get(x)?.died === Infinity)
    for (const x of real.pieces.slice(1)) {
      if (homes.some((y) => overlaps(y, x))) continue
      f.pieces.push(x)
      life.set(x, { born: l.born, died: Infinity })
    }
  }
  // 城墙修起来时（见 buildWalls 给墙定的生卒），压在墙线、护城河上的田与树那时拆掉
  const walls = [...ctx.out.walls, ...h.past.filter((x) => x.key === 'walls').map((x) => x.item as Wall)]
  for (const w of walls) {
    const wl = h.life.get(w)
    if (!wl) continue
    const loop = [...w.loop, w.loop[0]]
    const reach = w.thickness / 2 + 6 + (w.moat ? w.moat.width + 4 : 0)
    const [x0, y0, x1, y1] = bboxOf(loop)
    for (const f of forms) {
      if (f.pieces[0] && (f.pieces[0].item as Ward).inner) continue
      for (const x of f.pieces) {
        if (x.key !== 'fields' && x.key !== 'trees') continue
        const l = life.get(x)
        if (!l || !(l.born < wl.born && wl.born < l.died)) continue
        if (x.box[2] < x0 - reach || x.box[0] > x1 + reach || x.box[3] < y0 - reach || x.box[1] > y1 + reach) continue
        const pts = x.poly ?? [x.p!]
        if (pts.some((q) => polylineDist(q, loop) < reach) || (x.poly && loop.some((q) => pointInPoly(q, x.poly!)))) l.died = wl.born
      }
    }
  }
  // 各片区开张（成了城区、有人住或整片建成）的时刻：第一个城区形态的片区底出生时
  const opened = new Map<number, number>()
  for (const i of walk)
    for (const f of formsOf.get(i)!) {
      const w = f.pieces[0]
      const l = life.get(w)
      if (!l || !(w.item as Ward).inner) continue
      opened.set(i, Math.min(opened.get(i) ?? Infinity, l.born))
    }
  // 写回：现在还在的进 ctx.out（按片区，片区之后撒它的祠、神龛），别的进 past
  const alive = (x: Piece) => {
    const l = life.get(x)
    return !!l && l.died === Infinity
  }
  for (const i of walk) {
    const fs = formsOf.get(i)!
    const mine = fs.flatMap((f) => f.pieces).filter((x) => life.has(x))
    for (const x of mine) {
      h.life.set(x.item, life.get(x)!)
      if (!alive(x)) h.past.push({ key: x.key, item: x.item })
    }
    const now = mine.filter(alive)
    const cp = checkpoint(ctx)
    for (const x of now) {
      ;(ctx.out[x.key] as object[]).push(x.item)
      if (x.key === 'buildings' || x.key === 'piers') ctx.occ.add(x.poly!)
    }
    const ward = now.find((x) => x.key === 'wards')?.item as Ward | undefined
    if (!ward) continue
    const lived = ward.type === 'suburb' || (ward.inner && LIVED_TYPES.has(ward.type)) || (ward.type === 'farm' && S.villages.members.has(i))
    if (!lived) continue
    const homes = now.filter((x) => x.units > 0).map((x) => life.get(x)!.born).sort((a, b) => a - b)
    if (!homes.length) continue
    const block = (now.find((x) => x.key === 'blocks')?.item as Poly | undefined) ?? S.patches[i].poly
    const m = outMark(ctx)
    wardExtras(ctx, ward, block, cp)
    stamp(ctx, m, homes[Math.floor((homes.length - 1) * 0.7)])
  }
  return opened
}

/**
 * 都城宫城的位置与大小：至少占约六块标准片区（2 × 3），大城随人口更大（两万人约 230 × 310 米），进深比面宽长；东方的坐北朝南，放在城心北侧；
 * 别的正面朝城心。挑干燥、不太陡（选定后铲平）、碰到干道最少的地（碰到的干道绕宫墙走），由近到远试，放不下就缩小。
 * sites：宫城里的站点（按标准片区大小排成几行几列，Voronoi 切出宫城的几块片区）；keepOut：宫城及外围一圈不再布有机站点与街巷。
 */
function palaceZone(ctx: Ctx, arterials: P[][]): { sites: P[]; keepOut: (q: P) => boolean } | null {
  const { T } = ctx
  const south = CULTURE_INFO[ctx.p.culture].palaceSouth
  // 至少横两格、纵三格标准片区（约六块），大城随人口再大
  const side0 = Math.min(340, Math.max(ctx.cfg.patch * 2.1, Math.sqrt(planPopOf(ctx.p)) * 1.6))
  // 朝向：东方坐北朝南（横向是东西）；西式、别的正面朝城心（进深沿着离开城心的方向，楼后是纵深的园林）
  const axes = (dir: number): [P, P] => {
    const a = south ? 0 : dir + Math.PI / 2
    const u: P = [dmath.cos(a), dmath.sin(a)]
    return [u, [-u[1], u[0]]]
  }
  // 候选方向：东方先北（地图 y 向下），其余按位置哈希排
  const dirs = Array.from({ length: 16 }, (_, k) => (k * Math.PI) / 8 - Math.PI)
  const order = dirs.sort((x, y) =>
    south ? Math.abs(x + Math.PI / 2) - Math.abs(y + Math.PI / 2) : hashAt(ctx, [x * 100, 0], 'palace.dir') - hashAt(ctx, [y * 100, 0], 'palace.dir'),
  )
  const crossed = (grow: Poly) => arterials.filter((l) => l.some((p0, i) => i + 1 < l.length && segPolyDist(p0, l[i + 1], grow) < 0.01))
  // 挑碰到干道最少的位置（同样少时按方向、由近到远的先后）
  let pick: { c: P; u: P; W: number; D: number; n: number } | null = null
  for (const k of [1, 0.85, 0.7, 0.58]) {
    const W = side0 * k
    const D = side0 * k * (south ? 1.35 : 1.4)
    for (const t of [0.8, 1.05, 1.35, 1.7, 2.1])
      for (const dir of order) {
        const [u, v] = axes(dir)
        const r = t * dmath.hypot(W, D) * 0.5
        const c: P = [ctx.center[0] + dmath.cos(dir) * r, ctx.center[1] + dmath.sin(dir) * r]
        const grow = growConvex(rect(c, u, W, D), 12)
        if (ctx.cores.some((co) => pointInPoly(co.c, grow))) continue
        // 整块干燥；山坡可以铲平，但太陡的山头不选（平均坡度不超过 0.2，最陡处不超过 0.35）
        let ok = true
        let slope = 0
        let cnt = 0
        for (let x = -0.5; x <= 0.5 && ok; x += 0.125)
          for (let y = -0.5; y <= 0.5 && ok; y += 0.125) {
            const q: P = [c[0] + u[0] * x * W + v[0] * y * D, c[1] + u[1] * x * W + v[1] * y * D]
            const sl = T.slopeAt(q)
            if (T.waterAt(q) < 8 || sl > 0.35 || q[0] < 0 || q[1] < 0 || q[0] > ctx.MW || q[1] > ctx.MH) ok = false
            slope += sl
            cnt++
          }
        if (!ok || slope / cnt > 0.2) continue
        const n = crossed(grow).length
        if (!pick || n < pick.n) pick = { c, u, W, D, n }
        if (n === 0) break
      }
    if (pick && pick.n === 0) break
  }
  if (!pick) return null
  const { c, u, W, D } = pick
  const v: P = [-u[1], u[0]]
  const R = rect(c, u, W, D)
  ctx.palaceRect = R
  // 宫城的地铲平成一块平台，四周 30 米顺坡过渡
  levelTerrain(T, R, 30)
  // 穿过宫城的干道沿宫墙外绕过去（紫禁城四周的路就是这样）
  const ring = growConvex(R, 12)
  for (let k = 0; k < arterials.length; k++) if (crossed(ring).includes(arterials[k])) arterials[k] = detour(arterials[k], ring)
  // 按标准片区大小切成几行几列（至少 2 × 3）
  const nu = Math.max(2, Math.round(W / ctx.cfg.patch))
  const nv = Math.max(3, Math.round(D / ctx.cfg.patch))
  const sites: P[] = []
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const x = (i + 0.5) / nu - 0.5
      const y = (j + 0.5) / nv - 0.5
      sites.push([c[0] + u[0] * x * W + v[0] * y * D, c[1] + u[1] * x * W + v[1] * y * D])
    }
  const out = growConvex(R, ctx.cfg.patch * 0.35)
  return { sites, keepOut: (q) => pointInPoly(q, out) }
}

/** 折线进入凸多边形 ring 的那一段换成沿 ring 的边绕过去（走较短的一侧） */
function detour(line: P[], ring: Poly): P[] {
  const pts = resample(line, 3)
  const inIdx = pts.map((q) => pointInPoly(q, ring))
  const first = inIdx.indexOf(true)
  const last = inIdx.lastIndexOf(true)
  if (first < 0) return line
  // 终点在里面（干道止于宫门）：截到宫墙外
  if (last === pts.length - 1) return pts.slice(0, Math.max(1, first))
  if (first === 0) return pts.slice(last + 1)
  const a = pts[first - 1]
  const b = pts[last + 1]
  // a、b 各投到 ring 的最近边上，沿边走较短的一侧
  const n = ring.length
  const near = (q: P) => {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < n; i++) {
      const d = segDist(q, ring[i], ring[(i + 1) % n]).d
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    return bi
  }
  const ea = near(a)
  const eb = near(b)
  // 先落到最近的边上再沿边走：从 a 直奔下一个角会切过宫城的一角
  const onEdge = (q: P, e: number): P => {
    const t = segDist(q, ring[e], ring[(e + 1) % n]).t
    return lerpP(ring[e], ring[(e + 1) % n], t)
  }
  const pa = onEdge(a, ea)
  const pb = onEdge(b, eb)
  const walk = (dir: 1 | -1) => {
    const out: P[] = []
    for (let i = ea; ; i = (i + dir + n) % n) {
      if (i === eb) break
      out.push(ring[dir > 0 ? (i + 1) % n : i])
    }
    return out
  }
  const fw = walk(1)
  const bw = walk(-1)
  const len = (w: P[]) => polylineLength([pa, ...w, pb])
  const via = ea === eb ? [] : len(fw) <= len(bw) ? fw : bw
  return [...pts.slice(0, first), pa, ...via, pb, ...pts.slice(last + 1)]
}

/**
 * 宫城的地盘：同一座宫城的几块片区合起来的外轮廓是皇城（一圈宫墙），里面取一个尽量大的矩形盖宫殿，
 * 矩形外的地是御苑（草地与树林）。东方的宫殿坐北朝南，别的按外轮廓的长轴摆。放不下返回 null（照主片区盖）。
 */
/**
 * 矩形 R 里不压水、不压路的最大矩形（与 R 同向，长宽比不超过 2.2；短边不足 40 米返回 null）。
 * 按 step 米的格点采样，逐对列找每行都干的连续几行（河斜穿时也能找到偏在一侧的整块）。
 */
function dryRect(ctx: Ctx, R: Poly, step = 8): Poly | null {
  const [o, a, , b] = R
  const W = dist(o, a)
  const H = dist(o, b)
  const e: P = [(a[0] - o[0]) / W, (a[1] - o[1]) / W]
  const n: P = [(b[0] - o[0]) / H, (b[1] - o[1]) / H]
  const nu = Math.floor(W / step)
  const nv = Math.floor(H / step)
  const ok = Array.from({ length: nu }, (_, i) =>
    Array.from({ length: nv }, (_, j) => {
      const q: P = [o[0] + e[0] * (i + 0.5) * step + n[0] * (j + 0.5) * step, o[1] + e[1] * (i + 0.5) * step + n[1] * (j + 0.5) * step]
      return ctx.T.waterAt(q) > 3 + step / 2 && !ctx.corridors.hits(q, step / 2, ['road', 'river'])
    }),
  )
  let best: [number, number, number, number] | null = null
  let ba = 0
  for (let i0 = 0; i0 < nu; i0++) {
    const col = ok[i0].slice()
    for (let i1 = i0; i1 < nu; i1++) {
      if (i1 > i0) for (let j = 0; j < nv; j++) col[j] &&= ok[i1][j]
      const w = i1 - i0 + 1
      for (let j0 = 0; j0 < nv; ) {
        if (!col[j0]) {
          j0++
          continue
        }
        let j1 = j0
        while (j1 + 1 < nv && col[j1 + 1]) j1++
        // 这一段连续的干行里取长宽比合适的最大一块（太长时截到 2.2 倍）
        const h = Math.min(j1 - j0 + 1, Math.floor(w * 2.2))
        const ww = Math.min(w, Math.floor(h * 2.2))
        if (ww * h > ba) {
          ba = ww * h
          best = [i0, i0 + ww, j0, j0 + h]
        }
        j0 = j1 + 1
      }
    }
  }
  if (!best || Math.min(best[1] - best[0], best[3] - best[2]) * step < 40) return null
  const at = (i: number, j: number): P => [o[0] + e[0] * i * step + n[0] * j * step, o[1] + e[1] * i * step + n[1] * j * step]
  return [at(best[0], best[2]), at(best[1], best[2]), at(best[1], best[3]), at(best[0], best[3])]
}

function palaceSite(ctx: Ctx, patches: Patch[], seed: number, royal = true): Poly | null {
  const members = patches.filter((pa) => pa.palace === seed)
  const U = outlines(members.map((m) => m.poly)).sort((a, b) => area(b) - area(a))[0]
  if (!U) return null
  // 宫城圈进来的街巷拆掉（宫墙截断它们）：离宫城边 4 米以里的路段不动，那是宫城外的街
  const closed = [...U, U[0]]
  // 布局时预留的宫城矩形只属于都城的宫城（合成的大社、大园囿没有）
  const pr = royal ? ctx.palaceRect : undefined
  const prOut = pr && growConvex(pr, 3)
  const deep = (q: P) => (pointInPoly(q, U) && polylineDist(q, closed) > 4) || (!!prOut && pointInPoly(q, prOut))
  // 预留的宫城矩形里什么路都拆（干道布局时已绕到宫墙外，剩下的是旧墙拆出的环城路）；合并来的片区里只拆街巷
  // 路面（按路宽）碰到宫城矩形就拆
  const outs = new Map<number, Poly>()
  const reach = (w: number) => outs.get(w) ?? (outs.set(w, growConvex(pr!, w / 2 + 1.5)), outs.get(w)!)
  const gone = (r: { kind: string; width: number }, q: P) => (!!pr && pointInPoly(q, reach(r.width))) || (r.kind !== 'main' && r.kind !== 'highway' && deep(q))
  // 拆过的路：走廊整段删掉（一段长街的走廊只有一条线段），再按剩下的几截重新登记
  const cut: Road[] = []
  const access = gateStreets(ctx)
  ctx.out.roads = ctx.out.roads.flatMap((r) => {
    const pts = resample(r.line, 3)
    if (access.has(r) || !pts.some((q) => gone(r, q))) return [r]
    const pieces = splitBy(pts, (q) => !gone(r, q)).map((line) => ({ ...r, line }))
    cut.push(...pieces)
    return pieces
  })
  // 碰到宫城矩形的城墙段（连同护城河）拆掉：宫墙就是那一段城墙
  if (prOut) {
    const inPr = (a: P, b: P) => segPolyDist(a, b, prOut) < 0.5
    for (const w of ctx.out.walls) {
      w.loop.forEach((a, k) => {
        if (inPr(a, w.loop[(k + 1) % w.loop.length])) w.solid[k] = false
      })
      w.towers = w.towers.filter((t) => !pointInPoly(t, prOut))
      w.gates = w.gates.filter((g) => !pointInPoly(g.p, prOut))
      if (w.moat) {
        const mo = growConvex(prOut, w.moat.width)
        w.moat.runs = w.moat.runs.flatMap((run) => splitBy(resample(run, 3), (q) => !pointInPoly(q, mo)))
        w.moat.bridges = w.moat.bridges.filter((b) => !pointInPoly(b.p, mo))
      }
    }
    ctx.corridors.removeWhere((a, b, tag) => tag === 'wall' && inPr(a, b), prOut)
  }
  // 截断了过桥的街：桥头只剩一小截的连路带桥去掉（同 tidyRoads），再留下还有路走的桥
  // （合并片区里留下来的干道照样过它的桥）
  ctx.out.roads = trimDangling(ctx.out.roads, ctx.T)
  const carries = (c: Crossing, r: Road) =>
    r.kind !== 'path' && (r.kind === 'main' || r.kind === 'highway' || (!deep(c.a) && !deep(c.b))) && polylineDist(c.a, r.line) < 2.5 && polylineDist(c.b, r.line) < 2.5
  ctx.out.crossings = ctx.out.crossings.filter((c) => ctx.out.roads.some((r) => carries(c, r)))
  // 走廊跟着拆：留下来的干道（合并片区里的）不动
  const kept = ctx.out.roads.filter((r) => (r.kind === 'main' || r.kind === 'highway') && resample(r.line, 3).some(deep))
  // 碰到宫城矩形（或拆了路的合并片区）的走廊段整段删掉，再给附近留下的路重新登记走廊
  const bb = prOut ? [...U, ...prOut] : U
  ctx.corridors.removeWhere((a, b, tag, hw) => {
    if (tag !== 'road') return false
    if (pr && segPolyDist(a, b, pr) < hw + 1.5) return true
    const m: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    return deep(m) && !kept.some((r) => polylineDist(m, r.line) < r.width / 2 + 2)
  }, bb)
  const [x0, y0, x1, y1] = bboxOf(bb)
  const nearBy = (q: P) => q[0] > x0 - 60 && q[0] < x1 + 60 && q[1] > y0 - 60 && q[1] < y1 + 60
  for (const r of ctx.out.roads) if (cut.includes(r) || r.line.some(nearBy)) roadCorridor(ctx, r)
  // 东方的大寺、大社按方格朝向摆（院落坐北朝南，见 eastCompound 的 northOf）；别的顺着合成片区的长轴
  const east = CULTURE_INFO[ctx.p.culture].palaceSouth
  const axis: P = royal && east ? [1, 0] : !royal && east ? [dmath.cos(ctx.gridAngle), dmath.sin(ctx.gridAngle)] : obb(U).axis
  const n: P = [-axis[1], axis[0]]
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const q of U) {
    const u = q[0] * axis[0] + q[1] * axis[1]
    const v = q[0] * n[0] + q[1] * n[1]
    ;[u0, u1, v0, v1] = [Math.min(u0, u), Math.max(u1, u), Math.min(v0, v), Math.max(v1, v)]
  }
  const ok = (R: Poly) => {
    const pts = resample([...R, R[0]], 5)
    return pts.every((q) => pointInPoly(q, U) && ctx.T.waterAt(q) > 3) && !ctx.corridors.hitsPoly(R, 1.5)
  }
  // 布局时预留的宫城矩形就是宫殿的地盘；没有（选址时并的片区）才在合起来的轮廓里找：从大到小试，每个大小再试几种长宽比
  // 预留的矩形压了水或路（河从宫城地盘里穿过）：宫城让到河的一侧，取其中最大的一块
  let R: Poly | null = !pr ? null : (resample([...pr, pr[0]], 5).every((q) => ctx.T.waterAt(q) > 3) && !ctx.corridors.hitsPoly(pr, 0, ['road', 'river']) ? pr : dryRect(ctx, pr))
  let best = R ? Infinity : 0
  // 合成的大社、大园：地盘尽量方正（狭长的一条盖不出参道与社殿、池与御殿），面积按长宽比打折
  const score = (w: number, h: number) => w * h * (royal ? 1 : Math.min(1, Math.min(w, h) / Math.max(w, h) / 0.4))
  for (const s of [0.85, 0.78, 0.7, 0.63, 0.56, 0.5, 0.44, 0.38, 0.32])
    for (const k of royal ? [1, 0.8, 1.25, 0.65, 1.55] : [1, 0.8, 1.25, 0.65, 1.55, 0.5, 0.4]) {
      const w = (u1 - u0) * s * k
      const h = (v1 - v0) * s / k
      if (score(w, h) <= best) continue
      const q = fit(U, (c) => rect(c, axis, w, h), ok, [1])
      if (q) {
        R = q
        best = score(w, h)
      }
    }
  if (!R) return null
  // 矩形外是御苑
  for (const m of members) {
    const g = placeable(ctx, insetConvex(m.poly, 3))
    if (!g) continue
    emitArea(ctx, 'greens', g, 'park')
    const t0 = ctx.out.trees.length
    // 合成的大社四周是镇守之森（密林），大寺、大教堂是寺林、草地上的树，都城的御苑疏朗
    const t = patches[seed].type
    scatterTrees(ctx, g, royal ? 0.004 : t === 'temple' ? (ctx.p.culture === 'wa' ? 0.014 : 0.007) : t === 'castle' ? 0.002 : 0.005, 3, 5.5)
    const inR = growConvex(R, 6)
    drop(ctx, 'trees', (t) => pointInPoly(t.p, inR), t0)
  }
  return R
}

/**
 * 城外相邻的两三块农田并成一片（一户人家、一个庄园的地）：片区之间不留田间道，垄向与用地按整片来定，
 * 田野不再是一格格一样大的 Voronoi 块。
 * 分组只看片区网格与位置哈希、不看现在哪些是农田：城长大、占掉其中一块时，同片剩下的几块还是原来那一片
 * （用地、色调、垄向都不变），相邻的分组也不会跟着重排。ok 只决定哪些块现在按这片来种。
 */
function farmGroups(ctx: Ctx, patches: Patch[], ok: (i: number) => boolean) {
  const out = new Map<number, FarmGroup>()
  const taken = new Set<number>()
  const order = patches.map((pa, i) => [hashAt(ctx, pa.site, 'farm.group'), i] as const).sort((a, b) => a[0] - b[0])
  const land = (i: number) => patches[i].land >= 0.35
  for (const [h, i] of order) {
    if (taken.has(i) || !land(i)) continue
    // 三成单独一块，其余两到三块一片
    const want = h < 0.3 ? 1 : h < 0.75 ? 2 : 3
    const members = [i]
    for (let k = 0; k < members.length && members.length < want; k++)
      for (const j of patches[members[k]].nb) {
        if (members.length >= want || taken.has(j) || members.includes(j) || !land(j)) continue
        const e = sharedEdge(patches[members[k]], patches[j])
        if (e && dist(e[0], e[1]) > 20) members.push(j)
      }
    for (const j of members) taken.add(j)
    const live = members.filter(ok)
    if (members.length < 2 || !live.length) continue
    let ax = 0
    let ay = 0
    let at = 0
    for (const j of members) {
      const a = area(patches[j].poly)
      const c = centroid(patches[j].poly)
      ax += c[0] * a
      ay += c[1] * a
      at += a
    }
    const g: FarmGroup = { c: [ax / at, ay / at], seams: [] }
    for (const a of live) for (const b of live) if (a < b) {
      const e = sharedEdge(patches[a], patches[b])
      if (e) g.seams.push(e)
    }
    for (const j of live) out.set(j, g)
  }
  return out
}

/**
 * 城外的村庄：城镇与城市周围，每隔七八百米一个村子（中世纪欧洲与中国的农户大多聚居在村里、出村种田）。
 * 选城区外、近路、平缓的农田片区作村心（公地与水井），相邻几块平缓的地是村舍；
 * 按位置哈希的先后挑，彼此、与城区都隔开一段，城长大时已有的村子不挪。
 */
function pickVillages(ctx: Ctx, patches: Patch[]): { centers: Set<number>; members: Set<number> } {
  const out = new Set<number>()
  const members = new Set<number>()
  if (!ctx.env.big) return { centers: out, members }
  const gapCity = ctx.Rin + 350
  // 候选与彼此的间隔只看地形、道路与位置哈希（与人口无关）：城长大、吞掉离得近的村子时，
  // 空出来的地方不会冒出新村子，别处的村子也不会跟着挪。挑定之后，再只留现在还在城外田野里的
  const cands = patches
    .map((pa, i) => ({ pa, i, key: hashAt(ctx, pa.site, 'village.pick') }))
    .filter(({ pa }) => {
      const q = pa.site
      if (pa.land < 0.85) return false
      if (q[0] < 60 || q[1] < 60 || q[0] > ctx.MW - 60 || q[1] > ctx.MH - 60) return false
      if (ctx.T.slopeAt(q) > 0.12) return false
      if (ctx.plan?.z.contains(q)) return false
      return ctx.corridors.gap(q) < spacing(ctx, q) * 0.8
    })
    .sort((a, b) => a.key - b.key)
  const made: P[] = []
  const flat = (j: number) => patches[j].type === 'farm' && !patches[j].inner && patches[j].land >= 0.85 && ctx.T.slopeAt(patches[j].site) < 0.12
  for (const { pa, i } of cands) {
    if (made.some((m) => dist(m, pa.site) < 720)) continue
    made.push(pa.site)
    if (pa.type !== 'farm' || pa.inner || centerDist(ctx, pa.site) < gapCity) continue
    out.add(i)
    // 村舍铺到周围几块平缓的地上（一个村子二三十户）
    for (const j of pa.nb) if (!out.has(j) && flat(j) && dist(patches[j].site, pa.site) < 180) members.add(j)
  }
  return { centers: out, members }
}

/**
 * 村巷：片区之间的公共边组成一张图，以离干道不远的角点为根（到干道的距离算作代价）求最短路径树；
 * 每块没挨着干道的地，取它离路网最近的角点，把这条最短路径上的边都修成巷子，根点补一小段通到干道。
 * 于是每户都有路走、没有断头巷；村子长大时外面新添的边几乎不会成为里面的捷径，老村子的巷子不变。
 */
function villageLanes(ctx: Ctx, patches: Patch[], arterials: P[][], wanted: (i: number) => boolean) {
  const { T, cfg } = ctx
  const key = (q: P) => `${Math.round(q[0] * 2)},${Math.round(q[1] * 2)}`
  // 图：城内片区的每条公共边（两端都不落水）
  const pos = new Map<string, P>()
  const adj = new Map<string, { to: string; L: number }[]>()
  const link = (a: P, b: P) => {
    const ka = key(a)
    const kb = key(b)
    if (ka === kb) return
    pos.set(ka, a)
    pos.set(kb, b)
    const L = dist(a, b)
    ;(adj.get(ka) ?? adj.set(ka, []).get(ka)!).push({ to: kb, L })
    ;(adj.get(kb) ?? adj.set(kb, []).get(kb)!).push({ to: ka, L })
  }
  for (let i = 0; i < patches.length; i++) {
    if (!patches[i].inner) continue
    for (const j of patches[i].nb) {
      if (patches[j].inner && j < i) continue
      const e = sharedEdge(patches[i], patches[j])
      if (!e || T.waterAt(e[0]) < 3 || T.waterAt(e[1]) < 3) continue
      link(e[0], e[1])
    }
  }
  // 根：离干道不远的角点，初始代价是到干道的距离
  const reach = cfg.patch * 0.6
  const spur = new Map<string, P>()
  const cost = new Map<string, number>()
  for (const [k, q] of pos) {
    let bd = reach
    let best: P | null = null
    for (const r of arterials)
      for (let m = 0; m + 1 < r.length; m++) {
        const { d, t } = segDist(q, r[m], r[m + 1])
        if (d < bd) {
          bd = d
          best = [r[m][0] + (r[m + 1][0] - r[m][0]) * t, r[m][1] + (r[m + 1][1] - r[m][1]) * t]
        }
      }
    if (!best) continue
    cost.set(k, bd)
    if (bd > cfg.main / 2 + 1) spur.set(k, best)
  }
  // Dijkstra。代价相同时先取先登记进 cost 的角点（按 cost 的插入顺序编号），与逐个比较取最小的写法选出同一个点
  const prev = new Map<string, string>()
  const done = new Set<string>()
  const ord = new Map<string, number>()
  for (const k of cost.keys()) ord.set(k, ord.size)
  const heap: [number, number, string][] = []
  const less = (a: [number, number, string], b: [number, number, string]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
  const push = (e: [number, number, string]) => {
    let i = heap.length
    heap.push(e)
    while (i > 0) {
      const up = (i - 1) >> 1
      if (!less(e, heap[up])) break
      heap[i] = heap[up]
      i = up
    }
    heap[i] = e
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= heap.length) break
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++
        if (!less(heap[c], last)) break
        heap[i] = heap[c]
        i = c
      }
      heap[i] = last
    }
    return top
  }
  for (const [k, c] of cost) push([c, ord.get(k)!, k])
  while (heap.length) {
    const [cu, , u] = pop()
    // 过期的条目（之后又找到了更近的路）跳过
    if (done.has(u) || cu !== cost.get(u)) continue
    done.add(u)
    for (const { to, L } of adj.get(u) ?? []) {
      const c = cu + L
      if (c < (cost.get(to) ?? Infinity)) {
        if (!ord.has(to)) ord.set(to, ord.size)
        cost.set(to, c)
        prev.set(to, u)
        push([c, ord.get(to)!, to])
      }
    }
  }
  // 每块没挨着干道的地：从它离路网最近的角点沿树回到根
  const lanes = new Set<string>()
  const roots = new Set<string>()
  for (const [i, pa] of patches.entries()) {
    if (!pa.inner || !wanted(i) || arterials.some((r) => r.some((q) => pointInPoly(q, pa.poly)))) continue
    let best: string | null = null
    for (const v of pa.poly) {
      const k = key(v)
      if (cost.has(k) && (best === null || cost.get(k)! < cost.get(best)!)) best = k
    }
    for (let k = best; k !== null; ) {
      const pk = prev.get(k)
      if (pk === undefined) {
        roots.add(k)
        break
      }
      lanes.add(k < pk ? `${k}|${pk}` : `${pk}|${k}`)
      k = pk
    }
  }
  for (const e of lanes) {
    const [a, b] = e.split('|').map((k) => pos.get(k)!)
    for (const piece of landPieces(T, [a, b])) ctx.out.roads.push({ line: piece, width: cfg.lane, kind: 'lane' })
  }
  for (const k of roots) {
    const to = spur.get(k)
    if (to) for (const piece of landPieces(T, [pos.get(k)!, to])) ctx.out.roads.push({ line: piece, width: cfg.lane, kind: 'lane' })
  }
}

/**
 * 行道树：城镇、城市的主街两侧每隔约 9 米一棵（种在人行道上，避开房子、水面与路口）。
 * 由旧城墙改成的环城大道（有名字、成环）一定种，其余主街按位置哈希约六成种。
 */
function avenueTrees(ctx: Ctx) {
  if (!ctx.env.big) return
  const mains = ctx.out.roads.filter((r) => r.kind === 'main' && r.width >= 6)
  for (const r of mains) {
    // 成长史：随路出生
    const m = outMark(ctx)
    plantAvenue(ctx, r, mains)
    stamp(ctx, m, ctx.history.life.get(r)?.born ?? 0)
  }
}

function plantAvenue(ctx: Ctx, r: Road, mains: Road[]) {
  const L = polylineLength(r.line)
  if (L < 60) return
  const ring = dist(r.line[0], r.line[r.line.length - 1]) < 20 && L > 200
  if (!ring && hashAt(ctx, r.line[Math.floor(r.line.length / 2)], 'avenue') > 0.6) return
  const off = r.width / 2 + 0.9
  // 城门、宫门正前方（门内外各 40 米、门中线两侧各 14 米，连门楼两侧）让开：门前不挡树
  const gates = ctx.out.walls.flatMap((w) => w.gates)
  const fronting = (q: P) =>
    gates.some((g) => {
      const dx = q[0] - g.p[0]
      const dy = q[1] - g.p[1]
      const along = dx * dmath.cos(g.angle) + dy * dmath.sin(g.angle)
      return Math.abs(along) < 40 && Math.abs(dy * dmath.cos(g.angle) - dx * dmath.sin(g.angle)) < 14
    })
  for (let s = 6; s < L - 6; s += 9) {
    const { p, angle } = pointAt(r.line, s)
    const n: P = [-dmath.sin(angle), dmath.cos(angle)]
    for (const side of [-1, 1]) {
      const q: P = [p[0] + n[0] * off * side, p[1] + n[1] * off * side]
      if (ctx.T.waterAt(q) < 3 || ctx.occ.hitsPoint(q, 1.6) || fronting(q)) continue
      // 路口：离别的路太近就不种
      if (mains.some((o) => o !== r && polylineDist(q, o.line) < o.width / 2 + 2)) continue
      ctx.out.trees.push({ p: q, r: 2.3 + hashAt(ctx, q, 'avenue.tree') * 0.6 })
    }
  }
}

/** 临海村落：离村中心最近的岸边修一两座栈桥，一条小路通过去 */
function jetties(ctx: Ctx) {
  const { T, rng, center } = ctx
  const cands: P[] = []
  for (let r = 20; r < ctx.Rin * 3; r += 8)
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2
      const q: P = [center[0] + dmath.cos(a) * r, center[1] + dmath.sin(a) * r]
      const w = T.waterAt(q)
      if (w > 1 && w < 4 && T.seaAt([q[0] - T.waterGrad(q)[0] * 30, q[1] - T.waterGrad(q)[1] * 30])) cands.push(q)
    }
  const made: P[] = []
  for (const q of cands) {
    if (made.length >= 2 || made.some((m) => dist(m, q) < 40)) continue
    const g = T.waterGrad(q)
    const L = 22 + rng.next() * 16
    const end: P = [q[0] - g[0] * L, q[1] - g[1] * L]
    if (!T.seaAt(end)) continue
    const mid: P = [(q[0] + end[0]) / 2, (q[1] + end[1]) / 2]
    const route = smoothRoute(routeOnTerrain(T, center, [q[0] + g[0] * 3, q[1] + g[1] * 3], { water: 30, slope: 1 }), 3, T)
    if (route.length < 2) continue
    if (!addPier(ctx, rect(mid, [-g[0], -g[1]], L + 2, 3.2))) continue
    const n: P = [-g[1], g[0]]
    for (const s of [-1, 1]) {
      const len = 7 + rng.next() * 4
      if (rng.next() < 0.7) addBoat(ctx, [end[0] + g[0] * L * 0.3 + n[0] * (2.8 + len * 0.18) * s, end[1] + g[1] * L * 0.3 + n[1] * (2.8 + len * 0.18) * s], dmath.atan2(-g[1], -g[0]), len)
    }
    ctx.out.roads.push({ line: route, width: ctx.cfg.lane, kind: 'lane' })
    made.push(q)
  }
}

/** 村里的公地草场：整块裁到离水 2 米以外（河从一角斜穿过去也收到岸上），裁完不到 100 m² 就不要 */
function commonOf(ctx: Ctx, block: Poly): Poly | null {
  const q = clipWater(ctx, block, 2, 12)
  return q && area(q) >= 100 ? dryArea(ctx, q) : null
}

/** 村公地：草地、水井与几棵大树 */
function villageGreen(ctx: Ctx, block: Poly) {
  const w = clipWater(ctx, insetConvex(block, 4), 4)
  const g = w && ctx.corridors.clip(w)
  if (!g) {
    // 路从中间穿过（放不下一圈草地与井）：整块就是村里的公地草场，路从草场上过
    const common = commonOf(ctx, block)
    if (common) {
      emitArea(ctx, 'greens', common, 'park')
      scatterTrees(ctx, insetConvex(common, 3), 0.0015, 3.5, 5.5)
    }
    return
  }
  const c = centroid(g)
  const r = Math.min(22, Math.sqrt(area(g)) * 0.3)
  const green = insetConvex(circlePoly(c, r, 18), 0)
  const gi = ctx.out.greens.length
  emitArea(ctx, 'greens', green, 'park')
  ctx.out.landmarks.push({ p: c, kind: 'well' })
  for (let k = 0; k < 3; k++) {
    const a = ctx.rng.next() * Math.PI * 2
    const t: P = [c[0] + dmath.cos(a) * r * 0.6, c[1] + dmath.sin(a) * r * 0.6]
    if (!ctx.corridors.hits(t, 1) && !ctx.occ.hitsPoint(t, 2)) ctx.out.trees.push({ p: t, r: 4 + ctx.rng.next() * 2 })
  }
  const nb = ctx.out.buildings.length
  urban(ctx, block, 'village', [circlePoly(c, r + 4, 18)])
  // 四周一户也没盖（小村的人家都在别处）：整块是公地草场，井在当中
  // 草场垫在井边那圈草地下面（先画）
  const common = ctx.out.buildings.length === nb ? commonOf(ctx, block) : null
  if (common) ctx.out.greens.splice(gi, 0, { poly: common, kind: 'park' })
}

/** 城里跨河的额外桥：沿河每隔一段架一座，桥头的短街切开街坊 */
function extraBridges(ctx: Ctx, inside: (q: P) => boolean) {
  const { T, cfg, p } = ctx
  if (!T.river || isVillage(p.size)) return
  const line = T.river.line
  const L = polylineLength(line)
  const existing: P[] = []
  // 已有的过河处：沿路每 4 米查（理过的桥线是一条直线，水上没有顶点）
  for (const r of ctx.out.roads) for (const q of resample(r.line, 4)) if (T.waterAt(q) < 0) existing.push(q)
  const gap = p.size === 'city' ? 190 : 260
  for (let s = 0; s < L; s += 12) {
    const { p: q, angle } = pointAt(line, s)
    if (!inside(q) || existing.some((e) => dist(e, q) < gap)) continue
    const n: P = [-dmath.sin(angle), dmath.cos(angle)]
    const hw = T.river.hw[Math.min(T.river.hw.length - 1, Math.round((s / L) * (T.river.hw.length - 1)))]
    const reach = hw + 26
    const a: P = [q[0] - n[0] * reach, q[1] - n[1] * reach]
    const b: P = [q[0] + n[0] * reach, q[1] + n[1] * reach]
    if (T.waterAt(a) < 3 || T.waterAt(b) < 3) continue
    // 桥的两头都要接上岸上的路（同岸 120 米内最近的一条，接线不下水），接不上就不修这座桥
    const ja = joinRoad(ctx, a, q)
    const jb = joinRoad(ctx, b, q)
    if (!ja || !jb) continue
    ctx.out.roads.push({ line: [ja, a, q, b, jb], width: cfg.lane + 1, kind: 'street' })
    existing.push(q)
  }
}

/** 桥头 e 接到岸上最近的路（不含小径；接线全程在岸上、不回头过河）：返回接点，接不上返回 null */
function joinRoad(ctx: Ctx, e: P, bridge: P): P | null {
  const { T } = ctx
  // 接点在桥的这一侧（离桥中点比桥头远），接线沿途都是干地
  const ok = (r: Road, at: P) => {
    if (!through(r) || dist(at, bridge) < dist(e, bridge)) return false
    for (let t = 0.1; t <= 1; t += 0.1) if (T.waterAt(lerpP(e, at, t)) < 2) return false
    return true
  }
  return nearestRoad(ctx, e, 120, ok)?.p ?? null
}

function nameDistricts(ctx: Ctx) {
  const { p } = ctx
  if (isVillage(p.size)) return
  const named = (t: WardType) => t === 'suburb' || !!FEATURE[t as FeatureId]?.named
  const frac = p.size === 'city' ? 0.5 : 0.35
  for (const w of ctx.out.wards) {
    // 形制已经起了名的（麦地那的香料市……）不再重取
    if (!w.inner || w.name) continue
    // 形制自己的片区名（城下町的〇〇町、寺町……）优先
    const custom = ctx.plan?.def.districtName?.(ctx, w, ctx.plan.z)
    if (custom !== undefined) {
      w.name = custom ?? undefined
      continue
    }
    if (!named(w.type)) continue
    const c = centroid(w.poly)
    if (hashAt(ctx, c, 'district.name') > frac && w.type !== 'harbor') continue
    w.name = ctx.namer.district(w.type, whereOf(ctx, w.poly))
  }
}

// —————————————————————— 奇观 ——————————————————————

function magicExtras(ctx: Ctx) {
  const { p, T, MW, MH, counts } = ctx
  // 每种奇观用自己的随机数流：改其中一项的数量，其余的位置不变
  let rng = new RNG(hashString(`${p.seed}|sect`))
  // 东方：山上的宗门，石阶从城门蜿蜒而上
  if (counts.magic > 0 && eastAsian(p.culture) && p.hills && T.hillDir) {
    // 候选山头按"高、缓、离城不太远"排序，依次试到能落地为止（不压路、不压水）
    const cands: { q: P; h: number }[] = []
    for (let k = 0; k < 400; k++) {
      const q: P = [160 + rng.next() * (MW - 320), 160 + rng.next() * (MH - 320)]
      if (T.waterAt(q) > 30 && dist(q, ctx.center) > ctx.Rin * 1.2) cands.push({ q, h: T.heightAt(q) - T.slopeAt(q) * 200 - dist(q, ctx.center) * 0.03 })
    }
    cands.sort((a, b) => b.h - a.h)
    let best: P | null = null
    for (const { q } of cands.slice(0, 40)) {
      const zone = rect(q, [1, 0], 110, 110)
      if (zone.some((v) => T.waterAt(v) < 5) || ctx.corridors.hitsPoly(zone, 1, ['road', 'wall'])) continue
      best = q
      break
    }
    if (best) {
      // 宗门所在的山头先清场：原有的农舍、林木、田块让位
      const zone = rect(best, [1, 0], 110, 110)
      const clear = rect(best, [1, 0], 124, 124)
      const inClear = (poly: Poly) => poly.some((v) => pointInPoly(v, clear)) || pointInPoly(centroid(poly), clear)
      demolish(ctx, (b) => inClear(b.poly))
      drop(ctx, 'enclosures', inClear)
      drop(ctx, 'fields', (f) => inClear(f.poly))
      drop(ctx, 'trees', (t) => pointInPoly(t.p, clear))
      ctx.occ.removeWhere(inClear, bboxOf(clear))
      if (eastCompound(ctx, zone, 'sect')) {
        mark(ctx, best, 'magic')
        // 石阶从城门通到山门外，沿途让开
        // 从离山门最近的城门出发，绕开城内
        const gate: P = [best[0], best[1] + 62]
        const gates = ctx.cityWalls.flatMap((w) => w.gates)
        const from = gates.length ? gates.reduce((a, g) => (dist(g.p, gate) < dist(a.p, gate) ? g : a)).p : ctx.center
        const walled = ctx.cityWalls.length > 0
        const stair = smoothRoute(routeOnTerrain(T, from, gate, { water: 20, slope: 0.25, bias: (q) => (walled && inCity(ctx, q) ? 30 : ctx.corridors.hits(q, 0) ? 0.6 : 1) }), 3, T)
        if (stair.length > 1) {
          // 石阶两旁 2.5 米内的房子与树让开（树先按中心粗筛，碰得到的才按树冠细算）
          const maxR = ctx.out.trees.reduce((m, t) => Math.max(m, t.r), 0)
          const idx = new LineIndex(stair, 2.5 + maxR * 0.6)
          demolish(ctx, (b) => idx.nearPoly(b.poly, 2.5))
          drop(ctx, 'trees', (t) => idx.nearPoint(t.p, 2.5 + t.r * 0.6) && idx.nearPoly(circlePoly(t.p, t.r * 0.6, 6), 2.5))
          ctx.out.roads.push({ line: stair, width: 2.5, kind: 'stair' })
        }
      }
    }
  }
  // 浮空岛：离房屋、城墙都远的空中，彼此也隔开
  rng = new RNG(hashString(`${p.seed}|isle`))
  const blds = ctx.out.buildings.filter((_, i) => i % 3 === 0).map((b) => b.poly[0])
  const isles: P[] = []
  for (let n = 0; n < counts.isle; n++) {
    const ir = 34 + rng.next() * 24
    let ip: P | null = null
    let bestGap = -Infinity
    for (let k = 0; k < 160; k++) {
      const a = rng.next() * Math.PI * 2
      const r = ctx.Rin * (1 + rng.next() * 1.2)
      const q: P = [ctx.center[0] + dmath.cos(a) * r, ctx.center[1] + dmath.sin(a) * r]
      if (q[0] < ir * 2 || q[1] < ir * 2 || q[0] > MW - ir * 2 || q[1] > MH - ir * 2) continue
      let g = Infinity
      for (const b of blds) g = Math.min(g, dist(b, q))
      for (const w of ctx.out.walls) for (const v of w.loop) g = Math.min(g, dist(v, q))
      for (const o of isles) g = Math.min(g, dist(o, q) - ir * 2.5)
      if (g > bestGap) {
        bestGap = g
        ip = q
      }
    }
    if (!ip) break
    isles.push(ip)
    ctx.out.wonders.push({ p: ip, r: ir, kind: 'isle' })
  }
  // 灵脉：穿过奇观（法师塔 / 宗门，没有就是城心）的发光曲线；多条时方向错开
  rng = new RNG(hashString(`${p.seed}|leyline`))
  const m = ctx.out.landmarks.find((l) => l.kind === 'magic')?.p ?? ctx.center
  const b0 = rng.next() * Math.PI
  for (let n = 0; n < counts.leyline; n++) {
    const b = b0 + (n * Math.PI) / Math.max(1, counts.leyline)
    const pts: P[] = []
    for (let k = -12; k <= 12; k++) {
      const s = (k / 12) * dmath.hypot(MW, MH) * 0.6
      const wob = dmath.sin(k * 0.7 + rng.next()) * 30
      pts.push([m[0] + dmath.cos(b) * s - dmath.sin(b) * wob, m[1] + dmath.sin(b) * s + dmath.cos(b) * wob])
    }
    ctx.out.wonders.push({ p: m, r: 0, kind: 'leyline', line: chaikin(pts, 3) })
  }
}

// —————————————————————— 注记 ——————————————————————

function seaPoint(ctx: Ctx): P {
  const { T, MW, MH } = ctx
  let best: P = [0, 0]
  let bw = Infinity
  // 离图边留出余量，免得海名贴边
  const m = Math.min(MW, MH) * 0.12
  for (let y = m; y < MH - m; y += 20)
    for (let x = m; x < MW - m; x += 20) {
      const w = T.waterAt([x, y])
      if (T.seaAt([x, y]) && w < bw) {
        bw = w
        best = [x, y]
      }
    }
  return best
}

/** 与片区名同级标注的大地标 */
const MAJOR = new Set<Landmark['kind']>(['castle', 'temple', 'market', 'harbor', 'magic'])

function labels(ctx: Ctx, riverName: Tri | null, seaName: Tri | null) {
  const { T, out, MW, MH } = ctx
  const L: MapLabel[] = out.labels
  // 片区名；城外村庄的村名用地标一级的字（比城里的区名小）
  for (const w of out.wards) if (w.name) L.push({ text: w.name, p: centroid(w.poly), angle: 0, kind: w.inner || w.type !== 'farm' ? 'district' : 'landmark', weight: w.inner ? 5 : 3 })
  for (const r of out.roads) {
    if (!r.name || polylineLength(r.line) < 90) continue
    L.push({ text: r.name, p: pointAt(r.line, polylineLength(r.line) * 0.55).p, angle: 0, kind: 'street', path: r.line, weight: 4 })
  }
  for (const l of out.landmarks) {
    if (!l.name || l.kind === 'well') continue
    // 大地标与片区名同级；其余是小字的兴趣点，排在片区名、街名之后，放不下就不标
    if (MAJOR.has(l.kind) || l.major) L.push({ text: l.name, p: l.p, angle: 0, kind: 'landmark', weight: l.kind === 'castle' || l.kind === 'temple' || l.major ? 7 : 5 })
    else L.push({ text: l.name, p: l.p, angle: 0, kind: 'poi', weight: 1 })
  }
  if (T.river && riverName) {
    // 河名放在城外一段较直的河道上
    const line = T.river.line
    const Lr = polylineLength(line)
    let bestS = Lr * 0.2
    let bd = -Infinity
    for (let s = 120; s < Lr - 120; s += 20) {
      const q = pointAt(line, s).p
      if (q[0] < 150 || q[1] < 150 || q[0] > MW - 150 || q[1] > MH - 150) continue
      const d = dist(q, ctx.center) - Math.abs(dist(q, ctx.center) - ctx.Rin * 1.6) * 0.6
      if (d > bd) {
        bd = d
        bestS = s
      }
    }
    const seg: P[] = []
    for (let s = bestS - 110; s <= bestS + 110; s += 10) seg.push(pointAt(line, Math.max(0, Math.min(Lr, s))).p)
    L.push({ text: riverName, p: pointAt(line, bestS).p, angle: 0, kind: 'river', path: seg, weight: 8 })
  }
  if (T.coast && seaName) L.push({ text: seaName, p: seaPoint(ctx), angle: 0, kind: 'water', weight: 9 })
  if (T.hillDir) {
    let best: P = ctx.center
    let bh = -Infinity
    for (let y = 80; y < MH - 80; y += 30)
      for (let x = 80; x < MW - 80; x += 30) {
        const h = T.heightAt([x, y])
        if (h > bh) {
          bh = h
          best = [x, y]
        }
      }
    L.push({ text: ctx.namer.hill(), sub: same(`${Math.round(bh)} m`), p: best, angle: 0, kind: 'hill', weight: 6 })
  }
}

