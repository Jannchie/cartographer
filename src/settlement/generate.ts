import { RNG, hashString } from '../gen/rng'
import { contours, simplify } from '../render/atlas/svg/contour'
import { Corridors, SIZE_CFG, clipWater, placeable, type Ctx } from './ctx'
import {
  area,
  centroid,
  chaikin,
  circlePoly,
  dist,
  insetConvex,
  obb,
  pointAt,
  pointInPoly,
  polylineLength,
  rect,
  resample,
  type P,
  type Poly,
} from './geom'
import { layoutGrid } from './grid'
import { fromF32, smoothRoute, wallFromLoop } from './walls'
import { buildPatches, crossings, farm, sharedEdge, spacing, vegetation, wild, type Patch } from './outer'
import { SettleNamer } from './names'
import { EXTENT, buildTerrain, routeOnTerrain } from './terrain'
import type { MapLabel, Settlement, SettlementParams, Ward, WardType } from './types'
import { castle, cemetery, eastCompound, eastWard, harbor, magicWard, noble, park, plaza, temple, urban } from './wards'

export function generateSettlement(p: SettlementParams): Settlement {
  const t0 = performance.now()
  const rng = new RNG(hashString(`${p.seed}|${p.size}|${p.culture}`))
  const T = buildTerrain(p, rng.fork())
  const [MW, MH] = EXTENT[p.size]
  const cfg = SIZE_CFG[p.size]
  const namer = new SettleNamer(p.seed, p.culture)
  const ctx: Ctx = {
    p,
    rng: rng.fork(),
    T,
    cfg,
    namer,
    MW,
    MH,
    center: [MW / 2, MH / 2],
    Rin: 0,
    gridAngle: 0,
    corridors: new Corridors(),
    out: {
      roads: [],
      crossings: [],
      walls: [],
      wards: [],
      blocks: [],
      buildings: [],
      enclosures: [],
      plazas: [],
      greens: [],
      fields: [],
      trees: [],
      piers: [],
      boats: [],
      wonders: [],
      landmarks: [],
      labels: [],
    },
  }
  ctx.Rin = Math.sqrt((cfg.inner * 0.87 * cfg.patch * cfg.patch) / Math.PI)
  ctx.center = pickCenter(ctx)
  const town = namer.town(p.size, p.coast, p.river)
  const arterials = routeArterials(ctx)

  const walled = wallsFor(ctx)
  const grid = p.culture === 'eastern' && (p.size === 'town' || p.size === 'city')
  if (grid) layoutGrid(ctx, arterials, walled)
  else layoutOrganic(ctx, arterials, walled)

  magicExtras(ctx)
  const riverName = T.river ? namer.river() : ''
  const seaName = T.coast ? namer.sea() : ''
  labels(ctx, riverName, seaName)

  const inner = ctx.out.wards.filter((w) => w.inner)
  const innerArea = inner.reduce((s, w) => s + area(w.poly), 0)
  const houses = ctx.out.buildings.filter((b) => b.kind === 'house' || b.kind === 'large').length
  return {
    params: p,
    name: p.name || town.name,
    nameZh: p.nameZh || town.zh,
    width: MW,
    height: MH,
    terrain: T.terrain,
    river: T.river ? { ...T.river, name: riverName } : null,
    sea: T.coast ? { name: seaName, p: seaPoint(ctx) } : null,
    ...ctx.out,
    stats: {
      buildings: ctx.out.buildings.filter((b) => b.kind !== 'shed').length,
      population: Math.round((houses * (p.culture === 'eastern' ? 4.2 : 5.5)) / 10) * 10,
      area: innerArea / 10000,
      ms: performance.now() - t0,
    },
  }
}

// —————————————————————— 选址与干道 ——————————————————————

/** 在地图中部找一块平坦、离水适中（便于取水与渡河）的地方作为中心 */
function pickCenter(ctx: Ctx): P {
  const { T, MW, MH, rng, p } = ctx
  let best: P = [MW / 2, MH / 2]
  let bs = Infinity
  const R = Math.min(MW, MH) / 2
  for (let k = 0; k < 500; k++) {
    const a = rng.next() * Math.PI * 2
    const r = Math.sqrt(rng.next()) * R * 0.32
    const q: P = [MW / 2 + Math.cos(a) * r, MH / 2 + Math.sin(a) * r]
    const w = T.waterAt(q)
    if (w < ctx.cfg.patch * 0.45) continue
    let s = T.slopeAt(q) * 40 + (r / R) * 2.5
    if (p.river || p.coast) s += Math.abs(w - ctx.cfg.patch * 1.1) / (ctx.cfg.patch * 1.5)
    // 依山：稍微往高处靠，但别上山
    if (p.hills) s += Math.abs(T.heightAt(q) - 14) * 0.01
    if (s < bs) {
      bs = s
      best = q
    }
  }
  return best
}

function borderPoint(ctx: Ctx, a: number): P {
  const { MW, MH, center: c } = ctx
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  let t = Infinity
  if (dx > 1e-6) t = Math.min(t, (MW - 2 - c[0]) / dx)
  if (dx < -1e-6) t = Math.min(t, (2 - c[0]) / dx)
  if (dy > 1e-6) t = Math.min(t, (MH - 2 - c[1]) / dy)
  if (dy < -1e-6) t = Math.min(t, (2 - c[1]) / dy)
  return [c[0] + dx * t, c[1] + dy * t]
}

/** 由中心通往地图边缘的干道：沿地形寻路，后修的路尽量并入已有的路 */
function routeArterials(ctx: Ctx): P[][] {
  const { rng, T, cfg, MW, MH } = ctx
  const K = rng.int(cfg.roads[0], cfg.roads[1])
  const a0 = rng.next() * Math.PI * 2
  const roads: P[][] = []
  const cell = 8
  const GW = Math.ceil(MW / cell) + 1
  const GH = Math.ceil(MH / cell) + 1
  const used = new Uint8Array(GW * GH)
  const bias = (q: P) => (used[Math.min(GH - 1, Math.round(q[1] / cell)) * GW + Math.min(GW - 1, Math.round(q[0] / cell))] ? 0.45 : 1)
  for (let k = 0; k < K; k++) {
    let target: P | null = null
    for (let tries = 0; tries < 12 && !target; tries++) {
      const a = a0 + (k / K) * Math.PI * 2 + (rng.next() - 0.5) * 0.7 + (tries ? (tries % 2 ? 1 : -1) * Math.ceil(tries / 2) * 0.22 : 0)
      const q = borderPoint(ctx, a)
      if (T.waterAt(q) > 12 && T.heightAt(q) < 120) target = q
    }
    if (!target) continue
    const raw = routeOnTerrain(T, ctx.center, target, { water: 14, slope: 1, bias })
    for (const q of resample(raw, cell / 2)) {
      const i = Math.round(q[0] / cell)
      const j = Math.round(q[1] / cell)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = i + dx
          const y = j + dy
          if (x >= 0 && y >= 0 && x < GW && y < GH) used[y * GW + x] = 1
        }
    }
    roads.push(smoothRoute(raw))
  }
  return roads
}

function wallsFor(ctx: Ctx): 'stone' | 'palisade' | null {
  const { p, rng } = ctx
  if (p.walls === 'none') return null
  if (p.walls === 'stone' || p.walls === 'palisade') return p.size === 'hamlet' ? null : p.walls
  if (p.size === 'city') return 'stone'
  if (p.size === 'town') return rng.next() < 0.7 ? 'stone' : 'palisade'
  return null
}

// —————————————————————— 有机布局 ——————————————————————

function growInner(ctx: Ctx, patches: Patch[]) {
  const { T, cfg, rng } = ctx
  const typical = cfg.patch * cfg.patch * 0.87
  const cost = (i: number) => {
    const q = patches[i].site
    // 过大的片区（稀疏处的 Voronoi 单元）不适合作城区
    const big = Math.max(1, area(patches[i].poly) / typical)
    return dist(q, ctx.center) * (1 + T.slopeAt(q) * 5) * (0.85 + rng.next() * 0.3) * big
  }
  const seen = new Set<number>([0])
  const front: [number, number][] = []
  const push = (i: number) => {
    for (const j of patches[i].nb) {
      if (seen.has(j)) continue
      seen.add(j)
      if (patches[j].land < 0.45 || area(patches[j].poly) > typical * 2.6) continue
      front.push([cost(j), j])
    }
  }
  patches[0].inner = true
  push(0)
  let n = 1
  while (n < cfg.inner && front.length) {
    front.sort((a, b) => a[0] - b[0])
    const [, j] = front.shift()!
    patches[j].inner = true
    n++
    push(j)
  }
  // 填洞：四周全是城区的片区也并进来
  for (const pa of patches) if (!pa.inner && pa.land >= 0.5 && pa.nb.length && pa.nb.every((j) => patches[j].inner)) pa.inner = true
}

/** 城墙：把城内片区栅格化、减去海面，追踪外轮廓后简化成折线 */
function buildWall(ctx: Ctx, patches: Patch[], kind: 'stone' | 'palisade', arterials: P[][]) {
  const { MW, MH, T } = ctx
  const rc = 3
  const W = Math.ceil(MW / rc)
  const H = Math.ceil(MH / rc)
  const mask = new Float32Array(W * H)
  for (const pa of patches) {
    if (!pa.inner) continue
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const v of pa.poly) {
      x0 = Math.min(x0, v[0])
      y0 = Math.min(y0, v[1])
      x1 = Math.max(x1, v[0])
      y1 = Math.max(y1, v[1])
    }
    for (let j = Math.max(0, Math.floor(y0 / rc)); j <= Math.min(H - 1, Math.ceil(y1 / rc)); j++)
      for (let i = Math.max(0, Math.floor(x0 / rc)); i <= Math.min(W - 1, Math.ceil(x1 / rc)); i++) {
        const q: P = [(i + 0.5) * rc, (j + 0.5) * rc]
        if (pointInPoly(q, pa.poly) && !T.seaAt(q)) mask[j * W + i] = 1
      }
  }
  const rings = contours(mask, W, H, 0.5, true)
  let best: Float32Array | null = null
  let ba = 0
  for (const r of rings) {
    const a = area(fromF32(r))
    if (a > ba) {
      ba = a
      best = r
    }
  }
  if (!best) return
  const simp = fromF32(simplify(best, 7 / rc)).map(([x, y]) => [(x + 0.5) * rc, (y + 0.5) * rc] as P)
  if (simp.length > 3 && dist(simp[0], simp[simp.length - 1]) < 1) simp.pop()
  wallFromLoop(ctx, simp, kind, arterials)
  // 墙外的片区不算城内（墙按轮廓简化后可能与片区略有出入）
  for (const pa of patches) if (pa.inner && pa !== patches[0] && !pointInPoly(centroid(pa.poly), simp)) pa.inner = false
}

function assignWards(ctx: Ctx, patches: Patch[], walled: boolean) {
  const { rng, p, T } = ctx
  const inner = patches.map((_, i) => i).filter((i) => patches[i].inner && i !== 0)
  const free = () => inner.filter((i) => !patches[i].type)
  const wall = ctx.out.walls[0]
  const touchesWall = (i: number) => !!wall && patches[i].poly.some((v) => wall.loop.some((w) => dist(v, w) < 12) || !pointInPoly(v, wall.loop))
  const pick = (cands: number[], score: (i: number) => number) => {
    let best = -1
    let bs = -Infinity
    for (const i of cands) {
      const s = score(i) + rng.next() * 0.5
      if (s > bs) {
        bs = s
        best = i
      }
    }
    return best
  }
  const dc = (i: number) => dist(patches[i].site, ctx.center) / ctx.Rin
  const small = p.size === 'hamlet' || p.size === 'village'
  patches[0].type = small ? 'park' : 'plaza'
  if (small) {
    // 村落：中心是村公地，旁边一座小教堂 / 祠堂
    const t = pick(patches[0].nb.filter((i) => patches[i].inner), () => 0)
    if (t >= 0 && p.size === 'village') patches[t].type = 'temple'
    for (const i of free()) patches[i].type = 'common'
  } else {
    if (walled && (p.size === 'city' || rng.next() < 0.55)) {
      const typical = ctx.cfg.patch * ctx.cfg.patch * 0.87
      const c = pick(
        free().filter((i) => touchesWall(i) && area(patches[i].poly) < typical * 1.5 && area(patches[i].poly) > typical * 0.5),
        (i) => T.heightAt(patches[i].site) / 8 + dc(i) * 0.5,
      )
      if (c >= 0) patches[c].type = 'castle'
    }
    const t = pick(patches[0].nb.filter((i) => patches[i].inner && !patches[i].type), (i) => area(patches[i].poly) / 8000)
    if (t >= 0) patches[t].type = 'temple'
    if (p.magic > 0) {
      const m = pick(free().filter((i) => !patches[0].nb.includes(i)), (i) => T.heightAt(patches[i].site) / 10 + dc(i))
      if (m >= 0) patches[m].type = 'magic'
    }
    if (p.coast || p.river) {
      const hs = free()
        .filter((i) => patches[i].poly.some((v) => T.waterAt(v) < 4) && (!p.coast || patches[i].poly.some((v) => T.seaAt(v) || T.waterAt(v) < 0)))
        .sort((a, b) => dc(a) - dc(b))
        .slice(0, p.size === 'city' ? 3 : 2)
      for (const i of hs) patches[i].type = p.coast ? 'harbor' : 'craft'
    }
    if (p.size === 'city' || rng.next() < 0.45) {
      const k = pick(free().filter((i) => !patches[0].nb.includes(i)), () => 0)
      if (k >= 0) patches[k].type = 'park'
    }
    if (rng.next() < 0.6) {
      const k = pick(free().filter(touchesWall), (i) => dc(i))
      if (k >= 0) patches[k].type = 'cemetery'
    }
    const castleId = patches.findIndex((x) => x.type === 'castle')
    const nobles = p.size === 'city' ? 3 : 1
    for (let n = 0; n < nobles; n++) {
      const k = pick(free(), (i) => T.heightAt(patches[i].site) / 12 - dc(i) * 0.5 + (castleId >= 0 && patches[castleId].nb.includes(i) ? 1.5 : 0))
      if (k >= 0) patches[k].type = 'noble'
    }
    for (const i of patches[0].nb) if (patches[i].inner && !patches[i].type) patches[i].type = rng.next() < 0.3 ? 'market' : 'merchant'
    if (p.size === 'city') {
      for (let n = 0; n < 3; n++) {
        const k = pick(free().filter(touchesWall), (i) => dc(i) - T.heightAt(patches[i].site) / 20)
        if (k >= 0) patches[k].type = 'slum'
      }
    }
    for (const i of free()) patches[i].type = rng.next() < 0.3 ? 'craft' : dc(i) < 0.45 && rng.next() < 0.5 ? 'merchant' : 'common'
  }
  // 城外
  const veg = vegetation(ctx)
  for (let i = 0; i < patches.length; i++) {
    const pa = patches[i]
    if (pa.inner) continue
    if (pa.land < 0.35) {
      pa.type = 'water'
      continue
    }
    const d = dist(pa.site, ctx.center)
    const g = ctx.corridors.gap(pa.site)
    const nearTown = d < ctx.Rin * (small ? 1.8 : 2.1)
    if (!small && nearTown && g < spacing(ctx, pa.site) * 0.75 && T.slopeAt(pa.site) < 0.25) pa.type = 'suburb'
    else if (p.farms && veg.farm && T.slopeAt(pa.site) < 0.14 && d < ctx.Rin * (small ? 5 : 3.6) * (0.8 + rng.next() * 0.5)) pa.type = 'farm'
    else pa.type = 'wild'
  }
}

function layoutOrganic(ctx: Ctx, arterials: P[][], walled: 'stone' | 'palisade' | null) {
  const { p, rng, T, cfg } = ctx
  const patches = buildPatches(ctx, arterials)
  growInner(ctx, patches)
  if (walled) buildWall(ctx, patches, walled, arterials)
  const wall = ctx.out.walls[0]

  // —— 道路 ——
  const inside = (q: P) => (wall ? pointInPoly(q, wall.loop) : dist(q, ctx.center) < ctx.Rin)
  arterials.forEach((road) => {
    // 城内段为主街、城外段为大路
    let k = road.findIndex((q) => !inside(q))
    if (k < 0) k = road.length
    const inner = road.slice(0, Math.min(road.length, k + 1))
    const outer = road.slice(Math.max(0, k))
    const small = p.size === 'hamlet' || p.size === 'village'
    if (inner.length > 1) ctx.out.roads.push({ line: inner, width: cfg.main, kind: 'main', name: p.size === 'hamlet' ? undefined : ctx.namer.street(small ? 'street' : 'main') })
    if (outer.length > 1) ctx.out.roads.push({ line: outer, width: cfg.highway, kind: 'highway' })
  })
  // 村落：片区之间的边就是巷道
  if (p.size === 'hamlet' || p.size === 'village') {
    for (let i = 0; i < patches.length; i++) {
      if (!patches[i].inner) continue
      for (const j of patches[i].nb) {
        if (j < i || !patches[j].inner || rng.next() < 0.35) continue
        const e = sharedEdge(patches[i], patches[j])
        if (!e || T.waterAt(e[0]) < 3 || T.waterAt(e[1]) < 3) continue
        ctx.out.roads.push({ line: [e[0], e[1]], width: cfg.lane, kind: 'lane' })
      }
    }
  }
  extraBridges(ctx, inside)
  for (const r of ctx.out.roads) if (r.kind !== 'path') ctx.corridors.add(r.line, r.width / 2 + 1.2)
  if (T.river) ctx.corridors.add(T.river.line, 0)
  crossings(ctx)

  // —— 片区 ——
  assignWards(ctx, patches, !!walled)
  const veg = vegetation(ctx)
  for (let i = 0; i < patches.length; i++) {
    const pa = patches[i]
    const type = pa.type ?? 'wild'
    const ward: Ward = { poly: pa.poly, type, inner: pa.inner }
    ctx.out.wards.push(ward)
    if (type === 'water') continue
    const lane = pa.inner ? cfg.lane / 2 + rng.next() * 0.8 : 2
    const block = insetConvex(pa.poly, pa.poly.map(() => lane * (0.8 + rng.next() * 0.4)))
    if (block.length < 3) continue
    if (pa.inner) {
      const b = clipWater(ctx, block, 1.5)
      if (b) ctx.out.blocks.push(b)
    }
    const small = p.size === 'hamlet' || p.size === 'village'
    switch (type) {
      case 'plaza':
        plaza(ctx, ward, block)
        break
      case 'temple':
        if (small) {
          urban(ctx, block, p.size, [], 34)
          const c = centroid(block)
          const b = obb(block)
          const ch = rect(c, b.axis, 16, 8)
          if (placeable(ctx, ch)) {
            ctx.out.buildings.push({ poly: ch, kind: p.culture === 'eastern' ? 'hall' : 'temple', tone: 0.5, ridge: Math.atan2(b.axis[1], b.axis[0]) })
            ctx.out.landmarks.push({ p: c, name: ctx.namer.landmark(p.culture === 'eastern' ? 'shrine' : 'chapel', p.magic), kind: 'temple' })
          }
        } else temple(ctx, ward, block)
        break
      case 'castle':
        castle(ctx, ward, block)
        break
      case 'park':
        if (small) villageGreen(ctx, block)
        else park(ctx, ward, block)
        break
      case 'cemetery':
        cemetery(ctx, ward, block)
        break
      case 'noble':
        noble(ctx, ward, block)
        break
      case 'harbor':
        harbor(ctx, ward, block)
        break
      case 'magic':
        magicWard(ctx, ward, block)
        break
      case 'suburb':
        if (p.culture === 'eastern') eastWard(ctx, block, false, 30)
        else urban(ctx, block, 'suburb', [], 26)
        break
      case 'farm':
        farm(ctx, block, veg)
        break
      case 'wild':
        wild(ctx, block, veg)
        break
      default:
        if (small) urban(ctx, block, p.size, [], 30)
        else if (p.culture === 'eastern' && type === 'common') eastWard(ctx, block, false)
        else urban(ctx, block, type)
    }
  }
  if (p.coast && (p.size === 'hamlet' || p.size === 'village')) jetties(ctx)
  nameDistricts(ctx)
}

/** 临海村落：离村中心最近的岸边修一两座栈桥，一条小路通过去 */
function jetties(ctx: Ctx) {
  const { T, rng, center } = ctx
  const cands: P[] = []
  for (let r = 20; r < ctx.Rin * 3; r += 8)
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2
      const q: P = [center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]
      const w = T.waterAt(q)
      if (w > 1 && w < 4 && T.seaAt([q[0] - T.waterGrad(q)[0] * 30, q[1] - T.waterGrad(q)[1] * 30])) cands.push(q)
    }
  const made: P[] = []
  for (const q of cands) {
    if (made.length >= 2 || made.some((m) => dist(m, q) < 40)) continue
    const g = T.waterGrad(q)
    const L = 22 + rng.next() * 16
    const end: P = [q[0] - g[0] * L, q[1] - g[1] * L]
    if (!T.seaAt(end)) continue
    const mid: P = [(q[0] + end[0]) / 2, (q[1] + end[1]) / 2]
    ctx.out.piers.push(rect(mid, [-g[0], -g[1]], L + 2, 3.2))
    const n: P = [-g[1], g[0]]
    for (const s of [-1, 1])
      if (rng.next() < 0.7) ctx.out.boats.push({ p: [end[0] + g[0] * L * 0.3 + n[0] * 5 * s, end[1] + g[1] * L * 0.3 + n[1] * 5 * s], angle: Math.atan2(-g[1], -g[0]), len: 7 + rng.next() * 4 })
    const route = smoothRoute(routeOnTerrain(T, center, [q[0] + g[0] * 3, q[1] + g[1] * 3], { water: 30, slope: 1 }), 3)
    ctx.out.roads.push({ line: route, width: ctx.cfg.lane, kind: 'lane' })
    made.push(q)
  }
}

/** 村公地：草地、水井与几棵大树 */
function villageGreen(ctx: Ctx, block: Poly) {
  const g = clipWater(ctx, insetConvex(block, 4), 4)
  if (!g) return
  const c = centroid(g)
  const r = Math.min(22, Math.sqrt(area(g)) * 0.3)
  const green = insetConvex(circlePoly(c, r, 18), 0)
  ctx.out.greens.push({ poly: green, kind: 'park' })
  ctx.out.landmarks.push({ p: c, name: '', kind: 'well' })
  for (let k = 0; k < 3; k++) {
    const a = ctx.rng.next() * Math.PI * 2
    ctx.out.trees.push({ p: [c[0] + Math.cos(a) * r * 0.6, c[1] + Math.sin(a) * r * 0.6], r: 4 + ctx.rng.next() * 2 })
  }
  urban(ctx, block, ctx.p.size, [circlePoly(c, r + 4, 18)], 30)
}

/** 城里跨河的额外桥：沿河每隔一段架一座，桥头的短街切开街坊 */
function extraBridges(ctx: Ctx, inside: (q: P) => boolean) {
  const { T, cfg, p } = ctx
  if (!T.river || p.size === 'hamlet' || p.size === 'village') return
  const line = T.river.line
  const L = polylineLength(line)
  const existing: P[] = []
  for (const r of ctx.out.roads) for (const q of r.line) if (T.waterAt(q) < 0) existing.push(q)
  const gap = p.size === 'city' ? 190 : 260
  for (let s = 0; s < L; s += 12) {
    const { p: q, angle } = pointAt(line, s)
    if (!inside(q) || existing.some((e) => dist(e, q) < gap)) continue
    const n: P = [-Math.sin(angle), Math.cos(angle)]
    const hw = T.river.hw[Math.min(T.river.hw.length - 1, Math.round((s / L) * (T.river.hw.length - 1)))]
    const reach = hw + 26
    const a: P = [q[0] - n[0] * reach, q[1] - n[1] * reach]
    const b: P = [q[0] + n[0] * reach, q[1] + n[1] * reach]
    if (T.waterAt(a) < 3 || T.waterAt(b) < 3) continue
    ctx.out.roads.push({ line: [a, q, b], width: cfg.lane + 1, kind: 'street' })
    existing.push(q)
  }
}

function nameDistricts(ctx: Ctx) {
  const { rng, p } = ctx
  if (p.size === 'hamlet' || p.size === 'village') return
  const skip = new Set<WardType>(['plaza', 'castle', 'temple', 'park', 'cemetery', 'water', 'farm', 'wild', 'magic'])
  const frac = p.size === 'city' ? 0.5 : 0.35
  for (const w of ctx.out.wards) {
    if (skip.has(w.type) || !w.inner) continue
    if (rng.next() > frac && w.type !== 'harbor') continue
    w.name = ctx.namer.district(w.type)
  }
}

// —————————————————————— 奇观 ——————————————————————

function magicExtras(ctx: Ctx) {
  const { p, T, rng, MW, MH } = ctx
  if (p.magic === 0) return
  // 东方：山上的宗门，石阶从城门蜿蜒而上
  if (p.culture === 'eastern' && p.hills && T.hillDir) {
    let best: P | null = null
    let bh = -Infinity
    for (let k = 0; k < 400; k++) {
      const q: P = [160 + rng.next() * (MW - 320), 160 + rng.next() * (MH - 320)]
      const h = T.heightAt(q) - T.slopeAt(q) * 200 - dist(q, ctx.center) * 0.03
      if (h > bh && T.waterAt(q) > 30 && dist(q, ctx.center) > ctx.Rin * 1.2) {
        bh = h
        best = q
      }
    }
    if (best) {
      const zone = rect(best, [1, 0], 110, 110)
      const got = eastCompound(ctx, zone, 'sect')
      if (got) ctx.out.trees = ctx.out.trees.filter((t) => !pointInPoly(t.p, got))
      ctx.out.landmarks.push({ p: best, name: ctx.namer.landmark('magic', p.magic), kind: 'magic' })
      const from = ctx.out.walls[0]?.gates[0]?.p ?? ctx.center
      const stair = smoothRoute(routeOnTerrain(T, from, [best[0], best[1] + 50], { water: 20, slope: 0.25 }), 3)
      ctx.out.roads.push({ line: stair, width: 2.5, kind: 'stair' })
    }
  }
  if (p.magic < 2) return
  // 浮空岛：找一处离房屋、城墙都远的空中
  const ir = 34 + rng.next() * 24
  const blds = ctx.out.buildings.filter((_, i) => i % 3 === 0).map((b) => b.poly[0])
  let ip: P = ctx.center
  let bestGap = -Infinity
  for (let k = 0; k < 160; k++) {
    const a = rng.next() * Math.PI * 2
    const r = ctx.Rin * (1 + rng.next() * 1.2)
    const q: P = [ctx.center[0] + Math.cos(a) * r, ctx.center[1] + Math.sin(a) * r]
    if (q[0] < ir * 2 || q[1] < ir * 2 || q[0] > MW - ir * 2 || q[1] > MH - ir * 2) continue
    let g = Infinity
    for (const b of blds) g = Math.min(g, dist(b, q))
    for (const w of ctx.out.walls) for (const v of w.loop) g = Math.min(g, dist(v, q))
    if (g > bestGap) {
      bestGap = g
      ip = q
    }
  }
  ctx.out.wonders.push({ p: ip, r: ir, kind: 'isle' })
  // 灵脉：一条穿过奇观片区的发光曲线
  const m = ctx.out.landmarks.find((l) => l.kind === 'magic')?.p ?? ctx.center
  const b = rng.next() * Math.PI
  const pts: P[] = []
  for (let k = -12; k <= 12; k++) {
    const s = (k / 12) * Math.hypot(MW, MH) * 0.6
    const wob = Math.sin(k * 0.7 + rng.next()) * 30
    pts.push([m[0] + Math.cos(b) * s - Math.sin(b) * wob, m[1] + Math.sin(b) * s + Math.cos(b) * wob])
  }
  ctx.out.wonders.push({ p: m, r: 0, kind: 'leyline', line: chaikin(pts, 3) })
}

// —————————————————————— 注记 ——————————————————————

function seaPoint(ctx: Ctx): P {
  const { T, MW, MH } = ctx
  let best: P = [0, 0]
  let bw = Infinity
  // 离图边留出余量，免得海名贴边
  const m = Math.min(MW, MH) * 0.12
  for (let y = m; y < MH - m; y += 20)
    for (let x = m; x < MW - m; x += 20) {
      const w = T.waterAt([x, y])
      if (T.seaAt([x, y]) && w < bw) {
        bw = w
        best = [x, y]
      }
    }
  return best
}

function labels(ctx: Ctx, riverName: string, seaName: string) {
  const { T, out, MW, MH } = ctx
  const L: MapLabel[] = out.labels
  for (const w of out.wards) if (w.name) L.push({ text: w.name, p: centroid(w.poly), angle: 0, kind: 'district', weight: w.inner ? 5 : 3 })
  for (const r of out.roads) {
    if (!r.name || polylineLength(r.line) < 90) continue
    L.push({ text: r.name, p: pointAt(r.line, polylineLength(r.line) * 0.55).p, angle: 0, kind: 'street', path: r.line, weight: 4 })
  }
  for (const l of out.landmarks) {
    if (!l.name || l.kind === 'well') continue
    L.push({ text: l.name, p: l.p, angle: 0, kind: 'landmark', weight: l.kind === 'castle' || l.kind === 'temple' ? 7 : l.kind === 'gate' ? 3 : 5 })
  }
  if (T.river && riverName) {
    // 河名放在城外一段较直的河道上
    const line = T.river.line
    const Lr = polylineLength(line)
    let bestS = Lr * 0.2
    let bd = -Infinity
    for (let s = 120; s < Lr - 120; s += 20) {
      const q = pointAt(line, s).p
      if (q[0] < 150 || q[1] < 150 || q[0] > MW - 150 || q[1] > MH - 150) continue
      const d = dist(q, ctx.center) - Math.abs(dist(q, ctx.center) - ctx.Rin * 1.6) * 0.6
      if (d > bd) {
        bd = d
        bestS = s
      }
    }
    const seg: P[] = []
    for (let s = bestS - 110; s <= bestS + 110; s += 10) seg.push(pointAt(line, Math.max(0, Math.min(Lr, s))).p)
    L.push({ text: riverName, p: pointAt(line, bestS).p, angle: 0, kind: 'river', path: seg, weight: 8 })
  }
  if (T.coast && seaName) L.push({ text: seaName, p: seaPoint(ctx), angle: 0, kind: 'water', weight: 9 })
  if (T.hillDir) {
    let best: P = ctx.center
    let bh = -Infinity
    for (let y = 80; y < MH - 80; y += 30)
      for (let x = 80; x < MW - 80; x += 30) {
        const h = T.heightAt([x, y])
        if (h > bh) {
          bh = h
          best = [x, y]
        }
      }
    L.push({ text: ctx.namer.hill(), sub: `${Math.round(bh)} m`, p: best, angle: 0, kind: 'hill', weight: 6 })
  }
}

