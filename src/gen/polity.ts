import { defineSlot, registryOf } from '../kernel'
import { defaultPolity, type SettingDef } from './setting'

/**
 * 制度：一种文化怎样把土地组织成国家。决定国家的多少与大小、跨文化扩张的难易，以及中层政区怎样划分。
 * 制度由插件的 world 层入口登记（扩展点 Polities）；哪种文化实行哪种制度由世界观定（gen/setting.ts）。
 * 内置的三种（packs/classic/world/polity.ts）：
 * - feudal 分封：伯爵领 → 公爵领 → 王国。国家多而大小悬殊；公爵领围绕大城，大小随城市规模
 * - commandery 郡县：县 → 州 → 王朝。一个大一统王朝占据核心，周边少数小国；州均匀铺开、大小均衡，
 *   界线顺着山脊与大河（山川形便）
 * - ritsuryo 令制：郡 → 令制国 → 朝廷。国家少；令制国以山脊为界，大致一块盆地、一片平原一国
 */
export type Polity = string

/** 制度的规则：政区划分（gen/political.ts）按它调节 */
export interface PolityRule {
  /** 国家数目的倍率（按文化占地分配名额之后再乘） */
  realms: number
  /** 国家种子之间的最小间距倍率 */
  sep: number
  /** 国家扩张活力的范围；core：文化里第一个（最大城市的）国家额外的活力倍率 */
  vigor: [number, number]
  core: number
  /** 跨文化扩张的代价倍率 */
  cross: number
  /** 一个中层政区平均含几个基本单位 */
  group: number
  /** 中层政区的中心：towns 先取大城（其余补齐），even 从都城起按最远点均匀铺开 */
  seeding: 'towns' | 'even'
  /** 中层界线翻越山脊（每公里高度）、沿大河的代价 */
  ridge: number
  river: number
  /** 中层政区大小向平均靠拢的力度：0 不管，1 尽量均衡 */
  balance: number
}

/** 有名字的地方的三语写法 */
interface Named {
  name: string
  zh: string
  ja?: string
}

export interface PolityDef {
  id: Polity
  /** 制度的名字与基本单位、中层政区的称呼（中文原文，界面经 i18n 翻译）；国家的称呼在国名里（见命名风格的国名模板） */
  terms: { name: string; county: string; province: string }
  rule: PolityRule
  /** 中层政区的名字：治所基本单位的名字加上制度的称谓 */
  provinceName(seat: Named): { name: string; zh: string; ja: string }
}

/** 扩展点：制度，按 id 登记 */
export const Polities = defineSlot<PolityDef>('polity', { zh: '制度', en: 'polity', ja: '制度' })

/** 制度的注册表 */
export const polities = registryOf(Polities)

/** 文化的制度（旧存档没记，按所在世界观里它的命名风格对应的制度推出） */
export const polityOf = (s: SettingDef, c: { naming: string; polity?: Polity }): Polity => c.polity ?? s.polity[c.naming] ?? defaultPolity(s)

/** 国家的制度：按国家的主体文化（没有记录时取 fallback 文化，再没有就是世界观的默认制度） */
export function realmPolity(s: SettingDef, cultures: readonly { naming: string; polity?: Polity }[], realm: { culture?: number } | undefined, fallback?: number): Polity {
  const c = cultures[realm?.culture ?? -1] ?? cultures[fallback ?? -1]
  return c ? polityOf(s, c) : defaultPolity(s)
}
