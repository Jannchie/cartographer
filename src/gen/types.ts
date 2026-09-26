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
}

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
  kind: 'continent' | 'island' | 'ocean' | 'sea' | 'lake' | 'range' | 'city' | 'capital' | 'basin' | 'desert' | 'forest'
  name: string
  x: number
  y: number
  /** 文字旋转角（弧度） */
  angle: number
  /** 重要度，越大越优先放置 */
  weight: number
  /** 沿轴向的跨度（格） */
  span: number
}

export interface River {
  /** 交替存储 x, y（格坐标，可为小数） */
  points: Float32Array
  /** 每个点的流量 */
  flow: Float32Array
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
  worldName: string
  /** 每格代表的公里数 */
  kmPerCell: number
  stats: { land: number; peak: number; trench: number; lakes: number; rivers: number; ms: number }
}
