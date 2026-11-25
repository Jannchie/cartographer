import { Language } from '../../../gen/names'
import { katakana } from '../../../gen/names_ja'
import { transliterateZh, type Tri } from '../../../gen/naming'
import type { RNG } from '../../../gen/rng'
import { choose, fill, tri, type CultureNaming, type LandmarkNameKind, type SacredNames, type SettleNamer, type T3 } from '../../../settlement/names'
import type { WardType } from '../../../settlement/types'

/**
 * 西式的名字：专名是虚构语言的词（取名器的 proper），英文原样、中文音译、日文片假名；
 * 通名（教堂、城门、客栈……）三语各自意译。
 */

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

/** 以圣徒命名：模板里的 # 换成圣徒名 */
const saint = (n: SettleNamer, t: T3): Tri => fill(t, n.rng.pick(WEST_SAINTS))

function landmark(n: SettleNamer, kind: LandmarkNameKind, magic: number): Tri {
  const r = n.rng
  switch (kind) {
    case 'castle':
      return n.pick([['城堡', 'The Castle', '城'], ['领主堡', "Lord's Keep", '領主の砦'], ['要塞', 'The Citadel', '要塞'], ['王宫', 'Royal Palace', '王宮']])
    case 'temple': {
      const k = r.int(0, 2)
      if (k === 0) return saint(n, ['#大教堂', "#'s Cathedral", '#大聖堂'])
      if (k === 1) return saint(n, ['#教堂', "#'s Church", '#教会'])
      return tri(['修道院', 'The Abbey', '修道院'])
    }
    case 'chapel':
      return r.next() < 0.5 ? saint(n, ['#礼拜堂', "#'s Chapel", '#礼拝堂']) : saint(n, ['#小教堂', "#'s Chapel", '#小聖堂'])
    case 'market':
      return n.pick([['市政厅', 'Town Hall', '市庁舎'], ['行会大厅', 'Guildhall', 'ギルド会館'], ['谷物交易所', 'Corn Exchange', '穀物取引所']])
    case 'harbor':
      // 灯塔另有（城外岬角上，见 rural.ts）；河港没有海关、船坞
      return n.coast
        ? n.pick([['港务所', 'Harbour Office', '港務所'], ['海关', 'Custom House', '税関'], ['船坞', 'Shipyard', '造船所'], ['鱼市', 'Fish Market', '魚市場']])
        : n.pick([['码头', 'The Quay', '河岸'], ['船夫会馆', "Watermen's Hall", '船頭組合'], ['税卡', 'Toll House', '関所'], ['货运码头', 'The Wharf', '荷揚げ場']])
    case 'magic':
      return magic >= 2
        ? n.pick([['大法师塔', "Archmage's Tower", '大魔導師の塔'], ['星辉学院', 'Starlight Academy', '星輝学院'], ['奥术议会', 'Arcane Council', '秘術評議会']])
        : n.pick([['法师塔', "Wizard's Tower", '魔術師の塔'], ['炼金工坊', "Alchemist's Workshop", '錬金工房'], ['观星塔', 'Star Tower', '星見の塔']])
    case 'shrine':
      return n.pick([['路边神龛', 'Wayside Shrine', '路傍の祠'], ['圣泉', 'Holy Well', '聖なる泉']])
    case 'ferry':
      return n.proper(['渡口', '# Ferry', 'の渡し'])
    case 'park':
      return n.pick([['王家花园', 'Royal Gardens', '王立庭園'], ['公地', 'The Common', '共有地'], ['绿苑', 'The Green', '緑苑']])
    case 'cemetery':
      return tri(['墓园', 'Cemetery', '墓地'])
    case 'barracks':
      return n.pick([['兵营', 'Barracks', '兵舎'], ['军械库', 'Armoury', '武器庫'], ['校场', 'Drill Yard', '練兵場']])
    case 'guild':
      return n.pick([['工匠行会', "Artisans' Guild", '職人組合'], ['商人行会', "Merchants' Guild", '商人組合'], ['织工行会', "Weavers' Guild", '織工組合'], ['铁匠行会', "Smiths' Guild", '鍛冶組合']])
    case 'exchange':
      return n.pick([['交易所', 'The Bourse', '取引所'], ['钱庄', 'Counting House', '両替商'], ['商会大厅', "Merchants' Hall", '商館']])
    case 'warehouse':
      return n.pick([['货栈', 'Warehouse', '倉庫'], ['粮仓', 'Granary', '穀物倉'], ['码头仓库', 'Dock Warehouse', '波止場倉庫']])
    case 'observatory':
      return n.pick([['观星台', 'Observatory', '天文台'], ['星象塔', 'Star Tower', '星見の塔'], ['天文台', 'Astronomical Observatory', '天文観測所']])
    case 'tavern': {
      if (r.next() < 0.12) return n.pick([['旅人之家', "Travellers' Rest", '旅人の家'], ['跃马客栈', 'The Prancing Pony', '跳ね馬亭']])
      const [az, ae, aj] = r.pick(TAVERN_ADJ)
      const [nz, ne, nj] = r.pick(TAVERN_NOUN)
      const [kz, ke, kj] = r.pick(TAVERN_KIND)
      return { zh: az + nz + kz, en: `The ${ae} ${ne}${ae === 'Three' ? 's' : ''}${ke}`, ja: aj + nj + kj }
    }
    case 'portal':
      return n.pick([['传送门', 'The Portal', '転移門'], ['星门', 'Stargate', '星門'], ['虚空之门', 'Void Gate', '虚空の門']])
    case 'stage':
      return n.pick([['露天剧场', 'Open-air Theatre', '野外劇場'], ['天鹅剧场', 'The Swan Theatre', '白鳥座'], ['环球剧场', 'The Globe', '地球座'], ['市民戏台', "Citizens' Stage", '市民舞台']])
    case 'pulpit':
      return n.pick([['宣讲台', 'Preaching Cross', '説教壇'], ['十字讲坛', 'Market Cross', '十字講壇'], ['市民讲坛', "Citizens' Rostrum", '市民演壇']])
    case 'arena':
      return n.pick([['比武场', 'Tiltyard', '馬上槍試合場'], ['骑士竞技场', "Knights' Lists", '騎士競技場'], ['王家比武场', 'Royal Tiltyard', '王立試合場']])
    case 'winery':
      return r.next() < 0.5 ? saint(n, ['#酒庄', "#'s Vineyard", '#葡萄園']) : n.pick([['橡木酒庄', 'Oakbarrel Winery', '樫樽ワイナリー'], ['金藤酒庄', 'Goldvine Winery', '金蔓ワイナリー']])
    case 'amphitheater':
      return n.pick([['圆形竞技场', 'The Amphitheatre', '円形闘技場'], ['大斗兽场', 'The Colosseum', '大闘技場'], ['角斗场', "Gladiators' Arena", '剣闘場']])
    case 'mill':
      return n.proper(['磨坊', '# Mill', '水車小屋'])
    case 'windmill':
      return n.proper(['风车', '# Windmill', '風車'])
    case 'hospital':
      return r.next() < 0.5 ? saint(n, ['#医院', "#'s Hospital", '#施療院']) : n.pick([['济贫院', 'Almshouse', '救貧院'], ['麻风病院', 'Lazar House', '癩病院']])
    case 'school':
      return n.pick([['大学', 'The University', '大学'], ['主教座堂学校', 'Cathedral School', '司教座聖堂学校'], ['文法学校', 'Grammar School', 'グラマースクール']])
    case 'gallows':
      return tri(['绞刑架', 'Gallows', '絞首台'])
    case 'kiln':
      return n.pick([['砖窑', 'Brickworks', '煉瓦窯'], ['陶窑', 'Pottery Kilns', '陶窯']])
    case 'quarry':
      return n.proper(['采石场', '# Quarry', '石切場'])
    case 'lighthouse':
      return n.proper(['灯塔', '# Light', '灯台'])
    case 'halle':
      return r.next() < 0.5 ? n.proper(['市场棚', '# Halle', '市場']) : n.pick([['大市棚', 'The Market Hall', '市場ホール'], ['谷物市棚', 'Corn Market', '穀物市場']])
  }
}

/** 都城的宫殿 */
function palace(_n: SettleNamer, r: RNG): Tri {
  if (r.next() < 0.5) return tri(r.pick([['王宫', 'Royal Palace', '王宮'], ['冬宫', 'Winter Palace', '冬宮'], ['夏宫', 'Summer Palace', '夏の宮殿']] as T3[]))
  const w = new Language(r.fork()).word()
  return { zh: transliterateZh(w) + '宫', en: `Palace of ${w}`, ja: katakana(w) + '宮殿' }
}

/** 规模档与名所的专名（西式的叫法） */
export const WEST_SACRED: SacredNames = {
  abbey: (n) => saint(n, ['#修道院', "#'s Abbey", '#修道院']),
  pilgrim: (n) => (n.rng.next() < 0.5 ? n.proper(['圣母朝圣堂', 'Our Lady of #', 'の聖母巡礼教会']) : saint(n, ['#朝圣教堂', "#'s Pilgrimage Church", '#巡礼教会'])),
  cathedral: (n) => saint(n, ['#主教座堂', "#'s Minster", '#大聖堂']),
  parish: (n) => saint(n, ['#堂区教堂', "#'s Parish Church", '#教区教会']),
  crag: (n) => n.proper(['岩堡', '# Crag', '岩城']),
  manor: (n) => n.proper(['庄园', '# Hall', '館']),
  huntPark: (n) => n.proper(['猎苑', '# Chase', '猟園']),
  rikyu: (n) => n.proper(['别宫', 'Palais de #', '離宮']),
  square: (n) => n.proper(['广场花园', '# Gardens', '公園']),
  greatPark: (n) => n.proper(['公园', '# Park', '公園']),
}

/** 起名规则（名所的专名在文明定义里接上，见 ../sacredNames.ts） */
export const naming: Omit<CultureNaming, 'sacred'> = {
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
  // 城门：按朝向（东、南、西、北）挑名字
  gates: [
    [['东门', 'East Gate', '東門'], ['日出门', 'Sunrise Gate', '日の出門'], ['国王门', "King's Gate", '王の門']],
    [['南门', 'South Gate', '南門'], ['河门', 'River Gate', '川門'], ['王后门', "Queen's Gate", '王妃の門']],
    [['西门', 'West Gate', '西門'], ['日落门', 'Sunset Gate', '日没門'], ['狮门', 'Lion Gate', '獅子門']],
    [['北门', 'North Gate', '北門'], ['霜门', 'Frost Gate', '霜門'], ['塔门', 'Tower Gate', '塔門']],
  ],
  qualify: [['新', 'New #', '新'], ['老', 'Old #', '旧'], ['上', 'Upper #', '上'], ['下', 'Lower #', '下'], ['东', 'East #', '東'], ['西', 'West #', '西'], ['南', 'South #', '南'], ['北', 'North #', '北']],
  landmark,
  palace,
}
