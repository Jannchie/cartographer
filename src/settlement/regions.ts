import type { Tri } from '../gen/naming'
import { area, centroid, pointInPoly } from './geom'
import type { Settlement } from './types'

/**
 * 聚落的命名区域（织工区、码头区……）：区域视图里显示成多边形，可以改名、拖顶点改边界，只影响区域名的注记，不动房屋街巷。
 * 默认每个有名字的城区片区是一个区域（与生成器标片区名的规则一致：城内的，或城外不是农田的）。
 * 坐标是米（与聚落的其他几何一致）。
 */
export interface SettleRegion {
  id: string
  name: Tri
  poly: [number, number][]
  at: [number, number]
  /** 面积（平方米，重叠时先选小的） */
  size: number
}

export function defaultRegions(st: Settlement): SettleRegion[] {
  const out: SettleRegion[] = []
  st.wards.forEach((w, i) => {
    if (!w.name || !(w.inner || w.type !== 'farm')) return
    const c = centroid(w.poly)
    out.push({ id: `ward:${i}`, name: { ...w.name }, poly: w.poly.map((p) => [p[0], p[1]] as [number, number]), at: [c[0], c[1]], size: area(w.poly) })
  })
  return out
}

/**
 * 成长史里某一刻要不要标这个区域：注记点落在那时已有的城区片区里才标（城还没长到那里时不标）
 */
export function regionShown(st: Settlement, r: SettleRegion) {
  return st.wards.some((w) => (w.inner || w.type !== 'farm') && pointInPoly(r.at, w.poly))
}
