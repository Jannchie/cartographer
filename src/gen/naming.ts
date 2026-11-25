import { defineSlot, registryOf } from '../kernel'
import { RNG, hashString } from './rng'
import { settingOf } from './setting'
import type { Label, NamingStyle } from './types'

/**
 * 命名风格与取名器。每个地名先定下"专名词根 + 通名"的结构，再分别写成英文、中文、日文，
 * 于是三种语言说的是同一个地方、同一个意思。
 *
 * 命名风格（NamingStyleDef）由插件的 world 层入口登记（扩展点 NamingStyles）：通名模板、国名模板与取词根的办法。
 * 内置的四种在 packs/classic/world/naming.ts：
 * - 西幻：虚构语言的专名，中文按音译、日文按片假名转写
 * - 史诗：意义词根（霜 + 岭 = Frostfell），三种语言各自意译
 * - 东方：汉字专名，英文用拼音，日文用对应的日本汉字
 * - 和风：日本地名，英文用罗马字，中文用对应的简体字
 * 一个世界能用哪些命名风格由它的世界观定（gen/setting.ts）。"世界观"指那一整套设定，命名风格只是其中管地名的部分。
 *
 * 本模块是取名的引擎与通用工具（拉丁拼写的中文音译），不含任何具体的命名风格。
 */

export type NameKind = Exclude<Label['kind'], 'river'> | 'realm' | 'world'
export interface Tri {
  en: string
  zh: string
  ja: string
}

/** 通名模板：# 处放专名 */
export type Tpl = [en: string, zh: string, ja: string]
/** 各类地物的通名模板（国名另有一套） */
export type Kinds = Record<Exclude<NameKind, 'realm'> | 'saltLake', Tpl[]>

export interface NamingStyleDef {
  id: NamingStyle
  /** 名称与说明（中文键，界面按语言翻译） */
  label: string
  tip: string
  /** 通名模板：地物按种类，国名另有一套 */
  kinds: Kinds
  realm: Tpl[]
  /** 通名与词根用了同一个字（青山 + 山、春峰 + 连峰）时重抽；音译的专名不查 */
  avoidEcho: boolean
  /**
   * 建一个取专名词根的函数（每个取名器建一次，函数可以带自己的状态）。
   * rng 是取名器自己的随机数流（通名模板的挑选也用它）；rNames 是调用方给的流——
   * 西幻的虚构语言按原来的顺序从它取，旧种子的英文名不变
   */
  roots(env: { rng: RNG; rNames: RNG }): (kind: NameKind) => Tri
}

/** 扩展点：命名风格，按 id 登记 */
export const NamingStyles = defineSlot<NamingStyleDef>('namingStyle', { zh: '命名风格', en: 'naming style', ja: '命名スタイル' })

/** 命名风格的注册表 */
export const namingStyles = registryOf(NamingStyles)

/** 界面用：一个世界观里可选的命名风格（第一项是"随机"） */
export function namingChoices(p: { setting: string }): { id: NamingStyle; label: string; tip: string }[] {
  return [{ id: 'auto', label: '随机', tip: '按种子挑一种命名风格' }, ...settingOf(p).naming.map((id) => ({ id, label: namingStyles.get(id).label, tip: namingStyles.get(id).tip }))]
}

/**
 * 世界的命名风格：auto 按种子在世界观的池子里取一种；指定了池子里没有的风格时同样按 auto 取。
 * 池子由世界的参数定（见 gen/setting.ts），与启用了哪些插件无关
 */
export function resolveNaming(p: { seed: string; naming?: NamingStyle; setting: string }): NamingStyle {
  const all = settingOf(p).naming
  const n = p.naming ?? 'auto'
  if (n !== 'auto' && all.includes(n)) return n
  return all[hashString(`${p.seed}|naming`) % all.length]
}

/** 海湾的通名：各命名风格一律用"湾"（海的通名模板里未必有） */
const BAY: Tpl[] = [
  ['# Bay', '#湾', '#湾'],
  ['Gulf of #', '#湾', '#湾'],
]

// —— 西幻：拉丁拼写 → 中文音译 ——
// 每行依次是 a e i o u 与 an en in on un
const ZH_SYL: Record<string, string> = {
  '': '阿埃伊奥乌安恩因翁温',
  b: '巴贝比博布班本宾邦本',
  p: '帕佩皮波普潘彭平庞蓬',
  m: '马梅米莫穆曼门明蒙蒙',
  f: '法菲菲佛富凡芬芬丰丰',
  v: '瓦维维沃武万文温冯文',
  w: '瓦韦维沃伍万文温翁文',
  d: '达德迪多杜丹登丁东敦',
  t: '塔泰蒂托图坦滕廷通顿',
  n: '纳内尼诺努南嫩宁农农',
  l: '拉莱利洛卢兰伦林隆伦',
  g: '加格吉戈古甘根金贡衮',
  k: '卡凯基科库坎肯金孔昆',
  h: '哈赫希霍胡汉亨欣洪洪',
  s: '萨塞西索苏桑森辛松孙',
  z: '扎泽齐佐祖赞曾津宗尊',
  sh: '沙谢希肖舒尚申欣雄顺',
  ch: '恰切奇乔丘钱岑琴琼春',
  j: '贾杰吉乔朱詹真金琼君',
  zh: '扎热日若朱然仁任戎润',
  y: '亚叶伊约尤扬延尹雍云',
}
const ZH_CODA: Record<string, string> = {
  b: '布', p: '普', m: '姆', f: '夫', v: '夫', w: '乌', d: '德', t: '特', n: '恩', l: '尔', g: '格', k: '克', h: '',
  s: '斯', z: '兹', sh: '什', ch: '奇', j: '季', zh: '日', y: '伊',
}
const VOWELS = 'aeiou'

export function transliterateZh(word: string): string {
  const s = word
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/th/g, 's')
    .replace(/ph/g, 'f')
    .replace(/[kg]h/g, 'h')
    .replace(/rh/g, 'r')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'kw')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/r/g, 'l')
    .replace(/y(?![aeiou])/g, 'i')
    .replace(/([a-z])\1/g, '$1')
    // 复合元音并成一个
    .replace(/([aeo])[iu]/g, '$1')
  let out = ''
  let i = 0
  while (i < s.length) {
    let cons = ''
    for (const d of ['sh', 'ch', 'zh']) if (s.startsWith(d, i)) cons = d
    if (!cons && !VOWELS.includes(s[i])) cons = s[i]
    const j = i + cons.length
    const v = s[j]
    if (v !== undefined && VOWELS.includes(v)) {
      const row = ZH_SYL[cons] ?? ZH_SYL['']
      // 后面跟着不接元音的 n：并成鼻韵
      const nasal = s[j + 1] === 'n' && !VOWELS.includes(s[j + 2] ?? '')
      out += row[VOWELS.indexOf(v) + (nasal ? 5 : 0)]
      i = j + (nasal ? 2 : 1)
      continue
    }
    out += ZH_CODA[cons] ?? ''
    i = j
  }
  return out
}

/** 一个世界的取名器：同一世界内不重名，按种子确定 */
export class Namer {
  readonly style: NamingStyle
  private def: NamingStyleDef
  /** 取专名词根（命名风格给的） */
  private root: (kind: NameKind) => Tri
  /** 通名模板的挑选；命名风格取词根也用它 */
  private rng: RNG
  private used = new Set<string>()

  /** salt：另起一批名字（区域、海湾）时用自己的随机序列，不改动原有地名的抽取顺序 */
  constructor(p: { seed: string; naming?: NamingStyle; setting: string }, rNames: RNG, salt = '') {
    this.style = resolveNaming(p)
    this.def = namingStyles.get(this.style)
    this.rng = new RNG(hashString(`${p.seed}|naming|${this.style}${salt}`))
    this.root = this.def.roots({ rng: this.rng, rNames })
  }

  private templates(kind: NameKind | 'saltLake'): Tpl[] {
    return kind === 'realm' ? this.def.realm : this.def.kinds[kind]
  }

  /**
   * 取一个地名。variant 用来挑通名模板（如 "X Mountains" / "The Xs"），
   * 不给就用自己的随机数；西幻沿用调用方原来的随机数，旧种子的名字不变。
   */
  name(kind: NameKind | 'saltLake', variant?: number): Tri {
    return this.pick(kind === 'saltLake' ? 'lake' : kind, this.templates(kind), variant)
  }

  /** 海湾名：各命名风格一律用"湾"（海的通名模板里未必有） */
  bay(): Tri {
    return this.pick('sea', BAY)
  }

  private pick(baseKind: NameKind, tpls: Tpl[], variant?: number): Tri {
    let out: Tri | undefined
    for (let t = 0; t < 40; t++) {
      const root = this.root(baseKind)
      const v = variant ?? this.rng.next()
      const [en, zh, ja] = tpls[Math.min(tpls.length - 1, Math.floor(v * tpls.length))]
      out = { en: en.replace('#', root.en), zh: zh.replace('#', root.zh), ja: ja.replace('#', root.ja) }
      // 通名与词根用了同一个字（青山 + 山、春峰 + 连峰）读起来别扭
      if (this.def.avoidEcho && [...zh.replace('#', '')].some((c) => root.zh.includes(c))) continue
      // 一个词根只用一次，免得"夏江"和"夏江洋"并存
      if (this.used.has(root.en) || this.used.has(root.zh)) continue
      this.used.add(root.en)
      this.used.add(root.zh)
      break
    }
    return out!
  }
}
