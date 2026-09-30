import type { DisplayList } from './displayList'

/** 瓦片边长（画布像素）：一块的绘制成本在一帧之内 */
const T = 256
/** 缓存的瓦片数下限（每块 256 KB）；视口需要更多时按视口的两倍留 */
const MIN_TILES = 240

/**
 * 走 CPU 栅格化的 2D 上下文：地图的显示列表是成千上万条细碎路径，交给 GPU 逐条三角化反而更慢，
 * 而且 GPU 端的活异步拖住页面合成（实测 CPU 画瓦片、底图都更快）。
 * 浏览器没有专门的开关，借 willReadFrequently（只在第一次取上下文时生效）让画布留在 CPU 上
 */
export function cpuContext(c: HTMLCanvasElement) {
  return c.getContext('2d', { willReadFrequently: true })!
}

const key = (z: number, i: number, j: number) => `${z}:${i}:${j}`

/**
 * 细节层的瓦片缓存：放大到超出底图精度时，按缩放级别把显示列表切成 T 见方的瓦片逐块绘制、缓存。
 * 级别 z 的瓦片以 baseScale · 2^z 的倍率绘制（不低于屏幕精度，合成时只缩小不放大）。
 * 整个视口一次重画要把视口里成千上万条指令（手绘山形、树林）一次画完，停手时会卡住几百毫秒；
 * 切成瓦片后每帧最多画一块，平移时已画的瓦片直接复用，缩放时先用相邻级别的瓦片顶替
 */
export class TileCache {
  private tiles = new Map<string, HTMLCanvasElement>()
  /** 上次合成时视口要的瓦片数：缓存至少留它的两倍，免得可见的瓦片互相挤掉、反复重画 */
  private need = 0

  constructor(
    private list: DisplayList,
    private baseScale: number,
    /** 只画哪一层（图框模式下只画地图） */
    private only: 'map' | undefined,
  ) {}

  /** 屏幕倍率（画布像素 / 页面像素）对应的级别 */
  level(scale: number) {
    return Math.max(1, Math.ceil(Math.log2(scale / this.baseScale) - 0.02))
  }

  private scaleOf(z: number) {
    return this.baseScale * 2 ** z
  }

  /** 级别 z 下与画布可见区相交的瓦片（按离视口中心的距离排序） */
  private cover(z: number, scale: number, ox: number, oy: number, cw: number, ch: number): [number, number][] {
    const P = T / this.scaleOf(z)
    const L = this.list
    const px0 = Math.max(0, -ox / scale)
    const py0 = Math.max(0, -oy / scale)
    const px1 = Math.min(L.width, (cw - ox) / scale)
    const py1 = Math.min(L.height, (ch - oy) / scale)
    if (!(P > 0 && Number.isFinite(P)) || !(px1 > px0 && py1 > py0)) return []
    const cx = (px0 + px1) / 2 / P - 0.5
    const cy = (py0 + py1) / 2 / P - 0.5
    const out: [number, number, number][] = []
    for (let j = Math.floor(py0 / P); j * P < py1; j++) for (let i = Math.floor(px0 / P); i * P < px1; i++) out.push([i, j, (i - cx) ** 2 + (j - cy) ** 2])
    return out.sort((a, b) => a[2] - b[2]).map(([i, j]) => [i, j])
  }

  private get(z: number, i: number, j: number) {
    const k = key(z, i, j)
    const t = this.tiles.get(k)
    if (t) {
      // 最近用过的排到末尾（淘汰从头开始）
      this.tiles.delete(k)
      this.tiles.set(k, t)
    }
    return t
  }

  /** 级别 z 的瓦片 (i, j) 在画布上的矩形：页面坐标取整到画布像素，相邻瓦片共用边，不留缝 */
  private rect(scale: number, ox: number, oy: number, z: number, i: number, j: number) {
    const P = T / this.scaleOf(z)
    return [Math.round(i * P * scale + ox), Math.round(j * P * scale + oy), Math.round((i + 1) * P * scale + ox), Math.round((j + 1) * P * scale + oy)] as const
  }

  /**
   * 把可见区合成到画布上（画布像素 = 页面像素 × scale + (ox, oy)）：
   * 目标级别缺的瓦片先用粗一级的放大、细一级的缩小顶替，都没有的地方透明（露出底图）。返回目标级别缺的瓦片
   */
  composite(ctx: CanvasRenderingContext2D, scale: number, ox: number, oy: number): [number, number][] {
    const z = this.level(scale)
    const missing: [number, number][] = []
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.imageSmoothingQuality = 'high'
    const cover = this.cover(z, scale, ox, oy, ctx.canvas.width, ctx.canvas.height)
    this.need = cover.length
    for (const [i, j] of cover) {
      const [x0, y0, x1, y1] = this.rect(scale, ox, oy, z, i, j)
      const t = this.get(z, i, j)
      if (t) {
        ctx.drawImage(t, x0, y0, x1 - x0, y1 - y0)
        continue
      }
      missing.push([i, j])
      // 粗一级：取父瓦片的四分之一放大
      const parent = z > 1 ? this.get(z - 1, i >> 1, j >> 1) : undefined
      if (parent) {
        const h = T / 2
        ctx.drawImage(parent, (i & 1) * h, (j & 1) * h, h, h, x0, y0, x1 - x0, y1 - y0)
        continue
      }
      // 细一级：四个子瓦片各占四分之一
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const c = this.get(z + 1, i * 2 + dx, j * 2 + dy)
          if (!c) continue
          const [a, b, a1, b1] = this.rect(scale, ox, oy, z + 1, i * 2 + dx, j * 2 + dy)
          ctx.drawImage(c, a, b, a1 - a, b1 - b)
        }
    }
    return missing
  }

  /** 画级别 z 的一块瓦片并缓存 */
  render(z: number, i: number, j: number) {
    const c = document.createElement('canvas')
    c.width = c.height = T
    this.list.render(cpuContext(c), this.scaleOf(z), -i * T, -j * T, this.only, false)
    this.tiles.set(key(z, i, j), c)
    const max = Math.max(MIN_TILES, this.need * 2)
    while (this.tiles.size > max) this.tiles.delete(this.tiles.keys().next().value!)
  }

  /** 把缓存里的一块瓦片贴到画布上它的位置（补画一块后只更新这一块，不必整幅重新合成） */
  paint(ctx: CanvasRenderingContext2D, scale: number, ox: number, oy: number, z: number, i: number, j: number) {
    const t = this.tiles.get(key(z, i, j))
    if (!t) return
    const [x0, y0, x1, y1] = this.rect(scale, ox, oy, z, i, j)
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0)
    ctx.drawImage(t, x0, y0, x1 - x0, y1 - y0)
  }
}
