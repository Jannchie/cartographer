import type { World } from '../../gen/types'
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
import { drawGlyphs } from './glyphs'
import { LabelLayer } from './labels'
import { THEMES, themeById, type AtlasOpts, type StyleId } from './styles'

export { THEMES, type StyleId }

const rgb = (c: number[]) => `rgb(${c.map(Math.round).join(',')})`

/** 按风格加载所需字体；中文字体按实际用到的字取子集 */
export async function ensureFonts(world: World, id: StyleId) {
  const t = themeById(id)
  const fams = new Set<string>()
  for (const f of [t.labels.display, t.labels.text]) fams.add(f.split(',')[0].trim())
  const text = t.labels.zh
    ? [...world.labels.map((l) => l.zh), ...world.realms.map((r) => r.zh), world.worldNameZh, '舆地全图种子公里'].join('') + world.params.seed
    : undefined
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

/**
 * 纸质地图：先逐像素着色（各风格的底色、晕渲、线划），
 * 再叠加河流、符号、经纬网、图名、图例、注记与图框。
 */
export function renderAtlas(world: World, rivers: SmoothRiver[], id: StyleId, opts: AtlasOpts, S = 2): HTMLCanvasElement {
  const theme = themeById(id)
  let f = fieldCache.get(world)
  if (!f || f.S !== S) {
    f = new Fields(world, S)
    fieldCache.set(world, f)
  }
  theme.prepare?.(f)
  const { MW, MH, W } = f
  const k = S / 2
  const M = Math.round((theme.frame === 'ink' ? 44 : 34) * S)
  const canvas = document.createElement('canvas')
  canvas.width = MW + M * 2
  canvas.height = MH + M * 2
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = rgb(theme.paper)
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const t0 = performance.now()
  const img = f.scan((p, o) => theme.pixel(p, o, f!, opts))
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

  const compassR = (theme.compass === 'nautical' ? 46 : theme.compass === 'ornate' ? 44 : 34) * S
  const cx = MW - (theme.compass === 'nautical' ? 110 : 76) * S
  const cy = MH - (theme.compass === 'nautical' ? 118 : 84) * S
  if (theme.rhumb) drawRhumbLines(ctx, [[cx, cy], [MW * 0.3, MH * 0.35]], MW, MH, S)
  if (theme.soundings) drawSoundings(ctx, f)
  drawRivers(ctx, rivers, W, S, theme.river.color, theme.river.width, theme.river.minFlow)
  if (theme.glyphs) drawGlyphs(ctx, f, { ink: theme.ink, paper: 'rgb(236, 222, 186)', shadow: 'rgba(74, 54, 36, 0.32)' })
  if (opts.graticule && theme.graticule) drawGraticule(ctx, world, S, theme.graticule)
  drawCompass(ctx, theme, cx, cy, compassR)
  drawScaleBar(ctx, world, theme, S, theme.compass === 'none' ? MW - 150 * S : MW - 150 * S, MH - 24 * S)
  const title = drawCartouche(ctx, world, theme, S, MW)
  const legend = drawLegend(ctx, world, theme, S, MH)
  if (opts.labels) {
    const layer = new LabelLayer(ctx, world, S, theme)
    layer.reserve(title)
    if (legend) layer.reserve(legend)
    const cr = compassR * (theme.compass === 'nautical' ? 1.4 : 1.1)
    if (theme.compass !== 'none') layer.reserve({ x0: cx - cr, y0: cy - cr - 12 * k, x1: cx + cr, y1: cy + cr })
    layer.reserve({ x0: MW - 300 * k, y0: MH - 50 * k, x1: MW, y1: MH })
    layer.all()
  }
  ctx.restore()

  drawFrame(ctx, world, theme, S, M, MW, MH)
  if (import.meta.env?.DEV) console.log(`[atlas] ${id}: pixels ${(t1 - t0).toFixed(0)}ms, overlays ${(performance.now() - t1).toFixed(0)}ms`)
  return canvas
}
