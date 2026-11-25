import { defineStrings } from '../../i18n'
import type { LayerSetup } from '../../kernel'

/**
 * 插件 isekai 的 ui 层入口（只在主线程载入）：world 层内容在界面上的名称与说明的英文、日文——
 * 世界观、五种命名风格、三种制度及其政区的称呼。world 层不导入界面词典（世界生成的 Worker 不带它），所以词条放在这一层。
 */
const setup: LayerSetup = () => {
  defineStrings([
    ['异世界', 'Isekai', '異世界'],
    [
      '日式异世界：片假名地名的人类王国，森林里的精灵、山地的矮人、草原上的兽人，还有边远之地的魔王领',
      'A Japanese-style isekai world: human kingdoms with katakana names, elves in the forests, dwarves in the highlands, beastfolk on the steppe, and a Demon Realm at the far edge of the map',
      '日本風の異世界：カタカナ地名の人間の王国、森のエルフ、山地のドワーフ、草原の獣人、そして辺境の魔王領',
    ],
    [
      '片假名地名：魏斯堡、罗森海姆、阿尔特利亚王国……英文是原拼写，中文音译',
      'Katakana place names: Weissburg, Rosenheim, Kingdom of Altria… spelled out in English, transliterated in Chinese',
      'カタカナの地名：ヴァイスブルク、ローゼンハイム、アルトリア王国……英語は元の綴り、中国語は音訳',
    ],
    ['精灵语', 'Elvish', 'エルフ語'],
    ['精灵的地名：露米娜莉耶、希尔瓦里昂……', 'Elven place names: Luminarie, Silvarion…', 'エルフの地名：ルミナリエ、シルヴァリオン……'],
    ['矮人语', 'Dwarvish', 'ドワーフ語'],
    ['矮人的地名：格拉姆霍尔德、杜尔甘……', 'Dwarven place names: Gramhold, Durgan…', 'ドワーフの地名：グラムホルド、ドゥルガン……'],
    ['兽人语', 'Beastfolk speech', '獣人語'],
    ['兽人的地名：加尔姆、莱扎……', 'Beastfolk place names: Garmu, Raiza…', '獣人の地名：ガルム、ライザ……'],
    ['魔族语', 'Demonic', '魔族語'],
    ['魔族的地名：格赫纳、瓦尔普吉斯……', 'Demon place names: Gehena, Walpurgis…', '魔族の地名：ゲヘナ、ヴァルプルギス……'],
    ['贵族制', 'Aristocratic', '貴族制'],
    ['魔王领', 'Demon Realm', '魔王領'],
    ['魔域', 'Demon march', '魔域'],
    ['军团领', 'Legion', '軍団領'],
    ['部族制', 'Tribal', '部族制'],
    ['乡', 'Homestead', '郷'],
    ['氏族领', 'Clanland', '氏族領'],
  ])
}
export default setup
