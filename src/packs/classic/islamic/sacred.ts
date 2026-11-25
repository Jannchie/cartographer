import { clear } from '../../../settlement/civic'
import { emitArea, hashAt, type Ctx } from '../../../settlement/ctx'
import { growConvex, rect, type P } from '../../../settlement/geom'
import { approach, free, hilltops, landmark, nameAt, type SacredTry } from '../../../settlement/sacred'
import type { Wall } from '../../../settlement/types'
import { checkpoint, rollback } from '../../../settlement/undo'
import { addWall } from '../../../settlement/walls'
import { place } from '../../../settlement/wards'
import { placeMosque } from './medina'

/**
 * 伊斯兰的名所：山头的里巴特（四角碉楼的方堡，里面一座小清真寺）。
 */

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
    landmark(ctx, top, nameAt(ctx, ctx.p.function === 'fortress' || hashAt(ctx, top, 'sacred.ribat.kind') < 0.5 ? 'ribat' : 'crag', top), 'castle')
    return true
  }
  return false
}

/** 名所的候选：[名字, 概率, 盖法]，k 是随规模、功效的倍率 */
export const sacred = (ctx: Ctx, k: number): SacredTry[] => [['ribat', (ctx.p.function === 'fortress' ? 0.45 : 0.18) * k, () => ribat(ctx)]]
