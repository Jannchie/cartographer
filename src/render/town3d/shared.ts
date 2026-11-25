/**
 * 沙盘体块各模块共用的东西：地面高程取样、颜色与写入上下文。
 * 纯函数，不依赖 three.js 与 DOM，可在 Worker 中运行。
 */
import { sampleField } from '../../gen/util'
import { settleTheme } from '../../settlement/themes'
import type { Culture, Settlement } from '../../settlement/types'
import type { RGB, Writer } from './mesh'

export type Height = (x: number, z: number) => number

/** 地形格网上一个逐格量的双线性插值（坐标为米） */
function gridSampler(t: Settlement['terrain'], f: Float32Array): Height {
  const { W, H, cell } = t
  return (x, z) => sampleField(f, W, H, x / cell, z / cell)
}
/** 地面高程（米） */
export const heightSampler = (t: Settlement['terrain']) => gridSampler(t, t.height)
/** 到水的有向距离（米，水中为负） */
export const waterSampler = (t: Settlement['terrain']) => gridSampler(t, t.water)

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

/**
 * 沙盘的屋面与墙面材质色（写实的材质色）。二维彩绘主题的屋顶色是图例色，饱和度偏高，
 * 沙盘里只沿用它的色相关系：西式红瓦、东方青瓦与琉璃、和式黑瓦、伊斯兰的土色与绿釉
 */
export const ROOF = {
  /** 西式黏土瓦：新旧不一的陶红到褐 */
  clay: ['#a05a41', '#96553f', '#a8644a', '#8c4f3c', '#9c6b54', '#874f3d', '#a76148', '#93604b'].map(hex),
  /** 石板瓦 */
  slate: ['#565c63', '#4f555c', '#5e6268', '#4a4f56', '#5a5d5f'].map(hex),
  /** 茅草 */
  thatch: ['#8c7c58', '#84744f', '#96865f', '#7c6e4e'].map(hex),
  /** 东方的青瓦（灰陶） */
  grey: ['#5f6265', '#57595b', '#66686a', '#525456', '#6b6a66', '#5c5d5a'].map(hex),
  /** 和式的本瓦、栈瓦（熏银色） */
  kawara: ['#4c4f54', '#45484d', '#53565b', '#4a4c4e', '#565759'].map(hex),
  /** 木瓦、桧皮 */
  shingle: ['#6a5646', '#5f4e40', '#74604d'].map(hex),
  /** 琉璃：黄、绿、蓝 */
  glazeYellow: hex('#bd882d'),
  glazeGreen: hex('#3f6f57'),
  /** 铜绿、铅皮 */
  copper: hex('#6f9484'),
  lead: hex('#70777c'),
  /** 伊斯兰的绿釉瓦、青绿釉面的穹顶 */
  greenTile: hex('#3d7460'),
  turquoise: hex('#2f8a8c'),
} as const
/** 教堂、城堡的石色（按建筑群取一种） */
export const ASHLAR = ['#b9ae99', '#aaa191', '#c2b59d', '#a39b8d', '#b4a78c'].map(hex)
/** 西式民居的石墙、木骨架的填充墙色之外：砖墙 */
export const BRICK_WALL = ['#9a6249', '#8f5a45', '#a56c52'].map(hex)
/** 东方的粉墙与青砖 */
export const WHITEWASH = hex('#dcd8cc')
export const GREY_BRICK = ['#8f8e89', '#9a9892', '#85847f', '#a09d95'].map(hex)
/** 汉白玉 */
export const MARBLE = hex('#d8d5cc')
/** 和式的素木（桧、杉，旧了发灰褐） */
export const WOOD_WA = hex('#6b5440')
export const WOOD_DARK = hex('#3d3027')
/** 伊斯兰的土坯色与白灰 */
export const EARTH = ['#c9ab80', '#bf9f74', '#d2b58b', '#b89668', '#c4a27a'].map(hex)
export const LIME = hex('#e6e0d0')
/** 宫殿的朱墙 */
export const PALACE_RED = hex('#8e2f24')
/** 鎏金 */
export const GILT = hex('#c8a040')

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
