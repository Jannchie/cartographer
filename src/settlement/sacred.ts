import { clear } from './civic'
import { emitArea, cityDice, hashAt, inCity, isFree, memo, type Ctx } from './ctx'
import { add, bboxOf, centroid, circlePoly, dist, insetConvex, pointAt, pointInPoly, polylineDist, polylineLength, growConvex, rect, resample, segDist, segPolyDist, sub, unit, LineIndex, type P, type Poly } from './geom'
import { eastCompound } from './compose/chinese'
import { westCastle } from './compose/castle'
import { westChurch } from './compose/church'
import type { SacredKind } from './names'
import { placeMosque } from './plans/medina'
import { shrines } from './styles/wa'
import { levelTerrain, routeOnTerrain } from './terrain'
import { tierLog } from './tiers'
import type { Building, BuildingKind, Tri, Wall } from './types'
import { addWall, gateStreets, smoothRoute, WALL_CLEAR, wallCorridor } from './walls'
import { checkpoint, drop, rollback } from './undo'
import { place, plantTree, scatterTrees } from './wards'
import { isVillage } from './scale'
import { nearestRoad, roadsNear } from './roads'
import * as dmath from '../gen/dmath'

/**
 * 名所：按地形才有的"招牌"布置，城边、城外挑合适的地方盖，放在片区、地标、城外设施都盖好以后。
 * - 和风：千本鸟居（山脚的稻荷社，一条朱红的鸟居隧道蜿蜒上坡到奥社）、海上鸟居（临海的社，拜殿架在水上，
 *   海里立一座大鸟居）、奥宫（山顶的小社，石阶从山下的神社一路上去）、神桥（社前过河的朱漆桥）
 * - 东方（和风也有）：山寺（山坡上的寺，石阶上山）、山头的塔
 * - 西式：山上的修道院（围墙里的教堂、回廊、菜园鱼塘）、朝圣教堂（山顶的小教堂，一路上去是苦路十四处）、岩上的城堡
 * - 伊斯兰：山头的里巴特（四角碉楼的方堡，里面一座小清真寺）
 * 有没有、有几处按城的骰子（只看种子）与地形定：地形不合适就没有；人口变了，骰子不变，已有的名所不挪。
 * 一切落地都不压路、水、别的建筑（只清走田与树）。
 */
export function sacredSites(ctx: Ctx) {
  if (ctx.p.size === 'hamlet') return
  const c = ctx.p.culture
  const V = cityDice(ctx, 'sacred')
  const town = !isVillage(ctx.p.size)
  const big = ctx.p.size === 'city'
  // 城越大、越"神圣"（奇幻城、都城），名所越多
  const k = (big ? 1 : town ? 0.8 : 0.35) * (ctx.p.function === 'magic' || ctx.p.capital ? 1.25 : 1)
  // 名所难得一见：越有名的越少（千本鸟居、海上鸟居最少），常见些的山寺、山头塔多一点
  const tries: [string, number, () => boolean][] = []
  if (c === 'wa') {
    tries.push(['senbon', 0.15 * k, () => senbonTorii(ctx)])
    tries.push(['umi', 0.2 * k, () => umiTorii(ctx)])
    tries.push(['okumiya', 0.2 * k, () => okumiya(ctx)])
    tries.push(['shinkyo', 0.2 * k, () => shinkyo(ctx)])
    tries.push(['yamadera', 0.12 * k, () => yamadera(ctx)])
  }
  if (c === 'eastern') {
    tries.push(['yamadera', 0.25 * k, () => yamadera(ctx)])
    tries.push(['pagoda', 0.2 * k, () => hillPagoda(ctx)])
  }
  if (c === 'wa') tries.push(['pagoda', 0.1 * k, () => hillPagoda(ctx)])
  if (c === 'western') {
    tries.push(['abbey', 0.2 * k, () => abbey(ctx)])
    tries.push(['pilgrim', 0.15 * k, () => calvary(ctx)])
    tries.push(['crag', (ctx.p.function === 'fortress' ? 0.45 : 0.15) * k, () => cragCastle(ctx)])
  }
  if (c === 'islamic') tries.push(['ribat', (ctx.p.function === 'fortress' ? 0.45 : 0.18) * k, () => ribat(ctx)])
  // 一座城至多两处名所（城镇、村落一处）；按种子排先后，免得总是表里靠前的先占了名额
  let left = big ? 2 : 1
  tries
    .map((t) => ({ t, o: V.h(`${t[0]}.order`) }))
    .sort((a, b) => a.o - b.o)
    .forEach(({ t: [id, p, run] }) => {
      if (left <= 0 || V.h(`${id}.roll`) >= p) return
      if (!run()) return
      left--
      tierLog(ctx).push({ kind: id, tier: 'grand', p: ctx.out.landmarks.at(-1)?.p ?? ctx.center })
    })
}

// —————————————————————— 共用 ——————————————————————

const keyOf = (q: P) => `${Math.round(q[0])},${Math.round(q[1])}`
const name = (ctx: Ctx, kind: SacredKind, q: P): Tri => ctx.namer.sacred(kind, keyOf(q))
const onMap = (ctx: Ctx, q: P, m = 60) => q[0] > m && q[1] > m && q[0] < ctx.MW - m && q[1] < ctx.MH - m

/** 城区边缘（城内片区中心）到 q 的距离 */
function edgeDist(ctx: Ctx, q: P): number {
  // 名所都在城区长好以后才选址：城内片区的中心算一次就够
  const cores = memo(ctx, 'sacred.cores', () => ctx.out.wards.filter((w) => w.inner).map((w) => centroid(w.poly)))
  let d = Infinity
  for (const c of cores) d = Math.min(d, dist(c, q))
  return d - ctx.cfg.patch * 0.55
}

/** 高程梯度（指向上坡），单位向量；平地返回 null */
function uphill(ctx: Ctx, q: P): P | null {
  const T = ctx.T
  const gx = T.heightAt([q[0] + 4, q[1]]) - T.heightAt([q[0] - 4, q[1]])
  const gy = T.heightAt([q[0], q[1] + 4]) - T.heightAt([q[0], q[1] - 4])
  const L = dmath.hypot(gx, gy)
  return L < 0.05 ? null : [gx / L, gy / L]
}

/** 一块地能不能用：不压水、路、墙与任何建筑（田与树可以清走） */
const free = (ctx: Ctx, poly: Poly, pad = 1) => isFree(ctx, poly, { pad, water: 4 })

/** 折线沿途有没有压到建筑、水面（树与田不算） */
function lineFree(ctx: Ctx, line: P[], hw: number, water = 1.5): boolean {
  for (const q of resample(line, 2)) if (ctx.T.waterAt(q) < water) return false
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]
    const b = line[i + 1]
    const bb = bboxOf([a, b])
    for (const poly of ctx.occ.query([bb[0] - hw, bb[1] - hw, bb[2] + hw, bb[3] + hw])) if (segPolyDist(a, b, poly) < hw) return false
  }
  return true
}

/** 清走折线两旁 r 米以内的树 */
function clearTrees(ctx: Ctx, line: P[], r: number) {
  const idx = new LineIndex(line, r + ctx.out.trees.reduce((m, t) => Math.max(m, t.r), 0) * 0.5)
  drop(ctx, 'trees', (t) => idx.nearPoint(t.p, r + t.r * 0.5))
}

/** 地面沿坡寻路（避开房子、少过水），磨圆 */
function route(ctx: Ctx, from: P, to: P, slope: number): P[] {
  const bias = (q: P) => (ctx.occ.hitsPoint(q, 4.5) ? 40 : ctx.corridors.hits(q, 0, ['road']) ? 0.7 : 1)
  const raw = routeOnTerrain(ctx.T, from, to, { water: 30, slope, bias })
  return raw.length > 1 ? smoothRoute(raw, 3, ctx.T) : []
}

/**
 * 从附近的路修一条上山的路（石阶或小径）到 to：沿途不压房子与水，修好登记走廊、清走两旁的树。
 * 最近的几条路依次试；都接不上（太远、压房子）返回 null。
 */
function approach(ctx: Ctx, to: P, kind: 'stair' | 'path', w: number, within = 450): P[] | null {
  for (const { p: from } of roadsNear(ctx, to, within).slice(0, 4)) {
    const line = route(ctx, from, to, kind === 'stair' ? 0.35 : 0.8)
    if (line.length < 2) continue
    // 起点从路边退出路面，免得新路压在路上；终点的最后两米是地标门前，不查
    const body = trimStart(ctx, line)
    if (body.length < 2 || !lineFree(ctx, body.slice(0, -1), w / 2 + 0.3)) continue
    return commit(ctx, body, kind, w)
  }
  return null
}

/** 去掉起点落在已有道路走廊里的一段（新路从路边接出去） */
function trimStart(ctx: Ctx, line: P[]): P[] {
  const pts = resample(line, 1.5)
  let k = 0
  while (k < pts.length - 2 && ctx.corridors.hits(pts[k], 0.3, ['road'])) k++
  return pts.slice(Math.max(0, k - 1))
}

function commit(ctx: Ctx, line: P[], kind: 'stair' | 'path', w: number): P[] {
  ctx.out.roads.push({ line, width: w, kind })
  ctx.corridors.add(line, w / 2 + 0.6)
  clearTrees(ctx, line, w / 2 + 0.6)
  return line
}

/** 在水里（码头、鸟居、架在水上的殿）放一栋：不碰路、墙与别的实体 */
function placeWet(ctx: Ctx, poly: Poly, kind: BuildingKind, extra?: Partial<Building>): boolean {
  if (ctx.corridors.hitsPoly(poly, 0.3, ['road', 'wall']) || ctx.occ.overlaps(poly, 0.3)) return false
  const b = { poly, kind, tone: hashAt(ctx, centroid(poly), 'sacred.tone'), ridge: 0, ...extra }
  ctx.out.buildings.push(b)
  ctx.occ.add(poly)
  return true
}

/**
 * 山头：局部最高（周围 40 米一圈都比它低）、高出城心 rise 米以上、离城区边缘 d0 ~ d1 米、
 * 顶上 size 米见方的地干净（没有房子、路、水）。按"高、近"排序。
 */
function hilltops(ctx: Ctx, o: { d0: number; d1: number; rise: number; size: number; tag: string }): P[] {
  const T = ctx.T
  const h0 = T.heightAt(ctx.center)
  const out: { q: P; s: number }[] = []
  const step = 24
  for (const [x, y] of gridPts(ctx, step, 80)) {
      const q: P = [x + (hashAt(ctx, [x, y], `${o.tag}.x`) - 0.5) * step * 0.6, y + (hashAt(ctx, [x, y], `${o.tag}.y`) - 0.5) * step * 0.6]
      const h = T.heightAt(q)
      if (h - h0 < o.rise || T.waterAt(q) < 30 || T.slopeAt(q) > 0.45) continue
      let top = true
      for (let a = 0; a < 8 && top; a++) if (T.heightAt(add(q, [dmath.cos((a * Math.PI) / 4), dmath.sin((a * Math.PI) / 4)], 40)) > h + 0.3) top = false
      if (!top) continue
      const e = edgeDist(ctx, q)
      if (e < o.d0 || e > o.d1 || inCity(ctx, q)) continue
      // 打分只看不随人口变的东西（高差、离城心多远、位置哈希）：城长大时挑中的山头不变
      out.push({ q, s: h - h0 - dist(q, ctx.center) * 0.01 + hashAt(ctx, q, `${o.tag}.score`) * 4 })
    }
  out.sort((a, b) => b.s - a.s)
  const picked: P[] = []
  // 别的名所已经占了的山头（修道院与朝圣教堂不挤在一座山上）
  const taken = tierLog(ctx).filter((r) => r.tier === 'grand').map((r) => r.p)
  for (const { q } of out) {
    if (picked.some((p) => dist(p, q) < 60) || taken.some((p) => dist(p, q) < 260)) continue
    // 山顶未必正好平：顶上的方块往下探一点也行
    if (!free(ctx, rect(q, [1, 0], o.size, o.size), 1)) continue
    picked.push(q)
    if (picked.length >= 12) break
  }
  return picked
}

/** 名所的一个地标（按大地标标注）；lift：注记往北挪几米，不压着塔、小社本身 */
function landmark(ctx: Ctx, p: P, n: Tri, kind: 'shrine' | 'temple' | 'castle' = 'shrine', major = true, lift = 0) {
  ctx.out.landmarks.push({ p: [p[0], p[1] - lift], name: n, kind, major })
}

/**
 * 一座小社：前沿中点 c，f 从鸟居往里；拜殿、本殿、鸟居、社地的院墙与林。s 是尺度（1 约 30 × 22 米）。
 * 放不下返回 null；返回社地与本殿背后的点。
 */
function miniShrine(ctx: Ctx, c: P, f: P, s: number, o: { torii?: number; role?: string; grove?: number } = {}): { precinct: Poly; back: P; hall: P } | null {
  const l: P = [-f[1], f[0]]
  const at = (a: number, b: number): P => [c[0] + f[0] * a + l[0] * b, c[1] + f[1] * a + l[1] * b]
  const box = (a0: number, a1: number, b0: number, b1: number): Poly => [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]
  const D = 30 * s
  const W = 22 * s
  const precinct = box(0, D, -W / 2, W / 2)
  const haiden = box(D * 0.42, D * 0.42 + 7 * s, -4.5 * s, 4.5 * s)
  const honden = box(D * 0.7, D * 0.7 + 5.5 * s, -2.8 * s, 2.8 * s)
  if (!free(ctx, precinct, 0.5)) return null
  clear(ctx, precinct)
  place(ctx, haiden, 'hall', { pad: 0.2 })
  place(ctx, honden, 'temple', { pad: 0.2 }, o.role ? { role: o.role } : undefined)
  const nt = o.torii ?? 1
  for (let k = 0; k < nt; k++) {
    const a = 2 + k * Math.min(6, (D * 0.3) / Math.max(1, nt))
    place(ctx, box(a, a + 0.8, -3.2 * Math.max(0.8, s), 3.2 * Math.max(0.8, s)), 'torii', { pad: 0.1 })
  }
  const walk = [at(-1.5, 0), at(D * 0.42, 0)]
  ctx.out.roads.push({ line: walk, width: 2.2, kind: 'path' })
  emitArea(ctx, 'plazas', box(D * 0.3, D * 0.95, -W * 0.3, W * 0.3))
  emitArea(ctx, 'enclosures', precinct)
  ctx.occ.add(box(D * 0.3, D * 0.95, -W * 0.3, W * 0.3))
  const t0 = ctx.out.trees.length
  scatterTrees(ctx, insetConvex(precinct, 1), o.grove ?? 0.012, 2.2, 4.2)
  drop(ctx, 'trees', (t) => segDist(t.p, walk[0], walk[1]).d <= 2.5, t0)
  return { precinct, back: at(D + 1.5, 0), hall: centroid(honden) }
}

// —————————————————————— 和风 ——————————————————————

/**
 * 千本鸟居：山脚的稻荷社，社后一条山道蜿蜒上坡，上面一座挨一座的朱红鸟居（开头一段两条并行），到上面的奥社。
 * 要有坡：山脚的点往上坡 90 ~ 160 米处高出 10 米以上。
 */
function senbonTorii(ctx: Ctx): boolean {
  const T = ctx.T
  const cands: { q: P; up: P; s: number }[] = []
  const step = 28
  for (const q of gridPts(ctx, step, 90)) {
      const sl = T.slopeAt(q)
      if (sl < 0.06 || sl > 0.35 || T.waterAt(q) < 20) continue
      const e = edgeDist(ctx, q)
      if (e < 0 || e > 500 || inCity(ctx, q)) continue
      const up = uphill(ctx, q)
      if (!up) continue
      const top = add(q, up, 130)
      if (!onMap(ctx, top) || T.heightAt(top) - T.heightAt(q) < 10) continue
      cands.push({ q, up, s: dist(q, ctx.center) * 0.004 - (T.heightAt(top) - T.heightAt(q)) * 0.05 + hashAt(ctx, q, 'sacred.senbon') * 2 })
    }
  cands.sort((a, b) => a.s - b.s)
  for (const { q, up } of cands.slice(0, 30)) {
    // 社的正面朝下坡（鸟居在山脚），往里是上坡
    const base = add(q, up, -18)
    if (!nearestRoad(ctx, base, 260)) continue
    const cp = checkpoint(ctx)
    const sh = miniShrine(ctx, base, up, 1, { torii: 2, grove: 0.01 })
    if (!sh) continue
    const top = add(q, up, 140)
    const trail = route(ctx, sh.back, top, 0.25)
    const body = trail.length > 1 ? resample(trail, 1.2) : []
    const L = polylineLength(body)
    const hw = 2.4
    if (L < 60 || !lineFree(ctx, body.slice(6), hw + 1.6) || !approach(ctx, add(base, up, -1.5), 'path', 2.4, 260)) {
      rollback(ctx, cp)
      continue
    }
    // 奥社
    const endDir = unitOf(body[body.length - 1], body[body.length - 6] ?? body[0])
    const oku = rect(add(body[body.length - 1], endDir, -4.5), endDir, 5, 6)
    if (!free(ctx, oku, 0.5)) {
      rollback(ctx, cp)
      continue
    }
    place(ctx, oku, 'temple', { pad: 0.2 }, { role: '奥社' })
    ctx.out.roads.push({ line: body, width: 1.6, kind: 'path' })
    clearTrees(ctx, body, hw + 1)
    // 鸟居：约 1.2 米一座；开头一段两条并行（千本鸟居的双隧道）
    const twin = L * 0.35
    let made = 0
    for (let s = 3; s < L - 6; s += 1.1) {
      const { p, angle } = pointAt(body, s)
      const u: P = [dmath.cos(angle), dmath.sin(angle)]
      const n: P = [-u[1], u[0]]
      const at = s < twin ? [-1.9, 1.9] : [0]
      for (const o of at) if (placeWet(ctx, rect(add(p, n, o), u, 0.6, s < twin ? 2.6 : 3.2), 'torii', { role: '千本鸟居' })) made++
    }
    // 山道两旁是密林
    const wood = rect(centroid(body), unitOf(body[0], body[body.length - 1]), L * 0.9, 40)
    const t0 = ctx.out.trees.length
    scatterTrees(ctx, wood, 0.014, 2.2, 4)
    drop(ctx, 'trees', (t) => polylineDist(t.p, body) <= hw + t.r * 0.4, t0)
    ctx.corridors.add(body, hw)
    landmark(ctx, sh.hall, name(ctx, 'inari', sh.hall), 'shrine', true, 18)
    ctx.out.landmarks.push({ p: pointAt(body, L * 0.5).p, name: { zh: '千本鸟居', en: 'Senbon Torii', ja: '千本鳥居' }, kind: 'shrine' })
    return made > 20
  }
  return false
}

/**
 * 海上鸟居（严岛式）：海边的社，本殿在岸上，拜殿、平舞台与回廊架在水上的桩基上，海里百来米处立一座大鸟居。
 */
function umiTorii(ctx: Ctx): boolean {
  const T = ctx.T
  if (!T.coast) return false
  const cands: { q: P; s: number }[] = []
  for (const q of gridPts(ctx, 12, 60)) {
      const w = T.waterAt(q)
      if (w < 3 || w > 9) continue
      const g = T.waterGrad(q)
      const sea = add(q, g, -60)
      if (!T.seaAt(sea) || !T.seaAt(add(q, g, -20))) continue
      const e = edgeDist(ctx, q)
      if (e < -40 || e > 700) continue
      cands.push({ q, s: dist(q, ctx.center) * 0.003 + hashAt(ctx, q, 'sacred.umi') * 1.5 })
    }
  cands.sort((a, b) => a.s - b.s)
  for (const { q } of cands.slice(0, 160)) {
    const g = T.waterGrad(q)
    // f 从海往岸（社的纵深），岸线在 q
    const f: P = [g[0], g[1]]
    const l: P = [-f[1], f[0]]
    const at = (a: number, b: number): P => [q[0] + f[0] * a + l[0] * b, q[1] + f[1] * a + l[1] * b]
    const box = (a0: number, a1: number, b0: number, b1: number): Poly => [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]
    // 岸上：本殿与社地
    const land = box(4, 36, -18, 18)
    if (!free(ctx, land, 0.5)) continue
    // 水上：平舞台与拜殿（伸出去 26 米），两翼的回廊
    const stage = box(-26, 3, -7, 7)
    const wings = [box(-14, 3, -24, -19), box(-14, 3, 19, 24), box(-17, -14, -24, 24)]
    const deck = [stage, ...wings]
    if (deck.some((p) => ctx.corridors.hitsPoly(p, 0.5, ['road', 'wall']) || ctx.occ.overlaps(p, 1))) continue
    if (!deck.every((p) => p.some((v) => T.waterAt(v) < 0))) continue
    // 大鸟居：海里离平舞台三四十米外，要整个在水里
    let torii: Poly | null = null
    for (const a of [-62, -72, -55, -85]) {
      const tq = box(a - 1.1, a + 1.1, -8, 8)
      if (tq.every((v) => T.waterAt(v) < -3 && T.seaAt(v)) && !ctx.occ.overlaps(tq, 2)) {
        torii = tq
        break
      }
    }
    if (!torii) continue
    const cp = checkpoint(ctx)
    clear(ctx, land)
    // 水上的殿先落地，再铺桩基上的平台（前面已查过不碰路、墙与别的东西；几块平台彼此相连）
    placeWet(ctx, box(-20, -12, -5, 5), 'hall', { role: '拜殿（水上）' })
    placeWet(ctx, box(-12, -4, -3.5, 3.5), 'hall', { role: '币殿（水上）' })
    for (const b of [-21.5, 21.5]) placeWet(ctx, box(-12, -4, b - 2, b + 2), 'hall', { role: '回廊（水上）' })
    for (const p of deck) ctx.out.piers.push(p)
    for (const p of deck) ctx.occ.add(p)
    const honden = box(8, 17, -5, 5)
    place(ctx, honden, 'temple', { pad: 0.2 }, { role: '本殿' })
    place(ctx, box(20, 28, 7, 15), 'hall', { pad: 0.2 }, { role: '社务所' })
    placeWet(ctx, torii, 'torii', { role: '海上鸟居' })
    emitArea(ctx, 'enclosures', land)
    // 社后的林
    scatterTrees(ctx, box(22, 40, -26, 26), 0.02, 2.4, 4.4)
    if (!approach(ctx, at(37, 0), 'path', 2.6, 320)) {
      rollback(ctx, cp)
      continue
    }
    // 社名标在岸上一侧（水上的殿与平台留给图面）
    landmark(ctx, at(46, 0), name(ctx, 'umi', q))
    ctx.out.landmarks.push({ p: centroid(torii), name: { zh: '海上鸟居', en: 'Floating Torii', ja: '海上鳥居' }, kind: 'shrine' })
    return true
  }
  return false
}

/**
 * 奥宫：山头上的一座小社，长长的石阶从山脚的神社（本社）后面一路上去。山脚四五百米内已有神社就从它出发，
 * 没有就在山脚修一座本社（面朝山下，背靠山）。
 */
function okumiya(ctx: Ctx): boolean {
  const recs = shrines(ctx)
  const tops = hilltops(ctx, { d0: 40, d1: 900, rise: 18, size: 26, tag: 'sacred.okumiya' })
  for (const top of tops) {
    // 山脚：从山头往城的方向下坡，到坡缓了或快到城边为止
    const toCity = unitOf(ctx.center, top)
    let foot = top
    for (let k = 0; k < 40; k++) {
      const nx = add(foot, toCity, 10)
      if (ctx.T.slopeAt(nx) < 0.05 || edgeDist(ctx, nx) < 50 || ctx.T.waterAt(nx) < 15) break
      foot = nx
    }
    if (dist(foot, top) < 110) continue
    const cp = checkpoint(ctx)
    const f = unitOf(top, foot)
    // 奥宫的小社朝着上来的石阶
    const sh = miniShrine(ctx, add(top, f, -12), f, 0.75, { torii: 1, role: '奥宫本殿', grove: 0.008 })
    if (!sh) continue
    // 本社：附近已有的神社，或在山脚新修一座
    const near = recs.filter((r) => dist(r.back, foot) < 420).sort((x, y) => dist(x.back, foot) - dist(y.back, foot))[0]
    let from: { back: P; precinct: Poly } | null = near ?? null
    let made = false
    if (!from) {
      const base = miniShrine(ctx, add(foot, f, -34), f, 1.2, { torii: 2, grove: 0.014 })
      if (base && approach(ctx, add(add(foot, f, -34), f, -1.5), 'path', 2.6, 300)) {
        from = base
        made = true
      }
    }
    if (!from) {
      rollback(ctx, cp)
      continue
    }
    const stair = route(ctx, from.back, add(top, f, -14), 0.3)
    const body = stair.length > 1 ? trimShrine(stair, from.precinct) : []
    if (body.length < 2 || polylineLength(body) < 100 || !lineFree(ctx, body.slice(1), 1.6)) {
      rollback(ctx, cp)
      continue
    }
    commit(ctx, body, 'stair', 2.4)
    // 石阶口的鸟居
    const d0 = unitOf(body[Math.min(3, body.length - 1)], body[0])
    place(ctx, rect(add(body[0], d0, 2), d0, 0.8, 5), 'torii', { pad: 0.1 })
    if (made) landmark(ctx, from.back, ctx.namer.sacred('villageShrine', keyOf(foot)), 'shrine', false)
    landmark(ctx, sh.hall, name(ctx, 'okumiya', top), 'shrine', true, 14)
    return true
  }
  return false
}

/** 石阶从社地里出发：社地里的一段不算（社地是空的，但院墙、树要让开） */
function trimShrine(line: P[], precinct: Poly): P[] {
  const pts = resample(line, 1.5)
  let k = 0
  while (k < pts.length - 2 && pointInPoly(pts[k], precinct)) k++
  return pts.slice(Math.max(0, k - 1))
}

/**
 * 神桥：城边的河上一座朱漆的桥，过了桥是社前的参道与鸟居（日光的神桥、宫岛的朱桥）。
 */
function shinkyo(ctx: Ctx): boolean {
  const T = ctx.T
  if (!T.river) return false
  const line = T.river.line
  const L = polylineLength(line)
  const cands: { s: number; key: number }[] = []
  for (let s = 40; s < L - 40; s += 10) {
    const q = pointAt(line, s).p
    const e = edgeDist(ctx, q)
    if (e < 0 || e > 600 || !onMap(ctx, q, 100)) continue
    // 位置取到 20 米的格上再哈希：河道的起点随地图大小变，按弧长取的点会错开
    cands.push({ s, key: dist(q, ctx.center) * 0.001 + hashAt(ctx, [ctx.MW / 2 + Math.round((q[0] - ctx.MW / 2) / 20) * 20, ctx.MH / 2 + Math.round((q[1] - ctx.MH / 2) / 20) * 20], 'sacred.shinkyo') })
  }
  cands.sort((a, b) => a.key - b.key)
  for (const { s } of cands.slice(0, 40)) {
    const { p: q, angle } = pointAt(line, s)
    const hw = T.river.hw[Math.min(T.river.hw.length - 1, Math.round((s / L) * (T.river.hw.length - 1)))]
    if (hw > 22) continue
    const n: P = [-dmath.sin(angle), dmath.cos(angle)]
    // 离城心远的一岸是社
    const side = dist(add(q, n, 40), ctx.center) > dist(add(q, n, -40), ctx.center) ? 1 : -1
    const f: P = [n[0] * side, n[1] * side]
    // 桥头：两岸离水 2 米处
    let a0 = hw
    while (a0 < hw + 30 && T.waterAt(add(q, f, -a0)) < 2) a0 += 1
    let a1 = hw
    while (a1 < hw + 30 && T.waterAt(add(q, f, a1)) < 2) a1 += 1
    const A = add(q, f, -a0)
    const B = add(q, f, a1)
    if (dist(A, B) > 50 || ctx.out.crossings.some((c) => dist(c.a, q) < 90 || dist(c.b, q) < 90)) continue
    const deck = rect(add(A, f, dist(A, B) / 2), f, dist(A, B) + 4, 5)
    if (ctx.corridors.hitsPoly(deck, 0.5, ['road', 'wall']) || ctx.occ.overlaps(deck, 1)) continue
    const cp = checkpoint(ctx)
    const sh = miniShrine(ctx, add(B, f, 16), f, 1.1, { torii: 2, grove: 0.014 })
    if (!sh) continue
    const sando = [add(A, f, -1), B, add(B, f, 15)]
    if (!lineFree(ctx, [B, add(B, f, 15)], 1.6) || !approach(ctx, add(A, f, -1.5), 'path', 2.6, 260)) {
      rollback(ctx, cp)
      continue
    }
    ctx.out.roads.push({ line: sando, width: 3, kind: 'path' })
    ctx.out.crossings.push({ a: A, b: B, width: 4, kind: 'bridge', sacred: true })
    ctx.occ.add(deck)
    place(ctx, rect(add(B, f, 4), f, 0.9, 7), 'torii', { pad: 0.1 })
    landmark(ctx, sh.hall, ctx.namer.sacred('villageShrine', keyOf(sh.hall)), 'shrine', false)
    ctx.out.landmarks.push({ p: add(A, f, dist(A, B) / 2), name: name(ctx, 'shinkyo', q), kind: 'shrine', major: true })
    return true
  }
  return false
}

// —————————————————————— 东方与和风的寺、塔 ——————————————————————

/** 山寺：山坡上（或山头）的一座寺院，石阶从山下的路上去 */
function yamadera(ctx: Ctx): boolean {
  const tops = hilltops(ctx, { d0: 120, d1: 1200, rise: 14, size: 70, tag: 'sacred.yamadera' })
  for (const top of tops) {
    // 寺按方格朝向坐北朝南：地盘也顺着这个方向
    const e: P = [dmath.cos(ctx.gridAngle), dmath.sin(ctx.gridAngle)]
    const zone = rect(top, e, 90, 90)
    if (!free(ctx, zone, 1)) continue
    const cp = checkpoint(ctx)
    clear(ctx, rect(top, e, 96, 96))
    const comp = eastCompound(ctx, zone, 'temple')
    if (!comp) {
      rollback(ctx, cp)
      continue
    }
    // 石阶到寺的南面（山门）：寺院按方格朝向坐北朝南
    const a = ctx.gridAngle
    const gate: P = [top[0] - dmath.sin(a) * 50, top[1] + dmath.cos(a) * 50]
    if (!approach(ctx, gate, 'stair', 2.6, 700)) {
      rollback(ctx, cp)
      continue
    }
    // 山头削成一块平台（山寺、修道院都是先平整台地再盖；放得下才动地形，撤回时不用复原）
    levelTerrain(ctx.T, zone, 18)
    scatterTrees(ctx, rect(top, [1, 0], 130, 130), 0.004, 2.5, 4.5)
    landmark(ctx, top, name(ctx, 'yamadera', top), 'temple', true, 52)
    return true
  }
  return false
}

/** 山头的塔（文峰塔、五重塔）：小小的台地上一座塔、一座小殿，小径上去 */
function hillPagoda(ctx: Ctx): boolean {
  const tops = hilltops(ctx, { d0: 40, d1: 700, rise: 10, size: 30, tag: 'sacred.hillPagoda' })
  for (const top of tops) {
    const pad = circlePoly(top, 13, 16)
    if (!free(ctx, pad, 1)) continue
    const cp = checkpoint(ctx)
    clear(ctx, circlePoly(top, 16, 16))
    emitArea(ctx, 'plazas', pad)
    const wa = ctx.p.culture === 'wa'
    // 塔：东方八角，和风方的五重塔
    const tower = place(ctx, wa ? rect(top, [1, 0], 8, 8) : circlePoly(top, 4.6, 8, Math.PI / 8), 'pagoda', { pad: 0.1 }, { role: wa ? '五重塔' : '塔' })
    place(ctx, rect([top[0], top[1] + 9], [1, 0], 9, 4.5), 'hall', { pad: 0.1 })
    ctx.occ.add(pad)
    if (!tower) {
      rollback(ctx, cp)
      continue
    }
    if (!approach(ctx, [top[0], top[1] + 14], 'path', 2, 500)) {
      rollback(ctx, cp)
      continue
    }
    for (let k = 0; k < 7; k++) plantTree(ctx, add(top, [dmath.cos(k * 0.9), dmath.sin(k * 0.9)], 17), 2.6)
    landmark(ctx, top, name(ctx, 'pagoda', top), 'temple', true, 16)
    return true
  }
  return false
}

// —————————————————————— 西式 ——————————————————————

/** 山上的修道院：一圈院墙，里面教堂（多半带回廊院）、院长居所、菜园果园与鱼塘 */
function abbey(ctx: Ctx): boolean {
  const tops = hilltops(ctx, { d0: 150, d1: 1400, rise: 10, size: 80, tag: 'sacred.abbey' })
  for (const top of tops) {
    const zone = rect(top, [1, 0], 110, 90)
    if (!free(ctx, zone, 1)) continue
    const cp = checkpoint(ctx)
    clear(ctx, zone)
    const inner = insetConvex(zone, 4)
    const t0 = ctx.tier
    ctx.tier = 'standard'
    let ok = false
    try {
      ok = westChurch(ctx, zone, inner, { fill: false, key: keyOf(top), label: 'abbey' })
    } finally {
      ctx.tier = t0
    }
    if (!ok || !approach(ctx, [top[0], top[1] + 42], 'path', 2.4, 700)) {
      rollback(ctx, cp)
      continue
    }
    levelTerrain(ctx.T, zone, 18)
    // 修道院的鱼塘（围墙、房舍与果园见 westChurch 的 close）
    const pond = rect([top[0] + 38, top[1] + 28], [1, 0], 14, 9)
    if (free(ctx, pond, 0.5)) {
      ctx.out.parkParts.push({ poly: pond, kind: 'pond' })
      ctx.occ.add(pond)
    }
    return true
  }
  return false
}

/** 朝圣教堂（圣山、Kalvarienberg）：山顶的小教堂，一路上去的小径旁是苦路十四处 */
function calvary(ctx: Ctx): boolean {
  const tops = hilltops(ctx, { d0: 60, d1: 900, rise: 12, size: 40, tag: 'sacred.calvary' })
  for (const top of tops) {
    const zone = rect(top, [1, 0], 40, 34)
    if (!free(ctx, zone, 1)) continue
    const cp = checkpoint(ctx)
    clear(ctx, zone)
    const t0 = ctx.tier
    ctx.tier = 'small'
    let ok = false
    try {
      ok = westChurch(ctx, zone, insetConvex(zone, 3), { fill: false, key: keyOf(top), label: 'pilgrim' })
    } finally {
      ctx.tier = t0
    }
    const path = ok ? approach(ctx, [top[0], top[1] + 19], 'path', 2, 700) : null
    if (!path || polylineLength(path) < 80) {
      rollback(ctx, cp)
      continue
    }
    // 苦路：沿上山的小径十四处小龛
    const L = polylineLength(path)
    for (let k = 1; k <= 14; k++) {
      const { p, angle } = pointAt(path, (L * k) / 15)
      const n: P = [-dmath.sin(angle), dmath.cos(angle)]
      place(ctx, rect(add(p, n, 2.6), [dmath.cos(angle), dmath.sin(angle)], 1.2, 1.2), 'civic', { pad: 0.1 }, { role: '苦路站' })
    }
    return true
  }
  return false
}

/** 岩上的城堡：陡峭的山头上一座城堡，一条之字路上去 */
function cragCastle(ctx: Ctx): boolean {
  const tops = hilltops(ctx, { d0: 80, d1: 1400, rise: 16, size: 60, tag: 'sacred.crag' })
  for (const top of tops) {
    const curtain = circlePoly(top, 32, 9, hashAt(ctx, top, 'sacred.crag.curtain') * 3)
    if (!free(ctx, growConvex(curtain, 2), 1)) continue
    const cp = checkpoint(ctx)
    clear(ctx, growConvex(curtain, 6))
    const w0 = ctx.out.walls.length
    westCastle(ctx, curtain, { connect: false })
    // 上山的小路一直修到城门前
    const g = ctx.out.walls[w0]?.gates[0]
    const front = g && add(g.p, unit(sub(g.p, top)), 6)
    if (!front || !approach(ctx, front, 'path', 3, 800)) {
      rollback(ctx, cp)
      continue
    }
    gateStreets(ctx).add(ctx.out.roads[ctx.out.roads.length - 1])
    // 山上的城堡盖完了再给墙登记走廊（上山的路、树让开墙脚）
    for (const w of ctx.out.walls.slice(w0)) wallCorridor(ctx, w, WALL_CLEAR.compound)
    landmark(ctx, top, name(ctx, 'crag', top), 'castle')
    return true
  }
  return false
}

// —————————————————————— 伊斯兰 ——————————————————————

/** 山头的里巴特 / 卡斯巴：方正的围墙、四角碉楼、一座门，里面沿墙一圈房间、当中一座小清真寺 */
function ribat(ctx: Ctx): boolean {
  const tops = hilltops(ctx, { d0: 80, d1: 1200, rise: 12, size: 56, tag: 'sacred.ribat' })
  for (const top of tops) {
    const S = 48
    const box = rect(top, [1, 0], S, S)
    if (!free(ctx, growConvex(box, 3), 1)) continue
    const cp = checkpoint(ctx)
    clear(ctx, growConvex(box, 6))
    const h = S / 2
    const c = top
    const P2 = (x: number, y: number): P => [c[0] + x, c[1] + y]
    const loop: P[] = [P2(-2.5, h), P2(-h, h), P2(-h, -h), P2(h, -h), P2(h, h), P2(2.5, h)]
    const wall: Wall = { loop, solid: loop.map((_, i) => i !== loop.length - 1), towers: [P2(-h, h), P2(-h, -h), P2(h, -h), P2(h, h)], gates: [], kind: 'stone', thickness: 2.4 }
    // 沿墙一圈房间（北、东、西三面），当中的院子里一座小清真寺；房间先盖，墙的走廊后登记
    const t = 6
    const y0 = -h + 3
    place(ctx, rect(P2(0, y0 + t / 2), [1, 0], S - 6, t), 'hall', { pad: 0.2 }, { role: '里巴特的房间' })
    for (const sx of [-1, 1]) place(ctx, rect(P2(sx * (h - 3 - t / 2), (y0 + t + 0.6 + h - 6) / 2), [0, 1], h - 6 - (y0 + t + 0.6), t), 'hall', { pad: 0.2 }, { role: '里巴特的房间' })
    emitArea(ctx, 'plazas', rect(P2(0, 2), [1, 0], S - 20, S - 22))
    placeMosque(ctx, rect(P2(0, 1), [1, 0], 22, 20), rect(P2(0, 1), [1, 0], 26, 24), 18, 15, false)
    addWall(ctx, wall, 'compound')
    if (!approach(ctx, P2(0, h + 4), 'path', 2.6, 800)) {
      rollback(ctx, cp)
      continue
    }
    landmark(ctx, top, name(ctx, ctx.p.function === 'fortress' || hashAt(ctx, top, 'sacred.ribat.kind') < 0.5 ? 'ribat' : 'crag', top), 'castle')
    return true
  }
  return false
}

// —————————————————————— 小工具 ——————————————————————

/** 以地图中心（世界原点）对齐的格点：地图随人口变大时，同一处的格点不变 */
function gridPts(ctx: Ctx, step: number, margin: number): P[] {
  const cx = ctx.MW / 2
  const cy = ctx.MH / 2
  const out: P[] = []
  for (let x = cx - Math.floor((cx - margin) / step) * step; x < ctx.MW - margin; x += step)
    for (let y = cy - Math.floor((cy - margin) / step) * step; y < ctx.MH - margin; y += step) out.push([x, y])
  return out
}

const unitOf = (a: P, b: P): P => {
  const L = dist(a, b) || 1
  return [(a[0] - b[0]) / L, (a[1] - b[1]) / L]
}
