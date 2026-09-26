import { Biome, type World } from '../../gen/types'
import { blur, edt } from '../../gen/util'
import { ATLAS, atlasSea, ramp, type RGB } from '../palette'
import { Fields, fnoise, hash, line, mix, mixc, paperGrain, set, sm, vnoise, type Px } from './fields'

export type StyleId = 'physical' | 'fantasy' | 'nautical' | 'teyvat' | 'ink' | 'topo'

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
  /** 使用中文名 */
  zh: boolean
  /** 竖排的注记类型 */
  vertical: string[]
  /** 大写与字距 */
  caps: boolean
  city_marker: 'dot' | 'castle' | 'square' | 'star'
  /** 不描边的注记类型（默认海洋、海、大陆：大字直接压在浅色底图上）；彩色底图上的白字要全部描边 */
  noHalo?: string[]
}

export interface AtlasOpts {
  labels: boolean
  contours: boolean
  graticule: boolean
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
  frame: 'atlas' | 'ornate' | 'ink' | 'none'
  compass: 'star' | 'ornate' | 'nautical' | 'north' | 'none'
  cartouche: 'box' | 'scroll' | 'nautical' | 'ink' | 'game'
  graticule: string | null
  glyphs?: boolean
  rhumb?: boolean
  soundings?: boolean
  realms?: boolean
  legend?: 'realms' | 'hypsometric'
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

export const THEMES: Theme[] = [
  {
    id: 'physical',
    name: '自然地理',
    desc: '分层设色 · 晕渲',
    paper: hex('#f1ead8'),
    ink: '#3a4246',
    pixel: physicalPixel,
    river: { color: 'rgba(78, 122, 146, 0.92)', width: 1, minFlow: 1.8 },
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
      zh: false,
      vertical: [],
      caps: true,
      city_marker: 'dot',
    },
  },
  {
    id: 'fantasy',
    name: '奇幻羊皮',
    desc: '手绘山形 · 树林符号',
    paper: hex('#dcc596'),
    ink: '#4a3624',
    pixel: fantasyPixel,
    river: { color: 'rgba(48, 70, 88, 0.95)', width: 1.15, minFlow: 2, fitCoast: true },
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
      zh: false,
      vertical: [],
      caps: true,
      city_marker: 'castle',
    },
  },
  {
    id: 'nautical',
    name: '航海图',
    desc: '测深 · 恒向线',
    paper: hex('#efe9da'),
    ink: '#1f2a33',
    pixel: nauticalPixel,
    river: { color: 'rgba(60, 110, 150, 0.85)', width: 0.8, minFlow: 3 },
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
      zh: false,
      vertical: [],
      caps: true,
      city_marker: 'dot',
    },
  },
  {
    id: 'teyvat',
    name: '提瓦特',
    desc: '原神风 · 平涂台地 · 星空边界',
    paper: TEYVAT.void,
    ink: '#f2f0e6',
    pixel: teyvatPixel,
    river: { color: 'rgba(88, 150, 152, 0.95)', width: 1.1, minFlow: 2, fitCoast: true },
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
      zh: false,
      vertical: [],
      caps: true,
      city_marker: 'dot',
      noHalo: [],
    },
  },
  {
    id: 'ink',
    name: '水墨',
    desc: '青绿山水 · 中文注记',
    paper: hex('#e6ddc6'),
    ink: '#2b2a27',
    pixel: inkPixel,
    river: { color: 'rgba(60, 62, 60, 0.75)', width: 0.8, minFlow: 2.2 },
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
      zh: true,
      vertical: ['continent', 'ocean', 'range', 'realm'],
      caps: false,
      city_marker: 'square',
    },
  },
  {
    id: 'topo',
    name: '等高线',
    desc: '现代地形图',
    paper: hex('#fbfaf6'),
    ink: '#2d3a44',
    pixel: topoPixel,
    river: { color: 'rgba(50, 110, 160, 0.95)', width: 0.8, minFlow: 1.8 },
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
      zh: false,
      vertical: [],
      caps: true,
      city_marker: 'dot',
    },
  },
]

export const HYPSO_STOPS = HYPSO

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}
