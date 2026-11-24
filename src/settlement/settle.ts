import type { Ctx } from './ctx'
import { area, bboxOf, centroid, convexOverlap, pointInPoly, segDist, segPolyDist, segSegDist, type BBox, type P, type Poly } from './geom'
import type { Life } from './history'
import type { Building, Road, Tree, Wall } from './types'
import * as dmath from '../gen/dmath'

/**
 * 收尾：成长史排完以后，把仍然在某个时刻"同时存在又压在一起"的东西按先后理顺。
 *
 * 各片区的形态是分别盖、分别调度的（见 history.ts），片区之间、形态之间、片区与后放的地标之间只在盖的那一刻互相让开：
 * 后来的地标压着的旧房可能晚几步才拆，新形态的巷子底下还留着没轮到翻建的旧屋，田野里的树长在后来的墙根、城门口。
 * 这些在二维图上只是一点重影，立起来就是屋顶互相穿插、树长在屋里。这里统一按生卒处理，只改寿命、不挪位置：
 * - 画幅之外：建筑、院墙有顶点出了画幅的，树干出了画幅的，不要（沙盘的底座只有画幅那么大）；
 * - 房 × 房：先有的在后来的盖起来时拆掉；同时出现的留下更要紧的那座（地标 > 大宅 > 民居 > 棚屋，再按面积）。
 *   同一组部件（addGroup 一起放下的，Building.group 相同）与都不是民居、棚屋的（组合地标的殿、塔、廊）是有意叠放的，不动；
 * - 房 × 路：路修到时拆掉压着的房；房子后盖的，压着形态里的小巷时巷子让位（巷子到此为止），压着街与大路的不盖；
 * - 房 × 墙：城墙、院墙式的幕墙修到时拆掉压着的房（含路边小祠），墙已经在的不盖（墙上的塔楼、门楼不算）；
 * - 院墙 × 路：院墙压到街面的，路修到时拆，路先有的不围；
 * - 房 × 院墙：院墙从房子中间穿过的，院墙等房子拆了才有（一直没拆就不要这道院墙）；
 * - 房、树 × 铺装：先有的在广场、前庭铺成时拆掉、砍掉（同时或之后放上的摊位、院心的树是有意的）；
 * - 树：树干在房子里或紧贴外墙、在城墙墙体里、在城门的门道上、在水里的，房子（墙）盖起来时砍掉，之后才该长出来的不种。
 */
export function settleConflicts(ctx: Ctx) {
  const h = ctx.history
  const { MW, MH } = ctx
  const past = <T>(key: string) => h.past.filter((x) => x.key === key).map((x) => x.item as T)
  const lifeOf = (x: object): Life => h.life.get(x) ?? ALWAYS
  /** 要改寿命时取（没有记录的补一条"一直都在"） */
  const edit = (x: object): Life => {
    let l = h.life.get(x)
    if (!l) h.life.set(x, (l = { born: 0, died: Infinity }))
    return l
  }
  const never = (x: object) => {
    const l = edit(x)
    l.died = l.born
  }
  /** x 在 t 时消亡（不早于出生） */
  const endAt = (x: object, t: number) => {
    const l = edit(x)
    l.died = Math.max(l.born, Math.min(l.died, t))
  }
  const both = (a: object, b: object) => {
    const la = lifeOf(a)
    const lb = lifeOf(b)
    return Math.max(la.born, lb.born) < Math.min(la.died, lb.died)
  }

  const buildings = [...ctx.out.buildings, ...past<Building>('buildings')].filter((b) => lifeOf(b).born < lifeOf(b).died)
  const enclosures = [...ctx.out.enclosures, ...past<Poly>('enclosures')]
  const trees = [...ctx.out.trees, ...past<Tree>('trees')]
  const roads = [...ctx.out.roads, ...past<Road>('roads')]
  const walls = [...ctx.out.walls, ...past<Wall>('walls')]

  // —— 画幅之外 ——
  const off = (q: P, m: number) => q[0] < m || q[1] < m || q[0] > MW - m || q[1] > MH - m
  for (const b of buildings) if (b.poly.some((q) => off(q, 0.5))) never(b)
  for (const e of enclosures) if (e.some((q) => off(q, 0.5))) never(e)
  for (const t of trees) if (off(t.p, 1)) never(t)

  const boxes = new Map<Building, BBox>()
  const grid = new Grid<Building>(32)
  for (const b of buildings) {
    const bb = bboxOf(b.poly)
    boxes.set(b, bb)
    grid.add(bb, b)
  }
  const alive = (x: object) => {
    const l = lifeOf(x)
    return l.born < l.died
  }

  // —— 房 × 房 ——
  const pairs: [Building, Building][] = []
  const seen = new Set<Building>()
  for (const a of buildings) {
    seen.add(a)
    if (!alive(a)) continue
    const ba = boxes.get(a)!
    for (const b of grid.near(ba)) {
      if (seen.has(b) || !alive(b)) continue
      if (a.group !== undefined && a.group === b.group) continue
      if (!MINOR.has(a.kind) && !MINOR.has(b.kind)) continue
      const bb = boxes.get(b)!
      if (ba[0] >= bb[2] || bb[0] >= ba[2] || ba[1] >= bb[3] || bb[1] >= ba[3]) continue
      if (both(a, b) && convexOverlap(a.poly, b.poly, 0.25)) pairs.push([a, b])
    }
  }
  // 按后来者出现的先后处理：先拆的不再挡后面的
  const later = (p: [Building, Building]) => Math.max(lifeOf(p[0]).born, lifeOf(p[1]).born)
  pairs.sort((p, q) => later(p) - later(q))
  for (const [a, b] of pairs) {
    if (!both(a, b)) continue
    const la = lifeOf(a)
    const lb = lifeOf(b)
    if (la.born < lb.born) endAt(a, lb.born)
    else if (lb.born < la.born) endAt(b, la.born)
    else never(rank(a) < rank(b) || (rank(a) === rank(b) && area(a.poly) <= area(b.poly)) ? a : b)
  }

  // —— 房 × 路 ——
  for (const r of roads) {
    if (r.kind === 'path' || r.kind === 'stair' || !alive(r)) continue
    const half = r.width / 2 - 0.3
    for (let i = 0; i + 1 < r.line.length; i++) {
      const p = r.line[i]
      const q = r.line[i + 1]
      for (const b of grid.near([Math.min(p[0], q[0]) - half, Math.min(p[1], q[1]) - half, Math.max(p[0], q[0]) + half, Math.max(p[1], q[1]) + half])) {
        if (b.kind === 'torii' || !both(b, r) || segPolyDist(p, q, b.poly) >= half) continue
        const lb = lifeOf(b)
        const lr = lifeOf(r)
        if (lr.born > lb.born) endAt(b, lr.born)
        else if (r.kind === 'lane' && lb.born > lr.born) endAt(r, lb.born)
        else never(b)
      }
    }
  }

  // —— 房 × 墙 ——
  for (const w of walls) {
    if (!alive(w)) continue
    const half = w.thickness / 2 - 0.3
    const n = w.loop.length
    for (let i = 0; i < n; i++) {
      if (!w.solid[i]) continue
      const p = w.loop[i]
      const q = w.loop[(i + 1) % n]
      for (const b of grid.near([Math.min(p[0], q[0]) - half, Math.min(p[1], q[1]) - half, Math.max(p[0], q[0]) + half, Math.max(p[1], q[1]) + half])) {
        if ((!MINOR.has(b.kind) && !(b.kind === 'temple' && area(b.poly) < 80)) || !both(b, w) || segPolyDist(p, q, b.poly) >= half) continue
        if (lifeOf(w).born > lifeOf(b).born) endAt(b, lifeOf(w).born)
        else never(b)
      }
    }
  }

  // —— 房 × 院墙 ——
  for (const e of enclosures) {
    if (!alive(e)) continue
    for (const b of grid.near(bboxOf(e))) {
      if (b.kind === 'torii' || !both(b, e)) continue
      let inn = false
      let out = false
      for (const v of b.poly) {
        if (edgeDist(v, e) < 0.5) continue
        if (pointInPoly(v, e)) inn = true
        else out = true
      }
      if (!inn || !out) continue
      // 院墙等这座房子拆了才有
      const le = edit(e)
      le.born = Math.min(le.died, Math.max(le.born, lifeOf(b).died))
      if (le.born >= le.died) break
    }
  }

  // —— 院墙 × 路：院墙的边压到街面的，路修到时拆掉；路先有的，这道院墙不围 ——
  const egrid = new Grid<Poly>(48)
  for (const e of enclosures) if (alive(e)) egrid.add(bboxOf(e), e)
  for (const r of roads) {
    if (r.kind === 'path' || r.kind === 'stair' || !alive(r)) continue
    const half = r.width / 2 - 0.6
    if (half <= 0) continue
    for (let i = 0; i + 1 < r.line.length; i++) {
      const p = r.line[i]
      const q = r.line[i + 1]
      for (const e of egrid.near([Math.min(p[0], q[0]) - half, Math.min(p[1], q[1]) - half, Math.max(p[0], q[0]) + half, Math.max(p[1], q[1]) + half])) {
        if (!both(e, r) || !e.some((v, k) => segSegDist(v, e[(k + 1) % e.length], p, q) < half)) continue
        if (lifeOf(r).born > lifeOf(e).born) endAt(e, lifeOf(r).born)
        else never(e)
      }
    }
  }

  // —— 铺装（广场、前庭）：先有的房子、树在铺成时拆掉、砍掉；与铺装同时或之后放上的（摊位、院心的树）是有意的 ——
  const paved = new Grid<Poly>(48)
  for (const q of [...ctx.out.plazas, ...past<Poly>('plazas')]) if (q.length >= 3 && alive(q)) paved.add(bboxOf(q), q)
  for (const b of buildings) {
    if (b.kind === 'torii' || !alive(b)) continue
    const c = centroid(b.poly)
    for (const q of paved.near(boxes.get(b)!)) if (lifeOf(b).born < lifeOf(q).born && both(b, q) && pointInPoly(c, q)) endAt(b, lifeOf(q).born)
  }

  // —— 树 ——
  const segs = new Grid<{ w: Wall; a: P; b: P }>(48)
  for (const w of walls) {
    if (!alive(w)) continue
    const n = w.loop.length
    for (let i = 0; i < n; i++) {
      if (!w.solid[i]) continue
      const a = w.loop[i]
      const b = w.loop[(i + 1) % n]
      segs.add([Math.min(a[0], b[0]) - 4, Math.min(a[1], b[1]) - 4, Math.max(a[0], b[0]) + 4, Math.max(a[1], b[1]) + 4], { w, a, b })
    }
  }
  const gates = new Grid<{ w: Wall; p: P; u: P }>(48)
  for (const w of walls) if (alive(w)) for (const g of w.gates) gates.add([g.p[0] - GATE_ALONG, g.p[1] - GATE_ALONG, g.p[0] + GATE_ALONG, g.p[1] + GATE_ALONG], { w, p: g.p, u: [dmath.cos(g.angle), dmath.sin(g.angle)] })
  /** 树被 x 挡住：x 后来才有的，树到那时砍掉；x 先有的，这棵树不种 */
  const blocked = (t: Tree, x: object) => {
    if (!both(t, x)) return
    const lx = lifeOf(x)
    if (lx.born > lifeOf(t).born) endAt(t, lx.born)
    else never(t)
  }
  for (const t of trees) {
    if (!alive(t)) continue
    if (ctx.T.waterAt(t.p) < 0.3) {
      never(t)
      continue
    }
    const clear = Math.max(0.8, t.r * 0.35)
    const box: BBox = [t.p[0] - clear, t.p[1] - clear, t.p[0] + clear, t.p[1] + clear]
    for (const b of grid.near(box)) {
      if (b.kind === 'torii' || !alive(b)) continue
      const bb = boxes.get(b)!
      if (bb[0] > box[2] || bb[2] < box[0] || bb[1] > box[3] || bb[3] < box[1]) continue
      if (pointInPoly(t.p, b.poly) || edgeDist(t.p, b.poly) < clear) blocked(t, b)
    }
    for (const q of paved.near(box)) if (lifeOf(t).born < lifeOf(q).born && pointInPoly(t.p, q)) blocked(t, q)
    for (const s of segs.near(box)) if (segDist(t.p, s.a, s.b).d < s.w.thickness / 2 + 1) blocked(t, s.w)
    for (const g of gates.near(box)) {
      const dx = t.p[0] - g.p[0]
      const dy = t.p[1] - g.p[1]
      if (Math.abs(dx * g.u[0] + dy * g.u[1]) < GATE_ALONG && Math.abs(-dx * g.u[1] + dy * g.u[0]) < GATE_ACROSS) blocked(t, g.w)
    }
  }
}

const ALWAYS: Life = { born: 0, died: Infinity }
/** 民居与棚屋：与别的建筑叠在一起就是冲突（组合地标的部件之间不算） */
const MINOR = new Set<Building['kind']>(['house', 'large', 'shed'])
const RANK: Partial<Record<Building['kind'], number>> = { shed: 0, house: 1, large: 2 }
const rank = (b: Building) => RANK[b.kind] ?? 3
/** 城门的门道：沿穿门的路前后各这么远、左右各这么宽以内不长树（门楼、瓮城与门前的空场） */
const GATE_ALONG = 16
const GATE_ACROSS = 5

/** 点到多边形边界的距离 */
function edgeDist(p: P, poly: Poly) {
  let d = Infinity
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]).d)
  return d
}

/** 按格子登记包围盒的索引 */
class Grid<T> {
  private m = new Map<number, T[]>()
  constructor(private cell: number) {}
  private keys(b: BBox, f: (k: number) => void) {
    for (let y = Math.floor(b[1] / this.cell); y <= Math.floor(b[3] / this.cell); y++) for (let x = Math.floor(b[0] / this.cell); x <= Math.floor(b[2] / this.cell); x++) f(y * 65536 + x)
  }
  add(b: BBox, item: T) {
    this.keys(b, (k) => {
      const l = this.m.get(k)
      if (l) l.push(item)
      else this.m.set(k, [item])
    })
  }
  near(b: BBox): T[] {
    const out = new Set<T>()
    this.keys(b, (k) => {
      const l = this.m.get(k)
      if (l) for (const x of l) out.add(x)
    })
    return [...out]
  }
}
