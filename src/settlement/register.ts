import { defineStrings } from '../i18n'
import type { Host } from '../kernel'
import { Cultures, type CultureDef } from './culture'
import { schemeStrings } from './people'

/**
 * 登记一组文明（插件的 settlement 层入口调用）：按给出的顺序登记，界面上的选项也按这个顺序。
 * strings 是这组文明自己的界面词条（中、英、日），在各文明的职业名之前登记——同一个中文键先登记的为准；
 * default 是其中登记为默认文明的那个（没有指定文明时用它）。
 */
export function registerCultures(host: Host, cultures: readonly CultureDef[], o: { strings?: [zh: string, en: string, ja: string][]; default?: string } = {}) {
  if (o.strings) defineStrings(o.strings)
  for (const c of cultures) {
    host.add(Cultures, c.id, c, { default: c.id === o.default })
    // 职业名的英文、日文（界面按中文键翻译）
    defineStrings(schemeStrings(c.people.scheme))
  }
}
