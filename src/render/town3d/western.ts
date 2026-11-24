/**
 * 西式建筑：民居与大宅（木骨架的出挑楼层、老虎窗、烟囱、临街铺面）、厅堂与公共建筑、
 * 教堂（按部件：中殿与高侧窗、侧廊的披檐、耳堂、后殿、西立面的塔与尖顶、交叉塔或穹顶、扶壁与飞扶壁、回廊院）、
 * 城堡主楼与塔楼、宫殿的主体与圆厅。纯函数，在 Worker 中运行。
 */
import { centroid, type P } from '../../settlement/geom'
import { DOOR, MAT, STYLE, WIN, at, block, cap, circle, cone, crenels, dome, flat, frameOf, gable, grow, growEdges, hip, lathe, leanTo, leanToEnds, parapet, prism, rectOf, shade, slab, taper, tent, tube, turned, wall1, walls, type Frame, type RGB, type WallFac } from './mesh'
import { chimney, dormer, finial, hashOf, soffitRing, type Site } from './kit'
import { mid, type Group } from './groups'
import { ASHLAR, BRICK_WALL, GILT, ROOF, STONE, STONE_DARK, TIMBER_DARK, WALL, pick, type Ctx } from './shared'

export function western(c: Ctx, s: Site, g: Group | null) {
  if (g && part(c, s, g)) return
  switch (s.b.kind) {
    case 'house':
    case 'large':
      return house(c, s)
    case 'hall':
    case 'civic':
      return hall(c, s)
    case 'temple':
      return chapel(c, s)
    case 'keep':
      return keep(c, s)
    case 'tower':
      return tower(c, s)
    default:
      return gazebo(c, s)
  }
}

// —————————————————————— 民居、大宅 ——————————————————————

function house(c: Ctx, s: Site) {
  const { w, storey } = c
  const { b, f, fac, g0, g1, base, tone, t2, t3, t4 } = s
  const large = b.kind === 'large'
  const floors = Math.max(1, s.floors)
  // 墙：民居多为抹灰或露明木构架，少数石砌、砖砌；大宅石砌居多
  const wm = large ? (t2 < 0.5 ? MAT.stone : t2 < 0.85 ? MAT.plaster : MAT.brick) : t2 < 0.36 ? MAT.timber : t2 < 0.8 ? MAT.plaster : t2 < 0.93 ? MAT.stone : MAT.brick
  const wallCol = wm === MAT.stone ? shade(pick(ASHLAR, t3), 0.94) : wm === MAT.brick ? pick(BRICK_WALL, t3) : pick(WALL.western, t3)
  // 屋面：陶瓦为主，少数石板；城外低矮的小屋铺茅草
  const cottage = !large && floors === 1 && f.b < 4.2 && t4 > 0.8
  const slate = large ? t4 < 0.5 : t4 < 0.13
  const roofCol = cottage ? pick(ROOF.thatch, tone) : slate ? pick(ROOF.slate, tone) : pick(ROOF.clay, tone)
  w.roofFace = cottage ? MAT.thatch : slate ? MAT.slate : MAT.tile
  w.roofTh = cottage ? 0.42 : 0.24
  w.gableFace = wm
  const k = cottage ? 1.1 + t2 * 0.2 : 0.84 + t2 * 0.3
  const over = cottage ? 0.5 : 0.4
  const top = g1 + floors * storey
  const poly = b.poly
  // 临街的铺面：密处的楼房底层
  const shop = fac.door >= 0 && floors >= 2 && !large && t3 > 0.4
  const wf: WallFac = { win: fac.win, door: fac.door, alt: shop ? (i) => (i === fac.door ? { face: wm | WIN | DOOR, style: STYLE.shop } : null) : undefined }
  w.c = wallCol
  w.face = wm | WIN
  let rf = f
  // 木骨架的楼层向临空的几面挑出
  const jetty = wm === MAT.timber && floors >= 2 && g1 - g0 < 0.9 && f.b > 2.4 && poly.length === 4
  if (jetty) {
    const yj = g0 + storey
    const up = growEdges(poly, fac.win.map((o) => (o ? 0.3 : 0)))
    walls(w, poly, base, yj, wf)
    walls(w, up, yj, top, { win: fac.win, door: -1 })
    soffitRing(w, up, poly, yj, TIMBER_DARK)
    rf = frameOf(up, b.ridge)
  } else walls(w, poly, base, top, wf)

  const hipped = large && t4 > 0.62 && rf.a > rf.b * 1.25
  w.gableWin = !cottage && !hipped && rf.b > 2.3 && rf.b - 1.5 / k > 0.6
  if (hipped) hip(w, rf, top, k, over, roofCol)
  else gable(w, rf, top, k, over, roofCol, wallCol)
  w.gableWin = false
  const ridge = top + rf.b * k
  // 大宅：横出的一道小山墙（墙面升起成山尖，屋脊垂直于主脊）
  let cross = 0
  if (large && !hipped && rf.a > 6.5) {
    const wc = Math.min(rf.b * 0.8, rf.a * 0.3)
    cross = rf.a * 0.42 * (tone > 0.5 ? 1 : -1)
    const fc: Frame = { c: at(rf, cross, 0), u: rf.v, v: [-rf.u[0], -rf.u[1]], a: rf.b, b: wc }
    w.gableWin = wc > 2.2
    gable(w, fc, top, Math.min(1.3, (rf.b * k * 0.94) / wc), over, roofCol, wallCol)
    w.gableWin = false
  }
  // 烟囱：多数民居有一个，落在屋脊一侧；大宅两个
  if (!cottage ? t2 > 0.3 && rf.a > 2.5 : t2 > 0.5) {
    const sgn = tone > 0.5 ? 1 : -1
    chimney(w, rf, rf.a * 0.55 * (cross ? -Math.sign(cross) : sgn), rf.b * 0.3, top, ridge + 0.8)
    if (large && rf.a > 5 && !cross) chimney(w, rf, -rf.a * 0.55 * sgn, -rf.b * 0.3, top, ridge + 0.8)
  }
  // 老虎窗
  if (!cottage && rf.b > 3 && rf.a > 3.4 && hashOf(tone, 5) > (large ? 0.25 : 0.62)) {
    const sgn = hashOf(tone, 6) > 0.5 ? 1 : -1
    w.face = wm === MAT.timber ? MAT.plaster : wm
    const n = rf.a > 6.5 ? 2 : 1
    for (let i = 0; i < n; i++) {
      const ds = n === 1 ? (cross ? -cross * 0.6 : rf.a * 0.15 * -sgn) : rf.a * 0.42 * (i ? 1 : -1)
      if (cross && Math.abs(ds - cross) < rf.a * 0.45) continue
      dormer(w, rf, ds, sgn, top, k, wallCol, roofCol)
    }
  }
}

// —————————————————————— 厅堂、公共建筑 ——————————————————————

function hall(c: Ctx, s: Site) {
  const { w, storey } = c
  const { b, f, fac, g1, base, tone, t2, t3, t4 } = s
  const civic = b.kind === 'civic'
  // 路边的小龛（苦路站）：一根石柱顶着小龛
  if (Math.max(f.a, f.b) < 1.2) return pillarShrine(c, s)
  const floors = Math.max(1, s.floors || (civic && f.b > 4 ? 2 : 1))
  const top = g1 + floors * storey + (civic ? 0.6 : 1.6)
  const wm = civic ? (t2 < 0.45 ? MAT.timber : t2 < 0.75 ? MAT.plaster : MAT.stone) : t2 < 0.75 ? MAT.stone : MAT.brick
  const wallCol = wm === MAT.stone ? pick(ASHLAR, t3) : wm === MAT.brick ? pick(BRICK_WALL, t3) : pick(WALL.western, t3)
  const slate = t4 < 0.6
  const roofCol = slate ? pick(ROOF.slate, tone) : pick(ROOF.clay, tone)
  w.roofFace = slate ? MAT.slate : MAT.tile
  w.roofTh = 0.28
  w.gableFace = wm
  w.c = wallCol
  w.face = wm | WIN
  // 市场的厅：底层一圈拱廊
  const market = !civic && floors === 1 && t3 > 0.55 && !b.role
  if (market) w.style = STYLE.arcade
  walls(w, b.poly, base, top, fac)
  w.style = 0
  const k = 0.9 + t2 * 0.25
  const sq = f.a - f.b < 1.2
  if (sq || t4 > 0.35) hip(w, f, top, sq ? 1.25 : k, 0.45, roofCol)
  else {
    w.gableWin = f.b > 3
    gable(w, f, top, k, 0.45, roofCol, wallCol)
    w.gableWin = false
  }
  const ridge = top + f.b * (sq ? 1.25 : k)
  if (f.a > 4) chimney(w, f, f.a * 0.6 * (tone > 0.5 ? 1 : -1), f.b * 0.25, top, ridge + 0.9, 0.5)
  // 屋脊上的小尖塔（公共建筑、大厅）
  if ((civic || f.a > 12) && f.a > 6 && f.b > 3.2 && hashOf(tone, 3) > 0.35) fleche(c, at(f, 0, 0), ridge - 0.6, Math.min(1.1, f.b * 0.22), roofCol)
  if (f.b > 3.4 && f.a > 5 && !market) {
    w.face = wm === MAT.timber ? MAT.plaster : wm
    for (const sg of [-1, 1]) for (const ds of f.a > 9 ? [-0.5, 0, 0.5] : [-0.35, 0.35]) dormer(w, f, f.a * ds, sg, top, sq ? 1.25 : k, wallCol, roofCol)
  }
}

/** 屋脊上的小尖塔：方座、百叶的一段、细高的尖顶 */
function fleche(c: Ctx, p: P, y: number, r: number, roof: RGB) {
  const { w } = c
  const f: Frame = { c: p, u: [1, 0], v: [0, 1], a: r, b: r }
  w.c = TIMBER_DARK
  w.face = MAT.board
  walls(w, rectOf(f), y, y + r * 2.4)
  w.roofFace = MAT.metal
  w.c = ROOF.lead
  tent(w, p, 4, Math.PI / 4, r * 1.75, y + r * 2.4, 0, y + r * 2.4 + r * 4.5, mixLead(roof), 'straight')
  finial(w, p, y + r * 6.8, r * 0.14, r * 0.9, GILT)
}
const mixLead = (roof: RGB): RGB => [Math.round((roof[0] + ROOF.lead[0]) / 2), Math.round((roof[1] + ROOF.lead[1]) / 2), Math.round((roof[2] + ROOF.lead[2]) / 2)]

/** 路边的小龛：石柱、龛、小两坡顶 */
function pillarShrine(c: Ctx, s: Site) {
  const { w } = c
  const { f, g1, base } = s
  const p = f.c
  w.c = STONE
  w.face = MAT.stone
  const sq: Frame = { c: p, u: f.u, v: f.v, a: 0.28, b: 0.28 }
  prism(w, rectOf(sq, 0.18), base, g1 + 0.3)
  walls(w, rectOf(sq), g1 + 0.3, g1 + 1.7)
  w.c = shade(STONE, 1.08)
  walls(w, rectOf(sq, 0.1), g1 + 1.7, g1 + 2.3)
  w.roofFace = MAT.slate
  w.gableFace = MAT.stone
  w.roofTh = 0.06
  gable(w, { ...sq, a: 0.38, b: 0.38 }, g1 + 2.3, 1.1, 0.12, ROOF.slate[0], STONE)
}

// —————————————————————— 小礼拜堂（没有部件名的宗教建筑） ——————————————————————

function chapel(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, tone, t3, round } = s
  const stone = pick(ASHLAR, t3)
  const roof = pick(ROOF.slate, tone)
  w.roofFace = MAT.slate
  w.gableFace = MAT.stone
  w.roofTh = 0.22
  if (round) {
    // 园中的圆亭、圆形小堂：一圈墙，铅皮穹顶
    const ct = centroid(b.poly)
    const r = Math.max(f.a, f.b)
    const top = g1 + 3.2 + r * 0.8
    w.c = stone
    w.face = MAT.stone | WIN
    w.style = STYLE.arcade
    walls(w, b.poly, base, top, undefined, 0.5)
    w.style = 0
    ring(c, ct, r + 0.12, top - 0.3, 0.3, stone)
    w.face = MAT.metal
    dome(w, ct, r * 0.96, top, ROOF.lead, 16, 5, 0.85)
    finial(w, ct, top + r * 0.8, r * 0.1, r * 0.4, GILT)
    return
  }
  const small = f.a < 3.6
  const top = g1 + (small ? 2.6 : 3.2 + f.b * 1.5)
  w.c = stone
  w.face = MAT.stone | WIN
  w.style = small ? STYLE.house : STYLE.lancet
  const west = edgeFacing(b.poly, [-f.u[0], -f.u[1]])
  walls(w, b.poly, base, top, { win: b.poly.map(() => true), door: small ? west : -1, alt: (i) => (!small && i === west ? { face: MAT.stone | WIN, style: STYLE.portal } : null) })
  w.style = 0
  gable(w, f, top, 1.15, 0.3, roof, stone)
  const ridge = top + f.b * 1.15
  // 西山墙顶上的钟架
  const bc = at(f, -f.a + 0.3, 0)
  const bf: Frame = { c: bc, u: f.v, v: [-f.u[0], -f.u[1]], a: Math.min(0.7, f.b * 0.35), b: 0.28 }
  w.c = stone
  w.face = MAT.stone
  walls(w, rectOf(bf), ridge - 0.5, ridge + (small ? 0.8 : 1.5))
  w.roofTh = 0.08
  gable(w, bf, ridge + (small ? 0.8 : 1.5), 1.2, 0.1, roof, stone)
  cross(c, at(f, f.a, 0), ridge, 0.9)
}

/** 山墙顶、塔尖上的十字架 */
function cross(c: Ctx, p: P, y: number, h: number) {
  const { w } = c
  w.c = STONE_DARK
  w.face = MAT.plain
  const f: Frame = { c: p, u: [1, 0], v: [0, 1], a: 0.05, b: 0.05 }
  prism(w, rectOf(f), y - 0.1, y + h)
  block(w, rectOf({ ...f, a: h * 0.3 }), y + h * 0.58, y + h * 0.7)
}

/** 圆塔、圆堂墙顶的一道外凸的线脚 */
function ring(c: Ctx, ct: P, r: number, y: number, h: number, col: RGB) {
  const { w } = c
  w.c = col
  w.face = MAT.plain
  lathe(w, ct, y, [[r - 0.14, 0], [r, 0.02], [r, h], [r - 0.14, h]], 16)
}

/** 多边形里朝向 dir 的那面墙（下标） */
export function edgeFacing(poly: P[], dir: P): number {
  const ct = mid(poly)
  let best = 0
  let bd = -Infinity
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length]
    const d = ((poly[i][0] + q[0]) / 2 - ct[0]) * dir[0] + ((poly[i][1] + q[1]) / 2 - ct[1]) * dir[1]
    if (d > bd) {
      bd = d
      best = i
    }
  }
  return best
}

// —————————————————————— 城堡主楼、塔楼 ——————————————————————

function keep(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, t3, round } = s
  const stone = shade(pick(ASHLAR, t3), 0.9)
  w.gableFace = MAT.stone
  if (round) {
    // 圆主楼：收分的圆筒、挑出的墙垛一圈、里面一座低的圆锥顶
    const ct = centroid(b.poly)
    const r = Math.max(f.a, f.b)
    const top = g1 + Math.min(30, 13 + r * 1.3)
    w.c = stone
    w.face = MAT.stone | WIN
    w.style = STYLE.slit
    walls(w, b.poly, base, top, undefined, 0.5)
    w.style = 0
    roundCrown(c, ct, r, top, stone)
    w.roofFace = MAT.slate
    cone(w, ct, r * 0.82, top + 0.4, r * 0.9, ROOF.slate[1], 16)
    return
  }
  const side = Math.min(f.a, f.b) * 2
  const fore = b.part === 'forebuilding'
  const top = g1 + (fore ? 9 + side * 0.3 : Math.min(30, Math.max(16, 12 + side * 0.7)))
  w.c = stone
  w.face = MAT.stone | WIN
  w.style = STYLE.slit
  walls(w, b.poly, base, top)
  w.style = 0
  w.face = MAT.stone
  flat(w, f, top, STONE_DARK, stone, 0.9)
  w.c = stone
  crenels(w, f, top + 0.9, 0.4, 0.85, 2.3)
  if (fore) return
  // 四角的角楼：略凸出墙面，高出墙垛
  const tr = Math.max(1.1, side * 0.11)
  for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const tf: Frame = { c: at(f, sa * (f.a - tr * 0.6), sb * (f.b - tr * 0.6)), u: f.u, v: f.v, a: tr, b: tr }
    w.c = stone
    w.face = MAT.stone
    walls(w, rectOf(tf), base, top + 2.8)
    flat(w, tf, top + 2.8, STONE_DARK, stone, 0.7)
    w.c = stone
    crenels(w, tf, top + 3.5, 0.3, 0.7, 1.5)
  }
}

/** 圆塔顶：外挑的一圈承托（堞眼）与墙垛 */
function roundCrown(c: Ctx, ct: P, r: number, y: number, stone: RGB) {
  const { w } = c
  w.c = stone
  w.face = MAT.stone
  // 挑台：自墙面向外斜挑，再竖直成女儿墙，墙顶一道平台面收向里
  lathe(w, ct, y - 1.3, [[r, 0], [r + 0.55, 0.7], [r + 0.55, 2.2], [r + 0.1, 2.2], [r + 0.1, 1.3], [0, 1.3]], 18)
  const n = Math.max(8, Math.round((r * 6.28) / 2.2))
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2
    const u: P = [-Math.sin(a), Math.cos(a)]
    const m: P = [ct[0] + Math.cos(a) * (r + 0.33), ct[1] + Math.sin(a) * (r + 0.33)]
    const hw = (r * 6.28) / n / 2 * 0.56
    prism(w, rectOf({ c: m, u, v: [-u[1], u[0]], a: hw, b: 0.23 }), y + 0.85, y + 1.75)
  }
}

function tower(c: Ctx, s: Site) {
  const { w, storey } = c
  const { b, f, g1, base, tone, t2, t3, round } = s
  // 路边的石十字：平面上是一竖一横两条，立体只在横条处立一座
  if (b.role === '路边十字架' || Math.min(f.a, f.b) < 0.6) {
    if (f.a < 1.25) waysideCross(c, s)
    return
  }
  const stone = shade(pick(ASHLAR, t3), 0.92)
  w.gableFace = MAT.stone
  w.roofFace = MAT.slate
  w.roofTh = 0.2
  if (round) {
    const ct = centroid(b.poly)
    const r = Math.max(f.a, f.b)
    const top = g1 + 13 + tone * 5
    w.c = stone
    w.face = MAT.stone | WIN
    w.style = STYLE.slit
    walls(w, b.poly, base, top, undefined, 0.5)
    w.style = 0
    if (t2 > 0.45) {
      ring(c, ct, r + 0.2, top - 0.35, 0.35, stone)
      w.roofFace = MAT.slate
      cone(w, ct, r * 1.22, top, r * 2.3, pick(ROOF.slate, tone), 16)
    } else {
      roundCrown(c, ct, r, top, stone)
    }
    return
  }
  const sq: Frame = { ...f, a: Math.max(f.a, f.b), b: Math.max(f.a, f.b) }
  // 塔楼民居：方塔住人，四坡顶与烟囱
  if (b.role === '塔楼民居') {
    const top = g1 + storey * 4.5
    w.c = stone
    w.face = MAT.stone | WIN
    walls(w, b.poly, base, top, s.fac)
    hip(w, f, top, 1.1, 0.4, pick(ROOF.slate, tone))
    chimney(w, f, f.a * 0.5, 0, top, top + f.b * 1.1 + 0.9, 0.45, STONE)
    return
  }
  const top = g1 + 15 + hashOf(tone, 3) * 7
  w.c = stone
  w.face = MAT.stone | WIN
  w.style = STYLE.slit
  walls(w, b.poly, base, top)
  w.style = 0
  if (t2 > 0.62) {
    w.c = stone
    w.face = MAT.stone
    walls(w, rectOf(sq, 0.18), top - 0.4, top)
    hip(w, sq, top, 1.7, 0.3, pick(ROOF.slate, tone))
  } else {
    w.face = MAT.stone
    flat(w, f, top, STONE_DARK, stone, 0.9)
    w.c = stone
    crenels(w, f, top + 0.9, 0.38, 0.8, 2.1)
  }
}

/** 路边的石十字：三级台座、柱、十字 */
function waysideCross(c: Ctx, s: Site) {
  const { w } = c
  const { f, g1, base } = s
  const p = f.c
  const sq = (r: number): Frame => ({ c: p, u: f.u, v: f.v, a: r, b: r })
  w.c = STONE
  w.face = MAT.stone
  prism(w, rectOf(sq(0.7)), base, g1 + 0.22)
  prism(w, rectOf(sq(0.48)), g1 + 0.22, g1 + 0.44)
  w.face = MAT.plain
  prism(w, rectOf(sq(0.13)), g1 + 0.44, g1 + 3.1)
  block(w, rectOf({ c: p, u: f.u, v: f.v, a: 0.1, b: 0.55 }), g1 + 2.35, g1 + 2.6)
}

/** 园中的亭子（西式）：一圈细柱，铅皮的攒尖顶 */
function gazebo(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base } = s
  const ct = centroid(b.poly)
  const r = Math.min(f.a, f.b)
  const n = b.poly.length >= 6 ? 8 : 4
  w.c = STONE
  w.face = MAT.stone
  prism(w, circle(ct, r, n, Math.PI / n), base, g1 + 0.35)
  const top = g1 + 0.35 + 2.6 + r * 0.25
  w.c = pick(WALL.western, 0.3)
  w.face = MAT.plain
  for (const p of circle(ct, r * 0.86, n, Math.PI / n)) tube(w, p, 0.11, 0.1, g1 + 0.35, top, 6)
  w.c = STONE
  block(w, circle(ct, r * 0.98, n, Math.PI / n), top, top + 0.28)
  w.roofFace = MAT.metal
  w.roofTh = 0.08
  tent(w, ct, n, Math.PI / n, r * 1.15, top + 0.28, 0, top + 0.28 + r * 0.95, ROOF.lead)
  finial(w, ct, top + 0.2 + r * 0.95, 0.09, 0.5, GILT)
}

// —————————————————————— 教堂（按部件） ——————————————————————

/** 一座教堂的整体尺寸：由中殿推出，各部件共用 */
interface Church {
  /** 中殿的框（u 沿中殿、指向东端） */
  nf: Frame
  /** 中殿半宽、连侧廊的半宽 */
  wn: number
  hb: number
  /** 基准地面、中殿檐高、侧廊檐高、屋脊高（都是绝对高度） */
  G: number
  En: number
  Ea: number
  ridge: number
  /** 屋面坡度 */
  k: number
  stone: RGB
  roof: RGB
  /** 塔顶的样式：尖塔、四坡、平顶墙垛 */
  crown: 0 | 1 | 2
  aisled: boolean
}

function churchOf(c: Ctx, g: Group): Church | null {
  if (g.memo.has('church')) return g.memo.get('church') as Church | null
  const nave = g.of('nave')[0]
  let out: Church | null = null
  if (nave) {
    let nf = frameOf(nave.poly, nave.ridge)
    // 东端在哪一头：后殿、圣坛所在的一侧；没有时取西端部件的反向
    const eastParts = [...g.of('apse'), ...g.of('chancel'), ...g.of('ambulatory'), ...g.of('ladyChapel')]
    const westParts = [...g.of('westTower'), ...g.of('westwork')]
    let sgn = 1
    if (eastParts.length) {
      const m = mid(eastParts[0].poly)
      sgn = (m[0] - nf.c[0]) * nf.u[0] + (m[1] - nf.c[1]) * nf.u[1] >= 0 ? 1 : -1
    } else if (westParts.length) {
      const m = mid(westParts[0].poly)
      sgn = (m[0] - nf.c[0]) * nf.u[0] + (m[1] - nf.c[1]) * nf.u[1] >= 0 ? -1 : 1
    }
    if (sgn < 0) nf = { ...nf, u: [-nf.u[0], -nf.u[1]], v: [-nf.v[0], -nf.v[1]] }
    let G = -Infinity
    for (const p of nave.poly) G = Math.max(G, c.H(p[0], p[1]))
    const wn = nf.b
    const aisle = g.of('aisle')[0]
    let hb = wn
    if (aisle) for (const p of aisle.poly) hb = Math.max(hb, Math.abs((p[0] - nf.c[0]) * nf.v[0] + (p[1] - nf.c[1]) * nf.v[1]))
    const W = wn * 2
    const en = Math.min(30, 2.5 + 1.1 * Math.min(W, 8) + 1.5 * Math.max(0, W - 8))
    const k = 1.15
    out = { nf, wn, hb, G, En: G + en, Ea: G + en * 0.46, ridge: G + en + wn * k, k, stone: pick(ASHLAR, g.seed), roof: pick(ROOF.slate, hashOf(g.seed, 2)), crown: g.seed < 0.5 ? 0 : g.seed < 0.78 ? 1 : 2, aisled: !!aisle }
  }
  g.memo.set('church', out)
  return out
}

function part(c: Ctx, s: Site, g: Group): boolean {
  const p = s.b.part!
  if (p === 'donjon' || p === 'forebuilding') {
    keep(c, s)
    return true
  }
  if (p === 'corps' || p === 'pavilion' || p === 'portico') {
    palaceBlock(c, s, p)
    return true
  }
  if (p === 'rotunda') {
    rotunda(c, s)
    return true
  }
  const ch = churchOf(c, g)
  if (!ch) return false
  const { w } = c
  const { b, base } = s
  const { nf, wn, hb, En, Ea, k, stone, roof } = ch
  w.roofFace = MAT.slate
  w.gableFace = MAT.stone
  w.roofTh = 0.3
  const all = b.poly.map(() => true)
  /** 部件中心在中殿坐标里的位置 */
  const ct = mid(b.poly)
  const sc = (ct[0] - nf.c[0]) * nf.u[0] + (ct[1] - nf.c[1]) * nf.u[1]
  const tc = (ct[0] - nf.c[0]) * nf.v[0] + (ct[1] - nf.c[1]) * nf.v[1]
  const west: P = [-nf.u[0], -nf.u[1]]
  switch (p) {
    case 'nave': {
      // 西墙是正立面（大门与玫瑰窗）；有西塔、西堂时门在它们那里
      const wk = edgeFacing(b.poly, west)
      const front = !g.of('westwork').length && g.of('westTower').length !== 1
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = ch.aisled ? STYLE.clerestory : STYLE.lancet
      walls(w, b.poly, base, En, { win: all, door: -1, alt: (i) => (i === wk ? { face: MAT.stone | (front ? WIN : 0), style: STYLE.portal } : null) })
      w.style = 0
      gable(w, nf, En, k, 0.35, roof, stone)
      cross(c, at(nf, -nf.a, 0), ch.ridge, 1.3)
      return true
    }
    case 'aisle': {
      // 两侧的侧廊：外墙开长窗，披檐靠在中殿墙上，高侧窗露在披檐之上
      const f = frameOf(b.poly, Math.atan2(nf.u[1], nf.u[0]))
      const a = Math.abs((f.u[0] * nf.u[0] + f.u[1] * nf.u[1])) > 0.5 ? f.a : f.b
      const yHi = Ea + (En - Ea) * 0.32
      for (const sd of [-1, 1]) {
        const lf: Frame = { c: at(nf, sc, (sd * (wn + hb)) / 2), u: [nf.u[0] * sd, nf.u[1] * sd], v: [nf.v[0] * sd, nf.v[1] * sd], a, b: (hb - wn) / 2 }
        const r = rectOf(lf)
        w.c = stone
        w.face = MAT.stone | WIN
        w.style = STYLE.lancet
        wall1(w, r[3], r[2], base, Ea, lf.v)
        w.style = 0
        w.face = MAT.stone
        wall1(w, r[0], r[3], base, Ea, [-lf.u[0], -lf.u[1]])
        wall1(w, r[1], r[2], base, Ea, lf.u)
        leanToEnds(w, lf, Ea, yHi, Ea, stone, MAT.stone)
        leanTo(w, lf, yHi, Ea, 0.3, roof, 0.1)
      }
      return true
    }
    case 'transept': {
      // 耳堂：与中殿同高，屋脊横过中殿；两端的山墙是带门与玫瑰窗的立面
      const f = frameOf(b.poly, b.ridge)
      const e0 = edgeFacing(b.poly, f.u)
      const e1 = edgeFacing(b.poly, [-f.u[0], -f.u[1]])
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.lancet
      walls(w, b.poly, base, En, { win: all, door: -1, alt: (i) => (i === e0 || i === e1 ? { face: MAT.stone | WIN, style: STYLE.portal } : null) })
      w.style = 0
      gable(w, f, En, k, 0.35, roof, stone)
      return true
    }
    case 'chancel':
    case 'ladyChapel': {
      // 方圣坛、圣母堂：屋脊沿中殿的轴线
      let f = frameOf(b.poly, Math.atan2(nf.u[1], nf.u[0]))
      if (Math.abs(f.u[0] * nf.u[0] + f.u[1] * nf.u[1]) < 0.5) f = turned(f)
      const top = p === 'chancel' ? ch.G + (En - ch.G) * 0.9 : ch.G + (En - ch.G) * 0.55
      const ek = edgeFacing(b.poly, nf.u)
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.lancet
      walls(w, b.poly, base, top, { win: all, door: -1, alt: (i) => (i === ek ? { face: MAT.stone | WIN, style: STYLE.lancet } : null) })
      w.style = 0
      gable(w, f, top, k, 0.3, roof, stone)
      return true
    }
    case 'apse':
    case 'apsidiole': {
      // 半圆后殿：弧墙开长窗，半个圆锥顶靠在山墙上
      const { o, r } = chord(b.poly)
      const top = p === 'apse' ? ch.G + (En - ch.G) * 0.92 : Ea
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.lancet
      walls(w, b.poly, base, top, undefined, 0.6)
      w.style = 0
      halfCone(c, o, r, top, r * (p === 'apse' ? 0.95 : 1.1), nf.u, roof)
      return true
    }
    case 'ambulatory': {
      // 回廊：外圈矮墙与一圈披檐，里圈是与中殿同高的后殿（高侧窗）
      const { o } = chord(b.poly)
      const a0 = Math.atan2(nf.u[1], nf.u[0]) - Math.PI / 2
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.lancet
      walls(w, b.poly, base, Ea, undefined, 0.6)
      // 里圈的后殿
      const inner: P[] = []
      for (let i = 0; i <= 10; i++) inner.push([o[0] + Math.cos(a0 + (i / 10) * Math.PI) * wn, o[1] + Math.sin(a0 + (i / 10) * Math.PI) * wn])
      w.style = STYLE.clerestory
      walls(w, inner, base, En - 0.6, undefined, 0.6)
      w.style = 0
      const yHi = Ea + (En - Ea) * 0.32
      w.c = roof
      w.face = MAT.slate
      lathe(w, o, 0, [[hb + 0.3, Ea - 0.25], [wn, yHi]], 14, [a0, a0 + Math.PI])
      w.c = shade(roof, 0.5)
      w.face = MAT.plain
      lathe(w, o, 0, [[hb - 0.1, Ea - 0.27], [hb + 0.3, Ea - 0.27]], 14, [a0, a0 + Math.PI])
      halfCone(c, o, wn, En - 0.6, wn * 0.95, nf.u, roof)
      return true
    }
    case 'chapel': {
      // 放射状的小礼拜堂（圆）、侧礼拜堂（方）
      if (s.round) {
        const cc = centroid(b.poly)
        const r = Math.max(s.f.a, s.f.b)
        const top = ch.G + (Ea - ch.G) * 0.88
        w.c = stone
        w.face = MAT.stone | WIN
        w.style = STYLE.lancet
        walls(w, b.poly, base, top, undefined, 0.5)
        w.style = 0
        cone(w, cc, r * 1.12, top, r * 1.25, roof, 12)
        return true
      }
      const sd = tc >= 0 ? 1 : -1
      const f = frameOf(b.poly, Math.atan2(nf.u[1], nf.u[0]))
      const along = Math.abs(f.u[0] * nf.u[0] + f.u[1] * nf.u[1]) > 0.5
      const lf: Frame = { c: f.c, u: [nf.u[0] * sd, nf.u[1] * sd], v: [nf.v[0] * sd, nf.v[1] * sd], a: along ? f.a : f.b, b: along ? f.b : f.a }
      const lo = ch.G + (Ea - ch.G) * 0.7
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.lancet
      walls(w, rectOf(lf), base, lo)
      w.style = 0
      leanToEnds(w, lf, lo, Ea - 0.4, lo, stone, MAT.stone)
      leanTo(w, lf, Ea - 0.4, lo, 0.25, roof, 0.1)
      return true
    }
    case 'westTower':
    case 'campanile':
    case 'crossingTower': {
      const f = frameOf(b.poly, Math.atan2(nf.u[1], nf.u[0]))
      const side = Math.min(f.a, f.b)
      const sq: Frame = { ...f, a: side, b: side }
      const body = p === 'crossingTower' ? ch.ridge + Math.min(16, Math.max(5, wn * 1.5)) : p === 'campanile' ? ch.ridge + 6 + side * 2 : ch.G + (ch.ridge - ch.G) * 1.22 + 3 + side
      // 略放大一圈，免得与侧廊的外墙共面
      const ringP = grow(b.poly, p === 'crossingTower' ? 0 : 0.22)
      const single = p === 'westTower' && g.of('westTower').length === 1
      const wk = edgeFacing(ringP, west)
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.belfry
      walls(w, ringP, base, body, { win: all, door: single ? wk : -1 })
      w.style = 0
      steeple(c, { ...sq, a: side + (p === 'crossingTower' ? 0 : 0.22), b: side + (p === 'crossingTower' ? 0 : 0.22) }, body, p === 'campanile' ? 1 : p === 'crossingTower' && ch.crown === 0 ? (g.of('westTower').length ? 1 : 0) : ch.crown, stone, roof)
      return true
    }
    case 'westwork': {
      // 西堂：横宽的高楼，两角的楼梯塔，正面大门
      const f = frameOf(b.poly, b.ridge)
      const top = ch.ridge + 1
      const wk = edgeFacing(b.poly, west)
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.lancet
      walls(w, b.poly, base, top, { win: all, door: -1, alt: (i) => (i === wk ? { face: MAT.stone | WIN, style: STYLE.portal } : null) })
      w.style = 0
      hip(w, f, top, 0.95, 0.3, roof)
      const tr = Math.min(f.b * 0.55, 2.6)
      for (const sd of [-1, 1]) {
        const q = at(nf, sc - (Math.abs(f.u[0] * nf.u[0] + f.u[1] * nf.u[1]) > 0.5 ? f.a : f.b), sd * hb * 0.98)
        w.c = stone
        w.face = MAT.stone | WIN
        w.style = STYLE.slit
        walls(w, circle(q, tr, 12), base, top + 5, undefined, 0.5)
        w.style = 0
        cone(w, q, tr * 1.2, top + 5, tr * 2.6, roof, 12)
      }
      return true
    }
    case 'crossingDome': {
      // 十字交叉处的穹顶：鼓座开窗，铜绿的穹顶，顶上采光亭
      const cc = centroid(b.poly)
      const r = Math.max(s.f.a, s.f.b)
      const top = ch.ridge + 2.5 + r * 0.25
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.lancet
      walls(w, b.poly, base, top, undefined, 0.5)
      w.style = 0
      ring(c, cc, r + 0.35, top - 0.4, 0.5, stone)
      w.face = MAT.metal
      dome(w, cc, r * 1.02, top + 0.1, ROOF.copper, 20, 7, 1.12)
      const ly = top + r * 1.1
      w.c = stone
      w.face = MAT.stone
      tube(w, cc, r * 0.2, r * 0.2, ly - 0.4, ly + r * 0.42, 10)
      w.face = MAT.metal
      w.roofFace = MAT.metal
      cone(w, cc, r * 0.27, ly + r * 0.42, r * 0.5, ROOF.copper, 10)
      finial(w, cc, ly + r * 0.9, r * 0.05, r * 0.3, GILT)
      return true
    }
    case 'buttress': {
      // 扶壁：两级收分的墩；飞扶壁再高出侧廊，顶上小尖塔，一道斜拱飞向中殿的墙
      const sd = tc >= 0 ? 1 : -1
      const tAbs = Math.abs(tc)
      const half = Math.max(0.45, s.f.b < s.f.a ? s.f.b : s.f.a)
      const len = Math.max(s.f.a, s.f.b)
      const flying = len > 1 && ch.aisled
      const t0 = tAbs - len
      const t1 = tAbs + len
      const R = (ta: number, tb: number, hs = half): P[] => [at(nf, sc - hs, ta * sd), at(nf, sc + hs, ta * sd), at(nf, sc + hs, tb * sd), at(nf, sc - hs, tb * sd)]
      const hB = flying ? Ea + 3.2 : ch.aisled ? ch.G + (Ea - ch.G) * 0.95 : ch.G + (En - ch.G) * 0.82
      const y1 = base + (hB - base) * 0.62
      w.c = stone
      w.face = MAT.stone
      walls(w, R(t0, t1), base, y1)
      const mid1 = R(t0, t0 + (t1 - t0) * 0.62)
      taper(w, R(t0, t1), mid1, y1, y1 + 0.7)
      walls(w, mid1, y1 + 0.7, hB)
      if (flying) {
        cap(w, mid1, hB)
        const pc = at(nf, sc, (t0 + (t1 - t0) * 0.31) * sd)
        w.roofFace = MAT.stone
        w.roofTh = 0.05
        tent(w, pc, 4, Math.PI / 4, half * 1.2, hB, 0, hB + 2.4, stone)
        w.c = stone
        w.face = MAT.stone
        slab(w, at(nf, sc, (t0 + 0.3) * sd), at(nf, sc, wn * sd), 0.28, hB - 0.5, ch.G + (En - ch.G) * 0.86, 0.55)
      } else taper(w, mid1, R(t0, t0 + 0.05), hB, hB + 0.9)
      return true
    }
    case 'porch': {
      // 门廊：山墙朝外的小屋，正面一个拱门
      const sd = tc >= 0 ? 1 : -1
      const f0 = frameOf(b.poly, 0)
      const along = Math.abs(f0.u[0] * nf.u[0] + f0.u[1] * nf.u[1]) > 0.5
      const f: Frame = { c: f0.c, u: [nf.v[0] * sd, nf.v[1] * sd], v: [-nf.u[0] * sd, -nf.u[1] * sd], a: along ? f0.b : f0.a, b: along ? f0.a : f0.b }
      const ek = edgeFacing(b.poly, f.u)
      w.c = stone
      w.face = MAT.stone
      walls(w, b.poly, base, ch.G + 3.4, { win: all, door: -1, alt: (i) => (i === ek ? { face: MAT.stone | WIN, style: STYLE.arcade } : null) })
      w.roofTh = 0.2
      gable(w, f, ch.G + 3.4, 1.05, 0.25, roof, stone)
      return true
    }
    case 'cloister': {
      // 回廊院的一面：低矮的廊屋，朝院子的一面是一排拱
      const f = frameOf(b.poly, b.ridge)
      const top = s.g1 + 3.6
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.arcade
      walls(w, b.poly, base, top)
      w.style = 0
      w.roofTh = 0.22
      gable(w, f, top, 0.8, 0.3, roof, stone)
      return true
    }
    case 'chapterHouse': {
      // 牧师会堂：多边形的厅，每面一扇长窗，攒尖顶
      const cc = centroid(b.poly)
      const n = b.poly.length
      const r = Math.hypot(b.poly[0][0] - cc[0], b.poly[0][1] - cc[1])
      const top = s.g1 + 5.5 + r * 0.5
      w.c = stone
      w.face = MAT.stone | WIN
      w.style = STYLE.lancet
      walls(w, b.poly, base, top)
      w.style = 0
      tent(w, cc, n, Math.atan2(b.poly[0][1] - cc[1], b.poly[0][0] - cc[0]), r + 0.35, top - 0.1, 0, top + r * 1.25, roof)
      finial(w, cc, top + r * 1.2, 0.12, 0.8, GILT)
      return true
    }
  }
  return false
}

/** 半圆平面的弦（最长的边）：中点与半径 */
function chord(poly: P[]): { o: P; r: number } {
  let best = 0
  let o: P = poly[0]
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length]
    const L = Math.hypot(q[0] - poly[i][0], q[1] - poly[i][1])
    if (L > best) {
      best = L
      o = [(poly[i][0] + q[0]) / 2, (poly[i][1] + q[1]) / 2]
    }
  }
  return { o, r: best / 2 }
}

/** 半个圆锥顶（半圆后殿）：平的一面朝 −dir（靠在山墙上），檐口略出挑并封底 */
function halfCone(c: Ctx, o: P, r: number, y: number, h: number, dir: P, roof: RGB) {
  const { w } = c
  const a0 = Math.atan2(dir[1], dir[0]) - Math.PI / 2
  w.c = roof
  w.face = w.roofFace
  lathe(w, o, y, [[r + 0.3, -0.15], [0, h]], 12, [a0, a0 + Math.PI])
  w.c = shade(roof, 0.5)
  w.face = MAT.plain
  lathe(w, o, y, [[r - 0.1, -0.17], [r + 0.3, -0.17]], 12, [a0, a0 + Math.PI])
}

/**
 * 塔顶：0 八角尖塔（四角小尖塔）、1 四坡的方尖顶、2 平顶墙垛加四角小尖塔
 */
function steeple(c: Ctx, sq: Frame, y: number, crown: number, stone: RGB, roof: RGB) {
  const { w } = c
  const r = sq.a
  w.c = stone
  w.face = MAT.stone
  // 塔身顶上一道挑出的线脚
  block(w, rectOf(sq, 0.2), y - 0.45, y)
  if (crown === 1) {
    w.roofFace = MAT.slate
    w.roofTh = 0.2
    hip(w, sq, y, 2.1, 0.25, roof)
    finial(w, sq.c, y + r * 2.1 - 0.1, 0.1, 0.9, GILT)
    return
  }
  const pin = (h: number) => {
    for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const pc = at(sq, sa * (r - 0.25), sb * (r - 0.25))
      const pf: Frame = { c: pc, u: sq.u, v: sq.v, a: 0.42, b: 0.42 }
      w.c = stone
      w.face = MAT.stone
      walls(w, rectOf(pf), y, y + h * 0.45)
      w.roofFace = MAT.stone
      w.roofTh = 0.04
      tent(w, pc, 4, Math.atan2(sq.u[1] + sq.v[1], sq.u[0] + sq.v[0]), 0.62, y + h * 0.45, 0, y + h, stone)
    }
  }
  if (crown === 2) {
    w.face = MAT.stone
    w.gableFace = MAT.stone
    flat(w, sq, y, STONE_DARK, stone, 0.9)
    w.c = stone
    crenels(w, sq, y + 0.9, 0.35, 0.8, 1.9)
    pin(4.2)
    return
  }
  // 八角尖塔：塔顶的平台、矮女儿墙、四角小尖塔
  w.c = STONE_DARK
  w.face = MAT.plain
  cap(w, rectOf(sq), y)
  w.c = stone
  w.face = MAT.stone
  parapet(w, rectOf(sq), y, 0.7, 0.25)
  pin(Math.max(3, r * 1.3))
  w.roofFace = MAT.slate
  w.roofTh = 0.12
  const h = r * 5.2
  tent(w, sq.c, 8, Math.atan2(sq.u[1], sq.u[0]) + Math.PI / 8, r * 1.02, y + 0.2, 0, y + h, roof)
  finial(w, sq.c, y + h - 0.3, 0.12, 1.2, GILT)
}

// —————————————————————— 宫殿的主体、圆厅 ——————————————————————

function palaceBlock(c: Ctx, s: Site, p: string) {
  const { w, storey } = c
  const { b, f, g1, base, tone, t3 } = s
  const stone = pick(ASHLAR, t3)
  const roof = pick(ROOF.slate, tone)
  w.roofFace = MAT.slate
  w.gableFace = MAT.stone
  w.roofTh = 0.3
  if (p === 'portico') {
    // 门廊：一排柱子托着山花
    const top = g1 + storey * 2.2
    w.c = stone
    w.face = MAT.stone | WIN
    w.style = STYLE.arcade
    walls(w, b.poly, base, top)
    w.style = 0
    gable(w, turned(f), top, 0.45, 0.4, roof, stone)
    return
  }
  const floors = p === 'pavilion' ? 3.4 : 3
  const top = g1 + storey * floors + 0.8
  w.c = stone
  w.face = MAT.stone | WIN
  walls(w, b.poly, base, top, s.fac)
  // 檐口：墙顶一道挑出的线脚
  w.c = shade(stone, 1.06)
  w.face = MAT.plain
  block(w, grow(b.poly, 0.25), top - 0.4, top)
  const k = p === 'pavilion' ? 1.5 : 1.05
  hip(w, f, top, k, 0.2, roof)
  w.face = MAT.stone
  if (f.b > 3.5) for (const sg of [-1, 1]) for (let x = -f.a + 2.5; x <= f.a - 2.5; x += 4.5) dormer(w, f, x, sg, top, k, stone, roof)
  for (const e of [-0.6, 0.6]) chimney(w, f, f.a * e, 0, top + f.b * k * 0.5, top + f.b * k + 1.4, 0.55, stone)
}

function rotunda(c: Ctx, s: Site) {
  const { w, storey } = c
  const { b, f, g1, base, t3 } = s
  const stone = pick(ASHLAR, t3)
  const ct = centroid(b.poly)
  const r = Math.max(f.a, f.b)
  const top = g1 + storey * 3.4 + 1.6
  w.c = stone
  w.face = MAT.stone | WIN
  walls(w, b.poly, base, top, undefined, 0.5)
  ring(c, ct, r + 0.3, top - 0.45, 0.5, stone)
  w.face = MAT.metal
  dome(w, ct, r * 0.98, top + 0.05, ROOF.lead, 20, 6, 0.95)
  w.c = stone
  w.face = MAT.stone
  tube(w, ct, r * 0.16, r * 0.16, top + r * 0.85, top + r * 1.25, 10)
  w.roofFace = MAT.metal
  cone(w, ct, r * 0.22, top + r * 1.25, r * 0.4, ROOF.lead, 10)
  finial(w, ct, top + r * 1.6, 0.1, 0.9, GILT)
}
