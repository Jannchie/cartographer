/**
 * 【实验】山（含丘陵）的六种画法。每种画法自己处理四种规模：
 * 丘陵、孤峰、短山脊、大山脉（主脊连贯成链，支脉与边缘的低山降一级）。
 */
import { fnoise } from '../fields'
import type { Pen } from '../glyphBatch'
import { addBlob, addCurve, addDab, addLine, addTaper, mixColor, resample, rnd, type P } from './brush'
import type { SymbolStyle } from './index'
import type { Chain, Peak } from './terrain'

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpP = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

function fillPoly(pen: Pen, pts: P[], color: string, alpha = 1) {
  pen.beginPath()
  addLine(pen, pts, true)
  pen.fillStyle = color
  pen.globalAlpha = alpha
  pen.fill()
  pen.globalAlpha = 1
}
function strokeLine(pen: Pen, pts: P[], color: string, width: number, alpha = 1, close = false) {
  pen.beginPath()
  addLine(pen, pts, close)
  pen.strokeStyle = color
  pen.lineWidth = width
  pen.globalAlpha = alpha
  pen.stroke()
  pen.globalAlpha = 1
}

/** 山体的半宽与高（像素）：与现有画法的量级相同 */
function dims(p: { s: number; t: number; seed: number }) {
  const r = rnd(p.seed)
  return { r, w: p.s * (0.8 + r(1) * 0.3), h: p.s * (0.95 + r(2) * 0.35 + p.t * 0.4) }
}

/** 每顶点给笔宽的一笔（闭合形，用 fill 画）；sy 为法向在纵向的压缩（俯瞰的台面用） */
function addBrush(pen: Pen, pts: P[], widths: number[], sy = 1) {
  const n = pts.length
  if (n < 2) return
  const L: P[] = []
  const Rr: P[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    let dx = b[0] - a[0]
    let dy = b[1] - a[1]
    const d = Math.hypot(dx, dy) || 1
    dx /= d
    dy /= d
    const w = widths[i] / 2
    L.push([pts[i][0] - dy * w, pts[i][1] + dx * w * sy])
    Rr.push([pts[i][0] + dy * w, pts[i][1] - dx * w * sy])
  }
  pen.moveTo(L[0][0], L[0][1])
  for (let i = 1; i < n; i++) pen.lineTo(L[i][0], L[i][1])
  for (let i = n - 1; i >= 0; i--) pen.lineTo(Rr[i][0], Rr[i][1])
  pen.closePath()
}

/** Douglas–Peucker 简化 */
function simplifyP(pts: P[], tol: number): P[] {
  const n = pts.length
  if (n < 3) return pts
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const dx = pts[b][0] - pts[a][0]
    const dy = pts[b][1] - pts[a][1]
    const L = Math.hypot(dx, dy) || 1
    let best = -1
    let bd = tol
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - pts[a][0]) * dy - (pts[i][1] - pts[a][1]) * dx) / L
      if (d > bd) {
        bd = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

// ———————————————————————— 侧视的连屏：若干山头合成一道连续的剪影 ————————————————————————

/** 一座山头：底边中点 (x, y)、半宽、高 */
interface Hump {
  x: number
  y: number
  w: number
  h: number
  seed: number
  /** 山峰本身（鞍部、肩部这些补出来的山头没有） */
  peak?: Peak
}

/** 把山链拆成几道屏：左右相邻（横向为主）的山峰连成一屏，南北叠着的各自成屏、前后遮叠 */
function screensOf(c: Chain): Peak[][] {
  const out: Peak[][] = []
  let cur: Peak[] = [c.nodes[0]]
  let dir = 0
  for (let i = 1; i < c.nodes.length; i++) {
    const a = c.nodes[i - 1]
    const b = c.nodes[i]
    const dx = b.x - a.x
    const d = Math.sign(dx)
    if (Math.abs(dx) > Math.abs(b.y - a.y) * 0.7 && (dir === 0 || d === dir) && cur.length < 6) {
      cur.push(b)
      dir = d
    } else {
      out.push(cur)
      cur = [b]
      dir = 0
    }
  }
  out.push(cur)
  return out
}

/** 一屏的山头：各山峰、相邻两峰之间的鞍部；孤峰另补两肩。low 为边缘低山的压低倍数 */
function humpsOf(nodes: Peak[], c: Chain, saddle: number, shoulders: boolean): Hump[] {
  const out: Hump[] = []
  const sorted = [...nodes].sort((a, b) => a.x - b.x)
  sorted.forEach((p, i) => {
    const { w, h, r } = dims(p)
    const low = c.main ? 1 : 0.82
    out.push({ x: p.x + (r(3) - 0.5) * w * 0.3, y: p.y, w, h: h * low, seed: p.seed, peak: p })
    const q = sorted[i + 1]
    if (q) {
      const d = dims(q)
      const dist = Math.hypot(q.x - p.x, q.y - p.y)
      out.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, w: dist * 0.62 + Math.min(w, d.w) * 0.2, h: Math.min(h, d.h) * low * saddle, seed: p.seed + 7 })
    }
  })
  if (shoulders && nodes.length === 1) {
    const p = nodes[0]
    const { w, h, r } = dims(p)
    const side = r(20) > 0.5 ? 1 : -1
    out.push({ x: p.x - side * w * 0.66, y: p.y, w: w * 0.62, h: h * (0.46 + r(21) * 0.12), seed: p.seed + 11 })
    if (c.kind === 'solo') out.push({ x: p.x + side * w * 0.72, y: p.y, w: w * 0.5, h: h * (0.3 + r(22) * 0.12), seed: p.seed + 13 })
  }
  return out
}

/** 各山头外形的上包络：返回等距采样的顶线与底线；shape(d, 山头) 给出离中线 d（−1~1）处的相对高度 */
function envelope(humps: Hump[], shape: (d: number, hp: Hump, x: number) => number, step: number) {
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
  const n = Math.max(2, Math.ceil((x1 - x0) / step))
  const top: P[] = []
  const base: P[] = []
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n
    const b = baseAt(x)
    let hh = 0
    for (const hp of humps) {
      const d = (x - hp.x) / hp.w
      if (d <= -1 || d >= 1) continue
      hh = Math.max(hh, hp.h * shape(d, hp, x))
    }
    top.push([x, b - hh])
    base.push([x, b])
  }
  return { top, base, baseAt, x0, x1 }
}
/** 顶线上横坐标 x 处的纵坐标 */
function topAt(top: P[], x: number) {
  if (x <= top[0][0]) return top[0][1]
  for (let i = 1; i < top.length; i++) if (x <= top[i][0]) return lerp(top[i - 1][1], top[i][1], (x - top[i - 1][0]) / (top[i][0] - top[i - 1][0] || 1))
  return top[top.length - 1][1]
}

/** 嶙峋的山头：左右坡各带一个肩的折线 */
function crag(d: number, hp: Hump) {
  const r = rnd(hp.seed)
  const a = Math.abs(d)
  const [s1, f1, s2, f2] = d < 0 ? [0.2 + r(11) * 0.1, 0.7 + r(12) * 0.12, 0.5 + r(13) * 0.12, 0.38 + r(14) * 0.14] : [0.16 + r(15) * 0.1, 0.68 + r(16) * 0.12, 0.52 + r(17) * 0.14, 0.3 + r(18) * 0.12]
  // 顶部收成圆头（峦头），不是尖角
  if (a < s1) return 1 - (1 - f1) * (a / s1) ** 1.8
  if (a < s2) return f1 - (f1 - f2) * ((a - s1) / (s2 - s1))
  return f2 * (1 - (a - s2) / (1 - s2))
}

// ———————————————————————— 一、连嶂 ————————————————————————

/**
 * 连嶂：东亚舆图与山水的画法。山链上左右相邻的山峰连成一道屏，一笔有顿挫的墨线勾出连绵的山脊，
 * 披麻皴顺坡垂下，山脊上点苔；大山脉在主脊后面再衬一层淡色的远山。
 */
const screen: SymbolStyle = {
  id: 'screen',
  name: '连嶂',
  desc: '舆图与山水的笔意：一笔勾出连绵的山脊，披麻皴顺坡垂下，山脊点苔；大山脉后衬淡色远山，山脚不封口。',
  draw(T, o, out) {
    const k = T.k
    const far = mixColor(o.shadow, o.paper, 0.45)
    for (const c of T.chains) {
      for (const nodes of screensOf(c)) {
        const humps = humpsOf(nodes, c, 0.56, true)
        const big = c.kind === 'range' && c.main
        const yMax = Math.max(...nodes.map((p) => p.y))
        out.item(yMax, (pen) => {
          // 远山：主脊后面错开半个身位的一层，只平涂、不勾线
          if (big) {
            const ghosts: Hump[] = humps.map((hp, i) => ({ x: hp.x + hp.w * (i % 2 ? 0.5 : -0.42), y: hp.y - hp.h * 0.16, w: hp.w * 1.15, h: hp.h * (hp.peak ? 0.92 : 1.45), seed: hp.seed + 101 }))
            const g = envelope(ghosts, crag, 1.6 * k)
            const top = simplifyP(g.top, 0.45 * k)
            pen.beginPath()
            addCurve(pen, [...top, ...g.base.slice().reverse()], true)
            pen.fillStyle = far
            pen.fill()
            pen.beginPath()
            addCurve(pen, top)
            pen.strokeStyle = o.ink
            pen.lineWidth = 0.45 * k
            pen.globalAlpha = 0.32
            pen.stroke()
            pen.globalAlpha = 1
          }
          const env = envelope(humps, crag, 1.3 * k)
          const top = simplifyP(env.top, 0.4 * k)
          const hMax = Math.max(...humps.map((hp) => hp.h))
          // 山体：底边向下微鼓、不勾线
          pen.beginPath()
          addLine(pen, top)
          const n = env.base.length
          for (let i = n - 1; i >= 0; i -= Math.max(1, Math.floor(n / 8))) pen.lineTo(env.base[i][0], env.base[i][1] + hMax * 0.13 * Math.sin((i / (n - 1)) * Math.PI))
          pen.closePath()
          pen.fillStyle = o.paper
          pen.fill()
          // 阴面的淡染：每座山峰右坡一片
          pen.beginPath()
          for (const hp of humps) {
            if (!hp.peak) continue
            const xr = hp.x + hp.w * 0.86
            const pts: P[] = [[hp.x, topAt(env.top, hp.x)]]
            for (const p of env.top) if (p[0] > hp.x && p[0] < xr) pts.push(p)
            pts.push([xr, env.baseAt(xr) - hp.h * 0.04], [hp.x + hp.w * 0.2, env.baseAt(hp.x) + hp.h * 0.04], [hp.x + hp.w * 0.07, hp.y - hp.h * 0.5])
            addLine(pen, pts, true)
          }
          pen.fillStyle = o.shadow
          pen.globalAlpha = 0.55
          pen.fill()
          pen.globalAlpha = 1
          // 披麻皴：从山脊顺坡垂下的长线，右坡密、左坡疏
          pen.beginPath()
          for (const hp of humps) {
            const r = rnd(hp.seed)
            const t = hp.peak?.t ?? 0
            const nr = hp.peak ? 3 + Math.round(t * 3) : 1
            const nl = hp.peak ? 1 + Math.round(t * 1.6) : 0
            for (let j = 0; j < nr + nl; j++) {
              const right = j < nr
              const q = right ? (j + 0.6 + r(30 + j) * 0.5) / (nr + 0.6) : (j - nr + 0.8) / (nl + 0.6)
              const sx = hp.x + (right ? 1 : -1) * q * hp.w * 0.74
              const sy = topAt(env.top, sx) + (1.1 + r(40 + j)) * k
              const room = env.baseAt(sx) - sy
              if (room < 3.5 * k) continue
              const len = room * (right ? 0.5 + r(50 + j) * 0.3 : 0.34 + r(50 + j) * 0.2)
              const ex = sx + (right ? 1 : -1) * q * hp.w * 0.2 + (right ? 0.05 : -0.03) * hp.w
              const mid: P = [lerp(sx, ex, 0.4) - (right ? 0.6 : -0.6) * k, sy + len * 0.5]
              addTaper(pen, [[sx, sy], mid, [ex, sy + len]], (u) => (0.95 - 0.75 * u) * k)
            }
          }
          pen.fillStyle = o.ink
          pen.globalAlpha = 0.78
          pen.fill()
          pen.globalAlpha = 1
          // 山脊：一笔，右坡（下行）重、左坡轻，起止收锋
          const widths = top.map((p, i) => {
            const a = top[Math.max(0, i - 1)]
            const b = top[Math.min(top.length - 1, i + 1)]
            const down = Math.max(0, (b[1] - a[1]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1))
            const edge = Math.min(1, Math.min(i, top.length - 1 - i) / 2 + 0.35)
            return (0.95 + 1.35 * down + 0.4 * fnoise(p[0] * 3, p[1] * 3, 9)) * k * edge
          })
          pen.beginPath()
          addBrush(pen, top, widths)
          pen.fillStyle = o.ink
          pen.fill()
          // 点苔：山脊肩部的几个横点
          pen.beginPath()
          for (const hp of humps) {
            const r = rnd(hp.seed)
            const nd = hp.peak ? 2 + Math.round(r(60) * 2) : 1
            for (let j = 0; j < nd; j++) {
              const dx = hp.x + (r(61 + j) - 0.45) * hp.w * 1.5
              if (dx < env.x0 + 2 * k || dx > env.x1 - 2 * k) continue
              addDab(pen, dx, topAt(env.top, dx) - 0.9 * k, (1.7 + r(70 + j)) * k, 0.55 * k, (r(80 + j) - 0.5) * 0.5)
            }
          }
          pen.fill()
        })
      }
    }
    // 丘陵：一道两头收锋的弧，里面一两笔短皴，顶上点苔
    for (const hl of T.hills) {
      out.item(hl.y, (pen) => {
        const r = rnd(hl.seed)
        const w = hl.s * (0.95 + r(1) * 0.3)
        const h = hl.s * (0.5 + r(2) * 0.16 + hl.t * 0.26)
        const ax = hl.x + (r(3) - 0.5) * w * 0.4
        // 小丘的笔跟着变细，免得糊成一团
        const fat = clamp(hl.s / (9 * k), 0.45, 1)
        const arc: P[] = []
        for (let i = 0; i <= 10; i++) {
          const u = i / 10
          const x = hl.x - w + 2 * w * u
          const d = (x - ax) / (x < ax ? ax - (hl.x - w) : hl.x + w - ax)
          arc.push([x, hl.y - h * Math.max(0, 1 - d * d) ** (0.75 - 0.3 * hl.t)])
        }
        pen.beginPath()
        addLine(pen, arc)
        pen.quadraticCurveTo(hl.x, hl.y + h * 0.22, arc[0][0], arc[0][1])
        pen.closePath()
        pen.fillStyle = o.paper
        pen.fill()
        pen.beginPath()
        addLine(pen, [[ax + w * 0.08, hl.y - h * 0.86], ...arc.filter((p) => p[0] > ax + w * 0.1), [ax + w * 0.3, hl.y + h * 0.04]], true)
        pen.fillStyle = o.shadow
        pen.globalAlpha = 0.62
        pen.fill()
        pen.globalAlpha = 1
        pen.beginPath()
        addBrush(
          pen,
          arc,
          arc.map((_, i) => (0.3 + 1.0 * Math.sin((i / 10) * Math.PI) ** 0.8 * (i > 5 ? 1.15 : 0.8)) * k * fat),
        )
        const m = 1 + Math.round(hl.t * 1.4)
        for (let j = 0; j < m; j++) {
          const sx = ax + w * (0.18 + 0.28 * j + r(5 + j) * 0.1)
          const sy = hl.y - h * (0.72 - 0.26 * j)
          addTaper(pen, [[sx, sy], [sx + w * 0.1, sy + h * 0.3], [sx + w * 0.16, sy + h * 0.52]], (u) => (0.75 - 0.55 * u) * k * fat)
        }
        if (hl.rank === 0 && fat > 0.8) addDab(pen, ax - w * 0.15, hl.y - h - 0.2 * k, 1.5 * k, 0.45 * k)
        pen.fillStyle = o.ink
        pen.fill()
      })
    }
  },
}

// ———————————————————————— 二、晕滃 ————————————————————————

/** 山链上一点的局部尺寸与高低：按到各山峰的距离反比加权 */
function localSize(c: Chain, x: number, y: number) {
  let sw = 0
  let s = 0
  let t = 0
  for (const p of c.nodes) {
    const w = 1 / ((p.x - x) ** 2 + (p.y - y) ** 2 + 4)
    sw += w
    s += p.s * w
    t += p.t * w
  }
  return { s: s / sw, t: t / sw }
}

/**
 * 晕滃：铜版地形图的俯视画法，不画侧面的山形。短而尖的晕滃线从山脊两侧顺坡撒下，山脊留白成一条亮线；
 * 背光的东南坡线粗而密、受光的西北坡线细，长短随实际地形的宽窄变化。
 */
const hachure: SymbolStyle = {
  id: 'hachure',
  name: '晕滃',
  desc: '铜版地形图的俯视画法：晕滃线从留白的山脊两侧顺坡撒下，背光坡粗密、受光坡细疏，线的长短跟着真实地形的宽窄走。',
  draw(T, o, out) {
    const k = T.k
    /** 沿 (nx, ny) 方向顺坡走的距离：走到地势降到山脚、或者谷底（再走就上坡）为止，不越过相邻的山脊 */
    const run = (x: number, y: number, nx: number, ny: number, s: number, e0: number) => {
      const lo = Math.max(0.55, e0 * 0.42)
      let d = s * 0.28
      let prev = T.elevAt(x + nx * d, y + ny * d)
      for (; d < s * 0.8; d += 1.5 * k) {
        const e = T.elevAt(x + nx * (d + 1.5 * k), y + ny * (d + 1.5 * k))
        if (e < lo || e > prev + 0.02) break
        prev = e
      }
      return d
    }
    /** 一道晕滃线：山脊一头宽、坡脚一头尖的楔形 */
    const wedge = (pen: Pen, x: number, y: number, nx: number, ny: number, g: number, len: number, hw: number, bend: number) => {
      const sx = x + nx * g
      const sy = y + ny * g
      const tx = -ny
      const ty = nx
      pen.moveTo(sx + tx * hw, sy + ty * hw)
      pen.lineTo(sx - tx * hw, sy - ty * hw)
      pen.lineTo(sx + nx * len + tx * bend, sy + ny * len + ty * bend)
      pen.closePath()
    }
    // 光自西北来：法向朝东南的一侧是背光坡
    const shade = (nx: number, ny: number) => clamp((nx + ny) * 0.71 * 0.5 + 0.5, 0, 1)
    for (const c of T.chains) {
      const yMax = Math.max(...c.nodes.map((p) => p.y + p.s))
      const single = c.line.length < 2
      out.item(yMax, (pen) => {
        const marks: { x: number; y: number; nx: number; ny: number; s: number; g: number; q: number; e0: number }[] = []
        if (single) {
          // 孤峰：绕留白的峰顶一圈放射，峰顶的空白是个略扁的圆
          const p = c.nodes[0]
          const n = Math.round(12 + p.s / (1.3 * k))
          const e0 = T.elevAt(p.x, p.y)
          for (let j = 0; j < n; j++) {
            const a = ((j + rnd(p.seed)(j) * 0.5) / n) * Math.PI * 2
            marks.push({ x: p.x, y: p.y, nx: Math.cos(a), ny: Math.sin(a), s: p.s * 0.8, g: p.s * 0.2, q: j, e0 })
          }
        } else {
          const pts = resample(c.line, 3 * k)
          // 支脉从主脊上岔出：靠近岔口的一段留给主脊的线
          const skip = c.main ? 0 : c.nodes[0].s * 0.75
          pts.forEach(({ p, t: tan, at }, i) => {
            if (at < skip) return
            const L = localSize(c, p[0], p[1])
            const e0 = T.elevAt(p[0], p[1])
            const g = L.s * 0.07 + 0.7 * k
            for (const side of [1, -1]) marks.push({ x: p[0], y: p[1], nx: -tan[1] * side, ny: tan[0] * side, s: L.s, g, q: i * 2 + (side > 0 ? 0 : 1), e0 })
            // 链端：绕端点半圈，短一些
            const end = i === 0 ? -1 : i === pts.length - 1 ? 1 : 0
            if (end && (c.main || i !== 0)) {
              for (let j = 1; j < 4; j++) {
                const a = (j / 4) * Math.PI
                const nx = -tan[1] * Math.cos(a) + tan[0] * end * Math.sin(a)
                const ny = tan[0] * Math.cos(a) + tan[1] * end * Math.sin(a)
                marks.push({ x: p[0], y: p[1], nx, ny, s: L.s * (1 - 0.45 * Math.sin(a)), g, q: 1000 + j + (end > 0 ? 10 : 0), e0 })
              }
            }
          })
        }
        // 山体：沿脊线一片淡淡的纸色，把晕滃线从底图的晕渲里托出来
        pen.beginPath()
        if (!single) {
          const pts = resample(c.line, 4 * k).map((q) => q.p)
          addBrush(
            pen,
            pts,
            pts.map((p) => localSize(c, p[0], p[1]).s * 1.2),
          )
        }
        for (const p of c.nodes) addBlob(pen, p.x, p.y, p.s * 0.66, p.s * 0.66, 9, 0.12, p.seed)
        pen.fillStyle = o.paper
        pen.globalAlpha = 0.5
        pen.fill()
        pen.globalAlpha = 1
        // 晕滃线：受光、背光两种浓淡各一条路径
        for (const pass of [0, 1]) {
          pen.beginPath()
          for (const m of marks) {
            const sh = shade(m.nx, m.ny)
            if ((sh > 0.5 ? 1 : 0) !== pass) continue
            const r = rnd(c.id * 7919 + m.q)
            const len = (run(m.x, m.y, m.nx, m.ny, m.s, m.e0) - (single ? m.g * 0.6 : 0)) * (0.78 + r(1) * 0.34)
            const hw = (0.26 + 0.62 * sh * sh) * k * (0.85 + r(2) * 0.4)
            wedge(pen, m.x, m.y, m.nx, m.ny, m.g, len, hw, (r(3) - 0.5) * 2.2 * k)
            // 主脊高大处再撒一排短线，错开半步
            if (c.main && m.s > 15 * k && m.q % 2 === 0 && m.q < 1000 && len > m.s * 0.6) {
              const g2 = m.g + len + 1.3 * k
              if (T.elevAt(m.x + m.nx * (g2 + 2 * k), m.y + m.ny * (g2 + 2 * k)) > 0.7) wedge(pen, m.x - m.ny * 1.25 * k, m.y + m.nx * 1.25 * k, m.nx, m.ny, g2, len * 0.4, hw * 0.7, 0)
            }
          }
          pen.fillStyle = o.ink
          pen.globalAlpha = pass ? 1 : 0.7
          pen.fill()
          pen.globalAlpha = 1
        }
        // 最高的几座：山脊上顺着脊线的一小条雪
        pen.beginPath()
        let any = false
        c.nodes.forEach((p, i) => {
          if (p.t < 0.62) return
          const a = c.nodes[Math.max(0, i - 1)]
          const b = c.nodes[Math.min(c.nodes.length - 1, i + 1)]
          const rot = single ? 0 : Math.atan2(b.y - a.y, b.x - a.x)
          addBlob(pen, p.x, p.y, p.s * (single ? 0.13 : 0.2), p.s * (single ? 0.1 : 0.045), 7, 0.2, p.seed, rot)
          any = true
        })
        if (any) {
          pen.fillStyle = o.snow
          pen.fill()
        }
      })
    }
    // 丘陵：背光一侧一弯短线，像睫毛；受光一侧只点两三笔
    for (const hl of T.hills) {
      out.item(hl.y, (pen) => {
        const r = rnd(hl.seed)
        const rx = hl.s * (0.5 + 0.12 * r(1))
        const ry = rx * 0.5
        const cx = hl.x
        const cy = hl.y - hl.s * 0.3
        for (const pass of [0, 1]) {
          pen.beginPath()
          const n = pass ? 6 + Math.round(hl.t * 3) : 3
          for (let j = 0; j < n; j++) {
            // 背光：东南的半圈（−25°~115°）；受光：西北侧
            const a = pass ? (-0.14 + ((j + 0.5 + (r(j) - 0.5) * 0.5) / n) * 0.78) * Math.PI : (1.05 + ((j + 0.5) / n) * 0.4) * Math.PI
            if (!pass && r(20 + j) > 0.6) continue
            const nx = Math.cos(a)
            const ny = Math.sin(a)
            const len = hl.s * (pass ? 0.3 + 0.14 * hl.t + 0.1 * r(30 + j) : 0.2)
            wedge(pen, cx + nx * rx, cy + ny * ry, nx * 0.75 + 0.2, ny * 0.75 + 0.25, 0, len, (pass ? 0.62 : 0.28) * k, 0)
          }
          pen.fillStyle = o.ink
          pen.globalAlpha = pass ? 1 : 0.7
          pen.fill()
          pen.globalAlpha = 1
        }
      })
    }
  },
}

// ———————————————————————— 三、折纸 ————————————————————————

/**
 * 折纸：几何化的切面山。每座山是一块平涂切面的晶体（左亮右暗、上浅下深）加细线，暗面里几道平行线；
 * 大的山顶是一小段横脊而不是一个尖，像折出来的屋脊；山链上相邻两峰之间补一块矮晶体，折成一条连续的带子；高峰顶上是白色的切面。
 */
const facet: SymbolStyle = {
  id: 'facet',
  name: '折纸',
  desc: '几何切面：每座山是几个平涂切面的晶体，左亮右暗、暗面里排几道平行线，大山的顶是一小段折出来的横脊；相邻山峰之间补矮切面，折成连续的山脊。',
  draw(T, o, out) {
    const k = T.k
    const tone = { l1: mixColor(o.paper, o.snow, 0.6), l2: o.paper, d1: mixColor(o.paper, o.shadow, 0.7), d2: mixColor(o.shadow, o.ink, 0.2), snow2: mixColor(o.snow, o.shadow, 0.45) }
    /** level：0 丘陵（两个切面）、1 鞍部与边缘低山（四个切面）、2 完整（可带横脊与雪面） */
    const crystal = (pen: Pen, x: number, y: number, w: number, h: number, seed: number, t: number, level: number) => {
      const r = rnd(seed)
      const lean = (r(3) - 0.5) * 0.7
      const A: P = [x + lean * w, y - h]
      const BL: P = [x - w, y - h * 0.1 * r(4)]
      const BR: P = [x + w, y - h * 0.12 * r(5)]
      const F: P = [x + (0.12 - lean * 0.5 + r(6) * 0.2) * w, y + h * (0.12 + r(7) * 0.1)]
      if (level === 0) {
        fillPoly(pen, [A, BL, F], tone.l2)
        fillPoly(pen, [A, F, BR], tone.d1)
        strokeLine(pen, [A, F], o.ink, 0.5 * k)
        strokeLine(pen, [BL, A, BR], o.ink, 0.8 * k)
        strokeLine(pen, [BL, F, BR], o.ink, 0.5 * k, 0.8)
        return
      }
      // 横脊：山顶从一个尖拉成一小段（A → A2），前面多出一个朝向看图人的三角面
      const roof = level === 2 && r(12) > 0.35
      const A2: P = roof ? [A[0] + w * (0.22 + r(13) * 0.16), A[1] + h * (0.03 + r(14) * 0.09)] : A
      const top: P = roof ? lerpP(A, A2, 0.5) : A
      const K = lerpP(top, F, 0.46 + r(8) * 0.16)
      K[0] += (r(9) - 0.5) * w * 0.26
      const ML = lerpP(A, BL, 0.44 + r(10) * 0.22)
      ML[0] -= w * 0.07
      ML[1] -= h * 0.06
      const MR = lerpP(A2, BR, 0.4 + r(11) * 0.22)
      MR[0] += w * 0.08
      MR[1] -= h * 0.05
      fillPoly(pen, [ML, BL, F, K], tone.l2)
      fillPoly(pen, [A, ML, K], tone.l1)
      fillPoly(pen, [A2, K, MR], tone.d1)
      fillPoly(pen, [K, F, BR, MR], tone.d2)
      const snowy = level === 2 && t > 0.45
      if (roof) fillPoly(pen, [A, A2, K], snowy ? o.snow : tone.l2)
      if (snowy) {
        const q = 0.4 + (t - 0.45) * 0.5
        const a1 = lerpP(A, ML, q)
        const a2 = lerpP(top, K, roof ? 1 : q * 0.72)
        const a3 = lerpP(A2, MR, q * 0.9)
        fillPoly(pen, [A, a1, a2], o.snow)
        fillPoly(pen, [A2, a2, a3], tone.snow2)
      }
      // 暗面的平行线
      pen.beginPath()
      const nl = level === 2 ? 2 + Math.round(h / (11 * k)) : 1
      for (let j = 1; j <= nl; j++) {
        const u = j / (nl + 1)
        const a = lerpP(K, F, u)
        const b = lerpP(MR, BR, u)
        pen.moveTo(a[0], a[1])
        pen.lineTo(lerp(a[0], b[0], 0.86), lerp(a[1], b[1], 0.86))
      }
      pen.strokeStyle = o.ink
      pen.lineWidth = 0.4 * k
      pen.globalAlpha = 0.75
      pen.stroke()
      pen.globalAlpha = 1
      pen.beginPath()
      addLine(pen, roof ? [A, K, A2] : [A, K])
      addLine(pen, [K, F])
      addLine(pen, [ML, K, MR])
      pen.lineWidth = 0.5 * k
      pen.stroke()
      strokeLine(pen, roof ? [BL, ML, A, A2, MR, BR] : [BL, ML, A, MR, BR], o.ink, 0.9 * k)
      strokeLine(pen, [BL, F, BR], o.ink, 0.55 * k)
    }
    for (const c of T.chains) {
      c.nodes.forEach((p, i) => {
        const { w, h, r } = dims(p)
        const low = !c.main && p.t < 0.3
        out.item(p.y, (pen) => {
          // 孤峰旁边一块小碎晶
          if (c.kind === 'solo') {
            const side = r(20) > 0.5 ? 1 : -1
            crystal(pen, p.x + side * w * 0.95, p.y - h * 0.02, w * 0.42, h * 0.36, p.seed + 3, 0, 1)
          }
          crystal(pen, p.x, p.y, w * 0.9, (low ? h * 0.8 : h) * 1.08, p.seed, p.t, low ? 1 : 2)
        })
        const q = c.nodes[i + 1]
        if (!q) return
        const d = dims(q)
        const dist = Math.hypot(q.x - p.x, q.y - p.y)
        out.item(Math.min(p.y, q.y) - 0.5, (pen) => crystal(pen, (p.x + q.x) / 2, (p.y + q.y) / 2, dist * 0.5 + Math.min(w, d.w) * 0.25, Math.min(h, d.h) * 0.56, p.seed + 5, 0, 1))
      })
    }
    for (const hl of T.hills) {
      out.item(hl.y, (pen) => {
        const r = rnd(hl.seed)
        crystal(pen, hl.x, hl.y, hl.s * (0.95 + r(1) * 0.3), hl.s * (0.42 + r(2) * 0.14 + hl.t * 0.24), hl.seed, 0, 0)
      })
    }
  },
}

// ———————————————————————— 四、木刻 ————————————————————————

/**
 * 木刻：文艺复兴木刻地图的土丘山，刻得更重。山头有圆有尖、带一侧的肩，背光的右半是整块的墨，
 * 墨里顺着山形刻出两三道纸色的长刀痕，受光面对称地留一两道墨线；轮廓粗，山脚一道压重的地面线。
 */
const woodcut: SymbolStyle = {
  id: 'woodcut',
  name: '木刻',
  desc: '木刻版画的黑白对比：有圆有尖的土丘山，背光的半边是整块的墨、墨里顺着山形刻出纸色的长刀痕，受光面只留一两道墨线。',
  draw(T, o, out) {
    const k = T.k
    /** level：0 丘陵、1 鞍部与低山、2 完整 */
    const dome = (pen: Pen, x: number, y: number, w: number, h: number, seed: number, t: number, level: number) => {
      const r = rnd(seed)
      const ax = x + (r(3) - 0.5) * w * 0.36
      // 外形：两侧各一条超椭圆弧，指数小则尖、大则圆；一侧带个肩
      const pl = 2.0 + (r(4) - 0.5) * 0.7 - t * 1.0
      const pr = 2.0 + (r(5) - 0.5) * 0.7 - t * 1.0
      const bump = (r(6) > 0.5 ? 1 : -1) * (0.45 + r(7) * 0.2)
      const amp = level === 0 ? 0 : 0.07 + r(8) * 0.08
      const yAt = (u: number) => {
        const a = Math.abs(u)
        return (1 - a ** (u < 0 ? pl : pr)) ** 0.72 + amp * Math.exp(-(((u - bump) / 0.2) ** 2)) * (1 - a)
      }
      const xAt = (u: number) => (u < 0 ? ax + u * (ax - (x - w)) : ax + u * (x + w - ax))
      const N = 5
      const left: P[] = []
      const right: P[] = []
      for (let i = 0; i <= N; i++) {
        const u = i / N
        left.push([xAt(-1 + u), y - h * yAt(-1 + u)])
        right.push([xAt(u), y - h * yAt(u)])
      }
      const prof = [...left, ...right.slice(1)]
      // 山体
      pen.beginPath()
      addCurve(pen, prof)
      pen.quadraticCurveTo(x, y + h * 0.16, x - w, y)
      pen.closePath()
      pen.fillStyle = o.paper
      pen.fill()
      // 山形内部的一条线：u 为离中线的远近（0 中线、1 轮廓），v0~v1 为自顶向下的范围
      const rib = (u: number, v0: number, v1: number, side: number, n = 4): P[] => {
        const pts: P[] = []
        for (let i = 0; i <= n; i++) {
          const v = lerp(v0, v1, i / n)
          // 高度 v 处轮廓的横向位置：自顶向下由窄到宽
          const uu = side * Math.min(1, u * (0.25 + 0.95 * v ** 0.8))
          pts.push([xAt(uu), Math.min(y + h * 0.05, y - h * Math.min(yAt(uu), 1 - v))])
        }
        return pts
      }
      // 背光面：整块的墨，高峰的墨块从雪线以下起
      const v0 = level === 2 && t > 0.5 ? 0.3 : 0.08
      const inner = rib(0.22 + r(10) * 0.14, v0, 1, 1)
      const u0 = inner[0][0] <= ax ? 0 : (inner[0][0] - ax) / (x + w - ax)
      const edge: P[] = []
      for (let i = 0; i <= 5; i++) {
        const u = lerp(1, Math.min(0.96, u0), i / 5)
        edge.push([xAt(u), y - h * yAt(u)])
      }
      pen.beginPath()
      addLine(pen, [...inner, [x + w * 0.62, y + h * 0.07], ...edge], true)
      pen.fillStyle = o.ink
      pen.fill()
      // 墨里的刀痕：纸色，顺着山形从上到下
      pen.beginPath()
      const ng = level === 0 ? 1 : level === 1 ? 1 + (h > 9 * k ? 1 : 0) : 2 + (h > 26 * k ? 1 : 0)
      for (let j = 0; j < ng; j++) {
        const f = lerp(0.45, 0.85, ng === 1 ? 0.4 : j / (ng - 1))
        addTaper(pen, rib(f, v0 + 0.14 + 0.07 * j, 0.93 - 0.05 * j, 1), (q) => (0.15 + (level === 0 ? 0.7 : 1.05) * Math.sin(q * Math.PI) ** 0.7) * k)
      }
      pen.fillStyle = o.paper
      pen.fill()
      // 受光面：对称的一两道墨线
      pen.beginPath()
      const nf = level === 0 ? (h > 5 * k ? 1 : 0) : level === 1 ? 1 : 2
      for (let j = 0; j < nf; j++) {
        const f = lerp(0.42, 0.74, nf === 1 ? 0.5 : j / (nf - 1))
        addTaper(pen, rib(f, 0.34 + 0.1 * j + r(20 + j) * 0.08, 0.84 - 0.12 * j, -1), (q) => (0.12 + 0.8 * Math.sin(q * Math.PI) ** 0.8) * k)
      }
      // 山脚压重的地面线
      if (level > 0) addTaper(pen, [[x + w * 0.3, y + h * 0.07], [x + w * 0.8, y + h * 0.05], [x + w * 1.22, y]], (q) => (1.5 - 1.3 * q) * k)
      pen.fillStyle = o.ink
      pen.fill()
      // 轮廓
      pen.beginPath()
      addCurve(pen, prof)
      pen.strokeStyle = o.ink
      pen.lineWidth = (level === 0 ? 0.95 : 1.3) * k
      pen.stroke()
    }
    for (const c of T.chains) {
      c.nodes.forEach((p, i) => {
        const { w, h, r } = dims(p)
        const low = !c.main && p.t < 0.3
        out.item(p.y, (pen) => {
          dome(pen, p.x, p.y, w * 0.98, (low ? h * 0.72 : h) * 0.84, p.seed, p.t, low ? 1 : 2)
          // 孤峰：山脚左侧几道短的地面刻线
          if (c.kind === 'solo') {
            pen.beginPath()
            for (let j = 0; j < 3; j++) {
              const yy = p.y + (0.02 + 0.05 * j) * h
              addTaper(pen, [[p.x - w * (1.25 - 0.12 * j), yy], [p.x - w * (0.72 - 0.2 * j + r(30 + j) * 0.1), yy + 0.3 * k]], (q) => (0.9 - 0.7 * q) * k)
            }
            pen.fillStyle = o.ink
            pen.fill()
          }
        })
        const q = c.nodes[i + 1]
        if (!q) return
        const d = dims(q)
        const dist = Math.hypot(q.x - p.x, q.y - p.y)
        out.item(Math.min(p.y, q.y) - 0.5, (pen) => dome(pen, (p.x + q.x) / 2, (p.y + q.y) / 2, dist * 0.46 + Math.min(w, d.w) * 0.2, Math.min(h, d.h) * 0.46, p.seed + 5, 0, 1))
      })
    }
    for (const hl of T.hills) {
      out.item(hl.y, (pen) => {
        const r = rnd(hl.seed)
        dome(pen, hl.x, hl.y, hl.s * (0.9 + r(1) * 0.3), hl.s * (0.44 + r(2) * 0.14 + hl.t * 0.24), hl.seed, 0, 0)
      })
    }
  },
}

// ———————————————————————— 五、层台 ————————————————————————

/**
 * 层台：把山画成一层层叠起来的台地，像斜着看的分层地形模型。每一层是顺着脊线的一条不规则的圆角带，
 * 向上一层缩一圈、抬高一步，南侧露出暗色的层壁与短竖线；同一山系的各层连成一体，山峰处多叠一两层，高峰的顶层是白的。
 */
const terrace: SymbolStyle = {
  id: 'terrace',
  name: '层台',
  desc: '斜看的分层地形模型：山脉是顺着脊线一层层缩小、抬高的台地，南侧露出暗色层壁，同一山系各层连成一体，高峰的顶层留白。',
  draw(T, o, out) {
    const k = T.k
    const wall = mixColor(o.shadow, o.ink, 0.3)
    const faces = [mixColor(o.paper, o.shadow, 0.55), mixColor(o.paper, o.shadow, 0.25), o.paper, mixColor(o.paper, o.snow, 0.6), o.snow]
    const SQ = 0.6
    /** 一层里的一块：一条带（脊线上的一段，每点一个半径）或一个圆台（只有一个点） */
    interface Band {
      pts: P[]
      rad: number[]
      seed: number
    }
    const addBand = (pen: Pen, b: Band, grow: number, dy: number) => {
      if (b.pts.length === 1) {
        const [x, y] = b.pts[0]
        addBlob(pen, x, y + dy, b.rad[0] + grow, (b.rad[0] + grow) * SQ, 7, 0.13, b.seed, b.seed % 7)
        return
      }
      // 两端各补半个圆头
      const n = b.pts.length
      const ext = (p: P, q: P, r: number): P => {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1
        return [p[0] + ((p[0] - q[0]) / d) * r * 0.7, p[1] + ((p[1] - q[1]) / d) * r * 0.7 * SQ]
      }
      const pts: P[] = [ext(b.pts[0], b.pts[1], b.rad[0] + grow), ...b.pts, ext(b.pts[n - 1], b.pts[n - 2], b.rad[n - 1] + grow)].map((p) => [p[0], p[1] + dy] as P)
      const rad = [(b.rad[0] + grow) * 1.15, ...b.rad.map((r) => (r + grow) * 2), (b.rad[n - 1] + grow) * 1.15]
      addBrush(pen, pts, rad, SQ)
    }
    const drawLevels = (pen: Pen, levels: Band[][], dz: number, snowTop: boolean) => {
      levels.forEach((bands, l) => {
        if (!bands.length) return
        const y0 = -l * dz
        // 层壁（含描边）：底、顶两份叠成一段立面
        pen.beginPath()
        for (const b of bands) for (const f of [0, 1]) addBand(pen, b, 0.6 * k, y0 - dz * f)
        pen.fillStyle = o.ink
        pen.fill()
        pen.beginPath()
        for (const b of bands) for (const f of [0, 1]) addBand(pen, b, 0, y0 - dz * f)
        pen.fillStyle = wall
        pen.fill()
        // 台面：比层壁缩进一点，四周留一圈暗边
        pen.beginPath()
        for (const b of bands) addBand(pen, b, -0.45 * k, y0 - dz)
        const top = l === levels.length - 1
        pen.fillStyle = top && snowTop ? faces[4] : faces[Math.min(3, l + (levels.length < 3 ? 1 : 0))]
        pen.fill()
      })
    }
    // 同一山系的各条山链并在一起逐层画，层与层之间才不会互相压出接缝
    const systems = new Map<number, Chain[]>()
    for (const c of T.chains) {
      const l = systems.get(c.system)
      if (l) l.push(c)
      else systems.set(c.system, [c])
    }
    for (const chains of systems.values()) {
      const all = chains.flatMap((c) => c.nodes)
      const tMax = Math.max(...all.map((p) => p.t))
      const sAvg = all.reduce((a, p) => a + p.s, 0) / all.length
      const dz = (1.9 + sAvg * 0.08) * k
      // 通层（沿脊线连续）的层数随山系的规模；山峰处按各自的高低再叠
      const through = chains[0].kind === 'range' ? 2 : 1
      const levels: Band[][] = []
      const push = (l: number, b: Band) => (levels[l] ??= []).push(b)
      for (const c of chains) {
        const line = c.line.length >= 2
        if (line) {
          const pts = resample(c.line, 5 * k).map((q) => q.p)
          if (pts.length >= 2) {
            const info = pts.map((p) => localSize(c, p[0], p[1]))
            for (let l = 0; l < through; l++) {
              // 支脉只铺到第一层，且比主脊窄
              if (l > 0 && !c.main) break
              const rad = pts.map((p, i) => info[i].s * (c.main ? 0.74 : 0.52) * (1 - l * 0.36) * (0.7 + 0.6 * fnoise(p[0] * 2 + l * 31, p[1] * 2, 26)))
              push(l, { pts, rad, seed: c.id })
            }
          }
        }
        for (const p of c.nodes) {
          const base = line ? (c.main ? through : 1) : 0
          const extra = (line ? 1 : 2) + Math.round(p.t * (c.main ? 2.2 : 1.2))
          const r0 = p.s * (line ? (c.main ? 0.44 : 0.34) : 0.7)
          const r = rnd(p.seed)
          for (let j = 0; j < extra; j++) {
            const rr = r0 * (1 - j / (extra + 0.3)) ** 0.85
            if (rr < 2.4 * k) break
            push(base + j, { pts: [[p.x + (r(j) - 0.5) * p.s * 0.14, p.y + (r(j + 9) - 0.5) * p.s * 0.06]], rad: [rr], seed: p.seed + j })
          }
        }
      }
      for (let l = 0; l < levels.length; l++) levels[l] ??= []
      const yMax = Math.max(...all.map((p) => p.y + p.s * 0.4))
      out.item(yMax, (pen) => drawLevels(pen, levels, dz, tMax > 0.5))
    }
    // 丘陵：一层的小台，起伏大的再叠一小层
    for (const hl of T.hills) {
      out.item(hl.y, (pen) => {
        const r = rnd(hl.seed)
        const rad = hl.s * (0.5 + r(1) * 0.22) * (hl.rank ? 0.85 : 1)
        const levels: Band[][] = [[{ pts: [[hl.x, hl.y - rad * SQ * 0.5]], rad: [rad], seed: hl.seed }]]
        if (hl.t > 0.45 && hl.rank === 0) levels.push([{ pts: [[hl.x - rad * 0.14 + r(2) * rad * 0.26, hl.y - rad * SQ * 0.55]], rad: [rad * (0.46 + 0.1 * hl.t)], seed: hl.seed + 1 }])
        drawLevels(pen, levels, (1.1 + hl.t * 0.7) * k, false)
      })
    }
  },
}

// ———————————————————————— 六、霞岳 ————————————————————————

/** 富士式的山头：凹的坡、略平的顶，轮廓带一点毛糙 */
function cone(d: number, hp: Hump, x: number) {
  const a = Math.abs(d)
  const f = a < 0.07 ? 1 - a * 0.4 : Math.max(0, 1 - (a - 0.07) / 0.93) ** 1.55 * 0.972
  return f * (1 + (fnoise(x * 4 + hp.seed, hp.y * 4, 7) - 0.5) * 0.16 * Math.min(1, a * 4))
}

/**
 * 霞岳：浮世绘与大和绘的没骨画法，不勾线。山是平涂的剪影，自顶向下由深到浅分三段晕开，山脚溶进纸色；
 * 一两道圆头的横霞（すやり霞）横切山腰；大山脉后面衬一层更淡的远山，高峰顶上是垂下指状雪痕的雪冠。
 */
const mist: SymbolStyle = {
  id: 'mist',
  name: '霞岳',
  desc: '浮世绘式的没骨剪影：不勾线，山顶深、山脚淡地分段晕开，一两道圆头的横霞切过山腰；大山脉后衬淡色远山，高峰有垂下雪痕的雪冠。',
  draw(T, o, out) {
    const k = T.k
    const deep = mixColor(o.shadow, o.ink, 0.42)
    const mid = mixColor(o.shadow, o.ink, 0.12)
    const pale = mixColor(o.shadow, o.paper, 0.5)
    const far = mixColor(o.shadow, o.paper, 0.3)
    const haze = mixColor(o.paper, o.snow, 0.3)
    /** 圆头的横带 */
    const band = (pen: Pen, x0: number, x1: number, y: number, th: number) => {
      const r = th / 2
      pen.moveTo(x0, y - r)
      pen.lineTo(x1, y - r)
      pen.quadraticCurveTo(x1 + r * 1.6, y, x1, y + r)
      pen.lineTo(x0, y + r)
      pen.quadraticCurveTo(x0 - r * 1.6, y, x0, y - r)
      pen.closePath()
    }
    /** 一道剪影：frac 把高度压到原来的几成（同一条底线），用来叠出由深到浅的三段 */
    const sil = (pen: Pen, env: ReturnType<typeof envelope>, frac: number, color: string, tol: number) => {
      const top = simplifyP(env.top.map((p, i) => [p[0], lerp(env.base[i][1], p[1], frac)] as P), tol)
      pen.beginPath()
      addLine(pen, top)
      const n = env.base.length
      for (let i = n - 1; i >= 0; i -= Math.max(1, Math.floor(n / 6))) pen.lineTo(env.base[i][0], env.base[i][1] + 0.6 * k)
      pen.closePath()
      pen.fillStyle = color
      pen.fill()
    }
    for (const c of T.chains) {
      for (const nodes of screensOf(c)) {
        const humps = humpsOf(nodes, c, 0.5, false)
        const big = c.kind === 'range' && c.main
        const yMax = Math.max(...nodes.map((p) => p.y))
        out.item(yMax, (pen) => {
          const r = rnd(nodes[0].seed)
          if (big) {
            const ghosts: Hump[] = humps.map((hp, i) => ({ x: hp.x + hp.w * (i % 2 ? 0.5 : -0.42), y: hp.y - hp.h * 0.16, w: hp.w * 1.1, h: hp.h * (hp.peak ? 1.0 : 1.5), seed: hp.seed + 101 }))
            sil(pen, envelope(ghosts, cone, 1.5 * k), 1, far, 0.4 * k)
          }
          const env = envelope(humps, cone, 1.2 * k)
          const hMax = Math.max(...humps.map((hp) => hp.h))
          sil(pen, env, 1, deep, 0.3 * k)
          sil(pen, env, 0.66, mid, 0.4 * k)
          sil(pen, env, 0.36, pale, 0.5 * k)
          // 雪冠：峰顶一块，下缘垂下几道指状的雪痕
          pen.beginPath()
          let snow = false
          for (const hp of humps) {
            if (!hp.peak || hp.peak.t < 0.42) continue
            snow = true
            const q = rnd(hp.seed)
            const span = hp.w * (0.2 + 0.16 * hp.peak.t)
            const xs: number[] = []
            const nf = 5
            for (let j = 0; j <= nf; j++) xs.push(hp.x - span + (2 * span * j) / nf)
            const pts: P[] = []
            for (const p of env.top) if (p[0] >= xs[0] && p[0] <= xs[nf]) pts.push(p)
            if (pts.length < 2) continue
            pen.moveTo(pts[0][0], pts[0][1])
            for (const p of pts.slice(1)) pen.lineTo(p[0], p[1])
            for (let j = nf; j > 0; j--) {
              const xa = xs[j]
              const xb = xs[j - 1]
              const xm = (xa + xb) / 2
              const drop = hp.h * (0.14 + 0.2 * q(40 + j)) * (1 - Math.abs(j - 0.5 - nf / 2) / nf)
              pen.quadraticCurveTo(xm + (xa - xm) * 0.3, topAt(env.top, xm) + drop * 1.6, xb, topAt(env.top, xb) + (j > 1 ? hp.h * 0.03 : 0))
            }
            pen.closePath()
          }
          if (snow) {
            pen.fillStyle = o.snow
            pen.fill()
          }
          // 横霞：一两道圆头的横带切过山腰，两端伸出山外
          pen.beginPath()
          const span = env.x1 - env.x0
          const nb = c.kind === 'solo' ? 2 : c.main && nodes.length > 2 ? 1 + (r(4) > 0.5 ? 1 : 0) : c.main && nodes.length === 2 && r(5) > 0.5 ? 1 : 0
          for (let j = 0; j < nb; j++) {
            const yy = yMax - hMax * (0.16 + 0.17 * j + r(6 + j) * 0.05)
            // 长屏的霞只占一段，不横贯整条山脉
            const len = Math.min(span * (0.5 + r(8 + j) * 0.25), (38 + 30 * r(12 + j)) * k)
            const x0 = j ? env.x1 - len * (0.75 + r(10) * 0.2) : env.x0 - len * (0.12 + r(9) * 0.14)
            band(pen, x0, x0 + len, yy, (1.7 + hMax * 0.03) * k * (j ? 0.8 : 1))
          }
          pen.fillStyle = haze
          pen.fill()
        })
      }
    }
    // 丘陵：顶上深、底下淡的扁丘，无线
    for (const hl of T.hills) {
      out.item(hl.y, (pen) => {
        const r = rnd(hl.seed)
        const w = hl.s * (0.95 + r(1) * 0.3)
        const h = hl.s * (0.42 + r(2) * 0.14 + hl.t * 0.24)
        const ax = hl.x + (r(3) - 0.5) * w * 0.4
        const mound = (f: number, color: string) => {
          pen.beginPath()
          pen.moveTo(hl.x - w, hl.y)
          pen.quadraticCurveTo(lerp(hl.x - w, ax, 0.6), hl.y - h * f * 1.25, ax, hl.y - h * f)
          pen.quadraticCurveTo(lerp(hl.x + w, ax, 0.6), hl.y - h * f * 1.25, hl.x + w, hl.y)
          pen.closePath()
          pen.fillStyle = color
          pen.fill()
        }
        mound(1, mid)
        mound(0.55, pale)
        if (hl.rank === 0 && r(7) > 0.88) {
          pen.beginPath()
          band(pen, hl.x - w * 1.05, hl.x + w * (0.3 + r(4) * 0.4), hl.y - h * 0.12, 1.5 * k)
          pen.fillStyle = haze
          pen.fill()
        }
      })
    }
  },
}

export const MOUNTAIN_STYLES: SymbolStyle[] = [screen, hachure, facet, woodcut, terrace, mist]
