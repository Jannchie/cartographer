<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { lang } from '../../i18n'
import type { SettleRegion } from '../../settlement/regions'
import { langRef, t } from '../i18n'
import Loading from '../kit/Loading.vue'
import RegionOverlay from '../kit/RegionOverlay.vue'
import SettlementTimeline from './SettlementTimeline.vue'
import { commitRegions, mountSettlement, regionCheckpoint, selectRegion, setMode, ss } from './settlement'

const host = ref<HTMLElement>()
onMounted(() => mountSettlement(host.value!))

const MODES = [
  { id: 'map', label: '地图' },
  { id: 'areas', label: '区域' },
] as const
/** 区域叠加层要的名字与大小 */
const regionInfo = (r: SettleRegion) => {
  void langRef.value
  return { label: r.name[lang], size: r.size }
}
const hint = computed(() =>
  ss.mode === 'areas' ? '点选区域 · 拖顶点改边界 · 拖边中点加顶点 · 双击顶点删除 · 拖名字挪注记 · Ctrl+Z 撤销' : '拖动平移 · 滚轮缩放 · 方向键平移 · +/− 缩放 · 双击或 0 复位 · R 随机',
)
</script>

<template>
  <main class="stage">
    <div ref="host" class="view paper-view">
      <RegionOverlay
        v-if="ss.mode === 'areas'"
        :regions="ss.regions"
        :info="regionInfo"
        :selected="ss.regionSel"
        :view="ss.paper"
        @select="selectRegion"
        @checkpoint="regionCheckpoint"
        @commit="commitRegions()"
      />
    </div>
    <div class="neatline" aria-hidden="true"></div>
    <nav class="tabs" role="tablist">
      <button v-for="m in MODES" :key="m.id" type="button" role="tab" :aria-selected="ss.mode === m.id" :class="{ on: ss.mode === m.id }" @click="setMode(m.id)">
        {{ t(m.label) }}
      </button>
    </nav>
    <SettlementTimeline />
    <div class="hint">{{ t(hint) }}</div>
    <Loading :show="ss.loading.show" title="正在营建" :stage="ss.loading.stage" />
  </main>
</template>
