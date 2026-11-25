import type { SettingDef } from '../../../gen/setting'

/**
 * 内置的世界观 classic（由 ../world.ts 登记）：前工业时代的世界，四种命名风格、三种制度、四种城市文明，东西方混在同一个世界里。
 * 参数里没有写世界观的世界都按它生成（gen/types.ts 的 normalizeParams），所以这里的每一项都是旧种子结果的一部分：
 * 命名风格的池子不能增删、不能调换顺序，制度的对应与城镇文明规则不能改。
 */
export const classic: SettingDef = {
  id: 'classic',
  name: '古典',
  desc: '前工业时代：西幻、史诗、东方、和风四种命名风格，分封、郡县、令制三种制度，西式、东方、和风、伊斯兰四种城市文明',
  naming: ['fantasy', 'epic', 'eastern', 'wa'],
  polity: { fantasy: 'feudal', epic: 'feudal', eastern: 'commandery', wa: 'ritsuryo' },
  // 汉字地名的文化建东方的城，日本地名的建和风的城；其余的看地理——炎热干旱的地方占到四成五以上建伊斯兰式的城
  //（只换形制，名字仍按自己的命名风格），否则是西式
  townCulture: ({ naming, aridCells, cells }) => (naming === 'eastern' || naming === 'wa' ? naming : aridCells > cells * 0.45 ? 'islamic' : 'western'),
}

/**
 * 西洋：中世纪欧洲式的世界。classic 里西方的那一半——西幻、史诗两种命名风格，各文化都实行分封；
 * 城是西式的，炎热干旱的地方占到四成五以上建伊斯兰式的城（与 classic 的规则相同）。
 * 文化比命名风格多时，多出来的用西幻（池子里的第一种）。
 */
export const occident: SettingDef = {
  id: 'occident',
  name: '西洋',
  desc: '中世纪欧洲式的世界：西幻、史诗两种命名风格，分封制；城是西式的，炎热干旱的地方建伊斯兰式的城',
  naming: ['fantasy', 'epic'],
  polity: { fantasy: 'feudal', epic: 'feudal' },
  townCulture: ({ aridCells, cells }) => (aridCells > cells * 0.45 ? 'islamic' : 'western'),
}

/**
 * 东亚：汉字文化圈的世界。classic 里东方的那一半——东方、和风两种命名风格，汉字地名的文化实行郡县、建东方的城，
 * 日本地名的文化实行令制、建和风的城。城镇的文明只看命名风格，不看地理：干旱的地方也不建伊斯兰式的城。
 * 文化比命名风格多时，多出来的用东方（池子里的第一种），于是一个世界里至多一种文化是和风的；
 * 规则里"既不是和风的"一律按东方处理（池子里只有这两种，这一支只是兜底）。
 */
export const eastAsia: SettingDef = {
  id: 'eastasia',
  name: '东亚',
  desc: '汉字文化圈的世界：东方、和风两种命名风格，郡县与令制两种制度；汉字地名的文化建东方的城，日本地名的建和风的城',
  naming: ['eastern', 'wa'],
  polity: { eastern: 'commandery', wa: 'ritsuryo' },
  townCulture: ({ naming }) => (naming === 'wa' ? 'wa' : 'eastern'),
}
