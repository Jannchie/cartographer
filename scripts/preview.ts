// 离线预览：node 下跑完整生成流水线，输出简易 PNG 与统计，便于调参
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { generateWorld } from '../src/gen/world'
import { DEFAULT_PARAMS, Biome } from '../src/gen/types'

const seed = process.argv[2] ?? DEFAULT_PARAMS.seed
const out = process.argv[3] ?? 'preview.png'
let last = performance.now()
let lastStage = ''
const w = generateWorld({ ...DEFAULT_PARAMS, seed }, (stage) => {
  if (stage !== lastStage) {
    const now = performance.now()
    if (lastStage) console.log(`${lastStage}: ${(now - last).toFixed(0)}ms`)
    last = now
    lastStage = stage
  }
})
console.log(w.stats, w.worldName)
const { W, H, elevation: e } = w
const q = (arr: Float32Array, f: (i: number) => boolean) => {
  const v: number[] = []
  for (let i = 0; i < arr.length; i++) if (f(i)) v.push(arr[i])
  v.sort((a, b) => a - b)
  return [0.05, 0.25, 0.5, 0.75, 0.95, 0.99].map((t) => v[Math.floor(t * (v.length - 1))]?.toFixed(2))
}
console.log('land elev q', q(e, (i) => e[i] > 0))
console.log('precip q', q(w.precipitation, (i) => e[i] > 0))
console.log('temp q', q(w.temperature, (i) => e[i] > 0))
const counts: Record<number, number> = {}
for (const b of w.biome) counts[b] = (counts[b] ?? 0) + 1
console.log('biomes', counts)
console.log('labels', w.labels.map((l) => `${l.kind}:${l.name}`).join(', '))

const col: Record<number, [number, number, number]> = {
  [Biome.Ocean]: [40, 70, 120],
  [Biome.Lake]: [60, 110, 170],
  [Biome.IceCap]: [240, 245, 250],
  [Biome.Tundra]: [160, 165, 140],
  [Biome.Taiga]: [60, 95, 70],
  [Biome.TemperateForest]: [70, 120, 60],
  [Biome.TemperateRainforest]: [40, 100, 60],
  [Biome.Grassland]: [150, 170, 90],
  [Biome.Shrubland]: [160, 150, 100],
  [Biome.ColdDesert]: [180, 170, 140],
  [Biome.HotDesert]: [220, 195, 140],
  [Biome.Savanna]: [175, 170, 80],
  [Biome.TropicalSeasonalForest]: [90, 140, 50],
  [Biome.TropicalRainforest]: [30, 110, 40],
  [Biome.Alpine]: [140, 130, 120],
  [Biome.Beach]: [230, 215, 170],
  [Biome.Wetland]: [80, 120, 100],
  [Biome.SaltFlat]: [230, 225, 215],
}
const png = new PNG({ width: W, height: H })
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x
    const [r, g, b] = col[w.biome[i]]
    const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1)
    const ym = Math.max(0, y - 1), yp = Math.min(H - 1, y + 1)
    const gx = (Math.max(0, e[y * W + xp]) - Math.max(0, e[y * W + xm])) * 3
    const gy = (Math.max(0, e[yp * W + x]) - Math.max(0, e[ym * W + x])) * 3
    const shade = e[i] > 0 ? Math.max(0.35, Math.min(1.3, 1 + (-gx + -gy) * 0.35)) : 1 + e[i] * 0.1
    png.data[i * 4] = Math.min(255, r * shade)
    png.data[i * 4 + 1] = Math.min(255, g * shade)
    png.data[i * 4 + 2] = Math.min(255, b * shade)
    png.data[i * 4 + 3] = 255
  }
}
for (const rv of w.rivers) {
  for (let k = 0; k < rv.points.length / 2; k++) {
    const x = Math.floor(rv.points[k * 2]), y = Math.floor(rv.points[k * 2 + 1])
    const i = (y * W + x) * 4
    png.data[i] = 50; png.data[i + 1] = 100; png.data[i + 2] = 200
  }
}
writeFileSync(out, PNG.sync.write(png))
console.log('wrote', out)
