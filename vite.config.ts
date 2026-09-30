import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * virtual:gen-hash —— 生成器源码（src/gen）的哈希，用作世界缓存的版本号：
 * 改了生成算法，浏览器里缓存的旧世界自动失效。
 */
function genHash(): Plugin {
  const id = 'virtual:gen-hash'
  const dir = resolve(import.meta.dirname, 'src/gen')
  return {
    name: 'gen-hash',
    resolveId: (s) => (s === id ? '\0' + id : undefined),
    load(s) {
      if (s !== '\0' + id) return
      const h = createHash('sha1')
      // 连同子目录（地球底图的数据也算生成器的一部分）
      const walk = (d: string, rel: string) => {
        for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
          const path = join(d, e.name)
          if (e.isDirectory()) walk(path, `${rel}${e.name}/`)
          else {
            this.addWatchFile(path)
            h.update(rel + e.name).update(readFileSync(path))
          }
        }
      }
      walk(dir, '')
      return `export default ${JSON.stringify(h.digest('hex').slice(0, 12))}`
    },
    handleHotUpdate({ file, server }) {
      if (!resolve(file).startsWith(dir)) return
      const m = server.moduleGraph.getModuleById('\0' + id)
      if (m) server.moduleGraph.invalidateModule(m)
    },
  }
}

export default defineConfig({
  // 相对路径：同一份构建既能放在根路径，也能放在 GitHub Pages 的 /cartographer/ 子路径下
  base: './',
  plugins: [vue(), genHash()],
  worker: { format: 'es', plugins: () => [genHash()] },
  // Git Bash 崩溃时会在工作目录留下 bash.exe.stackdump，被监听时锁着会让开发服务器退出
  server: { port: 5190, watch: { ignored: ['**/*.stackdump'] } },
  build: { chunkSizeWarningLimit: 1100 },
})
