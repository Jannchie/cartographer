/**
 * 经纬度多边形栅格化：真实地球的数据构建（scripts/earth-real.ts）与运行时把自然地物投到地图网格都用它。
 * 网格是等经纬度的：第 x 列格心经度 lon0 + (x + 0.5)·dLon，第 y 行格心纬度 lat0 − (y + 0.5)·dLat（lat0 为上缘）。
 */
export interface LonLatGrid {
  W: number
  H: number
  lon0: number
  lat0: number
  dLon: number
  dLat: number
}

/** 全球等经纬度网格：W 列覆盖 360° 经度，H 行从 latN 到 latS */
export function lonLatGrid(W: number, H: number, latN = 90, latS = -90): LonLatGrid {
  return { W, H, lon0: -180, lat0: latN, dLon: 360 / W, dLat: (latN - latS) / H }
}

/**
 * 把一个地物的全部环（交替存储的经度、纬度，首尾不必重复）按奇偶规则填进网格：格心落在多边形内的格逐个交给 set。
 * 洞（湖中岛、环礁）按奇偶自然扣掉；跨越 ±180° 的多边形要事先切开（Natural Earth 已切好）
 */
export function fillRings(rings: ArrayLike<number>[], g: LonLatGrid, set: (i: number) => void) {
  const rows: (number[] | undefined)[] = []
  let yMin = g.H
  let yMax = -1
  for (const r of rings) {
    const n = r.length >> 1
    if (n < 3) continue
    for (let k = 0; k < n; k++) {
      const k2 = k + 1 === n ? 0 : k + 1
      const ax = r[2 * k]
      const bx = r[2 * k2]
      // 分数行号：行 y 的格心在 y 处
      const fa = (g.lat0 - r[2 * k + 1]) / g.dLat - 0.5
      const fb = (g.lat0 - r[2 * k2 + 1]) / g.dLat - 0.5
      if (fa === fb) continue
      const lo = Math.min(fa, fb)
      const hi = Math.max(fa, fb)
      // 半开区间 [lo, hi)：顶点正好落在格心行上时只算一次
      const y0 = Math.max(0, Math.ceil(lo))
      const y1 = Math.min(g.H - 1, Math.ceil(hi) - 1)
      for (let y = y0; y <= y1; y++) {
        const t = (y - fa) / (fb - fa)
        const lon = ax + t * (bx - ax)
        ;(rows[y] ??= []).push((lon - g.lon0) / g.dLon - 0.5)
      }
      if (y0 < yMin) yMin = y0
      if (y1 > yMax) yMax = y1
    }
  }
  for (let y = yMin; y <= yMax; y++) {
    const xs = rows[y]
    if (!xs) continue
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]))
      const x1 = Math.min(g.W - 1, Math.ceil(xs[k + 1]) - 1)
      for (let x = x0; x <= x1; x++) set(y * g.W + x)
    }
  }
}

/** Douglas–Peucker 化简（交替存储的坐标），tol 与坐标同单位；首尾总保留 */
export function simplifyLine(pts: ArrayLike<number>, tol: number): number[] {
  const n = pts.length >> 1
  if (n <= 2) return Array.from(pts)
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  const t2 = tol * tol
  while (stack.length) {
    const [a, b] = stack.pop()!
    const ax = pts[2 * a]
    const ay = pts[2 * a + 1]
    const dx = pts[2 * b] - ax
    const dy = pts[2 * b + 1] - ay
    const L = dx * dx + dy * dy
    let best = -1
    let bd = t2
    for (let k = a + 1; k < b; k++) {
      const px = pts[2 * k] - ax
      const py = pts[2 * k + 1] - ay
      let d: number
      if (L === 0) d = px * px + py * py
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L))
        const ex = px - t * dx
        const ey = py - t * dy
        d = ex * ex + ey * ey
      }
      if (d > bd) {
        bd = d
        best = k
      }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  const out: number[] = []
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[2 * k], pts[2 * k + 1])
  return out
}
