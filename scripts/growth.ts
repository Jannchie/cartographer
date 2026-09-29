// 成长动画的稳定性：按 playGrowth 的人口序列取各帧，量城市是不是"一座城一路长大"
// tsx scripts/growth.ts key=value ...   (target=, frames=, from=, v=1, legacy=1, seed=, culture= ...)
//
// 轨迹指标（与帧的疏密无关）：
// - flicker：消失后又在原处出现的要素数（同一栋房子时有时无）
// - orphan：无因消失——消失时下一帧没有新出现的东西压在它的位置上（房子凭空没了、跑到别处去了）
// 相邻帧指标：keepB（建筑）、keepR（道路）、keepF（田块）、keepT（树）留下来的比例
import { createCanvas, ImageData, Path2D, DOMMatrix } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).Path2D = Path2D
;(globalThis as any).DOMMatrix = DOMMatrix
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }
const G: any = await import('../src/settlement/generate')
const H: any = await import('../src/settlement/history').catch(() => ({}))
const { DEFAULT_SETTLEMENT } = await import('../src/settlement/types')

const extra: Record<string, any> = {}
for (const kv of process.argv.slice(2)) {
  const [k, v] = kv.split('=')
  extra[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v)
}
const take = (k: string, d: any) => {
  const v = extra[k] ?? d
  delete extra[k]
  return v
}
const target = take('target', 20000)
const frames = take('frames', 48)
const from = take('from', Math.min(30, target))
const verbose = !!take('v', false)
const legacy = !!take('legacy', false) || !G.generateHistory
const pops = Array.from({ length: frames + 1 }, (_, k) => Math.round(Math.exp(Math.log(from) + ((Math.log(target) - Math.log(from)) * k) / frames)))

type P = [number, number]
type Box = [number, number, number, number]
const cen = (poly: P[]): P => {
  let x = 0
  let y = 0
  for (const q of poly) {
    x += q[0]
    y += q[1]
  }
  return [x / poly.length, y / poly.length]
}
const boxOf = (poly: P[], ox: number, oy: number): Box => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x - ox)
    y0 = Math.min(y0, y - oy)
    x1 = Math.max(x1, x - ox)
    y1 = Math.max(y1, y - oy)
  }
  return [x0, y0, x1, y1]
}
const hit = (a: Box, b: Box) => a[0] < b[2] - 0.3 && b[0] < a[2] - 0.3 && a[1] < b[3] - 0.3 && b[1] < a[3] - 0.3

/** 一帧里的要素：键（世界坐标取整到米 + 种类）与包围盒 */
function frameOf(s: any) {
  const ox = s.width / 2
  const oy = s.height / 2
  const key = (q: P, tag: string) => `${Math.round(q[0] - ox)},${Math.round(q[1] - oy)},${tag}`
  const b = new Map<string, Box>()
  for (const x of s.buildings) b.set(key(cen(x.poly), x.kind), boxOf(x.poly, ox, oy))
  const f = new Map<string, Box>()
  for (const x of s.fields) f.set(key(cen(x.poly), x.kind), boxOf(x.poly, ox, oy))
  const t = new Map<string, Box>()
  for (const x of s.trees) t.set(key(x.p, 't'), [x.p[0] - ox - x.r, x.p[1] - oy - x.r, x.p[0] - ox + x.r, x.p[1] - oy + x.r])
  const road = new Set<string>()
  for (const r of s.roads) {
    if (r.kind === 'path') continue
    for (let i = 0; i + 1 < r.line.length; i++) {
      const a = r.line[i]
      const c = r.line[i + 1]
      const n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / 4))
      for (let k = 0; k < n; k++) road.add(`${Math.round((a[0] + ((c[0] - a[0]) * k) / n - ox) / 4)},${Math.round((a[1] + ((c[1] - a[1]) * k) / n - oy) / 4)}`)
    }
  }
  return { b, f, t, road, n: s.buildings.length, pop: s.stats.population }
}

/** 近似匹配：同种类、位置差一米以内算同一个 */
const find = (m: Map<string, Box> | Set<string>, k: string) => {
  if (m.has(k)) return k
  const [x, y, tag] = k.split(',')
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const kk = `${+x + dx},${+y + dy}${tag === undefined ? '' : ',' + tag}`
      if (m.has(kk)) return kk
    }
  return null
}

/** 轨迹：每个要素出现过几段、消失时有没有新东西压在原处 */
class Track {
  /** 要素 → 上一次在的帧、出现过的段数 */
  seen = new Map<string, { last: number; runs: number }>()
  flicker = 0
  orphan = 0
  deaths = 0
  step(k: number, prev: Map<string, Box> | null, cur: Map<string, Box>) {
    for (const key of cur.keys()) {
      const id = (prev && find(prev, key)) ?? key
      const s = this.seen.get(id)
      if (!s) this.seen.set(key, { last: k, runs: 1 })
      else {
        if (s.last < k - 1) {
          s.runs++
          if (s.runs === 2) this.flicker++
        }
        s.last = k
        if (id !== key) this.seen.set(key, s)
      }
    }
    if (!prev) return 0
    // 新出现的（上一帧没有的）
    const born: Box[] = []
    for (const [key, box] of cur) if (!find(prev, key)) born.push(box)
    let orphan = 0
    for (const [key, box] of prev) {
      if (find(cur, key)) continue
      this.deaths++
      if (!born.some((b) => hit(b, box))) orphan++
    }
    this.orphan += orphan
    return orphan
  }
}

const base: any = { ...DEFAULT_SETTLEMENT, ...extra, counts: { ...(extra.counts ?? {}) } }
const ex = pops.map((pop) => G.settlementExtent({ ...base, population: pop }))
base.minExtent = [Math.max(...ex.map((e: number[]) => e[0])), Math.max(...ex.map((e: number[]) => e[1]))]
base.planPop = target

const t0 = performance.now()
const hist = legacy ? null : G.generateHistory({ ...base, population: target })
const tHist = performance.now() - t0
const frameAt = (pop: number) => (hist ? H.snapshot(hist, pop) : G.generateSettlement({ ...base, population: pop }))

const TB = new Track()
const TF = new Track()
const TT = new Track()
let prev: ReturnType<typeof frameOf> | null = null
const sum = { b: 0, r: 0, f: 0, t: 0 }
const worst: [number, number][] = []
const keep = (a: Map<string, Box> | Set<string>, b: Map<string, Box> | Set<string>) => {
  let n = 0
  for (const k of a.keys()) if (find(b, k)) n++
  return a.size ? n / a.size : 1
}
pops.forEach((pop, k) => {
  const cur = frameOf(frameAt(pop))
  const ob = TB.step(k, prev?.b ?? null, cur.b)
  TF.step(k, prev?.f ?? null, cur.f)
  TT.step(k, prev?.t ?? null, cur.t)
  if (prev) {
    const kb = keep(prev.b, cur.b)
    const kr = keep(prev.road, cur.road)
    const kf = keep(prev.f, cur.f)
    const kt = keep(prev.t, cur.t)
    sum.b += kb
    sum.r += kr
    sum.f += kf
    sum.t += kt
    worst.push([pop, kb])
    if (verbose)
      console.log(
        String(pop).padStart(6),
        'pop',
        String(cur.pop).padStart(6),
        'bld',
        String(cur.n).padStart(5),
        'keepB',
        (kb * 100).toFixed(1).padStart(5),
        'orphanB',
        String(ob).padStart(4),
        'keepR',
        (kr * 100).toFixed(1).padStart(5),
        'keepF',
        (kf * 100).toFixed(1).padStart(5),
        'keepT',
        (kt * 100).toFixed(1).padStart(5),
      )
  }
  prev = cur
})
worst.sort((a, b) => a[1] - b[1])
const pct = (x: number) => ((x / frames) * 100).toFixed(1)
console.log(
  JSON.stringify(extra),
  legacy ? '[legacy]' : '[history]',
  `keepB ${pct(sum.b)} keepR ${pct(sum.r)} keepF ${pct(sum.f)} keepT ${pct(sum.t)}`,
  `| flicker B ${TB.flicker} F ${TF.flicker} T ${TT.flicker}`,
  `| orphan B ${TB.orphan}/${TB.deaths} F ${TF.orphan}/${TF.deaths}`,
  `| worstB ${worst
    .slice(0, 3)
    .map(([p, b]) => `${p}:${(b * 100).toFixed(0)}`)
    .join(' ')}`,
  `| ${hist ? `history ${(tHist / 1000).toFixed(1)}s, ` : ''}total ${((performance.now() - t0) / 1000).toFixed(1)}s`,
)
