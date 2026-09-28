import { addRoad } from '../roads'
import { hashAt, placeable, type Ctx } from '../ctx'
import { area, centroid, dist, insetConvex, pointInPoly, splitConvex, type P, type Poly } from '../geom'
import type { Tri } from '../../gen/naming'
import type { Culture, WardType } from '../types'
import { farm, vegetation } from '../outer'
import { urban } from '../wards'
import { drop } from '../undo'
import { axisExit, gridSites, rectOutline, RESIDENTIAL, uvLine } from './common'
import type { CityPlan, PlanRoad, PlanZone } from './types'

/**
 * 里坊制（隋唐长安、洛阳的形制，缩到地图的尺度）：
 * - 坐北朝南的矩形外郭，东西略宽；外郭按规划一次筑成，城南常有空着的坊（种田）；
 * - 棋盘式的坊：每坊一圈坊墙，坊内十字街分成四区，四面开坊门；
 * - 中轴朱雀大街从南面正门直通北端居中的宫城，宫城前是一条东西横街；
 * - 东市、西市在中轴两侧对称，是城里仅有的市；
 * - 城门落在大街的尽头：南面正门在中轴上，东西、北面的门对着坊间大街。
 */

/**
 * 各文明的里坊。平安京、平城京（条坊制）照搬唐长安的格局，但有几处不同：
 * 坊不筑坊墙，每坊由小路再分成 4 × 4 个"町"；外郭没有城墙，只在南面正门两侧有一小段罗城与罗城门；
 * 片区按"左京 / 右京 + 几条 + 几坊"编号（条从北往南数，坊从朱雀大路往外数）。
 */
interface Form {
  /** 每坊一圈坊墙 */
  fangWall: boolean
  /** 坊内每个方向分成几份（长安是十字街分四区：2；平安京是十六町：4） */
  cells: number
  /** 没有城墙时，南面正门修一段罗城与罗城门 */
  rajo: boolean
  /** 坊按条坊编号取名 */
  jobo: boolean
}
const TANG: Form = { fangWall: true, cells: 2, rajo: false, jobo: false }
const FORM: Partial<Record<Culture, Form>> = { wa: { fangWall: false, cells: 4, rajo: true, jobo: true } }
const formOf = (ctx: Ctx) => FORM[ctx.p.culture] ?? TANG

/**
 * 坊的尺寸（米）：东西 × 南北，随城的规模（规划区尺度 R）变大：小州城的坊一二百米，
 * 大城的坊三百多米（长安的坊五百到一千米，缩到地图的尺度）。
 */
const dims = (z: { R: number }) => {
  const bu = Math.min(340, Math.max(170, z.R * 0.42))
  return { BU: bu, BV: bu * 0.82 }
}
/** 朱雀大街、坊间大街、坊间小街的宽 */
const AXIS_W = 28
const AVENUE_W = 14
const STREET_W = 9

/**
 * 外郭里坊的行列范围：i ∈ [i0, i1]（向东）、j ∈ [j0, j1]（向南），中轴那一列是第 0 列、城心那一排是第 0 排。
 * 大小按规划区的尺度（东西略宽），以 shift 为中心摆放：临海时城心仍在海边，外郭向岸上一侧展开。
 */
function extent(z: Pick<PlanZone, 'R' | 'shift'>) {
  const { BU, BV } = dims(z)
  const au = z.R * 1.1
  const av = z.R
  const [su, sv] = z.shift
  const i0 = Math.min(0, Math.round((su - au) / BU))
  const i1 = Math.max(0, Math.round((su + au) / BU))
  const j0 = Math.min(0, Math.round((sv - av) / BV))
  const j1 = Math.max(0, Math.round((sv + av) / BV))
  // 城门对着的两条南北大街：中轴两侧各自的中间
  const gw = (0.5 - Math.max(1, Math.ceil(-i0 / 2))) * BU
  const ge = (Math.max(1, Math.ceil(i1 / 2)) - 0.5) * BU
  return { i0, i1, j0, j1, gw, ge, BU, BV }
}

/**
 * 宫城：北端居中。都城的宫城横跨居中的三坊（wide）；外郭南北够深时纵向再占一排（rows = 2），
 * 合起来约 2 : 1，像长安的宫城（东西约 2.8 公里、南北约 1.5 公里）；只占一排的三坊太扁。州城只是一坊的子城。
 */
function palaceOf(ctx: Ctx, z: Pick<PlanZone, 'R' | 'shift'>) {
  const { i0, i1, j0, j1 } = extent(z)
  const wide = !!ctx.p.capital && i0 <= -3 && i1 >= 3 && j1 - j0 >= 4
  // 两排时宫城不压到城心那一排（城心照常是坊）
  const rows = wide && j1 - j0 >= 6 && j0 <= -2 ? 2 : 1
  return { wide, rows }
}

/** 片区站点的格号（i 向东、j 向南；宫城在 j = −nv） */
const cellOf = (z: PlanZone, q: P): [number, number] => {
  const { BU, BV } = dims(z)
  const [u, v] = z.toUV(q)
  return [Math.round(u / BU), Math.round(v / BV)]
}

export const lifang: CityPlan = {
  id: 'lifang',
  // 坐北朝南：u 向东、v 向南
  angle: () => 0,
  // 外郭按规划一次筑成，比当时的城区大一圈
  scale: 1.2,
  outline(_ctx, z) {
    const { i0, i1, j0, j1, BU, BV } = extent(z)
    return rectOutline(z, (i0 - 0.5) * BU, (i1 + 0.5) * BU, (j0 - 0.5) * BV, (j1 + 0.5) * BV)
  },
  sites: (_ctx, z) => gridSites(z, dims(z).BU, dims(z).BV),
  streets(ctx, z) {
    const { i0, i1, j0, j1, gw, ge, BU, BV } = extent(z)
    // 宫城前的横街：宫城最南一排的南边
    const front = j0 + palaceOf(ctx, z).rows - 1
    const U0 = (i0 - 0.5) * BU
    const U1 = (i1 + 0.5) * BU
    const V0 = (j0 - 0.5) * BV
    const V1 = (j1 + 0.5) * BV
    const out: PlanRoad[] = []
    // 坊间街：所有坊的边界线；通城门的（中间一条东西街、两侧各一条南北街）是大街
    const gateV = 0.5 * BV
    const gateU = [gw, ge]
    for (let i = i0; i < i1; i++) {
      const u = (i + 0.5) * BU
      const main = gateU.some((g) => Math.abs(g - u) < 1)
      out.push({ line: uvLine(z, [[u, V0], [u, V1]]), width: main ? AVENUE_W : STREET_W, kind: main ? 'main' : 'street', named: main })
    }
    for (let j = j0; j < j1; j++) {
      const v = (j + 0.5) * BV
      const main = Math.abs(v - gateV) < 1 || j === front
      out.push({ line: uvLine(z, [[U0, v], [U1, v]]), width: main ? AVENUE_W : STREET_W, kind: main ? 'main' : 'street', named: main })
    }
    // 朱雀大街：从宫城前的横街往南直到正门（接在横街南沿上，不伸进宫城）
    out.push({ line: uvLine(z, [[0, (front + 0.5) * BV + AVENUE_W / 2], [0, V1]]), width: AXIS_W, kind: 'main', named: true })
    return out
  },
  exit(_ctx, z, dir) {
    const { gw, ge, BV } = extent(z)
    const d = z.toUV([z.c[0] + Math.cos(dir), z.c[1] + Math.sin(dir)])
    // 向南出正门走朱雀大街；向北绕开宫城走侧面的大街；东西走中间的横街
    if (Math.abs(d[1]) >= Math.abs(d[0])) {
      if (d[1] > 0) return axisExit(z, dir)
      const u = d[0] >= 0 ? ge : gw
      return axisExit(z, dir, [u, 0])
    }
    return axisExit(z, dir, [0, 0.5 * BV])
  },
  assign(ctx, z, lots) {
    const { i0, i1, j0, j1, BU, BV } = extent(z)
    const at = (i: number, j: number) => lots.find((l) => {
      const [a, b] = cellOf(z, l.site)
      return a === i && b === j
    })
    const set = (i: number, j: number, t: WardType) => {
      const l = at(i, j)
      if (l) l.type = t
    }
    // 宫城（见 palaceOf）前隔着横街的一排是皇城（官署），按贵族宅第盖；都城的宫城几坊合成一座宫殿。
    // 通城门的南北大街在两侧第二列以外时，居中三坊之间只有坊间小街（合成宫城时拆掉）
    const { wide, rows } = palaceOf(ctx, z)
    // 宫城的矩形就是这几坊：东西到两侧坊间街，北到外郭（留出顺城街），南到横街
    if (wide) ctx.palaceRect = rectOutline(z, -1.5 * BU + STREET_W, 1.5 * BU - STREET_W, (j0 - 0.5) * BV + 14, (j0 + rows - 0.5) * BV - AVENUE_W / 2 - 5)
    for (const i of wide ? [-1, 0, 1] : [0]) {
      for (let r = 0; r < rows; r++) {
        set(i, j0 + r, 'castle')
        const l = at(i, j0 + r)
        if (l && wide) l.palace = true
      }
      if (j1 - j0 >= rows + 2) set(i, j0 + rows, 'noble')
    }
    // 城心那一坊不作广场，照常是坊
    const c = at(0, 0)
    if (c) c.type = 'common'
    // 东西两市：中轴两侧对称，在城的中部
    const mj = j0 <= -2 ? -1 : 0
    set(Math.max(1, Math.ceil(i1 / 2)), mj, 'market')
    set(-Math.max(1, Math.ceil(-i0 / 2)), mj, 'market')
  },
  build(ctx, ward, block, z) {
    if (!RESIDENTIAL.has(ward.type)) return false
    const { BU } = dims(z)
    // 中轴上的坊被朱雀大街劈成东西两半，各自围墙
    const [u] = z.toUV(centroid(block))
    const halves = Math.abs(u) < BU / 2 && crossesAxis(z, block) ? splitConvex(block, z.c, z.fromUV(0, 1).map((x, k) => x - z.c[k]) as P, AXIS_W + 8) : [block]
    const type = ward.type
    let homes = 0
    for (const h of halves) if (h.length >= 3 && area(h) > 400) homes += fang(ctx, type, h, halves.length === 1)
    // 还没住上人的坊（外郭按规划筑得比城大）：不算城区（统计的城区面积、区名都只给住了人的坊），也不铺城区的底色
    if (!homes) {
      ward.inner = false
      ward.type = 'farm'
      drop(ctx, 'blocks', (b) => pointInPoly(centroid(b), block))
    }
    return true
  },
  districtName(ctx, ward, z) {
    if (!formOf(ctx).jobo || !RESIDENTIAL.has(ward.type)) return undefined
    const c = centroid(ward.poly)
    if (!z.contains(c)) return undefined
    const [i, j] = cellOf(z, c)
    // 中轴那一列被朱雀大路劈成左右京的一坊，一块片区不好取名；其余约四成标出来，免得满图都是字
    if (i === 0 || hashAt(ctx, c, 'lifang.name') > 0.4) return null
    return joboName(j - extent(z).j0 + 1, Math.abs(i) + 1, i > 0)
  },
  facade(ctx, z) {
    if (formOf(ctx).rajo) rajomon(ctx, z)
  },
  wall(_ctx, z) {
    const { i0, i1, j0, j1, BU, BV } = extent(z)
    // 外郭墙在最外一圈坊的外侧，离坊间街留出顺城街
    return rectOutline(z, (i0 - 0.5) * BU - 6, (i1 + 0.5) * BU + 6, (j0 - 0.5) * BV - 6, (j1 + 0.5) * BV + 6)
  },
}

/** 按坊盖的片区（宫城、市、寺院等有自己的形态） */

function crossesAxis(z: PlanZone, poly: Poly) {
  let lo = Infinity
  let hi = -Infinity
  for (const q of poly) {
    const [u] = z.toUV(q)
    lo = Math.min(lo, u)
    hi = Math.max(hi, u)
  }
  return lo < -1 && hi > 1
}

/**
 * 一坊：坊墙（让开坊外的街）、坊内十字街（半坊只有一条东西街）分成几区，各区照片区功能填房子。
 * 返回盖起来的住户房屋数。
 */
function fang(ctx: Ctx, type: WardType, block: Poly, cross: boolean): number {
  const wall = placeable(ctx, insetConvex(block, 1.5), 2, 0.4)
  if (!wall || area(wall) < 400) return 0
  const c = centroid(wall)
  const inner = insetConvex(wall, 2)
  if (inner.length < 3) return 0
  const form = formOf(ctx)
  // 坊墙先登记，房子盖好了再画（一户也没有的空坊只留墙，像长安城南的空坊一样也是常态）
  if (form.fangWall) ctx.out.enclosures.push(wall)
  const e: P = [1, 0]
  const n: P = [0, 1]
  const w = 5
  // 坊内的街：长安是十字街（半坊只有一条东西街），平安京是小路把一坊分成十六町（半坊八町）
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const q of inner) [x0, y0, x1, y1] = [Math.min(x0, q[0]), Math.min(y0, q[1]), Math.max(x1, q[0]), Math.max(y1, q[1])]
  const cuts = (lo: number, hi: number, mid: number, k: number) => (k === 2 ? [mid] : Array.from({ length: k - 1 }, (_, m) => lo + ((hi - lo) * (m + 1)) / k))
  const rows = cuts(y0, y1, c[1], form.cells)
  const cols = cuts(x0, x1, c[0], cross ? form.cells : form.cells / 2)
  let parts: Poly[] = [inner]
  for (const y of rows) parts = parts.flatMap((a) => splitConvex(a, [c[0], y], e, w)).filter((a) => a.length >= 3)
  for (const x of cols) parts = parts.flatMap((a) => splitConvex(a, [x, c[1]], n, w)).filter((a) => a.length >= 3)
  // 坊内的街画成巷道（坊门开在街的两端）
  const ext = (o: P, d: P): P[] => {
    const L = 400
    return [
      [o[0] - d[0] * L, o[1] - d[1] * L],
      [o[0] + d[0] * L, o[1] + d[1] * L],
    ]
  }
  const clipTo = (line: P[]): P[] | null => {
    // 截到坊墙里
    const pts: P[] = []
    for (let t = 0; t <= 1; t += 0.005) {
      const q: P = [line[0][0] + (line[1][0] - line[0][0]) * t, line[0][1] + (line[1][1] - line[0][1]) * t]
      if (pointInPoly(q, wall)) pts.push(q)
    }
    return pts.length > 1 ? [pts[0], pts[pts.length - 1]] : null
  }
  const lanes = [...rows.map((y) => clipTo(ext([c[0], y], e))), ...cols.map((x) => clipTo(ext([x, c[1]], n)))]
  for (const l of lanes) if (l) addRoad(ctx, { line: l, width: 4, kind: 'lane' }, 1)
  const n0 = ctx.out.buildings.length
  for (const p of parts) {
    if (area(p) < 150) continue
    // 坊里的住宅按文明盖（长安是院落，平安京是町家）
    if (!ctx.style.plotFill?.(ctx, p, type)) urban(ctx, p, type)
  }
  const homes = ctx.out.buildings.slice(n0).filter((b) => b.kind === 'house' || b.kind === 'large').length
  // 还没住上人的坊（外郭按规划筑得比城大）：坊墙里种田，像长安城南的空坊
  if (!homes) {
    const veg = vegetation(ctx)
    for (const p of parts) if (area(p) > 300) farm(ctx, p, veg)
  }
  return homes
}


const NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
const kanjiNum = (k: number) => (k <= 10 ? NUM[k] : `十${NUM[k - 10]}`)
/** 条坊编号："左京五条三坊"（条从北往南数，坊从朱雀大路往外数；左京在东） */
function joboName(jo: number, bo: number, east: boolean): Tri {
  const side = east ? '左京' : '右京'
  return {
    zh: `${side}${kanjiNum(jo)}条${kanjiNum(bo)}坊`,
    en: `${east ? 'Sakyō' : 'Ukyō'} ${jo}-jō ${bo}-bō`,
    ja: `${side}${kanjiNum(jo)}条${kanjiNum(bo)}坊`,
  }
}

/**
 * 罗城与罗城门：外郭不筑城墙时，只在南面正门（朱雀大路的南端）两侧修一段罗城（各一坊宽），
 * 门是城的正面。临水处断开。
 */
function rajomon(ctx: Ctx, z: PlanZone) {
  const { j1, BU, BV } = extent(z)
  const v = (j1 + 0.5) * BV + 6
  const gate = z.fromUV(0, v)
  const loop: P[] = []
  const solid: boolean[] = []
  const half = 1.5 * BU
  for (let u = -half; u < half; u += 8) {
    loop.push(z.fromUV(u, v))
    solid.push(ctx.T.waterAt(z.fromUV(u + 4, v)) > 2)
  }
  loop.push(z.fromUV(half, v))
  // 回到起点的一段不画
  solid.push(false)
  if (ctx.T.waterAt(gate) < 3) return
  const thickness = 3
  ctx.out.walls.push({ loop, solid, towers: [], gates: [{ p: gate, angle: Math.PI / 2 }], kind: 'stone', thickness })
  for (let k = 0; k + 1 < loop.length; k++) if (solid[k] && dist(loop[k], gate) > AXIS_W / 2 + 2) ctx.corridors.add([loop[k], loop[k + 1]], thickness / 2 + 1.5, 'wall')
  ctx.out.landmarks.push({ p: gate, name: { zh: '罗城门', en: 'Rajōmon', ja: '羅城門' }, kind: 'gate' })
}
