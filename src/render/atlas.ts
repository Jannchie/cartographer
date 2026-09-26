import { Biome, type Label, type World } from '../gen/types'
import { ATLAS, atlasSea } from './palette'
import { drawRivers, type SmoothRiver } from './rivers'

export interface AtlasOptions {
  labels: boolean
  contours: boolean
  graticule: boolean
  scale: number
}

const INK = [58, 66, 70]
const PAPER = [241, 234, 216]
const SERIF = '"Cormorant Garamond", "Noto Serif SC", Georgia, serif'

function sm(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export async function ensureFonts() {
  try {
    await Promise.all([
      document.fonts.load(`500 20px "Cormorant Garamond"`),
      document.fonts.load(`italic 500 20px "Cormorant Garamond"`),
      document.fonts.load(`700 20px "Cormorant Garamond"`),
      document.fonts.load(`italic 600 20px "Cormorant Garamond"`),
    ])
  } catch {
    // 字体加载失败时回退到系统衬线体
  }
}

/**
 * 制图风格地图：分层设色的海洋 + 等深线、岸线晕渲波纹、
 * 群系水彩底色 × 多方向山体晕渲、等高线、河流湖泊、经纬网、图框与注记。
 */
export function renderAtlas(world: World, rivers: SmoothRiver[], opts: AtlasOptions): HTMLCanvasElement {
  const { W, H, elevation: e, biome, coastDist } = world
  const S = opts.scale
  const MW = W * S
  const MH = H * S
  const M = Math.round(34 * S)
  const canvas = document.createElement('canvas')
  canvas.width = MW + M * 2
  canvas.height = MH + M * 2
  const ctx = canvas.getContext('2d')!

  // —— 每格底色（羽化） ——
  const N = W * H
  const cr = new Float32Array(N)
  const cg = new Float32Array(N)
  const cb = new Float32Array(N)
  const lake = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const c = ATLAS[biome[i]]
    const hi = sm(1.2, 4, e[i])
    cr[i] = c[0] + (216 - c[0]) * hi * 0.5
    cg[i] = c[1] + (204 - c[1]) * hi * 0.5
    cb[i] = c[2] + (186 - c[2]) * hi * 0.5
    lake[i] = biome[i] === Biome.Lake ? 1 : 0
  }
  feather(cr, W, H)
  feather(cg, W, H)
  feather(cb, W, H)

  const img = ctx.createImageData(MW, MH)
  const d = img.data
  const km = world.kmPerCell
  const zf = 14 // 晕渲垂直夸张

  const sample = (a: Float32Array, gx: number, gy: number) => {
    gx = Math.min(W - 1.001, Math.max(0, gx))
    gy = Math.min(H - 1.001, Math.max(0, gy))
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const i = y0 * W + x0
    const x1 = x0 + 1 < W ? 1 : 0
    const y1 = y0 + 1 < H ? W : 0
    return (a[i] * (1 - fx) + a[i + x1] * fx) * (1 - fy) + (a[i + y1] * (1 - fx) + a[i + y1 + x1] * fx) * fy
  }

  const rip = [4.5, 9.5, 16, 25].map((v) => v * (S / 2))
  const ripA = [0.34, 0.22, 0.13, 0.07]
  const seaLevels = [0.2, 1, 2, 3.2, 4.2]
  for (let py = 0; py < MH; py++) {
    const gy = (py + 0.5) / S - 0.5
    for (let px = 0; px < MW; px++) {
      const gx = (px + 0.5) / S - 0.5
      const h = sample(e, gx, gy)
      const o = (py * MW + px) * 4
      const hL = sample(e, gx - 0.5, gy)
      const hR = sample(e, gx + 0.5, gy)
      const hU = sample(e, gx, gy - 0.5)
      const hD = sample(e, gx, gy + 0.5)
      // 每像素的梯度（km/px）
      const dhx = (hR - hL) / S
      const dhy = (hD - hU) / S
      const gpx = Math.hypot(dhx, dhy) + 1e-6
      let r: number, g: number, b: number
      if (h <= 0) {
        const depth = -h
        const c = atlasSea(stepDepth(depth))
        r = c[0]
        g = c[1]
        b = c[2]
        // 等深线
        for (const lv of seaLevels) {
          const sd = Math.abs(depth - lv) / gpx
          const a = (1 - sm(0.3, 1.1, sd)) * 0.16
          if (a > 0) {
            r += (INK[0] + 30 - r) * a
            g += (INK[1] + 40 - g) * a
            b += (INK[2] + 50 - b) * a
          }
        }
        // 海冰
        const tsea = sample(world.temperature, gx, gy) + (hash(px >> 3, py >> 3) - 0.5) * 2.5
        const ice = sm(-6.5, -9.5, tsea)
        if (ice > 0) {
          r += (236 - r) * ice
          g += (240 - g) * ice
          b += (239 - b) * ice
        }
        // 岸线外的波纹线（经典手绘地图的"水线"）
        const dpx = -sample(coastDist, gx, gy) * S
        for (let k = 0; k < rip.length; k++) {
          const a = (1 - sm(0.35, 1.05, Math.abs(dpx - rip[k]))) * ripA[k]
          if (a > 0) {
            r += (70 - r) * a
            g += (104 - g) * a
            b += (120 - b) * a
          }
        }
      } else {
        r = sample(cr, gx, gy)
        g = sample(cg, gx, gy)
        b = sample(cb, gx, gy)
        // 多方向山体晕渲（主光源西北）
        const nx = (-(hR - hL) / km) * zf
        const ny = (-(hD - hU) / km) * zf
        const inv = 1 / Math.hypot(nx, ny, 1)
        const l1 = (nx * -0.6 + ny * -0.6 + 0.53) * inv / 0.53
        const l2 = (nx * -0.85 + ny * 0.1 + 0.52) * inv / 0.52
        const l3 = (nx * -0.1 + ny * -0.85 + 0.52) * inv / 0.52
        let shade = l1 * 0.6 + l2 * 0.2 + l3 * 0.2
        shade = Math.min(1.12, Math.max(0.38, shade))
        const sh = 1 + (shade - 1) * 0.85
        r *= sh
        g *= sh
        b *= sh * 1.02
        // 等高线（每 500 m）
        if (opts.contours) {
          const lv = Math.round(h / 0.5) * 0.5
          if (lv > 0) {
            const sd = Math.abs(h - lv) / gpx
            const a = (1 - sm(0.3, 1.0, sd)) * (lv % 2 === 0 ? 0.2 : 0.1)
            r += (120 - r) * a
            g += (96 - g) * a
            b += (70 - b) * a
          }
        }
        // 湖泊
        const lm = sample(lake, gx, gy)
        if (lm > 0.5) {
          const c = ATLAS[Biome.Lake]
          r = c[0]
          g = c[1]
          b = c[2]
        }
        const lgx = sample(lake, gx + 0.5, gy) - sample(lake, gx - 0.5, gy)
        const lgy = sample(lake, gx, gy + 0.5) - sample(lake, gx, gy - 0.5)
        const lsd = Math.abs(lm - 0.5) / ((Math.hypot(lgx, lgy) + 1e-6) / S)
        const la = (1 - sm(0.4, 1.1, lsd)) * 0.75
        if (la > 0 && lm > 0.05) {
          r += (INK[0] + 20 - r) * la
          g += (INK[1] + 40 - g) * la
          b += (INK[2] + 60 - b) * la
        }
      }
      // 海岸线墨线：用 h/|∇h| 近似像素级有符号距离
      const csd = Math.abs(h) / gpx
      const ca = 1 - sm(0.45, 1.25, csd)
      if (ca > 0) {
        r += (INK[0] - r) * ca * 0.9
        g += (INK[1] - g) * ca * 0.9
        b += (INK[2] - b) * ca * 0.9
      }
      // 纸张纹理：细颗粒 + 大块晕染
      const grain = (hash(px, py) - 0.5) * 7
      const blot = (hash(px >> 5, py >> 5) - 0.5) * 3 + (hash(px >> 7, py >> 7) - 0.5) * 5
      d[o] = r + grain + blot
      d[o + 1] = g + grain + blot
      d[o + 2] = b + grain * 0.9 + blot
      d[o + 3] = 255
    }
  }

  // 纸底 + 地图
  ctx.fillStyle = `rgb(${PAPER.join(',')})`
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const off = document.createElement('canvas')
  off.width = MW
  off.height = MH
  off.getContext('2d')!.putImageData(img, 0, 0)
  ctx.drawImage(off, M, M)

  ctx.save()
  ctx.translate(M, M)
  ctx.beginPath()
  ctx.rect(0, 0, MW, MH)
  ctx.clip()
  drawRivers(ctx, rivers, W, S, 'rgba(78, 122, 146, 0.92)', 1, 1.8)
  if (opts.graticule) drawGraticule(ctx, world, S)
  if (opts.labels) drawLabels(ctx, world, S)
  drawCompass(ctx, MW - 70 * S, MH - 78 * S, 34 * S)
  drawScaleBar(ctx, world, S, MW - 150 * S, MH - 26 * S)
  drawCartouche(ctx, world, S)
  ctx.restore()

  drawFrame(ctx, world, S, M, MW, MH)
  return canvas
}

function stepDepth(d: number) {
  // 分层设色：层内保留一点连续渐变
  const levels = [0, 0.2, 1, 2, 3.2, 4.2, 9]
  for (let k = 0; k < levels.length - 1; k++) {
    if (d < levels[k + 1]) {
      const t = (d - levels[k]) / (levels[k + 1] - levels[k])
      return levels[k] + (levels[k + 1] - levels[k]) * (0.25 + t * 0.35)
    }
  }
  return d
}

function feather(a: Float32Array, W: number, H: number) {
  const t = new Float32Array(a.length)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      t[i] = a[i] * 0.5 + ((x > 0 ? a[i - 1] : a[i]) + (x < W - 1 ? a[i + 1] : a[i])) * 0.25
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      a[i] = t[i] * 0.5 + ((y > 0 ? t[i - W] : t[i]) + (y < H - 1 ? t[i + W] : t[i])) * 0.25
    }
  }
}

/** 经度：以地图中央为 0°，按中纬度换算每格经度 */
function lonScale(world: World) {
  const p = world.params
  const midLat = (p.latNorth + p.latSouth) / 2
  return world.kmPerCell / (111.32 * Math.cos((midLat * Math.PI) / 180))
}

function drawGraticule(ctx: CanvasRenderingContext2D, world: World, S: number) {
  const { W, H, params: p } = world
  ctx.save()
  ctx.strokeStyle = 'rgba(70, 80, 84, 0.22)'
  ctx.lineWidth = 0.7 * (S / 2)
  ctx.setLineDash([6 * (S / 2), 5 * (S / 2)])
  const latStep = 10
  const top = p.latNorth
  const bot = p.latSouth
  for (let lat = Math.ceil(Math.min(top, bot) / latStep) * latStep; lat <= Math.max(top, bot); lat += latStep) {
    const y = ((lat - top) / (bot - top)) * (H - 1) * S
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W * S, y)
    ctx.stroke()
  }
  const ls = lonScale(world)
  const lonHalf = (W / 2) * ls
  for (let lon = Math.ceil(-lonHalf / 10) * 10; lon <= lonHalf; lon += 10) {
    const x = (lon / ls + W / 2) * S
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, H * S)
    ctx.stroke()
  }
  ctx.restore()
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function drawLabels(ctx: CanvasRenderingContext2D, world: World, S: number) {
  const k = S / 2
  const placed: Box[] = []
  const hit = (b: Box) => placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0)
  const MW = world.W * S
  const MH = world.H * S
  const inside = (b: Box) => b.x0 > 4 && b.y0 > 4 && b.x1 < MW - 4 && b.y1 < MH - 4
  // 为图名与指北针预留位置
  placed.push({ x0: 0, y0: 0, x1: 380 * k, y1: 120 * k })
  placed.push({ x0: MW - 190 * k, y0: MH - 150 * k, x1: MW, y1: MH })

  const style = (l: Label) => {
    switch (l.kind) {
      case 'ocean':
        return { font: `italic 500 ${30 * k}px ${SERIF}`, color: '#4b6c7c', spacing: 0.42, upper: true }
      case 'sea':
        return { font: `italic 500 ${19 * k}px ${SERIF}`, color: '#557686', spacing: 0.25, upper: false }
      case 'continent':
        return { font: `600 ${Math.min(40, 22 + l.weight / 9000) * k}px ${SERIF}`, color: 'rgba(78, 64, 50, 0.78)', spacing: 0.55, upper: true }
      case 'island':
        return { font: `500 ${(l.weight > 2500 ? 16 : 13) * k}px ${SERIF}`, color: '#4e4033', spacing: 0.12, upper: false }
      case 'range':
        return { font: `italic 600 ${14.5 * k}px ${SERIF}`, color: '#6c533c', spacing: 0.36, upper: true }
      case 'basin':
      case 'desert':
        return { font: `italic 500 ${15 * k}px ${SERIF}`, color: '#7a6246', spacing: 0.22, upper: false }
      case 'forest':
        return { font: `italic 500 ${15 * k}px ${SERIF}`, color: '#50653f', spacing: 0.22, upper: false }
      case 'lake':
        return { font: `italic 500 ${12.5 * k}px ${SERIF}`, color: '#44697a', spacing: 0.05, upper: false }
      case 'capital':
        return { font: `700 ${15.5 * k}px ${SERIF}`, color: '#2f2b27', spacing: 0.04, upper: false }
      default:
        return { font: `500 ${13.5 * k}px ${SERIF}`, color: '#36322d', spacing: 0.03, upper: false }
    }
  }

  const drawText = (text: string, x: number, y: number, angle: number, st: ReturnType<typeof style>, halo: boolean, place: boolean) => {
    ctx.font = st.font
    const t = st.upper ? text.toUpperCase() : text
    const size = parseFloat(st.font.match(/([\d.]+)px/)![1])
    const sp = st.spacing * size
    const widths = [...t].map((ch) => ctx.measureText(ch).width)
    const total = widths.reduce((a, b) => a + b, 0) + sp * (t.length - 1)
    // 旋转后的外接框
    const c = Math.abs(Math.cos(angle))
    const s = Math.abs(Math.sin(angle))
    const bw = total * c + size * s
    const bh = total * s + size * c
    const box = { x0: x - bw / 2 - 3, y0: y - bh / 2 - 3, x1: x + bw / 2 + 3, y1: y + bh / 2 + 3 }
    if (place && (hit(box) || !inside(box))) return false
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.textBaseline = 'middle'
    let cx = -total / 2
    for (let i = 0; i < t.length; i++) {
      if (halo) {
        ctx.lineWidth = 3.2 * k
        ctx.strokeStyle = 'rgba(241, 234, 216, 0.72)'
        ctx.lineJoin = 'round'
        ctx.strokeText(t[i], cx, 0)
      }
      ctx.fillStyle = st.color
      ctx.fillText(t[i], cx, 0)
      cx += widths[i] + sp
    }
    ctx.restore()
    if (place) placed.push(box)
    return true
  }

  const order: Label['kind'][] = ['ocean', 'continent', 'capital', 'range', 'sea', 'city', 'island', 'lake', 'desert', 'basin', 'forest']
  const labels = [...world.labels].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.weight - a.weight)
  for (const l of labels) {
    const st = style(l)
    const x = l.x * S
    const y = l.y * S
    if (l.kind === 'city' || l.kind === 'capital') {
      const r = (l.kind === 'capital' ? 4.2 : 2.6) * k
      const dot: Box = { x0: x - r - 1, y0: y - r - 1, x1: x + r + 1, y1: y + r + 1 }
      if (hit(dot)) continue
      // 尝试四个方位放字
      ctx.font = st.font
      const tw = ctx.measureText(l.name).width + st.spacing * 14 * l.name.length
      const size = parseFloat(st.font.match(/([\d.]+)px/)![1])
      const cands = [
        [x + r + 4 * k + tw / 2, y],
        [x - r - 4 * k - tw / 2, y],
        [x, y - r - size * 0.7],
        [x, y + r + size * 0.7],
      ]
      let ok = false
      for (const [cx, cy] of cands) {
        const box = { x0: cx - tw / 2 - 2, y0: cy - size / 2 - 2, x1: cx + tw / 2 + 2, y1: cy + size / 2 + 2 }
        if (hit(box) || !inside(box)) continue
        placed.push(dot)
        drawText(l.name, cx, cy, 0, st, true, true)
        ok = true
        break
      }
      if (!ok) continue
      ctx.save()
      if (l.kind === 'capital') {
        ctx.fillStyle = '#f4ecd9'
        ctx.strokeStyle = '#2f2b27'
        ctx.lineWidth = 1.4 * k
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = '#2f2b27'
        ctx.beginPath()
        ctx.arc(x, y, r * 0.45, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.fillStyle = '#2f2b27'
        ctx.strokeStyle = '#f1ead8'
        ctx.lineWidth = 1.2 * k
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      ctx.restore()
      continue
    }
    const halo = l.kind !== 'ocean' && l.kind !== 'sea' && l.kind !== 'continent'
    // 放不下时在附近找几个候选位置
    const r = Math.max(30 * k, Math.min(120 * k, l.span * S * 0.25))
    const offs = [[0, 0], [0, -r * 0.5], [0, r * 0.5], [-r, 0], [r, 0], [-r, -r * 0.6], [r, r * 0.6], [r, -r * 0.6], [-r, r * 0.6]]
    for (const [ox, oy] of offs) {
      const i = Math.round(l.y + oy / S) * world.W + Math.round(l.x + ox / S)
      const water = l.kind === 'ocean' || l.kind === 'sea'
      if (water && !(world.elevation[i] < 0)) continue
      if (drawText(l.name, x + ox, y + oy, l.angle, st, halo, true)) break
    }
  }
}

function drawCompass(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.strokeStyle = 'rgba(58,66,70,0.75)'
  ctx.lineWidth = r * 0.025
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2)
  ctx.stroke()
  // 刻度
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2
    const l = k % 8 === 0 ? 0.62 : k % 4 === 0 ? 0.66 : 0.68
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7)
    ctx.lineTo(Math.cos(a) * r * l, Math.sin(a) * r * l)
    ctx.stroke()
  }
  // 星芒
  const point = (a: number, len: number, w: number) => {
    const ca = Math.cos(a), sa = Math.sin(a)
    const px = -sa, py = ca
    for (const side of [1, -1]) {
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(ca * len, sa * len)
      ctx.lineTo(px * w * side, py * w * side)
      ctx.closePath()
      ctx.fillStyle = side === 1 ? 'rgba(58,66,70,0.85)' : 'rgba(241,234,216,0.95)'
      ctx.fill()
      ctx.stroke()
    }
  }
  for (let k = 0; k < 4; k++) point(Math.PI / 4 + (k * Math.PI) / 2, r * 0.5, r * 0.07)
  for (let k = 0; k < 4; k++) point(-Math.PI / 2 + (k * Math.PI) / 2, r * 0.95, r * 0.12)
  ctx.fillStyle = 'rgba(58,66,70,0.9)'
  ctx.font = `600 ${r * 0.34}px ${SERIF}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText('N', 0, -r * 0.98)
  ctx.restore()
}

function drawScaleBar(ctx: CanvasRenderingContext2D, world: World, S: number, x: number, y: number) {
  const k = S / 2
  const kmPx = world.kmPerCell / S
  const target = 240 * k * kmPx
  const nice = [100, 200, 250, 500, 1000, 2000]
  const kmLen = nice.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
  const len = kmLen / kmPx
  ctx.save()
  ctx.translate(x - len / 2, y)
  ctx.strokeStyle = 'rgba(58,66,70,0.85)'
  ctx.lineWidth = 1 * k
  const segs = 4
  for (let s = 0; s < segs; s++) {
    ctx.fillStyle = s % 2 ? 'rgba(241,234,216,0.9)' : 'rgba(58,66,70,0.85)'
    ctx.fillRect((len / segs) * s, 0, len / segs, 5 * k)
  }
  ctx.strokeRect(0, 0, len, 5 * k)
  ctx.fillStyle = 'rgba(58,66,70,0.9)'
  ctx.font = `500 ${11 * k}px ${SERIF}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  for (let s = 0; s <= segs; s += 2) ctx.fillText(`${(kmLen / segs) * s}`, (len / segs) * s, -3 * k)
  ctx.textAlign = 'left'
  ctx.fillText('km', len + 5 * k, 7 * k)
  ctx.restore()
}

function drawCartouche(ctx: CanvasRenderingContext2D, world: World, S: number) {
  const k = S / 2
  ctx.save()
  ctx.translate(28 * k, 26 * k)
  ctx.fillStyle = 'rgba(241, 234, 216, 0.82)'
  ctx.strokeStyle = 'rgba(58,66,70,0.7)'
  ctx.lineWidth = 1 * k
  const w = 330 * k
  const h = 84 * k
  ctx.fillRect(0, 0, w, h)
  ctx.strokeRect(0, 0, w, h)
  ctx.strokeRect(4 * k, 4 * k, w - 8 * k, h - 8 * k)
  ctx.fillStyle = '#3a3530'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `600 ${32 * k}px ${SERIF}`
  const title = world.worldName.toUpperCase()
  const sp = 0.3 * 32 * k
  const ws = [...title].map((c) => ctx.measureText(c).width)
  const tot = ws.reduce((a, b) => a + b, 0) + sp * (title.length - 1)
  let cx = w / 2 - tot / 2
  ctx.textAlign = 'left'
  for (let i = 0; i < title.length; i++) {
    ctx.fillText(title[i], cx, 44 * k)
    cx += ws[i] + sp
  }
  ctx.textAlign = 'center'
  ctx.font = `italic 500 ${13 * k}px ${SERIF}`
  ctx.fillStyle = '#5b544b'
  ctx.fillText(`A physical map of the known world · seed “${world.params.seed}”`, w / 2, 66 * k)
  ctx.restore()
}

/** 图框：外粗线 + 黑白相间的经纬度分划 + 边缘度数注记 */
function drawFrame(ctx: CanvasRenderingContext2D, world: World, S: number, M: number, MW: number, MH: number) {
  const k = S / 2
  const p = world.params
  ctx.save()
  ctx.strokeStyle = '#3a4246'
  ctx.lineWidth = 1.2 * k
  ctx.strokeRect(M, M, MW, MH)
  const bw = 7 * k
  ctx.strokeRect(M - bw, M - bw, MW + bw * 2, MH + bw * 2)
  ctx.lineWidth = 2.4 * k
  ctx.strokeRect(M - bw - 6 * k, M - bw - 6 * k, MW + bw * 2 + 12 * k, MH + bw * 2 + 12 * k)
  // 纬度分划（每 2°）
  const H = world.H
  const W = world.W
  const top = p.latNorth
  const bot = p.latSouth
  const yOf = (lat: number) => M + ((lat - top) / (bot - top)) * (H - 1) * S
  const lo = Math.min(top, bot)
  const hi = Math.max(top, bot)
  let flip = false
  for (let lat = Math.floor(hi / 2) * 2; lat > lo; lat -= 2) {
    const y0 = yOf(lat)
    const y1 = yOf(Math.max(lo, lat - 2))
    ctx.fillStyle = flip ? '#f1ead8' : '#3a4246'
    ctx.fillRect(M - bw, Math.min(y0, y1), bw, Math.abs(y1 - y0))
    ctx.fillRect(M + MW, Math.min(y0, y1), bw, Math.abs(y1 - y0))
    flip = !flip
  }
  const ls = lonScale(world)
  const lonHalf = (W / 2) * ls
  const xOf = (lon: number) => M + (lon / ls + W / 2) * S
  flip = false
  for (let lon = Math.floor(-lonHalf / 2) * 2; lon < lonHalf; lon += 2) {
    const x0 = Math.max(M, xOf(lon))
    const x1 = Math.min(M + MW, xOf(lon + 2))
    if (x1 <= x0) continue
    ctx.fillStyle = flip ? '#f1ead8' : '#3a4246'
    ctx.fillRect(x0, M - bw, x1 - x0, bw)
    ctx.fillRect(x0, M + MH, x1 - x0, bw)
    flip = !flip
  }
  ctx.lineWidth = 0.8 * k
  ctx.strokeRect(M - bw, M - bw, MW + bw * 2, MH + bw * 2)
  // 注记
  ctx.fillStyle = '#3a4246'
  ctx.font = `500 ${11 * k}px ${SERIF}`
  ctx.textBaseline = 'middle'
  for (let lat = Math.ceil(lo / 10) * 10; lat <= hi; lat += 10) {
    const y = yOf(lat)
    const t = `${Math.abs(lat)}°${lat > 0 ? 'N' : lat < 0 ? 'S' : ''}`
    ctx.textAlign = 'right'
    ctx.fillText(t, M - bw - 9 * k, y)
    ctx.textAlign = 'left'
    ctx.fillText(t, M + MW + bw + 9 * k, y)
  }
  ctx.textAlign = 'center'
  for (let lon = Math.ceil(-lonHalf / 10) * 10; lon <= lonHalf; lon += 10) {
    const x = xOf(lon)
    const t = `${Math.abs(lon)}°${lon > 0 ? 'E' : lon < 0 ? 'W' : ''}`
    ctx.fillText(t, x, M - bw - 12 * k)
    ctx.fillText(t, x, M + MH + bw + 12 * k)
  }
  ctx.restore()
}
