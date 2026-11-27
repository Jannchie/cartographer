/**
 * 【实验·第二轮】山与丘陵共用一个连续的形态参数（山势 m，见 terrain.ts 的 mountainness）的两种画法：
 * - classicGradual「现有画法·连续过渡」：奇幻羊皮现有山形的笔法（折线轮廓、阴坡填色与排线、山脊线、雪冠），
 *   但丘陵与山不再是两种符号，而是同一个生成函数在 m 上的两端；
 * - lianzhang「连嶂」第二版：山水 / 舆图的笔意，按屏幕深度严格排序，笔有起收与轻重，山体留白。
 * 两种画法里，大小、高宽比、峰的尖锐度、皴笔 / 排线的数量、笔重、雪线都是 m 的连续函数，不按阈值挑符号。
 */
import { fnoise } from '../fields'
import type { Pen } from '../glyphBatch'
import { addCurve, addDab, addLine, addTaper, mixColor, rnd, type P } from './brush'
import type { SymbolStyle } from './index'
import type { Peak, Terrain } from './terrain'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/**
 * 山势 m（0~1）→ 形态。全部是 m 的连续函数：
 * size 基准尺寸（像素）；w 半宽、h 高（缓丘宽而矮，高峰窄而高）；sharp 尖锐度（0 圆丘、1 嶙峋的山峰）；
 * weight 笔重的倍数；strokes 皴笔 / 排线的期望数量；snow 雪线的深浅（0 无雪）
 */
export function form(m: number, k: number) {
  const size = (6.5 + 19.5 * m ** 1.35) * k
  return {
    size,
    w: size * (1.06 - 0.2 * m),
    h: size * (0.46 + 0.98 * m ** 0.8),
    sharp: smooth(0.08, 0.6, m),
    weight: 0.85 + 0.95 * m,
    // 皴笔从山势 0.1 起才有：缓丘只是一两笔弧
    strokes: Math.max(0, 11 * (m - 0.1)),
    snow: clamp01((m - 0.58) / 0.42),
  }
}

/** 期望值为 x 的整数：小数部分按种子随机进位，数量随 m 渐增而不是在某个阈值上齐刷刷地多一笔 */
const dither = (x: number, r: number) => Math.floor(x + r)

/** 折线上纵坐标为 y 处的横坐标（取自上而下第一次越过处） */
function xAtY(line: P[], y: number) {
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1]
    const [x1, y1] = line[i]
    if (y <= y1 || i === line.length - 1) return x0 + (x1 - x0) * clamp01((y - y0) / (y1 - y0 || 1))
  }
  return line[line.length - 1][0]
}

/** 分段线性：knots 为 [a, f] 序列（a 递增） */
function piecewise(a: number, knots: [number, number][]) {
  for (let i = 1; i < knots.length; i++) {
    if (a <= knots[i][0]) return lerp(knots[i - 1][1], knots[i][1], (a - knots[i - 1][0]) / (knots[i][0] - knots[i - 1][0] || 1))
  }
  return knots[knots.length - 1][1]
}

// ———————————————————————— 现有画法 · 连续过渡 ————————————————————————

/** 一座山（或丘）：现有画法的笔法，形态全由 m 定 */
function classicMount(pen: Pen, x: number, y: number, m: number, seed: number, o: { ink: string; paper: string; shadow: string; snow: string }, k: number) {
  const f = form(m, k)
  const r = rnd(seed)
  const w = f.w * (0.88 + r(1) * 0.26)
  const h = f.h * (0.88 + r(2) * 0.28)
  const sharp = f.sharp
  const ax = x + (r(3) - 0.5) * w * 0.3
  // 轮廓：圆丘（抛物线顶）与嶙峋山形（带肩的折线、右坡偶有次峰）按 sharp 插值
  const kl: [number, number][] = [[0, 1], [0.2, 0.72 + r(4) * 0.1], [0.44 + r(5) * 0.08, 0.5 + r(6) * 0.1], [0.64, 0.3 + r(7) * 0.1], [1, 0]]
  const kr: [number, number][] = [[0, 1], [0.22, 0.7 + r(9) * 0.1], [0.56, 0.3 + r(10) * 0.1], [1, 0]]
  const sub = r(8) > 0.55 ? 0.17 : 0
  const prof = (a: number, right: boolean) => {
    const dome = (1 - a * a) ** 0.62
    const crag = piecewise(a, right ? kr : kl) + (right ? sub * Math.exp(-(((a - 0.38) / 0.09) ** 2)) : 0)
    return lerp(dome, crag, sharp)
  }
  const N = 9
  const left: P[] = []
  const right: P[] = []
  for (let i = 0; i <= N; i++) {
    const a = i / N
    left.push([ax - a * (ax - (x - w)), y - h * prof(a, false)])
    right.push([ax + a * (x + w - ax), y - h * prof(a, true)])
  }
  const outline = [...left.slice().reverse(), ...right.slice(1)]
  const P0 = right[0]
  const B: P = [x + w * (0.12 + r(11) * 0.1), y + h * 0.04]
  const ridge: P[] = [P0, [P0[0] + w * 0.05, P0[1] + h * 0.36], [P0[0] + w * (0.03 + r(12) * 0.1), P0[1] + h * 0.7], B]
  // 山体：山脚向下微鼓。缓丘与现有的丘陵符号一样不填（只是一道弧加阴坡），随山势渐实
  const solid = smooth(0.06, 0.24, m)
  if (solid > 0.01) {
    pen.beginPath()
    addCurve(pen, outline)
    pen.quadraticCurveTo(x, y + h * 0.17, x - w, y)
    pen.closePath()
    pen.fillStyle = o.paper
    pen.globalAlpha = solid
    pen.fill()
    pen.globalAlpha = 1
  }
  // 阴坡
  pen.beginPath()
  addLine(pen, [...right, [x + w * 0.6, y + h * 0.1], ...ridge.slice().reverse().slice(0, -1)], true)
  pen.fillStyle = o.shadow
  pen.fill()
  // 雪冠：深度从 0 起随 m 加深
  if (f.snow > 0.03) {
    const yl = P0[1] + h * 0.34 * f.snow
    const lx = xAtY(left, yl)
    const rx = xAtY(right, yl + h * 0.03)
    const rgx = xAtY(ridge, yl + h * 0.04)
    const cap: P[] = [...left.filter((p) => p[1] < yl).reverse(), ...right.filter((p) => p[1] < yl + h * 0.03).slice(1), [rx, yl + h * 0.03]]
    for (let j = 1; j < 4; j++) cap.push([rx + ((lx - rx) * j) / 4, yl + (j % 2 ? h * 0.06 * f.snow : -h * 0.01)])
    cap.push([lx, yl])
    pen.beginPath()
    addLine(pen, cap, true)
    pen.fillStyle = o.snow
    pen.fill()
    pen.beginPath()
    addLine(pen, [P0, ...right.filter((p) => p[1] < yl + h * 0.03).slice(1), [rx, yl + h * 0.03], [rgx, yl + h * 0.05]], true)
    pen.fillStyle = o.shadow
    pen.globalAlpha = 0.45
    pen.fill()
    pen.globalAlpha = 1
  }
  // 阴坡排线：从右坡斜向下伸向山脊
  pen.beginPath()
  const n = Math.max(1, dither(h / (3.3 * k) - 0.5, r(13)))
  const y0 = P0[1] + h * (0.14 + 0.24 * f.snow)
  for (let j = 0; j < n; j++) {
    const yy = y0 + ((y - h * 0.08 - y0) * (j + 0.5)) / n
    const sx = xAtY(right, yy)
    const ex = xAtY(ridge, yy + h * 0.1)
    if (sx - ex < 1.8 * k) continue
    pen.moveTo(sx - 0.6 * k, yy)
    pen.lineTo(sx - (sx - ex) * 0.77, yy + h * 0.1)
  }
  pen.strokeStyle = o.ink
  pen.lineWidth = 0.55 * k
  pen.stroke()
  // 轮廓
  pen.beginPath()
  addCurve(pen, outline)
  pen.lineWidth = (0.62 + 0.45 * smooth(0.04, 0.4, m)) * k
  pen.stroke()
  // 山脊线：圆丘只有半截，越尖越长
  pen.beginPath()
  addLine(pen, [ridge[0], ridge[1], lerpP(ridge[1], ridge[2], 0.35 + 0.65 * sharp)])
  pen.lineWidth = (0.56 + 0.14 * sharp) * k
  pen.stroke()
  // 山脚的地面线：随 sharp 渐显
  if (sharp > 0.1) {
    pen.beginPath()
    pen.moveTo(x + w * 0.25, y + h * 0.06)
    pen.quadraticCurveTo(x + w * 0.8, y + h * 0.04, x + w * (0.85 + 0.25 * sharp), y - h * 0.02)
    pen.lineWidth = 0.6 * k * sharp
    pen.stroke()
  }
}
const lerpP = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

export const classicGradual: SymbolStyle = {
  id: 'classic-gradual',
  name: '现有画法 · 连续过渡',
  desc: '奇幻羊皮现有的笔法（折线轮廓、阴坡排线、山脊线、雪冠），丘陵与山改由同一个形态参数连续生成：缓丘、圆丘、矮山、山、高峰之间没有符号的切换。',
  draw(T, o, out) {
    const k = T.k
    for (const p of T.peaks) out.item(p.y, (pen) => classicMount(pen, p.x, p.y, p.m, p.seed, o, k))
    for (const hl of T.hills) out.item(hl.y, (pen) => classicMount(pen, hl.x, hl.y, hl.m, hl.seed, o, k))
  },
}

// ———————————————————————— 连嶂（第二版） ————————————————————————

/** 一座山头：底边中点 (x, y)、半宽、高、山势；real 为真正的山峰或丘（鞍部、肩部是补出来的） */
interface Hump {
  x: number
  y: number
  w: number
  h: number
  m: number
  sharp: number
  seed: number
  real: boolean
  /** 笔重的倍数：主脊 1，支脉、丘陵、远山依次减轻 */
  wt: number
  kl: [number, number][]
  kr: [number, number][]
}

function makeHump(x: number, y: number, m: number, seed: number, k: number, wt: number, scale = 1): Hump {
  const f = form(m, k)
  const r = rnd(seed)
  const w = f.w * (0.9 + r(1) * 0.25) * scale
  const h = f.h * (0.88 + r(2) * 0.3) * scale
  return {
    x: x + (r(3) - 0.5) * w * 0.3 * f.sharp,
    y,
    w,
    h,
    m,
    sharp: f.sharp,
    seed,
    real: true,
    wt,
    kl: [[0, 1], [0.2 + r(11) * 0.1, 0.7 + r(12) * 0.12], [0.5 + r(13) * 0.12, 0.38 + r(14) * 0.14], [1, 0]],
    kr: [[0, 1], [0.16 + r(15) * 0.1, 0.68 + r(16) * 0.12], [0.52 + r(17) * 0.14, 0.3 + r(18) * 0.12], [1, 0]],
  }
}

/** 山头的外形：圆丘与带肩的峦头按 sharp 插值；峦头的顶仍收成圆头 */
function humpShape(d: number, hp: Hump) {
  const a = Math.abs(d)
  const kn = d < 0 ? hp.kl : hp.kr
  const s1 = kn[1][0]
  const crag = a < s1 ? 1 - (1 - kn[1][1]) * (a / s1) ** 1.8 : piecewise(a, kn)
  return lerp((1 - a ** 2.2) ** 0.7, crag, hp.sharp)
}

/** 各山头外形的上包络（等距采样的顶线与底线） */
function envelope(humps: Hump[], step: number) {
  let x0 = Infinity
  let x1 = -Infinity
  for (const hp of humps) {
    x0 = Math.min(x0, hp.x - hp.w)
    x1 = Math.max(x1, hp.x + hp.w)
  }
  const by = [...humps].sort((a, b) => a.x - b.x)
  const baseAt = (x: number) => {
    if (x <= by[0].x) return by[0].y
    for (let i = 1; i < by.length; i++) if (x <= by[i].x) return lerp(by[i - 1].y, by[i].y, (x - by[i - 1].x) / (by[i].x - by[i - 1].x || 1))
    return by[by.length - 1].y
  }
  const n = Math.max(4, Math.ceil((x1 - x0) / step))
  const top: P[] = []
  const base: P[] = []
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n
    const b = baseAt(x)
    let hh = 0
    for (const hp of humps) {
      const d = (x - hp.x) / hp.w
      if (d > -1 && d < 1) hh = Math.max(hh, hp.h * humpShape(d, hp) * (1 + (fnoise(x * 5 + hp.seed, hp.y * 5, 6) - 0.5) * 0.14 * hp.sharp * Math.min(1, (1 - Math.abs(d)) * 4)))
    }
    top.push([x, b - hh])
    base.push([x, b])
  }
  return { top, base, baseAt, x0, x1 }
}
export function topAt(top: P[], x: number) {
  if (x <= top[0][0]) return top[0][1]
  for (let i = 1; i < top.length; i++) if (x <= top[i][0]) return lerp(top[i - 1][1], top[i][1], (x - top[i - 1][0]) / (top[i][0] - top[i - 1][0] || 1))
  return top[top.length - 1][1]
}

/** 折线按弧长比例取 u0~u1 的一段 */
function slicePath(pts: P[], u0: number, u1: number): P[] {
  const len: number[] = [0]
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = len[len.length - 1]
  const at = (d: number): P => {
    for (let i = 1; i < pts.length; i++) if (d <= len[i]) return lerpP(pts[i - 1], pts[i], (d - len[i - 1]) / (len[i] - len[i - 1] || 1))
    return pts[pts.length - 1]
  }
  const a = u0 * total
  const b = u1 * total
  const out: P[] = [at(a)]
  for (let i = 0; i < pts.length; i++) if (len[i] > a && len[i] < b) out.push(pts[i])
  out.push(at(b))
  return out
}

/** 隔点抽稀（保留首尾与转折）：笔画的折线不必逐个采样点都留 */
export function thin(pts: P[], tol: number): P[] {
  if (pts.length < 3) return pts
  const out: P[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]
    const b = pts[i + 1]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const d = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / (Math.hypot(dx, dy) || 1)
    if (d > tol) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out
}

/** 把山链上（取舍之后）的山峰分成屏：左右并排、底边几乎等高的才连成一屏；一屏的纵向跨度很小，按它的纵坐标排序才不会错 */
export function screensOf(nodes: Peak[]): Peak[][] {
  const out: Peak[][] = []
  let cur: Peak[] = [nodes[0]]
  let dir = 0
  let lo = nodes[0].y
  let hi = nodes[0].y
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]
    const b = nodes[i]
    const dx = b.x - a.x
    const d = Math.sign(dx)
    const nlo = Math.min(lo, b.y)
    const nhi = Math.max(hi, b.y)
    const s = Math.min(a.s, b.s)
    if (Math.abs(dx) > 2.2 * Math.abs(b.y - a.y) && (dir === 0 || d === dir) && cur.length < 5 && nhi - nlo < 0.3 * s && Math.hypot(dx, b.y - a.y) < 2 * Math.max(a.s, b.s)) {
      cur.push(b)
      dir = d
      lo = nlo
      hi = nhi
    } else {
      out.push(cur)
      cur = [b]
      dir = 0
      lo = hi = b.y
    }
  }
  out.push(cur)
  return out
}

export interface LianzhangOpts {
  /**
   * 山体的底色（遮住后面的笔）：给了就按山脚所在处取，应与底图在那里的颜色相当或略深——山体是"纸"，不能比纸亮。
   * 不给就用 GlyphColors.paper（垫在别的风格上比较时用）
   */
  ground?: (T: Terrain, x: number, y: number) => string
}

/** 连嶂（第三版）：丘、矮山、山、高峰是同一个生成函数在山势上的连续变化——缓丘只是一两笔淡墨的弧，随山势渐有山体、晕染、皴笔与峰形 */
export function makeLianzhang(opts: LianzhangOpts = {}): SymbolStyle {
  return {
    id: 'lianzhang',
    name: '连嶂',
    desc: '山水与舆图的笔意：缓丘是一两笔淡墨的弧，随山势渐有山体、背光侧的淡赭晕染、披麻皴与峰形；山体用纸色，山脚不封口；主脊最重，支脉与丘陵渐轻。',
    draw(T, o, out) {
      const k = T.k
      const ochre = mixColor(mixColor(o.shadow, 'rgb(170,120,78)', 0.3), o.ink, 0.12)
      const groundAt = (x: number, y: number) => (opts.ground ? opts.ground(T, x, y) : o.paper)
      // —— 取舍：主脊全留；支脉的山峰从高到低挑，离已留下的山峰太近（纵向按 1.5 倍算：前后挤着的多半被挡住）的不画；
      // 丘陵每簇只留一两座，贴着山峰的不画，山麓的更稀 ——
      const crowd = (x: number, y: number, s: number, f: number) => {
        for (const q of kept) {
          const dx = x - q.x
          const dy = (y - q.y) * 1.5
          const R = f * Math.max(s, q.s)
          if (dx * dx + dy * dy < R * R) return true
        }
        return false
      }
      const kept: Peak[] = []
      const keptSet = new Set<Peak>()
      const order: { p: Peak; main: boolean }[] = []
      for (const c of T.chains) for (const p of c.nodes) order.push({ p, main: c.main })
      order.sort((a, b) => Number(b.main) - Number(a.main) || b.p.m - a.p.m || a.p.seed - b.p.seed)
      for (const { p, main } of order) {
        if (!main && crowd(p.x, p.y, p.s, 1.12)) continue
        kept.push(p)
        keptSet.add(p)
      }
      const units: { humps: Hump[] }[] = []
      for (const c of T.chains) {
        const nodes = c.nodes.filter((p) => keptSet.has(p))
        if (!nodes.length) continue
        const wt = c.main ? 1 : 0.8
        for (const run of screensOf(nodes)) {
          const sorted = [...run].sort((a, b) => a.x - b.x)
          const humps: Hump[] = []
          sorted.forEach((p, i) => {
            const hp = makeHump(p.x, p.y, p.m, p.seed, k, wt, c.main ? 1 : 0.9)
            humps.push(hp)
            const q = sorted[i + 1]
            if (q) {
              // 鞍部：两峰之间的山脊不落到地面
              const dist = Math.hypot(q.x - p.x, q.y - p.y)
              const mm = Math.min(p.m, q.m)
              const sd = makeHump((p.x + q.x) / 2, (p.y + q.y) / 2, mm, p.seed + 7, k, wt)
              sd.x = (p.x + q.x) / 2
              sd.w = dist * 0.6 + sd.w * 0.2
              sd.h = Math.min(hp.h, form(q.m, k).h) * 0.5
              sd.real = false
              humps.push(sd)
            }
          })
          // 肩与次峰（笔架式的山形）：每座山峰一两个，高度随 sharp 从无到有
          for (const hp of humps.filter((q) => q.real)) {
            const r = rnd(hp.seed)
            const side = r(20) > 0.5 ? 1 : -1
            const two = r(22) > 0.45
            for (let j = 0; j < (two ? 2 : 1); j++) {
              const sd = j ? -side : side
              const hh = hp.h * (j ? 0.34 + r(23) * 0.14 : 0.52 + r(21) * 0.16) * hp.sharp
              if (hh < 2.5 * k) continue
              const sh = makeHump(hp.x, hp.y, hp.m * 0.6, hp.seed + 11 + j, k, wt)
              sh.x = hp.x - sd * hp.w * (0.5 + r(24 + j) * 0.2)
              sh.w = hp.w * (0.5 + r(26 + j) * 0.16)
              sh.h = hh
              sh.real = false
              humps.push(sh)
            }
          }
          units.push({ humps })
        }
      }
      // 丘与矮山：选点已经按丘群成组、山势取真实值；这里只让开已留下的山峰
      for (const hl of T.hills) {
        if (crowd(hl.x, hl.y, hl.s, 0.95)) continue
        units.push({ humps: [makeHump(hl.x, hl.y, hl.m, hl.seed, k, lerp(0.62, 0.85, smooth(0.05, 0.35, hl.m)))] })
      }

      /** 一屏：山体（纸色）→ 背光侧的淡赭晕染（两层）→ 皴 → 山脊的几笔 → 点苔。各层的有无与浓淡都随山势连续变化 */
      const drawScreen = (pen: Pen, humps: Hump[]) => {
        const env = envelope(humps, 1.1 * k)
        const top = env.top
        const n = top.length
        const hMax = Math.max(...humps.map((hp) => hp.h))
        const mMax = Math.max(...humps.filter((hp) => hp.real).map((hp) => hp.m))
        const ground = groundAt((env.x0 + env.x1) / 2, env.baseAt((env.x0 + env.x1) / 2))
        // 墨色：缓丘是淡墨，山势到 0.32 时为正墨
        const ink = mixColor(o.ink, ground, 0.5 * (1 - smooth(0.04, 0.32, mMax)))
        // 山体：纸色，把后面的线盖住；底边略低于山脚，不勾线。缓丘不填（只是几笔弧），随山势渐实
        const solid = smooth(0.08, 0.22, mMax)
        if (solid > 0.01) {
          pen.beginPath()
          addLine(pen, thin(top, 0.2 * k))
          for (let i = n - 1; i >= 0; i -= Math.max(1, Math.floor(n / 6))) pen.lineTo(env.base[i][0], env.base[i][1] + hMax * 0.05 * Math.sin((i / (n - 1)) * Math.PI) + 0.4 * k)
          pen.closePath()
          pen.fillStyle = ground
          pen.globalAlpha = solid
          pen.fill()
          pen.globalAlpha = 1
        }
        // 背光一侧的淡赭：宽的一层从峰顶弯到山脚，窄的一层贴着山脊，叠出由深到浅
        const wash = smooth(0.1, 0.42, mMax)
        for (const [reach, alpha] of [[0.84, 0.22], [0.46, 0.2]] as const) {
          if (wash < 0.02) break
          pen.beginPath()
          for (const hp of humps) {
            if (!hp.real || hp.h < 4 * k) continue
            // 外缘贴着山脊（被山脊的笔盖住），内缘是一道从峰顶弯到山脚的弧
            const xr = hp.x + hp.w * reach
            const pts: P[] = [[hp.x, topAt(top, hp.x)]]
            for (const p of top) if (p[0] > hp.x && p[0] < xr) pts.push(p)
            const sub = thin(pts, 0.4 * k)
            const fy = env.baseAt(xr) - hp.h * (reach > 0.6 ? 0.03 : 0.3)
            addLine(pen, sub)
            pen.lineTo(xr, fy)
            pen.quadraticCurveTo(hp.x + hp.w * reach * 0.6, env.baseAt(hp.x) - hp.h * (reach > 0.6 ? -0.02 : 0.25), hp.x + hp.w * reach * 0.36, env.baseAt(hp.x) - hp.h * (reach > 0.6 ? 0.1 : 0.4))
            pen.quadraticCurveTo(hp.x + hp.w * 0.1, hp.y - hp.h * (reach > 0.6 ? 0.45 : 0.62), sub[0][0], sub[0][1])
            pen.closePath()
          }
          pen.fillStyle = ochre
          pen.globalAlpha = alpha * wash
          pen.fill()
          pen.globalAlpha = 1
        }
        // 披麻皴：稀，集中在背光一侧的上半，长短不一
        pen.beginPath()
        for (const hp of humps) {
          if (!hp.real) continue
          const f = form(hp.m, k)
          const r = rnd(hp.seed)
          const nr = dither(f.strokes * 0.68, r(30))
          const nl = dither(f.strokes * 0.3 - 0.2, r(31))
          for (let j = 0; j < nr + nl; j++) {
            const right = j < nr
            if (r(60 + j) < 0.2) continue
            const q = right ? 0.1 + 0.62 * ((j + r(32 + j) * 0.8) / Math.max(1, nr)) ** 1.15 : 0.16 + 0.5 * ((j - nr + r(32 + j) * 0.8) / Math.max(1, nl))
            const sx = hp.x + (right ? 1 : -1) * q * hp.w
            const sy = topAt(top, sx) + (1.3 + 1.6 * r(40 + j)) * k
            const room = env.baseAt(sx) - sy
            if (room < 3.2 * k) continue
            const len = room * (right ? 0.46 + 0.36 * r(50 + j) : 0.3 + 0.26 * r(50 + j)) * (1 - 0.25 * q)
            const ex = sx + (right ? 1 : -1) * (q * hp.w * 0.17 + hp.w * 0.03)
            const mid: P = [lerp(sx, ex, 0.38) - (right ? 0.7 : -0.7) * k, sy + len * 0.5]
            const wd = (1.0 + 0.6 * hp.m) * hp.wt * k
            addTaper(pen, [[sx, sy], mid, [ex, sy + len]], (u) => wd * (1 - 0.78 * u))
          }
        }
        pen.fillStyle = ink
        pen.globalAlpha = 0.78
        pen.fill()
        pen.globalAlpha = 1
        // 山脊：在峰顶与鞍部处断成几笔。上行的左坡轻而快，下行的右坡起笔一顿、行笔渐轻、不到山脚就收
        pen.beginPath()
        const cut: number[] = [0]
        let prev = 0
        for (let i = 1; i < n; i++) {
          const dy = top[i][1] - top[i - 1][1]
          const d = dy < -0.02 * k ? -1 : dy > 0.02 * k ? 1 : 0
          if (!d) continue
          if (prev && d !== prev) cut.push(i - 1)
          prev = d
        }
        cut.push(n - 1)
        for (let c = 0; c + 1 < cut.length; c++) {
          const a = cut[c]
          const b = cut[c + 1]
          if (b - a < 2) continue
          const rising = top[b][1] < top[a][1]
          const apex = rising ? top[b] : top[a]
          // 这一笔属于哪座山头：取离峰顶最近的
          let hp = humps[0]
          for (const q of humps) if (q.real && (!hp.real || Math.abs(q.x - apex[0]) < Math.abs(hp.x - apex[0]))) hp = q
          const W = form(hp.m, k).weight * hp.wt * k
          const r = rnd(hp.seed + c * 13)
          let seg = thin(top.slice(a, b + 1), 0.22 * k)
          const drop = Math.abs(top[b][1] - top[a][1])
          if (drop < 1.2 * k) continue
          // 最外侧的两笔离地：山脚不封口
          if (a === 0) seg = slicePath(seg, 0.1 + 0.08 * r(1), 1)
          if (b === n - 1) seg = slicePath(seg, 0, 0.88 - 0.08 * r(2))
          const jit = 0.88 + 0.3 * fnoise(apex[0] * 3, apex[1] * 3, 11)
          if (rising) {
            addTaper(pen, seg, (u) => W * 0.8 * jit * Math.min(1, 0.3 + u * 7) * (1 - 0.45 * u * u))
          } else {
            // 搭笔：从峰顶左下一点起笔，压过左坡那一笔的收尾
            seg = [[apex[0] - 0.9 * W, apex[1] + 0.75 * W], ...seg]
            addTaper(pen, seg, (u) => W * 1.05 * jit * Math.min(1, 0.42 + u * 8) * (1 - 0.84 * smooth(0.42, 1, u)))
          }
        }
        // 点苔：山脊上的几个横点，随山势渐多
        for (const hp of humps) {
          if (!hp.real) continue
          const r = rnd(hp.seed)
          const nd = dither(hp.m * 2.6 - 0.2, r(70))
          for (let j = 0; j < nd; j++) {
            const dx = hp.x + (r(71 + j) - 0.42) * hp.w * 1.3
            if (dx < env.x0 + 2 * k || dx > env.x1 - 2 * k) continue
            addDab(pen, dx, topAt(top, dx) - 0.7 * k, (1.3 + r(80 + j)) * k * hp.wt, 0.42 * k, (r(90 + j) - 0.5) * 0.5)
          }
        }
        pen.fillStyle = ink
        pen.fill()
      }

      for (const u of units) {
        const ys = u.humps.filter((hp) => hp.real).map((hp) => hp.y)
        const y = ys.reduce((a, b) => a + b, 0) / ys.length
        const hMax = Math.max(...u.humps.map((hp) => hp.h))
        // 同一深度时矮的后画（在前）
        out.item(y - hMax * 1e-3, (pen) => drawScreen(pen, u.humps))
      }
    },
  }
}

export const lianzhang = makeLianzhang()

export const MOUNTAIN_STYLES_V2: SymbolStyle[] = [classicGradual, lianzhang]
