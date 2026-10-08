<script setup lang="ts">
import { IconDiorama, IconEdit, IconHologram, IconMap, IconRegion, type Icon as IconDef } from '@jannchie/icons'
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import Icon from '../kit/Icon.vue'
import Loading from '../kit/Loading.vue'
import Probe from '../kit/Probe.vue'
import RegionOverlay from '../kit/RegionOverlay.vue'
import { isFeatureArea, isWaterArea, type Area } from '../../gen/areas'
import { placeName } from '../../i18n'
import { langRef } from '../i18n'
import { areaCheckpoint, commitAreas, mountWorld, selectArea, setMode, toggleTour, ws, type Mode } from './world'

const stage = ref<HTMLElement>()
const v3 = ref<HTMLElement>()
const vh = ref<HTMLElement>()
const v2 = ref<HTMLElement>()
const ve = ref<HTMLElement>()
onMounted(() => mountWorld({ stage: stage.value!, v3: v3.value!, vh: vh.value!, v2: v2.value!, ve: ve.value! }))

/** 区域叠加层要的名字、大小与是否水域 */
const areaInfo = (a: Area) => {
  void langRef.value
  return { label: placeName(a), size: a.cells, water: isWaterArea(a.kind) || a.kind === 'lake', feature: isFeatureArea(a.kind) }
}

const MODES: { id: Mode; label: string; icon: IconDef<string> }[] = [
  { id: '3d', label: '3D 沙盘', icon: IconDiorama },
  { id: 'holo', label: '全息', icon: IconHologram },
  { id: '2d', label: '纸图', icon: IconMap },
  { id: 'edit', label: '编辑', icon: IconEdit },
  { id: 'areas', label: '区域', icon: IconRegion },
]
const hint = computed(() =>
  ws.mode === '3d'
    ? ws.touring
      ? '自动运镜中 · → 下一个镜头 · 拖动或 Esc 交还手动'
      : '拖动旋转 · 右键平移 · 滚轮缩放 · WASD / 方向键移动 · Q E 转向 · PgUp PgDn 俯仰 · +/− 远近 · T 巡览 · R 随机 · P 性能'
    : ws.mode === 'holo'
      ? '拖动旋转 · 右键平移 · 滚轮缩放 · 点选陆块锁定目标 · R 随机'
      : ws.mode === '2d'
        ? '拖动平移 · 滚轮缩放 · 方向键平移 · +/− 缩放 · 双击或 0 复位 · R 随机'
        : ws.mode === 'areas'
          ? '点选区域 · 拖顶点改边界 · 拖边中点加顶点 · 双击顶点删除 · 拖名字挪注记 · Ctrl+Z 撤销'
          : ws.tool === 'lasso'
            ? '拖动圈出陆地 · 按住 Alt 圈出海洋 · 右键或 Shift 拖动平移 · Ctrl+Z 撤销'
            : ws.tool === 'ridge'
              ? '拖动画山脉脊线 · 点选山脉后拖动整条或拖顶点 · Delete 删除 · 右键或 Shift 拖动平移 · Ctrl+Z 撤销'
              : '左键绘制 / 选取 · 右键或 Shift 拖动平移 · 滚轮缩放 · Alt+滚轮 画笔大小 · Ctrl+Z 撤销',
)
</script>

<template>
  <main ref="stage" class="stage">
    <div ref="v3" class="view" :class="{ hidden: ws.mode !== '3d' }"></div>
    <div ref="vh" class="view holo-view" :class="{ hidden: ws.mode !== 'holo' }"></div>
    <div v-if="ws.no3d && (ws.mode === '3d' || ws.mode === 'holo')" class="no3d">
      <Icon :icon="IconDiorama" :size="32" weight="light" />
      <h3>{{ t('3D 沙盘不可用') }}</h3>
      <p>{{ t('浏览器没能创建 WebGL，多半是显卡加速被停用了。完全退出浏览器再重新打开通常就能恢复；在 Chrome 里可以打开 chrome://gpu 查看状态。纸图与编辑不受影响。') }}</p>
    </div>
    <div ref="v2" class="view paper-view" :class="{ hidden: ws.mode !== '2d' && ws.mode !== 'areas' }">
      <RegionOverlay
        v-if="ws.mode === 'areas'"
        :regions="ws.areas"
        :info="areaInfo"
        :selected="ws.areaSel"
        :view="ws.paper"
        @select="selectArea"
        @checkpoint="areaCheckpoint"
        @commit="commitAreas"
      />
    </div>
    <div ref="ve" class="view edit-view" :class="{ hidden: ws.mode !== 'edit' }"></div>
    <div class="neatline" aria-hidden="true"></div>
    <nav class="tabs" role="tablist">
      <button v-for="m in MODES" :key="m.id" type="button" role="tab" :aria-selected="ws.mode === m.id" :class="{ on: ws.mode === m.id }" @click="setMode(m.id)">
        <Icon :icon="m.icon" :size="16" />{{ t(m.label) }}
      </button>
    </nav>
    <Transition name="fade">
      <div v-if="ws.editStatus" class="status">{{ ws.editStatus }}</div>
    </Transition>
    <button v-if="ws.mode === '3d' && !ws.no3d && !ws.loading.show" type="button" class="tour" :class="{ on: ws.touring }" :title="t('自动运镜俯瞰浏览（T）')" @click="toggleTour">
      <i aria-hidden="true"></i>{{ t(ws.touring ? '停止巡览' : '巡览') }}
    </button>
    <!-- 纸图的悬停读数画在图廓里（见 world.ts 的 probeCard） -->
    <Probe :data="ws.mode === '2d' || ws.mode === 'areas' ? null : ws.probe" />
    <div class="hint">{{ t(hint) }}</div>
    <Loading :show="ws.loading.show" title="正在塑造世界" :stage="ws.loading.stage" :frac="ws.loading.frac" />
  </main>
</template>
