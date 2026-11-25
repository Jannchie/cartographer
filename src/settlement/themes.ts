import { defineSlot, registryOf } from '../kernel'
import { cultureOf } from './culture'
import type { BuildingKind, Culture, Field } from './types'

/**
 * 聚落图主题（绘图风格）的类型与扩展点，以及沙盘地面的底色。主题由插件的 settlement 层入口登记（扩展点 SettleThemes）——
 * 放在 settlement 层而不是 paper 层，是因为沙盘的体块在聚落 Worker 里构建，要用彩绘主题的建筑配色。
 * 内置的八种在 packs/cartography/settlement/themes.ts。
 */

/** 聚落图主题的 id（注册表里的）。内置的有 parchment、color、ink、blueprint、kiriezu、nolli、fangzhi、survey */
export type SettleStyleId = string

/** 建筑配色：每种建筑一组颜色（按建筑的 tone 挑） */
export type BuildingPalette = Record<Exclude<BuildingKind, 'torii'>, string[]>

/**
 * 聚落地图的绘图风格。与文明设定正交；个别颜色（屋顶）随文明而变：
 * 风格给出默认的建筑配色，文明在自己的定义里改其中几项（CultureDef.palettes）。
 */
export interface SettleTheme {
  id: SettleStyleId
  name: string
  desc: string
  /** 纸色（图框外）与地面色 */
  paper: string
  ground: string
  /** 图框线 */
  frame: string
  ink: string
  /** 晕渲：暗部颜色与不透明度 */
  shade: { color: string; alpha: number; light: number }
  contour: { color: string; alpha: number; width: number } | null
  water: string
  waterDeep: string
  /** 岸线外的水线 */
  waterLine: { color: string; alpha: number[] }
  road: { fill: string; casing: string | null }
  /** 城内街道（街坊之间的铺装） */
  street: string
  /** 街区内未建的院落 */
  yard: string
  plaza: string
  /** 建筑配色：按文明（文明可以改默认配色的几项）；不给文明时是这种风格的默认配色 */
  buildings: (culture?: Culture) => BuildingPalette
  /** 鸟居、神桥的朱红（缺省 #c8412a） */
  vermilion?: string
  buildingStroke: { color: string; width: number }
  /** 屋脊线 / 投影 / 排线 */
  roofLines: string | null
  shadow: string | null
  hatch: string | null
  wall: { fill: string; stroke: string }
  fields: Record<Field['kind'], string[]>
  furrow: { color: string; alpha: number }
  green: { park: string; garden: string; cemetery: string; courtyard: string }
  /** 树冠：底色、右下暗面（darkAlpha 缺省 0.55）、描边、右下的投影色 */
  tree: { fill: string; dark: string; stroke: string | null; darkAlpha?: number; shadow?: string }
  magic: string
  label: { color: string; halo: string; water: string; district: string }
  font: { title: string; label: string; italic: string }
  /** 街区（院落）的描边 */
  blockStroke?: { color: string; alpha: number; width: number }
  /** 水面纹样：铜版横纹 lines、正弦波纹 waves、鱼鳞状水波 scallops；step 是行距（米） */
  waterHatch?: { kind: 'lines' | 'waves' | 'scallops'; color: string; alpha: number; width: number; step?: number }
  /** 额外的排线图案，填充色写 url(#id) 引用 */
  patterns?: { id: string; step: number; width: number; cross: boolean; color: string; bg: string }[]
  /** 岸线与护城河岸的颜色（缺省用 ink） */
  waterEdge?: string
  /** 东方文明的中文标题用毛笔字（缺省 true） */
  brushTitle?: boolean
  /** 标题框旁的朱印（印泥色）；缺省不盖 */
  seal?: string
}

/** 扩展点：聚落图主题，按 id 登记（界面上的色块按登记顺序） */
export const SettleThemes = defineSlot<SettleTheme>('settleTheme')

/** 没有选过、或选的主题不可用时用的那个（羊皮纸）；沙盘的地面贴图与建筑配色用的那个（彩绘）。都由内置插件 cartography 登记 */
export const DEFAULT_SETTLE_STYLE: SettleStyleId = 'parchment'
export const DIORAMA_STYLE: SettleStyleId = 'color'

const registry = registryOf(SettleThemes)

/** 已登记的聚落图主题（按登记顺序） */
export const settleThemes = (): SettleTheme[] => registry.all()

/** 这个 id 的主题有没有登记（界面读存下的选择、地址里的参数时先核对，不可用就回到默认并提示） */
export const hasSettleTheme = (id: string): boolean => registry.has(id)

/** 主题的定义；没有登记时抛 MissingContent（所属的插件没有启用，或入口没有先启动插件） */
export const settleTheme = (id: SettleStyleId): SettleTheme => registry.get(id)

/**
 * 主题的建筑配色：默认配色，盖上文明的改动（CultureDef.palettes 里按主题 id 写的那几项）。
 * 登记主题时用它生成 SettleTheme.buildings
 */
export const cultureBuildings =
  (id: SettleStyleId, base: BuildingPalette) =>
  (c?: Culture): BuildingPalette => ({ ...base, ...(c === undefined ? undefined : cultureOf(c).palettes?.[id]) })

/** 一组颜色（同一种东西的几个色调） */
const shades = (...c: string[]) => c

/**
 * 聚落沙盘地面（写实地景）的底色。沙盘以"彩绘"作地面时不用图上的浅色，改用草、土、石本来的颜色，
 * 地面着色器再按材质叠上草皮、垄沟、铺石等细节（见 render/town3d/ground.ts）。
 * 颜色是材质的固有色，明暗交给光照。
 */
export interface DioramaGround {
  /** 野地的草 */
  wild: string
  /** 田埂（田块之间的一条草带）、水田的土埂、牧场的篱笆 */
  balk: string
  bund: string
  fence: string
  fields: Record<Field['kind'], string[]>
  green: { park: string; garden: string; cemetery: string; courtyard: string }
  /** 花坛与镶边的绿篱、耙纹白砂、池水（没有下刻的由着色器画成水面） */
  bed: string
  hedge: string
  gravel: string
  pond: string
  /** 城内街道（铺石或夯土）与路缘、街区里的院地、广场与边石 */
  street: string
  gutter: string
  yard: string
  plaza: string
  curb: string
  /** 官道：路肩、路面、车辙、路中 */
  verge: string
  road: string
  rut: string
  crown: string
  /** 巷子与小径（土路）、台阶 */
  lane: string
  path: string
  stair: string
  /** 护城河的河底与岸 */
  moat: string
  moatBank: string
  /** 城内街道铺石（否则是夯土） */
  paved: boolean
}

export function dioramaGround(culture: Culture): DioramaGround {
  const base: DioramaGround = {
    wild: '#84925a',
    balk: '#7b8a4c',
    bund: '#9a8a66',
    fence: '#6e5d45',
    fields: {
      // 麦田：将熟的金黄、青苗、收过的茬地、翻耕过的土
      crop: shades('#c4ad68', '#a3ad5e', '#b9a877', '#8fa256', '#9a7f5c', '#b5b068'),
      pasture: shades('#8ca05a', '#93a45e'),
      orchard: shades('#84985a'),
      paddy: shades('#74896c', '#7c9070'),
      vineyard: shades('#a49370'),
      garden: shades('#8c7a5c', '#94805e', '#86765a'),
      meadow: shades('#9aaa64', '#a2ae6a'),
    },
    green: { park: '#7a9358', garden: '#82985e', cemetery: '#879465', courtyard: '#8d9a68' },
    bed: '#6f8a4e',
    hedge: '#4f6a3a',
    gravel: '#cfc8b6',
    pond: '#4a6462',
    street: '#a59d8f',
    gutter: '#857e72',
    yard: '#9b946f',
    plaza: '#b3aa98',
    curb: '#8f887a',
    verge: '#8e8a5e',
    road: '#b7a584',
    rut: '#a3906f',
    crown: '#b1a57c',
    lane: '#b09e7e',
    path: '#ad9c7a',
    stair: '#a8a295',
    moat: '#5e5a48',
    moatBank: '#7d7458',
    paved: true,
  }
  // 文明改其中几项（街道的铺装、夯土的颜色、干旱地带的草色……）
  return { ...base, ...cultureOf(culture).ground }
}
