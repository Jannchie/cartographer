import type { Language } from './names'
import type { ZhNamer } from './names_zh'
import { RNG } from './rng'
import type { Label, Realm } from './types'
import { MinHeap, edt, neighbors8 } from './util'

/**
 * 政区：以都城和大城市为种子做"地形代价"扩张（Dijkstra）。
 * 翻山、跨大河、渡海代价高，于是国界自然落在山脊、大河与海峡上。
 */
export function buildRealms(
  elev: Float32Array,
  flow: Float32Array,
  labels: Label[],
  W: number,
  H: number,
  kmPerCell: number,
  riverThr: number,
  lang: Language,
  zh: ZhNamer,
  rng: RNG,
): { realm: Int16Array; realms: Realm[] } {
  const N = W * H
  let landCells = 0
  for (let i = 0; i < N; i++) if (elev[i] > 0) landCells++
  const target = Math.max(3, Math.min(14, Math.round(landCells / 11000) + 2))
  const minSep = 70 * (W / 1024)

  const cities = labels.filter((l) => l.kind === 'capital' || l.kind === 'city').sort((a, b) => b.weight - a.weight)
  const seeds: Label[] = []
  for (const c of cities) {
    if (seeds.length >= target) break
    if (seeds.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < minSep)) continue
    seeds.push(c)
  }

  const cost = new Float64Array(N).fill(Infinity)
  const realm = new Int16Array(N).fill(-1)
  const heap = new MinHeap(1 << 16)
  const { off, dx, dy, dist } = neighbors8(W)
  seeds.forEach((s, id) => {
    const i = Math.floor(s.y) * W + Math.floor(s.x)
    cost[i] = 0
    realm[i] = id
    heap.push(0, i)
  })
  // 各国扩张能力略有不同，边界不至于是等距的平分线
  const vigor = seeds.map(() => rng.range(0.8, 1.25))
  while (heap.size > 0) {
    const c = heap.pop()
    const kc = heap.lastKey
    if (kc > cost[c]) continue
    const cx = c % W
    const cy = (c - cx) / W
    const id = realm[c]
    for (let k = 0; k < 8; k++) {
      const x = cx + dx[k]
      const y = cy + dy[k]
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const j = c + off[k]
      const hj = elev[j]
      let step: number
      if (hj <= 0) step = 6 // 渡海
      else {
        const slope = Math.abs(hj - Math.max(0, elev[c])) / kmPerCell
        step = 1 + slope * 45 + Math.max(0, hj - 1.2) * 1.5
        if (flow[j] > riverThr * 6) step += 5 // 大河
      }
      const nc = kc + (step * dist[k]) / vigor[id]
      if (nc < cost[j]) {
        cost[j] = nc
        realm[j] = id
        heap.push(nc, j)
      }
    }
  }
  for (let i = 0; i < N; i++) if (elev[i] <= 0) realm[i] = -1

  // 邻接 → 贪心着色，相邻国家颜色不同
  const adj = seeds.map(() => new Set<number>())
  for (let i = 0; i < N - W - 1; i++) {
    const a = realm[i]
    if (a < 0) continue
    for (const j of [i + 1, i + W]) {
      const b = realm[j]
      if (b >= 0 && b !== a) {
        adj[a].add(b)
        adj[b].add(a)
      }
    }
  }
  const color = new Array<number>(seeds.length).fill(-1)
  const order = seeds.map((_, i) => i).sort((a, b) => adj[b].size - adj[a].size)
  for (const id of order) {
    const usedC = new Set([...adj[id]].map((n) => color[n]))
    let c = rng.int(0, 7)
    for (let t = 0; t < 8 && usedC.has(c); t++) c = (c + 1) % 8
    color[id] = c
  }

  // 国名标注点：国土内离国界与海岸最远处（不可达极点）
  const edge = new Uint8Array(N)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const a = realm[i]
      if (a < 0 || x === 0 || y === 0 || x === W - 1 || y === H - 1) {
        edge[i] = 1
        continue
      }
      if (realm[i + 1] !== a || realm[i - 1] !== a || realm[i + W] !== a || realm[i - W] !== a) edge[i] = 1
    }
  }
  const inner = edt(edge, W, H)
  const pole = new Int32Array(seeds.length).fill(-1)
  const cnt = new Float64Array(seeds.length)
  for (let i = 0; i < N; i++) {
    const r = realm[i]
    if (r < 0) continue
    cnt[r]++
    if (pole[r] < 0 || inner[i] > inner[pole[r]]) pole[r] = i
  }
  const forms: [string, string][] = [
    ['Kingdom of #', '王国'],
    ['# Empire', '帝国'],
    ['Duchy of #', '公国'],
    ['Principality of #', '公国'],
    ['# Republic', '共和国'],
    ['Grand Duchy of #', '大公国'],
    ['# Dominion', '领'],
    ['Khanate of #', '汗国'],
  ]
  const realms: Realm[] = seeds.map((s, id) => {
    const best = pole[id] >= 0 ? pole[id] : Math.floor(s.y) * W + Math.floor(s.x)
    const base = lang.word()
    const [form, suffix] = rng.pick(forms)
    return {
      name: form.replace('#', base),
      zh: zh.name('realm', base, suffix),
      color: color[id],
      x: best % W,
      y: Math.floor(best / W),
      capital: labels.indexOf(s),
      area: cnt[id],
      room: pole[id] >= 0 ? inner[pole[id]] : 1,
    }
  })
  return { realm, realms }
}
