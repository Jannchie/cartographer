import { addRoad } from '../roads'
import { clamp } from '../../gen/util'
import type { CultureStyle } from '../culture'
import { centerDist, cityDice, clipWater, hashAt, isFree, memo, placeable, siteDice, whereOf, mark, type Ctx } from '../ctx'
import { composer, type Composer, type Elem, type Preset } from '../compose/core'
import { area, at, box, centroid, circlePoly, dist, extent, insetConvex, obb, pointInPoly, rect, segDist, splitConvex, unit, type Frame, type P, type Poly } from '../geom'
import { buke, jiin, machiya, put, rampart, tenshu } from '../plans/jokamachi-build'
import { isVillage, townShare } from '../scale'
import type { BuildingKind, Ward } from '../types'
import { addBuilding, addGroup, eastCompound, inside, place, plantTree, scatterTrees, urban } from '../wards'
import { drop } from '../undo'

/**
 * 和风：有机生长的日本城镇（城下町规划区以外、或不用规划的城）也按日本的样子盖——
 * 民居、商人、工匠、市是沿街的町家，贵族区是武家屋敷，宗教区是寺院或神社，城堡是石垣与堀围着的天守，
 * 都城是御所；广场是广小路 / 火除地或市，园林是庭园。
 */
export const wa: CultureStyle = {
  // 平安京的坊里是町家（面宽窄、进深长）
  plotFill(ctx, plot, type) {
    machiya(ctx, plot, null, type)
    return true
  },
  buildWard(ctx, ward, block) {
    switch (ward.type) {
      case 'common':
      case 'merchant':
      case 'craft':
      case 'slum':
      case 'market':
      case 'suburb':
        machiWard(ctx, ward, block)
        return true
      case 'noble':
        // 城里的大宅院地块大（上级武士），小城镇是普通的武家屋敷
        buke(ctx, block, null, ctx.p.size === 'city')
        return true
      case 'temple':
        return templeWard(ctx, ward, block)
      case 'castle':
        // 条坊（平安京、大宰府）的城心是御所或国衙政厅；天守是战国以后城下町的东西
        if (ctx.plan?.def.id === 'lifang') return (!!ctx.p.capital && gosho(ctx, block)) || kokuga(ctx, block)
        return ctx.p.capital ? gosho(ctx, block) || shiro(ctx, block) : shiro(ctx, block)
      case 'plaza':
        hirokoji(ctx, block)
        return true
      default:
        return false
    }
  },
}

const small = (ctx: Ctx) => isVillage(ctx.p.size)

// —————————————————————— 小工具 ——————————————————————

/** 点落在路上（只看道路，不算河与堀） */
const onRoad = (ctx: Ctx, q: P) => ctx.corridors.hitsPoly(circlePoly(q, 0.6, 4), 0, ['road'])

/**
 * 街区的正面：临街（边外几米就是路）的最长一条边；没有临街边就取最长边。
 * 返回边的起点、方向 u 与朝里的法向 n。
 */
function frontOf(ctx: Ctx, poly: Poly): { a: P; u: P; n: P; L: number; street: boolean } {
  const c = centroid(poly)
  let best: { a: P; u: P; n: P; L: number; street: boolean } | null = null
  let bs = -Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const L = dist(a, b)
    if (L < 1) continue
    const u = unit([b[0] - a[0], b[1] - a[1]])
    let n: P = [-u[1], u[0]]
    const m: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    if ((c[0] - m[0]) * n[0] + (c[1] - m[1]) * n[1] < 0) n = [-n[0], -n[1]]
    const street = onRoad(ctx, [m[0] - n[0] * 4, m[1] - n[1] * 4])
    const s = (street ? 1000 : 0) + L
    if (s > bs) {
      bs = s
      best = { a, u, n, L, street }
    }
  }
  return best!
}

/**
 * 区域里顺着标架（f 朝里、l 横向）的最大矩形：试几种长宽比（限在 maxRatio 以内）与几个中心，
 * 每种二分出四角都还在区域里的最大尺寸，取面积最大的。返回标架与 a、b 两个方向上的范围。
 */
function fitRect(zone: Poly, f: P, maxRatio = 1.5): { F: Frame; a0: number; a1: number; b0: number; b1: number } | null {
  const l: P = [-f[1], f[0]]
  const c = centroid(zone)
  const F: Frame = { o: c, f, l }
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
  const span = Math.max(a1 - a0, b1 - b0)
  let best: { F: Frame; a0: number; a1: number; b0: number; b1: number } | null = null
  let ba = 0
  const ratios = [1, 1.2, 1 / 1.2, 1.45, 1 / 1.45, 1.8, 1 / 1.8].filter((r) => r <= maxRatio + 1e-6 && 1 / r <= maxRatio + 1e-6)
  for (const r of ratios)
    for (const du of [0, -0.1, 0.1, -0.2, 0.2])
      for (const dv of [0, -0.1, 0.1, -0.2, 0.2]) {
        const ac = du * (a1 - a0)
        const bc = dv * (b1 - b0)
        // 半边长：a 向 h·√r，b 向 h/√r
        const fits = (h: number) => box(F, ac - h * Math.sqrt(r), ac + h * Math.sqrt(r), bc - h / Math.sqrt(r), bc + h / Math.sqrt(r)).every((v) => pointInPoly(v, zone))
        if (!fits(1)) continue
        let lo = 1
        let hi = span
        for (let it = 0; it < 14; it++) {
          const m = (lo + hi) / 2
          if (fits(m)) lo = m
          else hi = m
        }
        if (lo * lo > ba) {
          ba = lo * lo
          const ha = lo * Math.sqrt(r)
          const hb = lo / Math.sqrt(r)
          best = { F, a0: ac - ha, a1: ac + ha, b0: bc - hb, b1: bc + hb }
        }
      }
  return best
}

/** 区域与标架里横向位置 b 处纵线的交段（a 的范围） */
function chord(zone: Poly, F: Frame, b: number): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  const loc = zone.map((v): P => [(v[0] - F.o[0]) * F.f[0] + (v[1] - F.o[1]) * F.f[1], (v[0] - F.o[0]) * F.l[0] + (v[1] - F.o[1]) * F.l[1]])
  for (let i = 0; i < loc.length; i++) {
    const p = loc[i]
    const q = loc[(i + 1) % loc.length]
    if ((p[1] - b) * (q[1] - b) > 0 || p[1] === q[1]) continue
    const a = p[0] + ((q[0] - p[0]) * (b - p[1])) / (q[1] - p[1])
    lo = Math.min(lo, a)
    hi = Math.max(hi, a)
  }
  return hi > lo ? [lo, hi] : null
}

/** 一条自己修的小路（登城路、参道、路地） */
function path(ctx: Ctx, line: P[], w: number, kind: 'street' | 'lane' | 'path' = 'street') {
  addRoad(ctx, { line, width: w, kind }, 0.8)
}

// —————————————————————— 町家 ——————————————————————

/** 大街区中间开一条横穿的小路（町割的"通り"），切成两半再各自沿街排町家 */
function splitBlock(ctx: Ctx, block: Poly, depth = 0): Poly[] {
  const b = obb(block)
  if (depth >= 2 || area(block) < 9000 || b.wid < 55) return [block]
  const dir: P = [-b.axis[1], b.axis[0]]
  const t = (hashAt(ctx, b.center, 'wa.machi.skew', depth) - 0.5) * 0.2
  const o: P = [b.center[0] + b.axis[0] * t * b.len, b.center[1] + b.axis[1] * t * b.len]
  const gap = 4
  const halves = splitConvex(block, o, dir, gap)
  if (halves.some((h) => h.length < 3 || area(h) < 1500)) return [block]
  // 小路：沿切线穿过整个街区，两端各伸出一点接上外面的街
  const ext = b.wid / 2 + 6
  const line: P[] = [
    [o[0] - dir[0] * ext, o[1] - dir[1] * ext],
    [o[0] + dir[0] * ext, o[1] + dir[1] * ext],
  ]
  // 只有两端都接上街时才修；否则只留一道缝（背割）
  const ends = line.map((q) => ctx.corridors.hits(q, 2) || ctx.T.waterAt(q) < 2)
  if (ends.every(Boolean)) {
    const clipped = clipLine(line, insetConvex(block, -3))
    if (clipped) path(ctx, clipped, 3, 'lane')
  }
  return halves.flatMap((h) => splitBlock(ctx, h, depth + 1))
}

/** 线段裁到凸多边形里 */
function clipLine(line: [P, P] | P[], poly: Poly): P[] | null {
  const [p, q] = line
  let t0 = 0
  let t1 = 1
  const d: P = [q[0] - p[0], q[1] - p[1]]
  const c = centroid(poly)
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    let n: P = [-(b[1] - a[1]), b[0] - a[0]]
    if ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]]
    // 内侧：(x - a)·n ≥ 0
    const num = (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1]
    const den = d[0] * n[0] + d[1] * n[1]
    if (Math.abs(den) < 1e-9) {
      if (num < 0) return null
      continue
    }
    const t = -num / den
    if (den > 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
  }
  if (t1 - t0 < 1e-3) return null
  return [
    [p[0] + d[0] * t0, p[1] + d[1] * t0],
    [p[0] + d[0] * t1, p[1] + d[1] * t1],
  ]
}

/** 町人地（民居、商人、工匠、贫民、市、城郊）：沿街的町家 */
function machiWard(ctx: Ctx, ward: Ward, block: Poly) {
  const t = ward.type
  if (small(ctx)) {
    // 村子：村心附近是沿街的町家，其余是零散的农家（与通用填法同一套比例）
    const townlike = t === 'suburb' || ctx.rng.next() < townShare(ctx.p.population, centerDist(ctx, centroid(block)) / Math.max(1, ctx.Rin))
    // 沿街的一排是宿场町那样挨着的町家，屋后是小宅地；其余是零散的农家
    if (!townlike) return urban(ctx, block, 'village', [])
    machiya(ctx, block, null, 'common', { streetOnly: true, dens: 'mid' })
    urban(ctx, block, 'suburb')
    return
  }
  if (t === 'suburb') {
    machiya(ctx, block, null, 'common', { streetOnly: true })
    return
  }
  const kind = t === 'market' ? 'merchant' : t
  for (const q of splitBlock(ctx, block)) machiya(ctx, q, null, kind)
  if (t === 'market') ward.name = ctx.namer.district('market', whereOf(ctx, ward.poly))
}

// —————————————————————— 寺社 ——————————————————————

function templeWard(ctx: Ctx, _ward: Ward, block: Poly): boolean {
  const F = frontOf(ctx, block)
  // 山门 / 鸟居朝最近的街
  const facing: P = [-F.n[0], -F.n[1]]
  if (small(ctx)) {
    // 村里：村社（小神社），周围是农家
    const zone = jinja(ctx, block, facing, true)
    urban(ctx, block, 'village', zone ? [zone] : [])
    return true
  }
  // 合成的大地标：大社（长参道、楼门、摄社）或大寺；只看种子抽，城长大时不变
  if (ctx.tier === 'grand') {
    if (cityDice(ctx, 'wa.grandShrine').h('jinja') < 0.6 && jinja(ctx, block, facing, false)) return true
    const n0 = ctx.out.landmarks.length
    jiin(ctx, block, facing)
    // 大寺的名字（不耗主随机数）
    const lm = ctx.out.landmarks.slice(n0).find((l) => l.kind === 'temple')
    if (lm) lm.name = ctx.namer.sacred('grandTemple', `${Math.round(lm.p[0])},${Math.round(lm.p[1])}`)
    return true
  }
  if (hashAt(ctx, centroid(block), 'wa.temple.jinja') < 0.3 && jinja(ctx, block, facing, false)) return true
  jiin(ctx, block, facing)
  return true
}

/** 一座神社盖好后记下（名所的奥宫、千本鸟居从这里接出去，见 sacred.ts） */
export interface ShrineRec {
  /** 拜殿的中心、本殿后面（奥宫的石阶从这里出发） */
  p: P
  back: P
  /** 参道的方向（从鸟居往里） */
  f: P
  tier: 'small' | 'standard' | 'grand'
  precinct: Poly
}
export const shrines = (ctx: Ctx) => memo(ctx, 'shrines', () => [] as ShrineRec[])

/** 片区一角的村社（small 档）：key 是取名用的位置键 */
export function villageShrine(ctx: Ctx, block: Poly, facing: P, key: string): Poly | null {
  return jinja(ctx, block, facing, true, key)
}

/**
 * 神社：鎮守の森里的社域。参道从街上穿过鸟居通到拜殿，拜殿后面连着币殿、本殿；
 * 一旁是神乐殿、社务所；四周是密林。small 是村社：只占街区里的一小块。
 * 返回社域的范围（村里给农家让地）。
 */
function jinja(ctx: Ctx, block: Poly, facing: P, isSmall: boolean, key?: string): Poly | null {
  const f = unit([-facing[0], -facing[1]])
  const grand = !isSmall && ctx.tier === 'grand'
  const zone0 = placeable(ctx, insetConvex(block, 2), 3, 0.7)
  if (!zone0 || zone0.length < 3 || area(zone0) < (isSmall ? 500 : 1500)) return null
  let Fr: Frame
  let precinct: Poly
  let a0: number
  let a1: number
  let bm: number
  let s: number
  if (isSmall) {
    // 村社：靠街的一块，三四十米见方
    const R = fitRect(zone0, f, 1.8)
    if (!R) return null
    const b = (R.b0 + R.b1) / 2
    Fr = R.F
    a0 = R.a0
    a1 = Math.min(R.a1, R.a0 + 42)
    const b0 = Math.max(R.b0, b - 16)
    const b1 = Math.min(R.b1, b + 16)
    if (a1 - a0 < 26 || b1 - b0 < 20) return null
    precinct = box(Fr, a0, a1, b0, b1)
    bm = b
    s = 0.55
  } else {
    // 社域是整个街区（鎮守の森）；参道沿着过形心的纵线
    Fr = { o: centroid(zone0), f, l: [-f[1], f[0]] }
    precinct = zone0
    bm = (hashAt(ctx, Fr.o, 'wa.jinja.offset') - 0.5) * 10
    const ch = chord(zone0, Fr, bm)
    if (!ch) return null
    ;[a0, a1] = ch
    let wmin = Infinity
    for (const t of [0.4, 0.6, 0.8]) {
      const cw = chord(zone0, { o: at(Fr, a0 + (a1 - a0) * t, 0), f: Fr.l, l: Fr.f }, 0)
      if (cw) wmin = Math.min(wmin, cw[1] - cw[0])
    }
    s = grand ? Math.min(1.6, Math.max(0.8, Math.min(a1 - a0, wmin) / 85)) : Math.min(1.2, Math.max(0.6, Math.min(a1 - a0, wmin) / 70))
  }
  const D = a1 - a0
  if (D < 26) return null
  // 本殿在后，拜殿在前，中间币殿连着
  const hd = 12 * s
  const hw = 16 * s
  // 大社的参道长：拜殿退到纵深的六成以后
  const ha = a0 + D * (grand ? 0.56 : 0.5)
  const haiden = box(Fr, ha, ha + hd, bm - hw / 2, bm + hw / 2)
  const heiden = box(Fr, ha + hd - 0.5, ha + hd + 4 * s, bm - 3 * s, bm + 3 * s)
  const honden = box(Fr, ha + hd + 3.5 * s, ha + hd + 3.5 * s + 9 * s, bm - 5.5 * s, bm + 5.5 * s)
  if (a0 + D - 2 < ha + hd + 13 * s) return null
  if (![haiden, heiden, honden].every((p) => inside(p, precinct))) return null
  if (!addGroup(ctx, [
    [haiden, 'hall'],
    [heiden, 'hall'],
    [honden, 'temple'],
  ], 0))
    return null
  // 参道与鸟居：从街上直通拜殿
  const e0 = at(Fr, a0 - 3, bm)
  const e1 = at(Fr, ha - 1, bm)
  const sw = isSmall ? 2.2 : grand ? 4.5 : 3
  ctx.out.roads.push({ line: [e0, e1], width: sw, kind: 'path' })
  const sando = () => ctx.corridors.add([e0, e1], sw / 2 + 0.5)
  // 鸟居：村社一座，神社两座（一之鸟居、二之鸟居），大社三座
  const toriiAt = isSmall ? [a0 + 3] : grand ? [a0 + 3, a0 + (ha - a0) * 0.4, a0 + (ha - a0) * 0.75] : [a0 + 3, a0 + (ha - a0) * 0.55]
  for (const ta of toriiAt) {
    const hwT = (grand ? 4.6 : 3.2) * Math.max(0.8, Math.min(1.2, s))
    const torii = box(Fr, ta, ta + (grand ? 1.3 : 1), bm - hwT, bm + hwT)
    if (isFree(ctx, torii, { tags: ['river', 'wall'] })) addGroup(ctx, [[torii, 'torii']], 0)
  }
  if (grand) {
    // 楼门：拜殿前一座两层的门，参道两旁一对对石灯笼
    const romon = box(Fr, ha - 11, ha - 6, bm - 6, bm + 6)
    if (isFree(ctx, romon)) place(ctx, romon, 'hall', {}, { role: '楼门' })
    for (let a = a0 + 8; a < ha - 13; a += 7)
      for (const sd of [-1, 1]) {
        const q = at(Fr, a, bm + sd * (sw / 2 + 1.6))
        if (!ctx.occ.hitsPoint(q, 0.8) && ctx.T.waterAt(q) > 2) ctx.out.landmarks.push({ p: q, kind: 'statue' })
      }
  }
  const ok = (p: Poly) => inside(p, precinct) && isFree(ctx, p)
  if (!isSmall) {
    const sd = hashAt(ctx, Fr.o, 'wa.jinja.side') < 0.5 ? -1 : 1
    // 神乐殿、社务所、手水舍
    const kagura = box(Fr, ha - 14, ha - 6, bm + sd * (hw / 2 + 3), bm + sd * (hw / 2 + 11))
    if (ok(kagura)) addGroup(ctx, [[kagura, 'hall']], 0)
    const office = box(Fr, ha + 2, ha + 12, bm - sd * (hw / 2 + 5), bm - sd * (hw / 2 + 17))
    if (ok(office)) addGroup(ctx, [[office, 'hall']], 0)
    const chozu = box(Fr, ha - 9, ha - 5.5, bm - sd * 4.5, bm - sd * 8)
    if (ok(chozu)) addGroup(ctx, [[chozu, 'shed']], 0)
  }
  if (grand) {
    // 摄社、末社：社叢里星散的小社，各有一座小鸟居
    const V = siteDice(ctx, Fr.o, 'wa.sessha')
    const n = V.int('n', 4, 8)
    let made = 0
    for (let k = 0; k < 40 && made < n; k++) {
      const q = at(Fr, a0 + (a1 - a0) * V.num('a', 0.15, 0.95, k), bm + V.num('b', -1, 1, k) * 40)
      if (!pointInPoly(q, insetConvex(precinct, 6))) continue
      const hall = box({ o: q, f: Fr.f, l: Fr.l }, 0, 3.4, -1.8, 1.8)
      const gate = box({ o: q, f: Fr.f, l: Fr.l }, -3, -2.5, -1.6, 1.6)
      if (!isFree(ctx, hall, { pad: 1.2 }) || !isFree(ctx, gate, { pad: 0.3 })) continue
      place(ctx, hall, 'temple', {}, { role: '摄社' })
      place(ctx, gate, 'torii')
      made++
    }
  }
  ctx.out.enclosures.push(precinct)
  const name = grand ? ctx.namer.sacred('taisha', `${Math.round(Fr.o[0])},${Math.round(Fr.o[1])}`) : key ? ctx.namer.sacred('villageShrine', key) : (ctx.namer.wa('shrine') ?? ctx.namer.wa('temple'))
  ctx.out.landmarks.push({ p: at(Fr, ha + hd / 2, bm), name, kind: 'shrine', major: grand })
  shrines(ctx).push({ p: at(Fr, ha + hd / 2, bm), back: at(Fr, ha + hd + 13 * s, bm), f: Fr.f, tier: grand ? 'grand' : isSmall ? 'small' : 'standard', precinct })
  // 大社：参道从社地一直伸到街上（合成的社域四周是森），街口立一之鸟居
  if (grand) {
    const back: P = [-Fr.f[0], -Fr.f[1]]
    let end: P | null = null
    for (let k = 1; k < 90; k++) {
      const q: P = [e0[0] + back[0] * k * 2, e0[1] + back[1] * k * 2]
      if (ctx.T.waterAt(q) < 2 || ctx.occ.hitsPoint(q, sw / 2 + 0.8)) {
        break
      }
      if (ctx.corridors.hits(q, 0.5, ['road'])) {
        end = q
        break
      }
    }
    // 正后方没有路：接到最近的路上（沿途不压房子、不下水）
    if (!end) {
      let bd = 150
      for (const r of ctx.out.roads) {
        if (r.kind === 'path' || r.kind === 'stair') continue
        for (let k = 0; k + 1 < r.line.length; k++) {
          const sd = segDist(e0, r.line[k], r.line[k + 1])
          if (sd.d >= bd) continue
          const q: P = [r.line[k][0] + (r.line[k + 1][0] - r.line[k][0]) * sd.t, r.line[k][1] + (r.line[k + 1][1] - r.line[k][1]) * sd.t]
          let clear = true
          for (let t = 0.05; t < 0.97 && clear; t += 0.03) {
            const m: P = [e0[0] + (q[0] - e0[0]) * t, e0[1] + (q[1] - e0[1]) * t]
            if (ctx.T.waterAt(m) < 2 || ctx.occ.hitsPoint(m, sw / 2 + 0.6) || pointInPoly(m, precinct)) clear = false
          }
          if (!clear) continue
          bd = sd.d
          end = q
        }
      }
    }
    if (end && dist(end, e0) > 6) {
      ctx.out.roads.push({ line: [end, e0], width: sw, kind: 'path' })
      ctx.corridors.add([end, e0], sw / 2 + 0.5)
      const hwT = 5 * Math.max(0.8, Math.min(1.2, s))
      const t1: P = [end[0] - back[0] * 5, end[1] - back[1] * 5]
      const torii1 = rect(t1, Fr.f, 1.4, hwT * 2)
      if (isFree(ctx, torii1, { tags: ['river', 'wall'] })) place(ctx, torii1, 'torii', {}, { role: '一之鸟居' })
      drop(ctx, 'trees', (t) => segDist(t.p, end!, e0).d <= sw / 2 + t.r * 0.5)
    }
  }
  // 鎮守の森：参道两侧与社殿四周种满树（参道上不种）；大社的森更密
  sando()
  const wood = insetConvex(precinct, 1)
  // 有的社叢特别密（鎮守の森）：按社址抽，城长大也不变
  const dense = !isSmall && !grand && siteDice(ctx, Fr.o, 'wa.chinju').chance('dense', 0.35)
  scatterTrees(ctx, wood, isSmall ? 0.01 : grand || dense ? 0.022 : 0.013, 2.5, 5)
  return precinct
}

// —————————————————————— 城郭 ——————————————————————

/** 本丸的隅橹：四角、三角（背后一角省去）、只在正面两角 */
const YAGURA: Elem<'four' | 'three' | 'two'>[] = [
  { id: 'four', w: 3 },
  { id: 'three', w: 1.5 },
  { id: 'two', w: 1 },
]
/** 本丸御殿：雁行两栋、一栋、雁行三栋 */
const GOTEN: Elem<'two' | 'one' | 'three'>[] = [
  { id: 'two', w: 3 },
  { id: 'one', w: 1.5 },
  { id: 'three', w: 1 },
]

/**
 * 城郭（有机城镇里单独的一块）：顺着正面的街摆一个方形的本丸，外面一道堀（地方够时）、里面一道石垣；
 * 正中是大天守连着小天守，四角的隅橹，天守前是御殿；大手门朝街，登城路过堀上的桥进门。
 * 地方太小盖不下城的，是土墙围着的阵屋。
 */
function shiro(ctx: Ctx, block: Poly): boolean {
  const zone = placeable(ctx, insetConvex(block, 1.5), 3, 0.6)
  if (!zone || zone.length < 3 || area(zone) < 700) return false
  const front = frontOf(ctx, zone)
  const R = fitRect(zone, front.n, 1.3)
  if (!R) return false
  const { F } = R
  const M = Math.min(R.a1 - R.a0, R.b1 - R.b0)
  if (M < 40) return jinya(ctx, R)
  const moat = M >= 64
  const mw = moat ? (M >= 100 ? 12 : 9) : 0
  const th = M >= 90 ? 4.2 : 3.4
  // 本丸石垣：堀的内沿再退 2.5 米
  const ins = moat ? mw + 2.5 : 1.5
  const A0 = R.a0 + ins
  const A1 = R.a1 - ins
  const B0 = R.b0 + ins
  const B1 = R.b1 - ins
  const bm = (B0 + B1) / 2
  const hb = (B1 - B0) / 2
  const gl = bm + hb * 0.4 * (hashAt(ctx, F.o, 'wa.buke.gateSide') < 0.5 ? 1 : -1)
  const corners = [at(F, A0, B0), at(F, A0, B1), at(F, A1, B1), at(F, A1, B0)]
  const mo = mw / 2 + 0.5
  const ring = moat ? [at(F, R.a0 + mo, R.b0 + mo), at(F, R.a0 + mo, R.b1 - mo), at(F, R.a1 - mo, R.b1 - mo), at(F, R.a1 - mo, R.b0 + mo)] : null
  const fA = Math.atan2(-F.f[1], -F.f[0])
  rampart(ctx, corners, [{ edge: 0, p: at(F, A0, gl), angle: fA }], ring, mw, th)
  // 本丸的地面与登城路（街 → 桥 → 大手门 → 门内的枡形空地）
  const court = box(F, A0 + th / 2, A1 - th / 2, B0 + th / 2, B1 - th / 2)
  ctx.out.plazas.push(court)
  path(ctx, [at(F, R.a0 - 4, gl), at(F, A0 + th / 2 + 7, gl)], 4)
  // 天守：本丸正中略偏后；小天守在背着登城路的一侧
  const D = A1 - A0 - th
  const W = B1 - B0 - th
  const tb = Math.max(14, Math.min(30, Math.min(D, W) * 0.4))
  const side = gl > bm ? -1 : 1
  const ta = (A0 + A1) / 2 + D * 0.08
  const tl = bm - side * tb * 0.22
  if (!tenshu(ctx, F, ta, tl, tb, side)) tenshu(ctx, F, ta, tl, tb * 0.75, side)
  // 城名标在大手门外（堀与街之间），不压住天守
  ctx.out.landmarks.push({ p: at(F, R.a0 + mw / 2, bm), name: ctx.namer.wa('castle'), kind: 'castle' })
  // 隅橹：本丸四角全有、只在正面两角与背后一角、只在正面两角（抽签，siteDice）
  const C = composer(siteDice(ctx, F.o, 'shiro'), 'shiro', [], { size: M })
  const yagura = C.pick('yagura', YAGURA)
  const yg = M >= 90 ? 7.5 : 6
  const ci = th / 2 + 0.5
  const corners4: [number, number][] = [
    [A0, B0],
    [A0, B1],
    [A1, B0],
    [A1, B1],
  ]
  for (const [a, b] of yagura === 'four' ? corners4 : yagura === 'three' ? corners4.slice(0, 3) : corners4.slice(0, 2)) {
    const sa = a === A0 ? 1 : -1
    const sb = b === B0 ? 1 : -1
    put(ctx, box(F, a + sa * ci, a + sa * (ci + yg), b + sb * ci, b + sb * (ci + yg)), 'tower')
  }
  // 御殿：天守前面、背着登城路的一侧；雁行两栋、一栋、或雁行三栋（抽签）；比天守小得多
  const gf = A0 + th / 2 + 4
  const ge = ta - tb * 0.43 - 4
  const goten = C.pick('goten', GOTEN)
  if (ge - gf > 9) {
    const d1 = Math.min(11, (ge - gf) * 0.55)
    const bIn = bm + side * 2
    const bOut = bm + side * (hb - th / 2 - yg - 2)
    put(ctx, box(F, ge - d1, ge, Math.min(bIn, bOut), Math.max(bIn, bOut)), 'hall')
    const bMid = bm + side * (hb * 0.35)
    if (goten !== 'one') put(ctx, box(F, gf, gf + d1 * 0.8, Math.min(bMid, bOut), Math.max(bMid, bOut)), 'hall')
    if (goten === 'three' && ge - gf > 24) put(ctx, box(F, (gf + ge) / 2 - d1 * 0.35, (gf + ge) / 2 + d1 * 0.35, Math.min(bIn, bMid), Math.max(bIn, bMid)), 'hall')
  }
  // 本丸背面沿墙的藏（有的城没有）
  const kb0 = A1 - th / 2 - 2 - 7
  if (C.chance('kura', 0.7) && kb0 > ta + tb * 0.43 + 3)
    for (let b = B0 + th / 2 + yg + 3; b + 12 < B1 - th / 2 - yg - 3; b += 16) put(ctx, box(F, kb0, kb0 + 7, b, b + 12), 'shed')
  // 松：本丸里零星几棵
  scatterTrees(ctx, insetConvex(court, 2), 0.0012, 2.5, 4)
  C.done(at(F, ta, tl))
  // 城外剩下的边角是土手上的树林
  const outer = insetConvex(zone, 1)
  if (outer.length >= 3) scatterTrees(ctx, outer, 0.003, 2.5, 4.5)
  return true
}

/** 阵屋：地方小的城（小藩的居所）——土墙围着的一组御殿，门朝街 */
function jinya(ctx: Ctx, R: { F: Frame; a0: number; a1: number; b0: number; b1: number }): boolean {
  const { F, a0, a1, b0, b1 } = R
  if (Math.min(a1 - a0, b1 - b0) < 20) return false
  const encl = box(F, a0, a1, b0, b1)
  const D = a1 - a0
  const W = b1 - b0
  const bm = (b0 + b1) / 2
  const main = box(F, a0 + D * 0.35, a0 + D * 0.35 + Math.min(14, D * 0.35), bm - Math.min(20, W * 0.35), bm + Math.min(20, W * 0.35))
  if (!put(ctx, main, 'hall')) return false
  const gate = box(F, a0 + 0.8, a0 + 5, bm - 5, bm + 5)
  put(ctx, gate, 'hall')
  const sub = box(F, a0 + D * 0.72, a1 - 2.5, b0 + 3, b0 + 3 + Math.min(12, W * 0.3))
  if (inside(sub, encl)) put(ctx, sub, 'hall')
  ctx.out.enclosures.push(encl)
  ctx.out.landmarks.push({ p: at(F, a0 + D * 0.5, bm), name: ctx.namer.wa('castle'), kind: 'castle' })
  scatterTrees(ctx, insetConvex(encl, 2), 0.004, 2.5, 4)
  return true
}

// —————————————————————— 御所 ——————————————————————

/** 清凉殿在紫宸殿西北（常例），或整组左右翻过来 */
const SEIRYO: Elem<'west' | 'east'>[] = [
  { id: 'west', w: 3 },
  { id: 'east', w: 1 },
]
/** 南庭：回廊围合（门在南、东、西），或只是築地围着 */
const SOUTH: Elem<'kairo' | 'tsuiji'>[] = [
  { id: 'kairo', w: 3 },
  { id: 'tsuiji', w: 1.2 },
]
/** 御池庭：东列中段（小御所东边）、东列北端 */
const POND: Elem<'mid' | 'north'>[] = [
  { id: 'mid', w: 3 },
  { id: 'north', w: 2 },
]
/** 预设：京都御所（常例）、平安内里（回廊、池在北） */
const GOSHO_PRESETS: Preset[] = [
  { id: 'kyoto', w: 2, bias: { seiryo: { west: 4 }, south: { kairo: 3 }, pond: { mid: 3 } } },
  { id: 'heian', w: 1.5, bias: { south: { kairo: 4 }, pond: { north: 4 }, buraku: { yes: 3 } } },
]

/** 築地围着的南庭：南面正中一座门，庭里铺白砂。返回庭的内沿 */
function tsuiji(K: Kit, r: Rc): Rc {
  const bm = (r.b0 + r.b1) / 2
  const gw = clamp((r.b1 - r.b0) * 0.12, 5, 18)
  K.fence(r)
  K.bld('hall', { a0: r.a0 - 1, a1: r.a0 + clamp((r.a1 - r.a0) * 0.08, 3, 10), b0: bm - gw / 2, b1: bm + gw / 2 })
  const inner = { a0: r.a0 + 1, a1: r.a1, b0: r.b0 + 1, b1: r.b1 - 1 }
  K.gravel(inner)
  return inner
}

/** 标架里 a（南 → 北）、b（西 → 东）两个方向上的范围 */
interface Rc {
  a0: number
  a1: number
  b0: number
  b1: number
}


/**
 * 御所的矩形：宫城地盘（generate 的 palaceSite 给的正矩形）原样用满；
 * 单独一块片区时在里面取坐北朝南的最大矩形。F 的 f 朝北、l 朝东（屏幕上 y 向下是南）。
 */
function palaceRect(zone: Poly): ({ F: Frame } & Rc) | null {
  const f: P = [0, -1]
  const F: Frame = { o: centroid(zone), f, l: [-f[1], f[0]] }
  const { a0, a1, b0, b1 } = extent(F, zone)
  // 地盘本身就是正南北的矩形（面积与外包框相当）：整块都用
  if (area(zone) > (a1 - a0) * (b1 - b0) * 0.97) return { F, a0, a1, b0, b1 }
  return fitRect(zone, f, 1.8)
}

/** 御所用的一组小工具：都按标架里的 (a, b) 范围放 */
function palaceKit(ctx: Ctx, F: Frame) {
  const rect = (r: Rc): Poly => box(F, Math.min(r.a0, r.a1), Math.max(r.a0, r.a1), Math.min(r.b0, r.b1), Math.max(r.b0, r.b1))
  const ok = (r: Rc, min = 1.5) => Math.abs(r.a1 - r.a0) >= min && Math.abs(r.b1 - r.b0) >= min
  return {
    F,
    rect,
    ok,
    /** 一栋建筑（压路、压河、压别的房子就不盖） */
    bld: (kind: BuildingKind, r: Rc) => ok(r) && put(ctx, rect(r), kind),
    /** 白砂的庭（南庭、前庭、院子里的地面） */
    gravel: (r: Rc) => {
      if (ok(r, 3)) ctx.out.plazas.push(rect(r))
    },
    green: (r: Rc | Poly, kind: 'garden' | 'park' | 'courtyard') => {
      const poly = Array.isArray(r) ? r : rect(r)
      if (poly.length >= 3 && area(poly) > 20) ctx.out.greens.push({ poly, kind })
    },
    /** 院墙（築地塀、回廊外沿的线） */
    fence: (r: Rc) => {
      if (ok(r, 6)) ctx.out.enclosures.push(rect(r))
    },
    /** 单独种的一棵树（左近の桜、右近の橘、壺庭的藤与梅） */
    tree: (a: number, b: number, r: number) => void plantTree(ctx, at(F, a, b), r),
    h: (a: number, b: number, tag: string, i = 0) => hashAt(ctx, at(F, a, b), `gosho.${tag}`, i),
  }
}
type Kit = ReturnType<typeof palaceKit>

/**
 * 回廊围着的庭：南面正中是门（承明门、会昌门），东西两面正中各一座门（日华门、月华门）；
 * north 为 false 时北面不封（由正殿把回廊接上）。回廊是细长的一溜房子，庭里铺白砂。返回庭的内沿。
 */
function kairo(K: Kit, r: Rc, cw: number, north: boolean): Rc {
  const bm = (r.b0 + r.b1) / 2
  const am = (r.a0 + r.a1) / 2
  const gw = clamp((r.b1 - r.b0) * 0.14, 5, 22)
  const gs = clamp((r.a1 - r.a0) * 0.12, 4, 16)
  const e = 0.6
  // 南面：两段回廊夹着门
  K.bld('large', { a0: r.a0, a1: r.a0 + cw, b0: r.b0, b1: bm - gw / 2 - e })
  K.bld('large', { a0: r.a0, a1: r.a0 + cw, b0: bm + gw / 2 + e, b1: r.b1 })
  K.bld('hall', { a0: r.a0 - cw * 0.4, a1: r.a0 + cw * 1.6, b0: bm - gw / 2, b1: bm + gw / 2 })
  const top = north ? r.a1 - cw - e : r.a1
  // 东西两面：门上下两段
  for (const [c0, c1] of [
    [r.b0, r.b0 + cw],
    [r.b1 - cw, r.b1],
  ]) {
    K.bld('large', { a0: r.a0 + cw + e, a1: am - gs / 2 - e, b0: c0, b1: c1 })
    K.bld('large', { a0: am + gs / 2 + e, a1: top, b0: c0, b1: c1 })
    K.bld('hall', { a0: am - gs / 2, a1: am + gs / 2, b0: c0 - cw * 0.3, b1: c1 + cw * 0.3 })
  }
  if (north) K.bld('large', { a0: r.a1 - cw, a1: r.a1, b0: r.b0, b1: r.b1 })
  const inner = { a0: r.a0 + cw, a1: north ? r.a1 - cw : r.a1, b0: r.b0 + cw, b1: r.b1 - cw }
  K.gravel(inner)
  return inner
}

/**
 * 壺（院落）：一圈院墙，北面是正屋，东西是两翼的对屋，南面是中门；当中白砂的小庭里种一棵树
 * （藤壺、梅壺、桐壺、梨壺就是按这棵树叫的）。院子太小时只盖一两栋。
 */
function tsubo(K: Kit, r: Rc, h: number, main: BuildingKind = 'large') {
  const d = r.a1 - r.a0
  const w = r.b1 - r.b0
  if (d < 6 || w < 6) return
  if (Math.min(d, w) < 13) {
    // 小院：一栋（长的一边朝南），宽裕时后面再一栋
    const m = 1
    if (d > w * 1.6) {
      K.bld(main, { a0: r.a0 + m, a1: r.a0 + d * 0.48, b0: r.b0 + m, b1: r.b1 - m })
      K.bld('large', { a0: r.a0 + d * 0.55, a1: r.a1 - m, b0: r.b0 + m, b1: r.b1 - m })
    } else K.bld(main, { a0: r.a0 + m, a1: r.a1 - m, b0: r.b0 + m, b1: r.b1 - m })
    return
  }
  K.fence(r)
  K.gravel(r)
  const m = 1.3
  const hd = clamp(d * 0.3, 4.5, 20)
  const ww = clamp(w * 0.2, 3.5, 11)
  const gd = clamp(d * 0.12, 2.5, 6)
  const bm = (r.b0 + r.b1) / 2
  // 正屋
  K.bld(main, { a0: r.a1 - m - hd, a1: r.a1 - m, b0: r.b0 + m + 0.5, b1: r.b1 - m - 0.5 })
  const wa0 = r.a0 + m + gd + 1.5
  const wa1 = r.a1 - m - hd - 1.2
  if (h < 0.3) {
    // 前后两进：南面再一栋，当中是庭
    K.bld('large', { a0: r.a0 + m, a1: r.a0 + m + hd * 0.75, b0: r.b0 + m + ww * 0.6, b1: r.b1 - m - ww * 0.6 })
    K.bld('large', { a0: r.a0 + m + hd * 0.75 + 1.5, a1: wa1, b0: r.b0 + m, b1: r.b0 + m + ww * 0.8 })
    K.tree((r.a0 + m + hd * 0.75 + wa1) / 2, bm, clamp(w * 0.08, 2.2, 4))
    return
  }
  // 两翼的对屋（h 大时只一翼，另一边是庭）
  if (wa1 - wa0 > 3) {
    K.bld('large', { a0: wa0, a1: wa1, b0: r.b0 + m, b1: r.b0 + m + ww })
    if (h < 0.8) K.bld('large', { a0: wa0, a1: wa1, b0: r.b1 - m - ww, b1: r.b1 - m })
  }
  // 中门与两侧的廊
  const gw = clamp(w * 0.22, 3.5, 10)
  K.bld('large', { a0: r.a0 + m, a1: r.a0 + m + gd, b0: bm - gw / 2, b1: bm + gw / 2 })
  if (w > 30) {
    K.bld('large', { a0: r.a0 + m, a1: r.a0 + m + gd * 0.6, b0: r.b0 + m, b1: bm - gw / 2 - 1 })
    K.bld('large', { a0: r.a0 + m, a1: r.a0 + m + gd * 0.6, b0: bm + gw / 2 + 1, b1: r.b1 - m })
  }
  // 壺庭的一棵树
  K.tree((wa0 + wa1) / 2, h < 0.8 ? bm : bm + ww * 0.6, clamp(Math.min(w, d) * 0.08, 2.2, 4.5))
}

/** 一排排的藏（御文庫、大蔵）：顺着长边排两行，中间留一条通道 */
function kura(K: Kit, r: Rc) {
  const d = r.a1 - r.a0
  const w = r.b1 - r.b0
  const along = w >= d
  const L = along ? w : d
  const S = along ? d : w
  const rows = S >= 20 ? 2 : 1
  const sd = clamp(S * (rows === 2 ? 0.3 : 0.6), 3.5, 7)
  const sl = sd * 1.35
  // 一行排几座：两端各留 1 米，座间至少 1.8 米，余下的均分
  const n = Math.max(1, Math.floor((L - 2 + 1.8) / (sl + 1.8)))
  const gap = n > 1 ? (L - 2 - n * sl) / (n - 1) : 0
  for (let k = 0; k < rows; k++) {
    const s0 = k === 0 ? 1 : S - 1 - sd
    for (let i = 0, t = n > 1 ? 1 : (L - sl) / 2; i < n; i++, t += sl + gap) {
      const q = along ? { a0: r.a0 + s0, a1: r.a0 + s0 + sd, b0: r.b0 + t, b1: r.b0 + t + sl } : { a0: r.a0 + t, a1: r.a0 + t + sl, b0: r.b0 + s0, b1: r.b0 + s0 + sd }
      K.bld('shed', q)
    }
  }
}

/**
 * 把一块矩形划成一格格的院子（殿舍、曹司、官衙），格间是白砂的小路；
 * store 是格子做成仓库的比例，main 是院子正屋的种类。
 */
function cells(K: Kit, r: Rc, size: number, salt: string, store = 0.15, main: BuildingKind = 'large') {
  const d = r.a1 - r.a0
  const w = r.b1 - r.b0
  if (d < 6 || w < 6) return
  K.gravel(r)
  const lane = clamp(size * 0.12, 2, 5)
  const na = Math.max(1, Math.round((d + lane) / (size + lane)))
  const nb = Math.max(1, Math.round((w + lane) / (size * 1.15 + lane)))
  const ca = (d - lane * (na - 1)) / na
  const cb = (w - lane * (nb - 1)) / nb
  for (let i = 0; i < na; i++)
    for (let j = 0; j < nb; j++) {
      const c: Rc = { a0: r.a0 + i * (ca + lane), a1: r.a0 + i * (ca + lane) + ca, b0: r.b0 + j * (cb + lane), b1: r.b0 + j * (cb + lane) + cb }
      const h = K.h((c.a0 + c.a1) / 2, (c.b0 + c.b1) / 2, `cells.${salt}`)
      if (h < store || Math.max(ca, cb) > Math.min(ca, cb) * 2.4) kura(K, c)
      else tsubo(K, c, (h - store) / (1 - store), main)
    }
}

/**
 * 池庭（御池庭）：一片庭园，当中是洲浜围着的池（地图上没有池水，画成一片白砂的洲浜），
 * 池边一圈树，池畔一座茶屋，园路绕池一周。
 */
function ikeniwa(ctx: Ctx, K: Kit, r: Rc) {
  const d = r.a1 - r.a0
  const w = r.b1 - r.b0
  if (d < 10 || w < 10) return
  K.green(r, 'garden')
  const ca = (r.a0 + r.a1) / 2
  const cb = (r.b0 + r.b1) / 2
  const ra = d * 0.3
  const rb = w * 0.3
  const ph = K.h(ca, cb, 'pond.phase') * 6.28
  const pond: Poly = []
  for (let i = 0; i < 20; i++) {
    const t = (i / 20) * Math.PI * 2
    const k = 1 + 0.16 * Math.sin(3 * t + ph) + 0.08 * Math.cos(5 * t - ph)
    pond.push(at(K.F, ca + Math.cos(t) * ra * k, cb + Math.sin(t) * rb * k))
  }
  if (Math.min(ra, rb) > 3) {
    ctx.out.plazas.push(pond)
    // 池面不种树、不盖房
    ctx.occ.add(pond)
    // 园路绕池一周
    const loop: P[] = []
    for (let i = 0; i <= 24; i++) {
      const t = (i / 24) * Math.PI * 2
      loop.push(at(K.F, ca + Math.cos(t) * (ra * 1.28 + 2), cb + Math.sin(t) * (rb * 1.28 + 2)))
    }
    ctx.out.roads.push({ line: loop, width: 1.6, kind: 'path' })
    // 池边一圈树
    const n = Math.round((ra + rb) * 0.45)
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2 + K.h(ca, cb, 'pond.treeA', i) * 0.4
      const s = 1.12 + K.h(ca, cb, 'pond.treeR', i) * 0.1
      K.tree(ca + Math.cos(t) * ra * s, cb + Math.sin(t) * rb * s, 2 + K.h(ca, cb, 'pond.treeS', i) * 1.8)
    }
    // 池畔的茶屋
    const ts = clamp(Math.min(d, w) * 0.08, 3, 7)
    const ta = ca + ra * 0.95
    const tb = cb - rb * 0.95
    K.bld('hall', { a0: ta - ts / 2, a1: ta + ts / 2, b0: tb - ts / 2, b1: tb + ts / 2 })
  }
  scatterTrees(ctx, insetConvex(K.rect(r), 1.5), 0.01, 2, 4.2)
}

/**
 * 御所（都城）：築地塀围成坐北朝南的长方形——南面正中建礼门、东面建春门、西面宜秋门、北面朔平门。
 * 宫城地盘够大（数百米见方）时是平安京的大内里：南半是朝堂院（大极殿与十二堂）、豊楽院与八省的官衙，
 * 北半当中是内里，西边宴の松原，东边是曹司与大蔵。否则整块就是内里（京都御所）：
 * 回廊围着的南庭与紫宸殿（左近の桜、右近の橘），西边清凉殿，东边小御所、御学问所与御池庭，
 * 背后是常御殿与后宫的一个个壺（院落），沿北墙是藏。房子的尺寸与数量都随矩形放大，排得密。
 */
/** 国衙（国府的政厅）：仿唐的院落，正殿、后殿与两厢围着庭院，坐北朝南 */
function kokuga(ctx: Ctx, block: Poly): boolean {
  const zone = placeable(ctx, insetConvex(block, 3), 3, 0.5)
  if (!zone || zone.length < 3 || area(zone) < 900 || !eastCompound(ctx, zone, 'palace')) return false
  ctx.out.landmarks.push({ p: centroid(zone), name: { zh: '国衙', en: 'Kokuga', ja: '国衙' }, kind: 'castle' })
  return true
}

function gosho(ctx: Ctx, block: Poly): boolean {
  const zone = placeable(ctx, insetConvex(block, 1.5), 3, 0.35)
  if (!zone || zone.length < 3 || area(zone) < 1000) return false
  const R = palaceRect(zone)
  if (!R || Math.min(R.a1 - R.a0, R.b1 - R.b0) < 30) return false
  const { F } = R
  const K = palaceKit(ctx, F)
  const M = Math.min(R.a1 - R.a0, R.b1 - R.b0)
  const th = clamp(M * 0.012, 2.4, 4)
  const A0 = R.a0 + 1
  const A1 = R.a1 - 1
  const B0 = R.b0 + 1
  const B1 = R.b1 - 1
  const bm = (B0 + B1) / 2
  const D = A1 - A0
  const corners = [at(F, A0, B0), at(F, A0, B1), at(F, A1, B1), at(F, A1, B0)]
  const fA = Math.atan2(F.f[1], F.f[0])
  const lA = Math.atan2(F.l[1], F.l[0])
  // 築地塀：建礼门（南）、建春门（东）、朔平门（北）、宜秋门（西）
  rampart(
    ctx,
    corners,
    [
      { edge: 0, p: at(F, A0, bm), angle: fA },
      { edge: 1, p: at(F, A0 + D * 0.42, B1), angle: lA },
      { edge: 2, p: at(F, A1, bm), angle: fA },
      { edge: 3, p: at(F, A0 + D * 0.34, B0), angle: lA },
    ],
    null,
    0,
    th,
  )
  path(ctx, [at(F, R.a0 - 4, bm), at(F, A0 + 1, bm)], clamp(M * 0.025, 4, 8))
  const I: Rc = { a0: A0 + th / 2 + 3.5, a1: A1 - th / 2 - 1.5, b0: B0 + th / 2 + 1.5, b1: B1 - th / 2 - 1.5 }
  const Di = I.a1 - I.a0
  const Wi = I.b1 - I.b0
  // 矩形太扁或太长：内里取当中（或北端）一块方一些的，其余是官衙与曹司
  const g = clamp(M * 0.02, 3, 6)
  const cell = clamp(M * 0.13, 16, 40)
  let core = I
  if (Wi > Di * 1.7) {
    const cw = Math.max(Di * 1.35, 30)
    core = { ...I, b0: bm - cw / 2, b1: bm + cw / 2 }
    cells(K, { ...I, b1: core.b0 - g }, cell, 'gosho.west', 0.2, 'hall')
    cells(K, { ...I, b0: core.b1 + g }, cell, 'gosho.east', 0.2, 'hall')
  } else if (Di > Wi * 1.9) {
    const cd = Math.max(Wi * 1.5, 30)
    core = { ...I, a0: I.a1 - cd }
    // 南边：中轴一条白砂的参道，两侧是官衙
    const av = clamp(Wi * 0.14, 6, 24)
    K.gravel({ a0: I.a0, a1: core.a0, b0: bm - av / 2, b1: bm + av / 2 })
    cells(K, { a0: I.a0, a1: core.a0 - g, b0: I.b0, b1: bm - av / 2 - g }, cell, 'gosho.frontW', 0.2, 'hall')
    cells(K, { a0: I.a0, a1: core.a0 - g, b0: bm + av / 2 + g, b1: I.b1 }, cell, 'gosho.frontE', 0.2, 'hall')
  }
  const Dc = core.a1 - core.a0
  const Wc = core.b1 - core.b0
  // 御所的构成按种子抽签（cityDice）：清凉殿在西（常例）或整组左右翻过来、南庭用回廊还是築地、御池庭在哪
  const C = composer(cityDice(ctx, 'gosho'), 'gosho', GOSHO_PRESETS, { size: Math.min(Dc, Wc), rank: 2 })
  const bc = (core.b0 + core.b1) / 2
  const Km = C.pick('seiryo', SEIRYO) === 'east' ? palaceKit(ctx, { o: at(F, 0, 2 * bc), f: F.f, l: [-F.l[0], -F.l[1]] }) : K
  let mark: P
  if (Dc >= 190 && Wc >= 150) mark = daidairi(ctx, Km, core, C)
  else if (Math.min(Dc, Wc) >= 64) mark = dairi(ctx, Km, core, C)
  else mark = dairiSmall(ctx, Km, core, C)
  C.done(mark)
  ctx.out.landmarks.push({ p: mark, name: ctx.namer.palace(), kind: 'castle' })
  return true
}

/** 内里（京都御所的格局）：返回南庭的中心（标名字用） */
function dairi(ctx: Ctx, K: Kit, r: Rc, C: Composer): P {
  const d = r.a1 - r.a0
  const w = r.b1 - r.b0
  const bm = (r.b0 + r.b1) / 2
  const g = clamp(Math.min(d, w) * 0.02, 2.5, 6)
  const cell = clamp(Math.min(d, w) * 0.13, 16, 42)
  // 中轴那一列的宽、南庭的深、南庭的围法、御池庭在东列的中段还是北端
  const pondNorth = C.pick('pond', POND) === 'north'
  // 三列：当中是南庭—紫宸殿—常御殿的中轴，西列清凉殿与诸大夫之间、御台所，东列小御所、御池庭
  const wc = w * C.num('wc', 0.38, 0.46)
  const bC0 = bm - wc / 2
  const bC1 = bm + wc / 2
  const bW1 = bC0 - g
  const bE0 = bC1 + g
  const we = r.b1 - bE0
  const ww = bW1 - r.b0
  // 前庭（建礼门—承明门之间的白砂）
  const aF = r.a0 + Math.max(5, d * 0.05)
  K.gravel({ a0: r.a0, a1: aF, b0: bC0, b1: bC1 })
  // 南庭：回廊围合，紫宸殿接在北面
  const aN = r.a0 + d * C.num('aN', 0.32, 0.4)
  const cw = clamp(w * 0.014, 2.5, 5)
  const sdp = clamp(d * 0.085, 7, 40)
  const sw = wc * 0.66
  const court = C.pick('south', SOUTH) === 'kairo' ? kairo(K, { a0: aF, a1: aN - cw / 2, b0: bC0, b1: bC1 }, cw, false) : tsuiji(K, { a0: aF, a1: aN - cw / 2, b0: bC0, b1: bC1 })
  // 紫宸殿（最大的一座）与左右接回廊的廊
  K.bld('hall', { a0: aN - sdp * 0.5, a1: aN + sdp * 0.5, b0: bm - sw / 2, b1: bm + sw / 2 })
  K.bld('large', { a0: aN - cw / 2 - 0.1, a1: aN + cw / 2, b0: bC0, b1: bm - sw / 2 - 0.6 })
  K.bld('large', { a0: aN - cw / 2 - 0.1, a1: aN + cw / 2, b0: bm + sw / 2 + 0.6, b1: bC1 })
  // 左近の桜（东）、右近の橘（西）
  const ta = aN - sdp * 0.5 - clamp(d * 0.03, 3, 10)
  const tr = clamp(w * 0.012, 2.6, 4.5)
  K.tree(ta, bm + sw * 0.34, tr)
  K.tree(ta, bm - sw * 0.34, tr)
  // 紫宸殿背后：常御殿一院，再往北是后宫的一个个壺
  const aB = aN + sdp * 0.5 + g
  const aJ = aB + d * 0.2
  tsubo(K, { a0: aB, a1: aJ, b0: bC0, b1: bC1 }, 0.5, 'hall')
  cells(K, { a0: aJ + g, a1: r.a1, b0: bC0, b1: bC1 }, cell, 'dairi.north', 0.15)
  // 西列：清凉殿（紫宸殿西北，朝东）与后凉殿；南边诸大夫之间、御车寄，北边御台所与杂舍
  if (ww > 12) {
    const s0 = aN - d * 0.1
    const s1 = aN + d * 0.12
    const sd = clamp(ww * 0.45, 8, 32)
    K.gravel({ a0: s0, a1: s1, b0: r.b0, b1: bW1 })
    K.bld('hall', { a0: s0 + 1.5, a1: s1 - 1.5, b0: bW1 - sd - 4, b1: bW1 - 4 })
    const kd = clamp(ww * 0.22, 5, 16)
    if (bW1 - sd - 6 - kd > r.b0 + 1) K.bld('large', { a0: s0 + (s1 - s0) * 0.15, a1: s1 - 1.5, b0: r.b0 + 1.5, b1: r.b0 + 1.5 + kd })
    // 清凉殿东庭的呉竹・河竹
    K.tree(s0 + (s1 - s0) * 0.3, bW1 - 2, 2)
    K.tree(s0 + (s1 - s0) * 0.6, bW1 - 2, 2)
    cells(K, { a0: r.a0, a1: s0 - g, b0: r.b0, b1: bW1 }, cell, 'dairi.west', 0.1)
    cells(K, { a0: s1 + g, a1: r.a1, b0: r.b0, b1: bW1 }, cell, 'dairi.westN', 0.4)
  }
  // 东列：南边春兴殿一带的殿舍；中段西侧小御所与御学问所，东侧御池庭；北边御内庭与曹司
  if (we > 12) {
    const p0 = aN - d * 0.14
    const p1 = aN + d * 0.2
    const sb = clamp(we * 0.34, 8, 36)
    cells(K, { a0: r.a0, a1: p0 - g, b0: bE0, b1: r.b1 }, cell, 'dairi.east', 0.2)
    K.gravel({ a0: p0, a1: p1, b0: bE0, b1: bE0 + sb })
    const mid = aN + d * 0.03
    K.bld('hall', { a0: p0 + 1.5, a1: mid - 1.2, b0: bE0 + 1.5, b1: bE0 + sb - 1.5 })
    K.bld('hall', { a0: mid + 1.2, a1: p1 - 1.5, b0: bE0 + 2.5, b1: bE0 + sb - 2.5 })
    // 御池庭：小御所东边（京都御所），或挪到东列北端（小御所东边是殿舍）
    if (pondNorth) cells(K, { a0: p0, a1: p1, b0: bE0 + sb + g, b1: r.b1 }, cell, 'dairi.pond', 0.2)
    else ikeniwa(ctx, K, { a0: p0, a1: p1, b0: bE0 + sb + g, b1: r.b1 })
    const north = (a0: number) => {
      const q: Rc = { a0, a1: r.a1, b0: bE0, b1: r.b1 }
      if (pondNorth && r.a1 - a0 > 16) ikeniwa(ctx, K, q)
      else cells(K, q, cell, 'dairi.eastN', 0.3)
    }
    // 御内庭（常御殿东边的小庭）与北边的曹司
    const q1 = p1 + g + d * 0.1
    if (q1 < r.a1 - 8) {
      K.green({ a0: p1 + g, a1: q1, b0: bE0 + we * 0.4, b1: r.b1 }, 'garden')
      scatterTrees(ctx, insetConvex(K.rect({ a0: p1 + g, a1: q1, b0: bE0 + we * 0.4, b1: r.b1 }), 1.5), 0.012, 2, 3.8)
      tsubo(K, { a0: p1 + g, a1: q1, b0: bE0, b1: bE0 + we * 0.4 - g }, 0.35)
      north(q1 + g)
    } else north(p1 + g)
  }
  return at(K.F, (court.a0 + court.a1) / 2, bm)
}

/** 小的内里（地盘不到六七十米）：南庭、紫宸殿，背后清凉殿与常御殿，一角池庭，沿北墙几座藏 */
function dairiSmall(ctx: Ctx, K: Kit, r: Rc, C: Composer): P {
  const d = r.a1 - r.a0
  const w = r.b1 - r.b0
  const bm = (r.b0 + r.b1) / 2
  const sw = w * 0.5
  const sdp = clamp(d * 0.16, 5, 12)
  const sa = r.a0 + d * 0.4
  const cw = w * 0.34
  const c0 = r.a0 + d * 0.06
  K.gravel({ a0: r.a0, a1: sa, b0: bm - cw, b1: bm + cw })
  if (w >= 44) kairo(K, { a0: c0, a1: sa, b0: bm - cw, b1: bm + cw }, 2.2, false)
  else K.fence({ a0: c0, a1: sa, b0: bm - cw, b1: bm + cw })
  K.bld('hall', { a0: sa, a1: sa + sdp, b0: bm - sw / 2, b1: bm + sw / 2 })
  K.tree(sa - 3, bm + sw * 0.3, 2.4)
  K.tree(sa - 3, bm - sw * 0.3, 2.4)
  // 两侧的殿舍（宜陽殿、校書殿）
  const side = (bm - cw - r.b0) - 2
  if (side > 5)
    for (const sd of [-1, 1]) {
      const bIn = bm + sd * (cw + 1.5)
      const bOut = bm + sd * (cw + 1.5 + Math.min(side, 12))
      K.bld('large', { a0: c0 + 2, a1: sa - 2, b0: Math.min(bIn, bOut), b1: Math.max(bIn, bOut) })
    }
  // 背后：清凉殿（西）、常御殿（东），池庭在东北角；按种子抽签，有的整组左右翻过来（池庭在西北）
  const back = sa + sdp + 3
  const bd = Math.min(14, (r.a1 - back) * 0.45)
  const X = C.chance('flipBack', 0.35) ? (b: number) => 2 * bm - b : (b: number) => b
  if (bd > 4) {
    K.bld('hall', { a0: back, a1: back + bd, b0: X(r.b0 + 2), b1: X(bm - 2) })
    K.bld('hall', { a0: back + 1.5, a1: back + bd * 0.85, b0: X(bm + 2), b1: X(bm + w * 0.3) })
    const g0 = back
    ikeniwa(ctx, K, { a0: g0, a1: r.a1 - 1, b0: Math.min(X(bm + w * 0.3 + 2), X(r.b1 - 1)), b1: Math.max(X(bm + w * 0.3 + 2), X(r.b1 - 1)) })
    // 沿北墙的藏
    const k0 = back + bd + 2
    if (r.a1 - k0 > 5) kura(K, { a0: k0, a1: r.a1 - 0.5, b0: Math.min(X(r.b0 + 1), X(bm + w * 0.3)), b1: Math.max(X(r.b0 + 1), X(bm + w * 0.3)) })
  }
  return at(K.F, (c0 + sa) / 2, bm)
}

/**
 * 大内里（平安宫）：南半当中是朝堂院（北端大极殿，前面左右各两列朝堂，南面会昌门），西边豊楽院，
 * 东西两侧是太政官与八省的官衙；北半当中（略偏东）是内里，西边中和院与宴の松原，东边曹司与大蔵。
 */
function daidairi(ctx: Ctx, K: Kit, r: Rc, Z: Composer): P {
  const d = r.a1 - r.a0
  const w = r.b1 - r.b0
  const bm = (r.b0 + r.b1) / 2
  const g = clamp(Math.min(d, w) * 0.015, 3, 8)
  const cell = clamp(Math.min(d, w) * 0.09, 20, 44)
  // 南北两半的分界、朝堂院的宽、有没有豊楽院、内里偏东多少：按种子抽签
  const aS = r.a0 + d * Z.num('aS', 0.4, 0.48)
  const S: Rc = { a0: r.a0, a1: aS - g, b0: r.b0, b1: r.b1 }
  const dS = S.a1 - S.a0
  // 朝堂院
  const cw = w * Z.num('chodo', 0.26, 0.34)
  const C: Rc = { a0: S.a0 + dS * 0.06, a1: S.a1, b0: bm - cw / 2, b1: bm + cw / 2 }
  K.gravel({ a0: S.a0, a1: C.a0, b0: C.b0, b1: C.b1 })
  K.fence(C)
  K.gravel(C)
  const m = 2
  // 会昌门
  const gw = clamp(cw * 0.16, 8, 26)
  K.bld('hall', { a0: C.a0 - 1, a1: C.a0 + clamp(dS * 0.04, 4, 10), b0: bm - gw / 2, b1: bm + gw / 2 })
  // 大极殿、后面的小安殿；前面左右的苍龙楼、白虎楼
  const dd = clamp(dS * 0.13, 10, 45)
  const dk1 = C.a1 - m - dS * 0.1
  const dk0 = dk1 - dd
  K.bld('hall', { a0: dk0, a1: dk1, b0: bm - cw * 0.3, b1: bm + cw * 0.3 })
  K.bld('large', { a0: dk1 + 2.5, a1: C.a1 - m, b0: bm - cw * 0.18, b1: bm + cw * 0.18 })
  const tw = clamp(cw * 0.06, 4, 10)
  for (const sd of [-1, 1]) K.bld('tower', { a0: dk0 - 4 - tw, a1: dk0 - 4, b0: bm + sd * cw * 0.38 - tw / 2, b1: bm + sd * cw * 0.38 + tw / 2 })
  // 朝堂：大极殿前的龙尾坛以南，左右各两列细长的堂
  const t0 = C.a0 + clamp(dS * 0.04, 4, 10) + 4
  const t1 = dk0 - 8 - tw
  // 堂数随进深（每侧 2 ~ 6 座一列），堂长把龙尾坛以南排满
  const n = clamp(Math.round((t1 - t0) / Math.max(14, dS * 0.2)), 1, 6)
  const hl = (t1 - t0 - 3 * (n - 1)) / n
  const hw = clamp(cw * 0.11, 4, 14)
  for (let k = 0; k < n && hl > 4; k++) {
    const a = t0 + k * (hl + 3)
    for (const sd of [-1, 1])
      for (const col of cw >= 44 ? [0, 1] : [0]) {
        const bOut = bm + sd * (cw / 2 - m - col * (hw + 3))
        const bIn = bOut - sd * hw
        K.bld('large', { a0: a, a1: a + hl, b0: Math.min(bIn, bOut), b1: Math.max(bIn, bOut) })
      }
  }
  const mark = at(K.F, (t0 + t1) / 2, bm)
  // 豊楽院（西）：豊楽殿与左右的堂
  const fw = Z.chance('buraku', 0.75) ? w * Z.num('fw', 0.14, 0.19) : 0
  const Fr: Rc = { a0: S.a0 + dS * 0.14, a1: S.a1 - dS * 0.06, b0: C.b0 - g - fw, b1: C.b0 - g }
  if (fw > 20) {
    // 回廊一圈，里面北边豊楽殿、背后清暑堂，前庭左右各两座堂
    const q = kairo(K, Fr, clamp(fw * 0.05, 2.5, 4), true)
    const fm = (q.b0 + q.b1) / 2
    const fd = q.a1 - q.a0
    const qw = q.b1 - q.b0
    const hd = clamp(fd * 0.14, 8, 30)
    const h0 = q.a0 + fd * 0.52
    K.bld('hall', { a0: h0, a1: h0 + hd, b0: fm - qw * 0.34, b1: fm + qw * 0.34 })
    K.bld('large', { a0: h0 + hd + 3, a1: q.a1 - 2, b0: fm - qw * 0.24, b1: fm + qw * 0.24 })
    const sw = clamp(qw * 0.16, 4, 12)
    const s0 = q.a0 + fd * 0.08
    const s1 = h0 - 4
    const sl = (s1 - s0 - 3) / 2
    for (const sd of [-1, 1])
      for (let k = 0; k < 2 && sl > 4; k++) {
        const bOut = fm + sd * (qw / 2 - 2)
        const bIn = bOut - sd * sw
        K.bld('large', { a0: s0 + k * (sl + 3), a1: s0 + k * (sl + 3) + sl, b0: Math.min(bIn, bOut), b1: Math.max(bIn, bOut) })
      }
  }
  // 太政官与八省（东西两侧的官衙）
  cells(K, { a0: S.a0, a1: S.a1, b0: C.b1 + g, b1: r.b1 }, cell, 'daidairi.east', 0.15, 'hall')
  cells(K, { a0: S.a0, a1: S.a1, b0: r.b0, b1: (fw > 20 ? Fr.b0 : C.b0) - g }, cell, 'daidairi.west', 0.15, 'hall')
  if (fw > 20) {
    cells(K, { a0: S.a0, a1: Fr.a0 - g, b0: Fr.b0, b1: Fr.b1 }, cell, 'daidairi.frontW', 0.3)
    cells(K, { a0: Fr.a1 + g, a1: S.a1, b0: Fr.b0, b1: Fr.b1 }, cell, 'daidairi.frontE', 0.3)
  }
  // 北半：内里（略偏东，一圈院墙）
  const N: Rc = { a0: aS + g, a1: r.a1, b0: r.b0, b1: r.b1 }
  const dw = w * Z.num('dw', 0.4, 0.48)
  const dc = bm + w * Z.num('dc', -0.02, 0.07)
  const Dr: Rc = { a0: N.a0, a1: N.a1, b0: dc - dw / 2, b1: dc + dw / 2 }
  K.fence(Dr)
  const inner = { a0: Dr.a0 + 3, a1: Dr.a1 - 2, b0: Dr.b0 + 2, b1: Dr.b1 - 2 }
  if (Math.min(inner.a1 - inner.a0, inner.b1 - inner.b0) >= 64) dairi(ctx, K, inner, Z)
  else dairiSmall(ctx, K, inner, Z)
  // 西边：宴の松原（靠内里的一侧）与中和院、曹司
  const west: Rc = { a0: N.a0, a1: N.a1, b0: r.b0, b1: Dr.b0 - g }
  const pw = (west.b1 - west.b0) * 0.5
  if (pw > 12) {
    const pine = K.rect({ a0: west.a0, a1: west.a1 - (N.a1 - N.a0) * 0.3, b0: west.b1 - pw, b1: west.b1 })
    K.green(pine, 'park')
    scatterTrees(ctx, insetConvex(pine, 2), 0.035, 2.6, 4.6)
    cells(K, { a0: west.a1 - (N.a1 - N.a0) * 0.3 + g, a1: west.a1, b0: west.b1 - pw, b1: west.b1 }, cell, 'daidairi.store', 0.2)
    cells(K, { a0: west.a0, a1: west.a1, b0: west.b0, b1: west.b1 - pw - g }, cell, 'daidairi.nw', 0.2, 'hall')
  } else cells(K, west, cell, 'daidairi.nw', 0.2)
  // 东边：中务省等曹司，北端大蔵
  cells(K, { a0: N.a0, a1: N.a1, b0: Dr.b1 + g, b1: r.b1 }, cell, 'daidairi.north', 0.35)
  return mark
}

// —————————————————————— 广小路、市 ——————————————————————

/**
 * 广场：日本的城没有西式的广场，街口放宽的是广小路、火除地（防火的空地，平时摆着茶屋与小屋），
 * 或者是定期的市（一排排的摊棚）。城镇里有火见橹与高札场，村里是一口井。
 */
function hirokoji(ctx: Ctx, block: Poly) {
  const pave = ctx.corridors.clip(clipWater(ctx, block, 1) ?? block, ['wall']) ?? block
  ctx.out.plazas.push(pave)
  const c = centroid(pave)
  if (small(ctx)) {
    ctx.out.landmarks.push({ p: c, kind: 'well' })
    return
  }
  const b = obb(pave)
  const across: P = [-b.axis[1], b.axis[0]]
  const inner = insetConvex(pave, 4)
  const market = hashAt(ctx, c, 'wa.village.market') < 0.55
  if (market && inner.length >= 3) {
    // 市：顺着长轴一排排的摊棚，排与排之间是走道
    for (let v = -b.wid / 2 + 6; v < b.wid / 2 - 6; v += 9)
      for (let u = -b.len / 2 + 5; u < b.len / 2 - 5; u += 4.6) {
        if (hashAt(ctx, [c[0] + u, c[1] + v], 'wa.village.gap') < 0.2) continue
        const q: P = [b.center[0] + b.axis[0] * u + across[0] * v, b.center[1] + b.axis[1] * u + across[1] * v]
        const s = rect(q, b.axis, 3.8, 2.6)
        if (inside(s, inner)) addBuilding(ctx, s, 'shed', 0.5)
      }
    mark(ctx, c, 'market')
  } else {
    // 火除地：空着，边上几间茶屋、一行树
    const edge = insetConvex(pave, 3)
    for (let i = 0; i < edge.length; i++) {
      const a = edge[i]
      const e = edge[(i + 1) % edge.length]
      const L = dist(a, e)
      for (let s = 4; s < L - 4; s += 9) {
        const q: P = [a[0] + ((e[0] - a[0]) * s) / L, a[1] + ((e[1] - a[1]) * s) / L]
        if (ctx.corridors.hits(q, 1.5) || ctx.occ.hitsPoint(q, 2)) continue
        ctx.out.trees.push({ p: q, r: 2.6 + hashAt(ctx, q, 'wa.village.tree') * 1.2 })
      }
    }
    for (let k = 0; k < 3; k++) {
      const q: P = [c[0] + (hashAt(ctx, c, 'wa.village.x', k) - 0.5) * b.len * 0.6, c[1] + (hashAt(ctx, c, 'wa.village.y', k) - 0.5) * b.wid * 0.6]
      const s = rect(q, b.axis, 7, 5)
      if (inside(s, inner)) addBuilding(ctx, s, 'shed', 1)
    }
  }
  // 火见橹与高札场
  const tower = rect([c[0] + across[0] * b.wid * 0.3, c[1] + across[1] * b.wid * 0.3], b.axis, 3.5, 3.5)
  if (inside(tower, pave)) addBuilding(ctx, tower, 'tower', 1)
  const board = rect([c[0] - b.axis[0] * b.len * 0.3, c[1] - b.axis[1] * b.len * 0.3], b.axis, 5, 1.6)
  if (inside(board, pave)) addBuilding(ctx, board, 'shed', 1)
  if (!ctx.occ.hitsPoint(c, 2)) ctx.out.landmarks.push({ p: c, kind: 'well' })
}
