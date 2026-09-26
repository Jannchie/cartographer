import { Biome, type World } from '../gen/types'
import { PHYSICAL, seabed } from './palette'
import { drawRivers, type SmoothRiver } from './rivers'

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * 写实地表贴图：群系底色（格间平滑过渡）+ 海拔/坡度/气温决定的岩石与积雪 +
 * 凹凸度暗化（谷暗脊亮）+ 细颗粒噪声。另输出一张粗糙度贴图：河流光滑反光。
 */
export function buildPhysicalTexture(world: World, rivers: SmoothRiver[], scale = 2) {
  const { W, H, elevation: e, biome, temperature: T, water } = world
  const N = W * H
  const cr = new Float32Array(N)
  const cg = new Float32Array(N)
  const cb = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    let c: [number, number, number]
    const h = e[i]
    if (h <= 0) c = seabed(-h)
    else if (biome[i] === Biome.Lake) {
      const d = water[i] - h
      c = seabed(d * 3 + 0.05)
    } else {
      const base = PHYSICAL[biome[i]]
      // 高处略偏灰褐，低处略偏暖
      const hi = smooth(0.4, 2.8, h)
      c = [base[0] * (1 - hi * 0.12) + 128 * hi * 0.12, base[1] * (1 - hi * 0.16) + 118 * hi * 0.16, base[2] * (1 - hi * 0.1) + 104 * hi * 0.1]
    }
    cr[i] = c[0]
    cg[i] = c[1]
    cb[i] = c[2]
  }
  // 陆、海分开羽化（归一化卷积），岸线两侧的颜色互不渗透
  const isLand = new Float32Array(N)
  for (let i = 0; i < N; i++) isLand[i] = e[i] > 0 ? 1 : 0
  const [lr, lg, lb] = maskedBlur([cr, cg, cb], isLand, W, H)
  const isSea = isLand.map((v) => 1 - v)
  const [sr, sg, sb] = maskedBlur([cr, cg, cb], isSea, W, H)

  const TW = W * scale
  const TH = H * scale
  const canvas = document.createElement('canvas')
  canvas.width = TW
  canvas.height = TH
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(TW, TH)
  const d = img.data
  const rough = document.createElement('canvas')
  rough.width = TW
  rough.height = TH
  const rctx = rough.getContext('2d')!
  const rimg = rctx.createImageData(TW, TH)
  const rd = rimg.data
  const km = world.kmPerCell

  const bil = (a: Float32Array, x0: number, y0: number, fx: number, fy: number) => {
    const i = y0 * W + x0
    return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + W] * (1 - fx) + a[i + W + 1] * fx) * fy
  }

  for (let py = 0; py < TH; py++) {
    const gy = Math.min(H - 1.001, Math.max(0, (py + 0.5) / scale - 0.5))
    const y0 = Math.min(H - 2, Math.floor(gy))
    const fy = gy - y0
    for (let px = 0; px < TW; px++) {
      const gx = Math.min(W - 1.001, Math.max(0, (px + 0.5) / scale - 0.5))
      const x0 = Math.min(W - 2, Math.floor(gx))
      const fx = gx - x0
      const i = y0 * W + x0
      const h = bil(e, x0, y0, fx, fy)
      const onLand = h > 0
      let r = bil(onLand ? lr : sr, x0, y0, fx, fy)
      let g = bil(onLand ? lg : sg, x0, y0, fx, fy)
      let b = bil(onLand ? lb : sb, x0, y0, fx, fy)
      const o = (py * TW + px) * 4
      let roughV = 235
      if (h > 0 && biome[i] !== Biome.Lake) {
        const xm = Math.max(0, x0 - 1), xp = Math.min(W - 1, x0 + 2)
        const ym = Math.max(0, y0 - 1), yp = Math.min(H - 1, y0 + 2)
        const gxv = (e[y0 * W + xp] - e[y0 * W + xm]) / ((xp - xm) * km)
        const gyv = (e[yp * W + x0] - e[ym * W + x0]) / ((yp - ym) * km)
        const slope = Math.hypot(gxv, gyv)
        // 裸岩：陡坡
        const rock = smooth(0.16, 0.36, slope) * 0.45
        r += (122 - r) * rock
        g += (113 - g) * rock
        b += (102 - b) * rock
        // 积雪：随温度与海拔，陡坡上积不住
        const t = bil(T, x0, y0, fx, fy)
        const snow = smooth(-1.5, -6, t) * (1 - smooth(0.25, 0.5, slope) * 0.55)
        r += (242 - r) * snow
        g += (245 - g) * snow
        b += (248 - b) * snow
        // 凹凸度：谷暗脊亮
        const lap = e[i - 1 >= 0 ? i - 1 : i] + e[i + 1] + e[Math.max(0, i - W)] + e[Math.min(N - 1, i + W)] - 4 * e[i]
        const cav = Math.max(-0.12, Math.min(0.12, -lap * 0.5))
        r *= 1 + cav
        g *= 1 + cav
        b *= 1 + cav
        if (snow > 0.5) roughV = 170
      }
      const n = (hash(px, py) - 0.5) * 10
      d[o] = r + n
      d[o + 1] = g + n
      d[o + 2] = b + n
      d[o + 3] = 255
      rd[o] = rd[o + 1] = rd[o + 2] = roughV
      rd[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  rctx.putImageData(rimg, 0, 0)

  // 河流：稍深的水色，粗糙度低 → 在阳光下会闪光
  drawRivers(ctx, rivers, W, scale, 'rgba(52, 88, 104, 0.9)', 0.85, 2.5)
  drawRivers(rctx, rivers, W, scale, 'rgb(120,120,120)', 0.85, 2.5)
  return { color: canvas, roughness: rough }
}

/** 归一化卷积：只用 mask=1 的格求加权平均，并外推到 mask=0 的格 */
function maskedBlur(ch: Float32Array[], mask: Float32Array, W: number, H: number): Float32Array[] {
  const den = Float32Array.from(mask)
  const nums = ch.map((c) => c.map((v, i) => v * mask[i]))
  for (let pass = 0; pass < 3; pass++) {
    for (const a of [den, ...nums]) box3(a, W, H)
  }
  return nums.map((n, k) => n.map((v, i) => (den[i] > 1e-4 ? v / den[i] : ch[k][i])))
}

function box3(a: Float32Array, W: number, H: number) {
  const t = new Float32Array(a.length)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const l = x > 0 ? a[i - 1] : a[i]
      const r = x < W - 1 ? a[i + 1] : a[i]
      t[i] = a[i] * 0.5 + (l + r) * 0.25
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const u = y > 0 ? t[i - W] : t[i]
      const d = y < H - 1 ? t[i + W] : t[i]
      a[i] = t[i] * 0.5 + (u + d) * 0.25
    }
  }
}
