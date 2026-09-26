import { Biome, type Label, type Road } from './types'

/**
 * 道路与航线。
 *
 * 陆路：在粗网格上给每格一个通行代价（陡坡、高山、湿地、冰原、大河都更贵），
 * 城市之间用 A* 找最省力的路线。选哪些城市相连：每座城与最近的几座城是候选，
 * 先取最小生成树保证全连通，再补上"绕路太远"的捷径；布线时已有道路的格子打折，
 * 后修的路会顺势并入干道，形成主干 + 支线，而不是一把互不相干的直线。
 *
 * 航线：不同陆块（岛屿）之间，从各自的港口城市出发走离岸的海路，按陆块做最小生成树。
 */

interface Grid {
  /** 粗网格边长（细格数） */
  r: number
  CW: number
  CH: number
  /** 陆地通行代价，Infinity 为不可通行（海、湖） */
  land: Float32Array
  /** 海上通行代价，Infinity 为陆地或湖 */
  sea: Float32Array
}

export function buildRoads(
  elev: Float32Array,
  water: Float32Array,
  biome: Uint8Array,
  flow: Float32Array,
  labels: Label[],
  W: number,
  H: number,
  kmPerCell: number,
  riverThr: number,
): Road[] {
  const g = costGrid(elev, water, biome, flow, W, H, kmPerCell, riverThr)
  const { CW, CH, r } = g
  const toC = (x: number, y: number) => Math.min(CH - 1, Math.max(0, Math.round(y / r))) * CW + Math.min(CW - 1, Math.max(0, Math.round(x / r)))
  const cities = labels
    .filter((l) => l.kind === 'city' || l.kind === 'capital')
    .map((l) => ({ capital: l.kind === 'capital', cell: nearest(g.land, CW, CH, toC(l.x, l.y), 4) }))
    .filter((c) => c.cell >= 0)
  if (cities.length < 2) return []

  // 陆块编号
  const comp = components(g.land, CW, CH)
  const byComp = new Map<number, number[]>()
  cities.forEach((c, i) => {
    const k = comp[c.cell]
    if (!byComp.has(k)) byComp.set(k, [])
    byComp.get(k)!.push(i)
  })

  const roadCell = new Uint8Array(CW * CH)
  const astar = new AStar(CW, CH)
  const roads: Road[] = []
  /** 陆路段（粗格序列），全部布完后统一在接头处断开、简化、平滑 */
  const segs: Seg[] = []

  // —— 陆路：每个陆块内选边 ——
  const chosen: { a: number; b: number; major: boolean; cost: number }[] = []
  for (const ids of byComp.values()) {
    if (ids.length < 2) continue
    const pos = (i: number) => [cities[i].cell % CW, Math.floor(cities[i].cell / CW)]
    const dist = (i: number, j: number) => {
      const [ax, ay] = pos(i)
      const [bx, by] = pos(j)
      return Math.hypot(ax - bx, ay - by)
    }
    // 候选：每座城最近的 4 座
    const cand = new Map<string, { a: number; b: number; cost: number }>()
    for (const i of ids) {
      const near = ids.filter((j) => j !== i).sort((p, q) => dist(i, p) - dist(i, q)).slice(0, 4)
      for (const j of near) {
        const key = i < j ? `${i},${j}` : `${j},${i}`
        if (!cand.has(key)) cand.set(key, { a: Math.min(i, j), b: Math.max(i, j), cost: 0 })
      }
    }
    for (const e of cand.values()) e.cost = astar.cost(g.land, cities[e.a].cell, cities[e.b].cell, roadCell, 1)
    const edges = [...cand.values()].filter((e) => Number.isFinite(e.cost)).sort((p, q) => p.cost - q.cost)
    // 最小生成树（Kruskal）
    const parent = new Map<number, number>(ids.map((i) => [i, i]))
    const find = (x: number): number => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!))
    const adj = new Map<number, { to: number; w: number }[]>(ids.map((i) => [i, []]))
    const link = (e: { a: number; b: number; cost: number }, major: boolean) => {
      chosen.push({ ...e, major })
      adj.get(e.a)!.push({ to: e.b, w: e.cost })
      adj.get(e.b)!.push({ to: e.a, w: e.cost })
    }
    const rest: typeof edges = []
    for (const e of edges) {
      const ra = find(e.a)
      const rb = find(e.b)
      if (ra === rb) rest.push(e)
      else {
        parent.set(ra, rb)
        link(e, true)
      }
    }
    // 候选图不连通（两团城市互相都不在对方最近的 4 座里）：团与团之间补最近的一对
    for (;;) {
      const roots = new Set(ids.map(find))
      if (roots.size < 2) break
      let best: { a: number; b: number; cost: number } | null = null
      let bestD = Infinity
      for (const i of ids) for (const j of ids) if (find(i) !== find(j) && dist(i, j) < bestD) ((bestD = dist(i, j)), (best = { a: i, b: j, cost: 0 }))
      if (!best) break
      best.cost = astar.cost(g.land, cities[best.a].cell, cities[best.b].cell, roadCell, 1)
      parent.set(find(best.a), find(best.b))
      if (Number.isFinite(best.cost)) link(best, true)
    }
    // 捷径：网络上绕行超过直连 1.4 倍的，补一条支线
    for (const e of rest) {
      if (graphDist(adj, e.a, e.b, e.cost * 1.4) > e.cost * 1.4) link(e, false)
    }
  }

  // 按重要性布线：干线（连都城的优先）在前，支线在后；已有道路打折，后修的路并入干道
  chosen.sort((p, q) => Number(q.major) - Number(p.major) || Number(cities[q.a].capital || cities[q.b].capital) - Number(cities[p.a].capital || cities[p.b].capital) || p.cost - q.cost)
  for (const e of chosen) {
    const path = astar.path(g.land, cities[e.a].cell, cities[e.b].cell, roadCell, 0.4)
    if (path) emit(segs, path, roadCell, e.major ? 'major' : 'minor')
  }

  // —— 航线：陆块之间 ——
  const compIds = [...byComp.keys()]
  if (compIds.length > 1) {
    // 港口：离海近的城市；一座都没有就取最靠海的那座
    const ports = new Map<number, { city: number; sea: number }[]>()
    for (const k of compIds) {
      const list: { city: number; sea: number; d: number }[] = []
      // 先在城市近旁找海；整块陆地的城市都在内陆时放宽半径，取离海最近的一座
      for (const radius of [6, 48]) {
        for (const i of byComp.get(k)!) {
          const s = nearest(g.sea, CW, CH, cities[i].cell, radius)
          if (s < 0) continue
          const d = Math.hypot((s % CW) - (cities[i].cell % CW), Math.floor(s / CW) - Math.floor(cities[i].cell / CW))
          list.push({ city: i, sea: s, d })
        }
        if (list.length) break
      }
      list.sort((p, q) => p.d - q.d)
      const good = list.filter((p) => p.d <= 3)
      ports.set(k, good.length ? good : list.slice(0, 1))
    }
    const sea = new SeaSearch(CW, CH)
    // 每个陆块多源出发，量到其他陆块最近港口的海路
    const links: { a: number; b: number; cost: number; path: number[]; pa: number; pb: number }[] = []
    for (const k of compIds) {
      const src = ports.get(k)!
      if (!src.length) continue
      sea.run(g.sea, src.map((p) => p.sea))
      for (const k2 of compIds) {
        if (k2 <= k) continue
        let best: { city: number; sea: number } | null = null
        for (const p of ports.get(k2)!) if (!best || sea.dist[p.sea] < sea.dist[best.sea]) best = p
        if (!best || !Number.isFinite(sea.dist[best.sea])) continue
        const path = sea.trace(best.sea)
        const from = src.find((p) => p.sea === path[path.length - 1])
        links.push({ a: k, b: k2, cost: sea.dist[best.sea], path, pa: from ? from.city : src[0].city, pb: best.city })
      }
    }
    links.sort((p, q) => p.cost - q.cost)
    const par = new Map<number, number>(compIds.map((k) => [k, k]))
    const find = (x: number): number => (par.get(x) === x ? x : (par.set(x, find(par.get(x)!)), par.get(x)!))
    for (const l of links) {
      const ra = find(l.a)
      const rb = find(l.b)
      if (ra === rb) continue
      par.set(ra, rb)
      // 两端的上岸点：航线从岸上的码头出发，港口城市再修一小段路过去，三者首尾相接
      const ends: number[] = []
      for (const [city, s] of [[l.pb, l.path[0]], [l.pa, l.path[l.path.length - 1]]]) {
        let shore = nearest(g.land, CW, CH, s, 3)
        if (shore < 0) shore = cities[city].cell
        ends.push(shore)
        if (shore === cities[city].cell) continue
        const path = astar.path(g.land, cities[city].cell, shore, roadCell, 0.4)
        if (path && path.length > 1) emit(segs, path, roadCell, 'minor')
      }
      const cells = [ends[0], ...l.path, ends[1]]
      roads.push({ kind: 'sea', pts: smooth(simplify(cells.map((c) => cellXY(c, g)).flat(), 1.2 * r), 2) })
    }
  }
  return [...finish(segs, g), ...roads]
}

// ———————————————————————— 代价网格 ————————————————————————

function costGrid(elev: Float32Array, water: Float32Array, biome: Uint8Array, flow: Float32Array, W: number, H: number, kmPerCell: number, riverThr: number): Grid {
  const r = Math.max(1, Math.round(W / 512))
  const CW = Math.ceil(W / r)
  const CH = Math.ceil(H / r)
  const land = new Float32Array(CW * CH)
  const sea = new Float32Array(CW * CH)
  const at = (cx: number, cy: number) => Math.min(H - 1, cy * r + (r >> 1)) * W + Math.min(W - 1, cx * r + (r >> 1))
  const km = kmPerCell * r
  for (let cy = 0; cy < CH; cy++) {
    for (let cx = 0; cx < CW; cx++) {
      const c = cy * CW + cx
      const i = at(cx, cy)
      const h = elev[i]
      const isSea = h <= 0
      const isLake = !isSea && !Number.isNaN(water[i])
      sea[c] = isSea ? 1 : Infinity
      if (isSea || isLake) {
        land[c] = Infinity
        continue
      }
      // 坡度（高差 / 水平距离，都换成 km）
      const hx = elev[at(Math.min(CW - 1, cx + 1), cy)] - elev[at(Math.max(0, cx - 1), cy)]
      const hy = elev[at(cx, Math.min(CH - 1, cy + 1))] - elev[at(cx, Math.max(0, cy - 1))]
      const s = Math.hypot(hx, hy) / (2 * km)
      let cost = 1 + Math.min(30, (s / 0.012) ** 2) + Math.max(0, h - 1.4) * 1.5
      const b = biome[i]
      if (b === Biome.Wetland) cost += 2
      else if (b === Biome.IceCap) cost += 6
      else if (b === Biome.TropicalRainforest || b === Biome.TemperateRainforest) cost += 0.6
      else if (b === Biome.HotDesert || b === Biome.ColdDesert) cost += 0.4
      // 大河：过河要架桥，沿河走在水里更不行
      if (flow[i] > riverThr * 6) cost += 4
      land[c] = cost
    }
  }
  // 海路离岸行驶：贴着陆地的海格更贵
  for (let cy = 0; cy < CH; cy++) {
    for (let cx = 0; cx < CW; cx++) {
      const c = cy * CW + cx
      if (!Number.isFinite(sea[c])) continue
      let nearLand = false
      for (let dy = -1; dy <= 1 && !nearLand; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x >= 0 && y >= 0 && x < CW && y < CH && !Number.isFinite(sea[y * CW + x])) {
            nearLand = true
            break
          }
        }
      }
      if (nearLand) sea[c] = 3
    }
  }
  return { r, CW, CH, land, sea }
}

/** 最近的可通行格（螺旋外扩，半径 maxR 内） */
function nearest(cost: Float32Array, CW: number, CH: number, c: number, maxR: number) {
  if (Number.isFinite(cost[c])) return c
  const x0 = c % CW
  const y0 = Math.floor(c / CW)
  let best = -1
  let bd = Infinity
  for (let dy = -maxR; dy <= maxR; dy++) {
    for (let dx = -maxR; dx <= maxR; dx++) {
      const x = x0 + dx
      const y = y0 + dy
      if (x < 0 || y < 0 || x >= CW || y >= CH) continue
      const d = dx * dx + dy * dy
      if (d < bd && Number.isFinite(cost[y * CW + x])) ((bd = d), (best = y * CW + x))
    }
  }
  return best
}

function components(cost: Float32Array, CW: number, CH: number) {
  const id = new Int32Array(CW * CH).fill(-1)
  let n = 0
  const stack: number[] = []
  for (let s = 0; s < id.length; s++) {
    if (id[s] >= 0 || !Number.isFinite(cost[s])) continue
    id[s] = n
    stack.push(s)
    while (stack.length) {
      const c = stack.pop()!
      const x = c % CW
      const y = (c - x) / CW
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue
          const j = ny * CW + nx
          if (id[j] < 0 && Number.isFinite(cost[j])) {
            id[j] = n
            stack.push(j)
          }
        }
      }
    }
    n++
  }
  return id
}

/** 城市图上的最短路（超过 limit 就提前放弃） */
function graphDist(adj: Map<number, { to: number; w: number }[]>, a: number, b: number, limit: number) {
  const d = new Map<number, number>([[a, 0]])
  const heap = new Heap()
  heap.push(a, 0)
  while (heap.size) {
    const [u, du] = heap.pop()
    if (u === b) return du
    if (du > limit) break
    if (du > (d.get(u) ?? Infinity)) continue
    for (const { to, w } of adj.get(u) ?? []) {
      const nd = du + w
      if (nd < (d.get(to) ?? Infinity)) {
        d.set(to, nd)
        heap.push(to, nd)
      }
    }
  }
  return Infinity
}

// ———————————————————————— 搜索 ————————————————————————

const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
]

/** 陆路 A*：已有道路的格子乘以 roadMul */
class AStar {
  private g: Float64Array
  private from: Int32Array
  private seen: Uint32Array
  private stamp = 0
  private heap = new Heap()

  constructor(
    private CW: number,
    private CH: number,
  ) {
    this.g = new Float64Array(CW * CH)
    this.from = new Int32Array(CW * CH)
    this.seen = new Uint32Array(CW * CH)
  }

  cost(cost: Float32Array, a: number, b: number, road: Uint8Array, roadMul: number) {
    return this.search(cost, a, b, road, roadMul) ? this.g[b] : Infinity
  }

  path(cost: Float32Array, a: number, b: number, road: Uint8Array, roadMul: number) {
    if (!this.search(cost, a, b, road, roadMul)) return null
    const out = [b]
    let c = b
    while (c !== a) {
      c = this.from[c]
      out.push(c)
    }
    return out.reverse()
  }

  private search(cost: Float32Array, a: number, b: number, road: Uint8Array, roadMul: number) {
    const { CW, CH, g, from, seen, heap } = this
    const st = ++this.stamp
    const bx = b % CW
    const by = Math.floor(b / CW)
    const hMul = Math.min(1, roadMul)
    const h = (c: number) => Math.hypot((c % CW) - bx, Math.floor(c / CW) - by) * hMul
    heap.clear()
    g[a] = 0
    seen[a] = st
    heap.push(a, h(a))
    while (heap.size) {
      const [c, f] = heap.pop()
      if (c === b) return true
      const gc = g[c]
      if (f - h(c) > gc + 1e-9) continue
      const x = c % CW
      const y = (c - x) / CW
      const cc = cost[c] * (road[c] ? roadMul : 1)
      for (const [dx, dy, len] of DIRS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue
        const j = ny * CW + nx
        const cj = cost[j]
        if (!Number.isFinite(cj)) continue
        const ng = gc + len * 0.5 * (cc + cj * (road[j] ? roadMul : 1))
        if (seen[j] !== st || ng < g[j]) {
          seen[j] = st
          g[j] = ng
          from[j] = c
          heap.push(j, ng + h(j))
        }
      }
    }
    return false
  }
}

/** 海上多源 Dijkstra */
class SeaSearch {
  dist: Float64Array
  private from: Int32Array
  private heap = new Heap()

  constructor(
    private CW: number,
    private CH: number,
  ) {
    this.dist = new Float64Array(CW * CH)
    this.from = new Int32Array(CW * CH)
  }

  run(cost: Float32Array, sources: number[]) {
    const { CW, CH, dist, from, heap } = this
    dist.fill(Infinity)
    heap.clear()
    for (const s of sources) {
      dist[s] = 0
      from[s] = -1
      heap.push(s, 0)
    }
    while (heap.size) {
      const [c, d] = heap.pop()
      if (d > dist[c]) continue
      const x = c % CW
      const y = (c - x) / CW
      for (const [dx, dy, len] of DIRS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue
        const j = ny * CW + nx
        if (!Number.isFinite(cost[j])) continue
        const nd = d + len * 0.5 * (cost[c] + cost[j])
        if (nd < dist[j]) {
          dist[j] = nd
          from[j] = c
          heap.push(j, nd)
        }
      }
    }
  }

  /** 从 c 回溯到出发的港口：返回 [c, …, 港口] */
  trace(c: number) {
    const out = [c]
    while (this.from[c] >= 0) {
      c = this.from[c]
      out.push(c)
    }
    return out
  }
}

/** 二叉最小堆（键用 Float64，Float32 会让相近的代价比较出错） */
class Heap {
  private ids: number[] = []
  private keys: number[] = []
  get size() {
    return this.ids.length
  }
  clear() {
    this.ids.length = 0
    this.keys.length = 0
  }
  push(id: number, key: number) {
    const { ids, keys } = this
    let i = ids.length
    ids.push(id)
    keys.push(key)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      ids[i] = ids[p]
      keys[i] = keys[p]
      i = p
    }
    ids[i] = id
    keys[i] = key
  }
  pop(): [number, number] {
    const { ids, keys } = this
    const top: [number, number] = [ids[0], keys[0]]
    const id = ids.pop()!
    const key = keys.pop()!
    const n = ids.length
    if (n) {
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        if (l >= n) break
        const r = l + 1
        const m = r < n && keys[r] < keys[l] ? r : l
        if (keys[m] >= key) break
        ids[i] = ids[m]
        keys[i] = keys[m]
        i = m
      }
      ids[i] = id
      keys[i] = key
    }
    return top
  }
}

// ———————————————————————— 输出 ————————————————————————

function cellXY(c: number, g: Grid): [number, number] {
  const x = c % g.CW
  const y = (c - x) / g.CW
  return [x * g.r + (g.r - 1) / 2, y * g.r + (g.r - 1) / 2]
}

interface Seg {
  kind: Road['kind']
  cells: number[]
}

/** 只记下新修的段落（已有道路上的部分不重复画），首尾各多带一格，正好落在原有道路上 */
function emit(segs: Seg[], path: number[], roadCell: Uint8Array, kind: Road['kind']) {
  let start = -1
  const flush = (end: number) => {
    const a = Math.max(0, start - 1)
    const b = Math.min(path.length - 1, end + 1)
    if (b - a >= 1) segs.push({ kind, cells: path.slice(a, b + 1) })
    start = -1
  }
  for (let k = 0; k < path.length; k++) {
    const isNew = !roadCell[path[k]]
    if (isNew && start < 0) start = k
    if (!isNew && start >= 0) flush(k - 1)
  }
  if (start >= 0) flush(path.length - 1)
  for (const c of path) roadCell[c] = 1
}

/**
 * 输出：每段路的首尾格都是"锚点"（城市或接头）。经过锚点的路在锚点处断开，
 * 这样简化与平滑都保住锚点，支路的端点与干道严丝合缝地交在同一点上。
 */
function finish(segs: Seg[], g: Grid): Road[] {
  const anchor = new Set<number>()
  for (const s of segs) {
    anchor.add(s.cells[0])
    anchor.add(s.cells[s.cells.length - 1])
  }
  const out: Road[] = []
  for (const s of segs) {
    let from = 0
    for (let k = 1; k < s.cells.length; k++) {
      if (k < s.cells.length - 1 && !anchor.has(s.cells[k])) continue
      const piece = s.cells.slice(from, k + 1)
      out.push({ kind: s.kind, pts: smooth(simplify(piece.map((c) => cellXY(c, g)).flat(), 0.7 * g.r), 2) })
      from = k
    }
  }
  return out
}

/** Ramer–Douglas–Peucker（交替存储的 x, y） */
function simplify(pts: number[], tol: number) {
  const n = pts.length / 2
  if (n <= 2) return pts
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const ax = pts[a * 2]
    const ay = pts[a * 2 + 1]
    const dx = pts[b * 2] - ax
    const dy = pts[b * 2 + 1] - ay
    const len = Math.hypot(dx, dy) || 1
    let best = -1
    let bd = tol
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((pts[k * 2] - ax) * dy - (pts[k * 2 + 1] - ay) * dx) / len
      if (d > bd) ((bd = d), (best = k))
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  const out: number[] = []
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[k * 2], pts[k * 2 + 1])
  return out
}

/** Chaikin 细分：折线变成柔和的曲线（端点保持不动） */
function smooth(pts: number[], iters: number) {
  let p = pts
  for (let t = 0; t < iters; t++) {
    const n = p.length / 2
    if (n < 3) return p
    const out = [p[0], p[1]]
    for (let k = 0; k < n - 1; k++) {
      const x0 = p[k * 2]
      const y0 = p[k * 2 + 1]
      const x1 = p[k * 2 + 2]
      const y1 = p[k * 2 + 3]
      out.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25, x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75)
    }
    out.push(p[(n - 1) * 2], p[(n - 1) * 2 + 1])
    p = out
  }
  return p
}
