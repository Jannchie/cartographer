/**
 * 聚落布局诊断：在 Node 下直接跑生成器（不需要画布），对一组"文明 × 人口 × 形制 × 种子"统计几何冲突与布局指标。
 *
 *   pnpm tsx scripts/settlement-audit.ts [样例名的一部分 ...] [key=value ...] [--list=类别] [--limit=12] [--json=文件]
 *
 * 不给样例名时跑全部内置样例；给了 key=value 时只跑这一组参数（同聚落模块的地址参数，如 culture=wa population=20000 seed=edo）。
 * --list=类别 列出该类冲突的位置（米）与当事要素，便于用 settlement:png 的 crop 或 town3d 的自定机位去看；类别名见表头。
 *
 * 冲突按成长史统计：两样东西只有生卒重叠（在某个人口下同时存在）才算冲突，原地翻建的新旧房不算。
 * 各列：
 *   房×房    民居、棚屋与别的建筑重叠（深于 0.25 米）；有意叠放的部件（同一组，或两者都不是民居 / 棚屋的组合地标）另计在"组合"
 *   压路      建筑压到路面（深于 0.3 米；园路、石阶不算）
 *   落水      建筑的角或形心在水里（鸟居不算：海上鸟居是有意的）
 *   骑墙      建筑压到城墙实墙段（墙上的塔楼、主楼不算）
 *   骑院      院墙从建筑中间穿过（建筑一部分在院内、一部分在院外，各深于 0.5 米）
 *   树∈房    树干落在建筑里；树≈房：树干离建筑外墙不足 max(0.6, 冠径 × 0.3) 米
 *   树∈路    树干在路面上；树∈水：树干在水里；树∈门：城门前后 14 米、左右 4 米以内；树∈墙：树干在城墙墙体里
 *   房∈场    建筑先有、后来铺成广场 / 前庭时没让位（形心在铺装里）；树∈场同理（树干）；场中树：与铺装同时或之后种在铺装上的树（院心、殿前的树是有意的，只作参考）
 *   院压路    院墙的边压到街面（深于 0.6 米）
 *   出画      建筑、院墙、树、城墙有顶点落在画幅之外
 * 指标（按最终人口的快照）：
 *   墙内      最大一圈城墙里的用地占比：建 = 建筑，路 = 道路与铺装，田 = 田块（不含菜园），园 = 菜园与园地
 *   密度      建筑覆盖率，按离城心的远近分三环（内 / 中 / 外，半径取九成民居所在的范围）；应由内向外递减
 *   连排      城心一环里与别的建筑相距不足 1.2 米（共用山墙）的民居占比
 *   沿街      城心一环里主街、街两侧 9 米内有建筑的长度占比
 */
import { writeFileSync } from 'node:fs'
import type { Building, Road, Settlement, SettlementParams, Tree, Wall } from '../src/settlement/types'
import type { Life } from '../src/settlement/history'
import type { P, Poly } from '../src/settlement/geom'
// 先启动插件（文明、沙盘套件、城镇文明规则由插件登记，见 src/packs/boot.ts）
import '../src/packs/all'

const { generateHistory } = await import('../src/settlement/generate')
const { snapshot } = await import('../src/settlement/history')
const { DEFAULT_SETTLEMENT } = await import('../src/settlement/types')
const { area, bboxOf, centroid, convexOverlap, edgeDist, pointInPoly, segDist, segIntersect, segPolyDist } = await import('../src/settlement/geom')
const { waterSampler } = await import('../src/render/town3d/shared')

const CASES: Record<string, Partial<SettlementParams>> = {
  'west-town': { seed: 'thornwick' },
  'west-capital': { culture: 'western', population: 40000, capital: true, hills: true, coast: true, seed: 'aldmoor' },
  'east-lifang': { culture: 'eastern', population: 30000, capital: true, plan: 'lifang', seed: 'changan' },
  'wa-jokamachi': { culture: 'wa', population: 20000, capital: true, plan: 'jokamachi', seed: 'edo' },
  'islam-medina': { culture: 'islamic', population: 20000, plan: 'medina', seed: 'fes' },
  'west-village': { culture: 'western', population: 300, seed: 'brook' },
  'east-village': { culture: 'eastern', population: 300, seed: 'brook' },
  'wa-village': { culture: 'wa', population: 300, seed: 'brook' },
  'islam-village': { culture: 'islamic', population: 300, seed: 'brook' },
  'west-castrum': { culture: 'western', population: 8000, plan: 'castrum', seed: 'deva' },
  'west-bastide': { culture: 'western', population: 6000, plan: 'bastide', seed: 'monpazier' },
  'west-coast': { culture: 'western', population: 12000, coast: true, seed: 'harbor' },
  'west-hills': { culture: 'western', population: 6000, hills: true, relief: 0.9, seed: 'crag' },
  'west-magic': { culture: 'western', population: 12000, magic: 2, seed: 'arcanum' },
  'west-1500': { culture: 'western', population: 1500, seed: 'thornwick' },
  'east-town': { culture: 'eastern', population: 5000, seed: 'luoyi' },
  'east-city': { culture: 'eastern', population: 15000, seed: 'jiangling', coast: true },
  'wa-town': { culture: 'wa', population: 5000, seed: 'nara' },
  'islam-town': { culture: 'islamic', population: 4000, seed: 'kairouan' },
  'islam-capital': { culture: 'islamic', population: 30000, capital: true, seed: 'qahira' },
}

const args = process.argv.slice(2)
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const names = args.filter((a) => !a.startsWith('--') && !a.includes('='))
const custom: Record<string, unknown> = {}
for (const kv of args.filter((a) => !a.startsWith('--') && a.includes('='))) {
  const [k, v] = kv.split('=')
  custom[k] = ['capital', 'coast', 'hills', 'river', 'farms'].includes(k) ? v === '1' || v === 'true' : isNaN(Number(v)) ? v : Number(v)
}
const LIST = flag('list')
const LIMIT = Number(flag('limit') ?? 12)

type Hit = { at: P; what: string }
interface Report {
  name: string
  ms: number
  size: string
  pop: number
  buildings: number
  trees: number
  conflicts: Record<string, number>
  hits: Record<string, Hit[]>
  metrics: Record<string, number | string>
}

const ALWAYS: Life = { born: 0, died: Infinity }
const DWELL = new Set(['house', 'large', 'shed'])

/** 按格子登记包围盒的索引 */
class Grid<T> {
  private m = new Map<number, T[]>()
  constructor(private cell: number) {}
  private keys(b: number[], f: (k: number) => void) {
    for (let y = Math.floor(b[1] / this.cell); y <= Math.floor(b[3] / this.cell); y++) for (let x = Math.floor(b[0] / this.cell); x <= Math.floor(b[2] / this.cell); x++) f(y * 65536 + x)
  }
  add(b: number[], item: T) {
    this.keys(b, (k) => (this.m.get(k) ?? this.m.set(k, []).get(k)!).push(item))
  }
  near(b: number[]): T[] {
    const out = new Set<T>()
    this.keys(b, (k) => this.m.get(k)?.forEach((x) => out.add(x)))
    return [...out]
  }
}

/** 点到凸多边形的距离（内部为 0） */
const polyDist = (p: P, poly: Poly) => (pointInPoly(p, poly) ? 0 : edgeDist(p, poly))

function audit(name: string, input: Partial<SettlementParams>): Report {
  const params = { ...DEFAULT_SETTLEMENT, ...input } as SettlementParams
  const t0 = performance.now()
  const h = generateHistory(params)
  const ms = performance.now() - t0
  const st = h.st
  const W = st.width
  const H = st.height
  const lifeOf = (x: object) => h.life.get(x) ?? ALWAYS
  const both = (a: object, b: object) => {
    const la = lifeOf(a)
    const lb = lifeOf(b)
    return Math.max(la.born, lb.born) < Math.min(la.died, lb.died, h.until + 1e-6)
  }
  const T = st.terrain
  const water = waterSampler(T)
  const waterAt = (q: P) => water(q[0], q[1])
  const conflicts: Record<string, number> = {}
  const hits: Record<string, Hit[]> = {}
  const hit = (k: string, at: P, what: string) => {
    conflicts[k] = (conflicts[k] ?? 0) + 1
    ;(hits[k] ??= []).push({ at: [Math.round(at[0]), Math.round(at[1])], what })
  }
  for (const k of ['房×房', '组合', '压路', '落水', '骑墙', '骑院', '树∈房', '树≈房', '树∈路', '树∈水', '树∈门', '树∈墙', '房∈场', '树∈场', '场中树', '院压路', '出画']) conflicts[k] = 0
  const tag = (b: Building) => `${b.kind}${b.role ? `(${b.role})` : ''}[${lifeOf(b).born.toFixed(0)}~${lifeOf(b).died === Infinity ? '' : lifeOf(b).died.toFixed(0)}]`

  // —— 建筑索引 ——
  const bgrid = new Grid<Building>(32)
  const bbox = new Map<Building, number[]>()
  for (const b of st.buildings) {
    const bb = bboxOf(b.poly)
    bbox.set(b, bb)
    bgrid.add(bb, b)
  }
  // 房×房
  const seen = new Set<Building>()
  for (const a of st.buildings) {
    seen.add(a)
    const ba = bbox.get(a)!
    for (const b of bgrid.near(ba)) {
      if (seen.has(b)) continue
      const bb = bbox.get(b)!
      if (ba[0] >= bb[2] || bb[0] >= ba[2] || ba[1] >= bb[3] || bb[1] >= ba[3]) continue
      if (!both(a, b) || !convexOverlap(a.poly, b.poly, 0.25)) continue
      const k = (a.group !== undefined && a.group === b.group) || (!DWELL.has(a.kind) && !DWELL.has(b.kind)) ? '组合' : '房×房'
      hit(k, centroid(a.poly), `${tag(a)} × ${tag(b)}`)
    }
  }
  // 压路
  const rgrid = new Grid<{ r: Road; a: P; b: P }>(48)
  for (const r of st.roads) for (let i = 0; i + 1 < r.line.length; i++) rgrid.add([Math.min(r.line[i][0], r.line[i + 1][0]) - r.width, Math.min(r.line[i][1], r.line[i + 1][1]) - r.width, Math.max(r.line[i][0], r.line[i + 1][0]) + r.width, Math.max(r.line[i][1], r.line[i + 1][1]) + r.width], { r, a: r.line[i], b: r.line[i + 1] })
  for (const b of st.buildings) {
    if (b.kind === 'torii') continue
    for (const s of rgrid.near(bbox.get(b)!)) {
      // 园路、石阶通到亭台、殿前，不算压路
      if (s.r.kind === 'path' || s.r.kind === 'stair' || !both(b, s.r)) continue
      if (segPolyDist(s.a, s.b, b.poly) < s.r.width / 2 - 0.3) {
        hit('压路', centroid(b.poly), `${tag(b)} × ${s.r.kind} 宽 ${s.r.width}`)
        break
      }
    }
  }
  // 落水
  for (const b of st.buildings) {
    if (b.kind === 'torii') continue
    if ([centroid(b.poly), ...b.poly].some((q) => waterAt(q) < -0.5)) hit('落水', centroid(b.poly), tag(b))
  }
  // 骑墙
  const wgrid = new Grid<{ w: Wall; a: P; b: P }>(48)
  for (const w of st.walls)
    for (let i = 0; i < w.loop.length; i++) {
      if (!w.solid[i]) continue
      const a = w.loop[i]
      const b = w.loop[(i + 1) % w.loop.length]
      wgrid.add([Math.min(a[0], b[0]) - 6, Math.min(a[1], b[1]) - 6, Math.max(a[0], b[0]) + 6, Math.max(a[1], b[1]) + 6], { w, a, b })
    }
  for (const b of st.buildings) {
    // 墙上的塔楼、门楼、主楼是城防的一部分
    if (b.kind === 'tower' || b.kind === 'keep') continue
    for (const s of wgrid.near(bbox.get(b)!)) {
      if (!both(b, s.w)) continue
      if (segPolyDist(s.a, s.b, b.poly) < s.w.thickness / 2 - 0.3) {
        hit('骑墙', centroid(b.poly), `${tag(b)} × ${s.w.kind}`)
        break
      }
    }
  }
  // 骑院
  const egrid = new Grid<Poly>(48)
  for (const e of st.enclosures) egrid.add(bboxOf(e), e)
  for (const b of st.buildings) {
    if (b.kind === 'torii') continue
    for (const e of egrid.near(bbox.get(b)!)) {
      if (!both(b, e)) continue
      let inn = false
      let out = false
      for (const v of b.poly) {
        if (edgeDist(v, e) < 0.5) continue
        if (pointInPoly(v, e)) inn = true
        else out = true
      }
      if (inn && out) {
        hit('骑院', centroid(b.poly), tag(b))
        break
      }
    }
  }
  // 树
  const gates = st.walls.flatMap((w) => w.gates.map((g) => ({ w, g })))
  for (const t of st.trees as Tree[]) {
    const q = t.p
    const bb = [q[0] - t.r, q[1] - t.r, q[0] + t.r, q[1] + t.r]
    let inB = false
    let nearB = false
    for (const b of bgrid.near(bb)) {
      if (b.kind === 'torii' || !both(t, b)) continue
      const d = polyDist(q, b.poly)
      if (d === 0) inB = true
      else if (d < Math.max(0.6, t.r * 0.3)) nearB = true
    }
    if (inB) hit('树∈房', q, `r=${t.r.toFixed(1)}`)
    else if (nearB) hit('树≈房', q, `r=${t.r.toFixed(1)}`)
    for (const s of rgrid.near(bb)) {
      if (!both(t, s.r)) continue
      if (segDist(q, s.a, s.b).d < s.r.width / 2 - 0.2) {
        hit('树∈路', q, `${s.r.kind} 宽 ${s.r.width} [${lifeOf(t).born.toFixed(0)}~${lifeOf(t).died.toFixed(0)}] 路 [${lifeOf(s.r).born.toFixed(0)}~]`)
        break
      }
    }
    if (waterAt(q) < 0) hit('树∈水', q, `水距 ${waterAt(q).toFixed(1)}`)
    for (const s of wgrid.near(bb)) {
      if (!both(t, s.w)) continue
      if (segDist(q, s.a, s.b).d < s.w.thickness / 2 + 0.3) {
        hit('树∈墙', q, s.w.kind)
        break
      }
    }
    for (const { w, g } of gates) {
      const dx = q[0] - g.p[0]
      const dy = q[1] - g.p[1]
      if (Math.abs(dx) > 16 || Math.abs(dy) > 16 || !both(t, w)) continue
      const u: P = [Math.cos(g.angle), Math.sin(g.angle)]
      const along = dx * u[0] + dy * u[1]
      const across = -dx * u[1] + dy * u[0]
      if (Math.abs(along) < 14 && Math.abs(across) < 4) {
        hit('树∈门', q, `门 ${g.p.map((x) => x.toFixed(0))}`)
        break
      }
    }
  }
  // 铺装：广场、前庭、院心。与它同时盖的（摊位、院里的树）是有意的；先有、后来没让位的才算
  const pgrid = new Grid<Poly>(48)
  for (const p of st.plazas) if (p.length >= 3) pgrid.add(bboxOf(p), p)
  for (const b of st.buildings) {
    if (b.kind === 'torii') continue
    const c = centroid(b.poly)
    for (const p of pgrid.near(bbox.get(b)!)) {
      if (!both(b, p) || lifeOf(b).born >= lifeOf(p).born || !pointInPoly(c, p)) continue
      hit('房∈场', c, `${tag(b)} 场 [${lifeOf(p).born.toFixed(0)}~]`)
      break
    }
  }
  for (const t of st.trees as Tree[]) {
    for (const p of pgrid.near([t.p[0], t.p[1], t.p[0], t.p[1]])) {
      if (!both(t, p) || !pointInPoly(t.p, p)) continue
      hit(lifeOf(t).born < lifeOf(p).born ? '树∈场' : '场中树', t.p, `[${lifeOf(t).born.toFixed(0)}~${lifeOf(t).died.toFixed(0)}] 场 [${lifeOf(p).born.toFixed(0)}~]`)
      break
    }
  }
  // 院墙压路：院墙的边穿过街面（深于 0.6 米；园路、石阶不算）
  for (const e of st.enclosures) {
    const eb = bboxOf(e)
    let bad = false
    for (const s of rgrid.near(eb)) {
      if (s.r.kind === 'path' || s.r.kind === 'stair' || !both(e, s.r)) continue
      for (let i = 0; i < e.length && !bad; i++) {
        const a = e[i]
        const b = e[(i + 1) % e.length]
        // 院墙的一条边与路的中线段：两条线段的最近距离（取四个端点到对方的最小值，相交时为 0）
        const x = segIntersect(a, b, s.a, s.b)
        const d = x && x.t >= 0 && x.t <= 1 && x.u >= 0 && x.u <= 1 ? 0 : Math.min(segDist(a, s.a, s.b).d, segDist(b, s.a, s.b).d, segDist(s.a, a, b).d, segDist(s.b, a, b).d)
        if (d < s.r.width / 2 - 0.6) bad = true
      }
      if (bad) {
        hit('院压路', centroid(e), `${s.r.kind} 宽 ${s.r.width}`)
        break
      }
    }
  }
  // 出画
  const off =(q: P) => q[0] < -0.5 || q[1] < -0.5 || q[0] > W + 0.5 || q[1] > H + 0.5
  for (const b of st.buildings) if (b.poly.some(off)) hit('出画', centroid(b.poly), `建筑 ${tag(b)}`)
  for (const e of st.enclosures) if (e.some(off)) hit('出画', centroid(e), '院墙')
  for (const t of st.trees) if (off(t.p)) hit('出画', t.p, '树')
  for (const w of st.walls) if (w.loop.some((q, i) => (w.solid[i] || w.solid[(i - 1 + w.loop.length) % w.loop.length]) && off(q))) hit('出画', w.loop[0], '城墙')

  // —— 指标：最终人口的快照 ——
  const now: Settlement = snapshot(h, h.until)
  const metrics: Record<string, number | string> = {}
  const ngrid = new Grid<Building>(32)
  for (const b of now.buildings) if (b.kind !== 'torii') ngrid.add(bboxOf(b.poly), b)
  const builtAt = (q: P) => ngrid.near([q[0], q[1], q[0], q[1]]).some((b) => pointInPoly(q, b.poly))
  const outer = now.walls.filter((w) => w.gates.length > 0).sort((a, b) => area(b.loop) - area(a.loop))[0]
  if (outer && area(outer.loop) > 30000) {
    const lb = bboxOf(outer.loop)
    const fgrid = new Grid<{ poly: Poly; kind: string }>(48)
    for (const f of now.fields) fgrid.add(bboxOf(f.poly), { poly: f.poly, kind: f.kind === 'garden' ? 'garden' : 'field' })
    for (const g of now.greens) fgrid.add(bboxOf(g.poly), { poly: g.poly, kind: 'garden' })
    for (const p of now.plazas) fgrid.add(bboxOf(p), { poly: p, kind: 'road' })
    const ngr = new Grid<{ r: Road; a: P; b: P }>(48)
    for (const r of now.roads) for (let i = 0; i + 1 < r.line.length; i++) ngr.add([Math.min(r.line[i][0], r.line[i + 1][0]) - r.width, Math.min(r.line[i][1], r.line[i + 1][1]) - r.width, Math.max(r.line[i][0], r.line[i + 1][0]) + r.width, Math.max(r.line[i][1], r.line[i + 1][1]) + r.width], { r, a: r.line[i], b: r.line[i + 1] })
    const n = { all: 0, built: 0, road: 0, field: 0, garden: 0, water: 0 }
    const step = Math.max(3, Math.sqrt(area(outer.loop)) / 220)
    for (let y = lb[1]; y < lb[3]; y += step)
      for (let x = lb[0]; x < lb[2]; x += step) {
        const q: P = [x, y]
        if (!pointInPoly(q, outer.loop)) continue
        n.all++
        if (waterAt(q) < 0) n.water++
        else if (builtAt(q)) n.built++
        else if (ngr.near([x, y, x, y]).some((s) => segDist(q, s.a, s.b).d < s.r.width / 2)) n.road++
        else {
          const fs = fgrid.near([x, y, x, y]).filter((f) => pointInPoly(q, f.poly))
          if (fs.some((f) => f.kind === 'road')) n.road++
          else if (fs.some((f) => f.kind === 'field')) n.field++
          else if (fs.some((f) => f.kind === 'garden')) n.garden++
        }
      }
    const pc = (x: number) => Math.round((x / Math.max(1, n.all - n.water)) * 100)
    metrics['墙内'] = `${(area(outer.loop) / 10000).toFixed(0)}ha 建${pc(n.built)} 路${pc(n.road)} 田${pc(n.field)} 园${pc(n.garden)}`
  } else metrics['墙内'] = '—'
  // 城心：取"market"地标或民居的重心
  const homes = now.buildings.filter((b) => b.kind === 'house' || b.kind === 'large')
  const cs = homes.map((b) => centroid(b.poly))
  const mk = now.landmarks.find((l) => l.kind === 'market')?.p
  const c0: P = mk ?? [cs.reduce((s, q) => s + q[0], 0) / Math.max(1, cs.length), cs.reduce((s, q) => s + q[1], 0) / Math.max(1, cs.length)]
  const ds = cs.map((q) => Math.hypot(q[0] - c0[0], q[1] - c0[1])).sort((a, b) => a - b)
  const R = ds[Math.floor(ds.length * 0.9)] ?? 100
  const ring = [0, 0, 0]
  const land = [0, 0, 0]
  const step = Math.max(2.5, R / 160)
  for (let y = c0[1] - R; y < c0[1] + R; y += step)
    for (let x = c0[0] - R; x < c0[0] + R; x += step) {
      const d = Math.hypot(x - c0[0], y - c0[1])
      if (d >= R || x < 0 || y < 0 || x > W || y > H || waterAt([x, y]) < 0) continue
      const k = Math.min(2, Math.floor((d / R) * 3))
      land[k]++
      if (builtAt([x, y])) ring[k]++
    }
  metrics['密度'] = ring.map((v, k) => Math.round((v / Math.max(1, land[k])) * 100)).join('/')
  // 连排
  let att = 0
  let coreHomes = 0
  for (const b of homes) {
    const c = centroid(b.poly)
    if (Math.hypot(c[0] - c0[0], c[1] - c0[1]) > R / 3) continue
    coreHomes++
    const bb = bboxOf(b.poly)
    if (ngrid.near([bb[0] - 1.2, bb[1] - 1.2, bb[2] + 1.2, bb[3] + 1.2]).some((o) => o !== b && convexOverlap(b.poly, o.poly, -1.2))) att++
  }
  metrics['连排'] = coreHomes ? Math.round((att / coreHomes) * 100) : 0
  // 沿街
  let lined = 0
  let total = 0
  for (const r of now.roads) {
    if (r.kind !== 'main' && r.kind !== 'street' && r.kind !== 'highway') continue
    for (let i = 0; i + 1 < r.line.length; i++) {
      const a = r.line[i]
      const b = r.line[i + 1]
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (L < 0.5) continue
      const nx = -(b[1] - a[1]) / L
      const ny = (b[0] - a[0]) / L
      for (let s = 2; s < L; s += 4) {
        const q: P = [a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L]
        if (Math.hypot(q[0] - c0[0], q[1] - c0[1]) > R / 3) continue
        for (const sg of [-1, 1]) {
          total++
          if ([2.5, 5.5, 8.5].some((o) => builtAt([q[0] + nx * sg * (r.width / 2 + o), q[1] + ny * sg * (r.width / 2 + o)]))) lined++
        }
      }
    }
  }
  metrics['沿街'] = total ? Math.round((lined / total) * 100) : 0
  return { name, ms, size: `${W}×${H}`, pop: now.stats.population, buildings: now.buildings.length, trees: now.trees.length, conflicts, hits, metrics }
}

const todo: [string, Partial<SettlementParams>][] = Object.keys(custom).length ? [['custom', custom as Partial<SettlementParams>]] : Object.entries(CASES).filter(([k]) => !names.length || names.some((n) => k.includes(n)))
const reports: Report[] = []
const pad = (s: string | number, n: number) => {
  const str = String(s)
  // 汉字按两格算
  const w = [...str].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return str + ' '.repeat(Math.max(0, n - w))
}
const CK = ['房×房', '组合', '压路', '落水', '骑墙', '骑院', '树∈房', '树≈房', '树∈路', '树∈水', '树∈门', '树∈墙', '房∈场', '树∈场', '场中树', '院压路', '出画']
console.log(pad('样例', 15) + pad('毫秒', 7) + pad('人口', 7) + pad('建筑', 6) + pad('树', 7) + CK.map((k) => pad(k, 7)).join('') + pad('密度', 10) + pad('连排', 5) + pad('沿街', 5) + '墙内')
for (const [name, input] of todo) {
  const r = audit(name, input)
  reports.push(r)
  console.log(pad(r.name, 15) + pad(r.ms.toFixed(0), 7) + pad(r.pop, 7) + pad(r.buildings, 6) + pad(r.trees, 7) + CK.map((k) => pad(r.conflicts[k], 7)).join('') + pad(r.metrics['密度'], 10) + pad(r.metrics['连排'], 5) + pad(r.metrics['沿街'], 5) + r.metrics['墙内'])
  if (LIST)
    for (const k of LIST.split(',')) {
      const hs = r.hits[k] ?? []
      const by = new Map<string, number>()
      for (const x of hs) by.set(x.what.replace(/\[[^\]]*\]/g, '').replace(/r=[\d.]+/, ''), (by.get(x.what.replace(/\[[^\]]*\]/g, '').replace(/r=[\d.]+/, '')) ?? 0) + 1)
      console.log(`  ${k}：${[...by].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w, n]) => `${w} ×${n}`).join('；')}`)
      for (const x of hs.slice(0, LIMIT)) console.log(`    (${x.at[0]}, ${x.at[1]}) ${x.what}`)
    }
}
if (reports.length > 1) {
  const sum = (k: string) => reports.reduce((s, r) => s + r.conflicts[k], 0)
  console.log(pad('合计', 15) + pad(reports.reduce((s, r) => s + r.ms, 0).toFixed(0), 7) + pad('', 7) + pad('', 6) + pad('', 7) + CK.map((k) => pad(sum(k), 7)).join(''))
}
const json = flag('json')
if (json) writeFileSync(json, JSON.stringify(reports.map(({ hits: _h, ...r }) => r), null, 1))
