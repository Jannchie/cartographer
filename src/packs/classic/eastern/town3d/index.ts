/**
 * 东方在沙盘上的全套做法（见 render/town3d/kits.ts 的 TownKit）。
 */
import { MAT, shade } from '../../../../render/town3d/mesh'
import { COPPER, LACQUER, ROOF, STONE, STONE_EAST, hex } from '../../../../render/town3d/shared'
import type { TownKit } from '../../../../render/town3d/kits'
import { eastern } from './buildings'
import { flora } from './flora'
import { graveMarker, gravePlot, ship, stele } from './props'
import { wall } from './works'

export const kit: TownKit = {
  storey: 3.4,
  facade: 1,
  building: eastern,
  // 木板棚屋：木瓦顶或灰瓦顶
  shed: { roof: { split: 0.5, hi: MAT.shingle, lo: MAT.tileEast }, tile: ROOF.grey, pitch: 0.5 },
  grave: { marker: graveMarker, plot: gravePlot },
  wall,
  // 瓦顶的院墙，朱漆的小门楼
  fence: { kind: 'tiled', kerb: STONE, tiled: { hgt: [3.0, 2.5], post: LACQUER, leaf: hex('#7a2a20'), pitch: 0.62 } },
  // 高拱的石桥，望柱栏板
  bridge: { col: shade(STONE_EAST, 1.12), face: MAT.stone, arch: 'round', rail: 'balustrade', riseK: 0.11, riseMax: 4.2 },
  // 舢板带席篷
  harbor: { quay: shade(STONE_EAST, 1.1), tar: hex('#5b4130'), skiff: { blunt: true, awning: true }, sail: 0.6, ship },
  props: {
    skew: false,
    stallRoof: { col: hex('#c2a55e'), face: MAT.straw },
    lighthouse: { col: hex('#b9b5ab'), face: MAT.stone, cap: COPPER },
    well: { square: true, col: STONE_EAST, face: MAT.stone, roof: hex('#565a60'), roofFace: MAT.tileEast },
    statue: stele,
    // 太湖石偏高瘦
    rock: { base: 1.0, vary: 1.1, col: hex('#a9a69e') },
    haystack: { foot: 0.9, body: 0.7, top: 1.6 },
  },
  flora,
}
