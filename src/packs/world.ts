import type { LayerTable } from '../kernel'

/**
 * world 层的入口表：世界生成用到的插件内容（命名风格、制度、世界观）。世界生成的 Worker 只导入这一张表（见 src/worker.ts），
 * 它的构建里没有聚落与沙盘的代码。本表与清单、各插件的 world 层一起计入世界缓存的版本号。
 */
export const WORLD: LayerTable = {
  classic: () => import('./classic/world'),
  // 示例插件只在开发构建里出现（与清单一致）；离线脚本里没有 import.meta.env
  ...(import.meta.env?.DEV ? { sample: () => import('./sample/world') } : {}),
}
