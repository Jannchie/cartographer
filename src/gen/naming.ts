import { Language } from './names'
import { katakana } from './names_ja'
import { RNG, hashString } from './rng'
import type { Label, NamingStyle } from './types'

/**
 * 命名世界观。每个地名先定下"专名词根 + 通名"的结构，再分别写成英文、中文、日文，
 * 于是三种语言说的是同一个地方、同一个意思：
 * - 西幻：虚构语言的专名，中文按音译、日文按片假名转写
 * - 史诗：意义词根（霜 + 岭 = Frostfell），三种语言各自意译
 * - 东方：汉字专名，英文用拼音，日文用对应的日本汉字
 * - 和风：日本地名，英文用罗马字，中文用对应的简体字
 */

export type NameKind = Label['kind'] | 'realm' | 'world'
export interface Tri {
  en: string
  zh: string
  ja: string
}

export const NAMING_STYLES: { id: NamingStyle; label: string; tip: string }[] = [
  { id: 'auto', label: '随机', tip: '按种子挑一种世界观' },
  { id: 'fantasy', label: '西幻', tip: '虚构语言的专名：中文音译、日文片假名' },
  { id: 'epic', label: '史诗', tip: '意义词根：霜岭、银港、鸦渡……三语意译' },
  { id: 'eastern', label: '东方', tip: '汉字地名：英文拼音、日文汉字' },
  { id: 'wa', label: '和风', tip: '日本地名：英文罗马字、中文汉字' },
]

/** auto 按种子落到具体的世界观 */
export function resolveNaming(p: { seed: string; naming?: NamingStyle }): Exclude<NamingStyle, 'auto'> {
  const n = p.naming ?? 'auto'
  if (n !== 'auto') return n
  const all = ['fantasy', 'epic', 'eastern', 'wa'] as const
  return all[hashString(`${p.seed}|naming`) % all.length]
}

// —— 通名模板：# 处放专名 ——
type Tpl = [en: string, zh: string, ja: string]
type Kinds = Record<Exclude<NameKind, 'realm'> | 'saltLake', Tpl[]>

const WESTERN: Kinds = {
  world: [['#', '#', '#']],
  continent: [['#', '#', '#']],
  island: [['#', '#岛', '#島']],
  ocean: [['# Ocean', '#洋', '#洋']],
  sea: [['# Sea', '#海', '#海'], ['Sea of #', '#海', '#海']],
  range: [['# Mountains', '#山脉', '#山脈'], ['The #s', '#山脉', '#山脈']],
  basin: [['# Basin', '#盆地', '#盆地']],
  desert: [['# Desert', '#沙漠', '#砂漠']],
  forest: [['# Forest', '#森林', '#の森'], ['#wood', '#林', '#の森']],
  lake: [['Lake #', '#湖', '#湖']],
  saltLake: [['Salt Lake #', '#盐湖', '#塩湖']],
  city: [['#', '#', '#']],
  capital: [['#', '#', '#']],
}

/** 史诗：词根本身已是复合词，不再接 -wood 这类词尾 */
const EPIC: Kinds = { ...WESTERN, forest: [['# Forest', '#森林', '#の森']] }

const EASTERN: Kinds = {
  world: [['#', '#', '#']],
  continent: [['#zhou', '#洲', '#洲']],
  island: [['# Island', '#岛', '#島'], ['# Isle', '#屿', '#嶼']],
  ocean: [['# Ocean', '#洋', '#洋']],
  sea: [['# Sea', '#海', '#海']],
  range: [['# Mountains', '#山', '#山'], ['# Ridge', '#岭', '#嶺'], ['# Range', '#山脉', '#山脈']],
  basin: [['# Basin', '#盆地', '#盆地'], ['# Plain', '#原', '#原']],
  desert: [['# Desert', '#大漠', '#大漠'], ['# Sand Sea', '#沙海', '#砂海']],
  forest: [['# Forest', '#林', '#林'], ['# Sea of Trees', '#林海', '#樹海']],
  lake: [['Lake #', '#湖', '#湖'], ['# Marsh', '#泽', '#沢']],
  saltLake: [['# Salt Lake', '#盐池', '#塩池']],
  city: [['#', '#', '#']],
  capital: [['#', '#', '#']],
}

const WA: Kinds = {
  world: [['#', '#', '#']],
  continent: [['#', '#', '#']],
  island: [['# Island', '#岛', '#島']],
  ocean: [['# Ocean', '#洋', '#洋']],
  sea: [['# Sea', '#海', '#海'], ['# Bay', '#湾', '#湾']],
  range: [['# Mountains', '#山脉', '#山脈'], ['# Peaks', '#连峰', '#連峰']],
  basin: [['# Basin', '#盆地', '#盆地']],
  desert: [['# Desert', '#沙漠', '#砂漠'], ['# Dunes', '#砂丘', '#砂丘']],
  forest: [['# Forest', '#之森', '#の森'], ['# Sea of Trees', '#树海', '#樹海']],
  lake: [['Lake #', '#湖', '#湖'], ['# Pond', '#池', '#池']],
  saltLake: [['# Salt Lake', '#盐湖', '#塩湖']],
  city: [['#', '#', '#']],
  capital: [['#kyo', '#京', '#京']],
}

const BAY: Tpl[] = [
  ['# Bay', '#湾', '#湾'],
  ['Gulf of #', '#湾', '#湾'],
]

const REALM_WESTERN: Tpl[] = [
  ['Kingdom of #', '#王国', '#王国'],
  ['# Empire', '#帝国', '#帝国'],
  ['Duchy of #', '#公国', '#公国'],
  ['Principality of #', '#公国', '#公国'],
  ['# Republic', '#共和国', '#共和国'],
  ['Grand Duchy of #', '#大公国', '#大公国'],
  ['# Dominion', '#领', '#領'],
  ['Khanate of #', '#汗国', '#ハン国'],
]
const REALM_EASTERN: Tpl[] = [
  ['Kingdom of #', '#国', '#国'],
  ['Great #', '大#', '大#'],
  ['# Dynasty', '#朝', '#朝'],
  ['# Protectorate', '#都护府', '#都護府'],
]
const REALM_WA: Tpl[] = [
  ['Province of #', '#国', '#国'],
  ['# Shogunate', '#幕府', '#幕府'],
  ['# Domain', '#藩', '#藩'],
  ['# Empire', '#帝国', '#帝国'],
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

// —— 史诗：意义词根 ——
type Morph = [en: string, zh: string, ja: string]
const EPIC_HEAD: Morph[] = [
  ['Frost', '霜', '霜'], ['Storm', '风暴', '嵐'], ['Silver', '银', '銀'], ['Iron', '铁', '鉄'], ['Gold', '金', '金'],
  ['Raven', '鸦', '鴉'], ['Wolf', '狼', '狼'], ['Stag', '鹿', '鹿'], ['Dragon', '龙', '竜'], ['Ember', '烬', '燼'],
  ['Ash', '灰', '灰'], ['Thorn', '棘', '茨'], ['Grey', '苍', '蒼'], ['White', '白', '白'], ['Black', '黑', '黒'],
  ['Red', '赤', '赤'], ['Green', '翠', '翠'], ['Star', '星', '星'], ['Moon', '月', '月'], ['Sun', '日', '日'],
  ['Dawn', '晓', '暁'], ['Dusk', '暮', '暮'], ['Winter', '冬', '冬'], ['Summer', '夏', '夏'], ['Stone', '石', '石'],
  ['Oak', '橡', '樫'], ['Pine', '松', '松'], ['Willow', '柳', '柳'], ['Rose', '蔷薇', '薔薇'], ['Salt', '盐', '塩'],
  ['Mist', '雾', '霧'], ['Shadow', '影', '影'], ['Bright', '明', '明'], ['Eagle', '鹰', '鷲'], ['Bear', '熊', '熊'],
  ['Kings', '王', '王'], ['Crow', '乌', '烏'], ['Thunder', '雷', '雷'], ['Cold', '寒', '寒'], ['High', '高', '高'],
]
const EPIC_TOWN: Morph[] = [
  ['hold', '寨', '砦'], ['haven', '港', '港'], ['ford', '渡', '渡'], ['watch', '哨', '哨'], ['gate', '门', '門'],
  ['bridge', '桥', '橋'], ['keep', '堡', '塞'], ['vale', '谷', '谷'], ['march', '疆', '辺'], ['stead', '庄', '荘'],
  ['wick', '村', '村'], ['burg', '城', '城'], ['mouth', '口', '口'], ['spire', '塔', '塔'], ['field', '野', '野'],
  ['cross', '十字', '十字'], ['well', '井', '井'], ['hall', '厅', '館'],
]
const EPIC_LAND: Morph[] = [
  ['fell', '岭', '嶺'], ['wood', '林', '林'], ['mere', '泽', '沢'], ['reach', '境', '境'], ['crest', '峰', '峰'],
  ['shade', '荫', '陰'], ['fall', '瀑', '滝'], ['deep', '渊', '淵'], ['moor', '原', '原'], ['horn', '角', '角'],
  ['vale', '谷', '谷'], ['water', '水', '水'], ['shore', '滨', '浜'], ['brook', '溪', '渓'], ['crag', '岩', '岩'],
  ['wind', '风', '風'], ['land', '地', '地'],
]

// —— 东方：汉字 / 拼音 / 日本汉字 ——
const hanzi = (s: string) => s.split(' ').map((w) => w.split(':') as Morph)
const EAST_POOL = hanzi(
  '青:qing:青 苍:cang:蒼 玄:xuan:玄 赤:chi:赤 碧:bi:碧 金:jin:金 朔:shuo:朔 岚:lan:嵐 澜:lan:瀾 岐:qi:岐 雍:yong:雍 ' +
    '凉:liang:涼 幽:you:幽 冀:ji:冀 扬:yang:揚 荆:jing:荊 豫:yu:豫 梁:liang:梁 蜀:shu:蜀 越:yue:越 吴:wu:呉 楚:chu:楚 ' +
    '燕:yan:燕 赵:zhao:趙 秦:qin:秦 晋:jin:晋 齐:qi:斉 鲁:lu:魯 云:yun:雲 龙:long:龍 凤:feng:鳳 鹤:he:鶴 松:song:松 ' +
    '霜:shuang:霜 雪:xue:雪 月:yue:月 星:xing:星 辰:chen:辰 阳:yang:陽 安:an:安 平:ping:平 宁:ning:寧 定:ding:定 ' +
    '康:kang:康 永:yong:永 昌:chang:昌 兴:xing:興 丰:feng:豊 泰:tai:泰 华:hua:華 洛:luo:洛 渭:wei:渭 沅:yuan:沅 ' +
    '湘:xiang:湘 沧:cang:滄 澄:cheng:澄 清:qing:清 明:ming:明 灵:ling:霊 翠:cui:翠 琅:lang:琅 临:lin:臨 淮:huai:淮 ' +
    '昆:kun:昆 衡:heng:衡 嵩:song:嵩 岱:dai:岱 紫:zi:紫 丹:dan:丹 玉:yu:玉 瑶:yao:瑶 琼:qiong:瓊 溪:xi:渓 泉:quan:泉 ' +
    '浦:pu:浦 汀:ting:汀 望:wang:望 归:gui:帰 远:yuan:遠 怀:huai:懐 武:wu:武 威:wei:威 鹿:lu:鹿 梧:wu:梧 白:bai:白 ' +
    '江:jiang:江 天:tian:天 长:chang:長',
)
const EAST_HEAD = hanzi('东:dong:東 西:xi:西 南:nan:南 北:bei:北')
const EAST_CITY = hanzi('城:cheng:城 州:zhou:州 阳:yang:陽 安:an:安 宁:ning:寧 陵:ling:陵 关:guan:関 渡:du:渡 川:chuan:川')
const EAST_CAPITAL = hanzi('京:jing:京 都:du:都')

/** 拼音连写：后一音节以 a/e/o 开头时加隔音符（Xi'an） */
function pinyin(parts: string[]): string {
  let s = ''
  for (const p of parts) s += s && /^[aeo]/.test(p) ? `'${p}` : p
  return s[0].toUpperCase() + s.slice(1)
}

// —— 和风：日本汉字 / 罗马字 / 简体字 ——
const WA_HEAD = hanzi(
  '白:shira:白 黒:kuro:黑 青:ao:青 赤:aka:赤 朝:asa:朝 夕:yu:夕 月:tsuki:月 星:hoshi:星 桜:sakura:樱 松:matsu:松 ' +
    '竹:take:竹 霧:kiri:雾 雪:yuki:雪 風:kaze:风 鷹:taka:鹰 鶴:tsuru:鹤 鹿:shika:鹿 岩:iwa:岩 高:taka:高 大:o:大 ' +
    '小:ko:小 長:naga:长 深:fuka:深 霞:kasumi:霞 秋:aki:秋 春:haru:春 夏:natsu:夏 冬:fuyu:冬 若:waka:若 紅:beni:红 ' +
    '金:kana:金 藤:fuji:藤 梅:ume:梅 菊:kiku:菊 熊:kuma:熊 龍:tatsu:龙 神:kami:神 天:ama:天',
)
const WA_TAIL = hanzi(
  '川:kawa:川 山:yama:山 野:no:野 原:hara:原 島:shima:岛 沢:sawa:泽 浜:hama:滨 崎:saki:崎 岡:oka:冈 森:mori:森 ' +
    '津:tsu:津 谷:tani:谷 瀬:se:濑 宮:miya:宫 橋:hashi:桥 田:ta:田 見:mi:见 根:ne:根 戸:to:户 峰:mine:峰 江:e:江',
)

/** 一个世界的取名器：同一世界内不重名，按种子确定 */
export class Namer {
  readonly style: Exclude<NamingStyle, 'auto'>
  private lang: Language
  /** 词根与模板的挑选；西幻的专名仍由 Language 按原来的顺序取，旧种子的英文名不变 */
  private rng: RNG
  private used = new Set<string>()

  /** salt：另起一批名字（区域、海湾）时用自己的随机序列，不改动原有地名的抽取顺序 */
  constructor(p: { seed: string; naming?: NamingStyle }, rNames: RNG, salt = '') {
    this.style = resolveNaming(p)
    this.lang = new Language(rNames)
    this.rng = new RNG(hashString(`${p.seed}|naming|${this.style}${salt}`))
  }

  private root(kind: NameKind): Tri {
    const r = this.rng
    const town = kind === 'city' || kind === 'capital'
    switch (this.style) {
      case 'fantasy': {
        const en = this.lang.word()
        return { en, zh: transliterateZh(en), ja: katakana(en) }
      }
      case 'epic': {
        const a = r.pick(EPIC_HEAD)
        let b = r.pick(town ? EPIC_TOWN : EPIC_LAND)
        while (b[1] === a[1]) b = r.pick(town ? EPIC_TOWN : EPIC_LAND)
        return { en: a[0] + b[0], zh: a[1] + b[1], ja: a[2] + b[2] }
      }
      case 'eastern': {
        const parts: Morph[] = []
        const add = (pool: Morph[]) => {
          let m = r.pick(pool)
          while (parts.some((q) => q[0] === m[0])) m = r.pick(pool)
          parts.push(m)
        }
        if (town) {
          if (kind === 'capital' || r.next() < 0.6) add(EAST_POOL)
          else add(EAST_HEAD)
          add(kind === 'capital' ? EAST_CAPITAL : r.next() < 0.7 ? EAST_CITY : EAST_POOL)
          if (parts.length === 1) add(EAST_POOL)
        } else {
          if (r.next() < 0.12) add(EAST_HEAD)
          add(EAST_POOL)
          if (parts.length === 1 || r.next() < 0.05) add(EAST_POOL)
        }
        return { en: pinyin(parts.map((m) => m[1])), zh: parts.map((m) => m[0]).join(''), ja: parts.map((m) => m[2]).join('') }
      }
      case 'wa': {
        const a = r.pick(WA_HEAD)
        const b = r.pick(WA_TAIL)
        const en = a[1] + b[1]
        return { en: en[0].toUpperCase() + en.slice(1), zh: a[2] + b[2], ja: a[0] + b[0] }
      }
    }
  }

  private templates(kind: NameKind | 'saltLake'): Tpl[] {
    if (kind === 'realm') return this.style === 'eastern' ? REALM_EASTERN : this.style === 'wa' ? REALM_WA : REALM_WESTERN
    const table = this.style === 'eastern' ? EASTERN : this.style === 'wa' ? WA : this.style === 'epic' ? EPIC : WESTERN
    return table[kind]
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
      if (this.style !== 'fantasy' && [...zh.replace('#', '')].some((c) => root.zh.includes(c))) continue
      // 一个词根只用一次，免得"夏江"和"夏江洋"并存
      if (this.used.has(root.en) || this.used.has(root.zh)) continue
      this.used.add(root.en)
      this.used.add(root.zh)
      break
    }
    return out!
  }
}
