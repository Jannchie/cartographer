import type { BuildingKind, Culture, Field } from './types'

export type SettleStyleId = 'parchment' | 'color' | 'ink' | 'blueprint'

/**
 * 聚落地图的绘图风格。与文明设定正交；个别颜色（屋顶）随文明而变。
 */
export interface SettleTheme {
  id: SettleStyleId
  name: string
  desc: string
  /** 纸色（图框外）与地面色 */
  paper: string
  ground: string
  /** 图框线 */
  frame: string
  ink: string
  /** 晕渲：暗部颜色与不透明度 */
  shade: { color: string; alpha: number; light: number }
  contour: { color: string; alpha: number; width: number } | null
  water: string
  waterDeep: string
  /** 岸线外的水线 */
  waterLine: { color: string; alpha: number[] }
  road: { fill: string; casing: string | null }
  /** 城内街道（街坊之间的铺装） */
  street: string
  /** 街区内未建的院落 */
  yard: string
  plaza: string
  buildings: (culture: Culture) => Record<BuildingKind, string[]>
  buildingStroke: { color: string; width: number }
  /** 屋脊线 / 投影 / 排线 */
  roofLines: string | null
  shadow: string | null
  hatch: string | null
  wall: { fill: string; stroke: string }
  fields: Record<Field['kind'], string[]>
  furrow: { color: string; alpha: number }
  green: { park: string; garden: string; cemetery: string; courtyard: string }
  tree: { fill: string; dark: string; stroke: string | null }
  magic: string
  label: { color: string; halo: string; water: string; district: string }
  font: { title: string; label: string; italic: string }
}

const shades = (...c: string[]) => c

export const SETTLE_THEMES: SettleTheme[] = [
  {
    id: 'parchment',
    name: '羊皮纸',
    desc: '奇幻冒险地图：旧纸、墨线、手绘林木，街坊以墨色勾勒',
    paper: '#e9dcbc',
    ground: '#efe4c8',
    frame: '#4a3a28',
    ink: '#3f3122',
    shade: { color: '#6b5335', alpha: 0.1, light: 0.18 },
    contour: { color: '#8a6e4b', alpha: 0.35, width: 0.6 },
    water: '#b7c6ba',
    waterDeep: '#a3b6ac',
    waterLine: { color: '#4f6158', alpha: [0.45, 0.3, 0.18, 0.1] },
    road: { fill: '#f3ead3', casing: '#8c7457' },
    street: '#f1e7cf',
    yard: '#e2d4b2',
    plaza: '#ede1c4',
    buildings: () => ({
      house: shades('#c7b18c', '#c2aa83', '#cbb693'),
      large: shades('#bba47d'),
      temple: shades('#b09a74'),
      keep: shades('#a88f69'),
      tower: shades('#a88f69'),
      hall: shades('#b8a07a'),
      shed: shades('#cdbb98'),
      pagoda: shades('#b09a74'),
      magic: shades('#a996b6'),
    }),
    buildingStroke: { color: '#3f3122', width: 0.9 },
    roofLines: null,
    shadow: null,
    hatch: '#5a4630',
    wall: { fill: '#8a7556', stroke: '#3f3122' },
    fields: {
      crop: shades('#e6d9b1', '#dfd3a6', '#e8dcb8', '#dccfa1'),
      pasture: shades('#dcd8b0'),
      orchard: shades('#d8d3a8'),
      paddy: shades('#d3d6b6', '#cfd3b0'),
      vineyard: shades('#ddd2aa'),
    },
    furrow: { color: '#8a7456', alpha: 0.35 },
    green: { park: '#d6d3a6', garden: '#dcd6ad', cemetery: '#d3cfa4', courtyard: '#dcd3ae' },
    tree: { fill: '#b7b784', dark: '#7c7a52', stroke: '#4a4128' },
    magic: '#6b4f9a',
    label: { color: '#3a2c1c', halo: '#efe4c8', water: '#34504a', district: '#5a4630' },
    font: { title: '"IM Fell English", "Noto Serif SC", serif', label: '"Noto Serif SC", "IM Fell English", serif', italic: 'italic "IM Fell English", "Noto Serif SC", serif' },
  },
  {
    id: 'color',
    name: '彩绘',
    desc: '明快的彩色城市图：红瓦（东方为青瓦）、绿野、蓝水与投影',
    paper: '#ece6d6',
    ground: '#dfe2c4',
    frame: '#3d3a33',
    ink: '#3b3833',
    shade: { color: '#3d4a2e', alpha: 0.12, light: 0.22 },
    contour: { color: '#7d8a5a', alpha: 0.3, width: 0.55 },
    water: '#8fbccc',
    waterDeep: '#79abbf',
    waterLine: { color: '#ffffff', alpha: [0.45, 0.25, 0.12, 0.06] },
    road: { fill: '#f2ead3', casing: '#b6a98a' },
    street: '#ece3cb',
    yard: '#cfd6ac',
    plaza: '#e8dcc0',
    buildings: (c) =>
      c === 'eastern'
        ? {
            house: shades('#747b82', '#6a7178', '#7d838a', '#666d74'),
            large: shades('#5f666e'),
            temple: shades('#c9963a'),
            keep: shades('#c79a3c'),
            tower: shades('#8f4a3a'),
            hall: shades('#4f7e62'),
            shed: shades('#9a8f7e'),
            pagoda: shades('#8f4a3a'),
            magic: shades('#4c8a8f'),
          }
        : {
            house: shades('#c0674a', '#b65c42', '#c9764f', '#a9543d', '#c26e56'),
            large: shades('#8a7f76'),
            temple: shades('#9aa0a6'),
            keep: shades('#8c8f94'),
            tower: shades('#8c8f94'),
            hall: shades('#a35f45'),
            shed: shades('#b69b7a'),
            pagoda: shades('#9aa0a6'),
            magic: shades('#7b64a8'),
          },
    buildingStroke: { color: '#3b3833', width: 0.5 },
    roofLines: 'rgba(40,30,25,0.35)',
    shadow: 'rgba(40,40,30,0.28)',
    hatch: null,
    wall: { fill: '#b6ad9c', stroke: '#4a453d' },
    fields: {
      crop: shades('#d8d49a', '#cfd28f', '#e0d6a0', '#c5cf8e', '#dccc8a'),
      pasture: shades('#bcd097'),
      orchard: shades('#b5cb8e'),
      paddy: shades('#a9cdb4', '#b3d3ad'),
      vineyard: shades('#c6c48e'),
    },
    furrow: { color: '#7a7a45', alpha: 0.28 },
    green: { park: '#a9c98c', garden: '#b8cf95', cemetery: '#b4c796', courtyard: '#c9d2a4' },
    tree: { fill: '#6f9a55', dark: '#4d7440', stroke: null },
    magic: '#7a4fd0',
    label: { color: '#2e2b26', halo: '#f4efe2', water: '#2b5a6e', district: '#5a4c3a' },
    font: { title: '"Cormorant Garamond", "Noto Serif SC", serif', label: '"Noto Serif SC", "Cormorant Garamond", serif', italic: 'italic "Cormorant Garamond", "Noto Serif SC", serif' },
  },
  {
    id: 'ink',
    name: '版画',
    desc: '黑白铜版：建筑排线、水面横纹、线描林木，像旧城志里的插图',
    paper: '#f7f4ec',
    ground: '#f7f4ec',
    frame: '#1e1c1a',
    ink: '#1e1c1a',
    shade: { color: '#1e1c1a', alpha: 0.06, light: 0 },
    contour: { color: '#1e1c1a', alpha: 0.28, width: 0.5 },
    water: '#f7f4ec',
    waterDeep: '#f7f4ec',
    waterLine: { color: '#1e1c1a', alpha: [0.8, 0.55, 0.35, 0.2] },
    road: { fill: '#f7f4ec', casing: '#1e1c1a' },
    street: '#f7f4ec',
    yard: '#f7f4ec',
    plaza: '#f7f4ec',
    buildings: () => ({
      house: shades('url(#hatch)'),
      large: shades('url(#hatch)'),
      temple: shades('url(#hatch2)'),
      keep: shades('url(#hatch2)'),
      tower: shades('url(#hatch2)'),
      hall: shades('url(#hatch)'),
      shed: shades('#f7f4ec'),
      pagoda: shades('url(#hatch2)'),
      magic: shades('url(#hatch2)'),
    }),
    buildingStroke: { color: '#1e1c1a', width: 0.8 },
    roofLines: null,
    shadow: null,
    hatch: '#1e1c1a',
    wall: { fill: '#1e1c1a', stroke: '#1e1c1a' },
    fields: {
      crop: shades('#f7f4ec'),
      pasture: shades('#f7f4ec'),
      orchard: shades('#f7f4ec'),
      paddy: shades('#f7f4ec'),
      vineyard: shades('#f7f4ec'),
    },
    furrow: { color: '#1e1c1a', alpha: 0.32 },
    green: { park: '#f7f4ec', garden: '#f7f4ec', cemetery: '#f7f4ec', courtyard: '#f7f4ec' },
    tree: { fill: '#f7f4ec', dark: '#1e1c1a', stroke: '#1e1c1a' },
    magic: '#1e1c1a',
    label: { color: '#1e1c1a', halo: '#f7f4ec', water: '#1e1c1a', district: '#1e1c1a' },
    font: { title: '"Noto Serif SC", "Cormorant Garamond", serif', label: '"Noto Serif SC", serif', italic: 'italic "Cormorant Garamond", "Noto Serif SC", serif' },
  },
  {
    id: 'blueprint',
    name: '蓝图',
    desc: '规划蓝图：深蓝底、白色细线，适合当作设定稿',
    paper: '#1d3b5c',
    ground: '#21456b',
    frame: '#d9e6f2',
    ink: '#e3eef8',
    shade: { color: '#0d2034', alpha: 0.18, light: 0.06 },
    contour: { color: '#9fc0de', alpha: 0.28, width: 0.5 },
    water: '#1a3a5c',
    waterDeep: '#17344f',
    waterLine: { color: '#cfe2f3', alpha: [0.5, 0.3, 0.16, 0.08] },
    road: { fill: '#2a5480', casing: '#cfe2f3' },
    street: '#28507a',
    yard: '#234a72',
    plaza: '#2b5682',
    buildings: () => ({
      house: shades('#3d6c98'),
      large: shades('#4574a0'),
      temple: shades('#5a86b0'),
      keep: shades('#5a86b0'),
      tower: shades('#5a86b0'),
      hall: shades('#4a79a5'),
      shed: shades('#35638e'),
      pagoda: shades('#5a86b0'),
      magic: shades('#6f6fb8'),
    }),
    buildingStroke: { color: '#e3eef8', width: 0.6 },
    roofLines: null,
    shadow: null,
    hatch: null,
    wall: { fill: '#9fc0de', stroke: '#e3eef8' },
    fields: {
      crop: shades('#24496f', '#264c73'),
      pasture: shades('#22476d'),
      orchard: shades('#22476d'),
      paddy: shades('#20456b'),
      vineyard: shades('#24496f'),
    },
    furrow: { color: '#9fc0de', alpha: 0.18 },
    green: { park: '#244d6f', garden: '#244d6f', cemetery: '#244d6f', courtyard: '#244d6f' },
    tree: { fill: '#2a5a7a', dark: '#9fc0de', stroke: '#9fc0de' },
    magic: '#b9a4ff',
    label: { color: '#e3eef8', halo: '#21456b', water: '#bcd6ee', district: '#bcd6ee' },
    font: { title: '"Source Sans 3", "Noto Serif SC", sans-serif', label: '"Source Sans 3", "Noto Serif SC", sans-serif', italic: 'italic "Source Sans 3", "Noto Serif SC", sans-serif' },
  },
]

export function settleTheme(id: string): SettleTheme {
  return SETTLE_THEMES.find((t) => t.id === id) ?? SETTLE_THEMES[0]
}
