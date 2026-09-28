import type { Ctx } from '../ctx'
import type { P, Poly } from '../geom'
import type { FeatureId } from '../features'
import type { Tri, Ward, WardType } from '../types'

/**
 * 城市形制（规划）。聚落 = 规划核心 + 有机生长：
 * - 规划区在建城时一次定下（里坊、营寨城、新城的方格、城下町……），里面的片区是规划给的固定站点
 *   切出的方正街坊，街道、城门、功能分区都按规划；
 * - 规划区以外照旧有机生长（沿干道的关厢、城郊），与规划区在交界处由 Voronoi 自然过渡；
 * - 规划强度（0 ~ 1）决定规划区住得下多少人：0 是纯有机，1 是整座城都按规划铺开（规划的扩张），
 *   中间是"规划的老城 + 有机的外城"。规划区的站点按世界坐标定，人口变化时已有的街坊不动。
 *
 * 新增一种形制：在 plans/ 下写一个 CityPlan，登记到 plans/index.ts。
 */
export type PlanId = 'organic' | 'lifang' | 'castrum' | 'bastide' | 'medina' | 'jokamachi'

/** 规划区：中心就是主城心（第 0 个片区的站点），u / v 是规划方格的两条轴 */
export interface PlanZone {
  c: P
  /** 规划方格的朝向（u 轴的方向角，弧度；屏幕坐标，y 向下为南） */
  angle: number
  /** 局部坐标：(u, v) ↔ 地图坐标 */
  toUV(q: P): P
  fromUV(u: number, v: number): P
  /** 规划区的尺度（米）：按"规划强度 × 人口"需要的城区面积折成的半径 */
  R: number
  /**
   * 规划范围的中心相对城心的偏移（局部坐标，米）。临海时城心仍在海边（城是从海边建起来的），
   * 规划范围往背离海的一侧挪：朝海一侧只铺到海岸，缺的宽度补到岸上一侧，方城保持方形、向岸上扩展。
   * 不临海时是 (0, 0)。形制按自己的规则算出范围的大小，再以 shift 为中心摆放；街坊格点仍以城心为原点。
   */
  shift: P
  /** 规划区轮廓与判定 */
  poly: Poly
  contains(q: P): boolean
}

export interface PlanRoad {
  line: P[]
  /** 路面宽（米） */
  width: number
  kind: 'main' | 'street' | 'lane'
  /** 取个街名 */
  named?: boolean
}

/** 规划区里的一块片区（交给 assign 预定功能） */
export interface PlanLot {
  poly: Poly
  site: P
  /** 站点的局部坐标 */
  uv: P
  /** 预定的功能；不填交给通用选址（民居、商人、工匠……）。点名的片区即使城还没长到也会建起来 */
  type?: WardType
  /** 片区是否在城区里（规划区可能比现在的城区大，城墙里有空着的坊） */
  inner: boolean
  /** 都城的宫城由几块片区合成：同一座宫城的片区都标上（宫殿按合起来的地盘一次盖好） */
  palace?: boolean
}

export interface CityPlan {
  id: Exclude<PlanId, 'organic'>
  /**
   * 规划区的朝向（弧度，u 轴方向）。默认沿主城心的方格朝向；坐北朝南的形制（里坊、城下町）返回 0。
   */
  angle?(ctx: Ctx): number
  /** 规划区的尺度倍数：规划常比当时的城区大（长安的外郭里有大片空坊），默认 1 */
  scale?: number
  /** 规划城墙外挖护城河：true 总有、false 没有；不填按通用规则（东方与要塞总有，西式约三分之二） */
  moat?: boolean
  /** 城内主街（干道在城里的一段）的宽度（米）；不填用规模的默认宽度 */
  mainWidth?: number
  /** 主街种行道树；默认种 */
  avenueTrees?: boolean
  /** 这种形制里没有的通用要素（数量一律为 0），如麦地那没有角斗场、露天剧场 */
  exclude?: FeatureId[]
  /** 规划区轮廓（局部坐标由 z 给出；poly / contains 由框架按轮廓生成） */
  outline(ctx: Ctx, z: Omit<PlanZone, 'poly' | 'contains'>): Poly
  /**
   * 规划区里的片区站点（Voronoi 站点，按世界坐标定）。排成方格就得到方正的街坊；
   * 站点彼此相距至少十几米；落水的站点框架会丢掉；离城心 1 米以内的由城心片区代替。
   */
  sites(ctx: Ctx, z: PlanZone): P[]
  /** 规划的街道（大街、坊间街、十字街……），全部加入路网 */
  streets(ctx: Ctx, z: PlanZone): PlanRoad[]
  /**
   * 干道怎么出规划区：给出干道原本的出城方向（弧度），返回从城心到规划区边上的一条路（通常沿大街，终点就是城门），
   * 干道从终点接着按地形走到地图边。
   */
  exit(ctx: Ctx, z: PlanZone, dir: number): P[]
  /** 预定规划片区的功能（宫城、东西市、广场、寺院……）；其余交给通用选址 */
  assign?(ctx: Ctx, z: PlanZone, lots: PlanLot[]): void
  /** 片区名：返回名字用它，null 不取名，undefined 交给通用的取名 */
  districtName?(ctx: Ctx, ward: Ward, z: PlanZone): Tri | null | undefined
  /** 规划片区的填法；返回 false 用通用填法 */
  build?(ctx: Ctx, ward: Ward, block: Poly, z: PlanZone): boolean
  /**
   * 规划的城墙轮廓（有城墙时用它代替按生长修的墙，只修这一道）；null / 不实现用通用的（按生长修）；
   * 返回空数组表示这种形制没有城墙（城下町）。城堡自己的内墙、护城河在 build 里修（如城下町的 rampart）。
   */
  wall?(ctx: Ctx, z: PlanZone): P[] | null
  /** 不筑城墙时形制自带的门面（平安京只在南面有罗城与罗城门）；在盖片区之前修，房子会让开 */
  facade?(ctx: Ctx, z: PlanZone): void
}
