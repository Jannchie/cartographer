import { computed, markRaw, reactive, watch } from 'vue'
import type { DisplayList } from '../../render/atlas/svg/displayList'
import { AtlasViewer } from '../../render/atlas/svg/viewer'
import { cultures } from '../../settlement/culture'
import { chaikin, pointInPoly, segDist, type P } from '../../settlement/geom'
import {
  addRoad, blankState, GROW_VERSION, lotAtPoint, lotCenter, paintTerrain, place, placeAt, probeLot, removeLot, removeRoad, seedState, setState, unzone, zone, zoneAtPoint,
  type GrowBrush, type GrowFault, type GrowLot, type GrowP, type GrowParams, type GrowRoadKind, type GrowState, type GrowZone,
} from '../../settlement/grow'
import { ROAD_WIDTH } from '../../settlement/grow/core'
import { advance, finishAll, newDriver, placeSalt, runOp, type GrowDriver, type GrowOp } from '../../settlement/grow/demands'
import { toSettlement } from '../../settlement/grow/draw'
import { buildSettlementVector } from '../../settlement/render'
import { settleThemes } from '../../settlement/themes'
import { lang } from '../../i18n'
import { app, download, initialQuery, registerRoute, storeGet, storeSet, stored, syncRoute, type Notice } from '../app'
import { t } from '../i18n'
import { isTypingTarget } from '../keys'
import { bindPanZoom, fitInto } from '../panZoom'
import { syllableSeed } from '../seed'
import './strings'

/**
 * 村落生长模块：生长引擎（settlement/grow）上的自由编辑器。
 * 可以从生成的村子起，也可以从什么都没有的空地起；舞台底部的工具栏像游戏的建造栏：
 *   道路（按住拖动随手画，或一下一下点出折线；过河自动架桥）、建筑（点一下摆一块，按住沿路拖摆一排）、
 *   分区（拖一个框，或点出多边形）、地形（抬高、压低、平整、挖水、填陆的笔刷）、拆除（点一下，或按住拖着拆地块）。
 * 也可以交给需求序列自己长（播放、单步）。每一步都能撤销、重做，进度存在本机；地址里只有开局的参数（#/grow?seed=...）。
 * 选了工具时左键归工具，右键或中键拖动平移；点选工具下左键拖动平移。
 */

/** 开局的参数：地形参数（方向总是随种子）、画幅边长（米）、起始（生成的村子 / 空地） */
export interface GrowSetup {
  seed: string
  culture: string
  river: boolean
  coast: boolean
  hills: boolean
  relief: number
  size: number
  start: 'village' | 'blank'
}
const DEFAULT_SETUP: GrowSetup = { seed: 'aki', culture: 'wa', river: true, coast: false, hills: false, relief: 0.3, size: 1600, start: 'village' }
export const SIZES = [800, 1600, 2400]
const paramsOf = (p: GrowSetup): GrowParams => ({
  seed: p.seed,
  culture: p.culture,
  river: p.river,
  coast: p.coast,
  hills: p.hills,
  relief: p.relief,
  coastDir: null,
  riverDir: null,
  hillDir: null,
  size: [p.size, p.size],
})
const newGame = (p: GrowSetup) => (p.start === 'blank' ? blankState(paramsOf(p)) : seedState(paramsOf(p)))
const sameSetup = (a: GrowSetup, b: GrowSetup) => JSON.stringify(a) === JSON.stringify(b)

// —— 地址 ——
function encode(p: GrowSetup, style: string) {
  const q = new URLSearchParams()
  q.set('seed', p.seed)
  if (p.culture !== DEFAULT_SETUP.culture) q.set('culture', p.culture)
  for (const k of ['river', 'coast', 'hills'] as const) if (p[k] !== DEFAULT_SETUP[k]) q.set(k, p[k] ? '1' : '0')
  if (p.relief !== DEFAULT_SETUP.relief) q.set('relief', String(p.relief))
  if (p.size !== DEFAULT_SETUP.size) q.set('size', String(p.size))
  if (p.start !== DEFAULT_SETUP.start) q.set('start', p.start)
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
  for (const k of ['river', 'coast', 'hills'] as const) if (q.has(k)) p[k] = q.get(k) === '1'
  const r = Number(q.get('relief'))
  if (q.has('relief') && Number.isFinite(r)) p.relief = Math.min(1, Math.max(0, r))
  if (SIZES.includes(Number(q.get('size')))) p.size = Number(q.get('size'))
  if (q.get('start') === 'blank') p.start = 'blank'
  const st = q.get('style') ?? undefined
  if (st && !settleThemes.has(st)) notices.push({ source: 'link', what: settleThemes.label, id: st })
  return { setup: p, style: st && settleThemes.has(st) ? st : undefined }
}

// —— 存档：本机记着最近一局（开局参数、生长状态、驱动） ——
interface Save {
  v: number
  setup: GrowSetup
  state: GrowState
  driver: GrowDriver
}
function loadSave(): Save | null {
  try {
    const s = JSON.parse(storeGet('growSave') ?? 'null') as Save | null
    if (!s || s.v !== GROW_VERSION || s.state?.v !== GROW_VERSION || !cultures.has(s.state.terrain.culture)) return null
    // 旧存档没有记开局参数：从状态推出来
    const g = s.state
    s.setup ??= { seed: g.seed, culture: g.terrain.culture, river: g.terrain.river, coast: g.terrain.coast, hills: g.terrain.hills, relief: g.terrain.relief, size: g.size[0], start: 'village' }
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
const first: Save = (() => {
  if (saved && (!fromUrl || sameSetup(fromUrl.setup, saved.setup))) return saved
  const setup = fromUrl?.setup ?? DEFAULT_SETUP
  return { v: GROW_VERSION, setup, state: newGame(setup), driver: newDriver() }
})()

export type GrowTab = 'grow' | 'land' | 'stats'
/** 点选、道路、建筑、分区、地形、拆除 */
export type GrowTool = 'look' | 'road' | 'build' | 'zone' | 'terrain' | 'erase'
export type GrowSel = { kind: 'lot' | 'road' | 'zone'; id: number } | null

/** 用途的名称、颜色（面板、舞台共用） */
export const USE_NAME: Record<string, string> = { center: '村心', home: '住处', shop: '铺子', public: '公所', yard: '料场', field: '田' }
export const USE_COLOR: Record<string, string> = { center: '#b0413e', home: '#c9822b', shop: '#8a4fa8', public: '#2f6fae', yard: '#7a6a4f', field: '#5f8f3a' }
export const ROAD_NAME: Record<GrowRoadKind, string> = { highway: '大路', street: '街', lane: '巷' }
export const BRUSH_NAME: Record<GrowBrush, string> = { raise: '抬高', lower: '压低', flat: '平整', water: '挖水', land: '填陆' }
export const BRUSH_COLOR: Record<GrowBrush, string> = { raise: '#8a6a3c', lower: '#6f6a60', flat: '#8a8072', water: '#4f8fa8', land: '#b79a5c' }
/** 各工具的子选项（工具栏上面的一行；数字键 1 ~ 9 选） */
export const ROAD_KINDS: GrowRoadKind[] = ['highway', 'street', 'lane']
export const BUILD_USES = ['home', 'field', 'shop', 'yard', 'public', 'center']
export const ZONE_USES = ['home', 'field', 'shop', 'yard', 'public']
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
  tab: (['grow', 'land', 'stats'].includes(storeGet('growTab') ?? '') ? storeGet('growTab') : 'grow') as GrowTab,
  /** 面板上的开局参数（与 applied 不同即有待重开的改动） */
  setup: { ...first.setup } as GrowSetup,
  /** 当前这一局开局时的参数 */
  applied: { ...first.setup } as GrowSetup,
  style: fromUrl?.style ?? stored('growStyle', settleThemes, startNotices),
  /** 当前这一局（markRaw：状态是不可变的大对象，整个替换） */
  state: markRaw(first.state) as GrowState,
  driver: first.driver as GrowDriver,
  playing: false,
  /** 播放速度（步 / 秒） */
  speed: Number(storeGet('growSpeed')) || 8,
  tool: 'look' as GrowTool,
  roadKind: 'street' as GrowRoadKind,
  buildUse: 'home',
  zoneUse: 'home',
  /** 划完分区马上沿路盖满（关掉就只是规划：留给自动生长） */
  zoneFill: storeGet('growZoneFill') !== '0',
  brush: 'raise' as GrowBrush,
  /** 笔刷半径（米） */
  brushR: Number(storeGet('growBrushR')) || 40,
  /** 一下一下点出来的路或分区的顶点（米） */
  draft: [] as GrowP[],
  /** 按住拖动中的一笔：路的走线、分区框的两个角、地形笔画（米） */
  free: null as GrowP[] | null,
  /** 指针所在处（米） */
  cursor: null as GrowP | null,
  /** 路、分区的预览（接到已有的路上之后的样子）：ok 为 false 时画成不行的颜色 */
  preview: null as { pts: GrowP[]; ok: boolean; closed: boolean } | null,
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
  /** 地图在舞台上的位置（叠加层跟着它）：米 → 页面 = M + 米·S；页面 → 舞台 = x + 页面·k */
  paper: { x: 0, y: 0, k: 1, M: 0, S: 1 },
  /** 能撤销、重做几步 */
  undoCount: 0,
  redoCount: 0,
})

export const dirty = computed(() => !sameSetup(gs.setup, gs.applied))

export function setTab(tab: GrowTab) {
  gs.tab = tab
  storeSet('growTab', tab)
}

// —— 撤销、重做：每次手动操作（一个手势算一次）、单步、一段播放之前记一份 ——
type Snap = { state: GrowState; driver: GrowDriver; applied: GrowSetup }
const undoStack: Snap[] = []
const redoStack: Snap[] = []
const UNDO_MAX = 200
const snap = (): Snap => ({ state: gs.state, driver: gs.driver, applied: { ...gs.applied } })
function checkpoint() {
  undoStack.push(snap())
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  redoStack.length = 0
  gs.undoCount = undoStack.length
  gs.redoCount = 0
}
function restore(from: Snap[], to: Snap[]) {
  const u = from.pop()
  if (!u) return
  pause()
  cancelDraft()
  to.push(snap())
  gs.undoCount = undoStack.length
  gs.redoCount = redoStack.length
  const resized = u.state.size[0] !== gs.state.size[0]
  gs.applied = u.applied
  commit(u.state, u.driver)
  syncRoute('grow')
  if (resized) requestAnimationFrame(fitView)
}
export const undo = () => restore(undoStack, redoStack)
export const redo = () => restore(redoStack, undoStack)

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
    const s: Save = { v: GROW_VERSION, setup: gs.applied, state: gs.state, driver: gs.driver }
    try {
      storeSet('growSave', JSON.stringify(s))
    } catch {
      // 本机存不下（空间满了）：这一局只留在内存里
    }
  }, 300)
}

// —— 开局、种子 ——
export function restart() {
  pause()
  checkpoint()
  cancelDraft()
  gs.sel = null
  gs.msg = ''
  gs.applied = { ...gs.setup }
  commit(newGame(gs.applied), newDriver())
  syncRoute('grow')
  requestAnimationFrame(fitView)
}
/** 随机种子的音节（村名式的） */
const SYL = ['aki', 'no', 'mura', 'ta', 'ka', 'hara', 'sato', 'ki', 'mi', 'yama', 'kawa', 'shi', 'ro', 'na', 'to', 'ma']
export function randomSeed() {
  gs.setup.seed = syllableSeed(SYL)
  restart()
}
/** 一张白纸：没有河、海、山的平地，什么都没有，直接拿起道路工具 */
export function blankSlate() {
  Object.assign(gs.setup, { river: false, coast: false, hills: false, relief: 0, start: 'blank' })
  restart()
  setTool('road')
}

// —— 自动生长 ——
const noRoom = (use: string) => (gs.state.roads.length ? t('摆不下：{what}', { what: t(USE_NAME[use] ?? use) }) : t('还没有路：先用「道路」画一条'))
/** 走一步需求序列；摆不下时在舞台上说一声 */
function stepOnce() {
  const r = advance(gs.state, gs.driver)
  if (r.failed && r.op.kind === 'place') gs.msg = noRoom(r.op.req.use)
  gs.state = markRaw(r.state)
  gs.driver = r.driver
}
export function step() {
  pause()
  checkpoint()
  stepOnce()
  commit(gs.state)
}

let raf = 0
let last = 0
let due = 0
export function play() {
  if (gs.playing) return
  checkpoint()
  cancelDraft()
  gs.playing = true
  gs.msg = ''
  last = performance.now()
  due = 1
  raf = requestAnimationFrame(frame)
}
export function pause() {
  gs.playing = false
  cancelAnimationFrame(raf)
}
export const toggle = () => (gs.playing ? pause() : play())
function frame(now: number) {
  if (!gs.playing) return
  due += ((now - last) / 1000) * gs.speed
  last = now
  // 一帧最多走 8 步，免得慢机器上越积越多
  const n = Math.min(8, Math.floor(due))
  due -= n
  if (n > 0) {
    for (let i = 0; i < n; i++) stepOnce()
    commit(gs.state)
  }
  raf = requestAnimationFrame(frame)
}
export function setSpeed(v: number) {
  gs.speed = v
  storeSet('growSpeed', String(v))
}

/** 在建的全部盖好 */
export function finishBuilding() {
  if (!gs.driver.pending.length) return
  checkpoint()
  const r = finishAll(gs.state, gs.driver)
  commit(r.state, r.driver)
}

/** 交给引擎挑地方摆一种需求（不走需求序列；和序列里的同样先在建、过几步盖好） */
export const MANUAL: { use: string; count: number }[] = [
  { use: 'home', count: 1 },
  { use: 'field', count: 4 },
  { use: 'shop', count: 1 },
  { use: 'yard', count: 2 },
  { use: 'public', count: 1 },
]
export function addDemand(use: string) {
  const m = MANUAL.find((x) => x.use === use)
  if (!m) return
  pause()
  checkpoint()
  const op: GrowOp = { kind: 'place', req: { use, area: 1, owner: `hand${gs.state.nextId}`, ...(m.count > 1 ? { count: m.count } : {}) } }
  const r = runOp(gs.state, gs.driver, op)
  gs.msg = r.failed ? noRoom(use) : ''
  commit(r.state, r.driver)
  if (r.lots.length) gs.sel = { kind: 'lot', id: r.lots[0].id }
}

// —— 选中的、指针下的东西 ——
function find(sel: GrowSel) {
  if (!sel) return null
  const s = gs.state
  if (sel.kind === 'lot') {
    const l = s.lots.find((x) => x.id === sel.id)
    return l && l.state !== 'vacant' ? { kind: 'lot' as const, lot: l } : null
  }
  if (sel.kind === 'road') {
    const r = s.roads.find((x) => x.id === sel.id)
    return r ? { kind: 'road' as const, road: r } : null
  }
  const z = s.zones.find((x) => x.id === sel.id)
  return z ? { kind: 'zone' as const, zone: z } : null
}
export const selected = () => find(gs.sel)
export const hovered = () => find(gs.hot)
export function buildSel() {
  const x = selected()
  if (x?.kind !== 'lot' || x.lot.state !== 'building') return
  checkpoint()
  const d = { ...gs.driver, pending: gs.driver.pending.filter((p) => p.id !== x.lot.id) }
  commit(setState(gs.state, x.lot.id, 'built'), d)
}
/** 拆掉选中的地块、路（连同临街的地块）、分区 */
export function removeSel() {
  if (gs.sel) remove(gs.sel, true)
}
/** 拆一样东西；mark 为 false 时不另记撤销点（按住拖着拆，一个手势只记一次） */
function remove(x: NonNullable<GrowSel>, mark: boolean): boolean {
  const s = gs.state
  let next: GrowState
  let msg = ''
  if (x.kind === 'lot') next = removeLot(s, x.id)
  else if (x.kind === 'zone') next = unzone(s, x.id)
  else {
    const n = s.lots.filter((l) => l.road === x.id && l.state !== 'vacant').length
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
export function setBrushR(r: number) {
  gs.brushR = Math.min(BRUSH_R.max, Math.max(BRUSH_R.min, Math.round(r)))
  storeSet('growBrushR', String(gs.brushR))
}
/** 当前工具的子选项：选第 i 个（数字键） */
export function pickOption(i: number) {
  if (gs.tool === 'road' && ROAD_KINDS[i]) gs.roadKind = ROAD_KINDS[i]
  else if (gs.tool === 'build' && BUILD_USES[i]) gs.buildUse = BUILD_USES[i]
  else if (gs.tool === 'zone' && ZONE_USES[i]) gs.zoneUse = ZONE_USES[i]
  else if (gs.tool === 'terrain' && BRUSHES[i]) gs.brush = BRUSHES[i]
  refreshHover()
}
export function cancelDraft() {
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
const cm = (p: GrowP): GrowP => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]
function roadAt(p: GrowP) {
  let best: { id: number; d: number } | null = null
  for (const r of gs.state.roads) {
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const d = segDist(p, r.pts[i], r.pts[i + 1]).d - ROAD_WIDTH[r.kind] / 2
      if (d < pxToM(HIT_PX) && (!best || d < best.d)) best = { id: r.id, d }
    }
  }
  return best?.id
}
/** 指针下的东西：地块、路、分区（先上后下） */
function hitAt(p: GrowP): GrowSel {
  const lot = lotAtPoint(gs.state, p)
  if (lot) return { kind: 'lot', id: lot.id }
  const road = roadAt(p)
  if (road !== undefined) return { kind: 'road', id: road }
  const z = zoneAtPoint(gs.state, p)
  return z ? { kind: 'zone', id: z.id } : null
}

/** 道格拉斯–普克简化（保留首尾） */
function simplify(pts: GrowP[], tol: number): GrowP[] {
  if (pts.length < 3) return pts
  let far = -1
  let at = 0
  for (let k = 1; k + 1 < pts.length; k++) {
    const d = segDist(pts[k], pts[0], pts[pts.length - 1]).d
    if (d > far) {
      far = d
      at = k
    }
  }
  if (far <= tol) return [pts[0], pts[pts.length - 1]]
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)]
}
const lengthOf = (pts: GrowP[]) => pts.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0)
/** 随手画的走线 → 路的中线：简化到 2 米，拐弯处抹圆 */
const roadLine = (pts: GrowP[]): GrowP[] => {
  const s = simplify(pts, 2)
  return s.length > 2 ? (chaikin(s as P[], 2) as GrowP[]) : s
}
const rectOf = (a: GrowP, b: GrowP): GrowP[] => [a, [b[0], a[1]], b, [a[0], b[1]]]

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
      best = end ? [end[0], end[1]] : cm(q)
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
    gs.preview = { pts, ok: r.fault === 'short', closed: false }
    gs.tip = r.fault === 'short' ? null : { text: t(FAULT[r.fault]), bad: true }
  } else {
    gs.preview = { pts: r.road.pts, ok: true, closed: false }
    gs.tip = { text: `${Math.round(lengthOf(r.road.pts))} m`, bad: false }
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
  commit(r.state)
}
// —— 分区 ——
/** 一片分区一次最多盖多少块 */
const FILL_MAX = 200
/** 分区往外放多少米再盖：随手划的框差一点没盖住临街那排地块的中心时，那一排也算在分区里（半块地多一点） */
const FILL_MARGIN = 12
/** 多边形每条边往外推 d 米（顶点沿相邻两边外法线的合方向挪；很尖的角不无限伸出去） */
function inflate(poly: GrowP[], d: number): GrowP[] {
  const n = poly.length
  let area = 0
  for (let i = 0; i < n; i++) area += poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]
  const sign = area >= 0 ? 1 : -1
  const normal = (a: GrowP, b: GrowP): GrowP => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [((b[1] - a[1]) / L) * sign, (-(b[0] - a[0]) / L) * sign]
  }
  return poly.map((q, i) => {
    const n1 = normal(poly[(i + n - 1) % n], q)
    const n2 = normal(q, poly[(i + 1) % n])
    const k = d / Math.max(0.35, 1 + n1[0] * n2[0] + n1[1] * n2[1])
    return [q[0] + (n1[0] + n2[0]) * k, q[1] + (n1[1] + n2[1]) * k]
  })
}
/**
 * 把一片分区盖满：一块一块地交给引擎摆这种用途（引擎优先摆进相符的分区，路不够时自己往里延），
 * 摆到分区外面去了、或者摆不下了为止。盖的时候分区按往外放 FILL_MARGIN 米算，盖完还是原来的范围。返回新的状态和盖了几块
 */
function fillZone(s: GrowState, z: GrowZone): { state: GrowState; n: number } {
  const wide: GrowZone = { ...z, poly: inflate(z.poly, FILL_MARGIN) }
  const swap = (st: GrowState, to: GrowZone): GrowState => ({ ...st, zones: st.zones.map((q) => (q.id === z.id ? to : q)) })
  let cur = swap(s, wide)
  let n = 0
  for (; n < FILL_MAX; n++) {
    const got = place(cur, { use: z.use, area: 1 }, placeSalt(cur))
    if (!got || !pointInPoly(lotCenter(got.lots[0]), wide.poly)) break
    cur = got.state
  }
  return { state: swap(cur, z), n }
}
const fillMsg = (n: number) => (n ? '' : t(gs.state.roads.length ? '这片分区里摆不下：把路通到分区边上再试' : '还没有路：先用「道路」画一条'))
function commitZone(poly: GrowP[]) {
  cancelDraft()
  if (poly.length < 3) return
  const r = zone(gs.state, poly, gs.zoneUse)
  if ('error' in r) {
    gs.msg = t(FAULT.edge)
    return
  }
  checkpoint()
  const filled = gs.zoneFill ? fillZone(r.state, r.zone) : null
  gs.msg = filled ? fillMsg(filled.n) : ''
  commit(filled?.state ?? r.state)
}
/** 把选中的分区盖满 */
export function fillSel() {
  const x = selected()
  if (x?.kind !== 'zone') return
  const r = fillZone(gs.state, x.zone)
  gs.msg = fillMsg(r.n)
  if (!r.n) return
  checkpoint()
  commit(r.state)
}
export function setZoneFill(on: boolean) {
  gs.zoneFill = on
  storeSet('growZoneFill', on ? '1' : '0')
}
/** 画完一下一下点出来的路或分区（回车、再点一下最后一个点） */
export function finishDraft() {
  if (gs.tool === 'road' && gs.draft.length >= 2) commitRoad(gs.draft.slice())
  else if (gs.tool === 'zone' && gs.draft.length >= 3) commitZone(gs.draft.slice())
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
  commit(r.state)
  probe(p)
}
// —— 地形 ——
function commitStroke(pts: GrowP[], g: Gesture) {
  const r = paintTerrain(gs.state, { tool: gs.brush, r: gs.brushR, pts: simplify(pts.map(cm), Math.max(1, gs.brushR / 12)) })
  mark(g)
  gs.msg = r.flooded ? t('水漫掉了 {n} 块地（Ctrl+Z 撤销）', { n: r.flooded }) : ''
  commit(r.state)
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
    const h = hitAt(p)
    if (h && remove(h, !g.marked)) g.marked = true
  } else if (!gs.draft.length) gs.free = [gs.tool === 'road' ? snapped(p) : p]
}
function toolDrag(p: GrowP, g: Gesture) {
  if (gs.tool === 'build') build(p, true, g)
  else if (gs.tool === 'erase') {
    // 按住拖着拆：只拆地块（路和分区要点一下才拆，免得一拖带走一片）
    const lot = lotAtPoint(gs.state, p)
    if (lot && remove({ kind: 'lot', id: lot.id }, !g.marked)) g.marked = true
  } else if (gs.tool === 'terrain' && gs.free) {
    if (!near(p, gs.free[gs.free.length - 1], 3)) gs.free = [...gs.free, p]
  } else if (gs.tool === 'road' && gs.free) {
    if (!near(p, gs.free[gs.free.length - 1], 4)) gs.free = [...gs.free, p]
    // 走线的末端吸到已有的路上（松手时接上去）
    const end = snapToRoad(p)
    gs.snap = end
    previewRoad(roadLine(end ? [...gs.free, end] : gs.free))
  } else if (gs.tool === 'zone' && gs.free) {
    gs.free = [gs.free[0], p]
    gs.preview = { pts: rectOf(gs.free[0], p), ok: true, closed: true }
  }
}
function toolUp(p: GrowP, g: Gesture) {
  const free = gs.free
  gs.free = null
  if (gs.tool === 'terrain') {
    if (free) commitStroke(free, g)
    return
  }
  if (gs.tool !== 'road' && gs.tool !== 'zone') return
  // 拖出来的一笔：路的走线、分区的框
  if (g.moved && free && !gs.draft.length) {
    if (gs.tool === 'road') commitRoad(roadLine([...free, snapToRoad(p) ?? p]).map(cm))
    else if (Math.abs(p[0] - free[0][0]) > 8 && Math.abs(p[1] - free[0][1]) > 8) commitZone(rectOf(cm(free[0]), cm(p)))
    else cancelDraft()
    return
  }
  // 点一下：加一个顶点；路再点一下最后一个点就铺，分区点回第一个点就划
  const d = gs.draft
  if (gs.tool === 'road' && d.length >= 2 && near(p, d[d.length - 1])) return finishDraft()
  if (gs.tool === 'zone' && d.length >= 3 && near(p, d[0])) return finishDraft()
  gs.draft = [...d, cm(gs.tool === 'road' ? snapped(p) : p)]
  toolHover(p)
}
/** 没按着的时候指针挪动：各工具的预览 */
function toolHover(p: GrowP) {
  if (gs.tool === 'look' || gs.tool === 'erase') {
    gs.hot = hitAt(p)
    return
  }
  gs.hot = null
  if (gs.tool === 'build') probe(p)
  else if (gs.tool === 'road') {
    const q = snapped(p)
    if (gs.draft.length) previewRoad([...gs.draft, q])
  } else if (gs.tool === 'zone') {
    gs.preview = gs.draft.length ? { pts: [...gs.draft, p], ok: true, closed: true } : null
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

/** 这一局画成的聚落里的人口、住户（面板上的读数） */
export const picture = reactive({ population: 0, households: 0 })

function draw() {
  if (!host || app.module !== 'grow') return
  const s = gs.state
  const st = toSettlement(s, { fieldKind: cultures.get(s.terrain.culture).traits.paddy ? 'paddy' : 'crop' })
  picture.population = st.stats.population
  picture.households = st.stats.households
  const list = buildSettlementVector(st, gs.style, { labels: false, contours: true, lang }, measurer)
  if (!viewer) viewer = markRaw(new AtlasViewer(host))
  const fresh = !shown
  shown = list
  viewer.setList(list)
  gs.paper.M = list.M
  gs.paper.S = list.MW / st.width
  if (fresh) fitView()
  else applyView()
}

function applyView() {
  viewer?.setView(view.x, view.y, view.k)
  Object.assign(gs.paper, { x: view.x, y: view.y, k: view.k })
}
/** 适配视图：对准村子（地块的范围外扩 150 米，至少 500 米见方，不超过画幅）；没有地块时看整张图 */
export function fitView() {
  if (!shown || !viewer) return
  fitInto(view, viewer.inner(), shown)
  const lots = gs.state.lots.filter((l) => l.state !== 'vacant')
  if (lots.length) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const l of lots)
      for (const [x, y] of l.poly) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    const [W, H] = gs.state.size
    const half = Math.min(W / 2, H / 2, Math.max(250, (x1 - x0) / 2 + 150, (y1 - y0) / 2 + 150))
    const cx = Math.min(W - half, Math.max(half, (x0 + x1) / 2))
    const cy = Math.min(H - half, Math.max(half, (y0 + y1) / 2))
    const f = viewer.inner()
    const { M, S } = gs.paper
    const k = Math.max(view.k, Math.min(f.w, f.h) / (2 * half * S))
    view.k = k
    view.x = f.x + f.w / 2 - (M + cx * S) * k
    view.y = f.y + f.h / 2 - (M + cy * S) * k
  }
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
    if (gs.tool !== 'look') toolDown(p, g)
  })
  el.addEventListener('pointermove', (e) => {
    const p = toMeters(e.clientX, e.clientY)
    gs.cursor = p
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
export const TOOL_KEYS: Record<GrowTool, string> = { look: 'V', road: 'R', build: 'B', zone: 'Z', terrain: 'T', erase: 'X' }
window.addEventListener('keydown', (e) => {
  if (app.module !== 'grow' || isTypingTarget(e)) return
  const key = e.key.toLowerCase()
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
  query: () => encode(gs.applied, gs.style),
  apply(q) {
    if (![...q.keys()].length) return
    const d = decode(q, gs.notices)
    if (d.style) gs.style = d.style
    if (sameSetup(d.setup, gs.applied)) return draw()
    gs.setup = d.setup
    restart()
  },
})

/** 地块的说明行 */
export function lotRows(l: GrowLot): [string, string][] {
  return [
    ['用途', t(USE_NAME[l.use] ?? l.use)],
    ['主人', l.owner ?? '—'],
    ['状态', t(l.state === 'building' ? '在建' : '盖好了')],
    ['面积', `${l.area * 400} m²`],
  ]
}
