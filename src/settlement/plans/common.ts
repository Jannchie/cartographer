import type { Ctx } from '../ctx'
import { pointInPoly, type P, type Poly } from '../geom'
import type { WardType } from '../types'
import type { PlanZone } from './types'

/**
 * 形制通用的积木：方形 / 圆形规划区、方格站点、沿轴出城。
 */

/** 局部坐标里的矩形轮廓 [u0, u1] × [v0, v1] */
export function rectOutline(z: Pick<PlanZone, 'fromUV'>, u0: number, u1: number, v0: number, v1: number): Poly {
  return [z.fromUV(u0, v0), z.fromUV(u1, v0), z.fromUV(u1, v1), z.fromUV(u0, v1)]
}

/** 住人的片区（形制按自己的样式盖民居的那几类） */
export const RESIDENTIAL: ReadonlySet<WardType> = new Set<WardType>(['common', 'merchant', 'craft', 'slum'])

/**
 * 方格站点：街坊中心在 (i·bu, j·bv)（i, j 取整，城心本身是 (0, 0) 那一格），只取落在规划区里的。
 * 相邻站点的 Voronoi 边界正好是方格线：街坊是 bu × bv 的矩形。
 */
export function gridSites(z: PlanZone, bu: number, bv: number, keep: (i: number, j: number) => boolean = () => true): P[] {
  const out: P[] = []
  const K = Math.ceil((z.R * 2) / Math.min(bu, bv)) + 2
  for (let j = -K; j <= K; j++)
    for (let i = -K; i <= K; i++) {
      if (!keep(i, j)) continue
      const q = z.fromUV(i * bu, j * bv)
      if (z.contains(q)) out.push(q)
    }
  return out
}

/**
 * 沿最近的一条主轴出城：干道原本朝 dir 方向出去，就改走与 dir 最接近的那条轴（±u、±v），
 * 从城心沿轴走到规划区边上（边上就是城门）。offset 让路线在轴旁错开半格，走在街坊之间的街上。
 */
export function axisExit(z: PlanZone, dir: number, offset: [number, number] = [0, 0]): P[] {
  const d: P = [Math.cos(dir), Math.sin(dir)]
  const [du, dv] = z.toUV([z.c[0] + d[0], z.c[1] + d[1]])
  const alongU = Math.abs(du) >= Math.abs(dv)
  const s = alongU ? Math.sign(du) || 1 : Math.sign(dv) || 1
  // 沿轴往外走，直到出了规划区
  const pts: P[] = []
  const start = alongU ? z.fromUV(0, offset[1]) : z.fromUV(offset[0], 0)
  pts.push(start)
  for (let t = 5; t < z.R * 4; t += 5) {
    const q = alongU ? z.fromUV(s * t, offset[1]) : z.fromUV(offset[0], s * t)
    pts.push(q)
    if (!z.contains(q)) break
  }
  return pts
}

/** 点是否在多边形里（给 contains 用） */
export const inside = (poly: Poly) => (q: P) => pointInPoly(q, poly)

/** 局部坐标里的一条折线 */
export const uvLine = (z: PlanZone, pts: [number, number][]): P[] => pts.map(([u, v]) => z.fromUV(u, v))

/** 规划区里某点是否可建（不落水、不太陡） */
export const buildable = (ctx: Ctx, q: P) => ctx.T.waterAt(q) > 6 && ctx.T.slopeAt(q) < 0.3
