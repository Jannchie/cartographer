import { defineStrings } from '../../i18n'
import type { LayerSetup } from '../../kernel'
import { registerCultures } from '../../settlement/register'
import { western } from '../classic/western'

/**
 * 示例插件（只在开发构建里出现）的 settlement 层入口：登记一种与西式相同、只换了 id 的文明，
 * 用来验证插件的启停、重新载入，以及参数引用了没有启用的内容时的提示。它依赖 classic（借用西式的定义）。
 */
const setup: LayerSetup = (host) => {
  defineStrings([
    ['示例文明', 'Sample', 'サンプル'],
    ['示例插件登记的文明：建法与西式相同', 'Culture registered by the sample plugin; built like the Western one', 'サンプルプラグインが登録する文明。建て方は西洋式と同じ'],
  ])
  registerCultures(host, [{ ...western, id: 'sample', name: '示例文明', desc: '示例插件登记的文明：建法与西式相同' }])
}
export default setup
