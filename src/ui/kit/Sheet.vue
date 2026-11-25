<script setup lang="ts">
import { t } from '../i18n'

/**
 * 浮层的外壳：半透明的遮罩加一张居中的纸。点遮罩或按 Esc 关闭（向外发 close）；
 * 内容（标题栏用 .modal-head / .modal-actions / .modal-close 这几个通用的类）由调用方放进来
 */
defineProps<{ open: boolean; label: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div v-if="open" class="modal" @pointerdown.self="emit('close')" @keydown.esc="emit('close')">
    <section class="modal-sheet" role="dialog" :aria-label="t(label)">
      <slot />
    </section>
  </div>
</template>
