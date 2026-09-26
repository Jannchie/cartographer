import { Biome, type World } from '../../../gen/types'
import { blur } from '../../../gen/util'
import { ATLAS, atlasSea, ramp, type RGB } from '../../palette'
import type { SmoothRiver } from '../../rivers'
import { drawFrame } from '../furniture'
import { drawOverlays, fieldsFor, marginOf } from '../index'
import { FANTASY_COLORS, FANTASY_TINT, HYPSO_STOPS, TEYVAT, TEYVAT_STEP, TEYVAT_TINT, teyvatReach, themeById, type AtlasOpts, type StyleId } from '../styles'
import { contours, pathData } from './contour'
import { DisplayList, type Fill, type Stroke } from './displayList'
import { Recorder } from './recorder'

const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=IM+Fell+English:ital@0;1&family=IM+Fell+English+SC&family=Ma+Shan+Zheng&family=Noto+Serif+SC:wght@400;600&family=Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400&display=swap'

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const rgb = (c: RGB) => `rgb(${c.map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(',')})`

const FOREST = new Set<number>([Biome.Taiga, Biome.TemperateForest, Biome.TemperateRainforest, Biome.TropicalRainforest, Biome.TropicalSeasonalForest])

interface LayerOpt {
  stroke?: Stroke
  filter?: string
  clip?: string
  tol?: number
  minArea?: number
}

/** 颜色或 url(#图案) → 填充 */
function toFill(color: string, alpha: number): Fill {
  return color.startsWith('url(') ? { pattern: color.slice(5, -1), alpha, rule: 'evenodd' } : { color, alpha, rule: 'evenodd' }
}

/** 以格为单位的矢量图层构建器：追踪出的路径直接写进显示列表（地图坐标空间） */
class Layers {
  constructor(
    readonly list: DisplayList,
    readonly W: number,
    readonly H: number,
    readonly S: number,
  ) {}

  /** 填充"场 ≥ level"的区域 */
  fill(field: ArrayLike<number>, level: number, color: string, opacity = 1, o: LayerOpt = {}) {
    const d = pathData(contours(field, this.W, this.H, level, true), this.S, { closed: true, tol: o.tol ?? 0.35, minArea: o.minArea ?? 1.5 })
    this.list.path('map', d, { fill: toFill(color, opacity), stroke: o.stroke, filter: o.filter, clip: o.clip })
    return d
  }

  /** 等值线 */
  line(field: ArrayLike<number>, level: number, color: string, width: number, opacity = 1, dash?: number[], o: LayerOpt = {}) {
    const d = pathData(contours(field, this.W, this.H, level, false), this.S, { closed: true, tol: o.tol ?? 0.35, minArea: 0.8 })
    this.list.path('map', d, { stroke: { color, alpha: opacity, width, dash, cap: 'round', join: 'round' }, filter: o.filter })
  }

  /** 整个地图框的矩形 */
  rect(color: string, opacity = 1) {
    const w = this.W * this.S
    const h = this.H * this.S
    this.list.path('map', `M-10 -10L${w + 10} -10L${w + 10} ${h + 10}L-10 ${h + 10}Z`, { fill: toFill(color, opacity) })
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
    L.fill(biomeField(world, (x) => x === b), 0.5, rgb(c), opacity, { tol: 0.4, minArea: 3 })
  }
}

function hillshade(L: Layers, F: ReturnType<typeof fieldsOf>, ink: string, darkOp: number, lightOp: number, o: LayerOpt = {}) {
  for (const t of [0.07, 0.16, 0.26, 0.38, 0.5]) L.fill(F.dark, t, ink, darkOp, { ...o, tol: 0.45, minArea: 2.5 })
  if (lightOp > 0) for (const t of [0.04, 0.08]) L.fill(F.light, t, '#ffffff', lightOp, { ...o, tol: 0.45, minArea: 2.5 })
}

function ripples(L: Layers, world: World, dists: number[], color: string, opacities: number[], width: number) {
  const cd = world.coastDist
  dists.forEach((d, k) => L.line(cd, -d, color, width, opacities[k]))
}

// —————————————————————————— 各风格的矢量底图 ——————————————————————————

function physical(L: Layers, world: World, F: ReturnType<typeof fieldsOf>, opts: AtlasOpts) {
  L.rect(rgb(atlasSea(0.1)))
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
  L.fill(F.lake, 0.5, rgb(ATLAS[Biome.Lake]), 1, { stroke: { color: 'rgb(78,106,130)', width: 0.9, alpha: 0.8 } })
  L.line(F.land, 0, 'rgb(58,66,70)', 1.7, 0.92)
}

function fantasy(L: Layers, world: World, F: ReturnType<typeof fieldsOf>) {
  const C = FANTASY_COLORS
  const SEPIA = rgb(C.sepia)
  const N = world.W * world.H
  // 海：近纸色，近岸几层铜绿水彩叠出由浓到淡的晕
  L.rect(rgb(C.sea))
  for (const [d, a] of [[60, 0.05], [34, 0.1], [20, 0.14], [11, 0.16], [5, 0.16]] as const) L.fill(world.coastDist, -d, rgb(C.seaWash), a)
  L.fill(F.ice, 0, 'rgb(240,232,210)')
  ripples(L, world, [1.75, 3.5, 5.5, 8, 11], SEPIA, [0.36, 0.3, 0.23, 0.16, 0.1], 0.75)
  // 陆：群系淡彩 + 高地棕晕 + 沿岸赭石色带
  L.fill(F.land, 0, rgb(hex('#ecdcb3')))
  biomeLayers(L, world, FANTASY_TINT, 0.6)
  for (const lv of [1.3, 2.3]) L.fill(F.land, lv, rgb(C.mountainWash), 0.07)
  const band = new Float32Array(N)
  for (let i = 0; i < N; i++) band[i] = world.elevation[i] > 0 ? -world.coastDist[i] : -99
  for (const d of [4, 2.5, 1.2]) L.fill(band, -d, rgb(C.coastWash), 0.14)
  hillshade(L, F, SEPIA, 0.045, 0.07)
  L.fill(F.lake, 0.5, rgb(C.lake), 1, { stroke: { color: SEPIA, width: 1.4, alpha: 1 } })
  L.line(F.land, 0, SEPIA, 2.6, 0.95)
}

function nautical(L: Layers, world: World, F: ReturnType<typeof fieldsOf>) {
  const N = world.W * world.H
  L.rect('rgb(244,241,232)')
  // 浅海分层：越浅越蓝
  const shallow = new Float32Array(N)
  for (let i = 0; i < N; i++) shallow[i] = world.elevation[i] <= 0 ? world.elevation[i] : -9
  for (const [lv, c] of [[-0.2, '#e3eff2'], [-0.05, '#cde4ee'], [-0.02, '#b3d6e6'], [-0.01, '#9fcbe0']] as const) L.fill(shallow, lv, c)
  for (const lv of [0.01, 0.02]) L.line(F.depth, lv, 'rgb(60,120,170)', 0.7, 0.55, [4, 4])
  for (const lv of [0.05, 0.2, 1]) L.line(F.depth, lv, 'rgb(60,120,170)', 0.8, 0.5)
  L.fill(F.ice, 0, 'rgb(250,250,250)')
  L.fill(F.land, 0, 'rgb(235,220,180)')
  // 海岸内侧加深的色带
  const band = new Float32Array(N)
  for (let i = 0; i < N; i++) band[i] = world.elevation[i] > 0 ? -world.coastDist[i] : -99
  for (const d of [3, 1.5]) L.fill(band, -d, 'rgb(214,190,140)', 0.35)
  hillshade(L, F, 'rgb(60,50,40)', 0.06, 0.06)
  L.fill(F.lake, 0.5, '#c7e0ea', 1, { stroke: { color: 'rgb(40,60,80)', width: 0.9, alpha: 1 } })
  L.line(F.land, 0, 'rgb(30,30,30)', 1.9, 0.92)
}

function teyvat(L: Layers, world: World, F: ReturnType<typeof fieldsOf>, S: number) {
  const C = TEYVAT
  const N = world.W * world.H
  const cd = world.coastDist
  // 虚空 → 探索区域（圆润的一整团，外侧泛青色辉光）→ 近岸渐亮的青绿水
  const reach = teyvatReach(world)
  const inner = new Float32Array(N)
  for (let i = 0; i < N; i++) inner[i] = -reach[i]
  // 虚空里零星的星点：可平铺的小图案
  const k = S / 2
  const T = 180 * k
  const stars = Array.from({ length: 14 }, (_, i) => [((i * 97 + 31) % 180) * k, ((i * 61 + 17) % 180) * k, (0.4 + ((i * 7) % 5) * 0.15) * k])
  L.list.patterns.set('stars', {
    w: T,
    h: T,
    svg: stars.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${rgb(C.star)}" fill-opacity="0.55"/>`).join(''),
    tile: () => {
      const c = document.createElement('canvas')
      c.width = c.height = Math.round(T * 2)
      const g = c.getContext('2d')!
      g.scale(2, 2)
      g.fillStyle = rgb(C.star)
      g.globalAlpha = 0.55
      for (const [x, y, r] of stars) {
        g.beginPath()
        g.arc(x, y, r, 0, Math.PI * 2)
        g.fill()
      }
      return c
    },
  })
  L.rect('url(#stars)')
  for (const [d, a] of [[6, 0.1], [3, 0.16]] as const) L.fill(inner, -d, rgb(C.sea), a, { tol: 0.6, minArea: 4 })
  // 边界亮线复用这一层追踪出的轮廓
  const region = L.fill(inner, 0, rgb(C.deep), 1, { tol: 0.6, minArea: 4 })
  for (const d of [18, 13, 9, 6]) L.fill(cd, -d, rgb(C.sea), 0.22)
  for (const d of [4, 2.5, 1.5]) L.fill(cd, -d, rgb(C.shallow), 0.22)
  L.fill(F.ice, 0, rgb(C.ice))
  L.list.path('map', region, { stroke: { color: rgb(C.edge), alpha: 0.9, width: 1.6, cap: 'round', join: 'round' } })
  // 陆：群系平涂 + 台地（越高越偏土黄）+ 崖线
  L.fill(F.land, 0, rgb(TEYVAT_TINT[Biome.Grassland]))
  biomeLayers(L, world, TEYVAT_TINT, 1)
  for (let lv = TEYVAT_STEP; lv < 2.6; lv += TEYVAT_STEP) L.fill(F.land, lv, rgb(C.plateau), 0.05, { tol: 0.45, minArea: 2 })
  L.fill(F.land, 2.9, rgb(C.rock), 0.7)
  L.fill(F.snow, 0.5, rgb(C.snow))
  // 卡通分层的明暗
  L.fill(F.dark, 0.08, rgb(C.toonDark), 0.1, { tol: 0.5, minArea: 3 })
  L.fill(F.dark, 0.2, rgb(C.toonDark), 0.12, { tol: 0.5, minArea: 3 })
  L.fill(F.light, 0.04, rgb(C.toonLight), 0.08, { tol: 0.5, minArea: 3 })
  // 崖线：只有陡处的台地边缘明显（坡度调制透明度在矢量里做不到，改用较淡的线 + 只画较高的台阶）
  for (let lv = TEYVAT_STEP * 2; lv < 4; lv += TEYVAT_STEP) L.line(F.land, lv, rgb(C.cliff), 1, 0.35, undefined, { tol: 0.45 })
  L.fill(F.lake, 0.5, rgb(C.lake), 1, { stroke: { color: rgb(C.coast), width: 0.9, alpha: 0.8 } })
  L.line(F.land, 0, rgb(C.coast), 1.4, 0.7)
}

function ink(L: Layers, world: World, F: ReturnType<typeof fieldsOf>, S: number) {
  const k = S / 2
  const RICE = hex('#ede6d3')
  const INK = 'rgb(43,42,39)'
  L.rect(rgb(RICE))
  // 鱼鳞水波：图案填满海面
  const pw = 36 * k
  const ph = 9 * k
  const wave = `M0 ${4.5 * k} Q${9 * k} ${1.5 * k} ${18 * k} ${4.5 * k} T${36 * k} ${4.5 * k}`
  L.list.patterns.set('waves', {
    w: pw,
    h: ph,
    svg: `<path d="${wave}" fill="none" stroke="rgb(110,120,120)" stroke-width="${0.7 * k}" stroke-opacity="0.18"/>`,
    tile: () => {
      const c = document.createElement('canvas')
      c.width = Math.round(pw * 4)
      c.height = Math.round(ph * 4)
      const g = c.getContext('2d')!
      g.scale(4, 4)
      g.strokeStyle = 'rgba(110,120,120,0.18)'
      g.lineWidth = 0.7 * k
      g.stroke(new Path2D(wave))
      return c
    },
  })
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
  for (const lv of [1.5, 2.5, 3.5]) L.fill(F.land, lv, INK, 0.05, { filter: 'brush' })
  hillshade(L, F, INK, 0.13, 0, { filter: 'brush' })
  L.fill(F.snow, 0, rgb(RICE), 0.6)
  L.fill(F.lake, 0.5, 'rgb(218,216,204)', 1, { stroke: { color: INK, width: 1.1, alpha: 1 } })
  L.line(F.land, 0, INK, 2.2, 0.9, undefined, { filter: 'brush' })
}

function topo(L: Layers, world: World, F: ReturnType<typeof fieldsOf>) {
  L.rect('#d6e8ef')
  for (const lv of [0.2, 1, 2, 3, 4]) L.line(F.depth, lv, 'rgb(80,140,185)', 0.8, 0.45)
  L.fill(F.ice, 0, 'rgb(248,250,252)')
  L.fill(F.land, 0, rgb(ramp(HYPSO_STOPS, 0.1)))
  for (let lv = 0.25; lv < 6.5; lv += 0.25) L.fill(F.land, lv, rgb(ramp(HYPSO_STOPS, lv + 0.12)), 1, { tol: 0.4, minArea: 2 })
  L.fill(biomeField(world, (b) => FOREST.has(b)), 0.5, 'rgb(196,222,180)', 0.7, { tol: 0.4, minArea: 3 })
  L.fill(F.snow, 1, 'rgb(248,250,252)')
  hillshade(L, F, 'rgb(40,40,40)', 0.07, 0.1)
  for (let lv = 0.1; lv < 9; lv += 0.1) {
    const major = Math.abs(lv / 0.5 - Math.round(lv / 0.5)) < 1e-6
    L.line(F.land, lv, 'rgb(165,105,60)', major ? 1.1 : 0.55, major ? 0.7 : 0.38, undefined, { tol: 0.45 })
  }
  L.fill(F.lake, 0.5, '#cfe4ee', 1, { stroke: { color: 'rgb(60,120,170)', width: 0.9, alpha: 1 } })
  L.line(F.land, 0, 'rgb(50,110,160)', 1.4, 0.95)
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
 * 构建矢量纸图的显示列表：底色、色带、晕渲分级、等值线由格点场追踪成路径，
 * 河流、符号、注记、罗盘、图框复用位图渲染的绘制代码（经 Recorder 录制）。
 */
export function buildAtlasVector(world: World, rivers: SmoothRiver[], id: StyleId, opts: AtlasOpts, measurer: CanvasRenderingContext2D, S = 2): DisplayList {
  const theme = themeById(id)
  const f = fieldsFor(world, S)
  theme.prepare?.(f)
  const { MW, MH, W, H } = f
  const k = S / 2
  const M = marginOf(theme, S)
  const list = new DisplayList(MW + M * 2, MH + M * 2, M, MW, MH)
  list.head = `<title>${world.worldName}</title><style>@import url('${FONT_CSS.replace(/&/g, '&amp;')}');</style>`
  // 纸底
  list.path('page', `M0 0L${list.width} 0L${list.width} ${list.height}L0 ${list.height}Z`, { fill: { color: rgb(theme.paper), alpha: 1 } })

  const F = fieldsOf(world)
  const L = new Layers(list, W, H, S)
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
    case 'teyvat':
      teyvat(L, world, F, S)
      break
    case 'ink':
      ink(L, world, F, S)
      break
    case 'topo':
      topo(L, world, F)
      break
  }

  // 纸纹：两张可平铺的小噪声图做图案
  const brown = theme.id === 'fantasy'
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
  drawOverlays(rec as unknown as CanvasRenderingContext2D, f, theme, rivers, opts)
  rec.space = 'page'
  drawFrame(rec as unknown as CanvasRenderingContext2D, world, theme, S, M, MW, MH)
  return list
}

export function renderAtlasSvg(world: World, rivers: SmoothRiver[], id: StyleId, opts: AtlasOpts, measurer: CanvasRenderingContext2D, S = 2): string {
  return buildAtlasVector(world, rivers, id, opts, measurer, S).toSVG()
}
