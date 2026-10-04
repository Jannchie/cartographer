/**
 * 沙盘的地形网格与到水距离场（纯数据，在 Worker 中与体块一起构建）。
 * 取地形格网（5 米）的高程，大城隔格取样（约 15 万顶点）；水体格向下刻到水面以下，
 * 岸线与二维地图的水边一致（水面的透明度也按同一个距离场淡出）。
 */
import type { Settlement } from '../../settlement/types'

/** 水面高度（米）：水体实测都在海平面附近，河床刻在地形里 */
export const WATER_LEVEL = -0.1

export interface TerrainMesh {
  /** 顶点位置（米）、贴图坐标、法线（Int8 归一化）、三角形下标 */
  pos: Float32Array
  uv: Float32Array
  nrm: Int8Array
  idx: Uint32Array
  /** 到水距离场：128 − 4·距离（米，水中为负），0.25 米一级；W × H 与地形格网相同 */
  water: Uint8Array
}

export function terrainMesh(st: Settlement): TerrainMesh {
  const T = st.terrain
  const s = Math.max(1, Math.ceil(Math.sqrt((T.W * T.H) / 200000)))
  const GW = Math.ceil((T.W - 1) / s) + 1
  const GH = Math.ceil((T.H - 1) / s) + 1
  const pos = new Float32Array(GW * GH * 3)
  const uv = new Float32Array(GW * GH * 2)
  const hs = new Float32Array(GW * GH)
  for (let j = 0; j < GH; j++)
    for (let i = 0; i < GW; i++) {
      const ci = Math.min(T.W - 1, i * s)
      const cj = Math.min(T.H - 1, j * s)
      const c = cj * T.W + ci
      const x = Math.min(st.width, ci * T.cell)
      const z = Math.min(st.height, cj * T.cell)
      let y = T.height[c]
      if (T.water[c] < 0) y = Math.min(y, WATER_LEVEL - 0.9 - Math.min(2, -T.water[c] * 0.05))
      const k = j * GW + i
      hs[k] = y
      pos[k * 3] = x
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = z
      uv[k * 2] = x / st.width
      uv[k * 2 + 1] = 1 - z / st.height
    }
  // 法线：格网上的中心差分
  const nrm = new Int8Array(GW * GH * 3)
  const d = s * T.cell
  for (let j = 0; j < GH; j++)
    for (let i = 0; i < GW; i++) {
      const k = j * GW + i
      const dx = hs[j * GW + Math.min(GW - 1, i + 1)] - hs[j * GW + Math.max(0, i - 1)]
      const dz = hs[Math.min(GH - 1, j + 1) * GW + i] - hs[Math.max(0, j - 1) * GW + i]
      const nx = -dx / (2 * d)
      const nz = -dz / (2 * d)
      const l = Math.hypot(nx, 1, nz)
      nrm[k * 3] = Math.round((nx / l) * 127)
      nrm[k * 3 + 1] = Math.round((1 / l) * 127)
      nrm[k * 3 + 2] = Math.round((nz / l) * 127)
    }
  const idx = new Uint32Array((GW - 1) * (GH - 1) * 6)
  let n = 0
  for (let j = 0; j < GH - 1; j++)
    for (let i = 0; i < GW - 1; i++) {
      const a = j * GW + i
      idx[n++] = a
      idx[n++] = a + GW
      idx[n++] = a + 1
      idx[n++] = a + 1
      idx[n++] = a + GW
      idx[n++] = a + GW + 1
    }
  const water = new Uint8Array(T.W * T.H)
  for (let k = 0; k < water.length; k++) water[k] = Math.max(0, Math.min(255, Math.round(128 - T.water[k] * 4)))
  return { pos, uv, nrm, idx, water }
}
