import { clamp } from '../../../gen/util'
import { centroid, circlePoly, insetConvex, rect } from '../../../settlement/geom'
import { keepManor, type CultureTiers } from '../../../settlement/tiers'
import { plantTree } from '../../../settlement/wards'
import { placeMosque } from './medina'

/** 规模档：街区清真寺（small）、施水亭与城外的圣徒墓（micro）、四角碉楼的堡 */
export const tiers: CultureTiers = {
  rate: { micro: 85, small: 170 },
  small: {
    kind: 'masjid',
    size: [24, 27],
    rural: 0.8,
    town: 0.72,
    build(ctx, poly, _front, key) {
      const m = placeMosque(ctx, insetConvex(poly, 1), poly, 26, 22, false)
      if (m) ctx.out.landmarks.push({ p: centroid(m), name: ctx.namer.sacred('masjid', key), kind: 'temple' })
      return !!m
    },
  },
  // 四角碉楼的堡（qasr / tighremt）
  manor: { parts: keepManor, towers: 'all', thick: 1.8, wall: 'stone', keepRole: '碉楼' },
  wayside(ctx, s) {
    // 城外：圣徒的墓（库巴，koubba），白色的小穹顶，旁边一棵树
    if (s.outside) {
      if (!s.put(circlePoly(s.c, 2.8, 10), 'temple', '圣徒墓（库巴）')) return false
      plantTree(ctx, s.at(-4, 2), 3)
      return true
    }
    // 施水亭（sabil）：街角的小亭，路人取水
    return s.put(rect(s.c, s.d, clamp(s.room * 0.7, 3.2, 4.5), clamp(s.room * 0.7, 3.2, 4.5)), 'civic', '施水亭（萨比勒）')
  },
  pocketGarden: 'fountain',
  towerHouse: { rate: 100, size: 6, role: '碉楼' },
}
