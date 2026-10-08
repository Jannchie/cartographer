import type { WorldParams } from '../types'
import * as dmath from '../dmath'

/**
 * 区域图：不覆盖全球、而是用某种地图投影铺满一块区域的真实地球模板。
 * 地图格与经纬度经由投影互换（格心为整数坐标，y 向下），比例尺在区域内近似不变。
 *
 * 中国：兰勃特等角圆锥投影（双标准纬线 25°N、47°N，中央经线 105°E），中国地图的常用投影；
 * 范围从帕米尔到乌苏里江、从漠河到曾母暗沙，南海诸岛不另作附图。
 */
export type RegionId = 'china'

export interface MapProjection {
  /** 经纬度 → 地图格坐标 */
  toCell(lon: number, lat: number): [number, number]
  /** 地图格坐标 → 经纬度 */
  toLonLat(x: number, y: number): [number, number]
  /** 每格公里数 */
  kmPerCell: number
  /**
   * 图框反算到经纬度的外包范围（再留 2°）：圆锥投影会把地球另一侧的点也投进图框，
   * 河流、地物先按这个范围裁掉再投影
   */
  bounds: { lonW: number; lonE: number; latS: number; latN: number }
}

interface RegionDef {
  lon0: number
  lat1: number
  lat2: number
  /** 投影原点纬度（只影响坐标原点） */
  latO: number
  /** 投影平面上的范围（公里）：x 向东、y 向北 */
  x0: number
  x1: number
  y0: number
  y1: number
}

const R_KM = 6371.0088
const RAD = Math.PI / 180

/** 投影平面范围由 scripts/china-real.ts 按国界与断续线的外包框再留边定出 */
const REGIONS: Record<RegionId, RegionDef> = {
  china: { lon0: 105, lat1: 25, lat2: 47, latO: 30, x0: -2900, x1: 2450, y0: -3350, y1: 3000 },
}

/** 兰勃特等角圆锥投影（球面），结果单位为公里 */
function lambert(d: RegionDef) {
  const f1 = d.lat1 * RAD
  const f2 = d.lat2 * RAD
  const t = (f: number) => dmath.sin(Math.PI / 4 + f / 2) / dmath.cos(Math.PI / 4 + f / 2)
  const n = dmath.log(dmath.cos(f1) / dmath.cos(f2)) / dmath.log(t(f2) / t(f1))
  const F = (dmath.cos(f1) * dmath.pow(t(f1), n)) / n
  const rho = (f: number) => (R_KM * F) / dmath.pow(t(f), n)
  const rho0 = rho(d.latO * RAD)
  return {
    forward(lon: number, lat: number): [number, number] {
      const r = rho(lat * RAD)
      const th = n * (lon - d.lon0) * RAD
      return [r * dmath.sin(th), rho0 - r * dmath.cos(th)]
    },
    inverse(x: number, y: number): [number, number] {
      const dy = rho0 - y
      const r = Math.sign(n) * Math.sqrt(x * x + dy * dy)
      const th = dmath.atan2(x, dy)
      const lat = 2 * dmath.atan(dmath.pow((R_KM * F) / r, 1 / n)) - Math.PI / 2
      return [d.lon0 + th / n / RAD, lat / RAD]
    },
  }
}

/** 区域的投影平面（公里）与范围：数据构建脚本用来定图框与栅格窗口 */
export function regionPlane(id: RegionId) {
  const def = REGIONS[id]
  return { ...lambert(def), def }
}

/** 区域图的高度：按投影平面范围的宽高比 */
export function regionHeight(p: Pick<WorldParams, 'width' | 'region'>) {
  const d = REGIONS[p.region!]
  return Math.round((p.width * (d.y1 - d.y0)) / (d.x1 - d.x0))
}

const cache = new Map<string, MapProjection>()
/** 区域图的投影（不是区域图时为 null） */
export function regionProjection(p: Pick<WorldParams, 'width' | 'height' | 'region'>): MapProjection | null {
  if (!p.region) return null
  const key = `${p.region}:${p.width}x${p.height}`
  const have = cache.get(key)
  if (have) return have
  const d = REGIONS[p.region]
  const L = lambert(d)
  const k = (d.x1 - d.x0) / p.width
  let lonW = Infinity
  let lonE = -Infinity
  let latS = Infinity
  let latN = -Infinity
  for (let s = 0; s <= 200; s++) {
    const t = s / 200
    for (const [x, y] of [
      [d.x0 + (d.x1 - d.x0) * t, d.y0],
      [d.x0 + (d.x1 - d.x0) * t, d.y1],
      [d.x0, d.y0 + (d.y1 - d.y0) * t],
      [d.x1, d.y0 + (d.y1 - d.y0) * t],
    ]) {
      const [lon, lat] = L.inverse(x, y)
      lonW = Math.min(lonW, lon)
      lonE = Math.max(lonE, lon)
      latS = Math.min(latS, lat)
      latN = Math.max(latN, lat)
    }
  }
  const proj: MapProjection = {
    kmPerCell: k,
    bounds: { lonW: lonW - 2, lonE: lonE + 2, latS: latS - 2, latN: latN + 2 },
    toCell(lon, lat) {
      const [x, y] = L.forward(lon, lat)
      return [(x - d.x0) / k - 0.5, (d.y1 - y) / k - 0.5]
    },
    toLonLat(x, y) {
      return L.inverse(d.x0 + (x + 0.5) * k, d.y1 - (y + 0.5) * k)
    },
  }
  cache.set(key, proj)
  return proj
}

/** 区域图的名称与说明（界面、图名用） */
export const REGION_INFO: Record<RegionId, { en: string; zh: string; ja: string }> = {
  china: { en: 'China', zh: '中国', ja: '中国' },
}
