import { hashString } from '../../gen/rng'
import { pointInPoly } from '../geom'
import { buildTerrain, retouchTerrain, type TerrainResult } from '../terrain'
import type { SettlementParams } from '../types'
import type { GrowLot, GrowP, GrowState, GrowStroke, GrowTerrain } from './api'
import { applyStroke } from './relief'

// 生长引擎的公共部分：常量、地形缓存、几个不用找地方的操作（退地、改状态）。选址与延路在 place.ts。

export const GROW_VERSION = 1

/** 一个单位的面宽、进深（米）：一块 20 × 20 = 400 平方米，和村落宅地密度表（wards.ts 的 village：115 ~ 400）的上限一样大 */
export const UNIT_W = 20
export const UNIT_D = 20
/** 地块离路边多远（米） */
export const SETBACK = 1.5

/** 路面宽（米）：画图与留出路面都用它 */
export const ROAD_WIDTH = { highway: 6, street: 5, lane: 3.5 } as const
/** 路离水至少几米（第一版不架桥：自动延的路、手动铺的路都不跨水） */
export const ROAD_WATER = 2
/** 地块离路面边还要空出几米（路压地块、地块压路都按「半个路面宽 + 它」量） */
export const ROAD_CLEAR = 0.5
/** 两块地（或地块与路口空当）重叠不到这么多米不算压到（贴边、取整到厘米的误差） */
export const LOT_OVERLAP_TOL = 0.3
/** 接在别的地块背后、旁边时，两块之间留的缝（米） */
export const LOT_GAP = 0.6
/** 自动摆的地块离画幅边至少几米 */
export const LOT_EDGE = 10
/** 手动铺的路离画幅边至少几米 */
export const ROAD_EDGE = 2

/**
 * 用途的归类。near：要靠村心（住处、铺子、公家、村心）；不 near 的要在住处那一圈之外（田、料场），
 * inside 是落进那一圈里每米罚多少；back：可以接在已有地块的背后、旁边（不临路）
 */
export interface UseDef {
  near: boolean
  back: boolean
  inside: number
}
export const USES: Record<string, UseDef> = {
  center: { near: true, back: false, inside: 0 },
  home: { near: true, back: false, inside: 0 },
  shop: { near: true, back: false, inside: 0 },
  public: { near: true, back: false, inside: 0 },
  yard: { near: false, back: true, inside: 1.5 },
  field: { near: false, back: true, inside: 4 },
}
export const useOf = (use: string): UseDef => USES[use] ?? USES.home

export { hashString as growHash }

/** 坐标取到厘米：存进 JSON 的数短一些，读回来逐位一样 */
export const cm = (v: number) => Math.round(v * 100) / 100

export function lotCenter(lot: GrowLot): GrowP {
  const q = lot.poly
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4]
}

/** 点落在哪块地上（不算空着的；只给点选用，正好落在边上的算不算都行） */
export function lotAtPoint(state: GrowState, p: GrowP): GrowLot | undefined {
  for (const l of state.lots) if (l.state !== 'vacant' && pointInPoly(p, l.poly)) return l
  return undefined
}

/** 退掉一块地：形状留着（以后同样大小的需求可以接着用），变成 vacant、去掉 owner */
export function release(state: GrowState, lotId: number): GrowState {
  const i = state.lots.findIndex((l) => l.id === lotId)
  if (i < 0 || state.lots[i].state === 'vacant') return state
  const lot: GrowLot = { ...state.lots[i], state: 'vacant' }
  delete lot.owner
  const lots = state.lots.slice()
  lots[i] = lot
  return { ...state, lots }
}

export function setState(state: GrowState, lotId: number, s: 'building' | 'built'): GrowState {
  const i = state.lots.findIndex((l) => l.id === lotId)
  if (i < 0 || state.lots[i].state === s || state.lots[i].state === 'vacant') return state
  const lots = state.lots.slice()
  lots[i] = { ...lots[i], state: s }
  return { ...state, lots }
}

/** 地形参数 → cartographer 的聚落参数（只有地形用得到的字段有意义） */
export function settleParams(seed: string, t: GrowTerrain, population = 100): SettlementParams {
  const dir = (v: number | null) => (v === null ? NaN : v)
  return {
    seed,
    population,
    size: 'hamlet',
    culture: t.culture,
    magic: 0,
    walls: 'none',
    regularity: 0.2,
    radial: 0.3,
    spread: 0.15,
    motif: 'auto',
    plan: 'organic',
    planStrength: 0,
    capital: false,
    function: 'balanced',
    counts: {},
    river: t.river,
    coast: t.coast,
    hills: t.hills,
    relief: t.relief,
    farms: true,
    farmland: 0.4,
    wallBend: 0.3,
    coastDir: dir(t.coastDir),
    riverDir: dir(t.riverDir),
    hillDir: dir(t.hillDir),
    terrainSeed: t.terrainSeed ?? '',
  }
}

/**
 * 地形不存进 state：按参数重算（15 ~ 30 毫秒），再依次叠上手动改地形的笔画（state.strokes）。
 * 这里记着最近几份：地形只由参数与笔画定，缓存不改变结果。笔画只多出后面几笔时接着上一份的网格画（撤销、连着画都落在这条路上）
 */
interface TerrainMemo {
  key: string
  strokes: readonly GrowStroke[]
  T: TerrainResult
  /** 叠完笔画的水面（1 为水）；没用到过时是 null */
  wet: Uint8Array | null
}
const terrainMemo: TerrainMemo[] = []
const TERRAIN_MEMO = 6
const strokeText = new WeakMap<GrowStroke, string>()
const textOf = (st: GrowStroke) => {
  let v = strokeText.get(st)
  if (v === undefined) strokeText.set(st, (v = JSON.stringify(st)))
  return v
}
/** a 是不是 b 开头的一段（同一个对象，或内容相同） */
const isPrefix = (a: readonly GrowStroke[], b: readonly GrowStroke[]) => a.length <= b.length && a.every((st, i) => st === b[i] || textOf(st) === textOf(b[i]))

export function terrainOf(s: { seed: string; terrain: GrowTerrain; size: [number, number]; strokes?: GrowStroke[] }): TerrainResult {
  const key = JSON.stringify([s.seed, s.terrain, s.size])
  const strokes = s.strokes ?? []
  let from: TerrainMemo | null = null
  for (const m of terrainMemo) {
    if (m.key !== key || !isPrefix(m.strokes, strokes)) continue
    if (m.strokes.length === strokes.length) return m.T
    if (!from || m.strokes.length > from.strokes.length) from = m
  }
  const keep = (m: TerrainMemo) => {
    terrainMemo.unshift(m)
    if (terrainMemo.length > TERRAIN_MEMO) terrainMemo.pop()
    return m
  }
  if (!from) {
    from = keep({ key, strokes: [], T: buildTerrain(settleParams(s.seed, s.terrain), s.size), wet: null })
    if (!strokes.length) return from.T
  }
  const { W, H, cell } = from.T.terrain
  const height = from.T.terrain.height.slice()
  let wet = from.wet
  if (wet) wet = wet.slice()
  else {
    const water = from.T.terrain.water
    wet = new Uint8Array(W * H)
    for (let k = 0; k < W * H; k++) wet[k] = water[k] < 0 ? 1 : 0
  }
  let changed = false
  for (let i = from.strokes.length; i < strokes.length; i++) changed = applyStroke({ W, H, cell, height, wet }, strokes[i]) || changed
  return keep({ key, strokes, T: retouchTerrain(from.T, height, changed ? wet : null), wet }).T
}

export function checkState(s: GrowState) {
  if (s.v !== GROW_VERSION) throw new Error(`生长状态的版本是 ${s.v}，这里只认 ${GROW_VERSION}`)
}
