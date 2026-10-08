import * as dmath from './dmath'

export const INF = 1e20

export function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 分位数（对副本排序） */
export function quantile(arr: ArrayLike<number>, q: number, filter?: (v: number) => boolean): number {
  let tmp: Float32Array
  if (filter) {
    const buf: number[] = []
    for (let i = 0; i < arr.length; i++) if (filter(arr[i])) buf.push(arr[i])
    tmp = Float32Array.from(buf)
  } else {
    tmp = Float32Array.from(arr as ArrayLike<number>)
  }
  if (tmp.length === 0) return 0
  tmp.sort()
  return tmp[clamp(Math.floor(q * (tmp.length - 1)), 0, tmp.length - 1)]
}

/** Felzenszwalb 精确欧氏距离变换：返回每格到最近 feature 格（mask=1）的距离 */
export function edt(mask: Uint8Array, W: number, H: number): Float32Array {
  const n = Math.max(W, H)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const grid = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) grid[i] = mask[i] ? 0 : INF

  const pass = (len: number) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++
      const dq = q - v[k]
      d[q] = dq * dq + f[v[k]]
    }
  }

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x]
    pass(H)
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y]
  }
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) f[x] = grid[row + x]
    pass(W)
    for (let x = 0; x < W; x++) out[row + x] = Math.sqrt(d[x])
  }
  return out
}

/** 三次盒式模糊 ≈ 高斯模糊（原地） */
export function blur(src: Float32Array, W: number, H: number, radius: number, passes = 3): Float32Array {
  const r = Math.max(1, Math.round(radius))
  const tmp = new Float32Array(W * H)
  const a = src
  for (let p = 0; p < passes; p++) {
    // 横向
    for (let y = 0; y < H; y++) {
      const row = y * W
      let acc = 0
      for (let x = -r; x <= r; x++) acc += a[row + clampi(x, 0, W - 1)]
      for (let x = 0; x < W; x++) {
        tmp[row + x] = acc / (2 * r + 1)
        acc += a[row + clampi(x + r + 1, 0, W - 1)] - a[row + clampi(x - r, 0, W - 1)]
      }
    }
    // 纵向
    for (let x = 0; x < W; x++) {
      let acc = 0
      for (let y = -r; y <= r; y++) acc += tmp[clampi(y, 0, H - 1) * W + x]
      for (let y = 0; y < H; y++) {
        a[y * W + x] = acc / (2 * r + 1)
        acc += tmp[clampi(y + r + 1, 0, H - 1) * W + x] - tmp[clampi(y - r, 0, H - 1) * W + x]
      }
    }
  }
  return a
}

function clampi(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x
}

/** 最小堆（浮点键 + 整数值） */
export class MinHeap {
  keys: Float64Array
  vals: Int32Array
  size = 0

  constructor(cap: number) {
    this.keys = new Float64Array(cap)
    this.vals = new Int32Array(cap)
  }

  push(k: number, v: number) {
    if (this.size >= this.keys.length) this.grow()
    let i = this.size++
    const keys = this.keys
    const vals = this.vals
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= k) break
      keys[i] = keys[p]
      vals[i] = vals[p]
      i = p
    }
    keys[i] = k
    vals[i] = v
  }

  /** 弹出最小值，返回值（键在 lastKey） */
  lastKey = 0
  pop(): number {
    const keys = this.keys
    const vals = this.vals
    const top = vals[0]
    this.lastKey = keys[0]
    const n = --this.size
    const k = keys[n]
    const v = vals[n]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= n) break
      if (c + 1 < n && keys[c + 1] < keys[c]) c++
      if (keys[c] >= k) break
      keys[i] = keys[c]
      vals[i] = vals[c]
      i = c
    }
    keys[i] = k
    vals[i] = v
    return top
  }

  private grow() {
    const k = new Float64Array(this.keys.length * 2)
    k.set(this.keys)
    const v = new Int32Array(this.vals.length * 2)
    v.set(this.vals)
    this.keys = k
    this.vals = v
  }
}

/** 8 邻域偏移 */
export function neighbors8(W: number): { off: Int32Array; dx: Int8Array; dy: Int8Array; dist: Float32Array } {
  const dx = Int8Array.from([1, -1, 0, 0, 1, 1, -1, -1])
  const dy = Int8Array.from([0, 0, 1, -1, 1, -1, 1, -1])
  const off = new Int32Array(8)
  const dist = new Float32Array(8)
  for (let k = 0; k < 8; k++) {
    off[k] = dy[k] * W + dx[k]
    dist[k] = k < 4 ? 1 : Math.SQRT2
  }
  return { off, dx, dy, dist }
}

/** Ramer–Douglas–Peucker 折线简化（交替存储的坐标）：偏离弦线不超过 tol 的点去掉 */
export function simplifyLine(pts: number[], tol: number) {
  const n = pts.length / 2
  if (n <= 2) return pts
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const ax = pts[a * 2]
    const ay = pts[a * 2 + 1]
    const dx = pts[b * 2] - ax
    const dy = pts[b * 2 + 1] - ay
    const len = dmath.hypot(dx, dy) || 1
    let best = -1
    let bd = tol
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((pts[k * 2] - ax) * dy - (pts[k * 2 + 1] - ay) * dx) / len
      if (d > bd) ((bd = d), (best = k))
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  const out: number[] = []
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[k * 2], pts[k * 2 + 1])
  return out
}

/** 有符号距离（格）：inside 为 1 的格取到外部的距离（正），其余取到内部的距离（负） */
export function signedDistance(inside: Uint8Array, W: number, H: number) {
  const N = W * H
  const outside = new Uint8Array(N)
  for (let i = 0; i < N; i++) outside[i] = 1 - inside[i]
  const dIn = edt(inside, W, H)
  const dOut = edt(outside, W, H)
  const out = new Float32Array(N)
  for (let i = 0; i < N; i++) out[i] = inside[i] ? dOut[i] : -dIn[i]
  return out
}
