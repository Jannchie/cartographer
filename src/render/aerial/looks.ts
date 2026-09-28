/**
 * 成片观感（终合成里的调色参数）与画质档位。
 * 观感预设模仿几类胶片的性格：反差、饱和度、暗部/亮部偏色、褪色、光晕、颗粒；
 * 用户在预设基础上再用滑杆微调。
 */

export type RGB = readonly [number, number, number]

export interface Look {
  /** 曝光补偿（EV） */
  ev: number
  /** 色温：负值偏冷、正值偏暖（-1~1） */
  temp: number
  saturation: number
  contrast: number
  /** 褪色：抬黑位（0~0.15） */
  fade: number
  /** 泛光强度 */
  bloom: number
  /** 胶片光晕：高光边缘渗出的红橙色辉光（片基反射） */
  halation: number
  /** 色差：画面边缘的红蓝错位（像素） */
  aberration: number
  vignette: number
  grain: number
  /** 颗粒尺寸（像素） */
  grainSize: number
  /** 暗部 / 亮部偏色（乘在显示空间） */
  shadowTint: RGB
  highTint: RGB
  /** 黑白：0 彩色、1 全黑白；monoMix 为转灰时各通道权重（模拟滤镜） */
  mono: number
  monoMix: RGB
}

const BASE: Look = {
  ev: 0,
  temp: 0,
  saturation: 1.12,
  contrast: 1.22,
  fade: 0,
  bloom: 0.08,
  halation: 0,
  aberration: 0,
  vignette: 0.28,
  grain: 0.035,
  grainSize: 1,
  shadowTint: [0.97, 0.99, 1.04],
  highTint: [1.03, 1.0, 0.96],
  mono: 0,
  monoMix: [0.2126, 0.7152, 0.0722],
}

export const LOOKS: { id: string; name: string; look: Look }[] = [
  { id: 'natural', name: '自然', look: BASE },
  {
    id: 'neutral',
    name: '中性',
    look: { ...BASE, saturation: 1, contrast: 1, bloom: 0.04, vignette: 0, grain: 0, shadowTint: [1, 1, 1], highTint: [1, 1, 1] },
  },
  {
    // 暖调负片：宽容度高、反差柔、肤色暖，高光略带奶油色
    id: 'negative',
    name: '暖调负片',
    look: { ...BASE, ev: 0.15, temp: 0.25, saturation: 0.95, contrast: 1.05, fade: 0.025, halation: 0.12, grain: 0.055, grainSize: 1.3, shadowTint: [0.98, 1.0, 1.02], highTint: [1.05, 1.0, 0.92] },
  },
  {
    // 反转片：浓郁、硬朗，暗部偏品红冷色
    id: 'slide',
    name: '反转片',
    look: { ...BASE, ev: -0.1, saturation: 1.45, contrast: 1.4, vignette: 0.38, grain: 0.02, shadowTint: [1.0, 0.96, 1.06], highTint: [1.02, 1.0, 0.97] },
  },
  {
    // 灯光片（钨丝灯平衡）：日光下整体偏冷，高光外一圈红色光晕
    id: 'tungsten',
    name: '电影卷',
    look: { ...BASE, temp: -0.45, saturation: 1.05, contrast: 1.15, bloom: 0.12, halation: 0.6, aberration: 0.8, grain: 0.07, grainSize: 1.4, shadowTint: [0.94, 1.0, 1.06], highTint: [1.04, 0.99, 0.95] },
  },
  {
    // 过期胶片：黑位发灰、偏绿的暗部、偏暖的亮部，边角压暗
    id: 'faded',
    name: '褪色',
    look: { ...BASE, ev: 0.2, temp: 0.15, saturation: 0.78, contrast: 0.92, fade: 0.08, halation: 0.15, aberration: 1.2, vignette: 0.5, grain: 0.07, grainSize: 1.6, shadowTint: [0.95, 1.03, 0.98], highTint: [1.06, 1.0, 0.9] },
  },
  {
    // 黑白：加红滤镜（天空、水面压暗，陆地提亮），高反差、粗颗粒
    id: 'mono',
    name: '黑白',
    look: { ...BASE, saturation: 1, contrast: 1.35, vignette: 0.4, grain: 0.09, grainSize: 1.5, shadowTint: [1, 1, 1], highTint: [1, 1, 1], mono: 1, monoMix: [0.5, 0.42, 0.08] },
  },
  {
    // 棕褐调：黑白加暖色调色
    id: 'sepia',
    name: '棕褐',
    look: { ...BASE, contrast: 1.15, fade: 0.04, vignette: 0.45, grain: 0.06, grainSize: 1.3, shadowTint: [0.92, 0.86, 0.78], highTint: [1.08, 1.0, 0.86], mono: 1, monoMix: [0.35, 0.55, 0.1] },
  },
]

/** 色温 → 白平衡增益（近似黑体轨迹，保持亮度大致不变） */
export function whiteBalance(temp: number): [number, number, number] {
  const r = 1 + 0.18 * temp
  const g = 1 + 0.02 * temp
  const b = 1 - 0.26 * temp
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [r / l, g / l, b / l]
}

export type QualityId = 'low' | 'medium' | 'high' | 'ultra'

export interface Quality {
  /** 像素比上限（实际取 min(设备像素比, 上限)） */
  pixelRatio: number
  /** 场景 MSAA 采样数 */
  msaa: number
  shadowMap: number
  /** 体积云：步进密度与渲染分辨率（相对画布） */
  cloudSteps: number
  cloudScale: number
  /** 泛光降采样级数 */
  bloomLevels: number
  /** 静止时的累积帧上限（越多越干净，但动态的水、云越拖影） */
  accumulate: number
  /** 动态分辨率：镜头移动时渲染缩放的下限（静止时总是全分辨率） */
  minScale: number
}

export const QUALITIES: { id: QualityId; name: string; q: Quality }[] = [
  { id: 'low', name: '低', q: { pixelRatio: 1, msaa: 0, shadowMap: 1024, cloudSteps: 24, cloudScale: 0.34, bloomLevels: 4, accumulate: 6, minScale: 0.45 } },
  { id: 'medium', name: '中', q: { pixelRatio: 1.25, msaa: 2, shadowMap: 2048, cloudSteps: 34, cloudScale: 0.5, bloomLevels: 5, accumulate: 8, minScale: 0.5 } },
  { id: 'high', name: '高', q: { pixelRatio: 1.5, msaa: 4, shadowMap: 4096, cloudSteps: 44, cloudScale: 0.5, bloomLevels: 6, accumulate: 12, minScale: 0.55 } },
  { id: 'ultra', name: '极高', q: { pixelRatio: 2, msaa: 8, shadowMap: 8192, cloudSteps: 64, cloudScale: 0.75, bloomLevels: 6, accumulate: 24, minScale: 0.7 } },
]
