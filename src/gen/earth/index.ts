/**
 * 地球底图：NOAA ETOPO1 的 0.5° 高程网格（含海深，见 scripts/earth.ts）。
 * 数据有三百多 KB，只在用到地球预设时加载：生成之前先 await loadEarth()，之后 earthElevation 可同步取样。
 */
let grid: Float32Array | null = null
let W = 0
let H = 0

/** 解码数据模块：base64 → gzip 解压 → 逐行差分还原 → 公里 */
export async function loadEarth(): Promise<void> {
  if (grid) return
  const m = await import('./data')
  const bin = Uint8Array.from(atob(m.EARTH_DATA), (c) => c.charCodeAt(0))
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))
  const raw = new Int16Array(await new Response(stream).arrayBuffer())
  W = m.EARTH_W
  H = m.EARTH_H
  const g = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    let v = 0
    for (let x = 0; x < W; x++) {
      v += raw[y * W + x]
      g[y * W + x] = v / 100
    }
  }
  grid = g
}

export const earthLoaded = () => grid !== null

/**
 * 经纬度处的高程（公里，海面以下为负）：双线性插值，经度首尾相接。
 * 网格格心在纬度 89.75 − 0.5j、经度 −179.75 + 0.5i
 */
export function earthElevation(lat: number, lon: number): number {
  const g = grid
  if (!g) throw new Error('地球底图还没加载（先 await loadEarth()）')
  const fy = Math.min(H - 1, Math.max(0, (89.75 - lat) * 2))
  const fx = ((((lon + 179.75) * 2) % W) + W) % W
  const y0 = Math.floor(fy)
  const y1 = Math.min(H - 1, y0 + 1)
  const x0 = Math.floor(fx)
  const x1 = (x0 + 1) % W
  const ty = fy - y0
  const tx = fx - x0
  const a = g[y0 * W + x0] + (g[y0 * W + x1] - g[y0 * W + x0]) * tx
  const b = g[y1 * W + x0] + (g[y1 * W + x1] - g[y1 * W + x0]) * tx
  return a + (b - a) * ty
}
