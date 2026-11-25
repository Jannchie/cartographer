import { Language } from '../../../gen/names'
import { katakana } from '../../../gen/names_ja'
import { transliterateZh, type Kinds, type NamingStyleDef, type Tpl } from '../../../gen/naming'

/**
 * 内置的四种命名风格（由 ../world.ts 登记）：西幻、史诗、东方、和风。
 * 各自的通名模板、国名模板与取词根的办法；取名的引擎在 gen/naming.ts。
 * 词表的内容与先后、取词根时随机数的抽取顺序都是生成结果的一部分，改动会让旧种子的地名全部改变。
 */

// —— 通名模板：# 处放专名 ——
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

const isTown = (kind: string) => kind === 'city' || kind === 'capital'

/** 西幻：虚构语言的专名，中文按音译、日文按片假名转写。专名由 Language 从调用方给的流里取 */
export const fantasy: NamingStyleDef = {
  id: 'fantasy',
  label: '西幻',
  tip: '虚构语言的专名：中文音译、日文片假名',
  kinds: WESTERN,
  realm: REALM_WESTERN,
  avoidEcho: false,
  roots({ rNames }) {
    const lang = new Language(rNames)
    return () => {
      const en = lang.word()
      return { en, zh: transliterateZh(en), ja: katakana(en) }
    }
  },
}

/** 史诗：意义词根（霜 + 岭 = Frostfell），三种语言各自意译 */
export const epic: NamingStyleDef = {
  id: 'epic',
  label: '史诗',
  tip: '意义词根：霜岭、银港、鸦渡……三语意译',
  kinds: EPIC,
  realm: REALM_WESTERN,
  avoidEcho: true,
  roots:
    ({ rng: r }) =>
    (kind) => {
      const town = isTown(kind)
      const a = r.pick(EPIC_HEAD)
      let b = r.pick(town ? EPIC_TOWN : EPIC_LAND)
      while (b[1] === a[1]) b = r.pick(town ? EPIC_TOWN : EPIC_LAND)
      return { en: a[0] + b[0], zh: a[1] + b[1], ja: a[2] + b[2] }
    },
}

/** 东方：汉字专名，英文用拼音，日文用对应的日本汉字 */
export const eastern: NamingStyleDef = {
  id: 'eastern',
  label: '东方',
  tip: '汉字地名：英文拼音、日文汉字',
  kinds: EASTERN,
  realm: REALM_EASTERN,
  avoidEcho: true,
  roots:
    ({ rng: r }) =>
    (kind) => {
      const town = isTown(kind)
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
    },
}

/** 和风：日本地名，英文用罗马字，中文用对应的简体字 */
export const wa: NamingStyleDef = {
  id: 'wa',
  label: '和风',
  tip: '日本地名：英文罗马字、中文汉字',
  kinds: WA,
  realm: REALM_WA,
  avoidEcho: true,
  roots:
    ({ rng: r }) =>
    () => {
      const a = r.pick(WA_HEAD)
      const b = r.pick(WA_TAIL)
      const en = a[1] + b[1]
      return { en: en[0].toUpperCase() + en.slice(1), zh: a[2] + b[2], ja: a[0] + b[0] }
    },
}
