/** 视频里通用的缓动与时间工具 */

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
/** sec 落在 [a, b] 里的进度（0~1） */
export const span = (sec: number, a: number, b: number) => clamp01((sec - a) / (b - a))
/** 缓入缓出（二次） */
export const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t))
/** 缓出（三次） */
export const easeOut = (t: number) => 1 - (1 - t) ** 3
/** 缓入（三次） */
export const easeIn = (t: number) => t * t * t

/** 确定性的伪随机数（0~1）：同样的参数总是同样的值，逐帧录制可复现 */
export function rand(a: number, b = 0) {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return h - Math.floor(h)
}
