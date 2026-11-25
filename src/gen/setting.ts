import { defineSlot, registryOf } from '../kernel'
import type { TownCultureRule } from './townCulture'

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
}

/** 扩展点：世界观，按 id 登记（界面上的选项按登记顺序）。默认条目是新建世界时用的那个，也是链接里的世界观不可用时换上的那个 */
export const Settings = defineSlot<SettingDef>('setting', { zh: '世界观', en: 'setting', ja: '世界観' })

/** 世界观的注册表 */
export const settings = registryOf(Settings)

/** 一组世界参数用的世界观（参数先经过 normalizeParams：没有写世界观的旧参数已经补上）；没有登记时抛错（所属的插件没有启用） */
export const settingOf = (p: { setting: string }): SettingDef => settings.get(p.setting)

/** 没有文化可依时的制度（区域图、还没有政区的世界）：世界观里第一种命名风格的制度 */
export const defaultPolity = (s: SettingDef): string => s.polity[s.naming[0]]
