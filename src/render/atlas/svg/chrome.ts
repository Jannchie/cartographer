import type { World } from '../../../gen/types'
import { cjkFont, lang } from '../../../i18n'
import { drawCartouche, drawCompass, drawFrameAt, drawLegend, drawScaleBarAt, lonScale, SCALE_NICE_KM } from '../furniture'
import { compassSpot, marginOf } from '../index'
import { themeById, type StyleId, type Theme } from '../styles'
import { DisplayList } from './displayList'
import { Recorder } from './recorder'
import type { Box, Inset } from './viewer'

/**
 * 世界纸图在浏览器里的图廓层（AtlasViewer 的图框模式）：纸边、图框与经纬刻度、标题、指北针、比例尺、图例、悬停读数
 * 固定在舞台上，围着图框内框排；地图层只剩地图本身，随拖动缩放。整页导出仍用 buildAtlasVector 的经典排版。
 */

/** 图廓件的尺寸倍率（相当于整页排版里的 S；k = S / 2 是线宽字号的倍率） */
const CHROME_S = 2
/** 纸边宽：比整页排版的留白略窄（舞台上寸土寸金），仍放得下经纬度边注 */
const rimOf = (theme: Theme) => marginOf(theme, 1.6)

/** 图框内框离舞台四边的最小距离：外面一圈纸边，上边让出视图切换的纸签，下边让出操作提示 */
export function atlasFrameInset(style: StyleId): Inset {
  const R = rimOf(themeById(style))
  return { t: 34 + R, r: 22 + R, b: 46 + R, l: 22 + R }
}

/** 图框里、地图范围以外的底色 */
export const atlasBackdrop = (style: StyleId) => {
  const p = themeById(style).paper
  return `rgb(${p.map(Math.round).join(',')})`
}

/** 悬停读数：标题与几行"名称 …… 数值"（已翻译） */
export interface AtlasProbe {
  title: string
  rows: [string, string][]
}

/** 地图当前在舞台上的位置：页面坐标 (0, 0) 在 (x, y)，每页面像素 k 个屏幕像素 */
export interface MapView {
  x: number
  y: number
  k: number
}

/** 经纬度注记间隔：相邻两条注记至少隔 70 像素 */
function degStep(pxPerDeg: number) {
  return [1, 2, 5, 10, 20, 30, 45].find((s) => s * pxPerDeg >= 70) ?? 90
}

export function buildAtlasChrome(
  world: World,
  style: StyleId,
  map: DisplayList,
  view: MapView,
  measurer: CanvasRenderingContext2D,
  w: number,
  h: number,
  box: Box,
  probe?: AtlasProbe | null,
): DisplayList {
  const theme = themeById(style)
  const list = new DisplayList(w, h, 0, w, h)
  const { x: X, y: Y, w: FW, h: FH } = box
  // 缩得很小、图框贴着地图收拢时，图廓件跟着缩（至多缩到一半），免得把地图盖满
  const S = CHROME_S * Math.min(1, Math.max(0.5, Math.min(FW / 1300, FH / 820)))
  const k = S / 2
  const paper = atlasBackdrop(style)
  // 纸：内框外的一圈
  const R = rimOf(theme)
  if (R > 0) {
    const band = (a: number, b: number, c: number, d: number) => `M${a} ${b}H${c}V${d}H${a}Z`
    const [x0, y0, x1, y1] = [X - R, Y - R, X + FW + R, Y + FH + R]
    list.path('page', band(x0, y0, x1, Y) + band(x0, Y + FH, x1, y1) + band(x0, Y, X, Y + FH) + band(X + FW, Y, x1, Y + FH), { fill: { color: paper, alpha: 1 } })
  }
  const rec = new Recorder(list, measurer)
  rec.space = 'page'
  const ctx = rec as unknown as CanvasRenderingContext2D
  // 图框：经纬刻度带与边注按地图当前的位置与倍率排，注记间隔随缩放变
  const cellPx = (map.width - map.M * 2) / world.W
  const geo = { ox: view.x + map.M * view.k, oy: view.y + map.M * view.k, s: cellPx * view.k }
  const p = world.params
  const latPx = ((world.H - 1) * geo.s) / Math.max(1e-6, Math.abs(p.latSouth - p.latNorth))
  const lonPx = geo.s / lonScale(world)
  const step = degStep(Math.min(latPx, lonPx))
  drawFrameAt(ctx, world, theme, S, X, Y, FW, FH, geo, step, step / 5)
  // 图框内的几件：与整页排版同样的相对位置，只是贴着当前的内框
  rec.save()
  rec.translate(X, Y)
  const c = compassSpot(theme, S, FW, FH)
  drawCompass(ctx, theme, c.cx, c.cy, c.r)
  // 比例尺：每屏幕像素的公里数随缩放倍率变
  drawScaleBarAt(ctx, theme, S, world.kmPerCell / geo.s, FW - 150 * S, FH - 24 * S, SCALE_NICE_KM)
  drawCartouche(ctx, world, theme, S, FW)
  drawLegend(ctx, world, theme, S, FH)
  rec.restore()
  // 水墨风格的题名竖排在右上角，读数卡放左上；其余放右上
  if (probe) probeCard(list, theme, measurer, probe, theme.cartouche === 'ink' ? X + 18 * k : null, X + FW - 18 * k, Y + 18 * k)
  return list
}

/** 悬停读数画成图廓里的一张小卡片，与标题框同一套纸色与框线；x0 给出时左对齐 x0，否则右对齐 x1 */
function probeCard(list: DisplayList, theme: Theme, measurer: CanvasRenderingContext2D, p: AtlasProbe, x0: number | null, x1: number, y: number) {
  const cjk = cjkFont(lang)
  const titleFont = `600 15px ${theme.labels.display}, ${cjk}`
  const rowFont = `500 12.5px ${theme.labels.text}, ${cjk}`
  measurer.font = titleFont
  let tw = measurer.measureText(p.title).width
  measurer.font = rowFont
  for (const [a, b] of p.rows) tw = Math.max(tw, measurer.measureText(a).width + 28 + measurer.measureText(b).width)
  const pw = Math.max(170, Math.ceil(tw) + 28)
  const rh = 20
  const ph = 42 + p.rows.length * rh + 8
  const x = x0 ?? x1 - pw
  const ink = theme.ink
  const paper = `rgb(${theme.paper.map(Math.round).join(',')})`
  list.path('page', `M${x} ${y}h${pw}v${ph}h${-pw}Z`, { fill: { color: paper, alpha: 0.93 }, stroke: { color: ink, alpha: 1, width: 1 } })
  list.path('page', `M${x + 3} ${y + 3}h${pw - 6}v${ph - 6}h${-(pw - 6)}Z`, { stroke: { color: ink, alpha: 0.45, width: 0.5 } })
  const bb: [number, number, number, number] = [x, y, x + pw, y + ph]
  list.text('page', { t: p.title, x: x + 14, y: y + 20, font: titleFont, align: 'start', baseline: 'central', fill: { color: ink, alpha: 1 }, opacity: 1, bbox: bb })
  list.path('page', `M${x + 14} ${y + 34}H${x + pw - 14}`, { stroke: { color: ink, alpha: 0.6, width: 0.6 } })
  p.rows.forEach(([a, b], i) => {
    const ry = y + 42 + i * rh + rh / 2
    const kx = x + 14 + measurer.measureText(a).width + 5
    const vx = x + pw - 14 - measurer.measureText(b).width - 5
    list.text('page', { t: a, x: x + 14, y: ry, font: rowFont, align: 'start', baseline: 'central', fill: { color: ink, alpha: 0.75 }, opacity: 1, bbox: bb })
    // 名称与数值之间的点线引导
    if (vx > kx) list.path('page', `M${kx} ${ry + 4}H${vx}`, { stroke: { color: ink, alpha: 0.4, width: 0.6, dash: [1, 2.5] } })
    list.text('page', { t: b, x: x + pw - 14, y: ry, font: rowFont, align: 'end', baseline: 'central', fill: { color: ink, alpha: 1 }, opacity: 1, bbox: bb })
  })
}
