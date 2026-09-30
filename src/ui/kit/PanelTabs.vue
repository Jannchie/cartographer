<script setup lang="ts" generic="K extends string">
import { t } from '../i18n'

/** 侧边栏顶部的分页：图标 + 短名称，选中的一页墨色、下方一道强调色短线 */
type TabIcon = 'sliders' | 'blocks' | 'brush' | 'chart' | 'layers'
defineProps<{ tabs: { id: K; label: string; icon: TabIcon; title?: string }[]; modelValue: K }>()
const emit = defineEmits<{ 'update:modelValue': [id: K] }>()

const PATHS: Record<TabIcon, string> = {
  sliders: 'M2 4.5h7M12.5 4.5H14M2 11.5h2M7.5 11.5H14M10.75 3v3M5.75 10v3',
  blocks: 'M1.5 14h13M2.5 14V8l3-2.5L8.5 8v6M8.5 14V3.5h5V14M10.5 6h1M10.5 8.5h1M10.5 11h1',
  brush: 'M9.5 3.5l3 3M11 2l3 3-7.5 7.5H3.5v-3z',
  chart: 'M1.5 14h13M3.5 12V8.5M7 12V4M10.5 12V6.5M14 12V9.5',
  layers: 'M8 2 1.5 5.25 8 8.5l6.5-3.25zM1.5 8 8 11.25 14.5 8M1.5 10.75 8 14l6.5-3.25',
}
</script>

<template>
  <nav class="ptabs" role="tablist">
    <button
      v-for="tb in tabs"
      :key="tb.id"
      type="button"
      role="tab"
      :aria-selected="tb.id === modelValue"
      :class="{ on: tb.id === modelValue }"
      :title="tb.title ? t(tb.title) : undefined"
      @click="emit('update:modelValue', tb.id)"
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path :d="PATHS[tb.icon]" /></svg>
      <span>{{ t(tb.label) }}</span>
    </button>
  </nav>
</template>
