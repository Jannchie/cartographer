import { area, bboxOf, convexOverlap, pointInPoly, type BBox, type Poly } from './geom'
import type { Ctx, RegMark } from './ctx'
import type { Building } from './types'

/**
 * 撤回与拆除：一处地标、一块园子、一座名所试着盖，盖不成就整个撤回；盖之前要给它腾地方就拆掉挡路的人家。
 *
 * - checkpoint / rollback：记下所有输出数组（ctx.out 的每一项）、占地登记、走廊、民居预算与各模块的记录（memo 里的数组、集合），
 *   撤回时恢复成记下时的样子。输出数组只许追加，或经 drop 删除（删除按先后记在 ctx.dropped，撤回时倒着插回原处）；
 *   在检查点之后直接替换数组（ctx.out.x = ...filter()）的撤回时会报错。
 * - demolish：拆房子——从输出与占地登记里删掉，拆掉的住户退回民居预算，人口仍对得上目标。
 */

type Out = Ctx['out']
type OutKey = keyof Out
type Item<K extends OutKey> = Out[K][number]

export interface Checkpoint {
  len: Map<OutKey, number>
  refs: Map<OutKey, unknown[]>
  dropped: number
  occ: RegMark
  cor: RegMark
  budget: number
  memo: Map<string, number | Set<unknown>>
}

export function checkpoint(ctx: Ctx): Checkpoint {
  const len = new Map<OutKey, number>()
  const refs = new Map<OutKey, unknown[]>()
  for (const k of Object.keys(ctx.out) as OutKey[]) {
    const a = ctx.out[k] as unknown[]
    len.set(k, a.length)
    refs.set(k, a)
  }
  const memo = new Map<string, number | Set<unknown>>()
  for (const [k, v] of ctx.memo) {
    if (Array.isArray(v)) memo.set(k, v.length)
    else if (v instanceof Set) memo.set(k, new Set(v))
  }
  return { len, refs, dropped: ctx.dropped.length, occ: ctx.occ.mark(), cor: ctx.corridors.mark(), budget: ctx.houseBudget, memo }
}

/** 撤回到检查点：之后追加的去掉、删掉的插回原处，占地、走廊、预算、记录一并恢复 */
export function rollback(ctx: Ctx, cp: Checkpoint) {
  for (const [k, a] of cp.refs) if (ctx.out[k] !== a) throw new Error(`rollback: out.${k} 在检查点之后被整个替换了（删除要走 drop）`)
  // 删除倒着插回：之后追加的都在数组末尾，插回的下标不受影响
  for (let i = ctx.dropped.length - 1; i >= cp.dropped; i--) {
    const d = ctx.dropped[i]
    ;(ctx.out[d.key] as unknown[]).splice(d.idx, 0, d.item)
  }
  ctx.dropped.length = cp.dropped
  for (const [k, n] of cp.len) {
    const a = ctx.out[k] as unknown[]
    if (a.length < n) throw new Error(`rollback: out.${k} 在检查点之后被截短了（删除要走 drop）`)
    a.length = n
  }
  ctx.occ.truncate(cp.occ)
  ctx.corridors.truncate(cp.cor)
  ctx.houseBudget = cp.budget
  for (const [k, v] of [...ctx.memo]) {
    const was = cp.memo.get(k)
    if (Array.isArray(v)) {
      if (typeof was === 'number') v.length = Math.min(v.length, was)
      else ctx.memo.delete(k)
    } else if (v instanceof Set) {
      if (was instanceof Set) {
        v.clear()
        for (const x of was) v.add(x)
      } else ctx.memo.delete(k)
    }
  }
}

/** 试着做一件事：返回假值（或抛错）就撤回它写下的一切 */
export function attempt<T>(ctx: Ctx, f: () => T): T {
  const cp = checkpoint(ctx)
  let ok = false
  try {
    const r = f()
    ok = !!r
    return r
  } finally {
    if (!ok) rollback(ctx, cp)
  }
}

/** 从输出数组里删掉满足 f 的项（原地删，记下以便撤回）；from 起只看这个下标以后的。返回删掉的项 */
export function drop<K extends OutKey>(ctx: Ctx, key: K, f: (x: Item<K>, k: number) => boolean, from = 0): Item<K>[] {
  const a = ctx.out[key] as Item<K>[]
  const gone: Item<K>[] = []
  let w = from
  for (let r = from; r < a.length; r++) {
    const x = a[r]
    if (f(x, r)) {
      // 记下删的时候它在哪（前面删掉的已经挪走）
      ctx.dropped.push({ key, idx: w, item: x })
      gone.push(x)
    } else {
      // 多数时候一个也不删：只读不写
      if (w !== r) a[w] = x
      w++
    }
  }
  a.length = w
  return gone
}

/** 住户（计入人口）的建筑 */
export const dwelling = (b: Pick<Building, 'kind'>) => b.kind === 'house' || b.kind === 'large'

/**
 * 能拆的建筑：民居与棚；minor 时连占一户宅地的小东西也算（路边的祠、小鸟居、礼拜龛、施水亭，见 tiers.ts 的 micro）。
 * 别的（地标、殿宇、城楼）不拆，要让位的换个地方。
 */
export function removable(b: Building, minor = false) {
  if (b.kind === 'house' || b.kind === 'large' || b.kind === 'shed') return true
  return minor && ((b.kind === 'torii' && !b.role) || (!!b.role && area(b.poly) < 16))
}

/**
 * 拆掉 pick 选中的建筑（from 起只看这个下标以后的）：从输出与占地登记里删掉，拆掉的住户退回民居预算
 * （按它算进人口的户数：units，缺省一户；城外村子、宫殿里不算人口的为 0）。返回拆掉的建筑。
 */
export function demolish(ctx: Ctx, pick: (b: Building) => boolean, from = 0): Building[] {
  const gone = drop(ctx, 'buildings', pick, from)
  if (!gone.length) return gone
  const set = new Set<Poly>()
  let bb: BBox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const b of gone) {
    set.add(b.poly)
    const q = bboxOf(b.poly)
    bb = [Math.min(bb[0], q[0]), Math.min(bb[1], q[1]), Math.max(bb[2], q[2]), Math.max(bb[3], q[3])]
    if (dwelling(b)) ctx.houseBudget += b.units ?? 1
  }
  ctx.occ.removeWhere((q) => set.has(q), bb)
  return gone
}

/**
 * 拆掉的人家留下的院墙、菜园、树也清走：与 poly 相交的院墙、园地（公园、墓地不动）与落在 poly 里的树。
 * from / to 两个检查点限定只动这一段里写下的（缺省全部）：地标刚盖的院墙、树在 to 之后，留着。
 */
export function clearYards(ctx: Ctx, poly: Poly, o: { from?: Checkpoint; to?: Checkpoint } = {}) {
  const [x0, y0, x1, y1] = bboxOf(poly)
  const touches = (q: Poly) => {
    const b = bboxOf(q)
    return !(b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0) && convexOverlap(q, poly)
  }
  const range = (k: OutKey) => [o.from?.len.get(k) ?? 0, o.to?.len.get(k) ?? Infinity] as const
  const [e0, e1] = range('enclosures')
  drop(ctx, 'enclosures', (q, k) => k < e1 && touches(q), e0)
  const [g0, g1] = range('greens')
  drop(ctx, 'greens', (g, k) => k < g1 && g.kind !== 'park' && g.kind !== 'cemetery' && touches(g.poly), g0)
  const [t0, t1] = range('trees')
  drop(ctx, 'trees', (t, k) => k < t1 && pointInPoly(t.p, poly), t0)
}
