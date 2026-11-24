/**
 * 沙盘植被的树形表：实例数据（vegetation.ts，Worker）与网格、着色（treeMeshes.ts、treeLayer.ts，主线程）共用。
 * 不依赖 three.js 与 DOM。
 *
 * 所有尺寸以"冠径单位"计：实例的冠径（米）乘上去就是实际大小。树形只定形态，
 * 叶色、花果的点缀、个体大小由 vegetation.ts 按树种（槐、椴、樱、橄榄……）写进实例。
 */

export const SP = {
  /** 阔叶大乔木：树干分叉，多团树冠（橡、椴、槐、樟） */
  oak: 0,
  /** 高卵形阔叶（杨、榆、银杏、桤木） */
  poplar: 1,
  /** 柱形（意大利柏、紫杉、圆柏、钻天杨） */
  cypress: 2,
  /** 分层的锥形针叶（云杉、冷杉、柳杉） */
  spruce: 3,
  /** 弯干、平展的层云状树冠（黑松、油松、石松） */
  pine: 4,
  /** 垂柳 */
  willow: 5,
  /** 椰枣 */
  palm: 6,
  /** 果树：矮干、圆冠（苹果、柑橘、橄榄、桃、柿） */
  fruit: 7,
  /** 观赏树：分枝开张、层叠的平冠（樱、枫、梅） */
  ornamental: 8,
  /** 竹丛 */
  bamboo: 9,
  /** 灌木 */
  shrub: 10,
  /** 芦苇丛 */
  reed: 11,
  /** 修剪的绿篱段：沿朝向排成一道（园圃的镶边、田埂的树篱） */
  hedge: 12,
  /** 葡萄藤架的一段：木桩之间一道藤叶 */
  vine: 13,
} as const

export const SPECIES_NAMES = Object.keys(SP) as (keyof typeof SP)[]
export const SPECIES_COUNT = SPECIES_NAMES.length

/** 花果的点缀（写在实例的树种字节的高 4 位）：叶簇里零星的异色小团 */
export const ACCENT = { none: 0, red: 1, orange: 2, pale: 3 } as const

export interface SpeciesSpec {
  /**
   * 远景回转体的轮廓：自下而上 5 个环 (半径, 高度)——冠底、下缘、最宽处、肩、顶点。
   * 近景网格（treeMeshes.ts）的外形与它一致，远近切换时轮廓不跳
   */
  profile: [number, number][]
  /** 树干：半径与树皮色（sRGB） */
  trunk: number
  bark: string
  /** 远景轮廓各顶点半径的参差（0 ~ 1）：团状树冠大，修剪的柱形小 */
  lump: number
  /** 树干的倾斜量（冠径单位 / 高度平方） */
  lean: number
  /** 个体形变：树冠顶点按低频场错动的幅度 */
  warp: number
  /** 叶簇纹理：一簇的大小（米）、竖向拉伸（垂柳、柏的叶簇是竖长的）、轮廓的镂空程度、表面零星透空的比例、粗糙度 */
  leaf: { cell: number; stretch: number; erode: number; hole: number; rough: number }
  /** 朝向随实例给定（绿篱、藤架沿线排布），不按随机数转；也不做个体形变与高宽变化 */
  aligned?: boolean
  /** 分层针叶的层数：远景回转体按它画出一层层明暗（与近景网格的层大致对上） */
  tiers?: number
}

export const SPECIES: SpeciesSpec[] = [
  // oak
  {
    profile: [[0.5, 0.74], [0.98, 1.05], [1.06, 1.45], [0.74, 2.02], [0, 2.4]],
    trunk: 0.115,
    bark: '#7d6f5f',
    lump: 0.32,
    lean: 0.012,
    warp: 0.07,
    leaf: { cell: 0.26, stretch: 1, erode: 0.75, hole: 0.12, rough: 0.82 },
  },
  // poplar
  {
    profile: [[0.3, 0.72], [0.6, 1.25], [0.66, 1.95], [0.44, 2.8], [0, 3.38]],
    trunk: 0.085,
    bark: '#8d877a',
    lump: 0.22,
    lean: 0.006,
    warp: 0.05,
    leaf: { cell: 0.22, stretch: 1.3, erode: 0.75, hole: 0.14, rough: 0.78 },
  },
  // cypress
  {
    profile: [[0.2, 0.2], [0.4, 0.85], [0.45, 1.7], [0.3, 2.95], [0, 4.0]],
    trunk: 0.07,
    bark: '#7a6857',
    lump: 0.1,
    lean: 0.003,
    warp: 0.03,
    leaf: { cell: 0.15, stretch: 2.2, erode: 0.5, hole: 0.04, rough: 0.88 },
  },
  // spruce
  {
    profile: [[0.4, 0.42], [0.8, 0.62], [0.62, 1.55], [0.32, 2.85], [0, 4.15]],
    trunk: 0.075,
    bark: '#6e5d50',
    lump: 0.2,
    lean: 0.003,
    warp: 0.03,
    leaf: { cell: 0.16, stretch: 0.8, erode: 0.8, hole: 0.08, rough: 0.9 },
    tiers: 5,
  },
  // pine
  {
    profile: [[0.35, 1.42], [0.98, 1.66], [1.08, 2.0], [0.62, 2.45], [0, 2.72]],
    trunk: 0.1,
    bark: '#8a6650',
    lump: 0.3,
    lean: 0.035,
    warp: 0.05,
    leaf: { cell: 0.17, stretch: 0.7, erode: 0.8, hole: 0.12, rough: 0.9 },
  },
  // willow
  {
    profile: [[0.82, 0.22], [1.06, 0.85], [1.08, 1.45], [0.72, 2.05], [0, 2.38]],
    trunk: 0.15,
    bark: '#7b6f60',
    lump: 0.2,
    lean: 0.02,
    warp: 0.05,
    leaf: { cell: 0.16, stretch: 4, erode: 0.85, hole: 0.3, rough: 0.8 },
  },
  // palm
  {
    profile: [[0.14, 3.0], [1.0, 2.95], [1.2, 3.3], [0.62, 3.85], [0, 4.05]],
    trunk: 0.085,
    bark: '#8f8272',
    lump: 0.45,
    lean: 0.02,
    warp: 0,
    leaf: { cell: 0.2, stretch: 1, erode: 0, hole: 0, rough: 0.7 },
  },
  // fruit
  {
    profile: [[0.42, 0.46], [0.88, 0.68], [0.96, 0.98], [0.62, 1.4], [0, 1.62]],
    trunk: 0.085,
    bark: '#786a5c',
    lump: 0.25,
    lean: 0.02,
    warp: 0.06,
    leaf: { cell: 0.2, stretch: 1, erode: 0.7, hole: 0.1, rough: 0.8 },
  },
  // ornamental
  {
    profile: [[0.42, 0.62], [1.02, 0.95], [1.14, 1.3], [0.72, 1.74], [0, 1.98]],
    trunk: 0.09,
    bark: '#6a5d56',
    lump: 0.34,
    lean: 0.025,
    warp: 0.07,
    leaf: { cell: 0.17, stretch: 1, erode: 0.85, hole: 0.2, rough: 0.82 },
  },
  // bamboo
  {
    profile: [[0.32, 0.9], [0.62, 1.8], [0.78, 2.8], [0.52, 3.6], [0, 4.1]],
    trunk: 0.13,
    bark: '#7f8f4a',
    lump: 0.35,
    lean: 0.01,
    warp: 0.03,
    leaf: { cell: 0.16, stretch: 1, erode: 0.9, hole: 0.2, rough: 0.75 },
  },
  // shrub
  {
    profile: [[0.82, 0.02], [1.0, 0.3], [0.96, 0.58], [0.6, 0.92], [0, 1.08]],
    trunk: 0,
    bark: '#4d4338',
    lump: 0.3,
    lean: 0,
    warp: 0.08,
    leaf: { cell: 0.14, stretch: 1, erode: 0.7, hole: 0.1, rough: 0.85 },
  },
  // reed
  {
    profile: [[0.3, 0.02], [0.5, 0.6], [0.6, 1.2], [0.5, 1.7], [0, 2.0]],
    trunk: 0,
    bark: '#8a8055',
    lump: 0.4,
    lean: 0,
    warp: 0,
    leaf: { cell: 0.2, stretch: 1, erode: 0, hole: 0, rough: 0.8 },
  },
  // hedge
  {
    profile: [[0.4, 0.02], [0.42, 0.3], [0.42, 0.7], [0.36, 0.95], [0, 1.0]],
    trunk: 0,
    bark: '#4d4338',
    lump: 0.05,
    lean: 0,
    warp: 0,
    leaf: { cell: 0.1, stretch: 1, erode: 0.35, hole: 0, rough: 0.88 },
    aligned: true,
  },
  // vine
  {
    profile: [[0.3, 0.3], [0.34, 0.55], [0.36, 0.85], [0.28, 1.1], [0, 1.2]],
    trunk: 0,
    bark: '#7c6e5e',
    lump: 0.2,
    lean: 0,
    warp: 0,
    leaf: { cell: 0.16, stretch: 1, erode: 0.8, hole: 0.2, rough: 0.82 },
    aligned: true,
  },
]

/** 高度的个体变化：实例字节 0 ~ 255 对应的竖向比例 */
export const HEIGHT_SCALE: [number, number] = [0.82, 1.22]
