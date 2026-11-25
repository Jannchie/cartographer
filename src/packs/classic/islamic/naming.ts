import type { Tri } from '../../../gen/naming'
import type { RNG } from '../../../gen/rng'
import { choose, fill, tri, type CultureNaming, type LandmarkNameKind, type SacredNames, type SettleNamer, type T3 } from '../../../settlement/names'
import type { WardType } from '../../../settlement/types'

/**
 * 伊斯兰的名字：专名是阿拉伯风味的音节词，英文罗马字、中文音译、日文片假名；
 * 通名英文照读阿拉伯语（Bab、Souq、Wadi），中日文意译。
 */

/** 音节表：[中文, 罗马字, 片假名]；词 = 词首 +（词中）+ 词尾，拼出 Marakesh、Tarudant、Rabat 这样的词 */
const AR_OPEN: T3[] = [
  ['马', 'Ma', 'マ'], ['拉', 'Ra', 'ラ'], ['萨', 'Sa', 'サ'], ['法', 'Fa', 'ファ'], ['哈', 'Ha', 'ハ'], ['卡', 'Ka', 'カ'], ['盖', 'Qa', 'カ'], ['塔', 'Ta', 'タ'],
  ['扎', 'Za', 'ザ'], ['巴', 'Ba', 'バ'], ['达', 'Da', 'ダ'], ['贾', 'Ja', 'ジャ'], ['纳', 'Na', 'ナ'], ['穆', 'Mu', 'ム'], ['努', 'Nu', 'ヌ'], ['苏', 'Su', 'ス'],
  ['图', 'Tu', 'トゥ'], ['库', 'Ku', 'ク'], ['梅', 'Me', 'メ'], ['费', 'Fe', 'フェ'], ['西', 'Si', 'シ'], ['阿', 'A', 'ア'], ['乌', 'U', 'ウ'], ['伊', 'I', 'イ'],
  ['丹', 'Tan', 'タン'], ['马尔', 'Mar', 'マル'], ['萨尔', 'Sal', 'サル'], ['塔尔', 'Tar', 'タル'], ['卡斯', 'Qas', 'カス'], ['扎尔', 'Zar', 'ザル'], ['哈姆', 'Ham', 'ハム'],
]
const AR_MID: T3[] = [
  ['拉', 'ra', 'ラ'], ['里', 'ri', 'リ'], ['鲁', 'ru', 'ル'], ['利', 'li', 'リ'], ['马', 'ma', 'マ'], ['米', 'mi', 'ミ'], ['纳', 'na', 'ナ'], ['尼', 'ni', 'ニ'],
  ['巴', 'ba', 'バ'], ['比', 'bi', 'ビ'], ['达', 'da', 'ダ'], ['迪', 'di', 'ディ'], ['哈', 'ha', 'ハ'], ['贾', 'ja', 'ジャ'], ['卡', 'ka', 'カ'], ['萨', 'sa', 'サ'],
  ['塔', 'ta', 'タ'], ['瓦', 'wa', 'ワ'], ['亚', 'ya', 'ヤ'], ['齐', 'zi', 'ジ'], ['菲', 'fi', 'フィ'], ['库', 'ku', 'ク'],
]
const AR_END: T3[] = [
  ['喀什', 'kesh', 'ケシュ'], ['巴特', 'bat', 'バト'], ['马德', 'mad', 'マド'], ['西姆', 'sim', 'シム'], ['希尔', 'hir', 'ヒル'], ['丹', 'dan', 'ダン'],
  ['利姆', 'lim', 'リム'], ['里夫', 'rif', 'リフ'], ['吉德', 'jid', 'ジド'], ['达斯', 'das', 'ダス'], ['齐尔', 'zir', 'ジル'], ['马尔', 'mar', 'マル'],
  ['纳特', 'nat', 'ナト'], ['万', 'wan', 'ワン'], ['卡尔', 'qar', 'カル'], ['苏斯', 'sus', 'スス'], ['坦', 'tan', 'タン'], ['伦', 'run', 'ルン'],
  ['比尔', 'bir', 'ビル'], ['拉特', 'lat', 'ラト'], ['基尔', 'kir', 'キル'], ['赞', 'zan', 'ザン'], ['丁', 'din', 'ディン'], ['哈德', 'had', 'ハド'],
  ['法', 'fa', 'ファ'], ['拉', 'ra', 'ラ'], ['纳', 'na', 'ナ'], ['亚', 'ya', 'ヤ'],
]
/** 人名前缀：圣徒（Sidi）、某人之父（Abu）、某人之子（Ibn） */
const AR_PERSON: T3[] = [['西迪', 'Sidi #', 'シディ・#'], ['阿布', 'Abu #', 'アブー・#'], ['伊本', 'Ibn #', 'イブン・#'], ['穆莱', 'Moulay #', 'ムーレイ・#']]
/** 专有的称号（清真寺、宫殿、浴场常用）：中文、日文照读 */
const AR_EPITHET: T3[] = [
  ['宰图纳', 'al-Zaytuna', 'ザイトゥーナ'], ['库图比亚', 'al-Kutubiyya', 'クトゥビーヤ'], ['爱资哈尔', 'al-Azhar', 'アズハル'], ['曼苏尔', 'al-Mansur', 'マンスール'],
  ['安达卢斯', 'al-Andalus', 'アンダルス'], ['努尔', 'al-Nur', 'ヌール'], ['哈姆拉', 'al-Hamra', 'ハムラー'], ['贾迪德', 'al-Jadid', 'ジャディード'],
  ['卡比尔', 'al-Kabir', 'カビール'], ['萨利希', 'al-Salihi', 'サーリヒー'], ['卡鲁因', 'al-Qarawiyyin', 'カラウィーイーン'], ['纳斯尔', 'al-Nasr', 'ナスル'],
]
/** 行当：集市、街巷、片区按行当得名（Souq al-Attarin 香料市）。中文、日文是行当的意思 */
const AR_TRADE: T3[] = [
  ['香料', 'al-Attarin', '香料'], ['铜器', 'al-Nahhasin', '銅器'], ['染坊', 'al-Sabbaghin', '染物'], ['皮革', 'al-Dabbaghin', '皮革'], ['地毯', 'al-Zarabi', '絨毯'],
  ['金器', 'al-Sagha', '金細工'], ['布匹', 'al-Bazzazin', '布'], ['陶器', 'al-Fakhkharin', '陶器'], ['书籍', 'al-Kutubiyyin', '書籍'], ['羊毛', 'al-Souf', '羊毛'],
  ['马具', 'al-Sarrajin', '馬具'], ['铁器', 'al-Haddadin', '鉄器'],
]
/** 街巷按景物得名（Darb al-Rumman 石榴街） */
const AR_STREET: T3[] = [
  ['泉', 'al-Ain', '泉'], ['枣椰', 'al-Nakhla', 'ナツメヤシ'], ['石榴', 'al-Rumman', '柘榴'], ['清真寺', 'al-Masjid', 'モスク'], ['浴场', 'al-Hammam', '浴場'],
  ['水车', 'al-Saqiya', '水車'], ['橄榄', 'al-Zaytun', 'オリーブ'], ['烤炉', 'al-Farran', 'パン窯'], ['驼队', 'al-Qafila', '隊商'], ['玫瑰', 'al-Ward', '薔薇'],
  ['狮子', 'al-Asad', '獅子'], ['长老', 'al-Shaykh', '長老'], ['茉莉', 'al-Yasmin', 'ジャスミン'], ['新', 'al-Jadid', '新'], ['长', 'al-Tawil', '長'],
]
const AR_STREET_NO_BATH = AR_STREET.filter(([zh]) => zh !== '浴场')
const AR_DISTRICT:Partial<Record<WardType, T3[]>> = {
  market: [['香料市', 'Souq al-Attarin', '香料市場'], ['布市', 'Souq al-Bazzazin', '布市場'], ['铜器市', 'Souq al-Nahhasin', '銅器市場'], ['大集市', 'Souq al-Kabir', '大スーク']],
  merchant: [['金匠区', 'Harat al-Sagha', '金細工師街'], ['商人区', 'Harat al-Tujjar', '商人街'], ['钱商区', 'Harat al-Sarrafin', '両替商街']],
  craft: [
    ['制革区', 'Harat al-Dabbaghin', '皮なめし街'], ['染坊区', 'Harat al-Sabbaghin', '染物師街'], ['铁匠区', 'Harat al-Haddadin', '鍛冶屋街'],
    ['陶匠区', 'Harat al-Fakhkharin', '陶工街'], ['木匠区', 'Harat al-Najjarin', '大工街'], ['织工区', 'Harat al-Hayyakin', '織工街'],
  ],
  common: [
    ['老城', 'Medina Qadima', '旧市街'], ['新城', 'Hay Jadid', '新市街'], ['北区', 'Hay al-Shamal', '北地区'], ['南区', 'Hay al-Janub', '南地区'],
    ['东区', 'Hay al-Sharq', '東地区'], ['西区', 'Hay al-Gharb', '西地区'], ['河畔区', 'Hay al-Wadi', '河畔地区'], ['泉水区', 'Harat al-Ain', '泉地区'],
    ['枣椰区', 'Harat al-Nakhil', 'ナツメヤシ地区'],
  ],
  slum: [['泥屋区', 'Harat al-Tin', '泥小屋街'], ['穷人区', 'Harat al-Masakin', '貧民街']],
  noble: [['贵族区', "Harat al-A'yan", '名士街'], ['花园区', 'Hay al-Riyad', '庭園地区'], ['宫侧区', 'Harat al-Qasr', '宮殿街']],
  harbor: [['码头区', 'Harat al-Mina', '港地区'], ['造船坊', "Dar al-Sina'a", '造船所'], ['渔人区', 'Harat al-Sayyadin', '漁師街']],
  temple: [['清真寺区', "Harat al-Jami'", 'モスク地区'], ['道堂区', 'Harat al-Zawiya', 'ザーウィヤ地区']],
  magic: [['秘学区', 'Harat al-Hikma', '叡智街'], ['星象区', 'Harat al-Falakiyyin', '星読み街'], ['术士区', 'Harat al-Sahara', '魔術師街']],
  suburb: [['城郊', 'al-Rabad', '城外町'], ['外城', 'Rabad al-Kharij', '外町']],
}

/** 阿拉伯风味的专名：两三个音节 */
export function arab(r: RNG): T3 {
  const parts = [r.pick(AR_OPEN)]
  if (r.next() < 0.5) {
    // 别让同一个音叠在一起（Kakakesh）
    let m = r.pick(AR_MID)
    while (m[0] === parts[0][0]) m = r.pick(AR_MID)
    parts.push(m)
  }
  parts.push(r.pick(AR_END))
  return [parts.map((p) => p[0]).join(''), parts.map((p) => p[1]).join(''), parts.map((p) => p[2]).join('')]
}

/** 人名：Sidi Salim、Abu Hamad……（圣徒、捐建者） */
export function arabPerson(r: RNG): T3 {
  const [pz, pe, pj] = r.pick(AR_PERSON)
  const [z, e, j] = arab(r)
  return [pz + z, pe.replace('#', e), pj.replace('#', j)]
}

/** 伊斯兰建筑的专名：人名、称号或地名，三选一 */
function arabDedic(r: RNG): T3 {
  const k = r.next()
  return k < 0.4 ? arabPerson(r) : k < 0.7 ? r.pick(AR_EPITHET) : arab(r)
}

/** 伊斯兰城市的专名：清真寺（大 / 小）、集市、浴场、城堡（卡斯巴）、经学院、商队客栈、染坊 */
export type IslamicKind = 'greatMosque' | 'mosque' | 'souq' | 'hammam' | 'kasbah' | 'madrasa' | 'caravanserai' | 'tannery'

/** 伊斯兰城市的专名（去重）：大清真寺、清真寺、集市、浴场、卡斯巴、经学院、商队客栈 */
export const islamicName = (n: SettleNamer, kind: IslamicKind): Tri => n.uniq(() => islamicNameOf(kind, n.rng))

function islamicNameOf(kind: IslamicKind, r: RNG): Tri {
  switch (kind) {
    case 'greatMosque': {
      // Great Mosque of 地名，或 Jami' al-称号（宰图纳、卡鲁因那样）
      const k = r.next()
      if (k < 0.4) return fill(['#大清真寺', 'Great Mosque of #', '#大モスク'], arab(r))
      if (k < 0.8) return fill(['#大清真寺', "Jami' #", '#・モスク'], r.pick(AR_EPITHET))
      return tri(r.pick([['星期五清真寺', 'Friday Mosque', '金曜モスク'], ['大清真寺', 'The Great Mosque', '大モスク']] as T3[]))
    }
    case 'mosque':
      return fill(r.next() < 0.5 ? ['#清真寺', 'Masjid #', '#・モスク'] : ['#清真寺', '# Mosque', '#・モスク'], arabDedic(r))
    case 'souq': {
      if (r.next() < 0.7) return fill(['#市', 'Souq #', '#市場'], r.pick(AR_TRADE))
      // 按开市的日子得名
      return tri(
        r.pick([
          ['周五集', "Souq al-Jum'a", '金曜市'],
          ['周四集', 'Souq al-Khamis', '木曜市'],
          ['周日集', 'Souq al-Had', '日曜市'],
          ['大集市', 'Souq al-Kabir', '大スーク'],
        ] as T3[]),
      )
    }
    case 'hammam':
      // 按街景得名时不取"浴场"本身（免得"浴场浴场"）
      return fill(r.pick([['#浴场', 'Hammam #', '#浴場'], ['#浴室', '# Baths', '#の湯']] as T3[]), r.next() < 0.3 ? r.pick(AR_STREET_NO_BATH) : arabDedic(r))
    case 'tannery':
      // 染坊（Dar Dbagh）：头一个就叫染坊，其余按人名、地名
      return r.next() < 0.3 ? tri(['染坊', 'The Tannery', 'なめし場']) : fill(['#染坊', 'Dar Dbagh #', '#なめし場'], r.next() < 0.5 ? arabPerson(r) : arab(r))
    case 'kasbah':
      return r.next() < 0.4 ? tri(['卡斯巴', 'The Kasbah', 'カスバ']) : fill(['#卡斯巴', 'Kasbah #', '#・カスバ'], arab(r))
    case 'madrasa':
      return fill(r.pick([['#经学院', 'Madrasa #', '#・マドラサ'], ['#学院', 'Madrasa #', '#学院']] as T3[]), arabDedic(r))
    case 'caravanserai': {
      const k = r.next()
      if (k < 0.4) return fill(['#客栈', 'Funduq #', '#のフンドゥク'], arabDedic(r))
      if (k < 0.75) return fill(['#商队客栈', 'Caravanserai of #', '#隊商宿'], arab(r))
      return fill(['#驿站', 'Khan #', '#のハーン'], r.next() < 0.5 ? r.pick(AR_TRADE) : arabPerson(r))
    }
  }
}

function landmark(n: SettleNamer, kind: LandmarkNameKind, magic: number): Tri {
  const r = n.rng
  const A = (tpl: T3) => fill(tpl, arab(n.rng))
  switch (kind) {
    case 'castle':
      return r.next() < 0.5 ? islamicNameOf('kasbah', r) : n.pick([['城堡', "The Qal'a", '城砦'], ['总督府', 'Dar al-Imara', '総督府'], ['王宫', 'Dar al-Makhzen', '王宮']])
    case 'temple':
      return islamicNameOf(r.next() < 0.5 ? 'greatMosque' : 'mosque', r)
    case 'chapel': {
      // 小清真寺、苏非道堂、圣徒墓
      const k = r.next()
      if (k < 0.4) return islamicNameOf('mosque', r)
      if (k < 0.7) return fill(['#道堂', 'Zawiya of #', '#のザーウィヤ'], arabPerson(n.rng))
      return fill(['#圣墓', 'Qubba of #', '#廟'], arabPerson(n.rng))
    }
    case 'market':
    case 'halle':
      return r.next() < 0.75 ? islamicNameOf('souq', r) : tri(['盖萨里亚', 'The Qaysariyya', 'カイサリーヤ'])
    case 'harbor':
      // 河港：河埠、税卡（Maks 是过境税）、船坞
      return n.coast
        ? n.pick([['海关', 'Diwan al-Bahr', '海関'], ['港口', 'al-Mina', '港'], ['造船坊', "Dar al-Sina'a", '造船所']])
        : n.pick([['河埠', 'Marsa al-Nahr', '河港'], ['税卡', 'Diwan al-Maks', '関税所'], ['船坞', 'Dar al-Sufun', '船渠']])
    case 'magic':
      if (magic >= 2) return n.pick([['智慧宫', 'Bayt al-Hikma', '知恵の館'], ['群星塔', 'Burj al-Nujum', '星々の塔'], ['镇尼宫', 'Qasr al-Jinn', 'ジンの宮殿']])
      return n.pick([['炼金坊', 'Dar al-Kimiya', '錬金工房'], ['术士塔', 'Burj al-Sahir', '魔術師の塔'], ['星盘坊', 'Dar al-Asturlab', 'アストロラーベ工房']])
    case 'shrine':
      return r.next() < 0.6 ? fill(['#圣墓', 'Qubba of #', '#廟'], arabPerson(n.rng)) : tri(['福泉', 'Ain al-Baraka', '祝福の泉'])
    case 'ferry':
      return A(['#渡口', '# Ferry', '#の渡し'])
    case 'park':
      return n.pick([['王家花园', 'The Agdal', '王家庭園'], ['橄榄园', 'Jnan al-Zaytun', 'オリーブ園'], ['枣椰林', 'The Palm Grove', 'ナツメヤシ林'], ['喷泉园', 'Riyad al-Nafura', '噴水の庭']])
    case 'cemetery':
      return r.next() < 0.5 ? tri(['墓园', 'The Maqbara', '墓地']) : fill(['#墓园', 'Maqbarat #', '#墓地'], arabPerson(n.rng))
    case 'barracks':
      return n.pick([['兵营', 'Barracks', '兵営'], ['军械库', 'Dar al-Silah', '武器庫'], ['校场', 'The Mechouar', '練兵場']])
    case 'guild':
      return n.pick([['商人会馆', 'Dar al-Tujjar', '商人会館'], ['铜匠行会', "Coppersmiths' Guild", '銅細工組合'], ['织工行会', "Weavers' Guild", '織工組合']])
    case 'exchange':
      return n.pick([['兑换所', 'Dar al-Sarf', '両替所'], ['铸币厂', 'Dar al-Sikka', '造幣所'], ['盖萨里亚', 'The Qaysariyya', 'カイサリーヤ']])
    case 'warehouse':
      // Agadir 是筑垒的粮仓，Makhzan 是库房
      return n.pick([['货栈', 'The Funduq', 'フンドゥク'], ['粮仓', 'The Agadir', '穀物倉'], ['库房', 'The Makhzan', '倉庫']])
    case 'observatory':
      return n.pick([['观象台', 'al-Marsad', '天文台'], ['授时房', 'Dar al-Muwaqqit', '時計係の館']])
    case 'tavern':
      return islamicNameOf('caravanserai', r)
    case 'portal':
      return n.pick([['星门', 'Bab al-Nujum', '星の門'], ['镇尼之门', 'Bab al-Jinn', 'ジンの門'], ['传送门', 'The Portal', '転移門']])
    case 'stage':
      // 广场上说书、耍艺人的圈子（halqa），皮影戏
      return n.pick([['说书圈', 'The Halqa', '語り部の輪'], ['皮影戏台', 'Khayal al-Zill', '影絵芝居小屋'], ['乐坊', "Dar al-Sama'", '音楽の館']])
    case 'pulpit':
      return n.pick([['讲经台', 'The Minbar', 'ミンバル'], ['诵经台', 'The Dikka', 'ディッカ'], ['宣讲台', "Kursi al-Wa'z", '説教壇']])
    case 'arena':
      return n.pick([['马术场', 'Maydan al-Furusiyya', '馬術場'], ['赛马场', 'The Maydan', '競馬場'], ['摔跤场', 'Wrestling Ground', 'レスリング場']])
    case 'winery':
      // 不酿酒：葡萄园或榨油坊
      return r.next() < 0.5 ? A(['#葡萄园', 'Karm #', '#葡萄園']) : A(['#榨油坊', "Ma'sarat #", '#搾油所'])
    case 'amphitheater':
      return n.pick([['罗马剧场', 'The Roman Theatre', 'ローマ劇場'], ['古竞技场', 'The Old Arena', '古闘技場']])
    case 'mill':
      return r.next() < 0.5 ? A(['#磨坊', 'Tahunat #', '#水車小屋']) : A(['#水车', '# Noria', '#水車'])
    case 'windmill':
      return A(['#风车', '# Windmill', '#風車'])
    case 'hospital':
      return r.next() < 0.6 ? fill(['#医院', 'Bimaristan #', '#病院'], arabDedic(n.rng)) : tri(['大医院', 'The Great Bimaristan', '大病院'])
    case 'school':
      return islamicNameOf('madrasa', r)
    case 'gallows':
      return tri(['刑场', 'Execution Ground', '刑場'])
    case 'kiln':
      return n.pick([['陶窑', "The Potters' Kilns", '陶窯'], ['砖窑', 'Brick Kilns', '煉瓦窯']])
    case 'quarry':
      return A(['#采石场', '# Quarry', '#石切場'])
    case 'lighthouse':
      return A(['#灯塔', 'Manarat #', '#灯台'])
  }
}

/** 都城的宫殿 */
function palace(_n: SettleNamer, r: RNG): Tri {
  // Dar al-Makhzen 是摩洛哥王宫的叫法
  const k = r.next()
  if (k < 0.3) return tri(['王宫', 'Dar al-Makhzen', '王宮'])
  return fill(['#宫', 'Qasr #', '#宮殿'], k < 0.65 ? r.pick(AR_EPITHET) : arab(r))
}

/** 规模档与名所的专名（伊斯兰的叫法） */
export const ISLAMIC_SACRED: SacredNames = {
  abbey: (n) => fill(['#道堂', 'Zawiya #', '#・ザーウィヤ'], arabPerson(n.rng)),
  crag: (n) => fill(['#卡斯巴', 'Qasba #', '#・カスバ'], arab(n.rng)),
  manor: (n) => fill(['#堡', 'Qasr #', '#・カスル'], arab(n.rng)),
  ribat: (n) => fill(['#里巴特', 'Ribat #', '#・リバート'], arab(n.rng)),
  masjid: (n) => fill(['#小清真寺', 'Masjid #', '#・マスジド'], arabDedic(n.rng)),
  rikyu: (n) => fill(['#园', 'Bagh-e #', '#庭園'], arab(n.rng)),
  greatPark: (n) => fill(['#园', 'Bagh-e #', '#庭園'], arab(n.rng)),
}

/** 起名规则（名所的专名在文明定义里接上，见 ../sacredNames.ts） */
export const naming: Omit<CultureNaming, 'sacred'> = {
  // 小的是泉、井、筑垒的村子（Ain、Bir、Ksar），大的是集镇、城
  town: {
    hamlet: [['#村', '#', '#'], ['#泉', 'Ain #', 'アイン・#'], ['#井', 'Bir #', 'ビール・#'], ['#堡', 'Ksar #', 'クサル・#']],
    village: [['#村', '#', '#'], ['#泉', 'Ain #', 'アイン・#'], ['#堡', 'Ksar #', 'クサル・#'], ['#集', 'Souk #', 'スーク・#']],
    town: [['#镇', '#', '#'], ['#堡', 'Qasr #', 'カスル・#'], ['#集', 'Souk #', 'スーク・#']],
    city: [['#城', '#', '#'], ['#城', 'Madinat #', 'マディーナト・#']],
  },
  townName(n, pool, _size, coast, river, crossing) {
    const r = n.rng
    // 临河的看怎么过河：有桥是 Jisr（桥），渡口、浅滩是 Mashra'（渡）
    const s: T3 =
      coast && r.next() < 0.4
        ? ['#港', 'Marsa #', 'マルサ・#']
        : river && crossing && r.next() < 0.3
          ? crossing === 'bridge'
            ? ['#桥', 'Jisr #', 'ジスル・#']
            : ['#渡', "Mashra' #", 'マシュラア・#']
          : r.next() < 0.5
            ? pool[0]
            : r.pick(pool)
    return () => fill(s, arab(n.rng))
  },
  // 河是 Wadi / Oued / Nahr，中文都叫河；Jebel 山、Tell 丘、Ras 岬角似的山头
  feature: {
    river: [['#河', 'Wadi #', 'ワディ・#'], ['#河', 'Oued #', 'ウエド・#'], ['#河', 'Nahr #', 'ナフル・#']],
    sea: [['#海', 'Bahr #', '#海'], ['#湾', 'Gulf of #', '#湾'], ['#湾', 'Khalij #', 'ハリージュ・#']],
    hill: [['#山', 'Jebel #', 'ジェベル・#'], ['#丘', 'Tell #', 'テル・#'], ['#峰', 'Ras #', 'ラス・#']],
  },
  featureName: (n, suf) => fill(choose(n.rng, suf), arab(n.rng)),
  district: AR_DISTRICT,
  // 大道 Tariq、街 Darb、巷 Zanqat；按景物、行当或人得名
  street: {
    main: [['#大道', 'Tariq #', '#街道'], ['#大街', 'Darb #', '#大通り']],
    street: [['#街', 'Darb #', '#通り']],
    lane: [['#巷', 'Zanqat #', '#小路']],
  },
  streetName(n, suf) {
    const r = n.rng
    const k = r.next()
    return fill(r.pick(suf), k < 0.5 ? r.pick(AR_STREET) : k < 0.8 ? r.pick(AR_TRADE) : arabPerson(n.rng))
  },
  // 城门 Bab al-X：按方位，或按门外是什么（海、沙漠、墓地、周四的集）
  gates: [
    [['东门', 'Bab al-Sharq', '東門'], ['太阳门', 'Bab al-Shams', '太陽門'], ['胜利门', 'Bab al-Nasr', '勝利門'], ['周四门', 'Bab al-Khamis', '木曜門']],
    [['南门', 'Bab al-Janub', '南門'], ['沙漠门', 'Bab al-Sahra', '砂漠門'], ['基卜拉门', 'Bab al-Qibla', 'キブラ門'], ['铁匠门', 'Bab al-Haddadin', '鍛冶屋門']],
    [['西门', 'Bab al-Gharb', '西門'], ['海门', 'Bab al-Bahr', '海門'], ['狮门', "Bab al-Siba'", '獅子門'], ['皮匠门', 'Bab al-Dabbaghin', '皮なめし門']],
    [['北门', 'Bab al-Shamal', '北門'], ['征服门', 'Bab al-Futuh', '征服門'], ['新门', 'Bab Jdid', '新門'], ['墓园门', 'Bab al-Maqabir', '墓地門']],
  ],
  qualify: [['新', '# al-Jadid', '新'], ['老', '# al-Qadim', '旧'], ['大', '# al-Kabir', '大'], ['小', '# al-Saghir', '小'], ['东', '# al-Sharqi', '東'], ['西', '# al-Gharbi', '西'], ['南', '# al-Janubi', '南'], ['北', '# al-Shamali', '北']],
  landmark,
  palace,
}
