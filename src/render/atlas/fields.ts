import { Biome, reliefKm, type World } from '../../gen/types'
import { blur, sampleField, smoothstep } from '../../gen/util'
import type { RGB } from '../palette'

export function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 平滑值噪声（像素坐标，cell 为特征尺寸） */
export function vnoise(x: number, y: number, cell: number) {
  const gx = x / cell
  const gy = y / cell
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  let fx = gx - x0
  let fy = gy - y0
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const a = hash(x0, y0)
  const b = hash(x0 + 1, y0)
  const c = hash(x0, y0 + 1)
  const d = hash(x0 + 1, y0 + 1)
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
}

/** 多层旋转叠加的值噪声，消除单层值噪声的方格感，约 [0,1] */
export function fnoise(x: number, y: number, cell: number) {
  const a = vnoise(x, y, cell)
  const b = vnoise(x * 0.8 - y * 0.6 + 317, x * 0.6 + y * 0.8 - 91, cell * 0.53)
  const c = vnoise(x * 0.28 + y * 0.96 - 733, -x * 0.96 + y * 0.28 + 211, cell * 0.29)
  return a * 0.55 + b * 0.3 + c * 0.15
}

/** 在颜色 o 上按 a 混入 (r,g,b) */
export function mix(o: Float32Array, r: number, g: number, b: number, a: number) {
  if (a <= 0) return
  if (a > 1) a = 1
  o[0] += (r - o[0]) * a
  o[1] += (g - o[1]) * a
  o[2] += (b - o[2]) * a
}

export function mixc(o: Float32Array, c: RGB, a: number) {
  mix(o, c[0], c[1], c[2], a)
}

export function set(o: Float32Array, c: RGB) {
  o[0] = c[0]
  o[1] = c[1]
  o[2] = c[2]
}

/** 细线的抗锯齿覆盖率：sd 为到线的像素距离，w 为半线宽 */
export function line(sd: number, w: number) {
  return 1 - smoothstep(w - 0.5, w + 0.6, sd)
}

/** 每个像素的地理量（由栅格双线性采样得到） */
export interface Px {
  px: number
  py: number
  gx: number
  gy: number
  /** 最近格索引 */
  i: number
  /** 海拔 km */
  h: number
  /** 海拔梯度（km/像素） */
  gpx: number
  /** 多方向山体晕渲，平地 ≈ 1 */
  shade: number
  /** 到海岸线的有符号距离（像素，陆地为正；远距离时来自距离场） */
  coast: number
  /** 海岸线附近的精确像素距离 |h|/|∇h| */
  coastSd: number
  /** 湖泊覆盖 0~1 与湖岸像素距离 */
  lake: number
  lakeSd: number
  /** 年均温 */
  T: number
}

/** 每个世界、每个缩放比共享的采样器 */
export class Fields {
  readonly W: number
  readonly H: number
  readonly MW: number
  readonly MH: number
  readonly lake: Float32Array
  private colorCache = new Map<string, [Float32Array, Float32Array, Float32Array]>()

  constructor(readonly world: World, readonly S: number) {
    this.W = world.W
    this.H = world.H
    this.MW = world.W * S
    this.MH = world.H * S
    const N = world.W * world.H
    this.lake = new Float32Array(N)
    for (let i = 0; i < N; i++) this.lake[i] = world.biome[i] === Biome.Lake ? 1 : 0
  }

  sample(a: ArrayLike<number>, gx: number, gy: number) {
    return sampleField(a, this.W, this.H, gx, gy)
  }

  /** 按调色板生成羽化过的每格群系底色 */
  biomeColors(key: string, palette: Record<number, RGB>, tweak?: (c: RGB, i: number) => RGB) {
    let c = this.colorCache.get(key)
    if (c) return c
    const { W, H } = this
    const N = W * H
    const r = new Float32Array(N)
    const g = new Float32Array(N)
    const b = new Float32Array(N)
    const { biome: bio, temperature: T, elevation: e } = this.world
    const cold = palette[Biome.ColdDesert]
    const hot = palette[Biome.HotDesert]
    // 群系沿气候带的等值线划分，平原上常是近乎笔直的长线：取色时把陆地格的取样位置低频扰动几格，边界随之弯曲
    const amp = ecotoneRadius(W) * 4
    const cell = ecotoneRadius(W) * 10
    const warpable = (k: number) => e[k] > 0 && bio[k] !== Biome.Lake && bio[k] !== Biome.Beach
    for (let i = 0; i < N; i++) {
      let src = i
      if (warpable(i)) {
        const x = i % W
        const y = (i - x) / W
        const sx = Math.round(x + (fnoise(x, y, cell) - 0.5) * 2 * amp)
        const sy = Math.round(y + (fnoise(x + 1931, y - 777, cell) - 0.5) * 2 * amp)
        const j = sy * W + sx
        if (sx >= 0 && sx < W && sy >= 0 && sy < H && warpable(j)) src = j
      }
      let col = palette[bio[src]]
      // 冷、热沙漠按年均温阈值划分，平原上等温线近乎纬线：按温度连续插值，免得出现一条笔直的色带接缝
      if (bio[src] === Biome.ColdDesert || bio[src] === Biome.HotDesert) {
        const k = smoothstep(7, 17, T[src])
        col = [cold[0] + (hot[0] - cold[0]) * k, cold[1] + (hot[1] - cold[1]) * k, cold[2] + (hot[2] - cold[2]) * k]
      }
      if (tweak) col = tweak(col, i)
      r[i] = col[0]
      g[i] = col[1]
      b[i] = col[2]
    }
    featherBiomes([r, g, b], this.world)
    c = [r, g, b]
    this.colorCache.set(key, c)
    return c
  }

  /** 逐像素扫描，fn 写入颜色 */
  scan(fn: (p: Px, o: Float32Array) => void): ImageData {
    const { W, S, MW, MH, world } = this
    const e = world.elevation
    const km = reliefKm(world)
    const img = new ImageData(MW, MH)
    const d = img.data
    const o = new Float32Array(3)
    const p = {} as Px
    const zf = 14
    for (let py = 0; py < MH; py++) {
      const gy = (py + 0.5) / S - 0.5
      for (let px = 0; px < MW; px++) {
        const gx = (px + 0.5) / S - 0.5
        const h = this.sample(e, gx, gy)
        const hL = this.sample(e, gx - 0.5, gy)
        const hR = this.sample(e, gx + 0.5, gy)
        const hU = this.sample(e, gx, gy - 0.5)
        const hD = this.sample(e, gx, gy + 0.5)
        const gpx = Math.hypot(hR - hL, hD - hU) / S + 1e-6
        // 多方向晕渲：主光源西北，辅以西、北
        const nx = (-(Math.max(0, hR) - Math.max(0, hL)) / km) * zf
        const ny = (-(Math.max(0, hD) - Math.max(0, hU)) / km) * zf
        const inv = 1 / Math.hypot(nx, ny, 1)
        const l1 = ((nx * -0.6 + ny * -0.6 + 0.53) * inv) / 0.53
        const l2 = ((nx * -0.85 + ny * 0.1 + 0.52) * inv) / 0.52
        const l3 = ((nx * -0.1 + ny * -0.85 + 0.52) * inv) / 0.52
        p.px = px
        p.py = py
        p.gx = gx
        p.gy = gy
        p.i = Math.min(this.H - 1, Math.max(0, Math.round(gy))) * W + Math.min(W - 1, Math.max(0, Math.round(gx)))
        p.h = h
        p.gpx = gpx
        p.shade = Math.min(1.12, Math.max(0.38, l1 * 0.6 + l2 * 0.2 + l3 * 0.2))
        p.coastSd = Math.abs(h) / gpx
        p.coast = this.sample(world.coastDist, gx, gy) * S
        const lm = this.sample(this.lake, gx, gy)
        p.lake = lm
        if (lm > 0.02 && lm < 0.98) {
          const lgx = this.sample(this.lake, gx + 0.5, gy) - this.sample(this.lake, gx - 0.5, gy)
          const lgy = this.sample(this.lake, gx, gy + 0.5) - this.sample(this.lake, gx, gy - 0.5)
          p.lakeSd = Math.abs(lm - 0.5) / ((Math.hypot(lgx, lgy) + 1e-6) / S)
        } else p.lakeSd = 99
        p.T = this.sample(world.temperature, gx, gy)
        fn(p, o)
        const k = (py * MW + px) * 4
        d[k] = o[0]
        d[k + 1] = o[1]
        d[k + 2] = o[2]
        d[k + 3] = 255
      }
    }
    return img
  }
}

/** 群系过渡带的羽化半径（格）：群系由气候阈值逐格判定，不羽化时相邻群系之间是硬边 */
export const ecotoneRadius = (W: number) => Math.max(1, Math.round(W / 512))

/**
 * 归一化卷积：只在 mask 为 1 的格之间模糊，mask 两侧的颜色互不渗透。
 * 返回新数组；mask 外、但在半径内的格得到 mask 内颜色的外推值（供岸线处双线性采样），更远的格保留原值。
 */
export function maskedBlur(ch: Float32Array[], mask: Float32Array, W: number, H: number, radius: number, passes = 2): Float32Array[] {
  const den = blur(Float32Array.from(mask), W, H, radius, passes)
  return ch.map((c) => {
    const num = blur(c.map((v, i) => v * mask[i]), W, H, radius, passes)
    return num.map((v, i) => (den[i] > 1e-4 ? v / den[i] : c[i]))
  })
}

/** 陆地与水域分开羽化后按格拼回：岸线两侧颜色互不渗透，群系之间渐变 */
export function featherBiomes(ch: Float32Array[], world: World) {
  const { W, H, elevation: e, biome } = world
  const land = new Float32Array(W * H)
  for (let i = 0; i < land.length; i++) land[i] = e[i] > 0 && biome[i] !== Biome.Lake ? 1 : 0
  const r = ecotoneRadius(W)
  const onLand = maskedBlur(ch, land, W, H, r)
  const onWater = maskedBlur(ch, land.map((v) => 1 - v), W, H, r)
  ch.forEach((c, k) => {
    for (let i = 0; i < c.length; i++) c[i] = land[i] ? onLand[k][i] : onWater[k][i]
  })
}

/** 纸张纹理：细颗粒 + 大块晕染 */
export function paperGrain(o: Float32Array, px: number, py: number, amt = 1) {
  const g = (hash(px, py) - 0.5) * 7 * amt
  const b = ((fnoise(px, py, 40) - 0.5) * 5 + (fnoise(px + 511, py, 150) - 0.5) * 8) * amt
  o[0] += g + b
  o[1] += g + b
  o[2] += g * 0.9 + b
}
