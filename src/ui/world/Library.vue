<script setup lang="ts">
import { IconDownload, IconFolderOpen, IconSave, IconTrash, IconX } from '@jannchie/icons'
import { nextTick, ref } from 'vue'
import { lang } from '../../i18n'
import { t } from '../i18n'
import Icon from '../kit/Icon.vue'
import * as W from './world'
import { ws } from './world'

/** 世界库：保存过的世界（整个世界的数据），打开、改名、导出、删除；也从这里导入文件 */
const emit = defineEmits<{ import: [] }>()
const editing = ref<string | null>(null)
const draft = ref('')
const input = ref<HTMLInputElement[]>()

const fmtTime = (ms: number) => new Date(ms).toLocaleString(lang === 'zh' ? 'zh-CN' : lang, { dateStyle: 'medium', timeStyle: 'short' })

function startRename(id: string, name: string) {
  editing.value = id
  draft.value = name
  nextTick(() => input.value?.[0]?.select())
}
async function finishRename(apply: boolean) {
  const id = editing.value
  editing.value = null
  if (apply && id) await W.renameEntry(id, draft.value)
}
</script>

<template>
  <div v-if="ws.library.open" class="library" @pointerdown.self="W.openLibrary(false)" @keydown.esc="W.openLibrary(false)">
    <section class="library-sheet" role="dialog" :aria-label="t('世界库')">
      <header class="library-head">
        <h2>{{ t('世界库') }}</h2>
        <div class="library-actions">
          <button type="button" class="link" :disabled="ws.busy" :title="t('保存到世界库：地形定稿成数据，之后与种子无关')" @click="W.saveWorld()"><Icon :icon="IconSave" :size="14" />{{ t('保存') }}</button>
          <button v-if="ws.entry" type="button" class="link" :disabled="ws.busy" @click="W.saveWorld(true)"><Icon :icon="IconSave" :size="14" />{{ t('另存为新世界') }}</button>
          <button type="button" class="link" @click="emit('import')"><Icon :icon="IconFolderOpen" :size="14" />{{ t('导入文件…') }}</button>
          <button type="button" class="library-close" :title="t('关闭')" @click="W.openLibrary(false)"><Icon :icon="IconX" :size="16" /></button>
        </div>
      </header>
      <p v-if="!ws.library.items.length" class="library-empty">{{ t('还没有保存的世界。生成满意后点「保存」，世界会连同全部数据存进这里。') }}</p>
      <ul v-else class="library-grid">
        <li v-for="m in ws.library.items" :key="m.id" class="library-card" :class="{ current: ws.entry?.id === m.id }">
          <button type="button" class="library-thumb" @click="W.openEntry(m.id)">
            <img v-if="m.thumb" :src="m.thumb" alt="" />
            <span v-if="ws.entry?.id === m.id" class="library-badge">{{ t('当前') }}</span>
          </button>
          <div class="library-meta">
            <input
              v-if="editing === m.id"
              ref="input"
              v-model="draft"
              spellcheck="false"
              @keydown.enter.prevent="finishRename(true)"
              @keydown.esc.stop.prevent="finishRename(false)"
              @blur="finishRename(true)"
            />
            <strong v-else :title="t('双击改名')" @dblclick="startRename(m.id, m.name)">{{ m.name }}</strong>
            <small>{{ fmtTime(m.savedAt) }} · {{ m.W }}×{{ m.H }} · {{ m.seed }}</small>
          </div>
          <div class="library-card-actions">
            <button type="button" class="link" @click="W.openEntry(m.id)">{{ t('打开') }}</button>
            <button type="button" class="link" @click="W.exportEntry(m.id)"><Icon :icon="IconDownload" :size="13" />{{ t('导出') }}</button>
            <button type="button" class="link danger-link" @click="W.deleteEntry(m.id)"><Icon :icon="IconTrash" :size="13" />{{ t('删除') }}</button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
