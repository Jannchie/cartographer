import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * virtual:gen-hash —— 生成器源码（src/gen）的哈希，用作世界缓存的版本号：
 * 改了生成算法，浏览器里缓存的旧世界自动失效。
 */
function genHash(): Plugin {
  const id = 'virtual:gen-hash'
  const dir = resolve(__dirname, 'src/gen')
  return {
    name: 'gen-hash',
    resolveId: (s) => (s === id ? '\0' + id : undefined),
    load(s) {
      if (s !== '\0' + id) return
      const h = createHash('sha1')
      for (const f of readdirSync(dir).sort()) {
        const path = join(dir, f)
        this.addWatchFile(path)
        h.update(f).update(readFileSync(path))
      }
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
  plugins: [genHash()],
  worker: { format: 'es', plugins: () => [genHash()] },
  server: { port: 5190 },
  build: { chunkSizeWarningLimit: 900 },
})
