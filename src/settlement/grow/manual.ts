import { convexOverlap, dist, segDist, unit } from '../geom'
import type { GrowFault, GrowLot, GrowP, GrowState, GrowStroke, LotProbe } from './api'
import { LOT_GAP, LOT_OVERLAP_TOL, ROAD_WIDTH, SETBACK, UNIT_D, UNIT_W, checkState, cm, lotCenter, naturalHook, terrainOf, useOf } from './core'
import { STEP, Work, quadOf } from './place'

// 手动编辑（玩家像自由编辑器那样一块一块地摆、改地形）：和自动生长、手动规划改的是同一份状态。规则一句一条：
//   - 手动摆地块：位置由指针定——沿附近的路吸附到临街的位置（沿路每 STEP 米一档，和自动摆的对得齐），在指针所在的那一侧；
//     田、料场还可以接在同类地块的背后、两旁。离指针 REACH 米以内摆得下的位置里取最近的。
//   - 验地和自动摆的一样（不压路、不压在用的地、离水 3 米、不太陡、不出画幅），但不给以后的岔路留路口；压到的空地直接去掉。
//   - 摆下马上盖好；摆的是村心（center）时 state.center 挪到它上面（自动生长按离村心远近打分）。
//   - 拆地块：整块去掉（自动生长的退地是空出来、形状留着）。
//   - 改地形：笔画记进 state.strokes（地形 = 生成的地形依次叠上每一笔，见 relief.ts）；水漫到的地块去掉，路留着（过水的一段画成桥）。

/** 离指针多远以内的位置才算（米，量到地块中心） */
const REACH = 30
/** 沿路往两边各试几档 */
const SHIFTS = 6
/** 笔刷半径的范围（米） */
const R_MIN = 4
const R_MAX = 300

const FAULT_TEXT: Record<GrowFault, string> = {
  edge: '出了画幅',
  lot: '压到了别的地块',
  road: '压到了路',
  water: '离水太近',
  sea: '下海了',
  bridge: '桥太长',
  slope: '地太陡',
  far: '离路太远',
  short: '太短',
}

/** 最近一个状态的工作台（指针每动一下都要试，状态不可变、只读地用）；只留一个：别的状态再试时重建，不跟着撤销栈留一串 */
let lastWork: { state: GrowState; work: Work } | null = null
function workOf(state: GrowState) {
  if (lastWork?.state !== state) lastWork = { state, work: new Work(state, terrainOf(state)) }
  return lastWork.work
}

interface Spot {
  o: GrowP
  u: GrowP
  n: GrowP
  road: number
  d: number
}

export function probeLot(state: GrowState, use: string, area: number, p: GrowP): LotProbe | null {
  checkState(state)
  const w = UNIT_W * Math.max(1, Math.floor(area))
  const spots: Spot[] = []
  const push = (o: GrowP, u: GrowP, n: GrowP, road: number) => {
    const c: GrowP = [o[0] + (u[0] * w + n[0] * UNIT_D) / 2, o[1] + (u[1] * w + n[1] * UNIT_D) / 2]
    const d = dist(c, p)
    if (d <= REACH) spots.push({ o, u, n, road, d })
  }
  // 沿路：指针所在的一侧，落点前后各 SHIFTS 档
  for (const r of state.roads) {
    const hw = ROAD_WIDTH[r.kind] / 2
    let acc = 0
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]
      const b = r.pts[i + 1]
      const L = dist(a, b)
      const hit = segDist(p, a, b)
      if (L > 0 && hit.d <= hw + SETBACK + UNIT_D + REACH) {
        const u = unit([b[0] - a[0], b[1] - a[1]])
        const side = u[0] * (p[1] - a[1]) - u[1] * (p[0] - a[0]) >= 0 ? 1 : -1
        const n: GrowP = [-u[1] * side, u[0] * side]
        const s0 = Math.round((acc + hit.t * L - w / 2) / STEP) * STEP
        for (let k = -SHIFTS; k <= SHIFTS; k++) {
          const s = s0 + k * STEP
          if (s < acc || s >= acc + L) continue
          const t = s - acc
          push([a[0] + u[0] * t + n[0] * (hw + SETBACK), a[1] + u[1] * t + n[1] * (hw + SETBACK)], u, n, r.id)
        }
      }
      acc += L
    }
  }
  // 田、料场：接在同类地块的背后、两旁
  if (useOf(use).back) {
    for (const l of state.lots) {
      if (l.state === 'vacant' || l.ref !== undefined || l.use !== use || dist(lotCenter(l), p) > REACH + UNIT_D + w) continue
      const [p0, p1, , p3] = l.poly
      const u = unit([p1[0] - p0[0], p1[1] - p0[1]])
      const n = unit([p3[0] - p0[0], p3[1] - p0[1]])
      const lw = dist(p0, p1)
      push([p0[0] + n[0] * (UNIT_D + LOT_GAP), p0[1] + n[1] * (UNIT_D + LOT_GAP)], u, n, l.road)
      push([p0[0] + u[0] * (lw + LOT_GAP), p0[1] + u[1] * (lw + LOT_GAP)], u, n, l.road)
      push([p0[0] - u[0] * (w + LOT_GAP), p0[1] - u[1] * (w + LOT_GAP)], u, n, l.road)
    }
  }
  if (!spots.length) return null
  spots.sort((a, b) => a.d - b.d)
  const work = workOf(state)
  const quad = (s: Spot) => quadOf({ ...s, w }).map(([x, y]): GrowP => [cm(x), cm(y)])
  let first: LotProbe | null = null
  for (const s of spots) {
    const poly = quad(s)
    const fault = work.why(poly)
    if (!fault) return { poly, road: s.road }
    first ??= { poly, road: s.road, fault }
  }
  return first
}

export function placeAt(
  state: GrowState,
  req: { use: string; area?: number; owner?: string; state?: 'building' | 'built' },
  p: GrowP,
): { state: GrowState; lot: GrowLot } | { error: string; fault: GrowFault } {
  const area = Math.max(1, Math.floor(req.area ?? 1))
  const pr = probeLot(state, req.use, area, p)
  if (!pr) return { error: FAULT_TEXT.far, fault: 'far' }
  if (pr.fault) return { error: FAULT_TEXT[pr.fault], fault: pr.fault }
  const lot: GrowLot = {
    id: state.nextId,
    use: req.use,
    ...(req.owner === undefined ? {} : { owner: req.owner }),
    poly: pr.poly,
    road: pr.road,
    state: req.state ?? 'built',
    born: state.step,
    area,
  }
  const lots = state.lots.filter((l) => !(l.state === 'vacant' && l.ref === undefined && convexOverlap(l.poly, pr.poly, LOT_OVERLAP_TOL)))
  lots.push(lot)
  return { state: { ...state, lots, nextId: state.nextId + 1, ...(req.use === 'center' ? { center: lotCenter(lot).map(cm) as GrowP } : {}) }, lot }
}

export function removeLot(state: GrowState, lotId: number): GrowState {
  const lots = state.lots.filter((l) => l.id !== lotId)
  return lots.length === state.lots.length ? state : { ...state, lots }
}

/**
 * 把一笔记进状态（半径、坐标取整），别的不动：paintTerrain 的头一步。
 * 调用方可以先拿它得到改完地形的状态（比如先在别处把它的规划算好），再调 paintTerrain
 */
export function withStroke(state: GrowState, stroke: GrowStroke): GrowState {
  checkState(state)
  if (!stroke.pts.length) return state
  const st: GrowStroke = {
    tool: stroke.tool,
    r: Math.min(R_MAX, Math.max(R_MIN, Math.round(stroke.r))),
    pts: stroke.pts.map(([x, y]): GrowP => [cm(x), cm(y)]),
  }
  return { ...state, strokes: [...(state.strokes ?? []), st] }
}

export function paintTerrain(state: GrowState, stroke: GrowStroke): { state: GrowState; flooded: number } {
  let next = withStroke(state, stroke)
  if (next === state) return { state, flooded: 0 }
  const st = next.strokes![next.strokes!.length - 1]
  let flooded = 0
  if (st.tool === 'water') {
    const T = terrainOf(next)
    const wet = (l: GrowLot) => T.waterAt(lotCenter(l)) < 0.5 || l.poly.some((q) => T.waterAt(q) < 0.5)
    // 规划的地块不在这里管（下面按新地形重新落）
    const lots = next.lots.filter((l) => l.ref !== undefined || !wet(l))
    flooded = next.lots.length - lots.length
    if (flooded) next = { ...next, lots }
  }
  // 自然生长的聚落：地形变了，规划跟着变，规划的地块按新的规划重新落一遍
  if (next.plan) next = naturalHook('rebase')(next)
  return { state: next, flooded }
}
