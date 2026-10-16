/**
 * 录制页叠加层的界面动效（全部只取决于时刻与种子，逐帧录制可复现）：
 * - 故障闪现：内容按水平条带错位、局部像素化，叠青橙两色的错位副本
 * - 信息栏：先刷出竖向的辅助线，再横向刷出内容区域；关闭时倒放。不做透明度渐变
 * - 顶部状态栏：竖向分隔线先出，各栏读数随后横向刷出
 * - 解码式出字：字符先随机跳动，再逐位定格
 * - 片头标题卡与事件提示（可从地图上的地点引出）
 */
import { clamp01, easeOut, rand, span } from './motion'
import { H, W } from './page'

export interface HudStyle {
  ink: string
  dim: string
  line: string
  accent: string
  glow: string
  sans: string
  mono: string
  /** 叠加层画布的像素比（离屏画布按它放大，保持清晰） */
  dpr: number
}

const pool = new Map<string, HTMLCanvasElement>()
function scratch(key: string, w: number, h: number) {
  let c = pool.get(key)
  if (!c) {
    c = document.createElement('canvas')
    pool.set(key, c)
  }
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c
}

/**
 * 故障闪现：把 draw 画的内容（绝对坐标，限于 x, y, w, h 的框内）先画进离屏画布，再按水平条带贴回。
 * amount 0~1：条带的错位幅度、像素化与缺失的条带比例、色差副本的强度都随它增减；0 时原样贴回
 */
export function glitch(ctx: CanvasRenderingContext2D, st: HudStyle, box: [number, number, number, number], amount: number, seed: number, draw: (g: CanvasRenderingContext2D) => void) {
  const [x, y, w, h] = box
  const k = st.dpr
  const pw = Math.max(1, Math.ceil(w * k))
  const ph = Math.max(1, Math.ceil(h * k))
  const src = scratch('src', pw, ph)
  const g = src.getContext('2d')!
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, pw, ph)
  g.setTransform(k, 0, 0, k, -x * k, -y * k)
  draw(g)
  if (amount <= 0.002) {
    ctx.drawImage(src, x, y, w, h)
    return
  }
  // 条带：高度随机，逐条决定错位、像素化或缺失
  const tiny = scratch('tiny', Math.ceil(pw / 6), Math.ceil(ph / 6))
  const tg = tiny.getContext('2d')!
  let yy = 0
  for (let i = 0; yy < h; i++) {
    const sh = Math.min(h - yy, 3 + rand(seed, i) * h * 0.22)
    const r = rand(seed + 1, i)
    const dx = (rand(seed + 2, i) - 0.5) * 90 * amount * (r < amount ? 1 : 0.12)
    if (r > 1 - amount * 0.3) {
      // 缺失
    } else if (r < amount * 0.55) {
      // 像素化：缩到很小再放大，关掉平滑
      const q = 4 + Math.floor(rand(seed + 3, i) * 10)
      const tw = Math.max(1, Math.ceil(pw / q))
      const th = Math.max(1, Math.ceil((sh * k) / q))
      tg.clearRect(0, 0, tw, th)
      tg.imageSmoothingEnabled = true
      tg.drawImage(src, 0, yy * k, pw, sh * k, 0, 0, tw, th)
      ctx.save()
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(tiny, 0, 0, tw, th, x + dx, y + yy, w, sh)
      ctx.restore()
    } else ctx.drawImage(src, 0, yy * k, pw, sh * k, x + dx, y + yy, w, sh)
    yy += sh
  }
  // 色差：青、橙两份错位副本，加色叠上
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const [color, sx] of [
    ['#36c8ff', 1],
    ['#ff7a3c', -1],
  ] as const) {
    const t = scratch(color, pw, ph)
    const c = t.getContext('2d')!
    c.globalCompositeOperation = 'source-over'
    c.clearRect(0, 0, pw, ph)
    c.drawImage(src, 0, 0)
    c.globalCompositeOperation = 'source-in'
    c.fillStyle = color
    c.fillRect(0, 0, pw, ph)
    ctx.globalAlpha = 0.75 * amount
    ctx.drawImage(t, x + sx * (4 + 16 * amount * rand(seed + 4, sx)), y, w, h)
  }
  ctx.restore()
}

/**
 * 信息栏的进出进度（秒）：v 为竖向辅助线（0~1），h 为横向刷出的内容区（0~1），glitch 为内容刚出现时的故障强度。
 * 打开：竖线 0.08 秒刷出，内容 0.14 秒横向刷开，随后约 0.12 秒的故障闪烁；关闭（最后 0.16 秒）：内容先收回，竖线再收起
 */
export function panelPhase(age: number, life: number) {
  const V = 0.08
  const Hd = 0.14
  const rest = life - age
  if (age < 0 || rest < 0) return { v: 0, h: 0, glitch: 0 }
  let v = easeOut(clamp01(age / V))
  let h = easeOut(clamp01((age - V) / Hd))
  if (rest < 0.16) {
    h = Math.min(h, clamp01((rest - 0.06) / 0.1))
    v = Math.min(v, clamp01(rest / 0.06))
  }
  const after = age - V - Hd
  const glitchIn = after >= 0 && after < 0.12 ? 0.55 * (1 - after / 0.12) : 0
  const glitchOut = rest < 0.16 && rest > 0.06 ? 0.4 : 0
  return { v, h, glitch: Math.max(glitchIn, glitchOut) }
}

/**
 * 信息栏：竖向辅助线在 gx（内容区的起始边），先自中点向上下刷出（超出内容区 ext 的部分较淡）；
 * 内容区从 gx 向 dir 方向（1 向右，-1 向左）横向刷开，刷开的前沿一道亮线。content 画内容（绝对坐标）
 */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  st: HudStyle,
  p: { gx: number; y: number; w: number; h: number; dir: 1 | -1; ext: number; phase: { v: number; h: number; glitch: number }; seed: number; fill?: string },
  content: (g: CanvasRenderingContext2D) => void,
) {
  const { gx, y, w, h, dir, ext, phase, seed } = p
  if (phase.v <= 0) return
  const cy = y + h / 2
  // 竖向辅助线：内容区一段较亮，向外延伸的部分较淡
  const half = (h / 2 + ext) * phase.v
  ctx.save()
  ctx.strokeStyle = st.line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(gx + 0.5, cy - half)
  ctx.lineTo(gx + 0.5, cy + half)
  ctx.stroke()
  ctx.strokeStyle = st.ink
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(gx, cy - Math.min(half, h / 2))
  ctx.lineTo(gx, cy + Math.min(half, h / 2))
  ctx.stroke()
  if (phase.h > 0) {
    const ww = w * phase.h
    const x0 = dir > 0 ? gx : gx - ww
    ctx.fillStyle = p.fill ?? 'rgba(6, 12, 22, 0.62)'
    ctx.fillRect(x0, y, ww, h)
    // 上下两道细线
    ctx.strokeStyle = st.line
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x0, y + 0.5)
    ctx.lineTo(x0 + ww, y + 0.5)
    ctx.moveTo(x0, y + h - 0.5)
    ctx.lineTo(x0 + ww, y + h - 0.5)
    ctx.stroke()
    // 内容：只露出已经刷开的部分
    ctx.save()
    ctx.beginPath()
    ctx.rect(x0, y, ww, h)
    ctx.clip()
    const bx = dir > 0 ? gx : gx - w
    glitch(ctx, st, [bx - 40, y, w + 80, h], phase.glitch, seed, content)
    ctx.restore()
    if (phase.h < 1) {
      // 刷开的前沿
      const ex = dir > 0 ? x0 + ww : x0
      ctx.fillStyle = st.glow
      ctx.fillRect(ex - 1, y, 2, h)
    } else {
      // 远端一道短竖线收口
      const ex = dir > 0 ? gx + w : gx - w
      ctx.strokeStyle = st.line
      ctx.beginPath()
      ctx.moveTo(ex + 0.5, y)
      ctx.lineTo(ex + 0.5, y + h)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * 顶部状态栏：各栏左侧一道竖向分隔线先依次刷出（自上而下），读数随后横向刷出。
 * cols 为 [标签, 读数, 宽度]；age 为状态栏出现了多久（秒）
 */
export function drawStatusBar(ctx: CanvasRenderingContext2D, st: HudStyle, cols: [string, string, number][], x: number, y: number, age: number) {
  if (age <= 0) return
  let cx = x
  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  cols.forEach(([k, v, w], i) => {
    const t = age - i * 0.04
    const line = easeOut(clamp01(t / 0.08))
    if (line > 0) {
      ctx.strokeStyle = st.line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx + 0.5, y)
      ctx.lineTo(cx + 0.5, y + 40 * line)
      ctx.stroke()
      const wipe = easeOut(clamp01((t - 0.08) / 0.14))
      if (wipe > 0) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(cx, y - 4, (w - 4) * wipe, 48)
        ctx.clip()
        ctx.fillStyle = st.dim
        ctx.font = `400 11px ${st.mono}`
        ctx.fillText(k, cx + 10, y + 13)
        ctx.fillStyle = st.ink
        ctx.font = `400 15px ${st.mono}`
        ctx.fillText(v, cx + 10, y + 34)
        ctx.restore()
        if (wipe < 1) {
          ctx.fillStyle = st.glow
          ctx.fillRect(cx + (w - 4) * wipe - 1, y, 2, 40)
        }
      }
    }
    cx += w
  })
  ctx.restore()
}

/**
 * 解码式出字：各字符先随机跳动，再从左到右依次定格（progress 0~1）。数字跳数字，其余字符跳符号
 */
export function decode(text: string, progress: number, seed: number) {
  const chars = [...text]
  const n = chars.length
  return chars
    .map((c, k) => {
      if (c === ' ' || c === ',' || progress >= 0.25 + (0.75 * (k + 1)) / n) return c
      if (progress <= 0) return ''
      const r = rand(k + 1, seed)
      return /\d/.test(c) ? String(Math.floor(r * 10)) : '#%&*+/<=>@'[Math.floor(r * 10)]
    })
    .join('')
}

/** 画布上的一个点（CSS 像素）；behind 为在镜头背后 */
export type ScreenPoint = { x: number; y: number; behind: boolean }

/**
 * 片头标题卡：两道竖线先刷出，三行文字（上方等宽小字、主标题、副标题）以故障闪现的方式出现
 * （像素块、条带错位与色差，很快稳定），停留后再故障消失。[a, b] 为出现到消失的时刻（秒）
 */
export function drawTitleCard(ctx: CanvasRenderingContext2D, st: HudStyle, sec: number, frame: number, [a, b]: readonly [number, number], text: { kicker: string; title: string; subtitle: string }) {
  if (sec < a || sec > b) return
  const cx = W / 2
  const cy = H / 2 - 10
  ctx.font = `700 84px ${st.sans}`
  const bx = ctx.measureText(text.title).width / 2 + 70
  // 竖线：自中点向上下刷出，结束时收起
  const lv = Math.min(easeOut(span(sec, a, a + 0.1)), clamp01((b - sec) / 0.08))
  ctx.fillStyle = st.ink
  for (const sx of [-1, 1]) ctx.fillRect(cx + sx * bx - 1, cy - 58 * lv, 2, 116 * lv)
  // 故障强度：出现时从 1 迅速落到 0（中间偶尔再抽一下），消失前 0.3 秒升回 1
  const age = sec - a - 0.08
  if (age < 0 || b - sec < 0.06) return
  const spike = rand(frame, 3) > 0.82 ? 0.35 : 0
  const amount = age < 0.4 ? 1 - age / 0.4 : b - sec < 0.32 ? 1 - (b - sec - 0.06) / 0.26 : age < 0.9 ? spike * (1 - (age - 0.4) / 0.5) : 0
  glitch(ctx, st, [cx - bx + 6, cy - 130, bx * 2 - 12, 260], clamp01(amount), frame, (g) => {
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = st.dim
    g.font = `400 20px ${st.mono}`
    g.fillText(text.kicker, cx, cy - 92)
    g.fillStyle = st.ink
    g.font = `700 84px ${st.sans}`
    g.fillText(text.title, cx, cy + 2)
    g.font = `500 26px ${st.sans}`
    g.fillText(text.subtitle, cx, cy + 92)
  })
}

/**
 * 从地图上的地点引出信息栏：地点处一个准星（0.06 秒内收拢），竖线自地点向上（太靠上时向下）刷出 pole 像素，
 * 信息栏（宽 w、高 h）接在竖线的顶端，向右展开（太靠右时向左）。地点不在画面里时返回画面左上的默认位置。
 * 返回信息栏的竖线位置 gx、顶边 y、展开方向 dir，以及是否锚定在地点上
 */
export function anchorPanel(ctx: CanvasRenderingContext2D, st: HudStyle, at: ScreenPoint | null, age: number, life: number, w: number, h: number, pole = 120) {
  const anchored = !!at && !at.behind && at.x > 60 && at.x < W - 60 && at.y > 200 && at.y < H - 60
  if (!at || !anchored) return { gx: 72, y: 104, dir: 1 as 1 | -1, anchored: false }
  const k = 1 + 2 * (1 - easeOut(clamp01(age / 0.06)))
  if (life - age > 0.04) {
    ctx.strokeStyle = st.glow
    ctx.lineWidth = 1.5
    const r = 9 * k
    ctx.beginPath()
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      ctx.moveTo(at.x + sx * r, at.y + sy * r * 0.5)
      ctx.lineTo(at.x + sx * r, at.y + sy * r)
      ctx.lineTo(at.x + sx * r * 0.5, at.y + sy * r)
    }
    ctx.stroke()
    ctx.fillStyle = st.glow
    ctx.fillRect(at.x - 2, at.y - 2, 4, 4)
  }
  const up = at.y - pole - h > 120
  const dir: 1 | -1 = at.x + w + 40 > W ? -1 : 1
  const grow = Math.min(easeOut(clamp01(age / 0.1)), clamp01((life - age) / 0.05))
  ctx.strokeStyle = st.ink
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(at.x, at.y + (up ? -10 : 10))
  ctx.lineTo(at.x, at.y + (up ? -10 - (pole - 10) * grow : 10 + (pole - 10) * grow))
  ctx.stroke()
  return { gx: at.x, y: up ? at.y - pole - h : at.y + pole, dir, anchored: true }
}

/**
 * 事件提示：从地点引出（见 anchorPanel），没有地点的显示在画面左上。
 * 信息栏：标题行（EVENT 与日期、右侧编号），下面是正文。age 为出现了多久、life 为总时长（秒），收起时倒放
 */
export function drawCallout(
  ctx: CanvasRenderingContext2D,
  st: HudStyle,
  frame: number,
  p: { tag: string; text: string; index: number; age: number; life: number; at: ScreenPoint | null },
) {
  const { age, life } = p
  ctx.font = `500 26px ${st.sans}`
  const w = Math.max(ctx.measureText(p.text).width + 56, 380)
  const h = 96
  const { gx, y, dir, anchored } = anchorPanel(ctx, st, p.at, age, life, w, h)
  const phase = panelPhase(anchored ? age - 0.1 : age, life - (anchored ? 0.1 : 0))
  const x0 = dir > 0 ? gx : gx - w
  drawPanel(ctx, st, { gx, y, w, h, dir, ext: anchored ? 0 : 22, phase, seed: frame * 7 + p.index }, (g) => {
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    g.fillStyle = st.accent
    g.font = `400 15px ${st.mono}`
    g.fillText(`EVENT  |  ${p.tag}`, x0 + 22, y + 26)
    g.textAlign = 'right'
    g.fillStyle = st.dim
    g.fillText(`E-${String(p.index + 1).padStart(2, '0')}`, x0 + w - 18, y + 26)
    g.fillStyle = st.line
    g.fillRect(x0 + 22, y + 38, w - 40, 1)
    g.textAlign = 'left'
    g.fillStyle = st.ink
    g.font = `500 26px ${st.sans}`
    g.fillText(p.text, x0 + 22, y + 76)
  })
}
