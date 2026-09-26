import { Biome } from '../gen/types'

export type RGB = [number, number, number]

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

/** 写实地表色（3D 贴图用），偏自然的卫星影像色调 */
export const PHYSICAL: Record<number, RGB> = {
  [Biome.Ocean]: hex('#1d3b52'),
  [Biome.Lake]: hex('#5e6f5a'),
  [Biome.IceCap]: hex('#eef1f3'),
  [Biome.Tundra]: hex('#8d8b72'),
  [Biome.Taiga]: hex('#3c5541'),
  [Biome.TemperateForest]: hex('#4b6737'),
  [Biome.TemperateRainforest]: hex('#2f553a'),
  [Biome.Grassland]: hex('#98a05c'),
  [Biome.Shrubland]: hex('#a09566'),
  [Biome.ColdDesert]: hex('#a89c80'),
  [Biome.HotDesert]: hex('#d6b985'),
  [Biome.Savanna]: hex('#ada056'),
  [Biome.TropicalSeasonalForest]: hex('#5a7a33'),
  [Biome.TropicalRainforest]: hex('#2d5a28'),
  [Biome.Alpine]: hex('#81786d'),
  [Biome.Beach]: hex('#d8c69b'),
  [Biome.Wetland]: hex('#56694f'),
  [Biome.SaltFlat]: hex('#cfc7b3'),
}

/** 制图风格（纸质地图）：低饱和的水彩色 */
export const ATLAS: Record<number, RGB> = {
  [Biome.Ocean]: hex('#b9cfd2'),
  [Biome.Lake]: hex('#a9c3c8'),
  [Biome.IceCap]: hex('#f4f3ee'),
  [Biome.Tundra]: hex('#c9c6ad'),
  [Biome.Taiga]: hex('#9aaa8a'),
  [Biome.TemperateForest]: hex('#a9b886'),
  [Biome.TemperateRainforest]: hex('#8fa785'),
  [Biome.Grassland]: hex('#d3d3a2'),
  [Biome.Shrubland]: hex('#d6cc9f'),
  [Biome.ColdDesert]: hex('#d9ceb0'),
  [Biome.HotDesert]: hex('#ead7ab'),
  [Biome.Savanna]: hex('#dcd29b'),
  [Biome.TropicalSeasonalForest]: hex('#abbc7f'),
  [Biome.TropicalRainforest]: hex('#8ea878'),
  [Biome.Alpine]: hex('#c4b9a8'),
  [Biome.Beach]: hex('#ece0bd'),
  [Biome.Wetland]: hex('#a3b59b'),
  [Biome.SaltFlat]: hex('#f1ece0'),
}

/** 海底：浅滩沙色 → 陆架青绿 → 深海蓝 */
export function seabed(depthKm: number): RGB {
  const stops: [number, RGB][] = [
    [0, hex('#b8ae88')],
    [0.012, hex('#7f9a86')],
    [0.04, hex('#5b8580')],
    [0.14, hex('#3f6f73')],
    [0.6, hex('#23485a')],
    [4, hex('#132a3b')],
  ]
  return ramp(stops, depthKm)
}

/** 纸图海洋分层设色 */
export function atlasSea(depthKm: number): RGB {
  const stops: [number, RGB][] = [
    [0, hex('#cfe0de')],
    [0.15, hex('#bcd3d5')],
    [1, hex('#a8c4cb')],
    [3, hex('#94b3be')],
    [5, hex('#86a7b4')],
  ]
  return ramp(stops, depthKm)
}

export function ramp(stops: [number, RGB][], v: number): RGB {
  if (v <= stops[0][0]) return stops[0][1]
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const [a, ca] = stops[k - 1]
      const [b, cb] = stops[k]
      const t = (v - a) / (b - a)
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]
    }
  }
  return stops[stops.length - 1][1]
}
