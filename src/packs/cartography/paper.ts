import type { LayerSetup } from '../../kernel'
import { AtlasStyles } from '../../render/atlas/styles'
import { ATLAS_STYLES } from './paper/styles'

/**
 * 内置插件 cartography 的 paper 层入口：登记八种纸图风格（世界地图的纸图）。
 * 登记顺序决定界面上色块的顺序。
 */
const setup: LayerSetup = (host) => {
  // 第一种（自然地理）是默认风格
  ATLAS_STYLES.forEach((s, i) => host.add(AtlasStyles, s.id, s, { default: i === 0 }))
}
export default setup
