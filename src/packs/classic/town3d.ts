/**
 * 内置插件 classic 的 town3d 层入口：登记四种文明（西式、东方、和式、伊斯兰）的沙盘套件（render/town3d/kits.ts 的 TownKits）。
 */
import type { LayerSetup } from '../../kernel'
import { TownKits } from '../../render/town3d/kits'
import { kit as eastern } from './eastern/town3d'
import { kit as islamic } from './islamic/town3d'
import { kit as wa } from './wa/town3d'
import { kit as western } from './western/town3d'

const setup: LayerSetup = (host) => {
  host.add(TownKits, 'western', western)
  host.add(TownKits, 'eastern', eastern)
  host.add(TownKits, 'wa', wa)
  host.add(TownKits, 'islamic', islamic)
}
export default setup
