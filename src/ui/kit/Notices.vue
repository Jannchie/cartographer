<script lang="ts">
import { defineStrings } from '../../i18n'

// 提示只有两种说法：来自链接的，与本机上次选用的；{what} 是那类内容的名称（扩展点的 label）
const TEXT = {
  link: '链接里的{what}「{id}」没有启用（它所属的插件已停用，或不在这个版本里），已改用默认的{what}。',
  stored: '上次选用的{what}「{id}」没有启用（它所属的插件已停用，或不在这个版本里），已改用默认的{what}。',
}
defineStrings([
  [TEXT.link, 'The {what} "{id}" in this link is not enabled (its plugin is disabled or not part of this version); the default {what} is used instead.', 'リンクにある{what}「{id}」は有効になっていません（プラグインが無効、またはこのバージョンに含まれていません）。既定の{what}を使います。'],
  [TEXT.stored, 'The {what} "{id}" you used last time is not enabled (its plugin is disabled or not part of this version); the default {what} is used instead.', '前回選んだ{what}「{id}」は有効になっていません（プラグインが無効、またはこのバージョンに含まれていません）。既定の{what}を使います。'],
  ['点击关闭', 'Click to dismiss', 'クリックで閉じる'],
])
</script>

<script setup lang="ts">
import type { Notice } from '../app'
import { t, tl } from '../i18n'

/** 舞台上的提示（地址、存下的选择引用了没有启用的内容，见 app.ts 的 resolveRefs）：一条一行，点一下全部收起 */
defineProps<{ modelValue: Notice[] }>()
const emit = defineEmits<{ 'update:modelValue': [v: Notice[]] }>()
</script>

<template>
  <button v-if="modelValue.length" type="button" class="notice" :title="t('点击关闭')" @click="emit('update:modelValue', [])">
    <span v-for="n in modelValue" :key="n.source + n.what.zh + n.id">{{ t(TEXT[n.source], { what: tl(n.what), id: n.id }) }}</span>
  </button>
</template>
