/**
 * 西式的城防：石墙的形制、圆塔与城门。纯函数，在 Worker 中运行。
 */
import { MAT, shade } from '../../../../render/town3d/mesh'
import { hex, STONE } from '../../../../render/town3d/shared'
import { archBlock, leaves, portcullis } from '../../../../render/town3d/gates'
import { battlement, drum, outRing } from '../../../../render/town3d/works'
import { archRing, box, lp } from '../../../../render/town3d/worksMesh'
import type { WallKit } from '../../../../render/town3d/kits'

export const wall: WallKit = {
  stone: (k, s) => ({ hgt: 9 * k, col: STONE, face: MAT.stone, batter: 0.35, parapet: 1.0, merlon: 0.9, mLen: 1.35, mGap: 0.9, inner: 0.9, pave: shade(STONE, 0.9), gateHalf: 5.9 * s, arch: 'round' }),
  roofFace: MAT.slate,
  /** 圆塔：有的带圆锥顶，有的是露天的垛台 */
  tower(c, look, f, R, roofed, g, lo) {
    drum(c, f.o, R, lo, g, g + look.hgt + 3.4 * look.s, roofed, look)
  },
  /** 城门：两座圆塔夹着门楼，尖拱门道贯通，吊闸半悬，门扇朝里开 */
  gate(c, look, f, g, yb) {
    const { w } = c
    const { s, hgt, half } = look
    const hwB = 4.7 * s
    const hd = Math.max(half + 1.3, 3.8 * s)
    const top = g + hgt + 2.8 * s
    const phw = 2.6 * s
    const spring = 3.0 * s
    const hole = archBlock(c, f, hwB, hd, yb, top, 'pointed', phw, g, spring, { topCol: look.pave })
    // 拱圈：门洞内外口各一圈浅色的券石
    w.c = shade(look.col, 1.12)
    w.face = MAT.plain
    for (const sg of [1, -1]) archRing(w, lp(f, sg * hd, 0), f.v, [f.u[0] * sg, f.u[1] * sg], hole, 0.42, 0.1)
    w.c = look.col
    w.face = look.face
    // 门楼顶的女墙与垛；外口上方一道挑出的线脚
    battlement(c, outRing(f, hd, hwB), top, look)
    w.c = shade(look.col, 0.88)
    box(w, f, hd, hd + 0.14, -hwB, hwB, top - 0.5, top - 0.2, { bottom: true })
    // 外口上方的徽板
    w.c = shade(look.col, 1.15)
    w.face = MAT.plain
    box(w, f, hd, hd + 0.08, -0.55 * s, 0.55 * s, g + spring + phw * 1.22 + 0.9 * s, g + spring + phw * 1.22 + 2.3 * s, { bottom: true })
    // 两座圆塔
    const tr = 3.25 * s
    for (const sg of [-1, 1]) {
      const ct = lp(f, hd * 0.42, sg * (hwB + 1.25 * s))
      w.at(ct[0], ct[1])
      drum(c, ct, tr, yb, g, top + 2.2 * s, true, look)
    }
    w.at(f.o[0], f.o[1])
    const apex = g + spring + phw * 1.2
    portcullis(c, f, hd - 0.55, phw, g + spring * 0.95, apex + 0.3)
    leaves(c, f, hd * 0.25, phw, phw * 0.98, g + 0.06, spring - 0.1, hex('#4b3a2a'))
  },
}
