<script setup lang="ts">
import { ref, watch } from 'vue'
import { storeGet, storeSet } from '../app'
import { t } from '../i18n'

/** 折叠栏：展开状态按 id 记住 */
const props = defineProps<{ label: string; id: string }>()
const open = ref(storeGet(props.id) === '1')
watch(open, (v) => storeSet(props.id, v ? '1' : '0'))
</script>

<template>
  <div class="fold" :class="{ open }">
    <button type="button" class="fold-head" :aria-expanded="open" @click="open = !open">
      <span>{{ t(label) }}</span><i></i>
    </button>
    <div class="fold-body">
      <div class="fold-inner"><slot /></div>
    </div>
  </div>
</template>
