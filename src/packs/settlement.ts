import type { LayerTable } from '../kernel'

/** settlement 层的入口表：聚落生成与聚落图用到的插件内容（文明、聚落图主题）。主线程、聚落 Worker 与离线脚本导入 */
export const SETTLEMENT: LayerTable = {
  classic: () => import('./classic/settlement'),
  cartography: () => import('./cartography/settlement'),
  // 示例插件只在开发构建里出现（与清单一致）；离线脚本里没有 import.meta.env
  ...(import.meta.env?.DEV ? { sample: () => import('./sample/settlement') } : {}),
}
