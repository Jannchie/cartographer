<script setup lang="ts">
import { IconLock, IconRefresh, IconX } from '@jannchie/icons'
import { computed } from 'vue'
import { t, tl } from './i18n'
import Icon from './kit/Icon.vue'
import Sheet from './kit/Sheet.vue'
import { applyPlugins, openPlugins, pluginRows, plugins, pluginsDirty, togglePlugin } from './plugins'

/**
 * 插件面板：列出随应用提供的插件，逐个启停。开关只改面板里的选择，点「应用并重新载入」才存下并生效。
 * 不可停用的插件锁定；依赖没有启用的插件注明缺哪个
 */
const rows = computed(pluginRows)
const dirty = computed(pluginsDirty)
</script>

<template>
  <Sheet :open="plugins.open" label="插件" class="plugins" @close="openPlugins(false)">
    <header class="modal-head">
      <h2>{{ t('插件') }}</h2>
      <div class="modal-actions">
        <button type="button" class="modal-close" :title="t('关闭')" @click="openPlugins(false)"><Icon :icon="IconX" :size="16" /></button>
      </div>
    </header>
    <p class="plugins-note">{{ t('启用或停用随应用提供的内容。改动在重新载入页面后生效；已经生成的世界不受影响。') }}</p>
    <ul class="plugins-list">
      <li v-for="r in rows" :key="r.id" class="plugin-row" :class="{ off: !r.on }" :data-plugin="r.id">
        <div class="plugin-text">
          <strong>{{ tl(r.name) }}</strong>
          <span>{{ tl(r.desc) }}</span>
          <small v-if="r.on && r.missing.length" class="plugin-warn">{{ t('依赖的「{names}」没有启用，应用后它也不会启用', { names: r.missing.map(tl).join('、') }) }}</small>
        </div>
        <span v-if="r.required" class="plugin-locked" :title="t('不可停用：默认的选择用到它的内容')"><Icon :icon="IconLock" :size="13" />{{ t('不可停用') }}</span>
        <label v-else class="plugin-switch">
          <input type="checkbox" :checked="r.on" @change="togglePlugin(r.id, ($event.target as HTMLInputElement).checked)" />
          <span>{{ t(r.on ? '已启用' : '已停用') }}</span>
        </label>
      </li>
    </ul>
    <footer class="plugins-foot">
      <span v-if="!dirty">{{ t('没有待应用的改动') }}</span>
      <button type="button" class="primary plugins-apply" :disabled="!dirty" @click="applyPlugins()"><Icon :icon="IconRefresh" :size="14" />{{ t('应用并重新载入') }}</button>
    </footer>
  </Sheet>
</template>
