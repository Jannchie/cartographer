/**
 * 生成地球底图资产 src/gen/earth/data.ts（地球预设用）。
 * 数据：NOAA ETOPO1（冰面版，含海深），经 CoastWatch ERDDAP 按 0.25° 取样：
 *   curl -o etopo.csv "https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.csv?altitude%5B(-90):15:(90)%5D%5B(-180):15:(180)%5D"
 *   pnpm tsx scripts/earth.ts etopo.csv
 * 输出 720 × 360 的 0.5° 网格（格心在 89.75°N、179.75°W 起），每格取周围 3 × 3 个 0.25° 采样按 [1, 2, 1] 加权平均。
 * 存法：高程以 10 米为单位取整成 int16，逐行差分后 gzip，再转 base64 写成模块（浏览器与 Node 都能动态 import）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const src = process.argv[2]
if (!src) throw new Error('用法：tsx scripts/earth.ts etopo.csv')
const QW = 1441
const QH = 721
const q = new Float32Array(QW * QH)
let n = 0
for (const line of readFileSync(src, 'utf8').split('\n')) {
  const f = line.split(',')
  if (f.length !== 3) continue
  const lat = Number(f[0])
  const lon = Number(f[1])
  const alt = Number(f[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) continue
  const j = Math.round((lat + 90) * 4)
  const i = Math.round((lon + 180) * 4)
  q[j * QW + i] = alt
  n++
}
if (n !== QW * QH) throw new Error(`采样数不对：${n}，应为 ${QW * QH}`)

const W = 720
const H = 360
const at = (i: number, j: number) => q[Math.min(QH - 1, Math.max(0, j)) * QW + ((i + QW - 1) % (QW - 1))]
const grid = new Int16Array(W * H)
for (let y = 0; y < H; y++) {
  // 0.5° 格心：纬度 89.75 − 0.5y，对应 0.25° 采样的行号
  const j = Math.round((89.75 - 0.5 * y + 90) * 4)
  for (let x = 0; x < W; x++) {
    const i = Math.round((-179.75 + 0.5 * x + 180) * 4)
    let s = 0
    let w = 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const k = (2 - Math.abs(dx)) * (2 - Math.abs(dy))
        s += at(i + dx, j + dy) * k
        w += k
      }
    grid[y * W + x] = Math.round(s / w / 10)
  }
}
// 逐行差分：相邻格高程接近，差值小，压缩得更好
const delta = new Int16Array(W * H)
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const k = y * W + x
    delta[k] = x ? grid[k] - grid[k - 1] : grid[k]
  }
const gz = gzipSync(Buffer.from(delta.buffer), { level: 9 })
const b64 = gz.toString('base64')
writeFileSync(
  'src/gen/earth/data.ts',
  `// 由 scripts/earth.ts 生成，勿手改。NOAA ETOPO1（冰面版）0.5° 网格：${W} × ${H}，单位 10 米，逐行差分后 gzip 再 base64\n` +
    `export const EARTH_W = ${W}\nexport const EARTH_H = ${H}\nexport const EARTH_DATA =\n  '${b64}'\n`,
)
console.log(`gzip ${(gz.length / 1024).toFixed(0)} KB, base64 ${(b64.length / 1024).toFixed(0)} KB`)
