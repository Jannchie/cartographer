/**
 * 承载组合地标的片区：神殿、城堡（都城为宫城）、奇观。地标本身按构图语法拼（compose/、palaces.ts），
 * 片区的其余部分按普通街区填（wards.ts）。
 */
import { cultures } from './culture'
import { imperialPalace, royalPalace } from './palaces'
import { eastCompound } from './compose/chinese'
import { westChurch } from './compose/church'
import { westCastle } from './compose/castle'
import { clearOf, clipWater, emitArea, isFree, mark, type Ctx } from './ctx'
import { area, centroid, circlePoly, insetConvex, type Poly } from './geom'
import type { Ward } from './types'
import { addBuilding, eastWard, fit, inside, scatterTrees, urban } from './wards'
import * as dmath from '../gen/dmath'

export function temple(ctx: Ctx, _ward: Ward, block: Poly) {
  const inner = insetConvex(block, 10)
  if (inner.length < 3) return urban(ctx, block, 'common')
  // 西式：教堂按平面语法拼（compose/church.ts）
  if (!cultures.get(ctx.p.culture).traits.eastAsian) {
    westChurch(ctx, block, inner)
    return
  }
  const reserve: Poly[] = []
  // 合成的大寺（grand）：整块地盘都是寺域（寺林、塔院），不再填街坊
  const grand = ctx.tier === 'grand'
  const comp = eastCompound(ctx, grand ? insetConvex(block, 4) : inner, 'temple')
  if (comp) reserve.push(comp)
  // 合成的大寺：自己的名字（不耗主随机数），按大地标标注
  if (ctx.tier === 'grand') ctx.out.landmarks.push({ p: centroid(inner), name: ctx.namer.sacred('grandTemple', `${Math.round(centroid(inner)[0])},${Math.round(centroid(inner)[1])}`), kind: 'temple', major: true })
  else mark(ctx, centroid(inner), 'temple')
  // 外圈仍是街坊；大寺四周是寺林
  if (grand) scatterTrees(ctx, insetConvex(block, 3), 0.004, 2.5, 5)
  else urban(ctx, block, 'common', reserve)
}

/** 城堡 / 衙署：幕墙、角楼、主楼与沿墙的附属建筑 */
export function castle(ctx: Ctx, ward: Ward, block: Poly) {
  // 幕墙不能被街道穿过、不能顶到城墙：碰到就往里收（斜切过一角的路沿路裁掉），收不下就不建城堡
  let curtain: Poly | null = null
  for (const d of [4, 8, 12]) {
    const w = clipWater(ctx, insetConvex(block, d), 4)
    const q = w && clearOf(ctx, w, ['road', 'river', 'wall'])
    if (q && q.length >= 3 && area(q) > 900 && !ctx.corridors.hitsPoly(q, 1, ['road', 'river', 'wall'])) {
      curtain = q
      break
    }
  }
  if (!curtain) return urban(ctx, block, 'common')
  const c = centroid(curtain)
  // 都城：城堡的位置是皇宫、王宫
  const royal = !!ctx.p.capital
  ctx.out.landmarks.push({ p: c, name: royal ? ctx.namer.palace() : ctx.namer.landmark('castle', ctx.p.magic), kind: 'castle' })
  if (cultures.get(ctx.p.culture).traits.eastAsian) {
    if (royal && imperialPalace(ctx, curtain)) return
    if (!eastCompound(ctx, curtain, 'palace')) eastWard(ctx, block, true)
    return
  }
  if (royal && royalPalace(ctx, curtain)) return
  // 西式城堡：按城堡的语法拼（compose/castle.ts）
  westCastle(ctx, curtain)
  // 堡外的片区剩余部分
  void ward
}

/** 奇观片区：法师塔与魔法阵 / 宗门与仙阁 */
export function magicWard(ctx: Ctx, _ward: Ward, block: Poly) {
  const g = clipWater(ctx, insetConvex(block, 3), 3)
  if (!g || g.length < 3) return
  const c = centroid(g)
  mark(ctx, c, 'magic')
  if (cultures.get(ctx.p.culture).traits.eastAsian) {
    if (eastCompound(ctx, g, 'sect')) ctx.out.wonders.push({ p: [c[0], c[1]], r: 10, kind: 'spring' })
    else eastWard(ctx, block, false)
    return
  }
  // 魔法阵连同石柱一整圈都不能压路、压水
  const r0 = Math.min(34, Math.sqrt(area(g)) * 0.32)
  const spot = fit(g, (q, s) => ({ q, r: r0 * s }), (t) => inside(circlePoly(t.q, t.r * 1.2, 16), g) && isFree(ctx, circlePoly(t.q, t.r * 1.2, 16), { pad: 1 }), [1, 0.85, 0.7, 0.55])
  if (!spot) return urban(ctx, block, 'common')
  const { q: mc, r } = spot
  emitArea(ctx, 'greens', g, 'garden')
  ctx.out.wonders.push({ p: mc, r, kind: 'circle' })
  addBuilding(ctx, circlePoly(mc, r * 0.28, 20), 'magic')
  // 围绕的石柱
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    addBuilding(ctx, circlePoly([mc[0] + dmath.cos(a) * r * 1.12, mc[1] + dmath.sin(a) * r * 1.12], 1.2, 8), 'shed')
  }
  // 整个魔法阵登记为占地：树与房屋都绕开
  ctx.occ.add(circlePoly(mc, r * 1.2, 16))
  // 先盖房再种树，树就不会被房子压住
  urban(ctx, block, 'common', [circlePoly(mc, r * 1.4, 16)])
  scatterTrees(ctx, g, 0.003, 3, 5)
}
