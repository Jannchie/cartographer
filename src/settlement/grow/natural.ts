import { generateHistory, settlementExtent } from '../generate'
import { area, centroid, type P } from '../geom'
import { snapshot, type SettlementHistory } from '../history'
import { DEFAULT_SETTLEMENT, type Building, type Field, type Road, type Settlement, type SettlementParams } from '../types'
import { dwelling } from '../undo'
import type { GrowLot, GrowP, GrowParams, GrowRoad, GrowRoadKind, GrowState, GrowStroke, GrowTerrain, PlaceReq, PlaceResult } from './api'
import { ROAD_WIDTH, UNIT_D, UNIT_W, WAY_ID, cm, lotCenter, manualBlocker, naturalHooks, release, terrainFields, type Blocker } from './core'
import { blankState } from './place'

// 自然生长：聚落不是一块一块沿路摆出来的，而是沿着一次成形的生成器（generate.ts）给这片地规划好的成长史往前走——
// 和聚落地图里「一键生成」的是同一套规划、同一套画法，所以长出来的就是那种聚落：片区、街坊、不规则的宅地、田野、地标。
//
// 一次成形的生成器要先知道终点（规划的人口 horizon）；这里把终点定在开局时选的规模上，之后只沿这一份成长史走，
// 所以同一局里聚落是一路长大的（换一个 horizon 是另一份规划、另一座城）。成长史不存进状态，按参数重算（缓存不改变结果）。
//
// 状态里多了 plan = { horizon, pop }：pop 是成长史走到的时刻（按人口计）。规则一句一条：
//   - 住处、铺子、公所、料场、村心这些用途：一块地 = 规划里一户人家的位置（一栋民居里的一户），带 ref。先用退掉、空着的；
//     没有空位时把 pop 往前推到规划里下一批房子盖起来的时刻，取其中最早盖的一栋。地块的形状是那栋房子的轮廓。
//   - 田：认领眼下已经开出来、还没人认领的田块，取离同主的地（没有就离有人住的地方）最近的。田是规划里随人口开垦的，不为认领多开。
//   - pop 往前推时：规划里拆掉重盖的房子上的住户挪到最近的有空位的房子里，被城区占掉的田换成最近的空田（没有空田就没了）。
//   - 手动的东西和它混在同一份状态里：手动铺的路（id 小于 WAY_ID）、手动摆的地块（没有 ref）照 plan.ts、manual.ts 的规矩来。
//     手动的优先：规划里的房子、田落在手动的地块、路上的就不要了（不住人、不画），原来住在那儿的户挪到别处；
//     规划的路里贴着手动的路并排走的那几段也不要（斜着、横着穿过去的是路口，留着）。规划的路不能拆。
//   - 手动的路还是规划的骨架：下一次 place 摆新地块时，规划把这时的手动的路当作已有的街重算（记在 plan.guides 里），
//     片区、街巷顺着它们来，规划的地块照原来的先后重新落一遍。铺路的当时不重算（一条一条铺的时候不折腾），只按上一条让开。
//   - 手动改了地形（state.strokes）：规划按改过的地形重算，规划的地块按新的规划照原来的先后重新落一遍（rebase）；新地形上放不下的没了。
//   - 规划的规模住满以后 place 返回 null。
// 这个文件要整套生成器（要先启动插件：文明等内容由插件登记）；载入时把自己登记到 core.ts 的 naturalHooks 上，
// place、画图、改地形遇到带 plan 的状态就转到这里。没载入它就用带 plan 的状态会报错。

/** 规划里的一栋民居、一块田、一条路，和它们存在的时段（按人口计） */
interface Home {
  b: Building
  born: number
  died: number
  units: number
  c: P
}
interface Plot {
  f: Field
  born: number
  died: number
  c: P
}
interface Way {
  id: number
  born: number
  died: number
  kind: GrowRoadKind
  pts: GrowP[]
}
interface Plan {
  hist: SettlementHistory
  /** 民居，按盖起来的先后 */
  homes: Home[]
  plots: Plot[]
  ways: Way[]
  /** 有民居盖起来的时刻，从早到晚 */
  times: number[]
}

const KIND: Record<Road['kind'], GrowRoadKind> = { highway: 'highway', main: 'street', street: 'street', lane: 'lane', path: 'lane', stair: 'lane' }

/** 这片地的规划参数：布局用聚落地图的默认值，所以和那边同一个种子、人口取 horizon 的是同一座城；手动改地形的笔画也交过去 */
function paramsOf(seed: string, t: GrowTerrain, horizon: number, strokes?: GrowStroke[], guides?: Guide[]): SettlementParams {
  return { ...DEFAULT_SETTLEMENT, ...terrainFields(seed, t), population: horizon, ...(strokes?.length ? { strokes } : {}), ...(guides?.length ? { guides } : {}) }
}
type Guide = NonNullable<NonNullable<GrowState['plan']>['guides']>[number]

/**
 * 规划认的手动的路换成现在的这些（状态里别的不动；本来就一样时原样返回）。
 * 规划把它认的路当骨架：片区沿它们布点、街巷顺着它们、新修的路接到它们上面。手动的路变了以后规划要重算，
 * 所以不是每铺一条就换：下一次 place 摆新地块时才换上、把规划的地块重新落一遍（见 place）。
 * 调用方可以先拿它得到换上之后的状态，在别处把那份规划算好（naturalParams、primeNatural）
 */
export function withGuides(s: GrowState): GrowState {
  if (!s.plan) return s
  const now: Guide[] = s.roads.filter((r) => r.id < WAY_ID).map((r) => ({ line: r.pts, width: ROAD_WIDTH[r.kind] }))
  const was = s.plan.guides ?? []
  const same = (a: Guide, b: Guide) => a.width === b.width && a.line.length === b.line.length && (a.line === b.line || a.line.every((p, i) => p[0] === b.line[i][0] && p[1] === b.line[i][1]))
  if (was.length === now.length && was.every((g, i) => same(g, now[i]))) return s
  const { guides: _, ...plan } = s.plan
  return { ...s, plan: now.length ? { ...plan, guides: now } : plan }
}

const memo: { key: string; plan: Plan }[] = []
/** 笔画的文本（笔画数组在各步之间是同一个对象，只在改地形时换） */
const texts = new WeakMap<object, string>()
/** 笔画、规划认的路的文本（这两个数组在各步之间是同一个对象，只在改地形、换路时换） */
const textOf = (x: object | undefined) => {
  if (!x) return ''
  let v = texts.get(x)
  if (v === undefined) texts.set(x, (v = JSON.stringify(x)))
  return v
}
const keyOf = (s: GrowState) => {
  if (!s.plan) throw new Error('不是自然生长的状态')
  return `${JSON.stringify([s.seed, s.terrain, s.plan.horizon])}|${s.strokes?.length ? textOf(s.strokes) : ''}|${textOf(s.plan.guides)}`
}
/** 这个状态的规划参数（交给后台线程推演成长史用，见 primeNatural） */
export const naturalParams = (s: GrowState): SettlementParams => paramsOf(s.seed, s.terrain, s.plan!.horizon, s.strokes, s.plan!.guides)
/** 这个状态的规划算好了没有（没算好时 place、画图会当场算，要一到几秒） */
export const naturalReady = (s: GrowState) => {
  const key = keyOf(s)
  return memo.some((m) => m.key === key)
}
/**
 * 把在别处（后台线程）按 naturalParams 推演好的成长史交进来，免得在这里再算一遍。
 * 成长史要原样传回（结构化克隆保留物件之间的引用：生卒表的键就是地图上的各样东西）
 */
export function primeNatural(s: GrowState, hist: SettlementHistory) {
  if (!naturalReady(s)) keep(keyOf(s), hist)
}
function planOf(s: GrowState): Plan {
  const key = keyOf(s)
  return memo.find((m) => m.key === key)?.plan ?? keep(key, generateHistory(naturalParams(s)))
}
function keep(key: string, hist: SettlementHistory): Plan {
  const span = (x: object) => hist.life.get(x) ?? { born: 0, died: Infinity }
  const homes: Home[] = hist.st.buildings
    .filter((b) => dwelling(b) && (b.units ?? 1) > 0)
    .map((b) => ({ b, ...span(b), units: b.units ?? 1, c: centroid(b.poly) }))
    .sort((a, b) => a.born - b.born)
  const plots: Plot[] = hist.st.fields.map((f) => ({ f, ...span(f), c: centroid(f.poly) }))
  // 规划认的手动的路（given）不算规划的路：状态里本来就有它们
  const ways: Way[] = hist.st.roads.flatMap((r, i) => (r.given ? [] : [{ id: WAY_ID + i, ...span(r), kind: KIND[r.kind], pts: r.line.map(([x, y]): GrowP => [cm(x), cm(y)]) }]))
  const times = [...new Set(homes.map((h) => h.born))].sort((a, b) => a - b)
  const plan: Plan = { hist, homes, plots, ways, times }
  memo.unshift({ key, plan })
  // 留三份：眼下的、改地形之前的（撤销）、正在后台算的
  if (memo.length > 3) memo.pop()
  return plan
}

const alive = (x: { born: number; died: number }, pop: number) => x.born <= pop && pop < x.died
const d2 = (a: P, b: P) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

/** 各个 Blocker（手动的东西）把规划的各条路修剪成了哪几段（null：没动）；手动的东西不变时逐步生长不用重算 */
const trims = new WeakMap<object, Map<Way, GrowP[][] | null>>()
/**
 * 手动铺的路照旧，加上 pop 这一刻规划里已经修好的路；原来就在 state.roads 里的沿用（born 是它头一次出现的那一步）。
 * 规划的路里贴着手动的路走的那几段不要（手动的优先，见 core.ts 的 Blocker.trim）：剩下的各段各是一条路，
 * 第 k 段的 id 是 WAY_ID × (k + 1) + 它在规划里的序号（没被修剪的就是 WAY_ID + 序号）
 */
function roadsAt(plan: Plan, pop: number, old: GrowRoad[], step: number, block: Blocker | null): GrowRoad[] {
  const seen = new Map(old.map((r) => [r.id, r]))
  const out = old.filter((r) => r.id < WAY_ID)
  let cache = block ? trims.get(block) : undefined
  if (block && !cache) trims.set(block, (cache = new Map()))
  for (const w of plan.ways) {
    if (!alive(w, pop)) continue
    let parts: GrowP[][] | null = null
    if (block) {
      const hit = cache!.get(w)
      if (hit === undefined) cache!.set(w, (parts = block.trim(w.pts)))
      else parts = hit
    }
    if (!parts) out.push(seen.get(w.id) ?? { id: w.id, kind: w.kind, pts: w.pts, born: step })
    else
      parts.forEach((pts, k) => {
        const id = WAY_ID * (k + 1) + (w.id - WAY_ID)
        // 修剪的结果变了（手动的路改了）同一个 id 可能是另一段：形状不同就算新的
        const was = seen.get(id)
        out.push(was && was.pts.length === pts.length && was.pts.every((p, i) => p[0] === pts[i][0] && p[1] === pts[i][1]) ? was : { id, kind: w.kind, pts, born: step })
      })
  }
  return out
}

/** 离一点最近的路（隔几个点量一下，够用了）；一条路也没有时是 0 */
function nearestRoad(roads: GrowRoad[], c: P): number {
  let best = 0
  let bd = Infinity
  for (const r of roads)
    for (let i = 0; i < r.pts.length; i += 3) {
      const d = d2(r.pts[i], c)
      if (d < bd) {
        bd = d
        best = r.id
      }
    }
  return best
}

const outline = (poly: P[]) => poly.map(([x, y]): GrowP => [cm(x), cm(y)])

export function seedNatural(p: GrowParams, horizon: number): GrowState {
  const s = blankState(p)
  // 画幅由规划的规模定（和一次成形的生成器取的一样大）
  const size = settlementExtent(paramsOf(s.seed, s.terrain, horizon))
  // 开局还没有人、也没有路：规划等到头一次 place、画图时才算（或由 primeNatural 交进来），这里不用等
  return { ...s, size, center: [size[0] / 2, size[1] / 2], plan: { horizon, pop: 0 } }
}

/**
 * 手动的东西变了之后把规划的地块理一遍：被手动的地块、路压住的住户、田挪到近处（眼下没有空位的先留在原处）。
 * place 开头也会做这一步；手动改完当场调它，状态里就不留着压在手动东西底下的规划地块
 */
export function settleNatural(state: GrowState): GrowState {
  return state.plan ? (place(state, null)?.state ?? state) : state
}

/** 各个 Blocker（手动的东西）在各份规划上压住了哪些房子、田：手动的东西不变时逐步生长不用重查 */
const hits = new WeakMap<object, WeakMap<Plan, { home: Map<number, boolean>; plot: Map<number, boolean> }>>()

/**
 * req 为 null：不摆新的，只把被压住、拆掉的安置一遍（settleNatural）。
 * again：重新落一遍时（rebase）沿用原来的 id、出现的那一步，不接着用空着的地块
 */
function place(state: GrowState, req: PlaceReq | null, again?: { id: number; born: number }): PlaceResult | null {
  // 要摆新地块了：手动的路变过的话，规划把现在这些路当骨架重算，规划的地块照原来的先后重新落一遍
  if (req && !again) {
    const adopted = withGuides(state)
    if (adopted !== state) state = rebase(adopted)
  }
  const plan = planOf(state)
  const { homes, plots } = plan
  let pop = state.plan!.pop
  const step = again || !req ? state.step : state.step + 1
  let nextId = state.nextId
  let lots = state.lots.slice()
  const isField = (l: { use: string }) => l.use === 'field'
  // 手动的东西压着的房子、田不能用（手动的优先）；查过的记着（手动的东西没变就一直用）
  const block = manualBlocker(state)
  let seen = block ? hits.get(block)?.get(plan) : undefined
  if (block && !seen) {
    seen = { home: new Map(), plot: new Map() }
    const per = hits.get(block) ?? new WeakMap()
    hits.set(block, per.set(plan, seen))
  }
  const homeHit = seen?.home ?? new Map<number, boolean>()
  const plotHit = seen?.plot ?? new Map<number, boolean>()
  const hit = (cache: Map<number, boolean>, i: number, poly: P[]) => {
    if (!block) return false
    let v = cache.get(i)
    if (v === undefined) cache.set(i, (v = block.poly(poly as GrowP[])))
    return v
  }
  const homeOk = (i: number) => alive(homes[i], pop) && !hit(homeHit, i, homes[i].b.poly)
  const plotOk = (i: number) => alive(plots[i], pop) && !hit(plotHit, i, plots[i].f.poly)
  /** 各栋房子住了几户（空着的地块也占着它的位置）、哪些田有人认领 */
  const used = new Map<number, number>()
  const taken = new Set<number>()
  for (const l of lots) {
    if (l.ref === undefined) continue
    if (isField(l)) taken.add(l.ref)
    else used.set(l.ref, (used.get(l.ref) ?? 0) + 1)
  }
  const freeHome = (near?: P) => {
    let best = -1
    let bd = Infinity
    for (let i = 0; i < homes.length; i++) {
      const h = homes[i]
      if ((used.get(i) ?? 0) >= h.units || !homeOk(i)) continue
      // 没给位置：取最早盖的那一栋（homes 按先后排好了）
      if (!near) return i
      const d = d2(h.c, near)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return best
  }
  const freePlot = (near: P) => {
    let best = -1
    let bd = Infinity
    for (let i = 0; i < plots.length; i++) {
      if (taken.has(i) || !plotOk(i)) continue
      const d = d2(plots[i].c, near)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return best
  }
  let roads = roadsAt(plan, pop, state.roads, step, block)
  const homeLot = (l: GrowLot, i: number): GrowLot => ({ ...l, ref: i, poly: outline(homes[i].b.poly), road: nearestRoad(roads, homes[i].c) })
  const plotLot = (l: GrowLot, i: number): GrowLot => ({ ...l, ref: i, poly: outline(plots[i].f.poly), road: nearestRoad(roads, plots[i].c), area: Math.max(1, Math.round(area(plots[i].f.poly) / (UNIT_W * UNIT_D))) })
  /** 拆掉的、被手动的东西压住的房子上的住户，被占掉的田上的地块挪到近处；返回是不是都安置下了 */
  const resettle = () => {
    let ok = true
    const next: GrowLot[] = []
    for (const l of lots) {
      if (l.ref === undefined) {
        next.push(l)
        continue
      }
      if (isField(l)) {
        if (plotOk(l.ref)) next.push(l)
        else {
          taken.delete(l.ref)
          const i = freePlot(plots[l.ref].c)
          if (i >= 0) {
            taken.add(i)
            next.push(plotLot(l, i))
          }
        }
        continue
      }
      if (homeOk(l.ref)) {
        next.push(l)
        continue
      }
      const i = freeHome(homes[l.ref].c)
      if (i < 0) {
        // 眼下没有空位：先留在原处，等下一批房子盖起来
        ok = false
        next.push(l)
        continue
      }
      used.set(l.ref, (used.get(l.ref) ?? 1) - 1)
      used.set(i, (used.get(i) ?? 0) + 1)
      next.push(homeLot(l, i))
    }
    lots = next
    return ok
  }
  // 上次 place 之后手动的东西可能压住了几户：先安置
  if (block) resettle()
  /** 往前推到下一批房子盖起来的时刻；规划走到头了返回 false */
  const advance = () => {
    const t = plan.times.find((x) => x > pop)
    if (t === undefined) return false
    pop = t
    roads = roadsAt(plan, pop, roads, step, block)
    return true
  }
  const fresh = (req: PlaceReq, i: number): GrowLot => ({
    id: again ? again.id : nextId++,
    use: req.use,
    ...(req.owner === undefined ? {} : { owner: req.owner }),
    poly: [],
    road: 0,
    state: req.state ?? 'built',
    born: again ? again.born : step,
    area: 1,
    ref: i,
  })
  const placed: GrowLot[] = []
  const count = !req ? 0 : again ? 1 : Math.max(1, Math.floor(req.count ?? 1))
  for (let k = 0; req && k < count; k++) {
    // 退掉、空着的同一类地块接着用
    const vi = again ? -1 : lots.findIndex((l) => l.state === 'vacant' && l.ref !== undefined && isField(l) === isField(req) && (isField(l) ? plotOk(l.ref) : homeOk(l.ref)))
    if (vi >= 0) {
      const old = lots[vi]
      const lot: GrowLot = { ...old, use: req.use, state: req.state ?? 'built', born: step }
      if (req.owner === undefined) delete lot.owner
      else lot.owner = req.owner
      lots[vi] = lot
      placed.push(lot)
      continue
    }
    if (isField(req)) {
      // 离同主的地（连同这次刚摆下的）最近；没有就离有人住的地方最近
      const mates = [...lots.filter((l) => l.state !== 'vacant' && req.owner !== undefined && l.owner === req.owner), ...placed]
      const anchor = mates.length ? mates : lots.filter((l) => l.state !== 'vacant' && !isField(l))
      const c: P = anchor.length
        ? [anchor.reduce((a, l) => a + lotCenter(l)[0], 0) / anchor.length, anchor.reduce((a, l) => a + lotCenter(l)[1], 0) / anchor.length]
        : (homes.find((h) => alive(h, pop))?.c ?? [state.size[0] / 2, state.size[1] / 2])
      const i = freePlot(c)
      if (i < 0) return null
      taken.add(i)
      const lot = plotLot(fresh(req, i), i)
      lots.push(lot)
      placed.push(lot)
      continue
    }
    let i = freeHome()
    while (i < 0) {
      if (!advance()) return null
      // 先安置拆迁的，再看有没有剩下的空位
      resettle()
      i = freeHome()
    }
    used.set(i, (used.get(i) ?? 0) + 1)
    const lot = homeLot(fresh(req, i), i)
    lots.push(lot)
    placed.push(lot)
  }
  const before = new Set(state.roads.map((r) => r.id))
  return { state: { ...state, lots, roads, nextId, step, plan: { ...state.plan!, pop } }, lots: placed, roads: roads.filter((r) => !before.has(r.id)) }
}

/** 地形改了（规划变了）：规划的地块照原来的先后在新的规划上重新落一遍，手动的东西原样留着 */
function rebase(state: GrowState): GrowState {
  const olds = state.lots.filter((l) => l.ref !== undefined).sort((a, b) => a.id - b.id)
  let s: GrowState = { ...state, lots: state.lots.filter((l) => l.ref === undefined), roads: state.roads.filter((r) => r.id < WAY_ID), plan: { ...state.plan!, pop: 0 } }
  const vacant: number[] = []
  for (const l of olds) {
    const got = place(s, { use: l.use, area: 1, ...(l.owner === undefined ? {} : { owner: l.owner }), state: l.state === 'building' ? 'building' : 'built' }, { id: l.id, born: l.born })
    // 新的地形上放不下了：这块地没了
    if (!got) continue
    s = got.state
    if (l.state === 'vacant') vacant.push(l.id)
  }
  for (const id of vacant) s = release(s, id)
  // 没有规划的地块时也要按这一刻取路（开局时规划里可能已经有路）
  return olds.length ? s : { ...s, roads: roadsAt(planOf(s), 0, s.roads, s.step, manualBlocker(s)) }
}

naturalHooks.place = (state, req) => place(state, req)
/** 最近画的那一刻：规划、时刻都没变就给同一个对象（调用方凭它知道画面没变，不用重画） */
let drawn: { plan: Plan; pop: number; st: Settlement } | null = null
naturalHooks.draw = (state) => {
  const plan = planOf(state)
  const pop = state.plan!.pop
  if (drawn?.plan !== plan || drawn.pop !== pop) {
    const st = snapshot(plan.hist, pop)
    // 规划认的手动的路不画（手动的那一层自己画）
    drawn = { plan, pop, st: st.roads.some((r) => r.given) ? { ...st, roads: st.roads.filter((r) => !r.given) } : st }
  }
  return drawn.st
}
naturalHooks.rebase = rebase
