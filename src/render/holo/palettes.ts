/**
 * 全息沙盘的配色方案。
 * land 是陆地与海岸线的主色，accent 是强调色（锁定的陆块）；
 * fill 控制填色强度（低则只剩轮廓，高则整块发亮）：陆地、强调区域。
 */

export interface HoloPalette {
  id: string
  name: string
  /** 背景（远处的暗部） */
  bg: string
  /** 投影台网格、图框与界面线条 */
  grid: string
  /** 海面底色 */
  sea: string
  land: string
  accent: string
  /** 地名、界面文字 */
  text: string
  /** 填色强度：陆地、强调区域 */
  fill: readonly [number, number]
  /** 海岸线的亮度倍率（浅色主色本身就亮，要压低，不然泛光一片白） */
  glow: number
}

export const HOLO_PALETTES: HoloPalette[] = [
  {
    // 蓝橙：钢蓝的陆地、橙色的强调，深蓝灰的投影台
    id: 'tactical',
    name: '战术',
    bg: '#0b131d',
    grid: '#7f9dbf',
    sea: '#0e1925',
    land: '#6f9fd8',
    accent: '#ff6a2a',
    text: '#dfe9f5',
    fill: [0.55, 0.85],
    glow: 1,
  },
  {
    // 赤色警戒：红橙的陆地填色更重，强调色用冷蓝
    id: 'crimson',
    name: '警戒',
    bg: '#0f0a0d',
    grid: '#b8645a',
    sea: '#0c121c',
    land: '#ff4f2e',
    accent: '#4a9bff',
    text: '#ffe4da',
    fill: [1.15, 0.7],
    glow: 0.9,
  },
  {
    // 雷达绿：单色磷光屏，强调色用偏黄的亮绿
    id: 'phosphor',
    name: '雷达',
    bg: '#040c09',
    grid: '#3a8a62',
    sea: '#06130e',
    land: '#22c47f',
    accent: '#e4ff6a',
    text: '#c9ffe4',
    fill: [0.4, 0.6],
    glow: 0.7,
  },
  {
    // 极地：冷白的陆地、品红的强调
    id: 'arctic',
    name: '极地',
    bg: '#0b1015',
    grid: '#94a9bd',
    sea: '#0f1820',
    land: '#a9c8e8',
    accent: '#ff3a64',
    text: '#eef6ff',
    fill: [0.36, 0.8],
    glow: 0.5,
  },
]

export const holoPalette = (id: string) => HOLO_PALETTES.find((p) => p.id === id) ?? HOLO_PALETTES[0]
