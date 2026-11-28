import { computed, markRaw, reactive, watch } from 'vue'
import type { DisplayList } from '../../render/atlas/svg/displayList'
import { AtlasViewer } from '../../render/atlas/svg/viewer'
import { cultures } from '../../settlement/culture'
import { chaikin, pointInPoly, polylineLength, segDist, type P } from '../../settlement/geom'
import {
  addRoad, GROW_VERSION, lotAtPoint, paintTerrain, placeAt, probeLot, removeLot, removeRoad, withStroke,
  type GrowBrush, type GrowFault, type GrowLot, type GrowP, type GrowParams, type GrowRoadKind, type GrowState, type GrowStroke,
} from '../../settlement/grow'
import { ROAD_WIDTH, UNIT_D, UNIT_W, WAY_ID, cm, sameItems } from '../../settlement/grow/core'
import { advance, newDriver, type GrowDriver } from '../../settlement/grow/demands'
import { toSettlement } from '../../settlement/grow/draw'
import { adoptRoads, clearArea, naturalParams, naturalReady, primeNatural, seedNatural, settleNatural, withGuides } from '../../settlement/grow/natural'
import { simplify } from '../../settlement/grow/place'
import { SETTLE_FRAME_INSET, buildSettlementChrome, buildSettlementVector, ensureSettleFonts, settleBackdrop } from '../../render/settlementMap'
import { settleThemes } from '../../settlement/themes'
import { changedBoxes } from '../../settlement/history'
import type { Settlement } from '../../settlement/types'
import { lang } from '../../i18n'
import { app, download, initialQuery, registerRoute, storeGet, storeSet, stored, syncRoute, type Notice } from '../app'
import { mapFontsReady } from '../fonts'
import { t } from '../i18n'
import { isTypingTarget } from '../../render/keys'
import { bindPanZoom, fitInto } from '../panZoom'
import { UndoStack } from '../undo'
import { syllableSeed } from '../seed'
import { historyClient } from '../settlement/historyWorker'
import './strings'

/**
 * 村落生长模块：生长引擎（settlement/grow）的界面。只有一种聚落：
 *   这片地按选定的规模规划好一份成长史（和聚落地图「一键生成」的是同一套规划），聚落沿着它长——需求一条条来，
 *   路、房子、田、地标按规划一步步出现。「生成」一口气长到目标人口（记一步撤销），「回放」按步速一步步长给人看。
 *   新建地图可以是一块空白平地（从零动手），也可以是按种子随机的地形。
 *   同一座聚落上可以随时动手：舞台底部的工具栏像游戏的建造栏——
 *   道路（按住拖动随手画，或一下一下点出折线；过河自动架桥）、建筑（点一下摆一块，按住沿路拖摆一排）、
 *   地形（抬高、压低、平整、挖水、填陆的笔刷）、拆除（点一下，或按住拖着拆）。
 *   手动的东西优先于规划：规划里的房子、田落在手动的路、地块上的就让开；改了地形，规划按新的地形重算。
 * 每一步都能撤销、重做，进度存在本机；地址里只有开局的参数（#/grow?seed=...）。
 * 选了工具时左键归工具，右键或中键拖动平移；点选工具下左键拖动平移。
 */

/** 开局的参数：地形参数（方向总是随种子）、规划的规模（人口；画幅由它定） */
export interface GrowSetup {
  seed: string
  culture: string
  river: boolean
  coast: boolean
  hills: boolean
  relief: number
  /** 基底是一块平地（地形从头用笔刷刷） */
  flat: boolean
  horizon: number
}
// 默认的文明：和风（它所在的插件没启用时用注册表的默认）
const DEFAULT_SETUP: GrowSetup = { seed: 'aki', culture: cultures.has('wa') ? 'wa' : cultures.defaultId(), river: true, coast: false, hills: false, relief: 0.3, flat: false, horizon: 3000 }
/** 地图大小：规划的规模（人口；画幅由它定）与界面上的叫法 */
export const SIZES = [
  { pop: 600, name: '小' },
  { pop: 3000, name: '中' },
  { pop: 8000, name: '大' },
]
export const HORIZONS = SIZES.map((x) => x.pop)
export const sizeName = (pop: number) => SIZES.find((x) => x.pop === pop)?.name ?? ''
/** 空白平地：没有河、海、山，也不起伏 */
export const isBlank = (t: { flat?: boolean; river: boolean; coast: boolean; hills: boolean }) => !!t.flat && !t.river && !t.coast && !t.hills
const paramsOf = (p: GrowSetup): GrowParams => ({
  seed: p.seed,
  culture: p.culture,
  river: p.river,
  coast: p.coast,
  hills: p.hills,
  relief: p.relief,
  ...(p.flat ? { flat: true } : {}),
  coastDir: null,
  riverDir: null,
  hillDir: null,
  size: [0, 0],
})
const newGame = (p: GrowSetup) => seedNatural(paramsOf(p), p.horizon)
const setupOf = (s: GrowState): GrowSetup => ({ seed: s.seed, culture: s.terrain.culture, river: s.terrain.river, coast: s.terrain.coast, hills: s.terrain.hills, relief: s.terrain.relief, flat: !!s.terrain.flat, horizon: s.plan!.horizon })
const sameSetup = (a: GrowSetup, b: GrowSetup) => JSON.stringify(a) === JSON.stringify(b)

// —— 地址 ——
function encode(p: GrowSetup, style: string) {
  const q = new URLSearchParams()
  q.set('seed', p.seed)
  if (p.culture !== DEFAULT_SETUP.culture) q.set('culture', p.culture)
  for (const k of ['river', 'coast', 'hills', 'flat'] as const) if (p[k] !== DEFAULT_SETUP[k]) q.set(k, p[k] ? '1' : '0')
  if (p.relief !== DEFAULT_SETUP.relief) q.set('relief', String(p.relief))
  if (p.horizon !== DEFAULT_SETUP.horizon) q.set('horizon', String(p.horizon))
  if (style !== settleThemes.defaultId()) q.set('style', style)
  return q
}
function decode(q: URLSearchParams, notices: Notice[]): { setup: GrowSetup; style?: string } {
  const p = { ...DEFAULT_SETUP }
  const seed = q.get('seed')
  if (seed) p.seed = seed
  const c = q.get('culture')
  if (c) {
    if (cultures.has(c)) p.culture = c
    else notices.push({ source: 'link', what: cultures.label, id: c })
  }
  for (const k of ['river', 'coast', 'hills', 'flat'] as const) if (q.has(k)) p[k] = q.get(k) === '1'
  const r = Number(q.get('relief'))
  if (q.has('relief') && Number.isFinite(r)) p.relief = Math.min(1, Math.max(0, r))
  if (HORIZONS.includes(Number(q.get('horizon')))) p.horizon = Number(q.get('horizon'))
  const st = q.get('style') ?? undefined
  if (st && !settleThemes.has(st)) notices.push({ source: 'link', what: settleThemes.label, id: st })
  return { setup: p, style: st && settleThemes.has(st) ? st : undefined }
}

// —— 存档：本机记着最近一局（生长状态、驱动）；开局的参数从状态里读 ——
interface Save {
  v: number
  state: GrowState
  driver: GrowDriver
}
function loadSave(): Save | null {
  try {
    const s = JSON.parse(storeGet('growSave') ?? 'null') as Save | null
    // 旧版本存下的、不带规划的一局（沿路一块块摆的那种）不再接着来
    if (!s || s.v !== GROW_VERSION || s.state?.v !== GROW_VERSION || !s.state.plan || !cultures.has(s.state.terrain.culture)) return null
    return s
  } catch {
    return null
  }
}

const startNotices: Notice[] = []
const fromUrl = (() => {
  const q = initialQuery('grow')
  return q && [...q.keys()].length ? decode(q, startNotices) : null
})()
const saved = loadSave()
/** 地址里的参数与存档的一局相同就接着存档来，否则按参数开一局新的 */
const first: Save = saved && (!fromUrl || sameSetup(fromUrl.setup, setupOf(saved.state))) ? saved : { v: GROW_VERSION, state: newGame(fromUrl?.setup ?? DEFAULT_SETUP), driver: newDriver() }

/** 属性（读数、选中的东西、统计）；地图（新建、绘图风格） */
export type GrowTab = 'info' | 'map'
/** 点选、道路、建筑、地形、拆除 */
export type GrowTool = 'look' | 'road' | 'build' | 'terrain' | 'erase'
/** 选中、指针下的东西：地块、路；plan 是画面上自动长出的一栋房子、一块田（没有地块对着它的也算，只给拆除用） */
export type GrowSel = { kind: 'lot' | 'road'; id: number } | { kind: 'plan'; poly: GrowP[] } | null

/** 用途的名称、颜色（面板、舞台共用） */
export const USE_NAME: Record<string, string> = { center: '村心', home: '住处', shop: '铺子', public: '公所', yard: '料场', field: '田' }
export const USE_COLOR: Record<string, string> = { center: '#b0413e', home: '#c9822b', shop: '#8a4fa8', public: '#2f6fae', yard: '#7a6a4f', field: '#5f8f3a' }
export const ROAD_NAME: Record<GrowRoadKind, string> = { highway: '大路', street: '街', lane: '巷' }
export const BRUSH_NAME: Record<GrowBrush, string> = { raise: '抬高', lower: '压低', flat: '平整', water: '挖水', land: '填陆' }
export const BRUSH_COLOR: Record<GrowBrush, string> = { raise: '#8a6a3c', lower: '#6f6a60', flat: '#8a8072', water: '#4f8fa8', land: '#b79a5c' }
/** 各工具的子选项（工具栏上面的一行；数字键 1 ~ 9 选） */
export const ROAD_KINDS: GrowRoadKind[] = ['highway', 'street', 'lane']
export const BUILD_USES = ['home', 'field', 'shop', 'yard', 'public', 'center']
export const BRUSHES: GrowBrush[] = ['raise', 'lower', 'flat', 'water', 'land']
export const BRUSH_R = { min: 10, max: 150, step: 5 }

/** 被拒绝的原因（界面上的说法） */
const FAULT: Record<GrowFault, string> = {
  edge: '出了画幅',
  lot: '压到了地块',
  road: '压到了路',
  water: '离水太近',
  sea: '不能下海',
  bridge: '桥太长',
  slope: '地太陡：先用「平整」',
  far: '要挨着路',
  short: '太短',
}

export const gs = reactive({
  tab: (['info', 'map'].includes(storeGet('growTab') ?? '') ? storeGet('growTab') : 'info') as GrowTab,
  /** 「新建地图」卡片上的参数（打开卡片时取当前这一张的，点「新建」才生效） */
  setup: setupOf(first.state) as GrowSetup,
  /** 「新建地图」卡片开着：头一回进来（没有存档、地址里也没有参数）时自动打开 */
  creating: !saved && !fromUrl,
  /** 生成的目标人口 */
  target: 0,
  style: fromUrl?.style ?? stored('growStyle', settleThemes, startNotices),
  /** 当前这一局（markRaw：状态是不可变的大对象，整个替换） */
  state: markRaw(first.state) as GrowState,
  driver: first.driver as GrowDriver,
  /** 在长：生成（一口气长到目标）、回放（按步速一步步长），或停着 */
  run: 'idle' as 'idle' | 'replay' | 'rush',
  /** 回放速度（步 / 秒） */
  speed: Number(storeGet('growSpeed')) || 8,
  tool: 'look' as GrowTool,
  roadKind: 'street' as GrowRoadKind,
  buildUse: 'home',
  brush: 'raise' as GrowBrush,
  /** 笔刷半径（米） */
  brushR: Number(storeGet('growBrushR')) || 40,
  /** 一下一下点出来的路的顶点（米） */
  draft: [] as GrowP[],
  /** 按住拖动中的一笔：路的走线、地形笔画（米） */
  free: null as GrowP[] | null,
  /** 指针所在处（米） */
  cursor: null as GrowP | null,
  /** 路的预览（接到已有的路上之后的样子）：ok 为 false 时画成不行的颜色 */
  preview: null as { pts: GrowP[]; ok: boolean } | null,
  /** 建筑工具下指针处会摆出来的地块 */
  ghost: null as { poly: GrowP[]; ok: boolean } | null,
  /** 画路时指针吸到的已有的路上的点（画一个圈） */
  snap: null as GrowP | null,
  /** 指针旁的一行字：长度、不行的原因 */
  tip: null as { text: string; bad: boolean } | null,
  /** 指针下的东西（点选、拆除时描出来） */
  hot: null as GrowSel,
  sel: null as GrowSel,
  /** 舞台上的一行说明：拒绝的原因、摆不下…… */
  msg: '',
  notices: startNotices,
  /** 地图在舞台上的位置（叠加层跟着它）：米 → 页面 = M + 米·S；页面 → 舞台 = x + 页面·k；frame 是露出地图的图框内框 */
  paper: { x: 0, y: 0, k: 1, M: 0, S: 1, frame: { x: 0, y: 0, w: 0, h: 0 } },
  /** 等着规划算好才能接着做一件事（长、认路、已经长起来的聚落改地形）：算好之前不让动手 */
  loading: false,
  /** 规划正在后台线程里算（不挡操作：还没有规划的地块时先画地形，算好了补上规划的东西） */
  planning: false,
  /** 标出手动的东西（手动的路、地块，拆空的地方）：分清哪些是自己画的、哪些是生成的 */
  showHand: storeGet('growShowHand') === '1',
  /** 能撤销、重做几步 */
  undoCount: 0,
  redoCount: 0,
})

export function setTab(tab: GrowTab) {
  gs.tab = tab
  storeSet('growTab', tab)
}

// —— 撤销、重做：每次手动操作（一个手势算一次）、单步、一段播放之前记一份 ——
type Snap = { state: GrowState; driver: GrowDriver }
const undos = new UndoStack<Snap>(200)
const snap = (): Snap => ({ state: gs.state, driver: gs.driver })
const syncCounts = () => {
  gs.undoCount = undos.undoCount
  gs.redoCount = undos.redoCount
}
function checkpoint() {
  undos.push(snap())
  syncCounts()
}
function restore(dir: 'undo' | 'redo') {
  if (gs.loading || !(dir === 'undo' ? undos.undoCount : undos.redoCount)) return
  pause()
  cancelDraft()
  const u = dir === 'undo' ? undos.undo(snap())! : undos.redo(snap())!
  syncCounts()
  const other = !sameSetup(setupOf(u.state), setupOf(gs.state))
  commit(u.state, u.driver)
  if (other) {
    // 回到了另一局（新建之前的）：地址、视图跟着换
    syncRoute('grow')
    requestAnimationFrame(fitView)
  }
}
export const undo = () => restore('undo')
export const redo = () => restore('redo')

/** 换上新状态：重画、存档；选中的东西没了就取消选中 */
function commit(s: GrowState, d: GrowDriver = gs.driver) {
  gs.state = markRaw(s)
  gs.driver = d
  if (gs.sel && !selected()) gs.sel = null
  gs.hot = null
  draw()
  persist()
}

let saveTimer = 0
function persist() {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const s: Save = { v: GROW_VERSION, state: gs.state, driver: gs.driver }
    try {
      storeSet('growSave', JSON.stringify(s))
    } catch {
      // 本机存不下（空间满了）：这一局只留在内存里
    }
  }, 300)
}

// —— 新建地图 ——
/** 按 gs.setup 新建一张（当前这一张清空，可撤销） */
function restart() {
  if (gs.loading) return
  pause()
  cancelDraft()
  gs.sel = null
  gs.msg = ''
  gs.creating = false
  checkpoint()
  commit(newGame({ ...gs.setup }), newDriver())
  gs.target = defaultTarget()
  syncRoute('grow')
  requestAnimationFrame(fitView)
}
/** 打开「新建地图」卡片：参数从当前这一张取 */
export function openNewMap() {
  pause()
  cancelDraft()
  Object.assign(gs.setup, setupOf(gs.state))
  gs.creating = true
}
export const closeNewMap = () => (gs.creating = false)
/** 新建：空白平地（没有河、海、山、起伏，地形自己刷，拿起道路工具），或按种子随机的地形 */
export function createMap(blank: boolean) {
  if (blank) Object.assign(gs.setup, { river: false, coast: false, hills: false, flat: true })
  else gs.setup.flat = false
  restart()
  if (blank) setTool('road')
}
/** 随机种子的音节（村名式的） */
const SYL = ['aki', 'no', 'mura', 'ta', 'ka', 'hara', 'sato', 'ki', 'mi', 'yama', 'kawa', 'shi', 'ro', 'na', 'to', 'ma']
export const rollSeed = () => (gs.setup.seed = syllableSeed(SYL))

// —— 生成：一口气长到目标人口（记一步撤销）；回放：按步速一步步长，看它怎么长起来 ——
/** 目标人口的刻度：到这张地图的容量为止，最后一档是「长满」 */
const TARGET_STOPS = [50, 100, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 5000, 8000]
export const targetStops = () => {
  const cap = gs.state.plan!.horizon
  return [...TARGET_STOPS.filter((v) => v < cap), cap]
}
/** 眼下长到的人口（成长史走到的时刻） */
export const grownPop = () => gs.state.plan!.pop
/** 这张地图住满了 */
export const full = () => grownPop() >= gs.state.plan!.horizon
/** 默认的目标：比眼下多一档 */
const defaultTarget = () => targetStops().find((v) => v > grownPop()) ?? gs.state.plan!.horizon
gs.target = defaultTarget()
export function setTarget(v: number, go = false) {
  gs.target = v
  if (go && v > grownPop()) generate()
}
const noRoom = () => t('这张地图住满了：新建一张更大的地图接着长')
/** 走一步需求序列；住满了在舞台上说一声，停下 */
function stepOnce() {
  const r = advance(gs.state, gs.driver)
  if (r.failed && r.op.kind === 'place' && r.op.req.use !== 'field') {
    gs.msg = noRoom()
    gs.run = 'idle'
  }
  gs.state = markRaw(r.state)
  gs.driver = r.driver
}
/**
 * 要长了：手动的路变过的话先认下——规划把它们当骨架重算，规划的地块重新落一遍。那份规划先在后台线程里算好（免得卡住主线程），
 * 再记撤销点、认路、做 then：认路和接下来长的这一下算同一次操作（撤销回到认路之前）
 */
const whenPlanned = (then: () => void) =>
  withPlan(withGuides(gs.state), () => {
    checkpoint()
    gs.state = markRaw(adoptRoads(gs.state))
    then()
  })
function step() {
  pause()
  if (gs.loading) return
  whenPlanned(() => {
    stepOnce()
    commit(gs.state)
  })
}

/** 开始生成或回放（住满了只说一声） */
function begin(run: 'replay' | 'rush') {
  if (gs.loading) return
  if (full()) return void (gs.msg = noRoom())
  pause()
  whenPlanned(() => {
    cancelDraft()
    gs.msg = ''
    gs.run = run
    last = performance.now()
    due = 1
    raf = requestAnimationFrame(frame)
  })
}
/** 长到目标人口；正在长时再点一下停下。已经到了目标就往上挪一档再长 */
export function generate() {
  if (gs.run === 'rush') return pause()
  if (grownPop() >= gs.target) gs.target = targetStops().find((v) => v > grownPop()) ?? gs.target
  begin('rush')
}
export const toggle = () => (gs.run === 'replay' ? pause() : begin('replay'))
function pause() {
  if (gs.run === 'idle') return
  gs.run = 'idle'
  cancelAnimationFrame(raf)
  // 停下时画到这一刻（长的时候画面、图题是隔一会儿才换的），存档
  draw()
  persist()
}

let raf = 0
let last = 0
let due = 0
let drawAt = 0
/** 回放：一帧最多走几步（免得慢机器上越积越多）、画面隔多久换一次（毫秒） */
const FRAME_STEPS = 24
const DRAW_EVERY = 50
/** 生成：每帧最多算多久（毫秒，其余留给画面与指针）、画面隔多久换一次（边长边看见它长起来，又不至于把时间都花在画上） */
const RUSH_BUDGET = 30
const RUSH_DRAW_EVERY = 160
/** 回放速度的几档（步 / 秒） */
export const SPEEDS = [2, 8, 30, 120]
function frame(now: number) {
  if (gs.run === 'idle') return
  const rush = gs.run === 'rush'
  if (rush) {
    while (gs.run === 'rush' && grownPop() < gs.target && performance.now() - now < RUSH_BUDGET) stepOnce()
    if (grownPop() >= gs.target) gs.run = 'idle'
  } else {
    due += ((now - last) / 1000) * gs.speed
    last = now
    const n = Math.min(FRAME_STEPS, Math.floor(due))
    due -= n
    for (let i = 0; i < n && gs.run === 'replay'; i++) stepOnce()
  }
  // 步子照走，画面隔一会儿换一次：中间的几帧留给拖动、缩放；停下时照常画
  if (gs.run === 'idle' || now - drawAt >= (rush ? RUSH_DRAW_EVERY : DRAW_EVERY)) {
    drawAt = now
    commit(gs.state)
  }
  if (gs.run !== 'idle') raf = requestAnimationFrame(frame)
}
export function setSpeed(v: number) {
  gs.speed = v
  storeSet('growSpeed', String(v))
}

/**
 * 下一次生成（或回放）会让已经长出来的自动建筑重新布局几栋：手动的路变过、还没并进规划时，规划要把它们当骨架重算，
 * 自动的地块按原来的先后重新落一遍。没有要重排的时候是 0
 */
export const reflow = computed(() => {
  const s = gs.state
  if (withGuides(s) === s) return 0
  return s.lots.filter((l) => l.ref !== undefined && l.state !== 'vacant').length
})

// —— 选中的、指针下的东西 ——
function find(sel: GrowSel) {
  if (!sel) return null
  const s = gs.state
  if (sel.kind === 'plan') return sel
  if (sel.kind === 'lot') {
    const l = s.lots.find((x) => x.id === sel.id)
    return l && l.state !== 'vacant' ? { kind: 'lot' as const, lot: l } : null
  }
  const r = s.roads.find((x) => x.id === sel.id)
  return r ? { kind: 'road' as const, road: r } : null
}
export const selected = () => find(gs.sel)
export const hovered = () => find(gs.hot)
/** 这条路是规划里的（不能拆） */
export const planned = (roadId: number) => roadId >= WAY_ID
/**
 * 拆掉选中的：手动的地块、手动的路（连同临街的地块）拆掉；自动长出的房子、田拆掉以后那里空着，不再长回来（见 clearArea），
 * 住在那儿的户挪到别处
 */
export function removeSel() {
  if (gs.sel) remove(gs.sel, true)
}
/** 拆一样东西；mark 为 false 时不另记撤销点（按住拖着拆，一个手势只记一次） */
function remove(x: NonNullable<GrowSel>, mark: boolean): boolean {
  const s = gs.state
  let next: GrowState
  let msg = ''
  if (x.kind === 'plan') next = clearArea(s, x.poly)
  else if (x.kind === 'lot') {
    const lot = s.lots.find((l) => l.id === x.id)
    next = !lot ? s : lot.ref !== undefined ? clearArea(s, lot.poly) : removeLot(s, x.id)
  } else {
    if (planned(x.id)) {
      gs.msg = t('自动长出的路不能拆')
      return false
    }
    const n = s.lots.filter((l) => l.road === x.id && l.ref === undefined && l.state !== 'vacant').length
    const r = removeRoad(s, x.id, { lots: true })
    if ('error' in r) return false
    next = r.state
    if (n) msg = t('连同临街的 {n} 块地一起拆了（Ctrl+Z 撤销）', { n })
  }
  if (next === s) return false
  if (mark) checkpoint()
  gs.msg = msg
  commit(next)
  return true
}

// —— 工具 ——
export function setTool(tool: GrowTool) {
  gs.tool = tool
  cancelDraft()
  gs.hot = null
  gs.msg = ''
  if (tool !== 'look') pause()
}
export function toggleHand() {
  gs.showHand = !gs.showHand
  storeSet('growShowHand', gs.showHand ? '1' : '0')
}
export function setBrushR(r: number) {
  gs.brushR = Math.min(BRUSH_R.max, Math.max(BRUSH_R.min, Math.round(r)))
  storeSet('growBrushR', String(gs.brushR))
}
/** 当前工具的子选项：选第 i 个（数字键） */
export function pickOption(i: number) {
  if (gs.tool === 'road' && ROAD_KINDS[i]) gs.roadKind = ROAD_KINDS[i]
  else if (gs.tool === 'build' && BUILD_USES[i]) gs.buildUse = BUILD_USES[i]
  else if (gs.tool === 'terrain' && BRUSHES[i]) gs.brush = BRUSHES[i]
  refreshHover()
}
function cancelDraft() {
  gs.draft = []
  gs.free = null
  gs.snap = null
  gs.preview = null
  gs.ghost = null
  gs.tip = null
}

/** 屏幕上几像素以内算点到 */
const HIT_PX = 8
const pxToM = (px: number) => px / (gs.paper.S * gs.paper.k)
const near = (a: GrowP, b: GrowP, px = HIT_PX) => Math.hypot(a[0] - b[0], a[1] - b[1]) < pxToM(px)
const cmP = (p: GrowP): GrowP => [cm(p[0]), cm(p[1])]
function roadAt(p: GrowP, handOnly = false) {
  let best: { id: number; d: number } | null = null
  for (const r of gs.state.roads) {
    if (handOnly && planned(r.id)) continue
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const d = segDist(p, r.pts[i], r.pts[i + 1]).d - ROAD_WIDTH[r.kind] / 2
      if (d < pxToM(HIT_PX) && (!best || d < best.d)) best = { id: r.id, d }
    }
  }
  return best?.id
}
/** 指针下的东西：地块、路（先上后下） */
function hitAt(p: GrowP): GrowSel {
  const lot = lotAtPoint(gs.state, p)
  if (lot) return { kind: 'lot', id: lot.id }
  const road = roadAt(p)
  return road !== undefined ? { kind: 'road', id: road } : null
}
/**
 * 拆除工具指着的东西：地块、手动的路，再是画面上自动长出的房子、田（没有地块对着的也算：铺子、庙、空着的房子……）。
 * 自动长出的路拆不了，不去点它（免得挡住路边的房子）
 */
function eraseAt(p: GrowP): GrowSel {
  const lot = lotAtPoint(gs.state, p)
  if (lot) return { kind: 'lot', id: lot.id }
  const road = roadAt(p, true)
  if (road !== undefined) return { kind: 'road', id: road }
  const poly = plannedAt(p)
  return poly ? { kind: 'plan', poly } : null
}
/** 画面上这一点的自动长出的房子（先）、田；手动的那一层的不算（它们落在手动的地块里，已经先点到了） */
function plannedAt(p: GrowP): GrowP[] | null {
  const st = drawn?.st
  if (!st || !gs.state.plan) return null
  const hit = <X extends { poly: P[] }>(xs: X[]) => xs.find((x) => pointInPoly(p, x.poly))
  const x = hit(st.buildings) ?? hit(st.fields)
  return x ? x.poly.map(cmP) : null
}

/** 随手画的走线 → 路的中线：简化到 2 米，拐弯处抹圆 */
const roadLine = (pts: GrowP[]): GrowP[] => chaikin(simplify(pts, 2) as P[], 2) as GrowP[]

// —— 道路 ——
/** 吸附的范围（屏幕像素）：路的端头、路身；折成米以后不小于引擎自己的 8 米 */
const SNAP_END_PX = 14
const SNAP_BODY_PX = 10
const SNAP_M = 8
/**
 * 画路时把点吸到已有的路上：先找端头（首尾相接，连成一条线），再找路身上最近的一点（落点离端头很近时也算端头）。
 * 范围按屏幕像素算：缩得再小也接得上。没有可吸的返回 null
 */
function snapToRoad(p: GrowP): GrowP | null {
  const endR = Math.max(SNAP_M, pxToM(SNAP_END_PX))
  let best: GrowP | null = null
  let bd = endR
  for (const r of gs.state.roads)
    for (const e of [r.pts[0], r.pts[r.pts.length - 1]]) {
      const d = Math.hypot(p[0] - e[0], p[1] - e[1])
      if (d < bd) {
        bd = d
        best = [e[0], e[1]]
      }
    }
  if (best) return best
  bd = Math.max(SNAP_M, pxToM(SNAP_BODY_PX))
  for (const r of gs.state.roads)
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]
      const b = r.pts[i + 1]
      const { d, t } = segDist(p, a, b)
      if (d >= bd) continue
      bd = d
      const q: GrowP = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const end = [r.pts[0], r.pts[r.pts.length - 1]].find((e) => Math.hypot(q[0] - e[0], q[1] - e[1]) < SNAP_M)
      best = end ? [end[0], end[1]] : cmP(q)
    }
  return best
}
/** 吸附后的点，并记下吸到了哪儿（没吸到就是原来的点） */
function snapped(p: GrowP): GrowP {
  gs.snap = snapToRoad(p)
  return gs.snap ?? p
}
/** 试铺一条路（不改状态）：给出预览与指针旁的字 */
function previewRoad(pts: GrowP[]) {
  if (pts.length < 2) {
    gs.preview = null
    gs.tip = null
    return
  }
  const r = addRoad(gs.state, pts, gs.roadKind, { bridge: true })
  if ('error' in r) {
    gs.preview = { pts, ok: r.fault === 'short' }
    gs.tip = r.fault === 'short' ? null : { text: t(FAULT[r.fault]), bad: true }
  } else {
    gs.preview = { pts: r.road.pts, ok: true }
    gs.tip = { text: `${Math.round(polylineLength(r.road.pts))} m`, bad: false }
  }
}
function commitRoad(pts: GrowP[]) {
  cancelDraft()
  if (pts.length < 2) return
  const r = addRoad(gs.state, pts, gs.roadKind, { bridge: true })
  if ('error' in r) {
    gs.msg = r.fault === 'short' ? '' : t(FAULT[r.fault])
    return
  }
  checkpoint()
  gs.msg = ''
  // 路压到的规划的住户当场挪走
  commit(settle(r.state))
}
/** 画完一下一下点出来的路（回车、再点一下最后一个点） */
function finishDraft() {
  if (gs.tool === 'road' && gs.draft.length >= 2) commitRoad(gs.draft.slice())
}
// —— 建筑 ——
function probe(p: GrowP) {
  const pr = probeLot(gs.state, gs.buildUse, 1, p)
  gs.ghost = pr ? { poly: pr.poly, ok: !pr.fault } : null
  gs.tip = pr?.fault ? { text: t(FAULT[pr.fault]), bad: true } : pr ? null : { text: t(gs.state.roads.length ? FAULT.far : '还没有路：先用「道路」画一条'), bad: true }
  return pr
}
/**
 * 指针是不是对着这块地：沿街方向落在面宽以内，进深方向从路面到地块背后再多出一块地那么远。
 * 按住沿路拖动时指针不必正好压在地块里，离路远一点、压在路上都算
 */
function facing(p: GrowP, poly: GrowP[]) {
  const [p0, p1, , p3] = poly
  const w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  const d = Math.hypot(p3[0] - p0[0], p3[1] - p0[1])
  const a = ((p[0] - p0[0]) * (p1[0] - p0[0]) + (p[1] - p0[1]) * (p1[1] - p0[1])) / w
  const b = ((p[0] - p0[0]) * (p3[0] - p0[0]) + (p[1] - p0[1]) * (p3[1] - p0[1])) / d
  return a >= 0 && a <= w && b >= -6 && b <= d * 2
}
/** 在指针处摆一块；strict（按住拖动时）：指针对着那个位置才摆（免得停着不动也一块接一块地往两边摆） */
function build(p: GrowP, strict: boolean, g: Gesture) {
  const pr = probe(p)
  if (!pr || pr.fault) return
  if (strict && !facing(p, pr.poly)) return
  const r = placeAt(gs.state, { use: gs.buildUse }, p)
  if ('error' in r) return
  mark(g)
  gs.msg = ''
  commit(settle(r.state))
  probe(p)
}
// —— 地形 ——
/** 画完一笔：地形变了，规划要按新的地形重算——等改完地形的那个状态的规划算好（见 withPlan），再落这一笔 */
function commitStroke(pts: GrowP[]) {
  const base = gs.state
  const stroke: GrowStroke = { tool: gs.brush, r: gs.brushR, pts: simplify(pts.map(cmP), Math.max(1, gs.brushR / 12)) }
  const apply = () => {
    if (gs.state !== base) return
    const r = paintTerrain(base, stroke)
    checkpoint()
    gs.msg = r.flooded ? t('水漫掉了 {n} 块地（Ctrl+Z 撤销）', { n: r.flooded }) : ''
    commit(r.state)
  }
  // 还没有规划的地块（开局先刷地形）：用不着规划，当场落笔，一笔接一笔不用等。已经长起来的要按新的规划重新落：等它算好
  if (unsettled(base)) apply()
  else withPlan(withStroke(base, stroke), apply)
}

// —— 指针手势 ——
/** 一次按下到松开：moved 挪动过（算拖动）；marked 已经记过撤销点（一个手势只记一次） */
interface Gesture {
  x: number
  y: number
  moved: boolean
  marked: boolean
}
function mark(g: Gesture) {
  if (g.marked) return
  g.marked = true
  checkpoint()
}

function toolDown(p: GrowP, g: Gesture) {
  pause()
  if (gs.tool === 'build') build(p, false, g)
  else if (gs.tool === 'terrain') gs.free = [p]
  else if (gs.tool === 'erase') {
    const h = eraseAt(p)
    if (h && remove(h, !g.marked)) g.marked = true
  } else if (gs.tool === 'road' && !gs.draft.length) gs.free = [snapped(p)]
}
function toolDrag(p: GrowP, g: Gesture) {
  if (gs.tool === 'build') build(p, true, g)
  else if (gs.tool === 'erase') {
    // 按住拖着拆：只拆地块、自动长出的房子和田（路要点一下才拆，免得一拖带走一片）
    const h = eraseAt(p)
    if (h && h.kind !== 'road' && remove(h, !g.marked)) g.marked = true
  } else if (gs.tool === 'terrain' && gs.free) {
    if (!near(p, gs.free[gs.free.length - 1], 3)) gs.free = [...gs.free, p]
  } else if (gs.tool === 'road' && gs.free) {
    if (!near(p, gs.free[gs.free.length - 1], 4)) gs.free = [...gs.free, p]
    // 走线的末端吸到已有的路上（松手时接上去）
    const end = snapToRoad(p)
    gs.snap = end
    previewRoad(roadLine(end ? [...gs.free, end] : gs.free))
  }
}
function toolUp(p: GrowP, g: Gesture) {
  const free = gs.free
  gs.free = null
  if (gs.tool === 'terrain') {
    if (free) commitStroke(free)
    return
  }
  if (gs.tool !== 'road') return
  // 拖出来的一笔：路的走线
  if (g.moved && free && !gs.draft.length) return commitRoad(roadLine([...free, snapToRoad(p) ?? p]).map(cmP))
  // 点一下：加一个顶点；再点一下最后一个点就铺
  const d = gs.draft
  if (d.length >= 2 && near(p, d[d.length - 1])) return finishDraft()
  gs.draft = [...d, cmP(snapped(p))]
  toolHover(p)
}
/** 没按着的时候指针挪动：各工具的预览 */
function toolHover(p: GrowP) {
  if (gs.tool === 'look' || gs.tool === 'erase') {
    gs.hot = gs.tool === 'erase' ? eraseAt(p) : hitAt(p)
    return
  }
  gs.hot = null
  if (gs.tool === 'build') probe(p)
  else if (gs.tool === 'road') {
    const q = snapped(p)
    if (gs.draft.length) previewRoad([...gs.draft, q])
  }
}
/** 换了子选项之后按指针现在的位置重算预览 */
function refreshHover() {
  if (gs.cursor && !gs.free) toolHover(gs.cursor)
}

// —— 舞台 ——
let viewer: AtlasViewer | null = null
let host: HTMLElement | null = null
let shown: DisplayList | null = null
const view = { x: 0, y: 0, k: 1 }
const measurer = document.createElement('canvas').getContext('2d')!
const chromeMeasurer = document.createElement('canvas').getContext('2d')!
/** 图框内框离舞台边的距离：底边让出工具栏 */
const frameInset = (w: number, h: number) => {
  // 类型上它可以是固定的边距或函数（实际是函数）
  const base = typeof SETTLE_FRAME_INSET === 'function' ? SETTLE_FRAME_INSET(w, h) : SETTLE_FRAME_INSET
  return { ...base, t: base.t - 14, b: w < 720 ? 190 : 236 }
}

/** 这一局画成的聚落里的人口、住户（面板上的读数） */
export const picture = reactive({ population: 0, households: 0 })

/** 还没有规划的地块（没开始长）：这时规划只是画面上的树、田野，改地形、动手都用不着等它 */
const unsettled = (s: GrowState) => !s.lots.some((l) => l.ref !== undefined)
/** 手动改完把压到的规划地块理一遍；规划还没算好时不理（那时还没有规划的地块，见 draw） */
const settle = (s: GrowState) => (naturalReady(s) ? settleNatural(s) : s)

// 规划（一份成长史）在后台线程里算，一次一份。两种等法：
//   - 挡着的（withPlan）：要用规划才能接着做的事（长、认路、已经长起来的聚落改地形）——gs.loading 挡住各种操作，算好了做。
//   - 不挡的（draw）：还没有规划的地块时，画面先画地形和手动的东西，规划算好了补上——gs.planning 只是个提示。
/** 后台线程正在算一份 */
let computing = false
/** 挡着的那件事与它要的状态 */
let waiting: { s: GrowState; then: () => void } | null = null
/** 后台线程没算成的状态（线程起不来、出错）：用到规划时由引擎在主线程当场算 */
const failed = new WeakSet<GrowState>()
const ready = (s: GrowState) => naturalReady(s) || failed.has(s)
// 规划（一份成长史，大规模要几秒）放在后台线程推演：与聚落模块用同一个线程脚本，另起一个线程
//（聚落模块自己的线程里留着它最近的成长史给沙盘用，不去动它）。一次只等一份（见 withPlan），上一份没算完时直接失败、改在主线程算
const planner = historyClient('reject')

/** 后台线程空着就让它算眼下要的那一份：先顾挡着的那件事要的，没有就顾眼下这个状态的。算完再看一遍（期间状态可能又变了） */
function pump() {
  if (computing) return
  const s = waiting?.s ?? gs.state
  if (ready(s)) {
    gs.planning = false
    const w = waiting
    waiting = null
    if (w) {
      gs.loading = false
      w.then()
    }
    return
  }
  computing = true
  gs.planning = true
  const done = () => {
    computing = false
    pump()
    draw()
  }
  planner.computeHistory(naturalParams(s)).then(
    (hist) => {
      primeNatural(s, hist)
      done()
    },
    () => {
      failed.add(s)
      done()
    },
  )
}
/** 等 s 的规划算好再做 then：算好了当场做；没算好就等后台线程算（一到几秒，界面照常响应，期间 gs.loading 挡住各种操作）。已经在等一件时什么也不做 */
function withPlan(s: GrowState, then: () => void) {
  if (ready(s)) return then()
  if (gs.loading) return
  gs.loading = true
  pause()
  waiting = { s, then }
  pump()
}

function draw() {
  if (!host || app.module !== 'grow') return
  const s = gs.state
  if (ready(s)) return render(s)
  // 规划还没算好。还没有规划的地块时先画地形和手动的东西（一眨眼的事），规划在后台算，算好了再画一遍补上；
  // 已经长起来的不能只画一半：等规划算好再画（等的时候状态换了就按新的再来）
  if (unsettled(s)) {
    render(s, true)
    pump()
  } else withPlan(s, () => (gs.state === s ? render(s) : draw()))
}
/** bare：只画地形和手动的东西（规划还没算好） */
function render(s: GrowState, bare = false) {
  if (!host) return
  const st = toSettlement(s, { fieldKind: cultures.get(s.terrain.culture).traits.paddy ? 'paddy' : 'crop', bare })
  picture.population = st.stats.population
  picture.households = st.stats.households
  const key = `${gs.style}|${lang}`
  // 画面没变（没到规划的下一刻、手动的东西也没动：toSettlement 给的是同一个对象）：不用重画
  if (drawn && drawn.st === st && drawn.key === key) {
    // 图题里的人口播放时隔一会儿才换：停下了补上这一刻的
    if (gs.run === 'idle') viewer?.refreshChrome()
    return
  }
  // 注记（地名、片区名）用的字体到齐以后再画一遍
  wantFonts(st)
  const list = buildSettlementVector(st, gs.style, { labels: true, contours: true, lang }, measurer)
  // 底图切成格子：每一步只重画变了的那几格（见 AtlasViewer.patchList）
  if (!viewer) viewer = markRaw(new AtlasViewer(host, { cell: 256 }))
  const was = drawn
  const fresh = !shown || shown.width !== list.width || shown.height !== list.height
  const S = list.MW / st.width
  // 和上一张只差几处（成长的一步、摆了一块地）：底图只重画变了的那几块，不整张重画（整张要几百毫秒，期间拖动、缩放都卡住）
  const dirty = !fresh && was?.key === key ? changedBoxes(was.st, st) : null
  if (dirty)
    // 注记层只在注记、地标（带符号的）变了时重画
    viewer.patchList(list, dirty.map(([x0, y0, x1, y1]) => [list.M + x0 * S, list.M + y0 * S, list.M + x1 * S, list.M + y1 * S] as const), !sameItems(was!.st.labels, st.labels) || !sameItems(was!.st.landmarks, st.landmarks))
  else viewer.setList(list)
  shown = list
  drawn = { st, key }
  // 图廓（纸边、图框、图题、指北针、比例尺）固定在舞台上，缩放只动图框里的地图。它画的是眼下这一张（drawn）：
  // 风格、语言换了才重设，别的时候只要重画；图题里的人口播放时隔一会儿才换一次
  const now = performance.now()
  if (was?.key !== key) {
    const style = gs.style
    viewer.setChrome((w, h, box, k) => buildSettlementChrome(drawn!.st, style, { labels: true, contours: true, ornaments: true, lang }, chromeMeasurer, w, h, box, k, null), settleBackdrop(style), frameInset)
  } else if (gs.run === 'idle' || now - chromeAt > CHROME_EVERY) {
    chromeAt = now
    viewer.refreshChrome()
  }
  gs.paper.M = list.M
  gs.paper.S = S
  // 局部重画时视图、图框都没动
  if (fresh) fitView()
  else if (!dirty) applyView()
}
/** 上一次画的那张地图（下一次只重画和它不同的地方） */
let drawn: { st: Settlement; key: string } | null = null
/** 播放时图廓（图题里的人口）隔多久换一次（毫秒） */
const CHROME_EVERY = 500
let chromeAt = 0

/** 已经要过字体的（风格、语言、注记的条数）：注记多了可能要新的字 */
let fontKey = ''
function wantFonts(st: Settlement) {
  const key = `${gs.style}|${lang}|${st.labels.length}`
  if (key === fontKey) return
  fontKey = key
  void mapFontsReady()
    .then(() => ensureSettleFonts(st, gs.style, lang, 3000))
    .then((f) => (f.ready ? undefined : f.later))
    .then(() => key === fontKey && draw())
}

function applyView() {
  viewer?.setView(view.x, view.y, view.k)
  Object.assign(gs.paper, { x: view.x, y: view.y, k: view.k, frame: viewer?.frame() ?? gs.paper.frame })
}
/** 适配视图：整张图放进图框（田野、林子都是画面） */
export function fitView() {
  if (!shown || !viewer) return
  fitInto(view, viewer.inner(), shown)
  applyView()
}

/** 舞台坐标 → 米 */
function toMeters(clientX: number, clientY: number): GrowP {
  const r = host!.getBoundingClientRect()
  const P = gs.paper
  return [((clientX - r.left - P.x) / P.k - P.M) / P.S, ((clientY - r.top - P.y) / P.k - P.M) / P.S]
}

export function mountGrow(el: HTMLElement) {
  host = el
  bindPanZoom(el, view, applyView, { min: 0.1, max: 40, fit: fitView, tool: () => gs.tool !== 'look' })
  /** 主键的手势（工具用）；别的键按下的位置（右键不拖就松开 = 放下草稿 / 回到点选） */
  let g: (Gesture & { id: number }) | null = null
  let other: { x: number; y: number } | null = null
  const pointers = new Set<number>()
  const abort = () => {
    g = null
    gs.free = null
    if (!gs.draft.length) gs.preview = null
  }
  el.addEventListener('contextmenu', (e) => e.preventDefault())
  el.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId)
    // 第二根手指落下：这是双指缩放，放弃正在做的手势
    if (pointers.size > 1) return abort()
    if (e.button !== 0) {
      other = { x: e.clientX, y: e.clientY }
      return
    }
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, marked: false }
    const p = toMeters(e.clientX, e.clientY)
    gs.cursor = p
    // 规划还在算：先不让动手
    if (gs.tool !== 'look' && !gs.loading) toolDown(p, g)
  })
  el.addEventListener('pointermove', (e) => {
    const p = toMeters(e.clientX, e.clientY)
    gs.cursor = p
    if (gs.loading) return
    if (g && g.id === e.pointerId) {
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) >= 5) g.moved = true
      if (g.moved && gs.tool !== 'look') toolDrag(p, g)
    } else if (!e.buttons) toolHover(p)
  })
  el.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId)
    if (e.button !== 0) {
      if (other && Math.hypot(e.clientX - other.x, e.clientY - other.y) < 5) {
        if (gs.draft.length || gs.free) cancelDraft()
        else if (gs.tool !== 'look') setTool('look')
      }
      other = null
      return
    }
    if (!g || g.id !== e.pointerId) return
    const done = g
    g = null
    if (gs.loading) return abort()
    const p = toMeters(e.clientX, e.clientY)
    if (gs.tool === 'look') {
      if (!done.moved) gs.sel = hitAt(p)
    } else toolUp(p, done)
  })
  el.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId)
    abort()
  })
  el.addEventListener('pointerleave', () => {
    if (g) return
    gs.cursor = null
    gs.hot = null
    gs.snap = null
    gs.ghost = null
    gs.tip = null
    if (!gs.draft.length) gs.preview = null
  })
  window.addEventListener('resize', () => app.module === 'grow' && fitView())
  start()
}

function start() {
  if (app.module !== 'grow') return pause()
  if (!host) return
  draw()
  requestAnimationFrame(fitView)
}
watch(() => app.module, start)

export function setStyle(id: string) {
  gs.style = id
  storeSet('growStyle', id)
  syncRoute('grow')
  draw()
}

// —— 导出 ——
const fileName = (ext: string) => `village-${gs.state.seed}-${gs.driver.tick}.${ext}`
export function exportPng() {
  if (!viewer) return
  viewer.rasterize(2).toBlob((b) => b && download(b, fileName('png')))
}
export function exportSvg() {
  if (shown) download(new Blob([shown.toSVG()], { type: 'image/svg+xml' }), fileName('svg'))
}
export function exportState() {
  download(new Blob([JSON.stringify(gs.state)], { type: 'application/json' }), fileName('json'))
}

// —— 键盘 ——
/** 工具的快捷键（工具栏的按钮上标着） */
export const TOOL_KEYS: Record<GrowTool, string> = { look: 'V', road: 'R', build: 'B', terrain: 'T', erase: 'X' }
window.addEventListener('keydown', (e) => {
  if (app.module !== 'grow' || isTypingTarget(e)) return
  const key = e.key.toLowerCase()
  // 「新建地图」卡片开着：只认 Esc（关掉它）
  if (gs.creating) {
    if (key === 'escape') closeNewMap()
    return
  }
  if (e.ctrlKey || e.metaKey) {
    if (key === 'z' || key === 'y') {
      e.preventDefault()
      if (key === 'y' || e.shiftKey) redo()
      else undo()
    }
    return
  }
  if (e.altKey) return
  const tool = (Object.keys(TOOL_KEYS) as GrowTool[]).find((k) => TOOL_KEYS[k].toLowerCase() === key)
  if (tool) setTool(tool)
  else if (key >= '1' && key <= '9') pickOption(Number(key) - 1)
  else if (key === '[' || key === ']') setBrushR(gs.brushR + (key === ']' ? 1 : -1) * BRUSH_R.step * 2)
  else if (key === 'g') generate()
  else if (key === 'h') toggleHand()
  else if (key === ' ') {
    e.preventDefault()
    toggle()
  } else if (key === 'n') step()
  else if (key === 'enter') finishDraft()
  else if (key === 'escape') {
    if (gs.draft.length || gs.free) cancelDraft()
    else if (gs.tool !== 'look') setTool('look')
    else gs.sel = null
  } else if (key === 'backspace' && gs.draft.length) {
    gs.draft = gs.draft.slice(0, -1)
    if (!gs.draft.length) cancelDraft()
    else refreshHover()
  } else if (key === 'delete' || key === 'backspace') removeSel()
})

// —— 地址：#/grow?seed=... ——
registerRoute('grow', {
  query: () => encode(setupOf(gs.state), gs.style),
  apply(q) {
    if (![...q.keys()].length) return
    const d = decode(q, gs.notices)
    if (d.style) gs.style = d.style
    if (sameSetup(d.setup, setupOf(gs.state))) return draw()
    // 原地改（面板拿着 gs.setup 这个对象）
    Object.assign(gs.setup, d.setup)
    restart()
  },
})

/** 地块的说明行 */
export function lotRows(l: GrowLot): [string, string][] {
  return [
    ['用途', t(USE_NAME[l.use] ?? l.use)],
    ['来历', t(l.ref === undefined ? '手动' : '自动')],
    ['主人', l.owner ?? '—'],
    ['面积', `${l.area * UNIT_W * UNIT_D} m²`],
  ]
}

// 一进来就是这个模块：不等舞台挂上，先让后台线程把这一局的规划算起来
if (app.module === 'grow') pump()
