import { markRaw, reactive, toRaw, watch } from 'vue'
import type { World } from '../../gen/types'
import type { DisplayList } from '../../render/atlas/svg/displayList'
import { AtlasViewer } from '../../render/atlas/svg/viewer'
import { fromWorld } from '../../settlement/fromWorld'
import { generateHistory } from '../../settlement/generate'
import { snapshot, type SettlementHistory } from '../../settlement/history'
import { pointInPoly, type P } from '../../settlement/geom'
import { SETTLE_FRAME_INSET, buildSettlementChrome, buildSettlementVector, ensureSettleFonts, settleBackdrop } from '../../settlement/render'
import { SETTLE_THEMES, type SettleStyleId } from '../../settlement/themes'
import type { CityFunction, FeatureId } from '../../settlement/features'
import { POP_OF_SIZE } from '../../settlement/scale'
import { DEFAULT_SETTLEMENT, LAYOUT_DEFAULT, WARD_NAMES, type Culture, type Settlement, type SettlementParams } from '../../settlement/types'
import { app, download, initialQuery, registerRoute, storeGet, storeSet, syncRoute } from '../app'
import { ensureWorld, getWorld } from '../world/world'
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

/**
 * 聚落地图模块：参数、风格、导出 + 矢量查看器与悬停探针。
 * 世界已生成时可以选一个城镇，继承那里的环境。
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
  },
  /** 区划各类的面积（图例用） */
  landUse: [] as LandUseStat[],
  /** 继承的世界地点（world.labels 的下标，-1 为独立生成） */
  from: -1,
  places: [] as { i: number; label: string }[],
  loading: { show: false, stage: '…' },
  info: null as { title: string; sub: string; tiles: [string, string][] } | null,
  probe: null as { title: string; rows: [string, string][] } | null,
  /** 成长动画进行中 */
  growing: false,
  /** 点「随机」时：all 全部参数都随机、keep 保留配置只换种子；地形 random 跟着换、fixed 保持现在的山河海岸 */
  random: {
    mode: (storeGet('settleRandomMode') === 'keep' ? 'keep' : 'all') as 'all' | 'keep',
    terrain: (storeGet('settleRandomTerrain') === 'fixed' ? 'fixed' : 'random') as 'random' | 'fixed',
  },
})

/** 解除固定的地形：地形重新跟着种子与文明 */
export function unpinTerrain() {
  ss.params.terrainSeed = ''
  run()
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
  ss.places = towns.map(({ l, i }) => ({ i, label: `${l.kind === 'capital' ? '★ ' : ''}${l.zh} · ${l.name}` }))
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
  run()
}
/** 换文明：原来的形制不属于新文明时退回有机生长 */
export function setCulture(c: Culture) {
  ss.params.culture = c
  if (!planFits(c, ss.params.plan)) ss.params.plan = 'organic'
  run()
}

export function setParam<K extends keyof SettlementParams>(k: K, v: SettlementParams[K], regen = true) {
  ss.params[k] = v
  if (regen) run()
}

/** 布局三角：拖动时只改参数，松手才重算 */
export function setLayout(r: number, g: number) {
  ss.params.regularity = r
  ss.params.radial = g
}
/** 要素数量：null 为自动推算。连续点击时稍等再重算 */
let countTimer = 0
export function setCount(id: FeatureId, n: number | null) {
  if (n === null) delete ss.params.counts[id]
  else ss.params.counts[id] = n
  clearTimeout(countTimer)
  countTimer = window.setTimeout(run, 250)
}
/** 全部要素回到自动 */
export function resetCounts() {
  ss.params.counts = {}
  run()
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
export async function run() {
  ss.growing = false
  const id = ++job
  const p = ss.params
  p.seed = p.seed.trim() || 'settlement'
  roundParams(p)
  storeSet('settleParams', JSON.stringify({ ...toRaw(p), ...INHERITED }))
  // 地址只在提交生成时改写（拖动人口的实时预览、成长动画不写）
  syncRoute('settlement')
  ss.loading.show = true
  ss.loading.stage = '规划街巷与街坊'
  await new Promise((r) => setTimeout(r, 30))
  if (id !== job) return
  try {
    hist = markRaw(generateHistory({ ...toRaw(p), counts: { ...toRaw(p.counts) } }))
    st = markRaw(snapshot(hist, p.population))
  } catch (err) {
    console.error(err)
    ss.loading.stage = '生成失败：' + (err instanceof Error ? err.message : String(err))
    return
  }
  cache.clear()
  showInfo(st)
  await refresh(true)
}

async function listFor(s: Settlement, id: SettleStyleId) {
  let l = cache.get(id)
  if (l) return l
  await ensureSettleFonts(s, id, lang)
  const measurer = document.createElement('canvas').getContext('2d')!
  l = buildSettlementVector(s, id, { ...toRaw(ss.opts), hidden: [...toRaw(ss.opts.hidden)], lang }, measurer)
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
  const list = await listFor(s, ss.style)
  if (id !== job) return
  ss.loading.show = false
  if (!viewer) viewer = markRaw(new AtlasViewer(host))
  const same = !!shown && shown.width === list.width && shown.height === list.height
  shown = list
  // 图廓固定在舞台上、铺满剩余空间，缩放只动图框里的地图
  const style = ss.style
  const opts = { ...toRaw(ss.opts), hidden: [...toRaw(ss.opts.hidden)], lang }
  viewer.setChrome((w, h, box, k) => buildSettlementChrome(s, style, opts, chromeMeasurer, w, h, box, k, probeCard()), settleBackdrop(style), SETTLE_FRAME_INSET)
  viewer.setList(list)
  if (fit || !same) fitView()
  else viewer.setView(view.x, view.y, view.k)
}

/**
 * 生成并显示一帧，不显示加载遮罩（拖动人口、成长动画用）。
 * 同一个种子的聚落是连续长大的（见 generate.ts），所以逐帧换人口看起来就是在长。
 */
async function quickRun(population = ss.params.population) {
  // 比算好的成长史小：就是这座城当年的样子，直接取快照；比它大才重新推演
  if (!hist || population > hist.until) hist = markRaw(generateHistory({ ...toRaw(ss.params), population, counts: { ...toRaw(ss.params.counts) } }))
  await showFrame(snapshot(hist, population))
}

/** 拖动时实时重算：正在算就只记下"还要再算"，算完接着算最新的值，不排队 */
let liveBusy = false
let liveAgain = false
export function runLive() {
  ss.growing = false
  if (liveBusy) {
    liveAgain = true
    return
  }
  liveBusy = true
  requestAnimationFrame(async () => {
    try {
      await quickRun()
    } finally {
      liveBusy = false
      if (liveAgain) {
        liveAgain = false
        runLive()
      }
    }
  })
}

/** 显示一帧已经算好的地图（成长动画的快照） */
async function showFrame(s: Settlement) {
  st = markRaw(s)
  cache.clear()
  showInfo(st)
  await refresh(false, true)
}

/**
 * 成长动画：先推演一次这座城从几十人长到目标人口的成长史（见 settlement/history.ts），
 * 再按对数人口逐帧取快照——每样东西只出现一次、只在被新东西取代时消失，城是真的一路长大的。再点一次停止
 */
export async function playGrowth() {
  if (ss.growing) {
    ss.growing = false
    return
  }
  ss.growing = true
  const target = ss.params.population
  const from = Math.min(30, target)
  const frames = 48
  const pops = Array.from({ length: frames + 1 }, (_, k) => Math.round(Math.exp(Math.log(from) + ((Math.log(target) - Math.log(from)) * k) / frames)))
  // 现在显示的地图就是这座城成长史的最后一刻：还没算过（或拖小过人口）才推演一次
  if (!hist || hist.until !== target) {
    ss.loading.show = true
    ss.loading.stage = '推演城市的成长史'
    await new Promise((r) => setTimeout(r, 30))
    if (!ss.growing) {
      ss.loading.show = false
      return
    }
    hist = markRaw(generateHistory({ ...toRaw(ss.params), population: target, counts: { ...toRaw(ss.params.counts) } }))
    ss.loading.show = false
  }
  const h = hist
  for (let k = 0; k <= frames && ss.growing; k++) {
    const t0 = performance.now()
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
export function setOpt(k: 'labels' | 'contours', v: boolean) {
  ss.opts[k] = v
  cache.clear()
  refresh()
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
  viewer.setView(view.x, view.y, view.k)
}

function showInfo(s: Settlement) {
  ss.landUse = landUseStats(s)
  ss.info = {
    title: lang === 'zh' ? s.nameZh : lang === 'ja' ? s.nameJa : s.name,
    sub: `${lang === 'en' ? s.nameZh : s.name} · ${(s.stats.ms / 1000).toFixed(2)} s`,
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
  bindPanZoom(el, view, () => viewer?.setView(view.x, view.y, view.k), { min: 0.1, max: 40, fit: fitView })
  el.addEventListener('pointermove', (e) => probeAt(e.clientX, e.clientY))
  el.addEventListener('pointerleave', () => (ss.probe = null))
  window.addEventListener('resize', () => app.module === 'settlement' && fitView())
  start()
}

// —— 探针：悬停显示片区与海拔 ——
let raf = 0
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
    const ward = st.wards.find((w) => pointInPoly(q, w.poly))
    // 指着的东西（建筑、田、园林、街……）优先作标题，下面列它的读数，再列所在的片区
    const what = wet ? null : describeAt(st, q, ward)
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
    ss.probe = { title, rows }
  })
}

// —— 导出 ——
const fileBase = () => `${(st?.name ?? 'settlement').toLowerCase()}-${ss.params.seed}-${ss.style}${ss.opts.view === 'zoning' ? '-zoning' : ''}`
export async function exportPng() {
  if (!st) return
  const list = await listFor(st, ss.style)
  const c = document.createElement('canvas')
  c.width = list.width * 2
  c.height = list.height * 2
  list.render(c.getContext('2d')!, 2, 0, 0)
  download(c.toDataURL('image/png'), `${fileBase()}.png`)
}
export async function exportSvg() {
  if (!st) return
  const list = await listFor(st, ss.style)
  download(new Blob([list.toSVG()], { type: 'image/svg+xml' }), `${fileBase()}.svg`)
}

window.addEventListener('keydown', (e) => {
  if (app.module !== 'settlement') return
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
