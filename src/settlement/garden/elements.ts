import { clamp } from '../../gen/util'
import { mark } from '../ctx'
import { add, at, box, cbox, chaikin, frameAt, lerpP, local, neg, perp, segDist, sub, unit, type P, type Poly, type RectFrame } from '../geom'
import type { Culture } from '../types'
import { inside } from '../wards'
import type { Elem } from '../compose/core'
import {
  area, blob, bld, centroid, circlePoly, clump, crosses, dist, edgeDist, fitShape, gates, insetConvex, kiosk,
  landmark, loop, ngon, northward, offWater, part, pave, pointInPoly, reach, rock, rocks, row, scatter, shore, spur, touch,
  tree, walk, wall, dry, rectIn, type Garden, type Skel,
} from './kit'
import * as dmath from '../../gen/dmath'

/**
 * 元素池：园子里能放的每样东西（水面、园路、亭榭、花木、小品），各自标明
 * - 能占哪种槽位（slot：轴端、园心、池岸、岛、园路节点、园角……，由骨架给出位置、朝向与大小）
 * - 属于哪些文明（cult）、能用在哪些骨架（skel）
 * - 需要多大的槽（min）、占多深（depth：轴端、园边），以及怎么盖（build）
 * 骨架在每个槽位按园址抽签选一样（预设给权重偏好），盖不下就换下一样；于是同一套骨架能拼出许多种园子，
 * 而不合规矩的搭配（自然式里的绿篱花坛、规则式里的曲岸湖）根本不在候选里。
 */

export type SlotType =
  | 'layout' // 规则式的轴线格局
  | 'axis' // 轴线的做法（甬道、水渠、林荫道）
  | 'edge' // 园边（林带、柏树圈、游廊、竹）
  | 'centre' // 轴线交点（喷水池、亭、陵）
  | 'axisEnd' // 轴端（橘园、观景亭、凉亭、园门）
  | 'along' // 沿轴成对的（行道树、柏树、雕像）
  | 'compartment' // 规则式的花坛格
  | 'water' // 自然式的主池
  | 'island' // 岛上
  | 'crossing' // 渡水（曲桥、拱桥、汀步、长堤）
  | 'hall' // 池北的主厅
  | 'shore' // 池岸的景点（水榭、茶屋、柳）
  | 'node' // 园路上的景点（亭、石、灯笼、孤植树）
  | 'corner' // 离池最远的园角（假山、书斋、塔、迷园）
  | 'shoreline' // 沿岸一圈（柳、护岸石）
  | 'lawn' // 其余的草地
  | 'field' // 成片的地（梅林、竹林、果园、白砂）
  | 'hub' // 成片园当中的节点
  | 'paths' // 成片园的园路
  | 'pond' // 成片园角上的小池
  | 'entry' // 参道口
  | 'marker' // 参道中途的门
  | 'flank' // 参道两旁
  | 'terminal' // 参道尽头

/** 一个槽位：骨架给出位置 p、朝向 d、大小 s（米），以及各槽位自己的附加信息 */
export interface Spot {
  t: SlotType
  p: P
  d: P
  s: number
  /** 规则格（花坛格、轴线段、前庭） */
  F?: RectFrame
  /** 花坛格的轮廓（已切好）、池岸与岛的轮廓 */
  q?: Poly
  /** 参道、轴线段的两端 */
  line?: [P, P]
  /** 园路（自然式的回游路） */
  path?: P[]
  /** 可用进深（轴端） */
  room?: number
  /** 回写：园心用掉的半径 */
  r?: number
}

/** 园林元素：组合式的元素（compose/core.ts 的 Elem：id、权重、槽位、min 是槽位大小 s 至少多少、tiers）另带园子自己的几项 */
export interface El extends Elem<string, SlotType> {
  slots: readonly SlotType[]
  cult?: Culture[]
  skel?: Skel[]
  /** 占的进深（轴端、园边往里收多少） */
  depth?: number
  /** 轴线宽度的倍数 */
  wide?: number
  /** 花坛格：底下铺成砂地（法式、伊斯兰的下沉花坛）；否则是草坪 */
  pave?: boolean
  /** 成片园：自成一园（枯山水），骨架别的都不做 */
  solo?: boolean
  build: (K: Garden, s: Spot) => boolean
}

const W: Culture = 'western'
const E: Culture = 'eastern'
const J: Culture = 'wa'
const I: Culture = 'islamic'
const ok = () => true

// —————————————————————— 抽签 ——————————————————————

/** 元素 e 能不能放进这座园子的槽位 s（文明、骨架、槽位大小与进深） */
const fits = (K: Garden, s: Spot, e: El) =>
  (!e.cult || e.cult.includes(K.cult)) && (!e.skel || e.skel.includes(K.P.skel)) && (e.min ?? 0) <= s.s && (e.depth ?? 0) <= (s.room ?? Infinity)

/**
 * 在槽位 s 的候选里经作曲者抽一样（元素基础权重 × 预设对这种槽位的偏好；偏好为 0 的不要）。
 * 槽位按种类编号（这座园子里第几个 shore 槽位……）；重试（skip 里多一样）换一个序号。别的槽位重试不影响它
 */
export function choose(K: Garden, s: Spot, skip: string[] = []): El | null {
  let name = slotName.get(s)
  if (!name) slotName.set(s, (name = `slot.${s.t}.${K.C.seq(`slot.${s.t}`)}`))
  return K.C.draw(name, POOL, { slot: s.t, key: s.t, k: skip.length, only: (id, e) => !skip.includes(id) && fits(K, s, e as El) })
}

/** 每个槽位的抽签名（同一个槽位重试时不变） */
const slotName = new WeakMap<Spot, string>()

/** 记下槽位上盖成的元素（进园子的签名，同一种槽位每处都记） */
export const note = (K: Garden, t: SlotType | string, id: string) => K.C.note(t, id, true)

/** 选一样盖在槽位上，盖不下换一样（最多四次）；返回盖成的元素 */
export function fill(K: Garden, s: Spot, skip: string[] = []): El | null {
  const tried = [...skip]
  for (let i = 0; i < 4; i++) {
    const e = choose(K, s, tried)
    if (!e) return null
    if (e.build(K, s)) {
      note(K, s.t, e.id)
      return e
    }
    tried.push(e.id)
  }
  return null
}

// —————————————————————— 共用的小动作 ——————————————————————

/** 按文明的亭：东方方亭、和风东屋（小方亭）、西式八角凉亭、伊斯兰八角 köşk */
function pavilion(K: Garden, p: P, s: number, wet = false, d: P = K.f) {
  if (K.cult === 'western' || K.cult === 'islamic') return kiosk(K, p, s, 'civic', 8, wet, d)
  return kiosk(K, p, K.cult === 'wa' ? s * 0.8 : s, 'pagoda', 4, wet, d)
}
const seat = (K: Garden, p: P) => {
  K.seat ??= p
  return true
}
/** 以 p 为中心的一圈铺装 */
const round = (K: Garden, p: P, r: number, n = 24) => pave(K, circlePoly(p, r, n))
/** 在 [a, b] 两侧 ±y 处各种一行 */
function pairRows(K: Garden, s: Spot, y: number, step: number, r: number | ((k: number) => number), any = true) {
  const [a, b] = s.line!
  const n = unit(perp(sub(b, a)))
  for (const k of [-1, 1]) row(K, add(a, n, k * y), add(b, n, k * y), step, r, any)
}
/** 在 [a, b] 两侧 ±y 处每隔 step 立一对小品 */
function pairs(K: Garden, s: Spot, y: number, step: number, x0 = step / 2) {
  const [a, b] = s.line!
  const L = dist(a, b)
  const d = unit(sub(b, a))
  const n = perp(d)
  let made = 0
  for (let x = x0; x < L - 2; x += step) for (const k of [-1, 1]) if (landmark(K, add(add(a, d, x), n, k * y), 'statue')) made++
  return made > 0
}
/** 园边一圈（规则式给的矩形，否则是园地往里收） */
const ringOf = (K: Garden, s: Spot, inset: number): Poly => (s.F ? box(s.F, -s.F.hx + inset, s.F.hx - inset, -s.F.hy + inset, s.F.hy - inset) : insetConvex(K.g, inset))
function ringRows(K: Garden, q: Poly, step: number, r: number, any = false) {
  for (let i = 0; i < q.length; i++) row(K, q[i], q[(i + 1) % q.length], step, r, any)
}
/** 池岸上离 p 最近的一点 */
function nearShore(q: Poly, p: P): P {
  let best = q[0]
  for (const v of q) if (dist(v, p) < dist(best, p)) best = v
  return best
}
/** 最窄处横过池面的一条线（在池心附近的几条平行线与几个方向里取最短、又不碰岛的） */
function narrowest(K: Garden, q: Poly, minW = 6): [P, P] | null {
  const c = centroid(q)
  const o = K.C.nth.h('narrowest') * Math.PI
  let best: [P, P] | null = null
  let bw = Infinity
  for (let i = 0; i < 12; i++) {
    const d: P = [dmath.cos(o + (i * Math.PI) / 12), dmath.sin(o + (i * Math.PI) / 12)]
    const n = perp(d)
    for (const t of [-0.3, -0.15, 0, 0.15, 0.3]) {
      const m = add(c, n, t * (reach(q, c, n) + reach(q, c, neg(n))))
      if (!pointInPoly(m, q)) continue
      const a = add(m, d, -reach(q, m, neg(d)) - 2.5)
      const b = add(m, d, reach(q, m, d) + 2.5)
      const w = dist(a, b)
      if (w < minW || w >= bw || !Number.isFinite(w)) continue
      if (K.isles.some((z) => crosses(a, b, z, 1))) continue
      if (!pointInPoly(a, K.inner) || !pointInPoly(b, K.inner)) continue
      best = [a, b]
      bw = w
    }
  }
  return best
}

// —————————————————————— 规则式：格局与轴线 ——————————————————————

const LAYOUT: El[] = [
  { id: 'single', slots: ['layout'], cult: [W, I], build: ok },
  { id: 'cross', slots: ['layout'], cult: [W, I], w: 1.5, build: ok },
  { id: 'parallel', slots: ['layout'], cult: [W], w: 0.6, min: 18, build: ok },
]

/** 轴线段：s.F 的 u 沿轴、hx 半长、hy 半宽 */
const AXIS: El[] = [
  { id: 'alley', slots: ['axis'], build: (K, s) => (pave(K, cbox(s.F!, 0, 0, s.F!.hx * 2, s.F!.hy * 2)), true) },
  {
    id: 'tapis',
    slots: ['axis'],
    cult: [W],
    wide: 1.6,
    build: (K, s) => {
      // 草毯（tapis vert）：当中一条草带，两边是园路
      const F = s.F!
      for (const y of [-1, 1]) walk(K, [at(F, -F.hx, y * (F.hy - 0.8)), at(F, F.hx, y * (F.hy - 0.8))], 1.6)
      K.bare.push(cbox(F, 0, 0, F.hx * 2, F.hy * 2))
      return true
    },
  },
  {
    id: 'canal',
    slots: ['axis'],
    cult: [I, W],
    wide: 1.3,
    build: (K, s) => {
      const F = s.F!
      if (F.hx < 3) return false
      pave(K, cbox(F, 0, 0, F.hx * 2, F.hy * 2))
      part(K, cbox(F, 0, 0, F.hx * 2, clamp(F.hy * 0.45, 1, 2.4)), 'pond')
      // 渠里一串喷泉
      if (K.C.nth.chance('canal.fountains', 0.6)) for (let x = -F.hx + 5; x < F.hx - 3; x += 11) landmark(K, at(F, x, 0), 'fountain')
      return true
    },
  },
  {
    id: 'rill',
    slots: ['axis'],
    cult: [I],
    build: (K, s) => {
      // 细渠（chadar）：甬道当中一道窄水
      const F = s.F!
      pave(K, cbox(F, 0, 0, F.hx * 2, F.hy * 2))
      part(K, cbox(F, 0, 0, F.hx * 2, 0.9), 'pond')
      return true
    },
  },
  { id: 'mall', slots: ['axis'], cult: [W], wide: 1.8, build: (K, s) => (pave(K, cbox(s.F!, 0, 0, s.F!.hx * 2, s.F!.hy * 2)), true) },
]

// —————————————————————— 园边 ——————————————————————

const EDGE: El[] = [
  {
    id: 'allee',
    slots: ['edge'],
    cult: [W],
    skel: ['axial', 'field'],
    min: 28,
    depth: 7,
    build: (K, s) => {
      // 林荫道：两行树夹着的一圈园路
      const q = ringOf(K, s, 2.4)
      const w = ringOf(K, s, 5)
      if (q.length < 3 || w.length < 3) return false
      walk(K, [...w, w[0]], 2.4)
      ringRows(K, q, 6.5, 2.3)
      ringRows(K, ringOf(K, s, 7.6), 6.5, 2.3)
      return true
    },
  },
  {
    id: 'hedge',
    slots: ['edge'],
    cult: [W],
    skel: ['axial'],
    depth: 3.5,
    build: (K, s) => (ringRows(K, ringOf(K, s, 1.6), 3, 1, true), true),
  },
  {
    id: 'cypressRing',
    slots: ['edge'],
    cult: [I, W],
    skel: ['axial', 'field'],
    w: 1,
    depth: 4,
    build: (K, s) => (ringRows(K, ringOf(K, s, 2.2), 4, 1), true),
  },
  {
    id: 'ringwalk',
    slots: ['edge'],
    cult: [W],
    skel: ['axial', 'field'],
    depth: 7,
    build: (K, s) => {
      // 绕园一圈园路，内侧一圈行道树
      const q = ringOf(K, s, 2.5)
      if (q.length < 3) return false
      walk(K, [...q, q[0]], 2.4)
      ringRows(K, ringOf(K, s, 5.6), 8, 2.4)
      return true
    },
  },
  {
    id: 'belt',
    slots: ['edge'],
    cult: [W],
    skel: ['natural', 'field', 'procession'],
    build: (K) => {
      // 林带：沿园边，按方位留出几处望远的缺口
      const c = centroid(K.g)
      const ph = K.C.nth.h('belt.phase') * 6.28
      scatter(K, K.inner, 0.03, 2.4, 4.4, (p) => edgeDist(p, K.g) < 9 && dmath.sin(dmath.atan2(p[1] - c[1], p[0] - c[0]) * 3 + ph) < 0.55)
      return true
    },
  },
  {
    id: 'bambooWall',
    slots: ['edge'],
    cult: [E, J],
    skel: ['natural', 'field'],
    build: (K) => {
      // 墙根竹：沿长边几丛
      for (const [a, b] of sides(K, 12).slice(0, 4)) for (let t = 0.15; t < 0.9; t += 0.25) clump(K, lerpP(a, b, t), 3, 5, 0.9, 1.3)
      return true
    },
  },
  {
    id: 'gallery',
    slots: ['edge'],
    cult: [E],
    skel: ['natural'],
    min: 16,
    build: (K) => {
      // 游廊：沿墙一两段细长的廊，廊外墙根几丛竹
      const ss = sides(K, 20)
      let made = 0
      for (const [a, b] of ss.slice(0, K.C.nth.int('gallery.n', 1, 2))) {
        const L = dist(a, b)
        const d = unit(sub(b, a))
        const inw = perp(d)
        const sg = pointInPoly(add(add(a, d, L / 2), inw, 2), K.g) ? 1 : -1
        const F: RectFrame = { o: a, f: d, l: [inw[0] * sg, inw[1] * sg], hx: 0, hy: 0 }
        if (bld(K, box(F, L * K.C.nth.num('gallery.a', 0.1, 0.3), L * K.C.nth.num('gallery.b', 0.65, 0.9), 0.2, 2.6), 'hall')) made++
      }
      for (const [a, b] of ss.slice(0, 3)) for (let t = 0.15; t < 0.9; t += 0.3) clump(K, lerpP(a, b, t), 3, 4, 0.9, 1.3)
      return made > 0
    },
  },
  {
    id: 'mixedwood',
    slots: ['edge'],
    cult: [J, E],
    skel: ['natural', 'field', 'procession'],
    build: (K) => (scatter(K, K.inner, 0.022, 1.6, 3, (p) => edgeDist(p, K.g) < 8), true),
  },
  {
    id: 'sacredwood',
    slots: ['edge'],
    cult: [J],
    skel: ['procession', 'field'],
    build: (K) => (scatter(K, K.inner, 0.032, 2.4, 4.4), true),
  },
  { id: 'edge-none', slots: ['edge'], w: 0.5, build: ok },
]

/** 园墙内侧的边（长于 min 米），按长短排 */
function sides(K: Garden, min: number): [P, P][] {
  const q = insetConvex(K.g, 1.8)
  return q
    .map((a, i) => [a, q[(i + 1) % q.length]] as [P, P])
    .filter(([a, b]) => dist(a, b) > min)
    .sort((x, y) => dist(y[0], y[1]) - dist(x[0], x[1]))
}

// —————————————————————— 园心与轴端 ——————————————————————

const CENTRE: El[] = [
  {
    id: 'basin',
    slots: ['centre', 'hub'],
    cult: [W, I],
    build: (K, s) => {
      const r = clamp(s.s * 0.55, 3.5, 9)
      if (s.t === 'hub') round(K, s.p, r + 2)
      part(K, circlePoly(s.p, r, 28), 'pond')
      landmark(K, s.p, 'fountain')
      s.r = s.t === 'hub' ? r + 2 : r
      return seat(K, s.p)
    },
  },
  {
    id: 'octPool',
    slots: ['centre', 'hub'],
    cult: [I, W],
    w: 0.8,
    build: (K, s) => {
      // 八角池与喷泉，池边一圈铺地（奥斯曼的 şadırvan、游憩园的园心）；成片园里池北一座凉亭
      const r = clamp(s.s * 0.5, 3.5, 7.5)
      const F = frameAt(s.p, K.f)
      round(K, s.p, r + 3.5, 8)
      part(K, ngon(F, s.p, r, 8), 'pond')
      landmark(K, s.p, 'fountain')
      s.r = r + 3
      if (s.t === 'hub') {
        const n = northward(K)
        const kp = add(s.p, n, r + 8)
        if (kiosk(K, kp, 8, 'civic', 8)) K.seat = kp
      }
      return seat(K, s.p)
    },
  },
  {
    id: 'poolKiosk',
    slots: ['centre'],
    cult: [I],
    min: 5,
    build: (K, s) => {
      // 池中亭（kushk）：方池当中一座凉亭
      const sp = Math.min(s.s * 2, 18)
      if (kiosk(K, s.p, sp * 0.42, 'civic', 4, true, s.F!.f)) K.seat = s.p
      part(K, cbox(s.F!, local(s.F!, s.p)[0], local(s.F!, s.p)[1], sp, sp), 'pond')
      s.r = sp / 2
      return true
    },
  },
  {
    id: 'tomb',
    slots: ['centre'],
    cult: [I],
    min: 8,
    build: (K, s) => {
      // 陵园（胡马雍陵式）：台基上的陵，四角小亭
      const sp = Math.min(s.s * 2, 18)
      const half = sp * 0.85
      const F = frameAt(s.p, s.F!.f)
      if (!inside(cbox(F, 0, 0, half * 2, half * 2), K.inner)) return false
      pave(K, cbox(F, 0, 0, half * 2, half * 2))
      if (!kiosk(K, s.p, sp * 1.05, 'temple', 4, false, F.f)) return false
      K.seat = s.p
      for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) kiosk(K, at(F, x * (half - 1.6), y * (half - 1.6)), 2.4, 'pagoda', 4, false, F.f)
      s.r = half
      return true
    },
  },
  {
    id: 'bandstand',
    slots: ['centre', 'hub'],
    cult: [W],
    build: (K, s) => {
      const r = clamp(s.s * 0.6, 6, 11)
      round(K, s.p, r)
      if (!kiosk(K, s.p, 7, 'civic', 8)) return false
      K.seat = s.p
      s.r = r
      return true
    },
  },
  {
    id: 'statueRound',
    slots: ['centre', 'hub'],
    cult: [W],
    w: 0.7,
    build: (K, s) => {
      const r = clamp(s.s * 0.45, 4, 8)
      round(K, s.p, r)
      landmark(K, s.p, 'statue')
      s.r = r
      return seat(K, s.p)
    },
  },
]

/** 园地的北向（按园地的长短轴取最朝北的一个） */

/** 轴端：s.p 在花坛区的尽头，s.d 朝外（往园边），可用进深 s.room、半宽 s.s */
const END: El[] = [
  {
    id: 'orangery',
    slots: ['axisEnd'],
    cult: [W],
    min: 14,
    depth: 11,
    build: (K, s) => {
      // 橘园：轴端横着的一长溜暖房
      const q = cbox(frameAt(s.p, s.d), 6, 0, 7, Math.min(s.s * 2 * 0.62, 40))
      return bld(K, q, 'civic') && seat(K, centroid(q))
    },
  },
  {
    id: 'belvedere',
    slots: ['axisEnd'],
    cult: [W],
    min: 6,
    depth: 10,
    build: (K, s) => {
      // 观景亭：轴端一座圆形小神殿，前面一圈铺地
      const p = add(s.p, s.d, 5)
      round(K, p, 5.5, 16)
      return kiosk(K, p, 6.5, 'temple', 8) && seat(K, p)
    },
  },
  {
    id: 'exedra',
    slots: ['axisEnd'],
    cult: [W],
    min: 9,
    depth: 9,
    build: (K, s) => {
      // 半圆的绿廊（exedra）：一弯修剪的树围着一尊雕像
      const c = add(s.p, s.d, 1.5)
      const a0 = dmath.atan2(s.d[1], s.d[0])
      for (let k = 0; k <= 8; k++) {
        const a = a0 - Math.PI / 2 + (k / 8) * Math.PI
        tree(K, add(c, [dmath.cos(a), dmath.sin(a)], 6.5), 1.2, true)
      }
      pave(K, circlePoly(c, 5, 16))
      return landmark(K, add(c, s.d, 2), 'statue')
    },
  },
  { id: 'endStatue', slots: ['axisEnd'], cult: [W, I], depth: 2, build: (K, s) => landmark(K, add(s.p, s.d, 1), 'statue') },
  {
    id: 'kushk',
    slots: ['axisEnd'],
    cult: [I],
    min: 5,
    depth: 10,
    build: (K, s) => {
      // 凉亭（kushk）：轴端横着一座开敞的亭，面朝全园
      const q = cbox(frameAt(s.p, s.d), 5, 0, 8, clamp(s.s * 0.9, 8, 22))
      return bld(K, q, 'civic') && seat(K, centroid(q))
    },
  },
  {
    id: 'endPool',
    slots: ['axisEnd'],
    cult: [I, W],
    w: 0.8,
    depth: 7,
    build: (K, s) => {
      const p = add(s.p, s.d, 3.5)
      part(K, circlePoly(p, 3, 16), 'pond')
      return landmark(K, p, 'fountain')
    },
  },
  {
    id: 'gatehouse',
    slots: ['axisEnd'],
    cult: [W, I],
    w: 0.7,
    min: 5,
    depth: 5,
    build: (K, s) => bld(K, cbox(frameAt(s.p, s.d), 2.5, 0, 3.5, 7), 'hall'),
  },
  { id: 'end-none', slots: ['axisEnd'], w: 0.4, build: ok },
]

/** 沿轴两侧（s.line 是半条轴，s.s 是轴的半宽） */
const ALONG: El[] = [
  { id: 'limeRows', slots: ['along'], cult: [W], build: (K, s) => (pairRows(K, s, s.s + 2, 6.5, 2.3), true) },
  {
    id: 'doubleRows',
    slots: ['along'],
    cult: [W],
    min: 3,
    build: (K, s) => {
      pairRows(K, s, s.s + 2, 6.5, 2.3)
      pairRows(K, s, s.s + 7.5, 6.5, 2.3)
      return true
    },
  },
  { id: 'cypressRows', slots: ['along'], cult: [I, W], build: (K, s) => (pairRows(K, s, s.s + 0.9, 4.5, 1), true) },
  { id: 'cypressPlane', slots: ['along'], cult: [I], build: (K, s) => (pairRows(K, s, s.s + 1.2, 4.5, (k) => (k % 2 ? 2.4 : 1)), true) },
  { id: 'topiary', slots: ['along'], cult: [W], build: (K, s) => (pairRows(K, s, s.s + 1.2, 5, 0.9), true) },
  { id: 'statuePairs', slots: ['along'], cult: [W], w: 0.7, build: (K, s) => pairs(K, s, s.s + 0.8, 14) },
  { id: 'along-none', slots: ['along'], w: 0.5, build: ok },
]

// —————————————————————— 花坛格（规则式，四块或多块对称） ——————————————————————

/** s.F 是格子的标架，s.q 是切好的轮廓（让出园心的圆场） */
const bedMid = (q: Poly) => q.map((p, k): P => lerpP(p, q[(k + 1) % q.length], 0.5))
const small = (s: Spot) => Math.min(s.F!.hx, s.F!.hy)
const COMPART: El[] = [
  {
    id: 'cutBeds',
    slots: ['compartment'],
    cult: [W],
    pave: true,
    build: (K, s) => {
      part(K, s.q!, 'bed')
      if (small(s) > 3) part(K, circlePoly(s.F!.o, small(s) * 0.45, 16), 'bed')
      for (const p of box(s.F!, -s.F!.hx, s.F!.hx, -s.F!.hy, s.F!.hy)) if (pointInPoly(p, s.q!) || edgeDist(p, s.q!) < 0.5) tree(K, add(p, unit(sub(p, s.F!.o)), 1.1), 0.9, true)
      return true
    },
  },
  {
    id: 'broderie',
    slots: ['compartment'],
    cult: [W],
    pave: true,
    build: (K, s) => {
      // 刺绣花坛：坛心菱形，中间一株修剪的小树
      part(K, s.q!, 'bed')
      if (small(s) > 3) {
        part(K, insetConvex(bedMid(box(s.F!, -s.F!.hx, s.F!.hx, -s.F!.hy, s.F!.hy)), 1.2), 'bed')
        tree(K, s.F!.o, 0.9, true)
      }
      return true
    },
  },
  {
    id: 'nested',
    slots: ['compartment'],
    cult: [W],
    pave: true,
    build: (K, s) => {
      // 回字形套坛
      part(K, s.q!, 'bed')
      if (small(s) > 4) part(K, insetConvex(s.q!, 2.2), 'bed')
      if (small(s) > 8) part(K, insetConvex(s.q!, 4.4), 'bed')
      return true
    },
  },
  {
    id: 'splitBeds',
    slots: ['compartment'],
    cult: [W, I],
    pave: true,
    min: 4,
    build: (K, s) => {
      // 一格再分四块（伊斯兰的四分之四分）
      const F = s.F!
      const g = 0.8
      for (const x of [-1, 1]) for (const y of [-1, 1]) part(K, box(F, x < 0 ? -F.hx : g, x < 0 ? -g : F.hx, y < 0 ? -F.hy : g, y < 0 ? -g : F.hy), 'bed')
      if (K.cult === 'islamic') tree(K, F.o, 1.6, true)
      else landmark(K, F.o, 'statue')
      return true
    },
  },
  {
    id: 'orchardGrid',
    slots: ['compartment'],
    cult: [I, W],
    pave: true,
    build: (K, s) => {
      // 下沉的果园：成行的果树
      part(K, s.q!, 'bed')
      const F = s.F!
      const step = K.cult === 'islamic' ? 4.6 : 5.5
      for (let x = -F.hx + 2.2; x < F.hx - 1.6; x += step) for (let y = -F.hy + 2.2; y < F.hy - 1.6; y += step) if (pointInPoly(at(F, x, y), s.q!)) tree(K, at(F, x, y), 1.8, true)
      return true
    },
  },
  {
    id: 'basins',
    slots: ['compartment'],
    cult: [I],
    pave: true,
    min: 6,
    build: (K, s) => {
      // 坛心一方小池，周围一圈果树
      part(K, s.q!, 'bed')
      const F = s.F!
      const r = clamp(small(s) * 0.28, 1.8, 4)
      part(K, cbox(F, 0, 0, r * 2, r * 2), 'pond')
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        tree(K, add(F.o, [dmath.cos(a), dmath.sin(a)], r + 3), 1.8, true)
      }
      return true
    },
  },
  {
    id: 'flowerRows',
    slots: ['compartment'],
    cult: [I, W],
    w: 0.6,
    pave: true,
    min: 4,
    build: (K, s) => {
      // 一畦畦的花：顺长边的窄坛
      const F = s.F!
      const n = Math.max(2, Math.floor((F.hy * 2) / 3))
      const h = (F.hy * 2) / n
      for (let i = 0; i < n; i++) part(K, box(F, -F.hx, F.hx, -F.hy + i * h + 0.4, -F.hy + (i + 1) * h - 0.4), 'bed')
      return true
    },
  },
  {
    id: 'lawnRound',
    slots: ['compartment'],
    cult: [W],
    build: (K, s) => {
      // 草坪当中一座圆花坛
      const q = circlePoly(s.F!.o, clamp(small(s) * 0.45, 2, 4.5), 16)
      part(K, q, 'bed')
      K.bare.push(q)
      return true
    },
  },
  { id: 'lawnSpecimen', slots: ['compartment'], cult: [W], build: (K, s) => (tree(K, s.F!.o, clamp(small(s) * 0.5, 2.4, 4.5)), true) },
  {
    id: 'bosquet',
    slots: ['compartment'],
    cult: [W],
    min: 9,
    build: (K, s) => {
      // 小林（bosquet）：格里密植的树，当中一方林间空地与雕像
      const F = s.F!
      const clear = circlePoly(F.o, Math.min(4, small(s) * 0.35), 12)
      pave(K, clear)
      landmark(K, F.o, 'statue')
      scatter(K, insetConvex(s.q!, 1.2), 0.08, 1.4, 2.2)
      return true
    },
  },
  {
    id: 'maze',
    slots: ['compartment', 'corner'],
    cult: [W],
    min: 9,
    build: (K, s) => {
      // 迷园：一圈套一圈的绿篱，每圈在不同的边上留口
      const F = s.F ?? frameAt(s.p, K.f, 9, 9)
      const R = Math.min(F.hx, F.hy, 16)
      const q0 = cbox(F, 0, 0, R * 2, R * 2)
      if (!inside(q0, K.inner) || K.ponds.some((w) => touch(w, q0))) return false
      K.bare.push(q0)
      for (let r = R, k = 0; r > 2; r -= 2.2, k++) {
        const g = (k * 5 + 1) % 4
        for (let e = 0; e < 4; e++) {
          const a = at(F, r * [-1, 1, 1, -1][e], r * [-1, -1, 1, 1][e])
          const b = at(F, r * [1, 1, -1, -1][e], r * [-1, 1, 1, 1][e])
          const d = unit(sub(b, a))
          const n = perp(d)
          const L = dist(a, b)
          const segs: [number, number][] = e === g ? [[0, L / 2 - 1], [L / 2 + 1, L]] : [[0, L]]
          for (const [t0, t1] of segs) part(K, [add(add(a, d, t0), n, -0.4), add(add(a, d, t1), n, -0.4), add(add(a, d, t1), n, 0.4), add(add(a, d, t0), n, 0.4)], 'bed')
        }
      }
      return true
    },
  },
]

// —————————————————————— 自然式：水、岛、渡 ——————————————————————

/** s.p 是池心的目标位置，s.s 是园地的半宽 */
const WATER: El[] = [
  {
    id: 'lake',
    slots: ['water'],
    cult: [W, E, J],
    build: (K, s) => {
      // 东亚的园林以水为心（池占园子的三分之一上下），西式风景园的湖只是草地里的一景
      const big = K.cult !== 'western'
      const c = local(K, s.p)
      const wob = K.C.nth.num('lake.wob', 1.2, 1.9)
      const kx = K.C.nth.num('lake.kx', big ? 0.48 : 0.4, big ? 0.62 : 0.56)
      const ky = K.C.nth.num('lake.ky', big ? 0.4 : 0.32, big ? 0.54 : 0.46)
      const ph = K.C.nth.h('lake.phase') * 6.28
      const q = fitShape(K, (f) => blob(K, c[0] * f, c[1] * f, K.hx * kx * f, K.hy * ky * f, ph, wob, 40), clamp(s.s * (big ? 0.12 : 0.2), 4, 14))
      return !!q && setLake(K, q)
    },
  },
  {
    id: 'serpentine',
    slots: ['water'],
    cult: [W, E],
    min: 22,
    build: (K, s) => {
      // 蛇形湖：顺长轴弯两弯，宽窄不一
      const c = local(K, s.p)
      const amp = K.C.nth.num('serpentine.amp', 0.12, 0.25) * K.hy
      const w0 = K.C.nth.num('serpentine.w', 0.18, 0.28) * K.hy
      const ph = K.C.nth.h('serpentine.phase') * 6.28
      const q = fitShape(
        K,
        (f) => {
          const L: P[] = []
          const R: P[] = []
          for (let i = 0; i <= 14; i++) {
            const t = i / 14
            const x = c[0] * f + (t - 0.5) * K.hx * 1.3 * f
            const y = c[1] * f + dmath.sin(t * Math.PI * 1.6 + ph) * amp * f
            const w = w0 * f * (0.55 + 0.45 * dmath.sin(t * Math.PI)) * (1 + 0.25 * dmath.sin(t * 9 + ph))
            L.push(at(K, x, y - w))
            R.push(at(K, x, y + w))
          }
          return chaikin([...L, ...R.reverse()], 2, true)
        },
        8,
      )
      return !!q && setLake(K, q)
    },
  },
  {
    id: 'twin',
    slots: ['water'],
    cult: [E, J],
    min: 18,
    build: (K, s) => {
      // 葫芦形的池：当中收腰（桥多架在腰上）
      const c = local(K, s.p)
      const rx = K.hx * K.C.nth.num('twin.rx', 0.5, 0.64)
      const ry = K.hy * K.C.nth.num('twin.ry', 0.4, 0.54)
      const ph = K.C.nth.h('twin.phase') * 6.28
      const waist = K.C.nth.num('twin.waist', 0.35, 0.55)
      const q = fitShape(
        K,
        (f) => {
          const out: Poly = []
          for (let i = 0; i < 44; i++) {
            const t = (i / 44) * Math.PI * 2
            const k = 1 + 0.12 * dmath.sin(3 * t + ph) + 0.06 * dmath.cos(5 * t - ph)
            out.push(at(K, c[0] * f + dmath.cos(t) * rx * f * k, c[1] * f + dmath.sin(t) * ry * f * k * (waist + (1 - waist) * dmath.pow(Math.abs(dmath.cos(t)), 0.7))))
          }
          return out
        },
        5,
      )
      return !!q && setLake(K, q)
    },
  },
  {
    id: 'pondlet',
    slots: ['water'],
    cult: [E, J],
    w: 0.5,
    build: (K, s) => {
      // 小池（小园子里的一方曲池）
      const c = local(K, s.p)
      const r = s.s * K.C.nth.num('pondlet.r', 0.3, 0.42)
      const ph = K.C.nth.h('pondlet.phase') * 6.28
      const q = fitShape(K, (f) => blob(K, c[0] * f, c[1] * f, r * 1.3 * f, r * f, ph, 1.8, 30), 5)
      return !!q && setLake(K, q)
    },
  },
  { id: 'water-none', slots: ['water'], cult: [W], w: 0.3, build: ok },
]
function setLake(K: Garden, q: Poly) {
  part(K, q, 'pond')
  K.lake = q
  return true
}

/** s.q 是岛，s.s 是岛的半径 */
const ISLAND: El[] = [
  {
    id: 'islePalace',
    slots: ['island'],
    cult: [E],
    min: 5,
    tiers: ['grand'],
    build: (K, s) => {
      // 岛上的宫（离宫、湖心的水殿）：铺地的台，正殿居中，两座配亭，台边一圈柳
      const c = centroid(s.q!)
      const F = frameAt(c, K.f)
      const r = s.s
      const hall = cbox(F, 0, 0, clamp(r * 1.0, 7, 16), clamp(r * 0.62, 5, 10))
      if (!bld(K, hall, 'temple', true, { role: '水殿' })) return false
      pave(K, cbox(F, 0, 0, clamp(r * 1.35, 9, 20), clamp(r * 0.95, 7, 14)))
      for (const x of [-1, 1]) kiosk(K, at(F, x * clamp(r * 0.8, 6, 12), clamp(r * 0.45, 3.5, 7)), clamp(r * 0.3, 2.6, 4.5), 'pagoda', 4, true)
      for (let k = 0; k < 10; k++) tree(K, shore(s.q!, (k / 10) * 6.28, -1.5), 1.6, true)
      K.seat = c
      return true
    },
  },
  { id: 'isleClump', slots: ['island'], cult: [W, E], build: (K, s) => (clump(K, centroid(s.q!), s.s * 0.6, 4, 1.8, 2.6), true) },
  {
    id: 'isleFolly',
    slots: ['island'],
    cult: [W],
    min: 3.5,
    build: (K, s) => {
      const c = centroid(s.q!)
      if (!kiosk(K, c, clamp(s.s * 0.8, 3, 6), 'temple', 8, true)) return false
      clump(K, c, s.s * 0.8, 3, 1.4, 2)
      return true
    },
  },
  {
    id: 'islePine',
    slots: ['island'],
    cult: [J],
    build: (K, s) => {
      // 鹤岛、龟岛：岛上一棵松，岸边一块石
      tree(K, centroid(s.q!), 2.2)
      rock(K, shore(s.q!, K.C.nth.h('islePine.rock') * 6.28, -0.3), 0.7)
      return true
    },
  },
  { id: 'isleRocks', slots: ['island'], cult: [J, E], w: 0.7, build: (K, s) => rocks(K, centroid(s.q!), s.s * 0.5, 4, 0.5, 1.1) > 0 },
  {
    id: 'islePavilion',
    slots: ['island'],
    cult: [E, J],
    min: 3,
    build: (K, s) => {
      const c = centroid(s.q!)
      if (!kiosk(K, c, clamp(s.s * 0.5, 3.2, 7), 'pagoda', K.cult === 'eastern' ? 8 : 4, true)) return false
      K.seat ??= c
      clump(K, c, s.s * 0.8, 4, 1.4, 2.2)
      return true
    },
  },
  {
    id: 'isleLantern',
    slots: ['island'],
    cult: [J],
    w: 0.6,
    build: (K, s) => {
      landmark(K, centroid(s.q!), 'statue')
      tree(K, shore(s.q!, K.C.nth.h('isleLantern.tree') * 6.28, -1.2), 1.6)
      return true
    },
  },
]

/** s.q 是主池 */
const CROSS: El[] = [
  {
    id: 'zigzag',
    slots: ['crossing'],
    cult: [E, J],
    build: (K, s) => {
      // 九曲桥：横过池面，折几折
      const l = narrowest(K, s.q!, 8)
      if (!l) return false
      const [a, b] = l
      const d = unit(sub(b, a))
      const n = perp(d)
      const segs = 5
      const zig: P[] = []
      for (let i = 0; i <= segs; i++) zig.push(add(lerpP(a, b, i / segs), n, i === 0 || i === segs ? 0 : i % 2 ? 2 : -2))
      walk(K, zig, 1.5)
      return true
    },
  },
  {
    id: 'arched',
    slots: ['crossing'],
    build: (K, s) => {
      // 拱桥：最窄处一跨
      const l = narrowest(K, s.q!)
      if (!l) return false
      walk(K, l, 2)
      return true
    },
  },
  {
    id: 'stepping',
    slots: ['crossing'],
    cult: [J],
    build: (K, s) => {
      // 泽渡（汀步）：一溜踏石
      const l = narrowest(K, s.q!)
      if (!l || dist(l[0], l[1]) > 30) return false
      const [a, b] = l
      const n = Math.round(dist(a, b) / 1.9)
      const side = perp(unit(sub(b, a)))
      for (let k = 1; k < n; k++) rock(K, add(lerpP(a, b, k / n), side, (k % 2 ? 0.5 : -0.5) * (K.rng.next() + 0.5)), 0.65)
      return true
    },
  },
  {
    id: 'causeway',
    slots: ['crossing'],
    cult: [E, W],
    min: 14,
    build: (K, s) => {
      // 长堤：顺着长轴横过湖面，堤上夹岸种柳
      const q = s.q!
      const lc = centroid(q)
      const Lf: RectFrame = { ...K, o: lc }
      const L0 = reach(q, lc, neg(K.f))
      const L1 = reach(q, lc, K.f)
      const y = K.C.nth.num('causeway.y', -0.2, 0.2) * K.hy * 0.4
      const dike = box(Lf, -L0 - 1, L1 + 1, y - 3.5, y + 3.5)
      // 堤两边都得留出像样的水面
      const m = at(Lf, 0, y)
      if (K.isles.some((z) => touch(z, dike)) || reach(q, m, K.l) < 9 || reach(q, m, neg(K.l)) < 9) return false
      part(K, dike, 'isle')
      walk(K, [at(Lf, -L0 - 3, y), at(Lf, L1 + 3, y)], 2.4)
      for (const g of [-1, 1]) row(K, at(Lf, -L0 + 2, y + g * 2.4), at(Lf, L1 - 2, y + g * 2.4), 6, 1.9, true)
      return true
    },
  },
  {
    id: 'isleBridge',
    slots: ['crossing'],
    build: (K, s) => {
      // 从岛渡到最近的岸
      if (!K.isles.length) return false
      let made = 0
      for (const z of K.isles.slice(0, 2)) {
        const ic = centroid(z)
        let best: P = K.l
        for (const d of [K.f, K.l, neg(K.f), neg(K.l)] as P[]) if (reach(s.q!, ic, d) < reach(s.q!, ic, best)) best = d
        const b = add(ic, best, reach(s.q!, ic, best) + 2.5)
        if (!pointInPoly(b, K.inner) || K.isles.some((o) => o !== z && crosses(ic, b, o, 1))) continue
        walk(K, [add(ic, best, 1), b], 1.4)
        made++
      }
      return made > 0
    },
  },
  { id: 'crossing-none', slots: ['crossing'], w: 0.4, build: ok },
]

// —————————————————————— 自然式：厅、景点、园角 ——————————————————————

/** s.p 在池北，s.d 朝池（往南） */
const HALL: El[] = [
  {
    id: 'goten',
    slots: ['hall'],
    cult: [J],
    tiers: ['grand'],
    build: (K, s) => {
      // 离宫的御殿：古书院、中书院、新御殿雁行错开（桂离宫），各自前面一溜缘侧，一旁月见台
      const F = frameAt(s.p, perp(s.d))
      const w = clamp(s.s * 0.1, 7, 12)
      let made = 0
      for (let k = 0; k < 4; k++) {
        const q = cbox(F, (k - 1.5) * w * 1.05, k * 3.2, w * 1.15, 8)
        if (bld(K, q, 'hall', false, { role: '御殿' })) {
          made++
          K.solid.push(q)
          K.seat ??= centroid(q)
        }
      }
      if (made) pave(K, cbox(F, -w * 1.6, -5.6, w * 1.2, 1.6))
      return made >= 2
    },
  },
  {
    id: 'mainHall',
    slots: ['hall'],
    cult: [E],
    build: (K, s) => {
      // 主厅：坐北朝南，前面临水一方月台
      const F = frameAt(s.p, perp(s.d))
      const hw = clamp(s.s * 0.18, 6, 12)
      for (const k of [0, 2, 4, -2]) {
        const q = cbox(F, 0, k, hw * 2, 7)
        if (!bld(K, q, 'hall')) continue
        K.seat = centroid(q)
        K.solid.push(q)
        pave(K, cbox(F, 0, k - 5.5, hw * 1.2, 4))
        return true
      }
      return false
    },
  },
  {
    id: 'shoin',
    slots: ['hall'],
    cult: [J],
    build: (K, s) => {
      // 书院：雁行错开的两栋，前面一溜缘侧的石板
      const F = frameAt(s.p, perp(s.d))
      const hw = clamp(s.s * 0.14, 5, 9)
      for (const k of [0, 2, 4]) {
        const a = cbox(F, -hw * 0.45, k, hw * 1.1, 6.5)
        const b = cbox(F, hw * 0.55, k + 3, hw * 0.9, 5.5)
        if (!bld(K, a, 'hall')) continue
        bld(K, b, 'hall')
        K.seat = centroid(a)
        K.solid.push(a)
        pave(K, cbox(F, -hw * 0.45, k - 4.2, hw * 1.1, 1.4))
        return true
      }
      return false
    },
  },
  {
    id: 'manor',
    slots: ['hall'],
    cult: [W],
    min: 30,
    build: (K, s) => {
      // 庄园主宅：面朝湖，宅前一片铺地
      const F = frameAt(s.p, perp(s.d))
      for (const k of [2, 5, 8]) {
        const q = cbox(F, 0, k, 22, 11)
        if (!bld(K, q, 'hall')) continue
        K.seat = centroid(q)
        K.solid.push(q)
        pave(K, cbox(F, 0, k - 8, 16, 5))
        return true
      }
      return false
    },
  },
  { id: 'hall-none', slots: ['hall'], w: 0.5, build: ok },
]

/** 池岸的景点：s.p 在岸线上，s.d 朝外（离开水） */
const SHORE: El[] = [
  { id: 'shuixie', slots: ['shore'], cult: [E], build: (K, s) => kiosk(K, add(s.p, s.d, 0.8), 6, 'hall', 4, true, s.d) },
  { id: 'ting', slots: ['shore', 'node'], cult: [E], build: (K, s) => kiosk(K, add(s.p, s.d, 3.5), 4.5, 'pagoda', K.C.nth.chance('ting.hex', 0.3) ? 6 : 4, false, s.d) },
  {
    id: 'teahouse',
    slots: ['shore', 'node'],
    cult: [J],
    build: (K, s) => {
      // 茶屋：旁边一盏灯笼、一块踏石
      const p = add(s.p, s.d, 5.5)
      if (!kiosk(K, p, 6, 'hall', 4, false, s.d)) return false
      landmark(K, add(add(p, s.d, -4.5), perp(s.d), 2.5), 'statue')
      return true
    },
  },
  { id: 'azumaya', slots: ['shore', 'node'], cult: [J], build: (K, s) => kiosk(K, add(s.p, s.d, 4), 3.8, 'pagoda', 4, false, s.d) },
  { id: 'boathouse', slots: ['shore'], cult: [W], w: 0.7, build: (K, s) => bld(K, cbox(frameAt(s.p, s.d), 0, 0, 7, 4), 'shed', true) },
  { id: 'follyShore', slots: ['shore'], cult: [W], build: (K, s) => kiosk(K, add(s.p, s.d, 7), 6.5, 'temple', 8) },
  {
    id: 'willows',
    slots: ['shore'],
    cult: [W, E, J],
    build: (K, s) => {
      const n = perp(s.d)
      for (const k of [-1, 0, 1]) tree(K, add(add(s.p, s.d, 2.5), n, k * 4), 2.3)
      return true
    },
  },
  {
    id: 'revetment',
    slots: ['shore'],
    cult: [J, E],
    build: (K, s) => {
      // 护岸石组：一大两小
      const n = perp(s.d)
      rock(K, add(s.p, s.d, 0.4), 1.2)
      rock(K, add(add(s.p, s.d, 0.2), n, 2), 0.7)
      rock(K, add(add(s.p, s.d, 0.6), n, -1.9), 0.6)
      return true
    },
  },
  {
    id: 'yukimi',
    slots: ['shore'],
    cult: [J],
    build: (K, s) => {
      // 雪见灯笼：探向水面，脚下一块石
      rock(K, add(s.p, s.d, 0.3), 0.8)
      return landmark(K, add(s.p, s.d, 1.8), 'statue')
    },
  },
  {
    id: 'platform',
    slots: ['shore'],
    cult: [E, J],
    w: 0.7,
    build: (K, s) => {
      // 临水的石台（钓台、观鱼台）
      const q = cbox(frameAt(s.p, s.d), 0.5, 0, 4, 5)
      if (K.ctx.occ.overlaps(q)) return false
      pave(K, q)
      return true
    },
  },
]

/** 园路上的景点：s.p 在园路边，s.d 离开水 */
const NODE: El[] = [
  { id: 'gazebo', slots: ['node'], cult: [W], build: (K, s) => kiosk(K, add(s.p, s.d, 4), 5, 'civic', 8) },
  { id: 'statueNode', slots: ['node'], cult: [W], build: (K, s) => landmark(K, add(s.p, s.d, 2), 'statue') },
  { id: 'lanternNode', slots: ['node'], cult: [J], build: (K, s) => landmark(K, add(s.p, s.d, 1.8), 'statue') },
  { id: 'rockGroup', slots: ['node'], cult: [E, J], build: (K, s) => rocks(K, add(s.p, s.d, 3.5), 2.2, 3, 0.6, 1.3) > 0 },
  { id: 'specimen', slots: ['node'], build: (K, s) => tree(K, add(s.p, s.d, 5), K.cult === 'western' ? 4.5 : 3.2) },
  { id: 'wellNode', slots: ['node'], cult: [W, E], w: 0.4, build: (K, s) => landmark(K, add(s.p, s.d, 2.2), 'well') },
  { id: 'stele', slots: ['node'], cult: [E], w: 0.6, build: (K, s) => kiosk(K, add(s.p, s.d, 3), 2.6, 'pagoda', 4, false, s.d) },
]

/** 园角：s.p 在离池最远的角上，s.d 朝池 */
const CORNER: El[] = [
  {
    id: 'rockery',
    slots: ['corner'],
    cult: [E],
    build: (K, s) => {
      // 叠石假山，山顶一座小亭
      pavilion(K, s.p, 3.5)
      return rocks(K, s.p, 6, 10, 0.9, 2) > 3
    },
  },
  {
    id: 'study',
    slots: ['corner'],
    cult: [E],
    min: 12,
    build: (K, s) => {
      // 书斋小院：院墙里一座书斋、铺地的小院、一棵树
      const cs = clamp(s.s * 0.38, 12, 22)
      for (const k of [0.3, 0.6, 1]) {
        const cc = add(s.p, s.d, cs * k)
        const F = frameAt(cc, K.f)
        const court = cbox(F, 0, 0, cs, cs * 0.8)
        if (!inside(court, K.inner) || K.ponds.some((q) => touch(court, q)) || K.walks.some((w) => pointInPoly(w.a, court))) continue
        if (!bld(K, cbox(F, 0, cs * 0.25, cs * 0.7, cs * 0.26), 'hall')) continue
        wall(K, court)
        pave(K, cbox(F, 0, -cs * 0.12, cs - 1.2, cs * 0.5))
        tree(K, add(cc, K.l, -cs * 0.12), 2, true)
        K.solid.push(court)
        return true
      }
      return false
    },
  },
  { id: 'pagodaTower', slots: ['corner'], cult: [E], build: (K, s) => kiosk(K, s.p, 8, 'pagoda', 8) && seat(K, s.p) },
  {
    id: 'tsukiyama',
    slots: ['corner'],
    cult: [J],
    build: (K, s) => {
      // 筑山：树丛与石
      rocks(K, s.p, 4, 4, 0.7, 1.4)
      clump(K, s.p, 6, 6, 1.8, 2.8)
      return true
    },
  },
  {
    id: 'follyMound',
    slots: ['corner'],
    cult: [W],
    build: (K, s) => {
      if (!kiosk(K, s.p, 6.5, 'temple', 8)) return false
      clump(K, add(s.p, s.d, -6), 6, 6, 2.2, 3.4)
      return true
    },
  },
  {
    id: 'grotto',
    slots: ['corner'],
    cult: [W],
    w: 0.7,
    build: (K, s) => {
      rocks(K, s.p, 4, 6, 0.8, 1.6)
      clump(K, add(s.p, s.d, -4), 5, 5, 2, 3)
      return true
    },
  },
  {
    id: 'smallShrine',
    slots: ['corner'],
    cult: [J, E],
    w: 0.6,
    build: (K, s) => {
      // 园里的小祠：祠前一座鸟居（和风）或一对石灯
      const F = frameAt(s.p, s.d)
      if (!bld(K, cbox(F, 0, 0, 3, 3.6), 'temple', false, { role: K.cult === 'wa' ? '祠' : '小庙' })) return false
      if (K.cult === 'wa') bld(K, cbox(F, 4.5, 0, 0.7, 3.6), 'torii')
      else for (const y of [-1.8, 1.8]) landmark(K, at(F, 3.5, y), 'statue')
      return true
    },
  },
  { id: 'cornerClump', slots: ['corner'], build: (K, s) => (clump(K, s.p, 7, 7, 2, 3.4), true) },
]

/** 沿岸一圈：s.q 是池 */
const SHORELINE: El[] = [
  {
    id: 'willowRing',
    slots: ['shoreline'],
    cult: [W, E, J],
    build: (K, s) => {
      const n = Math.round(Math.sqrt(area(s.q!)) * 0.45)
      const ph = K.C.nth.h('willowRing.phase') * 6.28
      for (let k = 0; k < n; k++) tree(K, shore(s.q!, ph + (k / n) * Math.PI * 2, 2.8), 2.1)
      return true
    },
  },
  {
    id: 'rockShore',
    slots: ['shoreline'],
    cult: [J, E],
    build: (K, s) => {
      // 护岸石组，一处三块
      const lr = Math.sqrt(area(s.q!) / Math.PI)
      const n = clamp(Math.round(lr * 0.3), 3, 8)
      const ph = K.C.nth.h('rockShore.phase') * 6.28
      for (let k = 0; k < n; k++) {
        const a = ph + (k / n) * 6.28 + K.rng.next() * 0.5
        for (let j = 0; j < 3; j++) rock(K, shore(s.q!, a + j * 0.07, 0.2 + K.rng.next() * 0.8), 0.5 + K.rng.next() * (j ? 0.5 : 0.9))
      }
      return true
    },
  },
  {
    id: 'pineShore',
    slots: ['shoreline'],
    cult: [J],
    build: (K, s) => {
      // 洲浜：岸边几棵斜探的松，松下一两块石
      const ph = K.C.nth.h('pineShore.phase') * 6.28
      for (let k = 0; k < 6; k++) {
        tree(K, shore(s.q!, ph + k * 1.05, 2), 1.9)
        if (k % 2) rock(K, shore(s.q!, ph + k * 1.05 + 0.2, 0.3), 0.7)
      }
      return true
    },
  },
  { id: 'shoreline-none', slots: ['shoreline'], w: 0.4, build: ok },
]

// —————————————————————— 草地与成片的地 ——————————————————————

const LAWN: El[] = [
  {
    id: 'clumps',
    slots: ['lawn'],
    cult: [W, I],
    build: (K) => {
      // 草地上的树丛与孤植树
      const zone = insetConvex(K.g, 8)
      if (zone.length < 3) return false
      const n = clamp(Math.round(K.A / 2200), 2, 9)
      const rng = K.rng
      for (let k = 0, made = 0; k < n * 6 && made < n; k++) {
        const p: P = [K.o[0] + (rng.next() - 0.5) * K.hx * 2, K.o[1] + (rng.next() - 0.5) * K.hx * 2]
        if (!pointInPoly(p, zone) || K.ponds.some((q) => pointInPoly(p, q) || edgeDist(p, q) < 6)) continue
        if (rng.next() < 0.35) tree(K, p, 4.5 + rng.next() * 1.5)
        else clump(K, p, 5 + rng.next() * 4, 4 + Math.floor(rng.next() * 4), 2.4, 3.8)
        made++
      }
      return true
    },
  },
  // 规则园外的小林（bosquet）：花坛区四周一圈密林，林里几条直的林间路
  { id: 'bosquets', slots: ['lawn'], cult: [W], skel: ['axial'], w: 1.2, build: (K) => (scatter(K, K.inner, 0.022, 2, 3.4), true) },
  { id: 'sparse', slots: ['lawn'], build: (K) => (scatter(K, K.inner, 0.006, 2.2, 4), true) },
  { id: 'pines', slots: ['lawn'], cult: [J, E], build: (K) => (scatter(K, K.inner, 0.009, 1.6, 3), true) },
  {
    id: 'planes',
    slots: ['lawn'],
    cult: [I, W],
    build: (K) => {
      // 遮荫的大树（悬铃木）
      const n = clamp(Math.round(K.A / 800), 3, 12)
      for (let k = 0, made = 0; k < n * 6 && made < n; k++) if (tree(K, at(K, (K.rng.next() - 0.5) * K.hx * 1.8, (K.rng.next() - 0.5) * K.hy * 1.8), 5 + K.rng.next() * 1.5)) made++
      return true
    },
  },
]

const FIELD: El[] = [
  {
    id: 'huntwood',
    slots: ['field'],
    cult: [W, E],
    tiers: ['grand'],
    build: (K) => {
      // 猎苑的林：大片的密林，几片林间空地（鹿吃草的地方），骑道从林里直穿
      const glades: [P, number][] = []
      for (let k = 0; k < 3; k++) glades.push([at(K, K.C.nth.num('huntwood.x', -0.6, 0.6) * K.hx, K.C.nth.num('huntwood.y', -0.6, 0.6) * K.hy), Math.min(K.hx, K.hy) * K.C.nth.num('huntwood.r', 0.15, 0.28)])
      scatter(K, K.inner, 0.022, 2.4, 4.2, (p) => glades.every(([c, r]) => dist(p, c) > r))
      return true
    },
  },
  {
    id: 'plumGrid',
    slots: ['field'],
    cult: [E, J],
    build: (K) => {
      // 梅林：疏朗的格点，稍有错落
      const step = 6.5
      const ang = K.C.nth.num('plumGrid.angle', 0, Math.PI / 2)
      const a: P = [dmath.cos(ang), dmath.sin(ang)]
      const b = perp(a)
      const R = Math.max(K.hx, K.hy)
      for (let i = -R; i <= R; i += step) for (let j = -R; j <= R; j += step) tree(K, [K.o[0] + a[0] * i + b[0] * j + (K.rng.next() - 0.5) * 2, K.o[1] + a[1] * i + b[1] * j + (K.rng.next() - 0.5) * 2], 1.5 + K.rng.next() * 0.6)
      return true
    },
  },
  {
    id: 'bamboo',
    slots: ['field'],
    cult: [E, J],
    w: 0.7,
    build: (K) => {
      // 竹丛：成簇的细竹，簇与簇之间留出空地
      const n = Math.round(K.A / 280)
      for (let k = 0; k < n; k++) clump(K, at(K, (K.rng.next() - 0.5) * K.hx * 2, (K.rng.next() - 0.5) * K.hy * 2), 4, 9, 1.1, 1.7)
      return true
    },
  },
  {
    id: 'pineWood',
    slots: ['field'],
    cult: [E, J],
    build: (K) => {
      scatter(K, K.inner, 0.012, 2.2, 3.4)
      rocks(K, at(K, K.C.nth.num('pineWood.x', -0.3, 0.3) * K.hx, K.C.nth.num('pineWood.y', -0.3, 0.3) * K.hy), 4, 5, 0.8, 1.6)
      return true
    },
  },
  {
    id: 'cherry',
    slots: ['field'],
    cult: [J, E],
    build: (K) => {
      // 樱林：一团团的樱树，团与团之间是赏花的空地
      const n = clamp(Math.round(K.A / 500), 3, 20)
      for (let k = 0; k < n; k++) clump(K, at(K, (K.rng.next() - 0.5) * K.hx * 1.8, (K.rng.next() - 0.5) * K.hy * 1.8), 6, 6, 1.8, 2.6)
      return true
    },
  },
  { id: 'maple', slots: ['field'], cult: [J], build: (K) => (scatter(K, K.inner, 0.016, 1.5, 2.6), true) },
  {
    id: 'orchard',
    slots: ['field'],
    cult: [I, W, E],
    build: (K) => {
      // 果园：顺园地长轴的方格
      const step = 5
      for (let x = -K.hx; x <= K.hx; x += step) for (let y = -K.hy; y <= K.hy; y += step) tree(K, at(K, x, y), 1.8)
      return true
    },
  },
  {
    id: 'planeShade',
    slots: ['field'],
    cult: [I, W],
    build: (K) => {
      const n = clamp(Math.round(K.A / 700), 4, 14)
      for (let k = 0, made = 0; k < n * 6 && made < n; k++) if (tree(K, at(K, (K.rng.next() - 0.5) * K.hx * 1.8, (K.rng.next() - 0.5) * K.hy * 1.8), 5 + K.rng.next() * 1.5)) made++
      return true
    },
  },
  {
    id: 'meadow',
    slots: ['field'],
    cult: [W],
    build: (K) => {
      // 草地上几棵孤植的大树（橡树、椴树）
      const n = clamp(Math.round(K.A / 900), 3, 9)
      for (let k = 0, made = 0; k < n * 6 && made < n; k++) if (tree(K, at(K, (K.rng.next() - 0.5) * K.hx * 2, (K.rng.next() - 0.5) * K.hy * 2), 4 + K.rng.next() * 1.8)) made++
      return true
    },
  },
  {
    id: 'moss',
    slots: ['field'],
    cult: [J],
    w: 0.6,
    build: (K) => {
      // 苔庭：一片片的苔地，枫与石散在其间
      const n = clamp(Math.round(K.A / 350), 3, 16)
      for (let k = 0; k < n; k++) {
        const p = at(K, (K.rng.next() - 0.5) * K.hx * 1.7, (K.rng.next() - 0.5) * K.hy * 1.7)
        const r = 2.5 + K.rng.next() * 3
        const q = blob(frameAt(p, K.f), 0, 0, r * 1.3, r, K.rng.next() * 6.28, 1.3, 16)
        if (inside(q, K.inner) && !K.walks.some((w) => segDist(p, w.a, w.b).d < r * 1.4 + w.hw) && !K.ctx.occ.overlaps(q)) part(K, q, 'isle')
      }
      scatter(K, K.inner, 0.01, 1.5, 2.6)
      rocks(K, K.o, Math.min(K.hx, K.hy) * 0.6, 4, 0.5, 1)
      return true
    },
  },
  {
    id: 'rosebeds',
    slots: ['field'],
    cult: [I, W],
    build: (K) => {
      // 玫瑰园（golestan）：成行的小花坛，行间种几棵果树
      const zone = insetConvex(K.g, 5)
      if (zone.length < 3) return false
      const F = frameAt(K.o, K.f)
      let n = 0
      for (let x = -K.hx; x <= K.hx; x += 7)
        for (let y = -K.hy; y <= K.hy; y += 5.5) {
          const q = cbox(F, x, y, 5, 3.2)
          if (!inside(q, zone) || K.ponds.some((w) => touch(w, q)) || K.bare.some((w) => touch(w, q)) || K.ctx.occ.overlaps(q)) continue
          if (K.walks.some((w) => segDist(at(F, x, y), w.a, w.b).d < w.hw + 3)) continue
          part(K, q, 'bed')
          K.bare.push(q)
          n++
        }
      scatter(K, K.inner, 0.004, 2, 3)
      return n > 3
    },
  },
  {
    id: 'raked',
    slots: ['field'],
    cult: [J],
    solo: true,
    min: 8,
    build: (K) => karesansui(K),
  },
]

/**
 * 枯山水（龙安寺、大仙院式）：方丈前一方耙纹白砂，石组三五成群（七五三），土塀根一溜修剪的灌木与几棵树，
 * 园角一两片苔地；园地比方丈院大时，院外是苔庭与园路。
 */
function karesansui(K: Garden): boolean {
  const R0 = rectIn(K, 1.5, 16)
  if (!R0) return false
  // 方丈院不过五十来米见方（龙安寺的石庭只有 25 × 10 米）
  const R: RectFrame = { ...R0, hx: Math.min(R0.hx, K.C.nth.num('karesansui.hx', 18, 28)), hy: Math.min(R0.hy, K.C.nth.num('karesansui.hy', 12, 18)) }
  const V = K.C.nth
  const rng = K.rng
  const precinct = box(R, -R.hx, R.hx, -R.hy, R.hy)
  wall(K, precinct)
  K.bare.push(precinct)
  K.solid.push(precinct)
  // 方丈在北侧的长边
  const n = northward(R)
  const dot = n[0] * R.l[0] + n[1] * R.l[1]
  const sy = Math.abs(dot) > 0.7 ? Math.sign(dot) : V.side('karesansui.side')
  const hd = clamp(R.hy * 0.28, 6, 14)
  const hl = Math.min(R.hx * 2 * 0.72, 40)
  const hall = cbox(R, 0, sy * (R.hy - 1 - hd / 2), hl, hd)
  if (bld(K, hall, 'hall')) K.seat = centroid(hall)
  pave(K, cbox(R, 0, sy * (R.hy - 1 - hd - 1), hl * 0.9, 1.6))
  // 白砂：耙纹顺长边（或竖纹）
  const g0 = -R.hy + 2.2
  const g1 = R.hy - hd - 4
  const gx = R.hx - 2.2
  if (g1 - g0 < 6) return true
  const gy = (g0 + g1) / 2
  const gravel = cbox(R, 0, sy * gy, gx * 2, g1 - g0)
  part(K, gravel, 'gravel', dmath.atan2(R.f[1], R.f[0]) + (V.chance('karesansui.rake', 0.25) ? Math.PI / 2 : 0))
  // 石组：七五三（沿长边错落）、群岛（大小不一的几处）、或一座"蓬莱"大石组
  const style = V.pick('karesansui.style', ['753', 'isles', 'horai'] as const, [3, 2, 1])
  note(K, 'field', `stones-${style}`)
  if (style === 'horai') {
    const p = at(R, V.num('karesansui.horai', -0.3, 0.3) * gx, sy * gy)
    rock(K, p, 2.2)
    rocks(K, p, 4.5, 6, 0.6, 1.4)
  } else {
    const shift = Math.floor(V.h('karesansui.groups') * 7)
    const groups = style === '753' ? clamp(Math.round((gx * 2 * (g1 - g0)) / 160), 3, 7) : clamp(Math.round((gx * 2 * (g1 - g0)) / 110), 4, 9)
    for (let i = 0; i < groups; i++) {
      const x = -gx + ((i + 0.5) / groups) * gx * 2 + (rng.next() - 0.5) * 4
      const y = sy * (gy + (style === '753' ? (i % 2 ? 1 : -1) * (g1 - g0) * 0.18 : (rng.next() - 0.5) * (g1 - g0) * 0.6))
      const p = at(R, x, y)
      const cnt = [3, 2, 1, 2, 3, 1, 2][(i + shift) % 7]
      rock(K, p, 1.2 + rng.next() * 0.7)
      for (let k = 1; k < cnt; k++) rock(K, add(p, unit([rng.next() - 0.5, rng.next() - 0.5]), 2.2 + rng.next() * 0.8), 0.6 + rng.next() * 0.4)
    }
  }
  // 苔地：白砂的一角
  for (const g of [-1, 1]) if (V.chance('karesansui.moss', 0.55)) part(K, blob(R, g * (gx - 3.2), sy * (g0 + 2.6), 3.4, 2.2, V.h('karesansui.mossShape') * 6, 0.8, 16), 'isle')
  // 土塀根：修剪的灌木与几棵树
  row(K, at(R, -R.hx + 1.5, -sy * (R.hy - 1)), at(R, R.hx - 1.5, -sy * (R.hy - 1)), 3.2, 1, true)
  for (const g of [-1, 1]) tree(K, at(R, g * (R.hx - 1.8), sy * (R.hy - hd - 2)), 2.2, true)
  // 园地比方丈院大：院外是苔庭，绕院一条园路，石与枫、松
  if (K.A > area(precinct) * 1.8) {
    const path = loop(K, 4, 2.5, 1.4)
    if (path) for (const gt of gates(K).slice(0, 2)) spur(K, gt.p, path, 1.4)
    for (let k = 0; k < 3; k++) rocks(K, offWater(K, at(K, V.num('karesansui.rockX', -0.4, 0.4) * K.hx, V.num('karesansui.rockY', -0.4, 0.4) * K.hy), 3), 2.5, 3, 0.5, 1.1)
    scatter(K, K.inner, 0.016, 1.6, 3.2)
  } else scatter(K, K.inner, 0.01, 2, 3.6)
  return true
}

/** 成片园当中的节点：s.p，回写 s.r（园路停在这个半径上） */
const HUB: El[] = [
  {
    id: 'lodge',
    slots: ['hub'],
    cult: [W, E],
    tiers: ['grand'],
    build: (K, s) => {
      // 猎苑当中的狩猎行宫：一座主楼、一排马厩围着前院
      const F = frameAt(s.p, K.f)
      const main = cbox(F, 0, 4, 22, 11)
      if (!bld(K, main, 'large', false, { role: '狩猎行宫', units: 0, floors: 2 })) return false
      bld(K, cbox(F, 0, -9, 18, 5), 'shed', false, { role: '马厩' })
      pave(K, cbox(F, 0, -2.5, 16, 7))
      s.r = 14
      return seat(K, s.p)
    },
  },
  { id: 'pavilionHub', slots: ['hub'], cult: [E, J], build: (K, s) => pavilion(K, s.p, 5) && seat(K, s.p) },
  { id: 'wellHub', slots: ['hub'], cult: [W, E], w: 0.8, build: (K, s) => landmark(K, s.p, 'well') && seat(K, s.p) },
  {
    id: 'marketCross',
    slots: ['hub'],
    cult: [W],
    build: (K, s) => {
      round(K, s.p, 3.5, 12)
      s.r = 3
      return landmark(K, s.p, 'statue') && seat(K, s.p)
    },
  },
  {
    id: 'lanternHub',
    slots: ['hub'],
    cult: [J],
    build: (K, s) => {
      rocks(K, add(s.p, K.f, 2.5), 1.8, 2, 0.6, 1.1)
      return landmark(K, s.p, 'statue') && seat(K, s.p)
    },
  },
  { id: 'kushkHub', slots: ['hub'], cult: [I], build: (K, s) => kiosk(K, s.p, 8, 'civic', 8) && seat(K, s.p) },
  {
    id: 'hauz',
    slots: ['hub'],
    cult: [I],
    min: 6,
    build: (K, s) => {
      // 长方的水池（hauz），池边铺地，池的一头一座凉亭照影
      const F = frameAt(s.p, K.f)
      const L = clamp(s.s * 1.1, 8, 20)
      const q = cbox(F, 0, 0, L + 5, L * 0.5 + 5)
      if (!inside(q, K.inner)) return false
      pave(K, q)
      part(K, cbox(F, 0, 0, L, L * 0.5), 'pond')
      const kp = at(F, L / 2 + 6.5, 0)
      if (kiosk(K, kp, 7, 'civic', 4, false, F.f)) K.seat = kp
      s.r = L * 0.25 + 2.5
      return seat(K, s.p)
    },
  },
]

/** 成片园的园路：s.p 是节点，s.r 是节点的半径 */
const PATHS: El[] = [
  {
    id: 'star',
    slots: ['paths'],
    build: (K, s) => {
      // 从各园门通到节点（踩出来的小路）
      const gs = gates(K).slice(0, K.C.nth.int('star.n', 2, 4))
      for (const gt of gs) {
        const d = unit(sub(gt.p, s.p))
        const end = add(s.p, d, Math.max(0, (s.r ?? 0) - 0.5))
        const mid = offWater(K, add(lerpP(gt.p, end, 0.5), perp(d), (K.rng.next() - 0.5) * 6), 2)
        walk(K, dry(K, [gt.p, mid, end]), K.cult === 'western' ? 1.8 : 1.6, true)
      }
      return gs.length > 0
    },
  },
  {
    id: 'meander',
    slots: ['paths'],
    cult: [E, J, W, I],
    build: (K) => {
      // 曲径：两座园门之间，摆几摆
      const gs = gates(K)
      if (gs.length < 2) return false
      const a = gs[0].p
      const b = gs[1].p
      const d = unit(perp(sub(b, a)))
      const ph = K.C.nth.h('meander.phase') * 6
      const pts: P[] = []
      for (let i = 0; i <= 6; i++) pts.push(offWater(K, add(lerpP(a, b, i / 6), d, i === 0 || i === 6 ? 0 : dmath.sin((i / 6) * Math.PI * 2 + ph) * Math.min(K.hy, 14) * 0.5), 2))
      walk(K, dry(K, pts), 1.6, true)
      return true
    },
  },
  {
    id: 'crossPaths',
    slots: ['paths'],
    cult: [W, I],
    build: (K, s) => {
      // 十字路：从节点顺园地的长短轴直通园边
      for (const d of [K.f, neg(K.f), K.l, neg(K.l)] as P[]) {
        const L = reach(K.inner, s.p, d)
        if (Number.isFinite(L) && L > (s.r ?? 0) + 3) walk(K, dry(K, [add(s.p, d, s.r ?? 0), add(s.p, d, L)]), 2)
      }
      return true
    },
  },
  {
    id: 'ringPath',
    slots: ['paths'],
    cult: [W, J, E, I],
    w: 0.7,
    build: (K) => {
      const l = loop(K, 5, 2.5, 1.6)
      if (!l) return false
      for (const gt of gates(K).slice(0, 2)) spur(K, gt.p, l, 1.6)
      return true
    },
  },
  { id: 'paths-none', slots: ['paths'], cult: [J, E], w: 0.3, build: ok },
]

/** 成片园角上的小池 */
const POND: El[] = [
  {
    id: 'duckPond',
    slots: ['pond'],
    cult: [W],
    build: (K) => {
      const r = Math.min(13, K.hy * 0.4)
      if (r < 4.5) return false
      // 位置、岸形抽一次（逐级缩小时不变）
      const [x, y, ph, ta] = [K.C.nth.num('duckPond.x', -0.4, 0.4), K.C.nth.num('duckPond.y', -0.3, 0.3), K.C.nth.h('duckPond.phase'), K.C.nth.h('duckPond.trees')]
      const q = fitShape(K, (f) => blob(K, x * K.hx * f, y * K.hy * f, r * 1.2 * f, r * f, ph * 6.28, 1.1, 24), 4)
      if (!q) return false
      part(K, q, 'pond')
      for (let k = 0; k < 3; k++) tree(K, shore(q, ta * 6.28 + k * 2.1, 2.2), 2.8)
      return true
    },
  },
  {
    id: 'cornerPond',
    slots: ['pond'],
    cult: [E, J, I],
    min: 12,
    build: (K) => {
      // 园角一方小池，池岸几块石（伊斯兰：园角一方水池）
      const sq = K.cult === 'islamic'
      const [sx, sy, ph] = [K.C.nth.side('cornerPond.x'), K.C.nth.side('cornerPond.y'), K.C.nth.h('cornerPond.phase')]
      const q = fitShape(K, (f) => (sq ? cbox(K, sx * K.hx * 0.5 * f, sy * K.hy * 0.4 * f, 10 * f, 7 * f) : blob(K, sx * K.hx * 0.45 * f, sy * K.hy * 0.35 * f, 7 * f, 5.5 * f, ph * 6.28, 1.4, 22)), 3)
      if (!q) return false
      part(K, q, 'pond')
      if (!sq) for (let k = 0; k < 5; k++) rock(K, shore(q, k * 1.3, 0.2), 0.7 + K.rng.next() * 0.6)
      return true
    },
  },
  { id: 'pond-none', slots: ['pond'], w: 0.8, build: ok },
]

// —————————————————————— 序列式：参道 ——————————————————————

/** 参道口、中途的门：s.p 在参道上，s.d 顺参道，s.s 是参道两旁可用的半宽 */
const GATE: El[] = [
  { id: 'torii', slots: ['entry', 'marker'], cult: [J], build: (K, s) => bld(K, cbox(frameAt(s.p, s.d), 0, 0, 0.9, Math.min(5.5, s.s * 1.6)), 'torii') },
  {
    id: 'paifang',
    slots: ['entry', 'marker'],
    cult: [E],
    build: (K, s) => {
      // 牌坊：宽而薄，前面一对石狮
      if (!bld(K, cbox(frameAt(s.p, s.d), 0, 0, 1.2, Math.min(9, s.s * 2)), 'civic')) return false
      for (const y of [-2.6, 2.6]) landmark(K, at(frameAt(s.p, s.d), -2, y), 'statue')
      return true
    },
  },
  { id: 'archGate', slots: ['entry'], cult: [W], build: (K, s) => bld(K, cbox(frameAt(s.p, s.d), 0, 0, 2.6, Math.min(8, s.s * 1.8)), 'civic') },
  { id: 'portal', slots: ['entry', 'marker'], cult: [I], build: (K, s) => bld(K, cbox(frameAt(s.p, s.d), 0, 0, 4, Math.min(9, s.s * 2)), 'hall') },
  { id: 'lychgate', slots: ['entry'], cult: [W], w: 0.5, build: (K, s) => bld(K, cbox(frameAt(s.p, s.d), 0, 0, 3, 4.5), 'hall') },
  { id: 'marker-none', slots: ['marker'], w: 0.8, build: ok },
]

/** 参道两旁：s.line 是参道，s.s 是参道半宽 */
const FLANK: El[] = [
  { id: 'lanternPairs', slots: ['flank'], cult: [J], build: (K, s) => pairs(K, s, s.s + 1.2, 9, 9) },
  { id: 'stoneBeasts', slots: ['flank'], cult: [E], build: (K, s) => pairs(K, s, s.s + 1.4, 7, 8) },
  { id: 'cedarRows', slots: ['flank'], cult: [J, E], build: (K, s) => (pairRows(K, s, s.s + 3, 6, 2.4, false), true) },
  {
    id: 'toriiTunnel',
    slots: ['flank'],
    cult: [J],
    w: 0.5,
    build: (K, s) => {
      // 千本鸟居：参道上一座挨一座
      const [a, b] = s.line!
      const d = unit(sub(b, a))
      let made = 0
      for (let x = 6; x < dist(a, b) - 4; x += 2.6) if (bld(K, cbox(frameAt(add(a, d, x), d), 0, 0, 0.6, s.s * 2 + 1.4), 'torii')) made++
      return made > 3
    },
  },
  { id: 'obeliskPairs', slots: ['flank'], cult: [W], build: (K, s) => pairs(K, s, s.s + 1.5, 12, 8) },
  { id: 'avenue', slots: ['flank'], cult: [W], build: (K, s) => (pairRows(K, s, s.s + 3, 7, 2.6, false), true) },
  { id: 'cypressFlank', slots: ['flank'], cult: [I, W], build: (K, s) => (pairRows(K, s, s.s + 1.5, 4, 1, false), true) },
]

/** 参道尽头：s.F 是前庭（o 在前庭的前沿中点，u 顺参道，hx 进深，hy 半宽） */
const TERMINAL: El[] = [
  {
    id: 'shrine',
    slots: ['terminal'],
    cult: [J],
    build: (K, s) => {
      // 社：白砂的社地，拜殿在前、本殿在后，手水舍，本殿后一棵神木
      const F = s.F!
      const hw = Math.min(F.hy * 1.1, 13)
      pave(K, box(F, 0, F.hx, -F.hy, F.hy))
      if (!bld(K, cbox(F, F.hx * 0.35, 0, Math.min(F.hx * 0.3, 9), hw), 'hall')) return false
      const honden = cbox(F, F.hx * 0.74, 0, Math.min(F.hx * 0.22, 6.5), hw * 0.55)
      bld(K, honden, 'temple')
      bld(K, cbox(F, 3.5, F.hy - 3, 3, 2.4), 'shed')
      mark(K.ctx, centroid(honden), 'shrine')
      tree(K, at(F, F.hx, F.hy + 4), 5.5)
      K.seat = centroid(honden)
      return true
    },
  },
  {
    id: 'ancestral',
    slots: ['terminal'],
    cult: [E],
    build: (K, s) => {
      // 祠堂：铺地的院子，正殿在后，两厢对峙
      const F = s.F!
      pave(K, box(F, 0, F.hx, -F.hy, F.hy))
      const hall = cbox(F, F.hx * 0.78, 0, Math.min(F.hx * 0.3, 10), Math.min(F.hy * 1.4, 18))
      if (!bld(K, hall, 'temple')) return false
      if (F.hy > 8) for (const y of [-1, 1]) bld(K, cbox(F, F.hx * 0.42, y * (F.hy - 3), F.hx * 0.4, 4.5), 'hall')
      mark(K.ctx, centroid(hall), 'shrine')
      K.seat = centroid(hall)
      return true
    },
  },
  {
    id: 'tumulus',
    slots: ['terminal'],
    cult: [E],
    w: 0.7,
    min: 8,
    build: (K, s) => {
      // 陵：享殿在前，后面一座围着墙的圆形坟丘（宝城）
      const F = s.F!
      const r = Math.min(F.hy * 0.9, F.hx * 0.32, 14)
      const c = at(F, F.hx - r - 1.5, 0)
      const mound = circlePoly(c, r, 28)
      if (!inside(mound, K.inner) || K.ctx.occ.overlaps(mound)) return false
      pave(K, box(F, 0, F.hx - r * 2 - 2, -F.hy * 0.7, F.hy * 0.7))
      const hall = cbox(F, (F.hx - r * 2 - 2) * 0.55, 0, Math.min(F.hx * 0.2, 8), Math.min(F.hy * 1.2, 14))
      if (!bld(K, hall, 'temple')) return false
      part(K, mound, 'isle')
      wall(K, circlePoly(c, r + 0.8, 28))
      K.solid.push(mound)
      scatter(K, mound, 0.03, 1.6, 2.4)
      mark(K.ctx, centroid(hall), 'shrine')
      K.seat = centroid(hall)
      return true
    },
  },
  {
    id: 'mausoleum',
    slots: ['terminal'],
    cult: [W],
    build: (K, s) => {
      // 纪念堂：一圈铺地当中一座圆顶的小殿
      const F = s.F!
      const r = Math.min(F.hy, F.hx * 0.45, 12)
      const c = at(F, F.hx * 0.55, 0)
      round(K, c, r)
      if (!kiosk(K, c, r * 1.1, 'temple', 8, false, F.f)) return false
      K.seat = c
      return true
    },
  },
  {
    id: 'chapel',
    slots: ['terminal'],
    cult: [W],
    build: (K, s) => {
      const F = s.F!
      pave(K, box(F, 0, F.hx * 0.3, -F.hy * 0.6, F.hy * 0.6))
      const q = cbox(F, F.hx * 0.62, 0, Math.min(F.hx * 0.6, 18), Math.min(F.hy, 8))
      if (!bld(K, q, 'temple')) return false
      K.seat = centroid(q)
      return true
    },
  },
  {
    id: 'monument',
    slots: ['terminal'],
    cult: [W, I],
    w: 0.7,
    build: (K, s) => {
      // 纪念柱：圆场当中一尊雕像，周围一圈树
      const F = s.F!
      const r = Math.min(F.hy, F.hx * 0.45, 10)
      const c = at(F, F.hx * 0.5, 0)
      round(K, c, r)
      landmark(K, c, 'statue')
      for (let k = 0; k < 12; k++) tree(K, add(c, [dmath.cos((k / 12) * 6.28), dmath.sin((k / 12) * 6.28)], r + 2.5), 1.8)
      return seat(K, c)
    },
  },
  {
    id: 'turbe',
    slots: ['terminal'],
    cult: [I],
    build: (K, s) => {
      // 陵（türbe）：铺地的院子当中一座方陵，四角柏树
      const F = s.F!
      const sz = Math.min(F.hy * 1.1, F.hx * 0.5, 14)
      const c = at(F, F.hx * 0.55, 0)
      pave(K, cbox(F, F.hx * 0.55, 0, sz + 8, sz + 8))
      if (!kiosk(K, c, sz, 'temple', 4, false, F.f)) return false
      for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) tree(K, at(frameAt(c, F.f), x * (sz / 2 + 2.5), y * (sz / 2 + 2.5)), 1.1, true)
      K.seat = c
      return true
    },
  },
]

export const POOL: El[] = [
  ...LAYOUT,
  ...AXIS,
  ...EDGE,
  ...CENTRE,
  ...END,
  ...ALONG,
  ...COMPART,
  ...WATER,
  ...ISLAND,
  ...CROSS,
  ...HALL,
  ...SHORE,
  ...NODE,
  ...CORNER,
  ...SHORELINE,
  ...LAWN,
  ...FIELD,
  ...HUB,
  ...PATHS,
  ...POND,
  ...GATE,
  ...FLANK,
  ...TERMINAL,
]

/**
 * 预设的偏好表：按元素给（元素 id → 倍数），摊到这个元素能放的每一种槽位上，得到组合式预设的 bias[槽位][元素]。
 * 提到不存在的元素直接报错（写错了名字就静默失效的偏好最难查）
 */
export function bySlot(flat: Record<string, number>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const [id, w] of Object.entries(flat)) {
    const e = POOL.find((x) => x.id === id)
    if (!e) throw new Error(`garden preset: unknown element '${id}'`)
    for (const s of e.slots) (out[s] ??= {})[id] = w
  }
  return out
}

export { nearShore, pavilion }
