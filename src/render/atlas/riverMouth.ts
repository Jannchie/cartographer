import type { SmoothRiver } from '../rivers'
import type { Fields } from './fields'

/**
 * 把入海河流精确截到海岸线（高程过零处），止于岸边陆地上的沿流向补到海岸，
 * 让河的墨线正好收进海岸线里，而不是差一截或伸进海里。
 */
export function fitRiversToCoast(rivers: SmoothRiver[], f: Fields): SmoothRiver[] {
  const e = f.world.elevation
  // 河流坐标是格中心（x + 0.5）；场的采样坐标以格中心为整数
  const elev = (x: number, y: number) => f.sample(e, x - 0.5, y - 0.5)
  const out: SmoothRiver[] = []
  for (const r of rivers) {
    const n = r.xs.length
    let end: SmoothRiver | null = null
    // 第一个落到海面的点：在它和前一点之间插值出过零位置
    for (let i = 1; i < n; i++) {
      const b = elev(r.xs[i], r.ys[i])
      if (b > 0) continue
      const a = elev(r.xs[i - 1], r.ys[i - 1])
      const t = a > 0 ? a / (a - b) : 0
      end = cut(r, i, r.xs[i - 1] + (r.xs[i] - r.xs[i - 1]) * t, r.ys[i - 1] + (r.ys[i] - r.ys[i - 1]) * t)
      break
    }
    if (!end && n >= 3) {
      const lx = r.xs[n - 1]
      const ly = r.ys[n - 1]
      const px = r.xs[Math.max(0, n - 4)]
      const py = r.ys[Math.max(0, n - 4)]
      const dl = Math.hypot(lx - px, ly - py) || 1
      const dx = (lx - px) / dl
      const dy = (ly - py) / dl
      let prev = elev(lx, ly)
      for (let s = 0.1; s <= 3 && prev > 0; s += 0.1) {
        const cur = elev(lx + dx * s, ly + dy * s)
        if (cur <= 0) {
          const ss = s - 0.1 + 0.1 * (prev / (prev - cur))
          end = cut(r, n, lx + dx * ss, ly + dy * ss)
          break
        }
        prev = cur
      }
    }
    out.push(end ?? r)
  }
  return out
}

function cut(r: SmoothRiver, n: number, x: number, y: number): SmoothRiver {
  const xs = new Float32Array(n + 1)
  const ys = new Float32Array(n + 1)
  const fl = new Float32Array(n + 1)
  xs.set(r.xs.subarray(0, n))
  ys.set(r.ys.subarray(0, n))
  fl.set(r.fl.subarray(0, n))
  xs[n] = x
  ys[n] = y
  fl[n] = r.fl[Math.min(n, r.fl.length - 1)]
  return { xs, ys, fl }
}
