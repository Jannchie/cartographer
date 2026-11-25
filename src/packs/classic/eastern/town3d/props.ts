/**
 * 东方的小品：墓、石碑、大船。纯函数，在 Worker 中运行。
 */
import type { Site } from '../../../../render/town3d/kit'
import { lathe, MAT, mixRGB, prism, rectOf, shade, type V3 } from '../../../../render/town3d/mesh'
import { GRANITE, GRAVE_EARTH, hex, STONE, STONE_EAST, type Ctx } from '../../../../render/town3d/shared'
import type { WCtx } from '../../../../render/town3d/works'
import { ball, beam, box, cbox, hash, l3, loft, lp, type Ax } from '../../../../render/town3d/worksMesh'
import { battenSail, hull, mast, type ShipEnv } from '../../../../render/town3d/harbor'

/** 墓地里按"小棚"给出的墓：土冢与碑 */
export function graveMarker(c: Ctx, s: Site) {
  const { w } = c
  const { f, g1, base } = s
  // 土冢与碑
  w.c = hex('#7d8a5c')
  w.face = MAT.plain
  lathe(w, f.c, g1 - 0.1, [[Math.min(f.a, f.b) * 0.95, 0], [Math.min(f.a, f.b) * 0.7, 0.35], [0, 0.6]], 8)
  w.c = STONE
  w.face = MAT.stone
  prism(w, rectOf({ ...f, c: [f.c[0] + f.u[0] * f.a * 0.9, f.c[1] + f.u[1] * f.a * 0.9], a: 0.08, b: 0.22 }), base, g1 + 0.8)
}

/** 墓：覆草的坟丘，丘前一方石碑 */
export function gravePlot(c: WCtx, f: Ax, g: number, len: number, wid: number) {
  const { w } = c
  const [x, z] = f.o
  const h1 = hash(x, z, 1)
  const h2 = hash(x, z, 2)
  const lo = g - 0.4
  // 坟丘：覆草的土丘，丘前一方石碑
  w.c = mixRGB(hex('#77824f'), GRAVE_EARTH, h1 * 0.6)
  w.face = MAT.straw
  ball(w, [x, g - 0.05, z], Math.min(wid, len) * 0.52, 6, 2, 0, Math.PI / 2, 0.75)
  w.c = shade(GRANITE, 0.9 + h2 * 0.2)
  w.face = MAT.plain
  box(w, f, len * 0.36, len * 0.36 + 0.14, -0.22, 0.22, lo, g + 0.62 + h1 * 0.2)
}

/** 石碑：龟趺座、碑身与碑首 */
export function stele(c: WCtx, f: Ax, g: number) {
  const { w } = c
  w.c = shade(STONE_EAST, 1.05)
  w.face = MAT.stone
  cbox(w, f, 0.6, 0.95, g - 0.4, g + 0.5, { inset: 0.1 })
  w.c = hex('#55585a')
  w.face = MAT.plain
  cbox(w, f, 0.13, 0.52, g + 0.5, g + 2.5)
  w.c = shade(STONE_EAST, 1.1)
  cbox(w, f, 0.17, 0.6, g + 2.5, g + 3.0, { inset: 0.06 })
}

/** 大船：沙船 */
export function ship(c: WCtx, e: ShipEnv) {
  const { w } = c
  const { f, L, hs, hs2, col, deckCol, big, set } = e
  // 沙船：平头方艉、艉楼高起，硬篷帆
  const h = hull(c, f, { L, beam: L * 0.27, fb: Math.min(1.7, L * 0.085), draft: 0.5, bow: L * 0.055, stern: L * 0.12, sternW: 0.78, bowP: 4.5, well: 0.45, col, deck: deckCol })
  // 舷侧一道赭红的腰线
  // 艉楼：舱房与弧形的篷顶
  const cu = 0.18
  const cb = h.halfBeam(cu) - 0.25
  const cy = h.deckY(cu)
  const cf = { o: lp(f, (cu - 0.5) * L, 0), u: f.u, v: f.v }
  w.c = hex('#7a4a34')
  w.face = MAT.board
  box(w, cf, -L * 0.1, L * 0.1, -cb, cb, cy, cy + 1.5, { top: false })
  w.c = hex('#8c8468')
  w.face = MAT.straw
  const rows: V3[][] = []
  for (const s of [-L * 0.11, L * 0.11]) {
    const row: V3[] = []
    for (let k = 0; k <= 4; k++) row.push(l3(cf, s, -cb - 0.12 + ((cb * 2 + 0.24) * k) / 4, cy + 1.5 + Math.sin((Math.PI * k) / 4) * 0.35))
    rows.push(row)
  }
  loft(w, rows, l3(cf, 0, 0, cy), { double: true })
  w.c = hex('#7a4a34')
  w.face = MAT.board
  for (const s of [-L * 0.1, L * 0.1]) w.triOut(l3(cf, s, -cb, cy + 1.5), l3(cf, s, cb, cy + 1.5), l3(cf, s, 0, cy + 1.85), [f.u[0] * s, 0, f.u[1] * s])
  const sailCol = shade(hex('#8a4f36'), 0.9 + hs2 * 0.25)
  const masts: [number, number, number][] = big ? [[0.5, L * 0.78, L * 0.36], [0.76, L * 0.55, L * 0.26]] : [[0.52, L * 0.72, L * 0.34]]
  for (const [u, mh, sw] of masts) {
    const foot = h.at(u, 0, h.deckY(u))
    const top: V3 = [foot[0], foot[1] + mh, foot[2]]
    mast(c, foot, top, L * 0.012 + 0.06)
    if (set) battenSail(c, f, foot, foot[1] + mh * 0.2, foot[1] + mh * 0.97, sw, (hs - 0.5) * 0.9, sailCol)
    else {
      // 落帆：帆与帆竹叠在桅脚的帆架上
      w.c = sailCol
      w.face = MAT.cloth
      const a = h.at(u - 0.02 - (sw * 0.75) / L, 0.1, foot[1] + 1.25)
      const e = h.at(u + (sw * 0.25) / L, 0.1, foot[1] + 1.4)
      beam(w, a, e, 0.16, 0.22)
    }
  }
}
