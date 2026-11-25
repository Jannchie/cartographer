/**
 * 东方（中式）建筑：硬山的民居与歇山的大宅、殿堂（台基、朱柱槅扇、斗拱、翼角起翘的庑殿与歇山、重檐）、
 * 宫城的大殿（多层白石台基、两侧朵殿与廊庑）、廊、门、影壁、城楼式的市楼与角楼、楼阁式塔与亭。
 * 生成器的平面是示意性的（正殿可以长达两百米）：过长的殿按"当中正殿、两侧朵殿、其间廊庑"分段，各段各有合乎比例的屋顶。
 * 纯函数，在 Worker 中运行。
 */
import { clamp } from '../../../../gen/util'
import { centroid } from '../../../../settlement/geom'
import { DOOR, MAT, STYLE, WIN, annulus, block, cap, circle, crenels, gable, hip, irimoya, parapet, prism, rectOf, ridgeBar, shade, skirt, sub, taper, tent, tube, turned, walls, type Frame, type RGB, type WallFac } from '../../../../render/town3d/mesh'
import { finial, hashOf, peristyle, terrace, type Site } from '../../../../render/town3d/kit'
import { edgeFacing, type Group } from '../../../../render/town3d/groups'
import { GILT, GREY_BRICK, LACQUER, MARBLE, PALACE_RED, ROOF, STONE_EAST, WHITEWASH, hex, pick, type Ctx } from '../../../../render/town3d/shared'

/** 民居与一般厅堂的木色（门窗、柱） */
const WOOD = hex('#5e4334')
/** 寺观的黄墙 */
const OCHRE = hex('#c79b4d')

export function eastern(c: Ctx, s: Site, _g: Group | null) {
  // 部件名：族.角色（palace.gate、temple.gallery……），宫城里的一律黄琉璃、朱墙
  const [family, role] = (s.b.part ?? '').split('.')
  const palace = family === 'palace'
  switch (s.b.kind) {
    case 'house':
    case 'large':
      return house(c, s)
    case 'pagoda':
      return pagodaKind(c, s, role, palace)
    case 'tower':
      return gateTower(c, s, false, 9)
    case 'keep':
      return palaceHall(c, s, family === 'yamen' ? ROOF.glazeGreen : ROOF.glazeYellow)
    case 'temple':
      return temple(c, s, palace)
    case 'hall':
      return hallKind(c, s, palace, role)
    default:
      return civic(c, s, palace, role)
  }
}

// —————————————————————— 殿堂的通用做法 ——————————————————————

export interface HallOpt {
  /** 檐柱一线的框 */
  f: Frame
  /** 台面高度 */
  y0: number
  /** 柱与墙的颜色、屋面色与材质 */
  col: RGB
  roof: RGB
  roofFace: number
  form: 'hip' | 'irimoya' | 'gable'
  /** 檐柱高、屋面坡度、出檐 */
  wallH: number
  k: number
  over: number
  /** 斗拱层高（0 为不设） */
  dg: number
  /** 翼角起翘（米）、屋角的脊宽（0 不做） */
  upturn: number
  ribs: number
  /** 重檐 */
  double?: boolean
  /** 前廊进深：外圈是真柱子，墙退进去 */
  porch?: number
  /** 四面墙（长、短、长、短）是否开槅扇 */
  open?: boolean[]
  /** 山花与山墙的颜色 */
  gableCol?: RGB
}

/** 一座殿：墙（或柱廊加退进的墙）、斗拱、屋顶；返回脊高 */
export function hallEA(c: Ctx, o: HallOpt): number {
  const { w } = c
  const { f, y0 } = o
  const eaveY = y0 + o.wallH
  const dgO = o.dg > 0 ? 0.32 : 0.12
  const fr: Frame = { ...f, a: f.a + dgO, b: f.b + dgO }
  const open = o.open ?? [true, false, true, false]
  const porch = Math.min(o.porch ?? 0, f.b * 0.4)
  const din = o.double ? Math.max(porch, Math.min(f.b * 0.3, 3.2)) : porch
  const cell: Frame = din > 0 ? { ...f, a: f.a - din, b: f.b - din } : f
  const wallF = porch > 0 ? cell : f
  w.soffit = MAT.rafter
  w.roofFace = o.roofFace
  w.roofTh = 0.34
  w.gableFace = MAT.plaster
  const opt = { upturn: o.upturn, ribs: o.ribs }
  const lattice: WallFac = { win: open, door: -1 }
  const blind: WallFac = { win: [false, false, false, false], door: -1 }
  const body = (fw: Frame, ya: number, yb: number, fac: WallFac) => {
    w.c = o.col
    w.face = MAT.hall | WIN
    w.style = STYLE.lattice
    walls(w, rectOf(fw), ya, yb, fac)
    w.style = 0
  }
  /** 斗拱层：自 ya 到 yb 的一圈，底下封一圈朝下的面 */
  const dougong = (fo: Frame, fi: Frame, ya: number, yb: number) => {
    if (yb - ya < 0.2) return
    w.c = o.col
    w.face = MAT.dougong
    w.style = clamp(Math.round((yb - ya) / 0.15), 1, 15)
    walls(w, rectOf(fo), ya, yb)
    w.style = 0
    w.c = shade(o.col, 0.45)
    w.face = MAT.plain
    annulus(w, rectOf(fo), rectOf(fi), ya, false)
  }
  body(wallF, y0, eaveY + 0.02, lattice)
  if (porch > 0) {
    // 柱廊：檐柱一圈，廊顶封平
    const r = clamp(o.wallH * 0.055, 0.2, 0.42)
    w.c = o.col
    w.face = MAT.plain
    const cf: Frame = { ...f, a: f.a - r, b: f.b - r }
    peristyle(w, cf, Math.max(1, Math.round((f.a * 2) / 4.2)), Math.max(1, Math.round((f.b * 2) / 4.2)), y0, eaveY, r)
    // 额枋：柱顶一圈横枋
    w.c = o.col
    w.face = MAT.hall
    w.style = STYLE.lattice
    walls(w, rectOf(f), eaveY - 0.5, eaveY, blind)
    w.style = 0
    w.c = shade(o.col, 0.5)
    w.face = MAT.plain
    annulus(w, rectOf(f), rectOf(cell), eaveY - 0.5, false)
  }
  const dgTop = eaveY + o.dg
  dougong(fr, porch > 0 ? f : wallF, eaveY, dgTop)
  let roofY = dgTop
  let rf = fr
  if (o.double) {
    // 重檐：下檐一圈披檐搭在殿身上，殿身升起再出上檐
    const yIn = dgTop + (din + dgO) * 0.42 + 0.25
    const up = Math.max(1.2, o.wallH * 0.3)
    skirt(w, fr, dgTop, o.over, din + dgO, yIn, o.roof, 'curved', opt)
    body(cell, yIn - 0.1, yIn + up, blind)
    rf = { ...cell, a: cell.a + dgO, b: cell.b + dgO }
    roofY = yIn + up + o.dg * 0.85
    dougong(rf, cell, yIn + up, roofY)
  }
  const gc = o.gableCol ?? o.col
  const ridgeCol = shade(o.roof, 0.78)
  const rh = clamp(rf.b * 0.07, 0.28, 0.8)
  if (o.form === 'gable') {
    const r = gable(w, rf, roofY, o.k, o.over, o.roof, gc, 'curved', 0.45)
    ridgeBar(w, rf, rf.a + o.over * 0.3, r.yr, rh * 0.8, ridgeCol)
    return r.yr
  }
  const r = o.form === 'hip' ? hip(w, rf, roofY, o.k, o.over, o.roof, 'curved', opt) : irimoya(w, rf, roofY, o.k, o.over, o.roof, gc, 'curved', opt)
  if (r.r > 0.4) ridgeBar(w, rf, r.r + (o.form === 'hip' ? 0.2 : 0), r.yr, rh, ridgeCol)
  else finial(w, rf.c, r.yr - 0.1, rh * 0.9, rh * 3, GILT)
  return r.yr
}

/** 矮台基：殿堂脚下的一方石台 */
export function podium(c: Ctx, f: Frame, d: number, base: number, y: number, col: RGB = STONE_EAST) {
  const { w } = c
  w.c = col
  w.face = MAT.stone
  prism(w, rectOf(f, d), base, y)
}

// —————————————————————— 民居、大宅 ——————————————————————

function house(c: Ctx, s: Site) {
  const { w } = c
  const { storey } = c.kit
  const { b, f, fac, g1, base, tone, t2, t3 } = s
  const large = b.kind === 'large'
  const floors = Math.max(1, s.floors)
  // 墙：青砖为主，一部分粉墙
  const white = t2 < 0.3
  const wm = white ? MAT.plaster : MAT.brick
  const wallCol = white ? shade(WHITEWASH, 0.94 + t3 * 0.08) : pick(GREY_BRICK, t3)
  const roofCol = pick(ROOF.grey, tone)
  w.roofFace = MAT.tileEast
  w.roofTh = 0.3
  w.gableFace = wm
  w.soffit = MAT.rafter
  const top = g1 + floors * storey * (large ? 1 : 0.9)
  // 进深、面宽都在十三米以上的宅地（邸店、大宅）：一栋大屋顶会高出十多米，改成四面围合的合院
  if (floors === 1 && f.b >= 6.5 && b.poly.length <= 6) return courtyard(c, s, wallCol, wm, roofCol, top)
  // 正面（开门的一面）是木装修：平房是通间的槅扇，楼房底层是铺面
  const front = (i: number) => (i === fac.door ? (floors > 1 ? { face: wm | WIN | DOOR, style: STYLE.shop } : { face: MAT.hall | WIN, style: STYLE.lattice, c: WOOD }) : null)
  w.c = wallCol
  w.face = wm | WIN
  walls(w, b.poly, base, top, { win: fac.win, door: fac.door, alt: fac.door >= 0 ? front : undefined })
  if (large && f.b >= 4.6 && f.a > f.b * 1.15) {
    const r = irimoya(w, f, top, 0.64, 1.1, roofCol, wallCol, 'curved', { upturn: 0.3, ribs: 0.13 })
    ridgeBar(w, f, r.r, r.yr, 0.3, shade(roofCol, 0.8))
    return
  }
  // 硬山：两山出际很小
  gable(w, f, top, 0.58 + t2 * 0.08, large ? 0.85 : 0.65, roofCol, wallCol, 'curved', 0.3)
}

/**
 * 合院：后面的正房最高最深，两侧厢房次之，临街的倒座最矮；各自硬山两坡，围出当中的院子。
 * 临街的墙只在倒座当中开门，朝院子的一面开窗与槅扇
 */
function courtyard(c: Ctx, s: Site, wallCol: RGB, wm: number, roofCol: RGB, top: number) {
  const { w } = c
  const { b, f, fac, base, t2 } = s
  // 正面朝向：开门那面墙（没有门时取 −v）
  let n: [number, number] = [-f.v[0], -f.v[1]]
  if (fac.door >= 0) {
    const p = b.poly[fac.door]
    const q = b.poly[(fac.door + 1) % b.poly.length]
    n = [(p[0] + q[0]) / 2 - f.c[0], (p[1] + q[1]) / 2 - f.c[1]]
  }
  const alongV = Math.abs(n[0] * f.v[0] + n[1] * f.v[1]) >= Math.abs(n[0] * f.u[0] + n[1] * f.u[1])
  // F：u 横向，v 指向正面（保持左右手系：转 90° 或 180°）
  let F: Frame = alongV ? f : turned(f)
  if (n[0] * F.v[0] + n[1] * F.v[1] < 0) F = { ...F, u: [-F.u[0], -F.u[1]], v: [-F.v[0], -F.v[1]] }
  const A = F.a
  const B = F.b
  const d = clamp(Math.min(A, B) * 0.34, 4.2, 7.5)
  const k = 0.58 + t2 * 0.06
  w.roofFace = MAT.tileEast
  w.gableFace = wm
  w.soffit = MAT.rafter
  /** 一栋房：r 为房的框（u 沿屋脊），朝院子开窗槅扇，临街的一面按 door 开门 */
  const range = (r: Frame, y: number, street: boolean) => {
    const ring = rectOf(r)
    const inner = edgeFacing(ring, [F.c[0] - r.c[0], F.c[1] - r.c[1]])
    const outer = (inner + 2) % 4
    w.c = wallCol
    w.face = wm | WIN
    walls(w, ring, base, y, {
      win: ring.map((_, i) => i === inner),
      door: street ? outer : -1,
      alt: (i) => (i === inner ? { face: MAT.hall | WIN, style: STYLE.lattice, c: WOOD } : null),
    })
    w.roofTh = 0.28
    const g = gable(w, r, y, k, 0.6, roofCol, wallCol, 'curved', 0.3)
    ridgeBar(w, r, r.a + 0.1, g.yr, 0.26, shade(roofCol, 0.8))
  }
  // 正房（后）、倒座（前）：屋脊沿 u
  range(sub(F, 0, -(B - d / 2), A, d / 2), top + 0.6, false)
  const df = d * 0.8
  range(sub(F, 0, B - df / 2, A, df / 2), top - 0.3, true)
  // 厢房：屋脊沿 v，夹在正房与倒座之间
  const ds = d * 0.82
  const len = (2 * B - d - df) / 2
  if (len > 1.5)
    for (const sd of [-1, 1]) {
      const sf = sub(F, sd * (A - ds / 2), (B - df - (B - d)) / 2, ds / 2, len)
      range(turned(sf), top, false)
    }
}

// —————————————————————— 寺观的殿、祠庙 ——————————————————————

function temple(c: Ctx, s: Site, palace: boolean) {
  const { w } = c
  const { f, g1, base, tone, t3 } = s
  if (Math.max(f.a, f.b) < 2.6) return miniShrine(c, s)
  const big = f.b >= 5.5
  const glazed = palace || (c.capital && hashOf(tone, 4) > 0.55)
  const roof = palace ? ROOF.glazeYellow : glazed ? (hashOf(tone, 5) > 0.5 ? ROOF.glazeGreen : ROOF.glazeYellow) : pick(ROOF.grey, tone)
  const ph = clamp(0.4 + f.b * 0.1, 0.5, 1.9)
  const y0 = g1 + ph
  if (big) terrace(w, f, 1.2 + f.b * 0.08, base, y0, g1, { rails: true, stairs: Math.min(f.a * 0.3, 4.5) })
  else {
    podium(c, f, 0.7, base, y0)
  }
  hallEA(c, {
    f,
    y0,
    col: palace ? PALACE_RED : t3 > 0.6 ? OCHRE : LACQUER,
    roof,
    roofFace: MAT.tileEast,
    form: f.a > f.b * 2.4 && big ? 'hip' : f.b < 3 ? 'gable' : 'irimoya',
    wallH: clamp(3.3 + f.b * 0.3, 3.5, 7),
    k: 0.64,
    over: clamp(0.9 + f.b * 0.14, 1.1, 2.8),
    dg: big ? 1.05 : f.b >= 3 ? 0.6 : 0,
    upturn: clamp(f.b * 0.09, 0.3, 0.9),
    ribs: f.b >= 3 ? clamp(f.b * 0.03, 0.13, 0.26) : 0,
    double: f.b >= 8.5,
    porch: f.b >= 6.5 ? 2.4 : 0,
    gableCol: palace ? PALACE_RED : LACQUER,
  })
}

/** 土地庙、祠：一间小屋，砖墙朱门，小两坡顶 */
function miniShrine(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, tone } = s
  podium(c, f, 0.25, base, g1 + 0.25)
  const top = g1 + 0.25 + 1.9 + f.b * 0.3
  w.c = pick(GREY_BRICK, tone)
  w.face = MAT.brick | WIN
  const front = (i: number) => (i === 0 ? { face: MAT.hall | WIN, style: STYLE.lattice, c: LACQUER } : null)
  walls(w, b.poly, g1 + 0.2, top, { win: [true, false, false, false], door: -1, alt: front })
  w.roofFace = MAT.tileEast
  w.roofTh = 0.2
  w.gableFace = MAT.brick
  w.soffit = MAT.rafter
  gable(w, f, top, 0.62, 0.45, pick(ROOF.grey, tone), pick(GREY_BRICK, tone), 'curved', 0.4)
}

// —————————————————————— 厅、廊、门、影壁 ——————————————————————

function hallKind(c: Ctx, s: Site, palace: boolean, role: string | undefined) {
  const { f, g1, base, tone } = s
  if (role === 'screen' || f.b < 1.15) return screenWall(c, s, palace)
  if (role === 'gallery' || (f.b < 2.5 && f.a > f.b * 2.6)) return gallery(c, f, base, g1, palace, tone)
  const roof = palace ? ROOF.glazeYellow : pick(ROOF.grey, tone)
  const col = palace ? PALACE_RED : hashOf(tone, 3) > 0.5 ? LACQUER : shade(WOOD, 1.15)
  const ph = clamp(0.3 + f.b * 0.05, 0.35, 0.9)
  podium(c, f, 0.5, base, g1 + ph)
  hallEA(c, {
    f,
    y0: g1 + ph,
    col,
    roof,
    roofFace: MAT.tileEast,
    form: f.b < 2.8 ? 'gable' : 'irimoya',
    wallH: clamp(3 + f.b * 0.25, 3.1, 5.6),
    k: 0.62,
    over: clamp(0.8 + f.b * 0.12, 0.9, 2),
    dg: f.b >= 4.5 ? 0.6 : 0,
    upturn: clamp(f.b * 0.08, 0.25, 0.6),
    ribs: f.b >= 3.4 ? 0.14 : 0,
    gableCol: palace ? PALACE_RED : col,
  })
}

/** 廊：两面敞开的柱廊，卷棚的小两坡顶 */
function gallery(c: Ctx, f: Frame, base: number, g1: number, palace: boolean, tone: number) {
  const { w } = c
  const col = palace ? PALACE_RED : LACQUER
  const roof = palace ? ROOF.glazeYellow : pick(ROOF.grey, tone)
  podium(c, f, 0.3, base, g1 + 0.3)
  const top = g1 + 0.3 + 3
  w.c = col
  w.face = MAT.hall | WIN
  w.style = STYLE.arcade
  walls(w, rectOf(f), g1 + 0.3, top, { win: [true, false, true, false], door: -1 })
  w.style = 0
  w.roofFace = MAT.tileEast
  w.roofTh = 0.26
  w.gableFace = MAT.plaster
  w.soffit = MAT.rafter
  gable(w, f, top, 0.55, 0.7, roof, col, 'curved', 0.4)
}

/** 影壁、照壁：一堵带瓦顶的墙 */
function screenWall(c: Ctx, s: Site, palace: boolean) {
  const { w } = c
  const { f, g1, base, tone } = s
  const top = g1 + 3.4
  w.c = palace ? PALACE_RED : pick(GREY_BRICK, tone)
  w.face = palace ? MAT.plaster : MAT.brick
  podium(c, f, 0.15, base, g1 + 0.4)
  w.c = palace ? PALACE_RED : pick(GREY_BRICK, tone)
  w.face = palace ? MAT.plaster : MAT.brick
  walls(w, rectOf(f), g1 + 0.4, top)
  w.roofFace = MAT.tileEast
  w.roofTh = 0.16
  w.gableFace = w.face
  w.soffit = MAT.plain
  gable(w, f, top, 0.7, 0.35, palace ? ROOF.glazeYellow : pick(ROOF.grey, tone), w.c, 'curved', 0.4)
}

// —————————————————————— 宫城的大殿 ——————————————————————

/**
 * 宫城中轴上的殿与门（生成器给的是一条长矩形）：进深大的是正殿——多层白石台基上的重檐庑殿；
 * 面宽远大于进深时两侧分出朵殿、廊庑与尽端的阁，进深小的是门殿与两侧的廊
 */
function palaceHall(c: Ctx, s: Site, roof: RGB) {
  const { w } = c
  const { f, g1, base } = s
  const A = f.a
  const B = f.b
  if (B < 5.2) {
    // 门殿：当中一座歇山的门，两侧是廊
    const ha = Math.min(A, Math.max(B * 2.8, 8))
    podium(c, f, 0.6, base, g1 + 0.9)
    hallEA(c, { f: sub(f, 0, 0, ha, B), y0: g1 + 0.9, col: PALACE_RED, roof, roofFace: MAT.tileEast, form: 'irimoya', wallH: 4.6, k: 0.64, over: 1.5, dg: 0.75, upturn: 0.5, ribs: 0.16 })
    const R = A - ha
    if (R > 3) for (const sd of [-1, 1]) flank(c, sub(f, sd * (ha + R / 2), 0, R / 2, Math.min(B * 0.8, 2.6)), g1 + 0.9, roof)
    return
  }
  // 台基：一至三层，逐层收进
  const tiers = B >= 12 ? 3 : B >= 7.5 ? 2 : 1
  const m = clamp(B * 0.3, 2, 8)
  const th = B >= 12 ? 1.35 : 1.1
  const hb = B - m
  const ha = Math.min(A - m, hb * 2.5)
  for (let i = 0; i < tiers; i++) {
    const d = m - (m * (i + 0.15)) / tiers
    // 只有最下一层铺满整个平面；上两层只托着正殿
    const tf = i === 0 ? { ...f, a: A - m, b: hb } : sub(f, 0, 0, ha + m * 0.6, hb)
    terrace(w, tf, d, i === 0 ? base : g1 + th * i - 0.05, g1 + th * (i + 1), g1 + th * i, { rails: true, stairs: Math.min(ha * 0.3, 7), sides: i > 0 || A - m < ha * 1.3 })
  }
  const y0 = g1 + th * tiers
  hallEA(c, {
    f: sub(f, 0, 0, ha, hb),
    y0,
    col: PALACE_RED,
    roof,
    roofFace: MAT.tileEast,
    form: hb >= 6.5 ? 'hip' : 'irimoya',
    wallH: clamp(3.8 + hb * 0.36, 4.4, 8.4),
    k: 0.64,
    over: clamp(1.2 + hb * 0.13, 1.6, 3.2),
    dg: clamp(0.6 + hb * 0.07, 0.75, 1.5),
    upturn: clamp(hb * 0.09, 0.45, 1.1),
    ribs: clamp(hb * 0.028, 0.16, 0.3),
    double: hb >= 6.5,
    porch: hb >= 6.5 ? Math.min(3, hb * 0.26) : 0,
  })
  // 两侧：朵殿、廊庑、尽端的阁（都坐在最下一层台基上）
  const R = A - m - ha
  if (R < 5) return
  const yl = g1 + th
  const wb = Math.max(3.2, hb * 0.62)
  const wa = Math.min((R - 2.5) / 2, wb * 1.7)
  for (const sd of [-1, 1]) {
    const x0 = ha + 2.5
    if (wa < 3) {
      flank(c, sub(f, sd * (ha + R / 2), 0, R / 2, Math.min(2.6, hb * 0.4)), yl, roof)
      continue
    }
    const wing = (x: number, a: number, bb: number) =>
      hallEA(c, { f: sub(f, sd * x, 0, a, bb), y0: yl + 0.45, col: PALACE_RED, roof, roofFace: MAT.tileEast, form: 'irimoya', wallH: clamp(3.4 + bb * 0.3, 3.8, 6), k: 0.64, over: clamp(1 + bb * 0.12, 1.3, 2.2), dg: 0.75, upturn: 0.5, ribs: 0.16 })
    podium(c, sub(f, sd * (x0 + wa), 0, wa, wb), 0.5, yl - 0.1, yl + 0.45)
    wing(x0 + wa, wa, wb)
    const rest = R - 2.5 - wa * 2
    if (rest > 6) {
      // 尽端的阁与连接的廊
      const ea = Math.min(wb * 1.1, rest * 0.3)
      const gl = rest - ea * 2
      if (gl > 2) flank(c, sub(f, sd * (x0 + wa * 2 + gl / 2), 0, gl / 2 + 0.3, Math.min(2.6, wb * 0.5)), yl, roof)
      podium(c, sub(f, sd * (A - m - ea), 0, ea, wb * 0.9), 0.5, yl - 0.1, yl + 0.45)
      wing(A - m - ea, ea, wb * 0.9)
    } else if (rest > 1) flank(c, sub(f, sd * (x0 + wa * 2 + rest / 2), 0, rest / 2 + 0.3, Math.min(2.6, wb * 0.5)), yl, roof)
  }
}

/** 殿侧的廊庑：朱柱的敞廊，黄瓦的小两坡顶 */
function flank(c: Ctx, f: Frame, y0: number, roof: RGB) {
  const { w } = c
  const top = y0 + 3.6
  w.c = PALACE_RED
  w.face = MAT.hall | WIN
  w.style = STYLE.arcade
  walls(w, rectOf(f), y0 - 0.1, top, { win: [true, false, true, false], door: -1 })
  w.style = 0
  w.roofFace = MAT.tileEast
  w.roofTh = 0.28
  w.gableFace = MAT.plaster
  w.soffit = MAT.rafter
  gable(w, f, top, 0.58, 0.9, roof, PALACE_RED, 'curved', 0.3)
}

// —————————————————————— 城台上的楼（市楼、鼓楼、宫门、角楼） ——————————————————————

/** 砖砌的城台（四面收分，正中开券门）上一座重檐歇山的楼 */
function gateTower(c: Ctx, s: Site, palace: boolean, baseH: number) {
  const { w } = c
  const { f, g1, base, tone } = s
  const wallCol = palace ? PALACE_RED : pick(GREY_BRICK, tone)
  const yb = g1 + baseH
  const batter = Math.min(0.9, Math.min(f.a, f.b) * 0.12)
  const top = rectOf(f, -batter)
  w.c = wallCol
  w.face = (palace ? MAT.plaster : MAT.brick) | WIN
  w.style = STYLE.portal
  taper(w, rectOf(f), top, base, yb)
  w.style = 0
  w.c = STONE_EAST
  w.face = MAT.stone
  cap(w, top, yb)
  w.c = wallCol
  w.face = palace ? MAT.plaster : MAT.brick
  w.gableFace = w.face
  const tf: Frame = { ...f, a: f.a - batter, b: f.b - batter }
  parapet(w, top, yb, 0.5, 0.3)
  if (!palace) crenels(w, tf, yb + 0.5, 0.3, 0.6, 1.6)
  const d = Math.min(2.2, Math.min(f.a, f.b) * 0.24)
  const hf: Frame = { ...tf, a: tf.a - d, b: tf.b - d }
  hallEA(c, {
    f: hf,
    y0: yb,
    col: palace ? PALACE_RED : LACQUER,
    roof: palace ? ROOF.glazeYellow : pick(ROOF.grey, tone),
    roofFace: MAT.tileEast,
    form: 'irimoya',
    wallH: clamp(3.2 + hf.b * 0.25, 3.4, 5.5),
    k: 0.64,
    over: clamp(0.9 + hf.b * 0.14, 1.2, 2.4),
    dg: hf.b >= 3 ? 0.7 : 0,
    upturn: clamp(hf.b * 0.1, 0.35, 0.8),
    ribs: 0.15,
    double: hf.b >= 3.2,
    open: [true, true, true, true],
  })
}

function civic(c: Ctx, s: Site, palace: boolean, role: string | undefined) {
  const { w } = c
  const { storey } = c.kit
  const { f, g1, base, tone } = s
  // 碑、榜（村口的告示、碑刻）
  if (Math.max(f.a, f.b) < 1.5) {
    w.c = STONE_EAST
    w.face = MAT.stone
    prism(w, rectOf(f, 0.12), base, g1 + 0.35)
    prism(w, rectOf({ ...f, b: Math.min(f.b, 0.14) }), g1 + 0.35, g1 + 2.3)
    return
  }
  if (palace) return gateTower(c, s, true, role === 'corner' ? 9.5 : 10.5)
  // 酒楼、戏台一类：两层的楼，腰檐与歇山顶
  podium(c, f, 0.4, base, g1 + 0.45)
  hallEA(c, {
    f,
    y0: g1 + 0.45,
    col: hashOf(tone, 3) > 0.4 ? LACQUER : shade(WOOD, 1.2),
    roof: pick(ROOF.grey, tone),
    roofFace: MAT.tileEast,
    form: f.b < 2.8 ? 'gable' : 'irimoya',
    wallH: storey,
    k: 0.62,
    over: clamp(0.8 + f.b * 0.1, 0.9, 1.8),
    dg: 0,
    upturn: clamp(f.b * 0.08, 0.25, 0.6),
    ribs: f.b >= 3.2 ? 0.13 : 0,
    double: f.b >= 3.6,
    open: [true, true, true, true],
  })
}

// —————————————————————— 塔、亭 ——————————————————————

function pagodaKind(c: Ctx, s: Site, role: string | undefined, palace: boolean) {
  const { b, f } = s
  const d = Math.min(f.a, f.b) * 2
  const n = b.poly.length >= 8 ? 8 : b.poly.length === 6 ? 6 : 4
  if (d >= 7 && role !== 'pavilion') return pagoda(c, s, n === 8 || s.t2 > 0.45 ? 8 : 4)
  if (role === 'bell' || (d >= 4.2 && d < 5.2 && n === 4)) return gateTower(c, s, palace, 3.4)
  pavilion(c, s, n, palace)
}

/** 楼阁式塔：砖身，逐层收分，层层出檐与平坐，塔刹 */
function pagoda(c: Ctx, s: Site, n: number) {
  const { w } = c
  const { b, f, g1, base, tone } = s
  const ct = centroid(b.poly)
  const r0 = Math.min(f.a, f.b) / (n === 8 ? 1 : Math.SQRT1_2)
  const ph = n === 8 ? Math.PI / 8 : Math.atan2(f.u[1] + f.v[1], f.u[0] + f.v[0])
  const tiers = r0 >= 6 ? 9 : 7
  const body = hex('#b3a48b')
  const roof = pick(ROOF.grey, tone)
  w.c = STONE_EAST
  w.face = MAT.stone
  prism(w, circle(ct, r0 * 1.22, n, ph), base, g1 + 1)
  w.soffit = MAT.rafter
  w.roofFace = MAT.tileEast
  w.roofTh = 0.2
  let y = g1 + 1
  for (let i = 0; i < tiers; i++) {
    const r = r0 * 0.82 * (1 - (i / tiers) * 0.42)
    const h = (i === 0 ? 4.6 : 3.3) * (1 - i * 0.03)
    w.c = body
    w.face = MAT.brick | WIN
    w.style = STYLE.slit
    walls(w, circle(ct, r, n, ph), y - 0.05, y + h)
    w.style = 0
    y += h
    // 出檐：檐下一道叠涩，屋面略翘
    const eo = 1.15 + r * 0.12
    const last = i === tiers - 1
    tent(w, ct, n, ph, r + eo, y - 0.12, last ? 0 : r * 0.9, y + (last ? r * 1.25 : 0.55), roof, 'curved', { upturn: 0.22, ribs: last ? 0.12 : 0 })
    if (!last) {
      // 平坐：上一层脚下的一圈台
      w.c = shade(body, 0.85)
      w.face = MAT.plain
      block(w, circle(ct, r * 0.98, n, ph), y + 0.5, y + 0.75)
      y += 0.75
    } else y += r * 1.25
  }
  finial(w, ct, y - 0.2, r0 * 0.16, r0 * 1.1 + 1.5, hex('#6f6a5c'), MAT.metal)
}

/** 亭：台基、一圈柱、攒尖顶与宝顶；大的重檐 */
function pavilion(c: Ctx, s: Site, n: number, palace: boolean) {
  const { w } = c
  const { b, f, g1, base, tone } = s
  const ct = centroid(b.poly)
  const r = Math.min(f.a, f.b) / (n === 4 ? Math.SQRT1_2 : 1)
  const ph = n === 4 ? Math.atan2(f.u[1] + f.v[1], f.u[0] + f.v[0]) : Math.PI / n
  const roof = palace ? ROOF.glazeYellow : hashOf(tone, 2) > 0.6 ? ROOF.glazeGreen : pick(ROOF.grey, tone)
  const col = palace ? PALACE_RED : LACQUER
  w.c = palace ? MARBLE : STONE_EAST
  w.face = palace ? MAT.marble : MAT.stone
  prism(w, circle(ct, r * 1.05, n, ph), base, g1 + 0.45)
  const hc = 2.5 + r * 0.22
  const top = g1 + 0.45 + hc
  w.c = col
  w.face = MAT.plain
  for (const p of circle(ct, r * 0.84, n, ph)) tube(w, p, 0.13 + r * 0.012, 0.12 + r * 0.01, g1 + 0.45, top, 6)
  // 额枋一圈
  w.face = MAT.hall
  block(w, circle(ct, r * 0.9, n, ph), top - 0.42, top)
  w.soffit = MAT.rafter
  w.roofFace = MAT.tileEast
  w.roofTh = 0.2
  const eo = 0.75 + r * 0.14
  const up = clamp(r * 0.14, 0.25, 0.6)
  let y = top
  if (r >= 3) {
    // 重檐
    tent(w, ct, n, ph, r * 0.9 + eo, y - 0.1, r * 0.55, y + r * 0.3, roof, 'curved', { upturn: up, ribs: 0.12 })
    y += r * 0.3
    w.c = col
    w.face = MAT.hall
    walls(w, circle(ct, r * 0.55, n, ph), y - 0.1, y + 0.9)
    y += 0.9
    tent(w, ct, n, ph, r * 0.55 + eo * 0.8, y - 0.1, 0, y + r * 0.6, roof, 'curved', { upturn: up * 0.8, ribs: 0.12 })
    y += r * 0.6
  } else {
    tent(w, ct, n, ph, r * 0.9 + eo, y - 0.1, 0, y + r * 0.85 + 0.3, roof, 'curved', { upturn: up, ribs: 0.11 })
    y += r * 0.85 + 0.3
  }
  finial(w, ct, y - 0.15, clamp(r * 0.09, 0.14, 0.3), clamp(r * 0.4, 0.6, 1.4), GILT)
}
