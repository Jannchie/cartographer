/**
 * 建筑的体块：按"文明 × 类别 × 尺寸"推导高度与屋顶形式（民居、大宅、厅堂、宗教建筑、塔、天守、层塔、鸟居）。
 * 生成器只给出平面、类别、屋脊方向与民居层数；组合地标（教堂、寺院、清真寺）被拆成互相重叠的矩形，
 * 体块叠加后即得到高低错落的剖面。纯函数，在 Worker 中运行。
 */
import { centroid, type P } from '../../settlement/geom'
import type { Building, Culture } from '../../settlement/types'
import { MAT, WIN, at, cap, circle, cone, dome, flat, frameOf, gable, hip, irimoya, merlons, plinth, prism, rectOf, shade, v3, walls, type Frame, type RGB, type Writer } from './mesh'
import type { Facade } from './facade'
import { BRICK, COPPER, GOLD, LACQUER, PLASTER, STONE, STONE_DARK, STONE_EAST, TIMBER, TIMBER_DARK, VERMILION, WALL, frac, hex, pick, type Ctx } from './shared'

/** 颜色的明度（0~1）：深色屋面用石板瓦 */
const lum = (c: RGB) => (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255

/**
 * 墙面材质：西式民居多为抹灰或露明木构架，少数石砌；公共建筑、大宅石砌；
 * 东方青砖，和式真壁，伊斯兰抹灰（土坯外抹一层）
 */
function wallMat(culture: Culture, kind: Building['kind'], t: number): number {
  if (culture === 'western') {
    if (kind === 'house') return t < 0.38 ? MAT.timber : t < 0.86 ? MAT.plaster : MAT.stone
    if (kind === 'large') return t < 0.5 ? MAT.stone : MAT.plaster
    if (kind === 'shed') return MAT.board
    return MAT.stone
  }
  if (kind === 'shed') return culture === 'islamic' ? MAT.plaster : MAT.board
  return culture === 'eastern' ? MAT.brick : culture === 'wa' ? MAT.wa : MAT.plaster
}

export function building(c: Ctx, b: Building, fac: Facade) {
  const { w, culture, east, pal, H, storey } = c
  const poly = b.poly
  // 地基：脚下最低处往下埋 0.6 米，墙顶按最高处算（坡地上的房子不悬空）
  let g0 = Infinity
  let g1 = -Infinity
  for (const p of poly) {
    const h = H(p[0], p[1])
    g0 = Math.min(g0, h)
    g1 = Math.max(g1, h)
  }
  const base = g0 - 0.6
  w.base = base
  const tone = b.tone
  const tone2 = frac(tone * 7.31 + 0.17)
  const roofCol = b.kind === 'torii' ? VERMILION : hex(pick(pal[b.kind], tone))
  const wallCol = pick(WALL[culture], tone2)
  const round = poly.length >= 8
  const f = frameOf(poly, b.ridge)
  const floors = b.floors ?? 1
  const k = culture === 'western' ? 0.82 + tone2 * 0.28 : culture === 'wa' ? 0.55 : culture === 'eastern' ? 0.6 : 0
  const over = east ? 0.9 : 0.35
  const prof = east ? 'curved' : 'straight'
  const wm = wallMat(culture, b.kind, tone2)
  w.face = 0
  w.roofFace = east ? MAT.tileEast : lum(roofCol) < 0.3 ? MAT.slate : MAT.tile
  w.gableFace = wm
  w.roofTh = east ? 0.32 : 0.16

  switch (b.kind) {
    case 'torii': {
      w.c = VERMILION
      const top = g1 + 4.5
      for (const s of [-0.36, 0.36]) walls(w, circle(at(f, s * f.a * 2, 0), 0.25, 6), base, top)
      const beam = [at(f, -f.a * 1.1, -0.3), at(f, f.a * 1.1, -0.3), at(f, f.a * 1.1, 0.3), at(f, -f.a * 1.1, 0.3)]
      w.c = TIMBER_DARK
      prism(w, beam, top - 0.45, top)
      w.c = VERMILION
      const tie = [at(f, -f.a * 0.9, -0.2), at(f, f.a * 0.9, -0.2), at(f, f.a * 0.9, 0.2), at(f, -f.a * 0.9, 0.2)]
      prism(w, tie, top - 1.4, top - 1.0)
      return
    }
    case 'shed': {
      const y = g1 + 2.4
      const col = wm === MAT.board ? TIMBER : wallCol
      w.c = col
      w.face = wm | WIN
      walls(w, poly, base, y, { win: [], door: fac.door })
      w.face = 0
      w.roofTh = 0.1
      if (culture === 'islamic') flat(w, f, y, roofCol, wallCol, 0.3)
      else gable(w, f, y, Math.max(0.35, k * 0.7), 0.25, roofCol, col)
      return
    }
    case 'pagoda':
      return pagoda(c, f, base, g1, roofCol, wallCol)
    case 'keep':
      return keep(c, b, f, base, g1, roofCol, wallCol)
    case 'tower':
      return tower(c, b, f, base, g1, roofCol, wallCol)
    case 'magic': {
      const ct = centroid(poly)
      const r = Math.max(f.a, f.b)
      const top = g1 + 30
      w.c = hex('#cfc7e6')
      walls(w, poly, base, top)
      cone(w, ct, r * 1.2, top, r * 3, roofCol)
      return
    }
  }

  // 民居、大宅、厅堂、公共建筑、宗教建筑
  let top: number
  if (b.kind === 'temple') {
    // 西式教堂按部件宽窄定高（宽的中殿高、窄的侧廊低）；东亚寺社是台基上的单层大屋顶；伊斯兰礼拜殿平顶
    top = g1 + (culture === 'western' ? Math.min(28, 6 + f.b * 1.2) : culture === 'islamic' ? 9 : 5 + f.b * 0.22)
  } else if (b.kind === 'hall' || b.kind === 'civic' || b.kind === 'large') top = g1 + Math.max(1, floors) * storey + (b.kind === 'hall' ? 2 : 0.5)
  else top = g1 + Math.max(1, floors) * storey

  // 东亚的殿堂立在台基上
  let foot = base
  if (east && (b.kind === 'temple' || b.kind === 'hall')) {
    const plinth = Math.min(1.6, 0.5 + f.b * 0.08)
    w.c = STONE
    prism(w, rectOf(f, 1.2), base, g1 + plinth)
    foot = g1 + plinth
    top += plinth
  }
  // 勒脚：墙脚外凸的一圈石砌（东亚殿堂已在台基上）
  if (!round && foot === base) {
    w.c = culture === 'islamic' ? shade(wallCol, 0.82) : culture === 'eastern' ? STONE_EAST : STONE
    w.face = MAT.stone
    plinth(w, poly, base, g0 + (culture === 'wa' ? 0.35 : 0.5), 0.07)
  }
  w.c = b.kind === 'temple' && east ? LACQUER : wallCol
  // 开窗的立面：民居、大宅、厅堂、公共建筑（窗与门在着色器里按层高、开间排，哪面开窗、哪面开门见 facade.ts）
  w.face = b.kind === 'temple' ? (east ? MAT.plain : MAT.stone) : wm | WIN
  walls(w, poly, foot, top, fac)
  w.face = 0
  if (round) {
    const ct = centroid(poly)
    const r = Math.max(f.a, f.b)
    if (culture === 'islamic') dome(w, ct, r, top, roofCol)
    else cone(w, ct, r * 1.05, top, r * (b.kind === 'temple' ? 0.9 : 0.8), roofCol, 16)
    return
  }
  if (culture === 'islamic') {
    flat(w, f, top, wallCol, wallCol, b.kind === 'temple' ? 1 : 0.7)
    return
  }
  const sq = Math.abs(f.a - f.b) < 0.6
  if (culture === 'western') {
    if (b.kind === 'house' || b.kind === 'civic') {
      gable(w, f, top, k, over, roofCol, wallCol)
      // 烟囱：多数民居有一个，落在屋脊一侧
      if (tone2 > 0.35 && f.a > 2.5) {
        const ct = at(f, f.a * (tone > 0.5 ? 0.55 : -0.55), f.b * 0.35)
        const ch = top + f.b * k + 0.9
        w.c = BRICK
        w.face = MAT.brick
        walls(w, rectOf({ ...f, c: ct, a: 0.45, b: 0.45 }), top, ch)
        // 烟囱帽：外挑的一圈压顶，上面两个烟囱管
        w.c = STONE
        w.face = MAT.plain
        prism(w, rectOf({ ...f, c: ct, a: 0.55, b: 0.55 }), ch, ch + 0.14)
        w.c = shade(BRICK, 0.75)
        for (const s of [-0.18, 0.18]) prism(w, rectOf({ ...f, c: at({ ...f, c: ct }, s, 0), a: 0.11, b: 0.11 }), ch + 0.14, ch + 0.42)
        w.face = 0
      }
    } else if (sq) hip(w, f, top, b.kind === 'temple' ? 1.6 : k, over, roofCol)
    else if (b.kind === 'temple') gable(w, f, top, 1.05, over, roofCol, wallCol)
    else hip(w, f, top, k, over, roofCol)
    return
  }
  // 东亚：民居两坡（曲面），大宅、殿堂歇山 / 入母屋，屋脊加脊
  if (b.kind === 'house' || b.kind === 'civic' || (b.kind === 'large' && culture === 'eastern' && f.b < 5)) {
    gable(w, f, top, k, over, roofCol, wallCol, prof)
    return
  }
  const kk = k * 1.1
  const oo = over * (b.kind === 'temple' ? 1.8 : 1.4)
  irimoya(w, f, top, kk, oo, roofCol, culture === 'wa' ? PLASTER : wallCol, prof)
  ridgeBeam(w, f, top + f.b * kk, Math.max(0.35, f.b * 0.06), roofCol)
}

/** 屋脊：沿屋脊的一道矮条（东亚殿堂的正脊），两端略高（鸱吻） */
function ridgeBeam(w: Writer, f: Frame, y: number, h: number, col: RGB) {
  const d: RGB = [Math.round(col[0] * 0.7), Math.round(col[1] * 0.7), Math.round(col[2] * 0.7)]
  w.c = d
  const r = Math.max(0.5, f.a - f.b * 0.55)
  const bar = [at(f, -r, -h * 0.5), at(f, r, -h * 0.5), at(f, r, h * 0.5), at(f, -r, h * 0.5)]
  prism(w, bar, y - h, y + h * 0.6)
  for (const s of [-1, 1]) prism(w, rectOf({ ...f, c: at(f, s * r, 0), a: h * 0.6, b: h * 0.5 }), y, y + h * 1.8)
}

/** 层塔：东方七层、和式五层，逐层收分，每层一圈四坡出檐，塔刹 */
function pagoda(c: Ctx, f: Frame, base: number, g1: number, roof: RGB, wall: RGB) {
  const { w, culture } = c
  w.roofFace = MAT.tileEast
  w.roofTh = 0.35
  const tiers = culture === 'wa' ? 5 : 7
  const r0 = Math.min(f.a, f.b)
  const sq: Frame = { ...f, a: r0, b: r0 }
  w.c = STONE
  prism(w, rectOf(sq, r0 * 0.15), base, g1 + 1)
  let y = g1 + 1
  for (let i = 0; i < tiers; i++) {
    const s = 1 - (i / tiers) * 0.45
    const t: Frame = { ...sq, a: r0 * s * 0.8, b: r0 * s * 0.8 }
    const hgt = i === 0 ? 4 : 2.6
    w.c = culture === 'wa' ? PLASTER : wall
    walls(w, rectOf(t), y, y + hgt)
    y += hgt
    hip(w, { ...t, a: t.a + 1.2, b: t.b + 1.2 }, y, 0.35, 0.5, roof, 'curved')
    y += 0.6
  }
  w.c = GOLD
  walls(w, circle(sq.c, 0.25, 6), y, y + r0 * 1.2)
}

/** 天守：石垣 + 逐层收分的白壁层 + 每层出檐，顶层入母屋 */
function tenshu(c: Ctx, f: Frame, base: number, g1: number, roof: RGB) {
  const { w } = c
  const ish = 8
  w.roofFace = MAT.tileEast
  w.gableFace = MAT.plaster
  w.roofTh = 0.35
  w.c = STONE
  w.face = MAT.stone
  // 石垣：上小下大
  const lo = rectOf(f, Math.max(f.a, f.b) * 0.2)
  const hi = rectOf(f, Math.max(f.a, f.b) * 0.08)
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    w.quad(v3(lo[j], base), v3(lo[i], base), v3(hi[i], g1 + ish), v3(hi[j], g1 + ish))
  }
  cap(w, hi, g1 + ish)
  let y = g1 + ish
  const tiers = 5
  for (let i = 0; i < tiers; i++) {
    const s = 1 - (i / tiers) * 0.55
    const t: Frame = { ...f, a: f.a * s, b: f.b * s }
    w.c = PLASTER
    w.face = MAT.plaster | WIN
    walls(w, rectOf(t), y, y + 3.6)
    w.face = MAT.plaster
    y += 3.6
    if (i === tiers - 1) irimoya(w, t, y, 0.6, 1.2, roof, PLASTER, 'curved')
    else hip(w, { ...t, a: t.a + 1, b: t.b + 1 }, y, 0.45, 0.5, roof, 'curved')
    y += 0.4
  }
}

function keep(c: Ctx, b: Building, f: Frame, base: number, g1: number, roof: RGB, wall: RGB) {
  const { w, culture, east } = c
  if (culture === 'wa') return tenshu(c, f, base, g1, roof)
  w.face = culture === 'western' ? MAT.stone : east ? MAT.plain : MAT.plaster
  w.gableFace = w.face
  const poly = b.poly
  if (poly.length >= 8 && (culture === 'islamic' || culture === 'western')) {
    // 十字交叉处的穹顶、圆塔
    const ct = centroid(poly)
    const r = Math.max(f.a, f.b)
    const top = g1 + (culture === 'western' ? 26 : 14)
    w.c = wall
    walls(w, poly, base, top)
    dome(w, ct, r, top, culture === 'western' ? COPPER : roof, 18, 6, culture === 'islamic' ? 1.15 : 1)
    if (culture === 'western') {
      w.c = wall
      walls(w, circle(ct, r * 0.22, 8), top + r * 0.95, top + r * 1.35)
      cone(w, ct, r * 0.28, top + r * 1.35, r * 0.6, COPPER, 8)
    }
    return
  }
  const tall = culture === 'western' ? 24 : culture === 'islamic' ? 15 : 8
  const top = g1 + tall
  if (east) {
    // 宫殿正殿：两层台基 + 重檐庑殿
    w.c = STONE
    prism(w, rectOf(f, 4), base, g1 + 1.2)
    prism(w, rectOf(f, 2), g1 + 1.2, g1 + 2.4)
    w.c = LACQUER
    walls(w, poly, g1 + 2.4, top)
    hip(w, { ...f, a: f.a + 1.5, b: f.b + 1.5 }, top - 3, 0.3, 0.9, roof, 'curved')
    w.c = LACQUER
    walls(w, rectOf(f, -0.8), top - 3 + 0.4, top + 0.6)
    hip(w, { ...f, a: f.a - 0.8, b: f.b - 0.8 }, top + 0.6, 0.62, 1.4, roof, 'curved')
    ridgeBeam(w, { ...f, a: f.a - 0.8, b: f.b - 0.8 }, top + 0.6 + (f.b - 0.8) * 0.62, Math.max(0.4, f.b * 0.05), roof)
    return
  }
  // 西式城堡主楼、伊斯兰的城堡：方楼平顶加雉堞
  w.c = culture === 'western' ? STONE : wall
  walls(w, poly, base, top)
  const crown = culture === 'western' ? STONE : wall
  flat(w, f, top, STONE_DARK, crown, 0.9)
  const r = rectOf(f)
  for (let i = 0; i < 4; i++) {
    const a = r[i]
    const bb = r[(i + 1) % 4]
    const L = Math.hypot(bb[0] - a[0], bb[1] - a[1]) || 1
    // rectOf 的绕向使左手法线朝内
    const inward: P = [-(bb[1] - a[1]) / L, (bb[0] - a[0]) / L]
    merlons(w, a, bb, top + 0.9, top + 0.9, inward, 0.35, 0.8, 2.2)
  }
}

function tower(c: Ctx, b: Building, f: Frame, base: number, g1: number, roof: RGB, wall: RGB) {
  const { w, culture, east } = c
  w.face = culture === 'western' ? MAT.stone : culture === 'eastern' ? MAT.brick : MAT.plaster
  w.gableFace = culture === 'wa' ? MAT.plaster : w.face
  if (culture === 'western') w.roofFace = MAT.slate
  const poly = b.poly
  const round = poly.length >= 8
  if (culture === 'islamic') {
    // 宣礼塔：细高的柱身 + 阳台 + 小穹顶
    const ct = f.c
    const r = Math.min(f.a, f.b)
    const top = g1 + Math.max(18, r * 9)
    w.c = wall
    walls(w, poly, base, top)
    cap(w, poly, top)
    w.c = wall
    prism(w, circle(ct, r * 1.25, 10), top - 3, top - 2.4)
    walls(w, circle(ct, r * 0.6, 8), top, top + 1.4)
    dome(w, ct, r * 0.7, top + 1.4, roof, 10, 4, 1.3)
    return
  }
  const top = g1 + (east ? 9 : 16 + frac(b.tone * 3.7) * 8)
  w.c = culture === 'western' ? STONE : wall
  walls(w, poly, base, top)
  if (round) cone(w, centroid(poly), Math.max(f.a, f.b) * 1.15, top, Math.max(f.a, f.b) * 2.4, roof)
  else if (culture === 'western') hip(w, { ...f, a: Math.max(f.a, f.b), b: Math.max(f.a, f.b) }, top, 2.4, 0.3, roof)
  else if (culture === 'wa') irimoya(w, f, top, 0.6, 1.0, roof, PLASTER, 'curved')
  else hip(w, f, top, 0.6, 0.9, roof, 'curved')
}
