import { Biome, type World } from '../../../gen/types'
import { blur } from '../../../gen/util'
import { ATLAS, atlasSea, ramp, type RGB } from '../../palette'
import type { SmoothRiver } from '../../rivers'
import { drawFrame } from '../furniture'
import { drawOverlays, fieldsFor, marginOf } from '../index'
import { HYPSO_STOPS, REALM_COLORS, themeById, type AtlasOpts, type StyleId, type Theme } from '../styles'
import { categoryBorders, contours, pathData } from './contour'
import { SvgContext } from './recorder'

const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=IM+Fell+English:ital@0;1&family=IM+Fell+English+SC&family=Ma+Shan+Zheng&family=Noto+Serif+SC:wght@400;600&family=Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400&display=swap'

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const rgb = (c: RGB) => `rgb(${c.map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(',')})`
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

const FOREST = new Set<number>([Biome.Taiga, Biome.TemperateForest, Biome.TemperateRainforest, Biome.TropicalRainforest, Biome.TropicalSeasonalForest])

/** 以格为单位的矢量图层构建器 */
class Layers {
  parts: string[] = []
  constructor(
    readonly W: number,
    readonly H: number,
    readonly S: number,
  ) {}

  /** 填充"场 ≥ level"的区域 */
  fill(field: ArrayLike<number>, level: number, color: string, opacity = 1, extra = '', tol = 0.35, minArea = 1.5) {
    const d = pathData(contours(field, this.W, this.H, level, true), this.S, { closed: true, tol, minArea })
    if (d) this.parts.push(`<path d="${d}" fill="${color}" fill-rule="evenodd"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}${extra}/>`)
    return d
  }

  /** 等值线 */
  line(field: ArrayLike<number>, level: number, color: string, width: number, opacity = 1, dash = '', extra = '', tol = 0.35) {
    const d = pathData(contours(field, this.W, this.H, level, false), this.S, { closed: true, tol, minArea: 0.8 })
    if (!d) return
    this.parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${opacity < 1 ? ` stroke-opacity="${opacity}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}${extra}/>`,
    )
  }

  raw(s: string) {
    this.parts.push(s)
  }
}

/** 预计算的格点场 */
function fieldsOf(world: World) {
  const { W, H, elevation: e, biome, temperature: T, kmPerCell: km } = world
  const N = W * H
  const land = new Float32Array(N)
  const depth = new Float32Array(N)
  const lake = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    land[i] = e[i]
    depth[i] = -e[i]
    lake[i] = biome[i] === Biome.Lake ? 1 : 0
  }
  // 多方向晕渲（格尺度），只在陆地上
  const shade = new Float32Array(N).fill(1)
  const zf = 14
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (e[i] <= 0) continue
      const nx = (-(Math.max(0, e[i + 1]) - Math.max(0, e[i - 1])) / (2 * km)) * zf
      const ny = (-(Math.max(0, e[i + W]) - Math.max(0, e[i - W])) / (2 * km)) * zf
      const inv = 1 / Math.hypot(nx, ny, 1)
      const l1 = ((nx * -0.6 + ny * -0.6 + 0.53) * inv) / 0.53
      const l2 = ((nx * -0.85 + ny * 0.1 + 0.52) * inv) / 0.52
      const l3 = ((nx * -0.1 + ny * -0.85 + 0.52) * inv) / 0.52
      shade[i] = Math.min(1.12, Math.max(0.38, l1 * 0.6 + l2 * 0.2 + l3 * 0.2))
    }
  }
  blur(shade, W, H, 1, 1)
  // 陆地外设为中性，避免海岸出现假晕渲
  const dark = new Float32Array(N)
  const light = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    dark[i] = e[i] > 0 ? 1 - shade[i] : -1
    light[i] = e[i] > 0 ? shade[i] - 1 : -1
  }
  // 海冰：海面且足够冷
  const ice = new Float32Array(N)
  for (let i = 0; i < N; i++) ice[i] = e[i] <= 0 ? -T[i] - 8 : -1
  const snow = new Float32Array(N)
  for (let i = 0; i < N; i++) snow[i] = e[i] > 0 ? -T[i] - 6 : -1
  blur(lake, W, H, 1, 1)
  return { land, depth, lake, dark, light, ice, snow }
}

/** 群系指示场（羽化） */
function biomeField(world: World, pred: (b: number) => boolean) {
  const { W, H, biome, elevation: e } = world
  const f = new Float32Array(W * H)
  for (let i = 0; i < f.length; i++) f[i] = e[i] > 0 && pred(biome[i]) ? 1 : 0
  blur(f, W, H, 1, 1)
  return f
}

function biomeLayers(L: Layers, world: World, palette: Record<number, RGB>, opacity: number, transform?: (c: RGB) => RGB) {
  const counts = new Map<number, number>()
  for (let i = 0; i < world.biome.length; i++) {
    const b = world.biome[i]
    if (world.elevation[i] > 0 && b !== Biome.Lake) counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  const order = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => b)
  for (const b of order) {
    const c = transform ? transform(palette[b]) : palette[b]
    L.fill(biomeField(world, (x) => x === b), 0.5, rgb(c), opacity, '', 0.4, 3)
  }
}

function hillshade(L: Layers, F: ReturnType<typeof fieldsOf>, ink: string, darkOp: number, lightOp: number, extra = '') {
  for (const t of [0.07, 0.16, 0.26, 0.38, 0.5]) L.fill(F.dark, t, ink, darkOp, extra, 0.45, 2.5)
  if (lightOp > 0) for (const t of [0.04, 0.08]) L.fill(F.light, t, '#ffffff', lightOp, extra, 0.45, 2.5)
}

function ripples(L: Layers, world: World, dists: number[], color: string, opacities: number[], width: number) {
  const cd = world.coastDist
  dists.forEach((d, k) => L.line(cd, -d, color, width, opacities[k]))
}

// —————————————————————————— 各风格的矢量底图 ——————————————————————————

function physical(L: Layers, world: World, F: ReturnType<typeof fieldsOf>, opts: AtlasOpts) {
  const S = L.S
  L.raw(`<rect x="-10" y="-10" width="${L.W * S + 20}" height="${L.H * S + 20}" fill="${rgb(atlasSea(0.1))}"/>`)
  const levels = [0.2, 1, 2, 3.2, 4.2]
  for (const lv of levels) L.fill(F.depth, lv, rgb(atlasSea(lv + 0.3)))
  for (const lv of levels) L.line(F.depth, lv, 'rgb(88,106,120)', 0.8, 0.16)
  L.fill(F.ice, 0, 'rgb(236,240,239)')
  ripples(L, world, [2.25, 4.75, 8, 12.5], 'rgb(70,104,120)', [0.34, 0.22, 0.13, 0.07], 0.75)
  L.fill(F.land, 0, rgb(ATLAS[Biome.Grassland]))
  biomeLayers(L, world, ATLAS, 1)
  for (const [lv, op] of [[1.5, 0.15], [2.5, 0.18], [3.5, 0.2]] as const) L.fill(F.land, lv, 'rgb(216,204,186)', op)
  hillshade(L, F, 'rgb(45,38,30)', 0.11, 0.1)
  if (opts.contours) for (let lv = 0.5; lv < 9; lv += 0.5) L.line(F.land, lv, 'rgb(120,96,70)', 0.8, lv % 1 === 0 ? 0.22 : 0.12)
  L.fill(F.lake, 0.5, rgb(ATLAS[Biome.Lake]), 1, ' stroke="rgb(78,106,130)" stroke-width="0.9" stroke-opacity="0.8"')
  L.line(F.land, 0, 'rgb(58,66,70)', 1.7, 0.92)
}

function fantasy(L: Layers, world: World, F: ReturnType<typeof fieldsOf>) {
  const S = L.S
  const PARCH = hex('#e6d3a7')
  const SEA = hex('#c9c7a4')
  const SEPIA = 'rgb(74,54,36)'
  L.raw(`<rect x="-10" y="-10" width="${L.W * S + 20}" height="${L.H * S + 20}" fill="${rgb(mixRGB(PARCH, SEA, 0.35))}"/>`)
  for (const d of [30, 18, 10, 5]) L.fill(world.coastDist, -d, rgb(SEA), 0.2)
  L.fill(F.ice, 0, 'rgb(240,232,210)')
  ripples(L, world, [2, 4, 6.5, 9.5, 13.5], SEPIA, [0.4, 0.33, 0.26, 0.19, 0.12], 0.9)
  L.fill(F.land, 0, rgb(hex('#ecdcb5')))
  biomeLayers(L, world, ATLAS, 0.22)
  hillshade(L, F, SEPIA, 0.05, 0.08)
  L.fill(F.lake, 0.5, 'rgb(205,200,170)', 1, ` stroke="${SEPIA}" stroke-width="1.4"`)
  L.line(F.land, 0, SEPIA, 2.5, 0.95)
}

function nautical(L: Layers, world: World, F: ReturnType<typeof fieldsOf>) {
  const S = L.S
  const N = world.W * world.H
  L.raw(`<rect x="-10" y="-10" width="${L.W * S + 20}" height="${L.H * S + 20}" fill="rgb(244,241,232)"/>`)
  // 浅海分层：越浅越蓝
  const shallow = new Float32Array(N)
  for (let i = 0; i < N; i++) shallow[i] = world.elevation[i] <= 0 ? world.elevation[i] : -9
  for (const [lv, c] of [[-0.2, '#e3eff2'], [-0.05, '#cde4ee'], [-0.02, '#b3d6e6'], [-0.01, '#9fcbe0']] as const) L.fill(shallow, lv, c)
  for (const lv of [0.01, 0.02]) L.line(F.depth, lv, 'rgb(60,120,170)', 0.7, 0.55, '4 4')
  for (const lv of [0.05, 0.2, 1]) L.line(F.depth, lv, 'rgb(60,120,170)', 0.8, 0.5)
  L.fill(F.ice, 0, 'rgb(250,250,250)')
  L.fill(F.land, 0, 'rgb(235,220,180)')
  // 海岸内侧加深的色带
  const band = new Float32Array(N)
  for (let i = 0; i < N; i++) band[i] = world.elevation[i] > 0 ? -world.coastDist[i] : -99
  for (const d of [3, 1.5]) L.fill(band, -d, 'rgb(214,190,140)', 0.35)
  hillshade(L, F, 'rgb(60,50,40)', 0.06, 0.06)
  L.fill(F.lake, 0.5, '#c7e0ea', 1, ' stroke="rgb(40,60,80)" stroke-width="0.9"')
  L.line(F.land, 0, 'rgb(30,30,30)', 1.9, 0.92)
}

function political(L: Layers, world: World, F: ReturnType<typeof fieldsOf>, S: number) {
  const { W, H } = world
  const N = W * H
  const k = S / 2
  L.raw(`<rect x="-10" y="-10" width="${W * S + 20}" height="${H * S + 20}" fill="#cfe0e4"/>`)
  for (const d of [30, 15, 6]) L.fill(world.coastDist, -d, 'rgb(170,200,210)', 0.2)
  L.fill(F.ice, 0, 'rgb(244,246,246)')
  ripples(L, world, [2.5, 5.5], 'rgb(90,130,150)', [0.18, 0.18], 0.7)
  L.fill(F.land, 0, 'rgb(243,238,226)')
  const paper: RGB = [243, 238, 226]
  world.realms.forEach((r, id) => {
    const ind = new Float32Array(N)
    for (let i = 0; i < N; i++) ind[i] = world.realm[i] === id ? 1 : 0
    blur(ind, W, H, 1, 1)
    const c = REALM_COLORS[r.color]
    const d = L.fill(ind, 0.5, rgb(mixRGB(paper, c, 0.62)), 1, '', 0.4, 2)
    if (d) {
      // 国界内侧晕边：以本国轮廓为裁剪，描一条宽边
      L.raw(
        `<clipPath id="rc${id}"><path d="${d}" clip-rule="evenodd"/></clipPath><path d="${d}" fill="none" stroke="${rgb(mixRGB(paper, [c[0] * 0.78, c[1] * 0.78, c[2] * 0.78], 0.9))}" stroke-width="${14 * k}" stroke-opacity="0.55" clip-path="url(#rc${id})"/>`,
      )
    }
  })
  hillshade(L, F, 'rgb(40,35,30)', 0.05, 0.05)
  // 国界：相邻两国格子的公共边串成折线，简化后平滑，止于海岸
  const borders = categoryBorders(world.realm, W, H)
  const bd = pathData(borders, S, { closed: false, tol: 0.75 })
  if (bd) L.raw(`<path d="${bd}" fill="none" stroke="rgb(120,50,55)" stroke-width="1.5" stroke-opacity="0.85" stroke-linecap="round" stroke-dasharray="${6 * k} ${3 * k} ${1.5 * k} ${3 * k}"/>`)
  L.fill(F.lake, 0.5, '#cfe0e4', 1, ' stroke="rgb(70,100,120)" stroke-width="0.9"')
  L.line(F.land, 0, 'rgb(60,70,76)', 1.6, 0.92)
}

function ink(L: Layers, world: World, F: ReturnType<typeof fieldsOf>, S: number) {
  const { W, H } = world
  const k = S / 2
  const RICE = hex('#ede6d3')
  const INK = 'rgb(43,42,39)'
  L.raw(`<rect x="-10" y="-10" width="${W * S + 20}" height="${H * S + 20}" fill="${rgb(RICE)}"/>`)
  // 鱼鳞水波：图案填满海面
  L.raw(
    `<pattern id="waves" width="${36 * k}" height="${9 * k}" patternUnits="userSpaceOnUse"><path d="M0 ${4.5 * k} Q${9 * k} ${1.5 * k} ${18 * k} ${4.5 * k} T${36 * k} ${4.5 * k}" fill="none" stroke="rgb(110,120,120)" stroke-width="${0.7 * k}" stroke-opacity="0.18"/></pattern>`,
  )
  L.fill(F.depth, 0, 'url(#waves)')
  for (const d of [16, 8, 3]) L.fill(world.coastDist, -d, 'rgb(150,160,158)', 0.1)
  L.fill(F.ice, 0, 'rgb(245,243,236)')
  L.fill(F.land, 0, rgb(RICE))
  const tint: Record<number, RGB> = {}
  for (let b = 0; b <= 17; b++) tint[b] = RICE
  for (const b of FOREST) tint[b] = hex('#a9b89c')
  tint[Biome.Grassland] = hex('#cfcfab')
  tint[Biome.Savanna] = hex('#d6caa0')
  tint[Biome.HotDesert] = hex('#dcc79e')
  tint[Biome.ColdDesert] = hex('#d5c8ab')
  tint[Biome.Shrubland] = hex('#d2c7a3')
  tint[Biome.Wetland] = hex('#b7c1ad')
  biomeLayers(L, world, tint, 0.42)
  for (const lv of [1.8, 2.8]) L.fill(F.land, lv, 'rgb(110,140,138)', 0.14)
  // 皴擦：分级墨色 + 湍流位移，让边缘像干笔
  for (const lv of [1.5, 2.5, 3.5]) L.fill(F.land, lv, INK, 0.05, ' filter="url(#brush)"')
  hillshade(L, F, INK, 0.13, 0, ' filter="url(#brush)"')
  L.fill(F.snow, 0, rgb(RICE), 0.6)
  L.fill(F.lake, 0.5, 'rgb(218,216,204)', 1, ` stroke="${INK}" stroke-width="1.1"`)
  L.line(F.land, 0, INK, 2.2, 0.9, '', ' filter="url(#brush)"')
}

function topo(L: Layers, world: World, F: ReturnType<typeof fieldsOf>) {
  const S = L.S
  L.raw(`<rect x="-10" y="-10" width="${L.W * S + 20}" height="${L.H * S + 20}" fill="#d6e8ef"/>`)
  for (const lv of [0.2, 1, 2, 3, 4]) L.line(F.depth, lv, 'rgb(80,140,185)', 0.8, 0.45)
  L.fill(F.ice, 0, 'rgb(248,250,252)')
  L.fill(F.land, 0, rgb(ramp(HYPSO_STOPS, 0.1)))
  for (let lv = 0.25; lv < 6.5; lv += 0.25) L.fill(F.land, lv, rgb(ramp(HYPSO_STOPS, lv + 0.12)), 1, '', 0.4, 2)
  L.fill(biomeField(world, (b) => FOREST.has(b)), 0.5, 'rgb(196,222,180)', 0.7, '', 0.4, 3)
  L.fill(F.snow, 1, 'rgb(248,250,252)')
  hillshade(L, F, 'rgb(40,40,40)', 0.07, 0.1)
  for (let lv = 0.1; lv < 9; lv += 0.1) {
    const major = Math.abs(lv / 0.5 - Math.round(lv / 0.5)) < 1e-6
    L.line(F.land, lv, 'rgb(165,105,60)', major ? 1.1 : 0.55, major ? 0.7 : 0.38, '', '', 0.45)
  }
  L.fill(F.lake, 0.5, '#cfe4ee', 1, ' stroke="rgb(60,120,170)" stroke-width="0.9"')
  L.line(F.land, 0, 'rgb(50,110,160)', 1.4, 0.95)
}

/** 纸张纹理与做旧（SVG 滤镜，缩放不失真） */
function paperDefs(theme: Theme, k: number) {
  const brown = theme.id === 'fantasy'
  return (
    `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${(0.9 / k).toFixed(3)}" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.3  0 0 0 0 0.24  0 0 0 -0.9 0.62"/></filter>` +
    `<filter id="blot" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${(0.006 / k).toFixed(4)}" numOctaves="3" seed="11"/><feColorMatrix values="0 0 0 0 ${brown ? 0.55 : 0.4}  0 0 0 0 ${brown ? 0.42 : 0.38}  0 0 0 0 ${brown ? 0.25 : 0.34}  0 0 0 -2.2 1.25"/></filter>` +
    `<filter id="brush" x="-2%" y="-2%" width="104%" height="104%"><feTurbulence type="fractalNoise" baseFrequency="${(0.35 / k).toFixed(3)}" numOctaves="2" seed="5"/><feDisplacementMap in="SourceGraphic" scale="${2.6 * k}"/></filter>` +
    `<radialGradient id="burn" cx="50%" cy="50%" r="72%"><stop offset="70%" stop-color="rgb(120,82,45)" stop-opacity="0"/><stop offset="100%" stop-color="rgb(120,82,45)" stop-opacity="0.6"/></radialGradient>`
  )
}

/**
 * 矢量纸图：底色、色带、晕渲分级、等值线全部由格点场追踪成路径，
 * 河流、符号、注记、罗盘、图框复用位图渲染的绘制代码（经 SvgContext 录制）。
 */
export function renderAtlasSvg(world: World, rivers: SmoothRiver[], id: StyleId, opts: AtlasOpts, measurer: CanvasRenderingContext2D, S = 2): string {
  const theme = themeById(id)
  const f = fieldsFor(world, S)
  theme.prepare?.(f)
  const { MW, MH, W, H } = f
  const k = S / 2
  const M = marginOf(theme, S)
  const width = MW + M * 2
  const height = MH + M * 2
  const F = fieldsOf(world)
  const L = new Layers(W, H, S)
  switch (theme.id) {
    case 'physical':
      physical(L, world, F, opts)
      break
    case 'fantasy':
      fantasy(L, world, F)
      break
    case 'nautical':
      nautical(L, world, F)
      break
    case 'political':
      political(L, world, F, S)
      break
    case 'ink':
      ink(L, world, F, S)
      break
    case 'topo':
      topo(L, world, F)
      break
  }

  const ctx = new SvgContext(measurer)
  ctx.def(paperDefs(theme, k))
  ctx.def(`<clipPath id="map"><rect x="0" y="0" width="${MW}" height="${MH}"/></clipPath>`)
  ctx.raw(`<rect width="${width}" height="${height}" fill="${rgb(theme.paper)}"/>`)
  ctx.raw(`<g transform="translate(${M} ${M})" clip-path="url(#map)">`)
  ctx.raw(`<g id="base">${L.parts.join('\n')}</g>`)
  // 纸张质感
  ctx.raw(`<rect width="${MW}" height="${MH}" filter="url(#blot)" opacity="${theme.id === 'fantasy' ? 0.5 : 0.25}"/>`)
  ctx.raw(`<rect width="${MW}" height="${MH}" filter="url(#grain)" opacity="${theme.id === 'fantasy' ? 0.35 : 0.2}"/>`)
  if (theme.id === 'fantasy') ctx.raw(`<rect width="${MW}" height="${MH}" fill="url(#burn)"/>`)
  ctx.raw(`<g id="overlays">`)
  drawOverlays(ctx as unknown as CanvasRenderingContext2D, f, theme, rivers, opts)
  ctx.raw(`</g></g>`)
  drawFrame(ctx as unknown as CanvasRenderingContext2D, world, theme, S, M, MW, MH)
  const head = `<title>${world.worldName}</title><style>@import url('${FONT_CSS.replace(/&/g, '&amp;')}');</style>`
  return ctx.toString(width, height, head)
}
