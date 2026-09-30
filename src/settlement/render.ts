import { eastAsian } from './culture'
import { contours, simplify, type Ring } from '../render/atlas/svg/contour'
import { DisplayList, rasterArea, rasterPoly, type BBox, type Fill, type Item, type LabelArea, type PathItem, type Stroke } from '../render/atlas/svg/displayList'
import { blur } from '../gen/util'
import { bboxOf, centroid, circlePoly, dist, obb, pointAt, pointInPoly, polylineLength, rect, type P, type Poly } from './geom'
import { settleTheme, type SettleStyleId, type SettleTheme } from './themes'
import type { BuildingKind, Field, MapLabel, Road, Settlement, SettlementSize } from './types'
import { LAND_USES, isDarkGround, landUseColor, landUseOf, landUseStats, type LandUse } from './landuse'
import { tr } from '../i18n'
import { regionShown, type SettleRegion } from './regions'
import * as dmath from '../gen/dmath'
import { GLYPH_R, HALO_RATIO, LABEL_PAD, labelPx } from '../render/atlas/labelSize'

type Lang = 'zh' | 'en' | 'ja'

export interface SettleOpts {
  labels: boolean
  contours: boolean
  /** 地图文字的语言（默认中文） */
  lang?: Lang
  /** map：普通地图（默认）；zoning：区划图，片区按用地性质着色 */
  view?: 'map' | 'zoning'
  /** 区划图里关掉（不着色）的类 */
  hidden?: LandUse[]
  /** 浏览器图廓层里画不画图饰（标题框、指北针、区划图例）；整页导出总是画 */
  ornaments?: boolean
  /** 命名区域（区域视图里改过的）：给了就按区域标片区名（见 regions.ts） */
  regions?: SettleRegion[]
}

const SIZE_NAME: Record<Lang, Record<SettlementSize, string>> = {
  zh: { hamlet: '小村', village: '村镇', town: '城镇', city: '城市' },
  en: { hamlet: 'Hamlet', village: 'Village', town: 'Town', city: 'City' },
  ja: { hamlet: '小村', village: '村', town: '町', city: '都市' },
}
/** 都城的标题不论人口都写作都城 */
const CAPITAL_NAME: Record<Lang, string> = { zh: '都城', en: 'Capital', ja: '都' }
const POP_TEXT: Record<Lang, (n: string) => string> = { zh: (n) => `约 ${n} 人`, en: (n) => `pop. ${n}`, ja: (n) => `人口 約${n}人` }
const CJK_SC = ['"Noto Serif SC"', '"Noto Sans SC"', '"Ma Shan Zheng"']

/**
 * 主题字体按语言调整：日文换成日本字形（Noto Serif JP），英文把拉丁字体排到中文字体前面。
 */
function langFont(f: string, lg: Lang): string {
  if (lg === 'zh') return f
  const italic = f.startsWith('italic ')
  const fams = f.replace(/^italic /, '').split(',').map((x) => x.trim())
  let out: string[]
  if (lg === 'ja') out = fams.map((x) => (x === '"Noto Serif SC"' ? '"Noto Serif JP"' : x === '"Noto Sans SC"' ? '"Noto Sans JP"' : x))
  else out = [...fams.filter((x) => !CJK_SC.includes(x) && !/^(serif|sans-serif)$/.test(x)), ...fams.filter((x) => CJK_SC.includes(x) || /^(serif|sans-serif)$/.test(x))]
  return (italic ? 'italic ' : '') + out.join(', ')
}

/**
 * 聚落地图 → 矢量显示列表（与世界纸图共用 DisplayList：预览、PNG 与 SVG 导出一致）。
 * 坐标：米 × S = 页面像素。
 */
/** 风格的字体按语言换成对应的字族 */
function themeFor(style: SettleStyleId, lg: Lang): SettleTheme {
  const th0 = settleTheme(style)
  return { ...th0, font: { title: langFont(th0.font.title, lg), label: langFont(th0.font.label, lg), italic: langFont(th0.font.italic, lg) } }
}

/** 整页排版时的比例（页面像素 / 米）：地图宽 1900 像素 */
export const settlePageScale = (st: Settlement) => 1900 / st.width

/** 聚落图注记按设计字号显示时的倍率：页面字号 = 设计字号 ÷ 它（整页 1900 像素宽，导出时字比屏幕上略小） */
const SETTLE_LABEL_K = 1.15

export function buildSettlementVector(st: Settlement, style: SettleStyleId, opts: SettleOpts, measurer: CanvasRenderingContext2D): DisplayList {
  const lg = opts.lang ?? 'zh'
  const th = themeFor(style, lg)
  const S = settlePageScale(st)
  const M = 44
  const MW = Math.round(st.width * S)
  const MH = Math.round(st.height * S)
  const list = new DisplayList(MW + M * 2, MH + M * 2, M, MW, MH)
  list.labelK = SETTLE_LABEL_K
  const R = new Painter(list, S, th)
  hatchPatterns(list, th)

  // 纸
  list.path('page', `M0 0H${list.width}V${list.height}H0Z`, { fill: { color: th.paper, alpha: 1 } })
  if (opts.view === 'zoning') {
    zoningMap(R, st, th, opts, measurer, lg)
    furniture(list, st, th, S, M, M, MW, MH, measurer, lg)
    return list
  }
  R.rect(th.ground)
  terrainLayers(R, st, th, opts)
  fieldFills(R, st, th)
  furrows(R, st, th)
  for (const g of st.greens) R.poly(g.poly, { color: th.green[g.kind], alpha: 1 }, g.kind === 'cemetery' ? { color: th.ink, alpha: 0.35, width: 0.5 } : undefined)
  urbanGround(R, st, th)
  waterLayers(R, st, th)
  wonderGlow(R, st, th)
  roads(R, st, th)
  crossingLayers(R, st, th)
  for (const p of st.piers) R.poly(p, { color: th.plaza, alpha: 1 }, { color: th.ink, alpha: 0.8, width: 0.7 })
  boatLayers(R, st, th)
  enclosureLayers(R, st, th)
  parkRocks(R, st, th)
  buildingLayers(R, st, th)
  // 树冠压在房顶上，但城墙在最上面（墙根的树不遮墙）
  treeLayers(R, st, th)
  toriiLayer(R, st, th)
  wallLayers(R, st, th)
  wonderLayers(R, st, th)
  if (opts.labels) labelLayers(R, st, th, measurer, lg, undefined, opts.regions)
  furniture(list, st, th, S, M, M, MW, MH, measurer, lg)
  return list
}

const pick = <T>(arr: T[], t: number) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))]
const f1 = (v: number) => (Math.round(v * 10) / 10).toString()

class Painter {
  constructor(
    readonly list: DisplayList,
    readonly S: number,
    readonly th: SettleTheme,
  ) {}

  polyD(poly: Poly) {
    if (poly.length < 3) return ''
    const S = this.S
    let d = `M${f1(poly[0][0] * S)} ${f1(poly[0][1] * S)}`
    for (let i = 1; i < poly.length; i++) d += `L${f1(poly[i][0] * S)} ${f1(poly[i][1] * S)}`
    return d + 'Z'
  }

  lineD(line: P[]) {
    if (line.length < 2) return ''
    const S = this.S
    let d = `M${f1(line[0][0] * S)} ${f1(line[0][1] * S)}`
    for (let i = 1; i < line.length; i++) d += `L${f1(line[i][0] * S)} ${f1(line[i][1] * S)}`
    return d
  }

  circleD(c: P, r: number) {
    const S = this.S
    const x = c[0] * S
    const y = c[1] * S
    const rr = r * S
    return `M${f1(x + rr)} ${f1(y)}A${f1(rr)} ${f1(rr)} 0 1 1 ${f1(x - rr)} ${f1(y)}A${f1(rr)} ${f1(rr)} 0 1 1 ${f1(x + rr)} ${f1(y)}Z`
  }

  fillOf(color: string, alpha = 1): Fill {
    return color.startsWith('url(') ? { pattern: color.slice(5, -1), alpha } : { color, alpha }
  }

  poly(poly: Poly, fill?: { color: string; alpha: number }, stroke?: { color: string; alpha: number; width: number; dash?: number[] }) {
    const d = this.polyD(poly)
    if (!d) return
    this.list.path('map', d, {
      fill: fill ? this.fillOf(fill.color, fill.alpha) : undefined,
      stroke: stroke ? { ...stroke, width: stroke.width, join: 'round', cap: 'round' } : undefined,
    })
  }

  /** 同样式的一批多边形合成一条路径 */
  polys(polys: Poly[], fill?: Fill, stroke?: Stroke) {
    const d = polys.map((p) => this.polyD(p)).join('')
    if (d) this.list.path('map', d, { fill, stroke })
  }

  lines(lines: P[][], stroke: Stroke) {
    const d = lines.map((l) => this.lineD(l)).join('')
    if (d) this.list.path('map', d, { stroke })
  }

  rect(color: string) {
    const w = this.list.MW
    const h = this.list.MH
    this.list.path('map', `M-4 -4L${w + 4} -4L${w + 4} ${h + 4}L-4 ${h + 4}Z`, { fill: this.fillOf(color) })
  }

  /** 地形栅格的等值区（场 ≥ level） */
  field(field: Float32Array, W: number, H: number, cell: number, level: number, fill: Fill | null, stroke?: Stroke, smooth = true) {
    const rings = contours(field, W, H, level, !stroke || !!fill)
    const d = ringsD(rings, cell * this.S, !!fill || !stroke, smooth)
    if (d) this.list.path('map', d, { fill: fill ? { ...fill, rule: 'evenodd' } : undefined, stroke })
  }
}

/** 折线（交错的 x, y）里超过 step 的边等分加点；closed 时首尾之间那条边也算 */
function densify(r: Float32Array, step: number, closed: boolean): Float32Array {
  const n = r.length / 2
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const x = r[i * 2]
    const y = r[i * 2 + 1]
    out.push(x, y)
    if (i + 1 === n && !closed) break
    const j = (i + 1) % n
    const nx = r[j * 2]
    const ny = r[j * 2 + 1]
    const m = Math.ceil(dmath.hypot(nx - x, ny - y) / step)
    for (let k = 1; k < m; k++) out.push(x + ((nx - x) * k) / m, y + ((ny - y) * k) / m)
  }
  return Float32Array.from(out)
}

/** 环（格坐标，格点 = 节点）→ 路径，中点二次贝塞尔平滑 */
function ringsD(rings: Ring[], k: number, closed: boolean, smooth: boolean) {
  const parts: string[] = []
  const f = (v: number) => f1(v * k)
  for (const raw of rings) {
    // 简化后长边再切成不超过 2 格的短段：中点平滑只在局部圆角，
    // 否则沿地图边缘的长直边会被平滑成一道大弧，把角落的海面切掉
    const r = smooth ? densify(simplify(raw, 0.3), 2, closed) : simplify(raw, 0.3)
    const n = r.length / 2
    if (n < 3) continue
    const isClosed = closed || dmath.hypot(r[0] - r[(n - 1) * 2], r[1] - r[(n - 1) * 2 + 1]) < 1.01
    if (!smooth) {
      let d = `M${f(r[0])} ${f(r[1])}`
      for (let i = 1; i < n; i++) d += `L${f(r[i * 2])} ${f(r[i * 2 + 1])}`
      parts.push(isClosed ? d + 'Z' : d)
      continue
    }
    const mid = (i: number, j: number, c: 0 | 1) => (r[i * 2 + c] + r[j * 2 + c]) / 2
    if (isClosed) {
      let d = `M${f(mid(0, 1, 0))} ${f(mid(0, 1, 1))}`
      for (let i = 1; i <= n; i++) {
        const a = i % n
        const b = (i + 1) % n
        d += `Q${f(r[a * 2])} ${f(r[a * 2 + 1])} ${f(mid(a, b, 0))} ${f(mid(a, b, 1))}`
      }
      parts.push(d + 'Z')
    } else {
      let d = `M${f(r[0])} ${f(r[1])}`
      for (let i = 1; i < n - 1; i++) d += `Q${f(r[i * 2])} ${f(r[i * 2 + 1])} ${f(mid(i, i + 1, 0))} ${f(mid(i, i + 1, 1))}`
      parts.push(d + `L${f(r[(n - 1) * 2])} ${f(r[(n - 1) * 2 + 1])}`)
    }
  }
  return parts.join('')
}

function hatchPatterns(list: DisplayList, th: SettleTheme) {
  const make = (id: string, step: number, cross: boolean, color = th.hatch!, bg = th.ground, width = 0.7, crossWidth = 0.6) => {
    const s = step
    const svg =
      `<rect width="${s}" height="${s}" fill="${bg}"/>` +
      `<path d="M0 ${s}L${s} 0M${-s / 2} ${s / 2}L${s / 2} ${-s / 2}M${s / 2} ${s * 1.5}L${s * 1.5} ${s / 2}" stroke="${color}" stroke-width="${width}"/>` +
      (cross ? `<path d="M0 0L${s} ${s}" stroke="${color}" stroke-width="${crossWidth}"/>` : '')
    list.patterns.set(id, {
      w: s,
      h: s,
      svg,
      tile: () => {
        const c = document.createElement('canvas')
        const k = 4
        c.width = c.height = Math.round(s * k)
        const g = c.getContext('2d')!
        g.fillStyle = bg
        g.fillRect(0, 0, c.width, c.height)
        g.strokeStyle = color
        g.lineWidth = width * k
        g.beginPath()
        g.moveTo(0, s * k)
        g.lineTo(s * k, 0)
        g.moveTo((-s / 2) * k, (s / 2) * k)
        g.lineTo((s / 2) * k, (-s / 2) * k)
        g.moveTo((s / 2) * k, s * 1.5 * k)
        g.lineTo(s * 1.5 * k, (s / 2) * k)
        if (cross) {
          g.moveTo(0, 0)
          g.lineTo(s * k, s * k)
        }
        g.stroke()
        return c
      },
    })
  }
  if (th.hatch) {
    make('hatch', 2.6, false)
    make('hatch2', 2.2, true)
  }
  for (const p of th.patterns ?? []) make(p.id, p.step, p.cross, p.color, p.bg, p.width, p.width * 0.85)
}

// —————————————————————— 地形与水 ——————————————————————

/**
 * 绘制用的地形场：生成用的是固定 5 米的细网格（大地图上很大），晕渲、等高线、水线追踪轮廓时
 * 降采样到至多 maxW 列（取平均），和图面的细节相当，追踪快得多。
 */
function coarseTerrain(t: Settlement['terrain'], maxW: number) {
  const s = Math.max(1, Math.ceil(t.W / maxW))
  if (s === 1) return t
  const W = Math.ceil(t.W / s)
  const H = Math.ceil(t.H / s)
  const height = new Float32Array(W * H)
  const water = new Float32Array(W * H)
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      let h = 0
      let w = 0
      let n = 0
      for (let y = j * s; y < Math.min(t.H, j * s + s); y++)
        for (let x = i * s; x < Math.min(t.W, i * s + s); x++) {
          h += t.height[y * t.W + x]
          w += t.water[y * t.W + x]
          n++
        }
      height[j * W + i] = h / n
      water[j * W + i] = w / n
    }
  return { ...t, W, H, cell: t.cell * s, height, water }
}

/**
 * 只取决于地形网格的图层（晕渲、等高线、水面）：成长动画、拖人口时逐帧重画，地形一般不变。
 * 按网格内容、画幅与画法记下上次生成的绘制项，下一帧直接放进来，不再追踪等值线、拼路径。
 * 绘制项不会被改写，几张地图共用同一批没有问题
 */
const layerMemo = new Map<string, Item[]>()
function memoLayer(R: Painter, key: string, draw: () => void) {
  const seg = R.list.segment('map')
  const hit = layerMemo.get(key)
  if (hit) {
    seg.items.push(...hit)
    return
  }
  const n0 = seg.items.length
  draw()
  // 只在全写进了同一段时记下（这几层都只写地图段）
  if (R.list.segments.at(-1) !== seg) return
  if (layerMemo.size >= 8) layerMemo.delete(layerMemo.keys().next().value!)
  layerMemo.set(key, seg.items.slice(n0))
}
/** 地形网格的内容指纹（高程、水距逐位哈希） */
const terrainPrints = new WeakMap<Settlement['terrain'], string>()
function terrainPrint(t: Settlement['terrain']) {
  let v = terrainPrints.get(t)
  if (v) return v
  let h = 2166136261
  for (const a of [t.height, t.water]) {
    const u = new Uint32Array(a.buffer, a.byteOffset, a.length)
    for (let k = 0; k < u.length; k++) h = Math.imul(h ^ u[k], 16777619)
  }
  v = `${t.W}x${t.H}@${t.cell}#${(h >>> 0).toString(36)}`
  terrainPrints.set(t, v)
  return v
}
const layerKey = (tag: string, R: Painter, st: Settlement, th: SettleTheme, extra = '') => `${tag}|${terrainPrint(st.terrain)}|${st.width}x${st.height}|${R.S}|${JSON.stringify(th)}|${extra}`

function terrainLayers(R: Painter, st: Settlement, th: SettleTheme, opts: SettleOpts) {
  memoLayer(R, layerKey('terrain', R, st, th, String(!!opts.contours)), () => drawTerrain(R, st, th, opts))
}
function drawTerrain(R: Painter, st: Settlement, th: SettleTheme, opts: SettleOpts) {
  const { W, H, cell, height, water } = coarseTerrain(st.terrain, 420)
  // 晕渲（西北光）
  const dark = new Float32Array(W * H)
  const light = new Float32Array(W * H)
  const z = 1.1
  for (let j = 1; j < H - 1; j++)
    for (let i = 1; i < W - 1; i++) {
      const k = j * W + i
      if (water[k] < 0) {
        dark[k] = light[k] = -1
        continue
      }
      const nx = (-(height[k + 1] - height[k - 1]) / (2 * cell)) * z
      const ny = (-(height[k + W] - height[k - W]) / (2 * cell)) * z
      const inv = 1 / dmath.hypot(nx, ny, 1)
      const l = ((nx * -0.6 + ny * -0.6 + 0.53) * inv) / 0.53
      dark[k] = 1 - l
      light[k] = l - 1
    }
  blur(dark, W, H, 1, 2)
  blur(light, W, H, 1, 2)
  for (const t of [0.07, 0.15, 0.25, 0.37, 0.5]) R.field(dark, W, H, cell, t, { color: th.shade.color, alpha: th.shade.alpha })
  if (th.shade.light > 0) for (const t of [0.03, 0.08]) R.field(light, W, H, cell, t, { color: '#ffffff', alpha: th.shade.light * 0.5 })
  if (!opts.contours || !th.contour) return
  // 等高线：按高差选等高距，陆上才画
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < W * H; k++)
    if (water[k] > 0) {
      lo = Math.min(lo, height[k])
      hi = Math.max(hi, height[k])
    }
  const range = hi - lo
  const step = range < 12 ? 1 : range < 30 ? 2 : range < 70 ? 5 : range < 160 ? 10 : 20
  const land = new Float32Array(W * H)
  for (let k = 0; k < W * H; k++) land[k] = water[k] < 0 ? -999 : height[k]
  const c = th.contour
  for (let h = Math.ceil(lo / step) * step; h < hi; h += step) {
    if (h <= 0) continue
    const idx = Math.round(h / step) % 5 === 0
    R.field(land, W, H, cell, h, null, { color: c.color, alpha: c.alpha * (idx ? 1.4 : 0.8), width: c.width * (idx ? 1.5 : 1), cap: 'round', join: 'round' })
  }
}

function waterLayers(R: Painter, st: Settlement, th: SettleTheme) {
  memoLayer(R, layerKey('water', R, st, th), () => drawWater(R, st, th))
}
function drawWater(R: Painter, st: Settlement, th: SettleTheme) {
  // 水面比地形晕渲要细一些（窄河也要画得出）
  const { W, H, cell, water } = coarseTerrain(st.terrain, 720)
  const wet = new Float32Array(W * H)
  for (let k = 0; k < W * H; k++) wet[k] = -water[k]
  R.field(wet, W, H, cell, 0, { color: th.water, alpha: 1 })
  R.field(wet, W, H, cell, 22, { color: th.waterDeep, alpha: 1 })
  // 水线：离岸越远越淡
  const lines = [2.2, 5, 9, 15]
  lines.forEach((d, i) => R.field(wet, W, H, cell, d, null, { color: th.waterLine.color, alpha: th.waterLine.alpha[i], width: 0.6, cap: 'round', join: 'round' }))
  R.field(wet, W, H, cell, 0, null, { color: th.waterEdge ?? th.ink, alpha: 0.75, width: 0.9, cap: 'round', join: 'round' })
  // 水面纹样：铜版的横纹、波纹、鱼鳞状的水波（方志舆图）
  const wh = th.waterHatch
  if (wh) {
    const S = R.S
    const step = wh.step ?? 3.2
    const d: string[] = []
    let row = 0
    for (let y = 3; y < st.height; y += step, row++)
      for (let x = 0; x < st.width; ) {
        while (x < st.width && water[Math.round(y / cell) * W + Math.round(x / cell)] > -3) x += 1.5
        const x0 = x
        while (x < st.width && water[Math.round(y / cell) * W + Math.round(x / cell)] <= -3) x += 1.5
        if (x - x0 <= 3) continue
        const x1 = x - 1.5
        if (wh.kind === 'lines') {
          d.push(`M${f1(x0 * S)} ${f1(y * S)}H${f1(x1 * S)}`)
          continue
        }
        // 波长与波幅随行距；相邻两行错开半个波长，读起来像一片连绵的水纹
        const lam = step * 2.2
        const amp = step * (wh.kind === 'scallops' ? 0.42 : 0.28)
        const ph = row % 2 ? lam / 2 : 0
        let a = Math.ceil((x0 - ph) / lam) * lam + ph
        if (x1 - a < lam) continue
        let seg = `M${f1(a * S)} ${f1(y * S)}`
        for (; a + lam <= x1; a += lam) {
          if (wh.kind === 'scallops') seg += `Q${f1((a + lam / 2) * S)} ${f1((y - amp * 2) * S)} ${f1((a + lam) * S)} ${f1(y * S)}`
          else {
            seg += `Q${f1((a + lam / 4) * S)} ${f1((y - amp * 2) * S)} ${f1((a + lam / 2) * S)} ${f1(y * S)}`
            seg += `Q${f1((a + (lam * 3) / 4) * S)} ${f1((y + amp * 2) * S)} ${f1((a + lam) * S)} ${f1(y * S)}`
          }
        }
        d.push(seg)
      }
    R.list.path('map', d.join(''), { stroke: wh.kind === 'lines' ? { color: wh.color, alpha: wh.alpha, width: wh.width } : { color: wh.color, alpha: wh.alpha, width: wh.width, cap: 'round', join: 'round' } })
  }
}

// —————————————————————— 田与林 ——————————————————————

/** 凸多边形内的平行线（Cyrus–Beck 裁剪） */
function hatchLines(poly: Poly, angle: number, step: number): P[][] {
  const u: P = [dmath.cos(angle), dmath.sin(angle)]
  const v: P = [-u[1], u[0]]
  let v0 = Infinity
  let v1 = -Infinity
  for (const p of poly) {
    const t = p[0] * v[0] + p[1] * v[1]
    v0 = Math.min(v0, t)
    v1 = Math.max(v1, t)
  }
  const c = centroid(poly)
  const out: P[][] = []
  for (let t = v0 + step / 2; t < v1; t += step) {
    // 直线：p = o + s·u，其中 o 在法向坐标 t 处
    const off = t - (c[0] * v[0] + c[1] * v[1])
    const o: P = [c[0] + v[0] * off, c[1] + v[1] * off]
    let s0 = -1e6
    let s1 = 1e6
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const ex = b[0] - a[0]
      const ey = b[1] - a[1]
      // 内侧判定用中心
      let nx = -ey
      let ny = ex
      if ((c[0] - a[0]) * nx + (c[1] - a[1]) * ny < 0) {
        nx = -nx
        ny = -ny
      }
      const den = u[0] * nx + u[1] * ny
      const num = (o[0] - a[0]) * nx + (o[1] - a[1]) * ny
      if (Math.abs(den) < 1e-9) {
        if (num < 0) s1 = -1e7
        continue
      }
      const s = -num / den
      if (den > 0) s0 = Math.max(s0, s)
      else s1 = Math.min(s1, s)
    }
    if (s1 - s0 > 1) out.push([[o[0] + u[0] * (s0 + 0.6), o[1] + u[1] * (s0 + 0.6)], [o[0] + u[0] * (s1 - 0.6), o[1] + u[1] * (s1 - 0.6)]])
  }
  return out
}

/**
 * 逐帧重画时按块复用绘制项：东西按所在的 CHUNK 米方格分块，块的记号是 tag、比例与块里各对象（按对象）的编号，
 * 块里的东西没变就直接取用上次的绘制项（连解析好的 Path2D 一起；成长动画里多数块是没变的城外林子、田）。
 * make 给出一块的各层绘制项，各块的同一层放在一起（别块的下层不会压住这块的上层）。
 * 每个方格只记最近几个版本（来回拖人口时也命中），内存按地图的方格数封顶
 */
const CHUNK = 250
const CHUNK_KEEP = 4
const objIds = new WeakMap<object, number>()
let objNext = 0
const chunkMemo = new Map<string, { key: string; layers: (PathItem | undefined)[] }[]>()
function chunked<T extends object>(R: Painter, tag: string, things: T[], at: (t: T) => P | undefined, make: (group: T[]) => (PathItem | undefined)[]) {
  const byChunk = new Map<string, T[]>()
  for (const t of things) {
    const p = at(t)
    if (!p) continue
    const k = `${tag}|${Math.floor(p[0] / CHUNK)},${Math.floor(p[1] / CHUNK)}`
    let g = byChunk.get(k)
    if (!g) byChunk.set(k, (g = []))
    g.push(t)
  }
  const layers: PathItem[][] = []
  for (const [cell, group] of byChunk) {
    let h = 2166136261
    for (const t of group) {
      let id = objIds.get(t)
      if (id === undefined) objIds.set(t, (id = objNext++))
      h = Math.imul(h ^ id, 16777619)
    }
    const key = `${R.S}|${group.length}|${h >>> 0}`
    let slots = chunkMemo.get(cell)
    if (!slots) chunkMemo.set(cell, (slots = []))
    let hit = slots.find((x) => x.key === key)
    if (!hit) {
      hit = { key, layers: make(group) }
      slots.unshift(hit)
      if (slots.length > CHUNK_KEEP) slots.pop()
    }
    hit.layers.forEach((x, k) => x && (layers[k] ??= []).push(x))
  }
  const seg = R.list.segment('map')
  for (const l of layers) if (l) seg.items.push(...l)
}
/** 画法的短编号（放进块的 tag：画法变了块就重画） */
const looks = new Map<string, number>()
const lookId = (x: unknown) => {
  const k = JSON.stringify(x)
  let v = looks.get(k)
  if (v === undefined) looks.set(k, (v = looks.size))
  return v
}
/** 一批田合起来的包围盒（页面像素） */
function fieldsBBox(R: Painter, fs: Field[]): BBox {
  let bb: BBox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const f of fs) {
    const [x0, y0, x1, y1] = bboxOf(f.poly)
    bb = [Math.min(bb[0], x0), Math.min(bb[1], y0), Math.max(bb[2], x1), Math.max(bb[3], y1)]
  }
  return [bb[0] * R.S, bb[1] * R.S, bb[2] * R.S, bb[3] * R.S]
}

/** 田块的底色：同一块里同色的田合成一条路径 */
function fieldFills(R: Painter, st: Settlement, th: SettleTheme) {
  const color = (f: Field) => pick(th.fields[f.kind], f.tone)
  chunked(R, `fill${lookId(th.fields)}`, st.fields, (f) => f.poly[0], (fs) => {
    const byColor = new Map<string, Field[]>()
    for (const f of fs) {
      let g = byColor.get(color(f))
      if (!g) byColor.set(color(f), (g = []))
      g.push(f)
    }
    const bb = fieldsBBox(R, fs)
    return [...byColor].map(([c, g]) => DisplayList.item(g.map((f) => R.polyD(f.poly)).join(''), { fill: R.fillOf(c, 1) }, bb))
  })
}

function furrows(R: Painter, st: Settlement, th: SettleTheme) {
  const fc = th.furrow.color
  const fa = th.furrow.alpha
  chunked(R, `furrow${lookId([th.furrow, th.tree.dark])}`, st.fields, (f) => f.poly[0], (fs) => {
    const bb = fieldsBBox(R, fs)
    const of = (kind: Field['kind']) => fs.filter((f) => f.kind === kind)
    const hatch = (kind: Field['kind'], step: number) => of(kind).flatMap((f) => hatchLines(f.poly, f.angle, step)).map((l) => R.lineD(l)).join('')
    const outline = (g: Field[]) => g.map((f) => R.polyD(f.poly)).join('')
    const vine = hatch('vineyard', 3.2)
    return [
      DisplayList.item(hatch('crop', 3.4), { stroke: { color: fc, alpha: fa, width: 0.4 } }, bb),
      // 菜园：密排的小畦；草甸：稀疏的草丛（虚点线），不设篱笆
      DisplayList.item(hatch('garden', 1.6), { stroke: { color: fc, alpha: fa * 1.2, width: 0.35 } }, bb),
      DisplayList.item(hatch('meadow', 6), { stroke: { color: fc, alpha: fa * 1.4, width: 0.6, cap: 'round', dash: [0.01, 2.4] } }, bb),
      // 葡萄园：一行行架子（细线）上排着一株株葡萄（圆头短虚线画成的圆点，比逐个画圆省得多）
      DisplayList.item(vine, { stroke: { color: fc, alpha: fa * 1.5, width: 0.35 } }, bb),
      DisplayList.item(vine, { stroke: { color: th.tree.dark, alpha: 0.95, width: Math.max(1, 1.35 * R.S), cap: 'round', dash: [0.01, 2.3 * R.S] } }, bb),
      DisplayList.item(outline(of('paddy')), { stroke: { color: fc, alpha: fa * 1.6, width: 0.7 } }, bb),
      // 田块边界；牧场是一圈篱笆（虚线），里面有一两小群羊
      DisplayList.item(outline(fs.filter((f) => f.kind !== 'paddy' && f.kind !== 'pasture' && f.kind !== 'meadow')), { stroke: { color: fc, alpha: fa * 1.3, width: 0.5 } }, bb),
      DisplayList.item(outline(of('pasture')), { stroke: { color: fc, alpha: fa * 2, width: 0.7, dash: [2.2, 1.6] } }, bb),
    ]
  })
  const pastures = st.fields.filter((f) => f.kind === 'pasture')
  const sheep: string[] = []
  for (const f of pastures) {
    const a = areaOf(f.poly)
    if (Math.abs(a) < 1500) continue
    // 由田块自身的色调取确定的随机：同一块地总是同样的羊群
    let h = Math.floor(f.tone * 1e9) >>> 0
    const rnd = () => ((h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296)
    const c = centroid(f.poly)
    const flocks = Math.abs(a) > 6000 ? 2 : 1
    for (let g = 0; g < flocks; g++) {
      const fc: P = [c[0] + (rnd() - 0.5) * Math.sqrt(Math.abs(a)) * 0.45, c[1] + (rnd() - 0.5) * Math.sqrt(Math.abs(a)) * 0.45]
      const n = 3 + Math.floor(rnd() * 5)
      for (let k = 0; k < n; k++) {
        const q: P = [fc[0] + (rnd() - 0.5) * 9, fc[1] + (rnd() - 0.5) * 7]
        if (pointInPoly(q, f.poly)) sheep.push(R.circleD(q, 0.95))
      }
    }
  }
  if (sheep.length) R.list.path('map', sheep.join(''), { fill: { color: th.paper, alpha: 1 }, stroke: { color: th.ink, alpha: 0.75, width: 0.5 } })
}

/** 树冠在图上画多大（相对生成时的半径）：与房子的比例更协调 */
const TREE_SCALE = 0.7

/**
 * 树按块画（见 chunked）：每块三条路径（投影、树冠、暗面），带自己的包围盒（放大时画面外的块不画）。
 * 投影与暗面缩小到树不到一两个像素时不画（见 PathItem.minScale）
 */
function treeLayers(R: Painter, st: Settlement, th: SettleTheme) {
  // 树冠半径约 2 米（页面像素）：放大到它有 1.5 像素才画投影、暗面
  const detail = 1.5 / Math.max(0.01, 2 * TREE_SCALE * R.S)
  chunked(R, `tree${lookId(th.tree)}`, st.trees, (t) => t.p, (trees) => {
    const c = treeChunk(R, trees, !!th.tree.shadow)
    return [
      th.tree.shadow ? DisplayList.item(c.shadow, { fill: { color: th.tree.shadow, alpha: 0.25 }, minScale: detail }, c.bb) : undefined,
      DisplayList.item(c.crown, { fill: { color: th.tree.fill, alpha: 1 }, stroke: th.tree.stroke ? { color: th.tree.stroke, alpha: 0.8, width: 0.6 } : undefined }, c.bb),
      DisplayList.item(c.dark, { fill: { color: th.tree.dark, alpha: th.tree.darkAlpha ?? 0.55 }, minScale: detail }, c.bb),
    ]
  })
}

/** 一块树的三条路径（按南北排，靠南的压在上面）与包围盒（投影往右下偏，一起罩住） */
function treeChunk(R: Painter, trees: Settlement['trees'], withShadow: boolean) {
  const S = R.S
  const sorted = trees.map((t) => ({ ...t, r: t.r * TREE_SCALE })).sort((a, b) => a.p[1] - b.p[1])
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const t of sorted) {
    x0 = Math.min(x0, (t.p[0] - t.r) * S)
    y0 = Math.min(y0, (t.p[1] - t.r) * S)
    x1 = Math.max(x1, (t.p[0] + t.r * 1.35) * S)
    y1 = Math.max(y1, (t.p[1] + t.r * 1.35) * S)
  }
  const bb: BBox = [x0, y0, x1, y1]
  const shadow = !withShadow ? '' : sorted.map((t) => R.circleD([t.p[0] + t.r * 0.35, t.p[1] + t.r * 0.35], t.r)).join('')
  const crown = sorted.map((t) => R.circleD(t.p, t.r)).join('')
  // 暗面：右下的月牙
  const dark = sorted
    .map((t) => {
      const r = t.r * S
      const x = t.p[0] * S
      const y = t.p[1] * S
      const a0 = -0.35
      const a1 = Math.PI * 0.85
      const sx = x + dmath.cos(a0) * r
      const sy = y + dmath.sin(a0) * r
      const ex = x + dmath.cos(a1) * r
      const ey = y + dmath.sin(a1) * r
      return `M${f1(sx)} ${f1(sy)}A${f1(r)} ${f1(r)} 0 0 1 ${f1(ex)} ${f1(ey)}Q${f1(x + r * 0.25)} ${f1(y + r * 0.2)} ${f1(sx)} ${f1(sy)}Z`
    })
    .join('')
  return { shadow, crown, dark, bb }
}

// —————————————————————— 道路与城区 ——————————————————————

/**
 * 各种路一起画，不描边：路面比四周的地面亮，靠这个显出来。城外的巷子与城内的街道同色，
 * 与街坊之间的缝（街）连成一张路网；只有官道用路的颜色（测绘图里是黄的）。官道在下，街巷、小径在上
 */
function roads(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  const byWidth = (kinds: Road['kind'][]) => {
    const g = new Map<number, P[][]>()
    for (const r of st.roads) {
      if (!kinds.includes(r.kind)) continue
      let l = g.get(r.width)
      if (!l) g.set(r.width, (l = []))
      l.push(r.line)
    }
    return [...g].sort((a, b) => b[0] - a[0])
  }
  // 端头是方的（平头，多出半个路宽，接到别的路上不露缝）；拐角是圆的
  const round = { cap: 'square', join: 'round' } as const
  for (const [w, lines] of byWidth(['highway'])) R.lines(lines, { color: th.road.fill, alpha: 1, width: w * S, ...round })
  for (const [w, lines] of byWidth(['lane', 'main', 'street'])) R.lines(lines, { color: th.street, alpha: 1, width: w * S, ...round })
  for (const [w, lines] of byWidth(['path'])) R.lines(lines, { color: th.plaza, alpha: 1, width: Math.max(1, w * S), ...round })
  for (const r of st.roads.filter((r) => r.kind === 'stair')) {
    R.lines([r.line], { color: th.road.casing ?? th.ink, alpha: 0.8, width: (r.width + 1) * S, cap: 'round', join: 'round' })
    R.lines([r.line], { color: th.road.fill, alpha: 1, width: r.width * S, cap: 'round', join: 'round' })
    // 台阶横纹
    const L = polylineLength(r.line)
    const ticks: P[][] = []
    for (let s = 2; s < L; s += 3) {
      const { p, angle } = pointAt(r.line, s)
      const n: P = [-dmath.sin(angle) * r.width * 0.5, dmath.cos(angle) * r.width * 0.5]
      ticks.push([[p[0] - n[0], p[1] - n[1]], [p[0] + n[0], p[1] + n[1]]])
    }
    R.lines(ticks, { color: th.ink, alpha: 0.45, width: 0.4 })
  }
}

function urbanGround(R: Painter, st: Settlement, th: SettleTheme) {
  const inner = st.wards.filter((w) => w.inner && !w.rural && w.type !== 'water')
  // 城内的地面先铺成街道色，再铺街区（院落）色：两者之间的缝就是街巷
  R.polys(inner.map((w) => w.poly), { color: th.street, alpha: 1 })
  R.polys(st.blocks, R.fillOf(th.yard), th.blockStroke)
  for (const g of st.greens.filter((g) => g.kind !== 'cemetery')) R.poly(g.poly, { color: th.green[g.kind], alpha: 1 })
  R.polys(st.plazas, { color: th.plaza, alpha: 1 }, { color: th.ink, alpha: 0.25, width: 0.4 })
  parkGround(R, st, th)
}

/** 园林的地面小品：绿篱镶边的花坛、耙纹白砂、池水与水渠、岛与苔地（置石另见 parkRocks） */
function parkGround(R: Painter, st: Settlement, th: SettleTheme) {
  const parts = st.parkParts ?? []
  if (!parts.length) return
  const of = (k: string) => parts.filter((q) => q.kind === k)
  const edge = th.waterEdge ?? th.ink
  // 花坛在下（坛心的小池、喷泉压在上面），白砂之上是苔岛
  R.polys(of('bed').map((q) => q.poly), R.fillOf(th.green.garden), { color: th.tree.dark, alpha: 0.9, width: 0.8, join: 'round' })
  const gravel = of('gravel')
  R.polys(gravel.map((q) => q.poly), { color: th.plaza, alpha: 1 }, { color: th.ink, alpha: 0.35, width: 0.4 })
  // 耙纹：顺着 angle 的平行细线，置石周围一圈圈的波纹
  const rakes = gravel.flatMap((q) => hatchLines(q.poly, q.angle ?? 0, 1.4))
  const rings: string[] = []
  for (const r of of('rock')) {
    const c = centroid(r.poly)
    if (!gravel.some((q) => pointInPoly(c, q.poly))) continue
    const rr = Math.max(...r.poly.map((p) => dist(p, c)))
    for (const k of [1, 2, 3]) rings.push(R.circleD(c, rr + k * 0.9))
  }
  R.lines(rakes, { color: th.ink, alpha: 0.22, width: 0.3 })
  if (rings.length) R.list.path('map', rings.join(''), { fill: { color: th.plaza, alpha: 1 } })
  if (rings.length) R.list.path('map', rings.join(''), { stroke: { color: th.ink, alpha: 0.28, width: 0.3 } })
  R.polys(of('pond').map((q) => q.poly), { color: th.water, alpha: 1 }, { color: edge, alpha: 0.7, width: 0.6, join: 'round' })
  R.polys(of('isle').map((q) => q.poly), R.fillOf(th.green.park), { color: th.ink, alpha: 0.45, width: 0.45, join: 'round' })
}

/** 置石、假山石：压在地面上、房子底下 */
function parkRocks(R: Painter, st: Settlement, th: SettleTheme) {
  const rocks = (st.parkParts ?? []).filter((q) => q.kind === 'rock')
  if (rocks.length) R.polys(rocks.map((q) => q.poly), { color: th.wall.fill, alpha: 1 }, { color: th.ink, alpha: 0.85, width: 0.5, join: 'round' })
}

function crossingLayers(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  for (const c of st.crossings) {
    const L = dist(c.a, c.b)
    const u: P = [(c.b[0] - c.a[0]) / L, (c.b[1] - c.a[1]) / L]
    const n: P = [-u[1], u[0]]
    if (c.kind === 'bridge') {
      const w = c.width / 2
      const ext = 2
      const a: P = [c.a[0] - u[0] * ext, c.a[1] - u[1] * ext]
      const b: P = [c.b[0] + u[0] * ext, c.b[1] + u[1] * ext]
      const deck: Poly = [
        [a[0] + n[0] * w, a[1] + n[1] * w],
        [b[0] + n[0] * w, b[1] + n[1] * w],
        [b[0] - n[0] * w, b[1] - n[1] * w],
        [a[0] - n[0] * w, a[1] - n[1] * w],
      ]
      // 神桥：朱漆的拱桥
      R.poly(deck, { color: c.sacred ? vermilion(th) : th.road.fill, alpha: 1 })
      // 护栏
      R.lines(
        [
          [deck[0], deck[1]],
          [deck[3], deck[2]],
        ],
        { color: th.ink, alpha: 0.9, width: 1.1 * Math.max(0.8, S * 0.8), cap: 'round' },
      )
      // 桥墩
      const piers = Math.max(0, Math.floor(L / 14))
      const ticks: P[][] = []
      for (let k = 1; k <= piers; k++) {
        const q: P = [c.a[0] + u[0] * (L * k) / (piers + 1), c.a[1] + u[1] * (L * k) / (piers + 1)]
        ticks.push([[q[0] + n[0] * (w + 1.4), q[1] + n[1] * (w + 1.4)], [q[0] + n[0] * (w + 0.1), q[1] + n[1] * (w + 0.1)]])
        ticks.push([[q[0] - n[0] * (w + 1.4), q[1] - n[1] * (w + 1.4)], [q[0] - n[0] * (w + 0.1), q[1] - n[1] * (w + 0.1)]])
      }
      R.lines(ticks, { color: th.ink, alpha: 0.9, width: 1.2 })
    } else if (c.kind === 'ferry') {
      R.lines([[c.a, c.b]], { color: th.ink, alpha: 0.7, width: 0.9, dash: [4, 3] })
      // 渡船
      const m: P = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]
      const boat: Poly = [
        [m[0] - u[0] * 5, m[1] - u[1] * 5],
        [m[0] + n[0] * 2, m[1] + n[1] * 2],
        [m[0] + u[0] * 5, m[1] + u[1] * 5],
        [m[0] - n[0] * 2, m[1] - n[1] * 2],
      ]
      R.poly(
        boat.map((p) => [p[0], p[1]] as P),
        { color: th.buildings('western').shed[0], alpha: 1 },
        { color: th.ink, alpha: 1, width: 0.8 },
      )
      // 两岸的小码头
      for (const e of [c.a, c.b]) {
        const s = e === c.a ? 1 : -1
        const q: P = [e[0] + u[0] * 3 * s, e[1] + u[1] * 3 * s]
        R.poly(
          [
            [q[0] + n[0] * 2 - u[0] * 4 * s, q[1] + n[1] * 2 - u[1] * 4 * s],
            [q[0] + n[0] * 2 + u[0] * 3 * s, q[1] + n[1] * 2 + u[1] * 3 * s],
            [q[0] - n[0] * 2 + u[0] * 3 * s, q[1] - n[1] * 2 + u[1] * 3 * s],
            [q[0] - n[0] * 2 - u[0] * 4 * s, q[1] - n[1] * 2 - u[1] * 4 * s],
          ],
          { color: th.plaza, alpha: 1 },
          { color: th.ink, alpha: 0.8, width: 0.6 },
        )
      }
    } else {
      // 浅滩：踏石
      const stones: string[] = []
      for (let s = 1.5; s < L; s += 2.6) stones.push(R.circleD([c.a[0] + u[0] * s + n[0] * ((s * 7) % 3 - 1.5) * 0.4, c.a[1] + u[1] * s + n[1] * ((s * 7) % 3 - 1.5) * 0.4], 0.8))
      R.list.path('map', stones.join(''), { fill: { color: th.plaza, alpha: 1 }, stroke: { color: th.ink, alpha: 0.7, width: 0.5 } })
    }
  }
}

function boatLayers(R: Painter, st: Settlement, th: SettleTheme) {
  if (!st.boats.length) return
  const hulls: Poly[] = []
  const masts: P[][] = []
  for (const b of st.boats) {
    const u: P = [dmath.cos(b.angle), dmath.sin(b.angle)]
    const v: P = [-u[1], u[0]]
    const L = b.len / 2
    const w = b.len * 0.17
    const at = (x: number, y: number): P => [b.p[0] + u[0] * x + v[0] * y, b.p[1] + u[1] * x + v[1] * y]
    hulls.push([at(L, 0), at(L * 0.35, w), at(-L * 0.8, w * 0.85), at(-L, 0), at(-L * 0.8, -w * 0.85), at(L * 0.35, -w)])
    if (b.len > 10) masts.push([at(L * 0.1, -w * 1.9), at(L * 0.1, w * 1.9)])
  }
  if (th.shadow) R.polys(hulls.map((h) => h.map(([x, y]) => [x + 1, y + 1] as P)), { color: th.shadow, alpha: 1 })
  R.polys(hulls, { color: th.buildings('western').shed[0], alpha: 1 }, { color: th.ink, alpha: 1, width: 0.7, join: 'round' })
  R.lines(masts, { color: th.ink, alpha: 0.9, width: 1.1, cap: 'round' })
}

function enclosureLayers(R: Painter, st: Settlement, th: SettleTheme) {
  if (!st.enclosures.length) return
  // 院子：叠一层淡淡的墨色，不描边（各种画法下都比四周的地面略深；蓝图是略亮）
  R.polys(st.enclosures, { color: th.ink, alpha: 0.08 })
}

const KIND_ORDER: Exclude<BuildingKind, 'torii'>[] = ['shed', 'house', 'large', 'hall', 'civic', 'temple', 'pagoda', 'keep', 'tower', 'magic']

function buildingLayers(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  const pal = th.buildings(st.params.culture)
  if (th.shadow) {
    // 影子随层数拉长：一层的平房短、四层的楼房长，一眼看出老城与外围的高低
    const byOff = new Map<number, P[][]>()
    for (const b of st.buildings) {
      if (b.kind === 'shed' || b.kind === 'torii') continue
      const off = b.floors ? 0.5 + b.floors * 0.55 : 1.6
      ;(byOff.get(off) ?? byOff.set(off, []).get(off)!).push(b.poly.map(([x, y]) => [x + off, y + off] as P))
    }
    for (const polys of byOff.values()) R.polys(polys, { color: th.shadow, alpha: 1 })
  }
  const sw = th.buildingStroke.width * Math.min(1.4, Math.max(0.6, S * 0.7))
  for (const kind of KIND_ORDER) {
    const bs = st.buildings.filter((b) => b.kind === kind)
    if (!bs.length) continue
    const colors = pal[kind]
    for (let c = 0; c < colors.length; c++) {
      const group = bs.filter((b) => Math.min(colors.length - 1, Math.floor(b.tone * colors.length)) === c)
      R.polys(
        group.map((b) => b.poly),
        R.fillOf(colors[c]),
        { color: th.buildingStroke.color, alpha: 1, width: kind === 'shed' ? sw * 0.6 : kind === 'keep' || kind === 'temple' || kind === 'civic' ? sw * 1.3 : sw, join: 'round' },
      )
    }
  }
  // 屋脊与戗脊：矩形房屋画成四坡顶
  if (th.roofLines) {
    const lines: P[][] = []
    for (const b of st.buildings) {
      if (b.kind === 'shed' || b.poly.length !== 4) continue
      const o = obb(b.poly)
      if (o.wid < 3) continue
      const h = Math.max(0, o.len / 2 - o.wid / 2)
      const a: P = [o.center[0] - o.axis[0] * h, o.center[1] - o.axis[1] * h]
      const e: P = [o.center[0] + o.axis[0] * h, o.center[1] + o.axis[1] * h]
      lines.push([a, e])
      // 戗脊：脊端连向最近的两个角
      for (const end of [a, e]) {
        const near = [...b.poly].sort((p, q) => dist(p, end) - dist(q, end)).slice(0, 2)
        for (const q of near) lines.push([end, q])
      }
    }
    R.lines(lines, { color: th.roofLines, alpha: 1, width: 0.45 * Math.min(1.5, S), cap: 'round' })
  }
  // 塔与法师塔：同心圆
  for (const b of st.buildings.filter((b) => b.kind === 'magic' || b.kind === 'pagoda')) {
    const c = centroid(b.poly)
    const r = Math.sqrt(Math.abs(areaOf(b.poly)) / Math.PI)
    R.list.path('map', R.circleD(c, r * 0.55) + R.circleD(c, r * 0.22), { stroke: { color: th.buildingStroke.color, alpha: 0.8, width: sw * 0.8 } })
  }
}

/** 鸟居、神桥的朱红（主题可改） */
const vermilion = (th: SettleTheme) => th.vermilion ?? '#c8412a'

/**
 * 鸟居：朱红的一道横梁（笠木），画在树冠之上——参道在社叢里也看得出一座座鸟居；
 * 千本鸟居一座挨一座，连成一条朱红的隧道。
 */
function toriiLayer(R: Painter, st: Settlement, th: SettleTheme) {
  const ts = st.buildings.filter((b) => b.kind === 'torii')
  if (!ts.length) return
  // 描边用深一点的朱色（千本鸟居一座挨一座，墨色的描边会把整条隧道描成深色的梯子）
  const sw = Math.max(0.25, 0.22 * Math.min(1.5, R.S))
  R.polys(
    ts.map((b) => b.poly),
    { color: vermilion(th), alpha: 1 },
    { color: '#6b1d10', alpha: 0.7, width: sw, join: 'round' },
  )
}

function areaOf(p: Poly) {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    a += p[i][0] * q[1] - q[0] * p[i][1]
  }
  return a / 2
}

function wallLayers(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  // 护城河：岸线、水面、一道水线；城门外的桥压在上面
  for (const w of st.walls) {
    if (!w.moat) continue
    const { runs, width, bridges } = w.moat
    R.lines(runs, { color: th.waterEdge ?? th.ink, alpha: 0.75, width: (width + 1.4) * S, cap: 'butt', join: 'round' })
    R.lines(runs, { color: th.water, alpha: 1, width: width * S, cap: 'butt', join: 'round' })
    R.lines(runs, { color: th.waterLine.color, alpha: th.waterLine.alpha[0], width: 0.6, cap: 'butt', join: 'round' })
    for (const b of bridges) {
      const u: P = [dmath.cos(b.angle), dmath.sin(b.angle)]
      const q = rect(b.p, u, width + 5, 7)
      R.poly(q, { color: th.wall.fill, alpha: 1 }, { color: th.wall.stroke, alpha: 1, width: 0.9 })
    }
  }
  for (const w of st.walls) {
    const n = w.loop.length
    // 实心墙段（城门处断开）
    const runs: P[][] = []
    let cur: P[] = []
    const gateGap = w.kind === 'stone' ? 7 : 5
    for (let i = 0; i < n; i++) {
      const a = w.loop[i]
      const b = w.loop[(i + 1) % n]
      if (!w.solid[i]) {
        if (cur.length > 1) runs.push(cur)
        cur = []
        continue
      }
      if (!cur.length) cur.push(a)
      // 门洞
      const g = w.gates.find((g) => dist(g.p, b) < 0.5)
      const g0 = w.gates.find((g) => dist(g.p, a) < 0.5)
      if (g0 && cur.length === 1) {
        const L = dist(a, b)
        const t = Math.min(0.45, gateGap / L)
        cur = [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]]
      }
      if (g) {
        const L = dist(a, b)
        const t = Math.max(0.55, 1 - gateGap / L)
        cur.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        runs.push(cur)
        cur = []
        continue
      }
      cur.push(b)
    }
    if (cur.length > 1) runs.push(cur)
    const tw = w.thickness * S
    R.lines(runs, { color: w.kind === 'stone' ? th.wall.stroke : th.ink, alpha: w.kind === 'stone' ? 0.9 : 0.7, width: tw + 1, cap: 'butt', join: 'miter' })
    R.lines(runs, { color: th.wall.fill, alpha: 1, width: Math.max(0.6, tw - 1.2), cap: 'butt', join: 'miter' })
    if (w.kind === 'palisade') R.lines(runs, { color: th.ink, alpha: 0.8, width: tw * 0.6, dash: [0.9 * S, 0.9 * S] })
    // 塔楼
    const tr = w.kind === 'stone' ? w.thickness * 1.25 : w.thickness * 1.3
    const towers = w.towers.map((t) => (w.kind === 'stone' ? R.circleD(t, tr) : R.polyD(circlePoly(t, tr, 4, Math.PI / 4)))).join('')
    R.list.path('map', towers, { fill: { color: th.wall.fill, alpha: 1 }, stroke: { color: th.wall.stroke, alpha: 1, width: 1 } })
    // 城门楼：门洞两侧的方墩
    for (const g of w.gates) {
      const u: P = [dmath.cos(g.angle), dmath.sin(g.angle)]
      const v: P = [-u[1], u[0]]
      const s = w.kind === 'stone' ? 1 : 0.7
      for (const side of [-1, 1]) {
        const c: P = [g.p[0] + v[0] * (gateGap + 2.5 * s) * side, g.p[1] + v[1] * (gateGap + 2.5 * s) * side]
        const q: Poly = [
          [c[0] - u[0] * 5 * s - v[0] * 3 * s, c[1] - u[1] * 5 * s - v[1] * 3 * s],
          [c[0] + u[0] * 5 * s - v[0] * 3 * s, c[1] + u[1] * 5 * s - v[1] * 3 * s],
          [c[0] + u[0] * 5 * s + v[0] * 3 * s, c[1] + u[1] * 5 * s + v[1] * 3 * s],
          [c[0] - u[0] * 5 * s + v[0] * 3 * s, c[1] - u[1] * 5 * s + v[1] * 3 * s],
        ]
        R.poly(q, { color: th.wall.fill, alpha: 1 }, { color: th.wall.stroke, alpha: 1, width: 1 })
      }
    }
  }
}

// —————————————————————— 奇观 ——————————————————————

function wonderGlow(R: Painter, st: Settlement, th: SettleTheme) {
  const S = R.S
  for (const w of st.wonders) {
    if (w.kind === 'leyline' && w.line) {
      R.lines([w.line], { color: th.magic, alpha: 0.1, width: 16 * S, cap: 'round', join: 'round' })
      R.lines([w.line], { color: th.magic, alpha: 0.18, width: 6 * S, cap: 'round', join: 'round' })
      R.lines([w.line], { color: th.magic, alpha: 0.7, width: 0.9, dash: [6, 4], cap: 'round' })
    }
  }
}

function wonderLayers(R: Painter, st: Settlement, th: SettleTheme) {
  for (const w of st.wonders) {
    if (w.kind === 'circle') {
      const c = w.p
      R.list.path('map', R.circleD(c, w.r * 1.15), { fill: { color: th.magic, alpha: 0.08 } })
      R.list.path('map', R.circleD(c, w.r) + R.circleD(c, w.r * 0.86), { stroke: { color: th.magic, alpha: 0.85, width: 1 } })
      // 七芒星
      const pts: P[] = []
      for (let k = 0; k < 7; k++) {
        const a = -Math.PI / 2 + ((k * 3) % 7) * ((Math.PI * 2) / 7)
        pts.push([c[0] + dmath.cos(a) * w.r * 0.86, c[1] + dmath.sin(a) * w.r * 0.86])
      }
      R.poly(pts, undefined, { color: th.magic, alpha: 0.75, width: 0.8 })
      // 符文刻度
      const ticks: P[][] = []
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2
        const r0 = w.r * 0.88
        const r1 = w.r * (k % 3 === 0 ? 0.98 : 0.94)
        ticks.push([[c[0] + dmath.cos(a) * r0, c[1] + dmath.sin(a) * r0], [c[0] + dmath.cos(a) * r1, c[1] + dmath.sin(a) * r1]])
      }
      R.lines(ticks, { color: th.magic, alpha: 0.8, width: 0.6 })
    } else if (w.kind === 'spring') {
      R.list.path('map', R.circleD(w.p, w.r * 1.8), { fill: { color: th.magic, alpha: 0.1 } })
      R.list.path('map', R.circleD(w.p, w.r), { fill: { color: th.water, alpha: 1 }, stroke: { color: th.ink, alpha: 0.8, width: 0.8 } })
      R.list.path('map', R.circleD(w.p, w.r * 1.35) + R.circleD(w.p, w.r * 1.6), { stroke: { color: th.magic, alpha: 0.5, width: 0.6, dash: [2, 2] } })
    } else if (w.kind === 'isle') {
      // 浮空岛：地面上的投影 + 岛体（边缘崖壁）+ 岛上的塔
      const c = w.p
      const blob = (r: number, seed: number): Poly => {
        const out: Poly = []
        for (let k = 0; k < 28; k++) {
          const a = (k / 28) * Math.PI * 2
          const rr = r * (1 + 0.16 * dmath.sin(a * 3 + seed) + 0.08 * dmath.sin(a * 7 + seed * 2))
          out.push([c[0] + dmath.cos(a) * rr, c[1] + dmath.sin(a) * rr * 0.8])
        }
        return out
      }
      R.poly(
        blob(w.r * 0.95, 1).map(([x, y]) => [x + w.r * 0.5, y + w.r * 0.9] as P),
        { color: '#000000', alpha: 0.12 },
      )
      const top = blob(w.r, 1)
      R.poly(
        top.map(([x, y]) => [x, y + w.r * 0.22] as P),
        { color: th.wall.fill, alpha: 1 },
        { color: th.ink, alpha: 1, width: 1 },
      )
      R.poly(top, { color: th.green.park, alpha: 1 }, { color: th.ink, alpha: 1, width: 1.1 })
      const tower = circlePoly(c, w.r * 0.16, 16)
      R.poly(tower, { color: th.buildings(st.params.culture).magic[0], alpha: 1 }, { color: th.ink, alpha: 1, width: 1 })
      const trees: string[] = []
      for (let k = 0; k < 7; k++) {
        const a = k * 2.3
        trees.push(R.circleD([c[0] + dmath.cos(a) * w.r * 0.6, c[1] + dmath.sin(a) * w.r * 0.45], w.r * 0.09))
      }
      R.list.path('map', trees.join(''), { fill: { color: th.tree.fill, alpha: 1 }, stroke: { color: th.tree.dark, alpha: 0.8, width: 0.6 } })
    }
  }
}

// —————————————————————— 注记 ——————————————————————

type Box = [number, number, number, number]
const overlap = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

/** 线段 ab 是否穿过（外扩 pad 的）框：Liang–Barsky 裁剪 */
function segHitsBox(a: P, b: P, box: Box, pad: number): boolean {
  const x0 = box[0] - pad
  const y0 = box[1] - pad
  const x1 = box[2] + pad
  const y1 = box[3] + pad
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  for (const [q, r] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ]) {
    if (q === 0) {
      if (r < 0) return false
      continue
    }
    const t = r / q
    if (q < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}

function labelLayers(R: Painter, st: Settlement, th: SettleTheme, measurer: CanvasRenderingContext2D, lg: Lang, zoning?: { reserve: Box }, regions?: SettleRegion[]) {
  const S = R.S
  const list = R.list
  const placed: Box[] = []
  // 区划图：图例的保留区
  if (zoning) placed.push(zoning.reserve)
  // 标题框的保留区
  placed.push([0, 0, 460, 140])
  placed.push([list.MW - 150, list.MH - 70, list.MW, list.MH])
  placed.push([list.MW - 90, 0, list.MW, 110])
  // 字号取字号体系的级别（见 labelSize）：海 > 片区 > 河、山、大地标 > 地标 > 街名、小地点；
  // 区划图上片区名再高一级。英文全大写的片区名比同字号的小写显大，低一级；中日文按 CJK_SCALE 略缩
  const tierOf = (l: MapLabel) =>
    l.kind === 'water'
      ? 5
      : l.kind === 'district'
        ? (lg === 'en' ? 2 : 3) + (zoning ? 1 : 0)
        : l.kind === 'river' || l.kind === 'hill'
          ? 2
          : l.kind === 'landmark'
            ? l.weight >= 7
              ? 2
              : 1
            : l.kind === 'street' || l.kind === 'poi'
              ? 0
              : 1
  const sizeOf = (l: MapLabel) => labelPx(tierOf(l), lg !== 'en', list.labelK)
  const fontOf = (l: MapLabel) => {
    const f = th.font
    const px = `${sizeOf(l).toFixed(1)}px`
    switch (l.kind) {
      case 'water':
      case 'river':
        return `italic 500 ${px} ${f.label}`
      case 'street':
      case 'poi':
        return `400 ${px} ${f.label}`
      default:
        return `600 ${px} ${f.label}`
    }
  }
  // 区划图：片区名用正文墨色（最醒目）
  const colorOf = (kind: string) => (kind === 'water' || kind === 'river' ? th.label.water : kind === 'district' ? (zoning ? th.label.color : th.label.district) : th.label.color)
  // anchor：整条注记的锚点（查看器放大时注记以它为中心保持屏幕大小，见 TextItem.g）
  let anchor: [number, number] | undefined
  // area：面状注记（片区名、海名）标的区域，放大后原位置不在视口里时挪到区域露出来的一角（见 TextItem.area）
  let area: LabelArea | undefined
  // along：沿路径排布的字在路径上的位置（见 TextItem.along）
  type Along = { line: [number, number][]; c: number; at: number }
  const halo = (t: string, x: number, y: number, font: string, m: [number, number, number, number, number, number] | undefined, w: number, along?: Along) => {
    list.text('map', { t, x, y, font, align: 'middle', baseline: 'central', stroke: { color: th.label.halo, alpha: 0.85, width: w }, m, opacity: 1, bbox: [x - 200, y - 40, x + 200, y + 40], g: anchor, along, area })
  }
  const text = (t: string, x: number, y: number, font: string, color: string, m?: [number, number, number, number, number, number], along?: Along) => {
    list.text('map', { t, x, y, font, align: 'middle', baseline: 'central', fill: { color, alpha: 1 }, m, opacity: 1, bbox: [x - 200, y - 40, x + 200, y + 40], g: anchor, along, area })
  }
  // 片区名：所在片区；海名：地形格网里的海面
  const T = st.terrain
  const regionOf = (l: MapLabel, w: number, h: number): LabelArea | undefined => {
    if (l.kind === 'district') {
      const rp = regionPoly.get(l)
      const ward = rp ? null : st.wards.find((wd) => pointInPoly(l.p, wd.poly))
      if (!rp && !ward) return undefined
      const poly = (rp ?? ward!.poly).map(([x, y]) => [x * S, y * S] as P)
      const b = bboxOf(poly)
      return { mask: rasterPoly(b, Math.max(2, Math.max(b[2] - b[0], b[3] - b[1]) / 32), poly), w, h }
    }
    if (l.kind === 'water') {
      const c = T.cell * S
      const sea = (x: number, y: number) => {
        const i = Math.min(T.W - 1, Math.max(0, Math.floor(x / c)))
        const j = Math.min(T.H - 1, Math.max(0, Math.floor(y / c)))
        const k = j * T.W + i
        return T.water[k] < 0 && T.height[k] < -0.6
      }
      return { mask: rasterArea([0, 0, T.W * c, T.H * c], c * 2, sea), w, h }
    }
    return undefined
  }
  // 区划图：片区名先排（压过地标），小地点不标
  // 命名区域改过：片区名按区域标（名字、位置、范围都来自区域）；此刻城还没长到的区域不标
  const regionPoly = new Map<MapLabel, [number, number][]>()
  let source = st.labels
  if (regions) {
    // 区域名排在原片区名的位置（同权重的注记按原顺序避让，挪到末尾会被别的名字挤掉）
    const own: MapLabel[] = []
    for (const r of regions) {
      if (!regionShown(st, r)) continue
      const l: MapLabel = { text: r.name, p: r.at, angle: 0, kind: 'district', weight: 5 }
      regionPoly.set(l, r.poly)
      own.push(l)
    }
    const at = st.labels.findIndex((l) => l.kind === 'district')
    const rest = st.labels.filter((l) => l.kind !== 'district')
    const cut = at < 0 ? rest.length : st.labels.slice(0, at).filter((l) => l.kind !== 'district').length
    source = [...rest.slice(0, cut), ...own, ...rest.slice(cut)]
  }
  const labels = [...source].filter((l) => !zoning || l.kind !== 'poi').sort((a, b) => (zoning ? +(b.kind === 'district') - +(a.kind === 'district') : 0) || b.weight - a.weight)
  // 城墙、护城河（像素坐标，带半宽）：地标、兴趣点的字不压在墙上
  const barriers: { a: P; b: P; pad: number }[] = []
  for (const w of st.walls) {
    const n = w.loop.length
    for (let i = 0; i < n; i++) {
      if (!w.solid[i]) continue
      const a = w.loop[i]
      const b = w.loop[(i + 1) % n]
      barriers.push({ a: [a[0] * S, a[1] * S], b: [b[0] * S, b[1] * S], pad: (w.thickness / 2 + 1.5) * S })
    }
    for (const run of w.moat?.runs ?? [])
      for (let i = 1; i < run.length; i++) barriers.push({ a: [run[i - 1][0] * S, run[i - 1][1] * S], b: [run[i][0] * S, run[i][1] * S], pad: (w.moat!.width / 2) * S })
  }
  const onWall = (box: Box) => barriers.some((s) => segHitsBox(s.a, s.b, box, s.pad))
  // 城门：字往城里挪（朝最近那道城墙的中心）
  const gates = st.walls.flatMap((w) => {
    const c = centroid(w.loop)
    return w.gates.map((g) => ({ p: g.p, c }))
  })
  const gateDir = (p: P): P | undefined => {
    if (!st.landmarks.some((l) => l.kind === 'gate' && dist(l.p, p) < 0.01)) return undefined
    let best: (typeof gates)[number] | undefined
    for (const g of gates) if (dist(g.p, p) < 40 && (!best || dist(g.p, p) < dist(best.p, p))) best = g
    if (!best) return undefined
    const d = dist(best.c, p) || 1
    return [(best.c[0] - p[0]) / d, (best.c[1] - p[1]) / d]
  }
  for (const l of labels) {
    const font = fontOf(l)
    measurer.font = font
    const color = colorOf(l.kind)
    const size = sizeOf(l)
    // 字距：中日文片区名、水名疏排；英文片区名全大写、略疏，其余照常
    const spacing = lg === 'en' ? (l.kind === 'district' ? 2 : l.kind === 'water' ? 4 : l.kind === 'river' ? 2 : 0.3) : l.kind === 'district' ? 4 : l.kind === 'water' ? 8 : l.kind === 'river' ? 5 : 1
    const str = lg === 'en' && l.kind === 'district' ? l.text.en.toUpperCase() : l.text[lg]
    if (l.path) {
      // 沿路径逐字排布
      const path = l.path.map(([x, y]) => [x * S, y * S] as P)
      const chars = [...str]
      const widths = chars.map((c) => measurer.measureText(c).width + spacing)
      const total = widths.reduce((a, b) => a + b, 0)
      const L = polylineLength(path)
      if (L < total + 10) continue
      // 路径方向：保证文字不倒置
      let pp = path
      const mid = pointAt(path, L / 2)
      if (dmath.cos(mid.angle) < 0) pp = [...path].reverse()
      // 选几个起点，挑不冲突的
      for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) {
        let s = L * f - total / 2
        if (s < 0 || s + total > L) continue
        const boxes: Box[] = []
        const glyphs: { c: string; p: P; a: number; at: number }[] = []
        const mid = s + total / 2
        for (let i = 0; i < chars.length; i++) {
          const g = pointAt(pp, s + widths[i] / 2)
          glyphs.push({ c: chars[i], p: g.p, a: g.angle, at: s + widths[i] / 2 })
          const r = size * (GLYPH_R + LABEL_PAD)
          boxes.push([g.p[0] - r, g.p[1] - r, g.p[0] + r, g.p[1] + r])
          s += widths[i]
        }
        if (boxes.some((b) => placed.some((q) => overlap(b, q)))) continue
        // 过弯太急的不放
        let bend = 0
        for (let i = 1; i < glyphs.length; i++) {
          let d = Math.abs(glyphs[i].a - glyphs[i - 1].a)
          if (d > Math.PI) d = Math.PI * 2 - d
          bend = Math.max(bend, d)
        }
        if (bend > 0.6) continue
        placed.push(...boxes)
        const line = pp as [number, number][]
        anchor = undefined
        area = undefined
        for (const g of glyphs) {
          const c = dmath.cos(g.a)
          const sn = dmath.sin(g.a)
          const m: [number, number, number, number, number, number] = [c, sn, -sn, c, g.p[0], g.p[1]]
          halo(g.c, 0, 0, font, m, size * HALO_RATIO, { line, c: mid, at: g.at })
        }
        for (const g of glyphs) {
          const c = dmath.cos(g.a)
          const sn = dmath.sin(g.a)
          text(g.c, 0, 0, font, color, [c, sn, -sn, c, g.p[0], g.p[1]], { line, c: mid, at: g.at })
        }
        break
      }
      continue
    }
    const chars = [...str]
    const w = chars.reduce((s, c) => s + measurer.measureText(c).width + spacing, -spacing)
    const pad = LABEL_PAD * size
    const boxAt = (cx: number, cy: number): Box => [cx - w / 2 - pad, cy - size * 0.75, cx + w / 2 + pad, cy + size * 0.75 + (l.sub ? size : 0)]
    const ax = l.p[0] * S
    const ay = l.p[1] * S
    // 候选位置：地标文字默认写在图标上方，放不下（压字、压城墙）再试下方、右侧、左侧；
    // 城门先试城里一侧（紧贴门洞往里），字不压在城墙上
    const spots: P[] = []
    const point = l.kind === 'landmark' || l.kind === 'poi'
    if (point) {
      const u = gateDir(l.p)
      if (u) {
        const hw = w / 2 + pad
        const hh = size * 0.75
        const off = size * 0.5 + 4 * S
        const t = Math.min(Math.abs(u[0]) > 1e-3 ? (hw + off) / Math.abs(u[0]) : Infinity, Math.abs(u[1]) > 1e-3 ? (hh + off) / Math.abs(u[1]) : Infinity)
        // 城里一侧（贴着门、再往里）；让不开就沿墙错开一点，最后试城外一侧
        const v: P = [-u[1], u[0]]
        const side = Math.abs(v[0]) * (hw + 2) + Math.abs(v[1]) * (hh + 2)
        for (const k of [1, 1.5]) spots.push([ax + u[0] * t * k, ay + u[1] * t * k])
        for (const sd of [-1, 1]) spots.push([ax + u[0] * t + v[0] * side * sd, ay + u[1] * t + v[1] * side * sd])
        for (const k of [1, 1.5]) spots.push([ax - u[0] * t * k, ay - u[1] * t * k])
      }
      spots.push([ax, ay - size * 1.05], [ax, ay + size * 1.05], [ax + w / 2 + size * 0.7, ay], [ax - w / 2 - size * 0.7, ay])
    } else spots.push([ax, ay])
    const spot = spots.find(([cx, cy]) => {
      const b = boxAt(cx, cy)
      return !placed.some((q) => overlap(b, q)) && !(point && onWall(b))
    })
    if (!spot) continue
    const [x, y] = spot
    // 点状的（地标、兴趣点）以图标为锚点：放大时字向图标收拢；面状的以字的中心
    anchor = point ? [ax, ay] : [x, y]
    area = point ? undefined : regionOf(l, w + pad * 2, (size * 0.75 + (l.sub ? size : 0)) * 2)
    placed.push(boxAt(x, y))
    if (x < 10 || y < 10 || x > list.MW - 10 || y > list.MH - 10) continue
    // 字距：逐字放置
    let cx = x - w / 2
    const glyphs: { c: string; x: number }[] = []
    for (const c of chars) {
      const cw = measurer.measureText(c).width
      glyphs.push({ c, x: cx + cw / 2 })
      cx += cw + spacing
    }
    for (const g of glyphs) halo(g.c, g.x, y, font, undefined, l.kind === 'water' ? 0 : size * (zoning && l.kind === 'district' ? 1.5 : 1) * HALO_RATIO)
    for (const g of glyphs) text(g.c, g.x, y, font, color)
    if (l.sub) {
      const sf = `400 ${(size * 0.7).toFixed(1)}px ${th.font.label}`
      halo(l.sub[lg], x, y + size, sf, undefined, size * 0.7 * HALO_RATIO)
      text(l.sub[lg], x, y + size, sf, color)
    }
  }
  if (zoning) return
  // 地标的小圆点
  const dots: string[] = []
  for (const l of st.landmarks) if (l.kind === 'well') dots.push(R.circleD(l.p, 1.6))
  // 喷泉：一圈水池；雕像：方座上一个点
  const pools: string[] = []
  const jets: string[] = []
  const bases: string[] = []
  for (const l of st.landmarks) {
    if (l.kind === 'fountain') {
      pools.push(R.circleD(l.p, 3.2))
      jets.push(R.circleD(l.p, 0.9))
    } else if (l.kind === 'statue') {
      bases.push(R.polyD(circlePoly(l.p, 1.3, 4, Math.PI / 4)))
      jets.push(R.circleD(l.p, 0.5))
    }
  }
  // 水车：河岸边一只带辐条的轮子；风车：塔身上的十字风帆（按位置取一个角度）
  const wheels: string[] = []
  const spokes: P[][] = []
  for (const l of st.landmarks) {
    if (l.kind === 'mill') {
      wheels.push(R.circleD(l.p, 2.8))
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 4
        spokes.push([
          [l.p[0] - dmath.cos(a) * 2.8, l.p[1] - dmath.sin(a) * 2.8],
          [l.p[0] + dmath.cos(a) * 2.8, l.p[1] + dmath.sin(a) * 2.8],
        ])
      }
    } else if (l.kind === 'windmill') {
      const a0 = ((l.p[0] * 13.7 + l.p[1] * 7.1) % 100) / 100 * (Math.PI / 2)
      for (let k = 0; k < 4; k++) {
        const a = a0 + (k * Math.PI) / 2
        spokes.push([l.p, [l.p[0] + dmath.cos(a) * 8, l.p[1] + dmath.sin(a) * 8]])
      }
    }
  }
  if (wheels.length) R.list.path('map', wheels.join(''), { fill: { color: th.wall.fill, alpha: 1 }, stroke: { color: th.ink, alpha: 0.9, width: 0.8 } })
  if (spokes.length) R.lines(spokes, { color: th.ink, alpha: 0.9, width: 1.1, cap: 'round' })
  if (pools.length) R.list.path('map', pools.join(''), { fill: { color: th.water, alpha: 1 }, stroke: { color: th.ink, alpha: 0.85, width: 0.8 } })
  if (bases.length) R.list.path('map', bases.join(''), { fill: { color: th.plaza, alpha: 1 }, stroke: { color: th.ink, alpha: 0.85, width: 0.7 } })
  if (jets.length) R.list.path('map', jets.join(''), { fill: { color: th.ink, alpha: 0.85 } })
  if (dots.length) list.path('map', dots.join(''), { fill: { color: th.water, alpha: 1 }, stroke: { color: th.ink, alpha: 0.9, width: 0.8 } })
}

// —————————————————————— 区划图 ——————————————————————

/** 两个 #rrggbb 按 t 混合（t=1 取 b）：得到不透明的颜色，叠放时不会越叠越深 */
function mix(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1, 7), 16)
  const pb = parseInt(b.slice(1, 7), 16)
  const c = [16, 8, 0].map((sh) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** 斜纹图案（底色 + 45° 细线），返回 url(#id) 形式的填充色 */
function stripes(list: DisplayList, id: string, bg: string, color: string, width: number, step = 3.2) {
  const s = step
  list.patterns.set(id, {
    w: s,
    h: s,
    svg: `<rect width="${s}" height="${s}" fill="${bg}"/><path d="M0 ${s}L${s} 0M${-s / 2} ${s / 2}L${s / 2} ${-s / 2}M${s / 2} ${s * 1.5}L${s * 1.5} ${s / 2}" stroke="${color}" stroke-width="${width}"/>`,
    tile: () => {
      const c = document.createElement('canvas')
      const k = 4
      c.width = c.height = Math.round(s * k)
      const g = c.getContext('2d')!
      g.fillStyle = bg
      g.fillRect(0, 0, c.width, c.height)
      g.strokeStyle = color
      g.lineWidth = width * k
      g.beginPath()
      g.moveTo(0, s * k)
      g.lineTo(s * k, 0)
      g.moveTo((-s / 2) * k, (s / 2) * k)
      g.lineTo((s / 2) * k, (-s / 2) * k)
      g.moveTo((s / 2) * k, s * 1.5 * k)
      g.lineTo(s * 1.5 * k, (s / 2) * k)
      g.stroke()
      return c
    },
  })
  return `url(#${id})`
}

/**
 * 区划图：片区按用地性质（landuse.ts）着色，城郊与农田淡一些；街道、道路、水系、城墙、注记照常，
 * 房屋、树木、田块只留淡淡的轮廓，认得出是哪座城。左下角是图例（各类占城区面积的比例）。
 */
/** 区划图的混入比例：片区底（街巷的颜色）、街区、城郊与农田 */
const zoningMix = (dark: boolean) => (dark ? { ward: 0.34, block: 0.62, faint: 0.16 } : { ward: 0.3, block: 0.58, faint: 0.15 })

function zoningMap(R: Painter, st: Settlement, th: SettleTheme, opts: SettleOpts, measurer: CanvasRenderingContext2D, lg: Lang) {
  const S = R.S
  const list = R.list
  const dark = isDarkGround(th.ground)
  const hidden = new Set(opts.hidden ?? [])
  const K = zoningMix(dark)
  const ground = th.ground
  R.rect(th.ground)
  terrainLayers(R, st, th, opts)
  // 田块只留边界
  R.polys(
    st.fields.map((f) => f.poly),
    undefined,
    { color: th.furrow.color, alpha: Math.min(0.6, th.furrow.alpha * 1.6), width: 0.5 },
  )
  // 片区底色
  const zoned = st.wards.flatMap((w) => {
    const u = landUseOf(w.type)
    return u && !hidden.has(u) ? [{ w, u, faint: u === 'rural' || w.type === 'suburb' }] : []
  })
  const byColor = new Map<string, Poly[]>()
  const add = (c: string, p: Poly) => (byColor.get(c) ?? byColor.set(c, []).get(c)!).push(p)
  // 城郊（城外沿路的住宅）：住宅色的细斜纹，暗底上混色会发灰、认不出是哪一类，斜纹保得住色相
  const suburb = zoned.some((z) => z.w.type === 'suburb') ? stripes(list, 'zone-suburb', mix(ground, landUseColor('residential', dark), dark ? 0.12 : 0.1), landUseColor('residential', dark), dark ? 0.7 : 0.6, 3.6) : ''
  for (const z of zoned) add(z.w.type === 'suburb' ? suburb : mix(ground, landUseColor(z.u, dark), z.faint ? K.faint : K.ward), z.w.poly)
  // 街区（院落）：按中心所在的片区取色，比片区底深，街巷就是两者之间的缝
  const boxes = zoned.map((z) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of z.w.poly) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    return [x0, y0, x1, y1]
  })
  for (const b of st.blocks) {
    const c = centroid(b)
    const i = zoned.findIndex((z, k) => c[0] >= boxes[k][0] && c[0] <= boxes[k][2] && c[1] >= boxes[k][1] && c[1] <= boxes[k][3] && pointInPoly(c, z.w.poly))
    if (i < 0) continue
    const z = zoned[i]
    add(mix(ground, landUseColor(z.u, dark), z.faint ? K.faint * 1.6 : K.block), b)
  }
  for (const [c, polys] of byColor) R.polys(polys, R.fillOf(c))
  waterLayers(R, st, th)
  roads(R, st, th)
  crossingLayers(R, st, th)
  for (const p of st.piers) R.poly(p, { color: th.plaza, alpha: 1 }, { color: th.ink, alpha: 0.6, width: 0.6 })
  // 房屋与树只留淡影
  R.polys(
    st.buildings.map((b) => b.poly),
    { color: th.ink, alpha: dark ? 0.2 : 0.16 },
  )
  if (st.trees.length) R.list.path('map', st.trees.map((t) => R.circleD(t.p, t.r * TREE_SCALE)).join(''), { fill: { color: th.ink, alpha: 0.08 } })
  // 片区边界：城区实线，城郊虚线
  R.polys(
    zoned.filter((z) => !z.faint).map((z) => z.w.poly),
    undefined,
    { color: th.ink, alpha: dark ? 0.7 : 0.6, width: Math.max(0.9, 0.5 * S), join: 'round' },
  )
  R.polys(
    zoned.filter((z) => z.faint && z.u !== 'rural').map((z) => z.w.poly),
    undefined,
    { color: th.ink, alpha: 0.35, width: 0.6, join: 'round', dash: [3, 2] },
  )
  wallLayers(R, st, th)
  // 图例：地图左下角
  const legend = zoningLegend(st, th, opts, measurer, lg)
  const lx = 22
  const ly = list.MH - 22 - legend.lh
  labelLayers(R, st, th, measurer, lg, { reserve: [lx - 6, ly - 6, lx + legend.lw + 6, ly + legend.lh + 6] }, opts.regions)
  legend.draw(list, list.M + lx, list.M + ly)
}

/** 区划图例：各类的色块、名称与占比；draw 把它画在页面坐标 (px, py) 处 */
function zoningLegend(st: Settlement, th: SettleTheme, opts: SettleOpts, measurer: CanvasRenderingContext2D, lg: Lang) {
  const dark = isDarkGround(th.ground)
  const hidden = new Set(opts.hidden ?? [])
  const K = zoningMix(dark)
  const ground = th.ground
  const stats = landUseStats(st)
  const font = `600 14px ${th.font.label}`
  const small = `400 12.5px ${th.font.label}`
  const pct = (x: number) => (x < 0.01 ? '<1%' : `${Math.round(x * 100)}%`)
  const rows = stats.map((s) => ({
    ...s,
    name: tr(LAND_USES.find((d) => d.id === s.id)!.name, lg),
    note: s.id === 'rural' ? `${s.ha < 10 ? s.ha.toFixed(1) : Math.round(s.ha)} ha` : pct(s.share),
  }))
  measurer.font = font
  const nameW = Math.max(40, ...rows.map((r) => measurer.measureText(r.name).width))
  measurer.font = small
  const noteW = Math.max(20, ...rows.map((r) => measurer.measureText(r.note).width))
  const lw = 16 + 26 + nameW + 18 + noteW + 16
  const rh = 23
  const lh = 40 + rows.length * rh + 10
  const draw = (list: DisplayList, px: number, py: number) => {
    list.path('page', `M${px} ${py}h${lw}v${lh}h${-lw}Z`, { fill: { color: th.paper, alpha: 0.92 }, stroke: { color: th.frame, alpha: 1, width: 1 } })
    list.text('page', { t: tr('区划', lg), x: px + 16, y: py + 21, font: `600 15px ${th.font.label}`, align: 'start', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: [px, py, px + lw, py + 36] })
    rows.forEach((r, i) => {
      const y = py + 40 + i * rh + rh / 2
      const off = hidden.has(r.id)
      const c = landUseColor(r.id, dark)
      list.path('page', `M${px + 16} ${y - 6.5}h18v13h-18Z`, {
        fill: off ? undefined : { color: mix(ground, c, r.id === 'rural' ? 0.45 : K.block + 0.15), alpha: 1 },
        stroke: { color: off ? th.label.color : mix(c, th.ink, 0.35), alpha: off ? 0.5 : 1, width: 1 },
      })
      const a = off ? 0.45 : 1
      list.text('page', { t: r.name, x: px + 42, y, font, align: 'start', baseline: 'central', fill: { color: th.label.color, alpha: a }, opacity: 1, bbox: [px, y - 9, px + lw, y + 9] })
      list.text('page', { t: r.note, x: px + lw - 14, y, font: small, align: 'end', baseline: 'central', fill: { color: th.label.color, alpha: a * 0.75 }, opacity: 1, bbox: [px, y - 9, px + lw, y + 9] })
    })
  }
  return { lw, lh, draw }
}

// —————————————————————— 图廓 ——————————————————————

/** 图廓：图框内框左上角在 (X, Y)、大小 MW × MH（整页排版时 X = Y = M）；S 是地图的像素 / 米（比例尺用） */
/** ornaments：图饰（标题框、朱印、指北针）；浏览器里默认不画，图框与比例尺照画 */
function furniture(list: DisplayList, st: Settlement, th: SettleTheme, S: number, X: number, Y: number, MW: number, MH: number, measurer: CanvasRenderingContext2D, lg: Lang, ornaments = true) {
  const ink = th.frame
  // 图框：内细外粗
  list.path('page', `M${X} ${Y}H${X + MW}V${Y + MH}H${X}Z`, { stroke: { color: ink, alpha: 1, width: 1.4 } })
  list.path('page', `M${X - 8} ${Y - 8}H${X + MW + 8}V${Y + MH + 8}H${X - 8}Z`, { stroke: { color: ink, alpha: 1, width: 2.6 } })
  if (ornaments) titleBlock(list, st, th, X, Y, measurer, lg)
  scaleBar(list, th, S, X, Y, MW, MH)
  if (ornaments) compass(list, th, X, Y, MW)
}

/** 标题框：城名、副标题与朱印 */
function titleBlock(list: DisplayList, st: Settlement, th: SettleTheme, X: number, Y: number, measurer: CanvasRenderingContext2D, lg: Lang) {
  const ink = th.frame
  // 标题框
  const tx = X + 22
  const ty = Y + 22
  // 东式城名用毛笔字（中文）；英文用标题字体
  const title = lg === 'zh' ? st.nameZh : lg === 'ja' ? st.nameJa : st.name
  const zhFont = lg === 'en' ? `600 40px ${th.font.title}` : eastAsian(st.params.culture) && th.brushTitle !== false && lg === 'zh' ? `400 44px "Ma Shan Zheng", ${th.font.label}` : `600 40px ${th.font.label}`
  measurer.font = zhFont
  const tw = Math.max(measurer.measureText(title).width, 200)
  const bw = tw + 60
  const bh = 104
  list.path('page', `M${tx} ${ty}h${bw}v${bh}h${-bw}Z`, { fill: { color: th.paper, alpha: 0.9 }, stroke: { color: ink, alpha: 1, width: 1.2 } })
  list.path('page', `M${tx + 4} ${ty + 4}h${bw - 8}v${bh - 8}h${-(bw - 8)}Z`, { stroke: { color: ink, alpha: 0.6, width: 0.6 } })
  list.text('page', { t: title, x: tx + bw / 2, y: ty + 44, font: zhFont, align: 'middle', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: [tx, ty, tx + bw, ty + bh] })
  // 副标题：另一种写法的城名（中文、日文图配原文名；英文图配中文名）· 规模 · 人口
  const other = lg === 'en' ? st.nameZh : st.name
  const sub = `${other} · ${st.params.capital ? CAPITAL_NAME[lg] : SIZE_NAME[lg][st.params.size]} · ${POP_TEXT[lg](st.stats.population.toLocaleString(lg === 'zh' ? 'zh-CN' : lg))}`
  list.text('page', { t: sub, x: tx + bw / 2, y: ty + 80, font: `italic 400 14px ${th.font.italic.replace(/^italic /, '')}`, align: 'middle', baseline: 'central', fill: { color: th.label.color, alpha: 0.85 }, opacity: 1, bbox: [tx, ty, tx + bw, ty + bh] })
  // 朱印：标题框右下角压一方竖排的白文印，印文取中文城名的前两个字
  if (th.seal) {
    const chars = [...st.nameZh].slice(0, 2)
    const sw = 30
    const sh = chars.length > 1 ? 56 : 30
    const px = tx + bw - sw * 0.6
    const py = ty + bh - sh * 0.45
    list.path('page', `M${px} ${py}h${sw}v${sh}h${-sw}Z`, { fill: { color: th.seal, alpha: 0.9 } })
    list.path('page', `M${px + 2.5} ${py + 2.5}h${sw - 5}v${sh - 5}h${-(sw - 5)}Z`, { stroke: { color: th.paper, alpha: 0.85, width: 1 } })
    chars.forEach((c, i) =>
      list.text('page', { t: c, x: px + sw / 2, y: py + 15.5 + i * 25, font: `400 21px "Ma Shan Zheng", ${th.font.label}`, align: 'middle', baseline: 'central', fill: { color: th.paper, alpha: 0.95 }, opacity: 1, bbox: [px, py, px + sw, py + sh] }),
    )
  }
}

/** 比例尺：取最短的、画出来超过 120 像素的整数长度（浏览器里随缩放变，放大时到几米，缩小时到几公里） */
function scaleBar(list: DisplayList, th: SettleTheme, S: number, X: number, Y: number, MW: number, MH: number) {
  const ink = th.frame
  const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]
  const niceM = NICE.find((m) => m * S > 120) ?? NICE[NICE.length - 1]
  const len = niceM * S
  const sx = X + MW - len - 30
  const sy = Y + MH - 30
  list.path('page', `M${sx - 10} ${sy - 22}h${len + 30}v${38}h${-(len + 30)}Z`, { fill: { color: th.paper, alpha: 0.85 } })
  for (let k = 0; k < 4; k++) list.path('page', `M${sx + (len * k) / 4} ${sy}h${len / 4}v5h${-len / 4}Z`, { fill: { color: k % 2 ? th.paper : ink, alpha: 1 }, stroke: { color: ink, alpha: 1, width: 0.8 } })
  for (const [k, t] of [
    [0, '0'],
    [1, niceM >= 1000 ? `${niceM / 1000} km` : `${niceM} m`],
  ] as const)
    list.text('page', { t, x: sx + len * k, y: sy - 9, font: `400 11px ${th.font.label}`, align: 'middle', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: [sx - 20, sy - 20, sx + len + 20, sy] })
}

function compass(list: DisplayList, th: SettleTheme, X: number, Y: number, MW: number) {
  const ink = th.frame
  const nx = X + MW - 50
  const ny = Y + 58
  list.path('page', `M${nx} ${ny - 30}L${nx + 9} ${ny + 8}L${nx} ${ny + 2}Z`, { fill: { color: ink, alpha: 1 } })
  list.path('page', `M${nx} ${ny - 30}L${nx - 9} ${ny + 8}L${nx} ${ny + 2}Z`, { fill: { color: th.paper, alpha: 1 }, stroke: { color: ink, alpha: 1, width: 1 } })
  list.path('page', `M${nx + 16} ${ny - 4}A16 16 0 1 1 ${nx - 16} ${ny - 4}A16 16 0 1 1 ${nx + 16} ${ny - 4}Z`, { stroke: { color: ink, alpha: 0.6, width: 0.8 } })
  list.text('page', { t: 'N', x: nx, y: ny - 42, font: `600 14px ${th.font.title}`, align: 'middle', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: [nx - 10, ny - 52, nx + 10, ny - 32] })
}

/** 纸边到图框内框的距离 */
const RIM = 30
/**
 * 浏览器里图框内框离舞台边的最小距离：外面还有一圈纸（RIM）和暗色桌面；上边让出"地图 / 区域"的页签，底边多留，放成长时间轴与操作提示。
 * 地图比可用区域小时（缩小了），图框贴着地图收拢，见 AtlasViewer 的图框模式。
 */
export const SETTLE_FRAME_INSET = { t: 34 + RIM, r: 20 + RIM, b: 76 + RIM, l: 20 + RIM }

/**
 * 浏览器里固定不动的图廓层（见 AtlasViewer 的图框模式）：纸边、图框、标题、指北针、比例尺、区划图例
 * 围着图框内框 box（舞台坐标）排；比例尺按当前缩放倍率 k 算。
 */
export function buildSettlementChrome(
  st: Settlement,
  style: SettleStyleId,
  opts: SettleOpts,
  measurer: CanvasRenderingContext2D,
  w: number,
  h: number,
  box: { x: number; y: number; w: number; h: number },
  k: number,
  probe?: ProbeCard | null,
): DisplayList {
  const lg = opts.lang ?? 'zh'
  const th = themeFor(style, lg)
  const list = new DisplayList(w, h, 0, w, h)
  const { x, y } = box
  // 纸：内框外的一圈
  const band = (a: number, b: number, c: number, d: number) => `M${a} ${b}H${c}V${d}H${a}Z`
  const [x0, y0, x1, y1] = [x - RIM, y - RIM, x + box.w + RIM, y + box.h + RIM]
  list.path('page', band(x0, y0, x1, y) + band(x0, y + box.h, x1, y1) + band(x0, y, x, y + box.h) + band(x + box.w, y, x1, y + box.h), {
    fill: { color: th.paper, alpha: 1 },
  })
  furniture(list, st, th, settlePageScale(st) * k, x, y, box.w, box.h, measurer, lg, !!opts.ornaments)
  if (opts.view === 'zoning' && opts.ornaments) {
    const legend = zoningLegend(st, th, opts, measurer, lg)
    legend.draw(list, x + 22, y + box.h - 22 - legend.lh)
  }
  if (probe) probeCard(list, th, measurer, probe, x + box.w - 18, y + 112)
  return list
}

/** 悬停读数：标题与几行"名称 …… 数值" */
export interface ProbeCard {
  title: string
  rows: [string, string][]
}

/** 悬停读数画成图廓里的一张小卡片：右上角、指北针下面，与标题框、图例一套纸色与框线（右边缘对齐 x1） */
function probeCard(list: DisplayList, th: SettleTheme, measurer: CanvasRenderingContext2D, p: ProbeCard, x1: number, y: number) {
  const titleFont = `600 14px ${th.font.label}`
  const rowFont = `400 12px ${th.font.label}`
  measurer.font = titleFont
  let w = measurer.measureText(p.title).width
  measurer.font = rowFont
  for (const [k, v] of p.rows) w = Math.max(w, measurer.measureText(k).width + 28 + measurer.measureText(v).width)
  const pw = Math.max(170, Math.ceil(w) + 28)
  const rh = 20
  const ph = 42 + p.rows.length * rh + 8
  const x = x1 - pw
  const ink = th.frame
  list.path('page', `M${x} ${y}h${pw}v${ph}h${-pw}Z`, { fill: { color: th.paper, alpha: 0.93 }, stroke: { color: ink, alpha: 1, width: 1 } })
  list.path('page', `M${x + 3} ${y + 3}h${pw - 6}v${ph - 6}h${-(pw - 6)}Z`, { stroke: { color: ink, alpha: 0.45, width: 0.5 } })
  const bb: [number, number, number, number] = [x, y, x + pw, y + ph]
  list.text('page', { t: p.title, x: x + 14, y: y + 20, font: titleFont, align: 'start', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: bb })
  list.path('page', `M${x + 14} ${y + 34}H${x + pw - 14}`, { stroke: { color: ink, alpha: 0.6, width: 0.6 } })
  p.rows.forEach(([k, v], i) => {
    const ry = y + 42 + i * rh + rh / 2
    const kx = x + 14 + measurer.measureText(k).width + 5
    const vx = x + pw - 14 - measurer.measureText(v).width - 5
    list.text('page', { t: k, x: x + 14, y: ry, font: rowFont, align: 'start', baseline: 'central', fill: { color: th.label.color, alpha: 0.75 }, opacity: 1, bbox: bb })
    // 名称与数值之间的点线引导
    if (vx > kx) list.path('page', `M${kx} ${ry + 4}H${vx}`, { stroke: { color: ink, alpha: 0.4, width: 0.6, dash: [1, 2.5] } })
    list.text('page', { t: v, x: x + pw - 14, y: ry, font: rowFont, align: 'end', baseline: 'central', fill: { color: th.label.color, alpha: 1 }, opacity: 1, bbox: bb })
  })
}

/** 图框里、地图范围以外的底色 */
export const settleBackdrop = (style: SettleStyleId) => settleTheme(style).ground

/** 字体加载：中文按实际用到的字取子集 */
/**
 * 等这幅图要用的字体（只下载图上出现的字）。最多等 wait 毫秒：中日文字体按字切成上百个子集，
 * 大城的地名多、网络慢时要下很久，超时就先用回退字体画，返回 false；later 在字体全部到齐（或失败）时兑现，调用方据此重画
 */
export async function ensureSettleFonts(st: Settlement, style: SettleStyleId, lg: Lang = 'zh', wait = 2500): Promise<{ ready: boolean; later: Promise<unknown> }> {
  const th = settleTheme(style)
  const text = [st.nameZh, st.name, st.nameJa, ...st.labels.map((l) => l.text[lg] + (l.sub?.[lg] ?? '')), SIZE_NAME[lg][st.params.size], CAPITAL_NAME[lg], POP_TEXT[lg]('0123456789,'), tr('区划', lg), ...LAND_USES.map((d) => tr(d.name, lg))].join('')
  const fams = new Set<string>()
  for (const f of [th.font.title, th.font.label]) for (const x of langFont(f, lg).split(',')) if (x.includes('"')) fams.add(x.trim().replace(/^italic /, ''))
  if (eastAsian(st.params.culture) || th.seal) fams.add('"Ma Shan Zheng"')
  const loads: Promise<unknown>[] = []
  for (const fam of fams) for (const w of ['400', '600', 'italic 400']) loads.push(document.fonts.load(`${w} 20px ${fam}`, text))
  // 字体加载失败回退系统字体
  const later = Promise.all(loads).catch(() => undefined)
  const ready = await Promise.race([later.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), wait))])
  return { ready, later }
}
