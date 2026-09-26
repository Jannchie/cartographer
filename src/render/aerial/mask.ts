import { Biome, type World } from '../../gen/types'
import { blur, clamp } from '../../gen/util'
import { riverThreshold, slopeField } from '../../gen/world'

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

/**
 * 细节遮罩（RGBA8，每格一个像素）：
 *   R 河岸湿润度（沿河谷的茂密植被带）  G 农田（城镇周边平缓宜耕的土地）
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
  const farm = farmland(world, wet)
  const out = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) {
    out[i * 4] = Math.round(Math.min(1, wet[i] * 1.4) * 255)
    out[i * 4 + 1] = Math.round(Math.min(1, farm[i]) * 255)
    out[i * 4 + 2] = Math.round(Math.min(1, marsh[i]) * 255)
    out[i * 4 + 3] = Math.round(Math.min(1, salt[i]) * 255)
  }
  return out
}

/** 各群系的宜耕程度（森林会被开垦，但比草原少） */
const ARABLE: Partial<Record<number, number>> = {
  [Biome.Grassland]: 1,
  [Biome.TemperateForest]: 0.85,
  [Biome.Savanna]: 0.75,
  [Biome.Shrubland]: 0.6,
  [Biome.TropicalSeasonalForest]: 0.6,
  [Biome.TemperateRainforest]: 0.45,
  [Biome.Wetland]: 0.35,
  [Biome.TropicalRainforest]: 0.3,
  [Biome.Taiga]: 0.25,
}

/**
 * 农田：以城镇为中心向外（首都腹地更大），只落在平缓、宜耕的低地上；
 * 河谷两岸的冲积平原顺着河道往外延伸得更远。
 */
function farmland(world: World, wet: Float32Array) {
  const { W, H, elevation: e, biome, kmPerCell } = world
  const prox = new Float32Array(W * H)
  for (const l of world.labels) {
    if (l.kind !== 'city' && l.kind !== 'capital') continue
    // 半径（格）：城市约 90 km，首都约 150 km；河谷方向再放宽一半
    const r = (l.kind === 'capital' ? 150 : 90) / kmPerCell
    const R = Math.ceil(r * 1.6)
    const cx = Math.round(l.x)
    const cy = Math.round(l.y)
    for (let y = Math.max(1, cy - R); y <= Math.min(H - 2, cy + R); y++) {
      for (let x = Math.max(1, cx - R); x <= Math.min(W - 2, cx + R); x++) {
        const i = y * W + x
        const d = Math.hypot(x - l.x, y - l.y) / (r * (1 + 0.6 * wet[i]))
        if (d < 1) prox[i] = Math.max(prox[i], 1 - d * d)
      }
    }
  }
  const slope = slopeField(e, W, H, kmPerCell)
  const farm = new Float32Array(W * H)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (prox[i] <= 0 || e[i] <= 0.003) continue
      const suit = ARABLE[biome[i]] ?? 0
      if (!suit) continue
      // 陡坡不开田，高原上少
      const flat = 1 - clamp((slope[i] - 0.004) / 0.012, 0, 1)
      const low = 1 - clamp((e[i] - 0.8) / 0.8, 0, 1)
      farm[i] = Math.min(1, prox[i] * 1.6) * suit * flat * low * (0.8 + 0.4 * wet[i])
    }
  }
  blur(farm, W, H, 1, 1)
  return farm
}
