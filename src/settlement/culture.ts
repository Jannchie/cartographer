import type { Ctx } from './ctx'
import type { FeatureId } from './features'
import type { P, Poly } from './geom'
import type { PlanId } from './plans/types'
import type { Culture, Ward, WardType } from './types'

/**
 * 文明：决定一座城用什么形制、盖什么样的房子、起什么样的名字。
 * - 西方：中世纪欧洲，城堡、教堂、广场与市民住宅
 * - 东方：中国，四合院、中轴对称的宫城与寺观、里坊
 * - 和风：日本，町家、武家屋敷、寺社与天守
 * - 伊斯兰：中东与北非，内院住宅、清真寺、集市与浴场
 */
export interface CultureInfo {
  id: Culture
  /** 中文名、英文名、日文名 */
  name: [zh: string, en: string, ja: string]
  desc: string
  /** 可选的规划形制（有机生长总是可选） */
  plans: Exclude<PlanId, 'organic'>[]
  /** 东亚的木构体系：水田、默认挖护城河、汉字书法字体这些东方与和风共有的 */
  eastAsian: boolean
  /** 每户人数 */
  perHousehold: number
  /** 城墙选"自动"时修不修（和风的城下町不筑外郭，靠城堡与寺町防守；要塞城照修） */
  autoWalls: boolean
  /** 最外一道石墙总挖护城河（否则要塞城挖，别的城大多挖） */
  moat: boolean
  /** 城扩出去以后，上一道石墙留作内城（子城 / 内城外郭）；否则拆了筑环城大道，留几段残墙 */
  innerWall: boolean
  /** 宫城坐北朝南（否则顺着地块的长轴） */
  palaceSouth: boolean
  /** 各家的祖坟散在城外的坡地上（城里不设公共墓园，见 rural.ts 的 hillTombs） */
  tombs?: boolean
  /** 这个文明没有的要素（自动数量为 0，手动仍可加） */
  exclude?: FeatureId[]
}

export const CULTURE_INFO: Record<Culture, CultureInfo> = {
  western: {
    id: 'western',
    name: ['西式', 'Western', '西洋'],
    desc: '中世纪欧洲式：城堡、教堂、广场与市民住宅',
    plans: ['castrum', 'bastide'],
    eastAsian: false,
    perHousehold: 5.5,
    autoWalls: true,
    moat: false,
    innerWall: false,
    palaceSouth: false,
  },
  eastern: {
    id: 'eastern',
    name: ['东方', 'Chinese', '中華'],
    desc: '里坊民居、中轴对称的宫城与寺观、四合院',
    plans: ['lifang'],
    eastAsian: true,
    perHousehold: 4.2,
    autoWalls: true,
    moat: true,
    innerWall: true,
    palaceSouth: true,
    tombs: true,
    // 唐律"京城内不得葬"：城里没有墓园，坟地在城外（见 tombs）
    exclude: ['windmill', 'cemetery'],
  },
  wa: {
    id: 'wa',
    name: ['和风', 'Japanese', '和風'],
    desc: '町家与武家屋敷、寺社、天守与城下町',
    // 平安京、平城京的条坊制照搬唐长安
    plans: ['jokamachi', 'lifang'],
    eastAsian: true,
    perHousehold: 4.5,
    autoWalls: false,
    moat: true,
    innerWall: false,
    palaceSouth: true,
    // 墓地附在寺院里（寺町），不单独成片
    exclude: ['amphitheater', 'pulpit', 'winery', 'windmill', 'cemetery'],
  },
  islamic: {
    id: 'islamic',
    name: ['伊斯兰', 'Islamic', 'イスラーム'],
    desc: '内院住宅与尽端巷、清真寺、集市与浴场',
    plans: ['medina'],
    eastAsian: false,
    perHousehold: 6,
    autoWalls: true,
    moat: false,
    innerWall: false,
    palaceSouth: false,
    // 没有剧场、竞技场、比武场与酒庄
    exclude: ['stage', 'pulpit', 'amphitheater', 'arena', 'winery', 'windmill'],
  },
}

export const CULTURES = Object.keys(CULTURE_INFO) as Culture[]

/** 东亚（东方、和风）共有的做法 */
export const eastAsian = (c: Culture) => CULTURE_INFO[c].eastAsian

/** 形制与文明是否相配 */
export const planFits = (c: Culture, plan: PlanId | undefined) => !plan || plan === 'organic' || CULTURE_INFO[c].plans.includes(plan)

/**
 * 文明自己的盖法：规划区外的有机片区也按本文明的样式盖（和风的町家、伊斯兰的内院住宅……）。
 * 返回 true 表示已经盖好；false 交给通用的填法（features.ts）。
 */
export interface CultureStyle {
  buildWard?(ctx: Ctx, ward: Ward, block: Poly): boolean
  /** 规划形制（里坊）里一块坊内地的住宅；false 用通用的街坊 */
  plotFill?(ctx: Ctx, plot: Poly, type: WardType): boolean
  /** 城外的农舍：lot 是宅地，front 是临路边的起点，n 朝宅地里；false 用通用的农舍 */
  farmstead?(ctx: Ctx, lot: Poly, front: P, n: P): boolean
}
