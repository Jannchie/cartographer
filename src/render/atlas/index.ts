import type { World } from '../../gen/types'
import { cjkFont, lang, placeName, t as tr, worldTitle } from '../../i18n'
import type { SmoothRiver } from '../rivers'
import { drawRivers } from '../rivers'
import { Fields } from './fields'
import {
  drawCartouche,
  drawCompass,
  drawFrame,
  drawGraticule,
  drawLegend,
  drawRhumbLines,
  drawScaleBar,
  drawSoundings,
} from './furniture'
import { fitRiversToCoast } from './riverMouth'
import { drawRoads } from './roads'
import { drawAdmin } from './admin'
import { drawGlyphs } from './glyphs'
import { LabelLayer } from './labels'
import { FANTASY_GLYPHS, THEMES, themeById, type AtlasOpts, type StyleId, type Theme } from './styles'

export { THEMES, type StyleId }
export { Fields }

const rgb = (c: number[]) => `rgb(${c.map(Math.round).join(',')})`

/** 按风格加载所需字体；中文、日文字体按实际用到的字取子集 */
export async function ensureFonts(world: World, id: StyleId) {
  const t = themeById(id)
  const fams = new Set<string>()
  for (const f of [t.labels.display, t.labels.text]) fams.add(f.split(',')[0].trim())
  let text: string | undefined
  if (lang !== 'en') {
    for (const f of [cjkFont(lang), cjkFont(lang, true)]) fams.add(f.split(',')[0].trim())
    text = [...world.labels.map((l) => placeName(l)), ...world.realms.map((r) => placeName(r)), worldTitle(world), tr('{name}舆地全图', { name: '' }), tr('种子 {seed}', { seed: '' }), tr('公里'), tr('海拔（米）')].join('') + world.params.seed
  }
  const loads: Promise<unknown>[] = []
  for (const fam of fams) {
    for (const style of ['400', '600', 'italic 400']) loads.push(document.fonts.load(`${style} 20px ${fam}`, text))
  }
  if (t.cartouche === 'ink') loads.push(document.fonts.load(`400 20px "Ma Shan Zheng"`, text))
  try {
    await Promise.all(loads)
  } catch {
    // 字体加载失败时回退到系统字体
  }
}

const fieldCache = new WeakMap<World, Fields>()

export function fieldsFor(world: World, S: number) {
  let f = fieldCache.get(world)
  if (!f || f.S !== S) {
    f = new Fields(world, S)
    fieldCache.set(world, f)
  }
  return f
}

export function marginOf(theme: Theme, S: number) {
  if (theme.frame === 'none') return 0
  return Math.round((theme.frame === 'ink' ? 44 : 34) * S)
}

/**
 * 纸质地图：先逐像素着色（各风格的底色、晕渲、线划），
 * 再叠加河流、符号、经纬网、图名、图例、注记与图框。
 */
export function renderAtlas(world: World, rivers: SmoothRiver[], id: StyleId, opts: AtlasOpts, S = 2): HTMLCanvasElement {
  const theme = themeById(id)
  const f = fieldsFor(world, S)
  theme.prepare?.(f)
  const { MW, MH } = f
  const M = marginOf(theme, S)
  const canvas = document.createElement('canvas')
  canvas.width = MW + M * 2
  canvas.height = MH + M * 2
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = rgb(theme.paper)
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const t0 = performance.now()
  const img = f.scan((p, o) => theme.pixel(p, o, f, opts))
  const t1 = performance.now()
  const off = document.createElement('canvas')
  off.width = MW
  off.height = MH
  off.getContext('2d')!.putImageData(img, 0, 0)
  ctx.drawImage(off, M, M)

  ctx.save()
  ctx.translate(M, M)
  ctx.beginPath()
  ctx.rect(0, 0, MW, MH)
  ctx.clip()
  drawOverlays(ctx, f, theme, rivers, opts)
  ctx.restore()

  drawFrame(ctx, world, theme, S, M, MW, MH)
  if (import.meta.env?.DEV) console.log(`[atlas] ${id}: pixels ${(t1 - t0).toFixed(0)}ms, overlays ${(performance.now() - t1).toFixed(0)}ms`)
  return canvas
}

/** 指北针的位置与半径：地图框（宽 MW、高 MH）右下角、比例尺上方 */
export function compassSpot(theme: Theme, S: number, MW: number, MH: number) {
  return {
    r: (theme.compass === 'nautical' ? 46 : theme.compass === 'ornate' ? 44 : 34) * S,
    cx: MW - (theme.compass === 'nautical' ? 110 : 76) * S,
    cy: MH - (theme.compass === 'nautical' ? 118 : 84) * S,
  }
}

/**
 * 地图框内的全部叠加层（位图与矢量共用）。
 * furniture(on)：标题、指北针、比例尺、图例这几件图廓件画之前 / 之后各调一次（矢量列表据此把它们单独分段）
 */
export function drawOverlays(ctx: CanvasRenderingContext2D, f: Fields, theme: Theme, rivers: SmoothRiver[], opts: AtlasOpts, furniture?: (on: boolean) => void) {
  const reserved = drawMapOverlays(ctx, f, theme, rivers, opts, furniture)
  if (opts.labels) drawMapLabels(ctx, f, theme, opts.areas, reserved)
}

/** 注记要让开的范围（地图框坐标） */
export type Reserved = Parameters<LabelLayer['reserve']>[0]

/** 注记以外的叠加层；返回注记要让开的范围（图名、图例、指北针、比例尺） */
export function drawMapOverlays(ctx: CanvasRenderingContext2D, f: Fields, theme: Theme, rivers: SmoothRiver[], opts: AtlasOpts, furniture?: (on: boolean) => void): Reserved[] {
  const { world, S, MW, MH, W } = f
  const k = S / 2
  const { r: compassR, cx, cy } = compassSpot(theme, S, MW, MH)
  if (theme.rhumb) drawRhumbLines(ctx, [[cx, cy], [MW * 0.3, MH * 0.35]], MW, MH, S)
  if (theme.soundings) drawSoundings(ctx, f)
  const rv = theme.river
  drawRivers(ctx, rv.fitCoast ? fitRiversToCoast(rivers, f) : rivers, W, S, rv.color, rv.width, rv.minFlow)
  if (theme.glyphs) drawGlyphs(ctx, f, FANTASY_GLYPHS)
  // 道路画在山形、树林符号之上：翻山的路段也看得见
  drawRoads(ctx, world.roads, S, theme.roads)
  drawAdmin(ctx, world, S, theme)
  if (opts.graticule && theme.graticule) drawGraticule(ctx, world, S, theme.graticule)
  furniture?.(true)
  drawCompass(ctx, theme, cx, cy, compassR)
  drawScaleBar(ctx, world, theme, S, MW - 150 * S, MH - 24 * S)
  const title = drawCartouche(ctx, world, theme, S, MW)
  const legend = drawLegend(ctx, world, theme, S, MH)
  furniture?.(false)
  const out: Reserved[] = [title]
  if (legend) out.push(legend)
  const cr = compassR * (theme.compass === 'nautical' ? 1.4 : 1.1)
  if (theme.compass !== 'none') out.push({ x0: cx - cr, y0: cy - cr - 12 * k, x1: cx + cr, y1: cy + cr })
  out.push({ x0: MW - 300 * k, y0: MH - 50 * k, x1: MW, y1: MH })
  return out
}

/** 地图里的注记（叠加层的最后一步）：区域改动后只需重排这一步 */
export function drawMapLabels(ctx: CanvasRenderingContext2D, f: Fields, theme: Theme, areas: AtlasOpts['areas'], reserved: Reserved[]) {
  const layer = new LabelLayer(ctx, f.world, f.S, theme, areas)
  for (const b of reserved) layer.reserve(b)
  layer.all()
}
