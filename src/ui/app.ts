import { reactive, watch } from 'vue'

export type Module = 'home' | 'world' | 'settlement'

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

// —— 路由：hash 里写明模块与参数 ——
// #/            首页
// #/world?...   世界地图（查询串是与默认值不同的世界参数）
// #/settlement?... 聚落地图（查询串见 settlement.ts 的 encodeSettlement）
// 旧版的世界分享链接 #seed=...&landRatio=... 没有路径，按世界地图处理
const MODULES: Module[] = ['home', 'world', 'settlement']

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
