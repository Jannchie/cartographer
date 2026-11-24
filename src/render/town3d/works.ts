/**
 * 建筑以外的构筑物：城墙与塔楼城门、院墙、桥与渡船、码头、船。
 * 纯函数，在 Worker 中运行。
 */
import { centroid, type P } from '../../settlement/geom'
import type { Settlement, Wall } from '../../settlement/types'
import { MAT, at, cap, circle, cone, coping, fence, flat, frameOf, hip, irimoya, merlons, prism, rectOf, shade, slab, strip, v3, wallSegment, walls, type Frame } from './mesh'
import { ADOBE, LACQUER, PLASTER, STONE, STONE_DARK, STONE_EAST, TILE_DARK, TIMBER, TIMBER_DARK, VERMILION, hex, type Ctx } from './shared'

/** 城墙：按段拉成墙体（城门处断开、墙顶随地形、雉堞），塔楼，门楼 */
export function cityWall(c: Ctx, wall: Wall) {
  const { w, culture, H } = c
  const stone = wall.kind === 'stone'
  const hgt = stone ? (culture === 'eastern' ? 11 : culture === 'wa' ? 7 : 9) : 4.5
  const th = wall.thickness
  const col = stone ? (culture === 'eastern' ? STONE_EAST : culture === 'islamic' ? ADOBE : STONE) : TIMBER
  const n = wall.loop.length
  const gap = stone ? 7 : 5
  const near = (p: P) => wall.gates.some((g) => Math.hypot(g.p[0] - p[0], g.p[1] - p[1]) < 0.5)
  // 环的绕向：左手法线朝外还是朝内（雉堞立在外沿）
  let a2 = 0
  for (let i = 0; i < n; i++) {
    const q = wall.loop[(i + 1) % n]
    a2 += wall.loop[i][0] * q[1] - q[0] * wall.loop[i][1]
  }
  const outSign = a2 > 0 ? -1 : 1
  const crenel = stone && culture !== 'wa'
  w.face = !stone ? MAT.board : culture === 'islamic' ? MAT.plaster : culture === 'eastern' ? MAT.brick : MAT.stone
  w.roofFace = culture === 'western' ? MAT.slate : MAT.tileEast
  w.gableFace = culture === 'wa' ? MAT.plaster : w.face
  w.base = -1.5
  for (let i = 0; i < n; i++) {
    if (!wall.solid[i]) continue
    let a = wall.loop[i]
    let b = wall.loop[(i + 1) % n]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 0.1) continue
    const cut = Math.min(0.45, gap / L)
    if (near(a)) a = [a[0] + (b[0] - a[0]) * cut, a[1] + (b[1] - a[1]) * cut]
    if (near(b)) b = [b[0] + (a[0] - b[0]) * cut, b[1] + (a[1] - b[1]) * cut]
    const ux = (b[0] - a[0]) / L
    const uz = (b[1] - a[1]) / L
    // 外沿方向
    const ox = -uz * outSign
    const oz = ux * outSign
    // 长段按 12 米切开，墙顶跟着地形走
    const segs = Math.max(1, Math.ceil(L / 12))
    for (let s = 0; s < segs; s++) {
      const p: P = [a[0] + (b[0] - a[0]) * (s / segs), a[1] + (b[1] - a[1]) * (s / segs)]
      const q: P = [a[0] + (b[0] - a[0]) * ((s + 1) / segs), a[1] + (b[1] - a[1]) * ((s + 1) / segs)]
      w.at(p[0], p[1])
      const hp = H(p[0], p[1])
      const hq = H(q[0], q[1])
      w.c = col
      wallSegment(w, p, q, th / 2, Math.min(hp, hq) - 1.5, hp + hgt, hq + hgt)
      if (crenel) {
        const e = th / 2
        merlons(w, [p[0] + ox * e, p[1] + oz * e], [q[0] + ox * e, q[1] + oz * e], hp + hgt, hq + hgt, [-ox, -oz], 0.6, 1.1, 3)
      }
    }
  }
  const tr = stone ? th * 1.25 : th * 1.3
  for (const t of wall.towers) {
    w.at(t[0], t[1])
    const g = H(t[0], t[1])
    w.c = col
    if (stone && culture === 'western') {
      const ring = circle(t, tr, 12)
      walls(w, ring, g - 1.5, g + hgt + 3)
      cone(w, t, tr * 1.15, g + hgt + 3, tr * 2, hex('#7d6a5c'), 12)
    } else if (stone && (culture === 'eastern' || culture === 'wa')) {
      // 敌台（马面）上的小楼
      const ring = circle(t, tr * 1.2, 4)
      prism(w, ring, g - 1.5, g + hgt + 0.5)
      const f: Frame = { c: t, u: [1, 0], v: [0, 1], a: tr * 0.6, b: tr * 0.6 }
      w.c = culture === 'wa' ? PLASTER : LACQUER
      walls(w, rectOf(f), g + hgt + 0.5, g + hgt + 3.5)
      hip(w, f, g + hgt + 3.5, 0.55, 0.9, TILE_DARK, 'curved')
    } else {
      const ring = circle(t, tr * 1.2, 4)
      prism(w, ring, g - 1.5, g + hgt + 3)
    }
  }
  for (const gt of wall.gates) {
    w.at(gt.p[0], gt.p[1])
    const g = H(gt.p[0], gt.p[1])
    const u: P = [Math.cos(gt.angle), Math.sin(gt.angle)]
    const v: P = [-u[1], u[0]]
    const s = stone ? 1 : 0.7
    // 门楼：门洞两侧的墩 + 跨过门洞的楼
    w.c = col
    for (const side of [-1, 1]) {
      const ct: P = [gt.p[0] + v[0] * (gap + 2.5 * s) * side, gt.p[1] + v[1] * (gap + 2.5 * s) * side]
      prism(w, rectOf({ c: ct, u, v, a: 5 * s, b: 3 * s }), g - 1.5, g + hgt + 2)
    }
    if (!stone) continue
    const f: Frame = { c: gt.p, u: v, v: [-u[0], -u[1]], a: gap + 5 * s, b: 5 * s }
    const ring = rectOf(f)
    w.c = col
    walls(w, ring, g + 5, g + hgt + 2)
    // 门洞顶
    const under = [...ring].reverse()
    for (let i = 1; i < 3; i++) w.tri(v3(under[0], g + 5), v3(under[i], g + 5), v3(under[i + 1], g + 5))
    if (culture === 'eastern' || culture === 'wa') {
      // 城楼：重檐歇山
      cap(w, ring, g + hgt + 2)
      const hall: Frame = { ...f, a: f.a * 0.8, b: f.b * 0.75 }
      w.c = culture === 'wa' ? PLASTER : LACQUER
      walls(w, rectOf(hall), g + hgt + 2, g + hgt + 6)
      irimoya(w, hall, g + hgt + 6, 0.6, 1.6, TILE_DARK, culture === 'wa' ? PLASTER : LACQUER, 'curved')
    } else {
      flat(w, f, g + hgt + 2, STONE_DARK, col, 1)
      if (culture === 'western') for (const sg of [-1, 1]) merlons(w, at(f, -f.a, f.b * sg), at(f, f.a, f.b * sg), g + hgt + 3, g + hgt + 3, [-f.v[0] * sg, -f.v[1] * sg], 0.35, 0.8, 2.2)
    }
  }
}

/** 院墙：沿环拉成矮墙（东亚加墙帽瓦） */
export function enclosure(c: Ctx, ring: P[]) {
  const { w, culture, H } = c
  if (ring.length < 3) return
  const hgt = culture === 'eastern' ? 2.6 : culture === 'islamic' ? 2.8 : culture === 'wa' ? 2.1 : 1.8
  w.face = culture === 'wa' || culture === 'islamic' ? MAT.plaster : culture === 'eastern' ? MAT.brick : MAT.stone
  w.base = -0.5
  w.c = culture === 'wa' ? PLASTER : culture === 'eastern' ? hex('#b8b0a2') : culture === 'islamic' ? hex('#dccaa4') : STONE
  const r = fence(w, ring, 0.3, (p) => H(p[0], p[1]) - 0.5, (p) => H(p[0], p[1]) + hgt)
  // 东亚院墙的墙帽：出檐的小两坡瓦顶
  if (culture === 'wa' || culture === 'eastern') {
    w.c = TILE_DARK
    w.face = MAT.tileEast
    coping(w, r, 0.6, (p) => H(p[0], p[1]) + hgt - 0.05, 0.32, 0.06, shade(TILE_DARK, 0.55))
  }
}

/** 桥：桥面按跨度起拱，两侧栏杆，长桥加桥墩；神桥为朱漆拱桥；渡口放一条渡船 */
export function crossing(c: Ctx, x: Settlement['crossings'][number]) {
  const { w, culture, H } = c
  const L = Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1])
  if (L < 1) return
  const mid: P = [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2]
  w.at(mid[0], mid[1])
  w.face = x.sacred || culture === 'wa' ? MAT.board : culture === 'islamic' ? MAT.plaster : MAT.stone
  if (x.kind === 'ford') return
  if (x.kind === 'ferry') {
    boat(c, { p: mid, angle: Math.atan2(x.b[1] - x.a[1], x.b[0] - x.a[0]) + Math.PI / 2, len: 9 })
    return
  }
  const ya = Math.max(H(x.a[0], x.a[1]), 0.3) + 0.5
  const yb = Math.max(H(x.b[0], x.b[1]), 0.3) + 0.5
  const rise = Math.min(x.sacred ? L * 0.22 : L * 0.08, x.sacred ? 5 : 3.5)
  const half = Math.max(1.2, x.width / 2)
  const col = x.sacred ? VERMILION : culture === 'wa' ? TIMBER : culture === 'eastern' ? STONE_EAST : culture === 'islamic' ? ADOBE : STONE
  const n = Math.max(4, Math.min(16, Math.ceil(L / 4)))
  const yAt = (t: number) => ya + (yb - ya) * t + rise * 4 * t * (1 - t)
  const pt = (t: number): P => [x.a[0] + (x.b[0] - x.a[0]) * t, x.a[1] + (x.b[1] - x.a[1]) * t]
  w.base = Math.min(ya, yb) - 2
  const dx = (x.b[0] - x.a[0]) / L
  const dz = (x.b[1] - x.a[1]) / L
  for (let i = 0; i < n; i++) {
    const t0 = i / n
    const t1 = (i + 1) / n
    const p = pt(t0)
    const q = pt(t1)
    const y0 = yAt(t0)
    const y1 = yAt(t1)
    w.c = col
    slab(w, p, q, half, y0, y1, 0.8)
    // 栏杆
    for (const sgn of [-1, 1]) {
      const o = (half - 0.15) * sgn
      const off = (r: P): P => [r[0] - dz * o, r[1] + dx * o]
      wallSegment(w, off(p), off(q), 0.15, Math.min(y0, y1) - 0.1, y0 + 0.9, y1 + 0.9)
    }
  }
  // 桥墩：长桥每 15 米一个
  if (L > 24 && !x.sacred) {
    const piers = Math.floor(L / 15)
    w.c = col
    for (let i = 1; i <= piers; i++) {
      const t = i / (piers + 1)
      const p = pt(t)
      const f = frameOf(strip(pt(t - 0.5 / L), pt(t + 0.5 / L), half * 0.9), Math.atan2(x.b[1] - x.a[1], x.b[0] - x.a[0]))
      prism(w, rectOf(f), Math.min(H(p[0], p[1]), -1) - 1, yAt(t) - 0.8)
    }
  }
}

/** 船：尖头的船体 + 甲板，长船加桅杆 */
export function boat(c: Ctx, b: { p: P; angle: number; len: number }) {
  const { w, culture } = c
  w.at(b.p[0], b.p[1])
  w.base = -0.4
  w.face = MAT.board
  const L = b.len / 2
  const Wd = Math.max(0.8, b.len * 0.16)
  const u: P = [Math.cos(b.angle), Math.sin(b.angle)]
  const f: Frame = { c: b.p, u, v: [-u[1], u[0]], a: L, b: Wd }
  const hull: P[] = [at(f, L, 0), at(f, L * 0.55, Wd), at(f, -L * 0.85, Wd * 0.9), at(f, -L, Wd * 0.5), at(f, -L, -Wd * 0.5), at(f, -L * 0.85, -Wd * 0.9), at(f, L * 0.55, -Wd)]
  w.c = culture === 'islamic' ? hex('#8a6a48') : TIMBER_DARK
  walls(w, hull, -0.4, 0.5)
  w.c = hex('#a08560')
  cap(w, hull, 0.5)
  if (b.len > 10) {
    w.c = TIMBER_DARK
    prism(w, circle(at(f, L * 0.1, 0), 0.15, 4), 0.5, 0.5 + b.len * 0.7)
  }
}

/** 码头、栈桥：水面上的一块平台（东亚木构，其余石砌） */
export function pier(c: Ctx, p: P[]) {
  const { w, culture } = c
  const ct = centroid(p)
  w.at(ct[0], ct[1])
  w.base = -1
  const wood = culture === 'wa' || culture === 'eastern'
  w.c = wood ? TIMBER : STONE
  w.face = wood ? MAT.board : MAT.stone
  prism(w, p, -1.2, 0.9)
}
