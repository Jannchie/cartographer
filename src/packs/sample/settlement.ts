import { defineStrings } from '../../i18n'
import type { LayerSetup } from '../../kernel'
import { registerCultures } from '../../settlement/register'
import { cultureBuildings, SettleThemes, type SettleTheme } from '../../settlement/themes'
import { SETTLE_THEMES } from '../cartography/settlement/themes'
import { western } from '../classic/western'

/**
 * 示例插件（只在开发构建里出现）的 settlement 层入口：登记一种与西式相同、只换了 id 的文明，
 * 和一种聚落图主题（内置的"蓝图"换成墨绿底色），用来验证插件的启停、重新载入，
 * 以及参数、存下的选择引用了没有启用的内容时的提示。它依赖 classic（借用西式的定义）与 cartography（借用蓝图主题）。
 */
const blueprint = SETTLE_THEMES.find((t) => t.id === 'blueprint')!
const theme: SettleTheme = {
  ...blueprint,
  id: 'sample-green',
  name: '示例主题',
  desc: '示例插件 · 墨绿底色的蓝图',
  paper: '#12332c',
  ground: '#173d34',
  water: '#0f2a25',
  waterDeep: '#0c231f',
  buildings: cultureBuildings('sample-green', blueprint.buildings()),
}

const setup: LayerSetup = (host) => {
  defineStrings([
    ['示例文明', 'Sample', 'サンプル'],
    ['示例插件登记的文明：建法与西式相同', 'Culture registered by the sample plugin; built like the Western one', 'サンプルプラグインが登録する文明。建て方は西洋式と同じ'],
  ])
  registerCultures(host, [{ ...western, id: 'sample', name: '示例文明', desc: '示例插件登记的文明：建法与西式相同' }])
  host.add(SettleThemes, theme.id, theme)
}
export default setup
