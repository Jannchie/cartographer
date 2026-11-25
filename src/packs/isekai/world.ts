import { NamingStyles } from '../../gen/naming'
import { Polities } from '../../gen/polity'
import { Settings } from '../../gen/setting'
import type { LayerSetup } from '../../kernel'
import { beastfolk, demon, dwarf, elf, human } from './world/naming'
import { demonRealm, kingdom, tribal } from './world/polity'
import { isekai } from './world/setting'

/**
 * 插件 isekai（日式异世界，可停用）的 world 层入口：五种命名风格（人类与四个种族）、三种制度与世界观 isekai。
 * 本模块与 ./world/ 目录是世界生成的 Worker 载入的全部代码，不导入聚落层；内容计入世界缓存的版本号（见 vite.config.ts 的 gen-hash）。
 * 插件自己的内容一律带 isekai. 前缀。登记顺序决定界面选项的顺序（制度的先后还用于统计里并列时取哪一种），不要改动。
 */
const setup: LayerSetup = (host) => {
  for (const s of [human, elf, dwarf, beastfolk, demon]) host.add(NamingStyles, s.id, s)
  for (const p of [kingdom, tribal, demonRealm]) host.add(Polities, p.id, p)
  host.add(Settings, isekai.id, isekai)
}
export default setup
