<script setup lang="ts" generic="K extends string">
import type { Icon as IconDef } from '@jannchie/icons'
import { t } from '../i18n'
import Icon from './Icon.vue'

/** 侧边栏顶部的分页：图标 + 短名称，选中的一页墨色、下方一道强调色短线 */
defineProps<{ tabs: { id: K; label: string; icon: IconDef<string>; title?: string }[]; modelValue: K }>()
const emit = defineEmits<{ 'update:modelValue': [id: K] }>()
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
      <Icon :icon="tb.icon" :size="18" />
      <span>{{ t(tb.label) }}</span>
    </button>
  </nav>
</template>
