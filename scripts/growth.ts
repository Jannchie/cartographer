// 成长动画稳定性：按 playGrowth 的人口序列逐帧生成，量相邻两帧之间保留下来的比例
// tsx growth.ts key=value ...   (target=, frames=, seed=, culture= ...)
import { createCanvas, ImageData, Path2D, DOMMatrix } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).Path2D = Path2D
;(globalThis as any).DOMMatrix = DOMMatrix
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }
const SRC = '../src/settlement/'
const { generateSettlement, settlementExtent } = await import(SRC + 'generate.ts')
const { DEFAULT_SETTLEMENT } = await import(SRC + 'types.ts')

const extra: Record<string, any> = {}
for (const kv of process.argv.slice(2)) {
  const [k, v] = kv.split('=')
  extra[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v)
}
const target = extra.target ?? 20000
const frames = extra.frames ?? 48
const from = extra.from ?? Math.min(30, target)
const verbose = !!extra.v
// 与成长动画一样：各帧用同一个画幅（free=1 时各帧按自己的人口定画幅）
const free = !!extra.free
delete extra.free
delete extra.target
delete extra.frames
delete extra.from
delete extra.v
const pops = Array.from({ length: frames + 1 }, (_, k) => Math.round(Math.exp(Math.log(from) + ((Math.log(target) - Math.log(from)) * k) / frames)))

type P = [number, number]
const inPoly = (q: number[], poly: P[]) => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const cen = (poly: P[]): P => {
  let x = 0
  let y = 0
  for (const q of poly) {
    x += q[0]
    y += q[1]
  }
  return [x / poly.length, y / poly.length]
}
function snap(s: any) {
  const ox = s.width / 2
  const oy = s.height / 2
  const bkeys = new Map<string, string>()
  for (const b of s.buildings) {
    const c = cen(b.poly)
    bkeys.set(`${Math.round(c[0] - ox)},${Math.round(c[1] - oy)}`, b.kind)
  }
  // 街道采样点：5 米一格
  const road = new Set<string>()
  for (const r of s.roads) {
    if (r.kind === 'path') continue
    for (let i = 0; i + 1 < r.line.length; i++) {
      const a = r.line[i]
      const b = r.line[i + 1]
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      const n = Math.max(1, Math.ceil(L / 4))
      for (let k = 0; k < n; k++) {
        const t = k / n
        road.add(`${Math.round((a[0] + (b[0] - a[0]) * t - ox) / 4)},${Math.round((a[1] + (b[1] - a[1]) * t - oy) / 4)}`)
      }
    }
  }
  const walls = s.walls.length
  // 各片区的民居数（按片区中心）
  const wardHouses = new Map<string, number>()
  {
    const wk = s.wards.map((w: any) => { const c = cen(w.poly); return { w, k: `${Math.round(c[0] - ox)},${Math.round(c[1] - oy)}` } })
    for (const b of s.buildings) {
      if (b.kind !== 'house' && b.kind !== 'large') continue
      const c = cen(b.poly)
      const hit = wk.find(({ w }) => inPoly(c, w.poly))
      if (hit) wardHouses.set(hit.k, (wardHouses.get(hit.k) ?? 0) + 1)
    }
  }
  // 特殊建筑（民居、棚屋以外）：位置与种类
  const special = new Set<string>()
  for (const b of s.buildings) {
    if (b.kind === 'house' || b.kind === 'large' || b.kind === 'shed') continue
    const c = cen(b.poly)
    special.add(`${Math.round(c[0] - ox)},${Math.round(c[1] - oy)},${b.kind}`)
  }
  // 树：位置
  const trees = new Set<string>()
  for (const t of s.trees) trees.add(`${Math.round(t.p[0] - ox)},${Math.round(t.p[1] - oy)}`)
  // 田块：位置与用地
  const fields = new Set<string>()
  for (const fl of s.fields) {
    const c = cen(fl.poly)
    fields.add(`${Math.round(c[0] - ox)},${Math.round(c[1] - oy)},${fl.kind}`)
  }
  // 城区（住人的片区）：按片区中心的位置
  const urban = new Set<string>()
  for (const w of s.wards) {
    if (!w.density || w.type === 'farm') continue
    const c = cen(w.poly)
    urban.add(`${Math.round(c[0] - ox)},${Math.round(c[1] - oy)}`)
  }
  return { bkeys, road, urban, fields, wardHouses, special, trees, walls, W: s.width, H: s.height, pop: s.stats.population, n: s.buildings.length, wards: s.wards.length }
}
const near = (set: Set<string>, k: string) => {
  if (set.has(k)) return true
  const [x, y] = k.split(',').map(Number)
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (set.has(`${x + dx},${y + dy}`)) return true
  return false
}
const nearB = (m: Map<string, string>, k: string) => {
  if (m.has(k)) return true
  const [x, y] = k.split(',').map(Number)
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (m.has(`${x + dx},${y + dy}`)) return true
  return false
}
const base: any = { ...DEFAULT_SETTLEMENT, ...extra }
if (!free) {
  const ex = pops.map((pop) => settlementExtent({ ...base, population: pop }))
  base.minExtent = [Math.max(...ex.map((e: number[]) => e[0])), Math.max(...ex.map((e: number[]) => e[1]))]
  base.planPop = target
}
let prev: ReturnType<typeof snap> | null = null
let sumB = 0
let sumR = 0
let sumW = 0
let sumL = 0
let sumS = 0
let sumT = 0
let sumF = 0
let worst: [number, number, number][] = []
const t0 = performance.now()
for (const pop of pops) {
  const s = generateSettlement({ ...base, population: pop, counts: { ...(base.counts ?? {}) } })
  const cur = snap(s)
  if (prev) {
    let keptB = 0
    for (const k of prev.bkeys.keys()) if (nearB(cur.bkeys, k)) keptB++
    let keptR = 0
    for (const k of prev.road) if (near(cur.road, k)) keptR++
    let keptW = 0
    for (const k of prev.urban) if (cur.urban.has(k)) keptW++
    const fw = prev.urban.size ? keptW / prev.urban.size : 1
    sumW += fw
    // 片区民居减少的总数 ÷ 上一帧民居数：房子从一个片区"跑"到另一个片区
    let lost = 0
    let tot = 0
    for (const [k, n] of prev.wardHouses) {
      tot += n
      lost += Math.max(0, n - (cur.wardHouses.get(k) ?? 0))
    }
    const fl = tot ? lost / tot : 0
    sumL += fl
    const keepOf = (a: Set<string>, b: Set<string>) => {
      let n = 0
      for (const k of a) if (b.has(k)) n++
      return a.size ? n / a.size : 1
    }
    const fs = keepOf(prev.special, cur.special)
    const ft = keepOf(prev.trees, cur.trees)
    sumS += fs
    sumT += ft
    let keptF = 0
    for (const k of prev.fields) if (cur.fields.has(k)) keptF++
    const ff = prev.fields.size ? keptF / prev.fields.size : 1
    sumF += ff
    const fb = prev.bkeys.size ? keptB / prev.bkeys.size : 1
    const fr = prev.road.size ? keptR / prev.road.size : 1
    sumB += fb
    sumR += fr
    worst.push([pop, fb, fr])
    if (verbose) console.log(String(pop).padStart(6), `${cur.W}x${cur.H}`.padStart(10), 'bld', String(cur.n).padStart(6), 'keepB', (fb * 100).toFixed(1).padStart(5), 'keepR', (fr * 100).toFixed(1).padStart(5), 'keepW', (fw * 100).toFixed(1).padStart(5), 'keepF', (ff * 100).toFixed(1).padStart(5), 'lossH', (fl * 100).toFixed(1).padStart(5), 'keepS', (fs * 100).toFixed(1).padStart(5), 'keepT', (ft * 100).toFixed(1).padStart(5), 'walls', cur.walls)
  }
  prev = cur
}
worst.sort((a, b) => a[1] - b[1])
console.log(JSON.stringify(extra), 'avg keepB', ((sumB / frames) * 100).toFixed(1), 'avg keepR', ((sumR / frames) * 100).toFixed(1), 'avg keepW', ((sumW / frames) * 100).toFixed(1), 'avg keepF', ((sumF / frames) * 100).toFixed(1), 'avg lossH', ((sumL / frames) * 100).toFixed(1), 'avg keepS', ((sumS / frames) * 100).toFixed(1), 'avg keepT', ((sumT / frames) * 100).toFixed(1), 'worstB', worst.slice(0, 4).map(([p, b]) => `${p}:${(b * 100).toFixed(0)}`).join(' '), ((performance.now() - t0) / 1000).toFixed(1) + 's')
