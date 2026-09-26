import { latitudeOf } from './gen/climate'
import { BIOME_NAMES, DEFAULT_PARAMS, type World, type WorldParams } from './gen/types'
import { ensureFonts, renderAtlas } from './render/atlas'
import { smoothRivers, type SmoothRiver } from './render/rivers'
import { Scene3D, type View3DOptions } from './render/scene3d'
import { buildPhysicalTexture } from './render/texture'
import type { WorkerOut } from './worker'
import GenWorker from './worker?worker'

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T

// —— 状态 ——
const params: WorldParams = { ...DEFAULT_PARAMS, ...readHash() }
const view3d: View3DOptions = { exaggeration: 26, trees: true, labels: true, sunAzimuth: 225, sunElevation: 32 }
const atlasOpts = { labels: true, contours: true, graticule: true }
let world: World | null = null
let rivers: SmoothRiver[] = []
let atlasCanvas: HTMLCanvasElement | null = null
let mode: '3d' | '2d' = '3d'

const scene = new Scene3D($('#view3d'), view3d)
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__scene = scene

// —— 控件 ——
interface SliderSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  fmt: (v: number) => string
  get: () => number
  set: (v: number) => void
  live?: boolean
}

function slider(host: HTMLElement, s: SliderSpec) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `<label>${s.label}</label><input type="range" min="${s.min}" max="${s.max}" step="${s.step}"><output></output>`
  const input = row.querySelector('input')!
  const out = row.querySelector('output')!
  const sync = () => {
    const v = s.get()
    input.value = String(v)
    out.textContent = s.fmt(v)
    input.style.setProperty('--p', `${((v - s.min) / (s.max - s.min)) * 100}%`)
  }
  input.addEventListener('input', () => {
    s.set(parseFloat(input.value))
    sync()
  })
  sync()
  host.appendChild(row)
  sliders.push(sync)
  return row
}
const sliders: (() => void)[] = []

const pct = (v: number) => `${Math.round(v * 100)}%`
const x100 = (v: number) => v.toFixed(2)
const wc = $('#world-controls')

const resRow = document.createElement('div')
resRow.className = 'row'
resRow.style.gridTemplateColumns = '76px 1fr'
resRow.innerHTML = `<label>分辨率</label><select id="res">
  <option value="768x480">768 × 480 · 快</option>
  <option value="1024x640">1024 × 640 · 标准</option>
  <option value="1536x960">1536 × 960 · 精细</option>
</select>`
wc.appendChild(resRow)
const resSel = $<HTMLSelectElement>('#res')
resSel.value = `${params.width}x${params.height}`
if (!resSel.value) resSel.value = '1024x640'
resSel.addEventListener('change', () => {
  const [w, h] = resSel.value.split('x').map(Number)
  params.width = w
  params.height = h
})

const worldSliders: Omit<SliderSpec, 'get' | 'set'>[] = [
  { key: 'landRatio', label: '陆地比例', min: 0.12, max: 0.65, step: 0.01, fmt: pct },
  { key: 'plates', label: '板块数量', min: 4, max: 30, step: 1, fmt: (v) => String(v) },
  { key: 'mountains', label: '造山强度', min: 0, max: 2, step: 0.05, fmt: x100 },
  { key: 'coastRoughness', label: '海岸破碎', min: 0, max: 1, step: 0.05, fmt: x100 },
  { key: 'erosion', label: '侵蚀风化', min: 0, max: 2, step: 0.05, fmt: x100 },
  { key: 'rainfall', label: '降水倍率', min: 0.3, max: 2, step: 0.05, fmt: x100 },
  { key: 'temperature', label: '气温偏移', min: -15, max: 12, step: 0.5, fmt: (v) => `${v > 0 ? '+' : ''}${v}°` },
  { key: 'latNorth', label: '北缘纬度', min: -60, max: 88, step: 1, fmt: latFmt },
  { key: 'latSouth', label: '南缘纬度', min: -88, max: 60, step: 1, fmt: latFmt },
]
for (const s of worldSliders) {
  const k = s.key as keyof WorldParams
  slider(wc, { ...s, get: () => params[k] as number, set: (v) => ((params as unknown as Record<string, number>)[k] = v) })
}

function latFmt(v: number) {
  return `${Math.abs(v)}°${v > 0 ? 'N' : v < 0 ? 'S' : ''}`
}

const seedInput = $<HTMLInputElement>('#seed')
seedInput.value = params.seed
seedInput.addEventListener('input', () => (params.seed = seedInput.value.trim() || 'world'))
seedInput.addEventListener('keydown', (e) => e.key === 'Enter' && generate())

const SYL = ['ar', 'en', 'is', 'or', 'ul', 'va', 'mi', 'ko', 'ra', 'the', 'lo', 'san', 'dra', 'nor', 'eth', 'wyn', 'ka', 'mel']
$('#dice').addEventListener('click', () => {
  let s = ''
  const n = 2 + Math.floor(Math.random() * 2)
  for (let i = 0; i < n; i++) s += SYL[Math.floor(Math.random() * SYL.length)]
  params.seed = s
  seedInput.value = s
  generate()
})

// 预设
const presets: { name: string; p: Partial<WorldParams> }[] = [
  { name: '大陆', p: { landRatio: 0.36, plates: 14, mountains: 1, coastRoughness: 0.55, rainfall: 1, temperature: 0, latNorth: 64, latSouth: 14 } },
  { name: '群岛', p: { landRatio: 0.2, plates: 22, mountains: 1.2, coastRoughness: 0.85, rainfall: 1.2, temperature: 3, latNorth: 30, latSouth: -30 } },
  { name: '泛大陆', p: { landRatio: 0.56, plates: 9, mountains: 1.3, coastRoughness: 0.4, rainfall: 0.85, temperature: 1, latNorth: 55, latSouth: -40 } },
  { name: '冰封北境', p: { landRatio: 0.4, plates: 12, mountains: 1.1, coastRoughness: 0.9, rainfall: 0.9, temperature: -9, latNorth: 82, latSouth: 42 } },
  { name: '沙海', p: { landRatio: 0.48, plates: 11, mountains: 0.8, coastRoughness: 0.5, rainfall: 0.4, temperature: 5, latNorth: 40, latSouth: 5 } },
]
for (const pr of presets) {
  const b = document.createElement('button')
  b.textContent = pr.name
  b.addEventListener('click', () => {
    Object.assign(params, pr.p)
    sliders.forEach((f) => f())
    generate()
  })
  $('#presets').appendChild(b)
}

// —— 视图控件 ——
const vc = $('#view-controls')
const sub3d = document.createElement('div')
sub3d.innerHTML = `<div class="sub">3D 沙盘</div>`
vc.appendChild(sub3d)
slider(sub3d, {
  key: 'ex',
  label: '垂直夸张',
  min: 4,
  max: 60,
  step: 1,
  fmt: (v) => `×${v}`,
  get: () => view3d.exaggeration,
  set: (v) => {
    view3d.exaggeration = v
    scheduleExaggeration()
  },
})
slider(sub3d, {
  key: 'az',
  label: '太阳方位',
  min: 0,
  max: 360,
  step: 1,
  fmt: (v) => `${v}°`,
  get: () => view3d.sunAzimuth,
  set: (v) => {
    view3d.sunAzimuth = v
    scene.setOptions({ sunAzimuth: v })
  },
})
slider(sub3d, {
  key: 'el',
  label: '太阳高度',
  min: 2,
  max: 88,
  step: 1,
  fmt: (v) => `${v}°`,
  get: () => view3d.sunElevation,
  set: (v) => {
    view3d.sunElevation = v
    scene.setOptions({ sunElevation: v })
  },
})
toggles(sub3d, [
  { label: '植被', get: () => view3d.trees, set: (v) => scene.setOptions({ trees: (view3d.trees = v) }) },
  { label: '地名', get: () => view3d.labels, set: (v) => scene.setOptions({ labels: (view3d.labels = v) }) },
])
const sub2d = document.createElement('div')
sub2d.innerHTML = `<div class="sub">制图</div>`
vc.appendChild(sub2d)
toggles(sub2d, [
  { label: '注记', get: () => atlasOpts.labels, set: (v) => ((atlasOpts.labels = v), refreshAtlas()) },
  { label: '等高线', get: () => atlasOpts.contours, set: (v) => ((atlasOpts.contours = v), refreshAtlas()) },
  { label: '经纬网', get: () => atlasOpts.graticule, set: (v) => ((atlasOpts.graticule = v), refreshAtlas()) },
])

function toggles(host: HTMLElement, list: { label: string; get: () => boolean; set: (v: boolean) => void }[]) {
  const box = document.createElement('div')
  box.className = 'toggles'
  for (const t of list) {
    const b = document.createElement('button')
    b.className = 'toggle' + (t.get() ? ' on' : '')
    b.textContent = t.label
    b.addEventListener('click', () => {
      t.set(!t.get())
      b.classList.toggle('on', t.get())
    })
    box.appendChild(b)
  }
  host.appendChild(box)
}

let exTimer = 0
function scheduleExaggeration() {
  clearTimeout(exTimer)
  exTimer = window.setTimeout(() => scene.setOptions({ exaggeration: view3d.exaggeration }), 120)
}

// —— 视图切换 ——
for (const b of document.querySelectorAll<HTMLButtonElement>('#switch button')) {
  b.addEventListener('click', () => setMode(b.dataset.view as '3d' | '2d'))
}
function setMode(m: '3d' | '2d') {
  mode = m
  for (const b of document.querySelectorAll<HTMLButtonElement>('#switch button')) b.classList.toggle('on', b.dataset.view === m)
  $('#view3d').classList.toggle('hidden', m !== '3d')
  $('#view2d').classList.toggle('hidden', m !== '2d')
  scene.active = m === '3d'
  $('#hint').textContent = m === '3d' ? '拖动旋转 · 右键平移 · 滚轮缩放' : '拖动平移 · 滚轮缩放 · 双击复位'
  if (m === '2d' && world && !atlasCanvas) refreshAtlas()
}

// —— 生成 ——
const worker = new GenWorker()
let jobId = 0
const loading = $('#loading')
function generate() {
  const id = ++jobId
  params.seed = seedInput.value.trim() || 'world'
  writeHash()
  loading.classList.remove('hidden')
  $<HTMLButtonElement>('#generate').disabled = true
  worker.postMessage({ id, params: { ...params } })
}
worker.onmessage = async (ev: MessageEvent<WorkerOut>) => {
  const m = ev.data
  if (m.id !== jobId) return
  if (m.type === 'progress') {
    $('#load-stage').textContent = m.stage
    $('#load-bar').style.width = `${Math.round(m.frac * 100)}%`
    return
  }
  if (m.type === 'error') {
    $('#load-stage').textContent = '生成失败：' + m.message.split('\n')[0]
    $<HTMLButtonElement>('#generate').disabled = false
    console.error(m.message)
    return
  }
  $('#load-stage').textContent = '绘制地表'
  await new Promise((r) => setTimeout(r, 16))
  world = m.world
  rivers = smoothRivers(world)
  const tex = buildPhysicalTexture(world, rivers, 2)
  scene.setWorld(world, tex.color, tex.roughness)
  atlasCanvas = null
  if (mode === '2d') await refreshAtlas()
  showStats(world)
  loading.classList.add('hidden')
  $<HTMLButtonElement>('#generate').disabled = false
}
$('#generate').addEventListener('click', generate)

async function refreshAtlas() {
  if (!world) return
  await ensureFonts()
  atlasCanvas = renderAtlas(world, rivers, { ...atlasOpts, scale: 2 })
  const wrap = $('#map-wrap')
  wrap.innerHTML = ''
  wrap.appendChild(atlasCanvas)
  fitMap()
}

function showStats(w: World) {
  const s = w.stats
  const rows: [string, string][] = [
    ['世界', w.worldName],
    ['陆地', pct(s.land)],
    ['最高峰', `${Math.round(s.peak * 1000).toLocaleString()} m`],
    ['最深处', `${Math.round(s.trench * 1000).toLocaleString()} m`],
    ['湖泊', String(s.lakes)],
    ['河流', String(s.rivers)],
    ['地图跨度', `${Math.round(w.W * w.kmPerCell).toLocaleString()} km`],
    ['生成耗时', `${(s.ms / 1000).toFixed(2)} s`],
  ]
  $('#stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
}

// —— 2D 平移缩放 ——
const map = { x: 0, y: 0, k: 1 }
function applyMap() {
  $('#map-wrap').style.transform = `translate(${map.x}px, ${map.y}px) scale(${map.k})`
}
function fitMap() {
  if (!atlasCanvas) return
  const v = $('#view2d')
  const k = Math.min((v.clientWidth - 60) / atlasCanvas.width, (v.clientHeight - 90) / atlasCanvas.height)
  map.k = k
  map.x = (v.clientWidth - atlasCanvas.width * k) / 2
  map.y = (v.clientHeight - atlasCanvas.height * k) / 2 + 16
  applyMap()
}
{
  const v = $('#view2d')
  let drag: { x: number; y: number; mx: number; my: number } | null = null
  v.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, mx: map.x, my: map.y }
    v.classList.add('dragging')
    v.setPointerCapture(e.pointerId)
  })
  v.addEventListener('pointermove', (e) => {
    if (drag) {
      map.x = drag.mx + e.clientX - drag.x
      map.y = drag.my + e.clientY - drag.y
      applyMap()
    }
  })
  v.addEventListener('pointerup', () => {
    drag = null
    v.classList.remove('dragging')
  })
  v.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = v.getBoundingClientRect()
      const cx = e.clientX - r.left
      const cy = e.clientY - r.top
      const f = Math.exp(-e.deltaY * 0.0015)
      const nk = Math.min(6, Math.max(0.15, map.k * f))
      map.x = cx - ((cx - map.x) * nk) / map.k
      map.y = cy - ((cy - map.y) * nk) / map.k
      map.k = nk
      applyMap()
    },
    { passive: false },
  )
  v.addEventListener('dblclick', fitMap)
  window.addEventListener('resize', () => mode === '2d' && fitMap())
}

// —— 探针：悬停查看地点信息 ——
const probe = $('#probe')
let probeRaf = 0
function probeAt(clientX: number, clientY: number) {
  if (!world) return
  let cell: { x: number; y: number } | null = null
  if (mode === '3d') cell = scene.pick(clientX, clientY)
  else if (atlasCanvas) {
    const r = $('#view2d').getBoundingClientRect()
    const M = Math.round(34 * 2)
    const px = (clientX - r.left - map.x) / map.k - M
    const py = (clientY - r.top - map.y) / map.k - M
    const x = Math.floor(px / 2)
    const y = Math.floor(py / 2)
    if (x >= 0 && y >= 0 && x < world.W && y < world.H) cell = { x, y }
  }
  if (!cell || cell.x < 0 || cell.y < 0 || cell.x >= world.W || cell.y >= world.H) {
    probe.classList.add('hidden')
    return
  }
  const i = cell.y * world.W + cell.x
  const e = world.elevation[i]
  const lat = latitudeOf(world.params, cell.y, world.H)
  const lake = !Number.isNaN(world.water[i]) && e > 0
  const rows: [string, string][] = [
    ['纬度', latFmt(Math.round(lat * 10) / 10)],
    [e > 0 ? '海拔' : '水深', `${Math.round(Math.abs(e) * 1000).toLocaleString()} m`],
  ]
  if (lake) rows.push(['湖面', `${Math.round(world.water[i] * 1000).toLocaleString()} m`])
  rows.push(['年均温', `${world.temperature[i].toFixed(1)} °C`])
  if (e > 0) rows.push(['年降水', `${Math.round(world.precipitation[i]).toLocaleString()} mm`])
  if (e > 0 && world.flow[i] > 1) rows.push(['径流', `${world.flow[i].toFixed(0)}`])
  probe.innerHTML = `<div class="b">${BIOME_NAMES[world.biome[i]]}</div>` + rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')
  probe.classList.remove('hidden')
}
$('#stage').addEventListener('pointermove', (e) => {
  cancelAnimationFrame(probeRaf)
  probeRaf = requestAnimationFrame(() => probeAt(e.clientX, e.clientY))
})
$('#stage').addEventListener('pointerleave', () => probe.classList.add('hidden'))

// —— 导出 ——
$('#export').addEventListener('click', async () => {
  if (!world) return
  let url: string
  if (mode === '3d') url = scene.snapshot()
  else {
    if (!atlasCanvas) await refreshAtlas()
    url = atlasCanvas!.toDataURL('image/png')
  }
  const a = document.createElement('a')
  a.href = url
  a.download = `${world.worldName.toLowerCase()}-${params.seed}-${mode}.png`
  a.click()
})

// —— URL 同步：分享链接即可复现同一世界 ——
function writeHash() {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if ((DEFAULT_PARAMS as unknown as Record<string, unknown>)[k] !== v) q.set(k, String(v))
  history.replaceState(null, '', '#' + q.toString())
}
function readHash(): Partial<WorldParams> {
  const q = new URLSearchParams(location.hash.slice(1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of q) {
    if (!(k in DEFAULT_PARAMS)) continue
    out[k] = typeof (DEFAULT_PARAMS as unknown as Record<string, unknown>)[k] === 'number' ? Number(v) : v
  }
  return out as Partial<WorldParams>
}

generate()
