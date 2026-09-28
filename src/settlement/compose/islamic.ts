import { circlePoly, type P, type Poly } from '../geom'
import type { BuildingKind } from '../types'
import type { Composer, Elem, Preset } from './core'

/**
 * 清真寺的平面语法（局部坐标：a 沿礼拜朝向，从入口 -D/2 到礼拜墙 D/2；s 横向 -W/2 ~ W/2）：
 * 礼拜殿（柱厅：一整片 / 垂直礼拜墙的一道道廊 / 平行礼拜墙的一道道廊；T 形：中廊加宽、沿礼拜墙一道横廊）
 * + 穹顶（无 / 壁龛前一座 / 三座 / 沿礼拜墙一排）+ 庭院（三面回廊 / 两侧回廊 / 敞开）
 * + 宣礼塔（门边一角 / 入口墙正中 / 入口两侧一对 / 礼拜殿前两角一对 / 四角）+ 净水池；
 * 另有波斯式的四伊旺（庭院四面正中各一座拱厅，礼拜朝向那座后面是穹顶殿）、
 * 奥斯曼式（方殿上一座大穹顶、前后半穹顶，前院四面带小穹顶的廊）、没有庭院的街区小寺。
 * 规矩：奥斯曼式的塔在礼拜殿两角（大寺四座），T 形配正中方塔，四伊旺配入口一对塔；四塔、三穹顶只在大寺。
 */

export type MPlan = 'hypostyle' | 'tplan' | 'iwan' | 'ottoman' | 'kiosk'
export type Minaret = 'corner' | 'axial' | 'pair' | 'qibla' | 'four'
type Roof = 'single' | 'aisles' | 'transverse'
type Domes = 'none' | 'mihrab' | 'three' | 'row'
type Riwaq = 'three' | 'sides' | 'none'

const PLAN: Elem<MPlan>[] = [
  { id: 'hypostyle', w: 3 },
  { id: 'tplan', w: 1.5 },
  { id: 'iwan', w: 1.2, min: 44 },
  { id: 'ottoman', w: 1.2, min: 40 },
  { id: 'kiosk', w: 1.5 },
]
const MINARET: Elem<Minaret>[] = [
  { id: 'corner', w: 3 },
  { id: 'axial', w: 2 },
  { id: 'pair', w: 1.2 },
  { id: 'qibla', w: 1 },
  { id: 'four', w: 0.7, rank: 1 },
]
const ROOF: Elem<Roof>[] = [
  { id: 'single', w: 2 },
  { id: 'aisles', w: 2 },
  { id: 'transverse', w: 1.2 },
]
const DOMES: Elem<Domes>[] = [
  { id: 'mihrab', w: 3 },
  { id: 'none', w: 1 },
  { id: 'three', w: 1, rank: 1 },
  { id: 'row', w: 0.8 },
]
const RIWAQ: Elem<Riwaq>[] = [
  { id: 'three', w: 3 },
  { id: 'sides', w: 1.2 },
  { id: 'none', w: 0.8 },
]

/** 以前的几种形制，现在是预设：倭马亚（大马士革）、科尔多瓦、马格里布（凯鲁万、库图比亚）、波斯、奥斯曼 */
export const MOSQUE_PRESETS = (big: boolean): Preset[] => [
  { id: 'umayyad', w: 2, bias: { plan: { hypostyle: 6 }, roof: { transverse: 5 }, domes: { mihrab: 3 }, minaret: { corner: 2, four: 2 } } },
  { id: 'cordoba', w: 1.5, bias: { plan: { hypostyle: 6 }, roof: { aisles: 6 }, minaret: { axial: 4 } } },
  { id: 'maghreb', w: 1.5, bias: { plan: { tplan: 8 } } },
  { id: 'persian', w: big ? 1.5 : 0.4, bias: { plan: { iwan: 8 } } },
  { id: 'ottoman', w: big ? 1.5 : 0.8, bias: { plan: { ottoman: 8 } } },
]

export interface MosqueForm {
  plan: MPlan
  minaret: Minaret
  roof: Roof
  domes: Domes
  riwaq: Riwaq
  /** 柱厅的开间数（横向的廊数） */
  bays: number
  /** 门边那座塔在哪一侧（±1） */
  side: number
  fountain: boolean
}

/** 按语法抽一座清真寺的构成（规矩见文件头） */
export function mosqueForm(C: Composer, big: boolean): MosqueForm {
  const plan = C.pick('plan', PLAN, { only: (p) => (p !== 'kiosk' || !big) && (big || p !== 'iwan') })
  const minaret = C.pick('minaret', MINARET, {
    only: (m) =>
      plan === 'ottoman' ? m === 'qibla' || m === 'four' : plan === 'tplan' ? m === 'axial' : plan === 'iwan' ? m === 'pair' || m === 'corner' : plan === 'kiosk' ? m === 'corner' || m === 'axial' : m !== 'qibla',
  })
  const roof = plan === 'hypostyle' ? C.pick('roof', ROOF) : 'single'
  const domes = plan === 'hypostyle' || plan === 'tplan' ? C.pick('domes', DOMES) : 'mihrab'
  const riwaq = plan === 'hypostyle' || plan === 'tplan' ? C.pick('riwaq', RIWAQ) : plan === 'kiosk' ? 'none' : 'three'
  const bays = roof === 'aisles' || plan === 'tplan' ? C.int('bays', 3, big ? 6 : 4) * 2 + 1 : roof === 'transverse' ? C.int('rows', 2, 4) : 1
  return { plan, minaret, roof, domes, riwaq, bays, side: minaret === 'corner' ? C.side('minSide') : 1, fountain: plan !== 'kiosk' && C.chance('fountain', 0.85) }
}

/** 最朴素的一种（抽到的放不下时退回）：一整片礼拜殿、壁龛前一座穹顶、门边一座塔 */
export const plainMosque = (side: number, kiosk: boolean): MosqueForm => ({ plan: kiosk ? 'kiosk' : 'hypostyle', minaret: 'corner', roof: 'single', domes: 'mihrab', riwaq: kiosk ? 'none' : 'three', bays: 1, side, fountain: !kiosk })

/**
 * 清真寺的各部分：m 为中心、q 为礼拜朝向，D × W 为围墙范围，deep 为礼拜殿进深，arcade 为回廊进深。
 * 返回部件、庭院（sahn，没有时 null）与整座的占地。
 */
export function mosqueParts(m: P, q: P, D: number, W: number, deep: number, arcade: number, o: MosqueForm) {
  const b: P = [-q[1], q[0]]
  const at = (a: number, s: number): P => [m[0] + q[0] * a + b[0] * s, m[1] + q[1] * a + b[1] * s]
  const box = (a0: number, a1: number, s0: number, s1: number): Poly => [at(a0, s0), at(a1, s0), at(a1, s1), at(a0, s1)]
  const half = (a: number, s: number, r: number, dir: number): Poly => {
    const c = at(a, s)
    return circlePoly(c, r, 14).filter((p) => ((p[0] - c[0]) * q[0] + (p[1] - c[1]) * q[1]) * dir >= -0.01)
  }
  const kiosk = o.plan === 'kiosk'
  if (kiosk) deep = D * 0.62
  const hallA = D / 2 - deep
  const parts: [Poly, BuildingKind][] = []
  const dr = Math.min(deep * 0.3, W * 0.13)
  // 礼拜殿
  if (o.plan === 'ottoman') {
    // 方殿，一座大穹顶，前后两个半穹顶；殿前一道门廊
    const hw = Math.min(W / 2, deep * 0.62)
    parts.push([box(hallA, D / 2, -hw, hw), 'temple'])
    const R = Math.min(hw, deep / 2) * 0.72
    const ac = D / 2 - deep / 2
    parts.push([circlePoly(at(ac, 0), R, 20), 'temple'])
    parts.push([half(ac + R * 0.9, 0, R * 0.55, 1), 'temple'])
    parts.push([half(ac - R * 0.9, 0, R * 0.55, -1), 'temple'])
    parts.push([box(hallA - arcade * 0.9, hallA, -hw * 0.8, hw * 0.8), 'temple'])
  } else if (o.plan === 'iwan') {
    // 四伊旺：礼拜殿是礼拜墙前一座穹顶殿，两旁是冬季礼拜厅
    parts.push([box(hallA, D / 2, -W / 2, W / 2), 'temple'])
    const R = Math.min(deep * 0.42, W * 0.18)
    parts.push([circlePoly(at(D / 2 - deep * 0.45, 0), R, 18), 'temple'])
  } else if (o.roof === 'aisles' || o.plan === 'tplan') {
    // 一道道垂直礼拜墙的廊（T 形：中廊加宽，沿礼拜墙再一道横廊）
    const n = o.bays
    const mid = o.plan === 'tplan' ? 1.8 : 1
    const unit = W / (n - 1 + mid)
    let s = -W / 2
    const t0 = o.plan === 'tplan' ? D / 2 - Math.min(deep * 0.28, 7) : D / 2
    for (let i = 0; i < n; i++) {
      const w = i === (n - 1) / 2 ? unit * mid : unit
      parts.push([box(hallA, t0, s + 0.25, s + w - 0.25), 'temple'])
      s += w
    }
    if (o.plan === 'tplan') parts.push([box(t0 - 0.2, D / 2, -W / 2, W / 2), 'temple'])
  } else if (o.roof === 'transverse') {
    // 平行礼拜墙的几道廊（大马士革）；正中一道横穿的高廊
    const n = o.bays
    const t = deep / n
    for (let i = 0; i < n; i++) parts.push([box(hallA + i * t + 0.25, hallA + (i + 1) * t - 0.25, -W / 2, W / 2), 'temple'])
    parts.push([box(hallA, D / 2, -W * 0.08, W * 0.08), 'temple'])
  } else parts.push([box(hallA, D / 2, -W / 2, W / 2), 'temple'])
  // 穹顶
  if (o.plan !== 'ottoman' && o.plan !== 'iwan') {
    if (o.domes === 'mihrab' || o.domes === 'three') parts.push([circlePoly(at(D / 2 - deep * 0.32, 0), dr, 16), 'temple'])
    if (o.domes === 'three') for (const sd of [-1, 1]) parts.push([circlePoly(at(D / 2 - deep * 0.32, sd * W * 0.3), dr * 0.55, 12), 'temple'])
    if (o.domes === 'row') {
      const k = Math.max(3, Math.round(W / (dr * 2.6)))
      for (let i = 0; i < k; i++) parts.push([circlePoly(at(D / 2 - dr * 0.8, -W / 2 + (W * (i + 0.5)) / k), Math.min(dr * 0.6, W / k / 2.4), 12), 'temple'])
    }
  }
  // 壁龛
  parts.push([box(D / 2 - 0.2, D / 2 + Math.min(3, D * 0.05), -Math.min(3, W * 0.06), Math.min(3, W * 0.06)), 'temple'])
  // 庭院与回廊
  const rs = o.riwaq === 'none' ? 0 : arcade
  const rf = o.riwaq === 'three' ? arcade : 0
  if (!kiosk) {
    if (rf) parts.push([box(-D / 2, -D / 2 + rf, -W / 2, W / 2), 'temple'])
    if (rs) for (const sd of [-1, 1]) parts.push([box(-D / 2 + rf, hallA, sd < 0 ? -W / 2 : W / 2 - rs, sd < 0 ? -W / 2 + rs : W / 2), 'temple'])
    if (o.plan === 'iwan') {
      // 庭院四面正中的伊旺（朝礼拜方向那座最大）
      const iw = Math.min(W * 0.2, 14)
      const id = arcade * 1.6
      parts.push([box(hallA - id * 1.3, hallA + 0.5, -iw * 0.65, iw * 0.65), 'temple'])
      parts.push([box(-D / 2, -D / 2 + id, -iw / 2, iw / 2), 'temple'])
      const am = (-D / 2 + rf + hallA) / 2
      for (const sd of [-1, 1]) parts.push([box(am - iw / 2, am + iw / 2, sd * (W / 2 - id), sd * (W / 2)), 'temple'])
    }
    if (o.plan === 'ottoman') {
      // 前院回廊上一排小穹顶
      const k = Math.max(3, Math.round(W / (arcade * 2.2)))
      for (let i = 0; i < k; i++) parts.push([circlePoly(at(-D / 2 + rf / 2, -W / 2 + (W * (i + 0.5)) / k), Math.min(arcade * 0.42, W / k / 2.4), 10), 'temple'])
    }
  } else parts.push([box(hallA - 2.5, hallA + 0.3, -W * 0.3, W * 0.3), 'temple'])
  // 宣礼塔
  const mt = Math.max(4, Math.min(7.5, W * 0.12))
  const edge = W / 2 - mt / 2 + 1
  const tower = (a: number, s: number, k = 1) => parts.push([box(a, a + mt * k, s - (mt * k) / 2, s + (mt * k) / 2), 'tower'])
  const front = -D / 2 - 1.5
  if (o.minaret === 'corner') tower(front, o.side * edge)
  else if (o.minaret === 'axial') tower(front - mt * 0.2, 0, 1.2)
  else if (o.minaret === 'pair') for (const sd of [-1, 1]) tower(front, sd * (W * 0.12 + mt / 2))
  else if (o.minaret === 'qibla') {
    const hw = o.plan === 'ottoman' ? Math.min(W / 2, deep * 0.62) : W / 2
    for (const sd of [-1, 1]) tower(hallA - mt * 0.5, sd * (hw + mt * 0.4))
  } else
    for (const sd of [-1, 1]) {
      tower(front, sd * edge)
      tower(D / 2 - mt + 1.5, sd * (edge + 0.5))
    }
  const sahn = kiosk ? box(-D / 2 + 1, hallA - 2.5, -W * 0.4, W * 0.4) : box(-D / 2 + rf, hallA - (o.plan === 'ottoman' ? arcade * 0.9 : 0), -W / 2 + rs, W / 2 - rs)
  const whole = box(-D / 2 - 2 - (o.minaret === 'axial' ? mt * 0.2 : 0), D / 2 + 3.5, -W / 2 - 1 - (o.minaret === 'qibla' ? mt : 0), W / 2 + 1 + (o.minaret === 'qibla' ? mt : 0))
  return { parts, sahn, whole }
}
