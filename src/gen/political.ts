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

/** 伯爵领（不含名字）：seat 为治所在 labels 中的下标（没有城镇时 -1），x/y 为治所格坐标 */
export interface CountyBase {
  x: number
  y: number
  seat: number
  realm: number
  culture: number
  /** 陆地格数 */
  area: number
}

/** 文化（不含名字）：naming 是起名的世界观，town 是城镇形制；color 为调色板序号；x/y 为标注点 */
export interface CultureBase {
  naming: Style
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
 * 政区：先按地形把陆地切成伯爵领，再在伯爵领的邻接图上长出文化区与国家。
 * - 伯爵领：城镇优先做治所，其余按宜居度撒点（泊松盘），从治所做地形代价扩张（Dijkstra），
 *   于是领界落在山脊与河上；平原上叠一层噪声，免得领界是笔直的等分线
 * - 文化：最远点挑出几个文化中心，在伯爵领图上扩张，山海隔开不同文化
 * - 国家：以都城和大城市为种子，在伯爵领图上扩张，跨文化代价更高；国土由整块伯爵领拼成
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
    counties.push({ x: c % W, y: Math.floor(c / W), seat: seedLabel[s], realm: -1, culture: -1, area: landArea[s] })
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

  // —— 伯爵领邻接图：边权 = 两侧治所经由这条边界相互到达的最小代价 ——
  const edges = new Map<number, number>()
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
      const old = edges.get(key)
      if (old === undefined || w < old) edges.set(key, w)
    }
  }
  const adj: { to: number; w: number }[][] = Array.from({ length: nC }, () => [])
  for (const [key, w] of edges) {
    const a = Math.floor(key / nC)
    const b = key - a * nC
    adj[a].push({ to: b, w })
    adj[b].push({ to: a, w })
  }
  /** 伯爵领图上的多源最短路：edgeCost 给出从 a 走到 b 的代价 */
  const flood = (seeds: number[], edgeCost: (a: number, b: number, w: number, id: number) => number) => {
    const d = new Float64Array(nC).fill(Infinity)
    const lab = new Int32Array(nC).fill(-1)
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
        const nd = ka + edgeCost(a, e.to, e.w, lab[a])
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
    const { d } = flood(cultSeeds, (_a, _b, w) => w)
    let best = -1
    for (let k = 0; k < nC; k++) if (bigLand(k) && Number.isFinite(d[k]) && (best < 0 || d[k] > d[best])) best = k
    if (best < 0 || d[best] === 0) break
    cultSeeds.push(best)
  }
  const cultVigor = cultSeeds.map(() => rng.range(0.75, 1.3))
  const cult = flood(cultSeeds, (_a, _b, w, id) => w / cultVigor[id]).lab
  for (let k = 0; k < nC; k++) counties[k].culture = Math.max(0, cult[k])

  // —— 国家：都城与大城市为种子，跨文化的扩张代价更高 ——
  let landCells = 0
  for (let i = 0; i < N; i++) if (elev[i] > 0) landCells++
  const target = Math.max(3, Math.min(14, Math.round(landCells / 11000) + 2))
  const minSep = 70 * (W / 1024)
  const realmSeeds: { label: number; county: number }[] = []
  for (const { l, i } of towns) {
    if (realmSeeds.length >= target) break
    const k = county[Math.floor(l.y) * W + Math.floor(l.x)]
    if (k < 0 || realmSeeds.some((s) => s.county === k)) continue
    if (realmSeeds.some((s) => dmath.hypot(labels[s.label].x - l.x, labels[s.label].y - l.y) < minSep)) continue
    realmSeeds.push({ label: i, county: k })
  }
  const realmVigor = realmSeeds.map(() => rng.range(0.8, 1.25))
  const rl = flood(
    realmSeeds.map((s) => s.county),
    (a, b, w, id) => (w * (counties[a].culture !== counties[b].culture ? 3 : 1)) / realmVigor[id],
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

  // —— 文化的起名世界观与城镇形制 ——
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
    return { naming, town, color: cColor[k], x: p >= 0 ? p % W : 0, y: p >= 0 ? Math.floor(p / W) : 0, area: cPole.area[k], room: cPole.room[k] }
  })

  return { county, counties, cultures, realm, realms, hints }
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
