/**
 * 沙盘的植被：实例数据。纯函数，可在 Worker 中运行。
 *
 * 生成器只给出树的位置与冠径；树种由所处的环境推定——文明、气候、所在的田块（果园）、绿地（园林、墓地）、
 * 片区（寺社、宫城、城里的院子、野地）、离水与离路的距离（河边的柳、行道树）、海拔与坡度（山上的针叶林），
 * 野地里再按低频噪声成片（同一片林子以一两个树种为主）。个体的大小、高矮、叶色随位置哈希与所在林分变化：
 * 密林里的树高而挤，林缘与孤树矮而开张。
 *
 * 实例化时再做一道剔除：落进房子、路面、水里的不要（与它们的生卒对照：后来才盖的房子只截短树的寿命），
 * 贴着房子的树收小树冠或换成窄冠的树种，免得枝叶穿墙。
 * 另外补上生成器里没有的矮植被（见 lowPlants）：林下与院角的灌木、水边的芦苇、田埂与园圃的绿篱、葡萄园的藤架。
 */
import type { Life } from '../../settlement/history'
import type { Culture, Settlement } from '../../settlement/types'
import { NEVER } from './mesh'
import { ACCENT, SP, SPECIES, SPECIES_NAMES } from './treeSpecies'

/** 实例的两个缓冲的步长：浮点 6 个（x, 地面高, z, 冠径, 出生人口, 消亡人口），字节 12 个（见 push） */
export const INST_F = 6
export const INST_B = 12
/** 细格的边长（米）：近景按格收集视点附近的实例 */
const CELL = 32

/** 一组实例，按细格排好（同一分块的格相邻），供远景分块绘制与近景按格收集 */
export interface TreeSet {
  inst: Float32Array
  attr: Uint8Array
  count: number
  /** 细格：边长（米）、每个分块一边的格数、分块的列数与行数 */
  cell: number
  per: number
  cnx: number
  cnz: number
  /** start[k] 为第 k 格的首个实例（k = 分块号 × per² + 块内格号，长度为格数 + 1） */
  start: Uint32Array
  /** 每格的地面高程范围（最低、最高） */
  yr: Float32Array
}

export interface TreeBuild {
  /** 乔木：远景按分块画回转体 */
  trees: TreeSet
  /** 灌木、芦苇、绿篱、藤架：只在近处画 */
  low: TreeSet
  /** 各树形的棵数（调试与截图工具的概况） */
  species: [string, number][]
}

type Season = 'spring' | 'summer' | 'autumn'

/** 树种：树形 + 叶色（两端之间取）+ 相对生成器冠径的大小 + 高矮范围；春、秋另有叶色，accent 为花果的点缀 */
interface Variety {
  sp: number
  col: [string, string]
  spring?: [string, string]
  autumn?: [string, string]
  accent?: number
  /** 点缀只在这些季节出现（缺省全年） */
  accentIn?: Season[]
  size: number
  h: [number, number]
}

const V = {
  oak: { sp: SP.oak, col: ['#41532c', '#526434'], size: 0.92, h: [0.3, 0.7] },
  linden: { sp: SP.oak, col: ['#4a5e30', '#5b6e39'], size: 0.88, h: [0.5, 0.9] },
  sophora: { sp: SP.oak, col: ['#4e6233', '#61743d'], size: 0.9, h: [0.35, 0.7] },
  camphor: { sp: SP.oak, col: ['#384c2a', '#465a30'], size: 0.95, h: [0.25, 0.6] },
  plane: { sp: SP.oak, col: ['#4f6235', '#60713f'], size: 1, h: [0.5, 0.9] },
  holm: { sp: SP.oak, col: ['#34452a', '#405330'], size: 0.75, h: [0.1, 0.4] },
  elm: { sp: SP.poplar, col: ['#4e6332', '#60743c'], size: 0.95, h: [0.3, 0.8] },
  birch: { sp: SP.poplar, col: ['#5c713d', '#6f8247'], size: 0.82, h: [0.3, 0.7] },
  ginkgo: { sp: SP.poplar, col: ['#536933', '#667a3d'], autumn: ['#c99c2b', '#ddb53c'], size: 0.9, h: [0.3, 0.75] },
  cypress: { sp: SP.cypress, col: ['#2b3928', '#35452d'], size: 0.85, h: [0.3, 0.9] },
  yew: { sp: SP.cypress, col: ['#263228', '#2f3e2c'], size: 1.3, h: [0, 0.2] },
  lombardy: { sp: SP.cypress, col: ['#485d31', '#566c39'], size: 1, h: [0.55, 1] },
  spruce: { sp: SP.spruce, col: ['#2a3c2e', '#354933'], size: 0.9, h: [0.3, 0.8] },
  fir: { sp: SP.spruce, col: ['#293b32', '#334637'], size: 0.95, h: [0.2, 0.7] },
  sugi: { sp: SP.spruce, col: ['#30452c', '#3b5131'], size: 0.85, h: [0.5, 1] },
  pine: { sp: SP.pine, col: ['#33492f', '#3f5435'], size: 0.9, h: [0.3, 0.8] },
  blackpine: { sp: SP.pine, col: ['#2b3f2b', '#354a2f'], size: 0.88, h: [0.15, 0.6] },
  stonepine: { sp: SP.pine, col: ['#39502f', '#445d34'], size: 1, h: [0.6, 1] },
  willow: { sp: SP.willow, col: ['#60733f', '#74864c'], size: 1, h: [0.3, 0.7] },
  palm: { sp: SP.palm, col: ['#475d34', '#566c3c'], size: 0.95, h: [0.25, 1] },
  apple: { sp: SP.fruit, col: ['#466031', '#546e38'], accent: ACCENT.red, size: 0.95, h: [0.3, 0.7] },
  pear: { sp: SP.fruit, col: ['#4e663a', '#5c7442'], size: 0.92, h: [0.5, 0.9] },
  citrus: { sp: SP.fruit, col: ['#2f492a', '#395630'], accent: ACCENT.orange, size: 0.9, h: [0.2, 0.6] },
  olive: { sp: SP.fruit, col: ['#646d56', '#788068'], size: 1.05, h: [0.2, 0.6] },
  pomegranate: { sp: SP.fruit, col: ['#3f592e', '#4d6836'], accent: ACCENT.red, size: 0.85, h: [0.3, 0.7] },
  fig: { sp: SP.fruit, col: ['#3b5331', '#455f36'], size: 1.1, h: [0.1, 0.5] },
  peach: { sp: SP.fruit, col: ['#4c6738', '#5b7540'], spring: ['#d99aab', '#eab6c2'], accent: ACCENT.red, accentIn: ['summer'], size: 0.92, h: [0.3, 0.7] },
  persimmon: { sp: SP.fruit, col: ['#445d30', '#526b38'], autumn: ['#a36a2b', '#b98233'], accent: ACCENT.orange, accentIn: ['autumn'], size: 1, h: [0.4, 0.9] },
  ume: { sp: SP.ornamental, col: ['#4b6336', '#597241'], spring: ['#e2d5d9', '#eec3cf'], size: 0.85, h: [0.2, 0.6] },
  sakura: { sp: SP.ornamental, col: ['#496336', '#58723e'], spring: ['#e8bccb', '#f3d6de'], autumn: ['#aa5e2c', '#bf7835'], size: 1, h: [0.3, 0.8] },
  maple: { sp: SP.ornamental, col: ['#506932', '#617a3c'], spring: ['#6c813d', '#7f9148'], autumn: ['#a03020', '#c65422'], size: 0.92, h: [0.3, 0.8] },
  redmaple: { sp: SP.ornamental, col: ['#76332a', '#8c402c'], autumn: ['#9e2c1e', '#b83d1f'], size: 0.8, h: [0.2, 0.6] },
  hawthorn: { sp: SP.ornamental, col: ['#496233', '#58713c'], size: 0.9, h: [0.2, 0.7] },
  bamboo: { sp: SP.bamboo, col: ['#617740', '#74894c'], size: 0.8, h: [0.3, 0.9] },
  shrub: { sp: SP.shrub, col: ['#3e522d', '#4f6437'], size: 1, h: [0.2, 0.8] },
  maquis: { sp: SP.shrub, col: ['#495539', '#5d6648'], size: 1, h: [0.1, 0.6] },
  azalea: { sp: SP.shrub, col: ['#405730', '#4f6638'], spring: ['#c9537a', '#de7f9c'], size: 1, h: [0.1, 0.5] },
  reed: { sp: SP.reed, col: ['#7b7c4d', '#a39a5c'], autumn: ['#a8935a', '#bda56a'], size: 1, h: [0.2, 1] },
  hedge: { sp: SP.hedge, col: ['#3b4f2c', '#485d33'], size: 1, h: [0.3, 0.5] },
  hedgerow: { sp: SP.hedge, col: ['#42562e', '#536637'], size: 1, h: [0.5, 1] },
  vine: { sp: SP.vine, col: ['#4f6b34', '#627b3e'], autumn: ['#9a7a2c', '#b0553a'], size: 1, h: [0, 0.3] },
} satisfies Record<string, Variety>
type VK = keyof typeof V

/** 所处的环境 */
type Ctx = 'wild' | 'upland' | 'field' | 'water' | 'cemetery' | 'park' | 'yard' | 'sacred' | 'court'
type Mix = [VK, number][]

/** 各文明、各环境里的树种与权重（野地的权重再乘上各树种的成片噪声） */
const MIX: Record<Culture, Record<Ctx, Mix>> = {
  western: {
    wild: [['oak', 5], ['linden', 2], ['elm', 3], ['birch', 1.2], ['spruce', 0.8], ['pine', 0.6], ['hawthorn', 0.5]],
    upland: [['spruce', 5], ['fir', 2.5], ['pine', 2], ['birch', 1.5], ['oak', 1]],
    field: [['oak', 6], ['elm', 2], ['linden', 1.5], ['hawthorn', 0.8]],
    water: [['willow', 4], ['elm', 3], ['oak', 1], ['birch', 1]],
    cemetery: [['yew', 4], ['cypress', 3], ['oak', 1]],
    park: [['oak', 2], ['linden', 2.5], ['plane', 1.5], ['hawthorn', 1.2], ['cypress', 0.8], ['elm', 1], ['yew', 0.6]],
    yard: [['apple', 3], ['pear', 1.5], ['hawthorn', 1.2], ['linden', 1.5], ['elm', 1]],
    sacred: [['yew', 2], ['linden', 3], ['oak', 2], ['cypress', 1]],
    court: [['oak', 2], ['linden', 2.5], ['cypress', 1.5], ['plane', 1.5], ['yew', 0.8]],
  },
  eastern: {
    wild: [['sophora', 3], ['camphor', 2.5], ['elm', 3], ['pine', 2.2], ['bamboo', 1.6], ['sugi', 0.8], ['maple', 0.5]],
    upland: [['pine', 5], ['sugi', 3], ['camphor', 1.5], ['bamboo', 1.2], ['maple', 0.8], ['cypress', 1]],
    field: [['elm', 3], ['sophora', 3], ['willow', 1], ['camphor', 1]],
    water: [['willow', 7], ['elm', 1], ['bamboo', 1], ['peach', 0.8]],
    cemetery: [['cypress', 5], ['pine', 3]],
    park: [['pine', 3], ['willow', 1.5], ['ume', 1.5], ['maple', 1.2], ['bamboo', 2], ['ginkgo', 1.5], ['sophora', 2], ['cypress', 1]],
    yard: [['sophora', 3], ['pomegranate', 1.5], ['persimmon', 1.5], ['bamboo', 1], ['ume', 1], ['elm', 1]],
    sacred: [['pine', 3], ['cypress', 3], ['ginkgo', 3], ['sophora', 1]],
    court: [['pine', 3], ['cypress', 3], ['sophora', 2], ['ume', 1], ['ginkgo', 1]],
  },
  wa: {
    wild: [['camphor', 3], ['sugi', 3], ['pine', 2], ['sakura', 0.8], ['maple', 0.9], ['bamboo', 1.5], ['elm', 1.5]],
    upland: [['sugi', 6], ['fir', 1.5], ['pine', 2], ['camphor', 1], ['maple', 1.2]],
    field: [['camphor', 2], ['pine', 2], ['persimmon', 1.5], ['elm', 1.5]],
    water: [['willow', 4], ['sakura', 3], ['pine', 1], ['maple', 0.8]],
    cemetery: [['sugi', 3], ['pine', 2], ['sakura', 1], ['camphor', 1]],
    park: [['blackpine', 4], ['maple', 2.5], ['redmaple', 0.7], ['sakura', 3], ['bamboo', 1.2], ['sugi', 1], ['ume', 1]],
    yard: [['blackpine', 2], ['persimmon', 2], ['maple', 1.5], ['sakura', 1], ['bamboo', 1], ['ume', 1]],
    sacred: [['sugi', 5], ['camphor', 1.5], ['blackpine', 2], ['sakura', 2], ['maple', 2], ['ginkgo', 1]],
    court: [['blackpine', 5], ['sakura', 3], ['maple', 1.5], ['camphor', 1]],
  },
  islamic: {
    wild: [['olive', 2], ['pine', 2], ['cypress', 1.5], ['holm', 2.5], ['palm', 1.2], ['fig', 0.6]],
    upland: [['pine', 3], ['cypress', 2], ['holm', 2.5], ['yew', 1]],
    field: [['olive', 3], ['palm', 2], ['fig', 1.5], ['holm', 1]],
    water: [['palm', 5], ['willow', 1], ['elm', 2], ['fig', 1]],
    cemetery: [['cypress', 6], ['olive', 1]],
    park: [['cypress', 3], ['citrus', 3], ['palm', 2], ['pomegranate', 1], ['plane', 1.5], ['elm', 1]],
    yard: [['citrus', 2], ['fig', 2], ['palm', 1.5], ['pomegranate', 1], ['olive', 1]],
    sacred: [['cypress', 3], ['plane', 2], ['palm', 2], ['citrus', 1]],
    court: [['cypress', 3], ['palm', 2.5], ['citrus', 2], ['plane', 1.5]],
  },
}
/** 行道树（整条路一个树种）、果园（整块田一个树种）、窄处（贴着房子、树冠放不开）的树种 */
const AVENUE: Record<Culture, VK[]> = {
  western: ['linden', 'lombardy', 'plane', 'linden'],
  eastern: ['sophora', 'willow', 'elm', 'sophora'],
  wa: ['blackpine', 'sakura', 'sugi', 'sakura'],
  islamic: ['palm', 'cypress', 'plane', 'palm'],
}
const ORCHARD: Record<Culture, VK[]> = {
  western: ['apple', 'apple', 'pear', 'olive'],
  eastern: ['peach', 'pear', 'persimmon', 'citrus'],
  wa: ['ume', 'persimmon', 'peach', 'citrus'],
  islamic: ['citrus', 'olive', 'pomegranate', 'palm', 'fig'],
}
const NARROW: Record<Culture, VK> = { western: 'lombardy', eastern: 'cypress', wa: 'sugi', islamic: 'cypress' }
/** 没有世界气候时各文明的年均温 */
const TEMP: Record<Culture, number> = { western: 10, eastern: 14, wa: 14, islamic: 20 }

/** 气候对树种的取舍：椰枣与柑橘怕冷，云杉、冷杉喜冷 */
function climate(k: VK, temp: number): number {
  const sp = V[k].sp
  if (sp === SP.palm) return temp < 14 ? 0 : 1
  if (k === 'citrus' || k === 'olive' || k === 'pomegranate' || k === 'fig') return temp < 11 ? 0.15 : 1
  if (k === 'spruce' || k === 'fir') return Math.min(2.5, Math.max(0.15, 1.6 - (temp - 8) * 0.12))
  if (k === 'cypress' || k === 'stonepine' || k === 'holm') return temp < 7 ? 0.3 : 1
  if (sp === SP.bamboo) return temp < 9 ? 0.1 : 1
  return 1
}

// —— 哈希与噪声（按位置，确定性） ——
const ih = (x: number, y: number, s: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
/** 一棵树的第 s 个随机数（位置取到 1/8 米） */
const hashAt = (x: number, z: number, s: number) => ih(Math.round(x * 8), Math.round(z * 8), s)
function vnoise(x: number, y: number, s: number) {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const u = x - i
  const v = y - j
  const a = u * u * (3 - 2 * u)
  const b = v * v * (3 - 2 * v)
  return (ih(i, j, s) * (1 - a) + ih(i + 1, j, s) * a) * (1 - b) + (ih(i, j + 1, s) * (1 - a) + ih(i + 1, j + 1, s) * a) * b
}
const strHash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const hexRGB = (s: string): [number, number, number] => {
  const n = parseInt(s.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

type Pt = [number, number]
/** 均匀网格上的空间索引：按包围盒登记，按点查候选 */
class Grid<T> {
  private cells: T[][]
  private nx: number
  private nz: number
  constructor(
    w: number,
    h: number,
    private size: number,
  ) {
    this.nx = Math.ceil(w / size) + 1
    this.nz = Math.ceil(h / size) + 1
    this.cells = new Array(this.nx * this.nz)
  }
  add(x0: number, z0: number, x1: number, z1: number, item: T) {
    const i0 = Math.max(0, Math.floor(x0 / this.size))
    const i1 = Math.min(this.nx - 1, Math.floor(x1 / this.size))
    const j0 = Math.max(0, Math.floor(z0 / this.size))
    const j1 = Math.min(this.nz - 1, Math.floor(z1 / this.size))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (this.cells[j * this.nx + i] ??= []).push(item)
  }
  addPoly(poly: Pt[], pad: number, item: T) {
    let x0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let z1 = -Infinity
    for (const p of poly) {
      if (p[0] < x0) x0 = p[0]
      if (p[0] > x1) x1 = p[0]
      if (p[1] < z0) z0 = p[1]
      if (p[1] > z1) z1 = p[1]
    }
    this.add(x0 - pad, z0 - pad, x1 + pad, z1 + pad, item)
  }
  at(x: number, z: number): T[] | undefined {
    const i = Math.floor(x / this.size)
    const j = Math.floor(z / this.size)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return undefined
    return this.cells[j * this.nx + i]
  }
}

const inPoly = (x: number, z: number, poly: Pt[]) => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}
const segD = (x: number, z: number, a: Pt, b: Pt) => {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const l = dx * dx + dz * dz
  const t = l > 0 ? clamp01(((x - a[0]) * dx + (z - a[1]) * dz) / l) : 0
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t)
}
/** 点到多边形的距离（在里面为 0） */
const polyD = (x: number, z: number, poly: Pt[]) => {
  if (inPoly(x, z, poly)) return 0
  let d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segD(x, z, poly[j], poly[i]))
  return d
}

interface Span {
  born: number
  died: number
}
const ALWAYS: Span = { born: 0, died: Infinity }

/** 实例的写入缓冲：收齐后按细格排序 */
class Bag {
  f: number[] = []
  b: number[] = []
  counts = new Array<number>(SPECIES.length).fill(0)
  /**
   * 一个实例：位置、冠径（米）、生卒、树形、点缀、高矮（0 ~ 1）、郁闭度（0 ~ 1）、
   * 随机数（朝向固定的树形是朝向 / 2π）、叶色、第二个随机数、地面坡度
   */
  push(x: number, y: number, z: number, r: number, life: Span, sp: number, accent: number, hs: number, crowd: number, seed: number, col: [number, number, number], seed2: number, sx: number, sz: number) {
    this.f.push(x, y, z, r, life.born, life.died === Infinity ? NEVER : life.died)
    const q = (v: number) => Math.round(clamp01(v) * 255)
    this.b.push(sp + accent * 16, q(hs), q(crowd), q(seed), col[0], col[1], col[2], q(seed2), Math.round(128 + Math.max(-1.27, Math.min(1.27, sx)) * 100), Math.round(128 + Math.max(-1.27, Math.min(1.27, sz)) * 100), 0, 0)
    this.counts[sp]++
  }
  /** 按细格排序：分块号在前（同一分块的格相邻，远景按分块取一段连续的实例） */
  finish(W: number, D: number): TreeSet {
    const n = this.f.length / INST_F
    const nx = Math.max(1, Math.ceil(W / CELL))
    const nz = Math.max(1, Math.ceil(D / CELL))
    const per = Math.max(1, Math.ceil(Math.max(nx, nz) / 10))
    const cnx = Math.ceil(nx / per)
    const cnz = Math.ceil(nz / per)
    const cells = cnx * cnz * per * per
    const key = new Uint32Array(n)
    const start = new Uint32Array(cells + 1)
    for (let i = 0; i < n; i++) {
      const ci = Math.min(nx - 1, Math.max(0, Math.floor(this.f[i * INST_F] / CELL)))
      const cj = Math.min(nz - 1, Math.max(0, Math.floor(this.f[i * INST_F + 2] / CELL)))
      const k = (Math.floor(cj / per) * cnx + Math.floor(ci / per)) * per * per + (cj % per) * per + (ci % per)
      key[i] = k
      start[k + 1]++
    }
    for (let k = 0; k < cells; k++) start[k + 1] += start[k]
    const at = start.slice(0, cells)
    const inst = new Float32Array(n * INST_F)
    const attr = new Uint8Array(n * INST_B)
    const yr = new Float32Array(cells * 2)
    for (let k = 0; k < cells; k++) {
      yr[k * 2] = Infinity
      yr[k * 2 + 1] = -Infinity
    }
    for (let i = 0; i < n; i++) {
      const k = key[i]
      const o = at[k]++
      for (let c = 0; c < INST_F; c++) inst[o * INST_F + c] = this.f[i * INST_F + c]
      for (let c = 0; c < INST_B; c++) attr[o * INST_B + c] = this.b[i * INST_B + c]
      const y = this.f[i * INST_F + 1]
      if (y < yr[k * 2]) yr[k * 2] = y
      if (y > yr[k * 2 + 1]) yr[k * 2 + 1] = y
    }
    return { inst, attr, count: n, cell: CELL, per, cnx, cnz, start, yr }
  }
}

/** 近景网格里树冠的半径（冠径单位）：贴着房子时按它收小 */
const CROWN = SPECIES.map((s) => Math.max(...s.profile.map((p) => p[0])))

export function treeInstances(st: Settlement, life: Map<object, Life>, H: (x: number, z: number) => number): TreeBuild {
  const culture = st.params.culture
  const W = st.width
  const D = st.height
  const T = st.terrain
  const temp = st.params.climate?.temp ?? TEMP[culture]
  const seed = strHash(st.params.seed) & 0xffff
  // 季相：东方与和式的城按种子定春、夏、秋（花色与秋色只是点缀：樱、梅、枫、银杏、柿），其余常夏
  const sr = ih(seed, 7, 3)
  const season: Season = culture === 'wa' || culture === 'eastern' ? (sr < 0.36 ? 'spring' : sr < 0.66 ? 'summer' : 'autumn') : 'summer'
  const span = (o: object): Span => life.get(o) ?? ALWAYS
  const water = (x: number, z: number) => {
    const fx = Math.min(T.W - 1.001, Math.max(0, x / T.cell))
    const fz = Math.min(T.H - 1.001, Math.max(0, z / T.cell))
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const u = fx - i
    const v = fz - j
    const k = j * T.W + i
    return (T.water[k] * (1 - u) + T.water[k + 1] * u) * (1 - v) + (T.water[k + T.W] * (1 - u) + T.water[k + T.W + 1] * u) * v
  }

  // —— 空间索引 ——
  const bGrid = new Grid<{ poly: Pt[]; life: Span }>(W, D, 16)
  for (const b of st.buildings) if (b.kind !== 'torii') bGrid.addPoly(b.poly, 9, { poly: b.poly, life: span(b) })
  const rGrid = new Grid<{ a: Pt; b: Pt; hw: number; id: number; main: boolean; life: Span }>(W, D, 16)
  st.roads.forEach((r, id) => {
    const l = span(r)
    const main = r.kind === 'highway' || r.kind === 'main'
    for (let i = 0; i + 1 < r.line.length; i++) {
      const a = r.line[i]
      const b = r.line[i + 1]
      const pad = r.width / 2 + 3
      rGrid.add(Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad, { a, b, hw: r.width / 2, id, main, life: l })
    }
  })
  const fGrid = new Grid<{ poly: Pt[]; kind: string; id: number }>(W, D, 32)
  st.fields.forEach((f, id) => fGrid.addPoly(f.poly, 0, { poly: f.poly, kind: f.kind, id }))
  const gGrid = new Grid<{ poly: Pt[]; kind: string }>(W, D, 32)
  for (const g of st.greens) gGrid.addPoly(g.poly, 0, g)
  const wGrid = new Grid<{ poly: Pt[]; type: string }>(W, D, 64)
  for (const w of st.wards) wGrid.addPoly(w.poly, 0, w)
  const pGrid = new Grid<{ poly: Pt[]; life: Span }>(W, D, 32)
  for (const p of st.plazas) pGrid.addPoly(p, 0, { poly: p, life: span(p) })

  // 树的疏密：12 米格里的棵数（3 × 3 格的和是 36 米见方里的棵数）
  const DC = 12
  const dnx = Math.ceil(W / DC) + 1
  const dnz = Math.ceil(D / DC) + 1
  const dens = new Uint16Array(dnx * dnz)
  for (const t of st.trees) {
    const i = Math.floor(t.p[0] / DC)
    const j = Math.floor(t.p[1] / DC)
    if (i >= 0 && j >= 0 && i < dnx && j < dnz) dens[j * dnx + i]++
  }
  const around = (x: number, z: number) => {
    const i = Math.floor(x / DC)
    const j = Math.floor(z / DC)
    let near = 0
    let wide = 0
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const a = i + di
        const b = j + dj
        if (a < 0 || b < 0 || a >= dnx || b >= dnz) continue
        const n = dens[b * dnx + a]
        wide += n
        if (!di && !dj) near = n
      }
    return { near, wide }
  }

  const pickMix = (mix: Mix, x: number, z: number, h: number, stands: boolean): VK => {
    let total = 0
    const ws: number[] = []
    for (let i = 0; i < mix.length; i++) {
      let w = mix[i][1] * climate(mix[i][0], temp)
      // 成片：每个树种一张低频噪声，高处权重大，同一片林子以一两个树种为主
      if (stands && w > 0) {
        const n = vnoise(x / 150 + i * 7.3, z / 150 - i * 3.1, seed + i * 17)
        w *= 0.08 + 3.4 * n * n * n
      }
      ws.push(w)
      total += w
    }
    if (total <= 0) return 'oak'
    let t = h * total
    for (let i = 0; i < mix.length; i++) {
      t -= ws[i]
      if (t <= 0) return mix[i][0]
    }
    return mix[mix.length - 1][0]
  }
  const colour = (v: Variety, x: number, z: number, h: number, tone: number): [number, number, number] => {
    const pair = (season === 'spring' && v.spring) || (season === 'autumn' && v.autumn) || v.col
    const a = hexRGB(pair[0])
    const b = hexRGB(pair[1])
    // 明度：个体的随机与所在一片的起伏
    const k = (0.9 + 0.2 * hashAt(x, z, 11)) * tone
    return [0, 1, 2].map((c) => Math.round(Math.min(255, (a[c] + (b[c] - a[c]) * h) * k))) as [number, number, number]
  }
  const accentOf = (v: Variety) => (v.accent && (!v.accentIn || v.accentIn.includes(season)) ? v.accent : 0)

  const bag = new Bag()
  const low = new Bag()
  /** 留下的乔木（位置、冠的半径、环境）：补灌木时用 */
  const kept: { x: number; z: number; r: number; ctx: Ctx; life: Span; crowd: number }[] = []

  for (const t of st.trees) {
    const [x, z] = t.p
    if (x < 1 || z < 1 || x > W - 1 || z > D - 1) continue
    const wd = water(x, z)
    // 树干不站在水边线上（树冠可以探到水面上）
    if (wd < 0.8 + t.r * 0.15) continue
    const l0 = span(t)
    let born = l0.born
    let died = l0.died

    // 落进房子、路面里的不要；后来才盖、才开的只截短寿命。顺带量出离最近的房子多远
    let bDist = Infinity
    let gone = false
    const bs = bGrid.at(x, z)
    if (bs)
      for (const b of bs) {
        if (b.life.born >= died || b.life.died <= born) continue
        const d = polyD(x, z, b.poly)
        if (d < 1.1) {
          if (b.life.born > born) died = Math.min(died, b.life.born)
          else gone = true
        } else if (d < bDist) bDist = d
      }
    let avenue = -1
    let rGap = Infinity
    const rs = rGrid.at(x, z)
    if (rs && !gone)
      for (const r of rs) {
        if (r.life.born >= died || r.life.died <= born) continue
        const g = segD(x, z, r.a, r.b) - r.hw
        if (g < 0.15) {
          if (r.life.born > born) died = Math.min(died, r.life.born)
          else gone = true
        }
        if (g < rGap) {
          rGap = g
          if (r.main && g < 1.7) avenue = r.id
        }
      }
    if (gone || died <= born) continue
    const lf: Span = { born, died }

    // —— 环境 ——
    const y = H(x, z)
    const sx = (H(x + 3, z) - H(x - 3, z)) / 6
    const sz = (H(x, z + 3) - H(x, z - 3)) / 6
    const slope = Math.hypot(sx, sz)
    const { near, wide } = around(x, z)
    const crowd = clamp01((wide - 1) / 14)
    let field: { kind: string; id: number } | null = null
    for (const f of fGrid.at(x, z) ?? [])
      if (inPoly(x, z, f.poly)) {
        field = f
        break
      }
    let green = ''
    for (const g of gGrid.at(x, z) ?? [])
      if (inPoly(x, z, g.poly)) {
        green = g.kind
        break
      }
    let ward = ''
    for (const w of wGrid.at(x, z) ?? [])
      if (inPoly(x, z, w.poly)) {
        ward = w.type
        break
      }
    let paved = false
    for (const p of pGrid.at(x, z) ?? []) if (inPoly(x, z, p.poly)) paved = true

    const h1 = hashAt(x, z, 1)
    const h2 = hashAt(x, z, 2)
    const h3 = hashAt(x, z, 3)
    const h4 = hashAt(x, z, 4)
    let vk: VK
    let ctx: Ctx
    let row = false
    if (field?.kind === 'orchard') {
      // 果园：整块田一个树种，大小一律
      const list = ORCHARD[culture].filter((k) => climate(k, temp) >= 1)
      vk = list.length ? list[Math.floor(ih(field.id, seed, 5) * list.length)] : 'apple'
      ctx = 'field'
      row = true
    } else if (green === 'cemetery' || ward === 'cemetery') {
      ctx = 'cemetery'
      vk = pickMix(MIX[culture].cemetery, x, z, h1, false)
    } else if (avenue >= 0 && t.r < 3.2 && !green) {
      // 行道树：整条路一个树种
      const list = AVENUE[culture].filter((k) => climate(k, temp) >= 1)
      vk = list.length ? list[Math.floor(ih(avenue, seed, 6) * list.length)] : 'linden'
      ctx = 'yard'
      row = true
    } else {
      const urban = ward && ward !== 'wild' && ward !== 'farm' && ward !== 'water'
      if (ward === 'temple') ctx = 'sacred'
      else if (ward === 'castle' || ward === 'noble') ctx = green ? 'park' : 'court'
      else if (green === 'park' || green === 'garden' || ward === 'park') ctx = 'park'
      else if (wd < 14 && !urban) ctx = 'water'
      else if (green === 'courtyard' || urban || paved) ctx = 'yard'
      else if (field || ward === 'farm') ctx = 'field'
      else ctx = sstep(30, 90, y) + slope * 1.6 + (vnoise(x / 90, z / 90, seed + 91) - 0.5) * 0.5 > 0.55 ? 'upland' : 'wild'
      // 园林里靠水的多栽柳（东方）、樱（和式）
      if ((ctx === 'park' || ctx === 'court' || ctx === 'sacred') && wd < 9 && h4 < 0.6 && culture !== 'islamic') vk = culture === 'wa' ? (h1 < 0.5 ? 'sakura' : 'willow') : 'willow'
      else vk = pickMix(MIX[culture][ctx], x, z, h1, ctx === 'wild' || ctx === 'upland')
    }
    let v: Variety = V[vk]

    // —— 大小 ——
    const forest = ctx === 'wild' || ctx === 'upland'
    // 林冠的起伏：一片高一片低；密林里的树挤着长高，林缘与孤树矮而开张
    const stand = vnoise(x / 70, z / 70, seed + 33)
    let r = t.r * v.size
    let hs = v.h[0] + (v.h[1] - v.h[0]) * h2
    if (row) {
      r = t.r * v.size * (0.94 + 0.12 * h2)
      hs = (v.h[0] + v.h[1]) / 2 + (h3 - 0.5) * 0.12
    } else if (forest) {
      r *= (0.8 + 0.4 * stand) * (0.86 + 0.3 * crowd)
      hs = clamp01(hs + 0.3 * (crowd - 0.4) + 0.25 * (stand - 0.5))
    } else if (ctx === 'field') {
      r *= 1.08
      hs = clamp01(hs - 0.15)
    }
    // 贴着房子：树冠收到够不着墙；收得太多就换窄冠的树种，再放不下的不要
    const room = bDist + 0.5
    if (v.sp !== SP.palm && r * CROWN[v.sp] > room) {
      let k = room / (r * CROWN[v.sp])
      if (k < 0.62) {
        v = V[NARROW[culture]]
        r = t.r * v.size
        hs = v.h[0] + (v.h[1] - v.h[0]) * h2
        k = Math.min(1, room / (r * CROWN[v.sp]))
        if (k < 0.55) continue
      }
      r *= k
    }
    // 树冠不伸出沙盘
    const m = r * CROWN[v.sp] * 0.85
    if (x < m || z < m || x > W - m || z > D - m) continue

    const tone = forest ? 0.9 + 0.2 * vnoise(x / 110, z / 110, seed + 57) : 0.96 + 0.08 * stand
    bag.push(x, y, z, r, lf, v.sp, accentOf(v), hs, forest ? Math.max(crowd, clamp01(near / 3) * 0.6) : crowd * 0.6, h3, colour(v, x, z, hashAt(x, z, 12), tone), h4, sx, sz)
    kept.push({ x, z, r: r * CROWN[v.sp], ctx, life: lf, crowd })
  }

  lowPlants(st, low, { H, water, span, kept, season, seed, temp, bGrid, rGrid, wGrid })
  const species: [string, number][] = []
  SPECIES_NAMES.forEach((n, i) => {
    const c = bag.counts[i] + low.counts[i]
    if (c) species.push([n, c])
  })
  return { trees: bag.finish(W, D), low: low.finish(W, D), species }
}

/**
 * 陈列：各树种排成一排排（每排一个树种，自西向东五棵，大小与随机数各不相同），中心在 (cx, cz)。
 * 检查页（scripts/town3d/）用它贴近看每一种树形
 */
export function treeSpecimens(st: Settlement, H: (x: number, z: number) => number, cx: number, cz: number): TreeBuild {
  const bag = new Bag()
  const low = new Bag()
  const keys = Object.keys(V) as VK[]
  const gap = 16
  keys.forEach((k, row) => {
    const v: Variety = V[k]
    const tall = v.sp !== SP.shrub && v.sp !== SP.reed && v.sp !== SP.hedge && v.sp !== SP.vine
    for (let i = 0; i < 5; i++) {
      const x = cx + (i - 2) * gap
      const z = cz + (row - keys.length / 2) * gap
      const a = hexRGB(v.col[0])
      const b = hexRGB(v.col[1])
      const h = i / 4
      const r = (tall ? 2.6 + i * 0.8 : 1 + i * 0.3) * v.size
      ;(tall ? bag : low).push(x, H(x, z), z, r, ALWAYS, v.sp, v.accent ?? 0, v.h[0] + (v.h[1] - v.h[0]) * h, i === 4 ? 0.8 : 0, hashAt(x, z, 3), [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * h)) as [number, number, number], hashAt(x, z, 4), 0, 0)
    }
  })
  return { trees: bag.finish(st.width, st.height), low: low.finish(st.width, st.height), species: keys.map((k) => [k, 5]) }
}

interface LowEnv {
  H: (x: number, z: number) => number
  water: (x: number, z: number) => number
  span: (o: object) => Span
  kept: { x: number; z: number; r: number; ctx: Ctx; life: Span; crowd: number }[]
  season: Season
  seed: number
  temp: number
  bGrid: Grid<{ poly: Pt[]; life: Span }>
  rGrid: Grid<{ a: Pt; b: Pt; hw: number; id: number; main: boolean; life: Span }>
  wGrid: Grid<{ poly: Pt[]; type: string }>
}

/** 一条直线（方向 angle，法向坐标 t）穿过多边形的各段：沿方向的 [起, 止] 参数（奇偶规则，凹多边形也对） */
function scan(poly: Pt[], ux: number, uz: number, t: number): [number, number][] {
  const vx = -uz
  const vz = ux
  const hits: number[] = []
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]
    const b = poly[i]
    const ta = a[0] * vx + a[1] * vz - t
    const tb = b[0] * vx + b[1] * vz - t
    if (ta > 0 === tb > 0) continue
    const k = ta / (ta - tb)
    hits.push((a[0] + (b[0] - a[0]) * k) * ux + (a[1] + (b[1] - a[1]) * k) * uz)
  }
  hits.sort((p, q) => p - q)
  const out: [number, number][] = []
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]])
  return out
}

/**
 * 生成器里没有的矮植被（见文件头）。生卒随它所依附的东西：灌木随树，绿篱、藤架随田块与园圃，芦苇一直在。
 * 都要离房子、路面、水留出空隙：房子后来才盖的只截短寿命
 */
function lowPlants(st: Settlement, low: Bag, env: LowEnv) {
  const { H, water, span, season, seed, temp, bGrid, rGrid, wGrid } = env
  const culture = st.params.culture
  const W = st.width
  const D = st.height
  const colour = (v: Variety, x: number, z: number) => {
    const pair = (season === 'spring' && v.spring) || (season === 'autumn' && v.autumn) || v.col
    const a = hexRGB(pair[0])
    const b = hexRGB(pair[1])
    const h = hashAt(x, z, 12)
    const k = 0.9 + 0.2 * hashAt(x, z, 11)
    return [0, 1, 2].map((c) => Math.round(Math.min(255, (a[c] + (b[c] - a[c]) * h) * k))) as [number, number, number]
  }
  /** 这一处放得下半径 rad 的矮植被吗：返回截短后的生卒，放不下为 null */
  const fit = (x: number, z: number, rad: number, l: Span): Span | null => {
    if (x < rad || z < rad || x > W - rad || z > D - rad) return null
    if (water(x, z) < 0.4 + rad * 0.5) return null
    let died = l.died
    for (const b of bGrid.at(x, z) ?? []) {
      if (b.life.born >= died || b.life.died <= l.born) continue
      if (polyD(x, z, b.poly) < rad + 0.3) {
        if (b.life.born > l.born) died = Math.min(died, b.life.born)
        else return null
      }
    }
    for (const r of rGrid.at(x, z) ?? []) {
      if (r.life.born >= died || r.life.died <= l.born) continue
      if (segD(x, z, r.a, r.b) - r.hw < rad * 0.8 + 0.2) {
        if (r.life.born > l.born) died = Math.min(died, r.life.born)
        else return null
      }
    }
    return died > l.born ? { born: l.born, died } : null
  }
  const slope = (x: number, z: number): [number, number] => [(H(x + 2, z) - H(x - 2, z)) / 4, (H(x, z + 2) - H(x, z - 2)) / 4]
  const put = (x: number, z: number, r: number, l: Span, v: Variety, seedA: number, hs = v.h[0] + (v.h[1] - v.h[0]) * hashAt(x, z, 2)) => {
    const [sx, sz] = slope(x, z)
    low.push(x, H(x, z), z, r, l, v.sp, 0, hs, 0, seedA, colour(v, x, z), hashAt(x, z, 4), sx, sz)
  }

  // —— 灌木：林缘与疏林里、园林与院子的树旁 ——
  const shrubOf = (ctx: Ctx, h: number): VK => {
    if (culture === 'islamic') return ctx === 'wild' || ctx === 'upland' || ctx === 'field' ? 'maquis' : h < 0.5 ? 'maquis' : 'shrub'
    if ((culture === 'wa' || culture === 'eastern') && (ctx === 'park' || ctx === 'sacred' || ctx === 'court')) return h < 0.6 ? 'azalea' : 'shrub'
    return 'shrub'
  }
  for (const t of env.kept) {
    const forest = t.ctx === 'wild' || t.ctx === 'upland'
    // 郁闭的林子里林下照不到光，灌木长在林缘与疏林；园林、院子里零星几丛
    const p = forest ? 0.55 * (1 - t.crowd) + 0.1 : t.ctx === 'park' || t.ctx === 'sacred' || t.ctx === 'court' ? 0.35 : t.ctx === 'water' ? 0.3 : t.ctx === 'yard' ? 0.12 : 0.15
    const n = hashAt(t.x, t.z, 21) < p ? (hashAt(t.x, t.z, 22) < 0.35 ? 2 : 1) : 0
    for (let k = 0; k < n; k++) {
      const a = hashAt(t.x, t.z, 23 + k) * Math.PI * 2
      const d = t.r * (0.75 + 0.6 * hashAt(t.x, t.z, 25 + k))
      const x = t.x + Math.cos(a) * d
      const z = t.z + Math.sin(a) * d
      const v: Variety = V[shrubOf(t.ctx, hashAt(x, z, 1))]
      const r = (0.7 + 0.8 * hashAt(x, z, 3)) * (forest ? 1.15 : 0.9)
      const l = fit(x, z, r, t.life)
      if (l) put(x, z, r, l, v, hashAt(x, z, 5))
    }
  }

  // —— 芦苇：水边一丛丛（城里砌了岸的不长） ——
  const T = st.terrain
  const reedV: Variety = V.reed
  for (let j = 1; j < T.H - 1; j++)
    for (let i = 1; i < T.W - 1; i++) {
      const w0 = T.water[j * T.W + i]
      if (w0 < -T.cell || w0 > T.cell * 1.5) continue
      // 每格试四处，成丛：低频噪声高处才长
      for (let s = 0; s < 4; s++) {
        const x = (i + hashAt(i, j, 31 + s * 2)) * T.cell
        const z = (j + hashAt(i, j, 32 + s * 2)) * T.cell
        const wd = water(x, z)
        if (wd < 0.3 || wd > 2.4) continue
        if (vnoise(x / 28, z / 28, seed + 71) < 0.42 || hashAt(x, z, 35) < 0.25) continue
        let urban = false
        for (const w of wGrid.at(x, z) ?? []) if (w.type !== 'wild' && w.type !== 'farm' && w.type !== 'water' && inPoly(x, z, w.poly)) urban = true
        if (urban) continue
        const r = 1.0 + 0.7 * hashAt(x, z, 36)
        const l = fit(x, z, r * 0.4, ALWAYS)
        if (l) put(x, z, r, l, reedV, hashAt(x, z, 5))
      }
    }

  // —— 沿线排布的：一段的半长为 r（网格沿 x 自 -1 到 1），首尾相接 ——
  const line = (a: Pt, b: Pt, r: number, l: Span, v: Variety, gap: number) => {
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const len = Math.hypot(dx, dz)
    const n = Math.floor(len / (2 * r * gap))
    if (n < 1) return
    const ang = (((Math.atan2(dz, dx) / (Math.PI * 2)) % 1) + 1) % 1
    const step = len / n
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) * step
      const x = a[0] + (dx / len) * t
      const z = a[1] + (dz / len) * t
      const s = fit(x, z, 0.5, l)
      if (s) put(x, z, (step / 2) / gap, s, v, ang)
    }
  }

  // 绿篱：西式牧场的树篱（相邻田块共用的边只种一道）、各文明城边菜园的矮篱、园林花坛的镶边
  const seen = new Set<string>()
  const key = (a: Pt, b: Pt) => {
    const p = `${Math.round(a[0])},${Math.round(a[1])}`
    const q = `${Math.round(b[0])},${Math.round(b[1])}`
    return p < q ? p + '|' + q : q + '|' + p
  }
  st.fields.forEach((f, id) => {
    const bocage = culture === 'western' && f.kind === 'pasture' && ih(id, seed, 41) < 0.7
    // 菜园的矮篱只有西式与和式的城边有（东方、伊斯兰的菜园是土埂与土墙）
    const kitchen = f.kind === 'garden' && (culture === 'western' || culture === 'wa') && ih(id, seed, 42) < 0.2
    if (!bocage && !kitchen) return
    const v: Variety = bocage ? V.hedgerow : V.hedge
    const r = bocage ? 1.15 : 0.6
    const l = span(f)
    for (let i = 0, j = f.poly.length - 1; i < f.poly.length; j = i++) {
      const k = key(f.poly[j], f.poly[i])
      if (seen.has(k)) continue
      seen.add(k)
      line(f.poly[j], f.poly[i], r, l, v, 0.96)
    }
  })
  for (const p of st.parkParts) {
    if (p.kind !== 'bed') continue
    const l = span(p)
    for (let i = 0, j = p.poly.length - 1; i < p.poly.length; j = i++) line(p.poly[j], p.poly[i], 0.45, l, V.hedge, 0.96)
  }

  // —— 葡萄园：顺着垄的方向一行行藤架（行距与二维地图的线一致） ——
  if (temp >= 7)
    for (const f of st.fields) {
      if (f.kind !== 'vineyard') continue
      const ux = Math.cos(f.angle)
      const uz = Math.sin(f.angle)
      let t0 = Infinity
      let t1 = -Infinity
      for (const p of f.poly) {
        const t = -p[0] * uz + p[1] * ux
        t0 = Math.min(t0, t)
        t1 = Math.max(t1, t)
      }
      const l = span(f)
      const r = 1.05
      for (let t = t0 + 1.6; t < t1; t += 3.2)
        for (const [s0, s1] of scan(f.poly, ux, uz, t)) {
          // 两头各让出一点：藤架不压田边
          const a: Pt = [(s0 + 1.2) * ux - t * uz, (s0 + 1.2) * uz + t * ux]
          const b: Pt = [(s1 - 1.2) * ux - t * uz, (s1 - 1.2) * uz + t * ux]
          line(a, b, r, l, V.vine, 0.98)
        }
    }
}
