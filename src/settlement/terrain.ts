import { Noise } from '../gen/noise'
import { RNG } from '../gen/rng'
import { edt } from '../gen/util'
import { chaikin, dist, resample, type P } from './geom'
import type { SettlementParams, Terrain } from './types'

/** 各规模的地图范围（米） */
export const EXTENT: Record<SettlementParams['size'], [number, number]> = {
  hamlet: [560, 400],
  village: [860, 600],
  town: [1320, 920],
  city: [2000, 1400],
}

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export interface TerrainResult {
  terrain: Terrain
  river: { line: P[]; hw: number[] } | null
  /** 海的方向（单位向量）与岸线离中心的距离 */
  coast: { dir: P; shore: number } | null
  hillDir: P | null
  /** 双线性采样高程 / 水距 */
  heightAt: (p: P) => number
  waterAt: (p: P) => number
  /** 水距的梯度（指向远离水体的方向） */
  waterGrad: (p: P) => P
  slopeAt: (p: P) => number
  /** 是否为海（河道不算） */
  seaAt: (p: P) => boolean
}

/**
 * 局部地形：缓坡基底 + 可选的"依山"山体、海岸与穿城河流。
 * 河流先定走向再下切河谷，保证水往低处流；海岸在城市附近内凹成海湾，便于建港。
 */
export function buildTerrain(p: SettlementParams, rng: RNG): TerrainResult {
  const [MW, MH] = EXTENT[p.size]
  const cell = MW / 360
  const W = Math.ceil(MW / cell) + 1
  const H = Math.ceil(MH / cell) + 1
  const N = W * H
  const noise = new Noise(rng.fork())
  const cx = MW / 2
  const cy = MH / 2
  const R = Math.min(MW, MH) / 2
  const angle = (a: number) => (Number.isFinite(a) ? a : rng.range(0, Math.PI * 2))

  const coastA = angle(p.coastDir)
  const cd: P = [Math.cos(coastA), Math.sin(coastA)]
  // 岸线：离中心 0.45R 左右，沿岸随噪声起伏，城市正前方内凹成海湾
  const shore0 = R * rng.range(0.38, 0.55)
  const bay = R * rng.range(0.12, 0.26)
  const bayW = R * rng.range(0.35, 0.6)
  const shoreAt = (x: number, y: number) => {
    const t = -(x - cx) * cd[1] + (y - cy) * cd[0]
    return shore0 + noise.fbm(t / 520 + 11.3, 3.7, 4) * R * 0.22 - bay * Math.exp(-((t / bayW) ** 2))
  }

  let hillA = angle(p.hillDir)
  // 依山又临海时，山在海的对面一侧
  if (p.coast && p.hills && !Number.isFinite(p.hillDir)) hillA = coastA + Math.PI + rng.range(-0.8, 0.8)
  const hd: P = [Math.cos(hillA), Math.sin(hillA)]
  const hillH = 55 + 110 * p.relief

  const height = new Float32Array(N)
  const rel = 0.25 + p.relief
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = i * cell
      const y = j * cell
      let h = 6 + rel * (noise.fbm(x / 520, y / 520, 4) * 16 + 12) + rel * noise.fbm(x / 140 + 7, y / 140 - 3, 3) * 3.5
      if (p.hills) {
        const d = (x - cx) * hd[0] + (y - cy) * hd[1]
        const t = sm(R * 0.05, R * 1.25, d + noise.fbm(x / 380 - 5, y / 380 + 9, 3) * R * 0.3)
        const ridge = noise.ridged(x / 330 + 2.1, y / 330 - 7.7, 4)
        h += t * hillH * (0.45 + 0.9 * ridge) + t * t * hillH * 0.4
      }
      if (p.coast) {
        const s = shoreAt(x, y) - ((x - cx) * cd[0] + (y - cy) * cd[1])
        h = s >= 0 ? Math.max(0.4, h * sm(-20, 220, s)) : s * 0.06
      }
      height[j * W + i] = h
    }
  }

  // —— 河流 ——
  let river: TerrainResult['river'] = null
  const riverMask = new Uint8Array(N)
  let hwAt = (_x: number, _y: number) => 0
  if (p.river) {
    const hw0 = { hamlet: 5, village: 7, town: rng.range(9, 14), city: rng.range(14, 24) }[p.size]
    // 来向：临海时从内陆流向海，否则随机
    let from = angle(p.riverDir)
    if (p.coast && !Number.isFinite(p.riverDir)) from = coastA + Math.PI + rng.range(-0.9, 0.9)
    const u: P = [-Math.cos(from), -Math.sin(from)] // 流向
    const n: P = [-u[1], u[0]]
    // 离中心的横向偏移：城市通常建在河的一侧并跨河发展
    const off = R * rng.range(-0.28, 0.28)
    const far = Math.hypot(MW, MH)
    const pts: P[] = []
    const steps = 40
    const amp = R * rng.range(0.08, 0.2)
    for (let k = 0; k <= steps; k++) {
      const s = -far / 2 + (far * k) / steps
      const wig = noise.fbm(s / 650 + 31.1, 0.5, 3) * amp * 2.2
      pts.push([cx + u[0] * s + n[0] * (off + wig), cy + u[1] * s + n[1] * (off + wig)])
    }
    let line = chaikin(pts, 3)
    // 临海：流到海里就截断（再多留一段伸进海里，保证河口与海相连）
    if (p.coast) {
      const cut = line.findIndex(([x, y]) => shoreAt(x, y) - ((x - cx) * cd[0] + (y - cy) * cd[1]) < -hw0 * 3)
      if (cut > 0) line = line.slice(0, cut + 1)
    }
    line = resample(line, cell)
    hwAt = (x: number, y: number) => hw0 * (1 + 0.18 * noise.fbm(x / 260 + 50, y / 260, 2))
    river = { line, hw: line.map(([x, y]) => hwAt(x, y)) }

    // 河谷：按到中线的距离下切
    const center = new Uint8Array(N)
    for (const [x, y] of resample(line, cell * 0.5)) {
      const i = Math.round(x / cell)
      const j = Math.round(y / cell)
      if (i >= 0 && j >= 0 && i < W && j < H) center[j * W + i] = 1
    }
    const dC = edt(center, W, H)
    const valley = 90 + 220 * (1 - p.relief) + hw0 * 4
    for (let k = 0; k < N; k++) {
      const x = (k % W) * cell
      const y = Math.floor(k / W) * cell
      const d = dC[k] * cell
      const hw = hwAt(x, y)
      if (d < hw) riverMask[k] = 1
      const floor = 0.6 + Math.max(0, d - hw) * 0.035
      const t = sm(hw * 1.2, hw * 1.2 + valley, d)
      const bed = d < hw ? -1.5 * (1 - d / hw) : floor
      height[k] = Math.min(height[k], bed * (1 - t) + height[k] * t)
      if (d < hw) height[k] = Math.min(height[k], -0.5)
    }
  }

  // —— 水体有向距离场 ——
  const wet = new Uint8Array(N)
  const dry = new Uint8Array(N)
  for (let k = 0; k < N; k++) {
    const w = height[k] < 0 || riverMask[k] === 1
    wet[k] = w ? 1 : 0
    dry[k] = w ? 0 : 1
  }
  const dOut = edt(wet, W, H)
  const dIn = edt(dry, W, H)
  const water = new Float32Array(N)
  for (let k = 0; k < N; k++) water[k] = (wet[k] ? -dIn[k] + 0.5 : dOut[k] - 0.5) * cell

  const bil = (f: Float32Array) => (q: P) => {
    const fx = Math.min(W - 1.001, Math.max(0, q[0] / cell))
    const fy = Math.min(H - 1.001, Math.max(0, q[1] / cell))
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const tx = fx - i
    const ty = fy - j
    const k = j * W + i
    return (f[k] * (1 - tx) + f[k + 1] * tx) * (1 - ty) + (f[k + W] * (1 - tx) + f[k + W + 1] * tx) * ty
  }
  const sea = new Uint8Array(N)
  for (let k = 0; k < N; k++) sea[k] = height[k] < 0 && !riverMask[k] ? 1 : 0
  const seaAt = (q: P) => {
    const i = Math.min(W - 1, Math.max(0, Math.round(q[0] / cell)))
    const j = Math.min(H - 1, Math.max(0, Math.round(q[1] / cell)))
    return sea[j * W + i] === 1
  }
  const heightAt = bil(height)
  const waterAt = bil(water)
  const g = cell
  const waterGrad = (q: P): P => {
    const gx = waterAt([q[0] + g, q[1]]) - waterAt([q[0] - g, q[1]])
    const gy = waterAt([q[0], q[1] + g]) - waterAt([q[0], q[1] - g])
    const L = Math.hypot(gx, gy) || 1
    return [gx / L, gy / L]
  }
  const slopeAt = (q: P) => {
    const gx = heightAt([q[0] + g, q[1]]) - heightAt([q[0] - g, q[1]])
    const gy = heightAt([q[0], q[1] + g]) - heightAt([q[0], q[1] - g])
    return Math.hypot(gx, gy) / (2 * g)
  }

  return {
    terrain: { W, H, cell, height, water },
    river,
    coast: p.coast ? { dir: cd, shore: shore0 - bay } : null,
    hillDir: p.hills ? hd : null,
    heightAt,
    waterAt,
    waterGrad,
    slopeAt,
    seaAt,
  }
}

/**
 * 网格 A*：在地形上找一条代价最低的路（坡度、涉水都有代价）。
 * 海不可通行（过河靠桥，过海不行）；终点不可达时返回空数组。
 */
export function routeOnTerrain(T: TerrainResult, from: P, to: P, opts: { water: number; slope: number; bias?: (p: P) => number }): P[] {
  const { W, H, cell } = T.terrain
  // 用较粗的网格寻路，保证速度
  const s = Math.max(1, Math.round(8 / cell))
  const GW = Math.ceil(W / s)
  const GH = Math.ceil(H / s)
  const gc = cell * s
  const idx = (q: P) => Math.min(GH - 1, Math.max(0, Math.round(q[1] / gc))) * GW + Math.min(GW - 1, Math.max(0, Math.round(q[0] / gc)))
  const start = idx(from)
  const goal = idx(to)
  const gScore = new Float64Array(GW * GH).fill(Infinity)
  const prev = new Int32Array(GW * GH).fill(-1)
  const open: [number, number][] = []
  const push = (k: number, f: number) => {
    open.push([f, k])
    let i = open.length - 1
    while (i > 0) {
      const pa = (i - 1) >> 1
      if (open[pa][0] <= open[i][0]) break
      ;[open[pa], open[i]] = [open[i], open[pa]]
      i = pa
    }
  }
  const pop = () => {
    const top = open[0]
    const last = open.pop()!
    if (open.length) {
      open[0] = last
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= open.length) break
        if (c + 1 < open.length && open[c + 1][0] < open[c][0]) c++
        if (open[c][0] >= open[i][0]) break
        ;[open[c], open[i]] = [open[i], open[c]]
        i = c
      }
    }
    return top[1]
  }
  const gx = goal % GW
  const gy = Math.floor(goal / GW)
  const hEst = (k: number) => Math.hypot((k % GW) - gx, Math.floor(k / GW) - gy) * gc
  gScore[start] = 0
  push(start, hEst(start))
  const DX = [1, -1, 0, 0, 1, 1, -1, -1, 2, 2, -2, -2, 1, 1, -1, -1]
  const DY = [0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 2, -2, 2, -2]
  const closed = new Uint8Array(GW * GH)
  while (open.length) {
    const k = pop()
    if (k === goal) break
    if (closed[k]) continue
    closed[k] = 1
    const x = k % GW
    const y = Math.floor(k / GW)
    const hp = T.heightAt([x * gc, y * gc])
    for (let d = 0; d < DX.length; d++) {
      const nx = x + DX[d]
      const ny = y + DY[d]
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue
      const nk = ny * GW + nx
      if (closed[nk]) continue
      const q: P = [nx * gc, ny * gc]
      if (nk !== goal && T.seaAt(q)) continue
      const L = Math.hypot(DX[d], DY[d]) * gc
      const dh = Math.abs(T.heightAt(q) - hp) / L
      let c = L * (1 + opts.slope * dh * dh * 40)
      if (T.waterAt(q) < 0) c += L * opts.water
      if (opts.bias) c *= opts.bias(q)
      const ng = gScore[k] + c
      if (ng < gScore[nk]) {
        gScore[nk] = ng
        prev[nk] = k
        push(nk, ng + hEst(nk))
      }
    }
  }
  if (goal !== start && prev[goal] < 0) return []
  const path: P[] = []
  for (let k = goal; k >= 0; k = prev[k]) {
    path.push([(k % GW) * gc, Math.floor(k / GW) * gc])
    if (k === start) break
  }
  path.reverse()
  if (path.length) {
    path[0] = from
    path[path.length - 1] = to
  }
  return path
}

/** 折线上是否有点落在海里（按 step 米重采样检查） */
export function touchesSea(T: TerrainResult, line: P[], step = 3) {
  if (line.length < 2) return false
  for (const q of resample(line, step)) if (T.seaAt(q)) return true
  return false
}

/** 把折线在海里的部分去掉，返回留在陆上的各段 */
export function landPieces(T: TerrainResult, line: P[], step = 3): P[][] {
  const out: P[][] = []
  let cur: P[] = []
  for (const q of resample(line, step)) {
    if (T.seaAt(q)) {
      if (cur.length > 1) out.push(cur)
      cur = []
    } else cur.push(q)
  }
  if (cur.length > 1) out.push(cur)
  return out
}

/** 折线离最近点的距离 */
export function nearestOn(line: P[], q: P) {
  let best = Infinity
  let at = 0
  for (let i = 0; i < line.length; i++) {
    const d = dist(line[i], q)
    if (d < best) {
      best = d
      at = i
    }
  }
  return { d: best, i: at }
}
