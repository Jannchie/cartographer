import type { LayerTable } from '../kernel'

/**
 * world 层的入口表：世界生成用到的插件内容。世界生成的 Worker 只导入这一张表（见 src/worker.ts），
 * 它的构建里没有聚落与沙盘的代码。本表与清单、各插件的 world 层一起计入世界缓存的版本号。
 */
export const WORLD: LayerTable = {
  classic: () => import('./classic/world'),
}
