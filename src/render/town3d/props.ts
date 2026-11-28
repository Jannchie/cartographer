/**
 * 小品：生成器给了点位或宅地、二维地图上画成符号的东西，在沙盘上立起来。
 * - 地标点：井、喷泉、雕像（有的文明立石灯笼、石碑）、水车；
 * - 交给这里盖的"建筑"：墓地里的墓（各文明的墓碑、坟丘、墓石）、广场上的市集摊棚、风车、灯塔、砖瓦窑、绞刑台、传送门；
 * - 园林的置石与假山；奇观（法阵、灵泉、浮空岛、灵脉的晶簇）；田里的草垛。
 * 各文明不同的做法（墓、摊棚的棚顶、井栏、喷泉、雕像位上立什么……）读文明的沙盘套件（kits.ts 的 GraveKit、PropsKit）。
 * 都并进体块的网格、带各自的生卒。数量可能上千（墓、摊棚），每件只用几十个三角形。纯函数，在 Worker 中运行。
 */
import { area, bboxOf, centroid, obb, pointInPoly, type P } from '../../settlement/geom'
import type { Building, Field, Landmark, ParkPart, Settlement } from '../../settlement/types'
import { MAT, mixRGB, shade, type RGB, type V3 } from './mesh'
import { COPPER, STONE, TIMBER, TIMBER_DARK, hex } from './shared'
import { archFace, archOutline, axOf, axUV, ball, beam, box, cbox, hash, l3, loft, lp, placeArch, ringUnder, wallTube, vault, type Ax } from './worksMesh'
import type { WCtx } from './works'

const MARBLE = hex('#d8d4c8')
const STRAW = hex('#c2a55e')
const IRON = hex('#33312f')

// —————————————————————— 交给小品盖的建筑 ——————————————————————

/** 小品的索引：哪些建筑不按房子盖，而是墓、摊棚、风车…… */
export interface PropIndex {
  /** 建筑 → 小品种类 */
  of: (b: Building) => PropKind | null
}
export type PropKind = 'grave' | 'stall' | 'windmill' | 'lighthouse' | 'kiln' | 'gallows' | 'portal'

interface Boxed {
  poly: P[]
  box: [number, number, number, number]
}
const boxed = (poly: P[]): Boxed => ({ poly, box: bboxOf(poly) })
const inAny = (p: P, list: Boxed[]) => list.some((q) => p[0] >= q.box[0] && p[0] <= q.box[2] && p[1] >= q.box[1] && p[1] <= q.box[3] && pointInPoly(p, q.poly))

export function propIndex(st: Settlement): PropIndex {
  const graveyards = st.greens.filter((g) => g.kind === 'cemetery').map((g) => boxed(g.poly))
  const plazas = st.plazas.map(boxed)
  const marks = (k: Landmark['kind']) => st.landmarks.filter((l) => l.kind === k).map((l) => l.p)
  const windmills = marks('windmill')
  const lighthouses = marks('lighthouse')
  const kilns = marks('kiln')
  const gallows = marks('gallows')
  const circles = st.wonders.filter((x) => x.kind === 'circle').map((x) => x.p)
  const near = (p: P, list: P[], d: number) => list.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < d)
  return {
    of(b) {
      const round = b.poly.length >= 8
      if (b.kind === 'shed' || (b.kind === 'civic' && !round)) {
        const a = area(b.poly)
        const c = centroid(b.poly)
        if (a < 3.4 && inAny(c, graveyards)) return 'grave'
        if (b.kind === 'shed' && a < 24 && near(c, gallows, 1.5)) return 'gallows'
        if (b.kind === 'shed' && a < 24 && inAny(c, plazas)) return 'stall'
        return null
      }
      if (round && b.kind === 'civic' && near(centroid(b.poly), windmills, 1.5)) return 'windmill'
      if (round && b.kind === 'tower' && near(centroid(b.poly), lighthouses, 1.5)) return 'lighthouse'
      if (round && b.kind === 'hall' && near(centroid(b.poly), kilns, 14)) return 'kiln'
      if (b.kind === 'magic' && b.poly.length === 4 && area(b.poly) < 14 && near(centroid(b.poly), circles, 2)) return 'portal'
      return null
    },
  }
}

/** 按种类盖小品（代替 building） */
export function propBuilding(c: WCtx, b: Building, kind: PropKind) {
  const { w, H } = c
  const o = obb(b.poly)
  const f = axUV(o.center, o.axis)
  const g = H(o.center[0], o.center[1])
  w.base = g - 0.6
  w.face = MAT.plain
  switch (kind) {
    case 'grave':
      return c.kit.grave.plot(c, f, g, o.len, o.wid)
    case 'stall':
      return stall(c, f, g, o.len / 2, o.wid / 2, b.tone)
    case 'windmill':
      return windmill(c, o.center, g, Math.sqrt(area(b.poly) / Math.PI))
    case 'lighthouse':
      return lighthouse(c, o.center, g, Math.sqrt(area(b.poly) / Math.PI))
    case 'kiln':
      return kiln(c, o.center, g, Math.sqrt(area(b.poly) / Math.PI))
    case 'gallows':
      return gallows(c, f, g, Math.min(o.len, o.wid) / 2)
    case 'portal':
      return portal(c, f, g, o.len / 2)
  }
}

/** 摊棚的篷布颜色（低饱和的红、蓝、绿、赭、本白） */
const AWNING: RGB[] = ['#a8483a', '#4a6a8a', '#5f7d52', '#b08a3e', '#c9c0a8', '#8a4a5a'].map(hex)

/** 市集摊棚：四柱、篷顶（条纹篷布，或木板 / 草顶的小棚）、柜台与货 */
function stall(c: WCtx, f: Ax, g: number, hs: number, ht: number, tone: number) {
  const { w } = c
  const [x, z] = f.o
  const h1 = hash(x, z, 1)
  const lo = g - 0.4
  // 木板、草顶的小棚（否则是条纹篷布）
  const solid = c.kit.props.stallRoof
  const yb = g + 1.95
  const yf = g + (solid ? 2.25 : 2.55)
  // 柱
  w.c = TIMBER_DARK
  for (const [s, t, top] of [[-1, -1, yb], [1, -1, yb], [1, 1, yf], [-1, 1, yf]] as [number, number, number][]) {
    const q = lp(f, s * (hs - 0.12), t * (ht - 0.12))
    beam(w, [q[0], lo, q[1]], [q[0], top, q[1]], 0.055, 0.055, false)
  }
  // 篷顶：单坡，前高后低，四周略挑出
  const col = solid ? solid.col : AWNING[Math.floor(tone * 977 + h1 * 6) % AWNING.length]
  w.c = col
  w.face = solid ? solid.face : MAT.cloth
  const ov = 0.3
  const a = l3(f, -hs - ov, -ht - ov, yb - 0.1)
  const b = l3(f, hs + ov, -ht - ov, yb - 0.1)
  const d = l3(f, -hs - ov, ht + ov, yf + 0.1)
  const e = l3(f, hs + ov, ht + ov, yf + 0.1)
  const stripe = solid ? 0 : h1 < 0.75 ? 0.34 : 0
  w.uvOf = (p) => [(p[0] - f.o[0]) * f.u[0] + (p[2] - f.o[1]) * f.u[1] + hs + ov, stripe, 0]
  w.slabQuad(a, b, e, d, 0.05, shade(col, 0.6))
  w.uvOf = null
  // 前檐垂下的一道布边
  if (!solid) {
    w.uvOf = (p) => [(p[0] - f.o[0]) * f.u[0] + (p[2] - f.o[1]) * f.u[1] + hs + ov, stripe, 0]
    const dn = (p: V3): V3 => [p[0], p[1] - 0.28, p[2]]
    w.quadOut(d, e, dn(e), dn(d), [f.v[0], 0, f.v[1]])
    w.quadOut(d, e, dn(e), dn(d), [-f.v[0], 0, -f.v[1]])
    w.uvOf = null
  }
  // 柜台与货：台面上两三堆
  w.c = shade(TIMBER, 1.15)
  w.face = MAT.board
  box(w, f, -hs + 0.25, hs - 0.25, ht * 0.1, ht - 0.25, lo, g + 0.85)
  w.face = MAT.plain
  const goods: RGB[] = ['#b8742a', '#8a9a4a', '#a84a3a', '#d2c08a', '#6a5a7a'].map(hex)
  for (let k = 0; k < 2; k++) {
    w.c = goods[Math.floor(hash(x, z, 5 + k) * goods.length)]
    const s0 = -hs + 0.4 + k * (hs - 0.3)
    box(w, f, s0, s0 + hs * 0.55, ht * 0.25, ht - 0.4, g + 0.85, g + 1.0 + hash(x, z, 8 + k) * 0.2, { inset: 0.07 })
  }
}

/** 风车：收分的石砌圆塔、可转向的木帽，四片帆翼（木骨与帆布） */
function windmill(c: WCtx, p: P, g: number, r: number) {
  const { w } = c
  const R = Math.max(2.6, r)
  const top = g + 9.5
  w.c = hex('#cfc8b6')
  w.face = MAT.plaster
  wallTube(w, p, R, R * 0.72, g - 1.2, top, 14)
  // 门
  const ang = hash(p[0], p[1], 1) * Math.PI * 2
  const f = axOf(p, ang)
  w.c = hex('#4f3d2c')
  w.face = MAT.board
  box(w, f, R * 0.93, R * 0.99, -0.5, 0.5, g - 0.2, g + 2.0)
  // 木帽：圆锥顶
  w.c = hex('#6a5846')
  w.face = MAT.plank
  w.uvOf = (q) => [q[1], 0, 0]
  wallTube(w, p, R * 0.8, R * 0.76, top, top + 0.5, 12)
  w.uvOf = null
  w.c = hex('#5c4a3a')
  w.face = MAT.straw
  ringUnder(w, p, R * 0.7, R * 0.92, top + 0.5, 12)
  wallTube(w, p, R * 0.92, 0, top + 0.5, top + 0.5 + R * 0.85, 12)
  // 帆翼：轴略上扬，朝门的方向；四片帆翼在垂直于轴的平面里
  const hub: V3 = l3(f, R * 0.72 + 1.0, 0, top - 0.2)
  w.c = TIMBER_DARK
  w.face = MAT.plain
  beam(w, l3(f, 0, 0, top), hub, 0.16, 0.16)
  const a0 = hash(p[0], p[1], 2) * Math.PI * 0.5
  const span = 7.6
  for (let k = 0; k < 4; k++) {
    const a = a0 + (k * Math.PI) / 2
    // 帆翼平面内的两个方向：沿翼（radial）与翼宽（tangent）
    const rad: V3 = [f.v[0] * Math.cos(a), Math.sin(a), f.v[1] * Math.cos(a)]
    const tan: V3 = [-f.v[0] * Math.sin(a), Math.cos(a), -f.v[1] * Math.sin(a)]
    const at = (s: number, t: number, fwd = 0): V3 => [hub[0] + rad[0] * s + tan[0] * t + f.u[0] * fwd, hub[1] + rad[1] * s + tan[1] * t, hub[2] + rad[2] * s + tan[2] * t + f.u[1] * fwd]
    w.c = TIMBER_DARK
    w.face = MAT.plain
    beam(w, at(0, 0), at(span, 0), 0.07, 0.07)
    // 帆布：翼的一侧，自翼根 1.4 米到翼梢
    w.c = hex('#d8cfb8')
    w.face = MAT.cloth
    const q = [at(1.4, 0.08, 0.04), at(span, 0.08, 0.04), at(span, 1.5, 0.16), at(1.4, 1.3, 0.16)]
    w.quadOut(q[0], q[1], q[2], q[3], [f.u[0], 0, f.u[1]])
    w.quadOut(q[0], q[1], q[2], q[3], [-f.u[0], 0, -f.u[1]])
    // 帆骨：外缘与几道横档
    w.c = TIMBER
    w.face = MAT.plain
    beam(w, at(1.4, 1.3, 0.16), at(span, 1.5, 0.16), 0.035, 0.035, false)
    for (const s of [1.4, 3.4, 5.5, span]) beam(w, at(s, 0, 0.02), at(s, 1.3 + ((s - 1.4) / (span - 1.4)) * 0.2, 0.16), 0.03, 0.03, false)
  }
}

/** 灯塔：收分的白塔、挑出的回廊、灯室（夜里发光）与小圆顶 */
function lighthouse(c: WCtx, p: P, g: number, r: number) {
  const { w } = c
  const look = c.kit.props.lighthouse
  const R = Math.max(3, r)
  const top = g + 21
  w.c = look.col
  w.face = look.face
  wallTube(w, p, R * 1.05, R * 0.95, g - 1.5, g + 3, 16)
  wallTube(w, p, R * 0.95, R * 0.62, g + 3, top, 16)
  // 回廊：挑出的平台与栏杆
  w.c = STONE
  w.face = MAT.plain
  ringUnder(w, p, R * 0.6, R * 0.95, top, 16)
  wallTube(w, p, R * 0.95, R * 0.95, top, top + 0.25, 16, { cap: true, capFace: MAT.paving })
  w.c = IRON
  wallTube(w, p, R * 0.92, R * 0.92, top + 0.95, top + 1.05, 16)
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2
    const q: P = [p[0] + Math.cos(a) * R * 0.92, p[1] + Math.sin(a) * R * 0.92]
    beam(w, [q[0], top + 0.25, q[1]], [q[0], top + 1.0, q[1]], 0.03, 0.03, false)
  }
  // 灯室：几根窗棂之间是发光的灯
  w.c = hex('#f1e2a8')
  w.face = MAT.lamp
  wallTube(w, p, R * 0.42, R * 0.42, top + 0.25, top + 2.5, 10)
  w.c = IRON
  w.face = MAT.plain
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2
    const q: P = [p[0] + Math.cos(a) * R * 0.45, p[1] + Math.sin(a) * R * 0.45]
    beam(w, [q[0], top + 0.25, q[1]], [q[0], top + 2.5, q[1]], 0.05, 0.05, false)
  }
  w.c = look.cap
  ringUnder(w, p, R * 0.3, R * 0.56, top + 2.5, 10)
  ball(w, [p[0], top + 2.5, p[1]], R * 0.56, 10, 3, 0, Math.PI / 2, 0.8)
  w.c = IRON
  beam(w, [p[0], top + 2.5 + R * 0.4, p[1]], [p[0], top + 3.4 + R * 0.45, p[1]], 0.04, 0.04)
}

/** 砖瓦窑：馒头形的窑体、窑顶的烟囱口、拱形的窑门（夜里透出火光） */
function kiln(c: WCtx, p: P, g: number, r: number) {
  const { w } = c
  const col = shade(hex('#8f5e46'), 0.9 + hash(p[0], p[1], 1) * 0.2)
  w.c = col
  w.face = MAT.brick
  wallTube(w, p, r * 1.02, r, g - 1, g + 1.5, 12)
  w.face = MAT.plain
  ball(w, [p[0], g + 1.5, p[1]], r, 12, 4, 0, Math.PI / 2, 0.82)
  // 烟囱口
  w.c = shade(col, 0.75)
  w.face = MAT.brick
  wallTube(w, p, 0.55, 0.5, g + 1.5 + r * 0.74, g + 1.5 + r * 0.82 + 0.9, 8)
  w.c = hex('#1c1a18')
  w.face = MAT.plain
  const yy = g + 1.5 + r * 0.82 + 0.86
  for (let k = 0; k < 8; k++) w.triOut([p[0], yy, p[1]], [p[0] + Math.cos((k / 8) * 6.2832) * 0.5, yy, p[1] + Math.sin((k / 8) * 6.2832) * 0.5], [p[0] + Math.cos(((k + 1) / 8) * 6.2832) * 0.5, yy, p[1] + Math.sin(((k + 1) / 8) * 6.2832) * 0.5], [0, 1, 0])
  // 窑门：凸出的门脸，拱洞里是火
  const f = axOf(p, hash(p[0], p[1], 2) * Math.PI * 2)
  const ff = { o: lp(f, r * 0.9, 0), u: f.u, v: f.v }
  w.c = shade(col, 0.85)
  w.face = MAT.brick
  box(w, ff, 0, 0.55, -0.85, 0.85, g - 0.5, g + 1.9)
  w.c = hex('#3a1c10')
  w.face = MAT.lamp
  box(w, ff, 0.55, 0.58, -0.4, 0.4, g, g + 1.15)
}

/** 绞刑台：木台、台阶，台上一副门形的绞架与绳套 */
function gallows(c: WCtx, f: Ax, g: number, hs: number) {
  const { w } = c
  const top = g + 1.5
  w.c = TIMBER_DARK
  w.face = MAT.plain
  for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const q = lp(f, s * (hs - 0.15), t * (hs - 0.15))
    beam(w, [q[0], g - 0.6, q[1]], [q[0], top, q[1]], 0.1, 0.1, false)
  }
  w.c = TIMBER
  w.face = MAT.plank
  w.uvOf = (p) => [(p[0] - f.o[0]) * f.u[0] + (p[2] - f.o[1]) * f.u[1], 0, 0]
  box(w, f, -hs, hs, -hs, hs, top - 0.14, top, { bottom: true })
  w.uvOf = null
  // 台阶
  w.face = MAT.board
  for (let k = 0; k < 5; k++) box(w, f, hs + k * 0.32, hs + (k + 1) * 0.32, -0.6, 0.6, g - 0.3, top - (k + 1) * 0.29, { bottom: true })
  // 绞架
  w.c = TIMBER_DARK
  w.face = MAT.plain
  const a = l3(f, -hs * 0.5, -hs * 0.7, top)
  const b = l3(f, -hs * 0.5, hs * 0.7, top)
  const up = (p: V3, y: number): V3 => [p[0], top + y, p[2]]
  beam(w, a, up(a, 3.3), 0.09, 0.09, false)
  beam(w, b, up(b, 3.3), 0.09, 0.09, false)
  beam(w, up(a, 3.3), up(b, 3.3), 0.09, 0.09)
  beam(w, up(a, 2.3), l3(f, -hs * 0.5, -hs * 0.7 + 1, top + 3.3), 0.05, 0.05, false)
  beam(w, up(b, 2.3), l3(f, -hs * 0.5, hs * 0.7 - 1, top + 3.3), 0.05, 0.05, false)
  w.c = hex('#8a7a5a')
  const m = l3(f, -hs * 0.5, 0, top + 3.25)
  beam(w, m, [m[0], top + 2.2, m[2]], 0.02, 0.02, false)
}

/** 传送门：两根石柱托着拱，拱里一面发光的门扉 */
function portal(c: WCtx, f: Ax, g: number, hs: number) {
  const { w } = c
  const hw = Math.max(1.6, hs * 0.8)
  const yb = g - 0.8
  const hole = placeArch(archOutline('pointed', hw - 0.55, 2.4 + (g - yb), 10), 0, yb)
  w.c = hex('#8f8a9c')
  w.face = MAT.stone
  const top = g + 2.4 + (hw - 0.55) * 1.25 + 0.9
  const th = 0.45
  for (const sg of [1, -1]) archFace(w, lp(f, 0, sg * th), f.u, -hw, hw, yb, () => top, [hole], [f.v[0] * sg, f.v[1] * sg])
  vault(w, lp(f, 0, -th), f.u, [f.v[0] * th * 2, f.v[1] * th * 2], hole)
  for (const sg of [1, -1]) w.quadOut(l3(f, sg * hw, -th, yb), l3(f, sg * hw, th, yb), l3(f, sg * hw, th, top), l3(f, sg * hw, -th, top), [f.u[0] * sg, 0, f.u[1] * sg])
  w.quadOut(l3(f, -hw, -th, top), l3(f, hw, -th, top), l3(f, hw, th, top), l3(f, -hw, th, top), [0, 1, 0])
  // 门扉：拱洞里一层发光的薄面（两面）
  w.c = hex('#9a7fe0')
  w.face = MAT.glow
  for (let i = 1; i + 2 < hole.length; i++) {
    const P3 = (k: number): V3 => l3(f, hole[k][0], 0, Math.max(g, hole[k][1]))
    for (const sg of [1, -1]) w.triOut(l3(f, 0, 0, g), P3(i), P3(i + 1), [f.v[0] * sg, 0, f.v[1] * sg])
  }
}

// —————————————————————— 地标点上的小品 ——————————————————————

/** 井、喷泉、雕像（石灯笼、石碑）、水车 */
export function landmarkProp(c: WCtx, l: Landmark) {
  const { w, H } = c
  const kit = c.kit.props
  const [x, z] = l.p
  if (l.kind !== 'well' && l.kind !== 'fountain' && l.kind !== 'statue' && l.kind !== 'mill') return
  w.at(x, z)
  const g = H(x, z)
  w.base = g - 0.6
  w.face = MAT.plain
  const h1 = hash(x, z, 1)
  const f = axOf(l.p, Math.floor(h1 * 4) * (Math.PI / 2) + (kit.skew ? h1 : 0))
  if (l.kind === 'well') return well(c, f, g)
  if (l.kind === 'fountain') return fountain(c, l.p, g)
  if (l.kind === 'mill') return waterwheel(c, l.p)
  // 雕像：文明自己的做法（石灯笼、石碑），否则是台座上的铜像
  if (kit.statue) return kit.statue(c, f, g)
  statue(c, f, g)
}

/** 井：井栏（圆的石井栏，或四块板围成的方井栏）、水面，井架与小顶 */
function well(c: WCtx, f: Ax, g: number) {
  const { w } = c
  const look = c.kit.props.well
  const p = f.o
  if (look.square) {
    // 方井栏：四块石板或木井桁
    w.c = look.col
    w.face = look.face
    for (const q of [0, 1, 2, 3]) {
      const ff = q % 2 ? { o: p, u: f.v, v: f.u } : f
      const sg = q < 2 ? 1 : -1
      box(w, ff, sg * 0.62 - 0.1, sg * 0.62 + 0.1, -0.78, 0.78, g - 0.4, g + 0.72)
    }
    w.c = hex('#27333a')
    w.face = MAT.pool
    w.quadOut(l3(f, -0.55, -0.55, g + 0.25), l3(f, 0.55, -0.55, g + 0.25), l3(f, 0.55, 0.55, g + 0.25), l3(f, -0.55, 0.55, g + 0.25), [0, 1, 0])
  } else {
    w.c = look.col
    w.face = look.face
    wallTube(w, p, 0.95, 0.9, g - 0.4, g + 0.8, 10)
    // 井栏顶与内壁
    w.face = MAT.plain
    for (let k = 0; k < 10; k++) {
      const a0 = (k / 10) * Math.PI * 2
      const a1 = ((k + 1) / 10) * Math.PI * 2
      const P3 = (a: number, r: number, y: number): V3 => [p[0] + Math.cos(a) * r, y, p[1] + Math.sin(a) * r]
      w.quadOut(P3(a0, 0.9, g + 0.8), P3(a1, 0.9, g + 0.8), P3(a1, 0.62, g + 0.8), P3(a0, 0.62, g + 0.8), [0, 1, 0])
      w.quadOut(P3(a0, 0.62, g + 0.2), P3(a1, 0.62, g + 0.2), P3(a1, 0.62, g + 0.8), P3(a0, 0.62, g + 0.8), [-Math.cos((a0 + a1) / 2), 0, -Math.sin((a0 + a1) / 2)])
    }
    w.c = hex('#27333a')
    w.face = MAT.pool
    for (let k = 0; k < 10; k++) w.triOut([p[0], g + 0.25, p[1]], [p[0] + Math.cos((k / 10) * 6.2832) * 0.62, g + 0.25, p[1] + Math.sin((k / 10) * 6.2832) * 0.62], [p[0] + Math.cos(((k + 1) / 10) * 6.2832) * 0.62, g + 0.25, p[1] + Math.sin(((k + 1) / 10) * 6.2832) * 0.62], [0, 1, 0])
  }
  // 井架：两柱一梁，梁上辘轳；小两坡顶
  w.c = TIMBER_DARK
  w.face = MAT.plain
  for (const sg of [-1, 1]) {
    const q = lp(f, 0, sg * 1.05)
    beam(w, [q[0], g - 0.4, q[1]], [q[0], g + 2.35, q[1]], 0.07, 0.07, false)
  }
  beam(w, l3(f, 0, -1.05, g + 1.75), l3(f, 0, 1.05, g + 1.75), 0.07, 0.07, false)
  beam(w, l3(f, 0, 0, g + 1.7), l3(f, 0, 0, g + 0.9), 0.015, 0.015, false)
  const col = look.roof
  w.c = col
  w.face = look.roofFace
  const A = 1.35
  const B = 0.8
  const yr = g + 2.75
  const ye = g + 2.3
  const P3 = (s: number, t: number, y: number): V3 => l3(f, s, t, y)
  for (const sg of [-1, 1]) w.slabQuad(P3(sg * B, -A, ye), P3(sg * B, A, ye), P3(0, A, yr), P3(0, -A, yr), 0.06, shade(col, 0.55))
}

/** 喷泉的水池：不给套件时的做法（大理石的圆池，中柱顶上带喷口） */
const FOUNTAIN = { sides: 16, kerb: 0.62, stone: MARBLE, rim: MARBLE, jet: true }

/** 喷泉：水池（池沿、水面）、中柱与上层的水盘；水池的形制按文明的沙盘套件（如贴地的八角浅池） */
function fountain(c: WCtx, p: P, g: number) {
  const { w } = c
  const look = c.kit.props.fountain ?? FOUNTAIN
  const R = 3.1
  const n = look.sides
  const kerb = look.kerb
  const stone = look.stone
  w.c = stone
  w.face = MAT.plain
  wallTube(w, p, R, R, g - 0.4, g + kerb, n)
  const P3 = (a: number, r: number, y: number): V3 => [p[0] + Math.cos(a) * r, y, p[1] + Math.sin(a) * r]
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2
    const a1 = ((k + 1) / n) * Math.PI * 2
    w.c = look.rim
    w.face = MAT.plain
    w.quadOut(P3(a0, R, g + kerb), P3(a1, R, g + kerb), P3(a1, R - 0.38, g + kerb), P3(a0, R - 0.38, g + kerb), [0, 1, 0])
    w.c = stone
    w.quadOut(P3(a0, R - 0.38, g + kerb - 0.3), P3(a1, R - 0.38, g + kerb - 0.3), P3(a1, R - 0.38, g + kerb), P3(a0, R - 0.38, g + kerb), [-Math.cos((a0 + a1) / 2), 0, -Math.sin((a0 + a1) / 2)])
    w.c = hex('#3f6f7c')
    w.face = MAT.pool
    w.triOut([p[0], g + kerb - 0.18, p[1]], P3(a0, R - 0.38, g + kerb - 0.18), P3(a1, R - 0.38, g + kerb - 0.18), [0, 1, 0])
  }
  // 中柱与水盘
  w.c = stone
  w.face = MAT.plain
  wallTube(w, p, 0.42, 0.3, g, g + 1.5, 8)
  wallTube(w, p, 0.3, 1.15, g + 1.5, g + 1.8, 10)
  wallTube(w, p, 1.15, 1.15, g + 1.8, g + 1.9, 10)
  w.c = hex('#3f6f7c')
  w.face = MAT.pool
  for (let k = 0; k < 10; k++) w.triOut([p[0], g + 1.86, p[1]], P3((k / 10) * 6.2832, 1.05, g + 1.86), P3(((k + 1) / 10) * 6.2832, 1.05, g + 1.86), [0, 1, 0])
  w.c = stone
  w.face = MAT.plain
  for (let k = 0; k < 10; k++) w.quadOut(P3((k / 10) * 6.2832, 1.05, g + 1.9), P3(((k + 1) / 10) * 6.2832, 1.05, g + 1.9), P3(((k + 1) / 10) * 6.2832, 1.15, g + 1.9), P3((k / 10) * 6.2832, 1.15, g + 1.9), [0, 1, 0])
  if (!look.jet) return
  wallTube(w, p, 0.16, 0.12, g + 1.8, g + 2.6, 6)
  ball(w, [p[0], g + 2.7, p[1]], 0.2, 6, 3, -Math.PI / 2, Math.PI / 2)
}

/** 雕像：石台座（座脚、座身、檐口）上的铜像 */
function statue(c: WCtx, f: Ax, g: number) {
  const { w } = c
  const p = f.o
  w.c = MARBLE
  w.face = MAT.stone
  cbox(w, f, 0.95, 0.95, g - 0.4, g + 0.3)
  cbox(w, f, 0.7, 0.7, g + 0.3, g + 1.75)
  w.face = MAT.plain
  cbox(w, f, 0.82, 0.82, g + 1.75, g + 1.93)
  // 铜像：袍身、躯干、头，一臂前伸
  const y = g + 1.93
  w.c = shade(COPPER, 0.8)
  wallTube(w, p, 0.3, 0.2, y, y + 1.0, 7)
  wallTube(w, p, 0.2, 0.27, y + 1.0, y + 1.62, 7)
  wallTube(w, p, 0.27, 0.1, y + 1.62, y + 1.74, 7)
  ball(w, [p[0], y + 1.92, p[1]], 0.17, 7, 4, -Math.PI / 2, Math.PI / 2)
  beam(w, l3(f, 0, 0.26, y + 1.55), l3(f, 0.5, 0.36, y + 1.75), 0.055, 0.055)
  beam(w, l3(f, 0, -0.26, y + 1.55), l3(f, 0.08, -0.3, y + 0.95), 0.055, 0.055)
}

/** 水车：立在岸边、半浸水里的轮（轮辋、辐条、叶板），轴伸向岸上的磨坊 */
function waterwheel(c: WCtx, p: P) {
  const { w, st } = c
  // 轮面顺着水流：取最近的河道段的走向
  let dir: P = [1, 0]
  if (st.river) {
    let bd = Infinity
    for (let i = 0; i + 1 < st.river.line.length; i++) {
      const a = st.river.line[i]
      const b = st.river.line[i + 1]
      const d = Math.hypot((a[0] + b[0]) / 2 - p[0], (a[1] + b[1]) / 2 - p[1])
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (d < bd && L > 1e-3) {
        bd = d
        dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
      }
    }
  }
  let f = axUV(p, dir)
  // 岸在哪一侧：水更浅（到水距离更大）的一侧
  const side = c.water(p[0] + f.v[0] * 3, p[1] + f.v[1] * 3) > c.water(p[0] - f.v[0] * 3, p[1] - f.v[1] * 3) ? 1 : -1
  // 地标点落在河岸线上：轮往水里挪到够深的地方（沙盘的岸线比河道的名义宽度靠里），轴相应加长
  let shift = 0
  while (shift < 9 && c.water(p[0] - f.v[0] * side * shift, p[1] - f.v[1] * side * shift) > -1.6) shift += 0.5
  f = axUV([p[0] - f.v[0] * side * shift, p[1] - f.v[1] * side * shift], dir)
  w.at(f.o[0], f.o[1])
  const R = 2.7
  const yc = 1.25
  const hwid = 0.5
  const n = 14
  w.base = -1
  const P3 = (a: number, r: number, t: number): V3 => l3(f, Math.cos(a) * r, t, yc + Math.sin(a) * r)
  const rdir = (a: number, k: number): V3 => [f.u[0] * Math.cos(a) * k, Math.sin(a) * k, f.u[1] * Math.cos(a) * k]
  w.c = TIMBER_DARK
  w.face = MAT.plain
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2
    const a1 = ((k + 1) / n) * Math.PI * 2
    const am = (a0 + a1) / 2
    // 两道轮辋：外缘、内缘与两个侧面
    for (const t of [-hwid, hwid]) {
      const t0 = t - 0.07
      const t1 = t + 0.07
      w.quadOut(P3(a0, R, t0), P3(a1, R, t0), P3(a1, R, t1), P3(a0, R, t1), rdir(am, 1))
      w.quadOut(P3(a0, R - 0.3, t0), P3(a1, R - 0.3, t0), P3(a1, R - 0.3, t1), P3(a0, R - 0.3, t1), rdir(am, -1))
      w.quadOut(P3(a0, R - 0.3, t0), P3(a1, R - 0.3, t0), P3(a1, R, t0), P3(a0, R, t0), [-f.v[0], 0, -f.v[1]])
      w.quadOut(P3(a0, R - 0.3, t1), P3(a1, R - 0.3, t1), P3(a1, R, t1), P3(a0, R, t1), [f.v[0], 0, f.v[1]])
    }
    // 叶板：两道轮辋之间的一块板（两面）
    const tn: V3 = [-f.u[0] * Math.sin(a0), Math.cos(a0), -f.u[1] * Math.sin(a0)]
    w.c = TIMBER
    w.quadOut(P3(a0, R - 0.42, -hwid), P3(a0, R + 0.12, -hwid), P3(a0, R + 0.12, hwid), P3(a0, R - 0.42, hwid), tn)
    w.quadOut(P3(a0, R - 0.42, -hwid), P3(a0, R + 0.12, -hwid), P3(a0, R + 0.12, hwid), P3(a0, R - 0.42, hwid), [-tn[0], -tn[1], -tn[2]])
    w.c = TIMBER_DARK
  }
  // 辐条与轴
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI + 0.3
    for (const t of [-hwid, hwid]) beam(w, P3(a, R - 0.15, t), P3(a + Math.PI, R - 0.15, t), 0.06, 0.05, false)
  }
  beam(w, l3(f, 0, -side * (hwid + 0.5), yc), l3(f, 0, side * (hwid + 3.2 + shift), yc), 0.13, 0.13)
  // 轴靠岸一侧的支架
  if (shift > 2) {
    const s2 = lp(f, 0, side * (hwid + 0.5))
    for (const s of [-0.7, 0.7]) beam(w, [s2[0] + f.u[0] * s, -2.5, s2[1] + f.u[1] * s], [s2[0], yc + 0.1, s2[1]], 0.09, 0.09, false)
  }
  // 靠河一侧的支架
  const q = lp(f, 0, -side * (hwid + 0.4))
  for (const s of [-0.7, 0.7]) beam(w, [q[0] + f.u[0] * s, -2.5, q[1] + f.u[1] * s], [q[0], yc + 0.1, q[1]], 0.09, 0.09, false)
}

// —————————————————————— 园林、奇观、田野 ——————————————————————

/** 置石、草垛：不给套件时的做法 */
const ROCK = { base: 0.6, vary: 0.6, col: hex('#8f8c84') }
const HAYSTACK = { foot: 0.85, body: 1.1, top: 2.1 }

/** 置石、假山石：由平面轮廓拉起的不规则石块（顶面内收、高低不一），岩石材质 */
export function rock(c: WCtx, q: ParkPart) {
  const { w, H } = c
  const look = c.kit.props.rock ?? ROCK
  const ct = centroid(q.poly)
  const n = q.poly.length
  if (n < 3) return
  let r = 0
  for (const p of q.poly) r = Math.max(r, Math.hypot(p[0] - ct[0], p[1] - ct[1]))
  w.at(ct[0], ct[1])
  const g = H(ct[0], ct[1])
  w.base = g - 0.6
  const h1 = hash(ct[0], ct[1], 1)
  // 高矮与石色随文明（太湖石偏高瘦，和式的石矮而稳）
  const hgt = r * (look.base + h1 * look.vary)
  w.c = shade(look.col, 0.85 + hash(ct[0], ct[1], 2) * 0.3)
  w.face = MAT.rock
  // 四层：底、腰（略外鼓）、肩（内收、偏心）、顶；各顶点再各自进出一些，面不平滑（石头的棱面）
  const off: P = [(hash(ct[0], ct[1], 3) - 0.5) * r * 0.6, (hash(ct[0], ct[1], 4) - 0.5) * r * 0.6]
  const ringAt = (lv: number, k: number, y: number, ox: number, oz: number): V3[] =>
    q.poly.map((p, i) => {
      const j = 0.72 + hash(p[0] + lv * 3.1, p[1], 5 + i) * 0.56
      return [ct[0] + ox + (p[0] - ct[0]) * k * j, y + (hash(p[1], p[0] + lv, 7 + i) - 0.5) * hgt * 0.16, ct[1] + oz + (p[1] - ct[1]) * k * j]
    })
  const rows = [ringAt(0, 1.0, g - 0.4, 0, 0), ringAt(1, 1.08, g + hgt * 0.34, off[0] * 0.3, off[1] * 0.3), ringAt(2, 0.7, g + hgt * 0.74, off[0], off[1]), ringAt(3, 0.22, g + hgt, off[0] * 1.25, off[1] * 1.25)]
  const mid: V3 = [ct[0] + off[0] * 0.5, g + hgt * 0.4, ct[1] + off[1] * 0.5]
  for (let i = 0; i + 1 < rows.length; i++)
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n
      const a = rows[i][j]
      const b = rows[i][k]
      const c2 = rows[i + 1][k]
      const d = rows[i + 1][j]
      // 四边形不共面：拆成两个三角形，各按自己的朝向
      w.triOut(a, b, c2, [(a[0] + b[0] + c2[0]) / 3 - mid[0], (a[1] + b[1] + c2[1]) / 3 - mid[1], (a[2] + b[2] + c2[2]) / 3 - mid[2]])
      w.triOut(a, c2, d, [(a[0] + c2[0] + d[0]) / 3 - mid[0], (a[1] + c2[1] + d[1]) / 3 - mid[1], (a[2] + c2[2] + d[2]) / 3 - mid[2]])
    }
  const top = rows[3]
  for (let i = 1; i + 1 < top.length; i++) w.triOut(top[0], top[i], top[i + 1], [0, 1, 0])
}

/** 奇观：法阵（地上的光环与七芒星、一圈晶柱）、灵泉、浮空岛、灵脉沿线的晶簇 */
export function wonder(c: WCtx, x: Settlement['wonders'][number], magic: RGB) {
  const { w, H } = c
  const [px, pz] = x.p
  w.at(px, pz)
  w.base = H(px, pz) - 0.6
  const glow = mixRGB(magic, hex('#c9b8ff'), 0.45)
  // 贴地的光带：沿 a → b 每几米取一次地面高
  const strip = (a: P, b: P, hw: number) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    const m = Math.max(1, Math.ceil(L / 5))
    const nx = (-(b[1] - a[1]) / (L || 1)) * hw
    const nz = ((b[0] - a[0]) / (L || 1)) * hw
    for (let i = 0; i < m; i++) {
      const p0: P = [a[0] + ((b[0] - a[0]) * i) / m, a[1] + ((b[1] - a[1]) * i) / m]
      const p1: P = [a[0] + ((b[0] - a[0]) * (i + 1)) / m, a[1] + ((b[1] - a[1]) * (i + 1)) / m]
      const y0 = H(p0[0], p0[1]) + 0.1
      const y1 = H(p1[0], p1[1]) + 0.1
      w.quadOut([p0[0] - nx, y0, p0[1] - nz], [p0[0] + nx, y0, p0[1] + nz], [p1[0] + nx, y1, p1[1] + nz], [p1[0] - nx, y1, p1[1] - nz], [0, 1, 0])
    }
  }
  const crystal = (p: P, h: number, r: number, lean: P) => {
    const g = H(p[0], p[1])
    const top: V3 = [p[0] + lean[0], g + h, p[1] + lean[1]]
    const f = axOf(p, hash(p[0], p[1], 3) * 3)
    const mid = [l3(f, -r, -r, g + h * 0.55), l3(f, r, -r, g + h * 0.55), l3(f, r, r, g + h * 0.55), l3(f, -r, r, g + h * 0.55)]
    const bot = [l3(f, -r * 0.6, -r * 0.6, g - 0.3), l3(f, r * 0.6, -r * 0.6, g - 0.3), l3(f, r * 0.6, r * 0.6, g - 0.3), l3(f, -r * 0.6, r * 0.6, g - 0.3)]
    const outs: V3[] = [
      [-f.v[0], 0, -f.v[1]],
      [f.u[0], 0, f.u[1]],
      [f.v[0], 0, f.v[1]],
      [-f.u[0], 0, -f.u[1]],
    ]
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      w.quadOut(bot[i], bot[j], mid[j], mid[i], outs[i])
      w.triOut(mid[i], mid[j], top, [outs[i][0], 0.3, outs[i][2]])
    }
  }
  if (x.kind === 'circle') {
    const R = x.r
    w.c = glow
    w.face = MAT.glow
    const n = Math.max(20, Math.round(R * 1.6))
    const pt = (a: number, r: number): P => [px + Math.cos(a) * r, pz + Math.sin(a) * r]
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2
      const a1 = ((i + 1) / n) * Math.PI * 2
      strip(pt(a0, R), pt(a1, R), 0.14)
      strip(pt(a0, R * 0.86), pt(a1, R * 0.86), 0.09)
    }
    // 七芒星
    const star: P[] = []
    for (let k = 0; k < 7; k++) star.push(pt(-Math.PI / 2 + ((k * 3) % 7) * ((Math.PI * 2) / 7), R * 0.86))
    for (let k = 0; k < 7; k++) strip(star[k], star[(k + 1) % 7], 0.08)
    // 一圈立石，石顶嵌着发光的晶
    for (let k = 0; k < 7; k++) {
      const q = pt(-Math.PI / 2 + (k / 7) * Math.PI * 2, R * 1.08)
      const g = H(q[0], q[1])
      w.at(q[0], q[1])
      w.c = hex('#77738a')
      w.face = MAT.rock
      const f = axUV(q, [Math.cos((k / 7) * Math.PI * 2 - Math.PI / 2), Math.sin((k / 7) * Math.PI * 2 - Math.PI / 2)])
      cbox(w, f, 0.3, 0.45, g - 0.5, g + 2.3 + hash(q[0], q[1], 1) * 0.6, { inset: 0.08 })
      w.c = glow
      w.face = MAT.glow
      crystal(q, 3.4 + hash(q[0], q[1], 1) * 0.6, 0.12, [0, 0])
    }
    return
  }
  if (x.kind === 'spring') {
    const R = x.r
    const g = H(px, pz)
    // 池沿一圈石，池心发光的水
    w.c = hex('#8f8c84')
    w.face = MAT.rock
    const n = 14
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2
      const q: P = [px + Math.cos(a) * R, pz + Math.sin(a) * R]
      const s = 0.5 + hash(q[0], q[1], 1) * 0.5
      const f = axOf(q, a + hash(q[0], q[1], 2))
      cbox(w, f, s, s * 1.3, H(q[0], q[1]) - 0.4, H(q[0], q[1]) + 0.3 + s * 0.6, { inset: s * 0.3 })
    }
    w.c = mixRGB(hex('#6fd0d8'), glow, 0.35)
    w.face = MAT.glow
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2
      const a1 = ((k + 1) / n) * Math.PI * 2
      w.triOut([px, g + 0.16, pz], [px + Math.cos(a0) * R, g + 0.16, pz + Math.sin(a0) * R], [px + Math.cos(a1) * R, g + 0.16, pz + Math.sin(a1) * R], [0, 1, 0])
    }
    return
  }
  if (x.kind === 'isle') {
    // 浮空岛：草顶、倒锥的岩体，岛上一座小塔；岛的轮廓同二维的画法
    const R = x.r
    const g = H(px, pz)
    const y = g + 26 + R * 0.9
    w.base = y - R * 1.6
    const n = 20
    const rim: V3[] = []
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2
      const rr = R * (1 + 0.16 * Math.sin(a * 3 + 1) + 0.08 * Math.sin(a * 7 + 2))
      rim.push([px + Math.cos(a) * rr, y + Math.sin(a * 2 + 1) * R * 0.03, pz + Math.sin(a) * rr * 0.8])
    }
    w.c = hex('#7d9455')
    w.face = MAT.straw
    for (let k = 0; k < n; k++) w.triOut([px, y + R * 0.08, pz], rim[k], rim[k + 1], [0, 1, 0])
    w.c = hex('#7b756c')
    w.face = MAT.rock
    const ring = (k: number, dy: number, sx: number, sz: number): V3[] => rim.map((p, i) => [px + sx + (p[0] - px) * k * (0.9 + hash(i, k * 7, 3) * 0.2), y + dy, pz + sz + (p[2] - pz) * k * (0.9 + hash(i, k * 5, 4) * 0.2)])
    loft(w, [rim, ring(0.82, -R * 0.35, 0, 0), ring(0.45, -R * 0.9, R * 0.1, -R * 0.05), ring(0.06, -R * 1.5, R * 0.16, -R * 0.1)], [px, y - R * 0.5, pz])
    // 岛下悬着的碎石
    for (let k = 0; k < 3; k++) {
      const a = k * 2.1 + 0.5
      const q: V3 = [px + Math.cos(a) * R * 0.55, y - R * (1.2 + k * 0.25), pz + Math.sin(a) * R * 0.4]
      const s = R * (0.07 + k * 0.02)
      const f = axOf([q[0], q[2]], a)
      box(w, f, -s, s, -s, s, q[1] - s, q[1] + s, { inset: s * 0.35, bottom: true })
    }
    // 岛上的塔
    w.c = hex('#cfc7e6')
    w.face = MAT.plaster
    const tr = R * 0.15
    wallTube(w, [px, pz], tr * 1.1, tr * 0.85, y, y + tr * 6, 10)
    w.c = hex('#5a4a8a')
    w.face = MAT.slate
    ringUnder(w, [px, pz], tr * 0.8, tr * 1.3, y + tr * 6, 10)
    wallTube(w, [px, pz], tr * 1.3, 0, y + tr * 6, y + tr * 8.6, 10)
    w.c = glow
    w.face = MAT.glow
    w.at(px, pz)
    const cy = y - R * 1.55
    for (const s of [1, -1]) w.triOut([px + R * 0.16 - 0.5, cy, pz - R * 0.1], [px + R * 0.16 + 0.5, cy, pz - R * 0.1], [px + R * 0.16, cy - 2.2, pz - R * 0.1], [0, 0, s])
    return
  }
  if (x.kind === 'leyline' && x.line) {
    // 灵脉：沿线每隔一段从地里冒出一簇发光的晶
    w.c = glow
    w.face = MAT.glow
    let acc = 20
    for (let i = 0; i + 1 < x.line.length; i++) {
      const a = x.line[i]
      const b = x.line[i + 1]
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      acc += L
      if (acc < 46) continue
      acc = 0
      const q: P = [a[0] + (hash(a[0], a[1], 1) - 0.5) * 6, a[1] + (hash(a[0], a[1], 2) - 0.5) * 6]
      if (q[0] < 4 || q[1] < 4 || q[0] > c.st.width - 4 || q[1] > c.st.height - 4 || c.water(q[0], q[1]) < 1.5) continue
      if (c.road(q, 4)) continue
      w.at(q[0], q[1])
      w.base = H(q[0], q[1]) - 0.6
      for (let k = 0; k < 3; k++) {
        const h = 0.9 + hash(q[0], q[1], 3 + k) * 1.4
        const d: P = [(hash(q[0], q[1], 6 + k) - 0.5) * 1.2, (hash(q[0], q[1], 9 + k) - 0.5) * 1.2]
        crystal([q[0] + d[0], q[1] + d[1]], h, 0.14 + h * 0.06, [d[0] * 0.5, d[1] * 0.5])
      }
    }
  }
}

/** 田里的草垛：收过的大田与草甸上零星的几个（圆垛，草顶收尖） */
export function fieldProps(c: WCtx, fd: Field) {
  const { w, H, st } = c
  const stack = c.kit.props.haystack ?? HAYSTACK
  if (fd.kind !== 'crop' && fd.kind !== 'meadow') return
  const ct = centroid(fd.poly)
  if (hash(ct[0], ct[1], 1) > (fd.kind === 'meadow' ? 0.5 : 0.22)) return
  const a = area(fd.poly)
  if (a < 500) return
  const n = Math.min(4, 1 + Math.floor(a / 2500))
  const o = obb(fd.poly)
  for (let k = 0; k < n; k++) {
    const q: P = [ct[0] + o.axis[0] * (hash(ct[0], ct[1], 2 + k) - 0.5) * o.len * 0.5 - o.axis[1] * (hash(ct[0], ct[1], 6 + k) - 0.5) * o.wid * 0.5, ct[1] + o.axis[1] * (hash(ct[0], ct[1], 2 + k) - 0.5) * o.len * 0.5 + o.axis[0] * (hash(ct[0], ct[1], 6 + k) - 0.5) * o.wid * 0.5]
    if (q[0] < 3 || q[1] < 3 || q[0] > st.width - 3 || q[1] > st.height - 3 || !pointInPoly(q, fd.poly) || c.road(q, 3)) continue
    const g = H(q[0], q[1])
    const r = 1.3 + hash(q[0], q[1], 1) * 0.7
    w.at(q[0], q[1])
    w.base = g - 0.6
    w.c = shade(STRAW, 0.85 + hash(q[0], q[1], 2) * 0.25)
    w.face = MAT.straw
    // 垛身与收尖的垛顶：高矮随文明（稻架、草堆矮而圆）
    wallTube(w, q, r * stack.foot, r, g - 0.3, g + r * stack.body, 8)
    wallTube(w, q, r, 0, g + r * stack.body, g + r * stack.top, 8)
  }
}
