/**
 * 【实验】符号套原型的地物结构分析：把格点场整理成画法要用的结构，与画法无关。
 * - 山：山峰（与现有画法同一套选点）连成山链（主脊、支脉），按山系里的山峰数分孤峰、短脊（2~8 峰）、大山脉；
 * - 丘陵：成簇的矮丘，记下是否贴着山脉（山麓）；
 * - 森林：树位（与现有画法同一套选点），各带所在林地的大小、到林缘的距离、是否在南缘；林地的轮廓环；
 * - 散树：稀树草原、灌丛、林缘外的零星树、小得不成林的树丛，每处 1~5 棵。
 * 全部按位置派生随机数，同一个世界结果不变。
 */
import { Biome } from '../../../gen/types'
import { blur, sampleField } from '../../../gen/util'
import { riverThreshold } from '../../../gen/world'
import { fnoise, hash } from '../fields'
import { contours, ringArea, simplify } from '../../../gen/contour'
import { chaikin, type P } from './brush'

/** 分析要读的格点场（Fields.world 的一个子集；比较图用的合成场景也按它造） */
export interface TerrainInput {
  W: number
  H: number
  /** 每格的像素数 */
  S: number
  /** 海拔 km */
  elevation: ArrayLike<number>
  biome: ArrayLike<number>
  /** 汇流量 */
  flow: ArrayLike<number>
}

export interface Peak {
  x: number
  y: number
  /** 符号的基准尺寸（像素）：现有画法里山体半宽约 0.7~1.1 s，高约 1~1.7 s */
  s: number
  /** 海拔的相对高低 0~1 */
  t: number
  /** 山势 0~1（见 mountainness）：丘陵与山共用的连续形态参数 */
  m: number
  seed: number
  /** 所在山链 */
  chain: number
  /** 所在山系（连通的一组山链）的山峰数 */
  group: number
  /** 在主脊上（否则是支脉） */
  main: boolean
  /** 山链的端点 */
  end: boolean
}

export interface Chain {
  id: number
  /** 沿脊线依次排列 */
  nodes: Peak[]
  /** 山系的主脊 */
  main: boolean
  /** 孤峰（山系只有 1 峰）、短脊（2~8 峰）、大山脉（9 峰以上） */
  kind: 'solo' | 'ridge' | 'range'
  /** 山系的山峰数 */
  group: number
  /** 山系的序号（同一山系的主脊与各支脉相同） */
  system: number
  /** 圆顺的脊线（像素）；支脉从接入主脊的那座山峰起 */
  line: P[]
}

export interface Hill {
  x: number
  y: number
  s: number
  /** 起伏的强弱 0~1 */
  t: number
  /** 山势 0~1（见 mountainness）：所在处的真实值，山麓的矮山可到 0.3 上下 */
  m: number
  seed: number
  /** 第一轮成簇时的簇内次序；第三轮起丘陵按丘群噪声成组，恒为 0（保留给第一轮的画法） */
  rank: number
  /** 贴着山脉（山麓的低山） */
  foot: boolean
}

export type TreeKind = 'leaf' | 'pine' | 'jungle' | 'acacia' | 'bush'

export interface ForestSpot {
  x: number
  y: number
  s: number
  kind: TreeKind
  seed: number
  /** 到林缘的距离（格）：1 为最外一圈 */
  depth: number
  /** 所在林地的面积（格） */
  size: number
  /** 在林地的南缘（面向看图的人，树干露出来）/ 北缘 */
  front: boolean
  back: boolean
}

export interface TreeSpot {
  x: number
  y: number
  s: number
  kind: TreeKind
  seed: number
  /** 这一处的棵数 1~5 */
  n: number
}

export interface ForestRing {
  pts: P[]
  /** 面积（像素²） */
  area: number
}

export interface Terrain {
  input: TerrainInput
  /** 线宽、尺寸的倍率（S/2） */
  k: number
  peaks: Peak[]
  chains: Chain[]
  hills: Hill[]
  spots: ForestSpot[]
  trees: TreeSpot[]
  /** 林地（去掉山体占位与河道之后）的轮廓环，含林间空地的内环 */
  rings: ForestRing[]
  /** 像素处的林地覆盖 0~1（羽化过，0.5 为林缘） */
  forestAt(x: number, y: number): number
  /** 像素处到林缘的距离（格）；林外为 0 */
  depthAt(x: number, y: number): number
  /** 像素处的树种；不是林地时为 null */
  kindAt(x: number, y: number): TreeKind | null
  /** 像素处的海拔 km（双线性） */
  elevAt(x: number, y: number): number
}

/**
 * 山势：由海拔（km）与 5×5 邻域的起伏（km）连续决定的形态参数，0 是平地上刚看得出的缓丘，1 是最高的山峰。
 * 丘陵与山峰的选点规则不同，但都用这一个量定大小与形态，于是"大丘陵"与"小山"落在相邻的取值上，没有断档。
 * 海拔、起伏都取选点及其紧邻一圈（3×3）里的最大值：丘陵的选点常落在坡上而不在顶上；圈再大，山脚的丘陵会沾上旁边高峰的海拔。
 */
export function mountainness(e: number, relief: number) {
  const a = Math.min(1, Math.max(0, (relief - 0.26) / 1.2))
  const b = Math.min(1, Math.max(0, (e - 0.25) / 4.0))
  return Math.min(1, 0.22 * a + 0.78 * b)
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 山势 m 的丘或矮山占地的半径（k=1 时的像素）：与 gradual.ts 的 form(m) 的半宽相当 */
export const hillSize = (m: number) => 6.8 + 18 * m ** 1.35

/** 空间哈希：最小间距检查（与 glyphs.ts 里的相同） */
class Occupancy {
  private cells = new Map<number, [number, number, number][]>()
  constructor(private size: number) {}
  free(x: number, y: number, r: number) {
    const cx = Math.floor(x / this.size)
    const cy = Math.floor(y / this.size)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const list = this.cells.get((cx + dx) * 65536 + cy + dy)
        if (!list) continue
        for (const [px, py, pr] of list) if (Math.hypot(px - x, py - y) < Math.max(r, pr)) return false
      }
    }
    return true
  }
  add(x: number, y: number, r: number) {
    const k = Math.floor(x / this.size) * 65536 + Math.floor(y / this.size)
    const l = this.cells.get(k)
    if (l) l.push([x, y, r])
    else this.cells.set(k, [[x, y, r]])
  }
}

const FOREST_KIND = (b: number, x: number, y: number): TreeKind | null => {
  if (b === Biome.Taiga) return 'pine'
  if (b === Biome.TemperateRainforest) return hash(x, y * 3) > 0.45 ? 'pine' : 'leaf'
  if (b === Biome.TemperateForest) return hash(x * 5, y) > 0.85 ? 'pine' : 'leaf'
  if (b === Biome.TropicalSeasonalForest) return 'leaf'
  if (b === Biome.TropicalRainforest) return 'jungle'
  return null
}
/** 一格所属的林型（不掺杂个别异种树）：轮廓、纹理按它取 */
const FOREST_TYPE = (b: number): TreeKind | null =>
  b === Biome.Taiga ? 'pine' : b === Biome.TropicalRainforest ? 'jungle' : b === Biome.TemperateForest || b === Biome.TemperateRainforest || b === Biome.TropicalSeasonalForest ? 'leaf' : null

/** 林缘之外可以长零星树的群系 */
const OPEN = new Set<number>([Biome.Grassland, Biome.Shrubland, Biome.Savanna, Biome.Tundra])

export function analyzeTerrain(input: TerrainInput): Terrain {
  const { W, H, S, elevation: e, biome: bio, flow } = input
  const k = S / 2
  const N = W * H
  const occ = new Occupancy(14 * k)
  const thr = riverThreshold(W)

  const cell = (x: number, y: number) => {
    const gx = Math.round(x / S)
    const gy = Math.round(y / S)
    if (gx < 1 || gy < 1 || gx >= W - 1 || gy >= H - 1) return -1
    return gy * W + gx
  }
  const landAt = (x: number, y: number) => {
    const i = cell(x, y)
    return i >= 0 && e[i] > 0.01 && bio[i] !== Biome.Lake
  }
  const wet = (i: number) => flow[i] > thr * 0.5
  const wetNear = (x: number, y: number, hw: number) => {
    for (const [dx, dy] of [[0, 0], [-hw, 0], [hw, 0], [-hw * 0.5, -hw * 0.4], [hw * 0.5, -hw * 0.4], [0, -hw * 0.6]]) {
      const i = cell(x + dx, y + dy)
      if (i >= 0 && flow[i] > thr * 1.5) return true
    }
    return false
  }

  // 起伏度：5×5 邻域的高差
  const relief = new Float32Array(N)
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      let lo = Infinity
      let hi = -Infinity
      for (let dy = -2; dy <= 2; dy += 2) {
        for (let dx = -2; dx <= 2; dx += 2) {
          const v = e[(y + dy) * W + x + dx]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      relief[y * W + x] = hi - lo
    }
  }

  /** 格 i 处的山势：海拔、起伏取 3×3 邻域的最大值 */
  const mAt = (i: number) => {
    const cx = i % W
    const cy = Math.floor(i / W)
    let em = 0
    let rm = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const j = y * W + x
        if (e[j] > em) em = e[j]
        if (relief[j] > rm) rm = relief[j]
      }
    }
    return mountainness(em, rm)
  }
  /**
   * 山峰的山势：峰顶的山势与"山体"（7×7 邻域的平均海拔）的山势各半。
   * 山脉末梢、孤立的尖峰底下的山体单薄，山势随之降下来，于是山脉从主峰到末梢是渐低的，而不是一律按峰顶的海拔画成大山
   */
  const peakM = (i: number) => {
    const cx = i % W
    const cy = Math.floor(i / W)
    let sum = 0
    let n = 0
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        sum += Math.max(0, e[y * W + x])
        n++
      }
    }
    return 0.5 * mAt(i) + 0.5 * mountainness(sum / n, relief[i])
  }

  // 山体、丘陵占住的格：林地的轮廓与树位都让开
  const blocked = new Uint8Array(N)
  const block = (x: number, y: number, r: number) => {
    const x0 = Math.max(0, Math.floor((x - r) / S))
    const x1 = Math.min(W - 1, Math.ceil((x + r) / S))
    const y0 = Math.max(0, Math.floor((y - r) / S))
    const y1 = Math.min(H - 1, Math.ceil((y + r) / S))
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) if (Math.hypot((gx + 0.5) * S - x, (gy + 0.5) * S - y) < r) blocked[gy * W + gx] = 1
  }

  // —— 山峰：从高到低，泊松盘采样 ——
  const peaks: Peak[] = []
  const peakE: number[] = []
  const cand: number[] = []
  for (let i = 0; i < N; i++) if (e[i] > 1.25 && relief[i] > 0.7) cand.push(i)
  cand.sort((a, b) => e[b] - e[a] || a - b)
  for (const i of cand) {
    const x = ((i % W) + 0.5 + (hash(i, 5) - 0.5) * 0.8) * S
    const y = (Math.floor(i / W) + 0.5 + (hash(i, 6) - 0.5) * 0.8) * S
    const t = Math.min(1, (e[i] - 1.25) / 3.4)
    const s = (8.5 + 17.5 * t) * k
    if (!occ.free(x, y, s * 0.85)) continue
    if (!landAt(x - s * 0.8, y) || !landAt(x + s * 0.8, y)) continue
    if (wetNear(x, y, s * 0.7)) continue
    occ.add(x, y, s * 0.72)
    block(x, y, s * 0.72)
    peaks.push({ x, y, s, t, m: peakM(i), seed: i, chain: -1, group: 1, main: true, end: true })
    peakE.push(e[i])
  }
  const chains = linkChains(peaks, peakE, input, thr)

  // —— 丘与矮山：山势取所在处的真实值（不再按簇内次序压低），从高到低排，先占住山麓的矮山，再往外放丘陵 ——
  // 疏密：丘陵按一张低频的"丘群"噪声成组，组与组之间留空；山势越高越不受它限制，于是山脉边缘的矮山连成一圈，
  // 平地上的缓丘只剩零星几组。林地里的丘陵（山势低）不放：林子里画了也看不见，还会把林子挖出洞来
  const hills: Hill[] = []
  const nearPeak = (x: number, y: number) => {
    for (const p of peaks) if (Math.abs(p.x - x) < p.s * 2.4 && Math.abs(p.y - y) < p.s * 2.4 && Math.hypot(p.x - x, p.y - y) < p.s * 2.4) return true
    return false
  }
  /** 到最近山峰的距离（以那座山峰的尺寸为单位） */
  const peakDist = (x: number, y: number) => {
    let best = Infinity
    for (const p of peaks) {
      const dx = Math.abs(p.x - x)
      if (dx > p.s * 4) continue
      const dy = Math.abs(p.y - y)
      if (dy > p.s * 4) continue
      best = Math.min(best, Math.hypot(dx, dy) / p.s)
    }
    return best
  }
  // 候选：起伏够大的格。丘与矮山的山势取所在处的真实值，但不超过起伏撑得起的程度——
  // 高原上起伏小的地方海拔虽高，看上去仍是平地上的缓丘，不该画成一片矮山
  const hc: [number, number][] = []
  for (let y = 2; y < H - 2; y += 2) {
    for (let x = 2; x < W - 2; x += 2) {
      const i = y * W + x
      if (e[i] < 0.25 || relief[i] < 0.26 || wet(i)) continue
      let rl = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) rl = Math.max(rl, relief[i + dy * W + dx])
      const m = Math.min(mAt(i), 0.03 + 0.4 * rl)
      if (FOREST_TYPE(bio[i]) && m < 0.2) continue
      hc.push([i, m])
    }
  }
  hc.sort((a, b) => b[1] - a[1] || a[0] - b[0])
  for (const [i, m] of hc) {
    const x = i % W
    const y = Math.floor(i / W)
    const px = (x + hash(x + 1, y) - 0.5) * S
    const py = (y + hash(x, y + 1) - 0.5) * S
    // 山麓带（离山峰两三个山体以内）：矮山连成一圈；带外：起伏大的地方按丘群噪声成组，组外留空
    const rl = relief[i]
    const band = 1 - smooth(1.3, 2.4, peakDist(px, py))
    const g = fnoise(px, py, 46 * k) + 0.2 * smooth(0.4, 1, rl)
    const want = Math.max(band * smooth(0.36, 0.56, g), smooth(0.3, 0.75, rl) * smooth(0.52, 0.66, g))
    if (hash(x * 7, y * 3) > want) continue
    const s = hillSize(m) * k
    if (!occ.free(px, py, s * 1.05)) continue
    if (!landAt(px - s * 0.9, py) || !landAt(px + s * 0.9, py) || wetNear(px, py, s * 0.8)) continue
    occ.add(px, py, s * 0.9)
    block(px, py, s * 0.8)
    hills.push({ x: px, y: py, s, t: Math.min(1, (relief[i] - 0.22) / 0.5), m, seed: i * 3 + 1, rank: 0, foot: nearPeak(px, py) })
  }

  // —— 林地：掩膜、连通块、到林缘的距离 ——
  const mask = new Uint8Array(N)
  for (let i = 0; i < N; i++) mask[i] = FOREST_TYPE(bio[i]) && e[i] > 0.01 && !blocked[i] && !wet(i) ? 1 : 0
  const comp = new Int32Array(N).fill(-1)
  const compSize: number[] = []
  const stack: number[] = []
  for (let i = 0; i < N; i++) {
    if (!mask[i] || comp[i] >= 0) continue
    const id = compSize.length
    let n = 0
    comp[i] = id
    stack.push(i)
    while (stack.length) {
      const c = stack.pop()!
      n++
      const x = c % W
      for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
        if (j < 0 || j >= N || !mask[j] || comp[j] >= 0) continue
        comp[j] = id
        stack.push(j)
      }
    }
    compSize.push(n)
  }
  // 太小的林块不成林：改成一处树丛（见下）
  const TINY = 12
  // 到林缘的距离：两遍倒角距离（1 / √2），林缘那一圈为 1
  const depth = new Float32Array(N)
  for (let i = 0; i < N; i++) depth[i] = mask[i] ? 1e6 : 0
  const D = Math.SQRT2
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (!mask[i]) continue
      depth[i] = Math.min(depth[i], depth[i - 1] + 1, depth[i - W] + 1, depth[i - W - 1] + D, depth[i - W + 1] + D)
    }
  }
  for (let y = H - 2; y > 0; y--) {
    for (let x = W - 2; x > 0; x--) {
      const i = y * W + x
      if (!mask[i]) continue
      depth[i] = Math.min(depth[i], depth[i + 1] + 1, depth[i + W] + 1, depth[i + W + 1] + D, depth[i + W - 1] + D)
    }
  }
  // 轮廓：掩膜（去掉小块）羽化后追 0.5 的等值线
  const soft = new Float32Array(N)
  for (let i = 0; i < N; i++) soft[i] = mask[i] && compSize[comp[i]] > TINY ? 1 : 0
  blur(soft, W, H, 1, 1)
  const rings: ForestRing[] = []
  for (const raw of contours(soft, W, H, 0.5, true)) {
    const area = ringArea(raw) * S * S
    if (area < 40 * k * k) continue
    const r = simplify(raw, 0.3)
    const pts: P[] = []
    for (let i = 0; i < r.length; i += 2) pts.push([(r[i] + 0.5) * S, (r[i + 1] + 0.5) * S])
    // 环首尾相接：去掉重复的末点
    if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.01) pts.pop()
    if (pts.length >= 3) rings.push({ pts, area })
  }

  // —— 树位：密排，与现有画法同一套选点 ——
  const spots: ForestSpot[] = []
  const trees: TreeSpot[] = []
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if ((x + y * 2) % 2) continue
      const i = y * W + x
      const kind = FOREST_KIND(bio[i], x, y)
      if (!kind || e[i] <= 0.01 || wet(i)) continue
      const px = (x + (hash(x, y) - 0.5) * 1.6) * S
      const py = (y + (hash(y, x) - 0.5) * 1.6) * S
      const s = (kind === 'jungle' ? 3.6 : 3.1 + hash(x * 3, y) * 0.7) * k
      if (!occ.free(px, py, s * 1.05)) continue
      const size = comp[i] >= 0 ? compSize[comp[i]] : 0
      // 小得不成林的块不逐棵排，下面合成一处树丛
      if (size <= TINY) continue
      occ.add(px, py, s * 0.95)
      const m = (dy: number) => {
        const yy = y + dy
        return yy >= 0 && yy < H && mask[yy * W + x] === 1
      }
      spots.push({ x: px, y: py, s, kind, seed: i, depth: Math.max(1, depth[i]), size, front: !m(2) || !m(3), back: !m(-2) || !m(-3) })
    }
  }
  // 小林块 → 树丛：放在块的重心
  {
    const sx = new Float64Array(compSize.length)
    const sy = new Float64Array(compSize.length)
    const first = new Int32Array(compSize.length).fill(-1)
    for (let i = 0; i < N; i++) {
      const c = comp[i]
      if (c < 0 || compSize[c] > TINY) continue
      sx[c] += i % W
      sy[c] += Math.floor(i / W)
      if (first[c] < 0) first[c] = i
    }
    for (let c = 0; c < compSize.length; c++) {
      const n = compSize[c]
      if (n > TINY || n < 2 || first[c] < 0) continue
      const i = first[c]
      const kind = FOREST_KIND(bio[i], i % W, Math.floor(i / W)) ?? 'leaf'
      const px = (sx[c] / n + 0.5) * S
      const py = (sy[c] / n + 0.5) * S
      const s = 3.6 * k
      if (!occ.free(px, py, s * 1.6)) continue
      occ.add(px, py, s * 2)
      trees.push({ x: px, y: py, s, kind, seed: i, n: Math.min(5, 2 + Math.floor(n / 3)) })
    }
  }
  // 林缘外的零星树：离林地越远越稀；树种随最近的林地
  {
    const near = new Uint8Array(N) // 到林地的步数（1~5），0 为不在林缘带
    const nk = new Uint8Array(N) // 林型：1 阔叶 2 针叶 3 雨林
    let front: number[] = []
    for (let i = 0; i < N; i++) {
      if (!mask[i] || compSize[comp[i]] <= TINY) continue
      const ty = FOREST_TYPE(bio[i])
      nk[i] = ty === 'pine' ? 2 : ty === 'jungle' ? 3 : 1
      front.push(i)
    }
    for (let d = 1; d <= 5 && front.length; d++) {
      const next: number[] = []
      for (const c of front) {
        const x = c % W
        for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
          if (j < 0 || j >= N || nk[j]) continue
          nk[j] = nk[c]
          near[j] = d
          next.push(j)
        }
      }
      front = next
    }
    const P_AT = [0, 0.5, 0.34, 0.22, 0.13, 0.07]
    for (let y = 2; y < H - 2; y += 2) {
      for (let x = 2 + (y % 4 ? 1 : 0); x < W - 2; x += 2) {
        const i = y * W + x
        const d = near[i]
        if (!d || mask[i] || !OPEN.has(bio[i]) || e[i] <= 0.01 || wet(i) || blocked[i]) continue
        if (hash(x * 11, y * 7) > P_AT[d]) continue
        const px = (x + (hash(x + 5, y) - 0.5) * 1.8) * S
        const py = (y + (hash(x, y + 5) - 0.5) * 1.8) * S
        const s = (3.2 + hash(x * 3, y * 3) * 0.8) * k
        const n = d <= 2 && hash(x * 13, y) > 0.55 ? 2 + Math.floor(hash(x, y * 13) * 2) : 1
        if (!occ.free(px, py, s * (n > 1 ? 2 : 1.5))) continue
        occ.add(px, py, s * (n > 1 ? 1.8 : 1.3))
        trees.push({ x: px, y: py, s, kind: nk[i] === 2 ? 'pine' : nk[i] === 3 ? 'jungle' : 'leaf', seed: i, n })
      }
    }
  }
  // 稀树草原上的金合欢、灌丛里的矮灌木、草原上偶尔的孤树
  for (let y = 2; y < H - 2; y += 3) {
    for (let x = 2; x < W - 2; x += 3) {
      const i = y * W + x
      const b = bio[i]
      const kind: TreeKind | null =
        b === Biome.Savanna && hash(x * 7, y) < 0.16 ? 'acacia' : b === Biome.Shrubland && hash(x, y * 7) < 0.3 ? 'bush' : b === Biome.Grassland && hash(x * 17, y * 3) < 0.035 ? 'leaf' : null
      if (!kind || e[i] <= 0.01 || wet(i) || blocked[i]) continue
      const px = (x + (hash(x + 3, y) - 0.5) * 2) * S
      const py = (y + (hash(x, y + 3) - 0.5) * 2) * S
      const s = (kind === 'acacia' ? 3.6 : kind === 'bush' ? 2.4 : 3.4) * k
      if (!occ.free(px, py, s * 1.6)) continue
      occ.add(px, py, s * 1.4)
      const n = kind === 'bush' ? 1 + Math.floor(hash(x * 3, y * 11) * 2.2) : kind === 'leaf' && hash(x * 5, y * 5) > 0.7 ? 3 : 1
      trees.push({ x: px, y: py, s, kind, seed: i, n })
    }
  }

  const at = (x: number, y: number) => {
    const gx = Math.min(W - 1, Math.max(0, Math.round(x / S - 0.5)))
    const gy = Math.min(H - 1, Math.max(0, Math.round(y / S - 0.5)))
    return gy * W + gx
  }
  return {
    input,
    k,
    peaks,
    chains,
    hills,
    spots,
    trees,
    rings,
    forestAt: (x, y) => sampleField(soft, W, H, x / S - 0.5, y / S - 0.5),
    depthAt: (x, y) => {
      const d = depth[at(x, y)]
      return d > 1e5 ? 0 : d
    },
    kindAt: (x, y) => {
      const i = at(x, y)
      return mask[i] ? FOREST_TYPE(bio[i]) : null
    },
    elevAt: (x, y) => sampleField(e, W, H, x / S - 0.5, y / S - 0.5),
  }
}

/**
 * 把山峰连成山链：相邻两峰之间取连线上的最低海拔作鞍部高度，鞍部够高（仍在山地里、不跨河）才连；
 * 按鞍部从高到低做最大生成森林（每峰至多连 3 条），树上最长的一条是主脊，其余逐级拆成支脉。
 */
function linkChains(peaks: Peak[], peakE: number[], input: TerrainInput, thr: number): Chain[] {
  const { W, H, S, elevation: e, flow } = input
  const n = peaks.length
  const size = 64 * (S / 2)
  const grid = new Map<number, number[]>()
  peaks.forEach((p, i) => {
    const key = Math.floor(p.x / size) * 65536 + Math.floor(p.y / size)
    const l = grid.get(key)
    if (l) l.push(i)
    else grid.set(key, [i])
  })
  const edges: [number, number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = peaks[i]
    const cx = Math.floor(a.x / size)
    const cy = Math.floor(a.y / size)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get((cx + dx) * 65536 + cy + dy) ?? []) {
          if (j <= i) continue
          const b = peaks[j]
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          if (d > 1.7 * Math.max(a.s, b.s)) continue
          // 连线上的最低海拔与河
          let lo = Infinity
          let river = false
          const steps = Math.max(2, Math.ceil(d / S))
          for (let q = 0; q <= steps; q++) {
            const gx = (a.x + ((b.x - a.x) * q) / steps) / S - 0.5
            const gy = (a.y + ((b.y - a.y) * q) / steps) / S - 0.5
            lo = Math.min(lo, sampleField(e, W, H, gx, gy))
            const ci = Math.round(gy) * W + Math.round(gx)
            if (flow[ci] > thr * 1.5) river = true
          }
          if (river || lo < 1.0 || lo < 0.6 * Math.min(peakE[i], peakE[j])) continue
          edges.push([i, j, lo - d / (400 * (S / 2))])
        }
      }
    }
  }
  edges.sort((a, b) => b[2] - a[2] || a[0] - b[0] || a[1] - b[1])
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const adj: number[][] = peaks.map(() => [])
  for (const [i, j] of edges) {
    if (adj[i].length >= 3 || adj[j].length >= 3) continue
    const a = find(i)
    const b = find(j)
    if (a === b) continue
    parent[a] = b
    adj[i].push(j)
    adj[j].push(i)
  }
  const groupSize = new Int32Array(n)
  for (let i = 0; i < n; i++) groupSize[find(i)]++

  const used = new Uint8Array(n)
  const chains: Chain[] = []
  /** 从 start 出发、不经过已用山峰的最远路径（按山峰尺寸累计） */
  const farthest = (start: number): number[] => {
    const prev = new Map<number, number>([[start, -1]])
    const dist = new Map<number, number>([[start, peaks[start].s]])
    const queue = [start]
    let best = start
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q]
      if (dist.get(c)! > dist.get(best)! || (dist.get(c)! === dist.get(best)! && c < best)) best = c
      for (const j of adj[c]) {
        if (used[j] || prev.has(j)) continue
        prev.set(j, c)
        dist.set(j, dist.get(c)! + peaks[j].s)
        queue.push(j)
      }
    }
    const path: number[] = []
    for (let c = best; c >= 0; c = prev.get(c)!) path.push(c)
    return path.reverse()
  }
  const emit = (path: number[], main: boolean, root: number) => {
    const id = chains.length
    const group = groupSize[find(path[0])]
    const nodes = path.map((i) => peaks[i])
    nodes.forEach((p, q) => {
      p.chain = id
      p.group = group
      p.main = main
      p.end = q === 0 || q === nodes.length - 1
    })
    for (const i of path) used[i] = 1
    const raw: P[] = nodes.map((p) => [p.x, p.y])
    if (root >= 0) raw.unshift([peaks[root].x, peaks[root].y])
    chains.push({ id, nodes, main, kind: group === 1 ? 'solo' : group < 9 ? 'ridge' : 'range', group, system: find(path[0]), line: raw.length > 2 ? chaikin(raw, 2) : raw })
    // 支脉：从这条链上各峰岔出去的最长一条，逐级拆
    for (const i of path) {
      for (const j of adj[i]) {
        if (used[j]) continue
        emit(farthest(j), false, i)
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (used[i]) continue
    // 山系的直径：从任一点找最远点，再从它找最远点
    const a = farthest(i)
    const b = farthest(a[a.length - 1])
    emit(b, true, -1)
  }
  return chains
}
