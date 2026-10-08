import { markRaw, reactive, toRaw, watch } from 'vue'
import { latitudeOf } from '../../gen/climate'
import { regionProjection } from '../../gen/earth/region'
import { hasEdits, parseProject, resampleEdits, serializeProject, snapshotEdits } from '../../app/project'
import { deleteWorld, getMeta, getWorld as getEntry, listWorlds, newWorldId, putMeta, putWorld, renameWorld, type LibraryMeta } from '../../app/library'
import { EditorView, isSketchTool, type EditTool, type EditView } from '../../editor/editor'
import { bumpSketch, sketchFromWorld } from '../../gen/sketch'
import { autoContinents, floodLand, regionAnchor } from '../../editor/layers'
import { BIOME_NAMES, DEFAULT_PARAMS, isSettlement, normalizeParams, type Label, type World, type WorldEdits, type WorldParams } from '../../gen/types'
import { inferAreas, isWaterArea, type Area, type AreaKind } from '../../gen/areas'
import { earthAreas } from '../../gen/earth/realWorld'
import { THEMES, ensureFonts, type StyleId } from '../../render/atlas'
import { atlasBackdrop, atlasFrameInset, buildAtlasChrome } from '../../render/atlas/svg/chrome'
import type { DisplayList } from '../../render/atlas/svg/displayList'
import type { AtlasBase } from '../../render/atlas/svg/vector'
import { AtlasViewer } from '../../render/atlas/svg/viewer'
import type { SmoothRiver } from '../../render/rivers'
import { Scene3D, type View3DOptions } from '../../render/scene3d'
import { HoloScene, type HoloOptions } from '../../render/holo/scene'
import { HOLO_PALETTES } from '../../render/holo/palettes'
import { LOOKS, QUALITIES, type Look, type QualityId } from '../../render/aerial/looks'
import { DEFAULT_TIME } from '../../render/aerial/daylight'
import { buildPhysicalTexture, textureCanvases } from '../../render/texture'
import type { WorkerIn, WorkerOut } from '../../worker'
import GenWorker from '../../worker?worker'
import { defineStrings, lang, onLang, placeName, worldTitle } from '../../i18n'
import { app, download, initialQuery, registerRoute, paramSig, storeGet, storeSet, syncRoute } from '../app'
import { t } from '../i18n'
import { isTypingTarget } from '../keys'
import { mapFontsReady } from '../fonts'
import { bindPanZoom } from '../panZoom'
import { syllableSeed } from '../seed'

export type Mode = '3d' | 'holo' | '2d' | 'edit' | 'areas'

export const pct = (v: number) => `${Math.round(v * 100)}%`
export const latFmt = (v: number) => `${Math.abs(v)}°${v > 0 ? 'N' : v < 0 ? 'S' : ''}`
export const lonFmt = (v: number) => `${Math.abs(v)}°${v > 0 ? 'E' : v < 0 ? 'W' : ''}`

// 预设：一键换一类世界
export const PRESETS: { name: string; desc: string; p: Partial<WorldParams> }[] = [
  { name: '大陆', desc: '几块中等大小的大陆，温带为主', p: { globe: false, earth: false, earthReal: false, landRatio: 0.36, plates: 14, mountains: 1, coastRoughness: 0.55, rainfall: 1, temperature: 0, latNorth: 64, latSouth: 14 } },
  { name: '群岛', desc: '破碎的岛链与浅海，热带到亚热带', p: { globe: false, earth: false, earthReal: false, landRatio: 0.2, plates: 22, mountains: 1.2, coastRoughness: 0.85, rainfall: 1.2, temperature: 3, latNorth: 30, latSouth: -30 } },
  { name: '泛大陆', desc: '一整块超级大陆，内陆干旱、山系绵长', p: { globe: false, earth: false, earthReal: false, landRatio: 0.56, plates: 9, mountains: 1.3, coastRoughness: 0.4, rainfall: 0.85, temperature: 1, latNorth: 55, latSouth: -40 } },
  { name: '冰原', desc: '高纬寒冷，冰盖、苔原与峡湾', p: { globe: false, earth: false, earthReal: false, landRatio: 0.4, plates: 12, mountains: 1.1, coastRoughness: 0.9, rainfall: 0.9, temperature: -9, latNorth: 82, latSouth: 42 } },
  { name: '沙海', desc: '炎热少雨，沙漠与盐湖广布', p: { globe: false, earth: false, earthReal: false, landRatio: 0.48, plates: 11, mountains: 0.8, coastRoughness: 0.5, rainfall: 0.4, temperature: 5, latNorth: 40, latSouth: 5 } },
  { name: '类地球', desc: '全球全图：几块大陆隔着大洋，从赤道雨林到两极冰原', p: { globe: true, earth: false, earthReal: false, landRatio: 0.29, plates: 16, mountains: 1.1, coastRoughness: 0.6, rainfall: 1, temperature: 0, latNorth: 80, latSouth: -62 } },
  { name: '地球', desc: '真实地球的大陆、山脉与海深（ETOPO1），地名仍是虚构的', p: { globe: true, earth: true, earthReal: false, mountains: 1, coastRoughness: 0.5, rainfall: 1, temperature: 0, latNorth: 84, latSouth: -58 } },
  { name: '真实地球', desc: '高程、气候、群系、河湖与自然地物名称都取自真实数据；没有城市与国家', p: { globe: true, earth: true, earthReal: true, rainfall: 1, temperature: 0, latNorth: 84, latSouth: -58 } },
  {
    name: '中国',
    desc: '中国区域图：真实地形（ETOPO 2022）、气候与河湖，省级与地级行政区划、国界与南海断续线；周边只显示地形',
    p: { region: 'china', globe: false, earth: true, earthReal: true, width: 1450, rainfall: 1, temperature: 0 },
  },
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

export const HOLO_DEFAULTS: HoloOptions = { palette: HOLO_PALETTES[0].id, exaggeration: 14, labels: true, hud: true, sectionHeight: 1 }
function loadHolo(): HoloOptions {
  try {
    const o = { ...HOLO_DEFAULTS, ...JSON.parse(storeGet('holo') ?? '{}') }
    if (!HOLO_PALETTES.some((p) => p.id === o.palette)) o.palette = HOLO_DEFAULTS.palette
    return o
  } catch {
    return { ...HOLO_DEFAULTS }
  }
}

// —— 界面状态（响应式） ——
export type WorldTab = 'gen' | 'view' | 'stats'
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
  /** 全息沙盘的选项 */
  holo: loadHolo(),
  atlasStyle: ((storeGet('atlasStyle') as StyleId) || 'physical') as StyleId,
  atlasOpts: { labels: true, contours: true, graticule: true },
  /** 纸图的图饰：标题框、指北针、图例（默认不画，只影响浏览器里的图廓层；导出总是画） */
  ornaments: storeGet('atlasOrnaments') === '1',
  mode: '3d' as Mode,
  /** 浏览器创建不了 WebGL（显卡加速被停用等）：3D 沙盘里只显示说明，纸图与编辑照常 */
  no3d: false,
  /** 侧边栏当前的分页：生成、视图（随模式是沙盘、纸图风格或编辑）、统计 */
  tab: (['gen', 'view', 'stats'].includes(storeGet('worldTab') ?? '') ? storeGet('worldTab') : 'gen') as WorldTab,
  /** 参数改了但还没重新生成 */
  dirty: false,
  /** 区域视图：编辑中的区域（改了就写进 edits.areas）与选中的那个 */
  areas: [] as Area[],
  areaSel: null as string | null,
  /** 区域改过（存着完整的列表，不再跟着自动推断） */
  areasEdited: false,
  /** 纸图当前在舞台上的位置（区域视图的叠加层跟着它）：页面坐标 → 屏幕 = (x + 页面·k)；地图格 → 页面 = M + (格 + 0.5)·S；frame 是露出地图的图框内框 */
  /** 纸图的视图（区域叠加层用）：half 是格中心相对格左上角的偏移（格 (x, y) 的中心在 x + 0.5） */
  paper: { x: 0, y: 0, k: 1, M: 0, S: 2, half: 0.5, frame: { x: 0, y: 0, w: 0, h: 0 } },
  /** 当前世界生成时所用的参数（滑杆双击回到这里） */
  applied: null as WorldParams | null,
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
  /** 有规划草图（大陆形状与山脉走向由草图决定） */
  sketch: false,
  /** 选中的草图山脉 */
  range: null as { height: number; width: number } | null,
  /** 已定稿：地形是数据，与种子、地形参数、草图无关 */
  frozen: false,
  /** 当前世界对应的世界库条目（保存时覆盖它） */
  entry: null as { id: string; name: string } | null,
  /** 世界库面板 */
  library: { open: false, items: [] as LibraryMeta[], busy: false },
  /** 自动运镜中 */
  touring: false,
})

// —— 引擎（非响应式） ——
let scene: Scene3D | null = null
/** 全息沙盘：第一次切到全息视图时才创建（另占一个 WebGL 上下文） */
let holo: HoloScene | null = null
/** 全息沙盘当前显示的世界：与 world 不同时，切到全息视图再重建 */
let holoWorld: World | null = null
/** 全息里的地名过期了（不可见时改了地名或语言）：切到全息视图时只重排注记 */
let holoNamesStale = false
let viewer: AtlasViewer | null = null
let editor: EditorView | null = null
let els: { stage: HTMLElement; v3: HTMLElement; vh: HTMLElement; v2: HTMLElement; ve: HTMLElement } | null = null
let world: World | null = null
let rivers: SmoothRiver[] = []
/**
 * 每种风格缓存一份矢量显示列表（预览、SVG 导出、PNG 导出共用）。
 * base 是不含地图注记的部分：区域改动只作废 list，按新区域重录注记即可
 */
const atlasCache = new Map<string, { base: AtlasBase; list: DisplayList | null }>()
/** 区域改了：各风格只重排注记 */
function relabelAtlas() {
  for (const c of atlasCache.values()) c.list = null
}
/** 查看器当前列表所用的底：同一个底换列表时只重画注记层 */
let shownBase: AtlasBase | null = null
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
/** 撤销记录：编辑快照 + 当时的地形、聚落方案（换方案也能撤销） */
const undoStack: { edits: WorldEdits; terrainVariant: number; placeVariant: number }[] = []
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
  try {
    scene = markRaw(new Scene3D(e.v3, structuredClone(toRaw(ws.view3d))))
  } catch (err) {
    // 没有 WebGL 时先显示纸图（3D 页签里说明原因），别让异常中断整个界面的挂载（聚落模块也在同一轮挂载）
    console.error(err)
    ws.no3d = true
    ws.mode = '2d'
  }
  if (scene) {
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
  }
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__scene = scene
  syncActive()
  bindPanZoom(e.v2, map, applyMap, { min: 0.15, max: 24, fit: fitMap })
  window.addEventListener('resize', () => paperMode() && fitMap())
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
    if (paperMode() && world) refreshAtlas()
  }
}

/** 纸图或区域视图（区域视图的底图就是纸图） */
const paperMode = () => ws.mode === '2d' || ws.mode === 'areas'

function syncActive() {
  if (scene) scene.active = app.module === 'world' && ws.mode === '3d'
  if (holo) holo.active = app.module === 'world' && ws.mode === 'holo'
}

/** 全息视图可见时：按需创建并换上当前世界 */
function syncHolo() {
  if (ws.mode !== 'holo' || !els || ws.no3d) return
  if (!holo) {
    try {
      holo = markRaw(new HoloScene(els.vh, structuredClone(toRaw(ws.holo))))
    } catch (err) {
      console.error(err)
      ws.no3d = true
      return
    }
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__holo = holo
    syncActive()
  }
  if (!world) return
  if (holoWorld !== world) {
    holoWorld = world
    holoNamesStale = false
    holo.setWorld(world)
  } else if (holoNamesStale) {
    holoNamesStale = false
    holo.refreshLabels()
  }
}
/** 地名或语言变了：全息里的注记重排（不可见时等下次切过去再排） */
function relabelHolo() {
  holoNamesStale = true
  syncHolo()
}
/** 地点增删改：纸图推迟重建，3D 与全息的地名重排 */
function labelsChanged() {
  atlasStale = true
  scene?.refreshLabels()
  relabelHolo()
}

export function setHolo(patch: Partial<HoloOptions>) {
  Object.assign(ws.holo, patch)
  storeSet('holo', JSON.stringify(toRaw(ws.holo)))
  holo?.setOptions(patch)
}
export function resetHoloView() {
  holo?.resetView()
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
/** 参数改动后调用：与当前世界所用的参数比较，改回原样就不再算改过 */
export function markDirty() {
  ws.dirty = !!ws.applied && paramSig(ws.params) !== paramSig(ws.applied)
  ws.preset = -1
}
export function setParam<K extends keyof WorldParams>(k: K, v: WorldParams[K]) {
  ws.params[k] = v
  // 改地图类型（全球图、地球底图、真实地球）就不再是区域图
  if (k === 'globe' || k === 'earth' || k === 'earthReal') ws.params.region = undefined
  // 全球图的高度随纬度范围走；开关全球图时换宽高比
  // 关掉全球图时地球底图一并关掉（地球底图总是全球图，见 normalizeParams）
  if (k === 'globe' && !v) ws.params.earth = false
  // 真实地球建立在地球底图之上：关掉底图时一并关掉
  if ((k === 'globe' || k === 'earth') && !v) ws.params.earthReal = false
  normalizeParams(ws.params)
  markDirty()
}
export function resetParams() {
  Object.assign(ws.params, { ...DEFAULT_PARAMS, seed: ws.params.seed })
  normalizeParams(ws.params)
  markDirty()
}
/** 预设只填入参数，点「生成」才生效 */
export function applyPreset(i: number) {
  // 预设没写区域的就不是区域图；离开区域图时宽度回到默认（区域图的宽度另成一套）
  const leaving = ws.params.region && !PRESETS[i].p.region
  Object.assign(ws.params, { region: undefined }, PRESETS[i].p)
  if (leaving) ws.params.width = DEFAULT_PARAMS.width
  normalizeParams(ws.params)
  markDirty()
  ws.preset = i
}

const SYL = ['ar', 'en', 'is', 'or', 'ul', 'va', 'mi', 'ko', 'ra', 'the', 'lo', 'san', 'dra', 'nor', 'eth', 'wyn', 'ka', 'mel']
export function randomSeed() {
  // 定稿的世界与种子无关：换种子要先回到规划
  if (ws.frozen) return
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
export function setOrnaments(v: boolean) {
  ws.ornaments = v
  storeSet('atlasOrnaments', v ? '1' : '0')
  viewer?.refreshChrome()
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

export function setTab(tab: WorldTab) {
  ws.tab = tab
  storeSet('worldTab', tab)
}

export function setMode(m: Mode) {
  // 编辑要用侧边栏里的工具：进编辑时翻到视图页
  if (m === 'edit') setTab('view')
  if (m !== '3d') scene?.stopTour()
  ws.mode = m
  syncActive()
  syncHolo()
  ws.probe = null
  if (m === '3d' && sceneStale && world && lastTex) {
    scene?.setWorld(world, lastTex.color, lastTex.roughness, rivers)
    sceneStale = false
  }
  if (m === 'areas') {
    setTab('view')
    loadAreas()
  }
  if ((m === '2d' || m === 'areas') && world) refreshAtlas()
  if (m === 'edit') {
    ensureEditor()
    if (world && lastTex) editor!.setWorld(world, lastTex.color, edits, genEdits)
  }
}

// —— 生成 ——
const worker = new GenWorker()
let jobId = 0
let quietJob = false
/** Worker 正在算的任务：算完前不再投递（Worker 同步执行，排队的旧任务只会白算一遍） */
let running = false
/** 运行期间又要求的生成：当前任务结束后只算最新的一次；null 为没有。有一次非静默就按非静默 */
let queued: boolean | null = null
/** opened：从世界库或文件打开的整个世界——不演算，只让 Worker 补派生数据 */
export function generate(quiet = false, opened?: World) {
  if (running && !opened) {
    queued = queued === null ? quiet : queued && quiet
    if (quiet) ws.editStatus = t('演算中…')
    else Object.assign(ws.loading, { show: true, frac: 0 })
    return
  }
  const id = ++jobId
  const p = ws.params
  p.seed = p.seed.trim() || 'world'
  // 链接、旧存档里带的高度可能与宽度、纬度范围对不上
  normalizeParams(p)
  // 换了种子：方案编号从头算；编辑是针对旧世界的，询问后清除；规划草图保留（同一份规划换一套随机细节）
  if (p.seed !== editsSize.seed) {
    p.terrainVariant = 0
    p.placeVariant = 0
    ws.entry = null
  }
  if (p.seed !== editsSize.seed && hasEdits(edits)) {
    const sketch = edits.sketch
    const others = hasEdits({ ...edits, sketch: undefined })
    const ask = sketch ? '换种子会按同一份草图重新生成细节，草图以外的编辑将被清除。继续吗？' : '换种子会生成一个全新的世界，当前的编辑将被清除。继续吗？'
    if (others && !window.confirm(t(ask))) {
      p.seed = editsSize.seed
      return
    }
    edits = sketch ? keepEdits('sketch', 'sketchRev') : {}
    undoStack.length = 0
    editor?.refreshEdits(edits)
    syncSketch()
  }
  // 换了分辨率：编辑按比例重采样
  if ((p.width !== editsSize.W || p.height !== editsSize.H) && hasEdits(edits)) edits = resampleEdits(edits, editsSize.W, editsSize.H, p.width, p.height)
  editsSize = { W: p.width, H: p.height, seed: p.seed }
  storeSet('worldQuery', worldQuery().toString())
  syncRoute('world')
  ws.applied = { ...toRaw(p) }
  ws.dirty = false
  quietJob = quiet
  if (quiet) ws.editStatus = t('演算中…')
  else Object.assign(ws.loading, { show: true, frac: 0 })
  ws.busy = true
  running = true
  sentEdits = snapshotEdits(edits)
  // 区域不影响地形，不发给生成线程（也不影响"没有编辑时整份缓存"的判断）；
  // 带上现有贴图的地面版本：地面没变时 Worker 不再算贴图
  const msg: WorkerIn = opened
    ? { id, params: { ...toRaw(p) }, edits: workerEdits(), world: opened }
    : { id, params: { ...toRaw(p) }, edits: workerEdits(), ground: lastTex ? lastGround : undefined }
  // 打开的世界不再留在主线程（世界库与文件各有一份）：场数据直接转移给 Worker，不复制
  worker.postMessage(msg, opened ? [opened.elevation, opened.water, opened.temperature, opened.precipitation, opened.flow, opened.biome, opened.coastDist, opened.realm].map((a) => a.buffer) : [])
}
worker.onmessage = async (ev: MessageEvent<WorkerOut>) => {
  const m = ev.data
  // 定稿取地形的请求（负编号，与生成任务分开）
  if (m.id < 0) {
    const req = stageReqs.get(m.id)
    if (!req) return
    if (m.type === 'progress') ws.editStatus = t('定稿 · {stage}', { stage: t(m.stage) })
    else {
      stageReqs.delete(m.id)
      if (m.type === 'stage') req.resolve({ elev: m.elev, basins: m.basins })
      else req.reject(new Error(m.type === 'error' ? m.message : '定稿失败'))
    }
    return
  }
  if (m.id !== jobId) return
  if (m.type === 'progress') {
    ws.loading.stage = t(m.stage)
    ws.loading.frac = m.frac
    if (quietJob && queued === null) ws.editStatus = t('演算中 · {stage}', { stage: t(m.stage) })
    return
  }
  running = false
  // 算的过程中又有了新的编辑或参数：这份结果已经过时，直接算最新的
  if (queued !== null) {
    const quiet = queued
    queued = null
    generate(quiet)
    return
  }
  if (m.type === 'stage') return
  if (m.type === 'error') {
    ws.loading.stage = t('生成失败：') + m.message.split('\n')[0]
    // 编辑后的静默重算不显示加载层：失败信息留在状态提示里，而不是一直显示"演算中"
    ws.editStatus = quietJob ? ws.loading.stage : null
    ws.busy = false
    console.error(m.message)
    flushWaiters()
    return
  }
  const next = markRaw(m.world)
  const places = placeSig(next)
  // 地面与地点位置都没变（例如只改了命名）：只换名字，不重建地表贴图与 3D 场景
  // 区域按这次的地名在 Worker 里推断好了
  inferred = { world: next, areas: m.areas }
  if (world && lastTex && m.ground === lastGround && places === lastPlaces) {
    // 全息沙盘显示的是同一片地面：换上新的世界对象，地名在下面的 relabelHolo 里重排
    if (holoWorld === world) {
      holoWorld = next
      holo?.setNames(next)
    }
    world = next
    rivers = m.rivers
    if (!sceneStale) scene?.setNames(world)
    genEdits = sentEdits
    if (edits.regions) syncContinentLabels()
    editor?.setWorld(world, lastTex.color, edits, genEdits)
    atlasCache.clear()
    if (paperMode()) await refreshAtlas()
    showStats(world, m.cached)
    ws.loading.show = false
    ws.editStatus = null
    ws.busy = false
    relabelHolo()
    flushWaiters()
    return
  }
  ws.loading.stage = t('绘制地表')
  await new Promise((r) => setTimeout(r, 16))
  world = next
  rivers = m.rivers
  try {
    // 贴图像素由 Worker 算好，这里只写进画布；Worker 省略时（地面没变）沿用旧贴图
    const tex = m.tex ? textureCanvases(world, rivers, m.tex, 2) : m.ground === lastGround && lastTex ? lastTex : buildPhysicalTexture(world, rivers, 2)
    lastTex = tex
    // 编辑视图里不重建 3D（较慢），切回 3D 时再建
    if (ws.mode === '3d' || !editor) {
      scene?.setWorld(world, tex.color, tex.roughness, rivers)
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
    ws.editStatus = quietJob ? ws.loading.stage : null
    ws.busy = false
    flushWaiters()
    return
  }
  atlasCanvas = null
  atlasCache.clear()
  if (paperMode()) await refreshAtlas()
  showStats(world, m.cached)
  ws.loading.show = false
  ws.editStatus = null
  ws.busy = false
  syncHolo()
  flushWaiters()
  void fillPendingThumb()
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
  const hit = atlasCache.get(style)
  if (hit?.list) return hit.list
  const { buildAtlasBase, withLabels } = await import('../../render/atlas/svg/vector')
  let c = atlasCache.get(style)
  if (!c) {
    const measurer = document.createElement('canvas').getContext('2d')!
    c = { base: buildAtlasBase(w, rivers, style, { ...toRaw(ws.atlasOpts) }, measurer, 2), list: null }
    atlasCache.set(style, c)
  }
  c.list ??= withLabels(c.base, currentAreas())
  return c.list
}
/** 把列表交给查看器：与当前列表同一个底（只有注记不同）时不重画底图 */
function showList(list: DisplayList, style: StyleId) {
  const base = atlasCache.get(style)?.base ?? null
  if (base && base === shownBase) viewer!.setLabels(list)
  else viewer!.setList(list)
  shownBase = base
}
/** quiet：不弹加载遮罩（区域视图里改名、拖边界后的重排：旧图一直显示到新图就绪，编辑不被打断） */
async function refreshAtlas(quiet = false) {
  if (!world || !els) return
  const w = world
  const style = ws.atlasStyle
  const job = ++atlasJob
  takeStale()
  if (!atlasCache.has(style) && !quiet) {
    Object.assign(ws.loading, { show: true, frac: 1, stage: t('矢量绘制{style}', { style: t(THEMES.find((th) => th.id === style)!.name) }) })
    await mapFontsReady()
    await ensureFonts(w, style)
    await new Promise((r) => setTimeout(r, 20))
    if (job !== atlasJob || w !== world) return
  }
  const list = await buildList(w, style)
  if (!quiet) ws.loading.show = false
  if (job !== atlasJob) return
  const keepView = atlasCanvas !== null && atlasCanvas.width === list.width && atlasCanvas.height === list.height
  atlasCanvas = { width: list.width, height: list.height }
  shown = list
  if (!viewer) viewer = markRaw(new AtlasViewer(els.v2))
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__viewer = viewer
  // 图框模式：图廓固定在舞台上、贴着地图收拢或铺满可用区，缩放只动图框里的地图（导出仍是整页排版）
  viewer.setChrome((cw, ch, box) => buildAtlasChrome(w, style, list, map, chromeMeasurer, cw, ch, box, probeCard(), ws.ornaments), atlasBackdrop(style), atlasFrameInset(style))
  showList(list, style)
  ws.paper.M = list.M
  if (ws.mode === 'areas' && areasWorld !== w) loadAreas()
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
  if (viewer && ws.mode === 'areas') Object.assign(ws.paper, { x: map.x, y: map.y, k: map.k, frame: viewer.frame() })
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
  const p = paperMode() ? ws.probe : null
  return p && { title: t(p.title), rows: p.rows.map(([k, v]): [string, string] => [t(k), v]) }
}
watch(
  () => ws.probe,
  () => paperMode() && viewer?.refreshChrome(),
)

// —— 探针：悬停查看地点信息 ——
let probeRaf = 0
function probeAt(clientX: number, clientY: number) {
  if (!world || !els) return
  let cell: { x: number; y: number } | null = null
  if (ws.mode === '3d') cell = scene?.pick(clientX, clientY) ?? null
  // 全息视图的读数在它自己的界面里（目标卡片）
  else if (ws.mode === 'holo') cell = null
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
  const proj = regionProjection(world.params)
  const [lon, lat] = proj ? proj.toLonLat(cell.x, cell.y) : [NaN, latitudeOf(world.params, cell.y, world.H)]
  const lake = !Number.isNaN(world.water[i]) && e > 0
  const rows: [string, string][] = [['纬度', latFmt(Math.round(lat * 10) / 10)]]
  if (proj) rows.push(['经度', lonFmt(Math.round(lon * 10) / 10)])
  // 区域图：所属的省级与地级行政区
  const a = world.admin
  const u = a ? a.unit[i] : -1
  if (a && u >= 0) {
    const unit = a.units[u]
    rows.push(['省级', lang === 'zh' ? a.provinceFull[unit.province] : placeName(world.realms[unit.province])])
    if (world.realms[unit.province] && unit.zh !== world.realms[unit.province].zh) rows.push(['地级', lang === 'zh' ? unit.full : placeName(unit)])
  }
  rows.push(
    [e > 0 ? '海拔' : '水深', `${Math.round(Math.abs(e) * 1000).toLocaleString()} m`],
  )
  if (lake) rows.push(['湖面', `${Math.round(world.water[i] * 1000).toLocaleString()} m`])
  rows.push(['年均温', `${world.temperature[i].toFixed(1)} °C`])
  if (e > 0) rows.push(['年降水', `${Math.round(world.precipitation[i]).toLocaleString()} mm`])
  if (e > 0 && world.flow[i] > 1) rows.push(['径流', `${world.flow[i].toFixed(0)}`])
  const title = BIOME_NAMES[world.biome[i]]
  // 读数没变（同一格、或编辑后读数恰好相同）就不换对象：换对象会触发图廓重排（每帧约 5 ms）
  if (sameProbe(ws.probe, title, rows)) return
  ws.probe = { title, rows }
}
/** 探针内容是否与当前一致 */
export function sameProbe(p: { title: string; rows: [string, string][] } | null, title: string, rows: [string, string][]) {
  if (!p || p.title !== title || p.rows.length !== rows.length) return false
  for (let i = 0; i < rows.length; i++) if (p.rows[i][0] !== rows[i][0] || p.rows[i][1] !== rows[i][1]) return false
  return true
}

// —— 导出 ——
export async function exportPng() {
  if (!world || !els) return
  let url: string
  if (ws.mode === '3d' && scene) url = scene.snapshot()
  else if (ws.mode === 'holo' && holo) url = holo.snapshot()
  else {
    // 由矢量显示列表按 2 倍分辨率栅格化
    await mapFontsReady()
    await ensureFonts(world, ws.atlasStyle)
    const list = await buildList(world, ws.atlasStyle)
    if (!viewer) viewer = markRaw(new AtlasViewer(els.v2))
    showList(list, ws.atlasStyle)
    url = viewer.rasterize(2).toDataURL('image/png')
  }
  download(url, `${world.worldName.toLowerCase()}-${ws.params.seed}-${ws.mode === '3d' ? '3d' : ws.mode === 'holo' ? `holo-${ws.holo.palette}` : ws.atlasStyle}.png`)
}
/** 矢量导出：纸图的全部底色、线划、符号与注记都是路径和文字 */
export async function exportSvg() {
  if (!world) return
  const w = world
  Object.assign(ws.loading, { show: true, frac: 1, stage: t('矢量化：追踪等值线与区域轮廓') })
  await mapFontsReady()
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
// —— 定稿与世界库 ——
const stageReqs = new Map<number, { resolve: (v: { elev: Float32Array; basins: { x: number; y: number; r: number }[] }) => void; reject: (e: Error) => void }>()
let stageSeq = 0
/** 向 Worker 要当前世界侵蚀结束时的地形（定稿的底） */
function requestStage() {
  const id = --stageSeq
  return new Promise<{ elev: Float32Array; basins: { x: number; y: number; r: number }[] }>((resolve, reject) => {
    stageReqs.set(id, { resolve, reject })
    const msg: WorkerIn = { id, params: { ...toRaw(ws.params) }, edits: workerEdits(), want: 'stage' }
    worker.postMessage(msg)
  })
}

/**
 * 定稿：把当前地形冻结成数据。之后地形与种子、地形参数、草图无关，地形画笔直接改在冻结的高度上；
 * 地点、世界名、国名一并钉住，往后重算气候、水系、政区时名字不变。之前的地形画笔已烘焙进去，另存一份供回到规划时恢复
 */
async function freeze() {
  const w = world
  // 真实地球（含区域图）本来就是观测数据，不必定稿
  if (!w || edits.frozen || w.params.earthReal) return
  const { elev, basins } = await requestStage()
  if (world !== w) throw new Error('世界在定稿时变了，请重试')
  edits.planTerrain = edits.terrain
  edits.terrain = undefined
  edits.terrainRev = (edits.terrainRev ?? 0) + 1
  edits.frozen = { elev, basins, seed: ws.params.seed, terrainVariant: ws.params.terrainVariant }
  edits.frozenRev = Date.now()
  edits.labels = w.labels.map((l) => ({ ...l }))
  pinWorldName(true)
  const names: NonNullable<WorldEdits['realmNames']> = {}
  for (const r of w.realms) {
    const cap = w.labels[r.capital]
    if (cap) names[cap.name] = { name: r.name, zh: r.zh, ja: r.ja }
  }
  edits.realmNames = names
  // 显示中的世界就是定稿的结果：编辑预览的基准随之换成定稿后的编辑
  genEdits = snapshotEdits(edits)
  editor?.refreshEdits(edits)
  syncSketch()
  ws.editStatus = null
}

/** 回到规划：去掉定稿地形，地形重新由种子、参数与草图生成；定稿后的地形画笔会丢失（可撤销） */
export function unfreeze() {
  if (!edits.frozen || !window.confirm(t('回到规划？地形重新由种子、参数与草图生成，定稿后在地形上的修改会丢失（可撤销）。'))) return
  pushUndo(false)
  edits.terrain = edits.planTerrain
  edits.planTerrain = undefined
  edits.frozen = undefined
  edits.frozenRev = undefined
  edits.realmNames = undefined
  edits.terrainRev = (edits.terrainRev ?? 0) + 1
  editor?.refreshEdits(edits)
  syncSketch()
  scheduleRegen()
}

function thumbnail(): string {
  if (!lastTex) return ''
  const src = lastTex.color
  const c = document.createElement('canvas')
  c.width = 320
  c.height = Math.round((320 * src.height) / src.width)
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  return c.toDataURL('image/webp', 0.8)
}

/** 存进世界库的数据（IndexedDB 的 put 会结构化克隆，存不了响应式代理：参数取原对象） */
function storable() {
  return { params: { ...toRaw(ws.params) }, edits, world: world! }
}

let flashTimer = 0
function flash(msg: string) {
  ws.editStatus = t(msg)
  clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    if (ws.editStatus === t(msg)) ws.editStatus = null
  }, 1800)
}

/** 保存到世界库（即定稿）：已对应某个条目就覆盖它，asNew 时另存一条 */
export async function saveWorld(asNew = false) {
  if (!world || ws.busy) return
  try {
    await freeze()
    const w = world!
    const id = !asNew && ws.entry ? ws.entry.id : newWorldId()
    const name = !asNew && ws.entry ? ws.entry.name : worldTitle(w)
    await putWorld({ id, name, savedAt: Date.now(), thumb: thumbnail(), seed: ws.params.seed, W: w.W, H: w.H }, storable())
    ws.entry = { id, name }
    flash('已保存到世界库')
    if (ws.library.open) await refreshLibrary()
  } catch (err) {
    window.alert(t('保存失败：') + (err instanceof Error ? err.message : String(err)))
  }
}

/** 打开世界库里的世界：整个世界直接显示，不演算 */
export async function openEntry(id: string) {
  const [e, m] = await Promise.all([getEntry(id), getMeta(id)])
  if (!e || !m) return
  loadWorldData(e.params, e.edits, e.world)
  ws.entry = { id, name: m.name }
  ws.library.open = false
}

function loadWorldData(params: WorldParams, ed: WorldEdits, w?: World) {
  Object.assign(ws.params, { ...DEFAULT_PARAMS, ...params })
  edits = ed
  if (edits.frozen) edits.frozenRev = Date.now()
  editsSize = { W: ws.params.width, H: ws.params.height, seed: ws.params.seed }
  undoStack.length = 0
  editor?.select(null)
  editor?.refreshEdits(edits)
  syncSketch()
  ws.entry = null
  ws.preset = -1
  generate(false, w)
}

export async function refreshLibrary() {
  ws.library.items = await listWorlds()
}
export async function openLibrary(v = true) {
  ws.library.open = v
  if (v) await refreshLibrary()
}
export async function renameEntry(id: string, name: string) {
  name = name.trim()
  if (!name) return
  await renameWorld(id, name)
  if (ws.entry?.id === id) ws.entry.name = name
  await refreshLibrary()
}
export async function deleteEntry(id: string) {
  const m = ws.library.items.find((x) => x.id === id)
  if (!m || !window.confirm(t('从世界库删除「{name}」？此操作无法撤销。', { name: m.name }))) return
  await deleteWorld(id)
  if (ws.entry?.id === id) ws.entry = null
  await refreshLibrary()
}

const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|\s]+/g, '-').toLowerCase() || 'world'}.cartographer.json`

/** 导出世界库里的一条：整个世界的数据，导入后直接显示 */
export async function exportEntry(id: string) {
  const [e, m] = await Promise.all([getEntry(id), getMeta(id)])
  if (!e || !m) return
  const text = await serializeProject(e.params, e.edits, e.world, m.name)
  download(new Blob([text], { type: 'application/json' }), fileName(m.name))
}

/** 导出当前世界（先定稿） */
export async function exportWorldFile() {
  if (!world || ws.busy) return
  await freeze()
  const name = ws.entry?.name ?? worldTitle(world!)
  const text = await serializeProject(toRaw(ws.params), toRaw(edits), toRaw(world!), name)
  download(new Blob([text], { type: 'application/json' }), fileName(name))
}

/** 打开文件：带整个世界数据的（第 2 版）存进世界库并直接显示；只有种子与编辑的旧文件按种子演算 */
export async function openProject(f: File) {
  try {
    const doc = await parseProject(await f.text())
    if (doc.world) {
      const id = newWorldId()
      const name = doc.name ?? worldTitle(doc.world)
      // 先存库再打开（打开时场数据转移给 Worker）；缩略图等贴图画好后再补
      await putWorld({ id, name, savedAt: Date.now(), thumb: '', seed: doc.params.seed, W: doc.world.W, H: doc.world.H }, { params: doc.params, edits: doc.edits, world: doc.world })
      loadWorldData(doc.params, doc.edits, doc.world)
      ws.entry = { id, name }
      pendingThumb = id
      if (ws.library.open) await refreshLibrary()
      return
    }
    loadWorldData(doc.params, doc.edits)
  } catch (err) {
    window.alert(t('无法打开：') + t(err instanceof Error ? err.message : String(err)))
  }
}
/** 导入的世界等贴图画好后补上缩略图 */
let pendingThumb: string | null = null
async function fillPendingThumb() {
  const id = pendingThumb
  if (!id || !lastTex) return
  pendingThumb = null
  const m = await getMeta(id)
  if (m) await putMeta({ ...m, thumb: thumbnail() })
  if (ws.library.open) await refreshLibrary()
}

// —— 编辑视图 ——
let regenTimer = 0
/** 编辑完成后稍等再重算，连续几笔只算一次 */
function scheduleRegen() {
  clearTimeout(regenTimer)
  regenTimer = window.setTimeout(() => generate(true), 350)
}
/** pin 为 false：草图编辑改的是大陆本身，不钉住地点（城镇、地名随新的海陆重新生成） */
function pushUndo(pin = true) {
  undoStack.push({
    edits: snapshotEdits({ ...edits, labels: world && edits.labels ? world.labels.map((l) => ({ ...l })) : edits.labels }),
    terrainVariant: ws.params.terrainVariant ?? 0,
    placeVariant: ws.params.placeVariant ?? 0,
  })
  if (undoStack.length > 30) undoStack.shift()
  // 一开始编辑就把现有地点钉住：之后改地形、改气候重算时，城镇与地名不会整体洗牌
  if (pin && !edits.labels && world) {
    edits.labels = world.labels.map((l) => ({ ...l }))
    pinWorldName()
  }
}
/** 重置编辑时保留的字段：其余丢弃，地形版本号换新（地形可能因此改变） */
function keepEdits(...keys: (keyof WorldEdits)[]): WorldEdits {
  const out: WorldEdits = { terrainRev: (edits.terrainRev ?? 0) + 1 }
  for (const k of keys) (out as Record<string, unknown>)[k] = edits[k]
  return out
}
const WORLD_NAME_KEYS = ['worldName', 'worldNameZh', 'worldNameJa'] as const
/** 发给 Worker 的编辑：区域不影响生成，回到规划才用的旧画笔也用不到，都不必复制过去 */
const workerEdits = (): WorldEdits => ({ ...edits, areas: undefined, planTerrain: undefined })
/** 放开钉住的地点、大洲与区域：按当前地形重新生成 */
function releasePlaces() {
  edits.labels = undefined
  edits.regions = undefined
  edits.regionMeta = undefined
  edits.areas = undefined
  editor?.select(null)
  editor?.refreshEdits(edits)
}
export function undo() {
  const prev = undoStack.pop()
  if (!prev) return
  edits = prev.edits
  ws.params.terrainVariant = prev.terrainVariant
  ws.params.placeVariant = prev.placeVariant
  edits.terrainRev = (edits.terrainRev ?? 0) + 1
  editor?.refreshEdits(edits)
  syncSketch()
  scheduleRegen()
}
export function clearEdits() {
  // 规划草图不算在内（退出规划另有按钮）：清除的是草图之上的画笔、地点与大洲
  if (!hasEdits({ ...edits, sketch: undefined, frozen: undefined }) || !window.confirm(t(edits.sketch ? '清除草图以外的全部编辑？' : '清除全部编辑，恢复为程序生成的原样？'))) return
  pushUndo()
  edits = keepEdits('sketch', 'sketchRev', 'frozen', 'frozenRev', 'planTerrain', 'realmNames')
  editor?.refreshEdits(edits)
  scheduleRegen()
}

// —— 规划草图 ——
defineStrings([
  ['从零规划', 'Plan from scratch', 'ゼロから計画'],
  ['画出大陆轮廓与山脉走向，其余细节按种子随机生成；之后随时改草图重算。', 'Draw the continents and the run of the mountains; everything else is generated from the seed. Change the sketch at any time to regenerate.', '大陸の輪郭と山脈の走向を描くと、残りはシードから生成されます。スケッチはいつでも修正して再計算できます。'],
  ['从一片汪洋开始，圈出大陆', 'Start from open ocean and outline the continents', '一面の海から始めて大陸を囲む'],
  ['空白画布', 'Blank canvas', '白紙から'],
  ['以当前世界的海陆与主要山脉为底稿，在上面修改', 'Start from the land, sea and main ranges of the current world', '現在の世界の海陸と主な山脈を下絵にする'],
  ['当前世界', 'Current world', '現在の世界'],
  ['规划草图', 'Sketch', '計画スケッチ'],
  ['圈地', 'Lasso', '囲む'],
  ['陆地', 'Land', '陸地'],
  ['海洋', 'Ocean', '海洋'],
  ['山脉', 'Range', '山脈'],
  ['拖动圈出一块陆地；按住 Alt 圈出海洋', 'Drag to outline land; hold Alt to outline sea', 'ドラッグで陸地を囲む。Alt を押しながらで海'],
  ['画笔涂出陆地', 'Paint land', 'ブラシで陸地を塗る'],
  ['画笔涂成海洋：挖出海湾、海峡', 'Paint sea: cut bays and straits', 'ブラシで海にする：湾や海峡を刻む'],
  ['拖动画出山脉的走向；点选已有山脉可拖动、调高度与宽度', 'Drag to draw the run of a range; click a range to move it or set its height and width', 'ドラッグで山脈の走向を描く。既存の山脈をクリックで移動・高さと幅の調整'],
  ['山脉高度', 'Range height', '山脈の高さ'],
  ['山体宽度', 'Range width', '山体の幅'],
  ['删除这条山脉', 'Delete this range', 'この山脈を削除'],
  ['地点编辑过后会固定不动；按当前的海陆重新生成全部城镇与地名', 'Places stay fixed once edited; regenerate all towns and names for the current land', '地点は編集後に固定されます。現在の海陸に合わせて町と地名をすべて作り直す'],
  ['重排地点', 'Re-place towns', '地点を再配置'],
  ['移除草图，大陆回到按陆地比例随机生成', 'Remove the sketch and go back to random continents', 'スケッチを外し、大陸をランダム生成に戻す'],
  ['退出规划', 'Leave plan', '計画を終了'],
  ['聚落与道路', 'Settlements & roads', '集落と道路'],
  ['定稿 · {stage}', 'Finalizing · {stage}', '確定中 · {stage}'],
  ['回到规划？地形重新由种子、参数与草图生成，定稿后在地形上的修改会丢失（可撤销）。', 'Back to planning? Terrain is generated again from the seed, parameters and sketch; terrain changes made after finalizing are lost (undoable).', '計画に戻りますか？地形はシード・パラメーター・スケッチから再び生成され、確定後の地形の修正は失われます（元に戻せます）。'],
  ['已保存到世界库', 'Saved to library', 'ライブラリに保存しました'],
  ['保存失败：', 'Save failed: ', '保存に失敗：'],
  ['从世界库删除「{name}」？此操作无法撤销。', 'Delete “{name}” from the library? This cannot be undone.', '「{name}」をライブラリから削除しますか？元に戻せません。'],
  ['读取世界库', 'Reading library', 'ライブラリを読み込み中'],
  ['读取定稿地形', 'Reading finalized terrain', '確定地形を読み込み中'],
  ['世界库', 'Library', 'ライブラリ'],
  ['世界库…', 'Library…', 'ライブラリ…'],
  ['关闭', 'Close', '閉じる'],
  ['中国', 'China', '中国'],
  ['中国区域图：真实地形（ETOPO 2022）、气候与河湖，省级与地级行政区划、国界与南海断续线；周边只显示地形', 'Regional map of China: observed terrain (ETOPO 2022), climate, rivers and lakes, with provinces, prefectures, the national boundary and the South China Sea dashed line; neighbouring areas show terrain only', '中国の地域図：実測の地形（ETOPO 2022）・気候・河川湖沼に、省級・地級の行政区画、国境と南シナ海の断続線。周辺は地形のみ'],
  ['约 3.7 km / 格', 'About 3.7 km per cell', '1 マス約 3.7 km'],
  ['约 1.85 km / 格（1′，生成较慢）', 'About 1.85 km per cell (1′, slower)', '1 マス約 1.85 km（1′、生成に時間がかかる）'],
  ['经度', 'Longitude', '経度'],
  ['省级', 'Province', '省級'],
  ['地级', 'Prefecture', '地級'],
  ['保存到世界库', 'Save to library', 'ライブラリに保存'],
  ['保存到世界库：地形定稿成数据，之后与种子无关', 'Save to the library: the terrain is finalized as data and no longer depends on the seed', 'ライブラリに保存：地形をデータとして確定し、以後シードに依存しない'],
  ['已定稿', 'Finalized', '確定済み'],
  ['地形已是数据，与种子无关：种子与地形参数不再起作用，地形画笔直接修改这份地形；气候、水系、聚落仍可调整与重算。', 'The terrain is data and no longer depends on the seed: seed and terrain parameters have no effect, and terrain brushes edit it directly. Climate, water and settlements can still be adjusted.', '地形はデータになり、シードに依存しません。シードと地形パラメーターは効かず、地形ブラシはこの地形を直接修正します。気候・水系・集落は引き続き調整できます。'],
  ['回到规划', 'Back to planning', '計画に戻る'],
  ['去掉定稿地形，重新由种子、参数与草图生成', 'Drop the finalized terrain and generate it from the seed, parameters and sketch again', '確定地形を外し、シード・パラメーター・スケッチから再び生成する'],
  ['另存为新世界', 'Save as new', '新規として保存'],
  ['导入文件…', 'Import file…', 'ファイルを読み込む…'],
  ['还没有保存的世界。生成满意后点「保存」，世界会连同全部数据存进这里。', 'No saved worlds yet. Click “Save” when you like a world; it is stored here with all its data.', '保存した世界はまだありません。気に入ったら「保存」を押すと、すべてのデータごとここに保存されます。'],
  ['打开', 'Open', '開く'],
  ['导出', 'Export', '書き出し'],
  ['删除', 'Delete', '削除'],
  ['双击改名', 'Double-click to rename', 'ダブルクリックで名前を変更'],
  ['当前', 'Current', '現在'],
  ['世界文件', 'World file', 'ワールドファイル'],
  ['整个世界的数据（.json），导入后直接显示，与种子无关', 'All data of the world (.json); opens as is, independent of the seed', '世界の全データ（.json）。読み込むとそのまま表示され、シードに依存しない'],
  ['保存的世界、导入与导出', 'Saved worlds, import and export', '保存した世界・読み込みと書き出し'],
  ['地形方案', 'Terrain variant', '地形案'],
  ['聚落方案', 'Settlement variant', '集落案'],
  ['同一种子下换一套地形细节（有草图时大陆形状与山脉走向不变）；地点随新地形重新生成', 'Another set of terrain details for the same seed (a sketch keeps its continents and ranges); places are regenerated for the new terrain', '同じシードで地形の細部を作り直す（スケッチがあれば大陸と山脈は保たれる）。地点は新しい地形に合わせて作り直す'],
  ['地形不变，换一套城镇选址、国界与道路', 'Same terrain, another set of town sites, borders and roads', '地形はそのままに、町の位置・国境・道路を作り直す'],
  ['上一个方案', 'Previous variant', '前の案'],
  ['原样', 'Original', '元の案'],
  ['下一个方案', 'Next variant', '次の案'],
  ['城镇、国家、道路与航线；关掉时只生成地形、气候、水系与自然地物，先定地形再放聚落', 'Towns, realms, roads and sea routes; turn off to generate only terrain, climate, water and natural features, and add settlements later', '町・国・道路・航路。オフにすると地形・気候・水系・自然地物だけを生成し、集落は後から置けます'],
  ['第一阶段：只有地形', 'Stage 1: terrain only', '第1段階：地形のみ'],
  ['第二阶段：聚落与道路', 'Stage 2: settlements & roads', '第2段階：集落と道路'],
  ['生成聚落与道路', 'Generate settlements & roads', '集落と道路を生成'],
  ['回到只有地形', 'Back to terrain only', '地形のみに戻る'],
  ['地形满意后，在这片地面上放置城镇、划分国家、修建道路', 'Once the terrain is right, place towns, draw realms and build roads on it', '地形が決まったら、町を置き、国を分け、道路を敷く'],
  ['去掉城镇、国家与道路，继续修改地形', 'Remove towns, realms and roads to keep working on the terrain', '町・国・道路を外して地形の修正を続ける'],
  ['草图', 'Sketch', 'スケッチ'],
  ['规划草图生效中：大陆形状与山脉走向由草图决定，陆地比例不起作用，板块只产生次级山地。', 'A sketch is in use: continents and mountain ranges follow it, land ratio has no effect, and plates only add minor uplands.', '計画スケッチ使用中：大陸の形と山脈はスケッチに従い、陸地比率は効かず、プレートは副次的な山地のみ生みます。'],
  ['拖动圈出陆地 · 按住 Alt 圈出海洋 · 右键或 Shift 拖动平移 · Ctrl+Z 撤销', 'Drag to outline land · Alt to outline sea · right-drag or Shift to pan · Ctrl+Z undo', 'ドラッグで陸地を囲む · Alt で海 · 右ドラッグか Shift で移動 · Ctrl+Z 元に戻す'],
  ['拖动画山脉脊线 · 点选山脉后拖动整条或拖顶点 · Delete 删除 · 右键或 Shift 拖动平移 · Ctrl+Z 撤销', 'Drag to draw a ridge · click a range, then drag it or its vertices · Delete removes · right-drag or Shift to pan · Ctrl+Z undo', 'ドラッグで稜線を描く · 山脈を選んで全体か頂点をドラッグ · Delete で削除 · 右ドラッグか Shift で移動 · Ctrl+Z 元に戻す'],
  ['换种子会按同一份草图重新生成细节，草图以外的编辑将被清除。继续吗？', 'A new seed regenerates the details from the same sketch; edits other than the sketch will be cleared. Continue?', 'シードを変えると同じスケッチで細部を作り直し、スケッチ以外の編集は消去されます。続けますか？'],
  ['清除草图以外的全部编辑？', 'Clear all edits except the sketch?', 'スケッチ以外の編集をすべて消去しますか？'],
  ['退出规划？草图将被移除，大陆回到随机生成（可撤销）。', 'Leave the plan? The sketch is removed and continents are generated randomly again (undoable).', '計画を終了しますか？スケッチを外し、大陸はランダム生成に戻ります（元に戻せます）。'],
])
function syncSketch() {
  ws.frozen = !!edits.frozen
  ws.sketch = !!edits.sketch
  if (!edits.sketch && isSketchTool(ws.tool)) setTool('select')
  showRangeInspector(editor?.selectedRange ?? -1)
}
/**
 * 开始从零规划：from 为 world 时以当前世界的海陆与高地为底稿，blank 为一片汪洋。
 * 原先的地形画笔、地点与大洲都是针对随机大陆的，一并清掉（可撤销）
 */
export function startSketch(from: 'world' | 'blank') {
  if (!world || ws.params.earth || ws.frozen) return
  pushUndo(false)
  const { W, H } = world
  const sketch = from === 'world' ? sketchFromWorld(world.elevation, W, H, world.kmPerCell) : { land: new Float32Array(W * H), ranges: [] }
  edits = { ...keepEdits(...WORLD_NAME_KEYS), sketch }
  bumpSketch(edits)
  editor?.refreshEdits(edits)
  syncSketch()
  setTool(from === 'world' ? 'ridge' : 'lasso')
  // 规划先定地形：聚落与道路留到地形满意之后再生成
  if (ws.params.settlements !== false) {
    pinWorldName()
    ws.params.settlements = false
  }
  scheduleRegen()
}
/** 世界名钉住：政区命名会消耗命名序列，开关聚落前后生成的世界名会不同。force：已钉住的也换成当前世界的 */
function pinWorldName(force = false) {
  if (!world || (edits.worldName && !force)) return
  edits.worldName = world.worldName
  edits.worldNameZh = world.worldNameZh
  edits.worldNameJa = world.worldNameJa
}
/**
 * 换地形方案：同一种子、同一份草图，换一套造山、侵蚀与气候的随机细节。
 * 钉住的地点、大洲与区域是贴着旧地形摆的，一并放开，按新地形重新生成（可撤销）
 */
export function setTerrainVariant(n: number) {
  if (ws.frozen) return
  n = Math.max(0, Math.round(n))
  if (n === (ws.params.terrainVariant ?? 0)) return
  pushUndo(false)
  pinWorldName()
  releasePlaces()
  ws.params.terrainVariant = n
  generate(ws.mode === 'edit')
}
/** 换聚落方案：地面不变，换一套城镇选址与国界；钉住的自然地物名称保留，钉住的城镇放开 */
export function setPlaceVariant(n: number) {
  n = Math.max(0, Math.round(n))
  if (n === (ws.params.placeVariant ?? 0)) return
  pushUndo(false)
  pinWorldName()
  if (edits.labels) edits.labels = edits.labels.filter((l) => !isSettlement(l))
  if (editor?.selected && isSettlement(editor.selected)) editor.select(null)
  ws.params.placeVariant = n
  generate(ws.mode === 'edit')
}

/**
 * 两阶段生成：关掉时只有地形、气候、水系与自然地物名称；打开时在同一片地面上放城镇、划政区、修道路。
 * 地面沿用缓存，切换只重算地点这一级
 */
export function setSettlements(on: boolean) {
  if ((ws.params.settlements !== false) === on) return
  pinWorldName()
  ws.params.settlements = on
  if (!on && ws.tool === 'place') setTool('select')
  generate(ws.mode === 'edit')
}
/** 退出规划：去掉草图，回到按陆地比例、板块随机生成的大陆 */
export function endSketch() {
  if (!edits.sketch || !window.confirm(t('退出规划？草图将被移除，大陆回到随机生成（可撤销）。'))) return
  pushUndo(false)
  edits = keepEdits(...WORLD_NAME_KEYS)
  editor?.refreshEdits(edits)
  syncSketch()
  scheduleRegen()
}
/** 地点被钉住后不再随大陆变化：按当前草图重新生成全部城镇与地名（大洲划分也重做） */
export function regenPlaces() {
  if (!edits.labels && !edits.regions) return
  pushUndo(false)
  releasePlaces()
  generate(true)
}
function showRangeInspector(i: number) {
  rangeEditing = false
  const r = edits.sketch?.ranges[i]
  ws.range = r ? { height: r.height, width: r.width } : null
}
/** 调山脉的高度、宽度：拖动滑杆只记一次撤销 */
let rangeEditing = false
export function setRange(patch: Partial<{ height: number; width: number }>) {
  const i = editor?.selectedRange ?? -1
  const r = edits.sketch?.ranges[i]
  if (!r || !ws.range) return
  if (!rangeEditing) pushUndo(false)
  rangeEditing = true
  Object.assign(r, patch)
  Object.assign(ws.range, patch)
  bumpSketch(edits)
  editor?.draw()
  scheduleRegen()
}
export function deleteRange() {
  const i = editor?.selectedRange ?? -1
  if (!edits.sketch?.ranges[i]) return
  pushUndo(false)
  edits.sketch.ranges.splice(i, 1)
  bumpSketch(edits)
  editor!.selectRange(-1)
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
          labelsChanged()
        }
        scheduleRegen()
      },
      onSelect: showInspector,
      onRegionSelect: showRegionInspector,
      onRangeSelect: showRangeInspector,
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
  labelsChanged()
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
  relabelHolo()
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
  labelsChanged()
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
  labelsChanged()
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
// —— 区域（大陆、海、湾……）：自动推断，区域视图里改名、改边界 ——
let inferred: { world: World; areas: Area[] } | null = null
/** 当前世界的区域：改过就用改过的，否则自动推断（每个世界推断一次；通常已由 Worker 算好） */
function currentAreas(): Area[] {
  if (edits.areas) return edits.areas
  if (!world) return []
  if (inferred?.world !== world) inferred = { world, areas: world.params.earthReal ? earthAreas(world) : inferAreas(world) }
  return inferred.areas
}
/** 区域视图里显示、编辑的是当前区域的副本；换了世界要重新载入 */
let areasWorld: World | null = null
function loadAreas() {
  if (!world) return
  areasWorld = world
  ws.areas = structuredClone(toRaw(currentAreas()))
  ws.areasEdited = !!edits.areas
  if (ws.areaSel && !ws.areas.some((a) => a.id === ws.areaSel)) ws.areaSel = null
}
const areaUndo: Area[][] = []
/** 一次改动开始前记下原样（拖顶点、改名、新建、删除……），Ctrl+Z 撤回；prev：事先存下的原样（拖动真的动了才记） */
export function areaCheckpoint(prev?: Area[]) {
  areaUndo.push(prev ?? structuredClone(toRaw(ws.areas)))
  if (areaUndo.length > 60) areaUndo.shift()
}
/** 区域视图里的改动写进编辑，纸图注记按新的区域重排（拖动过程中不调：重排一次要几百毫秒，松手时调） */
let areaTimer = 0
export function commitAreas() {
  edits.areas = structuredClone(toRaw(ws.areas))
  ws.areasEdited = true
  clearTimeout(areaTimer)
  areaTimer = window.setTimeout(() => {
    relabelAtlas()
    refreshAtlas(true)
  }, 80)
}
export function undoAreas() {
  const prev = areaUndo.pop()
  if (!prev) return
  ws.areas = prev
  if (ws.areaSel && !ws.areas.some((a) => a.id === ws.areaSel)) ws.areaSel = null
  commitAreas()
}
export function selectArea(id: string | null) {
  ws.areaSel = id
}
/** 丢掉全部区域改动，回到自动推断 */
export function resetAreas() {
  if (!edits.areas) return
  areaCheckpoint()
  edits.areas = undefined
  loadAreas()
  relabelAtlas()
  refreshAtlas()
}
/** 在视图中央放一个新区域（六边形，约占视图的六分之一），选中它 */
export function addArea(kind: AreaKind) {
  if (!world || !viewer) return
  areaCheckpoint()
  const f = viewer.frame()
  const P = ws.paper
  const toCell = (sx: number, sy: number): [number, number] => [(sx - P.x) / P.k / P.S - P.M / P.S - P.half, (sy - P.y) / P.k / P.S - P.M / P.S - P.half]
  const [cx, cy] = toCell(f.x + f.w / 2, f.y + f.h / 2)
  const r = Math.min(f.w, f.h) / 6 / P.k / P.S
  const poly: [number, number][] = []
  for (let i = 0; i < 6; i++) poly.push([cx + r * Math.cos((i * Math.PI) / 3), cy + r * Math.sin((i * Math.PI) / 3)])
  const water = isWaterArea(kind) || kind === 'lake'
  const id = `user:${Date.now().toString(36)}`
  const name = t(water ? '新水域' : '新区域')
  ws.areas.push({ id, kind, name, zh: name, ja: name, poly, at: [cx, cy], cells: Math.round(Math.PI * r * r) })
  ws.areaSel = id
  commitAreas()
}
/** 把地图移到区域上（区域比视口大就缩小到整个放下） */
export function focusArea(id: string) {
  const a = ws.areas.find((x) => x.id === id)
  if (!a || !viewer) return
  const P = ws.paper
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of a.poly) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const pg = (c: number) => P.M + (c + 0.5) * P.S
  const f = viewer.inner()
  const bw = (x1 - x0) * P.S
  const bh = (y1 - y0) * P.S
  map.k = Math.min(map.k, (f.w * 0.8) / Math.max(1, bw), (f.h * 0.8) / Math.max(1, bh))
  map.x = f.x + f.w / 2 - ((pg(x0) + pg(x1)) / 2) * map.k
  map.y = f.y + f.h / 2 - ((pg(y0) + pg(y1)) / 2) * map.k
  applyMap()
}
export function deleteArea(id: string) {
  const i = ws.areas.findIndex((a) => a.id === id)
  if (i < 0) return
  areaCheckpoint()
  ws.areas.splice(i, 1)
  if (ws.areaSel === id) ws.areaSel = null
  commitAreas()
}

window.addEventListener('keydown', (e) => {
  if (app.module !== 'world') return
  const typing = isTypingTarget(e)
  if (ws.mode === 'areas' && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    undoAreas()
    return
  }
  if (ws.mode === 'edit' && !typing) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      undo()
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && editor?.selected) deleteSelected()
    else if ((e.key === 'Delete' || e.key === 'Backspace') && ws.tool === 'ridge' && ws.range) deleteRange()
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing) return
  if (e.key === 'r' || e.key === 'R') randomSeed()
})

// 离开页面（含开发时的整页刷新）时立即交还两个 WebGL 上下文的显存：
// 浏览器回收旧页面的上下文有延迟，新页面紧接着再建两个大画布时可能因显存不足丢失上下文
window.addEventListener('pagehide', () => {
  holo?.renderer.forceContextLoss()
  scene?.renderer.forceContextLoss()
})

// —— 语言：地图文字重排版 ——
onLang(async () => {
  ws.probe = null
  if (!world) return
  showStats(world)
  await mapFontsReady()
  await document.fonts.load(`600 20px ${lang === 'ja' ? '"Noto Serif JP"' : '"Noto Serif SC"'}`, worldTitle(world) + [...world.labels, ...world.realms].map((l) => placeName(l)).join(''))
  atlasCache.clear()
  if (paperMode()) refreshAtlas()
  scene?.refreshLanguage()
  relabelHolo()
  editor?.draw()
})
