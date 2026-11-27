import type { GrowLot, GrowState, PlaceReq } from './api'
import { growHash, release, setState } from './core'
import { place } from './place'

// 一个村子的需求序列与按序推进它的驱动：scripts/grow.ts 的自检与应用的村落生长模块都用。
// 序列只由人数推出（不用随机数）：第 0 号是开村时的公所和料场，此后每来一个人一处住处，
// 每 4 人一片田（4 块）、每 8 人两块料场、每 10 人一间铺子、每 40 人公所多一块；每 15 人有一户翻盖（住处多占一块），每 25 人有一户搬走。
// 驱动每走一步执行一条需求：新地块先在建，过 LAG 步盖好。驱动的状态（GrowDriver）与 GrowState 一样能过 JSON。

export type GrowOp = { kind: 'place'; req: PlaceReq } | { kind: 'release'; owner: string }

/** 第 n 个来的人带来的需求（n = 0 是开村） */
export function villageOps(n: number): GrowOp[] {
  if (n === 0) {
    return [
      { kind: 'place', req: { use: 'public', area: 1, owner: 'office' } },
      { kind: 'place', req: { use: 'yard', area: 1, owner: 'builders' } },
    ]
  }
  const ops: GrowOp[] = [{ kind: 'place', req: { use: 'home', area: 1, owner: `p${n}` } }]
  // 每 7 片田归一个农场
  if (n % 4 === 0) ops.push({ kind: 'place', req: { use: 'field', area: 1, owner: `farm${Math.floor((n / 4 - 1) / 7)}`, count: 4 } })
  if (n % 8 === 0) ops.push({ kind: 'place', req: { use: 'yard', area: 1, owner: `quarry${Math.floor(n / 64)}`, count: 2 } })
  if (n % 10 === 0) ops.push({ kind: 'place', req: { use: 'shop', area: 1, owner: `shop${Math.floor(n / 50)}` } })
  if (n % 40 === 0) ops.push({ kind: 'place', req: { use: 'public', area: 1, owner: 'office' } })
  if (n % 15 === 0) ops.push({ kind: 'place', req: { use: 'home', area: 1, owner: `p${n / 15}` } })
  if (n % 25 === 0) ops.push({ kind: 'release', owner: `p${n / 25 + 1}` })
  return ops
}

/** 在建几步之后盖好 */
export const BUILD_LAG = 3

export interface GrowDriver {
  /** 下一条需求：第 n 个人的第 i 条 */
  n: number
  i: number
  /** 已经走了几步 */
  tick: number
  /** 在建的地块与盖好的那一步 */
  pending: { id: number; at: number }[]
  /** 摆不下的次数 */
  fails: number
}

export const newDriver = (): GrowDriver => ({ n: 0, i: 0, tick: 0, pending: [], fails: 0 })

/** 摆一块（或一片）地用的 salt：跟着种子与下一个 id，同样的状态同样的结果 */
export const placeSalt = (s: GrowState) => growHash(`${s.seed}|${s.nextId}`)

export interface StepResult {
  state: GrowState
  driver: GrowDriver
  /** 这一步摆下的地块（摆不下、退地时是空的） */
  lots: GrowLot[]
  /** 摆不下 */
  failed: boolean
}

/**
 * 执行一条需求并走一步：place 的新地块在建、记进 pending；release 退掉这个主人的第一块地。
 * 然后把到期的在建地块盖好。不改传入的 state、driver
 */
export function runOp(s: GrowState, d: GrowDriver, op: GrowOp): StepResult {
  const pending = d.pending.slice()
  let lots: GrowLot[] = []
  let failed = false
  if (op.kind === 'place') {
    const got = place(s, { ...op.req, state: 'building' }, placeSalt(s))
    if (got) {
      s = got.state
      lots = got.lots
      for (const l of lots) pending.push({ id: l.id, at: d.tick + BUILD_LAG })
    } else failed = true
  } else {
    const lot = s.lots.find((l) => l.owner === op.owner)
    if (lot) s = release(s, lot.id)
  }
  while (pending.length && pending[0].at <= d.tick) s = setState(s, pending.shift()!.id, 'built')
  return { state: s, driver: { ...d, tick: d.tick + 1, pending, fails: d.fails + (failed ? 1 : 0) }, lots, failed }
}

/** 按需求序列走一步 */
export function advance(s: GrowState, d: GrowDriver): StepResult & { op: GrowOp } {
  const ops = villageOps(d.n)
  const op = ops[d.i]
  const r = runOp(s, d, op)
  const last = d.i + 1 >= ops.length
  return { ...r, op, driver: { ...r.driver, n: last ? d.n + 1 : d.n, i: last ? 0 : d.i + 1 } }
}

/** 把在建的全部盖好（不走步） */
export function finishAll(s: GrowState, d: GrowDriver): { state: GrowState; driver: GrowDriver } {
  for (const p of d.pending) s = setState(s, p.id, 'built')
  return { state: s, driver: { ...d, pending: [] } }
}
