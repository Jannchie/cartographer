/**
 * 伊斯兰的城防：土坯城墙的形制、方塔、马蹄拱的城门。纯函数，在 Worker 中运行。
 */
import { MAT, mixRGB, shade } from '../../../../render/town3d/mesh'
import { ADOBE, hex } from '../../../../render/town3d/shared'
import { archBlock, leaves } from '../../../../render/town3d/gates'
import { bastion, battlement, outRing, salient } from '../../../../render/town3d/works'
import { archRing, box, lp } from '../../../../render/town3d/worksMesh'
import type { WallKit } from '../../../../render/town3d/kits'
import type { P } from '../../../../settlement/geom'

export const wall: WallKit = {
  stone: (k, s) => ({ hgt: 9.5 * k, col: ADOBE, face: MAT.plaster, batter: 0.5, parapet: 0.8, merlon: 0.85, mLen: 0.95, mGap: 0.7, mCap: 'point', inner: 0.75, pave: shade(ADOBE, 0.88), gateHalf: 6.6 * s, arch: 'pointed' }),
  roofFace: MAT.tileEast,
  /** 方塔：向城外凸出的方台，高出墙顶 */
  tower(c, look, f, R, _roofed, g, lo) {
    const hs = R * 0.85
    const ht = R * 0.85
    salient(c, look, f, hs, ht, lo, g + look.hgt + 2.6 * look.s, 0.45)
  },
  /** 城门：凸出的门楼，马蹄拱门洞套在方框（阿尔菲兹）里，两侧方塔 */
  gate(c, look, f, g, yb) {
    const { w } = c
    const { s, hgt, half } = look
    const hwB = 5.2 * s
    const hd = half + 2.6 * s
    const top = g + hgt + 3.2 * s
    const phw = 2.3 * s
    const spring = 3.2 * s
    const fo = { o: lp(f, 1.2 * s, 0), u: f.u, v: f.v }
    const hole = archBlock(c, fo, hwB, hd, yb, top, 'horseshoe', phw, g, spring, { topCol: look.pave })
    const light = mixRGB(look.col, hex('#efe6d0'), 0.75)
    const tile = hex('#3d7f86')
    for (const sg of [1, -1]) {
      const o = lp(fo, sg * hd, 0)
      const out: P = [f.u[0] * sg, f.u[1] * sg]
      // 拱圈
      w.c = light
      w.face = MAT.plain
      archRing(w, o, f.v, out, hole, 0.5, 0.07)
      // 方框（阿尔菲兹）：拱外一圈釉砖的边
      w.c = tile
      const fw = phw * 1.16 + 1.0
      const ft = g + spring + phw * 2.2 + 0.9
      const fr = { o, u: out, v: f.v }
      box(w, fr, 0, 0.09, -fw - 0.3, -fw, g + 0.2, ft, { bottom: true })
      box(w, fr, 0, 0.09, fw, fw + 0.3, g + 0.2, ft, { bottom: true })
      box(w, fr, 0, 0.09, -fw - 0.3, fw + 0.3, ft, ft + 0.3, { bottom: true })
    }
    w.c = look.col
    w.face = look.face
    battlement(c, outRing(fo, hd, hwB), top, look)
    for (const sg of [-1, 1]) {
      const tf = { o: lp(fo, hd - 1.3 * s, sg * (hwB + 1.3 * s)), u: f.u, v: f.v }
      w.at(tf.o[0], tf.o[1])
      bastion(c, tf, 2.6 * s, 2.6 * s, yb, top + 1.8 * s, look, 0.4)
    }
    w.at(f.o[0], f.o[1])
    leaves(c, fo, hd * 0.2, phw, phw * 0.98, g + 0.06, spring - 0.1, hex('#5a4630'), true)
  },
}
