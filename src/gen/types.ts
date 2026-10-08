import type { Area } from './areas'
import type { EarthRes } from './earth/real'
import { regionHeight, regionProjection, type RegionId } from './earth/region'
export interface WorldParams {
  seed: string
  width: number
  height: number
  /** 陆地占比 0.15 ~ 0.6 */
  landRatio: number
  /** 板块数 */
  plates: number
  /** 山脉强度 0 ~ 2 */
  mountains: number
  /** 侵蚀强度 0 ~ 2 */
  erosion: number
  /** 降水倍率 0.3 ~ 2 */
  rainfall: number
  /** 气温偏移（°C） */
  temperature: number
  /** 纬度范围：地图上缘纬度 / 下缘纬度 */
  latNorth: number
  latSouth: number
  /** 海岸破碎度 0 ~ 1 */
  coastRoughness: number
  /**
   * 全球图：横向覆盖 360° 经度（等经纬度格子，比例尺按赤道），高度由纬度范围定（见 globeHeight）。
   * 不开时地图宽 6000 公里，经度按中纬度换算
   */
  globe?: boolean
  /** 地球底图：大陆与海深取自真实地球（ETOPO1），只在全球图下有效；陆地比例、板块数这些不再起作用 */
  earth?: boolean
  /** 真实地球：在地球底图之上，气候、群系、河湖与自然地物名称也取自真实数据，不再模拟；没有城市、国家与道路 */
  earthReal?: boolean
  /** 区域图：真实地球模板只铺一块区域（地图投影见 gen/earth/region.ts），不是全球图 */
  region?: RegionId
  /** 真实地球数据的精度：15m 为 0.25°，5m 为 5′ */
  earthRes?: EarthRes
  /** 命名世界观（auto 按种子挑） */
  naming: NamingStyle
  /**
   * 生成聚落与道路（城镇、国家、道路与航线）。关掉时只生成地形、气候、水系与自然地物名称——
   * 先定地形、再放聚落的两阶段流程；地面不受影响，开关之间不重算地形
   */
  settlements?: boolean
  /** 地形方案：同一种子下换一套造山、侵蚀与气候的随机细节（0 为种子本身的方案）。有草图时即"同一份规划、另一种细节" */
  terrainVariant?: number
  /** 聚落方案：同一片地面上换一套城镇选址与国界（0 为种子本身的方案） */
  placeVariant?: number
}

/** 只塑造地形形状的参数：定稿后不再起作用（纬度、降水、气温仍影响气候） */
export const SHAPE_PARAMS = ['landRatio', 'plates', 'mountains', 'coastRoughness', 'erosion'] as const

/** 区域图的宽度（公里）；全球图按赤道一周 */
export const MAP_KM = 6000
export const EQUATOR_KM = 40075

/**
 * 晕渲、3D 高度换算用的每格公里数（垂直夸张）：全球图每格几十公里，按真实坡度晕渲几乎看不出起伏。
 * 像小比例尺地图那样放大起伏，但不放到区域图那么强（那样整张世界图显得过于崎岖）：
 * 每格公里数超出区域图的部分只按四次方根计入（全球图约放大 4 倍）；区域图就是真实比例
 */
export const reliefKm = (world: Pick<World, 'W' | 'kmPerCell'>) => {
  const ref = MAP_KM / world.W
  return world.kmPerCell <= ref ? world.kmPerCell : ref * Math.sqrt(Math.sqrt(world.kmPerCell / ref))
}

/** 是不是全球图（地球底图总是全球图；区域图不是） */
export const isGlobe = (p: Pick<WorldParams, 'globe' | 'earth' | 'region'>) => !p.region && !!(p.globe || p.earth)

/** 全球图的高度：宽度对应 360° 经度，高度对应纬度范围（等经纬度格子）；不是全球图时宽高比 1.6 */
export function globeHeight(p: Pick<WorldParams, 'width' | 'latNorth' | 'latSouth' | 'globe' | 'earth' | 'region'>) {
  return isGlobe(p) ? Math.max(64, Math.round((p.width * Math.abs(p.latNorth - p.latSouth)) / 360)) : Math.round(p.width * 0.625)
}

/** 参数里可以推导的部分就地补齐：地球底图总是全球图；高度由宽度（全球图再加纬度范围）定。改动 width、纬度、globe、earth 之后调用 */
export function normalizeParams(p: WorldParams) {
  if (p.region) {
    // 区域图：真实数据、投影铺满区域；纬度范围取图框中线的上下两端（模型补气温时用）
    p.earthReal = p.earth = true
    p.globe = false
    p.height = regionHeight(p)
    const proj = regionProjection(p)!
    p.latNorth = Math.round(proj.toLonLat(p.width / 2, 0)[1])
    p.latSouth = Math.round(proj.toLonLat(p.width / 2, p.height - 1)[1])
    return
  }
  if (p.earthReal) p.earth = true
  if (p.earth) p.globe = true
  p.height = globeHeight(p)
}

export type NamingStyle = 'auto' | 'fantasy' | 'epic' | 'eastern' | 'wa'

export const DEFAULT_PARAMS: WorldParams = {
  seed: 'aurelia',
  width: 1024,
  height: 640,
  landRatio: 0.36,
  plates: 14,
  mountains: 1,
  erosion: 1,
  rainfall: 1,
  temperature: 0,
  latNorth: 64,
  latSouth: 14,
  coastRoughness: 0.55,
  globe: false,
  earth: false,
  earthReal: false,
  earthRes: '15m',
  naming: 'auto',
  region: undefined,
  settlements: true,
  terrainVariant: 0,
  placeVariant: 0,
}

export const Biome = {
  Ocean: 0,
  Lake: 1,
  IceCap: 2,
  Tundra: 3,
  Taiga: 4,
  TemperateForest: 5,
  TemperateRainforest: 6,
  Grassland: 7,
  Shrubland: 8,
  ColdDesert: 9,
  HotDesert: 10,
  Savanna: 11,
  TropicalSeasonalForest: 12,
  TropicalRainforest: 13,
  Alpine: 14,
  Beach: 15,
  Wetland: 16,
  SaltFlat: 17,
} as const
export type Biome = (typeof Biome)[keyof typeof Biome]

export const BIOME_NAMES: Record<number, string> = {
  [Biome.Ocean]: '海洋',
  [Biome.Lake]: '湖泊',
  [Biome.IceCap]: '冰原',
  [Biome.Tundra]: '苔原',
  [Biome.Taiga]: '针叶林',
  [Biome.TemperateForest]: '温带阔叶林',
  [Biome.TemperateRainforest]: '温带雨林',
  [Biome.Grassland]: '草原',
  [Biome.Shrubland]: '灌丛',
  [Biome.ColdDesert]: '寒漠',
  [Biome.HotDesert]: '热沙漠',
  [Biome.Savanna]: '稀树草原',
  [Biome.TropicalSeasonalForest]: '热带季雨林',
  [Biome.TropicalRainforest]: '热带雨林',
  [Biome.Alpine]: '高山裸岩',
  [Biome.Beach]: '海滩',
  [Biome.Wetland]: '湿地',
  [Biome.SaltFlat]: '盐沼',
}

export interface Label {
  kind: 'continent' | 'island' | 'ocean' | 'sea' | 'lake' | 'range' | 'city' | 'capital' | 'basin' | 'desert' | 'forest' | 'river'
  name: string
  /** 中文名 */
  zh: string
  /** 日文名 */
  ja?: string
  x: number
  y: number
  /** 文字旋转角（弧度） */
  angle: number
  /** 重要度，越大越优先放置 */
  weight: number
  /** 沿轴向的跨度（格） */
  span: number
  /** 沿线排字的路径（交替存储的格坐标，河流注记用） */
  path?: number[]
  /** 在全息沙盘上带引线标注（区域图指定；没有任何注记指定时按规模取前几座城市） */
  anno?: boolean
}

/** 实测的山峰（区域图）：格坐标与海拔（公里）；地形格是一片的平均高程，山顶比实测低 */
export interface Peak {
  name: string
  zh: string
  ja: string
  x: number
  y: number
  elev: number
}

/** 城镇类地点（聚落阶段生成、聚落方案替换的那一类） */
export const isSettlement = (l: Pick<Label, 'kind'>) => l.kind === 'city' || l.kind === 'capital'

export interface Realm {
  name: string
  zh: string
  ja?: string
  /** 调色板序号 0~7（相邻国家不同） */
  color: number
  /** 国名标注位置（格） */
  x: number
  y: number
  /** 都城在 labels 中的下标 */
  capital: number
  /** 不单独标注名称（直辖市、特别行政区：城市注记已经写了同一个名字） */
  noLabel?: boolean
  area: number
  /** 标注点到国界/海岸的距离（格），用于决定国名字号 */
  room: number
}

/** 道路：交替存储的 x, y（格坐标，已平滑）；major 干道、minor 支线、sea 航线 */
export interface Road {
  kind: 'major' | 'minor' | 'sea'
  pts: number[]
}

export interface River {
  /** 交替存储 x, y（格坐标，可为小数） */
  points: Float32Array
  /** 每个点的流量 */
  flow: Float32Array
}

/** 规划草图里的一条山脉：沿折线隆起，高度、宽度可调，细部仍由噪声与侵蚀生成 */
export interface SketchRange {
  /** 交替存储的 x, y（格坐标） */
  pts: number[]
  /** 高度倍率 0.2 ~ 2（1 约与板块汇聚边界的造山带相当） */
  height: number
  /** 山体半宽（km） */
  width: number
}

/**
 * 从零规划的草图：用户指定大陆轮廓与山脉走向，生成时取代随机的大陆噪声与板块造山；
 * 海岸细节、丘陵、盆地、侵蚀与水系仍按种子随机生成。
 */
export interface WorldSketch {
  /** 陆地意图 0~1（W×H），0.5 为海岸线 */
  land: Float32Array
  ranges: SketchRange[]
}

/**
 * 用户对生成结果的编辑。所有增量图都是 W×H（与 params.width/height 对应）。
 * 生成流程会把它们叠加进对应阶段，于是改完参数重新生成时编辑不会丢。
 */
export interface WorldEdits {
  /** 地形意图：侵蚀前叠加的高度增量（km）。侵蚀与水系会顺着新地形重新演算 */
  terrain?: Float32Array
  /** 气温偏移（°C） */
  temp?: Float32Array
  /** 降水倍率的自然对数（0 为不变，ln2 为翻倍） */
  rain?: Float32Array
  /** 地点：编辑后的完整列表，替换生成的标注 */
  labels?: Label[]
  /** 大洲区域：每格所属大洲序号，-1 为不属于任何大洲 */
  regions?: Int16Array
  /** 大洲名称（下标即区域序号） */
  regionMeta?: { name: string; zh: string; ja?: string }[]
  /** 世界名（编辑后固定，不随重算变化） */
  worldName?: string
  worldNameZh?: string
  worldNameJa?: string
  /** 地形编辑的版本号：变了才需要重算侵蚀 */
  terrainRev?: number
  /** 从零规划的草图（有它时大陆形状与山脉走向由草图决定，陆地比例不再起作用） */
  sketch?: WorldSketch
  /** 草图的版本号：变了才需要重算造山 */
  sketchRev?: number
  /**
   * 定稿的地形：侵蚀结束时（河道下切之前）的高度与盆地。有它时地形不再由种子、参数与草图生成，
   * 地形画笔直接改在这份高度上；气候、水系、群系与聚落仍从它往下演算
   */
  frozen?: {
    elev: Float32Array
    basins: { x: number; y: number; r: number }[]
    /** 定稿时的种子与地形方案：气候扰动、水系、地名与聚落的随机数流从此固定，之后改种子也不影响这个世界 */
    seed: string
    terrainVariant?: number
  }
  /** 定稿版本号（每次定稿换一个） */
  frozenRev?: number
  /** 定稿前的地形画笔（已烘焙进 frozen）：回到规划时恢复 */
  planTerrain?: Float32Array
  /** 定稿时的国名，按都城原名对应：重算政区后国名不变 */
  realmNames?: Record<string, { name: string; zh: string; ja?: string }>
  /** 有名字的区域（区域视图里改过就存完整的列表，替换自动推断的；见 gen/areas.ts）。不影响地形，不发给生成线程 */
  areas?: Area[]
}

/** 行政界线（格坐标）：国界只画陆地上的一段，海岸不算 */
export interface AdminBorder {
  kind: 'national' | 'province' | 'prefecture'
  pts: number[]
}

/** 真实行政区划（区域图才有）：省级行政区记在 realm / realms 上，这里是地级单位与界线 */
export interface AdminLayer {
  borders: AdminBorder[]
  /** 海上断续线：每段一个多边形（格坐标） */
  claims: number[][]
  /** 每格所属的地级单位，-1 为不属于任何单位 */
  unit: Int16Array
  units: { name: string; zh: string; ja: string; full: string; province: number }[]
  /** 省级行政区的全称（realms 里是简称） */
  provinceFull: string[]
}

export interface World {
  params: WorldParams
  W: number
  H: number
  /** 海拔（km），海平面 0 */
  elevation: Float32Array
  /** 水面高度（km）：海洋 0，湖泊为湖面，其余 NaN */
  water: Float32Array
  temperature: Float32Array
  /** 年降水（mm） */
  precipitation: Float32Array
  /** 汇流量（归一化降水单位） */
  flow: Float32Array
  biome: Uint8Array
  /** 到海岸距离（格），海洋为负 */
  coastDist: Float32Array
  rivers: River[]
  labels: Label[]
  /** 每格所属国家，-1 为海洋 */
  realm: Int16Array
  realms: Realm[]
  /** 连通各城市的道路与跨海航线 */
  roads: Road[]
  worldName: string
  worldNameZh: string
  worldNameJa: string
  /** 每格代表的公里数 */
  kmPerCell: number
  /** 真实行政区划（只有区域图有） */
  admin?: AdminLayer
  /** 实测山峰（只有区域图有） */
  peaks?: Peak[]
  stats: { land: number; peak: number; trench: number; lakes: number; rivers: number; ms: number }
}
