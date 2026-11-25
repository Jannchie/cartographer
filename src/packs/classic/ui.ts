import { defineStrings } from '../../i18n'
import type { LayerSetup } from '../../kernel'

/**
 * 内置插件 classic 的 ui 层入口（只在主线程载入）：world 层内容在界面上的名称与说明的英文、日文。
 * world 层不导入界面词典（世界生成的 Worker 不带它），所以词条放在这一层。
 * 四种命名风格、三种制度的名称早已在总词典（src/i18n.ts）里，这里只有世界观的。
 */
const setup: LayerSetup = () => {
  defineStrings([
    ['古典', 'Classical', '古典'],
    [
      '前工业时代：西幻、史诗、东方、和风四种命名风格，分封、郡县、令制三种制度，西式、东方、和风、伊斯兰四种城市文明',
      'Pre-industrial worlds: four naming styles (Fantasy, Epic, Eastern, Japanese), three polities (feudal, commandery, ritsuryō) and four urban civilizations (Western, Eastern, Japanese, Islamic)',
      '前近代の世界：命名スタイル四種（ファンタジー・叙事詩・中華風・和風）、制度三種（封建・郡県・令制）、都市文明四種（西洋・東方・和風・イスラム）',
    ],
  ])
}
export default setup
