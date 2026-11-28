/**
 * 构筑物的几何构件：定向的盒与梁、平滑着色的圆柱 / 圆锥 / 球面、沿折线放样的截面（城墙、院墙、栏杆）、
 * 带拱洞的墙面与拱顶（城门、桥、水门）。纯函数，不依赖 three.js 与 DOM，可在 Worker 里运行。
 * 朝向一律由"朝外的方向"决定（Writer.quadOut / triN），调用处不必操心绕向。
 */
import type { P } from '../../settlement/geom'
import { DOWN, UP, h3, type Frame, type RGB, type V3, type Writer } from './mesh'
import type { Height } from './shared'

/** 平面上的局部坐标框：原点 o，u 向与 v 向（单位向量，v 为 u 的左手法线） */
export interface Ax {
  o: P
  u: P
  v: P
}
export const axOf = (o: P, angle: number): Ax => {
  const u: P = [Math.cos(angle), Math.sin(angle)]
  return { o, u, v: [-u[1], u[0]] }
}
export const axUV = (o: P, u: P): Ax => ({ o, u, v: [-u[1], u[0]] })
/** 局部 (s, t) → 平面点 */
export const lp = (f: Ax, s: number, t: number): P => [f.o[0] + f.u[0] * s + f.v[0] * t, f.o[1] + f.u[1] * s + f.v[1] * t]

/** 框 → 屋顶的框（屋脊沿 f.v，即沿墙） */
export const roofFrame = (f: Ax, s: number, t: number, a: number, b: number): Frame => ({ c: lp(f, s, t), u: f.v, v: f.u, a, b })
/** 局部 (s, t) 与高度 y → 三维点 */
export const l3 = (f: Ax, s: number, t: number, y: number): V3 => [f.o[0] + f.u[0] * s + f.v[0] * t, y, f.o[1] + f.u[1] * s + f.v[1] * t]
/** 框平移到局部 (s, t) */
export const shift = (f: Ax, s: number, t: number): Ax => ({ o: lp(f, s, t), u: f.u, v: f.v })
/** 框转 90 度的整数倍 */
export const turn = (f: Ax, q: number): Ax => {
  let { u, v } = f
  for (let i = 0; i < ((q % 4) + 4) % 4; i++) [u, v] = [v, [-u[0], -u[1]] as P]
  return { o: f.o, u, v }
}

/** 位置哈希（0 ~ 1）：k 区分用途 */
export const hash = (x: number, z: number, k = 0) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453
  return s - Math.floor(s)
}

/**
 * 定向的盒：局部 s ∈ [s0, s1]、t ∈ [t0, t1]、y ∈ [y0, y1]；inset 为顶面四周的收进（收分的台、碑）。
 * 默认不写底面；top 为假时不写顶面
 */
export function box(w: Writer, f: Ax, s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, o: { top?: boolean; bottom?: boolean; inset?: number; topFace?: number; topCol?: RGB } = {}) {
  const d = o.inset ?? 0
  const b = [l3(f, s0, t0, y0), l3(f, s1, t0, y0), l3(f, s1, t1, y0), l3(f, s0, t1, y0)]
  const t = [l3(f, s0 + d, t0 + d, y1), l3(f, s1 - d, t0 + d, y1), l3(f, s1 - d, t1 - d, y1), l3(f, s0 + d, t1 - d, y1)]
  const outs: V3[] = [h3(f.v, -1), h3(f.u), h3(f.v), h3(f.u, -1)]
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    w.quadOut(b[i], b[j], t[j], t[i], outs[i])
  }
  if (o.top !== false) {
    const c = w.c
    const face = w.face
    if (o.topCol) w.c = o.topCol
    if (o.topFace !== undefined) w.face = o.topFace
    w.quadOut(t[0], t[1], t[2], t[3], UP)
    w.c = c
    w.face = face
  }
  if (o.bottom) w.quadOut(b[0], b[1], b[2], b[3], DOWN)
}

/** 以中心与半宽给出的盒 */
export const cbox = (w: Writer, f: Ax, hs: number, ht: number, y0: number, y1: number, o?: Parameters<typeof box>[8]) => box(w, f, -hs, hs, -ht, ht, y0, y1, o)

/**
 * 梁：沿三维线段 a → b 的矩形截面条（横向半宽 hx，另一向半宽 hy），两端封口。
 * 斜撑、桅桁、栏杆扶手、风车的帆骨这类不沿坐标轴的杆件
 */
export function beam(w: Writer, a: V3, b: V3, hx: number, hy = hx, caps = true) {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const L = Math.hypot(d[0], d[1], d[2])
  if (L < 1e-6) return
  d[0] /= L
  d[1] /= L
  d[2] /= L
  // 横向 s：水平且垂直于 d；竖直的杆取 x 轴
  let s: V3 = [-d[2], 0, d[0]]
  const sl = Math.hypot(s[0], s[2])
  s = sl < 1e-4 ? [1, 0, 0] : [s[0] / sl, 0, s[2] / sl]
  const t: V3 = [s[1] * d[2] - s[2] * d[1], s[2] * d[0] - s[0] * d[2], s[0] * d[1] - s[1] * d[0]]
  const corner = (p: V3, i: number, j: number): V3 => [p[0] + s[0] * hx * i + t[0] * hy * j, p[1] + s[1] * hx * i + t[1] * hy * j, p[2] + s[2] * hx * i + t[2] * hy * j]
  const sides: [number, number, number, number, V3][] = [
    [1, -1, 1, 1, s],
    [-1, 1, -1, -1, [-s[0], -s[1], -s[2]]],
    [1, 1, -1, 1, t],
    [-1, -1, 1, -1, [-t[0], -t[1], -t[2]]],
  ]
  for (const [i0, j0, i1, j1, out] of sides) w.quadOut(corner(a, i0, j0), corner(a, i1, j1), corner(b, i1, j1), corner(b, i0, j0), out)
  if (!caps) return
  w.quadOut(corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1), [-d[0], -d[1], -d[2]])
  w.quadOut(corner(b, -1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(b, -1, 1), d)
}

/**
 * 平滑着色的圆台侧面：底半径 r0（高 y0）、顶半径 r1（高 y1），n 棱；cap 为真时封顶面（朝上的平面）。
 * 立面坐标沿周长展开（砌体的缝绕着塔身连续）
 */
export function tube(w: Writer, c: P, r0: number, r1: number, y0: number, y1: number, n = 12, o: { cap?: boolean; arc?: [number, number]; capFace?: number; capCol?: RGB } = {}) {
  const a0 = o.arc ? o.arc[0] : 0
  const a1 = o.arc ? o.arc[1] : Math.PI * 2
  const slope = (r0 - r1) / (y1 - y0 || 1)
  const nl = Math.hypot(1, slope)
  const L = Math.max(r0, r1) * (a1 - a0)
  const pt = (a: number, r: number, y: number): V3 => [c[0] + Math.cos(a) * r, y, c[1] + Math.sin(a) * r]
  const nr = (a: number): V3 => [Math.cos(a) / nl, slope / nl, Math.sin(a) / nl]
  const uv: [number, number, number] = [0, L, y1]
  for (let i = 0; i < n; i++) {
    const b0 = a0 + ((a1 - a0) * i) / n
    const b1 = a0 + ((a1 - a0) * (i + 1)) / n
    const A0 = pt(b0, r0, y0)
    const A1 = pt(b0, r1, y1)
    const B0 = pt(b1, r0, y0)
    const B1 = pt(b1, r1, y1)
    const uA = (L * i) / n
    const uB = (L * (i + 1)) / n
    w.uvOf = (p) => ((uv[0] = p === A0 || p === A1 ? uA : uB), uv)
    const nA = nr(b0)
    const nB = nr(b1)
    w.triN(A0, B0, B1, nA, nB, nB)
    w.triN(A0, B1, A1, nA, nB, nA)
  }
  w.uvOf = null
  if (o.cap && r1 > 1e-3) {
    const col = w.c
    const face = w.face
    if (o.capCol) w.c = o.capCol
    if (o.capFace !== undefined) w.face = o.capFace
    const ctr: V3 = [c[0], y1, c[1]]
    for (let i = 0; i < n; i++) w.triOut(ctr, pt(a0 + ((a1 - a0) * i) / n, r1, y1), pt(a0 + ((a1 - a0) * (i + 1)) / n, r1, y1), UP)
    w.c = col
    w.face = face
  }
}

/** 朝下的圆环面（外挑的檐、台的底）：半径 r0 ~ r1、高 y */
export function ringUnder(w: Writer, c: P, r0: number, r1: number, y: number, n = 12) {
  const pt = (a: number, r: number): V3 => [c[0] + Math.cos(a) * r, y, c[1] + Math.sin(a) * r]
  for (let i = 0; i < n; i++) {
    const b0 = (i / n) * Math.PI * 2
    const b1 = ((i + 1) / n) * Math.PI * 2
    w.quadOut(pt(b0, r0), pt(b1, r0), pt(b1, r1), pt(b0, r1), DOWN)
  }
}

/**
 * 平滑着色的球面带：球心 c、半径 r，纬度 la0 ~ la1（弧度，0 为赤道、π/2 为顶），ky 为竖向拉伸
 */
export function ball(w: Writer, c: V3, r: number, n = 10, rings = 4, la0 = 0, la1 = Math.PI / 2, ky = 1) {
  const pt = (la: number, lo: number): V3 => [c[0] + Math.cos(lo) * Math.cos(la) * r, c[1] + Math.sin(la) * r * ky, c[2] + Math.sin(lo) * Math.cos(la) * r]
  const nr = (la: number, lo: number): V3 => {
    const x = Math.cos(lo) * Math.cos(la)
    const y = Math.sin(la) / ky
    const z = Math.sin(lo) * Math.cos(la)
    const l = Math.hypot(x, y, z) || 1
    return [x / l, y / l, z / l]
  }
  for (let j = 0; j < rings; j++) {
    const l0 = la0 + ((la1 - la0) * j) / rings
    const l1 = la0 + ((la1 - la0) * (j + 1)) / rings
    for (let i = 0; i < n; i++) {
      const b0 = (i / n) * Math.PI * 2
      const b1 = ((i + 1) / n) * Math.PI * 2
      w.triN(pt(l0, b0), pt(l0, b1), pt(l1, b1), nr(l0, b0), nr(l0, b1), nr(l1, b1))
      w.triN(pt(l0, b0), pt(l1, b1), pt(l1, b0), nr(l0, b0), nr(l1, b1), nr(l1, b0))
    }
  }
}

/** 四棱锥（塔尖、碑帽、雉堞的尖顶）：底面为框里的矩形，尖在中心上方 h */
export function pyramid(w: Writer, f: Ax, hs: number, ht: number, y: number, h: number) {
  const b = [l3(f, -hs, -ht, y), l3(f, hs, -ht, y), l3(f, hs, ht, y), l3(f, -hs, ht, y)]
  const apex = l3(f, 0, 0, y + h)
  const outs: V3[] = [
    [-f.v[0], 0.5, -f.v[1]],
    [f.u[0], 0.5, f.u[1]],
    [f.v[0], 0.5, f.v[1]],
    [-f.u[0], 0.5, -f.u[1]],
  ]
  for (let i = 0; i < 4; i++) w.triOut(b[i], b[(i + 1) % 4], apex, outs[i])
}

// —————————————————————— 沿折线放样 ——————————————————————

/** 放样路径上的一站：位置、斜接方向（左手法线的角平分线）与放大系数、沿程、地面高与墙脚高 */
export interface Station {
  p: P
  n: P
  k: number
  s: number
  g: number
  lo: number
}
/** 截面里的"墙脚"：取该站的 lo（埋入地下的高度） */
export const LO = -1e6

/**
 * 折线 → 一串站：按 step 米加密，转角斜接（尖角限长）。closed 时首尾相接（末尾补一站与首站重合）。
 * 地面高取中线处，墙脚取中线与两侧 half 处的最低点再往下埋 bury 米。
 * 给了 coarse 时先按 coarse 米分段，只有地面偏离直线超过 0.2 米的边才按 step 加密（平地上的长墙不白白多切）
 */
export function stationsOf(path: P[], closed: boolean, step: number, H: Height, half: number, bury = 1, coarse = 0): Station[] {
  const src: P[] = []
  for (const p of path) if (!src.length || Math.hypot(p[0] - src[src.length - 1][0], p[1] - src[src.length - 1][1]) > 0.05) src.push(p)
  if (closed && src.length > 2 && Math.hypot(src[0][0] - src[src.length - 1][0], src[0][1] - src[src.length - 1][1]) < 0.05) src.pop()
  if (src.length < 2) return []
  const pts: P[] = []
  const m = closed ? src.length : src.length - 1
  for (let i = 0; i < m; i++) {
    const a = src[i]
    const b = src[(i + 1) % src.length]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    let segs = Math.max(1, Math.ceil(L / step))
    if (coarse > step) {
      const few = Math.max(1, Math.ceil(L / coarse))
      // 按细分的各点检查地面是否偏离粗分段的连线
      let flat = true
      let h0 = H(a[0], a[1])
      for (let k = 0; k < few && flat; k++) {
        const t1 = (k + 1) / few
        const h1 = H(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
        const sub = Math.max(2, Math.ceil(L / few / step))
        for (let j = 1; j < sub; j++) {
          const t = (k + j / sub) / few
          if (Math.abs(H(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) - (h0 + ((h1 - h0) * j) / sub)) > 0.2) {
            flat = false
            break
          }
        }
        h0 = h1
      }
      if (flat) segs = few
    }
    for (let s = 0; s < segs; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / segs, a[1] + ((b[1] - a[1]) * s) / segs])
  }
  if (!closed) pts.push(src[src.length - 1])
  const N = pts.length
  const segN = (i: number): P | null => {
    // 第 i 段（pts[i] → pts[i + 1]）的左手法线
    if (!closed && (i < 0 || i >= N - 1)) return null
    const a = pts[((i % N) + N) % N]
    const b = pts[(((i + 1) % N) + N) % N]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]
  }
  const out: Station[] = []
  let s = 0
  for (let i = 0; i < N; i++) {
    const n0 = segN(i - 1)
    const n1 = segN(i)
    const a = n0 ?? n1!
    const b = n1 ?? n0!
    let mx = a[0] + b[0]
    let mz = a[1] + b[1]
    const ml = Math.hypot(mx, mz)
    if (ml < 1e-6) {
      mx = a[0]
      mz = a[1]
    } else {
      mx /= ml
      mz /= ml
    }
    const k = Math.min(2.2, 1 / Math.max(0.3, mx * a[0] + mz * a[1]))
    const p = pts[i]
    if (i > 0) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1])
    const g = H(p[0], p[1])
    const lo = Math.min(g, H(p[0] + mx * half, p[1] + mz * half), H(p[0] - mx * half, p[1] - mz * half)) - bury
    out.push({ p, n: [mx, mz], k, s, g, lo })
  }
  if (closed) {
    const f = out[0]
    out.push({ ...f, s: s + Math.hypot(f.p[0] - pts[N - 1][0], f.p[1] - pts[N - 1][1]) })
  }
  return out
}

/** 站上偏移 off 处的平面点 */
export const stOff = (st: Station, off: number): P => [st.p[0] + st.n[0] * off * st.k, st.p[1] + st.n[1] * off * st.k]
const stPos = (st: Station, off: number, y: number): V3 => [st.p[0] + st.n[0] * off * st.k, y === LO ? st.lo : st.g + y, st.p[1] + st.n[1] * off * st.k]

/**
 * 截面沿各站放样。截面是 (偏移, 相对地面的高度) 的折线，按"外侧在行进方向右手"的顺序给出
 *（外墙脚 → 外墙顶 → 内墙顶 → 内墙脚，即偏移向右、高度向上时的逆时针）；高度取 LO 时落到墙脚。
 * cols / faces 逐边给颜色与材质（缺省沿用当前的）；caps 为真时两端按凸多边形封口。
 * 近乎竖直的面带沿程的立面坐标（砌体的缝沿墙连续）
 */
export function sweep(w: Writer, sts: Station[], prof: [number, number][], o: { cols?: (RGB | undefined)[]; faces?: (number | undefined)[]; caps?: boolean | 'start' | 'end'; loop?: boolean; chunk?: boolean } = {}) {
  if (sts.length < 2) return
  const col0 = w.c
  const face0 = w.face
  const total = sts[sts.length - 1].s
  const edges = o.loop ? prof.length : prof.length - 1
  const top = Math.max(...prof.map((q) => (q[1] === LO ? -1e9 : q[1])))
  const uv: [number, number, number] = [0, total, 0]
  for (let i = 0; i + 1 < sts.length; i++) {
    const A = sts[i]
    const B = sts[i + 1]
    const dx = B.p[0] - A.p[0]
    const dz = B.p[1] - A.p[1]
    const L = Math.hypot(dx, dz) || 1
    const nx = -dz / L
    const nz = dx / L
    if (o.chunk !== false) w.at(A.p[0], A.p[1])
    uv[2] = Math.min(A.g, B.g) + top
    for (let e = 0; e < edges; e++) {
      const p0 = prof[e]
      const p1 = prof[(e + 1) % prof.length]
      const y0 = p0[1] === LO ? -3 : p0[1]
      const y1 = p1[1] === LO ? -3 : p1[1]
      // 截面边的右手法线（偏移向, 高度向）
      const eo = y1 - y0
      const ey = -(p1[0] - p0[0])
      const el = Math.hypot(eo, ey) || 1
      w.c = o.cols?.[e] ?? col0
      w.face = o.faces?.[e] ?? face0
      w.uvOf = Math.abs(ey / el) < 0.5 ? (p) => ((uv[0] = A.s + ((p[0] - A.p[0]) * dx + (p[2] - A.p[1]) * dz) / L), uv) : null
      w.quadOut(stPos(A, p0[0], p0[1]), stPos(B, p0[0], p0[1]), stPos(B, p1[0], p1[1]), stPos(A, p1[0], p1[1]), [(nx * eo) / el, ey / el, (nz * eo) / el])
    }
  }
  w.uvOf = null
  w.c = col0
  w.face = face0
  const cap = (st: Station, other: Station) => {
    const out: V3 = [st.p[0] - other.p[0], 0, st.p[1] - other.p[1]]
    const ps = prof.map((q) => stPos(st, q[0], q[1]))
    for (let i = 1; i + 1 < ps.length; i++) w.triOut(ps[0], ps[i], ps[i + 1], out)
  }
  if (o.caps === true || o.caps === 'start') cap(sts[0], sts[1])
  if (o.caps === true || o.caps === 'end') cap(sts[sts.length - 1], sts[sts.length - 2])
}

/**
 * 雉堞：沿各站偏移 off 的线立垛。垛长 len、垛口 gap、高 h，自偏移线向 −sign(off) 一侧厚 depth；
 * y 为垛脚相对地面的高度（垛脚、垛顶随坡度倾斜，与女墙顶贴合）。cap 为 'point' 时垛顶加四棱锥
 */
export function crenels(w: Writer, sts: Station[], off: number, y: number, len: number, gap: number, h: number, depth: number, cap: 'flat' | 'point' = 'flat') {
  const sg = off >= 0 ? -1 : 1
  for (let i = 0; i + 1 < sts.length; i++) {
    const A = sts[i]
    const B = sts[i + 1]
    const a = stOff(A, off)
    const b = stOff(B, off)
    const a2 = stOff(A, off + sg * depth)
    const b2 = stOff(B, off + sg * depth)
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.round(L / (len + gap)))
    const per = L / n
    const hl = Math.min(len, per * 0.72) / 2
    if (L < 0.6) continue
    // 偏移线的左手法线朝 +off 一侧；垛的外面朝 +sign(off)
    const side: V3 = off >= 0 ? [-(b[1] - a[1]), 0, b[0] - a[0]] : [b[1] - a[1], 0, -(b[0] - a[0])]
    const along: V3 = [b[0] - a[0], 0, b[1] - a[1]]
    w.at(a[0], a[1])
    for (let k = 0; k < n; k++) {
      const t0 = ((k + 0.5) * per - hl) / L
      const t1 = ((k + 0.5) * per + hl) / L
      const q = (p: P, r: P, t: number, dy: number): V3 => [p[0] + (r[0] - p[0]) * t, A.g + (B.g - A.g) * t + y + dy, p[1] + (r[1] - p[1]) * t]
      const o0 = q(a, b, t0, 0)
      const o1 = q(a, b, t1, 0)
      const i0 = q(a2, b2, t0, 0)
      const i1 = q(a2, b2, t1, 0)
      const O0 = q(a, b, t0, h)
      const O1 = q(a, b, t1, h)
      const I0 = q(a2, b2, t0, h)
      const I1 = q(a2, b2, t1, h)
      w.quadOut(o0, o1, O1, O0, side)
      w.quadOut(i0, i1, I1, I0, [-side[0], 0, -side[2]])
      w.quadOut(o0, i0, I0, O0, [-along[0], 0, -along[2]])
      w.quadOut(o1, i1, I1, O1, along)
      if (cap === 'flat') w.quadOut(O0, O1, I1, I0, UP)
      else {
        const apex: V3 = [(O0[0] + O1[0] + I0[0] + I1[0]) / 4, (O0[1] + O1[1]) / 2 + Math.min(depth, hl * 2) * 0.55, (O0[2] + O1[2] + I0[2] + I1[2]) / 4]
        w.triOut(O0, O1, apex, [side[0], Math.hypot(side[0], side[2]), side[2]])
        w.triOut(I0, I1, apex, [-side[0], Math.hypot(side[0], side[2]), -side[2]])
        w.triOut(O0, I0, apex, [-along[0], Math.hypot(along[0], along[2]), -along[2]])
        w.triOut(O1, I1, apex, [along[0], Math.hypot(along[0], along[2]), along[2]])
      }
    }
  }
}

// —————————————————————— 拱 ——————————————————————

export type ArchShape = 'round' | 'pointed' | 'segmental' | 'horseshoe' | 'flat'

/**
 * 拱洞的轮廓：自左脚到右脚的折线（x 相对洞的中线、向右；y 相对洞底、向上），含两侧直壁。
 * hw 半宽，spring 起拱线高度；segmental 的矢高由 rise 给出。返回的折线左右对称
 */
export function archOutline(shape: ArchShape, hw: number, spring: number, n = 10, rise = hw * 0.4): [number, number][] {
  const pts: [number, number][] = [[-hw, 0]]
  if (shape === 'flat') {
    pts.push([-hw, spring], [hw, spring])
  } else if (shape === 'round') {
    for (let i = 0; i <= n; i++) {
      const a = Math.PI * (1 - i / n)
      pts.push([Math.cos(a) * hw, spring + Math.sin(a) * hw])
    }
  } else if (shape === 'pointed') {
    // 两心尖拱：圆心在起拱线上、偏向对侧，半径 1.25 倍半宽
    const R = hw * 1.25
    const a1 = Math.acos((R - hw) / R)
    const m = Math.max(2, Math.ceil(n / 2))
    for (let i = 0; i <= m; i++) {
      const a = Math.PI - (a1 * i) / m
      pts.push([R - hw + Math.cos(a) * R, spring + Math.sin(a) * R])
    }
    for (let i = m - 1; i >= 0; i--) {
      const a = Math.PI - (a1 * i) / m
      pts.push([-(R - hw + Math.cos(a) * R), spring + Math.sin(a) * R])
    }
  } else if (shape === 'segmental') {
    const R = (hw * hw + rise * rise) / (2 * rise)
    const a0 = Math.asin(Math.min(1, hw / R))
    for (let i = 0; i <= n; i++) {
      const a = -a0 + (2 * a0 * i) / n
      pts.push([Math.sin(a) * R, spring + rise - R + Math.cos(a) * R])
    }
  } else {
    // 马蹄拱：圆心高于起拱线，圆弧在起拱线处向内收到洞宽
    const R = hw * 1.16
    const d = Math.sqrt(R * R - hw * hw)
    const a0 = Math.atan2(-d, -hw)
    const a1 = Math.atan2(-d, hw)
    // 自左下（a0，第三象限）经顶到右下（a1，第四象限）：角度递减
    const span = a0 + Math.PI * 2 - a1
    for (let i = 0; i <= n + 2; i++) {
      const a = a0 + Math.PI * 2 - (span * i) / (n + 2)
      pts.push([Math.cos(a) * R, spring + d + Math.sin(a) * R])
    }
  }
  pts.push([hw, 0])
  return pts
}

/** 一处洞口：轮廓为墙面坐标（x 沿墙面、y 为绝对高度）的折线，首尾落在墙面的底边上 */
export type Opening = [number, number][]
/** 把 archOutline 的轮廓放到墙面上：中线在 cx、洞底在 y0 */
export const placeArch = (pts: [number, number][], cx: number, y0: number): Opening => pts.map(([x, y]) => [cx + x, y0 + y])

/**
 * 带洞口的竖直墙面：墙面在过 o、沿 e（单位向量）的竖直面上，范围 x ∈ [x0, x1]，自底 yb 到顶 top(x)。
 * 洞口按 x 从小到大给出、互不重叠。洞口轮廓里 x 回折的部分（马蹄拱起拱线以下的收口）按水平条带补面，其余按竖直条带接到墙顶。
 * out 为墙面朝外的方向（水平）；step 为条带的最大宽度（墙顶是曲线时加密）
 */
export function archFace(w: Writer, o: P, e: P, x0: number, x1: number, yb: number, top: (x: number) => number, holes: Opening[], out: P, step = 1e9) {
  const out3 = h3(out)
  const P3 = (x: number, y: number): V3 => [o[0] + e[0] * x, y, o[1] + e[1] * x]
  const yTop = Math.max(top(x0), top(x1), top((x0 + x1) / 2))
  const uv: [number, number, number] = [0, x1 - x0, yTop]
  w.uvOf = (p) => ((uv[0] = (p[0] - o[0]) * e[0] + (p[2] - o[1]) * e[1] - x0), uv)
  // 墙体的下边界：底边 + 各洞口轮廓里 x 单调的那一段
  const lower: [number, number][] = [[x0, yb]]
  for (const h of holes) {
    let iL = 0
    let iR = 0
    for (let i = 0; i < h.length; i++) {
      if (h[i][0] < h[iL][0] - 1e-6) iL = i
      if (h[i][0] >= h[iR][0] - 1e-6) iR = i
    }
    const xl = h[iL][0]
    const xr = h[iR][0]
    // 左右两侧回折的部分：水平条带接到 x = xl / xr
    for (let i = 0; i < iL; i++) w.quadOut(P3(xl, h[i][1]), P3(h[i][0], h[i][1]), P3(h[i + 1][0], h[i + 1][1]), P3(xl, h[i + 1][1]), out3)
    for (let i = iR; i + 1 < h.length; i++) w.quadOut(P3(xr, h[i][1]), P3(h[i][0], h[i][1]), P3(h[i + 1][0], h[i + 1][1]), P3(xr, h[i + 1][1]), out3)
    lower.push([xl, yb])
    for (let i = iL; i <= iR; i++) lower.push(h[i])
    lower.push([xr, yb])
  }
  lower.push([x1, yb])
  for (let i = 0; i + 1 < lower.length; i++) {
    const [xa, ya] = lower[i]
    const [xb, yb2] = lower[i + 1]
    if (xb - xa < 1e-6) continue
    const segs = Math.max(1, Math.ceil((xb - xa) / step))
    for (let k = 0; k < segs; k++) {
      const u0 = xa + ((xb - xa) * k) / segs
      const u1 = xa + ((xb - xa) * (k + 1)) / segs
      const v0 = ya + ((yb2 - ya) * k) / segs
      const v1 = ya + ((yb2 - ya) * (k + 1)) / segs
      w.quadOut(P3(u0, v0), P3(u1, v1), P3(u1, top(u1)), P3(u0, top(u0)), out3)
    }
  }
  w.uvOf = null
}

/**
 * 洞口的内壁与拱顶：轮廓自墙面（过 o、沿 e）沿 d（水平向量，长度即进深）拉到对面，法线朝洞内、沿拱平滑。
 * 轮廓里超过约 40 度的折角（直壁与平梁相接、尖拱的顶）保持硬边
 */
export function vault(w: Writer, o: P, e: P, d: P, hole: Opening) {
  const D = Math.hypot(d[0], d[1]) || 1
  const n = hole.length
  // 各段朝洞内的法线（行进方向的右手法线）
  const sn: [number, number][] = []
  for (let i = 0; i + 1 < n; i++) {
    const dx = hole[i + 1][0] - hole[i][0]
    const dy = hole[i + 1][1] - hole[i][1]
    const l = Math.hypot(dx, dy) || 1
    sn.push([dy / l, -dx / l])
  }
  const vn = (seg: number, other: number): V3 => {
    let nx = sn[seg][0]
    let ny = sn[seg][1]
    if (other >= 0 && other < sn.length && sn[seg][0] * sn[other][0] + sn[seg][1] * sn[other][1] > 0.76) {
      nx += sn[other][0]
      ny += sn[other][1]
      const l = Math.hypot(nx, ny) || 1
      nx /= l
      ny /= l
    }
    return [e[0] * nx, ny, e[1] * nx]
  }
  const uv: [number, number, number] = [0, D, 0]
  for (let i = 0; i + 1 < n; i++) {
    const a = hole[i]
    const b = hole[i + 1]
    const A0: V3 = [o[0] + e[0] * a[0], a[1], o[1] + e[1] * a[0]]
    const B0: V3 = [o[0] + e[0] * b[0], b[1], o[1] + e[1] * b[0]]
    const A1: V3 = [A0[0] + d[0], a[1], A0[2] + d[1]]
    const B1: V3 = [B0[0] + d[0], b[1], B0[2] + d[1]]
    const na = vn(i, i - 1)
    const nb = vn(i, i + 1)
    uv[2] = Math.max(a[1], b[1])
    w.uvOf = (p) => ((uv[0] = p === A0 || p === B0 ? 0 : D), uv)
    w.triN(A0, B0, B1, na, nb, nb)
    w.triN(A0, B1, A1, na, nb, na)
  }
  w.uvOf = null
}

/**
 * 拱圈：贴在墙面外、沿洞口轮廓的一圈凸出的券石（宽 wd、凸出 pr），只做起拱线以上的部分（from 为轮廓里起拱点的下标）。
 * 外沿的收边与正面各一条带
 */
export function archRing(w: Writer, o: P, e: P, out: P, hole: Opening, wd: number, pr: number, from = 1, to = hole.length - 2) {
  const P3 = (x: number, y: number, k: number): V3 => [o[0] + e[0] * x + out[0] * k, y, o[1] + e[1] * x + out[1] * k]
  const out3 = h3(out)
  // 轮廓各点向洞外的法线
  const nrm = (i: number): [number, number] => {
    const a = hole[Math.max(from, i - 1)]
    const b = hole[Math.min(to, i + 1)]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    return [-dy / l, dx / l]
  }
  for (let i = from; i < to; i++) {
    const a = hole[i]
    const b = hole[i + 1]
    const na = nrm(i)
    const nb = nrm(i + 1)
    const ao: [number, number] = [a[0] + na[0] * wd, a[1] + na[1] * wd]
    const bo: [number, number] = [b[0] + nb[0] * wd, b[1] + nb[1] * wd]
    w.quadOut(P3(a[0], a[1], pr), P3(b[0], b[1], pr), P3(bo[0], bo[1], pr), P3(ao[0], ao[1], pr), out3)
    const mid: V3 = [e[0] * (na[0] + nb[0]), na[1] + nb[1], e[1] * (na[0] + nb[0])]
    w.quadOut(P3(ao[0], ao[1], 0), P3(bo[0], bo[1], 0), P3(bo[0], bo[1], pr), P3(ao[0], ao[1], pr), mid)
    w.quadOut(P3(a[0], a[1], 0), P3(b[0], b[1], 0), P3(b[0], b[1], pr), P3(a[0], a[1], pr), [-mid[0], -mid[1], -mid[2]])
  }
  // 两脚的收头
  for (const i of [from, to]) {
    const a = hole[i]
    const na = nrm(i)
    w.quadOut(P3(a[0], a[1], 0), P3(a[0] + na[0] * wd, a[1] + na[1] * wd, 0), P3(a[0] + na[0] * wd, a[1] + na[1] * wd, pr), P3(a[0], a[1], pr), DOWN)
  }
}

/** 凸多边形（三维点）按扇形三角化，朝向 out */
export function fan(w: Writer, ps: V3[], out: V3) {
  for (let i = 1; i + 1 < ps.length; i++) w.triOut(ps[0], ps[i], ps[i + 1], out)
}

/**
 * 放样曲面：rows 为一排排的点（各排点数相同），按网格连成四边形，法线取网格的平滑法线、朝离开 center 的一侧。
 * double 为真时正反两面都写（帆这类薄片）；coordOf 给出立面坐标（木板缝、条纹的方向）
 */
export function loft(w: Writer, rows: V3[][], center: V3, o: { double?: boolean; coordOf?: (i: number, j: number) => readonly [number, number, number] } = {}) {
  const R = rows.length
  const C = rows[0].length
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const nrm: V3[][] = rows.map((row, i) =>
    row.map((p, j) => {
      const du = sub(rows[Math.min(R - 1, i + 1)][j], rows[Math.max(0, i - 1)][j])
      const dv = sub(row[Math.min(C - 1, j + 1)], row[Math.max(0, j - 1)])
      let n: V3 = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]]
      let l = Math.hypot(n[0], n[1], n[2])
      if (l < 1e-9) {
        n = sub(p, center)
        l = Math.hypot(n[0], n[1], n[2]) || 1
      }
      n = [n[0] / l, n[1] / l, n[2] / l]
      const d = sub(p, center)
      return n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0 ? [-n[0], -n[1], -n[2]] : n
    }),
  )
  const neg = (n: V3): V3 => [-n[0], -n[1], -n[2]]
  for (let i = 0; i + 1 < R; i++)
    for (let j = 0; j + 1 < C; j++) {
      const a = rows[i][j]
      const b = rows[i + 1][j]
      const c2 = rows[i + 1][j + 1]
      const d = rows[i][j + 1]
      if (o.coordOf) {
        const ca = o.coordOf(i, j)
        const cb = o.coordOf(i + 1, j)
        const cc = o.coordOf(i + 1, j + 1)
        const cd = o.coordOf(i, j + 1)
        w.uvOf = (p) => (p === a ? ca : p === b ? cb : p === c2 ? cc : cd)
      }
      w.triN(a, b, c2, nrm[i][j], nrm[i + 1][j], nrm[i + 1][j + 1])
      w.triN(a, c2, d, nrm[i][j], nrm[i + 1][j + 1], nrm[i][j + 1])
      if (o.double) {
        w.triN(a, b, c2, neg(nrm[i][j]), neg(nrm[i + 1][j]), neg(nrm[i + 1][j + 1]))
        w.triN(a, c2, d, neg(nrm[i][j]), neg(nrm[i + 1][j + 1]), neg(nrm[i][j + 1]))
      }
    }
  w.uvOf = null
}
