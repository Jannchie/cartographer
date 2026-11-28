// 架构约束检查：pnpm check:arch。规则的说明见 docs/architecture.md，本文件是它的可执行版本。
// 1. 分层：每个模块按路径归入一层，只能导入本层与 ALLOWED 里列出的层（类型导入同样计入）；
// 2. 插件之间：插件只能导入自己与清单里 requires 列出的插件；
// 3. 插件的 world 层只能导入 world 层、生成器与内核（世界缓存的版本号只按这些文件计算，见 vite.config.ts 的 gen-hash）；
// 4. 运行时的导入不成环（只有类型导入的环不算）；
// 5. src 下的每个文件都能从某个入口（应用、Worker、对外接口、离线脚本）沿导入走到。
// 有一项不成立，退出码是 1。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PLUGINS } from '../src/packs/manifest'

const ROOT = resolve(import.meta.dirname, '..')

type Layer = 'kernel' | 'base' | 'gen' | 'settlement' | 'render' | 'editor' | 'app' | 'plugin-world' | 'plugin' | 'packs' | 'ui' | 'entry'

/** 组合根：把各层接起来的入口文件，不受分层限制 */
const ENTRIES = new Set([
  'src/main.ts',
  'src/worker.ts',
  'src/ui/settlement/history.worker.ts',
  // 生长引擎对外的画图入口：按需启动最少的插件再画图（见 package.json 的 exports）
  'src/settlement/grow/paint.ts',
  // 对外接口的编译期核对，不被任何入口导入
  'src/settlement/grow/check-api.ts',
])

/** 每层能导入的其他层（本层总是可以） */
const ALLOWED: Record<Layer, readonly Layer[]> = {
  kernel: [],
  base: ['kernel'],
  gen: ['kernel'],
  settlement: ['kernel', 'base', 'gen'],
  render: ['kernel', 'base', 'gen', 'settlement'],
  editor: ['kernel', 'base', 'gen', 'render'],
  app: ['kernel', 'base', 'gen'],
  // world 层只能用计入世界缓存版本号的代码（生成器、内核、world 层自己）
  'plugin-world': ['kernel', 'gen'],
  plugin: ['kernel', 'base', 'gen', 'settlement', 'render', 'plugin-world'],
  packs: ['kernel', 'plugin', 'plugin-world'],
  ui: ['kernel', 'base', 'gen', 'settlement', 'render', 'editor', 'app', 'packs', 'entry'],
  entry: ['kernel', 'base', 'gen', 'settlement', 'render', 'editor', 'app', 'plugin-world', 'plugin', 'packs', 'ui', 'entry'],
}

/**
 * 暂时容许的例外：键是"导入方 -> 被导入方"或文件，值是原因。只减不增；
 * 修掉一项就删掉一项（检查会提示已经不存在的例外）。
 */
const EXCEPTIONS: Record<string, string> = {
  // 运行时的环（文件按"a <-> b"写，取环里字典序最小的两个文件）
  'cycle:src/gen/earth/realWorld.ts <-> src/gen/world.ts': '待拆：地球底图与世界生成互相调用',
  'cycle:src/settlement/ctx.ts <-> src/settlement/history.ts': '待拆：成长史与生成上下文互相调用',
  'cycle:src/settlement/compose/castle.ts <-> src/settlement/compose/chinese.ts': '待拆：构图与片区互相调用',
  'cycle:src/render/town3d/gates.ts <-> src/render/town3d/works.ts': '待拆：城门与城防工程互相调用',
}

/** 不要求从入口可达的文件（前缀）：原因见值 */
const UNREACHABLE_OK: Record<string, string> = {
  'src/render/atlas/symbols/': '实验中的符号套，尚未接入纸图风格（待产品决定：接入或删除）',
}

// ———————————————————————— 收集文件与导入 ————————————————————————

const files: string[] = []
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|vue)$/.test(e)) files.push(p)
  }
}
walk(join(ROOT, 'src'))
const scriptFiles: string[] = []
for (const d of ['scripts', 'video']) {
  const before = files.length
  walk(join(ROOT, d))
  scriptFiles.push(...files.splice(before))
}

const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

/** 去掉注释，保留字符串（导入路径在字符串里） */
const stripComments = (s: string) =>
  s.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str: string | undefined) => str ?? m.replace(/[^\n]/g, ' '))

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const b = resolve(dirname(from), spec.replace(/\?.*$/, ''))
  for (const c of [b, b + '.ts', b + '.d.ts', b + '.vue', join(b, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c
  return null
}

interface Edge {
  to: string
  /** 只导入类型 */
  typeOnly: boolean
}
const IMPORT = /\b(import|export)\s+([^'"`;]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g
const typeOnly = (clause: string) => {
  const c = clause.trim()
  if (c.startsWith('type ')) return true
  const inner = /^\{([^}]*)\}$/.exec(c)
  return !!inner && inner[1].split(',').map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith('type '))
}
const unresolved: string[] = []
function edgesOf(file: string): Edge[] {
  const code = stripComments(readFileSync(file, 'utf8'))
  const out: Edge[] = []
  for (const m of code.matchAll(IMPORT)) {
    const spec = m[3] ?? m[4] ?? m[5] ?? m[6]
    const to = resolveSpec(file, spec)
    if (!to) {
      if (spec.startsWith('.')) unresolved.push(`${rel(file)}: ${spec}`)
      continue
    }
    out.push({ to: rel(to), typeOnly: m[2] !== undefined && typeOnly(m[2]) })
  }
  return out
}
const graph = new Map<string, Edge[]>()
for (const f of [...files, ...scriptFiles]) graph.set(rel(f), edgesOf(f))

// ———————————————————————— 归层 ————————————————————————

const pluginIds = new Set(PLUGINS.map((p) => p.id).concat(['sample']))
function layerOf(f: string): Layer | null {
  if (ENTRIES.has(f)) return 'entry'
  const p = f.split('/')
  if (p[0] !== 'src') return null
  if (p[1] === 'kernel') return 'kernel'
  if (f === 'src/i18n.ts' || f === 'src/changelog.ts') return 'base'
  if (p[1] === 'packs') {
    if (p.length === 3) return 'packs'
    return p[3] === 'world.ts' || p[3] === 'world' ? 'plugin-world' : 'plugin'
  }
  const top: Record<string, Layer> = { gen: 'gen', settlement: 'settlement', render: 'render', editor: 'editor', app: 'app', ui: 'ui' }
  return top[p[1]] ?? null
}
const pluginOf = (f: string) => (f.startsWith('src/packs/') && f.split('/').length > 3 ? f.split('/')[2] : null)
const requires = new Map(PLUGINS.map((p) => [p.id, new Set(p.requires ?? [])]))
// 示例插件只在开发构建的清单里（离线脚本按非开发构建处理）；它的依赖照清单写
requires.set('sample', new Set(['classic', 'cartography']))

const problems: string[] = []
const usedExceptions = new Set<string>()

for (const [from, edges] of graph) {
  if (from.endsWith('.d.ts')) continue
  const lf = layerOf(from)
  if (!lf) continue
  for (const { to } of edges) {
    const lt = layerOf(to)
    if (!lt) continue
    if (lt !== lf && !ALLOWED[lf].includes(lt)) {
      const key = `${from} -> ${to}`
      if (EXCEPTIONS[key]) usedExceptions.add(key)
      else problems.push(`分层：${key}（${lf} 不能导入 ${lt}）`)
    }
    const pf = pluginOf(from)
    const pt = pluginOf(to)
    if (pf && pt && pf !== pt && !requires.get(pf)?.has(pt)) problems.push(`插件依赖：${from} -> ${to}（插件 ${pf} 没有在清单里依赖 ${pt}）`)
  }
}
for (const p of pluginIds) if (!existsSync(join(ROOT, 'src/packs', p))) problems.push(`插件清单里的 ${p} 在 src/packs 下没有目录`)

// ———————————————————————— 运行时的环 ————————————————————————

{
  let idx = 0
  const I = new Map<string, number>()
  const L = new Map<string, number>()
  const stack: string[] = []
  const on = new Set<string>()
  const runtime = (f: string) => (graph.get(f) ?? []).filter((e) => !e.typeOnly && graph.has(e.to)).map((e) => e.to)
  const strong = (v: string) => {
    I.set(v, idx)
    L.set(v, idx++)
    stack.push(v)
    on.add(v)
    for (const w of runtime(v)) {
      if (!I.has(w)) {
        strong(w)
        L.set(v, Math.min(L.get(v)!, L.get(w)!))
      } else if (on.has(w)) L.set(v, Math.min(L.get(v)!, I.get(w)!))
    }
    if (L.get(v) === I.get(v)) {
      const c: string[] = []
      let w: string
      do {
        w = stack.pop()!
        on.delete(w)
        c.push(w)
      } while (w !== v)
      if (c.length > 1) {
        c.sort()
        const key = `cycle:${c[0]} <-> ${c[1]}`
        if (EXCEPTIONS[key]) usedExceptions.add(key)
        else problems.push(`运行时的环：${c.join(' ')}`)
      }
    }
  }
  for (const v of graph.keys()) if (v.startsWith('src/') && !I.has(v)) strong(v)
}

// ———————————————————————— 可达性 ————————————————————————

{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports?: Record<string, { default: string; types?: string }> }
  const roots = [...ENTRIES, ...scriptFiles.map(rel)]
  for (const e of Object.values(pkg.exports ?? {})) {
    roots.push(e.default.replace(/^\.\//, ''))
    if (e.types) roots.push(e.types.replace(/^\.\//, ''))
  }
  const seen = new Set<string>()
  const todo = roots.filter((r) => graph.has(r))
  while (todo.length) {
    const f = todo.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const e of graph.get(f) ?? []) todo.push(e.to)
  }
  for (const f of graph.keys()) {
    if (!f.startsWith('src/') || seen.has(f) || /\.d\.ts$/.test(f) && f.split('/').length === 2) continue
    const ok = Object.keys(UNREACHABLE_OK).find((p) => f.startsWith(p))
    if (ok) usedExceptions.add(ok)
    else problems.push(`不可达：${f}（没有入口导入它；不再需要就删掉）`)
  }
}

for (const u of unresolved) problems.push(`导入的文件不存在：${u}`)
for (const k of [...Object.keys(EXCEPTIONS), ...Object.keys(UNREACHABLE_OK)]) if (!usedExceptions.has(k)) problems.push(`例外已经不存在，从 scripts/check-arch.ts 里删掉：${k}`)

if (problems.length) {
  for (const p of problems) console.log(p)
  console.log(`\n${problems.length} 处违反架构约束（规则见 docs/architecture.md）`)
  process.exit(1)
}
console.log(`ok：${graph.size} 个文件符合架构约束（${Object.keys(EXCEPTIONS).length + Object.keys(UNREACHABLE_OK).length} 项登记在案的例外）`)
