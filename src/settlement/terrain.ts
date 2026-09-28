import { Noise } from '../gen/noise'
import { RNG, hashString } from '../gen/rng'
import { edt } from '../gen/util'
import { chaikin, dist, pointInPoly, polylineDist, resample, type P } from './geom'
import type { SettlementParams, Terrain } from './types'

/** 地形网格的格距（米） */
export const TERRAIN_CELL = 5

/** 逐段等分加点，使相邻点距离不超过 step */
function densify(line: P[], step: number): P[] {
  const out: P[] = []
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]
    const b = line[i + 1]
    const n = Math.max(1, Math.ceil(dist(a, b) / step))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  if (line.length) out.push(line[line.length - 1])
  return out
}

/** smoothstep */
const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export interface TerrainResult {
  terrain: Terrain
  river: { line: P[]; hw: number[] } | null
  /** 海的方向（单位向量）与岸线离中心的距离 */
  coast: { dir: P; shore: number } | null
  hillDir: P | null
  /** 双线性采样高程 / 水距 */
  heightAt: (p: P) => number
  waterAt: (p: P) => number
  /** 水距的梯度（指向远离水体的方向） */
  waterGrad: (p: P) => P
  slopeAt: (p: P) => number
  /** 是否为海（河道不算） */
  seaAt: (p: P) => boolean
}

/** 算好的整块地形：按档位放大的画框上的网格与河道，裁出实际画框再用（见 buildTerrain） */
interface Field {
  W: number
  H: number
  height: Float32Array
  water: Float32Array
  sea: Uint8Array
  river: { line: P[]; hw: number[]; u: P } | null
  coast: TerrainResult['coast']
  hillDir: P | null
}

/** 地形的随机数种子：固定了地形种子用它，否则跟着种子与文明 */
export const terrainKey = (p: Pick<SettlementParams, 'seed' | 'culture' | 'terrainSeed'>) => p.terrainSeed || `${p.seed}|${p.culture}`

/** 地形只由这些参数定（与人口、规模无关） */
const fieldKey = (p: SettlementParams) => [terrainKey(p), p.river, p.coast, p.hills, p.relief, p.coastDir, p.riverDir, p.hillDir].join('|')

/** 画框之外多算的一圈（米）：水距、河谷这类距离场在画框边上也不受截断影响 */
const MARGIN = 300
/** 计算范围按档位取整（每档放大约 1.25 倍，都是 40 米的倍数）：同一档里换人口直接裁缓存，结果也不取决于之前算过什么 */
function bucket(x: number) {
  let b = 480
  while (b < x + 2 * MARGIN) b = Math.ceil((b * 1.25) / 40) * 40
  return b
}
/** 最近算过的一块地形：拖人口滑块、成长动画时逐帧生成，免得每帧重算整张网格 */
let cached: { key: string; field: Field } | null = null

/**
 * 局部地形：缓坡基底 + 可选的"依山"山体、海岸与穿城河流。
 * 河流先定走向再下切河谷，保证水往低处流；海岸在城市附近内凹成海湾，便于建港。
 *
 * 地形定义在以地图中心为原点的"世界坐标"里，尺度都是固定的米数，与地图范围（随人口放大）无关：
 * 同一个种子，人口多少只决定画面框多大，山、河、海岸的位置不变，聚落才能连续地长大。
 * 实际在按档位放大的画框上算好、缓存，再裁出这次的画框（extent 须是 20 米的倍数）。
 */
export function buildTerrain(p: SettlementParams, extent: [number, number]): TerrainResult {
  // 没固定地形种子时，与聚落的随机数流同源（第一个分支），老的种子生成的地形不变
  const rng = new RNG(hashString(terrainKey(p))).fork()
  const big: [number, number] = [bucket(extent[0]), bucket(extent[1])]
  const key = `${fieldKey(p)}|${big}`
  if (cached?.key !== key) cached = { key, field: computeField(p, rng, big) }
  return crop(cached.field, big, extent)
}

/** 从整块地形里裁出以同一点为中心、范围为 extent 的一块（网格复制一份：levelTerrain 会改高程） */
function crop(F: Field, big: [number, number], extent: [number, number]): TerrainResult {
  const [MW, MH] = extent
  const cell = TERRAIN_CELL
  const ox = (big[0] - MW) / 2
  const oy = (big[1] - MH) / 2
  const i0 = ox / cell
  const j0 = oy / cell
  const W = Math.ceil(MW / cell) + 1
  const H = Math.ceil(MH / cell) + 1
  const N = W * H
  const height = new Float32Array(N)
  const water = new Float32Array(N)
  const sea = new Uint8Array(N)
  for (let j = 0; j < H; j++) {
    const a = (j + j0) * F.W + i0
    height.set(F.height.subarray(a, a + W), j * W)
    water.set(F.water.subarray(a, a + W), j * W)
    sea.set(F.sea.subarray(a, a + W), j * W)
  }
  let river: TerrainResult['river'] = null
  if (F.river) {
    // 河道只留画框外接圆附近的一段（沿河按 60 米取样，与原先按画框取样的范围一致）
    const cx = big[0] / 2
    const cy = big[1] / 2
    const reach = (Math.ceil(Math.hypot(MW, MH) / 2 / 60) + 1) * 60
    const { line, hw, u } = F.river
    const keep = line.map(([x, y]) => Math.abs((x - cx) * u[0] + (y - cy) * u[1]) <= reach)
    river = { line: line.filter((_, k) => keep[k]).map(([x, y]) => [x - ox, y - oy]), hw: hw.filter((_, k) => keep[k]) }
  }
  return { ...sample(W, H, height, water, sea), river, coast: F.coast, hillDir: F.hillDir }
}

function computeField(p: SettlementParams, rng: RNG, extent: [number, number]): Field {
  const [MW, MH] = extent
  // 网格固定 5 米，且地图范围是 20 米的倍数（见 generate.ts）：网格点落在世界坐标的固定位置上，
  // 同一处的高程、水距在任何规模下都一样
  const cell = TERRAIN_CELL
  const W = Math.ceil(MW / cell) + 1
  const H = Math.ceil(MH / cell) + 1
  const N = W * H
  const noise = new Noise(rng.fork())
  const cx = MW / 2
  const cy = MH / 2
  /** 地形的参照尺度（米） */
  const R = 620
  const angle = (a: number) => (Number.isFinite(a) ? a : rng.range(0, Math.PI * 2))
  // 噪声都按世界坐标取样（与画面框无关）
  const fbm = (x: number, y: number, sx: number, ox: number, oy: number, oct: number) => noise.fbm((x - cx) / sx + ox, (y - cy) / sx + oy, oct)

  const coastA = angle(p.coastDir)
  const cd: P = [Math.cos(coastA), Math.sin(coastA)]
  // 岸线：城心正前方内凹成海湾，湾顶离城心固定的距离；两侧岸线随噪声起伏
  const shoreC = rng.range(90, 200)
  const bay = rng.range(60, 150)
  const bayW = rng.range(200, 380)
  const shoreAt = (x: number, y: number) => {
    const t = -(x - cx) * cd[1] + (y - cy) * cd[0]
    const open = 1 - Math.exp(-((t / bayW) ** 2))
    return shoreC + (bay + noise.fbm(t / 520 + 11.3, 3.7, 4) * R * 0.2) * open
  }

  let hillA = angle(p.hillDir)
  // 依山又临海时，山在海的对面一侧
  if (p.coast && p.hills && !Number.isFinite(p.hillDir)) hillA = coastA + Math.PI + rng.range(-0.8, 0.8)
  const hd: P = [Math.cos(hillA), Math.sin(hillA)]
  const hillH = 55 + 110 * p.relief

  const height = new Float32Array(N)
  const rel = 0.25 + p.relief
  // 噪声的尺度都在一两百米以上：先在 20 米的粗网格上算（网格点对齐世界坐标），再双线性插到 5 米的细网格
  const step = 4
  const oi = ((Math.round(cx / cell) % step) + step) % step
  const oj = ((Math.round(cy / cell) % step) + step) % step
  const CW = Math.ceil((W - oi) / step) + 2
  const CH = Math.ceil((H - oj) / step) + 2
  const baseC = new Float32Array(CW * CH)
  const shoreGrid = new Float32Array(CW * CH)
  for (let cj = 0; cj < CH; cj++)
    for (let ci = 0; ci < CW; ci++) {
      const x = (oi + (ci - 1) * step) * cell
      const y = (oj + (cj - 1) * step) * cell
      let h = 6 + rel * (fbm(x, y, 520, 0, 0, 4) * 16 + 12) + rel * fbm(x, y, 140, 7, -3, 3) * 3.5
      if (p.hills) {
        const d = (x - cx) * hd[0] + (y - cy) * hd[1]
        const t = sm(R * 0.1, R * 1.5, d + fbm(x, y, 380, -5, 9, 3) * R * 0.3)
        const ridge = noise.ridged((x - cx) / 330 + 2.1, (y - cy) / 330 - 7.7, 4)
        h += t * hillH * (0.45 + 0.9 * ridge) + t * t * hillH * 0.4
      }
      baseC[cj * CW + ci] = h
      if (p.coast) shoreGrid[cj * CW + ci] = shoreAt(x, y)
    }
  const lerpC = (f: Float32Array, i: number, j: number) => {
    const fx = (i - oi) / step + 1
    const fy = (j - oj) / step + 1
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const k = y0 * CW + x0
    return (f[k] * (1 - tx) + f[k + 1] * tx) * (1 - ty) + (f[k + CW] * (1 - tx) + f[k + CW + 1] * tx) * ty
  }
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = i * cell
      const y = j * cell
      let h = lerpC(baseC, i, j)
      if (p.coast) {
        const s = lerpC(shoreGrid, i, j) - ((x - cx) * cd[0] + (y - cy) * cd[1])
        h = s >= 0 ? Math.max(0.4, h * sm(-20, 220, s)) : s * 0.06
      }
      height[j * W + i] = h
    }
  }

  // —— 河流 ——
  let river: Field['river'] = null
  const riverMask = new Uint8Array(N)
  let hwAt = (_x: number, _y: number) => 0
  if (p.river) {
    // 河宽只由种子定（与聚落大小无关），聚落长大时河不变宽
    const hw0 = rng.range(6, 16)
    // 来向：临海时从内陆流向海，否则随机
    let from = angle(p.riverDir)
    if (p.coast && !Number.isFinite(p.riverDir)) from = coastA + Math.PI + rng.range(-0.9, 0.9)
    const u: P = [-Math.cos(from), -Math.sin(from)] // 流向
    const n: P = [-u[1], u[0]]
    // 离中心的横向偏移：城市通常建在河的一侧并跨河发展
    const off = R * rng.range(-0.2, 0.2)
    const amp = R * rng.range(0.08, 0.2)
    // 沿河按固定步长取样（步长与画面无关，大小地图上同一段河道完全一样）
    const step = 60
    const half = Math.ceil(Math.hypot(MW, MH) / 2 / step) + 1
    const pts: P[] = []
    for (let k = -half; k <= half; k++) {
      const s = k * step
      const wig = noise.fbm(s / 650 + 31.1, 0.5, 3) * amp * 2.2
      pts.push([cx + u[0] * s + n[0] * (off + wig), cy + u[1] * s + n[1] * (off + wig)])
    }
    let line = chaikin(pts, 3)
    // 临海：流到海里就截断（再多留一段伸进海里，保证河口与海相连）
    if (p.coast) {
      const cut = line.findIndex(([x, y]) => shoreAt(x, y) - ((x - cx) * cd[0] + (y - cy) * cd[1]) < -hw0 * 3)
      if (cut > 0) line = line.slice(0, cut + 1)
    }
    // 逐段加密（不从起点按弧长重采样）：同一段河道的点在大小地图上完全一样
    line = densify(line, cell)
    hwAt = (x: number, y: number) => hw0 * (1 + 0.18 * fbm(x, y, 260, 50, 0, 2))
    river = { line, hw: line.map(([x, y]) => hwAt(x, y)), u }

    // 河谷：按到中线的距离下切
    const center = new Uint8Array(N)
    for (const [x, y] of densify(line, cell * 0.5)) {
      const i = Math.round(x / cell)
      const j = Math.round(y / cell)
      if (i >= 0 && j >= 0 && i < W && j < H) center[j * W + i] = 1
    }
    const dC = edt(center, W, H)
    const valley = 90 + 220 * (1 - p.relief) + hw0 * 4
    for (let k = 0; k < N; k++) {
      const x = (k % W) * cell
      const y = Math.floor(k / W) * cell
      const d = dC[k] * cell
      const hw = hwAt(x, y)
      if (d < hw) riverMask[k] = 1
      const floor = 0.6 + Math.max(0, d - hw) * 0.035
      const t = sm(hw * 1.2, hw * 1.2 + valley, d)
      const bed = d < hw ? -1.5 * (1 - d / hw) : floor
      height[k] = Math.min(height[k], bed * (1 - t) + height[k] * t)
      if (d < hw) height[k] = Math.min(height[k], -0.5)
    }
  }

  // —— 水体有向距离场 ——
  const wet = new Uint8Array(N)
  const dry = new Uint8Array(N)
  for (let k = 0; k < N; k++) {
    const w = height[k] < 0 || riverMask[k] === 1
    wet[k] = w ? 1 : 0
    dry[k] = w ? 0 : 1
  }
  const dOut = edt(wet, W, H)
  const dIn = edt(dry, W, H)
  const water = new Float32Array(N)
  for (let k = 0; k < N; k++) water[k] = (wet[k] ? -dIn[k] + 0.5 : dOut[k] - 0.5) * cell
  const sea = new Uint8Array(N)
  for (let k = 0; k < N; k++) sea[k] = height[k] < 0 && !riverMask[k] ? 1 : 0
  return { W, H, height, water, sea, river, coast: p.coast ? { dir: cd, shore: shoreC } : null, hillDir: p.hills ? hd : null }
}

/** 网格上的采样函数 */
function sample(W: number, H: number, height: Float32Array, water: Float32Array, sea: Uint8Array) {
  const cell = TERRAIN_CELL
  const bil = (f: Float32Array) => (q: P) => {
    const fx = Math.min(W - 1.001, Math.max(0, q[0] / cell))
    const fy = Math.min(H - 1.001, Math.max(0, q[1] / cell))
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const tx = fx - i
    const ty = fy - j
    const k = j * W + i
    return (f[k] * (1 - tx) + f[k + 1] * tx) * (1 - ty) + (f[k + W] * (1 - tx) + f[k + W + 1] * tx) * ty
  }
  const seaAt = (q: P) => {
    const i = Math.min(W - 1, Math.max(0, Math.round(q[0] / cell)))
    const j = Math.min(H - 1, Math.max(0, Math.round(q[1] / cell)))
    return sea[j * W + i] === 1
  }
  const heightAt = bil(height)
  const waterAt = bil(water)
  const g = cell
  const waterGrad = (q: P): P => {
    const gx = waterAt([q[0] + g, q[1]]) - waterAt([q[0] - g, q[1]])
    const gy = waterAt([q[0], q[1] + g]) - waterAt([q[0], q[1] - g])
    const L = Math.hypot(gx, gy) || 1
    return [gx / L, gy / L]
  }
  const slopeAt = (q: P) => {
    const gx = heightAt([q[0] + g, q[1]]) - heightAt([q[0] - g, q[1]])
    const gy = heightAt([q[0], q[1] + g]) - heightAt([q[0], q[1] - g])
    return Math.hypot(gx, gy) / (2 * g)
  }

  return {
    terrain: { W, H, cell, height, water },
    heightAt,
    waterAt,
    waterGrad,
    slopeAt,
    seaAt,
  }
}

/**
 * 网格 A*：在地形上找一条代价最低的路（坡度、涉水都有代价）。
 * 海不可通行（过河靠桥，过海不行）；终点不可达时返回空数组。
 */
export function routeOnTerrain(T: TerrainResult, from: P, to: P, opts: { water: number; slope: number; bias?: (p: P) => number }): P[] {
  const { W, H, cell } = T.terrain
  // 用较粗的网格寻路，保证速度
  const s = Math.max(1, Math.round(8 / cell))
  const GW = Math.ceil(W / s)
  const GH = Math.ceil(H / s)
  const gc = cell * s
  const idx = (q: P) => Math.min(GH - 1, Math.max(0, Math.round(q[1] / gc))) * GW + Math.min(GW - 1, Math.max(0, Math.round(q[0] / gc)))
  const start = idx(from)
  const goal = idx(to)
  const N = GW * GH
  const gScore = new Float64Array(N).fill(Infinity)
  const prev = new Int32Array(N).fill(-1)
  // 每格的高程、地表（1 海，2 水，0 陆）与偏好只算一次：同一格会被周围十几个格子反复问到
  const hAt = new Float64Array(N).fill(NaN)
  const surf = new Int8Array(N).fill(-1)
  const biasAt = opts.bias ? new Float64Array(N).fill(NaN) : null
  const height = (k: number) => {
    let h = hAt[k]
    if (h !== h) h = hAt[k] = T.heightAt([(k % GW) * gc, Math.floor(k / GW) * gc])
    return h
  }
  const surface = (k: number) => {
    let v = surf[k]
    if (v < 0) {
      const q: P = [(k % GW) * gc, Math.floor(k / GW) * gc]
      v = surf[k] = T.seaAt(q) ? 1 : T.waterAt(q) < 0 ? 2 : 0
    }
    return v
  }
  // 小顶堆：f 与格号分放两个数组（不再每次推入都新建一个元组），比较与交换的规则照旧，出堆次序不变
  const hf: number[] = []
  const hk: number[] = []
  const swap = (a: number, b: number) => {
    const f = hf[a]
    hf[a] = hf[b]
    hf[b] = f
    const k = hk[a]
    hk[a] = hk[b]
    hk[b] = k
  }
  const push = (k: number, f: number) => {
    hf.push(f)
    hk.push(k)
    let i = hf.length - 1
    while (i > 0) {
      const pa = (i - 1) >> 1
      if (hf[pa] <= hf[i]) break
      swap(pa, i)
      i = pa
    }
  }
  const pop = () => {
    const top = hk[0]
    const lf = hf.pop()!
    const lk = hk.pop()!
    const n = hf.length
    if (n) {
      hf[0] = lf
      hk[0] = lk
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && hf[c + 1] < hf[c]) c++
        if (hf[c] >= hf[i]) break
        swap(c, i)
        i = c
      }
    }
    return top
  }
  const gx = goal % GW
  const gy = Math.floor(goal / GW)
  const hEst = (k: number) => Math.hypot((k % GW) - gx, Math.floor(k / GW) - gy) * gc
  gScore[start] = 0
  push(start, hEst(start))
  const DX = [1, -1, 0, 0, 1, 1, -1, -1, 2, 2, -2, -2, 1, 1, -1, -1]
  const DY = [0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 2, -2, 2, -2]
  const closed = new Uint8Array(N)
  while (hf.length) {
    const k = pop()
    if (k === goal) break
    if (closed[k]) continue
    closed[k] = 1
    const x = k % GW
    const y = Math.floor(k / GW)
    const hp = height(k)
    for (let d = 0; d < DX.length; d++) {
      const nx = x + DX[d]
      const ny = y + DY[d]
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue
      const nk = ny * GW + nx
      if (closed[nk]) continue
      const sf = surface(nk)
      if (nk !== goal && sf === 1) continue
      const L = Math.hypot(DX[d], DY[d]) * gc
      const dh = Math.abs(height(nk) - hp) / L
      let c = L * (1 + opts.slope * dh * dh * 40)
      // 海一定也是水（水距 < 0），终点落在海里时照旧算过水
      if (sf !== 0) c += L * opts.water
      if (biasAt) {
        let b = biasAt[nk]
        if (b !== b) b = biasAt[nk] = opts.bias!([nx * gc, ny * gc])
        c *= b
      }
      const ng = gScore[k] + c
      if (ng < gScore[nk]) {
        gScore[nk] = ng
        prev[nk] = k
        push(nk, ng + hEst(nk))
      }
    }
  }
  if (goal !== start && prev[goal] < 0) return []
  const path: P[] = []
  for (let k = goal; k >= 0; k = prev[k]) {
    path.push([(k % GW) * gc, Math.floor(k / GW) * gc])
    if (k === start) break
  }
  path.reverse()
  if (path.length) {
    path[0] = from
    path[path.length - 1] = to
  }
  return path
}

/**
 * 把一块地铲平（宫城这类大工程）：多边形里的地面压到里面的平均高程，外围 margin 米内平滑过渡回原来的地形。
 * 水（河、海）不动，岸边的地也只在平台一侧削、填。
 */
export function levelTerrain(T: TerrainResult, poly: P[], margin: number) {
  const { W, H, cell, height, water } = T.terrain
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const i0 = Math.max(0, Math.floor((x0 - margin) / cell))
  const i1 = Math.min(W - 1, Math.ceil((x1 + margin) / cell))
  const j0 = Math.max(0, Math.floor((y0 - margin) / cell))
  const j1 = Math.min(H - 1, Math.ceil((y1 + margin) / cell))
  const closed = [...poly, poly[0]]
  let sum = 0
  let n = 0
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const q: P = [i * cell, j * cell]
      if (water[j * W + i] > 0 && pointInPoly(q, poly)) {
        sum += height[j * W + i]
        n++
      }
    }
  if (!n) return
  const target = sum / n
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = j * W + i
      if (water[k] <= 0) continue
      const q: P = [i * cell, j * cell]
      const d = pointInPoly(q, poly) ? 0 : polylineDist(q, closed)
      if (d >= margin) continue
      const t = sm(0, margin, d)
      height[k] = Math.max(0.2, target * (1 - t) + height[k] * t)
    }
}

/** 折线上是否有点落在海里（按 step 米重采样检查） */
export function touchesSea(T: TerrainResult, line: P[], step = 3) {
  if (line.length < 2) return false
  for (const q of resample(line, step)) if (T.seaAt(q)) return true
  return false
}

/** 把折线在海里的部分去掉，返回留在陆上的各段 */
export function landPieces(T: TerrainResult, line: P[], step = 3): P[][] {
  const out: P[][] = []
  let cur: P[] = []
  for (const q of resample(line, step)) {
    if (T.seaAt(q)) {
      if (cur.length > 1) out.push(cur)
      cur = []
    } else cur.push(q)
  }
  if (cur.length > 1) out.push(cur)
  return out
}

/** 折线离最近点的距离 */
export function nearestOn(line: P[], q: P) {
  let best = Infinity
  let at = 0
  for (let i = 0; i < line.length; i++) {
    const d = dist(line[i], q)
    if (d < best) {
      best = d
      at = i
    }
  }
  return { d: best, i: at }
}
