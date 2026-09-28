import type { BuildingKind, Culture, Field } from './types'

export type SettleStyleId = 'parchment' | 'color' | 'ink' | 'blueprint' | 'kiriezu' | 'nolli' | 'fangzhi' | 'survey'

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
  buildings: (culture: Culture) => Record<Exclude<BuildingKind, 'torii'>, string[]>
  /** 鸟居、神桥的朱红（缺省 #c8412a） */
  vermilion?: string
  buildingStroke: { color: string; width: number }
  /** 屋脊线 / 投影 / 排线 */
  roofLines: string | null
  shadow: string | null
  hatch: string | null
  wall: { fill: string; stroke: string }
  fields: Record<Field['kind'], string[]>
  furrow: { color: string; alpha: number }
  green: { park: string; garden: string; cemetery: string; courtyard: string }
  /** 树冠：底色、右下暗面（darkAlpha 缺省 0.55）、描边、右下的投影色 */
  tree: { fill: string; dark: string; stroke: string | null; darkAlpha?: number; shadow?: string }
  magic: string
  label: { color: string; halo: string; water: string; district: string }
  font: { title: string; label: string; italic: string }
  /** 街区（院落）的描边 */
  blockStroke?: { color: string; alpha: number; width: number }
  /** 水面纹样：铜版横纹 lines、正弦波纹 waves、鱼鳞状水波 scallops；step 是行距（米） */
  waterHatch?: { kind: 'lines' | 'waves' | 'scallops'; color: string; alpha: number; width: number; step?: number }
  /** 额外的排线图案，填充色写 url(#id) 引用 */
  patterns?: { id: string; step: number; width: number; cross: boolean; color: string; bg: string }[]
  /** 岸线与护城河岸的颜色（缺省用 ink） */
  waterEdge?: string
  /** 东方文明的中文标题用毛笔字（缺省 true） */
  brushTitle?: boolean
  /** 标题框旁的朱印（印泥色）；缺省不盖 */
  seal?: string
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
      civic: shades('#b58a55'),
    }),
    buildingStroke: { color: '#3f3122', width: 0.9 },
    roofLines: null,
    shadow: null,
    hatch: '#5a4630',
    wall: { fill: '#b8a27f', stroke: '#75614a' },
    fields: {
      crop: shades('#e6d9b1', '#dfd3a6', '#e8dcb8', '#dccfa1'),
      pasture: shades('#dcd8b0'),
      orchard: shades('#d8d3a8'),
      paddy: shades('#d3d6b6', '#cfd3b0'),
      vineyard: shades('#ddd2aa'),
      garden: shades('#d6d8a6', '#d0d49c', '#dad9ab'),
      meadow: shades('#dfdfbb'),
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
      c === 'wa'
        ? {
            // 瓦顶的町家是深灰，天守、寺社的白壁黑瓦
            house: shades('#5d6167', '#565a60', '#63676d', '#51555b'),
            large: shades('#4c5056'),
            temple: shades('#7a5a3c'),
            keep: shades('#e9e4d6'),
            tower: shades('#e2ddcf'),
            hall: shades('#8a3b2e'),
            shed: shades('#8f8574'),
            pagoda: shades('#8a3b2e'),
            magic: shades('#4c8a8f'),
            civic: shades('#b0452f'),
          }
        : c === 'islamic'
          ? {
              // 土坯、石灰抹面的平顶，清真寺的绿与白
              house: shades('#e3d3b1', '#dccaa4', '#e8dbbd', '#d6c39b', '#ead9b3'),
              large: shades('#cdb68c'),
              temple: shades('#3f8a78'),
              keep: shades('#b98e5d'),
              tower: shades('#f0e9d8'),
              hall: shades('#c49a62'),
              shed: shades('#c9b38e'),
              pagoda: shades('#f0e9d8'),
              magic: shades('#4c6fa8'),
              civic: shades('#3f6f8a'),
            }
          : c === 'eastern'
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
            civic: shades('#b0452f'),
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
            civic: shades('#4a6f86'),
          },
    buildingStroke: { color: '#3b3833', width: 0.5 },
    roofLines: 'rgba(40,30,25,0.35)',
    shadow: 'rgba(40,40,30,0.28)',
    hatch: null,
    wall: { fill: '#cdc5b4', stroke: '#7d756a' },
    fields: {
      crop: shades('#d8d49a', '#cfd28f', '#e0d6a0', '#c5cf8e', '#dccc8a'),
      pasture: shades('#bcd097'),
      orchard: shades('#b5cb8e'),
      paddy: shades('#a9cdb4', '#b3d3ad'),
      vineyard: shades('#c6c48e'),
      garden: shades('#a9c784', '#b2cc8a', '#a3c27c'),
      meadow: shades('#c9dca6'),
    },
    furrow: { color: '#7a7a45', alpha: 0.28 },
    green: { park: '#a9c98c', garden: '#b8cf95', cemetery: '#b4c796', courtyard: '#c9d2a4' },
    tree: { fill: '#6f9a55', dark: '#4d7440', stroke: null, shadow: 'rgb(40,50,30)' },
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
      civic: shades('url(#hatch2)'),
    }),
    buildingStroke: { color: '#1e1c1a', width: 0.8 },
    roofLines: null,
    shadow: null,
    hatch: '#1e1c1a',
    wall: { fill: '#8f8a82', stroke: '#1e1c1a' },
    fields: {
      crop: shades('#f7f4ec'),
      pasture: shades('#f7f4ec'),
      orchard: shades('#f7f4ec'),
      paddy: shades('#f7f4ec'),
      vineyard: shades('#f7f4ec'),
      garden: shades('#f7f4ec'),
      meadow: shades('#f7f4ec'),
    },
    furrow: { color: '#1e1c1a', alpha: 0.32 },
    green: { park: '#f7f4ec', garden: '#f7f4ec', cemetery: '#f7f4ec', courtyard: '#f7f4ec' },
    tree: { fill: '#f7f4ec', dark: '#1e1c1a', stroke: '#1e1c1a', darkAlpha: 0.45 },
    magic: '#1e1c1a',
    label: { color: '#1e1c1a', halo: '#f7f4ec', water: '#1e1c1a', district: '#1e1c1a' },
    font: { title: '"Noto Serif SC", "Cormorant Garamond", serif', label: '"Noto Serif SC", serif', italic: 'italic "Cormorant Garamond", "Noto Serif SC", serif' },
    blockStroke: { color: '#1e1c1a', alpha: 0.35, width: 0.4 },
    waterHatch: { kind: 'lines', color: '#1e1c1a', alpha: 0.5, width: 0.45 },
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
      civic: shades('#7fa6cc'),
    }),
    buildingStroke: { color: '#e3eef8', width: 0.6 },
    roofLines: null,
    shadow: null,
    hatch: null,
    wall: { fill: '#6f98c0', stroke: '#b6cde3' },
    fields: {
      crop: shades('#24496f', '#264c73'),
      pasture: shades('#22476d'),
      orchard: shades('#22476d'),
      paddy: shades('#20456b'),
      vineyard: shades('#24496f'),
      garden: shades('#24496f'),
      meadow: shades('#22476d'),
    },
    furrow: { color: '#9fc0de', alpha: 0.18 },
    green: { park: '#244d6f', garden: '#244d6f', cemetery: '#244d6f', courtyard: '#244d6f' },
    tree: { fill: '#2a5a7a', dark: '#9fc0de', stroke: '#9fc0de', darkAlpha: 0.7 },
    magic: '#b9a4ff',
    label: { color: '#e3eef8', halo: '#21456b', water: '#bcd6ee', district: '#bcd6ee' },
    font: { title: '"Source Sans 3", "Noto Serif SC", sans-serif', label: '"Source Sans 3", "Noto Serif SC", sans-serif', italic: 'italic "Source Sans 3", "Noto Serif SC", sans-serif' },
    blockStroke: { color: '#e3eef8', alpha: 0.35, width: 0.4 },
    brushTitle: false,
  },
  {
    id: 'kiriezu',
    name: '切绘图',
    desc: '江户切绘图：矿物色平涂、墨线勾边；道路土黄、寺社朱红、町屋鼠灰、武家白地，靛蓝水面',
    paper: '#e4d3a8',
    ground: '#e0cd9c',
    frame: '#1e1b16',
    ink: '#1e1b16',
    shade: { color: '#5a4a2a', alpha: 0.05, light: 0 },
    contour: null,
    water: '#5a83ae',
    waterDeep: '#4f78a4',
    waterLine: { color: '#eef2ee', alpha: [0.55, 0.3, 0, 0] },
    road: { fill: '#e6c25a', casing: '#1e1b16' },
    street: '#e6c25a',
    yard: '#b4ada0',
    plaza: '#e9ca6c',
    buildings: (c) => ({
      // 切绘图的图例：町屋鼠灰、武家屋敷白地、寺社朱；伊斯兰的土坯城换成浅一些的灰褐
      house: c === 'islamic' ? shades('#a49a88', '#9d9382', '#aaa08e') : shades('#8e8a82', '#86827a', '#96928a'),
      large: shades('#f3eee0'),
      temple: shades('#c8452d'),
      keep: shades('#f3eee0'),
      tower: shades('#f3eee0'),
      hall: shades(c === 'wa' || c === 'eastern' ? '#c8452d' : '#f3eee0'),
      shed: shades('#a8a398'),
      pagoda: shades('#c8452d'),
      magic: shades('#3f8a80'),
      civic: shades('#c8452d'),
    }),
    buildingStroke: { color: '#1e1b16', width: 0.8 },
    roofLines: null,
    shadow: null,
    hatch: null,
    wall: { fill: '#f0eadb', stroke: '#1e1b16' },
    fields: {
      crop: shades('#b9c887', '#b2c37f', '#bfcc8e'),
      pasture: shades('#aec27e'),
      orchard: shades('#a4bb76'),
      paddy: shades('#a7c48a', '#a0bf83'),
      vineyard: shades('#b3c27f'),
      garden: shades('#9fbb72', '#a6c079'),
      meadow: shades('#b7ca8c'),
    },
    furrow: { color: '#4d5a2c', alpha: 0.3 },
    green: { park: '#8fb069', garden: '#99b872', cemetery: '#a2b47e', courtyard: '#c2cf98' },
    tree: { fill: '#5f8d4c', dark: '#2c4a28', stroke: '#1e1b16', darkAlpha: 0.5 },
    magic: '#7a3f8e',
    label: { color: '#1e1b16', halo: '#efe3c2', water: '#12294a', district: '#6a2a1c' },
    font: { title: '"Noto Serif SC", serif', label: '"Noto Serif SC", serif', italic: 'italic "Noto Serif SC", serif' },
    blockStroke: { color: '#1e1b16', alpha: 0.85, width: 0.6 },
    waterHatch: { kind: 'waves', color: '#e8eef0', alpha: 0.4, width: 0.55, step: 4.2 },
    waterEdge: '#1e1b16',
  },
  {
    id: 'nolli',
    name: '图底铜版',
    desc: '十八世纪罗马诺利图式的铜版平面：街区以密排线涂实，街巷、广场与公共建筑留白',
    paper: '#f1ece0',
    ground: '#f1ece0',
    frame: '#1f1c19',
    ink: '#1f1c19',
    shade: { color: '#1f1c19', alpha: 0.045, light: 0 },
    contour: { color: '#1f1c19', alpha: 0.2, width: 0.45 },
    water: '#f1ece0',
    waterDeep: '#f1ece0',
    waterLine: { color: '#1f1c19', alpha: [0.7, 0.4, 0.22, 0.12] },
    road: { fill: '#f1ece0', casing: '#1f1c19' },
    street: '#f1ece0',
    yard: 'url(#poche)',
    plaza: '#f1ece0',
    buildings: () => ({
      // 私宅并进街区的涂实里，只剩一圈轮廓；寺院、官署、城堡这些公共空间留白
      house: shades('url(#poche)'),
      large: shades('url(#poche)'),
      temple: shades('#f1ece0'),
      keep: shades('#f1ece0'),
      tower: shades('#f1ece0'),
      hall: shades('url(#poche)'),
      shed: shades('url(#poche)'),
      pagoda: shades('#f1ece0'),
      magic: shades('#f1ece0'),
      civic: shades('#f1ece0'),
    }),
    buildingStroke: { color: '#1f1c19', width: 0.7 },
    roofLines: null,
    shadow: null,
    hatch: null,
    wall: { fill: '#3a3530', stroke: '#1f1c19' },
    fields: {
      crop: shades('#f1ece0'),
      pasture: shades('#f1ece0'),
      orchard: shades('#f1ece0'),
      paddy: shades('#f1ece0'),
      vineyard: shades('#f1ece0'),
      garden: shades('#f1ece0'),
      meadow: shades('#f1ece0'),
    },
    furrow: { color: '#1f1c19', alpha: 0.26 },
    green: { park: '#f1ece0', garden: '#f1ece0', cemetery: '#f1ece0', courtyard: '#f1ece0' },
    tree: { fill: '#f1ece0', dark: '#1f1c19', stroke: '#1f1c19', darkAlpha: 0.5 },
    magic: '#1f1c19',
    label: { color: '#1f1c19', halo: '#f1ece0', water: '#1f1c19', district: '#1f1c19' },
    font: { title: '"IM Fell English SC", "Noto Serif SC", serif', label: '"Noto Serif SC", "Cormorant Garamond", serif', italic: 'italic "IM Fell English", "Noto Serif SC", serif' },
    blockStroke: { color: '#1f1c19', alpha: 0.9, width: 0.6 },
    waterHatch: { kind: 'lines', color: '#1f1c19', alpha: 0.55, width: 0.4, step: 2.4 },
    patterns: [{ id: 'poche', step: 2, width: 0.5, cross: true, color: '#1f1c19', bg: '#f1ece0' }],
    brushTitle: false,
  },
  {
    id: 'fangzhi',
    name: '方志舆图',
    desc: '明清地方志里的木刻舆图：宣纸墨线，屋宇留白勾出屋脊，鱼鳞水波，淡墨染出山势，钤一方朱印',
    paper: '#ebdfc3',
    ground: '#ebdfc3',
    frame: '#2b2520',
    ink: '#2b2520',
    shade: { color: '#3b332a', alpha: 0.07, light: 0 },
    contour: null,
    water: '#e4d8ba',
    waterDeep: '#e4d8ba',
    waterLine: { color: '#2b2520', alpha: [0.3, 0, 0, 0] },
    road: { fill: '#ebdfc3', casing: '#2b2520' },
    street: '#ebdfc3',
    yard: '#e5d8b9',
    plaza: '#ebdfc3',
    buildings: () => ({
      house: shades('#efe5cc'),
      large: shades('#efe5cc'),
      temple: shades('#dcc39c'),
      keep: shades('#dcc39c'),
      tower: shades('#dcc39c'),
      hall: shades('#e6d6b4'),
      shed: shades('#ebdfc3'),
      pagoda: shades('#dcc39c'),
      magic: shades('#d7c4a6'),
      civic: shades('#dcc39c'),
    }),
    buildingStroke: { color: '#2b2520', width: 0.75 },
    roofLines: 'rgba(43,37,32,0.55)',
    shadow: null,
    hatch: null,
    wall: { fill: '#d6c6a2', stroke: '#2b2520' },
    fields: {
      crop: shades('#e8dcbe', '#e5d9ba'),
      pasture: shades('#e7dcbf'),
      orchard: shades('#e5dabc'),
      paddy: shades('#e3d9ba'),
      vineyard: shades('#e6dabb'),
      garden: shades('#e4d8b7'),
      meadow: shades('#e8ddc1'),
    },
    furrow: { color: '#2b2520', alpha: 0.15 },
    green: { park: '#e3d8b8', garden: '#e3d8b8', cemetery: '#e1d6b6', courtyard: '#e6dabb' },
    tree: { fill: '#ebdfc3', dark: '#2b2520', stroke: '#2b2520', darkAlpha: 0.6 },
    magic: '#8c3a2e',
    label: { color: '#2b2520', halo: '#ebdfc3', water: '#2b2520', district: '#4a3a30' },
    font: { title: '"Noto Serif SC", serif', label: '"Noto Serif SC", serif', italic: 'italic "Noto Serif SC", serif' },
    blockStroke: { color: '#2b2520', alpha: 0.45, width: 0.5 },
    waterHatch: { kind: 'scallops', color: '#2b2520', alpha: 0.55, width: 0.6, step: 5.5 },
    seal: '#b5392a',
  },
  {
    id: 'survey',
    name: '测绘图',
    desc: '现代大比例尺地形图：白底、褐色等高线、黄色干道、蓝色水系，无衬线注记',
    paper: '#fbfaf6',
    ground: '#fbfaf6',
    frame: '#2a2a2a',
    ink: '#3a3632',
    shade: { color: '#6b5a45', alpha: 0.05, light: 0 },
    contour: { color: '#c47a3a', alpha: 0.6, width: 0.55 },
    water: '#b3d8f0',
    waterDeep: '#a1cdeb',
    waterLine: { color: '#2f7fbf', alpha: [0.45, 0.2, 0, 0] },
    road: { fill: '#f7d64e', casing: '#6d6252' },
    street: '#ffffff',
    yard: '#efe9e1',
    plaza: '#ffffff',
    buildings: () => ({
      house: shades('#d9b8a4', '#d4b19c', '#ddbfac'),
      large: shades('#cba590'),
      temple: shades('#8f7064'),
      keep: shades('#8f7064'),
      tower: shades('#8f7064'),
      hall: shades('#b98f7c'),
      shed: shades('#e3d0c2'),
      pagoda: shades('#8f7064'),
      magic: shades('#8c79a8'),
      civic: shades('#8f7064'),
    }),
    buildingStroke: { color: '#6b5347', width: 0.45 },
    roofLines: null,
    shadow: null,
    hatch: null,
    wall: { fill: '#bcb1a6', stroke: '#4a4038' },
    fields: {
      crop: shades('#f3f5e8', '#eff3e2'),
      pasture: shades('#ecf2de'),
      orchard: shades('#e5eed4'),
      paddy: shades('#e4efe9'),
      vineyard: shades('#edefdb'),
      garden: shades('#e7efd6'),
      meadow: shades('#edf3df'),
    },
    furrow: { color: '#8a9676', alpha: 0.16 },
    green: { park: '#cfe5b4', garden: '#d8eac0', cemetery: '#d9e3c9', courtyard: '#e3edd2' },
    tree: { fill: '#a9d08a', dark: '#5e8f4a', stroke: '#4d7a3c', darkAlpha: 0.4 },
    magic: '#8a4fb0',
    label: { color: '#222222', halo: '#fbfaf6', water: '#1f6fae', district: '#5a5550' },
    font: { title: '"Source Sans 3", "Noto Sans SC", sans-serif', label: '"Source Sans 3", "Noto Sans SC", sans-serif', italic: 'italic "Source Sans 3", "Noto Sans SC", sans-serif' },
    blockStroke: { color: '#9a8f84', alpha: 0.6, width: 0.4 },
    waterEdge: '#2f7fbf',
    brushTitle: false,
  },
]

export function settleTheme(id: string): SettleTheme {
  return SETTLE_THEMES.find((t) => t.id === id) ?? SETTLE_THEMES[0]
}
