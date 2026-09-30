import type { CultureStyle } from '../culture'
import { emitArea, clearOf, cityDice, clipWater, hashAt, isFree, placeable, type Ctx } from '../ctx'
import { allot, composer, type Elem, type Preset } from '../compose/core'
import { add, area, axes, centroid, circlePoly, clipConvex, clipHalf, dist, inscribedRect, insetConvex, localBox, obb, pointInPoly, rect, type P, type Poly } from '../geom'
import {
  fabric,
  FABRIC,
  greatMosque,
  kasbah,
  khan,
  orchard,
  poi,
  quarter,
  rahba,
  smallMosque,
  souq,
  st,
  type Fabric,
} from '../plans/medina'
import { isVillage } from '../scale'
import type { BuildingKind, Ward } from '../types'
import { addBuilding, addGroup, fit, inside, place, plantTree, scatterTrees, subdivide } from '../wards'
import { addWall, connectGates } from '../walls'
import * as dmath from '../../gen/dmath'

/**
 * 伊斯兰：有机生长的城里（以及麦地那城墙外的关厢）也按伊斯兰城市的样子盖：
 * - 住宅街坊是内院住宅与尽端巷（与麦地那共用 plans/medina.ts 的 fabric），按片区的密度档调宅地大小、层数；
 * - 宗教片区是清真寺：离城心最近的一座（最先盖的）是大清真寺，其余是街坊清真寺；
 * - 市场是有顶的集市巷（souq），广场是街坊里的小广场（rahba）；
 * - 城堡是要塞（kasbah），都城里第一座是宫殿（qasr：宫门、校场、一进进的院子、后宫、服务区与御园）；
 * - 住宅街坊里偶有浴场、经学院，商人街坊与城郊沿路有商队客栈。
 */
export const islamic: CultureStyle = {
  buildWard(ctx, ward, block) {
    const small = isVillage(ctx.p.size)
    switch (ward.type) {
      case 'plaza':
        rahba(ctx, block)
        return true
      case 'temple':
        if (!small && ward.inner && st(ctx).great === 0) greatMosque(ctx, ward, block)
        else smallMosque(ctx, block, small ? VILLAGE : preset(ctx, 'common'))
        return true
      case 'market':
        souq(ctx, ward, block)
        return true
      case 'castle':
        return citadel(ctx, block)
      case 'suburb':
        suburb(ctx, ward, block)
        return true
      case 'common':
      case 'merchant':
      case 'craft':
      case 'slum':
      case 'noble':
        dwell(ctx, ward, block, small)
        return true
    }
    return false
  },
}

// —————————————————————— 住宅街坊 ——————————————————————

/** 村心的街坊：宅地大些、平房 */
const VILLAGE: Fabric = { maxA: 300, minA: 120, derb: 44, floors: 1 }

/**
 * 按片区的密度档调住宅街坊：密档宅地小、临街主屋两三层（楼上另住一户）；
 * 疏档（新辟的外围）宅地大、院子是种树的园子，一部分宅地空着是果园。
 */
function preset(ctx: Ctx, type: Ward['type']): Fabric {
  const o = FABRIC[type] ?? FABRIC.common!
  const k = (m: number, extra: Partial<Fabric> = {}): Fabric => ({ ...o, maxA: o.maxA * m, minA: o.minA * m, ...extra })
  // 贵人的大宅（riad）比麦地那城心的更宽敞；贫民街坊挤到三层
  if (type === 'noble') return k(2, { derb: o.derb * 1.3 })
  if (type === 'slum') return { ...o, floors: 3 }
  switch (ctx.wardDensity) {
    case 'high':
      return k(0.42, { derb: o.derb * 0.8, floors: 4 })
    case 'low':
      return k(2.2, { derb: o.derb * 1.4, riad: true, fill: 0.55 })
    default:
      return k(type === 'craft' ? 0.9 : 0.72)
  }
}

function dwell(ctx: Ctx, ward: Ward, block: Poly, small: boolean) {
  const n0 = ctx.out.buildings.length
  // 零散的农家院（村子的外围；村 → 镇连续过渡，见 generate.ts 的 wardTown）
  if (!ctx.wardTown) {
    farmsteads(ctx, block)
    return
  }
  // 村子里成了街坊的：挤在一起的内院住宅
  if (small) {
    fabric(ctx, block, VILLAGE)
    return
  }
  const s = st(ctx)
  const reserve: Poly[] = []
  const h = hashAt(ctx, centroid(ward.poly), 'islamic.ward')
  const pop = ctx.p.population
  // 街坊里的公共设施：商人街坊偶有商队客栈，民居、商人街坊偶有经学院（浴场、染坊见 quarter）
  if (ctx.wardFill > 0.6 && ctx.houseBudget > 0) {
    if (ward.type === 'merchant' && h < 0.4 && s.khans < Math.max(1, Math.round(pop / 9000))) {
      const k = caravanserai(ctx, block)
      if (k) reserve.push(k)
    } else if ((ward.type === 'common' || ward.type === 'merchant') && h > 0.82 && ctx.p.size === 'city' && s.madrasas < Math.max(1, Math.round(pop / 12000))) {
      const m = madrasa(ctx, block)
      if (m) reserve.push(m)
    }
  }
  quarter(ctx, ward, block, preset(ctx, ward.type), pop / 4000, reserve)
  // 一户也没盖上的贵族、贫民片区是果园（民居、工匠、商人片区由框架退回农田）
  if ((ward.type === 'noble' || ward.type === 'slum') && !ctx.out.buildings.slice(n0).some((b) => b.kind === 'house' || b.kind === 'large')) orchard(ctx, block)
}

/** 城郊：沿路的内院住宅，路边偶有商队客栈 */
function suburb(ctx: Ctx, ward: Ward, block: Poly) {
  const s = st(ctx)
  const reserve: Poly[] = []
  if (ctx.p.size === 'city' || ctx.p.size === 'town') {
    const h = hashAt(ctx, centroid(ward.poly), 'islamic.reserve')
    if (h < 0.18 && s.khans < Math.max(1, Math.round(ctx.p.population / 9000))) {
      const k = caravanserai(ctx, block)
      if (k) reserve.push(k)
    }
  }
  fabric(ctx, block, { maxA: 260, minA: 110, derb: 1e9, reach: 26, fill: 0.85 }, reserve)
}

/** 村外的农家：一座小内院住宅，旁边一方围起来的院子，几棵果树 */
function farmsteads(ctx: Ctx, block: Poly) {
  const rng = ctx.rng
  const lots = subdivide(ctx, block, { maxA: 900, minA: 400, alley: 0, alleyP: 0, depth: 10, fill: 1, irr: 0.8 })
  for (const { poly: lot } of lots) {
    if (rng.next() > 0.75) continue
    const q = placeable(ctx, insetConvex(lot, 1.5), 3)
    if (!q || area(q) < 200) continue
    const b = obb(q)
    const c = b.center
    const house = rect(add(c, b.axis, -b.len * 0.18), b.axis, Math.min(15, b.len * 0.45), Math.min(13, b.wid * 0.7))
    if (!inside(house, q)) continue
    const { u0, u1, v0, v1, box } = localBox(house, b.axis)
    const t = Math.min(4, (v1 - v0) * 0.32)
    // 两翼成 L 形，院子朝着地里
    if (!addBuilding(ctx, box(u0, u1, v0, v0 + t), 'house', 0, 1)) continue
    const wingP = box(u0, u0 + t, v0 + t, v1)
    place(ctx, wingP, 'house', {}, { ridge: dmath.atan2(b.axis[1], b.axis[0]) + Math.PI / 2, floors: 1, units: 0 })
    const yard = insetConvex(q, 0.5)
    if (yard.length >= 3) emitArea(ctx, 'enclosures', yard)
    scatterTrees(ctx, insetConvex(q, 2), 0.004, 2, 3.4)
  }
}

// —————————————————————— 公共设施 ——————————————————————

/** 商队客栈：临街的大方院，一圈客房与货仓围着院子 */
function caravanserai(ctx: Ctx, block: Poly): Poly | null {
  const zone = insetConvex(block, 5)
  if (zone.length < 3) return null
  const foot = khan(ctx, block, zone, obb(block).axis, ctx.p.size === 'city' ? 34 : 28, 'civic')
  if (!foot) return null
  st(ctx).khans++
  ctx.out.landmarks.push({ p: centroid(foot), name: ctx.namer.islamic('caravanserai'), kind: 'tavern' })
  return foot
}

/**
 * 经学院（madrasa）：四面的学舍围着方院，朝礼拜方向一面是讲堂（iwan），院心一方水池，门边一座小宣礼塔。
 */
function madrasa(ctx: Ctx, block: Poly): Poly | null {
  const zone = insetConvex(block, 5)
  if (zone.length < 3) return null
  const q = st(ctx).qibla
  const got = fit(
    zone,
    (m, s) => {
      const L = 30 * s
      const W = 26 * s
      const t = 5 * s
      const { u0, u1, v0, v1, box } = localBox(rect(m, q, L, W), q)
      const parts: [Poly, BuildingKind][] = [
        [box(u1 - t * 1.8, u1, v0, v1), 'civic'],
        [box(u0, u0 + t, v0, v1), 'civic'],
        [box(u0 + t, u1 - t * 1.8, v0, v0 + t), 'civic'],
        [box(u0 + t, u1 - t * 1.8, v1 - t, v1), 'civic'],
        [box(u0 - 1.5, u0 + 3.5 * s, v1 - 3.5 * s, v1 + 1.5), 'tower'],
      ]
      return { parts, court: box(u0 + t, u1 - t * 1.8, v0 + t, v1 - t), foot: box(u0 - 1, u1 + 1, v0 - 1, v1 + 1) }
    },
    (t) => t.parts.every(([p]) => inside(p, block) && isFree(ctx, p, { pad: 0.5 })),
    [1, 0.85, 0.72],
  )
  if (!got || !addGroup(ctx, got.parts, 0.5)) return null
  emitArea(ctx, 'plazas', got.court)
  ctx.occ.add(got.court)
  ctx.out.landmarks.push({ p: centroid(got.court), name: ctx.namer.islamic('madrasa'), kind: 'school' })
  st(ctx).madrasas++
  return got.foot
}

// —————————————————————— 要塞与宫殿 ——————————————————————

function citadel(ctx: Ctx, block: Poly): boolean {
  const s = st(ctx)
  if (ctx.p.capital && s.palaces === 0 && qasr(ctx, block)) {
    s.palaces++
    return true
  }
  if (kasbah(ctx, block)) return true
  // 放不下要塞：贵人的大宅院
  fabric(ctx, block, FABRIC.noble!)
  return true
}

/** 幕墙上朝城心的那条边（开门处） */
function gateEdge(ctx: Ctx, curtain: Poly, c: P) {
  const toC: P = [ctx.center[0] - c[0], ctx.center[1] - c[1]]
  let gi = 0
  let gd = -Infinity
  for (let i = 0; i < curtain.length; i++) {
    const a = curtain[i]
    const e = curtain[(i + 1) % curtain.length]
    const m: P = [(a[0] + e[0]) / 2 - c[0], (a[1] + e[1]) / 2 - c[1]]
    const s = (m[0] * toC[0] + m[1] * toC[1]) / (dmath.hypot(...m) || 1)
    if (s > gd && dist(a, e) > 14) {
      gd = s
      gi = i
    }
  }
  const L = dmath.hypot(...toC) || 1
  return { gi, toC: [toC[0] / L, toC[1] / L] as P }
}

/**
 * 宫殿（qasr）：都城的王宫（仿阿尔罕布拉、托普卡帕、非斯与马拉喀什的王宫 Dar al-Makhzen）。
 * 一圈幕墙与方塔，朝城里一面是两座方塔夹着的宫门（Bab）；进门是校场（mechouar），沿门墙是卫队的营房。
 * 校场往里（局部坐标 u 从门往里、v 横向）分成几条纵带：
 * - 中轴：一进进的院子——议事院（divan：四面回廊，尽头是接见大殿与穹顶殿）、
 *   长院（桃金娘院：中间一条长水池，两边绿篱，尽头是觐见塔）、狮子院（一圈柱廊，十字水渠分出四块花圃，院心水泉）、
 *   最里面是后宫（harem）：一格格的小内院住宅；
 * - 一侧是服务区：宫里的清真寺（朝礼拜方向）、浴场、御膳房、马厩、库房；
 * - 另一侧是御园：一座座四分园（chahar-bagh），宫城够大时往里是果园（agdal）与蓄水的大池。
 * 宫城小时纵带并起来：窄的只剩中轴（长院 + 狮子院），最小的是一座围着水池院的宫殿。
 */
function qasr(ctx: Ctx, block: Poly): boolean {
  let curtain: Poly | null = null
  for (const d of [3, 6, 10]) {
    // 干道斜切过片区一角时，幕墙沿路收进来，不整座放弃
    const w = clipWater(ctx, insetConvex(block, d), 4)
    const q = w && clearOf(ctx, w, ['road', 'river', 'wall'])
    if (q && q.length >= 3 && area(q) > 1400 && !ctx.corridors.hitsPoly(q, 1, ['road', 'river', 'wall'])) {
      curtain = q
      break
    }
  }
  if (!curtain) return false
  curtain = dry(ctx, curtain)
  if (!curtain) return false
  const c = centroid(curtain)
  const { gi } = gateEdge(ctx, curtain, c)
  const ga = curtain[gi]
  const gb = curtain[(gi + 1) % curtain.length]
  const gm: P = [(ga[0] + gb[0]) / 2, (ga[1] + gb[1]) / 2]
  const gl = dist(ga, gb) || 1
  const ge: P = [(gb[0] - ga[0]) / gl, (gb[1] - ga[1]) / gl]
  // 门墙的内法向就是中轴方向
  let eg: P = [-ge[1], ge[0]]
  if ((c[0] - gm[0]) * eg[0] + (c[1] - gm[1]) * eg[1] < 0) eg = [-eg[0], -eg[1]]
  // 宫殿占幕墙里最大的矩形：顺着门墙的法向或幕墙某条边的方向摆（顺着门的稍占便宜、贴着门的占便宜）
  const inner = insetConvex(curtain, 3.5)
  if (inner.length < 3) return false
  let W: Poly | null = null
  let ax: P = eg
  let best = 0
  const dirs: P[] = [eg, ...curtain.map((a, i) => {
    const b = curtain![(i + 1) % curtain!.length]
    const L = dist(a, b) || 1
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L] as P
  })]
  for (const [k, x] of dirs.entries()) {
    // 进深从门这一侧量起；离门远的矩形打折（门与宫殿之间空出一大片不好）
    let v: P = [-x[1], x[0]]
    if (v[0] * eg[0] + v[1] * eg[1] < 0) v = [-v[0], -v[1]]
    const r = inscribedRect(inner, x, { minSide: 14, v })
    if (!r) continue
    const gap = Math.max(0, Math.min(...r.map((q) => (q[0] - gm[0]) * eg[0] + (q[1] - gm[1]) * eg[1])) - 4)
    const sc = (area(r) * (k === 0 ? 1.15 : 1)) / (1 + gap / 60)
    if (sc > best) {
      best = sc
      W = r
      ax = x
    }
  }
  if (!W) return false
  // 中轴取矩形两个方向里最接近门内法向的一个
  let e: P = ax
  for (const x of [ax, [-ax[0], -ax[1]], [-ax[1], ax[0]], [ax[1], -ax[0]]] as P[]) if (x[0] * eg[0] + x[1] * eg[1] > e[0] * eg[0] + e[1] * eg[1]) e = x
  const towers: P[] = []
  curtain.forEach((a, i) => {
    const b = curtain![(i + 1) % curtain!.length]
    towers.push(a)
    const k = Math.floor(dist(a, b) / 22)
    for (let j = 1; j <= k; j++) if (i !== gi) towers.push([a[0] + ((b[0] - a[0]) * j) / (k + 1), a[1] + ((b[1] - a[1]) * j) / (k + 1)])
  })
  const wall = addWall(ctx, { loop: curtain, solid: curtain.map(() => true), towers, gates: [{ p: gm, angle: dmath.atan2(ge[1], ge[0]) + Math.PI / 2 }], kind: 'stone', thickness: 3 }, 'keep')
  ctx.out.landmarks.push({ p: c, name: ctx.namer.palace(), kind: 'castle' })

  const f = axes(e)
  const fw = localBox(W, e)
  const [u0, u1, v0, v1] = [fw.u0, fw.u1, fw.v0, fw.v1]
  const Lu = u1 - u0
  const Lv = v1 - v0
  const K: Kit = { ctx, f }
  const g0 = axes(eg)
  const gv0 = gm[0] * f.n[0] + gm[1] * f.n[1]
  const gv = Math.min(v1 - 10, Math.max(v0 + 10, gv0))
  // 宫门：门洞两侧各一座方塔，骑在幕墙上
  const gt = Math.max(6, Math.min(11, Lv * 0.045))
  {
    const gu = gm[0] * eg[0] + gm[1] * eg[1]
    const gw = gm[0] * g0.n[0] + gm[1] * g0.n[1]
    for (const sg of [-1, 1]) {
      const tv = gw + sg * (2.8 + gt / 2)
      for (const du of [0, 1.5, 3]) if (put(K, g0.box(gu + du - gt / 2, gu + du + gt / 2, tv - gt / 2, tv + gt / 2), 'tower')) break
    }
  }
  // 宫殿离门远：门里一条两边种树的甬道通到校场
  const gu0 = gm[0] * e[0] + gm[1] * e[1]
  if (u0 - gu0 > 8) {
    const av = clipConvex(f.box(gu0, u0, gv - 4, gv + 4), curtain)
    if (av.length >= 3) {
      for (const sv of [-6, 6]) for (let u = gu0 + 6; u < u0 - 3; u += 7) if (pointInPoly(f.at(u, gv + sv), inner)) tree(K, f.at(u, gv + sv), 2 + ctx.rng.next() * 0.5)
      emitArea(ctx, 'plazas', av)
      ctx.occ.add(av)
    }
  }

  // 校场：门里横着的一条铺地，门墙一侧是卫队的营房
  const dm = Lu < 60 || Lv < 45 ? 0 : Math.max(12, Math.min(28, Lu * 0.1))
  if (dm > 0) {
    const tg = Math.min(7, dm * 0.35)
    range(K, [u0, u0 + tg, v0, gv - 3.2 - gt], 'hall', 20)
    range(K, [u0, u0 + tg, gv + 3.2 + gt, v1], 'hall', 20)
    // 校场里沿内侧一行树
    if (dm > 16) for (let v = v0 + 6; v < v1 - 5; v += 7) if (Math.abs(v - gv) > 12) tree(K, f.at(u0 + dm - 3.5, v), 1.8 + ctx.rng.next() * 0.5)
    pave(K, [u0, u0 + dm, v0, v1])
  }
  const ub = u0 + dm
  const D = u1 - ub
  // 纵带：宽的宫城三条（服务区 | 中轴 | 御园），中等两条，窄的只有中轴
  const lane = 3.5
  const flip = cityDice(ctx, 'qasr.layout').chance('flip', 0.5)
  let spine: [number, number]
  let service: [number, number] | null = null
  let garden: [number, number] | null = null
  if (Lv >= 125) {
    const ws = Math.max(44, Math.min(100, Lv * 0.36))
    const s0 = Math.min(v1 - ws - 40, Math.max(v0 + 40, gv - ws / 2))
    spine = [s0, s0 + ws]
    const A: [number, number] = [v0, s0 - lane]
    const B: [number, number] = [s0 + ws + lane, v1]
    ;[service, garden] = flip ? [A, B] : [B, A]
    // 服务区不必比御园宽
    if (service[1] - service[0] > garden[1] - garden[0] + 10) [service, garden] = [garden, service]
  } else if (Lv >= 70) {
    const ws = Lv * 0.56
    spine = flip ? [v0, v0 + ws] : [v1 - ws, v1]
    const side: [number, number] = flip ? [v0 + ws + lane, v1] : [v0, v1 - ws - lane]
    service = side
    garden = side
  } else spine = [v0, v1]
  // 纵带之间的通道
  for (const band of service === garden ? [service] : [service, garden]) {
    if (!band) continue
    const sv = band[0] < spine[0] ? [band[1], spine[0]] : [spine[1], band[0]]
    if (sv[1] - sv[0] > 0.5) pave(K, [ub, u1, sv[0], sv[1]])
  }
  spineCourts(K, ub, u1, spine[0], spine[1])
  if (service && garden && service === garden) {
    // 两条带：靠门是清真寺与浴场，往里是御园
    const W2 = service[1] - service[0]
    const ds = Math.min(D * 0.45, Math.max(24, W2 * 0.9))
    serviceBand(K, ub, ub + ds, service[0], service[1], true)
    pave(K, [ub + ds, ub + ds + lane, service[0], service[1]])
    gardenBand(K, ub + ds + lane, u1, service[0], service[1])
  } else {
    if (service) serviceBand(K, ub, u1, service[0], service[1], false)
    if (garden) gardenBand(K, ub, u1, garden[0], garden[1])
  }
  // 幕墙与宫殿之间的边角：铺地，宽的边角沿墙一排库房、几棵树
  const wc = centroid(W)
  let big = 0
  for (let i = 0; i < 4; i++) {
    const a = W[i]
    const b = W[(i + 1) % 4]
    const L = dist(a, b) || 1
    let out: P = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L]
    const o: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    if ((o[0] - wc[0]) * out[0] + (o[1] - wc[1]) * out[1] < 0) out = [-out[0], -out[1]]
    // clipHalf 留下 (p - o)·n ≤ 0 的一侧：法向取朝里，留下矩形外的一侧
    const q = clipHalf(curtain, o, [-out[0], -out[1]])
    if (q.length < 3 || area(q) < 20) continue
    const b2 = obb(q)
    if (b2.wid > 30 && area(q) > 1500) {
      // 大的边角：先顺着宫殿的轴线摆一方四分园或一片仓房马厩（轮着来），其余是围起来的果园，树成行成列
      const qi = insetConvex(q, 3)
      const r = qi.length >= 3 ? inscribedRect(qi, e, { minSide: 26 }) : null
      if (r && area(r) > 1000 && !ctx.occ.overlaps(r)) {
        const fr = localBox(r, e)
        if (big++ % 2 === 0) chaharBagh(K, [fr.u0, fr.u1, fr.v0, fr.v1])
        else serviceBand(K, fr.u0, fr.u1, fr.v0, fr.v1, false, 1)
      }
      const g = insetConvex(q, 2.5)
      if (g.length < 3) continue
      const fq = localBox(g, e)
      const g2 = insetConvex(g, 1.5)
      for (let u = fq.u0 + 3; u < fq.u1 - 2; u += 5.5)
        for (let v = fq.v0 + 3; v < fq.v1 - 2; v += 5.5) {
          const t = f.at(u, v)
          if (pointInPoly(t, g2)) tree(K, t, 1.6 + ctx.rng.next() * 0.7)
        }
      emitArea(ctx, 'greens', g, 'garden')
      emitArea(ctx, 'enclosures', g)
      ctx.occ.add(g)
      continue
    }
    if (b2.wid > 14) {
      const r = inscribedRect(insetConvex(q, 2), b2.axis, { minSide: 6 })
      if (r) {
        const g = localBox(r, b2.axis)
        const dep = Math.min(9, g.v1 - g.v0)
        for (let u = g.u0; u + 8 < g.u1; u += 16) put(K, g.box(u, Math.min(g.u1, u + 14), g.v0, g.v0 + dep), 'shed')
      }
      scatterTrees(ctx, q, 0.004, 2, 3.4)
    }
    emitArea(ctx, 'plazas', q)
  }
  // 宫门接上路
  connectGates(ctx, [wall])
  return true
}

/**
 * 穿过幕墙中间的小河、水渠（没登记成走廊、顶点又都在岸上时 clipWater 看不出来）：
 * 在幕墙里按格子找最近水的一点，沿离水的方向把那一侧切掉，切到里面都离水 4 米以上；剩下不到三成就放弃。
 */
function dry(ctx: Ctx, poly: Poly): Poly | null {
  const A0 = area(poly)
  let out = poly
  for (let pass = 0; pass < 6; pass++) {
    const b = obb(out)
    const g = localBox(out, b.axis)
    let wp: P | null = null
    let ww = 4
    for (let u = g.u0 + 2; u < g.u1; u += 5)
      for (let v = g.v0 + 2; v < g.v1; v += 5) {
        const q = g.box(u, u, v, v)[0]
        if (!pointInPoly(q, out)) continue
        const w = ctx.T.waterAt(q)
        if (w < ww) {
          ww = w
          wp = q
        }
      }
    if (!wp) return out
    const gr = ctx.T.waterGrad(wp)
    const L = dmath.hypot(gr[0], gr[1])
    if (L < 1e-6) return null
    const n: P = [gr[0] / L, gr[1] / L]
    out = clipHalf(out, add(wp, n, 4.5 - ww), [-n[0], -n[1]])
    if (out.length < 3 || area(out) < A0 * 0.3) return null
  }
  return out
}

/** 宫里的局部坐标：u 沿中轴（从门往里），v 横向 */
type Lay = ReturnType<typeof axes>
interface Kit {
  ctx: Ctx
  f: Lay
}
/** 局部坐标里的矩形 [u0, u1, v0, v1] */
type Box = [number, number, number, number]

/** 盖一座宫里的屋子（不占民居预算；两层的是住人的殿阁） */
const put = (K: Kit, poly: Poly, kind: BuildingKind) => place(K.ctx, poly, kind, { pad: 0.5 }, { floors: kind === 'large' ? 2 : 1, units: 0 })

/** 一排屋：沿长向切成几段（一段段屋顶），太薄的不盖 */
function range(K: Kit, [a, b, c, d]: Box, kind: BuildingKind, seg = 18) {
  if (b - a < 2 || d - c < 2) return
  const alongU = b - a >= d - c
  const L = alongU ? b - a : d - c
  const k = Math.max(1, Math.round(L / seg))
  for (let i = 0; i < k; i++) {
    const s0 = (L * i) / k
    const s1 = (L * (i + 1)) / k
    put(K, alongU ? K.f.box(a + s0, a + s1, c, d) : K.f.box(a, b, c + s0, c + s1), kind)
  }
}

/** 铺地（院子、巷子、渠岸） */
function pave(K: Kit, [a, b, c, d]: Box) {
  if (b - a < 0.4 || d - c < 0.4) return
  const p = K.f.box(a, b, c, d)
  emitArea(K.ctx, 'plazas', p)
  K.ctx.occ.add(p)
}

/** 花圃（铺地压在绿地上面：花圃与铺地不能叠） */
function bed(K: Kit, [a, b, c, d]: Box) {
  if (b - a < 0.8 || d - c < 0.8) return
  const p = K.f.box(a, b, c, d)
  emitArea(K.ctx, 'greens', p, 'garden')
  K.ctx.occ.add(p)
}

/** 种一棵树（先种树再登记花圃、铺地：树只躲开屋子） */
const tree = (K: Kit, p: P, r: number) => plantTree(K.ctx, p, r)

/** 成行成列的树（果园、花圃） */
function grove(K: Kit, [a, b, c, d]: Box, step: number, r0: number, r1: number) {
  if (b - a < 1 || d - c < 1) return
  const nu = Math.max(1, Math.floor((b - a) / step))
  const nv = Math.max(1, Math.floor((d - c) / step))
  const su = (b - a) / nu
  const sv = (d - c) / nv
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) tree(K, K.f.at(a + su * (i + 0.5), c + sv * (j + 0.5)), r0 + K.ctx.rng.next() * (r1 - r0))
}

/**
 * 四面的屋子围着一方院子：t 为 [前、后、两侧] 的进深，前面（u 小的一侧，朝门）开宽 gap 的门洞（0 为不开）。返回院子。
 */
function ring(K: Kit, [a, b, c, d]: Box, t: [number, number, number], kinds: [BuildingKind, BuildingKind, BuildingKind], gap = 0, seg = 18): Box {
  const [tf, tb, ts] = t
  const [kf, kb, ks] = kinds
  const vm = (c + d) / 2
  if (gap > 0) {
    range(K, [a, a + tf, c, vm - gap / 2], kf, seg)
    range(K, [a, a + tf, vm + gap / 2, d], kf, seg)
    pave(K, [a, a + tf, vm - gap / 2, vm + gap / 2])
  } else range(K, [a, a + tf, c, d], kf, seg)
  range(K, [b - tb, b, c, d], kb, seg)
  range(K, [a + tf, b - tb, c, c + ts], ks, seg)
  range(K, [a + tf, b - tb, d - ts, d], ks, seg)
  return [a + tf, b - tb, c + ts, d - ts]
}

// —————————————————————— 中轴的院子 ——————————————————————

type Court = 'divan' | 'myrtle' | 'lions' | 'riad' | 'kiosk' | 'harem'

/**
 * 中轴上一进进院子的语法（从门往里）：公共的院（议事院 / 园亭院 / 没有）→ 觐见的院（长院 / 议事院）
 * → 0 ~ 2 座私人的院（狮子院 / 里亚德花园院 / 园亭院）→ 后宫（可无）；有的宫是长院直接对着校场（觐见院在前）。
 * 以前的几种排法是预设：阿尔罕布拉、托普卡帕、非斯、马拉喀什。
 */
const PUBLIC: Elem<'divan' | 'kiosk' | 'none'>[] = [
  { id: 'divan', w: 3 },
  { id: 'kiosk', w: 1 },
  { id: 'none', w: 1 },
]
const AUDIENCE: Elem<'myrtle' | 'divan'>[] = [
  { id: 'myrtle', w: 3 },
  { id: 'divan', w: 1 },
]
const PRIVATE: Elem<'lions' | 'riad' | 'kiosk'>[] = [
  { id: 'lions', w: 2 },
  { id: 'riad', w: 2 },
  { id: 'kiosk', w: 1 },
]
const SPINE_PRESETS: Preset[] = [
  { id: 'alhambra', w: 3, bias: { public: { divan: 5 }, audience: { myrtle: 5 }, 'private.0': { lions: 5 }, harem: { yes: 4 } }, num: { privates: [1, 1] } },
  { id: 'topkapi', w: 1.5, bias: { public: { divan: 3 }, 'private.0': { kiosk: 5 }, 'private.1': { kiosk: 2, riad: 2 }, harem: { yes: 5 } }, num: { privates: [1, 2] } },
  { id: 'fez', w: 1.5, bias: { public: { none: 4 }, audience: { myrtle: 5 }, audienceFirst: { yes: 3 } }, num: { privates: [0, 0] } },
  { id: 'marrakech', w: 1.5, bias: { public: { divan: 4 }, 'private.0': { riad: 5 }, 'private.1': { riad: 5 } }, num: { privates: [2, 2] } },
]

/** 中轴从门往里一进进的院子：按语法抽（cityDice）；按中轴的长短取舍（先舍后宫，再舍私人的院、公共的院），深度按偏好分配 */
function spineCourts(K: Kit, a: number, b: number, c: number, d: number) {
  const ws = d - c
  const D = b - a
  const T = Math.max(4.5, Math.min(11, ws * 0.12))
  const C = composer(cityDice(K.ctx, 'qasr'), 'qasr', SPINE_PRESETS, { size: D, rank: 2 })
  const pub = C.pick('public', PUBLIC)
  const aud = C.pick('audience', AUDIENCE, { only: (x) => x !== pub })
  const np = C.int('privates', 0, 2)
  const priv = Array.from({ length: np }, (_, i) => C.pick(`private.${i}`, PRIVATE, { only: (x) => !(x === 'kiosk' && pub === 'kiosk') }))
  const hasHarem = C.chance('harem', 0.8)
  const audFirst = pub !== 'none' && C.chance('audienceFirst', 0.2)
  const head: Court[] = pub === 'none' ? [aud] : audFirst ? [aud, pub] : [pub, aud]
  const order: Court[] = [...head, ...priv, ...(hasHarem ? ['harem' as Court] : [])]
  const PREF: Record<Court, { pref: number; min: number; max: number }> = {
    divan: { pref: ws * 0.7 * C.num('divan', 0.8, 1.25), min: 24, max: ws * 1.1 },
    myrtle: { pref: ws * 1.25 * C.num('myrtle', 0.75, 1.3), min: 22, max: ws * 2.2 },
    lions: { pref: ws * 0.8 * C.num('lions', 0.8, 1.25), min: 24, max: ws * 1.1 },
    riad: { pref: ws * 0.7 * C.num('riad', 0.8, 1.2), min: 22, max: ws * 1 },
    kiosk: { pref: ws * 0.9 * C.num('kiosk', 0.8, 1.2), min: 24, max: ws * 1.3 },
    harem: { pref: Math.max(24, ws * 0.8), min: 20, max: Infinity },
  }
  // 放不下时先舍后宫，再从后往前舍私人的院，再舍公共的院；觐见的院不舍
  const drop = (k: Court, i: number) => (k === 'harem' ? 0 : k === aud && i < head.length ? undefined : i < head.length ? 10 : 5 - i * 0.1)
  const gap = 3
  const items = order.map((k, i) => ({ ...PREF[k], drop: drop(k, i) }))
  const hi = order.indexOf('harem')
  const { keep, len } = allot(items, D, gap, hi >= 0 ? hi : order.indexOf(aud))
  if (keep.length < order.length) C.note('kept', keep.map((i) => order[i]).join('-'))
  let u = a
  keep.forEach((j, i) => {
    const k = order[j]
    const bx: Box = [u, u + len[i], c, d]
    if (k === 'divan') divan(K, bx, T)
    else if (k === 'myrtle') myrtle(K, bx, T)
    else if (k === 'lions') lions(K, bx, T)
    else if (k === 'riad') lions(K, bx, T, false)
    else if (k === 'kiosk') kioskCourt(K, bx, T)
    else harem(K, bx)
    u += len[i]
    if (i < keep.length - 1) pave(K, [u, u + gap, c, d])
    u += gap
  })
  C.done(K.f.at((a + b) / 2, (c + d) / 2))
}

/** 园亭院（托普卡帕的内院）：一圈矮墙，院里成行的树，当中一座方亭（köşk），尽头一排殿 */
function kioskCourt(K: Kit, [a, b, c, d]: Box, T: number) {
  const vm = (c + d) / 2
  const th = Math.max(6, Math.min(T * 1.2, (b - a) * 0.22))
  range(K, [b - th, b, c, d], 'large', 20)
  emitArea(K.ctx, 'enclosures', K.f.box(a, b - th, c, d))
  const g: Box = [a + 1.5, b - th - 1.5, c + 1.5, d - 1.5]
  const um = (g[0] + g[1]) / 2
  const ps = Math.min(9, (g[1] - g[0]) * 0.18, (g[3] - g[2]) * 0.18)
  if (ps > 3) put(K, K.f.box(um - ps, um + ps, vm - ps, vm + ps), 'hall')
  grove(K, g, 6, 1.8, 2.6)
  bed(K, g)
  pave(K, [a, b - th, c, c + 1.5])
  pave(K, [a, b - th, d - 1.5, d])
}

/** 议事院（divan / mashwar）：一圈回廊，中门两侧一对塔，尽头是接见大殿，大殿正中凸出一座穹顶殿 */
function divan(K: Kit, [a, b, c, d]: Box, T: number) {
  const vm = (c + d) / 2
  const th = Math.max(8, Math.min(T * 1.6, (b - a) * 0.3))
  const q = Math.min(th + 4, (d - c) * 0.3)
  // 穹顶殿（qubba）先盖，大殿分在两边
  put(K, K.f.box(b - th - 4, b, vm - q / 2, vm + q / 2), 'keep')
  range(K, [b - th, b, c, vm - q / 2], 'hall', 22)
  range(K, [b - th, b, vm + q / 2, d], 'hall', 22)
  // 中门（Bab as-Salam）两侧的塔
  const tt = Math.min(7, T + 1)
  put(K, K.f.box(a, a + tt, vm - 3 - tt, vm - 3), 'tower')
  put(K, K.f.box(a, a + tt, vm + 3, vm + 3 + tt), 'tower')
  const ct = ring(K, [a, b - th, c, d], [T * 0.8, 0, T * 0.7], ['hall', 'hall', 'hall'], 6 + 2 * tt, 16)
  // 院里两行悬铃木，院心水泉
  const [ca, cb, cc, cd] = ct
  if (cd - cc > 30 && cb - ca > 20) for (const v of [cc + 5, cd - 5]) for (let u = ca + 5; u < cb - 4; u += 7) tree(K, K.f.at(u, v), 2 + K.ctx.rng.next() * 0.6)
  if (cb - ca > 12) K.ctx.out.landmarks.push({ p: K.f.at((ca + cb) / 2, vm), kind: 'fountain' })
  pave(K, ct)
}

/** 长院（桃金娘院）：两侧是两层的殿阁，中间一条长水池，池边两道绿篱，尽头一座高塔（觐见厅） */
function myrtle(K: Kit, [a, b, c, d]: Box, T: number) {
  const vm = (c + d) / 2
  const ts = Math.min(T * 1.1, (d - c) * 0.2)
  const tb = Math.max(5, Math.min(T * 1.2, (b - a) * 0.2))
  const k = Math.min((d - c) * 0.38, T * 2.6, (b - a) * 0.4)
  const p = Math.min(4, k * 0.3)
  // 觐见塔先盖，后排殿阁分在两边
  const tw = put(K, K.f.box(b - tb - p, b, vm - k / 2, vm + k / 2), 'keep')
  const kv = tw ? k / 2 : 0
  range(K, [b - tb, b, c, vm - kv], 'hall', 22)
  range(K, [b - tb, b, vm + kv, d], 'hall', 22)
  // 侧翼厚的分两层：外侧殿阁，内侧柱廊
  const tf = Math.min(T * 0.6, (b - a) * 0.12)
  for (const [s0, s1, sg] of [[c, c + ts, 1], [d - ts, d, -1]] as const) {
    if (ts > 8) {
      const o = ts * 0.62
      range(K, sg > 0 ? [a, b - tb, s0, s0 + o] : [a, b - tb, s1 - o, s1], 'large', 18)
      range(K, sg > 0 ? [a + tf, b - tb, s0 + o, s1] : [a + tf, b - tb, s0, s1 - o], 'hall', 18)
    } else range(K, [a, b - tb, s0, s1], 'large', 18)
  }
  range(K, [a, a + tf, c + ts, vm - 2.5], 'hall', 16)
  range(K, [a, a + tf, vm + 2.5, d - ts], 'hall', 16)
  pave(K, [a, a + tf, vm - 2.5, vm + 2.5])
  // 院子：觐见塔凸进来的一截铺地，其余是水池院；院子横宽时水池顺着横向
  const cb0 = b - tb - (tw ? p : 0)
  if (tw) pave(K, [cb0, b - tb, c + ts, d - ts])
  const ct: Box = [a + tf, cb0, c + ts, d - ts]
  if (ct[3] - ct[2] > (ct[1] - ct[0]) * 1.15) poolCourt({ ctx: K.ctx, f: axes(K.f.n) }, [ct[2], ct[3], -ct[1], -ct[0]])
  else poolCourt(K, ct)
}

/** 水池院：顺着 u 一条长水池，池边两道绿篱，两边铺地（宽的院子铺地上再种两行橘树） */
function poolCourt(K: Kit, [ca, cb, cc, cd]: Box) {
  const vm = (cc + cd) / 2
  const cw = cd - cc
  const pw = Math.max(3, Math.min(14, cw * 0.28))
  const h = Math.max(1.2, Math.min(3, cw * 0.06))
  const e0 = ca + Math.min(3.5, (cb - ca) * 0.1)
  const e1 = cb - Math.min(3.5, (cb - ca) * 0.1)
  if (cw > 12 && e1 - e0 > 8) {
    const pool = K.f.box(e0, e1, vm - pw / 2, vm + pw / 2)
    if (cw > 40) for (const v of [cc + (vm - pw / 2 - h - cc) / 2, cd - (cd - vm - pw / 2 - h) / 2]) for (let u = e0 + 3; u < e1 - 2; u += 6.5) tree(K, K.f.at(u, v), 1.5 + K.ctx.rng.next() * 0.4)
    // 绿篱：修剪成一溜矮丛
    for (const v of [vm - pw / 2 - h / 2, vm + pw / 2 + h / 2]) for (let u = e0 + 1; u < e1 - 0.5; u += Math.max(1.6, h * 1.1)) K.ctx.out.trees.push({ p: K.f.at(u, v), r: h * 0.55 })
    bed(K, [e0, e1, vm - pw / 2 - h, vm - pw / 2])
    bed(K, [e0, e1, vm + pw / 2, vm + pw / 2 + h])
    pave(K, [e0, e1, vm - pw / 2, vm + pw / 2])
    // 池沿：两道线
    emitArea(K.ctx, 'enclosures', pool)
    if (pw > 4) emitArea(K.ctx, 'enclosures', K.f.box(e0 + 0.7, e1 - 0.7, vm - pw / 2 + 0.7, vm + pw / 2 - 0.7))
    if (pw > 5 && e1 - e0 > 30) for (const u of [e0 + 2.5, e1 - 2.5]) K.ctx.out.landmarks.push({ p: K.f.at(u, vm), kind: 'fountain' })
    pave(K, [ca, e0, cc, cd])
    pave(K, [e1, cb, cc, cd])
    pave(K, [e0, e1, cc, vm - pw / 2 - h])
    pave(K, [e0, e1, vm + pw / 2 + h, cd])
  } else pave(K, [ca, cb, cc, cd])
}

/** 狮子院：一圈柱廊，两头各一座凸进院里的小亭；十字水渠把院子分成四块花圃，院心水泉 */
/** 狮子院；pav 为 false 时是里亚德花园院（一圈住屋围着四块花圃，没有两头的小亭） */
function lions(K: Kit, [a, b, c, d]: Box, T: number, pav = true) {
  const vm = (c + d) / 2
  const t = Math.min(T * 0.9, (d - c) * 0.18, (b - a) * 0.18)
  const ct = ring(K, [a, b, c, d], [t, t, t], pav ? ['hall', 'large', 'hall'] : ['large', 'large', 'large'], pav ? 5 : 3, 14)
  const [ca, cb, cc, cd] = ct
  const cw = cd - cc
  const ch = cb - ca
  if (cw < 8 || ch < 8) {
    pave(K, ct)
    return
  }
  // 两头的小亭
  const pd = pav ? Math.min(6, ch * 0.14) : 0
  const pw = cw * 0.3
  if (pav) {
    put(K, K.f.box(ca, ca + pd, vm - pw / 2, vm + pw / 2), 'large')
    put(K, K.f.box(cb - pd, cb, vm - pw / 2, vm + pw / 2), 'large')
  }
  const bw = Math.max(1.5, Math.min(4, cw * 0.08))
  const w = Math.max(1, Math.min(2.2, cw * 0.05))
  const um = (ca + cb) / 2
  const g: Box = [ca + bw + pd, cb - bw - pd, cc + bw, cd - bw]
  const quads: Box[] = [
    [g[0], um - w, g[2], vm - w],
    [um + w, g[1], g[2], vm - w],
    [g[0], um - w, vm + w, g[3]],
    [um + w, g[1], vm + w, g[3]],
  ]
  for (const q of quads) grove(K, [q[0] + 0.8, q[1] - 0.8, q[2] + 0.8, q[3] - 0.8], 4.5, 1.1, 1.5)
  for (const q of quads) bed(K, q)
  pave(K, [g[0], g[1], vm - w, vm + w])
  pave(K, [um - w, um + w, g[2], vm - w])
  pave(K, [um - w, um + w, vm + w, g[3]])
  pave(K, [ca, g[0], cc, cd])
  pave(K, [g[1], cb, cc, cd])
  pave(K, [g[0], g[1], cc, g[2]])
  pave(K, [g[0], g[1], g[3], cd])
  K.ctx.out.landmarks.push({ p: K.f.at(um, vm), kind: 'fountain' })
}

/** 后宫：一格格的小内院住宅（院里种树），格子之间是窄巷，偶有一格是小花园 */
function harem(K: Kit, [a, b, c, d]: Box) {
  const rng = K.ctx.rng
  const g = 2.4
  const nu = Math.max(1, Math.round((b - a) / 24))
  const nv = Math.max(1, Math.round((d - c) / 24))
  const cu = (b - a - g * (nu - 1)) / nu
  const cv = (d - c - g * (nv - 1)) / nv
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const bx: Box = [a + i * (cu + g), a + i * (cu + g) + cu, c + j * (cv + g), c + j * (cv + g) + cv]
      const m = Math.min(cu, cv)
      if (m < 11) {
        range(K, bx, 'large', 14)
        continue
      }
      if (rng.next() < 0.15) {
        // 小花园：一方花圃，成行的树
        grove(K, [bx[0] + 1, bx[1] - 1, bx[2] + 1, bx[3] - 1], 4.2, 1.3, 1.9)
        bed(K, bx)
        continue
      }
      const t = Math.max(3.5, Math.min(6.5, m * 0.26))
      const ct = ring(K, bx, [t, t, t], ['large', 'large', 'large'], 0, 12)
      const [ca, cb, cc, cd] = ct
      if (cb - ca > 4 && cd - cc > 4) {
        const w = Math.min(cb - ca, cd - cc)
        for (const [du, dv] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) tree(K, K.f.at(ca + (cb - ca) * du, cc + (cd - cc) * dv), Math.min(2.2, w * 0.18))
        bed(K, ct)
      }
    }
  for (let i = 1; i < nu; i++) pave(K, [a + i * (cu + g) - g, a + i * (cu + g), c, d])
  for (let j = 1; j < nv; j++) pave(K, [a, b, c + j * (cv + g) - g, c + j * (cv + g)])
}

// —————————————————————— 服务区 ——————————————————————

/**
 * 服务区：从门往里依次是清真寺（带浴场）、御膳房、马厩、库房，一片片隔着窄巷；
 * 服务区宽时分成几列（一列清真寺打头，一列浴场打头），免得一片马厩、库房铺得太宽。
 * only 为真时只盖清真寺与浴场（两条带的宫城，服务区只占靠门的一段）。
 */
function serviceBand(K: Kit, a: number, b: number, c: number, d: number, only: boolean, first = 0) {
  const lane = 3
  const cols = only ? 1 : Math.max(1, Math.round((d - c) / 50))
  const cw = (d - c - lane * (cols - 1)) / cols
  const SEQ: Service[][] = [
    ['mosque', 'kitchen', 'stable', 'store'],
    ['hammam', 'store', 'kitchen', 'stable'],
    ['store', 'stable', 'store', 'kitchen'],
  ]
  for (let j = 0; j < cols; j++) {
    const c0 = c + j * (cw + lane)
    if (j > 0) pave(K, [a, b, c0 - lane, c0])
    serviceColumn(K, a, b, c0, c0 + cw, only ? ['mosque'] : SEQ[(j + first) % SEQ.length], only)
  }
}

type Service = 'mosque' | 'hammam' | 'kitchen' | 'stable' | 'store'

/** 服务区的一列：按顺序一片片往里盖（顺序用完从第二项起轮着来），剩下不够一片的并进最后一片 */
function serviceColumn(K: Kit, a: number, b: number, c: number, d: number, seq: Service[], only: boolean) {
  const W = d - c
  const gap = 3
  let u = a
  for (let i = 0; b - u >= 16; i++) {
    const k = i < seq.length ? seq[i] : seq[1 + ((i - 1) % (seq.length - 1 || 1))]
    const rest = b - u
    let dep = k === 'mosque' ? Math.max(22, Math.min(60, W * 0.85)) : Math.max(22, Math.min(50, W * 0.65))
    if (only || rest - dep - gap < 22) dep = rest
    const bx: Box = [u, u + dep, c, d]
    if (k === 'mosque') mosqueWithBath(K, bx)
    else if (k === 'hammam') hammam(K, bx)
    else if (k === 'kitchen') kitchens(K, bx)
    else if (k === 'stable') stables(K, bx)
    else stores(K, bx)
    u += dep
    if (u + gap < b) pave(K, [u, u + gap, c, d])
    u += gap
    if (only) break
  }
}

/** 宫里的清真寺；片区宽出来的一截是浴场，深出来的一截是御膳房 */
function mosqueWithBath(K: Kit, [a, b, c, d]: Box) {
  const D = b - a
  const mw = Math.min(d - c, Math.max(20, Math.min(56, D * 1.05)))
  const mu = Math.min(b, a + Math.min(D, mw * 1.1))
  mosque(K, [a, mu, c, c + mw])
  if (mu < b - 12) kitchens(K, [mu + 3, b, c, c + mw])
  else if (mu < b) pave(K, [mu, b, c, c + mw])
  if (d - (c + mw) > 14) hammam(K, [a, b, c + mw + 3, d])
  else pave(K, [a, b, c + mw, d])
}

/** 宫里的清真寺：顺着宫殿的轴线，礼拜殿朝向就近取四个方向之一；三面回廊围着庭院，背面一角是宣礼塔 */
function mosque(K: Kit, bx: Box) {
  const { ctx, f } = K
  const q = st(ctx).qibla
  const dirs: P[] = [f.e, [-f.e[0], -f.e[1]], f.n, [-f.n[0], -f.n[1]]]
  let qd = dirs[0]
  for (const dd of dirs) if (dd[0] * q[0] + dd[1] * q[1] > qd[0] * q[0] + qd[1] * q[1]) qd = dd
  const g = localBox(f.box(...bx), qd)
  const [a, b, c, d] = [g.u0, g.u1, g.v0, g.v1]
  const D = b - a
  const Wd = d - c
  if (D < 14 || Wd < 14) {
    pave(K, bx)
    return
  }
  const hd = D * 0.45
  const ar = Math.max(3, Math.min(6, Wd * 0.1))
  const mt = Math.max(4.5, Math.min(8, Wd * 0.13))
  const vm = (c + d) / 2
  const parts: [Poly, BuildingKind][] = [
    [g.box(b - hd, b, c, d), 'temple'],
    [circlePoly(g.box(b - hd * 0.45, b, vm, vm)[0], Math.min(hd * 0.3, Wd * 0.14), 16), 'temple'],
    [g.box(a, a + ar, c, d), 'temple'],
    [g.box(a + ar, b - hd, c, c + ar), 'temple'],
    [g.box(a + ar, b - hd, d - ar, d), 'temple'],
    [g.box(a, a + mt, d - mt, d), 'tower'],
  ]
  if (!addGroup(ctx, parts, 0.5)) {
    pave(K, bx)
    return
  }
  const sahn = g.box(a + ar, b - hd, c + ar, d - ar)
  emitArea(ctx, 'plazas', sahn)
  ctx.occ.add(sahn)
  if (area(sahn) > 100) ctx.out.landmarks.push({ p: centroid(sahn), kind: 'fountain' })
}

/** 浴场：一座长屋，屋顶一排圆穹；其余是库房与烧火的院子 */
function hammam(K: Kit, [a, b, c, d]: Box) {
  const { ctx, f } = K
  const D = b - a
  const hd = Math.min(D * 0.55, 30)
  const hw = Math.min(d - c, 22)
  const parts: [Poly, BuildingKind][] = [[f.box(a, a + hd, c, c + hw), 'civic']]
  const nd = Math.max(1, Math.round(hd / 8))
  for (let k = 0; k < nd; k++) parts.push([circlePoly(f.at(a + (hd * (k + 0.5)) / nd, c + hw / 2), Math.min(hw * 0.22, (hd / nd) * 0.35), 12), 'civic'])
  if (addGroup(ctx, parts, 0.5)) poi(ctx, f.at(a + hd / 2, c + hw / 2), ctx.namer.islamic('hammam'))
  if (b - (a + hd) > 12) stores(K, [a + hd + 2.5, b, c, c + hw])
  else pave(K, [a + hd, b, c, c + hw])
  if (d - (c + hw) > 10) stores(K, [a, b, c + hw + 2.5, d])
  else pave(K, [a, b, c + hw, d])
}

/** 御膳房：一排带圆顶（烟囱）的灶房，对面是库房，中间是铺地的院子，院里几座小灶 */
function kitchens(K: Kit, [a, b, c, d]: Box) {
  const { ctx, f } = K
  const t = Math.max(5, Math.min(10, Math.min(b - a, d - c) * 0.22))
  const n = Math.max(1, Math.round((b - a) / 9))
  const s = (b - a) / n
  for (let k = 0; k < n; k++) {
    const u = a + k * s
    addGroup(
      ctx,
      [
        [f.box(u, u + s, c, c + t), 'large'],
        [circlePoly(f.at(u + s / 2, c + t / 2), Math.min(s, t) * 0.28, 10), 'civic'],
      ],
      0.5,
    )
  }
  range(K, [a, b, d - t * 0.8, d], 'shed', 12)
  range(K, [a, a + t * 0.7, c + t, d - t * 0.8], 'large', 14)
  range(K, [b - t * 0.7, b, c + t, d - t * 0.8], 'shed', 14)
  const yard: Box = [a + t * 0.7, b - t * 0.7, c + t, d - t * 0.8]
  if (yard[1] - yard[0] > 14 && yard[3] - yard[2] > 10) for (const du of [0.3, 0.7]) put(K, f.box(yard[0] + (yard[1] - yard[0]) * du - 2, yard[0] + (yard[1] - yard[0]) * du + 2, yard[3] - 5, yard[3] - 1), 'shed')
  pave(K, yard)
  emitArea(ctx, 'enclosures', f.box(...yard))
}

/** 马厩：两排长长的马房夹着一片围起来的场院，尽头是马夫住的屋，场院里一道水槽 */
function stables(K: Kit, [a, b, c, d]: Box) {
  const { ctx, f } = K
  const t = Math.max(5, Math.min(8, (d - c) * 0.18))
  range(K, [a, b, c, c + t], 'shed', 16)
  range(K, [a, b, d - t, d], 'shed', 16)
  range(K, [b - t, b, c + t, d - t], 'large', 16)
  const yard: Box = [a, b - t, c + t, d - t]
  const vm = (yard[2] + yard[3]) / 2
  // 宽的场院当中再一排马房，窄的只一道水槽
  const [yu, yv] = [yard[1] - yard[0], yard[3] - yard[2]]
  const um = (yard[0] + yard[1]) / 2
  if (Math.min(yu, yv) > 24) range(K, yu >= yv ? [yard[0] + 6, yard[1] - 6, vm - t / 2, vm + t / 2] : [um - t / 2, um + t / 2, yard[2] + 6, yard[3] - 6], 'shed', 16)
  else if (yard[1] - yard[0] > 16 && yard[3] - yard[2] > 8) put(K, f.box(yard[0] + 4, yard[1] - 4, vm - 0.8, vm + 0.8), 'shed')
  pave(K, yard)
  emitArea(ctx, 'enclosures', f.box(...yard))
}

/** 库房（makhzen）：一排排长仓房，中间是窄巷 */
function stores(K: Kit, [a, b, c, d]: Box) {
  const alongU = b - a >= d - c
  const dep = 8
  const lane = 3
  const L = alongU ? d - c : b - a
  const n = Math.max(1, Math.floor((L + lane) / (dep + lane)))
  const dd = (L - lane * (n - 1)) / n
  for (let k = 0; k < n; k++) {
    const s0 = k * (dd + lane)
    range(K, alongU ? [a, b, c + s0, c + s0 + dd] : [a + s0, a + s0 + dd, c, d], k % 2 ? 'shed' : 'large', 16)
    if (k < n - 1) pave(K, alongU ? [a, b, c + s0 + dd, c + s0 + dd + lane] : [a + s0 + dd, a + s0 + dd + lane, c, d])
  }
}

// —————————————————————— 御园 ——————————————————————

/** 御园：一座座四分园沿中轴排开，够大的片与四分园轮着是果园（agdal）与大水池 */
function gardenBand(K: Kit, a: number, b: number, c: number, d: number) {
  const W = d - c
  const gap = 3
  let u = a
  let n = 0
  while (b - u >= 14) {
    const rest = b - u
    let dep = Math.min(rest, Math.max(24, W * 1.05))
    if (rest - dep - gap < 24) dep = rest
    if (n % 2 === 1 && dep * W > 2800) orchardPool(K, [u, u + dep, c, d])
    else chaharBagh(K, [u, u + dep, c, d])
    u += dep
    if (u + gap < b) pave(K, [u, u + gap, c, d])
    u += gap
    n++
  }
}

/**
 * 四分园（chahar-bagh）：一圈园墙，里面一圈园路；两条十字交叉的水渠（铺石的渠岸）把园子分成四块（大园子八块），
 * 每块成行种果树（石榴、柑橘、柏树），十字交汇处一座凉亭，渠的四端各有一眼水泉。
 */
function chaharBagh(K: Kit, [a, b, c, d]: Box) {
  const { ctx, f } = K
  const D = b - a
  const Wd = d - c
  if (D < 10 || Wd < 10) {
    grove(K, [a, b, c, d], 4.5, 1.4, 2)
    bed(K, [a, b, c, d])
    return
  }
  const um = (a + b) / 2
  const vm = (c + d) / 2
  const m = Math.min(D, Wd)
  const w = Math.max(1.4, Math.min(3.5, m * 0.035))
  const walk = Math.max(1.2, Math.min(3, m * 0.03))
  emitArea(ctx, 'enclosures', f.box(a, b, c, d))
  const pv = Math.min(18, m * 0.16)
  const pav = m > 30 && put(K, f.box(um - pv / 2, um + pv / 2, vm - pv / 2, vm + pv / 2), 'hall')
  const quads: Box[] = []
  const split = m > 70
  for (const [qa, qb] of [[a + walk, um - w], [um + w, b - walk]])
    for (const [qc, qd] of [[c + walk, vm - w], [vm + w, d - walk]]) {
      if (split) {
        const qm = (qa + qb) / 2
        const w2 = w * 0.5
        quads.push([qa, qm - w2, qc, qd], [qm + w2, qb, qc, qd])
        pave(K, [qm - w2, qm + w2, qc, qd])
      } else quads.push([qa, qb, qc, qd])
    }
  const step = m > 60 ? 5 : 4.5
  for (const q of quads) grove(K, [q[0] + 0.6, q[1] - 0.6, q[2] + 0.6, q[3] - 0.6], step, 1.4, 2.1)
  for (const q of quads) bed(K, q)
  pave(K, [a + walk, b - walk, vm - w, vm + w])
  pave(K, [um - w, um + w, c + walk, vm - w])
  pave(K, [um - w, um + w, vm + w, d - walk])
  pave(K, [a, a + walk, c, d])
  pave(K, [b - walk, b, c, d])
  pave(K, [a + walk, b - walk, c, c + walk])
  pave(K, [a + walk, b - walk, d - walk, d])
  if (!pav) ctx.out.landmarks.push({ p: f.at(um, vm), kind: 'fountain' })
  if (m > 55) for (const [u, v] of [[a + walk + 3.5, vm], [b - walk - 3.5, vm], [um, c + walk + 3.5], [um, d - walk - 3.5]]) ctx.out.landmarks.push({ p: f.at(u, v), kind: 'fountain' })
}

/** 果园（agdal）：园墙里一方方密密的果树（橄榄、柑橘），当中一方蓄水的大池，池边一座凉亭 */
function orchardPool(K: Kit, [a, b, c, d]: Box) {
  const { ctx, f } = K
  const um = (a + b) / 2
  const vm = (c + d) / 2
  const pu = Math.min((b - a) * 0.4, 70)
  const pw = Math.min((d - c) * 0.4, 50)
  const pool: Box = [um - pu / 2, um + pu / 2, vm - pw / 2, vm + pw / 2]
  const walk = 3
  emitArea(ctx, 'enclosures', f.box(a, b, c, d))
  const pv = Math.min(14, pw * 0.4)
  put(K, f.box(pool[1] + 0.5, pool[1] + walk - 0.5 + pv * 0.6, vm - pv / 2, vm + pv / 2), 'hall')
  const cells: Box[] = [
    [a + 1.5, pool[0] - walk, c + 1.5, d - 1.5],
    [pool[1] + walk, b - 1.5, c + 1.5, d - 1.5],
    [pool[0] - walk, pool[1] + walk, c + 1.5, pool[2] - walk],
    [pool[0] - walk, pool[1] + walk, pool[3] + walk, d - 1.5],
  ]
  for (const q of cells) if (q[1] - q[0] > 3 && q[3] - q[2] > 3) grove(K, q, 4.2, 1.5, 2.2)
  for (const q of cells) bed(K, q)
  pave(K, [pool[0] - walk, pool[1] + walk, pool[2] - walk, pool[3] + walk])
  pave(K, [a, b, c, c + 1.5])
  pave(K, [a, b, d - 1.5, d])
  pave(K, [a, a + 1.5, c + 1.5, d - 1.5])
  pave(K, [b - 1.5, b, c + 1.5, d - 1.5])
  emitArea(ctx, 'enclosures', f.box(...pool))
  for (const u of [pool[0] + 4, pool[1] - 4]) ctx.out.landmarks.push({ p: f.at(u, vm), kind: 'fountain' })
}
