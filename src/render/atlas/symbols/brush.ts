/**
 * 【实验】符号套原型的笔画工具：只用 Pen（glyphBatch.ts）那一小部分 Canvas 接口，
 * 位图与矢量（Recorder）都能回放。带 add 前缀的函数只往当前路径里追加子路径，不 beginPath、不 fill / stroke，
 * 便于把许多同样式的笔并成一条路径。
 */
import { hash } from '../fields'
import type { Pen } from '../glyphBatch'

export type P = [number, number]

/** 按种子派生的随机数：r(i) 是第 i 个随机量（0~1），同一种子同一序号结果不变 */
export const rnd = (seed: number) => (i: number) => hash(seed | 0, i)

const colorCache = new Map<string, [number, number, number]>()
/** 解析 #hex / rgb() / rgba()（忽略透明度） */
export function parseColor(c: string): [number, number, number] {
  let v = colorCache.get(c)
  if (v) return v
  const m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/)
  if (m) v = [+m[1], +m[2], +m[3]]
  else {
    let h = c.replace('#', '')
    if (h.length === 3) h = h.replace(/./g, (x) => x + x)
    v = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  colorCache.set(c, v)
  return v
}

/** 两色混合：t=0 为 a，t=1 为 b */
export function mixColor(a: string, b: string, t: number): string {
  const x = parseColor(a)
  const y = parseColor(b)
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * t)},${Math.round(x[1] + (y[1] - x[1]) * t)},${Math.round(x[2] + (y[2] - x[2]) * t)})`
}

/** 折线 */
export function addLine(pen: Pen, pts: P[], close = false) {
  pts.forEach(([x, y], i) => (i ? pen.lineTo(x, y) : pen.moveTo(x, y)))
  if (close) pen.closePath()
}

/** 过各边中点的二次曲线：折线变成圆顺的曲线（开口时两端点保留） */
export function addCurve(pen: Pen, pts: P[], close = false) {
  const n = pts.length
  if (n < 3) return addLine(pen, pts, close)
  if (close) {
    const m = (i: number): P => [(pts[i][0] + pts[(i + 1) % n][0]) / 2, (pts[i][1] + pts[(i + 1) % n][1]) / 2]
    const s = m(n - 1)
    pen.moveTo(s[0], s[1])
    for (let i = 0; i < n; i++) {
      const e = m(i)
      pen.quadraticCurveTo(pts[i][0], pts[i][1], e[0], e[1])
    }
    pen.closePath()
    return
  }
  pen.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < n - 1; i++) {
    const e: P = i === n - 2 ? pts[n - 1] : [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]
    pen.quadraticCurveTo(pts[i][0], pts[i][1], e[0], e[1])
  }
}

/** 椭圆（8 段二次曲线） */
export function addEllipse(pen: Pen, cx: number, cy: number, rx: number, ry = rx) {
  const n = 8
  const q = 1 / Math.cos(Math.PI / n)
  pen.moveTo(cx + rx, cy)
  for (let i = 1; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    const c = a - Math.PI / n
    pen.quadraticCurveTo(cx + Math.cos(c) * rx * q, cy + Math.sin(c) * ry * q, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry)
  }
  pen.closePath()
}

/** 不规则的圆团：n 个控制点，半径按种子起伏 wobble（0~1） */
export function addBlob(pen: Pen, cx: number, cy: number, rx: number, ry: number, n: number, wobble: number, seed: number, rot = 0) {
  const pts: P[] = []
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2
    const r = 1 + (hash(seed | 0, i + 31) - 0.5) * 2 * wobble
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r])
  }
  addCurve(pen, pts, true)
}

/**
 * 有粗细变化的一笔（毛笔、刻刀）：沿折线两侧各偏半个笔宽围成的闭合形，用 fill 画。
 * width(u) 给出弧长比例 u（0~1）处的笔宽
 */
export function addTaper(pen: Pen, pts: P[], width: (u: number) => number) {
  const n = pts.length
  if (n < 2) return
  const len: number[] = [0]
  for (let i = 1; i < n; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = len[n - 1] || 1
  const L: P[] = []
  const R: P[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    let dx = b[0] - a[0]
    let dy = b[1] - a[1]
    const d = Math.hypot(dx, dy) || 1
    dx /= d
    dy /= d
    const w = width(len[i] / total) / 2
    L.push([pts[i][0] - dy * w, pts[i][1] + dx * w])
    R.push([pts[i][0] + dy * w, pts[i][1] - dx * w])
  }
  pen.moveTo(L[0][0], L[0][1])
  for (let i = 1; i < n; i++) pen.lineTo(L[i][0], L[i][1])
  for (let i = n - 1; i >= 0; i--) pen.lineTo(R[i][0], R[i][1])
  pen.closePath()
}

/** 一点（横向的小墨点 / 米点）：两头尖的梭形，tilt 为倾角（弧度） */
export function addDab(pen: Pen, x: number, y: number, w: number, h: number, tilt = 0) {
  const c = Math.cos(tilt)
  const s = Math.sin(tilt)
  const p = (u: number, v: number): P => [x + u * c - v * s, y + u * s + v * c]
  const a = p(-w / 2, 0)
  const b = p(w / 2, 0)
  const t = p(0, -h)
  const d = p(0, h)
  pen.moveTo(a[0], a[1])
  pen.quadraticCurveTo(t[0], t[1], b[0], b[1])
  pen.quadraticCurveTo(d[0], d[1], a[0], a[1])
  pen.closePath()
}

/** Chaikin 切角细分：折线变圆顺 */
export function chaikin(pts: P[], iter = 2, close = false): P[] {
  let p = pts
  for (let k = 0; k < iter; k++) {
    const n = p.length
    if (n < 3) return p
    const q: P[] = []
    if (!close) q.push(p[0])
    for (let i = 0; i < (close ? n : n - 1); i++) {
      const a = p[i]
      const b = p[(i + 1) % n]
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    if (!close) q.push(p[n - 1])
    p = q
  }
  return p
}

/** 按弧长等距重采样（step 为间距）；返回的点带上弧长处的切向 */
export function resample(pts: P[], step: number, close = false): { p: P; t: P; at: number }[] {
  const src = close ? [...pts, pts[0]] : pts
  const out: { p: P; t: P; at: number }[] = []
  let acc = 0
  let next = 0
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1]
    const b = src[i]
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (d < 1e-6) continue
    const t: P = [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
    while (next <= acc + d) {
      const u = (next - acc) / d
      out.push({ p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], t, at: next })
      next += step
    }
    acc += d
  }
  return out
}

/** 折线总长 */
export function pathLength(pts: P[]) {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return l
}
