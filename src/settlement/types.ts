import type { P, Poly } from './geom'

/** 规模：决定地图范围、街区数、是否设防 */
export type SettlementSize = 'hamlet' | 'village' | 'town' | 'city'

/**
 * 文明设定：决定聚落"长成什么样"（布局规则、建筑尺度、街区与地标种类）。
 * 与绘图风格正交——同一座城可以画成羊皮纸，也可以画成彩绘。
 */
export type Culture = 'western' | 'eastern'

/** 奇幻程度：0 写实；1 奇幻（法师塔、魔法阵 / 宗门、仙阁）；2 高魔（再加浮空岛、灵脉等奇观） */
export type Magic = 0 | 1 | 2

export type WallMode = 'auto' | 'none' | 'palisade' | 'stone'

export interface SettlementParams {
  seed: string
  size: SettlementSize
  culture: Culture
  magic: Magic
  walls: WallMode
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
  /** 海所在方向、河流来向、山所在方向（弧度）；NaN 表示随机 */
  coastDir: number
  riverDir: number
  hillDir: number
  /** 从世界地图继承时的名字（为空则随机取名） */
  name?: string
  nameZh?: string
  /** 继承自世界地图的环境（影响植被与农田） */
  climate?: SettlementClimate
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
  size: 'town',
  culture: 'western',
  magic: 0,
  walls: 'auto',
  river: true,
  coast: false,
  hills: false,
  relief: 0.4,
  farms: true,
  coastDir: NaN,
  riverDir: NaN,
  hillDir: NaN,
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
  suburb: '城郊',
  farm: '农田',
  wild: '野地',
  water: '水域',
}

export type BuildingKind = 'house' | 'large' | 'temple' | 'keep' | 'tower' | 'hall' | 'shed' | 'pagoda' | 'magic'

export interface Building {
  poly: Poly
  kind: BuildingKind
  /** 0 ~ 1 的随机色调（彩绘风格里给屋顶一点变化） */
  tone: number
  /** 屋脊方向（弧度） */
  ridge: number
}

export interface Road {
  line: P[]
  /** 路面宽（米） */
  width: number
  kind: 'highway' | 'main' | 'street' | 'lane' | 'path' | 'stair'
  name?: string
}

export interface Crossing {
  a: P
  b: P
  width: number
  kind: 'bridge' | 'ferry' | 'ford'
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
}

export interface Ward {
  poly: Poly
  type: WardType
  /** 片区名（只给部分片区） */
  name?: string
  /** 是否在城墙内 */
  inner: boolean
}

export interface Field {
  poly: Poly
  /** 垄沟方向 */
  angle: number
  kind: 'crop' | 'pasture' | 'orchard' | 'paddy' | 'vineyard'
  tone: number
}

export interface Tree {
  p: P
  r: number
}

export interface MapLabel {
  text: string
  /** 第二行 / 原文名 */
  sub?: string
  p: P
  angle: number
  kind: 'title' | 'district' | 'street' | 'river' | 'landmark' | 'water' | 'hill'
  /** 沿路径排布的文字 */
  path?: P[]
  weight: number
}

export interface Landmark {
  p: P
  name: string
  kind: 'castle' | 'temple' | 'market' | 'harbor' | 'magic' | 'gate' | 'well' | 'ferry' | 'shrine'
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
  name: string
  nameZh: string
  /** 地图范围（米） */
  width: number
  height: number
  terrain: Terrain
  /** 河流中线与每点半宽 */
  river: { line: P[]; hw: number[]; name: string } | null
  /** 海的位置（有海时） */
  sea: { name: string; p: P } | null
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
  stats: { buildings: number; population: number; area: number; ms: number }
}
