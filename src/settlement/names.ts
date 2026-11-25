import { Language } from '../gen/names'
import { katakana } from '../gen/names_ja'
import { transliterateZh, type Tri } from '../gen/naming'
import { RNG, hashString } from '../gen/rng'
import { cultureOf } from './culture'
import type { Culture, SettlementSize, WardType } from './types'

/**
 * 聚落里的名字，一律同时写成中文、英文、日文（Tri），说的是同一个东西。
 * 本模块是取名器（去重、各类名字各自的随机数流）与共用的工具；怎么起名由各文明的 CultureNaming 定
 *（通名表、专名的造法、地标与名所的叫法），登记在文明的定义里（见 culture.ts）。
 */
export type T3 = [zh: string, en: string, ja: string]
export const tri = ([zh, en, ja]: T3): Tri => ({ zh, en, ja })

/** 片区在城里的位置：相对城心的方位、是否在老城（城心附近）、是否临河 */
export interface DistrictWhere {
  dir: 'N' | 'S' | 'E' | 'W'
  central: boolean
  outer: boolean
  river: boolean
}
/** 带方位的片区名（西式、伊斯兰共用"北区"这些；和风是"北町"） */
const DIR_NAME: Record<string, DistrictWhere['dir']> = { 北区: 'N', 南区: 'S', 东区: 'E', 西区: 'W', 北町: 'N', 南町: 'S', 东町: 'E', 西町: 'W' }
const CENTRAL_NAME = new Set(['老城', '仲町'])
const OUTER_NAME = new Set(['新城', '新町'])
const RIVER_NAME = new Set(['河畔区', '川端町'])
function fits(zh: string, w?: DistrictWhere): boolean {
  if (!w) return !(zh in DIR_NAME) && !CENTRAL_NAME.has(zh) && !OUTER_NAME.has(zh) && !RIVER_NAME.has(zh)
  if (zh in DIR_NAME) return DIR_NAME[zh] === w.dir && !w.central
  if (CENTRAL_NAME.has(zh)) return w.central
  if (OUTER_NAME.has(zh)) return w.outer
  if (RIVER_NAME.has(zh)) return w.river
  return true
}

/** 通名模板里的 # 换成专名（三语各换各的）；英文打头的 al- 大写（Al-Andalus Mosque） */
export const fill = ([zh, en, ja]: T3, [pz, pe, pj]: T3): Tri => ({ zh: zh.replace('#', pz), en: en.replace('#', pe).replace(/^al-/, 'Al-'), ja: ja.replace('#', pj) })

export type LandmarkNameKind =
  | 'castle'
  | 'temple'
  | 'chapel'
  | 'market'
  | 'harbor'
  | 'magic'
  | 'shrine'
  | 'ferry'
  | 'park'
  | 'cemetery'
  | 'barracks'
  | 'guild'
  | 'exchange'
  | 'warehouse'
  | 'observatory'
  | 'tavern'
  | 'portal'
  | 'stage'
  | 'pulpit'
  | 'arena'
  | 'winery'
  | 'amphitheater'
  | 'mill'
  | 'windmill'
  | 'hospital'
  | 'school'
  | 'gallows'
  | 'kiln'
  | 'quarry'
  | 'lighthouse'
  | 'halle'

// —————————————————————— 各文化的命名规则 ——————————————————————

type Feature = 'river' | 'sea' | 'hill'
type StreetKind = 'main' | 'street' | 'lane'

/** 通名：单个是定的（不耗随机数），数组才随机挑 */
export const choose = (r: RNG, s: T3 | T3[]): T3 => (typeof s[0] === 'string' ? (s as T3) : r.pick(s as T3[]))

/** 规模档与名所的专名：种类（大社、山寺、堂区教堂、设防庄园……）→ 造名函数（用取名器当前的随机数流 n.rng） */
export type SacredNames = Record<string, (n: SettleNamer) => Tri>

/**
 * 一种文明怎么起名：通名表 + 专名的造法 + 各自的讲究。
 * 专名、通名谁先抽、在去重循环里还是外，都关系到随机数顺序，各项照原样写
 */
export interface CultureNaming {
  /** 聚落名的通名（按规模） */
  town: Record<SettlementSize, T3[]>
  /** 先定下通名（临海、临河另有讲究），返回造名函数（去重时反复调） */
  townName(n: SettleNamer, suf: T3[], size: SettlementSize, coast: boolean, river: boolean, crossing: CrossingKind | null): () => Tri
  /** 河、海、山的通名 */
  feature: Record<Feature, T3 | T3[]>
  featureName(n: SettleNamer, suf: T3 | T3[], f: Feature): Tri
  /** 片区名候选（按类型） */
  district: Partial<Record<WardType, T3[]>>
  /** 按位置筛候选，默认用 fits */
  districtFits?(zh: string, type: WardType, where?: DistrictWhere): boolean
  /** 先于候选表的讲究：返回造名函数就用它 */
  districtFirst?(n: SettleNamer, type: WardType): (() => Tri) | undefined
  /** 候选表里没有这类片区时的造法（没有就不命名） */
  districtElse?(n: SettleNamer): Tri
  /** 街名的通名（按等级） */
  street: Record<StreetKind, T3[]>
  streetName(n: SettleNamer, suf: T3[]): Tri
  /** 城门：按朝向（东、南、西、北）各一组候选 */
  gates: T3[][]
  /**
   * 候选用尽、名字重了时加的区别字（新钟楼、小南门、Old Town Hall、Souq al-Attarin al-Jadid……）：
   * [中文前缀, 英文模板, 日文前缀]；方位字不加在本就带方位的名字上（不出"北南门"）
   */
  qualify: T3[]
  /** 地标的名字（城堡、寺庙、市场、客栈……） */
  landmark(n: SettleNamer, kind: LandmarkNameKind, magic: number): Tri
  /** 都城的宫殿（皇宫、王宫、御所……）；r 是宫殿自己的随机数流 */
  palace(n: SettleNamer, r: RNG): Tri
  /**
   * 规模档与"名所"的专名（见 tiers.ts、sacred.ts）：大社、山寺、修道院、设防庄园、离宫……
   * kind 由盖它的代码与这里约定；没有约定的种类视为错误
   */
  sacred(n: SettleNamer, kind: string): Tri
}

const DIR_CHARS = /[东西南北]/

/** 河上过路的办法（聚落名里的"桥""渡"要对得上） */
export type CrossingKind = 'bridge' | 'ferry' | 'ford'

export class SettleNamer {
  /** 用过的名字：三种语言各记一份（"zh:钟楼""en:Bell Tower"），哪种语言重了都算重 */
  private used = new Set<string>()
  private lang: Language
  private _rng: RNG
  /** 当前的随机数流：名所、聚落名各用自己的流时，这里临时换成那一条 */
  get rng(): RNG {
    return this._rng
  }
  /** 本文明的起名规则 */
  private get rules() {
    return cultureOf(this.culture).naming
  }
  constructor(
    private seed: string,
    readonly culture: Culture,
    /** 临海：港口一类的地标按海港还是河港取名 */
    readonly coast = false,
  ) {
    this._rng = new RNG(hashString(seed + '|names'))
    this.lang = new Language(new RNG(hashString(seed + '|lang')))
  }

  private taken(n: Tri): boolean {
    return this.used.has('zh:' + n.zh) || this.used.has('en:' + n.en) || this.used.has('ja:' + n.ja)
  }

  private take(n: Tri): Tri {
    this.used.add('zh:' + n.zh)
    this.used.add('en:' + n.en)
    this.used.add('ja:' + n.ja)
    return n
  }

  /** 按中、英、日三种写法去重（拼音同音的"常阳坊 / 昌阳坊"也算重）；候选用尽时返回 undefined（用于可以不命名的场合） */
  tryUniq(make: () => Tri): Tri | undefined {
    for (let t = 0; t < 30; t++) {
      const n = make()
      if (!this.taken(n)) return this.take(n)
    }
    return undefined
  }

  /** 去重；候选用尽就给最后一个加区别字（新钟楼、Old Town Hall），还不行再编号 */
  uniq(make: () => Tri): Tri {
    return this.tryUniq(make) ?? this.distinct(make())
  }

  private distinct(n: Tri): Tri {
    const bare = n.en.replace(/^The /, '')
    for (const [qz, qe, qj] of this.rules.qualify) {
      if (n.zh.startsWith(qz) || (DIR_CHARS.test(qz) && DIR_CHARS.test(n.zh))) continue
      const m = { zh: qz + n.zh, en: qe.replace('#', bare), ja: qj + n.ja }
      if (!this.taken(m)) return this.take(m)
    }
    for (let k = 2; ; k++) {
      const m = { zh: `${n.zh}${k}`, en: `${n.en} ${k}`, ja: `${n.ja}${k}` }
      if (!this.taken(m)) return this.take(m)
    }
  }

  /** 虚构语言的专名：一个造出来的词，中文音译、日文片假名，各接上通名 */
  proper([zh, en, ja]: T3): Tri {
    const w = this.lang.word()
    return { zh: transliterateZh(w) + zh, en: en.replace('#', w), ja: katakana(w) + ja }
  }

  pick(pool: T3[]): Tri {
    return tri(this.rng.pick(pool))
  }

  /** 聚落名（城外的村子也用它）。crossing：河上怎么过（有桥才叫"某某桥"，只有渡口、浅滩的叫"某某渡"） */
  town(size: SettlementSize, coast: boolean, river: boolean, crossing: CrossingKind | null = null): Tri {
    const c = this.rules
    return this.uniq(c.townName(this, c.town[size], size, coast, river, crossing))
  }

  /**
   * 规模档与名所的专名：每个名字用自己的随机数流（按 key，通常是位置），不耗主随机数——
   * 城里多一座祠、少一座塔，别的地标、街巷的名字不会跟着变
   */
  sacred(kind: string, key: string): Tri {
    const rng = this._rng
    const lang = this.lang
    this._rng = new RNG(hashString(`${this.seed}|sacred|${kind}|${key}`))
    this.lang = new Language(new RNG(hashString(`${this.seed}|sacred-lang|${key}`)))
    try {
      return this.uniq(() => this.rules.sacred(this, kind))
    } finally {
      this._rng = rng
      this.lang = lang
    }
  }

  /**
   * 这座聚落本身的名字：要等桥、渡口定下之后才取（名字里的"桥"要真有桥），
   * 用自己的随机数流，取名的先后挪动不影响它，也不打乱别的名字
   */
  settlement(size: SettlementSize, coast: boolean, river: boolean, crossing: CrossingKind | null): Tri {
    const rng = this._rng
    const lang = this.lang
    this._rng = new RNG(hashString(this.seed + '|town'))
    this.lang = new Language(new RNG(hashString(this.seed + '|town-lang')))
    try {
      return this.town(size, coast, river, crossing)
    } finally {
      this._rng = rng
      this.lang = lang
    }
  }

  river(): Tri {
    return this.feature('river')
  }

  sea(): Tri {
    return this.feature('sea')
  }

  hill(): Tri {
    return this.feature('hill')
  }

  private feature(f: Feature): Tri {
    const c = this.rules
    return this.uniq(() => c.featureName(this, c.feature[f], f))
  }

  district(type: WardType, where?: DistrictWhere): Tri | undefined {
    const c = this.rules
    const first = c.districtFirst?.(this, type)
    if (first) return this.tryUniq(first)
    // 方位名、老城、新城、河畔只给位置对得上的片区
    const pool = c.district[type]?.filter(([zh]) => (c.districtFits ? c.districtFits(zh, type, where) : fits(zh, where)))
    if (pool?.length) return this.tryUniq(() => this.pick(pool))
    const other = c.districtElse
    return other ? this.uniq(() => other(this)) : undefined
  }

  street(kind: StreetKind): Tri {
    const c = this.rules
    const suf = c.street[kind]
    return this.uniq(() => c.streetName(this, suf))
  }

  gate(dirAngle: number): Tri {
    // dirAngle：城门朝外的方向（屏幕坐标，0 为东，π/2 为南）
    const idx = Math.round(((dirAngle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)) % 4
    const names = this.rules.gates[idx]
    return this.uniq(() => this.pick(names))
  }

  landmark(kind: LandmarkNameKind, magic: number): Tri {
    return this.uniq(() => this.rules.landmark(this, kind, magic))
  }

  /** 都城的宫殿（皇宫、王宫、御所……）。用自己的随机数，不打乱其他名字 */
  palace(): Tri {
    const r = new RNG(hashString(this.seed + '|palace'))
    return this.uniq(() => this.rules.palace(this, r))
  }

}
