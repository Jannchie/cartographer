/**
 * 建筑的体块：入口与各文明共有的小件（棚屋、墓碑、法师塔）。
 * 生成器只给出平面、类别、屋脊方向与民居层数，组合地标（教堂、寺院、清真寺、天守）被拆成互相重叠的矩形并标了部件名；
 * 高度与屋顶形式在这里按"文明 × 类别 × 部件 × 尺寸"推导，各文明的做法分在 western / eastern / wa / islamic 四个模块。
 * 纯函数，在 Worker 中运行。
 */
import { centroid } from '../../settlement/geom'
import type { Building, Settlement } from '../../settlement/types'
import { MAT, WIN, block, cone, flat, frameOf, gable, lathe, prism, rectOf, shade, walls } from './mesh'
import type { Facade } from './facade'
import { groupOf } from './groups'
import { finial, hashOf, type Site } from './kit'
import { EARTH, GILT, ROOF, STONE, STONE_DARK, TIMBER, frac, hex, pick, type Ctx } from './shared'

/**
 * 一栋建筑。st 用来把带部件名的建筑并成组（见 groups.ts）；不给时各部件各自按尺寸推导
 */
export function building(c: Ctx, b: Building, fac: Facade, st?: Settlement) {
  const { w, H } = c
  const poly = b.poly
  // 地基：脚下最低处往下埋 0.6 米，墙顶按最高处算（坡地上的房子不悬空）
  let g0 = Infinity
  let g1 = -Infinity
  for (const p of poly) {
    const h = H(p[0], p[1])
    g0 = Math.min(g0, h)
    g1 = Math.max(g1, h)
  }
  const tone = b.tone
  // 按色调错开一两厘米：着色器由地基高度派生每栋房子的随机数，平地上的房子地基同高
  const base = g0 - 0.6 + (tone - 0.5) * 0.02
  w.base = base
  const s: Site = {
    b,
    fac,
    f: frameOf(poly, b.ridge),
    g0,
    // 墙顶、屋面也按色调错开几厘米：平地上相邻的同层房子屋面同高，出挑的山面伸进邻屋的屋面里会共面闪烁
    g1: g1 + (tone - 0.5) * 0.08,
    base,
    tone,
    t2: frac(tone * 7.31 + 0.17),
    t3: hashOf(tone, 1),
    t4: hashOf(tone, 2),
    round: poly.length >= 8,
    floors: b.floors ?? 0,
  }
  if (b.kind === 'shed') return shed(c, s)
  if (b.kind === 'magic') return magic(c, s)
  const g = st ? groupOf(st, b) : null
  c.kit.building(c, s, g)
}

/** 棚屋、仓房；很小的是墓碑（墓地里一块块的"棚"） */
function shed(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, fac, g1, base, tone, t2, t3 } = s
  if (f.a < 1.3) return grave(c, s)
  const look = c.kit.shed
  const adobe = !!look.adobe
  // 土藏：白壁、瓦顶、厚墙的仓
  const kura = !look.adobe && !!look.kura && f.b > 2.2 && t3 > 0.55
  const y = g1 + (kura ? 4.4 : 2.5 + t2 * 0.5)
  const col = adobe ? pick(EARTH, t3) : kura ? hex('#e6e1d4') : shade(TIMBER, 0.9 + t3 * 0.3)
  w.c = col
  w.face = (adobe ? MAT.adobe : kura ? MAT.plaster : MAT.board) | WIN
  w.gableFace = adobe ? MAT.adobe : kura ? MAT.plaster : MAT.board
  walls(w, b.poly, base, y, { win: [], door: fac.door })
  w.face = 0
  if (look.adobe) {
    flat(w, f, y, shade(col, 0.95), col, 0.3)
    return
  }
  w.roofTh = kura ? 0.26 : 0.1
  w.roofFace = kura ? MAT.tileEast : t2 > look.roof.split ? look.roof.hi : look.roof.lo
  const roof = w.roofFace === MAT.tileEast ? pick(look.tile, tone) : w.roofFace === MAT.thatch ? pick(ROOF.thatch, tone) : pick(ROOF.shingle, tone)
  if (w.roofFace === MAT.thatch) w.roofTh = 0.3
  gable(w, f, y, kura ? 0.62 : look.pitch, kura ? 0.45 : 0.28, roof, col, kura ? 'curved' : 'straight')
}

/** 墓：文明自己的做法（碑与土冢、墓石，见 GraveKit.marker），否则是一方墓台与立在一头的碑 */
function grave(c: Ctx, s: Site) {
  const { w } = c
  const { f, g1, base, t2 } = s
  const kit = c.kit.grave
  w.face = MAT.stone
  if (kit.marker) return kit.marker(c, s)
  w.c = shade(kit.stone ?? STONE, 0.88 + t2 * 0.2)
  // 墓台与立在一头的碑
  prism(w, rectOf({ ...f, a: f.a * 0.85, b: f.b * 0.7 }), base, g1 + 0.18)
  const head = { ...f, c: [f.c[0] - f.u[0] * f.a * 0.8, f.c[1] - f.u[1] * f.a * 0.8] as [number, number], a: 0.07, b: f.b * 0.6 }
  prism(w, rectOf(head), base, g1 + 0.7 + t2 * 0.35)
}

/** 法师塔：细高的石塔，收分的塔身，尖顶 */
function magic(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, tone } = s
  const ct = centroid(b.poly)
  const r = Math.max(f.a, f.b)
  const top = g1 + Math.max(16, Math.min(34, r * 7))
  const stone = hex('#b7b0c9')
  w.c = stone
  w.face = MAT.stone
  if (b.poly.length >= 6) {
    lathe(w, ct, base, [[r, 0], [r * 0.82, (top - base) * 0.75], [r * 0.82, top - base - 1.2], [r * 1.05, top - base - 0.4], [r * 1.05, top - base]], 16)
    w.roofFace = MAT.slate
    cone(w, ct, r * 1.25, top, r * 3.2, hex(pick(c.pal.magic, tone)), 16)
    finial(w, ct, top + r * 3.1, r * 0.08, r * 0.6, GILT)
    return
  }
  walls(w, b.poly, base, g1 + 3.2)
  w.c = STONE_DARK
  w.face = MAT.plain
  block(w, rectOf(f, 0.15), g1 + 3.2, g1 + 3.5)
}
