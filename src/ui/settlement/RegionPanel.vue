<script setup lang="ts">
import { computed } from 'vue'
import { lang } from '../../i18n'
import { langRef, t } from '../i18n'
import Field from '../kit/Field.vue'
import * as S from './settlement'
import { ss } from './settlement'

/**
 * 聚落区域视图的侧栏：新建、选中区域的三种写法、区域清单（点一下选中并把地图移过去）。
 * 边界在地图上直接拖（见 kit/RegionOverlay.vue）。改动只影响片区名的注记，不动房屋街巷
 */
const sel = computed(() => ss.regions.find((r) => r.id === ss.regionSel) ?? null)
const list = computed(() => {
  void langRef.value
  return ss.regions.map((r) => ({ id: r.id, name: r.name[lang] || r.name.zh || r.name.en }))
})
const val = (e: Event) => (e.target as HTMLInputElement).value
function editName(key: 'en' | 'zh' | 'ja', v: string) {
  if (sel.value) sel.value.name[key] = v
}
function pick(id: string) {
  S.selectRegion(id)
  S.focusRegion(id)
}
</script>

<template>
  <div class="area-panel">
    <div class="area-actions">
      <button type="button" class="wide" @click="S.addRegion()">{{ t('新建区域') }}</button>
      <button v-if="ss.regionsEdited" type="button" class="link" :title="t('丢掉这座城的区域改动，回到按片区划分的区域与名字')" @click="S.resetRegions()">{{ t('恢复默认区域') }}</button>
    </div>

    <div v-if="sel" class="inspector">
      <Field label="原名"><input :value="sel.name.en" spellcheck="false" @focus="S.regionCheckpoint()" @input="editName('en', val($event))" @change="S.commitRegions()" /></Field>
      <Field label="中文名"><input :value="sel.name.zh" spellcheck="false" @focus="S.regionCheckpoint()" @input="editName('zh', val($event))" @change="S.commitRegions()" /></Field>
      <Field label="日文名"><input :value="sel.name.ja" spellcheck="false" @focus="S.regionCheckpoint()" @input="editName('ja', val($event))" @change="S.commitRegions()" /></Field>
      <div class="pair">
        <button type="button" @click="S.focusRegion(sel.id)">{{ t('定位') }}</button>
        <button type="button" @click="S.deleteRegion(sel.id)">{{ t('删除区域') }}</button>
      </div>
    </div>
    <p v-else class="counter-note">{{ t('在地图上点一个区域，或从下面的清单里选') }}</p>

    <div class="area-group">
      <h3>{{ t('区域') }} <small>{{ list.length }}</small></h3>
      <div class="area-list">
        <button v-for="r in list" :key="r.id" type="button" :class="{ on: r.id === ss.regionSel }" @click="pick(r.id)">{{ r.name }}</button>
      </div>
    </div>
  </div>
</template>
