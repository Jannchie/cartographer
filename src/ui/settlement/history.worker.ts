import { generateHistory } from '../../settlement/generate'
import type { SettlementHistory } from '../../settlement/history'
import type { SettlementParams } from '../../settlement/types'
import { buildTown } from '../../render/town3d/massing'

/**
 * 在后台线程推演聚落的成长史（大城要几秒）：主线程照常响应平移、缩放与拖动参数。
 * 成长史经结构化克隆传回，物件之间的引用（生卒表的键就是地图上的各样东西）原样保留。
 *
 * 最近一次的成长史留在线程里：进入沙盘时按它构建体块与树（见 render/town3d/massing.ts），
 * 结果（连同地形网格）以可转移的数组传回，不必把整个成长史再克隆一遍。
 */
export type HistoryRequest = { kind: 'history'; seq: number; params: SettlementParams } | { kind: 'town'; seq: number }

let last: { seq: number; hist: SettlementHistory } | null = null

self.onmessage = (e: MessageEvent<HistoryRequest>) => {
  const m = e.data
  if (m.kind === 'town') {
    // 线程里留的不是这一版（期间又推演过别的）：交给主线程自己构建
    if (last?.seq !== m.seq) {
      self.postMessage({ kind: 'town', seq: m.seq, missing: true })
      return
    }
    try {
      const town = buildTown(last.hist.st, last.hist.life)
      const transfer: ArrayBuffer[] = []
      for (const c of town.chunks) transfer.push(...[c.pos, c.nrm, c.col, c.uv, c.life, c.ids].map((a) => a.buffer as ArrayBuffer))
      for (const t of town.trees) transfer.push(t.data.buffer as ArrayBuffer)
      const r = town.terrain
      transfer.push(...[r.pos, r.uv, r.nrm, r.idx, r.water].map((a) => a.buffer as ArrayBuffer))
      self.postMessage({ kind: 'town', seq: m.seq, town }, { transfer })
    } catch (err) {
      console.error(err)
      self.postMessage({ kind: 'town', seq: m.seq, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  try {
    const hist = generateHistory(m.params)
    last = { seq: m.seq, hist }
    self.postMessage({ kind: 'history', seq: m.seq, hist })
  } catch (err) {
    console.error(err)
    last = null
    self.postMessage({ kind: 'history', seq: m.seq, error: err instanceof Error ? err.message : String(err) })
  }
}
