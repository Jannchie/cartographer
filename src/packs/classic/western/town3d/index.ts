/**
 * 西式在沙盘上的全套做法（见 render/town3d/kits.ts 的 TownKit）。
 */
import { MAT } from '../../../../render/town3d/mesh'
import { ROOF, STONE, hex } from '../../../../render/town3d/shared'
import type { TownKit } from '../../../../render/town3d/kits'
import { western } from './buildings'
import { flora } from './flora'
import { gravePlot, ship } from './props'
import { wall } from './works'

export const kit: TownKit = {
  storey: 3.1,
  facade: 0,
  building: western,
  // 木板棚屋：草顶或木瓦顶
  shed: { roof: { split: 0.6, hi: MAT.thatch, lo: MAT.shingle }, tile: ROOF.grey, pitch: 0.75 },
  grave: { plot: gravePlot },
  wall,
  // 院墙按片区：园子的铁栏杆、乡下的树篱或石墙、城里的石墙
  fence: { kerb: STONE },
  bridge: { col: STONE, face: MAT.stone, arch: 'round', rail: 'parapet', riseK: 0.075, riseMax: 3.2 },
  harbor: { quay: STONE, tar: hex('#4b3a2b'), skiff: { blunt: false, awning: false }, sail: 0.4, ship },
  props: {
    skew: true,
    lighthouse: { col: hex('#e2ddd0'), face: MAT.plaster, cap: hex('#7a3a2c') },
    well: { square: false, col: STONE, face: MAT.stone, roof: hex('#7a4a38'), roofFace: MAT.tile },
  },
  flora,
}
