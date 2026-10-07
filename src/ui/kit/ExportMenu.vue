<script setup lang="ts">
import { IconDownload, type Icon as IconDef } from '@jannchie/icons'
import { onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import Icon from './Icon.vue'

/**
 * 导出：一枚图标按钮，点开向上弹出格式菜单（放在面板底部生成按钮旁）。
 * 点菜单项导出并收起；点别处或按 Esc 收起。
 */
defineProps<{ items: { label: string; title?: string; icon?: IconDef<string>; run: () => void }[] }>()

const open = ref(false)
const root = ref<HTMLElement>()
function onDoc(e: PointerEvent) {
  if (!root.value?.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}
watch(open, (o) => {
  if (o) {
    document.addEventListener('pointerdown', onDoc, true)
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('pointerdown', onDoc, true)
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => (open.value = false))
function pick(run: () => void) {
  open.value = false
  run()
}
</script>

<template>
  <div ref="root" class="export-menu" :class="{ open }">
    <button type="button" class="export-btn" :title="t('导出')" :aria-label="t('导出')" aria-haspopup="menu" :aria-expanded="open" @click="open = !open">
      <Icon :icon="IconDownload" :size="18" />
    </button>
    <Transition name="pop">
      <div v-if="open" class="export-list" role="menu">
        <button v-for="it in items" :key="it.label" type="button" role="menuitem" :title="it.title ? t(it.title) : undefined" @click="pick(it.run)">
          <Icon v-if="it.icon" :icon="it.icon" :size="14" />{{ t(it.label) }}
        </button>
      </div>
    </Transition>
  </div>
</template>
