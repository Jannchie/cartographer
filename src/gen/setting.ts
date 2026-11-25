import { defineSlot, registryOf } from '../kernel'
import type { Polity } from './polity'
import type { TownCultureRule } from './townCulture'
import type { NamingStyle, TownCulture } from './types'

/**
 * 世界观（setting）：一套相互配套的人文内容——世界上的文化可以用哪些命名风格、各自实行什么制度、建哪种文明的城。
 * 一个世界用哪个世界观写在它的参数里（WorldParams.setting），是生成结果的一部分：
 * 命名风格选"随机"时、给其余文化抽命名风格时，都只从这个世界观的池子里取，与启用了哪些插件无关——
 * 多启用一个插件，已有的世界不会变。
 *
 * 世界观由插件的 world 层入口登记（扩展点 Settings）；它引用的命名风格（gen/naming.ts）、制度（gen/polity.ts）
 * 是另外两个扩展点，文明（settlement/culture.ts）在聚落层，这里只记 id。
 * 注意与"命名风格"区分：命名风格只管地名怎么起，世界观是包含它在内的整套设定。
 */
/**
 * 一个文化区的地理概况：世界观按它给文化定命名风格、制度与城镇文明（SettingDef.cultures）。
 * 都是确定的统计量，不用随机数
 */
export interface CultureRegion {
  /** 0 号是主体文化（最大城所在的那片）；其余按"离已有文化最远"的先后 */
  index: number
  /** 陆地格数 */
  cells: number
  /** 各群系的陆地格数（下标是群系的编号，见 gen/types.ts 的 Biome） */
  biomes: readonly number[]
  /** 炎热干旱的格数：气温高于 18 度的热沙漠、灌丛、稀树草原、盐沼（城镇文明规则 TownCultureEnv 里的那个量） */
  aridCells: number
  /** 高地的格数（海拔高于 HIGHLAND_KM）、平均海拔（公里）、平均气温（摄氏度） */
  highCells: number
  meanElev: number
  meanTemp: number
  /** 边远程度 0 ~ 1：文化中心到主体文化中心的路程，按其中最远的归一；隔海到不了的算 1，主体文化自己是 0 */
  remoteness: number
  /** 区内的城镇数 */
  towns: number
}

/** 算作高地的海拔（公里） */
export const HIGHLAND_KM = 0.8

/** 一个文化的三项属性 */
export interface CultureSpec {
  naming: NamingStyle
  polity: Polity
  town: TownCulture
}

export interface SettingDef {
  id: string
  /** 名称与说明（中文键，界面按语言翻译） */
  name: string
  desc: string
  /**
   * 命名风格的池子，有顺序。命名风格选"随机"时按种子在其中取一种；世界的主体文化用世界的命名风格，
   * 其余文化的命名风格从池子里余下的抽，抽完之后的文化用第一种。顺序与个数都是生成结果的一部分，登记后不能改动
   */
  naming: readonly string[]
  /** 各命名风格的文化实行的制度（制度的 id，见 gen/polity.ts）：池子里的每一种都要有；第一种命名风格的制度也是没有文化时的默认制度 */
  polity: Readonly<Record<string, string>>
  /** 城镇文明规则：一种文化建哪种文明的城（返回聚落层的文明 id）。它用到的文明、制度、命名风格若来自别的插件，登记世界观的插件要在清单里声明依赖 */
  townCulture: TownCultureRule
  /**
   * 整体规则：看全部文化区的地理概况，一次定下各文化的命名风格、制度与城镇文明（按 regions 的顺序返回，个数相同）。
   * 给了它就不用"池子洗牌 + polity 查表 + townCulture"那一套。world.style 是世界的命名风格，0 号文化沿用世界的取名器，
   * 它的命名风格应当就是 world.style；其余文化的命名风格可以在池子之外（各种族各自的地名：选不到、"随机"也抽不到，只由规则分配）。
   * 规则必须是确定的（同样的输入得到同样的结果），不能用随机数；规则没有覆盖到的场合
   *（没有政区层的世界、旧存档）仍用 polity 与 townCulture，所以那两项照样要给
   */
  cultures?(regions: readonly CultureRegion[], world: { style: NamingStyle }): CultureSpec[]
}

/** 扩展点：世界观，按 id 登记（界面上的选项按登记顺序）。默认条目是新建世界时用的那个，也是链接里的世界观不可用时换上的那个 */
export const Settings = defineSlot<SettingDef>('setting', { zh: '世界观', en: 'setting', ja: '世界観' })

/** 世界观的注册表 */
export const settings = registryOf(Settings)

/** 一组世界参数用的世界观（参数先经过 normalizeParams：没有写世界观的旧参数已经补上）；没有登记时抛错（所属的插件没有启用） */
export const settingOf = (p: { setting: string }): SettingDef => settings.get(p.setting)

/** 没有文化可依时的制度（区域图、还没有政区的世界）：世界观里第一种命名风格的制度 */
export const defaultPolity = (s: SettingDef): string => s.polity[s.naming[0]]
