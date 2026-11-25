import { defineSlot, registryOf } from '../kernel'
import type { NamingStyle, TownCulture } from './types'

/**
 * 世界层与聚落层的衔接：世界上的一种文化（一片说同一种语言、起同一类名字的地方）建哪种文明的城。
 * 世界生成只知道命名世界观（NamingStyle）与地理，不知道聚落层有哪些文明；这条对应关系是插件的内容，
 * 由插件的 world 层入口登记（内置的见 packs/classic/world.ts）。这里只有规则的类型与扩展点，不依赖聚落层与插件的代码。
 */
export interface TownCultureEnv {
  /** 这种文化的命名世界观 */
  naming: Exclude<NamingStyle, 'auto'>
  /** 文化范围里炎热干旱的格数与总格数（没有政区层时都是 0） */
  aridCells: number
  cells: number
}

export type TownCultureRule = (env: TownCultureEnv) => TownCulture

/** 扩展点：城镇文明规则，按规则的 id 登记 */
export const TownCultureRules = defineSlot<TownCultureRule>('townCultureRule')

const rules = registryOf(TownCultureRules)

/**
 * 当前世界用的规则。目前所有世界都用内置的 classic；规则改由世界的参数选定之后，
 * 这里按参数取（规则是生成结果的一部分，不能随启用了哪些插件而变）
 */
export const townCulture: TownCultureRule = (env) => rules.get('classic')(env)
