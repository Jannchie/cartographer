/**
 * 真实地球模板：高程、气候、群系、河湖、自然地物名称都取自真实数据（见 real.ts、scripts/earth-real.ts），
 * 不跑造山、侵蚀、气候与水文模拟；没有城市、国家与道路。
 *
 * - 地图格从数据格取值：一格覆盖多个数据格时取平均（覆盖层过半、群系取多数），否则双线性插值
 * - 本项目以"高程 ≤ 0"为海：陆地上低于海面的洼地（死海、卡塔拉）抬到海面以上一点，湖面按湖岸最低处定
 * - 没有观测的格（海洋、小岛）气温与降水用模型补上；地形、气候编辑过的格群系改用模型判定
 * - 区域图（region）：地图格经投影换算成经纬度后取值，地形与海陆来自 1′ 的区域栅格，另有真实的行政区划与城市
 */
import { Biome, EQUATOR_KM, type Label, type River, type World, type WorldEdits, type WorldParams } from '../types'
import { classifyBiome, latitudeOf, precipitationField, temperatureField } from '../climate'
import { riverThreshold, signedCoastDist, slopeField } from '../world'
import { outline, type Area, type AreaKind } from '../areas'
import { RNG, hashString } from '../rng'
import * as dmath from '../dmath'
import { COVER, earthFeatures, earthFeaturesLoaded, earthGrid, type EarthPlaceKind, type EarthRes } from './real'
import { fillRings, type LonLatGrid } from './raster'
import { regionProjection, REGION_INFO, type MapProjection } from './region'
import { chinaAdminLayer, chinaGrid, sampleChina } from './china'

type Progress = (stage: string, frac: number) => void

/** 区域图的格比 0.25° 细得多：气候与群系总用 5′ */
export const earthResOf = (p: Pick<WorldParams, 'earthRes' | 'region'>): EarthRes => (p.region ? '5m' : p.earthRes ?? '15m')

/** 地图网格（格心经度 −180 + (x + 0.5)·360/W，纬度 latitudeOf） */
function mapGrid(W: number, H: number, p: WorldParams): LonLatGrid {
  const dLat = (p.latNorth - p.latSouth) / (H - 1)
  return { W, H, lon0: -180, lat0: p.latNorth + dLat / 2, dLon: 360 / W, dLat }
}

export function realEarthWorld(p: WorldParams, progress: Progress = () => {}, edits: WorldEdits = {}): World {
  const t0 = performance.now()
  const W = p.width
  const H = p.height
  const N = W * H
  const proj = regionProjection(p)
  const kmPerCell = proj ? proj.kmPerCell : EQUATOR_KM / W
  const g = earthGrid(earthResOf(p))
  const rng = new RNG(hashString(`${p.seed}:earth`))

  // —— 从数据格取值 ——
  progress('读取真实地形与气候', 0.1)
  const e0 = new Float32Array(N)
  const tReal = new Float32Array(N)
  const pReal = new Float32Array(N)
  const landF = new Float32Array(N)
  const lakeF = new Float32Array(N)
  const playaF = new Float32Array(N)
  const glacF = new Float32Array(N)
  const code = new Uint8Array(N)
  const dLat = (p.latNorth - p.latSouth) / (H - 1)
  const votes = new Uint16Array(16)
  const colOf = (lon: number) => ((lon + 180) * g.W) / 360 - 0.5
  const rowOf = (lat: number) => ((90 - lat) * g.H) / 180 - 0.5
  if (proj) sampleRegion(proj, W, H, { e0, tReal, pReal, landF, lakeF, playaF, glacF, code })
  else for (let y = 0; y < H; y++) {
    const lat = latitudeOf(p, y, H)
    const r0 = Math.max(0, Math.ceil(rowOf(lat + dLat / 2)))
    const r1 = Math.min(g.H - 1, Math.ceil(rowOf(lat - dLat / 2)) - 1)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const c0 = Math.ceil((x * g.W) / W - 0.5)
      const c1 = Math.ceil(((x + 1) * g.W) / W - 0.5) - 1
      if (r0 <= r1 && c0 <= c1) {
        // 地图格比数据格粗：区域平均
        let n = 0
        let se = 0
        let st = 0
        let nt = 0
        let sp = 0
        let np = 0
        let nl = 0
        let nk = 0
        let ny = 0
        let ng = 0
        votes.fill(0)
        for (let r = r0; r <= r1; r++)
          for (let c = c0; c <= c1; c++) {
            const j = r * g.W + ((c + g.W) % g.W)
            n++
            se += g.elev[j]
            if (!Number.isNaN(g.temp[j])) {
              st += g.temp[j]
              nt++
            }
            if (!Number.isNaN(g.rain[j])) {
              sp += g.rain[j]
              np++
            }
            const cv = g.cover[j]
            if (cv & COVER.land) {
              nl++
              votes[g.biome[j]]++
            }
            if (cv & COVER.lake) nk++
            if (cv & COVER.playa) ny++
            if (cv & COVER.glacier) ng++
          }
        e0[i] = se / n
        tReal[i] = nt ? st / nt : NaN
        pReal[i] = np ? sp / np : NaN
        landF[i] = nl / n
        lakeF[i] = nk / n
        playaF[i] = ny / n
        glacF[i] = ng / n
        let best = 0
        for (let v = 1; v < 16; v++) if (votes[v] > votes[best]) best = v
        code[i] = best
      } else {
        // 地图格比数据格细：高程双线性插值，其余取最近的数据格
        const fx = colOf(-180 + ((x + 0.5) * 360) / W)
        const fy = Math.min(g.H - 1, Math.max(0, rowOf(lat)))
        const xa = Math.floor(fx)
        const ya = Math.min(g.H - 2, Math.floor(fy))
        const tx = fx - xa
        const ty = fy - ya
        const at = (c: number, r: number) => g.elev[r * g.W + ((c + g.W) % g.W)]
        const a = at(xa, ya) + (at(xa + 1, ya) - at(xa, ya)) * tx
        const b = at(xa, ya + 1) + (at(xa + 1, ya + 1) - at(xa, ya + 1)) * tx
        e0[i] = a + (b - a) * ty
        const j = Math.round(fy) * g.W + ((Math.round(fx) + g.W) % g.W)
        const cv = g.cover[j]
        tReal[i] = g.temp[j]
        pReal[i] = g.rain[j]
        landF[i] = cv & COVER.land ? 1 : 0
        lakeF[i] = cv & COVER.lake ? 1 : 0
        playaF[i] = cv & COVER.playa ? 1 : 0
        glacF[i] = cv & COVER.glacier ? 1 : 0
        code[i] = g.biome[j]
      }
    }
  }

  // —— 海陆与高程（叠加地形编辑） ——
  const terr = edits.terrain && edits.terrain.length === N ? edits.terrain : null
  const elev = new Float32Array(N)
  const lake = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const isLake = lakeF[i] >= 0.5
    const land = isLake || landF[i] >= 0.5
    let h = land ? Math.max(e0[i], 0.002) : Math.min(e0[i], -0.003)
    const d = terr ? terr[i] : 0
    if (d) {
      h += d
      // 编辑过的格海陆跟着高度走
      if (h <= 0) h = Math.min(h, -0.003)
    }
    elev[i] = h
    lake[i] = isLake && h > 0 ? 1 : 0
  }

  // —— 湖面：每个湖按湖岸最低处定水位，湖底略低于湖面 ——
  progress('湖泊与河流', 0.35)
  const water = new Float32Array(N).fill(NaN)
  for (let i = 0; i < N; i++) if (elev[i] <= 0) water[i] = 0
  const lakeId = new Int32Array(N).fill(-1)
  let lakes = 0
  for (let s = 0; s < N; s++) {
    if (!lake[s] || lakeId[s] >= 0) continue
    const cells = [s]
    lakeId[s] = lakes
    let rim = Infinity
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]
      const x = c % W
      for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
        if (j < 0 || j >= N) continue
        if (lake[j]) {
          if (lakeId[j] < 0) {
            lakeId[j] = lakes
            cells.push(j)
          }
        } else if (elev[j] > 0) rim = Math.min(rim, elev[j])
      }
    }
    const level = Math.max(0.004, Number.isFinite(rim) ? rim : 0.004)
    for (const c of cells) {
      water[c] = level
      elev[c] = Math.max(0.001, level - 0.01)
    }
    lakes++
  }

  // —— 气候：有观测的陆地用观测，其余用模型补 ——
  progress('气温与降水', 0.5)
  const coastDist = signedCoastDist(elev, W, H)
  const temperature = temperatureField(p, elev, coastDist, W, H, rng.fork())
  const precipitation = precipitationField(p, elev, temperature, W, H, kmPerCell, rng.fork())
  for (let i = 0; i < N; i++) {
    if (elev[i] <= 0) continue
    // 观测值对应原来的高度：抬升、下沉过的地方按递减率修正
    if (!Number.isNaN(tReal[i])) temperature[i] = tReal[i] + p.temperature - 6.5 * (terr ? terr[i] : 0)
    if (!Number.isNaN(pReal[i])) precipitation[i] = pReal[i] * p.rainfall
  }
  const tEd = edits.temp && edits.temp.length === N ? edits.temp : null
  const rEd = edits.rain && edits.rain.length === N ? edits.rain : null
  if (tEd) for (let i = 0; i < N; i++) temperature[i] += tEd[i]
  if (rEd) for (let i = 0; i < N; i++) precipitation[i] *= dmath.exp(rEd[i])

  // —— 生物群系 ——
  progress('生物群系', 0.6)
  const slope = slopeField(elev, W, H, kmPerCell)
  const biome = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const h = elev[i]
    if (h <= 0) biome[i] = Biome.Ocean
    else if (lake[i]) biome[i] = Biome.Lake
    else if ((terr && terr[i]) || (tEd && tEd[i]) || (rEd && rEd[i]) || !code[i]) biome[i] = classifyBiome(h, temperature[i], precipitation[i], slope[i], coastDist[i])
    else if (glacF[i] >= 0.5 || code[i] === 15) biome[i] = Biome.IceCap
    else if (playaF[i] >= 0.5) biome[i] = Biome.SaltFlat
    else biome[i] = resolveBiome(code[i], h, temperature[i], precipitation[i])
  }

  // —— 河流：Natural Earth 河道投到地图格，流量按等级给 ——
  const { rivers, flow } = projectRivers(p, W, H, elev, lake)

  // —— 自然地物名称；区域图另有行政区划与城市 ——
  progress('自然地物名称', 0.8)
  const draft = { W, H, elevation: elev, water, params: p } as World
  const generated = [...earthPlaces(draft).map(placeLabel(W)), ...riverLabels(p, W, H)]
  let political: ReturnType<typeof chinaAdminLayer> | null = null
  if (proj && p.region === 'china') {
    progress('行政区划', 0.9)
    political = chinaAdminLayer(proj, W, H, elev)
    // 省级区划的驻地（capital）是行政区划图层里城市标签的序号；城市标签接在自然地物之后，序号要加上偏移
    const offset = generated.length
    for (const r of political.realms) if (r.capital >= 0) r.capital += offset
    generated.push(...political.labels)
  }
  const labels = edits.labels ? edits.labels.map((l) => ({ ...l, zh: l.zh || l.name, ja: l.ja || l.name })) : generated
  const info = p.region ? REGION_INFO[p.region] : { en: 'Earth', zh: '地球', ja: '地球' }

  let land = 0
  // 有实测山峰时，最高峰取实测（地形格是平均高程，山顶被削低）
  let peak = political?.peaks.reduce((m, p) => Math.max(m, p.elev), -Infinity) ?? -Infinity
  let trench = Infinity
  for (let i = 0; i < N; i++) {
    if (elev[i] > 0) land++
    if (elev[i] > peak) peak = elev[i]
    if (elev[i] < trench) trench = elev[i]
  }
  progress('完成', 1)
  return {
    params: p,
    W,
    H,
    elevation: elev,
    water,
    temperature,
    precipitation,
    flow,
    biome,
    coastDist,
    rivers,
    labels,
    realm: political?.realm ?? new Int16Array(N).fill(-1),
    realms: political?.realms ?? [],
    roads: [],
    worldName: edits.worldName ?? info.en,
    worldNameZh: edits.worldNameZh ?? edits.worldName ?? info.zh,
    worldNameJa: edits.worldNameJa ?? edits.worldName ?? info.ja,
    kmPerCell,
    admin: political?.admin,
    peaks: political?.peaks,
    stats: { land: land / N, peak, trench, lakes, rivers: rivers.length, ms: performance.now() - t0 },
  }
}

/** RESOLVE 生物群系 → 本项目的群系；同一大类里再按气温、降水、海拔细分 */
function resolveBiome(c: number, h: number, t: number, pr: number): Biome {
  if (t < -7 && h > 3) return Biome.Alpine
  switch (c) {
    case 1:
      return Biome.TropicalRainforest
    case 2:
    case 3:
      return Biome.TropicalSeasonalForest
    case 4:
      return pr > 1800 && t < 16 ? Biome.TemperateRainforest : Biome.TemperateForest
    case 5:
      return pr > 1800 ? Biome.TemperateRainforest : Biome.Taiga
    case 6:
      return Biome.Taiga
    case 7:
      return Biome.Savanna
    case 8:
      return pr < 250 ? Biome.ColdDesert : Biome.Grassland
    case 9:
    case 14:
      return Biome.Wetland
    case 10:
      return h > 5.2 ? Biome.Alpine : t < 0 ? Biome.Tundra : Biome.Grassland
    case 11:
      return Biome.Tundra
    case 12:
      return Biome.Shrubland
    case 13:
      return pr < 250 ? (t >= 10 ? Biome.HotDesert : Biome.ColdDesert) : Biome.Shrubland
    default:
      return Biome.Grassland
  }
}

/** 等级 → 流量：最大的河（等级 0~1）与模拟世界的干流相当，等级 9 只略高于成河阈值 */
const rankFlow = (W: number, r: number) => riverThreshold(W) * (1 + 70 * dmath.pow(0.55, r))

/** 经纬度 → 地图格坐标（格心为整数）；区域图走投影 */
function projector(p: WorldParams, W: number, H: number) {
  const proj = regionProjection(p)
  if (proj) return proj.toCell
  return (lon: number, lat: number): [number, number] => [((lon + 180) * W) / 360 - 0.5, ((p.latNorth - lat) / (p.latNorth - p.latSouth)) * (H - 1)]
}

/** 一条河段投到地图上：出了地图范围、跨过 ±180° 的地方切开 */
function riverRuns(c: number[], p: WorldParams, W: number, H: number): number[][] {
  const proj = projector(p, W, H)
  const region = !!p.region
  const runs: number[][] = []
  let cur: number[] = []
  for (let k = 0; k < c.length; k += 2) {
    const lon = c[k] / 100
    const lat = c[k + 1] / 100
    const [x, y] = proj(lon, lat)
    const inside = y >= 0 && y <= H - 1 && (!region || (x >= 0 && x <= W - 1 && inBounds(p, lon, lat)))
    const jump = cur.length >= 2 && Math.abs(x - cur[cur.length - 2]) > W / 2
    if (!inside || jump) {
      if (cur.length >= 4) runs.push(cur)
      cur = []
      if (!inside) continue
    }
    cur.push(x, y)
  }
  if (cur.length >= 4) runs.push(cur)
  return runs
}

function projectRivers(p: WorldParams, W: number, H: number, elev: Float32Array, lake: Uint8Array) {
  const N = W * H
  const flow = new Float32Array(N)
  const rivers: River[] = []
  for (const r of earthFeatures().rivers) {
    const base = rankFlow(W, r.r)
    for (const run of riverRuns(r.c, p, W, H)) {
      const n = run.length / 2
      const len = [0]
      for (let k = 1; k < n; k++) len.push(len[k - 1] + Math.hypot(run[2 * k] - run[2 * k - 2], run[2 * k + 1] - run[2 * k - 1]))
      const total = len[n - 1]
      if (total < 1.5) continue
      const fl = new Float32Array(n)
      for (let k = 0; k < n; k++) fl[k] = base * (0.7 + (0.3 * len[k]) / total)
      rivers.push({ points: Float32Array.from(run), flow: fl })
      // 汇流场：沿河道每半格落一次
      for (let k = 0; k + 1 < n; k++) {
        const ax = run[2 * k]
        const ay = run[2 * k + 1]
        const steps = Math.ceil((len[k + 1] - len[k]) * 2) + 1
        for (let s = 0; s <= steps; s++) {
          const x = Math.round(ax + ((run[2 * k + 2] - ax) * s) / steps)
          const y = Math.round(ay + ((run[2 * k + 3] - ay) * s) / steps)
          if (x < 0 || x >= W || y < 0 || y >= H) continue
          const i = y * W + x
          if (elev[i] > 0 && !lake[i] && fl[k] > flow[i]) flow[i] = fl[k]
        }
      }
    }
  }
  return { rivers, flow }
}

// —— 自然地物 ——
const WATER_KINDS: EarthPlaceKind[] = ['ocean', 'sea', 'bay']
/** 各类注记的权重系数（与模拟世界的注记大致相当） */
const KIND_WEIGHT: Record<EarthPlaceKind, number> = { ocean: 60, sea: 10, bay: 4, continent: 1.2, island: 1.5, range: 1, basin: 0.4, desert: 0.5, lake: 6 }

/** 收录到哪一级（Natural Earth 的 scalerank，越小越重要）：地图越精细，收得越多 */
const rankCut = (W: number) => (W < 900 ? 2 : W < 1300 ? 3 : W < 2000 ? 4 : 5)
/** 大洲、大洋在数据里不分级（都记作 9），按最高一级算 */
const rankOf = (pl: { k: EarthPlaceKind; r: number }) => (pl.k === 'ocean' || pl.k === 'continent' ? 0 : pl.r)

interface PlaceCells {
  k: EarthPlaceKind
  n: string
  zh?: string
  ja?: string
  r: number
  cells: number[]
}

/** 每个自然地物在地图上占的格（水域只算海面、湖只算湖面、其余只算陆地）；太小的不要 */
export function earthPlaces(world: Pick<World, 'W' | 'H' | 'elevation' | 'water' | 'params'>): PlaceCells[] {
  const { W, H, elevation: e, water: w } = world
  const proj = regionProjection(world.params)
  // 区域图：环先投到地图格坐标，再按格心填充
  const grid: LonLatGrid = proj ? { W, H, lon0: -0.5, lat0: -0.5, dLon: 1, dLat: -1 } : mapGrid(W, H, world.params)
  const ringOf = proj
    ? (r: number[]) => {
        // 先裁到投影的经纬度范围（大洋这类环会绕到地球另一侧），再投到地图格
        const c = clipRing(r.map((v) => v / 100), proj.bounds)
        const out = new Array<number>(c.length)
        for (let k = 0; k < c.length; k += 2) [out[k], out[k + 1]] = proj.toCell(c[k], c[k + 1])
        return out
      }
    : (r: number[]) => r.map((v) => v / 100)
  const out: PlaceCells[] = []
  const min = Math.max(3, Math.round((W / 1024) * (W / 1024) * 3))
  const cut = rankCut(W)
  for (const pl of earthFeatures().places) {
    if (rankOf(pl) > cut) continue
    const member = WATER_KINDS.includes(pl.k) ? (i: number) => e[i] <= 0 && w[i] === 0 : pl.k === 'lake' ? (i: number) => w[i] > 0 : (i: number) => e[i] > 0 && !(w[i] > 0)
    const cells: number[] = []
    fillRings(
      pl.rings.map(ringOf),
      grid,
      (i) => member(i) && cells.push(i),
    )
    if (cells.length >= min) out.push({ k: pl.k, n: pl.n, zh: pl.zh, ja: pl.ja, r: pl.r, cells })
  }
  return out
}

function pca(cells: number[], W: number) {
  let mx = 0
  let my = 0
  for (const c of cells) {
    mx += c % W
    my += Math.floor(c / W)
  }
  mx /= cells.length
  my /= cells.length
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const c of cells) {
    const x = (c % W) - mx
    const y = Math.floor(c / W) - my
    sxx += x * x
    syy += y * y
    sxy += x * y
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const tr = (sxx + syy) / cells.length
  const det = (sxx * syy - sxy * sxy) / (cells.length * cells.length)
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
  return { mx, my, ang, major: 4 * Math.sqrt(tr / 2 + disc), minor: 4 * Math.sqrt(Math.max(0, tr / 2 - disc)) }
}

const clampAngle = (a: number) => {
  while (a > Math.PI / 2) a -= Math.PI
  while (a < -Math.PI / 2) a += Math.PI
  return a
}

/** 区域里离边最远的一格（只在包围盒里算距离场） */
function poleOf(cells: number[], W: number): [number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (const c of cells) {
    const x = c % W
    const y = (c - x) / W
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  const bw = x1 - x0 + 3
  const bh = y1 - y0 + 3
  const inside = new Uint8Array(bw * bh)
  for (const c of cells) inside[(Math.floor(c / W) - y0 + 1) * bw + (c % W) - x0 + 1] = 1
  const d = new Int32Array(bw * bh).fill(-1)
  const q: number[] = []
  for (let i = 0; i < inside.length; i++)
    if (inside[i] && (!inside[i - 1] || !inside[i + 1] || !inside[i - bw] || !inside[i + bw])) {
      d[i] = 0
      q.push(i)
    }
  let best = q[0] ?? 0
  for (let k = 0; k < q.length; k++) {
    const c = q[k]
    if (d[c] > d[best]) best = c
    for (const j of [c - 1, c + 1, c - bw, c + bw])
      if (inside[j] && d[j] < 0) {
        d[j] = d[c] + 1
        q.push(j)
      }
  }
  return [(best % bw) + x0 - 1, Math.floor(best / bw) + y0 - 1]
}

const placeLabel =
  (W: number) =>
  (pl: PlaceCells): Label => {
    const { ang, major, minor } = pca(pl.cells, W)
    const [x, y] = poleOf(pl.cells, W)
    const elongated = major > minor * 1.6
    return {
      kind: pl.k === 'bay' ? 'sea' : pl.k,
      name: pl.n,
      zh: pl.zh || pl.n,
      ja: pl.ja || pl.n,
      x,
      y,
      angle: pl.k === 'range' && elongated ? clampAngle(ang) : pl.k === 'continent' && elongated ? clampAngle(ang) * 0.35 : 0,
      weight: pl.cells.length * KIND_WEIGHT[pl.k] * dmath.pow(1.6, 6 - Math.min(9, rankOf(pl))),
      span: major,
    }
  }

/** 河流注记：同名的河段里取地图上最长的一段，名字顺着河道排（path） */
function riverLabels(p: WorldParams, W: number, H: number): Label[] {
  // Natural Earth 把一条河切成很多段（按等级、按国家改名）：同名（有译名时按译名）的河段首尾相接连成长链，取最长的一条
  const groups = new Map<string, { runs: number[][]; r: number; n: string; zh?: string; ja?: string }>()
  const cut = rankCut(W)
  for (const r of earthFeatures().rivers) {
    if (!r.n || r.r > cut + 1) continue
    const key = r.zh ?? r.n
    const g = groups.get(key) ?? { runs: [], r: r.r, n: r.n, zh: r.zh, ja: r.ja }
    g.r = Math.min(g.r, r.r)
    g.runs.push(...riverRuns(r.c, p, W, H))
    groups.set(key, g)
  }
  const best = new Map<string, { run: number[]; len: number; r: number; zh?: string; ja?: string }>()
  for (const g of groups.values()) {
    for (const run of chainRuns(g.runs)) {
      let len = 0
      for (let k = 2; k < run.length; k += 2) len += Math.hypot(run[k] - run[k - 2], run[k + 1] - run[k - 1])
      const have = best.get(g.n)
      if (!have || len > have.len) best.set(g.n, { run, len, r: g.r, zh: g.zh, ja: g.ja })
    }
  }
  const out: Label[] = []
  for (const [name, b] of best) {
    if (b.len < 12) continue
    // 中点与那一带的走向
    const n = b.run.length / 2
    const m = Math.floor(n / 2)
    const a = Math.max(0, m - 3)
    const z = Math.min(n - 1, m + 3)
    out.push({
      kind: 'river',
      name,
      zh: b.zh || name,
      ja: b.ja || name,
      x: b.run[2 * m],
      y: b.run[2 * m + 1],
      angle: clampAngle(Math.atan2(b.run[2 * z + 1] - b.run[2 * a + 1], b.run[2 * z] - b.run[2 * a])),
      weight: b.len * 20 * dmath.pow(1.6, 6 - Math.min(9, b.r)),
      span: b.len,
      path: smoothPath(b.run),
    })
  }
  return out
}

/** 把首尾相距不到 1.5 格的折线接起来（必要时反向） */
function chainRuns(runs: number[][]): number[][] {
  const left = runs.map((r) => r.slice())
  const out: number[][] = []
  const near = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by) < 1.5
  const rev = (r: number[]) => {
    const o: number[] = []
    for (let k = r.length - 2; k >= 0; k -= 2) o.push(r[k], r[k + 1])
    return o
  }
  while (left.length) {
    let cur = left.pop()!
    let grown = true
    while (grown) {
      grown = false
      for (let i = 0; i < left.length; i++) {
        const r = left[i]
        const n = r.length
        const cn = cur.length
        let joined: number[] | null = null
        if (near(cur[cn - 2], cur[cn - 1], r[0], r[1])) joined = [...cur, ...r.slice(2)]
        else if (near(cur[cn - 2], cur[cn - 1], r[n - 2], r[n - 1])) joined = [...cur, ...rev(r).slice(2)]
        else if (near(r[n - 2], r[n - 1], cur[0], cur[1])) joined = [...r, ...cur.slice(2)]
        else if (near(r[0], r[1], cur[0], cur[1])) joined = [...rev(r), ...cur.slice(2)]
        if (joined) {
          cur = joined
          left.splice(i, 1)
          grown = true
          break
        }
      }
    }
    out.push(cur)
  }
  return out
}

/** 排字用的河道：每格重采样一次，再做几遍滑动平均——实测河道在地图格上太曲折，字会一个个转得很急 */
function smoothPath(run: number[]): number[] {
  const pts: number[] = [run[0], run[1]]
  let carry = 0
  for (let k = 2; k < run.length; k += 2) {
    const ax = run[k - 2]
    const ay = run[k - 1]
    const d = Math.hypot(run[k] - ax, run[k + 1] - ay)
    let s = 1 - carry
    while (s <= d) {
      pts.push(ax + ((run[k] - ax) * s) / d, ay + ((run[k + 1] - ay) * s) / d)
      s += 1
    }
    carry = d - (s - 1)
  }
  pts.push(run[run.length - 2], run[run.length - 1])
  let cur = pts
  const R = 3
  for (let it = 0; it < 3; it++) {
    const n = cur.length / 2
    const next: number[] = []
    for (let i = 0; i < n; i++) {
      let sx = 0
      let sy = 0
      let c = 0
      for (let j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) {
        sx += cur[2 * j]
        sy += cur[2 * j + 1]
        c++
      }
      next.push(sx / c, sy / c)
    }
    cur = next
  }
  // 相邻点至少隔半格（也去掉重合的点），坐标留一位小数
  const out = [Math.round(cur[0] * 10) / 10, Math.round(cur[1] * 10) / 10]
  for (let k = 2; k < cur.length; k += 2) {
    const x = Math.round(cur[k] * 10) / 10
    const y = Math.round(cur[k + 1] * 10) / 10
    if (Math.hypot(x - out[out.length - 2], y - out[out.length - 1]) >= 0.5) out.push(x, y)
  }
  return out
}

/** 区域：每个自然地物一块（轮廓由它在地图上的格描出），注记按名字与种类对回 world.labels */
export function earthAreas(world: World): Area[] {
  if (!earthFeaturesLoaded()) return []
  const { W, H } = world
  const out: Area[] = []
  const index = new Map(world.labels.map((l, i) => [`${l.kind}:${l.name}`, i]))
  for (const pl of earthPlaces(world)) {
    const poly = outline(W, H, pl.cells)
    if (!poly) continue
    const kind: AreaKind = pl.k
    const li = index.get(`${pl.k === 'bay' ? 'sea' : pl.k}:${pl.n}`)
    const l = li !== undefined ? world.labels[li] : undefined
    out.push({ id: `${kind}:${out.length}`, kind, name: l?.name ?? pl.n, zh: l?.zh ?? pl.zh ?? pl.n, ja: l?.ja ?? pl.ja, poly, at: l ? [l.x, l.y] : poleOf(pl.cells, W), label: li, cells: pl.cells.length })
  }
  return out
}

/**
 * 区域图的取值：地图格心经投影换算成经纬度，地形与覆盖取 1′ 区域栅格（与地图格大小相当，双线性 / 最近格），
 * 气温、降水与群系取全球 5′ 栅格（双线性 / 最近格）
 */
function sampleRegion(
  proj: MapProjection,
  W: number,
  H: number,
  o: { e0: Float32Array; tReal: Float32Array; pReal: Float32Array; landF: Float32Array; lakeF: Float32Array; playaF: Float32Array; glacF: Float32Array; code: Uint8Array },
) {
  const cg = chinaGrid()
  const g = earthGrid('5m')
  const bil = (a: Float32Array, fx: number, fy: number) => {
    const x0 = Math.floor(fx)
    const y0 = Math.max(0, Math.min(g.H - 2, Math.floor(fy)))
    const tx = fx - x0
    const ty = Math.max(0, Math.min(1, fy - y0))
    const at = (c: number, r: number) => a[r * g.W + ((c + g.W) % g.W)]
    const v00 = at(x0, y0)
    const v10 = at(x0 + 1, y0)
    const v01 = at(x0, y0 + 1)
    const v11 = at(x0 + 1, y0 + 1)
    // 有一角没有观测（海、小岛）就退回最近格
    if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) return at(Math.round(fx), Math.round(Math.max(0, Math.min(g.H - 1, fy))))
    return (v00 + (v10 - v00) * tx) * (1 - ty) + (v01 + (v11 - v01) * tx) * ty
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const [lon, lat] = proj.toLonLat(x, y)
      const fx = ((lon + 180) * g.W) / 360 - 0.5
      const fy = ((90 - lat) * g.H) / 180 - 0.5
      const j = Math.max(0, Math.min(g.H - 1, Math.round(fy))) * g.W + ((Math.round(fx) + g.W) % g.W)
      const s = sampleChina(cg, lon, lat)
      const cv = s ? s.cover : g.cover[j]
      o.e0[i] = s ? s.elev : g.elev[j]
      o.tReal[i] = bil(g.temp, fx, fy)
      o.pReal[i] = bil(g.rain, fx, fy)
      o.landF[i] = cv & COVER.land ? 1 : 0
      o.lakeF[i] = cv & COVER.lake ? 1 : 0
      o.playaF[i] = cv & COVER.playa ? 1 : 0
      o.glacF[i] = cv & COVER.glacier ? 1 : 0
      o.code[i] = g.biome[j]
    }
  }
}

/** 区域图：经纬度在不在投影的有效范围里 */
function inBounds(p: WorldParams, lon: number, lat: number) {
  const b = regionProjection(p)!.bounds
  return lon >= b.lonW && lon <= b.lonE && lat >= b.latS && lat <= b.latN
}

/** Sutherland–Hodgman：把环（交替存储的经纬度）裁到经纬度矩形里 */
function clipRing(r: number[], b: MapProjection['bounds']): number[] {
  const edges: [number, number, boolean][] = [
    [0, b.lonW, true],
    [0, b.lonE, false],
    [1, b.latS, true],
    [1, b.latN, false],
  ]
  let pts = r
  for (const [axis, v, lower] of edges) {
    const n = pts.length / 2
    if (!n) break
    const out: number[] = []
    const inside = (k: number) => (lower ? pts[2 * k + axis] >= v : pts[2 * k + axis] <= v)
    for (let k = 0; k < n; k++) {
      const j = (k + n - 1) % n
      const ik = inside(k)
      const ij = inside(j)
      if (ik !== ij) {
        const t = (v - pts[2 * j + axis]) / (pts[2 * k + axis] - pts[2 * j + axis])
        out.push(pts[2 * j] + (pts[2 * k] - pts[2 * j]) * t, pts[2 * j + 1] + (pts[2 * k + 1] - pts[2 * j + 1]) * t)
      }
      if (ik) out.push(pts[2 * k], pts[2 * k + 1])
    }
    pts = out
  }
  return pts
}
