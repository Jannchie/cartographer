/**
 * 城防：城墙（墙身、步道、女墙与雉堞、木栅）、塔楼（圆塔、马面与敌楼、橹、方塔、望楼）、水门，以及院墙。
 * 城门见 gates.ts，桥见 bridges.ts。纯函数，在 Worker 中运行。
 *
 * 城墙沿墙圈的实心段连成一段段"墙段"（城门处、临水处断开），每段按几米一站放样截面：
 * 转角斜接，墙顶随地形起伏，墙脚埋入地下，不留缝。墙圈统一成"左手法线朝外"的走向，截面的正偏移就是城外一侧。
 */
import { pointInPoly, signedArea, type P } from '../../settlement/geom'
import type { Settlement, Wall } from '../../settlement/types'
import { MAT, hip, mixRGB, shade, type Frame, type RGB } from './mesh'
import { STONE, TILE_DARK, TIMBER, TIMBER_DARK, hex, type Ctx, type Height } from './shared'
import { LO, archFace, archOutline, axUV, beam, box, cbox, crenels, hash, l3, lp, placeArch, pyramid, ringUnder, stationsOf, sweep, tube, vault, type Ax, type Station } from './worksMesh'
import { gate } from './gates'
import type { TownKit } from './kits'

/** 构筑物的上下文：在建筑的上下文之外，另带聚落本身、到水距离与路网查询 */
export interface WCtx extends Ctx {
  st: Settlement
  /** 到水体的有向距离（米，水中为负） */
  water: Height
  /** 离 p 最近的道路：距离（到中线）、垂足、路宽与走向；reach 米内没有路返回 null */
  road: (p: P, reach: number) => { d: number; q: P; width: number; dir: P } | null
}

/** 路网的线段网格（查最近的路） */
export function roadIndex(st: Settlement): WCtx['road'] {
  const cell = 24
  const grid = new Map<number, number[]>()
  const segs: { a: P; b: P; width: number }[] = []
  for (const r of st.roads) {
    for (let i = 0; i + 1 < r.line.length; i++) {
      const a = r.line[i]
      const b = r.line[i + 1]
      const id = segs.length
      segs.push({ a, b, width: r.width })
      for (let y = Math.floor(Math.min(a[1], b[1]) / cell); y <= Math.floor(Math.max(a[1], b[1]) / cell); y++)
        for (let x = Math.floor(Math.min(a[0], b[0]) / cell); x <= Math.floor(Math.max(a[0], b[0]) / cell); x++) {
          const k = y * 65536 + x
          const l = grid.get(k)
          if (l) l.push(id)
          else grid.set(k, [id])
        }
    }
  }
  return (p, reach) => {
    let best: { d: number; q: P; width: number; dir: P } | null = null
    const r = Math.ceil(reach / cell)
    const cx = Math.floor(p[0] / cell)
    const cy = Math.floor(p[1] / cell)
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        for (const id of grid.get(y * 65536 + x) ?? []) {
          const { a, b, width } = segs[id]
          const dx = b[0] - a[0]
          const dz = b[1] - a[1]
          const L2 = dx * dx + dz * dz || 1
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2))
          const q: P = [a[0] + dx * t, a[1] + dz * t]
          const d = Math.hypot(p[0] - q[0], p[1] - q[1])
          if (d <= reach && (!best || d < best.d)) {
            const L = Math.sqrt(L2)
            best = { d, q, width, dir: [dx / L, dz / L] }
          }
        }
    return best
  }
}

/** 一道墙的形制：石墙按文明的沙盘套件（WallKit.stone）与墙厚定，木栅各文明相同 */
export interface WallLook {
  stone: boolean
  /** 墙厚的一半、墙顶步道的高度（相对地面） */
  half: number
  hgt: number
  col: RGB
  face: number
  /** 墙脚每侧放出的收分 */
  batter: number
  /** 外侧女墙的实心高度、垛高、垛长、垛口宽、女墙厚；内侧女墙高（0 不设） */
  parapet: number
  merlon: number
  mLen: number
  mGap: number
  pT: number
  mCap: 'flat' | 'point'
  inner: number
  /** 铺面色（步道、台面） */
  pave: RGB
  /** 按墙厚定的尺度系数（城门、塔楼跟着缩放） */
  s: number
  /** 城门沿墙的半宽：墙段在离门心这么远处收住（略伸进门楼里） */
  gateHalf: number
  /** 水门的拱形 */
  arch: 'round' | 'pointed'
  /** 墙顶代替女墙与雉堞的做法（石垣上的土塀）：有它时墙顶不设女墙 */
  crown?(c: WCtx, look: WallLook, sts: Station[], caps: boolean): void
  /** 女墙之外的添饰（墙顶外沿挑出的砖檐） */
  trim?(c: WCtx, look: WallLook, sts: Station[]): void
}

/** 石墙形制里由文明给出的部分（女墙厚与垛形不给时用通用值） */
export type StoneWall = Omit<WallLook, 'stone' | 'half' | 's' | 'pT' | 'mCap'> & Partial<Pick<WallLook, 'pT' | 'mCap'>>

const SLATE = hex('#5f6370')

export function wallLook(kit: TownKit, wall: Wall): WallLook {
  const stone = wall.kind === 'stone'
  const th = wall.thickness
  const s = Math.max(0.7, Math.min(1.1, th / 4.5))
  const k = Math.max(0.72, Math.min(1.05, 0.55 + th * 0.1))
  const base = { stone, half: th / 2, s, pT: 0.5, mCap: 'flat' as const }
  if (!stone) return { ...base, hgt: 4.2, col: TIMBER, face: MAT.board, batter: 0, parapet: 0, merlon: 0, mLen: 0, mGap: 0, inner: 0, pave: TIMBER, gateHalf: 2.7, arch: 'round' }
  return { ...base, ...kit.wall.stone(k, s) }
}

/** 一段连续的墙（开口的折线，或整圈闭合）；g0 / g1：起点、终点是城门 */
interface Run {
  pts: P[]
  closed: boolean
  g0: boolean
  g1: boolean
}

/** 折线的一头截掉 d 米（不足则返回空） */
function trim(pts: P[], d: number, fromStart: boolean): P[] {
  const line = fromStart ? pts : [...pts].reverse()
  let left = d
  for (let i = 0; i + 1 < line.length; i++) {
    const L = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1])
    if (L > left) {
      const t = left / L
      const out: P[] = [[line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t], ...line.slice(i + 1)]
      return fromStart ? out : out.reverse()
    }
    left -= L
  }
  return []
}

/** 墙圈统一成左手法线朝外的走向（面积为负的绕向），solid 随之重排 */
function outwardLoop(wall: Wall): { loop: P[]; solid: boolean[] } {
  const n = wall.loop.length
  if (signedArea(wall.loop) <= 0) return { loop: wall.loop, solid: wall.solid }
  return { loop: [...wall.loop].reverse(), solid: wall.loop.map((_, j) => wall.solid[(2 * n - 2 - j) % n]) }
}

/** 城墙：墙段、塔楼、水门与城门 */
export function cityWall(c: WCtx, wall: Wall) {
  const { w, kit } = c
  const n = wall.loop.length
  if (n < 2) return
  const look = wallLook(kit, wall)
  const { loop, solid } = outwardLoop(wall)
  const isGate = (p: P) => wall.gates.some((g) => Math.hypot(g.p[0] - p[0], g.p[1] - p[1]) < 0.5)
  w.roofFace = kit.wall.roofFace
  w.gableFace = kit.wall.gableFace ?? look.face

  // —— 墙段 ——
  const runs: Run[] = []
  const breakAt = (i: number) => isGate(loop[i]) || !solid[i] || !solid[(i - 1 + n) % n]
  let start = -1
  for (let i = 0; i < n; i++)
    if (breakAt(i)) {
      start = i
      break
    }
  if (start < 0) runs.push({ pts: [...loop], closed: true, g0: false, g1: false })
  else {
    let cur: P[] = []
    let g0 = false
    const flush = (g1: boolean) => {
      if (cur.length > 1) runs.push({ pts: cur, closed: false, g0, g1 })
      cur = []
    }
    for (let k = 0; k < n; k++) {
      const e = (start + k) % n
      if (!solid[e]) {
        flush(false)
        continue
      }
      if (!cur.length) {
        cur = [loop[e]]
        g0 = isGate(loop[e])
      }
      const nx = loop[(e + 1) % n]
      cur.push(nx)
      if (isGate(nx)) flush(true)
    }
    flush(false)
  }
  const cut = look.gateHalf - (look.stone ? 0.7 : 0.1)
  // 木栅很长时原木放粗放疏（三角形预算）
  let palLen = 0
  if (!look.stone) for (const r of runs) for (let i = 0; i + 1 < r.pts.length; i++) palLen += Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1])
  for (const r of runs) {
    let pts = r.pts
    if (r.g0) pts = trim(pts, cut, true)
    if (r.g1 && pts.length) pts = trim(pts, cut, false)
    if (pts.length < 2) continue
    if (look.stone) stoneRun(c, look, pts, r.closed)
    else palisadeRun(c, pts, r.closed, palLen > 1400 ? 0.56 : 0.42)
  }

  // —— 水门：墙过窄水处，墙身架拱跨过去 ——
  if (look.stone && start >= 0) {
    for (let k = 0; k < n; k++) {
      const e = (start + k) % n
      if (solid[e] || !solid[(e - 1 + n) % n]) continue
      // 连续的不实心段 e ~ j − 1，两头都接着实心墙
      let j = e
      while (!solid[j % n] && j - e < n) j++
      if (!solid[j % n]) {
        const a = loop[e]
        const b = loop[j % n]
        const L = Math.hypot(b[0] - a[0], b[1] - a[1])
        const mid: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        if (L > 3 && L < 64 && c.water(mid[0], mid[1]) < 0 && !isGate(a) && !isGate(b)) waterGate(c, look, a, b)
      }
    }
  }

  // —— 塔楼 ——
  const towerR = wall.thickness * (look.stone ? 1.25 : 1.3)
  const roofed = hash(loop[0][0], loop[0][1], 3) < 0.6
  // 城门自带塔楼与城台：门两侧这段距离内的墙塔去掉，塔与塔之间也不得相互穿插
  // 城门（连同自带的塔、城台）沿墙伸出约 9.2·s（西式门塔外缘、伊斯兰方塔外缘），木栅寨门约 3.5 米
  // 墙塔与门塔之间至少留出一段墙（0.6 倍塔半径再加 3 米），否则两座圆塔挤在一起
  const gateClear = (look.stone ? 9.6 * look.s : 3.5) + towerR * 1.6 + 3
  const kept: P[] = []
  for (const t of wall.towers) {
    if (wall.gates.some((g) => Math.hypot(g.p[0] - t[0], g.p[1] - t[1]) < gateClear)) continue
    if (kept.some((q) => Math.hypot(q[0] - t[0], q[1] - t[1]) < towerR * 2.4 + 1)) continue
    kept.push(t)
    // 所在的墙段：切线与朝外的方向
    let best = 0
    let bd = Infinity
    for (let i = 0; i < n; i++) {
      const a = loop[i]
      const b = loop[(i + 1) % n]
      const dx = b[0] - a[0]
      const dz = b[1] - a[1]
      const L2 = dx * dx + dz * dz
      if (L2 < 1e-6) continue
      const u = Math.max(0, Math.min(1, ((t[0] - a[0]) * dx + (t[1] - a[1]) * dz) / L2))
      // 实心的墙段优先（断口处的塔跟着有墙的那一段）
      const d = Math.hypot(t[0] - a[0] - dx * u, t[1] - a[1] - dz * u) + (solid[i] ? 0 : 3)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    const a = loop[best]
    const b = loop[(best + 1) % n]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const tan: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    // 框：u 朝城外，v 沿墙
    const f = axUV(t, [-tan[1], tan[0]])
    w.at(t[0], t[1])
    tower(c, look, f, towerR, roofed)
  }

  // —— 城门 ——
  for (const g of wall.gates) {
    let i = 0
    for (let k = 1; k < n; k++) if (Math.hypot(loop[k][0] - g.p[0], loop[k][1] - g.p[1]) < Math.hypot(loop[i][0] - g.p[0], loop[i][1] - g.p[1])) i = k
    // 城门处的墙向：前后各找一个隔开几米的点
    const far = (dir: number): P => {
      for (let k = 1; k < n; k++) {
        const q = loop[(((i + dir * k) % n) + n) % n]
        if (Math.hypot(q[0] - g.p[0], q[1] - g.p[1]) > 4) return q
      }
      return loop[(((i + dir) % n) + n) % n]
    }
    const p0 = far(-1)
    const p1 = far(1)
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1
    const out: P = [-(p1[1] - p0[1]) / L, (p1[0] - p0[0]) / L]
    // 门道顺着穿门的路；路斜穿得厉害时折中（门楼不至于与墙身错开太多）
    let r: P = [Math.cos(g.angle), Math.sin(g.angle)]
    let dot = r[0] * out[0] + r[1] * out[1]
    if (dot < 0) {
      r = [-r[0], -r[1]]
      dot = -dot
    }
    let u: P = r
    if (dot < 0.92) {
      const k = dot < 0.5 ? 0 : 0.5
      const m = Math.hypot(out[0] + r[0] * k, out[1] + r[1] * k) || 1
      u = [(out[0] + r[0] * k) / m, (out[1] + r[1] * k) / m]
    }
    w.at(g.p[0], g.p[1])
    gate(c, look, axUV(g.p, u))
  }
}

/** 石墙的一段：墙身（带收分）、步道、外侧女墙与雉堞、内侧女墙；形制带 crown 时墙顶改用它的做法 */
function stoneRun(c: WCtx, look: WallLook, pts: P[], closed: boolean) {
  const { w, H } = c
  const { half, hgt, batter } = look
  const sts = stationsOf(pts, closed, 5, H, half + batter, 1.2, 20)
  if (sts.length < 2) return
  w.base = sts[0].lo
  w.c = look.col
  w.face = look.face
  const caps = !closed
  // 墙身：外面、步道、内面
  sweep(w, sts, [[half + batter, LO], [half, hgt], [-half, hgt], [-half - batter * 0.5, LO]], { cols: [look.col, look.pave, look.col], faces: [look.face, MAT.paving, look.face], caps })
  if (look.crown) {
    look.crown(c, look, sts, caps)
    return
  }
  // 外侧女墙与雉堞
  const pT = look.pT
  sweep(w, sts, [[half, hgt], [half, hgt + look.parapet], [half - pT, hgt + look.parapet], [half - pT, hgt]], { caps })
  crenels(w, sts, half, hgt + look.parapet, look.mLen, look.mGap, look.merlon, pT, look.mCap)
  // 内侧女墙（宇墙）
  if (look.inner > 0) sweep(w, sts, [[-half + 0.32, hgt], [-half + 0.32, hgt + look.inner], [-half, hgt + look.inner], [-half, hgt]], { caps })
  look.trim?.(c, look, sts)
  w.c = look.col
}

/**
 * 木栅：一根根削尖的原木（菱形截面、平滑着色，看上去是圆木），各自立在脚下的地面上；
 * 内侧一道横木把它们连起来
 */
function palisadeRun(c: WCtx, pts: P[], closed: boolean, pitch: number) {
  const { w, H } = c
  const sts = stationsOf(pts, closed, pitch, H, 0.3, 0.6)
  if (sts.length < 2) return
  w.face = MAT.plain
  const r = pitch * 0.53
  for (let i = 0; i + (closed ? 1 : 0) < sts.length; i++) {
    const s = sts[i]
    const [x, z] = s.p
    const hsh = hash(x, z, 1)
    w.at(x, z)
    w.base = s.g - 0.6
    w.c = shade(TIMBER, 0.82 + hash(x, z, 2) * 0.4)
    const top = s.g + 3.9 + hsh * 0.5
    tube(w, s.p, r, r * 0.92, s.lo, top, 4, { arc: [hsh * 6.28, hsh * 6.28 + Math.PI * 2] })
    w.c = shade(TIMBER, 1.25)
    tube(w, s.p, r * 0.92, 0, top, top + 0.5, 4, { arc: [hsh * 6.28, hsh * 6.28 + Math.PI * 2] })
  }
  // 内侧的横木
  w.c = TIMBER_DARK
  w.face = MAT.board
  const rail = sts.filter((_, i) => i % 8 === 0 || i === sts.length - 1)
  w.base = sts[0].g - 0.6
  sweep(w, rail, [[-r, 2.7], [-r, 2.95], [-r - 0.16, 2.95], [-r - 0.16, 2.7]], { loop: true, caps: !closed })
}

/**
 * 水门：墙身自 a 到 b 架拱跨过水面（跨度大的分几孔，墩落在水里），墙顶的步道与女墙照常接过去。
 * 拱洞里一道铁栅（竖条）
 */
function waterGate(c: WCtx, look: WallLook, a: P, b: P) {
  const { w, H } = c
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  const e: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  const out: P = [-e[1], e[0]]
  const { half, hgt } = look
  const ga = Math.max(H(a[0], a[1]), 0.3)
  const gb = Math.max(H(b[0], b[1]), 0.3)
  const top = (x: number) => ga + (gb - ga) * (x / L) + hgt
  const yb = -3
  w.at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  w.base = Math.min(ga, gb) - 0.6
  // 分孔：每孔净宽不超过约 9 米，墩宽 2.4 米
  const pier = 2.4
  const nA = Math.max(1, Math.ceil((L - 1) / 11))
  const span = (L - pier * (nA - 1) - 1.6) / nA
  const hw = span / 2
  const spring = Math.min(2.2, Math.max(0.6, hgt - hw - 2.5))
  const holes = Array.from({ length: nA }, (_, i) => placeArch(archOutline(look.arch, hw, spring - yb, 10), 0.8 + hw + i * (span + pier), yb))
  w.c = look.col
  w.face = look.face
  for (const sg of [1, -1]) {
    const o: P = [a[0] + out[0] * half * sg, a[1] + out[1] * half * sg]
    archFace(w, o, e, 0, L, yb, top, holes, [out[0] * sg, out[1] * sg], 6)
  }
  const o0: P = [a[0] - out[0] * half, a[1] - out[1] * half]
  for (const h of holes) vault(w, o0, e, [out[0] * half * 2, out[1] * half * 2], h)
  // 铁栅：每孔一排竖条，落到水下
  w.c = hex('#2f2c2a')
  w.face = MAT.plain
  for (let i = 0; i < nA; i++) {
    const cx = 0.8 + hw + i * (span + pier)
    const bars = Math.max(3, Math.floor(span / 0.7))
    for (let k = 1; k < bars; k++) {
      const x = cx - hw + (span * k) / bars
      const dx = x - cx
      const yt = spring + (look.arch === 'pointed' ? Math.max(0, hw - Math.abs(dx)) * 1.2 : Math.sqrt(Math.max(0, hw * hw - dx * dx))) + 0.1
      const p: P = [a[0] + e[0] * x + out[0] * half * 0.5, a[1] + e[1] * x + out[1] * half * 0.5]
      beam(w, [p[0], -1.2, p[1]], [p[0], yt, p[1]], 0.05, 0.05, false)
    }
  }
  // 墙顶：步道、女墙与雉堞照墙段的做法
  const sts: Station[] = [
    { p: a, n: out, k: 1, s: 0, g: ga, lo: yb },
    { p: b, n: out, k: 1, s: L, g: gb, lo: yb },
  ]
  w.c = look.pave
  w.face = MAT.paving
  sweep(w, sts, [[half, hgt], [-half, hgt]], { caps: false })
  w.c = look.col
  w.face = look.face
  if (look.crown) return
  sweep(w, sts, [[half, hgt], [half, hgt + look.parapet], [half - look.pT, hgt + look.parapet], [half - look.pT, hgt]], { caps: false })
  crenels(w, sts, half, hgt + look.parapet, look.mLen, look.mGap, look.merlon, look.pT, look.mCap)
  if (look.inner > 0) sweep(w, sts, [[-half + 0.32, hgt], [-half + 0.32, hgt + look.inner], [-half, hgt + look.inner], [-half, hgt]], { caps: false })
}

/** 一圈女墙与雉堞：ring 为闭合环（左手法线朝外的走向），y 为台面高度 */
export function battlement(c: Ctx, ring: P[], y: number, look: WallLook, o: { merlons?: boolean; parapet?: number } = {}) {
  const { w } = c
  const sts = stationsOf(ring, true, 1e9, () => y, 0, 0)
  const pH = o.parapet ?? look.parapet
  sweep(w, sts, [[0, 0], [0, pH], [-look.pT, pH], [-look.pT, 0]], { caps: false, chunk: false })
  if (o.merlons !== false && look.merlon > 0) crenels(w, sts, 0, pH, look.mLen, look.mGap, look.merlon, look.pT, look.mCap)
}

/** 框里的矩形环（s ∈ ±hs、t ∈ ±ht），左手法线朝外的走向 */
export const outRing = (f: Ax, hs: number, ht: number): P[] => [lp(f, hs, -ht), lp(f, -hs, -ht), lp(f, -hs, ht), lp(f, hs, ht)]

/** 圆塔顶的一圈女墙与垛：外半径 R、台面高 y */
export function roundCrown(c: Ctx, ctr: P, R: number, y: number, look: WallLook, n = 16) {
  const { w } = c
  const pH = look.parapet
  const rin = R - look.pT
  tube(w, ctr, R, R, y, y + pH, n)
  // 内壁（朝塔心）与女墙顶
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    const P3 = (a: number, r: number, yy: number): [number, number, number] => [ctr[0] + Math.cos(a) * r, yy, ctr[1] + Math.sin(a) * r]
    w.quadOut(P3(a0, rin, y), P3(a1, rin, y), P3(a1, rin, y + pH), P3(a0, rin, y + pH), [-Math.cos((a0 + a1) / 2), 0, -Math.sin((a0 + a1) / 2)])
    w.quadOut(P3(a0, rin, y + pH), P3(a1, rin, y + pH), P3(a1, R, y + pH), P3(a0, R, y + pH), [0, 1, 0])
  }
  // 垛
  const m = Math.max(6, Math.round((Math.PI * 2 * R) / (look.mLen + look.mGap)))
  for (let i = 0; i < m; i++) {
    const a = ((i + 0.5) / m) * Math.PI * 2
    const rad: P = [Math.cos(a), Math.sin(a)]
    const f = axUV([ctr[0] + rad[0] * R, ctr[1] + rad[1] * R], rad)
    const hl = Math.min(look.mLen, ((Math.PI * 2 * R) / m) * 0.62) / 2
    box(w, f, -look.pT, 0.02, -hl, hl, y + pH, y + pH + look.merlon)
  }
}

/** 圆塔：收分的塔脚、塔身、挑出的塔顶；roofed 时加圆锥顶，否则是露天的垛台 */
export function drum(c: Ctx, ctr: P, R: number, lo: number, g: number, top: number, roofed: boolean, look: WallLook, roofCol: RGB = SLATE) {
  const { w } = c
  const n = R > 4.5 ? 20 : 16
  w.c = look.col
  w.face = look.face
  // 塔脚收分、塔身
  tube(w, ctr, R + 0.55, R, lo, g + 2.6, n)
  tube(w, ctr, R, R, g + 2.6, top - 0.7, n)
  // 挑出的一圈（托着垛台）
  const Rc = R + 0.4
  w.c = shade(look.col, 0.9)
  tube(w, ctr, R, Rc, top - 0.7, top, n)
  w.c = look.col
  if (roofed) {
    // 短短的一段墙身托着圆锥顶，檐口挑出
    tube(w, ctr, Rc, Rc, top, top + 1.5, n)
    const Re = Rc + 0.55
    w.c = shade(roofCol, 0.55)
    w.face = MAT.plain
    ringUnder(w, ctr, Rc - 0.05, Re, top + 1.5, n)
    w.c = roofCol
    w.face = MAT.slate
    tube(w, ctr, Re, 0, top + 1.5, top + 1.5 + Re * 1.75, n)
    // 塔尖的小球
    w.c = hex('#3a3936')
    w.face = MAT.plain
    beam(w, [ctr[0], top + 1.5 + Re * 1.7, ctr[1]], [ctr[0], top + 2.6 + Re * 1.75, ctr[1]], 0.05, 0.05)
  } else {
    w.c = look.pave
    w.face = MAT.paving
    const P3 = (a: number): [number, number, number] => [ctr[0] + Math.cos(a) * Rc, top, ctr[1] + Math.sin(a) * Rc]
    for (let i = 0; i < n; i++) w.triOut([ctr[0], top, ctr[1]], P3((i / n) * Math.PI * 2), P3(((i + 1) / n) * Math.PI * 2), [0, 1, 0])
    w.c = look.col
    w.face = look.face
    roundCrown(c, ctr, Rc, top, look, n)
  }
  w.c = look.col
  w.face = look.face
}

/** 方台：收分的台身 + 铺面的台顶 + 一圈女墙雉堞（马面、方塔、城台的角台） */
export function bastion(c: Ctx, f: Ax, hs: number, ht: number, lo: number, top: number, look: WallLook, batter = look.batter) {
  const { w } = c
  w.c = look.col
  w.face = look.face
  // 收分：台脚四周放出 batter
  const b = [l3(f, -hs - batter, -ht - batter, lo), l3(f, hs + batter, -ht - batter, lo), l3(f, hs + batter, ht + batter, lo), l3(f, -hs - batter, ht + batter, lo)]
  const t = [l3(f, -hs, -ht, top), l3(f, hs, -ht, top), l3(f, hs, ht, top), l3(f, -hs, ht, top)]
  const outs: [number, number, number][] = [
    [-f.v[0], 0, -f.v[1]],
    [f.u[0], 0, f.u[1]],
    [f.v[0], 0, f.v[1]],
    [-f.u[0], 0, -f.u[1]],
  ]
  const uv: [number, number, number] = [0, 0, top]
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const L = Math.hypot(t[j][0] - t[i][0], t[j][2] - t[i][2]) || 1
    const dx = (t[j][0] - t[i][0]) / L
    const dz = (t[j][2] - t[i][2]) / L
    uv[1] = L
    w.uvOf = (p) => ((uv[0] = (p[0] - t[i][0]) * dx + (p[2] - t[i][2]) * dz), uv)
    w.quadOut(b[i], b[j], t[j], t[i], outs[i])
  }
  w.uvOf = null
  w.c = look.pave
  w.face = MAT.paving
  w.quadOut(t[0], t[1], t[2], t[3], [0, 1, 0])
  w.c = look.col
  w.face = look.face
  if (look.parapet > 0) battlement(c, outRing(f, hs, ht), top, look)
}

/** 框 → 屋顶的框（屋脊沿 f.v，即沿墙） */
export const roofFrame = (f: Ax, s: number, t: number, a: number, b: number): Frame => ({ c: lp(f, s, t), u: f.v, v: f.u, a, b })

/**
 * 向城外凸出的方台（马面、方塔）：hs 为凸出方向的半长、ht 为沿墙的半长，top 为台面高度，batter 为台脚的收分。
 * f 的 u 朝城外、v 沿墙，原点在墙中线上；返回方台的框
 */
export function salient(c: WCtx, look: WallLook, f: Ax, hs: number, ht: number, lo: number, top: number, batter: number): Ax {
  const off = look.half + hs * 0.55
  const ff = { o: lp(f, off - hs, 0), u: f.u, v: f.v }
  bastion(c, ff, hs, ht, lo, top, look, batter)
  return ff
}

/** 塔楼：木栅是望楼，石墙按文明的沙盘套件（WallKit.tower）。f 的 u 朝城外、v 沿墙，原点在墙中线上 */
function tower(c: WCtx, look: WallLook, f: Ax, R: number, roofed: boolean) {
  const { w, H } = c
  const t = f.o
  const g = H(t[0], t[1])
  let lo = g
  for (const [s, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) lo = Math.min(lo, H(t[0] + f.u[0] * s * R + f.v[0] * v * R, t[1] + f.u[1] * s * R + f.v[1] * v * R))
  lo -= 1.5
  w.base = g - 0.6
  if (!look.stone) {
    // 木栅的望楼：四根立柱、木板台、矮栏与草顶
    const hs = Math.max(1.5, R * 0.75)
    const yp = g + 4.6
    w.c = TIMBER_DARK
    w.face = MAT.plain
    for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const q = lp(f, i * hs, j * hs)
      beam(w, [q[0], lo, q[1]], [q[0], yp + 2.9, q[1]], 0.16, 0.16, false)
    }
    // 斜撑
    for (const j of [-1, 1]) {
      const a = lp(f, -hs, j * hs)
      const b = lp(f, hs, j * hs)
      beam(w, [a[0], g + 0.4, a[1]], [b[0], yp - 0.3, b[1]], 0.09, 0.09, false)
    }
    w.c = TIMBER
    w.face = MAT.plank
    w.uvOf = (p) => [(p[0] - t[0]) * f.u[0] + (p[2] - t[1]) * f.u[1], 0, 0]
    box(w, f, -hs - 0.35, hs + 0.35, -hs - 0.35, hs + 0.35, yp - 0.18, yp, { bottom: true })
    w.uvOf = null
    w.face = MAT.board
    for (const q of [0, 1, 2, 3]) {
      const ff = { o: f.o, u: q % 2 ? f.v : f.u, v: q % 2 ? f.u : f.v }
      const sg = q < 2 ? 1 : -1
      box(w, ff, sg * (hs + 0.27), sg * (hs + 0.35), -hs - 0.35, hs + 0.35, yp, yp + 1.05)
    }
    w.roofFace = MAT.straw
    w.roofTh = 0.22
    hip(w, { c: t, u: f.v, v: f.u, a: hs + 0.3, b: hs + 0.3 }, yp + 2.9, 0.8, 0.45, hex('#a8905a'))
    w.roofFace = MAT.tile
    return
  }
  c.kit.wall.tower(c, look, f, R, roofed, g, lo)
}

// —————————————————————— 院墙 ——————————————————————

/** 院墙的种类：按文明的沙盘套件（FenceKit.kind）、所在片区与院子大小 */
type FenceKind = 'kerb' | 'stone' | 'tiled' | 'plaster' | 'tall' | 'hedge' | 'rail'

/**
 * 院墙：沿环放样（瓦顶墙加瓦顶的墙帽），对着最近的路的一边留门（门柱、门扇或小门楼）。
 * 很小的院子（水池、花坛的边）只做一道矮的石沿
 */
export function enclosure(c: WCtx, ring: P[]) {
  const { w, H, st } = c
  const fence = c.kit.fence
  if (ring.length < 3) return
  let cx = 0
  let cz = 0
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  let a2 = 0
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]
    cx += p[0] / ring.length
    cz += p[1] / ring.length
    x0 = Math.min(x0, p[0])
    x1 = Math.max(x1, p[0])
    z0 = Math.min(z0, p[1])
    z1 = Math.max(z1, p[1])
    a2 += p[0] * q[1] - q[0] * p[1]
  })
  const areaOf = Math.abs(a2) / 2
  // 走向统一成左手法线朝外
  const loop = a2 > 0 ? [...ring].reverse() : ring
  const n = loop.length
  // 最短的"宽度"：面积 / 最长边
  let longest = 0
  for (let i = 0; i < n; i++) longest = Math.max(longest, Math.hypot(loop[(i + 1) % n][0] - loop[i][0], loop[(i + 1) % n][1] - loop[i][1]))
  const wid = areaOf / (longest || 1)
  // 所在的片区
  let ward = undefined as Settlement['wards'][number] | undefined
  for (const wd of st.wards) {
    if (pointInPoly([cx, cz], wd.poly)) {
      ward = wd
      break
    }
  }
  const wt = ward?.type
  let kind: FenceKind
  if (areaOf < 70 || wid < 4.5) kind = 'kerb'
  else if (fence.kind) kind = fence.kind
  else if (wt === 'park') kind = 'rail'
  else if (wt === 'farm' || wt === 'wild' || wt === 'suburb') kind = hash(cx, cz, 7) < 0.5 ? 'hedge' : 'stone'
  else kind = 'stone'
  w.at(cx, cz)
  w.base = H(cx, cz) - 0.6

  if (kind === 'kerb') {
    const sts = stationsOf(loop, true, 30, H, 0.2, 0.4)
    w.c = fence.kerb
    w.face = MAT.stone
    sweep(w, sts, [[0.18, LO], [0.18, 0.32], [-0.18, 0.32], [-0.18, LO]], { faces: [MAT.stone, MAT.paving, MAT.stone] })
    return
  }

  // —— 门：最靠近路的一边，门心取路在这条边上的垂足 ——
  let gate: { i: number; t: number; d: number } | null = null
  for (let i = 0; i < n; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % n]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 5.5) continue
    for (const tt of [0.5, 0.3, 0.7]) {
      const m: P = [a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt]
      const r = c.road(m, 16)
      if (!r) continue
      // 路在墙外一侧才算
      const ox = -(b[1] - a[1]) / L
      const oz = (b[0] - a[0]) / L
      const side = (r.q[0] - m[0]) * ox + (r.q[1] - m[1]) * oz
      if (side < -0.5) continue
      const d = r.d + (tt === 0.5 ? 0 : 0.6)
      if (!gate || d < gate.d) gate = { i, t: tt, d }
    }
  }
  // 门前不能压着房子：门心处两侧各 1.2 米内有建筑角点就不开门（那里本就由房子把口）
  const big = areaOf > 1500
  const gw = kind === 'hedge' ? 1.6 : big ? 1.9 : 1.4
  const hgt = kind === 'tiled' ? (big ? fence.tiled!.hgt[0] : fence.tiled!.hgt[1]) : kind === 'tall' ? (big ? 3.6 : 3.0) : kind === 'hedge' ? 1.3 : kind === 'rail' ? 1.2 : wt === 'noble' || wt === 'castle' || wt === 'temple' ? 2.4 : wt === 'cemetery' ? 1.5 : 1.7
  const half = kind === 'hedge' ? 0.45 : kind === 'tall' ? 0.32 : kind === 'rail' ? 0.07 : kind === 'stone' ? 0.27 : 0.24

  // 环自门的一侧绕到另一侧（没有门时整圈闭合）
  let path: P[]
  let closed = true
  let gf: Ax | null = null
  if (gate) {
    const a = loop[gate.i]
    const b = loop[(gate.i + 1) % n]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    const e: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    const sc = Math.max(gw + 1.2, Math.min(L - gw - 1.2, L * gate.t))
    const gc: P = [a[0] + e[0] * sc, a[1] + e[1] * sc]
    // 门的框：u 朝外，v 沿墙（行进方向）
    gf = { o: gc, u: [-e[1], e[0]], v: e }
    const p1: P = [gc[0] + e[0] * gw, gc[1] + e[1] * gw]
    const p0: P = [gc[0] - e[0] * gw, gc[1] - e[1] * gw]
    path = [p1]
    for (let k = 1; k <= n; k++) path.push(loop[(gate.i + k) % n])
    path.push(p0)
    closed = false
  } else path = loop

  const sts = stationsOf(path, closed, 10, H, half, 0.5, 60)
  if (sts.length < 2) return
  const caps = !closed
  if (kind === 'tiled') {
    // 墙身：浅色的是抹灰，深色的是露砖
    const body: RGB = fence.tiled!.body ?? (hash(cx, cz, 9) < 0.45 ? hex('#d9d4c8') : hex('#b3aca0'))
    const bm = body[0] > 200 ? MAT.plaster : MAT.brick
    w.c = body
    // 墙身两面（墙顶压在墙帽下，不另做）；墙帽：两坡小瓦顶与檐下的底板
    sweep(w, sts, [[half, LO], [half, hgt]], { faces: [bm], caps: false })
    sweep(w, sts, [[-half, hgt], [-half, LO]], { faces: [bm], caps: false })
    const ov = half + 0.3
    sweep(w, sts, [[ov, hgt - 0.06], [0, hgt + 0.34], [-ov, hgt - 0.06]], { loop: true, cols: [TILE_DARK, TILE_DARK, shade(TILE_DARK, 0.5)], faces: [MAT.tileEast, MAT.tileEast, MAT.plain], caps })
    if (caps) {
      // 门口两侧的墙头封口
      w.c = body
      w.face = bm
      for (const [A, B] of [[sts[0], sts[1]], [sts[sts.length - 1], sts[sts.length - 2]]]) {
        const out: [number, number, number] = [A.p[0] - B.p[0], 0, A.p[1] - B.p[1]]
        const q = (o: number, y: number): [number, number, number] => [A.p[0] + A.n[0] * o * A.k, y, A.p[1] + A.n[1] * o * A.k]
        w.quadOut(q(half, A.lo), q(-half, A.lo), q(-half, A.g + hgt), q(half, A.g + hgt), out)
      }
    }
  } else if (kind === 'tall') {
    const body = mixRGB(hex('#dccaa4'), hex('#e8dbbd'), hash(cx, cz, 9))
    w.c = body
    sweep(w, sts, [[half + 0.06, LO], [half, hgt]], { faces: [MAT.plaster], caps: false })
    sweep(w, sts, [[-half, hgt], [-half - 0.06, LO]], { faces: [MAT.plaster], caps: false })
    // 墙顶一道略挑出的压顶
    w.c = shade(body, 0.92)
    sweep(w, sts, [[half + 0.06, hgt], [half + 0.06, hgt + 0.16], [-half - 0.06, hgt + 0.16], [-half - 0.06, hgt]], { faces: [MAT.plain, MAT.plain, MAT.plain], caps })
  } else if (kind === 'hedge') {
    // 树篱：修剪成梯形截面的一道绿篱
    sweep(w, sts, [[half, LO], [half * 0.8, hgt], [-half * 0.8, hgt], [-half, LO]], { faces: [MAT.straw, MAT.straw, MAT.straw], cols: [hex('#3f5232'), hex('#4c6239'), hex('#3f5232')], caps })
  } else if (kind === 'rail') {
    // 园子的铁栏杆：石座上一排竖杆，上下两道横杆
    w.c = STONE
    sweep(w, sts, [[0.16, LO], [0.16, 0.35], [-0.16, 0.35], [-0.16, LO]], { faces: [MAT.stone, MAT.paving, MAT.stone], caps })
    w.c = hex('#2c2d2b')
    w.face = MAT.plain
    for (const y of [0.55, hgt]) sweep(w, sts, [[0.03, y - 0.03], [0.03, y + 0.03], [-0.03, y + 0.03], [-0.03, y - 0.03]], { loop: true, caps })
    for (let i = 0; i + 1 < sts.length; i++) {
      const A = sts[i]
      const B = sts[i + 1]
      const L = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1])
      const m = Math.max(1, Math.round(L / 0.42))
      w.at(A.p[0], A.p[1])
      for (let k = 0; k < m; k++) {
        const t = (k + 0.5) / m
        const x = A.p[0] + (B.p[0] - A.p[0]) * t
        const z = A.p[1] + (B.p[1] - A.p[1]) * t
        const y = A.g + (B.g - A.g) * t
        beam(w, [x, y + 0.3, z], [x, y + hgt + 0.14, z], 0.022, 0.022, false)
      }
    }
  } else {
    // 西式的石墙：毛石墙身、挑出的压顶石
    w.c = shade(STONE, 0.92 + hash(cx, cz, 9) * 0.14)
    sweep(w, sts, [[half + 0.04, LO], [half, hgt]], { faces: [MAT.stone], caps: false })
    sweep(w, sts, [[-half, hgt], [-half - 0.04, LO]], { faces: [MAT.stone], caps: false })
    w.c = shade(STONE, 1.08)
    sweep(w, sts, [[half + 0.07, hgt - 0.02], [half + 0.07, hgt + 0.08], [0, hgt + 0.2], [-half - 0.07, hgt + 0.08], [-half - 0.07, hgt - 0.02]], { faces: [MAT.plain, MAT.plain, MAT.plain, MAT.plain], caps })
  }
  if (gf) fenceGate(c, gf, gw, hgt, half, kind, big)
}

/** 院门：门柱与门扇；瓦顶墙是带瓦顶的小门楼，抹灰高墙是墙上开的尖拱门洞，石墙为石门柱与木门，栏杆为石柱 */
function fenceGate(c: WCtx, f: Ax, gw: number, hgt: number, half: number, kind: FenceKind, big: boolean) {
  const { w, H } = c
  const g = H(f.o[0], f.o[1])
  const lo = Math.min(H(f.o[0] + f.v[0] * gw, f.o[1] + f.v[1] * gw), H(f.o[0] - f.v[0] * gw, f.o[1] - f.v[1] * gw), g) - 0.5
  w.at(f.o[0], f.o[1])
  if (kind === 'hedge') {
    // 树篱的口子：两根木桩与一扇栅门
    w.c = TIMBER
    w.face = MAT.board
    for (const sg of [-1, 1]) box(w, f, -0.09, 0.09, sg * gw - 0.09, sg * gw + 0.09, lo, g + 1.35)
    box(w, f, -0.03, 0.03, -gw + 0.1, gw - 0.1, g + 0.25, g + 1.1, { bottom: true })
    return
  }
  if (kind === 'tiled') {
    const tiled = c.kit.fence.tiled!
    // 小门楼：两根柱、门楣、两坡瓦顶（高出院墙），门扇半掩
    const top = hgt + (big ? 1.0 : 0.6)
    w.c = tiled.post
    w.face = MAT.plain
    for (const sg of [-1, 1]) box(w, f, -0.16, 0.16, sg * gw - 0.16, sg * gw + 0.16, lo, g + top)
    box(w, f, -0.14, 0.14, -gw - 0.3, gw + 0.3, g + top - 0.5, g + top - 0.2, { bottom: true })
    // 门扇（大院子才做）：朝里开，各开一半
    w.c = tiled.leaf
    w.face = MAT.board
    for (const sg of big ? [-1, 1] : []) {
      const hinge = lp(f, -0.1, sg * (gw - 0.16))
      const dir: P = [-f.u[0] * 0.8 - f.v[0] * sg * 0.6, -f.u[1] * 0.8 - f.v[1] * sg * 0.6]
      const lf = axUV(hinge, dir)
      box(w, lf, 0, gw - 0.2, -0.04, 0.04, g + 0.08, g + top - 0.55, { bottom: true })
    }
    w.roofFace = MAT.tileEast
    w.gableFace = MAT.plain
    w.roofTh = 0.16
    const rf: Frame = { c: f.o, u: f.v, v: f.u, a: gw + 0.45, b: 0.75 }
    gateRoof(c, rf, g + top, tiled.pitch)
    return
  }
  if (kind === 'tall') {
    // 高墙上的门：墙接过门洞（尖拱），拱里一扇关着的木门
    const body = hex('#e0d0ac')
    const yb = lo
    const top = g + hgt
    const hole = placeArch(archOutline('pointed', gw - 0.25, 1.75 + (g - yb), 8), 0, yb)
    w.c = body
    w.face = MAT.plaster
    for (const sg of [1, -1]) archFace(w, lp(f, sg * half, 0), f.v, -gw, gw, yb, () => top + 0.16, [hole], [f.u[0] * sg, f.u[1] * sg])
    vault(w, lp(f, -half, 0), f.v, [f.u[0] * half * 2, f.u[1] * half * 2], hole)
    w.quadOut(l3(f, -half, -gw, top + 0.16), l3(f, half, -gw, top + 0.16), l3(f, half, gw, top + 0.16), l3(f, -half, gw, top + 0.16), [0, 1, 0])
    // 门框一圈浅色的边、深色木门
    w.c = hex('#5a4630')
    w.face = MAT.board
    box(w, f, -0.05, 0.05, -gw + 0.25, gw - 0.25, yb, g + 1.75 + (gw - 0.25) * 1.25, { top: false })
    return
  }
  if (kind === 'rail') {
    w.c = STONE
    w.face = MAT.stone
    for (const sg of [-1, 1]) {
      cbox(w, { o: lp(f, 0, sg * gw), u: f.u, v: f.v }, 0.26, 0.26, lo, g + hgt + 0.5)
      w.face = MAT.plain
      pyramid(w, { o: lp(f, 0, sg * gw), u: f.u, v: f.v }, 0.32, 0.32, g + hgt + 0.5, 0.3)
      w.face = MAT.stone
    }
    return
  }
  // 石墙的门：方石门柱（柱帽），一半的院子装着木门
  w.c = shade(STONE, 1.05)
  w.face = MAT.stone
  for (const sg of [-1, 1]) {
    const pf = { o: lp(f, 0, sg * gw), u: f.u, v: f.v }
    cbox(w, pf, half + 0.12, half + 0.12, lo, g + hgt + 0.45)
    w.face = MAT.plain
    cbox(w, pf, half + 0.2, half + 0.2, g + hgt + 0.45, g + hgt + 0.57)
    pyramid(w, pf, half + 0.2, half + 0.2, g + hgt + 0.57, 0.22)
    w.face = MAT.stone
  }
  if (hash(f.o[0], f.o[1], 11) < 0.6) {
    w.c = hex('#4f3d2c')
    w.face = MAT.board
    for (const sg of [-1, 1]) {
      const hinge = lp(f, 0, sg * (gw - half - 0.12))
      const dir: P = [-f.u[0] * 0.5 - f.v[0] * sg * 0.87, -f.u[1] * 0.5 - f.v[1] * sg * 0.87]
      box(w, axUV(hinge, dir), 0, gw - half - 0.2, -0.035, 0.035, g + 0.1, g + hgt - 0.1, { bottom: true })
    }
  }
}

/** 小门楼的顶：小两坡瓦顶，屋脊沿墙；k 为坡度 */
function gateRoof(c: Ctx, f: Frame, y: number, k: number) {
  const { w } = c
  const col = TILE_DARK
  w.c = col
  const A = f.a
  const B = f.b
  const P3 = (s: number, t: number, h: number): [number, number, number] => [f.c[0] + f.u[0] * s + f.v[0] * t, h, f.c[1] + f.u[1] * s + f.v[1] * t]
  const yr = y + B * k
  const under = shade(col, 0.5)
  for (const sg of [-1, 1]) {
    w.c = col
    w.face = MAT.tileEast
    w.slabQuad(P3(-A, B * sg, y), P3(A, B * sg, y), P3(A, 0, yr), P3(-A, 0, yr), 0.1, under)
    w.c = under
    w.face = MAT.plain
    w.edgeStrip(P3(-A, B * sg, y), P3(A, B * sg, y), 0.1, [f.v[0] * sg, 0, f.v[1] * sg])
    for (const e of [-1, 1]) w.edgeStrip(P3(A * e, B * sg, y), P3(A * e, 0, yr), 0.1, [f.u[0] * e, 0, f.u[1] * e])
  }
  w.c = shade(col, 0.8)
  box(w, { o: f.c, u: f.u, v: f.v }, -A, A, -0.09, 0.09, yr - 0.04, yr + 0.12)
}
