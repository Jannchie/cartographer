import { defineStrings } from '../../i18n'
import type { LayerSetup } from '../../kernel'

/** 示例插件的 ui 层入口（只在主线程载入）：示例世界观与示例命名在界面上的名称与说明 */
const setup: LayerSetup = () => {
  defineStrings([
    ['示例世界观', 'Sample setting', 'サンプル世界観'],
    ['示例插件的世界观：只有示例命名一种命名风格，城镇都是示例文明', 'The setting of the sample plugin: a single naming style, and every town built by the Sample culture', 'サンプルプラグインの世界観：命名スタイルは一種のみ、町はすべてサンプル文明'],
    ['示例命名', 'Sample names', 'サンプル命名'],
    ['示例插件的命名风格：希腊字母加序数', 'The naming style of the sample plugin: a Greek letter and an ordinal', 'サンプルプラグインの命名スタイル：ギリシャ文字と序数'],
  ])
}
export default setup
