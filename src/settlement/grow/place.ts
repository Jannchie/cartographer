import * as dmath from '../../gen/dmath'
import { hash3, hashString } from '../../gen/rng'
import { at, bboxOf as bboxOfPts, box, chaikin, convexOverlap, dist, pointInPoly, polylineLength, rot, segPolyDist, segSegDist, unit, type BBox, type Frame } from '../geom'
import { routeOnTerrain, type TerrainResult } from '../terrain'
import type { GrowLot, GrowP, GrowParams, GrowRoad, GrowRoadKind, GrowState, GrowTerrain, PlaceReq, PlaceResult } from './api'
import {
  GROW_VERSION, LOT_EDGE, LOT_GAP, LOT_OVERLAP_TOL, ROAD_CLEAR, ROAD_WATER, ROAD_WIDTH, SETBACK, UNIT_D, UNIT_W, checkState, cm, lotCenter, terrainOf, useOf, type UseDef,
} from './core'

// 选址与延路（规则见 index.ts 顶上的说明；这里的常量一条一句）。

/** 沿路每隔几米试一处 */
const STEP = 4
/** 地块离水至少几米 */
const WATER_GAP = 3
/** 坡度（高差 / 水平距离）超过它的地不要 */
const MAX_SLOPE = 0.2
/** 住处那一圈至少多大（米）；圈的半径 = 住处一类地块的面积摊成圆、再放宽到 RING_SPREAD 倍面积（给以后的住处留着村心周围的平地） */
const RING_MIN = 100
const RING_SPREAD = 3
/** 打分的权重（都折成「米」）：同主的离得远每米、坡度每单位、位置哈希最多、新路每米、新开岔路（多一个尽头）一次 */
const W_OWNER = 3
const W_SLOPE = 150
const W_HASH = 3
const W_ROAD = 1.5
const BRANCH_COST = 25
/** 延路一次延多长（米） */
const EXT_LEN = 50
/** 延路时顺着原方向，也试着往两边拐这么多（弧度） */
const BENDS = [0, 0.4, -0.4]
/**
 * 沿路每隔几米给以后的岔路留一个路口：第一个在 GAP_FIRST 米处（离路的起头比 ROAD_GAP 远，岔出去才不会贴着上一级的路），
 * 空当面宽 GAP_W、进深 GAP_D（一段新路那么深：田接在临街地块背后往外长，不能把岔路的去路堵死）。
 * 不是对外的路的尽头也往前留一条同样深、路面宽的空当（以后往前延）
 */
const GAP_EVERY = 100
const GAP_FIRST = 50
/** 面宽 7 米：一条 street 的路面加两边各半米（岔出去以后沿岔路的地块不能被它挡住：巷子两边的地块离中线 3.25 米） */
const GAP_W = 7
const GAP_D = 60
/** 落在相符的分区里加多少分（折成米，减掉）；落在别的用途的分区里的不要 */
const ZONE_BONUS = 300
/** 新路离别的路至少多远（米）：中间要摆得下两排地；新路起头的这一段不算 */
const ROAD_GAP = 44
const ROAD_HEAD = 15
/** 延一次路至少要多少分（新路按八成长度算的路钱）：现有最好的空位比它还便宜就不试延路；每个方案也先拿它比一下 */
const EXT_FLOOR = EXT_LEN * 0.8 * W_ROAD
/** 延路的方案，按粗估的分排好后，细算到有 EXT_TRY 个摆得下地为止（最多寻 EXT_MAX 次路） */
const EXT_TRY = 12
const EXT_MAX = 400
/** 空间索引的格子（米） */
const BIN = 32

type Quad = GrowP[]
interface Seg {
  a: GrowP
  b: GrowP
  hw: number
  road: number
}
interface Cand {
  o: GrowP
  u: GrowP
  n: GrowP
  w: number
  road: number
  lb: number
  /** 接着用哪块空着的地（lots 里的下标） */
  reuse: number
  /** 落在用途相符的分区里 */
  zoned: boolean
}

/** 一块候选地的四个角：临街一角 o、沿街 u、进深 n，面宽 w、进深 UNIT_D */
const quadOf = (c: { o: GrowP; u: GrowP; n: GrowP; w: number }): Quad => box({ o: c.o, f: c.u, l: c.n }, 0, c.w, 0, UNIT_D)
/** 外接框，四周再放出 pad 米 */
const bboxOf = (pts: GrowP[], pad = 0): BBox => {
  const b = bboxOfPts(pts)
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]
}

/** 按格子分桶（一样东西可以落进好几个桶；查的时候可能碰到重复的，只多算几次，不影响结果） */
class Bins<T> {
  private map = new Map<number, T[]>()
  add(b: BBox, item: T) {
    for (let i = Math.floor(b[0] / BIN); i <= Math.floor(b[2] / BIN); i++)
      for (let j = Math.floor(b[1] / BIN); j <= Math.floor(b[3] / BIN); j++) {
        const k = (i + 1024) * 4096 + (j + 1024)
        const list = this.map.get(k)
        if (list) list.push(item)
        else this.map.set(k, [item])
      }
  }
  /** fn 返回 true 时停下，整个查询返回 true */
  some(b: BBox, fn: (item: T) => boolean): boolean {
    for (let i = Math.floor(b[0] / BIN); i <= Math.floor(b[2] / BIN); i++)
      for (let j = Math.floor(b[1] / BIN); j <= Math.floor(b[3] / BIN); j++) {
        const list = this.map.get((i + 1024) * 4096 + (j + 1024))
        if (list) for (const it of list) if (fn(it)) return true
      }
    return false
  }
}

/** 道格拉斯–普克简化（保留首尾） */
function simplify(pts: GrowP[], tol: number): GrowP[] {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    let best = -1
    let at = -1
    for (let k = i + 1; k < j; k++) {
      const d = segSegDist(pts[k], pts[k], pts[i], pts[j])
      if (d > best) {
        best = d
        at = k
      }
    }
    if (best > tol) {
      keep[at] = 1
      stack.push([i, at], [at, j])
    }
  }
  return pts.filter((_, k) => keep[k])
}

/** 折线上弧长 s 处的点与切向（单位向量） */
function along(pts: GrowP[], s: number): { p: GrowP; u: GrowP } {
  let acc = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const L = dist(a, b)
    if (s <= acc + L || i + 2 === pts.length) {
      const t = L ? Math.max(0, Math.min(1, (s - acc) / L)) : 0
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], u: unit([b[0] - a[0], b[1] - a[1]]) }
    }
    acc += L
  }
  return { p: pts[0], u: [1, 0] }
}

/** 一条路给以后的岔路留的路口：两侧各一块空当（只由路的形状定） */
function gapsOf(r: GrowRoad): { quads: Quad[]; at: { p: GrowP; n: GrowP }[] } {
  const L = polylineLength(r.pts)
  const hw = ROAD_WIDTH[r.kind] / 2
  const quads: Quad[] = []
  const spots: { p: GrowP; n: GrowP }[] = []
  for (let g = GAP_FIRST; g <= L - 20; g += GAP_EVERY) {
    const { p, u } = along(r.pts, g)
    for (const side of [1, -1]) {
      const n: GrowP = [-u[1] * side, u[0] * side]
      const o: GrowP = [p[0] + n[0] * hw - u[0] * (GAP_W / 2), p[1] + n[1] * hw - u[1] * (GAP_W / 2)]
      quads.push(box({ o, f: u, l: n }, 0, GAP_W, 0, GAP_D))
      spots.push({ p, n })
    }
  }
  if (r.kind !== 'highway' && L > 1) {
    const e = r.pts[r.pts.length - 1]
    const back = along(r.pts, Math.max(0, L - 10)).p
    const u = unit([e[0] - back[0], e[1] - back[1]])
    const h = hw + ROAD_CLEAR
    // 标架的第一轴是路的横向、第二轴是往前：(±h, 0 ~ GAP_D)
    const F: Frame = { o: e, f: [-u[1], u[0]], l: u }
    quads.push([at(F, h, 0), at(F, h, GAP_D), at(F, -h, GAP_D), at(F, -h, 0)])
  }
  return { quads, at: spots }
}

const segsOf = (r: GrowRoad): Seg[] => {
  const hw = ROAD_WIDTH[r.kind] / 2
  const out: Seg[] = []
  for (let i = 0; i + 1 < r.pts.length; i++) out.push({ a: r.pts[i], b: r.pts[i + 1], hw, road: r.id })
  return out
}

/** 一次 place 的工作台：state 的可改副本与空间索引 */
class Work {
  lots: GrowLot[]
  roads: GrowRoad[]
  nextId: number
  readonly step: number
  private lotBins = new Bins<number>()
  private segBins = new Bins<Seg>()
  private gapBins = new Bins<Quad>()
  private W: number
  private H: number

  constructor(
    readonly s: GrowState,
    readonly T: TerrainResult,
  ) {
    this.lots = s.lots.slice()
    this.roads = s.roads.slice()
    this.nextId = s.nextId
    this.step = s.step + 1
    this.W = s.size[0]
    this.H = s.size[1]
    this.lots.forEach((l, i) => this.lotBins.add(bboxOf(l.poly), i))
    for (const r of this.roads) this.indexRoad(r)
    this.zones = s.zones.map((z) => ({ use: z.use, poly: z.poly, b: bboxOf(z.poly) }))
  }

  private zones: { use: string; poly: GrowP[]; b: BBox }[]
  /** 这一点在不在分区里：1 在用途相符的分区里，-1 在别的用途的分区里，0 不在分区里 */
  zoneAt(use: string, x: number, y: number): number {
    let v = 0
    for (const z of this.zones) {
      if (x < z.b[0] || x > z.b[2] || y < z.b[1] || y > z.b[3] || !pointInPoly([x, y], z.poly)) continue
      if (z.use === use) return 1
      v = -1
    }
    return v
  }
  hasZone(use: string) {
    return this.zones.some((z) => z.use === use)
  }

  private indexRoad(r: GrowRoad, from = 0) {
    const segs = segsOf(r)
    for (let i = from; i < segs.length; i++) this.segBins.add(bboxOf([segs[i].a, segs[i].b], segs[i].hw + 1), segs[i])
    for (const q of gapsOf(r).quads) this.gapBins.add(bboxOf(q), q)
  }

  result(): GrowState {
    return { ...this.s, lots: this.lots, roads: this.roads, nextId: this.nextId, step: this.step }
  }

  // —— 打分 ——

  /** 住处那一圈的半径 */
  ring(): number {
    let n = 0
    for (const l of this.lots) if (l.state !== 'vacant' && useOf(l.use).near && l.use !== 'center') n += l.area
    return Math.max(RING_MIN, Math.sqrt((n * UNIT_W * UNIT_D * RING_SPREAD) / Math.PI))
  }

  /**
   * 不用验地就算得出的那部分分（离村心、离同主、分区、位置哈希）：验地只会再加上坡度的分，所以它是总分的下界。
   * 落在别的用途的分区里是 Infinity（不要）
   */
  lower(use: string, def: UseDef, ring: number, mates: GrowP[], salt: number, cx: number, cy: number, z = this.zoneAt(use, cx, cy)) {
    if (z < 0) return Infinity
    const c = this.s.center
    const d = dmath.hypot(cx - c[0], cy - c[1])
    let v = def.near ? d : d < ring ? (ring - d) * def.inside + ring * 0.3 : d * 0.3
    if (mates.length) {
      let m = Infinity
      for (const p of mates) m = Math.min(m, dmath.hypot(cx - p[0], cy - p[1]))
      v += Math.max(0, m - UNIT_W) * W_OWNER
    }
    return v - (z > 0 ? ZONE_BONUS : 0) + hash3(Math.round(cx * 2), Math.round(cy * 2), salt) * W_HASH
  }

  /** 验地：压到路、别的地、路口空当，下水、太陡、出画幅的不要；合格的返回坡度的分 */
  check(q: Quad, skip: number, extra?: { segs: Seg[]; gaps: Quad[] }): number | null {
    const b = bboxOf(q)
    if (b[0] < LOT_EDGE || b[1] < LOT_EDGE || b[2] > this.W - LOT_EDGE || b[3] > this.H - LOT_EDGE) return null
    if (this.lotBins.some(b, (i) => i !== skip && convexOverlap(q, this.lots[i].poly, LOT_OVERLAP_TOL))) return null
    if (this.gapBins.some(b, (g) => convexOverlap(q, g, LOT_OVERLAP_TOL))) return null
    const near = (s: Seg) => segPolyDist(s.a, s.b, q) < s.hw + ROAD_CLEAR
    if (this.segBins.some([b[0] - 4, b[1] - 4, b[2] + 4, b[3] + 4], near)) return null
    if (extra && (extra.segs.some(near) || extra.gaps.some((g) => convexOverlap(q, g, LOT_OVERLAP_TOL)))) return null
    const T = this.T
    const mid: GrowP = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2]
    for (let i = 0; i < 4; i++) {
      const a = q[i]
      const c = q[(i + 1) % 4]
      if (T.waterAt(a) < WATER_GAP || T.waterAt([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]) < WATER_GAP) return null
    }
    if (T.waterAt(mid) < WATER_GAP) return null
    let slope = T.slopeAt(mid)
    for (const a of q) slope += T.slopeAt(a)
    slope /= 5
    return slope > MAX_SLOPE ? null : slope * W_SLOPE
  }

  // —— 候选 ——

  /** 沿一条路两侧（只看弧长 s0 以后的一段） */
  roadCands(r: GrowRoad, w: number, s0: number, push: (c: Omit<Cand, 'lb' | 'reuse' | 'zoned'>) => void) {
    const hw = ROAD_WIDTH[r.kind] / 2
    let acc = 0
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]
      const b = r.pts[i + 1]
      const L = dist(a, b)
      const u = unit([b[0] - a[0], b[1] - a[1]])
      for (let s = Math.ceil(Math.max(acc, s0) / STEP) * STEP; s < acc + L; s += STEP) {
        const t = s - acc
        const p: GrowP = [a[0] + u[0] * t, a[1] + u[1] * t]
        for (const side of [1, -1]) {
          const n: GrowP = [-u[1] * side, u[0] * side]
          push({ o: [p[0] + n[0] * (hw + SETBACK), p[1] + n[1] * (hw + SETBACK)], u, n, w, road: r.id })
        }
      }
      acc += L
    }
  }

  /** 找最好的一处；extra 是还没开的新路（只沿它找） */
  best(req: PlaceReq, mates: GrowP[], salt: number, extra?: { road: GrowRoad; s0: number }): { c: Cand; cost: number } | null {
    const def = useOf(req.use)
    const w = UNIT_W * Math.max(1, req.area)
    const ring = this.ring()
    const cands: Cand[] = []
    const push = (c: Omit<Cand, 'lb' | 'reuse' | 'zoned'>, reuse = -1) => {
      const cx = c.o[0] + (c.u[0] * c.w + c.n[0] * UNIT_D) / 2
      const cy = c.o[1] + (c.u[1] * c.w + c.n[1] * UNIT_D) / 2
      const z = this.zoneAt(req.use, cx, cy)
      const lb = this.lower(req.use, def, ring, mates, salt, cx, cy, z)
      if (lb < Infinity) cands.push({ ...c, reuse, lb, zoned: z > 0 })
    }
    let ex: { segs: Seg[]; gaps: Quad[] } | undefined
    if (extra) {
      ex = { segs: segsOf(extra.road), gaps: gapsOf(extra.road).quads }
      this.roadCands(extra.road, w, extra.s0, push)
    } else {
      for (const r of this.roads) this.roadCands(r, w, 0, push)
      this.lots.forEach((l, i) => {
        const [p0, p1, , p3] = l.poly
        const u = unit([p1[0] - p0[0], p1[1] - p0[1]])
        const n = unit([p3[0] - p0[0], p3[1] - p0[1]])
        const lw = dist(p0, p1)
        // 空着的同样大小的地：接着用
        if (l.state === 'vacant') {
          if (l.area === Math.max(1, req.area)) push({ o: p0, u, n, w, road: l.road }, i)
          return
        }
        // 田、料场可以接在同一种地块的背后、两旁
        if (!def.back || l.use !== req.use) return
        push({ o: [p0[0] + n[0] * (UNIT_D + LOT_GAP), p0[1] + n[1] * (UNIT_D + LOT_GAP)], u, n, w, road: l.road })
        push({ o: [p0[0] + u[0] * (lw + LOT_GAP), p0[1] + u[1] * (lw + LOT_GAP)], u, n, w, road: l.road })
        push({ o: [p0[0] - u[0] * (w + LOT_GAP), p0[1] - u[1] * (w + LOT_GAP)], u, n, w, road: l.road })
      })
    }
    // 按下界排好，依次验地；下界已经不比手里最好的低，后面的都不用看了（排序稳定：同分按生成的先后）
    cands.sort((a, b) => a.lb - b.lb)
    let best: { c: Cand; cost: number } | null = null
    for (const c of cands) {
      if (best && c.lb >= best.cost) break
      const v = this.check(quadOf(c), c.reuse, ex)
      if (v === null) continue
      const cost = c.lb + v
      if (!best || cost < best.cost) best = { c, cost }
    }
    return best
  }

  // —— 延路 ——

  /** 延路的方案：尽头的路顺着（或略拐着）往前延；路口处往两边岔出去 */
  extensions(): { from: GrowP; to: GrowP; road: GrowRoad; branch: boolean }[] {
    const out: { from: GrowP; to: GrowP; road: GrowRoad; branch: boolean }[] = []
    for (const r of this.roads) {
      const end = r.pts[r.pts.length - 1]
      const onEdge = end[0] < LOT_EDGE + 15 || end[1] < LOT_EDGE + 15 || end[0] > this.W - LOT_EDGE - 15 || end[1] > this.H - LOT_EDGE - 15
      // 接到了别的路上的，不是尽头
      const joined = this.segBins.some(bboxOf([end], 4), (s) => s.road !== r.id && segSegDist(end, end, s.a, s.b) < 3)
      if (!onEdge && !joined && r.kind !== 'highway') {
        const L = polylineLength(r.pts)
        const back = along(r.pts, Math.max(0, L - 10)).p
        const u = unit([end[0] - back[0], end[1] - back[1]])
        for (const a of BENDS) {
          const v = rot(u, a)
          out.push({ from: end, to: [end[0] + v[0] * EXT_LEN, end[1] + v[1] * EXT_LEN], road: r, branch: false })
        }
      }
      for (const g of gapsOf(r).at) out.push({ from: g.p, to: [g.p[0] + g.n[0] * EXT_LEN, g.p[1] + g.n[1] * EXT_LEN], road: r, branch: true })
    }
    return out
  }

  /** 新路的中线（绕水、顺坡）；跨水、出画幅、压到地块、离别的路太近的不要 */
  route(o: { from: GrowP; to: GrowP; road: GrowRoad; branch: boolean }, hw: number): GrowP[] | null {
    const { from, to } = o
    if (to[0] < LOT_EDGE || to[1] < LOT_EDGE || to[0] > this.W - LOT_EDGE || to[1] > this.H - LOT_EDGE) return null
    if (this.T.waterAt(to) < ROAD_WATER + 3 || this.T.slopeAt(to) > MAX_SLOPE) return null
    const dry = (pts: GrowP[]) => {
      const L = polylineLength(pts)
      for (let s = 0; s <= L; s += 3) if (this.T.waterAt(along(pts, s).p) < ROAD_WATER) return false
      return true
    }
    // 先试直的；直的下水再按地形寻路绕开（寻路的网格 10 米，绕出来的路平滑过）；绕不开就不延（不跨水）
    let pts: GrowP[] = [from, [cm(to[0]), cm(to[1])]]
    if (!dry(pts)) {
      const raw = routeOnTerrain(this.T, from, to, { water: 40, slope: 2 })
      if (raw.length < 2) return null
      pts = chaikin(simplify(raw, 1.5), 2).map(([x, y]): GrowP => [cm(x), cm(y)])
      pts[0] = from
      if (!dry(pts)) return null
    }
    // 不压地块
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      if (this.lotBins.some(bboxOf([a, b], hw + 1), (k) => segPolyDist(a, b, this.lots[k].poly) < hw + ROAD_CLEAR)) return null
    }
    // 不和别的路挨着平行地走：沿新路每 3 米看一下，起头的一段（接在原来的路上）不算；岔出来的不看母路，延长的不看自己最后那一截
    const tail = o.road.pts[o.road.pts.length - 1]
    const mine = (s: Seg) => s.road === o.road.id && (o.branch || dist(s.a, tail) < 60 || dist(s.b, tail) < 60)
    const L = polylineLength(pts)
    for (let s = ROAD_HEAD; s <= L; s += 3) {
      const q = along(pts, s).p
      if (this.segBins.some(bboxOf([q], ROAD_GAP), (g) => !mine(g) && segSegDist(q, q, g.a, g.b) < ROAD_GAP)) return null
    }
    return pts
  }

  /** 摆下一块；需要时延一次路。改的是工作台里的副本 */
  one(req: PlaceReq, mates: GrowP[], salt: number): { lot: GrowLot; road?: GrowRoad } | null {
    let best = this.best(req, mates, salt)
    let plan: { road: GrowRoad; branch: boolean } | null = null
    // 延路的方案：新路的长度、多一个尽头都算进分里；比现有的空位还好（或者没有空位）才延。
    // 有相符的分区、现有最好的空位又不在分区里时也试（新路可以通进分区里去；分区的加分让方案往那儿排）
    const zoned = this.hasZone(req.use)
    if (!best || best.cost > EXT_FLOOR || (zoned && !best.c.zoned)) {
      const def = useOf(req.use)
      const ring = this.ring()
      const opts = this.extensions()
        .map((o) => {
          const mid: GrowP = [(o.from[0] + o.to[0]) / 2, (o.from[1] + o.to[1]) / 2]
          const far: GrowP = [o.from[0] + (o.to[0] - o.from[0]) * 0.9, o.from[1] + (o.to[1] - o.from[1]) * 0.9]
          const lb = Math.min(this.lower(req.use, def, ring, mates, salt, mid[0], mid[1]), this.lower(req.use, def, ring, mates, salt, far[0], far[1]))
          return { o, pre: lb + EXT_LEN * W_ROAD + (o.branch ? BRANCH_COST : 0) }
        })
        .filter((x) => x.pre < Infinity)
        .sort((a, b) => a.pre - b.pre)
      let good = 0
      let routed = 0
      for (const { o } of opts) {
        if (good >= EXT_TRY || routed >= EXT_MAX) break
        // 新路的分至少有这么多（沿新路摆下的那块可能落在相符的分区里，再减掉分区的加分）
        const extra = EXT_FLOOR + (o.branch ? BRANCH_COST : 0) - (zoned ? ZONE_BONUS : 0)
        if (best && extra >= best.cost) continue
        const kind: GrowRoadKind = o.branch ? (o.road.kind === 'highway' ? 'street' : 'lane') : o.road.kind
        routed++
        const pts = this.route(o, ROAD_WIDTH[kind] / 2)
        if (!pts) continue
        const len = polylineLength(pts)
        const road: GrowRoad = o.branch
          ? { id: this.nextId, kind, pts, born: this.step }
          : { ...o.road, pts: [...o.road.pts, ...pts.slice(1)] }
        const s0 = o.branch ? 0 : polylineLength(o.road.pts) - STEP
        // 延长的路：原来那条在索引里，先在副本里换掉它的旧样子不划算——沿新的一截找就够了（旧的一截已经验过）
        const got = this.best(req, mates, salt, { road, s0 })
        if (!got) continue
        good++
        const cost = got.cost + len * W_ROAD + (o.branch ? BRANCH_COST : 0)
        if (!best || cost < best.cost) {
          best = { c: got.c, cost }
          plan = { road, branch: o.branch }
        }
      }
    }
    if (!best) return null
    let road: GrowRoad | undefined
    if (plan) {
      road = plan.road
      if (plan.branch) {
        this.nextId++
        this.roads.push(road)
        this.indexRoad(road)
      } else {
        const i = this.roads.findIndex((r) => r.id === road!.id)
        const before = this.roads[i].pts.length - 1
        this.roads[i] = road
        this.indexRoad(road, before)
      }
    }
    const c = best.c
    const poly = quadOf(c).map(([x, y]): GrowP => [cm(x), cm(y)])
    const base = { use: req.use, ...(req.owner === undefined ? {} : { owner: req.owner }), state: req.state ?? 'built', born: this.step, area: Math.max(1, req.area) } as const
    let lot: GrowLot
    if (c.reuse >= 0) {
      const old = this.lots[c.reuse]
      lot = { id: old.id, ...base, poly: old.poly, road: old.road }
      this.lots[c.reuse] = lot
    } else {
      lot = { id: this.nextId++, ...base, poly, road: c.road }
      this.lots.push(lot)
      this.lotBins.add(bboxOf(poly), this.lots.length - 1)
    }
    return { lot, road }
  }
}

/** 同主的地块中心（不算空着的） */
const matesOf = (lots: GrowLot[], owner: string | undefined) => (owner === undefined ? [] : lots.filter((l) => l.owner === owner && l.state !== 'vacant').map(lotCenter))

export function place(state: GrowState, req: PlaceReq, salt: number): PlaceResult | null {
  checkState(state)
  const work = new Work(state, terrainOf(state))
  const placed: GrowLot[] = []
  const roads = new Map<number, GrowRoad>()
  const mates = matesOf(state.lots, req.owner)
  const count = Math.max(1, Math.floor(req.count ?? 1))
  for (let k = 0; k < count; k++) {
    // 一片里的后几块：同一个哈希换一个盐，挨着前面摆下的（没有 owner 的一片也挨着）
    const got = work.one(req, [...mates, ...placed.map(lotCenter)], (salt + Math.imul(k, 0x9e3779b1)) | 0)
    if (!got) return null
    placed.push(got.lot)
    if (got.road) roads.set(got.road.id, got.road)
  }
  return { state: work.result(), lots: placed, roads: [...roads.values()] }
}

// —— 开局 ——

/** 村心：画幅中间附近离水远、坡缓的一处（扫一遍 10 米的格子，离中间近的、哈希小的先） */
function pickCenter(T: TerrainResult, W: number, H: number, salt: number): GrowP {
  const mid: GrowP = [W / 2, H / 2]
  for (const [wet, steep] of [
    [40, 0.08],
    [15, 0.2],
  ]) {
    let best: GrowP | null = null
    let bestV = Infinity
    for (let dx = -240; dx <= 240; dx += 10)
      for (let dy = -240; dy <= 240; dy += 10) {
        const p: GrowP = [mid[0] + dx, mid[1] + dy]
        const d = dmath.hypot(dx, dy)
        if (d > 240 || T.waterAt(p) < wet || T.slopeAt(p) > steep) continue
        const v = d + hash3(dx, dy, salt) * 10
        if (v < bestV) {
          bestV = v
          best = p
        }
      }
    if (best) return best
  }
  return mid
}

/** 从村心到画幅边的一条路（按地形寻路，再简化、平滑） */
function outRoad(T: TerrainResult, c: GrowP, a: number, W: number, H: number) {
  const u: GrowP = [dmath.cos(a), dmath.sin(a)]
  // 射线到画幅边（往里收 1 米）
  let t = Infinity
  if (u[0] > 1e-9) t = Math.min(t, (W - 1 - c[0]) / u[0])
  if (u[0] < -1e-9) t = Math.min(t, (1 - c[0]) / u[0])
  if (u[1] > 1e-9) t = Math.min(t, (H - 1 - c[1]) / u[1])
  if (u[1] < -1e-9) t = Math.min(t, (1 - c[1]) / u[1])
  const to: GrowP = [c[0] + u[0] * t, c[1] + u[1] * t]
  const raw = routeOnTerrain(T, c, to, { water: 60, slope: 2 })
  if (raw.length < 2) return null
  const pts = chaikin(simplify(raw, 2), 2).map(([x, y]): GrowP => [cm(x), cm(y)])
  const L = polylineLength(pts)
  let wet = false
  for (let s = 0; s <= L; s += 4) if (T.waterAt(along(pts, s).p) < 1) wet = true
  return { pts, len: L, wet, a }
}

export function seedState(p: GrowParams): GrowState {
  const size: [number, number] = [Math.max(200, Math.round(p.size[0] / 20) * 20), Math.max(200, Math.round(p.size[1] / 20) * 20)]
  const seed = p.seed
  const terrain: GrowTerrain = {
    culture: p.culture,
    river: p.river,
    coast: p.coast,
    hills: p.hills,
    relief: p.relief,
    coastDir: p.coastDir,
    riverDir: p.riverDir,
    hillDir: p.hillDir,
    ...(p.terrainSeed ? { terrainSeed: p.terrainSeed } : {}),
  }
  const s0: GrowState = { v: GROW_VERSION, seed, terrain, size, center: [0, 0], roads: [], lots: [], zones: [], nextId: 1, step: 0 }
  const T = terrainOf(s0)
  const salt = hashString(`${seed}|seed`) | 0
  const c = pickCenter(T, size[0], size[1], salt)
  // 十六个方向都试：不下水的、短的先；第二条要和第一条岔开至少 120 度，也不下水才要
  const turn = hash3(1, 2, salt) * ((Math.PI * 2) / 16)
  const tries = []
  for (let k = 0; k < 16; k++) {
    const r = outRoad(T, c, turn + (k * Math.PI * 2) / 16, size[0], size[1])
    if (r) tries.push({ ...r, v: r.len + (r.wet ? 1e5 : 0) + hash3(k, 7, salt) * 5 })
  }
  tries.sort((a, b) => a.v - b.v)
  const roads: GrowRoad[] = []
  const first = tries[0]
  if (first) {
    roads.push({ id: 1, kind: 'highway', pts: first.pts, born: 0 })
    const second = tries.find((r) => {
      let d = Math.abs(r.a - first.a) % (Math.PI * 2)
      if (d > Math.PI) d = Math.PI * 2 - d
      return !r.wet && d >= (Math.PI * 2) / 3
    })
    if (second) roads.push({ id: 2, kind: 'highway', pts: second.pts, born: 0 })
  }
  const s1: GrowState = { ...s0, center: [cm(c[0]), cm(c[1])], roads, nextId: roads.length + 1 }
  // 村心：一块公用地，挨着两条路的起点
  const got = place({ ...s1, step: -1 }, { use: 'center', area: 1 }, salt)
  return got ? { ...got.state, step: 0 } : s1
}
