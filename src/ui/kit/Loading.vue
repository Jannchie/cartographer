<script setup lang="ts">
import { t } from '../i18n'

/** 生成中：纸卡 + 比例尺式进度条（frac 缺省时为不定进度） */
defineProps<{ show: boolean; title: string; stage: string; frac?: number }>()
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="loading">
      <div class="loading-card">
        <div class="loading-title">{{ t(title) }}</div>
        <div class="loading-stage">{{ t(stage) }}</div>
        <div class="loading-bar" :class="{ indeterminate: frac === undefined }"><i :style="frac !== undefined ? { width: `${Math.round(frac * 100)}%` } : undefined"></i></div>
      </div>
    </div>
  </Transition>
</template>
