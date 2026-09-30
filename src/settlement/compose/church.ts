import { emitArea, clipWater, isFree, mark, placeable, siteDice, type Ctx } from '../ctx'
import { area, at, box, centroid, circlePoly, insetConvex, obb, pointInPoly, rect, type Frame, type P, type Poly } from '../geom'
import type { BuildingKind } from '../types'
import type { SacredKind } from '../names'
import { addGroup, fit, graves, inside, place, plantTree, scatterTrees, urban } from '../wards'
import { composer, type Elem, type Preset } from './core'
import * as dmath from '../../gen/dmath'

/**
 * 西式教堂（主教座堂、修道院教堂、堂区教堂）的平面语法：
 * 中殿（几个开间）+ 侧廊（0 ~ 2 对）+ 耳堂（无 / 短 / 长 / 双耳堂）+ 东端（半圆后殿 / 方圣坛 / 回廊放射小礼拜堂 / 三后殿 / 圣母堂）
 * + 西端（双塔 / 单塔 / 西堂 / 平立面）+ 十字交叉处（塔 / 穹顶 / 无）+ 附件（扶壁、侧礼拜堂、南门廊、独立钟楼、回廊院、牧师会堂）。
 * 规矩：放射小礼拜堂、双塔、侧礼拜堂要有侧廊；五廊、双耳堂只在大城；交叉塔、穹顶要有耳堂；尽量朝东。
 */

type East = 'apse' | 'flat' | 'chevet' | 'triple' | 'lady'
type West = 'twin' | 'single' | 'westwork' | 'none'
type Transept = 'none' | 'short' | 'long' | 'double'
type Crossing = 'tower' | 'dome' | 'none'
type Buttress = 'none' | 'plain' | 'flying'

const EAST: Elem<East>[] = [
  { id: 'apse', w: 3 },
  { id: 'flat', w: 1.5 },
  { id: 'chevet', w: 1.2, rank: 1 },
  { id: 'triple', w: 1 },
  { id: 'lady', w: 0.8, rank: 1 },
]
const WEST: Elem<West>[] = [
  { id: 'twin', w: 2.5 },
  { id: 'single', w: 2.5 },
  { id: 'westwork', w: 1 },
  { id: 'none', w: 1 },
]
const TRANSEPT: Elem<Transept>[] = [
  { id: 'none', w: 1.5 },
  { id: 'short', w: 3 },
  { id: 'long', w: 2 },
  { id: 'double', w: 0.7, rank: 1 },
]
const CROSSING: Elem<Crossing>[] = [
  { id: 'none', w: 3 },
  { id: 'tower', w: 2 },
  { id: 'dome', w: 1 },
]
const BUTTRESS: Elem<Buttress>[] = [
  { id: 'none', w: 1 },
  { id: 'plain', w: 2 },
  { id: 'flying', w: 1.2, rank: 1 },
]

/** 以前的几种形制现在是预设：法式哥特主教座堂、英式大教堂、德意志罗马式、意式（穹顶 + 独立钟楼）、堂区教堂 */
const PRESETS = (big: boolean): Preset[] => [
  // 朝圣大教堂（孔波斯特拉、坎特伯雷式）：长中殿、长耳堂、回廊放射小礼拜堂、交叉塔，一侧是回廊院与牧师会堂
  { id: 'pilgrimage', w: 30, tiers: ['grand'], bias: { west: { twin: 6 }, east: { chevet: 8, lady: 3 }, transept: { long: 5, double: 3 }, crossing: { tower: 6 }, buttress: { flying: 4 }, cloister: { yes: 12 }, chapter: { yes: 6 }, chapels: { yes: 4 } }, num: { aisles: [1, 2] } },
  { id: 'french', w: big ? 3 : 0.6, tiers: ['standard', 'grand'], bias: { west: { twin: 8 }, east: { chevet: 8 }, transept: { short: 4 }, crossing: { none: 3 }, buttress: { flying: 5 } }, num: { aisles: [1, 2] } },
  { id: 'english', w: big ? 2 : 0.8, tiers: ['standard', 'grand'], bias: { west: { single: 2, twin: 2 }, crossing: { tower: 8 }, transept: { long: 4, double: 3 }, east: { flat: 4, lady: 5 }, cloister: { yes: 4 }, chapter: { yes: 5 } } },
  { id: 'romanesque', w: 1.5, bias: { west: { westwork: 5, twin: 2 }, east: { apse: 3, triple: 4 }, crossing: { tower: 3 }, buttress: { none: 3 } } },
  { id: 'italian', w: 1.2, tiers: ['standard', 'grand'], bias: { west: { none: 8 }, crossing: { dome: 8 }, east: { apse: 4 }, campanile: { yes: 8 }, buttress: { none: 4 } } },
  { id: 'parish', w: big ? 0.8 : 4, tiers: ['micro', 'small', 'standard'], bias: { west: { single: 6 }, transept: { none: 5 }, crossing: { none: 3 }, porch: { yes: 4 } }, num: { aisles: [0, 1] } },
]

/**
 * 大教堂片区：教堂（按上面的语法拼）、西门前的广场、一侧的回廊院（或墓园）与另一侧的树，其余照常是街坊。
 * 放不下就挪位、缩小，实在放不下整块是街坊。
 */
/**
 * o.fill：盖完教堂把片区其余部分盖成街坊（small 档放在片区一角时不填，四周本来就有人家）；
 * o.key：small 档的堂区教堂按它取名（不耗主随机数）。返回教堂盖成了没有。
 * 规模档（ctx.tier）：small 是堂区教堂（短、单廊、没有回廊院）；grand 是朝圣大教堂，另有围起来的教士区（close）：
 * 围墙、主教宫、沿墙一圈教士的住宅、草地。
 */
export function westChurch(ctx: Ctx, block: Poly, inner: Poly, o: { fill?: boolean; key?: string; label?: SacredKind } = {}): boolean {
  const b = obb(inner)
  const tier = ctx.tier
  const big = ctx.p.size === 'city' || tier === 'grand'
  const rank = Math.min(2, (ctx.p.capital ? 2 : ctx.p.size === 'city' ? 1 : 0) + (tier === 'grand' ? 1 : 0))
  // 尽量朝东
  const east: P = Math.abs(b.axis[0]) > 0.5 ? (b.axis[0] > 0 ? b.axis : [-b.axis[0], -b.axis[1]]) : b.axis
  const north: P = [east[1], -east[0]]
  const L0 = Math.min(b.len * (tier === 'grand' ? 0.62 : 0.78), tier === 'small' ? 27 : tier === 'grand' ? 105 : big ? 78 : 46)
  const C = composer(siteDice(ctx, centroid(block), 'church'), 'church', PRESETS(big), { size: L0, rank, tier })
  // 大城的主教座堂至少三廊
  const aisles = C.int('aisles', big ? 1 : 0, big ? 2 : 1)
  const transept = C.pick('transept', TRANSEPT, { only: (t) => t !== 'double' || L0 > 60 })
  const eastEnd = C.pick('east', EAST, { only: (e) => (e !== 'chevet' && e !== 'triple') || aisles > 0 })
  const west = C.pick('west', WEST, { only: (w) => w !== 'twin' || aisles > 0 })
  const crossing = transept === 'none' ? 'none' : C.pick('crossing', CROSSING)
  const buttress = C.pick('buttress', BUTTRESS)
  const chapels = aisles > 0 && C.chance('chapels', 0.3)
  const porch = C.chance('porch', 0.3)
  const campanile = C.chance('campanile', 0.15)
  const nave = C.num('nave', 0.1, 0.13)
  const tpos = C.num('tpos', 0.56, 0.72)
  const bays = tier === 'small' ? C.int('bays', 3, 5) : C.int('bays', big ? 6 : 4, big ? 11 : 7)
  // 回廊院在哪边（+1：中殿的左手，朝东时是北边）；没有回廊院时那一侧是墓园
  const gs = C.side('cloisterSide')
  // 修道院总有回廊院
  const cloister = tier !== 'small' && (C.chance('cloister', tier === 'grand' ? 0.8 : big ? 0.45 : 0.2) || o.label === 'abbey')
  const chapter = cloister && C.chance('chapter', 0.3)
  /** 以中心 c、缩放 s 拼出教堂：核心部件（一起落地）与附件（各自落地，放不下就不要） */
  const make = (c: P, s: number) => {
    const L = L0 * s
    const F: Frame = { o: c, f: east, l: north }
    const B = (a0: number, a1: number, b0: number, b1: number) => box(F, Math.min(a0, a1), Math.max(a0, a1), Math.min(b0, b1), Math.max(b0, b1))
    const wn = L * nave
    const wa = wn * 0.55
    const hb = wn + aisles * wa
    // 东端的深度
    const ed = eastEnd === 'chevet' ? hb + wn * 0.3 : eastEnd === 'flat' ? wn * 1.3 : eastEnd === 'lady' ? wn * 2.6 : wn
    const aW = -L / 2
    const aE = L / 2 - ed
    const core: [Poly, BuildingKind][] = []
    const extra: [Poly, BuildingKind][] = []
    // 中殿与侧廊（侧廊在东端收住）
    core.push([B(aW, aE + 0.3, -wn, wn), 'temple'])
    if (aisles) core.push([B(aW, aE, -hb, hb), 'temple'])
    // 耳堂
    const ac = aW + (aE - aW) * tpos
    const proj = transept === 'short' ? hb * 0.3 + 2 : hb * 0.75 + wn
    if (transept !== 'none') core.push([B(ac - wn * 0.95, ac + wn * 0.95, -hb - proj, hb + proj), 'temple'])
    if (transept === 'double') {
      const a2 = ac + (aE - ac) * 0.6
      core.push([B(a2 - wn * 0.7, a2 + wn * 0.7, -hb - proj * 0.55, hb + proj * 0.55), 'temple'])
    }
    // 东端
    const half = (o: P, r: number) => circlePoly(o, r, 16).filter((q) => (q[0] - o[0]) * east[0] + (q[1] - o[1]) * east[1] >= -0.01)
    if (eastEnd === 'apse' || eastEnd === 'triple') core.push([half(at(F, aE, 0), wn), 'temple'])
    if (eastEnd === 'triple') for (const sd of [-1, 1]) core.push([half(at(F, aE, sd * (wn + wa / 2)), wa * 0.5), 'temple'])
    if (eastEnd === 'chevet') {
      // 回廊（半圆）外一圈放射状的小礼拜堂
      core.push([half(at(F, aE, 0), hb), 'temple'])
      for (const t of [-1.15, -0.4, 0.4, 1.15]) core.push([circlePoly(at(F, aE + dmath.cos(t) * hb, dmath.sin(t) * hb), wn * 0.34, 10), 'temple'])
    }
    if (eastEnd === 'flat' || eastEnd === 'lady') core.push([B(aE, aE + wn * 1.3, -wn * 0.9, wn * 0.9), 'temple'])
    if (eastEnd === 'lady') core.push([B(aE + wn * 1.3 - 0.3, aE + wn * 2.6, -wn * 0.6, wn * 0.6), 'temple'])
    // 西端
    if (west === 'twin' && s > 0.75) {
      const q = Math.max(wa * 1.5, wn * 0.8)
      for (const sd of [-1, 1]) core.push([B(aW - q * 0.15, aW + q * 0.85, sd * (hb - q / 2) - q / 2, sd * (hb - q / 2) + q / 2), 'temple'])
    } else if (west === 'single' || (west === 'twin' && s <= 0.75)) {
      const q = wn * 1.35
      core.push([B(aW - q * 0.35, aW + q * 0.65, -q / 2, q / 2), 'temple'])
    } else if (west === 'westwork') core.push([B(aW - wn * 0.8, aW + wn * 0.4, -hb * 1.08, hb * 1.08), 'temple'])
    // 十字交叉：塔、穹顶
    if (crossing === 'tower') core.push([B(ac - wn * 1.05, ac + wn * 1.05, -wn * 1.05, wn * 1.05), 'keep'])
    else if (crossing === 'dome') core.push([circlePoly(at(F, ac, 0), wn * 1.15, 18), 'keep'])
    // 附件：扶壁（每个开间一对）、侧礼拜堂（开间之间）、南门廊、独立钟楼
    const bay = (aE - aW) / bays
    const inTransept = (a: number) => transept !== 'none' && Math.abs(a - ac) < wn * 1.3
    for (let k = 1; k < bays; k++) {
      const a = aW + k * bay
      if (inTransept(a)) continue
      if (buttress !== 'none') {
        const t = buttress === 'flying' ? Math.max(2.2, wa * 0.9) : 1.4
        for (const sd of [-1, 1]) extra.push([B(a - 0.6, a + 0.6, sd * hb, sd * (hb + t)), 'temple'])
      }
      if (chapels && k < bays - 1 && !inTransept(a + bay / 2)) for (const sd of [-1, 1]) extra.push([B(a + 1, a + bay - 1, sd * hb, sd * (hb + wa * 0.7)), 'temple'])
    }
    if (porch) {
      const a = aW + bay * 1.5
      extra.push([B(a - 2.2, a + 2.2, -gs * hb, -gs * (hb + 4)), 'temple'])
    }
    if (campanile) {
      const q = wn * 0.9
      extra.push([B(aW + q * 0.2, aW + q * 1.2, -gs * (hb + 5), -gs * (hb + 5 + q)), 'tower'])
    }
    // 回廊院：中殿一侧、耳堂以西（东廊让开耳堂）一方四面的廊，当中是草地；牧师会堂（八角形）接在东廊外
    const side = hb + (buttress === 'flying' ? Math.max(2.2, wa * 0.9) : 1.4) + (chapels ? wa * 0.7 : 0)
    const ue = transept === 'none' ? L * 0.1 : ac - wn - 2
    const cs = Math.min(L * 0.42, hb * 3.4, ue - aW - 1)
    let cl: { ranges: [Poly, BuildingKind][]; garth: Poly; around: Poly; chapter: Poly | null } | null = null
    if (withCloister && cs > 14) {
      const t = Math.max(2.5, cs * 0.14)
      const [u0, u1] = [ue - cs, ue]
      const [v0, v1] = gs > 0 ? [side + 1.5, side + 1.5 + cs] : [-side - 1.5 - cs, -side - 1.5]
      const r = Math.min(cs * 0.22, 7)
      cl = {
        ranges: [
          [B(u0, u1, v0, v0 + t), 'hall'],
          [B(u0, u1, v1 - t, v1), 'hall'],
          [B(u0, u0 + t, v0 + t, v1 - t), 'hall'],
          [B(u1 - t, u1, v0 + t, v1 - t), 'hall'],
        ],
        garth: B(u0 + t, u1 - t, v0 + t, v1 - t),
        around: B(u0 - 2, u1 + 2 + (chapter ? r * 2 : 0), v0 - 2, v1 + 2),
        chapter: chapter ? circlePoly(at(F, u1 + r + 0.5, (v0 + v1) / 2), r, 8, Math.PI / 8) : null,
      }
    }
    return { c, L, hb, core, extra, cl }
  }
  const ok = (t: ReturnType<typeof make>) => [...t.core, ...(t.cl?.ranges ?? [])].every(([p]) => inside(p, block) && isFree(ctx, p, { pad: 1.5 }))
  // 先连回廊院一起找位置，放不下再只放教堂
  let withCloister = cloister
  let got = cloister ? fit(inner, make, ok, [1, 0.85]) : null
  if (!got) {
    withCloister = false
    got = fit(inner, make, ok)
  }
  if (!got || !addGroup(ctx, [...got.core, ...(got.cl?.ranges ?? [])], 1.5)) {
    if (o.fill !== false) urban(ctx, block, 'common')
    return false
  }
  for (const [p, k] of got.extra) if (inside(p, block)) place(ctx, p, k, { pad: 0.5 })
  C.note('scale', got.L < L0 * 0.8 ? 'small' : 'full')
  const { c: tc, L, hb, cl } = got
  const reserve: Poly[] = [rect(tc, east, L + 14, hb * 2 + 30)]
  // 西门前的广场
  const fore = rect([tc[0] - east[0] * (L * 0.5 + 8), tc[1] - east[1] * (L * 0.5 + 8)], east, 16, hb * 3)
  if (isFree(ctx, fore, { tags: ['wall', 'river'] })) emitArea(ctx, 'plazas', fore)
  const beside = (sd: number, k: number): P => [tc[0] + north[0] * sd * k, tc[1] + north[1] * sd * k]
  const walled = !!cl
  if (cloister) C.note('cloisterBuilt', walled ? 'y' : 'n')
  if (cl) {
    emitArea(ctx, 'greens', cl.garth, 'courtyard')
    ctx.occ.add(cl.garth)
    reserve.push(cl.around)
    if (cl.chapter && inside(cl.chapter, block)) place(ctx, cl.chapter, 'temple', { pad: 0.5 })
  }
  if (!walled) {
    const gz = placeable(ctx, rect(beside(gs, hb + L * 0.3), east, L * 0.7, hb * 2.4), 2)
    if (gz && area(gz) > 60 && inside(gz, block)) {
      reserve.push(gz)
      graves(ctx, gz, east)
    }
  }
  const tz = placeable(ctx, rect(beside(-gs, hb + L * 0.3), east, L * 0.7, hb * 2.2), 2)
  if (tz && inside(tz, block)) {
    reserve.push(tz)
    scatterTrees(ctx, tz, 0.006, 2.5, 4)
  }
  // 名所（山上的修道院、朝圣教堂）按大地标取名；small 是堂区教堂（都不耗主随机数）
  if (o.label) ctx.out.landmarks.push({ p: tc, name: ctx.namer.sacred(o.label, o.key ?? `${Math.round(tc[0])},${Math.round(tc[1])}`), kind: 'temple', major: true })
  else if (tier === 'small') ctx.out.landmarks.push({ p: tc, name: ctx.namer.sacred('parish', o.key ?? `${Math.round(tc[0])},${Math.round(tc[1])}`), kind: 'shrine' })
  else if (tier === 'grand') ctx.out.landmarks.push({ p: tc, name: ctx.namer.sacred('cathedral', `${Math.round(tc[0])},${Math.round(tc[1])}`), kind: 'temple' })
  else mark(ctx, tc, 'temple')
  C.done(tc)
  if (tier === 'grand' || o.label === 'abbey') close(ctx, block, reserve, o.label === 'abbey')
  else if (o.fill !== false) urban(ctx, block, 'common', reserve)
  return true
}

/**
 * 大教堂的教士区（cathedral close）：一圈围墙，门朝城里；主教宫在教堂一侧，教士（咏礼司铎）的住宅沿墙排成一圈，
 * 当中是草地与几棵大树（索尔兹伯里、威尔斯的 close）。
 */
function close(ctx: Ctx, block: Poly, reserve: Poly[], abbey = false) {
  // 山上的修道院坡陡，不按坡度挑剔：只让开水与路
  const w = clipWater(ctx, insetConvex(block, 1.5), 2)
  const zone = w && ctx.corridors.clip(w)
  if (!zone || zone.length < 3) return
  emitArea(ctx, 'enclosures', zone)
  emitArea(ctx, 'greens', zone, 'park')
  const busy = (q: Poly) => reserve.some((r) => r.some((v) => pointInPoly(v, q)) || q.some((v) => pointInPoly(v, r)))
  // 主教宫：离教堂最远的一段墙内侧的大厅
  const ring = insetConvex(zone, 3)
  let palace = false
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const L = dmath.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 16) continue
    const u: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    const c = centroid(zone)
    let n: P = [-u[1], u[0]]
    if ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]]
    // 沿墙每 14 米一栋教士的住宅（两层、带小院），最长的一段墙当中是主教宫
    for (let s = 8; s < L - 8; s += 14) {
      const m: P = [a[0] + u[0] * s + n[0] * 5.5, a[1] + u[1] * s + n[1] * 5.5]
      const wantPalace = !palace && L > 40 && Math.abs(s - L / 2) < 8
      const q = wantPalace ? rect([m[0] + n[0] * 3, m[1] + n[1] * 3], u, 24, 13) : rect(m, u, 10, 8)
      if (busy(q) || !pointInPoly(centroid(q), zone) || !q.every((v) => pointInPoly(v, zone))) continue
      if (place(ctx, q, wantPalace ? 'hall' : 'large', { pad: 1 }, wantPalace ? { role: abbey ? '院长居所' : '主教宫' } : { role: abbey ? '修士房舍' : '教士住宅', floors: 2, units: 0 })) {
        if (wantPalace) palace = true
        s += wantPalace ? 12 : 0
      }
    }
  }
  // 修道院的园：空地上成行的果树；教士区是草地上几棵大树
  if (abbey) {
    const [x0, y0, x1, y1] = [Math.min(...zone.map((v) => v[0])), Math.min(...zone.map((v) => v[1])), Math.max(...zone.map((v) => v[0])), Math.max(...zone.map((v) => v[1]))]
    const inner = insetConvex(zone, 4)
    for (let x = x0 + 3; x < x1; x += 6)
      for (let y = y0 + 3; y < y1; y += 6) {
        const q: P = [x, y]
        if (pointInPoly(q, inner) && !reserve.some((r) => pointInPoly(q, r))) plantTree(ctx, q, 1.7)
      }
  } else scatterTrees(ctx, insetConvex(zone, 8), 0.0025, 3, 5)
}
