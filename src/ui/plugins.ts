import { reactive } from 'vue'
import { defineStrings } from '../i18n'
import { activePlugins, resolveEnabled } from '../kernel'
import { PLUGINS } from '../packs/manifest'
import { storeGet, storeSet } from './app'
import { t } from './i18n'

/**
 * 插件的启停（主线程）。本机只记停用的插件（localStorage 的 plugins.off）：以后新增的内置插件默认启用。
 * 启用清单只决定哪些内容可用，不进地址与世界缓存的键；改动在重新载入页面后生效（内核不做热卸载，见 kernel/）。
 */
const KEY = 'plugins.off'

function readOff(): string[] {
  try {
    const v: unknown = JSON.parse(storeGet(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 按本机的停用清单算出启用的插件（main.ts 启动时用） */
export const enabledPlugins = (): string[] => resolveEnabled(PLUGINS, readOff()).enabled

export const plugins = reactive({
  open: false,
  /** 面板里选定的停用清单（应用之前只改这里） */
  off: readOff(),
})

export interface PluginRow {
  id: string
  name: string
  desc: string
  required: boolean
  /** 面板里的开关 */
  on: boolean
  /** 开着，但依赖的插件（名称）没有启用：应用后也不会启用 */
  missing: string[]
}

const nameOf = (id: string) => PLUGINS.find((p) => p.id === id)?.name ?? id

/** 面板里的各行（清单顺序） */
export function pluginRows(): PluginRow[] {
  const { blocked } = resolveEnabled(PLUGINS, plugins.off)
  return PLUGINS.map((p) => ({
    id: p.id,
    name: p.name,
    desc: p.desc,
    required: !!p.required,
    on: !!p.required || !plugins.off.includes(p.id),
    missing: (blocked.find((b) => b.id === p.id)?.missing ?? []).map(nameOf),
  }))
}

export function togglePlugin(id: string, on: boolean) {
  plugins.off = on ? plugins.off.filter((x) => x !== id) : [...plugins.off.filter((x) => x !== id), id]
}

/** 面板里选定的与正在运行的不同：需要应用 */
export function pluginsDirty() {
  return resolveEnabled(PLUGINS, plugins.off).enabled.join('\n') !== activePlugins().join('\n')
}

export function openPlugins(v = true) {
  plugins.open = v
  // 打开时从存下的清单开始，丢掉上次没有应用的改动
  if (v) plugins.off = readOff()
}

function reloadWith(off: string[]) {
  // 只留清单里有的 id，按清单顺序
  storeSet(KEY, JSON.stringify(PLUGINS.filter((p) => off.includes(p.id) && !p.required).map((p) => p.id)))
  location.reload()
}

/** 应用面板里的改动：存下停用清单并重新载入页面（没有保存的世界与编辑会丢失，先确认） */
export function applyPlugins() {
  if (!pluginsDirty()) return
  if (!window.confirm(t('应用后页面会重新载入，没有保存到世界库的世界与编辑会丢失。继续吗？'))) return
  reloadWith(plugins.off)
}

/**
 * 存档引用了没有启用的插件时的处理：requires 里没有启用的列给用户，确认后启用它们（连同它们的依赖）并重新载入。
 * 返回 true 表示可以照常打开；false 表示不打开（已取消，或即将重新载入）。
 * 不回退到默认内容：换一种内容打开会不声不响地得到另一个世界
 */
export function ensurePlugins(requires: readonly string[] | undefined): boolean {
  const running = activePlugins()
  const missing = (requires ?? []).filter((id) => !running.includes(id))
  if (!missing.length) return true
  const unknown = missing.filter((id) => !PLUGINS.some((p) => p.id === id))
  if (unknown.length) {
    window.alert(t('无法打开：这个世界用到的插件「{names}」不在这个版本里。', { names: unknown.join('、') }))
    return false
  }
  const names = missing.map((id) => t(nameOf(id))).join('、')
  if (!window.confirm(t('这个世界用到了没有启用的插件「{names}」。启用并重新载入页面吗？重新载入后再打开它。', { names }))) return false
  // 连同依赖一起启用
  const need = new Set<string>()
  const add = (id: string) => {
    if (need.has(id)) return
    need.add(id)
    for (const d of PLUGINS.find((p) => p.id === id)?.requires ?? []) add(d)
  }
  missing.forEach(add)
  reloadWith(readOff().filter((id) => !need.has(id)))
  return false
}

defineStrings([
  ['插件', 'Plugins', 'プラグイン'],
  ['插件…', 'Plugins…', 'プラグイン…'],
  ['启用或停用随应用提供的内容。改动在重新载入页面后生效；已经生成的世界不受影响。', 'Enable or disable the content shipped with the app. Changes take effect after the page reloads; worlds already generated are not affected.', 'アプリに同梱の内容を有効・無効にします。変更はページの再読み込み後に反映され、生成済みの世界には影響しません。'],
  ['不可停用', 'Always on', '無効化不可'],
  ['不可停用：默认参数用到它的内容', 'Always on: the default settings use its content', '無効化不可：既定の設定がこの内容を使います'],
  ['已启用', 'Enabled', '有効'],
  ['已停用', 'Disabled', '無効'],
  ['依赖的「{names}」没有启用，应用后它也不会启用', 'It depends on "{names}", which is not enabled, so it will stay off after applying', '依存する「{names}」が無効のため、適用しても有効になりません'],
  ['应用并重新载入', 'Apply and reload', '適用して再読み込み'],
  ['没有待应用的改动', 'No changes to apply', '適用する変更はありません'],
  ['应用后页面会重新载入，没有保存到世界库的世界与编辑会丢失。继续吗？', 'The page will reload after applying; worlds and edits not saved to the library will be lost. Continue?', '適用するとページを再読み込みします。ライブラリに保存していない世界と編集は失われます。続けますか？'],
  ['无法打开：这个世界用到的插件「{names}」不在这个版本里。', 'Cannot open: this world uses the plugin "{names}", which is not part of this version.', '開けません：この世界が使うプラグイン「{names}」はこのバージョンに含まれていません。'],
  ['这个世界用到了没有启用的插件「{names}」。启用并重新载入页面吗？重新载入后再打开它。', 'This world uses the plugin "{names}", which is not enabled. Enable it and reload the page? Open the world again after the reload.', 'この世界は無効になっているプラグイン「{names}」を使います。有効にしてページを再読み込みしますか？再読み込みのあと、もう一度開いてください。'],
  ['古典', 'Classical', '古典'],
  [
    '内置的世界观「古典」：西幻、史诗、东方、和风四种命名风格，分封、郡县、令制三种制度，西式、东方、和风、伊斯兰四种城市文明',
    'The built-in "Classical" setting: four naming styles (Fantasy, Epic, Eastern, Japanese), three polities (feudal, commandery, ritsuryō) and four urban civilizations (Western, Eastern, Japanese, Islamic)',
    '組み込みの世界観「古典」：命名スタイル四種（ファンタジー・叙事詩・中華風・和風）、制度三種（封建・郡県・令制）、都市文明四種（西洋・東方・和風・イスラム）',
  ],
  ['制图风格', 'Map styles', '地図のスタイル'],
  [
    '内置的八种纸图风格（自然地理、奇幻羊皮、航海图、提瓦特、水墨、等高线、政区地图集、战略图）与八种聚落图主题',
    'The eight built-in map styles (Physical, Fantasy parchment, Nautical chart, Teyvat, Ink wash, Contours, Political atlas, Strategy) and the eight town-map themes',
    '組み込みの紙地図スタイル八種（自然地理・ファンタジー羊皮紙・海図・テイワット・水墨・等高線・政区地図帳・戦略図）と、集落図のテーマ八種',
  ],
])
// 示例插件只在开发构建里出现，它的名称与说明也只在开发构建里登记
if (import.meta.env?.DEV) {
  defineStrings([
    ['示例插件', 'Sample plugin', 'サンプルプラグイン'],
    [
      '一个示例世界观（一种命名风格和一种与西式相同的"示例文明"）、一种纸图风格与一种聚落图主题，用来验证插件的启停（只在开发构建里出现）',
      'A sample setting (one naming style and a "Sample" culture identical to the Western one), one map style and one town-map theme, for checking that plugins can be switched on and off (development builds only)',
      'サンプルの世界観（命名スタイル一種と、西洋式と同じ「サンプル」文明）、紙地図のスタイル一種、集落図のテーマ一種。プラグインの有効・無効を確認するためのもの（開発ビルドのみ）',
    ],
  ])
}
