import { CULTURE_INFO, eastAsian } from './culture'
import { emitArea, clipWater, isFree, placeable, whereOf, mark, type Ctx } from './ctx'
import { area, centroid, circlePoly, dist, insetConvex, obb, rect, type P, type Poly } from './geom'
import { amphitheater, arenaAt, hospitalAt, pulpitAt, schoolAt, stageAt, tavernAt, wineryAt } from './civic'
import { isVillage, scaleOf } from './scale'
import type { BuildingKind, Culture, Landmark, SettlementParams, SettlementSize, Ward, WardType } from './types'
import {
  addBuilding,
  addGroup,
  castle,
  cemetery,
  fit,
  harbor,
  inside,
  magicWard,
  noble,
  plaza,
  scatterTrees,
  temple,
  urban,
} from './wards'
import { park } from './parks'

/**
 * 聚落要素注册表：城里"有什么"都在这里声明。
 *
 * 每种要素说明：分组、东西方名称、需要的奇幻程度、形态（整块片区 / 插入的单栋地标 / 地图级奇观）、
 * 默认数量怎么随人口与城市功效推算、选址偏好（打分）、以及怎么生成（通用积木或专属函数）。
 * 选址与放置由 zoning.ts 的通用引擎完成；新增要素通常只需在这里加一条定义。
 */

export type FeatureId =
  | 'common'
  | 'merchant'
  | 'craft'
  | 'noble'
  | 'slum'
  | 'plaza'
  | 'market'
  | 'park'
  | 'cemetery'
  | 'tavern'
  | 'subcenter'
  | 'stage'
  | 'pulpit'
  | 'arena'
  | 'amphitheater'
  | 'winery'
  | 'temple'
  | 'castle'
  | 'barracks'
  | 'barbican'
  | 'guild'
  | 'exchange'
  | 'warehouse'
  | 'harbor'
  | 'magic'
  | 'observatory'
  | 'portal'
  | 'isle'
  | 'leyline'
  | 'hospital'
  | 'school'
  | 'mill'
  | 'windmill'
  | 'gallows'
  | 'kiln'
  | 'lighthouse'

export type CityFunction = 'balanced' | 'fortress' | 'magic' | 'craft' | 'trade'

/** 城市功效：改变要素的默认数量与城墙样式（要塞的棱堡、商贸城的宽干道见 generate.ts） */
export const FUNCTIONS: { id: CityFunction; name: string; desc: string }[] = [
  { id: 'balanced', name: '均衡', desc: '各类片区按常见比例分布' },
  { id: 'fortress', name: '要塞', desc: '棱堡城墙与卫城，兵营、校场与顺城环路' },
  { id: 'magic', name: '魔法', desc: '主塔居城心，观星台、传送门与灵脉' },
  { id: 'craft', name: '工匠', desc: '沿水的作坊带与货栈，行会大厅' },
  { id: 'trade', name: '商贸', desc: '宽阔干道汇向大市场，交易所、货栈与沿街酒馆' },
]

export type FeatureGroup = 'dwelling' | 'public' | 'faith' | 'defense' | 'industry' | 'magic'
export const GROUPS: { id: FeatureGroup; name: string }[] = [
  { id: 'dwelling', name: '居住' },
  { id: 'public', name: '公共' },
  { id: 'faith', name: '信仰' },
  { id: 'defense', name: '城防' },
  { id: 'industry', name: '产业' },
  { id: 'magic', name: '奇幻' },
]

/** 推算默认数量所需的环境 */
export interface FeatureEnv {
  pop: number
  size: SettlementSize
  big: boolean
  fn: CityFunction
  culture: Culture
  /** 实际的奇幻程度（魔法都市至少算奇幻） */
  magic: number
  coast: boolean
  river: boolean
  hills: boolean
  walled: boolean
  /** 都城：城堡（宫城）总有一座，盖成宫殿 */
  capital: boolean
  /** 城内片区数 */
  inner: number
}

/** 选址时一块候选片区的情况 */
export interface Site {
  /** 离城心的距离（按城区半径归一，0 ~ 1+） */
  dc: number
  /** 贴着城墙（或城区边缘） */
  wall: boolean
  /** 临水（河或海） */
  water: boolean
  /** 临海 */
  sea: boolean
  /** 地势高低（按城内高程归一，0 ~ 1） */
  high: number
  /** 没有干道穿过（城堡、教堂这类整块建筑需要） */
  clear: boolean
  /** 与城心相邻 */
  nearCenter: boolean
  /** 片区面积（按标准片区 patch² 归一，1 左右） */
  size: number
  /** 离干道的远近（1 在干道上，0 离得远） */
  road: number
  /** 到已放置的某种要素的距离（按城区半径归一；没有则为 Infinity） */
  near(id: FeatureId): number
}

export interface LandmarkSpec {
  /** 占地（米） */
  w: number
  d: number
  kind: BuildingKind
  /** 可以插进哪些片区 */
  hosts: WardType[]
  mark: Landmark['kind']
  /** 专属生成（默认是一栋沿街的建筑） */
  build?(ctx: Ctx, at: P, axis: P): boolean
}

export interface FeatureDef {
  id: FeatureId
  group: FeatureGroup
  /** 各文明下的叫法：西方、东方，和风、伊斯兰缺省时分别沿用东方、西方的 */
  name: [western: string, eastern: string, wa?: string, islamic?: string]
  desc: string
  /** 需要的奇幻程度 */
  magic?: number
  /** ward：占一整块片区；landmark：插进别的片区的一栋；wonder：由生成流程直接建造、不占片区（奇观、瓮城）；filler：填满其余 */
  form: 'ward' | 'landmark' | 'wonder' | 'filler'
  /** 选址顺序（越小越先占） */
  order: number
  /** 手动数量上限 */
  max: number
  auto(e: FeatureEnv): number
  site?(s: Site, e: FeatureEnv): number
  /** 片区形态：填满这块片区 */
  build?(ctx: Ctx, ward: Ward, block: Poly, e: FeatureEnv): void
  landmark?: LandmarkSpec
  /** 片区会取一个街区名（民居、商坊这类成片的街坊；单座建筑群如城堡、兵营不取） */
  named?: boolean
}

const round = (x: number) => Math.max(0, Math.round(x))
/** 村子越大、越靠村心，越多片区盖成连排的街坊（向城镇过渡）；其余是零散的农家。城镇以上都是街坊 */
export const townlike = (ctx: Ctx) => ctx.wardTown

/** 功效对数量的倍率 */
const fnMul = (e: FeatureEnv, m: Partial<Record<CityFunction, number>>) => m[e.fn] ?? 1

export const FEATURES: FeatureDef[] = [
  // —— 居住 ——
  {
    id: 'common',
    named: true,
    group: 'dwelling',
    name: ['民居', '里坊民居', '町家', '内院民居'],
    desc: '普通住户的街坊，填满其余的片区',
    form: 'filler',
    order: 100,
    max: 0,
    auto: () => 0,
    build(ctx, _w, block) {
      if (!townlike(ctx)) urban(ctx, block, 'village', [])
      else urban(ctx, block, 'common')
    },
  },
  {
    id: 'merchant',
    named: true,
    group: 'dwelling',
    name: ['商人区', '商坊', '商人町', '商人街区'],
    desc: '富商与店铺，靠近城心与干道',
    form: 'ward',
    order: 60,
    max: 40,
    auto: (e) => (e.big ? round(e.inner * 0.16 * fnMul(e, { trade: 1.8, fortress: 0.6, craft: 0.7 })) : 0),
    site: (s) => -s.dc * 2 + s.road * 1.2,
    build: (ctx, _w, block) => urban(ctx, block, 'merchant'),
  },
  {
    id: 'craft',
    named: true,
    group: 'dwelling',
    name: ['工匠区', '匠作坊', '职人町', '工匠街区'],
    desc: '作坊与工匠住户，偏爱临水与城区外圈',
    form: 'ward',
    order: 62,
    max: 40,
    auto: (e) => (e.big ? round(e.inner * 0.2 * fnMul(e, { craft: 2.2, trade: 0.8, magic: 0.7 })) : 0),
    site: (s, e) => (s.water ? 1.5 : 0) * (e.fn === 'craft' ? 2 : 1) + s.dc * 0.6 + s.road * 0.4,
    build: (ctx, _w, block) => urban(ctx, block, 'craft'),
  },
  {
    id: 'noble',
    named: true,
    group: 'dwelling',
    name: ['贵族区', '官宦宅第', '武家屋敷', '贵族宅邸'],
    desc: '带院墙与花园的大宅，偏爱高处、靠近城堡',
    form: 'ward',
    order: 30,
    max: 12,
    auto: (e) => (e.size === 'city' ? round(Math.min(8, 1 + e.pop / 6000)) : e.size === 'town' ? 1 : 0),
    site: (s) => s.high * 1.2 - s.dc * 0.5 + (s.near('castle') < 0.6 ? 1.5 : 0),
    build: (ctx, w, block) => noble(ctx, w, block),
  },
  {
    id: 'slum',
    named: true,
    group: 'dwelling',
    name: ['贫民窟', '棚户', '长屋', '棚户'],
    desc: '城墙根下密集低矮的房屋',
    form: 'ward',
    order: 70,
    max: 16,
    auto: (e) => (e.size === 'city' ? round(Math.min(10, e.pop / 4500) * fnMul(e, { magic: 0.6 })) : 0),
    site: (s) => (s.wall ? 1.5 : 0) + s.dc - s.high * 0.8,
    build: (ctx, _w, block) => urban(ctx, block, 'slum'),
  },
  // —— 公共 ——
  {
    id: 'plaza',
    group: 'public',
    name: ['广场', '广场'],
    desc: '城心之外的街头广场（城心本身按功效决定）',
    form: 'ward',
    order: 40,
    max: 6,
    auto: (e) => (e.big ? round(e.pop / 20000) : 0),
    site: (s) => s.road * 1.5 - s.dc * 0.5 + (s.nearCenter ? -1 : 0) - (s.near('plaza') < 0.5 ? 2 : 0),
    build: (ctx, w, block) => plaza(ctx, w, block),
  },
  {
    id: 'market',
    named: true,
    group: 'public',
    name: ['市集', '市坊', '市场', '巴扎'],
    desc: '市场与市集大厅 / 东西两市',
    form: 'ward',
    order: 20,
    max: 10,
    auto: (e) => (e.big ? round(Math.max(e.size === 'city' ? 2 : 1, e.pop / 7000) * fnMul(e, { trade: 2, fortress: 0.5 })) : 0),
    site: (s) => (s.nearCenter ? 2 : 0) - s.dc + s.road,
    build(ctx, w, block) {
      urban(ctx, block, 'market')
      w.name = ctx.namer.district('market', whereOf(ctx, w.poly))
    },
  },
  {
    id: 'park',
    group: 'public',
    name: ['公园', '园林', '庭园', '花园'],
    desc: '公园 / 园林',
    form: 'ward',
    order: 50,
    max: 8,
    auto: (e) => (e.big ? round(e.pop / 9000 * fnMul(e, { fortress: 0.4, magic: 1.4 })) : 0),
    site: (s) => (s.clear ? 1 : -1) + s.dc * 0.4,
    build: (ctx, w, block) => park(ctx, w, block),
  },
  {
    id: 'cemetery',
    group: 'public',
    name: ['墓地', '义冢', '墓地', '墓园'],
    desc: '墓园，靠近城墙',
    form: 'ward',
    order: 52,
    max: 6,
    auto: (e) => (e.big ? round(Math.max(1, e.pop / 18000)) : 0),
    site: (s) => (s.wall ? 1.5 : 0) + s.dc + (s.clear ? 0.5 : -1),
    build: (ctx, w, block) => cemetery(ctx, w, block),
  },
  {
    id: 'tavern',
    group: 'public',
    name: ['酒馆', '客栈', '旅笼', '商队客栈'],
    desc: '沿主街与城门的酒馆、旅店',
    form: 'landmark',
    order: 0,
    max: 30,
    auto: (e) => (e.pop < 60 ? 0 : e.big ? round(Math.max(1, e.pop / 2500) * fnMul(e, { trade: 2.2, fortress: 1.3, magic: 0.8 })) : 1),
    landmark: { w: 34, d: 30, kind: 'civic', hosts: ['common', 'merchant', 'market', 'craft', 'suburb', 'harbor'], mark: 'tavern', build: tavernAt },
  },
  {
    id: 'subcenter',
    group: 'public',
    name: ['副中心', '副都心'],
    desc: '城区另起的几个中心：各有广场或市集，城区围着它们一起生长、连成一片，彼此有干道相通',
    form: 'wonder',
    order: 0,
    max: 5,
    auto: (e) => (e.size !== 'city' ? 0 : Math.min(4, Math.floor(e.pop / 16000))),
  },
  {
    id: 'stage',
    group: 'public',
    name: ['露天剧场', '戏台', '芝居小屋', '说书场'],
    desc: '一座戏台，前面是扇形的观众场地',
    form: 'landmark',
    order: 0,
    max: 8,
    auto: (e) => (!e.big ? 0 : round(Math.max(1, e.pop / 15000) * fnMul(e, { trade: 1.5, fortress: 0.5 }))),
    landmark: { w: 28, d: 26, kind: 'civic', hosts: ['plaza', 'market', 'common', 'merchant', 'park'], mark: 'stage', build: stageAt },
  },
  {
    id: 'pulpit',
    group: 'public',
    name: ['宣讲台', '宣讲台'],
    desc: '广场上的讲台与围着它的空地：布道、宣读告示、说书',
    form: 'landmark',
    order: 0,
    max: 8,
    auto: (e) => (isVillage(e.size) ? 0 : round(Math.max(1, e.pop / 12000))),
    landmark: { w: 16, d: 16, kind: 'civic', hosts: ['plaza', 'market', 'temple', 'common', 'merchant'], mark: 'pulpit', build: pulpitAt },
  },
  {
    id: 'amphitheater',
    group: 'public',
    name: ['圆形竞技场', '百戏场', '相扑场', '竞技场'],
    desc: '椭圆看台环绕的角斗 / 百戏场地，大小随城市人口，大都会里接近罗马大斗兽场',
    form: 'ward',
    order: 13,
    max: 3,
    auto: (e) => (e.size !== 'city' ? 0 : e.pop >= 30000 ? 2 : 1),
    site: (s) => (s.clear ? 2 : -2) + (s.dc > 0.25 && s.dc < 0.8 ? 1 : 0) + s.road * 0.5 - (s.near('amphitheater') < 0.6 ? 2 : 0),
    build: (ctx, _w, block) => {
      if (!amphitheater(ctx, block)) urban(ctx, block, 'common')
    },
  },
  {
    id: 'arena',
    group: 'public',
    name: ['比武场', '擂台', '马场', '马球场'],
    desc: '围起来的比武场地与两侧看台，多在城边',
    form: 'landmark',
    order: 0,
    max: 4,
    auto: (e) => (!e.big ? 0 : e.fn === 'fortress' ? 2 : e.size === 'city' ? 1 : 0),
    landmark: { w: 46, d: 32, kind: 'civic', hosts: ['suburb', 'barracks', 'common', 'plaza', 'farm'], mark: 'arena', build: arenaAt },
  },
  // —— 信仰 ——
  {
    id: 'temple',
    group: 'faith',
    name: ['教堂', '寺观', '寺社', '清真寺'],
    desc: '主教堂 / 寺观；村里是礼拜堂 / 祠堂',
    form: 'ward',
    order: 12,
    max: 8,
    auto: (e) => (e.size === 'hamlet' ? 0 : e.size === 'village' ? 1 : round(Math.max(1, e.pop / 12000) * fnMul(e, { magic: 0.6 }))),
    site: (s) => (s.nearCenter ? 2 : 0) + (s.clear ? 1 : -2) - s.dc - (s.near('temple') < 0.5 ? 2 : 0),
    build(ctx, w, block, e) {
      if (e.big) return temple(ctx, w, block)
      // 村里：一座礼拜堂 / 祠堂，农舍绕开
      const b = obb(block)
      let ch: Poly | null = null
      for (const s of [1, 0.8])
        for (const t of [0, 0.2, -0.2, 0.35, -0.35]) {
          const q: P = [b.center[0] + b.axis[0] * b.len * t, b.center[1] + b.axis[1] * b.len * t]
          const cand = rect(q, b.axis, 16 * s, 8 * s)
          if (!ch && inside(cand, block) && isFree(ctx, cand, { pad: 1.5 })) ch = cand
        }
      const east = eastAsian(ctx.p.culture)
      if (ch && addBuilding(ctx, ch, east ? 'hall' : 'temple', 1.5))
        mark(ctx, centroid(ch), 'temple', east ? 'shrine' : 'chapel')
      urban(ctx, block, 'village', ch ? [rect(centroid(ch), b.axis, 26, 16)] : [])
    },
  },
  // —— 城防 ——
  {
    id: 'castle',
    group: 'defense',
    name: ['城堡', '宫城', '天守', '城堡'],
    desc: '城堡 / 宫城衙署；要塞城里是卫城',
    form: 'ward',
    order: 10,
    max: 3,
    auto: (e) => (e.capital && e.big ? 1 : !e.big || !e.walled ? 0 : e.fn === 'fortress' || e.size === 'city' ? 1 : e.pop > 5000 ? 1 : 0),
    // 都城的宫殿要大块地、离城心不远（不靠城墙），其余城堡靠墙、占高处
    site: (s, e) =>
      e.capital
        ? s.clear
          ? (s.nearCenter ? 1 : 0) - s.dc * 2 + Math.min(s.size, 2.5) * 4 + s.high - (s.water ? 3 : 0)
          : -Infinity
        : (s.wall ? (e.fn === 'fortress' ? 3 : 1) : -2) + s.high * 1.5 + (s.clear ? 1 : -4),
    build: (ctx, w, block) => castle(ctx, w, block),
  },
  {
    id: 'barracks',
    group: 'defense',
    name: ['兵营', '校场', '番所', '兵营'],
    desc: '围墙里的营房与操练场，靠近城墙与城堡',
    form: 'ward',
    order: 14,
    max: 10,
    auto: (e) => (!e.big ? 0 : e.fn === 'fortress' ? round(Math.max(2, e.inner * 0.08)) : e.size === 'city' ? 1 : 0),
    site: (s) => (s.wall ? 2 : 0) + (s.near('castle') < 0.7 ? 1 : 0) + (s.clear ? 0.5 : -1) - (s.near('barracks') < 0.4 ? 1.5 : 0),
    build: (ctx, w, block) => barracks(ctx, w, block),
  },
  {
    id: 'barbican',
    group: 'defense',
    name: ['城门外堡', '瓮城'],
    desc: '石砌城门外再围一圈小城，攻进外门还要再破内门',
    form: 'wonder',
    order: 0,
    max: 8,
    // 城市的主要城门都有，要塞城门门都有，城镇只在第一座城门
    auto: (e) => (!e.walled || !e.big ? 0 : e.fn === 'fortress' ? 8 : e.size === 'city' ? 3 : 1),
  },
  {
    id: 'hospital',
    group: 'public',
    name: ['医院 / 济贫院', '养济院', '养生所', '医院'],
    desc: '收治病人与孤贫的院落：病房大厅、礼拜堂与药草园',
    form: 'landmark',
    order: 0,
    max: 6,
    auto: (e) => (!e.big ? 0 : round(Math.max(e.pop > 4000 ? 1 : 0, e.pop / 15000))),
    landmark: { w: 34, d: 26, kind: 'civic', hosts: ['common', 'suburb', 'temple', 'merchant'], mark: 'hospital', build: hospitalAt },
  },
  {
    id: 'school',
    group: 'public',
    name: ['大学 / 学校', '书院', '藩校', '经学院'],
    desc: '四合方院的大学、主教座堂学校 / 中轴对称的书院',
    form: 'landmark',
    order: 0,
    max: 4,
    auto: (e) => (e.size === 'city' ? round(Math.max(1, e.pop / 25000)) : e.pop > 5000 ? 1 : 0),
    landmark: { w: 40, d: 34, kind: 'civic', hosts: ['common', 'temple', 'merchant', 'noble'], mark: 'school', build: schoolAt },
  },
  {
    id: 'gallows',
    group: 'public',
    name: ['绞刑架', '刑场', '刑场', '刑场'],
    desc: '城门外大路边的刑场',
    form: 'wonder',
    order: 0,
    max: 2,
    auto: (e) => (e.big ? 1 : 0),
  },
  {
    id: 'lighthouse',
    group: 'public',
    name: ['灯塔', '灯塔'],
    desc: '离港口不远的岬角上的灯塔',
    form: 'wonder',
    order: 0,
    max: 2,
    auto: (e) => (e.coast && e.big ? 1 : 0),
  },
  // —— 产业 ——
  {
    id: 'mill',
    group: 'industry',
    name: ['水车磨坊', '水碾', '水车小屋', '水磨'],
    desc: '城区上下游河岸上的水车磨坊',
    form: 'wonder',
    order: 0,
    max: 8,
    auto: (e) => (e.river && e.size !== 'hamlet' ? Math.min(6, round(1 + e.pop / 8000)) : 0),
  },
  {
    id: 'windmill',
    group: 'industry',
    name: ['风车', '风车'],
    desc: '城外开阔高处的磨坊风车（西式，别的文明见 CultureInfo.exclude）',
    form: 'wonder',
    order: 0,
    max: 8,
    auto: (e) => (e.size !== 'hamlet' ? Math.min(5, round(e.pop / 9000 + (e.river ? 0 : 1))) : 0),
  },
  {
    id: 'kiln',
    group: 'industry',
    name: ['砖窑', '砖瓦窑'],
    desc: '城外取土方便处的砖瓦窑与晾坯棚',
    form: 'wonder',
    order: 0,
    max: 4,
    auto: (e) => (e.big ? 1 + (e.fn === 'craft' ? 1 : 0) : 0),
  },
  {
    id: 'winery',
    group: 'industry',
    name: ['葡萄酒庄', '葡萄酒坊'],
    desc: '城外田间带院墙的酒庄，周围的田改种葡萄',
    form: 'landmark',
    order: 0,
    max: 4,
    auto: (e) => (e.pop < 150 ? 0 : 1),
    landmark: { w: 36, d: 28, kind: 'civic', hosts: ['farm'], mark: 'winery', build: wineryAt },
  },
  {
    id: 'guild',
    group: 'industry',
    name: ['行会大厅', '会馆', '株仲间会所', '商会'],
    desc: '工匠与商人的行会大厅',
    form: 'ward',
    order: 24,
    max: 6,
    auto: (e) => (!e.big ? 0 : e.fn === 'craft' ? round(Math.max(1, e.pop / 8000)) : e.fn === 'trade' || e.size === 'city' ? 1 : 0),
    site: (s) => -s.dc * 1.5 + s.road + (s.near('market') < 0.5 ? 1 : 0) - (s.near('guild') < 0.5 ? 2 : 0),
    build: (ctx, w, block) => guildHall(ctx, w, block),
  },
  {
    id: 'exchange',
    group: 'industry',
    name: ['交易所', '钱庄', '两替商', '钱庄'],
    desc: '回廊环绕的交易大院，靠近城心',
    form: 'ward',
    order: 26,
    max: 4,
    auto: (e) => (!e.big ? 0 : e.fn === 'trade' ? round(Math.max(1, e.pop / 12000)) : 0),
    site: (s) => (s.nearCenter ? 2 : 0) - s.dc + s.road + (s.clear ? 0.5 : -1),
    build: (ctx, w, block) => exchange(ctx, w, block),
  },
  {
    id: 'warehouse',
    group: 'industry',
    name: ['货栈', '仓廒', '土藏', '货栈'],
    desc: '成排的大仓库，临水或靠近城门',
    form: 'ward',
    order: 64,
    max: 12,
    auto: (e) => (!e.big ? 0 : round((e.size === 'city' ? 1 : 0) + (e.fn === 'trade' || e.fn === 'craft' ? Math.max(1, e.pop / 6000) : 0))),
    site: (s) => (s.water ? 2 : 0) + (s.wall ? 0.8 : 0) + s.road * 0.6,
    build(ctx, w, block) {
      urban(ctx, block, 'harbor')
      w.name = ctx.namer.landmark('warehouse', ctx.p.magic)
    },
  },
  {
    id: 'harbor',
    named: true,
    group: 'industry',
    name: ['港区', '码头', '凑', '港口'],
    desc: '临水的港口与码头',
    form: 'ward',
    order: 16,
    max: 8,
    auto: (e) => (!e.big ? 0 : e.coast ? (e.size === 'city' ? 3 : 2) + (e.fn === 'trade' ? 1 : 0) : e.river ? (e.fn === 'trade' || e.fn === 'craft' ? 2 : 1) : 0),
    site: (s, e) => (!s.water || (e.coast && !s.sea) ? -Infinity : 2 - s.dc),
    build: (ctx, w, block) => harbor(ctx, w, block),
  },
  // —— 奇幻 ——
  {
    id: 'magic',
    group: 'magic',
    name: ['法师塔', '宗门', '阴阳寮', '法师塔'],
    desc: '奇观片区；东方依山时宗门建在山上',
    magic: 1,
    form: 'ward',
    order: 18,
    max: 6,
    auto: (e) => (e.fn === 'magic' ? round(Math.max(1, e.pop / 10000)) : 1),
    site: (s) => s.high + s.dc + (s.clear ? 0.5 : -1) - (s.nearCenter ? 1 : 0) - (s.near('magic') < 0.5 ? 2 : 0),
    build: (ctx, w, block) => magicWard(ctx, w, block),
  },
  {
    id: 'observatory',
    group: 'magic',
    name: ['观星台', '司天台', '天文台', '天文台'],
    desc: '高处的星象塔与圆台',
    magic: 1,
    form: 'ward',
    order: 22,
    max: 4,
    auto: (e) => (!e.big ? 0 : e.fn === 'magic' ? 1 : e.size === 'city' ? 1 : 0),
    site: (s) => s.high * 2.5 + s.dc * 0.5 + (s.clear ? 0.5 : -1),
    build: (ctx, w, block) => observatory(ctx, w, block),
  },
  {
    id: 'portal',
    group: 'magic',
    name: ['传送门', '挪移阵'],
    desc: '广场或城门内的传送法阵',
    magic: 1,
    form: 'landmark',
    order: 0,
    max: 6,
    auto: (e) => (e.magic >= 2 || (e.fn === 'magic' && e.magic >= 1) ? 1 : 0),
    landmark: { w: 22, d: 22, kind: 'magic', hosts: ['plaza', 'market', 'magic', 'common', 'merchant'], mark: 'portal', build: portalAt },
  },
  {
    id: 'isle',
    group: 'magic',
    name: ['浮空岛', '浮空岛'],
    desc: '悬在城外空中的小岛',
    magic: 2,
    form: 'wonder',
    order: 0,
    max: 4,
    auto: () => 1,
  },
  {
    id: 'leyline',
    group: 'magic',
    name: ['灵脉', '灵脉'],
    desc: '穿过奇观的发光地脉',
    magic: 1,
    form: 'wonder',
    order: 0,
    max: 3,
    auto: (e) => (e.magic >= 2 || e.fn === 'magic' ? 1 : 0),
  },
]

export const FEATURE: Record<FeatureId, FeatureDef> = Object.fromEntries(FEATURES.map((f) => [f.id, f])) as Record<FeatureId, FeatureDef>

/** 要素在某个文明下的叫法 */
export function featureName(f: FeatureDef, c: Culture) {
  const [west, east, wa, islamic] = f.name
  return c === 'eastern' ? east : c === 'wa' ? (wa ?? east) : c === 'islamic' ? (islamic ?? west) : west
}

export function featureEnv(p: SettlementParams, walled = p.walls !== 'none'): FeatureEnv {
  const sc = scaleOf(p.population)
  const big = sc.size === 'town' || sc.size === 'city'
  return {
    pop: p.population,
    size: sc.size,
    big,
    fn: p.function,
    culture: p.culture,
    magic: Math.max(p.magic, p.function === 'magic' ? 1 : 0),
    coast: p.coast,
    river: p.river,
    hills: p.hills,
    walled: walled && sc.size !== 'hamlet',
    capital: !!p.capital,
    inner: sc.cfg.inner,
  }
}

/** 各要素最终数量：手动覆盖优先，否则自动推算 */
export function resolveCounts(p: SettlementParams, e: FeatureEnv): Record<FeatureId, number> {
  const out = {} as Record<FeatureId, number>
  for (const f of FEATURES) {
    // 奇幻程度不够的要素一律没有（手动数量也不例外）
    if ((f.magic ?? 0) > e.magic) {
      out[f.id] = 0
      continue
    }
    const manual = p.counts[f.id]
    const foreign = CULTURE_INFO[e.culture].exclude?.includes(f.id)
    out[f.id] = manual !== undefined && manual !== null ? Math.max(0, Math.min(f.max, manual)) : foreign ? 0 : f.auto(e)
  }
  return out
}

// —————————————————————— 新要素的生成 ——————————————————————

/** 兵营：围墙里三面营房、中间操练场 */
function barracks(ctx: Ctx, w: Ward, block: Poly) {
  const zone = placeable(ctx, insetConvex(block, 4), 3, 0.3)
  if (!zone || zone.length < 3 || area(zone) < 1200) return urban(ctx, block, 'common')
  emitArea(ctx, 'enclosures', zone)
  const yard = insetConvex(zone, 14)
  if (yard.length >= 3) emitArea(ctx, 'plazas', yard)
  const inner = insetConvex(zone, 2)
  const c = centroid(inner)
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i]
    const e = inner[(i + 1) % inner.length]
    const L = dist(a, e)
    if (L < 18) continue
    const u: P = [(e[0] - a[0]) / L, (e[1] - a[1]) / L]
    const n: P = [-u[1], u[0]]
    const s = (c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] > 0 ? 1 : -1
    const mid: P = [a[0] + u[0] * L * 0.5 + n[0] * s * 5, a[1] + u[1] * L * 0.5 + n[1] * s * 5]
    const hall = rect(mid, u, L * 0.72, 8)
    if (inside(hall, zone)) addBuilding(ctx, hall, 'hall', 0.5)
  }
  mark(ctx, c, 'barracks')
  void w
}

/** 行会大厅：临街的一座大厅，周围照常是街坊 */
function guildHall(ctx: Ctx, w: Ward, block: Poly) {
  const zone = clipWater(ctx, insetConvex(block, 3), 3)
  if (!zone) return urban(ctx, block, 'merchant')
  const b = obb(zone)
  const hall = fit(zone, (q, s) => rect(q, b.axis, 30 * s, 16 * s), (h) => inside(h, zone) && isFree(ctx, h, { pad: 1.5 }), [1, 0.8, 0.65])
  const reserve: Poly[] = []
  if (hall && addBuilding(ctx, hall, 'hall', 1.5)) {
    const hc = centroid(hall)
    mark(ctx, hc, 'guild')
    reserve.push(rect(hc, b.axis, 44, 28))
    const fore = rect([hc[0] - b.axis[1] * 14, hc[1] + b.axis[0] * 14], b.axis, 26, 8)
    if (isFree(ctx, fore, { tags: ['wall', 'river'] }) && inside(fore, zone)) emitArea(ctx, 'plazas', fore)
  }
  urban(ctx, block, 'merchant', reserve)
  void w
}

/** 交易所：四面回廊围着一方庭院 */
function exchange(ctx: Ctx, w: Ward, block: Poly) {
  const zone = clipWater(ctx, insetConvex(block, 4), 3)
  if (!zone) return urban(ctx, block, 'merchant')
  const b = obb(zone)
  const n: P = [-b.axis[1], b.axis[0]]
  const got = fit(
    zone,
    (q, s) => {
      const L = 44 * s
      const D = 32 * s
      const t = 7 * s
      const parts: [Poly, BuildingKind][] = [
        [rect([q[0] + n[0] * (D / 2 - t / 2), q[1] + n[1] * (D / 2 - t / 2)], b.axis, L, t), 'hall'],
        [rect([q[0] - n[0] * (D / 2 - t / 2), q[1] - n[1] * (D / 2 - t / 2)], b.axis, L, t), 'hall'],
        [rect([q[0] + b.axis[0] * (L / 2 - t / 2), q[1] + b.axis[1] * (L / 2 - t / 2)], b.axis, t, D - 2 * t), 'hall'],
        [rect([q[0] - b.axis[0] * (L / 2 - t / 2), q[1] - b.axis[1] * (L / 2 - t / 2)], b.axis, t, D - 2 * t), 'hall'],
      ]
      return { q, L, D, t, parts }
    },
    (g) => g.parts.every(([p]) => inside(p, zone) && isFree(ctx, p, { pad: 1 })),
    [1, 0.8, 0.65],
  )
  const reserve: Poly[] = []
  if (got && addGroup(ctx, got.parts, 1)) {
    emitArea(ctx, 'plazas', rect(got.q, b.axis, got.L - got.t * 2, got.D - got.t * 2))
    mark(ctx, got.q, 'exchange')
    reserve.push(rect(got.q, b.axis, got.L + 10, got.D + 10))
  }
  urban(ctx, block, 'merchant', reserve)
  void w
}

/** 观星台：高处的圆塔与一圈观测台，四周是园地 */
function observatory(ctx: Ctx, w: Ward, block: Poly) {
  const g = clipWater(ctx, insetConvex(block, 3), 3)
  if (!g || g.length < 3) return urban(ctx, block, 'common')
  const spot = fit(g, (q, s) => ({ q, r: 16 * s }), (t) => isFree(ctx, circlePoly(t.q, t.r * 1.3, 16), { pad: 1 }) && inside(circlePoly(t.q, t.r * 1.3, 16), g), [1, 0.8, 0.65])
  if (!spot) return urban(ctx, block, 'common')
  const { q, r } = spot
  emitArea(ctx, 'greens', circlePoly(q, r * 1.3, 20), 'garden')
  emitArea(ctx, 'plazas', circlePoly(q, r, 24))
  addBuilding(ctx, circlePoly(q, r * 0.36, 18), 'magic')
  // 圆台上的观测仪：一圈小石墩
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2
    addBuilding(ctx, circlePoly([q[0] + Math.cos(a) * r * 0.72, q[1] + Math.sin(a) * r * 0.72], 1.4, 6), 'shed')
  }
  ctx.occ.add(circlePoly(q, r * 1.3, 16))
  mark(ctx, q, 'observatory')
  urban(ctx, block, 'common', [circlePoly(q, r * 1.5, 16)])
  scatterTrees(ctx, g, 0.002, 3, 5)
  void w
}

/** 传送门：一圈法阵，中间一座门廊 */
function portalAt(ctx: Ctx, at: P, axis: P): boolean {
  const r = 9
  const ring = circlePoly(at, r * 1.15, 18)
  if (!isFree(ctx, ring, { pad: 0.5 })) return false
  ctx.out.wonders.push({ p: at, r, kind: 'circle' })
  addBuilding(ctx, rect(at, axis, 5, 2), 'magic')
  ctx.occ.add(ring)
  return true
}
