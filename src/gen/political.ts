import { Noise } from './noise'
import { RNG } from './rng'
import { Biome, isSettlement, type Label, type NamingStyle, type Realm, type TownCulture } from './types'
import { MinHeap, edt, neighbors8 } from './util'
import * as dmath from './dmath'

/** 一块伯爵领的目标面积（km²）：约 CK3 里一个伯爵领的大小 */
const COUNTY_KM2 = 3200
/** 伯爵领数目上限（Int16 存放，留足余量） */
const MAX_COUNTIES = 20000

type Style = Exclude<NamingStyle, 'auto'>

/**
 * 制度：一种文化怎样把土地组织成国家。决定国家的多少与大小、跨文化扩张的难易，以及中层政区怎样划分。
 * - feudal 分封：伯爵领 → 公爵领 → 王国。国家多而大小悬殊；公爵领围绕大城，大小随城市规模
 * - commandery 郡县：县 → 州 → 王朝。一个大一统王朝占据核心，周边少数小国；州均匀铺开、大小均衡，
 *   界线顺着山脊与大河（山川形便）
 * - ritsuryo 令制：郡 → 令制国 → 朝廷。国家少；令制国以山脊为界，大致一块盆地、一片平原一国
 */
export type Polity = 'feudal' | 'commandery' | 'ritsuryo'
/** 命名世界观对应的默认制度 */
const POLITY_OF: Record<Style, Polity> = { fantasy: 'feudal', epic: 'feudal', eastern: 'commandery', wa: 'ritsuryo' }

/** 制度的名字与基本单位、中层政区的称呼（中文原文，界面经 i18n 翻译）；国家的称呼在国名里（见 naming 的国名表） */
export const POLITY_TERMS: Record<Polity, { name: string; county: string; province: string }> = {
  feudal: { name: '分封', county: '伯爵领', province: '公爵领' },
  commandery: { name: '郡县', county: '县', province: '州' },
  ritsuryo: { name: '令制', county: '郡', province: '令制国' },
}
/** 文化的制度（旧存档没记，按命名世界观推出） */
export const polityOf = (c: { naming: Style; polity?: Polity }): Polity => c.polity ?? POLITY_OF[c.naming]
/** 国家的制度：按国家的主体文化（没有记录时取 fallback 文化，再没有就是分封） */
export function realmPolity(cultures: readonly { naming: Style; polity?: Polity }[], realm: { culture?: number } | undefined, fallback?: number): Polity {
  const c = cultures[realm?.culture ?? -1] ?? cultures[fallback ?? -1]
  return c ? polityOf(c) : 'feudal'
}

/** 中层政区的名字：治所伯爵领的名字加上制度的称谓（名字已带这个字的不再重复） */
export function provinceName(c: { name: string; zh: string; ja?: string }, polity: Polity) {
  const ja = c.ja ?? c.zh
  const suf = (s: string, t: string) => (s.endsWith(t) ? s : s + t)
  switch (polity) {
    case 'feudal':
      return { name: `Duchy of ${c.name}`, zh: suf(c.zh, '公爵领'), ja: suf(ja, '公爵領') }
    case 'commandery':
      return { name: `${c.name} Prefecture`, zh: suf(c.zh, '州'), ja: suf(ja, '州') }
    case 'ritsuryo':
      return { name: `${c.name} Province`, zh: suf(c.zh, '国'), ja: suf(ja, '国') }
  }
}

interface PolityRule {
  /** 国家数目的倍率（按文化占地分配名额之后再乘） */
  realms: number
  /** 国家种子之间的最小间距倍率 */
  sep: number
  /** 国家扩张活力的范围；core：文化里第一个（最大城市的）国家额外的活力倍率 */
  vigor: [number, number]
  core: number
  /** 跨文化扩张的代价倍率 */
  cross: number
  /** 一个中层政区平均含几个基本单位 */
  group: number
  /** 中层政区的中心：towns 先取大城（其余补齐），even 从都城起按最远点均匀铺开 */
  seeding: 'towns' | 'even'
  /** 中层界线翻越山脊（每公里高度）、沿大河的代价 */
  ridge: number
  river: number
  /** 中层政区大小向平均靠拢的力度：0 不管，1 尽量均衡 */
  balance: number
}
const RULES: Record<Polity, PolityRule> = {
  feudal: { realms: 1.4, sep: 0.8, vigor: [0.6, 1.6], core: 1, cross: 3, group: 5, seeding: 'towns', ridge: 1, river: 0.5, balance: 0 },
  commandery: { realms: 0.55, sep: 1.4, vigor: [0.85, 1.2], core: 1.7, cross: 1.6, group: 8, seeding: 'even', ridge: 3, river: 2, balance: 1 },
  ritsuryo: { realms: 0.5, sep: 1.2, vigor: [0.9, 1.2], core: 1.3, cross: 3, group: 4, seeding: 'even', ridge: 6, river: 1, balance: 0.4 },
}

/** 伯爵领图的边：w 为路程，hi 为界上山脊高度，rv 为沿大河的比例 */
type Edge = { to: number; w: number; hi: number; rv: number }
type Flood = (
  seeds: number[],
  edgeCost: (a: number, b: number, e: Edge, id: number) => number,
  prev?: { d: Float64Array; lab: Int32Array },
) => { d: Float64Array; lab: Int32Array }

/** 伯爵领（不含名字）：seat 为治所在 labels 中的下标（没有城镇时 -1），x/y 为治所格坐标 */
export interface CountyBase {
  x: number
  y: number
  seat: number
  realm: number
  culture: number
  /** 所属中层政区（provinces 下标），无主之地 -1 */
  province: number
  /** 陆地格数 */
  area: number
}

/** 中层政区（公爵领、州、令制国，不含名字）：county 为治所所在的基本单位，名字随它 */
export interface ProvinceBase {
  county: number
  realm: number
  /** 陆地格数 */
  area: number
}

/** 文化（不含名字）：naming 是起名的世界观，town 是城镇形制；color 为调色板序号；x/y 为标注点 */
export interface CultureBase {
  naming: Style
  polity: Polity
  town: TownCulture
  color: number
  x: number
  y: number
  area: number
  room: number
}

/** 政区底图（不含名字）：伯爵领、文化与国家，都只取决于地形和城镇位置 */
export interface PoliticalMap {
  /** 每格所属伯爵领，海洋 -1 */
  county: Int16Array
  counties: CountyBase[]
  provinces: ProvinceBase[]
  cultures: CultureBase[]
  /** 每格所属国家，海洋 -1（由伯爵领拼成，国界总落在伯爵领边界上） */
  realm: Int16Array
  realms: (Omit<Realm, 'name' | 'zh' | 'ja' | 'culture'> & { culture: number })[]
  /** 给每个国家起名用的随机数，按国家顺序预先取好 */
  hints: number[]
}

/** 宜居度 0.2~1：平原、森林里的伯爵领小而密，荒漠、冻土、高山上的大而疏 */
function habitability(b: number, h: number) {
  let v: number
  switch (b) {
    case Biome.Grassland:
    case Biome.TemperateForest:
    case Biome.Shrubland:
    case Biome.Savanna:
    case Biome.TropicalSeasonalForest:
    case Biome.Wetland:
    case Biome.Beach:
      v = 1
      break
    case Biome.Taiga:
    case Biome.TemperateRainforest:
    case Biome.TropicalRainforest:
      v = 0.6
      break
    default:
      v = 0.22
  }
  if (h > 2) v *= 0.6
  return Math.max(0.2, v)
}

/**
 * 政区：先按地形把陆地切成伯爵领，再在伯爵领的邻接图上长出文化区、国家与中层政区。
 * - 伯爵领：城镇优先做治所，其余按宜居度撒点（泊松盘），从治所做地形代价扩张（Dijkstra），
 *   于是领界落在山脊与河上；平原上叠一层噪声，免得领界是笔直的等分线
 * - 文化：最远点挑出几个文化中心，在伯爵领图上扩张，山海隔开不同文化
 * - 国家：以都城和大城市为种子，在伯爵领图上扩张，跨文化代价更高；国土由整块伯爵领拼成。
 *   各文化按占地分到国家名额，名额与扩张方式随文化的制度（Polity）
 * - 中层政区：每个国家内部再把伯爵领拼成公爵领、州或令制国，划法随国家主体文化的制度
 */
export function politicalMap(
  elev: Float32Array,
  flow: Float32Array,
  biome: Uint8Array,
  temperature: Float32Array,
  labels: Label[],
  W: number,
  H: number,
  /** 坡度换算用的每格公里数（与晕渲同样的夸张） */
  slopeKm: number,
  /** 面积换算用的真实每格公里数 */
  kmPerCell: number,
  riverThr: number,
  worldStyle: Style,
  rng: RNG,
): PoliticalMap {
  const N = W * H
  const { off, dx, dy, dist } = neighbors8(W)

  // —— 陆块大小：太小的岛不单独设伯爵领，由邻近伯爵领隔海管辖 ——
  const comp = new Int32Array(N).fill(-1)
  const compSize: number[] = []
  {
    const stack: number[] = []
    for (let s = 0; s < N; s++) {
      if (elev[s] <= 0 || comp[s] >= 0) continue
      const id = compSize.length
      let n = 0
      comp[s] = id
      stack.push(s)
      while (stack.length) {
        const c = stack.pop()!
        n++
        const x = c % W
        for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
          if (j < 0 || j >= N || comp[j] >= 0 || elev[j] <= 0) continue
          comp[j] = id
          stack.push(j)
        }
      }
      compSize.push(n)
    }
  }

  const hab = new Float32Array(N)
  let habSum = 0
  for (let i = 0; i < N; i++) {
    if (elev[i] <= 0) continue
    hab[i] = habitability(biome[i], elev[i])
    habSum += hab[i]
  }
  // 泊松盘的最小间距（格）：每个点约占 1.1·r² 的面积
  let r0 = Math.max(2.5, Math.sqrt(COUNTY_KM2 / (kmPerCell * kmPerCell) / 1.1))
  if (habSum / (1.1 * r0 * r0) > MAX_COUNTIES) r0 = Math.sqrt(habSum / (1.1 * MAX_COUNTIES))
  const radius = (i: number) => r0 / Math.sqrt(hab[i])
  const minIsland = Math.max(4, 0.35 * r0 * r0)

  // —— 治所：城镇优先（都城在前），其余随机撒点 ——
  const g = r0
  const GW = Math.ceil(W / g)
  const GH = Math.ceil(H / g)
  const bucket: number[][] = Array.from({ length: GW * GH }, () => [])
  const seedCell: number[] = []
  const seedR: number[] = []
  const seedLabel: number[] = []
  const reach = Math.ceil((r0 / Math.sqrt(0.2)) / g)
  const free = (x: number, y: number, r: number, k: number) => {
    const bx = Math.floor(x / g)
    const by = Math.floor(y / g)
    for (let yy = Math.max(0, by - reach); yy <= Math.min(GH - 1, by + reach); yy++) {
      for (let xx = Math.max(0, bx - reach); xx <= Math.min(GW - 1, bx + reach); xx++) {
        for (const s of bucket[yy * GW + xx]) {
          const sx = seedCell[s] % W
          const sy = (seedCell[s] - sx) / W
          const d = (r + seedR[s]) * 0.5 * k
          if ((sx - x) * (sx - x) + (sy - y) * (sy - y) < d * d) return false
        }
      }
    }
    return true
  }
  const addSeed = (i: number, label: number) => {
    const x = i % W
    const y = (i - x) / W
    bucket[Math.floor(y / g) * GW + Math.floor(x / g)].push(seedCell.length)
    seedCell.push(i)
    seedR.push(radius(i))
    seedLabel.push(label)
  }
  const towns = labels
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => isSettlement(l))
    .sort((a, b) => b.l.weight - a.l.weight)
  for (const { l, i } of towns) {
    const c = Math.floor(l.y) * W + Math.floor(l.x)
    if (c < 0 || c >= N || elev[c] <= 0) continue
    // 两座城挨得太近就同属一个伯爵领
    if (free(c % W, Math.floor(c / W), radius(c), 0.6)) addSeed(c, i)
  }
  const order: number[] = []
  for (let i = 0; i < N; i++) if (elev[i] > 0 && compSize[comp[i]] >= minIsland) order.push(i)
  for (let k = order.length - 1; k > 0; k--) {
    const j = Math.floor(rng.next() * (k + 1))
    const t = order[k]
    order[k] = order[j]
    order[j] = t
  }
  for (const i of order) if (seedCell.length < MAX_COUNTIES && free(i % W, Math.floor(i / W), radius(i), 1)) addSeed(i, -1)

  // —— 地形代价扩张：领界顺着山脊、大河；平原上的噪声让领界弯曲 ——
  const noise = new Noise(rng.fork())
  const wig = new Float32Array(N)
  const nf = 1 / (r0 * 1.3)
  for (let i = 0; i < N; i++) {
    if (elev[i] <= 0) continue
    const x = i % W
    wig[i] = 1 + 0.45 * noise.fbm(x * nf, ((i - x) / W) * nf, 3)
  }
  const cost = new Float64Array(N).fill(Infinity)
  const own = new Int32Array(N).fill(-1)
  const heap = new MinHeap(1 << 16)
  const vigor = seedCell.map(() => rng.range(0.85, 1.15))
  seedCell.forEach((i, id) => {
    cost[i] = 0
    own[i] = id
    heap.push(0, i)
  })
  const step = (c: number, j: number) => {
    const hj = elev[j]
    if (hj <= 0) return 6 // 渡海
    const slope = Math.abs(hj - Math.max(0, elev[c])) / slopeKm
    let s = 1 + slope * 45 + Math.max(0, hj - 1.2) * 1.5
    if (flow[j] > riverThr * 3) s += 4 // 河
    return s * wig[j]
  }
  while (heap.size > 0) {
    const c = heap.pop()
    const kc = heap.lastKey
    if (kc > cost[c]) continue
    const cx = c % W
    const cy = (c - cx) / W
    const id = own[c]
    for (let k = 0; k < 8; k++) {
      const x = cx + dx[k]
      const y = cy + dy[k]
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const j = c + off[k]
      const nc = kc + (step(c, j) * dist[k]) / vigor[id]
      if (nc < cost[j]) {
        cost[j] = nc
        own[j] = id
        heap.push(nc, j)
      }
    }
  }

  // —— 飞地并入邻领：每个伯爵领只留含治所的那一片（隔海的小岛除外） ——
  {
    const seen = new Uint8Array(N)
    const stack: number[] = []
    const piece: number[] = []
    for (let s = 0; s < N; s++) {
      if (elev[s] <= 0 || seen[s]) continue
      const id = own[s]
      piece.length = 0
      seen[s] = 1
      stack.push(s)
      let hasSeat = false
      const touch = new Map<number, number>()
      while (stack.length) {
        const c = stack.pop()!
        piece.push(c)
        if (c === seedCell[id]) hasSeat = true
        const x = c % W
        for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
          if (j < 0 || j >= N || elev[j] <= 0) continue
          if (own[j] !== id) {
            touch.set(own[j], (touch.get(own[j]) ?? 0) + 1)
            continue
          }
          if (seen[j]) continue
          seen[j] = 1
          stack.push(j)
        }
      }
      if (hasSeat || touch.size === 0) continue
      let best = -1
      let bn = 0
      for (const [o, n] of touch) if (n > bn) ((bn = n), (best = o))
      for (const c of piece) own[c] = best
    }
  }

  // —— 编号：去掉被并空的伯爵领 ——
  const nSeeds = seedCell.length
  const landArea = new Int32Array(nSeeds)
  for (let i = 0; i < N; i++) if (elev[i] > 0) landArea[own[i]]++
  const remap = new Int32Array(nSeeds).fill(-1)
  const counties: CountyBase[] = []
  for (let s = 0; s < nSeeds; s++) {
    if (landArea[s] === 0) continue
    remap[s] = counties.length
    const c = seedCell[s]
    counties.push({ x: c % W, y: Math.floor(c / W), seat: seedLabel[s], realm: -1, culture: -1, province: -1, area: landArea[s] })
  }
  const nC = counties.length
  // 海上的格也按扩张结果记一个伯爵领（只用来建邻接图）；空了的伯爵领的海归给最近的陆地领——直接丢掉即可
  const full = new Int32Array(N)
  for (let i = 0; i < N; i++) full[i] = own[i] >= 0 ? remap[own[i]] : -1
  const county = new Int16Array(N).fill(-1)
  for (let i = 0; i < N; i++) if (elev[i] > 0) county[i] = full[i]
  // 城镇所在的伯爵领：没有治所的伯爵领里有城镇时（并进来的），让最大的城做治所
  for (const { l, i } of towns) {
    const c = Math.floor(l.y) * W + Math.floor(l.x)
    const k = c >= 0 && c < N ? county[c] : -1
    if (k >= 0 && counties[k].seat < 0) {
      counties[k].seat = i
      counties[k].x = Math.floor(l.x)
      counties[k].y = Math.floor(l.y)
    }
  }

  // —— 伯爵领邻接图：边权 = 两侧治所经由这条边界相互到达的最小代价；
  // 另记边界上的地形：hi 为界上山脊的高度（两侧都高才算，公里），rv 为界线沿大河的比例 ——
  const edges = new Map<number, { w: number; hi: number; rv: number; n: number }>()
  const bigRiver = riverThr * 3
  for (let i = 0; i < N; i++) {
    const a = full[i]
    if (a < 0) continue
    const x = i % W
    for (const j of [x < W - 1 ? i + 1 : -1, i + W < N ? i + W : -1]) {
      if (j < 0) continue
      const b = full[j]
      if (b < 0 || b === a) continue
      const w = cost[i] + cost[j] + 1
      const key = a < b ? a * nC + b : b * nC + a
      const hi = Math.max(0, Math.min(elev[i], elev[j]))
      const rv = elev[i] > 0 && elev[j] > 0 && Math.max(flow[i], flow[j]) > bigRiver ? 1 : 0
      const e = edges.get(key)
      if (!e) edges.set(key, { w, hi, rv, n: 1 })
      else {
        if (w < e.w) e.w = w
        if (hi > e.hi) e.hi = hi
        e.rv += rv
        e.n++
      }
    }
  }
  const adj: Edge[][] = Array.from({ length: nC }, () => [])
  for (const [key, e] of edges) {
    const a = Math.floor(key / nC)
    const b = key - a * nC
    const rv = e.rv / e.n
    adj[a].push({ to: b, w: e.w, hi: e.hi, rv })
    adj[b].push({ to: a, w: e.w, hi: e.hi, rv })
  }
  /**
   * 伯爵领图上的多源最短路：edgeCost 给出从 a 走到 b 的代价（Infinity 为不可通过）。
   * 传入上一次的结果 prev（种子只增不减、代价不变）时在其上增量更新，只扩展新种子能改进的部分
   */
  const flood: Flood = (seeds, edgeCost, prev) => {
    const d = prev?.d ?? new Float64Array(nC).fill(Infinity)
    const lab = prev?.lab ?? new Int32Array(nC).fill(-1)
    const hp = new MinHeap(1024)
    seeds.forEach((s, id) => {
      d[s] = 0
      lab[s] = id
      hp.push(0, s)
    })
    while (hp.size > 0) {
      const a = hp.pop()
      const ka = hp.lastKey
      if (ka > d[a]) continue
      for (const e of adj[a]) {
        const nd = ka + edgeCost(a, e.to, e, lab[a])
        if (nd < d[e.to]) {
          d[e.to] = nd
          lab[e.to] = lab[a]
          hp.push(nd, e.to)
        }
      }
    }
    return { d, lab }
  }

  // —— 文化：最远点挑中心（只在大陆块上），再按地形代价扩张 ——
  const totalLand = counties.reduce((s, c) => s + c.area, 0)
  const nCult = nC < 12 ? 1 : Math.max(2, Math.min(6, Math.round(Math.sqrt(nC) / 9) + 1))
  const bigLand = (k: number) => {
    const c = counties[k]
    return compSize[comp[c.y * W + c.x]] >= totalLand * 0.05
  }
  const firstTown = towns.length ? county[Math.floor(towns[0].l.y) * W + Math.floor(towns[0].l.x)] : -1
  let first = firstTown >= 0 ? firstTown : 0
  if (firstTown < 0) for (let k = 1; k < nC; k++) if (counties[k].area > counties[first].area) first = k
  const cultSeeds = nC ? [first] : []
  while (cultSeeds.length < nCult) {
    const { d } = flood(cultSeeds, (_a, _b, e) => e.w)
    let best = -1
    for (let k = 0; k < nC; k++) if (bigLand(k) && Number.isFinite(d[k]) && (best < 0 || d[k] > d[best])) best = k
    if (best < 0 || d[best] === 0) break
    cultSeeds.push(best)
  }
  const cultVigor = cultSeeds.map(() => rng.range(0.75, 1.3))
  const cult = flood(cultSeeds, (_a, _b, e, id) => e.w / cultVigor[id]).lab
  for (let k = 0; k < nC; k++) counties[k].culture = Math.max(0, cult[k])

  // —— 文化的起名世界观、制度与城镇形制（国家怎样形成取决于制度，所以先定） ——
  const cultRaster = new Int16Array(N).fill(-1)
  for (let i = 0; i < N; i++) if (county[i] >= 0) cultRaster[i] = counties[county[i]].culture
  const nK = cultSeeds.length
  const cColor = colorRegions(cultRaster, nK, W, H, rng)
  const cPole = poles(cultRaster, nK, W, H)
  const others = (['fantasy', 'epic', 'eastern', 'wa'] as const).filter((s) => s !== worldStyle)
  for (let k = others.length - 1; k > 0; k--) {
    const j = Math.floor(rng.next() * (k + 1))
    ;[others[k], others[j]] = [others[j], others[k]]
  }
  // 炎热干旱的文化建伊斯兰式的城（只换形制，名字仍按自己的世界观）
  const arid = new Float64Array(nK)
  for (let i = 0; i < N; i++) {
    const k = cultRaster[i]
    if (k < 0) continue
    const b = biome[i]
    if (temperature[i] > 18 && (b === Biome.HotDesert || b === Biome.Shrubland || b === Biome.Savanna || b === Biome.SaltFlat)) arid[k]++
  }
  const cultures: CultureBase[] = cultSeeds.map((_, k) => {
    const naming: Style = k === 0 ? worldStyle : (others[k - 1] ?? 'fantasy')
    const town: TownCulture = naming === 'eastern' || naming === 'wa' ? naming : arid[k] > cPole.area[k] * 0.45 ? 'islamic' : 'western'
    const p = cPole.pole[k]
    return { naming, polity: POLITY_OF[naming], town, color: cColor[k], x: p >= 0 ? p % W : 0, y: p >= 0 ? Math.floor(p / W) : 0, area: cPole.area[k], room: cPole.room[k] }
  })
  const rule = (k: number) => RULES[cultures[k].polity]

  // —— 国家：都城与大城市为种子，跨文化的扩张代价更高 ——
  let landCells = 0
  for (let i = 0; i < N; i++) if (elev[i] > 0) landCells++
  const target = Math.max(3, Math.min(14, Math.round(landCells / 11000) + 2))
  const minSep = 70 * (W / 1024)
  // 名额：按文化占地分，再乘制度的倍率；每种有城镇的文化至少一国
  const cultLand = new Float64Array(nK)
  for (const c of counties) cultLand[c.culture] += c.area
  const quota = Array.from(cultLand, (a, k) => Math.max(1, Math.round((target * a * rule(k).realms) / Math.max(1, totalLand))))
  const taken = new Int32Array(nK)
  const realmSeeds: { label: number; county: number }[] = []
  for (const { l, i } of towns) {
    const k = county[Math.floor(l.y) * W + Math.floor(l.x)]
    if (k < 0 || realmSeeds.some((s) => s.county === k)) continue
    const ck = counties[k].culture
    if (taken[ck] >= quota[ck]) continue
    const sep = minSep * rule(ck).sep
    if (realmSeeds.some((s) => dmath.hypot(labels[s.label].x - l.x, labels[s.label].y - l.y) < sep)) continue
    realmSeeds.push({ label: i, county: k })
    taken[ck]++
  }
  // 活力：文化里第一个国家（最大的城）是核心王朝，郡县制下尤其强
  const seenCult = new Set<number>()
  const realmVigor = realmSeeds.map((s) => {
    const ck = counties[s.county].culture
    const r = rule(ck)
    const core = seenCult.has(ck) ? 1 : r.core
    seenCult.add(ck)
    return rng.range(r.vigor[0], r.vigor[1]) * core
  })
  const realmCross = realmSeeds.map((s) => rule(counties[s.county].culture).cross)
  const rl = flood(
    realmSeeds.map((s) => s.county),
    (a, b, e, id) => (e.w * (counties[a].culture !== counties[b].culture ? realmCross[id] : 1)) / realmVigor[id],
  ).lab
  for (let k = 0; k < nC; k++) counties[k].realm = rl[k]
  const realm = new Int16Array(N).fill(-1)
  for (let i = 0; i < N; i++) if (county[i] >= 0) realm[i] = counties[county[i]].realm

  // —— 国家的配色、国名标注点 ——
  const nR = realmSeeds.length
  const color = colorRegions(realm, nR, W, H, rng)
  const rPole = poles(realm, nR, W, H)
  const hints: number[] = []
  const realms = realmSeeds.map((s, id) => {
    hints.push(rng.next())
    const c = labels[s.label]
    const p = rPole.pole[id]
    return {
      color: color[id],
      x: p >= 0 ? p % W : Math.floor(c.x),
      y: p >= 0 ? Math.floor(p / W) : Math.floor(c.y),
      capital: s.label,
      culture: counties[s.county].culture,
      area: rPole.area[id],
      room: p >= 0 ? rPole.room[id] : 1,
    }
  })

  // —— 中层政区：每个国家内部按主体文化的制度把伯爵领拼成公爵领、州或令制国 ——
  const provinces = buildProvinces(counties, realms.map((r) => rule(r.culture)), realmSeeds.map((s) => s.county), labels, adj, flood)

  return { county, counties, provinces, cultures, realm, realms, hints }
}

/**
 * 中层政区：只在同一国家内扩张（跨国的边不可通过）。
 * - 中心：先取都城所在的伯爵领；分封制再按城市大小取大城（彼此不相邻），其余按最远点补齐。
 *   最远点只看路程、不计翻山：计了山，中心会落进山后的小谷与离岛，被山困成一两个伯爵领
 * - 扩张：伯爵领边权加上翻山、沿河的代价，界线于是落在山脊与大河上
 * - 均匀铺开的制度（郡县、令制）做几轮 Lloyd 松弛：中心挪到辖区重心附近再扩张；
 *   要求均衡的再按大小调活力（加权 Voronoi 向等大靠拢）
 * - 最后把过小的区并进同国里接壤最长的邻区
 * 每区的治所取区内最大的城（都城所在的区就是都城）
 */
function buildProvinces(counties: CountyBase[], realmRule: PolityRule[], capitals: number[], labels: Label[], adj: Edge[][], flood: Flood): ProvinceBase[] {
  const nC = counties.length
  const nR = realmRule.length
  const members: number[][] = Array.from({ length: nR }, () => [])
  for (let k = 0; k < nC; k++) if (counties[k].realm >= 0) members[counties[k].realm].push(k)
  const ruleOf = (r: number) => realmRule[r]
  const neighbors = (k: number) => adj[k].map((e) => e.to)
  const want = members.map((m, r) => Math.max(1, Math.round(m.length / ruleOf(r).group)))
  const seeds: number[] = []
  const seedRealm: number[] = []
  const add = (k: number, r: number) => {
    seeds.push(k)
    seedRealm.push(r)
  }
  const count = new Int32Array(nR)
  for (let r = 0; r < nR; r++) {
    if (!members[r].length) continue
    add(capitals[r], r)
    count[r]++
    if (ruleOf(r).seeding !== 'towns') continue
    // 分封：大城各成一个公爵领的中心（相邻的两座城只取大的）
    const picked = new Set([capitals[r]])
    const near = (k: number) => picked.has(k) || neighbors(k).some((n) => picked.has(n))
    const towns = members[r].filter((k) => counties[k].seat >= 0 && k !== capitals[r]).sort((a, b) => labels[counties[b].seat].weight - labels[counties[a].seat].weight)
    for (const k of towns) {
      if (count[r] >= want[r]) break
      if (near(k)) continue
      picked.add(k)
      add(k, r)
      count[r]++
    }
  }
  const sameRealm = (a: number, b: number, id: number) => counties[a].realm === seedRealm[id] && counties[b].realm === seedRealm[id]
  // 最远点补齐（只看路程）：每轮给还缺中心的国家各添一个；距离在上一轮的结果上增量更新
  let far: ReturnType<Flood> | undefined
  for (let round = 0; round < 256; round++) {
    const need: number[] = []
    for (let r = 0; r < nR; r++) if (members[r].length && count[r] < want[r]) need.push(r)
    if (!need.length) break
    far = flood(seeds, (a, b, e, id) => (sameRealm(a, b, id) ? e.w : Infinity), far)
    const { d } = far
    for (const r of need) {
      let best = -1
      for (const k of members[r]) if (Number.isFinite(d[k]) && (best < 0 || d[k] > d[best])) best = k
      if (best < 0 || d[best] === 0) want[r] = count[r]
      else {
        add(best, r)
        count[r]++
      }
    }
  }
  const vigor = seeds.map(() => 1)
  const grow = () =>
    flood(seeds, (a, b, e, id) => {
      if (!sameRealm(a, b, id)) return Infinity
      const ru = ruleOf(seedRealm[id])
      return (e.w * (1 + ru.ridge * e.hi + ru.river * e.rv)) / vigor[id]
    }).lab
  let lab = grow()
  const realmArea = members.map((m) => m.reduce((s, k) => s + counties[k].area, 0))
  for (let it = 0; it < 5; it++) {
    let moved = false
    // 辖区重心（按面积加权）与大小
    const sx = new Float64Array(seeds.length)
    const sy = new Float64Array(seeds.length)
    const size = new Float64Array(seeds.length)
    for (let k = 0; k < nC; k++) {
      const id = lab[k]
      if (id < 0) continue
      const a = counties[k].area
      sx[id] += counties[k].x * a
      sy[id] += counties[k].y * a
      size[id] += a
    }
    const best = new Int32Array(seeds.length).fill(-1)
    const bestD = new Float64Array(seeds.length).fill(Infinity)
    for (let k = 0; k < nC; k++) {
      const id = lab[k]
      if (id < 0 || size[id] === 0) continue
      const d = (counties[k].x - sx[id] / size[id]) ** 2 + (counties[k].y - sy[id] / size[id]) ** 2
      if (d < bestD[id]) {
        bestD[id] = d
        best[id] = k
      }
    }
    for (let id = 0; id < seeds.length; id++) {
      const r = seedRealm[id]
      const ru = ruleOf(r)
      // 都城所在的那一区中心不动
      if (ru.seeding === 'even' && seeds[id] !== capitals[r] && best[id] >= 0 && best[id] !== seeds[id]) {
        seeds[id] = best[id]
        moved = true
      }
      if (ru.balance > 0) {
        vigor[id] *= Math.pow(realmArea[r] / Math.max(1, count[r]) / Math.max(1, size[id]), 0.5 * ru.balance)
        moved = true
      }
    }
    if (!moved) break
    lab = grow()
  }
  // 扩张不到的（同国里没有边相连的岛）归都城所在的那一区
  const capId = new Map<number, number>()
  seeds.forEach((k, id) => {
    if (k === capitals[seedRealm[id]]) capId.set(seedRealm[id], id)
  })
  const prov = new Int32Array(nC).fill(-1)
  for (let k = 0; k < nC; k++) prov[k] = lab[k] >= 0 ? lab[k] : counties[k].realm >= 0 ? (capId.get(counties[k].realm) ?? -1) : -1

  // 过小的区并进同国里接壤最长的邻区（从小到大，并完的区不再参与）
  const nP = seeds.length
  const size = new Int32Array(nP)
  for (let k = 0; k < nC; k++) if (prov[k] >= 0) size[prov[k]]++
  const merged = new Int32Array(nP).map((_, i) => i)
  const root = (i: number): number => (merged[i] === i ? i : (merged[i] = root(merged[i])))
  const memb: number[][] = Array.from({ length: nP }, () => [])
  for (let k = 0; k < nC; k++) if (prov[k] >= 0) memb[prov[k]].push(k)
  const order = Array.from({ length: nP }, (_, i) => i).sort((a, b) => size[a] - size[b])
  for (const p of order) {
    if (root(p) !== p) continue
    const r = seedRealm[p]
    const min = Math.max(2, Math.round(ruleOf(r).group / 3))
    if (size[p] >= min || seeds[p] === capitals[r]) continue
    const border = new Map<number, number>()
    for (const k of memb[p]) {
      for (const n of neighbors(k)) {
        if (prov[n] < 0) continue
        const q = root(prov[n])
        if (q !== p && seedRealm[q] === r) border.set(q, (border.get(q) ?? 0) + 1)
      }
    }
    let to = -1
    for (const [q, n] of border) if (to < 0 || n > border.get(to)!) to = q
    if (to < 0) continue
    merged[p] = to
    size[to] += size[p]
    for (const k of memb[p]) memb[to].push(k)
    memb[p] = []
  }
  // 编号：留下没被并掉的区；治所取区内最大的城（都城所在的区就是都城）
  const remap = new Int32Array(nP).fill(-1)
  const provinces: ProvinceBase[] = []
  for (let p = 0; p < nP; p++) {
    if (root(p) !== p) continue
    remap[p] = provinces.length
    provinces.push({ county: seeds[p], realm: seedRealm[p], area: 0 })
  }
  for (let k = 0; k < nC; k++) {
    const id = prov[k] >= 0 ? remap[root(prov[k])] : -1
    counties[k].province = id
    if (id < 0) continue
    const pv = provinces[id]
    pv.area += counties[k].area
    const cur = counties[pv.county]
    if (cur.realm >= 0 && pv.county === capitals[cur.realm]) continue
    if (k === capitals[pv.realm] || (counties[k].seat >= 0 && (cur.seat < 0 || labels[counties[k].seat].weight > labels[cur.seat].weight))) pv.county = k
  }
  return provinces
}

/** 邻接 → 贪心着色（8 色），相邻区域颜色不同 */
function colorRegions(raster: Int16Array, n: number, W: number, H: number, rng: RNG) {
  const N = W * H
  const adj = Array.from({ length: n }, () => new Set<number>())
  for (let i = 0; i < N - W - 1; i++) {
    const a = raster[i]
    if (a < 0) continue
    for (const j of [i + 1, i + W]) {
      const b = raster[j]
      if (b >= 0 && b !== a) {
        adj[a].add(b)
        adj[b].add(a)
      }
    }
  }
  const color = new Array<number>(n).fill(-1)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => adj[b].size - adj[a].size)
  for (const id of order) {
    const used = new Set([...adj[id]].map((q) => color[q]))
    let c = rng.int(0, 7)
    for (let t = 0; t < 8 && used.has(c); t++) c = (c + 1) % 8
    color[id] = c
  }
  return color
}

/** 各区域的不可达极点（离区界与海岸最远处）、到区界的距离与陆地格数 */
function poles(raster: Int16Array, n: number, W: number, H: number) {
  const N = W * H
  const edge = new Uint8Array(N)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const a = raster[i]
      if (a < 0 || x === 0 || y === 0 || x === W - 1 || y === H - 1) {
        edge[i] = 1
        continue
      }
      if (raster[i + 1] !== a || raster[i - 1] !== a || raster[i + W] !== a || raster[i - W] !== a) edge[i] = 1
    }
  }
  const inner = edt(edge, W, H)
  const pole = new Int32Array(n).fill(-1)
  const area = new Array<number>(n).fill(0)
  for (let i = 0; i < N; i++) {
    const r = raster[i]
    if (r < 0) continue
    area[r]++
    if (pole[r] < 0 || inner[i] > inner[pole[r]]) pole[r] = i
  }
  const room = Array.from(pole, (p) => (p >= 0 ? inner[p] : 0))
  return { pole, area, room }
}
