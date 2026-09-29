import { hashAt, memo, type Ctx } from '../ctx'
import { centroid, pointInPoly, splitConvex, unit, type P, type Poly } from '../geom'
import { farm, vegetation, wild } from '../outer'
import { buke, castle, jiin, machiya, MASU } from './jokamachi-build'
import { rectOutline, RESIDENTIAL as MACHI } from './common'
import { checkpoint, drop, rollback } from '../undo'
import type { CityPlan, PlanRoad, PlanZone } from './types'
import { planPopOf, scaleOf } from '../scale'

/**
 * 城下町（江户时代日本的形制，缩到地图的尺度）：
 * - 城堡居中：外堀、石垣围着二之丸，里面再一道内堀围着本丸与天守；
 * - 按身份同心分层：城堡外一圈是武家地（上级武士的大宅院），再外是町人地（面宽窄、进深长的町屋，
 *   街区中间是会所地、里长屋），外缘一侧是一列寺町（寺院排成带，兼作防线）；
 * - 道路有意曲折：通往城堡的街在每一圈都错开（丁字路、食违），干道进城要拐几个直角，入口处是枡形；
 * - 没有外郭城墙，靠城堡的堀与寺町防守；规划区外照旧是沿街蔓延的町家。
 *
 * 规划区是以城为心的一圈圈方环：第 0 圈是城堡（城心片区），第 1 圈（大城再加第 2 圈）是武家地，
 * 其后是町人地，最外一圈在背面（大城再加一侧）是寺町。各圈的宽度按世界坐标固定，人口多了只是向外多几圈。
 */

/** 方环的四个方向（局部坐标 u, v；y 向下为南）：东、南、西、北 */
const SIDES: P[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]
/** 町人地一圈的宽（米）：京间六十间四方的町割，缩到地图上 */
const BLOCK = 110

export interface Masu {
  side: number
  /** 枡形在规划区外缘（r = b[K]）、横向位置 t，门向 sgn 一侧拐出 */
  t: number
  sgn: number
}

export interface Layout {
  /** 城堡片区的半宽 */
  C: number
  /** 各圈的外沿 b[0..K]（b[0] = C）与站点位置 p[0..K]（p[0] = 0 是城心） */
  b: number[]
  p: number[]
  K: number
  /** 武家地的圈数 */
  ns: number
  /** 大手（城堡正面）朝哪一侧；第一条干道的方向 */
  front: number
  /** 寺町在哪几侧 */
  temples: number[]
  /** 有干道出城的侧与枡形 */
  exitSides: Set<number>
  masu: Masu[]
  routes: P[][]
}

const layoutOf = (ctx: Ctx, z: Pick<PlanZone, 'R'>) => memo(ctx, 'jokamachi', () => makeLayout(ctx, z))

function makeLayout(ctx: Ctx, z: Pick<PlanZone, 'R'>): Layout {
  const big = planPopOf(ctx.p) >= 30000
  const city = scaleOf(planPopOf(ctx.p)).size === 'city'
  const C = big ? 160 : city ? 120 : 90
  // 方形规划区与同面积的圆：半宽 ≈ 0.886 R
  const H = z.R * 0.886
  const b = [C]
  const p = [0]
  // 站点交替落在两条边界之间：d 是上一个站点到这一圈内沿的距离，宽度不够就放宽这一圈，保证站点离两边都不太近
  let d = C
  for (let k = 1; ; k++) {
    let w = k === 1 ? C + 30 : BLOCK
    while (w - d < 24) w += 10
    p.push(b[k - 1] + d)
    b.push(b[k - 1] + w)
    d = w - d
    if (b[k] >= H - w * 0.5 || k >= 12) break
  }
  const K = b.length - 1
  return { C, b, p, K, ns: K >= 5 ? 2 : 1, front: -1, temples: [], exitSides: new Set(), masu: [], routes: [] }
}

/** 坐标所在的圈：|x| ≤ b[0] 是第 0 圈 */
const bandOf = (L: Layout, x: number) => {
  const a = Math.abs(x)
  for (let k = 0; k <= L.K; k++) if (a <= L.b[k] + 1e-6) return k
  return L.K + 1
}

/** 横向街线的带号：中轴 0，±b[a] 为 ±(a + 1)；相邻街线奇偶交替，错开的丁字路按它排 */
const lineIndex = (L: Layout, x: number) => {
  if (Math.abs(x) < 1e-6) return 0
  const a = L.b.findIndex((y) => Math.abs(Math.abs(x) - y) < 1e-6)
  return Math.sign(x) * (a + 1)
}

/**
 * 某条街线上、落在某一圈里的一段在不在：顺着城边的"环街"都在，朝城堡的"纵街"逐圈错开（奇偶交替），
 * 走到头是丁字路，不让人一眼望到城门（城门正对着武家地的街区）。
 */
function kept(L: Layout, x: number, band: number) {
  const a = Math.abs(x) < 1e-6 ? -1 : L.b.findIndex((y) => Math.abs(Math.abs(x) - y) < 1e-6)
  if (a === L.K) return false
  if (band > L.K) return false
  // 中轴线不进城堡
  if (a < 0 && band === 0) return false
  // 环街（街线位置在这一圈以外）
  if (a >= band) return true
  return (lineIndex(L, x) + band) % 2 === 0
}

/** 侧 s 的 (r 纵深, t 横向) → 局部 uv */
const sideUV = (s: number, r: number, t: number): P => {
  const d = SIDES[s]
  return [d[0] * r - d[1] * t, d[1] * r + d[0] * t]
}

/** 片区（按局部坐标）属于哪一圈、哪一侧 */
function cellOf(L: Layout, uv: P) {
  const bu = bandOf(L, uv[0])
  const bv = bandOf(L, uv[1])
  const ring = Math.max(bu, bv)
  const side = Math.abs(uv[0]) >= Math.abs(uv[1]) ? (uv[0] >= 0 ? 0 : 2) : uv[1] >= 0 ? 1 : 3
  // 角上那一格同时属于两侧
  const sides = bu === bv ? [uv[0] >= 0 ? 0 : 2, uv[1] >= 0 ? 1 : 3] : [side]
  return { ring, side, sides }
}

export const jokamachi: CityPlan = {
  id: 'jokamachi',
  // 和风的片区名：武家地〇〇丁、町人地与市按行业（呉服町、鍛冶町……）、寺町一处；规划区外沿街蔓延的町家也叫〇〇町
  districtName(ctx, ward, z) {
    const c = centroid(ward.poly)
    const inside = z.contains(c)
    if (inside && ward.type === 'noble') return hashAt(ctx, c, 'jokamachi.name.samurai') < 0.5 ? (ctx.namer.wa('samurai') ?? null) : null
    if (inside && ward.type === 'temple') return ctx.namer.wa('teramachi') ?? null
    if (MACHI.has(ward.type) || ward.type === 'market' || ward.type === 'suburb') return hashAt(ctx, c, 'jokamachi.name.machi') < (inside ? 0.4 : 0.3) ? (ctx.namer.wa('machi') ?? null) : null
    return inside ? null : undefined
  },
  // 城堡、武家屋敷、寺院住的人少，住下同样多的人要比有机的城区大一些
  scale: 1.15,
  outline(ctx, z) {
    const L = layoutOf(ctx, z)
    const B = L.b[L.K]
    return rectOutline(z, -B, B, -B, B)
  },
  sites(ctx, z) {
    const L = layoutOf(ctx, z)
    const xs = [...L.p.slice(1).map((x) => -x).reverse(), ...L.p]
    const out: P[] = []
    for (const v of xs) for (const u of xs) if (u !== 0 || v !== 0) out.push(z.fromUV(u, v))
    return out
  },
  streets(ctx, z) {
    const L = layoutOf(ctx, z)
    // 街线：各圈的边界与中轴；沿线按圈分段，留下的段首尾相接的并成一条
    const lines = [...L.b.map((x) => -x).reverse(), 0, ...L.b]
    const out: PlanRoad[] = []
    const W = ctx.cfg.lane + 2.5
    for (const vertical of [true, false])
      for (const x of lines) {
        const at = (y: number) => (vertical ? z.fromUV(x, y) : z.fromUV(y, x))
        let y0: number | null = null
        let main = false
        const flush = (y1: number) => {
          if (y0 !== null && y1 > y0) out.push({ line: [at(y0), at(y1)], width: main ? ctx.cfg.main : W, kind: main ? 'main' : 'street', named: main || y1 - y0 > 260 })
          y0 = null
        }
        for (let i = 0; i + 1 < lines.length; i++) {
          const a = lines[i]
          const c = lines[i + 1]
          const band = bandOf(L, (a + c) / 2)
          // 城堡四周的一圈是堀端的大街
          const m = Math.abs(Math.abs(x) - L.C) < 1e-6 && band === 0
          const keep = kept(L, x, band) && !steep(ctx, at(a), at(c))
          if (y0 !== null && (!keep || m !== main)) flush(a)
          if (keep && y0 === null) {
            y0 = a
            main = m
          }
        }
        flush(lines[lines.length - 1])
      }
    return out
  },
  exit(ctx, z, dir) {
    const L = layoutOf(ctx, z)
    const d = z.toUV([z.c[0] + Math.cos(dir), z.c[1] + Math.sin(dir)])
    const s = Math.abs(d[0]) >= Math.abs(d[1]) ? (d[0] >= 0 ? 0 : 2) : d[1] >= 0 ? 1 : 3
    const world = (r: number, tv: number) => {
      const uv = sideUV(s, r, tv)
      return z.fromUV(uv[0], uv[1])
    }
    const dry = (r: number, tv: number) => ctx.T.waterAt(world(r, tv)) > 8
    // 本侧的纵深与横向分量：干道原本在规划区外沿上的横向位置
    const rr = d[0] * SIDES[s][0] + d[1] * SIDES[s][1]
    const tt = -d[0] * SIDES[s][1] + d[1] * SIDES[s][0]
    const { b, K } = L
    const lim = b[Math.max(0, K - 1)]
    const target = Math.max(-lim, Math.min(lim, (b[K] * tt) / Math.max(0.2, rr)))
    // 从大手门（城边大街的正中）出发，逐圈往外走；每圈的纵街错开，到环街上拐一个直角
    const walk = (goal: number) => {
      const pts: [number, number][] = [[b[0], 0]]
      let t = 0
      for (let c = 1; c <= K; c++) {
        const cands = [0, ...b.slice(0, c).flatMap((x) => [x, -x])].filter((x) => kept(L, x, c))
        let best = t
        let bs = Infinity
        for (const x of cands) {
          const sc = Math.abs(x - goal) + Math.abs(x - t) * 0.3
          if (sc < bs) {
            bs = sc
            best = x
          }
        }
        if (best !== t) pts.push([b[c - 1], best])
        t = best
        pts.push([b[c], t])
      }
      return { pts, t }
    }
    // 出口落在水里（临河、临海的一侧）就换一条街出去；枡形放不下就直接出去
    const goals = [target, ...[0, ...b.slice(0, K).flatMap((x) => [x, -x])].sort((x, y) => Math.abs(x - target) - Math.abs(y - target))]
    for (const goal of goals) {
      const { pts, t } = walk(goal)
      const sgn = t > 0 ? -1 : 1
      const m = MASU
      const masu: [number, number][] = [[b[K] + m.turn, t], [b[K] + m.turn, t + sgn * m.out], [b[K] + m.turn + 10, t + sgn * m.out]]
      const box: [number, number][] = [[b[K], t - m.half], [b[K], t + m.half], [b[K] + 2 * m.half + 4, t - m.half], [b[K] + 2 * m.half + 4, t + m.half]]
      let tail: [number, number][] | null = null
      if ([...masu, ...box].every(([r, tv]) => dry(r, tv))) {
        tail = masu
        if (!L.masu.some((q) => q.side === s && Math.abs(q.t - t) < 1)) L.masu.push({ side: s, t, sgn })
      } else if (dry(b[K] + 20, t) && dry(b[K], t)) tail = [[b[K] + 20, t]]
      if (!tail) continue
      if (L.front < 0) L.front = s
      L.exitSides.add(s)
      const route = [...pts, ...tail].map(([r, tv]) => world(r, tv))
      L.routes.push(route)
      return route
    }
    // 这一侧整个临水：照样出去，过河的地方架桥
    const { pts, t } = walk(target)
    const route = [...pts, [b[K] + 20, t] as [number, number]].map(([r, tv]) => world(r, tv))
    if (L.front < 0) L.front = s
    L.exitSides.add(s)
    L.routes.push(route)
    return route
  },
  assign(ctx, z, lots) {
    const L = layoutOf(ctx, z)
    if (L.front < 0) L.front = 1
    // 寺町：背面（离大手最远的一侧）或地多的一侧；大城再加一侧
    const land = (s: number) =>
      lots.filter((l) => {
        const c = cellOf(L, z.toUV(centroid(l.poly)))
        return c.ring === L.K && c.sides.includes(s)
      }).length
    const back = (L.front + 2) % 4
    const sides = [back, (L.front + 1) % 4, (L.front + 3) % 4].sort((a, c) => land(c) - land(a) + (a === back ? -0.5 : 0) - (c === back ? -0.5 : 0))
    L.temples = L.K >= 2 ? sides.slice(0, L.K >= 6 ? 2 : 1) : []
    for (const l of lots) {
      // 按片区的形心算圈（站点落水时，邻近的片区会伸过来补上那一格）
      const c = cellOf(L, z.toUV(centroid(l.poly)))
      if (Math.hypot(l.uv[0], l.uv[1]) < 1) l.type = 'castle'
      else if (c.ring <= L.ns) l.type = 'noble'
      else if (c.ring === L.K && c.sides.some((s) => L.temples.includes(s))) l.type = 'temple'
      else if (l.inner) {
        // 町人地：干道两侧是大店（商人），其余交给通用选址
        const onRoute = L.routes.some((r) => nearLine(l.site, r, BLOCK * 0.62))
        if (onRoute) l.type = 'merchant'
      }
    }
  },
  build(ctx, ward, block, z) {
    const L = layoutOf(ctx, z)
    const uv = z.toUV(centroid(ward.poly))
    const { ring } = cellOf(L, uv)
    if (ward.type === 'castle') {
      if (!pointInPoly(z.c, ward.poly)) return false
      castle(ctx, z, L)
      return true
    }
    if (ring > L.K) return false
    const parts = splitAxis(ctx, L, z, block)
    if (ward.type === 'noble') {
      const grid = z.fromUV(1, 0)
      for (const q of parts) buke(ctx, q, unit([grid[0] - z.c[0], grid[1] - z.c[1]]), ring <= 1)
      return true
    }
    if (ward.type === 'temple') {
      // 山门朝城堡一侧（寺町背靠外缘）
      const s = SIDES[cellOf(L, uv).side]
      const f = z.fromUV(-s[0], -s[1])
      for (const q of parts) jiin(ctx, q, [f[0] - z.c[0], f[1] - z.c[1]])
      return true
    }
    if (MACHI.has(ward.type)) {
      const o = ctx.out
      const cp = checkpoint(ctx)
      const n0 = o.buildings.length
      const grid = z.fromUV(1, 0)
      for (const q of parts) machiya(ctx, q, unit([grid[0] - z.c[0], grid[1] - z.c[1]]), ward.type)
      // 町割定了、还没人家住进来的街区（预算先在里面用完了）：还是城边的田，不算城区
      if (!o.buildings.slice(n0).some((b) => b.kind === 'house' || b.kind === 'large')) {
        rollback(ctx, cp)
        if (o.blocks.length && pointInPoly(centroid(o.blocks[o.blocks.length - 1]), ward.poly)) drop(ctx, 'blocks', (_, k) => k === o.blocks.length - 1)
        // 陡坡上的街区照旧是山林
        const hill = ctx.T.slopeAt(centroid(block)) > STEEP
        ward.inner = false
        ward.type = hill ? 'wild' : 'farm'
        ward.density = undefined
        ;(hill ? wild : farm)(ctx, block, vegetation(ctx))
      }
      return true
    }
    return false
  },
  // 没有外郭：靠城堡的堀与寺町防守
  wall: () => [],
}

/** 太陡、不铺町割的坡度 */
const STEEP = 0.3

/** 一段街整段都在陡坡上（不修） */
const steep = (ctx: Ctx, a: P, b: P) => [0.2, 0.5, 0.8].every((t) => ctx.T.slopeAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) > STEEP)

/** 町人地按町屋盖的片区 */

function nearLine(q: P, line: P[], d: number) {
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]
    const b = line[i + 1]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
    if (Math.hypot(a[0] + dx * t - q[0], a[1] + dy * t - q[1]) < d) return true
  }
  return false
}

/** 中轴街穿过的片区（城堡那一行、那一列）沿中轴劈成两半 */
function splitAxis(ctx: Ctx, L: Layout, z: PlanZone, block: Poly): Poly[] {
  let parts: Poly[] = [block]
  const gap = ctx.cfg.lane + 2.5 + 3
  for (const vertical of [true, false]) {
    const next: Poly[] = []
    for (const q of parts) {
      const uv = q.map((v) => z.toUV(v))
      const xs = uv.map((w) => (vertical ? w[0] : w[1]))
      const ys = uv.map((w) => (vertical ? w[1] : w[0]))
      const band = bandOf(L, (Math.min(...ys) + Math.max(...ys)) / 2)
      if (Math.min(...xs) < -1 && Math.max(...xs) > 1 && kept(L, 0, band)) {
        const dir = vertical ? z.fromUV(0, 1) : z.fromUV(1, 0)
        for (const h of splitConvex(q, z.c, [dir[0] - z.c[0], dir[1] - z.c[1]], gap)) if (h.length >= 3) next.push(h)
      } else next.push(q)
    }
    parts = next
  }
  return parts
}
