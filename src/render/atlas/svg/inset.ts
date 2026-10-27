// 浏览器里图框模式的边距（见 AtlasViewer）：纸边与留白随舞台宽度收紧
import type { Inset } from './viewer'

/** 图框内框的边距：可以按舞台宽高现算（窄屏收紧纸边） */
export type InsetOf = Inset | ((w: number, h: number) => Inset)
/**
 * 图廓的松紧：舞台宽 800 以上为 1，越窄越紧，最紧 0.35。
 * 纸边与留白乘它，手机上不让一圈纸边吃掉半张图
 */
export const chromeFit = (w: number) => Math.min(1, Math.max(0.35, (w - 200) / 600))
/** 上边让出视图切换的纸签：宽屏纸签骑在图廓线上，窄屏整个挂在舞台里，要多让一点 */
export const chromeTop = (w: number) => Math.round(50 - 16 * chromeFit(w))
