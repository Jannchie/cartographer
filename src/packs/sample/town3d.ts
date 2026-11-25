import type { LayerSetup } from '../../kernel'
import { TownKits } from '../../render/town3d/kits'
import { kit as western } from '../classic/western/town3d'

/** 示例插件的 town3d 层入口：示例文明沿用西式的沙盘套件 */
const setup: LayerSetup = (host) => {
  host.add(TownKits, 'sample', western)
}
export default setup
