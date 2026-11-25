import { emitArea, isFree, type Ctx } from '../../../settlement/ctx'
import { at, box, centroid, frameAt, obb, rect, type P, type Poly } from '../../../settlement/geom'
import { isVillage } from '../../../settlement/scale'
import type { CultureTiers } from '../../../settlement/tiers'
import type { BuildingKind } from '../../../settlement/types'
import { addGroup, inside, plantTree } from '../../../settlement/wards'

/** 祠堂 / 小庙（small）：一圈院墙，门屋、正堂、两厢，院里一棵树 */
function ancestralHall(ctx: Ctx, poly: Poly, front: P, key: string): boolean {
  const c = centroid(poly)
  const f: P = [-front[0], -front[1]]
  const b = obb(poly)
  const W = Math.min(b.len, b.wid) - 3
  const D = Math.max(b.len, b.wid) - 3
  const F = frameAt(c, f)
  const wall = box(F, -D / 2, D / 2, -W / 2, W / 2)
  const parts: [Poly, BuildingKind][] = [
    [box(F, -D / 2 + 0.5, -D / 2 + 5, -W * 0.22, W * 0.22), 'hall'],
    [box(F, D / 2 - 9.5, D / 2 - 0.8, -W * 0.36, W * 0.36), 'temple'],
    [box(F, -D / 2 + 8, D / 2 - 12, -W / 2 + 0.6, -W / 2 + 4.6), 'hall'],
    [box(F, -D / 2 + 8, D / 2 - 12, W / 2 - 4.6, W / 2 - 0.6), 'hall'],
  ]
  if (!parts.every(([p]) => inside(p, wall) && isFree(ctx, p, { pad: 0.3 }))) return false
  addGroup(ctx, parts, 0.3)
  const main = ctx.out.buildings[ctx.out.buildings.length - 3]
  main.role = '祠堂'
  emitArea(ctx, 'enclosures', wall)
  emitArea(ctx, 'plazas', box(F, -D / 2 + 5.5, D / 2 - 10, -W / 2 + 5, W / 2 - 5))
  plantTree(ctx, at(F, 0, 0), 3.2)
  ctx.out.landmarks.push({ p: at(F, D / 2 - 5, 0), name: ctx.namer.sacred(isVillage(ctx.p.size) || ctx.p.size === 'town' ? 'tudi' : 'villageShrine', key), kind: 'shrine' })
  return true
}

/** 规模档：祠堂（small）、路边的土地庙（micro）、土堡 */
export const tiers: CultureTiers = {
  rate: { micro: 55, small: 280 },
  small: { kind: 'ci', size: [20, 27], rural: 0.75, town: 0.7, build: ancestralHall },
  // 土堡：正厅与两厢，对角两座角楼
  manor: {
    parts: (h, box) => [
      [box(h * 0.25, h * 0.85, -h * 0.6, h * 0.6), 'hall'],
      [box(-h * 0.6, h * 0.1, -h * 0.85, -h * 0.5), 'house'],
      [box(-h * 0.6, h * 0.1, h * 0.5, h * 0.85), 'house'],
    ],
    towers: 'diagonal',
    thick: 2.2,
    wall: 'stone',
  },
  wayside(ctx, s) {
    // 土地庙：一间小庙、门前一方小坪
    if (!s.put(rect(s.at(-0.8, 0), s.d, 3, 3.2), 'temple', '土地庙')) return false
    const fore = rect(s.at(1.8, 0), s.d, 2, 3.2)
    if (isFree(ctx, fore, { pad: 0.1 })) emitArea(ctx, 'plazas', fore)
    plantTree(ctx, s.at(-3.5, 2.5), 3)
    return true
  },
  pocketGarden: 'well',
  towerHouse: { rate: 110, size: 6, role: '碉楼' },
}
