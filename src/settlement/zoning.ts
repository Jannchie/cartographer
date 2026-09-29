import { ROAD_CLEAR } from './roads'
import { cityDice, hashAt, isFree, mark, type Ctx } from './ctx'
import { grandChance, grandSize } from './tiers'
import { FEATURES, featureEnv, resolveCounts, type FeatureId, type Site } from './features'
import { bboxOf, convexOverlap, dist, insetConvex, LineIndex, pointAt, pointInPoly, polylineLength, polylineDist, rect, resample, type P, type Poly } from './geom'
import type { Building, SettlementParams, WardType } from './types'
import { addBuilding, inside } from './wards'
import { checkpoint, clearYards, demolish, removable, rollback } from './undo'
import { outMark, stamp } from './history'

/** 城内的一块候选片区 */
export interface Lot {
  poly: Poly
  site: P
  /** 相邻候选的下标 */
  nb: number[]
  /** 全部相邻片区的数目（含城外的）：少于它说明这块在城区边缘 */
  deg: number
  /** 加入城区时累计能住的户数（生长历史，越小越早） */
  joinedAt: number
  type?: WardType
  /** 都城的宫城由几块片区合成：同一座宫城的片区记着主片区（选址选中的那块）的下标 */
  palace?: number
  /** 合成的大地标（大社、朝圣大教堂、大园囿、同心城）：grand */
  grand?: boolean
  /** 定下功能时的人口：地标按那时的规模盖，城市后来长大也不跟着放大、挪动 */
  foundPop?: number
}

/**
 * 通用选址，按城区的生长历史"重演"：片区按加入的先后逐块加入，每加入一块，按那时的人口算出
 * 各要素应有的数量，不够的在已加入、还没有功能的片区里挑最合适的补上。已经放下的要素不再挪动，
 * 城长大只是在后来加入的片区里添新的——特殊片区的位置只取决于历史（生长顺序的前缀），与最终人口无关。
 * 打分只用"当时"的信息：离城心按当时的城区半径归一、是否在当时城区的边缘、地势按绝对高差。
 * 扰动按片区位置取。没分到的片区是民居。
 */
export function zoneLots(ctx: Ctx, lots: Lot[], center: number, households: (cum: number) => number) {
  const { p } = ctx
  const arterials = ctx.out.roads.filter((r) => r.kind === 'main' || r.kind === 'highway').map((r) => r.line)
  // 干道（城内段与城外段合起来）不随人口变；城里后来开的街巷不算，否则同一段历史随现在修了哪些街而改写
  const dense = arterials.map((l) => resample(l, 3))
  const h0 = ctx.T.heightAt(ctx.center)
  // 与时间无关的部分先算好
  const fixed = lots.map((l, i) => {
    const core = l.poly.map((v) => [v[0] * 0.7 + l.site[0] * 0.3, v[1] * 0.7 + l.site[1] * 0.3] as P)
    let gap = Infinity
    for (const a of arterials) gap = Math.min(gap, polylineDist(l.site, a))
    return {
      water: l.poly.some((v) => ctx.T.waterAt(v) < 4),
      sea: l.poly.some((v) => ctx.T.seaAt(v)),
      high: Math.min(1, Math.max(0, 0.5 + (ctx.T.heightAt(l.site) - h0) / 40)),
      clear: !dense.some((l) => l.some((q) => pointInPoly(q, core))),
      nearCenter: center >= 0 && lots[center].nb.includes(i),
      road: Math.max(0, 1 - gap / (ctx.cfg.patch * 0.9)),
      area: Math.abs(l.poly.reduce((a, v, k) => a + v[0] * l.poly[(k + 1) % l.poly.length][1] - l.poly[(k + 1) % l.poly.length][0] * v[1], 0)) / 2,
    }
  })
  const placed = new Map<FeatureId, P[]>()
  const count = new Map<FeatureId, number>()
  const put = (id: FeatureId, q: P) => {
    ;(placed.get(id) ?? placed.set(id, []).get(id)!).push(q)
    count.set(id, (count.get(id) ?? 0) + 1)
  }
  // 预先定好的片区（城心、副中心）算作已放下
  for (const l of lots) if (l.type) put(l.type as FeatureId, l.site)
  const defs = FEATURES.filter((f) => f.form === 'ward').sort((a, b) => a.order - b.order)
  const order = lots.map((_, i) => i).sort((a, b) => lots[a].joinedAt - lots[b].joinedAt)
  const joined = new Set<number>()
  let areaJoined = 0
  const walled = ctx.env.walled
  for (let k = 0; k < order.length; k++) {
    joined.add(order[k])
    areaJoined += fixed[order[k]].area
    // 同一时刻加入的（填洞）一起算
    if (k + 1 < order.length && lots[order[k + 1]].joinedAt === lots[order[k]].joinedAt) continue
    // 只在历史上真有的时刻（某块片区加入时）放要素，不在"现在"另加一步：
    // 否则同一个要素在这一帧按现在的城区选址，城再长一点又按下一块片区加入时的城区重选，跳来跳去。
    // 墙里规划了、还没住上人的片区（加入时的人口超过现在）也不放要素，留作民居
    const pop = households(lots[order[k]].joinedAt)
    if (pop > p.population) break
    const R = Math.max(1, Math.sqrt(areaJoined / Math.PI))
    const q: SettlementParams = { ...p, population: pop }
    const env = featureEnv(q, walled)
    const auto = resolveCounts({ ...q, counts: {} }, env)
    const site = (i: number): Site => {
      const l = lots[i]
      const f = fixed[i]
      return {
        dc: dist(l.site, ctx.center) / R,
        wall: l.nb.filter((j) => joined.has(j)).length < l.deg,
        water: f.water,
        sea: f.sea,
        high: f.high,
        clear: f.clear,
        nearCenter: f.nearCenter,
        size: f.area / (ctx.cfg.patch * ctx.cfg.patch),
        road: f.road,
        near: (id) => {
          let d = Infinity
          for (const s of placed.get(id) ?? []) d = Math.min(d, dist(s, l.site))
          return d / R
        },
      }
    }
    for (const def of defs) {
      // 那时应有的数量：自动的按那时的人口推；手动的随人口按比例逐步出现
      const manual = p.counts[def.id]
      const want = manual !== undefined && manual !== null ? Math.ceil((Math.min(def.max, manual) * pop) / p.population) : auto[def.id]
      const tag = `zoning.lot.${def.id}`
      while ((count.get(def.id) ?? 0) < want) {
        let best = -1
        let bs = -Infinity
        const nth = count.get(def.id) ?? 0
        const scored: [number, number][] = []
        for (const i of joined) {
          if (lots[i].type) continue
          const sc = def.site ? def.site(site(i), env) : 0
          if (sc === -Infinity) continue
          const v = sc + hashAt(ctx, lots[i].site, tag, nth % 16) * 0.6
          scored.push([v, i])
          if (v > bs) {
            bs = v
            best = i
          }
        }
        if (best < 0) break
        // 都城的宫城：在得分前几的候选里挑能并成最大一片的（片区里的街巷拆掉，干道、城墙、河隔开的不并）
        let group: number[] = []
        let grand = false
        if (def.id === 'castle' && p.capital && nth === 0) {
          let ba = 0
          for (const [, i] of scored.sort((a, b) => b[0] - a[0]).slice(0, 8)) {
            const g = precinct(ctx, lots, fixed, i)
            const a = g.reduce((s, j) => s + fixed[j].area, 0)
            if (a > ba) {
              ba = a
              group = g
            }
          }
          if (group.length) best = group[0]
        } else if (nth === 0 && grandChance(ctx, def.id, env) > cityDice(ctx, 'zoning.grand').h(def.id)) {
          // 大地标（大社、朝圣大教堂、大园囿、同心城）：同样由几块相邻片区合成。骰子只看种子：城长大时一旦成了大地标就一直是。
          // 就在不合成时本该落的那块地上向四周并（不另挑别处）：城长大、跨过门槛升格时，地标原地扩大，不会跳到别的片区去
          const g = precinct(ctx, lots, fixed, best, grandSize(ctx, def.id), true)
          if (g.length >= 2) group = g
          if (group.length) {
            best = group[0]
            grand = true
          }
        }
        lots[best].type = def.id as WardType
        lots[best].foundPop = pop
        put(def.id, lots[best].site)
        for (const j of group) {
          lots[j].type = def.id as WardType
          lots[j].palace = best
          lots[j].foundPop = pop
          if (grand) lots[j].grand = true
        }
      }
    }
  }
  for (const l of lots) if (!l.type) l.type = 'common'
}

/**
 * 宫城的范围：从主片区出发，每次并上与已并片区公共边最长的相邻片区，城越大并得越多（大都会六块，小城三块）。
 * 小街小巷圈进宫城就拆掉（见 generate.ts 的 palaceSite），只有干道、城墙、河隔开的不并，片区中间也不能有它们穿过
 * （沿片区边走的干道、城墙离片区内缩 12 米的范围够不着）。
 * 返回并成的片区（主片区在第一个）；主片区不合适返回空数组。
 */
function precinct(ctx: Ctx, lots: Lot[], fixed: { water: boolean }[], seed: number, want = ctx.p.population > 15000 ? 6 : ctx.p.population > 6000 ? 4 : 3, wet = false): number[] {
  // 干道各建一张线段网格：候选片区只和附近的路段比
  const major = ctx.out.roads.filter((r) => r.kind === 'main' || r.kind === 'highway').map((r) => ({ idx: new LineIndex(r.line, r.width / 2 + 1.5), d: r.width / 2 + 1.5 }))
  const blocked = (q: Poly) => ctx.corridors.hitsPoly(q, 0.5, ['wall', 'river']) || major.some((r) => r.idx.nearPoly(q, r.d))
  // 合成的大地标（wet）可以挨着水：只要片区中心离水够远（宫殿、园、社的矩形另外让开水面）
  const wetOk = (i: number) => (wet ? ctx.T.waterAt(lots[i].site) > 20 : !fixed[i].water)
  // 合成的大地标只要干道不从片区当中穿过（贴着片区边走的不算）
  const core = (i: number) => insetConvex(lots[i].poly, wet ? 20 : 12)
  if (!wetOk(seed) || blocked(core(seed))) return []
  const shared = (a: Poly, b: Poly) => {
    const vs = a.filter((v) => b.some((w) => dist(v, w) < 0.1))
    return vs.length >= 2 ? ([vs[0], vs[vs.length - 1]] as [P, P]) : null
  }
  const group = [seed]
  while (group.length < want) {
    let best = -1
    let bl = 0
    for (const m of group)
      for (const j of lots[m].nb) {
        if (group.includes(j) || lots[j].type || !wetOk(j) || blocked(core(j))) continue
        const e = shared(lots[m].poly, lots[j].poly)
        // 公共边上是干道（或城墙、河）就隔开了
        if (!e || blocked([e[0], e[1]])) continue
        const L = dist(e[0], e[1])
        if (L > bl) {
          bl = L
          best = j
        }
      }
    if (best < 0) break
    group.push(best)
  }
  return group
}

/**
 * 地标建筑（酒馆、传送门……）：片区填好房子之后，沿主街找位置插进去。
 * 候选是街边一个个点（按要素自己的随机数流打乱），落在允许的片区里、与同类相隔足够远；
 * 通用做法是拆掉占位的普通房子，盖一栋更大的；有专属生成的就交给它。
 */
export function placeLandmarks(ctx: Ctx) {
  const { counts } = ctx
  // 片区与建筑的包围盒网格：候选点落在哪块片区、压到哪些房子，只看附近的
  const B = 60
  const bucket = <T,>(items: T[], poly: (t: T) => Poly) => {
    const g = new Map<number, T[]>()
    for (const it of items) {
      const bb = bboxOf(poly(it))
      for (let y = Math.floor(bb[1] / B); y <= Math.floor(bb[3] / B); y++)
        for (let x = Math.floor(bb[0] / B); x <= Math.floor(bb[2] / B); x++) (g.get(y * 100003 + x) ?? g.set(y * 100003 + x, []).get(y * 100003 + x)!).push(it)
    }
    return (q: P) => g.get(Math.floor(q[1] / B) * 100003 + Math.floor(q[0] / B)) ?? []
  }
  const wardsAt = bucket(ctx.out.wards, (w) => w.poly)
  // 占用网格里的实体 → 建筑（压到的是哪种房子）；地标新盖的随时补进来
  const byPoly = new Map<Poly, Building>()
  const index = (from: number) => {
    for (let k = from; k < ctx.out.buildings.length; k++) byPoly.set(ctx.out.buildings[k].poly, ctx.out.buildings[k])
  }
  index(0)
  const streets = ctx.out.roads.filter((r) => r.kind === 'main' || r.kind === 'street' || r.kind === 'highway')
  for (const def of FEATURES) {
    const spec = def.landmark
    const n = counts[def.id] ?? 0
    if (!spec || n <= 0) continue
    const tag = `zoning.landmark.${def.id}`
    const cands: { at: P; axis: P; key: number }[] = []
    for (const r of streets) {
      const L = polylineLength(r.line)
      for (let s = 10; s < L - 10; s += 16) {
        const { p, angle } = pointAt(r.line, s)
        const axis: P = [Math.cos(angle), Math.sin(angle)]
        const nrm: P = [-axis[1], axis[0]]
        const side = hashAt(ctx, p, `${tag}.side`) < 0.5 ? -1 : 1
        // 退到道路走廊之外再留 1 米
        const off = r.width / 2 + ROAD_CLEAR + 1 + spec.d / 2
        const at: P = [p[0] + nrm[0] * off * side, p[1] + nrm[1] * off * side]
        cands.push({ at, axis, key: hashAt(ctx, p, `${tag}.order`) })
      }
    }
    cands.sort((a, b) => a.key - b.key)
    const made: P[] = []
    const spacing = Math.max(70, ctx.Rin * 0.35)
    for (const c of cands) {
      if (made.length >= n) break
      if (made.some((m) => dist(m, c.at) < spacing)) continue
      const ward = wardsAt(c.at).find((w) => pointInPoly(c.at, w.poly))
      if (!ward || !spec.hosts.includes(ward.type)) continue
      const fp = rect(c.at, c.axis, spec.w, spec.d)
      if (!inside(fp, ward.poly) || fp.some((v) => ctx.T.waterAt(v) < 2)) continue
      // 先确认不压路、不压墙，再拆房子（免得拆了却盖不了，留下空洞）
      if (ctx.corridors.hitsPoly(fp, 0.5)) continue
      // 让位：拆掉压在这里的普通房子（特殊建筑、井、台这些不是房子的实体不拆，换个位置）
      const blocking = ctx.occ.query(bboxOf(fp)).filter((poly) => convexOverlap(poly, fp))
      if (!blocking.every((poly) => byPoly.has(poly) && removable(byPoly.get(poly)!))) continue
      // 拆了却盖不成就撤回（不留空洞）；拆掉的住户退回民居预算
      const cp = checkpoint(ctx)
      // 成长史：第 k 座在自动数量长到 k + 1 时出现，腾地方拆掉的人家那时才拆
      const hm = ctx.history ? outMark(ctx) : null
      const gone = new Set(blocking)
      demolish(ctx, (b) => gone.has(b.poly))
      const before = checkpoint(ctx)
      const ok = isFree(ctx, fp, { pad: 0.5 }) && (spec.build ? spec.build(ctx, c.at, c.axis) : addBuilding(ctx, fp, spec.kind, 0.5))
      if (!ok) {
        rollback(ctx, cp)
        continue
      }
      index(before.len.get('buildings')!)
      // 拆掉的人家留下的院墙、菜园、树也清走（地标自己刚加的院墙、院子留着）
      clearYards(ctx, fp, { to: before })
      mark(ctx, c.at, spec.mark)
      // 数量够了、所在的片区也有人住了才盖（不在那时还是田野的外围先冒出一座）
      if (hm) stamp(ctx, hm, Math.max(ctx.history!.countPop(def.id, made.length), ctx.history!.life.get(ward)?.born ?? 0))
      made.push(c.at)
    }
  }
}
