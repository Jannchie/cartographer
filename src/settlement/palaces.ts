import { emitArea, cityDice, type Ctx, type Dice } from './ctx'
import { at as gat, centroid, circlePoly, insetConvex, type Frame, type P, type Poly } from './geom'
import type { BuildingKind } from './types'
import { addBuilding, addGroup, plantTree, scatterTrees } from './wards'
import { composer, flanks, rectFrame, type Composer, type Elem, type Preset } from './compose/core'
import { jin, yard, type Centre, type Yard, type Side } from './compose/chinese'
import { addWall, connectGates } from './walls'
import * as dmath from '../gen/dmath'

/**
 * 都城的宫殿（东方的紫禁城式宫城、西式的王宫），铺满宫城地盘里的整个矩形（见 generate.ts 的 palaceSite）。
 * 不再从几套写死的形制里抽一套，而是按传统的骨架从元素池里一格格抽元素拼（见 compose/core.ts）：
 * 宫城是中轴上"宫门—广庭—前朝—（中院）—内廷—后苑"一进进排下去，两旁东西路各自抽；
 * 王宫是主楼加翼楼的平面语法（U、方院、H、E、T、一字楼），再挂上门廊、角阁、附属院落、礼拜堂与园林。
 * 抽签只看种子（cityDice）：人口变了、宫城伸缩了，构成不变，只随地盘缩放。
 */

/*
 * 园林与池苑都在宫城的标架（geom 的 Frame：a 从正面往里的进深、b 横向，米）里摆；
 * 下面的 fat / fbox 只是把参数排成"横向在前、进深在后"，读起来与画图的习惯一致
 */
const fat = (F: Frame, u: number, f: number) => gat(F, f, u)
const fbox = (F: Frame, u0: number, u1: number, f0: number, f1: number): Poly => [fat(F, u0, f0), fat(F, u1, f0), fat(F, u1, f1), fat(F, u0, f1)]

// 宫里的殿宇都不是民居（不占住户名额）：只用 hall、keep、civic、temple、shed、pagoda
const put = (ctx: Ctx, poly: Poly, kind: BuildingKind) => addBuilding(ctx, poly, kind, 0.2)

/** 成行的树：沿一条线每隔 step 米一棵 */
function treeLine(ctx: Ctx, a: P, b: P, step: number, r: number) {
  const L = dmath.hypot(b[0] - a[0], b[1] - a[1])
  const n = Math.max(1, Math.floor(L / step))
  for (let k = 0; k <= n; k++) {
    const t: P = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]
    if (!ctx.occ.hitsPoint(t, r * 0.6) && !ctx.corridors.hits(t, 1)) ctx.out.trees.push({ p: t, r })
  }
}

/**
 * 园里的池（地图上没有池水，画成一片铺地的洲浜）：曲折的岸线，先登记占地，后盖的亭榭都让开池面。
 * 返回池的轮廓、岸线上的点与"沿岸种一圈树"（等亭榭盖完再种）。ru、rd 是两个方向的半径（米），ph 定岸线的样子。
 */
function pond(ctx: Ctx, F: Frame, uc: number, fc: number, ru: number, rd: number, ph: number) {
  const shore = (t: number, s: number): P => {
    const k = 1 + 0.16 * dmath.sin(3 * t + ph) + 0.08 * dmath.cos(5 * t - ph)
    return fat(F, uc + dmath.cos(t) * ru * k * s, fc + dmath.sin(t) * rd * k * s)
  }
  const poly: Poly = []
  for (let i = 0; i < 22; i++) poly.push(shore((i / 22) * Math.PI * 2, 1))
  emitArea(ctx, 'plazas', poly)
  ctx.occ.add(poly)
  const trees = () => {
    const n = Math.round((ru + rd) * 0.3)
    for (let i = 0; i < n; i++) plantTree(ctx, shore((i / n) * Math.PI * 2 + ph, 1.2), 2 + (i % 4) * 0.45)
  }
  return { poly, shore, trees }
}

/** 一座方亭（c 为中心，半边长 s） */
const kiosk = (c: P, s: number): Poly => [
  [c[0] - s, c[1] - s],
  [c[0] + s, c[1] - s],
  [c[0] + s, c[1] + s],
  [c[0] - s, c[1] + s],
]

/**
 * 池苑（慈宁宫花园、西苑一类）：园墙里一方曲岸的池，池北岸一座水榭，池畔两座亭，其余是假山上的树丛。
 * h 定池偏向哪一角、岸线的样子。
 */
function pondGarden(ctx: Ctx, F: Frame, u0: number, u1: number, f0: number, f1: number, h: number) {
  const w = u1 - u0
  const d = f1 - f0
  if (w < 16 || d < 16) return
  const zone = fbox(F, u0, u1, f0, f1)
  emitArea(ctx, 'enclosures', zone)
  emitArea(ctx, 'greens', zone, 'garden')
  const ru = w * 0.27
  const rd = d * 0.25
  const uc = (u0 + u1) / 2 + (h - 0.5) * w * 0.18
  const fc = (f0 + f1) / 2 + (((h * 7) % 1) - 0.6) * (f1 - f0) * 0.16
  const po = pond(ctx, F, uc, fc, ru, rd, h * 6.28)
  // 水榭：池北岸，面宽随池
  const hw = Math.min(ru * 0.5, 12)
  const hb = fc + rd * 1.35
  put(ctx, fbox(F, uc - hw, uc + hw, hb, hb + Math.min(8, d * 0.1)), 'hall')
  // 两座亭：池的东南、西南岸
  for (const t of [0.7 + h, 2.4 + h]) put(ctx, kiosk(po.shore(t, 1.35), Math.min(3.5, w * 0.05)), 'pagoda')
  po.trees()
  scatterTrees(ctx, insetConvex(zone, 1.5), 0.012, 2, 3.8)
}

// —————————————————————— 宫城（中式） ——————————————————————

/** 宫门：凹字形的午门、门前一对阙楼（唐宋）、一座门楼、三门并列（元大内的崇天门、明堂式） */
type ImpGate = 'wumen' | 'que' | 'plain' | 'triple'
const IMP_GATE: Elem<ImpGate>[] = [
  { id: 'wumen', w: 3, min: 110 },
  { id: 'que', w: 2 },
  { id: 'plain', w: 1.5 },
  { id: 'triple', w: 1.5, min: 90 },
]
/** 宫门内的广庭：空阔的广场、御道两旁的树、两侧一溜朝房 */
type Fore = 'open' | 'grove' | 'rows'
const FORE: Elem<Fore>[] = [
  { id: 'open', w: 2 },
  { id: 'grove', w: 1.5 },
  { id: 'rows', w: 1.5, min: 120 },
]
/** 殿的台基：工字形的三台（殿都在一座大台上）、前宽后窄的土字台、各殿各自的台 */
type Terrace = 'gongzi' | 'tu' | 'none'
const TERRACE: Elem<Terrace>[] = [
  { id: 'gongzi', w: 3 },
  { id: 'tu', w: 1.5 },
  { id: 'none', w: 1 },
]
/** 一组殿的大小排法：工字（前后大、中间小，只有三殿时）、正殿居中最大、由前往后渐大、渐小 */
type Profile = 'gongzi' | 'peak' | 'rising' | 'falling'
const PROFILE: Elem<Profile>[] = [
  { id: 'gongzi', w: 2 },
  { id: 'peak', w: 2 },
  { id: 'rising', w: 1 },
  { id: 'falling', w: 1.5 },
]
/** 前朝的东西两路（文华殿、武英殿一类）：前后两进、一座大院、三进、仓廒、池苑、四座小院 */
type Wing = 'twin' | 'one' | 'triple' | 'stores' | 'garden' | 'grid'
const WING: Elem<Wing>[] = [
  { id: 'twin', w: 3 },
  { id: 'one', w: 2 },
  { id: 'triple', w: 1, min: 200 },
  { id: 'stores', w: 1.2 },
  { id: 'garden', w: 1.2 },
  { id: 'grid', w: 1, min: 160 },
]
/** 内廷两侧：东西六宫的院落格子、一列列窄长的"所"、一侧池苑 */
type Gong = 'grid' | 'suo' | 'garden'
const GONG: Elem<Gong>[] = [
  { id: 'grid', w: 4 },
  { id: 'suo', w: 1.5 },
  { id: 'garden', w: 1 },
]
/** 后苑：对称的御花园、池苑、成行的古柏林、一座殿院（寿皇殿式） */
type Garden = 'formal' | 'pond' | 'grove' | 'shrine'
const GARDEN: Elem<Garden>[] = [
  { id: 'formal', w: 3 },
  { id: 'pond', w: 2 },
  { id: 'grove', w: 1 },
  { id: 'shrine', w: 1 },
]
/** 后苑两侧、宫门两侧：院落、两座小院、仓廒、树林 */
type Aside = 'compound' | 'pair' | 'stores' | 'grove'
const ASIDE: Elem<Aside>[] = [
  { id: 'compound', w: 3 },
  { id: 'pair', w: 1.5 },
  { id: 'stores', w: 1.5 },
  { id: 'grove', w: 1 },
]
/** 宫墙四角：角楼、曲尺形的角阙、不设 */
type Corner = 'jiaolou' | 'que' | 'none'
const CORNER: Elem<Corner>[] = [
  { id: 'jiaolou', w: 3 },
  { id: 'que', w: 1 },
  { id: 'none', w: 1 },
]

/** 以前的几套形制，现在是预设：明清（紫禁城）、唐（大明宫）、元（大内）、宋（汴京大内） */
const IMP_PRESETS: Preset[] = [
  {
    id: 'mingqing',
    w: 3,
    bias: { gate: { wumen: 6 }, terrace: { gongzi: 6 }, 'throne.profile': { gongzi: 8 }, 'inner.profile': { gongzi: 5 }, garden: { formal: 5 }, corner: { jiaolou: 6 }, gong: { grid: 3 } },
    num: { 'throne.n': [3, 3], 'inner.n': [3, 3] },
  },
  { id: 'tang', w: 2, bias: { gate: { que: 8 }, terrace: { tu: 4 }, 'throne.profile': { peak: 4 }, garden: { pond: 5 }, corner: { que: 5 }, fore: { grove: 2 } }, num: { 'throne.n': [1, 2] } },
  { id: 'yuan', w: 1.5, bias: { gate: { triple: 6 }, terrace: { gongzi: 3 }, 'throne.profile': { falling: 4 }, 'inner.profile': { falling: 3 }, garden: { pond: 2, grove: 2 } }, num: { 'throne.n': [2, 2], 'inner.n': [2, 2] } },
  { id: 'song', w: 1.5, bias: { gate: { plain: 4, triple: 2 }, terrace: { none: 4 }, mid: { yes: 4 }, 'throne.profile': { rising: 3 }, garden: { shrine: 2, formal: 2 } } },
]

/**
 * 中轴上的一组殿：n 座，按 profile 排大小（正殿面宽 hw 米），a0 ~ a1 里前后排开；terrace 定台基。
 * 殿都是面宽大、进深小的长方形。
 */
function axisHalls(K: Yard, a0: number, a1: number, hw: number, n: number, profile: Profile, terrace: Terrace, main: number) {
  const ws = Array.from({ length: n }, (_, i) => {
    if (profile === 'gongzi' && n === 3) return [1, 0.32, 0.78][i]
    const t = n > 1 ? i / (n - 1) : 0
    if (profile === 'rising') return 0.62 + 0.38 * t
    if (profile === 'falling') return 1 - 0.36 * t
    return 1 - 0.3 * Math.abs(i - main)
  })
  const L = a1 - a0
  const g = n > 1 ? L * 0.07 : 0
  const sum = ws.reduce((s, x) => s + x, 0)
  if (terrace === 'gongzi') K.pave(a0 - 3, a1 + 3, -hw * 1.2, hw * 1.2)
  else if (terrace === 'tu') {
    K.pave(a0 - 4, a0 + L * 0.45, -hw * 1.45, hw * 1.45)
    K.pave(a0 + L * 0.45, a1 + 3, -hw * 1.05, hw * 1.05)
  }
  let a = a0
  for (let i = 0; i < n; i++) {
    const slot = ((L - g * (n - 1)) * ws[i]) / sum
    const d = Math.min(slot, hw * ws[i] * 0.95)
    const c = a + slot / 2
    const w = hw * ws[i]
    if (terrace === 'none') K.pave(c - d / 2 - 2.5, c + d / 2 + 2.5, -w - 3, w + 3)
    K.put('keep', c - d / 2, c + d / 2, -w, w)
    a += slot + g
  }
}

/** 一排仓廒、值房：沿 b 方向切成一间间 */
function rowB(K: Yard, a0: number, a1: number, b0: number, b1: number, kind: BuildingKind, unit = 16) {
  const n = Math.max(1, Math.round((b1 - b0) / unit))
  const s = (b1 - b0) / n
  for (let k = 0; k < n; k++) K.put(kind, a0, a1, b0 + k * s + 0.8, b0 + (k + 1) * s - 0.8)
}
/** 一列（沿进深）仓廒、值房 */
function colA(K: Yard, a0: number, a1: number, b0: number, b1: number, kind: BuildingKind, unit = 18) {
  const n = Math.max(1, Math.round((a1 - a0) / unit))
  const s = (a1 - a0) / n
  for (let k = 0; k < n; k++) K.put(kind, a0 + k * s + 0.8, a0 + (k + 1) * s - 0.8, b0, b1)
}

/** 宫里一座院落（东西路、六宫、南三所）：院子的样子全宫统一抽一次（一座宫城里的院落是一个规制） */
function palaceJin(K: Yard, C: Composer, a0: number, a1: number, b0: number, b1: number, centre?: Centre) {
  const side = C.pick('yard.side', [{ id: 'xiang', w: 3 }, { id: 'lang', w: 1 }, { id: 'double', w: 1 }] as Elem<Side>[])
  jin(K, a0, a1, b0, b1, { gate: 'men', main: 'hall', mw: 0.3, back: a1 - a0 > 34 ? 'hall' : null, side, centre: centre ?? 'none' })
}

/**
 * 紫禁城式的宫城（坐北朝南）。骨架是一条中轴：宫门 → 广庭 → 前朝（门、台基上的一组殿、两侧廊庑）
 * →（中院）→ 内廷（门、一组殿）→ 后苑 → 后门；两旁是东西路、东西六宫、后苑两侧的院落，宫门两侧是朝房。
 * 每一格都从元素池里抽（宫门、台基、殿数与大小排法、两路、六宫、后苑、角楼……），两侧可对称也可各抽各的。
 * 规矩：前朝的正殿最大（内廷的殿按比例收小）、中轴对称、地盘小时舍掉要大地盘的元素。
 * 地盘太小（宽或深不到 70 米）返回 false。
 */
export function imperialPalace(ctx: Ctx, R: Poly): boolean {
  // 地图上 y 向下：南是 +y
  const { F, W, D } = rectFrame(R, [0, 1])
  if (W < 70 || D < 70) return false
  const K = yard(ctx, F)
  const C = composer(cityDice(ctx, 'imperial'), 'imperial', IMP_PRESETS, { size: Math.min(W, D), rank: 2 })
  const m = 4
  const U = W / 2 - m
  // 中轴的分段（进深，米）：广庭、前朝、中院（可无）、内廷，其余是后苑
  const fa = D * C.num('foreDepth', 0.16, 0.22)
  const fb = fa + D * C.num('throne', 0.28, 0.34)
  const mid = D >= 200 && C.chance('mid', 0.3)
  const fm = mid ? fb + D * 0.075 : fb
  const fc = fm + D * C.num('inner', 0.2, 0.25)
  const g1 = D - m - 8
  // 宫墙与城门：宫门、后门，可有东西华门；门都是墙圈上的顶点（画墙时在那里断开门洞）
  const as = (fa + fb) / 2
  const side = C.chance('sideGates', 0.45)
  const P0 = (a: number, b: number) => gat(F, a, b)
  const loop = [P0(0, -W / 2), P0(0, 0), P0(0, W / 2), ...(side ? [P0(as, W / 2)] : []), P0(D, W / 2), P0(D, 0), P0(D, -W / 2), ...(side ? [P0(as, -W / 2)] : [])]
  const ang = (v: P) => dmath.atan2(v[1], v[0])
  const { f, l } = F
  const wall = addWall(
    ctx,
    {
      loop,
      solid: loop.map(() => true),
      towers: [],
      gates: [
        { p: P0(0, 0), angle: ang([-f[0], -f[1]]) },
        { p: P0(D, 0), angle: ang(f) },
        ...(side ? [{ p: P0(as, W / 2), angle: ang(l) }, { p: P0(as, -W / 2), angle: ang([-l[0], -l[1]]) }] : []),
      ],
      kind: 'stone',
      thickness: 3,
    },
    'keep',
  )
  // 四角
  const corner = C.pick('corner', CORNER)
  const tw = Math.min(10, W * 0.03)
  if (corner !== 'none')
    for (const [sb, sa] of [[-1, 0], [1, 0], [-1, 1], [1, 1]] as const) {
      const b = sb * (U - tw / 2)
      const a = sa === 0 ? m + tw / 2 : D - m - tw / 2
      K.put('civic', a - tw / 2, a + tw / 2, b - tw / 2, b + tw / 2)
      // 角阙：曲尺形，顺着两面墙各伸出一截
      if (corner === 'que') {
        K.put('civic', a - tw / 2, a + tw / 2, b - sb * tw * 1.6, b - sb * tw * 0.5)
        K.put('civic', a + (sa === 0 ? 1 : -1) * tw * 0.5, a + (sa === 0 ? 1 : -1) * tw * 1.6, b - tw / 2, b + tw / 2)
      }
    }
  // 宫门：门楼压到伸进宫门的御道就往里挪几米
  const gate = C.pick('gate', IMP_GATE)
  const gateHouse = (hw: number, dep: number, b = 0) => [0, 3, 6, 10].find((o) => K.put('civic', m + o, m + o + dep, b - hw, b + hw))
  if (gate === 'wumen') {
    const gw0 = W * 0.12
    const o = gateHouse(gw0, D * 0.035) ?? 0
    for (const sd of [-1, 1]) K.put('civic', m + o, D * 0.13, sd * gw0, sd * (gw0 + W * 0.05))
  } else if (gate === 'que') {
    gateHouse(W * 0.09, D * 0.04)
    const q = W * 0.028
    for (const sd of [-1, 1]) K.put('civic', m + 1, m + 1 + q * 2, sd * W * 0.16 - q, sd * W * 0.16 + q)
  } else if (gate === 'triple') {
    gateHouse(W * 0.06, D * 0.045)
    for (const sd of [-1, 1]) gateHouse(W * 0.03, D * 0.035, sd * W * 0.13)
  } else gateHouse(W * 0.075, D * 0.05)
  // 广庭
  const fore = C.pick('fore', FORE, { size: W })
  K.pave(D * 0.05, fa, -W * 0.3, W * 0.3)
  if (fore === 'rows') for (const sd of [-1, 1]) colA(K, D * 0.14, fa - 3, sd * W * 0.2, sd * W * 0.23, 'hall', 16)
  // 宫门两侧（广庭东西）：朝房一排加一座院、院落、仓廒、树林
  const [fw, fe] = flanks(C, 'foreSide', ASIDE, C.chance('foreMirror', 0.7))
  for (const [sd, kind] of [[-1, fw], [1, fe]] as const) {
    const c0 = sd < 0 ? -U + W * 0.04 : W * 0.19
    const c1 = sd < 0 ? -W * 0.19 : U - W * 0.04
    aside(K, C, kind, D * 0.05, fa + D * 0.025, c0, c1, true)
  }
  // 前朝：门、殿坐在台基上，四周廊庑围成大院
  const tg = C.pick('throne.gate', [{ id: 'one', w: 3 }, { id: 'triple', w: 1.5 }] as Elem<'one' | 'triple'>[])
  K.put('keep', fa, fa + D * 0.035, -W * 0.1, W * 0.1)
  if (tg === 'triple') for (const sd of [-1, 1]) K.put('hall', fa + D * 0.006, fa + D * 0.03, sd * W * 0.15 - W * 0.025, sd * W * 0.15 + W * 0.025)
  K.pave(fa + D * 0.035, fb, -W * 0.27, W * 0.27)
  const tn = C.int('throne.n', 1, 3)
  const tp = C.pick('throne.profile', PROFILE, { only: (p) => p !== 'gongzi' || tn === 3 })
  const terrace = C.pick('terrace', TERRACE)
  const thw = W * C.num('throne.w', 0.12, 0.16)
  const tmain = tp === 'peak' ? C.int('throne.main', 0, tn - 1) : 0
  axisHalls(K, fa + D * 0.11, fb - D * 0.02, thw, tn, tp, terrace, tmain)
  const pav = C.chance('pavilions', 0.6)
  for (const sd of [-1, 1]) {
    const b = sd * W * 0.27
    colA(K, fa + D * 0.04, fb - D * 0.005, Math.min(b, b - sd * W * 0.025), Math.max(b, b - sd * W * 0.025), 'hall', 22)
    // 体仁阁、弘义阁
    if (pav) {
      const pa = fa + D * 0.11 + (fb - fa - D * 0.13) * 0.25
      K.put('hall', pa - D * 0.02, pa + D * 0.02, Math.min(b, b - sd * W * 0.06), Math.max(b, b - sd * W * 0.06))
    }
  }
  // 东西两路（西武英殿、东文华殿）
  const [ww, we] = flanks(C, 'wing', WING, C.chance('wingMirror', 0.4), { size: D })
  for (const [sd, kind] of [[-1, ww === 'garden' && we === 'garden' ? 'twin' : ww], [1, we]] as const) {
    const u0 = sd < 0 ? -U + W * 0.04 : W * 0.3
    const u1 = sd < 0 ? -W * 0.3 : U - W * 0.04
    const a0 = fa + D * 0.04
    if (kind === 'twin' || kind === 'triple') {
      const k = kind === 'twin' ? 2 : 3
      const s = (fb - a0) / k
      for (let i = 0; i < k; i++) palaceJin(K, C, a0 + i * s + 1, a0 + (i + 1) * s - 1, u0, u1)
    } else if (kind === 'one') palaceJin(K, C, a0, fb, u0, u1, 'trees')
    else if (kind === 'grid') {
      const um = (u0 + u1) / 2
      const am = (a0 + fb) / 2
      for (const [p, q] of [[a0, am - 1], [am + 1, fb]]) for (const [r, t] of [[u0, um - 1], [um + 1, u1]]) palaceJin(K, C, p, q, r, t)
    } else if (kind === 'stores') {
      // 仓廒：一院里一排排的长仓
      K.fence(a0, fb, u0, u1)
      for (let a = a0 + 3; a + 9 < fb - 2; a += 14) rowB(K, a, a + 8, u0 + 2, u1 - 2, 'shed', 18)
    } else pondGarden(ctx, F, u0, u1, a0, fb, C.num(`wingPond${sd}`, 0, 1))
  }
  // 中院（奉先殿、交泰殿一类的一进小院）
  if (mid) palaceJin(K, C, fb + 2, fm - 1, -W * 0.13, W * 0.13, 'ding')
  // 内廷：门、一组殿（比前朝的小）、两侧廊庑
  K.put('keep', fm + D * 0.015, fm + D * 0.035, -W * 0.08, W * 0.08)
  const q0 = fm + D * 0.035
  K.pave(q0, fc, -W * 0.12, W * 0.12)
  const inn = C.int('inner.n', 1, 3)
  const ip = C.pick('inner.profile', PROFILE, { only: (p) => p !== 'gongzi' || inn === 3 })
  axisHalls(K, q0 + (fc - q0) * 0.12, fc - (fc - q0) * 0.12, thw * C.num('inner.w', 0.5, 0.66), inn, ip, 'none', ip === 'peak' ? C.int('inner.main', 0, inn - 1) : 0)
  for (const sd of [-1, 1]) {
    const b = sd * W * 0.12
    colA(K, fm + D * 0.04, fc - D * 0.005, Math.min(b, b - sd * W * 0.02), Math.max(b, b - sd * W * 0.02), 'hall', 18)
  }
  // 东西六宫：两侧的院落格子 / 一列列的所 / 一侧池苑
  const [gw_, ge_] = flanks(C, 'gong', GONG, C.chance('gongMirror', 0.6))
  const cols0 = C.int('gong.cols', 1, 2)
  const rows0 = C.int('gong.rows', 2, 4)
  const s0 = fb + D * 0.03
  const s1 = fc + D * 0.01
  for (const [sd, kind] of [[-1, gw_], [1, gw_ === 'garden' && ge_ === 'garden' ? 'grid' : ge_]] as const) {
    const inn0 = W * 0.135
    const out = U - W * 0.04
    const lo = (x: number, y: number): [number, number] => (sd < 0 ? [-y, -x] : [x, y])
    if (kind === 'garden') {
      const [p, q] = lo(inn0 + 1, out)
      pondGarden(ctx, F, p, q, s0, s1, C.num(`gongPond${sd}`, 0, 1))
      continue
    }
    const cols = kind === 'suo' ? Math.max(1, Math.floor((out - inn0) / 22)) : Math.max(1, Math.min(cols0, Math.floor((out - inn0) / 26)))
    const rows = kind === 'suo' ? Math.max(2, Math.min(6, Math.floor((s1 - s0) / 20))) : Math.max(1, Math.min(rows0, Math.floor((s1 - s0) / 26)))
    const cw = (out - inn0) / cols
    const rh = (s1 - s0) / rows
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        const [p, q] = lo(inn0 + c * cw + 1, inn0 + (c + 1) * cw - 1)
        if (kind === 'suo') jin(K, s0 + r * rh + 1, s0 + (r + 1) * rh - 1, p, q, { gate: 'chuihua', main: 'hall', mw: 0.36, side: 'none', centre: 'none' })
        else palaceJin(K, C, s0 + r * rh + 1, s0 + (r + 1) * rh - 1, p, q)
      }
  }
  // 后苑
  const garden = C.pick('garden', GARDEN)
  const gw = W * C.num('gardenW', 0.16, 0.24)
  const ga = fc + D * 0.01
  if (garden === 'formal') {
    // 御花园：对称的亭子、钦安殿与成行的古柏
    K.green('garden', ga, g1, -gw, gw)
    K.put('keep', ga + (g1 - ga) * 0.35, ga + (g1 - ga) * 0.65, -W * 0.04, W * 0.04)
    const pw = Math.min(6, W * 0.02)
    for (const sd of [-1, 1]) for (const t of [0.25, 0.7]) K.put('pagoda', ga + (g1 - ga) * t - pw, ga + (g1 - ga) * t + pw, sd * gw * 0.6 - pw, sd * gw * 0.6 + pw)
    K.trees(ga, g1, -gw, gw, 0.01, 2.2, 3.4)
  } else if (garden === 'pond') pondGarden(ctx, F, -gw, gw, ga, g1, C.num('gardenPond', 0, 1))
  else if (garden === 'grove') {
    // 古柏林：园墙里一行行的柏树，当中一座亭
    K.fence(ga, g1, -gw, gw)
    K.green('park', ga, g1, -gw, gw)
    K.put('pagoda', (ga + g1) / 2 - 5, (ga + g1) / 2 + 5, -5, 5)
    for (let a = ga + 4; a < g1 - 2; a += 7) for (let b = -gw + 4; b < gw - 2; b += 7) K.tree(a, b, 2.2)
  } else palaceJin(K, C, ga, g1, -gw, gw, 'trees')
  // 后门（神武门）
  K.put('civic', D - m - 7, D - m, -W * 0.06, W * 0.06)
  // 后苑两侧
  const [rw, re] = flanks(C, 'rearSide', ASIDE, C.chance('rearMirror', 0.6))
  for (const [sd, kind] of [[-1, rw], [1, re]] as const) {
    const [a, b] = sd < 0 ? [-U + W * 0.04, -gw - W * 0.01] : [gw + W * 0.01, U - W * 0.04]
    aside(K, C, kind, fc + D * 0.02, D * 0.97, a, b, false)
  }
  // 沿东西宫墙的值房
  if (C.chance('duty', 0.7)) for (const sd of [-1, 1]) colA(K, D * 0.05, D * 0.95, sd < 0 ? -U : U - W * 0.03, sd < 0 ? -U + W * 0.03 : U, 'shed', 16)
  // 广庭里御道两旁的松柏：中间让开宫门（连两侧的门楼、阙楼、午门的两翼）正前方的一条，门前不挡树
  const clear = W * (gate === 'wumen' ? 0.17 : gate === 'que' ? 0.19 : gate === 'triple' ? 0.16 : 0.075) + 3
  for (const sd of [-1, 1]) K.trees(D * 0.06, fa - D * 0.01, sd < 0 ? -W * 0.28 : clear, sd < 0 ? -clear : W * 0.28, fore === 'grove' ? 0.004 : 0.0015, 2.5, 3.5)
  C.done(gat(F, D / 2, 0))
  // 宫门接上路
  connectGates(ctx, [wall])
  return true
}

/** 宫门两侧、后苑两侧的一片：院落、两座小院、仓廒、树林；row 为真时临宫门的一侧先是一排朝房 */
function aside(K: Yard, C: Composer, kind: Aside, a0: number, a1: number, b0: number, b1: number, row: boolean) {
  if (b1 - b0 < 14 || a1 - a0 < 14) return
  if (row && kind !== 'grove') {
    rowB(K, a0, a0 + Math.min(7, (a1 - a0) * 0.2), b0, b1, 'hall', 20)
    a0 += Math.min(7, (a1 - a0) * 0.2) + 3
  }
  if (kind === 'compound') palaceJin(K, C, a0, a1, b0, b1)
  else if (kind === 'pair') {
    const bm = (b0 + b1) / 2
    if (b1 - b0 > (a1 - a0) * 1.2) {
      palaceJin(K, C, a0, a1, b0, bm - 1)
      palaceJin(K, C, a0, a1, bm + 1, b1)
    } else {
      const am = (a0 + a1) / 2
      palaceJin(K, C, a0, am - 1, b0, b1)
      palaceJin(K, C, am + 1, a1, b0, b1)
    }
  } else if (kind === 'stores') {
    K.fence(a0, a1, b0, b1)
    for (let a = a0 + 3; a + 8 < a1 - 2; a += 13) rowB(K, a, a + 7, b0 + 2, b1 - 2, 'shed', 18)
  } else {
    K.green('park', a0, a1, b0, b1)
    K.trees(a0 + 1, a1 - 1, b0 + 1, b1 - 1, 0.014, 2.2, 3.8)
  }
}

// —————————————————————— 王宫（西式） ——————————————————————

/**
 * 主楼与翼楼的平面语法：U 形（两翼三面围着荣誉庭，凡尔赛）、四面围合的方院（马德里、斯德哥尔摩）、
 * H 形（两翼前后都伸出）、E 形（U 形正中再伸出一翼）、T 形（一字楼背后正中伸出一翼）、一字长楼
 */
type Plan = 'U' | 'closed' | 'H' | 'E' | 'T' | 'block'
const PLAN: Elem<Plan>[] = [
  { id: 'U', w: 3 },
  { id: 'closed', w: 2 },
  { id: 'H', w: 1.5 },
  { id: 'E', w: 1.2, min: 90 },
  { id: 'T', w: 1 },
  { id: 'block', w: 1.5 },
]
/** 主楼正中：凸出的主阁（avant-corps）、穹顶圆厅（帕拉第奥式）、柱廊门廊、平直 */
type Mid = 'avant' | 'dome' | 'portico' | 'none'
const MID: Elem<Mid>[] = [
  { id: 'avant', w: 3 },
  { id: 'dome', w: 1 },
  { id: 'portico', w: 1.5 },
  { id: 'none', w: 0.8 },
]
/** 沿正面伸出的长翼、沿阅兵广场两侧往前伸的前翼（大臣翼） */
type Outer = 'none' | 'long' | 'forward'
const OUTER: Elem<Outer>[] = [
  { id: 'none', w: 2 },
  { id: 'long', w: 2 },
  { id: 'forward', w: 1, min: 100 },
]
/** 荣誉庭：铺石、草坪、当中喷泉、当中骑马像 */
type Court = 'paved' | 'lawn' | 'fountain' | 'statue'
const COURT: Elem<Court>[] = [
  { id: 'paved', w: 2 },
  { id: 'lawn', w: 1 },
  { id: 'fountain', w: 1.5 },
  { id: 'statue', w: 1.5 },
]
/** 阅兵广场：铺石、两行林荫、铁栅隔开的前院 */
type Parade = 'paved' | 'avenue' | 'grille'
const PARADE: Elem<Parade>[] = [
  { id: 'paved', w: 2 },
  { id: 'avenue', w: 1.5 },
  { id: 'grille', w: 1.5 },
]
/** 附属院落（马厩、厨房、仆役）：两侧都有、只一侧、没有 */
type Service = 'both' | 'one' | 'none'
const SERVICE: Elem<Service>[] = [
  { id: 'both', w: 3 },
  { id: 'one', w: 2 },
  { id: 'none', w: 1 },
]
/** 王家礼拜堂：荣誉庭旁单独一座、主楼背后伸进园里、接在一翼的前端、没有 */
type Chapel = 'court' | 'rear' | 'wing' | 'none'
const CHAPEL: Elem<Chapel>[] = [
  { id: 'court', w: 2 },
  { id: 'rear', w: 2 },
  { id: 'wing', w: 1 },
  { id: 'none', w: 0.6 },
]
/** 园林：法式的几何花坛与丛林、意式的层层台地、英式的风景园 */
type RGarden = 'parterre' | 'terrace' | 'landscape'
const RGARDEN: Elem<RGarden>[] = [
  { id: 'parterre', w: 3 },
  { id: 'terrace', w: 1.5 },
  { id: 'landscape', w: 2 },
]

/** 以前的几套形制，现在是预设：凡尔赛、马德里王宫、布伦海姆、汉普顿式的 H 形、帕拉第奥式的别墅宫殿 */
const ROYAL_PRESETS: Preset[] = [
  { id: 'versailles', w: 3, bias: { plan: { U: 5 }, outer: { long: 4 }, chapel: { rear: 4 }, garden: { parterre: 6 }, mid: { avant: 3 }, court: { paved: 2, statue: 3 } } },
  { id: 'madrid', w: 2, bias: { plan: { closed: 6 }, service: { both: 3 }, garden: { terrace: 4 }, mid: { portico: 2 } } },
  { id: 'blenheim', w: 1.5, bias: { plan: { block: 4, U: 1.5 }, ends: { yes: 4 }, garden: { landscape: 6 }, mid: { portico: 4 }, parade: { avenue: 3 } } },
  { id: 'hampton', w: 1.2, bias: { plan: { H: 6, E: 2 }, garden: { parterre: 3 }, chapel: { wing: 4 } } },
  { id: 'palladian', w: 1, bias: { plan: { block: 3, T: 4 }, mid: { dome: 8 }, garden: { landscape: 4 }, service: { one: 3 }, outer: { none: 3 } } },
]

/**
 * 西式王宫：正面朝城。骨架是"阅兵广场 → 荣誉庭 → 主楼（corps de logis）→ 园林"，主楼两旁按平面语法长出翼楼，
 * 再挂上正中的主阁 / 穹顶 / 柱廊、两端的角阁、翼端的阁、外伸的长翼、附属院落、礼拜堂。立面总是左右对称，
 * 附属院落与礼拜堂可以只在一侧。地盘太小（宽或深不到 60 米）返回 false。
 */
export function royalPalace(ctx: Ctx, R: Poly): boolean {
  const c = centroid(R)
  const toCity: P = [ctx.center[0] - c[0], ctx.center[1] - c[1]]
  const L = dmath.hypot(toCity[0], toCity[1]) || 1
  const { F, W, D } = rectFrame(R, [toCity[0] / L, toCity[1] / L])
  if (W < 60 || D < 60) return false
  const K = yard(ctx, F)
  const V = cityDice(ctx, 'royal')
  const C = composer(V, 'royal', ROYAL_PRESETS, { size: Math.min(W, D), rank: 2 })
  const plan = C.pick('plan', PLAN)
  const service = C.pick('service', SERVICE)
  // 主楼正面、半宽、翼楼宽，主楼进深（米）
  const fm = D * C.num('fm', 0.25, 0.32)
  const mw = W * C.num('mw', 0.26, 0.33)
  const ww = W * C.num('ww', 0.08, 0.12)
  const md = Math.max(18, D * 0.08) * C.num('md', 0.9, 1.25)
  // 阅兵广场与荣誉庭的分界
  const fp = fm * 0.43
  const at = (a: number, b: number) => gat(F, a, b)
  emitArea(ctx, 'enclosures', R)
  // 主楼；正中的主阁 / 穹顶 / 柱廊；两端的角阁
  const mid = C.pick('mid', MID)
  const ac = W * C.num('ac', 0.05, 0.09)
  const ends = C.chance('ends', plan === 'block' || plan === 'T' ? 0.8 : 0.3)
  const body: [Poly, BuildingKind][] = [[K.B(fm, fm + md, -mw, mw), 'hall']]
  if (mid === 'avant') body.push([K.B(fm - 5, fm + md + 4, -ac, ac), 'keep'])
  else if (mid === 'dome') {
    const r = Math.min(md * 0.6, W * 0.07)
    body.push([circlePoly(at(fm + md / 2, 0), r, 18), 'keep'])
    body.push([K.B(fm - 6, fm + 1, -r * 0.7, r * 0.7), 'keep'])
  } else if (mid === 'portico') body.push([K.B(fm - 7, fm + 1, -ac * 0.8, ac * 0.8), 'keep'])
  if (ends) for (const sd of [-1, 1]) body.push([K.B(fm - 6, fm + md + 5, sd * mw - (sd < 0 ? W * 0.02 : W * 0.05), sd * mw + (sd < 0 ? W * 0.05 : W * 0.02)), 'keep'])
  if (!addGroup(ctx, body, 0.2)) return false
  // 翼楼
  let back = fm + md
  const wingBox = (sd: number): [number, number] => (sd < 0 ? [-mw, -(mw - ww)] : [mw - ww, mw])
  const wf = plan === 'H' ? fp + D * 0.04 : fp + D * 0.01
  if (plan === 'U' || plan === 'closed' || plan === 'H' || plan === 'E')
    for (const sd of [-1, 1]) {
      const [a, b] = wingBox(sd)
      // 两端有角阁时翼楼接在角阁上
      K.put('hall', wf, ends ? fm - 6.5 : fm - 0.3, a, b)
      if (plan === 'H') {
        const bk = fm + md + D * C.num('hback', 0.08, 0.14)
        K.put('hall', ends ? fm + md + 5.5 : fm + md + 0.3, bk, a, b)
        back = Math.max(back, bk)
      }
    }
  const tips = plan !== 'block' && plan !== 'T' && !ends && C.chance('tips', 0.4)
  if (tips) for (const sd of [-1, 1]) K.put('keep', wf - 3, wf + ww * 1.1, sd < 0 ? -mw - 2 : mw - ww - 2, sd < 0 ? -mw + ww + 2 : mw + 2)
  if (plan === 'closed') {
    const t = Math.min(10, D * 0.05)
    addGroup(ctx, [
      [K.B(fp + D * 0.01, fp + D * 0.01 + t, -(mw - ww) + 0.6, mw - ww - 0.6), 'hall'],
      [K.B(fp + D * 0.01 - 3, fp + D * 0.01 + t + 2, -W * 0.05, W * 0.05), 'keep'],
    ], 0.2)
  }
  if (plan === 'E') K.put('hall', fp + D * C.num('eFront', 0.03, 0.09), mid === 'avant' || mid === 'portico' || mid === 'dome' ? fm - 7.5 : fm - 0.3, -ww * 0.6, ww * 0.6)
  if (plan === 'T') {
    const bk = fm + md + D * C.num('tback', 0.08, 0.14)
    K.put('hall', mid === 'avant' ? fm + md + 4.5 : mid === 'dome' ? fm + md / 2 + Math.min(md * 0.6, W * 0.07) + 0.5 : fm + md + 0.3, bk, -ww * 0.9, ww * 0.9)
    back = Math.max(back, bk)
  }
  // 阅兵广场（place d'armes）
  const parade = C.pick('parade', PARADE)
  K.pave(D * 0.01, fp, -mw, mw)
  if (parade === 'avenue') for (const sd of [-1, 1]) treeLine(ctx, at(D * 0.02, sd * mw * 0.55), at(fp - 3, sd * mw * 0.55), 6, 2.3)
  if (parade === 'grille') emitArea(ctx, 'enclosures', K.B(D * 0.01, fp, -mw * 0.8, mw * 0.8))
  // 荣誉庭；一字楼、T 形楼前没有围合的院子，是一片修剪整齐的草坪
  const open = plan === 'block' || plan === 'T'
  const court = K.B(fp, fm - (open ? 7 : 0), -(mw - ww), mw - ww)
  if (open) {
    emitArea(ctx, 'greens', court, 'garden')
    for (const sd of [-1, 1]) treeLine(ctx, at(fp + 3, sd * (mw - ww)), at(fm - 9, sd * (mw - ww)), 6, 2.2)
  } else {
    const ct = C.pick('court', COURT)
    emitArea(ctx, 'plazas', court)
    const cc = at((fp + fm) / 2 - (plan === 'E' ? D * 0.04 : 0), plan === 'E' ? mw * 0.45 : 0)
    if (ct === 'lawn') for (const sd of [-1, 1]) emitArea(ctx, 'greens', K.B(fp + 4, fm - 4, sd < 0 ? -(mw - ww) + 3 : ww * 0.8, sd < 0 ? -ww * 0.8 : mw - ww - 3), 'garden')
    else if (ct === 'fountain') ctx.out.landmarks.push({ p: cc, kind: 'fountain' })
    else if (ct === 'statue') ctx.out.landmarks.push({ p: cc, kind: 'statue' })
    if (ct === 'fountain' || ct === 'statue') ctx.occ.add(circlePoly(cc, 3, 10))
  }
  // 外伸的翼：沿正面的长翼、沿阅兵广场两侧的前翼（只在没有附属院落时）
  const outer = C.pick('outer', OUTER, { only: (o) => o !== 'forward' || service === 'none' })
  if (outer === 'long' && !open)
    for (const sd of [-1, 1]) K.put('hall', fm - D * 0.03, fm - D * 0.03 + Math.max(12, D * 0.05), sd < 0 ? -W * 0.46 : mw, sd < 0 ? -mw : W * 0.46)
  if (outer === 'forward')
    for (const sd of [-1, 1]) K.put('hall', D * 0.03, fm - D * 0.03, sd * (mw + W * 0.02) + (sd < 0 ? -ww * 0.8 : 0), sd * (mw + W * 0.02) + (sd < 0 ? 0 : ww * 0.8))
  // 附属院落：马厩、厨房、仆役（四面围合的院子）
  // 只有一侧附属院落时在哪边
  const ss = service === 'one' ? C.side('serviceSide') : 1
  const sides = service === 'both' ? [-1, 1] : service === 'one' ? [ss] : []
  for (const sd of sides) {
    const [s0, s1] = sd < 0 ? [-W * 0.47, -(mw + W * 0.03)] : [mw + W * 0.03, W * 0.47]
    const f1 = fm - D * 0.06
    if (s1 - s0 < 14 || f1 - D * 0.02 < 20) continue
    K.fence(D * 0.02, f1, s0, s1)
    const t = Math.min((s1 - s0) * 0.22, 9)
    K.put('hall', D * 0.02 + 1, D * 0.02 + 1 + t, s0 + 1, s1 - 1)
    K.put('hall', f1 - 1 - t, f1 - 1, s0 + 1, s1 - 1)
    K.put('shed', D * 0.02 + 2 + t, f1 - 2 - t, sd < 0 ? s0 + 1 : s1 - 1 - t, sd < 0 ? s0 + 1 + t : s1 - 1)
    if (C.chance(`yard${sd}`, 0.4)) K.put('shed', D * 0.02 + 5 + t, f1 - 5 - t, (s0 + s1) / 2 - 2, (s0 + s1) / 2 + 2)
  }
  // 王家礼拜堂
  const chapel = C.pick('chapel', CHAPEL, { only: (k) => (k !== 'court' || service !== 'both') && (k !== 'wing' || (!open && !tips)) })
  const cs = chapel === 'none' ? 1 : service === 'one' ? -ss : C.side('chapelSide')
  if (chapel === 'court') K.put('temple', fp, fm - D * 0.04, cs < 0 ? -(mw + W * 0.09) : mw + W * 0.02, cs < 0 ? -(mw + W * 0.02) : mw + W * 0.09)
  else if (chapel === 'rear') {
    const cb = fm + md + D * C.num('chapelDepth', 0.06, 0.09)
    const [a, b] = cs < 0 ? [-(mw - W * 0.02), -(mw - W * 0.09)] : [mw - W * 0.09, mw - W * 0.02]
    if (K.put('temple', fm + md + 0.5, cb, a, b)) back = Math.max(back, cb)
  } else if (chapel === 'wing') {
    const [a, b] = wingBox(cs)
    K.put('temple', Math.max(D * 0.02, wf - Math.min(18, fp * 0.6)), wf - 0.6, a, b)
  }
  // 园林
  const g0 = back + 6
  const g1 = D - 3
  if (g1 - g0 >= 20) {
    const G = C.pick('garden', RGARDEN)
    if (G === 'parterre') parterreGarden(ctx, F, W, g0, g1, V)
    else if (G === 'terrace') terraceGarden(ctx, F, W, g0, g1, V)
    else landscapeGarden(ctx, F, W, g0, g1, V)
  }
  C.done(at(fm, 0))
  return true
}

/** 花坛（parterre）：一方花圃，四周修剪整齐的矮树篱 */
function parterre(ctx: Ctx, F: Frame, u0: number, u1: number, f0: number, f1: number) {
  emitArea(ctx, 'greens', fbox(F, u0, u1, f0, f1), 'garden')
  for (const [p, q] of [
    [fat(F, u0, f0), fat(F, u1, f0)],
    [fat(F, u0, f1), fat(F, u1, f1)],
    [fat(F, u0, f0), fat(F, u0, f1)],
    [fat(F, u1, f0), fat(F, u1, f1)],
  ] as [P, P][])
    treeLine(ctx, p, q, 3, 1.1)
}

/**
 * 法式园林（凡尔赛）：楼后的几何花坛与喷泉、中轴大道、横向的林荫道，林荫道之间一格格的丛林（bosquet），
 * 可能有一条长长的大水渠。林荫道一两条、花坛一两列、水渠有无、橘园在哪边按宫城抽签。
 */
function parterreGarden(ctx: Ctx, F: Frame, W: number, g0: number, g1: number, V: Dice) {
  const G = g1 - g0
  const cross = V.pick('parterre.cross', [[0.3, 0.58], [0.42], [0.26, 0.5, 0.74]], [3, 2, 1]).map((t) => g0 + G * t)
  const cols = V.pick('parterre.cols', [[[0.05, 0.22], [0.25, 0.44]], [[0.05, 0.44]], [[0.05, 0.16], [0.19, 0.3], [0.33, 0.44]]], [3, 2, 1])
  const canal = V.chance('parterre.canal', 0.6)
  // 中轴大道与横向的林荫道
  emitArea(ctx, 'plazas', fbox(F, -W * 0.035, W * 0.035, g0, g1))
  for (const f of cross) emitArea(ctx, 'plazas', fbox(F, -W * 0.46, W * 0.46, f - 3, f + 3))
  // 楼前的几何花坛，中间喷泉
  for (const sd of [-1, 1])
    for (const [a, b] of cols) {
      const [u0, u1] = sd < 0 ? [-W * b, -W * a] : [W * a, W * b]
      parterre(ctx, F, u0, u1, g0 + 2, cross[0] - 5)
    }
  emitArea(ctx, 'plazas', fbox(F, -W * 0.06, W * 0.06, (g0 + cross[0]) / 2 - W * 0.06, (g0 + cross[0]) / 2 + W * 0.06))
  // 橘园（orangery）：花坛一侧
  const os = V.side('parterre.side')
  put(ctx, fbox(F, os < 0 ? -W * 0.46 : W * 0.3, os < 0 ? -W * 0.3 : W * 0.46, g0 + 1, g0 + 9), 'hall')
  // 丛林：林荫道之间一格格密林
  const bands: [number, number][] = []
  for (let i = 0; i < cross.length; i++) bands.push([cross[i] + 4, (i + 1 < cross.length ? cross[i + 1] - 4 : g1 - 1)])
  for (const [f0, f1] of bands)
    for (const [a, b] of [
      [0.05, 0.24],
      [0.27, 0.46],
    ])
      for (const sd of [-1, 1]) {
        if (f1 - f0 < 8) continue
        const [u0, u1] = sd < 0 ? [-W * b, -W * a] : [W * a, W * b]
        const q = fbox(F, u0, u1, f0, f1)
        emitArea(ctx, 'greens', q, 'park')
        scatterTrees(ctx, q, 0.02, 2.2, 3.6)
      }
  // 大水渠（没有水面图元，画成铺地的长条）
  const last = cross[cross.length - 1]
  if (canal) emitArea(ctx, 'plazas', fbox(F, -W * 0.05, W * 0.05, last + 4, g1 - 2))
  // 林荫道两旁成行的树
  for (const f of cross)
    for (const off of [-4.5, 4.5]) treeLine(ctx, fat(F, -W * 0.45, f + off), fat(F, W * 0.45, f + off), 7, 2.6)
  for (const sd of [-1, 1]) treeLine(ctx, fat(F, sd * W * 0.045, g0 + 3), fat(F, sd * W * 0.045, g1 - 2), 7, 2.6)
}

/**
 * 意式台地园（埃斯特别墅、波波里）：园子沿中轴分成几层台地，层间是挡土墙与台阶，
 * 每层两侧是树篱围着的花坛、中轴一座喷泉；两侧成行的柏树，最里面一座洞窟亭（grotto / casino）。
 */
function terraceGarden(ctx: Ctx, F: Frame, W: number, g0: number, g1: number, V: Dice) {
  const n = Math.max(1, Math.min(V.int('terrace.n', 2, 4), Math.floor((g1 - g0) / 24)))
  const T = (g1 - g0) / n
  const wide = V.num('terrace.wide', 0.3, 0.42)
  emitArea(ctx, 'plazas', fbox(F, -W * 0.03, W * 0.03, g0, g1))
  for (let k = 0; k < n; k++) {
    const f0 = g0 + k * T
    const f1 = f0 + T - 4
    // 挡土墙：层间一道铺石的台阶
    emitArea(ctx, 'plazas', fbox(F, -W * wide, W * wide, f1, f1 + 3))
    if (f1 - f0 < 8) continue
    for (const sd of [-1, 1]) {
      const [u0, u1] = sd < 0 ? [-W * wide, -W * 0.05] : [W * 0.05, W * wide]
      parterre(ctx, F, u0, u1, f0 + 2, f1 - 2)
    }
    const fc = (f0 + f1) / 2
    ctx.out.landmarks.push({ p: fat(F, 0, fc), kind: 'fountain' })
  }
  // 两侧的柏树行与台地外的林子
  for (const sd of [-1, 1]) {
    treeLine(ctx, fat(F, sd * W * (wide + 0.02), g0 + 2), fat(F, sd * W * (wide + 0.02), g1 - 2), 4, 1.6)
    const [u0, u1] = sd < 0 ? [-W * 0.47, -W * (wide + 0.04)] : [W * (wide + 0.04), W * 0.47]
    if (u1 - u0 > 8) {
      const q = fbox(F, u0, u1, g0, g1)
      emitArea(ctx, 'greens', q, 'park')
      scatterTrees(ctx, q, 0.018, 2.2, 3.8)
    }
  }
  // 洞窟亭：中轴尽头
  put(ctx, fbox(F, -W * 0.06, W * 0.06, g1 - 10, g1 - 1), 'civic')
}

/**
 * 英式风景园（斯托、邱园）：一大片起伏的草地，蜿蜒的园路绕一圈，一面不规则的湖，
 * 一丛丛的树林，湖边一座仿古的小神殿（folly）。湖与林的位置按宫城抽签。
 */
function landscapeGarden(ctx: Ctx, F: Frame, W: number, g0: number, g1: number, V: Dice) {
  const zone = fbox(F, -W * 0.47, W * 0.47, g0, g1)
  emitArea(ctx, 'greens', zone, 'park')
  const G = g1 - g0
  // 湖：偏向一侧，靠园子深处
  const lu = V.side('landscape.side') * W * V.num('landscape.lu', 0.04, 0.14)
  const lf = g0 + (g1 - g0) * V.num('landscape.lf', 0.5, 0.65)
  const ru = Math.min(W * 0.13, G * 0.3)
  const rd = Math.min(G * 0.16, W * 0.12)
  const lake = pond(ctx, F, lu, lf, ru, rd, V.h('landscape.lake') * 6.28)
  // 仿古小神殿：湖的对岸一侧，一座圆殿
  const t = V.h('landscape.isle') * Math.PI * 2
  const fc = lake.shore(t, 1.55)
  put(ctx, circlePoly(fc, Math.min(4, W * 0.02), 12), 'temple')
  // 蜿蜒的园路：绕园一圈（顺着湖岸外面起伏）
  const loop: P[] = []
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2
    const k = 1 + 0.08 * dmath.sin(3 * a + V.h('landscape.shore') * 6)
    loop.push(fat(F, dmath.cos(a) * W * 0.38 * k, (g0 + g1) / 2 + (dmath.sin(a) * (g1 - g0) * 0.4 * k)))
  }
  ctx.out.roads.push({ line: loop, width: 2, kind: 'path' })
  lake.trees()
  // 一丛丛的树林：沿园子边缘与路外，楼后留一片开阔的草坪
  for (let k = 0; k < 9; k++) {
    const a = V.h('landscape.clump', k) * Math.PI * 2
    const u = dmath.cos(a) * W * 0.4
    const f = (g0 + g1) / 2 + dmath.sin(a) * (g1 - g0) * 0.42
    if (f < g0 + (g1 - g0) * 0.2) continue
    const r = 8 + V.h('landscape.clumpR', k) * 12
    scatterTrees(ctx, circlePoly(fat(F, u, f), r, 10), 0.03, 2.4, 4.2)
  }
  scatterTrees(ctx, insetConvex(zone, 2), 0.002, 3, 5)
}
