import { blur, clamp } from '../gen/util'
import * as dmath from '../gen/dmath'
import { cultures } from './culture'
import { hashAt, type Core, type Ctx } from './ctx'
import { dist, polylineLength, resample, segDist, type P } from './geom'

/**
 * 街坊走向的张量场与它的流线（Chen 等 2008 的程序化街道建模）。
 *
 * 一处的走向是几种来源的加权：等高线（坡越陡越强）、干道的走向（离路越近越强）、岸线（离水越近越强）、
 * 核心的方格朝向与绕核心的环向（按规整度、放射度），再叠一层随位置缓慢摆动的底向。
 * 走向是无向的（东西与西东相同），所以按倍角 (cos 2θ, sin 2θ) 加权求和再取半角：互相垂直的两个来源相互抵消，
 * 同向、反向的则叠加。
 *
 * 流线沿主走向积分，彼此保持 dsep 左右的间距（Jobard–Lefer 的等距流线）；片区站点成排落在相邻两条流线之间，
 * Voronoi 片区的边界于是贴着流线：老城的街坊顺等高线、顺大路、顺河岸弯过去，而不是一片随机的多边形。
 *
 * 场与流线都只按"相对城心的位置"取值与排序，与画幅大小无关：聚落长大、画幅扩大时，近处的街坊不变。
 */

export interface TensorField {
  /** q 处的主走向（单位向量，正反同义） */
  dir: (q: P) => P
}

/** 一座城的走向场与它的母题设定（布局之初建好，片区剖分、城里的街都沿它走） */
export interface CityField {
  field: TensorField
  traits: FieldTraits
}

/** 场的取样格距（米）：比片区小得多，走向在格点之间双线性插值 */
const CELL = 16

/**
 * 街网的母题：张量场里哪一种来源占主导，一座城的样子由它定下大半。
 * - concentric 同心：街巷绕老城一圈圈展开，横街成了放射的辐条（讷德林根、布鲁日）；
 * - spine 脊街：一条大街贯穿全城，两侧的巷子成鱼骨（伯尔尼、宿场町）；
 * - river 顺河：街顺着河岸、海岸走（水乡、河港）；
 * - terrace 梯台：街顺着等高线一层层上山（山城、坂町）；
 * - drift 散漫：底向缓缓漂移，街坊各朝各的方向（自发生长的老镇）
 */
export type Motif = 'concentric' | 'spine' | 'river' | 'terrace' | 'drift'

/** 母题的名字与说明（界面用）；auto 按种子与地形抽 */
export const MOTIF_INFO: { id: Motif | 'auto'; name: string; desc: string }[] = [
  { id: 'auto', name: '自动', desc: '按种子与地形抽一种' },
  { id: 'concentric', name: '同心', desc: '街巷绕老城一圈圈展开，横街放射而出' },
  { id: 'spine', name: '脊街', desc: '一条大街贯穿全城，两侧的巷子成鱼骨' },
  { id: 'river', name: '顺河', desc: '街顺着河岸、海岸延伸' },
  { id: 'terrace', name: '梯台', desc: '街顺着等高线一层层上山' },
  { id: 'drift', name: '散漫', desc: '走向缓缓漂移，街坊各朝各的方向' },
]

/** 一座聚落的"性格"：同一个种子总是同一套，决定底向摆多大、多快，各种来源拉得多紧 */
export interface FieldTraits {
  motif: Motif
  /** 底向摆动的幅度（弧度） */
  wob: number
  /** 底向摆动的波长（米） */
  wobScale: number
  /** 等高线的权重 */
  contour: number
  /** 岸线的权重与影响距离（米） */
  shore: number
  shoreReach: number
  /** 绕城心环向的权重与影响距离（按城区半径的倍数） */
  ring: number
  ringReach: number
  /** 干道走向的权重与影响距离（按片区间距的倍数） */
  road: number
  roadReach: number
  /** 跳过的横街比例：越大，街坊越长 */
  merge: number
  /** 城里的街：主走向、副走向的线距（按基准街距的倍数）。母题决定哪个方向密：同心的环街密、辐条疏，脊街的肋巷密 */
  streetMajor: number
  streetMinor: number
  /** 副走向的街里有多少成了尽端巷（只从一头的路口伸进去，不通） */
  blind: number
}

/** 按种子、文明与地形抽母题：没有河、海就不抽顺河，平地不抽梯台 */
function pickMotif(ctx: Ctx): Motif {
  const { T, p } = ctx
  const b = cultures.get(p.culture).motifBias
  const w: [Motif, number][] = [
    ['concentric', b.concentric],
    ['spine', b.spine],
    ['drift', 0.8 * b.drift],
    ['river', T.river || T.coast ? 1.2 * b.river : 0],
    ['terrace', p.relief > 0.35 ? (0.6 + p.relief * 1.6) * b.terrace : 0],
  ]
  const sum = w.reduce((a, [, x]) => a + x, 0)
  let u = hashAt(ctx, ctx.center, 'tensor.motif') * sum
  for (const [m, x] of w) if ((u -= x) < 0) return m
  return 'drift'
}

export function fieldTraits(ctx: Ctx, motif: Motif = ctx.p.motif && ctx.p.motif !== 'auto' ? ctx.p.motif : pickMotif(ctx)): FieldTraits {
  const h = (tag: string) => hashAt(ctx, ctx.center, `tensor.${tag}`)
  const r = ctx.p.regularity
  const free = 1 - clamp(r / 0.8, 0, 1)
  const t: FieldTraits = {
    motif,
    wob: (0.25 + 0.45 * h('wob')) * free,
    wobScale: 280 + 360 * h('wobScale'),
    contour: 2.2 + 2.2 * h('contour'),
    shore: 1.2 + 1.4 * h('shore'),
    shoreReach: 90,
    ring: (0.35 + 0.7 * h('ring')) * free,
    ringReach: 0.9,
    road: 2.8,
    roadReach: 0.8,
    merge: (0.08 + 0.25 * h('merge')) * free,
    streetMajor: 1,
    streetMinor: 1.5 + 0.5 * h('streetMinor'),
    blind: 0,
  }
  // 母题加强它那一种来源（规整的城市里也照样起作用，只是底向的方格更强）
  if (motif === 'concentric') {
    t.ring = 2.6 + 1.4 * h('ring.m')
    t.ringReach = 2.2 + 1.2 * h('ring.r')
    // 干道多是从城心放射出去的，与环向正好垂直（倍角里相互抵消）：压低它，让干道成为辐条
    t.road = 0.4
    t.contour *= 0.5
    t.streetMajor = 1.05
    t.streetMinor = 2.2
  } else if (motif === 'spine') {
    t.road = 4.5 + 2 * h('road.m')
    t.roadReach = 2.4 + 1.4 * h('road.r')
    t.merge = Math.max(t.merge, 0.25 * free)
    t.ring *= 0.3
    // 鱼骨：与大街平行的街疏，垂直于大街的肋巷密
    t.streetMajor = 2.4
    t.streetMinor = 0.8
  } else if (motif === 'river') {
    t.shore = 3.5 + 2 * h('shore.m')
    t.shoreReach = 260 + 200 * h('shore.r')
    t.ring *= 0.4
    t.streetMajor = 0.9
    t.streetMinor = 1.4
  } else if (motif === 'terrace') {
    t.contour = 5 + 3 * h('contour.m')
    t.merge = Math.max(t.merge, 0.3 * free)
    t.ring *= 0.4
    // 顺等高线的街密，上下坡的巷子疏（陡处是石阶）
    t.streetMajor = 0.85
    t.streetMinor = 2.6
  } else {
    t.wob = (0.6 + 0.5 * h('wob.m')) * Math.max(free, 0.3)
    t.wobScale = 220 + 220 * h('wobScale.m')
    t.ring *= 0.5
    t.streetMajor = 1.1
    t.streetMinor = 1.25
  }
  ctx.style.streets?.(t)
  return t
}

/**
 * 张量场：按 CELL 米一格预先算好倍角向量，查询时双线性插值。
 * guides：参与定走向的干道（只取任何规模都有的那几条，见 generate.ts 的 layoutOrganic）
 */
export function buildField(ctx: Ctx, guides: P[][], pad: number, traits: FieldTraits): TensorField {
  const { T, MW, MH, p } = ctx
  const cores = ctx.layoutCores ?? ctx.cores
  // 格点对齐到城心（画幅中点）：画幅变大时已有的格点位置不变，模糊的结果也就不变
  const x0 = MW / 2 - Math.ceil((MW / 2 + pad) / CELL) * CELL
  const y0 = MH / 2 - Math.ceil((MH / 2 + pad) / CELL) * CELL
  const W = Math.ceil((MW + pad - x0) / CELL) + 1
  const H = Math.ceil((MH + pad - y0) / CELL) + 1
  const fx = new Float32Array(W * H)
  const fy = new Float32Array(W * H)
  const r = p.regularity
  const gridW = 0.4 + 3 * r * (1 - p.radial)
  const radW = 3 * r * p.radial
  // 干道折线的分段，供就近查找
  const segs: [P, P][] = []
  // 干道折线很密（寻路出来的几米一点）：按 15 米抽稀再查，走向的精度足够
  for (const g of guides) {
    const thin = thinLine(g, 15)
    for (let i = 0; i + 1 < thin.length; i++) segs.push([thin[i], thin[i + 1]])
  }
  const SB = 60
  const reach = ctx.cfg.patch * traits.roadReach
  const M = reach * 3
  const segGrid = new Map<number, number[]>()
  const sk = (i: number, j: number) => j * 100003 + i
  segs.forEach(([a, b], k) => {
    const i0 = Math.floor((Math.min(a[0], b[0]) - M) / SB)
    const i1 = Math.floor((Math.max(a[0], b[0]) + M) / SB)
    const j0 = Math.floor((Math.min(a[1], b[1]) - M) / SB)
    const j1 = Math.floor((Math.max(a[1], b[1]) + M) / SB)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (segGrid.get(sk(i, j)) ?? segGrid.set(sk(i, j), []).get(sk(i, j))!).push(k)
  })
  // 底向的摆动：相对城心的世界坐标上的平滑噪声（两层叠加，近似 fbm）
  const ox = MW / 2
  const oy = MH / 2
  // 格点上的随机值按 (格号, 用途) 记下：相邻的场格共用同一个格点，不必反复取哈希
  const lattice = new Map<number, number>()
  const latticeAt = (t: number, scale: number, i: number, j: number) => {
    const key = (t * 200003 + (i + 50000)) * 200003 + (j + 50000)
    let v = lattice.get(key)
    if (v === undefined) lattice.set(key, (v = hashAt(ctx, [ox + i * scale, oy + j * scale], t ? 'tensor.wob2' : 'tensor.wob')))
    return v
  }
  const noise = (q: P, scale: number, t: number) => {
    const gx = (q[0] - ox) / scale
    const gy = (q[1] - oy) / scale
    const ix = Math.floor(gx)
    const iy = Math.floor(gy)
    const tx = gx - ix
    const ty = gy - iy
    const sx = tx * tx * (3 - 2 * tx)
    const sy = ty * ty * (3 - 2 * ty)
    return (
      (latticeAt(t, scale, ix, iy) * (1 - sx) + latticeAt(t, scale, ix + 1, iy) * sx) * (1 - sy) +
      (latticeAt(t, scale, ix, iy + 1) * (1 - sx) + latticeAt(t, scale, ix + 1, iy + 1) * sx) * sy -
      0.5
    )
  }
  // 各核心方格朝向的倍角向量
  const coreDir = new Map(cores.map((c) => [c, [dmath.cos(2 * c.angle), dmath.sin(2 * c.angle)] as P]))
  let sx = 0
  let sy = 0
  // 沿向量 (x, y) 的走向（perp：与它垂直），倍角向量 = ((x² − y²), 2xy) / |v|²
  const addVec = (w: number, x: number, y: number, perp: boolean) => {
    const L2 = x * x + y * y
    if (L2 < 1e-12 || w <= 0) return
    const k = perp ? -w / L2 : w / L2
    sx += k * (x * x - y * y)
    sy += k * 2 * x * y
  }
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const q: P = [x0 + i * CELL, y0 + j * CELL]
      sx = 0
      sy = 0
      // 最近的核心：方格朝向 + 绕它的环向
      let core: Core = cores[0]
      let cd = Infinity
      for (const c of cores) {
        const d = dist(q, c.c) * c.k
        if (d < cd) {
          cd = d
          core = c
        }
      }
      // 底向摆动 wob：方格朝向转 wob（倍角里转 2 wob），环向转 wob / 2（倍角里转 wob）
      const wob = traits.wob * (noise(q, traits.wobScale, 0) * 1.4 + noise(q, traits.wobScale * 0.45, 1) * 0.6)
      const cw = dmath.cos(wob)
      const sw = dmath.sin(wob)
      const c2 = cw * cw - sw * sw
      const s2 = 2 * sw * cw
      const [gc, gs] = coreDir.get(core)!
      sx += gridW * (gc * c2 - gs * s2)
      sy += gridW * (gs * c2 + gc * s2)
      const rx = q[0] - core.c[0]
      const ry = q[1] - core.c[1]
      const dc = Math.sqrt(rx * rx + ry * ry)
      if (dc > 1) {
        // 环向（绕城心）：倍角向量是径向的倍角取反，再转 wob
        const ringW = traits.ring * dmath.exp(-dc / Math.max(120, core.R * traits.ringReach))
        const rc = -(rx * rx - ry * ry) / (dc * dc)
        const rs = -(2 * rx * ry) / (dc * dc)
        sx += ringW * (rc * cw - rs * sw)
        sy += ringW * (rs * cw + rc * sw)
        if (radW > 0) addVec(radW * Math.min(1, dc / 60), rx, ry, true)
      }
      // 等高线：坡越陡越听它的（平地上不起作用）
      const sl = T.slopeAt(q)
      if (sl > 0.015) {
        const gx = T.heightAt([q[0] + 20, q[1]]) - T.heightAt([q[0] - 20, q[1]])
        const gy = T.heightAt([q[0], q[1] + 20]) - T.heightAt([q[0], q[1] - 20])
        addVec(traits.contour * Math.min(1, (sl - 0.015) / 0.08), gx, gy, true)
      }
      // 岸线：沿着水边走
      const wd = T.waterAt(q)
      if (wd > -20 && wd < traits.shoreReach * 2.5) {
        const g = T.waterGrad(q)
        addVec(traits.shore * dmath.exp(-Math.max(0, wd) / traits.shoreReach), g[0], g[1], true)
      }
      // 干道：沿最近的路走
      let bd = reach * 3
      let bx = 0
      let by = 0
      for (const k of segGrid.get(sk(Math.floor(q[0] / SB), Math.floor(q[1] / SB))) ?? []) {
        const [a, b] = segs[k]
        const d = segDist(q, a, b).d
        if (d < bd) {
          bd = d
          bx = b[0] - a[0]
          by = b[1] - a[1]
        }
      }
      if (bd < reach * 3) addVec(traits.road * dmath.exp(-bd / reach), bx, by, false)
      const k = j * W + i
      fx[k] = sx
      fy[k] = sy
    }
  // 抹平小起伏带来的碎乱走向：倍角向量做几遍方框模糊（约 40 米），流线才长得长、拐得缓
  blur(fx, W, H, 2, 3)
  blur(fy, W, H, 2, 3)
  // 倍角向量 (c, s) 取半角：cos θ = √((1 + c) / 2)，sin θ = ±√((1 − c) / 2)（符号随 s）
  const dir = (q: P): P => {
    const gx = clamp((q[0] - x0) / CELL, 0, W - 1.001)
    const gy = clamp((q[1] - y0) / CELL, 0, H - 1.001)
    const i = Math.floor(gx)
    const j = Math.floor(gy)
    const tx = gx - i
    const ty = gy - j
    const k = j * W + i
    const c0 = (fx[k] * (1 - tx) + fx[k + 1] * tx) * (1 - ty) + (fx[k + W] * (1 - tx) + fx[k + W + 1] * tx) * ty
    const s0 = (fy[k] * (1 - tx) + fy[k + 1] * tx) * (1 - ty) + (fy[k + W] * (1 - tx) + fy[k + W + 1] * tx) * ty
    const L = Math.sqrt(c0 * c0 + s0 * s0)
    if (L < 1e-9) return [1, 0]
    const c = c0 / L
    const x = Math.sqrt(Math.max(0, (1 + c) / 2))
    const y = Math.sqrt(Math.max(0, (1 - c) / 2))
    return [x, s0 < 0 ? -y : y]
  }
  return { dir }
}

/** 点的空间哈希：每个点记着它属于哪条线 */
class PtHash {
  private m = new Map<number, number[]>()
  constructor(private cs: number) {}
  private key(i: number, j: number) {
    return j * 100003 + i
  }
  add(q: P, id: number) {
    const k = this.key(Math.floor(q[0] / this.cs), Math.floor(q[1] / this.cs))
    const a = this.m.get(k) ?? this.m.set(k, []).get(k)!
    a.push(q[0], q[1], id)
  }
  /** r 米以内、不属于 self 的点逐个交给 visit（按距离平方）；visit 返回 true 时提前结束 */
  private scan(q: P, r: number, self: number, visit: (d: number, a: number[], t: number) => boolean | void) {
    const n = Math.ceil(r / this.cs)
    const ci = Math.floor(q[0] / this.cs)
    const cj = Math.floor(q[1] / this.cs)
    for (let j = cj - n; j <= cj + n; j++)
      for (let i = ci - n; i <= ci + n; i++) {
        const a = this.m.get(this.key(i, j))
        if (!a) continue
        for (let t = 0; t < a.length; t += 3) {
          if (a[t + 2] === self) continue
          const dx = a[t] - q[0]
          const dy = a[t + 1] - q[1]
          if (visit(dx * dx + dy * dy, a, t)) return
        }
      }
  }
  /** r 米以内最近的点属于哪条线（没有为 -1） */
  nearest(q: P, r: number) {
    let best = -1
    let bd = r * r
    this.scan(q, r, NaN, (d, a, t) => {
      if (d < bd) {
        bd = d
        best = a[t + 2]
      }
    })
    return best
  }
  /** r 米以内最近的、不属于 self 的点（没有为 null） */
  nearestPoint(q: P, r: number, self = -1): P | null {
    let best: P | null = null
    let bd = r * r
    this.scan(q, r, self, (d, a, t) => {
      if (d < bd) {
        bd = d
        best = [a[t], a[t + 1]]
      }
    })
    return best
  }
  /** r 米以内有没有不属于 self 的点 */
  near(q: P, r: number, self = -1) {
    const r2 = r * r
    let hit = false
    this.scan(q, r, self, (d) => (hit = d < r2))
    return hit
  }
}

export interface Streamline {
  pts: P[]
  /** 这条线附近的街坊间距（米） */
  sep: number
}

export interface TraceOpts {
  /** 线距（随位置：城外的田野更疏） */
  sep: (q: P) => number
  /** 能不能走到这里（水、规划区、画外……） */
  open: (q: P) => boolean
  /** 已经存在、流线要让开的线（干道、河） */
  fixed: P[][]
  /** 种子的范围 */
  bounds: [number, number, number, number]
  /** 0 沿主走向，1 沿与它垂直的副走向 */
  family: 0 | 1
}

const STEP = 5

/**
 * 等距流线：种子由近城心到远依次试，离已有的线不到 sep 就跳过；
 * 每条线从种子往两头积分（中点法），走到水边、规划区、离同族的线不到 0.55 sep 或掉头太急时停下。
 */
export function traceStreamlines(ctx: Ctx, F: TensorField, o: TraceOpts): Streamline[] {
  // 格子按城心处的线距定：查询半径（0.55 ~ 0.9 sep）只扫附近几格
  const hash = new PtHash(clamp(o.sep(ctx.center) * 0.45, 16, 64))
  o.fixed.forEach((line, k) => {
    for (const q of resample(line, 6)) hash.add(q, -2 - k)
  })
  const lines: Streamline[] = []
  // 副走向：主走向转 90°
  const field = (q: P): P => {
    const d = F.dir(q)
    return o.family ? [-d[1], d[0]] : d
  }
  const dirAt = (q: P, px: number, py: number): P => {
    let [dx, dy] = field(q)
    if (dx * px + dy * py < 0) {
      dx = -dx
      dy = -dy
    }
    return [dx, dy]
  }
  const trace = (s: P, sep: number, id: number): P[] => {
    const halves: P[][] = []
    for (const sg of [1, -1]) {
      const d0 = field(s)
      let px = d0[0] * sg
      let py = d0[1] * sg
      let q = s
      const seg: P[] = []
      for (let st = 0; st < 900; st++) {
        const d1 = dirAt(q, px, py)
        const mid: P = [q[0] + (d1[0] * STEP) / 2, q[1] + (d1[1] * STEP) / 2]
        const d2 = dirAt(mid, d1[0], d1[1])
        const nq: P = [q[0] + d2[0] * STEP, q[1] + d2[1] * STEP]
        // 一步里拐得太急（场的奇点附近）就停
        if (d2[0] * px + d2[1] * py < 0.8) break
        if (!o.open(nq)) break
        const sp = Math.min(sep, o.sep(nq))
        if (hash.near(nq, sp * 0.55, id)) break
        seg.push(nq)
        q = nq
        px = d2[0]
        py = d2[1]
        // 绕回到自己附近（闭合的环）
        if (seg.length > 40 && dist(nq, s) < STEP * 1.5) break
      }
      halves.push(seg)
    }
    return [...halves[1].reverse(), s, ...halves[0]]
  }
  // 种子：一张以城心为原点的抖动格网，由近到远
  const [bx0, by0, bx1, by1] = o.bounds
  const c = ctx.center
  const G = 30
  const seeds: [number, P][] = []
  for (let j = Math.floor((by0 - c[1]) / G); j * G + c[1] <= by1; j++)
    for (let i = Math.floor((bx0 - c[0]) / G); i * G + c[0] <= bx1; i++) {
      const cell: P = [c[0] + i * G, c[1] + j * G]
      const q: P = [cell[0] + (hashAt(ctx, cell, 'tensor.seed.x', o.family) - 0.5) * G, cell[1] + (hashAt(ctx, cell, 'tensor.seed.y', o.family) - 0.5) * G]
      seeds.push([dist(q, c) + hashAt(ctx, cell, 'tensor.seed.o', o.family) * G, q])
    }
  seeds.sort((a, b) => a[0] - b[0])
  for (const [, s] of seeds) {
    if (!o.open(s)) continue
    const sep = o.sep(s)
    if (hash.near(s, sep * 0.9)) continue
    const id = lines.length
    const pts = trace(s, sep, id)
    if (pts.length * STEP < sep * 1.6) continue
    lines.push({ pts, sep })
    for (const q of pts) hash.add(q, id)
  }
  return lines
}

/** 折线抽稀：相邻保留点至少隔 step 米（首尾必留） */
function thinLine(line: P[], step: number): P[] {
  if (line.length < 3) return line
  const out: P[] = [line[0]]
  for (let i = 1; i + 1 < line.length; i++) if (dist(out[out.length - 1], line[i]) >= step) out.push(line[i])
  out.push(line[line.length - 1])
  return out
}

/**
 * 两族流线围成的格子的中心作站点：沿每条主线，按它与副线的交点切段（太长的段再等分，太短的并掉，
 * 少数交点按 merge 的比例跳过，街坊于是有长有短），每段的中点往两侧各量到相邻的主线（或水边、禁区），
 * 站点放在中点。相邻两条主线量到的是同一个格子的中心，后来的被调用方的间距检查挡掉；
 * 每个站点的四邻都是同一张格网上的格子，Voronoi 边界于是贴着两族流线。
 */
export function cellSites(ctx: Ctx, majors: Streamline[], minors: Streamline[], o: { open: (q: P) => boolean; along: (sep: number) => number; merge: number }): P[] {
  const hash = new PtHash(8)
  majors.forEach((l, k) => {
    for (const q of l.pts) hash.add(q, k)
  })
  const cross = new PtHash(6)
  minors.forEach((l, k) => {
    for (const q of l.pts) cross.add(q, k)
  })
  const out: P[] = []
  majors.forEach((l, k) => {
    const step = o.along(l.sep)
    const pts = l.pts
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
    const L = cum[cum.length - 1]
    // 与副线的交点（弧长）：同一条副线只记一次
    const cuts: number[] = [0]
    let last = -1
    for (let i = 0; i < pts.length; i++) {
      const id = cross.nearest(pts[i], STEP * 0.75)
      if (id < 0 || id === last) continue
      last = id
      if (hashAt(ctx, pts[i], 'tensor.merge') < o.merge) continue
      cuts.push(cum[i])
    }
    cuts.push(L)
    const mids: number[] = []
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i]
      const b = cuts[i + 1]
      if (b - a < step * 0.35) continue
      const n = Math.max(1, Math.round((b - a) / (step * 1.5)))
      for (let t = 0; t < n; t++) mids.push(a + ((b - a) * (t + 0.5)) / n)
    }
    let j = 0
    for (const sm of mids) {
      while (j + 2 < cum.length && cum[j + 1] < sm) j++
      const a = pts[j]
      const b = pts[j + 1] ?? pts[j]
      const d = dist(a, b)
      if (d < 1e-9) continue
      const t = (sm - cum[j]) / d
      const q: P = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const nx = -(b[1] - a[1]) / d
      const ny = (b[0] - a[0]) / d
      for (const sg of [1, -1]) {
        // 往一侧量：碰到别的主线、水边或禁区为止
        let gap = l.sep
        for (let s = 4; s <= l.sep * 1.3; s += 3) {
          const m: P = [q[0] + nx * s * sg, q[1] + ny * s * sg]
          if (!o.open(m) || hash.near(m, 4, k)) {
            gap = s
            break
          }
        }
        out.push([q[0] + nx * (gap / 2) * sg, q[1] + ny * (gap / 2) * sg])
      }
    }
  })
  return out
}

/**
 * 街的端头往前接到别的路上（丁字路口）：流线在离别的线还有半个线距时就停了，
 * 顺着端头的方向往前看 reach 米，碰到别的街或已有的路就延长过去；路上走不通（open 为假）就不接。
 * lines 原地改写
 */
export function joinEnds(lines: P[][], others: P[][], reach: number, open: (q: P) => boolean) {
  const hash = new PtHash(6)
  lines.forEach((l, k) => {
    for (const q of l) hash.add(q, k)
  })
  others.forEach((l, k) => {
    for (const q of resample(l, 4)) hash.add(q, -2 - k)
  })
  lines.forEach((l, k) => {
    if (l.length < 3) return
    for (const head of [true, false]) {
      const e = head ? l[0] : l[l.length - 1]
      const p = head ? l[2] : l[l.length - 3]
      const d = dist(e, p)
      if (d < 1e-6) continue
      const ux = (e[0] - p[0]) / d
      const uy = (e[1] - p[1]) / d
      for (let s = 2; s <= reach; s += 2) {
        const m: P = [e[0] + ux * s, e[1] + uy * s]
        const hit = hash.nearestPoint(m, 3, k)
        if (hit) {
          if (head) l.unshift(hit)
          else l.push(hit)
          break
        }
        if (!open(m)) break
      }
    }
  })
}

/**
 * 尽端巷：把线在与 others 相交（相接）处断开，每一段只从一头的路口往里伸一截就到头，两头不通。
 * 两个路口之间的一段从一头（偶尔两头各一条）伸进去不到一半；线头、线尾只连着一个路口的，从路口往外伸。
 * 一个路口也不挨着的线不要。长的巷子中途偶尔横着分一个叉（open 管叉的端头能不能到）。返回各条巷子（从路口起）
 */
export function blindAlleys(ctx: Ctx, lines: P[][], others: P[][], maxLen: number, open: (q: P) => boolean): P[][] {
  const hash = new PtHash(8)
  others.forEach((l, k) => {
    for (const q of resample(l, 4)) hash.add(q, k)
  })
  const out: P[][] = []
  // 从下标 i 起往 dir 方向沿线走 len 米（不越过 stop）
  const walk = (l: P[], i: number, dir: 1 | -1, stop: number, len: number) => {
    const pts: P[] = [l[i]]
    let acc = 0
    for (let k = i + dir; dir > 0 ? k <= stop : k >= stop; k += dir) {
      acc += dist(l[k - dir], l[k])
      pts.push(l[k])
      if (acc >= len) break
    }
    return acc >= 10 ? pts : null
  }
  for (const l of lines) {
    // 路口：挨着别的路的一串点取中间那个
    const at: number[] = []
    let run = -1
    for (let i = 0; i <= l.length; i++) {
      const on = i < l.length && hash.nearest(l[i], 4) >= 0
      if (on && run < 0) run = i
      if (!on && run >= 0) {
        at.push((run + i - 1) >> 1)
        run = -1
      }
    }
    if (!at.length) continue
    const h = (k: number, tag: string) => hashAt(ctx, l[at[k]], `tensor.blind.${tag}`)
    const push = (pts: P[] | null) => {
      if (!pts) return
      out.push(pts)
      // 分叉：从中途的一点横着伸出一小段，端头离别的路、别的巷子都远
      const m = pts.length >> 1
      const hb = hashAt(ctx, pts[m], 'tensor.blind.branch')
      if (pts.length < 6 || hb > 0.45) return
      const d = dist(pts[m - 1], pts[m]) || 1
      const side = hb < 0.225 ? 1 : -1
      const len = 8 + 8 * hashAt(ctx, pts[m], 'tensor.blind.branchLen')
      const n: P = [((-(pts[m][1] - pts[m - 1][1])) / d) * side, ((pts[m][0] - pts[m - 1][0]) / d) * side]
      const end: P = [pts[m][0] + n[0] * len, pts[m][1] + n[1] * len]
      const mid: P = [pts[m][0] + n[0] * len * 0.5, pts[m][1] + n[1] * len * 0.5]
      if (open(end) && hash.nearest(end, 7) < 0 && hash.nearest(mid, 4) < 0) out.push([pts[m], mid, end])
    }
    // 线头、线尾各自一半的机会：两头都留时，路口两边的巷子正对着，看着像一条穿过去的街
    const hh = h(0, 'head')
    const ht = h(at.length - 1, 'tail')
    if (hh < 0.55) push(walk(l, at[0], -1, 0, maxLen * (0.6 + 0.7 * hh)))
    if (ht < 0.55) push(walk(l, at[at.length - 1], 1, l.length - 1, maxLen * (0.6 + 0.7 * ht)))
    for (let k = 0; k + 1 < at.length; k++) {
      const a = at[k]
      const b = at[k + 1]
      const span = polylineLength(l.slice(a, b + 1))
      const u = h(k, 'span')
      if (u < 0.3) {
        // 两头各伸一条，中间隔开
        const len = Math.min(maxLen, span * 0.38)
        push(walk(l, a, 1, b, len))
        push(walk(l, b, -1, a, len))
        continue
      }
      const len = Math.min(maxLen, span * (0.4 + 0.25 * u))
      push(u < 0.65 ? walk(l, a, 1, b, len) : walk(l, b, -1, a, len))
    }
  }
  return out
}
