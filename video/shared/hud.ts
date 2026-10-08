/**
 * 录制页叠加层的界面动效（全部只取决于时刻与种子，逐帧录制可复现）：
 * - 故障闪现：内容按水平条带错位、局部像素化，叠青橙两色的错位副本
 * - 信息栏：先刷出竖向的辅助线，再横向刷出内容区域；关闭时倒放。不做透明度渐变
 * - 顶部状态栏：竖向分隔线先出，各栏读数随后横向刷出
 * - 解码式出字：字符先随机跳动，再逐位定格
 */
import { clamp01, easeOut, rand } from './motion'

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
