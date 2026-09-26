import { Biome } from '../../gen/types'
import { riverThreshold } from '../../gen/world'
import { hash, type Fields } from './fields'

export interface GlyphColors {
  ink: string
  /** 山体、丘陵的受光面 */
  paper: string
  /** 山体背光面 */
  shadow: string
  snow: string
  /** 阔叶树冠：受光 / 背光 */
  leaf: string
  leafDark: string
  /** 针叶树 */
  pine: string
  pineDark: string
  /** 草丛、沙丘等平铺笔触 */
  grass: string
}

type P = [number, number]

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

type Kind = 'mountain' | 'hill' | 'tree' | 'jungle' | 'conifer' | 'acacia' | 'bush'
interface G {
  x: number
  y: number
  kind: Kind
  s: number
  seed: number
  /** 山峰：海拔的相对高低 0~1 */
  t?: number
}

/**
 * 奇幻地图的手绘符号：
 * - 遮挡符号（山、丘、树）按纵坐标从后往前画，前面的用底色盖住后面的，连成山脉与林冠；
 * - 平铺笔触（草丛、沙丘、沼泽、点彩）先画在最底层。
 */
export function drawGlyphs(ctx: CanvasRenderingContext2D, f: Fields, o: GlyphColors) {
  const { world, S, W, H } = f
  const e = world.elevation
  const bio = world.biome
  const k = S / 2
  const occ = new Occupancy(14 * k)
  const thr = riverThreshold(W)
  const glyphs: G[] = []

  const cell = (x: number, y: number) => {
    const gx = Math.round(x / S)
    const gy = Math.round(y / S)
    if (gx < 1 || gy < 1 || gx >= W - 1 || gy >= H - 1) return -1
    return gy * W + gx
  }
  const landAt = (x: number, y: number) => {
    const i = cell(x, y)
    return i >= 0 && e[i] > 0.01 && bio[i] !== Biome.Lake
  }
  const wet = (i: number) => world.flow[i] > thr * 0.5
  /** 符号底边一带（锚点左右、稍靠上）有没有画出来的河 */
  const wetNear = (x: number, y: number, hw: number) => {
    for (const [dx, dy] of [[0, 0], [-hw, 0], [hw, 0], [-hw * 0.5, -hw * 0.4], [hw * 0.5, -hw * 0.4], [0, -hw * 0.6]]) {
      const i = cell(x + dx, y + dy)
      if (i >= 0 && world.flow[i] > thr * 1.5) return true
    }
    return false
  }

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

  // —— 山峰：从高到低；间距小于符号宽度，相互遮叠成山脉 ——
  const peaks: number[] = []
  for (let i = 0; i < W * H; i++) if (e[i] > 1.25 && relief[i] > 0.7) peaks.push(i)
  peaks.sort((a, b) => e[b] - e[a])
  for (const i of peaks) {
    const x = ((i % W) + 0.5 + (hash(i, 5) - 0.5) * 0.8) * S
    const y = (Math.floor(i / W) + 0.5 + (hash(i, 6) - 0.5) * 0.8) * S
    const t = Math.min(1, (e[i] - 1.25) / 3.4)
    const s = (8.5 + 17.5 * t) * k
    if (!occ.free(x, y, s * 0.85)) continue
    if (!landAt(x - s * 0.8, y) || !landAt(x + s * 0.8, y)) continue
    if (wetNear(x, y, s * 0.7)) continue
    occ.add(x, y, s * 0.72)
    glyphs.push({ x, y, kind: 'mountain', s, seed: i, t })
  }
  // —— 丘陵：与山峰同一套画法的"矮山"，尖度与大小随起伏度连续变化；每处 1~3 座成簇 ——
  for (let y = 2; y < H - 2; y += 2) {
    for (let x = 2; x < W - 2; x += 2) {
      const i = y * W + x
      if (e[i] < 0.25 || relief[i] < 0.26 || hash(x, y) > 0.55 || wet(i)) continue
      const px = (x + hash(x + 1, y) - 0.5) * S
      const py = (y + hash(x, y + 1) - 0.5) * S
      const t = Math.min(1, (relief[i] - 0.26) / 0.5)
      const s = (7 + 3.5 * t) * k
      if (!occ.free(px, py, s * 2.3)) continue
      occ.add(px, py, s * 1.9)
      const n = 1 + Math.floor(hash(x * 5, y * 3) * 2.6)
      const side = hash(x, y * 5) > 0.5 ? 1 : -1
      const members: [number, number, number][] = [
        [0, 0, 1],
        [side * 1.15, -0.4, 0.78],
        [-side * 0.95, 0.3, 0.62],
      ]
      for (const [dx, dy, m] of members.slice(0, n)) {
        const hx = px + dx * s
        const hy = py + dy * s
        if (!landAt(hx - s * m, hy) || !landAt(hx + s * m, hy) || wetNear(hx, hy, s * m)) continue
        glyphs.push({ x: hx, y: hy, kind: 'hill', s: s * m, seed: i * 3 + n, t })
      }
    }
  }
  // —— 树林：密排、相互遮叠 ——
  const treeKind = (b: number, x: number, y: number): Kind | null => {
    if (b === Biome.Taiga) return 'conifer'
    if (b === Biome.TemperateRainforest) return hash(x, y * 3) > 0.45 ? 'conifer' : 'tree'
    if (b === Biome.TemperateForest) return hash(x * 5, y) > 0.85 ? 'conifer' : 'tree'
    if (b === Biome.TropicalSeasonalForest) return 'tree'
    if (b === Biome.TropicalRainforest) return 'jungle'
    return null
  }
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if ((x + y * 2) % 2) continue
      const i = y * W + x
      const kind = treeKind(bio[i], x, y)
      if (!kind || e[i] <= 0.01 || wet(i)) continue
      const px = (x + (hash(x, y) - 0.5) * 1.6) * S
      const py = (y + (hash(y, x) - 0.5) * 1.6) * S
      const s = (kind === 'jungle' ? 3.6 : 3.1 + hash(x * 3, y) * 0.7) * k
      if (!occ.free(px, py, s * 1.05)) continue
      occ.add(px, py, s * 0.95)
      glyphs.push({ x: px, y: py, kind, s, seed: i })
    }
  }
  // —— 稀树草原上的金合欢、灌丛里的矮灌木 ——
  for (let y = 2; y < H - 2; y += 3) {
    for (let x = 2; x < W - 2; x += 3) {
      const i = y * W + x
      const b = bio[i]
      const kind: Kind | null =
        b === Biome.Savanna && hash(x * 7, y) < 0.16 ? 'acacia' : b === Biome.Shrubland && hash(x, y * 7) < 0.3 ? 'bush' : null
      if (!kind || e[i] <= 0.01 || wet(i)) continue
      const px = (x + (hash(x + 3, y) - 0.5) * 2) * S
      const py = (y + (hash(x, y + 3) - 0.5) * 2) * S
      const s = (kind === 'acacia' ? 3.6 : 2.4) * k
      if (!occ.free(px, py, s * 1.6)) continue
      occ.add(px, py, s * 1.4)
      glyphs.push({ x: px, y: py, kind, s, seed: i })
    }
  }

  // —— 平铺笔触（底层，不参与遮挡） ——
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  flatMarks(ctx, f, o, k, wet)
  ctx.restore()

  // —— 按纵坐标绘制遮挡符号 ——
  glyphs.sort((a, b) => a.y - b.y)
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const g of glyphs) {
    switch (g.kind) {
      case 'mountain':
        mountain(ctx, g, o, k)
        break
      case 'hill':
        hill(ctx, g, o, k)
        break
      case 'conifer':
        conifer(ctx, g, o, k)
        break
      case 'acacia':
        acacia(ctx, g, o, k)
        break
      case 'bush':
        bush(ctx, g, o, k)
        break
      default:
        tree(ctx, g, o, k)
    }
  }
  ctx.restore()
}

// ———————————————————————— 平铺笔触 ————————————————————————

function flatMarks(ctx: CanvasRenderingContext2D, f: Fields, o: GlyphColors, k: number, wet: (i: number) => boolean) {
  const { world, S, W, H } = f
  const e = world.elevation
  const bio = world.biome
  const jit = (x: number, y: number, t: number): P => [(x + (hash(x * 13 + t, y) - 0.5) * 3) * S, (y + (hash(x, y * 11 + t) - 0.5) * 3) * S]

  // 草丛：三到五笔向上散开的短弧；密度随群系变化
  const tuftDensity: Partial<Record<number, number>> = {
    [Biome.Grassland]: 0.62,
    [Biome.Savanna]: 0.45,
    [Biome.Shrubland]: 0.22,
    [Biome.Tundra]: 0.2,
    [Biome.Alpine]: 0.12,
  }
  ctx.strokeStyle = o.grass
  ctx.lineWidth = 0.6 * k
  ctx.globalAlpha = 0.75
  ctx.beginPath()
  for (let y = 3; y < H - 3; y += 3) {
    for (let x = 3 + (y % 2) * 1; x < W - 3; x += 3) {
      const i = y * W + x
      const d = tuftDensity[bio[i]]
      if (!d || e[i] <= 0.02 || wet(i) || hash(x * 3, y * 5) > d) continue
      const [px, py] = jit(x, y, 1)
      const tundra = bio[i] === Biome.Tundra || bio[i] === Biome.Alpine
      const s = (tundra ? 2 : 2.6 + hash(x, y * 9) * 1.2) * k
      const n = tundra ? 2 : 3 + Math.floor(hash(x * 9, y) * 3)
      const lean = (hash(x * 5, y * 7) - 0.5) * 0.4
      for (let j = 0; j < n; j++) {
        const a = lean + (j / (n - 1) - 0.5) * 1.3
        const l = s * (1 - Math.abs(j / (n - 1) - 0.5) * 0.7)
        const bx = px + (j - (n - 1) / 2) * 0.5 * k
        ctx.moveTo(bx, py)
        ctx.quadraticCurveTo(bx + Math.sin(a) * l * 0.3, py - l * 0.6, bx + Math.sin(a) * l, py - Math.cos(a) * l)
      }
      // 草根处的一小横
      ctx.moveTo(px - s * 0.45, py)
      ctx.lineTo(px + s * 0.45, py)
    }
  }
  ctx.stroke()

  // 沙丘：新月形的脊线 + 背风坡的短排线
  ctx.lineWidth = 0.7 * k
  ctx.globalAlpha = 0.7
  ctx.beginPath()
  for (let y = 3; y < H - 3; y += 4) {
    for (let x = 3 + (y % 8 ? 2 : 0); x < W - 3; x += 5) {
      const i = y * W + x
      if (bio[i] !== Biome.HotDesert || hash(x * 7, y * 3) > 0.55) continue
      const [px, py] = jit(x, y, 2)
      const s = (4.5 + hash(x, y) * 3) * k
      ctx.moveTo(px - s, py + s * 0.1)
      ctx.quadraticCurveTo(px - s * 0.2, py - s * 0.55, px + s, py)
      for (let j = 1; j <= 3; j++) {
        const u = 0.25 + j * 0.17
        const cx = px - s + 2 * s * u
        const cy = py + s * 0.1 - (1 - (2 * u - 1) ** 2) * s * 0.28
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx + s * 0.12, cy + s * 0.22)
      }
    }
  }
  ctx.stroke()

  // 点彩：沙漠、盐滩、冷荒漠
  ctx.fillStyle = o.ink
  ctx.globalAlpha = 0.4
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const b = bio[y * W + x]
      const p = b === Biome.HotDesert ? 0.45 : b === Biome.ColdDesert ? 0.35 : b === Biome.SaltFlat ? 0.2 : 0
      if (!p) continue
      for (let t = 0; t < 2; t++) {
        if (hash(x * 3 + t, y * 5) > p) continue
        ctx.fillRect((x + hash(x + t, y * 2) - 0.5) * S, (y + hash(x * 2, y + t) - 0.5) * S, 0.9 * k, 0.9 * k)
      }
    }
  }

  // 沼泽：芦苇 + 下方两道水纹
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.6 * k
  ctx.globalAlpha = 0.7
  ctx.beginPath()
  for (let y = 2; y < H - 2; y += 3) {
    for (let x = 2; x < W - 2; x += 3) {
      if (bio[y * W + x] !== Biome.Wetland || hash(x, y) > 0.6) continue
      const [px, py] = jit(x, y, 3)
      for (const a of [-0.35, 0, 0.35]) {
        ctx.moveTo(px + a * 2 * k, py)
        ctx.lineTo(px + a * 4 * k, py - (a ? 3 : 4) * k)
      }
      ctx.moveTo(px - 4 * k, py + 0.3 * k)
      ctx.lineTo(px + 4 * k, py + 0.3 * k)
      ctx.moveTo(px - 2 * k, py + 1.8 * k)
      ctx.lineTo(px + 2.6 * k, py + 1.8 * k)
    }
  }
  ctx.stroke()
  ctx.globalAlpha = 1
}

// ———————————————————————— 遮挡符号 ————————————————————————

function poly(ctx: CanvasRenderingContext2D, pts: P[], close = true) {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  if (close) ctx.closePath()
}

/** 折线上纵坐标为 y 处的横坐标（折线自上而下） */
function xAtY(line: P[], y: number) {
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1]
    const [x1, y1] = line[i]
    if (y <= y1 || i === line.length - 1) return x0 + ((x1 - x0) * Math.min(1, Math.max(0, (y - y0) / (y1 - y0 || 1))))
  }
  return line[line.length - 1][0]
}

/**
 * 山峰：嶙峋的折线轮廓（带肩部与次峰），右侧背光面填暗色并沿坡向排线，
 * 中间一条山脊线分开明暗；高峰加一顶锯齿状雪冠。
 */
function mountain(ctx: CanvasRenderingContext2D, g: G, o: GlyphColors, k: number) {
  const { x, y, s, seed } = g
  const t = g.t ?? 0
  const r = (i: number) => hash(seed, i)
  const w = s * (0.72 + r(1) * 0.42)
  const h = s * (0.95 + r(2) * 0.4 + t * 0.35)
  const P: P = [x + (r(3) - 0.5) * w * 0.3, y - h]
  const left: P[] = [
    [x - w, y],
    [x - w * 0.62, y - h * (0.28 + r(4) * 0.1)],
    [x - w * 0.42 + (r(5) - 0.5) * w * 0.08, y - h * (0.46 + r(6) * 0.12)],
    [P[0] - w * 0.2, P[1] + h * (0.2 + r(7) * 0.1)],
    P,
  ]
  // 右坡：偶尔带一座次峰
  const sub = r(8) > 0.55
  const right: P[] = sub
    ? [P, [P[0] + w * 0.2, P[1] + h * 0.3], [P[0] + w * 0.38, P[1] + h * 0.2], [x + w * 0.62, y - h * 0.38], [x + w, y]]
    : [P, [P[0] + w * 0.22, P[1] + h * (0.22 + r(9) * 0.1)], [x + w * 0.55, y - h * (0.3 + r(10) * 0.1)], [x + w, y]]
  const ridge: P[] = [P, [P[0] + w * 0.04, P[1] + h * 0.35], [P[0] + w * (0.02 + r(11) * 0.1), P[1] + h * 0.7], [x + w * (0.12 + r(12) * 0.1), y]]
  // 山体底色：山脚向下微鼓，免得一排排平直的底边把背景切成方块
  poly(ctx, [...left, ...right.slice(1)], false)
  ctx.quadraticCurveTo(x, y + h * 0.16, x - w, y)
  ctx.closePath()
  ctx.fillStyle = o.paper
  ctx.fill()
  // 背光面
  poly(ctx, [...right, ...[...ridge].reverse().slice(0, -1)])
  ctx.fillStyle = o.shadow
  ctx.fill()
  // 雪冠
  if (t > 0.45) {
    const d = h * (0.22 + (t - 0.45) * 0.25)
    const yl = P[1] + d
    const lx = xAtY(left.slice().reverse(), yl)
    const rx = xAtY(right, yl + h * 0.04)
    const rgx = xAtY(ridge, yl + h * 0.05)
    const zig: P[] = []
    const n = 4
    for (let j = 1; j < n; j++) zig.push([rx + ((lx - rx) * j) / n, yl + (j % 2 ? h * 0.07 : -h * 0.01)])
    poly(ctx, [P, [rx, yl + h * 0.04], ...zig, [lx, yl]])
    ctx.fillStyle = o.snow
    ctx.fill()
    poly(ctx, [P, [rx, yl + h * 0.04], [rgx, yl + h * 0.06]])
    ctx.fillStyle = o.shadow
    ctx.globalAlpha = 0.45
    ctx.fill()
    ctx.globalAlpha = 1
  }
  // 背光面排线：从右坡斜向下伸向山脊
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.55 * k
  ctx.beginPath()
  const n = Math.max(2, Math.round(h / (3.2 * k)))
  const y0 = P[1] + (t > 0.45 ? h * 0.35 : h * 0.12)
  for (let j = 0; j < n; j++) {
    const yy = y0 + ((y - h * 0.08 - y0) * j) / Math.max(1, n - 1)
    const sx = xAtY(right, yy)
    const ex = xAtY(ridge, yy + h * 0.1)
    if (sx - ex < 2 * k) continue
    ctx.moveTo(sx - 0.6 * k, yy)
    ctx.lineTo(sx - (sx - ex) * 0.78, yy + h * 0.1)
  }
  ctx.stroke()
  // 轮廓与山脊
  ctx.lineWidth = 1.05 * k
  poly(ctx, [...left, ...right.slice(1)], false)
  ctx.stroke()
  ctx.lineWidth = 0.7 * k
  poly(ctx, ridge.slice(0, 3), false)
  ctx.stroke()
  // 山脚的一笔地面线，顺着底边的弧度
  ctx.lineWidth = 0.6 * k
  ctx.beginPath()
  ctx.moveTo(x + w * 0.25, y + h * 0.06)
  ctx.quadraticCurveTo(x + w * 0.8, y + h * 0.04, x + w * 1.1, y - h * 0.02)
  ctx.stroke()
}

/**
 * 丘陵：与山峰同一套画法（阴坡填色 + 斜排线 + 山脊线），只是更矮更圆；
 * t 越大（起伏越强）顶越尖，向山麓小峰过渡。
 */
function hill(ctx: CanvasRenderingContext2D, g: G, o: GlyphColors, k: number) {
  const { x, y, s, seed } = g
  const t = g.t ?? 0
  const r = (i: number) => hash(seed, i)
  const w = s * (0.95 + r(1) * 0.3)
  const h = s * (0.58 + r(2) * 0.18 + t * 0.3)
  const P: P = [x + (r(3) - 0.5) * w * 0.35, y - h]
  // 控制点越低，顶越尖
  const cy = P[1] + h * (0.04 + 0.42 * t)
  const cl: P = [x - w * (0.5 - 0.15 * t), cy]
  const cr: P = [x + w * (0.5 - 0.15 * t), cy]
  const quad = (a: P, c: P, b: P, u: number): P => [
    (1 - u) * (1 - u) * a[0] + 2 * u * (1 - u) * c[0] + u * u * b[0],
    (1 - u) * (1 - u) * a[1] + 2 * u * (1 - u) * c[1] + u * u * b[1],
  ]
  const R: P = [x + w, y]
  const B: P = [x + w * (0.12 + r(4) * 0.12), y + h * 0.05]
  const rc: P = [P[0] + w * 0.1, y - h * 0.45]
  const outline = () => {
    ctx.beginPath()
    ctx.moveTo(x - w, y)
    ctx.quadraticCurveTo(cl[0], cl[1], P[0], P[1])
    ctx.quadraticCurveTo(cr[0], cr[1], R[0], R[1])
  }
  // 底色，山脚微鼓
  outline()
  ctx.quadraticCurveTo(x, y + h * 0.2, x - w, y)
  ctx.closePath()
  ctx.fillStyle = o.paper
  ctx.fill()
  // 阴坡
  ctx.beginPath()
  ctx.moveTo(P[0], P[1])
  ctx.quadraticCurveTo(cr[0], cr[1], R[0], R[1])
  ctx.quadraticCurveTo(x + w * 0.6, y + h * 0.14, B[0], B[1])
  ctx.quadraticCurveTo(rc[0], rc[1], P[0], P[1])
  ctx.closePath()
  ctx.fillStyle = o.shadow
  ctx.fill()
  // 排线：与山峰同向，从右坡斜向下伸向山脊
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.55 * k
  ctx.beginPath()
  const n = Math.max(1, Math.round(h / (3.4 * k)))
  for (let j = 0; j < n; j++) {
    const u = 0.3 + (0.55 * (j + 0.5)) / n
    const [sx, sy] = quad(P, cr, R, u)
    const [ex] = quad(P, rc, B, Math.min(1, u + 0.12))
    if (sx - ex < 2 * k) continue
    ctx.moveTo(sx - 0.6 * k, sy + 0.3 * k)
    ctx.lineTo(sx - (sx - ex) * 0.75, sy + h * 0.14)
  }
  ctx.stroke()
  // 轮廓与半截山脊
  outline()
  ctx.lineWidth = (0.85 + 0.2 * t) * k
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(P[0], P[1])
  ctx.quadraticCurveTo(P[0] + w * 0.06, P[1] + h * 0.3, P[0] + w * 0.08, P[1] + h * 0.55)
  ctx.lineWidth = 0.6 * k
  ctx.stroke()
}

/** 阔叶树：分瓣的树冠，先填暗色再向左上偏移叠一层亮色，形成右下的阴影 */
function tree(ctx: CanvasRenderingContext2D, g: G, o: GlyphColors, k: number) {
  const { x, y, s, seed } = g
  const jungle = g.kind === 'jungle'
  const r = s * (jungle ? 0.95 : 0.82)
  const cy = y - s * 0.35 - r
  // 树干
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.75 * k
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.25)
  ctx.lineTo(x, cy + r * 0.6)
  ctx.stroke()
  const lobes = jungle ? 7 : 5 + Math.floor(hash(seed, 2) * 2)
  const rot = hash(seed, 3) * Math.PI
  crown(ctx, x, cy, r, lobes, rot)
  ctx.fillStyle = o.leafDark
  ctx.fill()
  crown(ctx, x - r * 0.16, cy - r * 0.16, r * 0.72, lobes, rot)
  ctx.fillStyle = o.leaf
  ctx.fill()
  crown(ctx, x, cy, r, lobes, rot)
  ctx.lineWidth = 0.7 * k
  ctx.stroke()
}

function crown(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, lobes: number, rot: number) {
  ctx.beginPath()
  const pt = (a: number, rr: number): P => [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.92]
  for (let j = 0; j <= lobes; j++) {
    const a = rot + (j / lobes) * Math.PI * 2
    const [px, py] = pt(a, r * 0.86)
    if (j === 0) ctx.moveTo(px, py)
    else {
      const [qx, qy] = pt(a - Math.PI / lobes, r * 1.24)
      ctx.quadraticCurveTo(qx, qy, px, py)
    }
  }
  ctx.closePath()
}

/** 针叶树：两到三层下垂的塔形，右半边暗 */
function conifer(ctx: CanvasRenderingContext2D, g: G, o: GlyphColors, k: number) {
  const { x, y, s, seed } = g
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.7 * k
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.3)
  ctx.lineTo(x, y - s * 0.2)
  ctx.stroke()
  const tiers = hash(seed, 4) > 0.4 ? 3 : 2
  const top = y - s * (tiers === 3 ? 2.3 : 1.9)
  for (let i = 0; i < tiers; i++) {
    const yb = y - s * 0.15 - i * s * 0.62
    const yt = i === tiers - 1 ? top : yb - s * 0.95
    const hw = s * (0.78 - i * 0.18)
    const tier = () => {
      ctx.beginPath()
      ctx.moveTo(x, yt)
      ctx.lineTo(x + hw, yb)
      ctx.quadraticCurveTo(x, yb - s * 0.22, x - hw, yb)
      ctx.closePath()
    }
    tier()
    ctx.fillStyle = o.pine
    ctx.fill()
    poly(ctx, [
      [x, yt],
      [x + hw, yb],
      [x + hw * 0.1, yb - s * 0.12],
    ])
    ctx.fillStyle = o.pineDark
    ctx.fill()
    tier()
    ctx.stroke()
  }
}

/** 金合欢：分叉的细干 + 扁平的伞状树冠 */
function acacia(ctx: CanvasRenderingContext2D, g: G, o: GlyphColors, k: number) {
  const { x, y, s } = g
  const cy = y - s * 1.25
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.7 * k
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.2)
  ctx.lineTo(x, y - s * 0.5)
  ctx.lineTo(x - s * 0.45, cy + s * 0.1)
  ctx.moveTo(x, y - s * 0.5)
  ctx.lineTo(x + s * 0.4, cy + s * 0.1)
  ctx.stroke()
  const canopy = () => {
    ctx.beginPath()
    ctx.moveTo(x - s * 1.25, cy + s * 0.12)
    ctx.quadraticCurveTo(x - s * 0.9, cy - s * 0.42, x, cy - s * 0.38)
    ctx.quadraticCurveTo(x + s * 0.95, cy - s * 0.4, x + s * 1.2, cy + s * 0.1)
    ctx.quadraticCurveTo(x, cy + s * 0.3, x - s * 1.25, cy + s * 0.12)
    ctx.closePath()
  }
  canopy()
  ctx.fillStyle = o.leaf
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(x - s * 1.2, cy + s * 0.12)
  ctx.quadraticCurveTo(x, cy + s * 0.02, x + s * 1.2, cy + s * 0.1)
  ctx.quadraticCurveTo(x, cy + s * 0.3, x - s * 1.2, cy + s * 0.12)
  ctx.fillStyle = o.leafDark
  ctx.fill()
  canopy()
  ctx.stroke()
}

/** 灌木：贴地的三瓣矮丛 */
function bush(ctx: CanvasRenderingContext2D, g: G, o: GlyphColors, k: number) {
  const { x, y, s } = g
  const shape = () => {
    ctx.beginPath()
    ctx.moveTo(x - s, y)
    ctx.quadraticCurveTo(x - s * 1.15, y - s * 0.8, x - s * 0.35, y - s * 0.75)
    ctx.quadraticCurveTo(x, y - s * 1.35, x + s * 0.4, y - s * 0.7)
    ctx.quadraticCurveTo(x + s * 1.15, y - s * 0.7, x + s, y)
    ctx.closePath()
  }
  shape()
  ctx.fillStyle = o.leaf
  ctx.fill()
  poly(ctx, [
    [x + s * 0.1, y],
    [x + s * 0.55, y - s * 0.62],
    [x + s, y],
  ])
  ctx.fillStyle = o.leafDark
  ctx.fill()
  shape()
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 0.65 * k
  ctx.stroke()
}
