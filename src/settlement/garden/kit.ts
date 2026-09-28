import { RNG } from '../../gen/rng'
import type { Ctx } from '../ctx'
import { add, area, cbox, centroid, chaikin, circlePoly, dist, frameAt, inscribedRect, insetConvex, lerpP, neg, obb, perp, pointInPoly, resample, segDist, sub, unit, at, type P, type Poly, type RectFrame } from '../geom'
import type { BuildingKind, Building, Culture, ParkPart } from '../types'
import { inside, place, plantTree } from '../wards'
import type { Composer, Preset } from '../compose/core'
import { emitArea } from '../ctx'

/**
 * 园林的"工具箱"：园子的状态（Garden）、以及各元素共用的小动作（园路、铺装、池、树、石、房子）。
 * 骨架（skeletons.ts）与元素池（elements.ts）都只通过这里落地，于是"让开路、水、墙、别的房子"的规则只写一遍。
 * 标架用 geom 的 RectFrame（f 长轴、l 短轴，半长 hx、半宽 hy）。
 */

/** 标架的四个方向里最朝北（屏幕上 y 向上）的一个 */
export function northward(F: RectFrame): P {
  const dirs: P[] = [F.f, neg(F.f), F.l, neg(F.l)]
  return dirs.reduce((a, b) => (b[1] < a[1] ? b : a))
}

// —————————————————————— 园子的状态 ——————————————————————

/** 骨架：规则对称、自然山水、序列（参道）、成片（林、园地、白砂） */
export type Skel = 'axial' | 'natural' | 'procession' | 'field'

/**
 * 园林的预设（历史上有的样式，或各文明的自由组合）：就是组合式地标的预设（compose/core.ts 的 Preset：
 * bias.槽位.元素 = 倍数），另带园子自己的几项——骨架、地面、适用的文明与园地面积、有园墙的概率
 */
export interface GardenPreset extends Preset {
  cult: Culture
  skel: Skel
  /** 园地面积范围（m²） */
  min: number
  max?: number
  /** 地面：公园的草地，或围墙里的园林 */
  ground: 'park' | 'garden'
  /** 有园墙的概率 */
  wall: number
  /** 按园地改权重（临水的水渠园） */
  wAt?: (ctx: Ctx, g: Poly) => number
}

/** 一座园子在盖的时候的状态 */
export interface Garden extends RectFrame {
  ctx: Ctx
  cult: Culture
  /** 抽中的预设（骨架、地面） */
  P: GardenPreset
  /**
   * 这座园子的作曲者：预设、各槽位的元素都经它按名字抽签（按园址，城市长大也不变）；
   * 同一个名字要抽好几次的（沿池的几处景点）用 C.nth，按这个名字第几次抽编号，别的元素多抽、少抽、重试都不影响它
   */
  C: Composer
  /** 有没有园墙 */
  wall: boolean
  /** 细节的随机数（树的错落、石的形状）：也按园址播种，不动片区的随机数流 */
  rng: RNG
  /** 园地：让开水面、道路与城墙 */
  g: Poly
  /** 园地往里收 1 米（树、石都种在这里面） */
  inner: Poly
  A: number
  /** 园路（树让开） */
  walks: { a: P; b: P; hw: number }[]
  /** 不种树的地面：铺装、水池、白砂 */
  bare: Poly[]
  ponds: Poly[]
  /** 园路要让开的院落（书斋小院、方丈院） */
  solid: Poly[]
  /** 岛上可以种树（虽然在池里） */
  isles: Poly[]
  /** 主池（自然式） */
  lake?: Poly
  /** 园名注记的位置（主要的亭、殿） */
  seat?: P
}

export function garden(ctx: Ctx, g: Poly, C: Composer, P: GardenPreset, wall: boolean): Garden {
  const b = obb(g)
  return {
    ctx,
    cult: ctx.p.culture,
    P,
    C,
    wall,
    rng: new RNG(Math.floor(C.h('rng') * 4294967296)),
    g,
    inner: insetConvex(g, 1),
    A: area(g),
    o: b.center,
    f: b.axis,
    l: perp(b.axis),
    hx: b.len / 2,
    hy: b.wid / 2,
    walks: [],
    bare: [],
    ponds: [],
    solid: [],
    isles: [],
  }
}

/** 园地里内接的矩形（规则式园林用）：长边顺着 u，四周留 margin 米；短边不到 min 返回 null */
export function rectIn(K: Garden, margin: number, min: number, u: P = K.f): RectFrame | null {
  const zone = insetConvex(K.g, margin)
  if (zone.length < 3) return null
  const bands: [number, number][] = [[0, 1], [0.05, 0.95], [0.1, 0.9], [0.15, 0.85], [0.2, 0.8], [0, 0.8], [0.2, 1], [0.25, 0.75]]
  const r = inscribedRect(zone, u, { bands, minSide: min })
  if (!r) return null
  const hx = dist(r[0], r[1]) / 2
  const hy = dist(r[1], r[2]) / 2
  const o = centroid(r)
  const v = perp(u)
  return hx >= hy ? { o, f: u, l: v, hx, hy } : { o, f: v, l: perp(v), hx: hy, hy: hx }
}

// —————————————————————— 几何小工具 ——————————————————————

/** 点到多边形边界的距离 */
export function edgeDist(p: P, q: Poly) {
  let d = Infinity
  for (let i = 0; i < q.length; i++) d = Math.min(d, segDist(p, q[i], q[(i + 1) % q.length]).d)
  return d
}

/** 从 c 沿 d 出发到多边形边界的距离（c 在多边形里） */
export function reach(q: Poly, c: P, d: P) {
  let best = Infinity
  for (let i = 0; i < q.length; i++) {
    const a = q[i]
    const e = sub(q[(i + 1) % q.length], a)
    const den = d[0] * e[1] - d[1] * e[0]
    if (Math.abs(den) < 1e-9) continue
    const w = sub(a, c)
    const t = (w[0] * e[1] - w[1] * e[0]) / den
    const s = (w[0] * d[1] - w[1] * d[0]) / den
    if (t > 0 && s >= 0 && s <= 1) best = Math.min(best, t)
  }
  return best
}

/** 池岸（或岛岸）上 angle 方向的点，再往外 out 米 */
export function shore(q: Poly, angle: number, out = 0): P {
  const c = centroid(q)
  const d: P = [Math.cos(angle), Math.sin(angle)]
  const r = reach(q, c, d)
  return add(c, d, (Number.isFinite(r) ? r : 0) + out)
}

/** 两个多边形碰在一起（互有顶点落在对方里，或中心落在对方里） */
export const touch = (a: Poly, b: Poly) => a.some((p) => pointInPoly(p, b)) || b.some((p) => pointInPoly(p, a)) || pointInPoly(centroid(a), b)

/** 曲折的岸线：以标架里 (x, y) 为中心、半径 rx × ry，wob 越大岸线越曲折（湾、半岛），ph 定岸线的样子 */
export function blob(F: RectFrame, x: number, y: number, rx: number, ry: number, ph: number, wob = 1, n = 32): Poly {
  const out: Poly = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    const k = 1 + wob * (0.14 * Math.sin(2 * t + ph) + 0.1 * Math.sin(3 * t + ph * 1.3) + 0.06 * Math.cos(5 * t - ph * 0.7))
    out.push(at(F, x + Math.cos(t) * rx * k, y + Math.sin(t) * ry * k))
  }
  return out
}

/** 按比例 s（1 → 0.5）缩小，直到整个形状落在园地里离边 margin 米以内 */
export function fitShape(K: Garden, make: (s: number) => Poly, margin: number): Poly | null {
  const zone = insetConvex(K.g, margin)
  if (zone.length < 3) return null
  for (const s of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
    const q = make(s)
    if (q.every((p) => pointInPoly(p, zone))) return q
  }
  return null
}

/** 正 n 边形（朝向随标架） */
export const ngon = (F: RectFrame, p: P, r: number, n: number) => circlePoly(p, r, n, Math.atan2(F.f[1], F.f[0]) + Math.PI / n)

// —————————————————————— 落地 ——————————————————————

/** 园路：折线（smooth 时磨圆），宽 w 米；登记下来让树让开 */
export function walk(K: Garden, line: P[], w: number, smooth = false) {
  const l = smooth ? chaikin(line, 3) : line
  if (l.length < 2) return
  K.ctx.out.roads.push({ line: l, width: w, kind: 'path' })
  for (let i = 0; i + 1 < l.length; i++) K.walks.push({ a: l[i], b: l[i + 1], hw: w / 2 })
}

/** 铺装（甬道、台地、社前的白砂地）：画成广场，不种树 */
export function pave(K: Garden, poly: Poly) {
  if (poly.length < 3) return
  emitArea(K.ctx, 'plazas', poly)
  K.bare.push(poly)
}

export function part(K: Garden, poly: Poly, kind: ParkPart['kind'], angle?: number) {
  if (poly.length < 3) return
  K.ctx.out.parkParts.push(angle === undefined ? { poly, kind } : { poly, kind, angle })
  if (kind === 'pond') K.ponds.push(poly)
  if (kind === 'isle') K.isles.push(poly)
  if (kind === 'pond' || kind === 'gravel') K.bare.push(poly)
}

/** 园墙（粉墙、土塀、园囿的围墙） */
export const wall = (K: Garden, poly: Poly = insetConvex(K.g, 0.4)) => poly.length >= 3 && emitArea(K.ctx, 'enclosures', poly)

/** 种一棵园里的树：在园地里、不上园路、不落在铺装与池面上（岛上可以）；any 时只看园路与房子（花坛上的修剪树、堤上的柳） */
export function tree(K: Garden, p: P, r: number, any = false): boolean {
  if (!pointInPoly(p, K.inner)) return false
  if (!any && !K.isles.some((q) => pointInPoly(p, q)))
    for (const q of K.bare) if (pointInPoly(p, q) || edgeDist(p, q) < r * 0.5) return false
  if (any && K.ponds.some((q) => pointInPoly(p, q)) && !K.isles.some((q) => pointInPoly(p, q))) return false
  for (const s of K.walks) if (segDist(p, s.a, s.b).d < s.hw + r * 0.55) return false
  return plantTree(K.ctx, p, r)
}

/** 一行树：a 到 b 每隔约 step 米一棵；r 可随序号变（柏树与悬铃木相间） */
export function row(K: Garden, a: P, b: P, step: number, r: number | ((k: number) => number), any = false) {
  const n = Math.max(1, Math.round(dist(a, b) / step))
  for (let k = 0; k <= n; k++) tree(K, lerpP(a, b, k / n), typeof r === 'number' ? r : r(k), any)
}

/** 一丛树：p 周围 R 米内 n 棵 */
export function clump(K: Garden, p: P, R: number, n: number, r0: number, r1: number) {
  const rng = K.rng
  for (let k = 0, placed = 0; k < n * 3 && placed < n; k++) {
    const a = rng.next() * Math.PI * 2
    const d = Math.sqrt(rng.next()) * R
    if (tree(K, [p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d], r0 + rng.next() * (r1 - r0))) placed++
  }
}

/** 在 poly 里按密度（棵 / m²）随机种树；keep 可再筛掉一些位置 */
export function scatter(K: Garden, poly: Poly, density: number, r0: number, r1: number, keep?: (p: P) => boolean) {
  if (poly.length < 3) return
  const rng = K.rng
  const n = Math.round(area(poly) * density)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of poly) {
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  for (let k = 0, placed = 0; k < n * 4 && placed < n; k++) {
    const p: P = [x0 + rng.next() * (x1 - x0), y0 + rng.next() * (y1 - y0)]
    if (!pointInPoly(p, poly) || (keep && !keep(p))) continue
    if (tree(K, p, r0 + rng.next() * (r1 - r0))) placed++
  }
}

/** 园里的一栋房子：在园地里、不压池（wet 时可以一半探进水里，如水榭）、不压路与别的房子 */
export function bld(K: Garden, poly: Poly, kind: BuildingKind, wet = false, extra?: Partial<Building>): boolean {
  if (!inside(poly, K.inner)) return false
  if (!wet && K.ponds.some((q) => touch(poly, q))) return false
  if (K.solid.some((q) => touch(poly, q))) return false
  return place(K.ctx, poly, kind, { pad: kind === 'torii' ? 0.2 : 0.5 }, extra)
}

/** 一座亭：方亭，或 sides 边的多角亭（音乐亭、小神殿） */
export function kiosk(K: Garden, p: P, s: number, kind: BuildingKind = 'pagoda', sides = 4, wet = false, d: P = K.f) {
  const q = sides === 4 ? cbox(frameAt(p, d), 0, 0, s, s) : circlePoly(p, s / 2, sides, Math.atan2(d[1], d[0]) + Math.PI / sides)
  return bld(K, q, kind, wet)
}

/** 一块置石（r 为大致半径）：不规则的五到七边形 */
export function rock(K: Garden, p: P, r: number) {
  const rng = K.rng
  if (!pointInPoly(p, K.inner) || K.ctx.occ.hitsPoint(p, r * 0.9)) return false
  const n = 5 + Math.floor(rng.next() * 3)
  const a0 = rng.next() * Math.PI * 2
  const q: Poly = []
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2
    const rr = r * (0.7 + rng.next() * 0.45)
    q.push([p[0] + Math.cos(a) * rr, p[1] + Math.sin(a) * rr * 0.85])
  }
  part(K, q, 'rock')
  K.ctx.occ.add(q)
  return true
}

/** 一组石（假山、石组）：p 周围 R 米内 n 块，大小 r0 ~ r1 */
export function rocks(K: Garden, p: P, R: number, n: number, r0: number, r1: number) {
  const rng = K.rng
  let placed = 0
  for (let k = 0; k < n * 4 && placed < n; k++) {
    const a = rng.next() * Math.PI * 2
    const d = Math.sqrt(rng.next()) * R
    if (rock(K, [p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d], r0 + rng.next() * (r1 - r0))) placed++
  }
  return placed
}

export const landmark = (K: Garden, p: P, kind: 'fountain' | 'statue' | 'well') => {
  if (!pointInPoly(p, K.g)) return false
  K.ctx.out.landmarks.push({ p, kind })
  return true
}

// —————————————————————— 园门与园路 ——————————————————————

/** 园门：园地临街的边（边外几米就是路）按长短排，取中点；d 朝园里 */
export function gates(K: Garden): { p: P; d: P }[] {
  const c = centroid(K.g)
  const out: { p: P; d: P; s: number }[] = []
  for (let i = 0; i < K.g.length; i++) {
    const a = K.g[i]
    const b = K.g[(i + 1) % K.g.length]
    const L = dist(a, b)
    if (L < 8) continue
    const m = lerpP(a, b, 0.5)
    let n = unit(perp(sub(b, a)))
    if ((c[0] - m[0]) * n[0] + (c[1] - m[1]) * n[1] < 0) n = neg(n)
    const road = K.ctx.corridors.hits(add(m, n, -4), 1.5, ['road'])
    out.push({ p: add(m, n, 0.4), d: n, s: L + (road ? 1000 : 0) })
  }
  return out.sort((x, y) => y.s - x.s)
}

/** 把点推出池子与院落（离边至少 gap 米） */
export function offWater(K: Garden, p: P, gap: number): P {
  let q = p
  for (const w of [...K.ponds, ...K.solid]) {
    const c = centroid(w)
    const d = unit(sub(q, c))
    for (let k = 0; k < 40 && (pointInPoly(q, w) || edgeDist(q, w) < gap); k++) q = add(q, d, 1)
  }
  return q
}

/** 线段 a → b 穿过（或擦过离岸 gap 米以内）池 q */
export function crosses(a: P, b: P, q: Poly, gap: number) {
  const n = Math.max(2, Math.ceil(dist(a, b) / 1.5))
  for (let k = 0; k <= n; k++) {
    const p = lerpP(a, b, k / n)
    if (pointInPoly(p, q) || edgeDist(p, q) < gap) return true
  }
  return false
}

/** 园路绕开池子：穿过池面的一段，从离池近的一侧、岸外 gap 米绕过去（那一侧出了园就走另一侧） */
export function dry(K: Garden, line: P[], gap = 2.5): P[] {
  let pts = line
  for (let pass = 0; pass < 3; pass++) {
    const out: P[] = [pts[0]]
    let changed = false
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      const w = [...K.ponds, ...K.solid].find((q) => crosses(a, b, q, gap))
      if (w) {
        const pc = centroid(w)
        const { t } = segDist(pc, a, b)
        const foot = lerpP(a, b, t)
        const n0 = dist(foot, pc) > 0.5 ? unit(sub(foot, pc)) : unit(perp(sub(b, a)))
        const via = [n0, neg(n0)].map((n) => add(pc, n, reach(w, pc, n) + gap + 1.5)).find((p) => pointInPoly(p, K.inner))
        if (via) {
          out.push(via)
          changed = true
        }
      }
      out.push(b)
    }
    pts = out
    if (!changed) break
  }
  return pts
}

/** 绕园一周的园路：园地往里收 inset 米，岸线似的左右摆动 amp 米，推开池子，磨圆。返回闭合的点列 */
export function loop(K: Garden, inset: number, amp: number, w: number): P[] | null {
  const base = insetConvex(K.g, inset)
  if (base.length < 3 || area(base) < 200) return null
  const c = centroid(base)
  const ph = K.C.h('loop.phase') * 6.28
  const pts = resample([...base, base[0]], 8)
    .slice(0, -1)
    .map((p, i) => offWater(K, add(p, unit(sub(c, p)), amp * (0.5 + 0.5 * Math.sin(i * 1.1 + ph))), w / 2 + 1.5))
  const l = chaikin(pts, 3, true)
  const line = [...l, l[0]]
  walk(K, line, w)
  return line
}

/** 从 from 走到 line 上最近的点（小路微微弯一下） */
export function spur(K: Garden, from: P, line: P[], w: number) {
  let best = line[0]
  for (const p of line) if (dist(p, from) < dist(best, from)) best = p
  if (dist(best, from) < 3) return
  const m = lerpP(from, best, 0.5)
  const n = unit(perp(sub(best, from)))
  const k = (K.rng.next() - 0.5) * dist(best, from) * 0.3
  walk(K, dry(K, [from, offWater(K, add(m, n, k), w), best]), w, true)
}

/** 池中一座小岛：返回岛的轮廓 */
export function isle(K: Garden, lake: Poly, c: P, r: number, ph: number) {
  const q = blob(frameAt(c, K.f), 0, 0, r, r * 0.8, ph, 1.2, 18)
  if (!q.every((p) => pointInPoly(p, lake) && edgeDist(p, lake) > 1.5)) return null
  if (K.isles.some((o) => touch(o, q) || q.some((p) => edgeDist(p, o) < 2))) return null
  part(K, q, 'isle')
  return q
}

/** 园里离 p 最远的园角，往回收 back 米 */
export function farCorner(K: Garden, p: P, back: number): P {
  const far = K.inner.reduce((a, b) => (dist(b, p) > dist(a, p) ? b : a))
  return add(far, unit(sub(p, far)), back)
}

export { circlePoly, insetConvex, pointInPoly, dist, area, centroid, clipHalf } from '../geom'
