import { area as polyArea } from './geom'
import type { Settlement, WardType } from './types'
import * as dmath from '../gen/dmath'

/**
 * 区划（用地性质）：把片区功能归成少数几类，区划视图按类着色。
 * 颜色取自分类色板（dataviz 默认的 8 色，按固定顺序取前 7 个），亮底与暗底（蓝图）各一套；
 * 城郊农田不占分类色，用中性的橄榄灰淡淡铺一层。
 */
export type LandUse = 'civic' | 'commerce' | 'public' | 'residential' | 'faith' | 'craft' | 'harbor' | 'rural'

export interface LandUseDef {
  id: LandUse
  /** 中文名（也是 i18n 的键） */
  name: string
  /** 亮底 / 暗底的颜色 */
  light: string
  dark: string
}

export const LAND_USES: LandUseDef[] = [
  { id: 'civic', name: '官署与军事', light: '#2a78d6', dark: '#3987e5' },
  { id: 'commerce', name: '商业', light: '#eb6834', dark: '#d95926' },
  { id: 'public', name: '公共空间', light: '#1baf7a', dark: '#199e70' },
  { id: 'residential', name: '住宅', light: '#eda100', dark: '#c98500' },
  { id: 'faith', name: '宗教与奇观', light: '#e87ba4', dark: '#d55181' },
  { id: 'craft', name: '工坊', light: '#008300', dark: '#008300' },
  { id: 'harbor', name: '港口与仓储', light: '#4a3aa7', dark: '#9085e9' },
  { id: 'rural', name: '城郊农田', light: '#8f8a62', dark: '#8fa39a' },
]

/** 片区功能 → 区划类；野地与水域不着色 */
const LAND_USE_OF: Record<WardType, LandUse | null> = {
  castle: 'civic',
  barracks: 'civic',
  observatory: 'civic',
  market: 'commerce',
  merchant: 'commerce',
  exchange: 'commerce',
  plaza: 'public',
  park: 'public',
  common: 'residential',
  slum: 'residential',
  noble: 'residential',
  suburb: 'residential',
  temple: 'faith',
  cemetery: 'faith',
  magic: 'faith',
  craft: 'craft',
  guild: 'craft',
  harbor: 'harbor',
  warehouse: 'harbor',
  farm: 'rural',
  wild: null,
  water: null,
}

/** 按要素占整块片区的类型（剧场、竞技场、磨坊这类，片区 type 直接写要素名） */
const EXTRA: Record<string, LandUse> = {
  amphitheater: 'public',
  arena: 'public',
  stage: 'public',
  pulpit: 'public',
  tavern: 'public',
  subcenter: 'public',
  hospital: 'public',
  school: 'public',
  gallows: 'public',
  lighthouse: 'harbor',
  mill: 'craft',
  windmill: 'craft',
  kiln: 'craft',
  winery: 'craft',
  barbican: 'civic',
  portal: 'faith',
}

/** 片区类型 → 区划类（未知类型不着色） */
export function landUseOf(type: string): LandUse | null {
  return LAND_USE_OF[type as WardType] ?? EXTRA[type] ?? null
}

export interface LandUseStat {
  id: LandUse
  /** 面积（公顷） */
  ha: number
  /** 占城区面积的比例（城区不含城郊与农田）；城郊农田为 0 */
  share: number
}

/** 各区划类的面积；只列出现了的类，顺序同 LAND_USES */
export function landUseStats(st: Settlement): LandUseStat[] {
  const area = new Map<LandUse, number>()
  const core = new Map<LandUse, number>()
  for (const w of st.wards) {
    const u = landUseOf(w.type)
    if (!u) continue
    const a = polyArea(w.poly)
    area.set(u, (area.get(u) ?? 0) + a)
    if (u !== 'rural' && w.type !== 'suburb') core.set(u, (core.get(u) ?? 0) + a)
  }
  let urban = 0
  for (const a of core.values()) urban += a
  return LAND_USES.filter((d) => area.has(d.id)).map((d) => ({ id: d.id, ha: area.get(d.id)! / 10000, share: urban ? (core.get(d.id) ?? 0) / urban : 0 }))
}

/** 底色是否为暗色（蓝图）：按相对亮度判断 */
export function isDarkGround(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : dmath.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 0.18
}

export const landUseColor = (u: LandUse, dark: boolean) => {
  const d = LAND_USES.find((x) => x.id === u)!
  return dark ? d.dark : d.light
}
