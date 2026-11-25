import type { LayerTable } from '../kernel'

/** town3d 层的入口表：沙盘用到的插件内容（建筑套件）。主线程、聚落 Worker 与离线脚本导入 */
export const TOWN3D: LayerTable = {
  classic: () => import('./classic/town3d'),
  // 示例插件只在开发构建里出现（与清单一致）；离线脚本里没有 import.meta.env
  ...(import.meta.env?.DEV ? { sample: () => import('./sample/town3d') } : {}),
}
