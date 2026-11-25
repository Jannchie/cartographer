/**
 * 伊斯兰建筑：平顶的土坯房与内院住宅（屋顶的女儿墙、楼梯间）、客栈与浴场（平顶上的小穹顶）、
 * 清真寺（按部件：礼拜殿、成排的两坡绿瓦廊、鼓座与穹顶、庭院四周的回廊、伊旺、宣礼塔）、
 * 圣墓的小穹顶、卡斯巴的碉楼。纯函数，在 Worker 中运行。
 */
import { clamp } from '../../../../gen/util'
import { centroid, type P } from '../../../../settlement/geom'
import { MAT, STYLE, WIN, annulus, block, cap, circle, crenels, dome, flat, frameOf, gable, lathe, parapet, prism, rectOf, shade, sub, taper, tent, tube, wall1, walls, type Frame, type RGB } from '../../../../render/town3d/mesh'
import { finial, hashOf, type Site } from '../../../../render/town3d/kit'
import { edgeFacing, mid, type Group } from '../../../../render/town3d/groups'
import { EARTH, GILT, LIME, ROOF, hex, pick, type Ctx } from '../../../../render/town3d/shared'

/** 石灰抹面的墙色 */
const WALL = ['#e3d3b1', '#dccaa4', '#e8dbbd', '#d6c39b'].map(hex)
/** 公共建筑（客栈、浴场、经学院）单层的墙高 */
const HALL_H = 5.6
/** 石砌的清真寺、宫殿的石色 */
const SANDSTONE = ['#cdb793', '#c4ad87', '#d3c09d'].map(hex)
const PAVING = hex('#c9b996')

export function islamic(c: Ctx, s: Site, g: Group | null) {
  if (g && part(c, s, g)) return
  switch (s.b.kind) {
    case 'house':
    case 'large':
      return house(c, s)
    case 'temple':
      return shrine(c, s)
    case 'keep':
      return kasbah(c, s)
    case 'tower':
      return burj(c, s)
    case 'pagoda':
      return kiosk(c, s)
    default:
      return hall(c, s)
  }
}

// —————————————————————— 民居 ——————————————————————

/** 平屋顶的一方：屋面与四周的女儿墙；court 给出时当中留出内院（院墙朝里的一面开拱廊） */
function flatWithCourt(c: Ctx, f: Frame, top: number, floor: number, wallCol: RGB, wm: number, par: number, court: Frame | null, arcade: boolean) {
  const { w } = c
  w.gableFace = wm
  if (!court) {
    flat(w, f, top, shade(wallCol, 0.93), wallCol, par)
    return
  }
  w.c = shade(wallCol, 0.93)
  w.face = MAT.flatRoof
  annulus(w, rectOf(f), rectOf(court), top)
  w.c = wallCol
  w.face = wm
  parapet(w, rectOf(f), top, par, Math.min(0.35, f.b * 0.2))
  parapet(w, rectOf(court), top, 0.4, 0.22)
  // 院墙：朝院子的四面
  const r = rectOf(court, -0.22)
  w.face = wm | WIN
  w.style = arcade ? STYLE.arcade : STYLE.house
  for (let i = 0; i < 4; i++) {
    const a = r[i]
    const b = r[(i + 1) % 4]
    wall1(w, a, b, floor, top, [court.c[0] - (a[0] + b[0]) / 2, court.c[1] - (a[1] + b[1]) / 2])
  }
  w.style = 0
  // 院子的地面
  w.c = PAVING
  w.face = MAT.flatRoof
  cap(w, r, floor)
}

function house(c: Ctx, s: Site) {
  const { w } = c
  const { storey } = c.kit
  const { b, f, fac, g1, base, tone, t2, t3, t4 } = s
  const large = b.kind === 'large'
  const floors = Math.max(1, s.floors)
  // 土坯抹泥、石灰抹面两种墙
  const adobe = t2 < 0.5
  const wm = adobe ? MAT.adobe : MAT.plaster
  const wallCol = adobe ? pick(EARTH, t3) : t2 > 0.88 ? shade(LIME, 0.96) : pick(WALL, t3)
  const top = g1 + floors * storey + (large ? 0.6 : 0)
  w.c = wallCol
  w.face = wm | WIN
  walls(w, b.poly, base, top, fac)
  // 内院：够大的宅子当中留出院子
  const yard = b.poly.length === 4 && f.b >= 4 && f.a >= 5
  const court: Frame | null = yard ? sub(f, f.a * (tone - 0.5) * 0.2, 0, f.a * 0.36, f.b * 0.36) : null
  flatWithCourt(c, f, top, g1 + 0.05, wallCol, wm, 0.6 + t4 * 0.3, court, floors > 1 || large)
  // 屋顶的楼梯间：角上的一间小屋
  if (t4 > 0.5 && f.b > 2.6 && f.a > 3) {
    const sa = hashOf(tone, 5) > 0.5 ? 1 : -1
    const sb = hashOf(tone, 6) > 0.5 ? 1 : -1
    const hf = sub(f, sa * (f.a - 1.25), sb * (f.b - 1.15), 0.95, 0.85)
    w.c = wallCol
    w.face = wm
    walls(w, rectOf(hf), top, top + 2.1)
    w.c = shade(wallCol, 0.93)
    w.face = MAT.flatRoof
    cap(w, rectOf(hf), top + 2.1)
  }
}

// —————————————————————— 公共建筑：客栈、浴场、经学院、施水亭 ——————————————————————

function hall(c: Ctx, s: Site) {
  const { w } = c
  const { storey } = c.kit
  const { b, f, fac, g1, base, tone, t3, round } = s
  const stone = pick(SANDSTONE, t3)
  if (round) {
    // 平顶上的小穹顶（浴场、市场）：矮鼓座托着穹顶
    const ct = centroid(b.poly)
    const r = Math.max(f.a, f.b)
    const top = g1 + HALL_H + 0.5
    w.c = stone
    w.face = MAT.plaster
    walls(w, b.poly, base, top, undefined, 0.5)
    w.face = MAT.plain
    dome(w, ct, r * 0.97, top, shade(LIME, 0.97), 14, 5, 0.9)
    finial(w, ct, top + r * 0.85, 0.07, 0.5, GILT)
    return
  }
  // 施水亭一类的小亭：四面开拱，顶上小穹顶
  if (Math.max(f.a, f.b) < 2.6) {
    const top = g1 + 3.6
    w.c = stone
    w.face = MAT.stone | WIN
    w.style = STYLE.arcade
    walls(w, b.poly, base, top)
    w.style = 0
    w.gableFace = MAT.stone
    flat(w, f, top, shade(stone, 0.92), stone, 0.35)
    w.face = MAT.glaze
    dome(w, f.c, Math.min(f.a, f.b) * 0.7, top + 0.1, ROOF.turquoise, 12, 5, 1.05)
    finial(w, f.c, top + Math.min(f.a, f.b) * 0.75, 0.06, 0.5, GILT)
    return
  }
  const floors = Math.max(1, s.floors)
  const top = g1 + (floors > 1 ? floors * storey : HALL_H)
  w.c = stone
  w.face = MAT.plaster | WIN
  w.style = STYLE.upper
  walls(w, b.poly, base, top, fac)
  w.style = 0
  const yard = b.poly.length === 4 && f.b >= 6.5 && f.a >= 8
  flatWithCourt(c, f, top, g1 + 0.05, stone, MAT.plaster, 0.8, yard ? sub(f, 0, 0, f.a - Math.min(4.5, f.b * 0.4), f.b - Math.min(4.5, f.b * 0.4)) : null, true)
  w.c = stone
  if (tone > 0.5) crenels(w, f, top + 0.8, 0.3, 0.5, 1.5)
}

/** 圣墓（库巴）、小礼拜寺 */
function shrine(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base, tone, round } = s
  const white = shade(LIME, 0.98)
  if (round || Math.max(f.a, f.b) < 4) {
    // 库巴：白色的方座，四角小垛，当中一座穹顶
    const r = round ? Math.max(f.a, f.b) : Math.min(f.a, f.b)
    const sq: Frame = round ? { c: centroid(b.poly), u: [1, 0], v: [0, 1], a: r * 0.92, b: r * 0.92 } : f
    const top = g1 + 2.6 + r * 0.25
    w.c = white
    w.face = MAT.plaster | WIN
    w.style = STYLE.arcade
    walls(w, rectOf(sq), base, top, { win: [true, false, false, false], door: -1 })
    w.style = 0
    w.gableFace = MAT.plaster
    flat(w, sq, top, white, white, 0.3)
    for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) prism(w, rectOf(sub(sq, sa * (sq.a - 0.18), sb * (sq.b - 0.18), 0.18, 0.18)), top + 0.3, top + 0.75)
    w.face = MAT.plain
    dome(w, sq.c, Math.min(sq.a, sq.b) * 0.82, top + 0.05, white, 14, 5, 1.08)
    finial(w, sq.c, top + Math.min(sq.a, sq.b) * 0.85, 0.06, 0.6, GILT)
    return
  }
  // 街区的小寺：平顶的殿，当中一座绿釉的小穹顶
  const top = g1 + 5 + f.b * 0.25
  const stone = pick(SANDSTONE, tone)
  w.c = stone
  w.face = MAT.plaster | WIN
  w.style = STYLE.lancet
  walls(w, b.poly, base, top)
  w.style = 0
  w.gableFace = MAT.plaster
  flat(w, f, top, shade(stone, 0.93), stone, 0.8)
  const r = Math.min(f.a, f.b) * 0.42
  w.c = stone
  w.face = MAT.plaster
  tube(w, f.c, r, r, top, top + 0.9, 14)
  w.face = MAT.glaze
  dome(w, f.c, r * 1.02, top + 0.9, ROOF.greenTile, 14, 5, 1.1)
  finial(w, f.c, top + 0.8 + r * 1.1, 0.07, 0.7, GILT)
}

/** 卡斯巴的主楼、宫殿：大的是带内院的宫，小的是收分的碉楼 */
function kasbah(c: Ctx, s: Site) {
  const { w } = c
  const { storey } = c.kit
  const { b, f, g1, base, tone, t3 } = s
  const col = pick(EARTH, t3)
  if (Math.min(f.a, f.b) * 2 > 13) {
    const top = g1 + storey * 2.6
    w.c = col
    w.face = MAT.adobe | WIN
    w.style = STYLE.upper
    walls(w, b.poly, base, top)
    w.style = 0
    flatWithCourt(c, f, top, g1 + 0.05, col, MAT.adobe, 0.9, sub(f, 0, 0, f.a * 0.45, f.b * 0.45), true)
    w.c = col
    w.face = MAT.adobe
    crenels(w, f, top + 0.9, 0.3, 0.6, 1.6)
    return
  }
  tapered(c, f, base, g1 + 13 + tone * 5, col, true)
}

/** 收分的方碉楼：墙面向上略收，墙顶一圈阶梯形的垛，四角的角垛高出一截 */
function tapered(c: Ctx, f: Frame, base: number, top: number, col: RGB, turrets: boolean) {
  const { w } = c
  const bt = Math.min(0.9, Math.min(f.a, f.b) * 0.16)
  const tf: Frame = { ...f, a: f.a - bt, b: f.b - bt }
  w.c = col
  w.face = MAT.adobe | WIN
  w.style = STYLE.slit
  taper(w, rectOf(f), rectOf(tf), base, top)
  w.style = 0
  w.face = MAT.adobe
  w.gableFace = MAT.adobe
  flat(w, tf, top, shade(col, 0.9), col, 0.8)
  w.c = col
  crenels(w, tf, top + 0.8, 0.28, 0.55, 1.3)
  if (!turrets) return
  for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const q = sub(tf, sa * (tf.a - 0.55), sb * (tf.b - 0.55), 0.7, 0.7)
    w.c = col
    w.face = MAT.adobe
    prism(w, rectOf(q), top - 0.2, top + 2.2)
    tent(w, q.c, 4, Math.atan2(f.u[1] + f.v[1], f.u[0] + f.v[0]), 0.7, top + 2.2, 0, top + 2.9, col)
  }
}

function burj(c: Ctx, s: Site) {
  const { f, g1, base, tone, t3 } = s
  // 没有部件名的塔：窄的是宣礼塔，宽的是碉楼
  if (Math.min(f.a, f.b) * 2 < 5.4) return minaret(c, s, g1 + 9, hashOf(tone, 3) > 0.5 ? 1 : 2, pick(SANDSTONE, t3))
  tapered(c, f, base, g1 + 11 + tone * 4, pick(EARTH, t3), false)
}

/** 园中的小亭：四柱托着的穹顶 */
function kiosk(c: Ctx, s: Site) {
  const { w } = c
  const { b, f, g1, base } = s
  const ct = centroid(b.poly)
  const r = Math.min(f.a, f.b)
  const n = b.poly.length >= 6 ? 8 : 4
  const ph = n === 4 ? Math.atan2(f.u[1] + f.v[1], f.u[0] + f.v[0]) : Math.PI / n
  const R = n === 4 ? r * Math.SQRT2 : r
  const white = shade(LIME, 0.98)
  w.c = PAVING
  w.face = MAT.stone
  prism(w, circle(ct, R * 1.03, n, ph), base, g1 + 0.3)
  const top = g1 + 0.3 + 2.7
  w.c = white
  w.face = MAT.plain
  for (const p of circle(ct, R * 0.85, n, ph)) tube(w, p, 0.12, 0.1, g1 + 0.3, top, 6)
  block(w, circle(ct, R * 0.95, n, ph), top, top + 0.4)
  w.face = MAT.glaze
  dome(w, ct, r * 0.8, top + 0.4, ROOF.turquoise, 12, 5, 1.1)
  finial(w, ct, top + 0.3 + r * 0.9, 0.06, 0.5, GILT)
}

// —————————————————————— 清真寺（按部件） ——————————————————————

interface Mosque {
  /** 礼拜朝向（自入口指向礼拜墙）与基准地面 */
  q: P
  G: number
  /** 礼拜殿的墙高（绝对高度）、回廊的墙高 */
  top: number
  low: number
  stone: RGB
  /** 形制：0 柱厅式（方塔），1 奥斯曼式（大穹顶、细高的圆塔），2 波斯式（伊旺、釉面的穹顶与成对的塔） */
  kind: 0 | 1 | 2
  /** 整座的宽度 */
  W: number
}

function mosqueOf(c: Ctx, g: Group): Mosque | null {
  if (g.memo.has('mosque')) return g.memo.get('mosque') as Mosque | null
  const halls = [...g.of('prayerHall'), ...g.of('aisle')]
  let out: Mosque | null = null
  if (halls.length) {
    let G = -Infinity
    let x = 0
    let y = 0
    let n = 0
    for (const h of halls)
      for (const p of h.poly) {
        G = Math.max(G, c.H(p[0], p[1]))
        x += p[0]
        y += p[1]
        n++
      }
    const hc: P = [x / n, y / n]
    // 礼拜朝向：自全组的中心指向壁龛（没有壁龛时取礼拜殿）
    let ax = 0
    let ay = 0
    let m = 0
    let x0 = Infinity
    let x1 = -Infinity
    for (const b of g.all)
      for (const p of b.poly) {
        ax += p[0]
        ay += p[1]
        m++
      }
    const all: P = [ax / m, ay / m]
    const mih = g.of('mihrab')[0]
    const to = mih ? mid(mih.poly) : hc
    const L = Math.hypot(to[0] - all[0], to[1] - all[1]) || 1
    const q: P = [(to[0] - all[0]) / L, (to[1] - all[1]) / L]
    for (const h of halls)
      for (const p of h.poly) {
        const t = -(p[0] - hc[0]) * q[1] + (p[1] - hc[1]) * q[0]
        x0 = Math.min(x0, t)
        x1 = Math.max(x1, t)
      }
    const W = x1 - x0
    const kind = g.of('semidome').length ? 1 : g.of('iwan').length ? 2 : 0
    const h = kind === 1 ? clamp(7 + W * 0.22, 10, 17) : clamp(6 + W * 0.05, 6.8, 10.5)
    out = { q, G, top: G + h, low: G + Math.min(5.2, h * 0.62), stone: pick(SANDSTONE, g.seed), kind, W }
  }
  g.memo.set('mosque', out)
  return out
}

function part(c: Ctx, s: Site, g: Group): boolean {
  const p = s.b.part!
  const m = mosqueOf(c, g)
  if (!m) return false
  const { w } = c
  const { b, f, base } = s
  const { stone } = m
  const roofCol = shade(stone, 0.92)
  const ang = Math.atan2(m.q[1], m.q[0])
  w.gableFace = MAT.plaster
  switch (p) {
    case 'prayerHall': {
      // 礼拜殿：平顶的大殿；朝庭院的一面是一排拱
      w.c = stone
      w.face = MAT.plaster | WIN
      w.style = STYLE.lancet
      const front = edgeFacing(b.poly, [-m.q[0], -m.q[1]])
      walls(w, b.poly, base, m.top, { win: b.poly.map(() => true), door: -1, alt: (i) => (i === front && m.kind !== 1 ? { face: MAT.plaster | WIN, style: STYLE.arcade } : null) })
      w.style = 0
      flat(w, f, m.top, roofCol, stone, 0.9)
      w.c = stone
      crenels(w, f, m.top + 0.9, 0.3, 0.55, 1.5)
      return true
    }
    case 'aisle': {
      // 一道道的廊：各自一条两坡的绿瓦顶
      const ff = frameOf(b.poly, b.ridge)
      w.c = stone
      w.face = MAT.plaster | WIN
      w.style = STYLE.arcade
      const top = m.top - 1.6
      walls(w, b.poly, base, top, { win: b.poly.map((_, i) => i === edgeFacing(b.poly, [-m.q[0], -m.q[1]])), door: -1 })
      w.style = 0
      w.roofFace = MAT.tile
      w.roofTh = 0.2
      gable(w, ff, top, 0.5, 0.25, ROOF.greenTile, stone)
      return true
    }
    case 'transept': {
      // 正中横穿的高廊：比两旁的廊高出一截
      const ff = frameOf(b.poly, b.ridge)
      w.c = stone
      w.face = MAT.plaster | WIN
      w.style = STYLE.lancet
      walls(w, b.poly, base, m.top + 1.2)
      w.style = 0
      w.roofFace = MAT.tile
      w.roofTh = 0.22
      gable(w, ff, m.top + 1.2, 0.5, 0.25, ROOF.greenTile, stone)
      return true
    }
    case 'riwaq':
    case 'portico': {
      // 回廊、门廊：矮的平顶廊，朝院子的一面开一排拱
      w.c = stone
      w.face = MAT.plaster | WIN
      w.style = STYLE.arcade
      walls(w, b.poly, base, m.low)
      w.style = 0
      flat(w, f, m.low, roofCol, stone, 0.5)
      return true
    }
    case 'iwan': {
      // 伊旺：高出回廊的门墙，朝院子的一面是尖拱大龛，釉面砖的边饰
      const ff = frameOf(b.poly, ang)
      const top = m.top + Math.min(ff.a, ff.b) * 0.5 + 1.5
      // 朝向庭院中心的那面
      const cen = mid(g.all.flatMap((x) => x.poly))
      const bc = mid(b.poly)
      const dl = Math.hypot(cen[0] - bc[0], cen[1] - bc[1]) || 1
      const face = edgeFacing(b.poly, [(cen[0] - bc[0]) / dl, (cen[1] - bc[1]) / dl])
      w.c = stone
      w.face = MAT.plaster
      walls(w, b.poly, base, top, { win: b.poly.map(() => true), door: -1, alt: (i) => (i === face ? { face: MAT.plaster | WIN, style: STYLE.iwan } : null) })
      flat(w, f, top, roofCol, stone, 0.5)
      return true
    }
    case 'mihrab': {
      w.c = stone
      w.face = MAT.plaster
      prism(w, b.poly, base, m.top - 2)
      return true
    }
    case 'dome':
    case 'domeSmall':
    case 'semidome': {
      // 穹顶：坐在殿顶上的鼓座与穹顶（奥斯曼式是铅皮的大穹顶，波斯式是青绿釉面的尖穹顶）
      let ct = centroid(b.poly)
      let r = Math.max(f.a, f.b)
      if (p === 'semidome') {
        // 半穹顶的平面是半个圆：圆心在弦的中点
        let best = 0
        for (let i = 0; i < b.poly.length; i++) {
          const o = b.poly[(i + 1) % b.poly.length]
          const L = Math.hypot(o[0] - b.poly[i][0], o[1] - b.poly[i][1])
          if (L > best) {
            best = L
            ct = [(o[0] + b.poly[i][0]) / 2, (o[1] + b.poly[i][1]) / 2]
          }
        }
        r = best / 2
      }
      const onLow = p === 'domeSmall' && m.kind === 1
      const y0 = onLow ? m.low : m.top
      const drum = p === 'dome' ? Math.max(1.4, r * (m.kind === 2 ? 0.7 : 0.45)) : 0.5
      const y1 = y0 + (p === 'semidome' ? -r * 0.25 : drum)
      w.c = stone
      w.face = MAT.plaster
      if (p !== 'semidome') {
        if (p === 'dome') {
          w.face = MAT.plaster | WIN
          w.style = STYLE.lancet
        }
        walls(w, circle(ct, r, 16), y0 - 0.3, y1, undefined, 0.5)
        w.style = 0
        w.c = shade(stone, 1.04)
        w.face = MAT.plain
        lathe(w, ct, y1 - 0.25, [[r, 0], [r + 0.22, 0.04], [r + 0.22, 0.25], [r * 0.9, 0.25]], 16)
      }
      const lead = m.kind === 1
      w.face = lead ? MAT.metal : m.kind === 2 ? MAT.glaze : MAT.plain
      const col = lead ? ROOF.lead : m.kind === 2 ? ROOF.turquoise : p === 'dome' ? ROOF.greenTile : shade(LIME, 0.97)
      if (p === 'dome' && !lead) w.face = MAT.glaze
      const k = m.kind === 2 ? 1.32 : lead ? 0.82 : 1.1
      if (p === 'semidome') {
        // 半个穹顶：朝外的一半（平面各点所在的一侧）
        const mm = mid(b.poly)
        const dir = Math.atan2(mm[1] - ct[1], mm[0] - ct[0])
        const prof: [number, number][] = []
        for (let j = 0; j <= 5; j++) prof.push([j === 5 ? 0 : Math.cos((j / 5) * Math.PI * 0.5) * r, Math.sin((j / 5) * Math.PI * 0.5) * r * 0.85])
        w.c = stone
        w.face = MAT.plaster
        const arc: [number, number] = [dir - Math.PI / 2, dir + Math.PI / 2]
        lathe(w, ct, y0 - 0.3, [[r, 0], [r, y1 - y0 + 0.3]], 10, arc)
        w.c = col
        w.face = lead ? MAT.metal : MAT.plain
        lathe(w, ct, y1, prof, 10, arc)
        return true
      }
      dome(w, ct, r * 1.02, y1, col, p === 'dome' ? 20 : 12, p === 'dome' ? 7 : 5, k)
      finial(w, ct, y1 + r * k - 0.05, Math.max(0.06, r * 0.03), Math.max(0.5, r * 0.3), GILT)
      return true
    }
    case 'minaret': {
      minaret(c, s, m.top, m.kind, stone)
      return true
    }
  }
  return false
}

/**
 * 宣礼塔。kind：0 马格里布式的方塔（塔顶雉堞，上面一座小塔亭与穹顶）；
 * 1 奥斯曼式细高的圆塔（两层环廊、铅皮尖顶）；2 圆塔（一层环廊、塔亭、釉面的小穹顶）
 */
function minaret(c: Ctx, s: Site, hallTop: number, kind: number, stone: RGB) {
  const { w } = c
  const { f, base, g1 } = s
  const ct = f.c
  const side = Math.min(f.a, f.b)
  const hh = hallTop - g1
  if (kind === 0) {
    const top = g1 + Math.max(hh * 2.1, side * 7.5)
    const sq: Frame = { ...f, a: side, b: side }
    w.c = stone
    w.face = MAT.plaster | WIN
    w.style = STYLE.belfry
    walls(w, rectOf(sq), base, top)
    w.style = 0
    // 塔顶：一圈釉面砖的饰带、雉堞
    w.c = ROOF.turquoise
    w.face = MAT.glaze
    walls(w, rectOf(sq, 0.06), top - 1.5, top - 0.5)
    w.face = MAT.plaster
    w.gableFace = MAT.plaster
    flat(w, sq, top, shade(stone, 0.92), stone, 0.7)
    w.c = stone
    crenels(w, sq, top + 0.7, 0.25, 0.6, 1.2)
    // 塔亭与小穹顶
    const lf: Frame = { ...sq, a: side * 0.5, b: side * 0.5 }
    const lt = top + side * 2.1
    w.c = stone
    w.face = MAT.plaster | WIN
    w.style = STYLE.belfry
    walls(w, rectOf(lf), top, lt)
    w.style = 0
    w.face = MAT.plain
    block(w, rectOf(lf, 0.12), lt - 0.25, lt)
    w.face = MAT.glaze
    dome(w, ct, side * 0.46, lt, ROOF.greenTile, 10, 4, 1.15)
    finial(w, ct, lt + side * 0.5, 0.06, side * 0.55, GILT)
    return
  }
  const r = side * (kind === 1 ? 0.5 : 0.62)
  const top = g1 + (kind === 1 ? Math.max(hh * 2.5, 30) : Math.max(hh * 2.2, 22))
  const H = top - base
  // 方座、收分的圆塔身、挑出的环廊
  w.c = stone
  w.face = MAT.plaster
  const sq: Frame = { ...f, a: side, b: side }
  prism(w, rectOf(sq), base, g1 + Math.min(hh * 0.8, 6))
  const b0 = g1 + Math.min(hh * 0.8, 6) - base
  const prof: [number, number][] = [[r, b0], [r * 0.92, H * 0.55]]
  const gallery = (y: number, rr: number) => prof.push([rr, y - 0.5], [rr + 0.55, y - 0.1], [rr + 0.55, y + 0.85], [rr + 0.4, y + 0.85], [rr + 0.4, y], [rr * 0.94, y])
  if (kind === 1) gallery(H * 0.55, r * 0.92)
  prof.push([r * 0.86, H * 0.8])
  gallery(H * 0.8, r * 0.86)
  prof.push([r * 0.78, H])
  lathe(w, ct, base, prof, 12)
  if (kind === 1) {
    w.roofFace = MAT.metal
    w.c = ROOF.lead
    w.face = MAT.metal
    lathe(w, ct, top, [[r * 0.9, 0], [0, r * 4.2]], 12)
    finial(w, ct, top + r * 4.1, 0.07, 0.8, GILT)
    return
  }
  // 塔亭：一圈细柱托着釉面的小穹顶
  w.c = stone
  w.face = MAT.plain
  for (const p of circle(ct, r * 0.66, 6)) tube(w, p, 0.1, 0.1, top, top + 1.6, 5)
  block(w, circle(ct, r * 0.82, 8), top + 1.6, top + 1.85)
  w.face = MAT.glaze
  dome(w, ct, r * 0.74, top + 1.85, ROOF.turquoise, 10, 5, 1.3)
  finial(w, ct, top + 1.8 + r * 0.95, 0.06, 0.7, GILT)
}
