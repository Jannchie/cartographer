import { contours, type Ring } from '../render/atlas/svg/contour'

/**
 * 编辑视图的专题底图：配色带、等值线、大洲区域划分。
 * 颜色带是 [值, r, g, b] 的有序表，线性插值。
 */
export type Ramp = [number, number, number, number][]

export const ELEV_RAMP: Ramp = [
  [-5, 8, 28, 58],
  [-3, 16, 50, 90],
  [-1, 34, 88, 130],
  [-0.2, 70, 130, 170],
  [0, 110, 165, 195],
  [0.001, 92, 140, 82],
  [0.25, 132, 166, 94],
  [0.6, 196, 190, 116],
  [1.2, 206, 160, 96],
  [2, 170, 118, 78],
  [3, 142, 110, 96],
  [4, 214, 208, 200],
  [5.5, 250, 250, 252],
]

export const TEMP_RAMP: Ramp = [
  [-35, 70, 40, 120],
  [-20, 60, 90, 190],
  [-8, 110, 170, 230],
  [0, 215, 235, 245],
  [8, 180, 220, 150],
  [15, 245, 225, 110],
  [22, 245, 160, 70],
  [30, 205, 60, 45],
  [38, 130, 20, 40],
]

export const RAIN_RAMP: Ramp = [
  [0, 140, 95, 55],
  [150, 205, 165, 100],
  [400, 225, 215, 140],
  [800, 170, 205, 120],
  [1300, 95, 170, 105],
  [2000, 45, 135, 120],
  [3000, 35, 90, 150],
  [4500, 45, 50, 130],
]

export function rampColor(r: Ramp, v: number, out: number[]) {
  if (v <= r[0][0]) {
    out[0] = r[0][1]
    out[1] = r[0][2]
    out[2] = r[0][3]
    return
  }
  for (let i = 1; i < r.length; i++) {
    if (v <= r[i][0]) {
      const a = r[i - 1]
      const b = r[i]
      const t = (v - a[0]) / (b[0] - a[0])
      out[0] = a[1] + (b[1] - a[1]) * t
      out[1] = a[2] + (b[2] - a[2]) * t
      out[2] = a[3] + (b[3] - a[3]) * t
      return
    }
  }
  const l = r[r.length - 1]
  out[0] = l[1]
  out[1] = l[2]
  out[2] = l[3]
}

/** 等值线组：同一样式的一批线，画成一个 Path2D（格坐标） */
export interface IsoGroup {
  path: Path2D
  color: string
  width: number
}

/**
 * 等值线：在降采样（每 step 格取一点）的场上追踪，坐标换回格坐标。
 * levels: [值, 颜色, 线宽(px)]
 */
export function isolines(field: Float32Array, W: number, H: number, levels: [number, string, number][], step = 2): IsoGroup[] {
  const w = Math.ceil(W / step)
  const h = Math.ceil(H / step)
  const f = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = field[Math.min(H - 1, y * step) * W + Math.min(W - 1, x * step)]
  const groups = new Map<string, IsoGroup>()
  for (const [lv, color, width] of levels) {
    const key = color + width
    let g = groups.get(key)
    if (!g) {
      g = { path: new Path2D(), color, width }
      groups.set(key, g)
    }
    const rings: Ring[] = contours(f, w, h, lv, false)
    for (const r of rings) {
      if (r.length < 6) continue
      g.path.moveTo(r[0] * step, r[1] * step)
      for (let i = 2; i < r.length; i += 2) g.path.lineTo(r[i] * step, r[i + 1] * step)
    }
  }
  return [...groups.values()]
}

/** 大洲配色（半透明叠在地貌上） */
export const REGION_COLORS = [
  [230, 120, 90],
  [90, 160, 230],
  [120, 200, 110],
  [230, 190, 80],
  [180, 120, 220],
  [80, 200, 190],
  [230, 110, 170],
  [160, 170, 90],
]

/** 从一个格出发泛洪出连通陆地（8 邻接）；只收 regions 为 -1 或 allowFrom 的格 */
export function floodLand(land: Uint8Array, regions: Int16Array, W: number, H: number, start: number, allowFrom = -1): number[] {
  if (!land[start]) return []
  const out: number[] = []
  const seen = new Uint8Array(W * H)
  const stack = [start]
  seen[start] = 1
  while (stack.length) {
    const i = stack.pop()!
    if (regions[i] !== -1 && regions[i] !== allowFrom) continue
    out.push(i)
    const x = i % W
    const y = (i - x) / W
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const j = yy * W + xx
        if (seen[j] || !land[j]) continue
        seen[j] = 1
        stack.push(j)
      }
    }
  }
  return out
}

/**
 * 自动划分大洲：陆地按"离海岸的距离"腐蚀，窄于 neck 格的地峡被切断，剩下的核心各自成洲；
 * 再从核心沿陆地向外生长（测地距离），把整片陆地分给最近的核心。
 * 太小的核心与够不着核心的小岛不算大洲（留给岛屿标注）。
 */
export function autoContinents(land: Uint8Array, coastDist: Float32Array, W: number, H: number, neck: number, minArea: number): Int16Array {
  const N = W * H
  const core = new Int16Array(N).fill(-1)
  let n = 0
  const sizes: number[] = []
  // 核心的连通分量
  for (let i = 0; i < N; i++) {
    if (!land[i] || core[i] !== -1 || coastDist[i] <= neck) continue
    const stack = [i]
    core[i] = n
    let cnt = 0
    while (stack.length) {
      const c = stack.pop()!
      cnt++
      const x = c % W
      const y = (c - x) / W
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const j = yy * W + xx
        if (core[j] !== -1 || !land[j] || coastDist[j] <= neck) continue
        core[j] = n
        stack.push(j)
      }
    }
    sizes.push(cnt)
    n++
  }
  // 太小的核心并不算（稍后由生长接管或留空）
  const keep = sizes.map((s) => s * 6 >= minArea)
  const remap = new Int16Array(n).fill(-1)
  let m = 0
  for (let k = 0; k < n; k++) if (keep[k]) remap[k] = m++
  const out = new Int16Array(N).fill(-1)
  const q: number[] = []
  for (let i = 0; i < N; i++) {
    if (core[i] >= 0 && remap[core[i]] >= 0) {
      out[i] = remap[core[i]]
      q.push(i)
    }
  }
  // 沿陆地的多源 BFS
  for (let h = 0; h < q.length; h++) {
    const c = q[h]
    const x = c % W
    const y = (c - x) / W
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const j = yy * W + xx
        if (out[j] !== -1 || !land[j]) continue
        out[j] = out[c]
        q.push(j)
      }
    }
  }
  // 面积不够的区域去掉
  const area = new Int32Array(m)
  for (let i = 0; i < N; i++) if (out[i] >= 0) area[out[i]]++
  for (let i = 0; i < N; i++) if (out[i] >= 0 && area[out[i]] < minArea) out[i] = -1
  // 重新编号成 0..k-1
  const ids = new Int16Array(m).fill(-1)
  let k = 0
  for (let r = 0; r < m; r++) if (area[r] >= minArea) ids[r] = k++
  for (let i = 0; i < N; i++) if (out[i] >= 0) out[i] = ids[out[i]]
  return out
}

/** 区域的"最宽处"（到区域边界最远的格）与横向跨度：放大洲名 */
export function regionAnchor(regions: Int16Array, W: number, H: number, id: number) {
  const N = W * H
  const d = new Float32Array(N)
  const q: number[] = []
  let x0 = W
  let x1 = 0
  let cnt = 0
  for (let i = 0; i < N; i++) {
    if (regions[i] !== id) continue
    cnt++
    const x = i % W
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    const y = (i - x) / W
    // 边界格：邻格不属于该区域
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || regions[i - 1] !== id || regions[i + 1] !== id || regions[i - W] !== id || regions[i + W] !== id
    if (edge) {
      d[i] = 1
      q.push(i)
    }
  }
  if (!cnt) return null
  let best = q[0]
  for (let h = 0; h < q.length; h++) {
    const c = q[h]
    if (d[c] > d[best]) best = c
    const x = c % W
    for (const j of [c - 1, c + 1, c - W, c + W]) {
      if (j < 0 || j >= N || (j === c - 1 && x === 0) || (j === c + 1 && x === W - 1)) continue
      if (regions[j] !== id || d[j] !== 0) continue
      d[j] = d[c] + 1
      q.push(j)
    }
  }
  return { x: best % W, y: Math.floor(best / W), span: (x1 - x0) * 0.6, area: cnt }
}
