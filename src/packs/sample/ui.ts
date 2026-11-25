import { defineStrings } from '../../i18n'
import type { LayerSetup } from '../../kernel'

/** 示例插件的 ui 层入口（只在主线程载入）：示例世界观、示例命名、示例纸图风格与示例聚落图主题在界面上的名称与说明 */
const setup: LayerSetup = () => {
  defineStrings([
    ['示例世界观', 'Sample setting', 'サンプル世界観'],
    ['示例插件的世界观：只有示例命名一种命名风格，城镇都是示例文明', 'The setting of the sample plugin: a single naming style, and every town built by the Sample culture', 'サンプルプラグインの世界観：命名スタイルは一種のみ、町はすべてサンプル文明'],
    ['示例命名', 'Sample names', 'サンプル命名'],
    ['示例插件的命名风格：希腊字母加序数', 'The naming style of the sample plugin: a Greek letter and an ordinal', 'サンプルプラグインの命名スタイル：ギリシャ文字と序数'],
    ['示例风格', 'Sample style', 'サンプルスタイル'],
    ['示例插件 · 棕褐色调的自然地理', 'Sample plugin · Physical in sepia', 'サンプルプラグイン · セピア調の自然地理'],
    ['示例主题', 'Sample theme', 'サンプルテーマ'],
    ['示例插件 · 墨绿底色的蓝图', 'Sample plugin · Blueprint on dark green', 'サンプルプラグイン · 深緑地の青写真'],
  ])
}
export default setup
