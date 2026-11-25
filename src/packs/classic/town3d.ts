/**
 * 内置文化包（西式、东方、和式、伊斯兰）的沙盘入口：把四种文明的沙盘套件注册进 render/town3d/kits.ts。
 * 只为副作用导入（经 src/packs/town3d）。
 */
import { registerTownKit } from '../../render/town3d/kits'
import { kit as eastern } from './eastern/town3d'
import { kit as islamic } from './islamic/town3d'
import { kit as wa } from './wa/town3d'
import { kit as western } from './western/town3d'

registerTownKit('western', western)
registerTownKit('eastern', eastern)
registerTownKit('wa', wa)
registerTownKit('islamic', islamic)
