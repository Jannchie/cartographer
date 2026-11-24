/**
 * 桥、渡口与浅滩：
 * - 石拱桥（西式圆拱、东方高拱带望柱栏板、伊斯兰尖拱）：拱下透空，桥墩带分水尖，桥面起拱，两头顺着引道落到路面；
 * - 木桥（和式）与神桥（朱漆太鼓桥）：排架桩、桥板、带柱头的栏杆；
 * - 护城河上城门外的桥；渡口两岸的小栈桥与渡船；浅滩的踏石。
 * 纯函数，在 Worker 中运行。
 */
import type { P } from '../../settlement/geom'
import type { Settlement, Wall } from '../../settlement/types'
import { MAT, shade, type RGB } from './mesh'
import { ADOBE, STONE, STONE_EAST, TIMBER, TIMBER_DARK, VERMILION, hex } from './shared'
import { archFace, archOutline, axUV, beam, box, lp, placeArch, pyramid, sweep, tube, vault, type ArchShape, type Opening, type Station } from './worksMesh'
import { boat, jetty } from './harbor'
import type { WCtx } from './works'

/** 墩脚的深度：河床以下 */
const BED = -3.2
/** 起拱线：略高于水面 */
const SPRING = 0.12

interface Span {
  a: P
  b: P
  /** 桥面半宽 */
  half: number
  /** 两端的桥面高度、拱高 */
  ya: number
  yb: number
  rise: number
  /** 墩脚的深度与起拱线的高度（河上的桥按水面，护城河的桥按两头的地面） */
  bed: number
  spring: number
}

/** 沿桥轴的站：x 自 −ext 到 L + ext，桥面高度按抛物线，两端的引道落到地面以下 */
function deckStations(c: WCtx, sp: Span, ext: number, step: number): { sts: Station[]; deck: (x: number) => number; L: number; e: P; n: P } {
  const { a, b, ya, yb, rise } = sp
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  const e: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  const n: P = [-e[1], e[0]]
  const ga = c.H(a[0] - e[0] * ext, a[1] - e[1] * ext) - 0.25
  const gb = c.H(b[0] + e[0] * ext, b[1] + e[1] * ext) - 0.25
  const deck = (x: number) => {
    if (x < 0) return ya + (Math.min(ga, ya) - ya) * (-x / ext)
    if (x > L) return yb + (Math.min(gb, yb) - yb) * ((x - L) / ext)
    const t = x / L
    return ya + (yb - ya) * t + rise * 4 * t * (1 - t)
  }
  const sts: Station[] = []
  const xs: number[] = [-ext, 0]
  const m = Math.max(2, Math.ceil(L / step))
  for (let i = 1; i <= m; i++) xs.push((L * i) / m)
  xs.push(L + ext)
  for (const x of xs) {
    const y = deck(x)
    sts.push({ p: [a[0] + e[0] * x, a[1] + e[1] * x], n, k: 1, s: x + ext, g: y, lo: y })
  }
  return { sts, deck, L, e, n }
}

/** 石拱桥 */
function stoneBridge(c: WCtx, sp: Span, col: RGB, face: number, shape: ArchShape, style: 'parapet' | 'balustrade') {
  const { w } = c
  const { half, bed: BED, spring: SPRING } = sp
  const ext = 3.2
  const { sts, deck, L, e, n } = deckStations(c, sp, ext, 1.6)
  // 分孔：每孔净跨约 8 米，墩宽 1.7 米；两端各留 0.7 米的桥台
  const pier = 1.7
  const nA = Math.max(1, Math.round((L - 1) / 9.5))
  const span = (L - 1.4 - pier * (nA - 1)) / nA
  const hw = span / 2
  const holes: Opening[] = []
  const centers: number[] = []
  if (hw > 0.9)
    for (let i = 0; i < nA; i++) {
      const cx = 0.7 + hw + i * (span + pier)
      centers.push(cx)
      // 拱顶离桥面留出拱圈与填土；矢高不超过半跨
      const room = Math.min(deck(cx), deck(cx - hw * 0.6) + 0.2, deck(cx + hw * 0.6) + 0.2) - 0.6 - SPRING
      const rise = Math.max(0.35, Math.min(hw * (shape === 'pointed' ? 1.15 : 0.98), room))
      let pts: [number, number][]
      if (shape === 'pointed') {
        // 尖拱按矢高压扁：两心拱的高度比例缩到 rise
        const base = archOutline('pointed', hw, 0, 10)
        const full = hw * Math.sqrt(1.25 * 1.25 - 0.25 * 0.25)
        pts = base.map(([x, y], k) => (k === 0 || k === base.length - 1 ? [x, 0] : [x, SPRING - BED + (y * rise) / full]))
      } else pts = rise > hw * 0.93 ? archOutline('round', hw, SPRING - BED, 12) : archOutline('segmental', hw, SPRING - BED, 12, rise)
      holes.push(placeArch(pts, cx, BED))
    }
  w.c = col
  w.face = face
  // 两侧的桥身（拱洞透空）与拱腹
  for (const sg of [1, -1]) {
    const o: P = [sp.a[0] + n[0] * half * sg, sp.a[1] + n[1] * half * sg]
    archFace(w, o, e, -ext, L + ext, BED, deck, holes, [n[0] * sg, n[1] * sg], 1.6)
  }
  const o0: P = [sp.a[0] - n[0] * half, sp.a[1] - n[1] * half]
  for (const h of holes) vault(w, o0, e, [n[0] * half * 2, n[1] * half * 2], h)
  // 拱圈：浅色的券石
  w.c = shade(col, 1.12)
  w.face = MAT.plain
  for (const sg of [1, -1]) {
    const o: P = [sp.a[0] + n[0] * half * sg, sp.a[1] + n[1] * half * sg]
    for (const h of holes) archRing2(c, o, e, [n[0] * sg, n[1] * sg], h)
  }
  // 桥墩的分水尖：上下游各一个三角的墩头，顶上斜收
  w.c = col
  w.face = face
  for (let i = 0; i + 1 < centers.length; i++) {
    const px = (centers[i] + centers[i + 1]) / 2
    for (const sg of [1, -1]) {
      const p1: P = [sp.a[0] + e[0] * (px - pier / 2) + n[0] * half * sg, sp.a[1] + e[1] * (px - pier / 2) + n[1] * half * sg]
      const p2: P = [sp.a[0] + e[0] * (px + pier / 2) + n[0] * half * sg, sp.a[1] + e[1] * (px + pier / 2) + n[1] * half * sg]
      const tip: P = [sp.a[0] + e[0] * px + n[0] * (half + 1.5) * sg, sp.a[1] + e[1] * px + n[1] * (half + 1.5) * sg]
      const yt = SPRING + 0.9
      const out1: [number, number, number] = [n[0] * sg - e[0], 0, n[1] * sg - e[1]]
      const out2: [number, number, number] = [n[0] * sg + e[0], 0, n[1] * sg + e[1]]
      w.quadOut([p1[0], BED, p1[1]], [tip[0], BED, tip[1]], [tip[0], yt, tip[1]], [p1[0], yt, p1[1]], out1)
      w.quadOut([p2[0], BED, p2[1]], [tip[0], BED, tip[1]], [tip[0], yt, tip[1]], [p2[0], yt, p2[1]], out2)
      const apex: [number, number, number] = [sp.a[0] + e[0] * px + n[0] * half * sg, yt + 0.9, sp.a[1] + e[1] * px + n[1] * half * sg]
      w.triOut([p1[0], yt, p1[1]], [tip[0], yt, tip[1]], apex, [out1[0], 1, out1[2]])
      w.triOut([p2[0], yt, p2[1]], [tip[0], yt, tip[1]], apex, [out2[0], 1, out2[2]])
    }
  }
  // 桥面
  w.c = shade(col, 0.92)
  w.face = MAT.paving
  sweep(w, sts, [[half, 0], [-half, 0]], { caps: false })
  // 桥面外沿一道挑出的线脚
  w.c = shade(col, 1.06)
  w.face = MAT.plain
  for (const sg of [1, -1]) sweep(w, sts, sg > 0 ? [[half, -0.22], [half + 0.1, -0.22], [half + 0.1, 0.02], [half, 0.02]] : [[-half, 0.02], [-half - 0.1, 0.02], [-half - 0.1, -0.22], [-half, -0.22]], { caps: true })
  if (style === 'parapet') {
    // 实心的护墙，顶上压顶石
    w.c = col
    w.face = face
    for (const sg of [1, -1]) {
      const o = sg * half
      const i = sg * (half - 0.34)
      sweep(w, sts, sg > 0 ? [[o, 0], [o, 0.95], [i, 0.95], [i, 0]] : [[i, 0], [i, 0.95], [o, 0.95], [o, 0]], { caps: true, faces: [face, MAT.plain, face] })
    }
    w.c = shade(col, 1.1)
    w.face = MAT.plain
    for (const sg of [1, -1]) {
      const o = sg * (half + 0.05)
      const i = sg * (half - 0.39)
      sweep(w, sts, sg > 0 ? [[o, 0.95], [o, 1.07], [i, 1.07], [i, 0.95]] : [[i, 0.95], [i, 1.07], [o, 1.07], [o, 0.95]], { loop: true, caps: true })
    }
    // 护墙的两头各收在一座方墩上（墩脚埋进引道），护墙不以截断面收尾
    w.c = shade(col, 1.04)
    w.face = face
    for (const x of [-ext + 0.3, L + ext - 0.3]) {
      const y = deck(x)
      for (const sg of [1, -1]) {
        const f = axUV([sp.a[0] + e[0] * x + n[0] * (half - 0.17) * sg, sp.a[1] + e[1] * x + n[1] * (half - 0.17) * sg], e)
        box(w, f, -0.3, 0.3, -0.29, 0.29, y - 0.8, y + 1.25, { inset: 0.02 })
        w.face = MAT.plain
        pyramid(w, f, 0.34, 0.33, y + 1.25, 0.22)
        w.face = face
      }
    }
  } else {
    // 望柱栏板：薄的栏板、一根根带柱头的望柱
    const lc = shade(col, 1.22)
    w.c = lc
    w.face = MAT.plain
    for (const sg of [1, -1]) {
      const o = sg * (half - 0.08)
      const i = sg * (half - 0.24)
      sweep(w, sts, sg > 0 ? [[o, 0], [o, 0.82], [i, 0.82], [i, 0]] : [[i, 0], [i, 0.82], [o, 0.82], [o, 0]], { caps: true })
    }
    const total = L + ext * 2
    const m = Math.max(2, Math.round(total / 2.1))
    for (let k = 0; k <= m; k++) {
      const x = -ext + (total * k) / m
      const y = deck(x)
      for (const sg of [1, -1]) {
        const q: P = [sp.a[0] + e[0] * x + n[0] * (half - 0.16) * sg, sp.a[1] + e[1] * x + n[1] * (half - 0.16) * sg]
        const f = axUV(q, e)
        box(w, f, -0.13, 0.13, -0.13, 0.13, y - 0.1, y + 1.12)
        pyramid(w, f, 0.16, 0.16, y + 1.12, 0.26)
      }
    }
  }
}

/** 拱圈（石拱桥）：沿拱洞起拱线以上的一圈券石，贴着桥身外皮 */
function archRing2(c: WCtx, o: P, e: P, out: P, hole: Opening) {
  const { w } = c
  const P3 = (x: number, y: number, k: number): [number, number, number] => [o[0] + e[0] * x + out[0] * k, y, o[1] + e[1] * x + out[1] * k]
  const out3: [number, number, number] = [out[0], 0, out[1]]
  const wd = 0.38
  const pr = 0.07
  const from = 1
  const to = hole.length - 2
  const cx = (hole[0][0] + hole[hole.length - 1][0]) / 2
  const cy = hole[from][1] - 2
  // 券石向拱外的方向：近似取自拱心向外
  const nrm = (i: number): [number, number] => {
    const dx = hole[i][0] - cx
    const dy = hole[i][1] - cy
    const l = Math.hypot(dx, dy) || 1
    return [dx / l, dy / l]
  }
  for (let i = from; i < to; i++) {
    const a = hole[i]
    const b = hole[i + 1]
    const na = nrm(i)
    const nb = nrm(i + 1)
    const ao: [number, number] = [a[0] + na[0] * wd, a[1] + na[1] * wd]
    const bo: [number, number] = [b[0] + nb[0] * wd, b[1] + nb[1] * wd]
    w.quadOut(P3(a[0], a[1], pr), P3(b[0], b[1], pr), P3(bo[0], bo[1], pr), P3(ao[0], ao[1], pr), out3)
    w.quadOut(P3(ao[0], ao[1], 0), P3(bo[0], bo[1], 0), P3(bo[0], bo[1], pr), P3(ao[0], ao[1], pr), [e[0] * (na[0] + nb[0]), na[1] + nb[1], e[1] * (na[0] + nb[0])])
    w.quadOut(P3(a[0], a[1], 0), P3(b[0], b[1], 0), P3(b[0], b[1], pr), P3(a[0], a[1], pr), [-e[0] * (na[0] + nb[0]), -(na[1] + nb[1]), -e[1] * (na[0] + nb[0])])
  }
}

/** 木桥：排架桩、纵梁、桥板、栏杆；sacred 为朱漆的神桥（高拱、宝珠柱头） */
function timberBridge(c: WCtx, sp: Span, sacred: boolean) {
  const { w } = c
  const { half, bed: BED } = sp
  const ext = sacred ? 1.2 : 2.2
  const { sts, deck, L, e, n } = deckStations(c, sp, ext, sacred ? 0.9 : 1.5)
  const wood = sacred ? VERMILION : TIMBER
  const dark = sacred ? hex('#8f2a1c') : TIMBER_DARK
  // 桥板：板缝横穿桥向
  w.c = sacred ? hex('#6b4a36') : shade(TIMBER, 1.25)
  w.face = MAT.plank
  for (let i = 0; i + 1 < sts.length; i++) {
    const A = sts[i]
    const B = sts[i + 1]
    const q = (st: Station, t: number, dy: number): [number, number, number] => [st.p[0] + n[0] * t, st.g + dy, st.p[1] + n[1] * t]
    const a0 = q(A, -half, 0)
    const a1 = q(A, half, 0)
    const b0 = q(B, -half, 0)
    const b1 = q(B, half, 0)
    w.uvOf = (p) => [p === a0 || p === a1 ? A.s : B.s, 0, 0]
    w.quadOut(a0, a1, b1, b0, [0, 1, 0])
    w.uvOf = null
    w.quadOut(q(A, -half, -0.14), q(A, half, -0.14), q(B, half, -0.14), q(B, -half, -0.14), [0, -1, 0])
  }
  // 两侧的边梁与中间的纵梁
  w.c = dark
  w.face = MAT.plain
  for (const t of [-half, 0, half]) sweep(w, sts, [[t + 0.13, -0.42], [t + 0.13, 0.03], [t - 0.13, 0.03], [t - 0.13, -0.42]], { loop: true, caps: true })
  // 排架：每 4 ~ 5 米一排，每排两三根桩，上面一根盖梁
  const m = Math.max(sacred ? 1 : 2, Math.round(L / (sacred ? 4 : 4.6)))
  for (let k = 1; k < m; k++) {
    const x = (L * k) / m
    const y = deck(x)
    const ctr: P = [sp.a[0] + e[0] * x, sp.a[1] + e[1] * x]
    w.c = wood
    for (const t of half > 2.2 ? [-half + 0.35, 0, half - 0.35] : [-half + 0.3, half - 0.3]) tube(w, [ctr[0] + n[0] * t, ctr[1] + n[1] * t], 0.17, 0.15, BED, y - 0.6, 6)
    w.c = dark
    beam(w, [ctr[0] - n[0] * (half + 0.25), y - 0.52, ctr[1] - n[1] * (half + 0.25)], [ctr[0] + n[0] * (half + 0.25), y - 0.52, ctr[1] + n[1] * (half + 0.25)], 0.14, 0.11)
    // 桩间的横撑
    if (y - 1.7 > sp.spring + 0.3) beam(w, [ctr[0] - n[0] * (half - 0.3), y - 1.6, ctr[1] - n[1] * (half - 0.3)], [ctr[0] + n[0] * (half - 0.3), y - 1.6, ctr[1] + n[1] * (half - 0.3)], 0.07, 0.09, false)
  }
  // 栏杆：柱、扶手与中贯
  const total = L + ext * 2
  const posts = Math.max(2, Math.round(total / (sacred ? 1.5 : 1.9)))
  w.c = wood
  for (const sg of [1, -1]) {
    const o = sg * (half - 0.12)
    for (const [y, t] of [[0.92, 0.06], [0.48, 0.045]] as [number, number][]) sweep(w, sts, [[o + t, y - t], [o + t, y + t], [o - t, y + t], [o - t, y - t]], { loop: true, caps: true })
    for (let k = 0; k <= posts; k++) {
      const x = -ext + (total * k) / posts
      const y = deck(x)
      const q: P = [sp.a[0] + e[0] * x + n[0] * o, sp.a[1] + e[1] * x + n[1] * o]
      const f = axUV(q, e)
      w.c = wood
      box(w, f, -0.085, 0.085, -0.085, 0.085, y - 0.15, y + 1.08)
      if (sacred || k === 0 || k === posts) {
        // 宝珠柱头（拟宝珠）：深色的尖顶
        w.c = sacred ? hex('#2a2622') : dark
        box(w, f, -0.11, 0.11, -0.11, 0.11, y + 1.08, y + 1.2)
        pyramid(w, f, 0.1, 0.1, y + 1.2, 0.2)
      }
    }
  }
}

/** 桥、渡口、浅滩 */
export function crossing(c: WCtx, x: Settlement['crossings'][number]) {
  const { w, culture, H } = c
  const L = Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1])
  if (L < 1) return
  const mid: P = [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2]
  const e: P = [(x.b[0] - x.a[0]) / L, (x.b[1] - x.a[1]) / L]
  w.at(mid[0], mid[1])
  if (x.kind === 'ford') {
    // 浅滩：一串略高出水面的踏石（与二维的画法同一组位置）
    w.c = hex('#9b968c')
    w.face = MAT.rock
    w.base = -0.6
    const n: P = [-e[1], e[0]]
    for (let s = 1.5; s < L; s += 2.6) {
      const o = ((((s * 7) % 3) - 1.5) * 0.4) as number
      const p: P = [x.a[0] + e[0] * s + n[0] * o, x.a[1] + e[1] * s + n[1] * o]
      const top = Math.max(0.12, H(p[0], p[1]) + 0.18)
      tube(w, p, 0.95, 0.75, -1.4, top, 7, { cap: true })
    }
    return
  }
  if (x.kind === 'ferry') {
    // 渡口：两岸各一座小栈桥，河心一条渡船
    w.base = -1
    for (const [end, sg] of [[x.a, 1], [x.b, -1]] as [P, number][]) {
      const q: P = [end[0] + e[0] * 2.5 * sg, end[1] + e[1] * 2.5 * sg]
      const f = axUV(q, [e[0] * sg, e[1] * sg])
      jetty(c, [lp(f, -4.5, -1.5), lp(f, 4, -1.5), lp(f, 4, 1.5), lp(f, -4.5, 1.5)])
    }
    w.at(mid[0], mid[1])
    boat(c, { p: [mid[0] + e[0] * L * 0.12, mid[1] + e[1] * L * 0.12], angle: Math.atan2(e[1], e[0]), len: 9 }, 'ferry')
    return
  }
  const ya = Math.max(H(x.a[0], x.a[1]), 0.45) + 0.12
  const yb = Math.max(H(x.b[0], x.b[1]), 0.45) + 0.12
  const half = Math.max(1.3, x.width / 2)
  w.base = Math.min(ya, yb) - 0.8
  const river = { bed: BED, spring: SPRING }
  if (x.sacred) return timberBridge(c, { a: x.a, b: x.b, half, ya, yb, rise: Math.max(1.2, Math.min(L * 0.17, 4.2)), ...river }, true)
  if (culture === 'wa') return timberBridge(c, { a: x.a, b: x.b, half, ya, yb, rise: Math.max(0.5, Math.min(L * 0.055, 1.8)), ...river }, false)
  // 石拱桥：桥面抬到拱顶之上（至少高出水面约两米），矢高随跨度
  const lowest = Math.min(ya, yb)
  const riseK = culture === 'eastern' ? 0.11 : 0.075
  const rise = Math.max(Math.max(0.6, 2.3 - lowest), Math.min(L * riseK, culture === 'eastern' ? 4.2 : 3.2))
  const col = culture === 'eastern' ? shade(STONE_EAST, 1.12) : culture === 'islamic' ? ADOBE : STONE
  const face = culture === 'islamic' ? MAT.brick : MAT.stone
  stoneBridge(c, { a: x.a, b: x.b, half, ya, yb, rise: Math.min(rise, L * 0.2), ...river }, col, face, culture === 'islamic' ? 'pointed' : 'round', culture === 'eastern' ? 'balustrade' : 'parapet')
}

/**
 * 护城河上城门外的桥：桥面与两头的地面齐平、略起拱；河没有刻进地形时桥身埋在地里，只露出桥面与栏杆
 */
export function moatBridge(c: WCtx, wall: Wall, b: { p: P; angle: number }) {
  const { w, culture, H } = c
  const moat = wall.moat
  if (!moat) return
  const u: P = [Math.cos(b.angle), Math.sin(b.angle)]
  const hl = moat.width / 2 + 1.6
  const a: P = [b.p[0] - u[0] * hl, b.p[1] - u[1] * hl]
  const e: P = [b.p[0] + u[0] * hl, b.p[1] + u[1] * hl]
  w.at(b.p[0], b.p[1])
  const ya = H(a[0], a[1]) + 0.1
  const yb = H(e[0], e[1]) + 0.1
  w.base = Math.min(ya, yb) - 0.8
  const low = Math.min(ya, yb)
  const sp: Span = { a, b: e, half: 3.1, ya, yb, rise: 0.45, bed: low - 4.2, spring: low - 2.2 }
  if (culture === 'wa') return timberBridge(c, sp, false)
  const col = culture === 'eastern' ? shade(STONE_EAST, 1.12) : culture === 'islamic' ? ADOBE : STONE
  stoneBridge(c, sp, col, culture === 'islamic' ? MAT.brick : MAT.stone, culture === 'islamic' ? 'pointed' : 'round', culture === 'eastern' ? 'balustrade' : 'parapet')
}
