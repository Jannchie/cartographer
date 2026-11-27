import * as dmath from '../../gen/dmath'
import { pointInPoly, polylineLength, segPolyDist, segDist } from '../geom'
import type { GrowFault, GrowLot, GrowP, GrowRoad, GrowRoadKind, GrowState, GrowZone } from './api'
import { ROAD_CLEAR, ROAD_EDGE, ROAD_WATER, ROAD_WIDTH, checkState, cm, terrainOf } from './core'

// 手动的规划（玩家、或者游戏里的人「修路 / 划区」）：和自动生长改的是同一份状态，规则一句一条：
//   - 手动铺路：端点离已有的路不到 SNAP 米就接到那条路上（落在最近的那一点）；路至少 MIN_LEN 米、都在画幅里；
//     跨水（离水不到 2 米）、压到在用的地块的拒绝，说明原因；压到空着的地，那块空地去掉。
//     调用方说可以架桥（opts.bridge）时路可以过河、湖：两头在岸上、一座桥不超过 BRIDGE_MAX 米，海不跨；画图时水上那一段是桥。
//   - 拆路：路上还有临街的在用地块就拒绝（opts.lots 时连同它们一起拆）；临着它的空地一并去掉。别的路接在它上面的不管（会断开，以后细化）。
//   - 分区：只记下「这片地打算给什么用」，不立刻盖；自动生长摆这种用途时落在里面大幅加分、别的用途不进来（见 place.ts）。
//   - 取消分区：已经盖在里面的不动。

/** 端点离已有的路多近就接上去（米） */
const SNAP = 8
/** 手动的路至少多长（米） */
const MIN_LEN = 10
/** 一座桥（路连续在水上的一段）最长多少米 */
const BRIDGE_MAX = 120

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

export function addRoad(
  state: GrowState,
  pts: GrowP[],
  kind: GrowRoadKind,
  opts: { bridge?: boolean } = {},
): { state: GrowState; road: GrowRoad } | { error: string; fault: GrowFault } {
  checkState(state)
  if (pts.length < 2) return { error: '路至少要两个点', fault: 'short' }
  const line = pts.map(([x, y]): GrowP => [cm(x), cm(y)])
  line[0] = snap(state, line[0])
  line[line.length - 1] = snap(state, line[line.length - 1])
  const L = polylineLength(line)
  if (L < MIN_LEN) return { error: `路太短（${L.toFixed(1)} 米，至少 ${MIN_LEN} 米）`, fault: 'short' }
  const [W, H] = state.size
  if (line.some(([x, y]) => x < ROAD_EDGE || y < ROAD_EDGE || x > W - ROAD_EDGE || y > H - ROAD_EDGE)) return { error: '路出了画幅', fault: 'edge' }
  const T = terrainOf(state)
  // 架桥（opts.bridge）：两头在岸上，中间可以过河、湖；连续在水上的一段不超过 BRIDGE_MAX 米，海不跨
  let span = 0
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]
    const b = line[i + 1]
    const len = dmath.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.ceil(len / 2))
    for (let k = 0; k <= n; k++) {
      const q: GrowP = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]
      const near = `在 ${Math.round(q[0])}, ${Math.round(q[1])} 附近`
      if (T.waterAt(q) >= ROAD_WATER) {
        span = 0
        continue
      }
      if (!opts.bridge) return { error: `路跨水（${near}；第一版不架桥）`, fault: 'water' }
      const end = (i === 0 && k === 0) || (i + 2 === line.length && k === n)
      if (end) return { error: `路的两头要在岸上（${near}）`, fault: 'water' }
      if (T.waterAt(q) < 0 && T.seaAt(q)) return { error: `路不能下海（${near}）`, fault: 'sea' }
      if (k > 0) span += len / n
      if (span > BRIDGE_MAX) return { error: `桥太长（${near}，一座桥最多 ${BRIDGE_MAX} 米）`, fault: 'bridge' }
    }
  }
  const hw = ROAD_WIDTH[kind] / 2
  const hits = (l: GrowLot) => line.some((a, i) => i + 1 < line.length && segPolyDist(a, line[i + 1], l.poly) < hw + ROAD_CLEAR)
  const blocked = state.lots.find((l) => l.state !== 'vacant' && hits(l))
  if (blocked) return { error: `路压到了地块 #${blocked.id}（${blocked.use}${blocked.owner ? `，${blocked.owner} 的` : ''}）`, fault: 'lot' }
  const road: GrowRoad = { id: state.nextId, kind, pts: line, born: state.step }
  return { state: { ...state, roads: [...state.roads, road], lots: state.lots.filter((l) => !(l.state === 'vacant' && hits(l))), nextId: state.nextId + 1 }, road }
}

export function removeRoad(state: GrowState, roadId: number, opts: { lots?: boolean } = {}): { state: GrowState } | { error: string } {
  checkState(state)
  if (!state.roads.some((r) => r.id === roadId)) return { error: `没有这条路 #${roadId}` }
  const live = state.lots.filter((l) => l.road === roadId && l.state !== 'vacant')
  if (live.length && !opts.lots) return { error: `路上还有 ${live.length} 块临街的地块（#${live.slice(0, 5).map((l) => l.id).join('、#')}${live.length > 5 ? '……' : ''}）` }
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
