import type { World } from '../../gen/types'
import { simplifyLine } from '../../gen/util'
import { categoryBorders } from './svg/contour'
import type { LineLook, Theme } from './styles'

/** 政区图：按国家或按文化着色，伯爵领界、文化界与国界 */
export type PoliticalMode = 'realms' | 'cultures'

/** 每格所属文化（由伯爵领推出），海洋 -1；按世界缓存 */
const cultureCache = new WeakMap<World, Int16Array>()
export function cultureRaster(world: World): Int16Array {
  let r = cultureCache.get(world)
  if (r) return r
  const p = world.political!
  r = new Int16Array(p.county.length).fill(-1)
  for (let i = 0; i < r.length; i++) if (p.county[i] >= 0) r[i] = p.counties[p.county[i]].culture
  cultureCache.set(world, r)
  return r
}

/** 着色用的区域：国家或文化（列表与每格归属） */
export function politicalRegions(world: World, mode: PoliticalMode) {
  return mode === 'cultures' && world.political ? { list: world.political.cultures, raster: cultureRaster(world) } : { list: world.realms, raster: world.realm }
}

/**
 * 分界线：取格边上的折线，去掉台阶（简化）后用 Chaikin 切角磨圆；端点（三方交界、海岸）不动，各级界线在交界处对得上。
 * 坐标与等值线相同（格中心为整数），画布像素 = (g + 0.5)·S
 */
function smoothBorders(cat: ArrayLike<number>, W: number, H: number): number[][] {
  const out: number[][] = []
  for (const ring of categoryBorders(cat, W, H)) {
    let pts = simplifyLine(Array.from(ring), 0.6)
    for (let it = 0; it < 2 && pts.length >= 6; it++) {
      const n = pts.length / 2
      const next = [pts[0], pts[1]]
      for (let i = 0; i + 1 < n; i++) {
        const ax = pts[i * 2]
        const ay = pts[i * 2 + 1]
        const bx = pts[i * 2 + 2]
        const by = pts[i * 2 + 3]
        next.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25, ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75)
      }
      next.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1])
      pts = next
    }
    out.push(pts)
  }
  return out
}

const borderCache = new WeakMap<World, { county: number[][]; culture: number[][]; realm: number[][] }>()
export function politicalBorders(world: World) {
  let b = borderCache.get(world)
  if (b) return b
  const { W, H } = world
  b = { county: smoothBorders(world.political!.county, W, H), culture: smoothBorders(cultureRaster(world), W, H), realm: smoothBorders(world.realm, W, H) }
  borderCache.set(world, b)
  return b
}

/**
 * 政区界线（生成的世界）：伯爵领界、文化界（只在文化图上）与国界（下面可以垫一道晕带），画法随风格（Theme.political）
 */
export function drawPolitical(ctx: CanvasRenderingContext2D, world: World, S: number, theme: Theme, mode: PoliticalMode) {
  if (!world.political) return
  const b = politicalBorders(world)
  const look = theme.political
  const k = S / 2
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const stroke = (lines: number[][], l: LineLook) => {
    ctx.strokeStyle = l.color
    ctx.globalAlpha = l.alpha
    ctx.lineWidth = l.width * k
    ctx.setLineDash((l.dash ?? []).map((d) => d * k))
    for (const pts of lines) {
      ctx.beginPath()
      ctx.moveTo((pts[0] + 0.5) * S, (pts[1] + 0.5) * S)
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo((pts[i] + 0.5) * S, (pts[i + 1] + 0.5) * S)
      ctx.stroke()
    }
  }
  stroke(b.county, look.county)
  if (mode === 'cultures') stroke(b.culture, look.culture)
  if (look.halo) stroke(b.realm, look.halo)
  stroke(b.realm, look.realm)
  ctx.restore()
}
