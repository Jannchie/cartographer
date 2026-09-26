import { Biome } from '../gen/types'
import { clipWater, placeable, type Ctx } from './ctx'
import { centroid, dist, insetConvex, obb, pointAt, pointInPoly, polylineLength, rect, resample, splitConvex, voronoi, type P, type Poly } from './geom'
import type { Field, WardType } from './types'
import { addBuilding, scatterTrees, subdivide } from './wards'

/**
 * 城内外共用的部分：Voronoi 片区剖分、植被、农田、林地与道路过水处理。
 */

export interface Patch {
  poly: Poly
  site: P
  fixed: boolean
  nb: number[]
  land: number
  inner: boolean
  type?: WardType
}

/** 片区间距：城内紧凑，往外逐渐稀疏 */
export function spacing(ctx: Ctx, q: P) {
  const d = dist(q, ctx.center)
  const s = ctx.cfg.patch
  return s * Math.min(3.2, 1 + Math.max(0, (d - ctx.Rin * 0.9) / ctx.Rin) * 0.95)
}

function makeSites(ctx: Ctx, arterials: P[][], exclude?: (q: P) => boolean): { sites: P[]; fixed: boolean[] } {
  const { rng, T, MW, MH } = ctx
  const sites: P[] = [ctx.center]
  const fixed = [true]
  const ok = (q: P, s: number) => {
    if (exclude?.(q)) return false
    if (q[0] < -20 || q[1] < -20 || q[0] > MW + 20 || q[1] > MH + 20) return false
    for (const o of sites) if (dist(o, q) < s * 0.62) return false
    return true
  }
  // 沿河两岸成对布点：两点的平分线正好落在河道中线上，片区边界于是贴着河
  const river = T.river
  if (river) {
    const line = river.line
    const L = polylineLength(line)
    for (let s = 0; s < L; ) {
      const { p: q, angle } = pointAt(line, s)
      const sp = spacing(ctx, q)
      const hw = river.hw[Math.min(river.hw.length - 1, Math.round((s / L) * (river.hw.length - 1)))]
      const n: P = [-Math.sin(angle), Math.cos(angle)]
      const off = hw + sp * 0.45
      for (const sg of [-1, 1]) {
        const c: P = [q[0] + n[0] * off * sg, q[1] + n[1] * off * sg]
        if (ok(c, sp * 0.9)) {
          sites.push(c)
          fixed.push(true)
        }
      }
      s += sp * 0.85
    }
  }
  // 沿干道成对布点：路落在片区边界上，街坊与田块都沿路展开
  for (const road of arterials) {
    const L = polylineLength(road)
    for (let s = ctx.cfg.patch * 0.6; s < L; ) {
      const { p: q, angle } = pointAt(road, s)
      const sp = spacing(ctx, q)
      const n: P = [-Math.sin(angle), Math.cos(angle)]
      for (const sg of [-1, 1]) {
        const c: P = [q[0] + n[0] * sp * 0.5 * sg, q[1] + n[1] * sp * 0.5 * sg]
        if (T.waterAt(c) > 4 && ok(c, sp)) {
          sites.push(c)
          fixed.push(true)
        }
      }
      s += sp * 0.95
    }
  }
  // 其余用变密度的随机投点填满
  for (let k = 0; k < 9000; k++) {
    const q: P = [rng.next() * MW, rng.next() * MH]
    const s = spacing(ctx, q)
    if (Math.abs(T.waterAt(q)) < s * 0.22) continue
    if (ok(q, s * 1.35)) {
      sites.push(q)
      fixed.push(false)
    }
  }
  return { sites, fixed }
}

export function buildPatches(ctx: Ctx, arterials: P[][], exclude?: (q: P) => boolean): Patch[] {
  const { MW, MH, T } = ctx
  const { sites, fixed } = makeSites(ctx, arterials, exclude)
  const bounds: [number, number, number, number] = [-4, -4, MW + 4, MH + 4]
  let cells = voronoi(sites, bounds)
  // Lloyd 松弛（固定点不动）
  for (let it = 0; it < 2; it++) {
    for (let i = 0; i < sites.length; i++) if (!fixed[i] && cells[i].length >= 3) sites[i] = centroid(cells[i])
    cells = voronoi(sites, bounds)
  }
  const patches: Patch[] = sites.map((s, i) => {
    const poly = cells[i]
    // 陆地占比：顶点、边中点与质心采样
    const samples: P[] = [...poly, centroid(poly)]
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]
      const b = poly[(k + 1) % poly.length]
      samples.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
      samples.push([(a[0] * 3 + b[0] + centroid(poly)[0] * 2) / 6, (a[1] * 3 + b[1] + centroid(poly)[1] * 2) / 6])
    }
    const land = samples.filter((q) => T.waterAt(q) > 0).length / samples.length
    return { poly, site: s, fixed: fixed[i], nb: [], land, inner: false }
  })
  // 邻接：单元 i 上到两站点等距的顶点就在 i/j 的公共边上
  for (let i = 0; i < patches.length; i++) {
    const a = patches[i]
    for (let j = i + 1; j < patches.length; j++) {
      const b = patches[j]
      const d = dist(a.site, b.site)
      if (d > 4 * Math.max(spacing(ctx, a.site), spacing(ctx, b.site))) continue
      let n = 0
      for (const v of a.poly) if (Math.abs(dist(v, a.site) - dist(v, b.site)) < 0.05) n++
      if (n >= 2) {
        a.nb.push(j)
        b.nb.push(i)
      }
    }
  }
  return patches
}

/** 公共边（两个片区都有的两个顶点） */
export function sharedEdge(a: Patch, b: Patch): [P, P] | null {
  const vs = a.poly.filter((v) => Math.abs(dist(v, a.site) - dist(v, b.site)) < 0.05)
  return vs.length >= 2 ? [vs[0], vs[vs.length - 1]] : null
}


/** 由气候决定植被：林木多少、农田类型 */
export function vegetation(ctx: Ctx) {
  const c = ctx.p.climate
  if (!c) return { trees: 1, farm: true, paddy: ctx.p.culture === 'eastern' && ctx.p.relief < 0.6, vine: false }
  const b = c.biome
  const desert = b === Biome.HotDesert || b === Biome.ColdDesert || b === Biome.SaltFlat
  const cold = b === Biome.Tundra || b === Biome.IceCap
  const forest = b === Biome.TemperateForest || b === Biome.TemperateRainforest || b === Biome.Taiga || b === Biome.TropicalRainforest || b === Biome.TropicalSeasonalForest
  return {
    trees: desert ? 0.05 : cold ? 0.15 : forest ? 1.5 : b === Biome.Grassland || b === Biome.Savanna ? 0.4 : 0.9,
    farm: !cold && (!desert || !!ctx.p.river),
    paddy: ctx.p.culture === 'eastern' && c.temp > 14 && c.rain > 1000,
    vine: c.temp > 13 && c.rain < 900,
  }
}


/** 道路过水处：桥、渡口或浅滩 */
export function crossings(ctx: Ctx) {
  const { T, p } = ctx
  for (const r of ctx.out.roads) {
    if (r.kind === 'path') continue
    const line = resample(r.line, 2)
    let start = -1
    for (let i = 0; i < line.length; i++) {
      const wet = T.waterAt(line[i]) < 0.5
      if (wet && start < 0) start = i
      if ((!wet || i === line.length - 1) && start >= 0) {
        const a = line[Math.max(0, start - 2)]
        const b = line[Math.min(line.length - 1, i + 1)]
        const span = dist(a, b)
        start = -1
        if (span < 3) continue
        const smallPlace = p.size === 'hamlet' || p.size === 'village'
        const kind = smallPlace && span > 26 && r.kind === 'highway' ? 'ferry' : smallPlace && span < 14 && p.size === 'hamlet' ? 'ford' : 'bridge'
        ctx.out.crossings.push({ a, b, width: r.width + (kind === 'bridge' ? 1.5 : 0), kind })
        if (kind === 'ferry') ctx.out.landmarks.push({ p: a, name: ctx.namer.landmark('ferry', p.magic), kind: 'ferry' })
      }
    }
  }
}

/** 农田：按片区切成若干地块，耕地再细分成长条 */
export function farm(ctx: Ctx, block: Poly, veg: ReturnType<typeof vegetation>) {
  const { rng, p } = ctx
  const parcels = subdivide(ctx, block, { maxA: p.size === 'city' ? 16000 : 9000, minA: 1500, alley: 3, alleyP: 0.5, depth: 0, fill: 1, irr: 0.9 })
  for (const { poly } of parcels) {
    const r = rng.next()
    const kind: Field['kind'] = veg.paddy && r < 0.7 ? 'paddy' : r < 0.62 ? 'crop' : r < 0.8 ? 'pasture' : r < 0.92 ? 'orchard' : veg.vine ? 'vineyard' : 'crop'
    const b = obb(poly)
    const angle = Math.atan2(b.axis[1], b.axis[0])
    const tone = rng.next()
    // 偶见农舍：先占地，田里的果树再绕开它
    if (rng.next() < (p.size === 'city' ? 0.12 : 0.2)) {
      const c = centroid(poly)
      const h = rect(c, b.axis, 14, 8)
      if (ctx.corridors.gap(c) < 90 && h.every((v) => pointInPoly(v, poly)) && addBuilding(ctx, h, 'house', 2)) {
        const shed = rect([c[0] + b.axis[1] * 10, c[1] - b.axis[0] * 10], b.axis, 10, 6)
        if (shed.every((v) => pointInPoly(v, poly))) addBuilding(ctx, shed, 'shed', 2)
      }
    }
    if (kind === 'crop' || kind === 'paddy') {
      // 长条田：沿长轴方向分成窄条
      const stripW = kind === 'paddy' ? 14 + rng.next() * 10 : 11 + rng.next() * 14
      const n = Math.max(1, Math.round(b.wid / stripW))
      const across: P = [-b.axis[1], b.axis[0]]
      let rest = poly
      for (let k = 1; k <= n; k++) {
        let piece = rest
        if (k < n) {
          const off = -b.wid / 2 + (b.wid * k) / n + (rng.next() - 0.5) * stripW * 0.3
          const o: P = [b.center[0] + across[0] * off, b.center[1] + across[1] * off]
          const [x, y] = splitConvex(rest, o, b.axis, 0)
          // splitConvex 按法向 (−axis.y, axis.x)=across 分：x 在 across 负侧
          piece = x
          rest = y
        }
        if (kind === 'paddy' && piece.length >= 3) {
          // 水田再横向切成小块
          const m = Math.max(1, Math.round(b.len / (22 + rng.next() * 16)))
          let r2 = piece
          for (let t = 1; t <= m; t++) {
            let pc = r2
            if (t < m) {
              const off = -b.len / 2 + (b.len * t) / m
              const [x, y] = splitConvex(r2, [b.center[0] + b.axis[0] * off, b.center[1] + b.axis[1] * off], across, 0)
              pc = y
              r2 = x
            }
            const q = pc.length >= 3 ? placeable(ctx, insetConvex(pc, 0.6), 2, 0.2) : null
            if (q) ctx.out.fields.push({ poly: q, angle, kind, tone: rng.next() })
          }
          continue
        }
        const q = piece.length >= 3 ? placeable(ctx, insetConvex(piece, 0.5), 2, 0.2) : null
        if (q) ctx.out.fields.push({ poly: q, angle, kind, tone: (tone + rng.next() * 0.5) % 1 })
      }
    } else {
      const q = placeable(ctx, insetConvex(poly, 1.5), 2, 0.25)
      if (!q) continue
      ctx.out.fields.push({ poly: q, angle, kind, tone })
      if (kind === 'orchard') {
        const across: P = [-b.axis[1], b.axis[0]]
        for (let u = -b.len / 2 + 5; u < b.len / 2 - 4; u += 8)
          for (let v = -b.wid / 2 + 5; v < b.wid / 2 - 4; v += 8) {
            const t: P = [b.center[0] + b.axis[0] * u + across[0] * v, b.center[1] + b.axis[1] * u + across[1] * v]
            if (pointInPoly(t, q) && !ctx.occ.hitsPoint(t, 1.5) && !ctx.corridors.hits(t, 1)) ctx.out.trees.push({ p: t, r: 2.6 })
          }
      }
      if (kind === 'pasture' && rng.next() < 0.5) scatterTrees(ctx, q, 0.0004, 3, 5)
    }
  }
}

/** 野地：按噪声成片的林地，陡坡上更密 */
export function wild(ctx: Ctx, block: Poly, veg: ReturnType<typeof vegetation>) {
  const { rng, T } = ctx
  if (veg.trees <= 0.02) return
  const c = centroid(block)
  const cluster = 0.5 + 0.5 * Math.sin(c[0] * 0.011 + ctx.p.seed.length) * Math.cos(c[1] * 0.013)
  const slope = T.slopeAt(c)
  const dens = veg.trees * (0.0006 + 0.004 * cluster * cluster + slope * 0.01)
  const g = clipWater(ctx, insetConvex(block, 3), 3)
  if (g) scatterTrees(ctx, g, dens, 3, 6.5)
  void rng
}

