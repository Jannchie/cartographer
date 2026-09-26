/**
 * 聚落用的平面几何：单位是米，多边形为顶点数组（逆时针或顺时针均可，函数内部按需归一）。
 * 城市结构里的多边形几乎都是凸的（Voronoi 单元、半平面裁剪、直线二分），
 * 所以这里的切分与内缩只针对凸多边形实现，简单而稳健。
 */

export type P = [number, number]
export type Poly = P[]

export const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1])
export const lerpP = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** 有向面积（y 向下的屏幕坐标里，正值为顺时针） */
export function signedArea(poly: Poly) {
  let a = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}
export const area = (poly: Poly) => Math.abs(signedArea(poly))

export function centroid(poly: Poly): P {
  let cx = 0
  let cy = 0
  let a = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    const c = p[0] * q[1] - q[0] * p[1]
    a += c
    cx += (p[0] + q[0]) * c
    cy += (p[1] + q[1]) * c
  }
  if (Math.abs(a) < 1e-9) {
    // 退化：取顶点平均
    let sx = 0
    let sy = 0
    for (const p of poly) {
      sx += p[0]
      sy += p[1]
    }
    return [sx / poly.length, sy / poly.length]
  }
  return [cx / (3 * a), cy / (3 * a)]
}

export function perimeter(poly: Poly) {
  let s = 0
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length])
  return s
}

/** 统一为有向面积为正的顶点顺序 */
export function orient(poly: Poly): Poly {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly
}

/**
 * 半平面裁剪（Sutherland–Hodgman 单边）：保留 (p - o)·n ≤ 0 的部分。
 */
export function clipHalf(poly: Poly, o: P, n: P): Poly {
  const out: Poly = []
  const len = poly.length
  if (!len) return out
  const side = (p: P) => (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1]
  let prev = poly[len - 1]
  let sp = side(prev)
  for (let i = 0; i < len; i++) {
    const cur = poly[i]
    const sc = side(cur)
    if (sc <= 0) {
      if (sp > 0) out.push(lerpP(prev, cur, sp / (sp - sc)))
      out.push(cur)
    } else if (sp <= 0) out.push(lerpP(prev, cur, sp / (sp - sc)))
    prev = cur
    sp = sc
  }
  return dedupe(out)
}

/** 去掉相邻重合点 */
export function dedupe(poly: Poly, eps = 1e-6): Poly {
  const out: Poly = []
  for (const p of poly) {
    const q = out[out.length - 1]
    if (!q || Math.abs(q[0] - p[0]) > eps || Math.abs(q[1] - p[1]) > eps) out.push(p)
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= eps && Math.abs(out[0][1] - out[out.length - 1][1]) <= eps) out.pop()
  return out
}

/** 凸多边形按直线切成两半，gap 为两侧各退让的宽度之和（小巷） */
export function splitConvex(poly: Poly, o: P, dir: P, gap = 0): [Poly, Poly] {
  const L = Math.hypot(dir[0], dir[1]) || 1
  // 法向
  const n: P = [-dir[1] / L, dir[0] / L]
  const h = gap / 2
  const a = clipHalf(poly, [o[0] - n[0] * h, o[1] - n[1] * h], n)
  const b = clipHalf(poly, [o[0] + n[0] * h, o[1] + n[1] * h], [-n[0], -n[1]])
  return [a, b]
}

/**
 * 凸多边形逐边内缩：第 i 条边（poly[i] → poly[i+1]）向内退 d[i]。
 * 结果可能为空（内缩过度）。
 */
export function insetConvex(poly: Poly, d: number | number[]): Poly {
  const p = orient(poly)
  const flip = p !== poly
  let out = p
  const n = p.length
  for (let i = 0; i < n; i++) {
    // 若翻转了顶点顺序，边的序号也随之变化
    const di = typeof d === 'number' ? d : flip ? d[(n - 2 - i + n) % n] : d[i]
    if (di <= 0) continue
    const a = p[i]
    const b = p[(i + 1) % n]
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const L = Math.hypot(ex, ey)
    if (L < 1e-9) continue
    // 有向面积为正（屏幕坐标顺时针）时，外法向为 (ey, -ex)
    const nx = -ey / L
    const ny = ex / L
    // 内部方向为 (nx, ny)，保留 (x - (a + n*d))·(-n) ≤ 0
    out = clipHalf(out, [a[0] + nx * di, a[1] + ny * di], [-nx, -ny])
    if (out.length < 3) return []
  }
  return out
}

export function pointInPoly(p: P, poly: Poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** 点到线段距离及投影参数 */
export function segDist(p: P, a: P, b: P): { d: number; t: number } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L = dx * dx + dy * dy
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0
  t = Math.max(0, Math.min(1, t))
  return { d: Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t), t }
}

export function polylineDist(p: P, line: P[]) {
  let best = Infinity
  for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, segDist(p, line[i], line[i + 1]).d)
  return best
}

export function polylineLength(line: P[]) {
  let s = 0
  for (let i = 0; i + 1 < line.length; i++) s += dist(line[i], line[i + 1])
  return s
}

/** 沿折线取弧长 s 处的点与切向角 */
export function pointAt(line: P[], s: number): { p: P; angle: number } {
  for (let i = 0; i + 1 < line.length; i++) {
    const L = dist(line[i], line[i + 1])
    if (s <= L || i + 2 === line.length) {
      const t = L ? Math.max(0, Math.min(1, s / L)) : 0
      return { p: lerpP(line[i], line[i + 1], t), angle: Math.atan2(line[i + 1][1] - line[i][1], line[i + 1][0] - line[i][0]) }
    }
    s -= L
  }
  return { p: line[0], angle: 0 }
}

/** Chaikin 平滑（开折线保留端点） */
export function chaikin(line: P[], iters = 2, closed = false): P[] {
  let pts = line
  for (let k = 0; k < iters; k++) {
    const out: P[] = []
    const n = pts.length
    if (n < 3) return pts
    if (!closed) out.push(pts[0])
    const m = closed ? n : n - 1
    for (let i = 0; i < m; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      out.push(lerpP(a, b, 0.25), lerpP(a, b, 0.75))
    }
    if (!closed) out.push(pts[n - 1])
    pts = out
  }
  return pts
}

/** 按固定步长重采样折线 */
export function resample(line: P[], step: number): P[] {
  const L = polylineLength(line)
  const n = Math.max(1, Math.round(L / step))
  const out: P[] = []
  for (let i = 0; i <= n; i++) out.push(pointAt(line, (L * i) / n).p)
  return out
}

/** 最长边的序号 */
export function longestEdge(poly: Poly) {
  let best = 0
  let bl = -1
  for (let i = 0; i < poly.length; i++) {
    const l = dist(poly[i], poly[(i + 1) % poly.length])
    if (l > bl) {
      bl = l
      best = i
    }
  }
  return best
}

/**
 * 最小面积外接矩形的方向（旋转卡壳的简化版：逐边试探）。
 * 返回沿长轴的单位向量与两个方向上的跨度。
 */
export function obb(poly: Poly): { axis: P; len: number; wid: number; center: P } {
  let best = { axis: [1, 0] as P, len: 0, wid: 0, center: [0, 0] as P, a: Infinity }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const L = dist(a, b)
    if (L < 1e-6) continue
    const ux = (b[0] - a[0]) / L
    const uy = (b[1] - a[1]) / L
    let u0 = Infinity
    let u1 = -Infinity
    let v0 = Infinity
    let v1 = -Infinity
    for (const p of poly) {
      const u = p[0] * ux + p[1] * uy
      const v = -p[0] * uy + p[1] * ux
      u0 = Math.min(u0, u)
      u1 = Math.max(u1, u)
      v0 = Math.min(v0, v)
      v1 = Math.max(v1, v)
    }
    const ar = (u1 - u0) * (v1 - v0)
    if (ar < best.a) {
      const uc = (u0 + u1) / 2
      const vc = (v0 + v1) / 2
      const center: P = [uc * ux - vc * uy, uc * uy + vc * ux]
      if (u1 - u0 >= v1 - v0) best = { axis: [ux, uy], len: u1 - u0, wid: v1 - v0, center, a: ar }
      else best = { axis: [-uy, ux], len: v1 - v0, wid: u1 - u0, center, a: ar }
    }
  }
  return best
}

/** 以中心、朝向与长宽构造矩形 */
export function rect(c: P, axis: P, len: number, wid: number): Poly {
  const ux = axis[0] * (len / 2)
  const uy = axis[1] * (len / 2)
  const vx = -axis[1] * (wid / 2)
  const vy = axis[0] * (wid / 2)
  return [
    [c[0] - ux - vx, c[1] - uy - vy],
    [c[0] + ux - vx, c[1] + uy - vy],
    [c[0] + ux + vx, c[1] + uy + vy],
    [c[0] - ux + vx, c[1] - uy + vy],
  ]
}

export function circlePoly(c: P, r: number, n = 16, phase = 0): Poly {
  const out: Poly = []
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r])
  }
  return out
}

/**
 * 有界 Voronoi：每个站点的单元 = 包围盒被所有邻近站点的平分线裁剪。
 * 站点数在几百以内，按距离排序后提前终止，足够快。
 */
export function voronoi(sites: P[], bounds: [number, number, number, number]): Poly[] {
  const [x0, y0, x1, y1] = bounds
  const box: Poly = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const cells: Poly[] = []
  const order = sites.map((_, i) => i)
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    order.sort((a, b) => (sites[a][0] - s[0]) ** 2 + (sites[a][1] - s[1]) ** 2 - ((sites[b][0] - s[0]) ** 2 + (sites[b][1] - s[1]) ** 2))
    let cell = box
    for (const j of order) {
      if (j === i) continue
      const t = sites[j]
      const d = dist(s, t)
      // 单元的最远顶点都比平分线近，后面的站点不可能再裁到它
      let far = 0
      for (const p of cell) far = Math.max(far, dist(p, s))
      if (d / 2 > far) break
      const m: P = [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2]
      cell = clipHalf(cell, m, [t[0] - s[0], t[1] - s[1]])
      if (cell.length < 3) break
    }
    cells.push(cell)
  }
  return cells
}

/** 线段求交：返回参数 t（在 a 上）与 u（在 b 上），平行返回 null */
export function segIntersect(a0: P, a1: P, b0: P, b1: P): { t: number; u: number } | null {
  const rx = a1[0] - a0[0]
  const ry = a1[1] - a0[1]
  const sx = b1[0] - b0[0]
  const sy = b1[1] - b0[1]
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-12) return null
  const qx = b0[0] - a0[0]
  const qy = b0[1] - a0[1]
  return { t: (qx * sy - qy * sx) / den, u: (qx * ry - qy * rx) / den }
}

/** 点键：用于把共享顶点归并成图节点 */
export const keyOf = (p: P) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`

export type BBox = [number, number, number, number]

export function bboxOf(poly: Poly): BBox {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/**
 * 两个凸多边形是否相交（分离轴定理）。
 * tol > 0：贴边或重叠不足 tol 的不算相交；tol < 0：间距小于 |tol| 也算相交（留出空隙）。
 */
export function convexOverlap(a: Poly, b: Poly, tol = 0.05): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      let nx = q[1] - p[1]
      let ny = p[0] - q[0]
      const L = Math.hypot(nx, ny)
      if (L < 1e-9) continue
      nx /= L
      ny /= L
      let a0 = Infinity
      let a1 = -Infinity
      let b0 = Infinity
      let b1 = -Infinity
      for (const v of a) {
        const t = v[0] * nx + v[1] * ny
        if (t < a0) a0 = t
        if (t > a1) a1 = t
      }
      for (const v of b) {
        const t = v[0] * nx + v[1] * ny
        if (t < b0) b0 = t
        if (t > b1) b1 = t
      }
      if (a1 <= b0 + tol || b1 <= a0 + tol) return false
    }
  }
  return true
}

/** 两线段间的最短距离 */
export function segSegDist(a0: P, a1: P, b0: P, b1: P): number {
  const r = segIntersect(a0, a1, b0, b1)
  if (r && r.t >= 0 && r.t <= 1 && r.u >= 0 && r.u <= 1) return 0
  return Math.min(segDist(a0, b0, b1).d, segDist(a1, b0, b1).d, segDist(b0, a0, a1).d, segDist(b1, a0, a1).d)
}

/** 线段到多边形（含内部）的距离 */
export function segPolyDist(a: P, b: P, poly: Poly): number {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return 0
  let best = Infinity
  for (let i = 0; i < poly.length; i++) best = Math.min(best, segSegDist(a, b, poly[i], poly[(i + 1) % poly.length]))
  return best
}

/** 凸多边形与直线 p·v = t 的交弦，在 u 方向上的区间 */
function chord(poly: Poly, u: P, v: P, t: number): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const ta = a[0] * v[0] + a[1] * v[1]
    const tb = b[0] * v[0] + b[1] * v[1]
    if ((ta - t) * (tb - t) > 0 || ta === tb) continue
    const k = (t - ta) / (tb - ta)
    const s = (a[0] + (b[0] - a[0]) * k) * u[0] + (a[1] + (b[1] - a[1]) * k) * u[1]
    lo = Math.min(lo, s)
    hi = Math.max(hi, s)
  }
  return lo <= hi ? [lo, hi] : null
}

/**
 * 凸多边形里、沿 u 方向摆放的内接矩形（房屋的真实轮廓）。
 * 在 v 方向（u 的法向）试几种进深区间 [v0 + f0·H, v0 + f1·H]：凸多边形里，矩形在该区间内的宽度
 * 就是两端交弦的交集。取面积最大者；宽或深小于 minSide 就返回 null。
 * bands 默认从 v 最小的一侧（临街面）算起，房子贴着街。
 */
export function inscribedRect(
  poly: Poly,
  u: P,
  opts: { bands?: [number, number][]; minSide?: number; v?: P } = {},
): Poly | null {
  if (poly.length < 3) return null
  const L = Math.hypot(u[0], u[1]) || 1
  const uu: P = [u[0] / L, u[1] / L]
  const v: P = opts.v ?? [-uu[1], uu[0]]
  let v0 = Infinity
  let v1 = -Infinity
  for (const p of poly) {
    const t = p[0] * v[0] + p[1] * v[1]
    v0 = Math.min(v0, t)
    v1 = Math.max(v1, t)
  }
  const H = v1 - v0
  const minSide = opts.minSide ?? 3
  if (H < minSide) return null
  const bands = opts.bands ?? [
    [0, 1],
    [0, 0.85],
    [0, 0.7],
    [0, 0.55],
    [0, 0.4],
    [0.1, 0.9],
    [0.15, 1],
    [0.25, 0.75],
  ]
  const eps = Math.min(0.02, H * 0.001)
  let best: Poly | null = null
  let ba = 0
  for (const [f0, f1] of bands) {
    const ta = v0 + H * f0 + eps
    const tb = v0 + H * f1 - eps
    if (tb - ta < minSide) continue
    const ca = chord(poly, uu, v, ta)
    const cb = chord(poly, uu, v, tb)
    if (!ca || !cb) continue
    const s0 = Math.max(ca[0], cb[0])
    const s1 = Math.min(ca[1], cb[1])
    if (s1 - s0 < minSide) continue
    const a = (s1 - s0) * (tb - ta)
    if (a > ba) {
      ba = a
      const at = (s: number, t: number): P => [uu[0] * s + v[0] * t, uu[1] * s + v[1] * t]
      best = [at(s0, ta), at(s1, ta), at(s1, tb), at(s0, tb)]
    }
  }
  return best
}
