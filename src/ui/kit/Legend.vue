<script setup lang="ts">
import { t } from '../i18n'

/**
 * 开关组：画成地图图例，实心方块为开、空心为关。
 * 带 color 的项是色块图例（方块填这个颜色），note 是右侧的小注（比例、面积）。
 */
defineProps<{ items: { label: string; on: boolean; title?: string; color?: string; note?: string }[] }>()
const emit = defineEmits<{ toggle: [i: number] }>()
</script>

<template>
  <div class="legend" :class="{ swatched: items.some((it) => it.color) }">
    <button v-for="(it, i) in items" :key="it.label" type="button" :class="{ on: it.on }" :aria-pressed="it.on" :title="it.title ? t(it.title) : undefined" @click="emit('toggle', i)">
      <i :style="it.color ? { color: it.color, background: it.on ? it.color : 'transparent' } : undefined"></i>{{ t(it.label) }}<small v-if="it.note">{{ it.note }}</small>
    </button>
  </div>
</template>
