/**
 * 建筑的公用构件：烟囱、老虎窗、柱列、台基与栏杆、台阶、宝顶、披檐。
 * 各文明的建筑（buildings.ts 与 western / eastern / wa / islamic）都从这里取件。纯函数，在 Worker 中运行。
 */
import type { P } from '../../settlement/geom'
import type { Building } from '../../settlement/types'
import { DOWN, MAT, STYLE, WIN, annulus, at, block, cap, lathe, leanTo, prism, rectOf, shade, strip, tube, v3, walls, type Frame, type RGB, type V3, type Writer } from './mesh'
import type { Facade } from './facade'
import { BRICK, MARBLE, STONE, frac } from './shared'

/** 一栋建筑落地的基本量：平面的框、脚下地面、几个由色调派生的随机数 */
export interface Site {
  b: Building
  fac: Facade
  f: Frame
  /** 脚下地面的最低、最高处 */
  g0: number
  g1: number
  /** 墙脚（埋入地下） */
  base: number
  tone: number
  t2: number
  t3: number
  t4: number
  /** 平面是圆的近似（八边以上） */
  round: boolean
  floors: number
}

/** 由一个 0 ~ 1 的数派生第 k 个随机数 */
export const hashOf = (t: number, k: number) => frac(Math.sin(t * 127.1 + k * 311.7) * 43758.5453)

/** 颜色的明度（0 ~ 1） */
export const lum = (c: RGB) => (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255

/** 烟囱：砖砌的方筒，外挑的压顶，上面两个烟囱管；(s, t) 为框里的位置，自 y0 伸到 y1 */
export function chimney(w: Writer, f: Frame, s: number, t: number, y0: number, y1: number, r = 0.42, col: RGB = BRICK) {
  const ct = at(f, s, t)
  const g: Frame = { c: ct, u: f.u, v: f.v, a: r, b: r }
  w.c = col
  w.face = MAT.brick
  walls(w, rectOf(g), y0, y1)
  w.c = STONE
  w.face = MAT.plain
  block(w, rectOf(g, 0.09), y1, y1 + 0.14)
  w.c = shade(col, 0.72)
  for (const e of [-0.2, 0.2]) prism(w, rectOf({ ...g, c: at(g, e * (r / 0.42), 0), a: 0.11, b: 0.11 }), y1 + 0.14, y1 + 0.44)
}

/**
 * 老虎窗：坡屋面上的小两坡窗屋。s 为沿屋脊的位置，sgn 为哪一面坡；top 为墙顶、k 为屋面坡度、B 为半宽（墙线）。
 * 正面一扇窗（阁楼窗的样式），两颊与小屋顶收进主屋面
 */
export function dormer(w: Writer, f: Frame, s: number, sgn: number, top: number, k: number, wall: RGB, roof: RGB, hw = 0.62) {
  // 正面在距屋脊 62% 半宽处；窗屋墙高 1.15 米
  const tf = f.b * 0.66
  const yb = top + (f.b - tf) * k
  const wh = 1.15
  const kd = 0.85
  const yr = yb + wh + hw * kd
  // 两颊、屋脊向后收进主屋面处
  const tEave = Math.max(0, tf - wh / k)
  const tRidge = Math.max(0, tf - (wh + hw * kd) / k)
  const P = (ds: number, t: number, y: number): V3 => v3(at(f, s + ds, t * sgn), y)
  const out: V3 = [f.v[0] * sgn, 0, f.v[1] * sgn]
  // 正面：带阁楼窗
  const a = at(f, s - hw * sgn, tf * sgn)
  const face = w.face
  const style = w.style
  w.c = wall
  w.style = STYLE.attic
  w.face = (face & 63) | WIN
  const dx = f.u[0] * sgn
  const dz = f.u[1] * sgn
  const uv: [number, number, number] = [0, 2 * hw + 1024 * STYLE.attic, yb - 0.32]
  w.uvOf = (p) => ((uv[0] = (p[0] - a[0]) * dx + (p[2] - a[1]) * dz), uv)
  w.quadOut(P(-hw, tf, yb - 0.1), P(hw, tf, yb - 0.1), P(hw, tf, yb + wh), P(-hw, tf, yb + wh), out)
  w.uvOf = null
  w.style = style
  w.face = face & 63
  w.triOut(P(-hw, tf, yb + wh), P(hw, tf, yb + wh), P(0, tf, yr), out)
  // 两颊
  for (const e of [-1, 1]) w.triOut(P(hw * e, tf, yb - 0.1), P(hw * e, tf, yb + wh), P(hw * e, tEave, yb + wh), [f.u[0] * e, 0, f.u[1] * e])
  // 小屋顶：两坡，前端略出挑
  w.c = roof
  w.face = w.roofFace
  const o = 0.14
  for (const e of [-1, 1]) {
    const x = (hw + o) * e
    const ye = yb + wh - o * kd
    w.quadOut(P(x, tf + o, ye), P(0, tf + o, yr), P(0, tRidge, yr), P(x, Math.max(0, tEave - o / k), ye), [f.u[0] * e, 1, f.u[1] * e])
    // 前端的底面
    w.c = shade(roof, 0.5)
    w.face = MAT.plain
    w.triOut(P(x, tf + o, ye - 0.05), P(0, tf + o, yr - 0.05), P(0, tf, yr - 0.05), DOWN)
    w.triOut(P(x, tf + o, ye - 0.05), P(0, tf, yr - 0.05), P(x, tf, ye - 0.05), DOWN)
    w.c = roof
    w.face = w.roofFace
  }
  w.face = face
}

/** 沿 a → b 均布 n 根圆柱（含两端），自 y0 到 y1，半径 r，用当前颜色与材质 */
export function columnRow(w: Writer, a: P, b: P, n: number, y0: number, y1: number, r: number, sides = 8, ends = true) {
  for (let i = 0; i < n; i++) {
    if (!ends && (i === 0 || i === n - 1)) continue
    const t = n > 1 ? i / (n - 1) : 0.5
    tube(w, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], r, r * 0.92, y0, y1, sides)
  }
}

/**
 * 一圈柱廊：框的四边各一列柱（转角柱共用），长边 na 间、短边 nb 间
 */
export function peristyle(w: Writer, f: Frame, na: number, nb: number, y0: number, y1: number, r: number, sides = 8) {
  const c = rectOf(f)
  columnRow(w, c[0], c[1], na + 1, y0, y1, r, sides)
  columnRow(w, c[3], c[2], na + 1, y0, y1, r, sides)
  columnRow(w, c[0], c[3], nb + 1, y0, y1, r, sides, false)
  columnRow(w, c[1], c[2], nb + 1, y0, y1, r, sides, false)
}

/** 一段栏杆：沿 a → b 的薄墙（望柱与栏板由白石材质画出），自台面 y 起高 h */
export function rail(w: Writer, a: P, b: P, y: number, h = 1.05, col: RGB = MARBLE) {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.6) return
  w.c = col
  w.face = MAT.marble
  w.style = 1
  block(w, strip(a, b, 0.1), y, y + h)
  w.style = 0
}

/**
 * 台阶：自台面 y1 朝 dir（单位向量）一级级降到 y0。c 为台阶顶端（贴着台基边）的中点，半宽 hw
 */
export function stairs(w: Writer, c: P, dir: P, hw: number, y0: number, y1: number, col: RGB = MARBLE, tread = 0.34) {
  const n = Math.max(1, Math.min(14, Math.round((y1 - y0) / 0.19)))
  const u: P = [-dir[1], dir[0]]
  w.c = col
  w.face = MAT.marble
  for (let i = 0; i < n; i++) {
    // 第 i 级（自上而下）：越往下越长
    const d = (i + 1) * tread
    const f: Frame = { c: [c[0] + dir[0] * d * 0.5, c[1] + dir[1] * d * 0.5], u, v: dir, a: hw, b: d * 0.5 }
    const top = y1 - ((i + 1) * (y1 - y0)) / (n + 1)
    const bot = i === n - 1 ? y0 - 0.4 : y1 - ((i + 2) * (y1 - y0)) / (n + 1)
    // 只写露出的一段：踏面的外沿与这一级的立面
    const r = rectOf(f)
    walls(w, r, bot, top)
    cap(w, r, top)
  }
}

/**
 * 台基：自 y0（埋入地下）到台面 y1 的石台，四周外扩 d；rails 为真时台沿一圈栏杆，前后（±v）当中留出台阶的口并砌台阶
 */
export function terrace(w: Writer, f: Frame, d: number, y0: number, y1: number, ground: number, o: { rails?: boolean; stairs?: number; col?: RGB; sides?: boolean } = {}) {
  const col = o.col ?? MARBLE
  const r = rectOf(f, d)
  w.c = col
  w.face = MAT.marble
  w.style = 0
  prism(w, r, y0, y1)
  const sw = o.stairs ?? 0
  const A = f.a + d
  const B = f.b + d
  if (sw > 0 && y1 - ground > 0.25) {
    for (const s of [-1, 1]) stairs(w, at(f, 0, B * s), [f.v[0] * s, f.v[1] * s], sw, ground, y1, col)
    if (o.sides) for (const s of [-1, 1]) stairs(w, at(f, A * s, 0), [f.u[0] * s, f.u[1] * s], Math.min(sw, f.b * 0.5), ground, y1, col)
  }
  if (o.rails && y1 - ground > 0.7) {
    const e = 0.12
    for (const s of [-1, 1]) {
      // 长边：当中留台阶口
      if (sw > 0) {
        rail(w, at(f, -A + e, (B - e) * s), at(f, -sw - 0.1, (B - e) * s), y1)
        rail(w, at(f, sw + 0.1, (B - e) * s), at(f, A - e, (B - e) * s), y1)
      } else rail(w, at(f, -A + e, (B - e) * s), at(f, A - e, (B - e) * s), y1)
      const sh = o.sides && sw > 0 ? Math.min(sw, f.b * 0.5) : 0
      if (sh > 0) {
        rail(w, at(f, (A - e) * s, -B + e), at(f, (A - e) * s, -sh - 0.1), y1)
        rail(w, at(f, (A - e) * s, sh + 0.1), at(f, (A - e) * s, B - e), y1)
      } else rail(w, at(f, (A - e) * s, -B + e), at(f, (A - e) * s, B - e), y1)
    }
  }
}

/** 宝顶、塔刹：一串收分的旋转体（宝珠、相轮），底半径 r、总高 h */
export function finial(w: Writer, c: P, y: number, r: number, h: number, col: RGB, face: number = MAT.gilt) {
  w.c = col
  w.face = face
  lathe(
    w,
    c,
    y,
    [
      [r, 0],
      [r * 0.55, h * 0.12],
      [r * 0.8, h * 0.24],
      [r * 0.3, h * 0.4],
      [r * 0.5, h * 0.55],
      [r * 0.16, h * 0.72],
      [0, h],
    ],
    8,
  )
}

/**
 * 披檐：贴在一面墙外的单坡小屋顶（町家的庇、铺面的雨棚）。墙自 a 到 b（外法线 n），檐深 d，贴墙处高 yHi
 */
export function pent(w: Writer, a: P, b: P, n: P, d: number, yHi: number, drop: number, roof: RGB, inset = 0) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (L < 1.2) return
  const u: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  const f: Frame = { c: [(a[0] + b[0]) / 2 + n[0] * d * 0.5, (a[1] + b[1]) / 2 + n[1] * d * 0.5], u, v: n, a: L / 2 - inset, b: d * 0.5 }
  leanTo(w, f, yHi, yHi - drop, 0, roof, 0)
}

/** 出挑的楼层底：外环与内环之间朝下的一圈 */
export function soffitRing(w: Writer, outer: P[], inner: P[], y: number, col: RGB) {
  w.c = col
  w.face = MAT.plain
  annulus(w, outer, inner, y, false)
}
