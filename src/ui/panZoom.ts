// 纸图（世界、聚落）共用的平移缩放：拖动平移、滚轮以指针为中心缩放、双击适配

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
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    el.classList.add('dragging')
    el.setPointerCapture(e.pointerId)
  })
  el.addEventListener('pointermove', (e) => {
    if (!drag) return
    view.x = drag.vx + e.clientX - drag.x
    view.y = drag.vy + e.clientY - drag.y
    apply()
  })
  el.addEventListener('pointerup', () => {
    drag = null
    el.classList.remove('dragging')
  })
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
}
