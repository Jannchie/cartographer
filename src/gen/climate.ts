import { Noise } from './noise'
import { RNG } from './rng'
import { Biome, type WorldParams } from './types'
import { blur, clamp, smoothstep } from './util'

export function latitudeOf(p: WorldParams, y: number, H: number): number {
  return p.latNorth + (p.latSouth - p.latNorth) * (y / (H - 1))
}

/** 年均温：纬度 + 海拔递减率 6.5 °C/km + 海洋调节 */
export function temperatureField(p: WorldParams, elev: Float32Array, coastDist: Float32Array, W: number, H: number, rng: RNG) {
  const T = new Float32Array(W * H)
  const n = new Noise(rng)
  for (let y = 0; y < H; y++) {
    const lat = Math.abs(latitudeOf(p, y, H))
    const base = 27 - 0.0066 * lat * lat + p.temperature
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const h = Math.max(0, elev[i])
      // 大陆度：远离海洋的内陆年均温略低（高纬冬季更冷）
      const cont = smoothstep(0, 120, coastDist[i]) * smoothstep(20, 60, lat) * 3
      T[i] = base - 6.5 * h - cont + 1.6 * n.fbm(x / H * 4, y / H * 4, 3) + 1.4 * n.fbm(x / H * 16 + 7, y / H * 16, 3)
    }
  }
  return T
}

/**
 * 降水：沿行星风带逐行推进水汽。
 * 洋面蒸发补给水汽，陆上按基础降水、地形抬升（迎风坡）、高空饱和度析出，
 * 背风坡因此形成雨影区；叠加 ITCZ、副热带高压、西风带的纬向调制。
 */
export function precipitationField(
  p: WorldParams,
  elev: Float32Array,
  T: Float32Array,
  W: number,
  H: number,
  kmPerCell: number,
  rng: RNG,
) {
  const P = new Float32Array(W * H)
  const n = new Noise(rng)
  const cellScale = kmPerCell / 5.86
  for (let y = 0; y < H; y++) {
    const lat = latitudeOf(p, y, H)
    const al = Math.abs(lat)
    // 风向：信风带(东风) / 西风带 / 极地东风
    const west = smoothstep(26, 34, al) * (1 - smoothstep(58, 66, al))
    const windDir = west > 0.5 ? 1 : -1
    // 大气环流纬向调制
    const band =
      0.75 +
      0.8 * Math.exp(-((lat / 11) ** 2)) -
      0.42 * Math.exp(-(((al - 25) / 7) ** 2)) +
      0.3 * Math.exp(-(((al - 50) / 11) ** 2)) -
      0.35 * smoothstep(60, 85, al)
    const row = y * W
    let m = 1
    // 走两圈，让水汽在边界处达到稳态
    for (let lap = 0; lap < 2; lap++) {
      for (let s = 0; s < W; s++) {
        const x = windDir > 0 ? s : W - 1 - s
        const i = row + x
        const h = elev[i]
        const t = T[i]
        const sat = clamp((t + 12) / 38, 0.08, 1)
        if (h <= 0) {
          m += (sat - m) * 0.08 * cellScale
          if (lap === 1) P[i] = m * 900 * band
          continue
        }
        const xn = x + windDir
        const hn = xn >= 0 && xn < W ? Math.max(0, elev[row + xn]) : h
        const rise = Math.max(0, hn - h)
        // 高空的饱和水汽量随海拔下降
        const satAlt = sat * Math.exp(-h / 3.2)
        let rain = m * 0.0032 * cellScale + m * Math.min(0.3, rise * 0.7)
        if (m > satAlt) rain += (m - satAlt) * 0.08
        rain = Math.min(rain, m)
        m -= rain
        // 蒸散再循环：植被把一部分雨水还给大气
        m += rain * 0.62 * clamp((t + 5) / 30, 0, 1)
        if (lap === 1) P[i] = rain * 210000 * band / cellScale + 90 * band
      }
    }
  }
  blur(P, W, H, 4, 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const v = 0.8 + 0.4 * (n.fbm(x / H * 3.5, y / H * 3.5, 4) * 0.5 + 0.5)
      P[i] = Math.max(20, P[i] * v * p.rainfall)
    }
  }
  return P
}

/** 潜在蒸散（mm/年），简化的 Thornthwaite 型关系 */
export function pet(t: number): number {
  return Math.max(60, 48 * t + 360)
}

export function classifyBiome(h: number, t: number, pr: number, slope: number, coast: number): Biome {
  if (t < -7) return Biome.IceCap
  if (h > 2.6 && slope > 0.25 && t < 8) return Biome.Alpine
  if (h > 3.4 && t < 12) return Biome.Alpine
  if (t < 0) return pr < 150 ? Biome.ColdDesert : Biome.Tundra
  if (h < 0.012 && coast < 1.6 && slope < 0.04 && t > 4) return Biome.Beach
  if (t < 7) return pr < 170 ? Biome.ColdDesert : pr < 300 ? (t < 3 ? Biome.Tundra : Biome.Grassland) : Biome.Taiga
  if (t < 18) {
    if (pr < 210) return t < 12 ? Biome.ColdDesert : Biome.HotDesert
    if (pr < 500) return Biome.Grassland
    if (pr < 760) return Biome.Shrubland
    if (pr < 2100) return Biome.TemperateForest
    return Biome.TemperateRainforest
  }
  if (pr < 320) return Biome.HotDesert
  if (pr < 1000) return Biome.Savanna
  if (pr < 1900) return Biome.TropicalSeasonalForest
  return Biome.TropicalRainforest
}
