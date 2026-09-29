import type { Ctx } from './ctx'
import { bboxOf, convexOverlap, pointInPoly, type BBox, type P, type Poly } from './geom'
import { hashAt } from './ctx'
import { residentsOf } from './people'
import { scaleOf } from './scale'
import type { Settlement } from './types'

/**
 * 城市的成长史：城市按人口一路长大，每样东西（房子、田、树、路……）都有出生与消亡的时刻（按人口计）。
 * 某个人口时的地图就是那时还在的东西（见 snapshot）；成长动画只生成一次历史，逐帧取快照。
 *
 * 片区的"形态"：一块片区在历史上先后是田野 / 零散的农家 / 疏、中、密的街坊 / 某种特殊片区（广场、寺庙……）。
 * 每种形态都按它开始那一刻的规模事先盖满一套（Form），再由调度器（schedule）决定里面的东西何时出现、何时被拆：
 * - 整片的形态（whole）：开始时一次建成，同时清掉这块片区原来的一切（田野、特殊片区）；
 * - 渐进的形态（民居）：房子按户一栋栋入住（一栋房子连同它院里的棚、院墙、树是一组），全城的住户跟着人口走；
 *   翻建成更密的一档时，新一档的房子一户户盖起来，拆掉与它重叠的旧房——中间是新旧混杂的街坊。
 */

export type OutKey = keyof Ctx['out']
/** 形态里的一样东西 */
export interface Piece {
  key: OutKey
  item: object
  box: BBox
  /** 多边形（房子、田、院墙……）；点状的（树、船）没有 */
  poly?: Poly
  /** 点（树、地标、注记） */
  p?: P
  /** 算进人口的户数（民居） */
  units: number
}
/** 渐进形态里一起出现的一组：一户人家（房子与它院里的东西） */
interface Group {
  pieces: Piece[]
  units: number
  /** 最早可以入住的时刻 */
  avail: number
  /** 入住的先后（小的先） */
  key: number
  form: Form
  entered: boolean
}
export interface Form {
  patch: number
  /** 开始的时刻（人口） */
  start: number
  /** 整片一次建成（特殊片区、田野）；否则是民居，按户入住 */
  whole: boolean
  /** 翻建（前一个形态也是民居）：新房一户户替换旧房 */
  rebuild: boolean
  /** 零散的农家：原来的田地留着，只拆院子压到的（村子散在田间）；成了街坊时田地一次清掉 */
  rural?: boolean
  pieces: Piece[]
  /** 开始时就有的（整片形态的全部；民居形态里不属于哪一户的：街坊底、零散的树） */
  base: Piece[]
  groups: Group[]
  /** 下一个形态开始了：还没入住的户不再入住 */
  closed: boolean
}

export interface Life {
  born: number
  died: number
}

/** 生成成长史时的记录（ctx.history）：各样东西的生卒，和只在历史上出现过、最终状态里没有的东西 */
export interface HistoryState {
  life: Map<object, Life>
  /** 不在最终状态（ctx.out）里的东西：拆掉的老城墙、翻建前的房子、被地标拆掉的人家…… */
  past: { key: OutKey; item: object }[]
  /** 干道与它开通的时刻（道路整理之后按它给路定生卒） */
  sources: { line: P[]; born: number }[]
  /** 第 k 个（从 0 数）某种地标出现时的人口（按各人口下的自动数量） */
  countPop: (id: string, k: number) => number
  /**
   * 只要最后那一刻的地图（单次生成）：城外整片的形态（田野、荒地、城外的村子）先不盖，
   * 调度完只盖到最后还在的那些——它们不住人，盖不盖不影响别的片区怎么长
   */
  lazy?: boolean
}

/** 输出数组的一个记号：之后追加的、删掉的（stamp 按它给生卒） */
export interface Mark {
  lens: Map<OutKey, number>
  dropped: number
}
export function outMark(ctx: Ctx): Mark {
  const lens = new Map<OutKey, number>()
  for (const k of Object.keys(ctx.out) as OutKey[]) lens.set(k, (ctx.out[k] as unknown[]).length)
  return { lens, dropped: ctx.dropped.length }
}
/**
 * 记号之后追加的东西在 born 出生（已经记过的不动），died 时消亡；之后删掉的（drop、demolish）在 born 这一刻消亡，
 * 挪进 past（出生比它晚的就是从没出现过）
 */
export function stamp(ctx: Ctx, m: Mark, born: number, died = Infinity) {
  const h = ctx.history
  if (!h) return
  // 记号之后删掉的（拆房子腾地方）删在记号前的部分时，后面的项往前挪一格：按删除的先后重放出新项从哪里起
  const start = new Map(m.lens)
  for (let i = m.dropped; i < ctx.dropped.length; i++) {
    const d = ctx.dropped[i]
    const b = start.get(d.key)
    if (b !== undefined && d.idx < b) start.set(d.key, b - 1)
    const item = d.item as object
    const l = h.life.get(item)
    if (!l) h.life.set(item, { born: 0, died: born })
    else l.died = Math.max(l.born, Math.min(l.died, born))
    h.past.push({ key: d.key, item })
  }
  for (const [k, n] of start) {
    const a = ctx.out[k] as object[]
    for (let i = n; i < a.length; i++) if (!h.life.has(a[i])) h.life.set(a[i], { born, died })
  }
}

/** 成长史：settlement 里是历史上出现过的一切，life 记着各自的生卒（不在表里的一直都在） */
export interface SettlementHistory {
  st: Settlement
  life: Map<object, Life>
  /** 历史算到的人口 */
  until: number
}

const pieceBox = (key: OutKey, item: any): { box: BBox; poly?: Poly; p?: P } => {
  if (Array.isArray(item)) return { box: bboxOf(item as Poly), poly: item as Poly }
  if (item.poly) return { box: bboxOf(item.poly), poly: item.poly }
  if (item.line) return { box: bboxOf(item.line) }
  if (item.loop) return { box: bboxOf(item.loop) }
  if (item.a && item.b) return { box: bboxOf([item.a, item.b]) }
  const p: P = item.p ?? [0, 0]
  const r = item.r ?? item.len ?? 1
  return { box: [p[0] - r, p[1] - r, p[0] + r, p[1] + r], p }
  void key
}

export function piece(key: OutKey, item: object, units = 0): Piece {
  return { key, item, units, ...pieceBox(key, item) }
}

const SOLID = new Set<OutKey>(['buildings', 'plazas', 'piers'])
const boxHit = (a: BBox, b: BBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
/** 两样东西压在一起（新房压住旧房、院墙、树） */
export function overlaps(a: Piece, b: Piece) {
  // 树只被实心的东西压掉（房子、铺装、码头）：院墙、园地圈着的院子里本来就有树，
  // 树位又钉在世界网格上（见 wards.ts 的 scatterTrees），新旧两套里同一处的是同一棵树
  if (b.key === 'trees' && !SOLID.has(a.key)) return false
  if (a.key === 'trees' && !SOLID.has(b.key)) return false
  if (!boxHit(a.box, b.box)) return false
  if (a.poly && b.poly) return convexOverlap(a.poly, b.poly)
  if (a.poly && b.p) return pointInPoly(b.p, a.poly)
  if (b.poly && a.p) return pointInPoly(a.p, b.poly)
  return true
}

/**
 * 一个民居形态里的东西分户：每栋民居一户，院里的棚、院墙、菜园、树归给离它最近、10 米以内的那户；
 * 不属于哪一户的（街坊底、公共的树）开始时就有。
 */
export function groupForm(ctx: Ctx, f: Form, avail: (h: number) => number, key: (h: number) => number) {
  const heads = f.pieces.filter((x) => x.units > 0 || (x.key === 'buildings' && ((x.item as any).kind === 'house' || (x.item as any).kind === 'large')))
  const groups: Group[] = heads.map((x) => {
    const c: P = [(x.box[0] + x.box[2]) / 2, (x.box[1] + x.box[3]) / 2]
    const h = hashAt(ctx, c, 'history.group')
    return { pieces: [x], units: x.units, avail: avail(h), key: key(h), form: f, entered: false }
  })
  const headSet = new Set(heads)
  for (const x of f.pieces) {
    if (headSet.has(x)) continue
    if (x.key === 'blocks' || x.key === 'roads' || x.key === 'walls' || x.key === 'labels') {
      f.base.push(x)
      continue
    }
    let best: Group | null = null
    let bd = 10
    for (const g of groups) {
      const b = g.pieces[0].box
      const dx = Math.max(b[0] - x.box[2], x.box[0] - b[2], 0)
      const dy = Math.max(b[1] - x.box[3], x.box[1] - b[3], 0)
      const d = Math.hypot(dx, dy)
      if (d < bd) {
        bd = d
        best = g
      }
    }
    if (best) best.pieces.push(x)
    else f.base.push(x)
  }
  f.groups = groups
}

/**
 * 调度：按人口从 from 起每步长 3% 推进到 until。每一步：
 * 1. 到时开始的形态：整片的一次建成、清掉这块片区原来的一切；民居的底先有，各户按时可以入住；
 * 2. 全城的住户按人口（demand）补足：可以入住的户按先后依次入住，拆掉压住的旧东西（拆掉的住户退出）；
 * 返回各样东西的生卒。
 */
export function schedule(forms: Form[], o: { from: number; until: number; demand: (t: number) => number; step?: number }): Map<Piece, Life> {
  const life = new Map<Piece, Life>()
  const alive = new Map<number, Set<Piece>>()
  const aliveOf = (patch: number) => alive.get(patch) ?? alive.set(patch, new Set()).get(patch)!
  const byPatch = new Map<number, Form[]>()
  for (const f of forms) (byPatch.get(f.patch) ?? byPatch.set(f.patch, []).get(f.patch)!).push(f)
  for (const l of byPatch.values()) l.sort((a, b) => a.start - b.start)
  const pending = [...forms].sort((a, b) => a.start - b.start)
  const formOf = new Map<Piece, Form>()
  for (const f of forms) for (const x of f.pieces) formOf.set(x, f)
  let fi = 0
  let supply = 0
  const bear = (x: Piece, t: number, patch: number) => {
    life.set(x, { born: t, died: Infinity })
    aliveOf(patch).add(x)
    supply += x.units
  }
  const kill = (x: Piece, t: number, patch: number) => {
    const l = life.get(x)
    if (!l || l.died !== Infinity) return
    l.died = t
    aliveOf(patch).delete(x)
    supply -= x.units
  }
  /**
   * 形态开张：换下这块片区原来的东西、铺上新的底。整片的形态开始时就开张；民居形态等第一户入住时才开张——
   * 加入了城区却还没人来住的地仍是原来的田野，不会先铺出一片空街坊
   */
  const opened = new Set<Form>()
  const open = (f: Form, t: number) => {
    if (opened.has(f)) return
    opened.add(f)
    const own = aliveOf(f.patch)
    if (f.rural && !f.whole) {
      // 零散的农家：田地、树留着，只有原来那块地（片区底）换成这一个；屋旁的菜园、草场压住的旧田换下来
      const plots = f.base.filter((x) => x.key === 'fields' || x.key === 'enclosures')
      for (const x of [...own]) if (x.key === 'wards' || x.key === 'blocks' || (x.key === 'fields' && plots.some((y) => overlaps(y, x)))) kill(x, t, f.patch)
    } else if (f.whole || !f.rebuild) {
      // 整片建成或从田野辟成民居：原来的一切清掉
      for (const x of [...own]) kill(x, t, f.patch)
    } else {
      // 从农家翻建成街坊：散在田间的田地一次清掉
      for (const x of [...own]) if (x.key === 'fields') kill(x, t, f.patch)
      // 翻建：旧的街坊底去掉，落在新街坊之外（新的巷子里）的旧东西拆掉
      const blocks = f.base.filter((x) => x.key === 'blocks' && x.poly).map((x) => x.poly!)
      for (const x of [...own]) {
        if (x.key === 'blocks' || x.key === 'wards') kill(x, t, f.patch)
        else if (blocks.length) {
          const c: P = x.p ?? [(x.box[0] + x.box[2]) / 2, (x.box[1] + x.box[3]) / 2]
          if (!blocks.some((b) => pointInPoly(c, b))) kill(x, t, f.patch)
        }
      }
    }
    for (const x of f.base) bear(x, t, f.patch)
  }
  // 等着入住的户：按最早可以入住的时刻排，到时移进"可以入住"，再按先后入住
  const waiting: Group[] = []
  let ready: Group[] = []
  const step = o.step ?? 1.03
  for (let t = o.from; ; t = Math.min(o.until, t * step)) {
    // 1. 开始的形态：整片的当下建成；民居形态等第一户入住时才开张（见 open）
    while (fi < pending.length && pending[fi].start <= t) {
      const f = pending[fi++]
      // 同一片区之前的形态不再有新户入住
      for (const g of byPatch.get(f.patch)!) if (g !== f && g.start <= f.start) g.closed = true
      if (f.whole) {
        open(f, t)
        for (const g of f.groups) for (const x of g.pieces) bear(x, t, f.patch)
      } else for (const g of f.groups) waiting.push(g)
    }
    // 2. 住户补足
    const due = waiting.filter((g) => g.avail <= t && !g.form.closed)
    if (due.length) {
      const set = new Set(due)
      for (let k = waiting.length - 1; k >= 0; k--) if (set.has(waiting[k])) waiting.splice(k, 1)
      ready.push(...due)
      ready.sort((a, b) => a.key - b.key)
    }
    ready = ready.filter((g) => !g.form.closed)
    const need = o.demand(t)
    // 一户入住：拆掉压住的旧东西（同一片区之前形态的）；拆掉的旧房原处若有这个形态里还没入住的户，一起入住
    //（翻建时院墙、棚屋先压到旧房，旧房原处的新房却排在后面，中间会空出几帧）
    const enter = (g0: Group) => {
      const queue = [g0]
      g0.entered = true
      while (queue.length) {
        const g = queue.pop()!
        const f = g.form
        open(f, t)
        const own = aliveOf(f.patch)
        for (const x of [...own]) {
          if (formOf.get(x) === f) continue
          if (!g.pieces.some((y) => overlaps(y, x))) continue
          kill(x, t, f.patch)
          if (x.units > 0 || x.key === 'buildings')
            for (const h of f.groups) if (!h.entered && overlaps(h.pieces[0], x)) {
              h.entered = true
              queue.push(h)
            }
        }
        for (const x of g.pieces) bear(x, t, f.patch)
      }
    }
    let k = 0
    while (supply < need && k < ready.length) {
      const g = ready[k++]
      if (!g.entered) enter(g)
    }
    ready = ready.slice(k).filter((g) => !g.entered)
    for (let q = waiting.length - 1; q >= 0; q--) if (waiting[q].entered) waiting.splice(q, 1)
    if (t >= o.until) break
  }
  return life
}

/** 某个人口时的地图：只留那时还在的东西（stats 按留下的重算） */
export function snapshot(h: SettlementHistory, pop: number): Settlement {
  const st = h.st
  const at = (x: object) => {
    const l = h.life.get(x)
    return !l || (l.born <= pop && pop < l.died)
  }
  const out: any = { ...st }
  for (const k of ['roads', 'crossings', 'walls', 'wards', 'blocks', 'buildings', 'enclosures', 'plazas', 'greens', 'parkParts', 'fields', 'trees', 'piers', 'boats', 'wonders', 'landmarks', 'labels'] as const)
    out[k] = (st[k] as object[]).filter(at)
  const dwellings = (out.buildings as Settlement['buildings']).filter((b) => b.kind === 'house' || b.kind === 'large')
  const units = dwellings.reduce((s, b) => s + (b.units ?? 1), 0)
  const innerArea = (out.wards as Settlement['wards']).filter((w) => w.inner).reduce((s, w) => s + Math.abs(signedArea(w.poly)), 0)
  out.stats = {
    ...st.stats,
    buildings: (out.buildings as Settlement['buildings']).filter((b) => b.kind !== 'shed').length,
    houses: dwellings.length,
    households: units,
    population: Math.round(dwellings.reduce((s, b) => s + residentsOf(b, st.params.culture), 0) / 10) * 10,
    area: innerArea / 10000,
  }
  // 规模（村、镇、城）随那时的人口
  out.params = { ...st.params, population: pop, size: scaleOf(pop).size }
  return out as Settlement
}

function signedArea(poly: Poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}
