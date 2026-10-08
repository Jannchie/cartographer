import type { World } from '../../gen/types'
import type { Theme } from './styles'

/**
 * 行政界线（区域图）：地级界细点线、省界点划线、国界粗点划线加一道浅色晕带；海上断续线按原形状填实。
 * 颜色取风格的墨色，线宽、虚线以 S=2 时的像素计
 */
export function drawAdmin(ctx: CanvasRenderingContext2D, world: World, S: number, theme: Theme) {
  const a = world.admin
  if (!a) return
  const k = S / 2
  const ink = theme.ink
  ctx.save()
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  const trace = (pts: number[]) => {
    ctx.beginPath()
    ctx.moveTo(pts[0] * S, pts[1] * S)
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * S, pts[i + 1] * S)
  }
  const stroke = (kind: 'national' | 'province' | 'prefecture', width: number, dash: number[], alpha: number, color = ink) => {
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha
    ctx.lineWidth = width * k
    ctx.setLineDash(dash.map((d) => d * k))
    for (const b of a.borders) {
      if (b.kind !== kind) continue
      trace(b.pts)
      ctx.stroke()
    }
  }
  stroke('prefecture', 0.5, [1.4, 2.6], 0.42)
  stroke('province', 1.5, [8, 2.5, 1.8, 2.5], 0.85)
  // 国界：先铺一道浅色晕带，再画点划线
  stroke('national', 7, [], 0.18, 'rgb(196,72,96)')
  stroke('national', 2, [11, 3, 2.4, 3], 0.95)
  // 断续线：数据本身就是一段段细长的多边形
  ctx.globalAlpha = 0.95
  ctx.fillStyle = ink
  ctx.setLineDash([])
  for (const r of a.claims) {
    trace(r)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}
