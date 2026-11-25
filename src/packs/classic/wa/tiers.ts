import { rect } from '../../../settlement/geom'
import type { CultureTiers } from '../../../settlement/tiers'
import { plantTree } from '../../../settlement/wards'
import { villageShrine } from './style'

/** 规模档：村社（small）、路边的祠与小鸟居（micro，各文明里最密）、馆；没有塔楼民居 */
export const tiers: CultureTiers = {
  rate: { micro: 26, small: 200 },
  microCell: 28,
  smallGap: 150,
  shrineGap: 24,
  small: { kind: 'shrine', size: [26, 36], rural: 0.88, town: 0.78, build: (ctx, poly, front, key) => !!villageShrine(ctx, poly, front, key) },
  // 馆：土垒与板屋，不设角楼，背后一排树
  manor: {
    parts: (h, box) => [
      [box(h * 0.05, h * 0.8, -h * 0.55, h * 0.35), 'hall'],
      [box(-h * 0.5, -h * 0.05, h * 0.2, h * 0.75), 'shed'],
    ],
    towers: 'none',
    thick: 2.2,
    wall: 'palisade',
    treeRow: true,
  },
  wayside(ctx, s) {
    // 祠（ほこら）：小小的一间，前面一座小鸟居，背后一棵神木
    if (!s.put(rect(s.at(-1, 0), s.d, 2.2, 1.9), 'temple', '祠')) return false
    s.put(rect(s.at(1.9, 0), s.d, 0.45, 2.6), 'torii')
    plantTree(ctx, s.at(-4, 0.5), 2.6)
    return true
  },
  pocketGarden: 'well',
}
