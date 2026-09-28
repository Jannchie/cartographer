<script setup lang="ts">
import { t } from '../i18n'

/** 面板分节：编号（CSS 计数器）+ 标题 + 一条延伸到右边的细线 */
defineProps<{ title?: string }>()
</script>

<template>
  <section class="sec">
    <h2 v-if="title"><span>{{ t(title) }}</span></h2>
    <slot />
  </section>
</template>
