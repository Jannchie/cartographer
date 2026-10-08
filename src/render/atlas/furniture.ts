import { isGlobe, type World } from '../../gen/types'
import { regionProjection } from '../../gen/earth/region'
import { cjkFont, lang, t, worldTitle } from '../../i18n'
import { hash, type Fields } from './fields'
import { HYPSO_STOPS, REALM_COLORS, type Theme } from './styles'
import { labelCtx } from './svg/recorder'

const rgb = (c: number[]) => `rgb(${c.map(Math.round).join(',')})`

/** 经度：以地图中央为 0°，按中纬度换算每格经度（全球图横向正好 360°） */
export function lonScale(world: World) {
  const p = world.params
  if (isGlobe(p)) return 360 / world.W
  const midLat = (p.latNorth + p.latSouth) / 2
  return world.kmPerCell / (111.32 * Math.cos((midLat * Math.PI) / 180))
}

/**
 * 区域图的经纬网：每 step° 一条，投影后是折线（圆锥投影的经线汇聚、纬线成弧），格坐标。
 * 经线记 lon、纬线记 lat，图框上的经纬度注记按它们与图框的交点放
 */
export function projectedGraticule(world: World, step = 10): { pts: number[]; lon?: number; lat?: number }[] {
  const proj = regionProjection(world.params)
  if (!proj) return []
  const b = proj.bounds
  const out: { pts: number[]; lon?: number; lat?: number }[] = []
  for (let lat = Math.ceil(b.latS / step) * step; lat <= b.latN; lat += step) {
    const pts: number[] = []
    for (let lon = b.lonW; lon <= b.lonE + 1e-9; lon += 0.5) pts.push(...proj.toCell(lon, lat))
    out.push({ pts, lat })
  }
  for (let lon = Math.ceil(b.lonW / step) * step; lon <= b.lonE; lon += step) {
    const pts: number[] = []
    for (let lat = b.latS; lat <= b.latN + 1e-9; lat += 0.5) pts.push(...proj.toCell(lon, lat))
    out.push({ pts, lon })
  }
  return out
}

/** 折线与直线 x = v（axis 0）或 y = v（axis 1）的交点（另一个坐标） */
function crossings(pts: number[], axis: 0 | 1, v: number): number[] {
  const out: number[] = []
  for (let i = 2; i < pts.length; i += 2) {
    const a = pts[i - 2 + axis]
    const c = pts[i + axis]
    if ((a - v) * (c - v) > 0 || a === c) continue
    const t = (v - a) / (c - a)
    const o = 1 - axis
    out.push(pts[i - 2 + o] + (pts[i + o] - pts[i - 2 + o]) * t)
  }
  return out
}

export function drawGraticule(ctx: CanvasRenderingContext2D, world: World, S: number, color: string) {
  const { W, H, params: p } = world
  const k = S / 2
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 0.7 * k
  ctx.setLineDash([6 * k, 5 * k])
  if (p.region) {
    for (const g of projectedGraticule(world)) {
      ctx.beginPath()
      ctx.moveTo(g.pts[0] * S, g.pts[1] * S)
      for (let i = 2; i < g.pts.length; i += 2) ctx.lineTo(g.pts[i] * S, g.pts[i + 1] * S)
      ctx.stroke()
    }
    ctx.restore()
    return
  }
  const top = p.latNorth
  const bot = p.latSouth
  // 全球图 30° 一条（常见世界地图的间隔），其余 10°
  const gs = isGlobe(p) ? 30 : 10
  for (let lat = Math.ceil(Math.min(top, bot) / gs) * gs; lat <= Math.max(top, bot); lat += gs) {
    const y = ((lat - top) / (bot - top)) * (H - 1) * S
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W * S, y)
    ctx.stroke()
  }
  const ls = lonScale(world)
  const lonHalf = (W / 2) * ls
  for (let lon = Math.ceil(-lonHalf / gs) * gs; lon <= lonHalf; lon += gs) {
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
  drawScaleBarAt(ctx, theme, S, world.kmPerCell / S, x, y, [100, 200, 250, 500, 1000, 2000])
}

/** 浏览器图廓里用的比例尺长度候选（随缩放从几公里到几千公里） */
export const SCALE_NICE_KM = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000]

/** 比例尺：S 定线宽字号（k = S / 2），kmPx 为每像素多少公里，取 nice 里画出来最接近 240k 像素的长度；(x, y) 为尺的中点 */
export function drawScaleBarAt(ctx: CanvasRenderingContext2D, theme: Theme, S: number, kmPx: number, x: number, y: number, nice: number[]) {
  const k = S / 2
  const target = 240 * k * kmPx
  const kmLen = nice.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
  const len = kmLen / kmPx
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
  ctx.fillText(t('公里'), len + 5 * k, 3 * k)
  ctx.restore()
}

// ———————————————————————— 图名 ————————————————————————

/** 字距加宽的居中文字；halo 为真时每个字先按当前 strokeStyle / lineWidth 描边再填充 */
function spaced(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, spacing: number, halo = false) {
  const ws = [...text].map((c) => ctx.measureText(c).width)
  const tot = ws.reduce((a, b) => a + b, 0) + spacing * (text.length - 1)
  let x = cx - tot / 2
  ctx.textAlign = 'left'
  for (let i = 0; i < text.length; i++) {
    if (halo) ctx.strokeText(text[i], x, y)
    ctx.fillText(text[i], x, y)
    x += ws[i] + spacing
  }
  return tot
}

/** 返回图名区域（供注记避让） */
export function drawCartouche(ctx: CanvasRenderingContext2D, world: World, theme: Theme, S: number, MW: number) {
  const k = S / 2
  const title = lang === 'en' ? world.worldName.toUpperCase() : worldTitle(world)
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
      ctx.font = `400 ${32 * k}px ${theme.labels.display}, ${cjkFont(lang)}`
      spaced(ctx, title, w / 2, 44 * k, 7 * k)
      ctx.font = `italic 400 ${13 * k}px ${theme.labels.text}, ${cjkFont(lang)}`
      ctx.textAlign = 'center'
      ctx.fillText(t('此乃{name}之地', { name: worldTitle(world) }), w / 2, 62 * k)
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
      ctx.font = `500 ${12 * k}px ${theme.labels.text}, ${cjkFont(lang)}`
      spaced(ctx, t('海图'), w / 2, 22 * k, 2.5 * k)
      ctx.font = `600 ${30 * k}px ${theme.labels.display}, ${cjkFont(lang)}`
      spaced(ctx, title, w / 2, 56 * k, 6 * k)
      ctx.font = `italic 500 ${12 * k}px ${theme.labels.text}, ${cjkFont(lang)}`
      ctx.textAlign = 'center'
      ctx.fillText(t('测深以米计 · 以平均海面为基准'), w / 2, 78 * k)
      ctx.fillText(t('种子「{seed}」测绘', { seed: world.params.seed }), w / 2, 94 * k)
      box = { x0: 0, y0: 0, x1: x + w + 12 * k, y1: y + h + 10 * k }
      break
    }
    case 'game': {
      // 游戏大地图的区域名：无底框，白字深描边，下方一道带菱形的细装饰线
      const x = 30 * k
      const y = 28 * k
      const w = 320 * k
      ctx.translate(x, y)
      ctx.fillStyle = theme.ink
      ctx.strokeStyle = theme.labels.halo
      ctx.lineJoin = 'round'
      ctx.font = `600 ${34 * k}px ${theme.labels.display}, ${cjkFont(lang)}`
      ctx.lineWidth = 4 * k
      spaced(ctx, title, w / 2, 38 * k, 8 * k, true)
      ctx.lineWidth = 1 * k
      ctx.strokeStyle = theme.ink
      ctx.globalAlpha = 0.85
      for (const [a, b] of [[20 * k, w / 2 - 9 * k], [w / 2 + 9 * k, w - 20 * k]]) {
        ctx.beginPath()
        ctx.moveTo(a, 52 * k)
        ctx.lineTo(b, 52 * k)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.moveTo(w / 2, 47 * k)
      ctx.lineTo(w / 2 + 5 * k, 52 * k)
      ctx.lineTo(w / 2, 57 * k)
      ctx.lineTo(w / 2 - 5 * k, 52 * k)
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.font = `600 ${12 * k}px ${theme.labels.text}, ${cjkFont(lang)}`
      ctx.strokeStyle = theme.labels.halo
      ctx.lineWidth = 3 * k
      const sub = t('种子 · {seed}', { seed: lang === 'en' ? world.params.seed.toUpperCase() : world.params.seed })
      spaced(ctx, sub, w / 2, 74 * k, 3 * k, true)
      box = { x0: 0, y0: 0, x1: x + w + 16 * k, y1: y + 86 * k }
      break
    }
    case 'ink': {
      // 竖排题名 + 朱文印（英文题名转 90° 顺边排）
      const zhTitle = t('{name}舆地全图', { name: worldTitle(world) })
      const size = 30 * k
      const x = MW - 44 * k
      const y = 34 * k
      ctx.fillStyle = theme.ink
      ctx.font = `400 ${size}px ${theme.labels.display}, ${cjkFont(lang)}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      if (lang === 'en') {
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(Math.PI / 2)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.font = `400 ${size * 0.8}px ${theme.labels.display}, ${cjkFont(lang)}`
        ctx.fillText(zhTitle, 0, 0)
        const len = ctx.measureText(zhTitle).width
        ctx.font = `400 ${13 * k}px ${theme.labels.text}, ${cjkFont(lang)}`
        ctx.fillText(t('种子 {seed}', { seed: world.params.seed }), 0, size * 0.9)
        ctx.restore()
        box = { x0: x - size * 1.7, y0: 0, x1: MW, y1: y + len + 20 * k }
        break
      }
      const chars = [...zhTitle]
      chars.forEach((c, i) => ctx.fillText(c, x, y + i * size * 1.12))
      const bottom = y + chars.length * size * 1.12
      // 落款小字
      ctx.font = `400 ${13 * k}px ${theme.labels.text}, ${cjkFont(lang)}`
      const sign = [...t('种子 {seed}', { seed: world.params.seed })]
      sign.forEach((c, i) => ctx.fillText(c, x - size * 1.1, y + size * 0.6 + i * 14 * k))
      seal(ctx, x - size * 0.5, bottom + 10 * k, 58 * k, worldTitle(world), k)
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
      ctx.font = `${sans ? 700 : 600} ${(sans ? 26 : 32) * k}px ${theme.labels.display}, ${cjkFont(lang)}`
      spaced(ctx, title, w / 2, 44 * k, (sans ? 5 : 9.6) * k)
      ctx.font = `${sans ? '' : 'italic'} 500 ${13 * k}px ${theme.labels.text}, ${cjkFont(lang)}`
      ctx.textAlign = 'center'
      const sub =
        theme.id === 'topo'
            ? t('地形测量图 · 等高距 100 米')
            : t('已知世界自然地理图 · 种子「{seed}」', { seed: world.params.seed })
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
    ctx.fillText(t('海拔（米）'), bx, y + 43 * k)
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

/**
 * 测深：抖动网格上标注水深（米，数字的中心就是测点），近岸密、远洋疏。
 * 在查看器里（矢量记录）按海图的取舍排：放不下时浅的先留（关系航行安全）、深的先省；放大后再补两层更密的测点
 * （网格减半、再减半，只在近岸），疏密随比例尺变。纸面成品（位图、导出）只有第一层，与原来相同
 */
export function drawSoundings(ctx: CanvasRenderingContext2D, f: Fields) {
  const { world, S } = f
  const { W, H, elevation: e, coastDist } = world
  const k = S / 2
  const rec = labelCtx(ctx)
  ctx.save()
  ctx.fillStyle = 'rgba(40, 60, 80, 0.72)'
  ctx.font = `italic 500 ${9.5 * k}px "Cormorant Garamond", serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const text = (m: number) => (m >= 1000 ? String(Math.round(m / 10) * 10) : String(m))
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
      rec.beginLabel?.(jx * S, jy * S, undefined, undefined, { rank: m, zoom: 0 })
      ctx.fillText(text(m), jx * S, jy * S)
      rec.endLabel?.()
    }
  }
  // 加密层：只在矢量记录时（查看器放大后按需出现）。第 t 层网格是 g / 2^t，跳过上一层已有的格点；
  // 该层相邻测点在屏幕上至少隔 SPACING 个 CSS 像素时才参与
  if (rec.beginLabel) {
    const SPACING = 36
    for (let t = 1; t <= 2; t++) {
      const step = g / 2 ** t
      const zoom = SPACING / (step * S)
      // 越密的层离岸越近才补（远洋的海图测深本来就疏）
      const reach = t === 1 ? 25 : 12
      for (let r = 0; ; r++) {
        const y = 8 + r * step
        if (y >= H - 8) break
        for (let c = 0; ; c++) {
          const x = 8 + c * step
          if (x >= W - 8) break
          if (r % 2 === 0 && c % 2 === 0) continue
          const jx = x + (hash(Math.round(x * 4), Math.round(y * 4) + t) - 0.5) * step * 0.6
          const jy = y + (hash(Math.round(y * 4) + t, Math.round(x * 4)) - 0.5) * step * 0.6
          const d = -bilinear(e, W, H, jx, jy)
          if (d <= 0) continue
          const cd = -coastDist[Math.round(jy) * W + Math.round(jx)]
          if (cd < 1.5 || cd > reach) continue
          const m = Math.round(d * 1000)
          rec.beginLabel(jx * S, jy * S, undefined, undefined, { rank: t * 1e6 + m, zoom })
          ctx.fillText(text(m), jx * S, jy * S)
          rec.endLabel?.()
        }
      }
    }
  }
  ctx.restore()
}

/** 格点场在 (x, y)（格坐标，可带小数）处的双线性插值 */
function bilinear(a: Float32Array, W: number, H: number, x: number, y: number) {
  const x0 = Math.max(0, Math.min(W - 2, Math.floor(x)))
  const y0 = Math.max(0, Math.min(H - 2, Math.floor(y)))
  const fx = Math.max(0, Math.min(1, x - x0))
  const fy = Math.max(0, Math.min(1, y - y0))
  const i = y0 * W + x0
  return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + W] * (1 - fx) + a[i + W + 1] * fx) * fy
}

// ———————————————————————— 图框 ————————————————————————

export function drawFrame(ctx: CanvasRenderingContext2D, world: World, theme: Theme, S: number, M: number, MW: number, MH: number) {
  // 全球图横跨 360°：注记 30° 一个，免得挤在一起
  const step = isGlobe(world.params) ? 30 : 10
  drawFrameAt(ctx, world, theme, S, M, M, MW, MH, { ox: M, oy: M, s: S }, step, step / 5)
}

/**
 * 图框：内框左上角 (M, MY)、大小 MW × MH；S 定线宽字号（k = S / 2）。
 * geo 是地图格坐标到画面的换算（画面 x = ox + 格 x · s），经纬刻度带与边注按它定位，只画落在内框里的；
 * 每 step° 一个经纬度注记，刻度带每 band° 换一次黑白。整页排版时内框就是地图框、geo 与之重合。
 */
export function drawFrameAt(
  ctx: CanvasRenderingContext2D,
  world: World,
  theme: Theme,
  S: number,
  M: number,
  MY: number,
  MW: number,
  MH: number,
  geo: { ox: number; oy: number; s: number },
  step: number,
  band: number,
) {
  if (theme.frame === 'none') return
  const k = S / 2
  const ink = theme.ink
  const paper = rgb(theme.paper)
  ctx.save()
  if (theme.frame === 'ornate') {
    ctx.strokeStyle = ink
    ctx.lineWidth = 2.6 * k
    ctx.strokeRect(M - 10 * k, MY - 10 * k, MW + 20 * k, MH + 20 * k)
    ctx.lineWidth = 1 * k
    ctx.strokeRect(M - 4 * k, MY - 4 * k, MW + 8 * k, MH + 8 * k)
    ctx.strokeRect(M, MY, MW, MH)
    // 四角的方形饰块
    for (const [cx, cy] of [
      [M - 7 * k, MY - 7 * k],
      [M + MW + 7 * k, MY - 7 * k],
      [M - 7 * k, MY + MH + 7 * k],
      [M + MW + 7 * k, MY + MH + 7 * k],
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
      for (const y of [MY - 7 * k, MY + MH + 7 * k]) diamond(ctx, x, y, 2.4 * k)
    }
    for (let y = MY + step; y < MY + MH - step / 2; y += step) {
      for (const x of [M - 7 * k, M + MW + 7 * k]) diamond(ctx, x, y, 2.4 * k)
    }
    ctx.restore()
    return
  }
  if (theme.frame === 'ink') {
    ctx.strokeStyle = ink
    ctx.lineWidth = 2.2 * k
    ctx.strokeRect(M - 9 * k, MY - 9 * k, MW + 18 * k, MH + 18 * k)
    ctx.lineWidth = 0.8 * k
    ctx.strokeRect(M - 3 * k, MY - 3 * k, MW + 6 * k, MH + 6 * k)
    ctx.restore()
    return
  }
  const p = world.params
  const { W, H } = world
  ctx.strokeStyle = ink
  ctx.lineWidth = 1.2 * k
  ctx.strokeRect(M, MY, MW, MH)
  const bw = 7 * k
  ctx.strokeRect(M - bw, MY - bw, MW + bw * 2, MH + bw * 2)
  ctx.lineWidth = 2.4 * k
  ctx.strokeRect(M - bw - 6 * k, MY - bw - 6 * k, MW + bw * 2 + 12 * k, MH + bw * 2 + 12 * k)
  if (p.region) {
    // 区域图：经纬线是投影后的曲线，没有等距的刻度带；经纬度注记写在经纬线与地图边的交点外侧
    ctx.lineWidth = 0.8 * k
    ctx.fillStyle = ink
    ctx.font = `500 ${11 * k}px ${theme.labels.text}`
    ctx.textBaseline = 'middle'
    const sx = (x: number) => geo.ox + x * geo.s
    const sy = (y: number) => geo.oy + y * geo.s
    const inY = (y: number) => y >= MY + 6 * k && y <= MY + MH - 6 * k
    const inX = (x: number) => x >= M + 12 * k && x <= M + MW - 12 * k
    // 内框四条边在格坐标里的位置（放大平移时只露出地图的一部分）
    const top = (MY - geo.oy) / geo.s
    const bottom = (MY + MH - geo.oy) / geo.s
    const left = (M - geo.ox) / geo.s
    const right = (M + MW - geo.ox) / geo.s
    for (const g of projectedGraticule(world)) {
      if (g.lon !== undefined) {
        const t = `${Math.abs(g.lon)}°${g.lon > 0 ? 'E' : g.lon < 0 ? 'W' : ''}`
        ctx.textAlign = 'center'
        for (const x of crossings(g.pts, 1, top)) if (inX(sx(x))) ctx.fillText(t, sx(x), MY - bw - 12 * k)
        for (const x of crossings(g.pts, 1, bottom)) if (inX(sx(x))) ctx.fillText(t, sx(x), MY + MH + bw + 12 * k)
      } else if (g.lat !== undefined) {
        const t = `${Math.abs(g.lat)}°${g.lat > 0 ? 'N' : g.lat < 0 ? 'S' : ''}`
        ctx.textAlign = 'right'
        for (const y of crossings(g.pts, 0, left)) if (inY(sy(y))) ctx.fillText(t, M - bw - 9 * k, sy(y))
        ctx.textAlign = 'left'
        for (const y of crossings(g.pts, 0, right)) if (inY(sy(y))) ctx.fillText(t, M + MW + bw + 9 * k, sy(y))
      }
    }
    ctx.restore()
    return
  }
  const top = p.latNorth
  const bot = p.latSouth
  const yOf = (lat: number) => geo.oy + ((lat - top) / (bot - top)) * (H - 1) * geo.s
  const lo = Math.min(top, bot)
  const hi = Math.max(top, bot)
  // 黑白相间的刻度带：按序号定黑白（从固定的起点数），平移时不闪；只画落在内框里的一段
  const lat0 = Math.floor(hi / band) * band
  for (let i = 0; lat0 - i * band > lo; i++) {
    const lat = lat0 - i * band
    const y0 = yOf(lat)
    const y1 = yOf(Math.max(lo, lat - band))
    const ya = Math.max(MY, Math.min(y0, y1))
    const yb = Math.min(MY + MH, Math.max(y0, y1))
    if (yb <= ya) continue
    ctx.fillStyle = i % 2 ? paper : ink
    ctx.fillRect(M - bw, ya, bw, yb - ya)
    ctx.fillRect(M + MW, ya, bw, yb - ya)
  }
  const ls = lonScale(world)
  const lonHalf = (W / 2) * ls
  const xOf = (lon: number) => geo.ox + (lon / ls + W / 2) * geo.s
  const lon0 = Math.floor(-lonHalf / band) * band
  for (let i = 0; lon0 + i * band < lonHalf; i++) {
    const lon = lon0 + i * band
    const x0 = Math.max(M, xOf(lon))
    const x1 = Math.min(M + MW, xOf(lon + band))
    if (x1 <= x0) continue
    ctx.fillStyle = i % 2 ? paper : ink
    ctx.fillRect(x0, MY - bw, x1 - x0, bw)
    ctx.fillRect(x0, MY + MH, x1 - x0, bw)
  }
  ctx.lineWidth = 0.8 * k
  ctx.strokeRect(M - bw, MY - bw, MW + bw * 2, MH + bw * 2)
  ctx.fillStyle = ink
  ctx.font = `500 ${11 * k}px ${theme.labels.text}`
  ctx.textBaseline = 'middle'
  const inY = (y: number) => y >= MY - 0.5 && y <= MY + MH + 0.5
  const inX = (x: number) => x >= M - 0.5 && x <= M + MW + 0.5
  for (let lat = Math.ceil(lo / step) * step; lat <= hi; lat += step) {
    const y = yOf(lat)
    if (!inY(y)) continue
    const t = `${Math.abs(lat)}°${lat > 0 ? 'N' : lat < 0 ? 'S' : ''}`
    ctx.textAlign = 'right'
    ctx.fillText(t, M - bw - 9 * k, y)
    ctx.textAlign = 'left'
    ctx.fillText(t, M + MW + bw + 9 * k, y)
  }
  ctx.textAlign = 'center'
  for (let lon = Math.ceil(-lonHalf / step) * step; lon <= lonHalf; lon += step) {
    const x = xOf(lon)
    if (!inX(x)) continue
    const t = `${Math.abs(lon)}°${lon > 0 ? 'E' : lon < 0 ? 'W' : ''}`
    ctx.fillText(t, x, MY - bw - 12 * k)
    ctx.fillText(t, x, MY + MH + bw + 12 * k)
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
