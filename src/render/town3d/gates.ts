/**
 * 城门：按文明的形制。
 * - 西式：两座圆塔夹着门楼，尖拱门道贯通，吊闸半悬，门扇朝里开；
 * - 东方：砖砌城台、券门，台上重檐歇山的城楼；
 * - 和式：两侧石垣、中间木构的门，上面横跨一座白壁的橹（橹门）；
 * - 伊斯兰：凸出的门楼，马蹄拱门洞套在方框（阿尔菲兹）里，两侧方塔，尖顶的雉堞；
 * - 木栅：木构的寨门，门上一座带顶的望台。
 * 门道都是贯通的空洞（墙面开洞、内壁与拱顶另做），从门洞里能看穿。纯函数，在 Worker 中运行。
 */
import type { P } from '../../settlement/geom'
import { MAT, hip, irimoya, shade, type RGB } from './mesh'
import { LACQUER, PLASTER, TILE_DARK, TIMBER, TIMBER_DARK, hex } from './shared'
import { archFace, archOutline, archRing, axUV, beam, box, l3, lp, mixC, placeArch, tint, tube, vault, type ArchShape, type Ax, type Opening } from './worksMesh'
import { bastion, battlement, drum, outRing, roofFrame, type WCtx, type WallLook } from './works'

/** 城门沿墙的半宽：墙段在离门心这么远处收住（略伸进门楼里） */
export function gateHalf(look: WallLook): number {
  const { s, culture } = look
  if (!look.stone) return 2.7
  return culture === 'western' ? 5.9 * s : culture === 'eastern' ? 8.6 * s : culture === 'wa' ? 6.4 * s : 6.6 * s
}

const IRON = hex('#2f2c2a')
const DOOR_RED = hex('#7c2a1f')

/**
 * 开了门洞的实心台：框的 u 为门道方向（朝城外），v 沿墙。台宽 2·hw（沿 v）、进深 2·hd，自 yb 到 top；
 * 门洞居中、贯通。返回门洞在墙面上的轮廓（供拱圈、门扇沿用）
 */
function archBlock(c: WCtx, f: Ax, hw: number, hd: number, yb: number, top: number, shape: ArchShape, phw: number, floor: number, spring: number, o: { topCol?: RGB; sides?: boolean } = {}): Opening {
  const { w } = c
  const hole = placeArch(archOutline(shape, phw, floor - yb + spring, 12), 0, yb)
  for (const sg of [1, -1]) archFace(w, lp(f, sg * hd, 0), f.v, -hw, hw, yb, () => top, [hole], [f.u[0] * sg, f.u[1] * sg])
  vault(w, lp(f, -hd, 0), f.v, [f.u[0] * hd * 2, f.u[1] * hd * 2], hole)
  if (o.sides !== false) {
    const uv: [number, number, number] = [0, hd * 2, top]
    for (const sg of [1, -1]) {
      const a = l3(f, -hd, sg * hw, yb)
      w.uvOf = (p) => ((uv[0] = (p[0] - a[0]) * f.u[0] + (p[2] - a[2]) * f.u[1]), uv)
      w.quadOut(a, l3(f, hd, sg * hw, yb), l3(f, hd, sg * hw, top), l3(f, -hd, sg * hw, top), [f.v[0] * sg, 0, f.v[1] * sg])
    }
    w.uvOf = null
  }
  const col = w.c
  const face = w.face
  w.c = o.topCol ?? col
  w.face = MAT.paving
  w.quadOut(l3(f, -hd, -hw, top), l3(f, hd, -hw, top), l3(f, hd, hw, top), l3(f, -hd, hw, top), [0, 1, 0])
  w.c = col
  w.face = face
  return hole
}

/** 门扇：两扇朝城里开、贴着门道两壁；铰在 s 处，扇宽 lw、高 h */
function leaves(c: WCtx, f: Ax, s: number, phw: number, lw: number, y0: number, h: number, col: RGB, studs = false) {
  const { w } = c
  w.c = col
  w.face = MAT.board
  for (const sg of [-1, 1]) {
    // 略微外张（不与门道的壁共面）
    const hinge = lp(f, s, sg * (phw - 0.12))
    const dir: P = [-f.u[0] * 0.985 - f.v[0] * sg * 0.17, -f.u[1] * 0.985 - f.v[1] * sg * 0.17]
    const lf = axUV(hinge, dir)
    box(w, lf, 0, lw, -0.07, 0.07, y0, y0 + h, { bottom: true })
    if (studs) {
      // 门钉：朝门道一面的几排铜钉
      const face = w.face
      w.c = hex('#b8963e')
      w.face = MAT.plain
      const inward = sg > 0 ? -1 : 1
      for (let r = 0; r < 4; r++)
        for (let k = 0; k < 4; k++) {
          const q = l3(lf, lw * (0.18 + k * 0.21), inward * 0.075 * (lf.v[0] * f.v[0] + lf.v[1] * f.v[1] > 0 ? 1 : -1), y0 + h * (0.2 + r * 0.2))
          beam(w, [q[0], q[1] - 0.05, q[2]], [q[0], q[1] + 0.05, q[2]], 0.05, 0.03)
        }
      w.c = col
      w.face = face
    }
  }
}

/** 吊闸：悬在门洞外口的铁栅（下沿高 y0，上端没入拱顶） */
function portcullis(c: WCtx, f: Ax, s: number, phw: number, y0: number, y1: number) {
  const { w } = c
  w.c = IRON
  w.face = MAT.plain
  const n = Math.max(4, Math.round((phw * 2) / 0.42))
  for (let i = 0; i <= n; i++) {
    const t = -phw + 0.08 + ((phw * 2 - 0.16) * i) / n
    const q = lp(f, s, t)
    beam(w, [q[0], y0 - 0.22, q[1]], [q[0], y1, q[1]], 0.045, 0.045)
  }
  for (let y = y0 + 0.2; y < y1 - 0.2; y += 0.62) {
    const a = lp(f, s, -phw)
    const b = lp(f, s, phw)
    beam(w, [a[0], y, a[1]], [b[0], y, b[1]], 0.05, 0.04, false)
  }
}

/** 城门：f 的原点为门心（墙中线上），u 朝城外、v 沿墙 */
export function gate(c: WCtx, look: WallLook, f: Ax) {
  const { w, H, culture } = c
  const g = H(f.o[0], f.o[1])
  const R = gateHalf(look) + 2
  let lo = g
  for (const [s, t] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0]]) lo = Math.min(lo, H(f.o[0] + f.u[0] * s * 5 + f.v[0] * t * R, f.o[1] + f.u[1] * s * 5 + f.v[1] * t * R))
  const yb = lo - 1.2
  w.base = g - 0.6
  const { s, hgt, half } = look
  w.c = look.col
  w.face = look.face
  if (!look.stone) return timberGate(c, f, g, yb)

  if (culture === 'western') {
    const hwB = 4.7 * s
    const hd = Math.max(half + 1.3, 3.8 * s)
    const top = g + hgt + 2.8 * s
    const phw = 2.6 * s
    const spring = 3.0 * s
    const hole = archBlock(c, f, hwB, hd, yb, top, 'pointed', phw, g, spring, { topCol: look.pave })
    // 拱圈：门洞内外口各一圈浅色的券石
    w.c = tint(look.col, 1.12)
    w.face = MAT.plain
    for (const sg of [1, -1]) archRing(w, lp(f, sg * hd, 0), f.v, [f.u[0] * sg, f.u[1] * sg], hole, 0.42, 0.1)
    w.c = look.col
    w.face = look.face
    // 门楼顶的女墙与垛；外口上方一道挑出的线脚
    battlement(c, outRing(f, hd, hwB), top, look)
    w.c = tint(look.col, 0.88)
    box(w, f, hd, hd + 0.14, -hwB, hwB, top - 0.5, top - 0.2, { bottom: true })
    // 外口上方的徽板
    w.c = tint(look.col, 1.15)
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
    return
  }

  if (culture === 'eastern') {
    // 城台：比城墙宽厚、略高，券门
    const hwB = 8.6 * s
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
    return
  }

  if (culture === 'wa') {
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
    return
  }

  // 伊斯兰：凸出的门楼、马蹄拱与方框、两侧方塔
  const hwB = 5.2 * s
  const hd = half + 2.6 * s
  const top = g + hgt + 3.2 * s
  const phw = 2.3 * s
  const spring = 3.2 * s
  const fo = { o: lp(f, 1.2 * s, 0), u: f.u, v: f.v }
  const hole = archBlock(c, fo, hwB, hd, yb, top, 'horseshoe', phw, g, spring, { topCol: look.pave })
  const light = mixC(look.col, hex('#efe6d0'), 0.75)
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
}

/** 木栅的寨门：门柱与过梁、木板门扇，门上一座带顶的望台 */
function timberGate(c: WCtx, f: Ax, g: number, yb: number) {
  const { w } = c
  const phw = 2.1
  const yp = g + 4.3
  w.c = TIMBER_DARK
  w.face = MAT.plain
  for (const sg of [-1, 1])
    for (const ss of [-1, 1]) {
      const q = lp(f, ss * 1.25, sg * (phw + 0.25))
      beam(w, [q[0], yb, q[1]], [q[0], yp + 2.6, q[1]], 0.2, 0.2, false)
    }
  // 过梁与望台
  for (const ss of [-1, 1]) {
    const a = lp(f, ss * 1.25, -phw - 0.6)
    const b = lp(f, ss * 1.25, phw + 0.6)
    beam(w, [a[0], yp - 0.35, a[1]], [b[0], yp - 0.35, b[1]], 0.16, 0.18)
  }
  w.c = TIMBER
  w.face = MAT.plank
  w.uvOf = (p) => [(p[0] - f.o[0]) * f.v[0] + (p[2] - f.o[1]) * f.v[1], 0, 0]
  box(w, f, -1.7, 1.7, -phw - 0.75, phw + 0.75, yp - 0.17, yp, { bottom: true })
  w.uvOf = null
  w.face = MAT.board
  // 望台朝外的挡板与两侧矮栏
  box(w, f, 1.6, 1.7, -phw - 0.75, phw + 0.75, yp, yp + 1.25)
  box(w, f, -1.7, -1.62, -phw - 0.75, phw + 0.75, yp, yp + 0.95)
  for (const sg of [-1, 1]) box(w, f, -1.7, 1.7, sg * (phw + 0.75) - (sg > 0 ? 0.08 : 0), sg * (phw + 0.75) + (sg > 0 ? 0 : 0.08), yp, yp + 1.0)
  w.roofFace = MAT.thatch
  w.gableFace = MAT.board
  w.roofTh = 0.2
  hip(w, roofFrame(f, 0, 0, phw + 0.6, 1.5), yp + 2.6, 0.75, 0.5, hex('#a8905a'))
  w.roofFace = MAT.tile
  leaves(c, f, 0.2, phw + 0.1, phw * 0.98, g + 0.06, 3.5, TIMBER)
  // 门两侧补到木栅的原木
  for (const sg of [-1, 1]) {
    for (let k = 0; k < 2; k++) {
      const q = lp(f, 0, sg * (phw + 0.25 + 0.38 * (k + 0.2)))
      w.c = tint(TIMBER, 0.9 + k * 0.15)
      w.face = MAT.plain
      tube(w, q, 0.21, 0.19, yb, g + 4.1, 4)
      tube(w, q, 0.19, 0, g + 4.1, g + 4.6, 4)
    }
  }
}
