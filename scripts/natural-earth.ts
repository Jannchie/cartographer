/**
 * 观测数据生成脚本（earth-real.ts、china-real.ts）共用的工具：计时日志与 Natural Earth GeoJSON 的读取。
 * 原始数据目录 <src> 下的 ne/*.geojson 来自 https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
 */
import { readFileSync } from 'node:fs'

/** 带经过时间的日志 */
export function timedLog() {
  const t0 = performance.now()
  return (s: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`)
}

export type Feature = { properties: Record<string, any>; geometry: { type: string; coordinates: any } | null }

/** <src>/ne/<name>.geojson 的要素 */
export const geojson = (src: string, name: string): Feature[] => JSON.parse(readFileSync(`${src}/ne/${name}.geojson`, 'utf8')).features

/** 多边形 / 多多边形 → 扁平的环（经度、纬度交替） */
export function ringsOf(f: Feature): number[][] {
  const g = f.geometry
  if (!g) return []
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
  return polys.flatMap((p: number[][][]) => p.map((r) => r.flat()))
}

/** 线 / 多线 → 扁平的折线 */
export function linesOf(f: Feature): number[][] {
  const g = f.geometry
  if (!g) return []
  if (g.type === 'LineString') return [g.coordinates.flat()]
  if (g.type === 'MultiLineString') return g.coordinates.map((l: number[][]) => l.flat())
  return []
}
