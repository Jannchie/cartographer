import * as dmath from '../../../gen/dmath'
import { clear } from '../../../settlement/civic'
import { eastCompound } from '../../../settlement/compose/chinese'
import { emitArea, type Ctx } from '../../../settlement/ctx'
import { add, circlePoly, rect, type P } from '../../../settlement/geom'
import { approach, free, hilltops, landmark, nameAt, type SacredTry } from '../../../settlement/sacred'
import { levelTerrain } from '../../../settlement/terrain'
import { checkpoint, rollback } from '../../../settlement/undo'
import { place, plantTree, scatterTrees } from '../../../settlement/wards'

/**
 * 东方的名所：山寺（山坡上的寺，石阶上山）、山头的塔。和风也有这两样，借用这里的盖法（塔换成方的五重塔）。
 */

/** 山寺：山坡上（或山头）的一座寺院，石阶从山下的路上去 */
export function yamadera(ctx: Ctx): boolean {
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
    landmark(ctx, top, nameAt(ctx, 'yamadera', top), 'temple', true, 52)
    return true
  }
  return false
}

/** 山头的塔（文峰塔、五重塔）：小小的台地上一座塔、一座小殿，小径上去 */
export function hillPagoda(ctx: Ctx, form: { square: boolean; role: string } = { square: false, role: '塔' }): boolean {
  const tops = hilltops(ctx, { d0: 40, d1: 700, rise: 10, size: 30, tag: 'sacred.hillPagoda' })
  for (const top of tops) {
    const pad = circlePoly(top, 13, 16)
    if (!free(ctx, pad, 1)) continue
    const cp = checkpoint(ctx)
    clear(ctx, circlePoly(top, 16, 16))
    emitArea(ctx, 'plazas', pad)
    // 塔：八角的砖塔，或方的木塔（五重塔）
    const tower = place(ctx, form.square ? rect(top, [1, 0], 8, 8) : circlePoly(top, 4.6, 8, Math.PI / 8), 'pagoda', { pad: 0.1 }, { role: form.role })
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
    landmark(ctx, top, nameAt(ctx, 'pagoda', top), 'temple', true, 16)
    return true
  }
  return false
}

/** 名所的候选：[名字, 概率, 盖法]，k 是随规模、功效的倍率 */
export const sacred = (ctx: Ctx, k: number): SacredTry[] => [
  ['yamadera', 0.25 * k, () => yamadera(ctx)],
  ['pagoda', 0.2 * k, () => hillPagoda(ctx)],
]
