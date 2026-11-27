import * as dmath from '../../gen/dmath'
import { hashString } from '../../gen/rng'
import { bboxOf, convexOverlap, pointInPoly, polylineLength, segDist, segPolyDist, type BBox } from '../geom'
import { buildTerrain, type TerrainResult } from '../terrain'
import type { Settlement, SettlementParams } from '../types'
import type { GrowLot, GrowP, GrowParams, GrowRoad, GrowState, GrowStroke, GrowTerrain, PlaceReq, PlaceResult } from './api'
import { reliefTerrain } from './relief'

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

/** 地块的中心：各个角的平均（沿路摆的地块是四个角；自然生长的地块是房子、田的轮廓，几个角都有） */
export function lotCenter(lot: GrowLot): GrowP {
  let x = 0
  let y = 0
  for (const p of lot.poly) {
    x += p[0]
    y += p[1]
  }
  return [x / lot.poly.length, y / lot.poly.length]
}

/** 自然生长的状态里，规划的路的 id 从这里起（比它小的是手动铺的）；规划的地块带 ref */
export const WAY_ID = 1_000_000

/** 手动的东西压着的地方（见 manualBlocker）。poly：一个多边形压没压到；point：一个点（树）压没压到 */
export interface Blocker {
  poly: (q: GrowP[]) => boolean
  point: (p: GrowP, pad: number) => boolean
  /**
   * 规划的一条路里贴着手动的路走的那几段去掉（见 trimAlong），返回剩下的各段；没有要去掉的返回 null（原样）。
   * 斜着、横着穿过手动的路的不动（那是路口）
   */
  trim: (line: GrowP[]) => GrowP[][] | null
  /** 手动的路这一组的记号：手动的路没变时是同一个对象（手动的地块变了也不换）。修剪的结果只跟它有关，可以按它记 */
  ways: object
}

/**
 * 规划的路离手动的路的中线不到 ROAD_NEAR 米、走向又差不多（夹角的余弦超过 ROAD_ALONG，约 40°）的一段不要：
 * 两条路贴着并排走，中间连一排地都摆不下。（和整理路网时的「重叠」不是一回事：那是路面压在一起，见 roads.ts 的 tidyRoads）
 */
const ROAD_NEAR = 18
const ROAD_ALONG = 0.766
/** 修剪时沿规划的路每隔几米看一点；剩下的一段不到这么长的也不要（零碎的断头） */
const TRIM_STEP = 3
const TRIM_STUB = 12

/** 手动的路的一段：路面半宽（含 ROAD_CLEAR）、外接框（放出半宽）、走向 */
interface HandSeg {
  a: GrowP
  b: GrowP
  hw: number
  box: BBox
  u: GrowP
}
const apart = (a: BBox, b: BBox) => a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]
const grown = (b: BBox, d: number): BBox => [b[0] - d, b[1] - d, b[2] + d, b[3] + d]

/** 一条折线里贴着 segs（手动的路）走的那几段去掉，返回剩下的各段；没有要去掉的返回 null */
function trimAlong(segs: HandSeg[], line: GrowP[]): GrowP[][] | null {
  if (line.length < 2) return null
  // 只看外接框挨得着这条线的那几段
  const lb = grown(bboxOf(line), ROAD_NEAR)
  const near = segs.filter((s) => !apart(lb, s.box))
  if (!near.length) return null
  const along = (p: GrowP, d: GrowP) => near.some((s) => Math.abs(d[0] * s.u[0] + d[1] * s.u[1]) > ROAD_ALONG && segDist(p, s.a, s.b).d < ROAD_NEAR)
  // 沿路每 TRIM_STEP 米取一点（原来的顶点都留着），贴着手动的路走的点去掉，剩下的连成段
  const runs: GrowP[][] = []
  let run: GrowP[] = []
  let cut = false
  const close = () => {
    if (run.length > 1) runs.push(run)
    run = []
  }
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]
    const b = line[i + 1]
    const L = dmath.hypot(b[0] - a[0], b[1] - a[1])
    if (!L) continue
    const d: GrowP = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    const n = Math.max(1, Math.ceil(L / TRIM_STEP))
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const p: GrowP = k === n ? b : [cm(a[0] + ((b[0] - a[0]) * k) / n), cm(a[1] + ((b[1] - a[1]) * k) / n)]
      if (along(p, d)) {
        cut = true
        close()
      } else run.push(p)
    }
  }
  close()
  return cut ? runs.filter((q) => polylineLength(q) >= TRIM_STUB) : null
}

/** 最近一次的手动的东西与它们的 Blocker：逐步生长时手动的东西不变，不必每一步重建（调用方也凭同一个对象认出「没变」） */
let blockerMemo: { lots: GrowLot[]; roads: GrowRoad[]; cleared: GrowP[][] | undefined; segs: HandSeg[]; block: Blocker | null } | null = null
/** 两个数组里是不是同样的那些对象（逐个比是不是同一个） */
export const sameItems = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i])
/** 两条折线是不是同样的点（同一个数组，或者逐点相同） */
export const samePts = (a: readonly GrowP[], b: readonly GrowP[]) => a === b || (a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]))

/**
 * 手动的东西（手动摆的地块、手动铺的路）压着的地方：自然生长的聚落里手动的优先，规划里的房子、田、树落在这些地方就不要了。
 * 压没压到的规矩和手动摆放时的验地一样（地块相交、离路面不到 ROAD_CLEAR，见 place.ts 的 Work.why）。没有手动的东西时返回 null
 */
export function manualBlocker(state: GrowState): Blocker | null {
  const hand = state.lots.filter((l) => l.ref === undefined && l.state !== 'vacant')
  const roads = state.roads.filter((r) => r.id < WAY_ID)
  const was = blockerMemo
  const sameRoads = !!was && sameItems(was.roads, roads)
  if (was && sameRoads && sameItems(was.lots, hand) && was.cleared === state.cleared) return was.block
  // 手动的路没变（只是地块变了）：路段、路的记号沿用，按路记着的修剪结果不作废
  const segs: HandSeg[] = sameRoads ? was!.segs : []
  if (!sameRoads)
    for (const r of roads) {
      const hw = ROAD_WIDTH[r.kind] / 2 + ROAD_CLEAR
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i]
        const b = r.pts[i + 1]
        const L = dmath.hypot(b[0] - a[0], b[1] - a[1]) || 1
        segs.push({ a, b, hw, box: grown(bboxOf([a, b]), hw), u: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] })
      }
    }
  // 手动拆掉的地方和手动的地块一样压着规划的东西
  const lots = [...hand.map((l) => l.poly), ...(state.cleared ?? [])].map((poly) => ({ poly, b: bboxOf(poly) }))
  const block: Blocker | null =
    lots.length || segs.length
      ? {
          poly(q) {
            if (q.length < 3) return false
            const qb = bboxOf(q)
            for (const l of lots) if (!apart(qb, l.b) && convexOverlap(q, l.poly, LOT_OVERLAP_TOL)) return true
            for (const s of segs) if (!apart(qb, s.box) && segPolyDist(s.a, s.b, q) < s.hw) return true
            return false
          },
          point(p, pad) {
            const pb: BBox = [p[0] - pad, p[1] - pad, p[0] + pad, p[1] + pad]
            for (const l of lots) if (!apart(pb, l.b) && pointInPoly(p, l.poly)) return true
            for (const s of segs) if (!apart(pb, s.box) && segDist(p, s.a, s.b).d < s.hw + pad) return true
            return false
          },
          trim: (line) => trimAlong(segs, line),
          ways: segs,
        }
      : null
  blockerMemo = { lots: hand, roads, cleared: state.cleared, segs, block }
  return block
}

/**
 * 自然生长（state.plan，见 natural.ts）要整套一次成形的生成器，不放进这几个不启动插件也能跑的文件里：
 * natural.ts 载入时把自己登记到这里，place、画图遇到带 plan 的状态就转过去；没载入就用会报错
 */
export const naturalHooks: {
  place?: (state: GrowState, req: PlaceReq) => PlaceResult | null
  /** 规划在这一刻的样子；block（手动的东西）给了，贴着手动的路走的规划的路已经修剪掉 */
  draw?: (state: GrowState, block: Blocker | null) => Settlement
  /** 规划变了（改了地形、换了认的路）之后：规划的地块按新的规划重新落一遍 */
  rebase?: (state: GrowState) => GrowState
} = {}

/** 开局参数里的地形部分（存进状态的那一份） */
export function growTerrain(p: GrowParams): GrowTerrain {
  return {
    culture: p.culture,
    river: p.river,
    coast: p.coast,
    hills: p.hills,
    relief: p.relief,
    coastDir: p.coastDir,
    riverDir: p.riverDir,
    hillDir: p.hillDir,
    ...(p.terrainSeed ? { terrainSeed: p.terrainSeed } : {}),
    ...(p.flat ? { flat: true } : {}),
  }
}

/**
 * 地形参数 → cartographer 聚落参数里定地形的那几个字段。这里验地用的地形（terrainOf）和自然生长交给生成器的规划参数
 *（natural.ts）都用这一份：两边才是同一片地形
 */
export function terrainFields(seed: string, t: GrowTerrain) {
  const dir = (v: number | null) => (v === null ? NaN : v)
  return {
    seed,
    culture: t.culture,
    river: t.river,
    coast: t.coast,
    hills: t.hills,
    relief: t.relief,
    coastDir: dir(t.coastDir),
    riverDir: dir(t.riverDir),
    hillDir: dir(t.hillDir),
    terrainSeed: t.terrainSeed ?? '',
    ...(t.flat ? { flat: true } : {}),
  }
}
export function naturalHook<K extends keyof typeof naturalHooks>(k: K): NonNullable<(typeof naturalHooks)[K]> {
  const f = naturalHooks[k]
  if (!f) throw new Error('这是自然生长的状态：要先载入 settlement/grow/natural')
  return f as NonNullable<(typeof naturalHooks)[K]>
}

/** 点落在哪块地上（不算空着的；只给点选用，正好落在边上的算不算都行）。手动摆的地块在规划的地块上面 */
export function lotAtPoint(state: GrowState, p: GrowP): GrowLot | undefined {
  let under: GrowLot | undefined
  for (const l of state.lots) {
    if (l.state === 'vacant' || !pointInPoly(p, l.poly)) continue
    if (l.ref === undefined) return l
    under ??= l
  }
  return under
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
  return {
    ...terrainFields(seed, t),
    population,
    size: 'hamlet',
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
    farms: true,
    farmland: 0.4,
    wallBend: 0.3,
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
  /** 一笔没叠过的原地形（海面按它认） */
  base: TerrainResult
}
const terrainMemo: TerrainMemo[] = []
const TERRAIN_MEMO = 6
const texts = new WeakMap<object, string>()
/** 一个对象的 JSON 文本，记着（状态不可变：同一个对象的文本不变） */
export const textOf = (x: object) => {
  let v = texts.get(x)
  if (v === undefined) texts.set(x, (v = JSON.stringify(x)))
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
    const base = buildTerrain(settleParams(s.seed, s.terrain), s.size)
    from = keep({ key, strokes: [], T: base, base })
    if (!strokes.length) return base
  }
  return keep({ key, strokes, T: reliefTerrain(from.base, strokes.slice(from.strokes.length), from.T), base: from.base }).T
}

export function checkState(s: GrowState) {
  if (s.v !== GROW_VERSION) throw new Error(`生长状态的版本是 ${s.v}，这里只认 ${GROW_VERSION}`)
}
