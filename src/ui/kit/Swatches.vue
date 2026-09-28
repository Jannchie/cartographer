<script setup lang="ts" generic="V extends string">
import { t } from '../i18n'

/** 风格色卡：每张卡就是那种风格的一小块纸样（底色 + 墨色 + 图廓） */
defineProps<{ items: { id: V; name: string; desc: string; paper: string; ink: string }[]; modelValue: V }>()
const emit = defineEmits<{ 'update:modelValue': [v: V] }>()
</script>

<template>
  <div class="swatches">
    <button
      v-for="s in items"
      :key="s.id"
      type="button"
      :class="{ on: s.id === modelValue }"
      :title="t(s.desc)"
      :style="{ '--sw-paper': s.paper, '--sw-ink': s.ink }"
      @click="emit('update:modelValue', s.id)"
    >
      <span>{{ t(s.name) }}</span>
    </button>
  </div>
</template>
