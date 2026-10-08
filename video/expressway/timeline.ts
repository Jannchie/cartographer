/**
 * 《中国高速公路网》的时间轴（3 分钟）：片头标题、沙盘搭建与展开、年份推进、镜头路径、事件提示与片尾收起。
 * 录制页（main.ts）与配乐的对齐时刻（cues.ts）都从这里取。镜头的目标点与事件地点用经纬度给出，录制页换算成场景坐标。
 */
import { clamp01, ease, span } from '../shared/motion'

export const FPS = 30
export const DURATION = 180
export const FRAMES = FPS * DURATION

/** 演进（年份推进）的起止（秒） */
export const T_START = 10.5
export const T_END = 163
export const YEAR_FROM = 1988
export const YEAR_TO = 2026


/** 第 sec 秒的年份（小数）：片头停在 1988 年初，片尾停在 2025 年底 */
export function yearAt(sec: number) {
  return YEAR_FROM + (YEAR_TO - YEAR_FROM) * span(sec, T_START, T_END)
}

/** 年份 → 出现的时刻（秒） */
export const secOfYear = (year: number) => T_START + ((year - YEAR_FROM) / (YEAR_TO - YEAR_FROM)) * (T_END - T_START)

/**
 * 片头（秒）：
 * - floor：地板底纹自中心逐块铺开
 * - title：标题故障闪现、停留、故障消失
 * - boot：沙盘的搭建时钟从这一刻起走（图框、刻度、线框盒与辅助线逐段画出，时刻表见全息沙盘的 BOOT）
 * - unfold：地图以方块逐片浮现的方式从中部向外展开
 * - lines：海岸、界线与地名出现；neon：国界像霓虹灯管通电一样闪着亮起
 * - status：顶部状态栏刷出；body：左下的年份与里程读数刷出
 */
export const INTRO = { floor: [0, 2.8], title: [0.15, 2.7], boot: 2.5, unfold: [3.3, 8.1], lines: [7.4, 9], neon: [7.1, 8.5], status: 7.6, body: 8.4 } as const

/**
 * 片尾（秒）：fold 为沙盘收起（路网与界线先熄灭，地图逐片收回，图框与线框盒倒着拆掉），
 * neon 为国界闪着熄灭，floor 为地板底纹由外向内逐块收回，sources 为数据说明刷出的时刻
 */
export const OUTRO = { fold: [168.6, 172], neon: [168.6, 169.5], floor: [171, 172.8], sources: 171.4 } as const


/** 镜头关键帧：目标点（经纬度）、距离（场景单位，地图宽 100）、俯角与方位角（度） */
interface Shot {
  at: number
  lon: number
  lat: number
  dist: number
  tilt: number
  yaw: number
}
const SHOTS: Shot[] = [
  // 片头：从斜侧方低角度看着线框盒逐段搭起，再一路抬升、转正，地图展开时地形的隆起看得见
  { at: 0, lon: 104, lat: 32, dist: 245, tilt: 34, yaw: -42 },
  { at: INTRO.boot, lon: 104, lat: 32, dist: 240, tilt: 35, yaw: -40 },
  // 演进：目标点偏北、距离留足，后方立牌上的里程曲线留在画面上方
  { at: T_START, lon: 105, lat: 39.5, dist: 204, tilt: 60, yaw: -12 },
  { at: secOfYear(1993), lon: 116, lat: 41.5, dist: 148, tilt: 55, yaw: 4 },
  { at: secOfYear(1999), lon: 114, lat: 39.5, dist: 159, tilt: 56, yaw: 14 },
  { at: secOfYear(2004), lon: 109, lat: 37.5, dist: 170, tilt: 56, yaw: -4 },
  { at: secOfYear(2009), lon: 104, lat: 40.5, dist: 204, tilt: 59, yaw: -18 },
  { at: secOfYear(2014), lon: 104, lat: 38.5, dist: 175, tilt: 55, yaw: -8 },
  { at: secOfYear(2018), lon: 98, lat: 42.5, dist: 182, tilt: 55, yaw: -20 },
  { at: secOfYear(2022), lon: 104, lat: 40.5, dist: 204, tilt: 59, yaw: 12 },
  { at: T_END, lon: 104, lat: 40.5, dist: 208, tilt: 61, yaw: 2 },
  { at: DURATION, lon: 104, lat: 34, dist: 200, tilt: 70, yaw: -6 },
]

/** 第 sec 秒的镜头：关键帧之间缓动插值 */
export function shotAt(sec: number): Omit<Shot, 'at'> {
  let k = 0
  while (k < SHOTS.length - 2 && SHOTS[k + 1].at <= sec) k++
  const a = SHOTS[k]
  const b = SHOTS[k + 1]
  const t = ease(clamp01((sec - a.at) / (b.at - a.at)))
  const mix = (p: number, q: number) => p + (q - p) * t
  return { lon: mix(a.lon, b.lon), lat: mix(a.lat, b.lat), dist: mix(a.dist, b.dist), tilt: mix(a.tilt, b.tilt), yaw: mix(a.yaw, b.yaw) }
}

/**
 * 事件提示：tag 为日期标签，在 year 那一刻出现，停留 CAPTION_S 秒（下一条出现前先收起）。
 * at 为事件地点（经纬度），有地点的提示从地图上的地点引出；全国性的事件没有地点，显示在画面左上。
 * 内容取自交通运输部统计公报、国家统计局年鉴与官方报道，逐条核查过，出处记在各条上方。
 * 带年底里程数的提示放在 x.99：左下角的里程按年内线性插值，这时才走到年底值，数字与提示一致
 */
export interface Caption {
  year: number
  tag: string
  text: string
  at?: [number, number]
}
export const CAPTIONS: Caption[] = [
  // 沪嘉 1988-10-31 通车；沈大沈阳—鞍山、大连—三十里堡段同月先通，1988 年末统计 147 km 含两者（国家统计局年鉴）
  { year: 1988.82, tag: '1988.10', text: '沪嘉、沈大高速首批路段通车，实现零的突破', at: [121.33, 31.3] },
  // 新华网 2021-05-01 http://www.xinhuanet.com/2021-05/01/c_1127402052.htm
  { year: 1990.64, tag: '1990.08', text: '沈大高速公路全线建成通车', at: [122.4, 40.2] },
  // 人民政协网 2021-04-23 https://www.rmzxw.com.cn/c/2021-04-23/2838223.shtml
  { year: 1993.73, tag: '1993.09', text: '京津塘高速公路全线通车', at: [116.95, 39.45] },
  // 国家统计局年鉴 2007 表 16-4：1997 年末 4771、1998 年末 8733 km https://www.stats.gov.cn/sj/ndsj/2007/html/P1604C.HTM
  { year: 1998.99, tag: '1998', text: '全年新增高速公路 3962 公里，通车里程达 8733 公里' },
  // 经济日报（财政部网站转载）http://www.mof.gov.cn/zhengwuxinxi/caijingshidian/jjrb/200810/t20081020_82810.htm
  { year: 1999.83, tag: '1999.10', text: '济泰高速通车，全国通车里程突破 1 万公里', at: [117.05, 36.45] },
  // 光明日报 2000-09-16（京沈）https://www.gmw.cn/01gmrb/2000-09/16/GB/09^18545^0^GMA2-115b.htm
  { year: 2000.9, tag: '2000', text: '京沈、京沪高速公路全线贯通', at: [117.3, 37.6] },
  // 经济日报（财政部网站转载，同上）：2001 年超过加拿大居世界第二
  { year: 2001.99, tag: '2001', text: '通车里程达 1.9 万公里，跃居世界第二' },
  // 国家发展改革委 https://www.ndrc.gov.cn/fggz/zcssfz/zcgh/200507/t20050715_1145648.html
  { year: 2005.1, tag: '2005.01', text: '“7918”国家高速公路网规划发布' },
  // 国史网 http://hprc.cssn.cn/gsgl/dsnb/zdsj/qian30dashi/2000d2009/201906/t20190611_4915213.html
  { year: 2007.9, tag: '2007', text: '“五纵七横”国道主干线基本贯通' },
  // 公安部 2013-01-30 发布，中新网 http://www.chinanews.com/auto/2013/01-30/4534324.shtml
  { year: 2012.99, tag: '2012', text: '通车里程达 9.62 万公里，超过美国居世界第一' },
  // 《国家公路网规划（2013年—2030年）》发改基础〔2013〕980 号 https://www.ndrc.gov.cn/fggz/fgzy/shgqhy/202207/t20220715_1330779.html
  { year: 2013.4, tag: '2013.05', text: '国家高速公路网调整为“71118”网' },
  // 国家统计局年鉴 2020 表 16-2 https://www.stats.gov.cn/sj/ndsj/2020/html/C1602.jpg
  { year: 2016.99, tag: '2016', text: '通车里程突破 13 万公里' },
  // 人民日报 2020-01-20 https://paper.people.com.cn/zgcsb/html/2020-01/20/content_1968141.htm
  { year: 2019.99, tag: '2020.01.01', text: '全国高速公路省界收费站取消' },
  // 2025 年交通运输行业发展统计公报，中新网 2026-06-22 https://www.chinanews.com.cn/cj/2026/06-22/10645076.shtml
  { year: 2025.99, tag: '2025', text: '通车里程达 19.94 万公里' },
]
export const CAPTION_S = 5.5

/** 第 sec 秒正在显示的事件提示：出现了多久（秒）与总时长（下一条出现前收起） */
export function captionsAt(sec: number): { c: Caption; index: number; age: number; life: number }[] {
  const out: { c: Caption; index: number; age: number; life: number }[] = []
  CAPTIONS.forEach((c, index) => {
    const start = secOfYear(c.year)
    const next = CAPTIONS[index + 1]
    const life = Math.min(CAPTION_S, next ? secOfYear(next.year) - start - 0.05 : CAPTION_S)
    const age = sec - start
    if (age >= 0 && age <= life) out.push({ c, index, age, life })
  })
  return out
}

/** 年底累计里程（公里）在小数年 y 时的值：年内按线性插值 */
export function officialKmAt(official: [number, number][], y: number) {
  const yr = Math.floor(y)
  const at = (v: number) => (v < official[0][0] ? 0 : (official.find(([k]) => k === v)?.[1] ?? official[official.length - 1][1]))
  const before = at(yr - 1)
  const after = at(yr)
  return before + (after - before) * (y - yr)
}
