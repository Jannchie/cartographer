import type { World } from '../../../gen/types'
import type { SmoothRiver } from '../../rivers'
import { drawFrame } from '../furniture'
import { drawMapLabels, drawMapOverlays, fieldsFor, marginOf, type Reserved } from '../index'
import { atlasLabelK } from '../labels'
import { politicalRegions, type PoliticalMode } from '../political'
import { currentFontPreset, themeById, type AtlasOpts, type PoliticalLook, type StyleId } from '../styles'
import { contours } from '../../../gen/contour'
import { pathData } from './path'
import { DisplayList, type Segment } from './displayList'
import { fieldsOf, Layers, rgb, type VectorFields } from './layers'
import { Recorder } from './recorder'

const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=IM+Fell+English:ital@0;1&family=IM+Fell+English+SC&family=Ma+Shan+Zheng&family=Noto+Serif+SC:wght@400;600&family=Noto+Sans+SC:wght@400;600&family=Noto+Serif+JP:wght@400;600&family=Noto+Sans+JP:wght@400;600&family=Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400&display=swap'

/**
 * 政区着色：按国家或文化的配色给陆地上色。同色的区域互不相邻，一种颜色追踪一次；
 * 色块先向海里外扩几格，再用海岸线裁切，岸线与底图的海岸一样平滑。
 * 色带：沿色块轮廓描一道粗线，只留色块以内、陆地以内的半边，于是只出现在国界内侧
 */
function politicalFill(L: Layers, world: World, F: VectorFields, mode: PoliticalMode, look: PoliticalLook) {
  const { W, H } = world
  const N = W * H
  const k = L.S / 2
  const { list, raster } = politicalRegions(world, mode)
  const col = new Int8Array(N).fill(-1)
  let front: number[] = []
  for (let i = 0; i < N; i++) {
    const r = raster[i]
    if (r < 0) continue
    col[i] = list[r].color
    front.push(i)
  }
  for (let step = 0; step < 3 && front.length; step++) {
    const next: number[] = []
    for (const c of front) {
      const x = c % W
      for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
        if (j < 0 || j >= N || col[j] >= 0) continue
        col[j] = col[c]
        next.push(j)
      }
    }
    front = next
  }
  L.list.clips.set('landClip', { d: pathData(contours(F.land, W, H, 0, true), L.S, { closed: true, tol: 0.35, minArea: 1.5 }), rule: 'evenodd' })
  const field = new Float32Array(N)
  for (let c = 0; c < look.palette.length; c++) {
    let any = false
    for (let i = 0; i < N; i++) {
      field[i] = col[i] === c ? 1 : 0
      any ||= col[i] === c
    }
    if (!any) continue
    const d = pathData(contours(field, W, H, 0.5, true), L.S, { closed: true, tol: 0.35, minArea: 1.5 })
    const color = look.palette[c]
    if (look.fill > 0) L.list.path('map', d, { fill: { color: rgb(color), alpha: look.fill, rule: 'evenodd' }, clip: 'landClip' })
    if (look.band) {
      const id = `pol${c}`
      L.list.clips.set(id, { d, rule: 'evenodd', within: 'landClip' })
      const tone = look.band.tone
      L.list.path('map', d, { stroke: { color: rgb([color[0] * tone, color[1] * tone, color[2] * tone]), alpha: look.band.alpha, width: look.band.width * 2 * k, join: 'round' }, clip: id })
    }
  }
}

/** 可平铺的噪声小图（周期性值噪声），返回 data URL */
function noiseTile(size: number, cell: number, rgb: number[], alpha: number, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const img = g.createImageData(size, size)
  const P = Math.max(1, Math.round(size / cell))
  const h = (x: number, y: number) => {
    x = ((x % P) + P) % P
    y = ((y % P) + P) % P
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed * 1442695041
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * P
      const gy = (y / size) * P
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      let fx = gx - x0
      let fy = gy - y0
      fx = fx * fx * (3 - 2 * fx)
      fy = fy * fy * (3 - 2 * fy)
      const v = (h(x0, y0) * (1 - fx) + h(x0 + 1, y0) * fx) * (1 - fy) + (h(x0, y0 + 1) * (1 - fx) + h(x0 + 1, y0 + 1) * fx) * fy
      const o = (y * size + x) * 4
      img.data[o] = rgb[0]
      img.data[o + 1] = rgb[1]
      img.data[o + 2] = rgb[2]
      img.data[o + 3] = Math.max(0, v - 0.45) * 2 * alpha * 255
    }
  }
  g.putImageData(img, 0, 0)
  return c
}

/**
 * 不含地图注记的纸图：注记插在 cut 处（地图叠加层之后、图框之前）。
 * 区域改动只影响注记，按它重录注记即可（见 withLabels），底图与图框的指令原样共用
 */
export interface AtlasBase {
  list: DisplayList
  cut: number
  reserved: Reserved[]
  theme: StyleId
  S: number
  world: World
  opts: AtlasOpts
  measurer: CanvasRenderingContext2D
}

/**
 * 构建矢量纸图的显示列表：底色、色带、晕渲分级、等值线由格点场追踪成路径，
 * 河流、符号、注记、罗盘、图框复用位图渲染的绘制代码（经 Recorder 录制）。
 */
export async function buildAtlasVector(world: World, rivers: SmoothRiver[], id: StyleId, opts: AtlasOpts, measurer: CanvasRenderingContext2D, S = 2): Promise<DisplayList> {
  return withLabels(await buildAtlasBase(world, rivers, id, opts, measurer, S), opts.areas)
}

/** 不含地图注记的部分（见 AtlasBase） */
export async function buildAtlasBase(world: World, rivers: SmoothRiver[], id: StyleId, opts: AtlasOpts, measurer: CanvasRenderingContext2D, S = 2): Promise<AtlasBase> {
  const theme = themeById(id)
  // 风格的矢量画法用到时才载入
  const draw = await theme.vector()
  const f = fieldsFor(world, S)
  theme.prepare?.(f)
  const { MW, MH, W, H } = f
  const k = S / 2
  const M = marginOf(theme, S)
  const list = new DisplayList(MW + M * 2, MH + M * 2, M, MW, MH)
  list.labelK = atlasLabelK(S)
  const extraCss = currentFontPreset().css
  const imports = [FONT_CSS, ...(extraCss ? [`https://fonts.googleapis.com/css2?${extraCss}&display=swap`] : [])]
  list.head = `<title>${world.worldName}</title><style>${imports.map((u) => `@import url('${u.replace(/&/g, '&amp;')}');`).join('')}</style>`
  // 纸底
  list.path('page', `M0 0L${list.width} 0L${list.width} ${list.height}L0 ${list.height}Z`, { fill: { color: rgb(theme.paper), alpha: 1 } })

  const F = fieldsOf(world)
  const L = new Layers(list, W, H, S)
  // 政区专题风格的晕渲、湖泊与海岸线要压在政区色块之上：底图先画到色块为止，其余在着色之后
  // 风格自己的矢量底图；返回的函数留到政区着色之后再执行
  const after = draw(L, world, F, { opts, S })

  if (opts.political && world.political) politicalFill(L, world, F, opts.political, theme.political)
  after?.()

  // 纸纹：两张可平铺的小噪声图做图案；做旧的风格（Theme.aged）水渍偏褐、四角另有焦边
  const brown = !!theme.aged
  const blot = noiseTile(128, 16, brown ? [140, 100, 60] : [120, 110, 95], 0.55, 11)
  const grain = noiseTile(128, 1.5, [80, 70, 60], 0.35, 7)
  list.patterns.set('blotP', {
    w: 1024 * k,
    h: 1024 * k,
    svg: `<image href="${blot.toDataURL('image/png')}" width="${1024 * k}" height="${1024 * k}" preserveAspectRatio="none"/>`,
    tile: () => blot,
  })
  list.patterns.set('grainP', {
    w: 128 * k,
    h: 128 * k,
    svg: `<image href="${grain.toDataURL('image/png')}" width="${128 * k}" height="${128 * k}"/>`,
    tile: () => grain,
  })
  const mapRect = `M0 0L${MW} 0L${MW} ${MH}L0 ${MH}Z`
  if (theme.paperTexture !== false) {
    list.path('map', mapRect, { fill: { pattern: 'blotP', alpha: 1 }, opacity: brown ? 0.5 : 0.45 })
    list.path('map', mapRect, { fill: { pattern: 'grainP', alpha: 1 }, opacity: brown ? 0.5 : 0.3 })
  }
  list.filters.set(
    'brush',
    `<filter id="brush" x="-2%" y="-2%" width="104%" height="104%"><feTurbulence type="fractalNoise" baseFrequency="${(0.35 / k).toFixed(3)}" numOctaves="2" seed="5"/><feDisplacementMap in="SourceGraphic" scale="${2.6 * k}"/></filter>`,
  )
  if (brown) {
    list.gradients.set('burn', {
      svg: `<radialGradient id="burn" cx="50%" cy="50%" r="72%"><stop offset="70%" stop-color="rgb(120,82,45)" stop-opacity="0"/><stop offset="100%" stop-color="rgb(120,82,45)" stop-opacity="0.6"/></radialGradient>`,
      make: (ctx) => {
        const g = ctx.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.72)
        g.addColorStop(0.7, 'rgba(120,82,45,0)')
        g.addColorStop(1, 'rgba(120,82,45,0.6)')
        return g
      },
    })
    list.path('map', mapRect, { fill: { gradient: 'burn', alpha: 1 } })
  }

  const rec = new Recorder(list, measurer)
  rec.space = 'map'
  const reserved = drawMapOverlays(rec as unknown as CanvasRenderingContext2D, f, theme, rivers, opts, (on) => (list.furniture = on))
  const cut = list.segments.length
  rec.space = 'page'
  drawFrame(rec as unknown as CanvasRenderingContext2D, world, theme, S, M, MW, MH)
  return { list, cut, reserved, theme: id, S, world, opts, measurer }
}

/**
 * 在底图上按 areas 录入地图注记，得到完整的显示列表（新实例：查看器的注记分组等缓存随之作废）。
 * 底图的段与指令共用、不改动：注记可能并进的最后一段连同末条指令先复制
 */
export function withLabels(base: AtlasBase, areas: AtlasOpts['areas']): DisplayList {
  const { list: src, cut } = base
  if (!base.opts.labels) return src
  const list = new DisplayList(src.width, src.height, src.M, src.MW, src.MH)
  list.labelK = src.labelK
  list.head = src.head
  list.clips = new Map(src.clips)
  list.patterns = new Map(src.patterns)
  list.gradients = new Map(src.gradients)
  list.filters = new Map(src.filters)
  const pre = src.segments.slice(0, cut)
  const last = pre[cut - 1]
  if (last) {
    const items = last.items.slice()
    const tail = items[items.length - 1]
    if (tail) items[items.length - 1] = tail.k === 'path' ? { ...tail, bbox: [...tail.bbox] } : { ...tail }
    pre[cut - 1] = { ...last, items } as Segment
  }
  list.segments = pre
  const rec = new Recorder(list, base.measurer)
  rec.space = 'map'
  const theme = themeById(base.theme)
  drawMapLabels(rec as unknown as CanvasRenderingContext2D, fieldsFor(base.world, base.S), theme, areas, base.reserved, base.opts.political)
  list.segments.push(...src.segments.slice(cut))
  return list
}

export async function renderAtlasSvg(world: World, rivers: SmoothRiver[], id: StyleId, opts: AtlasOpts, measurer: CanvasRenderingContext2D, S = 2): Promise<string> {
  return (await buildAtlasVector(world, rivers, id, opts, measurer, S)).toSVG()
}
