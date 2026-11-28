/**
 * 等值线环转 SVG 路径数据（等值线的追踪与化简在 src/gen/contour.ts）。
 */
import { ringArea, simplify, type Ring } from '../../../gen/contour'

/** 平滑时拐角最多削掉多少（格）：更长的线段两头各削这么多，中间直连 */
const SMOOTH_CUT = 3

/**
 * 转成 SVG path 数据。格坐标 → 画布像素：px = (g + 0.5) * S。
 * 用二次贝塞尔经过各边中点，让折线变成平滑曲线。
 */
export function pathData(rings: Ring[], S: number, opt: { closed: boolean; tol?: number; minArea?: number; smooth?: boolean } = { closed: true }): string {
  const tol = opt.tol ?? 0.3
  const parts: string[] = []
  const f = (v: number) => (Math.round(((v + 0.5) * S) * 10) / 10).toString()
  for (const raw of rings) {
    if (opt.minArea && opt.closed && ringArea(raw) < opt.minArea) continue
    const rs = simplify(raw, tol)
    const ns = rs.length / 2
    if (ns < 2) continue
    const isClosed = opt.closed && Math.hypot(rs[0] - rs[(ns - 1) * 2], rs[1] - rs[(ns - 1) * 2 + 1]) < 1.01
    if (opt.smooth === false || ns < 3) {
      let d = `M${f(rs[0])} ${f(rs[1])}`
      for (let i = 1; i < ns; i++) d += `L${f(rs[i * 2])} ${f(rs[i * 2 + 1])}`
      parts.push(isClosed ? d + 'Z' : d)
      continue
    }
    // 中点二次贝塞尔平滑：拐角处从上一段的中点经拐点画到下一段的中点。
    // 长线段（超过 2·SMOOTH_CUT 格）两头各只削 SMOOTH_CUT 格、中间直连——否则贴着图框走的长直边在图角一拐弯，
    // 曲线从长边的中点连到长边的中点，斜穿半张地图（奇偶填充下成了一道交叉的楔形）
    const r = rs
    const n = ns
    const px = (i: number) => r[i * 2]
    const py = (i: number) => r[i * 2 + 1]
    /** 线段 i→j 上离 i 端 min(半段, SMOOTH_CUT) 处的点 */
    const near = (i: number, j: number): [number, number] => {
      const dx = px(j) - px(i)
      const dy = py(j) - py(i)
      const L = Math.sqrt(dx * dx + dy * dy)
      const t = L > SMOOTH_CUT * 2 ? SMOOTH_CUT / L : 0.5
      return [px(i) + dx * t, py(i) + dy * t]
    }
    const long = (i: number, j: number) => Math.hypot(px(j) - px(i), py(j) - py(i)) > SMOOTH_CUT * 2
    const P = (p: [number, number]) => `${f(p[0])} ${f(p[1])}`
    if (isClosed) {
      let d = `M${P(near(0, 1))}`
      for (let i = 1; i <= n; i++) {
        const a = i % n
        const prev = i - 1
        const b = (i + 1) % n
        if (long(prev, a)) d += `L${P(near(a, prev))}`
        d += `Q${f(px(a))} ${f(py(a))} ${P(near(a, b))}`
      }
      parts.push(d + 'Z')
    } else {
      let d = `M${f(px(0))} ${f(py(0))}`
      for (let i = 1; i < n - 1; i++) {
        if (long(i - 1, i)) d += `L${P(near(i, i - 1))}`
        d += `Q${f(px(i))} ${f(py(i))} ${P(near(i, i + 1))}`
      }
      d += `L${f(px(n - 1))} ${f(py(n - 1))}`
      parts.push(d)
    }
  }
  return parts.join('')
}
