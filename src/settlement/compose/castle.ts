import { emitArea, isFree, siteDice, type Ctx } from '../ctx'
import { area, centroid, circlePoly, clipHalf, dist, inscribedRect, insetConvex, obb, pointInPoly, rect, type P, type Poly } from '../geom'
import type { BuildingKind, Wall } from '../types'
import { addWall, connectGates } from '../walls'
import { addBuilding, fit, inside, place, scatterTrees } from '../wards'
import { composer, type Elem, type Preset } from './core'
import { nearestRoad } from '../roads'

/**
 * 西式城堡的语法：幕墙（顺着地块 / 规整的方院 / 内外两圈的同心城）+ 塔（圆塔 / 方塔，疏密）
 * + 院（一重 / 内外两重）+ 主楼（位置：院心 / 靠后 / 骑在幕墙上 / 没有；样子：方、圆、带前楼、环形的贝壳主楼）
 * + 门楼（门洞 / 双塔门楼 / 深的门楼）+ 沿墙的殿、大厅、礼拜堂。
 * 规矩：同心城、两重院要够大；没有主楼时沿墙的殿围满一圈（方院城堡）；门都是墙圈上的顶点（connectGates 接路）。
 */

type Enceinte = 'follow' | 'regular' | 'concentric'
type Towers = 'round' | 'square' | 'corners'
type Baileys = 'single' | 'double'
type KeepAt = 'centre' | 'rear' | 'wall' | 'none'
type KeepForm = 'square' | 'round' | 'forebuilding' | 'shell'
type Gatehouse = 'simple' | 'twin' | 'long'

const ENCEINTE: Elem<Enceinte>[] = [
  { id: 'follow', w: 3 },
  { id: 'regular', w: 2 },
  { id: 'concentric', w: 1, min: 70 },
]
const TOWERS: Elem<Towers>[] = [
  { id: 'round', w: 3 },
  { id: 'square', w: 1.5 },
  { id: 'corners', w: 1 },
]
const BAILEYS: Elem<Baileys>[] = [
  { id: 'single', w: 3 },
  { id: 'double', w: 1.5, min: 60 },
]
const KEEP_AT: Elem<KeepAt>[] = [
  { id: 'centre', w: 3 },
  { id: 'rear', w: 2 },
  { id: 'wall', w: 1.2 },
  { id: 'none', w: 1 },
]
const KEEP_FORM: Elem<KeepForm>[] = [
  { id: 'square', w: 3 },
  { id: 'round', w: 1.5 },
  { id: 'forebuilding', w: 1.2 },
  { id: 'shell', w: 0.8, min: 50 },
]
const GATEHOUSE: Elem<Gatehouse>[] = [
  { id: 'simple', w: 2 },
  { id: 'twin', w: 2 },
  { id: 'long', w: 1, min: 50 },
]

/** 以前的"方主楼 / 圆主楼"两种，现在是预设：诺曼、爱德华式同心城、法式圆塔主楼、土丘贝壳主楼、方院城堡 */
const PRESETS: Preset[] = [
  // 大城（grand，几块片区合成）：同心的内外两圈城墙、深门楼、圆塔（博马里斯、卡尔卡松的内城）
  { id: 'greatConcentric', w: 40, tiers: ['grand'], bias: { enceinte: { concentric: 30, follow: 0.2, regular: 0.5 }, towers: { round: 4 }, gatehouse: { long: 6, twin: 2 }, keepAt: { none: 2, centre: 1 } } },
  { id: 'norman', w: 3, bias: { keepForm: { square: 4, forebuilding: 4 }, keepAt: { centre: 3 }, towers: { square: 3 }, baileys: { double: 3 } } },
  { id: 'edwardian', w: 1.5, bias: { enceinte: { concentric: 6, regular: 2 }, keepAt: { none: 6 }, towers: { round: 4 }, gatehouse: { long: 6 } } },
  { id: 'french', w: 1.5, bias: { keepForm: { round: 8 }, keepAt: { wall: 4, rear: 2 }, towers: { round: 4 }, gatehouse: { twin: 4 } } },
  { id: 'motte', w: 1, bias: { keepForm: { shell: 8 }, keepAt: { rear: 3, centre: 2 }, towers: { corners: 3, square: 2 }, gatehouse: { simple: 4 } } },
  { id: 'quadrangle', w: 1.2, bias: { enceinte: { regular: 8 }, keepAt: { none: 8 }, towers: { round: 3 }, gatehouse: { twin: 3 }, ranges: { yes: 6 } } },
]

/** 门开在离街最近的那面墙上（一样近时朝城心） */
function gateEdge(ctx: Ctx, loop: Poly, c: P, minLen: number) {
  const toCenter: P = [ctx.center[0] - c[0], ctx.center[1] - c[1]]
  let gi = 0
  let gd = -Infinity
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const e = loop[(i + 1) % loop.length]
    const mid: P = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2]
    const m: P = [mid[0] - c[0], mid[1] - c[1]]
    const s = ((m[0] * toCenter[0] + m[1] * toCenter[1]) / (Math.hypot(...m) || 1)) * 8 - Math.min(80, nearestRoad(ctx, mid, 80)?.gap ?? Infinity)
    if (s > gd && dist(a, e) > minLen) {
      gd = s
      gi = i
    }
  }
  return gi
}

/** 一圈幕墙：门在第 gi 条边上（插成墙圈的顶点）；塔在顶点上，spacing > 0 时长墙上每隔这么远再加一座 */
function curtainWall(poly: Poly, gi: number, spacing: number, thickness: number, solid?: (i: number) => boolean) {
  const ga = poly[gi]
  const gb = poly[(gi + 1) % poly.length]
  const gp: P = [(ga[0] + gb[0]) / 2, (ga[1] + gb[1]) / 2]
  const loop = [...poly.slice(0, gi + 1), gp, ...poly.slice(gi + 1)]
  const towers: P[] = []
  poly.forEach((a, i) => {
    if (solid && !solid(i)) return
    const b = poly[(i + 1) % poly.length]
    towers.push(a)
    const k = spacing > 0 ? Math.floor(dist(a, b) / spacing) : 0
    for (let j = 1; j <= k; j++) {
      const t: P = [a[0] + ((b[0] - a[0]) * j) / (k + 1), a[1] + ((b[1] - a[1]) * j) / (k + 1)]
      if (i !== gi || dist(t, gp) > 10) towers.push(t)
    }
  })
  const solids = loop.map((_, k) => {
    if (!solid) return true
    // 插了门的那条边拆成两段，两段都跟着原来那条边
    const i = k <= gi ? k : k - 1
    return solid(i)
  })
  const wall: Wall = { loop, solid: solids, towers, gates: [{ p: gp, angle: Math.atan2(gb[1] - ga[1], gb[0] - ga[0]) + Math.PI / 2 }], kind: 'stone', thickness }
  // 朝里的法向
  const c = centroid(poly)
  let n: P = [-(gb[1] - ga[1]), gb[0] - ga[0]]
  const L = Math.hypot(n[0], n[1]) || 1
  n = [n[0] / L, n[1] / L]
  if ((c[0] - gp[0]) * n[0] + (c[1] - gp[1]) * n[1] < 0) n = [-n[0], -n[1]]
  wall.gates[0].angle = Math.atan2(-n[1], -n[0])
  return { wall, gp, n, u: [(gb[0] - ga[0]) / (dist(ga, gb) || 1), (gb[1] - ga[1]) / (dist(ga, gb) || 1)] as P }
}

/**
 * 西式城堡（城堡片区，都城盖不下王宫时也是它）：curtain 是已经让开路、河、城墙的幕墙轮廓。
 * 骨架与各部件按城堡的位置抽签（siteDice）。
 */
/** connect：城门接上路（山上的城堡不接，上山的小路另修） */
export function westCastle(ctx: Ctx, curtain0: Poly, o: { connect?: boolean } = {}) {
  const w0 = ctx.out.walls.length
  const rng = ctx.rng
  const c0 = centroid(curtain0)
  const M = Math.sqrt(area(curtain0))
  const C = composer(siteDice(ctx, c0, 'castle'), 'castle', PRESETS, { size: M, rank: ctx.p.capital ? 2 : ctx.p.size === 'city' || ctx.tier === 'grand' ? 1 : 0, tier: ctx.tier })
  let enceinte = C.pick('enceinte', ENCEINTE)
  // 规整的方院：幕墙里最大的矩形（顺着原来开门那面墙），太小就退回顺着地块
  let curtain = curtain0
  if (enceinte === 'regular') {
    const gi0 = gateEdge(ctx, curtain0, c0, 14)
    const a = curtain0[gi0]
    const b = curtain0[(gi0 + 1) % curtain0.length]
    const r = inscribedRect(curtain0, [b[0] - a[0], b[1] - a[1]], { minSide: 24 })
    if (r && area(r) > area(curtain0) * 0.55) {
      curtain = r
      // 方院外面余下的是一圈草坡（glacis）
      emitArea(ctx, 'greens', curtain0, 'park')
    } else enceinte = 'follow'
  }
  // 同心城要够大；合成的大城（grand）内外两圈靠得近一些也要做成同心
  const grand = ctx.tier === 'grand'
  if (enceinte === 'concentric' && area(insetConvex(curtain0, grand ? 12 : 16)) < (grand ? 700 : 1400)) enceinte = 'follow'
  C.note('built', enceinte)
  const c = centroid(curtain)
  emitArea(ctx, 'plazas', curtain)
  const towers = C.pick('towers', TOWERS)
  const spacing = towers === 'corners' ? 0 : C.pick('spacing', [{ id: '24', w: 2 }, { id: '34', w: 2 }, { id: '0', w: 1 }] as Elem<'24' | '34' | '0'>[])
  const sp = Number(spacing)
  /** 按塔的样子立墙：圆塔画在墙上，方塔是骑墙的方楼 */
  const raise = (poly: Poly, gi: number, th: number, solid?: (i: number) => boolean) => {
    const w = curtainWall(poly, gi, sp, th, solid)
    if (towers === 'square') {
      for (const t of w.wall.towers) place(ctx, rect(t, w.u, th * 2.6, th * 2.6), 'tower', { tags: ['road', 'river'] })
      w.wall.towers = []
    }
    addWall(ctx, w.wall, 'keep')
    return w
  }
  const gi = gateEdge(ctx, curtain, c, 14)
  const outer = raise(curtain, gi, 3.2)
  // 门楼
  const gate = C.pick('gatehouse', GATEHOUSE)
  const gateHouse = (g: { gp: P; n: P; u: P }, deep: number) => {
    if (gate === 'simple') return
    const s = gate === 'long' ? deep : 6
    for (const sd of [-1, 1]) {
      const o: P = [g.gp[0] + g.u[0] * sd * 6.5 + g.n[0] * (s / 2 - 1), g.gp[1] + g.u[1] * sd * 6.5 + g.n[1] * (s / 2 - 1)]
      place(ctx, gate === 'long' ? rect(o, g.n, s, 5) : circlePoly(o, 3.4, 12), 'tower', { tags: ['road', 'river'] })
    }
  }
  gateHouse(outer, 14)
  // 院：同心城的内圈、两重院的内院（从门往里切开），主楼与殿都在"主院"里
  let ward = insetConvex(curtain, 4)
  if (enceinte === 'concentric') {
    const d = grand ? C.num('ring', 11, 14) : C.num('ring', 13, 18)
    const inner = insetConvex(curtain, d)
    // 内圈的门对着外圈的门
    let ii = 0
    let bd = Infinity
    for (let i = 0; i < inner.length; i++) {
      const m: P = [(inner[i][0] + inner[(i + 1) % inner.length][0]) / 2, (inner[i][1] + inner[(i + 1) % inner.length][1]) / 2]
      if (dist(m, outer.gp) < bd) {
        bd = dist(m, outer.gp)
        ii = i
      }
    }
    const w = raise(inner, ii, 3.6)
    gateHouse(w, 12)
    ward = insetConvex(inner, 3.5)
  } else if (M >= 60 && C.pick('baileys', BAILEYS) === 'double') {
    // 两重院：沿门的法向往里 t 处切一道横墙，里面是内院（墙圈只画横墙那一段）
    const t = C.num('cut', 0.42, 0.58)
    const ext = extentAlong(curtain, outer.gp, outer.n)
    const o: P = [outer.gp[0] + outer.n[0] * ext * t, outer.gp[1] + outer.n[1] * ext * t]
    const inner = clipHalf(curtain, o, [-outer.n[0], -outer.n[1]])
    if (inner.length >= 3 && area(inner) > 900) {
      // 横墙那条边：两端都在切线上
      const onCut = (i: number) => {
        const a = inner[i]
        const b = inner[(i + 1) % inner.length]
        const s = (q: P) => Math.abs((q[0] - o[0]) * outer.n[0] + (q[1] - o[1]) * outer.n[1])
        return s(a) < 0.5 && s(b) < 0.5
      }
      let ci = inner.findIndex((_, i) => onCut(i))
      if (ci < 0) ci = 0
      const w = raise(inner, ci, 3, onCut)
      gateHouse(w, 10)
      ward = insetConvex(inner, 3)
      C.note('inner', 'y')
    }
  }
  if (ward.length < 3) return
  const wc = centroid(ward)
  const b = obb(ward)
  // 主楼
  const keepAt = C.pick('keepAt', KEEP_AT)
  const form = keepAt === 'none' ? 'square' : C.pick('keepForm', KEEP_FORM, { size: Math.sqrt(area(ward)) })
  const ks = Math.min(24, Math.sqrt(area(ward)) * 0.32)
  const kr = C.num('keepRatio', 0.8, 1.1)
  const shape = (q: P, s: number): [Poly, BuildingKind][] => {
    if (form === 'round') return [[circlePoly(q, ks * 0.5 * s, 18), 'keep']]
    const main = rect(q, b.axis, ks * s, ks * kr * s)
    if (form === 'forebuilding') {
      // 前楼：主楼朝院门一侧贴一座窄楼（上主楼的台阶在里面）
      const f: P = [q[0] + outer.n[0] * -(ks * kr * 0.5 + ks * 0.18) * s, q[1] + outer.n[1] * -(ks * kr * 0.5 + ks * 0.18) * s]
      return [[main, 'keep'], [rect(f, b.axis, ks * 0.45 * s, ks * 0.36 * s), 'keep']]
    }
    return [[main, 'keep']]
  }
  const away: P = [wc[0] + outer.n[0] * b.wid * 0.18, wc[1] + outer.n[1] * b.wid * 0.18]
  const okKeep = (parts: [Poly, BuildingKind][]) => parts.every(([p]) => inside(p, ward) && isFree(ctx, p, { pad: 1 }))
  let keepPoly: Poly | null = null
  if (keepAt !== 'none' && form === 'shell') {
    // 贝壳主楼：一圈环形的矮墙（门朝院门）围着几座屋
    const r = Math.min(16, Math.sqrt(area(ward)) * 0.22)
    const q = keepAt === 'rear' ? away : wc
    const ring = circlePoly(q, r, 14)
    if (ring.every((v) => pointInPoly(v, ward)) && !ctx.occ.overlaps(ring)) {
      let gi2 = 0
      let bd = -Infinity
      ring.forEach((v, i) => {
        const s = -((v[0] - q[0]) * outer.n[0] + (v[1] - q[1]) * outer.n[1])
        if (s > bd) {
          bd = s
          gi2 = i
        }
      })
      const w = curtainWall(ring, gi2, 0, 2.6)
      w.wall.towers = []
      addWall(ctx, w.wall, 'keep')
      for (const k of [0.35, -0.35]) {
        const h: P = [q[0] + outer.n[0] * r * 0.35 + w.u[0] * r * k, q[1] + outer.n[1] * r * 0.35 + w.u[1] * r * k]
        addBuilding(ctx, rect(h, w.u, r * 0.55, r * 0.4), 'hall', 0.5)
      }
      ctx.occ.add(ring)
      keepPoly = ring
    }
  } else if (keepAt === 'wall') {
    // 骑在幕墙上的圆塔主楼（离门最远那面墙的正中）
    let best: P | null = null
    let bd = -Infinity
    for (let i = 0; i < curtain.length; i++) {
      const m: P = [(curtain[i][0] + curtain[(i + 1) % curtain.length][0]) / 2, (curtain[i][1] + curtain[(i + 1) % curtain.length][1]) / 2]
      const s = (m[0] - outer.gp[0]) * outer.n[0] + (m[1] - outer.gp[1]) * outer.n[1]
      if (s > bd) {
        bd = s
        best = m
      }
    }
    for (const s of [1, 0.8, 0.65]) {
      const parts = shape(best!, s)
      if (parts.every(([p]) => isFree(ctx, p, { pad: 0.5 })) && parts.every(([p]) => place(ctx, p, 'keep'))) {
        keepPoly = parts[0][0]
        break
      }
    }
  } else if (keepAt !== 'none') {
    const at0 = keepAt === 'rear' ? away : wc
    const got = fit(ward, (q, s) => shape(keepAt === 'rear' ? [(q[0] + at0[0]) / 2, (q[1] + at0[1]) / 2] : q, s), okKeep, [1, 0.85, 0.7])
    if (got) for (const [p, k] of got) if (addBuilding(ctx, p, k, 1) && !keepPoly) keepPoly = p
  }
  C.note('keepBuilt', !!keepPoly)
  // 沿墙的殿：没有主楼时围满一圈（方院城堡），离门最远的一面是大厅
  const full = keepAt === 'none' || C.chance('ranges', 0.3)
  const inner = insetConvex(ward, 0.5)
  let far = -1
  let fd = -Infinity
  for (let i = 0; i < inner.length; i++) {
    const m: P = [(inner[i][0] + inner[(i + 1) % inner.length][0]) / 2, (inner[i][1] + inner[(i + 1) % inner.length][1]) / 2]
    const s = (m[0] - outer.gp[0]) * outer.n[0] + (m[1] - outer.gp[1]) * outer.n[1]
    if (s > fd) {
      fd = s
      far = i
    }
  }
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i]
    const e = inner[(i + 1) % inner.length]
    const L = dist(a, e)
    const m: P = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2]
    // 门所在的那面墙留空
    if (L < 16 || dist(m, outer.gp) < L * 0.45 + 2) continue
    if (!full && i !== far && rng.next() < 0.35) continue
    const u: P = [(e[0] - a[0]) / L, (e[1] - a[1]) / L]
    const n: P = [-u[1], u[0]]
    const s = (wc[0] - a[0]) * n[0] + (wc[1] - a[1]) * n[1] > 0 ? 1 : -1
    const d = i === far ? 10 + rng.next() * 3 : 7 + rng.next() * 3
    const t0 = full ? 0.08 : 0.15 + rng.next() * 0.2
    const t1 = full ? 0.92 : 0.65 + rng.next() * 0.2
    const mid: P = [a[0] + u[0] * L * ((t0 + t1) / 2) + (n[0] * s * d) / 2, a[1] + u[1] * L * ((t0 + t1) / 2) + (n[1] * s * d) / 2]
    const hall = rect(mid, u, L * (t1 - t0), d)
    if (inside(hall, ward)) addBuilding(ctx, hall, 'hall', 0.5)
  }
  // 礼拜堂：院里一座小堂
  if (C.chance('chapel', 0.45)) {
    const ch = fit(ward, (q, s) => rect(q, b.axis, 12 * s, 6.5 * s), (p) => inside(p, ward) && isFree(ctx, p, { pad: 1.5 }), [1, 0.8])
    C.note('chapelBuilt', !!ch && addBuilding(ctx, ch, 'temple', 1.5))
  }
  // 院里的井
  const well: P = [wc[0] - outer.n[0] * 4, wc[1] - outer.n[1] * 4]
  if (!ctx.occ.hitsPoint(well, 2) && pointInPoly(well, ward)) ctx.out.landmarks.push({ p: well, kind: 'well' })
  if (curtain !== curtain0) scatterTrees(ctx, curtain0, 0.0015, 2.5, 4)
  // 城门接上路（门前一条小街）
  if (o.connect !== false) connectGates(ctx, ctx.out.walls.slice(w0))
  C.done(c)
}

/** 多边形沿方向 n（从 o 量起）的最大伸展 */
function extentAlong(poly: Poly, o: P, n: P) {
  let hi = 0
  for (const v of poly) hi = Math.max(hi, (v[0] - o[0]) * n[0] + (v[1] - o[1]) * n[1])
  return hi
}
