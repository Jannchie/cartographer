import { eastAsian } from './culture'
import { emitArea, isFree, mark, type Ctx } from './ctx'
import { bboxOf, centroid, circlePoly, convexOverlap, dist, obb, pointInPoly, rect, type BBox, type P, type Poly } from './geom'
import { vegetation } from './outer'
import type { BuildingKind, Field, Tree } from './types'
import { addGroup, inside, urban } from './wards'
import { drop } from './undo'

/**
 * 公共设施与带露天场地的建筑群：酒馆、戏台、宣讲台、比武场、酒庄。
 * 它们由 placeLandmarks 沿街选址，拿到的是一块已经清空的占地（沿街宽 w、进深 d 的矩形）；
 * 这里在占地里按局部坐标摆放主楼、侧翼与露天场地（院子、观众席、场地），围上院墙。
 */

/** 占地的局部坐标：u 沿街，v 从街面（−d/2）指向里侧（+d/2） */
interface Lot {
  at: P
  u: P
  v: P
  w: number
  d: number
  box(u0: number, u1: number, v0: number, v1: number): Poly
  pt(u: number, v: number): P
  foot: Poly
}

function lot(ctx: Ctx, at: P, axis: P, w: number, d: number): Lot {
  // 街在哪一侧：两侧离道路走廊近的那边是街面
  let v: P = [-axis[1], axis[0]]
  const side = (s: number): P => [at[0] + v[0] * (d / 2) * s, at[1] + v[1] * (d / 2) * s]
  if (ctx.corridors.gap(side(1)) < ctx.corridors.gap(side(-1))) v = [-v[0], -v[1]]
  const pt = (a: number, b: number): P => [at[0] + axis[0] * a + v[0] * b, at[1] + axis[1] * a + v[1] * b]
  const box = (u0: number, u1: number, v0: number, v1: number): Poly => [pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)]
  return { at, u: axis, v, w, d, box, pt, foot: box(-w / 2, w / 2, -d / 2, d / 2) }
}

/** 田块的包围盒（田块多、每个地标都要查一遍，算一次记下来） */
const fieldBox = new WeakMap<Field, BBox>()

/** 占地里原有的树、田挪走（地标落在城外时占的是田地）；原地删（记下以便撤回），不整个重建 */
export function clear(ctx: Ctx, foot: Poly) {
  const [x0, y0, x1, y1] = bboxOf(foot)
  const keepTree = (t: Tree) => t.p[0] < x0 || t.p[0] > x1 || t.p[1] < y0 || t.p[1] > y1 || !pointInPoly(t.p, foot)
  const keepField = (f: Field) => {
    let b = fieldBox.get(f)
    if (!b) fieldBox.set(f, (b = bboxOf(f.poly)))
    return b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0 || !convexOverlap(f.poly, foot)
  }
  drop(ctx, 'trees', (t) => !keepTree(t))
  drop(ctx, 'fields', (f) => !keepField(f))
}

function trees(ctx: Ctx, pts: P[], r: number) {
  for (const p of pts) if (!ctx.occ.hitsPoint(p, 1)) ctx.out.trees.push({ p, r: r * (0.8 + ctx.rng.next() * 0.4) })
}

const east = (ctx: Ctx) => eastAsian(ctx.p.culture)

/**
 * 酒馆 / 客栈：驿站式的车马大院（约 34 × 30 米），比一般民居大得多。
 * 西式：临街两层的大堂（楼上客房）、一侧是穿过门洞进去的长排马厩、后排仓房与车棚，中间铺装的车马院；
 * 东式：四面围合的客栈院落，临街门楼大堂、两厢客房、后进仓房。
 */
export function tavernAt(ctx: Ctx, at: P, axis: P): boolean {
  const L = lot(ctx, at, axis, 34, 30)
  const { w, d, box } = L
  if (east(ctx)) {
    const parts: [Poly, BuildingKind][] = [
      [box(-w / 2 + 0.5, w / 2 - 0.5, -d / 2 + 0.5, -d / 2 + 9), 'civic'],
      [box(-w / 2 + 0.5, -w / 2 + 7, -d / 2 + 10, d / 2 - 7.5), 'large'],
      [box(w / 2 - 7, w / 2 - 0.5, -d / 2 + 10, d / 2 - 7.5), 'large'],
      [box(-w / 2 + 0.5, w / 2 - 0.5, d / 2 - 6.5, d / 2 - 0.5), 'shed'],
    ]
    if (!addGroup(ctx, parts, 0.3)) return false
    clear(ctx, L.foot)
    emitArea(ctx, 'greens', box(-w / 2 + 7.5, w / 2 - 7.5, -d / 2 + 9.5, d / 2 - 7), 'courtyard')
    emitArea(ctx, 'enclosures', L.foot)
    return true
  }
  const parts: [Poly, BuildingKind][] = [
    [box(-w / 2 + 0.5, w / 2 - 9, -d / 2 + 0.5, -d / 2 + 11), 'civic'],
    [box(w / 2 - 7, w / 2 - 0.5, -d / 2 + 4, d / 2 - 0.5), 'large'],
    [box(-w / 2 + 0.5, w / 2 - 9, d / 2 - 7, d / 2 - 0.5), 'shed'],
  ]
  if (!addGroup(ctx, parts, 0.3)) return false
  clear(ctx, L.foot)
  emitArea(ctx, 'greens', box(-w / 2 + 0.5, w / 2 - 7.5, -d / 2 + 11.5, d / 2 - 7.5), 'courtyard')
  emitArea(ctx, 'enclosures', L.foot)
  trees(ctx, [L.pt(-w / 2 + 3.5, 1)], 2.8)
  return true
}

/**
 * 医院 / 济贫院（约 34 × 26 米）：
 * 西式是临街一长排病房大厅，一端是小礼拜堂，后面一翼住修士，围着药草园；
 * 东式（养济院、惠民药局）是四面围合的院落，临街门厅、两厢病舍、后进药房。
 */
export function hospitalAt(ctx: Ctx, at: P, axis: P): boolean {
  const L = lot(ctx, at, axis, 34, 26)
  const { w, d, box } = L
  if (east(ctx)) {
    const parts: [Poly, BuildingKind][] = [
      [box(-w / 2 + 0.5, w / 2 - 0.5, -d / 2 + 0.5, -d / 2 + 7.5), 'civic'],
      [box(-w / 2 + 0.5, -w / 2 + 6.5, -d / 2 + 8.5, d / 2 - 7), 'large'],
      [box(w / 2 - 6.5, w / 2 - 0.5, -d / 2 + 8.5, d / 2 - 7), 'large'],
      [box(-w / 2 + 4, w / 2 - 4, d / 2 - 6.5, d / 2 - 0.5), 'hall'],
    ]
    if (!addGroup(ctx, parts, 0.3)) return false
    clear(ctx, L.foot)
    emitArea(ctx, 'greens', box(-w / 2 + 7, w / 2 - 7, -d / 2 + 8, d / 2 - 7), 'courtyard')
    emitArea(ctx, 'enclosures', L.foot)
    trees(ctx, [L.pt(-4, 1), L.pt(4, 1)], 2.4)
    return true
  }
  const parts: [Poly, BuildingKind][] = [
    [box(-w / 2 + 0.5, w / 2 - 8, -d / 2 + 0.5, -d / 2 + 9), 'civic'],
    [box(w / 2 - 7.5, w / 2 - 0.5, -d / 2 + 0.5, -d / 2 + 13), 'temple'],
    [box(-w / 2 + 0.5, -w / 2 + 7.5, -d / 2 + 9.5, d / 2 - 0.5), 'large'],
  ]
  if (!addGroup(ctx, parts, 0.3)) return false
  clear(ctx, L.foot)
  emitArea(ctx, 'greens', box(-w / 2 + 8, w / 2 - 0.5, -d / 2 + 13.5, d / 2 - 0.5), 'garden')
  emitArea(ctx, 'enclosures', L.foot)
  trees(ctx, [L.pt(w / 2 - 4, d / 2 - 3), L.pt(0, d / 2 - 4)], 2.4)
  return true
}

/**
 * 学校（约 40 × 34 米）：
 * 西式是大学 / 主教座堂学校的四合方院：临街门楼一翼、后面讲堂、两侧学舍，中间草坪；
 * 东式是书院：中轴上门屋、讲堂、藏书楼一进进往里，两侧斋舍。
 */
export function schoolAt(ctx: Ctx, at: P, axis: P): boolean {
  const L = lot(ctx, at, axis, 40, 34)
  const { w, d, box } = L
  if (east(ctx)) {
    const parts: [Poly, BuildingKind][] = [
      [box(-7, 7, -d / 2 + 0.5, -d / 2 + 6), 'hall'],
      [box(-11, 11, -3.5, 5), 'civic'],
      [box(-9, 9, d / 2 - 8, d / 2 - 0.5), 'temple'],
      [box(-w / 2 + 0.5, -w / 2 + 6, -d / 2 + 7, d / 2 - 0.5), 'large'],
      [box(w / 2 - 6, w / 2 - 0.5, -d / 2 + 7, d / 2 - 0.5), 'large'],
    ]
    if (!addGroup(ctx, parts, 0.3)) return false
    clear(ctx, L.foot)
    emitArea(ctx, 'greens', box(-w / 2 + 6.5, w / 2 - 6.5, -d / 2 + 6.5, -4), 'courtyard')
    emitArea(ctx, 'enclosures', L.foot)
    trees(ctx, [L.pt(-10, -d / 2 + 10), L.pt(10, -d / 2 + 10), L.pt(-11, d / 2 - 11), L.pt(11, d / 2 - 11)], 2.6)
    return true
  }
  const parts: [Poly, BuildingKind][] = [
    [box(-w / 2 + 0.5, w / 2 - 0.5, -d / 2 + 0.5, -d / 2 + 8), 'civic'],
    [box(-w / 2 + 0.5, w / 2 - 0.5, d / 2 - 9, d / 2 - 0.5), 'hall'],
    [box(-w / 2 + 0.5, -w / 2 + 7, -d / 2 + 8.5, d / 2 - 9.5), 'large'],
    [box(w / 2 - 7, w / 2 - 0.5, -d / 2 + 8.5, d / 2 - 9.5), 'large'],
  ]
  if (!addGroup(ctx, parts, 0.3)) return false
  clear(ctx, L.foot)
  emitArea(ctx, 'greens', box(-w / 2 + 7.5, w / 2 - 7.5, -d / 2 + 8.5, d / 2 - 9.5), 'courtyard')
  emitArea(ctx, 'enclosures', L.foot)
  trees(ctx, [L.pt(0, 0)], 3.2)
  return true
}

/** 戏台 / 露天剧场：靠里的一座台子，前面是扇形的观众场地 */
export function stageAt(ctx: Ctx, at: P, axis: P): boolean {
  const L = lot(ctx, at, axis, 28, 26)
  const { w, d, box } = L
  const stage = box(-6, 6, d / 2 - 8, d / 2 - 0.5)
  if (!addGroup(ctx, [[stage, 'civic']], 0.3)) return false
  clear(ctx, L.foot)
  // 观众场地：以台口为圆心、朝街的半圆
  const c = L.pt(0, d / 2 - 8)
  const R = Math.min(w / 2 - 0.5, d - 9)
  const fan: Poly = [L.pt(-R, d / 2 - 8)]
  for (let k = 1; k < 12; k++) {
    const a = Math.PI * (k / 12)
    fan.push(L.pt(-Math.cos(a) * R, d / 2 - 8 - Math.sin(a) * R))
  }
  fan.push(L.pt(R, d / 2 - 8))
  emitArea(ctx, 'plazas', fan)
  // 几排弧形的长凳（西式）/ 看台两侧的厢楼（东式）
  if (east(ctx)) addGroup(ctx, [[box(-w / 2 + 0.5, -w / 2 + 4.5, -d / 2 + 4, d / 2 - 1), 'large'], [box(w / 2 - 4.5, w / 2 - 0.5, -d / 2 + 4, d / 2 - 1), 'large']], 0.2)
  else
    for (const rr of [R * 0.45, R * 0.65, R * 0.85])
      for (let k = 1; k < 6; k++) {
        const a = Math.PI * (k / 6)
        const p: P = [c[0] + (-Math.cos(a) * L.u[0] - Math.sin(a) * L.v[0]) * rr, c[1] + (-Math.cos(a) * L.u[1] - Math.sin(a) * L.v[1]) * rr]
        const t: P = [Math.sin(a) * L.u[0] - Math.cos(a) * L.v[0], Math.sin(a) * L.u[1] - Math.cos(a) * L.v[1]]
        addGroup(ctx, [[rect(p, t, rr * 0.42, 0.9), 'shed']], 0)
      }
  return true
}

/** 宣讲台：广场上一块圆形空地，中间一座八角讲台 */
export function pulpitAt(ctx: Ctx, at: P, axis: P): boolean {
  const L = lot(ctx, at, axis, 16, 16)
  const pad = circlePoly(L.at, 7.5, 20)
  const stand = circlePoly(L.pt(0, 2), 2.4, 8, Math.PI / 8)
  if (!addGroup(ctx, [[stand, 'civic']], 0.3)) return false
  clear(ctx, pad)
  emitArea(ctx, 'plazas', pad)
  return true
}

/** 比武场 / 擂台：围起来的沙地，两侧长看台；西式中间一道比武隔栏，东式中间一座方擂台 */
export function arenaAt(ctx: Ctx, at: P, axis: P): boolean {
  const L = lot(ctx, at, axis, 46, 32)
  const { w, d, box } = L
  const parts: [Poly, BuildingKind][] = [
    [box(-w / 2 + 5, w / 2 - 5, -d / 2 + 0.5, -d / 2 + 4.5), 'civic'],
    [box(-w / 2 + 5, w / 2 - 5, d / 2 - 4.5, d / 2 - 0.5), 'civic'],
  ]
  parts.push(east(ctx) ? [box(-4.5, 4.5, -4.5, 4.5), 'civic'] : [box(-w * 0.3, w * 0.3, -0.35, 0.35), 'shed'])
  if (!addGroup(ctx, parts, 0.3)) return false
  clear(ctx, L.foot)
  emitArea(ctx, 'plazas', box(-w / 2 + 1, w / 2 - 1, -d / 2 + 5, d / 2 - 5))
  emitArea(ctx, 'enclosures', L.foot)
  return true
}

/** 葡萄酒庄：带院墙的庄园（主屋、酿酒房、院子），周围的田改种葡萄 */
export function wineryAt(ctx: Ctx, at: P, axis: P): boolean {
  const veg = vegetation(ctx)
  if (!veg.farm || !ctx.p.farms) return false
  const L = lot(ctx, at, axis, 36, 28)
  const { w, d, box } = L
  const parts: [Poly, BuildingKind][] = [
    [box(-w / 2 + 1, -w / 2 + 16, -d / 2 + 1, -d / 2 + 9), 'civic'],
    [box(-w / 2 + 1, -w / 2 + 9, -d / 2 + 9.5, d / 2 - 1), 'civic'],
    [box(w / 2 - 13, w / 2 - 1, -d / 2 + 1, -d / 2 + 8), 'hall'],
    [box(w / 2 - 9, w / 2 - 1, d / 2 - 8, d / 2 - 1), 'large'],
  ]
  if (!addGroup(ctx, parts, 0.3)) return false
  clear(ctx, L.foot)
  emitArea(ctx, 'plazas', box(-w / 2 + 9.5, w / 2 - 1, -d / 2 + 8.5, d / 2 - 8.5))
  emitArea(ctx, 'enclosures', L.foot)
  trees(ctx, [L.pt(-w / 2 + 13, d / 2 - 4), L.pt(0, d / 2 - 4)], 3)
  // 酒庄周围的田都是葡萄园
  const c = centroid(L.foot)
  for (const f of ctx.out.fields) if (f.kind !== 'paddy' && dist(centroid(f.poly), c) < 140) f.kind = 'vineyard'
  return true
}

/**
 * 圆形竞技场（罗马式）：椭圆的看台环（切成一圈扇段，四个方向留出入口）围着沙地，外面一圈铺装的空场；
 * 大小随城市人口（小城二三十米，大都会接近罗马大斗兽场的一百多米），放不下就缩小，片区其余部分照常盖房。
 */
export function amphitheater(ctx: Ctx, block: Poly): boolean {
  const b = obb(block)
  // 按建成时的人口定大小：城市后来长大，竞技场还是原来那座
  const pop = ctx.wardPop ?? ctx.p.population
  const want = Math.min(95, Math.max(22, 26 + 20 * Math.log2(Math.max(1, pop / 5000)))) * (0.85 + ctx.rng.next() * 0.3)
  const c = centroid(block)
  const ell = (a: number, e: number, n = 36): Poly =>
    Array.from({ length: n }, (_, k) => {
      const t = (k / n) * Math.PI * 2
      return [c[0] + b.axis[0] * Math.cos(t) * a - b.axis[1] * Math.sin(t) * e, c[1] + b.axis[1] * Math.cos(t) * a + b.axis[0] * Math.sin(t) * e] as P
    })
  // 从想要的大小往下缩，直到外圈空场整个落在片区里、不压路不压水
  for (let a = want; a >= 20; a *= 0.88) {
    const e = a * 0.82
    const apron = ell(a + 5, e + 5)
    if (!inside(apron, block) || !isFree(ctx, apron, { pad: 0.5, water: 3 })) continue
    const t = Math.max(6, a * 0.3)
    const n = 32
    const parts: [Poly, BuildingKind][] = []
    for (let k = 0; k < n; k++) {
      // 长短轴两端各留一个入口
      if (k % (n / 4) === 0) continue
      const seg = (r: number, s: number, i: number): P => {
        const th = ((i % n) / n) * Math.PI * 2 - Math.PI / n
        return [c[0] + b.axis[0] * Math.cos(th) * r - b.axis[1] * Math.sin(th) * s, c[1] + b.axis[1] * Math.cos(th) * r + b.axis[0] * Math.sin(th) * s]
      }
      parts.push([[seg(a, e, k), seg(a, e, k + 1), seg(a - t, e - t, k + 1), seg(a - t, e - t, k)], 'civic'])
    }
    if (!addGroup(ctx, parts, 0)) continue
    emitArea(ctx, 'plazas', apron)
    emitArea(ctx, 'plazas', ell(a - t - 0.5, e - t - 0.5))
    ctx.occ.add(apron)
    mark(ctx, c, 'amphitheater')
    // 片区其余的角落照常是街坊
    urban(ctx, block, 'common', [apron])
    return true
  }
  return false
}
