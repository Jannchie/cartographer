import { chaikin, dist, segIntersect, type P } from './geom'
import { simplify } from '../render/atlas/svg/contour'
import type { Ctx } from './ctx'
import { touchesSea, type TerrainResult } from './terrain'

export const toF32 = (line: P[]) => Float32Array.from(line.flat())
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
 * 由城墙轮廓生成完整的城墙：临水处断开，干道穿墙处开城门，拐角与长墙段上设塔楼，
 * 并在墙两侧留出空地（走廊）。
 */
export function wallFromLoop(ctx: Ctx, simp: P[], kind: 'stone' | 'palisade', arterials: P[][], towerStep = 62) {
  const { T, rng } = ctx
  // 临水处断开：沿边采样，在水陆交界处插入顶点
  const loop: P[] = []
  const solid: boolean[] = []
  const dry = (q: P) => T.waterAt(q) > 2
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
  // 塔楼：拐角处与长墙段上
  const towers: P[] = []
  const nearGate = (q: P) => gates.some((g) => dist(g.p, q) < (kind === 'stone' ? 16 : 10))
  const n = loop.length
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n]
    const cur = loop[i]
    const next = loop[(i + 1) % n]
    const s0 = solid[(i - 1 + n) % n]
    const s1 = solid[i]
    if (!s0 && !s1) continue
    const a1 = Math.atan2(cur[1] - prev[1], cur[0] - prev[0])
    const a2 = Math.atan2(next[1] - cur[1], next[0] - cur[0])
    let turn = Math.abs(a2 - a1)
    if (turn > Math.PI) turn = Math.PI * 2 - turn
    // 断口两端（桥头）必有塔
    const endCap = s0 !== s1
    if ((turn > (kind === 'stone' ? 0.2 : 0.45) || endCap) && !nearGate(cur)) towers.push(cur)
    if (s1 && kind === 'stone') {
      const L = dist(cur, next)
      const step = towerStep + rng.next() * 16
      const m = Math.floor(L / step)
      for (let k = 1; k <= m; k++) {
        const q: P = [cur[0] + ((next[0] - cur[0]) * k) / (m + 1), cur[1] + ((next[1] - cur[1]) * k) / (m + 1)]
        if (!nearGate(q)) towers.push(q)
      }
    }
  }
  const thickness = kind === 'stone' ? (ctx.p.size === 'city' ? 5 : 4) : 2
  ctx.out.walls.push({ loop, solid, towers, gates: gates.map(({ p, angle }) => ({ p, angle })), kind, thickness })
  // 城墙两侧留出空地（城内的环城路、城外的缓冲带）
  for (let i = 0; i < loop.length; i++) if (solid[i]) ctx.corridors.add([loop[i], loop[(i + 1) % loop.length]], thickness / 2 + (kind === 'stone' ? 6 : 4), 'wall')
  for (const g of gates) ctx.out.landmarks.push({ p: g.p, name: ctx.namer.gate(g.angle), kind: 'gate' })
}
