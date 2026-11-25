import type { PluginManifest } from '../kernel'

/**
 * 插件清单：随应用一起构建的全部插件。数组的顺序就是启动与登记的顺序（界面选项的顺序、先登记为准的词条都取决于它），
 * 依赖必须排在前面；用户只能启停，不能调整顺序。清单不引用插件的代码：各层的入口在同目录的入口表里
 *（world.ts、settlement.ts、town3d.ts），启用时才载入。
 *
 * 新增插件：在本目录下建一个目录，按层写入口模块（world.ts、settlement.ts、town3d.ts，默认导出 LayerSetup），
 * 列进下面的清单，并把各层的入口列进对应的入口表。world 层的代码只放在插件目录的 world.ts 与 world/ 里
 *（世界缓存的版本号按这两处计算，见 vite.config.ts 的 gen-hash）。
 */

/** 内置的古典文明：默认参数指向它的内容，不可停用 */
const classic: PluginManifest = {
  id: 'classic',
  name: '古典文明',
  desc: '前工业时代的四种城市文明：西式、东方、和风、伊斯兰，以及世界上的文化建哪种城的规则',
  required: true,
}

/** 示例插件：只在开发构建里出现，用来验证启停与缺失引用的处理 */
const sample: PluginManifest = {
  id: 'sample',
  name: '示例插件',
  desc: '登记一种与西式相同的"示例文明"，用来验证插件的启停（只在开发构建里出现）',
  requires: ['classic'],
  dev: true,
}

// 离线脚本（Node）里没有 import.meta.env：按非开发构建处理
export const PLUGINS: readonly PluginManifest[] = [classic, ...(import.meta.env?.DEV ? [sample] : [])]
