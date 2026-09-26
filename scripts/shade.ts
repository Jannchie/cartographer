import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { generateWorld, TUNE } from '../src/gen/world'
import { DEFAULT_PARAMS } from '../src/gen/types'
const seed = process.argv[2] ?? DEFAULT_PARAMS.seed
const extra = JSON.parse(process.argv[4] ?? '{}')
Object.assign(TUNE, JSON.parse(process.argv[5] ?? '{}'))
const w = generateWorld({ ...DEFAULT_PARAMS, seed, ...extra })
const { W, H, elevation: e } = w
const png = new PNG({ width: W, height: H })
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x
  const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(H - 1, y + 1)
  const gx = (Math.max(0, e[y * W + xp]) - Math.max(0, e[y * W + xm])) / (2 * w.kmPerCell) * 12
  const gy = (Math.max(0, e[yp * W + x]) - Math.max(0, e[ym * W + x])) / (2 * w.kmPerCell) * 12
  const l = Math.hypot(gx, gy, 1)
  const s = Math.max(0, (-gx * -0.6 + -gy * -0.6 + 0.53) / l / 0.53)
  const h = e[i]
  let r, g, b
  if (h <= 0) { r = 30; g = 50 + 40 * Math.exp(h); b = 90 + 80 * Math.exp(h * 2) }
  else { const t = Math.min(1, h / 4); r = (120 + 120 * t) * s; g = (140 + 90 * t) * s; b = (100 + 110 * t) * s }
  if (w.biome[i] === 1) { r = 60; g = 110; b = 180 }
  png.data[i * 4] = Math.min(255, r); png.data[i * 4 + 1] = Math.min(255, g); png.data[i * 4 + 2] = Math.min(255, b); png.data[i * 4 + 3] = 255
}
writeFileSync(process.argv[3], PNG.sync.write(png))
console.log(w.stats)
