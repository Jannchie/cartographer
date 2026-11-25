import type { LayerSetup } from '../../kernel'
import type { CultureDef } from '../../settlement/culture'
import { registerCultures } from '../../settlement/register'
import { western } from '../classic/western'

/**
 * 插件 isekai 的 settlement 层入口：异世界的城镇文明。目前只有人类一种——借用 classic 的西式文明的定义（所以依赖 classic），
 * 只改叫法：行会是冒险者公会，教堂叫教会。精灵、矮人、兽人、魔族的文明尚未登记，这些种族的城暂时也按人类的建
 *（世界观的规则见 ./world/setting.ts）。文明的 id 写在聚落的种子里，登记后不能改名。
 */
const human: CultureDef = {
  ...western,
  id: 'isekai.human',
  name: '人类',
  desc: '异世界的人类王国：城的建法与西式相同，行会是冒险者公会，教堂叫教会',
  naming: {
    ...western.naming,
    landmark: (n, kind, magic) =>
      kind === 'guild'
        ? n.pick([['冒险者公会', "Adventurers' Guild", '冒険者ギルド'], ['商业公会', "Merchants' Guild", '商業ギルド'], ['锻冶公会', "Smiths' Guild", '鍛冶ギルド'], ['魔法师公会', "Mages' Guild", '魔術師ギルド']])
        : western.naming.landmark(n, kind, magic),
  },
  lexicon: { ...western.lexicon, temple: '教会' },
  featureNames: { guild: '冒险者公会', temple: '教会' },
}

const setup: LayerSetup = (host) => {
  registerCultures(host, [human], {
    strings: [
      ['人类', 'Human', '人間'],
      ['异世界的人类王国：城的建法与西式相同，行会是冒险者公会，教堂叫教会', "A human kingdom of the isekai setting: built like the Western culture, with an Adventurers' Guild for a guildhall and churches by another name", '異世界の人間の王国：町の造りは西洋式と同じ。ギルドは冒険者ギルド、聖堂は教会と呼ぶ'],
      ['冒险者公会', "Adventurers' Guild", '冒険者ギルド'],
      ['教会', 'Church', '教会'],
    ],
  })
}
export default setup
