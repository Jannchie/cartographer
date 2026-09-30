import { computed, markRaw, reactive, toRaw, watch } from 'vue'
import type { World } from '../../gen/types'
import type { DisplayList } from '../../render/atlas/svg/displayList'
import { AtlasViewer } from '../../render/atlas/svg/viewer'
import { fromWorld } from '../../settlement/fromWorld'
import { computeHistory, Superseded } from './historyWorker'
import { snapshot, type SettlementHistory } from '../../settlement/history'
import { pointInPoly, type P } from '../../settlement/geom'
import { SETTLE_FRAME_INSET, buildSettlementChrome, buildSettlementVector, ensureSettleFonts, settleBackdrop } from '../../settlement/render'
import { SETTLE_THEMES, type SettleStyleId } from '../../settlement/themes'
import type { CityFunction, FeatureId } from '../../settlement/features'
import { POP_OF_SIZE } from '../../settlement/scale'
import { DEFAULT_SETTLEMENT, LAYOUT_DEFAULT, WARD_NAMES, type Culture, type Settlement, type SettlementParams, type Ward } from '../../settlement/types'
import { app, download, initialQuery, paramSig, registerRoute, storeGet, storeSet, syncRoute } from '../app'
import { ensureWorld, getWorld, sameProbe } from '../world/world'
import { mapFontsReady } from '../fonts'
import { bindPanZoom } from '../panZoom'
import { syllableSeed } from '../seed'
import { t } from '../i18n'
import { lang, onLang } from '../../i18n'
import { isTypingTarget } from '../keys'
import { decodeSettlement, encodeSettlement, roundParams } from './route'
import { describeAt } from '../../settlement/describe'
import { terrainKey } from '../../settlement/terrain'
import { planFits } from '../../settlement/culture'
import { LAND_USES, landUseOf, landUseStats, type LandUse, type LandUseStat } from '../../settlement/landuse'
import { peopleStats, type PeopleStat } from '../../settlement/people'
import { defaultRegions, type SettleRegion } from '../../settlement/regions'

/**
 * 聚落地图模块：参数、风格、导出 + 矢量查看器与悬停探针。
 * 世界已生成时可以选一个城镇，继承那里的环境。
 * 改参数只记下改动，点「生成」（或随机、回车）才重新生成；时间轴在当前这座城的成长史里穿梭。
 */
// 地址里带了参数（刷新、分享链接）就以地址为准，否则沿用上次存下的参数
const fromUrl = (() => {
  const q = initialQuery('settlement')
  return q && [...q.keys()].length ? decodeSettlement(q) : null
})()
const saved = (() => {
  try {
    return JSON.parse(storeGet('settleParams') ?? '{}') as Partial<SettlementParams> & { features?: Record<string, boolean> }
  } catch {
    return {}
  }
})()
/** 旧版本的要素开关：关掉的换成数量 0 */
const legacyCounts = Object.fromEntries(
  Object.entries(saved.features ?? {})
    .filter(([, on]) => !on)
    .map(([k]) => [k === 'tower' ? 'magic' : k, 0]),
) as Partial<Record<FeatureId, number>>
delete saved.features

/** 从世界地点继承来的字段：名字与气候（不存档、换地址时清掉） */
const INHERITED = { name: undefined, nameZh: undefined, nameJa: undefined, climate: undefined }
/** 独立生成：连同临海、临河、靠山的方位一起清掉 */
const DETACHED = { ...INHERITED, coastDir: NaN, riverDir: NaN, hillDir: NaN }

const initialParams: SettlementParams = fromUrl
  ? { ...DEFAULT_SETTLEMENT, ...fromUrl.params }
  : {
      ...DEFAULT_SETTLEMENT,
      ...saved,
      // 旧版本存下的参数：人口按档位换算，规整度按文明取默认
      population: saved.population ?? POP_OF_SIZE[saved.size ?? 'town'],
      // 布局与文明无关：旧存档的东方城默认是方城，换算成"规整、偏方格"
      regularity: saved.regularity ?? (saved.culture === 'eastern' ? 0.9 : LAYOUT_DEFAULT.regularity),
      radial: saved.radial ?? (saved.culture === 'eastern' ? 0 : LAYOUT_DEFAULT.radial),
      function: saved.function ?? 'balanced',
      counts: { ...legacyCounts, ...saved.counts },
      ...DETACHED,
    }

export type SettleTab = 'gen' | 'features' | 'style' | 'stats' | 'areas'
export const ss = reactive({
  params: initialParams,
  style: (fromUrl ? (fromUrl.style ?? 'parchment') : (storeGet('settleStyle') as SettleStyleId) || 'parchment') as SettleStyleId,
  opts: {
    labels: true,
    contours: true,
    /** 地图 / 区划图 */
    view: (storeGet('settleView') === 'zoning' ? 'zoning' : 'map') as 'map' | 'zoning',
    /** 区划图里关掉着色的类（点图例切换） */
    hidden: [] as LandUse[],
    /** 图饰：标题框、指北针、区划图例（默认不画，只在图廓层里；导出总是画） */
    ornaments: storeGet('settleOrnaments') === '1',
  },
  /** 区划各类的面积（图例用） */
  landUse: [] as LandUseStat[],
  /** 按职业的人口（图签里的职业表） */
  people: [] as PeopleStat[],
  /** 继承的世界地点（world.labels 的下标，-1 为独立生成） */
  from: -1,
  /** 世界地图上的城镇（地名按界面语言显示，见 SettlementPanel） */
  places: [] as { i: number; capital: boolean; name: string; zh: string; ja?: string }[],
  loading: { show: false, stage: '…' },
  info: null as { title: string; sub: string; tiles: [string, string][] } | null,
  probe: null as { title: string; rows: [string, string][] } | null,
  /** 当前这座城生成时所用的参数（滑杆双击回到这里；与 params 不同即有待生成的改动） */
  applied: null as SettlementParams | null,
  /** 时间轴：成长史的起止人口与正在显示的时刻（人口） */
  timeline: { from: 0, until: 0, at: 0 },
  /** 成长动画进行中 */
  growing: false,
  /** 舞台：地图，或编辑命名区域 */
  mode: 'map' as 'map' | 'areas',
  /** 区域视图：编辑中的命名区域、选中的那个、是否改过（改过就不再用默认的片区） */
  regions: [] as SettleRegion[],
  regionSel: null as string | null,
  regionsEdited: false,
  /** 地图在舞台上的位置（区域叠加层跟着它）：页面坐标 → 屏幕 = x + 页面·k；米 → 页面 = M + 米·S；frame 是露出地图的图框内框 */
  paper: { x: 0, y: 0, k: 1, M: 0, S: 1, half: 0, frame: { x: 0, y: 0, w: 0, h: 0 } },
  /** 侧边栏当前的分页 */
  tab: (['gen', 'features', 'style', 'stats'].includes(storeGet('settleTab') ?? '') ? storeGet('settleTab') : 'gen') as SettleTab,
  /** 点「随机」时：all 全部参数都随机、keep 保留配置只换种子；地形 random 跟着换、fixed 保持现在的山河海岸 */
  random: {
    mode: (storeGet('settleRandomMode') === 'keep' ? 'keep' : 'all') as 'all' | 'keep',
    terrain: (storeGet('settleRandomTerrain') === 'fixed' ? 'fixed' : 'random') as 'random' | 'fixed',
  },
})

export function setTab(tab: SettleTab) {
  ss.tab = tab
  storeSet('settleTab', tab)
}

/** 参数改过、还没重新生成 */
export const dirty = computed(() => !!ss.applied && paramSig(ss.params) !== paramSig(ss.applied))

/** 解除固定的地形：地形重新跟着种子与文明 */
export function unpinTerrain() {
  ss.params.terrainSeed = ''
}

export function setRandom(k: 'mode' | 'terrain', v: string) {
  if (k === 'mode') ss.random.mode = v === 'keep' ? 'keep' : 'all'
  else ss.random.terrain = v === 'fixed' ? 'fixed' : 'random'
  storeSet(k === 'mode' ? 'settleRandomMode' : 'settleRandomTerrain', v)
}

let st: Settlement | null = null
/**
 * 这座城的成长史（见 settlement/history.ts）：显示的地图是它在当前人口时的快照。
 * 成长动画、把人口往小拖都直接从它取；换了别的参数（run）重新推演
 */
let hist: SettlementHistory | null = null
const cache = new Map<string, DisplayList>()
let viewer: AtlasViewer | null = null
let host: HTMLElement | null = null
const view = { x: 0, y: 0, k: 1 }
/** 正在显示的列表（适配视图要它的地图范围） */
let shown: DisplayList | null = null
const chromeMeasurer = document.createElement('canvas').getContext('2d')!

// —— 世界地点列表 ——
let worldRef: World | null = null
export function refreshPlaces(load = true) {
  const w = getWorld()
  // 世界还没生成（没进过世界模块）：需要时开始生成，好了再列出
  if (!w && load) void ensureWorld().then((nw) => nw && refreshPlaces(false))
  if (w === worldRef) return
  worldRef = w
  if (!w) {
    ss.places = []
    return
  }
  const towns = w.labels.map((l, i) => ({ l, i })).filter(({ l }) => l.kind === 'city' || l.kind === 'capital')
  towns.sort((a, b) => b.l.weight - a.l.weight)
  ss.places = towns.map(({ l, i }) => ({ i, capital: l.kind === 'capital', name: l.name, zh: l.zh, ja: l.ja }))
  if (!ss.places.some((p) => p.i === ss.from)) ss.from = -1
}
function detach() {
  Object.assign(ss.params, DETACHED)
}
export function inheritFrom(idx: number) {
  ss.from = idx
  const w = getWorld()
  if (!w || idx < 0) detach()
  // 继承的地点有自己的地形（按它的种子），不沿用固定的地形
  else Object.assign(ss.params, fromWorld(w, w.labels[idx]), { terrainSeed: '' })
}
/** 换文明：原来的形制不属于新文明时退回有机生长 */
export function setCulture(c: Culture) {
  ss.params.culture = c
  if (!planFits(c, ss.params.plan)) ss.params.plan = 'organic'
}

export function setParam<K extends keyof SettlementParams>(k: K, v: SettlementParams[K]) {
  ss.params[k] = v
}

export function setLayout(r: number, g: number) {
  ss.params.regularity = r
  ss.params.radial = g
}
/** 要素数量：null 为自动推算 */
export function setCount(id: FeatureId, n: number | null) {
  if (n === null) delete ss.params.counts[id]
  else ss.params.counts[id] = n
}
/** 全部要素回到自动 */
export function resetCounts() {
  ss.params.counts = {}
}

// —— 生成与绘制 ——
const SYL = ['thorn', 'ash', 'wick', 'mere', 'ford', 'dale', 'brook', 'holm', 'stead', 'bury', 'ley', 'ton', 'wyn', 'mar', 'vel', 'or']
/** 按权重抽一项 */
function pick<T>(items: [T, number][]): T {
  let r = Math.random() * items.reduce((a, [, w]) => a + w, 0)
  for (const [v, w] of items) if ((r -= w) < 0) return v
  return items[items.length - 1][0]
}
/**
 * 随机一座聚落：种子之外，人口、文明、奇幻程度、功效、布局与环境也一起随机（按常见程度加权），
 * 各要素数量回到自动。只有地图风格与显示选项保持不变。
 */
export function randomSeed() {
  const p = ss.params
  const fixed = ss.random.terrain === 'fixed'
  // 固定地形：把现在的地形钉住（之后换种子、换文明，山、河、海岸都不变）；否则地形跟着新种子
  p.terrainSeed = fixed ? terrainKey(p) : ''
  p.seed = syllableSeed(SYL)
  // 保留配置：只换种子（继承的世界地点也保留）
  if (ss.random.mode === 'keep') return run()
  // 人口按对数均匀，小村到大都会都有机会
  p.population = Math.round(Math.exp(Math.log(60) + Math.random() * (Math.log(40000) - Math.log(60))))
  p.culture = pick<Culture>([
    ['western', 1],
    ['eastern', 1],
    ['wa', 1],
    ['islamic', 1],
  ])
  if (!planFits(p.culture, p.plan)) p.plan = 'organic'
  p.magic = pick<SettlementParams['magic']>([
    [0, 5],
    [1, 3],
    [2, 1.5],
  ])
  p.function = pick<CityFunction>([
    ['balanced', 4],
    ['fortress', 1.5],
    ['magic', p.magic ? 1.5 : 0.3],
    ['craft', 1.5],
    ['trade', 1.5],
  ])
  p.walls = 'auto'
  // 布局：多数偏有机，也常见规整的方城与环城
  p.regularity = +Math.pow(Math.random(), 0.8).toFixed(3)
  p.radial = +Math.random().toFixed(3)
  // 副中心多数与主城粘连，拉开成卫星城的是少数
  p.spread = +Math.pow(Math.random(), 3).toFixed(2)
  // 环境（河、海、山与起伏）就是地形：固定地形时不动
  if (!fixed) {
    p.river = Math.random() < 0.6
    p.coast = Math.random() < 0.35
    p.hills = Math.random() < 0.35
    p.relief = +(0.15 + Math.random() * 0.7).toFixed(2)
  }
  p.farms = Math.random() < 0.85
  p.farmland = +(0.15 + Math.random() * 0.7).toFixed(2)
  p.counts = {}
  // 随机即独立生成；固定地形时留着临海、临河、靠山的方位（地形的一部分）
  ss.from = -1
  Object.assign(p, fixed ? INHERITED : DETACHED)
  run()
}

let job = 0
/** 推演成长史的序号：参数变了（新的请求）就作废还没用上的旧结果（与重绘的 job 分开，推演时切风格不会丢掉结果） */
let gen = 0
/** 在后台推演（见 historyWorker.ts），期间显示加载提示 stage；被更新的请求取代时返回 null（提示留给新的请求收） */
async function historyFor(population: number, stage = '推演城市的成长史'): Promise<SettlementHistory | null> {
  const g = ++gen
  ss.loading.show = true
  ss.loading.stage = stage
  try {
    const h = await computeHistory({ ...toRaw(ss.params), population, counts: { ...toRaw(ss.params.counts) } })
    if (g !== gen) return null
    ss.loading.show = false
    return markRaw(h)
  } catch (err) {
    if (err instanceof Superseded) return null
    throw err
  }
}

export async function run() {
  ss.growing = false
  const p = ss.params
  p.seed = p.seed.trim() || 'settlement'
  roundParams(p)
  storeSet('settleParams', JSON.stringify({ ...toRaw(p), ...INHERITED }))
  // 地址只在提交生成时改写（拖动人口的实时预览、成长动画不写）
  syncRoute('settlement')
  try {
    const params = structuredClone(toRaw(p))
    const h = await historyFor(p.population, '规划街巷与街坊')
    if (!h) return
    hist = h
    ss.applied = params
    Object.assign(ss.timeline, { from: Math.min(GROWTH_FROM, h.until), until: h.until, at: h.until })
    st = markRaw(snapshot(hist, h.until))
  } catch (err) {
    console.error(err)
    ss.loading.stage = '生成失败：' + (err instanceof Error ? err.message : String(err))
    return
  }
  cache.clear()
  showInfo(st)
  if (ss.mode === 'areas') loadRegions()
  await refresh(true)
}

/** 先等地图字体样式表（@font-face 规则没到时 document.fonts.load 会直接返回），再等这幅图要用的字；两者合计最多等 wait 毫秒 */
async function settleFonts(s: Settlement, id: SettleStyleId, wait: number): Promise<{ ready: boolean; later: Promise<unknown> }> {
  const lg = lang
  const t0 = performance.now()
  const sheet = await Promise.race([mapFontsReady().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), wait))])
  if (sheet) return ensureSettleFonts(s, id, lg, Math.max(0, wait - (performance.now() - t0)))
  return { ready: false, later: mapFontsReady().then(() => ensureSettleFonts(s, id, lg, 0)).then((f) => f.later) }
}

/** 还在下载字体、到齐后要重画的风格（风格|语言） */
const fontWait = new Set<string>()
/** wait：最多等字体多久（毫秒）；成长动画、拖动这类逐帧刷新只等一下，免得每帧都卡在下载字体上 */
async function listFor(s: Settlement, id: SettleStyleId, wait = 2500) {
  let l = cache.get(id)
  if (l) return l
  const fonts = await settleFonts(s, id, wait)
  // 字体没等到就先用回退字体画；到齐以后这种风格的图作废、还在看它就重画。每种风格与语言只等一个（成长动画逐帧都会走到这里）
  const k = `${id}|${lang}`
  if (!fonts.ready && !fontWait.has(k)) {
    fontWait.add(k)
    void fonts.later.then(() => {
      fontWait.delete(k)
      cache.delete(id)
      if (ss.style === id) void refresh(false, true)
    })
  }
  const measurer = document.createElement('canvas').getContext('2d')!
  l = buildSettlementVector(s, id, { ...toRaw(ss.opts), hidden: [...toRaw(ss.opts.hidden)], lang, regions: regionEdits() }, measurer)
  cache.set(id, l)
  return l
}

async function refresh(fit = false, quiet = false) {
  if (!st || !host) return
  const s = st
  const id = ++job
  if (!cache.has(ss.style) && !quiet) {
    ss.loading.show = true
    ss.loading.stage = t('绘制{style}', { style: t(SETTLE_THEMES.find((th) => th.id === ss.style)!.name) })
    await new Promise((r) => setTimeout(r, 20))
  }
  const list = await listFor(s, ss.style, quiet ? 300 : 2500)
  if (id !== job) return
  ss.loading.show = false
  if (!viewer) {
    viewer = markRaw(new AtlasViewer(host))
    // 聚落图的字号设计得小（街名、小地点十来个像素）：放大时注记长到 1.5 倍再固定
    viewer.labelMax = 1.5
  }
  const same = !!shown && shown.width === list.width && shown.height === list.height
  shown = list
  // 图廓固定在舞台上、铺满剩余空间，缩放只动图框里的地图
  const style = ss.style
  const opts = { ...toRaw(ss.opts), hidden: [...toRaw(ss.opts.hidden)], lang }
  viewer.setChrome((w, h, box, k) => buildSettlementChrome(s, style, opts, chromeMeasurer, w, h, box, k, probeCard()), settleBackdrop(style), SETTLE_FRAME_INSET)
  viewer.setList(list)
  ss.paper.M = list.M
  ss.paper.S = list.MW / s.width
  if (fit || !same) fitView()
  else applyView()
}

/** 把视图交给查看器；区域视图里同步给叠加层 */
function applyView() {
  viewer?.setView(view.x, view.y, view.k)
  if (viewer && ss.mode === 'areas') Object.assign(ss.paper, { x: view.x, y: view.y, k: view.k, frame: viewer.frame() })
}

/** 显示一帧已经算好的地图（成长动画的快照） */
async function showFrame(s: Settlement) {
  st = markRaw(s)
  cache.clear()
  showInfo(st)
  await refresh(false, true)
}

/** 成长史从多少人开始（时间轴的起点） */
const GROWTH_FROM = 30

/** 时间轴：跳到成长史里人口为 pop 的时刻（拖动时连续调用：正在画就只记下最新的值，画完接着画） */
let seekBusy = false
let seekNext: number | null = null
export async function seek(pop: number) {
  if (!hist) return
  const tl = ss.timeline
  tl.at = Math.round(Math.min(tl.until, Math.max(tl.from, pop)))
  if (seekBusy) {
    seekNext = tl.at
    return
  }
  seekBusy = true
  try {
    await showFrame(snapshot(hist, tl.at))
  } finally {
    seekBusy = false
  }
  if (seekNext !== null) {
    const n = seekNext
    seekNext = null
    await seek(n)
  }
}

/**
 * 成长动画：在当前这座城的成长史（见 settlement/history.ts）里按对数人口逐帧取快照，
 * 从时间轴上的当前时刻播到最后（已在最后就从头播）——每样东西只出现一次、只在被新东西取代时消失。再点一次停止
 */
export async function playGrowth() {
  if (ss.growing) {
    ss.growing = false
    return
  }
  if (!hist) return
  const h = hist
  const tl = ss.timeline
  const start = tl.at >= tl.until ? tl.from : tl.at
  // 整条时间轴约 48 帧：从中途开始播，帧数按剩下的一段折算
  const span = Math.log(tl.until) - Math.log(tl.from) || 1
  const frames = Math.max(1, Math.round((48 * (Math.log(tl.until) - Math.log(start))) / span))
  const pops = Array.from({ length: frames + 1 }, (_, k) => Math.round(Math.exp(Math.log(start) + ((Math.log(tl.until) - Math.log(start)) * k) / frames)))
  ss.growing = true
  for (let k = 0; k <= frames && ss.growing && hist === h; k++) {
    const t0 = performance.now()
    tl.at = pops[k]
    await showFrame(snapshot(h, pops[k]))
    // 每帧至少停留 90 毫秒，小聚落算得快时也看得清
    await new Promise((r) => setTimeout(r, Math.max(0, 90 - (performance.now() - t0))))
  }
  ss.growing = false
}

export function setStyle(id: SettleStyleId) {
  ss.style = id
  storeSet('settleStyle', id)
  syncRoute('settlement')
  refresh()
}
export function setOpt(k: 'labels' | 'contours' | 'ornaments', v: boolean) {
  ss.opts[k] = v
  // 图饰只在图廓层里：地图本身不用重画
  if (k === 'ornaments') storeSet('settleOrnaments', v ? '1' : '0')
  else cache.clear()
  refresh(false, k === 'ornaments')
}
/** 地图 / 区划图 */
export function setView(v: 'map' | 'zoning') {
  ss.opts.view = v
  storeSet('settleView', v)
  cache.clear()
  refresh()
}
/** 区划图例：开关某一类的着色 */
export function toggleLandUse(u: LandUse) {
  const h = ss.opts.hidden
  ss.opts.hidden = h.includes(u) ? h.filter((x) => x !== u) : [...h, u]
  cache.clear()
  refresh(false, true)
}

/** 悬停读数画进图廓（右上角、指北针下面），跟着地图的纸色与字体 */
const probeCard = () => {
  const p = ss.probe
  return p && { title: t(p.title), rows: p.rows.map(([k, v]): [string, string] => [t(k), v]) }
}
watch(
  () => ss.probe,
  () => viewer?.refreshChrome(),
)

/** 把地图（不含页面的图廓）整个放进图框内框，四周留一点空 */
function fitView() {
  if (!shown || !viewer || !host) return
  const r = viewer.inner()
  const pad = 12
  const k = Math.min((r.w - pad * 2) / shown.MW, (r.h - pad * 2) / shown.MH)
  view.k = k
  view.x = r.x + (r.w - shown.MW * k) / 2 - shown.M * k
  view.y = r.y + (r.h - shown.MH * k) / 2 - shown.M * k
  applyView()
}

function showInfo(s: Settlement) {
  ss.landUse = landUseStats(s)
  ss.people = peopleStats(s)
  ss.info = {
    title: lang === 'zh' ? s.nameZh : lang === 'ja' ? s.nameJa : s.name,
    // 中文、日文界面附原名（与英文地图对照）；英文界面标题就是原名，不再附别的写法
    sub: `${lang === 'en' ? '' : `${s.name} · `}${(s.stats.ms / 1000).toFixed(2)} s`,
    tiles: [
      ['人口', `≈ ${s.stats.population.toLocaleString()}`],
      ['目标人口', s.params.population.toLocaleString()],
      ['民居', `${s.stats.houses.toLocaleString()} ${t('栋')}`],
      ['住户', `${s.stats.households.toLocaleString()} ${t('户')}`],
      ['建筑', s.stats.buildings.toLocaleString()],
      ['城区', `${s.stats.area.toFixed(1)} ha`],
      ['密度', `${Math.round(s.stats.population / Math.max(0.1, s.stats.area))} ${t('人/ha')}`],
      ['范围', `${(s.width / 1000).toFixed(1)}×${(s.height / 1000).toFixed(1)} km`],
      ['城门', String(s.landmarks.filter((l) => l.kind === 'gate').length)],
      ['桥 / 渡', String(s.crossings.length)],
    ],
  }
}

// —— 平移缩放 ——
export function mountSettlement(el: HTMLElement) {
  host = el
  bindPanZoom(el, view, applyView, { min: 0.1, max: 40, fit: fitView })
  el.addEventListener('pointermove', (e) => probeAt(e.clientX, e.clientY))
  el.addEventListener('pointerleave', () => (ss.probe = null))
  window.addEventListener('resize', () => app.module === 'settlement' && fitView())
  start()
}

// —— 探针：悬停显示片区与海拔 ——
let raf = 0
/** 上次命中的片区（片区互不重叠，指针多半还在它里面，先查它省掉逐片区扫描） */
let lastWard: { st: Settlement; ward: Ward } | null = null
/** 上次算 describeAt 的位置与结果：同一聚落、同一片区里移动不到 1 m 就沿用 */
let lastWhat: { st: Settlement; ward: Ward | undefined; q: P; what: ReturnType<typeof describeAt> } | null = null
function probeAt(clientX: number, clientY: number) {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    const list = cache.get(ss.style)
    if (!st || !list || !host) return
    const r = host.getBoundingClientRect()
    const S = list.MW / st.width
    const q: P = [((clientX - r.left - view.x) / view.k - list.M) / S, ((clientY - r.top - view.y) / view.k - list.M) / S]
    if (q[0] < 0 || q[1] < 0 || q[0] > st.width || q[1] > st.height) {
      ss.probe = null
      return
    }
    const T = st.terrain
    const i = Math.min(T.W - 1, Math.round(q[0] / T.cell))
    const j = Math.min(T.H - 1, Math.round(q[1] / T.cell))
    const k = j * T.W + i
    const wet = T.water[k] < 0
    const cur = st
    const ward = lastWard?.st === cur && pointInPoly(q, lastWard.ward.poly) ? lastWard.ward : cur.wards.find((w) => pointInPoly(q, w.poly))
    if (ward) lastWard = { st: cur, ward }
    // 指着的东西（建筑、田、园林、街……）优先作标题，下面列它的读数，再列所在的片区
    let what: ReturnType<typeof describeAt> = null
    if (!wet) {
      const c = lastWhat
      if (c && c.st === cur && c.ward === ward && Math.hypot(q[0] - c.q[0], q[1] - c.q[1]) < 1) what = c.what
      else {
        what = describeAt(cur, q, ward)
        lastWhat = { st: cur, ward, q, what }
      }
    }
    const wardName = ward ? (ward.name?.[lang] ?? t(WARD_NAMES[ward.type] ?? '野地')) : t('野地')
    const title = wet ? (st.sea && T.height[k] < -0.6 && !st.river ? st.sea.name[lang] : t('水域')) : what ? (what.name?.[lang] ?? t(what.title)) : wardName
    const rows: [string, string][] = []
    if (what?.name) rows.push(['类型', t(what.title)])
    if (what) for (const [key, v, tr] of what.rows) rows.push([key, tr ? t(v) : v])
    if (ward && !wet) rows.push(['片区', (what ? wardName : t(WARD_NAMES[ward.type] ?? '野地')) + (ward.inner ? t('（城内）') : '')])
    const use = ward && !wet ? landUseOf(ward.type) : null
    if (use) rows.push(['区划', t(LAND_USES.find((d) => d.id === use)!.name)])
    rows.push([wet ? '水深' : '海拔', `${Math.abs(T.height[k]).toFixed(1)} m`])
    rows.push(['坐标', `${Math.round(q[0])}, ${Math.round(q[1])} m`])
    // 内容没变就不换对象，免得触发图廓重排
    if (sameProbe(ss.probe, title, rows)) return
    ss.probe = { title, rows }
  })
}

// —— 导出 ——
const fileBase = () => `${(st?.name ?? 'settlement').toLowerCase()}-${st?.params.seed ?? ss.params.seed}-${ss.style}${ss.opts.view === 'zoning' ? '-zoning' : ''}`
export async function exportPng() {
  if (!st) return
  const list = await listFor(st, ss.style, 60000)
  const c = document.createElement('canvas')
  c.width = list.width * 2
  c.height = list.height * 2
  list.render(c.getContext('2d')!, 2, 0, 0)
  download(c.toDataURL('image/png'), `${fileBase()}.png`)
}
export async function exportSvg() {
  if (!st) return
  const list = await listFor(st, ss.style, 60000)
  download(new Blob([list.toSVG()], { type: 'image/svg+xml' }), `${fileBase()}.svg`)
}

// —— 命名区域：区域视图里改名、拖边界；改动按"生成这座城的参数"存在本机，同一座城下次打开还在 ——
const REGION_STORE = 'settleRegions'
const REGION_KEEP = 12
/** 这座城（按生成时的参数）存下的区域改动 */
let keyMemo: { p: SettlementParams; k: string } | null = null
function regionKey() {
  const p = ss.applied
  if (!p) return ''
  if (keyMemo?.p !== p) keyMemo = { p, k: paramSig(p) }
  return keyMemo.k
}
// 时间轴拖动、成长动画每帧都要读：存储内容没变就沿用上次解析的结果
type RegionStore = Record<string, { t: number; regions: SettleRegion[] }>
let storeMemo: { raw: string | null; data: RegionStore } | null = null
function readRegionStore(): RegionStore {
  const raw = storeGet(REGION_STORE)
  if (storeMemo?.raw === raw) return storeMemo.data
  let data: RegionStore = {}
  try {
    data = JSON.parse(raw ?? '{}')
  } catch {
    // 坏数据当作没存过
  }
  storeMemo = { raw, data }
  return data
}
/** 改过的区域（没改过为 undefined：片区名照生成的标） */
function regionEdits(): SettleRegion[] | undefined {
  const k = regionKey()
  return k ? readRegionStore()[k]?.regions : undefined
}
/** 默认的区域：取成长史的最终状态（不随时间轴停在哪一刻变） */
function currentRegions(): SettleRegion[] {
  return regionEdits() ?? (hist ? defaultRegions(hist.st) : [])
}
function loadRegions() {
  ss.regions = structuredClone(currentRegions())
  ss.regionsEdited = !!regionEdits()
  if (ss.regionSel && !ss.regions.some((r) => r.id === ss.regionSel)) ss.regionSel = null
}
const regionUndo: SettleRegion[][] = []
export function regionCheckpoint(prev?: SettleRegion[]) {
  regionUndo.push(prev ?? structuredClone(toRaw(ss.regions)))
  if (regionUndo.length > 60) regionUndo.shift()
}
let regionTimer = 0
/** 改动存起来、注记按新的区域重排（拖动过程中不调，松手时调） */
export function commitRegions(edited: SettleRegion[] | null = structuredClone(toRaw(ss.regions))) {
  const k = regionKey()
  if (!k) return
  const store = { ...readRegionStore() }
  if (edited) store[k] = { t: Date.now(), regions: edited }
  else delete store[k]
  // 只留最近的几座城
  const keys = Object.keys(store).sort((a, b) => store[b].t - store[a].t)
  for (const old of keys.slice(REGION_KEEP)) delete store[old]
  storeSet(REGION_STORE, JSON.stringify(store))
  ss.regionsEdited = !!edited
  clearTimeout(regionTimer)
  regionTimer = window.setTimeout(() => {
    cache.clear()
    refresh(false, true)
  }, 80)
}
export function undoRegions() {
  const prev = regionUndo.pop()
  if (!prev) return
  ss.regions = prev
  if (ss.regionSel && !ss.regions.some((r) => r.id === ss.regionSel)) ss.regionSel = null
  commitRegions()
}
export function selectRegion(id: string | null) {
  ss.regionSel = id
}
/** 丢掉这座城的区域改动，回到默认的片区 */
export function resetRegions() {
  if (!ss.regionsEdited) return
  regionCheckpoint()
  commitRegions(null)
  loadRegions()
}
export function setMode(m: 'map' | 'areas') {
  ss.mode = m
  if (m === 'areas') {
    loadRegions()
    setTab('areas')
    applyView()
  } else if (ss.tab === 'areas') setTab('gen')
}
/** 在视图中央放一个新区域（六边形），选中它 */
export function addRegion() {
  if (!viewer) return
  regionCheckpoint()
  const f = viewer.frame()
  const P = ss.paper
  const cx = (f.x + f.w / 2 - P.x) / P.k / P.S - P.M / P.S
  const cy = (f.y + f.h / 2 - P.y) / P.k / P.S - P.M / P.S
  const r = Math.min(f.w, f.h) / 6 / P.k / P.S
  const poly: [number, number][] = []
  for (let i = 0; i < 6; i++) poly.push([cx + r * Math.cos((i * Math.PI) / 3), cy + r * Math.sin((i * Math.PI) / 3)])
  const id = `user:${Date.now().toString(36)}`
  const n = t('新区域')
  ss.regions.push({ id, name: { en: n, zh: n, ja: n }, poly, at: [cx, cy], size: Math.PI * r * r })
  ss.regionSel = id
  commitRegions()
}
export function deleteRegion(id: string) {
  const i = ss.regions.findIndex((r) => r.id === id)
  if (i < 0) return
  regionCheckpoint()
  ss.regions.splice(i, 1)
  if (ss.regionSel === id) ss.regionSel = null
  commitRegions()
}
/** 把地图移到区域上（区域比视口大就缩小到整个放下） */
export function focusRegion(id: string) {
  const r = ss.regions.find((x) => x.id === id)
  if (!r || !viewer) return
  const P = ss.paper
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of r.poly) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const f = viewer.inner()
  view.k = Math.min(view.k, (f.w * 0.8) / Math.max(1, (x1 - x0) * P.S), (f.h * 0.8) / Math.max(1, (y1 - y0) * P.S))
  view.x = f.x + f.w / 2 - (P.M + ((x0 + x1) / 2) * P.S) * view.k
  view.y = f.y + f.h / 2 - (P.M + ((y0 + y1) / 2) * P.S) * view.k
  applyView()
}

window.addEventListener('keydown', (e) => {
  if (app.module !== 'settlement') return
  if (ss.mode === 'areas' && !isTypingTarget(e) && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    undoRegions()
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e)) return
  if (e.key === 'r' || e.key === 'R') randomSeed()
})

// 第一次进入聚落模块时才生成
function start() {
  if (app.module !== 'settlement' || !host) return
  refreshPlaces(false)
  if (!st) run()
  else requestAnimationFrame(fitView)
}
watch(() => app.module, start)

// —— URL：#/settlement?seed=...（编码见 route.ts） ——
registerRoute('settlement', {
  query: () => encodeSettlement(ss.params, ss.style),
  // 前进后退或手改地址：换成地址里的参数重新生成；地址没带参数时保持现状
  apply(q) {
    if (![...q.keys()].length) return
    const d = decodeSettlement(q)
    ss.from = -1
    Object.assign(ss.params, { ...DEFAULT_SETTLEMENT, ...INHERITED, ...d.params })
    ss.style = d.style ?? 'parchment'
    storeSet('settleStyle', ss.style)
    if (host && app.module === 'settlement') run()
  },
})

// —— 语言：地图文字（地名、片区、街名、图题）重排版 ——
onLang(() => {
  if (!st) return
  showInfo(st)
  cache.clear()
  if (app.module === 'settlement') refresh(false, true)
})
