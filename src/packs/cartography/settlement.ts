import type { LayerSetup } from '../../kernel'
import { SettleThemes } from '../../settlement/themes'
import { SETTLE_THEMES } from './settlement/themes'

/**
 * 内置插件 cartography 的 settlement 层入口：登记八种聚落图主题。
 * 聚落图主题放在 settlement 层（主线程、聚落 Worker 与离线脚本都载入）：沙盘的体块在聚落 Worker 里构建，
 * 要用彩绘主题的建筑配色。登记顺序决定界面上色块的顺序。
 */
const setup: LayerSetup = (host) => {
  // 第一种（羊皮纸）是默认主题
  SETTLE_THEMES.forEach((th, i) => host.add(SettleThemes, th.id, th, { default: i === 0 }))
}
export default setup
