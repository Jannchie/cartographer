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
const { POP_OF_SIZE } = await import('../src/settlement/scale')

const seed = process.argv[2] ?? DEFAULT_SETTLEMENT.seed
const size = (process.argv[3] ?? 'town') as any
const styles = (process.argv[4] ?? 'parchment').split(',')
const outDir = process.argv[5] ?? '.'
const extra: Record<string, unknown> = {}
for (const kv of process.argv.slice(6)) {
  const [k, v] = kv.split('=')
  extra[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v)
}
// 显示选项不进生成参数：view=zoning 出区划图，hidden=类,类 关掉区划图里这些类的着色
const view = extra.view === 'zoning' ? 'zoning' : 'map'
const hidden = extra.hidden ? String(extra.hidden).split(',') : undefined
delete extra.view
delete extra.hidden
const t = performance.now()
const st = generateSettlement({ ...DEFAULT_SETTLEMENT, seed, size, population: POP_OF_SIZE[size as keyof typeof POP_OF_SIZE] ?? 4000, ...extra })
console.log('gen', (performance.now() - t).toFixed(0), 'ms', st.stats, st.nameZh, st.name, st.nameJa)
const measurer = createCanvas(10, 10).getContext('2d') as any
for (const s of styles) {
  const t1 = performance.now()
  const list = buildSettlementVector(st, s as any, { labels: true, contours: true, lang: (extra.lang as any) ?? 'zh', view, hidden: hidden as any }, measurer)
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
  writeFileSync(`${outDir}/settle-${seed}-${size}-${s}${extra.lang ? `-${extra.lang}` : ''}${view === 'zoning' ? '-zoning' : ''}${crop ? '-crop' : ''}.png`, out.toBuffer('image/png'))
  console.log(s, (performance.now() - t1).toFixed(0), 'ms', list.segments.reduce((n, g) => n + g.items.length, 0), 'items')
}
