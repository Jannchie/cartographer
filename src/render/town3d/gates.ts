/**
 * 城门：石墙的城门按文明的沙盘套件（kits.ts 的 WallKit.gate，各文明的形制在 src/packs 下各自的目录里）；
 * 木栅是木构的寨门，门上一座带顶的望台。这里另有各形制共用的构件：开了门洞的实心台、门扇、吊闸。
 * 门道都是贯通的空洞（墙面开洞、内壁与拱顶另做），从门洞里能看穿。纯函数，在 Worker 中运行。
 */
import type { P } from '../../settlement/geom'
import { MAT, hip, shade, type RGB } from './mesh'
import { TIMBER, TIMBER_DARK, hex } from './shared'
import { archFace, archOutline, axUV, beam, box, l3, lp, placeArch, roofFrame, wallTube, vault, type ArchShape, type Ax, type Opening } from './worksMesh'
import type { WCtx, WallLook } from './works'

const IRON = hex('#2f2c2a')

/**
 * 开了门洞的实心台：框的 u 为门道方向（朝城外），v 沿墙。台宽 2·hw（沿 v）、进深 2·hd，自 yb 到 top；
 * 门洞居中、贯通。返回门洞在墙面上的轮廓（供拱圈、门扇沿用）
 */
export function archBlock(c: WCtx, f: Ax, hw: number, hd: number, yb: number, top: number, shape: ArchShape, phw: number, floor: number, spring: number, o: { topCol?: RGB; sides?: boolean } = {}): Opening {
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
export function leaves(c: WCtx, f: Ax, s: number, phw: number, lw: number, y0: number, h: number, col: RGB, studs = false) {
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
export function portcullis(c: WCtx, f: Ax, s: number, phw: number, y0: number, y1: number) {
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
  const { w, H } = c
  const g = H(f.o[0], f.o[1])
  const R = look.gateHalf + 2
  let lo = g
  for (const [s, t] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0]]) lo = Math.min(lo, H(f.o[0] + f.u[0] * s * 5 + f.v[0] * t * R, f.o[1] + f.u[1] * s * 5 + f.v[1] * t * R))
  const yb = lo - 1.2
  w.base = g - 0.6
  w.c = look.col
  w.face = look.face
  if (!look.stone) return timberGate(c, f, g, yb)
  c.kit.wall.gate(c, look, f, g, yb)
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
  w.roofFace = MAT.straw
  w.gableFace = MAT.board
  w.roofTh = 0.2
  hip(w, roofFrame(f, 0, 0, phw + 0.6, 1.5), yp + 2.6, 0.75, 0.5, hex('#a8905a'))
  w.roofFace = MAT.tile
  leaves(c, f, 0.2, phw + 0.1, phw * 0.98, g + 0.06, 3.5, TIMBER)
  // 门两侧补到木栅的原木
  for (const sg of [-1, 1]) {
    for (let k = 0; k < 2; k++) {
      const q = lp(f, 0, sg * (phw + 0.25 + 0.38 * (k + 0.2)))
      w.c = shade(TIMBER, 0.9 + k * 0.15)
      w.face = MAT.plain
      wallTube(w, q, 0.21, 0.19, yb, g + 4.1, 4)
      wallTube(w, q, 0.19, 0, g + 4.1, g + 4.6, 4)
    }
  }
}
