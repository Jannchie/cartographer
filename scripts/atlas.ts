// 离线渲染纸质地图：node 下用 @napi-rs/canvas 模拟浏览器 Canvas
import { writeFileSync } from 'node:fs'
import { createCanvas, ImageData } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }
const { generateWorld } = await import('../src/gen/world')
const { DEFAULT_PARAMS } = await import('../src/gen/types')
const { renderAtlas } = await import('../src/render/atlas/index')
const { smoothRivers } = await import('../src/render/rivers')

const seed = process.argv[2] ?? DEFAULT_PARAMS.seed
const styles = (process.argv[3] ?? 'physical').split(',')
const outDir = process.argv[4] ?? '.'
const crop = process.argv[5] ? process.argv[5].split(',').map(Number) : null
const w = generateWorld({ ...DEFAULT_PARAMS, seed })
const rivers = smoothRivers(w)
for (const s of styles) {
  const t = performance.now()
  const c = renderAtlas(w, rivers, s as any, { labels: true, contours: true, graticule: true }, 2) as any
  let out = c
  if (crop) {
    const [x, y, cw, ch] = crop
    out = createCanvas(cw, ch)
    out.getContext('2d').drawImage(c, x, y, cw, ch, 0, 0, cw, ch)
  } else {
    // 缩到一半便于查看
    out = createCanvas(c.width / 2, c.height / 2)
    out.getContext('2d').drawImage(c, 0, 0, c.width / 2, c.height / 2)
  }
  writeFileSync(`${outDir}/atlas-${s}${crop ? '-crop' : ''}.png`, out.toBuffer('image/png'))
  console.log(s, (performance.now() - t).toFixed(0), 'ms')
}
