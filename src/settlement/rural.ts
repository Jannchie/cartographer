import { CULTURE_INFO, eastAsian } from './culture'
import { clear } from './civic'
import { emitArea, centerDist, hashAt, isFree, mark, type Ctx } from './ctx'
import { isVillage } from './scale'
import { centroid, circlePoly, dist, pointAt, polylineLength, rect, type P, type Poly } from './geom'
import type { BuildingKind, Landmark } from './types'
import { addGroup, plantTree } from './wards'
import { waysideAt } from './tiers'

/**
 * 城外（与城边）的地图级设施：河上的水车磨坊、高处的风车、城门外大路边的刑场、
 * 河边取土的砖瓦窑、岬角上的灯塔。它们不占片区，按地形选址，放在片区与地标都盖好以后。
 * 候选点的先后按位置哈希，同一个种子换人口时已有的设施尽量不挪。
 */
export function ruralExtras(ctx: Ctx) {
  const { counts } = ctx
  if (counts.mill > 0) watermills(ctx, counts.mill)
  if (counts.windmill > 0) windmills(ctx, counts.windmill)
  if (counts.gallows > 0) gallows(ctx, counts.gallows)
  if (counts.kiln > 0) kilns(ctx, counts.kiln)
  if (counts.lighthouse > 0) lighthouse(ctx, counts.lighthouse)
  waysides(ctx)
  if (CULTURE_INFO[ctx.p.culture].tombs) {
    const pop = ctx.p.population
    hillTombs(ctx, isVillage(ctx.p.size) ? (pop > 150 ? 2 : 1) : Math.min(10, Math.max(3, Math.round(pop / 2500) + 2)))
  }
}

/**
 * 城外的坟地（东方）：城里不设公共墓园（唐律"京城内不得葬"），各家的祖坟散在城外，多在缓坡上、面朝低处。
 * 每处是一排几座坟丘，前面一方碑，背后半圈松柏；离城不远不近，避开路与水，彼此隔开。
 * 候选点按固定网格取、位置哈希打分：同一个种子换人口时已有的坟地不挪。
 */
function hillTombs(ctx: Ctx, n: number) {
  const { T } = ctx
  const cores = ctx.out.wards.filter((w) => w.inner).map((w) => centroid(w.poly))
  if (!cores.length) return
  const half = ctx.cfg.patch * 0.55
  const step = 36
  const cands: { p: P; score: number }[] = []
  for (let x = 60; x < ctx.MW - 60; x += step)
    for (let y = 60; y < ctx.MH - 60; y += step) {
      const p: P = [x + (hashAt(ctx, [x, y], 'rural.tomb.x') - 0.5) * step, y + (hashAt(ctx, [x, y], 'rural.tomb.y') - 0.5) * step]
      if (T.waterAt(p) < 25) continue
      const slope = T.slopeAt(p)
      if (slope > 0.25) continue
      let edge = Infinity
      for (const c of cores) edge = Math.min(edge, dist(c, p) - half)
      if (edge < 50 || edge > 500 || ctx.corridors.hits(p, 18)) continue
      cands.push({ p, score: Math.min(slope, 0.12) * 5 + hashAt(ctx, p, 'rural.tomb.score') * 0.6 - edge * 0.0008 })
    }
  cands.sort((a, b) => b.score - a.score)
  const made: P[] = []
  for (const { p } of cands) {
    if (made.length >= n) break
    if (made.some((m) => dist(m, p) < 110)) continue
    const r = 10 + hashAt(ctx, p, 'rural.tomb.r') * 6
    const ground = circlePoly(p, r, 14)
    if (!isFree(ctx, ground, { pad: 1 })) continue
    // 朝向低处（坡上的坟面朝山下）；平地朝南
    const gx = T.heightAt([p[0] + 4, p[1]]) - T.heightAt([p[0] - 4, p[1]])
    const gy = T.heightAt([p[0], p[1] + 4]) - T.heightAt([p[0], p[1] - 4])
    const gl = Math.hypot(gx, gy)
    const front: P = gl > 0.05 ? [-gx / gl, -gy / gl] : [0, 1]
    const side: P = [-front[1], front[0]]
    const k = 2 + Math.floor(hashAt(ctx, p, 'rural.tomb.n') * 4)
    const parts: [Poly, BuildingKind][] = []
    for (let i = 0; i < k; i++) {
      const o = (i - (k - 1) / 2) * 4.4
      const q: P = [p[0] - front[0] * r * 0.2 + side[0] * o, p[1] - front[1] * r * 0.2 + side[1] * o]
      parts.push([circlePoly(q, 1.7 + hashAt(ctx, q, 'rural.tomb.shed') * 0.7, 10), 'shed'])
    }
    parts.push([rect([p[0] + front[0] * r * 0.4, p[1] + front[1] * r * 0.4], side, 1.8, 0.7), 'civic'])
    if (!build(ctx, parts, ground)) continue
    emitArea(ctx, 'greens', ground, 'cemetery')
    ctx.occ.add(ground)
    // 背后半圈松柏
    for (let a = -1.2; a <= 1.2; a += 0.3) {
      const d: P = [-front[0] * Math.cos(a) + side[0] * Math.sin(a), -front[1] * Math.cos(a) + side[1] * Math.sin(a)]
      plantTree(ctx, [p[0] + d[0] * (r + 2.5), p[1] + d[1] * (r + 2.5)], 2.2 + hashAt(ctx, d, 'rural.tomb.tree') * 0.8)
    }
    made.push(p)
  }
}

/** 画面内、离图边留点余地 */
const onMap = (ctx: Ctx, q: P, m = 30) => q[0] > m && q[1] > m && q[0] < ctx.MW - m && q[1] < ctx.MH - m

/** 一组建筑要么全放下、要么一个不放；放下后清掉脚下的田与树 */
function build(ctx: Ctx, parts: [Poly, BuildingKind][], foot: Poly): boolean {
  if (!parts.every(([p]) => isFree(ctx, p, { pad: 1 }))) return false
  clear(ctx, foot)
  return addGroup(ctx, parts, 1)
}

const RURAL = new Set<Landmark['kind']>(['mill', 'windmill', 'gallows', 'kiln', 'lighthouse'])
/** 附近已经有别的城外设施 */
const crowded = (ctx: Ctx, p: P, r = 150) => ctx.out.landmarks.some((l) => RURAL.has(l.kind) && dist(l.p, p) < r)

/**
 * 水车磨坊（东方叫水碾）：贴着河岸的一座磨房，水车半浸在河里（地标点就是水车的位置）。
 * 在城区上下游一两个城区半径内的河岸上找，彼此隔开一段。
 */
function watermills(ctx: Ctx, n: number) {
  const river = ctx.T.river
  if (!river) return
  const L = polylineLength(river.line)
  const cands: { p: P; key: number }[] = []
  for (let s = 20; s < L - 20; s += 18) {
    const p = pointAt(river.line, s).p
    const d = centerDist(ctx, p)
    if (d < ctx.Rin * 0.5 || d > ctx.Rin * 2.4 + 200 || !onMap(ctx, p)) continue
    cands.push({ p: [s, 0], key: hashAt(ctx, p, 'rural.mill.order') })
  }
  cands.sort((a, b) => a.key - b.key)
  const made: P[] = []
  for (const c of cands) {
    if (made.length >= n) break
    const s = c.p[0]
    const { p, angle } = pointAt(river.line, s)
    if (made.some((m) => dist(m, p) < 140)) continue
    const u: P = [Math.cos(angle), Math.sin(angle)]
    // 河的半宽：取最近的河道节点
    let k = 0
    for (let i = 1; i < river.line.length; i++) if (dist(river.line[i], p) < dist(river.line[k], p)) k = i
    const hw = river.hw[k] ?? 6
    for (const side of hashAt(ctx, p, 'rural.mill.side') < 0.5 ? [1, -1] : [-1, 1]) {
      const nrm: P = [-u[1] * side, u[0] * side]
      const hc: P = [p[0] + nrm[0] * (hw + 6.5), p[1] + nrm[1] * (hw + 6.5)]
      const house = rect(hc, u, 12, 8)
      if (!build(ctx, [[house, 'civic']], rect(hc, u, 16, 12))) continue
      const wheel: P = [p[0] + nrm[0] * (hw + 1), p[1] + nrm[1] * (hw + 1)]
      mark(ctx, wheel, 'mill')
      made.push(p)
      break
    }
  }
}

/**
 * 风车：西式的磨坊风车立在城外开阔的高处（田野里的小丘、缓坡顶），塔身是一座小圆屋，
 * 风帆在地图上画成十字（见 render.ts）。
 */
function windmills(ctx: Ctx, n: number) {
  const { T } = ctx
  const cands: { p: P; score: number }[] = []
  const R0 = ctx.Rin * 1.15
  const R1 = ctx.Rin * 2.6 + 250
  for (let y = 40; y < ctx.MH - 40; y += 30)
    for (let x = 40; x < ctx.MW - 40; x += 30) {
      const q: P = [x, y]
      const d = centerDist(ctx, q)
      if (d < R0 || d > R1 || T.waterAt(q) < 40 || T.slopeAt(q) > 0.2) continue
      // 比周围高：局部突出度
      let around = 0
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        around += T.heightAt([x + Math.cos(a) * 60, y + Math.sin(a) * 60])
      }
      const prom = T.heightAt(q) - around / 8
      cands.push({ p: q, score: prom + hashAt(ctx, q, 'rural.windmill') * 1.5 - (d / R1) * 0.5 })
    }
  cands.sort((a, b) => b.score - a.score)
  const made: P[] = []
  for (const c of cands) {
    if (made.length >= n) break
    if (made.some((m) => dist(m, c.p) < 220) || crowded(ctx, c.p) || ctx.corridors.gap(c.p) < 8) continue
    const body = circlePoly(c.p, 3.2, 10)
    if (!build(ctx, [[body, 'civic']], circlePoly(c.p, 9, 12))) continue
    mark(ctx, c.p, 'windmill')
    made.push(c.p)
  }
}

/** 出城大路上、离城区边缘 s0 ~ s1 米的点（城区边缘按城内片区的中心估计） */
function roadsideOutside(ctx: Ctx, s0: number, s1: number, tag: string): { p: P; u: P }[] {
  const cores = ctx.out.wards.filter((w) => w.inner).map((w) => centroid(w.poly))
  const half = ctx.cfg.patch * 0.55
  const out: { p: P; u: P; key: number }[] = []
  for (const r of ctx.out.roads) {
    if (r.kind !== 'highway') continue
    const L = polylineLength(r.line)
    for (let s = 6; s < L; s += 12) {
      const { p, angle } = pointAt(r.line, s)
      if (!onMap(ctx, p, 50)) continue
      let edge = Infinity
      for (const c of cores) edge = Math.min(edge, dist(c, p) - half)
      if (edge < s0 || edge > s1) continue
      out.push({ p, u: [Math.cos(angle), Math.sin(angle)], key: hashAt(ctx, p, tag) })
    }
  }
  return out.sort((a, b) => a.key - b.key)
}

/**
 * 城外大路边的 micro：西式路口的十字架、和风村口的祠与小鸟居、东方路边的土地庙、伊斯兰山坡上的圣徒墓（库巴）。
 * 大路每隔一段一处（和风最密），按路边点的位置哈希挑，彼此隔开。
 */
function waysides(ctx: Ctx) {
  const gap = { wa: 220, eastern: 300, western: 380, islamic: 420 }[ctx.p.culture]
  const made: P[] = []
  let budget = 0
  for (const r of ctx.out.roads) if (r.kind === 'highway') budget += polylineLength(r.line)
  const n = Math.floor(budget / gap / 2)
  for (const { p, u } of roadsideOutside(ctx, 60, 1600, 'rural.wayside.order')) {
    if (made.length >= n) break
    if (made.some((m) => dist(m, p) < gap)) continue
    const side = hashAt(ctx, p, 'rural.wayside.side') < 0.5 ? 1 : -1
    const nrm: P = [-u[1] * side, u[0] * side]
    const r = ctx.out.roads.find((x) => x.kind === 'highway')
    const off = (r?.width ?? 6) / 2 + 6
    const c: P = [p[0] + nrm[0] * off, p[1] + nrm[1] * off]
    if (crowded(ctx, c, 60) || !isFree(ctx, rect(c, u, 7, 7), { pad: 0.5 })) continue
    if (waysideAt(ctx, c, [-nrm[0], -nrm[1]])) made.push(p)
  }
}

/**
 * 刑场：出城大路边、城门外不远的一小块空地。西式立一座绞刑架（方台），东方是一片空场。
 */
function gallows(ctx: Ctx, n: number) {
  let made = 0
  for (const { p, u } of roadsideOutside(ctx, 40, 160, 'rural.gallows.order')) {
    if (made >= n) break
    const side = hashAt(ctx, p, 'rural.gallows.side') < 0.5 ? 1 : -1
    const nrm: P = [-u[1] * side, u[0] * side]
    const c: P = [p[0] + nrm[0] * 18, p[1] + nrm[1] * 18]
    const ground = rect(c, u, 16, 14)
    if (crowded(ctx, c) || !isFree(ctx, ground, { pad: 1 })) continue
    if (!eastAsian(ctx.p.culture) && !build(ctx, [[rect(c, u, 4, 4), 'shed']], ground)) continue
    if (eastAsian(ctx.p.culture)) clear(ctx, ground)
    emitArea(ctx, 'plazas', ground)
    ctx.occ.add(ground)
    mark(ctx, c, 'gallows')
    made++
  }
}

/**
 * 砖瓦窑：城外取土方便的地方（近河更好），一圈院墙里两三座圆窑、几排晾坯的长棚。
 */
function kilns(ctx: Ctx, n: number) {
  const cands = roadsideOutside(ctx, 60, 400, 'rural.kiln.order')
    .map((c) => ({ ...c, score: (ctx.T.river ? -Math.min(1, ctx.T.waterAt(c.p) / 150) : 0) + hashAt(ctx, c.p, 'rural.kiln.score') * 0.6 }))
    .sort((a, b) => a.score - b.score)
  const made: P[] = []
  for (const { p, u } of cands) {
    if (made.length >= n) break
    if (made.some((m) => dist(m, p) < 250) || crowded(ctx, p)) continue
    const side = hashAt(ctx, p, 'rural.kiln.side') < 0.5 ? 1 : -1
    const nrm: P = [-u[1] * side, u[0] * side]
    const c: P = [p[0] + nrm[0] * 30, p[1] + nrm[1] * 30]
    const at = (a: number, b: number): P => [c[0] + u[0] * a + nrm[0] * b, c[1] + u[1] * a + nrm[1] * b]
    const yard = rect(c, u, 44, 30)
    const parts: [Poly, BuildingKind][] = [
      [circlePoly(at(-12, -5), 3.6, 12), 'hall'],
      [circlePoly(at(-2, -5), 3.6, 12), 'hall'],
      [rect(at(8, -6), u, 16, 4.5), 'shed'],
      [rect(at(8, 2), u, 16, 4.5), 'shed'],
      [rect(at(-8, 9), u, 20, 4.5), 'shed'],
    ]
    if (ctx.corridors.hitsPoly(yard, 0.5) || !build(ctx, parts, yard)) continue
    emitArea(ctx, 'enclosures', yard)
    mark(ctx, at(-7, -5), 'kiln')
    made.push(p)
  }
}

/** 灯塔：离城不远的岬角上（四周海面最多的岸边陆地），一座圆塔 */
function lighthouse(ctx: Ctx, n: number) {
  const { T } = ctx
  if (!T.coast) return
  const cands: { p: P; score: number }[] = []
  for (let y = 30; y < ctx.MH - 30; y += 10)
    for (let x = 30; x < ctx.MW - 30; x += 10) {
      const q: P = [x, y]
      const w = T.waterAt(q)
      if (w < 6 || w > 16 || T.seaAt(q)) continue
      const d = centerDist(ctx, q)
      if (d < ctx.Rin * 0.4 || d > ctx.Rin * 2.5 + 250) continue
      let sea = 0
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        if (T.seaAt([x + Math.cos(a) * 45, y + Math.sin(a) * 45])) sea++
      }
      cands.push({ p: q, score: sea + hashAt(ctx, q, 'rural.lighthouse') * 2 })
    }
  cands.sort((a, b) => b.score - a.score)
  let made = 0
  for (const c of cands) {
    if (made >= n) break
    const tower = circlePoly(c.p, 4, 12)
    if (!build(ctx, [[tower, 'tower']], circlePoly(c.p, 8, 12))) continue
    mark(ctx, c.p, 'lighthouse')
    made++
  }
}
