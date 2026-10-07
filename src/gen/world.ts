import { buildRoads } from './roads'
import { JaNamer } from './names_ja'
import { Namer, type Tri } from './naming'
import { classifyBiome, latitudeOf, pet, precipitationField, temperatureField } from './climate'
import { coarseErosion, dropletErosion, streamPowerErosion, thermalErosion } from './erosion'
import { fillSmallDepressions, findDepressions, hydrology, priorityFlood, type HydroResult } from './hydrology'
import { nameRealms, realmMap, type RealmMap } from './realms'
import { Noise } from './noise'
import { RNG, hashString } from './rng'
import { buildEarthTerrain, buildTerrain, type TerrainResult } from './terrain'
import { realEarthWorld } from './earth/realWorld'
import { highlandField, isDesertBiome, isForestBiome, RANGE_HI } from './areas'
import { Biome, EQUATOR_KM, isGlobe, MAP_KM, reliefKm, type Label, type River, type World, type WorldEdits, type WorldParams } from './types'
import { blur, edt, neighbors8 } from './util'
import * as dmath from './dmath'

export type Progress = (stage: string, frac: number) => void

/** 地图物理宽度（km） */

/** 侵蚀调参（离线脚本可覆盖） */
export const TUNE = { cBase: 1.3, cIters: 80, ckf: 0.14, cUplift: 0.07, cDiff: 0.02, spIters: 6, kf: 0.0028, uplift: 0.012, diffusion: 0.015, drops: 0.45 }

/** 侵蚀结束时的地形（缓存它，只改气候或地点时不必重跑最慢的造山与侵蚀） */
export interface TerrainStage {
  key: string
  elev: Float32Array
  basins: { x: number; y: number; r: number }[]
}

/** Worker 里的分阶段缓存：改了哪一级的参数，就只从那一级往下重算 */
export interface WorldCache {
  /** 板块造山的结果，叠加地形编辑之前（只改地形编辑时沿用；阶段内会改写，取用时复制） */
  plates?: { key: string; terr: TerrainResult }
  /** 侵蚀结束时的地形（只改气候时沿用） */
  stage?: TerrainStage
  /** 地名之前的地面（只改命名时沿用） */
  ground?: GroundStage
  /** 政区划分与道路（地点位置不变时沿用） */
  places?: { key: string; map: RealmMap; roads: World['roads'] }
}

/** 影响地形阶段的参数与地形编辑版本 */
export function terrainKey(p: WorldParams, edits?: WorldEdits) {
  return JSON.stringify([p.seed, p.width, p.height, p.landRatio, p.plates, p.mountains, p.coastRoughness, p.erosion, p.latNorth, p.latSouth, !!p.globe, !!p.earth, edits?.terrain ? edits.terrainRev ?? 1 : 0])
}

export function generateWorld(p: WorldParams, progress: Progress = () => {}, edits: WorldEdits = {}, cache?: WorldCache): World {
  // 真实地球：不走模拟流水线，直接取真实数据（数据要事先 await loadEarthGrid / loadEarthFeatures）
  if (p.earthReal) return realEarthWorld(p, progress, edits)
  const t0 = performance.now()
  const W = p.width
  const H = p.height
  const N = W * H
  // 全球图：宽度是赤道一周
  const kmPerCell = (isGlobe(p) ? EQUATOR_KM : MAP_KM) / W
  const rng = new RNG(hashString(p.seed))
  const rTerrain = rng.fork()
  const rErode = rng.fork()
  const rClimate = rng.fork()
  const rNames = rng.fork()
  const rPlace = rng.fork()

  const key = terrainKey(p, edits)
  let stage = cache?.stage?.key === key ? cache.stage : undefined
  if (!stage) {
    stage = terrainStage(p, progress, edits, W, H, kmPerCell, rTerrain, rErode, key, cache)
    if (cache) cache.stage = stage
  } else progress('沿用已演算的地形', 0.72)
  const gk = groundKey(p, edits)
  let ground = cache?.ground?.key === gk ? cache.ground : undefined
  if (!ground) {
    ground = groundStage(p, progress, edits, stage, W, H, kmPerCell, rClimate, gk)
    if (cache) cache.ground = ground
  } else progress('沿用已演算的地形与气候', 0.94)
  // 结果里的数组会转移给主线程，缓存要保持原样：输出用副本，后续阶段只读缓存
  const { elev, coastDist, temperature, precipitation, hydro, rivers, water, biome } = ground
  const terr = { basins: stage.basins }

  // —— 地名与标注 ——
  progress('命名与标注', 0.95)
  const namer = new Namer(p, rNames)
  const generated = makeLabels(p, elev, biome, coastDist, hydro, temperature, precipitation, W, H, namer, rPlace, terr.basins)
  // 地点编辑：用户改过的列表整体替换生成结果（政区按新的都城重算）；缺译名的旧数据用英文名兜底
  const ja = new JaNamer()
  const labels = edits.labels ? edits.labels.map((l) => ({ ...l, zh: l.zh || l.name, ja: l.ja || ja.name(l.kind, l.name) })) : generated
  // 政区划分与道路只取决于地面和地点的位置、类型，与名字无关：只改命名时沿用
  const pk = gk + '|' + labels.map((l) => `${l.kind}:${l.x},${l.y}`).join(';')
  let places = cache?.places?.key === pk ? cache.places : undefined
  if (!places) {
    // 国界、道路的坡度代价按晕渲同样的夸张比例算：全球图每格几十公里，真实坡度太缓，道路会直接翻山
    const slopeKm = reliefKm({ W, kmPerCell })
    progress('划分政区', 0.96)
    const map = realmMap(elev, hydro.flow, labels, W, H, slopeKm, riverThreshold(W), rPlace.fork())
    progress('道路与航线', 0.97)
    const roads = buildRoads(elev, water, biome, hydro.flow, labels, W, H, slopeKm, riverThreshold(W))
    places = { key: pk, map, roads }
    if (cache) cache.places = places
  }
  const realm = places.map.realm.slice()
  const realms = nameRealms(places.map, namer)
  const roads = places.roads
  const genName = namer.name('world')
  const worldName = edits.worldName ?? genName.en

  let land = 0
  let peak = -Infinity
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
    elevation: elev.slice(),
    water: water.slice(),
    temperature: temperature.slice(),
    precipitation: precipitation.slice(),
    flow: hydro.flow.slice(),
    biome: biome.slice(),
    coastDist: coastDist.slice(),
    rivers,
    labels,
    realm,
    realms,
    roads,
    worldName,
    worldNameZh: edits.worldNameZh ?? (edits.worldName ? edits.worldName : genName.zh),
    worldNameJa: edits.worldNameJa ?? (edits.worldName ? ja.name('world', edits.worldName) : genName.ja),
    kmPerCell,
    stats: {
      land: land / N,
      peak,
      trench,
      lakes: hydro.lakes.filter((l) => l.cells.length > 0).length,
      rivers: rivers.length,
      ms: performance.now() - t0,
    },
  }
}

/** 影响地面（高度、气候、水文、群系）的全部输入：除命名以外的参数 + 地形与气候编辑 */
export function groundKey(p: WorldParams, edits: WorldEdits = {}) {
  const { naming: _naming, ...rest } = p
  return JSON.stringify([terrainKey(p, edits), rest, arrayHash(edits.temp), arrayHash(edits.rain)])
}

function arrayHash(a?: ArrayLike<number>) {
  if (!a) return 0
  // 已经是 Float32Array 就直接按位读，不复制整张图
  const f = a instanceof Float32Array ? a : Float32Array.from(a)
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length)
  let h = 2166136261
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619)
  return h >>> 0
}

/** 地名之前的全部结果：只改命名时直接沿用（地点位置用独立的随机数流，与命名无关） */
export interface GroundStage {
  key: string
  elev: Float32Array
  coastDist: Float32Array
  temperature: Float32Array
  precipitation: Float32Array
  hydro: HydroResult
  rivers: River[]
  water: Float32Array
  biome: Uint8Array
}

/** 海岸距离、气候、水文、河道下切、水面与生物群系 */
function groundStage(
  p: WorldParams,
  progress: Progress,
  edits: WorldEdits,
  stage: TerrainStage,
  W: number,
  H: number,
  kmPerCell: number,
  rClimate: RNG,
  key: string,
): GroundStage {
  // 河道下切会改动高度，地形缓存要保持原样
  const elev = Float32Array.from(stage.elev)
  const N = W * H

  // —— 海岸距离（有符号） ——
  progress('海岸线与大陆架', 0.72)
  const coastDist = signedCoastDist(elev, W, H)

  // —— 气候 ——
  progress('大气环流与降水', 0.75)
  const temperature = temperatureField(p, elev, coastDist, W, H, rClimate.fork())
  const precipitation = precipitationField(p, elev, temperature, W, H, kmPerCell, rClimate.fork())
  // 气候编辑：气温偏移、降水倍率
  if (edits.temp && edits.temp.length === N) for (let i = 0; i < N; i++) temperature[i] += edits.temp[i]
  if (edits.rain && edits.rain.length === N) for (let i = 0; i < N; i++) precipitation[i] *= dmath.exp(edits.rain[i])

  // —— 水文 ——
  progress('汇流、湖泊与内流盆地', 0.82)
  const runoff = new Float32Array(N)
  const lakeEvap = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const pr = precipitation[i]
    const e = pet(temperature[i])
    // Budyko 型径流：干旱区几乎全部蒸发
    const aridity = e / pr
    const ratio = dmath.pow(1 + dmath.pow(aridity, 2.2), -1 / 2.2)
    runoff[i] = elev[i] > 0 ? (pr * ratio) / 1000 : 0
    lakeEvap[i] = (Math.max(0, e * 1.05 - pr * 0.9)) / 1000
  }
  // 汇流用"扰动地表"：陆上叠加低频微地形，平原与均匀斜坡上的水流会汇合成树枝状水系，
  // 而不是一排排互不相交的平行直线。真实高度不改。
  const route = routingSurface(elev, W, H, rClimate.fork())
  const hydro = hydrology(route, runoff, lakeEvap, W, H)
  // 湖面高度按真实地形重算（扰动只影响流向）
  for (const lk of hydro.lakes) {
    if (!lk.cells.length) continue
    let lv = -Infinity
    let rim = Infinity
    for (const c of lk.cells) {
      lv = Math.max(lv, elev[c])
      for (const o of [1, -1, W, -W]) {
        const j = c + o
        if (j >= 0 && j < elev.length && hydro.lakeId[j] < 0 && elev[j] > 0) rim = Math.min(rim, elev[j])
      }
    }
    // 湖面不高过湖岸最低处，水不会漫出湖盆
    lk.level = Math.min(lv, rim)
    for (const c of lk.cells) hydro.lakeLevel[c] = lk.level
  }
  const rivers = extractRivers(hydro, elev, W, H)
  carveRivers(elev, hydro, W, H)

  // —— 水面 ——
  const water = new Float32Array(N).fill(NaN)
  for (let i = 0; i < N; i++) {
    if (elev[i] <= 0) water[i] = 0
    else if (!Number.isNaN(hydro.lakeLevel[i])) water[i] = hydro.lakeLevel[i]
  }

  // —— 生物群系 ——
  progress('生物群系', 0.9)
  const biome = new Uint8Array(N)
  const slope = slopeField(elev, W, H, kmPerCell)
  const saltSet = new Uint8Array(N)
  for (const lk of hydro.lakes) {
    if (!lk.endorheic) continue
    for (const c of lk.dryCells) if (elev[c] < lk.level + 0.12) saltSet[c] = 1
  }
  const flowNear = new Float32Array(N)
  for (let i = 0; i < N; i++) flowNear[i] = dmath.log1p(hydro.flow[i])
  blur(flowNear, W, H, 2, 2)
  for (let i = 0; i < N; i++) {
    const h = elev[i]
    if (h <= 0) {
      biome[i] = Biome.Ocean
      continue
    }
    if (hydro.lakeId[i] >= 0) {
      biome[i] = Biome.Lake
      continue
    }
    const t = temperature[i]
    const pr = precipitation[i]
    if (saltSet[i] && pr < 700) {
      biome[i] = Biome.SaltFlat
      continue
    }
    let b = classifyBiome(h, t, pr, slope[i], coastDist[i])
    // 湿地：低平、水多的河口与河漫滩
    if (t > 2 && h < 0.35 && slope[i] < 0.012 && flowNear[i] > 2.2 && pr > 500 && b !== Biome.Beach) b = Biome.Wetland
    biome[i] = b
  }

  return { key, elev, coastDist, temperature, precipitation, hydro, rivers, water, biome }
}

/** 造山 + 地形编辑 + 各级侵蚀，得到侵蚀结束时的地形 */
function terrainStage(
  p: WorldParams,
  progress: Progress,
  edits: WorldEdits,
  W: number,
  H: number,
  kmPerCell: number,
  rTerrain: RNG,
  rErode: RNG,
  key: string,
  cache?: WorldCache,
): TerrainStage {
  const N = W * H
  // 板块造山与地形编辑无关：连续画笔重算时沿用
  const pk = terrainKey(p)
  let base = cache?.plates?.key === pk ? cache.plates.terr : undefined
  if (base) progress('沿用板块与造山', 0.18)
  else {
    progress('板块运动与造山', 0.02)
    base = p.earth ? buildEarthTerrain(p, rTerrain) : buildTerrain(p, rTerrain, kmPerCell)
    if (cache) cache.plates = { key: pk, terr: base }
  }
  const terr = { ...base, elev: base.elev.slice(), uplift: base.uplift.slice() }
  const elev = terr.elev
  // 地形编辑：在侵蚀之前叠加"意图"，抬高的地方同时获得构造抬升，侵蚀后仍能保持山体
  if (edits.terrain && edits.terrain.length === N) {
    for (let i = 0; i < N; i++) {
      const d = edits.terrain[i]
      if (d === 0) continue
      elev[i] += d
      if (d > 0) terr.uplift[i] += d * 0.6
    }
  }

  // —— 侵蚀 ——
  progress('填平噪声洼地', 0.18)
  fillSmallDepressions(elev, W, H, 60, 0.06)

  // 地球底图已是真实地形：不做会整体改形的粗尺度抬升侵蚀，只做后面的细部侵蚀
  const cIters = p.earth ? 0 : Math.round(TUNE.cIters * Math.min(1.5, p.erosion))
  if (cIters > 0) {
    // 整个大陆都在缓慢抬升（均衡），造山带抬升更快
    const up = new Float32Array(N)
    for (let i = 0; i < N; i++) up[i] = elev[i] > 0 ? terr.uplift[i] + TUNE.cBase * elev[i] : 0
    coarseErosion(
      elev,
      up,
      W,
      H,
      Math.max(2, Math.round(W / 256)),
      cIters,
      { kf: TUNE.ckf, m: 0.5, upliftRate: TUNE.cUplift, diffusion: TUNE.cDiff },
      (i) => progress('构造抬升与流水下切', 0.2 + 0.15 * (i / cIters)),
    )
  }
  // 抬升-侵蚀平衡后的高度偏高：按分位数把最高峰压回合理范围
  {
    let mx = 0
    const land: number[] = []
    for (let i = 0; i < N; i += 7) if (elev[i] > 0) land.push(elev[i])
    land.sort((a, b) => a - b)
    mx = land[Math.floor(land.length * 0.998)] ?? 1
    const target = 5.0 * (0.55 + 0.45 * p.mountains)
    if (mx > target) {
      const k = target / mx
      for (let i = 0; i < N; i++) if (elev[i] > 0) elev[i] = Math.max(0.002, elev[i] * k)
    }
  }
  const iters = Math.round(TUNE.spIters * p.erosion)
  if (iters > 0) {
    streamPowerErosion(
      elev,
      terr.uplift,
      W,
      H,
      iters,
      { kf: TUNE.kf, m: 0.5, upliftRate: TUNE.uplift, diffusion: TUNE.diffusion },
      (i) => progress('流水下切 · 树枝状水系', 0.35 + 0.15 * (i / iters)),
    )
  }
  progress('雨滴冲刷与沉积', 0.5)
  // 记住大型洼地的地形：雨滴沉积会把湖盆填平，之后恢复湖底
  const protect = protectedBasins(elev, W, H)
  const drops = Math.round(N * TUNE.drops * p.erosion)
  if (drops > 0) dropletErosion(elev, W, H, drops, rErode, 0.12, (f) => progress('雨滴冲刷与沉积', 0.5 + 0.18 * f))
  progress('热力风化', 0.68)
  thermalErosion(elev, W, H, Math.round(12 * p.erosion) + 2, 0.9 * (kmPerCell / 5.86), 0.3)

  for (const [c, h] of protect) if (elev[c] > h) elev[c] = h
  // 侵蚀可能挖出的新小坑再填一次
  fillSmallDepressions(elev, W, H, 80, 0.06)

  return { key, elev, basins: terr.basins }
}

function protectedBasins(elev: Float32Array, W: number, H: number): Map<number, number> {
  const { filled } = priorityFlood(elev, W, H, 1e-6)
  const { list } = findDepressions(elev, filled, W, H, 0.004)
  const m = new Map<number, number>()
  for (const d of list) {
    if (d.cells.length < 40 || d.maxDepth < 0.05) continue
    for (const c of d.cells) m.set(c, elev[c])
  }
  return m
}

export function signedCoastDist(elev: Float32Array, W: number, H: number) {
  const N = W * H
  const land = new Uint8Array(N)
  const sea = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    land[i] = elev[i] > 0 ? 1 : 0
    sea[i] = 1 - land[i]
  }
  const dl = edt(land, W, H)
  const ds = edt(sea, W, H)
  const out = new Float32Array(N)
  for (let i = 0; i < N; i++) out[i] = land[i] ? ds[i] : -dl[i]
  return out
}

export function slopeField(elev: Float32Array, W: number, H: number, kmPerCell: number) {
  const s = new Float32Array(W * H)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const gx = (elev[i + 1] - elev[i - 1]) / (2 * kmPerCell)
      const gy = (elev[i + W] - elev[i - W]) / (2 * kmPerCell)
      s[i] = dmath.hypot(gx, gy)
    }
  }
  return s
}

/** 河流阈值：以 1024 宽为基准的汇流量 */
export function riverThreshold(W: number) {
  return 90 * dmath.pow(W / 1024, 2)
}

/** 从汇流场提取河流折线：从每个源头向下游追踪，直到入海、入湖或汇入已有河道 */
function routingSurface(elev: Float32Array, W: number, H: number, rng: RNG): Float32Array {
  const n = new Noise(rng)
  const out = new Float32Array(elev)
  const s = 1024 / W
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const h = elev[i]
      if (h <= 0) continue
      // 两个尺度的微洼：~40 格的汇水盆与 ~12 格的细谷；越平的地方相对越重要
      const u = (x * s) / 40
      const v = (y * s) / 40
      const m = n.fbm(u, v, 3) * 0.04 + n.fbm(u * 3.3 + 7, v * 3.3 - 3, 2) * 0.012
      // 离海岸很近时收敛到原值，避免改变入海口
      const fade = Math.min(1, h / 0.02)
      out[i] = Math.max(0.0005, h + m * fade)
    }
  }
  return out
}

function extractRivers(hydro: HydroResult, elev: Float32Array, W: number, H: number): River[] {
  const N = W * H
  const thr = riverThreshold(W)
  const { dir, flow, lakeId } = hydro
  const isRiver = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (flow[i] >= thr && elev[i] > 0 && lakeId[i] < 0) isRiver[i] = 1
  // 有上游河道的格不是源头
  const hasUp = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (isRiver[i] && dir[i] >= 0) hasUp[dir[i]] = 1
  // 按河口流量从大到小处理：先追踪每条从源头到汇点的路径
  interface Path {
    cells: number[]
    mouthFlow: number
    toSea: boolean
  }
  const paths: Path[] = []
  for (let h = 0; h < N; h++) {
    if (!isRiver[h] || hasUp[h]) continue
    const cells: number[] = []
    let c = h
    let toSea = false
    for (let guard = 0; guard < N; guard++) {
      cells.push(c)
      const t = dir[c]
      if (t < 0) break
      if (elev[t] <= 0 || lakeId[t] >= 0) {
        cells.push(t)
        toSea = true
        break
      }
      c = t
    }
    paths.push({ cells, mouthFlow: flow[cells[cells.length - 1]], toSea })
  }
  paths.sort((a, b) => b.mouthFlow - a.mouthFlow)

  // 占据栅格：已接纳河道周围 R 格
  const R = Math.max(3, Math.round(6 * (W / 1024)))
  const occ = new Uint8Array(N)
  const mark = (c: number) => {
    const cx = c % W
    const cy = (c - cx) / W
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy
      if (y < 0 || y >= H) continue
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx
        if (x < 0 || x >= W || dx * dx + dy * dy > R * R) continue
        occ[y * W + x] = 1
      }
    }
  }
  const visited = new Uint8Array(N)
  const rivers: River[] = []
  for (const p of paths) {
    // 截到与已有河道的汇合点为止（汇合点之后与主流重合）
    const own: number[] = []
    let joins = false
    for (const c of p.cells) {
      own.push(c)
      if (visited[c]) {
        joins = true
        break
      }
    }
    if (own.length < 7) continue
    // 大部分河段贴着已有河道并行 → 视觉上的"平行河/梳齿支流"，丢弃
    // （支流不计汇合口附近那一段，那里本来就挨着干流）
    {
      const upto = joins ? Math.max(0, own.length - (R + 3)) : own.length
      let near = 0
      for (let k = 0; k < upto; k++) if (occ[own[k]]) near++
      if (upto > 0 && near / upto > (joins ? 0.5 : 0.35)) continue
    }
    if (!joins) {
      // 又短又小的入海小溪
      if (own.length < 18 && p.mouthFlow < thr * 3) continue
    }
    const pts: number[] = []
    const fl: number[] = []
    for (let k = 0; k < own.length; k++) {
      const c = own[k]
      pts.push((c % W) + 0.5, Math.floor(c / W) + 0.5)
      fl.push(flow[own[Math.max(0, k - (k === own.length - 1 && !joins ? 1 : 0))]])
    }
    for (const c of own) {
      if (!visited[c]) {
        visited[c] = 1
        mark(c)
      }
    }
    rivers.push({ points: Float32Array.from(pts), flow: Float32Array.from(fl) })
  }
  return rivers
}

/** 河谷：沿河道轻微下切，让 3D 中的河流嵌在地表里 */
function carveRivers(elev: Float32Array, hydro: HydroResult, W: number, H: number) {
  const thr = riverThreshold(W) * 0.5
  const N = W * H
  const { flow, lakeId } = hydro
  const { off } = neighbors8(W)
  const cut = new Float32Array(N)
  for (let i = W + 1; i < N - W - 1; i++) {
    if (elev[i] <= 0 || lakeId[i] >= 0 || flow[i] < thr) continue
    const d = Math.min(0.06, 0.012 * dmath.log(flow[i] / thr + 1))
    cut[i] = Math.max(cut[i], d)
    for (let k = 0; k < 8; k++) cut[i + off[k]] = Math.max(cut[i + off[k]], d * 0.45)
  }
  for (let i = 0; i < N; i++) {
    if (cut[i] > 0 && elev[i] > 0 && lakeId[i] < 0) elev[i] = Math.max(Math.min(elev[i], 0.004), elev[i] - cut[i])
  }
}

function makeLabels(
  p: WorldParams,
  elev: Float32Array,
  biome: Uint8Array,
  coastDist: Float32Array,
  hydro: HydroResult,
  T: Float32Array,
  P: Float32Array,
  W: number,
  H: number,
  namer: Namer,
  rng: RNG,
  basins: { x: number; y: number; r: number }[],
): Label[] {
  const N = W * H
  const labels: Label[] = []
  const { off, dx, dy } = neighbors8(W)
  const tri = (n: Tri) => ({ name: n.en, zh: n.zh, ja: n.ja })

  // 通用连通分量：返回分量列表
  const components = (pred: (i: number) => boolean) => {
    const lab = new Int32Array(N).fill(-1)
    const out: number[][] = []
    const q = new Int32Array(N)
    for (let s = 0; s < N; s++) {
      if (lab[s] >= 0 || !pred(s)) continue
      let qh = 0
      let qt = 0
      q[qt++] = s
      lab[s] = out.length
      while (qh < qt) {
        const c = q[qh++]
        const cx = c % W
        const cy = (c - cx) / W
        for (let k = 0; k < 8; k++) {
          const x = cx + dx[k]
          const y = cy + dy[k]
          if (x < 0 || y < 0 || x >= W || y >= H) continue
          const j = c + off[k]
          if (lab[j] >= 0 || !pred(j)) continue
          lab[j] = out.length
          q[qt++] = j
        }
      }
      out.push(Array.from(q.subarray(0, qt)))
    }
    return out
  }

  const pca = (cells: number[]) => {
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
    const ang = 0.5 * dmath.atan2(2 * sxy, sxx - syy)
    const tr = (sxx + syy) / cells.length
    const det = (sxx * syy - sxy * sxy) / (cells.length * cells.length)
    const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
    const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
    return { mx, my, ang, major: Math.sqrt(l1) * 2, minor: Math.sqrt(Math.max(0, l2)) * 2 }
  }

  const clampAngle = (a: number) => {
    while (a > Math.PI / 2) a -= Math.PI
    while (a < -Math.PI / 2) a += Math.PI
    return a
  }

  // —— 陆块：大陆 / 岛屿 ——
  const lands = components((i) => elev[i] > 0)
  lands.sort((a, b) => b.length - a.length)
  const landIdOf = new Int32Array(N).fill(-1)
  lands.forEach((cells, id) => {
    for (const c of cells) landIdOf[c] = id
  })
  for (const cells of lands) {
    if (cells.length < 120) break
    // 不可达极点：离海最远的格
    let best = cells[0]
    for (const c of cells) if (coastDist[c] > coastDist[best]) best = c
    const isCont = cells.length > N * 0.02
    const kind = isCont ? 'continent' : 'island'
    const { ang, major, minor } = pca(cells)
    labels.push({ kind,
      ...tri(namer.name(kind)),
      x: best % W,
      y: Math.floor(best / W),
      angle: isCont && major > minor * 1.6 ? clampAngle(ang) * 0.35 : 0,
      weight: cells.length,
      span: major,
    })
  }

  // —— 海洋：离岸最远的局部极大值 ——
  const seaPts: { i: number; d: number }[] = []
  const step = 6
  for (let y = step; y < H - step; y += step) {
    for (let x = step; x < W - step; x += step) {
      const i = y * W + x
      // 离图边太近的点不适合标注（角落总是离陆地最远）
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y) * 1.3
      const d = Math.min(-coastDist[i], edge)
      if (d > 18) seaPts.push({ i, d })
    }
  }
  seaPts.sort((a, b) => b.d - a.d)
  const chosenSea: { x: number; y: number; d: number }[] = []
  for (const s of seaPts) {
    const x = s.i % W
    const y = Math.floor(s.i / W)
    const minSep = Math.max(90, s.d * 3.2)
    if (chosenSea.some((c) => dmath.hypot(c.x - x, c.y - y) < Math.max(minSep, c.d * 3))) continue
    chosenSea.push({ x, y, d: s.d })
    if (chosenSea.length >= 6) break
  }
  chosenSea.forEach((s, k) => {
    const big = k === 0 && s.d > 45
    labels.push({ kind: big ? 'ocean' : 'sea',
      ...tri(big ? namer.name('ocean') : namer.name('sea', k % 2 ? 0.75 : 0.25)),
      x: s.x,
      y: s.y,
      angle: 0,
      weight: s.d * 1000,
      span: s.d * 2,
    })
  })

  // —— 山脉：高海拔区域的连通块，沿主轴标注 ——
  const hi = highlandField(elev, W, H)
  const ranges = components((i) => hi[i] > RANGE_HI)
  ranges.sort((a, b) => b.length - a.length)
  for (const cells of ranges.slice(0, 10)) {
    if (cells.length < 180) break
    const { mx, my, ang, major } = pca(cells)
    // 找离质心最近的属于该山脉的格
    let best = cells[0]
    let bd = Infinity
    for (const c of cells) {
      const d = dmath.pow(c % W - mx, 2) + dmath.pow(Math.floor(c / W) - my, 2)
      if (d < bd) {
        bd = d
        best = c
      }
    }
    labels.push({ kind: 'range',
      ...tri(namer.name('range', rng.next())),
      x: best % W,
      y: Math.floor(best / W),
      angle: clampAngle(ang),
      weight: cells.length * 0.8,
      span: major,
    })
  }

  // —— 盆地 ——
  for (const b of basins) {
    const i = Math.round(b.y) * W + Math.round(b.x)
    if (elev[i] <= 0) continue
    labels.push({ kind: 'basin', ...tri(namer.name('basin')), x: b.x, y: b.y, angle: 0, weight: b.r * 40, span: b.r * 1.5 })
  }

  // —— 沙漠与大森林 ——
  const deserts = components((i) => isDesertBiome(biome[i]))
  deserts.sort((a, b) => b.length - a.length)
  for (const cells of deserts.slice(0, 4)) {
    if (cells.length < 700) break
    const { mx, my, major } = pca(cells)
    const c = nearestIn(cells, mx, my, W)
    labels.push({ kind: 'desert', ...tri(namer.name('desert')), x: c % W, y: Math.floor(c / W), angle: 0, weight: cells.length * 0.4, span: major })
  }
  const forests = components((i) => isForestBiome(biome[i]))
  forests.sort((a, b) => b.length - a.length)
  for (const cells of forests.slice(0, 3)) {
    if (cells.length < 1500) break
    const { mx, my, major } = pca(cells)
    const c = nearestIn(cells, mx, my, W)
    labels.push({ kind: 'forest',
      ...tri(namer.name('forest', rng.next())),
      x: c % W,
      y: Math.floor(c / W),
      angle: 0,
      weight: cells.length * 0.3,
      span: major,
    })
  }

  // —— 湖泊 ——
  for (const lk of hydro.lakes) {
    if (lk.cells.length < 25) continue
    const cells = Array.from(lk.cells)
    const { mx, my } = pca(cells)
    const c = nearestIn(cells, mx, my, W)
    labels.push({ kind: 'lake',
      ...tri(namer.name(lk.endorheic ? 'saltLake' : 'lake')),
      x: c % W,
      y: Math.floor(c / W),
      angle: 0,
      weight: cells.length * 5,
      span: Math.sqrt(cells.length),
    })
  }

  // —— 城市：宜居度评分 + 最小间距 ——
  const score = new Float32Array(N)
  const thr = riverThreshold(W)
  for (let y = 4; y < H - 4; y++) {
    for (let x = 4; x < W - 4; x++) {
      const i = y * W + x
      const h = elev[i]
      if (h <= 0.003 || hydro.lakeId[i] >= 0) continue
      const b = biome[i]
      if (b === Biome.IceCap || b === Biome.Alpine || b === Biome.SaltFlat || b === Biome.Wetland) continue
      const t = T[i]
      const pr = P[i]
      let s = 0
      s += dmath.exp(-dmath.pow((t - 15) / 9, 2)) * 2
      s += Math.min(1, pr / 700) - Math.max(0, (pr - 2600) / 2000)
      s -= h * 0.8
      const lat = Math.abs(latitudeOf(p, y, H))
      s -= Math.max(0, lat - 55) * 0.05
      // 河流、海港、湖岸加分
      if (hydro.flow[i] > thr) s += 0.9 + 0.25 * dmath.log(hydro.flow[i] / thr)
      if (coastDist[i] > 0 && coastDist[i] < 2.2) s += 1.1
      let nearLake = false
      for (let k = 0; k < 8; k++) if (hydro.lakeId[i + off[k] * 2] >= 0) nearLake = true
      if (nearLake) s += 0.8
      // 平坦
      const gx = elev[i + 1] - elev[i - 1]
      const gy = elev[i + W] - elev[i - W]
      s -= dmath.hypot(gx, gy) * 6
      score[i] = s + rng.next() * 0.35
    }
  }
  const cand: number[] = []
  for (let i = 0; i < N; i++) if (score[i] > 1.6) cand.push(i)
  cand.sort((a, b) => score[b] - score[a])
  const cities: { x: number; y: number; land: number }[] = []
  let landCells = 0
  for (let i = 0; i < N; i++) if (elev[i] > 0) landCells++
  const maxCities = Math.min(48, Math.round(landCells / 4200) + 6)
  const minSep = 26 * (W / 1024)
  const capitalOf = new Set<number>()
  for (const i of cand) {
    const x = i % W
    const y = Math.floor(i / W)
    if (cities.some((c) => dmath.pow(c.x - x, 2) + dmath.pow(c.y - y, 2) < minSep * minSep)) continue
    const lid = landIdOf[i]
    const capital = !capitalOf.has(lid) && lid >= 0 && lands[lid].length > 1500
    if (capital) capitalOf.add(lid)
    cities.push({ x, y, land: lid })
    labels.push({ kind: capital ? 'capital' : 'city', ...tri(namer.name(capital ? 'capital' : 'city')), x: x + 0.5, y: y + 0.5, angle: 0, weight: capital ? 5e5 : 3e3 + score[i] * 100, span: 0 })
    if (cities.length >= maxCities) break
  }
  return labels
}

function nearestIn(cells: number[], mx: number, my: number, W: number) {
  let best = cells[0]
  let bd = Infinity
  for (const c of cells) {
    const d = dmath.pow(c % W - mx, 2) + dmath.pow(Math.floor(c / W) - my, 2)
    if (d < bd) {
      bd = d
      best = c
    }
  }
  return best
}
