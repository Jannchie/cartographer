import type { SettingDef } from '../../../gen/setting'

/**
 * 内置的世界观 classic（由 ../world.ts 登记）：前工业时代的世界，四种命名风格、三种制度、四种城市文明。
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
