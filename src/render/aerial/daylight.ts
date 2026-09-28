import * as THREE from 'three'

/**
 * 昼夜：时刻 → 太阳 / 月亮的方向与整套光照参数（纯函数，不碰场景）。
 *
 * 日轨是一条过"东""西"两点的大圆：正午太阳在 (方位 az, 高度 A)——正是原来的"太阳方位 / 太阳高度"，
 * 于是默认的 12:00 与改版前的画面完全一样；早上 6 点从 az+90° 升起，傍晚 6 点在 az−90° 落下，
 * 夜里太阳沉到地平线以下，同一条轨道的另一半。月亮取满月：永远在太阳正对面。
 *
 * 白天（太阳高于 2°）的各项数值与原先 updateSun 的公式逐项一致；
 * 往下依次是暮光（地平线暖粉、天顶紫蓝）→ 蓝调时刻 → 夜（深藏青，月光蓝灰）。
 */

export const DEFAULT_TIME = 12

export interface Daylight {
  /** 太阳高度（度，可为负） */
  sunEl: number
  /** 太阳直射光的淡出（太阳落到地平线下 3° 时为 0） */
  sunFade: number
  /** 夜的程度 0~1 */
  night: number
  sunDir: THREE.Vector3
  moonDir: THREE.Vector3
  /** 主光（投影的平行光）：白天是太阳，夜里换成月亮（换的那一刻两者都是 0，不会跳） */
  keyDir: THREE.Vector3
  keyColor: THREE.Color
  keyIntensity: number
  moonKey: boolean
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiIntensity: number
  /** 天色：水面反射、云的环境光、空气透视共用 */
  skyTop: THREE.Color
  skyHorizon: THREE.Color
  /** 自发光着色器（水面、海水剖面）的整体亮度 */
  light: number
  /** 云里的直射光颜色（已乘强度） */
  cloudSun: THREE.Color
  /** 空气透视里顺光方向的散射光（已乘强度） */
  hazeSun: THREE.Color
  /** 城市灯火 0~1：黄昏亮起，破晓熄灭 */
  cityLights: number
  /** 星空 0~1 */
  stars: number
  /** 月亮在天上的程度 0~1 */
  moonUp: number
  /** 暮光（日落前后地平线的暖粉）0~1 */
  twilight: number
  /** 曝光补偿倍数：夜里提亮，保证看得清 */
  exposure: number
  /** 阴影柔和度倍数（月光更柔） */
  shadowSoft: number
}

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const lin = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b)

const SKY_TOP = new THREE.Color('#3b6ea8')
const HAZE = new THREE.Color('#a9c6e4')
const HAZE_WARM = new THREE.Color('#f0c59a')
const HEMI_SKY = new THREE.Color(0xc4d7ea)
const HEMI_GROUND = new THREE.Color(0x5b4a3a)
const HEMI_TWILIGHT = new THREE.Color('#d6aec4')
/** 黄金时刻的天光：暖桃色 */
const HEMI_GOLDEN = new THREE.Color('#e9c9a8')
const HEMI_NIGHT = new THREE.Color('#7f95cc')
const HEMI_GROUND_NIGHT = new THREE.Color('#2e2e40')
/** 月光：蓝灰 */
const MOON = lin(0.45, 0.6, 1.0)
/** 太阳贴着地平线时的深橙红 */
const SUN_LOW = lin(1, 0.5, 0.26)

/** 太阳高度 ≤ 0 时的天色关键帧（线性色）：[高度, 天顶, 地平线] */
const DUSK: [number, THREE.Color, THREE.Color][] = [
  [-4, lin(0.03, 0.036, 0.1), lin(0.3, 0.13, 0.12)],
  [-8, lin(0.011, 0.014, 0.046), lin(0.07, 0.045, 0.085)],
  [-14, lin(0.0035, 0.0055, 0.018), lin(0.01, 0.013, 0.03)],
]

/** 夜里提亮的曝光倍数（约 +0.75 EV） */
const NIGHT_EXPOSURE = 1.7
/** 月光强度（太阳正午为 3.8） */
const MOON_INTENSITY = 0.3

/** 时刻（小时）→ 太阳方向（单位向量）。az、noon：正午的方位与高度（度） */
export function sunDirection(hours: number, azDeg: number, noonDeg: number, out = new THREE.Vector3()) {
  const H = ((hours - 12) / 24) * Math.PI * 2
  const az = (azDeg * Math.PI) / 180
  const A = (noonDeg * Math.PI) / 180
  // 正午方向 N、升起方向 E（N 逆着方位增加的方向转 90°）、天顶 U
  const nx = Math.cos(az)
  const nz = Math.sin(az)
  const ex = -nz
  const ez = nx
  const s = -Math.sin(H)
  const c = Math.cos(H)
  // 正午：cos A·N + sin A·U；早 6 点：+E；晚 6 点：−E
  return out.set(s * ex + c * Math.cos(A) * nx, c * Math.sin(A), s * ez + c * Math.cos(A) * nz)
}

export function daylight(hours: number, azDeg: number, noonDeg: number): Daylight {
  const sunDir = sunDirection(hours, azDeg, noonDeg)
  const moonDir = sunDir.clone().negate()
  const el = (Math.asin(clamp(sunDir.y, -1, 1)) * 180) / Math.PI
  const moonEl = -el

  // —— 白天的公式（与改版前一致） ——
  const warm = 1 - clamp((el - 4) / 40)
  const sunColor = lin(1, 0.95 - 0.2 * warm, 0.86 - 0.36 * warm)
  // 贴着地平线时再红一些
  sunColor.lerp(SUN_LOW, Math.max(1 - smooth(-2, 3, el), 0.35 * smooth(14, 2, el)))
  const k = clamp(Math.sin((Math.max(el, 0) * Math.PI) / 180) * 2.2, 0.15, 1)
  // 太阳落到地平线下 3° 时直射光熄灭
  const sunFade = smooth(-3, 2, el)
  const ks = k * sunFade
  // 白天的比例：1 = 白天，0 = 夜
  const day = smooth(-12, 2, el)
  // 月亮升到 3° 起亮，14° 全亮
  const moonUp = smooth(3, 14, moonEl)
  const twilight = smooth(7, 0, el) * smooth(-12, -3, el)
  // 黄金时刻：太阳低于 14° 起天光转暖、变弱，暖色的直射光占上风
  const golden = smooth(14, 2, el) * smooth(-3, 1, el)

  // —— 主光 ——
  const moonKey = el <= -3
  const keyDir = (moonKey ? moonDir : sunDir).clone()
  const keyColor = moonKey ? MOON.clone() : sunColor.clone()
  const keyIntensity = moonKey ? MOON_INTENSITY * moonUp : 3.8 * ks * (1 + 0.6 * golden)

  // —— 天色 ——
  const skyTop = SKY_TOP.clone().multiplyScalar(0.35 + 0.65 * k)
  const skyHorizon = HAZE.clone().lerp(HAZE_WARM, warm * 0.45).multiplyScalar(0.45 + 0.55 * k)
  if (el < 0) {
    let top0 = skyTop.clone()
    let hor0 = skyHorizon.clone()
    let e0 = 0
    for (const [e1, top1, hor1] of DUSK) {
      if (el >= e1) {
        const f = smooth(0, 1, (e0 - el) / (e0 - e1))
        skyTop.copy(top0).lerp(top1, f)
        skyHorizon.copy(hor0).lerp(hor1, f)
        break
      }
      top0 = top1
      hor0 = hor1
      e0 = e1
      skyTop.copy(top1)
      skyHorizon.copy(hor1)
    }
    // 月光把夜空照亮一点
    const moonSky = moonUp * (1 - day)
    skyTop.add(lin(0.003, 0.005, 0.012).multiplyScalar(moonSky))
    skyHorizon.add(lin(0.006, 0.008, 0.016).multiplyScalar(moonSky))
  }

  // —— 天光（半球光） ——
  // 黄金时刻：地平线与天顶都染上暖色（水面反射、霾、云的环境光跟着暖）
  if (golden > 0) {
    const b = skyHorizon.r + skyHorizon.g + skyHorizon.b
    skyHorizon.lerp(lin(0.5, 0.3, 0.2).multiplyScalar(b), golden * 0.45)
    skyTop.lerp(lin(0.1, 0.1, 0.18).multiplyScalar(skyTop.r + skyTop.g + skyTop.b), golden * 0.3)
  }
  const hemiSky = HEMI_SKY.clone().lerp(HEMI_GOLDEN, golden * 0.5).lerp(HEMI_TWILIGHT, twilight * 0.6).lerp(HEMI_NIGHT, 1 - day)
  const hemiGround = HEMI_GROUND.clone().lerp(HEMI_GROUND_NIGHT, 1 - day)
  const nightHemi = 0.06 + 0.04 * moonUp
  const hemiIntensity = (nightHemi + (0.42 + 0.3 * ks - nightHemi) * day) * (1 - 0.25 * golden)

  // —— 自发光着色器的亮度、云与空气透视里的直射光 ——
  const nightLight = 0.1 + 0.06 * moonUp
  // 水面与海水剖面比地表暗得更早（散射的蓝色在暮色里太跳）
  const light = nightLight + (0.45 + 0.55 * ks - nightLight) * day ** 2
  const cloudSun = moonKey ? MOON.clone().multiplyScalar(0.07 * moonUp) : sunColor.clone().multiplyScalar((0.35 + 0.65 * k) * sunFade)
  const hazeSun = moonKey ? MOON.clone().multiplyScalar(0.05 * moonUp) : sunColor.clone().multiplyScalar((0.25 + 0.35 * k) * sunFade)

  return {
    sunEl: el,
    sunFade,
    night: 1 - day,
    sunDir,
    moonDir,
    keyDir,
    keyColor,
    keyIntensity,
    moonKey,
    hemiSky,
    hemiGround,
    hemiIntensity,
    skyTop,
    skyHorizon,
    light,
    cloudSun,
    hazeSun,
    cityLights: 1 - smooth(-6, 3, el),
    stars: 1 - smooth(-14, -5, el),
    moonUp,
    twilight,
    exposure: 1 + (NIGHT_EXPOSURE - 1) * (1 - smooth(-12, 0, el)),
    shadowSoft: moonKey ? 1.8 : 1,
  }
}

/** 小时 → "HH:MM" */
export function fmtTime(h: number) {
  const m = Math.round((((h % 24) + 24) % 24) * 60) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
