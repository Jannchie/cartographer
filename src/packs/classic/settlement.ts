import type { LayerSetup } from '../../kernel'
import { registerCultures } from '../../settlement/register'
import { eastern } from './eastern'
import { islamic } from './islamic'
import { wa } from './wa'
import { western } from './western'

/**
 * 内置插件 classic 的 settlement 层入口：前工业时代的四种城市文明。每种文明的代码各在一个目录里——
 * index.ts 是它的定义（CultureDef），其余是定义引用的各部分：形制、片区的盖法、起名、职业、规模档与名所；
 * town3d/ 是沙盘的建筑套件（由 ./town3d.ts 登记，聚落生成不引入）。
 * 文明之间可以借用：和风的条坊制是东方里坊的变体，山寺、山塔与东方共用。
 *
 * 登记顺序（西式、东方、和风、伊斯兰）决定界面选项的顺序与 planById 的先后，不能改动。
 */
const setup: LayerSetup = (host) => {
  // "铁匠"在东方与西式的职业表里日文写法不同（鍛冶、鍛冶屋）：界面一律用前者
  registerCultures(host, [western, eastern, wa, islamic], [['铁匠', 'Smith', '鍛冶']])
}
export default setup
