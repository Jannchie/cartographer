/**
 * 《中国高速公路网 1988–2025》：全息沙盘视频（1920×1080，3 分钟）。
 * 页面生成中国区域图、建全息沙盘与路网层，逐帧约定与预览见 ../shared/page.ts。
 * 地址参数：?theme= 选主题色（见 THEMES）；?preview 为浏览器里的实时预览。
 *
 * 流程：标题故障闪现 → 沙盘逐段搭起、地图逐片展开 → 顶部状态栏与左下读数刷出 → 路网按年份焊接生长，
 * 事件提示从地图上的事件地点引出 → 沙盘收起 → 数据说明。
 * 沙盘后方的立牌画里程曲线（随年份推进）；叠加层（标题、状态栏、读数、事件提示、数据说明）画在全息画布上方的 2D 画布里，
 * 信息栏一律先刷出竖向辅助线、再横向刷出内容，不做渐变的淡入淡出
 */
import { generateWorld } from '../../src/gen/world'
import { DEFAULT_PARAMS, normalizeParams, type World, type WorldParams } from '../../src/gen/types'
import { loadEarthFeatures, loadEarthGrid, readPublicGz } from '../../src/gen/earth/real'
import { loadChinaAdmin, loadChinaGrid } from '../../src/gen/earth/china'
import { regionProjection } from '../../src/gen/earth/region'
import { HoloScene, type RoadStyle } from '../../src/render/holo/scene'
import { setLang } from '../../src/i18n'
import { decode, drawPanel, drawStatusBar, glitch, panelPhase, type HudStyle } from '../shared/hud'
import { clamp01, ease, easeIn, easeOut, rand, span } from '../shared/motion'
import { H, MONO, overlayContext, runVideo, SANS, stagePixelRatio, W } from '../shared/page'
import { BOOT, BOOT_LEN, FLOOR_FULL } from '../../src/render/holo/boot'
import {
  CAPTIONS,
  captionsAt,
  DURATION,
  FPS,
  INTRO,
  officialKmAt,
  OUTRO,
  shotAt,
  T_END,
  T_START,
  YEAR_FROM,
  YEAR_TO,
  yearAt,
} from './timeline'

interface RoadsData {
  official: [number, number][]
  /** 各来源的里程占比：0 OSM 标注、1 沿线推断、2 估算、3 学术数据 */
  share: number[]
  ways: { c: number[]; t: number; s: number; km: number }[]
}

/**
 * 主题色：路网与界面的强调色（road 路网、hot 焊接的白热色、accent 界面强调色及其 RGB 分量、glow 高亮点）。
 * 地址参数 ?theme= 选择，默认 amber（路网像夜里的灯光）
 */
const THEMES = {
  amber: { road: '#ff8a1e', hot: '#ffcf9a', accent: '#ff8f2a', rgb: '255, 143, 42', glow: '#ffe9d2' },
  cyan: { road: '#3fcfff', hot: '#e6fbff', accent: '#5fdcff', rgb: '95, 220, 255', glow: '#eafcff' },
  red: { road: '#ff5a3c', hot: '#ffe0d4', accent: '#ff6a48', rgb: '255, 106, 72', glow: '#fff0ea' },
}
const THEME = THEMES[(new URLSearchParams(location.search).get('theme') ?? 'amber') as keyof typeof THEMES] ?? THEMES.amber
const ROAD: RoadStyle = { color: THEME.road, width: 1.05, opacity: 0.88, hot: THEME.hot, hotWidth: 1.6, cool: 0.55, spark: '#ffffff', sparkSize: 0.32, halo: 0.035, haloWidth: 2.2 }
const INK = 'rgba(223, 233, 245, 0.92)'
const DIM = 'rgba(190, 210, 232, 0.55)'
const LINE = 'rgba(127, 157, 191, 0.55)'
const ACCENT = THEME.accent
const ST: HudStyle = { ink: INK, dim: DIM, line: LINE, accent: ACCENT, glow: THEME.glow, sans: SANS, mono: MONO, dpr: 1 }
/** 展开的圆心（经纬度）与最终半径（场景单位，盖住整张图） */
const UNFOLD_AT: [number, number] = [104, 34]
const UNFOLD_R = 100

/** 准备数据与场景，返回逐帧绘制函数 */
async function setup() {
  setLang('zh')
  const [, , , , roadsBuf] = await Promise.all([loadEarthGrid('5m'), loadEarthFeatures(), loadChinaGrid(), loadChinaAdmin(), readPublicGz('china/roads.bin')])
  const data = JSON.parse(new TextDecoder().decode(roadsBuf)) as RoadsData
  // 标准档（1450 格宽）：精细档的海岸线线段过密，加色叠加后发白晕开
  const p: WorldParams = { ...DEFAULT_PARAMS, region: 'china', width: 1450 }
  normalizeParams(p)
  const world = generateWorld(p)
  const proj = regionProjection(p)!

  const holo = new HoloScene(document.getElementById('stage')!, { palette: 'tactical', exaggeration: 16, labels: false, hud: false, sectionHeight: 4 })
  holo.setPixelRatio(stagePixelRatio())
  // 泛光弱、半径小：只在亮线周围一圈，不在整张图上罩一层雾
  holo.setBloom(0.05, 0.08)
  holo.setWorld(world)
  holo.setManual(true)
  // 焊接时长：按长度，约 900 公里一年，长链也不超过 0.9 年；年底开通的路段在演进结束前焊完
  const roads = data.ways.map((w) => {
    const pts: number[] = []
    for (let k = 0; k < w.c.length; k += 2) pts.push(...proj.toCell(w.c[k] / 1e5, w.c[k + 1] / 1e5))
    return { pts, t: w.t, dur: Math.max(0.02, Math.min(0.9, Math.max(0.08, w.km / 900), 2025.995 - w.t)) }
  })
  holo.setRoadNetwork(roads, ROAD)
  const [ucx, ucy] = proj.toCell(...UNFOLD_AT)
  // 后方立牌：标题与里程曲线
  const plate = document.createElement('canvas')
  plate.width = 2400
  plate.height = 440
  holo.setHeaderCanvas(plate)
  const pg = plate.getContext('2d')!

  const { ctx, dpr } = overlayContext()
  ST.dpr = dpr

  const official = data.official
  const final = official[official.length - 1][1]
  // 截至某年已开通的路段数：开通时间排好序后二分
  const opened = data.ways.map((w) => w.t).sort((a, b) => a - b)
  const openedBy = (y: number) => {
    let lo = 0
    let hi = opened.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (opened[m] <= y) lo = m + 1
      else hi = m
    }
    return lo
  }
  const anchors = CAPTIONS.map((c) => (c.at ? proj.toCell(...c.at) : null))
  const capitals = capitalMarks(world)
  const view: View = { sec: 0, year: YEAR_FROM, frame: 0, km: 0, official, final, estimated: data.share[2], segments: data.ways.length, opened: 0 }

  return (i: number) => {
    const sec = i / FPS
    const year = yearAt(sec)
    const [f0, f1] = OUTRO.fold
    // 沙盘：搭建时钟、展开半径与线的不透明度；收起时倒放
    let unfold: number | null
    let lines: number
    let boot: number
    if (sec < f0) {
      const u = span(sec, INTRO.unfold[0], INTRO.unfold[1])
      unfold = u >= 1 ? null : ease(u) * UNFOLD_R
      lines = span(sec, INTRO.lines[0], INTRO.lines[1])
      boot = sec - INTRO.boot
    } else {
      // 路网与界线 0.4 秒内熄灭，地图逐片收回，0.6 秒后图框与线框盒开始倒着拆
      unfold = (1 - easeIn(span(sec, f0 + 0.2, f1 - 0.8))) * UNFOLD_R
      lines = 1 - span(sec, f0, f0 + 0.4)
      boot = BOOT_LEN - (sec - f0 - 0.6) * (BOOT_LEN / (f1 - f0 - 0.6))
    }
    // 地板底纹：片头自中心逐块铺开，片尾由外向内收回
    const floor = sec < OUTRO.floor[0] ? ease(span(sec, INTRO.floor[0], INTRO.floor[1])) * FLOOR_FULL : (1 - easeIn(span(sec, OUTRO.floor[0], OUTRO.floor[1]))) * FLOOR_FULL
    // 国界：霓虹灯管通电式的闪烁，片尾倒放熄灭
    const neon = sec < f0 ? span(sec, INTRO.neon[0], INTRO.neon[1]) : 1 - span(sec, OUTRO.neon[0], OUTRO.neon[1])
    // 引线标注（直辖市与珠峰）：海岸与界线出现后逐条升起、刷开，片尾倒着收回
    const annotate = sec < f0 ? span(sec, INTRO.lines[0] + 0.2, INTRO.lines[1] + 1) : 1 - span(sec, f0, f0 + 0.5)
    holo.setIntro({ unfold, cx: ucx, cy: ucy, lines, boot, floor, neon, annotate })
    // 演进结束后路网的时钟继续走一点，最后焊完的小段冷却下来
    holo.setRoadTime(sec >= T_END ? 2026 + (sec - T_END) * 0.5 : year)
    const s = shotAt(sec)
    const [tx, ty] = proj.toCell(s.lon, s.lat)
    const [x, , z] = holo.cellToScene(tx, ty)
    const tilt = (s.tilt * Math.PI) / 180
    const yaw = (s.yaw * Math.PI) / 180
    holo.setCamera([x + s.dist * Math.cos(tilt) * Math.sin(yaw), s.dist * Math.sin(tilt), z + s.dist * Math.cos(tilt) * Math.cos(yaw)], [x, 0, z])
    Object.assign(view, { sec, year, frame: i, km: sec >= T_END ? final : officialKmAt(official, Math.min(year, 2025.999)), opened: openedBy(year) })
    drawPlate(pg, view)
    holo.refreshHeader()
    holo.renderFrame()
    drawOverlay(
      ctx,
      view,
      s,
      (k) => {
        const a = anchors[k]
        return a ? holo.cellToScreen(a[0], a[1]) : null
      },
      capitals.map((c) => ({ ...c, at: holo.cellToScreen(c.cx, c.cy) })),
    )
  }
}

/** 一帧的状态：时刻、年份、当前里程与路段数，以及画面不随时间变化的数据 */
interface View {
  sec: number
  year: number
  frame: number
  km: number
  official: [number, number][]
  final: number
  estimated: number
  segments: number
  opened: number
}

const fmtKm = (km: number) => Math.round(km).toLocaleString('en-US')

type ScreenPoint = { x: number; y: number; behind: boolean }

/** 省会（直辖市另有全息沙盘里的引线标注，不在此列）：画面上的位置与名称 */
interface CityMark {
  cx: number
  cy: number
  name: string
}
function capitalMarks(world: World): CityMark[] {
  const annotated = new Set(world.labels.filter((l) => l.anno).map((l) => l.zh))
  return (world.realms ?? [])
    .map((r) => world.labels[r.capital])
    .filter((l) => l && !annotated.has(l.zh))
    .map((l) => ({ cx: l.x, cy: l.y, name: l.zh }))
}

/**
 * 省会：一个小点与一行淡色小字，只作位置参照，不抢路网与事件提示的视线。
 * 海岸与界线出现之后依次刷出，收起沙盘时倒着收回
 */
function drawCapitals(ctx: CanvasRenderingContext2D, v: View, cities: (CityMark & { at: ScreenPoint })[]) {
  const [f0] = OUTRO.fold
  const show = v.sec < f0 ? span(v.sec, INTRO.lines[0] + 0.4, INTRO.lines[1] + 0.8) : 1 - span(v.sec, f0, f0 + 0.35)
  if (show <= 0) return
  const n = cities.length
  ctx.save()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `400 13px ${SANS}`
  cities.forEach((c, i) => {
    const { x, y, behind } = c.at
    if (behind || x < 20 || x > W - 20 || y < 90 || y > H - 20) return
    const t = clamp01((show - (i / n) * 0.5) / 0.5)
    if (t <= 0) return
    ctx.fillStyle = 'rgba(223, 233, 245, 0.6)'
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
    const wipe = easeOut(clamp01((t - 0.2) / 0.3))
    if (wipe <= 0) return
    const tw = ctx.measureText(c.name).width
    ctx.save()
    ctx.beginPath()
    ctx.rect(x + 5, y - 10, (tw + 6) * wipe, 20)
    ctx.clip()
    ctx.fillStyle = 'rgba(214, 226, 240, 0.5)'
    ctx.fillText(c.name, x + 6, y)
    ctx.restore()
  })
  ctx.restore()
}

/**
 * 左下的年份：空心描边字，填充半透明，背后衬一块网格底纹，网格上沿一条年内进度条（12 个月刻度，亮点随时间推进）。
 * 换年时像一次数据刷新：变了的数位上一道扫描线自上而下扫过（扫过处已是新数字，下方仍是旧数字），
 * 新数字头 0.1 秒带一点故障错位，数位四角弹出锁定框、半秒后收起，网格上一道亮带自左向右扫过
 */
function drawYear(ctx: CanvasRenderingContext2D, v: View, text: string, x: number, y: number) {
  const gx = x - 8
  const gy = y - 112
  const gw = 340
  const gh = 132
  const perYear = (T_END - T_START) / (YEAR_TO - YEAR_FROM)
  const live = v.sec >= T_START && v.sec < T_END
  // 换年后经过的时间（秒）；演进之外不播换年动画
  const age = live ? (v.year - Math.floor(v.year)) * perYear : 1e9
  const frac = live ? v.year - Math.floor(v.year) : v.sec >= T_END ? 1 : 0
  ctx.save()
  // 网格底纹：每 10 像素一道细线，向四周淡出；换年时一道亮带扫过，经过处网格提亮
  const band = age < 0.4 ? gx + gw * easeOut(age / 0.4) : -1e9
  ctx.lineWidth = 1
  for (let i = 0; i <= gw; i += 10) {
    const lit = Math.max(0, 1 - Math.abs(gx + i - band) / 36)
    ctx.strokeStyle = `rgba(127, 157, 191, ${0.16 * (1 - Math.abs(i / gw - 0.5) * 1.6) + 0.5 * lit})`
    ctx.beginPath()
    ctx.moveTo(gx + i + 0.5, gy)
    ctx.lineTo(gx + i + 0.5, gy + gh)
    ctx.stroke()
  }
  for (let j = 0; j <= gh; j += 10) {
    ctx.strokeStyle = `rgba(127, 157, 191, ${0.16 * (1 - Math.abs(j / gh - 0.5) * 1.6)})`
    ctx.beginPath()
    ctx.moveTo(gx, gy + j + 0.5)
    ctx.lineTo(gx + gw, gy + j + 0.5)
    ctx.stroke()
  }
  if (band > gx) {
    ctx.fillStyle = THEME.glow
    ctx.fillRect(band - 1, gy, 2, gh)
  }
  ctx.strokeStyle = LINE
  ctx.beginPath()
  for (const [cx, cy, sx, sy] of [
    [gx, gy + gh, 1, -1],
    [gx + gw, gy + gh, -1, -1],
  ]) {
    ctx.moveTo(cx + sx * 10, cy)
    ctx.lineTo(cx, cy)
    ctx.lineTo(cx, cy + sy * 10)
  }
  ctx.stroke()
  // 年内进度条：网格上沿，12 个月刻度，已走过的一段与当前位置的亮点
  ctx.fillStyle = LINE
  ctx.fillRect(gx, gy, gw, 1)
  for (let m = 0; m <= 12; m++) ctx.fillRect(gx + (gw * m) / 12, gy - (m % 3 === 0 ? 6 : 3), 1, m % 3 === 0 ? 6 : 3)
  ctx.fillStyle = ACCENT
  ctx.fillRect(gx, gy - 1, gw * frac, 2)
  ctx.fillStyle = THEME.glow
  ctx.fillRect(gx + gw * frac - 2, gy - 3, 4, 6)
  // 数字：等宽字体逐位画（空心描边、半透明填充）
  ctx.font = `700 132px ${MONO}`
  ctx.textAlign = 'left'
  const adv = ctx.measureText('0').width
  const top = y - 100
  const cellH = 108
  const glyph = (ch: string, cx: number) => {
    ctx.fillStyle = 'rgba(223, 233, 245, 0.16)'
    ctx.fillText(ch, cx, y)
    ctx.lineWidth = 1.6
    ctx.strokeStyle = INK
    ctx.strokeText(ch, cx, y)
  }
  const clipped = (y0: number, y1: number, draw: () => void) => {
    if (y1 <= y0) return
    ctx.save()
    ctx.beginPath()
    ctx.rect(gx, y0, gw, y1 - y0)
    ctx.clip()
    draw()
    ctx.restore()
  }
  const prev = String(Math.min(2025, Math.floor(v.year)) - 1)
  ;[...text].forEach((ch, i) => {
    const cx = x + i * adv
    const changed = age < 1 && ch !== prev[i]
    if (!changed) return glyph(ch, cx)
    // 扫描线：0.22 秒自上而下，扫过处是新数字（头 0.1 秒带故障错位），下方仍是旧数字
    const scan = top + cellH * easeOut(clamp01(age / 0.22))
    clipped(top - 10, scan, () => {
      if (age < 0.1) glitch(ctx, ST, [cx - 10, top - 10, adv + 20, cellH + 20], 0.6 * (1 - age / 0.1), v.frame + i * 17, () => glyph(ch, cx))
      else glyph(ch, cx)
    })
    clipped(scan, top + cellH + 10, () => glyph(prev[i], cx))
    if (scan < top + cellH) {
      ctx.fillStyle = THEME.glow
      ctx.fillRect(cx - 4, scan - 1, adv + 8, 2)
      ctx.fillStyle = `rgba(${THEME.rgb}, 0.35)`
      ctx.fillRect(cx - 4, scan - 7, adv + 8, 4)
    }
    // 锁定框：四角角标，弹出时由外向内收拢，半秒后收起
    if (age < 0.5) {
      const k = 6 * (1 - easeOut(clamp01(age / 0.12)))
      const [l, r, t, b] = [cx - 6 - k, cx + adv + 6 + k, top - 8 - k, top + cellH + 4 + k]
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (const [px, py, sx, sy] of [
        [l, t, 1, 1],
        [r, t, -1, 1],
        [l, b, 1, -1],
        [r, b, -1, -1],
      ]) {
        ctx.moveTo(px + sx * 12, py)
        ctx.lineTo(px, py)
        ctx.lineTo(px, py + sy * 12)
      }
      ctx.stroke()
    }
  })
  ctx.restore()
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  v: View,
  shot: { lon: number; lat: number },
  anchor: (k: number) => ScreenPoint | null,
  capitals: (CityMark & { at: ScreenPoint })[],
) {
  ctx.clearRect(0, 0, W, H)
  ctx.globalAlpha = 1
  drawTitle(ctx, v)
  // 顶部状态栏：收起沙盘时倒着收回
  const [f0] = OUTRO.fold
  const statusAge = v.sec < f0 ? v.sec - INTRO.status : 0.6 - (v.sec - f0) * 1.5
  const lat = `${shot.lat.toFixed(2)}°N ${shot.lon.toFixed(2)}°E`
  const yr = Math.min(2025.999, v.year)
  const tl = `${Math.floor(yr)}.${String(Math.floor((yr % 1) * 12) + 1).padStart(2, '0')}`
  drawStatusBar(
    ctx,
    ST,
    [
      ['SESSION STATUS', 'ONLINE', 150],
      ['OPERATION', 'CN EXPRESSWAY', 200],
      ['PROJECTION', 'LCC 25°N / 47°N', 190],
      ['TARGET', lat, 210],
      ['T/L', tl, 120],
      ['SEGMENTS', v.opened.toLocaleString('en-US'), 140],
      ['NETWORK', `${fmtKm(v.km)} KM`, 170],
      ['DATA', 'MOT · OSM · MA&TANG', 230],
    ],
    72,
    26,
    statusAge,
  )
  drawCapitals(ctx, v, capitals)
  drawReadout(ctx, v)
  for (const c of captionsAt(v.sec)) drawCaption(ctx, v, c.index, c.age, c.life, anchor(c.index))
  drawSources(ctx, v)
}

/**
 * 片头标题：两道竖线先刷出，文字以故障闪现的方式出现（像素块、条带错位与色差，很快稳定），停留后再故障消失
 */
function drawTitle(ctx: CanvasRenderingContext2D, v: View) {
  const [a, b] = INTRO.title
  const sec = v.sec
  if (sec < a || sec > b) return
  const cx = W / 2
  const cy = H / 2 - 10
  ctx.font = `700 84px ${SANS}`
  const tw = ctx.measureText('中国高速公路网').width
  const bx = tw / 2 + 70
  // 竖线：自中点向上下刷出，结束时收起
  const lv = Math.min(easeOut(span(sec, a, a + 0.1)), clamp01((b - sec) / 0.08))
  ctx.fillStyle = INK
  for (const sx of [-1, 1]) ctx.fillRect(cx + sx * bx - 1, cy - 58 * lv, 2, 116 * lv)
  // 故障强度：出现时从 1 迅速落到 0（中间偶尔再抽一下），消失前 0.3 秒升回 1
  const age = sec - a - 0.08
  if (age < 0 || b - sec < 0.06) return
  const spike = rand(Math.floor(sec * FPS), 3) > 0.82 ? 0.35 : 0
  const amount = age < 0.4 ? 1 - age / 0.4 : b - sec < 0.32 ? 1 - (b - sec - 0.06) / 0.26 : age < 0.9 ? spike * (1 - (age - 0.4) / 0.5) : 0
  glitch(ctx, ST, [cx - bx + 6, cy - 130, bx * 2 - 12, 260], clamp01(amount), v.frame, (g) => {
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = DIM
    g.font = `400 20px ${MONO}`
    g.fillText('CHINA EXPRESSWAY NETWORK', cx, cy - 92)
    g.fillStyle = INK
    g.font = `700 84px ${SANS}`
    g.fillText('中国高速公路网', cx, cy + 2)
    g.fillStyle = INK
    g.font = `500 26px ${SANS}`
    g.fillText('1988 — 2025 · 中国大陆高速公路建设历程', cx, cy + 92)
  })
}

/**
 * 左下读数：年份与里程。进入时竖标尺先长出，标签与数字横向刷出、数字解码定格；收起沙盘时从右往左收回
 */
function drawReadout(ctx: CanvasRenderingContext2D, v: View) {
  const b0 = INTRO.body
  const sec = v.sec
  if (sec < b0) return
  const [f0] = OUTRO.fold
  const out = easeOut(span(sec, f0, f0 + 0.18))
  if (out >= 1) return
  // 压在地图上：垫一层自下而上渐隐的暗色
  // 衬底是以左下角为中心的椭圆渐变，四周都柔和过渡（矩形的右边缘会在地图上切出一道竖线）
  ctx.save()
  ctx.translate(0, H)
  ctx.scale(2.6, 1)
  const shade = ctx.createRadialGradient(0, 0, 0, 0, 0, 400)
  shade.addColorStop(0, `rgba(2, 6, 12, ${0.72 * (1 - out)})`)
  shade.addColorStop(0.55, `rgba(2, 6, 12, ${0.45 * (1 - out)})`)
  shade.addColorStop(1, 'rgba(2, 6, 12, 0)')
  ctx.fillStyle = shade
  ctx.fillRect(0, -400, 400, 400)
  ctx.restore()
  const rule = Math.min(easeOut(span(sec, b0, b0 + 0.12)), 1 - out)
  ctx.strokeStyle = LINE
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(52.5, H - 96)
  ctx.lineTo(52.5, H - 96 - 226 * rule)
  ctx.stroke()
  ctx.fillStyle = INK
  ctx.fillRect(51, H - 322, 3, 12 * rule)
  ctx.save()
  ctx.beginPath()
  ctx.rect(52, H - 340, 800 * Math.min(easeOut(span(sec, b0 + 0.1, b0 + 0.3)), 1 - out), 300)
  ctx.clip()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = DIM
  ctx.font = `400 18px ${MONO}`
  ctx.fillText('YEAR', 76, H - 302)
  drawYear(ctx, v, decode(String(Math.min(2025, Math.floor(v.year))), span(sec, b0 + 0.1, b0 + 0.6), v.frame), 64, H - 176)
  const kmText = fmtKm(v.km)
  ctx.font = `700 44px ${MONO}`
  ctx.fillStyle = ACCENT
  ctx.fillText(decode(kmText, span(sec, b0 + 0.2, b0 + 0.7), v.frame + 7), 72, H - 110)
  const kw = ctx.measureText(kmText).width
  ctx.font = `500 24px ${SANS}`
  ctx.fillStyle = DIM
  ctx.fillText('公里 · 高速公路通车里程', 72 + kw + 16, H - 113)
  ctx.restore()
}

/**
 * 事件提示：有地点的从地图上的地点引出——地点处一个准星，竖线自地点向上刷到信息栏，信息栏再横向刷开；
 * 没有地点（或地点不在画面里）的显示在画面左上。信息栏：标题行（EVENT 与日期、右侧编号），下面是正文
 */
function drawCaption(ctx: CanvasRenderingContext2D, v: View, index: number, age: number, life: number, at: ScreenPoint | null) {
  const c = CAPTIONS[index]
  ctx.font = `500 26px ${SANS}`
  const w = Math.max(ctx.measureText(c.text).width + 56, 380)
  const h = 96
  const pole = 120
  const anchored = !!at && !at.behind && at.x > 60 && at.x < W - 60 && at.y > 200 && at.y < H - 60
  let gx = 72
  let y = 104
  let dir: 1 | -1 = 1
  const t = anchored ? age - 0.1 : age
  if (anchored) {
    // 准星：0.06 秒内收拢到位
    const k = 1 + 2 * (1 - easeOut(clamp01(age / 0.06)))
    const rest = life - age
    if (rest > 0.04) {
      ctx.strokeStyle = THEME.glow
      ctx.lineWidth = 1.5
      const r = 9 * k
      ctx.beginPath()
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        ctx.moveTo(at.x + sx * r, at.y + sy * r * 0.5)
        ctx.lineTo(at.x + sx * r, at.y + sy * r)
        ctx.lineTo(at.x + sx * r * 0.5, at.y + sy * r)
      }
      ctx.stroke()
      ctx.fillStyle = THEME.glow
      ctx.fillRect(at.x - 2, at.y - 2, 4, 4)
    }
    // 竖线：自地点向上（太靠上时向下）刷出，收起时最后收回
    const up = at.y - pole - h > 120
    dir = at.x + w + 40 > W ? -1 : 1
    gx = at.x
    y = up ? at.y - pole - h : at.y + pole
    const grow = Math.min(easeOut(clamp01(age / 0.1)), clamp01((life - age) / 0.05))
    ctx.strokeStyle = INK
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(gx, at.y + (up ? -10 : 10))
    ctx.lineTo(gx, at.y + (up ? -10 - (pole - 10) * grow : 10 + (pole - 10) * grow))
    ctx.stroke()
  }
  const phase = panelPhase(t, life - (anchored ? 0.1 : 0))
  const x0 = dir > 0 ? gx : gx - w
  drawPanel(ctx, ST, { gx, y, w, h, dir, ext: anchored ? 0 : 22, phase, seed: v.frame * 7 + index }, (g) => {
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    g.fillStyle = ACCENT
    g.font = `400 15px ${MONO}`
    g.fillText(`EVENT  |  ${c.tag}`, x0 + 22, y + 26)
    g.textAlign = 'right'
    g.fillStyle = DIM
    g.fillText(`E-${String(index + 1).padStart(2, '0')}`, x0 + w - 18, y + 26)
    g.fillStyle = LINE
    g.fillRect(x0 + 22, y + 38, w - 40, 1)
    g.textAlign = 'left'
    g.fillStyle = INK
    g.font = `500 26px ${SANS}`
    g.fillText(c.text, x0 + 22, y + 76)
  })
}

/** 片尾：沙盘收起后，画面中央刷出数据说明 */
function drawSources(ctx: CanvasRenderingContext2D, v: View) {
  const age = v.sec - OUTRO.sources
  if (age < 0) return
  const w = 1040
  const h = 560
  const gx = (W - w) / 2
  const y = (H - h) / 2
  const lines = [
    '通车里程：交通运输部历年统计公报、国家统计局《中国统计年鉴》',
    '路段与开通年份：© OpenStreetMap 贡献者（ODbL）；Ma & Tang (2024), J. Int. Econ. 148 论文配套数据（GPL-3.0）',
    `其中约 ${Math.round(v.estimated * 100)}% 的路段没有记载年份，按统计里程估算；只知道年份的路段在年内按接入路网的先后排开`,
    '地形：NOAA ETOPO 2022；陆地、湖泊与山峰：Natural Earth；行政区划：DataV.GeoAtlas',
    '里程统计范围：中国大陆，不含香港、澳门特别行政区和台湾省；底图界线按国内标准地图的口径绘制',
  ]
  drawPanel(ctx, ST, { gx, y, w, h, dir: 1, ext: 60, phase: panelPhase(age, 1e9), seed: v.frame * 13, fill: 'rgba(5, 10, 18, 0.78)' }, (g) => {
    const x = gx + 40
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    g.fillStyle = ACCENT
    g.font = `400 15px ${MONO}`
    g.fillText('DATA SOURCES  |  数据说明', x, y + 36)
    g.textAlign = 'right'
    g.fillStyle = DIM
    g.fillText('CN-EXPWY 1988–2025', gx + w - 30, y + 36)
    g.fillStyle = LINE
    g.fillRect(x, y + 50, w - 70, 1)
    g.textAlign = 'left'
    g.fillStyle = ACCENT
    g.font = `700 64px ${MONO}`
    const big = fmtKm(v.final)
    g.fillText(big, x, y + 132)
    const bw = g.measureText(big).width
    g.fillStyle = INK
    g.font = `500 24px ${SANS}`
    g.fillText('公里 · 2025 年底中国大陆高速公路通车里程', x + bw + 20, y + 128)
    g.fillStyle = DIM
    g.font = `400 20px ${MONO}`
    g.fillText(`1988 — 2025  ·  ${v.segments.toLocaleString('en-US')} SEGMENTS`, x, y + 170)
    g.fillStyle = LINE
    g.fillRect(x, y + 196, w - 70, 1)
    g.font = `400 18px ${SANS}`
    g.fillStyle = DIM
    // 长行在画布宽度内折行
    let ly = y + 236
    for (const l of lines) {
      let rest = l
      while (rest) {
        let n = rest.length
        while (n > 1 && g.measureText(rest.slice(0, n)).width > w - 80) n--
        g.fillText(rest.slice(0, n), x, ly)
        rest = rest.slice(n)
        ly += 32
      }
      ly += 6
    }
  })
}

/**
 * 沙盘后方的立牌（2400×440，加色叠在场景里，黑色即透明）：左上标题，右上读数，下方是里程曲线——
 * 官方年底里程整条淡画，已走过的一段高亮并填色，当前位置一道竖线与读数。曲线在沙盘搭好时横向刷出
 */
function drawPlate(g: CanvasRenderingContext2D, v: View) {
  const CW = 2400
  const CH = 440
  g.clearRect(0, 0, CW, CH)
  g.textBaseline = 'alphabetic'
  g.textAlign = 'left'
  g.fillStyle = INK
  g.font = `700 64px "Archivo", sans-serif`
  g.fontStretch = 'expanded'
  g.fillText('CHINA MAP', 60, 76)
  g.fontStretch = 'normal'
  g.fillStyle = DIM
  g.font = `500 28px ${SANS}`
  g.fillText('中国高速公路网 · 1988 — 2025 · 年底通车里程', 62, 118)
  const label = (x: number, k: string, val: string) => {
    g.textAlign = 'right'
    g.fillStyle = DIM
    g.font = `400 22px ${MONO}`
    g.fillText(k, x, 44)
    g.fillStyle = INK
    g.font = `400 38px ${MONO}`
    g.fillText(val, x, 90)
  }
  label(CW - 60, 'NETWORK', `${fmtKm(v.km)} KM`)
  label(CW - 520, 'SEGMENTS', v.opened.toLocaleString('en-US'))
  label(CW - 860, 'YEAR', String(Math.min(2025, Math.floor(v.year))))
  // 曲线区
  const x0 = 60
  const x1 = CW - 60
  const yt = 170
  const yb = 380
  const top = 200000
  const X = (yr: number) => x0 + ((yr - YEAR_FROM) / (2026 - YEAR_FROM)) * (x1 - x0)
  const Y = (km: number) => yb - (km / top) * (yb - yt)
  const reveal = easeOut(span(v.sec, INTRO.boot + BOOT.header - 0.1, INTRO.boot + BOOT.header + 0.7))
  if (reveal <= 0) return
  g.save()
  g.beginPath()
  g.rect(0, 140, x0 + (x1 - x0 + 80) * reveal, CH - 140)
  g.clip()
  g.strokeStyle = LINE
  g.lineWidth = 1.5
  g.beginPath()
  for (const km of [0, 50000, 100000, 150000, 200000]) {
    g.moveTo(x0, Y(km))
    g.lineTo(x1, Y(km))
  }
  g.stroke()
  g.fillStyle = DIM
  g.font = `400 20px ${MONO}`
  g.textAlign = 'left'
  for (const km of [50000, 100000, 150000, 200000]) g.fillText(`${km / 1000}K`, x0 + 8, Y(km) - 8)
  g.textAlign = 'center'
  g.font = `400 22px ${MONO}`
  for (let yr = 1990; yr <= 2025; yr += 5) {
    g.fillRect(X(yr) - 1, yb, 2, yr % 10 === 0 ? 14 : 8)
    g.fillText(String(yr), X(yr), yb + 40)
  }
  const pts: [number, number][] = [[X(YEAR_FROM), Y(0)]]
  for (const [yr, km] of v.official) pts.push([X(yr + 1), Y(km)])
  g.strokeStyle = `rgba(${THEME.rgb}, 0.28)`
  g.lineWidth = 3
  g.beginPath()
  pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.stroke()
  const yr = Math.min(v.year, 2025.999)
  const cut = X(yr)
  const cy = Y(officialKmAt(v.official, yr))
  g.save()
  g.beginPath()
  g.rect(x0 - 2, yt - 20, cut - x0 + 2, yb - yt + 40)
  g.clip()
  const fill = g.createLinearGradient(0, yt, 0, yb)
  fill.addColorStop(0, `rgba(${THEME.rgb}, 0.32)`)
  fill.addColorStop(1, `rgba(${THEME.rgb}, 0.02)`)
  g.fillStyle = fill
  g.beginPath()
  pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.lineTo(pts[pts.length - 1][0], yb)
  g.lineTo(x0, yb)
  g.fill()
  g.strokeStyle = ACCENT
  g.lineWidth = 6
  g.beginPath()
  pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.stroke()
  g.restore()
  g.strokeStyle = INK
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(cut, yt - 10)
  g.lineTo(cut, yb)
  g.stroke()
  g.fillStyle = THEME.glow
  g.beginPath()
  g.arc(cut, cy, 9, 0, Math.PI * 2)
  g.fill()
  g.font = `700 30px ${MONO}`
  g.textAlign = cut > x1 - 260 ? 'right' : 'left'
  g.fillText(`${fmtKm(v.km)} KM`, cut + (cut > x1 - 260 ? -18 : 18), Math.max(yt + 10, cy - 18))
  g.restore()
}

runVideo({ fps: FPS, duration: DURATION, setup, label: (sec) => String(Math.min(2025, Math.floor(yearAt(sec)))) })
