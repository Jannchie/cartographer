import { clipWater, type Ctx } from './ctx'
import { area, centroid, clipHalf, dist, insetConvex, pointInPoly, type P, type Poly } from './geom'
import { buildPatches, crossings, farm, spacing, vegetation, wild } from './outer'
import { landPieces, routeOnTerrain } from './terrain'
import type { Ward, WardType } from './types'
import { smoothRoute, wallFromLoop } from './walls'
import { cemetery, eastCompound, eastMarket, eastWard, harbor, magicWard, park } from './wards'

/**
 * 规划方城（东式）：矩形城墙、棋盘街道、南北中轴。
 * 宫城 / 衙署居北正中，东西两市对称，其余为里坊；坊内十字街，院落坐北朝南。
 */
export function layoutGrid(ctx: Ctx, _arterials: P[][], walled: 'stone' | 'palisade' | null) {
  const { p, rng, T, cfg, MW, MH } = ctx
  const theta = (rng.next() - 0.5) * 0.1
  ctx.gridAngle = theta
  const e: P = [Math.cos(theta), Math.sin(theta)]
  const n: P = [Math.sin(theta), -Math.cos(theta)]
  const city = p.size === 'city'
  const cs = city ? 132 : 118
  let nx = Math.max(2, Math.round(Math.sqrt(cfg.inner * 1.1) / 2) * 2)
  let ny = Math.max(2, Math.round(cfg.inner / nx))
  if (rng.next() < 0.5) ny++
  // 地图放不下就缩
  while (nx * cs > MW * 0.62 && nx > 2) nx -= 2
  while (ny * cs > MH * 0.7 && ny > 2) ny--
  // 选址：城池整体平移，让宫城（北侧正中）与城内尽量不压河、不下海
  {
    const c0 = ctx.center
    let best = c0
    let bs = Infinity
    const hw = (nx * cs) / 2
    const hh = (ny * cs) / 2
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const q: P = [c0[0] + (dx * cs) / 2, c0[1] + (dy * cs) / 2]
        if (q[0] - hw < 60 || q[0] + hw > MW - 60 || q[1] - hh < 60 || q[1] + hh > MH - 60) continue
        let wetCity = 0
        let wetPalace = 0
        for (let v = -hh; v <= hh; v += 20)
          for (let u = -hw; u <= hw; u += 20) {
            const p0: P = [q[0] + e[0] * u + n[0] * v, q[1] + e[1] * u + n[1] * v]
            if (T.waterAt(p0) < 4) {
              wetCity++
              if (v > hh - cs && Math.abs(u) < cs) wetPalace++
            }
          }
        const s = wetPalace * 10 + wetCity * 0.3 + Math.hypot(dx, dy) * 3 + T.slopeAt(q) * 200
        if (s < bs) {
          bs = s
          best = q
        }
      }
    ctx.center = best
  }
  const c = ctx.center
  const at = (u: number, v: number): P => [c[0] + e[0] * u + n[0] * v, c[1] + e[1] * u + n[1] * v]
  const U = (i: number) => (i - nx / 2) * cs
  const V = (j: number) => (j - ny / 2) * cs
  ctx.Rin = (Math.max(nx, ny) * cs) / 2

  // 街宽：中轴与中横街最宽，城内其他街次之
  const mainW = city ? 24 : 16
  const streetW = city ? 9 : 7
  const midI = nx / 2
  const midJ = Math.floor(ny / 2)
  const isMainI = (i: number) => i === midI || (city && (i === 2 || i === nx - 2) && nx >= 6)
  const isMainJ = (j: number) => j === midJ
  const widthI = (i: number) => (i === 0 || i === nx ? 0 : isMainI(i) ? (i === midI ? mainW : mainW * 0.7) : streetW)
  const widthJ = (j: number) => (j === 0 || j === ny ? 0 : isMainJ(j) ? mainW * 0.8 : streetW)

  // 宫城占北侧正中两格；中轴大街止于宫城南门
  const palaceRow = ny - 1
  const palace = { i0: midI - 1, i1: midI + 1, j0: palaceRow, j1: ny }

  // —— 城墙与城门 ——
  const corners = [at(U(0), V(0)), at(U(nx), V(0)), at(U(nx), V(ny)), at(U(0), V(ny))]
  const roadsOut: P[][] = []
  const gateLines: { from: P; dir: P }[] = []
  for (let i = 1; i < nx; i++) {
    if (!isMainI(i)) continue
    gateLines.push({ from: at(U(i), V(0)), dir: [-n[0], -n[1]] })
    if (!(i > palace.i0 && i < palace.i1)) gateLines.push({ from: at(U(i), V(ny)), dir: n })
  }
  for (let j = 1; j < ny; j++) {
    if (!isMainJ(j)) continue
    gateLines.push({ from: at(U(0), V(j)), dir: [-e[0], -e[1]] })
    gateLines.push({ from: at(U(nx), V(j)), dir: e })
  }
  // 城外大路：由城门沿地形通向地图边缘
  for (const g of gateLines) {
    const far: P = [g.from[0] + g.dir[0] * 2000, g.from[1] + g.dir[1] * 2000]
    const target = clampToMap(g.from, far, MW, MH)
    if (T.waterAt(target) < 10) continue
    const start: P = [g.from[0] - g.dir[0] * 6, g.from[1] - g.dir[1] * 6]
    const route = smoothRoute(routeOnTerrain(T, start, target, { water: 14, slope: 1 }), 4, T)
    if (route.length < 2) continue
    roadsOut.push(route)
    ctx.out.roads.push({ line: route, width: cfg.highway, kind: 'highway' })
  }
  if (walled) wallFromLoop(ctx, corners, walled, roadsOut, 70)

  // —— 城内街道 ——
  for (let i = 1; i < nx; i++) {
    const w = widthI(i)
    // 中轴大街止于宫城前的横街（街口由横街铺满），走廊不伸进宫城
    const top = i > palace.i0 && i < palace.i1 ? V(palaceRow) - widthJ(palaceRow) / 2 : V(ny)
    const name = ctx.namer.street(isMainI(i) ? 'main' : 'street')
    // 城池压到海里的部分不铺路
    for (const piece of landPieces(T, [at(U(i), V(0)), at(U(i), top)])) ctx.out.roads.push({ line: piece, width: w, kind: isMainI(i) ? 'main' : 'street', name })
  }
  for (let j = 1; j < ny; j++) {
    const w = widthJ(j)
    const name = ctx.namer.street(isMainJ(j) ? 'main' : 'street')
    for (const piece of landPieces(T, [at(U(0), V(j)), at(U(nx), V(j))])) ctx.out.roads.push({ line: piece, width: w, kind: isMainJ(j) ? 'main' : 'street', name })
  }
  // 顺城街
  const ring = 8
  const ringLine: P[] = [at(U(0) + ring, V(0) + ring), at(U(nx) - ring, V(0) + ring), at(U(nx) - ring, V(ny) - ring), at(U(0) + ring, V(ny) - ring), at(U(0) + ring, V(0) + ring)]
  for (const piece of landPieces(T, ringLine)) ctx.out.roads.push({ line: piece, width: 5, kind: 'street' })
  for (const r of ctx.out.roads) if (r.kind !== 'path') ctx.corridors.add(r.line, r.width / 2 + 1)
  if (T.river) ctx.corridors.add(T.river.line, 0, 'river')
  crossings(ctx)

  // —— 里坊 ——
  const cells: { poly: Poly; i: number; j: number; type?: WardType }[] = []
  const wallGap = walled ? 14 : 6
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (j >= palace.j0 && i >= palace.i0 && i < palace.i1) continue
      const u0 = U(i) + (i === 0 ? wallGap : widthI(i) / 2 + 2)
      const u1 = U(i + 1) - (i + 1 === nx ? wallGap : widthI(i + 1) / 2 + 2)
      const v0 = V(j) + (j === 0 ? wallGap : widthJ(j) / 2 + 2)
      const v1 = V(j + 1) - (j + 1 === ny ? wallGap : widthJ(j + 1) / 2 + 2)
      cells.push({ poly: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)], i, j })
    }
  const palacePoly = [at(U(palace.i0) + 4, V(palace.j0) + widthJ(palace.j0) / 2 + 2), at(U(palace.i1) - 4, V(palace.j0) + widthJ(palace.j0) / 2 + 2), at(U(palace.i1) - 4, V(ny) - wallGap), at(U(palace.i0) + 4, V(ny) - wallGap)]
  const landFrac = (poly: Poly) => {
    const cc = centroid(poly)
    const s = [...poly, cc, ...poly.map((v) => [(v[0] + cc[0]) / 2, (v[1] + cc[1]) / 2] as P)]
    return s.filter((q) => T.waterAt(q) > 0).length / s.length
  }
  const byIJ = (i: number, j: number) => cells.find((x) => x.i === i && x.j === j)
  // 东西两市：中横街南侧、对称
  if (city) {
    for (const i of [1, nx - 2]) {
      const m = byIJ(i, Math.max(0, midJ - 1))
      if (m) m.type = 'market'
    }
  } else {
    const m = byIJ(midI, Math.max(0, midJ - 1)) ?? byIJ(midI - 1, midJ)
    if (m) m.type = 'market'
  }
  const pickFree = (f: (x: (typeof cells)[number]) => boolean = () => true) => {
    const cand = cells.filter((x) => !x.type && landFrac(x.poly) > 0.6 && f(x))
    return cand.length ? cand[Math.floor(rng.next() * cand.length)] : undefined
  }
  for (let k = 0; k < (city ? 3 : 1); k++) {
    const t = pickFree()
    if (t) t.type = 'temple'
  }
  if (city || rng.next() < 0.5) {
    const t = pickFree((x) => x.i === 0 || x.i === nx - 1 || x.j === 0)
    if (t) t.type = 'park'
  }
  if (p.magic > 0 && !p.hills) {
    const t = pickFree((x) => x.j >= ny / 2)
    if (t) t.type = 'magic'
  }
  if (rng.next() < 0.5) {
    const t = pickFree((x) => x.j === 0)
    if (t) t.type = 'cemetery'
  }
  // 富人坊靠近宫城
  for (const x of cells) {
    if (x.type) continue
    const lf = landFrac(x.poly)
    if (lf < 0.3) x.type = 'water'
    else if (p.coast && x.poly.some((v) => T.seaAt(v) || T.waterAt(v) < 0) && x.j <= 1) x.type = 'harbor'
    else x.type = x.j >= ny - 2 && Math.abs(x.i + 0.5 - midI) < 2.5 ? 'noble' : 'common'
  }

  const ward = (poly: Poly, type: WardType, inner: boolean): Ward => {
    const w: Ward = { poly, type, inner }
    ctx.out.wards.push(w)
    return w
  }
  // 宫城
  {
    const w = ward(palacePoly, 'castle', true)
    const pc = centroid(palacePoly)
    if (!eastCompound(ctx, palacePoly, 'palace')) eastWard(ctx, palacePoly, true)
    ctx.out.landmarks.push({ p: pc, name: ctx.namer.landmark('castle', p.magic), kind: 'castle' })
    // 宫墙
    ctx.out.walls.push({ loop: palacePoly, solid: palacePoly.map(() => true), towers: palacePoly.slice(), gates: [{ p: at(0, V(palace.j0) + widthJ(palace.j0) / 2 + 2), angle: theta }], kind: 'stone', thickness: 3 })
    void w
  }
  for (const x of cells) {
    const w = ward(x.poly, x.type!, true)
    const b = clipWater(ctx, x.poly, 1.5)
    if (b) ctx.out.blocks.push(b)
    switch (x.type) {
      case 'market':
        eastMarket(ctx, x.poly)
        w.name = ctx.namer.district('market')
        break
      case 'temple': {
        const inner = insetConvex(x.poly, 6)
        const zone = eastCompound(ctx, [inner[0], inner[1], [(inner[1][0] + inner[2][0]) / 2, (inner[1][1] + inner[2][1]) / 2], [(inner[0][0] + inner[3][0]) / 2, (inner[0][1] + inner[3][1]) / 2]], 'temple')
        if (zone) {
          ctx.out.landmarks.push({ p: centroid(zone), name: ctx.namer.landmark('temple', p.magic), kind: 'temple' })
          // 北半坊仍是院落
          const half = clipHalf(x.poly, at(0, (V(x.j) + V(x.j + 1)) / 2), [-n[0], -n[1]])
          if (half.length >= 3) eastWard(ctx, half, false)
        } else eastWard(ctx, x.poly, false)
        w.name = ctx.namer.district('common')
        break
      }
      case 'park':
        park(ctx, w, x.poly)
        break
      case 'magic':
        magicWard(ctx, w, x.poly)
        break
      case 'cemetery':
        cemetery(ctx, w, x.poly)
        break
      case 'harbor':
        harbor(ctx, w, x.poly)
        w.name = ctx.namer.district('harbor')
        break
      case 'water':
        break
      default:
        eastWard(ctx, x.poly, x.type === 'noble')
        if (rng.next() < (city ? 0.7 : 0.5)) w.name = ctx.namer.district('common')
    }
  }

  // —— 城外：Voronoi 片区减去城池 ——
  const pad = walled ? 22 : 10
  const outerRect = [at(U(0) - pad, V(0) - pad), at(U(nx) + pad, V(0) - pad), at(U(nx) + pad, V(ny) + pad), at(U(0) - pad, V(ny) + pad)]
  const patches = buildPatches(ctx, roadsOut, (q) => pointInPoly(q, outerRect))
  const veg = vegetation(ctx)
  for (const pa of patches) {
    for (const piece of subtractConvex(pa.poly, outerRect)) {
      if (area(piece) < 400) continue
      const cc = centroid(piece)
      if (pa.land < 0.35) {
        ward(piece, 'water', false)
        continue
      }
      const d = dist(cc, c)
      const g = ctx.corridors.gap(cc)
      let type: WardType
      if (d < ctx.Rin * 1.5 && g < spacing(ctx, cc) * 0.5 && T.slopeAt(cc) < 0.25) type = 'suburb'
      else if (p.farms && veg.farm && T.slopeAt(cc) < 0.14 && d < ctx.Rin * 3.4 * (0.8 + rng.next() * 0.5)) type = 'farm'
      else type = 'wild'
      const w = ward(piece, type, false)
      const block = insetConvex(piece, 2)
      if (block.length < 3) continue
      if (type === 'suburb') {
        eastWard(ctx, block, false, 32)
        if (rng.next() < 0.3) w.name = ctx.namer.district('suburb')
      } else if (type === 'farm') farm(ctx, block, veg)
      else wild(ctx, block, veg)
    }
  }
}

/** 把 to 限制在地图内（沿 from→to 的射线） */
function clampToMap(from: P, to: P, MW: number, MH: number): P {
  let t = 1
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (dx > 0) t = Math.min(t, (MW - 3 - from[0]) / dx)
  if (dx < 0) t = Math.min(t, (3 - from[0]) / dx)
  if (dy > 0) t = Math.min(t, (MH - 3 - from[1]) / dy)
  if (dy < 0) t = Math.min(t, (3 - from[1]) / dy)
  return [from[0] + dx * t, from[1] + dy * t]
}

/** 凸多边形减去凸多边形 → 若干凸块 */
export function subtractConvex(poly: Poly, hole: Poly): Poly[] {
  const out: Poly[] = []
  let rest = poly
  const hc = centroid(hole)
  for (let i = 0; i < hole.length && rest.length >= 3; i++) {
    const a = hole[i]
    const b = hole[(i + 1) % hole.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    let nx = -dy
    let ny = dx
    // 外法向
    if ((hc[0] - a[0]) * nx + (hc[1] - a[1]) * ny > 0) {
      nx = -nx
      ny = -ny
    }
    // 在此边外侧的部分
    const outside = clipHalf(rest, a, [-nx, -ny])
    if (outside.length >= 3 && area(outside) > 1) out.push(outside)
    rest = clipHalf(rest, a, [nx, ny])
  }
  return out
}
