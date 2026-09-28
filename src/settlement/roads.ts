import { dist, resample, segDist, type P } from './geom'
import type { Ctx } from './ctx'
import type { TerrainResult } from './terrain'
import type { Road } from './types'

/** 道路两侧让出的空地（米）：走廊半宽 = 路面半宽 + 这么多，房子、树不进走廊。规划的窄巷可以给得更紧 */
export const ROAD_CLEAR = 1.2
/** 登记道路走廊（小径不设走廊） */
export function roadCorridor(ctx: Ctx, r: Road, clear = ROAD_CLEAR) {
  if (r.kind !== 'path') ctx.corridors.add(r.line, r.width / 2 + clear)
}
/**
 * 修一条路：加进路网并登记走廊。
 * 这里修的是片区里的街巷（路网整理、架桥之后才修），不再架桥：落在水上的部分截掉，停在岸边。
 */
export function addRoad(ctx: Ctx, r: Road, clear = ROAD_CLEAR) {
  for (const line of r.kind === 'path' ? [r.line] : dryPieces(r.line, ctx.T)) {
    const piece = line === r.line ? r : { ...r, line }
    ctx.out.roads.push(piece)
    roadCorridor(ctx, piece, clear)
  }
}

/** 折线去掉落水（水距 < 0）的部分，返回留在岸上的几段（不落水就原样返回） */
export function dryPieces(line: P[], T: TerrainResult): P[][] {
  const pts = resample(line, 1)
  if (pts.every((q) => T.waterAt(q) >= 0)) return [line]
  const out: P[][] = []
  let cur: P[] = []
  for (const q of pts) {
    if (T.waterAt(q) >= 0) cur.push(q)
    else {
      if (cur.length > 1 && dist(cur[0], cur[cur.length - 1]) > 3) out.push(cur)
      cur = []
    }
  }
  if (cur.length > 1 && dist(cur[0], cur[cur.length - 1]) > 3) out.push(cur)
  return out.map((pc) => resample(pc, 2))
}

/**
 * 路网整理：各条路是分头生成的（干道寻路、方格 / 环形街、顺城路、桥头街、村巷），
 * 彼此会平行贴着走、在同一处各自过河。这里按等级从高到低逐条并入路网：
 * - 与已有道路平行重叠的段落删掉，断开处接到已有道路上（成为岔口），于是共用的路段只剩一条；
 * - 在已有桥附近过河的路不再另架一座桥，而是在岸边接到那座桥的桥头上。
 */
const RANK: Record<Road['kind'], number> = { highway: 0, main: 0, street: 1, lane: 2, path: 3, stair: 3 }
const STEP = 2
/** 与已有道路相距不足"两路半宽之和 + SLACK"且大体平行，就算重叠 */
const SLACK = 1.5
const PARALLEL = 0.85
/** 同一处（这个距离内）只留一座桥 */
const BRIDGE_GAP = 45
/** 桥头以外的路至少要有这么长，或者接着别的路（离路 TOUCH 米内），不然这座桥是断头桥 */
const MIN_STUB = 25
const TOUCH = 4

interface Seg {
  a: P
  b: P
  hw: number
  /** 属于哪条路（给了的话） */
  road?: number
}

class SegGrid {
  segs: Seg[] = []
  private grid = new Map<number, number[]>()
  private readonly B = 32
  add(line: P[], hw: number, road?: number) {
    for (let i = 0; i + 1 < line.length; i++) {
      const s = { a: line[i], b: line[i + 1], hw, road }
      const id = this.segs.length
      this.segs.push(s)
      const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / this.B)
      const x1 = Math.floor(Math.max(s.a[0], s.b[0]) / this.B)
      const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / this.B)
      const y1 = Math.floor(Math.max(s.a[1], s.b[1]) / this.B)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const k = y * 4096 + x
          let l = this.grid.get(k)
          if (!l) this.grid.set(k, (l = []))
          l.push(id)
        }
    }
  }
  /** q 周围 r 米（按格子粗查）的线段，每段只给一次 */
  *around(q: P, r: number): Generator<Seg> {
    const seen = new Set<number>()
    for (let y = Math.floor((q[1] - r) / this.B); y <= Math.floor((q[1] + r) / this.B); y++)
      for (let x = Math.floor((q[0] - r) / this.B); x <= Math.floor((q[0] + r) / this.B); x++)
        for (const id of this.grid.get(y * 4096 + x) ?? []) {
          if (seen.has(id)) continue
          seen.add(id)
          yield this.segs[id]
        }
  }
  /** 离 q 最近、且（给了方向时）与方向平行的线段；返回它上面的最近点与净距（减去半宽）。ok 可以筛掉不合适的落点 */
  nearest(q: P, reach: number, dir?: P, ok?: (p: P, s: Seg) => boolean): { p: P; gap: number; s: Seg } | null {
    let best: { p: P; gap: number; s: Seg } | null = null
    const r = reach + 12
    const seen = new Set<number>()
    // 路网整理时每 2 米问一次：不用 around 的生成器，直接扫格子
    for (let y = Math.floor((q[1] - r) / this.B); y <= Math.floor((q[1] + r) / this.B); y++)
      for (let x = Math.floor((q[0] - r) / this.B); x <= Math.floor((q[0] + r) / this.B); x++)
        for (const id of this.grid.get(y * 4096 + x) ?? []) {
          if (seen.has(id)) continue
          seen.add(id)
          const s = this.segs[id]
          const { d, t } = segDist(q, s.a, s.b)
          const gap = d - s.hw
          if (gap > reach || (best && gap >= best.gap)) continue
          if (dir) {
            const ex = s.b[0] - s.a[0]
            const ey = s.b[1] - s.a[1]
            const cos = Math.abs(dir[0] * ex + dir[1] * ey) / (Math.hypot(ex, ey) || 1)
            if (cos < PARALLEL) continue
          }
          const p: P = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]
          if (ok && !ok(p, s)) continue
          best = { p, gap, s }
        }
    return best
  }
}

// —————————————————————— 找最近的路 ——————————————————————

/** 能走车马的路：小径、石阶（园路、上山的小路）不算 */
export const through = (r: Road) => r.kind !== 'path' && r.kind !== 'stair'

/** 路网的线段索引（按 ctx.out.roads 懒建：只追加时补上新的，删过、换过、撤回过就重建） */
interface RoadIndex {
  grid: SegGrid
  roads: Road[]
  n: number
  last: Road | undefined
  dropped: number
}
const indexes = new WeakMap<Ctx, RoadIndex>()
function roadIndex(ctx: Ctx): RoadIndex {
  const roads = ctx.out.roads
  let ix = indexes.get(ctx)
  if (!ix || ix.roads !== roads || roads.length < ix.n || ix.dropped !== ctx.dropped.length || (ix.n > 0 && roads[ix.n - 1] !== ix.last)) {
    ix = { grid: new SegGrid(), roads, n: 0, last: undefined, dropped: ctx.dropped.length }
    indexes.set(ctx, ix)
  }
  for (; ix.n < roads.length; ix.n++) ix.grid.add(roads[ix.n].line, roads[ix.n].width / 2, ix.n)
  ix.last = roads[ix.n - 1]
  return ix
}

/** 路上离 q 最近的一点：p 落点，d 到中线的距离，gap 到路边的净距（减去半宽），road 哪条路 */
export interface RoadHit {
  p: P
  d: number
  gap: number
  road: Road
}

/**
 * 离 q 最近的路（按到路边的净距）：只看净距 within 米以内的；缺省只要能走车马的路（through），
 * accept 可以另定要哪些路、哪些落点（落点在桥的这一侧、接过去不下水……）
 */
export function nearestRoad(ctx: Ctx, q: P, within = Infinity, accept: (r: Road, p: P) => boolean = through): RoadHit | null {
  const ix = roadIndex(ctx)
  const reach = Math.min(within, ctx.MW + ctx.MH)
  const hit = ix.grid.nearest(q, reach, undefined, (p, s) => accept(ix.roads[s.road!], p))
  return hit && { p: hit.p, d: hit.gap + hit.s.hw, gap: hit.gap, road: ix.roads[hit.s.road!] }
}

/** q 附近（净距 within 米以内）的各条路上各自离 q 最近的一点，由近到远 */
export function roadsNear(ctx: Ctx, q: P, within = Infinity, accept: (r: Road, p: P) => boolean = through): RoadHit[] {
  const ix = roadIndex(ctx)
  const reach = Math.min(within, ctx.MW + ctx.MH)
  const best = new Map<number, RoadHit>()
  for (const s of ix.grid.around(q, reach + 12)) {
    const { d, t } = segDist(q, s.a, s.b)
    const gap = d - s.hw
    const id = s.road!
    if (gap > reach || gap >= (best.get(id)?.gap ?? Infinity)) continue
    const p: P = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]
    if (!accept(ix.roads[id], p)) continue
    best.set(id, { p, d, gap, road: ix.roads[id] })
  }
  return [...best.values()].sort((a, b) => a.gap - b.gap)
}

/**
 * 按 2 米采样的折线上的过水段：[起, 止]，止是上岸后的第一个点（整条路止于水中时是最后一点）。
 * 过河途中碰到的沙洲、窄岛（几米干地）不算上岸，整段算一次过河。
 */
export function wetRuns(pts: P[], T: TerrainResult): [number, number][] {
  const out: [number, number][] = []
  const wetAt = (i: number) => T.waterAt(pts[i]) < 0.5
  let start = -1
  for (let i = 0; i < pts.length; i++) {
    let wet = wetAt(i)
    if (!wet && start >= 0) for (let k = i + 1; k < Math.min(pts.length, i + 6) && !wet; k++) wet = wetAt(k)
    if (wet && start < 0) start = i
    if ((!wet || i === pts.length - 1) && start >= 0) {
      out.push([start, i])
      start = -1
    }
  }
  return out
}

/** 过河的桥两头在原路上最多往回、往前找这么多个采样点（STEP 米一个）来取一条更短、更正的桥线 */
const BRIDGE_WIN = 25
/**
 * 桥身（过水的部分）最长：不超过这里水面最窄宽度的 BRIDGE_SPAN 倍（或宽度 + BRIDGE_SLACK 米），也不超过 BRIDGE_MAX 米。
 * 真实的河宽窄不匀，斜 30° 过河的桥身也会比最窄处长出三成多，这一条只挡顺河的长桥
 */
const BRIDGE_SPAN = 1.6
const BRIDGE_SLACK = 8
const BRIDGE_MAX = 120
/**
 * 桥线与"横过水面"方向的夹角余弦至少这么多（约 32° 以内；够不上的改架一座正的桥，见 doglegBridge）：顺着河、斜着河走的不算过河。
 * 横过的方向在河道上按河的中线取（与中线垂直），别处（湖、港湾）取水面最窄的方向
 */
const BRIDGE_COS = 0.85
/** 只擦着岸边下水（最深不过这么多米）的一段推回岸上 */
const GRAZE = 8

/** q 处横过河道的方向：在河道上（离中线不超过半宽 + 8 米）是中线的法向，否则 null */
function riverNormal(T: TerrainResult, q: P): P | null {
  const rv = T.river
  if (!rv) return null
  let best: P | null = null
  let bd = Infinity
  for (let i = 0; i + 1 < rv.line.length; i++) {
    const { d, t } = segDist(q, rv.line[i], rv.line[i + 1])
    if (d >= bd || d > rv.hw[i] + (rv.hw[i + 1] - rv.hw[i]) * t + 8) continue
    const a = rv.line[i]
    const b = rv.line[i + 1]
    const L = dist(a, b) || 1
    bd = d
    best = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]
  }
  return best
}

/** q 处水面最窄的方向与宽度（两侧上岸点之距） */
function narrowest(T: TerrainResult, q: P): { w: number; d: P } {
  let best = { w: Infinity, d: [1, 0] as P }
  for (let deg = 0; deg < 180; deg += 5) {
    const d: P = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]
    let w = 0
    for (const s of [1, -1]) {
      let t = 0
      while (t < 300 && T.waterAt([q[0] + d[0] * t * s, q[1] + d[1] * t * s]) < 0) t += 1
      w += t
    }
    if (w < best.w) best = { w, d }
  }
  return best
}

/**
 * 过水段 [s, e)（pts[s-1]、pts[e] 在岸上）取一条直的桥线：两头在原路上各往外找几个岸上的点，
 * 桥线要大体横过水面（与河道中线的法向或水面最窄方向夹角不大）、过水部分不太长、只过一次水、不碰海。
 * 取"桥线长 + 绕开的原路长 × 0.35"最小的一条；整条在岸上的捷径也行（绕开这片水）。找不到返回 null。
 */
/** 宽 w 米的水面上，桥最长能架多长 */
const maxSpanOf = (w: number) => Math.min(BRIDGE_MAX, Math.max(w * BRIDGE_SPAN, w + BRIDGE_SLACK))

/** 水面最窄处的方向与宽度（按 2 米取整缓存：同一处会被问好多次） */
function acrossWater(T: TerrainResult) {
  const memo = new Map<number, { w: number; d: P }>()
  return (q: P) => {
    const key = Math.round(q[0] / 2) * 65536 + Math.round(q[1] / 2)
    let v = memo.get(key)
    if (!v) memo.set(key, (v = narrowest(T, q)))
    return v
  }
}

/**
 * 直线 a → b 能不能是一座桥：过水只有一段（中间的干地、沙洲不超过 10 米）、不碰海，桥身不超过这里水面最窄宽度允许的长度，
 * 大体横过水面（与河道中线的法向或水面最窄方向夹角不大）。水面最窄处的方向与宽度按桥线自己最深的一点量
 * （同一段水里各处宽窄、走向可以差很多，比如支流、护城河汇进来的地方）。整条在岸上也算行
 */
function bridgeOk(T: TerrainResult, a: P, b: P, across: (q: P) => { w: number; d: P } = acrossWater(T)): boolean {
  const C = dist(a, b)
  const m = Math.max(1, Math.ceil(C))
  let first = -1
  let last = -1
  let gap = 0
  let q: P = a
  let qd = Infinity
  for (let k = 0; k <= m; k++) {
    const p: P = [a[0] + ((b[0] - a[0]) * k) / m, a[1] + ((b[1] - a[1]) * k) / m]
    const w = T.waterAt(p)
    if (w < qd) (qd = w), (q = p)
    if (T.seaAt(p)) return false
    if (w < 0.5) {
      if (first >= 0 && gap > 10) return false
      if (first < 0) first = k
      last = k
      gap = 0
    } else if (first >= 0) gap += C / m
  }
  if (first < 0) return true
  const span = ((last - first) * C) / m
  const nw = across(q)
  if (span > maxSpanOf(nw.w)) return false
  const d = riverNormal(T, q) ?? nw.d
  return Math.abs(((b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1]) / (C || 1)) >= BRIDGE_COS
}

function bridgeLine(pts: P[], s: number, e: number, iaMin: number, ibMax: number, T: TerrainResult): { ia: number; ib: number } | null {
  const across = acrossWater(T)
  let best: { ia: number; ib: number; cost: number } | null = null
  for (let ia = s - 1; ia >= iaMin; ia--) {
    if (T.waterAt(pts[ia]) < 0.5) continue
    for (let ib = e; ib <= ibMax; ib++) {
      if (T.waterAt(pts[ib]) < 0.5) continue
      const a = pts[ia]
      const b = pts[ib]
      const C = dist(a, b)
      const cost = C + 0.35 * STEP * (s - 1 - ia + ib - e)
      if (best && cost >= best.cost) continue
      if (!bridgeOk(T, a, b, across)) continue
      best = { ia, ib, cost }
    }
  }
  return best
}

/** 从 c 沿 d 走到岸上（水距 ≥ 0.5 再多走 1.5 米）；走 150 米还在水里返回 null */
function toShore(T: TerrainResult, c: P, d: P): P | null {
  for (let t = 0; t < 150; t += 0.5) {
    const p: P = [c[0] + d[0] * t, c[1] + d[1] * t]
    if (T.waterAt(p) >= 0.5) return [p[0] + d[0] * 1.5, p[1] + d[1] * 1.5]
  }
  return null
}

/**
 * 斜着过河、又取不到一条够正的直桥线时：在路过河的地方架一座横过水面的桥（河道上与中线垂直），
 * 路在两岸各拐一下接上桥头。两个岸上点要在水的两边，且顺着水面方向错开不多（不然是顺河走，不是过河）；
 * 接桥头的两段引道全在岸上。返回两头在原路上的接点与要插进去的桥头 [A, B]，不成返回 null。
 */
function doglegBridge(pts: P[], s: number, e: number, iaMin: number, ibMax: number, T: TerrainResult): { ia: number; ib: number; mid: P[] } | null {
  const a0 = pts[s - 1]
  const b0 = pts[e]
  const L = Math.ceil(dist(a0, b0))
  let c0: P = a0
  for (let k = 0; k <= L; k++) {
    const p: P = [a0[0] + ((b0[0] - a0[0]) * k) / L, a0[1] + ((b0[1] - a0[1]) * k) / L]
    if (T.waterAt(p) < T.waterAt(c0)) c0 = p
  }
  if (T.waterAt(c0) >= 0) return null
  const nw = narrowest(T, c0)
  const rn = riverNormal(T, c0)
  const maxSpan = maxSpanOf(nw.w)
  const dryLeg = (p: P, q: P) => {
    const m = Math.max(1, Math.ceil(dist(p, q)))
    for (let k = 0; k <= m; k++) if (T.waterAt([p[0] + ((q[0] - p[0]) * k) / m, p[1] + ((q[1] - p[1]) * k) / m]) < 0.3) return false
    return true
  }
  let best: { ia: number; ib: number; mid: P[]; cost: number } | null = null
  // 横过的方向：河道中线的法向、水面最窄的方向；桥位：路过水最深处，或顺着水面挪开几米（岸线弯、接不上引道时）
  for (const d of rn ? [rn, nw.d] : [nw.d]) {
    const side = (q: P) => (q[0] - c0[0]) * d[0] + (q[1] - c0[1]) * d[1]
    if (side(a0) * side(b0) >= 0) continue
    // 两个岸上点顺着水面错开太多：这是顺着河走，不是过河
    if (Math.abs((b0[0] - a0[0]) * d[1] - (b0[1] - a0[1]) * d[0]) > Math.max(3 * nw.w, 45)) continue
    const sa = side(a0) < 0 ? -1 : 1
    for (const off of [0, 6, -6, 12, -12]) {
      const c: P = [c0[0] - d[1] * off, c0[1] + d[0] * off]
      if (T.waterAt(c) >= 0) continue
      const A = toShore(T, c, [d[0] * sa, d[1] * sa])
      const B = toShore(T, c, [-d[0] * sa, -d[1] * sa])
      if (!A || !B) continue
      const span = dist(A, B) - 3
      if (span > maxSpan) continue
      let sea = false
      for (let t = 0; t <= 1 && !sea; t += 0.05) sea = T.seaAt([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t])
      if (sea) continue
      let ia = -1
      let ca = Infinity
      for (let i = s - 1; i >= iaMin; i--) {
        const cost = dist(pts[i], A) + 0.35 * STEP * (s - 1 - i)
        if (cost < ca && T.waterAt(pts[i]) >= 0.5 && dryLeg(pts[i], A)) (ca = cost), (ia = i)
      }
      let ib = -1
      let cb = Infinity
      for (let i = e; i <= ibMax; i++) {
        const cost = dist(pts[i], B) + 0.35 * STEP * (i - e)
        if (cost < cb && T.waterAt(pts[i]) >= 0.5 && dryLeg(B, pts[i])) (cb = cost), (ib = i)
      }
      if (ia < 0 || ib < 0) continue
      const cost = ca + cb + span
      if (!best || cost < best.cost) best = { ia, ib, mid: [A, B], cost }
    }
  }
  return best && { ia: best.ia, ib: best.ib, mid: best.mid }
}

/**
 * 路的过水段整理成真正的过河：
 * - 横过水面的一段拉成一条直线（就是桥线，见 bridgeLine），路上桥、过桥、下桥，不在水里拐弯；
 *   斜着过河、拉不成够正的直线的，在过河处架一座横过水面的桥，路在两岸拐一下接上（见 doglegBridge）；
 * - 只擦着岸边下水的一段（最深 GRAZE 米以内）推回岸上；
 * - 顺着河走、在水里走的一段（找不到像样的桥线）截掉：路停在岸边，不架一座顺着河的"桥"。
 * 起点、终点在水里的路也截到岸上。返回整理后的几段（名字留给最长的一段）。
 */
export function fixWet(r: Road, T: TerrainResult): Road[] {
  if (r.kind === 'path') return [r]
  const pts = resample(r.line, STEP)
  const n = pts.length
  const runs = wetRuns(pts, T)
  if (!runs.length) return [r]
  const wet = (i: number) => T.waterAt(pts[i]) < 0.5
  const pieces: P[][] = []
  let cur: P[] = []
  // 下一个要抄进 cur 的点
  let k = 0
  const copy = (to: number) => {
    for (; k <= to; k++) cur.push(pts[k])
  }
  for (let ri = 0; ri < runs.length; ri++) {
    const [s, e] = runs[ri]
    const endWet = e === n - 1 && wet(e)
    if (s < k) continue
    const hi = ri + 1 < runs.length ? runs[ri + 1][0] - 1 : n - 1
    if (s > 0 && !endWet) {
      let deep = 0
      for (let i = s; i < e; i++) deep = Math.max(deep, -T.waterAt(pts[i]))
      // 擦着岸边：推回岸上（推完要连贯、全在岸上，相邻两点之间也不过水，不然不算）
      const ashore = () => {
        if (deep > GRAZE) return null
        const moved: P[] = []
        for (let i = s; i < e; i++) {
          let p = pts[i]
          // 推到离水 1.5 米：之后重采样切角也不会再擦到水
          for (let it = 0; it < 6 && T.waterAt(p) < 1.5; it++) {
            const g = T.waterGrad(p)
            const step = 1.8 - T.waterAt(p)
            p = [p[0] + g[0] * step, p[1] + g[1] * step]
          }
          moved.push(p)
        }
        const line = [pts[s - 1], ...moved, pts[e]]
        const ok = line.every((p, i) => {
          if (T.waterAt(p) < 0.5) return false
          if (i === 0) return true
          const q = line[i - 1]
          return dist(p, q) < STEP * 3 && T.waterAt([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]) >= 0.5
        })
        return ok ? moved : null
      }
      // 很浅的（只擦到水边）先推回岸上；否则先找桥线，找不到再推
      const lo = Math.max(cur.length ? k - 1 : k, s - BRIDGE_WIN, 0)
      const ibMax = Math.min(hi, e + BRIDGE_WIN)
      const moved = deep <= 2.5 ? ashore() : null
      const br: { ia: number; ib: number; mid?: P[] } | null = moved || lo > s - 1 ? null : (bridgeLine(pts, s, e, lo, ibMax, T) ?? doglegBridge(pts, s, e, lo, ibMax, T))
      if (br) {
        copy(br.ia)
        if (br.mid) cur.push(...br.mid)
        k = br.ib
        continue
      }
      const pushed = moved ?? (deep > 2.5 ? ashore() : null)
      if (pushed) {
        copy(s - 1)
        cur.push(...pushed)
        k = e
        continue
      }
    }
    // 截断：水前的一段收尾，水后的从上岸处接着
    if (s > 0) copy(s - 1)
    pieces.push(cur)
    cur = []
    k = endWet ? n : e
  }
  copy(n - 1)
  pieces.push(cur)
  const keep = pieces.filter((pc) => pc.length > 1 && dist(pc[0], pc[pc.length - 1]) > 6)
  let longest = -1
  keep.forEach((pc, i) => {
    if (longest < 0 || pc.length > keep[longest].length) longest = i
  })
  return keep.map((line, i) => ({ ...r, line, name: i === longest ? r.name : undefined }))
}

/**
 * 桥（渡口、浅滩）的两头都要有路：路过了桥头还要再走一段（MIN_STUB 米以上），或者那一小段的尽头接着别的路，
 * 或者这条路本来就是一圈（环城路）。整理、截断以后只剩一小截桥头的，把那截连同桥一起去掉：
 * 一头悬空就截到过河之前，两头都悬空就整条去掉。去掉一段可能让别的桥头也悬空，所以反复做到不再变。
 */
export function trimDangling(roads: Road[], T: TerrainResult): Road[] {
  let cur = roads
  for (let pass = 0; pass < 4; pass++) {
    const net = new SegGrid()
    cur.forEach((r, id) => RANK[r.kind] < 3 && net.add(r.line, 0, id))
    let changed = false
    const next: Road[] = []
    cur.forEach((r, id) => {
      const line = r.line
      if (RANK[r.kind] >= 3 || dist(line[0], line[line.length - 1]) < 3) return next.push(r)
      const pts = resample(line, STEP)
      const runs = wetRuns(pts, T)
      if (!runs.length) return next.push(r)
      const len = [0]
      for (let k = 1; k < pts.length; k++) len.push(len[k - 1] + dist(pts[k - 1], pts[k]))
      const joined = (q: P) => !!net.nearest(q, TOUCH, undefined, (_, s) => s.road !== id)
      let lo = 0
      let hi = pts.length - 1
      let a = 0
      let b = runs.length - 1
      while (a <= b && len[runs[a][0]] - len[lo] < MIN_STUB && !joined(pts[lo])) lo = runs[a++][1]
      while (a <= b && len[hi] - len[runs[b][1]] < MIN_STUB && !joined(pts[hi])) hi = runs[b--][0] - 1
      if (lo === 0 && hi === pts.length - 1) return next.push(r)
      changed = true
      if (hi - lo >= 1 && len[hi] - len[lo] > 6 && a <= b + 1) next.push({ ...r, line: resample(pts.slice(lo, hi + 1), 4) })
    })
    cur = next
    if (!changed) break
  }
  return cur
}

export function tidyRoads(roads: Road[], T: TerrainResult): Road[] {
  // 同级的路里宽的先占：重叠时留下宽的那条（规划的大街与沿它出城的干道重合时，大街不被窄的干道截断）
  // 先把各条路的过水段理顺（直线过桥、顺河的截掉），同一处只留一座桥才判得准
  roads = roads.flatMap((r) => fixWet(r, T))
  const order = roads.map((_, i) => i).sort((a, b) => RANK[roads[a].kind] - RANK[roads[b].kind] || roads[b].width - roads[a].width || a - b)
  const net = new SegGrid()
  const bridges: P[] = []
  const out: Road[] = []
  for (const i of order) {
    const r = roads[i]
    if (RANK[r.kind] >= 3) {
      out.push(r)
      continue
    }
    const pts = resample(r.line, STEP)
    const n = pts.length
    const hw = r.width / 2
    // 0 保留，1 与已有道路重叠（断开处接上去），2 在已有桥附近过河（断开处就近接到那座桥的桥头，接不上就停在岸边）
    const drop = new Uint8Array(n)
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)]
      const b = pts[Math.min(n - 1, k + 1)]
      const L = dist(a, b) || 1
      if (net.nearest(pts[k], hw + SLACK, [(b[0] - a[0]) / L, (b[1] - a[1]) / L])) drop[k] = 1
    }
    // 只删成段的重叠（至少三个采样点），交叉口附近零星的一两个点不算
    for (let k = 0; k < n; ) {
      if (!drop[k]) {
        k++
        continue
      }
      let e = k
      while (e < n && drop[e] === 1) e++
      if (e - k < 3) drop.fill(0, k, e)
      k = e
    }
    // 过河：已有桥附近不再另架一座
    const wet = (q: P) => T.waterAt(q) < 0.5
    for (let k = 0; k < n; ) {
      if (!wet(pts[k]) || drop[k]) {
        k++
        continue
      }
      let e = k
      while (e < n && wet(pts[e])) e++
      // 只擦着水边（最深不到 0.5 米，重采样切角出来的）不算过河
      if (!pts.slice(k, e).some((q) => T.waterAt(q) < -0.5)) {
        k = e
        continue
      }
      const mid = pts[(k + e - 1) >> 1]
      if (bridges.some((b) => dist(b, mid) < BRIDGE_GAP)) drop.fill(2, Math.max(0, k - 2), Math.min(n, e + 2))
      else if (!drop.subarray(k, e).some((v) => v)) bridges.push(mid)
      k = e
    }
    if (!drop.some((v) => v)) {
      out.push(r)
      net.add(r.line, hw)
      continue
    }
    // 切成若干段；挨着"重叠"的断头接到已有道路上
    const pieces: P[][] = []
    for (let k = 0; k < n; ) {
      if (drop[k]) {
        k++
        continue
      }
      let e = k
      while (e < n && !drop[e]) e++
      const piece = pts.slice(k, e)
      for (const [end, side] of [
        [0, k - 1],
        [piece.length - 1, e],
      ] as const) {
        if (side < 0 || side >= n || !drop[side]) continue
        // 接桥头要落在岸上，不能接到桥身（那样又得再架一座）
        const hit = drop[side] === 1 ? net.nearest(piece[end], hw + SLACK + STEP * 2) : net.nearest(piece[end], BRIDGE_GAP * 0.5, undefined, (q) => T.waterAt(q) > 2)
        if (!hit) continue
        // 重叠处：断头直接落到已有道路上；桥头：补一小段接过去
        if (drop[side] === 1) piece[end] = hit.p
        else if (end === 0) piece.unshift(hit.p)
        else piece.push(hit.p)
      }
      if (piece.length > 1 && dist(piece[0], piece[piece.length - 1]) > 6) pieces.push(resample(piece, 4))
      k = e
    }
    // 路名留给最长的一段
    let longest = -1
    pieces.forEach((pc, k) => {
      if (longest < 0 || pc.length > pieces[longest].length) longest = k
    })
    pieces.forEach((pc, k) => {
      out.push({ ...r, line: pc, name: k === longest ? r.name : undefined })
      net.add(pc, hw)
    })
  }
  // 接桥头补的短线可能又擦到水：再理一遍
  return trimDangling(
    out.flatMap((r) => fixWet(r, T)),
    T,
  )
}
