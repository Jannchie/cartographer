/**
 * 中国大陆高速公路的开通年份：生成 public/china/roads.bin（路网演进视频用）。
 *
 *   python video/expressway/data/extract-osm.py china-latest.osm.pbf motorways.json   # 先从 OSM 数据包取出高速公路
 *   pnpm tsx video/expressway/data/build.ts motorways.json <Ma–Tang 数据目录>
 *
 * Ma–Tang 数据：Lin Ma, Yang Tang (2024), The Distributional Impacts of Transportation Networks in China,
 * Journal of International Economics 103873；https://github.com/malin84/transportation_networks_of_china
 * 的 seg_info/seg_info_road.csv 与 seg_pixel_road.csv（GPL-3.0，由此生成的 roads.bin 不随仓库分发）。
 *
 * 每条路段的开通时间按来源分四级（记在 s 上，视频里注明各级的占比）：
 *   0 OSM 标注：路段自带 start_date / opening_date（年，或年-月、年-月-日）
 *   3 学术数据：Ma–Tang 数据集里高速公路路段的建设年份——沿 OSM 路段每公里取一点，找 3 公里内最近的数据集像素，
 *     过半的点找得到时取年份的中位数（取年中）
 *   1 沿线推断：仍没有时间的路段，沿同一编号的线路找最近的有时间路段（50 公里以内），沿用它的时间
 *   2 估算：仍没有时间的路段，按离已开通路网的远近排序（取任意线路上最近的有时间路段的时间作参照），
 *     依次填进"官方累计里程 − 已知部分"的缺口，使各年的累计里程与交通运输部统计公报一致（按 OSM 总长与官方总里程的比例缩放）
 * 里程按路线长度计：双向分离的路（oneway=yes）两幅各算一半。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { simplifyLine } from '../../../src/gen/util'

const SRC = process.argv[2]
const MATANG = process.argv[3]
if (!SRC || !MATANG) throw new Error('用法：tsx video/expressway/data/build.ts <motorways.json> <Ma–Tang 数据目录>')

/**
 * 历年年底的高速公路通车里程（公里）：交通运输部历年统计公报、国家统计局《中国统计年鉴》。
 * 2001、2002 年由 2002 年公报（年底 25130，新增 5693）推得；2003、2008、2017、2018 年取年鉴的万公里值
 */
const OFFICIAL: [number, number][] = [
  [1988, 147], [1989, 271], [1990, 522], [1991, 574], [1992, 652], [1993, 1145], [1994, 1603], [1995, 2141], [1996, 3422], [1997, 4771],
  [1998, 8733], [1999, 11605], [2000, 16314], [2001, 19437], [2002, 25130], [2003, 29700], [2004, 34300], [2005, 41005], [2006, 45339],
  [2007, 53913], [2008, 60300], [2009, 65055], [2010, 74113], [2011, 84946], [2012, 96200], [2013, 104438], [2014, 111936], [2015, 123523],
  [2016, 130973], [2017, 136400], [2018, 142600], [2019, 149600], [2020, 161000], [2021, 169100], [2022, 177300], [2023, 183600],
  [2024, 190700], [2025, 199400],
]

interface Way {
  id: number
  n: number[]
  c: number[]
  t: Record<string, string>
}
const ways = JSON.parse(readFileSync(SRC, 'utf8')) as Way[]
const t0 = performance.now()
const log = (s: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`)
log(`${ways.length} 条路段`)

const R = 6371.0088
const rad = Math.PI / 180
function lengthKm(c: number[]) {
  let L = 0
  for (let i = 2; i < c.length; i += 2) {
    const la1 = c[i - 1] * rad
    const la2 = c[i + 1] * rad
    const dl = (c[i] - c[i - 2]) * rad
    const a = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dl / 2) ** 2
    L += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
  }
  return L
}

/** "2005" "2005-12" "2005-12-28" "~2005" → 小数年；只有年份的取年中。认不出、或不在 1984~2026 的返回 NaN */
function parseDate(s: string | undefined): number {
  if (!s || /before|after|</i.test(s)) return NaN
  const m = /(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(s)
  if (!m) return NaN
  const y = Number(m[1])
  if (y < 1984 || y > 2026) return NaN
  if (!m[2]) return y + 0.5
  const mo = Math.min(12, Math.max(1, Number(m[2])))
  const d = m[3] ? Math.min(28, Math.max(1, Number(m[3]))) : 15
  return y + (mo - 1) / 12 + (d - 1) / 365
}

const N = ways.length
const len = new Float64Array(N)
const weight = new Float64Array(N)
const date = new Float64Array(N).fill(NaN)
const source = new Uint8Array(N).fill(255)
const refs: string[][] = []
for (let i = 0; i < N; i++) {
  const w = ways[i]
  len[i] = lengthKm(w.c)
  weight[i] = w.t.oneway === 'yes' || w.t.oneway === '1' ? 0.5 : 1
  const d = parseDate(w.t.start_date ?? w.t.opening_date)
  if (!Number.isNaN(d)) {
    date[i] = d
    source[i] = 0
  }
  refs.push((w.t.ref ?? '').split(/[;,/]/).map((r) => r.trim().toUpperCase()).filter(Boolean))
}
// —— 3 学术数据（Ma–Tang）：网格索引高速公路像素 ——
{
  const info = readFileSync(`${MATANG}/seg_info_road.csv`, 'utf8').trim().split(/\r?\n/).slice(1)
  const yearOf = new Map<string, number>()
  for (const l of info) {
    const [id, rate, year] = l.split(',')
    if (rate === 'highway') yearOf.set(id, Number(year))
  }
  const G = 0.02
  const cells = new Map<string, number[]>()
  const px = readFileSync(`${MATANG}/seg_pixel_road.csv`, 'utf8').split(/\r?\n/)
  for (let k = 1; k < px.length; k++) {
    const l = px[k]
    if (!l) continue
    const c1 = l.indexOf(',')
    const y = yearOf.get(l.slice(0, c1))
    if (y === undefined) continue
    const c2 = l.indexOf(',', c1 + 1)
    const c3 = l.indexOf(',', c2 + 1)
    const lon = Number(l.slice(c1 + 1, c2))
    const lat = Number(l.slice(c2 + 1, c3))
    const key = `${Math.floor(lon / G)},${Math.floor(lat / G)}`
    const a = cells.get(key)
    if (a) a.push(lon, lat, y)
    else cells.set(key, [lon, lat, y])
  }
  const MAX_KM = 3
  const nearestYear = (lon: number, lat: number) => {
    const cx = Math.floor(lon / G)
    const cy = Math.floor(lat / G)
    const kx = Math.cos(lat * rad) * 111.32
    let best = Infinity
    let year = NaN
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const a = cells.get(`${cx + dx},${cy + dy}`)
        if (!a) continue
        for (let j = 0; j < a.length; j += 3) {
          const d = Math.hypot((a[j] - lon) * kx, (a[j + 1] - lat) * 110.57)
          if (d < best) {
            best = d
            year = a[j + 2]
          }
        }
      }
    return best <= MAX_KM ? year : NaN
  }
  for (let i = 0; i < N; i++) {
    if (source[i] !== 255) continue
    const c = ways[i].c
    const samples: number[] = []
    let tries = 0
    // 每隔约 1 公里取一点（至少取首尾与中点）
    const step = Math.max(1, Math.floor((c.length / 2) / Math.max(2, len[i])))
    for (let k = 0; k < c.length; k += 2 * step) {
      tries++
      const y = nearestYear(c[k], c[k + 1])
      if (!Number.isNaN(y)) samples.push(y)
    }
    if (samples.length * 2 < tries) continue
    samples.sort((a, b) => a - b)
    date[i] = samples[samples.length >> 1] + 0.5
    source[i] = 3
  }
}

const routeKm = (pick: (i: number) => boolean) => {
  let s = 0
  for (let i = 0; i < N; i++) if (pick(i)) s += len[i] * weight[i]
  return s
}
const total = routeKm(() => true)
log(`OSM 路线总长 ${total.toFixed(0)} km；有标注 ${((routeKm((i) => source[i] === 0) / total) * 100).toFixed(1)}%`)

// —— 连通关系：共用节点的路段相邻 ——
const byNode = new Map<number, number[]>()
for (let i = 0; i < N; i++) {
  for (const id of ways[i].n) {
    const l = byNode.get(id)
    if (l) l.push(i)
    else byNode.set(id, [i])
  }
}
const neighbors = (i: number) => {
  const out = new Set<number>()
  for (const id of ways[i].n) for (const j of byNode.get(id)!) if (j !== i) out.add(j)
  return out
}
const adj = Array.from({ length: N }, (_, i) => [...neighbors(i)])

/**
 * 多源 Dijkstra：从有时间的路段出发，沿相邻路段扩散，记下最近的有时间路段的时间与距离（公里）。
 * sameRoute：只走编号相同的相邻路段
 */
function nearestDated(seed: (i: number) => boolean, sameRoute: boolean) {
  const dist = new Float64Array(N).fill(Infinity)
  const from = new Float64Array(N).fill(NaN)
  // 二叉堆
  const heap: [number, number][] = []
  const push = (d: number, i: number) => {
    heap.push([d, i])
    let k = heap.length - 1
    while (k > 0) {
      const p = (k - 1) >> 1
      if (heap[p][0] <= heap[k][0]) break
      ;[heap[p], heap[k]] = [heap[k], heap[p]]
      k = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        const r = l + 1
        let m = k
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === k) break
        ;[heap[m], heap[k]] = [heap[k], heap[m]]
        k = m
      }
    }
    return top
  }
  for (let i = 0; i < N; i++)
    if (seed(i)) {
      dist[i] = 0
      from[i] = date[i]
      push(0, i)
    }
  while (heap.length) {
    const [d, i] = pop()
    if (d > dist[i]) continue
    for (const j of adj[i]) {
      if (sameRoute && !refs[i].some((r) => refs[j].includes(r))) continue
      const nd = d + (len[i] + len[j]) / 2
      if (nd < dist[j]) {
        dist[j] = nd
        from[j] = from[i]
        push(nd, j)
      }
    }
  }
  return { dist, from }
}

// —— 1 沿线推断 ——
const ROUTE_KM = 50
{
  const { dist, from } = nearestDated((i) => source[i] === 0 || source[i] === 3, true)
  for (let i = 0; i < N; i++) {
    if (source[i] !== 255 || dist[i] > ROUTE_KM) continue
    date[i] = from[i]
    source[i] = 1
  }
}
log(`沿线推断后：已知 ${((routeKm((i) => source[i] !== 255) / total) * 100).toFixed(1)}%`)

// —— 2 估算：按参照时间排序，填进官方累计里程的缺口 ——
{
  const { from } = nearestDated((i) => source[i] !== 255, false)
  const rest: number[] = []
  for (let i = 0; i < N; i++) if (source[i] === 255) rest.push(i)
  // 没有任何参照的（孤立的路段）放到最后
  const ref = (i: number) => (Number.isNaN(from[i]) ? 9999 : from[i])
  rest.sort((a, b) => ref(a) - ref(b) || a - b)
  const scale = total / OFFICIAL[OFFICIAL.length - 1][1]
  // 已知部分各年的累计里程
  const known = new Map<number, number>()
  for (let i = 0; i < N; i++) {
    if (source[i] === 255) continue
    const y = Math.floor(date[i])
    known.set(y, (known.get(y) ?? 0) + len[i] * weight[i])
  }
  // 逐年的缺口：官方累计（按比例）− 已知累计，单调不减
  const gaps: [number, number][] = []
  let kc = 0
  let prev = 0
  for (const [y, km] of OFFICIAL) {
    kc += known.get(y) ?? 0
    const g = Math.max(prev, km * scale - kc)
    gaps.push([y, g])
    prev = g
  }
  let acc = 0
  let k = 0
  for (const i of rest) {
    acc += len[i] * weight[i]
    while (k < gaps.length - 1 && gaps[k][1] < acc) k++
    // 在这一年里按缺口里的位置取月份
    const [y, g] = gaps[k]
    const g0 = k > 0 ? gaps[k - 1][1] : 0
    const f = g > g0 ? Math.min(0.999, Math.max(0, (acc - g0) / (g - g0))) : 0.5
    date[i] = y + f
    source[i] = 2
  }
}
const share = [0, 1, 2, 3].map((s) => routeKm((i) => source[i] === s) / total)
log(`来源：OSM 标注 ${(share[0] * 100).toFixed(1)}%，学术数据 ${(share[3] * 100).toFixed(1)}%，沿线推断 ${(share[1] * 100).toFixed(1)}%，估算 ${(share[2] * 100).toFixed(1)}%`)

// 各年累计（数据）与官方对照
{
  const rows: string[] = []
  for (const [y, km] of OFFICIAL) {
    const d = routeKm((i) => date[i] < y + 1)
    if (y % 5 === 0 || y === 1988 || y === 2025) rows.push(`${y}: 数据 ${Math.round(d)}，官方×比例 ${Math.round(km * (total / OFFICIAL[OFFICIAL.length - 1][1]))}`)
  }
  log('\n  ' + rows.join('\n  '))
}

// —— 年内排开（一）：只知道年份的路段（取年中）若同时出现，视频里会整批冒出来。
// 先算每条这样的路段离年初已开通路网有多远（沿路网，公里）；串成链之后按链排开（见下） ——
const growth = new Float64Array(N).fill(NaN)
const loose = (i: number) => source[i] !== 2 && date[i] - Math.floor(date[i]) === 0.5
{
  const byYear = new Map<number, number[]>()
  for (let i = 0; i < N; i++) {
    if (!loose(i)) continue
    const y = Math.floor(date[i])
    const l = byYear.get(y)
    if (l) l.push(i)
    else byYear.set(y, [i])
  }
  const dist = new Float64Array(N)
  const member = new Uint8Array(N)
  for (const [Y, list] of byYear) {
    for (const i of list) {
      member[i] = 1
      dist[i] = Infinity
    }
    // 接着已开通路网的路段从 0 出发，在本年这批路段里扩散
    const queue: number[] = []
    for (const i of list) {
      if (adj[i].some((j) => !member[j] && date[j] < Y)) {
        dist[i] = 0
        queue.push(i)
      }
    }
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h]
      for (const j of adj[i]) {
        if (!member[j]) continue
        const d = dist[i] + (len[i] + len[j]) / 2
        if (d < dist[j]) {
          dist[j] = d
          queue.push(j)
        }
      }
    }
    // 不与旧路网相连的新路：在已排开的范围里按编号散开（确定性的伪随机）
    let maxD = 0
    for (const i of list) if (Number.isFinite(dist[i])) maxD = Math.max(maxD, dist[i])
    for (const i of list) growth[i] = Number.isFinite(dist[i]) ? dist[i] : ((Math.imul(ways[i].id, 2654435761) >>> 0) / 4294967296) * (maxD || 1)
    for (const i of list) member[i] = 0
  }
}

// —— 串成长链：同线路、同一个月开通、首尾相连的路段接成一条，视频里一整条从一端焊到另一端 ——
// OSM 的路段很碎（平均不到 1 公里），单段动画看不出来
function chains() {
  const groups = new Map<string, number[]>()
  for (let i = 0; i < N; i++) {
    const key = `${Math.floor(date[i] * 12)}|${refs[i].join(';')}`
    const g = groups.get(key)
    if (g) g.push(i)
    else groups.set(key, [i])
  }
  const out: { c: number[]; t: number; s: number; km: number; near: number }[] = []
  for (const members of groups.values()) {
    // 端点 → 组内以它为端点的路段
    const ends = new Map<number, number[]>()
    for (const i of members) {
      const n = ways[i].n
      for (const e of [n[0], n[n.length - 1]]) {
        const l = ends.get(e)
        if (l) l.push(i)
        else ends.set(e, [i])
      }
    }
    const used = new Set<number>()
    // 先从链头（只连着一条路段的端点）出发，剩下的（成环的）随便挑一条起
    const starts = [...members].sort((a, b) => {
      const deg = (i: number) => Math.min(ends.get(ways[i].n[0])!.length, ends.get(ways[i].n[ways[i].n.length - 1])!.length)
      return deg(a) - deg(b)
    })
    for (const s0 of starts) {
      if (used.has(s0)) continue
      used.add(s0)
      let w = ways[s0]
      // 从度为 1 的一端出发
      let c = ends.get(w.n[0])!.length <= ends.get(w.n[w.n.length - 1])!.length ? w.c.slice() : reverse(w.c)
      let tail = ends.get(w.n[0])!.length <= ends.get(w.n[w.n.length - 1])!.length ? w.n[w.n.length - 1] : w.n[0]
      let t = date[s0]
      const order = (i: number) => (loose(i) ? growth[i] : date[i])
      const first = order(s0)
      let last = first
      let near = loose(s0) ? growth[s0] : Infinity
      let km = len[s0] * weight[s0]
      const src = new Float64Array(4)
      src[source[s0]] += len[s0]
      for (;;) {
        const next = ends.get(tail)!.find((j) => !used.has(j))
        if (next === undefined) break
        used.add(next)
        w = ways[next]
        const fwd = w.n[0] === tail
        const nc = fwd ? w.c : reverse(w.c)
        c = c.concat(nc.slice(2))
        tail = fwd ? w.n[w.n.length - 1] : w.n[0]
        t = Math.min(t, date[next])
        last = order(next)
        if (loose(next)) near = Math.min(near, growth[next])
        km += len[next] * weight[next]
        src[source[next]] += len[next]
      }
      let best = 0
      for (let k = 1; k < 4; k++) if (src[k] > src[best]) best = k
      // 从先通的一端焊向另一端
      if (last < first) c = reverse(c)
      out.push({ c: simplifyLine(c, 0.0015).map((v) => Math.round(v * 1e5)), t, s: best, km: Math.round(km * 10) / 10, near })
    }
  }
  return out
}
function reverse(c: number[]) {
  const o: number[] = []
  for (let k = c.length - 2; k >= 0; k -= 2) o.push(c[k], c[k + 1])
  return o
}

// —— 输出：经纬度化简到约 150 米，×10⁵ 取整 ——
const runs = chains()
// 年内排开（二）：同一年里只知道年份的链，按离旧路网的远近在年内依次排开
{
  const byYear = new Map<number, typeof runs>()
  for (const r of runs) {
    if (!Number.isFinite(r.near)) continue
    const y = Math.floor(r.t)
    const l = byYear.get(y)
    if (l) l.push(r)
    else byYear.set(y, [r])
  }
  for (const [Y, list] of byYear) {
    list.sort((a, b) => a.near - b.near)
    list.forEach((r, k) => (r.t = Y + 0.04 + (0.92 * k) / Math.max(1, list.length - 1)))
  }
}
for (const r of runs) r.t = Math.round(r.t * 1000) / 1000
log(`${runs.length} 条链（平均 ${(runs.reduce((a, r) => a + r.km, 0) / runs.length).toFixed(1)} km）`)
const out = { official: OFFICIAL, share, ways: runs.map(({ c, t, s, km }) => ({ c, t, s, km })) }
const bin = gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 })
writeFileSync('public/china/roads.bin', bin)
log(`roads.bin ${(bin.length / 1048576).toFixed(1)} MB`)
