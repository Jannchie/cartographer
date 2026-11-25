/**
 * 聚落层入口（副作用模块）：注册内置的文化包。聚落生成的入口（settlement/generate.ts）导入本模块，
 * 主线程与 Worker 都在模块加载时完成注册。沙盘的建筑套件由 ./town3d.ts 另行注册，世界层的规则由 ./world.ts 登记。
 *
 * 新增文化包：在本目录下建一个目录，导出 CulturePack，列进下面的 PACKS。
 */
import { defineStrings } from '../i18n'
import { registerPack } from '../settlement/culture'
import { schemeStrings } from '../settlement/people'
import { classic } from './classic'

const PACKS = [classic]

for (const pack of PACKS) {
  registerPack(pack)
  // 界面词条：包自己的，再是各文明职业名的英文、日文（界面按中文键翻译）
  if (pack.strings) defineStrings(pack.strings)
  for (const c of pack.cultures) defineStrings(schemeStrings(c.people.scheme))
}
