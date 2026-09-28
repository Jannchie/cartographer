import { markRaw, reactive, toRaw, watch } from 'vue'
import { latitudeOf } from '../../gen/climate'
import { hasEdits, parseProject, resampleEdits, serializeProject, snapshotEdits } from '../../app/project'
import { EditorView, type EditTool, type EditView } from '../../editor/editor'
import { autoContinents, floodLand, regionAnchor } from '../../editor/layers'
import { BIOME_NAMES, DEFAULT_PARAMS, type Label, type World, type WorldEdits, type WorldParams } from '../../gen/types'
import { THEMES, ensureFonts, type StyleId } from '../../render/atlas'
import { atlasBackdrop, atlasFrameInset, buildAtlasChrome } from '../../render/atlas/svg/chrome'
import type { DisplayList } from '../../render/atlas/svg/displayList'
import { AtlasViewer } from '../../render/atlas/svg/viewer'
import { smoothRivers, type SmoothRiver } from '../../render/rivers'
import { Scene3D, type View3DOptions } from '../../render/scene3d'
import { LOOKS, QUALITIES, type Look, type QualityId } from '../../render/aerial/looks'
import { DEFAULT_TIME } from '../../render/aerial/daylight'
import { buildPhysicalTexture } from '../../render/texture'
import type { WorkerOut } from '../../worker'
import GenWorker from '../../worker?worker'
import { lang, onLang, placeName, worldTitle } from '../../i18n'
import { app, download, initialQuery, registerRoute, storeGet, storeSet, syncRoute } from '../app'
import { t } from '../i18n'
import { isTypingTarget } from '../keys'
import { bindPanZoom } from '../panZoom'
import { syllableSeed } from '../seed'

export type Mode = '3d' | '2d' | 'edit'

export const pct = (v: number) => `${Math.round(v * 100)}%`
export const latFmt = (v: number) => `${Math.abs(v)}°${v > 0 ? 'N' : v < 0 ? 'S' : ''}`

// 预设：一键换一类世界
export const PRESETS: { name: string; desc: string; p: Partial<WorldParams> }[] = [
  { name: '大陆', desc: '几块中等大小的大陆，温带为主', p: { landRatio: 0.36, plates: 14, mountains: 1, coastRoughness: 0.55, rainfall: 1, temperature: 0, latNorth: 64, latSouth: 14 } },
  { name: '群岛', desc: '破碎的岛链与浅海，热带到亚热带', p: { landRatio: 0.2, plates: 22, mountains: 1.2, coastRoughness: 0.85, rainfall: 1.2, temperature: 3, latNorth: 30, latSouth: -30 } },
  { name: '泛大陆', desc: '一整块超级大陆，内陆干旱、山系绵长', p: { landRatio: 0.56, plates: 9, mountains: 1.3, coastRoughness: 0.4, rainfall: 0.85, temperature: 1, latNorth: 55, latSouth: -40 } },
  { name: '冰原', desc: '高纬寒冷，冰盖、苔原与峡湾', p: { landRatio: 0.4, plates: 12, mountains: 1.1, coastRoughness: 0.9, rainfall: 0.9, temperature: -9, latNorth: 82, latSouth: 42 } },
  { name: '沙海', desc: '炎热少雨，沙漠与盐湖广布', p: { landRatio: 0.48, plates: 11, mountains: 0.8, coastRoughness: 0.5, rainfall: 0.4, temperature: 5, latNorth: 40, latSouth: 5 } },
]

/** 观感：上次选的预设 + 在其上的微调（旧版本存的字段缺了就用预设补上） */
function loadLook(): Look {
  const base = LOOKS.find((l) => l.id === storeGet('lookId'))?.look ?? LOOKS[0].look
  try {
    return { ...base, ...JSON.parse(storeGet('look') ?? '{}') }
  } catch {
    return { ...base }
  }
}

/** 上次的时刻（没存过、或存的不是 0~24 的数就是正午） */
function loadTime() {
  const h = Number(storeGet('timeOfDay') ?? DEFAULT_TIME)
  return Number.isFinite(h) && h >= 0 && h <= 24 ? h : DEFAULT_TIME
}

// —— 界面状态（响应式） ——
export const ws = reactive({
  params: { ...DEFAULT_PARAMS, ...readQuery(initialQuery('world') ?? new URLSearchParams(storeGet('worldQuery') ?? '')) } as WorldParams,
  view3d: {
    exaggeration: 28,
    labels: true,
    sunAzimuth: 225,
    sunElevation: 32,
    timeOfDay: loadTime(),
    dayCycle: storeGet('dayCycle') === '1',
    clouds: true,
    haze: true,
    dof: 0.25,
    stage: true,
    roads: true,
    quality: QUALITIES.some((q) => q.id === storeGet('quality')) ? (storeGet('quality') as QualityId) : 'high',
    shadowSoftness: Number(storeGet('shadowSoftness') ?? 3),
    look: loadLook(),
  } as View3DOptions,
  lookId: storeGet('lookId') ?? LOOKS[0].id,
  atlasStyle: ((storeGet('atlasStyle') as StyleId) || 'physical') as StyleId,
  atlasOpts: { labels: true, contours: true, graticule: true },
  mode: '3d' as Mode,
  /** 参数改了但还没重新生成 */
  dirty: false,
  busy: false,
  preset: -1,
  loading: { show: true, stage: '…', frac: 0 },
  /** 编辑后的自动重算：不遮挡画面，只在角落显示进度 */
  editStatus: null as string | null,
  info: null as { title: string; time: string; tiles: [string, string][] } | null,
  probe: null as { title: string; rows: [string, string][] } | null,
  // 编辑
  tool: 'select' as EditTool,
  editView: 'auto' as 'auto' | EditView,
  showNames: true,
  brush: { radius: 18, strength: 0.5 },
  neck: 10,
  /** 选中的地点（编辑检查器） */
  insp: null as { name: string; zh: string; ja: string; kind: Label['kind'] } | null,
  /** 选中的大洲 */
  region: null as { name: string; zh: string; ja: string } | null,
  /** 自动运镜中 */
  touring: false,
})

// —— 引擎（非响应式） ——
let scene: Scene3D | null = null
let viewer: AtlasViewer | null = null
let editor: EditorView | null = null
let els: { stage: HTMLElement; v3: HTMLElement; v2: HTMLElement; ve: HTMLElement } | null = null
let world: World | null = null
let rivers: SmoothRiver[] = []
/** 每种风格缓存一份矢量显示列表（预览、SVG 导出、PNG 导出共用） */
const atlasCache = new Map<string, DisplayList>()
/** 当前预览的纸图尺寸（像素，与导出一致） */
let atlasCanvas: { width: number; height: number } | null = null
/** 用户对当前世界的编辑（与 params.width/height 对应） */
let edits: WorldEdits = {}
let editsSize = { W: ws.params.width, H: ws.params.height, seed: ws.params.seed }
/** 最近一次生成的地表贴图：编辑视图里改完后 3D 延迟到切回时再重建 */
let lastTex: { color: HTMLCanvasElement; roughness: HTMLCanvasElement } | null = null
let sceneStale = false
/** 生成当前世界时发给 Worker 的编辑（编辑视图的预览只叠加之后新画的部分） */
let genEdits: WorldEdits = {}
let sentEdits: WorldEdits = {}
const undoStack: WorldEdits[] = []
/** 上次完整重建时的地面版本与地点位置：都没变时只需换地名 */
let lastGround = ''
let lastPlaces = ''
const placeSig = (w: World) => w.labels.map((l) => `${l.kind}:${l.x.toFixed(2)},${l.y.toFixed(2)}`).join('|')

export const getWorld = () => world

/** 等世界生成完的调用方（别的模块要用世界时） */
const waiters: ((w: World | null) => void)[] = []
const flushWaiters = () => {
  for (const r of waiters.splice(0)) r(world)
}
/** 需要世界时调用：还没生成就开始生成，生成完（或失败，得 null）后兑现 */
export function ensureWorld(): Promise<World | null> {
  if (world) return Promise.resolve(world)
  const p = new Promise<World | null>((r) => waiters.push(r))
  // 舞台还没挂载时由 mountWorld 接着生成
  if (jobId === 0 && els) generate()
  return p
}

/** 舞台挂载后接上引擎；第一次进入世界模块（或别处要用世界）时才生成 */
export function mountWorld(e: NonNullable<typeof els>) {
  els = e
  scene = markRaw(new Scene3D(e.v3, structuredClone(toRaw(ws.view3d))))
  scene.onTourChange = (on) => (ws.touring = on)
  // 昼夜循环推进的时刻反映到滑杆上（不再回传给场景）
  let savedAt = 0
  scene.onTimeChange = (h) => {
    ws.view3d.timeOfDay = h
    // 循环中每 2 秒记一次
    const now = performance.now()
    if (now - savedAt > 2000) {
      savedAt = now
      storeSet('timeOfDay', h.toFixed(2))
    }
  }
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__scene = scene
  syncActive()
  bindPanZoom(e.v2, map, applyMap, { min: 0.15, max: 24, fit: fitMap })
  window.addEventListener('resize', () => ws.mode === '2d' && fitMap())
  e.stage.addEventListener('pointermove', (ev) => {
    cancelAnimationFrame(probeRaf)
    probeRaf = requestAnimationFrame(() => probeAt(ev.clientX, ev.clientY))
  })
  e.stage.addEventListener('pointerleave', () => (ws.probe = null))
  if (waiters.length && jobId === 0) generate()
  else start()
  // 舞台重新挂载（开发时热更新）：旧的纸图查看器挂在已卸下的节点上，换一个新的
  if (viewer) {
    viewer = null
    atlasCanvas = null
    if (ws.mode === '2d' && world) refreshAtlas()
  }
}

function syncActive() {
  if (scene) scene.active = app.module === 'world' && ws.mode === '3d'
}
// 第一次进入世界模块时才生成
function start() {
  if (app.module === 'world' && els && jobId === 0) generate()
}
watch(
  () => app.module,
  () => {
    syncActive()
    start()
  },
)

// —— 参数 ——
export function markDirty(d = true) {
  ws.dirty = d
  if (d) ws.preset = -1
}
export function setParam<K extends keyof WorldParams>(k: K, v: WorldParams[K]) {
  ws.params[k] = v
  markDirty()
}
export function resetParams() {
  Object.assign(ws.params, { ...DEFAULT_PARAMS, seed: ws.params.seed })
  markDirty()
}
export function applyPreset(i: number) {
  Object.assign(ws.params, PRESETS[i].p)
  generate()
  ws.preset = i
}

const SYL = ['ar', 'en', 'is', 'or', 'ul', 'va', 'mi', 'ko', 'ra', 'the', 'lo', 'san', 'dra', 'nor', 'eth', 'wyn', 'ka', 'mel']
export function randomSeed() {
  ws.params.seed = syllableSeed(SYL)
  generate()
}

// —— 3D 选项 ——
let exTimer = 0
/** 拖滑块时每一帧都会改参数：写存储稍等停手再做 */
const persistTimers = new Map<string, number>()
function persistLater(k: string, v: () => string) {
  clearTimeout(persistTimers.get(k))
  persistTimers.set(k, window.setTimeout(() => storeSet(k, v()), 300))
}
export function set3d(patch: Partial<View3DOptions>) {
  Object.assign(ws.view3d, patch)
  if (patch.quality) storeSet('quality', patch.quality)
  if (patch.shadowSoftness !== undefined) persistLater('shadowSoftness', () => String(ws.view3d.shadowSoftness))
  if (patch.timeOfDay !== undefined) persistLater('timeOfDay', () => ws.view3d.timeOfDay.toFixed(2))
  if (patch.dayCycle !== undefined) storeSet('dayCycle', patch.dayCycle ? '1' : '0')
  // 垂直夸张要重建网格：拖动时稍等再应用
  if (patch.exaggeration !== undefined) {
    clearTimeout(exTimer)
    exTimer = window.setTimeout(() => scene?.setOptions({ exaggeration: ws.view3d.exaggeration }), 120)
    return
  }
  scene?.setOptions(structuredClone(toRaw(patch)))
}
export function setLook(patch: Partial<Look>) {
  Object.assign(ws.view3d.look, patch)
  const look = { ...toRaw(ws.view3d.look) }
  scene?.setOptions({ look })
  persistLater('look', () => JSON.stringify(look))
}
export function pickLook(id: string) {
  ws.lookId = id
  storeSet('lookId', id)
  ws.view3d.look = structuredClone(LOOKS.find((l) => l.id === id)!.look)
  setLook({})
}

// —— 纸图 ——
export function setAtlasStyle(s: StyleId) {
  ws.atlasStyle = s
  storeSet('atlasStyle', s)
  refreshAtlas()
}
export function setAtlasOpt(k: keyof typeof ws.atlasOpts, v: boolean) {
  ws.atlasOpts[k] = v
  atlasCache.clear()
  refreshAtlas()
}

// —— 视图切换 ——
export function toggleTour() {
  scene?.toggleTour()
}

export function setMode(m: Mode) {
  if (m !== '3d') scene?.stopTour()
  ws.mode = m
  syncActive()
  ws.probe = null
  if (m === '3d' && sceneStale && world && lastTex) {
    scene!.setWorld(world, lastTex.color, lastTex.roughness, rivers)
    sceneStale = false
  }
  if (m === '2d' && world) refreshAtlas()
  if (m === 'edit') {
    ensureEditor()
    if (world && lastTex) editor!.setWorld(world, lastTex.color, edits, genEdits)
  }
}

// —— 生成 ——
const worker = new GenWorker()
let jobId = 0
let quietJob = false
export function generate(quiet = false) {
  const id = ++jobId
  const p = ws.params
  p.seed = p.seed.trim() || 'world'
  // 换了种子：编辑是针对旧世界的，询问后清除
  if (p.seed !== editsSize.seed && hasEdits(edits)) {
    if (!window.confirm(t('换种子会生成一个全新的世界，当前的编辑将被清除。继续吗？'))) {
      p.seed = editsSize.seed
      return
    }
    edits = {}
    undoStack.length = 0
  }
  // 换了分辨率：编辑按比例重采样
  if ((p.width !== editsSize.W || p.height !== editsSize.H) && hasEdits(edits)) edits = resampleEdits(edits, editsSize.W, editsSize.H, p.width, p.height)
  editsSize = { W: p.width, H: p.height, seed: p.seed }
  storeSet('worldQuery', worldQuery().toString())
  syncRoute('world')
  markDirty(false)
  quietJob = quiet
  if (quiet) ws.editStatus = t('演算中…')
  else Object.assign(ws.loading, { show: true, frac: 0 })
  ws.busy = true
  sentEdits = snapshotEdits(edits)
  worker.postMessage({ id, params: { ...toRaw(p) }, edits: { ...edits } })
}
worker.onmessage = async (ev: MessageEvent<WorkerOut>) => {
  const m = ev.data
  if (m.id !== jobId) return
  if (m.type === 'progress') {
    ws.loading.stage = t(m.stage)
    ws.loading.frac = m.frac
    if (quietJob) ws.editStatus = t('演算中 · {stage}', { stage: t(m.stage) })
    return
  }
  if (m.type === 'error') {
    ws.loading.stage = t('生成失败：') + m.message.split('\n')[0]
    ws.busy = false
    console.error(m.message)
    flushWaiters()
    return
  }
  const next = markRaw(m.world)
  const places = placeSig(next)
  // 地面与地点位置都没变（例如只改了命名）：只换名字，不重建地表贴图与 3D 场景
  if (world && lastTex && m.ground === lastGround && places === lastPlaces) {
    world = next
    if (!sceneStale) scene!.setNames(world)
    genEdits = sentEdits
    if (edits.regions) syncContinentLabels()
    editor?.setWorld(world, lastTex.color, edits, genEdits)
    atlasCache.clear()
    if (ws.mode === '2d') await refreshAtlas()
    showStats(world, m.cached)
    ws.loading.show = false
    ws.editStatus = null
    ws.busy = false
    flushWaiters()
    return
  }
  ws.loading.stage = t('绘制地表')
  await new Promise((r) => setTimeout(r, 16))
  world = next
  rivers = smoothRivers(world)
  try {
    const tex = buildPhysicalTexture(world, rivers, 2)
    lastTex = tex
    // 编辑视图里不重建 3D（较慢），切回 3D 时再建
    if (ws.mode === '3d' || !editor) {
      scene!.setWorld(world, tex.color, tex.roughness, rivers)
      sceneStale = false
    } else sceneStale = true
    genEdits = sentEdits
    // 大洲名随区域走（重算后的地点列表里补回）
    if (edits.regions) syncContinentLabels()
    editor?.setWorld(world, tex.color, edits, genEdits)
    lastGround = m.ground
    lastPlaces = places
  } catch (err) {
    console.error(err)
    ws.loading.stage = t('绘制失败：') + (err instanceof Error ? err.message : String(err))
    ws.busy = false
    flushWaiters()
    return
  }
  atlasCanvas = null
  atlasCache.clear()
  if (ws.mode === '2d') await refreshAtlas()
  showStats(world, m.cached)
  ws.loading.show = false
  ws.editStatus = null
  ws.busy = false
  flushWaiters()
}

let statsCached = false
function showStats(w: World, cached = statsCached) {
  statsCached = cached
  const s = w.stats
  const m = (km: number) => `${Math.round(km * 1000).toLocaleString()} m`
  ws.info = {
    title: worldTitle(w),
    time: cached ? t('缓存') : `${(s.ms / 1000).toFixed(1)} s`,
    tiles: [
      ['陆地', pct(s.land)],
      ['最高峰', m(s.peak)],
      ['最深处', m(s.trench)],
      ['河流', String(s.rivers)],
      ['湖泊', String(s.lakes)],
      ['跨度', `${Math.round(w.W * w.kmPerCell).toLocaleString()} km`],
    ],
  }
}

// —— 纸图 ——
let atlasJob = 0
/** 地点或名字改了但纸图缓存还没清：推迟到下次要用纸图时（改名逐键触发，编辑视图里又看不到纸图） */
let atlasStale = false
function takeStale() {
  if (!atlasStale) return
  atlasCache.clear()
  atlasStale = false
}
async function buildList(w: World, style: StyleId) {
  takeStale()
  let list = atlasCache.get(style)
  if (list) return list
  const { buildAtlasVector } = await import('../../render/atlas/svg/vector')
  const measurer = document.createElement('canvas').getContext('2d')!
  list = buildAtlasVector(w, rivers, style, toRaw(ws.atlasOpts), measurer, 2)
  atlasCache.set(style, list)
  return list
}
async function refreshAtlas() {
  if (!world || !els) return
  const w = world
  const style = ws.atlasStyle
  const job = ++atlasJob
  takeStale()
  if (!atlasCache.has(style)) {
    Object.assign(ws.loading, { show: true, frac: 1, stage: t('矢量绘制{style}', { style: t(THEMES.find((th) => th.id === style)!.name) }) })
    await ensureFonts(w, style)
    await new Promise((r) => setTimeout(r, 20))
    if (job !== atlasJob || w !== world) return
  }
  const list = await buildList(w, style)
  ws.loading.show = false
  if (job !== atlasJob) return
  const keepView = atlasCanvas !== null && atlasCanvas.width === list.width && atlasCanvas.height === list.height
  atlasCanvas = { width: list.width, height: list.height }
  shown = list
  if (!viewer) viewer = markRaw(new AtlasViewer(els.v2))
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__viewer = viewer
  // 图框模式：图廓固定在舞台上、贴着地图收拢或铺满可用区，缩放只动图框里的地图（导出仍是整页排版）
  viewer.setChrome((cw, ch, box) => buildAtlasChrome(w, style, list, map, chromeMeasurer, cw, ch, box, probeCard()), atlasBackdrop(style), atlasFrameInset(style))
  viewer.setList(list)
  if (!keepView) fitMap()
  else applyMap()
}

// —— 2D 平移缩放 ——
const map = { x: 0, y: 0, k: 1 }
/** 当前显示的纸图显示列表（适配视图要用它的地图框尺寸） */
let shown: DisplayList | null = null
const chromeMeasurer = document.createElement('canvas').getContext('2d')!
function applyMap() {
  viewer?.setView(map.x, map.y, map.k)
}
/** 把地图（不含整页排版的留白）整个放进图框内框，四周留一点空 */
function fitMap() {
  if (!shown || !viewer || !els) return
  const r = viewer.inner()
  const pad = 12
  const k = Math.min((r.w - pad * 2) / shown.MW, (r.h - pad * 2) / shown.MH)
  map.k = k
  map.x = r.x + (r.w - shown.MW * k) / 2 - shown.M * k
  map.y = r.y + (r.h - shown.MH * k) / 2 - shown.M * k
  applyMap()
}

/** 纸图里的悬停读数画进图廓（跟着地图的纸色与字体）；3D、编辑视图仍用浮层 */
const probeCard = () => {
  const p = ws.mode === '2d' ? ws.probe : null
  return p && { title: t(p.title), rows: p.rows.map(([k, v]): [string, string] => [t(k), v]) }
}
watch(
  () => ws.probe,
  () => ws.mode === '2d' && viewer?.refreshChrome(),
)

// —— 探针：悬停查看地点信息 ——
let probeRaf = 0
function probeAt(clientX: number, clientY: number) {
  if (!world || !els) return
  let cell: { x: number; y: number } | null = null
  if (ws.mode === '3d') cell = scene!.pick(clientX, clientY)
  else if (ws.mode === 'edit' && editor) {
    const r = els.ve.getBoundingClientRect()
    const c = editor.toCell(clientX - r.left, clientY - r.top)
    cell = { x: Math.floor(c.x), y: Math.floor(c.y) }
  } else if (atlasCanvas && viewer) {
    const r = els.v2.getBoundingClientRect()
    const sx = clientX - r.left
    const sy = clientY - r.top
    // 图框外（纸边、图廓）不读数
    const f = viewer.frame()
    const M = (atlasCanvas.width - world.W * 2) / 2
    const x = Math.floor(((sx - map.x) / map.k - M) / 2)
    const y = Math.floor(((sy - map.y) / map.k - M) / 2)
    if (sx >= f.x && sy >= f.y && sx <= f.x + f.w && sy <= f.y + f.h && x >= 0 && y >= 0 && x < world.W && y < world.H) cell = { x, y }
  }
  if (!cell || cell.x < 0 || cell.y < 0 || cell.x >= world.W || cell.y >= world.H) {
    ws.probe = null
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
  ws.probe = { title: BIOME_NAMES[world.biome[i]], rows }
}

// —— 导出 ——
export async function exportPng() {
  if (!world || !els) return
  let url: string
  if (ws.mode === '3d') url = scene!.snapshot()
  else {
    // 由矢量显示列表按 2 倍分辨率栅格化
    await ensureFonts(world, ws.atlasStyle)
    const list = await buildList(world, ws.atlasStyle)
    if (!viewer) viewer = markRaw(new AtlasViewer(els.v2))
    viewer.setList(list)
    url = viewer.rasterize(2).toDataURL('image/png')
  }
  download(url, `${world.worldName.toLowerCase()}-${ws.params.seed}-${ws.mode === '3d' ? '3d' : ws.atlasStyle}.png`)
}
/** 矢量导出：纸图的全部底色、线划、符号与注记都是路径和文字 */
export async function exportSvg() {
  if (!world) return
  const w = world
  Object.assign(ws.loading, { show: true, frac: 1, stage: t('矢量化：追踪等值线与区域轮廓') })
  await ensureFonts(w, ws.atlasStyle)
  await new Promise((r) => setTimeout(r, 20))
  try {
    const svg = (await buildList(w, ws.atlasStyle)).toSVG()
    download(new Blob([svg], { type: 'image/svg+xml' }), `${w.worldName.toLowerCase()}-${ws.params.seed}-${ws.atlasStyle}.svg`)
  } finally {
    ws.loading.show = false
  }
}

// —— URL 同步：分享链接即可复现同一世界（#/world?seed=...，只写与默认值不同的参数，种子总是写上） ——
function worldQuery() {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(ws.params)) if (k === 'seed' || (DEFAULT_PARAMS as unknown as Record<string, unknown>)[k] !== v) q.set(k, String(v))
  return q
}
function readQuery(q: URLSearchParams): Partial<WorldParams> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of q) {
    if (!(k in DEFAULT_PARAMS)) continue
    const d = (DEFAULT_PARAMS as unknown as Record<string, unknown>)[k]
    if (typeof d === 'number') {
      if (Number.isFinite(Number(v))) out[k] = Number(v)
    } else if (typeof d === 'boolean') out[k] = v === 'true' || v === '1'
    else out[k] = v
  }
  return out as Partial<WorldParams>
}
// 地址被外部改动（前进后退、手改地址栏）：换成地址里的参数重新生成
registerRoute('world', {
  query: worldQuery,
  apply(q) {
    Object.assign(ws.params, { ...DEFAULT_PARAMS, ...readQuery(q) })
    ws.preset = -1
    generate()
  },
})

// —— 项目：保存 / 打开 ——
export async function saveProject() {
  const text = await serializeProject(toRaw(ws.params), edits)
  download(new Blob([text], { type: 'application/json' }), `${(world?.worldName ?? 'world').toLowerCase()}-${ws.params.seed}.cartographer.json`)
}
export async function openProject(f: File) {
  try {
    const doc = await parseProject(await f.text())
    Object.assign(ws.params, doc.params)
    edits = doc.edits
    editsSize = { W: ws.params.width, H: ws.params.height, seed: ws.params.seed }
    undoStack.length = 0
    generate()
  } catch (err) {
    window.alert(t('无法打开：') + t(err instanceof Error ? err.message : String(err)))
  }
}

// —— 编辑视图 ——
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
export function undo() {
  const prev = undoStack.pop()
  if (!prev) return
  edits = prev
  edits.terrainRev = (edits.terrainRev ?? 0) + 1
  editor?.refreshEdits(edits)
  scheduleRegen()
}
export function clearEdits() {
  if (!hasEdits(edits) || !window.confirm(t('清除全部编辑，恢复为程序生成的原样？'))) return
  pushUndo()
  edits = { terrainRev: (edits.terrainRev ?? 0) + 1 }
  editor?.refreshEdits(edits)
  scheduleRegen()
}
function ensureEditor() {
  if (editor || !els) return
  editor = markRaw(
    new EditorView(els.ve, {
      onBeforeEdit: pushUndo,
      onCommit: (kind) => {
        // 大洲只影响标注，不必重算
        if (kind === 'regions') {
          syncContinentLabels(true)
          editor?.draw()
          return
        }
        if (kind === 'labels' && world) {
          edits.labels = world.labels.map((l) => ({ ...l }))
          // 地点改动立即反映到纸图与 3D 地名，政区在重算后更新
          atlasStale = true
          scene!.refreshLabels()
        }
        scheduleRegen()
      },
      onSelect: showInspector,
      onRegionSelect: showRegionInspector,
    }),
  )
  Object.assign(editor.brush, toRaw(ws.brush))
  editor.showNames = ws.showNames
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__editor = editor
}
export function setTool(id: EditTool) {
  ensureEditor()
  if (id.startsWith('region')) ensureRegions()
  editor!.setTool(id)
  ws.tool = id
}
export function setBrush(patch: Partial<typeof ws.brush>) {
  Object.assign(ws.brush, patch)
  ensureEditor()
  Object.assign(editor!.brush, patch)
}
export function setShowNames(v: boolean) {
  ws.showNames = v
  ensureEditor()
  editor!.showNames = v
  editor!.draw()
}
export function setEditView(v: 'auto' | EditView) {
  ws.editView = v
  ensureEditor()
  editor!.setView(v === 'auto' ? null : v)
}

// 地点检查器
let inspEditing = false
function commitLabels() {
  edits.labels = world ? world.labels.map((l) => ({ ...l })) : edits.labels
  atlasStale = true
  scene?.refreshLabels()
  editor?.draw()
}
/** 只改了一个地点的名字（逐键触发）：只同步 edits 里的对应项与 3D 里的那一个地名，纸图推迟到下次显示再重建 */
function renamed(l: Label) {
  const w = world
  if (!w) return
  const i = w.labels.indexOf(l)
  const copy = edits.labels?.length === w.labels.length ? edits.labels[i] : undefined
  if (copy && copy.kind === l.kind && copy.x === l.x && copy.y === l.y) Object.assign(copy, { name: l.name, zh: l.zh, ja: l.ja })
  else edits.labels = w.labels.map((x) => ({ ...x }))
  atlasStale = true
  scene?.renameLabel(l)
  editor?.draw()
}
/** 改名：连续输入只记一次撤销 */
export function editLabelName(key: 'name' | 'zh' | 'ja', v: string) {
  const l = editor?.selected
  if (!l || !ws.insp) return
  if (!inspEditing) pushUndo()
  inspEditing = true
  l[key] = v
  ws.insp[key] = v
  renamed(l)
}
export function endLabelEdit() {
  inspEditing = false
}
export function setLabelKind(k: Label['kind']) {
  const l = editor?.selected
  if (!l || !ws.insp) return
  pushUndo()
  l.kind = k
  ws.insp.kind = k
  commitLabels()
  scheduleRegen()
}
export function deleteSelected() {
  const l = editor?.selected
  if (!l || !world) return
  pushUndo()
  world.labels.splice(world.labels.indexOf(l), 1)
  editor!.select(null)
  edits.labels = world.labels.map((x) => ({ ...x }))
  atlasStale = true
  scene?.refreshLabels()
  scheduleRegen()
}
function showInspector(l: Label | null) {
  inspEditing = false
  ws.insp = l ? { name: l.name, zh: l.zh, ja: l.ja ?? '', kind: l.kind } : null
}

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
/** 各区域的大洲名锚点（整图扫描加 BFS，较慢）：按区域编号缓存，区域数组换了或被涂改时作废 */
const anchors = new Map<number, ReturnType<typeof regionAnchor>>()
let anchorsOf: Int16Array | null = null
/** 当前世界里各区域对应的大洲名标注（改名时原地改它） */
const contLabels = new Map<number, Label>()
/** 大洲名放到各区域最宽阔处；地点列表原地替换（编辑视图持有同一个数组）。regionsChanged：区域格子被涂改过 */
function syncContinentLabels(regionsChanged = false) {
  const w = world
  const reg = edits.regions
  if (!w || !reg || reg.length !== w.W * w.H) return
  if (regionsChanged || anchorsOf !== reg) {
    anchors.clear()
    anchorsOf = reg
  }
  const others = w.labels.filter((l) => l.kind !== 'continent')
  const conts: Label[] = []
  contLabels.clear()
  ;(edits.regionMeta ?? []).forEach((m, id) => {
    let a = anchors.get(id)
    if (a === undefined) anchors.set(id, (a = regionAnchor(reg, w.W, w.H, id)))
    if (!a) return
    const l: Label = { kind: 'continent', name: m.name, zh: m.zh, ja: m.ja, x: a.x, y: a.y, angle: 0, weight: 1000 + a.area / 20, span: a.span }
    conts.push(l)
    contLabels.set(id, l)
  })
  w.labels.splice(0, w.labels.length, ...conts, ...others)
  edits.labels = w.labels.map((l) => ({ ...l }))
  atlasStale = true
  scene?.refreshLabels()
}
export function autoRegions() {
  if (!world || !editor) return
  const { W, H } = world
  const land = editor.landMask()
  let landN = 0
  for (const v of land) landN += v
  const reg = autoContinents(land, world.coastDist, W, H, ws.neck * (W / 1024), Math.max(400, landN * 0.02))
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
}
function showRegionInspector(id: number) {
  const m = edits.regionMeta?.[id]
  ws.region = m ? { name: m.name, zh: m.zh, ja: m.ja ?? '' } : null
}
export function editRegionName(key: 'name' | 'zh' | 'ja', v: string) {
  const m = edits.regionMeta?.[editor?.selectedRegion ?? -1]
  if (!m || !ws.region) return
  m[key] = v
  ws.region[key] = v
  // 只改名：区域没动，原地改对应的那条大洲名
  const l = contLabels.get(editor!.selectedRegion)
  if (l && world?.labels.includes(l)) {
    l[key] = v
    renamed(l)
  } else {
    syncContinentLabels()
    editor?.draw()
  }
}
export function deleteRegion() {
  const id = editor?.selectedRegion ?? -1
  const reg = edits.regions
  if (!reg || id < 0) return
  pushUndo()
  for (let i = 0; i < reg.length; i++) if (reg[i] === id) reg[i] = -1
  anchors.delete(id)
  syncContinentLabels()
  editor!.selectRegion(-1)
}

// —— 快捷键 ——
window.addEventListener('keydown', (e) => {
  if (app.module !== 'world') return
  const typing = isTypingTarget(e)
  if (ws.mode === 'edit' && !typing) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      undo()
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && editor?.selected) deleteSelected()
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing) return
  if (e.key === 'r' || e.key === 'R') randomSeed()
})

// —— 语言：地图文字重排版 ——
onLang(async () => {
  ws.probe = null
  if (!world) return
  showStats(world)
  await document.fonts.load(`600 20px ${lang === 'ja' ? '"Noto Serif JP"' : '"Noto Serif SC"'}`, worldTitle(world) + [...world.labels, ...world.realms].map((l) => placeName(l)).join(''))
  atlasCache.clear()
  if (ws.mode === '2d') refreshAtlas()
  scene?.refreshLanguage()
  editor?.draw()
})
