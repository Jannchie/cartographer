/**
 * 伊斯兰在沙盘上的全套做法（见 render/town3d/kits.ts 的 TownKit）。
 */
import { MAT } from '../../../../render/town3d/mesh'
import { ADOBE, COPPER, hex } from '../../../../render/town3d/shared'
import type { TownKit } from '../../../../render/town3d/kits'
import { islamic } from './buildings'
import { flora } from './flora'
import { gravePlot, ship } from './props'
import { wall } from './works'

export const kit: TownKit = {
  storey: 3.1,
  facade: 3,
  building: islamic,
  shed: { adobe: true },
  grave: { stone: hex('#d9d2c0'), plot: gravePlot },
  wall,
  // 抹灰的高墙，墙上开尖拱门洞
  fence: { kind: 'tall', kerb: hex('#d9cfb8') },
  // 砖砌的尖拱桥
  bridge: { col: ADOBE, face: MAT.brick, arch: 'pointed', rail: 'parapet', riseK: 0.075, riseMax: 3.2 },
  harbor: { quay: hex('#bfae90'), tar: hex('#6f5237'), skiff: { blunt: false, awning: false }, sail: 0.4, ship },
  props: {
    skew: false,
    lighthouse: { col: hex('#dccdaa'), face: MAT.stone, cap: COPPER },
    well: { square: false, col: hex('#cfc3a6'), face: MAT.stone, roof: hex('#b9a888'), roofFace: MAT.tile },
    // 贴地的八角浅池，池沿贴釉砖
    fountain: { sides: 8, kerb: 0.32, stone: hex('#d9d2c0'), rim: hex('#3d7f86'), jet: false },
  },
  flora,
}
