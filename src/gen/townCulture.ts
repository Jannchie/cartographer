import type { NamingStyle, TownCulture } from './types'

/**
 * 世界层与聚落层的衔接：世界上的一种文化（一片说同一种语言、起同一类名字的地方）建哪种文明的城。
 * 世界生成只知道命名世界观（NamingStyle）与地理，不知道聚落层有哪些文明；这条对应关系是文化包的内容
 *（见 packs/world.ts）。这里只有规则的类型，不依赖聚落层与文化包的代码。
 */
export interface TownCultureEnv {
  /** 这种文化的命名世界观 */
  naming: Exclude<NamingStyle, 'auto'>
  /** 文化范围里炎热干旱的格数与总格数（没有政区层时都是 0） */
  aridCells: number
  cells: number
}

export type TownCultureRule = (env: TownCultureEnv) => TownCulture
