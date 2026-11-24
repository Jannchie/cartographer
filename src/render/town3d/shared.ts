/**
 * 沙盘体块各模块共用的东西：地面高程取样、颜色与写入上下文。
 * 纯函数，不依赖 three.js 与 DOM，可在 Worker 中运行。
 */
import { settleTheme } from '../../settlement/themes'
import type { Culture, Settlement } from '../../settlement/types'
import type { RGB, Writer } from './mesh'

export type Height = (x: number, z: number) => number

/** 地面高程：地形格网双线性插值（米） */
export function heightSampler(t: Settlement['terrain']): Height {
  const { W, H, cell, height } = t
  return (x, z) => {
    const fx = Math.min(W - 1.001, Math.max(0, x / cell))
    const fz = Math.min(H - 1.001, Math.max(0, z / cell))
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const u = fx - i
    const v = fz - j
    const k = j * W + i
    return (height[k] * (1 - u) + height[k + 1] * u) * (1 - v) + (height[k + W] * (1 - u) + height[k + W + 1] * u) * v
  }
}

export const hex = (s: string): RGB => {
  const n = parseInt(s.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export const pick = <T>(arr: readonly T[], t: number) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))]
/** 由色调派生的第二个随机数 */
export const frac = (x: number) => x - Math.floor(x)

/** 各文明的墙色（抹灰、石、土坯、白壁） */
export const WALL: Record<Culture, RGB[]> = {
  western: ['#e9dfc8', '#ddd0b4', '#cdbf9f', '#efe6d2', '#d9c7a8'].map(hex),
  eastern: ['#b9b2a6', '#c6bfb2', '#a9a196', '#cfc6b6'].map(hex),
  wa: ['#ece6d8', '#e4dccb', '#8d6f52', '#7a5f45'].map(hex),
  islamic: ['#e3d3b1', '#dccaa4', '#e8dbbd', '#d6c39b'].map(hex),
}
export const STONE = hex('#a69f94')
export const STONE_DARK = hex('#7f786f')
export const STONE_EAST = hex('#8e8d88')
export const ADOBE = hex('#c9a77a')
export const TIMBER = hex('#6b5a48')
export const TIMBER_DARK = hex('#4a3d31')
export const VERMILION = hex('#c8412a')
export const LACQUER = hex('#9b2f22')
export const PLASTER = hex('#f1ede3')
export const TILE_DARK = hex('#565a60')
export const COPPER = hex('#7f9a8a')
export const BRICK = hex('#8a5a44')
export const GOLD = hex('#c9a24a')

export type Palette = ReturnType<ReturnType<typeof settleTheme>['buildings']>

export interface Ctx {
  w: Writer
  culture: Culture
  east: boolean
  pal: Palette
  H: Height
  storey: number
  capital: boolean
}
