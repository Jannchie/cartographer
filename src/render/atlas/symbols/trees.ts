/**
 * 【实验】散树与小丛的六种画法（单棵、三五棵的小丛；阔叶、针叶、雨林、金合欢、灌木各有对应的形）。
 * 一处树（TreeSpot）是一个遮挡符号：丛内的前后次序、共用的根部 / 地面线 / 投影都在这一个符号里排好。
 * 顺序与 forests.ts 的森林画法一一配对。
 */
import type { Pen } from '../glyphBatch'
import type { GlyphColors } from '../glyphs'
import { addBlob, addDab, addEllipse, addLine, addTaper, chaikin, mixColor, rnd, type P } from './brush'
import type { SymbolStyle } from './index'
import type { TreeSpot } from './terrain'

/** 丛里的一棵：位置、尺寸、随机数的序号偏移 */
interface Member {
  x: number
  y: number
  s: number
  /** 这一棵用的随机数从 r(q) 起 */
  q: number
}

/** 丛的排布（以 s 为单位的 dx、dy 与大小倍率）：后排在前、最大的一棵在最前 */
const LAYOUT: Record<number, [number, number, number][]> = {
  1: [[0, 0, 1]],
  2: [
    [-0.62, -0.18, 0.88],
    [0.55, 0.1, 1],
  ],
  3: [
    [-1.0, -0.28, 0.86],
    [0.95, -0.16, 0.9],
    [0.02, 0.26, 1],
  ],
  4: [
    [-1.35, -0.2, 0.8],
    [0.3, -0.5, 0.86],
    [1.25, -0.05, 0.84],
    [-0.3, 0.28, 1],
  ],
  5: [
    [-1.65, -0.22, 0.78],
    [-0.55, -0.55, 0.88],
    [0.6, -0.5, 0.84],
    [1.55, -0.12, 0.8],
    [0.0, 0.3, 1],
  ],
}

/** 一处树丛里的各棵，按纵坐标从后往前；spread 调整疏密 */
function members(t: TreeSpot, spread = 1): Member[] {
  const r = rnd(t.seed)
  const n = Math.max(1, Math.min(5, t.n))
  const flip = r(39) > 0.5 ? -1 : 1
  const out = LAYOUT[n].map(([dx, dy, m], i) => ({
    x: t.x + (dx * flip * spread + (n > 1 ? (r(40 + i) - 0.5) * 0.24 : 0)) * t.s,
    y: t.y + (dy * spread + (n > 1 ? (r(50 + i) - 0.5) * 0.16 : 0)) * t.s,
    s: t.s * m,
    q: 60 + i * 10,
  }))
  return out.sort((a, b) => a.y - b.y)
}

const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
/** 从笔的当前位置（pts[0]）接着画过各边中点的二次曲线，末点精确到达 */
function curveOn(pen: Pen, pts: P[]) {
  const n = pts.length
  for (let i = 1; i < n - 1; i++) {
    const e = i === n - 2 ? pts[n - 1] : mid(pts[i], pts[i + 1])
    pen.quadraticCurveTo(pts[i][0], pts[i][1], e[0], e[1])
  }
}

/** 一棵树的画法：pen 上画一处树（含丛） */
type SpotDraw = (pen: Pen, t: TreeSpot, k: number, o: GlyphColors) => void

function treeStyle(id: string, name: string, desc: string, draw: SpotDraw): SymbolStyle {
  return {
    id,
    name,
    desc,
    draw(T, o, out) {
      for (const t of T.trees) out.item(t.y + t.s * 0.3, (pen) => draw(pen, t, T.k, o))
    },
  }
}

// ———————————————————————— 一、叶脉树 ————————————————————————

/** 叶形：从叶基 b 到叶尖 tip，最宽处半宽 W；prof 为沿主脉的若干站位 [位置, 相对宽度] */
const OVATE: [number, number][] = [
  [0.1, 0.6],
  [0.34, 1],
  [0.62, 0.78],
  [0.86, 0.34],
]
const LANCE: [number, number][] = [
  [0.1, 0.7],
  [0.32, 1],
  [0.62, 0.8],
  [0.88, 0.36],
]
const CORDATE: [number, number][] = [
  [-0.09, 0.58],
  [0.14, 1],
  [0.5, 0.8],
  [0.84, 0.3],
]
function leafFrame(b: P, tip: P) {
  const ax = tip[0] - b[0]
  const ay = tip[1] - b[1]
  // 法向：主脉朝上时指向右
  const h = Math.hypot(ax, ay) || 1
  const nx = -ay / h
  const ny = ax / h
  return (f: number, w: number): P => [b[0] + ax * f + nx * w, b[1] + ay * f + ny * w]
}
/** 整片叶（side=0）或右半片（side=1，以主脉为界）的路径 */
function addLeaf(pen: Pen, b: P, tip: P, W: number, prof: [number, number][], side: 0 | 1) {
  const at = leafFrame(b, tip)
  const R = prof.map(([f, w]) => at(f, W * w))
  pen.moveTo(b[0], b[1])
  if (side === 0) {
    const L = prof.map(([f, w]) => at(f, -W * w))
    curveOn(pen, [b, ...L, tip])
    curveOn(pen, [tip, ...R.slice().reverse(), b])
  } else {
    curveOn(pen, [b, ...R, tip])
  }
  pen.closePath()
}
/** 侧脉：n 对，从主脉斜向上伸到叶缘内侧；rise 为沿主脉上行的量 */
function addVeins(pen: Pen, b: P, tip: P, W: number, prof: [number, number][], n: number, rise: number) {
  const at = leafFrame(b, tip)
  const wAt = (f: number) => {
    for (let i = 1; i < prof.length; i++) {
      if (f <= prof[i][0]) {
        const u = (f - prof[i - 1][0]) / (prof[i][0] - prof[i - 1][0])
        return prof[i - 1][1] + (prof[i][1] - prof[i - 1][1]) * Math.max(0, u)
      }
    }
    return prof[prof.length - 1][1] * Math.max(0, (1 - f) / (1 - prof[prof.length - 1][0]))
  }
  for (let j = 0; j < n; j++) {
    const f = 0.2 + (0.56 * j) / Math.max(1, n - 1)
    const m = at(f, 0)
    const w = W * wAt(f + rise) * 0.74
    for (const sg of [-1, 1]) {
      const e = at(f + rise, sg * w)
      const c = at(f + rise * 0.35, sg * w * 0.6)
      pen.moveTo(m[0], m[1])
      pen.quadraticCurveTo(c[0], c[1], e[0], e[1])
    }
  }
}

const vein: SpotDraw = (pen, t, k, o) => {
  const r = rnd(t.seed)
  const { x, y, s, kind } = t
  const n = Math.max(1, Math.min(5, t.n))
  const pine = kind === 'pine'
  const light = pine ? o.pine : kind === 'jungle' ? mixColor(o.leaf, o.pine, 0.5) : o.leaf
  const dark = pine ? o.pineDark : kind === 'jungle' ? mixColor(o.leafDark, o.pineDark, 0.5) : o.leafDark
  const veinInk = mixColor(o.ink, dark, 0.3)
  // 每片叶：叶柄起点 g、叶基 b、叶尖 tip、半宽 W
  const leaves: { g: P; b: P; tip: P; W: number; prof: [number, number][]; veins: number; rise: number }[] = []
  if (kind === 'bush') {
    // 贴地的三片小叶
    const m = Math.min(3, n)
    for (let c = 0; c < m; c++) {
      const cx = x + (c - (m - 1) / 2) * 1.5 * s
      for (const a of [-0.75, 0.7, 0]) {
        const l = s * (a ? 1.05 : 1.4) * (0.9 + r(c * 5 + 3) * 0.2)
        const g: P = [cx + a * 0.25 * s, y + 0.15 * s]
        leaves.push({ g, b: g, tip: [g[0] + Math.sin(a) * l, g[1] - Math.cos(a) * l], W: s * 0.36, prof: OVATE, veins: 0, rise: 0 })
      }
    }
  } else if (kind === 'acacia') {
    // 金合欢：下面单画（扇形叶），这里不排叶片
  } else {
    // 扇形展开：外侧的叶先画，中间最高的一片最后
    const FAN: Record<number, number[]> = { 1: [0], 2: [-0.3, 0.24], 3: [-0.5, 0.44, 0], 4: [-0.7, 0.62, -0.24, 0.2], 5: [-0.84, 0.78, -0.42, 0.38, 0] }
    const flip = r(1) > 0.5 ? -1 : 1
    FAN[n].forEach((a0, i) => {
      const a = a0 * flip + (r(10 + i) - 0.5) * (n > 1 ? 0.1 : 0.22)
      const size = s * (n > 1 ? 0.96 : 1) * (1 - Math.abs(a0) * 0.3)
      const gx = x + a0 * flip * 0.85 * s
      const g: P = [gx, y + 0.2 * s]
      const dir: P = [Math.sin(a), -Math.cos(a)]
      const stem = size * (pine ? 0.4 : 0.55)
      const len = size * (pine ? 2.55 : kind === 'jungle' ? 2.1 : 2.2)
      const b: P = [g[0] + dir[0] * stem, g[1] + dir[1] * stem]
      const tip: P = [b[0] + dir[0] * len, b[1] + dir[1] * len]
      leaves.push({ g, b, tip, W: size * (pine ? 0.4 : kind === 'jungle' ? 1.0 : 0.8), prof: pine ? LANCE : kind === 'jungle' ? CORDATE : OVATE, veins: pine ? 5 : kind === 'jungle' ? 4 : 3, rise: pine ? 0.11 : 0.17 })
    })
  }
  for (const L of leaves) {
    pen.beginPath()
    addLeaf(pen, L.b, L.tip, L.W, L.prof, 0)
    pen.fillStyle = light
    pen.fill()
    if (kind !== 'bush') {
      pen.beginPath()
      addLeaf(pen, L.b, L.tip, L.W, L.prof, 1)
      pen.fillStyle = dark
      pen.fill()
    }
    if (L.veins) {
      pen.beginPath()
      addVeins(pen, L.b, L.tip, L.W, L.prof, L.veins, L.rise)
      pen.strokeStyle = veinInk
      pen.lineWidth = 0.4 * k
      pen.stroke()
    }
    pen.beginPath()
    addLeaf(pen, L.b, L.tip, L.W, L.prof, 0)
    pen.strokeStyle = o.ink
    pen.lineWidth = (kind === 'bush' ? 0.42 : 0.55) * k
    pen.stroke()
    // 叶柄连主脉
    pen.beginPath()
    pen.moveTo(L.g[0], L.g[1])
    pen.lineTo(L.b[0], L.b[1])
    pen.lineTo(L.b[0] + (L.tip[0] - L.b[0]) * 0.9, L.b[1] + (L.tip[1] - L.b[1]) * 0.9)
    pen.lineWidth = (kind === 'bush' ? 0.42 : 0.6) * k
    pen.stroke()
  }
  if (kind === 'acacia') {
    // 扇形叶（银杏式）：细柄托着一面向上张开的扇，扇骨当叶脉
    const c: P = [x, y - 1.05 * s]
    const R = 1.3 * s
    const ry = 0.8
    const a0 = Math.PI * 1.14
    const a1 = Math.PI * 1.86
    const arc = (u: number, rr = R): P => {
      const a = a0 + (a1 - a0) * u
      return [c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr * ry]
    }
    const fan = (u0: number, u1: number) => {
      pen.beginPath()
      pen.moveTo(c[0], c[1])
      const p0 = arc(u0)
      pen.lineTo(p0[0], p0[1])
      const m = 4
      for (let j = 1; j <= m; j++) {
        const ua = u0 + ((u1 - u0) * (j - 0.5)) / m
        const ub = u0 + ((u1 - u0) * j) / m
        const cp = arc(ua, R * 1.07)
        const e = arc(ub)
        pen.quadraticCurveTo(cp[0], cp[1], e[0], e[1])
      }
      pen.closePath()
    }
    fan(0, 1)
    pen.fillStyle = light
    pen.fill()
    fan(0.5, 1)
    pen.fillStyle = dark
    pen.fill()
    pen.beginPath()
    for (const u of [0.2, 0.36, 0.64, 0.8]) {
      const e = arc(u, R * 0.9)
      pen.moveTo(c[0], c[1])
      pen.lineTo(e[0], e[1])
    }
    pen.strokeStyle = veinInk
    pen.lineWidth = 0.4 * k
    pen.stroke()
    fan(0, 1)
    pen.strokeStyle = o.ink
    pen.lineWidth = 0.55 * k
    pen.stroke()
    pen.beginPath()
    pen.moveTo(x, y + 0.2 * s)
    pen.lineTo(c[0], c[1])
    const e = arc(0.5, R * 0.92)
    pen.lineTo(e[0], e[1])
    pen.lineWidth = 0.6 * k
    pen.stroke()
  }
  // 根部的一小横
  const half = (kind === 'bush' ? 0.5 + 0.7 * Math.min(3, n) : 0.45 + 0.42 * n) * s
  pen.beginPath()
  pen.moveTo(x - half, y + 0.2 * s)
  pen.lineTo(x + half, y + 0.2 * s)
  pen.strokeStyle = o.ink
  pen.lineWidth = 0.45 * k
  pen.stroke()
}

// ———————————————————————— 二、云松 ————————————————————————

/** 叶团的上缘：底平、顶上 n 个扇贝形的弧；返回路径（不闭合），从左端到右端 */
function addPadTop(pen: Pen, cx: number, cy: number, w: number, h: number, n: number) {
  const x0 = cx - w / 2
  pen.moveTo(x0, cy)
  for (let j = 0; j < n; j++) {
    const xa = x0 + (w * j) / n
    const xb = x0 + (w * (j + 1)) / n
    const edge = j === 0 || j === n - 1
    // 两端的弧落到底边，中间的弧之间留一个浅凹
    const yb = j === n - 1 ? cy : cy - h * 0.42
    const peak = h * (n === 1 ? 1 : edge ? 0.8 : 1)
    const ya = j === 0 ? cy : cy - h * 0.42
    const cyq = cy - (peak * 2 - (cy - ya + (cy - yb)) / 2)
    const cxq = (xa + xb) / 2 + (n > 1 && j === 0 ? -w * 0.1 : n > 1 && j === n - 1 ? w * 0.1 : 0)
    pen.quadraticCurveTo(cxq, cyq, xb, yb)
  }
}

const pad: SpotDraw = (pen, t, k, o) => {
  const r = rnd(t.seed)
  const green = t.kind === 'jungle' ? mixColor(o.leafDark, o.pine, 0.5) : t.kind === 'pine' ? mixColor(o.pine, o.pineDark, 0.35) : mixColor(o.leaf, o.leafDark, 0.5)
  /** 一片叶团：填色、上缘细线、下缘一道墨线 */
  const drawPad = (cx: number, cy: number, w: number, h: number, n: number) => {
    pen.beginPath()
    addPadTop(pen, cx, cy, w, h, n)
    pen.closePath()
    pen.fillStyle = green
    pen.fill()
    pen.beginPath()
    addPadTop(pen, cx, cy, w, h, n)
    pen.strokeStyle = o.ink
    pen.lineWidth = 0.38 * k
    pen.stroke()
    pen.beginPath()
    pen.moveTo(cx - w / 2, cy)
    pen.lineTo(cx + w / 2, cy)
    pen.lineWidth = 0.6 * k
    pen.stroke()
  }
  const trunk = (pts: P[], w0: number, w1: number) => {
    pen.beginPath()
    addTaper(pen, chaikin(pts, 2), (u) => (w0 + (w1 - w0) * u) * k)
    pen.fillStyle = o.ink
    pen.fill()
  }
  if (t.kind === 'bush') {
    const m = Math.min(3, Math.max(1, t.n))
    for (let c = 0; c < m; c++) {
      const cx = t.x + (c - (m - 1) / 2) * 1.35 * t.s + (r(c + 2) - 0.5) * 0.3 * t.s
      const cy = t.y + (c % 2 ? -0.25 : 0.15) * t.s
      drawPad(cx, cy, t.s * (1.25 + r(c + 5) * 0.3), t.s * 0.62, 3)
    }
    return
  }
  const ms = members(t, t.kind === 'pine' ? 1.0 : 1.2)
  ms.forEach((m, i) => {
    const { x, y, s } = m
    const rr = (j: number) => r(m.q + j)
    // 丛里的树向中间倾，树干交错
    const d = ms.length > 1 ? (m.x < t.x - 0.1 * s ? 1 : m.x > t.x + 0.1 * s ? -1 : i % 2 ? 1 : -1) : rr(1) > 0.5 ? 1 : -1
    if (t.kind === 'pine') {
      // 杉：直干上一层层分开的檐（底平顶圆），越往上越窄，层间露出树干
      const tiers = 4
      pen.beginPath()
      pen.moveTo(x, y + 0.25 * s)
      pen.lineTo(x, y - (0.5 + (tiers - 1) * 0.66) * s)
      pen.strokeStyle = o.ink
      pen.lineWidth = 0.65 * k
      pen.stroke()
      for (let j = 0; j < tiers; j++) {
        const cy = y - 0.5 * s - j * 0.66 * s
        const last = j === tiers - 1
        drawPad(x, cy, s * (1.4 - j * 0.3), s * (last ? 0.7 : 0.44), 1)
      }
      return
    }
    if (t.kind === 'acacia') {
      // 分叉的干托一片宽扁的叶团
      trunk([[x, y + 0.2 * s], [x + 0.08 * s * d, y - 0.55 * s], [x - 0.5 * s, y - 1.2 * s]], 0.75, 0.35)
      trunk([[x + 0.06 * s * d, y - 0.5 * s], [x + 0.55 * s, y - 1.2 * s]], 0.5, 0.3)
      drawPad(x, y - 1.15 * s, 2.5 * s, 0.6 * s, 4)
      return
    }
    const jungle = t.kind === 'jungle'
    // 弯两折的树干
    const top: P = [x + 0.08 * s * d, y - (jungle ? 1.75 : 1.95) * s]
    trunk([[x - 0.05 * s * d, y + 0.22 * s], [x + 0.3 * s * d, y - 0.7 * s], [x - 0.16 * s * d, y - 1.35 * s], top], jungle ? 0.9 : 0.75, 0.32)
    const fat = jungle ? 1.22 : 1
    // 丛里只有最前面的一棵画全三片，后排的省掉低处的一片，免得挤成一团
    if (i === ms.length - 1) drawPad(x + 0.66 * s * d, y - 0.9 * s, 1.25 * s * fat, 0.56 * s * fat, jungle ? 3 : 2)
    drawPad(x - 0.6 * s * d, y - 1.45 * s, 1.2 * s * fat, 0.54 * s * fat, jungle ? 3 : 2)
    drawPad(top[0], top[1] + 0.05 * s, 1.6 * s * fat, 0.7 * s * fat, 3)
  })
}

// ———————————————————————— 三、墨点树 ————————————————————————

const ink: SpotDraw = (pen, t, k, o) => {
  const r = rnd(t.seed)
  const dark = mixColor(o.ink, o.pineDark, 0.3)
  const wash = t.kind === 'pine' ? o.pineDark : o.leafDark
  const trunks: P[][] = []
  const trunkW: [number, number][] = []
  const light: [number, number, number, number, number][] = []
  const heavy: [number, number, number, number, number][] = []
  const strokes: { pts: P[]; w0: number; w1: number }[] = []
  if (t.kind === 'bush') {
    const m = Math.min(3, Math.max(1, t.n))
    for (let c = 0; c < m; c++) {
      const x = t.x + (c - (m - 1) / 2) * 1.4 * t.s
      const y = t.y + (c % 2 ? -0.2 : 0.1) * t.s
      const s = t.s
      // 贴地的一团：淡墨一横点打底，上面两三个浓墨小点，旁边两笔草
      light.push([x, y - 0.12 * s, 1.7 * s, 0.4 * s, 0], [x + 0.1 * s, y - 0.5 * s, 1.1 * s, 0.34 * s, 0])
      heavy.push([x - 0.35 * s, y - 0.4 * s, 0.8 * s, 0.26 * s, -0.1], [x + 0.4 * s, y - 0.3 * s, 0.7 * s, 0.24 * s, 0.12], [x + 0.05 * s, y - 0.75 * s, 0.6 * s, 0.22 * s, 0])
      strokes.push({ pts: [[x - 0.85 * s, y + 0.15 * s], [x - 1.05 * s, y - 0.4 * s]], w0: 0.5, w1: 0.2 }, { pts: [[x + 0.9 * s, y + 0.15 * s], [x + 1.0 * s, y - 0.3 * s]], w0: 0.5, w1: 0.2 })
    }
  } else {
    const ms = members(t, t.kind === 'pine' ? 1.15 : 0.9)
    for (const m of ms) {
      const { s } = m
      const rr = (j: number) => r(m.q + j)
      // 丛：根部相互靠拢，树干向外散开
      const bx = ms.length > 1 ? t.x + (m.x - t.x) * 0.45 : m.x
      const by = m.y
      const x = m.x
      const d = ms.length > 1 ? (m.x >= t.x ? 1 : -1) : rr(1) > 0.5 ? 1 : -1
      if (t.kind === 'pine') {
        // 直干上叠三层"个"字
        const top = by - 2.75 * s
        trunks.push([[bx, by + 0.25 * s], [(bx + x) / 2, by - 1.2 * s], [x, top]])
        trunkW.push([0.95, 0.3])
        const tiers = 3
        for (let j = 0; j < tiers; j++) {
          const u = 0.3 + j * 0.24
          const cx = bx + (x - bx) * Math.min(1, u * 1.2)
          const ty = by + 0.25 * s + (top - by - 0.25 * s) * u
          const hw = s * 0.82 * (1 - j * 0.24)
          for (const sg of [-1, 1]) {
            strokes.push({ pts: [[cx, ty - 0.42 * s], [cx + sg * hw * 0.55, ty - 0.12 * s], [cx + sg * hw, ty + 0.2 * s]], w0: 0.7, w1: 0.2 })
          }
          light.push([cx, ty - 0.02 * s, hw * 1.9, 0.36 * s, 0])
        }
        continue
      }
      if (t.kind === 'acacia') {
        trunks.push([[bx, by + 0.2 * s], [bx + 0.05 * s * d, by - 0.75 * s], [bx - 0.6 * s, by - 1.4 * s]], [[bx + 0.04 * s * d, by - 0.7 * s], [bx + 0.62 * s, by - 1.4 * s]])
        trunkW.push([1.0, 0.3], [0.6, 0.3])
        light.push([bx - 0.75 * s, by - 1.5 * s, 1.5 * s, 0.32 * s, -0.06], [bx + 0.75 * s, by - 1.5 * s, 1.5 * s, 0.32 * s, 0.06], [bx, by - 1.68 * s, 1.5 * s, 0.32 * s, 0])
        heavy.push([bx - 0.35 * s, by - 1.74 * s, 1.1 * s, 0.24 * s, 0], [bx + 0.5 * s, by - 1.62 * s, 0.95 * s, 0.22 * s, 0])
        continue
      }
      const h = (t.kind === 'jungle' ? 2.0 : 1.8) * s
      const top: P = [x + 0.1 * s * d, by - h]
      trunks.push([[bx, by + 0.25 * s], [bx + (x - bx) * 0.5 + 0.14 * s * d, by - h * 0.35], [x - 0.06 * s * d, by - h * 0.7], top])
      trunkW.push([1.0, 0.35])
      if (t.kind === 'jungle') {
        // 垂叶点：从干顶向四周披下
        const A = [Math.PI - 0.3, Math.PI + 0.5, -Math.PI / 2 - 0.1, -0.5, 0.3]
        A.forEach((a, j) => {
          const cx = top[0] + Math.cos(a) * 0.62 * s
          const cy = top[1] + Math.sin(a) * 0.62 * s
          ;(j % 2 ? heavy : light).push([cx, cy, 1.3 * s, (j % 2 ? 0.26 : 0.34) * s, a])
        })
        continue
      }
      // 侧枝一笔
      strokes.push({ pts: [[x - 0.03 * s * d, by - h * 0.62], [x - 0.5 * s * d, by - h * 0.95]], w0: 0.5, w1: 0.2 })
      const j = (q: number, a: number) => (rr(q) - 0.5) * a * s
      // 树冠：淡墨点叠成三排，浓墨点压在上面
      light.push(
        [x - 0.5 * s * d + j(2, 0.2), by - h * 0.98 + j(3, 0.1), 1.3 * s, 0.4 * s, j(4, 0.08) / s],
        [x + 0.5 * s * d + j(5, 0.2), by - h * 1.08 + j(6, 0.1), 1.25 * s, 0.4 * s, 0],
        [x - 0.1 * s * d + j(7, 0.2), by - h * 1.3, 1.3 * s, 0.4 * s, 0],
        [x + 0.12 * s * d, by - h * 1.55, 0.9 * s, 0.36 * s, 0],
      )
      heavy.push([x - 0.15 * s * d + j(8, 0.2), by - h * 1.18, 0.95 * s, 0.27 * s, 0], [x + 0.42 * s * d, by - h * 0.93 + j(9, 0.1), 0.8 * s, 0.24 * s, 0.1 * d], [x - 0.42 * s * d, by - h * 1.42, 0.7 * s, 0.24 * s, -0.08 * d], [x + 0.3 * s * d, by - h * 1.4, 0.6 * s, 0.22 * s, 0])
    }
  }
  // 淡墨点在下，树干居中，浓墨点在上
  if (light.length) {
    pen.beginPath()
    for (const [x, y, w, h, a] of light) addDab(pen, x, y, w, h, a)
    pen.fillStyle = wash
    pen.globalAlpha = 0.8
    pen.fill()
    pen.globalAlpha = 1
  }
  if (trunks.length || strokes.length) {
    pen.beginPath()
    trunks.forEach((pts, i) => addTaper(pen, pts.length > 2 ? chaikin(pts, 2) : pts, (u) => (trunkW[i][0] + (trunkW[i][1] - trunkW[i][0]) * u) * k))
    for (const st of strokes) addTaper(pen, st.pts.length > 2 ? chaikin(st.pts, 1) : st.pts, (u) => (st.w0 + (st.w1 - st.w0) * u) * k)
    pen.fillStyle = dark
    pen.fill()
  }
  if (heavy.length) {
    pen.beginPath()
    for (const [x, y, w, h, a] of heavy) addDab(pen, x, y, w, h, a)
    pen.fillStyle = dark
    pen.globalAlpha = 0.88
    pen.fill()
    pen.globalAlpha = 1
  }
}

// ———————————————————————— 四、影绘树 ————————————————————————

/** 俯视的花形树冠：lobes 瓣 */
function addRosette(pen: Pen, cx: number, cy: number, r: number, lobes: number, rot: number) {
  for (let j = 0; j <= lobes; j++) {
    const a = rot + (j / lobes) * Math.PI * 2
    const px = cx + Math.cos(a) * r * 0.8
    const py = cy + Math.sin(a) * r * 0.8
    if (j === 0) pen.moveTo(px, py)
    else {
      const q = a - Math.PI / lobes
      pen.quadraticCurveTo(cx + Math.cos(q) * r * 1.36, cy + Math.sin(q) * r * 1.36, px, py)
    }
  }
  pen.closePath()
}
function addStar(pen: Pen, cx: number, cy: number, r: number, n: number, rot: number, inner = 0.48) {
  for (let j = 0; j < n * 2; j++) {
    const a = rot + (j / (n * 2)) * Math.PI * 2
    const rr = j % 2 ? r * inner : r * 1.12
    const px = cx + Math.cos(a) * rr
    const py = cy + Math.sin(a) * rr
    if (j === 0) pen.moveTo(px, py)
    else pen.lineTo(px, py)
  }
  pen.closePath()
}

const plan: SpotDraw = (pen, t, k, o) => {
  const r = rnd(t.seed)
  const pale = t.kind === 'pine' ? o.pine : t.kind === 'jungle' ? mixColor(o.leaf, o.pine, 0.5) : mixColor(o.leaf, o.paper, 0.12)
  // 各朵：圆心与半径
  const crowns: { x: number; y: number; r: number; q: number }[] = []
  if (t.kind === 'bush') {
    const m = Math.min(3, Math.max(1, t.n))
    for (let c = 0; c < m; c++) {
      const cx = t.x + (c - (m - 1) / 2) * 1.2 * t.s
      const cy = t.y - 0.3 * t.s + (c % 2 ? -0.3 : 0.1) * t.s
      for (const [dx, dy, rr] of [[-0.36, 0.05, 0.36], [0.34, 0.1, 0.34], [0, -0.3, 0.4]]) crowns.push({ x: cx + dx * t.s, y: cy + dy * t.s, r: rr * t.s, q: 60 + c * 10 })
    }
  } else {
    for (const m of members(t, 0.82)) {
      const rad = m.s * (t.kind === 'jungle' ? 0.98 : t.kind === 'acacia' ? 1.05 : t.kind === 'pine' ? 0.8 : 0.86)
      crowns.push({ x: m.x, y: m.y - rad * 0.85, r: rad, q: m.q })
    }
  }
  // 投影：落在每朵东南的一小片横排线（椭圆形），被树冠盖住一半
  pen.beginPath()
  for (const c of crowns) {
    const ex = c.x + c.r * 0.72
    const ey = c.y + c.r * 0.62
    const rx = c.r * 0.98
    const ry = c.r * 0.6
    const rows = t.kind === 'bush' ? 2 : 4
    for (let j = 0; j < rows; j++) {
      const v = -0.62 + (1.4 * j) / (rows - 1 || 1)
      if (Math.abs(v) >= 1) continue
      const hl = rx * Math.sqrt(1 - v * v)
      pen.moveTo(ex - hl, ey + v * ry)
      pen.lineTo(ex + hl, ey + v * ry)
    }
  }
  pen.strokeStyle = o.ink
  pen.lineWidth = 0.42 * k
  pen.globalAlpha = 0.8
  pen.stroke()
  pen.globalAlpha = 1
  for (const c of crowns) {
    const rot = r(c.q + 1) * Math.PI
    const shape = () => {
      pen.beginPath()
      if (t.kind === 'pine') addStar(pen, c.x, c.y, c.r, 6, rot)
      else if (t.kind === 'acacia') addEllipse(pen, c.x, c.y, c.r, c.r * 0.92)
      else if (t.kind === 'bush') addEllipse(pen, c.x, c.y, c.r)
      else addRosette(pen, c.x, c.y, c.r, t.kind === 'jungle' ? 8 : 5 + Math.floor(r(c.q + 2) * 2), rot)
    }
    shape()
    pen.fillStyle = pale
    pen.fill()
    if (t.kind === 'pine') {
      // 针叶：从心到各尖的细线（俯视的枝）
      pen.beginPath()
      for (let j = 0; j < 6; j++) {
        const a = rot + (j / 6) * Math.PI * 2
        pen.moveTo(c.x, c.y)
        pen.lineTo(c.x + Math.cos(a) * c.r * 0.95, c.y + Math.sin(a) * c.r * 0.95)
      }
      pen.strokeStyle = o.ink
      pen.lineWidth = 0.35 * k
      pen.stroke()
    } else {
      // 暗面：东南半边的几道斜排线
      pen.beginPath()
      const rr = c.r * (t.kind === 'acacia' ? 0.86 : 0.74)
      for (const d of t.kind === 'bush' ? [0.3] : [0.2, 0.46, 0.7]) {
        const hl = Math.sqrt(Math.max(0, rr * rr - d * d * c.r * c.r)) * 0.9
        const mx = c.x + d * c.r * 0.7071
        const my = c.y + d * c.r * 0.7071
        pen.moveTo(mx + hl * 0.7071, my - hl * 0.7071)
        pen.lineTo(mx - hl * 0.7071, my + hl * 0.7071)
      }
      pen.strokeStyle = o.ink
      pen.lineWidth = 0.4 * k
      pen.stroke()
    }
    if (t.kind === 'acacia') {
      // 伞骨
      pen.beginPath()
      for (let j = 0; j < 7; j++) {
        const a = rot + (j / 7) * Math.PI * 2
        pen.moveTo(c.x, c.y)
        pen.lineTo(c.x + Math.cos(a) * c.r * 0.9, c.y + Math.sin(a) * c.r * 0.83)
      }
      pen.lineWidth = 0.35 * k
      pen.stroke()
    }
    shape()
    pen.lineWidth = 0.5 * k
    pen.stroke()
    if (t.kind === 'pine' || t.kind === 'acacia') {
      // 树干的截面：圆心一点
      pen.beginPath()
      addEllipse(pen, c.x, c.y, 0.38 * k)
      pen.fillStyle = o.ink
      pen.fill()
    }
  }
}

// ———————————————————————— 五、木刻树 ————————————————————————

const block: SpotDraw = (pen, t, k, o) => {
  const r = rnd(t.seed)
  const mass = t.kind === 'pine' ? mixColor(o.ink, o.pineDark, 0.32) : mixColor(o.ink, o.leafDark, 0.3)
  const cut = mixColor(o.leaf, o.paper, 0.55)
  const trunkPath: (() => void)[] = []
  const massPath: (() => void)[] = []
  const cuts: (() => void)[] = []
  let gx0 = Infinity
  let gx1 = -Infinity
  /** 根部外张的树干 */
  const flare = (x: number, y: number, s: number, top: number, w = 1) => {
    trunkPath.push(() => {
      pen.moveTo(x - 0.4 * s * w, y + 0.25 * s)
      pen.quadraticCurveTo(x - 0.13 * s * w, y + 0.1 * s, x - 0.11 * s * w, y - 0.5 * s)
      pen.lineTo(x - 0.08 * s * w, top)
      pen.lineTo(x + 0.08 * s * w, top)
      pen.lineTo(x + 0.11 * s * w, y - 0.5 * s)
      pen.quadraticCurveTo(x + 0.13 * s * w, y + 0.1 * s, x + 0.4 * s * w, y + 0.25 * s)
      pen.closePath()
    })
    gx0 = Math.min(gx0, x - 0.75 * s)
    gx1 = Math.max(gx1, x + 0.85 * s)
  }
  /** 一道刻痕：圆心、半径、起止角 */
  const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number) => {
    cuts.push(() => {
      const m = 4
      const pts: P[] = []
      for (let j = 0; j <= m; j++) {
        const a = a0 + ((a1 - a0) * j) / m
        pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
      }
      pen.moveTo(pts[0][0], pts[0][1])
      curveOn(pen, pts)
    })
  }
  if (t.kind === 'bush') {
    const m = Math.min(3, Math.max(1, t.n))
    for (let c = 0; c < m; c++) {
      const x = t.x + (c - (m - 1) / 2) * 1.5 * t.s
      const y = t.y + 0.2 * t.s
      const s = t.s
      const sd = t.seed + c * 13
      massPath.push(() => {
        pen.moveTo(x - 0.95 * s, y)
        pen.quadraticCurveTo(x - 1.05 * s, y - 0.75 * s, x - 0.35 * s, y - 0.8 * s)
        pen.quadraticCurveTo(x + (hashish(sd) - 0.5) * 0.3 * s, y - 1.3 * s, x + 0.4 * s, y - 0.78 * s)
        pen.quadraticCurveTo(x + 1.05 * s, y - 0.7 * s, x + 0.95 * s, y)
        pen.closePath()
      })
      arc(x - 0.3 * s, y - 0.25 * s, 0.4 * s, 0.38 * s, Math.PI * 1.05, Math.PI * 1.55)
      arc(x + 0.35 * s, y - 0.2 * s, 0.36 * s, 0.34 * s, Math.PI * 1.1, Math.PI * 1.6)
      gx0 = Math.min(gx0, x - 1.1 * s)
      gx1 = Math.max(gx1, x + 1.2 * s)
    }
  } else {
    for (const m of members(t, 1.0)) {
      const { x, y, s } = m
      const rr = (j: number) => r(m.q + j)
      if (t.kind === 'pine') {
        // 锯齿边的冷杉剪影
        const top = y - 3.0 * s
        const n = 4
        massPath.push(() => {
          const R: P[] = []
          for (let j = 0; j < n; j++) {
            const yy = top + (j + 1) * 0.62 * s
            const hw = (0.3 + 0.18 * j) * s
            R.push([hw, yy], [hw * 0.42, yy - 0.1 * s])
          }
          R.pop()
          pen.moveTo(x, top)
          for (const [dx, yy] of R) pen.lineTo(x + dx, yy)
          for (let j = R.length - 1; j >= 0; j--) pen.lineTo(x - R[j][0], R[j][1])
          pen.closePath()
        })
        trunkPath.push(() => {
          pen.moveTo(x - 0.13 * s, y - 0.6 * s)
          pen.lineTo(x + 0.13 * s, y - 0.6 * s)
          pen.lineTo(x + 0.2 * s, y + 0.25 * s)
          pen.lineTo(x - 0.2 * s, y + 0.25 * s)
          pen.closePath()
        })
        cuts.push(() => {
          pen.moveTo(x, top + 0.55 * s)
          pen.lineTo(x, y - 0.75 * s)
          // 两侧各两道短刻痕，顺着枝的方向
          for (const [f, l] of [[0.5, 0.22], [0.78, 0.32]] as const) {
            const yy = top + (y - 0.6 * s - top) * f
            pen.moveTo(x - l * s, yy + 0.16 * s)
            pen.lineTo(x - 0.08 * s, yy - 0.06 * s)
            pen.moveTo(x + l * s, yy + 0.16 * s)
            pen.lineTo(x + 0.08 * s, yy - 0.06 * s)
          }
        })
        gx0 = Math.min(gx0, x - 0.9 * s)
        gx1 = Math.max(gx1, x + 1.0 * s)
        continue
      }
      if (t.kind === 'acacia') {
        trunkPath.push(() => {
          addTaper(pen, [[x, y + 0.25 * s], [x, y - 0.6 * s], [x - 0.65 * s, y - 1.3 * s]], (u) => (1.5 - 0.9 * u) * k)
          addTaper(pen, [[x, y - 0.55 * s], [x + 0.65 * s, y - 1.3 * s]], (u) => (1.0 - 0.4 * u) * k)
        })
        massPath.push(() => {
          pen.moveTo(x - 1.4 * s, y - 1.25 * s)
          pen.quadraticCurveTo(x - 1.0 * s, y - 1.95 * s, x, y - 1.9 * s)
          pen.quadraticCurveTo(x + 1.05 * s, y - 1.95 * s, x + 1.4 * s, y - 1.25 * s)
          pen.quadraticCurveTo(x, y - 1.05 * s, x - 1.4 * s, y - 1.25 * s)
          pen.closePath()
        })
        arc(x, y - 1.2 * s, 1.0 * s, 0.5 * s, Math.PI * 1.12, Math.PI * 1.7)
        gx0 = Math.min(gx0, x - 0.8 * s)
        gx1 = Math.max(gx1, x + 0.9 * s)
        continue
      }
      const jungle = t.kind === 'jungle'
      flare(x, y, s, y - 1.1 * s, jungle ? 1.25 : 1)
      const cy = y - (jungle ? 1.75 : 1.8) * s
      const R = (jungle ? 0.98 : 0.86) * s
      const sd = t.seed + m.q
      if (jungle) {
        // 穹顶形的大冠，底边平
        massPath.push(() => {
          pen.moveTo(x - R * 1.08, cy + R * 0.55)
          pen.quadraticCurveTo(x - R * 1.2, cy - R * 0.9, x, cy - R * 1.0)
          pen.quadraticCurveTo(x + R * 1.2, cy - R * 0.9, x + R * 1.08, cy + R * 0.55)
          pen.quadraticCurveTo(x, cy + R * 0.25, x - R * 1.08, cy + R * 0.55)
          pen.closePath()
        })
        // 从冠心放射的刻痕
        cuts.push(() => {
          for (const a of [-2.55, -1.95, -1.3, -0.7]) {
            pen.moveTo(x + Math.cos(a) * R * 0.25, cy + R * 0.2 + Math.sin(a) * R * 0.25)
            pen.lineTo(x + Math.cos(a) * R * 0.82, cy + R * 0.2 + Math.sin(a) * R * 0.86)
          }
        })
      } else {
        // 三瓣并成的块面
        massPath.push(() => {
          addBlob(pen, x, cy - R * 0.28, R * 0.74, R * 0.68, 7, 0.1, sd)
          addBlob(pen, x - R * 0.56, cy + R * 0.22, R * 0.6, R * 0.52, 6, 0.1, sd + 1)
          addBlob(pen, x + R * 0.56, cy + R * 0.26, R * 0.6, R * 0.52, 6, 0.1, sd + 2)
        })
        const ja = (rr(3) - 0.5) * 0.3
        arc(x - R * 0.02, cy - R * 0.22, R * 0.46, R * 0.42, Math.PI * 1.05 + ja, Math.PI * 1.62 + ja)
        arc(x - R * 0.56, cy + R * 0.3, R * 0.36, R * 0.32, Math.PI * 1.0, Math.PI * 1.5)
        arc(x + R * 0.5, cy + R * 0.34, R * 0.34, R * 0.3, Math.PI * 1.08, Math.PI * 1.6)
      }
    }
  }
  if (trunkPath.length) {
    pen.beginPath()
    for (const f of trunkPath) f()
    pen.fillStyle = o.ink
    pen.fill()
  }
  pen.beginPath()
  for (const f of massPath) f()
  pen.fillStyle = mass
  pen.fill()
  if (cuts.length) {
    pen.beginPath()
    for (const f of cuts) f()
    pen.strokeStyle = cut
    pen.lineWidth = 0.6 * k
    pen.stroke()
  }
  // 地面的一刀
  pen.beginPath()
  pen.moveTo(gx0, t.y + 0.27 * t.s)
  pen.lineTo(gx1, t.y + 0.27 * t.s)
  pen.strokeStyle = o.ink
  pen.lineWidth = 0.75 * k
  pen.stroke()
}
/** 0~1 的派生随机数（单个种子） */
const hashish = (seed: number) => rnd(seed)(7)

// ———————————————————————— 六、几何树 ————————————————————————

const geo: SpotDraw = (pen, t, k, o) => {
  const r = rnd(t.seed)
  const pine = t.kind === 'pine'
  // 不描边，靠色块自己从底图上跳出来：两种色调都比别的画法深一档
  const A = pine ? mixColor(o.pine, o.pineDark, 0.45) : t.kind === 'jungle' ? mixColor(o.leafDark, o.pine, 0.5) : mixColor(o.leaf, o.leafDark, 0.6)
  const B = pine ? mixColor(o.pineDark, o.ink, 0.22) : t.kind === 'jungle' ? mixColor(o.pineDark, o.ink, 0.12) : mixColor(o.leafDark, o.pineDark, 0.7)
  // 丛：立在同一道地面线上，中间大两边小，色调交替
  const ROW: Record<number, [number, number][]> = {
    1: [[0, 1]],
    2: [[-0.55, 0.8], [0.5, 1.05]],
    3: [[-1.0, 0.78], [0.95, 0.7], [0, 1.1]],
    4: [[-1.5, 0.66], [0.55, 0.74], [1.4, 0.6], [-0.45, 1.1]],
    5: [[-1.75, 0.6], [1.7, 0.56], [-0.9, 0.86], [0.85, 0.78], [0, 1.14]],
  }
  const n = Math.max(1, Math.min(t.kind === 'bush' ? 3 : 5, t.n))
  const flip = r(1) > 0.5 ? -1 : 1
  const base = t.y + 0.2 * t.s
  const row = ROW[n].map(([dx, m], i) => ({ x: t.x + dx * flip * t.s, s: t.s * m, tone: (i + (r(2) > 0.5 ? 1 : 0)) % 2 }))
  // 地面线
  let x0 = Infinity
  let x1 = -Infinity
  for (const m of row) {
    x0 = Math.min(x0, m.x - 0.75 * m.s)
    x1 = Math.max(x1, m.x + 0.75 * m.s)
  }
  pen.beginPath()
  pen.moveTo(x0, base)
  pen.lineTo(x1, base)
  // 细干：从地面到形的下缘
  const stemTop = (s: number) => (t.kind === 'bush' ? base : t.kind === 'pine' ? base - 0.7 * s : t.kind === 'acacia' ? base - 1.5 * s : t.kind === 'jungle' ? base - 1.15 * s : base - 1.15 * s)
  if (t.kind !== 'bush')
    for (const m of row) {
      pen.moveTo(m.x, base)
      pen.lineTo(m.x, stemTop(m.s))
      if (t.kind === 'acacia') {
        // 伞骨：两道斜线
        pen.moveTo(m.x, base - 0.75 * m.s)
        pen.lineTo(m.x - 0.75 * m.s, base - 1.5 * m.s)
        pen.moveTo(m.x, base - 0.75 * m.s)
        pen.lineTo(m.x + 0.75 * m.s, base - 1.5 * m.s)
      }
    }
  pen.strokeStyle = o.ink
  pen.lineWidth = 0.55 * k
  pen.stroke()
  const inner: P[][] = []
  for (const tone of [0, 1]) {
    let any = false
    pen.beginPath()
    for (const m of row) {
      if (m.tone !== tone) continue
      any = true
      const { x, s } = m
      if (t.kind === 'bush') {
        // 贴地的半圆
        halfDisc(pen, x, base, 0.85 * s, 0.75 * s)
      } else if (pine) {
        pen.moveTo(x, base - 3.0 * s)
        pen.lineTo(x + 0.7 * s, base - 0.7 * s)
        pen.lineTo(x - 0.7 * s, base - 0.7 * s)
        pen.closePath()
        inner.push([[x, base - 0.7 * s], [x, base - 1.75 * s]])
      } else if (t.kind === 'acacia') {
        halfDisc(pen, x, base - 1.5 * s, 1.35 * s, 0.55 * s)
      } else if (t.kind === 'jungle') {
        halfDisc(pen, x, base - 1.15 * s, 0.98 * s, 1.25 * s)
        inner.push([[x, base - 1.15 * s], [x, base - 1.75 * s]])
      } else {
        addEllipse(pen, x, base - 1.95 * s, 0.82 * s)
        inner.push([[x, base - 1.13 * s], [x, base - 1.95 * s]])
      }
    }
    if (!any) continue
    pen.fillStyle = tone ? B : A
    pen.globalAlpha = 0.92
    pen.fill()
    pen.globalAlpha = 1
  }
  // 形里的一道纸色细线：树干在形内的留白
  if (inner.length) {
    pen.beginPath()
    for (const l of inner) addLine(pen, l)
    pen.strokeStyle = o.paper
    pen.lineWidth = 0.5 * k
    pen.stroke()
  }
}
/** 底边平的半椭圆：圆心在底边中点 */
function halfDisc(pen: Pen, cx: number, cy: number, rx: number, ry: number) {
  const q = 0.9
  pen.moveTo(cx - rx, cy)
  pen.quadraticCurveTo(cx - rx, cy - ry * q, cx - rx * 0.5, cy - ry * 0.92)
  pen.quadraticCurveTo(cx, cy - ry * 1.08, cx + rx * 0.5, cy - ry * 0.92)
  pen.quadraticCurveTo(cx + rx, cy - ry * q, cx + rx, cy)
  pen.closePath()
}

export const TREE_STYLES: SymbolStyle[] = [
  treeStyle('vein', '叶脉树', '整棵树画成一片叶：树干即主脉，两侧几对侧脉；针叶是细长的披针叶，小丛是同一处基部展开的一把叶。', vein),
  treeStyle('pad', '云松', '屏风画里的松：弯折的树干托着几片底平顶圆的扁叶团，下缘一道墨线；杉是直干上一层层分开的檐。', pad),
  treeStyle('ink', '墨点树', '山水画的点叶树：一笔有粗细的树干，树冠是几个横向墨点，淡墨在下、浓墨在上，没有轮廓线。', ink),
  treeStyle('plan', '影绘树', '铜版地形图的俯视树：花形树冠（针叶为星形），东南半边几道斜排线当暗面，地上落一小片横排线的投影。', plan),
  treeStyle('block', '木刻树', '木刻：根部外张的粗干、深色块面的树冠，上面用浅色刻出几道弧；针叶是锯齿边的剪影。', block),
  treeStyle('geo', '几何树', '圆、三角、半圆立在一根细线上，平涂、不描边；小丛的形大小不一、两种色调相互交叠。', geo),
]
