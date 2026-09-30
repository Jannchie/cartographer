import { RNG } from './rng'
import * as dmath from './dmath'

const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6
// 12 个梯度方向，均匀分布
const GRAD = new Float32Array(24)
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2 + 0.13
  GRAD[i * 2] = dmath.cos(a)
  GRAD[i * 2 + 1] = dmath.sin(a)
}

/** 种子化 2D simplex 噪声及其分形组合。 */
export class Noise {
  private perm = new Uint8Array(512)
  private permMod12 = new Uint8Array(512)

  constructor(rng: RNG) {
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1))
      const t = p[i]
      p[i] = p[j]
      p[j] = t
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255]
      this.permMod12[i] = this.perm[i] % 12
    }
  }

  /** 约 [-1, 1] */
  simplex(xin: number, yin: number): number {
    const perm = this.perm
    const pm = this.permMod12
    const s = (xin + yin) * F2
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const t = (i + j) * G2
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)
    const i1 = x0 > y0 ? 1 : 0
    const j1 = 1 - i1
    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2
    const ii = i & 255
    const jj = j & 255
    let n = 0
    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 > 0) {
      const g = pm[ii + perm[jj]] * 2
      t0 *= t0
      n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0)
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1]] * 2
      t1 *= t1
      n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1)
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 > 0) {
      const g = pm[ii + 1 + perm[jj + 1]] * 2
      t2 *= t2
      n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2)
    }
    return 99 * n
  }

  /** 分形布朗运动，约 [-1, 1] */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0
    let amp = 1
    let norm = 0
    let f = 1
    for (let o = 0; o < octaves; o++) {
      // 每个八度旋转并平移，打破网格方向性
      const rx = x * f
      const ry = y * f
      sum += amp * this.simplex(rx * 0.8 - ry * 0.6 + o * 17.3, rx * 0.6 + ry * 0.8 - o * 9.1)
      norm += amp
      amp *= gain
      f *= lacunarity
    }
    return sum / norm
  }

  /** Musgrave 脊状多重分形：尖锐的山脊线，[0, 1] */
  ridged(x: number, y: number, octaves: number, lacunarity = 2.05, gain = 0.5): number {
    let sum = 0
    let amp = 0.5
    let norm = 0
    let prev = 1
    let f = 1
    for (let o = 0; o < octaves; o++) {
      const rx = x * f
      const ry = y * f
      let n = 1 - Math.abs(this.simplex(rx * 0.8 - ry * 0.6 + o * 31.7, rx * 0.6 + ry * 0.8 + o * 5.3))
      n *= n
      sum += n * amp * prev
      norm += amp
      prev = Math.min(1, n * 1.6)
      amp *= gain
      f *= lacunarity
    }
    return sum / norm
  }
}
