import { reactive } from 'vue'
import { defineStrings } from '../i18n'
import { activePlugins, requiredPlugins, resolveEnabled, type Label } from '../kernel'
import { PLUGINS } from '../packs/manifest'
import { storeGet, storeSet } from './app'
import { t, tl } from './i18n'

/**
 * 插件的启停（主线程）。本机只记停用的插件（localStorage 的 plugins.off）：以后新增的内置插件默认启用。
 * 启用清单只决定哪些内容可用，不进地址与世界缓存的键；改动在重新载入页面后生效（内核不做热卸载，见 kernel/）。
 * 哪些插件不可停用由内核给出（登记了默认条目的那些）：面板上锁住它们，停用清单写入时（reloadWith）也不收它们。
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

/** 按本机的停用清单算出启用的插件（启动时用） */
export const enabledPlugins = (): string[] => resolveEnabled(PLUGINS, readOff()).enabled

/**
 * 启动失败时的补救（见 main.ts）：本机存着停用清单就清掉它并返回 true，调用方重新载入试一次。
 * 停用清单只由面板写入、不会含不可停用的插件，但它存在本机，可能被手改，也可能是旧版本留下的
 */
export function resetDisabledPlugins(): boolean {
  if (!readOff().length) return false
  storeSet(KEY, '[]')
  return true
}

export const plugins = reactive({
  open: false,
  /** 面板里选定的停用清单（应用之前只改这里） */
  off: readOff(),
})

export interface PluginRow {
  id: string
  name: Label
  desc: Label
  required: boolean
  /** 面板里的开关 */
  on: boolean
  /** 开着，但依赖的插件（名称）没有启用：应用后也不会启用 */
  missing: Label[]
}

const nameOf = (id: string): Label => PLUGINS.find((p) => p.id === id)?.name ?? { zh: id, en: id, ja: id }

/** 面板里的各行（清单顺序） */
export function pluginRows(): PluginRow[] {
  const { blocked } = resolveEnabled(PLUGINS, plugins.off)
  const required = requiredPlugins()
  return PLUGINS.map((p) => ({
    id: p.id,
    name: p.name,
    desc: p.desc,
    required: required.includes(p.id),
    on: !plugins.off.includes(p.id),
    missing: (blocked.find((b) => b.id === p.id)?.missing ?? []).map(nameOf),
  }))
}

export function togglePlugin(id: string, on: boolean) {
  plugins.off = on ? plugins.off.filter((x) => x !== id) : [...plugins.off.filter((x) => x !== id), id]
}

/** 面板里选定的与正在运行的不同：需要应用 */
export function pluginsDirty() {
  return resolveEnabled(PLUGINS, plugins.off).enabled.join() !== activePlugins().join()
}

export function openPlugins(v = true) {
  plugins.open = v
  // 打开时从存下的清单开始，丢掉上次没有应用的改动
  if (v) plugins.off = readOff()
}

/** 存下停用清单并重新载入。只留清单里有的、可以停用的 id，按清单顺序 */
function reloadWith(off: readonly string[]) {
  const required = requiredPlugins()
  storeSet(KEY, JSON.stringify(PLUGINS.filter((p) => off.includes(p.id) && !required.includes(p.id)).map((p) => p.id)))
  location.reload()
}

/** 应用面板里的改动：存下停用清单并重新载入页面（没有保存的世界与编辑会丢失，先确认） */
export function applyPlugins() {
  if (!pluginsDirty()) return
  if (!window.confirm(t('应用后页面会重新载入，没有保存到世界库的世界与编辑会丢失。继续吗？'))) return
  reloadWith(plugins.off)
}

/**
 * 存档依赖了没有启用的插件时的处理：requires 里没有启用的列给用户，确认后启用它们（连同它们的依赖）并重新载入。
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
  const names = missing.map((id) => tl(nameOf(id))).join('、')
  if (!window.confirm(t('这个世界用到了没有启用的插件「{names}」。启用并重新载入页面吗？重新载入后再打开它。', { names }))) return false
  // 连同依赖一起启用：依赖都排在清单里更靠前的位置，倒着扫一遍就是闭包
  const need = new Set(missing)
  for (const p of [...PLUGINS].reverse()) if (need.has(p.id)) for (const d of p.requires ?? []) need.add(d)
  reloadWith(readOff().filter((id) => !need.has(id)))
  return false
}

defineStrings([
  ['插件', 'Plugins', 'プラグイン'],
  ['插件…', 'Plugins…', 'プラグイン…'],
  ['启用或停用随应用提供的内容。改动在重新载入页面后生效；已经生成的世界不受影响。', 'Enable or disable the content shipped with the app. Changes take effect after the page reloads; worlds already generated are not affected.', 'アプリに同梱の内容を有効・無効にします。変更はページの再読み込み後に反映され、生成済みの世界には影響しません。'],
  ['不可停用', 'Always on', '無効化不可'],
  ['不可停用：默认的选择用到它的内容', 'Always on: the default choices use its content', '無効化不可：既定の選択がこの内容を使います'],
  ['已启用', 'Enabled', '有効'],
  ['已停用', 'Disabled', '無効'],
  ['依赖的「{names}」没有启用，应用后它也不会启用', 'It depends on "{names}", which is not enabled, so it will stay off after applying', '依存する「{names}」が無効のため、適用しても有効になりません'],
  ['应用并重新载入', 'Apply and reload', '適用して再読み込み'],
  ['没有待应用的改动', 'No changes to apply', '適用する変更はありません'],
  ['应用后页面会重新载入，没有保存到世界库的世界与编辑会丢失。继续吗？', 'The page will reload after applying; worlds and edits not saved to the library will be lost. Continue?', '適用するとページを再読み込みします。ライブラリに保存していない世界と編集は失われます。続けますか？'],
  ['无法打开：这个世界用到的插件「{names}」不在这个版本里。', 'Cannot open: this world uses the plugin "{names}", which is not part of this version.', '開けません：この世界が使うプラグイン「{names}」はこのバージョンに含まれていません。'],
  ['这个世界用到了没有启用的插件「{names}」。启用并重新载入页面吗？重新载入后再打开它。', 'This world uses the plugin "{names}", which is not enabled. Enable it and reload the page? Open the world again after the reload.', 'この世界は無効になっているプラグイン「{names}」を使います。有効にしてページを再読み込みしますか？再読み込みのあと、もう一度開いてください。'],
])
