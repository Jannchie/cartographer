import { westChurch } from '../../../settlement/compose/church'
import { emitArea, isFree } from '../../../settlement/ctx'
import { insetConvex, rect } from '../../../settlement/geom'
import { keepManor, type CultureTiers } from '../../../settlement/tiers'
import { addGroup, plantTree } from '../../../settlement/wards'

/** 规模档：堂区教堂（small）、路边的礼拜龛与十字架（micro）、塔楼庄园 */
export const tiers: CultureTiers = {
  rate: { micro: 95, small: 300 },
  small: {
    kind: 'church',
    size: [24, 38],
    rural: 0.72,
    town: 0.62,
    build: (ctx, poly, _front, key) => westChurch(ctx, poly, insetConvex(poly, 2.5), { fill: false, key }),
  },
  // 塔楼庄园（tower house 与它的 barmkin）
  manor: { parts: keepManor, towers: 'all', thick: 1.8, wall: 'stone', keepRole: '塔楼' },
  wayside(ctx, s) {
    // 城里是临街的礼拜龛（小小的路边礼拜堂），乡下是路边的十字架与一棵椴树
    if (s.outside || s.rural()) {
      const pad = rect(s.at(0.5, 0), s.d, 4, 4)
      if (!isFree(ctx, pad, { pad: 0.1 })) return false
      emitArea(ctx, 'plazas', pad)
      // 石十字：一竖一横（两块可以相交，一起落地）
      if (addGroup(ctx, [[rect(s.at(0.4, 0), s.d, 3, 0.7), 'tower'], [rect(s.at(0.9, 0), s.d, 0.7, 2), 'tower']], 0.1))
        for (const x of ctx.out.buildings.slice(-2)) x.role = '路边十字架'
      plantTree(ctx, s.at(-2.5, 1.5), 3.2)
      return true
    }
    return s.put(rect(s.at(0.5, 0), s.d, 3.4, 2.6), 'temple', '路边礼拜龛')
  },
  pocketGarden: 'fountain',
  towerHouse: { rate: 90, size: 7.5, role: '塔楼民居' },
}
