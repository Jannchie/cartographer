import { defineSlot, registryOf } from '../kernel'
import type { Ctx } from './ctx'
import type { CultureLexicon } from './describe'
import type { FeatureId } from './features'
import type { GardenTradition } from './garden/kit'
import type { P, Poly } from './geom'
import type { CultureNaming } from './names'
import type { CulturePeople } from './people'
import type { CityPlan, PlanId } from './plans/types'
import type { SacredTry } from './sacred'
import type { CultureHousing } from './scale'
import type { FieldTraits, Motif } from './tensor'
import type { BuildingPalette, DioramaGround, SettleStyleId } from './themes'
import type { CultureTiers } from './tiers'
import type { Culture, Ward, WardType } from './types'

/**
 * 文明的注册表。文明（Culture）决定一座城用什么形制、盖什么样的房子、起什么样的名字；
 * 它是一个字符串 id，对应一份 CultureDef。聚落生成的各个环节不按 id 分支，而是读这份定义里的
 * 能力标记、数据表，或调用它的钩子——新增一种文明只需要写一份 CultureDef 并注册，不需要改生成器。
 *
 * 文明由插件登记（扩展点 Cultures）：一个插件带一组相互配套的文明（内置的 classic 包含西式、东方、和风、伊斯兰），
 * 在它的 settlement 层入口里用 register.ts 的 registerCultures 登记。文明与世界层的命名风格
 *（gen/naming.ts）是两回事：命名风格决定世界地图上的地名怎么起，文明提供聚落的建法；
 * 两者由世界观的城镇文明规则对应起来（gen/setting.ts）。
 *
 * 本模块除内核外只有类型导入，不依赖任何具体的文明，也不导入插件：各入口（main.ts、两个 Worker、离线脚本）
 * 先启动插件（packs/boot.ts）再调用生成器。文明的 id 写在聚落的种子里（generate.ts），登记后不能改名。
 * 沙盘（render/town3d）的建筑套件是另一个扩展点（render/town3d/kits.ts），按同一个文明 id 对应。
 */

/** 能力标记与基本参数：生成器里按文明分支的地方读这里 */
export interface CultureTraits {
  /**
   * 东亚的木构院落体系。通用填法（wards.ts、civic.ts、features.ts）内置院落式与西式两套衙署、寺观、市集的盖法，
   * 按这一项选用；两套都不合适的文明由 CultureStyle 的钩子整体接管
   */
  eastAsian: boolean
  /** 气候合适时种水田 */
  paddy: boolean
  /** 图名用书法字体（汉字文化圈） */
  brushTitle: boolean
  /** 奇幻城依山时，山上立一座宗门，石阶从城门上山 */
  hillSect: boolean
  /** 每户人数 */
  perHousehold: number
  /** 城墙选"自动"时修不修（和风的城下町不筑外郭，靠城堡与寺町防守；要塞城照修） */
  autoWalls: boolean
  /** 最外一道石墙总挖护城河（否则要塞城挖，别的城大多挖） */
  moat: boolean
  /** 城扩出去以后，上一道石墙留作内城（子城 / 内城外郭）；否则拆了筑环城大道，留几段残墙 */
  innerWall: boolean
  /** 都城宫城的朝向：south 坐北朝南；center 正面朝城心（进深沿着离开城心的方向） */
  palaceFacing: 'south' | 'center'
  /** 合成的大地标（宫城、大寺社）的轴线：grid 按方格朝向摆（宫城正南北）；lot 顺着合成地块的长轴 */
  compoundAxis: 'grid' | 'lot'
  /** 各家的祖坟散在城外的坡地上（城里不设公共墓园，见 rural.ts 的 hillTombs） */
  tombs?: boolean
  /** 这个文明没有的要素（自动数量为 0，手动仍可加） */
  exclude?: FeatureId[]
  /** 合成的大寺社四周林木的密度（株 / 平方米）：镇守之森密，寺林、教堂草地疏 */
  templeGrove: number
  /** 城外大路边的祠、十字架每隔多少米一处 */
  waysideGap: number
}

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
  /** 城里街网的参数：在母题定好的值上改（见 tensor.ts 的 fieldTraits） */
  streets?(t: FieldTraits): void
}

/** 一种文明的全部定义 */
export interface CultureDef {
  id: Culture
  /** 名称与说明（中文键，界面按语言翻译） */
  name: string
  desc: string
  traits: CultureTraits
  /** 可选的规划形制（有机生长总是可选）。同一种形制在不同文明里可以有自己的变体与叫法（和风的条坊制是里坊的变体） */
  plans: CityPlan[]
  /** 片区、农舍、街网的盖法；空对象表示全用通用填法 */
  style: CultureStyle
  /** 聚落、片区、街巷、城门、地标的起名规则（names.ts） */
  naming: CultureNaming
  /** 悬停说明里按文明的叫法与作物（describe.ts） */
  lexicon: CultureLexicon
  /** 职业分法、专门片区的人口密度（people.ts） */
  people: CulturePeople
  /** 民居密度的实测值（scale.ts） */
  housing: CultureHousing
  /** 偏好的街网母题（权重，tensor.ts） */
  motifBias: Record<Motif, number>
  /** small / micro 规模档的地标：堂区教堂、村社、祠堂、路边的祠……（tiers.ts） */
  tiers: CultureTiers
  /** 名所：按地形才有的招牌布置，k 是随规模、功效的倍率（sacred.ts）；不填没有 */
  sacred?(ctx: Ctx, k: number): SacredTry[]
  /** 造园传统：园林的预设与元素池按它挑（garden/） */
  garden: GardenTradition
  /** 要素在这个文明里的叫法（缺省用要素自己的名字，features.ts 的 featureName） */
  featureNames?: Partial<Record<FeatureId, string>>
  /** 各绘图风格里建筑配色的改动：盖在该风格的默认配色之上（themes.ts） */
  palettes?: Partial<Record<SettleStyleId, Partial<BuildingPalette>>>
  /** 沙盘地面配色的改动：盖在默认配色之上（themes.ts 的 dioramaGround） */
  ground?: Partial<DioramaGround>
}

/** 扩展点：文明，按文明 id 登记（界面上的选项按登记顺序）。默认条目是没有指定文明时用的那个 */
export const Cultures = defineSlot<CultureDef>('culture', { zh: '文明', en: 'culture', ja: '文明' })

/** 文明的注册表：get 取定义（没有登记的 id 抛错：入口没有先启动插件，或参数里的文明来自没有启用的插件） */
export const cultures = registryOf(Cultures)

// —————————————————————— 城市形制 ——————————————————————

/** 界面用：有机生长的名称与说明（它不是规划，不在各文明的 plans 里） */
const ORGANIC_PLAN = { id: 'organic' as PlanId, name: '有机生长', desc: '沿干道、河流自然长成的街巷' }

/** 这个文明里的某种形制（含它在这个文明里的变体）；有机生长、别的文明的形制返回 undefined */
export const planOf = (c: Culture, id: PlanId | undefined): CityPlan | undefined => (id && id !== 'organic' ? cultures.get(c).plans.find((p) => p.id === id) : undefined)

/** 形制与文明是否相配 */
export const planFits = (c: Culture, plan: PlanId | undefined) => !plan || plan === 'organic' || !!planOf(c, plan)

/** 界面用：这个文明可选的形制（名称与说明按它在这个文明里的叫法） */
export const planChoices = (c: Culture): { id: PlanId; name: string; desc: string }[] => [ORGANIC_PLAN, ...cultures.get(c).plans.map((p) => ({ id: p.id, name: p.name, desc: p.desc }))]

/** 按 id 找形制，不看文明：参数里写着某种形制时，它自带的属性（如 eliteShare）照它的算 */
export function planById(id: PlanId | undefined): CityPlan | undefined {
  if (!id || id === 'organic') return undefined
  for (const d of cultures.all()) {
    const p = d.plans.find((p) => p.id === id)
    if (p) return p
  }
  return undefined
}

/** 全部形制的 id（含有机生长） */
export const planIds = (): PlanId[] => [...new Set<PlanId>(['organic', ...cultures.all().flatMap((d) => d.plans.map((p) => p.id))])]

/** 城市形制当作一种可引用的内容（界面核对地址、存下的参数里的形制时用）：不可用时回到有机生长 */
export const plans = {
  label: { zh: '城市形制', en: 'city plan', ja: '都市形制' },
  has: (id: string) => planIds().includes(id),
  defaultId: (): PlanId => 'organic',
}
