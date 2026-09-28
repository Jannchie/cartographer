import { emitArea, placeable, mark, memo, type Ctx } from '../ctx'
import { area, centroid, circlePoly, pointInPoly, rect, signedArea, type P, type Poly } from '../geom'
import type { Ward, WardType } from '../types'
import { addBuilding, addGroup, scatterTrees } from '../wards'
import { buildable, rectOutline as box, RESIDENTIAL, uvLine } from './common'
import type { CityPlan, PlanRoad, PlanZone } from './types'

/**
 * 方格新城（bastide，13~14 世纪法国西南部的设防新镇，如 Monpazier，缩到地图的尺度）：
 * - 方格路网，街坊是长条形；坊里是面宽窄、进深长的临街宅地（burgage），前面临街盖房、后面是院子，
 *   宅地之间留出一线防火缝（andrones）；
 * - 城心就是市场广场：四面是邻坊的拱廊，中央一座有顶的市场棚，四条大街从广场的四个角进来；
 * - 教堂在紧挨广场的一个斜对角街坊，正面朝着广场角上的大街；
 * - 街道两级：大街（rue）临街开门，大街之间是背街的小巷（carreyrou），宅地从大街一直通到小巷；
 * - 城墙顺着方格外缘，拐角切掉，地形不许的地方方格缺一块，墙也跟着内收；城门在大街尽头。
 * 规划区之外照旧有机生长：方格外面补一圈方格站点，外缘的街坊都是整齐的矩形，外面一圈按通用填法盖成城关。
 */

/** 广场（城心那一格）与街坊的尺寸（米）：u 向是街坊的长边 */
const PU = 76
const PV = 64
const BU = 84
const BV = 44
/** 城的长宽比（u : v） */
const ASPECT = 1.3
/** 大街、横街、小巷的宽 */
const RUE_W = 6
const CROSS_W = 5
const LANE_W = 3
/** 广场四面拱廊的进深、广场角上让出的街口 */
const ARCADE = 5
const CORNER = 6.5
/** 拱廊的柱宽、柱间拱口凹进的深度 */
const PIER = 1.1
const NOTCH = 1.6
/** 城墙离方格外缘 */
const WALL_GAP = 8

/** 第 k 格的范围（k = 0 是城心那一格，宽 2·half；其余每格宽 B） */
function span(k: number, half: number, B: number): [number, number] {
  if (k === 0) return [-half, half]
  const a = half + (Math.abs(k) - 1) * B
  return k > 0 ? [a, a + B] : [-a - B, -a]
}
/** 从城心往外数第 n 条格线（n = 0 是城心那一格的边） */
const line = (n: number, half: number, B: number) => half + n * B
/**
 * 第 k 格的站点：相邻站点的中线正好是格线（城心那一格的站点就是城心）。
 * s₀ = 0，s_k = 2·b_k − s_{k−1}，于是奇数格离内侧格线 half、偶数格离内侧格线 B − half。
 */
function siteAt(k: number, half: number, B: number) {
  if (k === 0) return 0
  const n = Math.abs(k)
  return Math.sign(k) * (n % 2 ? 2 * half + (n - 1) * B : n * B)
}
/** 局部坐标所在的格 */
function cellAt(x: number, half: number, B: number) {
  if (Math.abs(x) <= half) return 0
  return Math.sign(x) * (1 + Math.floor((Math.abs(x) - half) / B))
}

/** 方格：各列（u 向第 i 格）往北（−v）、往南（+v）各有几排街坊 */
interface Grid {
  lo: number
  hi: number
  up: Map<number, number>
  dn: Map<number, number>
  /** 规划区轮廓（局部坐标） */
  outline: P[]
}

const grid = (ctx: Ctx, z: Pick<PlanZone, 'R' | 'fromUV' | 'shift'>) => memo(ctx, 'bastide', () => makeGrid(ctx, z))

function makeGrid(ctx: Ctx, z: Pick<PlanZone, 'R' | 'fromUV' | 'shift'>): Grid {
  const Vh = z.R * Math.sqrt(Math.PI / (4 * ASPECT))
  const Uh = Vh * ASPECT
  // 范围的半宽（取整到格线）；范围以 shift 为中心（临海时往岸上挪），格点仍以城心为原点
  const U1 = line(Math.max(1, Math.round((Uh - PU / 2) / BU)), PU / 2, BU)
  // 每侧的排数取奇数：最外一排朝里临大街、背靠城墙
  const V1 = line(Math.max(1, 2 * Math.round(((Vh - PV / 2) / BV - 1) / 2) + 1), PV / 2, BV)
  // 偏移不超过范围本身（城心那一格外面至少还留一圈街坊）
  const su = Math.max(-(U1 - BU), Math.min(U1 - BU, z.shift[0]))
  const sv = Math.max(-(V1 - BV), Math.min(V1 - BV, z.shift[1]))
  const cols = (x: number) => Math.max(0, Math.round((x - PU / 2) / BU))
  const odd = (x: number) => {
    const n = (x - PV / 2) / BV
    return n < 0.5 ? 0 : 2 * Math.round((n - 1) / 2) + 1
  }
  const nuW = cols(U1 - su)
  const nuE = cols(U1 + su)
  const nvN = odd(V1 - sv)
  const nvS = odd(V1 + sv)
  // 一格的情形：2 能建；1 河、湖占了（方格跨河而过，格里不盖房）；0 海、陡坡或超出范围。四角按超椭圆略收
  const state = (i: number, j: number) => {
    if (i === 0 && j === 0) return 2
    const [u0, u1] = span(i, PU / 2, BU)
    const [v0, v1] = span(j, PV / 2, BV)
    const uc = (u0 + u1) / 2
    const vc = (v0 + v1) / 2
    if ((Math.abs(uc - su) / U1) ** 4 + (Math.abs(vc - sv) / V1) ** 4 > 1) return 0
    const pts = [
      z.fromUV(uc, vc),
      z.fromUV(u0 * 0.7 + u1 * 0.3, v0 * 0.7 + v1 * 0.3),
      z.fromUV(u0 * 0.3 + u1 * 0.7, v0 * 0.7 + v1 * 0.3),
      z.fromUV(u0 * 0.7 + u1 * 0.3, v0 * 0.3 + v1 * 0.7),
      z.fromUV(u0 * 0.3 + u1 * 0.7, v0 * 0.3 + v1 * 0.7),
    ]
    if (pts.filter((q) => buildable(ctx, q)).length >= 4) return 2
    if (pts.some((q) => ctx.T.seaAt(q))) return 0
    return pts.some((q) => ctx.T.waterAt(q) < 0) ? 1 : 0
  }
  const up = new Map<number, number>()
  const dn = new Map<number, number>()
  // 列从城心往两边连续取（岸上一侧取得更远），每列往南北连续取排：跨过河接着取，碰到海、陡坡就停；
  // 最外一排、最外一列要能建（不以河为边），排数取奇数
  const rows = (i: number, s: number) => {
    const max = s < 0 ? nvN : nvS
    let last = 0
    for (let n = 1; n <= max; n++) {
      const t = state(i, s * n)
      if (!t) break
      if (t === 2) last = n
    }
    return last % 2 ? last : Math.max(0, last - 1)
  }
  let lo = 0
  let hi = 0
  for (const s of [-1, 1]) {
    // 每列最多比里面一列多一排街坊：隔着河、沟的外侧不会伸出一条条细长的"手指"
    const cap = (prev: number | undefined) => (prev === undefined ? Infinity : prev ? prev + 2 : 1)
    for (let k = 0; k <= (s < 0 ? nuW : nuE); k++) {
      const i = s * k
      const t = state(i, 0)
      if (!t) break
      up.set(i, Math.min(rows(i, -1), cap(k ? up.get(i - s) : undefined)))
      dn.set(i, Math.min(rows(i, 1), cap(k ? dn.get(i - s) : undefined)))
      if (t === 2 || up.get(i)! + dn.get(i)! > 0) {
        if (s < 0) lo = i
        else hi = i
      }
    }
  }
  // 轮廓：沿各列的北沿从西到东，再沿南沿从东到西
  const outline: P[] = []
  for (let i = lo; i <= hi; i++) {
    const [u0, u1] = span(i, PU / 2, BU)
    const v = -line(up.get(i)!, PV / 2, BV)
    outline.push([u0, v], [u1, v])
  }
  for (let i = hi; i >= lo; i--) {
    const [u0, u1] = span(i, PU / 2, BU)
    const v = line(dn.get(i)!, PV / 2, BV)
    outline.push([u1, v], [u0, v])
  }
  return { lo, hi, up, dn, outline: pruneCollinear(outline) }
}

/** 去掉重复点与严格共线的点（方格轮廓的直边上只留拐角） */
function pruneCollinear(loop: P[]): P[] {
  let pts = loop.filter((q, k) => {
    const r = loop[(k + 1) % loop.length]
    return Math.abs(q[0] - r[0]) > 1e-6 || Math.abs(q[1] - r[1]) > 1e-6
  })
  pts = pts.filter((q, k) => {
    const a = pts[(k - 1 + pts.length) % pts.length]
    const b = pts[(k + 1) % pts.length]
    return Math.abs((q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0])) > 1e-6
  })
  return pts
}

/** 某格是否在方格里 */
function kept(g: Grid, i: number, j: number) {
  if (i < g.lo || i > g.hi) return false
  return j < 0 ? -j <= g.up.get(i)! : j <= g.dn.get(i)!
}

/** 局部坐标所在的格号 */
const cellOf = (z: PlanZone, q: P): [number, number] => {
  const [u, v] = z.toUV(q)
  return [cellAt(u, PU / 2, BU), cellAt(v, PV / 2, BV)]
}

/** 片区是哪一格：格点就是 Voronoi 站点，一定落在自己的片区里（跨河时邻格会并进落水格的地方，形心不可靠） */
function cellOfWard(z: PlanZone, poly: Poly): [number, number] {
  const [i0, j0] = cellOf(z, centroid(poly))
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++) {
      const q = z.fromUV(siteAt(i0 + a, PU / 2, BU), siteAt(j0 + b, PV / 2, BV))
      if (pointInPoly(q, poly)) return [i0 + a, j0 + b]
    }
  return [i0, j0]
}

/** 大街宽 */
const mainW = (ctx: Ctx) => ctx.cfg.main

/** 格线的种类：u 向的线（横着分隔各排）第 0 条是大街，此后奇数条是小巷、偶数条是大街（rue） */
type Edge = 'main' | 'rue' | 'lane' | 'cross' | 'plaza' | 'edge'
const rowLine = (n: number): Edge => (n === 0 ? 'main' : n % 2 ? 'lane' : 'rue')

/** 格 (i, j) 某一面的邻格是什么（side：0 西 −u、1 东 +u、2 北 −v、3 南 +v） */
function edgeOf(g: Grid, i: number, j: number, side: number): Edge {
  const [di, dj] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ][side]
  const ni = i + di
  const nj = j + dj
  if (!kept(g, ni, nj)) return 'edge'
  if (ni === 0 && nj === 0) return 'plaza'
  if (di) {
    // 横街：两格之间第几条线（0 是广场角上的大街）
    const n = Math.min(Math.abs(i), Math.abs(ni))
    return n === 0 ? 'main' : 'cross'
  }
  return rowLine(Math.min(Math.abs(j), Math.abs(nj)))
}

/** 街面半宽 + 让出的余量（与道路走廊一致） */
function margin(ctx: Ctx, e: Edge) {
  switch (e) {
    case 'main':
      return mainW(ctx) / 2 + 1.6
    case 'rue':
      return RUE_W / 2 + 1.5
    case 'cross':
      return CROSS_W / 2 + 1.5
    case 'lane':
      return LANE_W / 2 + 1.4
    case 'plaza':
      return 0.3
    default:
      return 1.5
  }
}

export const bastide: CityPlan = {
  id: 'bastide',
  outline(ctx, z) {
    return grid(ctx, z).outline.map(([u, v]) => z.fromUV(u, v))
  },
  sites(ctx, z) {
    const g = grid(ctx, z)
    const out: P[] = []
    const seen = new Set<string>()
    const add = (i: number, j: number) => {
      const k = `${i},${j}`
      if (seen.has(k)) return
      seen.add(k)
      out.push(z.fromUV(siteAt(i, PU / 2, BU), siteAt(j, PV / 2, BV)))
    }
    for (let i = g.lo; i <= g.hi; i++) for (let j = -g.up.get(i)!; j <= g.dn.get(i)!; j++) add(i, j)
    // 方格外再补一圈方格站点：外缘街坊的外沿正好是格线，外面这一圈由通用填法盖成城关
    for (let i = g.lo - 1; i <= g.hi + 1; i++)
      for (let j = -Math.max(...g.up.values()) - 1; j <= Math.max(...g.dn.values()) + 1; j++) {
        if (kept(g, i, j)) continue
        let near = false
        for (let a = -1; a <= 1 && !near; a++) for (let b = -1; b <= 1 && !near; b++) near = kept(g, i + a, j + b)
        if (near) add(i, j)
      }
    return out
  },
  streets(ctx, z) {
    const g = grid(ctx, z)
    const out: PlanRoad[] = []
    const road = (pts: [number, number][], e: Edge, named = e === 'main') => {
      const width = e === 'main' ? mainW(ctx) : e === 'rue' ? RUE_W : e === 'lane' ? LANE_W : CROSS_W
      const kind = e === 'main' ? 'main' : e === 'lane' ? 'lane' : 'street'
      out.push({ line: uvLine(z, pts), width, kind, named })
    }
    // 沿 u 的线：两侧各排之间；第 0 条（广场南北沿）让开广场，从广场角上起
    for (const s of [-1, 1]) {
      const rowsOf = (i: number) => (s < 0 ? g.up.get(i)! : g.dn.get(i)!)
      for (let n = 0; ; n++) {
        let any = false
        let run: number[] = []
        const flush = () => {
          if (run.length) road([[span(run[0], PU / 2, BU)[0], s * line(n, PV / 2, BV)], [span(run[run.length - 1], PU / 2, BU)[1], s * line(n, PV / 2, BV)]], rowLine(n), n === 0 || n % 4 === 2)
          run = []
        }
        for (let i = g.lo; i <= g.hi; i++) {
          if (rowsOf(i) > n) any = true
          if (rowsOf(i) > n && !(n === 0 && i === 0)) run.push(i)
          else flush()
        }
        flush()
        if (!any) break
      }
    }
    // 沿 v 的线（横街）：相邻两列之间，两列都有的那几排；第 0 条（广场东西沿）让开广场
    for (const s of [-1, 1])
      for (let k = 0; ; k++) {
        const a = s * k
        const b = s * (k + 1)
        if (b < g.lo || b > g.hi) break
        const u = s * line(k, PU / 2, BU)
        const up = Math.min(g.up.get(a)!, g.up.get(b)!)
        const dn = Math.min(g.dn.get(a)!, g.dn.get(b)!)
        const e: Edge = k === 0 ? 'main' : 'cross'
        if (k === 0) {
          if (up > 0) road([[u, -PV / 2], [u, -line(up, PV / 2, BV)]], e)
          if (dn > 0) road([[u, PV / 2], [u, line(dn, PV / 2, BV)]], e)
        } else road([[u, -line(up, PV / 2, BV)], [u, line(dn, PV / 2, BV)]], e)
      }
    return out
  },
  exit(_ctx, z, dir) {
    // 从广场的角上起，沿最接近原方向的那条大街出城
    const [du, dv] = z.toUV([z.c[0] + Math.cos(dir), z.c[1] + Math.sin(dir)])
    const su = Math.sign(du) || 1
    const sv = Math.sign(dv) || 1
    const alongU = Math.abs(du) >= Math.abs(dv)
    const pts: P[] = []
    for (let t = 0; t < z.R * 4; t += 4) {
      const q = alongU ? z.fromUV(su * (PU / 2 + t), sv * (PV / 2)) : z.fromUV(su * (PU / 2), sv * (PV / 2 + t))
      pts.push(q)
      if (t > 0 && !z.contains(q)) break
    }
    return pts
  },
  assign(ctx, z, lots) {
    const at = (i: number, j: number) => lots.find((l) => {
      const [a, b] = cellOf(z, l.site)
      return a === i && b === j && z.contains(l.site)
    })
    const c = lots.find((l) => Math.hypot(l.uv[0], l.uv[1]) < 1)
    if (c && c.type !== 'market' && c.type !== 'magic') c.type = 'plaza'
    // 教堂：广场斜对角的一个街坊，后殿朝东（街坊的长边沿 u）
    const east = z.toUV([z.c[0] + 1, z.c[1]])
    const si = east[0] >= 0 ? 1 : -1
    const sj = ctx.seedHash & 1 ? 1 : -1
    if (ctx.counts.temple > 0) {
      const t = [at(si, sj), at(si, -sj), at(-si, sj), at(-si, -sj)].find((l) => l && !l.type)
      if (t) t.type = 'temple'
    }
    // 广场四面的街坊：拱廊下是铺面
    for (const [i, j] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const l = at(i, j)
      if (l && !l.type) l.type = 'merchant'
    }
  },
  build(ctx, ward, _block, z) {
    const g = grid(ctx, z)
    const [i, j] = cellOfWard(z, ward.poly)
    if (!kept(g, i, j)) return false
    if (i === 0 && j === 0) {
      if (ward.type !== 'plaza' && ward.type !== 'market') return false
      square(ctx, z, ward.type === 'market')
      return true
    }
    if (ward.type === 'temple') {
      church(ctx, g, z, i, j)
      return true
    }
    if (!RESIDENTIAL.has(ward.type)) return false
    burgages(ctx, g, z, ward, i, j)
    return true
  },
  wall(ctx, z) {
    // 规划强度低：方格只是老城，城墙随生长修
    if (ctx.p.planStrength! < 0.4) return null
    const g = grid(ctx, z)
    return wallLoop(ctx, g.outline).map(([u, v]) => z.fromUV(u, v))
  },
}


/** 城墙：方格外缘外推，凸角切掉；长墙中段随位置略向外鼓（不是尺子画的） */
function wallLoop(ctx: Ctx, outline: P[]): P[] {
  const n = outline.length
  const s = Math.sign(signedArea(outline)) || 1
  // 各边的外法向（局部坐标）
  const nrm = outline.map((a, k) => {
    const b = outline[(k + 1) % n]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const d: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    return (s > 0 ? [d[1], -d[0]] : [-d[1], d[0]]) as P
  })
  const off = outline.map((q, k) => {
    const n0 = nrm[(k - 1 + n) % n]
    const n1 = nrm[k]
    return [q[0] + (n0[0] + n1[0]) * WALL_GAP, q[1] + (n0[1] + n1[1]) * WALL_GAP] as P
  })
  const out: P[] = []
  for (let k = 0; k < n; k++) {
    const a = off[(k - 1 + n) % n]
    const q = off[k]
    const b = off[(k + 1) % n]
    const cross = (q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0])
    const convex = cross * s > 0
    const la = Math.hypot(q[0] - a[0], q[1] - a[1])
    const lb = Math.hypot(b[0] - q[0], b[1] - q[1])
    const c = Math.min(14, la * 0.3, lb * 0.3)
    if (convex && c > 3) {
      out.push([q[0] + ((a[0] - q[0]) / la) * c, q[1] + ((a[1] - q[1]) / la) * c])
      out.push([q[0] + ((b[0] - q[0]) / lb) * c, q[1] + ((b[1] - q[1]) / lb) * c])
    } else out.push(q)
    // 长墙中段略向外鼓
    if (lb > 150) {
      const m: P = [(q[0] + b[0]) / 2, (q[1] + b[1]) / 2]
      const bulge = 3 + ((ctx.seedHash >>> (k % 24)) & 7)
      out.push([m[0] + nrm[k][0] * bulge, m[1] + nrm[k][1] * bulge])
    }
  }
  return out
}


/** 盖一栋：压了路、水就按走廊裁掉一角再试（裁剩太少就不盖） */
function place(ctx: Ctx, poly: Poly, kind: Parameters<typeof addBuilding>[2], floorCap?: number) {
  if (addBuilding(ctx, poly, kind, 0, floorCap)) return true
  const q = placeable(ctx, poly, 2)
  if (!q || q.length > 8 || area(q) < Math.max(14, area(poly) * 0.6)) return false
  return addBuilding(ctx, q, kind, 0, floorCap)
}

/**
 * 市场广场（城心那一格）：铺装，四面拱廊（cornières，角上让出街口），中央有顶的市场棚，棚边一口井，零星摊位。
 */
function square(ctx: Ctx, z: PlanZone, trade: boolean) {
  const h = PU / 2
  const k = PV / 2
  emitArea(ctx, 'plazas', box(z, -h, h, -k, k))
  // 拱廊：沿四边一道连续的廊（上面是临广场的楼房出挑），朝广场一面是一排石柱、柱间是拱口。
  // 画成一条带柱齿的廊带：柱子伸到廊沿，柱间凹进去一截（拱口），城镇尺度看是一圈围着广场的深色廊带，放大能数出开间
  // 角上让出的街口随大街宽（城市的大街更宽）
  const cn = Math.max(CORNER, mainW(ctx) / 2 + 2.5)
  arcadeSide(ctx, z, -h + cn, h - cn, true, -k, 1)
  arcadeSide(ctx, z, -h + cn, h - cn, true, k, -1)
  arcadeSide(ctx, z, -k + cn, k - cn, false, -h, 1)
  arcadeSide(ctx, z, -k + cn, k - cn, false, h, -1)
  // 市场棚（halle）：木柱撑起的大屋顶，长边顺着广场；放不下就缩一点再试
  let hu = 0
  let hv = 0
  for (const f of trade ? [0.5, 0.44, 0.38] : [0.44, 0.38, 0.32]) {
    const a = f * PU
    const b = f * 0.95 * PV
    if (addBuilding(ctx, box(z, -a / 2, a / 2, -b / 2, b / 2), 'hall', 0)) {
      hu = a
      hv = b
      // 棚下的柱网：两排木柱（小方块），与拱廊呼应
      const n = Math.max(2, Math.round(a / 5))
      for (let m = 1; m < n; m++) {
        const u = -a / 2 + (m * a) / n
        for (const v of [-b / 6, b / 6]) ctx.out.buildings.push({ poly: box(z, u - 0.5, u + 0.5, v - 0.5, v + 0.5), kind: 'civic', tone: 0.5, ridge: z.angle })
      }
      mark(ctx, z.fromUV(0, 0), 'market', 'halle')
      break
    }
  }
  // 井：棚的一角外，广场空处；位置不行就换个角
  for (const [su, sv] of [
    [1, -1],
    [-1, 1],
    [1, 1],
    [-1, -1],
  ]) {
    const well = z.fromUV(su * (Math.max(hu, 8) / 2 + 4), sv * (Math.max(hv, 8) / 2 - 2))
    if (ctx.occ.hitsPoint(well, 2)) continue
    ctx.out.landmarks.push({ p: well, kind: 'well' })
    ctx.occ.add(circlePoly(well, 1.6, 10))
    break
  }
  // 摊位：棚外的空场上，靠着棚的两端
  const stalls = (ctx.p.size === 'city' ? 10 : 6) * (trade ? 2 : 1)
  const rng = ctx.rng
  const axis: P = [Math.cos(z.angle), Math.sin(z.angle)]
  const room = h - ARCADE - hu / 2 - 7
  if (room > 0)
    for (let m = 0, t = 0; m < stalls && t < stalls * 6; t++) {
      const side = rng.next() < 0.5 ? -1 : 1
      const u = side * (hu / 2 + 3.5 + rng.next() * room)
      const v = (rng.next() - 0.5) * (2 * k - 2 * ARCADE - 8)
      const s = rect(z.fromUV(u, v), axis, 2.4 + rng.next(), 3 + rng.next() * 1.5)
      if (addBuilding(ctx, s, 'shed', 1.2)) m++
    }
}

/**
 * 广场一面的拱廊：沿 [a0, a1]，外沿在格线 o 上，往广场里（s 向）进深 ARCADE。
 * 整面一条放不下（有路、水擦过）就按开间一段段放。
 */
function arcadeSide(ctx: Ctx, z: PlanZone, a0: number, a1: number, alongU: boolean, o: number, s: number) {
  const at = (t: number, d: number): P => (alongU ? z.fromUV(t, o + s * d) : z.fromUV(o + s * d, t))
  const n = Math.max(2, Math.round((a1 - a0) / 3.6))
  const w = (a1 - a0) / n
  // 一段 [m0, m1] 开间：背面平直，正面是柱齿（柱宽 PIER、柱间凹进 NOTCH）
  const piece = (m0: number, m1: number): Poly => {
    const out: P[] = [at(a0 + m0 * w, 0), at(a0 + m1 * w, 0)]
    for (let m = m1; m >= m0; m--) {
      const c = a0 + m * w
      const l = m === m0 ? c : c - PIER / 2
      const r = m === m1 ? c : c + PIER / 2
      out.push(at(r, ARCADE), at(l, ARCADE))
      if (m > m0) out.push(at(l, ARCADE - NOTCH), at(c - w + PIER / 2, ARCADE - NOTCH))
    }
    return out
  }
  // 两头碰到街口的路面就各让掉一两个开间，仍是一整条
  for (let t = 0; t <= 2 && n - 2 * t >= 2; t++) if (addBuilding(ctx, piece(t, n - t), 'civic', 0)) return
  // 还不行（中段有路、水擦过）：按开间两两一段，放得下的都放
  for (let m = 0; m < n; m += 2) addBuilding(ctx, piece(m, Math.min(n, m + 2)), 'civic', 0)
}

/** 教堂：面朝广场角上大街的西立面钟楼、中殿、半圆后殿；背后是墓园，街坊其余照常切宅地 */
function church(ctx: Ctx, g: Grid, z: PlanZone, i: number, j: number) {
  const [u0, u1] = span(i, PU / 2, BU)
  const [v0, v1] = span(j, PV / 2, BV)
  const si = Math.sign(i) || 1
  // 临街一面：靠城心的一面临大街就朝里，否则朝外
  const inner = edgeOf(g, i, j, j > 0 ? 2 : 3)
  const sj = (Math.sign(j) || 1) * (inner === 'main' || inner === 'rue' || inner === 'plaza' ? 1 : -1)
  // 近端（靠广场的一头）
  const mNear = margin(ctx, edgeOf(g, i, j, si > 0 ? 0 : 1))
  const mFar = margin(ctx, edgeOf(g, i, j, si > 0 ? 1 : 0))
  const near = si > 0 ? u0 + mNear : u1 - mNear
  const far = si > 0 ? u1 - mFar : u0 + mFar
  const front = sj > 0 ? v0 + margin(ctx, edgeOf(g, i, j, 2)) : v1 - margin(ctx, edgeOf(g, i, j, 3))
  const back = sj > 0 ? v1 - margin(ctx, edgeOf(g, i, j, 3)) : v0 + margin(ctx, edgeOf(g, i, j, 2))
  const big = ctx.p.size === 'city'
  const W = big ? 15 : 12
  const T = W * 0.62
  const L = Math.min(Math.abs(far - near) * 0.55, big ? 44 : 34)
  const parvis = 8
  const U = (d: number) => near + si * d
  const V = (d: number) => front + sj * d
  const vc = V(2 + W / 2)
  const nave = box(z, U(parvis + T * 0.7), U(parvis + T * 0.7 + L), V(2), V(2 + W))
  const tower = box(z, U(parvis), U(parvis + T), vc - T / 2, vc + T / 2)
  const ac = z.fromUV(U(parvis + T * 0.7 + L), vc)
  const dir: P = [z.fromUV(si, 0)[0] - z.c[0], z.fromUV(si, 0)[1] - z.c[1]]
  const apse = circlePoly(ac, W * 0.42, 14).filter((q) => (q[0] - ac[0]) * dir[0] + (q[1] - ac[1]) * dir[1] >= -0.01)
  let end = 0
  if (addGroup(ctx, [
    [nave, 'temple'],
    [tower, 'temple'],
    [apse, 'temple'],
  ], 0.5)) {
    mark(ctx, z.fromUV(U(parvis + T * 0.7 + L / 2), vc), 'temple')
    emitArea(ctx, 'plazas', box(z, U(0), U(parvis), V(0), V(2 + W + 2)))
    end = parvis + T * 0.7 + L + W * 0.42 + 3
    // 墓园：教堂背后
    const gy = box(z, U(parvis + T * 0.7), U(end), V(2 + W + 3), back)
    if (Math.abs(back - V(2 + W + 3)) > 8) graves(ctx, z, gy, U(parvis + T * 0.7), U(end), V(2 + W + 3), back)
  }
  // 教堂以外的一段照常是宅地
  strips(ctx, z, 'common', U(end), far, front, back)
}

function graves(ctx: Ctx, z: PlanZone, zone: Poly, a0: number, a1: number, b0: number, b1: number) {
  emitArea(ctx, 'greens', zone, 'cemetery')
  emitArea(ctx, 'enclosures', zone)
  const [ua, ub] = [Math.min(a0, a1) + 2.5, Math.max(a0, a1) - 2.5]
  const [va, vb] = [Math.min(b0, b1) + 2.5, Math.max(b0, b1) - 2.5]
  for (let u = ua; u < ub; u += 3.4)
    for (let v = va; v < vb; v += 4.4) {
      if (ctx.rng.next() < 0.3) continue
      addBuilding(ctx, box(z, u - 0.45, u + 0.45, v - 0.9, v + 0.9), 'shed')
    }
  scatterTrees(ctx, zone, 0.003, 2.5, 4)
}

/**
 * 一个街坊切成临街宅地：临大街（或广场）的长边是正面，背面是小巷；两面都临大街的（广场所在的那一排）背靠背切成两半。
 * 紧挨广场一头的街坊，那一头另切一排朝广场的宅地（拱廊后面的铺面）。
 */
function burgages(ctx: Ctx, g: Grid, z: PlanZone, ward: Ward, i: number, j: number) {
  const [u0, u1] = span(i, PU / 2, BU)
  const [v0, v1] = span(j, PV / 2, BV)
  const e = [0, 1, 2, 3].map((s) => edgeOf(g, i, j, s))
  let ua = u0 + margin(ctx, e[0])
  let ub = u1 - margin(ctx, e[1])
  const va = v0 + margin(ctx, e[2])
  const vb = v1 - margin(ctx, e[3])
  const front = (x: Edge) => x === 'main' || x === 'rue' || x === 'plaza'
  // 朝广场的一头：一排进深约 18 米、朝广场开门的宅地
  const head = 18
  if (e[0] === 'plaza') {
    strips(ctx, z, ward.type, va, vb, ua, ua + head, 1)
    ua += head + 0.3
  }
  if (e[1] === 'plaza') {
    strips(ctx, z, ward.type, va, vb, ub, ub - head, 1)
    ub -= head + 0.3
  }
  // 临横街的两头也各有一排朝横街的宅地（房子绕过街角）；疏处不切
  const end = ctx.wardDensity === 'low' ? 0 : 13
  if (end && ub - ua > 50 && (e[0] === 'main' || e[0] === 'cross')) {
    strips(ctx, z, ward.type, va, vb, ua, ua + end, 1)
    ua += end + 0.3
  }
  if (end && ub - ua > 40 && (e[1] === 'main' || e[1] === 'cross')) {
    strips(ctx, z, ward.type, va, vb, ub, ub - end, 1)
    ub -= end + 0.3
  }
  if (ub - ua < 6) return
  const fn = front(e[2])
  const fs = front(e[3])
  if (fn && fs) {
    const vm = (va + vb) / 2
    strips(ctx, z, ward.type, ua, ub, va, vm - 0.3)
    strips(ctx, z, ward.type, ua, ub, vb, vm + 0.3)
  } else if (fs || (!fn && Math.abs(v1) < Math.abs(v0))) strips(ctx, z, ward.type, ua, ub, vb, va)
  else strips(ctx, z, ward.type, ua, ub, va, vb)
}

/**
 * 一排宅地：沿 [a0, a1] 等宽切开，每块从正面（f0）往里通到背面（f1）；房子临街，
 * 后面是院子，背街一头偶有后屋 / 工棚。flip = 1 时 a 沿 v、f 沿 u（朝广场一头的那排）。
 */
function strips(ctx: Ctx, z: PlanZone, type: WardType, a0: number, a1: number, f0: number, f1: number, flip = 0) {
  const rng = ctx.rng
  const lo = Math.min(a0, a1)
  const hi = Math.max(a0, a1)
  const L = hi - lo
  const D = Math.abs(f1 - f0)
  const s = Math.sign(f1 - f0) || 1
  if (L < 4 || D < 6) return
  const dens = ctx.wardDensity
  // 面宽：密处窄、疏处宽；商人铺面略宽，贫民更窄
  const w0 = (dens === 'high' ? 4.8 : dens === 'mid' ? 5.6 : 8) + (type === 'merchant' ? 1 : type === 'craft' ? 1.5 : type === 'slum' ? -1.2 : 0)
  const n = Math.max(1, Math.round(L / w0))
  const w = L / n
  const deep = (dens === 'high' ? 15 : dens === 'mid' ? 13 : 10) + (type === 'merchant' ? 2 : 0)
  const R = (a: number, b: number, c: number, d: number) => (flip ? box(z, c, d, a, b) : box(z, a, b, c, d))
  for (let m = 0; m < n; m++) {
    let b0 = lo + m * w
    let b1 = b0 + w
    // 偶有两块合成一户大宅
    if (m + 1 < n && rng.next() < (dens === 'low' ? 0.08 : 0.14)) {
      b1 += w
      m++
    }
    // 防火缝（andrones）
    const gap = 0.2 + rng.next() * 0.3
    const hd = Math.min(D - 2, deep * (0.85 + rng.next() * 0.35))
    const house = R(b0 + gap, b1 - gap, f0, f0 + s * hd)
    const big = (b1 - b0) * hd > 330
    if (!place(ctx, house, big ? 'large' : 'house', type === 'slum' ? 2 : undefined)) {
      if (D > 12 && rng.next() < 0.3) scatterTrees(ctx, R(b0 + 1, b1 - 1, f0 + s * 3, f1 - s * 1), 0.01, 2, 3.2)
      continue
    }
    // 院子深处：背街一头的后屋 / 工棚（密处多、作坊多）；其余是菜园果树
    const yard = D - hd
    const backP = type === 'craft' ? 0.7 : dens === 'high' ? 0.8 : dens === 'mid' ? 0.55 : 0.2
    if (yard > 11 && rng.next() < backP) {
      const bd = Math.min(yard - 5, 5 + rng.next() * 3)
      const inset = Math.min(0.8, (b1 - b0) * 0.1)
      const kind = type === 'craft' || rng.next() < 0.25 ? 'shed' : 'house'
      place(ctx, R(b0 + gap + inset, b1 - gap - inset, f1 - s * bd, f1), kind, 2)
    } else if (yard > 8 && rng.next() < (dens === 'low' ? 0.5 : 0.2)) scatterTrees(ctx, R(b0 + 1, b1 - 1, f0 + s * (hd + 2), f1 - s * 1), 0.012, 1.8, 3)
  }
}
