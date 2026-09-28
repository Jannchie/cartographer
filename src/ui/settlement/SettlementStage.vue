<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { t } from '../i18n'
import Loading from '../kit/Loading.vue'
import { mountSettlement, ss } from './settlement'

const host = ref<HTMLElement>()
onMounted(() => mountSettlement(host.value!))
</script>

<template>
  <main class="stage">
    <div ref="host" class="view paper-view"></div>
    <div class="neatline" aria-hidden="true"></div>
    <div class="hint">{{ t('拖动平移 · 滚轮缩放 · 双击复位 · R 随机') }}</div>
    <Loading :show="ss.loading.show" title="正在营建" :stage="ss.loading.stage" />
  </main>
</template>
