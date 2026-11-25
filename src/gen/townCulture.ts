import type { TownCulture } from './types'

/**
 * 世界层与聚落层的衔接：世界上的一种文化（一片说同一种语言、起同一类名字的地方）建哪种文明的城。
 * 世界生成只知道命名风格与地理，不知道聚落层有哪些文明；这条对应关系是世界观的一部分
 *（SettingDef.townCulture，见 gen/setting.ts；内置的在 packs/classic/world/setting.ts）。这里只有规则的类型，不依赖聚落层与插件的代码。
 */
export interface TownCultureEnv {
  /** 这种文化的命名风格 */
  naming: string
  /** 文化范围里炎热干旱的格数与总格数（没有政区层时都是 0） */
  aridCells: number
  cells: number
}

export type TownCultureRule = (env: TownCultureEnv) => TownCulture
