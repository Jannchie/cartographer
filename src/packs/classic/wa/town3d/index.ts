/**
 * 和式在沙盘上的全套做法（见 render/town3d/kits.ts 的 TownKit）。
 */
import { MAT } from '../../../../render/town3d/mesh'
import { COPPER, PLASTER, ROOF, STONE, TIMBER, TIMBER_DARK, hex } from '../../../../render/town3d/shared'
import type { TownKit } from '../../../../render/town3d/kits'
import { wa } from './buildings'
import { flora } from './flora'
import { graveMarker, gravePlot, lantern, ship } from './props'
import { wall } from './works'

export const kit: TownKit = {
  storey: 3.4,
  facade: 2,
  building: wa,
  // 木板棚屋与土藏：木瓦顶或瓦顶
  shed: { kura: true, roof: { split: 0.5, hi: MAT.shingle, lo: MAT.tileEast }, tile: ROOF.kawara, pitch: 0.5 },
  grave: { marker: graveMarker, plot: gravePlot },
  wall,
  // 白壁瓦顶的塀，素木的小门楼
  fence: { kind: 'tiled', kerb: STONE, tiled: { hgt: [2.1, 2.1], body: PLASTER, post: TIMBER_DARK, leaf: TIMBER, pitch: 0.5 } },
  bridge: { timber: true },
  // 码头是木桩上的栈台
  harbor: { tar: hex('#7a6248'), skiff: { blunt: true, awning: false }, sail: 0.4, ship },
  props: {
    skew: false,
    stallRoof: { col: hex('#7b6a55'), face: MAT.plank },
    lighthouse: { col: hex('#e2ddd0'), face: MAT.stone, cap: COPPER },
    well: { square: true, col: TIMBER, face: MAT.board, roof: hex('#565a60'), roofFace: MAT.tileEast },
    statue: lantern,
    // 石矮而稳
    rock: { base: 0.55, vary: 0.5, col: hex('#8f8c84') },
    haystack: { foot: 0.9, body: 0.7, top: 1.6 },
  },
  flora,
}
