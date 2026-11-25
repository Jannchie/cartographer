import type { LayerSetup } from '../../kernel'
import { TownKits } from '../../render/town3d/kits'
import { kit as western } from '../classic/western/town3d'

/** 插件 isekai 的 town3d 层入口：人类的城沿用西式的沙盘套件 */
const setup: LayerSetup = (host) => {
  host.add(TownKits, 'isekai.human', western)
}
export default setup
