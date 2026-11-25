import { createApp } from 'vue'
import './style.css'
// 世界生成的线程先建起来：它载入脚本、启动插件与下面主线程的启动并行
import './ui/world/genWorker'
import { bootPlugins } from './packs/boot'
import { enabledPlugins, resetDisabledPlugins } from './ui/plugins'

/**
 * 入口：先启动插件，再载入并挂载界面。界面的模块在求值时就读注册表（默认参数、地址里的参数、选项列表），
 * 所以用动态导入放在启动之后。启用的插件按本机的停用清单算出（见 ui/plugins.ts），主线程载入全部层（见 packs/boot.ts）。
 */
async function start() {
  await bootPlugins(enabledPlugins())
  const { default: App } = await import('./ui/App.vue')
  createApp(App).mount('#root')
}

start().catch((err) => {
  console.error(err)
  // 本机存着停用清单时，可能是它停用了不该停的插件（少了某类内容的默认条目）：清掉它重新载入试一次
  if (resetDisabledPlugins()) return location.reload()
  // 再不行（多半是入口没能载入）：界面起不来，至少把原因写在页面上
  document.getElementById('root')!.textContent = `Cartographer failed to start: ${err instanceof Error ? err.message : String(err)}`
})
