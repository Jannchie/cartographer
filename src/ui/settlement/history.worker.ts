import { generateHistory } from '../../settlement/generate'
import type { SettlementParams } from '../../settlement/types'

/**
 * 在后台线程推演聚落的成长史（大城要几秒）：主线程照常响应平移、缩放与拖动参数。
 * 成长史经结构化克隆传回，物件之间的引用（生卒表的键就是地图上的各样东西）原样保留
 */
self.onmessage = (e: MessageEvent<SettlementParams>) => {
  try {
    self.postMessage({ hist: generateHistory(e.data) })
  } catch (err) {
    console.error(err)
    self.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
