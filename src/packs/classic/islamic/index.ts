import type { CultureDef } from '../../../settlement/culture'
import { sacredNamer } from '../sacredNames'
import { medina } from './medina'
import { ISLAMIC_SACRED, naming } from './naming'
import { people } from './people'
import { sacred } from './sacred'
import { islamic as style } from './style'
import { tiers } from './tiers'

/** 伊斯兰：中东与北非，内院住宅、清真寺、集市与浴场 */
export const islamic: CultureDef = {
  id: 'islamic',
  name: '伊斯兰',
  desc: '内院住宅与尽端巷、清真寺、集市与浴场',
  traits: {
    eastAsian: false,
    paddy: false,
    brushTitle: false,
    hillSect: false,
    perHousehold: 6,
    autoWalls: true,
    moat: false,
    innerWall: false,
    palaceFacing: 'center',
    compoundAxis: 'lot',
    // 没有剧场、竞技场、比武场与酒庄
    exclude: ['stage', 'pulpit', 'amphitheater', 'arena', 'winery', 'windmill'],
    templeGrove: 0.007,
    waysideGap: 420,
  },
  plans: [medina],
  style,
  naming: { ...naming, sacred: sacredNamer(ISLAMIC_SACRED) },
  lexicon: {
    home: ['内院住宅', '农舍'],
    temple: '清真寺',
    keep: '城堡主楼',
    mansion: '府邸',
    shophouse: '商人的楼房（楼下铺面）',
    tenement: '大宅',
    grave: '墓',
    castleHall: '殿',
    townHall: '市署',
    marketTower: '市楼',
    pavilion: '凉亭',
    crops: {
      crop: ({ dry }) => (dry ? '大麦、小麦（引水灌溉）' : '小麦、大麦'),
      orchard: ({ warm }) => (warm ? '枣椰、石榴、杏' : '杏、石榴、核桃'),
      garden: '豆、洋葱、瓜',
      pasture: '羊',
    },
  },
  people,
  housing: {
    // 内院住宅与尽端巷和西式一样密
    perHa: { farm: 4.5, street: 38, town: 38, regular: 0, trade: 0.85 },
    // 内院住宅挤满街坊，只留尽端巷
    full: {
      common: { low: 16, mid: 51, high: 100 },
      merchant: { low: 10, mid: 32, high: 80 },
      // 集市是摊位与商队客栈，住户很少
      market: { low: 22, mid: 22, high: 22 },
      craft: { low: 15, mid: 49, high: 85 },
      slum: { low: 104, mid: 104, high: 104 },
      noble: { low: 11, mid: 11, high: 11 },
    },
  },
  // 老城是走向各异的巷子
  motifBias: { concentric: 0.4, spine: 0.4, drift: 2.2, river: 0.7, terrace: 0.8 },
  tiers,
  sacred,
  garden: 'islamic',
  featureNames: {
    common: '内院民居', merchant: '商人街区', craft: '工匠街区', noble: '贵族宅邸', slum: '棚户', market: '巴扎', park: '花园', cemetery: '墓园', tavern: '商队客栈', stage: '说书场',
    amphitheater: '竞技场', arena: '马球场', temple: '清真寺', hospital: '医院', school: '经学院', gallows: '刑场', mill: '水磨', guild: '商会', exchange: '钱庄',
    harbor: '港口', observatory: '天文台',
  },
  palettes: {
    color: {
      // 土坯、石灰抹面的平顶，清真寺的绿与白
      house: ['#e3d3b1', '#dccaa4', '#e8dbbd', '#d6c39b', '#ead9b3'],
      large: ['#cdb68c'],
      temple: ['#3f8a78'],
      keep: ['#b98e5d'],
      tower: ['#f0e9d8'],
      hall: ['#c49a62'],
      shed: ['#c9b38e'],
      pagoda: ['#f0e9d8'],
      magic: ['#4c6fa8'],
      civic: ['#3f6f8a'],
    },
    // 切绘图：土坯城的民居换成浅一些的灰褐
    kiriezu: { house: ['#a49a88', '#9d9382', '#aaa08e'] },
  },
  // 干旱地带：草色偏黄，街道、官道都是夯土
  ground: {
    wild: '#a39b62',
    balk: '#8f8a54',
    street: '#c2ae8a',
    gutter: '#a5916f',
    plaza: '#c9b896',
    yard: '#b8a67c',
    road: '#c4b08a',
    rut: '#af9a74',
    crown: '#bdab82',
    lane: '#bfaa84',
    path: '#b9a47e',
    verge: '#a09660',
    paved: false,
  },
}
