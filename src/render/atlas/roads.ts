import type { Road } from '../../gen/types'
import type { RoadStyle } from './styles'

/** 道路与航线：航线在最下，其次支线、干道；有衬边的风格先画一道更宽的衬边 */
export function drawRoads(ctx: CanvasRenderingContext2D, roads: Road[] | undefined, S: number, st: RoadStyle) {
  if (!roads?.length) return
  const k = S / 2
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const stroke = (kind: Road['kind'], color: string, width: number, dash: number[] | undefined) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width * k
    ctx.setLineDash(dash ? dash.map((d) => d * k) : [])
    for (const r of roads) {
      if (r.kind !== kind) continue
      ctx.beginPath()
      ctx.moveTo(r.pts[0] * S, r.pts[1] * S)
      for (let i = 2; i < r.pts.length; i += 2) ctx.lineTo(r.pts[i] * S, r.pts[i + 1] * S)
      ctx.stroke()
    }
  }
  stroke('sea', st.sea, 1.3, st.seaDash)
  for (const [kind, w] of [['minor', st.width * 0.65], ['major', st.width]] as const) {
    if (st.casing) stroke(kind, st.casing, w + 1.6, undefined)
    stroke(kind, st.color, w, st.dash)
  }
  ctx.restore()
}
