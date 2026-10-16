/**
 * 区域图的地形栅格（由 scripts/region-grid.ts 生成，放在 public/<区域>/grid.bin）：
 * 等经纬度 1′ 的高程与海陆湖覆盖（ETOPO 2022、Natural Earth）。气温、降水与生物群系仍取全球 5′ 栅格（real.ts）
 */
import { readPublicGz } from './real'
import type { RegionId } from './region'

export interface RegionGrid {
  W: number
  H: number
  /** 西缘经度、北缘纬度（格的外缘），格距 1′ */
  lonW: number
  latN: number
  /** 高程（公里） */
  elev: Float32Array
  cover: Uint8Array
}

const grids = new Map<RegionId, RegionGrid>()

export async function loadRegionGrid(id: RegionId): Promise<RegionGrid> {
  const have = grids.get(id)
  if (have) return have
  const buf = await readPublicGz(`${id}/grid.bin`)
  const head = new DataView(buf, 0, 28)
  if (String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3)) !== 'RGN1') throw new Error(`区域地形数据格式不对：${id}`)
  const W = head.getUint32(4, true)
  const H = head.getUint32(8, true)
  const N = W * H
  const de = new Int16Array(buf, 28, N)
  const elev = new Float32Array(N)
  for (let y = 0; y < H; y++) {
    let v = 0
    for (let x = 0; x < W; x++) {
      v += de[y * W + x]
      elev[y * W + x] = v / 1000
    }
  }
  const g = { W, H, lonW: head.getFloat64(12, true), latN: head.getFloat64(20, true), elev, cover: new Uint8Array(buf, 28 + 2 * N, N) }
  grids.set(id, g)
  return g
}

export const regionGrid = (id: RegionId) => {
  const g = grids.get(id)
  if (!g) throw new Error(`区域地形数据还没加载（先 await loadRegionGrid('${id}')）`)
  return g
}

/** 1′ 栅格在 (lon, lat) 处的高程（双线性）与覆盖（最近格） */
export function sampleRegionGrid(g: RegionGrid, lon: number, lat: number): { elev: number; cover: number } | null {
  const fx = (lon - g.lonW) * 60 - 0.5
  const fy = (g.latN - lat) * 60 - 0.5
  if (fx < 0 || fy < 0 || fx >= g.W - 1 || fy >= g.H - 1) return null
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const i = y0 * g.W + x0
  const e = g.elev
  const a = e[i] + (e[i + 1] - e[i]) * tx
  const b = e[i + g.W] + (e[i + g.W + 1] - e[i + g.W]) * tx
  return { elev: a + (b - a) * ty, cover: g.cover[Math.round(fy) * g.W + Math.round(fx)] }
}
