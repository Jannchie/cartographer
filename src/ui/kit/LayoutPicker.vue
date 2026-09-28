<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n'

/**
 * 布局三角：三个角是有机、方格、放射，点的位置就是三者的比例（重心坐标）。
 * 与生成参数的换算：规整度 r = 1 − 有机；放射度 g = 放射 / (方格 + 放射)。
 * 拖动（或方向键）改变位置，松手提交；双击恢复默认。
 */
const props = defineProps<{ regularity: number; radial: number; reset: { regularity: number; radial: number } }>()
const emit = defineEmits<{ update: [r: number, g: number]; change: [] }>()

const W = 240
const H = 118
const PAD = 14
// 顶点：有机在上，方格左下，放射右下
const A: [number, number] = [W / 2, PAD]
const B: [number, number] = [PAD, H - PAD]
const C: [number, number] = [W - PAD, H - PAD]

const weights = computed(() => {
  const r = props.regularity
  const g = props.radial
  return { organic: 1 - r, grid: r * (1 - g), radial: r * g }
})
const dot = computed(() => {
  const w = weights.value
  return [A[0] * w.organic + B[0] * w.grid + C[0] * w.radial, A[1] * w.organic + B[1] * w.grid + C[1] * w.radial]
})
const pct = (x: number) => `${Math.round(x * 100)}%`
/** 三角形里的淡网格：每条边分四份 */
const grid = computed(() => {
  const lines: string[] = []
  const lerp = (p: [number, number], q: [number, number], t: number) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
  for (let k = 1; k < 4; k++) {
    const t = k / 4
    for (const [p0, p1, q0, q1] of [
      [A, B, A, C],
      [B, C, B, A],
      [C, A, C, B],
    ] as [number, number][][]) {
      const a = lerp(p0 as [number, number], p1 as [number, number], t)
      const b = lerp(q0 as [number, number], q1 as [number, number], t)
      lines.push(`M${a[0]},${a[1]}L${b[0]},${b[1]}`)
    }
  }
  return lines.join('')
})

const svg = ref<SVGSVGElement>()
const dragging = ref(false)
function setFrom(x: number, y: number) {
  // 重心坐标，裁到三角形内
  const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1])
  let wa = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d
  let wb = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d
  let wc = 1 - wa - wb
  wa = Math.max(0, wa)
  wb = Math.max(0, wb)
  wc = Math.max(0, wc)
  const s = wa + wb + wc || 1
  wa /= s
  wb /= s
  wc /= s
  const r = +(1 - wa).toFixed(3)
  const g = wb + wc > 1e-3 ? +(wc / (wb + wc)).toFixed(3) : props.radial
  emit('update', r, g)
}
function local(e: PointerEvent) {
  const rc = svg.value!.getBoundingClientRect()
  return [((e.clientX - rc.left) / rc.width) * W, ((e.clientY - rc.top) / rc.height) * H] as const
}
function down(e: PointerEvent) {
  if (e.button !== 0) return
  svg.value!.setPointerCapture(e.pointerId)
  dragging.value = true
  setFrom(...local(e))
}
function move(e: PointerEvent) {
  if (dragging.value) setFrom(...local(e))
}
function up() {
  if (!dragging.value) return
  dragging.value = false
  emit('change')
}
function resetAll() {
  emit('update', props.reset.regularity, props.reset.radial)
  emit('change')
}
let keyTimer = 0
function key(e: KeyboardEvent) {
  const step = e.shiftKey ? 12 : 3
  const [x, y] = dot.value
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
  if (e.key in d) {
    setFrom(x + d[e.key][0], y + d[e.key][1])
    clearTimeout(keyTimer)
    keyTimer = window.setTimeout(() => emit('change'), 350)
  } else if (e.key === 'Delete' || e.key === 'Backspace') resetAll()
  else return
  e.preventDefault()
}
</script>

<template>
  <div class="layout-picker" :class="{ dragging }" :title="t('拖动选择三种布局的混合比例 · 双击恢复默认')" @dblclick.prevent="resetAll">
    <svg
      ref="svg"
      :viewBox="`0 0 ${W} ${H}`"
      tabindex="0"
      role="slider"
      :aria-label="t('布局')"
      :aria-valuetext="`${t('有机')} ${pct(weights.organic)} · ${t('方格')} ${pct(weights.grid)} · ${t('放射')} ${pct(weights.radial)}`"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @keydown="key"
    >
      <path class="lp-grid" :d="grid" />
      <path class="lp-tri" :d="`M${A[0]},${A[1]}L${B[0]},${B[1]}L${C[0]},${C[1]}Z`" />
      <circle class="lp-corner" :cx="A[0]" :cy="A[1]" r="2.5" />
      <circle class="lp-corner" :cx="B[0]" :cy="B[1]" r="2.5" />
      <circle class="lp-corner" :cx="C[0]" :cy="C[1]" r="2.5" />
      <g :transform="`translate(${dot[0]},${dot[1]})`">
        <circle class="lp-halo" r="9" />
        <rect class="lp-dot" x="-4" y="-4" width="8" height="8" />
      </g>
    </svg>
    <!-- 读数与三个角的位置对应：方格在左下、有机在上、放射在右下 -->
    <div class="lp-read">
      <span><i>{{ t('方格') }}</i>{{ pct(weights.grid) }}</span>
      <span><i>{{ t('有机') }}</i>{{ pct(weights.organic) }}</span>
      <span><i>{{ t('放射') }}</i>{{ pct(weights.radial) }}</span>
    </div>
  </div>
</template>
