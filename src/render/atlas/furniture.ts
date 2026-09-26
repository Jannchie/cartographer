import type { World } from '../../gen/types'
import { hash, type Fields } from './fields'
import { HYPSO_STOPS, REALM_COLORS, type Theme } from './styles'

const rgb = (c: number[]) => `rgb(${c.map(Math.round).join(',')})`

/** 经度：以地图中央为 0°，按中纬度换算每格经度 */
export function lonScale(world: World) {
  const p = world.params
  const midLat = (p.latNorth + p.latSouth) / 2
  return world.kmPerCell / (111.32 * Math.cos((midLat * Math.PI) / 180))
}

export function drawGraticule(ctx: CanvasRenderingContext2D, world: World, S: number, color: string) {
  const { W, H, params: p } = world
  const k = S / 2
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 0.7 * k
  ctx.setLineDash([6 * k, 5 * k])
  const top = p.latNorth
  const bot = p.latSouth
  for (let lat = Math.ceil(Math.min(top, bot) / 10) * 10; lat <= Math.max(top, bot); lat += 10) {
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

// ———————————————————————— 指北针 ————————————————————————

export function drawCompass(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number, r: number) {
  if (theme.compass === 'none') return
  if (theme.compass === 'north') return northArrow(ctx, theme, x, y, r)
  const ink = theme.ink
  const paper = rgb(theme.paper)
  ctx.save()
  ctx.translate(x, y)
  ctx.strokeStyle = ink
  ctx.lineWidth = r * 0.025
  if (theme.compass === 'nautical') {
    // 外圈 360° 刻度
    ctx.beginPath()
    ctx.arc(0, 0, r * 1.18, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 0, r * 1.02, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = ink
    ctx.font = `500 ${r * 0.11}px "Cormorant Garamond", serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let d = 0; d < 360; d += 5) {
      const a = ((d - 90) * Math.PI) / 180
      const l = d % 10 === 0 ? 0.08 : 0.04
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * r * 1.02, Math.sin(a) * r * 1.02)
      ctx.lineTo(Math.cos(a) * r * (1.02 + l), Math.sin(a) * r * (1.02 + l))
      ctx.stroke()
      if (d % 30 === 0) {
        ctx.save()
        ctx.translate(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25)
        ctx.rotate(a + Math.PI / 2)
        ctx.fillText(String(d), 0, 0)
        ctx.restore()
      }
    }
  }
  const ornate = theme.compass === 'ornate'
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2)
  if (ornate) {
    ctx.fillStyle = paper
    ctx.fill()
  }
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2)
  ctx.stroke()
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2
    const l = k % 8 === 0 ? 0.62 : k % 4 === 0 ? 0.66 : 0.68
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7)
    ctx.lineTo(Math.cos(a) * r * l, Math.sin(a) * r * l)
    ctx.stroke()
  }
  const point = (a: number, len: number, w: number) => {
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    for (const side of [1, -1]) {
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(ca * len, sa * len)
      ctx.lineTo(-sa * w * side, ca * w * side)
      ctx.closePath()
      ctx.fillStyle = side === 1 ? ink : paper
      ctx.fill()
      ctx.stroke()
    }
  }
  if (ornate) for (let k = 0; k < 8; k++) point(Math.PI / 8 + (k * Math.PI) / 4, r * 0.42, r * 0.05)
  for (let k = 0; k < 4; k++) point(Math.PI / 4 + (k * Math.PI) / 2, r * 0.55, r * 0.07)
  for (let k = 0; k < 4; k++) point(-Math.PI / 2 + (k * Math.PI) / 2, r * 0.98, r * 0.12)
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.06, 0, Math.PI * 2)
  ctx.fillStyle = paper
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = ink
  ctx.font = `600 ${r * 0.34}px ${theme.labels.display}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  if (ornate) {
    // 百合花饰代替 N
    ctx.beginPath()
    const t = -r * 1.02
    ctx.moveTo(0, t - r * 0.3)
    ctx.quadraticCurveTo(r * 0.1, t - r * 0.15, 0, t)
    ctx.quadraticCurveTo(-r * 0.1, t - r * 0.15, 0, t - r * 0.3)
    ctx.moveTo(0, t - r * 0.05)
    ctx.quadraticCurveTo(r * 0.2, t - r * 0.25, r * 0.16, t - r * 0.05)
    ctx.moveTo(0, t - r * 0.05)
    ctx.quadraticCurveTo(-r * 0.2, t - r * 0.25, -r * 0.16, t - r * 0.05)
    ctx.stroke()
    ctx.fill()
  } else if (theme.compass !== 'nautical') ctx.fillText('N', 0, -r * 0.98)
  ctx.restore()
}

function northArrow(ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number, r: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = theme.ink
  ctx.strokeStyle = theme.ink
  ctx.lineWidth = r * 0.03
  ctx.beginPath()
  ctx.moveTo(0, -r * 0.7)
  ctx.lineTo(r * 0.22, r * 0.25)
  ctx.lineTo(0, r * 0.1)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(0, -r * 0.7)
  ctx.lineTo(-r * 0.22, r * 0.25)
  ctx.lineTo(0, r * 0.1)
  ctx.closePath()
  ctx.stroke()
  ctx.font = `700 ${r * 0.32}px ${theme.labels.display}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText('N', 0, -r * 0.75)
  ctx.restore()
}

// ———————————————————————— 比例尺 ————————————————————————

export function drawScaleBar(ctx: CanvasRenderingContext2D, world: World, theme: Theme, S: number, x: number, y: number) {
  const k = S / 2
  const kmPx = world.kmPerCell / S
  const target = 240 * k * kmPx
  const nice = [100, 200, 250, 500, 1000, 2000]
  const kmLen = nice.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
  const len = kmLen / kmPx
  const zh = theme.labels.zh
  ctx.save()
  ctx.translate(x - len / 2, y)
  ctx.strokeStyle = theme.ink
  ctx.lineWidth = 1 * k
  const segs = 4
  for (let s = 0; s < segs; s++) {
    ctx.fillStyle = s % 2 ? rgb(theme.paper) : theme.ink
    ctx.fillRect((len / segs) * s, 0, len / segs, 5 * k)
  }
  ctx.strokeRect(0, 0, len, 5 * k)
  ctx.fillStyle = theme.ink
  ctx.font = `500 ${11 * k}px ${theme.labels.text}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  for (let s = 0; s <= segs; s += 2) ctx.fillText(`${(kmLen / segs) * s}`, (len / segs) * s, -3 * k)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(zh ? '公里' : 'km', len + 5 * k, 3 * k)
  ctx.restore()
}

// ———————————————————————— 图名 ————————————————————————

function spaced(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, spacing: number) {
  const ws = [...text].map((c) => ctx.measureText(c).width)
  const tot = ws.reduce((a, b) => a + b, 0) + spacing * (text.length - 1)
  let x = cx - tot / 2
  ctx.textAlign = 'left'
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i], x, y)
    x += ws[i] + spacing
  }
  return tot
}

/** 返回图名区域（供注记避让） */
export function drawCartouche(ctx: CanvasRenderingContext2D, world: World, theme: Theme, S: number, MW: number) {
  const k = S / 2
  const title = world.worldName.toUpperCase()
  const paper = rgb(theme.paper)
  ctx.save()
  ctx.textBaseline = 'alphabetic'
  let box = { x0: 0, y0: 0, x1: 380 * k, y1: 120 * k }
  switch (theme.cartouche) {
    case 'scroll': {
      // 卷轴：两端卷起的横幅
      const x = 34 * k
      const y = 26 * k
      const w = 330 * k
      const h = 78 * k
      ctx.translate(x, y)
      ctx.fillStyle = 'rgba(238, 224, 190, 0.95)'
      ctx.strokeStyle = theme.ink
      ctx.lineWidth = 1.3 * k
      ctx.beginPath()
      ctx.moveTo(0, 8 * k)
      ctx.quadraticCurveTo(w / 2, -4 * k, w, 8 * k)
      ctx.lineTo(w, h - 8 * k)
      ctx.quadraticCurveTo(w / 2, h - 20 * k, 0, h - 8 * k)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      for (const ex of [0, w]) {
        ctx.beginPath()
        ctx.ellipse(ex, h / 2 - 2 * k, 9 * k, h / 2 - 4 * k, 0, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(220, 200, 158, 1)'
        ctx.fill()
        ctx.stroke()
        ctx.beginPath()
        ctx.ellipse(ex, h / 2 - 2 * k, 3 * k, h / 2 - 12 * k, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = theme.ink
      ctx.font = `400 ${32 * k}px ${theme.labels.display}`
      spaced(ctx, title, w / 2, 44 * k, 7 * k)
      ctx.font = `italic 400 ${13 * k}px ${theme.labels.text}`
      ctx.textAlign = 'center'
      ctx.fillText(`Here be the lands of ${world.worldName}`, w / 2, 62 * k)
      box = { x0: 0, y0: 0, x1: x + w + 20 * k, y1: y + h + 10 * k }
      break
    }
    case 'nautical': {
      const x = 28 * k
      const y = 26 * k
      const w = 340 * k
      const h = 104 * k
      ctx.translate(x, y)
      ctx.fillStyle = 'rgba(244, 241, 232, 0.92)'
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = theme.ink
      ctx.lineWidth = 1 * k
      ctx.strokeRect(0, 0, w, h)
      ctx.fillStyle = theme.ink
      ctx.textAlign = 'center'
      ctx.font = `500 ${12 * k}px ${theme.labels.text}`
      spaced(ctx, 'CHART OF THE COASTS OF', w / 2, 22 * k, 2.5 * k)
      ctx.font = `600 ${30 * k}px ${theme.labels.display}`
      spaced(ctx, title, w / 2, 56 * k, 6 * k)
      ctx.font = `italic 500 ${12 * k}px ${theme.labels.text}`
      ctx.textAlign = 'center'
      ctx.fillText('Soundings in metres · reduced to mean sea level', w / 2, 78 * k)
      ctx.fillText(`Surveyed under seed “${world.params.seed}”`, w / 2, 94 * k)
      box = { x0: 0, y0: 0, x1: x + w + 12 * k, y1: y + h + 10 * k }
      break
    }
    case 'ink': {
      // 竖排题名 + 朱文印
      const zhTitle = `${world.worldNameZh}舆地全图`
      const size = 30 * k
      const x = MW - 44 * k
      const y = 34 * k
      ctx.fillStyle = theme.ink
      ctx.font = `400 ${size}px ${theme.labels.display}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const chars = [...zhTitle]
      chars.forEach((c, i) => ctx.fillText(c, x, y + i * size * 1.12))
      const bottom = y + chars.length * size * 1.12
      // 落款小字
      ctx.font = `400 ${13 * k}px ${theme.labels.text}`
      const sign = [...`种子 ${world.params.seed}`]
      sign.forEach((c, i) => ctx.fillText(c, x - size * 1.1, y + size * 0.6 + i * 14 * k))
      seal(ctx, x - size * 0.5, bottom + 10 * k, 58 * k, world.worldNameZh, k)
      box = { x0: x - size * 1.7, y0: 0, x1: MW, y1: bottom + 60 * k }
      break
    }
    default: {
      const x = 28 * k
      const y = 26 * k
      const w = 330 * k
      const h = 84 * k
      ctx.translate(x, y)
      ctx.fillStyle = paper
      ctx.globalAlpha = 0.86
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = 1
      ctx.strokeStyle = theme.ink
      ctx.lineWidth = 1 * k
      ctx.strokeRect(0, 0, w, h)
      ctx.strokeRect(4 * k, 4 * k, w - 8 * k, h - 8 * k)
      ctx.fillStyle = theme.ink
      const sans = theme.id === 'topo'
      ctx.font = `${sans ? 700 : 600} ${(sans ? 26 : 32) * k}px ${theme.labels.display}`
      spaced(ctx, title, w / 2, 44 * k, (sans ? 5 : 9.6) * k)
      ctx.font = `${sans ? '' : 'italic'} 500 ${13 * k}px ${theme.labels.text}`
      ctx.textAlign = 'center'
      const sub =
        theme.id === 'political'
          ? `Political map · ${world.realms.length} realms`
          : theme.id === 'topo'
            ? `Topographic survey · contour interval 100 m`
            : `A physical map of the known world · seed “${world.params.seed}”`
      ctx.fillText(sub, w / 2, 66 * k)
      box = { x0: 0, y0: 0, x1: x + w + 20 * k, y1: y + h + 20 * k }
    }
  }
  ctx.restore()
  return box
}

/** 朱文方印：印文按 2×2 或 1×N 排列，边框做旧 */
function seal(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, text: string, k: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = '#b3322b'
  ctx.globalAlpha = 0.9
  ctx.fillRect(-s / 2, 0, s, s)
  // 刻出来的字：用纸色写
  ctx.fillStyle = '#efe4cc'
  const chars = [...text].slice(0, 4)
  const n = chars.length
  const cols = n > 2 ? 2 : 1
  const rows = Math.ceil(n / cols)
  const cs = (s * 0.82) / Math.max(cols, rows)
  ctx.font = `400 ${cs}px "Ma Shan Zheng", "Noto Serif SC", serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // 印章从右往左竖读
  chars.forEach((c, i) => {
    const col = cols - 1 - Math.floor(i / rows)
    const row = i % rows
    ctx.fillText(c, -s / 2 + s * 0.09 + cs * (col + 0.5) + (cols === 1 ? (s * 0.82 - cs) / 2 : 0), s * 0.09 + cs * (row + 0.5) + (rows === 1 ? (s * 0.82 - cs) / 2 : 0))
  })
  // 做旧：随机剥落
  ctx.globalCompositeOperation = 'destination-out'
  for (let t = 0; t < 40; t++) {
    const px = (hash(t, 7) - 0.5) * s
    const py = hash(t, 13) * s
    ctx.globalAlpha = 0.5
    ctx.fillRect(px, py, 1.2 * k, 1.2 * k)
  }
  ctx.restore()
}

// ———————————————————————— 图例 ————————————————————————

export function drawLegend(ctx: CanvasRenderingContext2D, world: World, theme: Theme, S: number, MH: number) {
  const k = S / 2
  if (!theme.legend) return null
  ctx.save()
  const x = 28 * k
  let box = null
  if (theme.legend === 'realms') {
    const rs = [...world.realms].sort((a, b) => b.area - a.area).slice(0, 10)
    const row = 17 * k
    const w = 230 * k
    const h = 34 * k + rs.length * row
    const y = MH - h - 26 * k
    ctx.fillStyle = 'rgba(243, 238, 226, 0.9)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = theme.ink
    ctx.lineWidth = 1 * k
    ctx.strokeRect(x, y, w, h)
    ctx.fillStyle = theme.ink
    ctx.font = `600 ${13 * k}px ${theme.labels.display}`
    ctx.textBaseline = 'middle'
    ctx.fillText('REALMS', x + 12 * k, y + 16 * k)
    ctx.font = `500 ${12.5 * k}px ${theme.labels.text}`
    rs.forEach((r, i) => {
      const yy = y + 34 * k + i * row
      ctx.fillStyle = rgb(REALM_COLORS[r.color])
      ctx.fillRect(x + 12 * k, yy - 5 * k, 16 * k, 10 * k)
      ctx.strokeRect(x + 12 * k, yy - 5 * k, 16 * k, 10 * k)
      ctx.fillStyle = theme.ink
      ctx.fillText(r.name, x + 36 * k, yy)
    })
    box = { x0: 0, y0: y - 10 * k, x1: x + w + 10 * k, y1: MH }
  } else {
    // 分层设色图例
    const w = 240 * k
    const h = 56 * k
    const y = MH - h - 26 * k
    ctx.fillStyle = 'rgba(251, 250, 246, 0.92)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = theme.ink
    ctx.lineWidth = 0.8 * k
    ctx.strokeRect(x, y, w, h)
    const bx = x + 14 * k
    const bw = w - 28 * k
    const maxH = 5
    for (let t = 0; t < bw; t++) {
      const hv = (t / bw) * maxH
      let c = HYPSO_STOPS[0][1]
      for (let s = 1; s < HYPSO_STOPS.length; s++) {
        if (hv <= HYPSO_STOPS[s][0]) {
          const [a, ca] = HYPSO_STOPS[s - 1]
          const [b, cb] = HYPSO_STOPS[s]
          const u = (hv - a) / (b - a)
          c = [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u]
          break
        }
        c = HYPSO_STOPS[s][1]
      }
      ctx.fillStyle = rgb(c)
      ctx.fillRect(bx + t, y + 14 * k, 1.5, 12 * k)
    }
    ctx.strokeRect(bx, y + 14 * k, bw, 12 * k)
    ctx.fillStyle = theme.ink
    ctx.font = `500 ${10.5 * k}px ${theme.labels.text}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let v = 0; v <= maxH; v++) ctx.fillText(`${v * 1000}`, bx + (v / maxH) * bw, y + 30 * k)
    ctx.textAlign = 'left'
    ctx.fillText('Elevation (m)', bx, y + 43 * k)
    box = { x0: 0, y0: y - 10 * k, x1: x + w + 10 * k, y1: MH }
  }
  ctx.restore()
  return box
}

// ———————————————————————— 航海图元素 ————————————————————————

/** 恒向线：从两个罗盘中心放射出 32 条方位线，贯穿全图 */
export function drawRhumbLines(ctx: CanvasRenderingContext2D, centers: [number, number][], MW: number, MH: number, S: number) {
  const k = S / 2
  const L = Math.hypot(MW, MH)
  ctx.save()
  ctx.lineWidth = 0.6 * k
  for (const [cx, cy] of centers) {
    for (let t = 0; t < 32; t++) {
      const a = (t / 32) * Math.PI * 2
      ctx.strokeStyle = t % 4 === 0 ? 'rgba(40, 40, 40, 0.28)' : t % 2 === 0 ? 'rgba(150, 50, 40, 0.22)' : 'rgba(40, 90, 60, 0.18)'
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/** 测深：抖动网格上标注水深（米），近岸密、远洋疏 */
export function drawSoundings(ctx: CanvasRenderingContext2D, f: Fields) {
  const { world, S } = f
  const { W, H, elevation: e, coastDist } = world
  const k = S / 2
  ctx.save()
  ctx.fillStyle = 'rgba(40, 60, 80, 0.72)'
  ctx.font = `italic 500 ${9.5 * k}px "Cormorant Garamond", serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const g = 11
  for (let y = 8; y < H - 8; y += g) {
    for (let x = 8; x < W - 8; x += g) {
      const jx = Math.round(x + (hash(x, y) - 0.5) * 7)
      const jy = Math.round(y + (hash(y, x) - 0.5) * 7)
      const i = jy * W + jx
      if (e[i] >= 0) continue
      const cd = -coastDist[i]
      // 远洋稀疏
      if (cd > 25 && hash(jx, jy * 3) > 0.3) continue
      if (cd < 1.5) continue
      const m = Math.round(-e[i] * 1000)
      ctx.fillText(m >= 1000 ? String(Math.round(m / 10) * 10) : String(m), jx * S, jy * S)
    }
  }
  ctx.restore()
}

// ———————————————————————— 图框 ————————————————————————

export function drawFrame(ctx: CanvasRenderingContext2D, world: World, theme: Theme, S: number, M: number, MW: number, MH: number) {
  const k = S / 2
  const ink = theme.ink
  const paper = rgb(theme.paper)
  ctx.save()
  if (theme.frame === 'ornate') {
    ctx.strokeStyle = ink
    ctx.lineWidth = 2.6 * k
    ctx.strokeRect(M - 10 * k, M - 10 * k, MW + 20 * k, MH + 20 * k)
    ctx.lineWidth = 1 * k
    ctx.strokeRect(M - 4 * k, M - 4 * k, MW + 8 * k, MH + 8 * k)
    ctx.strokeRect(M, M, MW, MH)
    // 四角的方形饰块
    for (const [cx, cy] of [
      [M - 7 * k, M - 7 * k],
      [M + MW + 7 * k, M - 7 * k],
      [M - 7 * k, M + MH + 7 * k],
      [M + MW + 7 * k, M + MH + 7 * k],
    ]) {
      ctx.fillStyle = paper
      ctx.fillRect(cx - 12 * k, cy - 12 * k, 24 * k, 24 * k)
      ctx.strokeRect(cx - 12 * k, cy - 12 * k, 24 * k, 24 * k)
      ctx.beginPath()
      ctx.moveTo(cx, cy - 8 * k)
      ctx.lineTo(cx + 8 * k, cy)
      ctx.lineTo(cx, cy + 8 * k)
      ctx.lineTo(cx - 8 * k, cy)
      ctx.closePath()
      ctx.fillStyle = ink
      ctx.fill()
    }
    // 边上的缠枝点缀：等距小菱形
    ctx.fillStyle = ink
    const step = 40 * k
    for (let x = M + step; x < M + MW - step / 2; x += step) {
      for (const y of [M - 7 * k, M + MH + 7 * k]) diamond(ctx, x, y, 2.4 * k)
    }
    for (let y = M + step; y < M + MH - step / 2; y += step) {
      for (const x of [M - 7 * k, M + MW + 7 * k]) diamond(ctx, x, y, 2.4 * k)
    }
    ctx.restore()
    return
  }
  if (theme.frame === 'ink') {
    ctx.strokeStyle = ink
    ctx.lineWidth = 2.2 * k
    ctx.strokeRect(M - 9 * k, M - 9 * k, MW + 18 * k, MH + 18 * k)
    ctx.lineWidth = 0.8 * k
    ctx.strokeRect(M - 3 * k, M - 3 * k, MW + 6 * k, MH + 6 * k)
    ctx.restore()
    return
  }
  const p = world.params
  const { W, H } = world
  ctx.strokeStyle = ink
  ctx.lineWidth = 1.2 * k
  ctx.strokeRect(M, M, MW, MH)
  const bw = 7 * k
  ctx.strokeRect(M - bw, M - bw, MW + bw * 2, MH + bw * 2)
  ctx.lineWidth = 2.4 * k
  ctx.strokeRect(M - bw - 6 * k, M - bw - 6 * k, MW + bw * 2 + 12 * k, MH + bw * 2 + 12 * k)
  const top = p.latNorth
  const bot = p.latSouth
  const yOf = (lat: number) => M + ((lat - top) / (bot - top)) * (H - 1) * S
  const lo = Math.min(top, bot)
  const hi = Math.max(top, bot)
  let flip = false
  for (let lat = Math.floor(hi / 2) * 2; lat > lo; lat -= 2) {
    const y0 = yOf(lat)
    const y1 = yOf(Math.max(lo, lat - 2))
    ctx.fillStyle = flip ? paper : ink
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
    ctx.fillStyle = flip ? paper : ink
    ctx.fillRect(x0, M - bw, x1 - x0, bw)
    ctx.fillRect(x0, M + MH, x1 - x0, bw)
    flip = !flip
  }
  ctx.lineWidth = 0.8 * k
  ctx.strokeRect(M - bw, M - bw, MW + bw * 2, MH + bw * 2)
  ctx.fillStyle = ink
  ctx.font = `500 ${11 * k}px ${theme.labels.text}`
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

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x, y - r)
  ctx.lineTo(x + r, y)
  ctx.lineTo(x, y + r)
  ctx.lineTo(x - r, y)
  ctx.closePath()
  ctx.fill()
}
