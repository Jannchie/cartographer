import type { RNG } from '../gen/rng'
import { bboxOf, centroid, circlePoly, clipHalf, convexOverlap, pointInPoly, segDist, segPolyDist, type BBox, type P, type Poly } from './geom'
import type { SettleNamer } from './names'
import type { TerrainResult } from './terrain'
import type { Settlement, SettlementParams } from './types'

/** 各规模的结构参数 */
export interface SizeCfg {
  /** 城内片区数 */
  inner: number
  /** 片区间距（米） */
  patch: number
  /** 对外道路条数 */
  roads: [number, number]
  /** 城内街宽 / 主街宽 / 城外大路宽 */
  lane: number
  main: number
  highway: number
}

export const SIZE_CFG: Record<SettlementParams['size'], SizeCfg> = {
  hamlet: { inner: 4, patch: 58, roads: [2, 2], lane: 3, main: 4.5, highway: 4 },
  village: { inner: 8, patch: 72, roads: [2, 3], lane: 3.5, main: 5.5, highway: 5 },
  town: { inner: 16, patch: 96, roads: [3, 4], lane: 4.5, main: 7.5, highway: 6 },
  city: { inner: 34, patch: 116, roads: [4, 5], lane: 5, main: 10, highway: 8 },
}

/**
 * "走廊"：道路、河流、城墙这类带宽度的线状要素。
 * 小地块（住宅、田垄）与走廊相交时，用走廊边线所在的半平面裁掉越界的部分，
 * 于是房屋自然沿街退让、沿河收边，而无需通用的多边形布尔运算。
 */
export type CorridorTag = 'road' | 'river' | 'wall'

export class Corridors {
  private segs: { a: P; b: P; hw: number; tag: CorridorTag }[] = []
  private grid = new Map<number, number[]>()
  private readonly B = 40
  private maxHw = 0

  add(line: P[], hw: number, tag: CorridorTag = 'road') {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]
      const b = line[i + 1]
      const id = this.segs.length
      this.segs.push({ a, b, hw, tag })
      this.maxHw = Math.max(this.maxHw, hw)
      const r = hw + 2
      const x0 = Math.floor((Math.min(a[0], b[0]) - r) / this.B)
      const x1 = Math.floor((Math.max(a[0], b[0]) + r) / this.B)
      const y0 = Math.floor((Math.min(a[1], b[1]) - r) / this.B)
      const y1 = Math.floor((Math.max(a[1], b[1]) + r) / this.B)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const k = y * 4096 + x
          let l = this.grid.get(k)
          if (!l) this.grid.set(k, (l = []))
          l.push(id)
        }
    }
  }

  private near(poly: Poly, pad = 0): number[] {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of poly) {
      x0 = Math.min(x0, p[0] - pad)
      y0 = Math.min(y0, p[1] - pad)
      x1 = Math.max(x1, p[0] + pad)
      y1 = Math.max(y1, p[1] + pad)
    }
    const out = new Set<number>()
    for (let y = Math.floor(y0 / this.B); y <= Math.floor(y1 / this.B); y++)
      for (let x = Math.floor(x0 / this.B); x <= Math.floor(x1 / this.B); x++) for (const id of this.grid.get(y * 4096 + x) ?? []) out.add(id)
    return [...out]
  }

  /**
   * 多边形是否碰到走廊（离走廊中线不足半宽 + pad）。tags 限定只看某几类走廊。
   * 贴着走廊边线放置的地块（裁剪结果）不算碰到。
   */
  hitsPoly(poly: Poly, pad = 0, tags?: CorridorTag[]) {
    for (const id of this.near(poly, Math.max(0, pad))) {
      const s = this.segs[id]
      if (tags && !tags.includes(s.tag)) continue
      if (segPolyDist(s.a, s.b, poly) < s.hw + pad - 0.05) return true
    }
    return false
  }

  /** 点是否落在某条走廊里 */
  hits(p: P, pad = 0) {
    for (const id of this.near([p])) {
      const s = this.segs[id]
      if (segDist(p, s.a, s.b).d < s.hw + pad) return true
    }
    return false
  }

  /** 最近走廊的距离（减去半宽） */
  gap(p: P) {
    let best = Infinity
    for (const id of this.near([[p[0] - 60, p[1] - 60], [p[0] + 60, p[1] + 60]])) {
      const s = this.segs[id]
      best = Math.min(best, segDist(p, s.a, s.b).d - s.hw)
    }
    return best
  }

  clip(poly: Poly): Poly | null {
    let out = poly
    for (let pass = 0; pass < 2; pass++) {
      const c = centroid(out)
      for (const id of this.near(out)) {
        const s = this.segs[id]
        const { d, t } = segDist(c, s.a, s.b)
        if (d < s.hw && t > 0 && t < 1) return null
        let hit = false
        for (const v of out) if (segDist(v, s.a, s.b).d < s.hw - 0.05) hit = true
        if (!hit) continue
        const dx = s.b[0] - s.a[0]
        const dy = s.b[1] - s.a[1]
        const L = Math.hypot(dx, dy) || 1
        // 投影落在线段外很远：交给相邻线段处理（避免直线外延误切）
        const tu = ((c[0] - s.a[0]) * dx + (c[1] - s.a[1]) * dy) / (L * L)
        if (tu < -0.6 || tu > 1.6) continue
        let nx = -dy / L
        let ny = dx / L
        if ((c[0] - s.a[0]) * nx + (c[1] - s.a[1]) * ny < 0) {
          nx = -nx
          ny = -ny
        }
        out = clipHalf(out, [s.a[0] + nx * s.hw, s.a[1] + ny * s.hw], [-nx, -ny])
        if (out.length < 3) return null
      }
    }
    return out
  }
}

/**
 * 占地登记：已经放下的建筑、码头、船等实体。
 * 任何新实体落地前都要先查这里，保证特殊建筑、院落、码头之间互不重叠。
 */
export class Occupancy {
  private items: { poly: Poly; bb: BBox }[] = []
  private grid = new Map<number, number[]>()
  private readonly B = 24

  private cells(bb: BBox, pad: number, f: (k: number) => void) {
    for (let y = Math.floor((bb[1] - pad) / this.B); y <= Math.floor((bb[3] + pad) / this.B); y++)
      for (let x = Math.floor((bb[0] - pad) / this.B); x <= Math.floor((bb[2] + pad) / this.B); x++) f(y * 8192 + x)
  }

  add(poly: Poly) {
    const id = this.items.length
    const bb = bboxOf(poly)
    this.items.push({ poly, bb })
    this.cells(bb, 0, (k) => {
      let l = this.grid.get(k)
      if (!l) this.grid.set(k, (l = []))
      l.push(id)
    })
  }

  /** 与已登记实体相交（pad > 0 时还要求留出 pad 米的间隙） */
  overlaps(poly: Poly, pad = 0) {
    const bb = bboxOf(poly)
    const seen = new Set<number>()
    let hit = false
    this.cells(bb, pad, (k) => {
      if (hit) return
      for (const id of this.grid.get(k) ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        const it = this.items[id]
        if (it.bb[0] > bb[2] + pad || it.bb[2] < bb[0] - pad || it.bb[1] > bb[3] + pad || it.bb[3] < bb[1] - pad) continue
        if (convexOverlap(poly, it.poly, pad > 0 ? -pad : 0.05)) {
          hit = true
          return
        }
      }
    })
    return hit
  }

  /** 圆（树冠、井）是否压到已登记实体 */
  hitsPoint(p: P, r: number) {
    if (r <= 0) {
      const seen = new Set<number>()
      let hit = false
      this.cells([p[0], p[1], p[0], p[1]], 0, (k) => {
        for (const id of this.grid.get(k) ?? []) {
          if (hit || seen.has(id)) continue
          seen.add(id)
          if (pointInPoly(p, this.items[id].poly)) hit = true
        }
      })
      return hit
    }
    return this.overlaps(circlePoly(p, r, 8))
  }

  /** 删除满足条件的实体（腾地方给后来的奇观） */
  removeWhere(f: (poly: Poly) => boolean) {
    const keep = this.items.filter((it) => !f(it.poly)).map((it) => it.poly)
    this.items = []
    this.grid.clear()
    for (const p of keep) this.add(p)
  }
}

export interface Ctx {
  p: SettlementParams
  rng: RNG
  T: TerrainResult
  cfg: SizeCfg
  namer: SettleNamer
  MW: number
  MH: number
  center: P
  /** 城区半径估计（米） */
  Rin: number
  /** 规划布局的网格朝向（弧度）；院落据此判断坐北朝南 */
  gridAngle: number
  corridors: Corridors
  occ: Occupancy
  out: Omit<Settlement, 'params' | 'name' | 'nameZh' | 'width' | 'height' | 'terrain' | 'river' | 'sea' | 'stats'>
}

/** 把多边形裁到离水 margin 米以外（沿水距场的等值线收边） */
export function clipWater(ctx: Ctx, poly: Poly, margin: number): Poly | null {
  let out = poly
  for (let pass = 0; pass < 3; pass++) {
    let worst = Infinity
    for (const v of out) worst = Math.min(worst, ctx.T.waterAt(v))
    if (worst >= margin) return out
    const c = centroid(out)
    const w = ctx.T.waterAt(c)
    if (w < margin) return null
    const g = ctx.T.waterGrad(c)
    const o: P = [c[0] - g[0] * (w - margin), c[1] - g[1] * (w - margin)]
    out = clipHalf(out, o, [-g[0], -g[1]])
    if (out.length < 3) return null
  }
  return out
}

/**
 * 实体能否原样落地：不压水（离水 water 米以上）、不碰走廊（留 pad 米）、不压已登记的实体。
 * 与 placeable 不同，这里不做裁剪：特殊建筑不能被切掉一角，放不下就换个位置或缩小。
 */
export function isFree(ctx: Ctx, poly: Poly, o: { pad?: number; water?: number; tags?: CorridorTag[]; gap?: number } = {}) {
  if (poly.length < 3) return false
  const water = o.water ?? 1.5
  const c = centroid(poly)
  if (ctx.T.waterAt(c) < water) return false
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if (ctx.T.waterAt(a) < water || ctx.T.waterAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) < water) return false
  }
  if (ctx.corridors.hitsPoly(poly, o.pad ?? 0, o.tags)) return false
  return !ctx.occ.overlaps(poly, o.gap ?? 0)
}

/** 地块统一的落地检查：离水、离路、坡度 */
export function placeable(ctx: Ctx, poly: Poly, waterMargin = 2.5, maxSlope = 0.32): Poly | null {
  let q: Poly | null = clipWater(ctx, poly, waterMargin)
  if (!q) return null
  q = ctx.corridors.clip(q)
  if (!q) return null
  if (ctx.T.slopeAt(centroid(q)) > maxSlope) return null
  return q
}
