<script setup lang="ts">
import { t } from '../i18n'

/** 悬停探针：标题 + 带点线引导的读数表 */
defineProps<{ data: { title: string; rows: [string, string][] } | null }>()
</script>

<template>
  <Transition name="probe">
    <div v-if="data" class="probe">
      <div class="probe-title">{{ t(data.title) }}</div>
      <div v-for="[k, v] in data.rows" :key="k" class="probe-row">
        <span>{{ t(k) }}</span><i></i><b>{{ v }}</b>
      </div>
    </div>
  </Transition>
</template>
