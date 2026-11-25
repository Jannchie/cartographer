import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * virtual:gen-hash —— 世界生成所用源码的哈希，用作世界缓存的版本号：改了生成算法，浏览器里缓存的旧世界自动失效。
 * 范围是世界生成的 Worker 会载入的生成代码：生成器（src/gen）、插件内核（src/kernel）、
 * 插件清单与 world 层的入口表（src/packs/manifest.ts、src/packs/world.ts），
 * 以及各插件的 world 层（src/packs/<插件>/world.ts 与 world/ 目录——插件的 world 层代码只放在这两处）。
 */
function genHash(): Plugin {
  const id = 'virtual:gen-hash'
  const src = resolve(import.meta.dirname, 'src')
  const packs = join(src, 'packs')
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  /** 计入哈希的文件与目录；每次计算时现列，新增的插件自动计入 */
  const roots = () => [
    join(src, 'gen'),
    join(src, 'kernel'),
    join(packs, 'manifest.ts'),
    join(packs, 'world.ts'),
    ...readdirSync(packs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort(byName)
      .flatMap((e) => [join(packs, e.name, 'world.ts'), join(packs, e.name, 'world')])
      .filter((p) => existsSync(p)),
  ]
  /** 路径在不在计入哈希的范围里（热更新时判断；插件的 world 层按路径的形状判断，不要求文件已经存在） */
  const covered = (file: string) => {
    const f = resolve(file)
    if (f.startsWith(join(src, 'gen') + sep) || f.startsWith(join(src, 'kernel') + sep)) return true
    if (!f.startsWith(packs + sep)) return false
    const [top, layer] = f.slice(packs.length + 1).split(sep)
    return layer === undefined ? top === 'manifest.ts' || top === 'world.ts' : layer === 'world.ts' || layer === 'world'
  }
  return {
    name: 'gen-hash',
    resolveId: (s) => (s === id ? '\0' + id : undefined),
    load(s) {
      if (s !== '\0' + id) return
      const h = createHash('sha1')
      // 文件以相对 src 的路径记名
      const add = (path: string) => {
        this.addWatchFile(path)
        h.update(path.slice(src.length + 1).split(sep).join('/')).update(readFileSync(path))
      }
      // 连同子目录（地球底图的数据也算生成器的一部分）
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true }).sort(byName)) {
          const path = join(d, e.name)
          if (e.isDirectory()) walk(path)
          else add(path)
        }
      }
      for (const r of roots()) {
        if (statSync(r).isDirectory()) walk(r)
        else add(r)
      }
      return `export default ${JSON.stringify(h.digest('hex').slice(0, 12))}`
    },
    handleHotUpdate({ file, server }) {
      if (!covered(file)) return
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
  server: { port: 5190, watch: { ignored: ['**/*.stackdump', '**/.claude/**'] } },
  // 依赖预扫描默认爬根目录下所有 html；.claude/worktrees 里的工作树副本（含其 dist）不是入口
  optimizeDeps: { entries: ['**/*.html', '!.claude/**', '!**/dist/**'] },
  build: { chunkSizeWarningLimit: 1100 },
})
