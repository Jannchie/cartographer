<script setup lang="ts">
import { LANGS, setLang, type Lang } from '../i18n'
import { langRef, t } from './i18n'

/** 面板里空间有限：语言用简写（下拉项与当前值一致，免得选中后宽度跳动） */
const SHORT: Record<Lang, string> = { zh: '中文', en: 'EN', ja: '日本語' }
</script>

<template>
  <select class="lang" :value="langRef" :title="t('语言')" @change="setLang(($event.target as HTMLSelectElement).value as Lang)">
    <option v-for="l in LANGS" :key="l.id" :value="l.id">{{ SHORT[l.id] }}</option>
  </select>
</template>
