/**
 * 西式的小品：墓地里的墓、大船。纯函数，在 Worker 中运行。
 */
import { MAT, mixRGB, shade, type V3 } from '../../../../render/town3d/mesh'
import { GRANITE, GRAVE_EARTH, hex } from '../../../../render/town3d/shared'
import type { WCtx } from '../../../../render/town3d/works'
import { beam, box, hash, l3, lp, tube, type Ax } from '../../../../render/town3d/worksMesh'
import { CANVAS, hull, mast, rope, squareSail, type ShipEnv } from '../../../../render/town3d/harbor'

/** 墓：立碑（多数）或石十字，碑前一方略高的墓床 */
export function gravePlot(c: WCtx, f: Ax, g: number, len: number, wid: number) {
  const { w } = c
  const h1 = hash(f.o[0], f.o[1], 1)
  const h2 = hash(f.o[0], f.o[1], 2)
  const lo = g - 0.4
  w.c = mixRGB(hex('#6f7a4c'), GRAVE_EARTH, 0.35)
  w.face = MAT.straw
  box(w, f, -len * 0.3, len * 0.42, -wid * 0.36, wid * 0.36, lo, g + 0.1, { inset: 0.08 })
  w.c = shade(mixRGB(GRANITE, hex('#b9b5a6'), h2), 0.85 + h1 * 0.2)
  w.face = MAT.plain
  const s = -len * 0.4
  // 歪一点：年久的碑并不都直
  const lean = (h1 - 0.5) * 0.08
  if (h2 < 0.24) {
    beam(w, l3(f, s, 0, lo), l3(f, s + lean, 0, g + 1.15), 0.07, 0.07)
    beam(w, l3(f, s + lean * 0.7, -0.26, g + 0.82), l3(f, s + lean * 0.7, 0.26, g + 0.82), 0.07, 0.07)
  } else {
    const hh = 0.62 + h1 * 0.4
    box(w, f, s - 0.06, s + 0.06, -0.26, 0.26, lo, g + hh, { top: h2 >= 0.7 })
    // 碑头：尖的或平的
    if (h2 < 0.7) {
      w.triOut(l3(f, s - 0.06, -0.26, g + hh), l3(f, s - 0.06, 0.26, g + hh), l3(f, s - 0.06, 0, g + hh + 0.2), [-f.u[0], 0, -f.u[1]])
      w.triOut(l3(f, s + 0.06, -0.26, g + hh), l3(f, s + 0.06, 0.26, g + hh), l3(f, s + 0.06, 0, g + hh + 0.2), [f.u[0], 0, f.u[1]])
      for (const t of [-1, 1]) w.quadOut(l3(f, s - 0.06, t * 0.26, g + hh), l3(f, s + 0.06, t * 0.26, g + hh), l3(f, s + 0.06, 0, g + hh + 0.2), l3(f, s - 0.06, 0, g + hh + 0.2), [f.v[0] * t, 1, f.v[1] * t])
    }
  }
}

/** 大船：柯克船（大的带首尾楼），小些的是单桅渔船 */
export function ship(c: WCtx, e: ShipEnv) {
  const { w } = c
  const { f, L, hs, hs2, col, deckCol, big, set } = e
  const h = hull(c, f, { L, beam: L * 0.3, fb: Math.min(1.9, L * 0.1), draft: 0.6, bow: L * 0.075, stern: L * 0.08, sternW: 0.5, bowP: 2.3, well: 0.5, col, deck: deckCol })
  if (big) {
    // 艉楼与艏楼：高出舷缘的平台，四周一圈木栏
    for (const [u0, u1] of [[0.04, 0.27], [0.83, 0.95]]) {
      const um = (u0 + u1) / 2
      const cb = Math.max(0.5, h.halfBeam(um) + 0.1)
      const y = h.sheer(um) + 0.75
      const cf = { o: lp(f, (um - 0.5) * L, 0), u: f.u, v: f.v }
      const hl = ((u1 - u0) * L) / 2
      w.c = shade(col, 1.25)
      w.face = MAT.board
      box(w, cf, -hl, hl, -cb, cb, h.deckY(um) + 0.02, y, { topFace: MAT.plank, topCol: deckCol })
      for (const sg of [-1, 1]) {
        box(w, cf, -hl, hl, sg * cb - (sg > 0 ? 0.08 : 0), sg * cb + (sg > 0 ? 0 : 0.08), y, y + 0.7)
        box(w, cf, sg * hl - (sg > 0 ? 0.08 : 0), sg * hl + (sg > 0 ? 0 : 0.08), -cb, cb, y, y + 0.7)
      }
    }
  }
  const u = 0.53
  const foot = h.at(u, 0, h.deckY(u))
  const mh = L * (big ? 0.82 : 0.7)
  const top: V3 = [foot[0], foot[1] + mh, foot[2]]
  mast(c, foot, top, L * 0.013 + 0.07)
  squareSail(c, f, [foot[0], foot[1] + mh * 0.86, foot[2]], L * 0.27, mh * 0.6, set, shade(CANVAS, 0.92 + hs2 * 0.12), hs < 0.3 ? L * 0.04 : 0)
  if (big) {
    // 桅顶的瞭望斗
    w.c = shade(col, 1.2)
    w.face = MAT.board
    tube(w, [foot[0], foot[2]], 0.38, 0.5, foot[1] + mh * 0.9, foot[1] + mh * 0.9 + 0.55, 8, { cap: true })
  }
  rope(c, top, h.at(0.99, 0, h.sheer(0.99)))
  rope(c, top, h.at(0.02, 0, h.sheer(0.02)))
  for (const sg of [-1, 1]) rope(c, [top[0], top[1] - mh * 0.12, top[2]], h.at(u - 0.06, sg * (h.halfBeam(u) - 0.05), h.sheer(u)))
}
