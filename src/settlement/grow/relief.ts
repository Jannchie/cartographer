import { hash3 } from '../../gen/rng'
import { smoothstep } from '../../gen/util'
import { retouchTerrain, type TerrainResult } from '../terrain'
import type { GrowP, GrowStroke } from './api'

// 手动改地形的笔画落到网格上（规则一句一条；只用加减乘除、开方与哈希，同样的笔画逐位同样的结果）：
//   - 一笔 = 沿折线（一个点时是一个圆）半径 r 以内的格子；离折线越远改得越少。
//   - raise / lower：陆地抬高 / 压低，一笔最多 AMOUNT × r 米（至少 MIN_AMOUNT）；压低不低过 LAND_MIN（不会压出水来，水面用 water 挖）。
//   - flat：陆地压到起笔处的高程，笔刷的里一半完全压平、往外过渡回原来的地形。
//   - water：挖成水面；岸线按位置哈希进退 SHORE × r（不是一条圆滑的胶囊边）。水面在海拔 0：岸外的地面压成从岸边起坡度 BANK_SLOPE 的缓坡
//     （高地上挖水会带出一圈河谷，最远到岸外 BANK 米；本来就低的地不动），不留悬崖。
//   - land：水面填成刚出水的平地（河、海都可以填）。
//   - 抬高、压低、平整不碰水面。

const AMOUNT = 0.08
const MIN_AMOUNT = 1.5
/** 陆地最低的高程（米；海面是 0） */
const LAND_MIN = 0.2
/** 填出来的陆地、岸边的高程 */
const SHORE_H = 0.6
/** 岸线进退的幅度（× r）与起伏的尺度（米） */
const SHORE = 0.22
const SHORE_SCALE = 18
/** 岸外的缓坡：最远压到多远（米）、坡度 */
const BANK = 240
const BANK_SLOPE = 0.05

export interface Grid {
  W: number
  H: number
  cell: number
  height: Float32Array
  /** 1 为水 */
  wet: Uint8Array
}

/** 位置哈希的双线性插值（0 ~ 1），尺度 SHORE_SCALE 米 */
function wobble(x: number, y: number) {
  const fx = x / SHORE_SCALE
  const fy = y / SHORE_SCALE
  const i = Math.floor(fx)
  const j = Math.floor(fy)
  const tx = smoothstep(0, 1, fx - i)
  const ty = smoothstep(0, 1, fy - j)
  const a = hash3(i, j, 613)
  const b = hash3(i + 1, j, 613)
  const c = hash3(i, j + 1, 613)
  const d = hash3(i + 1, j + 1, 613)
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/** 点到折线的距离（一个点的折线就是到那个点） */
function distTo(pts: GrowP[], x: number, y: number) {
  let best = Infinity
  if (pts.length === 1) return Math.sqrt((x - pts[0][0]) * (x - pts[0][0]) + (y - pts[0][1]) * (y - pts[0][1]))
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0]
    const ay = pts[i][1]
    const dx = pts[i + 1][0] - ax
    const dy = pts[i + 1][1] - ay
    const L = dx * dx + dy * dy
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0
    const ex = x - ax - dx * t
    const ey = y - ay - dy * t
    const d = ex * ex + ey * ey
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

/**
 * 在 from（原地形 base 已经叠过前几笔的样子；一笔没叠过就是 base 自己）上接着叠几笔，不改传入的地形。
 * 接着上一份叠和从 base 起一次叠完逐位相同：水面就是水距为负的格子，海面只按 base 认（见 retouchTerrain）
 */
export function reliefTerrain(base: TerrainResult, strokes: readonly GrowStroke[], from: TerrainResult = base): TerrainResult {
  if (!strokes.length) return from
  const { W, H, cell, water } = from.terrain
  const height = from.terrain.height.slice()
  const wet = new Uint8Array(W * H)
  for (let k = 0; k < W * H; k++) wet[k] = water[k] < 0 ? 1 : 0
  let changed = false
  for (const st of strokes) changed = applyStroke({ W, H, cell, height, wet }, st) || changed
  return retouchTerrain(from, height, changed ? wet : null, base)
}

/** 把一笔落到网格上（原地改 height、wet）；返回水面有没有变 */
export function applyStroke(g: Grid, st: GrowStroke): boolean {
  const { W, H, cell, height, wet } = g
  const pts = st.pts
  if (!pts.length) return false
  const r = st.r
  const shaping = st.tool === 'water' || st.tool === 'land'
  const bank = st.tool === 'water' ? BANK : 0
  const reach = r * (shaping ? 1 + SHORE : 1) + bank
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const i0 = Math.max(0, Math.floor((x0 - reach) / cell))
  const i1 = Math.min(W - 1, Math.ceil((x1 + reach) / cell))
  const j0 = Math.max(0, Math.floor((y0 - reach) / cell))
  const j1 = Math.min(H - 1, Math.ceil((y1 + reach) / cell))
  const amount = Math.max(MIN_AMOUNT, AMOUNT * r)
  // 平整的目标：起笔处那一格的高程
  const ci = Math.min(W - 1, Math.max(0, Math.round(pts[0][0] / cell)))
  const cj = Math.min(H - 1, Math.max(0, Math.round(pts[0][1] / cell)))
  const target = Math.max(LAND_MIN, height[cj * W + ci])
  let changed = false
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = j * W + i
      const x = i * cell
      const y = j * cell
      let d = distTo(pts, x, y)
      if (d >= reach) continue
      if (shaping) {
        d += (wobble(x, y) - 0.5) * 2 * SHORE * r
        if (st.tool === 'water') {
          if (d < r) {
            if (!wet[k]) changed = true
            wet[k] = 1
            height[k] = Math.min(height[k], -0.4 - 1.2 * (1 - Math.max(0, d) / r))
          } else if (!wet[k] && d < r + bank) height[k] = Math.min(height[k], SHORE_H + (d - r) * BANK_SLOPE)
        } else if (d < r && wet[k]) {
          changed = true
          wet[k] = 0
          height[k] = Math.max(height[k], SHORE_H)
        }
        continue
      }
      if (wet[k] || d >= r) continue
      if (st.tool === 'flat') {
        const f = smoothstep(0, 1, (1 - d / r) * 2)
        height[k] = height[k] * (1 - f) + target * f
      } else {
        const f = smoothstep(0, 1, 1 - d / r)
        height[k] = st.tool === 'raise' ? height[k] + amount * f : Math.max(LAND_MIN, height[k] - amount * f)
      }
    }
  return changed
}
