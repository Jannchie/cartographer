<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import Loading from '../kit/Loading.vue'
import Probe from '../kit/Probe.vue'
import { mountWorld, setMode, toggleTour, ws, type Mode } from './world'

const stage = ref<HTMLElement>()
const v3 = ref<HTMLElement>()
const v2 = ref<HTMLElement>()
const ve = ref<HTMLElement>()
onMounted(() => mountWorld({ stage: stage.value!, v3: v3.value!, v2: v2.value!, ve: ve.value! }))

const MODES: { id: Mode; label: string }[] = [
  { id: '3d', label: '3D 沙盘' },
  { id: '2d', label: '纸图' },
  { id: 'edit', label: '编辑' },
]
const hint = computed(() =>
  ws.mode === '3d'
    ? ws.touring
      ? '自动运镜中 · → 下一个镜头 · 拖动或 Esc 交还手动'
      : '拖动旋转 · 右键平移 · 滚轮缩放 · T 巡览 · R 随机 · P 性能'
    : ws.mode === '2d'
      ? '拖动平移 · 滚轮缩放 · 双击复位 · R 随机'
      : '左键绘制 / 选取 · 右键或 Shift 拖动平移 · 滚轮缩放 · Alt+滚轮 画笔大小 · Ctrl+Z 撤销',
)
</script>

<template>
  <main ref="stage" class="stage">
    <div ref="v3" class="view" :class="{ hidden: ws.mode !== '3d' }"></div>
    <div ref="v2" class="view paper-view" :class="{ hidden: ws.mode !== '2d' }"></div>
    <div ref="ve" class="view edit-view" :class="{ hidden: ws.mode !== 'edit' }"></div>
    <div class="neatline" aria-hidden="true"></div>
    <nav class="tabs" role="tablist">
      <button v-for="m in MODES" :key="m.id" type="button" role="tab" :aria-selected="ws.mode === m.id" :class="{ on: ws.mode === m.id }" @click="setMode(m.id)">
        {{ t(m.label) }}
      </button>
    </nav>
    <Transition name="fade">
      <div v-if="ws.editStatus" class="status">{{ ws.editStatus }}</div>
    </Transition>
    <button v-if="ws.mode === '3d' && !ws.loading.show" type="button" class="tour" :class="{ on: ws.touring }" :title="t('自动运镜俯瞰浏览（T）')" @click="toggleTour">
      <i aria-hidden="true"></i>{{ t(ws.touring ? '停止巡览' : '巡览') }}
    </button>
    <!-- 纸图的悬停读数画在图廓里（见 world.ts 的 probeCard） -->
    <Probe :data="ws.mode === '2d' ? null : ws.probe" />
    <div class="hint">{{ t(hint) }}</div>
    <Loading :show="ws.loading.show" title="正在塑造世界" :stage="ws.loading.stage" :frac="ws.loading.frac" />
  </main>
</template>
