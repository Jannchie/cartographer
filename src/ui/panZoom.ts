// 纸图（世界、聚落）共用的平移缩放：拖动平移、滚轮以指针为中心缩放、双击适配；键盘导航（见 bindKeys）
import { isTypingTarget } from './keys'

export interface PanView {
  x: number
  y: number
  k: number
}

/** 把 size 大小的图居中放进 el：左右共留 mx、上下共留 my，再整体下移 dy */
export function fitTo(el: HTMLElement, view: PanView, size: { width: number; height: number }, m: { mx: number; my: number; dy: number }) {
  const k = Math.min((el.clientWidth - m.mx) / size.width, (el.clientHeight - m.my) / size.height)
  view.k = k
  view.x = (el.clientWidth - size.width * k) / 2
  view.y = (el.clientHeight - size.height * k) / 2 + m.dy
}

/** 在 el 上接好拖动与滚轮；view 原地修改，改完调用 apply。fit 给出时双击适配 */
export function bindPanZoom(el: HTMLElement, view: PanView, apply: () => void, o: { min: number; max: number; fit?: () => void }) {
  let drag: { x: number; y: number; vx: number; vy: number } | null = null
  // 触屏双指：按下的手指位置；两指时以两指中点为中心缩放，同时跟着中点平移
  const touches = new Map<number, { x: number; y: number }>()
  let pinch: { d: number; cx: number; cy: number } | null = null
  const pinchOf = () => {
    const [a, b] = [...touches.values()]
    const r = el.getBoundingClientRect()
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top }
  }
  /** 剩一根手指（或松开第二指）时，从它当前位置接着单指拖动，免得地图跳一下 */
  const restartDrag = () => {
    const p = [...touches.values()][0]
    drag = p ? { x: p.x, y: p.y, vx: view.x, vy: view.y } : null
  }
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId)
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.size === 2) {
        pinch = pinchOf()
        drag = null
        return
      }
      if (touches.size > 2) return
    }
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    el.classList.add('dragging')
  })
  el.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && touches.size === 2) {
      const p = pinchOf()
      const nk = Math.min(o.max, Math.max(o.min, (view.k * p.d) / pinch.d))
      // 先跟着中点平移，再以新中点为中心缩放
      view.x += p.cx - pinch.cx
      view.y += p.cy - pinch.cy
      view.x = p.cx - ((p.cx - view.x) * nk) / view.k
      view.y = p.cy - ((p.cy - view.y) * nk) / view.k
      view.k = nk
      pinch = p
      apply()
      return
    }
    if (!drag) return
    view.x = drag.vx + e.clientX - drag.x
    view.y = drag.vy + e.clientY - drag.y
    apply()
  })
  const up = (e: PointerEvent) => {
    if (touches.delete(e.pointerId) && touches.size) {
      pinch = touches.size === 2 ? pinchOf() : null
      if (!pinch) restartDrag()
      return
    }
    pinch = null
    drag = null
    el.classList.remove('dragging')
  }
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const cx = e.clientX - r.left
      const cy = e.clientY - r.top
      const nk = Math.min(o.max, Math.max(o.min, view.k * Math.exp(-e.deltaY * 0.0015)))
      view.x = cx - ((cx - view.x) * nk) / view.k
      view.y = cy - ((cy - view.y) * nk) / view.k
      view.k = nk
      apply()
    },
    { passive: false },
  )
  if (o.fit) el.addEventListener('dblclick', o.fit)
  bindKeys(el, view, apply, o)
}

/** 平移速度（像素 / 秒，按住 Shift 三倍）与缩放速度（每秒倍率的对数） */
const PAN_SPEED = 700
const ZOOM_SPEED = 1.6
const PAN_KEYS: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
const ZOOM_KEYS: Record<string, number> = { '+': 1, '=': 1, '-': -1, _: -1 }

/**
 * 键盘导航：方向键平移、+ / − 以视口中心缩放（按住连续平滑移动，Shift 加速），0 适配整图。
 * 只对看得见的那张图起作用；焦点在输入框、滑块这类自己处理按键的控件上时让位（isTypingTarget）
 */
function bindKeys(el: HTMLElement, view: PanView, apply: () => void, o: { min: number; max: number; fit?: () => void }) {
  const held = new Set<string>()
  let shift = false
  let raf = 0
  let last = 0
  const visible = () => el.isConnected && el.offsetParent !== null && !el.classList.contains('hidden')
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (!held.size || !visible()) {
      raf = 0
      held.clear()
      return
    }
    let dx = 0
    let dy = 0
    let dz = 0
    for (const k of held) {
      const p = PAN_KEYS[k]
      if (p) {
        dx += p[0]
        dy += p[1]
      } else dz += ZOOM_KEYS[k] ?? 0
    }
    const v = PAN_SPEED * (shift ? 3 : 1) * dt
    view.x += dx * v
    view.y += dy * v
    if (dz) {
      const nk = Math.min(o.max, Math.max(o.min, view.k * Math.exp(dz * ZOOM_SPEED * (shift ? 2 : 1) * dt)))
      const cx = el.clientWidth / 2
      const cy = el.clientHeight / 2
      view.x = cx - ((cx - view.x) * nk) / view.k
      view.y = cy - ((cy - view.y) * nk) / view.k
      view.k = nk
    }
    apply()
    raf = requestAnimationFrame(tick)
  }
  window.addEventListener('keydown', (e) => {
    shift = e.shiftKey
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e) || !visible()) return
    if (e.key === '0' && o.fit) {
      e.preventDefault()
      o.fit()
      return
    }
    if (!(e.key in PAN_KEYS) && !(e.key in ZOOM_KEYS)) return
    e.preventDefault()
    held.add(e.key)
    // 按下的当下先走一帧（轻点一下也有反应），之后按住逐帧连续移动
    if (!raf) {
      last = performance.now() - 1000 / 60
      tick(performance.now())
    }
  })
  window.addEventListener('keyup', (e) => {
    shift = e.shiftKey
    held.delete(e.key)
    // Shift 松开时 + 变回 =（反之亦然）：两种写法都算松开
    for (const pair of [['=', '+'], ['-', '_']]) if (pair.includes(e.key)) for (const k of pair) held.delete(k)
  })
  window.addEventListener('blur', () => held.clear())
}
