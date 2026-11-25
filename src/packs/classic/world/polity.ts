import type { PolityDef } from '../../../gen/polity'

/**
 * 内置的三种制度（由 ../world.ts 登记；总述见 gen/polity.ts）。
 * 规则里的数值是生成结果的一部分，改动会让旧种子的政区全部改变。
 */

/** 称谓接在名字后面；名字已带这个字的不再重复 */
const suf = (s: string, t: string) => (s.endsWith(t) ? s : s + t)

/** 分封：伯爵领 → 公爵领 → 王国 */
export const feudal: PolityDef = {
  id: 'feudal',
  terms: { name: '分封', county: '伯爵领', province: '公爵领' },
  rule: { realms: 1.4, sep: 0.8, vigor: [0.6, 1.6], core: 1, cross: 3, group: 5, seeding: 'towns', ridge: 1, river: 0.5, balance: 0 },
  provinceName: (c) => ({ name: `Duchy of ${c.name}`, zh: suf(c.zh, '公爵领'), ja: suf(c.ja ?? c.zh, '公爵領') }),
}

/** 郡县：县 → 州 → 王朝 */
export const commandery: PolityDef = {
  id: 'commandery',
  terms: { name: '郡县', county: '县', province: '州' },
  rule: { realms: 0.55, sep: 1.4, vigor: [0.85, 1.2], core: 1.7, cross: 1.6, group: 8, seeding: 'even', ridge: 3, river: 2, balance: 1 },
  provinceName: (c) => ({ name: `${c.name} Prefecture`, zh: suf(c.zh, '州'), ja: suf(c.ja ?? c.zh, '州') }),
}

/** 令制：郡 → 令制国 → 朝廷 */
export const ritsuryo: PolityDef = {
  id: 'ritsuryo',
  terms: { name: '令制', county: '郡', province: '令制国' },
  rule: { realms: 0.5, sep: 1.2, vigor: [0.9, 1.2], core: 1.3, cross: 3, group: 4, seeding: 'even', ridge: 6, river: 1, balance: 0.4 },
  provinceName: (c) => ({ name: `${c.name} Province`, zh: suf(c.zh, '国'), ja: suf(c.ja ?? c.zh, '国') }),
}
