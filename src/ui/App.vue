<script setup lang="ts">
import { IconCastle, IconChartBar, IconDatabase, IconDiorama, IconFlag, IconImage, IconLeaf, IconLibrary, IconMountain, IconPalette, IconRegion, IconSave, IconShapes, IconSliders } from '@jannchie/icons'
import { computed, ref, watchEffect } from 'vue'
import { app, storeGet, storeSet } from './app'
import { langRef, t } from './i18n'
import ExportMenu from './kit/ExportMenu.vue'
import Icon from './kit/Icon.vue'
import PanelTabs from './kit/PanelTabs.vue'
import Home from './Home.vue'
import LangSelect from './LangSelect.vue'
import SettlementPanel from './settlement/SettlementPanel.vue'
import SettlementStage from './settlement/SettlementStage.vue'
import * as S from './settlement/settlement'
import WorldPanel from './world/WorldPanel.vue'
import WorldStage from './world/WorldStage.vue'
import Library from './world/Library.vue'
import * as W from './world/world'
import { ws } from './world/world'
import { narrow, useSheet } from './sheet'

// 导出格式：纸图才有矢量版本
const worldExports = computed(() => [
  { label: 'PNG', title: '导出当前视图的图片', icon: IconImage, run: W.exportPng },
  ...(ws.mode === '2d' || ws.mode === 'areas' ? [{ label: 'SVG', title: '纸图的矢量版本，可无损放大', icon: IconShapes, run: W.exportSvg }] : []),
  { label: '世界文件', title: '整个世界的数据（.json），导入后直接显示，与种子无关', icon: IconDatabase, run: W.exportWorldFile },
])
const settleExports = computed(() =>
  S.ss.mode === 'sandbox'
    ? [{ label: 'PNG', title: '导出当前视图的图片', icon: IconImage, run: S.exportPng }]
    : [
        { label: 'PNG', title: '按 2 倍分辨率导出', icon: IconImage, run: S.exportPng },
        { label: 'SVG', title: '矢量版本，可无损放大', icon: IconShapes, run: S.exportSvg },
      ],
)

// 侧边栏分页：按生成阶段（地形 → 自然 → 人文），外观页的内容随舞台模式
const worldTabs = [
  { id: 'terrain' as const, label: '地形', icon: IconMountain },
  { id: 'nature' as const, label: '自然', icon: IconLeaf, title: '气候、大洲与地理区域' },
  { id: 'human' as const, label: '人文', icon: IconFlag, title: '城镇、政区与交通' },
  { id: 'look' as const, label: '外观', icon: IconPalette, title: '当前视图的显示选项' },
  { id: 'stats' as const, label: '统计', icon: IconChartBar },
]
// 区域视图里多出一页"区域"；沙盘模式下绘图风格页换成沙盘选项
const settleTabs = computed(() => [
  { id: 'gen' as const, label: '生成', icon: IconSliders },
  { id: 'features' as const, label: '要素', icon: IconCastle },
  S.ss.mode === 'sandbox' ? { id: 'style' as const, label: '沙盘', icon: IconDiorama } : { id: 'style' as const, label: '绘图风格', icon: IconPalette },
  ...(S.ss.mode === 'areas' ? [{ id: 'areas' as const, label: '区域', icon: IconRegion }] : []),
  { id: 'stats' as const, label: '统计', icon: IconChartBar },
])

const file = ref<HTMLInputElement>()
function openFile() {
  app.module = 'world'
  file.value!.click()
}
function openLibrary() {
  app.module = 'world'
  W.openLibrary()
}
function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) W.openProject(f)
}
// 侧边栏宽度：拖右缘调节，双击恢复默认；记住上次的宽度
const PANEL_W = 320
// 存的是想要的宽度，显示时才按窗口宽度夹住：窗口一时变窄（转屏、窄屏打开）不会把它永久压小
const vw = ref(window.innerWidth)
window.addEventListener('resize', () => (vw.value = window.innerWidth))
const clampW = (w: number) => Math.round(Math.min(Math.max(280, w), Math.max(280, Math.min(640, vw.value * 0.5))))
const panelW = ref(Number(storeGet('panelWidth')) || PANEL_W)
const shownW = computed(() => clampW(panelW.value))
const resizing = ref(false)
function onResizeDown(e: PointerEvent) {
  if (e.button !== 0) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  resizing.value = true
}
function onResizeMove(e: PointerEvent) {
  if (resizing.value) panelW.value = clampW(e.clientX)
}
function endResize() {
  if (!resizing.value) return
  resizing.value = false
  commitWidth()
}
function resetWidth() {
  panelW.value = PANEL_W
  commitWidth()
}
/** 松手后记下宽度，并让舞台按新尺寸重新适配（与窗口缩放同一套处理） */
function commitWidth() {
  storeSet('panelWidth', String(panelW.value))
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
}

// 窄屏：侧边栏成了底部抽屉（见 sheet.ts）
const panel = ref<HTMLElement>()
const sheet = useSheet(panel)
const appStyle = computed(() =>
  narrow.value ? { '--sheet-h': `${sheet.live.value}px`, '--stage-b': `${sheet.stage.value}px` } : { '--panel-w': `${shownW.value}px` },
)
function pickWorldTab(tab: W.WorldTab) {
  W.setTab(tab)
  if (narrow.value) sheet.reveal()
}
function pickSettleTab(tab: S.SettleTab) {
  S.setTab(tab)
  if (narrow.value) sheet.reveal()
}
watchEffect(() => {
  document.documentElement.lang = langRef.value === 'zh' ? 'zh-CN' : langRef.value
  document.title = t('Cartographer · 世界地图生成器')
  document.body.dataset.module = app.module
})
</script>

<template>
  <Home v-show="app.module === 'home'" @open="openLibrary" />
  <Library @import="openFile" />
  <div v-show="app.module !== 'home'" class="app" :class="{ resizing, [`sheet-${sheet.snap.value}`]: narrow, 'sheet-drag': sheet.dragging.value }" :style="appStyle">
    <aside ref="panel" class="panel">
      <!-- 窄屏抽屉的把手：拖动换档，轻点开合 -->
      <div
        class="sheet-grip"
        role="button"
        :aria-label="t(sheet.snap.value === 'peek' ? '展开面板' : '收起面板')"
        :aria-expanded="sheet.snap.value !== 'peek'"
        @pointerdown="sheet.onDown"
        @pointermove="sheet.onMove"
        @pointerup="sheet.onUp"
        @pointercancel="sheet.onUp"
        @lostpointercapture="sheet.onUp"
      >
        <i aria-hidden="true"></i>
      </div>
      <header class="masthead">
        <div class="masthead-top">
          <button type="button" class="wordmark" :title="t('回到首页')" @click="app.module = 'home'">Cartographer</button>
          <div class="file">
            <button v-show="app.module === 'world'" type="button" class="link" :title="t('保存的世界、导入与导出')" @click="W.openLibrary()"><Icon :icon="IconLibrary" :size="14" />{{ t('世界库') }}</button>
            <button v-show="app.module === 'world'" type="button" class="link" :disabled="ws.busy" :title="t('保存到世界库：存下整个世界的数据，打开时直接显示')" @click="W.saveWorld()"><Icon :icon="IconSave" :size="14" />{{ t('保存') }}</button>
            <LangSelect />
          </div>
        </div>
        <PanelTabs v-if="app.module === 'world'" :tabs="worldTabs" :model-value="ws.tab" @update:model-value="pickWorldTab" />
        <PanelTabs v-else :tabs="settleTabs" :model-value="S.ss.tab" @update:model-value="pickSettleTab" />
      </header>
      <div class="panel-scroll">
        <WorldPanel v-show="app.module === 'world'" />
        <SettlementPanel v-show="app.module === 'settlement'" />
      </div>
      <!-- 生成常驻在底部：改完参数点它才重新生成；导出是旁边的图标按钮，点开选格式 -->
      <footer class="panel-foot">
        <template v-if="app.module === 'world'">
          <button type="button" class="primary" :class="{ dirty: ws.dirty }" :disabled="ws.busy" @click="W.generate()">
            {{ t(ws.dirty ? '按新参数生成' : '生成世界') }}
          </button>
          <ExportMenu :items="worldExports" />
        </template>
        <template v-else>
          <button type="button" class="primary" :class="{ dirty: S.dirty.value }" @click="S.run()">
            {{ t(S.dirty.value ? '按新参数生成' : '生成聚落') }}
          </button>
          <ExportMenu :items="settleExports" />
        </template>
      </footer>
      <div
        class="panel-resize"
        role="separator"
        aria-orientation="vertical"
        :title="t('拖动调节侧边栏宽度 · 双击恢复默认')"
        @pointerdown="onResizeDown"
        @pointermove="onResizeMove"
        @pointerup="endResize"
        @pointercancel="endResize"
        @lostpointercapture="endResize"
        @dblclick="resetWidth"
      ></div>
    </aside>
    <!-- 全屏抽屉盖住舞台时，点露出的那截地图收起抽屉 -->
    <div v-if="narrow && sheet.snap.value === 'full'" class="sheet-scrim" @click="sheet.setSnap('half')"></div>
    <WorldStage v-show="app.module === 'world'" />
    <SettlementStage v-show="app.module === 'settlement'" />
  </div>
  <input ref="file" type="file" accept=".json,application/json" hidden @change="onFile" />
</template>
