import type { Tri } from '../../../gen/naming'
import type { RNG } from '../../../gen/rng'
import { choose, tri, type CultureNaming, type LandmarkNameKind, type SacredNames, type SettleNamer, type T3 } from '../../../settlement/names'
import type { WardType } from '../../../settlement/types'

/**
 * 东方的名字：专名是汉字，英文用拼音、日文用对应的日本汉字；通名三语意译（坊 Ward、大街 Avenue……）。
 */

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
export const AUSP = [...'安仁崇义永宁平康兴道光德善和怀远长乐宣阳通济延寿丰昌明太清嘉会修文敦化常静昭归靖恭升晋']
export const NATURE = [...'青苍碧金玉云松柏竹梅桃杏柳桐枫溪泉涧月星霞岚峰岩潭']

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
export const eastName = (proper: string, [zh, en, ja]: T3): Tri => ({ zh: proper + zh, en: en.replace('#', pinyin(proper)), ja: kanji(proper) + ja })

/** 两个汉字的吉祥 / 山水专名 */
export const han = (r: RNG, a = AUSP, b = [...AUSP, ...NATURE]) => r.pick(a) + r.pick(b)

const EAST_DISTRICT: Partial<Record<WardType, T3[]>> = {
  market: [['东市', 'East Market', '東市'], ['西市', 'West Market', '西市'], ['南市', 'South Market', '南市'], ['北市', 'North Market', '北市']],
  harbor: [['码头', 'The Wharf', '埠頭'], ['船坞', 'Dockyard', '船渠'], ['渔港', 'Fishing Harbour', '漁港']],
  temple: [['寺前坊', 'Temple Ward', '寺前坊']],
  magic: [['仙门', 'Immortal Gate', '仙門'], ['灵境', 'Spirit Realm', '霊境']],
  suburb: [['关厢', 'Guanxiang', '関廂'], ['城郊', 'Outskirts', '城郊']],
}

/** 汉字专名接通名：吉祥字 + 山水字、单个山水字 */
const auspNature = (n: SettleNamer, t: T3) => eastName(n.rng.pick(AUSP) + n.rng.pick(NATURE), t)
const nature = (n: SettleNamer, t: T3) => eastName(n.rng.pick(NATURE), t)

function landmark(n: SettleNamer, kind: LandmarkNameKind, magic: number): Tri {
  const r = n.rng
  const N = () => r.pick(NATURE)
  const A = () => r.pick(AUSP)
  switch (kind) {
    case 'castle':
      return n.pick([['府衙', 'Prefectural Yamen', '府衙'], ['县衙', 'County Yamen', '県衙'], ['都督府', "Governor's Residence", '都督府'], ['王府', "Prince's Mansion", '王府'], ['宫城', 'Palace City', '宮城']])
    case 'temple': {
      const k = r.int(0, 3)
      if (k === 0) return eastName(A() + A(), ['寺', '# Temple', '寺'])
      if (k === 1) return eastName(N() + A(), ['观', '# Abbey', '観'])
      return n.pick([['文庙', 'Confucian Temple', '文廟'], ['城隍庙', 'City God Temple', '城隍廟']])
    }
    case 'chapel':
      return n.pick([['祠堂', 'Ancestral Hall', '祠堂'], ['宗祠', 'Clan Shrine', '宗祠'], ['土地庙', 'Earth God Shrine', '土地廟']])
    case 'market':
      return n.pick([['市楼', 'Market Tower', '市楼'], ['鼓楼', 'Drum Tower', '鼓楼'], ['钟楼', 'Bell Tower', '鐘楼'], ['市亭', 'Market Pavilion', '市亭']])
    case 'harbor':
      // 市舶司管海上贸易，只在海港；河港是河泊所（收渔税、船税）、漕运的仓
      return n.coast
        ? n.pick([['码头', 'The Wharf', '埠頭'], ['市舶司', 'Maritime Trade Office', '市舶司'], ['船厂', 'Shipyard', '造船所']])
        : n.pick([['码头', 'The Wharf', '埠頭'], ['河泊所', 'River Toll Office', '河泊所'], ['漕仓', 'Canal Granary', '漕倉']])
    case 'magic':
      if (magic >= 2) {
        const k = r.int(0, 2)
        if (k === 0) return nature(n, ['霄宗', '#xiao Sect', '霄宗'])
        if (k === 1) return nature(n, ['云仙门', '#yun Immortal Gate', '雲仙門'])
        return tri(['天衍阁', 'Tianyan Pavilion', '天衍閣'])
      }
      return r.next() < 0.4 ? nature(n, ['云观', '#yun Abbey', '雲観']) : n.pick([['藏经阁', 'Sutra Library', '蔵経閣'], ['炼丹房', 'Elixir Chamber', '錬丹房']])
    case 'shrine':
      return n.pick([['土地庙', 'Earth God Shrine', '土地廟'], ['山神庙', 'Mountain God Shrine', '山神廟'], ['龙王庙', 'Dragon King Temple', '竜王廟']])
    case 'ferry':
      return nature(n, ['渡', '# Ferry', '渡'])
    case 'park':
      return eastName((r.next() < 0.5 ? N() : A()) + A(), ['园', '# Garden', '園'])
    case 'cemetery':
      return tri(['义冢', "Paupers' Graves", '義塚'])
    case 'barracks':
      return n.pick([['校场', 'Drill Ground', '校場'], ['兵营', 'Barracks', '兵営'], ['武库', 'Arsenal', '武庫']])
    case 'guild':
      return r.next() < 0.4 ? nature(n, ['商会馆', "# Merchants' Hall", '商会館']) : n.pick([['会馆', 'Guild Hall', '会館'], ['行会公所', 'Guild Office', '行会公所']])
    case 'exchange':
      return n.pick([['钱庄', 'Money House', '銭荘'], ['票号', 'Draft Bank', '票号'], ['交子务', 'Paper Money Bureau', '交子務']])
    case 'warehouse':
      return n.pick([['仓廒', 'Granary', '倉廒'], ['常平仓', 'Ever-Normal Granary', '常平倉'], ['货栈', 'Warehouse', '貨桟']])
    case 'observatory':
      return n.pick([['观星台', 'Star Terrace', '観星台'], ['司天监', 'Bureau of Astronomy', '司天監'], ['灵台', 'Spirit Terrace', '霊台']])
    case 'tavern': {
      const k = r.int(0, 2)
      if (k === 0) return eastName(A() + A(), ['客栈', '# Inn', '客桟'])
      if (k === 1) return eastName(N() + A(), ['酒楼', '# Wine House', '酒楼'])
      return tri(['悦来客栈', 'Yuelai Inn', '悦来客桟'])
    }
    case 'portal':
      return r.next() < 0.4 ? nature(n, ['天门', '# Heavenly Gate', '天門']) : n.pick([['挪移阵', 'Shifting Array', '挪移陣'], ['传送阵', 'Teleport Array', '転送陣']])
    case 'stage':
      return r.next() < 0.3 ? eastName(A() + A(), ['乐台', '# Music Stage', '楽台']) : n.pick([['戏台', 'Opera Stage', '戯台'], ['万年台', 'Wannian Stage', '万年台'], ['古戏楼', 'Old Opera House', '古戯楼']])
    case 'pulpit':
      return n.pick([['宣讲台', 'Lecture Platform', '宣講台'], ['讲经台', 'Sutra Platform', '講経台'], ['说书场', 'Storytelling Hall', '講談場']])
    case 'arena':
      return n.pick([['擂台', 'Leitai', '擂台'], ['演武场', 'Martial Grounds', '演武場'], ['比武台', 'Duelling Stage', '比武台']])
    case 'winery':
      return r.next() < 0.5 ? nature(n, ['葡萄酒坊', '# Winery', '葡萄酒坊']) : auspNature(n, ['酒坊', '# Brewery', '酒坊'])
    case 'amphitheater':
      return r.next() < 0.3 ? eastName(A() + A(), ['武场', '# Martial Arena', '武場']) : n.pick([['百戏场', 'Hundred Acts Arena', '百戯場'], ['角抵场', 'Wrestling Ground', '角抵場']])
    case 'mill':
      return nature(n, ['水碾', '# Watermill', '水碾'])
    case 'windmill':
      return nature(n, ['风车', '# Windmill', '風車'])
    case 'hospital':
      return n.pick([['养济院', 'Almshouse', '養済院'], ['安济坊', 'Anji Infirmary', '安済坊'], ['惠民药局', "People's Dispensary", '恵民薬局']])
    case 'school':
      return r.next() < 0.5 ? nature(n, ['书院', '# Academy', '書院']) : n.pick([['府学', 'Prefectural School', '府学'], ['县学', 'County School', '県学'], ['贡院', 'Examination Hall', '貢院']])
    case 'gallows':
      return tri(['刑场', 'Execution Ground', '刑場'])
    case 'kiln':
      return n.pick([['砖瓦窑', 'Brick Kilns', '瓦窯'], ['官窑', 'Imperial Kiln', '官窯']])
    case 'quarry':
      return nature(n, ['石场', '# Quarry', '石切場'])
    case 'lighthouse':
      return nature(n, ['灯塔', '# Lighthouse', '灯台'])
    case 'halle':
      return n.pick([['市楼', 'Market Tower', '市楼'], ['大市棚', 'Market Hall', '大市場']])
  }
}

/** 都城的宫殿 */
function palace(_n: SettleNamer, r: RNG): Tri {
  if (r.next() < 0.5) return eastName(r.pick(AUSP) + r.pick(AUSP), ['宫', '# Palace', '宮'])
  return tri(r.pick([['皇宫', 'Imperial Palace', '皇宮'], ['紫禁城', 'Forbidden City', '紫禁城'], ['太极宫', 'Taiji Palace', '太極宮'], ['大明宫', 'Daming Palace', '大明宮']] as T3[]))
}

/** 规模档与名所的专名（东方的叫法） */
export const EAST_SACRED: SacredNames = {
  villageShrine: (n) => tri(n.rng.pick([['土地庙', 'Earth God Shrine', '土地廟'], ['山神庙', 'Mountain God Shrine', '山神廟'], ['娘娘庙', "Goddess' Shrine", '娘娘廟']] as T3[])),
  yamadera: (n) => nature(n, ['山寺', '# Mountain Temple', '山寺']),
  pagoda: (n) => auspNature(n, ['塔', '# Pagoda', '塔']),
  grandTemple: (n) => eastName(n.rng.pick(AUSP), ['大寺', 'Great # Temple', '大寺']),
  crag: (n) => nature(n, ['山寨', '# Fastness', '山塞']),
  manor: (n) => nature(n, ['土堡', '# Fort', '土堡']),
  huntPark: (n) => nature(n, ['苑', '# Hunting Park', '苑']),
  rikyu: (n) => auspNature(n, ['园', '# Garden Palace', '園']),
  greatPark: (n) => auspNature(n, ['苑', '# Park', '苑']),
  tudi: (n) => tri(n.rng.pick([['土地庙', 'Earth God Shrine', '土地廟'], ['福德祠', 'Fude Shrine', '福徳祠'], ['社稷坛', 'Altar of the Soil', '社稷壇']] as T3[])),
}

/** 起名规则（名所的专名在文明定义里接上，见 ../sacredNames.ts） */
export const naming: Omit<CultureNaming, 'sacred'> = {
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
  districtElse: (n) => eastName(han(n.rng, AUSP, AUSP), ['坊', '# Ward', '坊']),
  street: {
    main: [['大街', '# Avenue', '大街'], ['大道', '# Road', '大道']],
    street: [['街', '# Street', '街']],
    lane: [['巷', '# Lane', '巷'], ['胡同', '# Hutong', '胡同']],
  },
  streetName(n, suf) {
    const r = n.rng
    return eastName(r.pick([...AUSP, ...NATURE]) + (r.next() < 0.5 ? r.pick(AUSP) : ''), r.pick(suf))
  },
  // 城门：按朝向（东、南、西、北）挑名字
  gates: [
    [['东门', 'East Gate', '東門'], ['朝阳门', 'Chaoyang Gate', '朝陽門'], ['东华门', 'Donghua Gate', '東華門'], ['迎春门', 'Yingchun Gate', '迎春門']],
    [['南门', 'South Gate', '南門'], ['永定门', 'Yongding Gate', '永定門'], ['正阳门', 'Zhengyang Gate', '正陽門'], ['朱雀门', 'Zhuque Gate', '朱雀門']],
    [['西门', 'West Gate', '西門'], ['西华门', 'Xihua Gate', '西華門'], ['宣武门', 'Xuanwu Gate', '宣武門'], ['金光门', 'Jinguang Gate', '金光門']],
    [['北门', 'North Gate', '北門'], ['安定门', 'Anding Gate', '安定門'], ['玄武门', 'Xuanwu Gate', '玄武門'], ['德胜门', 'Desheng Gate', '徳勝門']],
  ],
  qualify: [['新', 'New #', '新'], ['小', 'Little #', '小'], ['老', 'Old #', '旧'], ['上', 'Upper #', '上'], ['下', 'Lower #', '下'], ['东', 'East #', '東'], ['西', 'West #', '西'], ['南', 'South #', '南'], ['北', 'North #', '北']],
  landmark,
  palace,
}
