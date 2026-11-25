/**
 * 和式建筑：町家（格子的正面、庇）、茅葺的农家、武家屋敷与土藏，寺院的堂（入母屋、深出檐）与回廊，
 * 神社的本殿（高床、桧皮葺的切妻顶、千木与鲣木）与拜殿，天守（石垣、层层收分的白壁与出檐、千鸟破风、鯱）、
 * 橹、五重塔与鸟居。纯函数，在 Worker 中运行。
 */
import { clamp } from '../../../../gen/util'
import { centroid, type P } from '../../../../settlement/geom'
import { DOOR, MAT, STYLE, WIN, at, block, cap, circle, gable, hip, irimoya, lathe, prism, rectOf, shade, skirt, slab, strip, sub, taper, tent, tube, walls, type Frame, type RGB } from '../../../../render/town3d/mesh'
import { finial, hashOf, pent, type Site } from '../../../../render/town3d/kit'
import { hallEA, podium } from '../../eastern/town3d/buildings'
import { mid, type Group } from '../../../../render/town3d/groups'
import { GILT, PLASTER, ROOF, STONE, TIMBER_DARK, VERMILION, WOOD_DARK, WOOD_WA, hex, pick, type Ctx } from '../../../../render/town3d/shared'

/** 町家的墙色：白壁与素木的板壁 */
const WALL = ['#ece6d8', '#e4dccb', '#8d6f52', '#7a5f45'].map(hex)
/** 石垣的石色 */
const ISHIGAKI = hex('#8c877c')
/** 天守的下见板（黑漆的木板壁） */
const BLACK_BOARD = hex('#2e2c2b')

export function wa(c: Ctx, s: Site, g: Group | null) {
  if (g && part(c, s, g)) return
  switch (s.b.kind) {
    case 'torii':
      return torii(c, s)
    case 'house':
    case 'large':
      return house(c, s)
    case 'keep':
      return tenshu(c, s.f, s.base, s.g1, s.f.b * 2 < 9 ? 3 : 5, clamp(4 + s.f.b * 0.5, 5, 9), s.t3 > 0.5)
    case 'tower':
      return yagura(c, s)
    case 'pagoda':
      return Math.min(s.f.a, s.f.b) * 2 >= 5.5 ? gojunoto(c, s) : azumaya(c, s)
    case 'temple':
      return temple(c, s)
    default:
      return hallKind(c, s)
  }
}

/** 多边形第 k 边的外法线 */
function outward(poly: P[], k: number): P {
  const a = poly[k]
  const b = poly[(k + 1) % poly.length]
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  let n: P = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]
  const m = mid(poly)
  if (((a[0] + b[0]) / 2 - m[0]) * n[0] + ((a[1] + b[1]) / 2 - m[1]) * n[1] < 0) n = [-n[0], -n[1]]
  return n
}

// —————————————————————— 町家、农家、屋敷 ——————————————————————

function house(c: Ctx, s: Site) {
  const { w } = c
  const { storey } = c.kit
  const { b, f, fac, g1, base, tone, t2, t3, t4 } = s
  const large = b.kind === 'large'
  const floors = Math.max(1, s.floors)
  const wallCol = pick(WALL, t3)
  w.gableFace = MAT.wa
  w.soffit = MAT.rafter
  // 茅葺的农家：低矮的平房，厚厚的寄栋草顶
  if (!large && floors === 1 && t4 > 0.76 && f.b > 2.6) {
    const top = g1 + 2.5
    w.c = wallCol
    w.face = MAT.wa | WIN
    walls(w, b.poly, base, top, fac)
    w.roofFace = MAT.thatch
    w.roofTh = 0.5
    w.soffit = MAT.plain
    const roof = pick(ROOF.thatch, tone)
    const r = hip(w, f, top, 1.05, 0.7, roof)
    // 草顶的脊：压一道木与树皮的盖
    if (r.r > 0.3) {
      w.c = shade(roof, 0.62)
      w.face = MAT.plain
      block(w, [at(f, -r.r - 0.3, -0.42), at(f, r.r + 0.3, -0.42), at(f, r.r + 0.3, 0.42), at(f, -r.r - 0.3, 0.42)], r.yr - 0.32, r.yr + 0.22)
    }
    return
  }
  const tile = large || t4 < 0.55
  const roofCol = tile ? pick(ROOF.kawara, tone) : pick(ROOF.shingle, tone)
  w.roofFace = tile ? MAT.tileEast : MAT.shingle
  w.roofTh = tile ? 0.26 : 0.14
  const top = g1 + floors * storey * (large ? 0.95 : 0.86)
  // 正面：平房是通间的格子与障子，楼房底层是铺面
  const front = (i: number) => (i === fac.door ? (floors > 1 ? { face: MAT.wa | WIN | DOOR, style: STYLE.shop } : { face: MAT.hall | WIN, style: STYLE.lattice, c: WOOD_WA }) : null)
  w.c = wallCol
  w.face = MAT.wa | WIN
  walls(w, b.poly, base, top, { win: fac.win, door: fac.door, alt: fac.door >= 0 ? front : undefined })
  if (large && f.b >= 4 && f.a > f.b * 1.15) {
    const r = irimoya(w, f, top, 0.58, 0.95, roofCol, PLASTER, 'curved', { upturn: 0.12, ribs: 0.11 })
    ridgeTile(c, f, r.r, r.yr, roofCol)
  } else {
    const r = gable(w, f, top, 0.5 + t2 * 0.08, 0.6, roofCol, wallCol, 'curved', 0.5)
    if (tile && f.b > 2.5) ridgeTile(c, f, f.a + 0.2, r.yr, roofCol)
  }
  // 庇：正面底层上方的一道披檐
  if (fac.door >= 0 && (floors > 1 || t3 > 0.35) && top - g1 > 3.1) {
    const a = b.poly[fac.door]
    const q = b.poly[(fac.door + 1) % b.poly.length]
    w.roofTh = 0.1
    w.soffit = MAT.rafter
    pent(w, a, q, outward(b.poly, fac.door), 0.85, g1 + 2.75, 0.3, roofCol, 0.05)
  }
}

/** 瓦顶的大栋：屋脊上叠起的一道熨斗瓦，两端的鬼瓦 */
function ridgeTile(c: Ctx, f: Frame, r: number, y: number, roof: RGB) {
  const { w } = c
  if (r < 0.3) return
  w.c = shade(roof, 0.8)
  w.face = MAT.plain
  block(w, [at(f, -r, -0.16), at(f, r, -0.16), at(f, r, 0.16), at(f, -r, 0.16)], y - 0.2, y + 0.22)
  for (const e of [-1, 1]) block(w, rectOf(sub(f, e * (r - 0.05), 0, 0.12, 0.24)), y + 0.1, y + 0.5)
}

// —————————————————————— 寺院的堂、回廊，神社 ——————————————————————

function hallKind(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, tone, t3 } = s
  const shrine = /殿|社|回廊/.test(b.role ?? '')
  const roof = shrine ? pick(ROOF.shingle, tone) : pick(ROOF.kawara, tone)
  const roofFace = shrine ? MAT.shingle : MAT.tileEast
  if (f.b < 2.5 && f.a > f.b * 2.6) {
    // 回廊：一面连子窗、一面敞开的廊
    podium(c, f, 0.25, base, g1 + 0.3, STONE)
    const top = g1 + 0.3 + 2.9
    w.c = shrine || t3 > 0.5 ? VERMILION : WOOD_WA
    w.face = MAT.hall | WIN
    w.style = STYLE.arcade
    walls(w, rectOf(f), g1 + 0.3, top, { win: [true, false, true, false], door: -1 })
    w.style = 0
    w.roofFace = roofFace
    w.roofTh = 0.24
    w.gableFace = MAT.plaster
    w.soffit = MAT.rafter
    gable(w, f, top, 0.5, 0.75, roof, PLASTER, 'curved', 0.4)
    return
  }
  const ph = clamp(0.3 + f.b * 0.06, 0.35, 1)
  podium(c, f, 0.6, base, g1 + ph, STONE)
  hallEA(c, {
    f,
    y0: g1 + ph,
    col: shrine ? VERMILION : t3 > 0.6 ? WOOD_DARK : WOOD_WA,
    roof,
    roofFace,
    form: f.b < 2.6 ? 'gable' : 'irimoya',
    wallH: clamp(2.9 + f.b * 0.22, 3, 5.2),
    k: 0.6,
    over: clamp(1 + f.b * 0.16, 1.1, 2.6),
    dg: f.b >= 4 ? 0.45 : 0,
    upturn: clamp(f.b * 0.035, 0.1, 0.3),
    ribs: f.b >= 3.2 ? 0.12 : 0,
    gableCol: PLASTER,
    // 楼门、仁王门一类进深大的门：重檐
    double: f.b >= 3.2 && f.a < f.b * 1.6 && f.b < 5 && hashOf(tone, 7) > 0.4,
    open: [true, true, true, true],
  })
}

function temple(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, tone } = s
  // 祠：石台上一座小小的社
  if (Math.max(f.a, f.b) < 1.6) {
    w.c = STONE
    w.face = MAT.stone
    prism(w, rectOf(f, 0.1), base, g1 + 0.5)
    const sf: Frame = { ...f, a: f.a * 0.6, b: f.b * 0.6 }
    w.c = WOOD_WA
    w.face = MAT.board
    walls(w, rectOf(sf), g1 + 0.5, g1 + 1.25)
    w.roofFace = MAT.shingle
    w.roofTh = 0.07
    w.gableFace = MAT.board
    gable(w, sf, g1 + 1.25, 0.8, 0.3, pick(ROOF.shingle, tone), WOOD_WA, 'curved', 0.6)
    return
  }
  const shrine = b.part === 'honden' || /本殿|奥社|摄社|社$/.test(b.role ?? '')
  if (shrine) return honden(c, s)
  // 本堂、金堂：石坛上的入母屋大殿，出檐深远
  const ph = clamp(0.5 + f.b * 0.07, 0.6, 1.5)
  podium(c, f, 0.9, base, g1 + ph, STONE)
  hallEA(c, {
    f,
    y0: g1 + ph,
    col: hashOf(tone, 3) > 0.7 ? VERMILION : WOOD_DARK,
    roof: pick(ROOF.kawara, tone),
    roofFace: MAT.tileEast,
    form: 'irimoya',
    wallH: clamp(3.2 + f.b * 0.3, 3.4, 6.5),
    k: 0.66,
    over: clamp(1.3 + f.b * 0.2, 1.5, 3.4),
    dg: f.b >= 3.5 ? 0.6 : 0,
    upturn: clamp(f.b * 0.04, 0.12, 0.4),
    ribs: 0.14,
    gableCol: PLASTER,
    double: f.b >= 8,
    porch: f.b >= 6 ? 2 : 0,
    open: [true, true, true, true],
  })
}

/** 神社的本殿：高床、缘侧一圈、朱柱白壁，桧皮葺的切妻顶，脊上千木与鲣木 */
function honden(c: Ctx, s: Site) {
  const { w } = c
  const { f, g1, base, tone } = s
  const fl = g1 + clamp(0.8 + f.b * 0.12, 0.9, 1.8)
  // 床下：收进去的束柱一圈（暗处）
  w.c = WOOD_DARK
  w.face = MAT.board
  walls(w, rectOf(f, -0.5), base, fl)
  // 缘侧：挑出的一圈板台与栏杆
  w.c = VERMILION
  w.face = MAT.plain
  block(w, rectOf(f, 0.75), fl - 0.22, fl)
  w.c = shade(VERMILION, 0.9)
  const rr = rectOf(f, 0.68)
  for (let e = 0; e < 4; e++) block(w, strip(rr[e], rr[(e + 1) % 4], 0.05), fl + 0.55, fl + 0.65)
  const top = fl + clamp(2.6 + f.b * 0.3, 2.8, 4.6)
  w.c = VERMILION
  w.face = MAT.hall | WIN
  w.style = STYLE.lattice
  walls(w, rectOf(f), fl, top, { win: [true, false, true, false], door: -1 })
  w.style = 0
  const roof = pick(ROOF.shingle, tone)
  w.roofFace = MAT.shingle
  w.roofTh = 0.3
  w.gableFace = MAT.plaster
  w.soffit = MAT.rafter
  const r = gable(w, f, top, 0.85, clamp(0.9 + f.b * 0.25, 1, 2.4), roof, PLASTER, 'curved', 0.7)
  // 鲣木：横在脊上的几根圆木；千木：脊两端交叉上翘的一对
  const n = Math.max(3, Math.min(7, Math.round(f.a / 0.9)))
  w.c = WOOD_DARK
  w.face = MAT.plain
  block(w, [at(f, -f.a - 0.4, -0.14), at(f, f.a + 0.4, -0.14), at(f, f.a + 0.4, 0.14), at(f, -f.a - 0.4, 0.14)], r.yr - 0.1, r.yr + 0.2)
  for (let i = 0; i < n; i++) block(w, rectOf(sub(f, (-1 + (2 * (i + 0.5)) / n) * f.a * 0.8, 0, 0.13, 0.55)), r.yr + 0.2, r.yr + 0.46)
  w.c = shade(GILT, 0.9)
  for (const e of [-1, 1])
    for (const sd of [-1, 1]) {
      const x = e * (f.a + 0.35)
      slab(w, at(f, x, -sd * 0.55), at(f, x, sd * 1.05), 0.07, r.yr - 0.35, r.yr + 1.55, 0.2)
    }
}
// —————————————————————— 天守、橹 ——————————————————————

/**
 * 天守：石垣上逐层收分的几重（每重一圈出檐，隔一重在长面上起千鸟破风），顶层入母屋，脊两端立鯱。
 * f 为天守台的框，ish 为石垣高；black 为下见板张（黑），否则白壁
 */
function tenshu(c: Ctx, f: Frame, base: number, g1: number, tiers: number, ish: number, black: boolean, small = false) {
  const { w } = c
  const roof = ROOF.kawara[1]
  // 石垣：下大上小，略带弧度（分两段收）
  const spread = Math.max(1.2, ish * 0.32)
  w.c = ISHIGAKI
  w.face = MAT.stone
  taper(w, rectOf(f, spread), rectOf(f, spread * 0.3), base, g1 + ish * 0.55)
  taper(w, rectOf(f, spread * 0.3), rectOf(f), g1 + ish * 0.55, g1 + ish)
  cap(w, rectOf(f), g1 + ish)
  w.roofFace = MAT.tileEast
  w.roofTh = 0.28
  w.soffit = MAT.rafter
  w.gableFace = MAT.plaster
  const side = Math.min(f.a, f.b)
  const step = (side * 0.62) / Math.max(1, tiers - 1)
  let y = g1 + ish
  for (let i = 0; i < tiers; i++) {
    const t: Frame = { ...f, a: f.a - step * i - 0.25, b: f.b - step * i - 0.25 }
    const h = (i === 0 ? 4 : 3.3) * (small ? 0.88 : 1)
    // 墙：白壁；下见板张的下半是黑漆木板
    if (black) {
      w.c = BLACK_BOARD
      w.face = MAT.board
      walls(w, rectOf(t), y - 0.05, y + h * 0.55)
      w.c = PLASTER
      w.face = MAT.plaster | WIN
      w.style = STYLE.slit
      walls(w, rectOf(t), y + h * 0.55, y + h, { win: [true, true, true, true], door: -1 })
    } else {
      w.c = PLASTER
      w.face = MAT.plaster | WIN
      w.style = STYLE.slit
      walls(w, rectOf(t), y - 0.05, y + h, { win: [true, true, true, true], door: -1 })
    }
    w.style = 0
    y += h
    const over = 1.25 + (tiers - i) * 0.08
    if (i === tiers - 1) {
      const r = irimoya(w, t, y, 0.62, over, roof, PLASTER, 'curved', { upturn: 0.3, ribs: 0.13 })
      ridgeTile(c, t, r.r, r.yr, roof)
      // 鯱
      w.c = GILT
      w.face = MAT.gilt
      for (const e of [-1, 1]) {
        const p = at(t, e * (r.r - 0.1), 0)
        lathe(w, p, r.yr + 0.3, [[0.2, 0], [0.26, 0.25], [0.1, 0.75], [0, 1]], 6)
      }
      return
    }
    const rise = step * 0.48 + 0.2
    const ye = skirt(w, t, y, over, step, y + rise, roof, 'curved', { upturn: 0.3, ribs: 0.13 })
    // 千鸟破风：出檐上三角形的小山墙，隔一重设在长面或短面
    const onLong = i % 2 === 0
    const span = onLong ? t.a : t.b
    const depthHalf = (step + over * 0.55) / 2
    const wc = Math.min(span * 0.34, 3.4) * (small ? 0.8 : 1)
    if (wc > 1.1 && !(small && i > 0)) {
      for (const sd of [-1, 1]) {
        const inner = (onLong ? t.b : t.a) - step
        const ctr = onLong ? at(t, 0, sd * (inner + depthHalf)) : at(t, sd * (inner + depthHalf), 0)
        const u: P = onLong ? [t.v[0] * sd, t.v[1] * sd] : [t.u[0] * sd, t.u[1] * sd]
        const gf: Frame = { c: ctr, u, v: [-u[1], u[0]], a: depthHalf, b: wc }
        w.gableWin = false
        gable(w, gf, ye + 0.25, Math.min(0.95, (rise + 2.2) / wc), 0.25, roof, PLASTER, 'curved', 0.5)
      }
    }
    y += rise
  }
}

function yagura(c: Ctx, s: Site) {
  const { f, g1, base, t3 } = s
  // 橹：矮石垣上的两重
  tenshu(c, f, base, g1, 2, Math.min(4.5, 2 + Math.min(f.a, f.b) * 0.4), t3 > 0.6, true)
}

/** 天守群的共同量：石垣高、黑白、重数 */
interface Castle {
  ish: number
  black: boolean
  tiers: number
  g1: number
}
function castleOf(c: Ctx, g: Group): Castle | null {
  if (g.memo.has('castle')) return g.memo.get('castle') as Castle | null
  const main = g.of('tenshu')[0]
  let out: Castle | null = null
  if (main) {
    let g1 = -Infinity
    for (const p of main.poly) g1 = Math.max(g1, c.H(p[0], p[1]))
    let a = 0
    for (let i = 0; i < main.poly.length; i++) a = Math.max(a, Math.hypot(main.poly[i][0] - main.poly[(i + 1) % main.poly.length][0], main.poly[i][1] - main.poly[(i + 1) % main.poly.length][1]))
    // 重数：大天守的台上叠着几块逐层收小的平面（生成器给的）
    const tiers = clamp(g.of('tenshuTier').length + 1, 3, 5)
    out = { ish: clamp(4.5 + a * 0.16, 6, 10), black: g.seed > 0.55, tiers, g1 }
  }
  g.memo.set('castle', out)
  return out
}

function part(c: Ctx, s: Site, g: Group): boolean {
  const p = s.b.part!
  if (p === 'honden') {
    honden(c, s)
    return true
  }
  const k = castleOf(c, g)
  if (!k) return false
  const { f, base } = s
  switch (p) {
    case 'tenshu':
      tenshu(c, f, base, k.g1, k.tiers, k.ish, k.black)
      return true
    case 'tenshuTier':
    case 'tierSmall':
      // 逐层收小的平面只是生成器给二维图的示意：立体由大天守一并搭出
      return true
    case 'kotenshu':
      tenshu(c, f, base, k.g1, 3, k.ish, k.black, true)
      return true
    case 'tsuke':
      tenshu(c, f, base, k.g1, 2, k.ish * 0.85, k.black, true)
      return true
    case 'watari': {
      // 渡橹：石垣上一段白壁的廊，连着大小天守
      const { w } = c
      w.c = ISHIGAKI
      w.face = MAT.stone
      const sp = k.ish * 0.2
      taper(w, rectOf(f, sp), rectOf(f), base, k.g1 + k.ish)
      w.c = PLASTER
      w.face = MAT.plaster | WIN
      w.style = STYLE.slit
      walls(w, rectOf(f), k.g1 + k.ish, k.g1 + k.ish + 3.4, { win: [true, true, true, true], door: -1 })
      w.style = 0
      w.roofFace = MAT.tileEast
      w.roofTh = 0.26
      w.soffit = MAT.rafter
      w.gableFace = MAT.plaster
      hip(w, f, k.g1 + k.ish + 3.4, 0.55, 0.9, ROOF.kawara[1], 'curved', { upturn: 0.15 })
      return true
    }
  }
  return false
}

// —————————————————————— 五重塔、亭、鸟居 ——————————————————————

/** 五重塔：方形，五重深远的出檐逐层略收，顶上相轮 */
function gojunoto(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, tone } = s
  const ct = centroid(b.poly)
  const r0 = Math.min(f.a, f.b)
  const ph = Math.atan2(f.u[1] + f.v[1], f.u[0] + f.v[0])
  const roof = pick(ROOF.kawara, tone)
  const col = hashOf(tone, 3) > 0.45 ? VERMILION : WOOD_DARK
  w.c = STONE
  w.face = MAT.stone
  prism(w, circle(ct, r0 * 1.25 * Math.SQRT2, 4, ph), base, g1 + 0.9)
  w.soffit = MAT.rafter
  w.roofFace = MAT.tileEast
  w.roofTh = 0.22
  let y = g1 + 0.9
  const tiers = 5
  for (let i = 0; i < tiers; i++) {
    const r = r0 * 0.62 * (1 - i * 0.075)
    const h = i === 0 ? 3.6 : 2.5
    const sq: Frame = { c: ct, u: f.u, v: f.v, a: r, b: r }
    w.c = col
    w.face = MAT.hall | WIN
    w.style = STYLE.lattice
    walls(w, rectOf(sq), y - 0.05, y + h, { win: [i === 0, i === 0, i === 0, i === 0], door: -1 })
    w.style = 0
    // 斗拱：墙顶一圈
    w.face = MAT.dougong
    w.style = 3
    walls(w, rectOf(sq, 0.3), y + h - 0.45, y + h)
    w.style = 0
    y += h
    const eo = (2.1 + r0 * 0.16) * (1 - i * 0.05)
    const last = i === tiers - 1
    tent(w, ct, 4, ph, (r + 0.3 + eo) * Math.SQRT2, y - 0.25, last ? 0 : r * 0.9 * Math.SQRT2, y + (last ? r * 1.1 + 0.6 : 0.75), roof, 'curved', { upturn: 0.3, ribs: 0.11 })
    y += last ? r * 1.1 + 0.6 : 0.75
    if (!last) {
      // 缘：上一重脚下的栏杆台
      w.c = col
      w.face = MAT.plain
      block(w, rectOf(sq, 0.35 - r0 * 0.045), y, y + 0.3)
      y += 0.3
    }
  }
  // 相轮：露盘、九轮、水烟、宝珠
  w.c = hex('#5c5a4a')
  w.face = MAT.metal
  const hs = r0 * 1.5 + 2.5
  const prof: [number, number][] = [[0.42, 0], [0.42, 0.3], [0.12, 0.34]]
  for (let i = 0; i < 9; i++) {
    const yy = 0.6 + (i / 9) * hs * 0.62
    const rr = 0.36 - i * 0.022
    prof.push([0.1, yy], [rr, yy + 0.04], [rr, yy + 0.14], [0.1, yy + 0.18])
  }
  prof.push([0.08, hs * 0.72], [0.2, hs * 0.8], [0.06, hs * 0.92], [0, hs])
  lathe(w, ct, y - 0.2, prof, 8)
}

/** 东屋：四根柱子托着的宝形小顶 */
function azumaya(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, tone } = s
  const ct = centroid(b.poly)
  const r = Math.min(f.a, f.b)
  const n = b.poly.length >= 6 ? 6 : 4
  const ph = n === 4 ? Math.atan2(f.u[1] + f.v[1], f.u[0] + f.v[0]) : Math.PI / n
  const R = n === 4 ? r * Math.SQRT2 : r
  w.c = STONE
  w.face = MAT.stone
  prism(w, circle(ct, R * 1.02, n, ph), base, g1 + 0.25)
  const top = g1 + 0.25 + 2.3
  w.c = WOOD_WA
  w.face = MAT.plain
  for (const p of circle(ct, R * 0.82, n, ph)) tube(w, p, 0.09, 0.09, g1 + 0.25, top, 6)
  block(w, circle(ct, R * 0.88, n, ph), top - 0.25, top)
  const thatch = hashOf(tone, 4) > 0.5
  w.roofFace = thatch ? MAT.thatch : MAT.shingle
  w.roofTh = thatch ? 0.3 : 0.14
  w.soffit = thatch ? MAT.plain : MAT.rafter
  tent(w, ct, n, ph, R * 1.35 + 0.4, top - 0.2, 0, top + r * 0.9, thatch ? pick(ROOF.thatch, tone) : pick(ROOF.shingle, tone), 'curved')
  finial(w, ct, top + r * 0.85, 0.12, 0.45, TIMBER_DARK, MAT.plain)
}

/** 鸟居（明神鸟居）：两根圆柱，上翘的笠木与岛木，贯与额束 */
function torii(c: Ctx, s: Site) {
  const { w } = c
  const { f, g1, base, b } = s
  // 平面是一道横梁：长向是鸟居的面宽
  const span = f.a * 2
  const half = span * 0.36
  const h = clamp(span * 0.82, 2.2, 9.5)
  const r = h * 0.045 + 0.02
  const top = g1 + h
  const stone = /石/.test(b.role ?? '')
  w.c = stone ? STONE : VERMILION
  w.face = MAT.plain
  for (const sd of [-1, 1]) {
    const p0 = at(f, sd * half, 0)
    // 柱：下粗上细，脚下一圈黑色的根卷
    tube(w, p0, r * 1.08, r * 0.92, base, top - h * 0.1, 8)
    w.c = hex('#262422')
    lathe(w, p0, g1 - 0.05, [[r * 1.25, 0], [r * 1.25, h * 0.06], [r * 1.05, h * 0.065]], 8)
    w.c = stone ? STONE : VERMILION
  }
  // 贯：穿过两柱的横枋，两端出头
  const th = h * 0.055
  block(w, rectOf(sub(f, 0, 0, half * 1.22, r * 0.7)), top - h * 0.3, top - h * 0.3 + th * 1.5)
  // 额束
  block(w, rectOf(sub(f, 0, 0, r * 0.8, r * 0.6)), top - h * 0.3 + th * 1.5, top - h * 0.11)
  // 岛木与笠木：当中平、两端上翘
  const reach = half * 1.42
  for (const [dy, hh, col, bw] of [[0, th * 1.4, stone ? STONE : VERMILION, r * 1.1], [th * 1.4, th * 1.2, stone ? shade(STONE, 0.8) : hex('#2a2725'), r * 1.45]] as const) {
    w.c = col
    const y0 = top - h * 0.1 + dy
    block(w, rectOf(sub(f, 0, 0, half * 0.75, bw)), y0, y0 + hh)
    for (const sd of [-1, 1]) slab(w, at(f, sd * half * 0.75, 0), at(f, sd * reach, 0), bw, y0 + hh, y0 + hh + h * 0.045, hh)
  }
}
