import type { Area } from '../../gen/areas'
import type { World } from '../../gen/types'
import { cjkFont, lang } from '../../i18n'
import { defineSlot, registryOf } from '../../kernel'
import type { RGB } from '../palette'
import type { Fields, Px } from './fields'
import type { GlyphColors } from './glyphs'
import type { PoliticalMode } from './political'
import type { Layers, VectorFields } from './svg/layers'

/**
 * 纸图风格的类型、扩展点与字体方案。风格（Theme）由插件的 paper 层入口登记（扩展点 AtlasStyles）：
 * 一种风格给出位图着色（pixel）与矢量底图（vector）两套画法，以及河流、道路、图框、指北针、图名、注记的样式；
 * 渲染引擎（./index.ts 的位图、./svg/vector.ts 的矢量）只读这些字段，不按风格的 id 分支。
 * 内置的八种在 packs/cartography/paper/。
 */

/** 纸图风格的 id（注册表里的）。内置的有 physical、fantasy、nautical、teyvat、ink、topo、political、strategy */
export type StyleId = string

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
  /** 中文、日文字体（衬线、无衬线）；不给就用 cjkFont 的思源宋体 / 黑体。字体方案（FontPreset）会填它 */
  cjk?: { zh: [serif: string, sans: string]; ja: [serif: string, sans: string] }
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
  /** 位图着色：逐像素算底色、晕渲与线划（o 是这个像素的 RGB，就地改写） */
  pixel: (p: Px, o: Float32Array, f: Fields, opts: AtlasOpts) => void
  /**
   * 矢量底图：用图层工具（./svg/layers.ts）把与 pixel 对应的底色、色带、晕渲、线划画成矢量图层。
   * 返回一个函数时，它留到政区着色之后再执行（政区专题风格的晕渲、湖泊与海岸线要压在色块之上）
   */
  vector: (L: Layers, world: World, F: VectorFields, env: { opts: AtlasOpts; S: number }) => void | (() => void)
  river: { color: string; width: number; minFlow: number; fitCoast?: boolean }
  /** 道路（干道；支线更细）与跨海航线（虚线）。dash 以 S=2 时的像素计 */
  roads: RoadStyle
  frame: 'atlas' | 'ornate' | 'ink' | 'none'
  compass: 'star' | 'ornate' | 'nautical' | 'north' | 'none'
  cartouche: 'box' | 'scroll' | 'nautical' | 'ink' | 'game'
  graticule: string | null
  /** 手绘的山形、树林符号：给了配色就画 */
  glyphs?: GlyphColors
  rhumb?: boolean
  soundings?: boolean
  realms?: boolean
  legend?: 'realms' | 'hypsometric'
  /** 分层设色的色标（海拔 km → 颜色）：legend 为 hypsometric 时图例按它画 */
  hypsometric?: [number, RGB][]
  /** 方框图名（cartouche 为 box）的样式：sans 用无衬线的粗体、字距收紧；subtitle 是图名下的副题（中文键），不给用通用的副题 */
  titleBox?: { sans?: boolean; subtitle?: string }
  /** 政区图的画法 */
  political: PoliticalLook
  /** 政区专题风格：政区开关为"无"时也按这个模式着色 */
  politicalDefault?: PoliticalMode
  /** 纸纹（水渍、颗粒），默认有；游戏地图这类非纸质风格关掉 */
  paperTexture?: boolean
  /** 做旧（矢量版）：水渍偏褐、四角有焦边 */
  aged?: boolean
  labels: LabelTheme
}

// —— 注记用的西文、中文字族（各风格与字体方案共用） ——
export const CORMORANT = '"Cormorant Garamond", Georgia, serif'
export const FELL = '"IM Fell English", "Cormorant Garamond", Georgia, serif'
export const FELL_SC = '"IM Fell English SC", "IM Fell English", Georgia, serif'
export const SANS = '"Source Sans 3", "Helvetica Neue", Arial, sans-serif'
export const BRUSH = '"Ma Shan Zheng", "Noto Serif SC", "STKaiti", "KaiTi", serif'
export const SONG = '"Noto Serif SC", "Songti SC", "SimSun", serif'

/** 扩展点：纸图风格，按 id 登记（界面上的色块按登记顺序） */
export const AtlasStyles = defineSlot<Theme>('atlasStyle')

/** 没有选过、或选的风格不可用时用的那个：内置插件 cartography 登记 */
export const DEFAULT_ATLAS_STYLE: StyleId = 'physical'

const styles = registryOf(AtlasStyles)

/** 已登记的纸图风格（按登记顺序） */
export const atlasStyles = (): Theme[] => styles.all()

/** 这个 id 的纸图风格有没有登记（界面读存下的选择时先核对，不可用就回到默认并提示） */
export const hasAtlasStyle = (id: string): boolean => styles.has(id)

// ———————————————————————— 字体方案 ————————————————————————

/**
 * 注记字体方案：替换风格自带的西文大字（display）、正文（text）与中日文字体。
 * css 是额外要加载的 Google Fonts 族（family= 参数），选中时才加载
 */
export interface FontPreset {
  id: string
  name: string
  desc: string
  display?: string
  text?: string
  cjk?: NonNullable<LabelTheme['cjk']>
  css?: string
}

export const FONT_PRESETS: FontPreset[] = [
  { id: 'theme', name: '跟随风格', desc: '每种风格自带的字体' },
  {
    id: 'classic',
    name: '衬线',
    desc: 'Cormorant · 思源宋体',
    display: CORMORANT,
    text: CORMORANT,
    cjk: { zh: [SONG, '"Noto Sans SC", sans-serif'], ja: ['"Noto Serif JP", serif', '"Noto Sans JP", sans-serif'] },
  },
  {
    id: 'modern',
    name: '无衬线',
    desc: 'Source Sans · 思源黑体',
    display: SANS,
    text: SANS,
    cjk: { zh: ['"Noto Sans SC", sans-serif', '"Noto Sans SC", sans-serif'], ja: ['"Noto Sans JP", sans-serif', '"Noto Sans JP", sans-serif'] },
  },
  {
    id: 'woodblock',
    name: '刻本',
    desc: 'IM Fell · 站酷小薇 · しっぽり明朝',
    display: FELL_SC,
    text: FELL,
    cjk: { zh: ['"ZCOOL XiaoWei", "Noto Serif SC", serif', '"ZCOOL XiaoWei", "Noto Serif SC", serif'], ja: ['"Shippori Mincho", "Noto Serif JP", serif', '"Shippori Mincho", "Noto Serif JP", serif'] },
    css: 'family=ZCOOL+XiaoWei&family=Shippori+Mincho:wght@400;600',
  },
  {
    id: 'brush',
    name: '书法',
    desc: 'Cinzel · 马善政楷书 · 佑字肃',
    display: '"Cinzel", "Cormorant Garamond", serif',
    text: CORMORANT,
    cjk: { zh: [BRUSH, BRUSH], ja: ['"Yuji Syuku", "Noto Serif JP", serif', '"Yuji Syuku", "Noto Serif JP", serif'] },
    css: 'family=Cinzel:wght@400;600;700&family=Yuji+Syuku',
  },
  {
    id: 'rounded',
    name: '圆体',
    desc: 'Nunito · 站酷快乐体 · M PLUS 圆体',
    display: '"Nunito", "Source Sans 3", sans-serif',
    text: '"Nunito", "Source Sans 3", sans-serif',
    cjk: { zh: ['"ZCOOL KuaiLe", "Noto Sans SC", sans-serif', '"ZCOOL KuaiLe", "Noto Sans SC", sans-serif'], ja: ['"M PLUS Rounded 1c", "Noto Sans JP", sans-serif', '"M PLUS Rounded 1c", "Noto Sans JP", sans-serif'] },
    css: 'family=Nunito:ital,wght@0,400;0,600;0,700;1,400&family=ZCOOL+KuaiLe&family=M+PLUS+Rounded+1c:wght@400;700',
  },
]

/** 当前的字体方案（界面上选的，全部纸图共用；themeById 取风格时套上） */
let fontPreset: FontPreset = FONT_PRESETS[0]
export function setFontPreset(id: string) {
  fontPreset = FONT_PRESETS.find((f) => f.id === id) ?? FONT_PRESETS[0]
}
export const currentFontPreset = () => fontPreset

const themed = new Map<string, Theme>()
/** 风格（套上当前的字体方案）；没有登记时抛 MissingContent（所属的插件没有启用，或入口没有先启动插件） */
export function themeById(id: StyleId): Theme {
  const t = styles.get(id)
  const f = fontPreset
  if (f.id === 'theme') return t
  const key = `${t.id}|${f.id}`
  let out = themed.get(key)
  if (!out) {
    out = { ...t, labels: { ...t.labels, display: f.display ?? t.labels.display, text: f.text ?? t.labels.text, cjk: f.cjk } }
    themed.set(key, out)
  }
  return out
}

/** 这种风格的中文、日文字体（英文界面不用，回退到通用族） */
export function themeCjk(theme: Theme, sans = false): string {
  const c = theme.labels.cjk
  if (c && (lang === 'zh' || lang === 'ja')) return c[lang][sans ? 1 : 0]
  return cjkFont(lang, sans)
}
