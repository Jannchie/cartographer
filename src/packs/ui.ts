import type { LayerTable } from '../kernel'

/** ui 层的入口表：只在主线程用的界面内容（目前是 world 层内容的名称与说明的译文）。只有主线程导入 */
export const UI: LayerTable = {
  classic: () => import('./classic/ui'),
  // 示例插件只在开发构建里出现（与清单一致）
  ...(import.meta.env?.DEV ? { sample: () => import('./sample/ui') } : {}),
}
