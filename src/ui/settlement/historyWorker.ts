import type { SettlementHistory } from '../../settlement/history'
import type { SettlementParams } from '../../settlement/types'

/** 推演被更新的请求取代（拖动参数时）：调用方忽略即可 */
export class Superseded extends Error {}

let worker: Worker | null = null
let pending: ((e: Error) => void) | null = null

/**
 * 在后台线程推演成长史（见 history.worker.ts）。一次只算一个：新的请求直接终止还没算完的旧请求，
 * 旧请求以 Superseded 失败——拖动参数时不会一个接一个排队，只算最后那个值
 */
export function computeHistory(params: SettlementParams): Promise<SettlementHistory> {
  if (worker && pending) {
    worker.terminate()
    worker = null
    pending(new Superseded())
    pending = null
  }
  const w = (worker ??= new Worker(new URL('./history.worker.ts', import.meta.url), { type: 'module' }))
  return new Promise((resolve, reject) => {
    pending = reject
    w.onmessage = (e: MessageEvent<{ hist?: SettlementHistory; error?: string }>) => {
      pending = null
      if (e.data.hist) resolve(e.data.hist)
      else reject(new Error(e.data.error ?? 'failed'))
    }
    w.onerror = (e) => {
      pending = null
      worker = null
      reject(new Error(e.message))
    }
    w.postMessage(params)
  })
}
