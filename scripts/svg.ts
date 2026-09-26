// 离线导出矢量纸图
import { writeFileSync } from 'node:fs'
import { createCanvas, ImageData } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }
const { generateWorld } = await import('../src/gen/world')
const { DEFAULT_PARAMS } = await import('../src/gen/types')
const { renderAtlasSvg } = await import('../src/render/atlas/svg/vector')
const { smoothRivers } = await import('../src/render/rivers')

const seed = process.argv[2] ?? DEFAULT_PARAMS.seed
const styles = (process.argv[3] ?? 'physical').split(',')
const outDir = process.argv[4] ?? '.'
const w = generateWorld({ ...DEFAULT_PARAMS, seed })
const rivers = smoothRivers(w)
const measurer = createCanvas(10, 10).getContext('2d') as any
for (const s of styles) {
  const t = performance.now()
  const svg = renderAtlasSvg(w, rivers, s as any, { labels: true, contours: true, graticule: true }, measurer, 2)
  writeFileSync(`${outDir}/atlas-${s}.svg`, svg)
  console.log(s, (performance.now() - t).toFixed(0), 'ms', (svg.length / 1e6).toFixed(2), 'MB')
}
