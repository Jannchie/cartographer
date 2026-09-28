import { Biome, type Label, type World } from '../gen/types'
import { resolveNaming } from '../gen/naming'
import type { SettlementParams } from './types'

/**
 * 从世界地图上的一座城镇推断聚落环境：名字、规模、河流与来向、海的方向、山地、气候。
 */
export function fromWorld(w: World, l: Label): Partial<SettlementParams> {
  const { W, H } = w
  const x = Math.min(W - 2, Math.max(1, Math.round(l.x)))
  const y = Math.min(H - 2, Math.max(1, Math.round(l.y)))
  const i = y * W + x
  // 在全部城镇中的重要度排名（0 最低，1 最高）
  const cities = w.labels.filter((c) => c.kind === 'city')
  const rank = cities.length ? cities.filter((c) => c.weight < l.weight).length / cities.length : 0.5
  const out: Partial<SettlementParams> = {
    seed: `${w.params.seed}-${l.name.toLowerCase()}`,
    name: l.name,
    nameZh: l.zh,
    nameJa: l.ja,
    // 人口：都城约一万五，其余按重要度在几百到几千之间
    population: l.kind === 'capital' ? 15000 : Math.round(Math.exp(Math.log(300) + rank * (Math.log(9000) - Math.log(300))) / 10) * 10,
    climate: { temp: w.temperature[i], rain: w.precipitation[i], biome: w.biome[i] },
    capital: l.kind === 'capital',
  }
  // 文明跟着世界的命名世界观：汉字地名的世界是东方，日本地名的是和风，其余是西方
  const naming = resolveNaming(w.params)
  if (naming === 'eastern' || naming === 'wa') out.culture = naming
  else out.culture = 'western'
  // 海：到海岸距离小；海在距离下降的方向
  const cd = w.coastDist
  out.coast = cd[i] < 3
  if (out.coast) {
    const gx = cd[i + 1] - cd[i - 1]
    const gy = cd[i + W] - cd[i - W]
    out.coastDir = Math.atan2(-gy, -gx)
  } else out.coastDir = NaN
  // 河：附近有河道点
  let best = Infinity
  let dir = NaN
  for (const r of w.rivers) {
    const pts = r.points
    for (let k = 0; k + 1 < pts.length / 2; k++) {
      const d = Math.hypot(pts[k * 2] - l.x, pts[k * 2 + 1] - l.y)
      if (d < best && r.flow[k] > 2) {
        best = d
        // 上游方向（河道点由源头流向河口）
        const k0 = Math.max(0, k - 3)
        dir = Math.atan2(pts[k0 * 2 + 1] - pts[k * 2 + 1], pts[k0 * 2] - pts[k * 2])
      }
    }
  }
  out.river = best < 2.5
  out.riverDir = out.river && Number.isFinite(dir) ? dir : NaN
  // 山：周围 5 格内的最高点明显高于城
  let hx = 0
  let hy = 0
  let hmax = w.elevation[i]
  let sum = 0
  let n = 0
  for (let dy = -5; dy <= 5; dy++)
    for (let dx = -5; dx <= 5; dx++) {
      const xx = x + dx
      const yy = y + dy
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
      const e = w.elevation[yy * W + xx]
      if (e > 0) {
        sum += Math.abs(e - w.elevation[i])
        n++
      }
      if (e > hmax) {
        hmax = e
        hx = dx
        hy = dy
      }
    }
  out.hills = hmax - w.elevation[i] > 0.25
  out.hillDir = out.hills ? Math.atan2(hy, hx) : NaN
  out.relief = Math.min(1, Math.max(0.1, (sum / Math.max(1, n)) * 2.5))
  const b = w.biome[i]
  out.farms = b !== Biome.IceCap && b !== Biome.Tundra
  return out
}
