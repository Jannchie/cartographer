import type { Tri } from '../../../gen/naming'
import type { RNG } from '../../../gen/rng'
import { choose, fill, tri, type CultureNaming, type LandmarkNameKind, type SacredNames, type SettleNamer, type T3 } from '../../../settlement/names'
import type { WardType } from '../../../settlement/types'

/**
 * 和风的名字：专名是日本汉字，英文用罗马字、中文用简体字；通名英文多照读（-machi、-dōri、-ji），
 * 也有意译的（Castle、Shrine）。
 */

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

/** 和风专名：两段日本汉字（松田、白泽……）；exclude 里的字不作词尾，免得"松山山" */
export function waProper(r: RNG, exclude = ''): T3 {
  const [hz, he, hj] = r.pick(WA_HEAD)
  let t = r.pick(WA_TAIL)
  while (exclude.includes(t[2])) t = r.pick(WA_TAIL)
  return [hz + t[0], he + t[1], hj + t[2]]
}

export type WaKind = 'castle' | 'temple' | 'samurai' | 'machi' | 'teramachi' | 'masugata' | 'shrine' | 'tenshu'

/** 和风的名字（城下町）：城、寺、武家地、町人地、寺町、枡形 */
export function waName(n: SettleNamer, kind: WaKind): Tri | undefined {
  switch (kind) {
    case 'castle':
      return n.uniq(() => fill(['#城', '# Castle', '#城'], waProper(n.rng)))
    case 'temple':
      return n.uniq(() => n.pick(WA_TEMPLE))
    case 'samurai':
      return n.tryUniq(() => fill(['#丁', '#-chō', '#丁'], waProper(n.rng)))
    case 'machi':
      return n.tryUniq(() => n.pick(WA_MACHI))
    case 'teramachi':
      return n.tryUniq(() => tri(['寺町', 'Teramachi', '寺町']))
    case 'masugata':
      return tri(['枡形', 'Masugata Gate', '枡形'])
    case 'shrine':
      return n.tryUniq(() => n.pick(WA_SHRINE.slice(0, 3)))
    case 'tenshu':
      return tri(['天守', 'Tenshu', '天守'])
  }
}

/** 模板里的 # 换成和风专名 */
const proper = (n: SettleNamer, t: T3) => fill(t, waProper(n.rng))

function landmark(n: SettleNamer, kind: LandmarkNameKind, magic: number): Tri {
  const r = n.rng
  switch (kind) {
    case 'castle':
      return r.next() < 0.5 ? proper(n, ['#城', '# Castle', '#城']) : n.pick([['阵屋', "Jin'ya", '陣屋'], ['奉行所', "Magistrate's Office", '奉行所'], ['代官所', "Intendant's Office", '代官所']])
    case 'temple':
      return r.next() < 0.6 ? n.pick(WA_TEMPLE) : proper(n, ['#寺', '#-ji', '#寺'])
    case 'chapel':
      return n.pick([['地藏堂', 'Jizō-dō', '地蔵堂'], ['观音堂', 'Kannon-dō', '観音堂'], ['药师堂', 'Yakushi-dō', '薬師堂'], ['阎魔堂', 'Enma-dō', '閻魔堂']])
    case 'market':
    case 'halle':
      return n.pick([['鱼市场', 'Uo-ichiba', '魚市場'], ['青物市场', 'Aomono-ichiba', '青物市場'], ['米会所', 'Rice Exchange', '米会所'], ['市场', 'Ichiba', '市場']])
    case 'harbor':
      // 海港是湊、船番所；河港是河岸（船着场）、川番所
      if (!n.coast) return r.next() < 0.5 ? proper(n, ['#河岸', '#-gashi', '#河岸']) : n.pick([['川番所', 'Kawa-bansho', '川番所'], ['船着场', 'Funatsuki-ba', '船着場']])
      return r.next() < 0.5 ? proper(n, ['#凑', '#-minato', '#湊']) : n.pick([['船番所', 'Funa-bansho', '船番所'], ['御船手', 'Ofunate', '御船手']])
    case 'magic':
      if (magic >= 2) return n.pick([['阴阳寮', 'Onmyōryō', '陰陽寮'], ['天狗堂', 'Tengu-dō', '天狗堂'], ['神隐之森', 'Kamikakushi Wood', '神隠しの森']])
      return n.pick([['阴阳师宅', "Onmyōji's House", '陰陽師の屋敷'], ['狐冢', 'Kitsune-zuka', '狐塚'], ['占卜所', "Diviner's Hut", '占い処']])
    case 'shrine':
      return r.next() < 0.6 ? n.pick(WA_SHRINE) : proper(n, ['#神社', '# Shrine', '#神社'])
    case 'ferry':
      return proper(n, ['#渡', '# Ferry', '#の渡し'])
    case 'park':
      // 大名庭园
      return n.pick([['后乐园', 'Kōraku-en', '後楽園'], ['偕乐园', 'Kairaku-en', '偕楽園'], ['栗林园', 'Ritsurin-en', '栗林園'], ['兼六园', 'Kenroku-en', '兼六園'], ['乐寿园', 'Rakuju-en', '楽寿園'], ['玄宫园', 'Genkyū-en', '玄宮園']])
    case 'cemetery':
      return n.pick([['墓地', 'Cemetery', '墓地'], ['无缘冢', 'Muen-zuka', '無縁塚']])
    case 'barracks':
      return n.pick([['番所', 'Bansho', '番所'], ['足轻长屋', 'Ashigaru Barracks', '足軽長屋'], ['马场', 'Riding Ground', '馬場']])
    case 'guild':
      return n.pick([['株仲间', 'Kabu-nakama', '株仲間'], ['问屋会所', "Ton'ya Kaisho", '問屋会所'], ['会所', 'Kaisho', '会所']])
    case 'exchange':
      return n.pick([['两替商', 'Ryōgae-shō', '両替商'], ['米会所', 'Rice Exchange', '米会所'], ['金座', 'Kinza', '金座'], ['银座', 'Ginza', '銀座']])
    case 'warehouse':
      return n.pick([['米藏', 'Kome-gura', '米蔵'], ['土藏', 'Dozō', '土蔵'], ['藏屋敷', 'Kura-yashiki', '蔵屋敷']])
    case 'observatory':
      return n.pick([['天文台', 'Tenmondai', '天文台'], ['天文方', 'Tenmonkata', '天文方'], ['星见橹', 'Hoshimi Yagura', '星見櫓']])
    case 'tavern': {
      // 屋号 + 旅笼 / 茶屋 / 居酒屋
      const [yz, ye, yj] = r.pick(WA_YAGO)
      const [kz, ke, kj] = r.pick([['客栈', 'Inn', '旅籠'], ['茶屋', 'Teahouse', '茶屋'], ['居酒屋', 'Izakaya', '居酒屋']] as T3[])
      return { zh: yz + kz, en: `${ye} ${ke}`, ja: yj + kj }
    }
    case 'portal':
      return n.pick([['神隐之门', 'Kamikakushi Gate', '神隠しの門'], ['狐之鸟居', 'Fox Torii', '狐の鳥居'], ['千本鸟居', 'Senbon Torii', '千本鳥居']])
    case 'stage':
      return n.pick([['能舞台', 'Noh Stage', '能舞台'], ['芝居小屋', 'Playhouse', '芝居小屋'], ['歌舞伎座', 'Kabuki-za', '歌舞伎座'], ['寄席', 'Yose Hall', '寄席']])
    case 'pulpit':
      // 高札场：贴告示的地方
      return n.pick([['高札场', 'Kōsatsu-ba', '高札場'], ['辻讲释', 'Tsuji-kōshaku', '辻講釈'], ['说法所', 'Sermon Hall', '説法所']])
    case 'arena':
      return n.pick([['相扑场', 'Sumō Ring', '相撲場'], ['马场', 'Riding Ground', '馬場'], ['道场', 'Dōjō', '道場']])
    case 'winery':
      return proper(n, ['#酒藏', '# Sake Brewery', '#酒蔵'])
    case 'amphitheater':
      return n.pick([['劝进相扑场', 'Kanjin Sumō Ground', '勧進相撲場'], ['大芝居', 'Grand Theatre', '大芝居']])
    case 'mill':
      return proper(n, ['#水车小屋', '# Watermill', '#水車小屋'])
    case 'windmill':
      return proper(n, ['#风车', '# Windmill', '#風車'])
    case 'hospital':
      return n.pick([['养生所', 'Yōjōsho', '養生所'], ['施药院', 'Seyaku-in', '施薬院'], ['疗病院', 'Ryōbyō-in', '療病院']])
    case 'school':
      // 寺子屋，或藩校（明伦馆、弘道馆……）
      return n.pick([['寺子屋', 'Terakoya', '寺子屋'], ['明伦馆', 'Meirinkan', '明倫館'], ['弘道馆', 'Kōdōkan', '弘道館'], ['致道馆', 'Chidōkan', '致道館'], ['养贤堂', 'Yōkendō', '養賢堂']])
    case 'gallows':
      return n.pick([['刑场', 'Execution Ground', '刑場'], ['仕置场', 'Shiokiba', '仕置場']])
    case 'kiln':
      return n.pick([['瓦窑', 'Tile Kilns', '瓦窯'], ['登窑', 'Climbing Kiln', '登り窯']])
    case 'quarry':
      return proper(n, ['#石切场', '# Quarry', '#石切場'])
    case 'lighthouse':
      // 旧时的灯塔叫灯明台
      return proper(n, ['#灯明台', '# Beacon', '#灯明台'])
  }
}

/** 都城的宫殿 */
function palace(_n: SettleNamer, r: RNG): Tri {
  if (r.next() < 0.3) return fill(['#御所', '#-gosho', '#御所'], waProper(r))
  return tri(r.pick([['御所', 'Gosho', '御所'], ['内里', 'Dairi', '内裏'], ['大内里', 'Daidairi', '大内裏']] as T3[]))
}

/** 规模档与名所的专名（和风的叫法） */
export const WA_SACRED: SacredNames = {
  taisha: (n) => proper(n, ['#大社', '#-taisha', '#大社']),
  inari: (n) => proper(n, ['#稻荷大社', '#-inari Taisha', '#稲荷大社']),
  okumiya: (n) => proper(n, ['#山奥宫', 'Okumiya of Mt. #', '#山奥宮']),
  umi: (n) => proper(n, ['#神社', '#-jinja', '#神社']),
  shinkyo: (n) => tri(n.rng.pick([['神桥', 'Shinkyō', '神橋'], ['御手洗桥', 'Mitarashi Bridge', '御手洗橋'], ['朱桥', 'Vermilion Bridge', '朱橋']] as T3[])),
  villageShrine: (n) => tri(n.rng.pick(WA_SHRINE)),
  yamadera: (n) => proper(n, ['#山寺', '#-yamadera', '#山寺']),
  pagoda: (n) => proper(n, ['#五重塔', '#-gojūnotō', '#五重塔']),
  grandTemple: (n) => proper(n, ['#大寺', '#-daiji', '#大寺']),
  crag: (n) => proper(n, ['#山城', '#-yamajiro', '#山城']),
  manor: (n) => proper(n, ['#馆', '#-yakata', '#館']),
  rikyu: (n) => proper(n, ['#离宫', '#-rikyū', '#離宮']),
  greatPark: (n) => proper(n, ['#庭园', '#-teien', '#庭園']),
}

/** 起名规则（名所的专名在文明定义里接上，见 ../sacredNames.ts） */
export const naming: Omit<CultureNaming, 'sacred'> = {
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
    return () => fill(s, waProper(r, s[2] + (crossing === 'bridge' ? '' : '橋')))
  },
  // 〇〇川、〇〇滩、〇〇山；专名不以通名的字结尾
  feature: {
    river: ['#川', '#-gawa', '#川'],
    sea: [['#滩', '#-nada', '#灘'], ['#湾', '# Bay', '#湾'], ['#浦', '#-ura', '#浦']],
    hill: [['#山', 'Mount #', '#山'], ['#岳', '#-dake', '#岳'], ['#峠', '#-tōge', '#峠']],
  },
  featureName: (n, suf, f) => fill(choose(n.rng, suf), waProper(n.rng, { river: '川', sea: '浦', hill: '山峰' }[f])),
  district: WA_DISTRICT,
  // 武家地有一半叫"〇〇丁"
  districtFirst: (n, type) => (type === 'noble' && n.rng.next() < 0.4 ? () => fill(['#丁', '#-chō', '#丁'], waProper(n.rng)) : undefined),
  street: {
    main: [['#通', '#-dōri', '#通り'], ['#大路', '#-ōji', '#大路']],
    street: [['#通', '#-dōri', '#通り'], ['#筋', '#-suji', '#筋']],
    lane: [['#小路', '#-kōji', '#小路'], ['#横丁', '#-yokochō', '#横丁']],
  },
  streetName(n, suf) {
    const r = n.rng
    return fill(r.pick(suf), r.next() < 0.7 ? r.pick(WA_STREET) : waProper(n.rng))
  },
  // 城门：按朝向（东、南、西、北）挑名字
  gates: [
    [['东口', 'Higashi-guchi', '東口'], ['京口', 'Kyō-guchi', '京口'], ['大手门', 'Ōte-mon', '大手門'], ['东御门', 'Higashi-gomon', '東御門']],
    [['南口', 'Minami-guchi', '南口'], ['南御门', 'Minami-gomon', '南御門'], ['樱田门', 'Sakurada-mon', '桜田門'], ['伏见口', 'Fushimi-guchi', '伏見口']],
    [['西口', 'Nishi-guchi', '西口'], ['搦手门', 'Karamete-mon', '搦手門'], ['西御门', 'Nishi-gomon', '西御門'], ['虎之门', 'Tora-no-mon', '虎ノ門']],
    [['北口', 'Kita-guchi', '北口'], ['北御门', 'Kita-gomon', '北御門'], ['清水门', 'Shimizu-mon', '清水門'], ['乾门', 'Inui-mon', '乾門']],
  ],
  qualify: [['新', 'Shin #', '新'], ['古', 'Furu #', '古'], ['上', 'Kami #', '上'], ['下', 'Shimo #', '下'], ['东', 'Higashi #', '東'], ['西', 'Nishi #', '西'], ['南', 'Minami #', '南'], ['北', 'Kita #', '北']],
  landmark,
  palace,
}
