import { Biome, reliefKm, type World } from '../../gen/types'
import { blur } from '../../gen/util'
import { riverThreshold } from '../../gen/world'

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
  const { W, H, elevation: e } = world
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
  const D = dirs.length
  const S = steps.length
  // 每个方向、每一步的整数偏移（x 为整数时 round(x + v) = x + round(v)）与下标增量
  const ox = new Int32Array(D * S)
  const oy = new Int32Array(D * S)
  const od = new Int32Array(D * S)
  for (let d = 0; d < D; d++) {
    for (let j = 0; j < S; j++) {
      const m = d * S + j
      ox[m] = Math.round(dirs[d][0] * steps[j])
      oy[m] = Math.round(dirs[d][1] * steps[j])
      od[m] = oy[m] * W + ox[m]
    }
  }
  // 海面以下按 0 计：先统一截断
  const hp = new Float32Array(N)
  for (let i = 0; i < N; i++) hp[i] = Math.max(0, e[i])
  const k = ex / reliefKm(world)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const h0 = hp[i]
      let occ = 0
      for (let d = 0; d < D; d++) {
        let maxT = 0
        for (let j = 0, m = d * S; j < S; j++, m++) {
          const xx = x + ox[m]
          const yy = y + oy[m]
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) break
          const t = ((hp[i + od[m]] - h0) * k) / steps[j]
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

/**
 * 细节遮罩（RGBA8，每格一个像素）：
 *   R 河岸湿润度（沿河谷的茂密植被带）  G 保留
 *   B 湿地（沼泽里的小水塘）  A 盐壳（盐沼、干涸湖床）
 */
export function buildDetailMask(world: World): Uint8Array {
  const { W, H, elevation: e, biome, flow, water } = world
  const N = W * H
  const wet = new Float32Array(N)
  const salt = new Float32Array(N)
  const marsh = new Float32Array(N)
  const thr = riverThreshold(W)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (e[i] <= 0.004 || !Number.isNaN(water[i])) continue
      const f = flow[i] / thr
      if (f > 0.25) wet[i] = Math.min(1, 0.35 + 0.25 * Math.log2(1 + f))
      if (biome[i] === Biome.Wetland) {
        wet[i] = Math.max(wet[i], 0.8)
        marsh[i] = 1
      }
      if (biome[i] === Biome.SaltFlat) salt[i] = 1
    }
  }
  blur(wet, W, H, 2, 2)
  blur(salt, W, H, 1, 1)
  blur(marsh, W, H, 1, 1)
  const out = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) {
    out[i * 4] = Math.round(Math.min(1, wet[i] * 1.4) * 255)
    out[i * 4 + 2] = Math.round(Math.min(1, marsh[i]) * 255)
    out[i * 4 + 3] = Math.round(Math.min(1, salt[i]) * 255)
  }
  return out
}
