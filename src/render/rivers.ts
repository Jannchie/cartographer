import type { River, World } from '../gen/types'
import { riverThreshold } from '../gen/world'

export interface SmoothRiver {
  xs: Float32Array
  ys: Float32Array
  fl: Float32Array
}

/** Chaikin 细分：把 D8 的折线变成自然的曲线，同时保留端点（汇流点不脱节） */
export function smoothRivers(world: World): SmoothRiver[] {
  const out: SmoothRiver[] = []
  for (const r of world.rivers) out.push(chaikin(r, 2))
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
