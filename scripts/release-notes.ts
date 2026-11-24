/**
 * 由 src/changelog.ts 生成某个版本的 GitHub Release 说明（英 / 中 / 日三段），并检查更新日志：
 * 第一条的版本与 package.json 一致，每个版本三种语言的条数一致。检查不过时退出码为 1。
 *
 *   pnpm release:notes [v0.2.0] > notes.md     # 不给版本时取最新一条
 *   pnpm release:notes --check                 # 只检查（构建时跑）
 */
import { readFileSync } from 'node:fs'
import { CHANGELOG } from '../src/changelog'

const SITE = 'https://jannchie.github.io/cartographer/'
const fail = (msg: string) => {
  console.error(msg)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
if (CHANGELOG[0]?.version !== pkg.version) fail(`更新日志第一条是 ${CHANGELOG[0]?.version}，package.json 是 ${pkg.version}`)
const uneven = CHANGELOG.filter((r) => !r.notes.zh.length || r.notes.en.length !== r.notes.zh.length || r.notes.ja.length !== r.notes.zh.length)
if (uneven.length) fail(`三种语言的条数不一致：${uneven.map((r) => r.version).join('、')}`)

const args = process.argv.slice(2)
if (args.includes('--check')) process.exit(0)
const want = (args[0] ?? '').replace(/^v/, '') || CHANGELOG[0].version
const r = CHANGELOG.find((x) => x.version === want)
if (!r) fail(`更新日志里没有 ${want}`)
const section = (title: string, items: string[]) => [`### ${title}`, '', ...items.map((x) => `- ${x}`), ''].join('\n')
console.log([SITE, '', section('English', r!.notes.en), section('中文', r!.notes.zh), section('日本語', r!.notes.ja)].join('\n'))
