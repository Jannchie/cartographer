<script setup lang="ts">
import { computed } from 'vue'
import { toPaths, type Icon, type Weight } from '@jannchie/icons'
import { dpr } from './dpr'

/**
 * 图标（@jannchie/icons）：按显示尺寸 × 设备像素比把线条对齐到像素网格，颜色跟随 currentColor。
 * 界面是直角的纸图风格，所以默认用尖角（sharp）；16px 下 regular 的线宽正好约 1 个像素。
 */
const props = withDefaults(defineProps<{ icon: Icon<string>; size?: number; weight?: Weight }>(), { size: 16, weight: 'regular' })

const shape = computed(() => {
  const { svg, paths } = toPaths(props.icon, { radius: 'sharp', weight: props.weight, px: Math.round(props.size * dpr.value) })
  return { svg, paths: paths.map(({ animate: _, ...p }) => p) }
})
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" :width="size" :height="size" v-bind="shape.svg" aria-hidden="true" focusable="false">
    <path v-for="(p, i) in shape.paths" :key="i" v-bind="p" />
  </svg>
</template>
