import { addRoad } from '../roads'
import { emitArea, hashAt, isFree, siteDice, placeable, type Ctx } from '../ctx'
import { area, at, box, centroid, clipConvex, dist, insetConvex, obb, polylineDist, unit, type Frame, type P, type Poly } from '../geom'
import type { BuildingKind, Density, Wall } from '../types'
import { addBuilding, addGroup, inside, place, scatterTrees, subdivide } from '../wards'
import type { Layout } from './jokamachi'
import type { PlanZone } from './types'
import { garan } from '../compose/wa'
import { composer, type Elem, type Preset } from '../compose/core'
import { addWall, connectGates } from '../walls'
import * as dmath from '../../gen/dmath'

/**
 * 城下町的填法：城堡（堀、石垣、本丸与天守）、武家屋敷、町屋、寺院、枡形。
 * 都在局部标架里摆：F.f 是"纵深"（朝外 / 朝里）方向，F.l 是横向。
 */

/** 枡形的尺寸：出规划区直走 turn 米撞墙，横向 out 米出门；石垣圈半宽 half */
export const MASU = { turn: 27, out: 38, half: 25 }

/** 局部坐标方向 (du, dv) 的世界单位向量 */
const dirOf = (z: PlanZone, du: number, dv: number): P => {
  const q = z.fromUV(du, dv)
  return unit([q[0] - z.c[0], q[1] - z.c[1]])
}
/** 方格的两条轴（grid 与它的法向）里离 u 方向最近的一条 */
const gridAxis = (grid: P, u: P): P => {
  const n: P = [-grid[1], grid[0]]
  return Math.abs(u[0] * grid[0] + u[1] * grid[1]) > Math.abs(u[0] * n[0] + u[1] * n[1]) ? grid : n
}
const SIDE_UV: P[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]

/** 直接落地的城郭建筑（不占民居预算；位置由城的规划定，只让开水面与已有的东西） */
export const put = (ctx: Ctx, poly: Poly, kind: BuildingKind) => place(ctx, poly, kind, { tags: ['road', 'river'] })

/**
 * 天守的构成（由简到繁）：独立式、复合式（付橹直接贴着大天守）、连结式（渡橹连着一座小天守）、
 * 连结复合式（小天守之外再贴一座付橹，松本城）、连立式（大天守与三座小天守用渡橹围成一圈，姬路城）
 */
const TENSHU = ['single', 'compound', 'linked', 'complex', 'ring'] as const
type Tenshu = (typeof TENSHU)[number]
const TENSHU_POOL: Elem<Tenshu>[] = [
  { id: 'single', w: 1.2 },
  { id: 'compound', w: 1.2 },
  { id: 'linked', w: 2.5 },
  { id: 'complex', w: 1, min: 20 },
  { id: 'ring', w: 1, min: 22 },
]
/** 以前的三种构成现在是预设：姬路（连立、五重）、松本（连结复合）、犬山（复合、三重）、名古屋（连结、五重）、丸龟（独立、三重） */
const TENSHU_PRESETS: Preset[] = [
  { id: 'himeji', w: 1.2, bias: { form: { ring: 8 } }, num: { tiers: [5, 5] } },
  { id: 'matsumoto', w: 1, bias: { form: { complex: 8 } }, num: { tiers: [4, 5] } },
  { id: 'inuyama', w: 1, bias: { form: { compound: 8 } }, num: { tiers: [3, 4] } },
  { id: 'nagoya', w: 1.5, bias: { form: { linked: 6 } }, num: { tiers: [5, 5] } },
  { id: 'marugame', w: 1, bias: { form: { single: 8 } }, num: { tiers: [3, 3] } },
]

/**
 * 天守：大天守（天守台上层层收小的几重屋顶）与小天守、付橹、渡橹，要么整组落地，要么退一档（连立 → 连结复合 → 连结 → 复合 → 独立）。
 * F 的 f 向是纵深，(a, b) 是大天守中心，s 是大天守的面宽；小天守在 side 一侧。
 * 构成、重数、大天守的进深比例、小天守的大小按天守的位置抽签（siteDice）。
 */
export function tenshu(ctx: Ctx, F: Frame, a: number, b: number, s: number, side: number): boolean {
  const V = siteDice(ctx, at(F, a, b), 'tenshu')
  const C = composer(V, 'tenshu', TENSHU_PRESETS, { size: s, rank: ctx.p.capital ? 2 : 1 })
  const d = s * C.num('depth', 0.37, 0.47)
  const bx = (ac: number, bc: number, ha: number, hb: number) => box(F, ac - ha, ac + ha, bc - hb, bc + hb)
  const main = bx(a, b, d, s / 2)
  // 小天守：半进深 kh、半面宽 kw
  const ks = s * C.num('small', 0.45, 0.58)
  const kh = ks * 0.42
  const kw = ks / 2
  const kb = b + side * (s / 2 + 3 + kw)
  const ka = a + d - ks * 0.45
  const ra = a + d + 3 + kh
  // 付橹：贴在大天守正面（背着小天守的一侧），不用渡橹
  const tk: [number, number, number, number] = [a - d - kh * 0.7, b - side * s * 0.18, kh * 0.75, kw * 0.8]
  const tsuke = bx(tk[0], tk[1], tk[2], tk[3])
  // 各构成：小天守的中心、付橹与渡橹
  const forms: Record<Tenshu, { small: P[]; extra: Poly[]; bridges: Poly[] }> = {
    single: { small: [], extra: [], bridges: [] },
    compound: { small: [], extra: [tsuke], bridges: [] },
    linked: { small: [[ka, kb]], extra: [], bridges: [bx(ka, b + side * (s / 2 + 1.5), 2.2, 2.5)] },
    complex: { small: [[ka, kb]], extra: [tsuke], bridges: [bx(ka, b + side * (s / 2 + 1.5), 2.2, 2.5)] },
    ring: {
      small: [[a, kb], [ra, kb], [ra, b]],
      extra: [],
      bridges: [
        bx(a, b + side * (s / 2 + 1.5), 2.2, 2.5),
        bx((a + ra) / 2, kb, (ra - a) / 2 - kh + 1, 2.2),
        bx(ra, (b + kb) / 2, 2.2, Math.abs(kb - b) / 2 - kw + 1),
        bx((a + d + ra - kh) / 2, b, (ra - kh - a - d) / 2 + 1, 2.2),
      ],
    },
  }
  const want = C.pick('form', TENSHU_POOL, { size: s })
  const tries = TENSHU.slice(0, TENSHU.indexOf(want) + 1).reverse()
  const ok = (p: Poly) => isFree(ctx, p, { tags: ['road', 'river', 'wall'] })
  const got = tries.find((k) => [main, ...forms[k].small.map(([x, y]) => bx(x, y, kh, kw)), ...forms[k].extra, ...forms[k].bridges].every(ok))
  if (!got) return false
  if (got !== want) C.note('built', got)
  const form = forms[got]
  const smalls = form.small.map(([x, y]) => bx(x, y, kh, kw))
  const bases = [main, ...smalls, ...form.extra, ...form.bridges]
  const tone = ctx.rng.next()
  const ridge = dmath.atan2(F.l[1], F.l[0])
  const tiers: Poly[] = [...bases]
  // 重层：一重比一重小，叠在一起看出层层收分的屋顶（重数随大小：小的天守最多三重）
  const n = Math.min(C.int('tiers', 3, 5), s < 18 ? 3 : 5)
  for (let i = 1; i < n; i++) {
    const k = 1 - (0.72 * i) / (n - 1) - 0.02
    tiers.push(bx(a, b, d * k, (s / 2) * k))
  }
  for (const [x, y] of form.small) tiers.push(bx(x, y, kh * 0.62, kw * 0.62))
  if (form.extra.length) tiers.push(bx(tk[0], tk[1], tk[2] * 0.6, tk[3] * 0.6))
  for (const p of tiers) ctx.out.buildings.push({ poly: p, kind: 'keep', tone, ridge })
  for (const p of bases) ctx.occ.add(p)
  C.done(at(F, a, b))
  return true
}

/**
 * 一道方形的石垣与外侧的堀：loop 按顺序给出四角，gates 是插在边上的门（在 loop 的第 k 条边上）。
 * 临水的墙段断开（河就是堀），堀在水里的部分不画。
 */
export function rampart(ctx: Ctx, corners: P[], gates: { edge: number; p: P; angle: number }[], moatRing: P[] | null, moatW: number, thickness: number): Wall {
  const T = ctx.T
  const loop: P[] = []
  const solid: boolean[] = []
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]
    const b = corners[(k + 1) % corners.length]
    const g = gates.find((x) => x.edge === k)
    const stops = g ? [a, g.p] : [a]
    for (const s of stops) {
      const e = s === a && g ? g.p : b
      const n = Math.max(1, Math.ceil(dist(s, e) / 8))
      for (let i = 0; i < n; i++) {
        const q: P = [s[0] + ((e[0] - s[0]) * i) / n, s[1] + ((e[1] - s[1]) * i) / n]
        const m: P = [s[0] + ((e[0] - s[0]) * (i + 0.5)) / n, s[1] + ((e[1] - s[1]) * (i + 0.5)) / n]
        loop.push(q)
        solid.push(T.waterAt(m) > 2)
      }
    }
  }
  const wall: Wall = { loop, solid, towers: [], gates: gates.map((g) => ({ p: g.p, angle: g.angle })), kind: 'stone', thickness }
  if (moatRing) {
    const runs: P[][] = []
    let cur: P[] = []
    let broken = false
    for (let k = 0; k < moatRing.length; k++) {
      const a = moatRing[k]
      const b = moatRing[(k + 1) % moatRing.length]
      const n = Math.max(1, Math.ceil(dist(a, b) / 3))
      for (let i = 0; i < n; i++) {
        const q: P = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]
        if (T.waterAt(q) > moatW / 2) cur.push(q)
        else {
          broken = true
          if (cur.length > 1) runs.push(cur)
          cur = []
        }
      }
    }
    if (cur.length > 1) runs.push(cur)
    // 一整圈没断：首尾接上；断过的话首尾两段并成一段
    if (!broken && runs.length === 1) runs[0].push(runs[0][0])
    else if (runs.length > 1 && dist(runs[0][0], runs[runs.length - 1][runs[runs.length - 1].length - 1]) < 4) runs[0] = [...runs.pop()!, ...runs[0]]
    if (runs.length) {
      const bridges: { p: P; angle: number }[] = []
      for (const g of gates) {
        let best: P | null = null
        let bd = Infinity
        for (const r of runs)
          for (const q of r) {
            const d = dist(q, g.p)
            if (d < bd) {
              bd = d
              best = q
            }
          }
        if (best && bd < moatW * 2 + 12) bridges.push({ p: best, angle: g.angle })
      }
      wall.moat = { runs, width: moatW, bridges }
    }
  }
  return addWall(ctx, wall, 'plan')
}

// —————————————————————— 城堡 ——————————————————————

/**
 * 城堡（城心片区）：堀端大街以内是外堀与石垣围成的二之丸，里面一道内堀围着本丸；
 * 本丸偏在背面，天守立在本丸的后角，前面是御殿；二之丸里是御殿、藏与松树。
 * 大手门开在正面，干道出城的各侧开门；入城的路过桥进门后先拐一道弯，再过内堀进本丸。
 * 规划区外缘干道入口的枡形也在这里一并修（城堡最先盖）。
 */
export function castle(ctx: Ctx, z: PlanZone, L: Layout) {
  const w0 = ctx.out.walls.length
  const C = L.C
  const s = L.front
  const F: Frame = { o: z.c, f: dirOf(z, SIDE_UV[s][0], SIDE_UV[s][1]), l: dirOf(z, -SIDE_UV[s][1], SIDE_UV[s][0]) }
  const mw = C >= 140 ? 16 : C >= 120 ? 13 : 10
  const hs = ctx.cfg.main / 2 + 1.2
  const mo = C - hs - 2 - mw / 2
  const wo = mo - mw / 2 - 2.5
  const th = C >= 120 ? 4.5 : 3.6
  // 外圈：四角按 uv 的东南西北顺序，门在有干道的各侧正中
  const U: Frame = { o: z.c, f: dirOf(z, 1, 0), l: dirOf(z, 0, 1) }
  const sq = (r: number): P[] => [at(U, r, -r), at(U, r, r), at(U, -r, r), at(U, -r, -r)]
  const gateSides = [...new Set([s, ...L.exitSides])]
  const outerGates = gateSides.map((k) => {
    const d = dirOf(z, SIDE_UV[k][0], SIDE_UV[k][1])
    return { edge: k, p: [z.c[0] + d[0] * wo, z.c[1] + d[1] * wo] as P, angle: dmath.atan2(d[1], d[0]) }
  })
  rampart(ctx, sq(wo), outerGates, sq(mo), mw, th)
  // 二之丸的地面
  const inner2 = sq(wo - th / 2 - 0.5)
  emitArea(ctx, 'plazas', inner2)
  // 本丸：偏向背面
  const hh = C * 0.36
  const ob = C * 0.1
  const H0 = -hh - ob
  const H1 = hh - ob
  const mi = Math.round(mw * 0.75)
  const mc = th / 2 + 2 + mi / 2
  const gl = hh * 0.45 * (hashAt(ctx, z.c, 'jokamachi.gateSide') < 0.5 ? 1 : -1)
  const honmaru: P[] = [at(F, H1, -hh), at(F, H1, hh), at(F, H0, hh), at(F, H0, -hh)]
  const ring: P[] = [at(F, H1 + mc, -hh - mc), at(F, H1 + mc, hh + mc), at(F, H0 - mc, hh + mc), at(F, H0 - mc, -hh - mc)]
  const fAngle = dmath.atan2(F.f[1], F.f[0])
  rampart(ctx, honmaru, [{ edge: 0, p: at(F, H1, gl), angle: fAngle }], ring, mi, th)
  emitArea(ctx, 'plazas', box(F, H0 + th / 2, H1 - th / 2, -hh + th / 2, hh - th / 2))
  // 登城路：堀端大街 → 大手门（过外堀的桥）→ 二之丸里拐弯 → 过内堀进本丸
  const inner = (line: P[], w: number) => {
    addRoad(ctx, { line, width: w, kind: 'street' }, 0.8)
  }
  const fr = H1 + mc + mi / 2 + 6
  inner([at(F, C - hs + 1, 0), at(F, wo - 2, 0), at(F, fr, 0), at(F, fr, gl), at(F, H1 - 4, gl)], 5)
  for (const k of gateSides) {
    if (k === s) continue
    const d = dirOf(z, SIDE_UV[k][0], SIDE_UV[k][1])
    inner([[z.c[0] + d[0] * (C - hs + 1), z.c[1] + d[1] * (C - hs + 1)], [z.c[0] + d[0] * (wo - 10), z.c[1] + d[1] * (wo - 10)]], 4)
  }
  // 天守：本丸正中（略偏后）一座大天守，旁边渡橹连着小天守
  const tb = Math.max(20, Math.min(36, hh * 0.7))
  const side = gl > 0 ? -1 : 1
  const ta = (H0 + H1) / 2 - hh * 0.12
  const tl = -side * tb * 0.22
  tenshu(ctx, F, ta, tl, tb, side)
  // 城名标在本丸前面的二之丸里，不压住天守
  ctx.out.landmarks.push({ p: at(F, (H1 + mc + wo) / 2, 0), name: ctx.namer.wa('castle'), kind: 'castle' })
  // 隅橹：本丸与二之丸石垣的转角
  const yg = C >= 120 ? 8 : 6.5
  for (const [a, b] of [
    [H1, hh],
    [H1, -hh],
    [H0, -side * hh],
  ] as [number, number][])
    put(ctx, box(F, a - Math.sign(a) * (th / 2 + yg), a - Math.sign(a) * (th / 2), b - Math.sign(b) * (th / 2 + yg), b - Math.sign(b) * (th / 2)), 'tower')
  const w2 = wo - th / 2
  for (const [a, b] of [
    [w2, w2],
    [w2, -w2],
    [-w2, w2],
    [-w2, -w2],
  ] as [number, number][])
    put(ctx, box(U, a - Math.sign(a) * (yg + 1), a - Math.sign(a), b - Math.sign(b) * (yg + 1), b - Math.sign(b)), 'tower')
  // 本丸御殿：天守前面、背着登城路的一侧，雁行排列两三栋
  const gf = ta + tb * 0.43 + 4
  const ge = H1 - th / 2 - 3
  const gb = hh - th / 2 - yg - 2
  if (ge - gf > 10) {
    // 御殿比天守小得多：平屋一两栋
    const d1 = Math.min(10, (ge - gf) * 0.5)
    put(ctx, box(F, gf, gf + d1, side * 1, side * Math.min(gb, hh * 0.45)), 'hall')
    put(ctx, box(F, ge - d1 * 0.85, ge, side * hh * 0.35, side * Math.min(gb, hh * 0.7)), 'hall')
  }
  // 本丸背面：沿墙一排藏
  const kb0 = H0 + th / 2 + 2
  const kb1 = ta - tb * 0.43 - 3
  if (kb1 - kb0 > 7) for (let b = -hh * 0.55; b < hh * 0.5; b += 16) put(ctx, box(F, kb0, kb0 + Math.min(7, kb1 - kb0), b, b + 12), 'shed')
  // 二之丸：正面的御殿、两侧与背面沿墙的藏（长条库房）
  const band = wo - th / 2 - 2 - (H1 + mc + mi / 2)
  if (band > 18) {
    const a = H1 + mc + mi / 2 + band / 2 + 2
    put(ctx, box(F, a - band * 0.25, a + band * 0.25, -gl - hh * 0.5, -gl + hh * 0.2), 'hall')
    put(ctx, box(F, a - band * 0.2, a + band * 0.2, gl * 2.2 - 6, gl * 2.2 + 6), 'hall')
  }
  const lat = wo - th / 2 - 2 - (hh + mc + mi / 2)
  for (const sd of [-1, 1])
    if (lat > 12)
      for (let a = H0 * 0.8; a < H1 * 0.6; a += 22) put(ctx, box(F, a, a + 16, sd * (wo - th / 2 - 3 - Math.min(8, lat * 0.4)), sd * (wo - th / 2 - 3)), 'shed')
  scatterTrees(ctx, insetConvex(inner2, 3), 0.0015, 2.5, 4)
  for (const m of L.masu) masugata(ctx, z, L, m)
  // 城门（外郭的门在干道上，本丸、二之丸的门在城里）接上路
  connectGates(ctx, ctx.out.walls.slice(w0))
}

/** 枡形：干道进规划区的地方一圈方石垣，外门、内门成直角，进门要拐弯 */
function masugata(ctx: Ctx, z: PlanZone, L: Layout, m: { side: number; t: number; sgn: number }) {
  const F: Frame = { o: z.c, f: dirOf(z, SIDE_UV[m.side][0], SIDE_UV[m.side][1]), l: dirOf(z, -SIDE_UV[m.side][1], SIDE_UV[m.side][0]) }
  const r0 = L.b[L.K] + 3
  const r1 = r0 + MASU.half * 2
  const t0 = m.t - MASU.half
  const t1 = m.t + MASU.half
  const outline = box(F, r0, r1, t0, t1)
  // 干道真的从这里过（没有接不上的），整圈在陆上
  const gIn = at(F, r0, m.t)
  if (!ctx.out.roads.some((r) => (r.kind === 'main' || r.kind === 'highway') && polylineDist(gIn, r.line) < 3)) return
  if (outline.some((q) => ctx.T.waterAt(q) < 4) || ctx.occ.overlaps(outline)) return
  const fA = dmath.atan2(F.f[1], F.f[0])
  const lA = dmath.atan2(F.l[1] * m.sgn, F.l[0] * m.sgn)
  // 边：0 内侧（r0，t0→t1）、1 横向 t1 边、2 外侧、3 横向 t0 边
  const corners = [at(F, r0, t0), at(F, r0, t1), at(F, r1, t1), at(F, r1, t0)]
  const gOut = at(F, r0 + MASU.turn, m.sgn > 0 ? t1 : t0)
  rampart(ctx, corners, [
    { edge: 0, p: gIn, angle: fA },
    { edge: m.sgn > 0 ? 1 : 3, p: gOut, angle: lA },
  ], null, 0, 3)
  ctx.occ.add(outline)
}

// —————————————————————— 武家地 ——————————————————————

/**
 * 武家屋敷：大地块，土墙围合；临街一排长屋门（家臣住的长屋，中间开门），
 * 主屋雁行错开几栋，屋后是庭园与树，角上一座藏。上级武士（紧挨城堡的一圈）地块更大。
 * grid：町割方格的轴（城下町规划区里宅地顺着方格摆）；null 表示没有方格（有机的城区），宅地顺着各自的临街边摆。
 */
export function buke(ctx: Ctx, block: Poly, grid: P | null, upper: boolean) {
  const rng = ctx.rng
  const lots = subdivide(ctx, block, { maxA: upper ? 3800 : 1700, minA: upper ? 1500 : 650, alley: 0, alleyP: 0, depth: 20, fill: 1, irr: 0.3 })
  for (const lot of lots) {
    const encl0 = placeable(ctx, insetConvex(lot.poly, 1), 3)
    if (!encl0 || encl0.length < 3 || area(encl0) < 300) continue
    // 临街边：最长的一条；没有就按最长边
    const edges = (lot.front.length ? lot.front : lot.poly.map((_, i) => i)).map((i) => [lot.poly[i], lot.poly[(i + 1) % lot.poly.length]] as [P, P])
    edges.sort((a, b) => dist(b[0], b[1]) - dist(a[0], a[1]))
    const [ea, eb] = edges[0]
    // 标架：顺着方格（离临街边方向最近的格轴）；没有方格就顺着临街边
    const eu = unit([eb[0] - ea[0], eb[1] - ea[1]])
    const ax = grid ? gridAxis(grid, eu) : eu
    const c = centroid(encl0)
    let fn: P = [-ax[1], ax[0]]
    // fn 朝里（背离临街边）
    const mid: P = [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2]
    if ((c[0] - mid[0]) * fn[0] + (c[1] - mid[1]) * fn[1] < 0) fn = [-fn[0], -fn[1]]
    // 取成顺着方格的矩形宅地
    let a0 = Infinity
    let a1 = -Infinity
    let b0 = Infinity
    let b1 = -Infinity
    for (const v of encl0) {
      const a = (v[0] - mid[0]) * fn[0] + (v[1] - mid[1]) * fn[1]
      const b = (v[0] - mid[0]) * ax[0] + (v[1] - mid[1]) * ax[1]
      a0 = Math.min(a0, a)
      a1 = Math.max(a1, a)
      b0 = Math.min(b0, b)
      b1 = Math.max(b1, b)
    }
    const F: Frame = { o: mid, f: fn, l: ax }
    const rectLot = clipConvex(box(F, a0, a1, b0, b1), encl0)
    const encl = rectLot.length >= 3 && area(rectLot) > area(encl0) * 0.8 ? rectLot : encl0
    const D = a1 - a0
    const W = b1 - b0
    if (D < 16 || W < 16) continue
    const ok = (p: Poly) => inside(p, encl) && isFree(ctx, p)
    // 长屋门：临街一排，正中留门
    const gw = 5
    const bm = (b0 + b1) / 2 + (rng.next() - 0.5) * W * 0.3
    const nd = Math.min(5.5, D * 0.15)
    for (const [s0, s1] of [
      [b0 + 1.5, bm - gw / 2],
      [bm + gw / 2, b1 - 1.5],
    ])
      if (s1 - s0 > 6) {
        const p = box(F, a0 + 0.8, a0 + 0.8 + nd, s0, s1)
        if (ok(p)) addBuilding(ctx, p, 'house')
      }
    // 主屋：雁行两三栋
    const hw = Math.min(W * 0.42, upper ? 26 : 16)
    const hd = Math.min(D * 0.26, upper ? 16 : 11)
    const f0 = a0 + nd + Math.max(5, D * 0.12)
    const shift = (rng.next() < 0.5 ? -1 : 1) * W * 0.12
    const parts: [Poly, BuildingKind][] = [[box(F, f0, f0 + hd, bm - hw / 2 + shift, bm + hw / 2 + shift), 'large']]
    // 第二栋贴着主屋的侧边、往后错半栋（雁行）
    const lb = shift > 0 ? bm + shift - hw / 2 : bm + shift + hw / 2
    const ls = shift > 0 ? -1 : 1
    parts.push([box(F, f0 + hd * 0.55, f0 + hd * 1.45, Math.min(lb, lb + ls * hw * 0.55), Math.max(lb, lb + ls * hw * 0.55)), 'house'])
    if (upper && D > 50) parts.push([box(F, f0 + hd * 1.3, f0 + hd * 2, bm + shift - hw * 0.25, bm + shift + hw * 0.25), 'hall'])
    if (ctx.houseBudget > 0 && parts.every(([p]) => inside(p, encl))) addGroup(ctx, parts, 0.5)
    // 藏：后角
    const kc = rng.next() < 0.5 ? b0 + 3 : b1 - 8
    const kura = box(F, a1 - 9, a1 - 3, kc, kc + 5)
    if (ok(kura)) addBuilding(ctx, kura, 'shed')
    // 预算用完时盖不了房子，也还是一处空着的屋敷：土墙与庭园
    emitArea(ctx, 'enclosures', encl)
    // 庭园：主屋后面到后墙
    const g0 = f0 + hd * (upper && D > 50 ? 2.1 : 1.6) + 2
    if (a1 - 2 - g0 > 8) {
      const garden = clipConvex(box(F, g0, a1 - 1.5, b0 + 1.5, b1 - 1.5), encl)
      if (garden.length >= 3 && area(garden) > 80) {
        emitArea(ctx, 'greens', garden, 'garden')
        scatterTrees(ctx, insetConvex(garden, 1.5), upper ? 0.012 : 0.008, 2, 4)
      }
    }
  }
}

// —————————————————————— 町人地 ——————————————————————

/**
 * 町屋街区：沿街四面是面宽窄、进深长的町屋（鳗鱼的窝），屋后是小院与土藏；
 * 街区中间是会所地：密的街区在一侧盖一两栋里长屋（路地从街上穿进去），其余是空地、井与小祠；
 * 不密的是菜园与树，作坊区是大工棚。
 */
export function machiya(ctx: Ctx, block: Poly, grid: P | null, type: string, o: { streetOnly?: boolean; dens?: Density } = {}) {
  const rng = ctx.rng
  const blk = placeable(ctx, block, 2.5)
  if (!blk || blk.length < 3 || area(blk) < 200) return
  const c = centroid(blk)
  const merchant = type === 'merchant'
  const craft = type === 'craft'
  const dens = o.dens ?? (type === 'slum' ? 'high' : ctx.wardDensity)
  const D = merchant ? 20 : craft ? 18 : 16
  // 各边：临街的排前面，长边优先
  type Edge = { a: P; u: P; n: P; L: number; pri: number }
  const edges: Edge[] = []
  for (let i = 0; i < blk.length; i++) {
    const a = blk[i]
    const b = blk[(i + 1) % blk.length]
    const L = dist(a, b)
    if (L < 8) continue
    const u = unit([b[0] - a[0], b[1] - a[1]])
    let nn: P = [-u[1], u[0]]
    const m: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    if ((c[0] - m[0]) * nn[0] + (c[1] - m[1]) * nn[1] < 0) nn = [-nn[0], -nn[1]]
    const street = ctx.corridors.hits([m[0] - nn[0] * 4, m[1] - nn[1] * 4], 0.5)
    // 城郊、村里只沿街盖
    if (o.streetOnly && !street) continue
    edges.push({ a, u, n: nn, L, pri: (street ? 1000 : 0) + L })
  }
  edges.sort((x, y) => y.pri - x.pri)
  // 里长屋只在密的街区：路地从最长的临街边中段穿进街区中心
  const deep = insetConvex(blk, D + 1)
  const nagaya = dens === 'high' && deep.length >= 3 && area(deep) > 500 && !craft && !o.streetOnly
  if (nagaya && edges.length) {
    const E = edges[0]
    const t = E.L * (0.35 + rng.next() * 0.3)
    const p0: P = [E.a[0] + E.u[0] * t, E.a[1] + E.u[1] * t]
    const p1: P = [p0[0] + E.n[0] * (D + 3), p0[1] + E.n[1] * (D + 3)]
    addRoad(ctx, { line: [p0, p1], width: 2, kind: 'lane' }, 0.4)
  }
  const ok = (p: Poly) => inside(p, blk) && isFree(ctx, p)
  // 临街的町屋：面宽按密度（密的五六米一间，疏的是宽门面、房子之间留空）
  const [w0, w1] = dens === 'high' ? [5.5, 8.5] : dens === 'mid' ? [7, 10.5] : [13, 20]
  for (const E of edges) {
    let s = 0.5
    while (s < E.L - 3) {
      const w = (w0 + rng.next() * (w1 - w0)) * (merchant ? 1.15 : 1)
      const s1 = Math.min(E.L - 0.5, s + w)
      if (s1 - s < 3.5) break
      const F: Frame = { o: E.a, f: E.n, l: E.u }
      const hd = D * (dens === 'low' ? 0.5 : 0.6 + rng.next() * 0.15)
      const hw = dens === 'low' ? Math.min(s1 - s - 3, 8 + rng.next() * 4) : s1 - s - 0.4
      const house = box(F, dens === 'low' ? 1.5 : 0.3, hd, s + 0.2, s + 0.2 + hw)
      if (hw > 3 && ok(house) && addBuilding(ctx, house, area(house) > 160 ? 'large' : 'house')) {
        // 屋后的土藏（商家多）
        if (rng.next() < (merchant ? 0.45 : craft ? 0.5 : 0.15) && s1 - s > 5) {
          const kd = craft ? 7 : 5
          const kura = box(F, hd + 2, Math.min(D - 0.5, hd + 2 + kd), s + 0.8, Math.min(s1 - 0.8, s + 0.8 + (craft ? s1 - s - 1.6 : 4.2)))
          if (ok(kura)) addBuilding(ctx, kura, 'shed')
        }
      }
      s = s1
    }
  }
  // 只沿街盖的（城郊、宿场）：屋后就是田地，不留会所地
  if (o.streetOnly || deep.length < 3 || area(deep) < 150) return
  if (!nagaya) {
    // 会所地是菜园、晒场与树（作坊区是大工棚）
    if (craft) {
      const ob = obb(deep)
      for (let k = 0; k < 3; k++) {
        const q: P = [ob.center[0] + ob.axis[0] * (rng.next() - 0.5) * ob.len * 0.6, ob.center[1] + ob.axis[1] * (rng.next() - 0.5) * ob.len * 0.6]
        const shed = rectAt(q, ob.axis, 8 + rng.next() * 6, 6 + rng.next() * 3)
        if (ok(shed)) addBuilding(ctx, shed, 'shed')
      }
    } else {
      emitArea(ctx, 'greens', deep, 'garden')
      scatterTrees(ctx, insetConvex(deep, 1), 0.006, 2, 3.5)
    }
    return
  }
  // 里长屋：顺着路地两侧，背靠背两排一组；其余是会所地（空地、井、小祠）
  const E = edges[0]
  const ax = grid ? gridAxis(grid, E.u) : E.u
  const across: P = [-ax[1], ax[0]]
  const dc = centroid(deep)
  let lo = Infinity
  let hi = -Infinity
  let l0 = Infinity
  let l1 = -Infinity
  for (const v of deep) {
    const a = (v[0] - dc[0]) * across[0] + (v[1] - dc[1]) * across[1]
    const b = (v[0] - dc[0]) * ax[0] + (v[1] - dc[1]) * ax[1]
    lo = Math.min(lo, a)
    hi = Math.max(hi, a)
    l0 = Math.min(l0, b)
    l1 = Math.max(l1, b)
  }
  const F: Frame = { o: dc, f: across, l: ax }
  const unitW = 3.6
  const unitD = 4.5
  // 长屋每排的长度有限：一个街区只盖一两栋（每栋六到八户）
  const len = Math.min(l1 - l0 - 2, unitW * (6 + Math.floor(rng.next() * 3)) + 2)
  const bs = l0 + 1 + (l1 - l0 - 2 - len) * rng.next()
  const rows = hi - lo > 26 ? [lo + 2.5, lo + 2.5 + unitD + 0.2] : [lo + 2.5]
  for (const a of rows)
    for (let b = bs; b + unitW <= bs + len; b += unitW + 0.25) {
      const p = box(F, a, a + unitD, b, b + unitW)
      if (ok(p)) addBuilding(ctx, p, 'house')
    }
  // 会所地：井与一座小祠
  const mid = (rows[rows.length - 1] + unitD + hi) / 2
  if (hi - mid > 6) {
    ctx.out.landmarks.push({ p: at(F, mid, (l0 + l1) / 2), kind: 'well' })
    const sh = box(F, mid + 2, mid + 5.5, l1 - 8, l1 - 5)
    if (ok(sh)) addBuilding(ctx, sh, 'hall')
  }
}

export const rectAt = (c: P, axis: P, len: number, wid: number): Poly => {
  const u = unit(axis)
  const F: Frame = { o: c, f: u, l: [-u[1], u[0]] }
  return box(F, -len / 2, len / 2, -wid / 2, wid / 2)
}

// —————————————————————— 寺町 ——————————————————————

/**
 * 寺院：土墙围合的寺域，山门朝城堡一侧（寺町背靠城的外缘）。伽蓝配置按骨架与元素池拼（见 compose/wa.ts）。
 */
export function jiin(ctx: Ctx, block: Poly, facing: P) {
  garan(ctx, block, facing)
}
