import type { CultureDef } from '../../../settlement/culture'
import { sacredNamer } from '../sacredNames'
import { lifang } from './lifang'
import { EAST_SACRED, naming } from './naming'
import { people } from './people'
import { sacred } from './sacred'
import { eastern as style } from './style'
import { tiers } from './tiers'

/** 东方：中国，四合院、中轴对称的宫城与寺观、里坊 */
export const eastern: CultureDef = {
  id: 'eastern',
  name: '东方',
  desc: '里坊民居、中轴对称的宫城与寺观、四合院',
  traits: {
    eastAsian: true,
    paddy: true,
    brushTitle: true,
    hillSect: true,
    perHousehold: 4.2,
    autoWalls: true,
    moat: true,
    innerWall: true,
    palaceFacing: 'south',
    compoundAxis: 'grid',
    tombs: true,
    // 唐律"京城内不得葬"：城里没有墓园，坟地在城外（见 tombs）
    exclude: ['windmill', 'cemetery'],
    templeGrove: 0.007,
    waysideGap: 300,
  },
  plans: [lifang],
  style,
  naming: { ...naming, sacred: sacredNamer(EAST_SACRED) },
  lexicon: {
    home: ['院落民居', '农家院落'],
    temple: '寺观',
    keep: '楼阁',
    mansion: '府第',
    shophouse: '临街铺面楼',
    tenement: '大宅',
    grave: '坟丘',
    castleHall: '殿',
    townHall: '市署',
    marketTower: '市楼',
    pavilion: '塔、亭',
    ruralCemetery: '坟地（家族祖坟）',
    crops: {
      crop: ({ warm, dry }) => (dry ? '粟、黍' : warm ? '麦、豆' : '粟、麦'),
      orchard: ({ warm }) => (warm ? '柑橘、荔枝' : '桃、梨、枣'),
      garden: '白菜、葱、萝卜',
      pasture: '牛、羊',
    },
  },
  people,
  housing: {
    // 院落之间空地多：规整时变稀（regular）
    perHa: { farm: 12, street: 33, town: 33, regular: 0.1, trade: 1 },
    // 院落：疏档的大宅是一家人住好几座屋
    full: {
      common: { low: 7.5, mid: 20, high: 44 },
      merchant: { low: 11, mid: 30, high: 60 },
      market: { low: 41, mid: 41, high: 75 },
      craft: { low: 3.5, mid: 26, high: 68 },
      slum: { low: 80, mid: 80, high: 80 },
      noble: { low: 20, mid: 20, high: 20 },
    },
  },
  // 多沿一条大街、街道铺开（街市）
  motifBias: { concentric: 0.15, spine: 1.4, drift: 0.6, river: 1, terrace: 0.8 },
  tiers,
  sacred,
  garden: 'eastern',
  featureNames: {
    common: '里坊民居', merchant: '商坊', craft: '匠作坊', noble: '官宦宅第', slum: '棚户', market: '市坊', park: '园林', cemetery: '义冢', tavern: '客栈', subcenter: '副都心',
    stage: '戏台', amphitheater: '百戏场', arena: '擂台', temple: '寺观', castle: '宫城', barracks: '校场', barbican: '瓮城', hospital: '养济院', school: '书院',
    gallows: '刑场', mill: '水碾', kiln: '砖瓦窑', winery: '葡萄酒坊', guild: '会馆', exchange: '钱庄', warehouse: '仓廒', harbor: '码头', magic: '宗门', observatory: '司天台',
    portal: '挪移阵',
  },
  palettes: {
    color: {
      house: ['#747b82', '#6a7178', '#7d838a', '#666d74'],
      large: ['#5f666e'],
      temple: ['#c9963a'],
      keep: ['#c79a3c'],
      tower: ['#8f4a3a'],
      hall: ['#4f7e62'],
      shed: ['#9a8f7e'],
      pagoda: ['#8f4a3a'],
      magic: ['#4c8a8f'],
      civic: ['#b0452f'],
    },
    // 切绘图：厅堂用朱
    kiriezu: { hall: ['#c8452d'] },
  },
  ground: { street: '#a39e94', gutter: '#847f76', plaza: '#a9a59c', yard: '#a89f7c', lane: '#b3a283' },
}
