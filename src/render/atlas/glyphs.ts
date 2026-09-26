import { Biome } from '../../gen/types'
import { riverThreshold } from '../../gen/world'
import { hash, type Fields } from './fields'

interface Opt {
  ink: string
  paper: string
  shadow: string
}

/** 空间哈希：泊松盘采样用的最小间距检查 */
class Occupancy {
  private cells = new Map<number, [number, number, number][]>()
  constructor(private size: number) {}
  private key(x: number, y: number) {
    return Math.floor(x / this.size) * 65536 + Math.floor(y / this.size)
  }
  free(x: number, y: number, r: number) {
    const cx = Math.floor(x / this.size)
    const cy = Math.floor(y / this.size)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const list = this.cells.get((cx + dx) * 65536 + cy + dy)
        if (!list) continue
        for (const [px, py, pr] of list) if (Math.hypot(px - x, py - y) < Math.max(r, pr)) return false
      }
    }
    return true
  }
  add(x: number, y: number, r: number) {
    const k = this.key(x, y)
    const l = this.cells.get(k)
    if (l) l.push([x, y, r])
    else this.cells.set(k, [[x, y, r]])
  }
}

/**
 * 奇幻地图的手绘符号：山峰（背光面排线）、丘陵、树林、沙漠点彩、沼泽草丛。
 * 符号按纵坐标从后往前绘制，前面的符号用纸色填充遮挡后面的。
 */
export function drawGlyphs(ctx: CanvasRenderingContext2D, f: Fields, o: Opt) {
  const { world, S, W, H } = f
  const e = world.elevation
  const k = S / 2
  const occ = new Occupancy(14 * k)
  const thr = riverThreshold(W)
  type G = { x: number; y: number; kind: 'mountain' | 'hill' | 'tree' | 'conifer' | 'palm'; s: number; seed: number }
  const glyphs: G[] = []

  const landAt = (x: number, y: number) => {
    const gx = Math.round(x / S)
    const gy = Math.round(y / S)
    if (gx < 1 || gy < 1 || gx >= W - 1 || gy >= H - 1) return false
    const i = gy * W + gx
    return e[i] > 0.01 && world.biome[i] !== Biome.Lake
  }

  // —— 山峰：从高到低，泊松盘间距随尺寸变化 ——
  // 起伏度：5×5 邻域的高差，高而平的高原不画山
  const relief = new Float32Array(W * H)
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      let lo = Infinity
      let hi = -Infinity
      for (let dy = -2; dy <= 2; dy += 2) {
        for (let dx = -2; dx <= 2; dx += 2) {
          const v = e[(y + dy) * W + x + dx]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      relief[y * W + x] = hi - lo
    }
  }
  const peaks: number[] = []
  for (let i = 0; i < W * H; i++) if (e[i] > 1.2 && relief[i] > 0.6) peaks.push(i)
  peaks.sort((a, b) => e[b] - e[a])
  for (const i of peaks) {
    const x = ((i % W) + 0.5) * S
    const y = (Math.floor(i / W) + 0.5) * S
    const h = e[i]
    const s = (9 + 16 * Math.min(1, (h - 1.2) / 4)) * k
    if (!occ.free(x, y, s * 1.15)) continue
    if (!landAt(x - s * 0.8, y) || !landAt(x + s * 0.8, y)) continue
    occ.add(x, y, s * 0.95)
    glyphs.push({ x, y, kind: 'mountain', s, seed: i })
  }
  // —— 丘陵：中等海拔且起伏明显处 ——
  for (let y = 2; y < H - 2; y += 2) {
    for (let x = 2; x < W - 2; x += 2) {
      const i = y * W + x
      const h = e[i]
      if (h < 0.35) continue
      if (relief[i] < 0.18 || hash(x, y) > 0.35) continue
      const px = (x + hash(x + 1, y) - 0.5) * S
      const py = (y + hash(x, y + 1) - 0.5) * S
      const s = 5.5 * k
      if (!occ.free(px, py, s * 1.5)) continue
      occ.add(px, py, s * 1.3)
      glyphs.push({ x: px, y: py, kind: 'hill', s, seed: i })
    }
  }
  // —— 树林 ——
  const treeKind = (b: number, x: number, y: number): G['kind'] | null => {
    if (b === Biome.Taiga) return 'conifer'
    if (b === Biome.TemperateRainforest) return hash(x, y * 3) > 0.5 ? 'conifer' : 'tree'
    if (b === Biome.TemperateForest || b === Biome.TropicalSeasonalForest) return 'tree'
    if (b === Biome.TropicalRainforest) return 'palm'
    return null
  }
  const step = 3
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      if ((x * 7 + y * 13) % step) continue
      const i = y * W + x
      const kind = treeKind(world.biome[i], x, y)
      if (!kind || e[i] <= 0.01) continue
      if (world.flow[i] > thr * 0.6) continue
      const px = (x + hash(x, y) - 0.5) * S
      const py = (y + hash(y, x) - 0.5) * S
      const s = (kind === 'conifer' ? 3.4 : 3.1) * k
      if (!occ.free(px, py, s * 1.25)) continue
      occ.add(px, py, s * 1.1)
      glyphs.push({ x: px, y: py, kind, s, seed: i })
    }
  }

  // —— 沙漠点彩与沼泽草丛（底层，不参与遮挡） ——
  ctx.save()
  ctx.fillStyle = o.ink
  ctx.globalAlpha = 0.45
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const b = world.biome[i]
      if (b !== Biome.HotDesert && b !== Biome.ColdDesert) continue
      for (let t = 0; t < 2; t++) {
        if (hash(x * 3 + t, y * 5) > (b === Biome.HotDesert ? 0.5 : 0.25)) continue
        const px = (x + hash(x + t, y * 2) - 0.5) * S
        const py = (y + hash(x * 2, y + t) - 0.5) * S
        ctx.fillRect(px, py, 0.9 * k, 0.9 * k)
      }
    }
  }
  ctx.globalAlpha = 0.7
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.7 * k
  ctx.beginPath()
  for (let y = 2; y < H - 2; y += 3) {
    for (let x = 2; x < W - 2; x += 3) {
      const i = y * W + x
      if (world.biome[i] !== Biome.Wetland || hash(x, y) > 0.6) continue
      const px = (x + hash(x, y + 9) - 0.5) * S
      const py = (y + hash(x + 9, y) - 0.5) * S
      for (const a of [-0.5, 0, 0.5]) {
        ctx.moveTo(px, py)
        ctx.lineTo(px + Math.sin(a) * 3 * k, py - Math.cos(a) * 3.2 * k)
      }
      ctx.moveTo(px - 3 * k, py)
      ctx.lineTo(px + 3 * k, py)
    }
  }
  ctx.stroke()
  ctx.restore()

  // —— 按纵坐标绘制遮挡符号 ——
  glyphs.sort((a, b) => a.y - b.y)
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const g of glyphs) {
    if (g.kind === 'mountain') mountain(ctx, g.x, g.y, g.s, g.seed, o, k)
    else if (g.kind === 'hill') hill(ctx, g.x, g.y, g.s, o, k)
    else tree(ctx, g.x, g.y, g.s, g.kind, o, k)
  }
  ctx.restore()
}

function mountain(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number, o: Opt, k: number) {
  const w = s * (0.75 + hash(seed, 1) * 0.25)
  const h = s * (0.95 + hash(seed, 2) * 0.45)
  const jx = (hash(seed, 3) - 0.5) * w * 0.35
  const px = x + jx
  const py = y - h
  // 山体（纸色遮挡）
  ctx.beginPath()
  ctx.moveTo(x - w, y)
  ctx.quadraticCurveTo(x - w * 0.45, y - h * 0.45, px, py)
  ctx.quadraticCurveTo(x + w * 0.4, y - h * 0.5, x + w, y)
  ctx.closePath()
  ctx.fillStyle = o.paper
  ctx.fill()
  // 背光面
  ctx.beginPath()
  ctx.moveTo(px, py)
  ctx.quadraticCurveTo(x + w * 0.4, y - h * 0.5, x + w, y)
  ctx.lineTo(x + w * 0.1, y)
  ctx.quadraticCurveTo(px + w * 0.05, y - h * 0.45, px, py)
  ctx.fillStyle = o.shadow
  ctx.fill()
  // 排线
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.6 * k
  ctx.beginPath()
  const n = Math.max(2, Math.round(s / (3 * k)))
  for (let t = 1; t <= n; t++) {
    const u = t / (n + 1)
    const ex = px + (x + w - px) * u
    const ey = py + (y - py) * u
    ctx.moveTo(ex, ey)
    ctx.lineTo(ex - w * 0.28, ey + h * 0.18)
  }
  ctx.stroke()
  // 轮廓
  ctx.lineWidth = 1.05 * k
  ctx.beginPath()
  ctx.moveTo(x - w, y)
  ctx.quadraticCurveTo(x - w * 0.45, y - h * 0.45, px, py)
  ctx.quadraticCurveTo(x + w * 0.4, y - h * 0.5, x + w, y)
  ctx.stroke()
  // 山脊线
  ctx.lineWidth = 0.7 * k
  ctx.beginPath()
  ctx.moveTo(px, py)
  ctx.quadraticCurveTo(px + w * 0.08, y - h * 0.4, x + w * 0.1, y - h * 0.05)
  ctx.stroke()
}

function hill(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, o: Opt, k: number) {
  ctx.beginPath()
  ctx.moveTo(x - s, y)
  ctx.quadraticCurveTo(x, y - s * 1.15, x + s, y)
  ctx.fillStyle = o.paper
  ctx.fill()
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.9 * k
  ctx.stroke()
  ctx.lineWidth = 0.55 * k
  ctx.beginPath()
  ctx.moveTo(x + s * 0.35, y - s * 0.35)
  ctx.lineTo(x + s * 0.15, y - s * 0.05)
  ctx.moveTo(x + s * 0.65, y - s * 0.2)
  ctx.lineTo(x + s * 0.48, y)
  ctx.stroke()
}

function tree(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, kind: string, o: Opt, k: number) {
  ctx.strokeStyle = o.ink
  ctx.fillStyle = o.paper
  ctx.lineWidth = 0.75 * k
  if (kind === 'conifer') {
    ctx.beginPath()
    ctx.moveTo(x, y - s * 2)
    ctx.lineTo(x + s * 0.75, y - s * 0.2)
    ctx.lineTo(x - s * 0.75, y - s * 0.2)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x, y - s * 0.2)
    ctx.lineTo(x, y + s * 0.25)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x + s * 0.1, y - s * 1.6)
    ctx.lineTo(x + s * 0.55, y - s * 0.35)
    ctx.lineTo(x + s * 0.1, y - s * 0.35)
    ctx.fillStyle = o.shadow
    ctx.fill()
    return
  }
  const r = kind === 'palm' ? s * 0.95 : s * 0.8
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.3)
  ctx.lineTo(x, y - s * 0.4)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y - s * 0.4 - r, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  // 右下的阴影月牙
  ctx.beginPath()
  ctx.arc(x, y - s * 0.4 - r, r * 0.78, -0.2, Math.PI * 0.7)
  ctx.strokeStyle = o.shadow
  ctx.lineWidth = r * 0.35
  ctx.stroke()
}
