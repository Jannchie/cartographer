// 离线渲染聚落地图：pnpm settlement:png <seed> <size> <style> <outDir> [key=value ...]
import { writeFileSync } from 'node:fs'
import { createCanvas, ImageData, Path2D, DOMMatrix } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).Path2D = Path2D
;(globalThis as any).DOMMatrix = DOMMatrix
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }
const { generateSettlement } = await import('../src/settlement/generate')
const { buildSettlementVector } = await import('../src/settlement/render')
const { DEFAULT_SETTLEMENT } = await import('../src/settlement/types')

const seed = process.argv[2] ?? DEFAULT_SETTLEMENT.seed
const size = (process.argv[3] ?? 'town') as any
const styles = (process.argv[4] ?? 'parchment').split(',')
const outDir = process.argv[5] ?? '.'
const extra: Record<string, unknown> = {}
for (const kv of process.argv.slice(6)) {
  const [k, v] = kv.split('=')
  extra[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v)
}
const t = performance.now()
const st = generateSettlement({ ...DEFAULT_SETTLEMENT, seed, size, ...extra })
console.log('gen', (performance.now() - t).toFixed(0), 'ms', st.stats, st.nameZh, st.name)
const measurer = createCanvas(10, 10).getContext('2d') as any
for (const s of styles) {
  const t1 = performance.now()
  const list = buildSettlementVector(st, s as any, { labels: true, contours: true }, measurer)
  const scale = Number(extra.scale ?? 1)
  const c = createCanvas(Math.round(list.width * scale), Math.round(list.height * scale))
  list.render(c.getContext('2d') as any, scale, 0, 0)
  const crop = extra.crop ? String(extra.crop).split(',').map(Number) : null
  let out: any = c
  if (crop) {
    const [x, y, w, h] = crop
    out = createCanvas(w, h)
    out.getContext('2d').drawImage(c, x, y, w, h, 0, 0, w, h)
  }
  writeFileSync(`${outDir}/settle-${seed}-${size}-${s}${crop ? '-crop' : ''}.png`, out.toBuffer('image/png'))
  console.log(s, (performance.now() - t1).toFixed(0), 'ms', list.segments.reduce((n, g) => n + g.items.length, 0), 'items')
}
