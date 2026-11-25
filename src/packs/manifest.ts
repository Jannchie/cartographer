import type { PluginManifest } from '../kernel'

/**
 * 插件清单：随应用一起构建的全部插件。数组的顺序就是启动与登记的顺序（界面选项的顺序、先登记为准的词条都取决于它），
 * 依赖必须排在前面；用户只能启停，不能调整顺序。清单不引用插件的代码：各层的入口在同目录的入口表里
 *（world.ts、settlement.ts、town3d.ts、paper.ts、ui.ts）。
 * 哪些插件不可停用不在这里写：登记了某个扩展点默认条目的插件就是（内核的 requiredPlugins）；
 * 入口表里它们的入口是静态导入的，随所在的入口一起打包。
 *
 * 新增插件：在本目录下建一个目录，按层写入口模块（world.ts、settlement.ts、town3d.ts、paper.ts、ui.ts，默认导出 LayerSetup），
 * 列进下面的清单，并把各层的入口列进对应的入口表。world 层的代码只放在插件目录的 world.ts 与 world/ 里
 *（世界缓存的版本号按这两处计算，见 vite.config.ts 的 gen-hash）。
 */

/** 内置的古典内容：默认的世界观与文明都在这里 */
const classic: PluginManifest = {
  id: 'classic',
  name: { zh: '古典', en: 'Classical', ja: '古典' },
  desc: {
    zh: '内置的世界观「古典」：西幻、史诗、东方、和风四种命名风格，分封、郡县、令制三种制度，西式、东方、和风、伊斯兰四种城市文明',
    en: 'The built-in "Classical" setting: four naming styles (Fantasy, Epic, Eastern, Japanese), three polities (feudal, commandery, ritsuryō) and four urban civilizations (Western, Eastern, Japanese, Islamic)',
    ja: '組み込みの世界観「古典」：命名スタイル四種（ファンタジー・叙事詩・中華風・和風）、制度三種（封建・郡県・令制）、都市文明四種（西洋・東方・和風・イスラム）',
  },
}

/** 内置的制图风格：默认的纸图风格、聚落图主题与沙盘的配色都在这里 */
const cartography: PluginManifest = {
  id: 'cartography',
  name: { zh: '制图风格', en: 'Map styles', ja: '地図のスタイル' },
  desc: {
    zh: '内置的八种纸图风格（自然地理、奇幻羊皮、航海图、提瓦特、水墨、等高线、政区地图集、战略图）与八种聚落图主题',
    en: 'The eight built-in map styles (Physical, Fantasy parchment, Nautical chart, Teyvat, Ink wash, Contours, Political atlas, Strategy) and the eight town-map themes',
    ja: '組み込みの紙地図スタイル八種（自然地理・ファンタジー羊皮紙・海図・テイワット・水墨・等高線・政区地図帳・戦略図）と、集落図のテーマ八種',
  },
}

/** 示例插件：只在开发构建里出现，用来验证启停与缺失引用的处理 */
const sample: PluginManifest = {
  id: 'sample',
  name: { zh: '示例插件', en: 'Sample plugin', ja: 'サンプルプラグイン' },
  desc: {
    zh: '一个示例世界观（一种命名风格和一种与西式相同的"示例文明"）、一种纸图风格与一种聚落图主题，用来验证插件的启停（只在开发构建里出现）',
    en: 'A sample setting (one naming style and a "Sample" culture identical to the Western one), one map style and one town-map theme, for checking that plugins can be switched on and off (development builds only)',
    ja: 'サンプルの世界観（命名スタイル一種と、西洋式と同じ「サンプル」文明）、紙地図のスタイル一種、集落図のテーマ一種。プラグインの有効・無効を確認するためのもの（開発ビルドのみ）',
  },
  requires: ['classic', 'cartography'],
  dev: true,
}

// 只在开发构建里出现的插件按 import.meta.env?.DEV 判断（离线脚本里没有 import.meta.env，按非开发构建处理）。
// 入口表里同样就地写这个判断，不从这里导出一个常量共用：打包器只在同一个模块里把它折叠成常量，
// 跨模块引用时示例插件的入口会被打进生产构建
export const PLUGINS: readonly PluginManifest[] = [classic, cartography, ...(import.meta.env?.DEV ? [sample] : [])]
