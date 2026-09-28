<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { t } from '../i18n'

/**
 * 数量步进器：modelValue 为 null 时是"自动"（显示推算值 auto，灰字）；
 * 点 − / + 或输入数字就变成手动值；双击回到自动。
 * 键盘：← → ↑ ↓ 增减，Delete / Backspace 回到自动，Enter 输入。
 */
const props = defineProps<{ modelValue: number | null; auto: number; max: number; label: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: number | null] }>()

const manual = computed(() => props.modelValue !== null && props.modelValue !== undefined)
const value = computed(() => (manual.value ? props.modelValue! : props.auto))
const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement>()

function set(v: number) {
  emit('update:modelValue', Math.max(0, Math.min(props.max, Math.round(v))))
}
function toAuto() {
  if (manual.value) emit('update:modelValue', null)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(value.value + 1)
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(value.value - 1)
  else if (e.key === 'Delete' || e.key === 'Backspace') toAuto()
  else if (e.key === 'Enter') startEdit()
  else return
  e.preventDefault()
}
let editTimer = 0
function clickValue() {
  clearTimeout(editTimer)
  editTimer = window.setTimeout(startEdit, 240)
}
function startEdit() {
  draft.value = String(value.value)
  editing.value = true
  nextTick(() => input.value?.select())
}
function finish(apply: boolean) {
  if (!editing.value) return
  editing.value = false
  const n = parseInt(draft.value, 10)
  if (apply && Number.isFinite(n)) set(n)
}
function dbl() {
  clearTimeout(editTimer)
  toAuto()
}
</script>

<template>
  <div class="counter" :class="{ manual, zero: value === 0, disabled }" :title="t(manual ? '手动数量 · 双击恢复自动' : '自动推算 · 调整即改为手动')" @dblclick.prevent="dbl">
    <span class="counter-name">{{ t(label) }}</span>
    <i class="counter-lead" aria-hidden="true"></i>
    <span class="counter-ctl" tabindex="0" role="spinbutton" :aria-label="t(label)" :aria-valuenow="value" :aria-valuemin="0" :aria-valuemax="max" @keydown="onKey">
      <button type="button" tabindex="-1" :disabled="value <= 0" @click="set(value - 1)" @dblclick.stop>−</button>
      <input v-if="editing" ref="input" v-model="draft" inputmode="numeric" @keydown.enter.prevent="finish(true)" @keydown.esc.prevent="finish(false)" @blur="finish(true)" @dblclick.stop />
      <b v-else @click="clickValue">{{ value }}</b>
      <button type="button" tabindex="-1" :disabled="value >= max" @click="set(value + 1)" @dblclick.stop>+</button>
    </span>
  </div>
</template>
