/**
 * 和式的小品：墓、石灯笼、大船。纯函数，在 Worker 中运行。
 */
import type { Site } from '../../../../render/town3d/kit'
import { MAT, prism, rectOf, shade } from '../../../../render/town3d/mesh'
import { GRANITE, hex, STONE, TIMBER, type Ctx } from '../../../../render/town3d/shared'
import type { WCtx } from '../../../../render/town3d/works'
import { ball, beam, box, cbox, hash, lp, ringUnder, tube, type Ax } from '../../../../render/town3d/worksMesh'
import { hull, mast, rope, squareSail, type ShipEnv } from '../../../../render/town3d/harbor'

/** 墓地里按"小棚"给出的墓：台座上一根方柱的墓石 */
export function graveMarker(c: Ctx, s: Site) {
  const { w } = c
  const { f, g1, base, t2 } = s
  // 墓石：台座上一根方柱
  w.c = shade(STONE, 0.9 + t2 * 0.2)
  const sq = { ...f, a: 0.3, b: 0.3 }
  prism(w, rectOf(sq), base, g1 + 0.25)
  prism(w, rectOf({ ...f, a: 0.14, b: 0.14 }), g1 + 0.25, g1 + 0.95 + t2 * 0.3)
}

/** 墓：台石上立一根方柱的墓石 */
export function gravePlot(c: WCtx, f: Ax, g: number, _len: number, _wid: number) {
  const { w } = c
  const h1 = hash(f.o[0], f.o[1], 1)
  const h2 = hash(f.o[0], f.o[1], 2)
  const lo = g - 0.4
  // 墓石：台石上立一根方柱
  w.c = shade(GRANITE, 0.82 + h2 * 0.22)
  cbox(w, f, 0.34, 0.34, lo, g + 0.2)
  cbox(w, f, 0.24, 0.24, g + 0.2, g + 0.36)
  cbox(w, f, 0.14, 0.14, g + 0.36, g + 1.05 + h1 * 0.25, { inset: 0.012 })
}

/** 石灯笼：基座、竿、中台、火袋（夜里亮）、笠与宝珠 */
export function lantern(c: WCtx, f: Ax, g: number) {
  const { w } = c
  const p = f.o
  w.c = shade(GRANITE, 0.9)
  tube(w, p, 0.42, 0.34, g - 0.3, g + 0.22, 6)
  tube(w, p, 0.15, 0.13, g + 0.22, g + 1.15, 6)
  tube(w, p, 0.14, 0.36, g + 1.15, g + 1.3, 6, { cap: true })
  w.c = hex('#e8d9a0')
  w.face = MAT.lamp
  cbox(w, f, 0.2, 0.2, g + 1.3, g + 1.68, { top: false })
  w.c = shade(GRANITE, 0.9)
  w.face = MAT.plain
  for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const q = lp(f, s * 0.2, t * 0.2)
    beam(w, [q[0], g + 1.3, q[1]], [q[0], g + 1.68, q[1]], 0.035, 0.035, false)
  }
  ringUnder(w, p, 0.1, 0.5, g + 1.68, 6)
  tube(w, p, 0.5, 0.1, g + 1.68, g + 1.95, 6)
  ball(w, [p[0], g + 2.02, p[1]], 0.09, 6, 2, -Math.PI / 2, Math.PI / 2)
}

/** 大船：和船（弁才船） */
export function ship(c: WCtx, e: ShipEnv) {
  const { w } = c
  const { f, L, col, deckCol, set } = e
  // 和船（弁才船）：艏柱高挑，单桅大方帆，艉部低矮的舱屋
  const h = hull(c, f, { L, beam: L * 0.3, fb: Math.min(1.5, L * 0.08), draft: 0.5, bow: L * 0.13, stern: L * 0.09, sternW: 0.7, bowP: 1.9, well: 0.4, col, deck: deckCol })
  const cu = 0.2
  const cb = h.halfBeam(cu) - 0.2
  const cy = h.deckY(cu)
  const cf = { o: lp(f, (cu - 0.5) * L, 0), u: f.u, v: f.v }
  w.c = shade(TIMBER, 1.2)
  w.face = MAT.board
  box(w, cf, -L * 0.09, L * 0.09, -cb, cb, cy, cy + 1.1, { topFace: MAT.plank, topCol: shade(TIMBER, 1.4) })
  const u = 0.47
  const foot = h.at(u, 0, h.deckY(u))
  const mh = L * 0.8
  mast(c, foot, [foot[0], foot[1] + mh, foot[2]], L * 0.013 + 0.07)
  squareSail(c, f, [foot[0], foot[1] + (set ? mh * 0.93 : 1.6), foot[2]], L * 0.27, mh * 0.66, set, hex('#e6dfcc'), L * 0.045)
  rope(c, [foot[0], foot[1] + mh, foot[2]], h.at(0.98, 0, h.sheer(0.98)))
  rope(c, [foot[0], foot[1] + mh, foot[2]], h.at(0.03, 0, h.sheer(0.03)))
}
