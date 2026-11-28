import { Biome, reliefKm, type World } from '../../../gen/types'
import { blur } from '../../../gen/util'
import { rgb, type RGB } from '../../palette'
import { contourGrid, contours, type ContourGrid } from '../../../gen/contour'
import { pathData } from './path'
import type { DisplayList, Fill, Stroke } from './displayList'

/**
 * 矢量纸图的图层工具：把格点场追踪成填充与等值线的图层构建器（Layers）、与风格无关的预计算格点场、
 * 以及几种通用的画法（群系分层、晕渲、近岸水线）。各纸图风格的矢量底图（Theme.vector）用它们画，
 * 引擎在 ./vector.ts。
 */


export const FOREST = new Set<number>([Biome.Taiga, Biome.TemperateForest, Biome.TemperateRainforest, Biome.TropicalRainforest, Biome.TropicalSeasonalForest])

export interface LayerOpt {
  stroke?: Stroke
  filter?: string
  clip?: string
  tol?: number
  minArea?: number
}

/** 颜色或 url(#图案) → 填充 */
function toFill(color: string, alpha: number): Fill {
  return color.startsWith('url(') ? { pattern: color.slice(5, -1), alpha, rule: 'evenodd' } : { color, alpha, rule: 'evenodd' }
}

/** 以格为单位的矢量图层构建器：追踪出的路径直接写进显示列表（地图坐标空间） */
export class Layers {
  constructor(
    readonly list: DisplayList,
    readonly W: number,
    readonly H: number,
    readonly S: number,
  ) {}

  // 同一张场第二次被追踪时建网格（一次外扩 + 分块极值），之后的等级都复用；构建期间场不会被改写
  private grids = [new Map<ArrayLike<number>, ContourGrid | null>(), new Map<ArrayLike<number>, ContourGrid | null>()]
  private grid(field: ArrayLike<number>, closed: boolean) {
    const m = this.grids[closed ? 1 : 0]
    let g = m.get(field)
    if (g === undefined) m.set(field, null)
    else if (g === null) m.set(field, (g = contourGrid(field, this.W, this.H, closed)))
    return g ?? undefined
  }

  /** 填充"场 ≥ level"的区域 */
  fill(field: ArrayLike<number>, level: number, color: string, opacity = 1, o: LayerOpt = {}) {
    const d = pathData(contours(field, this.W, this.H, level, true, this.grid(field, true)), this.S, { closed: true, tol: o.tol ?? 0.35, minArea: o.minArea ?? 1.5 })
    this.list.path('map', d, { fill: toFill(color, opacity), stroke: o.stroke, filter: o.filter, clip: o.clip })
    return d
  }

  /** 等值线 */
  line(field: ArrayLike<number>, level: number, color: string, width: number, opacity = 1, dash?: number[], o: LayerOpt = {}) {
    const d = pathData(contours(field, this.W, this.H, level, false, this.grid(field, false)), this.S, { closed: true, tol: o.tol ?? 0.35, minArea: 0.8 })
    this.list.path('map', d, { stroke: { color, alpha: opacity, width, dash, cap: 'round', join: 'round' }, filter: o.filter })
  }

  /** 整个地图框的矩形 */
  rect(color: string, opacity = 1) {
    const w = this.W * this.S
    const h = this.H * this.S
    this.list.path('map', `M-10 -10L${w + 10} -10L${w + 10} ${h + 10}L-10 ${h + 10}Z`, { fill: toFill(color, opacity) })
  }
}

/**
 * 预计算的格点场（与风格无关，按世界缓存：切换风格不重算）。
 * 缓存的数组各风格共用，只读：追踪等值线不写场，要改的场（色带等）各风格自己另建
 */
export type VectorFields = ReturnType<typeof computeFields>
const fieldsCache = new WeakMap<World, VectorFields>()
export function fieldsOf(world: World): VectorFields {
  let F = fieldsCache.get(world)
  if (!F) fieldsCache.set(world, (F = computeFields(world)))
  return F
}

function computeFields(world: World) {
  const { W, H, elevation: e, biome, temperature: T } = world
  const km = reliefKm(world)
  const N = W * H
  const land = new Float32Array(N)
  const depth = new Float32Array(N)
  const lake = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    land[i] = e[i]
    depth[i] = -e[i]
    lake[i] = biome[i] === Biome.Lake ? 1 : 0
  }
  // 多方向晕渲（格尺度），只在陆地上
  const shade = new Float32Array(N).fill(1)
  const zf = 14
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (e[i] <= 0) continue
      const nx = (-(Math.max(0, e[i + 1]) - Math.max(0, e[i - 1])) / (2 * km)) * zf
      const ny = (-(Math.max(0, e[i + W]) - Math.max(0, e[i - W])) / (2 * km)) * zf
      const inv = 1 / Math.hypot(nx, ny, 1)
      const l1 = ((nx * -0.6 + ny * -0.6 + 0.53) * inv) / 0.53
      const l2 = ((nx * -0.85 + ny * 0.1 + 0.52) * inv) / 0.52
      const l3 = ((nx * -0.1 + ny * -0.85 + 0.52) * inv) / 0.52
      shade[i] = Math.min(1.12, Math.max(0.38, l1 * 0.6 + l2 * 0.2 + l3 * 0.2))
    }
  }
  blur(shade, W, H, 1, 1)
  // 陆地外设为中性，避免海岸出现假晕渲
  const dark = new Float32Array(N)
  const light = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    dark[i] = e[i] > 0 ? 1 - shade[i] : -1
    light[i] = e[i] > 0 ? shade[i] - 1 : -1
  }
  // 海冰：海面且足够冷
  const ice = new Float32Array(N)
  for (let i = 0; i < N; i++) ice[i] = e[i] <= 0 ? -T[i] - 8 : -1
  const snow = new Float32Array(N)
  for (let i = 0; i < N; i++) snow[i] = e[i] > 0 ? -T[i] - 6 : -1
  blur(lake, W, H, 1, 1)
  return { land, depth, lake, dark, light, ice, snow }
}

/** 群系指示场（羽化）；按世界与 key（同一个 key 必须对应同一个 pred）缓存，只读 */
const biomeCache = new WeakMap<World, Map<number | string, Float32Array>>()
export function biomeField(world: World, key: number | string, pred: (b: number) => boolean) {
  let byKey = biomeCache.get(world)
  if (!byKey) biomeCache.set(world, (byKey = new Map()))
  let f = byKey.get(key)
  if (f) return f
  const { W, H, biome, elevation: e } = world
  f = new Float32Array(W * H)
  for (let i = 0; i < f.length; i++) f[i] = e[i] > 0 && pred(biome[i]) ? 1 : 0
  blur(f, W, H, 1, 1)
  byKey.set(key, f)
  return f
}

export function biomeLayers(L: Layers, world: World, palette: Record<number, RGB>, opacity: number) {
  const counts = new Map<number, number>()
  for (let i = 0; i < world.biome.length; i++) {
    const b = world.biome[i]
    if (world.elevation[i] > 0 && b !== Biome.Lake) counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  const order = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => b)
  for (const b of order) {
    L.fill(biomeField(world, b, (x) => x === b), 0.5, rgb(palette[b]), opacity, { tol: 0.4, minArea: 3 })
  }
}

export function hillshade(L: Layers, F: VectorFields, ink: string, darkOp: number, lightOp: number, o: LayerOpt = {}) {
  for (const t of [0.07, 0.16, 0.26, 0.38, 0.5]) L.fill(F.dark, t, ink, darkOp, { ...o, tol: 0.45, minArea: 2.5 })
  if (lightOp > 0) for (const t of [0.04, 0.08]) L.fill(F.light, t, '#ffffff', lightOp, { ...o, tol: 0.45, minArea: 2.5 })
}

export function ripples(L: Layers, world: World, dists: number[], color: string, opacities: number[], width: number) {
  const cd = world.coastDist
  dists.forEach((d, k) => L.line(cd, -d, color, width, opacities[k]))
}
