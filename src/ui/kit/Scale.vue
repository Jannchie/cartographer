<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { t } from '../i18n'

/**
 * 滑杆（自绘，不用原生 range）：
 * - 拖动：点轨道直接跳到该处，按住指针拖；Shift 精细（1/10 速度）；靠近默认值时轻微吸附
 * - 双击整行（名称、轨道、读数任意处）平滑回到复位值 reset；聚焦时 Delete / Backspace 也能复位。
 *   生成参数的复位值是当前生成结果所用的值（resetTip 换成相应的提示），显示选项的复位值是默认值
 * - 键盘：← → ↑ ↓ 一步，Shift 或 PageUp / PageDown 十步，Home / End 到两端
 * - 聚焦时滚轮微调（不抢面板滚动）
 * - 点读数可直接输入数值（inputScale 把内部值换算成显示单位，例如百分比传 100）
 * - 跨零的量（气温偏移、曝光）从零点往两边填充
 * - log：对数刻度（人口这类跨几个数量级的量），数值取两位有效数字
 */
const props = withDefaults(
  defineProps<{
    label: string
    min: number
    max: number
    step: number
    modelValue: number
    fmt?: (v: number) => string
    reset?: number
    title?: string
    inputScale?: number
    log?: boolean
    resetTip?: string
  }>(),
  { inputScale: 1, resetTip: '双击恢复默认' },
)
const emit = defineEmits<{ 'update:modelValue': [v: number]; change: [v: number] }>()

const track = ref<HTMLElement>()
const editor = ref<HTMLInputElement>()
const dragging = ref(false)
const editing = ref(false)
const draft = ref('')
/** 键盘或滚轮调节后短暂显示读数气泡 */
const peek = ref(false)

const span = computed(() => props.max - props.min)
const lmin = computed(() => Math.log(props.min))
const lspan = computed(() => Math.log(props.max) - lmin.value)
const frac = (v: number) => Math.min(1, Math.max(0, props.log ? (Math.log(Math.max(v, props.min)) - lmin.value) / lspan.value : (v - props.min) / span.value))
const fromFrac = (f: number) => (props.log ? Math.exp(lmin.value + f * lspan.value) : props.min + f * span.value)
const pos = computed(() => frac(props.modelValue) * 100)
const zero = computed(() => (!props.log && props.min < 0 && props.max > 0 ? frac(0) * 100 : 0))
const fill = computed(() => ({ left: `${Math.min(zero.value, pos.value)}%`, width: `${Math.abs(pos.value - zero.value)}%` }))
const def = computed(() => (props.reset === undefined ? null : frac(props.reset) * 100))
const atDefault = computed(() => props.reset !== undefined && Math.abs(props.modelValue - props.reset) < props.step / 2)
const text = computed(() => (props.fmt ? props.fmt(props.modelValue) : String(props.modelValue)))
const decimals = computed(() => {
  const s = String(props.step)
  return s.includes('.') ? s.length - s.indexOf('.') - 1 : 0
})
const tip = computed(() => {
  const parts = [props.title ? t(props.title) : '']
  if (props.reset !== undefined) parts.push(t(props.resetTip) + ` · ${props.fmt ? props.fmt(props.reset) : props.reset}`)
  return parts.filter(Boolean).join('\n')
})

function quantize(v: number) {
  if (props.log) {
    const c = Math.min(props.max, Math.max(props.min, v))
    const m = Math.pow(10, Math.max(0, Math.floor(Math.log10(c)) - 1))
    return Math.min(props.max, Math.max(props.min, Math.round(c / m) * m))
  }
  const q = Math.round((v - props.min) / props.step) * props.step + props.min
  return +Math.min(props.max, Math.max(props.min, q)).toFixed(decimals.value)
}

let last = props.modelValue
function set(v: number) {
  const q = quantize(v)
  if (q !== props.modelValue) emit('update:modelValue', q)
  return q
}
function commit() {
  if (props.modelValue !== last) emit('change', props.modelValue)
  last = props.modelValue
}

// —— 复位：平滑过渡到默认值 ——
let anim = 0
function reset() {
  clearTimeout(editTimer)
  if (props.reset === undefined || editing.value) return
  cancelAnimationFrame(anim)
  const from = props.modelValue
  const to = props.reset
  if (from === to) return
  const t0 = performance.now()
  const tick = (now: number) => {
    const k = Math.min(1, (now - t0) / 220)
    const e = 1 - Math.pow(1 - k, 3)
    set(from + (to - from) * e)
    if (k < 1) anim = requestAnimationFrame(tick)
    else {
      emit('update:modelValue', to)
      commit()
    }
  }
  anim = requestAnimationFrame(tick)
}

// —— 拖动 ——
let raw = 0
let lastX = 0
function fracAt(clientX: number) {
  const r = track.value!.getBoundingClientRect()
  return (clientX - r.left) / r.width
}
function snapDefault(v: number, fine: boolean) {
  if (fine || props.reset === undefined) return v
  return Math.abs(frac(v) - frac(props.reset)) < 0.012 ? props.reset : v
}
function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  cancelAnimationFrame(anim)
  const el = track.value!
  el.focus({ preventScroll: true })
  el.setPointerCapture(e.pointerId)
  dragging.value = true
  last = props.modelValue
  // 按在指针上：保持抓取点，不跳；按在轨道其他处：跳到该处
  const r = el.getBoundingClientRect()
  const thumbX = r.left + (pos.value / 100) * r.width
  // raw 是轨道上的位置（0 ~ 1），对数刻度时也一样线性拖动
  raw = Math.abs(e.clientX - thumbX) <= 7 ? frac(props.modelValue) : fracAt(e.clientX)
  lastX = e.clientX
  set(snapDefault(fromFrac(raw), e.shiftKey))
}
function onMove(e: PointerEvent) {
  if (!dragging.value) return
  const r = track.value!.getBoundingClientRect()
  // 增量拖动：Shift 时 1/10 速度，出界后回拖不会"粘"在端点
  raw += ((e.clientX - lastX) / r.width) * (e.shiftKey ? 0.1 : 1)
  lastX = e.clientX
  raw = Math.min(1.25, Math.max(-0.25, raw))
  set(snapDefault(fromFrac(Math.min(1, Math.max(0, raw))), e.shiftKey))
}
function onUp() {
  if (!dragging.value) return
  dragging.value = false
  commit()
}

// —— 键盘与滚轮 ——
let keyTimer = 0
let peekTimer = 0
function nudge(steps: number) {
  // 对数刻度：每步走轨道的 1/100
  jumpTo(props.log ? fromFrac(frac(props.modelValue) + steps / 100) : props.modelValue + steps * props.step)
}
function jumpTo(v: number) {
  cancelAnimationFrame(anim)
  set(v)
  peek.value = true
  clearTimeout(peekTimer)
  peekTimer = window.setTimeout(() => (peek.value = false), 700)
  // 连按时等停下再提交（聚落等较慢的重算只做一次）
  clearTimeout(keyTimer)
  keyTimer = window.setTimeout(commit, 350)
}
function onKey(e: KeyboardEvent) {
  const big = props.log ? 10 : Math.max(10, Math.round(span.value / props.step / 10))
  const map: Record<string, number> = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
    PageDown: -big,
    PageUp: big,
  }
  if (e.key in map) nudge(map[e.key] * (e.shiftKey && Math.abs(map[e.key]) === 1 ? 10 : 1))
  else if (e.key === 'Home') jumpTo(props.min)
  else if (e.key === 'End') jumpTo(props.max)
  else if (e.key === 'Delete' || e.key === 'Backspace') reset()
  else if (e.key === 'Enter') startEdit()
  else return
  e.preventDefault()
}
function onWheel(e: WheelEvent) {
  if (document.activeElement !== track.value) return
  e.preventDefault()
  nudge((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1))
}

// —— 直接输入 ——
/** 单击读数稍等再进入编辑：期间若是双击，则按复位处理 */
let editTimer = 0
function clickValue() {
  clearTimeout(editTimer)
  editTimer = window.setTimeout(startEdit, 240)
}
function startEdit() {
  const v = props.modelValue * props.inputScale
  draft.value = String(+v.toFixed(Math.max(0, decimals.value - Math.round(Math.log10(props.inputScale)))))
  editing.value = true
  nextTick(() => editor.value?.select())
}
function finishEdit(apply: boolean) {
  if (!editing.value) return
  editing.value = false
  if (!apply) return
  const n = parseFloat(draft.value.replace(/[^\d.+-eE]/g, ''))
  if (Number.isFinite(n)) {
    last = props.modelValue
    set(n / props.inputScale)
    commit()
  }
  track.value?.focus({ preventScroll: true })
}

onBeforeUnmount(() => {
  cancelAnimationFrame(anim)
  clearTimeout(keyTimer)
  clearTimeout(peekTimer)
  clearTimeout(editTimer)
})
</script>

<template>
  <div class="scale" :class="{ dragging, editing, 'at-default': atDefault }" :title="tip" @dblclick.prevent="reset">
    <span class="scale-name">{{ t(label) }}</span>
    <div
      ref="track"
      class="scale-track"
      role="slider"
      tabindex="0"
      :aria-label="t(label)"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="modelValue"
      :aria-valuetext="text"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @lostpointercapture="onUp"
      @keydown="onKey"
      @wheel="onWheel"
    >
      <i class="scale-rail"></i>
      <i class="scale-fill" :style="fill"></i>
      <i v-if="def !== null" class="scale-def" :style="{ left: `${def}%` }"></i>
      <i class="scale-thumb" :style="{ left: `${pos}%` }"></i>
      <Transition name="bubble">
        <span v-if="dragging || peek" class="scale-bubble" :style="{ left: `${pos}%` }">{{ text }}</span>
      </Transition>
    </div>
    <input
      v-if="editing"
      ref="editor"
      v-model="draft"
      class="scale-input"
      inputmode="decimal"
      @keydown.enter.prevent="finishEdit(true)"
      @keydown.esc.prevent="finishEdit(false)"
      @blur="finishEdit(true)"
      @dblclick.stop
    />
    <output v-else :title="t('点击输入数值')" @click="clickValue">{{ text }}</output>
  </div>
</template>
