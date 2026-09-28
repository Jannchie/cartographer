import { bboxOf, chaikin, dist, LineIndex, pointInPoly, polylineLength, resample, segDist, segIntersect, signedArea, type P } from './geom'
import { simplify } from '../render/atlas/svg/contour'
import { MinHeap } from '../gen/util'
import { memo, rngAt, type Ctx } from './ctx'
import type { Road, Wall } from './types'
import { addRoad, nearestRoad, through } from './roads'
import { touchesSea, type TerrainResult } from './terrain'
import { demolish, drop, removable } from './undo'

export const toF32 = (line: P[]) => Float32Array.from(line.flat())
/** 闭合环的 Douglas–Peucker 简化（结果不重复首点） */
export function simplifyLoop(loop: P[], tol: number): P[] {
  const out = fromF32(simplify(toF32([...loop, loop[0]]), tol))
  if (out.length > 3 && dist(out[0], out[out.length - 1]) < 1) out.pop()
  return out
}

export const fromF32 = (r: Float32Array): P[] => {
  const out: P[] = []
  for (let i = 0; i < r.length; i += 2) out.push([r[i], r[i + 1]])
  return out
}

/**
 * 平滑寻路结果：先 Douglas–Peucker 去掉阶梯，再 Chaikin 圆滑。
 * 平滑会切弯；给了地形时，切进海里的方案就退回更保守的平滑，最后退回原始折线。
 */
export function smoothRoute(line: P[], tol = 4, T?: TerrainResult): P[] {
  if (line.length < 3) return line
  for (const [t, it] of [
    [tol, 3],
    [tol / 2, 2],
    [1, 1],
  ] as const) {
    const s = chaikin(fromF32(simplify(toF32(line), t)), it)
    if (!T || !touchesSea(T, s)) return s
  }
  return line
}

/**
 * 整理城墙轮廓：栅格追踪、变形之后的轮廓常有几米长的碎边、来回折的锯齿和几乎共线的多余顶点。
 * 反复合并短边（取中点）、削掉尖刺、删去共线点，直到稳定；城墙于是由几段像样的长墙和明确的拐角组成。
 */
export function cleanLoop(loop: P[], minEdge: number): P[] {
  let pts = loop.slice()
  for (let pass = 0; pass < 8; pass++) {
    const n0 = pts.length
    // 短边：两端并成中点
    const merged: P[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      if (b && dist(a, b) < minEdge && pts.length - (i + 2) + merged.length >= 4) {
        merged.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
        i++
      } else merged.push(a)
    }
    // 尖刺（折返超过约 110°、且挨着短边）与共线点：删掉
    const kept: P[] = []
    for (let i = 0; i < merged.length; i++) {
      const prev = kept.length ? kept[kept.length - 1] : merged[merged.length - 1]
      const cur = merged[i]
      const next = merged[(i + 1) % merged.length]
      const l1 = dist(prev, cur)
      const l2 = dist(cur, next)
      const cos = ((cur[0] - prev[0]) * (next[0] - cur[0]) + (cur[1] - prev[1]) * (next[1] - cur[1])) / (l1 * l2 || 1)
      const drop = (cos < -0.35 && Math.min(l1, l2) < minEdge * 3) || cos > 0.998
      if (drop && kept.length + (merged.length - i - 1) >= 4) continue
      kept.push(cur)
    }
    pts = kept
    if (pts.length === n0) break
  }
  return pts
}

/**
 * 棱堡式城墙（要塞城）：把轮廓简化到几个主要拐角，在每个外凸拐角加一座箭头形棱堡。
 * 太短的边上不加（棱堡会彼此重叠）。scale 按片区尺度缩放棱堡大小。
 */
export function bastioned(loop: P[], scale = 1): P[] {
  const base = simplifyLoop(loop, 18 * scale)
  if (base.length < 3) return loop
  const ccw = signedArea(base) > 0
  const a = 20 * scale
  const b = 26 * scale
  const out: P[] = []
  const n = base.length
  for (let i = 0; i < n; i++) {
    const prev = base[(i - 1 + n) % n]
    const v = base[i]
    const next = base[(i + 1) % n]
    const l1 = dist(prev, v)
    const l2 = dist(v, next)
    const e1: P = [(v[0] - prev[0]) / l1, (v[1] - prev[1]) / l1]
    const e2: P = [(next[0] - v[0]) / l2, (next[1] - v[1]) / l2]
    const cross = e1[0] * e2[1] - e1[1] * e2[0]
    // 外凸拐角：转向与环绕方向一致
    const convex = ccw ? cross > 0.05 : cross < -0.05
    if (!convex || l1 < a * 2.4 || l2 < a * 2.4) {
      out.push(v)
      continue
    }
    // 外法向：两条边的外法向之和
    const o1: P = ccw ? [e1[1], -e1[0]] : [-e1[1], e1[0]]
    const o2: P = ccw ? [e2[1], -e2[0]] : [-e2[1], e2[0]]
    let nx = o1[0] + o2[0]
    let ny = o1[1] + o2[1]
    const nl = Math.hypot(nx, ny) || 1
    nx /= nl
    ny /= nl
    const f1: P = [v[0] - e1[0] * a, v[1] - e1[1] * a]
    const f2: P = [v[0] + e2[0] * a, v[1] + e2[1] * a]
    out.push(
      f1,
      [f1[0] + o1[0] * b * 0.45, f1[1] + o1[1] * b * 0.45],
      [v[0] + nx * b, v[1] + ny * b],
      [f2[0] + o2[0] * b * 0.45, f2[1] + o2[1] * b * 0.45],
      f2,
    )
  }
  return out
}

/** 沿轮廓向内偏移 d 米（按相邻两边内法向的平均），用来铺顺城环路 */
export function insetLoop(loop: P[], d: number): P[] {
  const n = loop.length
  const s = signedArea(loop) > 0 ? 1 : -1
  return loop.map((v, i) => {
    const p = loop[(i - 1 + n) % n]
    const q = loop[(i + 1) % n]
    const e1 = [v[0] - p[0], v[1] - p[1]]
    const e2 = [q[0] - v[0], q[1] - v[1]]
    const l1 = Math.hypot(e1[0], e1[1]) || 1
    const l2 = Math.hypot(e2[0], e2[1]) || 1
    const nx = (-e1[1] / l1 - e2[1] / l2) * s
    const ny = (e1[0] / l1 + e2[0] / l2) * s
    const nl = Math.hypot(nx, ny) || 1
    return [v[0] + (nx / nl) * d, v[1] + (ny / nl) * d] as P
  })
}

// —————————————————————— 登记城墙 ——————————————————————

/**
 * 墙的用途 → 墙脚两侧让出的空地（墙厚一半以外再留几米，登记成 'wall' 走廊，房子、树让开）。
 * null 不登记：城堡、宫城、卡斯巴里的殿宇、房间紧贴着墙盖（要登记的话由盖完的地方自己登记，见 wallCorridor）
 */
export const WALL_CLEAR = {
  /** 城墙：城内的环城路、城外的缓冲带 */
  city: { stone: 6, palisade: 4 },
  /** 瓮城 */
  barbican: 3,
  /** 老城墙的残段 */
  remnant: 3,
  /** 形制城市的墙（条坊的罗城、城下町的内郭） */
  plan: 1.5,
  /** 庄园、里巴特这类小院子的围墙（房间先盖、墙后登记） */
  compound: 1,
  /** 城堡、宫城、卡斯巴 */
  keep: null,
} as const
export type WallRole = keyof typeof WALL_CLEAR
/** 护城河的水带两侧再让出的空地 */
const MOAT_CLEAR = 1.5

/** 登记墙的走廊：实心的墙段两侧各让出 墙厚 / 2 + clear 米；skip 的墙段（起点在门口附近等）不登记 */
export function wallCorridor(ctx: Ctx, w: Wall, clear: number, skip?: (a: P) => boolean) {
  const n = w.loop.length
  for (let i = 0; i < n; i++) if (w.solid[i] && !skip?.(w.loop[i])) ctx.corridors.add([w.loop[i], w.loop[(i + 1) % n]], w.thickness / 2 + clear, 'wall')
}

/** 登记护城河的走廊 */
export function moatCorridor(ctx: Ctx, moat: NonNullable<Wall['moat']>) {
  for (const r of moat.runs) ctx.corridors.add(r, moat.width / 2 + MOAT_CLEAR, 'wall')
}

/**
 * 筑一道墙：塔楼先落到干地上（dryTowers），加进输出，按用途登记墙（与已经挖好的护城河）的走廊。
 * gateGap：门口这么远以内的墙段不登记走廊（穿门的大街两旁照常盖房子）。返回这道墙
 */
export function addWall(ctx: Ctx, w: Wall, role: WallRole, o: { gateGap?: number } = {}): Wall {
  dryTowers(ctx, w)
  ctx.out.walls.push(w)
  const c = WALL_CLEAR[role]
  const clear = c === null ? null : typeof c === 'number' ? c : c[w.kind]
  const gap = o.gateGap
  if (clear !== null) wallCorridor(ctx, w, clear, gap ? (a) => w.gates.some((g) => dist(a, g.p) <= gap) : undefined)
  if (w.moat) moatCorridor(ctx, w.moat)
  return w
}

/**
 * 塔楼只立在干地上（离水超过塔的半径再留一点）：落水的塔（多是临水断口两端的桥头塔、河口处的拐角塔）
 * 沿实心墙段挪回岸上最近的地方（不挤到门洞、别的塔上），附近没有干地就不设。
 */
function dryTowers(ctx: Ctx, w: Wall) {
  const { T } = ctx
  if (!w.towers.length) return
  const r = w.thickness * (w.kind === 'stone' ? 1.25 : 1.3)
  const need = r + 0.5
  const gateGap = w.kind === 'stone' ? 16 : 10
  const n = w.loop.length
  const out: P[] = []
  // 挪过来的塔不压到别的塔上
  const free = (q: P) => !out.some((o) => dist(o, q) < r * 2 + 1) && !w.towers.some((o) => T.waterAt(o) > need && dist(o, q) < r * 2 + 1)
  for (const t of w.towers) {
    if (T.waterAt(t) > need) {
      out.push(t)
      continue
    }
    let best: P | null = null
    let bd = 16
    for (let i = 0; i < n; i++) {
      if (!w.solid[i]) continue
      const a = w.loop[i]
      const b = w.loop[(i + 1) % n]
      if (segDist(t, a, b).d > bd) continue
      const m = Math.max(1, Math.ceil(dist(a, b)))
      for (let k = 0; k <= m; k++) {
        const q: P = [a[0] + ((b[0] - a[0]) * k) / m, a[1] + ((b[1] - a[1]) * k) / m]
        const d = dist(q, t)
        if (d < bd && T.waterAt(q) > need && free(q) && !w.gates.some((g) => dist(g.p, q) < gateGap)) {
          bd = d
          best = q
        }
      }
    }
    if (best) out.push(best)
  }
  w.towers = out
}

/**
 * 沿闭合环筑墙：临水处断开，干道穿墙处开城门，拐角与长墙段上设塔楼，墙两侧留出空地（走廊）。bastions：棱堡墙；barbicans：最多加几座瓮城；moat：挖护城河；
 * keep：只筑满足的部分（保留的内城墙只留新墙里面的那段），别处断开，那里也不设塔、不开门。
 */
export function wallFromLoop(
  ctx: Ctx,
  simp: P[],
  kind: 'stone' | 'palisade',
  arterials: P[][],
  { bastions = false, barbicans = 0, moat = false, keep }: { bastions?: boolean; barbicans?: number; moat?: boolean; keep?: (q: P) => boolean } = {},
) {
  const { T, rng } = ctx
  const towerStep = 62
  // 临水处（与 keep 之外）断开：沿边采样，在交界处插入顶点
  const loop: P[] = []
  const solid: boolean[] = []
  const dry = (q: P) => T.waterAt(q) > 2 && (!keep || keep(q))
  for (let i = 0; i < simp.length; i++) {
    const a = simp[i]
    const b = simp[(i + 1) % simp.length]
    const n = Math.max(2, Math.ceil(dist(a, b) / 3))
    loop.push(a)
    let state = dry(a)
    solid.push(state)
    for (let k = 1; k < n; k++) {
      const q: P = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]
      const s = dry(q)
      if (s !== state) {
        loop.push(q)
        solid.push(s)
        state = s
      }
    }
  }
  // 城门：干道与城墙的第一个交点
  const gates: { p: P; angle: number; road: number }[] = []
  arterials.forEach((road, ri) => {
    for (let s = 0; s + 1 < road.length; s++) {
      let hit: { k: number; t: number; u: number } | null = null
      for (let k = 0; k < loop.length; k++) {
        const r = segIntersect(road[s], road[s + 1], loop[k], loop[(k + 1) % loop.length])
        if (r && r.t >= 0 && r.t <= 1 && r.u >= 0 && r.u <= 1 && (!hit || r.t < hit.t)) hit = { k, ...r }
      }
      if (!hit) continue
      const a = loop[hit.k]
      const b = loop[(hit.k + 1) % loop.length]
      const gp: P = [a[0] + (b[0] - a[0]) * hit.u, a[1] + (b[1] - a[1]) * hit.u]
      if (!solid[hit.k] || gates.some((g) => dist(g.p, gp) < 20)) return
      loop.splice(hit.k + 1, 0, gp)
      solid.splice(hit.k + 1, 0, solid[hit.k])
      gates.push({ p: gp, angle: Math.atan2(road[s + 1][1] - road[s][1], road[s + 1][0] - road[s][0]), road: ri })
      return
    }
  })
  // 塔楼：先放断口两端（桥头，必有），再按拐角大小依次放拐角塔，最后沿长墙每隔一段补塔；
  // 任意两座塔至少隔 minGap，城墙节点再密也不会挤成一串
  const towers: P[] = []
  const nearGate = (q: P) => gates.some((g) => dist(g.p, q) < (kind === 'stone' ? 16 : 10))
  const minGap = kind === 'stone' ? 24 : 14
  const tryTower = (q: P, gap = minGap) => {
    if (nearGate(q) || towers.some((t) => dist(t, q) < gap)) return false
    towers.push(q)
    return true
  }
  const n = loop.length
  const corners: { p: P; turn: number }[] = []
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n]
    const cur = loop[i]
    const next = loop[(i + 1) % n]
    const s0 = solid[(i - 1 + n) % n]
    const s1 = solid[i]
    if (!s0 && !s1) continue
    if (s0 !== s1) {
      tryTower(cur, 4)
      continue
    }
    const a1 = Math.atan2(cur[1] - prev[1], cur[0] - prev[0])
    const a2 = Math.atan2(next[1] - cur[1], next[0] - cur[0])
    let turn = Math.abs(a2 - a1)
    if (turn > Math.PI) turn = Math.PI * 2 - turn
    if (turn > (kind === 'stone' ? 0.2 : 0.45)) corners.push({ p: cur, turn })
  }
  // 棱堡墙：棱堡本身就是防御点，只在断口两端设塔
  if (!bastions) {
    corners.sort((a, b) => b.turn - a.turn)
    for (const c of corners) tryTower(c.p)
    if (kind === 'stone') {
      // 沿墙走，离上一座塔超过 step 就补一座（圆墙、长直墙上也有均匀的塔）
      let step = towerStep + rng.next() * 16
      let since = 0
      for (let i = 0; i < n; i++) {
        if (!solid[i]) {
          since = 0
          continue
        }
        const a = loop[i]
        const b = loop[(i + 1) % n]
        const m = Math.max(1, Math.ceil(dist(a, b) / 4))
        for (let k = 0; k < m; k++) {
          const q: P = [a[0] + ((b[0] - a[0]) * k) / m, a[1] + ((b[1] - a[1]) * k) / m]
          if (towers.some((t) => dist(t, q) < 6)) since = 0
          since += dist(a, b) / m
          if (since > step && tryTower(q)) {
            since = 0
            step = towerStep + rng.next() * 16
          }
        }
      }
    }
  }
  const thickness = kind === 'stone' ? (ctx.p.size === 'city' ? 5 : 4) : 2
  const wall = addWall(ctx, { loop, solid, towers, gates: gates.map(({ p, angle }) => ({ p, angle })), kind, thickness }, 'city')
  // 城门名按它在城的哪一面（相对墙圈中心的方位），不按穿墙那段路的走向（路可能斜着进城）
  const wc = loop.reduce((a, q) => [a[0] + q[0] / loop.length, a[1] + q[1] / loop.length], [0, 0] as P)
  for (const g of gates) ctx.out.landmarks.push({ p: g.p, name: ctx.namer.gate(Math.atan2(g.p[1] - wc[1], g.p[0] - wc[0])), kind: 'gate' })
  // 瓮城：按干道先后给城门加，放不下的城门跳过
  const withBarbican: P[] = []
  if (kind === 'stone') {
    let left = barbicans
    for (const g of gates)
      if (left > 0 && barbican(ctx, g.p, loop, arterials[g.road], thickness)) {
        left--
        withBarbican.push(g.p)
      }
  }
  if (moat) wall.moat = moatOf(ctx, wall, withBarbican)
  return wall
}

/**
 * 护城河：沿城墙外侧一圈（离墙脚留一段空地），宽 8 ~ 12 米。
 * - 临水的墙段本来就是水、不另挖；墙外紧挨着海、湖、河平行走的一段（水就是天然的屏障）也不挖；
 * - 地势比墙脚高出几米的地方存不住水，断开（山城的河只绕低处）；瓮城凸出去的那一段让开；
 * - 每段的两头若离水不远，顺着地势一直挖到水里：护城河与河道、入海口连成一片，引水、排水都靠它们。
 * 城门外架一座桥；水带登记为走廊，墙外的房子让开它。
 */
function moatOf(ctx: Ctx, wall: Wall, barbicans: P[]): Wall['moat'] {
  const { T } = ctx
  const width = ctx.p.size === 'city' ? 12 : 8
  const d = wall.thickness / 2 + 5 + width / 2
  const out = insetLoop(wall.loop, -d)
  const n = wall.loop.length
  // 墙外紧挨着水（从墙脚往外看，护城河再往外 30 米内就是水）：水面平行地护着这段墙，不必再挖
  const waterOutside = (q: P, w: P) => {
    const L = dist(q, w) || 1
    const o: P = [(q[0] - w[0]) / L, (q[1] - w[1]) / L]
    for (let s = width / 2 + 4; s <= width / 2 + 34; s += 6) if (T.waterAt([q[0] + o[0] * s, q[1] + o[1] * s]) < 0) return true
    return false
  }
  // 从护城河的一头顺着"朝最近的水"的方向挖进水里（最远 60 米）；要穿过城墙就不挖
  const crossesWall = (p: P, q: P) => {
    for (let i = 0; i < n; i++) {
      const hit = segIntersect(p, q, wall.loop[i], wall.loop[(i + 1) % n])
      if (hit && hit.t > 0 && hit.t < 1 && hit.u >= 0 && hit.u <= 1) return true
    }
    return false
  }
  const toWater = (e: P): P[] => {
    if (T.waterAt(e) > 45) return []
    const pts: P[] = []
    let q = e
    for (let k = 0; k < 20; k++) {
      const g = T.waterGrad(q)
      const L = Math.hypot(g[0], g[1]) || 1
      const nq: P = [q[0] - (g[0] / L) * 3, q[1] - (g[1] / L) * 3]
      if (crossesWall(q, nq)) return []
      pts.push(nq)
      q = nq
      if (T.waterAt(q) < -2) return pts
    }
    return []
  }
  const runs: P[][] = []
  let cur: P[] = []
  const flush = () => {
    if (cur.length > 1 && polylineLength(cur) > 20) runs.push(cur)
    cur = []
  }
  for (let i = 0; i < n; i++) {
    if (!wall.solid[i]) {
      flush()
      continue
    }
    const a = out[i]
    const b = out[(i + 1) % n]
    const w0 = wall.loop[i]
    const w1 = wall.loop[(i + 1) % n]
    const m = Math.max(1, Math.ceil(dist(a, b) / 3))
    for (let k = 0; k <= m; k++) {
      const t = k / m
      const q: P = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const w: P = [w0[0] + (w1[0] - w0[0]) * t, w0[1] + (w1[1] - w0[1]) * t]
      // 与同一处的墙脚比：高出太多（陡坡上）存不住水；缓坡上的河顺着地势分级开挖
      const foot = T.heightAt(w)
      const ok = T.waterAt(q) > width / 2 && T.heightAt(q) - foot < 7 && !barbicans.some((g) => dist(g, q) < d + 14) && !waterOutside(q, w)
      if (!ok) flush()
      else if (!cur.length || dist(cur[cur.length - 1], q) > 0.5) cur.push(q)
    }
  }
  flush()
  // 首尾相接的一圈并成一段
  if (runs.length > 1 && dist(runs[0][0], runs[runs.length - 1][runs[runs.length - 1].length - 1]) < 4) runs[0] = [...runs.pop()!, ...runs[0]]
  // 两头接进附近的水里（河道、入海口、湖）
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]
    if (dist(r[0], r[r.length - 1]) < 4) continue
    runs[k] = [...toWater(r[0]).reverse(), ...r, ...toWater(r[r.length - 1])]
  }
  if (!runs.length) return undefined
  const bridges: { p: P; angle: number }[] = []
  for (const g of wall.gates) {
    let best: P | null = null
    let bd = d + 4
    for (const r of runs)
      for (let k = 0; k + 1 < r.length; k++) {
        const s = segDist(g.p, r[k], r[k + 1])
        if (s.d < bd) {
          bd = s.d
          best = [r[k][0] + (r[k + 1][0] - r[k][0]) * s.t, r[k][1] + (r[k + 1][1] - r[k][1]) * s.t]
        }
      }
    if (best) bridges.push({ p: best, angle: g.angle })
  }
  const moat = { runs, width, bridges }
  moatCorridor(ctx, moat)
  return moat
}

/**
 * 瓮城：城门外贴着城墙再围一圈小城（方形或半圆，随放射度），干道从外门进、内门出。
 * 外门开在干道与外圈的交点上，干道斜穿时外门自然落在侧面，这正是瓮城常见的错位门。
 */
function barbican(ctx: Ctx, gp: P, loop: P[], road: P[], thickness: number): boolean {
  const { T } = ctx
  const i = loop.indexOf(gp)
  const n = loop.length
  if (i < 0) return false
  const a = loop[(i - 1 + n) % n]
  const b = loop[(i + 1) % n]
  const L = dist(a, b) || 1
  const t: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  // 朝外的法线：用城墙多边形本身判断里外（棱堡墙、凹进去的墙段上，"背离城心"并不可靠）
  let nx: P = [-t[1], t[0]]
  if (pointInPoly([gp[0] + nx[0] * 3, gp[1] + nx[1] * 3], loop)) nx = [-nx[0], -nx[1]]
  // 各座瓮城用自己的随机数流：改瓮城数量不影响城里别的东西
  const rng = rngAt(ctx, gp, 'walls.gate')
  const sc = ctx.cfg.patch / 96
  const at = (u: number, v: number): P => [gp[0] + t[0] * u + nx[0] * v, gp[1] + t[1] * u + nx[1] * v]
  // 两端要搭在城墙上：沿切线往两边走，离墙超过 2.5 米就停（棱堡的短墙段、急弯处瓮城随之变窄）
  const onWall = (u: number) => {
    const q = at(u, 0)
    let best = Infinity
    for (let k = 0; k < n; k++) best = Math.min(best, segDist(q, loop[k], loop[(k + 1) % n]).d)
    return best < 2.5
  }
  let hw = (24 + rng.next() * 8) * sc
  while (hw > 14 * sc && !(onWall(-hw) && onWall(hw) && onWall(-hw / 2) && onWall(hw / 2))) hw -= 2
  if (hw <= 14 * sc) return false
  const d = Math.max(hw * 0.8, (24 + rng.next() * 10) * sc)
  // 外圈：从城墙上的 A（−hw）绕到 B（+hw）
  const round = rng.next() < ctx.p.radial
  const outline: P[] = round
    ? Array.from({ length: 11 }, (_, k) => {
        const th = Math.PI * (1 - k / 10)
        return at(Math.cos(th) * hw, Math.sin(th) * d)
      })
    : [at(-hw, 0), at(-hw, d), at(hw, d), at(hw, 0)]
  // 两端要落在实心墙上、整圈在陆上，也不能压到别的瓮城
  if (resample(outline, 3).some((q) => T.waterAt(q) < 3)) return false
  if (ctx.occ.overlaps(outline)) return false
  // 外门：干道与外圈的第一个交点（从城门往外走）
  let gate: { k: number; p: P; angle: number } | null = null
  let best = Infinity
  for (let s = 0; s + 1 < road.length; s++)
    for (let k = 0; k + 1 < outline.length; k++) {
      const r = segIntersect(road[s], road[s + 1], outline[k], outline[k + 1])
      if (!r || r.t < 0 || r.t > 1 || r.u < 0 || r.u > 1) continue
      const p: P = [outline[k][0] + (outline[k + 1][0] - outline[k][0]) * r.u, outline[k][1] + (outline[k + 1][1] - outline[k][1]) * r.u]
      const dd = dist(p, gp)
      if (dd < best && dd > d * 0.5) {
        best = dd
        gate = { k, p, angle: Math.atan2(road[s + 1][1] - road[s][1], road[s + 1][0] - road[s][0]) }
      }
    }
  // 外门离两端太近（贴着城墙）就不像样了
  if (!gate || dist(gate.p, outline[0]) < 6 || dist(gate.p, outline[outline.length - 1]) < 6) return false
  const wl = [...outline.slice(0, gate.k + 1), gate.p, ...outline.slice(gate.k + 1)]
  // 最后一条边（B → A）贴着城墙，不画
  const solid = wl.map((_, k) => k < wl.length - 1)
  const towers = round ? [wl[0], wl[wl.length - 1]] : [wl[1], wl[wl.length - 2]].filter((q) => q !== gate!.p)
  addWall(ctx, { loop: wl, solid, towers, gates: [{ p: gate.p, angle: gate.angle }], kind: 'stone', thickness: thickness * 0.85 }, 'barbican')
  ctx.occ.add(outline)
  return true
}

// —————————————————————— 城堡、宫城的门接路 ——————————————————————

/** 门口离路网多近算接上了（米，减去路面半宽） */
export const GATE_REACH = 6

/** 门口接上了哪些路：能走车马的路，或者专给门修的门前街、上山的小路 */
export const gateAccess = (ctx: Ctx) => {
  const own = gateStreets(ctx)
  return (r: Road) => through(r) || own.has(r)
}

/** 墙圈第 k 条边上 p 处朝外的单位法向 */
function outward(loop: P[], k: number, p: P): P {
  const a = loop[k]
  const b = loop[(k + 1) % loop.length]
  const L = dist(a, b) || 1
  let n: P = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]
  if (pointInPoly([p[0] + n[0] * 2, p[1] + n[1] * 2], loop)) n = [-n[0], -n[1]]
  return n
}

/** 离 p 最近的墙圈边 */
function edgeOf(loop: P[], p: P): number {
  let k = 0
  let bd = Infinity
  for (let i = 0; i < loop.length; i++) {
    const d = segDist(p, loop[i], loop[(i + 1) % loop.length]).d
    if (d < bd) {
      bd = d
      k = i
    }
  }
  return k
}

interface GateRoute {
  /** 门（可能挪过位置）与朝外的方向 */
  p: P
  n: P
  /** 从门口到路网的折线 */
  line: P[]
  cost: number
}

/**
 * 从门口（movable 时整圈墙上能开门的地方都算）寻路到最近的道路：2 米一格的 Dijkstra。
 * 水、别的墙（门洞除外）、护城河（桥头除外）、本墙圈里面、宫殿寺庙这类要紧的建筑都过不去；
 * 民居、棚屋能拆但代价很高（路尽量走片区之间的缝），挪门也有代价（原来的门位优先）。
 */
function routeGate(ctx: Ctx, w: Wall, gate: P, movable: boolean, R = 200): GateRoute | null {
  const { T } = ctx
  const cs = 2
  const N = Math.ceil((R * 2) / cs)
  const x0 = gate[0] - R
  const y0 = gate[1] - R
  const at = (i: number, j: number): P => [x0 + (i + 0.5) * cs, y0 + (j + 0.5) * cs]
  const inGrid = (i: number, j: number) => i >= 0 && j >= 0 && i < N && j < N
  // 每格的额外代价（Infinity 过不去）与是否在路上
  const extra = new Float32Array(N * N)
  const road = new Uint8Array(N * N)
  const box = (bb: [number, number, number, number], pad: number, f: (k: number, q: P) => void) => {
    const i0 = Math.max(0, Math.floor((bb[0] - pad - x0) / cs))
    const i1 = Math.min(N - 1, Math.floor((bb[2] + pad - x0) / cs))
    const j0 = Math.max(0, Math.floor((bb[1] - pad - y0) / cs))
    const j1 = Math.min(N - 1, Math.floor((bb[3] + pad - y0) / cs))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * N + i, at(i, j))
  }
  const segBox = (a: P, b: P): [number, number, number, number] => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
  const line = (a: P, b: P, r: number, f: (k: number) => void) =>
    box(segBox(a, b), r, (k, q) => {
      if (segDist(q, a, b).d < r) f(k)
    })
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (T.waterAt(at(i, j)) < 1.5) extra[j * N + i] = Infinity
  // 片区之间的缝好走，街坊里面（院子）稍贵，园子、墓地再贵些
  for (const b of ctx.out.blocks)
    box(bboxOf(b), 0, (k, q) => {
      if (pointInPoly(q, b)) extra[k] += 0.6
    })
  for (const g of ctx.out.greens)
    box(bboxOf(g.poly), 0, (k, q) => {
      if (pointInPoly(q, g.poly)) extra[k] += g.kind === 'cemetery' ? 6 : 1
    })
  // 房子：民居能拆（贵），别的过不去
  const probe: P[] = [
    [0, 0],
    [1.2, 0],
    [-1.2, 0],
    [0, 1.2],
    [0, -1.2],
  ]
  for (const b of ctx.out.buildings) {
    const bb = bboxOf(b.poly)
    if (bb[2] < x0 - 2 || bb[0] > x0 + R * 2 + 2 || bb[3] < y0 - 2 || bb[1] > y0 + R * 2 + 2) continue
    // 门前街可以拆掉民居、棚，以及路边的祠、小鸟居这类占一户宅地的小东西
    const hard = !removable(b, true)
    box(bb, 1.5, (k, q) => {
      if (probe.some(([dx, dy]) => pointInPoly([q[0] + dx, q[1] + dy], b.poly))) extra[k] = hard ? Infinity : extra[k] + 14
    })
  }
  // 墙：别的墙只在门洞处能过；护城河只在桥头能过
  const openings: P[] = []
  for (const o of ctx.out.walls) {
    if (o !== w) openings.push(...o.gates.map((g) => g.p))
    for (const b of o.moat?.bridges ?? []) openings.push(b.p)
  }
  const wallMask = new Uint8Array(N * N)
  for (const o of ctx.out.walls) {
    const n = o.loop.length
    for (let s = 0; s < n; s++) if (o.solid[s]) line(o.loop[s], o.loop[(s + 1) % n], o.thickness / 2 + 1.5, (k) => (wallMask[k] = 1))
    for (const run of o.moat?.runs ?? []) for (let s = 0; s + 1 < run.length; s++) line(run[s], run[s + 1], o.moat!.width / 2 + 1, (k) => (wallMask[k] = 1))
  }
  for (const g of openings)
    box([g[0], g[1], g[0], g[1]], 9, (k, q) => {
      if (dist(q, g) < 9) wallMask[k] = 0
    })
  for (let k = 0; k < N * N; k++) if (wallMask[k]) extra[k] = Infinity
  box(bboxOf(w.loop), 0, (k, q) => {
    if (pointInPoly(q, w.loop)) extra[k] = Infinity
  })
  for (const r of ctx.out.roads) {
    if (!through(r)) continue
    for (let s = 0; s + 1 < r.line.length; s++) line(r.line[s], r.line[s + 1], r.width / 2 + 0.5, (k) => (road[k] = 1))
  }
  // 起点：门口外一步；可挪门时墙上每隔几米都是候选门位（离拐角留出余地）
  const starts: { p: P; n: P; cost: number }[] = []
  starts.push({ p: gate, n: outward(w.loop, edgeOf(w.loop, gate), gate), cost: 0 })
  if (movable) {
    const n = w.loop.length
    for (let k = 0; k < n; k++) {
      if (!w.solid[k]) continue
      const a = w.loop[k]
      const b = w.loop[(k + 1) % n]
      const L = dist(a, b)
      for (let s = 9; s <= L - 9; s += 6) {
        const p: P = [a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L]
        if (dist(p, gate) > 6) starts.push({ p, n: outward(w.loop, k, p), cost: 20 })
      }
    }
  }
  const step0 = w.thickness / 2 + 3
  const dval = new Float64Array(N * N).fill(Infinity)
  const prev = new Int32Array(N * N).fill(-1)
  const from = new Int32Array(N * N).fill(-1)
  const heap = new MinHeap(1024)
  const push = (k: number) => heap.push(dval[k], k)
  starts.forEach((s0, si) => {
    const i = Math.floor((s0.p[0] + s0.n[0] * step0 - x0) / cs)
    const j = Math.floor((s0.p[1] + s0.n[1] * step0 - y0) / cs)
    if (!inGrid(i, j)) return
    const k = j * N + i
    if ((extra[k] === Infinity && !road[k]) || s0.cost >= dval[k]) return
    dval[k] = s0.cost
    from[k] = si
    push(k)
  })
  const steps = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ]
  let goal = -1
  const done = new Uint8Array(N * N)
  while (heap.size) {
    const k = heap.pop()
    if (done[k]) continue
    done[k] = 1
    if (road[k]) {
      goal = k
      break
    }
    const i = k % N
    const j = (k - i) / N
    for (const [di, dj, len] of steps) {
      const ni = i + di
      const nj = j + dj
      if (!inGrid(ni, nj)) continue
      const nk = nj * N + ni
      if (done[nk] || (extra[nk] === Infinity && !road[nk])) continue
      const c = dval[k] + len * cs * (1 + (road[nk] ? 0 : extra[nk]))
      if (c < dval[nk]) {
        dval[nk] = c
        prev[nk] = k
        from[nk] = from[k]
        push(nk)
      }
    }
  }
  if (goal < 0) return null
  const cells: P[] = []
  for (let k = goal; k >= 0; k = prev[k]) cells.push(at(k % N, Math.floor(k / N)))
  cells.reverse()
  const s0 = starts[from[goal]]
  // 终点落到那条路的中线上
  const e0 = cells[cells.length - 1]
  const end = nearestRoad(ctx, e0)?.p ?? e0
  const out: P[] = [s0.p, [s0.p[0] + s0.n[0] * step0, s0.p[1] + s0.n[1] * step0], ...cells.slice(1, -1), end]
  // 简化会切角：切进水里（护城河、河岸）就用没简化的折线
  const simp = fromF32(simplify(toF32(out), 1.2))
  const wet = (l: P[]) => resample(l, 1).some((q) => T.waterAt(q) < 0.5)
  return { p: s0.p, n: s0.n, line: wet(simp) ? out : simp, cost: dval[goal] }
}

/**
 * 城堡、宫城、卫城这类自带墙圈的院子（城墙以外的墙）：每座门都要有路通进来。
 * 门口离路网超过 GATE_REACH 的，从门口寻一条最省事的路接到最近的道路上（修成小街，挡路的民居拆掉）；
 * 只有一座门的可以挪到墙上更好接路的地方；几座门里接不上（朝着护城河、城墙）或要绕很远的，那座门不开。
 * 接上路的门都插进墙圈作顶点（画墙时在那里断开门洞）。
 * 院子盖好时就接（walls 给这座院子的墙）：门前街的走廊在之后盖的房子之前登记，之后划宫城地盘时也留着它（gateStreets）。
 */
export function connectGates(ctx: Ctx, walls: Wall[]) {
  const city = new Set(ctx.cityWalls)
  for (const w of walls.slice()) {
    if (city.has(w) || !w.gates.length) continue
    const far = w.gates.filter((g) => !nearestRoad(ctx, g.p, GATE_REACH, gateAccess(ctx)))
    if (!far.length) continue
    const connected = w.gates.length - far.length
    const routes = far.map((g) => ({ g, r: routeGate(ctx, w, g.p, w.gates.length === 1) }))
    // 别的门都不接路时，最好接的那座总要开
    let best: GateRoute | null = null
    if (!connected) for (const { r } of routes) if (r && (!best || r.cost < best.cost)) best = r
    const drop = new Set<Wall['gates'][number]>()
    for (const { g, r } of routes) {
      if (r && (r === best || r.cost < 140)) buildAccess(ctx, w, g, r)
      else if (w.gates.length - drop.size > 1) drop.add(g)
    }
    if (drop.size) w.gates = w.gates.filter((g) => !drop.has(g))
  }
}

/** 把门挪到 r 选的位置（插进墙圈作顶点），修门前小街，拆掉挡路的民居与树 */
function buildAccess(ctx: Ctx, w: Wall, g: Wall['gates'][number], r: GateRoute) {
  if (dist(g.p, r.p) > 0.5) {
    g.p = r.p
    g.angle = Math.atan2(r.n[1], r.n[0])
    w.towers = w.towers.filter((t) => dist(t, r.p) > 8)
  }
  if (!w.loop.some((v) => dist(v, g.p) < 0.5)) {
    const k = edgeOf(w.loop, g.p)
    w.loop.splice(k + 1, 0, g.p)
    w.solid.splice(k + 1, 0, w.solid[k])
  }
  buildStreet(ctx, r.line, 'street')
}

/**
 * 没有城门楼的院子（庄园）：墙圈断口当中的门口 door 离路远的，同样寻一条路（见 routeGate，门不挪）接到最近的路上，修成小巷
 */
export function connectDoor(ctx: Ctx, w: Wall, door: P) {
  if (nearestRoad(ctx, door, GATE_REACH, gateAccess(ctx))) return
  const r = routeGate(ctx, w, door, false)
  if (r && r.cost < 140) buildStreet(ctx, r.line, 'lane')
}

/** 修门前的路：拆掉挡路的民居与树，路记进门前街 */
function buildStreet(ctx: Ctx, L: P[], kind: 'street' | 'lane') {
  const width = Math.max(3, ctx.cfg.lane)
  const clear = width / 2 + 0.4
  const hits = (poly: P[]) => {
    for (let i = 0; i + 1 < L.length; i++) if (poly.some((v) => segDist(v, L[i], L[i + 1]).d < clear) || segPolyHit(L[i], L[i + 1], poly)) return true
    return false
  }
  demolish(ctx, (b) => removable(b, true) && hits(b.poly))
  const idx = new LineIndex(L, clear + ctx.out.trees.reduce((m, t) => Math.max(m, t.r), 0) * 0.6)
  drop(ctx, 'trees', (t) => idx.nearPoint(t.p, clear + t.r * 0.6))
  const r0 = ctx.out.roads.length
  addRoad(ctx, { line: L, width, kind })
  for (const r of ctx.out.roads.slice(r0)) gateStreets(ctx).add(r)
}

/** 门前街（接城堡、宫城的门的小街）：之后划宫城地盘拆街巷时留着它们，门不会又断了路 */
export const gateStreets = (ctx: Ctx) => memo(ctx, 'walls.gateStreets', () => new Set<Road>())

/** 线段是否碰到多边形（端点在里面或与某条边相交） */
function segPolyHit(a: P, b: P, poly: P[]) {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true
  for (let i = 0; i < poly.length; i++) {
    const h = segIntersect(a, b, poly[i], poly[(i + 1) % poly.length])
    if (h && h.t >= 0 && h.t <= 1 && h.u >= 0 && h.u <= 1) return true
  }
  return false
}
