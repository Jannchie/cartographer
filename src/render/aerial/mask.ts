import { Biome, type World } from '../../gen/types'
import { blur } from '../../gen/util'

/**
 * 地表材质遮罩（RGBA8，每格一个像素，线性过滤后平滑过渡）：
 *   R 森林覆盖度  G 沙滩/裸沙  B 干旱度（荒漠、裸土）  A 环境光遮蔽
 * 着色器据此逐像素混合树冠、草地、沙地、岩石等程序化材质。
 */
export function buildMaterialMask(world: World, exaggeration = 20): Uint8Array {
  const { W, H, elevation: e, biome, temperature: T, coastDist } = world
  const N = W * H
  const forest = new Float32Array(N)
  const sand = new Float32Array(N)
  const arid = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const b = biome[i]
    const h = e[i]
    if (h <= 0) {
      // 浅海的海底是沙
      sand[i] = h > -0.04 ? 1 : 0
      continue
    }
    switch (b) {
      case Biome.TropicalRainforest:
      case Biome.TemperateRainforest:
        forest[i] = 1
        break
      case Biome.Taiga:
      case Biome.TemperateForest:
        forest[i] = 0.92
        break
      case Biome.TropicalSeasonalForest:
        forest[i] = 0.85
        break
      case Biome.Wetland:
        forest[i] = 0.35
        break
      case Biome.Savanna:
        forest[i] = 0.22
        arid[i] = 0.35
        break
      case Biome.Shrubland:
        forest[i] = 0.18
        arid[i] = 0.45
        break
      case Biome.Grassland:
        forest[i] = 0.06
        break
      case Biome.HotDesert:
        arid[i] = 1
        sand[i] = 0.6
        break
      case Biome.ColdDesert:
        arid[i] = 0.85
        break
      case Biome.SaltFlat:
        arid[i] = 0.7
        break
      case Biome.Beach:
        sand[i] = 1
        break
    }
    // 海岸边的沙滩带：低平、温暖处
    if (h < 0.02 && coastDist[i] < 1.6 && T[i] > 3) sand[i] = Math.max(sand[i], 1 - coastDist[i] / 1.8)
  }
  blur(forest, W, H, 1, 2)
  blur(sand, W, H, 1, 1)
  blur(arid, W, H, 1, 2)
  const ao = horizonAO(world, exaggeration)
  const out = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) {
    out[i * 4] = Math.round(Math.min(1, forest[i]) * 255)
    out[i * 4 + 1] = Math.round(Math.min(1, sand[i]) * 255)
    out[i * 4 + 2] = Math.round(Math.min(1, arid[i]) * 255)
    out[i * 4 + 3] = Math.round(ao[i] * 255)
  }
  return out
}

/**
 * 地平线环境光遮蔽：沿 8 个方向步进，记录最大仰角，
 * 天空被遮挡得越多越暗——山谷与峡谷因此有深度感。
 */
function horizonAO(world: World, ex: number): Float32Array {
  const { W, H, elevation: e, kmPerCell } = world
  const N = W * H
  const ao = new Float32Array(N)
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.707, 0.707],
    [-0.707, 0.707],
    [0.707, -0.707],
    [-0.707, -0.707],
  ]
  const steps = [1, 2, 3, 5, 8, 12, 18]
  const k = ex / kmPerCell
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const h0 = Math.max(0, e[i])
      let occ = 0
      for (const [dx, dy] of dirs) {
        let maxT = 0
        for (const s of steps) {
          const xx = Math.round(x + dx * s)
          const yy = Math.round(y + dy * s)
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) break
          const t = ((Math.max(0, e[yy * W + xx]) - h0) * k) / s
          if (t > maxT) maxT = t
        }
        // 仰角正弦
        occ += maxT / Math.sqrt(1 + maxT * maxT)
      }
      ao[i] = 1 - Math.min(0.75, (occ / 8) * 1.3)
    }
  }
  return ao
}
