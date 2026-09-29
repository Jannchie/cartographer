import { RNG } from '../gen/rng'
import { area, bboxOf, centroid, circlePoly, clipHalf, convexOverlap, dist, insetConvex, pointInPoly, resample, segDist, segPolyDist, type BBox, type P, type Poly } from './geom'
import type { DistrictWhere, LandmarkNameKind, SettleNamer } from './names'
import type { TerrainResult } from './terrain'
import type { FeatureEnv, FeatureId } from './features'
import type { CityPlan, PlanZone } from './plans/types'
import type { CultureStyle } from './culture'
import type { Density, Landmark, Settlement, SettlementParams, Tier, Wall, WardType } from './types'

/** 各规模的结构参数 */
export interface SizeCfg {
  /** 城内片区数 */
  inner: number
  /** 片区间距（米） */
  patch: number
  /** 对外道路条数 */
  roads: [number, number]
  /** 城内街宽 / 主街宽 / 城外大路宽 */
  lane: number
  main: number
  highway: number
}

/**
 * "走廊"：道路、河流、城墙这类带宽度的线状要素。
 * 小地块（住宅、田垄）与走廊相交时，用走廊边线所在的半平面裁掉越界的部分，
 * 于是房屋自然沿街退让、沿河收边，而无需通用的多边形布尔运算。
 */
export type CorridorTag = 'road' | 'river' | 'wall'

/** 撤回用的记号：登记了几条、拆除记录有多长（见 undo.ts 的 checkpoint） */
export type RegMark = readonly [number, number]

export class Corridors {
  /** dead：已拆掉的路段（只打标记） */
  private segs: { a: P; b: P; hw: number; tag: CorridorTag; dead?: boolean }[] = []
  private grid = new Map<number, number[]>()
  private readonly B = 40
  /** 拆除记录（被 removeWhere 打上 dead 的段），撤回时复活 */
  private killed: number[] = []

  private cells(s: { a: P; b: P; hw: number }, f: (k: number) => void) {
    const { a, b } = s
    const r = s.hw + 2
    const x0 = Math.floor((Math.min(a[0], b[0]) - r) / this.B)
    const x1 = Math.floor((Math.max(a[0], b[0]) + r) / this.B)
    const y0 = Math.floor((Math.min(a[1], b[1]) - r) / this.B)
    const y1 = Math.floor((Math.max(a[1], b[1]) + r) / this.B)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) f(y * 4096 + x)
  }

  add(line: P[], hw: number, tag: CorridorTag = 'road') {
    for (let i = 0; i + 1 < line.length; i++) {
      const id = this.segs.length
      const s = { a: line[i], b: line[i + 1], hw, tag }
      this.segs.push(s)
      this.cells(s, (k) => {
        let l = this.grid.get(k)
        if (!l) this.grid.set(k, (l = []))
        l.push(id)
      })
    }
  }

  mark(): RegMark {
    return [this.segs.length, this.killed.length]
  }

  /** 撤回到 mark 时的样子：之后拆掉的段复活，之后登记的段删掉 */
  truncate([n, k]: RegMark) {
    for (let i = this.killed.length - 1; i >= k; i--) this.segs[this.killed[i]].dead = false
    this.killed.length = k
    for (let id = this.segs.length - 1; id >= n; id--)
      this.cells(this.segs[id], (key) => {
        const l = this.grid.get(key)!
        while (l.length && l[l.length - 1] >= n) l.pop()
      })
    this.segs.length = n
  }

  /** near 的去重：每段记下最后一次被收进哪一次查询（比每次新建 Set 快得多，走廊查询是生成里最频繁的操作） */
  private seen: number[] = []
  private query = 0
  private near(poly: Poly, pad = 0): number[] {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of poly) {
      x0 = Math.min(x0, p[0] - pad)
      y0 = Math.min(y0, p[1] - pad)
      x1 = Math.max(x1, p[0] + pad)
      y1 = Math.max(y1, p[1] + pad)
    }
    const q = ++this.query
    const seen = this.seen
    const out: number[] = []
    for (let y = Math.floor(y0 / this.B); y <= Math.floor(y1 / this.B); y++)
      for (let x = Math.floor(x0 / this.B); x <= Math.floor(x1 / this.B); x++) {
        const l = this.grid.get(y * 4096 + x)
        if (l)
          for (const id of l)
            if (seen[id] !== q) {
              seen[id] = q
              out.push(id)
            }
      }
    return out
  }

  /**
   * 多边形是否碰到走廊（离走廊中线不足半宽 + pad）。tags 限定只看某几类走廊。
   * 贴着走廊边线放置的地块（裁剪结果）不算碰到。
   */
  hitsPoly(poly: Poly, pad = 0, tags?: CorridorTag[]) {
    for (const id of this.near(poly, Math.max(0, pad))) {
      const s = this.segs[id]
      if (s.dead) continue
      if (tags && !tags.includes(s.tag)) continue
      if (segPolyDist(s.a, s.b, poly) < s.hw + pad - 0.05) return true
    }
    return false
  }

  /** 拆掉满足条件的走廊段（宫城圈进去的街巷）；给了 bb 只看这个范围里的 */
  removeWhere(f: (a: P, b: P, tag: CorridorTag, hw: number) => boolean, bb: Poly) {
    for (const id of this.near(bb)) {
      const s = this.segs[id]
      if (!s.dead && f(s.a, s.b, s.tag, s.hw)) {
        s.dead = true
        this.killed.push(id)
      }
    }
  }

  /** 点是否落在某条走廊里；tags 限定只看某几类 */
  hits(p: P, pad = 0, tags?: CorridorTag[]) {
    for (const id of this.near([p])) {
      const s = this.segs[id]
      if (s.dead || (tags && !tags.includes(s.tag))) continue
      if (segDist(p, s.a, s.b).d < s.hw + pad) return true
    }
    return false
  }

  /** 最近走廊的距离（减去半宽） */
  gap(p: P) {
    let best = Infinity
    for (const id of this.near([[p[0] - 60, p[1] - 60], [p[0] + 60, p[1] + 60]])) {
      const s = this.segs[id]
      if (s.dead) continue
      best = Math.min(best, segDist(p, s.a, s.b).d - s.hw)
    }
    return best
  }

  /** 用走廊边线裁掉越界的部分；tags 限定只按某几类走廊裁 */
  clip(poly: Poly, tags?: CorridorTag[]): Poly | null {
    let out = poly
    for (let pass = 0; pass < 2; pass++) {
      const c = centroid(out)
      for (const id of this.near(out)) {
        const s = this.segs[id]
        if (s.dead) continue
        if (tags && !tags.includes(s.tag)) continue
        const { d, t } = segDist(c, s.a, s.b)
        if (d < s.hw && t > 0 && t < 1) return null
        // 用线段到多边形（含内部）的距离判断：街道从大地块中间穿过、附近没有顶点时也要切
        const gap = segPolyDist(s.a, s.b, out)
        if (gap >= s.hw - 0.05) continue
        const dx = s.b[0] - s.a[0]
        const dy = s.b[1] - s.a[1]
        const L = Math.hypot(dx, dy) || 1
        // 只是擦边、且投影落在线段外很远：交给相邻线段处理（避免直线外延误切）；真正穿过的线段总要切
        const tu = ((c[0] - s.a[0]) * dx + (c[1] - s.a[1]) * dy) / (L * L)
        if (gap > 0 && (tu < -0.6 || tu > 1.6)) continue
        let nx = -dy / L
        let ny = dx / L
        if ((c[0] - s.a[0]) * nx + (c[1] - s.a[1]) * ny < 0) {
          nx = -nx
          ny = -ny
        }
        out = clipHalf(out, [s.a[0] + nx * s.hw, s.a[1] + ny * s.hw], [-nx, -ny])
        if (out.length < 3) return null
      }
    }
    return out
  }
}

/**
 * 占地登记：已经放下的建筑、码头、船等实体。
 * 任何新实体落地前都要先查这里，保证特殊建筑、院落、码头之间互不重叠。
 */
export class Occupancy {
  /** dead：已删除（只打标记，不重建网格） */
  private items: { poly: Poly; bb: BBox; dead?: boolean }[] = []
  private grid = new Map<number, number[]>()
  private readonly B = 24
  /** 拆除记录（被 removeWhere 打上 dead 的实体），撤回时复活 */
  private killed: number[] = []

  private cells(bb: BBox, pad: number, f: (k: number) => void) {
    for (let y = Math.floor((bb[1] - pad) / this.B); y <= Math.floor((bb[3] + pad) / this.B); y++)
      for (let x = Math.floor((bb[0] - pad) / this.B); x <= Math.floor((bb[2] + pad) / this.B); x++) f(y * 8192 + x)
  }

  add(poly: Poly) {
    const id = this.items.length
    const bb = bboxOf(poly)
    this.items.push({ poly, bb })
    this.cells(bb, 0, (k) => {
      let l = this.grid.get(k)
      if (!l) this.grid.set(k, (l = []))
      l.push(id)
    })
  }

  mark(): RegMark {
    return [this.items.length, this.killed.length]
  }

  /** 撤回到 mark 时的样子：之后删掉的实体复活，之后登记的删掉 */
  truncate([n, k]: RegMark) {
    for (let i = this.killed.length - 1; i >= k; i--) this.items[this.killed[i]].dead = false
    this.killed.length = k
    for (let id = this.items.length - 1; id >= n; id--)
      this.cells(this.items[id].bb, 0, (key) => {
        const l = this.grid.get(key)!
        while (l.length && l[l.length - 1] >= n) l.pop()
      })
    this.items.length = n
  }

  /** 与已登记实体相交（pad > 0 时还要求留出 pad 米的间隙） */
  overlaps(poly: Poly, pad = 0) {
    const bb = bboxOf(poly)
    const seen = new Set<number>()
    let hit = false
    this.cells(bb, pad, (k) => {
      if (hit) return
      for (const id of this.grid.get(k) ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        const it = this.items[id]
        if (it.dead) continue
        if (it.bb[0] > bb[2] + pad || it.bb[2] < bb[0] - pad || it.bb[1] > bb[3] + pad || it.bb[3] < bb[1] - pad) continue
        if (convexOverlap(poly, it.poly, pad > 0 ? -pad : 0.05)) {
          hit = true
          return
        }
      }
    })
    return hit
  }

  /** 圆（树冠、井）是否压到已登记实体 */
  hitsPoint(p: P, r: number) {
    if (r <= 0) {
      const seen = new Set<number>()
      let hit = false
      this.cells([p[0], p[1], p[0], p[1]], 0, (k) => {
        for (const id of this.grid.get(k) ?? []) {
          if (hit || seen.has(id)) continue
          seen.add(id)
          if (!this.items[id].dead && pointInPoly(p, this.items[id].poly)) hit = true
        }
      })
      return hit
    }
    return this.overlaps(circlePoly(p, r, 8))
  }

  /** 包围盒与 bb 相交的实体 */
  query(bb: BBox): Poly[] {
    const out = new Set<Poly>()
    this.cells(bb, 0, (k) => {
      for (const id of this.grid.get(k) ?? []) {
        const it = this.items[id]
        if (!it.dead && it.bb[0] <= bb[2] && it.bb[2] >= bb[0] && it.bb[1] <= bb[3] && it.bb[3] >= bb[1]) out.add(it.poly)
      }
    })
    return [...out]
  }

  /** 删除满足条件的实体（腾地方给后来的地标、奇观）；给了 bb 只看这个范围里的 */
  removeWhere(f: (poly: Poly) => boolean, bb?: BBox) {
    const kill = (id: number) => {
      const it = this.items[id]
      if (!it.dead && f(it.poly)) {
        it.dead = true
        this.killed.push(id)
      }
    }
    if (bb) this.cells(bb, 0, (k) => (this.grid.get(k) ?? []).forEach(kill))
    else this.items.forEach((_, id) => kill(id))
  }
}

export interface Ctx {
  p: SettlementParams
  rng: RNG
  T: TerrainResult
  cfg: SizeCfg
  namer: SettleNamer
  MW: number
  MH: number
  center: P
  /** 城区半径估计（米） */
  Rin: number
  /** 种子的哈希（hashAt 用） */
  seedHash: number
  /** 本文明的盖法（styles/） */
  style: CultureStyle
  /** 各模块在这次生成里的状态（规划形制的方格、麦地那已建的设施……），随 ctx 一起丢掉 */
  memo: Map<string, unknown>
  /** 正在盖不算城里人口的房子（城外的村子、都城的宫殿）：不占民居预算，见 addBuilding */
  uncounted: boolean
  /** 正在盖东方疏档的大宅（一家人住好几座屋），见 eastWard */
  estate: boolean
  /** 城区核心：主中心与副中心（副都心），见 Core */
  cores: Core[]
  /**
   * 片区剖分用的核心：现有的核心，再加上城市长大后才出现的副中心（按它们出现时的位置）。
   * 片区的站点、方格吸附、街网归属都按它：副中心出现时那一带的片区早已按它划好，不会整片重划
   */
  layoutCores?: Core[]
  /** 各片城区的城墙（卫星城各有一道；不含城堡幕墙与瓮城） */
  cityWalls: Wall[]
  /** 都城布局时预留的宫城矩形（见 generate.ts 的 palaceZone） */
  palaceRect?: Poly
  /** 还能盖多少户民居（house / large）：由目标人口折算，盖满就停 */
  houseBudget: number
  /** 当前片区的占用率（0 ~ 1）：每块宅地按位置哈希决定盖不盖（见 generate.ts 的 occupancy） */
  wardFill: number
  /**
   * 当前片区还能住多少户（按片区的容量 × 占用率分下来的名额）：各片区只盖自己名额里的，
   * 某块片区翻建得更密，也不会把别的片区的房子挤掉（民居预算是全城的上限，名额是各片区自己的）
   */
  wardQuota: number
  /** 生成成长史时的记录（见 history.ts）；单次生成时没有 */
  history?: import('./history').HistoryState
  /** 当前片区是街坊（true）还是零散的农家：村 → 镇连续过渡，各片区按位置哈希与街坊占比定（见 generate.ts 的 wardTown） */
  wardTown: boolean
  /** 当前片区定下功能时的人口（地标按它定规模；没有记录的按现在的人口） */
  wardPop?: number
  /** 当前片区的密度档（决定地块大小、层数与形态，见 scale.ts 的 densityOf） */
  wardDensity: Density
  /** 当前片区的类型（民居住户的营生按它抽，见 people.ts） */
  wardType: WardType
  /** 正在盖的地标的规模档（见 Tier）：教堂、神社、园林、城堡的盖法据此收放元素池与尺度 */
  tier: Tier
  /** 规划布局的网格朝向（弧度）；院落据此判断坐北朝南 */
  gridAngle: number
  /** 城市形制与规划区（有机生长时没有） */
  plan?: { def: CityPlan; z: PlanZone }
  /** 要素环境与各要素数量（features.ts） */
  env: FeatureEnv
  counts: Record<FeatureId, number>
  corridors: Corridors
  occ: Occupancy
  out: Omit<Settlement, 'params' | 'name' | 'nameZh' | 'nameJa' | 'width' | 'height' | 'terrain' | 'river' | 'sea' | 'stats'>
  /** 从输出数组里删掉的东西（按删除的先后）：撤回时原样插回去（见 undo.ts） */
  dropped: { key: keyof Ctx['out']; idx: number; item: unknown }[]
}

/**
 * 抽签的用途名（tag）→ 32 位整数（FNV-1a）。tag 一律用字符串"模块.用途"（如 'medina.gate'），
 * 不同模块各用各的名字，不会像以前的数字 tag 那样撞号；同一个 tag 只在一处用（scratchpad 的查重脚本会查）。
 */
const tagKeys = new Map<string, number>()
export function keyOf(tag: string, i = 0) {
  // 用途名的哈希记下来（用途名是固定的一批字符串，抽签却是成千上万次）
  let h = tagKeys.get(tag)
  if (h === undefined) {
    h = 0x811c9dc5
    for (let k = 0; k < tag.length; k++) h = Math.imul(h ^ tag.charCodeAt(k), 0x01000193)
    tagKeys.set(tag, h)
  }
  // 序号（同一用途的第 i 次抽签）再搅一遍
  if (i) h = Math.imul(h ^ Math.imul(i, 0x9e3779b1), 0x85ebca77) ^ (h >>> 15)
  return h >>> 0
}

/**
 * 按位置取的随机数（0 ~ 1）：同一个种子、同一个位置（相对城心的世界坐标，按半米取整）、同一个用途 tag（与序号 i），
 * 在任何规模下都得到同一个值。代替"按抽签顺序"的随机数流，聚落长大时已有的东西才不会整体重抽。
 */
export function hashAt(ctx: Ctx, q: P, tag: string, i = 0) {
  return mix(ctx.seedHash ^ keyOf(tag, i), Math.round((q[0] - ctx.MW / 2) * 2), Math.round((q[1] - ctx.MH / 2) * 2))
}

/** 按位置播种的随机数流（片区填房子、寻路的扰动）：同一个种子、同一处、同一个 tag 总是同一串 */
export function rngAt(ctx: Ctx, q: P, tag: string) {
  return new RNG(Math.floor(hashAt(ctx, q, tag) * 4294967296) ^ ctx.seedHash)
}

/**
 * 一处地标的"骰子"：宫殿、城堡、教堂这类按模板盖的建筑，用它在几套形制之间抽签、在一个范围里取比例。
 * 每次抽签有自己的名字：V.h('wall') 就是 hashAt(ctx, q, 'tag.wall')，同一个种子、同一个位置、同一个名字总抽到同一个结果，
 * 与抽签的先后无关（前面多抽、少抽一次都不影响后面），人口变了也不会重排。i 是同一个名字下的序号（第几座岛、第几块石）。
 */
export function dice(ctx: Ctx, q: P, tag: string) {
  const h = (name: string, i = 0) => hashAt(ctx, q, `${tag}.${name}`, i)
  return {
    h,
    /** lo ~ hi 之间的一个数 */
    num: (name: string, lo: number, hi: number, i = 0) => lo + h(name, i) * (hi - lo),
    /** lo ~ hi 之间的整数（含两端） */
    int: (name: string, lo: number, hi: number, i = 0) => lo + Math.min(hi - lo, Math.floor(h(name, i) * (hi - lo + 1))),
    /** 按权重（缺省等概率）从几个选项里挑一个 */
    pick: <T>(name: string, xs: readonly T[], w?: readonly number[], i = 0): T => {
      const ws = w ?? xs.map(() => 1)
      let r = h(name, i) * ws.reduce((s, x) => s + x, 0)
      for (let k = 0; k < xs.length; k++) if ((r -= ws[k]) < 0) return xs[k]
      return xs[xs.length - 1]
    },
    /** 概率 p 为真 */
    chance: (name: string, p: number, i = 0) => h(name, i) < p,
    /** ±1 */
    side: (name: string, i = 0) => (h(name, i) < 0.5 ? -1 : 1),
  }
}
export type Dice = ReturnType<typeof dice>

/**
 * 城里只此一处的建筑（都城的宫殿）用的骰子：只看种子。城市长大时宫城会挪动、伸缩，
 * 按宫城的位置抽签会整座重抽；只看种子则同一个种子总是同一套形制，只是随地盘伸缩。
 */
export const cityDice = (ctx: Ctx, tag: string) => dice(ctx, [ctx.MW / 2, ctx.MH / 2], tag)

/**
 * 城里不止一处的地标（教堂、寺观、清真寺、城堡、天守）用的骰子：按位置取，但位置先取到 40 米的粗格上，
 * 城市长大时地标挪了几米也多半还在同一格、抽到同一套形制。
 */
export function siteDice(ctx: Ctx, q: P, tag: string) {
  const g = 40
  const snap = (x: number, o: number) => o + Math.round((x - o) / g) * g
  return dice(ctx, [snap(q[0], ctx.MW / 2), snap(q[1], ctx.MH / 2)], tag)
}

/** 整数三元组 → 0 ~ 1 */
export function mix(k: number, a: number, b = 0) {
  let h = (k ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * 城区核心：主中心（第 0 个）与各副中心。每个核心有自己的方格朝向与半径，
 * 片区对齐、方格 / 环形街、城区形状、城墙变形都按离得最近的核心来量，于是各片城区各有街网。
 */
export interface Core {
  c: P
  /** 方格朝向（弧度） */
  angle: number
  /** 这片城区的半径估计（米） */
  R: number
  /** 距离的权重：副中心的"引力"稍弱（距离按倍数放大） */
  k: number
}

/** 方格坐标系：以核心为原点、u 轴沿核心的方格朝向（与原点的偏移 (dx, dy) 换算成 (u, v)，以及反过来） */
export function gridFrame(core: { c: P; angle: number }) {
  const ca = Math.cos(core.angle)
  const sa = Math.sin(core.angle)
  const c = core.c
  return {
    u: [ca, sa] as P,
    v: [-sa, ca] as P,
    toUV: (q: P): P => {
      const dx = q[0] - c[0]
      const dy = q[1] - c[1]
      return [dx * ca + dy * sa, -dx * sa + dy * ca]
    },
    fromUV: (u: number, v: number): P => [c[0] + u * ca - v * sa, c[1] + u * sa + v * ca],
  }
}

/** 主核心（核心列表还没建好时按城心与当前方格朝向） */
export const mainCore = (ctx: Ctx): Core => ctx.cores[0] ?? { c: ctx.center, angle: ctx.gridAngle, R: ctx.Rin, k: 1 }

/** 离 q 最近的核心（按权重后的距离）及该距离 */
export function nearestCore(ctx: Ctx, q: P): { core: Core; d: number } {
  let core = mainCore(ctx)
  let d = dist(q, core.c)
  for (const c of ctx.cores.slice(1)) {
    const dc = dist(q, c.c) * c.k
    if (dc < d) {
      d = dc
      core = c
    }
  }
  return { core, d }
}

/** 点在城墙之内（任一片城区的城墙）；没有城墙时按离核心的距离 */
export function inCity(ctx: Ctx, q: P) {
  if (ctx.cityWalls.length) return ctx.cityWalls.some((w) => pointInPoly(q, w.loop))
  return ctx.cores.some((c) => dist(q, c.c) < c.R) || dist(q, ctx.center) < ctx.Rin
}

/** 离最近核心的（加权）距离 */
export const centerDist = (ctx: Ctx, q: P) => nearestCore(ctx, q).d
/** 副中心距离的权重 */
export const SUB_WEIGHT = 1.15

/** 方格程度：规整度里方格（而非放射）的那部分 */
export const squareness = (p: SettlementParams) => p.regularity * (1 - p.radial)

/** 多边形的顶点与边上（每 3 米一点）离水最近的一点与它的水距；都在 margin 以外返回 null */
function wettest(ctx: Ctx, poly: Poly, margin: number): { q: P; w: number } | null {
  let best: { q: P; w: number } | null = null
  if (!poly.length) return null
  for (const q of [...poly, ...resample([...poly, poly[0]], 3)]) {
    const w = ctx.T.waterAt(q)
    if (w < (best?.w ?? margin)) best = { q, w }
  }
  return best
}

/**
 * 把多边形裁到离水 margin 米以外：沿边每 3 米查一遍，最压水的一点朝形心的方向切掉一刀（河从一角斜穿过去、
 * 贴着弯曲的岸都能一刀刀收到岸上），最多 rounds 刀。形心落水、切没了返回 null；切满 rounds 刀还压水的返回切到的样子
 */
export function clipWater(ctx: Ctx, poly: Poly, margin: number, rounds = 3): Poly | null {
  let out = poly
  for (let pass = 0; pass < rounds; pass++) {
    const worst = wettest(ctx, out, margin)
    if (!worst) return out
    const c = centroid(out)
    if (ctx.T.waterAt(c) < margin) return null
    // 河心附近水距的梯度不可靠：朝形心的方向退回岸上（水距大致一米一米地涨，退够差的米数再多一米）
    const L = dist(c, worst.q) || 1
    const g: P = [(c[0] - worst.q[0]) / L, (c[1] - worst.q[1]) / L]
    const k = margin + 1 - worst.w
    out = clipHalf(out, [worst.q[0] + g[0] * k, worst.q[1] + g[1] * k], [-g[0], -g[1]])
    if (out.length < 3) return null
  }
  return out
}

/**
 * 成片的地面（院墙、广场、园地、菜园、墓地）落到岸上：离水不到 1 米的地方切掉（见 clipWater），
 * 切完还压水（离水不到 0.5 米）、或只剩一小块（20 m² 以下）的不要。不压水的原样返回
 */
export function dryArea(ctx: Ctx, poly: Poly): Poly | null {
  if (poly.length < 3) return null
  if (!wettest(ctx, poly, 1)) return poly
  const q = clipWater(ctx, poly, 1, 12)
  return q && q.length >= 3 && area(q) > 20 && !wettest(ctx, q, 0.5) ? q : null
}

type GreenKind = Settlement['greens'][number]['kind']
/** 登记一片成片的地面：先落到岸上（dryArea），落不下就不登记。返回登记的多边形 */
export function emitArea(ctx: Ctx, list: 'enclosures' | 'plazas', poly: Poly): Poly | null
export function emitArea(ctx: Ctx, list: 'greens', poly: Poly, kind: GreenKind): Poly | null
export function emitArea(ctx: Ctx, list: 'enclosures' | 'plazas' | 'greens', poly: Poly, kind?: GreenKind): Poly | null {
  const q = dryArea(ctx, poly)
  if (!q) return null
  if (list === 'greens') ctx.out.greens.push({ poly: q, kind: kind! })
  else ctx.out[list].push(q)
  return q
}

/**
 * 实体能否原样落地：不压水（离水 water 米以上）、不碰走廊（留 pad 米）、不压已登记的实体。
 * 与 placeable 不同，这里不做裁剪：特殊建筑不能被切掉一角，放不下就换个位置或缩小。
 */
export function isFree(ctx: Ctx, poly: Poly, o: { pad?: number; water?: number; tags?: CorridorTag[]; gap?: number } = {}) {
  if (poly.length < 3) return false
  const water = o.water ?? 1.5
  const c = centroid(poly)
  if (ctx.T.waterAt(c) < water) return false
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if (ctx.T.waterAt(a) < water || ctx.T.waterAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) < water) return false
  }
  if (ctx.corridors.hitsPoly(poly, o.pad ?? 0, o.tags)) return false
  return !ctx.occ.overlaps(poly, o.gap ?? 0)
}

/** 按走廊（道路、河、城墙）的边线裁掉越界的部分，再往里收 margin 米：斜切过片区一角的路不让整块作废 */
export function clearOf(ctx: Ctx, poly: Poly, tags: CorridorTag[], margin = 1.5): Poly | null {
  let out: Poly | null = poly
  // 弯路一次裁不干净：裁到不再碰为止
  for (let pass = 0; pass < 3 && out; pass++) {
    const q = ctx.corridors.clip(out, tags)
    out = q && q.length >= 3 ? insetConvex(q, margin) : null
    if (out && out.length < 3) out = null
    if (out && !ctx.corridors.hitsPoly(out, 1, tags)) return out
  }
  return null
}

/** 地块统一的落地检查：离水、离路、坡度 */
export function placeable(ctx: Ctx, poly: Poly, waterMargin = 2.5, maxSlope = 0.32): Poly | null {
  let q: Poly | null = clipWater(ctx, poly, waterMargin)
  if (!q) return null
  q = ctx.corridors.clip(q)
  if (!q) return null
  if (ctx.T.slopeAt(centroid(q)) > maxSlope) return null
  return q
}

/**
 * 每个片区填房子用自己的随机数流（按种子与片区的位置）：
 * 某个片区换了类型（开关要素），别的片区的房子不会跟着重排。
 */
export function wardRng(ctx: Ctx, site: P) {
  return rngAt(ctx, site, 'ward.rng')
}

/** 只看种子的随机数流（选城心、布副中心、奇观）：tag 区分用途 */
export function seedRng(ctx: Ctx, tag: string) {
  return new RNG(ctx.seedHash ^ keyOf(tag))
}

/** 片区在城里的位置（取名用）：相对城心的方位（屏幕上 y 向下是南）、是否在老城 / 外围、是否临河 */
export function whereOf(ctx: Ctx, poly: Poly): DistrictWhere {
  const c = centroid(poly)
  const dx = c[0] - ctx.center[0]
  const dy = c[1] - ctx.center[1]
  const r = Math.hypot(dx, dy) / Math.max(1, ctx.Rin)
  const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : dy > 0 ? 'S' : 'N'
  return { dir, central: r < 0.35, outer: r > 0.8, river: !!ctx.T.river && ctx.T.waterAt(c) < ctx.cfg.patch }
}

/** 立一个有名字的地标：名字按 named 的种类取（默认同地标种类，如园里的祠按"园"取名） */
export function mark(ctx: Ctx, p: P, kind: Landmark['kind'], named = kind as LandmarkNameKind) {
  ctx.out.landmarks.push({ p, name: ctx.namer.landmark(named, ctx.p.magic), kind })
}

/** 这次生成里按 key 只算一次的状态（见 Ctx.memo） */
export function memo<T>(ctx: Ctx, key: string, make: () => T): T {
  if (!ctx.memo.has(key)) ctx.memo.set(key, make())
  return ctx.memo.get(key) as T
}

/** 当前布局的"北"方向（东式城市按网格朝向） */
export function northOf(ctx: Ctx): { n: P; e: P } {
  const a = ctx.gridAngle
  return { n: [Math.sin(a), -Math.cos(a)], e: [Math.cos(a), Math.sin(a)] }
}
