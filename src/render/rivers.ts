import type { River, World } from '../gen/types'
import { riverThreshold } from '../gen/world'

export interface SmoothRiver {
  xs: Float32Array
  ys: Float32Array
  fl: Float32Array
}

/** Chaikin 细分 + 蜿蜒：把 D8 的折线变成自然的曲线，同时保留端点（汇流点不脱节） */
export function smoothRivers(world: World): SmoothRiver[] {
  const out: SmoothRiver[] = []
  for (const r of world.rivers) {
    const c = chaikin(r, 3)
    out.push(meander(Array.from(c.xs), Array.from(c.ys), Array.from(c.fl)))
  }
  return out
}

function chaikin(r: River, iterations: number): SmoothRiver {
  let n = r.points.length / 2
  let xs = new Float32Array(n)
  let ys = new Float32Array(n)
  let fl = Float32Array.from(r.flow)
  for (let i = 0; i < n; i++) {
    xs[i] = r.points[i * 2]
    ys[i] = r.points[i * 2 + 1]
  }
  for (let it = 0; it < iterations; it++) {
    if (n < 3) break
    const m = (n - 1) * 2
    const nx = new Float32Array(m)
    const ny = new Float32Array(m)
    const nf = new Float32Array(m)
    nx[0] = xs[0]
    ny[0] = ys[0]
    nf[0] = fl[0]
    let k = 1
    for (let i = 0; i < n - 1; i++) {
      if (i > 0) {
        nx[k] = 0.75 * xs[i] + 0.25 * xs[i + 1]
        ny[k] = 0.75 * ys[i] + 0.25 * ys[i + 1]
        nf[k] = fl[i]
        k++
      }
      if (i < n - 2) {
        nx[k] = 0.25 * xs[i] + 0.75 * xs[i + 1]
        ny[k] = 0.25 * ys[i] + 0.75 * ys[i + 1]
        nf[k] = fl[i + 1]
        k++
      }
    }
    nx[k] = xs[n - 1]
    ny[k] = ys[n - 1]
    nf[k] = fl[n - 1]
    k++
    xs = nx.subarray(0, k)
    ys = ny.subarray(0, k)
    fl = nf.subarray(0, k)
    n = k
  }
  return { xs, ys, fl }
}

/**
 * 按宽度分段绘制河流。同一宽度档位的一段用一条平滑路径画出，
 * 圆头圆角让不同档位之间无缝衔接。
 */
export function drawRivers(
  ctx: CanvasRenderingContext2D,
  rivers: SmoothRiver[],
  W: number,
  scale: number,
  color: string,
  widthMul = 1,
  minFlowMul = 1,
) {
  const thr = riverThreshold(W) * minFlowMul
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const widthOf = (f: number) => Math.min(4.2, 0.45 + 0.62 * Math.log2(1 + f / thr)) * widthMul * (scale / 2)
  for (const r of rivers) {
    const n = r.xs.length
    let k = 0
    while (k < n - 1) {
      if (r.fl[k] < thr) {
        k++
        continue
      }
      const w = widthOf(r.fl[k])
      const bucket = Math.round(w * 4)
      ctx.beginPath()
      ctx.lineWidth = w
      ctx.moveTo(r.xs[k] * scale, r.ys[k] * scale)
      let j = k + 1
      while (j < n) {
        const mx = ((r.xs[j - 1] + r.xs[j]) / 2) * scale
        const my = ((r.ys[j - 1] + r.ys[j]) / 2) * scale
        ctx.quadraticCurveTo(r.xs[j - 1] * scale, r.ys[j - 1] * scale, mx, my)
        if (Math.round(widthOf(r.fl[j]) * 4) !== bucket) break
        j++
      }
      if (j >= n) ctx.lineTo(r.xs[n - 1] * scale, r.ys[n - 1] * scale)
      ctx.stroke()
      k = Math.max(j - 1, k + 1)
    }
  }
  ctx.restore()
}

/** 按弧长等距重采样后沿法向加噪声摆动（两端收为零），打破网格留下的直线段 */
function meander(xs: number[], ys: number[], fl: number[]): SmoothRiver {
  const n = xs.length
  const L = [0]
  for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]))
  const total = L[n - 1]
  if (total < 1) return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), fl: Float32Array.from(fl) }
  const step = 0.35
  const m = Math.max(2, Math.ceil(total / step) + 1)
  const ox: number[] = []
  const oy: number[] = []
  const of: number[] = []
  let j = 0
  const seed = xs[0] * 12.9898 + ys[0] * 78.233
  for (let k = 0; k < m; k++) {
    const s = (k / (m - 1)) * total
    while (j < n - 2 && L[j + 1] < s) j++
    const t = (s - L[j]) / Math.max(1e-6, L[j + 1] - L[j])
    const x = xs[j] + (xs[j + 1] - xs[j]) * t
    const y = ys[j] + (ys[j + 1] - ys[j]) * t
    let tx = xs[j + 1] - xs[j]
    let ty = ys[j + 1] - ys[j]
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl
    ty /= tl
    // 沿弧长的一维分形噪声做摆动：弯的疏密、幅度都不规则；
    // 另一层低频噪声调制幅度，让有的河段近乎笔直、有的河段曲流发育。大河摆幅更大
    const f = fl[j]
    const tort = 0.25 + 0.75 * noise1(s * 0.12, seed + 91.7)
    const amp = Math.min(1.1, 0.3 + 0.1 * Math.log2(1 + f)) * tort * Math.min(1, s / 2, (total - s) / 2)
    const w = (noise1(s * 0.55, seed) - 0.5) * 1.3 + (noise1(s * 1.4, seed + 13.1) - 0.5) * 0.6 + (noise1(s * 3.3, seed + 47.9) - 0.5) * 0.25
    ox.push(x - ty * w * amp)
    oy.push(y + tx * w * amp)
    of.push(f)
  }
  return { xs: Float32Array.from(ox), ys: Float32Array.from(oy), fl: Float32Array.from(of) }
}

/** 平滑的一维值噪声，约 [0, 1] */
function noise1(x: number, seed: number) {
  const h = (i: number) => {
    const v = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453
    return v - Math.floor(v)
  }
  const i = Math.floor(x)
  const t = x - i
  const u = t * t * (3 - 2 * t)
  return h(i) * (1 - u) + h(i + 1) * u
}
