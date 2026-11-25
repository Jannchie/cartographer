/**
 * 伊斯兰的小品：墓地里的墓、大船。纯函数，在 Worker 中运行。
 */
import { MAT, shade } from '../../../../render/town3d/mesh'
import { hex } from '../../../../render/town3d/shared'
import type { WCtx } from '../../../../render/town3d/works'
import { box, hash, lp, type Ax } from '../../../../render/town3d/worksMesh'
import { hull, lateen, mast, rope, type ShipEnv } from '../../../../render/town3d/harbor'

/** 墓：一方低矮的白石棺台，头脚各立一块碑石 */
export function gravePlot(c: WCtx, f: Ax, g: number, len: number, wid: number) {
  const { w } = c
  const h1 = hash(f.o[0], f.o[1], 1)
  const h2 = hash(f.o[0], f.o[1], 2)
  const lo = g - 0.4
  // 卧碑：一方低矮的白石棺台，头脚各立一块碑石
  w.c = shade(hex('#dcd6c6'), 0.9 + h2 * 0.14)
  box(w, f, -len * 0.42, len * 0.42, -wid * 0.3, wid * 0.3, lo, g + 0.26, { inset: 0.04 })
  for (const s of [-1, 1]) box(w, f, s * len * 0.4 - 0.05, s * len * 0.4 + 0.05, -0.13, 0.13, g + 0.2, g + (s > 0 ? 0.82 : 0.55) + h1 * 0.15, { inset: 0.02 })
}

/** 大船：三角帆船 */
export function ship(c: WCtx, e: ShipEnv) {
  const { w } = c
  const { f, L, col, deckCol, big, set } = e
  // 三角帆船：艏柱前倾，斜桁三角帆
  const h = hull(c, f, { L, beam: L * 0.27, fb: Math.min(1.5, L * 0.08), draft: 0.55, bow: L * 0.12, stern: L * 0.1, sternW: 0.5, bowP: 1.6, well: 0.45, col, deck: deckCol })
  const u = 0.56
  const foot = h.at(u, 0, h.deckY(u))
  const mh = L * 0.62
  const top = h.at(u + 0.07, 0, foot[1] + mh)
  mast(c, foot, top, L * 0.012 + 0.06)
  const low = h.at(0.98, 0.25, h.sheer(0.98) + 0.5)
  const high = h.at(0.2, 0.25, foot[1] + mh * 1.32)
  lateen(c, f, low, high, h.at(0.12, 0.6, h.sheer(0.12) + 0.5), set)
  if (big) {
    // 艉甲板：高出一截的艉楼
    const cb = h.halfBeam(0.12) - 0.15
    box(w, { o: lp(f, -0.38 * L, 0), u: f.u, v: f.v }, -L * 0.1, L * 0.1, -cb, cb, h.deckY(0.12), h.sheer(0.12) + 0.05, { topFace: MAT.plank, topCol: deckCol })
  }
  rope(c, top, h.at(0.05, 0, h.sheer(0.05)))
}
