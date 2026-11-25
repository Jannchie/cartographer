import { hex, type RGB } from '../../../render/palette'
import type { PoliticalLook } from '../../../render/atlas/styles'

/**
 * 八种内置纸图风格各自的政区画法（Theme.political）：八色调色板、着色浓淡、国界内侧的色带与各级界线。
 */

export const REALM_COLORS: RGB[] = ['#e8c7a3', '#c7d8ab', '#d6c0da', '#eedd9c', '#b6d2d4', '#e4b5ad', '#cdc4a3', '#b8c5df'].map(hex)

/** 取色块颜色乘 k 作为国名颜色 */
const shadeOf = (k: number) => (c: RGB) => `rgb(${c.map((v) => Math.round(Math.min(255, v * k))).join(',')})`

export const POL_PHYSICAL: PoliticalLook = {
  palette: REALM_COLORS,
  fill: 0.45,
  band: { width: 6, alpha: 0.4, tone: 0.82 },
  county: { color: '#3a4246', width: 0.45, alpha: 0.28 },
  culture: { color: '#3a4246', width: 1.3, alpha: 0.7, dash: [5, 2.5] },
  realm: { color: '#3a4246', width: 1.7, alpha: 0.9, dash: [10, 3, 2.4, 3] },
  halo: { color: 'rgb(150,40,50)', width: 6, alpha: 0.14 },
}
/** 羊皮纸上的水彩：淡、暖，国界沿内侧晕开一圈更浓的颜色；国界是一串圆点 */
export const POL_FANTASY: PoliticalLook = {
  palette: ['#c98f6b', '#9caf74', '#a98fb0', '#d1b45e', '#7fa6a6', '#c27b6e', '#b09a6a', '#8a9cc0'].map(hex),
  fill: 0.36,
  band: { width: 11, alpha: 0.55, tone: 0.74 },
  county: { color: '#4a3624', width: 0.5, alpha: 0.3, dash: [1.2, 2.6] },
  culture: { color: '#4a3624', width: 1.2, alpha: 0.65, dash: [6, 3] },
  realm: { color: '#3a2818', width: 3, alpha: 0.95, dash: [0.01, 4.6] },
  halo: { color: 'rgb(140,50,30)', width: 8, alpha: 0.16 },
  label: shadeOf(0.38),
}
export const POL_NAUTICAL: PoliticalLook = {
  palette: ['#e6cfb4', '#cfdcbd', '#ddd0df', '#ece0b4', '#c8dcdc', '#e6c8c2', '#d8d2bd', '#cbd4e6'].map(hex),
  fill: 0.4,
  band: { width: 4, alpha: 0.35, tone: 0.8 },
  county: { color: '#1f2a33', width: 0.4, alpha: 0.2 },
  culture: { color: '#1f2a33', width: 1, alpha: 0.6, dash: [4, 2.5] },
  realm: { color: '#1f2a33', width: 1.3, alpha: 0.85, dash: [6, 2, 1.5, 2] },
}
/** 游戏地图：白色国界加深色衬边，色块很淡，不压住平涂的地形 */
export const POL_TEYVAT: PoliticalLook = {
  palette: ['#e2b46c', '#9fcf8a', '#c6a4dc', '#f0dc84', '#86cfd0', '#e79a8a', '#cfc095', '#9fb3e8'].map(hex),
  fill: 0.24,
  band: { width: 5, alpha: 0.45, tone: 1.15 },
  county: { color: '#ffffff', width: 0.5, alpha: 0.22 },
  culture: { color: '#ffffff', width: 1.1, alpha: 0.6, dash: [5, 3] },
  realm: { color: '#fbf6e2', width: 1.6, alpha: 0.95 },
  halo: { color: 'rgb(20,30,28)', width: 4.2, alpha: 0.5 },
}
/** 水墨：淡墨设色，国界用浅赭的细笔，国名与其余注记同为墨色 */
export const POL_INK: PoliticalLook = {
  palette: ['#bfae94', '#a9b5a2', '#b5a8a3', '#c2b897', '#a7b4b5', '#b9a39a', '#b3ad98', '#a9aab5'].map(hex),
  fill: 0.16,
  band: { width: 6, alpha: 0.22, tone: 0.85 },
  county: { color: '#2b2a27', width: 0.4, alpha: 0.14, dash: [1, 2] },
  culture: { color: '#2b2a27', width: 1, alpha: 0.45, dash: [4, 3] },
  realm: { color: '#7a5a48', width: 1.2, alpha: 0.6, dash: [6, 3] },
  label: () => '#3b3833',
}
/** 地形图：不着色块，国界用品红点划线，沿内侧一道淡紫色带 */
export const POL_TOPO: PoliticalLook = {
  palette: ['#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9', '#e7d6e9'].map(hex),
  fill: 0,
  band: { width: 6, alpha: 0.55, tone: 0.92 },
  county: { color: '#6b5a7a', width: 0.5, alpha: 0.35, dash: [2, 2] },
  culture: { color: '#6b5a7a', width: 1, alpha: 0.6, dash: [5, 2.5] },
  realm: { color: '#8a2f8f', width: 1.5, alpha: 0.9, dash: [9, 2.5, 1.8, 2.5] },
  label: () => '#6a2470',
}
/** 政区地图集：满铺的柔和色块，伯爵领白线，国界内侧加深的色带 */
export const POL_ATLAS: PoliticalLook = {
  palette: ['#f2c49b', '#c8dea0', '#d9bde3', '#f5e08f', '#a9d6d8', '#f0aea3', '#d8cfa4', '#b4c6ea'].map(hex),
  fill: 0.9,
  band: { width: 7, alpha: 0.75, tone: 0.8 },
  county: { color: '#ffffff', width: 0.6, alpha: 0.55 },
  culture: { color: '#4a4048', width: 1.2, alpha: 0.7, dash: [5, 2.5] },
  realm: { color: '#4a4048', width: 1.4, alpha: 0.95, dash: [7, 2.5, 1.5, 2.5] },
  label: shadeOf(0.4),
}
/** 战略图：饱和的纹章色压在晕渲地形上，伯爵领细黑线，国界粗黑线 */
export const POL_STRATEGY: PoliticalLook = {
  palette: ['#c0473c', '#3f74b8', '#d9aa3b', '#4f9450', '#8c52a3', '#d6803a', '#3a9e9a', '#a35470'].map(hex),
  fill: 0.6,
  band: { width: 5, alpha: 0.6, tone: 1.35 },
  county: { color: '#141414', width: 0.5, alpha: 0.32 },
  culture: { color: '#141414', width: 1.2, alpha: 0.6, dash: [5, 2.5] },
  realm: { color: '#101010', width: 2, alpha: 0.95 },
  halo: { color: '#000000', width: 5, alpha: 0.18 },
  label: () => '#fff8e8',
}
