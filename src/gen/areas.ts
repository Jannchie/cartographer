import { Biome, type Label, type World } from './types'
import { Namer } from './naming'
import { RNG, hashString } from './rng'
import { contours, ringArea, simplify } from '../render/atlas/svg/contour'
import { blur, MinHeap, neighbors8 } from './util'
import * as dmath from './dmath'

/**
 * 世界地图上有名字的区域：大陆、岛屿、洋、海、湾、湖，以及山脉、盆地、沙漠、森林这些地形区。区域视图里显示成多边形，可以改名、拖顶点改边界；
 * 注记按区域排（位置、放大后挪进露出来的一角）。
 *
 * 自动推断（inferAreas）：
 * - 大陆、岛屿：注记所在的陆块；湖：注记所在的湖面
 * - 山脉、沙漠、森林：与生成注记时同一判据的连通块（高海拔平滑后超过阈值；沙漠类、雨林针叶林类群系），取注记所在的那块
 * - 盆地：生成时只有中心与半径，从中心往外填，高度到盆底与盆缘之间一半处为止（盆缘山脊挡住），不超出 1.4 倍半径
 * - 海：把海面按"离岸距离"做分水岭分割——开阔处高、海峡与湾口低，从各个高点往外长，两块在收窄处相遇时，
 *   若鞍点比较矮一块的峰低得多（收窄得厉害），就在那里分开：内海、海湾各成一块；图边附近相遇的不算收窄（海一直延伸到图外）
 * - 分出来的一块里有几个海名，就按沿水面走的距离把它分给这几个海名；一个海名都没有的、够大的一块另起名字（小的叫湾）
 *
 * 多边形是区域的外轮廓（格坐标，格 (x, y) 的中心在 (x, y)），岛屿、湖泊这些洞不单独编辑：
 * 用到区域范围时再与"是不是海 / 是不是陆地"求交（areaMember）。
 */
export type AreaKind = 'continent' | 'island' | 'ocean' | 'sea' | 'bay' | 'lake' | 'range' | 'basin' | 'desert' | 'forest'
export interface Area {
  /** 稳定的编号：按推断的先后，编辑后保持不变 */
  id: string
  kind: AreaKind
  name: string
  zh: string
  ja?: string
  /** 外轮廓（格坐标） */
  poly: [number, number][]
  /** 注记位置（格坐标）：来自原有注记的沿用它的位置，否则取区域里离边最远的一格 */
  at: [number, number]
  /** 由哪条原有注记推出来的（world.labels 的下标）：地图上按区域画它，不再按原注记画 */
  label?: number
  /** 区域的格数（推断时的大小，定字号用） */
  cells: number
}

/** 格坐标（可带小数、可越界）所在的格号 */
export const cellAt = (world: World, x: number, y: number) => Math.min(world.H - 1, Math.max(0, Math.round(y))) * world.W + Math.min(world.W - 1, Math.max(0, Math.round(x)))

/** 区域的"本体"：水域类的区域只算水面（海面或湖面），陆地类只算陆地——多边形内岛屿、湖泊这些洞不算 */
export function areaMember(world: World, kind: AreaKind): (i: number) => boolean {
  const e = world.elevation
  const w = world.water
  if (!isWaterArea(kind) && kind !== 'lake') return (i) => e[i] > 0
  if (kind === 'lake') return (i) => !Number.isNaN(w[i]) && w[i] !== 0
  return (i) => e[i] <= 0 && w[i] === 0
}

const WATER: AreaKind[] = ['ocean', 'sea', 'bay']
/** 地形区（山脉、盆地、沙漠、森林）：叠在大陆上，区域视图里另用虚线描 */
export const FEATURES: AreaKind[] = ['range', 'basin', 'desert', 'forest']
export const isFeatureArea = (k: AreaKind) => FEATURES.includes(k)

export function inferAreas(world: World): Area[] {
  const { W, H } = world
  const N = W * H
  const scale = W / 768
  const out: Area[] = []
  const labelAt = (l: Label) => cellAt(world, l.x, l.y)
  const labelIndex = new Map(world.labels.map((l, i) => [l, i]))

  // —— 大陆、岛屿、湖：注记所在的连通块 ——
  const isLand = areaMember(world, 'continent')
  const isLake = areaMember(world, 'lake')
  const taken = new Uint8Array(N)
  for (const l of world.labels) {
    const kind = l.kind === 'continent' || l.kind === 'island' ? l.kind : l.kind === 'lake' ? 'lake' : null
    if (!kind) continue
    const start = labelAt(l)
    const member = kind === 'lake' ? isLake : isLand
    if (!member(start) || taken[start]) continue
    const cells = flood(W, H, start, member)
    for (const c of cells) taken[c] = 1
    const poly = outline(W, H, cells)
    if (poly) out.push({ id: `${kind}:${out.length}`, kind, name: l.name, zh: l.zh, ja: l.ja, poly, at: [l.x, l.y], label: labelIndex.get(l), cells: cells.length })
  }

  // —— 海：分水岭分割 ——
  const isSea = areaMember(world, 'sea')
  const h = new Float32Array(N)
  const idx: number[] = []
  for (let i = 0; i < N; i++)
    if (isSea(i)) {
      h[i] = -world.coastDist[i]
      idx.push(i)
    }
  const order = sortDesc(h, idx)
  const parent = new Int32Array(N).fill(-1)
  const peak = new Float32Array(N)
  const size = new Int32Array(N)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const RATIO = 0.55
  const MIN_CELLS = 400 * scale * scale
  const MIN_PEAK = 6 * scale
  const EDGE = 12 * scale
  for (const i of order) {
    parent[i] = i
    peak[i] = h[i]
    size[i] = 1
    const x = i % W
    const y = (i - x) / W
    const edge = Math.min(x, y, W - 1 - x, H - 1 - y) < EDGE
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const j = ny * W + nx
        if (parent[j] < 0) continue
        const a = find(i)
        const b = find(j)
        if (a === b) continue
        const lo = Math.min(peak[a], peak[b])
        if (!edge && h[i] < lo * RATIO && Math.min(size[a], size[b]) > MIN_CELLS && lo > MIN_PEAK) continue
        const [big, small] = peak[a] > peak[b] || (peak[a] === peak[b] && a < b) ? [a, b] : [b, a]
        parent[small] = big
        size[big] += size[small]
      }
  }
  // 各块里的海名
  const seaLabels = world.labels.filter((l) => l.kind === 'ocean' || l.kind === 'sea')
  const basins = new Map<number, number[]>()
  for (const i of order) {
    const r = find(i)
    let list = basins.get(r)
    if (!list) basins.set(r, (list = []))
    list.push(i)
  }
  const namesIn = new Map<number, Label[]>()
  for (const l of seaLabels) {
    const c = labelAt(l)
    if (!isSea(c)) continue
    const r = find(c)
    let list = namesIn.get(r)
    if (!list) namesIn.set(r, (list = []))
    list.push(l)
  }
  // 另起的名字：按世界的命名风格，避开已有的地名
  const namer = new Namer(world.params, new RNG(hashString(`${world.params.seed}|areas`)), '|areas')
  const existing = new Set(world.labels.map((l) => l.zh))
  const fresh = (bay: boolean) => {
    for (let t = 0; t < 20; t++) {
      const n = bay ? namer.bay() : namer.name('sea')
      if (!existing.has(n.zh)) {
        existing.add(n.zh)
        return n
      }
    }
    return bay ? namer.bay() : namer.name('sea')
  }
  // 按块的大小依次处理（大的先起名）
  const roots = [...basins.keys()].sort((a, b) => basins.get(b)!.length - basins.get(a)!.length || a - b)
  for (const r of roots) {
    const cells = basins.get(r)!
    const names = namesIn.get(r) ?? []
    if (!names.length) {
      if (cells.length < MIN_CELLS) continue
      // 没有海名的一块：小的是湾，大的另起一个海名
      const bay = cells.length < MIN_CELLS * 6
      const n = fresh(bay)
      const poly = outline(W, H, cells)
      if (poly) out.push({ id: `${bay ? 'bay' : 'sea'}:${out.length}`, kind: bay ? 'bay' : 'sea', name: n.en, zh: n.zh, ja: n.ja, poly, at: pole(W, H, cells), cells: cells.length })
      continue
    }
    // 一块里有几个海名：按沿水面走的距离分给它们
    const parts = names.length === 1 ? [cells] : geodesicSplit(W, H, cells, names.map(labelAt))
    parts.forEach((part, k) => {
      const l = names[k]
      const poly = part.length ? outline(W, H, part) : null
      if (poly) out.push({ id: `${l.kind}:${out.length}`, kind: l.kind as AreaKind, name: l.name, zh: l.zh, ja: l.ja, poly, at: [l.x, l.y], label: labelIndex.get(l), cells: part.length })
    })
  }

  // —— 地形区：山脉、沙漠、森林取注记所在的连通块，盆地从中心往外填 ——
  const e = world.elevation
  for (const l of world.labels) {
    if (l.kind !== 'range' && l.kind !== 'basin' && l.kind !== 'desert' && l.kind !== 'forest') continue
    const start = labelAt(l)
    let member: (i: number) => boolean
    if (l.kind === 'range') {
      const h = highland(world)
      member = (i) => h[i] > RANGE_HI
    } else if (l.kind === 'desert') member = (i) => isDesertBiome(world.biome[i])
    else if (l.kind === 'forest') member = (i) => isForestBiome(world.biome[i])
    else member = basinMember(world, l)
    if (!member(start)) continue
    let cells = flood(W, H, start, member)
    if (l.kind === 'basin') {
      // 盆缘朝海的一侧被蚀穿时，填出来的是一条贴着海岸的低地：改取生成半径内的陆地
      const r = Math.max(4, l.span / 1.5)
      const coastal = cells.filter((c) => world.coastDist[c] < r * 0.15).length
      if (coastal > cells.length * 0.2) {
        const r2 = r * r
        cells = flood(W, H, start, (i) => {
          const x = i % W
          const y = (i - x) / W
          return e[i] > 0 && (x - l.x) * (x - l.x) + (y - l.y) * (y - l.y) < r2
        })
      }
    }
    const poly = outline(W, H, cells)
    if (poly) out.push({ id: `${l.kind}:${out.length}`, kind: l.kind, name: l.name, zh: l.zh, ja: l.ja, poly, at: [l.x, l.y], label: labelIndex.get(l), cells: cells.length })
  }
  return out
}

// —— 地形区的判据：生成注记（world.ts 的 makeLabels）与推断区域共用 ——
/** 山脉：陆地高度平滑后（highlandField）超过这个值的连通块 */
export const RANGE_HI = 1.35
/** 陆地高度（海面记 0）的平滑场 */
export function highlandField(elev: Float32Array, W: number, H: number) {
  const h = new Float32Array(elev.length)
  for (let i = 0; i < elev.length; i++) h[i] = elev[i] > 0 ? elev[i] : 0
  blur(h, W, H, 3, 2)
  return h
}
export const isDesertBiome = (b: number) => b === Biome.HotDesert || b === Biome.ColdDesert || b === Biome.SaltFlat
export const isForestBiome = (b: number) => b === Biome.TropicalRainforest || b === Biome.TemperateRainforest || b === Biome.Taiga

const highlands = new WeakMap<World, Float32Array>()
function highland(world: World) {
  let h = highlands.get(world)
  if (!h) highlands.set(world, (h = highlandField(world.elevation, world.W, world.H)))
  return h
}

/** 山脉注记所在的那片高地（格号）；注记不在高地上时为空 */
export function rangeCells(world: World, l: Label): number[] {
  const { W, H } = world
  const h = highland(world)
  const start = cellAt(world, l.x, l.y)
  return h[start] > RANGE_HI ? flood(W, H, start, (i) => h[i] > RANGE_HI) : []
}

/**
 * 盆地的范围：注记记着中心，半径由跨度反推（生成时 span = 1.5r）。盆底取中心附近的中位高度，盆缘取 1.1r 一圈的中位高度，
 * 低于两者之间一半的陆地算盆地（不低于盆底、中心各加一点）
 */
function basinMember(world: World, l: Label): (i: number) => boolean {
  const { W } = world
  const e = world.elevation
  const r = Math.max(4, l.span / 1.5)
  const at = (x: number, y: number) => cellAt(world, x, y)
  const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1]
  const floor: number[] = []
  const rim: number[] = []
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2
    const c = dmath.cos(a)
    const s = dmath.sin(a)
    floor.push(e[at(l.x + c * r * 0.25, l.y + s * r * 0.25)])
    rim.push(e[at(l.x + c * r * 1.1, l.y + s * r * 1.1)])
  }
  const f = median(floor)
  // 中心那格偶尔比盆底高一点（盆底有起伏）：阈值至少比它高一些，保证从中心填得出去
  const top = Math.max(f + 0.2, e[at(l.x, l.y)] + 0.15, (f + median(rim)) / 2)
  const R2 = r * r * 1.96
  return (i) => {
    const x = i % W
    const y = (i - x) / W
    return e[i] > 0 && e[i] < top && (x - l.x) * (x - l.x) + (y - l.y) * (y - l.y) < R2
  }
}

/** 8 邻接的连通块 */
function flood(W: number, H: number, start: number, member: (i: number) => boolean): number[] {
  const seen = new Uint8Array(W * H)
  const cells = [start]
  seen[start] = 1
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k]
    const x = c % W
    const y = (c - x) / W
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const j = ny * W + nx
        if (!seen[j] && member(j)) {
          seen[j] = 1
          cells.push(j)
        }
      }
  }
  return cells
}

/** 多源最短路（沿水面，8 邻接，斜走 √2）：每格归最近的种子 */
function geodesicSplit(W: number, H: number, cells: number[], seeds: number[]): number[][] {
  const N = W * H
  const inside = new Uint8Array(N)
  for (const c of cells) inside[c] = 1
  const dist = new Float64Array(N).fill(Infinity)
  const own = new Int32Array(N).fill(-1)
  const nb = neighbors8(W)
  const heap = new MinHeap(cells.length + seeds.length)
  seeds.forEach((s, k) => {
    if (!inside[s] || own[s] >= 0) return
    dist[s] = 0
    own[s] = k
    heap.push(0, s)
  })
  while (heap.size) {
    const c = heap.pop()
    const d0 = heap.lastKey
    if (d0 > dist[c]) continue
    const x = c % W
    const y = (c - x) / W
    for (let k = 0; k < 8; k++) {
      const nx = x + nb.dx[k]
      const ny = y + nb.dy[k]
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const j = c + nb.off[k]
      if (!inside[j]) continue
      const nd = d0 + nb.dist[k]
      if (nd < dist[j]) {
        dist[j] = nd
        own[j] = own[c]
        heap.push(nd, j)
      }
    }
  }
  const parts: number[][] = seeds.map(() => [])
  for (const c of cells) if (own[c] >= 0) parts[own[c]].push(c)
  return parts
}

/** 格子集合的外轮廓：取面积最大的一圈，化简到一两百个顶点以内，并夹回地图范围 */
function outline(W: number, H: number, cells: number[]): [number, number][] | null {
  if (!cells.length) return null
  let x0 = W
  let y0 = H
  let x1 = 0
  let y1 = 0
  for (const c of cells) {
    const x = c % W
    const y = (c - x) / W
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  // 在包围盒（外扩一格）里描轮廓，省得每块都扫整张图
  const ox = Math.max(0, x0 - 1)
  const oy = Math.max(0, y0 - 1)
  const bw = Math.min(W - 1, x1 + 1) - ox + 1
  const bh = Math.min(H - 1, y1 + 1) - oy + 1
  const field = new Float32Array(bw * bh)
  for (const c of cells) {
    const x = c % W
    const y = (c - x) / W
    field[(y - oy) * bw + (x - ox)] = 1
  }
  const rings = contours(field, bw, bh, 0.5, true)
  let best: Float32Array | null = null
  let bestA = 0
  for (const r of rings) {
    const a = ringArea(r)
    if (a > bestA) {
      bestA = a
      best = r
    }
  }
  if (!best) return null
  // 顶点控制在 160 个以内：容差从 1 格起，不够再放宽
  let tol = 1
  let r = simplify(best, tol)
  while (r.length / 2 > 160 && tol < 64) {
    tol *= 1.5
    r = simplify(best, tol)
  }
  const pts: [number, number][] = []
  for (let i = 0; i < r.length; i += 2) {
    const p: [number, number] = [Math.min(W - 0.5, Math.max(-0.5, r[i] + ox)), Math.min(H - 0.5, Math.max(-0.5, r[i + 1] + oy))]
    const q = pts[pts.length - 1]
    if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p)
  }
  // 首尾重复的点去掉（环自然闭合）
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop()
  return pts.length >= 3 ? pts : null
}

/** 区域里离边最远的一格（不可达极点的近似：多源 BFS 距离场的最大处） */
export function pole(W: number, H: number, cells: number[]): [number, number] {
  const inside = new Uint8Array(W * H)
  for (const c of cells) inside[c] = 1
  const d = new Int32Array(W * H).fill(-1)
  const q: number[] = []
  for (const c of cells) {
    const x = c % W
    const y = (c - x) / W
    const border = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !inside[c - 1] || !inside[c + 1] || !inside[c - W] || !inside[c + W]
    if (border) {
      d[c] = 0
      q.push(c)
    }
  }
  let best = cells[0]
  for (let k = 0; k < q.length; k++) {
    const c = q[k]
    if (d[c] > d[best]) best = c
    const x = c % W
    const visit = (j: number) => {
      if (inside[j] && d[j] < 0) {
        d[j] = d[c] + 1
        q.push(j)
      }
    }
    // 队列里的格都在内部（边上的格进队时就是 0 层），四邻不会越界；左右邻只在同一行里找
    if (x > 0) visit(c - 1)
    if (x < W - 1) visit(c + 1)
    if (c >= W) visit(c - W)
    if (c + W < W * H) visit(c + W)
  }
  return [best % W, Math.floor(best / W)]
}

export const isWaterArea = (k: AreaKind) => WATER.includes(k)

/** 点在多边形内（格坐标，奇偶规则） */
export function inPoly(poly: [number, number][], x: number, y: number) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 按 h 降序、同值按下标升序排列 idx（idx 已升序）：两趟 16 位 LSD 基数排序，与比较排序结果一致 */
function sortDesc(h: Float32Array, idx: number[]): Int32Array {
  const n = idx.length
  // 键：float32 位型变换为可按无符号整数比较的形式再取反得降序；±0 视为同值
  const key = new Uint32Array(h.length)
  const bits = new Uint32Array(h.buffer, h.byteOffset, h.length)
  for (const i of idx) {
    const b = h[i] === 0 ? 0 : bits[i]
    key[i] = ~(b & 0x80000000 ? ~b : b | 0x80000000) >>> 0
  }
  let src = Int32Array.from(idx)
  let dst = new Int32Array(n)
  const cnt = new Int32Array(65537)
  for (let shift = 0; shift < 32; shift += 16) {
    cnt.fill(0)
    for (let k = 0; k < n; k++) cnt[((key[src[k]] >>> shift) & 0xffff) + 1]++
    for (let k = 0; k < 65536; k++) cnt[k + 1] += cnt[k]
    for (let k = 0; k < n; k++) dst[cnt[(key[src[k]] >>> shift) & 0xffff]++] = src[k]
    const t = src
    src = dst
    dst = t
  }
  return src
}
