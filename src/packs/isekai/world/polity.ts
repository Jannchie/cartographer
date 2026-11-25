import type { PolityDef } from '../../../gen/polity'

/**
 * 异世界的三种制度（由 ../world.ts 登记；总述见 gen/polity.ts）：人类的王国贵族制，魔族的魔王领，精灵、矮人、兽人共用的部族制。
 * 哪种文化实行哪种制度由世界观的整体规则定（./setting.ts）。
 * 规则里的数值是生成结果的一部分，改动会让旧种子的政区全部改变。
 */

/** 称谓接在名字后面；名字已带这个字的不再重复 */
const suf = (s: string, t: string) => (s.endsWith(t) ? s : s + t)

/** 王国贵族制：伯爵领 → 公爵领 → 王国。数值与内置的分封相同：国家多而大小悬殊，公爵领围绕大城 */
export const kingdom: PolityDef = {
  id: 'isekai.kingdom',
  terms: { name: '贵族制', county: '伯爵领', province: '公爵领' },
  rule: { realms: 1.4, sep: 0.8, vigor: [0.6, 1.6], core: 1, cross: 3, group: 5, seeding: 'towns', ridge: 1, river: 0.5, balance: 0 },
  provinceName: (c) => ({ name: `Duchy of ${c.name}`, zh: suf(c.zh, '公爵领'), ja: suf(c.ja ?? c.zh, '公爵領') }),
}

/**
 * 魔王领：魔域 → 军团领 → 魔王领。一种文化只出一个国家（名额的倍率是 0，按"有城镇的文化至少一国"恰好得一国），
 * 核心的活力高，占满自己的文化区；跨文化扩张的代价很高，基本不向外扩（没有国家的无主之地仍会就近并入）；
 * 军团领均匀铺开，界线压在山脊上。国名用制度自己的模板，不用命名风格的
 */
export const demonRealm: PolityDef = {
  id: 'isekai.demon',
  terms: { name: '魔王领', county: '魔域', province: '军团领' },
  rule: { realms: 0, sep: 1, vigor: [1, 1.2], core: 1.6, cross: 14, group: 4, seeding: 'even', ridge: 5, river: 1, balance: 0.5 },
  provinceName: (c) => ({ name: `Legion of ${c.name}`, zh: suf(c.zh, '军团领'), ja: suf(c.ja ?? c.zh, '軍団領') }),
  realm: [['Demon Realm of #', '魔王领#', '魔王領#']],
}

/** 部族制：乡 → 氏族领 → 部族的国。国家少而小，守在自己的地理单元里：跨文化扩张的代价高，氏族领以山脊为界 */
export const tribal: PolityDef = {
  id: 'isekai.tribal',
  terms: { name: '部族制', county: '乡', province: '氏族领' },
  rule: { realms: 0.6, sep: 1, vigor: [0.8, 1.1], core: 1.2, cross: 5, group: 4, seeding: 'towns', ridge: 4, river: 1, balance: 0 },
  provinceName: (c) => ({ name: `${c.name} Clanlands`, zh: suf(c.zh, '氏族领'), ja: suf(c.ja ?? c.zh, '氏族領') }),
}
