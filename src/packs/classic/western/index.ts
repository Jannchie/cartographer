import type { CultureDef } from '../../../settlement/culture'
import { sacredNamer } from '../sacredNames'
import { bastide } from './bastide'
import { castrum } from './castrum'
import { naming, WEST_SACRED } from './naming'
import { people } from './people'
import { sacred } from './sacred'
import { tiers } from './tiers'

/**
 * 西式：中世纪欧洲，城堡、教堂、广场与市民住宅。
 * 片区全用通用填法（features.ts、wards.ts 里西式的一套），各绘图风格与沙盘地面的默认配色也就是西式的。
 */
export const western: CultureDef = {
  id: 'western',
  name: '西式',
  desc: '中世纪欧洲式：城堡、教堂、广场与市民住宅',
  traits: {
    eastAsian: false,
    paddy: false,
    brushTitle: false,
    hillSect: false,
    perHousehold: 5.5,
    autoWalls: true,
    moat: false,
    innerWall: false,
    palaceFacing: 'center',
    compoundAxis: 'lot',
    templeGrove: 0.007,
    waysideGap: 380,
  },
  plans: [castrum, bastide],
  style: {},
  naming: { ...naming, sacred: sacredNamer(WEST_SACRED) },
  lexicon: {
    home: ['市民住宅', '农舍'],
    temple: '教堂',
    keep: '城堡主楼',
    mansion: '府邸',
    shophouse: '商人的楼房（楼下铺面）',
    tenement: '多层公寓楼',
    grave: '墓',
    castleHall: '厅堂、附属楼',
    townHall: '市政厅',
    marketTower: '钟楼',
    pavilion: '凉亭',
    crops: {
      crop: ({ warm }) => (warm ? '小麦、大麦' : '小麦、黑麦、燕麦（三圃轮作）'),
      orchard: ({ warm }) => (warm ? '橄榄、无花果' : '苹果、梨'),
      garden: '卷心菜、豆、洋葱',
      pasture: '牛、羊',
    },
  },
  people,
  housing: {
    // 宽街、仓栈在西式的街坊里明显压低密度（trade）
    perHa: { farm: 8.5, street: 38, town: 38, regular: 0, trade: 0.85 },
    // 疏档是贴着街、屋后带长院子的一排屋子，中档、密档是共用山墙的连排
    full: {
      common: { low: 14, mid: 44, high: 118 },
      merchant: { low: 9, mid: 34, high: 70 },
      market: { low: 53, mid: 53, high: 102 },
      craft: { low: 5, mid: 31, high: 72 },
      slum: { low: 80, mid: 80, high: 80 },
      noble: { low: 6.5, mid: 6.5, high: 6.5 },
    },
  },
  // 老城多绕教堂、市场成环
  motifBias: { concentric: 1.3, spine: 1, drift: 0.9, river: 1, terrace: 1 },
  tiers,
  sacred,
  garden: 'western',
}
