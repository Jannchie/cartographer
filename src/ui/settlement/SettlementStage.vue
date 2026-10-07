<script setup lang="ts">
import { IconDiorama, IconMap, IconRegion, type Icon as IconDef } from '@jannchie/icons'
import { computed, onMounted, ref } from 'vue'
import { lang } from '../../i18n'
import type { SettleRegion } from '../../settlement/regions'
import { langRef, t } from '../i18n'
import Icon from '../kit/Icon.vue'
import Loading from '../kit/Loading.vue'
import Probe from '../kit/Probe.vue'
import RegionOverlay from '../kit/RegionOverlay.vue'
import SettlementTimeline from './SettlementTimeline.vue'
import { commitRegions, mountSettlement, regionCheckpoint, selectRegion, setMode, ss, type SettleMode } from './settlement'

const host = ref<HTMLElement>()
const town = ref<HTMLElement>()
onMounted(() => mountSettlement(host.value!, town.value!))

const MODES: { id: SettleMode; label: string; icon: IconDef<string> }[] = [
  { id: 'map', label: '地图', icon: IconMap },
  { id: 'areas', label: '区域', icon: IconRegion },
  { id: 'sandbox', label: '沙盘', icon: IconDiorama },
]
/** 区域叠加层要的名字与大小 */
const regionInfo = (r: SettleRegion) => {
  void langRef.value
  return { label: r.name[lang], size: r.size }
}
const hint = computed(() =>
  ss.mode === 'areas'
    ? '点选区域 · 拖顶点改边界 · 拖边中点加顶点 · 双击顶点删除 · 拖名字挪注记 · Ctrl+Z 撤销'
    : ss.mode === 'sandbox'
      ? '拖动旋转 · 右键平移 · 滚轮缩放 · WASD / 方向键移动 · Q E 转向 · PgUp PgDn 俯仰 · +/− 远近 · R 随机 · P 性能'
      : '拖动平移 · 滚轮缩放 · 方向键平移 · +/− 缩放 · 双击或 0 复位 · R 随机',
)
</script>

<template>
  <main class="stage">
    <div ref="host" class="view paper-view" :class="{ hidden: ss.mode === 'sandbox' }">
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
    <!-- 沙盘：第一次进入时才创建 WebGL（见 settlement.ts 的 showTown） -->
    <div ref="town" class="view" :class="{ hidden: ss.mode !== 'sandbox' }"></div>
    <div v-if="ss.no3d && ss.mode === 'sandbox'" class="no3d">
      <Icon :icon="IconDiorama" :size="32" weight="light" />
      <h3>{{ t('3D 沙盘不可用') }}</h3>
      <p>{{ t('浏览器没能创建 WebGL，多半是显卡加速被停用了。完全退出浏览器再重新打开通常就能恢复；在 Chrome 里可以打开 chrome://gpu 查看状态。地图与区域不受影响。') }}</p>
    </div>
    <div class="neatline" aria-hidden="true"></div>
    <nav class="tabs" role="tablist">
      <button v-for="m in MODES" :key="m.id" type="button" role="tab" :aria-selected="ss.mode === m.id" :class="{ on: ss.mode === m.id }" @click="setMode(m.id)">
        <Icon :icon="m.icon" :size="16" />{{ t(m.label) }}
      </button>
    </nav>
    <SettlementTimeline />
    <!-- 地图的悬停读数画在图廓里（见 settlement.ts 的 probeCard），沙盘用浮层 -->
    <Probe :data="ss.mode === 'sandbox' ? ss.probe : null" />
    <div class="hint">{{ t(hint) }}</div>
    <Loading :show="ss.loading.show" title="正在营建" :stage="ss.loading.stage" />
  </main>
</template>
