import { Biome } from '../../gen/types'
import { edt } from '../../gen/util'
import { ATLAS, atlasSea, ramp, type RGB } from '../palette'
import { Fields, fnoise, hash, line, mix, mixc, paperGrain, set, sm, vnoise, type Px } from './fields'

export type StyleId = 'physical' | 'fantasy' | 'nautical' | 'political' | 'ink' | 'topo'

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
  river: { color: string; width: number; minFlow: number }
  frame: 'atlas' | 'ornate' | 'ink'
  compass: 'star' | 'ornate' | 'nautical' | 'north' | 'none'
  cartouche: 'box' | 'scroll' | 'nautical' | 'ink'
  graticule: string | null
  glyphs?: boolean
  rhumb?: boolean
  soundings?: boolean
  realms?: boolean
  legend?: 'realms' | 'hypsometric'
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
const PARCH = hex('#e6d3a7')
const PARCH_LAND = hex('#ecdcb5')
const PARCH_SEA = hex('#c9c7a4')
const SEPIA = hex('#4a3624')
function fantasyPixel(p: Px, o: Float32Array, f: Fields) {
  const { px, py } = p
  if (p.h <= 0) {
    // 近岸一圈淡墨绿晕染，向外渐隐到纸色
    const d = -p.coast
    set(o, PARCH)
    mixc(o, PARCH_SEA, 0.35 + 0.55 * Math.exp(-d / 26))
    seaIce(p, o, [240, 232, 210])
    const rip = [4, 8, 13, 19, 27]
    for (let k = 0; k < rip.length; k++) mixc(o, SEPIA, (1 - sm(0.3, 0.95, Math.abs(d - rip[k] * (f.S / 2)))) * (0.4 - k * 0.07))
  } else {
    set(o, PARCH_LAND)
    // 极淡的群系色与晕渲，让地形隐约可辨
    const [cr, cg, cb] = f.biomeColors('atlas', ATLAS)
    mix(o, f.sample(cr, p.gx, p.gy), f.sample(cg, p.gx, p.gy), f.sample(cb, p.gx, p.gy), 0.22)
    const sh = 1 + (p.shade - 1) * 0.35
    o[0] *= sh
    o[1] *= sh
    o[2] *= sh
    lakeFill(p, o, [205, 200, 170], SEPIA, 0.8)
  }
  coastInk(p, o, SEPIA, 1.25, 0.95)
  // 陈旧感：水渍、霉斑与四周焦边
  const stain = fnoise(px, py, 110) * 0.65 + fnoise(px + 999, py, 28) * 0.35
  mix(o, 170, 140, 95, sm(0.55, 0.85, stain) * 0.2)
  const ex = Math.min(px, f.MW - px) / f.MW
  const ey = Math.min(py, f.MH - py) / f.MH
  const edge = 1 - sm(0, 0.12, Math.min(ex, ey * 1.4) + (fnoise(px, py, 45) - 0.5) * 0.04)
  mix(o, 120, 82, 45, edge * 0.55)
  paperGrain(o, px, py, 1.3)
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

// ————————————————————————————————— 政区图 —————————————————————————————————
function politicalPrepare(f: Fields) {
  if (f.cache.has('border')) return
  const { W, H, world } = f
  const r = world.realm
  const mask = new Uint8Array(W * H)
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x
      const a = r[i]
      if (a < 0) continue
      const b = r[i + 1]
      const c = r[i + W]
      if ((b >= 0 && b !== a) || (c >= 0 && c !== a)) mask[i] = 1
    }
  }
  f.cache.set('border', edt(mask, W, H))
}
function politicalPixel(p: Px, o: Float32Array, f: Fields) {
  const S = f.S
  if (p.h <= 0) {
    set(o, hex('#cfe0e4'))
    mix(o, 170, 200, 210, Math.exp(-(-p.coast) / 30) * 0.6)
    seaIce(p, o, [244, 246, 246])
    for (const r of [5, 11]) mix(o, 90, 130, 150, (1 - sm(0.35, 1, Math.abs(-p.coast - r * (S / 2)))) * 0.18)
  } else {
    const id = f.world.realm[p.i]
    set(o, [243, 238, 226])
    if (id >= 0) {
      const c = REALM_COLORS[f.world.realms[id].color]
      const bd = f.sample(f.cache.get('border') as Float32Array, p.gx, p.gy) * S
      // 国界内侧加深的色带（经典政区图的"晕边"）
      mixc(o, c, 0.62)
      mix(o, c[0] * 0.78, c[1] * 0.78, c[2] * 0.78, Math.exp(-bd / 7) * 0.75)
      // 国界线：点划线
      const dash = ((p.px >> 2) + (p.py >> 2)) % 3 !== 0 ? 1 : 0.25
      mix(o, 120, 50, 55, line(bd, 0.75) * 0.85 * dash)
    }
    const sh = 1 + (p.shade - 1) * 0.3
    o[0] *= sh
    o[1] *= sh
    o[2] *= sh
    lakeFill(p, o, hex('#cfe0e4'), [70, 100, 120])
  }
  coastInk(p, o, [60, 70, 76], 0.8)
  paperGrain(o, p.px, p.py, 0.5)
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
    river: { color: 'rgba(74, 70, 70, 0.9)', width: 0.9, minFlow: 2.2 },
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
    id: 'political',
    name: '政区图',
    desc: '国家 · 国界 · 都城',
    paper: hex('#f3eee2'),
    ink: '#3c4448',
    prepare: politicalPrepare,
    pixel: politicalPixel,
    river: { color: 'rgba(70, 120, 150, 0.85)', width: 0.8, minFlow: 2.5 },
    frame: 'atlas',
    compass: 'star',
    cartouche: 'box',
    graticule: 'rgba(60, 80, 90, 0.2)',
    realms: true,
    legend: 'realms',
    labels: {
      display: CORMORANT,
      text: CORMORANT,
      water: '#4b6c7c',
      land: 'rgba(60, 50, 40, 0.5)',
      range: '#6c533c',
      region: '#6f5c48',
      city: '#2a2622',
      halo: 'rgba(243, 238, 226, 0.75)',
      zh: false,
      vertical: [],
      caps: true,
      city_marker: 'star',
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
