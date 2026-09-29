import type { CultureStyle } from '../culture'
import { placeable, whereOf } from '../ctx'
import { area, clipHalf, insetConvex } from '../geom'
import { townlike } from '../features'
import { eastMarket, eastWard, siheyuan, urban } from '../wards'

/**
 * 东方：民居是院落（四合院），市是东西两市式的市坊，城郊也是院落。
 * 城堡、寺观、园林这些与和风共用的东亚木构做法在通用的填法里（按 CultureInfo.eastAsian）。
 */
export const eastern: CultureStyle = {
  buildWard(ctx, ward, block) {
    switch (ward.type) {
      case 'common':
        // 村里不成街坊的是零散农家
        if (townlike(ctx)) eastWard(ctx, block, false)
        else urban(ctx, block, 'village', [])
        return true
      case 'market':
        // 城心的大市场（商贸城）照通用的广场填法
        if (ctx.out.wards[0] === ward) return false
        eastMarket(ctx, block)
        ward.name = ctx.namer.district('market', whereOf(ctx, ward.poly))
        return true
      case 'suburb':
        eastWard(ctx, block, false, 30)
        return true
      default:
        return false
    }
  },
  // 农家：临路一进小院，正房坐北
  farmstead(ctx, lot, a, n) {
    const yard = clipHalf(lot, [a[0] + n[0] * 34, a[1] + n[1] * 34], n)
    const q = yard.length >= 3 ? placeable(ctx, insetConvex(yard, 1)) : null
    if (q && area(q) > 80) siheyuan(ctx, q)
    return true
  },
  plotFill(ctx, plot, type) {
    if (type !== 'common' && type !== 'merchant') return false
    eastWard(ctx, plot, type === 'merchant')
    return true
  },
}
