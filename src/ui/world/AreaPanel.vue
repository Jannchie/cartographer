<script setup lang="ts">
import { IconLocate, IconTrash } from '@jannchie/icons'
import { computed } from 'vue'
import type { AreaKind } from '../../gen/areas'
import { placeName } from '../../i18n'
import { langRef, t } from '../i18n'
import Dropdown from '../kit/Dropdown.vue'
import Field from '../kit/Field.vue'
import Icon from '../kit/Icon.vue'
import * as W from './world'
import { ws } from './world'

/**
 * 区域视图的侧栏：新建、选中区域的名字与类型、按类型分组的清单（点一下选中并把地图移过去）。
 * 边界在地图上直接拖（见 kit/RegionOverlay.vue）。
 */
const KINDS: { value: AreaKind; label: string }[] = [
  { value: 'continent', label: '大陆' },
  { value: 'island', label: '岛屿' },
  { value: 'ocean', label: '大洋' },
  { value: 'sea', label: '海' },
  { value: 'bay', label: '湾' },
  { value: 'lake', label: '湖泊' },
  { value: 'range', label: '山脉' },
  { value: 'basin', label: '盆地' },
  { value: 'desert', label: '沙漠' },
  { value: 'forest', label: '森林' },
]
const kindLabel = (k: AreaKind) => KINDS.find((x) => x.value === k)!.label
const sel = computed(() => ws.areas.find((a) => a.id === ws.areaSel) ?? null)
const groups = computed(() => {
  void langRef.value
  return KINDS.map((k) => ({ ...k, items: ws.areas.filter((a) => a.kind === k.value).map((a) => ({ id: a.id, name: placeName(a) })) })).filter((g) => g.items.length)
})
const val = (e: Event) => (e.target as HTMLInputElement).value
function editName(key: 'name' | 'zh' | 'ja', v: string) {
  if (sel.value) sel.value[key] = v
}
function setKind(k: AreaKind) {
  if (!sel.value || sel.value.kind === k) return
  W.areaCheckpoint()
  sel.value.kind = k
  W.commitAreas()
}
function pick(id: string) {
  W.selectArea(id)
  W.focusArea(id)
}
</script>

<template>
  <div class="area-panel">
    <div class="area-actions">
      <Field label="新建">
        <Dropdown :options="KINDS" :model-value="null" placeholder="选择类型" @update:model-value="(k) => W.addArea(k)" />
      </Field>
      <button v-if="ws.areasEdited" type="button" class="link" :title="t('丢掉全部区域改动，回到自动推断的边界与名字')" @click="W.resetAreas()">{{ t('恢复自动推断') }}</button>
    </div>

    <div v-if="sel" class="inspector">
      <h3>{{ t(kindLabel(sel.kind)) }}</h3>
      <Field label="原名"><input :value="sel.name" spellcheck="false" @focus="W.areaCheckpoint()" @input="editName('name', val($event))" @change="W.commitAreas()" /></Field>
      <Field label="中文名"><input :value="sel.zh" spellcheck="false" @focus="W.areaCheckpoint()" @input="editName('zh', val($event))" @change="W.commitAreas()" /></Field>
      <Field label="日文名"><input :value="sel.ja ?? ''" spellcheck="false" @focus="W.areaCheckpoint()" @input="editName('ja', val($event))" @change="W.commitAreas()" /></Field>
      <Field label="类型">
        <Dropdown :options="KINDS" :model-value="sel.kind" @update:model-value="setKind" />
      </Field>
      <div class="pair">
        <button type="button" @click="W.focusArea(sel.id)"><Icon :icon="IconLocate" :size="14" />{{ t('定位') }}</button>
        <button type="button" @click="W.deleteArea(sel.id)"><Icon :icon="IconTrash" :size="14" />{{ t('删除区域') }}</button>
      </div>
    </div>
    <p v-else class="counter-note">{{ t('在地图上点一个区域，或从下面的清单里选') }}</p>

    <div v-for="g in groups" :key="g.value" class="area-group">
      <h3>{{ t(g.label) }} <small>{{ g.items.length }}</small></h3>
      <div class="area-list">
        <button v-for="a in g.items" :key="a.id" type="button" :class="{ on: a.id === ws.areaSel }" @click="pick(a.id)">{{ a.name }}</button>
      </div>
    </div>
  </div>
</template>
