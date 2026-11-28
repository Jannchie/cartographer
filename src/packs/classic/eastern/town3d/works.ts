/**
 * 东方的城防：砖城墙的形制、马面与敌楼、城台上的城楼。纯函数，在 Worker 中运行。
 */
import { irimoya, MAT, mixRGB, shade } from '../../../../render/town3d/mesh'
import { hex, LACQUER, STONE_EAST, TILE_DARK } from '../../../../render/town3d/shared'
import { archBlock, leaves } from '../../../../render/town3d/gates'
import { battlement, outRing, salient, type WCtx, type WallLook } from '../../../../render/town3d/works'
import { archRing, box, hash, l3, lp, roofFrame, sweep, tube, type Station } from '../../../../render/town3d/worksMesh'
import type { WallKit } from '../../../../render/town3d/kits'

const BRICK_GREY = hex('#8f8f8a')
const DOOR_RED = hex('#7c2a1f')

/** 墙顶外沿一道挑出的砖檐 */
function trim(c: WCtx, look: WallLook, sts: Station[]) {
  const { w } = c
  const { half, hgt } = look
  w.c = shade(look.col, 0.86)
  sweep(w, sts, [[half + 0.12, hgt - 0.28], [half + 0.12, hgt], [half, hgt]], { faces: [MAT.brick, MAT.plain], caps: false })
  sweep(w, sts, [[half, hgt - 0.28], [half + 0.12, hgt - 0.28]], { faces: [MAT.plain], caps: false })
}

export const wall: WallKit = {
  stone: (k, s) => ({ hgt: 11 * k, col: BRICK_GREY, face: MAT.brick, batter: 1.0 * k, parapet: 0.9, merlon: 0.8, mLen: 1.5, mGap: 0.55, inner: 1.0, pave: shade(STONE_EAST, 0.95), gateHalf: 8.6 * s, arch: 'round', trim }),
  roofFace: MAT.tileEast,
  /** 马面：向城外凸出的方台，部分台上有敌楼 */
  tower(c, look, f, R, _roofed, g, lo) {
    const { w } = c
    const t = f.o
    const hs = R * 0.95
    const ht = R * 1.1
    const top = g + look.hgt + 0.02
    const ff = salient(c, look, f, hs, ht, lo, top, look.batter)
    // 敌楼：部分马面上有一座单层的小楼（硬山 / 歇山顶）
    if (hash(t[0], t[1], 5) < 0.5) {
      const a = ht * 0.62
      const b = hs * 0.55
      w.c = mixRGB(look.col, hex('#6f6a64'), 0.3)
      w.face = MAT.brick
      box(w, ff, -b, b, -a, a, top, top + 3.2, { top: false })
      w.roofFace = MAT.tileEast
      w.gableFace = MAT.brick
      w.roofTh = 0.28
      irimoya(w, roofFrame(ff, 0, 0, a, b), top + 3.2, 0.62, 0.9, TILE_DARK, LACQUER, 'curved')
    }
  },
  /** 城门：砖砌城台、券门，台上重檐歇山的城楼 */
  gate(c, look, f, g, yb) {
    const { w } = c
    const { s, hgt, half } = look
    // 城台：比城墙宽厚、略高，券门
    const hwB = look.gateHalf
    const hd = half + 3.6 * s
    const top = g + hgt + 0.9
    const phw = 2.6 * s
    const spring = 3.3 * s
    const hole = archBlock(c, f, hwB, hd, yb, top, 'round', phw, g, spring, { topCol: look.pave })
    // 券脸石：两口各一圈白石
    w.c = hex('#c9c6bd')
    w.face = MAT.plain
    for (const sg of [1, -1]) archRing(w, lp(f, sg * hd, 0), f.v, [f.u[0] * sg, f.u[1] * sg], hole, 0.5, 0.08)
    // 门额：外口券顶上一块匾
    w.c = hex('#2f3a55')
    box(w, f, hd, hd + 0.1, -1.5 * s, 1.5 * s, g + spring + phw + 1.0, g + spring + phw + 2.0, { bottom: true })
    w.c = look.col
    w.face = look.face
    battlement(c, outRing(f, hd, hwB), top, look)
    // 城楼：重檐歇山。下层殿身外一圈檐柱（副阶），下檐压在柱头上；上层收进、歇山顶
    const a1 = hwB * 0.6
    const b1 = hd * 0.5
    w.roofFace = MAT.tileEast
    w.gableFace = MAT.plain
    w.roofTh = 0.32
    // 台基
    w.c = hex('#b9b5ab')
    w.face = MAT.stone
    box(w, f, -b1 - 2.1, b1 + 2.1, -a1 - 2.1, a1 + 2.1, top, top + 0.55, { topFace: MAT.paving })
    const y1 = top + 0.55
    const colH = 3.7
    // 檐柱
    w.c = LACQUER
    w.face = MAT.plain
    const nc = Math.max(4, Math.round((a1 * 2) / 3.2))
    for (let i = 0; i <= nc; i++)
      for (const sg of [-1, 1]) tube(w, lp(f, sg * (b1 + 1.5), -a1 - 1.5 + ((a1 * 2 + 3) * i) / nc), 0.2, 0.18, y1, y1 + colH, 6)
    for (const sg of [-1, 1]) tube(w, lp(f, 0, sg * (a1 + 1.5)), 0.2, 0.18, y1, y1 + colH, 6)
    // 额枋：柱头一圈横木
    w.c = hex('#2e4a5a')
    for (const sg of [-1, 1]) {
      box(w, f, sg * (b1 + 1.5) - 0.12, sg * (b1 + 1.5) + 0.12, -a1 - 1.5, a1 + 1.5, y1 + colH - 0.45, y1 + colH, { bottom: true })
      box(w, f, -b1 - 1.5, b1 + 1.5, sg * (a1 + 1.5) - 0.12, sg * (a1 + 1.5) + 0.12, y1 + colH - 0.45, y1 + colH, { bottom: true })
    }
    // 殿身（朱墙，上下两层通高）
    const y2 = y1 + colH + 1.3
    w.c = LACQUER
    w.face = MAT.plaster
    box(w, f, -b1, b1, -a1, a1, y1, y2 + 2.9, { top: false })
    // 下檐：一圈坡屋面，自殿身墙面坡到檐柱外
    {
      const ring = (k: number, y: number) => [l3(f, -b1 - k, -a1 - k, y), l3(f, b1 + k, -a1 - k, y), l3(f, b1 + k, a1 + k, y), l3(f, -b1 - k, a1 + k, y)]
      const lo2 = ring(2.7, y1 + colH - 0.1)
      const mid = ring(1.2, y1 + colH + 0.55)
      const hi = ring(0, y2)
      const outs: [number, number, number][] = [
        [-f.v[0], 0.8, -f.v[1]],
        [f.u[0], 0.8, f.u[1]],
        [f.v[0], 0.8, f.v[1]],
        [-f.u[0], 0.8, -f.u[1]],
      ]
      const under = shade(TILE_DARK, 0.5)
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4
        w.c = TILE_DARK
        w.face = MAT.tileEast
        w.quadOut(lo2[i], lo2[j], mid[j], mid[i], outs[i])
        w.quadOut(mid[i], mid[j], hi[j], hi[i], outs[i])
        // 檐下的底板与封檐
        w.c = under
        w.face = MAT.plain
        const dn = (p: [number, number, number], d: number): [number, number, number] => [p[0], p[1] - d, p[2]]
        w.quadOut(dn(lo2[i], 0.3), dn(lo2[j], 0.3), dn(hi[j], 0.9), dn(hi[i], 0.9), [0, -1, 0])
        w.quadOut(lo2[i], lo2[j], dn(lo2[j], 0.3), dn(lo2[i], 0.3), [outs[i][0], 0, outs[i][2]])
      }
    }
    // 上层的额枋与歇山顶
    w.c = hex('#2e4a5a')
    w.face = MAT.plain
    box(w, f, -b1 - 0.05, b1 + 0.05, -a1 - 0.05, a1 + 0.05, y2 + 2.45, y2 + 2.9, { top: false })
    irimoya(w, roofFrame(f, 0, 0, a1, b1), y2 + 2.9, 0.68, 2.0, TILE_DARK, LACQUER, 'curved')
    // 正脊与鸱吻
    const yr = y2 + 2.9 + b1 * 0.68
    w.c = shade(TILE_DARK, 0.72)
    w.face = MAT.plain
    const rl = Math.max(1, a1 - b1 * 0.45 - 0.1)
    box(w, f, -0.16, 0.16, -rl, rl, yr - 0.1, yr + 0.42)
    for (const sg of [-1, 1]) box(w, f, -0.2, 0.2, sg * rl - 0.28, sg * rl + 0.28, yr + 0.1, yr + 1.0, { inset: 0.08 })
    // 门扇：朱漆、门钉
    leaves(c, f, hd * 0.2, phw, phw * 0.98, g + 0.06, spring - 0.1, DOOR_RED, true)
  },
}
