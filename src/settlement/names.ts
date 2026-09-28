import { Language } from '../gen/names'
import { katakana } from '../gen/names_ja'
import { transliterateZh, type Tri } from '../gen/naming'
import { RNG, hashString } from '../gen/rng'
import type { Culture, SettlementSize, WardType } from './types'

/**
 * 聚落里的名字，一律同时写成中文、英文、日文（Tri），说的是同一个东西：
 * - 西式：专名是虚构语言的词，英文原样、中文音译、日文片假名；通名（教堂、城门、客栈……）三语各自意译；
 * - 东式：专名是汉字，英文用拼音、日文用对应的日本汉字；通名三语意译（坊 Ward、大街 Avenue……）；
 * - 和风：专名是日本汉字，英文用罗马字、中文用简体字；通名英文多照读（-machi、-dōri、-ji），也有意译的（Castle、Shrine）；
 * - 伊斯兰：专名是阿拉伯风味的音节词，英文罗马字、中文音译、日文片假名；通名英文照读阿拉伯语（Bab、Souq、Wadi），中日文意译。
 */
export type T3 = [zh: string, en: string, ja: string]
export const tri = ([zh, en, ja]: T3): Tri => ({ zh, en, ja })

// —————————————————————— 东式：汉字 → 拼音 / 日本汉字 ——————————————————————

const HAN: Record<string, [string, string]> = {}
for (const w of (
  '安:an:安 仁:ren:仁 崇:chong:崇 义:yi:義 永:yong:永 宁:ning:寧 平:ping:平 康:kang:康 兴:xing:興 道:dao:道 光:guang:光 ' +
  '德:de:徳 善:shan:善 和:he:和 怀:huai:懐 远:yuan:遠 长:chang:長 乐:le:楽 宣:xuan:宣 阳:yang:陽 通:tong:通 济:ji:済 ' +
  '延:yan:延 寿:shou:寿 丰:feng:豊 昌:chang:昌 明:ming:明 太:tai:太 清:qing:清 嘉:jia:嘉 会:hui:会 修:xiu:修 文:wen:文 ' +
  '敦:dun:敦 化:hua:化 常:chang:常 静:jing:静 昭:zhao:昭 归:gui:帰 靖:jing:靖 恭:gong:恭 升:sheng:昇 晋:jin:晋 ' +
  '青:qing:青 苍:cang:蒼 碧:bi:碧 金:jin:金 玉:yu:玉 云:yun:雲 松:song:松 柏:bai:柏 竹:zhu:竹 梅:mei:梅 桃:tao:桃 ' +
  '杏:xing:杏 柳:liu:柳 桐:tong:桐 枫:feng:楓 溪:xi:渓 泉:quan:泉 涧:jian:澗 月:yue:月 星:xing:星 霞:xia:霞 岚:lan:嵐 ' +
  '峰:feng:峰 岩:yan:岩 潭:tan:潭 海:hai:海 河:he:河 渡:du:渡 津:jin:津'
).split(' ')) {
  const [c, py, ja] = w.split(':')
  HAN[c] = [py, ja]
}
const AUSP = [...'安仁崇义永宁平康兴道光德善和怀远长乐宣阳通济延寿丰昌明太清嘉会修文敦化常静昭归靖恭升晋']
const NATURE = [...'青苍碧金玉云松柏竹梅桃杏柳桐枫溪泉涧月星霞岚峰岩潭']

/** 汉字专名的拼音（连写，首字母大写；后一音节以 a/e/o 开头时加隔音符） */
function pinyin(s: string): string {
  let out = ''
  for (const c of s) {
    const p = HAN[c]?.[0] ?? ''
    out += out && /^[aeo]/.test(p) ? `'${p}` : p
  }
  return out ? out[0].toUpperCase() + out.slice(1) : s
}
const kanji = (s: string) => [...s].map((c) => HAN[c]?.[1] ?? c).join('')

/** 东式名：汉字专名 + 通名 */
const eastName = (proper: string, [zh, en, ja]: T3): Tri => ({ zh: proper + zh, en: en.replace('#', pinyin(proper)), ja: kanji(proper) + ja })

// —————————————————————— 西式通名 ——————————————————————

const WEST_DISTRICT: Partial<Record<WardType, T3[]>> = {
  market: [['集市区', 'Market Quarter', '市場地区'], ['商会区', 'Guild Quarter', 'ギルド街'], ['行会区', 'Guildhall Quarter', '組合街']],
  merchant: [['商人区', "Merchants' Quarter", '商人街'], ['金匠区', "Goldsmiths' Row", '金細工街'], ['钱庄区', "Bankers' Quarter", '両替商街']],
  craft: [
    ['工匠区', "Artisans' Quarter", '職人街'],
    ['铁匠区', 'Smithy Quarter', '鍛冶屋街'],
    ['织工区', "Weavers' Quarter", '織工街'],
    ['制革区', "Tanners' Quarter", '皮なめし街'],
    ['陶匠区', "Potters' Quarter", '陶工街'],
  ],
  common: [
    ['老城', 'Old Town', '旧市街'],
    ['新城', 'New Town', '新市街'],
    ['北区', 'North Quarter', '北地区'],
    ['南区', 'South Quarter', '南地区'],
    ['东区', 'East Quarter', '東地区'],
    ['西区', 'West Quarter', '西地区'],
    ['河畔区', 'Riverside', '河畔地区'],
    ['钟楼区', 'Belltower Quarter', '鐘楼地区'],
  ],
  slum: [['贫民窟', 'The Rookery', '貧民街'], ['泥巷区', 'Mud Lanes', '泥小路'], ['乞丐区', "Beggars' Quarter", '物乞い街']],
  noble: [['贵族区', "Nobles' Quarter", '貴族街'], ['领主区', "Lord's Quarter", '領主街'], ['白石区', 'Whitestone', '白石地区']],
  harbor: [['码头区', 'Docklands', '波止場'], ['船坞区', 'Shipyards', '造船所地区'], ['港口区', 'Harbour Quarter', '港地区']],
  temple: [['教堂区', 'Cathedral Close', '聖堂地区'], ['修道院区', 'Abbey Quarter', '修道院地区']],
  magic: [['秘法区', 'Arcane Quarter', '秘法街'], ['法师区', "Wizards' Quarter", '魔術師街'], ['星象区', "Stargazers' Quarter", '星読み街']],
  suburb: [['外城', 'Outer Town', '外町'], ['城郊', 'Faubourg', '城外町']],
}
const EAST_DISTRICT: Partial<Record<WardType, T3[]>> = {
  market: [['东市', 'East Market', '東市'], ['西市', 'West Market', '西市'], ['南市', 'South Market', '南市'], ['北市', 'North Market', '北市']],
  harbor: [['码头', 'The Wharf', '埠頭'], ['船坞', 'Dockyard', '船渠'], ['渔港', 'Fishing Harbour', '漁港']],
  temple: [['寺前坊', 'Temple Ward', '寺前坊']],
  magic: [['仙门', 'Immortal Gate', '仙門'], ['灵境', 'Spirit Realm', '霊境']],
  suburb: [['关厢', 'Guanxiang', '関廂'], ['城郊', 'Outskirts', '城郊']],
}
const WEST_STREET: T3[] = [
  ['王冠', 'Crown', '王冠'], ['磨坊', 'Mill', '水車'], ['面包师', 'Baker', 'パン屋'], ['铁匠', 'Smith', '鍛冶'], ['织工', 'Weaver', '織工'],
  ['皮匠', 'Tanner', '皮職人'], ['酒馆', 'Tavern', '酒場'], ['钟楼', 'Bell', '鐘楼'], ['主教', 'Bishop', '司教'], ['渔夫', 'Fisher', '漁師'],
  ['石桥', 'Stonebridge', '石橋'], ['橡树', 'Oak', '樫'], ['玫瑰', 'Rose', '薔薇'], ['市场', 'Market', '市場'], ['羊毛', 'Wool', '羊毛'],
  ['银匠', 'Silversmith', '銀細工'], ['圣灵', 'Holy Ghost', '聖霊'], ['马厩', 'Stable', '厩'], ['烛匠', 'Chandler', '蝋燭'], ['桶匠', 'Cooper', '桶屋'],
]
const WEST_SAINTS: T3[] = [
  ['圣安德', 'St Andrew', '聖アンドレ'], ['圣玛丽', 'St Mary', '聖マリア'], ['圣乔治', 'St George', '聖ゲオルギウス'], ['圣彼得', 'St Peter', '聖ペテロ'],
  ['圣米迦勒', 'St Michael', '聖ミカエル'], ['圣卢卡', 'St Luke', '聖ルカ'], ['圣艾格', 'St Agnes', '聖アグネス'], ['圣伯纳', 'St Bernard', '聖ベルナール'],
]
/** 招牌：形容词 + 东西（"三"后面的英文名词用复数） */
const TAVERN_ADJ: T3[] = [
  ['金', 'Golden', '金の'], ['银', 'Silver', '銀の'], ['红', 'Red', '赤い'], ['黑', 'Black', '黒い'], ['白', 'White', '白い'], ['老', 'Old', '古い'],
  ['醉', 'Drunken', '酔いどれ'], ['跃', 'Prancing', '跳ねる'], ['独角', 'One-Horned', '一角の'], ['三', 'Three', '三つの'], ['笑', 'Laughing', '笑う'], ['歌唱', 'Singing', '歌う'],
]
const TAVERN_NOUN: T3[] = [
  ['狮', 'Lion', '獅子'], ['马', 'Horse', '馬'], ['橡树', 'Oak', '樫'], ['野猪', 'Boar', '猪'], ['天鹅', 'Swan', '白鳥'], ['乌鸦', 'Crow', '烏'], ['雄鹿', 'Stag', '牡鹿'],
  ['酒桶', 'Barrel', '酒樽'], ['竖琴', 'Harp', '竪琴'], ['王冠', 'Crown', '王冠'], ['铁锚', 'Anchor', '錨'], ['犁', 'Plough', '鋤'], ['钥匙', 'Key', '鍵'], ['鳟鱼', 'Trout', '鱒'],
]
/** 酒馆 / 客栈 / 旅店：英文都叫 The ……，日文分别是 亭 / 宿 / 館 */
const TAVERN_KIND: T3[] = [['酒馆', '', '亭'], ['客栈', ' Inn', '宿'], ['旅店', ' Lodge', '館']]

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
const fill = ([zh, en, ja]: T3, [pz, pe, pj]: T3): Tri => ({ zh: zh.replace('#', pz), en: en.replace('#', pe).replace(/^al-/, 'Al-'), ja: ja.replace('#', pj) })

// —————————————————————— 和风（城下町）：日本汉字 / 罗马字 / 简体字 ——————————————————————

const WA_HEAD: T3[] = [
  ['白', 'Shira', '白'], ['黑', 'Kuro', '黒'], ['青', 'Ao', '青'], ['朝', 'Asa', '朝'], ['月', 'Tsuki', '月'], ['樱', 'Sakura', '桜'],
  ['松', 'Matsu', '松'], ['竹', 'Take', '竹'], ['鹰', 'Taka', '鷹'], ['鹤', 'Tsuru', '鶴'], ['高', 'Taka', '高'], ['长', 'Naga', '長'],
  ['若', 'Waka', '若'], ['藤', 'Fuji', '藤'], ['梅', 'Ume', '梅'], ['菊', 'Kiku', '菊'], ['龟', 'Kame', '亀'], ['金', 'Kana', '金'],
]
const WA_TAIL: T3[] = [
  ['山', 'yama', '山'], ['川', 'kawa', '川'], ['田', 'da', '田'], ['野', 'no', '野'], ['原', 'hara', '原'], ['泽', 'sawa', '沢'],
  ['冈', 'oka', '岡'], ['崎', 'saki', '崎'], ['岛', 'shima', '島'], ['桥', 'hashi', '橋'], ['谷', 'tani', '谷'], ['森', 'mori', '森'],
]
const WA_TEMPLE: T3[] = [
  ['光明寺', 'Kōmyō-ji', '光明寺'], ['西福寺', 'Saifuku-ji', '西福寺'], ['净土寺', 'Jōdo-ji', '浄土寺'], ['本愿寺', 'Hongan-ji', '本願寺'],
  ['妙法寺', 'Myōhō-ji', '妙法寺'], ['龙泉寺', 'Ryūsen-ji', '龍泉寺'], ['大云寺', 'Daiun-ji', '大雲寺'], ['正觉寺', 'Shōgaku-ji', '正覚寺'],
  ['圆通寺', 'Entsū-ji', '円通寺'], ['善光寺', 'Zenkō-ji', '善光寺'], ['长安寺', 'Chōan-ji', '長安寺'], ['法华寺', 'Hokke-ji', '法華寺'],
]
/** 町人地按行业得名 */
const WA_MACHI: T3[] = [
  ['吴服町', 'Gofuku-machi', '呉服町'], ['绀屋町', "Kon'ya-machi", '紺屋町'], ['锻冶町', 'Kaji-machi', '鍛冶町'], ['大工町', 'Daiku-machi', '大工町'],
  ['鱼町', 'Uo-machi', '魚町'], ['米屋町', 'Komeya-machi', '米屋町'], ['材木町', 'Zaimoku-machi', '材木町'], ['本町', 'Hon-machi', '本町'],
  ['新町', 'Shin-machi', '新町'], ['茶屋町', 'Chaya-machi', '茶屋町'], ['肴町', 'Sakana-machi', '肴町'], ['桶屋町', 'Okeya-machi', '桶屋町'],
]
/** 城下町的片区（町名）：按行业、身份、位置得名 */
const WA_DISTRICT: Partial<Record<WardType, T3[]>> = {
  // 市日得名的町（三日町、八日町、十日町）
  market: [['本町', 'Hon-machi', '本町'], ['三日町', 'Mikka-machi', '三日町'], ['八日町', 'Yōka-machi', '八日町'], ['十日町', 'Tōka-machi', '十日町'], ['市场町', 'Ichiba-machi', '市場町']],
  merchant: [['吴服町', 'Gofuku-machi', '呉服町'], ['两替町', 'Ryōgae-machi', '両替町'], ['大町', 'Ō-machi', '大町'], ['米屋町', 'Komeya-machi', '米屋町'], ['茶屋町', 'Chaya-machi', '茶屋町']],
  craft: [
    ['锻冶町', 'Kaji-machi', '鍛冶町'], ['绀屋町', "Kon'ya-machi", '紺屋町'], ['大工町', 'Daiku-machi', '大工町'], ['桶屋町', 'Okeya-machi', '桶屋町'],
    ['叠町', 'Tatami-machi', '畳町'], ['铁炮町', 'Teppō-machi', '鉄砲町'], ['研屋町', 'Togiya-machi', '研屋町'], ['材木町', 'Zaimoku-machi', '材木町'],
  ],
  common: [
    ['仲町', 'Naka-machi', '仲町'], ['新町', 'Shin-machi', '新町'], ['北町', 'Kita-machi', '北町'], ['南町', 'Minami-machi', '南町'],
    ['东町', 'Higashi-machi', '東町'], ['西町', 'Nishi-machi', '西町'], ['川端町', 'Kawabata-chō', '川端町'], ['上町', 'Kami-machi', '上町'],
    ['下町', 'Shita-machi', '下町'], ['横町', 'Yoko-machi', '横町'],
  ],
  slum: [['里町', 'Ura-machi', '裏町'], ['长屋町', 'Nagaya-machi', '長屋町'], ['河原町', 'Kawara-machi', '河原町']],
  noble: [['番町', 'Banchō', '番町'], ['御徒町', 'Okachi-machi', '御徒町'], ['殿町', 'Tono-machi', '殿町'], ['中小路', 'Naka-kōji', '中小路']],
  harbor: [['湊町', 'Minato-machi', '湊町'], ['船町', 'Funa-machi', '船町'], ['滨町', 'Hama-chō', '浜町'], ['鱼町', 'Uo-machi', '魚町']],
  temple: [['寺町', 'Teramachi', '寺町'], ['门前町', 'Monzen-machi', '門前町']],
  magic: [['阴阳町', 'Onmyō-machi', '陰陽町'], ['狐町', 'Kitsune-machi', '狐町'], ['星见町', 'Hoshimi-machi', '星見町']],
  suburb: [['出町', 'Demachi', '出町'], ['新田', 'Shinden', '新田'], ['在乡町', 'Zaigō-machi', '在郷町']],
}
/** 街道名的前半：京都式的条、坊间小路，加上各地常见的 */
const WA_STREET: T3[] = [
  ['本', 'Hon', '本'], ['中', 'Naka', '中'], ['新', 'Shin', '新'], ['大手', 'Ōte', '大手'], ['堀川', 'Horikawa', '堀川'], ['寺', 'Tera', '寺'],
  ['柳', 'Yanagi', '柳'], ['松原', 'Matsubara', '松原'], ['三条', 'Sanjō', '三条'], ['四条', 'Shijō', '四条'], ['锦', 'Nishiki', '錦'], ['茶屋', 'Chaya', '茶屋'],
  ['乌丸', 'Karasuma', '烏丸'], ['高仓', 'Takakura', '高倉'], ['室町', 'Muromachi', '室町'], ['御幸', 'Miyuki', '御幸'], ['樱', 'Sakura', '桜'], ['鱼棚', 'Uonotana', '魚棚'],
]
/** 屋号（旅笼、茶屋的招牌） */
const WA_YAGO: T3[] = [
  ['菊屋', 'Kikuya', '菊屋'], ['鹤屋', 'Tsuruya', '鶴屋'], ['松屋', 'Matsuya', '松屋'], ['龟屋', 'Kameya', '亀屋'], ['梅屋', 'Umeya', '梅屋'], ['藤屋', 'Fujiya', '藤屋'],
  ['桔梗屋', 'Kikyōya', '桔梗屋'], ['大黑屋', 'Daikokuya', '大黒屋'], ['伊势屋', 'Iseya', '伊勢屋'], ['近江屋', 'Ōmiya', '近江屋'], ['越后屋', 'Echigoya', '越後屋'],
  ['丸屋', 'Maruya', '丸屋'], ['角屋', 'Sumiya', '角屋'], ['井筒屋', 'Izutsuya', '井筒屋'], ['茑屋', 'Tsutaya', '蔦屋'], ['扇屋', 'Ōgiya', '扇屋'], ['万屋', 'Yorozuya', '万屋'],
]
const WA_SHRINE: T3[] = [
  ['八幡神社', 'Hachiman Shrine', '八幡神社'], ['稻荷神社', 'Inari Shrine', '稲荷神社'], ['天满宫', 'Tenman-gū', '天満宮'], ['八坂神社', 'Yasaka Shrine', '八坂神社'],
  ['熊野神社', 'Kumano Shrine', '熊野神社'], ['日吉神社', 'Hiyoshi Shrine', '日吉神社'], ['住吉神社', 'Sumiyoshi Shrine', '住吉神社'], ['春日神社', 'Kasuga Shrine', '春日神社'],
]

// —————————————————————— 伊斯兰：阿拉伯风味的音节词 → 罗马字 / 中文音译 / 片假名 ——————————————————————

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

/** 城门：按朝向（东、南、西、北）挑名字 */
const GATES: Record<Culture, T3[][]> = {
  western: [
    [['东门', 'East Gate', '東門'], ['日出门', 'Sunrise Gate', '日の出門'], ['国王门', "King's Gate", '王の門']],
    [['南门', 'South Gate', '南門'], ['河门', 'River Gate', '川門'], ['王后门', "Queen's Gate", '王妃の門']],
    [['西门', 'West Gate', '西門'], ['日落门', 'Sunset Gate', '日没門'], ['狮门', 'Lion Gate', '獅子門']],
    [['北门', 'North Gate', '北門'], ['霜门', 'Frost Gate', '霜門'], ['塔门', 'Tower Gate', '塔門']],
  ],
  eastern: [
    [['东门', 'East Gate', '東門'], ['朝阳门', 'Chaoyang Gate', '朝陽門'], ['东华门', 'Donghua Gate', '東華門'], ['迎春门', 'Yingchun Gate', '迎春門']],
    [['南门', 'South Gate', '南門'], ['永定门', 'Yongding Gate', '永定門'], ['正阳门', 'Zhengyang Gate', '正陽門'], ['朱雀门', 'Zhuque Gate', '朱雀門']],
    [['西门', 'West Gate', '西門'], ['西华门', 'Xihua Gate', '西華門'], ['宣武门', 'Xuanwu Gate', '宣武門'], ['金光门', 'Jinguang Gate', '金光門']],
    [['北门', 'North Gate', '北門'], ['安定门', 'Anding Gate', '安定門'], ['玄武门', 'Xuanwu Gate', '玄武門'], ['德胜门', 'Desheng Gate', '徳勝門']],
  ],
  wa: [
    [['东口', 'Higashi-guchi', '東口'], ['京口', 'Kyō-guchi', '京口'], ['大手门', 'Ōte-mon', '大手門'], ['东御门', 'Higashi-gomon', '東御門']],
    [['南口', 'Minami-guchi', '南口'], ['南御门', 'Minami-gomon', '南御門'], ['樱田门', 'Sakurada-mon', '桜田門'], ['伏见口', 'Fushimi-guchi', '伏見口']],
    [['西口', 'Nishi-guchi', '西口'], ['搦手门', 'Karamete-mon', '搦手門'], ['西御门', 'Nishi-gomon', '西御門'], ['虎之门', 'Tora-no-mon', '虎ノ門']],
    [['北口', 'Kita-guchi', '北口'], ['北御门', 'Kita-gomon', '北御門'], ['清水门', 'Shimizu-mon', '清水門'], ['乾门', 'Inui-mon', '乾門']],
  ],
  // Bab al-X：按方位，或按门外是什么（海、沙漠、墓地、周四的集）
  islamic: [
    [['东门', 'Bab al-Sharq', '東門'], ['太阳门', 'Bab al-Shams', '太陽門'], ['胜利门', 'Bab al-Nasr', '勝利門'], ['周四门', 'Bab al-Khamis', '木曜門']],
    [['南门', 'Bab al-Janub', '南門'], ['沙漠门', 'Bab al-Sahra', '砂漠門'], ['基卜拉门', 'Bab al-Qibla', 'キブラ門'], ['铁匠门', 'Bab al-Haddadin', '鍛冶屋門']],
    [['西门', 'Bab al-Gharb', '西門'], ['海门', 'Bab al-Bahr', '海門'], ['狮门', "Bab al-Siba'", '獅子門'], ['皮匠门', 'Bab al-Dabbaghin', '皮なめし門']],
    [['北门', 'Bab al-Shamal', '北門'], ['征服门', 'Bab al-Futuh', '征服門'], ['新门', 'Bab Jdid', '新門'], ['墓园门', 'Bab al-Maqabir', '墓地門']],
  ],
}

export type WaKind ='castle' | 'temple' | 'samurai' | 'machi' | 'teramachi' | 'masugata' | 'shrine' | 'tenshu'
/** 伊斯兰城市的专名：清真寺（大 / 小）、集市、浴场、城堡（卡斯巴）、经学院、商队客栈、染坊 */
export type IslamicKind = 'greatMosque' | 'mosque' | 'souq' | 'hammam' | 'kasbah' | 'madrasa' | 'caravanserai' | 'tannery'

/**
 * 规模档与"名所"的专名（见 tiers.ts、sacred.ts）：大社、稻荷的千本鸟居、奥宫、海上鸟居的社、神桥、山寺、塔、
 * 修道院、朝圣教堂、岩上的城、设防庄园、里巴特、猎苑、离宫、堂区教堂、街区清真寺……
 */
export type SacredKind =
  | 'taisha'
  | 'inari'
  | 'okumiya'
  | 'umi'
  | 'shinkyo'
  | 'villageShrine'
  | 'yamadera'
  | 'pagoda'
  | 'grandTemple'
  | 'abbey'
  | 'pilgrim'
  | 'cathedral'
  | 'parish'
  | 'crag'
  | 'manor'
  | 'ribat'
  | 'masjid'
  | 'huntPark'
  | 'rikyu'
  | 'greatPark'
  | 'square'
  | 'tudi'

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
const choose = (r: RNG, s: T3 | T3[]): T3 => (typeof s[0] === 'string' ? (s as T3) : r.pick(s as T3[]))

/**
 * 一种文化怎么起名：通名表 + 专名的造法 + 各自的讲究。加一种文化 = 加一项。
 * 专名、通名谁先抽、在去重循环里还是外，都关系到随机数顺序，各项照原样写
 */
interface CultureNaming {
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
}

const NAMING: Record<Culture, CultureNaming> = {
  wa: {
    // 小的是村、宿场，大的是町；城市直接用专名（松山、金泽）
    town: {
      hamlet: [['#村', '#-mura', '#村']],
      village: [['#村', '#-mura', '#村'], ['#宿', '#-juku', '#宿']],
      town: [['#町', '#-machi', '#町'], ['#宿', '#-juku', '#宿'], ['#', '#', '#']],
      city: [['#', '#', '#']],
    },
    townName(n, suf, size, coast, river, crossing) {
      const r = n.rng
      // 临海的是浦、湊，临河的看怎么过河：有桥是桥，渡口、浅滩是渡（城市不带）
      const s: T3 =
        size === 'city'
          ? suf[0]
          : coast && r.next() < 0.4
            ? r.pick([['#浦', '#-ura', '#浦'], ['#凑', '#-minato', '#湊']] as T3[])
            : river && crossing && r.next() < 0.3
              ? crossing === 'bridge'
                ? ['#桥', '#-bashi', '#橋']
                : ['#渡', '#-watari', '#渡']
              : r.pick(suf)
      // 没有桥的，专名也不以"桥"收尾
      return () => fill(s, n.waProper(r, s[2] + (crossing === 'bridge' ? '' : '橋')))
    },
    // 〇〇川、〇〇滩、〇〇山；专名不以通名的字结尾
    feature: {
      river: ['#川', '#-gawa', '#川'],
      sea: [['#滩', '#-nada', '#灘'], ['#湾', '# Bay', '#湾'], ['#浦', '#-ura', '#浦']],
      hill: [['#山', 'Mount #', '#山'], ['#岳', '#-dake', '#岳'], ['#峠', '#-tōge', '#峠']],
    },
    featureName: (n, suf, f) => fill(choose(n.rng, suf), n.waProper(n.rng, { river: '川', sea: '浦', hill: '山峰' }[f])),
    district: WA_DISTRICT,
    // 武家地有一半叫"〇〇丁"
    districtFirst: (n, type) => (type === 'noble' && n.rng.next() < 0.4 ? () => fill(['#丁', '#-chō', '#丁'], n.waProper()) : undefined),
    street: {
      main: [['#通', '#-dōri', '#通り'], ['#大路', '#-ōji', '#大路']],
      street: [['#通', '#-dōri', '#通り'], ['#筋', '#-suji', '#筋']],
      lane: [['#小路', '#-kōji', '#小路'], ['#横丁', '#-yokochō', '#横丁']],
    },
    streetName(n, suf) {
      const r = n.rng
      return fill(r.pick(suf), r.next() < 0.7 ? r.pick(WA_STREET) : n.waProper())
    },
  },
  islamic: {
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
      return () => fill(s, n.arab())
    },
    // 河是 Wadi / Oued / Nahr，中文都叫河；Jebel 山、Tell 丘、Ras 岬角似的山头
    feature: {
      river: [['#河', 'Wadi #', 'ワディ・#'], ['#河', 'Oued #', 'ウエド・#'], ['#河', 'Nahr #', 'ナフル・#']],
      sea: [['#海', 'Bahr #', '#海'], ['#湾', 'Gulf of #', '#湾'], ['#湾', 'Khalij #', 'ハリージュ・#']],
      hill: [['#山', 'Jebel #', 'ジェベル・#'], ['#丘', 'Tell #', 'テル・#'], ['#峰', 'Ras #', 'ラス・#']],
    },
    featureName: (n, suf) => fill(choose(n.rng, suf), n.arab()),
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
      return fill(r.pick(suf), k < 0.5 ? r.pick(AR_STREET) : k < 0.8 ? r.pick(AR_TRADE) : n.arabPerson())
    },
  },
  eastern: {
    town: {
      hamlet: [['村', '#', '村'], ['庄', '#', '荘'], ['屯', '#', '屯']],
      village: [['村', '#', '村'], ['镇', '#', '鎮'], ['集', '#', '集']],
      town: [['镇', '#', '鎮'], ['县', '#', '県'], ['城', '#', '城']],
      city: [['城', '#', '城'], ['州', '#', '州'], ['府', '#', '府']],
    },
    townName(n, suf, _size, coast, river) {
      const r = n.rng
      const pre = coast && r.next() < 0.4 ? '海' : river && r.next() < 0.3 ? r.pick(['河', '渡', '津']) : ''
      return () => eastName((pre || r.pick(AUSP)) + r.pick([...AUSP, ...NATURE]), r.pick(suf))
    },
    // 专名先抽、通名后抽
    feature: {
      river: [['河', '# River', '河'], ['水', '# River', '水'], ['江', '# River', '江'], ['溪', '# Creek', '渓']],
      sea: [['海', '# Sea', '海'], ['湾', '# Bay', '湾']],
      hill: [['山', 'Mount #', '山'], ['岭', '# Ridge', '嶺'], ['峰', '# Peak', '峰']],
    },
    featureName: (n, suf) => eastName(n.rng.pick(NATURE), choose(n.rng, suf)),
    district: EAST_DISTRICT,
    // 市按方位：东市在东、西市在西；其余不看位置
    districtFits: (zh, type, w) => type !== 'market' || !w || zh === { E: '东市', W: '西市', S: '南市', N: '北市' }[w.dir],
    // 里坊：两字吉祥名 + 坊
    districtElse: (n) => eastName(n.han(AUSP, AUSP), ['坊', '# Ward', '坊']),
    street: {
      main: [['大街', '# Avenue', '大街'], ['大道', '# Road', '大道']],
      street: [['街', '# Street', '街']],
      lane: [['巷', '# Lane', '巷'], ['胡同', '# Hutong', '胡同']],
    },
    streetName(n, suf) {
      const r = n.rng
      return eastName(r.pick([...AUSP, ...NATURE]) + (r.next() < 0.5 ? r.pick(AUSP) : ''), r.pick(suf))
    },
  },
  western: {
    // 西式城名：英文、日文就是专名本身，中文按规模接个通名
    town: {
      hamlet: [['村', '#', ''], ['庄', '#', '']],
      village: [['村', '#', ''], ['镇', '#', '']],
      town: [['镇', '#', ''], ['堡', '#', '']],
      city: [['城', '#', ''], ['堡', '#', '']],
    },
    townName(n, suf, _size, coast, river, crossing) {
      const r = n.rng
      // 临河的看怎么过河：有桥才叫"某某桥"，渡口、浅滩叫"某某渡"
      const s: T3 = coast && r.next() < 0.5 ? ['港', '#', ''] : river && crossing && r.next() < 0.3 ? (crossing === 'bridge' ? ['桥', '#', ''] : ['渡', '#', '']) : r.pick(suf)
      return () => n.proper(s)
    },
    feature: {
      river: ['河', 'River #', '川'],
      sea: [['湾', '# Bay', '湾'], ['海', '# Sea', '海']],
      hill: [['丘', '# Hill', '丘'], ['岭', '# Ridge', '嶺'], ['山', 'Mount #', '山']],
    },
    featureName: (n, suf) => n.proper(choose(n.rng, suf)),
    district: WEST_DISTRICT,
    street: {
      main: [['大街', '# Street', '大通り'], ['大道', '# Avenue', '大路']],
      street: [['街', '# Street', '通り']],
      lane: [['巷', '# Lane', '小路']],
    },
    streetName(n, suf) {
      const r = n.rng
      const [zh, en, ja] = r.pick(WEST_STREET)
      const [sz, se, sj] = r.pick(suf)
      return { zh: zh + sz, en: se.replace('#', en), ja: ja + sj }
    },
  },
}

/**
 * 候选用尽、名字重了时加的区别字（新钟楼、小南门、Old Town Hall、Souq al-Attarin al-Jadid……）：
 * [中文前缀, 英文模板, 日文前缀]；方位字不加在本就带方位的名字上（不出"北南门"）
 */
const QUALIFY: Record<Culture, T3[]> = {
  western: [['新', 'New #', '新'], ['老', 'Old #', '旧'], ['上', 'Upper #', '上'], ['下', 'Lower #', '下'], ['东', 'East #', '東'], ['西', 'West #', '西'], ['南', 'South #', '南'], ['北', 'North #', '北']],
  eastern: [['新', 'New #', '新'], ['小', 'Little #', '小'], ['老', 'Old #', '旧'], ['上', 'Upper #', '上'], ['下', 'Lower #', '下'], ['东', 'East #', '東'], ['西', 'West #', '西'], ['南', 'South #', '南'], ['北', 'North #', '北']],
  wa: [['新', 'Shin #', '新'], ['古', 'Furu #', '古'], ['上', 'Kami #', '上'], ['下', 'Shimo #', '下'], ['东', 'Higashi #', '東'], ['西', 'Nishi #', '西'], ['南', 'Minami #', '南'], ['北', 'Kita #', '北']],
  islamic: [['新', '# al-Jadid', '新'], ['老', '# al-Qadim', '旧'], ['大', '# al-Kabir', '大'], ['小', '# al-Saghir', '小'], ['东', '# al-Sharqi', '東'], ['西', '# al-Gharbi', '西'], ['南', '# al-Janubi', '南'], ['北', '# al-Shamali', '北']],
}
const DIR_CHARS = /[东西南北]/

/** 河上过路的办法（聚落名里的"桥""渡"要对得上） */
export type CrossingKind = 'bridge' | 'ferry' | 'ford'

export class SettleNamer {
  /** 用过的名字：三种语言各记一份（"zh:钟楼""en:Bell Tower"），哪种语言重了都算重 */
  private used = new Set<string>()
  private lang: Language
  private _rng: RNG
  get rng(): RNG {
    return this._rng
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
  private tryUniq(make: () => Tri): Tri | undefined {
    for (let t = 0; t < 30; t++) {
      const n = make()
      if (!this.taken(n)) return this.take(n)
    }
    return undefined
  }

  /** 去重；候选用尽就给最后一个加区别字（新钟楼、Old Town Hall），还不行再编号 */
  private uniq(make: () => Tri): Tri {
    return this.tryUniq(make) ?? this.distinct(make())
  }

  private distinct(n: Tri): Tri {
    const bare = n.en.replace(/^The /, '')
    for (const [qz, qe, qj] of QUALIFY[this.culture]) {
      if (n.zh.startsWith(qz) || (DIR_CHARS.test(qz) && DIR_CHARS.test(n.zh))) continue
      const m = { zh: qz + n.zh, en: qe.replace('#', bare), ja: qj + n.ja }
      if (!this.taken(m)) return this.take(m)
    }
    for (let k = 2; ; k++) {
      const m = { zh: `${n.zh}${k}`, en: `${n.en} ${k}`, ja: `${n.ja}${k}` }
      if (!this.taken(m)) return this.take(m)
    }
  }

  /** 西式专名：虚构语言的词，中文音译、日文片假名，各接上通名 */
  proper([zh, en, ja]: T3): Tri {
    const w = this.lang.word()
    return { zh: transliterateZh(w) + zh, en: en.replace('#', w), ja: katakana(w) + ja }
  }

  pick(pool: T3[]): Tri {
    return tri(this.rng.pick(pool))
  }

  /** 两个汉字的吉祥 / 山水专名 */
  han(a = AUSP, b = [...AUSP, ...NATURE]) {
    return this.rng.pick(a) + this.rng.pick(b)
  }

  /** 和风专名：两段日本汉字（松田、白泽……）；exclude 里的字不作词尾，免得"松山山" */
  waProper(r = this.rng, exclude = ''): T3 {
    const [hz, he, hj] = r.pick(WA_HEAD)
    let t = r.pick(WA_TAIL)
    while (exclude.includes(t[2])) t = r.pick(WA_TAIL)
    return [hz + t[0], he + t[1], hj + t[2]]
  }

  /** 阿拉伯风味的专名：两三个音节 */
  arab(r = this.rng): T3 {
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
  arabPerson(r = this.rng): T3 {
    const [pz, pe, pj] = r.pick(AR_PERSON)
    const [z, e, j] = this.arab(r)
    return [pz + z, pe.replace('#', e), pj.replace('#', j)]
  }

  /** 伊斯兰建筑的专名：人名、称号或地名，三选一 */
  private arabDedic(r = this.rng): T3 {
    const k = r.next()
    return k < 0.4 ? this.arabPerson(r) : k < 0.7 ? r.pick(AR_EPITHET) : this.arab(r)
  }

  /** 聚落名（城外的村子也用它）。crossing：河上怎么过（有桥才叫"某某桥"，只有渡口、浅滩的叫"某某渡"） */
  town(size: SettlementSize, coast: boolean, river: boolean, crossing: CrossingKind | null = null): Tri {
    const c = NAMING[this.culture]
    return this.uniq(c.townName(this, c.town[size], size, coast, river, crossing))
  }

  /**
   * 规模档与名所的专名：每个名字用自己的随机数流（按 key，通常是位置），不耗主随机数——
   * 城里多一座祠、少一座塔，别的地标、街巷的名字不会跟着变
   */
  sacred(kind: SacredKind, key: string): Tri {
    const rng = this._rng
    const lang = this.lang
    this._rng = new RNG(hashString(`${this.seed}|sacred|${kind}|${key}`))
    this.lang = new Language(new RNG(hashString(`${this.seed}|sacred-lang|${key}`)))
    try {
      return this.uniq(() => this.sacredName(kind))
    } finally {
      this._rng = rng
      this.lang = lang
    }
  }

  private sacredName(kind: SacredKind): Tri {
    const r = this.rng
    const c = this.culture
    const saint = (t: T3): Tri => fill(t, r.pick(WEST_SAINTS))
    const wa = (t: T3) => fill(t, this.waProper(r))
    const han = (t: T3) => eastName(r.pick(AUSP) + r.pick(NATURE), t)
    const hill = (t: T3) => eastName(r.pick(NATURE), t)
    switch (kind) {
      case 'taisha':
        return wa(['#大社', '#-taisha', '#大社'])
      case 'inari':
        return wa(['#稻荷大社', '#-inari Taisha', '#稲荷大社'])
      case 'okumiya':
        return wa(['#山奥宫', 'Okumiya of Mt. #', '#山奥宮'])
      case 'umi':
        return wa(['#神社', '#-jinja', '#神社'])
      case 'shinkyo':
        return tri(r.pick([['神桥', 'Shinkyō', '神橋'], ['御手洗桥', 'Mitarashi Bridge', '御手洗橋'], ['朱桥', 'Vermilion Bridge', '朱橋']] as T3[]))
      case 'villageShrine':
        return c === 'wa' ? tri(r.pick(WA_SHRINE)) : tri(r.pick([['土地庙', 'Earth God Shrine', '土地廟'], ['山神庙', 'Mountain God Shrine', '山神廟'], ['娘娘庙', "Goddess' Shrine", '娘娘廟']] as T3[]))
      case 'yamadera':
        return c === 'wa' ? wa(['#山寺', '#-yamadera', '#山寺']) : hill(['山寺', '# Mountain Temple', '山寺'])
      case 'pagoda':
        return c === 'wa' ? wa(['#五重塔', '#-gojūnotō', '#五重塔']) : han(['塔', '# Pagoda', '塔'])
      case 'grandTemple':
        return c === 'wa' ? wa(['#大寺', '#-daiji', '#大寺']) : eastName(r.pick(AUSP), ['大寺', 'Great # Temple', '大寺'])
      case 'abbey':
        return c === 'islamic' ? fill(['#道堂', 'Zawiya #', '#・ザーウィヤ'], this.arabPerson(r)) : saint(['#修道院', "#'s Abbey", '#修道院'])
      case 'pilgrim':
        return r.next() < 0.5 ? this.proper(['圣母朝圣堂', 'Our Lady of #', 'の聖母巡礼教会']) : saint(['#朝圣教堂', "#'s Pilgrimage Church", '#巡礼教会'])
      case 'cathedral':
        return saint(['#主教座堂', "#'s Minster", '#大聖堂'])
      case 'parish':
        return saint(['#堂区教堂', "#'s Parish Church", '#教区教会'])
      case 'crag':
        return c === 'wa' ? wa(['#山城', '#-yamajiro', '#山城']) : c === 'eastern' ? hill(['山寨', '# Fastness', '山塞']) : c === 'islamic' ? fill(['#卡斯巴', 'Qasba #', '#・カスバ'], this.arab(r)) : this.proper(['岩堡', '# Crag', '岩城'])
      case 'manor':
        return c === 'wa' ? wa(['#馆', '#-yakata', '#館']) : c === 'eastern' ? hill(['土堡', '# Fort', '土堡']) : c === 'islamic' ? fill(['#堡', 'Qasr #', '#・カスル'], this.arab(r)) : this.proper(['庄园', '# Hall', '館'])
      case 'ribat':
        return fill(['#里巴特', 'Ribat #', '#・リバート'], this.arab(r))
      case 'masjid':
        return fill(['#小清真寺', 'Masjid #', '#・マスジド'], this.arabDedic(r))
      case 'huntPark':
        return c === 'eastern' ? hill(['苑', '# Hunting Park', '苑']) : this.proper(['猎苑', '# Chase', '猟園'])
      case 'rikyu':
        return c === 'wa' ? wa(['#离宫', '#-rikyū', '#離宮']) : c === 'eastern' ? han(['园', '# Garden Palace', '園']) : c === 'islamic' ? fill(['#园', 'Bagh-e #', '#庭園'], this.arab(r)) : this.proper(['别宫', 'Palais de #', '離宮'])
      case 'square':
        return this.proper(['广场花园', '# Gardens', '公園'])
      case 'greatPark':
        return c === 'wa' ? wa(['#庭园', '#-teien', '#庭園']) : c === 'eastern' ? han(['苑', '# Park', '苑']) : c === 'islamic' ? fill(['#园', 'Bagh-e #', '#庭園'], this.arab(r)) : this.proper(['公园', '# Park', '公園'])
      case 'tudi':
        return tri(r.pick([['土地庙', 'Earth God Shrine', '土地廟'], ['福德祠', 'Fude Shrine', '福徳祠'], ['社稷坛', 'Altar of the Soil', '社稷壇']] as T3[]))
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
    const c = NAMING[this.culture]
    return this.uniq(() => c.featureName(this, c.feature[f], f))
  }

  district(type: WardType, where?: DistrictWhere): Tri | undefined {
    const c = NAMING[this.culture]
    const first = c.districtFirst?.(this, type)
    if (first) return this.tryUniq(first)
    // 方位名、老城、新城、河畔只给位置对得上的片区
    const pool = c.district[type]?.filter(([zh]) => (c.districtFits ? c.districtFits(zh, type, where) : fits(zh, where)))
    if (pool?.length) return this.tryUniq(() => this.pick(pool))
    const other = c.districtElse
    return other ? this.uniq(() => other(this)) : undefined
  }

  street(kind: StreetKind): Tri {
    const c = NAMING[this.culture]
    const suf = c.street[kind]
    return this.uniq(() => c.streetName(this, suf))
  }

  gate(dirAngle: number): Tri {
    // dirAngle：城门朝外的方向（屏幕坐标，0 为东，π/2 为南）
    const idx = Math.round(((dirAngle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)) % 4
    const names = GATES[this.culture][idx]
    return this.uniq(() => this.pick(names))
  }

  landmark(kind: LandmarkNameKind, magic: number): Tri {
    const make = { eastern: this.eastLandmark, wa: this.waLandmark, islamic: this.islamicLandmark, western: this.westLandmark }[this.culture]
    return this.uniq(() => make.call(this, kind, magic))
  }

  private eastLandmark(kind: LandmarkNameKind, magic: number): Tri {
    const r = this.rng
    const one = (pool: T3[]) => tri(r.pick(pool))
    const N = () => r.pick(NATURE)
    const A = () => r.pick(AUSP)
    switch (kind) {
      case 'castle':
        return one([['府衙', 'Prefectural Yamen', '府衙'], ['县衙', 'County Yamen', '県衙'], ['都督府', "Governor's Residence", '都督府'], ['王府', "Prince's Mansion", '王府'], ['宫城', 'Palace City', '宮城']])
      case 'temple': {
        const k = r.int(0, 3)
        if (k === 0) return eastName(A() + A(), ['寺', '# Temple', '寺'])
        if (k === 1) return eastName(N() + A(), ['观', '# Abbey', '観'])
        return one([['文庙', 'Confucian Temple', '文廟'], ['城隍庙', 'City God Temple', '城隍廟']])
      }
      case 'chapel':
        return one([['祠堂', 'Ancestral Hall', '祠堂'], ['宗祠', 'Clan Shrine', '宗祠'], ['土地庙', 'Earth God Shrine', '土地廟']])
      case 'market':
        return one([['市楼', 'Market Tower', '市楼'], ['鼓楼', 'Drum Tower', '鼓楼'], ['钟楼', 'Bell Tower', '鐘楼'], ['市亭', 'Market Pavilion', '市亭']])
      case 'harbor':
        // 市舶司管海上贸易，只在海港；河港是河泊所（收渔税、船税）、漕运的仓
        return this.coast
          ? one([['码头', 'The Wharf', '埠頭'], ['市舶司', 'Maritime Trade Office', '市舶司'], ['船厂', 'Shipyard', '造船所']])
          : one([['码头', 'The Wharf', '埠頭'], ['河泊所', 'River Toll Office', '河泊所'], ['漕仓', 'Canal Granary', '漕倉']])
      case 'magic':
        if (magic >= 2) {
          const k = r.int(0, 2)
          if (k === 0) return eastName(N(), ['霄宗', '#xiao Sect', '霄宗'])
          if (k === 1) return eastName(N(), ['云仙门', '#yun Immortal Gate', '雲仙門'])
          return tri(['天衍阁', 'Tianyan Pavilion', '天衍閣'])
        }
        return r.next() < 0.4 ? eastName(N(), ['云观', '#yun Abbey', '雲観']) : one([['藏经阁', 'Sutra Library', '蔵経閣'], ['炼丹房', 'Elixir Chamber', '錬丹房']])
      case 'shrine':
        return one([['土地庙', 'Earth God Shrine', '土地廟'], ['山神庙', 'Mountain God Shrine', '山神廟'], ['龙王庙', 'Dragon King Temple', '竜王廟']])
      case 'ferry':
        return eastName(N(), ['渡', '# Ferry', '渡'])
      case 'park':
        return eastName((r.next() < 0.5 ? N() : A()) + A(), ['园', '# Garden', '園'])
      case 'cemetery':
        return tri(['义冢', "Paupers' Graves", '義塚'])
      case 'barracks':
        return one([['校场', 'Drill Ground', '校場'], ['兵营', 'Barracks', '兵営'], ['武库', 'Arsenal', '武庫']])
      case 'guild':
        return r.next() < 0.4 ? eastName(N(), ['商会馆', "# Merchants' Hall", '商会館']) : one([['会馆', 'Guild Hall', '会館'], ['行会公所', 'Guild Office', '行会公所']])
      case 'exchange':
        return one([['钱庄', 'Money House', '銭荘'], ['票号', 'Draft Bank', '票号'], ['交子务', 'Paper Money Bureau', '交子務']])
      case 'warehouse':
        return one([['仓廒', 'Granary', '倉廒'], ['常平仓', 'Ever-Normal Granary', '常平倉'], ['货栈', 'Warehouse', '貨桟']])
      case 'observatory':
        return one([['观星台', 'Star Terrace', '観星台'], ['司天监', 'Bureau of Astronomy', '司天監'], ['灵台', 'Spirit Terrace', '霊台']])
      case 'tavern': {
        const k = r.int(0, 2)
        if (k === 0) return eastName(A() + A(), ['客栈', '# Inn', '客桟'])
        if (k === 1) return eastName(N() + A(), ['酒楼', '# Wine House', '酒楼'])
        return tri(['悦来客栈', 'Yuelai Inn', '悦来客桟'])
      }
      case 'portal':
        return r.next() < 0.4 ? eastName(N(), ['天门', '# Heavenly Gate', '天門']) : one([['挪移阵', 'Shifting Array', '挪移陣'], ['传送阵', 'Teleport Array', '転送陣']])
      case 'stage':
        return r.next() < 0.3 ? eastName(A() + A(), ['乐台', '# Music Stage', '楽台']) : one([['戏台', 'Opera Stage', '戯台'], ['万年台', 'Wannian Stage', '万年台'], ['古戏楼', 'Old Opera House', '古戯楼']])
      case 'pulpit':
        return one([['宣讲台', 'Lecture Platform', '宣講台'], ['讲经台', 'Sutra Platform', '講経台'], ['说书场', 'Storytelling Hall', '講談場']])
      case 'arena':
        return one([['擂台', 'Leitai', '擂台'], ['演武场', 'Martial Grounds', '演武場'], ['比武台', 'Duelling Stage', '比武台']])
      case 'winery':
        return r.next() < 0.5 ? eastName(N(), ['葡萄酒坊', '# Winery', '葡萄酒坊']) : eastName(A() + N(), ['酒坊', '# Brewery', '酒坊'])
      case 'amphitheater':
        return r.next() < 0.3 ? eastName(A() + A(), ['武场', '# Martial Arena', '武場']) : one([['百戏场', 'Hundred Acts Arena', '百戯場'], ['角抵场', 'Wrestling Ground', '角抵場']])
      case 'mill':
        return eastName(N(), ['水碾', '# Watermill', '水碾'])
      case 'windmill':
        return eastName(N(), ['风车', '# Windmill', '風車'])
      case 'hospital':
        return one([['养济院', 'Almshouse', '養済院'], ['安济坊', 'Anji Infirmary', '安済坊'], ['惠民药局', "People's Dispensary", '恵民薬局']])
      case 'school':
        return r.next() < 0.5 ? eastName(N(), ['书院', '# Academy', '書院']) : one([['府学', 'Prefectural School', '府学'], ['县学', 'County School', '県学'], ['贡院', 'Examination Hall', '貢院']])
      case 'gallows':
        return tri(['刑场', 'Execution Ground', '刑場'])
      case 'kiln':
        return one([['砖瓦窑', 'Brick Kilns', '瓦窯'], ['官窑', 'Imperial Kiln', '官窯']])
      case 'quarry':
        return eastName(N(), ['石场', '# Quarry', '石切場'])
      case 'lighthouse':
        return eastName(N(), ['灯塔', '# Lighthouse', '灯台'])
      case 'halle':
        return one([['市楼', 'Market Tower', '市楼'], ['大市棚', 'Market Hall', '大市場']])
    }
  }

  /** 和风的名字（城下町）：城、寺、武家地、町人地、寺町、枡形 */
  wa(kind: WaKind): Tri | undefined {
    switch (kind) {
      case 'castle':
        return this.uniq(() => fill(['#城', '# Castle', '#城'], this.waProper()))
      case 'temple':
        return this.uniq(() => this.pick(WA_TEMPLE))
      case 'samurai':
        return this.tryUniq(() => fill(['#丁', '#-chō', '#丁'], this.waProper()))
      case 'machi':
        return this.tryUniq(() => this.pick(WA_MACHI))
      case 'teramachi':
        return this.tryUniq(() => tri(['寺町', 'Teramachi', '寺町']))
      case 'masugata':
        return tri(['枡形', 'Masugata Gate', '枡形'])
      case 'shrine':
        return this.tryUniq(() => this.pick(WA_SHRINE.slice(0, 3)))
      case 'tenshu':
        return tri(['天守', 'Tenshu', '天守'])
    }
  }

  /** 伊斯兰城市的专名：大清真寺、清真寺、集市、浴场、卡斯巴、经学院、商队客栈 */
  islamic(kind: IslamicKind): Tri {
    return this.uniq(() => this.islamicName(kind, this.rng))
  }

  private islamicName(kind: IslamicKind, r: RNG): Tri {
    switch (kind) {
      case 'greatMosque': {
        // Great Mosque of 地名，或 Jami' al-称号（宰图纳、卡鲁因那样）
        const k = r.next()
        if (k < 0.4) return fill(['#大清真寺', 'Great Mosque of #', '#大モスク'], this.arab(r))
        if (k < 0.8) return fill(['#大清真寺', "Jami' #", '#・モスク'], r.pick(AR_EPITHET))
        return tri(r.pick([['星期五清真寺', 'Friday Mosque', '金曜モスク'], ['大清真寺', 'The Great Mosque', '大モスク']] as T3[]))
      }
      case 'mosque':
        return fill(r.next() < 0.5 ? ['#清真寺', 'Masjid #', '#・モスク'] : ['#清真寺', '# Mosque', '#・モスク'], this.arabDedic(r))
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
        return fill(r.pick([['#浴场', 'Hammam #', '#浴場'], ['#浴室', '# Baths', '#の湯']] as T3[]), r.next() < 0.3 ? r.pick(AR_STREET_NO_BATH) : this.arabDedic(r))
      case 'tannery':
        // 染坊（Dar Dbagh）：头一个就叫染坊，其余按人名、地名
        return r.next() < 0.3 ? tri(['染坊', 'The Tannery', 'なめし場']) : fill(['#染坊', 'Dar Dbagh #', '#なめし場'], r.next() < 0.5 ? this.arabPerson(r) : this.arab(r))
      case 'kasbah':
        return r.next() < 0.4 ? tri(['卡斯巴', 'The Kasbah', 'カスバ']) : fill(['#卡斯巴', 'Kasbah #', '#・カスバ'], this.arab(r))
      case 'madrasa':
        return fill(r.pick([['#经学院', 'Madrasa #', '#・マドラサ'], ['#学院', 'Madrasa #', '#学院']] as T3[]), this.arabDedic(r))
      case 'caravanserai': {
        const k = r.next()
        if (k < 0.4) return fill(['#客栈', 'Funduq #', '#のフンドゥク'], this.arabDedic(r))
        if (k < 0.75) return fill(['#商队客栈', 'Caravanserai of #', '#隊商宿'], this.arab(r))
        return fill(['#驿站', 'Khan #', '#のハーン'], r.next() < 0.5 ? r.pick(AR_TRADE) : this.arabPerson(r))
      }
    }
  }

  /** 都城的宫殿（皇宫、王宫、御所……）。用自己的随机数，不打乱其他名字 */
  palace(): Tri {
    const r = new RNG(hashString(this.seed + '|palace'))
    return this.uniq(() => {
      switch (this.culture) {
        case 'eastern':
          if (r.next() < 0.5) return eastName(r.pick(AUSP) + r.pick(AUSP), ['宫', '# Palace', '宮'])
          return tri(r.pick([['皇宫', 'Imperial Palace', '皇宮'], ['紫禁城', 'Forbidden City', '紫禁城'], ['太极宫', 'Taiji Palace', '太極宮'], ['大明宫', 'Daming Palace', '大明宮']] as T3[]))
        case 'wa':
          if (r.next() < 0.3) return fill(['#御所', '#-gosho', '#御所'], this.waProper(r))
          return tri(r.pick([['御所', 'Gosho', '御所'], ['内里', 'Dairi', '内裏'], ['大内里', 'Daidairi', '大内裏']] as T3[]))
        case 'islamic': {
          // Dar al-Makhzen 是摩洛哥王宫的叫法
          const k = r.next()
          if (k < 0.3) return tri(['王宫', 'Dar al-Makhzen', '王宮'])
          return fill(['#宫', 'Qasr #', '#宮殿'], k < 0.65 ? r.pick(AR_EPITHET) : this.arab(r))
        }
        default: {
          if (r.next() < 0.5) return tri(r.pick([['王宫', 'Royal Palace', '王宮'], ['冬宫', 'Winter Palace', '冬宮'], ['夏宫', 'Summer Palace', '夏の宮殿']] as T3[]))
          const w = new Language(r.fork()).word()
          return { zh: transliterateZh(w) + '宫', en: `Palace of ${w}`, ja: katakana(w) + '宮殿' }
        }
      }
    })
  }

  private waLandmark(kind: LandmarkNameKind, magic: number): Tri {
    const r = this.rng
    const one = (pool: T3[]) => tri(r.pick(pool))
    const P = (tpl: T3) => fill(tpl, this.waProper())
    switch (kind) {
      case 'castle':
        return r.next() < 0.5 ? P(['#城', '# Castle', '#城']) : one([['阵屋', "Jin'ya", '陣屋'], ['奉行所', "Magistrate's Office", '奉行所'], ['代官所', "Intendant's Office", '代官所']])
      case 'temple':
        return r.next() < 0.6 ? this.pick(WA_TEMPLE) : P(['#寺', '#-ji', '#寺'])
      case 'chapel':
        return one([['地藏堂', 'Jizō-dō', '地蔵堂'], ['观音堂', 'Kannon-dō', '観音堂'], ['药师堂', 'Yakushi-dō', '薬師堂'], ['阎魔堂', 'Enma-dō', '閻魔堂']])
      case 'market':
      case 'halle':
        return one([['鱼市场', 'Uo-ichiba', '魚市場'], ['青物市场', 'Aomono-ichiba', '青物市場'], ['米会所', 'Rice Exchange', '米会所'], ['市场', 'Ichiba', '市場']])
      case 'harbor':
        // 海港是湊、船番所；河港是河岸（船着场）、川番所
        if (!this.coast) return r.next() < 0.5 ? P(['#河岸', '#-gashi', '#河岸']) : one([['川番所', 'Kawa-bansho', '川番所'], ['船着场', 'Funatsuki-ba', '船着場']])
        return r.next() < 0.5 ? P(['#凑', '#-minato', '#湊']) : one([['船番所', 'Funa-bansho', '船番所'], ['御船手', 'Ofunate', '御船手']])
      case 'magic':
        if (magic >= 2) return one([['阴阳寮', 'Onmyōryō', '陰陽寮'], ['天狗堂', 'Tengu-dō', '天狗堂'], ['神隐之森', 'Kamikakushi Wood', '神隠しの森']])
        return one([['阴阳师宅', "Onmyōji's House", '陰陽師の屋敷'], ['狐冢', 'Kitsune-zuka', '狐塚'], ['占卜所', "Diviner's Hut", '占い処']])
      case 'shrine':
        return r.next() < 0.6 ? this.pick(WA_SHRINE) : P(['#神社', '# Shrine', '#神社'])
      case 'ferry':
        return P(['#渡', '# Ferry', '#の渡し'])
      case 'park':
        // 大名庭园
        return one([['后乐园', 'Kōraku-en', '後楽園'], ['偕乐园', 'Kairaku-en', '偕楽園'], ['栗林园', 'Ritsurin-en', '栗林園'], ['兼六园', 'Kenroku-en', '兼六園'], ['乐寿园', 'Rakuju-en', '楽寿園'], ['玄宫园', 'Genkyū-en', '玄宮園']])
      case 'cemetery':
        return one([['墓地', 'Cemetery', '墓地'], ['无缘冢', 'Muen-zuka', '無縁塚']])
      case 'barracks':
        return one([['番所', 'Bansho', '番所'], ['足轻长屋', 'Ashigaru Barracks', '足軽長屋'], ['马场', 'Riding Ground', '馬場']])
      case 'guild':
        return one([['株仲间', 'Kabu-nakama', '株仲間'], ['问屋会所', "Ton'ya Kaisho", '問屋会所'], ['会所', 'Kaisho', '会所']])
      case 'exchange':
        return one([['两替商', 'Ryōgae-shō', '両替商'], ['米会所', 'Rice Exchange', '米会所'], ['金座', 'Kinza', '金座'], ['银座', 'Ginza', '銀座']])
      case 'warehouse':
        return one([['米藏', 'Kome-gura', '米蔵'], ['土藏', 'Dozō', '土蔵'], ['藏屋敷', 'Kura-yashiki', '蔵屋敷']])
      case 'observatory':
        return one([['天文台', 'Tenmondai', '天文台'], ['天文方', 'Tenmonkata', '天文方'], ['星见橹', 'Hoshimi Yagura', '星見櫓']])
      case 'tavern': {
        // 屋号 + 旅笼 / 茶屋 / 居酒屋
        const [yz, ye, yj] = r.pick(WA_YAGO)
        const [kz, ke, kj] = r.pick([['客栈', 'Inn', '旅籠'], ['茶屋', 'Teahouse', '茶屋'], ['居酒屋', 'Izakaya', '居酒屋']] as T3[])
        return { zh: yz + kz, en: `${ye} ${ke}`, ja: yj + kj }
      }
      case 'portal':
        return one([['神隐之门', 'Kamikakushi Gate', '神隠しの門'], ['狐之鸟居', 'Fox Torii', '狐の鳥居'], ['千本鸟居', 'Senbon Torii', '千本鳥居']])
      case 'stage':
        return one([['能舞台', 'Noh Stage', '能舞台'], ['芝居小屋', 'Playhouse', '芝居小屋'], ['歌舞伎座', 'Kabuki-za', '歌舞伎座'], ['寄席', 'Yose Hall', '寄席']])
      case 'pulpit':
        // 高札场：贴告示的地方
        return one([['高札场', 'Kōsatsu-ba', '高札場'], ['辻讲释', 'Tsuji-kōshaku', '辻講釈'], ['说法所', 'Sermon Hall', '説法所']])
      case 'arena':
        return one([['相扑场', 'Sumō Ring', '相撲場'], ['马场', 'Riding Ground', '馬場'], ['道场', 'Dōjō', '道場']])
      case 'winery':
        return P(['#酒藏', '# Sake Brewery', '#酒蔵'])
      case 'amphitheater':
        return one([['劝进相扑场', 'Kanjin Sumō Ground', '勧進相撲場'], ['大芝居', 'Grand Theatre', '大芝居']])
      case 'mill':
        return P(['#水车小屋', '# Watermill', '#水車小屋'])
      case 'windmill':
        return P(['#风车', '# Windmill', '#風車'])
      case 'hospital':
        return one([['养生所', 'Yōjōsho', '養生所'], ['施药院', 'Seyaku-in', '施薬院'], ['疗病院', 'Ryōbyō-in', '療病院']])
      case 'school':
        // 寺子屋，或藩校（明伦馆、弘道馆……）
        return one([['寺子屋', 'Terakoya', '寺子屋'], ['明伦馆', 'Meirinkan', '明倫館'], ['弘道馆', 'Kōdōkan', '弘道館'], ['致道馆', 'Chidōkan', '致道館'], ['养贤堂', 'Yōkendō', '養賢堂']])
      case 'gallows':
        return one([['刑场', 'Execution Ground', '刑場'], ['仕置场', 'Shiokiba', '仕置場']])
      case 'kiln':
        return one([['瓦窑', 'Tile Kilns', '瓦窯'], ['登窑', 'Climbing Kiln', '登り窯']])
      case 'quarry':
        return P(['#石切场', '# Quarry', '#石切場'])
      case 'lighthouse':
        // 旧时的灯塔叫灯明台
        return P(['#灯明台', '# Beacon', '#灯明台'])
    }
  }

  private islamicLandmark(kind: LandmarkNameKind, magic: number): Tri {
    const r = this.rng
    const one = (pool: T3[]) => tri(r.pick(pool))
    const A = (tpl: T3) => fill(tpl, this.arab())
    switch (kind) {
      case 'castle':
        return r.next() < 0.5 ? this.islamicName('kasbah', r) : one([['城堡', "The Qal'a", '城砦'], ['总督府', 'Dar al-Imara', '総督府'], ['王宫', 'Dar al-Makhzen', '王宮']])
      case 'temple':
        return this.islamicName(r.next() < 0.5 ? 'greatMosque' : 'mosque', r)
      case 'chapel': {
        // 小清真寺、苏非道堂、圣徒墓
        const k = r.next()
        if (k < 0.4) return this.islamicName('mosque', r)
        if (k < 0.7) return fill(['#道堂', 'Zawiya of #', '#のザーウィヤ'], this.arabPerson())
        return fill(['#圣墓', 'Qubba of #', '#廟'], this.arabPerson())
      }
      case 'market':
      case 'halle':
        return r.next() < 0.75 ? this.islamicName('souq', r) : tri(['盖萨里亚', 'The Qaysariyya', 'カイサリーヤ'])
      case 'harbor':
        // 河港：河埠、税卡（Maks 是过境税）、船坞
        return this.coast
          ? one([['海关', 'Diwan al-Bahr', '海関'], ['港口', 'al-Mina', '港'], ['造船坊', "Dar al-Sina'a", '造船所']])
          : one([['河埠', 'Marsa al-Nahr', '河港'], ['税卡', 'Diwan al-Maks', '関税所'], ['船坞', 'Dar al-Sufun', '船渠']])
      case 'magic':
        if (magic >= 2) return one([['智慧宫', 'Bayt al-Hikma', '知恵の館'], ['群星塔', 'Burj al-Nujum', '星々の塔'], ['镇尼宫', 'Qasr al-Jinn', 'ジンの宮殿']])
        return one([['炼金坊', 'Dar al-Kimiya', '錬金工房'], ['术士塔', 'Burj al-Sahir', '魔術師の塔'], ['星盘坊', 'Dar al-Asturlab', 'アストロラーベ工房']])
      case 'shrine':
        return r.next() < 0.6 ? fill(['#圣墓', 'Qubba of #', '#廟'], this.arabPerson()) : tri(['福泉', 'Ain al-Baraka', '祝福の泉'])
      case 'ferry':
        return A(['#渡口', '# Ferry', '#の渡し'])
      case 'park':
        return one([['王家花园', 'The Agdal', '王家庭園'], ['橄榄园', 'Jnan al-Zaytun', 'オリーブ園'], ['枣椰林', 'The Palm Grove', 'ナツメヤシ林'], ['喷泉园', 'Riyad al-Nafura', '噴水の庭']])
      case 'cemetery':
        return r.next() < 0.5 ? tri(['墓园', 'The Maqbara', '墓地']) : fill(['#墓园', 'Maqbarat #', '#墓地'], this.arabPerson())
      case 'barracks':
        return one([['兵营', 'Barracks', '兵営'], ['军械库', 'Dar al-Silah', '武器庫'], ['校场', 'The Mechouar', '練兵場']])
      case 'guild':
        return one([['商人会馆', 'Dar al-Tujjar', '商人会館'], ['铜匠行会', "Coppersmiths' Guild", '銅細工組合'], ['织工行会', "Weavers' Guild", '織工組合']])
      case 'exchange':
        return one([['兑换所', 'Dar al-Sarf', '両替所'], ['铸币厂', 'Dar al-Sikka', '造幣所'], ['盖萨里亚', 'The Qaysariyya', 'カイサリーヤ']])
      case 'warehouse':
        // Agadir 是筑垒的粮仓，Makhzan 是库房
        return one([['货栈', 'The Funduq', 'フンドゥク'], ['粮仓', 'The Agadir', '穀物倉'], ['库房', 'The Makhzan', '倉庫']])
      case 'observatory':
        return one([['观象台', 'al-Marsad', '天文台'], ['授时房', 'Dar al-Muwaqqit', '時計係の館']])
      case 'tavern':
        return this.islamicName('caravanserai', r)
      case 'portal':
        return one([['星门', 'Bab al-Nujum', '星の門'], ['镇尼之门', 'Bab al-Jinn', 'ジンの門'], ['传送门', 'The Portal', '転移門']])
      case 'stage':
        // 广场上说书、耍艺人的圈子（halqa），皮影戏
        return one([['说书圈', 'The Halqa', '語り部の輪'], ['皮影戏台', 'Khayal al-Zill', '影絵芝居小屋'], ['乐坊', "Dar al-Sama'", '音楽の館']])
      case 'pulpit':
        return one([['讲经台', 'The Minbar', 'ミンバル'], ['诵经台', 'The Dikka', 'ディッカ'], ['宣讲台', "Kursi al-Wa'z", '説教壇']])
      case 'arena':
        return one([['马术场', 'Maydan al-Furusiyya', '馬術場'], ['赛马场', 'The Maydan', '競馬場'], ['摔跤场', 'Wrestling Ground', 'レスリング場']])
      case 'winery':
        // 不酿酒：葡萄园或榨油坊
        return r.next() < 0.5 ? A(['#葡萄园', 'Karm #', '#葡萄園']) : A(['#榨油坊', "Ma'sarat #", '#搾油所'])
      case 'amphitheater':
        return one([['罗马剧场', 'The Roman Theatre', 'ローマ劇場'], ['古竞技场', 'The Old Arena', '古闘技場']])
      case 'mill':
        return r.next() < 0.5 ? A(['#磨坊', 'Tahunat #', '#水車小屋']) : A(['#水车', '# Noria', '#水車'])
      case 'windmill':
        return A(['#风车', '# Windmill', '#風車'])
      case 'hospital':
        return r.next() < 0.6 ? fill(['#医院', 'Bimaristan #', '#病院'], this.arabDedic()) : tri(['大医院', 'The Great Bimaristan', '大病院'])
      case 'school':
        return this.islamicName('madrasa', r)
      case 'gallows':
        return tri(['刑场', 'Execution Ground', '刑場'])
      case 'kiln':
        return one([['陶窑', "The Potters' Kilns", '陶窯'], ['砖窑', 'Brick Kilns', '煉瓦窯']])
      case 'quarry':
        return A(['#采石场', '# Quarry', '#石切場'])
      case 'lighthouse':
        return A(['#灯塔', 'Manarat #', '#灯台'])
    }
  }

  private westLandmark(kind: LandmarkNameKind, magic: number): Tri {
    const r = this.rng
    const one = (pool: T3[]) => tri(r.pick(pool))
    const saint = (zhSuf: string, en: string, jaSuf: string): Tri => {
      const [sz, se, sj] = r.pick(WEST_SAINTS)
      return { zh: sz + zhSuf, en: en.replace('#', se), ja: sj + jaSuf }
    }
    switch (kind) {
      case 'castle':
        return one([['城堡', 'The Castle', '城'], ['领主堡', "Lord's Keep", '領主の砦'], ['要塞', 'The Citadel', '要塞'], ['王宫', 'Royal Palace', '王宮']])
      case 'temple': {
        const k = r.int(0, 2)
        if (k === 0) return saint('大教堂', "#'s Cathedral", '大聖堂')
        if (k === 1) return saint('教堂', "#'s Church", '教会')
        return tri(['修道院', 'The Abbey', '修道院'])
      }
      case 'chapel':
        return r.next() < 0.5 ? saint('礼拜堂', "#'s Chapel", '礼拝堂') : saint('小教堂', "#'s Chapel", '小聖堂')
      case 'market':
        return one([['市政厅', 'Town Hall', '市庁舎'], ['行会大厅', 'Guildhall', 'ギルド会館'], ['谷物交易所', 'Corn Exchange', '穀物取引所']])
      case 'harbor':
        // 灯塔另有（城外岬角上，见 rural.ts）；河港没有海关、船坞
        return this.coast
          ? one([['港务所', 'Harbour Office', '港務所'], ['海关', 'Custom House', '税関'], ['船坞', 'Shipyard', '造船所'], ['鱼市', 'Fish Market', '魚市場']])
          : one([['码头', 'The Quay', '河岸'], ['船夫会馆', "Watermen's Hall", '船頭組合'], ['税卡', 'Toll House', '関所'], ['货运码头', 'The Wharf', '荷揚げ場']])
      case 'magic':
        return magic >= 2
          ? one([['大法师塔', "Archmage's Tower", '大魔導師の塔'], ['星辉学院', 'Starlight Academy', '星輝学院'], ['奥术议会', 'Arcane Council', '秘術評議会']])
          : one([['法师塔', "Wizard's Tower", '魔術師の塔'], ['炼金工坊', "Alchemist's Workshop", '錬金工房'], ['观星塔', 'Star Tower', '星見の塔']])
      case 'shrine':
        return one([['路边神龛', 'Wayside Shrine', '路傍の祠'], ['圣泉', 'Holy Well', '聖なる泉']])
      case 'ferry':
        return this.proper(['渡口', '# Ferry', 'の渡し'])
      case 'park':
        return one([['王家花园', 'Royal Gardens', '王立庭園'], ['公地', 'The Common', '共有地'], ['绿苑', 'The Green', '緑苑']])
      case 'cemetery':
        return tri(['墓园', 'Cemetery', '墓地'])
      case 'barracks':
        return one([['兵营', 'Barracks', '兵舎'], ['军械库', 'Armoury', '武器庫'], ['校场', 'Drill Yard', '練兵場']])
      case 'guild':
        return one([['工匠行会', "Artisans' Guild", '職人組合'], ['商人行会', "Merchants' Guild", '商人組合'], ['织工行会', "Weavers' Guild", '織工組合'], ['铁匠行会', "Smiths' Guild", '鍛冶組合']])
      case 'exchange':
        return one([['交易所', 'The Bourse', '取引所'], ['钱庄', 'Counting House', '両替商'], ['商会大厅', "Merchants' Hall", '商館']])
      case 'warehouse':
        return one([['货栈', 'Warehouse', '倉庫'], ['粮仓', 'Granary', '穀物倉'], ['码头仓库', 'Dock Warehouse', '波止場倉庫']])
      case 'observatory':
        return one([['观星台', 'Observatory', '天文台'], ['星象塔', 'Star Tower', '星見の塔'], ['天文台', 'Astronomical Observatory', '天文観測所']])
      case 'tavern': {
        if (r.next() < 0.12) return one([['旅人之家', "Travellers' Rest", '旅人の家'], ['跃马客栈', 'The Prancing Pony', '跳ね馬亭']])
        const [az, ae, aj] = r.pick(TAVERN_ADJ)
        const [nz, ne, nj] = r.pick(TAVERN_NOUN)
        const [kz, ke, kj] = r.pick(TAVERN_KIND)
        return { zh: az + nz + kz, en: `The ${ae} ${ne}${ae === 'Three' ? 's' : ''}${ke}`, ja: aj + nj + kj }
      }
      case 'portal':
        return one([['传送门', 'The Portal', '転移門'], ['星门', 'Stargate', '星門'], ['虚空之门', 'Void Gate', '虚空の門']])
      case 'stage':
        return one([['露天剧场', 'Open-air Theatre', '野外劇場'], ['天鹅剧场', 'The Swan Theatre', '白鳥座'], ['环球剧场', 'The Globe', '地球座'], ['市民戏台', "Citizens' Stage", '市民舞台']])
      case 'pulpit':
        return one([['宣讲台', 'Preaching Cross', '説教壇'], ['十字讲坛', 'Market Cross', '十字講壇'], ['市民讲坛', "Citizens' Rostrum", '市民演壇']])
      case 'arena':
        return one([['比武场', 'Tiltyard', '馬上槍試合場'], ['骑士竞技场', "Knights' Lists", '騎士競技場'], ['王家比武场', 'Royal Tiltyard', '王立試合場']])
      case 'winery':
        return r.next() < 0.5 ? saint('酒庄', "#'s Vineyard", '葡萄園') : one([['橡木酒庄', 'Oakbarrel Winery', '樫樽ワイナリー'], ['金藤酒庄', 'Goldvine Winery', '金蔓ワイナリー']])
      case 'amphitheater':
        return one([['圆形竞技场', 'The Amphitheatre', '円形闘技場'], ['大斗兽场', 'The Colosseum', '大闘技場'], ['角斗场', "Gladiators' Arena", '剣闘場']])
      case 'mill':
        return this.proper(['磨坊', '# Mill', '水車小屋'])
      case 'windmill':
        return this.proper(['风车', '# Windmill', '風車'])
      case 'hospital':
        return r.next() < 0.5 ? saint('医院', "#'s Hospital", '施療院') : one([['济贫院', 'Almshouse', '救貧院'], ['麻风病院', 'Lazar House', '癩病院']])
      case 'school':
        return one([['大学', 'The University', '大学'], ['主教座堂学校', 'Cathedral School', '司教座聖堂学校'], ['文法学校', 'Grammar School', 'グラマースクール']])
      case 'gallows':
        return tri(['绞刑架', 'Gallows', '絞首台'])
      case 'kiln':
        return one([['砖窑', 'Brickworks', '煉瓦窯'], ['陶窑', 'Pottery Kilns', '陶窯']])
      case 'quarry':
        return this.proper(['采石场', '# Quarry', '石切場'])
      case 'lighthouse':
        return this.proper(['灯塔', '# Light', '灯台'])
      case 'halle':
        return r.next() < 0.5 ? this.proper(['市场棚', '# Halle', '市場']) : one([['大市棚', 'The Market Hall', '市場ホール'], ['谷物市棚', 'Corn Market', '穀物市場']])
    }
  }
}
