import { NamingStyles, type Kinds, type NamingStyleDef, type Tpl } from '../../gen/naming'
import { Settings, type SettingDef } from '../../gen/setting'
import type { LayerSetup } from '../../kernel'

/**
 * 示例插件（只在开发构建里出现）的 world 层入口：一种命名风格与一个世界观，
 * 用来走通"选一个非默认的世界观生成世界 → 进入聚落"的整条链路，以及世界观所属的插件没有启用时的处理。
 * 世界观 sample 只有一种命名风格、建示例文明的城（聚落层的 sample，见 ./settlement.ts），制度借用 classic 的分封。
 */

type Morph = [en: string, zh: string, ja: string]
/** 专名：希腊字母 + 序数，一眼能认出是示例 */
const HEAD: Morph[] = [
  ['Alpha', '阿尔法', 'アルファ'], ['Beta', '贝塔', 'ベータ'], ['Gamma', '伽马', 'ガンマ'], ['Delta', '德尔塔', 'デルタ'],
  ['Epsilon', '艾普西隆', 'イプシロン'], ['Zeta', '泽塔', 'ゼータ'], ['Eta', '伊塔', 'イータ'], ['Theta', '西塔', 'シータ'],
  ['Iota', '约塔', 'イオタ'], ['Kappa', '卡帕', 'カッパ'], ['Lambda', '拉姆达', 'ラムダ'], ['Mu', '缪', 'ミュー'],
  ['Nu', '纽', 'ニュー'], ['Xi', '克西', 'クシー'], ['Omicron', '奥密克戎', 'オミクロン'], ['Pi', '派', 'パイ'],
  ['Rho', '柔', 'ロー'], ['Sigma', '西格玛', 'シグマ'], ['Tau', '陶', 'タウ'], ['Upsilon', '宇普西隆', 'ウプシロン'],
  ['Phi', '斐', 'ファイ'], ['Chi', '希', 'カイ'], ['Psi', '普西', 'プサイ'], ['Omega', '欧米伽', 'オメガ'],
]
const TAIL: Morph[] = [
  ['One', '一', '一'], ['Two', '二', '二'], ['Three', '三', '三'], ['Four', '四', '四'], ['Five', '五', '五'], ['Six', '六', '六'],
  ['Seven', '七', '七'], ['Eight', '八', '八'], ['Nine', '九', '九'], ['Ten', '十', '十'], ['Eleven', '十一', '十一'], ['Twelve', '十二', '十二'],
]

const plain: Tpl[] = [['#', '#', '#']]
const KINDS: Kinds = {
  world: plain,
  continent: plain,
  island: [['# Island', '#岛', '#島']],
  ocean: [['# Ocean', '#洋', '#洋']],
  sea: [['# Sea', '#海', '#海']],
  range: [['# Mountains', '#山脉', '#山脈']],
  basin: [['# Basin', '#盆地', '#盆地']],
  desert: [['# Desert', '#沙漠', '#砂漠']],
  forest: [['# Forest', '#森林', '#の森']],
  lake: [['Lake #', '#湖', '#湖']],
  saltLake: [['Salt Lake #', '#盐湖', '#塩湖']],
  city: [['# Station', '#站', '#駅']],
  capital: [['# Central', '#中枢', '#中枢']],
}

const naming: NamingStyleDef = {
  id: 'sample',
  label: '示例命名',
  tip: '示例插件的命名风格：希腊字母加序数',
  kinds: KINDS,
  realm: [['# Sector', '#区', '#区']],
  avoidEcho: false,
  roots:
    ({ rng: r }) =>
    () => {
      const a = r.pick(HEAD)
      const b = r.pick(TAIL)
      return { en: `${a[0]} ${b[0]}`, zh: a[1] + b[1], ja: a[2] + b[2] }
    },
}

const setting: SettingDef = {
  id: 'sample',
  name: '示例世界观',
  desc: '示例插件的世界观：只有示例命名一种命名风格，城镇都是示例文明',
  naming: ['sample'],
  polity: { sample: 'feudal' },
  townCulture: () => 'sample',
  cultures: ['sample'],
}

const setup: LayerSetup = (host) => {
  host.add(NamingStyles, naming.id, naming)
  host.add(Settings, setting.id, setting)
}
export default setup
