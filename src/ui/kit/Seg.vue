<script setup lang="ts" generic="V extends string | number">
import { t } from '../i18n'

/** 分段选择：一条细框里的几个选项，选中的反白 */
defineProps<{ options: { value: V; label: string; title?: string }[]; modelValue: V | null; cols?: number }>()
const emit = defineEmits<{ 'update:modelValue': [v: V] }>()
</script>

<template>
  <div class="seg" :class="{ cols }" role="radiogroup" :style="cols ? { '--cols': cols } : undefined">
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
      {{ t(o.label) }}
    </button>
  </div>
</template>
