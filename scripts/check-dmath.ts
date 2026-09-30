// 检查生成代码（src/gen、src/settlement）没有用与引擎实现相关的写法：pnpm check:dmath
// - Math.sin 之类与 ** 运算符：各引擎末位取整不同，一律改用 src/gen/dmath.ts
// - sort(() => 随机)：洗牌结果与抽签次数随排序实现而变，改用 Fisher–Yates
// 否则同一个种子会在不同浏览器里生成不同的世界
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BANNED = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt)\b/g
const files: string[] = []
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.ts') && !p.endsWith('dmath.ts')) files.push(p)
  }
}
walk('src/gen')
walk('src/settlement')

let bad = 0
for (const file of files) {
  // 去掉注释与字符串（按行报位置，替换时保留换行）
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '))
  code.split('\n').forEach((line, i) => {
    const hits = [...line.matchAll(BANNED)].map((m) => m[0])
    if (line.includes('**')) hits.push('**')
    // 随机比较函数的 sort：结果与比较次数随引擎的排序实现而变（改用 Fisher–Yates 洗牌）
    if (/\.sort\(\s*\(\s*\)\s*=>/.test(line)) hits.push('sort(() => …)')
    for (const h of hits) {
      console.log(`${file}:${i + 1}  ${h}`)
      bad++
    }
  })
}
if (bad) {
  console.log(`\n${bad} 处写法与引擎实现相关（见本文件开头的说明）`)
  process.exit(1)
}
console.log(`ok：${files.length} 个文件没有与引擎实现相关的写法`)
