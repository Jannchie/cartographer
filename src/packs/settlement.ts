import { eager, type LayerTable } from '../kernel'
import cartography from './cartography/settlement'
import classic from './classic/settlement'

/** settlement 层的入口表：聚落生成与聚落图用到的插件内容（文明、聚落图主题）。主线程、聚落 Worker 与离线脚本导入 */
export const SETTLEMENT: LayerTable = {
  classic: eager(classic),
  cartography: eager(cartography),
  // 示例插件只在开发构建里出现（与清单一致；判断要就地写，见 manifest.ts）
  ...(import.meta.env?.DEV ? { sample: () => import('./sample/settlement') } : {}),
}
