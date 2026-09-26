import { latitudeOf } from './gen/climate'
import { hasEdits, parseProject, resampleEdits, serializeProject, snapshotEdits } from './app/project'
import { EditorView, type EditTool, type EditView } from './editor/editor'
import { autoContinents, floodLand, regionAnchor } from './editor/layers'
import { BIOME_NAMES, DEFAULT_PARAMS, type Label, type World, type WorldEdits, type WorldParams } from './gen/types'
import { THEMES, ensureFonts, type StyleId } from './render/atlas'
import type { DisplayList } from './render/atlas/svg/displayList'
import { AtlasViewer } from './render/atlas/svg/viewer'
import { smoothRivers, type SmoothRiver } from './render/rivers'
import { Scene3D, type View3DOptions } from './render/scene3d'
import { buildPhysicalTexture } from './render/texture'
import type { WorkerOut } from './worker'
import GenWorker from './worker?worker'
import { bindStatic, lang, LANGS, onLang, placeName, setLang, t, tr, worldTitle, type Lang } from './i18n'

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T

// —— 状态 ——
const params: WorldParams = { ...DEFAULT_PARAMS, ...readHash() }
const view3d: View3DOptions = { exaggeration: 28, labels: true, sunAzimuth: 225, sunElevation: 32, clouds: true, haze: true, dof: 0.25, stage: true, roads: true }
const atlasOpts = { labels: true, contours: true, graticule: true }
let atlasStyle: StyleId = (localStorageGet('atlasStyle') as StyleId) || 'physical'
/** 每种风格缓存一份矢量显示列表（预览、SVG 导出、PNG 导出共用） */
const atlasCache = new Map<string, DisplayList>()
let world: World | null = null
let rivers: SmoothRiver[] = []
/** 当前预览的纸图尺寸（像素，与导出一致） */
let atlasCanvas: { width: number; height: number } | null = null
let mode: '3d' | '2d' | 'edit' = '3d'
/** 用户对当前世界的编辑（与 params.width/height 对应） */
let edits: WorldEdits = {}
let editsSize = { W: params.width, H: params.height, seed: params.seed }
/** 最近一次生成的地表贴图：编辑视图里改完后 3D 延迟到切回时再重建 */
let lastTex: { color: HTMLCanvasElement; roughness: HTMLCanvasElement } | null = null
let sceneStale = false
let editor: EditorView | null = null
/** 生成当前世界时发给 Worker 的编辑（编辑视图的预览只叠加之后新画的部分） */
let genEdits: WorldEdits = {}
let sentEdits: WorldEdits = {}

const scene = new Scene3D($('#view3d'), view3d)
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__scene = scene

// —— 控件 ——
interface SliderSpec {
  label: string
  min: number
  max: number
  step: number
  fmt: (v: number) => string
  get: () => number
  set: (v: number) => void
}

const sliders: (() => void)[] = []
function slider(host: HTMLElement, s: SliderSpec) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `<label></label><input type="range" min="${s.min}" max="${s.max}" step="${s.step}"><output></output>`
  tr(row.querySelector('label')!, s.label)
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
}

function toggles(host: HTMLElement, list: { label: string; get: () => boolean; set: (v: boolean) => void }[]) {
  const box = document.createElement('div')
  box.className = 'toggles'
  for (const it of list) {
    const b = document.createElement('button')
    b.className = 'toggle' + (it.get() ? ' on' : '')
    tr(b, it.label)
    b.addEventListener('click', () => {
      it.set(!it.get())
      b.classList.toggle('on', it.get())
    })
    box.appendChild(b)
  }
  host.appendChild(box)
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const x100 = (v: number) => v.toFixed(2)

// —— 世界参数 ——
/** 参数改了但还没重新生成：生成按钮给出提示 */
let dirtyNow = false
function markDirty(dirty = true) {
  dirtyNow = dirty
  $('#generate').classList.toggle('dirty', dirty)
  $('#generate').textContent = t(dirty ? '按新参数生成' : '生成世界')
  if (dirty) for (const b of $('#presets').children) b.classList.remove('on')
}

const wc = $('#world-controls')
const resRow = document.createElement('div')
resRow.className = 'row'
resRow.innerHTML = `<label></label><select id="res">
  <option value="768x480"></option>
  <option value="1024x640"></option>
  <option value="1536x960"></option>
</select>`
tr(resRow.querySelector('label')!, '分辨率')
const RES_NOTE = ['快', '标准', '精细']
const paintRes = () => resRow.querySelectorAll('option').forEach((o, i) => (o.textContent = `${o.value.replace('x', ' × ')} · ${t(RES_NOTE[i])}`))
paintRes()
onLang(paintRes)
wc.appendChild(resRow)
const resSel = $<HTMLSelectElement>('#res')
const syncRes = () => {
  resSel.value = `${params.width}x${params.height}`
  if (!resSel.value) resSel.value = '1024x640'
}
syncRes()
resSel.addEventListener('change', () => {
  ;[params.width, params.height] = resSel.value.split('x').map(Number)
  markDirty()
})

type NumKey = Exclude<keyof WorldParams, 'seed'>
const worldSliders: (Omit<SliderSpec, 'get' | 'set'> & { key: NumKey })[] = [
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
  slider(wc, {
    ...s,
    get: () => params[s.key],
    set: (v) => {
      params[s.key] = v
      markDirty()
    },
  })
}
const syncParams = () => {
  sliders.forEach((f) => f())
  syncRes()
}
$('#reset').addEventListener('click', () => {
  Object.assign(params, { ...DEFAULT_PARAMS, seed: params.seed })
  syncParams()
  markDirty()
})
{
  const adv = $<HTMLDetailsElement>('#advanced')
  adv.open = localStorageGet('advanced') === '1'
  adv.addEventListener('toggle', () => localStorageSet('advanced', adv.open ? '1' : '0'))
}

function latFmt(v: number) {
  return `${Math.abs(v)}°${v > 0 ? 'N' : v < 0 ? 'S' : ''}`
}

const seedInput = $<HTMLInputElement>('#seed')
seedInput.value = params.seed
seedInput.addEventListener('input', () => {
  params.seed = seedInput.value.trim() || 'world'
  markDirty()
})
seedInput.addEventListener('keydown', (e) => e.key === 'Enter' && generate())

const SYL = ['ar', 'en', 'is', 'or', 'ul', 'va', 'mi', 'ko', 'ra', 'the', 'lo', 'san', 'dra', 'nor', 'eth', 'wyn', 'ka', 'mel']
function randomSeed() {
  let s = ''
  const n = 2 + Math.floor(Math.random() * 2)
  for (let i = 0; i < n; i++) s += SYL[Math.floor(Math.random() * SYL.length)]
  params.seed = s
  seedInput.value = s
  generate()
}
$('#dice').addEventListener('click', randomSeed)
window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement
  if (e.ctrlKey || e.metaKey || e.altKey || el.matches('input, select, textarea')) return
  if (e.key === 'r' || e.key === 'R') randomSeed()
})

// 预设：一键换一类世界
const presets: { name: string; p: Partial<WorldParams> }[] = [
  { name: '大陆', p: { landRatio: 0.36, plates: 14, mountains: 1, coastRoughness: 0.55, rainfall: 1, temperature: 0, latNorth: 64, latSouth: 14 } },
  { name: '群岛', p: { landRatio: 0.2, plates: 22, mountains: 1.2, coastRoughness: 0.85, rainfall: 1.2, temperature: 3, latNorth: 30, latSouth: -30 } },
  { name: '泛大陆', p: { landRatio: 0.56, plates: 9, mountains: 1.3, coastRoughness: 0.4, rainfall: 0.85, temperature: 1, latNorth: 55, latSouth: -40 } },
  { name: '冰原', p: { landRatio: 0.4, plates: 12, mountains: 1.1, coastRoughness: 0.9, rainfall: 0.9, temperature: -9, latNorth: 82, latSouth: 42 } },
  { name: '沙海', p: { landRatio: 0.48, plates: 11, mountains: 0.8, coastRoughness: 0.5, rainfall: 0.4, temperature: 5, latNorth: 40, latSouth: 5 } },
]
for (const pr of presets) {
  const b = tr(document.createElement('button'), pr.name)
  b.addEventListener('click', () => {
    Object.assign(params, pr.p)
    syncParams()
    generate()
    b.classList.add('on')
  })
  $('#presets').appendChild(b)
}

// —— 3D 沙盘控件 ——
const v3 = $('#view-3d')
toggles(v3, [
  { label: '云层', get: () => view3d.clouds, set: (v) => scene.setOptions({ clouds: (view3d.clouds = v) }) },
  { label: '空气感', get: () => view3d.haze, set: (v) => scene.setOptions({ haze: (view3d.haze = v) }) },
  { label: '道路', get: () => view3d.roads, set: (v) => scene.setOptions({ roads: (view3d.roads = v) }) },
  { label: '展台', get: () => view3d.stage, set: (v) => scene.setOptions({ stage: (view3d.stage = v) }) },
  { label: '地名', get: () => view3d.labels, set: (v) => scene.setOptions({ labels: (view3d.labels = v) }) },
])
slider(v3, {
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
slider(v3, {
  label: '移轴景深',
  min: 0,
  max: 100,
  step: 1,
  fmt: (v) => (v ? `${v}%` : '关'),
  get: () => Math.round(view3d.dof * 100),
  set: (v) => scene.setOptions({ dof: (view3d.dof = v / 100) }),
})
slider(v3, {
  label: '太阳方位',
  min: 0,
  max: 360,
  step: 1,
  fmt: (v) => `${v}°`,
  get: () => view3d.sunAzimuth,
  set: (v) => scene.setOptions({ sunAzimuth: (view3d.sunAzimuth = v) }),
})
slider(v3, {
  label: '太阳高度',
  min: 2,
  max: 88,
  step: 1,
  fmt: (v) => `${v}°`,
  get: () => view3d.sunElevation,
  set: (v) => scene.setOptions({ sunElevation: (view3d.sunElevation = v) }),
})

// —— 纸图控件 ——
const v2 = $('#view-2d')
{
  const grid = document.createElement('div')
  grid.className = 'styles'
  for (const th of THEMES) {
    const b = document.createElement('button')
    b.className = 'style-card' + (th.id === atlasStyle ? ' on' : '')
    tr(b, th.desc, 'title')
    b.innerHTML = `<i style="background:rgb(${th.paper.join(',')})"><b style="border-color:${th.ink}"></b></i><span></span>`
    tr(b.querySelector('span')!, th.name)
    b.addEventListener('click', () => {
      atlasStyle = th.id
      localStorageSet('atlasStyle', th.id)
      for (const x of grid.children) x.classList.toggle('on', x === b)
      refreshAtlas()
    })
    grid.appendChild(b)
  }
  v2.appendChild(grid)
}
const atlasToggle = (label: string, key: keyof typeof atlasOpts) => ({
  label,
  get: () => atlasOpts[key],
  set: (v: boolean) => {
    atlasOpts[key] = v
    atlasCache.clear()
    refreshAtlas()
  },
})
toggles(v2, [atlasToggle('注记', 'labels'), atlasToggle('等高线', 'contours'), atlasToggle('经纬网', 'graticule')])

let exTimer = 0
function scheduleExaggeration() {
  clearTimeout(exTimer)
  exTimer = window.setTimeout(() => scene.setOptions({ exaggeration: view3d.exaggeration }), 120)
}

// —— 视图切换 ——
for (const b of document.querySelectorAll<HTMLButtonElement>('#switch button')) {
  b.addEventListener('click', () => setMode(b.dataset.view as '3d' | '2d'))
}
function setMode(m: '3d' | '2d' | 'edit') {
  mode = m
  for (const b of document.querySelectorAll<HTMLButtonElement>('#switch button')) b.classList.toggle('on', b.dataset.view === m)
  $('#view3d').classList.toggle('hidden', m !== '3d')
  $('#view2d').classList.toggle('hidden', m !== '2d')
  $('#viewEdit').classList.toggle('hidden', m !== 'edit')
  scene.active = m === '3d'
  $('#ctl-3d').classList.toggle('hidden', m !== '3d')
  $('#ctl-2d').classList.toggle('hidden', m !== '2d')
  $('#ctl-edit').classList.toggle('hidden', m !== 'edit')
  $('#export-svg').classList.toggle('hidden', m !== '2d')
  updateHint()
  if (m === '3d' && sceneStale && world && lastTex) {
    scene.setWorld(world, lastTex.color, lastTex.roughness, rivers)
    sceneStale = false
  }
  if (m === '2d' && world) refreshAtlas()
  if (m === 'edit') {
    ensureEditor()
    if (world && lastTex) editor!.setWorld(world, lastTex.color, edits, genEdits)
  }
}

function updateHint() {
  $('#hint').textContent = t(
    mode === '3d'
      ? '拖动旋转 · 右键平移 · 滚轮缩放 · R 随机 · P 性能'
      : mode === '2d'
        ? '拖动平移 · 滚轮缩放 · 双击复位 · R 随机'
        : '左键绘制 / 选取 · 右键或 Shift 拖动平移 · 滚轮缩放 · Alt+滚轮 画笔大小 · Ctrl+Z 撤销',
  )
}

// —— 生成 ——
const worker = new GenWorker()
let jobId = 0
const loading = $('#loading')
/** quiet：编辑后的自动重算，不遮挡画面，只在角落显示进度 */
function generate(quiet = false) {
  const id = ++jobId
  params.seed = seedInput.value.trim() || 'world'
  // 换了种子：编辑是针对旧世界的，询问后清除
  if (params.seed !== editsSize.seed && hasEdits(edits)) {
    if (!window.confirm(t('换种子会生成一个全新的世界，当前的编辑将被清除。继续吗？'))) {
      params.seed = editsSize.seed
      seedInput.value = params.seed
      return
    }
    edits = {}
    undoStack.length = 0
  }
  // 换了分辨率：编辑按比例重采样
  if ((params.width !== editsSize.W || params.height !== editsSize.H) && hasEdits(edits)) edits = resampleEdits(edits, editsSize.W, editsSize.H, params.width, params.height)
  editsSize = { W: params.width, H: params.height, seed: params.seed }
  writeHash()
  markDirty(false)
  quietJob = quiet
  if (quiet) {
    $('#edit-status').classList.remove('hidden')
    $('#edit-status').textContent = t('演算中…')
  } else loading.classList.remove('hidden')
  $<HTMLButtonElement>('#generate').disabled = true
  sentEdits = snapshotEdits(edits)
  worker.postMessage({ id, params: { ...params }, edits: { ...edits } })
}
let quietJob = false
worker.onmessage = async (ev: MessageEvent<WorkerOut>) => {
  const m = ev.data
  if (m.id !== jobId) return
  if (m.type === 'progress') {
    $('#load-stage').textContent = t(m.stage)
    $('#load-bar').style.width = `${Math.round(m.frac * 100)}%`
    if (quietJob) $('#edit-status').textContent = t('演算中 · {stage}', { stage: t(m.stage) })
    return
  }
  if (m.type === 'error') {
    $('#load-stage').textContent = t('生成失败：') + m.message.split('\n')[0]
    $<HTMLButtonElement>('#generate').disabled = false
    console.error(m.message)
    return
  }
  $('#load-stage').textContent = t('绘制地表')
  await new Promise((r) => setTimeout(r, 16))
  world = m.world
  rivers = smoothRivers(world)
  try {
    const tex = buildPhysicalTexture(world, rivers, 2)
    lastTex = tex
    homeThumb(tex.color)
    // 编辑视图里不重建 3D（较慢），切回 3D 时再建
    if (mode === '3d' || !editor) {
      scene.setWorld(world, tex.color, tex.roughness, rivers)
      sceneStale = false
    } else sceneStale = true
    genEdits = sentEdits
    // 大洲名随区域走（重算后的地点列表里补回）
    if (edits.regions) syncContinentLabels()
    editor?.setWorld(world, tex.color, edits, genEdits)
  } catch (err) {
    console.error(err)
    $('#load-stage').textContent = t('绘制失败：') + (err instanceof Error ? err.message : String(err))
    $<HTMLButtonElement>('#generate').disabled = false
    return
  }
  atlasCanvas = null
  atlasCache.clear()
  if (mode === '2d') await refreshAtlas()
  showStats(world, m.cached)
  loading.classList.add('hidden')
  $('#edit-status').classList.add('hidden')
  $<HTMLButtonElement>('#generate').disabled = false
}
$('#generate').addEventListener('click', () => generate())

let atlasJob = 0
let viewer: AtlasViewer | null = null
async function buildList(w: World, style: StyleId) {
  let list = atlasCache.get(style)
  if (list) return list
  const { buildAtlasVector } = await import('./render/atlas/svg/vector')
  const measurer = document.createElement('canvas').getContext('2d')!
  list = buildAtlasVector(w, rivers, style, atlasOpts, measurer, 2)
  atlasCache.set(style, list)
  return list
}
async function refreshAtlas() {
  if (!world) return
  const w = world
  const style = atlasStyle
  const job = ++atlasJob
  if (!atlasCache.has(style)) {
    loading.classList.remove('hidden')
    $('#load-stage').textContent = t('矢量绘制{style}', { style: t(THEMES.find((th) => th.id === style)!.name) })
    $('#load-bar').style.width = '100%'
    await ensureFonts(w, style)
    await new Promise((r) => setTimeout(r, 20))
    if (job !== atlasJob || w !== world) return
  }
  const list = await buildList(w, style)
  loading.classList.add('hidden')
  if (job !== atlasJob) return
  const keepView = atlasCanvas !== null && atlasCanvas.width === list.width && atlasCanvas.height === list.height
  atlasCanvas = { width: list.width, height: list.height }
  if (!viewer) viewer = new AtlasViewer($('#view2d'))
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__viewer = viewer
  viewer.setList(list)
  if (!keepView) fitMap()
  else applyMap()
}

let statsCached = false
function showStats(w: World, cached = statsCached) {
  statsCached = cached
  const s = w.stats
  const m = (km: number) => `${Math.round(km * 1000).toLocaleString()} m`
  const tiles: [string, string][] = [
    ['陆地', pct(s.land)],
    ['最高峰', m(s.peak)],
    ['最深处', m(s.trench)],
    ['河流', String(s.rivers)],
    ['湖泊', String(s.lakes)],
    ['跨度', `${Math.round(w.W * w.kmPerCell).toLocaleString()} km`],
  ]
  $('#world-name').innerHTML = `${worldTitle(w)}<small>${cached ? t('缓存') : `${(s.ms / 1000).toFixed(1)} s`}</small>`
  $('#stats').innerHTML = tiles.map(([k, v]) => `<div><b>${v}</b><span>${t(k)}</span></div>`).join('')
  $('#info').classList.remove('hidden')
}

// —— 2D 平移缩放 ——
const map = { x: 0, y: 0, k: 1 }
function applyMap() {
  viewer?.setView(map.x, map.y, map.k)
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
      const nk = Math.min(24, Math.max(0.15, map.k * f))
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
  else if (mode === 'edit' && editor) {
    const r = $('#viewEdit').getBoundingClientRect()
    const c = editor.toCell(clientX - r.left, clientY - r.top)
    cell = { x: Math.floor(c.x), y: Math.floor(c.y) }
  } else if (atlasCanvas) {
    const r = $('#view2d').getBoundingClientRect()
    const M = (atlasCanvas.width - world.W * 2) / 2
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
  probe.innerHTML = `<div class="b">${t(BIOME_NAMES[world.biome[i]])}</div>` + rows.map(([k, v]) => `<span class="k">${t(k)}</span><span class="v">${v}</span>`).join('')
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
    // 由矢量显示列表按 2 倍分辨率栅格化
    await ensureFonts(world, atlasStyle)
    await buildList(world, atlasStyle)
    if (!viewer) viewer = new AtlasViewer($('#view2d'))
    viewer.setList(atlasCache.get(atlasStyle)!)
    url = viewer.rasterize(2).toDataURL('image/png')
  }
  const a = document.createElement('a')
  a.href = url
  a.download = `${world.worldName.toLowerCase()}-${params.seed}-${mode === '3d' ? '3d' : atlasStyle}.png`
  a.click()
})

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v)
  } catch {
    // 隐私模式等场景不可用，忽略
  }
}

// —— 矢量导出：纸图的全部底色、线划、符号与注记都是路径和文字 ——
$('#export-svg').addEventListener('click', async () => {
  if (!world) return
  const w = world
  loading.classList.remove('hidden')
  $('#load-stage').textContent = t('矢量化：追踪等值线与区域轮廓')
  $('#load-bar').style.width = '100%'
  await ensureFonts(w, atlasStyle)
  await new Promise((r) => setTimeout(r, 20))
  try {
    const svg = (await buildList(w, atlasStyle)).toSVG()
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${w.worldName.toLowerCase()}-${params.seed}-${atlasStyle}.svg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  } finally {
    loading.classList.add('hidden')
  }
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


// —— 编辑视图 ——
const undoStack: WorldEdits[] = []
let regenTimer = 0
/** 编辑完成后稍等再重算，连续几笔只算一次 */
function scheduleRegen() {
  clearTimeout(regenTimer)
  regenTimer = window.setTimeout(() => generate(true), 350)
}
function pushUndo() {
  undoStack.push(snapshotEdits({ ...edits, labels: world ? world.labels.map((l) => ({ ...l })) : edits.labels }))
  if (undoStack.length > 30) undoStack.shift()
  // 一开始编辑就把现有地点钉住：之后改地形、改气候重算时，城镇与地名不会整体洗牌
  if (!edits.labels && world) {
    edits.labels = world.labels.map((l) => ({ ...l }))
    edits.worldName = world.worldName
    edits.worldNameZh = world.worldNameZh
  }
}
function undo() {
  const prev = undoStack.pop()
  if (!prev) return
  edits = prev
  edits.terrainRev = (edits.terrainRev ?? 0) + 1
  editor?.refreshEdits(edits)
  scheduleRegen()
}
function ensureEditor() {
  if (editor) return
  editor = new EditorView($('#viewEdit'), {
    onBeforeEdit: pushUndo,
    onCommit: (kind) => {
      // 大洲只影响标注，不必重算
      if (kind === 'regions') {
        syncContinentLabels()
        editor?.draw()
        return
      }
      if (kind === 'labels' && world) {
        edits.labels = world.labels.map((l) => ({ ...l }))
        // 地点改动立即反映到纸图与 3D 地名，政区在重算后更新
        atlasCache.clear()
        scene.refreshLabels()
      }
      scheduleRegen()
    },
    onSelect: showInspector,
    onRegionSelect: showRegionInspector,
  })
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__editor = editor
}

// 工具与画笔
{
  const tools: [EditTool, string, string][] = [
    ['select', '选取', '选取、拖动地点；空白处拖动平移'],
    ['place', '新增地点', '点击地图添加城镇'],
    ['raise', '抬升', '抬高地形：海里画出陆地、平原上堆出山'],
    ['lower', '下沉', '压低地形：挖出海湾、湖盆'],
    ['smooth', '抹平', '让地形变平缓'],
    ['warm', '升温', '提高气温'],
    ['cool', '降温', '降低气温'],
    ['wet', '增雨', '增加降水'],
    ['dry', '减雨', '减少降水'],
    ['region', '大洲', '点选陆块建立大洲，或选中已有大洲'],
    ['regionAdd', '划入', '画笔把陆地划入选中的大洲'],
    ['regionErase', '移出', '画笔把陆地移出选中的大洲'],
  ]
  const box = $('#edit-tools')
  for (const [id, label, tip] of tools) {
    const b = tr(tr(document.createElement('button'), label), tip, 'title')
    b.dataset.tool = id
    b.classList.toggle('on', id === 'select')
    b.addEventListener('click', () => {
      ensureEditor()
      if (id.startsWith('region')) ensureRegions()
      editor!.setTool(id)
      for (const x of box.children) x.classList.toggle('on', x === b)
      $('#brush-opts').classList.toggle('dim', id === 'select' || id === 'place' || id === 'region')
      $('#region-panel').classList.toggle('hidden', !id.startsWith('region'))
    })
    box.appendChild(b)
  }
  $('#brush-opts').classList.add('dim')
  const bo = $('#brush-opts')
  slider(bo, {
    label: '画笔大小',
    min: 3,
    max: 100,
    step: 1,
    fmt: (v) => `${Math.round(v)}`,
    get: () => editor?.brush.radius ?? 18,
    set: (v) => {
      ensureEditor()
      editor!.brush.radius = v
    },
  })
  slider(bo, {
    label: '画笔强度',
    min: 0.05,
    max: 1,
    step: 0.05,
    fmt: (v) => v.toFixed(2),
    get: () => editor?.brush.strength ?? 0.5,
    set: (v) => {
      ensureEditor()
      editor!.brush.strength = v
    },
  })
  $('#edit-undo').addEventListener('click', undo)
  $('#edit-clear').addEventListener('click', () => {
    if (!hasEdits(edits) || !window.confirm(t('清除全部编辑，恢复为程序生成的原样？'))) return
    pushUndo()
    edits = { terrainRev: (edits.terrainRev ?? 0) + 1 }
    editor?.refreshEdits(edits)
    scheduleRegen()
  })
  window.addEventListener('keydown', (e) => {
    if (mode !== 'edit' || (e.target as HTMLElement).matches('input, select, textarea')) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      undo()
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && editor?.selected) deleteSelected()
  })
}

// 地点检查器
const KIND_NAMES: [Label['kind'], string][] = [
  ['capital', '首都'],
  ['city', '城镇'],
  ['continent', '大陆'],
  ['island', '岛屿'],
  ['ocean', '大洋'],
  ['sea', '海'],
  ['lake', '湖泊'],
  ['range', '山脉'],
  ['basin', '盆地'],
  ['desert', '沙漠'],
  ['forest', '森林'],
]
{
  const sel = $<HTMLSelectElement>('#insp-kind')
  for (const [k, n] of KIND_NAMES) {
    const o = tr(document.createElement('option'), n)
    o.value = k
    sel.appendChild(o)
  }
  const commit = () => {
    edits.labels = world ? world.labels.map((l) => ({ ...l })) : edits.labels
    atlasCache.clear()
    scene.refreshLabels()
    editor?.draw()
  }
  let editing = false
  const begin = () => {
    if (!editing) pushUndo()
    editing = true
  }
  $<HTMLInputElement>('#insp-zh').addEventListener('input', (e) => {
    const l = editor?.selected
    if (!l) return
    begin()
    l.zh = (e.target as HTMLInputElement).value
    commit()
  })
  $<HTMLInputElement>('#insp-name').addEventListener('input', (e) => {
    const l = editor?.selected
    if (!l) return
    begin()
    l.name = (e.target as HTMLInputElement).value
    commit()
  })
  $<HTMLInputElement>('#insp-ja').addEventListener('input', (e) => {
    const l = editor?.selected
    if (!l) return
    begin()
    l.ja = (e.target as HTMLInputElement).value
    commit()
  })
  for (const id of ['#insp-zh', '#insp-name', '#insp-ja']) $(id).addEventListener('change', () => (editing = false))
  sel.addEventListener('change', () => {
    const l = editor?.selected
    if (!l) return
    pushUndo()
    l.kind = sel.value as Label['kind']
    commit()
    scheduleRegen()
  })
  $('#insp-delete').addEventListener('click', deleteSelected)
}
function deleteSelected() {
  const l = editor?.selected
  if (!l || !world) return
  pushUndo()
  world.labels.splice(world.labels.indexOf(l), 1)
  editor!.select(null)
  edits.labels = world.labels.map((x) => ({ ...x }))
  atlasCache.clear()
  scene.refreshLabels()
  scheduleRegen()
}
function showInspector(l: Label | null) {
  $('#inspector').classList.toggle('hidden', !l)
  if (!l) return
  $<HTMLInputElement>('#insp-zh').value = l.zh
  $<HTMLInputElement>('#insp-name').value = l.name
  $<HTMLInputElement>('#insp-ja').value = l.ja ?? ''
  $<HTMLSelectElement>('#insp-kind').value = l.kind
}
$<HTMLInputElement>('#edit-names').addEventListener('change', (e) => {
  ensureEditor()
  editor!.showNames = (e.target as HTMLInputElement).checked
  editor!.draw()
})

// —— 项目：保存 / 打开 ——
$('#save').addEventListener('click', async () => {
  const text = await serializeProject(params, { ...edits, labels: edits.labels })
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${(world?.worldName ?? 'world').toLowerCase()}-${params.seed}.cartographer.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
})
$('#open').addEventListener('click', () => $<HTMLInputElement>('#open-file').click())
$<HTMLInputElement>('#open-file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  try {
    const doc = await parseProject(await f.text())
    Object.assign(params, doc.params)
    seedInput.value = params.seed
    edits = doc.edits
    editsSize = { W: params.width, H: params.height, seed: params.seed }
    undoStack.length = 0
    syncParams()
    generate()
  } catch (err) {
    window.alert(t('无法打开：') + t(err instanceof Error ? err.message : String(err)))
  }
})

// —— 首页与模块：世界地图 / 聚落地图 ——
/** 首页卡片用当前世界的缩略图 */
function homeThumb(color: HTMLCanvasElement) {
  const c = document.createElement('canvas')
  c.width = 560
  c.height = Math.round((560 * color.height) / color.width)
  c.getContext('2d')!.drawImage(color, 0, 0, c.width, c.height)
  const art = $('.hc-world')
  art.style.background = `url(${c.toDataURL('image/jpeg', 0.85)}) center / cover`
}
function setModule(m: 'home' | 'world' | 'settlement') {
  document.body.dataset.module = m
  for (const x of document.querySelectorAll<HTMLButtonElement>('#modules button')) x.classList.toggle('on', x.dataset.mod === m)
  scene.active = m === 'world' && mode === '3d'
  localStorageSet('module', m)
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#modules button')) b.addEventListener('click', () => setModule(b.dataset.mod as 'world' | 'settlement'))
for (const b of document.querySelectorAll<HTMLButtonElement>('.home-card')) b.addEventListener('click', () => setModule(b.dataset.go as 'world' | 'settlement'))
$('#go-home').addEventListener('click', () => setModule('home'))
$('#home-open').addEventListener('click', () => {
  setModule('world')
  $<HTMLInputElement>('#open-file').click()
})
// 分享链接（带参数）直接进世界地图；否则回到上次所在的模块，首次打开显示首页
setModule(location.hash.length > 1 ? 'world' : ((localStorageGet('module') as 'home' | 'world' | 'settlement' | null) ?? 'home'))

// —— 底图 ——
$<HTMLSelectElement>('#edit-view').addEventListener('change', (e) => {
  ensureEditor()
  const v = (e.target as HTMLSelectElement).value
  editor!.setView(v === 'auto' ? null : (v as EditView))
})

// —— 大洲 ——
/** 还没有大洲数据时：按现有的大洲名，把各自所在的连通陆地建成区域 */
function ensureRegions() {
  if (edits.regions || !world || !editor) return
  const { W, H } = world
  const reg = new Int16Array(W * H).fill(-1)
  const meta: { name: string; zh: string; ja?: string }[] = []
  const land = editor.landMask()
  for (const l of world.labels) {
    if (l.kind !== 'continent') continue
    const i = Math.min(H - 1, Math.max(0, Math.round(l.y))) * W + Math.min(W - 1, Math.max(0, Math.round(l.x)))
    if (!land[i] || reg[i] >= 0) continue
    const id = meta.length
    meta.push({ name: l.name, zh: l.zh, ja: l.ja })
    for (const j of floodLand(land, reg, W, H, i, -1)) reg[j] = id
  }
  pushUndo()
  edits.regions = reg
  edits.regionMeta = meta
  editor.refreshEdits(edits)
}

/** 大洲名放到各区域最宽阔处；地点列表原地替换（编辑视图持有同一个数组） */
function syncContinentLabels() {
  const w = world
  const reg = edits.regions
  if (!w || !reg || reg.length !== w.W * w.H) return
  const others = w.labels.filter((l) => l.kind !== 'continent')
  const conts: Label[] = []
  ;(edits.regionMeta ?? []).forEach((m, id) => {
    const a = regionAnchor(reg, w.W, w.H, id)
    if (!a) return
    conts.push({ kind: 'continent', name: m.name, zh: m.zh, ja: m.ja, x: a.x, y: a.y, angle: 0, weight: 1000 + a.area / 20, span: a.span })
  })
  w.labels.splice(0, w.labels.length, ...conts, ...others)
  edits.labels = w.labels.map((l) => ({ ...l }))
  atlasCache.clear()
  scene.refreshLabels()
}

let neck = 10
slider($('#region-neck'), {
  label: '地峡宽度',
  min: 2,
  max: 40,
  step: 1,
  fmt: (v) => t('{n} 格', { n: Math.round(v) }),
  get: () => neck,
  set: (v) => (neck = v),
})
$('#region-auto').addEventListener('click', () => {
  if (!world || !editor) return
  const { W, H } = world
  const land = editor.landMask()
  let landN = 0
  for (const v of land) landN += v
  const reg = autoContinents(land, world.coastDist, W, H, neck * (W / 1024), Math.max(400, landN * 0.02))
  // 沿用原大洲名：新区域里若有旧的大洲名标注，就继承它
  const old = world.labels.filter((l) => l.kind === 'continent')
  let n = 0
  for (const v of reg) n = Math.max(n, v + 1)
  const meta = Array.from({ length: n }, (_, id) => {
    const hit = old.find((l) => reg[Math.min(H - 1, Math.round(l.y)) * W + Math.min(W - 1, Math.round(l.x))] === id)
    return hit ? { name: hit.name, zh: hit.zh, ja: hit.ja } : { name: `Terra ${id + 1}`, zh: `新大洲${id + 1}`, ja: `テラ${id + 1}` }
  })
  pushUndo()
  edits.regions = reg
  edits.regionMeta = meta
  syncContinentLabels()
  editor.selectRegion(-1)
  editor.refreshEdits(edits)
})
function showRegionInspector(id: number) {
  const m = edits.regionMeta?.[id]
  $('#region-insp').classList.toggle('hidden', !m)
  if (!m) return
  $<HTMLInputElement>('#region-zh').value = m.zh
  $<HTMLInputElement>('#region-name').value = m.name
  $<HTMLInputElement>('#region-ja').value = m.ja ?? ''
}
for (const [sel, key] of [
  ['#region-zh', 'zh'],
  ['#region-name', 'name'],
  ['#region-ja', 'ja'],
] as const) {
  $<HTMLInputElement>(sel).addEventListener('input', (e) => {
    const m = edits.regionMeta?.[editor?.selectedRegion ?? -1]
    if (!m) return
    m[key] = (e.target as HTMLInputElement).value
    syncContinentLabels()
    editor?.draw()
  })
}
$('#region-delete').addEventListener('click', () => {
  const id = editor?.selectedRegion ?? -1
  const reg = edits.regions
  if (!reg || id < 0) return
  pushUndo()
  for (let i = 0; i < reg.length; i++) if (reg[i] === id) reg[i] = -1
  syncContinentLabels()
  editor!.selectRegion(-1)
})


// —— 语言 ——
bindStatic()
document.title = t('Cartographer · 世界地图生成器')
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang
for (const sel of document.querySelectorAll<HTMLSelectElement>('select.lang')) {
  sel.innerHTML = LANGS.map((l) => `<option value="${l.id}">${l.label}</option>`).join('')
  sel.value = lang
  sel.addEventListener('change', () => setLang(sel.value as Lang))
}
onLang(async () => {
  for (const sel of document.querySelectorAll<HTMLSelectElement>('select.lang')) sel.value = lang
  markDirty(dirtyNow)
  updateHint()
  sliders.forEach((f) => f())
  probe.classList.add('hidden')
  if (!world) return
  showStats(world)
  // 地图文字：纸图重排版、3D 地名与铭牌、编辑视图地名
  await document.fonts.load(`600 20px ${lang === 'ja' ? '"Noto Serif JP"' : '"Noto Serif SC"'}`, worldTitle(world) + world.labels.map((l) => placeName(l)).join(''))
  atlasCache.clear()
  if (mode === '2d') refreshAtlas()
  scene.refreshLanguage()
  editor?.draw()
})
updateHint()

generate()
