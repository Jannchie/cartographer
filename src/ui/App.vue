<script setup lang="ts">
import { ref, watchEffect } from 'vue'
import { app } from './app'
import { langRef, t } from './i18n'
import Home from './Home.vue'
import LangSelect from './LangSelect.vue'
import SettlementPanel from './settlement/SettlementPanel.vue'
import SettlementStage from './settlement/SettlementStage.vue'
import * as S from './settlement/settlement'
import WorldPanel from './world/WorldPanel.vue'
import WorldStage from './world/WorldStage.vue'
import * as W from './world/world'
import { ws } from './world/world'

const file = ref<HTMLInputElement>()
function openFile() {
  app.module = 'world'
  file.value!.click()
}
function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) W.openProject(f)
}
watchEffect(() => {
  document.documentElement.lang = langRef.value === 'zh' ? 'zh-CN' : langRef.value
  document.title = t('Cartographer · 世界地图生成器')
  document.body.dataset.module = app.module
})
</script>

<template>
  <Home v-show="app.module === 'home'" @open="openFile" />
  <div v-show="app.module !== 'home'" class="app">
    <aside class="panel">
      <header class="masthead">
        <div class="masthead-top">
          <button type="button" class="wordmark" :title="t('回到首页')" @click="app.module = 'home'">Cartographer</button>
          <div class="file">
            <button v-show="app.module === 'world'" type="button" class="link" :title="t('打开项目文件')" @click="openFile">{{ t('打开') }}</button>
            <button v-show="app.module === 'world'" type="button" class="link" :title="t('保存种子、参数与全部编辑')" @click="W.saveProject()">{{ t('保存') }}</button>
          </div>
        </div>
        <nav class="modules">
          <button type="button" :class="{ on: app.module === 'world' }" @click="app.module = 'world'"><span class="no">I</span>{{ t('世界地图') }}</button>
          <button type="button" :class="{ on: app.module === 'settlement' }" @click="app.module = 'settlement'"><span class="no">II</span>{{ t('聚落地图') }}</button>
          <LangSelect />
        </nav>
      </header>
      <div class="panel-scroll">
        <WorldPanel v-show="app.module === 'world'" />
        <SettlementPanel v-show="app.module === 'settlement'" />
      </div>
      <footer class="panel-foot">
        <template v-if="app.module === 'world'">
          <button type="button" class="export" :title="t('导出当前视图的图片')" @click="W.exportPng()">{{ t('导出 PNG') }}</button>
          <button v-if="ws.mode === '2d'" type="button" class="export" :title="t('纸图的矢量版本，可无损放大')" @click="W.exportSvg()">{{ t('导出 SVG') }}</button>
        </template>
        <template v-else>
          <button type="button" class="export" :title="t('按 2 倍分辨率导出')" @click="S.exportPng()">{{ t('导出 PNG') }}</button>
          <button type="button" class="export" :title="t('矢量版本，可无损放大')" @click="S.exportSvg()">{{ t('导出 SVG') }}</button>
        </template>
      </footer>
    </aside>
    <WorldStage v-show="app.module === 'world'" />
    <SettlementStage v-show="app.module === 'settlement'" />
  </div>
  <input ref="file" type="file" accept=".json,application/json" hidden @change="onFile" />
</template>
