import { classifyBiome, latitudeOf, pet, precipitationField, temperatureField } from './climate'
import { coarseErosion, dropletErosion, streamPowerErosion, thermalErosion } from './erosion'
import { fillSmallDepressions, findDepressions, hydrology, priorityFlood, type HydroResult } from './hydrology'
import { Language } from './names'
import { ZhNamer } from './names_zh'
import { buildRealms } from './realms'
import { Noise } from './noise'
import { RNG, hashString } from './rng'
import { buildTerrain } from './terrain'
import { Biome, type Label, type River, type World, type WorldParams } from './types'
import { blur, edt, neighbors8 } from './util'

export type Progress = (stage: string, frac: number) => void

/** 地图物理宽度（km） */
const MAP_KM = 6000

/** 侵蚀调参（离线脚本可覆盖） */
export const TUNE = { cBase: 1.3, cIters: 80, ckf: 0.14, cUplift: 0.07, cDiff: 0.02, spIters: 6, kf: 0.0028, uplift: 0.012, diffusion: 0.015, drops: 0.45 }

export function generateWorld(p: WorldParams, progress: Progress = () => {}): World {
  const t0 = performance.now()
  const W = p.width
  const H = p.height
  const N = W * H
  const kmPerCell = MAP_KM / W
  const rng = new RNG(hashString(p.seed))
  const rTerrain = rng.fork()
  const rErode = rng.fork()
  const rClimate = rng.fork()
  const rNames = rng.fork()
  const rPlace = rng.fork()

  progress('板块运动与造山', 0.02)
  const terr = buildTerrain(p, rTerrain, kmPerCell)
  const elev = terr.elev

  // —— 侵蚀 ——
  progress('填平噪声洼地', 0.18)
  fillSmallDepressions(elev, W, H, 60, 0.06)

  const cIters = Math.round(TUNE.cIters * Math.min(1.5, p.erosion))
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

  // —— 海岸距离（有符号） ——
  progress('海岸线与大陆架', 0.72)
  const coastDist = signedCoastDist(elev, W, H)

  // —— 气候 ——
  progress('大气环流与降水', 0.75)
  const temperature = temperatureField(p, elev, coastDist, W, H, rClimate.fork())
  const precipitation = precipitationField(p, elev, temperature, W, H, kmPerCell, rClimate.fork())

  // —— 水文 ——
  progress('汇流、湖泊与内流盆地', 0.82)
  const runoff = new Float32Array(N)
  const lakeEvap = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const pr = precipitation[i]
    const e = pet(temperature[i])
    // Budyko 型径流：干旱区几乎全部蒸发
    const aridity = e / pr
    const ratio = Math.pow(1 + Math.pow(aridity, 2.2), -1 / 2.2)
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
    for (const c of lk.cells) lv = Math.max(lv, elev[c])
    lk.level = lv + 0.002
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
  for (let i = 0; i < N; i++) flowNear[i] = Math.log1p(hydro.flow[i])
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

  // —— 地名与标注 ——
  progress('命名与标注', 0.95)
  const lang = new Language(rNames)
  const zh = new ZhNamer(p.seed)
  const labels = makeLabels(p, elev, biome, coastDist, hydro, temperature, precipitation, W, H, lang, rPlace, terr.basins)
  for (const l of labels) l.zh = zh.name(l.kind, l.name)
  const { realm, realms } = buildRealms(elev, hydro.flow, labels, W, H, kmPerCell, riverThreshold(W), lang, zh, rPlace.fork())
  const worldName = lang.word()

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
    elevation: elev,
    water,
    temperature,
    precipitation,
    flow: hydro.flow,
    biome,
    coastDist,
    rivers,
    labels,
    realm,
    realms,
    worldName,
    worldNameZh: zh.name('world', worldName),
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

function signedCoastDist(elev: Float32Array, W: number, H: number) {
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

function slopeField(elev: Float32Array, W: number, H: number, kmPerCell: number) {
  const s = new Float32Array(W * H)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const gx = (elev[i + 1] - elev[i - 1]) / (2 * kmPerCell)
      const gy = (elev[i + W] - elev[i - W]) / (2 * kmPerCell)
      s[i] = Math.hypot(gx, gy)
    }
  }
  return s
}

/** 河流阈值：以 1024 宽为基准的汇流量 */
export function riverThreshold(W: number) {
  return 90 * (W / 1024) ** 2
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
    // 独立入海/入湖、且大部分河段贴着已有河道并行 → 视觉上的"平行河"，丢弃
    if (!joins) {
      let near = 0
      for (const c of own) if (occ[c]) near++
      if (near / own.length > 0.35) continue
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
    const d = Math.min(0.06, 0.012 * Math.log(flow[i] / thr + 1))
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
  lang: Language,
  rng: RNG,
  basins: { x: number; y: number; r: number }[],
): Label[] {
  const N = W * H
  const labels: Label[] = []
  const { off, dx, dy } = neighbors8(W)

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
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
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
    const nm = lang.word()
    const { ang, major, minor } = pca(cells)
    labels.push({ zh: '', kind: isCont ? 'continent' : 'island',
      name: nm,
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
    if (chosenSea.some((c) => Math.hypot(c.x - x, c.y - y) < Math.max(minSep, c.d * 3))) continue
    chosenSea.push({ x, y, d: s.d })
    if (chosenSea.length >= 6) break
  }
  chosenSea.forEach((s, k) => {
    const nm = lang.word()
    const big = k === 0 && s.d > 45
    labels.push({ zh: '', kind: big ? 'ocean' : 'sea',
      name: big ? `${nm} Ocean` : k % 2 ? `Sea of ${nm}` : `${nm} Sea`,
      x: s.x,
      y: s.y,
      angle: 0,
      weight: s.d * 1000,
      span: s.d * 2,
    })
  })

  // —— 山脉：高海拔区域的连通块，沿主轴标注 ——
  const hi = new Float32Array(N)
  for (let i = 0; i < N; i++) hi[i] = elev[i] > 0 ? elev[i] : 0
  blur(hi, W, H, 3, 2)
  const ranges = components((i) => hi[i] > 1.35)
  ranges.sort((a, b) => b.length - a.length)
  for (const cells of ranges.slice(0, 10)) {
    if (cells.length < 180) break
    const { mx, my, ang, major } = pca(cells)
    // 找离质心最近的属于该山脉的格
    let best = cells[0]
    let bd = Infinity
    for (const c of cells) {
      const d = (c % W - mx) ** 2 + (Math.floor(c / W) - my) ** 2
      if (d < bd) {
        bd = d
        best = c
      }
    }
    const nm = lang.word()
    labels.push({ zh: '', kind: 'range',
      name: rng.next() < 0.5 ? `${nm} Mountains` : `The ${nm}s`,
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
    labels.push({ zh: '', kind: 'basin', name: `${lang.word()} Basin`, x: b.x, y: b.y, angle: 0, weight: b.r * 40, span: b.r * 1.5 })
  }

  // —— 沙漠与大森林 ——
  const deserts = components((i) => biome[i] === Biome.HotDesert || biome[i] === Biome.ColdDesert || biome[i] === Biome.SaltFlat)
  deserts.sort((a, b) => b.length - a.length)
  for (const cells of deserts.slice(0, 4)) {
    if (cells.length < 700) break
    const { mx, my, major } = pca(cells)
    const c = nearestIn(cells, mx, my, W)
    labels.push({ zh: '', kind: 'desert', name: `${lang.word()} Desert`, x: c % W, y: Math.floor(c / W), angle: 0, weight: cells.length * 0.4, span: major })
  }
  const forests = components((i) => biome[i] === Biome.TropicalRainforest || biome[i] === Biome.TemperateRainforest || biome[i] === Biome.Taiga)
  forests.sort((a, b) => b.length - a.length)
  for (const cells of forests.slice(0, 3)) {
    if (cells.length < 1500) break
    const { mx, my, major } = pca(cells)
    const c = nearestIn(cells, mx, my, W)
    const nm = lang.word()
    labels.push({ zh: '', kind: 'forest',
      name: rng.next() < 0.5 ? `${nm} Forest` : `${nm}wood`,
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
    labels.push({ zh: '', kind: 'lake',
      name: `${lk.endorheic ? 'Salt Lake' : 'Lake'} ${lang.word()}`,
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
      s += Math.exp(-(((t - 15) / 9) ** 2)) * 2
      s += Math.min(1, pr / 700) - Math.max(0, (pr - 2600) / 2000)
      s -= h * 0.8
      const lat = Math.abs(latitudeOf(p, y, H))
      s -= Math.max(0, lat - 55) * 0.05
      // 河流、海港、湖岸加分
      if (hydro.flow[i] > thr) s += 0.9 + 0.25 * Math.log(hydro.flow[i] / thr)
      if (coastDist[i] > 0 && coastDist[i] < 2.2) s += 1.1
      let nearLake = false
      for (let k = 0; k < 8; k++) if (hydro.lakeId[i + off[k] * 2] >= 0) nearLake = true
      if (nearLake) s += 0.8
      // 平坦
      const gx = elev[i + 1] - elev[i - 1]
      const gy = elev[i + W] - elev[i - W]
      s -= Math.hypot(gx, gy) * 6
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
    if (cities.some((c) => (c.x - x) ** 2 + (c.y - y) ** 2 < minSep * minSep)) continue
    const lid = landIdOf[i]
    const capital = !capitalOf.has(lid) && lid >= 0 && lands[lid].length > 1500
    if (capital) capitalOf.add(lid)
    cities.push({ x, y, land: lid })
    labels.push({ zh: '', kind: capital ? 'capital' : 'city', name: lang.word(), x: x + 0.5, y: y + 0.5, angle: 0, weight: capital ? 5e5 : 3e3 + score[i] * 100, span: 0 })
    if (cities.length >= maxCities) break
  }
  return labels
}

function nearestIn(cells: number[], mx: number, my: number, W: number) {
  let best = cells[0]
  let bd = Infinity
  for (const c of cells) {
    const d = (c % W - mx) ** 2 + (Math.floor(c / W) - my) ** 2
    if (d < bd) {
      bd = d
      best = c
    }
  }
  return best
}
