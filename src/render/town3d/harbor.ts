/**
 * 码头与船。
 * 码头：窄长的是木栈桥（桥板、纵梁、成排的桩，隔一根高出桥面作系缆桩）；宽的是石砌的突堤（压顶石、系缆柱），
 * 和式以及水上的平舞台是桩上的木平台。
 * 船：放样的船壳（舷、甲板或舱底、舷墙），按文明与船长分小艇、渔船与商船——
 * 西式柯克船（单桅横帆、首尾楼）、东方的沙船与舢板（硬篷帆、尾楼，小船带席篷）、和船（单桅大方帆）、
 * 阿拉伯三角帆船（斜桁三角帆、前倾的艏柱）。帆或张或收，按位置哈希。纯函数，在 Worker 中运行。
 */
import { obb, type P } from '../../settlement/geom'
import { MAT, type RGB, type V3 } from './mesh'
import { STONE, STONE_EAST, TIMBER, TIMBER_DARK, hex } from './shared'
import { axUV, axOf, beam, box, hash, l3, loft, lp, stationsOf, sweep, tint, tube, type Ax } from './worksMesh'
import type { WCtx } from './works'

/** 码头面的高度（水面在 0 附近） */
const DECK = 0.9

/** 木栈桥：poly 为矩形（长向伸进水里） */
export function jetty(c: WCtx, poly: P[], top = DECK) {
  const { w } = c
  const o = obb(poly)
  const f = axUV(o.center, o.axis)
  const hs = o.len / 2
  const ht = o.wid / 2
  w.at(o.center[0], o.center[1])
  w.base = -1
  // 桥板：板缝横穿栈桥
  w.c = tint(TIMBER, 1.3)
  w.face = MAT.plank
  w.uvOf = (p) => [(p[0] - f.o[0]) * f.u[0] + (p[2] - f.o[1]) * f.u[1], 0, 0]
  box(w, f, -hs, hs, -ht, ht, top - 0.12, top, { bottom: true })
  w.uvOf = null
  // 纵梁
  w.c = TIMBER_DARK
  w.face = MAT.plain
  for (const t of [-ht + 0.25, ht - 0.25]) box(w, f, -hs, hs, t - 0.11, t + 0.11, top - 0.42, top - 0.12, { bottom: true, top: false })
  // 桩：两侧成排，隔一根高出桥面
  const n = Math.max(1, Math.round(o.len / 2.6))
  for (let i = 0; i <= n; i++) {
    const s = -hs + 0.3 + ((o.len - 0.6) * i) / n
    for (const sg of [-1, 1]) {
      const q = lp(f, s, sg * (ht - 0.02))
      const moor = (i + (sg > 0 ? 0 : 1)) % 2 === 0 && c.water(q[0], q[1]) < 1
      w.c = tint(TIMBER_DARK, 0.9 + hash(q[0], q[1], 1) * 0.3)
      tube(w, q, 0.15, 0.13, -3, top + (moor ? 0.6 : -0.1), 6, { cap: true })
    }
    // 桩间的横梁
    if (i % 2 === 0) {
      const a = lp(f, s, -ht)
      const b = lp(f, s, ht)
      w.c = TIMBER_DARK
      beam(w, [a[0], top - 0.55, a[1]], [b[0], top - 0.55, b[1]], 0.08, 0.1, false)
    }
  }
}

/** 桩上的木平台（和式的码头、水上的平舞台）：任意凸多边形 */
function platform(c: WCtx, poly: P[], top: number) {
  const { w } = c
  const ring = orient(poly)
  const o = obb(poly)
  w.c = tint(TIMBER, 1.3)
  w.face = MAT.plank
  w.uvOf = (p) => [(p[0] - o.center[0]) * o.axis[0] + (p[2] - o.center[1]) * o.axis[1], 0, 0]
  for (let i = 1; i + 1 < ring.length; i++) w.triOut([ring[0][0], top, ring[0][1]], [ring[i][0], top, ring[i][1]], [ring[i + 1][0], top, ring[i + 1][1]], [0, 1, 0])
  w.uvOf = null
  // 边梁一圈、底面
  const sts = stationsOf(ring, true, 1e9, () => top, 0, 0)
  w.c = TIMBER_DARK
  w.face = MAT.plain
  sweep(w, sts, [[0, -0.4], [0, 0]], { chunk: false })
  for (let i = 1; i + 1 < ring.length; i++) w.triOut([ring[0][0], top - 0.4, ring[0][1]], [ring[i][0], top - 0.4, ring[i][1]], [ring[i + 1][0], top - 0.4, ring[i + 1][1]], [0, -1, 0])
  // 桩：沿边每隔约 3 米一根（只立在水里或水边）
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    const m = Math.max(1, Math.round(L / 3))
    for (let k = 0; k < m; k++) {
      const q: P = [a[0] + ((b[0] - a[0]) * k) / m, a[1] + ((b[1] - a[1]) * k) / m]
      if (c.water(q[0], q[1]) > 1.5) continue
      // 略收进边梁里
      const ix = o.center[0] - q[0]
      const iz = o.center[1] - q[1]
      const il = Math.hypot(ix, iz) || 1
      tube(w, [q[0] + (ix / il) * 0.25, q[1] + (iz / il) * 0.25], 0.16, 0.14, -3, top - 0.05, 6)
    }
  }
}

/** 环统一成左手法线朝外的走向 */
function orient(poly: P[]): P[] {
  let a2 = 0
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length]
    a2 += poly[i][0] * q[1] - q[0] * poly[i][1]
  }
  return a2 > 0 ? [...poly].reverse() : poly
}

/** 石砌的突堤、岸壁：方石墙身、石板面、一圈压顶石，临水的边上立系缆柱 */
function quay(c: WCtx, poly: P[], top: number, col: RGB) {
  const { w } = c
  const ring = orient(poly)
  const sts = stationsOf(ring, true, 1e9, () => top, 0, 0)
  w.c = col
  w.face = MAT.stone
  sweep(w, sts, [[0.12, -4], [0, 0]], { chunk: false })
  w.c = tint(col, 0.92)
  w.face = MAT.paving
  for (let i = 1; i + 1 < ring.length; i++) w.triOut([ring[0][0], top, ring[0][1]], [ring[i][0], top, ring[i][1]], [ring[i + 1][0], top, ring[i + 1][1]], [0, 1, 0])
  // 压顶石：略高出台面的一圈
  w.c = tint(col, 1.1)
  w.face = MAT.plain
  sweep(w, sts, [[0.06, -0.16], [0.06, 0.1], [-0.42, 0.1], [-0.42, 0]], { chunk: false })
  sweep(w, sts, [[0, -0.16], [0.06, -0.16]], { chunk: false })
  // 系缆柱：临水的边每隔约 6 米一个
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 3) continue
    const ox = -(b[1] - a[1]) / L
    const oz = (b[0] - a[0]) / L
    const m = Math.max(1, Math.round(L / 6))
    for (let k = 0; k < m; k++) {
      const t = (k + 0.5) / m
      const q: P = [a[0] + (b[0] - a[0]) * t - ox * 0.75, a[1] + (b[1] - a[1]) * t - oz * 0.75]
      if (c.water(q[0] + ox * 2.5, q[1] + oz * 2.5) > 0) continue
      w.c = hex('#3b3a38')
      tube(w, q, 0.2, 0.16, top, top + 0.5, 7)
      tube(w, q, 0.24, 0.24, top + 0.5, top + 0.62, 7, { cap: true })
    }
  }
}

/** 码头、栈桥 */
export function pier(c: WCtx, poly: P[]) {
  const { w, culture } = c
  if (poly.length < 3) return
  const o = obb(poly)
  w.at(o.center[0], o.center[1])
  w.base = -1
  if (poly.length === 4 && o.wid <= 5.2 && o.len >= o.wid * 2.2) return jetty(c, poly)
  if (culture === 'wa') return platform(c, poly, DECK)
  quay(c, poly, DECK, culture === 'eastern' ? tint(STONE_EAST, 1.1) : culture === 'islamic' ? hex('#bfae90') : STONE)
}

// —————————————————————— 船 ——————————————————————

interface HullSpec {
  L: number
  beam: number
  /** 船中的干舷、吃水 */
  fb: number
  draft: number
  /** 艏艉的舷弧（比船中高出多少） */
  bow: number
  stern: number
  /** 艉封板宽度占船宽的比例（0 为两头尖） */
  sternW: number
  /** 艏的丰满度（指数，越大越钝） */
  bowP: number
  /** 甲板（或舱底板）低于舷缘多少 */
  well: number
  col: RGB
  deck: RGB
}

interface Hull {
  /** 船上的点：u 自艉（0）到艏（1），t 为横向（米），y 为高度 */
  at: (u: number, t: number, y: number) => V3
  sheer: (u: number) => number
  halfBeam: (u: number) => number
  deckY: (u: number) => number
}

/** 放样的船壳：外板、艉封板、甲板、舷墙内面与舷缘 */
function hull(c: WCtx, f: Ax, h: HullSpec): Hull {
  const { w } = c
  const N = 10
  const hb = (u: number) => {
    let k = 1
    if (u > 0.5) k = 1 - Math.pow((u - 0.5) / 0.5, h.bowP)
    else if (u < 0.3) k = 1 - (1 - h.sternW) * Math.pow((0.3 - u) / 0.3, 2)
    return (h.beam / 2) * Math.max(0, k)
  }
  const sheer = (u: number) => h.fb + h.stern * Math.pow(Math.max(0, 0.4 - u) / 0.4, 2) + h.bow * Math.pow(Math.max(0, u - 0.55) / 0.45, 2)
  const keel = (u: number) => -h.draft * (u > 0.72 ? 1 - Math.pow((u - 0.72) / 0.28, 2) * 0.9 : u < 0.15 ? 1 - Math.pow((0.15 - u) / 0.15, 2) * 0.5 : 1)
  const at = (u: number, t: number, y: number): V3 => l3(f, (u - 0.5) * h.L, t, y)
  const deckY = (u: number) => sheer(u) - h.well
  const rows: V3[][] = []
  for (let i = 0; i <= N; i++) {
    const u = i / N
    const b = hb(u)
    const s = sheer(u)
    const k = keel(u)
    rows.push([at(u, -b, s), at(u, -b * 0.99, s * 0.4), at(u, -b * 0.76, k * 0.72), at(u, 0, k), at(u, b * 0.76, k * 0.72), at(u, b * 0.99, s * 0.4), at(u, b, s)])
  }
  // 外板：列板的缝沿船长
  w.c = h.col
  w.face = MAT.plank
  const girth = [0, 0.9, 2.1, 3.0, 3.9, 5.1, 6.0]
  loft(w, rows, at(0.5, 0, h.fb * 0.3), { coordOf: (_, j) => [girth[j] * 0.26, 0, 0] })
  // 艉封板
  if (h.sternW > 0) {
    w.face = MAT.board
    const out: V3 = [-f.u[0], 0, -f.u[1]]
    for (let j = 1; j + 1 < 7; j++) w.triOut(rows[0][0], rows[0][j], rows[0][j + 1], out)
  }
  // 舷缘、舷墙内面、甲板
  const rim = 0.11
  for (let i = 0; i < N; i++) {
    const u0 = i / N
    const u1 = (i + 1) / N
    const b0 = hb(u0)
    const b1 = hb(u1)
    const d0 = Math.max(0, b0 - rim)
    const d1 = Math.max(0, b1 - rim)
    const s0 = sheer(u0)
    const s1 = sheer(u1)
    for (const sg of [-1, 1]) {
      w.c = tint(h.col, 0.7)
      w.face = MAT.plain
      w.quadOut(at(u0, sg * b0, s0), at(u1, sg * b1, s1), at(u1, sg * d1, s1), at(u0, sg * d0, s0), [0, 1, 0])
      w.c = tint(h.col, 1.15)
      w.face = MAT.board
      w.quadOut(at(u0, sg * d0, deckY(u0)), at(u1, sg * d1, deckY(u1)), at(u1, sg * d1, s1), at(u0, sg * d0, s0), [-f.v[0] * sg, 0, -f.v[1] * sg])
    }
    w.c = h.deck
    w.face = MAT.plank
    const a0 = at(u0, -d0, deckY(u0))
    const a1 = at(u0, d0, deckY(u0))
    const c0 = at(u1, -d1, deckY(u1))
    const c1 = at(u1, d1, deckY(u1))
    w.uvOf = (p) => [p === a0 ? -d0 : p === a1 ? d0 : p === c0 ? -d1 : d1, 0, 0]
    w.quadOut(a0, a1, c1, c0, [0, 1, 0])
    w.uvOf = null
  }
  // 艉端的舷墙内面（封板内侧）
  if (h.sternW > 0) {
    const d = Math.max(0, hb(0) - rim)
    w.c = tint(h.col, 1.15)
    w.face = MAT.board
    w.quadOut(at(0, -d, deckY(0)), at(0, d, deckY(0)), at(0, d, sheer(0)), at(0, -d, sheer(0)), [f.u[0], 0, f.u[1]])
  }
  return { at, sheer, halfBeam: hb, deckY }
}

const CANVAS = hex('#d9d0b8')
const ROPE = hex('#4a4034')

/** 桅：自甲板到 top 的圆杆（可前后倾） */
function mast(c: WCtx, foot: V3, top: V3, r: number) {
  const { w } = c
  w.c = hex('#6b5238')
  w.face = MAT.plain
  // 倾斜的桅用方梁近似圆杆（竖直时用圆台）
  if (Math.hypot(top[0] - foot[0], top[2] - foot[2]) < 0.05) tube(w, [foot[0], foot[2]], r, r * 0.6, foot[1], top[1], 6, { cap: true })
  else beam(w, foot, top, r * 0.85, r * 0.85)
}

/** 缆：细的方条 */
function rope(c: WCtx, a: V3, b: V3) {
  c.w.c = ROPE
  c.w.face = MAT.plain
  beam(c.w, a, b, 0.022, 0.022, false)
}

/** 横帆：帆桁在 yc（中心）、沿 v 向半长 hw；set 时自帆桁垂下 drop 米、向前鼓起，否则卷在桁上 */
function squareSail(c: WCtx, f: Ax, yc: V3, hw: number, drop: number, set: boolean, col: RGB, stripe = 0) {
  const { w } = c
  const P3 = (t: number, dy: number, fwd: number): V3 => [yc[0] + f.v[0] * t + f.u[0] * fwd, yc[1] + dy, yc[2] + f.v[1] * t + f.u[1] * fwd]
  w.c = hex('#5a4530')
  w.face = MAT.plain
  beam(w, P3(-hw - 0.3, 0, 0), P3(hw + 0.3, 0, 0), 0.07, 0.07)
  w.c = col
  w.face = MAT.cloth
  if (!set) {
    beam(w, P3(-hw, -0.2, 0.02), P3(hw, -0.2, 0.02), 0.13, 0.15)
    return
  }
  const R = 4
  const C = 4
  const rows: V3[][] = []
  for (let i = 0; i <= R; i++) {
    const row: V3[] = []
    for (let j = 0; j <= C; j++) {
      const t = -hw + (2 * hw * j) / C
      const belly = Math.sin((Math.PI * i) / R) * (1 - Math.pow(t / hw, 2) * 0.6) * hw * 0.28
      // 帆脚略收窄
      row.push(P3(t * (1 - 0.06 * (i / R)), -0.1 - (drop * i) / R, 0.12 + belly))
    }
    rows.push(row)
  }
  loft(w, rows, P3(0, -drop / 2, -hw), { double: true, coordOf: (_, j) => [(2 * hw * j) / C, stripe, 0] })
}

/** 硬篷帆（东方）：一块平的帆面，几道横向的帆竹；帆面在含桅的竖直面里、略偏转 */
function battenSail(c: WCtx, f: Ax, foot: V3, y0: number, y1: number, wd: number, yaw: number, col: RGB) {
  const { w } = c
  const d: P = [f.u[0] * Math.cos(yaw) + f.v[0] * Math.sin(yaw), f.u[1] * Math.cos(yaw) + f.v[1] * Math.sin(yaw)]
  // 桅在帆宽的前四分之一处；帆顶向后上方斜
  const P3 = (x: number, y: number): V3 => [foot[0] - d[0] * x, y, foot[2] - d[1] * x]
  const x0 = -wd * 0.25
  const x1 = wd * 0.75
  const top = (x: number) => y1 - (1 - (x - x0) / wd) * (y1 - y0) * 0.22
  const n = 5
  const side: V3 = [-d[1], 0, d[0]]
  w.c = col
  w.face = MAT.cloth
  for (let i = 0; i < n; i++) {
    const a = i / n
    const b = (i + 1) / n
    const q = [P3(x0, y0 + (top(x0) - y0) * a), P3(x1, y0 + (top(x1) - y0) * a), P3(x1, y0 + (top(x1) - y0) * b), P3(x0, y0 + (top(x0) - y0) * b)]
    w.quadOut(q[0], q[1], q[2], q[3], side)
    w.quadOut(q[0], q[1], q[2], q[3], [-side[0], 0, -side[2]])
  }
  w.c = hex('#4a3a2a')
  w.face = MAT.plain
  for (let i = 0; i <= n; i++) {
    const a = i / n
    beam(w, P3(x0 - 0.1, y0 + (top(x0) - y0) * a), P3(x1 + 0.1, y0 + (top(x1) - y0) * a), 0.05, 0.05)
  }
}

/** 三角帆（阿拉伯）：长斜桁自艏低处斜到艉上方；set 时桁下一面三角帆，否则帆卷在桁上 */
function lateen(c: WCtx, f: Ax, low: V3, high: V3, clew: V3, set: boolean) {
  const { w } = c
  w.c = hex('#5a4530')
  w.face = MAT.plain
  beam(w, low, high, 0.07, 0.07)
  w.c = CANVAS
  w.face = MAT.cloth
  if (!set) {
    const dn = (p: V3): V3 => [p[0], p[1] - 0.18, p[2]]
    beam(w, dn(low), dn(high), 0.12, 0.13)
    return
  }
  const side: V3 = [f.v[0], 0, f.v[1]]
  // 帆面略鼓：中间一点向一侧偏
  const mid: V3 = [(low[0] + high[0] + clew[0]) / 3 + f.v[0] * 0.5, (low[1] + high[1] + clew[1]) / 3, (low[2] + high[2] + clew[2]) / 3 + f.v[1] * 0.5]
  for (const [a, b] of [[low, high], [high, clew], [clew, low]] as [V3, V3][]) {
    w.triOut(a, b, mid, side)
    w.triOut(a, b, mid, [-side[0], 0, -side[2]])
  }
}

/** 船：按文明与船长；kind 为 'ferry' 时是渡船（平底的摆渡船，船上一根撑篙） */
export function boat(c: WCtx, b: { p: P; angle: number; len: number }, kind?: 'ferry') {
  const { w, culture } = c
  w.at(b.p[0], b.p[1])
  w.base = -0.6
  const f = axOf(b.p, b.angle)
  const L = b.len
  const hs = hash(b.p[0], b.p[1], 1)
  const hs2 = hash(b.p[0], b.p[1], 2)
  const tar = culture === 'islamic' ? hex('#6f5237') : culture === 'eastern' ? hex('#5b4130') : culture === 'wa' ? hex('#7a6248') : hex('#4b3a2b')
  const col = tint(tar, 0.88 + hs * 0.3)
  const deckCol = tint(hex('#a58a62'), 0.9 + hs2 * 0.2)

  if (kind === 'ferry') {
    // 渡船：平底方头，船上横几块坐板
    const h = hull(c, f, { L, beam: L * 0.34, fb: 0.5, draft: 0.25, bow: 0.18, stern: 0.12, sternW: 0.8, bowP: 5, well: 0.4, col, deck: deckCol })
    w.c = tint(col, 1.2)
    w.face = MAT.board
    for (const u of [0.3, 0.5, 0.7]) {
      const bb = h.halfBeam(u) - 0.1
      box(w, { o: lp(f, (u - 0.5) * L, 0), u: f.u, v: f.v }, -0.14, 0.14, -bb, bb, h.sheer(u) - 0.16, h.sheer(u) - 0.1, { bottom: true })
    }
    rope(c, h.at(0.2, 0.3, h.deckY(0.2)), h.at(0.05, 0.9, 3.4))
    return
  }

  if (L < 8.2) {
    // 小艇、舢板：敞口，坐板；东方的舢板带一段席篷
    const blunt = culture === 'eastern' || culture === 'wa'
    const h = hull(c, f, { L, beam: L * (blunt ? 0.27 : 0.3), fb: 0.48, draft: 0.3, bow: blunt ? 0.2 : 0.32, stern: 0.14, sternW: blunt ? 0.75 : 0.5, bowP: blunt ? 3.2 : 2, well: 0.42, col, deck: deckCol })
    w.c = tint(col, 1.25)
    w.face = MAT.board
    for (const u of culture === 'eastern' ? [0.22, 0.82] : [0.25, 0.5, 0.74]) {
      const bb = h.halfBeam(u) - 0.1
      if (bb > 0.25) box(w, { o: lp(f, (u - 0.5) * L, 0), u: f.u, v: f.v }, -0.13, 0.13, -bb, bb, h.sheer(u) - 0.17, h.sheer(u) - 0.11, { bottom: true })
    }
    if (culture === 'eastern') {
      // 席篷：船中一段拱形的篷
      const rows: V3[][] = []
      for (const u of [0.34, 0.5, 0.66]) {
        const bb = h.halfBeam(u) - 0.02
        const row: V3[] = []
        for (let k = 0; k <= 6; k++) {
          const a = Math.PI * (k / 6)
          row.push(h.at(u, -Math.cos(a) * bb, h.sheer(u) - 0.05 + Math.sin(a) * bb * 0.95))
        }
        rows.push(row)
      }
      w.c = hex('#a39264')
      w.face = MAT.straw
      loft(w, rows, h.at(0.5, 0, 0.3), { double: true })
    } else {
      // 一对桨：收在船里，架在坐板上
      w.c = hex('#8a7352')
      w.face = MAT.plain
      for (const sg of [-1, 1]) beam(w, h.at(0.22, sg * 0.28, h.sheer(0.3) - 0.06), h.at(0.78, sg * 0.2, h.sheer(0.7) - 0.02), 0.035, 0.03)
    }
    return
  }

  const big = L >= 13
  const set = hash(b.p[0], b.p[1], 4) < (culture === 'eastern' ? 0.6 : 0.4)
  if (culture === 'eastern') {
    // 沙船：平头方艉、艉楼高起，硬篷帆
    const h = hull(c, f, { L, beam: L * 0.27, fb: Math.min(1.7, L * 0.085), draft: 0.5, bow: L * 0.055, stern: L * 0.12, sternW: 0.78, bowP: 4.5, well: 0.45, col, deck: deckCol })
    // 舷侧一道赭红的腰线
    // 艉楼：舱房与弧形的篷顶
    const cu = 0.18
    const cb = h.halfBeam(cu) - 0.25
    const cy = h.deckY(cu)
    const cf = { o: lp(f, (cu - 0.5) * L, 0), u: f.u, v: f.v }
    w.c = hex('#7a4a34')
    w.face = MAT.board
    box(w, cf, -L * 0.1, L * 0.1, -cb, cb, cy, cy + 1.5, { top: false })
    w.c = hex('#8c8468')
    w.face = MAT.straw
    const rows: V3[][] = []
    for (const s of [-L * 0.11, L * 0.11]) {
      const row: V3[] = []
      for (let k = 0; k <= 4; k++) row.push(l3(cf, s, -cb - 0.12 + ((cb * 2 + 0.24) * k) / 4, cy + 1.5 + Math.sin((Math.PI * k) / 4) * 0.35))
      rows.push(row)
    }
    loft(w, rows, l3(cf, 0, 0, cy), { double: true })
    w.c = hex('#7a4a34')
    w.face = MAT.board
    for (const s of [-L * 0.1, L * 0.1]) w.triOut(l3(cf, s, -cb, cy + 1.5), l3(cf, s, cb, cy + 1.5), l3(cf, s, 0, cy + 1.85), [f.u[0] * s, 0, f.u[1] * s])
    const sailCol = tint(hex('#8a4f36'), 0.9 + hs2 * 0.25)
    const masts: [number, number, number][] = big ? [[0.5, L * 0.78, L * 0.36], [0.76, L * 0.55, L * 0.26]] : [[0.52, L * 0.72, L * 0.34]]
    for (const [u, mh, sw] of masts) {
      const foot = h.at(u, 0, h.deckY(u))
      const top: V3 = [foot[0], foot[1] + mh, foot[2]]
      mast(c, foot, top, L * 0.012 + 0.06)
      if (set) battenSail(c, f, foot, foot[1] + mh * 0.2, foot[1] + mh * 0.97, sw, (hs - 0.5) * 0.9, sailCol)
      else {
        // 落帆：帆与帆竹叠在桅脚的帆架上
        w.c = sailCol
        w.face = MAT.cloth
        const a = h.at(u - 0.02 - (sw * 0.75) / L, 0.1, foot[1] + 1.25)
        const e = h.at(u + (sw * 0.25) / L, 0.1, foot[1] + 1.4)
        beam(w, a, e, 0.16, 0.22)
      }
    }
    return
  }

  if (culture === 'wa') {
    // 和船（弁才船）：艏柱高挑，单桅大方帆，艉部低矮的舱屋
    const h = hull(c, f, { L, beam: L * 0.3, fb: Math.min(1.5, L * 0.08), draft: 0.5, bow: L * 0.13, stern: L * 0.09, sternW: 0.7, bowP: 1.9, well: 0.4, col, deck: deckCol })
    const cu = 0.2
    const cb = h.halfBeam(cu) - 0.2
    const cy = h.deckY(cu)
    const cf = { o: lp(f, (cu - 0.5) * L, 0), u: f.u, v: f.v }
    w.c = tint(TIMBER, 1.2)
    w.face = MAT.board
    box(w, cf, -L * 0.09, L * 0.09, -cb, cb, cy, cy + 1.1, { topFace: MAT.plank, topCol: tint(TIMBER, 1.4) })
    const u = 0.47
    const foot = h.at(u, 0, h.deckY(u))
    const mh = L * 0.8
    mast(c, foot, [foot[0], foot[1] + mh, foot[2]], L * 0.013 + 0.07)
    squareSail(c, f, [foot[0], foot[1] + (set ? mh * 0.93 : 1.6), foot[2]], L * 0.27, mh * 0.66, set, hex('#e6dfcc'), L * 0.045)
    rope(c, [foot[0], foot[1] + mh, foot[2]], h.at(0.98, 0, h.sheer(0.98)))
    rope(c, [foot[0], foot[1] + mh, foot[2]], h.at(0.03, 0, h.sheer(0.03)))
    return
  }

  if (culture === 'islamic') {
    // 三角帆船：艏柱前倾，斜桁三角帆
    const h = hull(c, f, { L, beam: L * 0.27, fb: Math.min(1.5, L * 0.08), draft: 0.55, bow: L * 0.12, stern: L * 0.1, sternW: 0.5, bowP: 1.6, well: 0.45, col, deck: deckCol })
    const u = 0.56
    const foot = h.at(u, 0, h.deckY(u))
    const mh = L * 0.62
    const top = h.at(u + 0.07, 0, foot[1] + mh)
    mast(c, foot, top, L * 0.012 + 0.06)
    const low = h.at(0.98, 0.25, h.sheer(0.98) + 0.5)
    const high = h.at(0.2, 0.25, foot[1] + mh * 1.32)
    lateen(c, f, low, high, h.at(0.12, 0.6, h.sheer(0.12) + 0.5), set)
    if (big) {
      // 艉甲板：高出一截的艉楼
      const cb = h.halfBeam(0.12) - 0.15
      box(w, { o: lp(f, -0.38 * L, 0), u: f.u, v: f.v }, -L * 0.1, L * 0.1, -cb, cb, h.deckY(0.12), h.sheer(0.12) + 0.05, { topFace: MAT.plank, topCol: deckCol })
    }
    rope(c, top, h.at(0.05, 0, h.sheer(0.05)))
    return
  }

  // 西式：柯克船（大船带首尾楼），小些的是单桅渔船
  const h = hull(c, f, { L, beam: L * 0.3, fb: Math.min(1.9, L * 0.1), draft: 0.6, bow: L * 0.075, stern: L * 0.08, sternW: 0.5, bowP: 2.3, well: 0.5, col, deck: deckCol })
  if (big) {
    // 艉楼与艏楼：高出舷缘的平台，四周一圈木栏
    for (const [u0, u1] of [[0.04, 0.27], [0.83, 0.95]]) {
      const um = (u0 + u1) / 2
      const cb = Math.max(0.5, h.halfBeam(um) + 0.1)
      const y = h.sheer(um) + 0.75
      const cf = { o: lp(f, (um - 0.5) * L, 0), u: f.u, v: f.v }
      const hl = ((u1 - u0) * L) / 2
      w.c = tint(col, 1.25)
      w.face = MAT.board
      box(w, cf, -hl, hl, -cb, cb, h.deckY(um) + 0.02, y, { topFace: MAT.plank, topCol: deckCol })
      for (const sg of [-1, 1]) {
        box(w, cf, -hl, hl, sg * cb - (sg > 0 ? 0.08 : 0), sg * cb + (sg > 0 ? 0 : 0.08), y, y + 0.7)
        box(w, cf, sg * hl - (sg > 0 ? 0.08 : 0), sg * hl + (sg > 0 ? 0 : 0.08), -cb, cb, y, y + 0.7)
      }
    }
  }
  const u = 0.53
  const foot = h.at(u, 0, h.deckY(u))
  const mh = L * (big ? 0.82 : 0.7)
  const top: V3 = [foot[0], foot[1] + mh, foot[2]]
  mast(c, foot, top, L * 0.013 + 0.07)
  squareSail(c, f, [foot[0], foot[1] + mh * 0.86, foot[2]], L * 0.27, mh * 0.6, set, tint(CANVAS, 0.92 + hs2 * 0.12), hs < 0.3 ? L * 0.04 : 0)
  if (big) {
    // 桅顶的瞭望斗
    w.c = tint(col, 1.2)
    w.face = MAT.board
    tube(w, [foot[0], foot[2]], 0.38, 0.5, foot[1] + mh * 0.9, foot[1] + mh * 0.9 + 0.55, 8, { cap: true })
  }
  rope(c, top, h.at(0.99, 0, h.sheer(0.99)))
  rope(c, top, h.at(0.02, 0, h.sheer(0.02)))
  for (const sg of [-1, 1]) rope(c, [top[0], top[1] - mh * 0.12, top[2]], h.at(u - 0.06, sg * (h.halfBeam(u) - 0.05), h.sheer(u)))
}
