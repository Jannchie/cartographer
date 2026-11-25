import { eager, type LayerTable } from '../kernel'
import classic from './classic/world'

/**
 * world 层的入口表：世界生成用到的插件内容（命名风格、制度、世界观）。世界生成的 Worker 只导入这一张表（见 src/worker.ts），
 * 它的构建里没有聚落与沙盘的代码。本表与清单、各插件的 world 层一起计入世界缓存的版本号。
 * 不可停用的插件静态导入（随入口一起打包），可停用的启用时才载入。
 */
export const WORLD: LayerTable = {
  classic: eager(classic),
  // 示例插件只在开发构建里出现（与清单一致；判断要就地写，见 manifest.ts）
  ...(import.meta.env?.DEV ? { sample: () => import('./sample/world') } : {}),
}
