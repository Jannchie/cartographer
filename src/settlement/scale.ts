import type { SizeCfg } from './ctx'
import { clamp, lerp } from '../gen/util'
import type { Culture, Density, SettlementParams, SettlementSize, WardType } from './types'
import { CULTURE_INFO } from './culture'

/**
 * 人口 → 规模：档位（决定布局分支，例如村落没有城墙、城市才有贫民窟）
 * 与连续的结构参数（片区数、片区尺度、街宽、地图范围）。
 * 锚点是各档实测的典型人口；锚点之间按对数人口插值，超过城市后按幂律继续放大。
 */
/**
 * 片区（街坊 / 田块）的尺度固定，与人口无关：同一个种子的片区网格在任何规模下都一样，
 * 聚落长大只是把外面的片区一块块并进城区（连续成长的前提）。
 */
export const PATCH = 90

interface Anchor {
  pop: number
  size: SettlementSize
  cfg: SizeCfg
  extent: [number, number]
}
const ANCHORS: Anchor[] = [
  { pop: 45, size: 'hamlet', cfg: { inner: 4, patch: PATCH, roads: [2, 2], lane: 3, main: 4.5, highway: 4 }, extent: [560, 400] },
  { pop: 130, size: 'village', cfg: { inner: 8, patch: PATCH, roads: [2, 3], lane: 3.5, main: 5.5, highway: 5 }, extent: [860, 600] },
  { pop: 3800, size: 'town', cfg: { inner: 16, patch: PATCH, roads: [3, 4], lane: 4.5, main: 7.5, highway: 6 }, extent: [1320, 920] },
  { pop: 13000, size: 'city', cfg: { inner: 34, patch: PATCH, roads: [4, 5], lane: 5, main: 10, highway: 8 }, extent: [2000, 1400] },
]

/**
 * 街宽随人口连续变宽，但取整到 0.5 米：人口小幅增减时宽度不变，已有的街坊与房子保持原样（连续成长）；
 * 村 → 镇 → 城之间也是一步步拓宽，没有突然的跳变。
 */
const q05 = (x: number) => Math.round(x * 2) / 2

/** 档位分界（相邻锚点的几何中点附近） */
const BOUNDS: [number, SettlementSize][] = [
  [80, 'hamlet'],
  [1500, 'village'],
  [7000, 'town'],
  [Infinity, 'city'],
]

export const POP_MIN = 20
export const POP_MAX = 60000
function sizeOf(pop: number): SettlementSize {
  return BOUNDS.find(([b]) => pop < b)![1]
}

/** 超过这个人口的城市叫大都会（只是名称，结构参数仍按幂律连续放大） */
const METROPOLIS = 30000
const SIZE_LABEL: Record<SettlementSize, string> = { hamlet: '小村', village: '村镇', town: '城镇', city: '城市' }
/** 人口对应的规模名称：与生成器用的档位一致 */
/** 村落级（小村、村庄），与城镇、城市相对 */
export const isVillage = (s: SettlementSize) => s === 'hamlet' || s === 'village'
export const sizeLabel = (pop: number) => (pop >= METROPOLIS ? '大都会' : SIZE_LABEL[sizeOf(pop)])

export function scaleOf(pop: number): { size: SettlementSize; cfg: SizeCfg; extent: [number, number] } {
  const p = clamp(pop, POP_MIN, POP_MAX)
  const size = sizeOf(p)
  const last = ANCHORS[ANCHORS.length - 1]
  if (p >= last.pop) {
    // 城市以上：片区数随人口的 0.78 次方增长，地图范围随片区数的平方根
    const k = p / last.pop
    const inner = Math.round(last.cfg.inner * Math.pow(k, 0.78))
    const g = Math.sqrt(inner / last.cfg.inner)
    const c = last.cfg
    return {
      size,
      cfg: { inner, patch: PATCH, roads: [c.roads[0] + Math.round(Math.log2(k)), c.roads[1] + Math.round(Math.log2(k))], lane: c.lane, main: q05(c.main * Math.pow(k, 0.12)), highway: c.highway },
      extent: [Math.round(last.extent[0] * g * 0.92), Math.round(last.extent[1] * g * 0.92)],
    }
  }
  let i = 0
  while (i < ANCHORS.length - 2 && p > ANCHORS[i + 1].pop) i++
  const a = ANCHORS[i]
  const b = ANCHORS[i + 1]
  const t = clamp(Math.log(p / a.pop) / Math.log(b.pop / a.pop), 0, 1)
  const ca = a.cfg
  const cb = b.cfg
  return {
    size,
    cfg: {
      inner: Math.max(3, Math.round(Math.exp(lerp(Math.log(ca.inner), Math.log(cb.inner), t)))),
      patch: PATCH,
      roads: [Math.round(lerp(ca.roads[0], cb.roads[0], t)), Math.round(lerp(ca.roads[1], cb.roads[1], t))],
      lane: q05(lerp(ca.lane, cb.lane, t)),
      main: q05(lerp(ca.main, cb.main, t)),
      highway: q05(lerp(ca.highway, cb.highway, t)),
    },
    extent: [Math.round(lerp(a.extent[0], b.extent[0], t)), Math.round(lerp(a.extent[1], b.extent[1], t))],
  }
}

/** 每户人数（见 culture.ts） */
export const perHousehold = (culture: Culture) => CULTURE_INFO[culture].perHousehold

/**
 * 每公顷城区（城内陆地）的民居户数：实测的经验值，含城外城郊与农舍，城区按它来定生长到多大。
 * - farm / street：村落的零散农家与连排街坊（街坊按城郊的密度，约为城里的七成，见 townShare）
 * - town：城镇、城市，相当稳定。伊斯兰的内院住宅与尽端巷和西式一样密；和风的町家比四合院密
 * - regular：规整时变稀的比例（东亚的院落之间空地多，按占用率部分盖时更明显）
 * - trade：商贸城的系数（宽街、仓栈只在西式的街坊里明显压低密度）
 */
const HOUSING: Record<Culture, { farm: number; street: number; town: number; regular: number; trade: number }> = {
  western: { farm: 4.5, street: 38, town: 38, regular: 0, trade: 0.85 },
  eastern: { farm: 8.5, street: 33, town: 33, regular: 0.1, trade: 1 },
  wa: { farm: 8.5, street: 33, town: 36, regular: 0.1, trade: 1 },
  islamic: { farm: 4.5, street: 38, town: 38, regular: 0, trade: 0.85 },
}
export function housesPerHa(p: Pick<SettlementParams, 'population' | 'culture' | 'function' | 'regularity'>) {
  const h = HOUSING[p.culture]
  if (isVillage(sizeOf(p.population))) {
    const s = townShare(p.population, 2 / 3)
    return h.farm * (1 - s) + h.street * 0.7 * s
  }
  return h.town * (1 - h.regular * p.regularity) * (p.function === 'fortress' ? 0.95 : p.function === 'trade' ? h.trade : 1)
}

/**
 * 片区盖满时每公顷（片区全面积）的住户数，按功能与密度档实测（scripts 里全部占用率为 1 时统计）。
 * 城区生长用的 housesPerHa 是全城平均（含广场、寺庙这些不住人的片区），占用率估算要的是单块片区盖满能住多少。
 */
const FULL: Record<Culture, Partial<Record<WardType, Record<Density, number>>>> = {
  western: {
    common: { low: 10, mid: 62, high: 154 },
    merchant: { low: 9, mid: 40, high: 92 },
    market: { low: 53, mid: 53, high: 102 },
    craft: { low: 7, mid: 39, high: 88 },
    slum: { low: 107, mid: 107, high: 107 },
    noble: { low: 6.5, mid: 6.5, high: 6.5 },
  },
  eastern: {
    common: { low: 11.5, mid: 29.5, high: 58 },
    merchant: { low: 11, mid: 37, high: 70 },
    market: { low: 41, mid: 41, high: 75 },
    craft: { low: 3, mid: 30, high: 75 },
    slum: { low: 109, mid: 109, high: 109 },
    noble: { low: 11, mid: 11, high: 11 },
  },
  // 町家：面宽窄、进深长的连排，比四合院密；武家屋敷大而疏
  wa: {
    common: { low: 25, mid: 42, high: 90 },
    merchant: { low: 11, mid: 28, high: 74 },
    market: { low: 25, mid: 25, high: 60 },
    craft: { low: 15, mid: 33, high: 65 },
    slum: { low: 95, mid: 95, high: 95 },
    noble: { low: 8, mid: 8, high: 8 },
  },
  // 内院住宅挤满街坊，只留尽端巷
  islamic: {
    common: { low: 13, mid: 57, high: 112 },
    merchant: { low: 10, mid: 42, high: 87 },
    // 集市是摊位与商队客栈，住户很少
    market: { low: 22, mid: 22, high: 22 },
    craft: { low: 12, mid: 43, high: 81 },
    slum: { low: 110, mid: 110, high: 110 },
    noble: { low: 11, mid: 11, high: 11 },
  },
}
export const fullPerHa = (culture: Culture, type: WardType, d: Density) => FULL[culture][type]?.[d] ?? FULL[culture].common![d]

/**
 * 片区的密度档。按三件事打分：
 * - age：片区加入城区时的累计户数 ÷ 现在的户数（0 是最早的老城，1 是刚辟的外围，>1 是城墙里预留的空地）；
 * - road：离对外干道多近（0 ~ 1），大路两侧的街坊更密；
 * - noise：平滑的位置噪声（0 ~ 1），同样远的地方有疏有密。
 * 密档要城市够大才有（小城镇的老街也就两层），疏档在任何城镇的外围都有。
 * 城市长大时老城的 age 变小，会从疏到中、从中到密一档档加密（翻建），但不会反过来。
 */
export function densityOf(pop: number, age: number, road: number, noise: number): Density {
  const s = (1 - Math.min(1.3, age)) * 0.85 + road * 0.3 + (noise - 0.5) * 0.55
  const big = clamp(Math.log(pop / 3000) / Math.log(4), 0, 1)
  if (s > 1.1 - 0.5 * big) return 'high'
  return s > 0.2 ? 'mid' : 'low'
}

/**
 * 村落里盖成连排街坊（而非零散农家）的片区占比：小村为 0，快到城镇（1500 人）时村心大多是街坊。
 * dc 是离村心的距离（按城区半径归一），越靠村心占比越高；传 2/3 得到全村的平均。
 */
export const townShare = (pop: number, dc: number) => clamp(villageT(pop) ** 2 * (1.5 - dc), 0, 1)

/** 村落大小的位置：150 人以下为 0，1500 人为 1（按对数） */
export const villageT = (pop: number) => clamp(Math.log(pop / 150) / Math.log(1500 / 150), 0, 1)

/** 旧参数（只有档位）换算成人口 */
export const POP_OF_SIZE: Record<SettlementSize, number> = { hamlet: 45, village: 300, town: 3800, city: 13000 }
