<script setup lang="ts">
import { IconChevronLeft, IconChevronRight } from '@jannchie/icons'
import { t } from '../i18n'
import Icon from './Icon.vue'

/**
 * 方案切换：同一种子下的第几套随机细节。0 是种子本身的方案（显示为"原样"），
 * › 换下一套、‹ 回到上一套；整行的说明放在 title 里
 */
defineProps<{ modelValue: number; label: string; title?: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: number] }>()
</script>

<template>
  <div class="counter variant" :class="{ disabled, manual: modelValue > 0 }" :title="title ? t(title) : undefined">
    <span class="counter-name">{{ t(label) }}</span>
    <i class="counter-lead" aria-hidden="true"></i>
    <span class="counter-ctl">
      <button type="button" :title="t('上一个方案')" :disabled="disabled || modelValue <= 0" @click="emit('update:modelValue', modelValue - 1)"><Icon :icon="IconChevronLeft" :size="13" /></button>
      <b>{{ modelValue > 0 ? `#${modelValue}` : t('原样') }}</b>
      <button type="button" :title="t('下一个方案')" :disabled="disabled" @click="emit('update:modelValue', modelValue + 1)"><Icon :icon="IconChevronRight" :size="13" /></button>
    </span>
  </div>
</template>
