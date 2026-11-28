/**
 * 【实验·和风】与奇幻羊皮、山水并列的一种纸图风格的原型（尚未登记进任何插件）。
 * 气质取浮世绘的名所绘、大和绘与日本的古地图（行基图、国绘图）：
 * - 山：没骨的平涂，不勾线；山顶深、山脚淡，沿山脊一层层套色（ぼかし）；丘、矮山、高峰是同一个生成函数在山势 m 上的连续变化；
 * - 霞：すやり霞，圆头的长条带，全图只放几道，横切大山脉的山腰；
 * - 林：青海波式的鳞片，每片是深色的鳞边托着浅色的鳞心；阔叶圆鳞、针叶尖鳞，林缘与林内分开处理，大片林地留出空地；
 * - 树：屏风画的松与杉；
 * - 纸面：和纸底，海是近岸一圈靛蓝的晕染与局部的青海波，海岸与河用藍，道路用朱。
 */
import { Biome, type World } from '../../../gen/types'
import { fnoise, hash, type Fields } from '../fields'
import type { Pen } from '../glyphBatch'
import type { GlyphColors } from '../glyphs'
import { hex, type RGB } from '../../palette'
import { SONG, type Theme, type VectorDraw } from '../styles'
import { biomeLayers, FOREST, type Layers, type VectorFields } from '../svg/layers'
import { rgb } from '../../palette'
import { addLine, addTaper, chaikin, rnd, type P } from './brush'
import { form, screensOf, thin, topAt } from './gradual'
import { kitDrawer, type SymbolStyle } from './index'
import type { Peak, Terrain, TreeKind } from './terrain'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const css = (c: RGB) => `rgb(${c.map((v) => Math.round(v)).join(',')})`
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

// ———————————————————————— 版画的套色 ————————————————————————

/** 和纸（页面与海面） */
const WASHI = hex('#ece3cc')
/** 陆地：比海面略亮的生成色 */
const KINARI = hex('#f1e9d5')
/** 藍（靛蓝）：海岸、河、水的注记 */
const AI: RGB = [46, 72, 104]
/** 浅葱 */
const ASAGI: RGB = [104, 160, 168]
/** 朱：道路、印章 */
const SHU: RGB = [190, 72, 46]
/** 黄土：砂子与丘的底色 */
const OUDO: RGB = [184, 150, 92]
/** 近岸的晕染：偏蓝的藍（版画的ベロ藍） */
const COAST_BLUE: RGB = [56, 104, 146]
/** 胡粉：雪、霞 */
const GOFUN: RGB = [250, 247, 238]
/** 墨 */
const SUMI = '#2c2a27'

/** 群系的淡设色：林地若竹、草原萌黄、沙地黄土、湿地浅葱，其余是生成色 */
const BIOME_ALPHA = 0.3
const TINT: Record<number, RGB> = (() => {
  const t: Record<number, RGB> = {}
  for (let b = 0; b <= 17; b++) t[b] = KINARI
  for (const b of FOREST) t[b] = hex('#c9d4bc')
  t[Biome.Grassland] = hex('#e3e2c0')
  t[Biome.Savanna] = hex('#e7dcb6')
  t[Biome.HotDesert] = hex('#ead7ac')
  t[Biome.ColdDesert] = hex('#e2d8bd')
  t[Biome.Shrubland] = hex('#e2dab8')
  t[Biome.Wetland] = hex('#cfdcd2')
  return t
})()

/** 山体的底色：底图在山脚处的颜色（山体就是那里的纸，山脚溶进纸色） */
function groundTone(T: Terrain, x: number, y: number): RGB {
  const { W, H, S, biome } = T.input
  const gx = Math.min(W - 1, Math.max(0, Math.round(x / S - 0.5)))
  const gy = Math.min(H - 1, Math.max(0, Math.round(y / S - 0.5)))
  const tint = TINT[biome[gy * W + gx]] ?? KINARI
  return mixRGB(KINARI, tint, BIOME_ALPHA)
}

/**
 * 山的套色（两色的ぼかし：山顶一色、山腰一色，山脚溶进纸色）。
 * 山顶：缓丘是黄土，矮山若草到緑青，高峰藍；山腰：黄土到緑青
 */
const TOP_KNOTS: [number, RGB][] = [
  [0, [172, 160, 106]],
  [0.25, [116, 142, 96]],
  [0.5, [64, 114, 110]],
  [0.75, [44, 82, 126]],
  [1, [34, 60, 116]],
]
const LOW_KNOTS: [number, RGB][] = [
  [0, [182, 170, 116]],
  [0.3, [134, 158, 108]],
  [0.6, [100, 146, 116]],
  [1, [92, 140, 124]],
]
function knot(K: [number, RGB][], m: number): RGB {
  for (let i = 1; i < K.length; i++) {
    const [a, ca] = K[i - 1]
    const [b, cb] = K[i]
    if (m <= b) return mixRGB(ca, cb, (m - a) / (b - a))
  }
  return K[K.length - 1][1]
}

// ———————————————————————— 山：没骨的套色 ————————————————————————

interface Hump {
  x: number
  y: number
  w: number
  h: number
  m: number
  sharp: number
  seed: number
  /** 真正的山峰或丘（鞍部、肩部是补出来的） */
  real: boolean
  /** 左右两坡的凹度 */
  el: number
  er: number
}

function makeHump(x: number, y: number, m: number, seed: number, k: number, scale = 1): Hump {
  const f = form(m, k)
  const r = rnd(seed)
  // 比山水的连嶂略宽、略矮：版画里的山是舒展的剪影
  const w = f.w * (0.95 + r(1) * 0.25) * scale * 1.08
  const h = f.h * (0.85 + r(2) * 0.25) * scale * 0.92
  return { x: x + (r(3) - 0.5) * w * 0.25 * f.sharp, y, w, h, m, sharp: f.sharp, seed, real: true, el: 1.25 + r(4) * 0.5, er: 1.25 + r(5) * 0.5 }
}

/** 山头的外形：缓丘是圆的馒头，随山势渐成凹坡的尖峰（富士式的两坡） */
function humpShape(d: number, hp: Hump) {
  const a = Math.abs(d)
  const dome = (1 - a * a) ** 0.8
  const e = d < 0 ? hp.el : hp.er
  const cone = a < 0.05 ? 1 - a * 0.6 : 0.97 * ((1 - a) / 0.95) ** e
  return lerp(dome, cone, hp.sharp * 0.92)
}

function envelope(humps: Hump[], step: number) {
  let x0 = Infinity
  let x1 = -Infinity
  for (const hp of humps) {
    x0 = Math.min(x0, hp.x - hp.w)
    x1 = Math.max(x1, hp.x + hp.w)
  }
  const by = [...humps].filter((h) => h.real).sort((a, b) => a.x - b.x)
  const baseAt = (x: number) => {
    if (x <= by[0].x) return by[0].y
    for (let i = 1; i < by.length; i++) if (x <= by[i].x) return lerp(by[i - 1].y, by[i].y, (x - by[i - 1].x) / (by[i].x - by[i - 1].x || 1))
    return by[by.length - 1].y
  }
  const n = Math.max(4, Math.ceil((x1 - x0) / step))
  const top: P[] = []
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n
    const b = baseAt(x)
    let hh = 0
    for (const hp of humps) {
      const d = (x - hp.x) / hp.w
      if (d <= -1 || d >= 1) continue
      const rough = 1 + (fnoise(x * 4 + hp.seed, hp.y * 4, 7) - 0.5) * 0.1 * hp.sharp * Math.min(1, (1 - Math.abs(d)) * 4)
      hh = Math.max(hh, hp.h * humpShape(d, hp) * rough)
    }
    top.push([x, b - hh])
  }
  return { top, baseAt, x0, x1 }
}
type Env = ReturnType<typeof envelope>

/** 一组山（一屏或一座丘）与它的霞的落点 */
interface Unit {
  humps: Hump[]
  /** 底边的纵坐标（排序用） */
  y: number
  env: Env
  hMax: number
  mMax: number
  /** 属于大山脉的主脊 */
  range: boolean
  system: number
}

/** 选点与成屏：主脊上的峰离得太近的也略去一些，支脉更稀；丘按山势与"丘群"取舍，平地的缓丘只留少数 */
function unitsOf(T: Terrain): Unit[] {
  const k = T.k
  const kept: Peak[] = []
  const crowd = (x: number, y: number, s: number, f: number) => {
    for (const q of kept) {
      const dx = x - q.x
      const dy = (y - q.y) * 1.5
      const R = f * Math.max(s, q.s)
      if (dx * dx + dy * dy < R * R) return true
    }
    return false
  }
  const keptSet = new Set<Peak>()
  const order: { p: Peak; main: boolean }[] = []
  for (const c of T.chains) for (const p of c.nodes) order.push({ p, main: c.main })
  order.sort((a, b) => Number(b.main) - Number(a.main) || b.p.m - a.p.m || a.p.seed - b.p.seed)
  for (const { p, main } of order) {
    if (crowd(p.x, p.y, p.s, main ? 0.78 : 1.3)) continue
    kept.push(p)
    keptSet.add(p)
  }
  const units: Unit[] = []
  const push = (humps: Hump[], range: boolean, system: number) => {
    const real = humps.filter((h) => h.real)
    const env = envelope(humps, 1.1 * k)
    units.push({
      humps,
      y: real.reduce((a, h) => a + h.y, 0) / real.length,
      env,
      hMax: Math.max(...humps.map((h) => h.h)),
      mMax: Math.max(...real.map((h) => h.m)),
      range,
      system,
    })
  }
  for (const c of T.chains) {
    const nodes = c.nodes.filter((p) => keptSet.has(p))
    if (!nodes.length) continue
    for (const run of screensOf(nodes)) {
      const sorted = [...run].sort((a, b) => a.x - b.x)
      const humps: Hump[] = []
      sorted.forEach((p, i) => {
        const hp = makeHump(p.x, p.y, p.m, p.seed, k, c.main ? 1 : 0.9)
        humps.push(hp)
        const q = sorted[i + 1]
        if (q) {
          // 鞍部：两峰之间的山脊不落到地面
          const sd = makeHump((p.x + q.x) / 2, (p.y + q.y) / 2, Math.min(p.m, q.m), p.seed + 7, k)
          sd.x = (p.x + q.x) / 2
          sd.w = Math.hypot(q.x - p.x, q.y - p.y) * 0.62 + sd.w * 0.2
          sd.h = Math.min(hp.h, form(q.m, k).h) * 0.45
          sd.sharp = 0
          sd.real = false
          humps.push(sd)
        }
      })
      // 肩：高峰旁一个低的次峰，随尖锐度从无到有
      for (const hp of humps.filter((q) => q.real)) {
        const r = rnd(hp.seed)
        const side = r(20) > 0.5 ? 1 : -1
        const hh = hp.h * (0.42 + r(21) * 0.16) * hp.sharp
        if (hh < 3 * k) continue
        const sh = makeHump(hp.x, hp.y, hp.m * 0.6, hp.seed + 11, k)
        sh.x = hp.x - side * hp.w * (0.5 + r(24) * 0.2)
        sh.w = hp.w * (0.55 + r(26) * 0.15)
        sh.h = hh
        sh.real = false
        humps.push(sh)
      }
      push(humps, c.main && c.kind === 'range', c.system)
    }
  }
  for (const hl of T.hills) {
    // 平地上的缓丘再减一半：版画里的平地是留白
    if (hash(hl.seed, 41) < 0.85 * (1 - smooth(0.1, 0.32, hl.m))) continue
    if (crowd(hl.x, hl.y, hl.s, 1.25)) continue
    push([makeHump(hl.x, hl.y, hl.m, hl.seed, k, 0.95)], false, -1)
  }
  return units
}

/** 霞：圆头的长条带，上下两条错开成段；外缘一道细的金线，里面填胡粉 */
interface Kasumi {
  x0: number
  x1: number
  y: number
  th: number
  /** 第二条的偏移与长度（0 为只有一条） */
  dx: number
  len2: number
  depth: number
  seed: number
}

/** 全图只放几道：挑大山脉里最宽、最高的几屏，彼此离得远 */
function kasumiOf(T: Terrain, units: Unit[]): Kasumi[] {
  const k = T.k
  const cand = units.filter((u) => u.range && u.humps.filter((h) => h.real).length >= 2 && u.mMax > 0.4)
  cand.sort((a, b) => (b.env.x1 - b.env.x0) * b.mMax - (a.env.x1 - a.env.x0) * a.mMax || a.y - b.y)
  const out: Kasumi[] = []
  const used = new Map<number, number>()
  const { W, H, S } = T.input
  const cap = Math.max(2, Math.round((W * H * S * S) / (1100 * 1100)))
  for (const u of cand) {
    if (out.length >= cap) break
    if ((used.get(u.system) ?? 0) >= 2) continue
    const cx = (u.env.x0 + u.env.x1) / 2
    if (out.some((q) => Math.hypot((q.x0 + q.x1) / 2 - cx, q.y - u.y) < 260 * k)) continue
    const r = rnd(u.humps[0].seed + 5)
    const span = u.env.x1 - u.env.x0
    const len = Math.min(Math.max(span * (0.9 + 0.3 * r(1)), 90 * k), 190 * k)
    // 一端伸出山外，另一端收在山腰里
    const left = r(2) > 0.5
    const x0 = left ? u.env.x0 - len * (0.25 + 0.15 * r(3)) : u.env.x1 + len * (0.25 + 0.15 * r(3)) - len
    const th = (7 + 3 * u.mMax) * k
    out.push({
      x0,
      x1: x0 + len,
      y: u.y - u.hMax * (0.2 + 0.1 * r(4)),
      th,
      dx: (left ? 1 : -1) * len * (0.25 + 0.2 * r(5)),
      len2: len * (0.45 + 0.2 * r(6)),
      depth: u.y + 0.5 * k,
      seed: u.humps[0].seed,
    })
    used.set(u.system, (used.get(u.system) ?? 0) + 1)
  }
  return out
}

/** 圆头的横带：上下两缘是极缓的弧，两头是半圆 */
function addBand(pen: Pen, x0: number, x1: number, y: number, th: number, sag: number) {
  const r = th / 2
  pen.moveTo(x0, y - r)
  pen.quadraticCurveTo((x0 + x1) / 2, y - r - sag, x1, y - r)
  pen.quadraticCurveTo(x1 + r * 1.35, y - r, x1 + r * 1.35, y)
  pen.quadraticCurveTo(x1 + r * 1.35, y + r, x1, y + r)
  pen.quadraticCurveTo((x0 + x1) / 2, y + r - sag, x0, y + r)
  pen.quadraticCurveTo(x0 - r * 1.35, y + r, x0 - r * 1.35, y)
  pen.quadraticCurveTo(x0 - r * 1.35, y - r, x0, y - r)
  pen.closePath()
}

/** 霞的金：胡粉里调一点黄土，金线再深一些 */
const KASUMI_FILL = mixRGB(GOFUN, [226, 196, 128], 0.62)
const KASUMI_LINE: RGB = [194, 160, 96]

function kasumiBands(q: Kasumi): [number, number, number][] {
  const bands: [number, number, number][] = [[q.x0, q.x1, q.y]]
  const mid = (q.x0 + q.x1) / 2
  // 段：下面一条错向一侧，上面一条短的错向另一侧（すやり霞的层次）
  if (q.len2 > 0) {
    const c = mid + q.dx
    bands.push([c - q.len2 / 2, c + q.len2 / 2, q.y + q.th * 0.72])
    const c2 = mid - q.dx * 0.8
    const l3 = q.len2 * 0.7
    bands.push([c2 - l3 / 2, c2 + l3 / 2, q.y - q.th * 0.7])
  }
  return bands
}

function drawKasumi(pen: Pen, q: Kasumi, k: number) {
  const bands = kasumiBands(q)
  const sag = q.th * 0.08
  // 没有轮廓：由外向内几圈渐浓的金胡粉，边缘晕开，中间实
  for (const [g, a] of [[4, 0.1], [2.8, 0.14], [1.7, 0.2], [0.8, 0.3], [0, 0.72]] as const) {
    pen.beginPath()
    for (const [x0, x1, y] of bands) addBand(pen, x0 - g * k, x1 + g * k, y, Math.max(1 * k, q.th - 2 * k + 2 * g * k), sag)
    pen.fillStyle = css(KASUMI_FILL)
    pen.globalAlpha = a
    pen.fill()
  }
  // 砂子：带里稀疏的几点金箔
  pen.beginPath()
  const r = rnd(q.seed + 77)
  for (const [x0, x1, y] of bands) {
    const n = Math.round((x1 - x0) / (7 * k))
    for (let j = 0; j < n; j++) {
      if (r(j * 3 + y) > 0.6) continue
      const px = x0 + (x1 - x0) * r(j * 3 + 1 + y)
      const py = y + (r(j * 3 + 2 + y) - 0.5) * q.th * 0.5
      const sz = (0.3 + 0.55 * r(j * 5 + 7 + y) ** 2) * k
      pen.moveTo(px, py - sz)
      pen.lineTo(px + sz, py)
      pen.lineTo(px, py + sz)
      pen.lineTo(px - sz, py)
      pen.closePath()
    }
  }
  pen.fillStyle = css(KASUMI_LINE)
  pen.globalAlpha = 0.65
  pen.fill()
  pen.globalAlpha = 1
}

/** 和风的山：没骨的套色 */
export const wafuMountain: SymbolStyle = {
  id: 'wafu-mountain',
  name: '霞岳',
  desc: '浮世绘的没骨山：不勾线，沿山脊一层层套色，山顶深、山脚溶进纸色；缓丘是一抹黄土，矮山緑青，高峰藍与克制的雪顶；全图只有几道横切大山脉山腰的すやり霞。',
  draw(T, _o, out) {
    const k = T.k
    const units = unitsOf(T)
    for (const u of units) out.item(u.y - u.hMax * 1e-3, (pen) => drawUnit(pen, T, u, k))
    for (const q of kasumiOf(T, units)) out.item(q.depth, (pen) => drawKasumi(pen, q, k))
  },
}

const STRIPS = 14

function drawUnit(pen: Pen, T: Terrain, u: Unit, k: number) {
  const { env, humps, mMax } = u
  const top = thin(env.top, 0.15 * k)
  const n = top.length
  const mid = (env.x0 + env.x1) / 2
  const ground = groundTone(T, mid, env.baseAt(mid))
  const cTop = knot(TOP_KNOTS, mMax)
  const cLow = knot(LOW_KNOTS, mMax)
  // 山体：纸色，盖住后面的山；底边略向下鼓
  const hMax = u.hMax
  pen.beginPath()
  addLine(pen, top)
  const nb = 6
  for (let i = nb; i >= 0; i--) {
    const x = env.x0 + ((env.x1 - env.x0) * i) / nb
    pen.lineTo(x, env.baseAt(x) + hMax * 0.04 * Math.sin((i / nb) * Math.PI) + 0.5 * k)
  }
  pen.closePath()
  pen.fillStyle = css(mixRGB(ground, cLow, 0.04))
  pen.fill()
  // 套色：沿山脊往下的几层，每层同色、同透明度，叠出由深到浅；层深按当地的山高
  const A = lerp(0.3, 0.94, smooth(0.02, 0.65, mMax))
  const reach = lerp(0.62, 0.82, mMax)
  const lo = top.map((p) => env.baseAt(p[0]) - p[1])
  for (let j = 0; j < STRIPS; j++) {
    const f = reach * ((j + 1) / STRIPS) ** 1.15
    pen.beginPath()
    addLine(pen, top)
    for (let i = n - 1; i >= 0; i--) pen.lineTo(top[i][0], top[i][1] + lo[i] * f)
    pen.closePath()
    pen.fillStyle = css(mixRGB(cTop, cLow, j / (STRIPS - 1)))
    pen.globalAlpha = A / STRIPS
    pen.fill()
  }
  pen.globalAlpha = 1
  // 雪顶：只在最高的几档，峰顶一小块，下缘垂下两三道短的雪痕
  pen.beginPath()
  let snow = false
  for (const hp of humps) {
    if (!hp.real) continue
    const s = smooth(0.62, 0.92, hp.m)
    if (s < 0.05) continue
    snow = true
    const r = rnd(hp.seed + 3)
    const span = hp.w * (0.2 + 0.12 * s)
    const xs: number[] = []
    const NF = 6
    for (let j = 0; j <= NF; j++) xs.push(hp.x - span + (2 * span * j) / NF)
    const pts: P[] = env.top.filter((p) => p[0] >= xs[0] && p[0] <= xs[NF])
    if (pts.length < 2) continue
    addLine(pen, pts)
    for (let j = NF - 1; j >= 1; j--) {
      const u = 1 - Math.abs(j / NF - 0.5) * 2
      const drop = hp.h * (0.09 + 0.12 * s) * (0.45 + 0.55 * u) * (j % 2 ? 1.25 + 0.4 * r(j) : 0.55)
      pen.lineTo(xs[j], topAt(env.top, xs[j]) + drop)
    }
    pen.closePath()
  }
  if (snow) {
    pen.fillStyle = css(GOFUN)
    pen.fill()
  }
}

// ———————————————————————— 林：青海波式的鳞 ————————————————————————

/** 三档套色（浅、中、深），按群系：阔叶若竹到常磐，针叶浅葱到深緑，雨林更深 */
const FOREST_TONES: Record<'leaf' | 'pine' | 'jungle', [RGB, RGB, RGB]> = {
  leaf: [
    [186, 204, 166],
    [140, 172, 132],
    [92, 134, 106],
  ],
  pine: [
    [170, 196, 182],
    [118, 158, 148],
    [74, 118, 114],
  ],
  jungle: [
    [150, 182, 138],
    [104, 146, 112],
    [62, 108, 88],
  ],
}

export const wafuForest: SymbolStyle = {
  id: 'wafu-forest',
  name: '鳞林',
  desc: '青海波式的鳞片逐排遮叠：每片是深色的鳞边托着浅色的鳞心，不用墨线；阔叶圆鳞、针叶尖鳞；林缘的鳞套两道弧、南缘露出树干，林内只是套色，大片林地成片留空。',
  draw(T, _o, out) {
    const k = T.k
    if (!T.spots.length) return
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const s of T.spots) {
      x0 = Math.min(x0, s.x)
      y0 = Math.min(y0, s.y)
      x1 = Math.max(x1, s.x)
      y1 = Math.max(y1, s.y)
    }
    const dx = 7.4 * k
    const dy = 3.9 * k
    const trunk = 'rgb(112,92,72)'
    for (let j = Math.floor((y0 - 10 * k) / dy); j <= Math.ceil((y1 + 10 * k) / dy); j++) {
      for (let i = Math.floor(x0 / dx) - 2; i <= Math.ceil(x1 / dx) + 2; i++) {
        const gx = (i + (j & 1 ? 0.5 : 0)) * dx
        const gy = j * dy
        const cy = gy - 1.6 * k
        if (T.forestAt(gx, cy) < 0.5) continue
        const type = T.kindAt(gx, cy) ?? T.kindAt(gx, cy - 2 * k) ?? 'leaf'
        const kind = type === 'pine' ? 'pine' : type === 'jungle' ? 'jungle' : 'leaf'
        const depth = T.depthAt(gx, cy)
        const rim = depth < 2.4
        // 空地：林内按低频噪声成片留空（林子越深越容易空），空地的边缘留一圈半透的鳞
        const gap = fnoise(gx + 1700, gy * 1.3 - 400, 64 * k) - 0.06 * smooth(3, 9, depth)
        if (!rim && gap < 0.36) continue
        const thinOut = !rim && gap < 0.42
        if (thinOut && hash(i * 7 + 3, j * 11) < 0.5) continue
        const front = T.forestAt(gx, gy + dy * 1.3) < 0.5
        const x = gx + (hash(i * 3 + 1, j * 5) - 0.5) * 1.2 * k
        const y = gy + (hash(i * 5, j * 3 + 2) - 0.5) * 0.8 * k
        // 色调：成片的深浅（低频），林缘偏浅、林内偏深
        const nz = fnoise(gx + 311, gy * 1.5 + 97, 52 * k) + (rim ? -0.08 : 0.06) + (hash(i, j) - 0.5) * 0.08
        const lv = nz < 0.48 ? 0 : nz < 0.67 ? 1 : 2
        const tones = FOREST_TONES[kind]
        // 林内的鳞边与鳞心反差减半：林内是一片套色，林缘才看得清一片片的鳞
        const edge = rim ? tones[Math.min(2, lv + 1)] : mixRGB(tones[lv], tones[Math.min(2, lv + 1)], 0.6)
        const core = mixRGB(tones[lv], KINARI, lv === 0 ? 0.25 : 0.12)
        // 针叶的鳞窄而高（杉的树梢），彼此之间露出后排
        const a = dx * (kind === 'jungle' ? 0.7 : kind === 'pine' ? 0.5 : 0.64)
        const h = (kind === 'pine' ? 7.6 : kind === 'jungle' ? 5.6 : 5.1) * k
        // 大小：成片的起伏与逐片的一点差，鳞不至于排得像壁纸
        const sz = (0.88 + 0.26 * fnoise(gx - 900, gy + 2400, 34 * k)) * (0.95 + 0.1 * hash(i * 13, j * 7))
        const dome = (pen: Pen, f: number, oy: number) => {
          const w = a * f * sz
          const t = h * f * sz
          const by = y + oy
          if (kind === 'pine') {
            pen.moveTo(x - w, by)
            pen.quadraticCurveTo(x - w * 0.35, by - t * 0.42, x, by - t)
            pen.quadraticCurveTo(x + w * 0.35, by - t * 0.42, x + w, by)
          } else {
            pen.moveTo(x - w, by)
            pen.quadraticCurveTo(x - w, by - t * 1.02, x, by - t)
            pen.quadraticCurveTo(x + w, by - t * 1.02, x + w, by)
          }
        }
        out.item(gy + (i & 1) * 0.01, (pen) => {
          if (front && kind !== 'jungle') {
            pen.beginPath()
            addTaper(pen, [[x, y + 2.6 * k], [x, y - h * 0.3]], (u) => (0.75 - 0.3 * u) * k)
            pen.fillStyle = trunk
            pen.fill()
          }
          // 鳞边（深）
          pen.beginPath()
          dome(pen, 1, 0)
          pen.quadraticCurveTo(x, y + 1.0 * k, x - a * sz, y)
          pen.closePath()
          pen.fillStyle = css(edge)
          pen.globalAlpha = thinOut ? 0.55 : 1
          pen.fill()
          // 鳞心（浅）：向下错开，上面露出一道月牙形的鳞边
          pen.beginPath()
          dome(pen, 0.8, 0.55 * k)
          pen.quadraticCurveTo(x, y + 1.3 * k, x - a * 0.8 * sz, y + 0.55 * k)
          pen.closePath()
          pen.fillStyle = css(core)
          pen.fill()
          pen.globalAlpha = 1
          // 林缘：鳞心里再套一道弧（青海波的同心弧），针叶是一根中脉
          if (rim) {
            pen.beginPath()
            if (kind === 'pine') {
              pen.moveTo(x, y - h * 0.62)
              pen.lineTo(x, y - h * 0.08)
            } else dome(pen, 0.5, 0.9 * k)
            pen.strokeStyle = css(edge)
            pen.lineWidth = 0.55 * k
            pen.stroke()
          }
        })
      }
    }
  },
}

// ———————————————————————— 树：屏风画的松与杉 ————————————————————————

/** 叶团：底平、顶上几个扇贝形的弧 */
function addPad(pen: Pen, cx: number, cy: number, w: number, h: number, n: number) {
  const x0 = cx - w / 2
  pen.moveTo(x0, cy)
  for (let j = 0; j < n; j++) {
    const xa = x0 + (w * j) / n
    const xb = x0 + (w * (j + 1)) / n
    const ya = j === 0 ? cy : cy - h * 0.45
    const yb = j === n - 1 ? cy : cy - h * 0.45
    const peak = h * (n > 2 && (j === 0 || j === n - 1) ? 0.82 : 1)
    pen.quadraticCurveTo((xa + xb) / 2, cy - peak * 2 + (cy - ya + (cy - yb)) / 2, xb, yb)
  }
  pen.closePath()
}

const PINE_GREEN: RGB = [62, 104, 84]
const CEDAR_GREEN: RGB = [52, 88, 86]

/** 一处树：t.n 棵，按 kind 画松（阔叶、雨林、金合欢）或杉（针叶），灌丛是贴地的扁叶团 */
function byobuTree(pen: Pen, x: number, y: number, s: number, kind: TreeKind, seed: number, k: number, lean: number) {
  const r = rnd(seed)
  const trunk = 'rgb(98,78,62)'
  const pad = (cx: number, cy: number, w: number, h: number, n: number, c: RGB) => {
    // 叶团下缘一道深色（版画的"当て"），上面是叶团
    pen.beginPath()
    addPad(pen, cx, cy + 0.35 * k, w, h, n)
    pen.fillStyle = css(mixRGB(c, [20, 30, 30], 0.35))
    pen.fill()
    pen.beginPath()
    addPad(pen, cx, cy - 0.2 * k, w * 0.96, h * 0.92, n)
    pen.fillStyle = css(c)
    pen.fill()
  }
  if (kind === 'bush') {
    pad(x, y, s * 1.6, s * 0.6, 3, mixRGB(PINE_GREEN, OUDO, 0.35))
    return
  }
  if (kind === 'pine') {
    // 杉：直干，一层层底平的三角檐，越往上越窄
    pen.beginPath()
    addTaper(pen, [[x, y + 0.3 * s], [x, y - 2.6 * s]], (u) => (0.8 - 0.4 * u) * k)
    pen.fillStyle = trunk
    pen.fill()
    const tiers = 4
    for (let j = 0; j < tiers; j++) {
      const cy = y - 0.55 * s - j * 0.62 * s
      const w = s * (1.05 - j * 0.2)
      const ht = s * (j === tiers - 1 ? 0.95 : 0.62)
      pen.beginPath()
      pen.moveTo(x - w, cy)
      pen.quadraticCurveTo(x - w * 0.3, cy - ht * 0.35, x, cy - ht)
      pen.quadraticCurveTo(x + w * 0.3, cy - ht * 0.35, x + w, cy)
      pen.quadraticCurveTo(x, cy - ht * 0.15, x - w, cy)
      pen.closePath()
      pen.fillStyle = css(j % 2 ? CEDAR_GREEN : mixRGB(CEDAR_GREEN, [20, 30, 34], 0.3))
      pen.fill()
    }
    return
  }
  // 松：弯两折的干，托着两三片扁平的叶团
  const d = lean
  const topP: P = [x + 0.15 * s * d, y - 1.9 * s]
  pen.beginPath()
  addTaper(pen, chaikin([[x - 0.05 * s * d, y + 0.25 * s], [x + 0.35 * s * d, y - 0.7 * s], [x - 0.2 * s * d, y - 1.3 * s], topP], 2), (u) => (1.0 - 0.6 * u) * k)
  // 一根横出的枝
  addTaper(pen, [[x + 0.2 * s * d, y - 0.95 * s], [x + 0.8 * s * d, y - 1.0 * s]], (u) => (0.55 - 0.3 * u) * k)
  pen.fillStyle = trunk
  pen.fill()
  const c = kind === 'jungle' ? mixRGB(PINE_GREEN, [40, 80, 60], 0.4) : kind === 'acacia' ? mixRGB(PINE_GREEN, OUDO, 0.3) : PINE_GREEN
  const wide = kind === 'acacia' ? 1.3 : 1
  pad(x + 0.85 * s * d, y - 0.95 * s, 1.15 * s * wide, 0.5 * s, 2, mixRGB(c, KINARI, 0.15))
  if (r(1) > 0.35) pad(x - 0.55 * s * d, y - 1.42 * s, 1.1 * s * wide, 0.5 * s, 2, c)
  pad(topP[0], topP[1] + 0.05 * s, 1.7 * s * wide, 0.66 * s, 3, c)
}

export const wafuTrees: SymbolStyle = {
  id: 'wafu-tree',
  name: '屏风松',
  desc: '屏风画的松与杉：松是弯两折的干托着两三片底平顶圆的扁叶团，杉是直干上一层层的檐；叶团下缘一道深色，不用墨线。',
  draw(T, _o, out) {
    const k = T.k
    for (const t of T.trees) {
      // 稀树草原、灌丛的树只留一半：平地留白
      if ((t.kind === 'acacia' || t.kind === 'bush') && hash(t.seed, 31) < 0.5) continue
      out.item(t.y + t.s * 0.3, (pen) => {
        const r = rnd(t.seed)
        const n = Math.min(3, t.n)
        const flip = r(2) > 0.5 ? 1 : -1
        const pos: [number, number, number][] = n === 1 ? [[0, 0, 1.05]] : n === 2 ? [[-0.7, -0.25, 0.85], [0.6, 0.1, 1]] : [[-1.0, -0.3, 0.8], [0.95, -0.2, 0.85], [0.05, 0.2, 1]]
        pos.forEach(([dx, dy, m], i) => byobuTree(pen, t.x + dx * flip * t.s, t.y + dy * t.s, t.s * m, t.kind, t.seed + i * 131, k, (dx * flip > 0.1 ? -1 : dx * flip < -0.1 ? 1 : flip)))
      })
    }
  },
}

// ———————————————————————— 平铺笔触 ————————————————————————

/**
 * 和风的平铺笔触：草原、灌丛、苔原留白（版画的平地是纸，底图已有极淡的设色）；
 * 沙地撒砂子（大和绘里撒在金地上的金箔碎屑：大小不一的小方块，疏密成片）；沼泽是两三道浅葱的短横线（水纹）
 */
export function wafuFlat(ctx: CanvasRenderingContext2D, f: Fields, _o: GlyphColors, k: number, wet: (i: number) => boolean) {
  const { world, S, W, H } = f
  const e = world.elevation
  const bio = world.biome
  const pen = ctx as unknown as Pen
  // 砂子
  const gold = [css(mixRGB(OUDO, [150, 118, 60], 0.2)), css(mixRGB(OUDO, KINARI, 0.3))]
  for (const g of [0, 1]) {
    pen.beginPath()
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        const b = bio[i]
        const p = b === Biome.HotDesert ? 0.11 : b === Biome.ColdDesert ? 0.07 : b === Biome.SaltFlat ? 0.05 : 0
        if (!p || e[i] <= 0.01 || wet(i)) continue
        if ((hash(x * 7, y * 13) > 0.5 ? 1 : 0) !== g) continue
        // 成团：只在噪声高处撒，团心密、团边稀
        const q = p * smooth(0.48, 0.78, fnoise(x * S, y * S, 40 * k)) * 2.4
        if (hash(x * 3, y * 5) > q) continue
        const sz = (0.35 + hash(x, y * 3) ** 3 * 1.1) * k
        const px = (x + hash(x + 1, y * 2) - 0.5) * S
        const py = (y + hash(x * 2, y + 1) - 0.5) * S
        // 箔屑：略斜的小方块
        const t = hash(x, y) * 1.2
        const c = Math.cos(t) * sz
        const s = Math.sin(t) * sz
        pen.moveTo(px - c + s, py - s - c)
        pen.lineTo(px + c + s, py + s - c)
        pen.lineTo(px + c - s, py + s + c)
        pen.lineTo(px - c - s, py - s + c)
        pen.closePath()
      }
    }
    pen.fillStyle = gold[g]
    pen.globalAlpha = 0.85
    pen.fill()
  }
  // 沼泽：两三道浅葱的短横线
  pen.beginPath()
  for (let y = 2; y < H - 2; y += 3) {
    for (let x = 2 + (y % 2) * 2; x < W - 2; x += 4) {
      if (bio[y * W + x] !== Biome.Wetland || hash(x * 3, y * 7) > 0.5) continue
      const px = (x + (hash(x + 7, y) - 0.5) * 2) * S
      const py = (y + (hash(x, y + 7) - 0.5) * 2) * S
      const n = 2 + (hash(x, y * 3) > 0.6 ? 1 : 0)
      for (let j = 0; j < n; j++) {
        const len = (2.6 + hash(x * 5 + j, y) * 2.4) * (1 - j * 0.2) * k
        const ox = px + (j % 2 ? 1.2 : -0.6) * k
        addTaper(pen, [[ox - len, py + j * 1.6 * k], [ox + len, py + j * 1.6 * k]], (u) => (0.25 + 0.45 * Math.sin(Math.PI * u)) * k)
      }
    }
  }
  pen.fillStyle = css(mixRGB(ASAGI, AI, 0.3))
  pen.globalAlpha = 0.75
  pen.fill()
  pen.globalAlpha = 1
}

// ———————————————————————— 底图 ————————————————————————

/**
 * 青海波的图块：一排排同心的半圆，下一排遮住上一排。只画每道弧露出来的那一段（底子透明，不遮下面的晕染）
 */
function seigaiha(R: number, lw: number) {
  const w = 2 * R
  const h = R
  const rings = [1, 0.72, 0.44]
  // 遮住圆心在 (0,0) 那组弧的圆：下一排的左右两个与再下一排正下方的一个
  const covers: P[] = [
    [-R, h / 2],
    [R, h / 2],
    [0, h],
  ]
  // 每道弧露出的角度区间（y 朝下：上半圆是 π~2π），按数值求，左右对称
  const arcs = rings.map((f) => {
    const rr = R * f
    let lo = 1.5 * Math.PI
    for (let t = 1.5 * Math.PI; t >= Math.PI * 0.5; t -= 0.002) {
      const px = Math.cos(t) * rr
      const py = Math.sin(t) * rr
      if (covers.some(([cx, cy]) => Math.hypot(px - cx, py - cy) < R - 1e-6)) break
      lo = t
    }
    return { rr, a0: lo, a1: 3 * Math.PI - lo }
  })
  const centers: P[] = [
    [0, 0],
    [w, 0],
    [R, h / 2],
    [0, h],
    [w, h],
  ]
  const line = css(mixRGB(ASAGI, AI, 0.35))
  const n2 = (v: number) => v.toFixed(2)
  const d = centers
    .flatMap(([cx, cy]) =>
      arcs.map(({ rr, a0, a1 }) => {
        const sx = cx + Math.cos(a0) * rr
        const sy = cy + Math.sin(a0) * rr
        const ex = cx + Math.cos(a1) * rr
        const ey = cy + Math.sin(a1) * rr
        return `M${n2(sx)} ${n2(sy)}A${n2(rr)} ${n2(rr)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${n2(ex)} ${n2(ey)}`
      }),
    )
    .join('')
  let tile: HTMLCanvasElement | undefined
  return {
    w,
    h,
    svg: `<path d="${d}" fill="none" stroke="${line}" stroke-width="${lw}"/>`,
    tile: () => {
      if (tile) return tile
      const c = document.createElement('canvas')
      const z = 4
      c.width = Math.round(w * z)
      c.height = Math.round(h * z)
      const g = c.getContext('2d')!
      g.scale(z, z)
      g.strokeStyle = line
      g.lineWidth = lw
      for (const [cx, cy] of centers) {
        for (const { rr, a0, a1 } of arcs) {
          g.beginPath()
          g.arc(cx, cy, rr, a0, a1)
          g.stroke()
        }
      }
      return (tile = c)
    },
  }
}

/** 和纸的纤维：稀疏的细长弯丝 */
function fiber(size: number, k: number) {
  const strands: string[] = []
  const paths: [number, number, number, number, number, number][] = []
  for (let i = 0; i < 46; i++) {
    const x = hash(i, 1) * size
    const y = hash(i, 2) * size
    const a = hash(i, 3) * Math.PI * 2
    const l = (6 + hash(i, 4) * 16) * k
    const bend = (hash(i, 5) - 0.5) * l * 0.5
    const ex = x + Math.cos(a) * l
    const ey = y + Math.sin(a) * l
    const cx = (x + ex) / 2 - Math.sin(a) * bend
    const cy = (y + ey) / 2 + Math.cos(a) * bend
    paths.push([x, y, cx, cy, ex, ey])
    strands.push(`M${x.toFixed(1)} ${y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`)
  }
  const color = 'rgb(160,140,105)'
  let tile: HTMLCanvasElement | undefined
  return {
    w: size,
    h: size,
    svg: `<path d="${strands.join('')}" fill="none" stroke="${color}" stroke-width="${(0.35 * k).toFixed(2)}" stroke-opacity="0.32"/>`,
    tile: () => {
      if (tile) return tile
      const c = document.createElement('canvas')
      c.width = c.height = Math.round(size)
      const g = c.getContext('2d')!
      g.strokeStyle = color
      g.globalAlpha = 0.32
      g.lineWidth = 0.35 * k
      g.beginPath()
      for (const [x, y, cx, cy, ex, ey] of paths) {
        g.moveTo(x, y)
        g.quadraticCurveTo(cx, cy, ex, ey)
      }
      g.stroke()
      return (tile = c)
    },
  }
}

/**
 * 和纸底图：海面是纸，近岸一圈靛蓝的晕染（版画的ぼかし），局部的近岸水面压一层很淡的青海波；
 * 陆地是生成色与极淡的群系设色，海岸一道藍线；山地不加晕渲（山的形由符号承担）
 */
export const wafuVector: VectorDraw = (L: Layers, world: World, F: VectorFields, env) => {
  const k = env.S / 2
  const { W, H } = world
  const cd = world.coastDist
  L.list.patterns.set('seigaihaP', seigaiha(5.2 * k, 0.5 * k))
  L.list.patterns.set('washiP', fiber(220 * k, k))
  L.rect(rgb(WASHI))
  // 近岸的藍：外宽内窄、越近越浓
  for (let j = 0; j < 14; j++) {
    const d = 1.6 * Math.pow(36 / 1.6, 1 - j / 13)
    L.fill(cd, -d, rgb(COAST_BLUE), j < 4 ? 0.024 : 0.032)
  }
  // 青海波：只在近岸、且按低频噪声成片出现（局部），外缘不是一刀切而是两层
  const band = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      // 宽度随噪声在 0~16 格之间平滑地变：没有拐角，噪声低处整段没有
      band[i] = cd[i] + 7 + 44 * (fnoise(x * 2, y * 2, 110) - 0.5)
    }
  }
  L.fill(band, 0, 'url(#seigaihaP)', 0.2)
  L.fill(band, 2.5, 'url(#seigaihaP)', 0.2)
  L.fill(F.ice, 0, 'rgb(246,244,238)')
  L.fill(F.land, 0, rgb(KINARI))
  biomeLayers(L, world, TINT, BIOME_ALPHA)
  L.fill(F.lake, 0.5, rgb(mixRGB(ASAGI, WASHI, 0.55)), 1, { stroke: { color: rgb(AI), width: 0.8, alpha: 0.85 } })
  L.rect('url(#washiP)', 1)
  // 海岸：一道藍线，外侧再一道极细的浅葱
  L.line(cd, -1.1, rgb(ASAGI), 0.6, 0.5)
  L.line(F.land, 0, rgb(AI), 1.35, 0.92)
}

/** 和风的符号配色（kitDrawer 的 GlyphColors；山、林、树多用本文件的套色） */
export const WAFU_GLYPHS: GlyphColors = {
  ink: SUMI,
  paper: css(KINARI),
  shadow: 'rgb(150,160,140)',
  snow: css(GOFUN),
  leaf: 'rgb(128,164,124)',
  leafDark: 'rgb(82,126,98)',
  pine: 'rgb(100,146,138)',
  pineDark: 'rgb(58,104,102)',
  grass: 'rgb(150,150,110)',
}

/**
 * 和风：以水墨风格为底（沿用它的简洁图框、竖排图名与朱印），换上和纸底图、霞岳、鳞林、屏风松与和风的平铺笔触；
 * 注记用明朝体（思源宋体）、水的注记用藍，道路是国绘图式的朱线
 */
export function wafuTheme(base: Theme): Theme {
  return {
    ...base,
    id: 'wafu',
    name: '和风',
    desc: '霞岳 · 鳞林 · 屏风松',
    paper: WASHI,
    ink: SUMI,
    vector: () => Promise.resolve(wafuVector),
    river: { color: 'rgba(46, 72, 104, 0.85)', width: 0.9, minFlow: 2.2, fitCoast: true },
    roads: { color: `rgba(${SHU.join(',')}, 0.78)`, width: 0.9, dash: [5, 2.2], sea: 'rgba(46, 72, 104, 0.4)', seaDash: [2, 4] },
    glyphs: WAFU_GLYPHS,
    glyphDraw: kitDrawer({ mountain: wafuMountain, forest: wafuForest, tree: wafuTrees }, { flat: wafuFlat }),
    aged: false,
    // 和纸没有水渍：纸纹只用底图里的纤维
    paperTexture: false,
    labels: {
      ...base.labels,
      display: SONG,
      text: SONG,
      water: 'rgb(46, 72, 104)',
      land: '#2c2a27',
      range: '#3a332b',
      region: '#6a5236',
      city: '#2c2a27',
      halo: 'rgba(240, 233, 214, 0.9)',
    },
  }
}
