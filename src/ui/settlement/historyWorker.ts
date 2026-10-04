import type { SettlementHistory } from '../../settlement/history'
import type { SettlementParams } from '../../settlement/types'
import type { TownBuild } from '../../render/town3d/massing'
import type { HistoryRequest } from './history.worker'

/** 推演被更新的请求取代（拖动参数时）：调用方忽略即可 */
export class Superseded extends Error {}

type Reply =
  | { kind: 'history'; seq: number; hist?: SettlementHistory; error?: string }
  | { kind: 'town'; seq: number; town?: TownBuild; missing?: boolean; error?: string }

let worker: Worker | null = null
let seq = 0
/** 还没算完的推演（同一时刻至多一个） */
let pending: { seq: number; resolve: (h: SettlementHistory) => void; reject: (e: Error) => void } | null = null
/** 还没回来的沙盘构建（按成长史的序号） */
const towns = new Map<number, { resolve: (t: TownBuild | null) => void; reject: (e: Error) => void }>()
/** 成长史 → 推演它的序号（线程里留着的那一版才能直接构建沙盘） */
const seqOf = new WeakMap<SettlementHistory, number>()

function spawn() {
  const w = new Worker(new URL('./history.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<Reply>) => {
    const m = e.data
    if (m.kind === 'history') {
      if (pending?.seq !== m.seq) return
      const p = pending
      pending = null
      if (m.hist) {
        seqOf.set(m.hist, m.seq)
        p.resolve(m.hist)
      } else p.reject(new Error(m.error ?? 'failed'))
      return
    }
    const t = towns.get(m.seq)
    if (!t) return
    towns.delete(m.seq)
    if (m.town) t.resolve(m.town)
    else if (m.missing) t.resolve(null)
    else t.reject(new Error(m.error ?? 'failed'))
  }
  w.onerror = (e) => {
    worker = null
    pending?.reject(new Error(e.message))
    pending = null
    for (const t of towns.values()) t.reject(new Error(e.message))
    towns.clear()
  }
  return w
}

/** 终止线程：没算完的推演与构建一并以 Superseded 失败 */
function terminate() {
  worker?.terminate()
  worker = null
  pending?.reject(new Superseded())
  pending = null
  for (const t of towns.values()) t.reject(new Superseded())
  towns.clear()
}

/**
 * 在后台线程推演成长史（见 history.worker.ts）。一次只算一个：新的请求直接终止还没算完的旧请求，
 * 旧请求以 Superseded 失败——拖动参数时不会一个接一个排队，只算最后那个值
 */
export function computeHistory(params: SettlementParams): Promise<SettlementHistory> {
  if (worker && pending) terminate()
  const w = (worker ??= spawn())
  const s = ++seq
  return new Promise((resolve, reject) => {
    pending = { seq: s, resolve, reject }
    w.postMessage({ kind: 'history', seq: s, params } satisfies HistoryRequest)
  })
}

/**
 * 沙盘的体块与树：在推演这份成长史的线程里构建（它还留着原件），数组转移回来。
 * 线程里已经换成了别的成长史（或线程被终止过）时得 null，由调用方在主线程构建
 */
export function computeTown(hist: SettlementHistory): Promise<TownBuild | null> {
  const s = seqOf.get(hist)
  if (s === undefined || !worker) return Promise.resolve(null)
  const w = worker
  return new Promise((resolve, reject) => {
    towns.set(s, { resolve, reject })
    w.postMessage({ kind: 'town', seq: s } satisfies HistoryRequest)
  })
}
