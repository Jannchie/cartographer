import { defineStrings } from '../../i18n'
import type { LayerSetup } from '../../kernel'

/**
 * 内置插件 classic 的 ui 层入口（只在主线程载入）：world 层内容在界面上的名称与说明的英文、日文。
 * world 层不导入界面词典（世界生成的 Worker 不带它），所以词条放在这一层。
 * 四种命名风格、三种制度的名称早已在总词典（src/i18n.ts）里，这里只有三个世界观的。
 */
const setup: LayerSetup = () => {
  defineStrings([
    ['古典', 'Classical', '古典'],
    [
      '前工业时代：西幻、史诗、东方、和风四种命名风格，分封、郡县、令制三种制度，西式、东方、和风、伊斯兰四种城市文明',
      'Pre-industrial worlds: four naming styles (Fantasy, Epic, Eastern, Japanese), three polities (feudal, commandery, ritsuryō) and four urban civilizations (Western, Eastern, Japanese, Islamic)',
      '前近代の世界：命名スタイル四種（ファンタジー・叙事詩・中華風・和風）、制度三種（封建・郡県・令制）、都市文明四種（西洋・東方・和風・イスラム）',
    ],
    ['西洋', 'Western', '西洋'],
    [
      '中世纪欧洲式的世界：西幻、史诗两种命名风格，分封制；城是西式的，炎热干旱的地方建伊斯兰式的城',
      'A medieval-European world: two naming styles (Fantasy, Epic) under feudal rule; towns are Western, and Islamic where the land is hot and dry',
      '中世ヨーロッパ風の世界：命名スタイルはファンタジーと叙事詩の二種、制度は封建制。町は西洋式、暑く乾いた土地ではイスラム式',
    ],
    ['东亚', 'East Asian', '東アジア'],
    [
      '汉字文化圈的世界：东方、和风两种命名风格，郡县与令制两种制度；汉字地名的文化建东方的城，日本地名的建和风的城',
      'A world of the Chinese-character sphere: two naming styles (Eastern, Japanese) with the commandery and ritsuryō polities; cultures with Chinese names build Eastern towns, those with Japanese names build Japanese ones',
      '漢字文化圏の世界：命名スタイルは中華風と和風の二種、制度は郡県と令制。漢字地名の文化は東方式の町を、日本の地名の文化は和風の町を建てる',
    ],
  ])
}
export default setup
