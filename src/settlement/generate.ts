import { RNG, hashString } from '../gen/rng'
import { contours, simplify } from '../render/atlas/svg/contour'
import { Corridors, Occupancy, SUB_WEIGHT, whereOf, centerDist, clipWater, placeable, hashAt, gridFrame, inCity, mainCore, squareness, seedRng, wardRng, type Core, mark, type Ctx } from './ctx'
import { FEATURE, FEATURES, featureEnv, resolveCounts, type FeatureId } from './features'
import { placeLandmarks, zoneLots, type Lot } from './zoning'
import { PATCH, POP_OF_SIZE, densityOf, isVillage, fullPerHa, housesPerHa, perHousehold, scaleOf } from './scale'
import {
  area,
  centroid,
  chaikin,
  circlePoly,
  dist,
  bboxOf,
  clipHalf,
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
import { bastioned, cleanLoop, connectGates, fromF32, keepTowersDry, insetLoop, simplifyLoop, smoothRoute, toF32, wallFromLoop } from './walls'
import { roadCorridor, tidyRoads, trimDangling } from './roads'
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
import { buildTerrain, landPieces, levelTerrain, routeOnTerrain } from './terrain'
import { DEFAULT_SETTLEMENT, LAYOUT_DEFAULT, type Density, type Landmark, type Road, type MapLabel, type Tri, same, type Settlement, type SettlementParams, type Wall, type Ward, type WardType } from './types'
import { addBoat, addPier, eastCompound, fit, plaza, scatterTrees, urban } from './wards'

export function generateSettlement(input: SettlementParams): Settlement {
  const t0 = performance.now()
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
  // 商贸城：干道更宽、对外道路更多
  if (p.function === 'trade') {
    cfg.main *= 1.6
    cfg.highway *= 1.25
    cfg.roads = [cfg.roads[0] + 1, cfg.roads[1] + 1]
  }
  // 随机数只由种子与文明定（不含规模档位）：同一个种子换人口，地形与骨架不变
  const rng = new RNG(hashString(`${p.seed}|${p.culture}`))
  // 副中心离得远（卫星城）时地图放大，放得下隔着田野的几座城
  const env0 = featureEnv(p)
  const subN = env0.big ? resolveCounts(p, env0).subcenter : 0
  // 城区要多大由目标户数定：户数 ÷ 每公顷户数 = 需要的城区面积，折成片区数（片区网格、城区半径、
  // 地图范围都按它铺开）；经验片区数偏少时（大村、规整的东方城）随之放大
  const households = Math.round(target / perHousehold(p.culture))
  // 城墙按规划容量修：地图要放得下现在这道墙（它能容纳的人口比现在多）
  const planned = wallStages(p).at(-1)?.cap ?? 0
  const needInner = innerFor(p, Math.max(target, planned))
  const room = Math.sqrt(Math.max(1, needInner / cfg.inner))
  cfg.inner = Math.max(cfg.inner, needInner)
  const grow = (subN ? 1 + 0.45 * p.spread * p.spread : 1) * room
  // 取整到 20 米：地形网格（5 米）与寻路网格（10 米）都对齐地图中心（世界原点）
  const extent: [number, number] = [Math.round((sc.extent[0] * grow) / 20) * 20, Math.round((sc.extent[1] * grow) / 20) * 20]
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
    uncounted: false,
    estate: false,
    cores: [],
    cityWalls: [],
    // 民居预算：目标人口折成户数，盖满就不再盖（见 addBuilding）
    houseBudget: households,
    wardFill: 1,
    wardDensity: 'mid',
    tier: 'standard',
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
  ctx.cores = [mainCore(ctx), ...pickSubcenters(ctx, arterials, ctx.env.big ? ctx.counts.subcenter : 0)]
  arterials.push(...linkSubcenters(ctx, arterials))
  // 城市形制：规划区（里坊、营寨城……）与干道在规划区里改走规划的大街
  ctx.plan = setupPlan(ctx)
  if (ctx.plan) planArterials(ctx, arterials)
  // 布局只有一条流程：有机 / 方格 / 放射由规整度与放射度连续混合
  layoutOrganic(ctx, arterials, stages)
  // 地标建筑（酒馆、传送门……）插进填好的街坊
  placeLandmarks(ctx)
  // 城外的磨坊、风车、刑场、砖窑、灯塔
  ruralExtras(ctx)
  magicExtras(ctx)
  // 名所：千本鸟居、海上鸟居、奥宫、神桥、山寺、山上的修道院、岩上的城……（按地形挑地方，见 sacred.ts）
  sacredSites(ctx)
  keepDry(ctx)
  // 聚落名等桥、渡口定下再取：有桥才叫"某某桥"
  const cross = ctx.out.crossings
  const crossing = cross.some((c) => c.kind === 'bridge') ? 'bridge' : cross.some((c) => c.kind === 'ferry') ? 'ferry' : cross.length ? 'ford' : null
  const town = namer.settlement(p.size, p.coast, p.river, crossing)
  const riverName = T.river ? namer.river() : null
  const seaName = T.coast ? namer.sea() : null
  labels(ctx, riverName, seaName)

  const inner = ctx.out.wards.filter((w) => w.inner)
  const innerArea = inner.reduce((s, w) => s + area(w.poly), 0)
  const dwellings = ctx.out.buildings.filter((b) => b.kind === 'house' || b.kind === 'large')
  const houses = dwellings.length
  const units = dwellings.reduce((s, b) => s + (b.units ?? 1), 0)
  return {
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
    stats: {
      buildings: ctx.out.buildings.filter((b) => b.kind !== 'shed').length,
      houses,
      households: units,
      population: Math.round((units * perHousehold(p.culture)) / 10) * 10,
      area: innerArea / 10000,
      ms: performance.now() - t0,
    },
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
    const q: P = [MW / 2 + Math.cos(a) * r, MH / 2 + Math.sin(a) * r]
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
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  let t = Infinity
  if (dx > 1e-6) t = Math.min(t, (MW - 2 - c[0]) / dx)
  if (dx < -1e-6) t = Math.min(t, (2 - c[0]) / dx)
  if (dy > 1e-6) t = Math.min(t, (MH - 2 - c[1]) / dy)
  if (dy < -1e-6) t = Math.min(t, (2 - c[1]) / dy)
  return [c[0] + dx * t, c[1] + dy * t]
}

/** 由中心通往地图边缘的干道：沿地形寻路，后修的路尽量并入已有的路 */
function routeArterials(ctx: Ctx): P[][] {
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
      stops.push(dryNear(ctx, [ctx.center[0] + Math.cos(dir) * r, ctx.center[1] + Math.sin(dir) * r]))
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
  }
  return roads
}

/** 干道路标点离城心的半径（米） */
const WAYPOINTS = [120, 250, 500, 1000, 2000, 4000]

/** 路标点落水时，沿同一半径左右挪到最近的旱地（挪法只看位置，与地图大小无关） */
function dryNear(ctx: Ctx, q: P): P {
  const c = ctx.center
  const r = dist(q, c)
  const a0 = Math.atan2(q[1] - c[1], q[0] - c[0])
  for (let k = 0; k < 24; k++) {
    const a = a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.06
    const p: P = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]
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
const wallNext = (pop: number) => Math.min(2.25, Math.max(1.45, 2.25 - 0.36 * Math.log2(pop / 1200)))
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
  const need = Math.round(((pop / perHousehold(p.culture)) / housesPerHa({ ...p, population: pop })) * 10000 / (0.87 * PATCH * PATCH * 0.9))
  return Math.max(scaleOf(pop).cfg.inner, need)
}
/** 人口为 pop 时的城区半径估计 */
const rinFor = (p: SettlementParams, pop: number) => Math.sqrt((innerFor(p, pop) * 0.87 * PATCH * PATCH) / Math.PI)

/** 第 k 个副中心出现时的人口（与 growInner 里副中心开始生长的时刻一致） */
const subBirth = (p: SettlementParams, k: number, n: number) => Math.min(SUB_BIRTH * (k + 1), (p.population * (k + 1)) / (n + 1))

/**
 * 副中心选址，按"出生时"定：第 k 个副中心在城市长到 subBirth 人时出现，离城心多远、自己多大
 * 都按那时的城区半径算；候选只取最早两条干道上的点与城心周围一圈，打分的扰动按位置取。
 * 先出现的定下后不再变，后出现的只在它们之后挑——城市继续长大时副中心不会搬家。
 * 距离随 spread：0 时约 0.7 ~ 1.0 个城区半径（与主城粘连成一片），1 时 1.5 ~ 2 个（隔着田野的卫星城）。
 * 每个副中心的方格朝向取所在干道的走向，各片城区的街网于是各有方向。
 */
function pickSubcenters(ctx: Ctx, arterials: P[][], n: number): Core[] {
  const { T, cfg, center: c, p } = ctx
  const fold = (a: number) => a - Math.round(a / (Math.PI / 2)) * (Math.PI / 2)
  const s = p.spread * p.spread
  const out: (Core & { a: number })[] = []
  for (let k = 0; k < n; k++) {
    const Rb = rinFor(p, subBirth(p, k, n))
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
        const along = Math.atan2(road[i + 1][1] - road[i - 1][1], road[i + 1][0] - road[i - 1][0])
        cands.push({ p: q, a: Math.atan2(q[1] - c[1], q[0] - c[0]), angle: fold(along), score: 1 + hashAt(ctx, q, 'sub.road', k) * 0.3 })
      }
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2
      const r = (d0 + d1) / 2
      const q: P = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]
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
    .sort((a, b) => Math.atan2(a[1] - ctx.center[1], a[0] - ctx.center[0]) - Math.atan2(b[1] - ctx.center[1], b[0] - ctx.center[0]))
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
    const aa = Math.atan2(a[1] - ctx.center[1], a[0] - ctx.center[0])
    const ab = Math.atan2(b[1] - ctx.center[1], b[0] - ctx.center[0])
    let da = Math.abs(aa - ab)
    if (da > Math.PI) da = Math.PI * 2 - da
    if (da > Math.PI * 0.75) continue
    const raw = routeOnTerrain(ctx.T, a, b, { water: 14, slope: 1, bias })
    if (raw.length > 1) out.push(straighten(smoothRoute(raw, 4, ctx.T), ctx.p.regularity))
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
}

function growInner(ctx: Ctx, patches: Patch[], plannedPop: number, arterials: P[][]): Growth {
  const { T, cfg } = ctx
  const typical = cfg.patch * cfg.patch * 0.87
  const dist = layoutDist(ctx, arterials)
  const cost = (i: number) => {
    const q = patches[i].site
    // 规划区是建城时的底子：先于有机的外城加入，片区再大也不算"稀疏"
    if (patches[i].planned || patches[i].palace !== undefined) return dist(q) * 0.3 * (1 + T.slopeAt(q) * 5)
    // 过大的片区（稀疏处的 Voronoi 单元）不适合作城区
    const big = Math.max(1, area(patches[i].poly) / typical)
    return dist(q) * (1 + T.slopeAt(q) * 5) * (0.85 + hashAt(ctx, q, 'grow.cost') * 0.3) * big
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
  const perHa = housesPerHa(ctx.p)
  // 城区长到住得下现在的人口；有城墙时长到城墙规划的容量（墙内先是稀疏的）
  // 余量：小城镇片区少、占用率的软边缘占比大，要多留；大城市留一点就够（余量多了外围会长出一大圈空着的疏档片区）
  const margin = !ctx.env.big ? 1.35 : ctx.p.population < 8000 ? 1.3 : 1.06
  // 撒祠、村社要拆的几户也留出地方（见 tiers.ts 的 tierReserve）
  const need = Math.max(ctx.houseBudget, plannedPop / perHousehold(ctx.p.culture)) * margin * tierReserve(ctx.p.culture)
  // 密度档在片区加入时就定了（看那时城区多大、离干道多近），容量按档计
  // 城镇按民居片区盖满的实测容量，扣掉约四分之一不住人的片区（广场、寺庙、公园……）；村落按平均
  const townlike = ctx.p.size === 'town' || ctx.p.size === 'city'
  // 特殊片区（广场、市集、寺庙、墓地、城堡……）各占一整块、几乎不住人：先算作没有容量。小城镇里它们占的比例很大
  let special = townlike ? ctx.cores.length + FEATURES.filter((f) => f.form === 'ward' && !LIVED.has(f.id)).reduce((s, f) => s + (ctx.counts[f.id] ?? 0), 0) : 0
  // 片区的"年龄"按名义容量（特殊片区也当作一块中档民居）累计，0 是老城、1 是现在城区的边缘
  const perPatch = townlike ? (typical * fullPerHa(ctx.p.culture, 'common', 'mid') * RESIDENTIAL) / 10000 : 0
  const hh = Math.max(1, (ctx.p.population / perHousehold(ctx.p.culture)) * margin + special * perPatch)
  let nominal = 0
  const ages = new Map<number, number>()
  const capacity = (i: number) => {
    ages.set(i, nominal / hh)
    const d = (patches[i].density ??= densityAt(ctx, patches[i].site, nominal / hh, arterials))
    const c = (area(patches[i].poly) * patches[i].land * (townlike ? fullPerHa(ctx.p.culture, 'common', d) * RESIDENTIAL : perHa)) / 10000
    nominal += c
    if (special > 0) {
      special--
      return 0
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
  const per = perHousehold(ctx.p.culture)
  const births = seeds.slice(1).map((i, k) => ({ i, at: (subBirth(ctx.p, k, seeds.length - 1) / per) * margin }))
  seed(seeds[0])
  let n = 1
  for (;;) {
    while (births.length && cap >= births[0].at) {
      seed(births.shift()!.i)
      n++
    }
    if (!(cap < need && n < cfg.inner * (ctx.env.big ? 4 : 8) && front.length)) break
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
  return { order, cum, margin, ages }
}

/** 住人片区（民居、商人、工匠……）的容量折扣：街角的水井、小广场、零星空地 */
const RESIDENTIAL = 0.95
/** 住人的成片片区；其余按片区放的要素（广场、寺庙、城堡……）几乎不住人 */
const LIVED = new Set<FeatureId>(['merchant', 'craft', 'slum'])

/** 片区的密度档：年龄、离对外干道多近、平滑噪声（见 scale.ts 的 densityOf） */
function densityAt(ctx: Ctx, q: P, age: number, arterials: P[][]): Density {
  let gap = Infinity
  for (const r of arterials) gap = Math.min(gap, polylineDist(q, r))
  return densityOf(ctx.p.population, age, Math.exp(-gap / (ctx.cfg.patch * 0.8)), smoothNoise(ctx, q, 240, 'density'))
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
    pa.density ??= densityAt(ctx, pa.site, Math.max(0, ...pa.nb.map((j) => g.ages.get(j) ?? 0)), arterials)
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
  // 沿对外干道长：离干道越近越"近"，城区沿大路伸出触角（大城的轮廓是星形而不是圆）
  const pull = ctx.env.big ? 0.5 : 0.25
  const reach = ctx.cfg.patch * 2.2
  // 大片的起伏（城越大越明显）：轮廓有凸有凹，不是一个圆
  const wob = ctx.env.big ? 0.35 + 0.35 * Math.min(1, Math.log2(Math.max(1, ctx.p.population / 8000)) / 3) : 0.25
  const shape = ctx.plan ? planShape(ctx.plan.z) : null
  return (q: P) => {
    let d = Infinity
    frames.forEach(({ f, k }, i) => {
      // 有规划区时主城心按规划区的形状量远近（轮廓上处处等远）：城区顺着规划区由内往外住满，外城也随之展开
      if (i === 0 && shape) {
        d = Math.min(d, shape(q) * k)
        return
      }
      const [u, v] = f.toUV(q)
      const cheb = Math.max(Math.abs(u), Math.abs(v)) * 1.12
      d = Math.min(d, (Math.hypot(u, v) * (1 - sq) + cheb * sq) * k)
    })
    let gap = Infinity
    for (const r of arterials) gap = Math.min(gap, polylineDist(q, r))
    return d * (1 - pull * Math.exp(-gap / reach)) * (1 + (smoothNoise(ctx, q, 260, 'layout.shape') - 0.5) * wob)
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
    const far: P = [z.c[0] + Math.cos(a) * 1e5, z.c[1] + Math.sin(a) * 1e5]
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
    const t = (((Math.atan2(dy, dx) / (Math.PI * 2)) % 1) + 1) % 1 * N
    const k0 = Math.floor(t) % N
    const f = t - Math.floor(t)
    const r = rim[k0] * (1 - f) + rim[(k0 + 1) % N] * f
    return (Math.hypot(dx, dy) * Req) / Math.max(1, r)
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
 * 各片区的占用率（0 ~ 1，每块宅地按位置哈希决定盖不盖，所以占用率升高只会多盖、已有的房子不动）：
 * - 城内：离核心近的高、远的低，中间是约三个片区宽的软过渡；过渡带的位置 r 取到"预计户数 ≈ 目标户数"；
 * - 城门外的城郊（关厢）：城墙里住得越满越多，越靠近城门越密；没有城墙时和城内一样按距离渐变；
 * - 特殊片区、田间照常盖。
 */
function occupancy(ctx: Ctx, patches: Patch[], stages: WallStage[]): { fill: number[]; d: number[] } {
  const perHa = housesPerHa(ctx.p)
  // 城内片区按功能与密度档的实测容量；城郊按平均
  const townlike = ctx.p.size === 'town' || ctx.p.size === 'city'
  const cap = (pa: Patch) => (area(pa.poly) * pa.land * (townlike && pa.inner && pa.type ? fullPerHa(ctx.p.culture, pa.type, pa.density ?? 'mid') : perHa)) / 10000
  const PLAIN = new Set<WardType | undefined>(['common', 'merchant', 'craft', 'slum', 'noble'])
  const W = ctx.cfg.patch * 1.5
  // 按布局的距离（方格布局下等距线是方的），再叠一层平滑噪声和逐块扰动：外围有进有出，不是完美的同心渐变
  const ld = layoutDist(ctx, ctx.out.roads.filter((r) => r.kind === 'main' || r.kind === 'highway').map((r) => r.line))
  // 城越大，边缘的起伏越大
  const wob = ctx.env.big ? 0.5 + 0.3 * Math.min(1, Math.log2(Math.max(1, ctx.p.population / 8000)) / 3) : 0.5
  const d = patches.map((pa) => ld(pa.site) * (1 + (smoothNoise(ctx, pa.site, 220, 'occupancy') - 0.5) * wob) + (hashAt(ctx, pa.site, 'occupancy.jitter') - 0.5) * ctx.cfg.patch)
  const gates = ctx.cityWalls.flatMap((w) => w.gates.map((g) => g.p))
  const last = stages.at(-1)
  // 关厢：城墙里快住满时开始在城门外出现，人口越过城墙的容量越多
  const faubourg = last ? sm01(0.8, 1.5, ctx.p.population / last.cap) : 0
  // 城市已经远远长出最外那道墙：城郊与墙外城区一样按距离渐变；刚溢出时，城郊的房子聚在城门口
  const outgrown = !last || ctx.p.population > last.cap * 1.5 || !gates.length
  const subFill = (pa: Patch) => faubourg * Math.exp(-Math.min(...gates.map((g) => dist(g, pa.site))) / 220)
  const byDist = (i: number, r: number) => 1 - sm01(r - W, r + W, d[i])
  // 估算按盖满的实测值，部分占用的片区实际盖得少一些：目标留足余量（盖房由内往外，预算用完截掉的是最外围）
  // 撒祠、村社、堂区教堂要拆掉几户（见 tiers.ts），多留出这一点
  const target = ctx.houseBudget * 1.2 * tierReserve(ctx.p.culture)
  const expect = (r: number) => {
    let sum = 0
    patches.forEach((pa, i) => {
      if (pa.inner && PLAIN.has(pa.type)) sum += cap(pa) * byDist(i, r)
      else if (pa.type === 'suburb') sum += cap(pa) * 0.6 * (outgrown ? byDist(i, r) : subFill(pa))
    })
    return sum
  }
  let lo = 0
  let hi = Math.max(...d) + W * 2
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2
    if (expect(mid) < target) lo = mid
    else hi = mid
  }
  const r = hi
  const fill = patches.map((pa, i) => {
    if (pa.inner && PLAIN.has(pa.type)) return byDist(i, r)
    if (pa.type === 'suburb') return outgrown ? byDist(i, r) : subFill(pa)
    return 1
  })
  return { fill, d }
}
const sm01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 人口为 pop 时的城区（生长顺序的前缀，再填上四周都是城区的洞） */
function innerAt(ctx: Ctx, patches: Patch[], g: Growth, pop: number): boolean[] {
  const need = (pop / perHousehold(ctx.p.culture)) * g.margin
  const set = patches.map(() => false)
  for (let k = 0; k < g.order.length; k++) {
    set[g.order[k]] = true
    if (g.cum[k] >= need) break
  }
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
  const w = Math.pow(ctx.p.regularity, 1.3) * (shared ? 0.35 : 1)
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
    rr += Math.hypot(u, v)
  }
  hu = (hu / dense.length) * 1.25
  hv = (hv / dense.length) * 1.25
  rr /= dense.length
  const out = dense.map((v) => {
    const dx = v[0] - c[0]
    const dy = v[1] - c[1]
    const L = Math.hypot(dx, dy) || 1
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
  const thickness = 4
  const wall: Wall = { loop: pts, solid, towers, gates: [], kind: 'stone', thickness }
  ctx.out.walls.push(wall)
  for (let i = 0; i < n; i++) if (solid[i]) ctx.corridors.add([pts[i], pts[(i + 1) % n]], thickness / 2 + 3, 'wall')
}

/** 把一组片区栅格化、减去海面，追踪外轮廓，简化后向规整形状变形；只要里面有核心的轮廓（每片城区一道） */
function wallLoops(ctx: Ctx, patches: Patch[], set: boolean[]): P[][] {
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
    // 先把片区轮廓的锯齿磨成圆润的外廓；规整时再向矩形（方格）或圆形（放射）收拢；最后整理成一段段直墙
    const target = morphWall(ctx, smoothLoop(simp), inside[0], inside.length > 1)
    // 城墙贴着街走：取中心落在目标外廓里的片区，它们合起来的外边界（片区之间的公共边就是街）作为城墙
    const along = patchOutline(patches, target, inside.map((c) => c.c))
    loops.push(cleanLoop(along ?? target, ctx.p.size === 'city' ? 14 : 10))
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
 * 城墙外廓：从轮廓的形心往外看，每个方向取轮廓最远的交点作半径，只留最平缓的几个起伏（傅里叶低通），
 * 再略放大到罩住绝大部分轮廓。于是城墙是一条圆润的曲线，折成约 50 米一段的直墙，不随片区边界凹凹凸凸。
 */
function smoothLoop(loop: P[]): P[] {
  const c = centroid(loop)
  const N = 144
  const rs: number[] = []
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2
    const d: P = [Math.cos(a), Math.sin(a)]
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
        ca += r * Math.cos(t)
        sa += r * Math.sin(t)
      })
      const t = (j / N) * Math.PI * 2 * h
      v += ((2 * ca) / N) * Math.cos(t) + ((2 * sa) / N) * Math.sin(t)
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
    return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r] as P
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
  const sets = stages.map((st) => innerAt(ctx, patches, growth, st.cap))
  const size = (set: boolean[]) => set.filter(Boolean).length
  // 形制自带的城墙（里坊的方形外郭……）：按规划一次筑成，只有这一道
  const planned = stages.length ? ctx.plan?.def.wall?.(ctx, ctx.plan.z) : null
  // 形制不修城墙（返回空的轮廓，如城下町）
  if (planned && !planned.length) return
  // 最外一道石墙挖不挖护城河：形制说了算，否则看文明，要塞城都挖，别的城大多挖
  const moatFor = (st: WallStage) => st.kind === 'stone' && (ctx.plan?.def.moat ?? (CULTURE_INFO[ctx.p.culture].moat || ctx.p.function === 'fortress' || hashAt(ctx, ctx.center, 'wall.moat') < 0.65))
  if (planned) {
    const st = stages[stages.length - 1]
    ctx.cityWalls.push(wallFromLoop(ctx, planned, st.kind, arterials, { barbicans: ctx.counts.barbican, moat: moatFor(st) }))
  }
  // 城区没怎么长（地形逼仄）：和下一道几乎重合的旧墙不画
  const drawn = (k: number) => k === stages.length - 1 || size(sets[k]) < size(sets[k + 1]) * 0.85
  const loopsBy = planned ? [] : stages.map((_, k) => (drawn(k) ? wallLoops(ctx, patches, sets[k]) : []))
  // 旧墙（内城墙、残墙与环城路）只留在新墙里面的部分：跑到新墙外面、或贴着新墙的那段，修新墙时已经拆掉或并进了新墙
  const outerLoops = (loopsBy[stages.length - 1] ?? []).map((L) => [...L, L[0]])
  const within = (q: P) => outerLoops.some((L) => pointInPoly(q, L) && polylineDist(q, L) > 15)
  if (!planned) stages.forEach((st, k) => {
    const last = k === stages.length - 1
    if (!drawn(k)) return
    const age = stages.length - 1 - k
    // 上一道留作内城，或拆了筑环城大道、留几段残墙（见 CultureInfo.innerWall）
    const keep = last || (CULTURE_INFO[ctx.p.culture].innerWall && st.kind === 'stone' && age === 1)
    for (const loop of loopsBy[k]) {
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
  const R = rinFor(ctx.p, Math.max(1500, ctx.p.population * s)) * (def.scale ?? 1)
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
    const du = Math.round(Math.cos(a) * 1e6) / 1e6
    const dv = Math.round(Math.sin(a) * 1e6) / 1e6
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
    const dir = Math.atan2(raw[k][1] - z.c[1], raw[k][0] - z.c[0])
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
  // 生长历史：每块地加入时的累计户数（填洞、城墙圈进来的，按它相邻片区里最晚加入的算）
  const joinedAt = new Map(growth.order.map((i, k) => [i, growth.cum[k]]))
  const when = (i: number) => joinedAt.get(i) ?? Math.max(0, ...patches[i].nb.map((j) => joinedAt.get(j) ?? 0))
  const lots: Lot[] = idx.map((i) => ({
    poly: patches[i].poly,
    site: patches[i].site,
    nb: patches[i].nb.filter((j) => pos.has(j)).map((j) => pos.get(j)!),
    deg: patches[i].nb.length,
    joinedAt: when(i),
    type: patches[i].type,
  }))
  // 累计户数 → 那时的人口
  zoneLots(ctx, lots, pos.get(0) ?? -1, (cum) => (cum / growth.margin) * perHousehold(ctx.p.culture))
  lots.forEach((l, k) => {
    patches[idx[k]].type = l.type
    if (l.palace !== undefined) patches[idx[k]].palace = idx[l.palace]
    if (l.grand) patches[idx[k]].grand = true
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
  const streets = (p.size === 'hamlet' ? [] : ctx.cores.flatMap((c, i) => [...latticeStreets(ctx, c, i), ...radialStreets(ctx, c, i)])).filter((l) => !l.some(reserved))
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
    // 城内段为主街、城外段为大路
    let k = road.findIndex((q) => !inside(q))
    if (k < 0) k = road.length
    const inner = road.slice(0, Math.min(road.length, k + 1))
    const outer = road.slice(Math.max(0, k))
    const small = isVillage(p.size)
    if (inner.length > 1) ctx.out.roads.push({ line: inner, width: ctx.plan?.def.mainWidth ?? cfg.main, kind: 'main', name: p.size === 'hamlet' ? undefined : ctx.namer.street(small ? 'street' : 'main') })
    if (outer.length > 1) ctx.out.roads.push({ line: outer, width: cfg.highway, kind: 'highway' })
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
  // 占用率：城内按离核心的距离渐变（软边界），城门外的关厢随城墙里住满的程度出现（见 occupancy）
  const { fill, d: layoutD } = occupancy(ctx, patches, stages)
  // 村巷等知道哪些地会有人家以后再修：只通往占用率够的片区，不修通往空地的巷子
  if (isVillage(p.size)) {
    const old = new Set(ctx.out.roads)
    villageLanes(ctx, patches, arterials, (i) => fill[i] > 0.25)
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
  const wards: Ward[] = patches.map((pa) => ({ poly: pa.poly, type: pa.type ?? 'wild', inner: pa.inner, density: pa.inner && !small ? pa.density : undefined, ...(pa.grand ? { tier: 'grand' as const } : {}) }))
  ctx.out.wards.push(...wards)
  // 顺序与占用率用同一套"布局距离"：预算用完时截掉的是布局意义上最外围的，而不是按直线距离截成一个圆
  const order = patches.map((pa, i) => [layoutD[i] + (pa.inner ? 0 : 1e6), i] as const).sort((a, b) => a[0] - b[0])
  for (const [, i] of order) {
    ctx.rng = wardRng(ctx, patches[i].site)
    ctx.wardFill = fill[i]
    ctx.wardDensity = small ? 'low' : (patches[i].density ?? 'mid')
    const rng = ctx.rng
    const pa = patches[i]
    const ward = wards[i]
    const type = ward.type
    if (type === 'water') continue
    // 整块在画面外（布点时多铺的一圈）：不盖东西
    if (pa.poly.every((v) => v[0] < 0 || v[1] < 0 || v[0] > ctx.MW || v[1] > ctx.MH) && !pa.inner) continue
    const lane = pa.inner ? cfg.lane / 2 + rng.next() * 0.8 : 2
    // 村落的片区边界大多不是路：只有真修了路的边才让出路面，其余只留一道细缝（田埂、篱笆）
    // 并成一片的农田之间也只是一道田埂
    const group = fields.get(i)
    const insets = pa.poly.map((v, k) => {
      const d = lane * (0.8 + rng.next() * 0.4)
      const w = pa.poly[(k + 1) % pa.poly.length]
      const mid: P = [(v[0] + w[0]) / 2, (v[1] + w[1]) / 2]
      const mate = group?.seams.some(([a, b]) => segDist(mid, a, b).d < 0.5)
      if (!small && !mate) return d
      return ctx.corridors.hits(mid, 0.5) ? d : mate ? 0 : 0.6
    })
    let block = insetConvex(pa.poly, insets)
    if (block.length < 3) continue
    // 片区开盖前的检查点：盖完一户也没住上的片区整个撤回；small / micro 只动这之后本片区自己盖的东西
    const cp = checkpoint(ctx)
    if (pa.inner) {
      const b = clipWater(ctx, block, 1.5)
      if (b) ctx.out.blocks.push(b)
    }
    // 都城的宫城：几块片区合起来，轮到主片区时一次盖好（宫殿占其中最大的矩形，其余是御苑），别的几块跳过
    if (pa.palace !== undefined) {
      if (pa.palace !== i) {
        // 宫城没能合成一片（主片区照原样盖宫殿）：这几块是御苑
        if (!palaces.has(pa.palace)) FEATURE.park.build!(ctx, ward, block, ctx.env)
        continue
      }
      block = palaces.get(i) ?? block
    }
    // 合成的大地标：按 grand 档盖（大社、朝圣大教堂、大园囿、同心城）
    ctx.tier = pa.grand && pa.palace === i && palaces.has(i) ? 'grand' : 'standard'
    // 规划片区的专属填法（坊墙、十字街……）
    if (pa.planned && pa.inner && plan?.def.build?.(ctx, ward, block, plan.z)) continue
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
        if (small) villageGreen(ctx, block)
        else if (!styled()) FEATURE.park.build!(ctx, ward, block, ctx.env)
        break
      case 'suburb': {
        if (!styled()) urban(ctx, block, 'suburb', [], 26)
        // 城郊沿路的人家之间也有路边的祠、十字架、塔楼民居
        wardExtras(ctx, ward, block, cp)
        break
      }
      case 'farm':
        if (villages.centers.has(i) || villages.members.has(i)) {
          // 城外的村子：村中是公地与水井，周围几块地是村舍；村民不算城里的人口
          ctx.uncounted = true
          if (villages.centers.has(i)) {
            villageGreen(ctx, block)
            ward.name = ctx.namer.town('village', false, false)
          } else {
            urban(ctx, block, 'village', [])
            wardExtras(ctx, ward, block, cp)
          }
          ctx.uncounted = false
        } else farm(ctx, block, veg, group)
        break
      case 'wild':
        wild(ctx, block, veg)
        break
      default: {
        const nb = ctx.out.buildings.length
        // 文明有自己的盖法先用它；否则商贸城的城心是摊位更多的大市场
        if (!styled()) {
          if (i === 0 && type === 'market') plaza(ctx, ward, block, 2.5)
          else (FEATURE[type as FeatureId] ?? FEATURE.common).build!(ctx, ward, block, ctx.env)
        }
        // 规划进城区、却一户也没盖上的外围民居 / 工匠 / 商人片区（预算先在里面用完了；村里沿路的人家没排到这块）：还是菜园、农田，不算城区
        if ((type === 'common' || type === 'craft' || type === 'merchant') && pa.inner && !ctx.out.buildings.slice(nb).some((b) => b.kind === 'house' || b.kind === 'large')) {
          rollback(ctx, cp)
          ward.inner = false
          ward.type = 'farm'
          ward.density = undefined
          farm(ctx, block, veg)
        } else wardExtras(ctx, ward, block, cp)
      }
    }
    if (royal) ctx.uncounted = false
  }
  ctx.tier = 'standard'
  ctx.rng = baseRng
  ctx.wardFill = 1
  ctx.wardDensity = 'mid'
  // 城堡、宫城、卫城的门：接不上路的修一条门前街（或挪门、不开那座门）
  connectGates(ctx)
  // 塔楼不落水
  keepTowersDry(ctx)
  if (ctx.plan?.def.avenueTrees !== false) avenueTrees(ctx)
  nameDistricts(ctx)
}

/**
 * 院墙、庭院、菜园、墓地、广场这些成片的地面都要落在岸上：各处生成时只让开了道路，
 * 地块、街坊贴着河岸时会探进水里。统一收到离水 1 米以内，整个在水里的去掉。
 */
function keepDry(ctx: Ctx) {
  const { T } = ctx
  const wetEdge = (poly: Poly, m: number) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      for (let t = 0; t <= 1; t += 3 / Math.max(3, dist(a, b))) if (T.waterAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) < m) return true
    }
    return false
  }
  const dry = (poly: Poly) => {
    if (!wetEdge(poly, 1)) return poly
    // 边加密到 3 米，压水的点沿水距场的梯度推回岸上：院墙顺着河岸收边
    const q = resample([...poly, poly[0]], 3)
      .slice(0, -1)
      .map((v): P => {
        const w = T.waterAt(v)
        if (w >= 1) return v
        const g = T.waterGrad(v)
        return [v[0] + g[0] * (1 - w), v[1] + g[1] * (1 - w)]
      })
    // 跨过整条河、推不回来的整个去掉
    return area(q) > 20 && T.waterAt(centroid(q)) > 1 && !wetEdge(q, -1) ? q : null
  }
  const o = ctx.out
  o.enclosures = o.enclosures.map(dry).filter((q): q is Poly => !!q)
  o.plazas = o.plazas.map(dry).filter((q): q is Poly => !!q)
  o.greens = o.greens.flatMap((g) => {
    const q = dry(g.poly)
    return q ? [{ ...g, poly: q }] : []
  })
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
  const side0 = Math.min(340, Math.max(ctx.cfg.patch * 2.1, Math.sqrt(ctx.p.population) * 1.6))
  // 朝向：东方坐北朝南（横向是东西）；西式、别的正面朝城心（进深沿着离开城心的方向，楼后是纵深的园林）
  const axes = (dir: number): [P, P] => {
    const a = south ? 0 : dir + Math.PI / 2
    const u: P = [Math.cos(a), Math.sin(a)]
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
        const r = t * Math.hypot(W, D) * 0.5
        const c: P = [ctx.center[0] + Math.cos(dir) * r, ctx.center[1] + Math.sin(dir) * r]
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
  ctx.out.roads = ctx.out.roads.flatMap((r) => {
    const pts = resample(r.line, 3)
    if (!pts.some((q) => gone(r, q))) return [r]
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
  ctx.out.roads = trimDangling(ctx.out.roads, ctx.T)
  ctx.out.crossings = ctx.out.crossings.filter((c) => !deep(c.a) && !deep(c.b) && ctx.out.roads.some((r) => r.kind !== 'path' && polylineDist(c.a, r.line) < 2.5 && polylineDist(c.b, r.line) < 2.5))
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
  const axis: P = royal && east ? [1, 0] : !royal && east ? [Math.cos(ctx.gridAngle), Math.sin(ctx.gridAngle)] : obb(U).axis
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
    ctx.out.greens.push({ poly: g, kind: 'park' })
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
 * 田野不再是一格格一样大的 Voronoi 块。按位置哈希挑，城长大时已有的分组不变。
 */
function farmGroups(ctx: Ctx, patches: Patch[], ok: (i: number) => boolean) {
  const out = new Map<number, FarmGroup>()
  const order = patches.map((pa, i) => [hashAt(ctx, pa.site, 'farm.group'), i] as const).sort((a, b) => a[0] - b[0])
  for (const [h, i] of order) {
    if (out.has(i) || !ok(i)) continue
    // 三成单独一块，其余两到三块一片
    const want = h < 0.3 ? 1 : h < 0.75 ? 2 : 3
    const members = [i]
    for (let k = 0; k < members.length && members.length < want; k++)
      for (const j of patches[members[k]].nb) {
        if (members.length >= want || out.has(j) || members.includes(j) || !ok(j)) continue
        const e = sharedEdge(patches[members[k]], patches[j])
        if (e && dist(e[0], e[1]) > 20) members.push(j)
      }
    if (members.length < 2) continue
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
    for (const a of members) for (const b of members) if (a < b) {
      const e = sharedEdge(patches[a], patches[b])
      if (e) g.seams.push(e)
    }
    for (const j of members) out.set(j, g)
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
  const cands = patches
    .map((pa, i) => ({ pa, i, key: hashAt(ctx, pa.site, 'village.pick') }))
    .filter(({ pa }) => {
      const q = pa.site
      if (pa.type !== 'farm' || pa.inner || pa.land < 0.85) return false
      if (q[0] < 60 || q[1] < 60 || q[0] > ctx.MW - 60 || q[1] > ctx.MH - 60) return false
      if (centerDist(ctx, q) < gapCity || ctx.T.slopeAt(q) > 0.12) return false
      if (ctx.plan?.z.contains(q)) return false
      return ctx.corridors.gap(q) < spacing(ctx, q) * 0.8
    })
    .sort((a, b) => a.key - b.key)
  const made: P[] = []
  const flat = (j: number) => patches[j].type === 'farm' && !patches[j].inner && patches[j].land >= 0.85 && ctx.T.slopeAt(patches[j].site) < 0.12
  for (const { pa, i } of cands) {
    if (made.some((m) => dist(m, pa.site) < 720)) continue
    out.add(i)
    made.push(pa.site)
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
  // Dijkstra（图很小，直接线性取最小）
  const prev = new Map<string, string>()
  const done = new Set<string>()
  for (;;) {
    let u: string | null = null
    for (const [k, c] of cost) if (!done.has(k) && (u === null || c < cost.get(u)!)) u = k
    if (u === null) break
    done.add(u)
    for (const { to, L } of adj.get(u) ?? []) {
      const c = cost.get(u)! + L
      if (c < (cost.get(to) ?? Infinity)) {
        cost.set(to, c)
        prev.set(to, u)
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
    const L = polylineLength(r.line)
    if (L < 60) continue
    const ring = dist(r.line[0], r.line[r.line.length - 1]) < 20 && L > 200
    if (!ring && hashAt(ctx, r.line[Math.floor(r.line.length / 2)], 'avenue') > 0.6) continue
    const off = r.width / 2 + 0.9
    for (let s = 6; s < L - 6; s += 9) {
      const { p, angle } = pointAt(r.line, s)
      const n: P = [-Math.sin(angle), Math.cos(angle)]
      for (const side of [-1, 1]) {
        const q: P = [p[0] + n[0] * off * side, p[1] + n[1] * off * side]
        if (ctx.T.waterAt(q) < 3 || ctx.occ.hitsPoint(q, 1.6)) continue
        // 路口：离别的路太近就不种
        if (mains.some((o) => o !== r && polylineDist(q, o.line) < o.width / 2 + 2)) continue
        ctx.out.trees.push({ p: q, r: 2.3 + hashAt(ctx, q, 'avenue.tree') * 0.6 })
      }
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
      const q: P = [center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]
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
      if (rng.next() < 0.7) addBoat(ctx, [end[0] + g[0] * L * 0.3 + n[0] * (2.8 + len * 0.18) * s, end[1] + g[1] * L * 0.3 + n[1] * (2.8 + len * 0.18) * s], Math.atan2(-g[1], -g[0]), len)
    }
    ctx.out.roads.push({ line: route, width: ctx.cfg.lane, kind: 'lane' })
    made.push(q)
  }
}

/** 村公地：草地、水井与几棵大树 */
/** 沿边每 3 米查一遍，压水（离水不到 m 米）的地方朝形心方向切掉：河从一角斜穿过去也能收到岸上 */
function dryPoly(ctx: Ctx, poly: Poly, m: number): Poly | null {
  let out = poly
  for (let pass = 0; pass < 12; pass++) {
    let worst: P | null = null
    let wv = m
    for (const q of resample([...out, out[0]], 3)) {
      const w = ctx.T.waterAt(q)
      if (w < wv) {
        wv = w
        worst = q
      }
    }
    if (!worst) return out
    // 河心附近梯度不可靠：朝形心的方向退回岸上
    const c = centroid(out)
    const L = dist(c, worst) || 1
    const g: P = [(c[0] - worst[0]) / L, (c[1] - worst[1]) / L]
    out = clipHalf(out, [worst[0] + g[0] * (m + 1 - wv), worst[1] + g[1] * (m + 1 - wv)], [-g[0], -g[1]])
    if (out.length < 3 || area(out) < 100) return null
  }
  return null
}

function villageGreen(ctx: Ctx, block: Poly) {
  const w = clipWater(ctx, insetConvex(block, 4), 4)
  const g = w && ctx.corridors.clip(w)
  if (!g) {
    // 路从中间穿过（放不下一圈草地与井）：整块就是村里的公地草场，路从草场上过
    const common = dryPoly(ctx, block, 2)
    if (common) {
      ctx.out.greens.push({ poly: common, kind: 'park' })
      scatterTrees(ctx, insetConvex(common, 3), 0.0015, 3.5, 5.5)
    }
    return
  }
  const c = centroid(g)
  const r = Math.min(22, Math.sqrt(area(g)) * 0.3)
  const green = insetConvex(circlePoly(c, r, 18), 0)
  const gi = ctx.out.greens.length
  ctx.out.greens.push({ poly: green, kind: 'park' })
  ctx.out.landmarks.push({ p: c, kind: 'well' })
  for (let k = 0; k < 3; k++) {
    const a = ctx.rng.next() * Math.PI * 2
    const t: P = [c[0] + Math.cos(a) * r * 0.6, c[1] + Math.sin(a) * r * 0.6]
    if (!ctx.corridors.hits(t, 1) && !ctx.occ.hitsPoint(t, 2)) ctx.out.trees.push({ p: t, r: 4 + ctx.rng.next() * 2 })
  }
  const nb = ctx.out.buildings.length
  urban(ctx, block, 'village', [circlePoly(c, r + 4, 18)])
  // 四周一户也没盖（小村的人家都在别处）：整块是公地草场，井在当中
  const common = ctx.out.buildings.length === nb ? dryPoly(ctx, block, 2) : null
  if (common) ctx.out.greens.splice(gi, 0, { poly: common, kind: 'park' })
}

/** 城里跨河的额外桥：沿河每隔一段架一座，桥头的短街切开街坊 */
function extraBridges(ctx: Ctx, inside: (q: P) => boolean) {
  const { T, cfg, p } = ctx
  if (!T.river || isVillage(p.size)) return
  const line = T.river.line
  const L = polylineLength(line)
  const existing: P[] = []
  for (const r of ctx.out.roads) for (const q of r.line) if (T.waterAt(q) < 0) existing.push(q)
  const gap = p.size === 'city' ? 190 : 260
  for (let s = 0; s < L; s += 12) {
    const { p: q, angle } = pointAt(line, s)
    if (!inside(q) || existing.some((e) => dist(e, q) < gap)) continue
    const n: P = [-Math.sin(angle), Math.cos(angle)]
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
  let best: P | null = null
  let bd = 120
  for (const r of ctx.out.roads) {
    if (r.kind === 'path') continue
    for (let k = 0; k + 1 < r.line.length; k++) {
      const s = segDist(e, r.line[k], r.line[k + 1])
      if (s.d >= bd) continue
      const at = lerpP(r.line[k], r.line[k + 1], s.t)
      // 接点在桥的这一侧（离桥中点比桥头远），接线沿途都是干地
      if (dist(at, bridge) < dist(e, bridge)) continue
      let dry = true
      for (let t = 0.1; t <= 1 && dry; t += 0.1) if (T.waterAt(lerpP(e, at, t)) < 2) dry = false
      if (!dry) continue
      bd = s.d
      best = at
    }
  }
  return best
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
      const q: P = [ctx.center[0] + Math.cos(a) * r, ctx.center[1] + Math.sin(a) * r]
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
      const s = (k / 12) * Math.hypot(MW, MH) * 0.6
      const wob = Math.sin(k * 0.7 + rng.next()) * 30
      pts.push([m[0] + Math.cos(b) * s - Math.sin(b) * wob, m[1] + Math.sin(b) * s + Math.cos(b) * wob])
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

