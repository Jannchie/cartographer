/**
 * 确定性数学函数：同一个种子在任何浏览器、任何版本的引擎里都生成同一个世界、同一座城。
 *
 * 语言标准只要求 Math.sin、Math.exp 这类函数"近似"正确，没有规定最后一位怎么取整：各引擎、同一引擎的不同版本
 * 实现不同（实测 Chrome 154 与 Node 24 的 sin、cos、exp、log、atan2 等在末位上不一致），误差经过噪声、侵蚀、
 * 流量累积逐级放大，最后成了不同的海岸线与地名位置。
 *
 * 这里按 fdlibm（Sun 的参考实现）移植，只用加减乘除、开方（IEEE 754 要求这几种运算正确取整）与位运算，
 * 所以处处逐位相同；精度在 1 ulp 左右，与引擎自带的相当。生成代码（src/gen、src/settlement）一律用这里的函数，
 * 不直接用 Math.sin 之类与 ** 运算符（scripts/check-dmath.ts 检查）。
 */

const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)
/** 高 32 位（带符号）与低 32 位（小端序：高位在 [1]） */
const hiOf = (x: number) => {
  f64[0] = x
  return u32[1] | 0
}
const loOf = (x: number) => {
  f64[0] = x
  return u32[0]
}
const fromWords = (hi: number, lo: number) => {
  u32[1] = hi >>> 0
  u32[0] = lo >>> 0
  return f64[0]
}

// —— exp ——
const LN2_HI = 6.93147180369123816490e-1
const LN2_LO = 1.90821492927058770002e-10
const INV_LN2 = 1.44269504088896338700e0
const P1 = 1.66666666666666019037e-1
const P2 = -2.77777777770155933842e-3
const P3 = 6.61375632143793436117e-5
const P4 = -1.65339022054652515390e-6
const P5 = 4.13813679705723846039e-8
const TWO_M1000 = 9.33263618503218878990e-302

export function exp(x: number): number {
  if (x !== x) return x
  let hx = hiOf(x)
  const xsb = (hx >>> 31) & 1
  hx &= 0x7fffffff
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) return xsb === 0 ? x : 0
    if (x > 7.09782712893383973096e2) return Infinity
    if (x < -7.45133219101941108420e2) return 0
  }
  let hi = 0
  let lo = 0
  let k = 0
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = x - (xsb ? -LN2_HI : LN2_HI)
      lo = xsb ? -LN2_LO : LN2_LO
      k = 1 - xsb - xsb
    } else {
      k = Math.trunc(INV_LN2 * x + (xsb ? -0.5 : 0.5))
      hi = x - k * LN2_HI
      lo = k * LN2_LO
    }
    x = hi - lo
  } else if (hx < 0x3e300000) return 1 + x
  const t = x * x
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  if (k === 0) return 1 - ((x * c) / (c - 2) - x)
  const y = 1 - (lo - (x * c) / (2 - c) - hi)
  // 把 k 加进指数
  if (k >= -1021) return fromWords(hiOf(y) + (k << 20), loOf(y))
  return fromWords(hiOf(y) + ((k + 1000) << 20), loOf(y)) * TWO_M1000
}

// —— log ——
const TWO54 = 1.8014398509481984e16
const Lg1 = 6.666666666666735130e-1
const Lg2 = 3.999999999940941908e-1
const Lg3 = 2.857142874366239149e-1
const Lg4 = 2.222219843214978396e-1
const Lg5 = 1.818357216161805012e-1
const Lg6 = 1.531383769920937332e-1
const Lg7 = 1.479819860511658591e-1

export function log(x: number): number {
  let hx = hiOf(x)
  const lx = loOf(x)
  let k = 0
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity
    if (hx < 0) return NaN
    k -= 54
    x *= TWO54
    hx = hiOf(x)
  }
  if (hx >= 0x7ff00000) return x + x
  k += (hx >> 20) - 1023
  hx &= 0x000fffff
  const i0 = (hx + 0x95f64) & 0x100000
  // 把 x 规整到 [sqrt(2)/2, sqrt(2)) 附近
  x = fromWords(hx | (i0 ^ 0x3ff00000), loOf(x))
  k += i0 >> 20
  const f = x - 1
  const dk = k
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO
    const R = f * f * (0.5 - 0.33333333333333333 * f)
    return k === 0 ? f - R : dk * LN2_HI - (R - dk * LN2_LO - f)
  }
  const s = f / (2 + f)
  const z = s * s
  let i = hx - 0x6147a
  const w = z * z
  const j = 0x6b851 - hx
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6))
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)))
  i |= j
  const R = t2 + t1
  if (i > 0) {
    const hfsq = 0.5 * f * f
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f)
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f)
}

/** log(1 + x)：小 x 时按 Goldberg 的做法补回 1 + x 的舍入误差 */
export function log1p(x: number): number {
  const u = 1 + x
  if (u === 1) return x
  return (log(u) * x) / (u - 1)
}

const INV_LN2_EXACT = 1.4426950408889634
export function log2(x: number): number {
  // 2 的整数次幂：直接给指数（尾数全零的正规数）
  const hx = hiOf(x)
  if (hx > 0 && hx < 0x7ff00000 && (hx & 0x000fffff) === 0 && loOf(x) === 0) return (hx >> 20) - 1023
  return log(x) * INV_LN2_EXACT
}

// —— sin / cos ——
const S1 = -1.66666666666666324348e-1
const S2 = 8.33333333332248946124e-3
const S3 = -1.98412698298579493134e-4
const S4 = 2.75573137070700676789e-6
const S5 = -2.50507602534068634195e-8
const S6 = 1.58969099521155010221e-10
function kSin(x: number, y: number, iy: number) {
  const ix = hiOf(x) & 0x7fffffff
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return x
  const z = x * x
  const v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  if (iy === 0) return x + v * (S1 + z * r)
  return x - (z * (0.5 * y - v * r) - y - v * S1)
}
const C1 = 4.16666666666666019037e-2
const C2 = -1.38888888888741095749e-3
const C3 = 2.48015872894767294178e-5
const C4 = -2.75573143513906633035e-7
const C5 = 2.08757232129817482790e-9
const C6 = -1.13596475577881948265e-11
function kCos(x: number, y: number) {
  const ix = hiOf(x) & 0x7fffffff
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return 1
  const z = x * x
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y))
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0)
  const hz = 0.5 * z - qx
  const a = 1 - qx
  return a - (hz - (z * r - x * y))
}

const INV_PIO2 = 6.36619772367581382433e-1
const PIO2_1 = 1.57079632673412561417e0
const PIO2_1T = 6.07710050650619224932e-11
const PIO2_2 = 6.07710050630396597660e-11
const PIO2_2T = 2.02226624879595063154e-21
const PIO2_3 = 2.02226624871116645580e-21
const PIO2_3T = 8.47842766036889956997e-32
/** 除以 π/2 的余数：返回商 n，余数（高、低两部分）写进 rem。按 fdlibm 的中等幅度做法（大数也照做，精度下降但仍确定） */
const rem: [number, number] = [0, 0]
function remPio2(x: number): number {
  const hx = hiOf(x)
  const ix = hx & 0x7fffffff
  const t0 = Math.abs(x)
  const n = Math.trunc(t0 * INV_PIO2 + 0.5)
  const fn = n
  let r = t0 - fn * PIO2_1
  let w = fn * PIO2_1T
  const j = ix >> 20
  let y0 = r - w
  let i = j - ((hiOf(y0) >> 20) & 0x7ff)
  if (i > 16) {
    let t = r
    w = fn * PIO2_2
    r = t - w
    w = fn * PIO2_2T - (t - r - w)
    y0 = r - w
    i = j - ((hiOf(y0) >> 20) & 0x7ff)
    if (i > 49) {
      t = r
      w = fn * PIO2_3
      r = t - w
      w = fn * PIO2_3T - (t - r - w)
      y0 = r - w
    }
  }
  const y1 = r - y0 - w
  if (hx < 0) {
    rem[0] = -y0
    rem[1] = -y1
    return -n
  }
  rem[0] = y0
  rem[1] = y1
  return n
}

export function sin(x: number): number {
  const ix = hiOf(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kSin(x, 0, 0)
  if (ix >= 0x7ff00000) return NaN
  const n = remPio2(x)
  switch (n & 3) {
    case 0:
      return kSin(rem[0], rem[1], 1)
    case 1:
      return kCos(rem[0], rem[1])
    case 2:
      return -kSin(rem[0], rem[1], 1)
    default:
      return -kCos(rem[0], rem[1])
  }
}

export function cos(x: number): number {
  const ix = hiOf(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) return kCos(x, 0)
  if (ix >= 0x7ff00000) return NaN
  const n = remPio2(x)
  switch (n & 3) {
    case 0:
      return kCos(rem[0], rem[1])
    case 1:
      return -kSin(rem[0], rem[1], 1)
    case 2:
      return -kCos(rem[0], rem[1])
    default:
      return kSin(rem[0], rem[1], 1)
  }
}

// —— atan / atan2 ——
const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e0]
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1, 9.09088713343650656196e-2, -7.69187620504482999495e-2,
  6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2,
]

export function atan(x: number): number {
  if (x !== x) return x
  const hx = hiOf(x)
  const ix = hx & 0x7fffffff
  let id: number
  if (ix >= 0x44100000) return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3]
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e200000) return x
    id = -1
  } else {
    x = Math.abs(x)
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0
        x = (2 * x - 1) / (2 + x)
      } else {
        id = 1
        x = (x - 1) / (x + 1)
      }
    } else if (ix < 0x40038000) {
      id = 2
      x = (x - 1.5) / (1 + 1.5 * x)
    } else {
      id = 3
      x = -1 / x
    }
  }
  const z = x * x
  const w = z * z
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))))
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))))
  if (id < 0) return x - x * (s1 + s2)
  const r = ATAN_HI[id] - (x * (s1 + s2) - ATAN_LO[id] - x)
  return hx < 0 ? -r : r
}

const PI = 3.1415926535897931160e0
const PI_LO = 1.2246467991473531772e-16
const PI_O_2 = 1.5707963267948965580e0
const PI_O_4 = 7.8539816339744827900e-1

export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN
  if (x === 1) return atan(y)
  const yNeg = y < 0 || Object.is(y, -0)
  const xNeg = x < 0 || Object.is(x, -0)
  const m = (yNeg ? 1 : 0) | (xNeg ? 2 : 0)
  if (y === 0) return m === 0 || m === 1 ? y : m === 2 ? PI : -PI
  if (x === 0) return yNeg ? -PI_O_2 : PI_O_2
  if (x === Infinity || x === -Infinity) {
    if (y === Infinity || y === -Infinity) return [PI_O_4, -PI_O_4, 3 * PI_O_4, -3 * PI_O_4][m]
    return [0, -0, PI, -PI][m]
  }
  if (y === Infinity || y === -Infinity) return yNeg ? -PI_O_2 : PI_O_2
  const k = ((hiOf(y) & 0x7fffffff) - (hiOf(x) & 0x7fffffff)) >> 20
  let z: number
  if (k > 60) z = PI_O_2 + 0.5 * PI_LO
  else if (xNeg && k < -60) z = 0
  else z = atan(Math.abs(y / x))
  switch (m) {
    case 0:
      return z
    case 1:
      return -z
    case 2:
      return PI - (z - PI_LO)
    default:
      return z - PI_LO - PI
  }
}

// —— pow / hypot ——
/** 整数次幂用连乘（逐位确定、比 exp(y·log x) 准）；其余按 exp(y·log x) */
export function pow(x: number, y: number): number {
  if (y === 0) return 1
  if (x !== x || y !== y) return NaN
  if (y === 1) return x
  if (y === 0.5 && x >= 0) return Math.sqrt(x)
  if (Number.isInteger(y) && Math.abs(y) <= 64) {
    let n = Math.abs(y)
    let b = x
    let r = 1
    while (n > 0) {
      if (n & 1) r *= b
      b *= b
      n >>= 1
    }
    return y < 0 ? 1 / r : r
  }
  if (x === 0) return y > 0 ? 0 : Infinity
  if (x < 0) {
    if (!Number.isInteger(y)) return NaN
    const v = exp(y * log(-x))
    return y % 2 === 0 ? v : -v
  }
  if (x === Infinity) return y > 0 ? Infinity : 0
  return exp(y * log(x))
}

/** √(a² + b² + c²)：只用乘加与开方（开方正确取整），各引擎一致 */
export function hypot(a: number, b: number, c = 0): number {
  return Math.sqrt(a * a + b * b + c * c)
}

export const dm = { exp, log, log1p, log2, sin, cos, atan, atan2, pow, hypot }
