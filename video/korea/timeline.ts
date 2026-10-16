/**
 * 《抗美援朝战争》战报式沙盘的时间轴：片头之后日期在片中连续推进——按 PACE 的速度推进，
 * 每场战役、每条事件提示的日期上停顿一下，留出读战报的时间（buildTimeline 按事件生成）。
 * 前线（fronts.geojson）、部队与行军方向（ops.json）都按日期取值
 */
import { clamp01, ease } from '../shared/motion'

export const FPS = 30

/** 片头（秒）：地板铺开、标题、沙盘搭建、地图展开、控制区与前线出现 */
export const INTRO = { floor: [0, 2.4], title: [0.15, 2.9], boot: 2.4, unfold: [3.2, 6.6], territory: [6.4, 7.6], status: 6.8, body: 7.2 } as const
/** 日期开始推进的时刻 */
export const T0 = 8.4

const DAY = 86400000
export const day = (d: string) => Date.parse(d) / DAY

/**
 * 推进速度：自该日起每秒推进的天数。开战到志愿军入朝快速交代，志愿军入朝后放慢，停战谈判开始后的阵地战加快
 */
const PACE: [string, number][] = [
  ['1950-06-25', 16],
  ['1950-10-19', 9],
  ['1951-07-10', 55],
]
const FIRST = '1950-06-25'
const LAST = '1953-07-27'

/** 日期锚点：[片中秒数, 日期（天）]；同一日期的相邻两个锚点之间是停顿 */
let ANCHORS: [number, number][] = []
export let T_END = 0
export let OUTRO = { fold: [0, 0], sources: 0 } as { fold: [number, number]; sources: number }
export let DURATION = 0
/** 镜头关键帧（取决于时间轴，buildTimeline 之后重算） */
let shots: Shot[] | null = null

/**
 * 按事件生成时间轴：各事件日期上停顿 hold 秒（同一天的取最长），其间按 PACE 匀速推进（锚点之间缓入缓出）
 */
export function buildTimeline(holds: { date: string; hold: number }[]) {
  const stop = new Map<number, number>()
  for (const h of holds) stop.set(day(h.date), Math.max(stop.get(day(h.date)) ?? 0, h.hold))
  const keys = new Set<number>([day(FIRST), day(LAST), ...PACE.map(([d]) => day(d)), ...stop.keys()])
  const sorted = [...keys].filter((d) => d >= day(FIRST) && d <= day(LAST)).sort((a, b) => a - b)
  const pace = (d: number) => {
    let v = PACE[0][1]
    for (const [k, s] of PACE) if (d >= day(k)) v = s
    return v
  }
  ANCHORS = []
  let t = T0 + 1.5
  sorted.forEach((d, k) => {
    if (k) t += (d - sorted[k - 1]) / pace(sorted[k - 1])
    ANCHORS.push([t, d])
    t += stop.get(d) ?? 0
    ANCHORS.push([t, d])
  })
  T_END = t + 1
  OUTRO = { fold: [T_END, T_END + 3], sources: T_END + 2.8 }
  DURATION = OUTRO.sources + 6
  shots = null
}

/** 第 sec 秒的日期（天，自 1970-01-01 起，可带小数）：锚点之间缓入缓出 */
export function dayAt(sec: number) {
  if (sec <= ANCHORS[0][0]) return ANCHORS[0][1]
  for (let k = 1; k < ANCHORS.length; k++) {
    const [s1, d1] = ANCHORS[k]
    if (sec <= s1) {
      const [s0, d0] = ANCHORS[k - 1]
      return d0 + (d1 - d0) * ease(clamp01((sec - s0) / (s1 - s0)))
    }
  }
  return ANCHORS[ANCHORS.length - 1][1]
}

/** 日期 → 片中第一次到达它的时刻（秒） */
export const secOf = (date: string) => secOfDay(day(date))

/** 日期（天）→ 片中第一次到达它的时刻（秒） */
export function secOfDay(d: number) {
  for (let k = 1; k < ANCHORS.length; k++) {
    const [s0, d0] = ANCHORS[k - 1]
    const [s1, d1] = ANCHORS[k]
    if (d <= d1) {
      if (d1 === d0) return s0
      // 缓入缓出的反函数：二分
      let lo = 0
      let hi = 1
      for (let n = 0; n < 30; n++) {
        const m = (lo + hi) / 2
        if (d0 + (d1 - d0) * ease(m) < d) lo = m
        else hi = m
      }
      return s0 + (s1 - s0) * lo
    }
  }
  return T_END
}

/** 日期（天）显示为 YYYY.MM.DD */
export function fmtDay(d: number) {
  const t = new Date(Math.floor(d + 1e-6) * DAY)
  return `${t.getUTCFullYear()}.${String(t.getUTCMonth() + 1).padStart(2, '0')}.${String(t.getUTCDate()).padStart(2, '0')}`
}
export const dateAt = (sec: number) => fmtDay(dayAt(sec))

/**
 * 简短的事件提示（重要战役另有战报栏，见 ops.json）：叙述以中国官方战史的口径为主线，日期与事实可核实
 * （军事科学院《抗美援朝战争史》、美国陆军军事史中心官方战史）
 */
export interface Caption {
  date: string
  tag: string
  text: string
  where?: [number, number]
}
export const CAPTIONS: Caption[] = [
  { date: '1950-06-25', tag: '1950.06.25', text: '朝鲜内战爆发', where: [127.0, 37.95] },
  { date: '1950-06-27', tag: '1950.06.27', text: '美国宣布武装干涉朝鲜内战，并派第七舰队进入台湾海峡' },
  { date: '1950-10-19', tag: '1950.10.19', text: '中国人民志愿军跨过鸭绿江，入朝参战', where: [124.4, 40.1] },
  { date: '1951-07-10', tag: '1951.07.10', text: '停战谈判在开城开始，此后转入阵地战', where: [126.55, 37.97] },
  { date: '1953-07-27', tag: '1953.07.27', text: '朝鲜停战协定在板门店签字，划定军事分界线', where: [126.68, 37.96] },
]
export const CAPTION_S = 3.6
/** 事件提示与战报在日期上的停顿（秒） */
export const CAPTION_HOLD = 3
export const BATTLE_HOLD = 4

buildTimeline(CAPTIONS.map((c) => ({ date: c.date, hold: CAPTION_HOLD })))

/** 镜头关键帧：总览为主，随各阶段的主要战场移动；战报与事件出现时的推近见录制页的聚焦 */
interface Shot {
  at: number
  lon: number
  lat: number
  dist: number
  tilt: number
  yaw: number
}
function getShots(): Shot[] {
  return (shots ??= [
    { at: 0, lon: 127.5, lat: 37.5, dist: 230, tilt: 34, yaw: -38 },
    { at: INTRO.boot, lon: 127.5, lat: 37.5, dist: 226, tilt: 35, yaw: -36 },
    { at: T0, lon: 127.4, lat: 38.2, dist: 165, tilt: 58, yaw: -8 },
    { at: secOf('1950-09-10'), lon: 128.2, lat: 36.4, dist: 140, tilt: 56, yaw: 6 },
    { at: secOf('1950-10-19'), lon: 126.8, lat: 39.4, dist: 150, tilt: 56, yaw: -4 },
    { at: secOf('1951-01-24'), lon: 127.3, lat: 38.0, dist: 150, tilt: 56, yaw: 6 },
    { at: secOf('1951-07-10'), lon: 127.4, lat: 38.3, dist: 140, tilt: 56, yaw: -4 },
    { at: T_END, lon: 127.5, lat: 38.2, dist: 170, tilt: 60, yaw: 0 },
    { at: T_END + 20, lon: 127.5, lat: 38.2, dist: 185, tilt: 66, yaw: -4 },
  ])
}

/** 第 sec 秒的镜头（关键帧之间缓动插值；录制页另做时间平滑） */
export function shotAt(sec: number): Omit<Shot, 'at'> {
  const S = getShots()
  let k = 0
  while (k < S.length - 2 && S[k + 1].at <= sec) k++
  const a = S[k]
  const b = S[k + 1]
  const t = ease(clamp01((sec - a.at) / (b.at - a.at)))
  const mix = (p: number, q: number) => p + (q - p) * t
  return { lon: mix(a.lon, b.lon), lat: mix(a.lat, b.lat), dist: mix(a.dist, b.dist), tilt: mix(a.tilt, b.tilt), yaw: mix(a.yaw, b.yaw) }
}
