import * as dmath from '../../gen/dmath'
import { pointInPoly, polylineLength, segPolyDist, segDist } from '../geom'
import type { GrowLot, GrowP, GrowRoad, GrowRoadKind, GrowState, GrowZone } from './api'
import { ROAD_CLEAR, ROAD_EDGE, ROAD_WATER, ROAD_WIDTH, checkState, cm, terrainOf } from './core'

// 手动的规划（玩家、或者游戏里的人「修路 / 划区」）：和自动生长改的是同一份状态，规则一句一条：
//   - 手动铺路：端点离已有的路不到 SNAP 米就接到那条路上（落在最近的那一点）；路至少 MIN_LEN 米、都在画幅里；
//     跨水（离水不到 2 米）、压到在用的地块的拒绝，说明原因；压到空着的地，那块空地去掉。
//   - 拆路：路上还有临街的在用地块就拒绝；临着它的空地一并去掉。别的路接在它上面的不管（会断开，以后细化）。
//   - 分区：只记下「这片地打算给什么用」，不立刻盖；自动生长摆这种用途时落在里面大幅加分、别的用途不进来（见 place.ts）。
//   - 取消分区：已经盖在里面的不动。

/** 端点离已有的路多近就接上去（米） */
const SNAP = 8
/** 手动的路至少多长（米） */
const MIN_LEN = 10

/** 点落到最近的一条路上（不到 SNAP 米才算） */
function snap(state: GrowState, p: GrowP): GrowP {
  let best: GrowP = p
  let bd = SNAP
  for (const r of state.roads)
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]
      const b = r.pts[i + 1]
      const { d, t } = segDist(p, a, b)
      if (d < bd) {
        bd = d
        best = [cm(a[0] + (b[0] - a[0]) * t), cm(a[1] + (b[1] - a[1]) * t)]
      }
    }
  return best
}

export function addRoad(state: GrowState, pts: GrowP[], kind: GrowRoadKind): { state: GrowState; road: GrowRoad } | { error: string } {
  checkState(state)
  if (pts.length < 2) return { error: '路至少要两个点' }
  const line = pts.map(([x, y]): GrowP => [cm(x), cm(y)])
  line[0] = snap(state, line[0])
  line[line.length - 1] = snap(state, line[line.length - 1])
  const L = polylineLength(line)
  if (L < MIN_LEN) return { error: `路太短（${L.toFixed(1)} 米，至少 ${MIN_LEN} 米）` }
  const [W, H] = state.size
  if (line.some(([x, y]) => x < ROAD_EDGE || y < ROAD_EDGE || x > W - ROAD_EDGE || y > H - ROAD_EDGE)) return { error: '路出了画幅' }
  const T = terrainOf(state)
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]
    const b = line[i + 1]
    const n = Math.max(1, Math.ceil(dmath.hypot(b[0] - a[0], b[1] - a[1]) / 2))
    for (let k = 0; k <= n; k++) {
      const q: GrowP = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]
      if (T.waterAt(q) < ROAD_WATER) return { error: `路跨水（在 ${Math.round(q[0])}, ${Math.round(q[1])} 附近；第一版不架桥）` }
    }
  }
  const hw = ROAD_WIDTH[kind] / 2
  const hits = (l: GrowLot) => line.some((a, i) => i + 1 < line.length && segPolyDist(a, line[i + 1], l.poly) < hw + ROAD_CLEAR)
  const blocked = state.lots.find((l) => l.state !== 'vacant' && hits(l))
  if (blocked) return { error: `路压到了地块 #${blocked.id}（${blocked.use}${blocked.owner ? `，${blocked.owner} 的` : ''}）` }
  const road: GrowRoad = { id: state.nextId, kind, pts: line, born: state.step }
  return { state: { ...state, roads: [...state.roads, road], lots: state.lots.filter((l) => !(l.state === 'vacant' && hits(l))), nextId: state.nextId + 1 }, road }
}

export function removeRoad(state: GrowState, roadId: number): { state: GrowState } | { error: string } {
  checkState(state)
  if (!state.roads.some((r) => r.id === roadId)) return { error: `没有这条路 #${roadId}` }
  const live = state.lots.filter((l) => l.road === roadId && l.state !== 'vacant')
  if (live.length) return { error: `路上还有 ${live.length} 块临街的地块（#${live.slice(0, 5).map((l) => l.id).join('、#')}${live.length > 5 ? '……' : ''}）` }
  return { state: { ...state, roads: state.roads.filter((r) => r.id !== roadId), lots: state.lots.filter((l) => l.road !== roadId) } }
}

export function zone(state: GrowState, poly: GrowP[], use: string): { state: GrowState; zone: GrowZone } | { error: string } {
  checkState(state)
  if (poly.length < 3) return { error: '分区至少要三个点' }
  const [W, H] = state.size
  if (poly.some(([x, y]) => x < 0 || y < 0 || x > W || y > H)) return { error: '分区出了画幅' }
  const z: GrowZone = { id: state.nextId, use, poly: poly.map(([x, y]): GrowP => [cm(x), cm(y)]), born: state.step }
  return { state: { ...state, zones: [...state.zones, z], nextId: state.nextId + 1 }, zone: z }
}

export function unzone(state: GrowState, zoneId: number): GrowState {
  const zones = state.zones.filter((z) => z.id !== zoneId)
  return zones.length === state.zones.length ? state : { ...state, zones }
}

/** 点在哪一片分区里（后划的在上面） */
export function zoneAtPoint(state: GrowState, p: GrowP): GrowZone | undefined {
  const zs = state.zones
  for (let i = zs.length - 1; i >= 0; i--) if (pointInPoly(p, zs[i].poly)) return zs[i]
  return undefined
}
