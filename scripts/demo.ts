// 30 秒演示视频（1920×1080，30 fps）：npx tsx scripts/demo.ts <out.mp4> [frames3d 目录] [字体目录]
// 地图镜头逐帧离线渲染；3D 航拍用浏览器里逐帧截下的 JPEG（目录里 0000.jpg…，旁边 meta.json 记着每帧的淡出量）。
// 原始像素直接喂给 ffmpeg，需要系统里有 ffmpeg。
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas, DOMMatrix, GlobalFonts, ImageData, loadImage, Path2D, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).Path2D = Path2D
;(globalThis as any).DOMMatrix = DOMMatrix
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }

const OUT = process.argv[2] ?? 'demo.mp4'
const FRAMES3D = process.argv[3]
const FONTS = process.argv[4]
// 地图与字幕用的字体：给了目录就注册（文件名随意，按字体里的族名注册）
if (FONTS && existsSync(FONTS)) for (const f of readdirSync(FONTS)) if (/\.(ttf|otf)$/i.test(f)) GlobalFonts.registerFromPath(join(FONTS, f))
for (const [file, alias] of [
  ['C:/Windows/Fonts/GeorgiaPro-Light.ttf', 'Georgia Pro Light'],
  [`${process.env.LOCALAPPDATA}/Microsoft/Windows/Fonts/BerkeleyMono-Regular.otf`, 'Demo Mono'],
] as const)
  if (existsSync(file)) GlobalFonts.registerFromPath(file, alias)

const { generateWorld } = await import('../src/gen/world')
const { DEFAULT_PARAMS } = await import('../src/gen/types')
const { renderAtlas } = await import('../src/render/atlas/index')
const { smoothRivers } = await import('../src/render/rivers')
const { setLang } = await import('../src/i18n')
const { generateSettlement } = await import('../src/settlement/generate')
const { buildSettlementVector } = await import('../src/settlement/render')
const { DEFAULT_SETTLEMENT } = await import('../src/settlement/types')
const { bboxOf } = await import('../src/settlement/geom')

type P = [number, number]
const W = 1920
const H = 1080
const FPS = 30
const PAPER = '#f2ecdf'
const ACCENT = '#6f9c8f'
const measurer = createCanvas(10, 10).getContext('2d') as any
setLang('en')

// —— 素材 ——

const sizeOf = (pop: number) => (pop < 400 ? 'hamlet' : pop < 3000 ? 'village' : pop < 9000 ? 'town' : 'city')
const settle = (p: Record<string, unknown>) => generateSettlement({ ...DEFAULT_SETTLEMENT, size: sizeOf(p.population as number), ...p } as any)
const cityBox = (st: any) => bboxOf(st.wards.filter((w: any) => w.inner).flatMap((w: any) => w.poly))

/** 聚落图的一块（世界坐标中心 c、宽 w 米，16:9），按 outW 像素宽渲染 */
function settleShot(st: any, style: string, c: P, w: number, outW: number, opts: Record<string, unknown> = {}): Canvas {
  const list = buildSettlementVector(st, style as any, { labels: true, contours: true, lang: 'en', ...opts } as any, measurer)
  const S = list.MW / st.width
  const k = outW / (w * S)
  const cv = createCanvas(outW, Math.round((outW * H) / W))
  const g = cv.getContext('2d')
  g.fillStyle = PAPER
  g.fillRect(0, 0, cv.width, cv.height)
  list.render(g as any, k, -(list.M + c[0] * S) * k + outW / 2, -(list.M + c[1] * S) * k + cv.height / 2)
  return cv
}
/** 取景：包住城区、留边，按 16:9 补齐，不出图幅 */
function frameCity(st: any, pad: number): { c: P; w: number } {
  const [x0, y0, x1, y1] = cityBox(st)
  const w = Math.min(Math.max((x1 - x0) * pad, ((y1 - y0) * pad * W) / H, 240), st.width, (st.height * W) / H)
  const h = (w * H) / W
  const cx = Math.min(Math.max((x0 + x1) / 2, w / 2), st.width - w / 2)
  const cy = Math.min(Math.max((y0 + y1) / 2, h / 2), st.height - h / 2)
  return { c: [cx, cy], w }
}

console.log('world…')
const world = generateWorld({ ...DEFAULT_PARAMS, seed: 'aurelia' })
const rivers = smoothRivers(world)
const atlas = (s: string, S: number) => renderAtlas(world, rivers, s as any, { labels: true, contours: true, graticule: true }, S) as unknown as Canvas
const physical = atlas('physical', 3)
const STYLES: [string, string][] = [
  ['fantasy', 'Fantasy'],
  ['nautical', 'Nautical'],
  ['teyvat', 'Teyvat'],
  ['ink', 'Ink wash'],
  ['topo', 'Topographic'],
]
const styleShots = STYLES.map(([id, name]) => ({ name, img: atlas(id, 2) }))

console.log('cultures…')
const CULTURES: [string, string, Record<string, unknown>][] = [
  ['Western', 'Organic harbour town', { seed: 'vale', culture: 'western', coast: true, walls: 'stone', population: 9000 }],
  ['Chinese', 'Walled-ward capital', { seed: 'chang', culture: 'eastern', plan: 'lifang', capital: true, planStrength: 0.8, population: 13000 }],
  ['Japanese', 'Castle town', { seed: 'kaga', culture: 'wa', plan: 'jokamachi', river: true, hills: true, population: 14000 }],
  ['Islamic', 'Medina', { seed: 'qasr', culture: 'islamic', plan: 'medina', hills: true, population: 12000 }],
]
const cultureShots = CULTURES.map(([name, sub, p]) => {
  const st = settle(p)
  const f = frameCity(st, 1.2)
  return { name, sub, img: settleShot(st, 'color', f.c, f.w, 3000) }
})

console.log('skins…')
const skinTown = settle({ seed: 'thornwick', culture: 'western', coast: true, walls: 'stone', population: 5000 })
const skinFrame = frameCity(skinTown, 0.75)
const SKINS: [string, string][] = [
  ['parchment', 'Parchment'],
  ['color', 'Colour'],
  ['ink', 'Engraving'],
  ['blueprint', 'Blueprint'],
  ['kiriezu', 'Kiriezu'],
  ['nolli', 'Nolli plan'],
  ['fangzhi', 'Gazetteer'],
  ['survey', 'Survey'],
]
const skinShots = SKINS.map(([id, name]) => ({ name, img: settleShot(skinTown, id, skinFrame.c, skinFrame.w, W) }))

console.log('growth…')
// 同一个种子逐步加人口；镜头以最终城区为准，图幅还小的时候按图幅收（看起来是镜头随城拉远）
const GROW = 30
const growPops = Array.from({ length: GROW }, (_, i) => Math.round(Math.exp(Math.log(300) + ((Math.log(22000) - Math.log(300)) * i) / (GROW - 1))))
const growBase = { seed: 'grow', culture: 'western', river: true, hills: true }
const finalSt = settle({ ...growBase, population: growPops[GROW - 1] })
const finalF = frameCity(finalSt, 1.1)
const off: P = [finalF.c[0] - finalSt.width / 2, finalF.c[1] - finalSt.height / 2]
const growShots = growPops.map((pop) => {
  const st = settle({ ...growBase, population: pop })
  const w = Math.min(finalF.w, st.width, (st.height * W) / H)
  const h = (w * H) / W
  const c: P = [Math.min(Math.max(st.width / 2 + off[0], w / 2), st.width - w / 2), Math.min(Math.max(st.height / 2 + off[1], h / 2), st.height - h / 2)]
  return { pop: st.stats.population as number, img: settleShot(st, 'parchment', c, w, W) }
})

// 3D 航拍帧
const frames3d = FRAMES3D && existsSync(FRAMES3D) ? readdirSync(FRAMES3D).filter((f) => f.endsWith('.jpg')).sort() : []
const fades: number[] = FRAMES3D && existsSync(join(FRAMES3D, '..', 'meta.json')) ? JSON.parse(readFileSync(join(FRAMES3D, '..', 'meta.json'), 'utf8')).fades : []
console.log('3d frames', frames3d.length)

// —— 画面 ——

const out = createCanvas(W, H)
const layer = createCanvas(W, H)
const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t))

/** 把 src 按 cover 铺满画面，再推近 zoom 倍（以 (fx, fy) 比例位置为中心） */
function cover(g: SKRSContext2D, src: Canvas | Image, zoom = 1, fx = 0.5, fy = 0.5, alpha = 1) {
  const s = Math.max(W / src.width, H / src.height) * zoom
  const sw = W / s
  const sh = H / s
  const sx = Math.min(Math.max(src.width * fx - sw / 2, 0), src.width - sw)
  const sy = Math.min(Math.max(src.height * fy - sh / 2, 0), src.height - sh)
  g.globalAlpha = alpha
  g.drawImage(src as any, sx, sy, sw, sh, 0, 0, W, H)
  g.globalAlpha = 1
}

/** 逐字排（带字距） */
function spaced(g: SKRSContext2D, s: string, x: number, y: number, track: number) {
  for (const ch of s) {
    g.fillText(ch, x, y)
    x += g.measureText(ch).width + track
  }
}

/** 字幕：底部渐暗遮罩，左下角一行等宽小标签（前面一小段铜绿短线）加大标题；t 是字幕出现后的秒数（淡入并上移） */
function caption(g: SKRSContext2D, kicker: string, title: string, t: number) {
  const scrim = g.createLinearGradient(0, H * 0.5, 0, H)
  scrim.addColorStop(0, 'rgba(18, 15, 12, 0)')
  scrim.addColorStop(0.55, 'rgba(18, 15, 12, 0.42)')
  scrim.addColorStop(1, 'rgba(18, 15, 12, 0.78)')
  g.fillStyle = scrim
  g.fillRect(0, H * 0.5, W, H * 0.5)
  const a = ease(t / 0.35)
  const dy = (1 - a) * 14
  const x = 112
  g.globalAlpha = a
  g.fillStyle = ACCENT
  g.fillRect(x, H - 195 + dy, 44, 4)
  g.font = '22px "Demo Mono", Consolas, monospace'
  g.fillStyle = 'rgba(242, 236, 223, 0.92)'
  spaced(g, kicker.toUpperCase(), x + 64, H - 186 + dy, 5)
  g.font = '500 92px "Cormorant Garamond", "Georgia Pro Light", Georgia, serif'
  g.fillStyle = PAPER
  g.shadowColor = 'rgba(0, 0, 0, 0.35)'
  g.shadowBlur = 18
  g.fillText(title, x - 4, H - 96 + dy)
  g.shadowBlur = 0
  g.globalAlpha = 1
}

/** 一组镜头依次交叉淡入：每张 dur 秒、淡入 fade 秒；zoom(u) 是自身时段 u∈[0,1] 的推近倍数 */
function sequence(g: SKRSContext2D, t: number, items: { img: Canvas }[], dur: number, fade: number, zoom: (u: number) => number) {
  const i = Math.min(items.length - 1, Math.floor(t / dur))
  const lt = t - i * dur
  if (i > 0 && lt < fade) cover(g, items[i - 1].img, zoom(1 + lt / dur))
  cover(g, items[i].img, zoom(lt / dur), 0.5, 0.5, i > 0 ? ease(lt / fade) : 1)
  return { i, lt }
}

type Scene = { d: number; draw: (g: SKRSContext2D, t: number) => void | Promise<void> }
const img3d = new Map<number, Image>()
const scenes: Scene[] = []
if (frames3d.length) {
  const n = Math.min(frames3d.length, 270)
  scenes.push({
    d: n / FPS,
    draw: async (g, t) => {
      const f = Math.min(n - 1, Math.round(t * FPS))
      let im = img3d.get(f)
      if (!im) {
        im = await loadImage(readFileSync(join(FRAMES3D!, frames3d[f])))
        img3d.clear()
        img3d.set(f, im)
      }
      cover(g, im)
      // 运镜切镜时的黑场
      const k = fades[f] ?? 0
      if (k > 0) (g.fillStyle = `rgba(0, 0, 0, ${k})`), g.fillRect(0, 0, W, H)
      caption(g, 'Cartographer', 'A whole world from one seed', t - 0.6)
    },
  })
}
scenes.push(
  {
    d: 3,
    draw: (g, t) => {
      cover(g, physical, 1.05 + 0.3 * ease(t / 3), 0.46, 0.5)
      caption(g, 'Plates · erosion · climate · rivers', 'Continents with a history', t - 0.3)
    },
  },
  {
    d: 3,
    draw: (g, t) => {
      const { i, lt } = sequence(g, t, styleShots, 0.6, 0.18, (u) => 1.1 + 0.06 * u)
      caption(g, 'Six paper-map styles', styleShots[i].name, i === 0 ? lt : 1)
    },
  },
  {
    d: 2.5,
    draw: (g, t) => {
      const k = Math.min(growShots.length - 1, Math.floor(ease(t / 2.3) * growShots.length))
      cover(g, growShots[k].img)
      caption(g, `${growShots[k].pop.toLocaleString('en')} people`, 'Towns grow', t)
    },
  },
  {
    d: 7.5,
    draw: (g, t) => {
      const { i, lt } = sequence(g, t, cultureShots, 7.5 / 4, 0.35, (u) => 1.02 + 0.16 * u)
      caption(g, cultureShots[i].sub, cultureShots[i].name, lt)
    },
  },
  {
    d: 5,
    draw: (g, t) => {
      const { i } = sequence(g, t, skinShots, 5 / skinShots.length, 0.12, (u) => 1 + 0.04 * u)
      caption(g, 'Eight skins', skinShots[i].name, t)
    },
  },
)

// —— 编码 ——

const X = 0.3
const total = scenes.reduce((s, x) => s + x.d, 0)
const frames = Math.round(total * FPS)
console.log(`encoding ${frames} frames (${total.toFixed(1)}s) → ${OUT}`)
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] })
const write = (buf: Buffer) => new Promise<void>((res) => (ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res)))
const g = out.getContext('2d')
const lg = layer.getContext('2d')
for (let f = 0; f < frames; f++) {
  let t = f / FPS
  let sc = 0
  while (sc < scenes.length - 1 && t >= scenes[sc].d) t -= scenes[sc++].d
  // 段落之间溶解：新段落的前 X 秒压在上一段的末帧上
  if (sc > 0 && t < X) {
    await scenes[sc - 1].draw(g, scenes[sc - 1].d - 1 / FPS)
    await scenes[sc].draw(lg, t)
    g.globalAlpha = ease(t / X)
    g.drawImage(layer as any, 0, 0)
    g.globalAlpha = 1
  } else await scenes[sc].draw(g, t)
  await write(Buffer.from(g.getImageData(0, 0, W, H).data.buffer))
}
ff.stdin.end()
await new Promise((res) => ff.on('close', res))
console.log('done', OUT)
