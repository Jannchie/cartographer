/**
 * 和式的城防：石垣与土塀、角橹、橹门。纯函数，在 Worker 中运行。
 */
import { hip, irimoya, MAT, shade } from '../../../../render/town3d/mesh'
import { hex, PLASTER, TILE_DARK, TIMBER, TIMBER_DARK } from '../../../../render/town3d/shared'
import { leaves } from '../../../../render/town3d/gates'
import { bastion, roofFrame, type WCtx, type WallLook } from '../../../../render/town3d/works'
import { box, lp, sweep, type Station } from '../../../../render/town3d/worksMesh'
import type { WallKit } from '../../../../render/town3d/kits'

const WA_STONE = hex('#8d8980')

/** 石垣上的土塀（代替女墙与雉堞） */
function crown(c: WCtx, look: WallLook, sts: Station[], caps: boolean) {
  const { w } = c
  const { half, hgt } = look
  // 土塀：白壁、瓦顶（两坡的墙帽）
  const o = half - 0.25
  const top = hgt + 1.9
  sweep(w, sts, [[o, hgt], [o, top], [o - 0.45, top], [o - 0.45, hgt]], { cols: [PLASTER, PLASTER, PLASTER], faces: [MAT.plaster, MAT.plain, MAT.plaster], caps })
  w.c = TILE_DARK
  sweep(w, sts, [[o + 0.4, top - 0.08], [o - 0.225, top + 0.36], [o - 0.85, top - 0.08]], { loop: true, cols: [TILE_DARK, TILE_DARK, shade(TILE_DARK, 0.55)], faces: [MAT.tileEast, MAT.tileEast, MAT.plain], caps })
  // 腰板：白壁下段一道深色木板
  w.c = TIMBER_DARK
  sweep(w, sts, [[o + 0.03, hgt], [o + 0.03, hgt + 0.7], [o, hgt + 0.7]], { faces: [MAT.board, MAT.plain], caps: false })
}

export const wall: WallKit = {
  stone: (k, s) => ({ hgt: 4.6 * k, col: WA_STONE, face: MAT.stone, batter: 1.3 * k, parapet: 0, merlon: 0, mLen: 0, mGap: 0, inner: 0, pave: hex('#9a927c'), gateHalf: 6.4 * s, arch: 'round', crown }),
  roofFace: MAT.tileEast,
  gableFace: MAT.plaster,
  tower(c, look, f, R, _roofed, g, lo) {
    const { w } = c
    const { hgt } = look
    // 橹：石垣上两层的白壁角橹，入母屋顶
    const hs = R * 0.95
    const ys = g + hgt + 0.3
    bastion(c, f, hs, hs, lo, ys, { ...look, parapet: 0 }, look.batter)
    w.roofFace = MAT.tileEast
    w.gableFace = MAT.plaster
    w.roofTh = 0.3
    const f1 = roofFrame(f, 0, 0, hs - 0.2, hs - 0.2)
    w.c = PLASTER
    w.face = MAT.plaster
    box(w, f, -hs + 0.2, hs - 0.2, -hs + 0.2, hs - 0.2, ys, ys + 3, { top: false })
    w.c = TIMBER_DARK
    w.face = MAT.board
    box(w, f, -hs + 0.16, hs - 0.16, -hs + 0.16, hs - 0.16, ys, ys + 0.9, { top: false })
    hip(w, { ...f1, a: f1.a + 0.2, b: f1.b + 0.2 }, ys + 3, 0.42, 0.75, TILE_DARK, 'curved')
    const h2 = hs * 0.62
    w.c = PLASTER
    w.face = MAT.plaster
    box(w, f, -h2, h2, -h2, h2, ys + 3.3, ys + 5.7, { top: false })
    irimoya(w, roofFrame(f, 0, 0, h2 + 0.01, h2), ys + 5.7, 0.6, 0.85, TILE_DARK, PLASTER, 'curved')
  },
  /** 城门（橹门） */
  gate(c, look, f, g, yb) {
    const { w } = c
    const { s, hgt, half } = look
    // 橹门：两侧石垣，中间木构的门，上面横跨白壁的橹
    const phw = 2.5 * s
    const bw = 2.6 * s
    const hd = Math.max(half + 0.6, 3.0 * s)
    const ys = g + hgt
    for (const sg of [-1, 1]) bastion(c, { o: lp(f, 0, sg * (phw + bw)), u: f.u, v: f.v }, hd, bw, yb, ys, { ...look, parapet: 0 }, look.batter * 0.8)
    // 门：镜柱、冠木，门道两侧的木板壁
    w.c = TIMBER_DARK
    w.face = MAT.plain
    for (const sg of [-1, 1]) {
      box(w, f, -0.3, 0.3, sg * phw - 0.3, sg * phw + 0.3, yb, ys)
      box(w, f, -hd + 0.4, -hd + 0.75, sg * phw - 0.2, sg * phw + 0.2, yb, ys)
    }
    box(w, f, -0.32, 0.32, -phw - 0.5, phw + 0.5, g + 3.9 * s, g + 4.5 * s, { bottom: true })
    leaves(c, f, -0.3, phw, phw * 0.96, g + 0.06, 3.8 * s, TIMBER)
    // 橹：横跨门道的一层，白壁、腰板、入母屋顶
    const hw2 = phw + bw * 2 - 0.5
    const hd2 = hd - 0.3
    w.c = TIMBER_DARK
    w.face = MAT.board
    box(w, f, -hd2 - 0.25, hd2 + 0.25, -hw2 - 0.25, hw2 + 0.25, ys - 0.25, ys + 0.2, { bottom: true })
    w.c = PLASTER
    w.face = MAT.plaster
    box(w, f, -hd2, hd2, -hw2, hw2, ys + 0.2, ys + 3.3, { top: false })
    w.c = TIMBER_DARK
    w.face = MAT.board
    box(w, f, -hd2 - 0.04, hd2 + 0.04, -hw2 - 0.04, hw2 + 0.04, ys + 0.2, ys + 1.1, { top: false })
    // 格子窗：正背面各一排
    w.c = hex('#3a3029')
    w.face = MAT.plain
    for (const sg of [-1, 1]) {
      const nwin = Math.max(2, Math.round(hw2 / 1.8))
      for (let i = 0; i < nwin; i++) {
        const t = -hw2 + ((i + 0.5) * hw2 * 2) / nwin
        box(w, f, sg * hd2 - 0.03, sg * hd2 + 0.03, t - 0.55, t + 0.55, ys + 1.5, ys + 2.5, { bottom: true })
      }
    }
    w.roofFace = MAT.tileEast
    w.gableFace = MAT.plaster
    w.roofTh = 0.3
    irimoya(w, roofFrame(f, 0, 0, hw2, hd2), ys + 3.3, 0.6, 1.1, TILE_DARK, PLASTER, 'curved')
  },
}
