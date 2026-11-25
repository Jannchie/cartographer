import { NamingStyles } from '../../gen/naming'
import { Polities } from '../../gen/polity'
import { Settings } from '../../gen/setting'
import type { LayerSetup } from '../../kernel'
import { eastern, epic, fantasy, wa } from './world/naming'
import { commandery, feudal, ritsuryo } from './world/polity'
import { classic, eastAsia, occident } from './world/setting'

/**
 * 内置插件 classic 的 world 层入口：四种命名风格、三种制度，以及三个世界观——混合的 classic，和把它拆开的西洋、东亚。
 * 本模块与 ./world/ 目录是世界生成的 Worker 载入的全部插件代码，不导入聚落层；
 * 它们的内容计入世界缓存的版本号（见 vite.config.ts 的 gen-hash）。
 * 登记顺序决定界面选项的顺序（制度的先后还用于统计里并列时取哪一种），不要改动。
 */
const setup: LayerSetup = (host) => {
  for (const s of [fantasy, epic, eastern, wa]) host.add(NamingStyles, s.id, s)
  for (const p of [feudal, commandery, ritsuryo]) host.add(Polities, p.id, p)
  // 默认的世界观：新建世界用它，链接里的世界观不可用时也换成它
  host.add(Settings, classic.id, classic, { default: true })
  // 西方、东方各自成一个世界观；classic 是两者混合的那个，作为旧种子的兼容保留
  host.add(Settings, occident.id, occident)
  host.add(Settings, eastAsia.id, eastAsia)
}
export default setup
