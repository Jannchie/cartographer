import * as dmath from '../../../gen/dmath'
import { clear } from '../../../settlement/civic'
import { emitArea, hashAt, inCity, type Ctx } from '../../../settlement/ctx'
import { add, at, box, centroid, dist, frameAt, insetConvex, pointAt, pointInPoly, polylineDist, polylineLength, rect, resample, segDist, type P, type Poly } from '../../../settlement/geom'
import { nearestRoad } from '../../../settlement/roads'
import { approach, clearTrees, commit, edgeDist, free, gridPts, hilltops, keyOf, landmark, lineFree, nameAt, onMap, placeWet, route, type SacredTry, unitOf, uphill } from '../../../settlement/sacred'
import { checkpoint, drop, rollback } from '../../../settlement/undo'
import { place, scatterTrees } from '../../../settlement/wards'
import { shrines } from './style'
import { hillPagoda, yamadera } from '../eastern/sacred'

/**
 * 和风的名所：千本鸟居（山脚的稻荷社，一条朱红的鸟居隧道蜿蜒上坡到奥社）、海上鸟居（临海的社，拜殿架在水上，
 * 海里立一座大鸟居）、奥宫（山顶的小社，石阶从山下的神社一路上去）、神桥（社前过河的朱漆桥），
 * 以及与东方共有的山寺、山头的塔（五重塔）。越有名的越少见。
 */

/**
 * 一座小社：前沿中点 c，f 从鸟居往里；拜殿、本殿、鸟居、社地的院墙与林。s 是尺度（1 约 30 × 22 米）。
 * 放不下返回 null；返回社地与本殿背后的点。
 */
function miniShrine(ctx: Ctx, c: P, f: P, s: number, o: { torii?: number; role?: string; grove?: number } = {}): { precinct: Poly; back: P; hall: P } | null {
  const F = frameAt(c, f)
  const D = 30 * s
  const W = 22 * s
  const precinct = box(F, 0, D, -W / 2, W / 2)
  const haiden = box(F, D * 0.42, D * 0.42 + 7 * s, -4.5 * s, 4.5 * s)
  const honden = box(F, D * 0.7, D * 0.7 + 5.5 * s, -2.8 * s, 2.8 * s)
  if (!free(ctx, precinct, 0.5)) return null
  clear(ctx, precinct)
  place(ctx, haiden, 'hall', { pad: 0.2 })
  place(ctx, honden, 'temple', { pad: 0.2 }, o.role ? { role: o.role, part: 'honden' } : { part: 'honden' })
  const nt = o.torii ?? 1
  for (let k = 0; k < nt; k++) {
    const a = 2 + k * Math.min(6, (D * 0.3) / Math.max(1, nt))
    place(ctx, box(F, a, a + 0.8, -3.2 * Math.max(0.8, s), 3.2 * Math.max(0.8, s)), 'torii', { pad: 0.1 })
  }
  const walk = [at(F, -1.5, 0), at(F, D * 0.42, 0)]
  ctx.out.roads.push({ line: walk, width: 2.2, kind: 'path' })
  emitArea(ctx, 'plazas', box(F, D * 0.3, D * 0.95, -W * 0.3, W * 0.3))
  emitArea(ctx, 'enclosures', precinct)
  ctx.occ.add(box(F, D * 0.3, D * 0.95, -W * 0.3, W * 0.3))
  const t0 = ctx.out.trees.length
  scatterTrees(ctx, insetConvex(precinct, 1), o.grove ?? 0.012, 2.2, 4.2)
  drop(ctx, 'trees', (t) => segDist(t.p, walk[0], walk[1]).d <= 2.5, t0)
  return { precinct, back: at(F, D + 1.5, 0), hall: centroid(honden) }
}

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
    place(ctx, oku, 'temple', { pad: 0.2 }, { role: '奥社', part: 'honden' })
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
    landmark(ctx, sh.hall, nameAt(ctx, 'inari', sh.hall), 'shrine', true, 18)
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
    const F = frameAt(q, f)
    // 岸上：本殿与社地
    const land = box(F, 4, 36, -18, 18)
    if (!free(ctx, land, 0.5)) continue
    // 水上：平舞台与拜殿（伸出去 26 米），两翼的回廊
    const stage = box(F, -26, 3, -7, 7)
    const wings = [box(F, -14, 3, -24, -19), box(F, -14, 3, 19, 24), box(F, -17, -14, -24, 24)]
    const deck = [stage, ...wings]
    if (deck.some((p) => ctx.corridors.hitsPoly(p, 0.5, ['road', 'wall']) || ctx.occ.overlaps(p, 1))) continue
    if (!deck.every((p) => p.some((v) => T.waterAt(v) < 0))) continue
    // 大鸟居：海里离平舞台三四十米外，要整个在水里
    let torii: Poly | null = null
    for (const a of [-62, -72, -55, -85]) {
      const tq = box(F, a - 1.1, a + 1.1, -8, 8)
      if (tq.every((v) => T.waterAt(v) < -3 && T.seaAt(v)) && !ctx.occ.overlaps(tq, 2)) {
        torii = tq
        break
      }
    }
    if (!torii) continue
    const cp = checkpoint(ctx)
    clear(ctx, land)
    // 水上的殿先落地，再铺桩基上的平台（前面已查过不碰路、墙与别的东西；几块平台彼此相连）
    placeWet(ctx, box(F, -20, -12, -5, 5), 'hall', { role: '拜殿（水上）' })
    placeWet(ctx, box(F, -12, -4, -3.5, 3.5), 'hall', { role: '币殿（水上）' })
    for (const b of [-21.5, 21.5]) placeWet(ctx, box(F, -12, -4, b - 2, b + 2), 'hall', { role: '回廊（水上）' })
    for (const p of deck) ctx.out.piers.push(p)
    for (const p of deck) ctx.occ.add(p)
    const honden = box(F, 8, 17, -5, 5)
    place(ctx, honden, 'temple', { pad: 0.2 }, { role: '本殿', part: 'honden' })
    place(ctx, box(F, 20, 28, 7, 15), 'hall', { pad: 0.2 }, { role: '社务所' })
    placeWet(ctx, torii, 'torii', { role: '海上鸟居' })
    emitArea(ctx, 'enclosures', land)
    // 社后的林
    scatterTrees(ctx, box(F, 22, 40, -26, 26), 0.02, 2.4, 4.4)
    if (!approach(ctx, at(F, 37, 0), 'path', 2.6, 320)) {
      rollback(ctx, cp)
      continue
    }
    // 社名标在岸上一侧（水上的殿与平台留给图面）
    landmark(ctx, at(F, 46, 0), nameAt(ctx, 'umi', q))
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
    landmark(ctx, sh.hall, nameAt(ctx, 'okumiya', top), 'shrine', true, 14)
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
    ctx.out.landmarks.push({ p: add(A, f, dist(A, B) / 2), name: nameAt(ctx, 'shinkyo', q), kind: 'shrine', major: true })
    return true
  }
  return false
}

/** 名所的候选：[名字, 概率, 盖法]，k 是随规模、功效的倍率 */
export const sacred = (ctx: Ctx, k: number): SacredTry[] => [
  ['senbon', 0.15 * k, () => senbonTorii(ctx)],
  ['umi', 0.2 * k, () => umiTorii(ctx)],
  ['okumiya', 0.2 * k, () => okumiya(ctx)],
  ['shinkyo', 0.2 * k, () => shinkyo(ctx)],
  ['yamadera', 0.12 * k, () => yamadera(ctx)],
  ['pagoda', 0.1 * k, () => hillPagoda(ctx, { square: true, role: '五重塔' })],
]
