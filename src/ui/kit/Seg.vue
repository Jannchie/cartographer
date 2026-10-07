<script setup lang="ts" generic="V extends string | number">
import type { Icon as IconDef } from '@jannchie/icons'
import { t } from '../i18n'
import Icon from './Icon.vue'

/** 分段选择：一条细框里的几个选项，选中的反白；带图标的选项（工具栏）图标在上、名称在下 */
defineProps<{ options: { value: V; label: string; title?: string; icon?: IconDef<string> }[]; modelValue: V | null; cols?: number }>()
const emit = defineEmits<{ 'update:modelValue': [v: V] }>()
</script>

<template>
  <div class="seg" :class="{ cols, iconic: options.some((o) => o.icon) }" role="radiogroup" :style="cols ? { '--cols': cols } : undefined">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="o.value === modelValue"
      :class="{ on: o.value === modelValue }"
      :title="o.title ? t(o.title) : undefined"
      @click="emit('update:modelValue', o.value)"
    >
      <Icon v-if="o.icon" :icon="o.icon" :size="18" />
      {{ t(o.label) }}
    </button>
  </div>
</template>
