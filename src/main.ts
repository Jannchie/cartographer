import { createApp } from 'vue'
import './style.css'
import { bootPlugins } from './packs/boot'
import { enabledPlugins } from './ui/plugins'

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
  // 插件入口没能载入（多半是网络）：界面起不来，至少把原因写在页面上
  document.getElementById('root')!.textContent = `Cartographer failed to start: ${err instanceof Error ? err.message : String(err)}`
})
