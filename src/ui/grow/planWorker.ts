import { activePlugins, workerName } from '../../kernel'
import type { SettlementHistory } from '../../settlement/history'
import type { SettlementParams } from '../../settlement/types'
import type { HistoryRequest } from '../settlement/history.worker'

// 规划（一份成长史，大规模要几秒）放在后台线程推演：用聚落模块的那个线程脚本，另起一个线程
//（聚落模块自己的线程里留着它最近的成长史给沙盘用，不去动它）。调用方一次只等一份（见 grow.ts 的 withPlan）。

type Reply = { kind: string; seq: number; hist?: SettlementHistory; error?: string }

let worker: Worker | null = null
let seq = 0
let pending: { seq: number; resolve: (h: SettlementHistory) => void; reject: (e: Error) => void } | null = null

function spawn() {
  // 启用的插件写在线程的名字里，线程在模块顶层据此启动
  const w = new Worker(new URL('../settlement/history.worker.ts', import.meta.url), { type: 'module', name: workerName(activePlugins()) })
  w.onmessage = (e: MessageEvent<Reply>) => {
    const m = e.data
    if (m.kind !== 'history' || pending?.seq !== m.seq) return
    const p = pending
    pending = null
    if (m.hist) p.resolve(m.hist)
    else p.reject(new Error(m.error ?? 'failed'))
  }
  w.onerror = (e) => {
    worker = null
    pending?.reject(new Error(e.message))
    pending = null
  }
  return w
}

/** 在后台线程推演成长史；线程起不来、推演出错、上一份还没算完时失败（调用方改在主线程算） */
export function planInWorker(params: SettlementParams): Promise<SettlementHistory> {
  if (pending) return Promise.reject(new Error('busy'))
  const w = (worker ??= spawn())
  const s = ++seq
  return new Promise((resolve, reject) => {
    pending = { seq: s, resolve, reject }
    w.postMessage({ kind: 'history', seq: s, params } satisfies HistoryRequest)
  })
}
