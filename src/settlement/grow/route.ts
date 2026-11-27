import * as dmath from '../../gen/dmath'
import type { GrowP, GrowRoad, GrowState } from './api'
import { UNIT_W, lotAtPoint } from './core'

// 沿路网走：给俯视图上「人从这儿走到那儿」画一条像样的路线（只是看的，不改状态、不影响选址）。规则一句一条：
//   - 路网 = 每条路的中线折线；一条路的端点离别的路不到 JOIN 米，就在那条路上最近的一点接上（岔路都是从路口岔出去的，端点正落在母路上）；
//     离得不到 JOIN 米的顶点当成同一个路口。
//   - 起点先垂直走到离它最近的那段路上，沿路网按长度走最短的一条（Dijkstra）到离终点最近的那段路上的投影点，再走到终点。
//   - 起终点不到一块地宽（UNIT_W），或落在同一块地上：直接直线。
//   - 没有路，或两头的路不连通：退回直线。
//   - 路网图按 state.roads 这个数组记着（状态只换新的不改；只改地块时 roads 还是同一个数组，不重建）。
// 没有什么：路口转弯不切角、不分左右侧通行，也不看路的种类（大路小路一样快）；不绕开地块（离路最近的那一下可能穿过邻家的地）。

/** 路的端点离别的路、两个顶点之间多近算接上（米） */
const JOIN = 2

interface Graph {
  /** 节点坐标 */
  xy: GrowP[]
  /** 邻接：节点 → [邻居, 长度][] */
  adj: [number, number][][]
  /** 所有路段（两个节点）：投影时找最近的一段 */
  segs: [number, number][]
}

const graphs = new WeakMap<GrowRoad[], Graph>()

const dist = (a: GrowP, b: GrowP) => dmath.hypot(b[0] - a[0], b[1] - a[1])

/** 点到线段 ab 的最近点：参数 t（0 ~ 1）与距离 */
function project(p: GrowP, a: GrowP, b: GrowP): { t: number; d: number; q: GrowP } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0
  const q: GrowP = [a[0] + dx * t, a[1] + dy * t]
  return { t, d: dist(p, q), q }
}

function build(roads: GrowRoad[]): Graph {
  const xy: GrowP[] = []
  /** 落到已有节点上（不到 JOIN 米），否则新开一个 */
  const nodeAt = (p: GrowP): number => {
    for (let i = 0; i < xy.length; i++) if (dist(xy[i], p) < JOIN) return i
    xy.push(p)
    return xy.length - 1
  }
  // 每段路上要切开的点（参数 t）：别的路的端点接在这儿
  const cuts = roads.map((r) => r.pts.slice(1).map(() => [] as { t: number; p: GrowP }[]))
  roads.forEach((r, ri) => {
    if (r.pts.length < 2) return
    for (const e of [r.pts[0], r.pts[r.pts.length - 1]]) {
      let best: { ri: number; si: number; t: number; d: number } | null = null
      roads.forEach((o, oi) => {
        if (oi === ri) return
        for (let si = 0; si + 1 < o.pts.length; si++) {
          const h = project(e, o.pts[si], o.pts[si + 1])
          if (h.d < JOIN && (!best || h.d < best.d)) best = { ri: oi, si, t: h.t, d: h.d }
        }
      })
      // 切点用这条路的端点本身：两条路在这一点上共用一个节点
      const b = best as { ri: number; si: number; t: number } | null
      if (b) cuts[b.ri][b.si].push({ t: b.t, p: e })
    }
  })
  const adj: [number, number][][] = []
  const segs: [number, number][] = []
  const link = (u: number, v: number) => {
    if (u === v) return
    while (adj.length < xy.length) adj.push([])
    const L = dist(xy[u], xy[v])
    adj[u].push([v, L])
    adj[v].push([u, L])
    segs.push([u, v])
  }
  roads.forEach((r, ri) => {
    for (let si = 0; si + 1 < r.pts.length; si++) {
      const chain = [r.pts[si], ...cuts[ri][si].sort((p, q) => p.t - q.t).map((c) => c.p), r.pts[si + 1]].map(nodeAt)
      for (let k = 0; k + 1 < chain.length; k++) link(chain[k], chain[k + 1])
    }
  })
  while (adj.length < xy.length) adj.push([])
  return { xy, adj, segs }
}

const graphOf = (state: GrowState): Graph => {
  let g = graphs.get(state.roads)
  if (!g) graphs.set(state.roads, (g = build(state.roads)))
  return g
}

/** 离点最近的路段：哪一段、投影点 */
function nearest(g: Graph, p: GrowP): { u: number; v: number; q: GrowP } | null {
  let best: { u: number; v: number; q: GrowP; d: number } | null = null
  for (const [u, v] of g.segs) {
    const h = project(p, g.xy[u], g.xy[v])
    if (!best || h.d < best.d) best = { u, v, q: h.q, d: h.d }
  }
  return best
}

/** 从起点所在路段的两头出发的最短路（多源 Dijkstra，二叉堆）：返回到各节点的长度与上一个节点 */
function dijkstra(g: Graph, src: [number, number][]): { d: Float64Array; prev: Int32Array } {
  const n = g.xy.length
  const d = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const heap: [number, number][] = []
  const push = (x: [number, number]) => {
    heap.push(x)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = (): [number, number] => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  for (const [s, c] of src) if (c < d[s]) { d[s] = c; push([c, s]) }
  while (heap.length) {
    const [c, u] = pop()
    if (c > d[u]) continue
    for (const [v, L] of g.adj[u]) {
      const nc = c + L
      if (nc < d[v]) { d[v] = nc; prev[v] = u; push([nc, v]) }
    }
  }
  return { d, prev }
}

export function route(state: GrowState, from: GrowP, to: GrowP): GrowP[] {
  const line: GrowP[] = [from, to]
  if (dist(from, to) < UNIT_W) return line
  const lf = lotAtPoint(state, from)
  if (lf && lf === lotAtPoint(state, to)) return line
  const g = graphOf(state)
  const a = nearest(g, from)
  const b = nearest(g, to)
  if (!a || !b) return line
  let mid: GrowP[]
  if ((a.u === b.u && a.v === b.v) || (a.u === b.v && a.v === b.u)) mid = [a.q, b.q]
  else {
    const { d, prev } = dijkstra(g, [[a.u, dist(a.q, g.xy[a.u])], [a.v, dist(a.q, g.xy[a.v])]])
    const du = d[b.u] + dist(g.xy[b.u], b.q)
    const dv = d[b.v] + dist(g.xy[b.v], b.q)
    if (!Number.isFinite(du) && !Number.isFinite(dv)) return line
    const nodes: number[] = []
    for (let k = du <= dv ? b.u : b.v; k >= 0; k = prev[k]) nodes.push(k)
    nodes.reverse()
    mid = [a.q, ...nodes.map((k) => g.xy[k]), b.q]
  }
  // 去掉挨得太近的点（投影点正落在节点上时）
  const out: GrowP[] = [from]
  for (const p of [...mid, to]) if (dist(out[out.length - 1], p) > 0.01) out.push([p[0], p[1]])
  if (out.length < 2) out.push([to[0], to[1]])
  return out
}
