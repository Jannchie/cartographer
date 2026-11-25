import { generateHistory } from '../../settlement/generate'
import type { SettlementHistory } from '../../settlement/history'
import type { SettlementParams } from '../../settlement/types'
import { buildTown } from '../../render/town3d/massing'
import { boot } from '../../kernel'
import { PLUGINS } from '../../packs/manifest'
import { SETTLEMENT } from '../../packs/settlement'
import { TOWN3D } from '../../packs/town3d'

/**
 * 在后台线程推演聚落的成长史（大城要几秒）：主线程照常响应平移、缩放与拖动参数。
 * 成长史经结构化克隆传回，物件之间的引用（生卒表的键就是地图上的各样东西）原样保留。
 *
 * 最近一次的成长史留在线程里：进入沙盘时按它构建体块与树（见 render/town3d/massing.ts），
 * 结果（连同地形网格）以可转移的数组传回，不必把整个成长史再克隆一遍。
 *
 * 线程建好后的第一条消息是 init：主线程启用的插件。本线程载入它们的 settlement 与 town3d 层，之后的请求等启动完成再处理。
 */
export type HistoryRequest = { kind: 'init'; plugins: string[] } | { kind: 'history'; seq: number; params: SettlementParams } | { kind: 'town'; seq: number }

let last: { seq: number; hist: SettlementHistory } | null = null
/** 插件的启动（收到 init 消息时开始）；null 为还没有收到 */
let ready: Promise<void> | null = null

self.onmessage = async (e: MessageEvent<HistoryRequest>) => {
  const m = e.data
  if (m.kind === 'init') {
    ready = boot({ manifests: PLUGINS, enabled: m.plugins, layers: { settlement: SETTLEMENT, town3d: TOWN3D } })
    // 失败留给之后的请求报告（每个请求都会等它）
    ready.catch(() => {})
    return
  }
  try {
    if (!ready) throw new Error('聚落线程还没有收到插件清单（init 消息）')
    await ready
  } catch (err) {
    console.error(err)
    if (m.kind === 'history') last = null
    self.postMessage({ kind: m.kind, seq: m.seq, error: err instanceof Error ? err.message : String(err) })
    return
  }
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
      for (const t of [town.trees.trees, town.trees.low]) transfer.push(...[t.inst, t.attr, t.start, t.yr].map((a) => a.buffer as ArrayBuffer))
      const r = town.terrain
      transfer.push(...[r.pos, r.nrm, r.idx, r.carve, r.nrm2, r.wet, r.rim, r.shore].map((a) => a.buffer as ArrayBuffer))
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
