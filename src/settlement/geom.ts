/**
 * 聚落用的平面几何：单位是米，多边形为顶点数组（逆时针或顺时针均可，函数内部按需归一）。
 * 城市结构里的多边形几乎都是凸的（Voronoi 单元、半平面裁剪、直线二分），
 * 所以这里的切分与内缩只针对凸多边形实现，简单而稳健。
 */

export type P = [number, number]
export type Poly = P[]

export const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1])
export const lerpP = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
export const rot = (v: P, a: number): P => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)]
export const add = (a: P, b: P, k = 1): P => [a[0] + b[0] * k, a[1] + b[1] * k]
export const unit = (v: P): P => {
  const L = Math.hypot(v[0], v[1]) || 1
  return [v[0] / L, v[1] / L]
}
export const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]]
/** 转 90°（屏幕坐标里顺时针） */
export const perp = (u: P): P => [-u[1], u[0]]
export const neg = (u: P): P => [-u[0], -u[1]]

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
/** 多边形与凸多边形 clip 的交（逐边半平面裁剪） */
export function clipConvex(poly: Poly, clip: Poly): Poly {
  const c = centroid(clip)
  let out = poly
  for (let i = 0; i < clip.length && out.length >= 3; i++) {
    const a = clip[i]
    const b = clip[(i + 1) % clip.length]
    let n: P = [b[1] - a[1], a[0] - b[0]]
    // 法向朝外（clipHalf 保留法向反侧）
    if ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] > 0) n = [-n[0], -n[1]]
    out = clipHalf(out, a, n)
  }
  return out
}

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

/** 凸多边形向外扩 d 米（各边外移 d，相邻两边的交点是新顶点）；insetConvex 只能往里收 */
export function growConvex(poly: Poly, d: number): Poly {
  const p = orient(poly)
  const n = p.length
  // 有向面积为正（屏幕坐标顺时针）时，外法向为 (ey, -ex)
  const lines = p.map((a, i) => {
    const b = p[(i + 1) % n]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const o: P = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L]
    return { a: [a[0] + o[0] * d, a[1] + o[1] * d] as P, u: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] as P }
  })
  return p.map((_, i) => {
    const l0 = lines[(i - 1 + n) % n]
    const l1 = lines[i]
    const den = l0.u[0] * l1.u[1] - l0.u[1] * l1.u[0]
    if (Math.abs(den) < 1e-9) return l1.a
    const t = ((l1.a[0] - l0.a[0]) * l1.u[1] - (l1.a[1] - l0.a[1]) * l1.u[0]) / den
    return [l0.a[0] + l0.u[0] * t, l0.a[1] + l0.u[1] * t] as P
  })
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
  const ex = p[0] - a[0] - dx * t
  const ey = p[1] - a[1] - dy * t
  return { d: Math.sqrt(ex * ex + ey * ey), t }
}

/** 点到线段距离的平方（热路径用：不分配对象、不开方） */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const L = dx * dx + dy * dy
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = px - ax - dx * t
  const ey = py - ay - dy * t
  return ex * ex + ey * ey
}

export function polylineDist(p: P, line: P[]) {
  let best = Infinity
  const px = p[0], py = p[1]
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1]
    const d = segDist2(px, py, a[0], a[1], b[0], b[1])
    if (d < best) best = d
  }
  return Math.sqrt(best)
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
  if (line.length < 2) {
    for (let i = 0; i <= n; i++) out.push(line[0])
    return out
  }
  // 一遍走完（逐点调 pointAt 每次都从头量起，长折线上是平方级）
  let k = 0
  let acc = 0
  let seg = dist(line[0], line[1])
  for (let i = 0; i <= n; i++) {
    const s = (L * i) / n
    while (s - acc > seg && k + 2 < line.length) {
      acc += seg
      k++
      seg = dist(line[k], line[k + 1])
    }
    const t = seg ? Math.max(0, Math.min(1, (s - acc) / seg)) : 0
    out.push(lerpP(line[k], line[k + 1], t))
  }
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
    // 并列（矩形的对边给出同一个外接矩形）时留先到的：只差舍入误差的比较，结果会随坐标原点变
    if (ar < best.a * (1 - 1e-9)) {
      const uc = (u0 + u1) / 2
      const vc = (v0 + v1) / 2
      const center: P = [uc * ux - vc * uy, uc * uy + vc * ux]
      if (u1 - u0 >= v1 - v0) best = { axis: [ux, uy], len: u1 - u0, wid: v1 - v0, center, a: ar }
      else best = { axis: [-uy, ux], len: v1 - v0, wid: u1 - u0, center, a: ar }
    }
  }
  return best
}

/** 局部标架：原点 o，纵向 f，横向 l；局部坐标 (a, b) 对应地图点 o + f·a + l·b。矩形标架另有半长 hx（沿 f）、半宽 hy（沿 l） */
export interface Frame {
  o: P
  f: P
  l: P
  hx?: number
  hy?: number
}
/** 以 o 为中心、a ∈ ±hx、b ∈ ±hy 的矩形标架 */
export type RectFrame = Frame & { hx: number; hy: number }
/** 以 p 为原点、f 朝 d 的标架（l 是 d 转 90°） */
export const frameAt = (p: P, d: P, hx = 0, hy = 0): RectFrame => ({ o: p, f: d, l: perp(d), hx, hy })
/** 地图点 p 在标架里的局部坐标 (a, b) */
export const local = (F: Frame, p: P): P => {
  const d = sub(p, F.o)
  return [d[0] * F.f[0] + d[1] * F.f[1], d[0] * F.l[0] + d[1] * F.l[1]]
}
export const at = (F: Frame, a: number, b: number): P => [F.o[0] + F.f[0] * a + F.l[0] * b, F.o[1] + F.f[1] * a + F.l[1] * b]
/** 局部坐标里 a0 ~ a1、b0 ~ b1 的矩形 */
export const box = (F: Frame, a0: number, a1: number, b0: number, b1: number): Poly => [at(F, a0, b0), at(F, a1, b0), at(F, a1, b1), at(F, a0, b1)]
/** 以局部 (a, b) 为中心、沿 f 长 w、沿 l 宽 h 的矩形 */
export const cbox = (F: Frame, a: number, b: number, w: number, h: number) => box(F, a - w / 2, a + w / 2, b - h / 2, b + h / 2)
/** 多边形在标架里的范围 */
export function extent(F: Frame, poly: Poly) {
  let a0 = Infinity
  let a1 = -Infinity
  let b0 = Infinity
  let b1 = -Infinity
  for (const v of poly) {
    const a = (v[0] - F.o[0]) * F.f[0] + (v[1] - F.o[1]) * F.f[1]
    const b = (v[0] - F.o[0]) * F.l[0] + (v[1] - F.o[1]) * F.l[1]
    a0 = Math.min(a0, a)
    a1 = Math.max(a1, a)
    b0 = Math.min(b0, b)
    b1 = Math.max(b1, b)
  }
  return { a0, a1, b0, b1 }
}
/** 过地图原点、沿 e 与 n 的局部坐标 (u, v)：取点与取盒子的函数 */
export function axes(e: P, n: P = [-e[1], e[0]]) {
  const F: Frame = { o: [0, 0], f: e, l: n }
  return { e, n, at: (u: number, v: number) => at(F, u, v), box: (ua: number, ub: number, va: number, vb: number) => box(F, ua, ub, va, vb) }
}
/** 多边形在 axes(e, n) 里的包围盒 u0 ~ u1、v0 ~ v1，连同取点与取盒子的函数 */
export function localBox(poly: Poly, e: P, n: P = [-e[1], e[0]]) {
  const A = axes(e, n)
  const r = extent({ o: [0, 0], f: e, l: n }, poly)
  return { ...A, u0: r.a0, u1: r.a1, v0: r.b0, v1: r.b1 }
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
 * Voronoi 单元（逐个用平分线裁包围盒）与相邻关系。
 * 候选邻居从空间网格里由近到远一圈圈取：单元的最远顶点比下一圈还近时，更远的站点不可能再裁到它。
 * 相邻：裁完后单元上有边落在与某站点的平分线上。
 */
export function voronoiNb(sites: P[], bounds: [number, number, number, number]): { cells: Poly[]; nb: number[][] } {
  const [x0, y0, x1, y1] = bounds
  const box: Poly = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const n = sites.length
  // 网格：平均每格一两个站点
  const G = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / Math.max(1, n)) * 1.2)
  const GW = Math.max(1, Math.ceil((x1 - x0) / G))
  const GH = Math.max(1, Math.ceil((y1 - y0) / G))
  const grid: number[][] = Array.from({ length: GW * GH }, () => [])
  const cellOf = (q: P) => [Math.min(GW - 1, Math.max(0, Math.floor((q[0] - x0) / G))), Math.min(GH - 1, Math.max(0, Math.floor((q[1] - y0) / G)))]
  sites.forEach((q, i) => {
    const [gx, gy] = cellOf(q)
    grid[gy * GW + gx].push(i)
  })
  const cells: Poly[] = []
  const nb: number[][] = []
  const maxRing = Math.max(GW, GH)
  for (let i = 0; i < n; i++) {
    const s = sites[i]
    const [gx, gy] = cellOf(s)
    let cell = box
    const used: number[] = []
    for (let ring = 0; ring <= maxRing; ring++) {
      // 这一圈里的站点至少离 s (ring - 1) × G 远：单元最远顶点不到它的一半，就不必再看了
      if (ring > 1) {
        let far = 0
        for (const p of cell) far = Math.max(far, (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2)
        if (((ring - 1) * G) / 2 > Math.sqrt(far)) break
      }
      const cand: number[] = []
      for (let yy = gy - ring; yy <= gy + ring; yy++) {
        if (yy < 0 || yy >= GH) continue
        for (let xx = gx - ring; xx <= gx + ring; xx++) {
          if (xx < 0 || xx >= GW) continue
          if (Math.max(Math.abs(xx - gx), Math.abs(yy - gy)) !== ring) continue
          for (const j of grid[yy * GW + xx]) if (j !== i) cand.push(j)
        }
      }
      cand.sort((a, b) => (sites[a][0] - s[0]) ** 2 + (sites[a][1] - s[1]) ** 2 - ((sites[b][0] - s[0]) ** 2 + (sites[b][1] - s[1]) ** 2))
      for (const j of cand) {
        const t = sites[j]
        const m: P = [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2]
        const next = clipHalf(cell, m, [t[0] - s[0], t[1] - s[1]])
        if (next.length !== cell.length || next.some((p, k) => p !== cell[k])) used.push(j)
        cell = next
        if (cell.length < 3) break
      }
      if (cell.length < 3) break
    }
    cells.push(cell)
    // 相邻：单元上有两个顶点与 s、t 等距（落在平分线上）
    const list: number[] = []
    for (const j of used) {
      const t = sites[j]
      let on = 0
      for (const p of cell) if (Math.abs(dist(p, s) - dist(p, t)) < 0.05) on++
      if (on >= 2) list.push(j)
    }
    nb.push(list)
  }
  // 对称化（数值误差可能让一侧漏判）
  for (let i = 0; i < n; i++) for (const j of nb[i]) if (!nb[j].includes(i)) nb[j].push(i)
  return { cells, nb }
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
/** 两线段距离的平方，相交为 0 */
function segSegDist2(a0x: number, a0y: number, a1x: number, a1y: number, b0x: number, b0y: number, b1x: number, b1y: number) {
  const rx = a1x - a0x
  const ry = a1y - a0y
  const sx = b1x - b0x
  const sy = b1y - b0y
  const den = rx * sy - ry * sx
  if (Math.abs(den) >= 1e-12) {
    const qx = b0x - a0x
    const qy = b0y - a0y
    const t = (qx * sy - qy * sx) / den
    const u = (qx * ry - qy * rx) / den
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0
  }
  return Math.min(
    segDist2(a0x, a0y, b0x, b0y, b1x, b1y),
    segDist2(a1x, a1y, b0x, b0y, b1x, b1y),
    segDist2(b0x, b0y, a0x, a0y, a1x, a1y),
    segDist2(b1x, b1y, a0x, a0y, a1x, a1y),
  )
}

export function segSegDist(a0: P, a1: P, b0: P, b1: P): number {
  return Math.sqrt(segSegDist2(a0[0], a0[1], a1[0], a1[1], b0[0], b0[1], b1[0], b1[1]))
}

/** 线段到多边形（含内部）的距离 */
export function segPolyDist(a: P, b: P, poly: Poly): number {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return 0
  let best = Infinity
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const c = poly[i], d = poly[i + 1 === n ? 0 : i + 1]
    const v = segSegDist2(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])
    if (v < best) best = v
  }
  return Math.sqrt(best)
}

/** 凸多边形与直线 p·v = t 的交弦，在 u 方向上的区间 */
export function chord(poly: Poly, u: P, v: P, t: number): [number, number] | null {
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

/**
 * 折线的线段网格：判断点、多边形离折线是否不到 d 米，只查附近几格里的线段。
 * reach 是会用到的最大 d（线段按它扩边登记），结果与逐段全算一样。
 */
export class LineIndex {
  private segs: [P, P][] = []
  private grid = new Map<number, number[]>()
  private stamp: number[] = []
  private tick = 0
  constructor(
    line: P[],
    reach: number,
    private readonly cell = 16,
  ) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]
      const b = line[i + 1]
      const id = this.segs.length
      this.segs.push([a, b])
      this.stamp.push(0)
      this.cells(Math.min(a[0], b[0]) - reach, Math.min(a[1], b[1]) - reach, Math.max(a[0], b[0]) + reach, Math.max(a[1], b[1]) + reach, (k) => {
        const l = this.grid.get(k)
        if (l) l.push(id)
        else this.grid.set(k, [id])
      })
    }
  }
  private cells(x0: number, y0: number, x1: number, y1: number, f: (k: number) => void) {
    const c = this.cell
    for (let y = Math.floor(y0 / c); y <= Math.floor(y1 / c); y++) for (let x = Math.floor(x0 / c); x <= Math.floor(x1 / c); x++) f(y * 65536 + x)
  }
  /** 附近格子里的线段（每条只给一次） */
  private around(x0: number, y0: number, x1: number, y1: number, f: (a: P, b: P) => boolean): boolean {
    const t = ++this.tick
    let hit = false
    this.cells(x0, y0, x1, y1, (k) => {
      if (hit) return
      for (const id of this.grid.get(k) ?? []) {
        if (this.stamp[id] === t) continue
        this.stamp[id] = t
        if (f(this.segs[id][0], this.segs[id][1])) {
          hit = true
          return
        }
      }
    })
    return hit
  }
  /** 点离折线不到 d 米（d ≤ reach） */
  nearPoint(q: P, d: number) {
    return this.around(q[0], q[1], q[0], q[1], (a, b) => segDist(q, a, b).d < d)
  }
  /** 多边形离折线不到 d 米（d ≤ reach） */
  nearPoly(poly: Poly, d: number) {
    const [x0, y0, x1, y1] = bboxOf(poly)
    return this.around(x0, y0, x1, y1, (a, b) => segPolyDist(a, b, poly) < d)
  }
}
