<script setup lang="ts">
import { t } from '../i18n'

/** 一行字段：左侧名称，右侧控件（下拉、输入框、分段） */
defineProps<{ label: string; title?: string }>()
</script>

<template>
  <div class="field" :title="title ? t(title) : undefined">
    <span class="field-name">{{ t(label) }}</span>
    <div class="field-body"><slot /></div>
  </div>
</template>
