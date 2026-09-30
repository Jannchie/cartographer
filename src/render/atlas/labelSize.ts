/**
 * 地图注记的字号体系（世界图与聚落图共用）。
 *
 * 字号以屏幕 CSS 像素为单位：一套相邻两级约差 1.15 倍的阶梯，每类注记落在某一级，或按规模在两级之间插值。
 * 录入显示列表时换算成页面像素（除以显示列表的 labelK，见 DisplayList.labelK）。
 * 查看器里注记在屏幕上最大就是这个字号；缩小时最多跟着地图缩到 LABEL_SHRINK 倍，再缩小就保持不变，
 * 注记之间按排布时的优先顺序让位（见 DisplayList.renderLabels）。层级比例在任何缩放下都不变。
 */
import { clamp } from '../../gen/util'

export const TYPE_SCALE = [13, 15, 17, 19.5, 22.5, 26, 30, 34.5, 40] as const

/** 阶梯上第 t 级的字号；t 可带小数，两级之间按比例（几何）插值 */
export function typeSize(t: number): number {
  const T = TYPE_SCALE
  const c = clamp(t, 0, T.length - 1)
  const i = Math.min(T.length - 2, Math.floor(c))
  return T[i] * (T[i + 1] / T[i]) ** (c - i)
}

/** v 在 [lo, hi] 之间按对数取 0–1（面积、人口这类跨几个数量级的量换成字号级别用） */
export function logT(v: number, lo: number, hi: number): number {
  if (!(v > lo)) return 0
  return Math.min(1, Math.log(v / lo) / Math.log(hi / lo))
}

/** 注记在查看器里最多跟着地图缩到设计字号的几倍 */
export const LABEL_SHRINK = 0.85

/** 中日文字号系数：汉字、假名填满字身，同字号看着比拉丁字母（含全大写）大，略缩小以取得同样的视觉分量 */
export const CJK_SCALE = 0.94

/**
 * 屏幕上的最小字号（CSS 像素）：阶梯最低一级缩到最小时的字号，阶梯上的注记不会低于它；
 * 设计字号在阶梯以下的（附注、测深数字）单独放大到它
 */
export const MIN_LABEL_PX = TYPE_SCALE[0] * CJK_SCALE * LABEL_SHRINK

/** 第 t 级在某种语言下的页面字号：设计字号（中日文按 CJK_SCALE 略缩）÷ 显示列表的 labelK */
export function labelPx(t: number, cjk: boolean, labelK: number): number {
  return (typeSize(t) * (cjk ? CJK_SCALE : 1)) / labelK
}

/** 晕边（描边）宽度与字号之比 */
export const HALO_RATIO = 0.23

/** 碰撞框四周的留白与字号之比 */
export const LABEL_PAD = 0.2

/** 逐字排布（沿曲线、沿路径）时一个字的碰撞半径与字号之比（不含留白） */
export const GLYPH_R = 0.6
