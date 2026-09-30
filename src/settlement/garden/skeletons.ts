import { clamp } from '../../gen/util'
import { add, at, box, frameAt, neg, segDist, sub, unit, type P, type RectFrame } from '../geom'
import { inside } from '../wards'
import { choose, fill, note, type El, type Spot } from './elements'
import { emitArea } from '../ctx'
import {
  area, centroid, clipHalf, dist, farCorner, gates, isle, loop, northward, offWater, pointInPoly, reach, rectIn,
  spur, wall, walk, type Garden, type Skel,
} from './kit'
import * as dmath from '../../gen/dmath'

/**
 * 骨架：园子的构图法。每种骨架只管"哪里有什么槽位"（轴端、园心、池岸、园角、参道两旁……），
 * 槽位上放什么由元素池按园址抽签（elements.ts）。
 * - axial 规则对称：主轴（可加横轴、平行的副轴），轴端是对景，交点是园心，花坛格四块或多块镜像对称
 * - natural 自然山水：一方曲池（位置按文明的规矩），岛与渡，绕池的园路上步移景异，池北主厅，园角假山
 * - procession 序列：园门 → 参道（门、两旁成对的小品）→ 前庭 → 尽头的殿
 * - field 成片：满园一种地被或林（梅、竹、松、果、白砂），当中几个节点与小路
 */

const slot = (t: Spot['t'], p: P, d: P, s: number, more: Partial<Spot> = {}): Spot => ({ t, p, d, s, ...more })

// —————————————————————— 规则对称 ——————————————————————

function axial(K: Garden): boolean {
  const ctx = K.ctx
  const V = K.C.nth
  const lay = choose(K, slot('layout', K.o, K.f, Math.min(K.hx, K.hy)))
  if (!lay) return false
  // 临水的单轴园：主轴朝水，主轴端（凉亭、观景亭）在临水一端
  const c = centroid(K.g)
  const wet = lay.id === 'single' && ctx.T.waterAt(c) < 90
  const toWater = wet ? unit(neg(ctx.T.waterGrad(c))) : K.f
  const R = rectIn(K, 1.5, lay.id === 'single' ? 16 : 18, toWater)
  if (!R || R.hx < 12) return false
  note(K, 'layout', lay.id)
  if (K.wall) wall(K, box(R, -R.hx, R.hx, -R.hy, R.hy))
  // 园边（林荫道、柏树圈、绿篱）
  const edge = fill(K, slot('edge', R.o, R.f, Math.min(R.hx, R.hy), { F: R, room: Math.min(R.hx, R.hy) * 0.3 }))
  const m = Math.max(1.5, edge?.depth ?? 0)
  const Pf: RectFrame = { ...R, hx: R.hx - m, hy: R.hy - m }
  // 轴端：主端（临水时在水那头）与另一端（同样的对景，或另选一样）
  const e = wet ? (R.f[0] * toWater[0] + R.f[1] * toWater[1] >= 0 ? 1 : -1) : V.side('axial.end')
  const endAt = (sg: number) => slot('axisEnd', at(Pf, sg * Pf.hx, 0), sg > 0 ? Pf.f : neg(Pf.f), Pf.hy, { room: Pf.hx * 0.3 })
  const endA = choose(K, endAt(e))
  const endB = V.chance('axial.sameEnds', 0.45) ? endA : choose(K, endAt(-e))
  const dep = (el: El | null) => el?.depth ?? 0
  const dPlus = e > 0 ? dep(endA) : dep(endB)
  const dMinus = e > 0 ? dep(endB) : dep(endA)
  const x0 = -Pf.hx + dMinus
  const x1 = Pf.hx - dPlus
  const P0: RectFrame = { ...Pf, o: at(Pf, (x0 + x1) / 2, 0), hx: (x1 - x0) / 2 }
  if (P0.hx < 8 || P0.hy < 6) return false
  for (const [sg, el] of [[e, endA], [-e, endB]] as const) {
    if (!el) continue
    const s = slot('axisEnd', at(P0, sg * P0.hx, 0), sg > 0 ? P0.f : neg(P0.f), P0.hy, { room: el.depth ?? 0 })
    if (el.build(K, s)) note(K, 'axisEnd', el.id)
    else fill(K, s, [el.id])
  }
  // 花坛格的做法先定（决定底下铺不铺砂地）
  const cell0 = Math.min(P0.hx, P0.hy) / 2
  const comp = choose(K, slot('compartment', P0.o, P0.f, cell0))
  if (comp?.pave) {
    emitArea(ctx, 'plazas', box(P0, -P0.hx, P0.hx, -P0.hy, P0.hy))
    K.bare.push(box(P0, -P0.hx, P0.hx, -P0.hy, P0.hy))
  }
  // 园心
  let r = 0
  if (lay.id !== 'single' || V.chance('axial.compartments', 0.4)) {
    const cs = slot('centre', P0.o, P0.f, Math.min(P0.hx, P0.hy) * 0.35, { F: P0 })
    if (fill(K, cs)) r = cs.r ?? 0
  }
  // 轴线：主轴（与横轴）从园心的圆场通到轴端
  const ax = choose(K, slot('axis', P0.o, P0.f, P0.hy))
  const hw = clamp(Math.min(P0.hx, P0.hy) * 0.09, 1.4, 3.2) * (ax?.wide ?? 1)
  const seg = (u: P, v: P, len: number, sg: number, y = 0): RectFrame => ({ o: add(at(P0, 0, y), u, (sg * (r + len)) / 2), f: u, l: v, hx: (len - r) / 2, hy: hw })
  const axes: [P, P, number][] = [[P0.f, P0.l, P0.hx]]
  if (lay.id === 'cross') axes.push([P0.l, neg(P0.f), P0.hy])
  if (ax) {
    for (const [u, v, len] of axes) for (const sg of [-1, 1]) if (len - r > 1) ax.build(K, slot('axis', P0.o, u, hw, { F: seg(u, v, len, sg) }))
    note(K, 'axis', ax.id)
  }
  // 平行的两条副轴（林荫散步道）
  const ys = P0.hy * 0.55
  if (lay.id === 'parallel')
    for (const y of [-ys, ys]) {
      const q = box(P0, -P0.hx, P0.hx, y - 1.2, y + 1.2)
      emitArea(ctx, 'plazas', q)
      K.bare.push(q)
    }
  // 横轴两端：一对小品（雕像、小池）
  if (lay.id === 'cross') {
    const ce = choose(K, slot('axisEnd', at(P0, 0, P0.hy), P0.l, P0.hx, { room: 2.5 }))
    if (ce) {
      for (const sg of [-1, 1]) ce.build(K, slot('axisEnd', at(P0, 0, sg * (P0.hy - 2.5)), sg > 0 ? P0.l : neg(P0.l), P0.hx, { room: 2.5 }))
      note(K, 'crossEnd', ce.id)
    }
  }
  // 花坛格：镜像对称，同一种做法
  if (comp) {
    const e2 = 1.2
    const gap = 1.8
    const v0 = hw + 1.4
    const split = (a: number, b: number, n: number): [number, number][] => {
      const w = (b - a - gap * (n - 1)) / n
      return Array.from({ length: n }, (_, i) => [a + i * (w + gap), a + i * (w + gap) + w] as [number, number])
    }
    const nx = P0.hx > 50 ? 3 : P0.hx > 24 ? 2 : 1
    const ny = P0.hy > 24 ? 2 : 1
    let xsI: [number, number][]
    if (lay.id === 'cross') xsI = [...split(v0, P0.hx - e2, nx), ...split(v0, P0.hx - e2, nx).map(([a, b]) => [-b, -a] as [number, number])]
    else xsI = split(-P0.hx + e2, P0.hx - e2, nx * 2)
    let ysI = lay.id === 'parallel' ? [[v0, ys - 2.4] as [number, number], [ys + 2.4, P0.hy - e2] as [number, number]] : split(v0, P0.hy - e2, ny)
    ysI = [...ysI, ...ysI.map(([a, b]) => [-b, -a] as [number, number])]
    const cut = r + hw + 2.5
    let made = 0
    for (const [a0, a1] of xsI)
      for (const [b0, b1] of ysI) {
        if (a1 - a0 < 3 || b1 - b0 < 3) continue
        const F: RectFrame = { o: at(P0, (a0 + a1) / 2, (b0 + b1) / 2), f: P0.f, l: P0.l, hx: (a1 - a0) / 2, hy: (b1 - b0) / 2 }
        let q = box(P0, a0, a1, b0, b1)
        // 靠园心的格子切掉一角，让出园心的圆场
        if (r > 0 && q.some((p) => dist(p, P0.o) < cut)) {
          const d = unit(sub(F.o, P0.o))
          q = clipHalf(q, add(P0.o, d, cut * 1.15), neg(d))
          if (q.length < 3 || area(q) < 8) continue
        }
        if (comp.build(K, slot('compartment', F.o, P0.f, Math.min(F.hx, F.hy), { F, q, r }))) made++
      }
    if (made) note(K, 'compartment', comp.id)
  }
  // 沿主轴两侧（行道树、柏树、雕像）
  const al = choose(K, slot('along', P0.o, P0.f, hw))
  if (al) {
    for (const sg of [-1, 1]) al.build(K, slot('along', P0.o, P0.f, hw, { line: [at(P0, sg * (r + 2.5), 0), at(P0, sg * (P0.hx - 1), 0)] }))
    note(K, 'along', al.id)
  }
  // 规则区之外的边角
  K.bare.push(box(R, -R.hx, R.hx, -R.hy, R.hy))
  fill(K, slot('lawn', K.o, K.f, Math.min(K.hx, K.hy)))
  K.seat ??= P0.o
  return true
}

// —————————————————————— 自然山水 ——————————————————————

function natural(K: Garden): boolean {
  const V = K.C.nth
  const m = Math.min(K.hx, K.hy)
  if (m < 12) return false
  const n = northward(K)
  // 池的位置：东方偏南（北岸留给坐北朝南的主厅），和风大致居中，西式随园偏向一边
  const off =
    K.cult === 'eastern'
      ? add(K.o, n, -m * V.num('natural.lakeSouth', 0.06, 0.16))
      : K.cult === 'wa'
        ? at(K, V.num('natural.lakeX', -0.12, 0.12) * K.hx, V.num('natural.lakeY', -0.1, 0.1) * K.hy)
        : at(K, V.num('natural.lakeX', -0.22, 0.22) * K.hx, V.num('natural.lakeY', -0.18, 0.18) * K.hy)
  if (!fill(K, slot('water', off, K.f, m))) return false
  if (K.wall) wall(K)
  const lake = K.lake
  // 离宫的湖心岛要有，且放得下水殿
  const palace = !!K.C.bias('island', 'islePalace')
  const lc = lake ? centroid(lake) : K.o
  const lr = lake ? Math.sqrt(area(lake) / Math.PI) : 0
  if (lake) {
    // 岛：大池一两座（和风的鹤岛、龟岛），小池没有
    const nIs = lr > 16 && K.cult === 'wa' ? 2 : lr > 10 && (V.chance('natural.isle', K.cult === 'western' ? 0.6 : 0.8) || palace) ? 1 : 0
    const used: string[] = []
    for (let i = 0; i < nIs; i++) {
      const a = V.h('natural.isleA') * 6.28
      const c = add(lc, [dmath.cos(a), dmath.sin(a)], lr * V.num('natural.isleD', 0.1, 0.4))
      // 离宫的湖心岛要放得下水殿：第一座岛大一些
      const rr = lr * (i ? 0.14 : V.num('natural.isleR', 0.16, 0.24) * (palace ? 1.5 : 1))
      const q = isle(K, lake, c, rr, a)
      if (!q) continue
      const e = fill(K, slot('island', c, K.f, rr, { q }), used)
      if (e) used.push(e.id)
    }
    // 池北的主厅（面朝池）
    const back = reach(lake, lc, n)
    const span = reach(K.g, lc, [-n[1], n[0]]) + reach(K.g, lc, [n[1], -n[0]])
    if (Number.isFinite(back)) fill(K, slot('hall', add(lc, n, back + 9), neg(n), span))
    // 渡水
    fill(K, slot('crossing', lc, K.f, lr, { q: lake }))
  }
  // 绕池的园路与园门进来的支路
  const w = K.cult === 'western' ? 2.2 : 1.5
  const path = loop(K, Math.max(4, m * V.num('natural.loop', 0.1, 0.16)), K.cult === 'western' ? 5 : 3, w)
  if (path) for (const gt of gates(K).slice(0, K.cult === 'western' ? 3 : 1)) spur(K, gt.p, path, w * 0.9)
  // 景点：沿池一圈，池岸与园路相间（步移景异：相邻的两处不重样）
  const scenes = lake ? clamp(Math.round((lr * 6.28) / 26), 2, 7) : clamp(Math.round(Math.sqrt(K.A) / 25), 2, 5)
  const ph = V.h('natural.scenes') * 6.28
  let prev = ''
  for (let i = 0; i < scenes; i++) {
    const a = ph + (i / scenes) * 6.28 + V.num('natural.scene', -0.25, 0.25)
    const dir: P = [dmath.cos(a), dmath.sin(a)]
    let s: Spot | null = null
    if (lake && (i % 2 === 0 || !path)) s = slot('shore', add(lc, dir, reach(lake, lc, dir)), dir, lr)
    else if (path) {
      const target = lake ? add(lc, dir, reach(lake, lc, dir) + 10) : add(K.o, dir, m * 0.6)
      let best = path[0]
      for (const p of path) if (dist(p, target) < dist(best, target)) best = p
      s = slot('node', best, unit(sub(best, lc)), m)
    }
    if (!s) continue
    const e = fill(K, s, prev ? [prev] : [])
    prev = e?.id ?? ''
  }
  // 园角（离池最远）：假山、书斋、塔、筑山
  const cp = farCorner(K, lc, 10)
  fill(K, slot('corner', cp, unit(sub(lc, cp)), m))
  if (lake) fill(K, slot('shoreline', lc, K.f, lr, { q: lake }))
  fill(K, slot('edge', K.o, K.f, m))
  fill(K, slot('lawn', K.o, K.f, m))
  return true
}

// —————————————————————— 序列 ——————————————————————

function procession(K: Garden): boolean {
  if (Math.min(K.hx, K.hy) < 12) return false
  const gt = gates(K)[0]
  if (!gt) return false
  const L = reach(K.g, gt.p, gt.d)
  if (!Number.isFinite(L) || L < 34) return false
  const F = frameAt(gt.p, gt.d)
  const pd = clamp(L * K.C.nth.num('procession.depth', 0.32, 0.42), 16, 36)
  const p0 = L - pd - 2
  const hw = K.cult === 'western' ? 2 : 1.6
  // 前庭：宽度收到放得进园地为止
  let pw = clamp(Math.min(K.hx, K.hy) * 0.7, 12, 28)
  while (pw > 9 && !inside(box(F, p0, L - 2, -pw / 2, pw / 2), K.inner)) pw *= 0.85
  if (pw <= 9) return false
  const TF: RectFrame = { o: at(F, p0, 0), f: F.f, l: F.l, hx: pd, hy: pw / 2 }
  if (!fill(K, slot('terminal', TF.o, F.f, pw / 2, { F: TF }))) return false
  walk(K, [F.o, at(F, p0 + 1, 0)], hw * 2)
  // 参道口的门、参道中途（前庭前）的门：同一样
  const side = Math.min(pw / 2, 8)
  fill(K, slot('entry', at(F, 3, 0), F.f, side))
  const mk = choose(K, slot('marker', at(F, p0 - 3, 0), F.f, side))
  if (mk) {
    const xs = p0 > 70 ? [p0 / 2, p0 - 3] : [p0 - 3]
    let made = 0
    for (const x of xs) if (mk.build(K, slot('marker', at(F, x, 0), F.f, side))) made++
    if (made) note(K, 'marker', mk.id)
  }
  fill(K, slot('flank', F.o, F.f, hw, { line: [at(F, 0, 0), at(F, p0 - 5, 0)] }))
  // 背景：社叢、林带或草地
  fill(K, slot('edge', K.o, K.f, Math.min(K.hx, K.hy)))
  fill(K, slot('lawn', K.o, K.f, Math.min(K.hx, K.hy)))
  return true
}

// —————————————————————— 成片 ——————————————————————

function field(K: Garden): boolean {
  const m = Math.min(K.hx, K.hy)
  if (m < 8) return false
  const fs = slot('field', K.o, K.f, m)
  const f = choose(K, fs)
  if (!f) return false
  if (f.solo) {
    if (!f.build(K, fs)) return false
    note(K, 'field', f.id)
    return true
  }
  if (K.wall) wall(K)
  fill(K, slot('pond', K.o, K.f, m))
  const hub = slot('hub', offWater(K, at(K, K.C.nth.num('field.hubX', -0.15, 0.15) * K.hx, K.C.nth.num('field.hubY', -0.15, 0.15) * K.hy), 6), K.f, m * 0.35)
  // 园路先让开节点，再从园门通进来
  fill(K, hub)
  fill(K, slot('paths', hub.p, K.f, m, { r: hub.r }))
  fill(K, slot('edge', K.o, K.f, m))
  f.build(K, fs)
  note(K, 'field', f.id)
  return true
}

export const SKELETONS: Record<Skel, (K: Garden) => boolean> = { axial, natural, procession, field }

/** 草坪公园（什么都放不下时）：几条从园边通向当中的小路，当中一口井或一座亭，散植的树 */
export function lawnPark(K: Garden): boolean {
  const c = centroid(K.g)
  if (!pointInPoly(c, K.inner)) return false
  const hub = slot('hub', c, K.f, Math.min(K.hx, K.hy) * 0.3)
  fill(K, hub)
  for (const gt of gates(K).slice(0, 3)) if (!K.walks.some((w) => segDist(gt.p, w.a, w.b).d < 2)) walk(K, [gt.p, add(c, unit(sub(gt.p, c)), hub.r ?? 0)], 1.8, true)
  fill(K, slot('lawn', c, K.f, Math.min(K.hx, K.hy)))
  return true
}
