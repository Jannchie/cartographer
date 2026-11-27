import { reactive, watch } from 'vue'
import type { Label, Registry } from '../kernel'
// 先定下界面语言：它要读地址里的 lang= 参数，而下面启动时会把地址规整掉
import '../i18n'

export type Module = 'home' | 'world' | 'settlement' | 'grow'

export function storeGet(k: string) {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
export function storeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v)
  } catch {
    // 隐私模式等场景不可用，忽略
  }
}

/**
 * 可以被参数引用的一类内容：注册表（扩展点），或同样有名称、能核对 id、给得出默认条目的对象（城市形制、沙盘地面风格）
 */
export type RefTarget = Pick<Registry<unknown>, 'label' | 'has' | 'defaultId'>

/** 舞台上的提示：来自链接或本机存储的 what「id」不可用，已换成默认的。点一下收起（见 kit/Notices.vue） */
export interface Notice {
  source: 'link' | 'stored'
  what: Label
  id: string
}

/**
 * 核对一组参数里对插件内容的引用：refs 说明哪个键引用哪一类内容。
 * 引用的内容不可用（所属的插件停用了，或已经不在这个版本里）时就地换成那一类的默认条目，返回要显示的提示。
 * source 是这组参数的来源（链接，或本机存下的选择）。存档不走这里：存档缺了内容是提示启用插件，不换成默认的
 */
export function resolveRefs<T extends object>(obj: T, refs: { [K in keyof T]?: RefTarget }, source: Notice['source']): Notice[] {
  const out: Notice[] = []
  for (const k of Object.keys(refs) as (keyof T & string)[]) {
    const target = refs[k]!
    const v = obj[k]
    if (typeof v !== 'string' || v === '' || target.has(v)) continue
    ;(obj as Record<string, unknown>)[k] = target.defaultId()
    out.push({ source, what: target.label, id: v })
  }
  return out
}

/**
 * 读本机存下的一个选项。
 * - allowed 是取值的列表：不在其中的回到 fallback（旧版的值先按 renamed 换成新值），不提示；
 * - allowed 是一类可引用的内容：没存过用它的默认条目；存下的不可用时也换成默认条目、立即写回存储，并往 notices 里记一条提示
 */
export function stored<T extends string>(key: string, allowed: readonly string[], fallback: T, renamed?: Record<string, T>): T
export function stored(key: string, allowed: RefTarget, notices: Notice[]): string
export function stored(key: string, allowed: readonly string[] | RefTarget, a: unknown, renamed: Record<string, string> = {}): string {
  const v = storeGet(key) ?? ''
  if ('has' in allowed) {
    const box = { value: v || allowed.defaultId() }
    const n = resolveRefs(box, { value: allowed }, 'stored')
    if (n.length) storeSet(key, box.value)
    ;(a as Notice[]).push(...n)
    return box.value
  }
  return renamed[v] ?? (allowed.includes(v) ? v : (a as string))
}

/** 读本机存下的一组选项（JSON 对象），核对其中对插件内容的引用（见 resolveRefs）：有不可用的就换成默认条目、立即写回，提示记进 notices */
export function storedJson<T extends object>(key: string, refs: { [K in keyof T]?: RefTarget }, notices: Notice[]): Partial<T> {
  let obj: Partial<T> = {}
  try {
    const v: unknown = JSON.parse(storeGet(key) ?? '{}')
    if (v && typeof v === 'object') obj = v as Partial<T>
  } catch {
    // 存坏了：当作没存过
  }
  const n = resolveRefs(obj as T, refs, 'stored')
  if (n.length) storeSet(key, JSON.stringify(obj))
  notices.push(...n)
  return obj
}

// —— 路由：hash 里写明模块与参数 ——
// #/            首页
// #/world?...   世界地图（查询串是与默认值不同的世界参数）
// #/settlement?... 聚落地图（查询串见 settlement.ts 的 encodeSettlement）
// #/grow?...   村落生长（查询串是地形参数，见 grow/grow.ts）
// 旧版的世界分享链接 #seed=...&landRatio=... 没有路径，按世界地图处理
const MODULES: Module[] = ['home', 'world', 'settlement', 'grow']

export function parseRoute(hash: string): { module: Module; query: URLSearchParams } | null {
  const h = hash.replace(/^#/, '')
  if (!h) return null
  if (!h.startsWith('/')) return { module: 'world', query: new URLSearchParams(h) }
  const qi = h.indexOf('?')
  const name = (qi < 0 ? h : h.slice(0, qi)).replace(/^\/+|\/+$/g, '')
  const module = (MODULES as string[]).includes(name) ? (name as Module) : 'home'
  return { module, query: new URLSearchParams(qi < 0 ? '' : h.slice(qi + 1)) }
}
export function routeHash(m: Module, q?: URLSearchParams) {
  const s = q?.toString() ?? ''
  return `#/${m === 'home' ? '' : m}${s ? '?' + s : ''}`
}

const initial = parseRoute(location.hash)
/** 打开页面时 URL 里带给该模块的参数（URL 指向别的模块时为 null） */
export function initialQuery(m: Module) {
  return initial?.module === m ? initial.query : null
}

/** 应用外壳：当前模块（首页 / 世界地图 / 聚落地图） */
export const app = reactive({
  // URL 指明了模块就进那个模块（刷新留在原处，分享链接直达）；否则回到上次所在的模块，首次打开显示首页
  module: (initial?.module ?? (storeGet('module') as Module | null) ?? 'home') as Module,
})

/** 各模块登记：当前参数编码成查询串，以及 URL 被外部改动（前进后退、手改地址栏）时应用新参数 */
interface RouteHandler {
  query: () => URLSearchParams
  apply: (q: URLSearchParams) => void
}
const handlers: Partial<Record<Module, RouteHandler>> = {}
const hashOf = (m: Module) => routeHash(m, handlers[m]?.query())

export function registerRoute(m: Module, h: RouteHandler) {
  handlers[m] = h
  // 当前就在该模块：把地址规范成新格式（旧链接、空 hash）
  if (app.module === m) syncRoute(m)
}
/** 参数提交后改写地址（replaceState，不增加历史记录）；不在该模块时不动地址 */
export function syncRoute(m: Module) {
  if (app.module !== m) return
  const h = hashOf(m)
  if (h !== location.hash) history.replaceState(null, '', h)
}

// 切换模块：写一条新的历史记录，浏览器后退可以回到上一个模块
let fromNav = false
watch(
  () => app.module,
  (m) => {
    storeSet('module', m)
    if (fromNav) return
    const h = hashOf(m)
    if (h !== location.hash) history.pushState(null, '', h)
  },
  // 同步执行：前进后退引起的切换能靠 fromNav 区分出来
  { flush: 'sync' },
)
if (app.module === 'home' && location.hash !== '#/') history.replaceState(null, '', '#/')

// 前进后退或手改地址：切到对应模块，参数与当前不同时才重新生成（应用自己改写地址用的是 replaceState/pushState，不会触发这里）
function onNav() {
  const r = parseRoute(location.hash) ?? { module: 'home' as Module, query: new URLSearchParams() }
  if (r.module !== app.module) {
    fromNav = true
    app.module = r.module
    fromNav = false
  }
  const h = handlers[r.module]
  if (h && r.query.toString() !== h.query().toString()) h.apply(r.query)
  // 旧格式、不规范或被拒绝的参数：就地改写成与实际状态一致的规范地址
  syncRoute(r.module)
}
window.addEventListener('popstate', onNav)
window.addEventListener('hashchange', onNav)

/** 触发浏览器下载：data 是 URL（如 dataURL）或 Blob（临时生成对象 URL，稍后释放） */
export function download(data: string | Blob, name: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** 参数的签名（键排序后的 JSON）：与上次生成所用的参数比较，判断是否改过、还没重新生成 */
export function paramSig(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  )
}
