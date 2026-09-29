import { eastAsian } from './culture'
import { Biome } from '../gen/types'
import { clamp } from '../gen/util'
import { centerDist, clipWater, gridFrame, hashAt, inCity, mark, placeable, rngAt, type Core, type Ctx } from './ctx'
import { chaikin, centroid, dist, insetConvex, obb, pointAt, pointInPoly, polylineDist, polylineLength, rect, resample, segDist, splitConvex, voronoiNb, type P, type Poly } from './geom'
import type { Density, Field, WardType } from './types'
import { addBuilding, scatterTrees, subdivide } from './wards'
import { wetRuns } from './roads'
import { isVillage } from './scale'

/**
 * 城内外共用的部分：Voronoi 片区剖分、植被、农田、林地与道路过水处理。
 */

export interface Patch {
  poly: Poly
  site: P
  nb: number[]
  land: number
  inner: boolean
  type?: WardType
  /** 建筑密度档（城区片区，见 scale.ts 的 densityOf） */
  density?: Density
  /** 密度得分（见 scale.ts 的 densityScore）：住户数随它连续变化 */
  score?: number
  /** 规划区里的片区（站点是形制给的，见 plans/） */
  planned?: boolean
  /** 都城宫城的一部分：主片区的下标（宫殿按几块合起来的地盘一次盖好，见 generate.ts 的 palaceBlock） */
  palace?: number
  /** 合成的大地标（见 zoning.ts 的 Lot.grand） */
  grand?: boolean
  /** 定下功能时的人口（见 zoning.ts 的 Lot.foundPop） */
  foundPop?: number
}

/**
 * 片区间距：离城心 FLAT 米以内一样密（多大的城都在这个范围里长），再往外的田野逐渐稀疏。
 * 与人口无关：同一块地在任何规模下都是同样大小的片区。
 */
const FLAT = 1800
export function spacing(ctx: Ctx, q: P) {
  const d = centerDist(ctx, q)
  return ctx.cfg.patch * Math.min(3.2, 1 + (Math.max(0, d - FLAT) / FLAT) * 1.4)
}

/** 规整的街道保留比例：规整度 0.2 以下没有，0.8 以上全部保留 */
const keepOf = (r: number) => clamp((r - 0.2) / 0.6, 0, 1)

/** 放射格网：第 k 圈（k ≥ 1）的半径与该圈一周的格数 */
function polarRing(k: number, s: number) {
  const rr = k * s
  return { rr, n: Math.max(6, Math.round((Math.PI * 2 * rr) / s)) }
}

/** 离 q 最近的剖分核心（含还没出现的副中心，见 Ctx.layoutCores；副中心按其权重放大距离） */
function layoutCore(ctx: Ctx, q: P): Core {
  const cores = ctx.layoutCores ?? ctx.cores
  let core = cores[0]
  let d = dist(q, core.c)
  for (const c of cores.slice(1)) {
    const dc = dist(q, c.c) * c.k
    if (dc < d) {
      d = dc
      core = c
    }
  }
  return core
}

/** 只留离这个核心最近的街段：相邻两片城区的街网在交界处各管各的，不会叠成两套 */
const ownedBy = (ctx: Ctx, core: Core) => (q: P) => layoutCore(ctx, q) === core

/**
 * 方格直街：以核心为原点、沿核心的方格方向，街线落在格点之间（正好是方格片区的边界），
 * 按格切成段，保留比例 = 规整度 × (1 − 放射度)；规整度越低，中段弯得越多。
 * 随机数用独立的流、每段总是取满，拖动布局时各段的抽签不变，只是保留的比例连续变化。
 */
export function latticeStreets(ctx: Ctx, core: Core, i: number): P[][] {
  const { p, T, cfg } = ctx
  const r = p.regularity
  const own = ownedBy(ctx, core)
  const { u: e, v: n } = gridFrame(core)
  const pitch = cfg.patch
  const R = core.R * 1.15
  const K = Math.ceil(R / pitch) + 1
  const keep = keepOf(r) * (1 - p.radial)
  const c = core.c
  const at = (d: P, m: P, u: number, v: number): P => [c[0] + d[0] * u + m[0] * v, c[1] + d[1] * u + m[1] * v]
  const out: P[][] = []
  for (const [dir, d, m] of [
    [0, e, n],
    [1, n, e],
  ] as [number, P, P][])
    for (let a = -K; a < K; a++)
      for (let b = -K; b < K; b++) {
        const v = (a + 0.5) * pitch
        const p0 = at(d, m, (b + 0.5) * pitch, v)
        const p1 = at(d, m, (b + 1.5) * pitch, v)
        const pick = hashAt(ctx, p0, `outer.lattice.keep${dir}`, i)
        const bend = hashAt(ctx, p1, `outer.lattice.bend${dir}`, i) - 0.5
        if (pick >= keep) continue
        const mid = at(d, m, (b + 1) * pitch, v + bend * pitch * 0.35 * (1 - r))
        if (dist(p0, c) > R || dist(p1, c) > R) continue
        if ([p0, mid, p1].some((q) => T.waterAt(q) < 5 || T.slopeAt(q) > 0.3 || !own(q))) continue
        out.push(resample(chaikin([p0, mid, p1]), 4))
      }
  return out
}

/**
 * 放射街道：环形街（落在相邻两圈格点之间）按格切成弧段，辐条街（同一圈里相邻格点之间）连接两圈；
 * 保留比例 = 规整度 × 放射度。与方格直街同样用独立随机数流，拖动布局时抽签不变。
 */
export function radialStreets(ctx: Ctx, core: Core, i: number): P[][] {
  const { p, T, cfg } = ctx
  const c = core.c
  const r = p.regularity
  const keep = keepOf(r) * p.radial
  const own = ownedBy(ctx, core)
  const s = cfg.patch
  const R = core.R * 1.1
  const out: P[][] = []
  const ok = (q: P) => T.waterAt(q) >= 5 && T.slopeAt(q) <= 0.3 && own(q)
  const arc = (rad: number, a0: number, a1: number, bend: number): P[] => {
    const m = Math.max(3, Math.ceil((Math.abs(a1 - a0) * rad) / 6))
    const pts: P[] = []
    for (let k = 0; k <= m; k++) {
      const a = a0 + ((a1 - a0) * k) / m
      const w = rad + Math.sin((k / m) * Math.PI) * bend
      pts.push([c[0] + Math.cos(a) * w, c[1] + Math.sin(a) * w])
    }
    return pts
  }
  for (let k = 1; (k + 0.5) * s < R; k++) {
    // 环：第 k 圈与第 k+1 圈之间，按第 k+1 圈的格数切段
    const { n } = polarRing(k + 1, s)
    const step = (Math.PI * 2) / n
    const rad = (k + 0.5) * s
    for (let j = 0; j < n; j++) {
      const mid: P = [c[0] + Math.cos(j * step) * rad, c[1] + Math.sin(j * step) * rad]
      const pick = hashAt(ctx, mid, 'outer.ring.keep', i)
      const bend = (hashAt(ctx, mid, 'outer.ring.bend', i) - 0.5) * s * 0.3 * (1 - r)
      if (pick >= keep) continue
      const pts = arc(rad, (j - 0.5) * step, (j + 0.5) * step, bend)
      if (pts.every(ok)) out.push(pts)
    }
    // 辐条：第 k 圈里相邻格点之间，从内环连到外环
    const inner = polarRing(k, s)
    const st = (Math.PI * 2) / inner.n
    for (let j = 0; j < inner.n; j++) {
      const a = (j + 0.5) * st
      const at: P = [c[0] + Math.cos(a) * k * s, c[1] + Math.sin(a) * k * s]
      const pick = hashAt(ctx, at, 'outer.spoke.keep', i)
      const bend = (hashAt(ctx, at, 'outer.spoke.bend', i) - 0.5) * s * 0.25 * (1 - r)
      if (pick >= keep * 0.85) continue
      const d: P = [Math.cos(a), Math.sin(a)]
      const nrm: P = [-d[1], d[0]]
      const r0 = Math.max(s * 0.5, (k - 0.5) * s)
      const r1 = (k + 0.5) * s
      const mid = (r0 + r1) / 2
      const pts = chaikin([
        [c[0] + d[0] * r0, c[1] + d[1] * r0],
        [c[0] + d[0] * mid + nrm[0] * bend, c[1] + d[1] * mid + nrm[1] * bend],
        [c[0] + d[0] * r1, c[1] + d[1] * r1],
      ])
      if (pts.every(ok)) out.push(resample(pts, 4))
    }
  }
  return out
}

/**
 * 布点与 Voronoi 剖分的范围比画面四周多出三个片区：单元在边界处被截断，
 * 这种边界效应都留在画面外，不会随画面（人口）大小传到城心。画面外的片区不盖东西（见 generate.ts）。
 */
export const sitePad = (ctx: Ctx) => ctx.cfg.patch * 3

function makeSites(ctx: Ctx, arterials: P[][], exclude?: (q: P) => boolean, extra: P[] = []): P[] {
  const { T, MW, MH } = ctx
  const pad = sitePad(ctx)
  // 主中心是第 0 个片区，副中心依次是第 1…k 个
  const sites: P[] = ctx.cores.map((c) => c.c)
  // 已有站点的空间网格（间距检查只看附近的格子）
  const GB = ctx.cfg.patch
  const near = new Map<number, P[]>()
  const gk = (x: number, y: number) => Math.floor(y / GB) * 100003 + Math.floor(x / GB)
  const addSite = (q: P) => {
    sites.push(q)
    const k = gk(q[0], q[1])
    ;(near.get(k) ?? near.set(k, []).get(k)!).push(q)
  }
  for (const q of sites) {
    const k = gk(q[0], q[1])
    ;(near.get(k) ?? near.set(k, []).get(k)!).push(q)
  }
  // 形制给的规划站点（固定，紧跟在核心之后；规划区里不再另外布点）
  for (const q of extra) addSite(q)
  // 还没出现的副中心也先占一个站点（排在最后，不影响前面的编号）：出现时它那一片的剖分不变
  for (const c of (ctx.layoutCores ?? ctx.cores).slice(ctx.cores.length)) addSite(c.c)
  const ok = (q: P, s: number) => {
    if (exclude?.(q)) return false
    if (q[0] < -pad || q[1] < -pad || q[0] > MW + pad || q[1] > MH + pad) return false
    const r = s * 0.62
    const reach = Math.ceil(r / GB)
    const cx = Math.floor(q[0] / GB)
    const cy = Math.floor(q[1] / GB)
    for (let y = cy - reach; y <= cy + reach; y++)
      for (let x = cx - reach; x <= cx + reach; x++) for (const o of near.get(y * 100003 + x) ?? []) if (dist(o, q) < r) return false
    return true
  }
  // 沿河两岸成对布点：两点的平分线正好落在河道中线上，片区边界于是贴着河
  const river = T.river
  if (river) {
    const line = river.line
    const L = polylineLength(line)
    // 弧长从离城心最近的河段量起、向两头走：河道在大小地图上的起点不同，这样取的点才一致
    const acc = [0]
    for (let i = 1; i < line.length; i++) acc.push(acc[i - 1] + dist(line[i - 1], line[i]))
    let s0 = 0
    let bd = Infinity
    line.forEach((q, i) => {
      const d = dist(q, ctx.center)
      if (d < bd) {
        bd = d
        // 挪开 1 厘米，避开正落在顶点上（浮点误差会让切线时而取前一段、时而取后一段）
        s0 = acc[i] + 0.01
      }
    })
    const hwAt = (s: number) => river.hw[Math.min(river.hw.length - 1, Math.max(0, acc.findIndex((a) => a >= s)))]
    for (const dirn of [1, -1])
      for (let s = dirn > 0 ? s0 : s0 - spacing(ctx, pointAt(line, s0).p) * 0.85; s >= 0 && s < L; ) {
        const { p: q, angle } = pointAt(line, s)
        const sp = spacing(ctx, q)
        const n: P = [-Math.sin(angle), Math.cos(angle)]
        const off = hwAt(s) + sp * 0.45
        for (const sg of [-1, 1]) {
          const c: P = [q[0] + n[0] * off * sg, q[1] + n[1] * off * sg]
          if (ok(c, sp * 0.9)) {
            addSite(c)
          }
        }
        s += dirn * sp * 0.85
      }
  }
  // 沿干道成对布点：路落在片区边界上，街坊与田块都沿路展开
  for (const road of arterials) {
    const L = polylineLength(road)
    for (let s = ctx.cfg.patch * 0.6; s < L; ) {
      const { p: q, angle } = pointAt(road, s)
      const sp = spacing(ctx, q)
      const n: P = [-Math.sin(angle), Math.cos(angle)]
      for (const sg of [-1, 1]) {
        const c: P = [q[0] + n[0] * sp * 0.5 * sg, q[1] + n[1] * sp * 0.5 * sg]
        if (T.waterAt(c) > 4 && ok(c, sp)) {
          addSite(c)
        }
      }
      s += sp * 0.95
    }
  }
  // 其余用变密度的随机投点填满；规整度 r 把投点往规整的格点上拉：
  // 方格点（Voronoi 单元是方块）与环 + 辐条点（单元是扇环）按放射度混合，r 为 1 时正好落在混合格点上
  const r = ctx.p.regularity
  const g = ctx.p.radial
  // 每个投点按离它最近的核心的方格 / 环形格点吸附：各片城区的街坊对齐各自的核心
  const frames = new Map((ctx.layoutCores ?? ctx.cores).map((c) => [c, gridFrame(c)]))
  const snap = (q: P, s: number): P => {
    const core = layoutCore(ctx, q)
    const grid = frames.get(core) ?? gridFrame(core)
    const center = core.c
    // 方格点
    const [u, v] = grid.toUV(q)
    const gs = grid.fromUV(Math.round(u / s) * s, Math.round(v / s) * s)
    if (g <= 0) return [q[0] + (gs[0] - q[0]) * r, q[1] + (gs[1] - q[1]) * r]
    // 环 + 辐条点（圈数按半径取整，每圈格数按周长）
    const dx = q[0] - center[0]
    const dy = q[1] - center[1]
    const ring = polarRing(Math.max(1, Math.round(Math.hypot(dx, dy) / s)), s)
    const step = (Math.PI * 2) / ring.n
    const a = Math.round(Math.atan2(dy, dx) / step) * step
    const gp: P = [center[0] + Math.cos(a) * ring.rr, center[1] + Math.sin(a) * ring.rr]
    const t: P = [gs[0] + (gp[0] - gs[0]) * g, gs[1] + (gp[1] - gs[1]) * g]
    return [q[0] + (t[0] - q[0]) * r, q[1] + (t[1] - q[1]) * r]
  }
  // 其余的点：世界坐标里一张固定的细网格，每格一个候选点（位置与优先级都按位置哈希），
  // 按优先级依次接受（离已有点太近的丢掉）。某处有没有片区只取决于附近的候选点，
  // 与地图大小无关，聚落长大时近处的片区不变。
  const cellSize = ctx.cfg.patch * 0.45
  const ox = ctx.MW / 2
  const oy = ctx.MH / 2
  const cands: { q: P; pr: number }[] = []
  for (let j = Math.floor((-oy - pad) / cellSize) - 1; j * cellSize < MH - oy + pad + cellSize; j++)
    for (let i = Math.floor((-ox - pad) / cellSize) - 1; i * cellSize < MW - ox + pad + cellSize; i++) {
      const cell: P = [ox + (i + 0.5) * cellSize, oy + (j + 0.5) * cellSize]
      const q: P = [cell[0] + (hashAt(ctx, cell, 'outer.site.x') - 0.5) * cellSize, cell[1] + (hashAt(ctx, cell, 'outer.site.y') - 0.5) * cellSize]
      if (q[0] < -pad || q[1] < -pad || q[0] > MW + pad || q[1] > MH + pad) continue
      cands.push({ q, pr: hashAt(ctx, cell, 'outer.site.order') })
    }
  cands.sort((a, b) => a.pr - b.pr)
  for (const cd of cands) {
    let q = cd.q
    const s = spacing(ctx, q)
    if (r > 0) q = snap(q, s)
    if (Math.abs(T.waterAt(q)) < s * 0.22) continue
    if (ok(q, s * 1.35)) {
      addSite(q)
    }
  }
  return sites
}

export function buildPatches(ctx: Ctx, arterials: P[][], exclude?: (q: P) => boolean, extra: P[] = []): Patch[] {
  const { MW, MH, T } = ctx
  const sites = makeSites(ctx, arterials, exclude, extra)
  const pad = sitePad(ctx)
  const bounds: [number, number, number, number] = [-pad, -pad, MW + pad, MH + pad]
  const { cells, nb } = voronoiCached(sites, bounds)
  // 不做 Lloyd 松弛：按优先级、保持间距的布点已经足够均匀；松弛会把画面边界附近的差别一圈圈传到城心，
  // 聚落就不能连续长大了（每个片区的形状只该取决于它的直接邻居）
  const patches: Patch[] = sites.map((s, i) => {
    const poly = canonical(cells[i], s)
    // 陆地占比：顶点、边中点与质心采样
    const samples: P[] = [...poly, centroid(poly)]
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]
      const b = poly[(k + 1) % poly.length]
      samples.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
      samples.push([(a[0] * 3 + b[0] + centroid(poly)[0] * 2) / 6, (a[1] * 3 + b[1] + centroid(poly)[1] * 2) / 6])
    }
    const land = samples.filter((q) => T.waterAt(q) > 0).length / samples.length
    return { poly, site: s, nb: [], land, inner: false }
  })
  // 邻接：Voronoi 裁剪时顺手记下的
  patches.forEach((pa, i) => (pa.nb = nb[i]))
  return patches
}

/**
 * 片区顶点从固定的一个开始（从站点看方位角最小的那个）：Voronoi 裁剪从哪个顶点起头随画面范围变，
 * 而片区里按边取的随机数（各边让出的路面宽……）是按顶点顺序取的，起头一变整块街坊就重排了。
 */
function canonical(poly: Poly, site: P): Poly {
  let k = 0
  let best = Infinity
  poly.forEach((v, i) => {
    const a = Math.atan2(v[1] - site[1], v[0] - site[0])
    if (a < best) {
      best = a
      k = i
    }
  })
  return k ? [...poly.slice(k), ...poly.slice(0, k)] : poly
}

/**
 * 片区剖分（Voronoi）按站点记下最近几次的结果：成长动画、拖人口时站点几乎不变，剖分是生成里最慢的一步之一。
 * 取出的是副本（片区的多边形会被后面的步骤引用、改写）
 */
const voronoiMemo = new Map<string, { cells: Poly[]; nb: number[][] }>()
function voronoiCached(sites: P[], bounds: [number, number, number, number]) {
  let h = 2166136261
  const f = new Float64Array(sites.length * 2 + 4)
  sites.forEach((q, i) => {
    f[i * 2] = q[0]
    f[i * 2 + 1] = q[1]
  })
  f.set(bounds, sites.length * 2)
  const u = new Uint32Array(f.buffer)
  for (let k = 0; k < u.length; k++) h = Math.imul(h ^ u[k], 16777619)
  const key = `${sites.length}#${(h >>> 0).toString(36)}`
  let hit = voronoiMemo.get(key)
  if (!hit) {
    hit = voronoiNb(sites, bounds)
    if (voronoiMemo.size >= 4) voronoiMemo.delete(voronoiMemo.keys().next().value!)
    voronoiMemo.set(key, hit)
  }
  return { cells: hit.cells.map((c) => c.map((q) => [q[0], q[1]] as P)), nb: hit.nb.map((n) => [...n]) }
}

/** 公共边（两个片区都有的两个顶点） */
export function sharedEdge(a: Patch, b: Patch): [P, P] | null {
  const vs = a.poly.filter((v) => Math.abs(dist(v, a.site) - dist(v, b.site)) < 0.05)
  return vs.length >= 2 ? [vs[0], vs[vs.length - 1]] : null
}


/** 由气候决定植被：林木多少、农田类型 */
export function vegetation(ctx: Ctx) {
  const c = ctx.p.climate
  if (!c) return { trees: 1, farm: true, paddy: eastAsian(ctx.p.culture) && ctx.p.relief < 0.6, vine: false }
  const b = c.biome
  const desert = b === Biome.HotDesert || b === Biome.ColdDesert || b === Biome.SaltFlat
  const cold = b === Biome.Tundra || b === Biome.IceCap
  const forest = b === Biome.TemperateForest || b === Biome.TemperateRainforest || b === Biome.Taiga || b === Biome.TropicalRainforest || b === Biome.TropicalSeasonalForest
  return {
    trees: desert ? 0.05 : cold ? 0.15 : forest ? 1.5 : b === Biome.Grassland || b === Biome.Savanna ? 0.4 : 0.9,
    farm: !cold && (!desert || !!ctx.p.river),
    paddy: eastAsian(ctx.p.culture) && c.temp > 14 && c.rain > 1000,
    vine: c.temp > 13 && c.rain < 900,
  }
}


/** 道路过水处：桥、渡口或浅滩 */
export function crossings(ctx: Ctx) {
  const { T, p } = ctx
  for (const r of ctx.out.roads) {
    if (r.kind === 'path') continue
    const line = resample(r.line, 2)
    // 过河途中碰到的沙洲、窄岛不算上岸，整段只架一座桥
    for (const [start, i] of wetRuns(line, T)) {
      // 路的过水段已经拉直成桥线（见 roads.ts 的 fixWet）：桥就是两岸最后、最先一个岸上点之间这一段，正压在路上
      if (start === 0 || T.waterAt(line[i]) < 0.5) continue
      const a = line[start - 1]
      const b = line[i]
      const span = dist(a, b)
      if (span < 3) continue
      const smallPlace = isVillage(p.size)
      const kind = smallPlace && span > 26 && r.kind === 'highway' ? 'ferry' : smallPlace && span < 14 && p.size === 'hamlet' ? 'ford' : 'bridge'
      ctx.out.crossings.push({ a, b, width: r.width + (kind === 'bridge' ? 1.5 : 0), kind })
      if (kind === 'ferry') mark(ctx, a, 'ferry')
    }
  }
}

/** 并成一片的几块农田：共用的中心（垄向、用地圈层按整片定），与片区之间的公共边（那里不留田埂以外的空隙） */
export interface FarmGroup {
  c: P
  seams: [P, P][]
}

/**
 * 农田。按真实的用地规律排布：
 * - 远近分层（杜能圈）：城边是菜园、果园与产奶的草场，往外是大片条田，再外牧场渐多；
 * - 顺水：河边低平的河漫滩是割草的草甸；东方湿热处的水田在临水的平地，临水的缓坡修梯田（沿等高线），离水远的平地是旱地；
 * - 成片同向：一片地里的条田共用一个垄向——坡上顺坡（排水）、梯田沿等高线，近路的垂直于路（从路上进地），
 *   其余按一张 500 米一格的方向场（相邻的地块走向一致）；一块块地各朝各的方向，正是开放田制里 furlong 的样子；
 * - 按坡度：陡坡不开垦，缓坡放牧、种果树葡萄。
 * g：这块地属于并成一片的农田（见 generate.ts 的 farmGroups），用地、色调、条带与同片的其他块连成一气。
 */
export function farm(ctx: Ctx, block: Poly, veg: ReturnType<typeof vegetation>, g?: FarmGroup) {
  const { T } = ctx
  const c0 = g?.c ?? centroid(block)
  // 同片共用的随机量（按片的中心取哈希）；单独一块时按这块地的中心
  const shared = (tag: string) => hashAt(ctx, c0, `farm.${tag}`)
  const uni = g && shared('uniform') < 0.6
  const onSeam = (a: P, b: P) => !!g?.seams.some(([s0, s1]) => segDist([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s0, s1).d < 1.5)
  const slope0 = T.slopeAt(c0)
  // 离最近城心多远（按城区半径）：决定用地的圈层
  const ring = centerDist(ctx, c0) / Math.max(150, ctx.Rin)
  const nearWater = T.waterAt(c0)
  const riverside = !!T.river && polylineDist(c0, T.river.line) < Math.max(...T.river.hw) + 90 && slope0 < 0.04
  const wet = veg.paddy && slope0 < 0.06 && nearWater < 350
  const terrace = veg.paddy && slope0 >= 0.06 && slope0 < 0.24 && nearWater < 500
  const ang = furlongAngle(ctx, c0, terrace)
  const dir: P = [Math.cos(ang), Math.sin(ang)]
  const across: P = [-dir[1], dir[0]]
  // 城墙里（城墙按规划修得比城大，墙根到城区之间空着）：不种大田，是小块的菜园、果园、葡萄园与放牧的公地
  const walled = ctx.cityWalls.length > 0 && inCity(ctx, c0)
  const parcels = walled
    ? subdivide(ctx, block, { maxA: 2400, minA: 400, alley: 2, alleyP: 0.6, depth: 0, fill: 1, irr: 0.7 })
    : subdivide(ctx, block, { maxA: fieldSize(ctx, c0), minA: 1500, alley: 3, alleyP: 0.5, depth: 0, fill: 1, irr: 0.9 })
  for (const { poly } of parcels) {
    // 每块地自己的随机数流（按位置）：前面的地盖没盖农舍、种了几棵树，不会让后面的地换庄稼
    const rng = rngAt(ctx, centroid(poly), 'farm.parcel')
    // 六成的片整片一种用地（一片牧场、一片麦田），其余每块地各自挑
    const r = uni ? shared('crop') : rng.next()
    const slope = T.slopeAt(centroid(poly))
    if (slope > 0.24) continue
    let kind: Field['kind']
    if (walled) kind = r < 0.5 ? (wet && r < 0.2 ? 'paddy' : 'garden') : r < 0.75 ? (veg.vine && r < 0.62 ? 'vineyard' : 'orchard') : 'pasture'
    else if (terrace) kind = r < 0.8 ? 'paddy' : 'orchard'
    else if (slope > 0.11) kind = r < 0.7 ? 'pasture' : r < 0.85 ? 'orchard' : veg.vine ? 'vineyard' : 'pasture'
    else if (riverside) kind = r < 0.65 ? 'meadow' : veg.paddy ? 'paddy' : 'crop'
    else if (wet) kind = r < 0.85 ? 'paddy' : 'garden'
    else if (ring < 1.7) kind = r < 0.35 ? 'garden' : r < 0.55 ? (veg.vine && r < 0.45 ? 'vineyard' : 'orchard') : r < 0.75 ? 'pasture' : 'crop'
    else if (ring < 3.4) kind = r < 0.72 ? 'crop' : r < 0.86 ? 'pasture' : r < 0.92 ? 'orchard' : r < 0.95 ? 'garden' : veg.vine ? 'vineyard' : 'crop'
    else kind = r < 0.45 ? 'crop' : r < 0.9 ? 'pasture' : r < 0.95 ? 'orchard' : 'meadow'
    const tone = uni ? shared('tone') : rng.next()
    // 农户多住在村里（见 generate.ts 的城外村庄），田里只在外圈偶有孤零零的农舍
    if (ring > 2.5 && rng.next() < 0.04) {
      const c = centroid(poly)
      const h = rect(c, dir, 14, 8)
      if (ctx.corridors.gap(c) < 90 && h.every((v) => pointInPoly(v, poly)) && addBuilding(ctx, h, 'house', 2)) {
        const shed = rect([c[0] + dir[1] * 10, c[1] - dir[0] * 10], dir, 10, 6)
        if (shed.every((v) => pointInPoly(v, poly))) addBuilding(ctx, shed, 'shed', 2)
      }
    }
    // 与同片相邻块的公共边上不内缩：两边的田接在一起，看不出片区的分界
    const inset = (q0: Poly, d: number) => insetConvex(q0, g ? q0.map((a, k) => (onSeam(a, q0[(k + 1) % q0.length]) ? 0 : d)) : d)
    const put = (q0: Poly, k: Field['kind'], t: number, d: number) => {
      const q = q0.length >= 3 ? placeable(ctx, inset(q0, d), 2, 0.25) : null
      if (q) ctx.out.fields.push({ poly: q, angle: ang, kind: k, tone: t })
    }
    // 条带的宽度与分界同片共用：垄沟跨过片区的边界接着走
    const cut = (tag: string) => (g ? (k: number) => hashAt(ctx, [g.c[0] + k, g.c[1]], `farm.cut.${tag}`) - 0.5 : () => rng.next() - 0.5)
    if (kind === 'crop') {
      // 长条田：沿垄向分成窄条（一户一条或几条）
      for (const q of bands(poly, dir, 11 + shared('strip') * 14, cut('strip'), !!g)) put(q, kind, (tone + rng.next() * 0.5) % 1, 0.5)
    } else if (kind === 'paddy') {
      // 水田：沿垄向分条再横切成一块块；梯田窄而长（沿等高线）
      const w = terrace ? 8 + shared('plotW') * 4 : 14 + shared('plotW') * 10
      const l = terrace ? 30 + shared('plotL') * 20 : 22 + shared('plotL') * 16
      for (const s of bands(poly, dir, w, cut('plot'), !!g)) for (const q of bands(s, across, l, () => 0, !!g)) put(q, kind, rng.next(), 0.6)
    } else if (kind === 'garden') {
      // 菜园：一畦畦小块，中间留窄径
      for (const s of bands(poly, dir, 16 + shared('gardenW') * 6, cut('garden'), !!g)) for (const q of bands(s, across, 12 + shared('gardenL') * 6, () => 0, !!g)) put(q, kind, rng.next(), 0.8)
    } else {
      const q = placeable(ctx, inset(poly, 1.5), 2, 0.25)
      if (!q) continue
      ctx.out.fields.push({ poly: q, angle: ang, kind, tone })
      if (kind === 'orchard') {
        // 果树成行，行向与垄向一致
        const b = obb(q)
        const R = Math.max(b.len, b.wid) / 2 + 8
        const inner = insetConvex(q, 3)
        for (let u = -R; u < R; u += 8)
          for (let v = -R; v < R; v += 8) {
            const t: P = [b.center[0] + dir[0] * u + across[0] * v, b.center[1] + dir[1] * u + across[1] * v]
            if (pointInPoly(t, inner) && !ctx.occ.hitsPoint(t, 1.5) && !ctx.corridors.hits(t, 1)) ctx.out.trees.push({ p: t, r: 2.6 })
          }
      }
      if ((kind === 'pasture' || kind === 'meadow') && rng.next() < 0.5) scatterTrees(ctx, q, kind === 'meadow' ? 0.0008 : 0.0004, 3, 5)
    }
  }
}

/**
 * 一块田最大多大（平方米）：离城心越远越大（城边是小块的菜园、果园，远处是大片的条田与牧场），
 * 按离城心的距离而不按城市的规模，城市长大时已有的田块不跟着重新划分
 */
function fieldSize(ctx: Ctx, q: P) {
  const t = Math.min(1, Math.max(0, (centerDist(ctx, q) - 400) / 1000))
  return 9000 + 7000 * t
}

/**
 * 凸多边形沿 dir 方向切成宽约 w 的长条（条的长边顺 dir）；jitter(第几条) 让分界略有错落。
 * global：分界落在全图统一的 w 间隔上（相邻几块地的条带对得上），否则在本块里均分。
 */
function bands(poly: Poly, dir: P, w: number, jitter: (k: number) => number, global = false): Poly[] {
  const n: P = [-dir[1], dir[0]]
  let lo = Infinity
  let hi = -Infinity
  for (const q of poly) {
    const t = q[0] * n[0] + q[1] * n[1]
    lo = Math.min(lo, t)
    hi = Math.max(hi, t)
  }
  const k0 = global ? Math.floor(lo / w) : 0
  const k = global ? Math.ceil(hi / w) - k0 : Math.max(1, Math.round((hi - lo) / w))
  const out: Poly[] = []
  let rest = poly
  for (let i = 1; i < k && rest.length >= 3; i++) {
    const t = global ? (k0 + i) * w + jitter(k0 + i) * w * 0.3 : lo + ((hi - lo) * i) / k + jitter(i) * w * 0.3
    const [x, y] = splitConvex(rest, [n[0] * t, n[1] * t], dir, 0)
    if (x.length >= 3) out.push(x)
    rest = y
  }
  if (rest.length >= 3) out.push(rest)
  return out
}

/** 各条路的外包盒（找最近的路时先粗筛） */
const roadBoxes = new WeakMap<Ctx, { line: P[]; box: [number, number, number, number] }[]>()

/**
 * 一片地的垄向（弧度，条田长边的方向）：坡上顺坡（梯田沿等高线）；120 米内有路就垂直于路；
 * 否则取 500 米一格的方向场（同一格里的地块同向）。
 */
function furlongAngle(ctx: Ctx, c: P, contour: boolean): number {
  const { T } = ctx
  if (T.slopeAt(c) > 0.06 || contour) {
    const gx = T.heightAt([c[0] + 6, c[1]]) - T.heightAt([c[0] - 6, c[1]])
    const gy = T.heightAt([c[0], c[1] + 6]) - T.heightAt([c[0], c[1] - 6])
    if (Math.hypot(gx, gy) > 1e-3) return Math.atan2(gy, gx) + (contour ? Math.PI / 2 : 0)
  }
  let boxes = roadBoxes.get(ctx)
  if (!boxes) {
    boxes = ctx.out.roads
      .filter((r) => r.kind === 'highway' || r.kind === 'main' || r.kind === 'street' || r.kind === 'lane')
      .map((r) => {
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (const q of r.line) {
          x0 = Math.min(x0, q[0])
          y0 = Math.min(y0, q[1])
          x1 = Math.max(x1, q[0])
          y1 = Math.max(y1, q[1])
        }
        return { line: r.line, box: [x0, y0, x1, y1] as [number, number, number, number] }
      })
    roadBoxes.set(ctx, boxes)
  }
  const reach = 120
  let best = reach
  let ang = NaN
  for (const { line, box } of boxes) {
    if (c[0] < box[0] - reach || c[0] > box[2] + reach || c[1] < box[1] - reach || c[1] > box[3] + reach) continue
    for (let i = 0; i + 1 < line.length; i++) {
      const d = segDist(c, line[i], line[i + 1]).d
      if (d < best) {
        best = d
        ang = Math.atan2(line[i + 1][1] - line[i][1], line[i + 1][0] - line[i][0])
      }
    }
  }
  if (!Number.isNaN(ang)) return ang + Math.PI / 2
  const cell = 500
  const ox = ctx.MW / 2
  const oy = ctx.MH / 2
  return hashAt(ctx, [ox + Math.floor((c[0] - ox) / cell) * cell, oy + Math.floor((c[1] - oy) / cell) * cell], 'outer.furlong') * Math.PI
}

/** 野地：按噪声成片的林地，陡坡上更密 */
export function wild(ctx: Ctx, block: Poly, veg: ReturnType<typeof vegetation>) {
  const { rng, T } = ctx
  if (veg.trees <= 0.02) return
  const c = centroid(block)
  // 林木成片：按离地图中心（世界原点）的坐标取，地图大小变了，林子还在原地
  const cluster = 0.5 + 0.5 * Math.sin((c[0] - ctx.MW / 2) * 0.011 + ctx.p.seed.length) * Math.cos((c[1] - ctx.MH / 2) * 0.013)
  const slope = T.slopeAt(c)
  const dens = veg.trees * (0.0006 + 0.004 * cluster * cluster + slope * 0.01)
  const g = clipWater(ctx, insetConvex(block, 3), 3)
  if (g) scatterTrees(ctx, g, dens, 3, 6.5)
  void rng
}

