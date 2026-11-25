import { boot } from '../kernel'
import { PLUGINS } from './manifest'
import { SETTLEMENT } from './settlement'
import { TOWN3D } from './town3d'
import { UI } from './ui'
import { WORLD } from './world'

/**
 * 启动插件：主线程（全部层）与离线脚本（界面以外的层）用。各入口在调用生成器之前先等它完成：
 * - 主线程（main.ts）：bootPlugins，启用的插件按本机的停用清单算出（ui/plugins.ts）；
 * - 离线脚本：导入 ./all（即 bootAll）。
 * 两个 Worker 不导入本模块：它们只导入自己用到的入口表，直接调用内核的 boot
 *（src/worker.ts 只有 world 层，ui/settlement/history.worker.ts 是 settlement 与 town3d 层），
 * 启用的插件由主线程在第一条消息里给出。
 */
const LAYERS = { world: WORLD, settlement: SETTLEMENT, town3d: TOWN3D }

/** 主线程用：另外载入 ui 层（界面词条） */
export function bootPlugins(enabled: readonly string[]) {
  return boot({ manifests: PLUGINS, enabled, layers: { ...LAYERS, ui: UI } })
}

/** 离线脚本用：启用全部插件（不含只在开发构建里出现的） */
export function bootAll() {
  return boot({ manifests: PLUGINS, enabled: PLUGINS.filter((p) => !p.dev).map((p) => p.id), layers: LAYERS })
}
