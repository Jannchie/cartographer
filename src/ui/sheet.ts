// 窄屏的侧边栏：变成贴着底边的抽屉，三档高度——收起（只露把手、页签与生成）、半屏、近全屏
import { computed, onMounted, ref, type Ref } from 'vue'

export type Snap = 'peek' | 'half' | 'full'

/** 窄屏断点：与 style.css 里的 @media (max-width: 760px) 一致 */
const QUERY = '(max-width: 760px)'
/** 全屏时上方留出的一截舞台：看得见地图，点它收起 */
const TOP_GAP = 72
/** 快速甩动的速度（像素 / 毫秒）：超过它就往甩的方向再走一档，不看松手位置 */
const FLICK = 0.5
/** 收起时露出的几块：把手、页签、底栏 */
const PEEK_PARTS = ['.sheet-grip', '.ptabs', '.panel-foot']

const mq = window.matchMedia(QUERY)
/** 当前是否窄屏 */
export const narrow = ref(mq.matches)
mq.addEventListener('change', () => (narrow.value = mq.matches))

/**
 * 抽屉的拖动与吸附。panel 是抽屉本身；收起时的高度量它里面的把手、页签与底栏。
 * live 是抽屉此刻的高度（拖动中跟手），stage 是舞台底边让出的高度：只在松手吸附后才变，
 * 而且最多让到半屏（全屏时抽屉盖住舞台，舞台不必跟着缩成一条再重排）
 */
export function useSheet(panel: Ref<HTMLElement | undefined>) {
  const snap = ref<Snap>('peek')
  const vh = ref(window.innerHeight)
  const peekH = ref(140)
  const drag = ref<{ y0: number; h0: number; h: number; t: number; v: number } | null>(null)

  const heightOf = (s: Snap) => (s === 'peek' ? peekH.value : s === 'half' ? Math.max(peekH.value, Math.round(vh.value * 0.5)) : Math.max(peekH.value, vh.value - TOP_GAP))
  const live = computed(() => (drag.value ? drag.value.h : heightOf(snap.value)))
  const stage = computed(() => Math.min(heightOf(snap.value), heightOf('half')))

  function measure() {
    vh.value = window.innerHeight
    const el = panel.value
    if (!el) return
    const parts = PEEK_PARTS.map((s) => el.querySelector<HTMLElement>(s)?.offsetHeight ?? 0)
    const h = parts.reduce((a, b) => a + b, 0)
    if (h > 0) peekH.value = h
  }
  onMounted(() => {
    measure()
    window.addEventListener('resize', measure)
    // 抽屉一开始可能藏着（首页），字体也可能还没到：几块的尺寸一变就重量
    const ro = new ResizeObserver(measure)
    for (const s of PEEK_PARTS) {
      const el = panel.value?.querySelector(s)
      if (el) ro.observe(el)
    }
  })

  /** 吸附到某一档；舞台尺寸变了就让纸图按新尺寸重新适配（与窗口缩放同一套处理） */
  function setSnap(s: Snap) {
    const before = stage.value
    snap.value = s
    if (stage.value !== before) setTimeout(() => window.dispatchEvent(new Event('resize')), 320)
  }
  /** 收起时点页签：顺手拉到半屏，好看见这一页的内容 */
  function reveal() {
    if (snap.value === 'peek') setSnap('half')
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    measure()
    const h = live.value
    drag.value = { y0: e.clientY, h0: h, h, t: e.timeStamp, v: 0 }
  }
  function onMove(e: PointerEvent) {
    const d = drag.value
    if (!d) return
    const h = Math.min(heightOf('full'), Math.max(peekH.value, d.h0 + d.y0 - e.clientY))
    const dt = e.timeStamp - d.t
    if (dt > 0) d.v = (h - d.h) / dt
    d.h = h
    d.t = e.timeStamp
  }
  function onUp(e: PointerEvent) {
    const d = drag.value
    if (!d) return
    drag.value = null
    // 停稳了才松手的不算甩
    if (e.timeStamp - d.t > 80) d.v = 0
    const order: Snap[] = ['peek', 'half', 'full']
    // 几乎没动：当作轻点，收起时拉开、展开时收起
    if (Math.abs(d.h - d.h0) < 6) return setSnap(snap.value === 'peek' ? 'half' : 'peek')
    if (d.v > FLICK) return setSnap(order.find((s) => heightOf(s) > d.h) ?? 'full')
    if (d.v < -FLICK) return setSnap([...order].reverse().find((s) => heightOf(s) < d.h) ?? 'peek')
    let best = order[0]
    for (const s of order) if (Math.abs(heightOf(s) - d.h) < Math.abs(heightOf(best) - d.h)) best = s
    setSnap(best)
  }

  return { snap, live, stage, dragging: computed(() => !!drag.value), setSnap, reveal, onDown, onMove, onUp }
}
