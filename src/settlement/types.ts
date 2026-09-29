import type { CityFunction, FeatureId } from './features'
import type { P, Poly } from './geom'

/** 规模：决定地图范围、街区数、是否设防 */
export type SettlementSize = 'hamlet' | 'village' | 'town' | 'city'

/**
 * 文明设定：决定聚落"长成什么样"（布局规则、建筑尺度、街区与地标种类）。
 * 与绘图风格正交——同一座城可以画成羊皮纸，也可以画成彩绘。
 */
export type Culture = 'western' | 'eastern' | 'wa' | 'islamic'

/** 奇幻程度：0 写实；1 奇幻（法师塔、魔法阵 / 宗门、仙阁）；2 高魔（再加浮空岛、灵脉等奇观） */
export type Magic = 0 | 1 | 2

export type WallMode = 'auto' | 'none' | 'palisade' | 'stone'

/**
 * 布局由两个连续参数决定（与文明、奇幻、功效都无关）：
 * regularity 规整度：0 有机生长，1 完全规整；
 * radial 放射度：规整的那部分是方格（0）还是环形放射（1），中间是两者融合。
 * 界面上是一个三角形：有机 / 方格 / 放射三个角，点的位置就是三者的比例。
 */
export const LAYOUT_DEFAULT = { regularity: 0.2, radial: 0.3 }

export interface SettlementParams {
  seed: string
  /** 目标人口（连续）；规模档位 size 由它推出（见 scale.ts），不单独设置 */
  population: number
  size: SettlementSize
  culture: Culture
  magic: Magic
  walls: WallMode
  /** 规整度 0 ~ 1：0 有机生长，1 完全规整（见 LAYOUT_DEFAULT） */
  regularity: number
  /** 放射度 0 ~ 1：规整部分是方格（0）还是环形放射（1） */
  radial: number
  /** 副中心离主城多远 0 ~ 1：0 与主城连成一片，1 是隔着田野、有路相连的卫星城 */
  spread: number
  /** 城市形制：有机生长，或里坊、营寨城、方格新城、麦地那、城下町这类规划（见 plans/） */
  plan?: PlanId
  /** 规划强度 0 ~ 1：规划区住得下的人口占比（0 纯有机，1 整城按规划铺开） */
  planStrength?: number
  /** 都城（一国之都）：有皇宫、王宫、御所这类宫殿 */
  capital?: boolean
  /** 城市功效：改变要素的默认数量与城墙样式（布局由 regularity / radial 决定） */
  function: CityFunction
  /** 各要素的手动数量（缺省 / null 表示自动推算，见 features.ts） */
  counts: Partial<Record<FeatureId, number | null>>
  /** 河流穿城 */
  river: boolean
  /** 临海（带港口） */
  coast: boolean
  /** 依山：地图一侧有山 */
  hills: boolean
  /** 地形起伏 0 ~ 1 */
  relief: number
  /** 城外农田 */
  farms: boolean
  /** 农田范围 0 ~ 1：0 只在城边一圈，1 铺得很远 */
  farmland: number
  /** 城墙的曲折度 0 ~ 1：0 是一圈平顺的墙，1 贴着片区之间的街曲曲折折地走 */
  wallBend: number
  /** 海所在方向、河流来向、山所在方向（弧度）；NaN 表示随机 */
  coastDir: number
  riverDir: number
  hillDir: number
  /**
   * 地形种子：不填（空串）时地形由种子与文明定；填了地形只看它，换种子、换文明时山、河、海岸都不变
   *（"固定地形"的随机就是把当前的地形钉在这里，见 terrain.ts 的 terrainKey）
   */
  terrainSeed?: string
  /** 从世界地图继承时的名字（为空则随机取名） */
  name?: string
  nameZh?: string
  nameJa?: string
  /** 继承自世界地图的环境（影响植被与农田） */
  climate?: SettlementClimate
  /** 画幅至少这么大（米，取整到 20）：成长动画的各帧共用一个画幅，城在原地长大。不存档、不进地址 */
  minExtent?: [number, number]
  /**
   * 规划按多少人口定（缺省为现在的人口）：规划区、宫城的大小，形制里的集市、墓地数量。
   * 成长动画传最终的人口——规划城是一开始就按全城划好、再慢慢住满的，各帧的规划不随人口伸缩。不存档、不进地址
   */
  planPop?: number
}

export interface SettlementClimate {
  /** 年均温 °C */
  temp: number
  /** 年降水 mm */
  rain: number
  /** 群系编号（gen/types 的 Biome） */
  biome: number
}

export const DEFAULT_SETTLEMENT: SettlementParams = {
  seed: 'thornwick',
  population: 4000,
  size: 'town',
  culture: 'western',
  magic: 0,
  walls: 'auto',
  regularity: LAYOUT_DEFAULT.regularity,
  radial: LAYOUT_DEFAULT.radial,
  spread: 0.15,
  plan: 'organic',
  planStrength: 0.6,
  capital: false,
  function: 'balanced',
  counts: {},
  river: true,
  coast: false,
  hills: false,
  relief: 0.4,
  farms: true,
  farmland: 0.4,
  wallBend: 0.3,
  coastDir: NaN,
  riverDir: NaN,
  hillDir: NaN,
  terrainSeed: '',
}

/** 街区（片区）功能 */
export type WardType =
  | 'plaza' // 中心广场 / 市
  | 'market' // 商业
  | 'temple' // 宗教（大教堂 / 寺庙）
  | 'castle' // 城堡 / 衙署宫城
  | 'noble' // 贵族宅邸（带院墙与花园）
  | 'merchant' // 富商
  | 'craft' // 工匠
  | 'common' // 平民
  | 'slum' // 贫民
  | 'harbor' // 港区
  | 'park' // 公园 / 园林
  | 'cemetery' // 墓地
  | 'magic' // 奇观：法师塔区 / 宗门
  | 'barracks' // 兵营与校场
  | 'guild' // 行会大厅
  | 'exchange' // 交易所
  | 'warehouse' // 货栈
  | 'observatory' // 观星台
  | 'suburb' // 城外沿路的郊区
  | 'farm' // 农田
  | 'wild' // 荒地 / 林地
  | 'water'

export const WARD_NAMES: Record<WardType, string> = {
  plaza: '广场',
  market: '市集',
  temple: '宗教区',
  castle: '城堡',
  noble: '贵族区',
  merchant: '商人区',
  craft: '工匠区',
  common: '民居',
  slum: '贫民窟',
  harbor: '港区',
  park: '公园',
  cemetery: '墓地',
  magic: '奇观',
  barracks: '兵营',
  guild: '行会',
  exchange: '交易所',
  warehouse: '货栈',
  observatory: '观星台',
  suburb: '城郊',
  farm: '农田',
  wild: '野地',
  water: '水域',
}

/**
 * civic：公共设施（酒馆、戏台、讲台、看台、酒庄主屋），屋顶用醒目的颜色与普通民居区分；
 * torii：鸟居（朱红的一道横梁，画在树冠之上，千本鸟居一座挨一座）
 */
export type BuildingKind = 'house' | 'large' | 'temple' | 'keep' | 'tower' | 'hall' | 'shed' | 'pagoda' | 'magic' | 'civic' | 'torii'

/**
 * 地标的规模档：micro 占一户宅地（路边的祠、神龛、口袋花园、塔楼民居），small 占片区的一角、四周照常是人家
 *（村社、堂区教堂、街心小园、设防庄园），standard 占一整块片区，grand 由相邻几块片区合成（大社、朝圣大教堂、大园囿、同心城、离宫）
 */
export type Tier = 'micro' | 'small' | 'standard' | 'grand'

export interface Building {
  poly: Poly
  kind: BuildingKind
  /** 0 ~ 1 的随机色调（彩绘风格里给屋顶一点变化） */
  tone: number
  /** 屋脊方向（弧度） */
  ridge: number
  /** 层数（民居按片区密度：疏的一两层，密的三四层） */
  floors?: number
  /** 住户数（民居）：多层的楼房一栋住几户 */
  units?: number
  /** 用途（悬停说明的中文键）：祠、鸟居、路边十字架这类由类型推不出的，盖的时候写明 */
  role?: string
}

/** 片区的建筑密度档：疏（新辟的外围、带园子的独院）、中、密（老城、干道两侧的多层连排） */
export type Density = 'low' | 'mid' | 'high'

export interface Road {
  line: P[]
  /** 路面宽（米） */
  width: number
  kind: 'highway' | 'main' | 'street' | 'lane' | 'path' | 'stair'
  name?: Tri
}

export interface Crossing {
  a: P
  b: P
  width: number
  kind: 'bridge' | 'ferry' | 'ford'
  /** 神桥：社前朱漆的拱桥 */
  sacred?: boolean
}

export interface Wall {
  /** 闭合环 */
  loop: P[]
  /** 按段是否画出（临水处为天然屏障，断开） */
  solid: boolean[]
  towers: P[]
  gates: { p: P; angle: number }[]
  kind: 'stone' | 'palisade'
  thickness: number
  /** 护城河：墙外一圈水带（临河、上坡、瓮城处断开），城门处架桥 */
  moat?: { runs: P[][]; width: number; bridges: { p: P; angle: number }[] }
}

import type { PlanId } from './plans/types'

/** 同一个名字的中文、英文、日文写法 */
export type { Tri } from '../gen/naming'
import type { Tri } from '../gen/naming'

export interface Ward {
  poly: Poly
  type: WardType
  /** 片区名（只给部分片区） */
  name?: Tri
  /** 是否在城墙内 */
  inner: boolean
  /** 建筑密度档（城区的民居、商业、工匠片区） */
  density?: Density
  /** 地标片区的规模档（合成的大社、同心城……是 grand） */
  tier?: Tier
  /** 零散农家的片区（成长史里村子的外围）：农家散在田间，地面还是田野，不铺城区的地面 */
  rural?: boolean
}

export interface Field {
  poly: Poly
  /** 垄沟方向 */
  angle: number
  /** garden：城边的菜园（小畦）；meadow：河滩上割草的草甸 */
  kind: 'crop' | 'pasture' | 'orchard' | 'paddy' | 'vineyard' | 'garden' | 'meadow'
  tone: number
}

/**
 * 园林小品：pond 池水与水渠、isle 池中的岛与苔岛、bed 花坛（绿篱镶边）、
 * gravel 耙纹白砂（angle 为耙纹方向）、rock 置石与假山石
 */
export interface ParkPart {
  poly: Poly
  kind: 'pond' | 'isle' | 'bed' | 'gravel' | 'rock'
  angle?: number
}

export interface Tree {
  p: P
  r: number
}

export interface MapLabel {
  text: Tri
  /** 第二行 / 原文名 */
  sub?: Tri
  p: P
  angle: number
  /** landmark：城堡、大教堂、市场这类大地标；poi：酒馆、戏台、城门这类小地点（小字，像真实地图的兴趣点） */
  kind: 'title' | 'district' | 'street' | 'river' | 'landmark' | 'poi' | 'water' | 'hill'
  /** 沿路径排布的文字 */
  path?: P[]
  weight: number
}

/** 三种语言写法相同的文字（海拔这类） */
export const same = (s: string): Tri => ({ zh: s, en: s, ja: s })

export interface Landmark {
  p: P
  /** 井、喷泉、雕像这类不起名 */
  name?: Tri
  /** 按大地标标注（与片区名同级）：大社、离宫、山上的修道院这类不在 castle / temple 里的名所 */
  major?: boolean
  kind:
    | 'castle'
    | 'temple'
    | 'market'
    | 'harbor'
    | 'magic'
    | 'gate'
    | 'well'
    | 'ferry'
    | 'shrine'
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
    | 'fountain'
    | 'statue'
    | 'mill'
    | 'windmill'
    | 'hospital'
    | 'school'
    | 'gallows'
    | 'kiln'
    | 'quarry'
    | 'lighthouse'
}

export interface Terrain {
  /** 格数与每格米数 */
  W: number
  H: number
  cell: number
  /** 地面高程（米），海面 0 */
  height: Float32Array
  /** 到水体的有向距离（米），水中为负 */
  water: Float32Array
}

export interface Settlement {
  params: SettlementParams
  /** 聚落名：原文（英文）、中文、日文 */
  name: string
  nameZh: string
  nameJa: string
  /** 地图范围（米） */
  width: number
  height: number
  terrain: Terrain
  /** 河流中线与每点半宽 */
  river: { line: P[]; hw: number[]; name: Tri } | null
  /** 海的位置（有海时） */
  sea: { name: Tri; p: P } | null
  roads: Road[]
  crossings: Crossing[]
  walls: Wall[]
  wards: Ward[]
  /** 街区（去掉街道后的地块集合，用来画"街区底色"） */
  blocks: Poly[]
  buildings: Building[]
  /** 院墙（闭合环） */
  enclosures: Poly[]
  /** 广场、市集等铺装地面 */
  plazas: Poly[]
  /** 园地、公园、墓地的绿地 */
  greens: { poly: Poly; kind: 'park' | 'garden' | 'cemetery' | 'courtyard' }[]
  /** 园林小品（见 parks.ts） */
  parkParts: ParkPart[]
  fields: Field[]
  trees: Tree[]
  /** 码头、栈桥 */
  piers: Poly[]
  /** 停泊的船（中心、船头朝向、船长） */
  boats: { p: P; angle: number; len: number }[]
  /** 奇观（魔法阵、灵池等） */
  wonders: { p: P; r: number; kind: 'circle' | 'spring' | 'isle' | 'leyline'; line?: P[] }[]
  landmarks: Landmark[]
  labels: MapLabel[]
  /** houses：民居栋数；households：住户数（多层楼一栋几户）；population = households × 每户人数（东方 4.2、西式 5.5） */
  stats: { buildings: number; houses: number; households: number; population: number; area: number; ms: number }
}
