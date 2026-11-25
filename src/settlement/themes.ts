import { defineSlot, registryOf } from '../kernel'
import { cultures } from './culture'
import type { BuildingKind, Culture, Field } from './types'

/**
 * 聚落图主题（绘图风格）的类型与扩展点，以及沙盘地面的底色。主题由插件的 settlement 层入口登记（扩展点 SettleThemes）——
 * 放在 settlement 层而不是 paper 层，是因为沙盘的体块在聚落 Worker 里构建，要用主题里的沙盘配色。
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
  /** 建筑的默认配色。文明可以改其中几项（CultureDef.palettes），用的时候由 buildingPalette 合并 */
  buildingBase: BuildingPalette
  /** 文明对建筑配色的改动按哪个主题的 id 取（CultureDef.palettes 的键）：缺省是本主题；由别的主题换色而来的主题指向它的父主题 */
  paletteOf?: SettleStyleId
  /**
   * 沙盘（三维）的配色：体块的建筑配色（连同文明的改动按哪个主题取）与法术色。给了它的主题作沙盘地面时体块按它着色，
   * 没给的用默认主题的（dioramaOf）。ground 为 true 表示作沙盘地面时按写实地景画——草、土、石的固有色加材质掩膜，
   * 而不是这种主题的地图
   */
  diorama?: DioramaLook
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

/** 沙盘的配色（见 SettleTheme.diorama） */
export interface DioramaLook {
  buildingBase: BuildingPalette
  paletteOf: SettleStyleId
  magic: string
  ground?: boolean
}

/** 扩展点：聚落图主题，按 id 登记（界面上的色块按登记顺序）。默认条目是没有选过、或选的主题不可用时用的那个，它要带沙盘的配色 */
export const SettleThemes = defineSlot<SettleTheme>('settleTheme', { zh: '绘图风格', en: 'map style', ja: '描画スタイル' })

/** 聚落图主题的注册表 */
export const settleThemes = registryOf(SettleThemes)

/**
 * 建筑配色：默认配色盖上文明的改动（文明按主题 id 写的那几项）；不给文明时就是默认配色。
 * src 是主题，或主题的沙盘配色
 */
export function buildingPalette(src: { buildingBase: BuildingPalette; paletteOf?: SettleStyleId; id?: SettleStyleId }, culture?: Culture): BuildingPalette {
  const key = src.paletteOf ?? src.id
  return { ...src.buildingBase, ...(culture === undefined || key === undefined ? undefined : cultures.get(culture).palettes?.[key]) }
}

/** 沙盘的配色：地面主题自己的；它没有（或这个主题没有登记）时用默认主题的 */
export function dioramaOf(ground?: SettleStyleId): DioramaLook {
  const own = ground !== undefined && settleThemes.has(ground) ? settleThemes.get(ground).diorama : undefined
  const look = own ?? settleThemes.get(settleThemes.defaultId()).diorama
  if (!look) throw new Error('默认的聚落图主题没有沙盘配色（SettleTheme.diorama）')
  return look
}

/** 两套沙盘配色是不是同一套（体块要不要重建） */
export const sameDiorama = (a: DioramaLook, b: DioramaLook) => a.buildingBase === b.buildingBase && a.paletteOf === b.paletteOf && a.magic === b.magic

/**
 * 沙盘地面可选的主题当作一种可引用的内容（界面核对存下的沙盘选项时用）：
 * 不可用时回到按写实地景画地面的那个主题，没有这样的主题就是默认主题
 */
export const groundStyles = {
  label: { zh: '沙盘地面风格', en: 'diorama ground style', ja: 'ジオラマの地面スタイル' },
  has: (id: string) => settleThemes.has(id),
  defaultId: (): SettleStyleId => settleThemes.all().find((t) => t.diorama?.ground)?.id ?? settleThemes.defaultId(),
}

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
  return { ...base, ...cultures.get(culture).ground }
}
