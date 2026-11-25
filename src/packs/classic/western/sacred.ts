import * as dmath from '../../../gen/dmath'
import { clear } from '../../../settlement/civic'
import { westCastle } from '../../../settlement/compose/castle'
import { westChurch } from '../../../settlement/compose/church'
import { hashAt, type Ctx } from '../../../settlement/ctx'
import { add, circlePoly, insetConvex, pointAt, polylineLength, growConvex, rect, sub, unit, type P } from '../../../settlement/geom'
import { approach, free, hilltops, keyOf, landmark, nameAt, type SacredTry } from '../../../settlement/sacred'
import { levelTerrain } from '../../../settlement/terrain'
import { checkpoint, rollback } from '../../../settlement/undo'
import { gateStreets, WALL_CLEAR, wallCorridor } from '../../../settlement/walls'
import { place } from '../../../settlement/wards'

/**
 * 西式的名所：山上的修道院（围墙里的教堂、回廊、菜园鱼塘）、朝圣教堂（山顶的小教堂，一路上去是苦路十四处）、
 * 岩上的城堡。
 */

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
    landmark(ctx, top, nameAt(ctx, 'crag', top), 'castle')
    return true
  }
  return false
}

/** 名所的候选：[名字, 概率, 盖法]，k 是随规模、功效的倍率 */
export const sacred = (ctx: Ctx, k: number): SacredTry[] => [
  ['abbey', 0.2 * k, () => abbey(ctx)],
  ['pilgrim', 0.15 * k, () => calvary(ctx)],
  ['crag', (ctx.p.function === 'fortress' ? 0.45 : 0.15) * k, () => cragCastle(ctx)],
]
