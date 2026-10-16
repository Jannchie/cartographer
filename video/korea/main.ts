/**
 * 《朝鲜战争 1950–1953》小样：全息沙盘上的控制区与前线随关键帧推进（1920×1080）。
 * 逐帧约定与预览见 ../shared/page.ts；前线关键帧见 fronts.geojson（据西点军校历史系地图集数字化，前线为示意）。
 *
 * 中立：两方用中性的沙色与青绿色（不用暗示善恶的红蓝），名称并列各方称呼；事件提示只陈述事实，
 * 不下胜负结论；片尾注明前线的依据与"关键帧之间为插值"
 */
import { generateWorld } from '../../src/gen/world'
import { DEFAULT_PARAMS, normalizeParams, type WorldParams } from '../../src/gen/types'
import { loadEarthFeatures, loadEarthGrid } from '../../src/gen/earth/real'
import { loadRegionGrid } from '../../src/gen/earth/regionGrid'
import { regionProjection, type MapProjection } from '../../src/gen/earth/region'
import { BOOT_LEN, FLOOR_FULL } from '../../src/render/holo/boot'
import { HoloScene } from '../../src/render/holo/scene'
import { frontContour } from '../../src/render/holo/territory'
import { setLang } from '../../src/i18n'
import { drawPanel, drawStatusBar, drawTitleCard, panelPhase, type HudStyle } from '../shared/hud'
import { clamp01, ease, easeIn, easeOut, span } from '../shared/motion'
import { H, MONO, overlayContext, runVideo, SANS, stagePixelRatio, W } from '../shared/page'
import { BATTLE_HOLD, buildTimeline, CAPTION_HOLD, CAPTION_S, CAPTIONS, dateAt, day, dayAt, DURATION, fmtDay, FPS, INTRO, OUTRO, secOf, secOfDay, shotAt } from './timeline'

const INK = 'rgba(223, 233, 245, 0.92)'
const DIM = 'rgba(190, 210, 232, 0.55)'
const LINE = 'rgba(127, 157, 191, 0.55)'
/** 两方的颜色：中性的沙色与青绿色；前线为白色 */
const SIDE_A = '#c4473a'
const SIDE_B = '#3f72c0'
const FRONT = '#fff1e2'
const ST: HudStyle = { ink: INK, dim: DIM, line: LINE, accent: '#e9c48a', glow: '#fff4e2', sans: SANS, mono: MONO, dpr: 1 }
const SIDES = ['中国人民志愿军、朝鲜人民军', '美军、“联合国军”、南朝鲜军']
/** 军标与箭头用的两方颜色（比控制区的填色亮一些） */
const MARK: Record<Side, string> = { a: '#ff6b55', b: '#5aa6ff' }
/** 画面上标出的城市：中文名（历史地名）、罗马字写法、经纬度 */
const CITIES: [string, string, number, number][] = [
  ['汉城', 'SEOUL', 126.98, 37.57],
  ['平壤', 'PYONGYANG', 125.75, 39.03],
  ['釜山', 'BUSAN', 129.04, 35.18],
  ['仁川', 'INCHEON', 126.63, 37.46],
  ['大邱', 'DAEGU', 128.6, 35.87],
  ['开城', 'KAESONG', 126.55, 37.97],
  ['元山', 'WONSAN', 127.44, 39.15],
  ['兴南', 'HUNGNAM', 127.62, 39.83],
  ['大田', 'DAEJEON', 127.38, 36.35],
  ['安东', 'ANDONG (DANDONG)', 124.39, 40.12],
]

type Geometry = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] } | { type: string; coordinates: unknown }
interface Fronts {
  features: { properties: { date: string; kind: string }; geometry: Geometry }[]
}
type Side = 'a' | 'b'
/** 部队部署、行军方向与战役（ops.json）：side a 为朝鲜人民军、中国人民志愿军，b 为韩国军、联合国军 */
interface Unit {
  id: string
  side: Side
  name: string
  nameAlt?: string
  /** 陆军、空军、海军（缺省为陆军） */
  domain?: 'land' | 'air' | 'naval'
  echelon: 'army' | 'corps' | 'division' | 'brigade' | 'regiment'
  type: string
  track: { date: string; lon: number; lat: number }[]
  /** 进入：日期、来处（省略则就地出现）与说明；离开：日期、去处（省略则就地撤出）与说明 */
  arrive?: { date: string; from?: [number, number]; note: string; source?: string }
  leave?: { date: string; to?: [number, number]; note: string; source?: string }
}
interface Arrow {
  side: Side
  /** 地面攻势画成宽箭头，空中、海上行动画成离地的发光弧线（缺省为地面） */
  kind?: 'ground' | 'air' | 'naval'
  start: string
  end: string
  path: [number, number][]
  label?: string
}
interface Battle {
  id: string
  name: string
  names: { ko?: string; en?: string }
  start: string
  end: string
  lon: number
  lat: number
  forces: Record<Side, string>
  summary: string
  outcome: Record<Side, string>
}
interface Ops {
  units: Unit[]
  arrows: Arrow[]
  battles: Battle[]
}

/**
 * 一个关键帧的控制区：每个地图格的归属（0 无、1 甲方 north、2 乙方 south、3 争夺或不确定 contested，后画的覆盖先画的）。
 * 多边形按格心投影到地图格坐标，画在离屏画布上再按像素取值
 */
function rasterize(fronts: Fronts, date: string, proj: MapProjection, gw: number, gh: number) {
  const owner = new Uint8Array(gw * gh)
  for (const [kind, side] of [
    ['north', 1],
    ['south', 2],
    ['contested', 3],
  ] as const) {
    const cv = new OffscreenCanvas(gw, gh)
    const g = cv.getContext('2d')!
    g.fillStyle = '#fff'
    g.beginPath()
    for (const f of fronts.features) {
      if (f.properties.date !== date || f.properties.kind !== kind) continue
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates as number[][][]] : f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][]) : []
      for (const poly of polys)
        for (const ring of poly)
          ring.forEach(([lon, lat], k) => {
            const [x, y] = proj.toCell(lon, lat)
            if (k) g.lineTo(x + 0.5, y + 0.5)
            else g.moveTo(x + 0.5, y + 0.5)
          })
    }
    g.fill('evenodd')
    const px = g.getImageData(0, 0, gw, gh).data
    for (let i = 0; i < gw * gh; i++) if (px[i * 4] > 127) owner[i] = side
  }
  return owner
}

/** 两遍扫描的倒角距离变换（3-4 权重，单位约为格）：src 为 1 的格到最近源格的距离 */
function chamfer(src: Uint8Array, gw: number, gh: number) {
  const INF = 1e9
  const d = new Float32Array(gw * gh)
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF
  const relax = (i: number, j: number, w: number) => {
    if (d[j] + w < d[i]) d[i] = d[j] + w
  }
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x
      if (x > 0) relax(i, i - 1, 3)
      if (y > 0) {
        relax(i, i - gw, 3)
        if (x > 0) relax(i, i - gw - 1, 4)
        if (x < gw - 1) relax(i, i - gw + 1, 4)
      }
    }
  for (let y = gh - 1; y >= 0; y--)
    for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x
      if (x < gw - 1) relax(i, i + 1, 3)
      if (y < gh - 1) {
        relax(i, i + gw, 3)
        if (x < gw - 1) relax(i, i + gw + 1, 4)
        if (x > 0) relax(i, i + gw - 1, 4)
      }
    }
  for (let i = 0; i < d.length; i++) d[i] /= 3
  return d
}

/**
 * 两个关键帧之间的过渡：易手的格按"到推进方原有控制区的距离 ÷（它 + 到后撤方剩余控制区的距离）"决定翻转的时刻，
 * 前线因此从旧位置连续推到新位置；进度 t 时，翻转时刻不超过 t 的格已经易手
 */
function transition(a: Uint8Array, b: Uint8Array, gw: number, gh: number) {
  const idx: number[] = []
  for (let i = 0; i < a.length; i++) if (a[i] && b[i] && a[i] !== b[i]) idx.push(i)
  // 争夺区（3）参与易手，但距离只从两方各自的控制区量起
  const changed = new Uint8Array(a.length)
  for (const i of idx) changed[i] = 1
  const dist = [0, 1, 2, 3].map((side) => {
    if (!side) return new Float32Array(0)
    const src = new Uint8Array(a.length)
    for (let i = 0; i < a.length; i++) if (!changed[i] && a[i] === side) src[i] = 1
    return chamfer(src, gw, gh)
  })
  const at = new Float32Array(idx.length)
  idx.forEach((i, k) => {
    const adv = dist[b[i]][i]
    const ret = dist[a[i]][i]
    at[k] = adv / Math.max(1e-6, adv + ret)
  })
  return { idx: Int32Array.from(idx), at }
}

interface View {
  sec: number
  frame: number
  /** 日期（天，自 1970-01-01 起） */
  day: number
  date: string
  share: [number, number]
}

/** 准备数据与场景，返回逐帧绘制函数 */
async function setup() {
  setLang('zh')
  const [fronts, ops, yalu] = await Promise.all([
    fetch(new URL('./fronts.geojson', import.meta.url)).then((r) => r.json() as Promise<Fronts>),
    fetch(new URL('./ops.json', import.meta.url)).then((r) => r.json() as Promise<Ops>),
    fetch(new URL('./yalu.json', import.meta.url)).then((r) => r.json() as Promise<{ path: [number, number][] }>),
    loadEarthGrid('5m'),
    loadEarthFeatures(),
    loadRegionGrid('korea'),
  ])
  // 时间轴：事件提示与各场战役的日期上停顿
  const sameDay = new Map<string, number>()
  for (const b of ops.battles) sameDay.set(b.start, (sameDay.get(b.start) ?? 0) + 1)
  buildTimeline([...CAPTIONS.map((c) => ({ date: c.date, hold: CAPTION_HOLD })), ...[...sameDay].map(([date, n]) => ({ date, hold: BATTLE_HOLD * n }))])
  const p: WorldParams = { ...DEFAULT_PARAMS, region: 'korea', width: 1200 }
  normalizeParams(p)
  const world = generateWorld(p)
  const proj = regionProjection(p)!
  const gw = world.W
  const gh = world.H

  const { ctx, dpr } = overlayContext()
  ST.dpr = dpr
  const holo = new HoloScene(document.getElementById('stage')!, { palette: 'tactical', exaggeration: 9, labels: false, hud: false, sectionHeight: 4 })
  holo.setPixelRatio(stagePixelRatio())
  holo.setBloom(0.05, 0.08)
  holo.setWorld(world)
  holo.setManual(true)
  const plate = document.createElement('canvas')
  plate.width = 2400
  plate.height = 440
  holo.setHeaderCanvas(plate)
  const pg = plate.getContext('2d')!

  // 关键帧（fronts.geojson 里出现的日期）的控制区与相邻关键帧之间的过渡
  const dates = [...new Set(fronts.features.map((f) => f.properties.date))].sort()
  const keyDays = dates.map(day)
  const keys = dates.map((d) => rasterize(fronts, d, proj, gw, gh))
  const moves = keys.slice(1).map((b, k) => transition(keys[k], b, gw, gh))
  // 片头：控制区自 38 度线向南北两侧铺开，按格心纬度与 38°N 之差排序
  const reveal = new Float32Array(gw * gh)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) reveal[y * gw + x] = Math.min(1, Math.abs(proj.toLonLat(x, y)[1] - 38) / 5.5)
  const owner = new Uint8Array(gw * gh)
  holo.setTerritory(owner, { a: SIDE_A, b: SIDE_B, front: FRONT, fill: 0.68, width: 3.2 })

  // 三维标注：地名与海名贴地，部队直立；行动路径贴地或拱起
  holo.setMarks([
    ...CITIES.map(([name, alt]) => ({ id: `city:${name}`, kind: 'ground' as const, title: name, sub: alt, color: '#ffffff', size: 1.05 })),
    ...SEAS.map(([name, alt]) => ({ id: `sea:${name}`, kind: 'ground' as const, title: name, sub: alt, color: '#ffffff', size: 1.6 })),
    ...ops.units.flatMap((u) =>
      (['arrive', 'leave'] as const).flatMap((k) => {
        const t = noteText(u, k)
        return t ? [{ id: `note:${u.id}:${k}`, kind: 'ground' as const, title: `${fmtDay(day(u[k]!.date))}  ${t}`, color: MARK[u.side], size: 0.62 }] : []
      }),
    ),
    ...ops.units.map((u) => {
      const st = STAND[u.echelon] ?? STAND.division
      return { id: `unit:${u.id}`, kind: 'stand' as const, title: u.name, sub: (u.nameAlt ?? '').toUpperCase(), color: MARK[u.side], size: st.size, height: st.height, shape: SHAPE[u.domain ?? 'land'], shapeSize: st.shape }
    }),
  ])
  holo.setPaths([
    ...ops.arrows.map((a, k) => ({ id: `path:${k}`, pts: a.path.flatMap(([lon, lat]) => proj.toCell(lon, lat)), color: MARK[a.side], kind: a.kind ?? 'ground' })),
    // 部队走过的轨迹：己方颜色的淡细线，不画箭头
    ...ops.units.map((u) => ({ id: `trail:${u.id}`, pts: unitRoute(u).pts.flatMap((q) => proj.toCell(q.lon, q.lat)), color: MARK[u.side], kind: 'ground' as const, head: false, opacity: 0.25 })),
    // 鸭绿江（江口到上游）与志愿军的三处渡江点
    { id: 'yalu', pts: yalu.path.flatMap(([lon, lat]) => proj.toCell(lon, lat)), color: '#ffe3c4', kind: 'ground' as const },
    ...CROSSINGS.map(([from, to], k) => ({ id: `cross:${k}`, pts: [...proj.toCell(...from), ...proj.toCell(...to)], color: MARK.a, kind: 'ground' as const })),
  ])
  const cityCells = CITIES.map(([name, , lon, lat]) => ({ id: `city:${name}`, cell: proj.toCell(lon, lat) }))
  const seaCells = SEAS.map(([name, , lon, lat]) => ({ id: `sea:${name}`, cell: proj.toCell(lon, lat) }))
  const contour: number[] = []
  const [ucx, ucy] = proj.toCell(127.5, 38)
  const view: View = { sec: 0, frame: 0, day: keyDays[0], date: '', share: [0, 0] }
  // 沙盘里的面板：战报、事件提示与图例（各一块离屏画布）
  // 各战报栏的出现时刻：同一天开始的按顺序间隔 BATTLE_HOLD 秒
  const cardAt = ops.battles.map((b, k) => secOf(b.start) + 0.15 + ops.battles.slice(0, k).filter((o) => o.start === b.start).length * BATTLE_HOLD)
  const battleCards = ops.battles.map((b, k) => {
    const cv = document.createElement('canvas')
    const L = battleLayout(cv.getContext('2d')!, b)
    const at = cardAt[k]
    const next = Math.min(...cardAt.filter((t) => t > at))
    const life = Math.min(BATTLE_S, Number.isFinite(next) ? next - at - 0.05 : BATTLE_S)
    return { id: `battle:${b.id}`, cv, L, at, life, cell: proj.toCell(b.lon, b.lat), draw: battleContent(b, k, L) }
  })
  const captionCards = CAPTIONS.map((c, k) => {
    const cv = document.createElement('canvas')
    const g = cv.getContext('2d')!
    g.font = `500 26px ${SANS}`
    const w = Math.max(g.measureText(c.text).width + 56, 380)
    const at = secOf(c.date) + 0.2
    return { id: `caption:${k}`, cv, w, at, life: CAPTION_S, cell: proj.toCell(...(c.where ?? [127.3, 38.3])), draw: captionContent(c.tag, c.text, w) }
  })
  const legend = document.createElement('canvas')
  const legendCell = proj.toCell(130.9, 34.7)
  /** 镜头聚焦：战报与事件出现时，镜头推近到地点（面板立在地点上方），读完再拉回 */
  const focus = [
    ...battleCards.map((c) => ({ at: c.at, life: c.life, cell: c.cell, w: 26, h: (26 * (c.L.h + 8)) / (c.L.w + 8), lift: 9 })),
    ...captionCards.map((c) => {
      const w = (c.w / 560) * 26
      return { at: c.at, life: c.life, cell: c.cell, w, h: (w * 104) / (c.w + 8), lift: 7 }
    }),
  ]
  /** 原始镜头：总览关键帧，聚焦时在面板出现前 1 秒推近、消失后 1 秒拉回；目标点放在面板中部下方 */
  const rawCam = (sec: number) => {
    const s = shotAt(sec)
    let [x, , z] = holo.cellToScene(...proj.toCell(s.lon, s.lat))
    let { dist, tilt, yaw } = s
    let ty = 6
    for (const f of focus) {
      const k = ease(clamp01(Math.min((sec - f.at + 1) / 1, (f.at + f.life + 1 - sec) / 1)))
      if (k <= 0) continue
      const [fx, , fz] = holo.cellToScene(f.cell[0], f.cell[1])
      // 对准面板中心，距离按面板高度定，角度压低到大致正对面板，整块面板都在画面里
      x += (fx + f.w * 0.5 - x) * k
      z += (fz - z) * k
      ty += (f.lift + f.h / 2 - ty) * k
      dist += (Math.max(55, f.h * 2.6 + 30) - dist) * k
      tilt += (24 - tilt) * k
      yaw += (0 - yaw) * k
    }
    return { x, z, ty, dist, tilt, yaw }
  }
  /**
   * 平滑的镜头：前后 1.5 秒内原始镜头的高斯加权平均（13 个采样，σ = 0.55 秒）。
   * 关键帧处的停顿与聚焦的推拉都变得连续；结果只取决于时刻，逐帧录制可复现
   */
  const smoothCam = (sec: number) => {
    const acc = { x: 0, z: 0, ty: 0, dist: 0, tilt: 0, yaw: 0 }
    let wsum = 0
    for (let n = -6; n <= 6; n++) {
      const dt = n * 0.25
      const w = Math.exp(-(dt * dt) / (2 * 0.55 * 0.55))
      const c = rawCam(Math.max(0, sec + dt))
      for (const k of ['x', 'z', 'ty', 'dist', 'tilt', 'yaw'] as const) acc[k] += c[k] * w
      wsum += w
    }
    for (const k of ['x', 'z', 'ty', 'dist', 'tilt', 'yaw'] as const) acc[k] /= wsum
    return acc
  }

  return (i: number) => {
    const sec = i / FPS
    const [f0, f1] = OUTRO.fold
    // 沙盘：搭建时钟、展开半径、线与标注、地板；收起时倒放
    let unfold: number | null
    let lines: number
    let boot: number
    if (sec < f0) {
      const u = span(sec, INTRO.unfold[0], INTRO.unfold[1])
      unfold = u >= 1 ? null : ease(u) * 80
      lines = span(sec, INTRO.unfold[1] - 0.6, INTRO.unfold[1] + 0.6)
      boot = sec - INTRO.boot
    } else {
      unfold = (1 - easeIn(span(sec, f0 + 0.2, f1 - 0.6))) * 80
      lines = 1 - span(sec, f0, f0 + 0.4)
      boot = BOOT_LEN - (sec - f0 - 0.5) * (BOOT_LEN / (f1 - f0 - 0.5))
    }
    const floor = sec < OUTRO.sources - 0.6 ? ease(span(sec, INTRO.floor[0], INTRO.floor[1])) * FLOOR_FULL : (1 - easeIn(span(sec, OUTRO.sources - 0.6, OUTRO.sources + 1.2))) * FLOOR_FULL
    const annotate = sec < f0 ? span(sec, INTRO.unfold[1], INTRO.unfold[1] + 1) : 1 - span(sec, f0, f0 + 0.4)
    holo.setIntro({ unfold, cx: ucx, cy: ucy, lines, boot, floor, annotate })

    const cam = smoothCam(sec)
    // 聚焦面板时镜头压低，后方立牌会压在面板后面：镜头俯角低于 40° 时收起
    holo.setHeaderVisible(cam.tilt > 40)
    // 按镜头远近分层：师及以下的部队，镜头远时只显示地面轮廓与竖线，推近到约 105 以内才刷出番号
    const detail = clamp01((130 - cam.dist) / 25)
    // 控制区：片头自 38 度线铺开；之后按日期在相邻关键帧之间插值；收起时随线熄灭
    const d = dayAt(sec)
    let k = 0
    while (k < keyDays.length - 2 && keyDays[k + 1] <= d) k++
    const t = k + 1 < keyDays.length ? clamp01((d - keyDays[k]) / (keyDays[k + 1] - keyDays[k])) : 0
    owner.set(keys[k])
    if (t > 0) {
      const m = moves[k]
      const next = keys[k + 1]
      for (let n = 0; n < m.idx.length; n++) if (m.at[n] <= t) owner[m.idx[n]] = next[m.idx[n]]
    }
    const grow = sec < f0 ? span(sec, INTRO.territory[0], INTRO.territory[1]) : 1 - span(sec, f0, f0 + 0.5)
    if (grow < 1) for (let n = 0; n < owner.length; n++) if (reveal[n] > grow) owner[n] = 0
    holo.refreshTerritory()
    // 前线光幕：两方交界的轮廓上竖起发光的幕
    holo.setCurtain(grow > 0 ? frontContour(owner, gw, gh, contour) : [], FRONT, 2.6 * Math.min(1, grow))
    // 地名、海名、部队与行动路径
    const show = sec < f0 ? span(sec, INTRO.territory[0], INTRO.territory[1] + 0.6) : 1 - span(sec, f0, f0 + 0.4)
    const live = sec >= INTRO.territory[1] && sec < f0
    holo.updateMarks([
      ...[...cityCells, ...seaCells].map((c, n) => ({ id: c.id, cx: c.cell[0], cy: c.cell[1], reveal: clamp01((show - (n / (cityCells.length + seaCells.length)) * 0.4) / 0.6) })),
      ...(live
        ? ops.units.flatMap((u) => {
            const at = unitAt(u, d)
            if (!at) return []
            let [cx, cy] = proj.toCell(at.lon, at.lat)
            if ((u.domain ?? 'land') === 'land') [cx, cy] = snapToOwn(owner, gw, gh, cx, cy, u.side === 'a' ? 1 : 2)
            const { start, end } = unitRoute(u)
            const appear = clamp01((sec - Math.max(INTRO.territory[1], secOfDay(start))) / 0.6)
            const vanish = clamp01((end - d) / 2)
            const minor = u.echelon !== 'army' && u.echelon !== 'corps'
            const out = [{ id: `unit:${u.id}`, cx, cy, reveal: Math.min(appear, vanish, minor ? 0.39 + 0.61 * detail : 1) }]
            // 说明：进入、离开的那一刻起显示约 3.5 秒，贴地放在部队南侧
            for (const k of ['arrive', 'leave'] as const) {
              const e = u[k]
              if (!e || !noteText(u, k)) continue
              const t = sec - secOf(e.date)
              if (t < 0 || t > 3.5) continue
              out.push({ id: `note:${u.id}:${k}`, cx, cy: cy + 2.2 * (gh / 100), reveal: Math.min(clamp01(t / 0.5), clamp01((3.5 - t) / 0.3)) })
            }
            return out
          })
        : []),
    ])
    // 跨过鸭绿江：江线自江口向上游点亮，三处渡江箭头随后画出，停留到事件提示结束后熄灭
    const yt = sec - secOf('1950-10-19')
    const yaluState = { grow: easeOut(clamp01(yt / 1.4)), gone: clamp01((yt - 4.6) / 0.6) }
    const crossState = { grow: easeOut(clamp01((yt - 1.0) / 0.9)), gone: clamp01((yt - 4.6) / 0.6) }
    holo.updatePaths(
      live
        ? [
            ...ops.arrows.map((a, k) => ({ id: `path:${k}`, ...arrowPhase(d, a) })),
            ...ops.units.flatMap((u) => {
              const at = unitAt(u, d)
              return at ? [{ id: `trail:${u.id}`, grow: at.travelled, gone: 0 }] : []
            }),
            { id: 'yalu', ...yaluState },
            ...CROSSINGS.map((_, k) => ({ id: `cross:${k}`, ...crossState })),
          ]
        : [],
    )
    let a = 0
    let b = 0
    for (let n = 0; n < owner.length; n++) {
      if (owner[n] === 1) a++
      else if (owner[n] === 2) b++
    }

    const tr = (cam.tilt * Math.PI) / 180
    const yr = (cam.yaw * Math.PI) / 180
    holo.setCamera([cam.x + cam.dist * Math.cos(tr) * Math.sin(yr), cam.dist * Math.sin(tr), cam.z + cam.dist * Math.cos(tr) * Math.cos(yr)], [cam.x, cam.ty, cam.z])
    // 面板：战报与事件提示立在地点上方的竖线顶端，略向后仰；图例平放在东南的海面上
    for (const c of battleCards) {
      const age = sec - c.at
      const on = age >= 0 && age <= c.life
      if (on) drawCard(c.cv, c.L.w, c.L.h, age, c.life, i * 11, c.draw)
      holo.setPanel(c.id, c.cv, { cx: c.cell[0], cy: c.cell[1], lift: 9, width: 26, lean: 0.18, pole: true, visible: on })
      if (on) holo.refreshPanel(c.id)
    }
    for (const c of captionCards) {
      const age = sec - c.at
      const on = age >= 0 && age <= c.life
      if (on) drawCard(c.cv, c.w, 96, age, c.life, i * 7, c.draw)
      holo.setPanel(c.id, c.cv, { cx: c.cell[0], cy: c.cell[1], lift: 7, width: (c.w / 560) * 26, lean: 0.18, pole: true, visible: on })
      if (on) holo.refreshPanel(c.id)
    }
    const lAge = sec - INTRO.territory[1]
    const lLife = OUTRO.fold[0] + 0.3 - INTRO.territory[1]
    const lOn = lAge >= 0 && lAge <= lLife
    if (lOn && (lAge < 1 || lLife - lAge < 1)) drawCard(legend, 420, 166, lAge, lLife, i * 3, legendContent)
    holo.setPanel('legend', legend, { cx: legendCell[0], cy: legendCell[1], lift: 0.2, width: 22, lean: Math.PI / 2, visible: lOn })
    if (lOn && (lAge < 1 || lLife - lAge < 1)) holo.refreshPanel('legend')
    Object.assign(view, { sec, frame: i, day: d, date: fmtDay(d), share: a + b ? [a / (a + b), b / (a + b)] : [0, 0] })
    drawPlate(pg, view)
    holo.refreshHeader()
    holo.renderFrame()
    drawOverlay(ctx, view)
  }
}

function drawOverlay(ctx: CanvasRenderingContext2D, v: View) {
  ctx.clearRect(0, 0, W, H)
  ctx.globalAlpha = 1
  drawTitleCard(ctx, ST, v.sec, v.frame, INTRO.title, { kicker: 'WAR TO RESIST US AGGRESSION AND AID KOREA · 1950 — 1953', title: '抗美援朝战争', subtitle: '1950.10.19 志愿军入朝参战 — 1953.07.27 朝鲜停战协定签字' })
  const [f0] = OUTRO.fold
  const statusAge = v.sec < f0 ? v.sec - INTRO.status : 0.6 - (v.sec - f0) * 1.5
  drawStatusBar(
    ctx,
    ST,
    [
      ['SESSION STATUS', 'ONLINE', 150],
      ['OPERATION', 'CPV WAR REPORT', 180],
      ['PROJECTION', 'LCC 33°N / 43°N', 190],
      ['DATE', v.date, 140],
      ['FRONT', 'SCHEMATIC', 140],
      ['SOURCE', 'USMA ATLAS · US ARMY CMH', 260],
    ],
    72,
    26,
    statusAge,
  )
  drawSources(ctx, v)
}

/** 行动路径在日期上的进度：start–end 之间画出，之后停留约 3 周，再在 5 天内从尾部收回 */
function arrowPhase(d: number, a: Arrow) {
  const s = day(a.start)
  const e = Math.max(day(a.end), s + 1)
  if (d < s) return { grow: 0, gone: 0 }
  return { grow: clamp01((d - s) / (e - s)), gone: clamp01((d - e - 21) / 5) }
}

/**
 * 进入、离开说明中上屏的部分：去掉"未核实""据来源"一类的考证括注与分句，半角逗号换成全角。
 * 只给兵团、军级以上的部队显示（师以下同时进出太多，交给轨迹表现）；开战当天就在的、
 * 停战时仍在的、说明只剩考证文字的不显示
 */
function noteText(u: Unit, k: 'arrive' | 'leave') {
  const e = u[k]
  if (!e || (u.echelon !== 'army' && u.echelon !== 'corps')) return ''
  if (k === 'arrive' && day(e.date) <= day('1950-06-26')) return ''
  if (k === 'leave' && day(e.date) >= day('1953-07-27')) return ''
  const t = e.note
    .replace(/[（(][^）)]*[）)]/g, '')
    .split('；')
    .filter((x) => !/未核实|来源|示意|源称/.test(x))
    .join('；')
    .replaceAll(',', '，')
    .trim()
  return /^(停战|开战时驻地)?$/.test(t) ? '' : t
}

/**
 * 部队的有效路线：来处（进入日期）→ 各个位置 → 去处（离开日期），按日期排列。
 * 可见时段从进入到离开；没有进入、离开记载的，按首末位置的日期
 */
function unitRoute(u: Unit) {
  const pts = u.track.map((t) => ({ d: day(t.date), lon: t.lon, lat: t.lat }))
  if (u.arrive?.from) pts.unshift({ d: day(u.arrive.date), lon: u.arrive.from[0], lat: u.arrive.from[1] })
  if (u.leave?.to) pts.push({ d: day(u.leave.date), lon: u.leave.to[0], lat: u.leave.to[1] })
  const start = Math.min(pts[0].d, u.arrive ? day(u.arrive.date) : Infinity)
  // 停战时仍在朝鲜的（离开日期在停战当天或之后）留到片尾
  const end = u.leave && day(u.leave.date) >= day('1953-07-27') ? Infinity : Math.max(pts[pts.length - 1].d, u.leave ? day(u.leave.date) : -Infinity)
  return { pts, start, end }
}

/** 部队在日期 d 的位置（路线上按日期线性插值）与走过的比例（按路线长度）；不在可见时段时为 null */
function unitAt(u: Unit, d: number): { lon: number; lat: number; travelled: number } | null {
  const { pts, start, end } = unitRoute(u)
  if (d < start || d > end) return null
  const len = [0]
  for (let k = 1; k < pts.length; k++) len.push(len[k - 1] + Math.hypot((pts[k].lon - pts[k - 1].lon) * Math.cos((pts[k].lat * Math.PI) / 180), pts[k].lat - pts[k - 1].lat))
  const total = len[len.length - 1] || 1
  if (d <= pts[0].d) return { lon: pts[0].lon, lat: pts[0].lat, travelled: 0 }
  for (let k = 1; k < pts.length; k++) {
    if (d <= pts[k].d) {
      const f = pts[k].d > pts[k - 1].d ? (d - pts[k - 1].d) / (pts[k].d - pts[k - 1].d) : 1
      return {
        lon: pts[k - 1].lon + (pts[k].lon - pts[k - 1].lon) * f,
        lat: pts[k - 1].lat + (pts[k].lat - pts[k - 1].lat) * f,
        travelled: (len[k - 1] + (len[k] - len[k - 1]) * f) / total,
      }
    }
  }
  const last = pts[pts.length - 1]
  return { lon: last.lon, lat: last.lat, travelled: 1 }
}

/**
 * 陆军的位置必须落在己方控制区：所在格子不是己方（1 或 2）时，向外逐圈找最近的己方格子（最多 60 格）
 */
function snapToOwn(owner: Uint8Array, gw: number, gh: number, cx: number, cy: number, side: number): [number, number] {
  const x0 = Math.round(cx)
  const y0 = Math.round(cy)
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : owner[y * gw + x])
  if (at(x0, y0) === side) return [cx, cy]
  for (let r = 1; r <= 60; r++) {
    let best: [number, number] | null = null
    let bd = Infinity
    for (let dx = -r; dx <= r; dx++)
      for (const dy of Math.abs(dx) === r ? Array.from({ length: 2 * r + 1 }, (_, k) => k - r) : [-r, r]) {
        if (at(x0 + dx, y0 + dy) !== side) continue
        const dd = dx * dx + dy * dy
        if (dd < bd) {
          bd = dd
          best = [x0 + dx, y0 + dy]
        }
      }
    if (best) return best
  }
  return [cx, cy]
}

/** 部队的直立标注：按编制定竖线高度、字高与地面轮廓大小；陆军方形、空军三角、海军圆 */
const STAND: Record<Unit['echelon'], { height: number; size: number; shape: number }> = {
  army: { height: 7.5, size: 1.25, shape: 1.1 },
  corps: { height: 5.8, size: 1.0, shape: 0.9 },
  division: { height: 4.2, size: 0.8, shape: 0.7 },
  brigade: { height: 3.6, size: 0.7, shape: 0.6 },
  regiment: { height: 3.2, size: 0.65, shape: 0.55 },
}
const SHAPE = { land: 'square', air: 'triangle', naval: 'circle' } as const
/**
 * 志愿军跨过鸭绿江的三处渡江点（1950-10-19 起，据军事科学院《抗美援朝战争史》）：
 * 安东—新义州、长甸河口—朔州一带、辑安—满浦，[起点, 终点] 经纬度，示意
 */
const CROSSINGS: [[number, number], [number, number]][] = [
  [[124.39, 40.16], [124.45, 39.95]],
  [[124.86, 40.56], [124.92, 40.35]],
  [[126.19, 41.13], [126.3, 40.92]],
]
/** 海名与地名（纸面标注） */
const SEAS: [string, string, number, number][] = [
  ['黄海', 'YELLOW SEA', 124.4, 36.6],
  ['日本海', 'SEA OF JAPAN', 131.0, 39.6],
  ['朝鲜海峡', 'KOREA STRAIT', 129.0, 34.4],
]

/** 按宽度折行（逐字，适合中文） */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number) {
  const out: string[] = []
  let line = ''
  for (const ch of text) {
    if (g.measureText(line + ch).width > maxW && line) {
      out.push(line)
      line = ch
    } else line += ch
  }
  if (line) out.push(line)
  return out
}

const BATTLE_S = 5.2
/** 面板画布的像素比：面板在镜头推近时占画面三分之一左右，按 2 倍画足够清晰 */
const CARD_DPR = 2

/**
 * 一张面板（战报、事件提示、图例）：在离屏画布上用信息栏的动效画出（竖线先出、内容横向刷开），
 * 画布按 CARD_DPR 倍分配像素；content 在 (0, 0, w, h) 的局部坐标里画内容
 */
function drawCard(cv: HTMLCanvasElement, w: number, h: number, age: number, life: number, seed: number, content: (g: CanvasRenderingContext2D) => void) {
  const pw = Math.ceil((w + 8) * CARD_DPR)
  const ph = Math.ceil((h + 8) * CARD_DPR)
  if (cv.width !== pw || cv.height !== ph) {
    cv.width = pw
    cv.height = ph
  }
  const g = cv.getContext('2d')!
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, pw, ph)
  g.setTransform(CARD_DPR, 0, 0, CARD_DPR, 4 * CARD_DPR, 4 * CARD_DPR)
  drawPanel(g, { ...ST, dpr: CARD_DPR }, { gx: 0, y: 0, w, h, dir: 1, ext: 0, phase: panelPhase(age, life), seed, fill: 'rgba(5, 10, 18, 0.82)' }, content)
}

/** 战报栏的高度（按内容折行算出） */
function battleLayout(g: CanvasRenderingContext2D, b: Battle) {
  const w = 560
  const pad = 22
  g.font = `400 16px ${SANS}`
  const sum = wrap(g, b.summary, w - pad * 2)
  g.font = `400 15px ${SANS}`
  const outA = wrap(g, `中、朝方表述：${b.outcome.a}`, w - pad * 2)
  const outB = wrap(g, `美、韩方表述：${b.outcome.b}`, w - pad * 2)
  g.font = `500 15px ${SANS}`
  const forces = { a: wrap(g, b.forces.a, w - pad * 2 - 20), b: wrap(g, b.forces.b, w - pad * 2 - 20) }
  const fl = forces.a.length + forces.b.length
  return { w, pad, sum, outA, outB, forces, h: 106 + fl * 21 + 12 + sum.length * 24 + (outA.length + outB.length) * 21 + 20 }
}

/**
 * 战报栏的内容：标题行（BATTLE、起止日期、编号），战役名（带光晕）与各方称呼，两方参战部队（色块区分），
 * 经过简述，以及两方对结果的表述（并列）
 */
function battleContent(b: Battle, index: number, L: ReturnType<typeof battleLayout>) {
  return (g: CanvasRenderingContext2D) => {
    const x = L.pad
    let ly = 26
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    g.fillStyle = ST.accent
    g.font = `400 14px ${MONO}`
    g.fillText(`BATTLE  |  ${fmtDay(day(b.start))} — ${fmtDay(day(b.end)).slice(5)}`, x, ly)
    g.textAlign = 'right'
    g.fillStyle = DIM
    g.fillText(`B-${String(index + 1).padStart(2, '0')}`, L.w - 18, ly)
    g.fillStyle = LINE
    g.fillRect(x, ly + 12, L.w - L.pad * 2, 1)
    g.textAlign = 'left'
    ly += 50
    g.save()
    g.shadowColor = 'rgba(255, 255, 255, 0.55)'
    g.shadowBlur = 10
    g.fillStyle = '#ffffff'
    g.font = `700 28px ${SANS}`
    g.fillText(b.name, x, ly)
    g.restore()
    ly += 22
    g.fillStyle = DIM
    g.font = `400 13px ${MONO}`
    g.fillText([b.names.ko, b.names.en].filter(Boolean).join('  ·  '), x, ly)
    ly += 28
    for (const side of ['a', 'b'] as const) {
      g.fillStyle = MARK[side]
      g.fillRect(x, ly - 10, 12, 12)
      g.fillStyle = INK
      g.font = `500 15px ${SANS}`
      for (const l of L.forces[side]) {
        g.fillText(l, x + 20, ly)
        ly += 21
      }
    }
    ly += 6
    g.fillStyle = 'rgba(214, 226, 240, 0.9)'
    g.font = `400 16px ${SANS}`
    for (const l of L.sum) {
      g.fillText(l, x, ly)
      ly += 24
    }
    ly += 4
    g.font = `400 15px ${SANS}`
    for (const [lines, side] of [
      [L.outA, 'a'],
      [L.outB, 'b'],
    ] as const) {
      g.fillStyle = MARK[side]
      for (const l of lines) {
        g.fillText(l, x, ly)
        ly += 21
      }
    }
  }
}

/** 事件提示的内容：标题行（EVENT 与日期）与一行正文 */
function captionContent(tag: string, text: string, w: number) {
  return (g: CanvasRenderingContext2D) => {
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    g.fillStyle = ST.accent
    g.font = `400 15px ${MONO}`
    g.fillText(`EVENT  |  ${tag}`, 22, 26)
    g.fillStyle = LINE
    g.fillRect(22, 38, w - 40, 1)
    g.save()
    g.shadowColor = 'rgba(255, 255, 255, 0.5)'
    g.shadowBlur = 8
    g.fillStyle = '#ffffff'
    g.font = `500 26px ${SANS}`
    g.fillText(text, 22, 76)
    g.restore()
  }
}

/** 图例的内容：两方的颜色与名称、争夺区的斜纹，以及"前线为示意"的说明 */
function legendContent(g: CanvasRenderingContext2D) {
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillStyle = ST.accent
  g.font = `400 14px ${MONO}`
  g.fillText('LEGEND  |  控制区', 20, 22)
  ;[SIDE_A, SIDE_B].forEach((c, k) => {
    const ly = 52 + k * 30
    g.fillStyle = c
    g.fillRect(20, ly - 7, 26, 14)
    g.fillStyle = INK
    g.font = `500 18px ${SANS}`
    g.fillText(SIDES[k], 58, ly)
  })
  const ly = 112
  g.save()
  g.beginPath()
  g.rect(20, ly - 7, 26, 14)
  g.clip()
  g.fillStyle = 'rgba(160, 175, 180, 0.6)'
  g.fillRect(20, ly - 7, 26, 14)
  g.strokeStyle = FRONT
  g.lineWidth = 2
  for (let sx = -14; sx < 30; sx += 6) {
    g.beginPath()
    g.moveTo(20 + sx, ly + 7)
    g.lineTo(20 + sx + 14, ly - 7)
    g.stroke()
  }
  g.restore()
  g.fillStyle = INK
  g.font = `500 18px ${SANS}`
  g.fillText('争夺或不确定区域（示意）', 58, ly)
  g.fillStyle = DIM
  g.font = `400 14px ${SANS}`
  g.fillText('前线为关键时间点的示意，其间按日期插值', 20, 146)
}

/** 片尾：数据来源与说明 */
function drawSources(ctx: CanvasRenderingContext2D, v: View) {
  const age = v.sec - OUTRO.sources
  if (age < 0) return
  const w = 980
  const h = 416
  const gx = (W - w) / 2
  const y = (H - h) / 2
  const lines = [
    '前线：据美国西点军校历史系地图集数字化（美国政府作品，公有领域），参照美国陆军军事史中心官方战史',
    '停战线：Natural Earth 的韩朝边界，与军事分界线一致（公有领域）',
    '战役划分与名称：军事科学院《抗美援朝战争史》等中国官方战史（仅作事实依据）',
    '前线关键帧之间按日期插值，部队位置与行军方向据同一地图集，均为示意',
    '事件日期：美国陆军军事史中心官方战史，并对照中、韩官方记述；各方表述不同之处并列',
    '地形：NOAA ETOPO 2022；海岸线：Natural Earth',
  ]
  drawPanel(ctx, ST, { gx, y, w, h, dir: 1, ext: 50, phase: panelPhase(age, 1e9), seed: v.frame * 13, fill: 'rgba(5, 10, 18, 0.78)' }, (g) => {
    const x = gx + 40
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    g.fillStyle = ST.accent
    g.font = `400 15px ${MONO}`
    g.fillText('DATA SOURCES  |  数据说明', x, y + 36)
    g.fillStyle = LINE
    g.fillRect(x, y + 50, w - 70, 1)
    g.fillStyle = INK
    g.font = `700 40px ${SANS}`
    g.fillText('抗美援朝战争 1950 — 1953', x, y + 110)
    g.fillStyle = DIM
    g.font = `400 18px ${MONO}`
    g.fillText('WAR TO RESIST US AGGRESSION AND AID KOREA', x, y + 146)
    g.fillStyle = LINE
    g.fillRect(x, y + 172, w - 70, 1)
    g.font = `400 17px ${SANS}`
    g.fillStyle = DIM
    lines.forEach((l, k) => g.fillText(l, x, y + 212 + k * 36))
  })
}

/** 沙盘后方的立牌：标题、日期与两方控制区占半岛面积的比例条 */
function drawPlate(g: CanvasRenderingContext2D, v: View) {
  const CW = 2400
  const CH = 440
  g.clearRect(0, 0, CW, CH)
  g.textBaseline = 'alphabetic'
  g.textAlign = 'left'
  g.fillStyle = INK
  g.font = `700 64px "Archivo", sans-serif`
  g.fontStretch = 'expanded'
  g.fillText('KOREAN PENINSULA', 60, 76)
  g.fontStretch = 'normal'
  g.fillStyle = DIM
  g.font = `500 28px ${SANS}`
  g.fillText('抗美援朝战争 · 1950 — 1953 · 控制区占半岛面积的比例（示意）', 62, 118)
  g.textAlign = 'right'
  g.fillStyle = DIM
  g.font = `400 22px ${MONO}`
  g.fillText('DATE', CW - 60, 44)
  g.fillStyle = INK
  g.font = `400 38px ${MONO}`
  g.fillText(v.date, CW - 60, 90)
  const [a, b] = v.share
  if (a + b <= 0) return
  const x0 = 60
  const x1 = CW - 60
  const y0 = 200
  const bh = 90
  const mid = x0 + (x1 - x0) * a
  g.fillStyle = SIDE_A
  g.globalAlpha = 0.75
  g.fillRect(x0, y0, mid - x0, bh)
  g.fillStyle = SIDE_B
  g.fillRect(mid, y0, x1 - mid, bh)
  g.globalAlpha = 1
  g.fillStyle = FRONT
  g.fillRect(mid - 2, y0 - 16, 4, bh + 32)
  g.font = `700 40px ${MONO}`
  g.textAlign = 'left'
  g.fillStyle = INK
  g.fillText(`${(a * 100).toFixed(0)}%`, x0, y0 + bh + 64)
  g.font = `500 26px ${SANS}`
  g.fillStyle = DIM
  g.fillText(SIDES[0], x0 + 110, y0 + bh + 62)
  g.textAlign = 'right'
  g.font = `700 40px ${MONO}`
  g.fillStyle = INK
  g.fillText(`${(b * 100).toFixed(0)}%`, x1, y0 + bh + 64)
  g.font = `500 26px ${SANS}`
  g.fillStyle = DIM
  g.fillText(SIDES[1], x1 - 110, y0 + bh + 62)
}

runVideo({ fps: FPS, duration: () => DURATION, setup, label: dateAt })
