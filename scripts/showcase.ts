// README 配图：pnpm showcase → docs/images/*.webp
// 世界纸图的各风格、聚落的四种文明、八种皮肤、区划视图、成长序列与几处地标特写
import { mkdirSync, writeFileSync } from 'node:fs'
import { createCanvas, DOMMatrix, ImageData, Path2D, type Canvas } from '@napi-rs/canvas'
;(globalThis as any).ImageData = ImageData
;(globalThis as any).Path2D = Path2D
;(globalThis as any).DOMMatrix = DOMMatrix
;(globalThis as any).document = { createElement: () => createCanvas(1, 1) }
const { generateWorld } = await import('../src/gen/world')
const { DEFAULT_PARAMS } = await import('../src/gen/types')
const { renderAtlas } = await import('../src/render/atlas/index')
const { smoothRivers } = await import('../src/render/rivers')
const { generateSettlement } = await import('../src/settlement/generate')
const { buildSettlementVector } = await import('../src/settlement/render')
const { DEFAULT_SETTLEMENT } = await import('../src/settlement/types')
const { POP_OF_SIZE } = await import('../src/settlement/scale')
const { tierTrace } = await import('../src/settlement/tiers')
const { traceParks } = await import('../src/settlement/parks')
const { centroid, area } = await import('../src/settlement/geom')

type P = [number, number]
const OUT = process.argv[2] ?? 'docs/images'
mkdirSync(OUT, { recursive: true })
const measurer = createCanvas(10, 10).getContext('2d') as any
const only = process.argv.slice(3)
const want = (k: string) => !only.length || only.includes(k)

function save(c: Canvas, name: string, q = 80) {
  writeFileSync(`${OUT}/${name}.webp`, c.toBuffer('image/webp', q))
  console.log(name, c.width, 'x', c.height)
}

function settle(p: Record<string, unknown>) {
  const size = (p.size as string) ?? 'city'
  return generateSettlement({ ...DEFAULT_SETTLEMENT, population: POP_OF_SIZE[size as keyof typeof POP_OF_SIZE], ...p } as any)
}

/** 整张聚落图（crop 为空）或以世界坐标 c 为中心、宽 w 米的一块；输出宽 outW 像素，高按 aspect */
function draw(st: any, style: string, outW: number, crop?: { c: P; w: number; aspect?: number }, opts: Record<string, unknown> = {}): Canvas {
  const list = buildSettlementVector(st, style as any, { labels: true, contours: true, lang: 'zh', ...opts } as any, measurer)
  if (!crop) {
    const k = outW / list.width
    const c = createCanvas(outW, Math.round(list.height * k))
    list.render(c.getContext('2d') as any, k, 0, 0)
    return c
  }
  const S = list.MW / st.width
  const pw = crop.w * S
  const ph = pw * (crop.aspect ?? 0.7)
  const x0 = list.M + crop.c[0] * S - pw / 2
  const y0 = list.M + crop.c[1] * S - ph / 2
  const k = outW / pw
  const c = createCanvas(outW, Math.round(ph * k))
  list.render(c.getContext('2d') as any, k, -x0 * k, -y0 * k)
  return c
}

// —— 世界纸图 ——
if (want('world')) {
  const w = generateWorld({ ...DEFAULT_PARAMS, seed: 'aurelia' })
  const rivers = smoothRivers(w)
  for (const [s, W] of [['physical', 1600], ['fantasy', 800], ['nautical', 800], ['teyvat', 800], ['ink', 800], ['topo', 800]] as const) {
    const full = renderAtlas(w, rivers, s as any, { labels: true, contours: true, graticule: true }, 2) as any
    const c = createCanvas(W, Math.round((full.height * W) / full.width))
    c.getContext('2d').drawImage(full, 0, 0, c.width, c.height)
    save(c, `world-${s}`)
  }
}

// —— 四种文明（各配自己的形制） ——
if (want('cultures')) {
  const cases: [string, Record<string, unknown>][] = [
    ['western', { seed: 'vale', culture: 'western', coast: true, walls: 'stone', population: 9000 }],
    ['eastern', { seed: 'chang', culture: 'eastern', plan: 'lifang', capital: true, planStrength: 0.8, population: 13000 }],
    ['wa', { seed: 'kaga', culture: 'wa', plan: 'jokamachi', river: true, hills: true, population: 14000 }],
    ['islamic', { seed: 'qasr', culture: 'islamic', plan: 'medina', hills: true, population: 12000 }],
  ]
  for (const [id, p] of cases) save(draw(settle(p), 'color', 900), `settlement-${id}`)
}

// —— 同一座城的八种皮肤（城心特写） ——
if (want('skins')) {
  const st = settle({ seed: 'thornwick', size: 'town', culture: 'western', coast: true, walls: 'stone', population: 5000 })
  const c = centroid(st.wards.filter((w: any) => w.inner).map((w: any) => centroid(w.poly)))
  for (const s of ['parchment', 'color', 'ink', 'blueprint', 'kiriezu', 'nolli', 'fangzhi', 'survey']) save(draw(st, s, 640, { c, w: 620 }), `skin-${s}`)
}

// —— 区划视图 ——
if (want('zoning')) save(draw(settle({ seed: 'vale', culture: 'western', coast: true, population: 16000 }), 'parchment', 1200, undefined, { view: 'zoning' }), 'zoning')

// —— 成长：同一个种子，人口从几十到几万 ——
if (want('growth')) {
  for (const pop of [120, 1500, 6000, 24000]) {
    const st = settle({ seed: 'grow', culture: 'western', river: true, hills: true, population: pop, size: pop < 400 ? 'hamlet' : pop < 3000 ? 'village' : pop < 9000 ? 'town' : 'city' })
    save(draw(st, 'parchment', 600), `growth-${pop}`)
  }
}

// —— 地标特写 ——
if (want('landmarks')) {
  /** 在一串种子里找第一个出现某种名所的聚落 */
  const findSacred = (kind: string, base: Record<string, unknown>) => {
    tierTrace.on = true
    for (let i = 0; i < 80; i++) {
      const st = settle({ ...base, seed: `${kind}${i}` })
      const r = tierTrace.list.find((x) => x.kind === kind)
      if (r) return { st, p: r.p as P }
    }
    throw new Error(`没找到 ${kind}`)
  }
  const senbon = findSacred('senbon', { culture: 'wa', hills: true, population: 13000 })
  save(draw(senbon.st, 'color', 800, { c: senbon.p, w: 190 }, { labels: false }), 'landmark-senbon')
  const umi = findSacred('umi', { culture: 'wa', coast: true, hills: true, population: 13000 })
  // 取景：海上鸟居与岸上社殿的中间
  const shrine = umi.st.buildings.filter((b: any) => b.kind !== 'torii').map((b: any) => centroid(b.poly) as P).sort((a: P, b: P) => Math.hypot(a[0] - umi.p[0], a[1] - umi.p[1]) - Math.hypot(b[0] - umi.p[0], b[1] - umi.p[1]))[0]
  save(draw(umi.st, 'color', 800, { c: [(umi.p[0] + shrine[0]) / 2, (umi.p[1] + shrine[1]) / 2], w: 170 }, { labels: false }), 'landmark-umi')
  const abbey = findSacred('abbey', { culture: 'western', hills: true, population: 13000 })
  save(draw(abbey.st, 'color', 800, { c: abbey.p, w: 200 }, { labels: false }), 'landmark-abbey')

  // 宫城、大教堂：取片区
  const cap = settle({ seed: 'chang', culture: 'eastern', plan: 'lifang', capital: true, planStrength: 0.8, population: 13000 })
  const pal = cap.wards.filter((w: any) => w.type === 'castle').sort((a: any, b: any) => area(b.poly) - area(a.poly))[0]
  const lm = cap.landmarks.find((l: any) => l.kind === 'castle')
  save(draw(cap, 'color', 800, { c: (lm?.p ?? centroid(pal.poly)) as P, w: 900 }, { labels: false }), 'landmark-palace')
  const west = settle({ seed: 'rome', culture: 'western', capital: true, population: 20000 })
  const cath = west.buildings.filter((b: any) => b.kind === 'temple').sort((a: any, b: any) => area(b.poly) - area(a.poly))[0]
  save(draw(west, 'color', 800, { c: centroid(cath.poly) as P, w: 200 }, { labels: false }), 'landmark-cathedral')

  // 公园：各文明挑一座构成最丰富的
  const parks: { c: P; sig: string[] }[] = []
  traceParks((c, sig) => parks.push({ c: c as P, sig }))
  for (const [culture, seed, key] of [['eastern', 'garden', 'natural'], ['wa', 'teien', 'field'], ['western', 'parterre', 'axial'], ['islamic', 'bagh', 'axial']] as const) {
    for (let i = 0; i < 40; i++) {
      parks.length = 0
      const st = settle({ seed: `${seed}${i}`, culture, population: 12000, river: true })
      const hit = parks.filter((x) => x.sig.some((s) => s.includes(key))).sort((a, b) => b.sig.length - a.sig.length)[0]
      if (!hit) continue
      save(draw(st, 'color', 700, { c: hit.c, w: 190, aspect: 0.8 }, { labels: false }), `park-${culture}`)
      console.log('  ', culture, hit.sig.slice(0, 6).join(' '))
      break
    }
  }
  traceParks(null)
}
