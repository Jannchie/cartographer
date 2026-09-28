import { isFree, placeable, siteDice, type Ctx } from '../ctx'
import { area, at, box, centroid, circlePoly, clipConvex, insetConvex, unit, type Frame, type P, type Poly } from '../geom'
import { clamp } from '../../gen/util'
import type { BuildingKind } from '../types'
import { addBuilding, addGroup, inside, scatterTrees } from '../wards'
import { composer, type Elem, type Preset } from './core'

/**
 * 日本寺院的伽蓝配置（骨架）：
 * - 四天王寺式：中门—塔—金堂—讲堂一条线，回廊从中门围到讲堂；
 * - 法隆寺式：回廊里塔与金堂左右并立（不对称；反过来是法起寺式），讲堂在回廊后；
 * - 药师寺式：金堂前东西双塔，都在回廊里；
 * - 东大寺式：回廊只围金堂（大佛殿），双塔在回廊外的前庭两角，各有塔院；
 * - 禅宗伽蓝：总门—三门—佛殿—法堂—方丈一线，庫裏、僧堂分列两侧，门前放生池，两旁塔头；
 * - 净土真宗：御影堂与阿弥陀堂左右并排朝着门，各有一座门；
 * - 近世寺院：山门、本堂、庫裏、钟楼，有的有塔，本堂后是墓地。
 * 古代的伽蓝要大地盘、大城；各部件（门、钟楼经藏的位置、放生池、塔头、墓地）从元素池里按位置抽签。
 */

type Plan = 'kinsei' | 'zen' | 'shinshu' | 'shitennoji' | 'horyuji' | 'yakushiji' | 'todaiji'
const PLANS: Elem<Plan>[] = [
  { id: 'kinsei', w: 4 },
  { id: 'zen', w: 2, min: 55 },
  { id: 'shinshu', w: 1, min: 55 },
  { id: 'shitennoji', w: 1, min: 64, rank: 1 },
  { id: 'horyuji', w: 1, min: 64, rank: 1 },
  { id: 'yakushiji', w: 0.8, min: 70, rank: 1 },
  { id: 'todaiji', w: 0.6, min: 84, rank: 1 },
]
/** 山门：二重的楼门、单层的四脚门 / 药医门、仁王门 */
type Gate = 'romon' | 'yakui' | 'nio'
const GATES: Elem<Gate>[] = [
  { id: 'romon', w: 2 },
  { id: 'yakui', w: 2 },
  { id: 'nio', w: 1.5 },
]
/** 本堂后面：墓地、树林、方丈庭园 */
type Back = 'bochi' | 'mori' | 'niwa'
const BACK: Elem<Back>[] = [
  { id: 'bochi', w: 3 },
  { id: 'mori', w: 1.5 },
  { id: 'niwa', w: 1 },
]

const PRESETS: Preset[] = [
  { id: 'machi', w: 4, bias: { plan: { kinsei: 5 }, back: { bochi: 3 } } },
  { id: 'kyoto', w: 1.5, bias: { plan: { zen: 6, shinshu: 2 }, back: { niwa: 3 }, pond: { yes: 3 } } },
  { id: 'nara', w: 1.2, bias: { plan: { shitennoji: 3, horyuji: 3, yakushiji: 3, todaiji: 3 }, back: { mori: 3 }, gate: { nio: 3 } } },
]


/**
 * 寺院：土墙围合的寺域，山门朝 facing（街、或城下町的城）。放不下主殿时是一片寺林。
 */
export function garan(ctx: Ctx, block: Poly, facing: P) {
  const rng = ctx.rng
  // 寺院多在坡上：比民居容许更陡的地；实在放不下就是一片寺林
  const zone = placeable(ctx, insetConvex(block, 2), 3, 0.6)
  if (!zone || zone.length < 3 || area(zone) < 900) {
    const g = placeable(ctx, insetConvex(block, 3), 3, 1)
    if (g && g.length >= 3) scatterTrees(ctx, g, 0.004, 2.5, 5)
    return
  }
  // 标架：f 从山门往里
  const f = unit([-facing[0], -facing[1]])
  const l: P = [-f[1], f[0]]
  const c = centroid(zone)
  let a0 = Infinity
  let a1 = -Infinity
  let b0 = Infinity
  let b1 = -Infinity
  for (const v of zone) {
    const a = (v[0] - c[0]) * f[0] + (v[1] - c[1]) * f[1]
    const b = (v[0] - c[0]) * l[0] + (v[1] - c[1]) * l[1]
    a0 = Math.min(a0, a)
    a1 = Math.max(a1, a)
    b0 = Math.min(b0, b)
    b1 = Math.max(b1, b)
  }
  const F: Frame = { o: c, f, l }
  const precinct = clipConvex(box(F, a0, a1, b0, b1), zone)
  if (precinct.length < 3) return
  const D = a1 - a0
  const W = b1 - b0
  const bm = (b0 + b1) / 2
  const rank = ctx.p.capital ? 2 : ctx.p.size === 'city' ? 1 : 0
  const C = composer(siteDice(ctx, c, 'jiin'), 'jiin', PRESETS, { size: Math.min(D, W * 1.15), rank })
  const B = (x0: number, x1: number, y0: number, y1: number) => box(F, Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1))
  const ok = (p: Poly) => inside(p, precinct) && isFree(ctx, p)
  /** 一座建筑（放不下就不盖） */
  const mk = (kind: BuildingKind, x0: number, x1: number, y0: number, y1: number) => {
    const p = B(x0, x1, y0, y1)
    return Math.abs(x1 - x0) > 1 && Math.abs(y1 - y0) > 1 && ok(p) && addGroup(ctx, [[p, kind]], 0)
  }
  /** 一组建筑：全部放下或一个都不放 */
  const group = (parts: [BuildingKind, number, number, number, number][]) => {
    const ps: [Poly, BuildingKind][] = parts.map(([k, x0, x1, y0, y1]) => [B(x0, x1, y0, y1), k])
    return ps.every(([p]) => ok(p)) && addGroup(ctx, ps, 0)
  }
  // 白砂的庭（回廊里、堂前）：盖完再登记占地，四周种树时让开
  const courts: Poly[] = []
  const gravel = (x0: number, x1: number, y0: number, y1: number) => {
    if (x1 - x0 > 3 && y1 - y0 > 3) {
      ctx.out.plazas.push(B(x0, x1, y0, y1))
      courts.push(B(x0, x1, y0, y1))
    }
  }
  const fence = (x0: number, x1: number, y0: number, y1: number) => ctx.out.enclosures.push(B(x0, x1, y0, y1))
  const pagoda = (a: number, b: number, s: number) => mk('pagoda', a - s / 2, a + s / 2, b - s / 2, b + s / 2)
  /** 山门：楼门宽而深，四脚门小，仁王门居中 */
  const gateAt = (g: Gate, a: number, w: number) => mk('hall', a, a + (g === 'romon' ? 7 : g === 'nio' ? 6 : 4.5), bm - w / 2, bm + w / 2)
  /**
   * 回廊：前沿 x0、后沿 x1、半宽 hw；前面正中开中门，后面接讲堂时不封（back 为 false）。返回回廊里的范围。
   */
  const kairo = (x0: number, x1: number, hw: number, back: boolean) => {
    const t = clamp(W * 0.035, 2, 3.5)
    const gw = clamp(hw * 0.28, 5, 12)
    const parts: [BuildingKind, number, number, number, number][] = [
      ['hall', x0, x0 + t, bm - hw, bm - gw / 2 - 0.5],
      ['hall', x0, x0 + t, bm + gw / 2 + 0.5, bm + hw],
      ['hall', x0 + t + 0.5, back ? x1 - t - 0.5 : x1, bm - hw, bm - hw + t],
      ['hall', x0 + t + 0.5, back ? x1 - t - 0.5 : x1, bm + hw - t, bm + hw],
    ]
    if (back) parts.push(['hall', x1 - t, x1, bm - hw, bm + hw])
    if (!group(parts)) return null
    // 中门：两层的楼门，骑在回廊上
    mk('hall', x0 - 1.5, x0 + t + 2.5, bm - gw / 2, bm + gw / 2)
    gravel(x0 + t, back ? x1 - t : x1, bm - hw + t, bm + hw - t)
    return { x0: x0 + t, x1: back ? x1 - t : x1, hw: hw - t }
  }
  const plan = C.pick('plan', PLANS)
  const gate = C.pick('gate', GATES)
  const sd = C.side('side')
  // 各伽蓝的主殿（标名字用）与主殿后沿（墓地、方丈从这里往后）
  let main: [number, number] | null = null
  let rear = a0 + D * 0.6
  /** 按一种配置盖：主殿（或回廊）先落地，落不了地返回 false，不留下别的东西 */
  const build = (plan: Plan, k: number): boolean => {
  const hw = Math.min(W * 0.4, 28) * k
  if (plan === 'kinsei') {
    const hf = a0 + D * C.num('hf', 0.26, 0.34)
    const dd = Math.min(D * 0.22, 20) * k
    if (group([['temple', hf, hf + dd, bm - hw / 2, bm + hw / 2]])) {
      main = [hf, hf + dd]
      rear = hf + dd
      gateAt(gate, a0 + 2, 10)
      mk('hall', hf + dd * 0.2, hf + dd * 0.2 + Math.min(14, dd * 0.8), bm + sd * (hw / 2 + 4), bm + sd * (hw / 2 + 4 + Math.min(16, W * 0.2)))
      mk('hall', a0 + D * 0.15, a0 + D * 0.15 + 4.5, bm - sd * (hw / 2), bm - sd * (hw / 2 - 4.5))
      if (C.chance('pagoda', 0.3)) pagoda(a0 + D * 0.16, bm - sd * (hw / 2 + 8), 8)
    }
  } else if (plan === 'zen') {
    // 佛殿先落地，再是总门、放生池、三门、法堂、方丈
    const bu = a0 + D * 0.36
    const bw = clamp(W * 0.2, 8, 20) * k
    if (!group([['temple', bu, bu + bw * 1.1, bm - bw / 2, bm + bw / 2]])) return false
    main = [bu, bu + bw * 1.1]
    mk('hall', a0 + 1, a0 + 4.5, bm - 4, bm + 4)
    const s = D / 100
    if (C.chance('pond', 0.4)) {
      const pc = at(F, a0 + 9 * s + 3, bm)
      const pond = circlePoly(pc, clamp(W * 0.12, 3, 10), 14)
      if (ok(pond)) {
        ctx.out.plazas.push(pond)
        ctx.out.enclosures.push(pond)
        ctx.occ.add(pond)
      }
    }
    const sm = a0 + D * 0.2
    group([['hall', sm, sm + 7, bm - clamp(W * 0.16, 7, 16), bm + clamp(W * 0.16, 7, 16)]])
    const ho = bu + bw * 1.1 + D * 0.07
    const hw2 = clamp(W * 0.26, 10, 26)
    mk('temple', ho, ho + hw2 * 0.75, bm - hw2 / 2, bm + hw2 / 2)
    const hj = ho + hw2 * 0.75 + D * 0.05
    mk('hall', hj, hj + Math.min(D * 0.12, 16), bm - hw2 * 0.55, bm + hw2 * 0.4)
    rear = hj + Math.min(D * 0.12, 16)
    // 庫裏与僧堂分列佛殿两侧
    mk('hall', bu - 2, bu + bw, bm + sd * (bw / 2 + 5), bm + sd * (bw / 2 + 5 + clamp(W * 0.14, 6, 14)))
    mk('hall', bu, bu + bw * 0.9, bm - sd * (bw / 2 + 5), bm - sd * (bw / 2 + 5 + clamp(W * 0.12, 5, 12)))
    // 塔头：地方宽时两旁一溜小院
    if (W > 80 && C.chance('tatchu', 0.6))
      for (const side of [-1, 1])
        for (let a = a0 + D * 0.3; a + 18 < a1 - 4; a += 22) {
          const y0 = side < 0 ? b0 + 3 : b1 - 3 - 18
          if (!ok(B(a, a + 18, y0, y0 + 18))) continue
          fence(a, a + 18, y0, y0 + 18)
          mk('hall', a + 5, a + 12, y0 + 3, y0 + 15)
        }
  } else if (plan === 'shinshu') {
    // 御影堂（大）与阿弥陀堂（小）并排，各有一门
    const hf = a0 + D * 0.28
    const g = 4
    const wBig = clamp(W * 0.42, 14, 40) * k
    const wSmall = wBig * 0.7
    const dBig = Math.min(D * 0.26, wBig * 0.8)
    const yb: [number, number] = sd > 0 ? [bm - wBig + g, bm + g] : [bm - g, bm + wBig - g]
    const ys: [number, number] = sd > 0 ? [bm + g * 2, bm + g * 2 + wSmall] : [bm - g * 2 - wSmall, bm - g * 2]
    if (group([['temple', hf, hf + dBig, yb[0], yb[1]]])) {
      main = [hf, hf + dBig]
      mk('temple', hf + dBig * 0.1, hf + dBig * 0.8, ys[0], ys[1])
      for (const [y0, y1] of [yb, ys]) mk('hall', a0 + 1.5, a0 + 6, (y0 + y1) / 2 - 5, (y0 + y1) / 2 + 5)
      gravel(a0 + 6, hf, Math.min(yb[0], ys[0]), Math.max(yb[1], ys[1]))
      rear = hf + dBig
      mk('hall', rear + 4, rear + 4 + Math.min(12, D * 0.12), bm - W * 0.3, bm)
      mk('hall', a0 + D * 0.15, a0 + D * 0.15 + 5, b1 - 8, b1 - 3)
    }
  } else {
    // 古代伽蓝：南大门、回廊（中门）、塔、金堂、讲堂
    const k0 = a0 + D * (plan === 'todaiji' ? 0.3 : 0.14)
    const k1 = a0 + D * (plan === 'horyuji' ? 0.52 : plan === 'todaiji' ? 0.66 : 0.64)
    const khw = W * (plan === 'todaiji' ? 0.23 : 0.3) * k
    const K = kairo(k0, k1, khw, plan === 'horyuji' || plan === 'todaiji')
    if (!K) return false
    {
      gateAt(gate === 'yakui' ? 'nio' : gate, a0 + 1, clamp(W * 0.18, 8, 16))
      const kd = K.x1 - K.x0
      const ps = clamp(Math.min(K.hw * 0.34, kd * 0.22), 5, 12)
      const kw = clamp(K.hw * 0.62, 7, 24)
      if (plan === 'shitennoji') {
        pagoda(K.x0 + kd * 0.3, bm, ps)
        if (group([['temple', K.x0 + kd * 0.55, K.x0 + kd * 0.85, bm - kw / 2, bm + kw / 2]])) main = [K.x0 + kd * 0.55, K.x0 + kd * 0.85]
      } else if (plan === 'horyuji') {
        // 塔与金堂左右并立：哪边是塔按位置抽签（反过来就是法起寺式）
        const ts = C.side('pagodaSide')
        pagoda(K.x0 + kd * 0.5, bm + ts * K.hw * 0.45, ps)
        const y = bm - ts * K.hw * 0.45
        if (group([['temple', K.x0 + kd * 0.3, K.x0 + kd * 0.72, y - kw * 0.42, y + kw * 0.42]])) main = [K.x0 + kd * 0.3, K.x0 + kd * 0.72]
      } else if (plan === 'yakushiji') {
        for (const s of [-1, 1]) pagoda(K.x0 + kd * 0.28, bm + s * K.hw * 0.52, ps * 0.85)
        if (group([['temple', K.x0 + kd * 0.52, K.x0 + kd * 0.85, bm - kw / 2, bm + kw / 2]])) main = [K.x0 + kd * 0.52, K.x0 + kd * 0.85]
      } else {
        // 东大寺式：回廊里一座大殿；双塔在回廊外前庭的两角，各围一圈塔院
        if (group([['temple', K.x0 + kd * 0.3, K.x0 + kd * 0.9, bm - K.hw * 0.62, bm + K.hw * 0.62]])) main = [K.x0 + kd * 0.3, K.x0 + kd * 0.9]
        for (const s of [-1, 1]) {
          const y = bm + s * W * 0.36
          const pa = a0 + D * 0.16
          const r = clamp(W * 0.09, 6, 14)
          if (ok(B(pa - r, pa + r, y - r, y + r))) fence(pa - r, pa + r, y - r, y + r)
          pagoda(pa, y, r * 0.8)
        }
      }
      // 讲堂：接在回廊背后（四天王寺、药师寺式）或回廊后面单独一座（法隆寺、东大寺式）
      const closed = plan === 'horyuji' || plan === 'todaiji'
      const ko = closed ? k1 + D * 0.05 : k1 - 0.2
      const kw2 = clamp(W * 0.3, 10, 30)
      mk('temple', ko, ko + Math.min(D * 0.1, kw2 * 0.45), bm - kw2 / 2, bm + kw2 / 2)
      rear = ko + Math.min(D * 0.1, kw2 * 0.45)
      // 钟楼、经藏：讲堂前左右（回廊外）或回廊外两角
      if (C.chance('shoro', 0.7)) for (const s of [-1, 1]) mk('hall', k1 - D * 0.04, k1 + 1, bm + s * (khw + 4), bm + s * (khw + 9))
      // 僧房：讲堂后面一两排
      for (let a = rear + 5; a + 6 < a1 - 3 && a < rear + 30; a += 13) mk('hall', a, a + 6, bm - W * 0.32, bm + W * 0.32)
      if (main === null) main = [k0, k1]
    }
  }
  return main !== null
  }
  // 抽到的配置放不下：先缩小，再退回近世寺院，再不行逐级缩小
  let used = plan
  let built = false
  for (const [pl, k] of [[plan, 1], [plan, 0.8], ['kinsei', 1], ['kinsei', 0.75], ['kinsei', 0.55]] as [Plan, number][]) {
    if (built) break
    used = pl
    built = build(pl, k)
  }
  if (used !== plan) C.note('built', built ? used : 'none')
  if (!main) {
    scatterTrees(ctx, precinct, 0.004, 2.5, 5)
    C.note('main', 'n')
    C.done(c)
    return
  }
  ctx.out.enclosures.push(precinct)
  ctx.out.landmarks.push({ p: at(F, (main[0] + main[1]) / 2, bm), name: ctx.namer.wa('temple'), kind: 'temple' })
  // 本堂后面：墓地、树林或方丈庭园
  const back = C.pick('back', BACK, { only: (k) => k !== 'bochi' || used === 'kinsei' || used === 'shinshu' || used === 'zen' })
  const g0 = rear + 6
  if (a1 - 2 - g0 > 10) {
    const yard = clipConvex(box(F, g0, a1 - 2, b0 + 3, b1 - 3), precinct)
    if (yard.length >= 3 && area(yard) > 120) {
      if (back === 'bochi') {
        ctx.out.greens.push({ poly: yard, kind: 'cemetery' })
        for (let a = g0 + 2; a < a1 - 4; a += 3.2)
          for (let b = b0 + 5; b < b1 - 5; b += 2.6) {
            if (rng.next() < 0.3) continue
            const g = box(F, a, a + 1.1, b, b + 1.6)
            if (inside(g, yard)) addBuilding(ctx, g, 'shed')
          }
      } else if (back === 'niwa') {
        // 方丈庭园：白砂与几块石、几棵树
        ctx.out.greens.push({ poly: yard, kind: 'garden' })
        scatterTrees(ctx, yard, 0.008, 2, 3.5)
      } else scatterTrees(ctx, yard, 0.012, 2.5, 4.5)
    }
  }
  // 寺域四周的树
  for (const q of courts) ctx.occ.add(q)
  const ring = insetConvex(precinct, 1.5)
  if (ring.length >= 3) scatterTrees(ctx, ring, 0.0035, 2.5, 4.5)
  C.done(c)
}
