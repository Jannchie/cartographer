import type { Area } from '../../gen/areas'
import type { PoliticalMode } from './political'
import { Biome, type World } from '../../gen/types'
import { blur, edt } from '../../gen/util'
import { ATLAS, atlasSea, ramp, type RGB } from '../palette'
import { Fields, fnoise, hash, line, mix, mixc, paperGrain, set, sm, vnoise, type Px } from './fields'

export type StyleId = 'physical' | 'fantasy' | 'nautical' | 'teyvat' | 'ink' | 'topo' | 'political' | 'strategy'

export interface LabelTheme {
  /** 大字（大陆、海洋、国名）字体 */
  display: string
  /** 普通注记字体 */
  text: string
  water: string
  land: string
  range: string
  region: string
  city: string
  halo: string
  /** 竖排的注记类型（只在中文、日文下生效） */
  vertical: string[]
  /** 大写与字距 */
  caps: boolean
  city_marker: 'dot' | 'castle' | 'square' | 'star'
  /** 不描边的注记类型（默认海洋、海、大陆：大字直接压在浅色底图上）；彩色底图上的白字要全部描边 */
  noHalo?: string[]
  /**
   * 所有注记同一个样式（游戏地图式：不分级别，同一字体、字号与颜色，一律描边）：
   * weight 字重，tier 字号级别（见 labelSize），字体取 text 并接无衬线的中日文字体
   */
  uniform?: { weight: string; tier: number; color: string }
}

export interface RoadStyle {
  color: string
  width: number
  dash?: number[]
  /** 路两侧的衬边，让路从底色上跳出来 */
  casing?: string
  sea: string
  seaDash: number[]
}

export interface AtlasOpts {
  labels: boolean
  contours: boolean
  graticule: boolean
  /** 有名字的区域（大陆、海、湾……）：给了就按区域排这些地名（见 gen/areas.ts） */
  areas?: Area[]
  /** 政区图：按国家或文化着色、画伯爵领界与国界，标国名或文化名（生成的世界才有） */
  political?: PoliticalMode
}

/** 一种界线的画法：线宽、虚线以 S=2 时的像素计 */
export interface LineLook {
  color: string
  width: number
  alpha: number
  dash?: number[]
}

/**
 * 政区图在这种风格下的样子：八色调色板（相邻的国家或文化颜色不同）、着色浓淡、
 * 国界内侧的色带（同色加深，像地图集里沿国界描的一道边），以及伯爵领界、文化界、国界的画法
 */
export interface PoliticalLook {
  palette: RGB[]
  /** 着色的不透明度 */
  fill: number
  /** 国界内侧色带：宽度、不透明度与颜色倍率（<1 加深，>1 提亮）；不给就不画 */
  band?: { width: number; alpha: number; tone: number }
  county: LineLook
  culture: LineLook
  realm: LineLook
  /** 国界下面的一道宽晕带 */
  halo?: LineLook
  /** 国名颜色（不给就取色块颜色加深） */
  label?: (c: RGB) => string
}

export interface Theme {
  id: StyleId
  name: string
  desc: string
  paper: RGB
  ink: string
  prepare?: (f: Fields) => void
  pixel: (p: Px, o: Float32Array, f: Fields, opts: AtlasOpts) => void
  river: { color: string; width: number; minFlow: number; fitCoast?: boolean }
  /** 道路（干道；支线更细）与跨海航线（虚线）。dash 以 S=2 时的像素计 */
  roads: RoadStyle
  frame: 'atlas' | 'ornate' | 'ink' | 'none'
  compass: 'star' | 'ornate' | 'nautical' | 'north' | 'none'
  cartouche: 'box' | 'scroll' | 'nautical' | 'ink' | 'game'
  graticule: string | null
  glyphs?: boolean
  rhumb?: boolean
  soundings?: boolean
  realms?: boolean
  legend?: 'realms' | 'hypsometric'
  /** 政区图的画法 */
  political: PoliticalLook
  /** 政区专题风格：政区开关为"无"时也按这个模式着色 */
  politicalDefault?: PoliticalMode
  /** 纸纹（水渍、颗粒），默认有；游戏地图这类非纸质风格关掉 */
  paperTexture?: boolean
  labels: LabelTheme
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

const CORMORANT = '"Cormorant Garamond", Georgia, serif'
const FELL = '"IM Fell English", "Cormorant Garamond", Georgia, serif'
const FELL_SC = '"IM Fell English SC", "IM Fell English", Georgia, serif'
const SANS = '"Source Sans 3", "Helvetica Neue", Arial, sans-serif'
const BRUSH = '"Ma Shan Zheng", "Noto Serif SC", "STKaiti", "KaiTi", serif'
const SONG = '"Noto Serif SC", "Songti SC", "SimSun", serif'

export const REALM_COLORS: RGB[] = ['#e8c7a3', '#c7d8ab', '#d6c0da', '#eedd9c', '#b6d2d4', '#e4b5ad', '#cdc4a3', '#b8c5df'].map(hex)

/** 取色块颜色乘 k 作为国名颜色 */
const shadeOf = (k: number) => (c: RGB) => `rgb(${c.map((v) => Math.round(Math.min(255, v * k))).join(',')})`

// —— 各风格的政区画法 ——
const POL_PHYSICAL: PoliticalLook = {
  palette: REALM_COLORS,
  fill: 0.45,
  band: { width: 6, alpha: 0.4, tone: 0.82 },
  county: { color: '#3a4246', width: 0.45, alpha: 0.28 },
  culture: { color: '#3a4246', width: 1.3, alpha: 0.7, dash: [5, 2.5] },
  realm: { color: '#3a4246', width: 1.7, alpha: 0.9, dash: [10, 3, 2.4, 3] },
  halo: { color: 'rgb(150,40,50)', width: 6, alpha: 0.14 },
}
/** 羊皮纸上的水彩：淡、暖，国界沿内侧晕开一圈更浓的颜色；国界是一串圆点 */
const POL_FANTASY: PoliticalLook = {
  palette: ['#c98f6b', '#9caf74', '#a98fb0', '#d1b45e', '#7fa6a6', '#c27b6e', '#b09a6a', '#8a9cc0'].map(hex),
  fill: 0.36,
  band: { width: 11, alpha: 0.55, tone: 0.74 },
  county: { color: '#4a3624', width: 0.5, alpha: 0.3, dash: [1.2, 2.6] },
  culture: { color: '#4a3624', width: 1.2, alpha: 0.65, dash: [6, 3] },
  realm: { color: '#3a2818', width: 3, alpha: 0.95, dash: [0.01, 4.6] },
  halo: { color: 'rgb(140,50,30)', width: 8, alpha: 0.16 },
  label: shadeOf(0.38),
}
const POL_NAUTICAL: PoliticalLook = {
  palette: ['#e6cfb4', '#cfdcbd', '#ddd0df', '#ece0b4', '#c8dcdc', '#e6c8c2', '#d8d2bd', '#cbd4e6'].map(hex),
  fill: 0.4,
  band: { width: 4, alpha: 0.35, tone: 0.8 },
  county: { color: '#1f2a33', width: 0.4, alpha: 0.2 },
  culture: { color: '#1f2a33', width: 1, alpha: 0.6, dash: [4, 2.5] },
  realm: { color: '#1f2a33', width: 1.3, alpha: 0.85, dash: [6, 2, 1.5, 2] },
}
/** 游戏地图：白色国界加深色衬边，色块很淡，不压住平涂的地形 */
const POL_TEYVAT: PoliticalLook = {
  palette: ['#e2b46c', '#9fcf8a', '#c6a4dc', '#f0dc84', '#86cfd0', '#e79a8a', '#cfc095', '#9fb3e8'].map(hex),
  fill: 0.24,
  band: { width: 5, alpha: 0.45, tone: 1.15 },
  county: { color: '#ffffff', width: 0.5, alpha: 0.22 },
  culture: { color: '#ffffff', width: 1.1, alpha: 0.6, dash: [5, 3] },
  realm: { color: '#fbf6e2', width: 1.6, alpha: 0.95 },
  halo: { color: 'rgb(20,30,28)', width: 4.2, alpha: 0.5 },
}
/** 水墨：淡墨设色，国界用浅赭的细笔，国名与其余注记同为墨色 */
const POL_INK: PoliticalLook = {
  palette: ['#bfae94', '#a9b5a2', '#b5a8a3', '#c2b897', '#a7b4b5', '#b9a39a', '#b3ad98', '#a9aab5'].map(hex),
  fill: 0.16,
  band: { width: 6, alpha: 0.22, tone: 0.85 },
  county: { color: '#2b2a27', width: 0.4, alpha: 0.14, dash: [1, 2] },
  culture: { color: '#2b2a27', width: 1, alpha: 0.45, dash: [4, 3] },
  realm: { color: '#7a5a48', width: 1.2, alpha: 0.6, dash: [6, 3] },
  label: () => '#3b3833',
}
/** 地形图：不着色块，国界用品红点划线，沿内侧一道淡紫色带 */
const POL_TOPO: PoliticalLook = {
  palette: ['#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9'].map(hex),
  fill: 0,
  band: { width: 6, alpha: 0.55, tone: 0.92 },
  county: { color: '#6b5a7a', width: 0.5, alpha: 0.35, dash: [2, 2] },
  culture: { color: '#6b5a7a', width: 1, alpha: 0.6, dash: [5, 2.5] },
  realm: { color: '#8a2f8f', width: 1.5, alpha: 0.9, dash: [9, 2.5, 1.8, 2.5] },
  label: () => '#6a2470',
}
/** 政区地图集：满铺的柔和色块，伯爵领白线，国界内侧加深的色带 */
const POL_ATLAS: PoliticalLook = {
  palette: ['#f2c49b', '#c8dea0', '#d9bde3', '#f5e08f', '#a9d6d8', '#f0aea3', '#d8cfa4', '#b4c6ea'].map(hex),
  fill: 0.9,
  band: { width: 7, alpha: 0.75, tone: 0.8 },
  county: { color: '#ffffff', width: 0.6, alpha: 0.55 },
  culture: { color: '#4a4048', width: 1.2, alpha: 0.7, dash: [5, 2.5] },
  realm: { color: '#4a4048', width: 1.4, alpha: 0.95, dash: [7, 2.5, 1.5, 2.5] },
  label: shadeOf(0.4),
}
/** 战略图：饱和的纹章色压在晕渲地形上，伯爵领细黑线，国界粗黑线 */
const POL_STRATEGY: PoliticalLook = {
  palette: ['#c0473c', '#3f74b8', '#d9aa3b', '#4f9450', '#8c52a3', '#d6803a', '#3a9e9a', '#a35470'].map(hex),
  fill: 0.6,
  band: { width: 5, alpha: 0.6, tone: 1.35 },
  county: { color: '#141414', width: 0.5, alpha: 0.32 },
  culture: { color: '#141414', width: 1.2, alpha: 0.6, dash: [5, 2.5] },
  realm: { color: '#101010', width: 2, alpha: 0.95 },
  halo: { color: '#000000', width: 5, alpha: 0.18 },
  label: () => '#fff8e8',
}

const FOREST = new Set<number>([Biome.Taiga, Biome.TemperateForest, Biome.TemperateRainforest, Biome.TropicalRainforest, Biome.TropicalSeasonalForest])

function coastInk(p: Px, o: Float32Array, c: RGB, w: number, a = 0.92) {
  mixc(o, c, line(p.coastSd, w) * a)
}

function lakeFill(p: Px, o: Float32Array, fill: RGB, edge: RGB, w = 0.7) {
  if (p.lake > 0.5) set(o, fill)
  if (p.lake > 0.05) mixc(o, edge, line(p.lakeSd, w) * 0.8)
}

// ————————————————————————————————— 自然地理 —————————————————————————————————
const INK_PH = hex('#3a4246')
function stepDepth(d: number) {
  const levels = [0, 0.2, 1, 2, 3.2, 4.2, 9]
  for (let k = 0; k < levels.length - 1; k++) {
    if (d < levels[k + 1]) {
      const t = (d - levels[k]) / (levels[k + 1] - levels[k])
      return levels[k] + (levels[k + 1] - levels[k]) * (0.25 + t * 0.35)
    }
  }
  return d
}
function physicalPixel(p: Px, o: Float32Array, f: Fields, opts: AtlasOpts) {
  const S = f.S
  if (p.h <= 0) {
    const depth = -p.h
    set(o, atlasSea(stepDepth(depth)))
    for (const lv of [0.2, 1, 2, 3.2, 4.2]) mix(o, 88, 106, 120, line(Math.abs(depth - lv) / p.gpx, 0.4) * 0.16)
    seaIce(p, o, [236, 240, 239])
    const dpx = -p.coast
    const rip = [4.5, 9.5, 16, 25]
    const ra = [0.34, 0.22, 0.13, 0.07]
    for (let k = 0; k < 4; k++) mix(o, 70, 104, 120, (1 - sm(0.35, 1.05, Math.abs(dpx - rip[k] * (S / 2)))) * ra[k])
  } else {
    const [cr, cg, cb] = f.biomeColors('atlas', ATLAS, (c, i) => {
      const hi = sm(1.2, 4, f.world.elevation[i]) * 0.5
      return [c[0] + (216 - c[0]) * hi, c[1] + (204 - c[1]) * hi, c[2] + (186 - c[2]) * hi]
    })
    o[0] = f.sample(cr, p.gx, p.gy)
    o[1] = f.sample(cg, p.gx, p.gy)
    o[2] = f.sample(cb, p.gx, p.gy)
    const sh = 1 + (p.shade - 1) * 0.85
    o[0] *= sh
    o[1] *= sh
    o[2] *= sh * 1.02
    if (opts.contours) {
      const lv = Math.round(p.h / 0.5) * 0.5
      if (lv > 0) mix(o, 120, 96, 70, line(Math.abs(p.h - lv) / p.gpx, 0.4) * (lv % 2 === 0 ? 0.2 : 0.1))
    }
    lakeFill(p, o, ATLAS[Biome.Lake], [78, 106, 130])
  }
  coastInk(p, o, INK_PH, 0.85)
  paperGrain(o, p.px, p.py)
}

function seaIce(p: Px, o: Float32Array, c: RGB) {
  const t = p.T + (hash(p.px >> 3, p.py >> 3) - 0.5) * 2.5
  mixc(o, c, sm(-6.5, -9.5, t))
}

// ————————————————————————————————— 奇幻羊皮 —————————————————————————————————
const PARCH_LAND = hex('#ecdcb3')
const PARCH_SEA = hex('#ded4b0')
const SEA_WASH = hex('#94ab98')
const COAST_WASH = hex('#cfa86c')
const MOUNTAIN_WASH = hex('#b08c60')
const SEPIA = hex('#4a3624')
/** 手工上色的群系淡彩 */
export const FANTASY_TINT: Record<number, RGB> = {}
for (let b = 0; b <= 17; b++) FANTASY_TINT[b] = PARCH_LAND
Object.assign(FANTASY_TINT, {
  [Biome.Grassland]: hex('#d8d49a'),
  [Biome.Savanna]: hex('#e2cf92'),
  [Biome.Shrubland]: hex('#d9c998'),
  [Biome.TemperateForest]: hex('#c2c690'),
  [Biome.TemperateRainforest]: hex('#b6c08e'),
  [Biome.Taiga]: hex('#bec4a0'),
  [Biome.TropicalSeasonalForest]: hex('#c8c68a'),
  [Biome.TropicalRainforest]: hex('#b2bc84'),
  [Biome.HotDesert]: hex('#edd29a'),
  [Biome.ColdDesert]: hex('#e0d2ac'),
  [Biome.SaltFlat]: hex('#ede5cd'),
  [Biome.Tundra]: hex('#dbd8c2'),
  [Biome.IceCap]: hex('#f3efe3'),
  [Biome.Alpine]: hex('#e0d6c0'),
  [Biome.Wetland]: hex('#bcc49e'),
  [Biome.Beach]: hex('#eedcae'),
})
export const FANTASY_COLORS = {
  sea: PARCH_SEA,
  seaWash: SEA_WASH,
  coastWash: COAST_WASH,
  mountainWash: MOUNTAIN_WASH,
  lake: hex('#b9c6b0'),
  sepia: SEPIA,
}
export const FANTASY_GLYPHS = {
  ink: '#4a3624',
  paper: 'rgb(241, 229, 199)',
  shadow: 'rgb(198, 172, 128)',
  snow: 'rgb(251, 247, 236)',
  leaf: 'rgb(190, 192, 132)',
  leafDark: 'rgb(140, 145, 94)',
  pine: 'rgb(154, 163, 114)',
  pineDark: 'rgb(108, 119, 84)',
  grass: 'rgb(98, 92, 50)',
}
function fantasyPixel(p: Px, o: Float32Array, f: Fields) {
  const { px, py } = p
  if (p.h <= 0) {
    // 深海近纸色，近岸一圈铜绿水彩，越近越浓
    const d = -p.coast
    set(o, PARCH_SEA)
    mixc(o, SEA_WASH, 0.56 * Math.exp(-d / (22 * f.S)) + 0.1 * Math.exp(-d / (60 * f.S)))
    seaIce(p, o, [240, 232, 210])
    const rip = [3.5, 7, 11, 16, 22]
    for (let k = 0; k < rip.length; k++) mixc(o, SEPIA, (1 - sm(0.25, 0.85, Math.abs(d - rip[k] * (f.S / 2)))) * (0.34 - k * 0.06))
  } else {
    set(o, PARCH_LAND)
    const [cr, cg, cb] = f.biomeColors('fantasy', FANTASY_TINT)
    mix(o, f.sample(cr, p.gx, p.gy), f.sample(cg, p.gx, p.gy), f.sample(cb, p.gx, p.gy), 0.6)
    // 高地一层棕色晕染，沿岸一道赭石色带
    mixc(o, MOUNTAIN_WASH, sm(1.1, 1.5, p.h) * 0.07 + sm(2.1, 2.5, p.h) * 0.06)
    mixc(o, COAST_WASH, Math.exp(-p.coast / (3 * f.S)) * 0.34)
    const sh = 1 + (p.shade - 1) * 0.3
    o[0] *= sh
    o[1] *= sh
    o[2] *= sh
    lakeFill(p, o, FANTASY_COLORS.lake, SEPIA, 0.9)
  }
  coastInk(p, o, SEPIA, 1.3, 0.95)
  // 陈旧感：水渍与四周焦边
  const stain = fnoise(px, py, 110) * 0.65 + fnoise(px + 999, py, 28) * 0.35
  mix(o, 170, 140, 95, sm(0.6, 0.88, stain) * 0.14)
  const ex = Math.min(px, f.MW - px) / f.MW
  const ey = Math.min(py, f.MH - py) / f.MH
  const edge = 1 - sm(0, 0.12, Math.min(ex, ey * 1.4) + (fnoise(px, py, 45) - 0.5) * 0.04)
  mix(o, 120, 82, 45, edge * 0.5)
  paperGrain(o, px, py, 1.2)
}

// ————————————————————————————————— 航海图 —————————————————————————————————
const CHART_PAPER = hex('#f4f1e8')
const CHART_LAND = hex('#ebdcb4')
function nauticalPixel(p: Px, o: Float32Array) {
  if (p.h <= 0) {
    const d = -p.h
    set(o, CHART_PAPER)
    if (d < 0.2) set(o, ramp([[0, hex('#9fcbe0')], [0.02, hex('#b3d6e6')], [0.05, hex('#cde4ee')], [0.2, hex('#e3eff2')]], d))
    // 等深线：10 m、20 m 虚线，50 m、200 m、1000 m 实线
    const dash = ((p.px + p.py) >> 2) & 1
    for (const lv of [0.01, 0.02]) mix(o, 60, 120, 170, line(Math.abs(d - lv) / p.gpx, 0.35) * 0.55 * dash)
    for (const lv of [0.05, 0.2, 1]) mix(o, 60, 120, 170, line(Math.abs(d - lv) / p.gpx, 0.4) * 0.5)
    seaIce(p, o, [250, 250, 250])
  } else {
    set(o, CHART_LAND)
    // 海岸内侧一圈加深的色带
    mix(o, 214, 190, 140, Math.exp(-p.coast / 5) * 0.7)
    const sh = 1 + (p.shade - 1) * 0.4
    o[0] *= sh
    o[1] *= sh
    o[2] *= sh
    lakeFill(p, o, hex('#c7e0ea'), [40, 60, 80])
  }
  coastInk(p, o, [30, 30, 30], 0.95)
  paperGrain(o, p.px, p.py, 0.6)
}

// ————————————————————————————————— 提瓦特（原神大地图风） —————————————————————————————————
/**
 * 游戏大地图：已探索区域（陆地外扩一圈海）之外是深藏青的星空虚空，交界是一道发光的青线；
 * 海是低饱和的青绿，陆地是橄榄绿 / 黄橄榄 / 土黄的平涂台地，台地边缘有深色崖线，几乎不做写实晕渲。
 */
export const TEYVAT = {
  void: hex('#0d1624'),
  deep: hex('#2e6972'),
  sea: hex('#3d8187'),
  shallow: hex('#5b9e9a'),
  edge: hex('#bfe6df'),
  cliff: hex('#4b5528'),
  coast: hex('#3f4a26'),
  rock: hex('#b3ad93'),
  snow: hex('#dfe2dc'),
  lake: hex('#4f9396'),
  /** 高处台地偏向的土黄 */
  plateau: hex('#c4b470'),
  star: hex('#c8dceb'),
  ice: hex('#d6e0de'),
  toonDark: hex('#282c14'),
  toonLight: hex('#fffae1'),
}
/** 台地高差（km） */
export const TEYVAT_STEP = 0.6

const reachCache = new WeakMap<World, Float32Array>()
/**
 * 探索区域的有符号距离场（格，区域外为正）：离陆地约 24 格以内的海先膨胀、再大半径模糊，
 * 相邻岛屿的范围连成一整团圆润的轮廓，而不是贴着每座岛绕一圈。
 */
export function teyvatReach(world: World) {
  let sd = reachCache.get(world)
  if (sd) return sd
  const { W, H, coastDist } = world
  const N = W * H
  const soft = new Float32Array(N)
  for (let i = 0; i < N; i++) soft[i] = coastDist[i] > -24 ? 1 : 0
  blur(soft, W, H, 14, 3)
  const inside = new Uint8Array(N)
  const outside = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    inside[i] = soft[i] >= 0.5 ? 1 : 0
    outside[i] = 1 - inside[i]
  }
  const dIn = edt(inside, W, H)
  const dOut = edt(outside, W, H)
  sd = new Float32Array(N)
  for (let i = 0; i < N; i++) sd[i] = dIn[i] - dOut[i]
  blur(sd, W, H, 1, 2)
  reachCache.set(world, sd)
  return sd
}
export const TEYVAT_TINT: Record<number, RGB> = {}
for (let b = 0; b <= 17; b++) TEYVAT_TINT[b] = hex('#9aa447')
Object.assign(TEYVAT_TINT, {
  [Biome.Grassland]: hex('#9ca646'),
  [Biome.Savanna]: hex('#b5a855'),
  [Biome.Shrubland]: hex('#a8a052'),
  [Biome.TemperateForest]: hex('#7e8d3b'),
  [Biome.TemperateRainforest]: hex('#6f8237'),
  [Biome.Taiga]: hex('#737f48'),
  [Biome.TropicalSeasonalForest]: hex('#8c9a3e'),
  [Biome.TropicalRainforest]: hex('#6a7f33'),
  [Biome.HotDesert]: hex('#c7b672'),
  [Biome.ColdDesert]: hex('#b9b189'),
  [Biome.SaltFlat]: hex('#d4cfba'),
  [Biome.Tundra]: hex('#aeb08d'),
  [Biome.IceCap]: hex('#dfe2dc'),
  [Biome.Alpine]: hex('#aba68b'),
  [Biome.Wetland]: hex('#7e8b50'),
  [Biome.Beach]: hex('#cbbd82'),
})
function teyvatPixel(p: Px, o: Float32Array, f: Fields) {
  const { px, py } = p
  const S = f.S
  if (p.h <= 0) {
    // 探索区域边界（像素，外为正）
    const bnd = f.sample(teyvatReach(f.world), p.gx, p.gy) * S
    if (bnd > 0) {
      // 虚空：深藏青，零星的星点，靠近边界泛出青色辉光
      set(o, TEYVAT.void)
      const n = vnoise(px, py, 220)
      mix(o, 26, 40, 62, n * 0.5)
      const star = hash(px, py)
      if (star > 0.9985) mixc(o, TEYVAT.star, (star - 0.9985) * 400 * (0.4 + n))
      mixc(o, TEYVAT.sea, Math.exp(-bnd / (7 * S)) * 0.45)
    } else {
      // 近岸用精确距离（平坦海底上 |h|/|∇h| 会失真，只在贴岸处用）
      const d = Math.min(-p.coast, p.coastSd)
      set(o, TEYVAT.deep)
      mixc(o, TEYVAT.sea, Math.exp(-d / (12 * S)) * 0.8)
      mixc(o, TEYVAT.shallow, Math.exp(-d / (3.5 * S)) * 0.6)
      // 内侧靠边界略暗
      mixc(o, TEYVAT.void, sm(-6 * S, 0, bnd) * 0.25)
      seaIce(p, o, TEYVAT.ice)
    }
    // 边界亮线
    mixc(o, TEYVAT.edge, line(Math.abs(bnd), 0.9) * 0.9)
  } else {
    const [cr, cg, cb] = f.biomeColors('teyvat', TEYVAT_TINT)
    o[0] = f.sample(cr, p.gx, p.gy)
    o[1] = f.sample(cg, p.gx, p.gy)
    o[2] = f.sample(cb, p.gx, p.gy)
    // 台地：按高差分层，越高越偏土黄、越亮
    const lv = p.h / TEYVAT_STEP
    const tier = Math.floor(lv)
    mixc(o, TEYVAT.plateau, Math.min(0.25, tier * 0.05))
    mixc(o, TEYVAT.rock, sm(2.4, 3.4, p.h) * 0.7)
    mixc(o, TEYVAT.snow, sm(-5, -7.5, p.T))
    // 卡通分层的明暗：只分亮、中、暗三档
    const s = p.shade
    const toon = s > 1.04 ? 1.06 : s < 0.8 ? 0.8 : s < 0.92 ? 0.9 : 1
    o[0] *= toon
    o[1] *= toon
    o[2] *= toon
    // 台地边缘：只在陡处画——上沿一道深色崖线，崖下一小段阴影；缓坡上不画，免得像等高线图
    const steep = sm(0.04, 0.12, p.gpx)
    if (steep > 0 && tier > 0) {
      const up = ((1 - (lv - tier)) * TEYVAT_STEP) / p.gpx
      const down = ((lv - tier) * TEYVAT_STEP) / p.gpx
      mixc(o, TEYVAT.cliff, line(down, 0.7) * 0.55 * steep)
      mixc(o, TEYVAT.cliff, (1 - sm(0, 3.5 * S, up)) * 0.18 * steep)
    }
    lakeFill(p, o, TEYVAT.lake, TEYVAT.coast, 0.8)
  }
  coastInk(p, o, TEYVAT.coast, 0.8, 0.7)
}

// ————————————————————————————————— 水墨 —————————————————————————————————
const RICE = hex('#ede6d3')
const INKC = hex('#2b2a27')
const INK_TINT: Record<number, RGB> = {}
for (let b = 0; b <= 17; b++) INK_TINT[b] = RICE
for (const b of FOREST) INK_TINT[b] = hex('#a9b89c')
INK_TINT[Biome.Grassland] = hex('#cfcfab')
INK_TINT[Biome.Savanna] = hex('#d6caa0')
INK_TINT[Biome.HotDesert] = hex('#dcc79e')
INK_TINT[Biome.ColdDesert] = hex('#d5c8ab')
INK_TINT[Biome.Shrubland] = hex('#d2c7a3')
INK_TINT[Biome.Wetland] = hex('#b7c1ad')
function inkPixel(p: Px, o: Float32Array, f: Fields) {
  const { px, py } = p
  set(o, RICE)
  if (p.h <= 0) {
    const d = -p.coast
    mix(o, 150, 160, 158, Math.exp(-d / 16) * 0.3)
    // 水波纹：鱼鳞状的细波线铺满水面
    const wy = py + Math.sin(px * 0.09 + Math.floor(py / 9) * 1.7) * 2.4
    const wave = Math.abs((wy % 9) - 4.5)
    mix(o, 110, 120, 120, line(wave, 0.35) * 0.16 * (0.5 + 0.5 * vnoise(px, py, 60)))
    seaIce(p, o, [245, 243, 236])
  } else {
    // 青绿山水：淡彩打底
    const [cr, cg, cb] = f.biomeColors('ink', INK_TINT)
    mix(o, f.sample(cr, p.gx, p.gy), f.sample(cg, p.gx, p.gy), f.sample(cb, p.gx, p.gy), 0.42)
    // 石青：只点染在高处的迎光面
    mix(o, 110, 140, 138, sm(1.4, 3.8, p.h) * sm(0.9, 1.08, p.shade) * 0.3)
    // 皴擦：背光坡用干笔，笔触沿斜向拉长；山脚淡、山顶浓
    const stroke = vnoise(px * 1.6 + py * 0.9, py * 0.5 - px * 0.3, 3)
    const dry = sm(0.35, 0.8, stroke * 0.7 + fnoise(px, py, 14) * 0.5)
    const dark = Math.max(0, 1 - p.shade) * 1.25 * sm(0.1, 1.4, p.h)
    const mass = sm(0.8, 4.5, p.h) * 0.16
    let ink = dark * (0.35 + 0.9 * dry) + mass * (0.6 + 0.4 * dry)
    // 积雪处留白
    ink *= 1 - sm(-4, -8, p.T) * 0.7
    mixc(o, INKC, Math.min(0.85, ink))
    lakeFill(p, o, [218, 216, 204], INKC, 0.6)
  }
  // 海岸：粗细变化的墨线
  const w = 0.7 + 1.1 * vnoise(px, py, 38)
  coastInk(p, o, INKC, w, 0.9)
  // 宣纸纤维
  const fiber = hash(px >> 0, py >> 2) * hash(px >> 3, py) - 0.25
  o[0] += fiber * 8
  o[1] += fiber * 8
  o[2] += fiber * 7
  paperGrain(o, px, py, 0.8)
}

// ————————————————————————————————— 等高线地形图 —————————————————————————————————
const HYPSO: [number, RGB][] = [
  [0, hex('#d4e4c2')],
  [0.3, hex('#e2e8c6')],
  [0.8, hex('#eee7c9')],
  [1.6, hex('#ead9c1')],
  [2.8, hex('#dfcdbc')],
  [4, hex('#e9e3df')],
  [6, hex('#fafafa')],
]
const TOPO_WOOD: Record<number, RGB> = {}
for (let b = 0; b <= 17; b++) TOPO_WOOD[b] = [0, 0, 0]
for (const b of FOREST) TOPO_WOOD[b] = [255, 255, 255]
function topoPixel(p: Px, o: Float32Array, f: Fields) {
  if (p.h <= 0) {
    set(o, hex('#d6e8ef'))
    const d = -p.h
    for (const lv of [0.2, 1, 2, 3, 4]) mix(o, 80, 140, 185, line(Math.abs(d - lv) / p.gpx, 0.4) * 0.45)
    seaIce(p, o, [248, 250, 252])
  } else {
    set(o, ramp(HYPSO, p.h))
    // 林地：绿色底纹
    const [wood] = f.biomeColors('wood', TOPO_WOOD)
    mix(o, 196, 222, 180, (f.sample(wood, p.gx, p.gy) / 255) * 0.7)
    const glacier = sm(-6, -8, p.T)
    mix(o, 248, 250, 252, glacier)
    const sh = 1 + (p.shade - 1) * 0.45
    o[0] *= sh
    o[1] *= sh
    o[2] *= sh
    // 首曲线 100 m，计曲线 500 m；太密时省略首曲线
    const c = glacier > 0.5 ? ([70, 130, 190] as RGB) : ([165, 105, 60] as RGB)
    const minor = Math.round(p.h / 0.1) * 0.1
    const spacing = 0.1 / p.gpx
    if (minor > 0 && spacing > 2.4) mixc(o, c, line(Math.abs(p.h - minor) / p.gpx, 0.3) * 0.38)
    const major = Math.round(p.h / 0.5) * 0.5
    if (major > 0) mixc(o, c, line(Math.abs(p.h - major) / p.gpx, 0.55) * 0.7)
    lakeFill(p, o, hex('#cfe4ee'), [60, 120, 170])
  }
  coastInk(p, o, [50, 110, 160], 0.7, 0.95)
}

// ————————————————————————————————— 政区地图集 · 战略图 —————————————————————————————————
/** 位图版本的政区着色（矢量版见 svg/vector.ts）：取最近格所属国家的颜色 */
function realmTint(p: Px, f: Fields, look: PoliticalLook): RGB | null {
  const r = f.world.realm[p.i]
  return r >= 0 && f.world.realms[r] ? look.palette[f.world.realms[r].color] : null
}

export const POLITICAL_SEA = hex('#d3e3ea')
export const POLITICAL_LAND = hex('#eee8d6')
function politicalPixel(p: Px, o: Float32Array, f: Fields) {
  const S = f.S
  if (p.h <= 0) {
    set(o, POLITICAL_SEA)
    mix(o, 176, 204, 216, sm(0.3, 3, -p.h) * 0.6)
    seaIce(p, o, [240, 244, 245])
    const dpx = -p.coast
    const rip = [2.5, 5.5, 9.5]
    const ra = [0.3, 0.18, 0.09]
    for (let k = 0; k < 3; k++) mix(o, 80, 120, 140, (1 - sm(0.35, 1.05, Math.abs(dpx - rip[k] * (S / 2)))) * ra[k])
  } else {
    set(o, POLITICAL_LAND)
    const c = realmTint(p, f, POL_ATLAS)
    if (c) mixc(o, c, POL_ATLAS.fill)
    const sh = 1 + (p.shade - 1) * 0.35
    o[0] *= sh
    o[1] *= sh
    o[2] *= sh
    lakeFill(p, o, POLITICAL_SEA, [70, 100, 120])
  }
  coastInk(p, o, [60, 80, 95], 0.65)
  paperGrain(o, p.px, p.py)
}

export const STRATEGY_SEA = hex('#1f3d50')
export const STRATEGY_SHALLOW = hex('#2f6178')
function strategyPixel(p: Px, o: Float32Array, f: Fields) {
  if (p.h <= 0) {
    set(o, STRATEGY_SEA)
    mixc(o, STRATEGY_SHALLOW, 1 - sm(0, 30 * f.S, -p.coast))
    seaIce(p, o, [214, 226, 232])
  } else {
    const [cr, cg, cb] = f.biomeColors('atlas', ATLAS)
    o[0] = f.sample(cr, p.gx, p.gy)
    o[1] = f.sample(cg, p.gx, p.gy)
    o[2] = f.sample(cb, p.gx, p.gy)
    const c = realmTint(p, f, POL_STRATEGY)
    if (c) mixc(o, c, POL_STRATEGY.fill)
    const sh = 1 + (p.shade - 1) * 1.1
    o[0] *= sh
    o[1] *= sh
    o[2] *= sh
    lakeFill(p, o, STRATEGY_SHALLOW, [20, 30, 36])
  }
  coastInk(p, o, [16, 24, 30], 0.75)
}

export const THEMES: Theme[] = [
  {
    id: 'physical',
    political: POL_PHYSICAL,
    name: '自然地理',
    desc: '分层设色 · 晕渲',
    paper: hex('#f1ead8'),
    ink: '#3a4246',
    pixel: physicalPixel,
    river: { color: 'rgba(78, 122, 146, 0.92)', width: 1, minFlow: 1.8 },
    roads: { color: 'rgba(158, 60, 42, 0.88)', width: 1.4, casing: 'rgba(241, 234, 216, 0.65)', sea: 'rgba(60, 96, 120, 0.55)', seaDash: [5, 4] },
    frame: 'atlas',
    compass: 'star',
    cartouche: 'box',
    graticule: 'rgba(70, 80, 84, 0.22)',
    labels: {
      display: CORMORANT,
      text: CORMORANT,
      water: '#4b6c7c',
      land: 'rgba(78, 64, 50, 0.78)',
      range: '#6c533c',
      region: '#7a6246',
      city: '#2f2b27',
      halo: 'rgba(241, 234, 216, 0.72)',
      vertical: [],
      caps: true,
      city_marker: 'dot',
    },
  },
  {
    id: 'fantasy',
    political: POL_FANTASY,
    name: '奇幻羊皮',
    desc: '手绘山形 · 树林符号',
    paper: hex('#dcc596'),
    ink: '#4a3624',
    pixel: fantasyPixel,
    river: { color: 'rgba(48, 70, 88, 0.95)', width: 1.15, minFlow: 2, fitCoast: true },
    roads: { color: 'rgba(74, 54, 36, 0.92)', width: 1.7, dash: [2, 3.2], sea: 'rgba(74, 54, 36, 0.5)', seaDash: [6, 5] },
    frame: 'ornate',
    compass: 'ornate',
    cartouche: 'scroll',
    graticule: null,
    glyphs: true,
    labels: {
      display: FELL_SC,
      text: FELL,
      water: '#4f4632',
      land: '#3e2c1c',
      range: '#4a3624',
      region: '#5a4430',
      city: '#2e2116',
      halo: 'rgba(236, 220, 181, 0.8)',
      vertical: [],
      caps: true,
      city_marker: 'castle',
    },
  },
  {
    id: 'nautical',
    political: POL_NAUTICAL,
    name: '航海图',
    desc: '测深 · 恒向线',
    paper: hex('#efe9da'),
    ink: '#1f2a33',
    pixel: nauticalPixel,
    river: { color: 'rgba(60, 110, 150, 0.85)', width: 0.8, minFlow: 3 },
    roads: { color: 'rgba(60, 60, 60, 0.6)', width: 0.9, sea: 'rgba(30, 70, 110, 0.7)', seaDash: [7, 4] },
    frame: 'atlas',
    compass: 'nautical',
    cartouche: 'nautical',
    graticule: 'rgba(30, 40, 50, 0.28)',
    rhumb: true,
    soundings: true,
    labels: {
      display: CORMORANT,
      text: CORMORANT,
      water: '#1f4a6b',
      land: '#262626',
      range: '#4a4a4a',
      region: '#555',
      city: '#1f1f1f',
      halo: 'rgba(244, 241, 232, 0.8)',
      vertical: [],
      caps: true,
      city_marker: 'dot',
    },
  },
  {
    id: 'teyvat',
    political: POL_TEYVAT,
    name: '提瓦特',
    desc: '原神风 · 平涂台地 · 星空边界',
    paper: TEYVAT.void,
    ink: '#f2f0e6',
    pixel: teyvatPixel,
    river: { color: 'rgba(88, 150, 152, 0.95)', width: 1.1, minFlow: 2, fitCoast: true },
    roads: { color: 'rgba(236, 222, 164, 0.95)', width: 1.9, casing: 'rgba(50, 56, 24, 0.55)', sea: 'rgba(190, 230, 222, 0.55)', seaDash: [4, 5] },
    frame: 'none',
    compass: 'none',
    cartouche: 'game',
    graticule: null,
    paperTexture: false,
    labels: {
      display: CORMORANT,
      text: SANS,
      water: '#e6f1ee',
      land: '#fbf8ec',
      range: '#f4efdc',
      region: '#f4efde',
      city: '#ffffff',
      halo: 'rgba(24, 32, 30, 0.7)',
      vertical: [],
      caps: false,
      city_marker: 'dot',
      noHalo: [],
      // 原神地图的地名只有一种：同一字号的白色无衬线字，深色描边
      uniform: { weight: '500', tier: 1, color: '#ffffff' },
    },
  },
  {
    id: 'ink',
    political: POL_INK,
    name: '水墨',
    desc: '青绿山水 · 中文注记',
    paper: hex('#e6ddc6'),
    ink: '#2b2a27',
    pixel: inkPixel,
    river: { color: 'rgba(60, 62, 60, 0.75)', width: 0.8, minFlow: 2.2 },
    roads: { color: 'rgba(43, 42, 39, 0.75)', width: 1, dash: [3, 2.5], sea: 'rgba(43, 42, 39, 0.45)', seaDash: [2, 4] },
    frame: 'ink',
    compass: 'none',
    cartouche: 'ink',
    graticule: null,
    labels: {
      display: BRUSH,
      text: SONG,
      water: '#4d5a5a',
      land: '#2b2a27',
      range: '#3b3a36',
      region: '#5a5040',
      city: '#2b2a27',
      halo: 'rgba(237, 230, 211, 0.8)',
      vertical: [],
      caps: false,
      city_marker: 'square',
    },
  },
  {
    id: 'topo',
    political: POL_TOPO,
    name: '等高线',
    desc: '现代地形图',
    paper: hex('#fbfaf6'),
    ink: '#2d3a44',
    pixel: topoPixel,
    river: { color: 'rgba(50, 110, 160, 0.95)', width: 0.8, minFlow: 1.8 },
    roads: { color: 'rgba(170, 40, 30, 0.88)', width: 1.3, casing: 'rgba(255, 255, 255, 0.8)', sea: 'rgba(50, 110, 160, 0.6)', seaDash: [6, 4] },
    frame: 'atlas',
    compass: 'north',
    cartouche: 'box',
    graticule: 'rgba(40, 60, 80, 0.3)',
    legend: 'hypsometric',
    labels: {
      display: SANS,
      text: SANS,
      water: '#2f6f9f',
      land: '#333',
      range: '#7a4b2a',
      region: '#5e5e4a',
      city: '#1e1e1e',
      halo: 'rgba(251, 250, 246, 0.85)',
      vertical: [],
      caps: true,
      city_marker: 'dot',
    },
  },
  {
    id: 'political',
    political: POL_ATLAS,
    politicalDefault: 'realms',
    name: '政区地图集',
    desc: '国家着色 · 伯爵领 · 国界色带',
    paper: hex('#f4efe2'),
    ink: '#3d3640',
    pixel: politicalPixel,
    river: { color: 'rgba(70, 120, 150, 0.85)', width: 0.8, minFlow: 3 },
    roads: { color: 'rgba(120, 60, 50, 0.55)', width: 0.9, sea: 'rgba(70, 110, 135, 0.45)', seaDash: [4, 4] },
    frame: 'atlas',
    compass: 'star',
    cartouche: 'box',
    graticule: 'rgba(70, 100, 120, 0.22)',
    legend: 'realms',
    labels: {
      display: CORMORANT,
      text: CORMORANT,
      water: '#3f6a80',
      land: 'rgba(70, 60, 60, 0.8)',
      range: '#6a5a50',
      region: '#6a5a50',
      city: '#2a2428',
      halo: 'rgba(250, 246, 236, 0.75)',
      vertical: [],
      caps: true,
      city_marker: 'square',
      noHalo: ['ocean', 'sea', 'continent', 'realm'],
    },
  },
  {
    id: 'strategy',
    political: POL_STRATEGY,
    politicalDefault: 'realms',
    name: '战略图',
    desc: '纹章色 · 晕渲地形 · 粗国界',
    paper: hex('#13222c'),
    ink: '#e9e1cc',
    pixel: strategyPixel,
    river: { color: 'rgba(70, 130, 160, 0.95)', width: 1, minFlow: 2.2 },
    roads: { color: 'rgba(60, 40, 25, 0.6)', width: 1, dash: [3, 2.5], sea: 'rgba(200, 220, 230, 0.35)', seaDash: [4, 5] },
    frame: 'none',
    compass: 'none',
    cartouche: 'game',
    graticule: null,
    paperTexture: false,
    labels: {
      display: FELL_SC,
      text: CORMORANT,
      water: '#b9d3df',
      land: '#f6efdc',
      range: '#efe6cf',
      region: '#efe6cf',
      city: '#fff8e8',
      halo: 'rgba(16, 14, 12, 0.75)',
      vertical: [],
      caps: true,
      city_marker: 'castle',
      noHalo: [],
    },
  },
]

export const HYPSO_STOPS = HYPSO

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}
