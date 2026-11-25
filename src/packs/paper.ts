import type { LayerTable } from '../kernel'

/**
 * paper 层的入口表：世界纸图用到的插件内容（纸图风格）。主线程与离线脚本导入；
 * 两个 Worker 都不画世界纸图，不导入本表。
 */
export const PAPER: LayerTable = {
  cartography: () => import('./cartography/paper'),
  // 示例插件只在开发构建里出现（与清单一致）；离线脚本里没有 import.meta.env
  ...(import.meta.env?.DEV ? { sample: () => import('./sample/paper') } : {}),
}
