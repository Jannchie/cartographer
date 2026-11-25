import { eager, type LayerTable } from '../kernel'
import classic from './classic/town3d'

/** town3d 层的入口表：沙盘用到的插件内容（建筑套件）。主线程、聚落 Worker 与离线脚本导入 */
export const TOWN3D: LayerTable = {
  classic: eager(classic),
  isekai: () => import('./isekai/town3d'),
  // 示例插件只在开发构建里出现（与清单一致；判断要就地写，见 manifest.ts）
  ...(import.meta.env?.DEV ? { sample: () => import('./sample/town3d') } : {}),
}
