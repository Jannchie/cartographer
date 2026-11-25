import * as dmath from '../gen/dmath'
import { cityDice, hashAt, inCity, isFree, memo, type Ctx } from './ctx'
import { add, bboxOf, centroid, dist, rect, resample, segPolyDist, sub, unit, LineIndex, type P, type Poly } from './geom'
import { roadsNear } from './roads'
import { isVillage } from './scale'
import { routeOnTerrain } from './terrain'
import { tierLog } from './tiers'
import type { Building, BuildingKind, Tri } from './types'
import { drop } from './undo'
import { smoothRoute } from './walls'
import { cultureOf } from './culture'

/**
 * 名所：按地形才有的"招牌"布置，城边、城外挑合适的地方盖，放在片区、地标、城外设施都盖好以后。
 * 有哪些名所由文明定（CultureDef.sacred，盖法在各文明的文化包里），内置的有：
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
  const V = cityDice(ctx, 'sacred')
  const town = !isVillage(ctx.p.size)
  const big = ctx.p.size === 'city'
  // 城越大、越"神圣"（奇幻城、都城），名所越多
  const k = (big ? 1 : town ? 0.8 : 0.35) * (ctx.p.function === 'magic' || ctx.p.capital ? 1.25 : 1)
  // 名所难得一见：越有名的越少，常见些的多一点。有哪些、各有多大可能由文明定
  const tries = cultureOf(ctx.p.culture).sacred?.(ctx, k) ?? []
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

/** 名所的一个候选：[名字（抽签与统计用）, 这座城有它的概率, 盖法（盖成返回 true）] */
export type SacredTry = [id: string, chance: number, build: () => boolean]

// —————————————————————— 共用：选址、上山的路、落地 ——————————————————————

export const keyOf = (q: P) => `${Math.round(q[0])},${Math.round(q[1])}`

export const nameAt = (ctx: Ctx, kind: string, q: P): Tri => ctx.namer.sacred(kind, keyOf(q))

export const onMap = (ctx: Ctx, q: P, m = 60) => q[0] > m && q[1] > m && q[0] < ctx.MW - m && q[1] < ctx.MH - m

/** 城区边缘（城内片区中心）到 q 的距离 */
export function edgeDist(ctx: Ctx, q: P): number {
  // 名所都在城区长好以后才选址：城内片区的中心算一次就够
  const cores = memo(ctx, 'sacred.cores', () => ctx.out.wards.filter((w) => w.inner).map((w) => centroid(w.poly)))
  let d = Infinity
  for (const c of cores) d = Math.min(d, dist(c, q))
  return d - ctx.cfg.patch * 0.55
}

/** 高程梯度（指向上坡），单位向量；平地返回 null */
export function uphill(ctx: Ctx, q: P): P | null {
  const T = ctx.T
  const gx = T.heightAt([q[0] + 4, q[1]]) - T.heightAt([q[0] - 4, q[1]])
  const gy = T.heightAt([q[0], q[1] + 4]) - T.heightAt([q[0], q[1] - 4])
  const L = dmath.hypot(gx, gy)
  return L < 0.05 ? null : [gx / L, gy / L]
}

/** 一块地能不能用：不压水、路、墙与任何建筑（田与树可以清走） */
export const free = (ctx: Ctx, poly: Poly, pad = 1) => isFree(ctx, poly, { pad, water: 4 })

/** 折线沿途有没有压到建筑、水面（树与田不算） */
export function lineFree(ctx: Ctx, line: P[], hw: number, water = 1.5): boolean {
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
export function clearTrees(ctx: Ctx, line: P[], r: number) {
  const idx = new LineIndex(line, r + ctx.out.trees.reduce((m, t) => Math.max(m, t.r), 0) * 0.5)
  drop(ctx, 'trees', (t) => idx.nearPoint(t.p, r + t.r * 0.5))
}

/** 地面沿坡寻路（避开房子、少过水），磨圆 */
export function route(ctx: Ctx, from: P, to: P, slope: number): P[] {
  const bias = (q: P) => (ctx.occ.hitsPoint(q, 4.5) ? 40 : ctx.corridors.hits(q, 0, ['road']) ? 0.7 : 1)
  const raw = routeOnTerrain(ctx.T, from, to, { water: 30, slope, bias })
  return raw.length > 1 ? smoothRoute(raw, 3, ctx.T) : []
}

/**
 * 从附近的路修一条上山的路（石阶或小径）到 to：沿途不压房子与水，修好登记走廊、清走两旁的树。
 * 最近的几条路依次试；都接不上（太远、压房子）返回 null。
 */
export function approach(ctx: Ctx, to: P, kind: 'stair' | 'path', w: number, within = 450): P[] | null {
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
export function trimStart(ctx: Ctx, line: P[]): P[] {
  const pts = resample(line, 1.5)
  let k = 0
  while (k < pts.length - 2 && ctx.corridors.hits(pts[k], 0.3, ['road'])) k++
  return pts.slice(Math.max(0, k - 1))
}

export function commit(ctx: Ctx, line: P[], kind: 'stair' | 'path', w: number): P[] {
  ctx.out.roads.push({ line, width: w, kind })
  ctx.corridors.add(line, w / 2 + 0.6)
  clearTrees(ctx, line, w / 2 + 0.6)
  return line
}

/** 在水里（码头、鸟居、架在水上的殿）放一栋：不碰路、墙与别的实体 */
export function placeWet(ctx: Ctx, poly: Poly, kind: BuildingKind, extra?: Partial<Building>): boolean {
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
export function hilltops(ctx: Ctx, o: { d0: number; d1: number; rise: number; size: number; tag: string }): P[] {
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
export function landmark(ctx: Ctx, p: P, n: Tri, kind: 'shrine' | 'temple' | 'castle' = 'shrine', major = true, lift = 0) {
  ctx.out.landmarks.push({ p: [p[0], p[1] - lift], name: n, kind, major })
}

/** 以地图中心（世界原点）对齐的格点：地图随人口变大时，同一处的格点不变 */
export function gridPts(ctx: Ctx, step: number, margin: number): P[] {
  const cx = ctx.MW / 2
  const cy = ctx.MH / 2
  const out: P[] = []
  for (let x = cx - Math.floor((cx - margin) / step) * step; x < ctx.MW - margin; x += step)
    for (let y = cy - Math.floor((cy - margin) / step) * step; y < ctx.MH - margin; y += step) out.push([x, y])
  return out
}

export const unitOf = (a: P, b: P): P => unit(sub(a, b))
