import { emitArea, northOf, siteDice, type Ctx } from '../ctx'
import { at, box, centroid, circlePoly, localBox, pointInPoly, type Frame, type P, type Poly } from '../geom'
import { clamp } from '../../gen/util'
import type { BuildingKind } from '../types'
import { addBuilding, plantTree, scatterTrees } from '../wards'
import { allot, composer, flanks, type Elem, type Preset } from './core'

/**
 * 中式的院落群（宫城、寺观、衙署、宗门）：中轴上一进进的院落，每进是"门 + 正殿 + 两侧配殿 / 廊庑"，
 * 院子当中可以有塔、香炉、碑亭、钟鼓楼；中轴两旁可有东西路（方丈、花厅、库房、园子）。
 * 进数随地盘深浅与等级，正殿最大、前后的殿依次收小（等级秩序），中轴对称，东西路可以不对称。
 */


/** 院落的局部坐标：a 从正面往里（米），b 横向（米）；inside 给了就只在它里面盖 */
export function yard(ctx: Ctx, F: Frame, o: { pad?: number; inside?: Poly } = {}) {
  const B = (a0: number, a1: number, b0: number, b1: number): Poly => box(F, Math.min(a0, a1), Math.max(a0, a1), Math.min(b0, b1), Math.max(b0, b1))
  const big = (a0: number, a1: number, b0: number, b1: number, s: number) => Math.abs(a1 - a0) >= s && Math.abs(b1 - b0) >= s
  return {
    ctx,
    F,
    B,
    at: (a: number, b: number) => at(F, a, b),
    /** 一栋不住人的建筑（宫殿、寺观的殿宇都不占民居名额）；压路、压水、压别的房子就不盖 */
    put(kind: BuildingKind, a0: number, a1: number, b0: number, b1: number) {
      if (!big(a0, a1, b0, b1, 1.2)) return false
      const p = B(a0, a1, b0, b1)
      if (o.inside && !p.every((q) => pointInPoly(q, o.inside!))) return false
      return addBuilding(ctx, p, kind, o.pad ?? 0.2)
    },
    pave(a0: number, a1: number, b0: number, b1: number) {
      if (big(a0, a1, b0, b1, 1)) emitArea(ctx, 'plazas', B(a0, a1, b0, b1))
    },
    fence(a0: number, a1: number, b0: number, b1: number) {
      if (big(a0, a1, b0, b1, 6)) emitArea(ctx, 'enclosures', B(a0, a1, b0, b1))
    },
    green(kind: 'garden' | 'park' | 'courtyard', a0: number, a1: number, b0: number, b1: number) {
      if (big(a0, a1, b0, b1, 4)) emitArea(ctx, 'greens', B(a0, a1, b0, b1), kind)
    },
    tree: (a: number, b: number, r: number) => plantTree(ctx, at(F, a, b), r),
    trees(a0: number, a1: number, b0: number, b1: number, dens: number, r0 = 2, r1 = 3.6) {
      if (big(a0, a1, b0, b1, 3)) scatterTrees(ctx, B(a0, a1, b0, b1), dens, r0, r1)
    },
  }
}
export type Yard = ReturnType<typeof yard>

// —————————————————————— 一进院落 ——————————————————————

export type Gate = 'men' | 'triple' | 'chuihua' | 'none'
export type Side = 'xiang' | 'double' | 'lang' | 'none'
export type Centre = 'none' | 'pagoda' | 'twin' | 'offset' | 'ding' | 'trees' | 'belldrum' | 'pool'

/** 一进院落的构成：院门、正殿（种类与半面宽占院宽的比例）、后殿、两侧、院心 */
export interface Jin {
  gate: Gate
  main: BuildingKind | null
  mw: number
  back?: BuildingKind | null
  side: Side
  centre: Centre
  wall?: boolean
}

/** 院门 */
export const GATES: Elem<Gate>[] = [
  { id: 'men', w: 4 },
  { id: 'triple', w: 1.2, min: 44 },
  { id: 'chuihua', w: 1.5 },
  { id: 'none', w: 0.5 },
]
/** 两侧：一对配殿（厢房）、前后两对、贯通的廊庑、空着 */
export const SIDES: Elem<Side>[] = [
  { id: 'xiang', w: 4 },
  { id: 'double', w: 1.5, min: 48 },
  { id: 'lang', w: 1.8, min: 36 },
  { id: 'none', w: 0.6 },
]
/** 院心：塔、东西双塔、偏在一侧的塔、香炉 / 碑亭、一对古树、钟鼓楼、放生池 */
export const CENTRES: Elem<Centre>[] = [
  { id: 'none', w: 2 },
  { id: 'ding', w: 1.5 },
  { id: 'trees', w: 1.5 },
  { id: 'belldrum', w: 1, min: 34 },
  { id: 'pool', w: 0.7, min: 30 },
  { id: 'pagoda', w: 0.8, min: 30 },
  { id: 'twin', w: 0.6, min: 44 },
  { id: 'offset', w: 0.6, min: 40 },
]

/**
 * 盖一进院落（a0 → a1 从前往后，b0 ~ b1 横向）：院墙、院门、正殿坐在院子后部（有后殿时后殿贴后墙），
 * 两侧配殿或廊庑，院心的塔、香炉、树。院子太小返回 false。
 */
export function jin(K: Yard, a0: number, a1: number, b0: number, b1: number, s: Jin): boolean {
  const w = b1 - b0
  const d = a1 - a0
  if (w < 12 || d < 12) return false
  const bm = (b0 + b1) / 2
  const m = 1.4
  if (s.wall !== false) K.fence(a0, a1, b0, b1)
  const hw = clamp(w * s.mw, 4, 34)
  const hd = clamp(Math.min(d * 0.22, hw * 0.85), 3, 16)
  const back = !!s.back && d > 30
  const bd = hd * 0.7
  const e1 = back ? a1 - m - bd - Math.max(2.5, d * 0.06) : a1 - m - d * 0.06
  const e0 = e1 - hd
  if (s.main) K.put(s.main, e0, e1, bm - hw, bm + hw)
  if (back) K.put(s.back!, a1 - m - bd, a1 - m, bm - hw * 0.75, bm + hw * 0.75)
  // 院门
  const gw = clamp(w * 0.12, 2.5, 7)
  const gd = clamp(d * 0.08, 2.5, 5)
  if (s.gate === 'men' || s.gate === 'triple') K.put('hall', a0 + 0.3, a0 + 0.3 + gd, bm - gw, bm + gw)
  if (s.gate === 'triple') for (const sd of [-1, 1]) K.put('hall', a0 + 0.3, a0 + 0.3 + gd * 0.75, bm + sd * (gw + 2), bm + sd * (gw + 2 + gw * 0.6))
  if (s.gate === 'chuihua') K.put('hall', a0 + 0.3, a0 + 0.3 + gd * 0.7, bm - gw * 0.6, bm + gw * 0.6)
  // 两侧：配殿在院门与正殿之间
  const s0 = a0 + m + gd + 1.5
  const s1 = e0 - 1.5
  const sw = clamp(w * 0.13, 3, 8)
  if (s.side === 'lang') {
    const t = clamp(w * 0.05, 2, 3.5)
    for (const sd of [-1, 1]) K.put('hall', a0 + m + gd * 0.5, e1, sd < 0 ? b0 + m : b1 - m - t, sd < 0 ? b0 + m + t : b1 - m)
  } else if (s.side !== 'none' && s1 - s0 > 6) {
    const segs: [number, number][] = s.side === 'double' && s1 - s0 > 18 ? [[s0, (s0 + s1) / 2 - 1], [(s0 + s1) / 2 + 1, s1]] : [[s0 + (s1 - s0) * 0.08, s1 - (s1 - s0) * 0.08]]
    for (const [p, q] of segs) for (const sd of [-1, 1]) K.put('hall', p, q, sd < 0 ? b0 + m : b1 - m - sw, sd < 0 ? b0 + m + sw : b1 - m)
  }
  // 院心（院门与正殿之间的空院）
  const cc = (s0 + s1) / 2
  const room = s1 - s0
  const inner = w - 2 * (m + sw)
  const ps = clamp(Math.min(inner * 0.14, room * 0.3), 2, 6.5)
  if (room > 5)
    switch (s.centre) {
      case 'pagoda':
        K.put('pagoda', cc - ps, cc + ps, bm - ps, bm + ps)
        break
      case 'twin':
        for (const sd of [-1, 1]) K.put('pagoda', cc - ps * 0.8, cc + ps * 0.8, bm + sd * inner * 0.28 - ps * 0.8, bm + sd * inner * 0.28 + ps * 0.8)
        break
      case 'offset':
        K.put('pagoda', cc - ps, cc + ps, bm + inner * 0.27 - ps, bm + inner * 0.27 + ps)
        break
      case 'ding':
        K.put('pagoda', cc - 1.6, cc + 1.6, bm - 1.6, bm + 1.6)
        break
      case 'trees':
        for (const sd of [-1, 1]) K.tree(cc, bm + sd * inner * 0.22, clamp(inner * 0.06, 2, 3.6))
        break
      case 'belldrum':
        for (const sd of [-1, 1]) K.put('pagoda', s0 + 0.5, s0 + 5, bm + sd * inner * 0.3 - 2.25, bm + sd * inner * 0.3 + 2.25)
        break
      case 'pool': {
        const r = clamp(Math.min(inner * 0.18, room * 0.3), 2.5, 9)
        const c = K.at(cc, bm)
        const half = circlePoly(c, r, 14).filter((q) => (q[0] - c[0]) * K.F.f[0] + (q[1] - c[1]) * K.F.f[1] <= 0.01)
        emitArea(K.ctx, 'plazas', half)
        emitArea(K.ctx, 'enclosures', half)
        break
      }
    }
  return true
}

// —————————————————————— 院落群（寺观、衙署、宗门） ——————————————————————

type Kind = 'palace' | 'temple' | 'sect'

/** 塔在哪：不设塔、第一进院心（塔在殿前，早期的佛寺）、东西双塔、东路塔院 / 院里偏一侧、最后一进（塔在殿后） */
type Pagoda = 'none' | 'axis' | 'twin' | 'side' | 'rear'
const PAGODA: Elem<Pagoda>[] = [
  { id: 'none', w: 2 },
  { id: 'axis', w: 1.2 },
  { id: 'twin', w: 1, min: 50 },
  { id: 'side', w: 1.2 },
  { id: 'rear', w: 0.8 },
]
/** 最后一进：后殿、藏经阁（横宽的楼）、后园、高阁 */
type Rear = 'hall' | 'cangjing' | 'garden' | 'tower'
const REAR: Elem<Rear>[] = [
  { id: 'hall', w: 2 },
  { id: 'cangjing', w: 1.5 },
  { id: 'garden', w: 1.2, min: 40 },
  { id: 'tower', w: 1 },
]
/** 殿宇大小的排法：正殿居中最大（前后收小）、由前往后渐大、最前最大 */
type Profile = 'peak' | 'rising' | 'falling'
const PROFILE: Elem<Profile>[] = [
  { id: 'peak', w: 3 },
  { id: 'rising', w: 2 },
  { id: 'falling', w: 0.6 },
]
/** 东西路：方丈 / 花厅一类的小院、成排的僧房 / 值房、园子、库房、空着 */
type Wing = 'yard' | 'rows' | 'garden' | 'stores' | 'none'
const WINGS: Elem<Wing>[] = [
  { id: 'yard', w: 3 },
  { id: 'rows', w: 2 },
  { id: 'garden', w: 1.5 },
  { id: 'stores', w: 1 },
  { id: 'none', w: 0.5 },
]
/** 山门前：只有山门、三门并列、门前影壁 */
type Front = 'shanmen' | 'sanmen' | 'yingbi'
const FRONT: Elem<Front>[] = [
  { id: 'shanmen', w: 3 },
  { id: 'sanmen', w: 1.5, min: 50 },
  { id: 'yingbi', w: 1.5 },
]

/** 以前的几种形制，现在是预设（给槽位加权）：禅宗伽蓝七堂、唐式殿前塔、双塔、衙署、王府、道观 */
const PRESETS: Record<Kind, Preset[]> = {
  temple: [
    { id: 'chan', w: 3, bias: { pagoda: { none: 3, side: 1.5 }, 'c0.centre': { belldrum: 6 }, rear: { cangjing: 4 }, profile: { peak: 3 } } },
    { id: 'tang', w: 1.5, bias: { pagoda: { axis: 6 }, side: { lang: 4 }, profile: { rising: 3 } } },
    { id: 'twin', w: 1, bias: { pagoda: { twin: 8 }, front: { sanmen: 2 } } },
    { id: 'tower', w: 0.8, bias: { pagoda: { rear: 6 }, rear: { tower: 2 } } },
  ],
  palace: [
    { id: 'yamen', w: 3, bias: { profile: { peak: 4 }, front: { yingbi: 4 }, rear: { hall: 2, garden: 2 }, wing: { rows: 2, yard: 2 } } },
    { id: 'wangfu', w: 2, bias: { profile: { rising: 4 }, rear: { tower: 2, garden: 1.5 }, wing: { yard: 3, garden: 2 } } },
  ],
  sect: [
    { id: 'guan', w: 2, bias: { rear: { tower: 4 }, pagoda: { none: 3 }, wing: { garden: 3 } } },
    { id: 'shan', w: 1.5, bias: { pagoda: { axis: 3, rear: 2 }, side: { lang: 3 } } },
  ],
}

/**
 * 东式大型院落群：宫城（王府、衙署）、寺观、宗门，坐北朝南。
 * 骨架：山门（或影壁、三门）→ 中轴一进进院落（进数随地盘与等级）→ 最后一进（后殿、藏经阁、后园或高阁）；
 * 地盘宽时两旁有东西路。塔的位置、殿的大小排法、各进两侧与院心都从元素池里按院落的位置抽签（siteDice）。
 */
export function eastCompound(ctx: Ctx, area0: Poly, kind: Kind): Poly | null {
  const { n, e } = northOf(ctx)
  const A = localBox(area0, e, n)
  const { u0, u1, v0, v1 } = A
  const w = u1 - u0
  const h = v1 - v0
  const uc = (u0 + u1) / 2
  const vc = (v0 + v1) / 2
  // 取包围盒内一个居中的矩形院落；压到水、路、城墙或已有的建筑就逐级缩小，太小就不建
  let cw = 0
  let ch = 0
  let court: Poly | null = null
  // 合成的大寺（grand）地盘大得多：中轴更多进、两旁的东西路
  const grand = ctx.tier === 'grand'
  for (const k of [1, 0.82, 0.68, 0.56]) {
    cw = Math.min(w * 0.9, kind === 'palace' || grand ? 170 : 110) * k
    ch = Math.min(h * 0.9, kind === 'palace' || grand ? 200 : 130) * k
    if (Math.min(cw, ch) < 34) return null
    const q = A.box(uc - cw / 2, uc + cw / 2, vc - ch / 2, vc + ch / 2)
    const probe: P[] = [...q, centroid(q)]
    for (let i = 0; i < 4; i++) probe.push([(q[i][0] + q[(i + 1) % 4][0]) / 2, (q[i][1] + q[(i + 1) % 4][1]) / 2])
    if (probe.some((t) => ctx.T.waterAt(t) < 3)) continue
    if (ctx.corridors.hitsPoly(q, 0.5, ['road', 'wall']) || ctx.occ.overlaps(q)) continue
    court = q
    break
  }
  if (!court) return null
  if (!court.every((p) => pointInPoly(p, area0))) emitArea(ctx, 'enclosures', area0)
  else emitArea(ctx, 'enclosures', court)
  emitArea(ctx, 'plazas', court)
  const F: Frame = { o: A.at(uc, vc - ch / 2), f: n, l: e }
  const K = yard(ctx, F, { inside: area0 })
  const rank = Math.min(2, (ctx.p.capital ? 2 : ctx.p.size === 'city' ? 1 : 0) + (grand ? 1 : 0))
  const C = composer(siteDice(ctx, centroid(area0), `east.${kind}`), `east-${kind}`, PRESETS[kind], { size: Math.min(cw, ch), rank, tier: ctx.tier })
  const big: BuildingKind = kind === 'palace' ? 'keep' : 'temple'
  // 东西路：地盘宽时中轴两旁各一路
  const lane = 2.5
  const sideW = cw >= 64 && C.chance('sideAxes', kind === 'palace' ? 0.7 : 0.55) ? cw * C.num('sideW', 0.19, 0.25) : 0
  const b0 = -cw / 2 + (sideW ? sideW + lane : 0)
  const b1 = -b0
  const Wc = b1 - b0
  // 山门前
  const front = C.pick('front', FRONT, { size: Wc })
  const fd = front === 'yingbi' ? 7 : 0
  if (front === 'yingbi') K.put('hall', 1.5, 3, -Math.min(10, Wc * 0.22), Math.min(10, Wc * 0.22))
  // 中轴的进数：随进深（每进至少二十来米）与等级
  const maxN = Math.max(2, Math.min(kind === 'sect' ? 4 : grand ? 6 : 5, Math.floor((ch - fd) / 22)))
  const N = C.int('jin', Math.min(maxN, 2 + (rank > 0 ? 1 : 0)), maxN)
  const pagoda: Pagoda = kind === 'palace' ? 'none' : C.pick('pagoda', PAGODA, { size: Wc })
  const rear0: Rear = C.pick('rear', REAR, { size: Wc, only: (r) => kind !== 'palace' || r !== 'cangjing' })
  // 最后一进另作他用（后园、藏经阁、高阁、塔）时正殿不能在那一进；两进又有殿前塔时不够分，最后一进仍是殿
  const rear: Rear = N < 3 && pagoda === 'axis' ? 'hall' : rear0
  const special = rear !== 'hall' || pagoda === 'rear'
  const profile = C.pick('profile', PROFILE)
  // 正殿（最大的一座）：居中最大时在第二进或当中；渐大时在最后一座殿；渐小时在第一进
  const lastHall = special ? N - 2 : N - 1
  const main = profile === 'rising' ? Math.max(0, lastHall) : profile === 'falling' ? (pagoda === 'axis' ? Math.min(1, lastHall) : 0) : clamp(Math.round((lastHall + (pagoda === 'axis' ? 1 : 0)) / 2 + 0.25), 0, Math.max(0, lastHall))
  const mw = C.num('mw', 0.26, 0.36)
  // 各进的深浅：正殿那一进深些，后园按偏好
  const items = Array.from({ length: N }, (_, i) => ({ pref: i === main ? 1.4 : i === N - 1 && rear === 'garden' ? 1.2 : 1, min: 14, drop: i === N - 1 || i === main ? undefined : N - i }))
  const { keep, len } = allot(items, ch - fd - 1, 0, main)
  const side = C.pick('side', SIDES, { size: Wc })
  let a = fd + 0.5
  keep.forEach((i, k) => {
    const d = len[k]
    const a0 = a
    const a1 = a + d
    a = a1
    const r = Math.abs(i - main) / Math.max(1, N - 1)
    const last = i === N - 1
    const s: Jin = {
      gate: i === 0 ? (front === 'sanmen' ? 'triple' : 'men') : C.pick(`c${i}.gate`, GATES, { size: Wc, only: (g) => g !== 'triple' }),
      main: i < main ? 'hall' : big,
      mw: mw * (1 - 0.3 * r),
      back: i === main && d > 34 && C.chance('back', 0.5) ? 'hall' : null,
      side: last && rear === 'garden' ? 'none' : side,
      centre: 'none',
    }
    // 塔：第一进院心、东西双塔、偏一侧（没有东西路时），或最后一进里代替后殿
    if (i === 0) s.centre = pagoda === 'axis' ? 'pagoda' : pagoda === 'twin' ? 'twin' : pagoda === 'side' && !sideW ? 'offset' : C.pick('c0.centre', CENTRES, { size: Wc, only: (c) => c === 'none' || c === 'belldrum' || c === 'pool' || c === 'ding' || c === 'trees' })
    else s.centre = C.pick(`c${i}.centre`, CENTRES, { size: Wc, only: (c) => c === 'none' || c === 'ding' || c === 'trees' })
    if (i === 0 && pagoda === 'axis') {
      // 塔在殿前：第一进的"正殿"就是塔，院心不再放
      s.main = null
      s.centre = 'none'
      const ps = clamp(Math.min(Wc * 0.12, d * 0.3), 4, 9)
      K.put('pagoda', a0 + d * 0.55 - ps, a0 + d * 0.55 + ps, -ps, ps)
    }
    if (last && rear === 'garden' && N > 1) {
      // 后园：园墙里的树、一座亭、一方池
      K.fence(a0, a1, b0, b1)
      K.green('garden', a0 + 1, a1 - 1, b0 + 1, b1 - 1)
      const pr = clamp(Math.min(Wc, d) * 0.18, 3, 12)
      const pc = K.at((a0 + a1) / 2, 0)
      const pond = circlePoly(pc, pr, 16, C.num('pondPh', 0, 3))
      emitArea(ctx, 'plazas', pond)
      ctx.occ.add(pond)
      K.put('pagoda', a1 - 2 - 5, a1 - 2, Wc * 0.25 - 2.5, Wc * 0.25 + 2.5)
      K.trees(a0 + 2, a1 - 2, b0 + 2, b1 - 2, 0.012, 2, 3.6)
      return
    }
    if (last && (rear === 'cangjing' || rear === 'tower' || pagoda === 'rear')) {
      s.main = null
      const hw = pagoda === 'rear' || rear === 'tower' ? clamp(Wc * 0.1, 4, 9) : clamp(Wc * 0.4, 8, 36)
      const hd = pagoda === 'rear' || rear === 'tower' ? hw : clamp(d * 0.2, 4, 10)
      K.put(pagoda === 'rear' ? 'pagoda' : rear === 'tower' ? 'pagoda' : 'temple', a1 - 2 - hd * 2 + (hd === hw ? 0 : hd), a1 - 2, -hw, hw)
    }
    jin(K, a0, a1, b0, b1, s)
  })
  // 东西路
  if (sideW) {
    const [west, east] = flanks(C, 'wing', WINGS, C.chance('mirror', 0.35))
    for (const [sd, wing] of [[-1, west], [1, east]] as const) {
      const c0 = sd < 0 ? -cw / 2 : b1 + lane
      const c1 = sd < 0 ? b0 - lane : cw / 2
      K.fence(0.5, ch - 0.5, c0, c1)
      // 塔院：塔在东路时东路前半是塔院
      let s0 = 0.5
      if (pagoda === 'side' && sd > 0) {
        const pd = Math.min(ch * 0.4, (c1 - c0) * 1.3)
        const ps = clamp((c1 - c0) * 0.22, 3, 8)
        K.fence(s0, s0 + pd, c0, c1)
        K.put('pagoda', s0 + pd / 2 - ps, s0 + pd / 2 + ps, (c0 + c1) / 2 - ps, (c0 + c1) / 2 + ps)
        s0 += pd + 1
      }
      wingFill(K, C, wing, s0, ch - 0.5, c0, c1, sd)
    }
  }
  C.done(centroid(court))
  // 整座院落登记为占地，后来的民居与树木都绕开
  ctx.occ.add(court)
  return A.box(uc - cw / 2 - 4, uc + cw / 2 + 4, vc - ch / 2 - 4, vc + ch / 2 + 4)
}

/** 东西路的一条：小院一两进、成排的屋、园子、库房 */
export function wingFill(K: Yard, C: { num: (n: string, a: number, b: number) => number }, wing: Wing, a0: number, a1: number, c0: number, c1: number, sd: number) {
  const w = c1 - c0
  const d = a1 - a0
  if (w < 8 || d < 10) return
  if (wing === 'yard') {
    const n = d > w * 2.4 ? 2 : 1
    const step = d / n
    for (let k = 0; k < n; k++) jin(K, a0 + k * step + 0.5, a0 + (k + 1) * step - 0.5, c0 + 0.5, c1 - 0.5, { gate: 'chuihua', main: 'hall', mw: 0.32, side: w > 26 ? 'xiang' : 'none', centre: k === 0 ? 'trees' : 'none', wall: true })
  } else if (wing === 'rows') {
    // 一排排的僧房、值房：横着的长屋，屋间是窄院
    for (let a = a0 + 2; a + 6 < a1 - 1; a += 12) K.put('hall', a, a + 6, c0 + 1.5, c1 - 1.5)
  } else if (wing === 'garden') {
    K.green('garden', a0 + 1, a1 - 1, c0 + 1, c1 - 1)
    const ph = C.num(`wg${sd}`, 0.3, 0.7)
    K.put('pagoda', a0 + d * ph - 2.5, a0 + d * ph + 2.5, (c0 + c1) / 2 - 2.5, (c0 + c1) / 2 + 2.5)
    K.trees(a0 + 1.5, a1 - 1.5, c0 + 1.5, c1 - 1.5, 0.014, 2, 3.8)
  } else if (wing === 'stores') {
    for (let a = a0 + 2; a + 7 < a1 - 1; a += 10) K.put('shed', a, a + 7, c0 + 1.5, c1 - 1.5)
  }
}
