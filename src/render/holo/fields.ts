import type { World } from '../../gen/types'
import { blur } from '../../gen/util'
import { contours, ringArea, simplify, type Ring } from '../atlas/svg/contour'

/**
 * 全息沙盘要用的栅格与矢量：
 * - ground：海拔，湖泊压成浅坑（湖面与海面一样是"水"）
 * - near：每格所属的陆块（四邻连通的陆地，含内陆湖）；海上的格子取最近的陆块（只往外扩几格），
 *   让海岸两侧的高亮连续
 * - masses：各陆块的面积、形心与最高点
 * - landBlur：模糊过的陆地掩膜，海岸处约 0.5，着色器据此画海岸内外的辉光
 * - coast：平滑后的海岸线（格坐标）
 */
export interface HoloFields {
  W: number
  H: number
  ground: Float32Array
  near: Int32Array
  masses: Landmass[]
  landBlur: Float32Array
  coast: Ring[]
  /** 侧视轮廓：每行、每列的最高海拔（km，海面为 0），以及全图最高点 */
  rowMax: Float32Array
  colMax: Float32Array
  peak: number
}

export interface Landmass {
  cells: number
  /** 形心（格） */
  x: number
  y: number
  /** 最高点海拔（km）与位置 */
  peak: number
  peakX: number
  peakY: number
}

const LAKE_DEPTH = -0.05
/** 海上沿用陆块编号的最远距离（格） */
const NEAR_REACH = 10

export function holoFields(world: World): HoloFields {
  const { W, H, elevation, water } = world
  const N = W * H
  const ground = new Float32Array(N)
  const rowMax = new Float32Array(H)
  const colMax = new Float32Array(W)
  let peak = 0
  for (let y = 0, i = 0; y < H; y++)
    for (let x = 0; x < W; x++, i++) {
      const e = elevation[i]
      ground[i] = e > 0 && !Number.isNaN(water[i]) ? LAKE_DEPTH : e
      if (e > rowMax[y]) rowMax[y] = e
      if (e > colMax[x]) colMax[x] = e
      if (e > peak) peak = e
    }

  // 陆块：海拔为正（含湖面）的四邻连通区域
  const near = new Int32Array(N).fill(-1)
  const masses: Landmass[] = []
  // 栈与队列共用一块类型化数组（每格至多入队一次）
  const queue = new Int32Array(N)
  for (let s = 0; s < N; s++) {
    if (elevation[s] <= 0 || near[s] >= 0) continue
    const id = masses.length
    const m: Landmass = { cells: 0, x: 0, y: 0, peak: -Infinity, peakX: 0, peakY: 0 }
    near[s] = id
    let top = 0
    queue[top++] = s
    while (top) {
      const i = queue[--top]
      const x = i % W
      const y = (i - x) / W
      m.cells++
      m.x += x
      m.y += y
      if (elevation[i] > m.peak) (m.peak = elevation[i]), (m.peakX = x), (m.peakY = y)
      if (x > 0 && elevation[i - 1] > 0 && near[i - 1] < 0) (near[i - 1] = id), (queue[top++] = i - 1)
      if (x < W - 1 && elevation[i + 1] > 0 && near[i + 1] < 0) (near[i + 1] = id), (queue[top++] = i + 1)
      if (y > 0 && elevation[i - W] > 0 && near[i - W] < 0) (near[i - W] = id), (queue[top++] = i - W)
      if (y < H - 1 && elevation[i + W] > 0 && near[i + W] < 0) (near[i + W] = id), (queue[top++] = i + W)
    }
    m.x /= m.cells
    m.y /= m.cells
    masses.push(m)
  }

  // 海上取最近的陆块：多源广度优先，限定步数。起点只取海岸格（内陆格的邻居都已有编号）
  let head = 0
  let tail = 0
  for (let i = 0; i < N; i++) {
    if (near[i] < 0) continue
    const x = i % W
    if ((x > 0 && near[i - 1] < 0) || (x < W - 1 && near[i + 1] < 0) || (i >= W && near[i - W] < 0) || (i < N - W && near[i + W] < 0)) queue[tail++] = i
  }
  for (let step = 0; step < NEAR_REACH && head < tail; step++) {
    const end = tail
    for (; head < end; head++) {
      const i = queue[head]
      const x = i % W
      const r = near[i]
      if (x > 0 && near[i - 1] < 0) (near[i - 1] = r), (queue[tail++] = i - 1)
      if (x < W - 1 && near[i + 1] < 0) (near[i + 1] = r), (queue[tail++] = i + 1)
      if (i >= W && near[i - W] < 0) (near[i - W] = r), (queue[tail++] = i - W)
      if (i < N - W && near[i + W] < 0) (near[i + W] = r), (queue[tail++] = i + W)
    }
  }

  // 陆地掩膜做两遍可分离的方框模糊（近似高斯）
  const landBlur = new Float32Array(N)
  for (let i = 0; i < N; i++) landBlur[i] = ground[i] > 0 ? 1 : 0
  blur(landBlur, W, H, 2, 2)

  const minArea = Math.max(2, (W * H) / 120000)
  const coast = contours(ground, W, H, 0, true)
    .filter((r) => ringArea(r) >= minArea)
    .map((r) => chaikin(simplify(r, 0.35), 2))

  return { W, H, ground, near, masses, landBlur, coast, rowMax, colMax, peak }
}

/** Chaikin 割角（闭合环）：每轮把每条边换成 1/4、3/4 处的两点 */
function chaikin(r: Ring, iter: number): Ring {
  let p = r
  for (let it = 0; it < iter; it++) {
    const n = p.length / 2
    if (n < 3) return p
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ax = p[i * 2], ay = p[i * 2 + 1]
      const bx = p[j * 2], by = p[j * 2 + 1]
      out.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25, ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75)
    }
    p = Float32Array.from(out)
  }
  return p
}
