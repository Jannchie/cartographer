// GitHub 横幅（README 头图与仓库社交预览，1280×640，JPEG 以满足社交预览 1 MB 上限）：npx tsx scripts/banner.ts [字体目录] → docs/images/banner.jpg
// 自然地理纸图满幅铺底，左侧压暗，放罗盘图标、标题与一行说明。字体目录里的 ttf/otf 会被注册（标题用 Cormorant Garamond）。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas, DOMMatrix, GlobalFonts, ImageData, loadImage, Path2D, type Canvas } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).Path2D = Path2D
;(globalThis as any).DOMMatrix = DOMMatrix
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }

const FONTS = process.argv[2]
if (FONTS && existsSync(FONTS)) for (const f of readdirSync(FONTS)) if (/\.(ttf|otf)$/i.test(f)) GlobalFonts.registerFromPath(join(FONTS, f))
const mono = `${process.env.LOCALAPPDATA}/Microsoft/Windows/Fonts/BerkeleyMono-Regular.otf`
if (existsSync(mono)) GlobalFonts.registerFromPath(mono, 'Banner Mono')

const { generateWorld } = await import('../src/gen/world')
const { DEFAULT_PARAMS } = await import('../src/gen/types')
const { renderAtlas } = await import('../src/render/atlas/index')
const { smoothRivers } = await import('../src/render/rivers')
const { setLang } = await import('../src/i18n')

const K = 2
const W = 1280 * K
const H = 640 * K
const PAPER = '#f2ecdf'

setLang('en')
const world = generateWorld({ ...DEFAULT_PARAMS, seed: 'aurelia' })
const S = 3
const full = renderAtlas(world, smoothRivers(world), 'physical', { labels: false, contours: true, graticule: true }, S) as unknown as Canvas
// 只取图框里的地图，裁成 2:1，避开角上的罗盘与图题；不标注记，免得和标题抢
const MW = world.W * S
const MH = world.H * S
const M = (full.width - MW) / 2
const cw = MW * 0.88
const ch = cw / 2
const cx = Math.min(Math.max(MW * 0.48, cw / 2), MW - cw / 2)
const cy = Math.min(Math.max(MH * 0.46, ch / 2), MH - ch / 2)

const out = createCanvas(W, H)
const g = out.getContext('2d')
g.drawImage(full as any, M + cx - cw / 2, M + cy - ch / 2, cw, ch, 0, 0, W, H)

// 左侧压暗：文字区近乎不透明，向右渐隐
const scrim = g.createLinearGradient(0, 0, W * 0.68, 0)
scrim.addColorStop(0, 'rgba(18, 15, 12, 0.88)')
scrim.addColorStop(0.5, 'rgba(18, 15, 12, 0.66)')
scrim.addColorStop(1, 'rgba(18, 15, 12, 0)')
g.fillStyle = scrim
g.fillRect(0, 0, W, H)

const x = 96 * K
const svg = readFileSync('public/favicon.svg', 'utf8')
const icon = await loadImage(Buffer.from(svg.replace('<svg ', `<svg width="${104 * K}" height="${104 * K}" `)))
g.drawImage(icon, x, 150 * K, 104 * K, 104 * K)

g.fillStyle = PAPER
g.shadowColor = 'rgba(0, 0, 0, 0.35)'
g.shadowBlur = 16 * K
g.font = `500 ${112 * K}px "Cormorant Garamond", Georgia, serif`
g.fillText('Cartographer', x - 6 * K, 384 * K)
g.shadowBlur = 0

g.font = `${22 * K}px "Banner Mono", Consolas, monospace`
g.fillStyle = 'rgba(242, 236, 223, 0.9)'
let tx = x
for (const ch of 'PROCEDURAL WORLDS AND TOWN PLANS FROM ONE SEED') {
  g.fillText(ch, tx, 446 * K)
  tx += g.measureText(ch).width + 4 * K
}

const small = createCanvas(W / K, H / K)
small.getContext('2d').drawImage(out as any, 0, 0, W / K, H / K)
writeFileSync('docs/images/banner.jpg', small.toBuffer('image/jpeg', 90))
console.log('docs/images/banner.jpg', W / K, 'x', H / K)
