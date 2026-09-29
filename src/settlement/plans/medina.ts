import { addRoad } from '../roads'
import { emitArea, clipWater, hashAt, isFree, placeable, siteDice, type Ctx } from '../ctx'
import {
  add,
  area,
  centroid,
  chord,
  circlePoly,
  dist,
  insetConvex,
  localBox,
  inscribedRect,
  obb,
  pointAt,
  pointInPoly,
  polylineDist,
  polylineLength,
  rect,
  resample,
  rot,
  segSegDist,
  type P,
  type Poly,
} from '../geom'
import type { Tri } from '../../gen/naming'
import type { BuildingKind, Ward } from '../types'
import { addBuilding, addGroup, fit, inside, place, scatterTrees, subdivide } from '../wards'
import { drop } from '../undo'
import type { CityPlan } from './types'
import { composer } from '../compose/core'
import { MOSQUE_PRESETS, mosqueForm, mosqueParts, plainMosque, type MosqueForm } from '../compose/islamic'
import { addWall, connectGates } from '../walls'
import { planPopOf } from '../scale'

/**
 * 麦地那（伊斯兰传统城市：非斯、突尼斯、大马士革老城，缩到地图的尺度）。规划不在方格，而在结构与街巷的层级：
 * - 城心是大清真寺（礼拜殿、带回廊的大庭院、一座宣礼塔），四周紧挨着集市（souq）：沿主街的长条市场，窄小的铺位成排；
 * - 几条弯曲的穿城主街从城门通向大清真寺；街坊（hara）之间是二级街巷，街坊里面靠尽端巷（derb）组织：
 *   巷子从街上伸进去、分个叉就到头，不通对面；
 * - 住宅是内院式：对外实墙、朝内开院，一户一个小院，挤得很密，一两层；
 * - 城墙顺地形、轮廓不规则，城门几座，门外路旁是墓地；要塞（kasbah）在城墙边的高处；
 * - 街坊比有机片区大：站点按世界坐标的抖动网格取（换人口时已有的街坊不动），沿主街、城墙成对布点，
 *   主街与城墙都落在街坊边界上。城墙外还有一圈规划的片区（门外的墓地、关厢），再往外照常有机生长。
 */

/**
 * 伊斯兰城市的状态（同一次生成里共用）：麦地那的 outline → exit → sites → assign → build 填好城墙、主街；
 * 有机生长的伊斯兰城（styles/islamic.ts）不经过 outline，第一次用到时按城心取默认值（城墙用 ctx.cityWalls）。
 */
interface State {
  /** 街坊间距（米） */
  S: number
  /** 城墙的中心（规划范围的中心：临海时从城心往岸上挪） */
  m: P
  /** 城墙线（闭合；有机生长时为空，改用 ctx.cityWalls） */
  loop: P[]
  /** 主街（从大清真寺旁到规划区边上），与出城方向 */
  exits: { line: P[]; dir: number }[]
  /** 礼拜朝向（全城的清真寺一致） */
  qibla: P
  /** 要塞的站点（城墙内侧的高处；没有要塞时为空） */
  kasbah?: P
  /** 已建浴场的位置（浴场彼此隔开些） */
  bathAt: P[]
  /** 已建的染坊、经学院、商队客栈、大清真寺、宫殿数 */
  tanneries: number
  madrasas: number
  khans: number
  great: number
  palaces: number
}

function fresh(ctx: Ctx, c: P, S = ctx.cfg.patch * 1.35, m = c, loop: P[] = []): State {
  const qa = hashAt(ctx, c, 'medina.fresh') * Math.PI * 2
  const s: State = { S, m, loop, exits: [], qibla: [Math.cos(qa), Math.sin(qa)], bathAt: [], tanneries: 0, madrasas: 0, khans: 0, great: 0, palaces: 0 }
  ctx.memo.set('medina', s)
  return s
}
export const st = (ctx: Ctx) => (ctx.memo.get('medina') as State | undefined) ?? fresh(ctx, ctx.center)

/** 尽端巷、集市巷的宽 */
const DERB_W = 2.4
const SOUQ_W = 3.2

const closed = (loop: P[]) => [...loop, loop[0]]
const inWall = (ctx: Ctx, q: P) => pointInPoly(q, st(ctx).loop)
/** 城墙线：麦地那的规划城墙，没有时用实际的城墙 */
const wallLoops = (ctx: Ctx) => {
  const s = st(ctx)
  return s.loop.length ? [s.loop] : ctx.cityWalls.map((w) => w.loop)
}
const nearWall = (ctx: Ctx, q: P, d: number) => wallLoops(ctx).some((l) => polylineDist(q, closed(l)) < d)

/**
 * 城墙线：以规划范围的中心 m（临海时从城心往岸上挪）为圆心、半径 R 上下起伏的一圈（几个低频的正弦叠加），再顺地形挪：
 * 墙往附近的高处靠（依山的城墙爬上山脊），临海处收回岸上；穿城的河不避（墙在河上断开）。
 * 城心 c（大清真寺）四周至少留一个街坊在墙里：离城心太近处墙往外推（落在水上的那段墙断开）。
 */
function wallLoop(ctx: Ctx, c: P, m: P, R: number, S: number): P[] {
  const { T } = ctx
  const N = 48
  const h0 = T.heightAt(c)
  const amp = [0.08, 0.055, 0.04, 0.03]
  const ph = amp.map((_, k) => hashAt(ctx, c, 'medina.wallPhase', k) * Math.PI * 2)
  const river = (q: P) => !!T.river && polylineDist(q, T.river.line) < 60
  let rs = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * Math.PI * 2
    const d: P = [Math.cos(a), Math.sin(a)]
    const r0 = R * (1 + amp.reduce((s, m, k) => s + m * Math.sin((k + 2) * a + ph[k]), 0))
    let best = r0
    let bs = -Infinity
    for (let f = 0.85; f <= 1.151; f += 0.05) {
      const r = r0 * f
      const q = add(m, d, r)
      const s = (T.heightAt(q) - h0) * 0.05 - ((r - r0) / R) ** 2 * 8 - (T.slopeAt(q) > 0.35 ? 1 : 0)
      if (s > bs) {
        bs = s
        best = r
      }
    }
    // 临海：退回岸上（离水 10 米）；河道两岸的点不退
    let r = best
    for (let q = add(m, d, r); r > R * 0.4 && (T.seaAt(q) || (T.waterAt(q) < 10 && !river(q))); q = add(m, d, r)) r -= 4
    return Math.max(R * 0.4, r)
  })
  // 城心周围半径 keep 的圆整个留在墙里：沿每条射线，墙至少要到圆的远端
  const keep = S * 1.35
  const cm: P = [c[0] - m[0], c[1] - m[1]]
  const need = rs.map((_, i) => {
    const a = (i / N) * Math.PI * 2
    const t = cm[0] * Math.cos(a) + cm[1] * Math.sin(a)
    const e2 = cm[0] ** 2 + cm[1] ** 2 - t * t
    return e2 < keep * keep ? t + Math.sqrt(keep * keep - e2) : 0
  })
  rs = rs.map((r, i) => Math.max(r, need[i]))
  for (let pass = 0; pass < 3; pass++) rs = rs.map((r, i) => Math.max(need[i], Math.min(r, rs[(i + N - 1) % N] * 0.25 + r * 0.5 + rs[(i + 1) % N] * 0.25)))
  return rs.map((r, i) => {
    const a = (i / N) * Math.PI * 2
    return add(m, [Math.cos(a), Math.sin(a)], r)
  })
}

/** 闭合折线上每个点的外法向 */
function outward(loop: P[], c: P, q: P, k: number): P {
  const a = loop[(k + loop.length - 1) % loop.length]
  const b = loop[(k + 1) % loop.length]
  const L = dist(a, b) || 1
  let n: P = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L]
  if ((q[0] - c[0]) * n[0] + (q[1] - c[1]) * n[1] < 0) n = [-n[0], -n[1]]
  return n
}

/**
 * 要塞的位置：城墙内侧、离主街与水远些的最高处。站点比别处离墙远一点、四周留空，
 * 切出的片区比一般街坊大，一直贴到城墙。
 */
function kasbahSite(ctx: Ctx, c: P): P | null {
  const { S, loop, exits, m } = st(ctx)
  if (!(ctx.counts.castle > 0) || ctx.p.size !== 'city' || ctx.p.walls === 'none') return null
  let best: P | null = null
  let bs = -Infinity
  loop.forEach((q, k) => {
    const p = add(q, outward(loop, m, q, k), -S * 0.6)
    if (dist(p, c) < S * 1.6 || ctx.T.waterAt(p) < S * 0.55 || exits.some((e) => polylineDist(p, e.line) < S * 0.95)) return
    const sc = ctx.T.heightAt(p) + hashAt(ctx, q, 'medina.kasbah') * 3
    if (sc > bs) {
      bs = sc
      best = p
    }
  })
  return best
}

export const medina: CityPlan = {
  id: 'medina',
  // 城墙外一般没有护城河；穿城的主街窄而弯，不种行道树；没有角斗场、剧场、比武场这类西式公共设施
  moat: false,
  mainWidth: 5,
  avenueTrees: false,
  exclude: ['arena', 'amphitheater', 'stage', 'pulpit', 'winery'],
  outline(ctx, z) {
    const S = ctx.cfg.patch * 1.35
    const m = z.fromUV(z.shift[0], z.shift[1])
    const loop = wallLoop(ctx, z.c, m, z.R, S)
    fresh(ctx, z.c, S, m, loop)
    // 规划区 = 城墙外再放出一圈街坊（门外的墓地、关厢）
    return loop.map((q, k) => add(q, outward(loop, m, q, k), S * 0.95))
  },
  /**
   * 主街：从大清真寺旁出发，按出城方向弯弯曲曲地走到规划区边上（穿过城墙处就是城门）。
   * 方向相近的干道并成一条主街、共用一座城门。
   */
  exit(ctx, z, dir) {
    const s = st(ctx)
    const near = s.exits.find((e) => Math.abs(Math.atan2(Math.sin(e.dir - dir), Math.cos(e.dir - dir))) < 0.6)
    if (near) return near.line
    const d0: P = [Math.cos(dir), Math.sin(dir)]
    const key = add(z.c, d0, 100)
    const ph = [0, 1, 2].map((k) => hashAt(ctx, key, 'medina.lanePhase', k) * Math.PI * 2)
    const lam = [55 + hashAt(ctx, key, 'medina.laneLam', 0) * 30, 24 + hashAt(ctx, key, 'medina.laneLam', 1) * 14]
    const line: P[] = [add(z.c, d0, s.S * 0.5)]
    const step = 8
    for (let t = 0; t < z.R * 4; t += step) {
      const ramp = Math.min(1, t / s.S)
      const a = dir + ramp * (0.5 * Math.sin(t / lam[0] + ph[0]) + 0.28 * Math.sin(t / lam[1] + ph[1]))
      const q = add(line[line.length - 1], [Math.cos(a), Math.sin(a)], step)
      line.push(q)
      if (!z.contains(q)) break
    }
    s.exits.push({ line, dir })
    return line
  },
  sites(ctx, z) {
    const { S, loop, exits } = st(ctx)
    const out: P[] = []
    const kas = kasbahSite(ctx, z.c)
    st(ctx).kasbah = kas ?? undefined
    if (kas) out.push(kas)
    const free = (q: P, d: number) => out.every((o) => dist(o, q) >= d) && (!kas || dist(q, kas) > S * 0.85)
    // 城墙两侧成对布点：墙落在街坊边界上，墙外一圈是门外的片区
    const ring = resample(closed(loop), S * 0.8)
    ring.pop()
    ring.forEach((q, k) => {
      const n = outward(ring, st(ctx).m, q, k)
      for (const sg of [-1, 1]) {
        const p = add(q, n, sg * S * 0.42)
        if (dist(p, z.c) > S * 0.9 && (sg > 0 ? out.every((o) => dist(o, p) >= S * 0.5) : free(p, S * 0.5))) out.push(p)
      }
    })
    // 主街两侧成对布点：主街走在街坊之间
    for (const e of exits) {
      const L = polylineLength(e.line)
      for (let t = S * 0.45; t < L; t += S * 0.85) {
        const { p: q, angle } = pointAt(e.line, t)
        if (!z.contains(q)) break
        const n: P = [-Math.sin(angle), Math.cos(angle)]
        for (const sg of [-1, 1]) {
          const p = add(q, n, sg * S * 0.45)
          if (dist(p, z.c) > S * 0.98 && free(p, S * 0.55)) out.push(p)
        }
      }
    }
    // 城里其余的街坊：世界坐标里的抖动网格，按位置哈希的优先级依次接受
    const g = S * 0.55
    const ox = ctx.MW / 2
    const oy = ctx.MH / 2
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const q of loop) {
      x0 = Math.min(x0, q[0])
      y0 = Math.min(y0, q[1])
      x1 = Math.max(x1, q[0])
      y1 = Math.max(y1, q[1])
    }
    const cands: { q: P; pr: number }[] = []
    for (let j = Math.floor((y0 - oy) / g) - 1; oy + j * g < y1 + g; j++)
      for (let i = Math.floor((x0 - ox) / g) - 1; ox + i * g < x1 + g; i++) {
        const cell: P = [ox + (i + 0.5) * g, oy + (j + 0.5) * g]
        const q: P = [cell[0] + (hashAt(ctx, cell, 'medina.site.x') - 0.5) * g, cell[1] + (hashAt(ctx, cell, 'medina.site.y') - 0.5) * g]
        cands.push({ q, pr: hashAt(ctx, cell, 'medina.site.order') })
      }
    cands.sort((a, b) => a.pr - b.pr)
    for (const { q } of cands) {
      if (!pointInPoly(q, loop) || dist(q, z.c) < S * 1.05 || nearWall(ctx, q, S * 0.36)) continue
      if (free(q, S * 0.82)) out.push(q)
    }
    return out.filter((q) => z.contains(q))
  },
  streets: () => [],
  assign(ctx, z, lots) {
    const { S, exits, loop } = st(ctx)
    const mains = exits.map((e) => e.line)
    const onMain = (q: P, d: number) => mains.some((l) => polylineDist(q, l) < d)
    const free = lots.filter((l) => l.type === undefined || l.type === 'plaza' || l.type === 'common')
    // 大清真寺：城心
    const center = lots.find((l) => dist(l.site, z.c) < 1)
    if (center) center.type = 'temple'
    // 集市：大清真寺周围、沿主街的几块
    const nSouq = Math.max(1, Math.min(6, Math.round((planPopOf(ctx.p) * ctx.p.planStrength!) / 4500) + 1))
    free
      .filter((l) => l !== center && dist(l.site, z.c) < S * 1.9 && onMain(l.site, S * 0.7))
      .sort((a, b) => dist(a.site, z.c) - dist(b.site, z.c))
      .slice(0, nSouq)
      .forEach((l) => (l.type = 'market'))
    // 要塞：布点时留好的那一块
    const kas = st(ctx).kasbah
    const kl = kas && lots.find((l) => dist(l.site, kas) < 1)
    if (kl) kl.type = 'castle'
    // 墓地：城门外、主街旁的片区
    const gates: P[] = ctx.cityWalls.length ? ctx.cityWalls.flatMap((w) => w.gates.map((gt) => gt.p)) : mains.map((l) => l.find((q) => !pointInPoly(q, loop))).filter((q): q is P => !!q)
    const nCem = Math.max(1, Math.min(gates.length, Math.round(planPopOf(ctx.p) / 9000) + 1))
    let placed = 0
    for (const gp of [...gates].sort((a, b) => hashAt(ctx, a, 'medina.gateOrder') - hashAt(ctx, b, 'medina.gateOrder'))) {
      if (placed >= nCem) break
      const l = free
        .filter((l) => !l.type && !pointInPoly(l.site, loop) && dist(l.site, gp) < S * 1.4 && l.poly.every((v) => ctx.T.waterAt(v) > 3))
        .sort((a, b) => dist(a.site, gp) - dist(b.site, gp))[0]
      if (l) {
        l.type = 'cemetery'
        placed++
      }
    }
  },
  build(ctx, ward, block, z) {
    // 城墙外的规划片区（关厢）照伊斯兰城的有机填法（styles/islamic.ts）
    if (!inWall(ctx, centroid(block))) return false
    switch (ward.type) {
      case 'temple':
        if (dist(centroid(ward.poly), z.c) < st(ctx).S * 0.6) greatMosque(ctx, ward, block)
        else smallMosque(ctx, block)
        return true
      case 'market':
        souq(ctx, ward, block)
        return true
      case 'castle':
        // 都城：要塞交给伊斯兰城的通用填法，盖成带四分园的宫殿（styles/islamic.ts 的 qasr）
        if (ctx.p.capital && st(ctx).palaces === 0) return false
        return kasbah(ctx, block)
      case 'plaza':
        rahba(ctx, block)
        return true
    }
    const o = FABRIC[ward.type]
    if (!o) return false
    // 城墙里还没住上人的街坊是果园、菜园
    if (ctx.wardFill <= 0.02 || ctx.houseBudget <= 0) {
      orchard(ctx, block)
      return true
    }
    const n0 = ctx.out.buildings.length
    quarter(ctx, ward, block, o, (planPopOf(ctx.p) * ctx.p.planStrength!) / 4000)
    if (!ctx.out.buildings.slice(n0).some((b) => b.kind === 'house' || b.kind === 'large')) orchard(ctx, block)
    return true
  },
  wall: (ctx) => st(ctx).loop,
}

// —————————————————————— 街坊：尽端巷与内院住宅 ——————————————————————

/** 各类住宅街坊的宅地大小与尽端巷的疏密 */
export const FABRIC: Partial<Record<Ward['type'], Fabric>> = {
  common: { maxA: 240, minA: 95, derb: 36 },
  slum: { maxA: 110, minA: 40, derb: 28 },
  merchant: { maxA: 270, minA: 110, derb: 44 },
  craft: { maxA: 230, minA: 80, derb: 40, work: true },
  noble: { maxA: 560, minA: 240, derb: 60, riad: true },
}

/**
 * 住宅街坊：尽端巷与内院住宅，偶有街坊里的公共设施（浴场；临水的工匠街坊是染坊）。
 * baths 为全城浴场数的上限（按人口）。
 */
export function quarter(ctx: Ctx, ward: Ward, block: Poly, o: Fabric, baths: number, reserve: Poly[] = []) {
  const s = st(ctx)
  const h = hashAt(ctx, centroid(ward.poly), 'medina.quarter')
  if (ward.type === 'craft' && block.some((v) => ctx.T.waterAt(v) < 14) && s.tanneries < 1 + Math.floor(planPopOf(ctx.p) / 20000)) {
    const t = tannery(ctx, block)
    if (t) {
      reserve.push(t)
      s.tanneries++
    }
  } else if (ward.type !== 'noble' && h < 0.3 && ctx.wardFill > 0.6 && s.bathAt.length < Math.max(1, Math.round(baths)) && s.bathAt.every((q) => dist(q, centroid(block)) > s.S * 1.5)) {
    const t = hammam(ctx, block)
    if (t) {
      reserve.push(t)
      s.bathAt.push(centroid(t))
    }
  }
  fabric(ctx, block, o, reserve)
}

/** 空着的街坊：围起来的果园（棕榈、橄榄、橘树） */
export function orchard(ctx: Ctx, block: Poly) {
  const g = placeable(ctx, insetConvex(block, 2), 2, 0.5)
  if (!g || area(g) < 200) return
  emitArea(ctx, 'greens', g, 'garden')
  emitArea(ctx, 'enclosures', g)
  scatterTrees(ctx, insetConvex(g, 2), 0.008, 2, 3.2)
}

export interface Fabric {
  /** 宅地面积上限 / 下限（m²） */
  maxA: number
  minA: number
  /** 尽端巷沿街的平均间距（米） */
  derb: number
  /** 大宅（riad）：院子是种树的花园 */
  riad?: boolean
  /** 工匠：一部分院子是作坊、堆场 */
  work?: boolean
  /** 主屋的层数上限（默认两层） */
  floors?: number
  /** 宅地盖房的比例（默认 1；疏的街坊留些园子） */
  fill?: number
  /** 只盖离街（道路走廊）这么近的宅地（城郊沿路） */
  reach?: number
}

/**
 * 一块街坊：先从四周的街上伸进尽端巷，再切成小宅地，每块盖一座内院住宅。
 * reserve 里的区域（清真寺、铺位）不盖。
 */
export function fabric(ctx: Ctx, block: Poly, o: Fabric, reserve: Poly[] = []) {
  const r0 = ctx.out.roads.length
  derbs(ctx, block, o.derb)
  const lots = subdivide(ctx, block, { maxA: o.maxA, minA: o.minA, alley: 0, alleyP: 0, depth: 10, fill: 1, irr: 0.9 })
  for (const lot of lots) {
    if (reserve.some((r) => pointInPoly(centroid(lot.poly), r))) continue
    if (o.reach !== undefined && ctx.corridors.gap(centroid(lot.poly)) > o.reach) continue
    if (o.fill !== undefined && ctx.rng.next() > o.fill) {
      // 空着的宅地是园子：围墙里种几棵果树
      const g = placeable(ctx, insetConvex(lot.poly, 1.2), 2)
      if (g && area(g) > 80 && ctx.rng.next() < 0.6) {
        emitArea(ctx, 'enclosures', g)
        scatterTrees(ctx, insetConvex(g, 1.5), 0.012, 1.8, 3)
      }
      continue
    }
    const q = placeable(ctx, insetConvex(lot.poly, 0.3))
    if (!q || area(q) < 30) continue
    courtHouse(ctx, q, o)
  }
  // 没有人家的巷子不留（街坊没住满时，尽端巷只通到有房子的地方）
  drop(ctx, 'roads', (r) => !ctx.occ.hitsPoint(r.line[r.line.length - 1], 4.5), r0)
}

/**
 * 尽端巷：沿街区每条临街边按间距取入口，巷子往里走一两折、偶尔分个叉就到头；
 * 巷子彼此、与对面的街都隔开一段（只进不通）。临城墙、临水的边不开巷。
 */
export function derbs(ctx: Ctx, block: Poly, spacing: number) {
  const rng = ctx.rng
  const core = insetConvex(block, 7)
  if (core.length < 3) return
  const c = centroid(block)
  const segs: [P, P][] = []
  const ok = (a: P, b: P) => pointInPoly(b, core) && segs.every(([s0, s1]) => segSegDist(a, b, s0, s1) > 10) && ctx.T.waterAt(b) > 4
  const lay = (line: P[]) => {
    addRoad(ctx, { line, width: DERB_W, kind: 'lane' }, 0.5)
  }
  for (let i = 0; i < block.length; i++) {
    const a = block[i]
    const b = block[(i + 1) % block.length]
    const L = dist(a, b)
    if (L < 16) continue
    const u: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    let n: P = [-u[1], u[0]]
    if ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]]
    let k = Math.floor(L / spacing)
    if (rng.next() < L / spacing - k) k++
    for (let j = 0; j < k; j++) {
      const t = (j + 0.5 + (rng.next() - 0.5) * 0.5) / k
      const e = add(a, u, L * t)
      if (nearWall(ctx, e, 16) || ctx.T.waterAt(add(e, n, -4)) < 3 || ctx.occ.hitsPoint(add(e, n, 2), 0)) continue
      const pts: P[] = [add(e, n, -1.5), e]
      let cur = e
      let h = rot(n, (rng.next() - 0.5) * 0.5)
      const nseg = 1 + Math.floor(rng.next() * 3)
      for (let s = 0; s < nseg; s++) {
        let len = 9 + rng.next() * 11
        let nxt = add(cur, h, len)
        if (!ok(cur, nxt)) {
          len *= 0.55
          nxt = add(cur, h, len)
          if (len < 6 || !ok(cur, nxt)) break
        }
        segs.push([cur, nxt])
        pts.push(nxt)
        cur = nxt
        h = rot(h, (rng.next() < 0.5 ? -1 : 1) * (0.4 + rng.next() * 0.8))
      }
      if (pts.length < 3) continue
      lay(pts)
      // 分叉：从中途的一点横着伸出一小段
      if (pts.length >= 4 && rng.next() < 0.45) {
        const m = 2 + Math.floor(rng.next() * (pts.length - 3))
        const d: P = [pts[m][0] - pts[m - 1][0], pts[m][1] - pts[m - 1][1]]
        const dl = Math.hypot(d[0], d[1]) || 1
        const side = rng.next() < 0.5 ? -1 : 1
        const br = add(pts[m], [(-d[1] / dl) * side, (d[0] / dl) * side], 7 + rng.next() * 6)
        if (ok(pts[m], br)) {
          segs.push([pts[m], br])
          lay([pts[m], br])
        }
      }
    }
  }
}


/** 附属的一翼：占地、画出来，但不另算一户（一座院子是一户人家） */
export const wing = (ctx: Ctx, poly: Poly, kind: BuildingKind = 'house') => place(ctx, poly, kind, {}, { floors: 1, units: 0 })

/**
 * 内院住宅：宅地取成矩形，四面（或三面）的屋子围着中间一方小院；对外是实墙，院子朝内。
 * 太小的宅地只盖一座屋。主屋算一户（一两层），其余几翼只占地。
 */
export function courtHouse(ctx: Ctx, q: Poly, o: Fabric) {
  const rng = ctx.rng
  const ax = obb(q).axis
  const r = inscribedRect(q, ax, { minSide: 4, bands: [[0, 1], [0.05, 0.95], [0, 0.85], [0.15, 1], [0.1, 0.8]] })
  if (!r || area(r) < 24) return
  const { u0, u1, v0, v1, box } = localBox(r, ax)
  const w = u1 - u0
  const d = v1 - v0
  if (Math.min(w, d) < 9 || w * d < 100) {
    addBuilding(ctx, r, 'house', 0, o.floors ?? 2)
    return
  }
  const t = Math.max(3.2, Math.min(o.riad ? 6.5 : 4.8, Math.min(w, d) * 0.3))
  // 作坊：临巷一排屋，院子是堆场（染缸、晾架）
  if (o.work && rng.next() < 0.35) {
    if (!addBuilding(ctx, box(u0, u1, v0, v0 + t + 1), 'house', 0, o.floors ?? 2)) return
    const yard = box(u0 + 0.6, u1 - 0.6, v0 + t + 1.6, v1 - 0.6)
    emitArea(ctx, 'enclosures', yard)
    if (rng.next() < 0.6) wing(ctx, box(u0 + 0.8, u0 + 0.8 + Math.min(6, w * 0.4), v1 - 0.8 - Math.min(5, d * 0.3), v1 - 0.8), 'shed')
    return
  }
  const parts: [Poly, boolean][] = [
    [box(u0, u1, v0, v0 + t), true],
    [box(u0, u1, v1 - t, v1), o.riad || rng.next() > 0.15],
    [box(u0, u0 + t, v0 + t, v1 - t), true],
    [box(u1 - t, u1, v0 + t, v1 - t), o.riad || rng.next() > 0.3],
  ]
  if (!addBuilding(ctx, parts[0][0], o.riad ? 'large' : 'house', 0, o.floors ?? 2)) return
  for (const [p, keep] of parts.slice(1)) if (keep) wing(ctx, p)
  const court = box(u0 + t, u1 - t, v0 + t, parts[1][1] ? v1 - t : v1 - 0.4)
  if (area(court) < 6) return
  emitArea(ctx, 'greens', court, o.riad ? 'garden' : 'courtyard')
  // 院心：大宅的花园种几棵树，小院偶尔一棵
  const cc = centroid(court)
  const { u0: a0, u1: a1, v0: b0, v1: b1 } = localBox(court, ax)
  const cw = Math.min(a1 - a0, b1 - b0)
  if (o.riad && cw > 6) {
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const tp: P = add(add(cc, ax, du * (a1 - a0) * 0.25), [-ax[1], ax[0]], dv * (b1 - b0) * 0.25)
      ctx.out.trees.push({ p: tp, r: Math.min(2.4, cw * 0.18) })
    }
  } else if (cw > 4.5 && rng.next() < 0.3) ctx.out.trees.push({ p: cc, r: Math.min(2.2, cw * 0.35) })
}

// —————————————————————— 清真寺 ——————————————————————

/**
 * 按街区位置抽签的清真寺（同一处每次都一样）：礼拜殿、穹顶、庭院、宣礼塔按清真寺的语法拼（见 compose/islamic.ts）。
 * 大寺是柱厅、T 形、四伊旺或奥斯曼式，街区小寺可以没有庭院。
 */
export function placeMosque(ctx: Ctx, zone: Poly, block: Poly, D0: number, W0: number, big: boolean): Poly | null {
  const q = st(ctx).qibla
  const C = composer(siteDice(ctx, centroid(block), 'mosque'), big ? 'mosque' : 'masjid', MOSQUE_PRESETS(big), { size: Math.min(D0, W0), rank: big ? 1 : 0 })
  const form = mosqueForm(C, big)
  // 庭院深浅（礼拜殿的进深占比）与整体的长宽
  const deep = C.num('deep', big ? 0.34 : 0.42, big ? 0.5 : 0.56)
  const k = C.num('k', 0.88, 1.15)
  const try1 = (o: MosqueForm, k: number, deep: number) =>
    fit(
      zone,
      (m, s) => mosqueParts(m, q, D0 * k * s, W0 * s, D0 * k * s * deep, big ? 5 * s : 3.5 * s, o),
      (t) => t.parts.every(([p]) => inside(p, block) && isFree(ctx, p, { pad: 1 })),
      [1, 0.9, 0.8, 0.7, 0.6],
    )
  // 抽到的形制放不下：退回最朴素的一种（一座门边的塔、一座穹顶）
  let got = try1(form, k, deep)
  if (!got) {
    got = try1(plainMosque(form.side, form.plan === 'kiosk'), 1, big ? 0.42 : 0.5)
    C.note('built', 'plain')
  }
  if (!got || !addGroup(ctx, got.parts, 1)) return null
  if (got.sahn) {
    emitArea(ctx, 'plazas', got.sahn)
    const c = centroid(got.sahn)
    // 庭院中央的净水池
    if (form.fountain && area(got.sahn) > 150) {
      ctx.out.landmarks.push({ p: c, kind: 'fountain' })
      ctx.occ.add(circlePoly(c, 2.5, 10))
    }
  }
  ctx.occ.add(got.whole)
  C.done(centroid(got.whole))
  return got.whole
}

/** 大清真寺：城心的一大组建筑；四周紧贴着铺位与住宅 */
export function greatMosque(ctx: Ctx, ward: Ward, block: Poly) {
  const big = ctx.p.size === 'city'
  // 合成的大清真寺（grand）：几块片区合起来的地盘，柱厅、庭院都大一圈
  const grand = ctx.tier === 'grand'
  const zone = insetConvex(block, 2)
  // grand 的尺寸按合成的地盘收（狭长的地盘放不下百米见方的大寺）
  const ob = obb(block)
  const [D0, W0] = grand ? [Math.min(108, ob.len * 0.8), Math.min(92, ob.wid * 0.85)] : [big ? 74 : 50, big ? 64 : 44]
  const whole = zone.length >= 3 ? placeMosque(ctx, zone, block, Math.max(D0, W0), Math.min(D0, W0), true) : null
  st(ctx).great++
  const name = ctx.namer.islamic('greatMosque')
  ctx.out.landmarks.push({ p: whole ? centroid(whole) : centroid(block), name, kind: 'temple' })
  ward.name = undefined
  stalls(ctx, block, [])
  fabric(ctx, block, { maxA: 200, minA: 80, derb: 60 }, whole ? [whole] : [])
}

/** 街区清真寺：小礼拜殿 + 小院 + 宣礼塔，其余照常是住宅 */
export function smallMosque(ctx: Ctx, block: Poly, o: Fabric = { maxA: 185, minA: 70, derb: 36 }) {
  const zone = insetConvex(block, 6)
  const whole = zone.length >= 3 ? placeMosque(ctx, zone, block, 32, 26, false) : null
  if (whole) ctx.out.landmarks.push({ p: centroid(whole), name: ctx.namer.islamic('mosque'), kind: 'temple' })
  fabric(ctx, block, o, whole ? [whole] : [])
}

// —————————————————————— 集市、广场、要塞 ——————————————————————

/** 沿一条线的一侧排铺位（窄小的店面，一间挨一间） */
export function stallRow(ctx: Ctx, a: P, b: P, n: P, off: number) {
  const L = dist(a, b)
  const u: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  const w = 3.1
  const dep = 4.2 + ctx.rng.next() * 1.2
  for (let t = 2; t + w < L - 2; t += w + 0.35) {
    const c = add(add(a, u, t + w / 2), n, off + dep / 2)
    addBuilding(ctx, rect(c, u, w, dep), 'shed')
  }
  // 铺位一排登记成走廊：后面的宅地退到铺位后面
  ctx.corridors.add([add(a, n, off + dep / 2), add(b, n, off + dep / 2)], dep / 2 + 0.3)
}

/** 街区各条临街边（不临城墙、不临水）的内侧排铺位 */
export function stalls(ctx: Ctx, block: Poly, skip: Poly[]) {
  const c = centroid(block)
  for (let i = 0; i < block.length; i++) {
    const a = block[i]
    const b = block[(i + 1) % block.length]
    const L = dist(a, b)
    if (L < 12) continue
    const m: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    if (nearWall(ctx, m, 16) || skip.some((s) => pointInPoly(m, s))) continue
    let n: P = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]
    if ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]]
    if (ctx.T.waterAt(add(m, n, -5)) < 3) continue
    stallRow(ctx, a, b, n, 0.4)
  }
}

/** 过 o、沿 d（单位向量）的直线落在多边形里的一段；短于 10 米返回 null */
function throughLine(poly: Poly, o: P, d: P): [P, P] | null {
  const n: P = [-d[1], d[0]]
  const c = chord(poly, d, n, o[0] * n[0] + o[1] * n[1])
  if (!c || c[1] - c[0] <= 10) return null
  const s = o[0] * d[0] + o[1] * d[1]
  return [add(o, d, c[0] - s), add(o, d, c[1] - s)]
}

/**
 * 集市（souq）：一条有顶的集市巷顺着街区的长向穿过（长街区再横穿一条），巷子两侧与街区临街的一圈都是窄小的铺位；
 * 大些的集市里有一座商队客栈（funduq，围着庭院的一圈房），其余是商人的宅院。
 */
export function souq(ctx: Ctx, ward: Ward, block: Poly) {
  const rng = ctx.rng
  const b = obb(block)
  const c = centroid(block)
  const lanes: [P, P][] = []
  const dirs: P[] = [b.axis]
  if (b.wid > 70) dirs.push([-b.axis[1], b.axis[0]])
  for (const d of dirs) {
    const ch = throughLine(block, c, d)
    if (!ch) continue
    const line: P[] = [add(ch[0], d, -2.5), add(ch[1], d, 2.5)]
    if (line.some((q) => ctx.T.waterAt(q) < 3)) continue
    addRoad(ctx, { line, width: SOUQ_W, kind: 'lane' }, 0.4)
    lanes.push(ch)
  }
  for (const [a, e] of lanes) {
    const L = dist(a, e)
    const u: P = [(e[0] - a[0]) / L, (e[1] - a[1]) / L]
    for (const sg of [-1, 1]) stallRow(ctx, a, e, [-u[1] * sg, u[0] * sg], SOUQ_W / 2 + 0.45)
  }
  stalls(ctx, block, [])
  // 商队客栈
  if (area(block) > 4500 && rng.next() < 0.85) {
    const zone = insetConvex(block, 8)
    if (zone.length >= 3) khan(ctx, block, zone, b.axis, ctx.p.size === 'city' ? 30 : 22)
  }
  fabric(ctx, block, { maxA: 240, minA: 90, derb: 70 })
  ward.name = ctx.namer.islamic('souq')
}

/**
 * 商队客栈（funduq / khan）：围着方院的一圈房，临街一面算一户（看店的人家），其余几翼只占地。
 * 返回整个占地，放不下时为 null。
 */
export function khan(ctx: Ctx, block: Poly, zone: Poly, axis: P, s0: number, kind: BuildingKind = 'large'): Poly | null {
  const got = fit(
    zone,
    (q, s) => {
      const L = s0 * s
      const t = 6 * s
      const { u0, u1, v0, v1, box } = localBox(rect(q, axis, L, L * 0.85), axis)
      return { court: box(u0 + t, u1 - t, v0 + t, v1 - t), parts: [box(u0, u1, v0, v0 + t), box(u0, u1, v1 - t, v1), box(u0, u0 + t, v0 + t, v1 - t), box(u1 - t, u1, v0 + t, v1 - t)], foot: box(u0, u1, v0, v1) }
    },
    (t) => t.parts.every((p) => inside(p, block) && isFree(ctx, p, { pad: 0.5 })),
    [1, 0.85, 0.7],
  )
  if (!got || !addBuilding(ctx, got.parts[0], kind, 0.5, 2)) return null
  for (const p of got.parts.slice(1)) wing(ctx, p, kind)
  emitArea(ctx, 'plazas', got.court)
  ctx.occ.add(got.court)
  return got.foot
}

/** 街区里的小广场（rahba）：一块铺地，中间一座水泉，四周照常是住宅 */
export function rahba(ctx: Ctx, block: Poly) {
  const b = obb(block)
  const zone = insetConvex(block, 4)
  const sq = zone.length >= 3 && fit(zone, (q, s) => rect(q, b.axis, 34 * s, 26 * s), (p) => inside(p, block) && isFree(ctx, p, { pad: 0.5 }), [1, 0.8, 0.6])
  if (sq) {
    const pave = ctx.corridors.clip(sq, ['wall']) ?? sq
    emitArea(ctx, 'plazas', pave)
    ctx.occ.add(pave)
    ctx.out.landmarks.push({ p: centroid(pave), kind: 'fountain' })
    stallRow(ctx, pave[0], pave[1], [(pave[3][0] - pave[0][0]) / (dist(pave[0], pave[3]) || 1), (pave[3][1] - pave[0][1]) / (dist(pave[0], pave[3]) || 1)], -6.4)
  }
  fabric(ctx, block, { maxA: 200, minA: 80, derb: 38 }, sq ? [sq] : [])
}

/**
 * 要塞（kasbah）：贴着城墙的一圈幕墙与方塔，里面是总督府（围着庭院的宫殿）、一座小清真寺、
 * 沿幕墙的兵营与仓房，中间是校场。
 */
export function kasbah(ctx: Ctx, block: Poly): boolean {
  const rng = ctx.rng
  let curtain: Poly | null = null
  for (const d of [3, 6, 10, 14]) {
    const q = clipWater(ctx, insetConvex(block, d), 4)
    if (q && q.length >= 3 && area(q) > 1600 && !ctx.corridors.hitsPoly(q, 1, ['road', 'river', 'wall'])) {
      curtain = q
      break
    }
  }
  if (!curtain) return false
  const c = centroid(curtain)
  emitArea(ctx, 'plazas', curtain)
  // 门朝城里
  const toC: P = [ctx.center[0] - c[0], ctx.center[1] - c[1]]
  let gi = 0
  let gd = -Infinity
  for (let i = 0; i < curtain.length; i++) {
    const a = curtain[i]
    const e = curtain[(i + 1) % curtain.length]
    const m: P = [(a[0] + e[0]) / 2 - c[0], (a[1] + e[1]) / 2 - c[1]]
    const s = (m[0] * toC[0] + m[1] * toC[1]) / (Math.hypot(...m) || 1)
    if (s > gd && dist(a, e) > 12) {
      gd = s
      gi = i
    }
  }
  const ga = curtain[gi]
  const gb = curtain[(gi + 1) % curtain.length]
  const towers: P[] = []
  curtain.forEach((a, i) => {
    const e = curtain![(i + 1) % curtain!.length]
    towers.push(a)
    const L = dist(a, e)
    const k = Math.floor(L / 28)
    for (let j = 1; j <= k; j++) if (i !== gi) towers.push([a[0] + ((e[0] - a[0]) * j) / (k + 1), a[1] + ((e[1] - a[1]) * j) / (k + 1)])
  })
  const wall = addWall(
    ctx,
    {
      loop: curtain,
      solid: curtain.map(() => true),
      towers,
      gates: [{ p: [(ga[0] + gb[0]) / 2, (ga[1] + gb[1]) / 2], angle: Math.atan2(gb[1] - ga[1], gb[0] - ga[0]) + Math.PI / 2 }],
      kind: 'stone',
      thickness: 3,
    },
    'keep',
  )
  ctx.out.landmarks.push({ p: c, name: ctx.namer.islamic('kasbah'), kind: 'castle' })
  // 沿幕墙的兵营、仓房（门所在的那面墙留空）
  for (let i = 0; i < curtain.length; i++) {
    if (i === gi) continue
    const a = curtain[i]
    const e = curtain[(i + 1) % curtain.length]
    const L = dist(a, e)
    if (L < 18) continue
    const u: P = [(e[0] - a[0]) / L, (e[1] - a[1]) / L]
    let n: P = [-u[1], u[0]]
    if ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]]
    const d = 6 + rng.next() * 2
    const k = Math.max(1, Math.round((L - 12) / 30))
    const seg = (L - 12) / k
    for (let j = 0; j < k; j++) {
      if (rng.next() < 0.2) continue
      const hall = rect(add(add(a, u, 6 + seg * (j + 0.5)), n, 3 + d / 2), u, seg - 4, d)
      if (inside(hall, curtain)) addBuilding(ctx, hall, 'hall', 0.5)
    }
  }
  const court = insetConvex(curtain, 4)
  if (court.length < 3) return true
  const b = obb(court)
  // 总督府：离门远的一侧
  const away: P = [-toC[0] / (Math.hypot(...toC) || 1), -toC[1] / (Math.hypot(...toC) || 1)]
  const ps = Math.min(34, Math.sqrt(area(court)) * 0.45)
  const pal = fit(
    court,
    (q, s) => {
      const m = add(q, away, b.wid * 0.12)
      const t = 6 * s
      const { u0, u1, v0, v1, box } = localBox(rect(m, b.axis, ps * s, ps * 0.8 * s), b.axis)
      return [box(u0, u1, v0, v0 + t), box(u0, u1, v1 - t, v1), box(u0, u0 + t, v0 + t, v1 - t), box(u1 - t, u1, v0 + t, v1 - t)]
    },
    (parts) => parts.every((p) => inside(p, court) && isFree(ctx, p, { pad: 1 })),
    [1, 0.85, 0.7, 0.55],
  )
  if (pal && addGroup(ctx, pal.map((p) => [p, 'keep'] as [Poly, BuildingKind]), 1)) {
    const { u0, u1, v0, v1, box } = localBox([...pal[0], ...pal[1]], b.axis)
    const t = Math.min(6, (u1 - u0) * 0.2)
    emitArea(ctx, 'greens', box(u0 + t, u1 - t, v0 + t, v1 - t), 'garden')
  }
  // 要塞里的小清真寺
  const mz = insetConvex(court, 2)
  if (mz.length >= 3) placeMosque(ctx, mz, court, 22, 18, false)
  // 要塞的门接上路
  connectGates(ctx, [wall])
  scatterTrees(ctx, court, 0.001, 2, 3)
  return true
}

/** 兴趣点的小字标注（没有对应的地标种类） */
export function poi(ctx: Ctx, p: P, text: Tri) {
  ctx.out.labels.push({ text, p, angle: 0, kind: 'poi', weight: 1 })
}

/** 浴场：临街的一座长屋，屋顶几个小圆穹 */
export function hammam(ctx: Ctx, block: Poly): Poly | null {
  const zone = insetConvex(block, 4)
  if (zone.length < 3) return null
  const b = obb(block)
  const got = fit(
    zone,
    (q, s) => {
      const L = 20 * s
      const W = 12 * s
      const parts: [Poly, BuildingKind][] = [[rect(q, b.axis, L, W), 'civic']]
      for (const k of [-1, 0, 1]) parts.push([circlePoly(add(q, b.axis, k * L * 0.3), W * 0.2, 12), 'civic'])
      return { parts, foot: rect(q, b.axis, L + 2, W + 2) }
    },
    (t) => t.parts.every(([p]) => inside(p, block) && isFree(ctx, p, { pad: 0.5 })),
    [1, 0.8],
  )
  if (!got || !addGroup(ctx, got.parts, 0.5)) return null
  poi(ctx, centroid(got.foot), ctx.namer.islamic('hammam'))
  return got.foot
}

/** 染坊（皮革作坊）：临水的一方院子，地上一格格的圆染缸 */
export function tannery(ctx: Ctx, block: Poly): Poly | null {
  const zone = insetConvex(block, 3)
  if (zone.length < 3) return null
  const b = obb(block)
  const yard = fit(zone, (q, s) => rect(q, b.axis, 26 * s, 18 * s), (p) => inside(p, block) && isFree(ctx, p, { pad: 0.5 }), [1, 0.8, 0.65])
  if (!yard) return null
  emitArea(ctx, 'plazas', yard)
  emitArea(ctx, 'enclosures', yard)
  const { u0, u1, v0, v1 } = localBox(yard, b.axis)
  const n: P = [-b.axis[1], b.axis[0]]
  for (let u = u0 + 2.2; u < u1 - 1.5; u += 2.9)
    for (let v = v0 + 2.2; v < v1 - 1.5; v += 2.9) {
      const c: P = [b.axis[0] * u + n[0] * v, b.axis[1] * u + n[1] * v]
      addBuilding(ctx, circlePoly(c, 1.05, 8), 'shed')
    }
  ctx.occ.add(yard)
  poi(ctx, centroid(yard), ctx.namer.islamic('tannery'))
  return yard
}
