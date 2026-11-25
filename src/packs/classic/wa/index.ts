import type { CultureDef } from '../../../settlement/culture'
import { sacredNamer } from '../sacredNames'
import { jobo } from '../eastern/lifang'
import { jokamachi } from './jokamachi'
import { naming, WA_SACRED } from './naming'
import { people } from './people'
import { sacred } from './sacred'
import { wa as style } from './style'
import { tiers } from './tiers'

/** 和风：日本，町家、武家屋敷、寺社与天守 */
export const wa: CultureDef = {
  id: 'wa',
  name: '和风',
  desc: '町家与武家屋敷、寺社、天守与城下町',
  traits: {
    eastAsian: true,
    paddy: true,
    brushTitle: true,
    hillSect: true,
    perHousehold: 4.5,
    // 城下町不筑外郭，靠城堡与寺町防守
    autoWalls: false,
    moat: true,
    innerWall: false,
    palaceFacing: 'south',
    compoundAxis: 'grid',
    // 墓地附在寺院里（寺町），不单独成片
    exclude: ['amphitheater', 'pulpit', 'winery', 'windmill', 'cemetery'],
    // 大社四周是镇守之森（密林）
    templeGrove: 0.014,
    waysideGap: 220,
  },
  // 平安京、平城京的条坊制照搬唐长安：里坊的变体（见 ../eastern/lifang.ts）
  plans: [jobo, jokamachi],
  style,
  naming: { ...naming, sacred: sacredNamer(WA_SACRED) },
  lexicon: {
    home: ['町家', '农家'],
    temple: '寺社',
    keep: '天守',
    mansion: '武家屋敷',
    shophouse: '商人的楼房（楼下铺面）',
    tenement: '大宅',
    grave: '墓',
    castleHall: '殿',
    townHall: '市署',
    marketTower: '市楼',
    pavilion: '塔、亭',
    crops: { crop: '麦、大豆', orchard: '柿、梅', garden: '萝卜、茄子、葱', pasture: '马、牛' },
  },
  people,
  housing: {
    // 町家比四合院密；规整时变稀（regular）
    perHa: { farm: 8.5, street: 33, town: 36, regular: 0.1, trade: 1 },
    // 町家：面宽窄、进深长的连排；武家屋敷大而疏
    full: {
      common: { low: 14, mid: 18, high: 36 },
      merchant: { low: 8, mid: 10, high: 25 },
      market: { low: 25, mid: 25, high: 60 },
      craft: { low: 14, mid: 18, high: 32 },
      slum: { low: 26, mid: 26, high: 26 },
      noble: { low: 8, mid: 8, high: 8 },
    },
  },
  // 多沿一条大街铺开（宿场町）
  motifBias: { concentric: 0.2, spine: 1.5, drift: 0.5, river: 1, terrace: 1.2 },
  tiers,
  sacred,
  garden: 'wa',
  featureNames: {
    common: '町家', merchant: '商人町', craft: '职人町', noble: '武家屋敷', slum: '长屋', market: '市场', park: '庭园', tavern: '旅笼', subcenter: '副都心', stage: '芝居小屋',
    amphitheater: '相扑场', arena: '马场', temple: '寺社', castle: '天守', barracks: '番所', barbican: '瓮城', hospital: '养生所', school: '藩校', gallows: '刑场',
    mill: '水车小屋', kiln: '砖瓦窑', winery: '葡萄酒坊', guild: '株仲间会所', exchange: '两替商', warehouse: '土藏', harbor: '凑', magic: '阴阳寮', observatory: '天文台',
    portal: '挪移阵',
  },
  palettes: {
    color: {
      // 瓦顶的町家是深灰，天守、寺社的白壁黑瓦
      house: ['#5d6167', '#565a60', '#63676d', '#51555b'],
      large: ['#4c5056'],
      temple: ['#7a5a3c'],
      keep: ['#e9e4d6'],
      tower: ['#e2ddcf'],
      hall: ['#8a3b2e'],
      shed: ['#8f8574'],
      pagoda: ['#8a3b2e'],
      magic: ['#4c8a8f'],
      civic: ['#b0452f'],
    },
    // 切绘图：厅堂用朱
    kiriezu: { hall: ['#c8452d'] },
  },
  // 街道是夯土，枯山水的白砂略亮
  ground: { street: '#b3a487', gutter: '#96886c', plaza: '#bdb096', yard: '#a8a07a', gravel: '#d6d1c2', paved: false },
}
