// 首页封面图：pnpm plates → public/plates/{world,town}-{zh,en,ja}.webp（地名跟着语言，每种语言一套）
// 世界地图用等高线皮肤（topo），聚落地图用彩绘皮肤（color）取主城区
import { mkdirSync, writeFileSync } from 'node:fs'
import { createCanvas, DOMMatrix, ImageData, Path2D, type Canvas } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).Path2D = Path2D
;(globalThis as any).DOMMatrix = DOMMatrix
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }
const { generateWorld } = await import('../src/gen/world')
const { DEFAULT_PARAMS } = await import('../src/gen/types')
const { drawOverlays, fieldsFor } = await import('../src/render/atlas/index')
const { themeById } = await import('../src/render/atlas/styles')
const { smoothRivers } = await import('../src/render/rivers')
const { setLang } = await import('../src/i18n')
const { generateSettlement } = await import('../src/settlement/generate')
const { buildSettlementVector } = await import('../src/settlement/render')
const { DEFAULT_SETTLEMENT } = await import('../src/settlement/types')
const { bboxOf } = await import('../src/settlement/geom')

type Lang = 'zh' | 'en' | 'ja'
const LANGS: Lang[] = ['zh', 'en', 'ja']
const OUT = 'public/plates'
/** 与首页图版的尺寸一致 */
const W = 1200
const H = 752
const measurer = createCanvas(10, 10).getContext('2d') as any
const only = process.argv.slice(2)
const want = (k: string) => !only.length || only.includes(k)

function save(c: Canvas, name: string) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/${name}.webp`, c.toBuffer('image/webp', 82))
  console.log(name, c.width, 'x', c.height)
}

// —— 世界地图：只画图框里的地图（不要图廓、图题、图例、指北针），首页按卡片比例裁切时不会切到它们 ——
if (want('world')) {
  const w = generateWorld({ ...DEFAULT_PARAMS, seed: 'aurelia' })
  const rivers = smoothRivers(w)
  const theme = themeById('topo')
  const f = fieldsFor(w, 2)
  theme.prepare?.(f)
  const off = createCanvas(f.MW, f.MH)
  off.getContext('2d').putImageData(f.scan((p: any, o: any) => theme.pixel(p, o, f, { labels: true, contours: true, graticule: true })) as any, 0, 0)
  for (const lg of LANGS) {
    setLang(lg)
    const map = createCanvas(f.MW, f.MH)
    const ctx = map.getContext('2d') as any
    ctx.drawImage(off, 0, 0)
    // 图廓件画在一个空的裁剪区里（等于不画）；注记照常避让它们的位置
    drawOverlays(ctx, f, theme, rivers, { labels: true, contours: true, graticule: true }, (on) => {
      if (on) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, 0, 0, 0)
        ctx.clip()
      } else ctx.restore()
    })
    const k = Math.max(W / map.width, H / map.height)
    const c = createCanvas(W, H)
    c.getContext('2d').drawImage(map, (W - map.width * k) / 2, (H - map.height * k) / 2, map.width * k, map.height * k)
    save(c, `world-${lg}`)
  }
  setLang('zh')
}

// —— 聚落地图：主城区特写，四周留一点城郊 ——
if (want('town')) {
  const st = generateSettlement({ ...DEFAULT_SETTLEMENT, seed: 'vale', culture: 'western', coast: true, river: true, walls: 'stone', population: 9000 } as any)
  const inner = st.wards.filter((x: any) => x.inner)
  const [x0, y0, x1, y1] = bboxOf(inner.flatMap((x: any) => x.poly))
  const aspect = H / W
  const cw = Math.min(Math.max((x1 - x0) * 1.15, ((y1 - y0) * 1.15) / aspect), st.width, st.height / aspect)
  const ch = cw * aspect
  const cx = Math.min(Math.max((x0 + x1) / 2, cw / 2), st.width - cw / 2)
  const cy = Math.min(Math.max((y0 + y1) / 2, ch / 2), st.height - ch / 2)
  for (const lg of LANGS) {
    const list = buildSettlementVector(st, 'color', { labels: true, contours: true, lang: lg } as any, measurer)
    const S = list.MW / st.width
    const k = W / (cw * S)
    const c = createCanvas(W, H)
    list.render(c.getContext('2d') as any, k, -(list.M + (cx - cw / 2) * S) * k, -(list.M + (cy - ch / 2) * S) * k)
    save(c, `town-${lg}`)
  }
}
