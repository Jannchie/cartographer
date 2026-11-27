<script setup lang="ts">
import { IconPlus, IconTrash } from '@jannchie/icons'
import { computed } from 'vue'
import { polylineLength } from '../../settlement/geom'
import { settleThemes } from '../../settlement/themes'
import { t } from '../i18n'
import Icon from '../kit/Icon.vue'
import Section from '../kit/Section.vue'
import Swatches from '../kit/Swatches.vue'
import * as G from './grow'
import { gs, picture, ROAD_NAME, USE_COLOR, USE_NAME } from './grow'

const swatches = settleThemes.all().map((th) => ({ id: th.id, name: th.name, desc: th.desc, paper: th.ground, ink: th.ink }))

const sel = computed(() => G.selected())
const roadLength = (pts: [number, number][]) => Math.round(polylineLength(pts))
const frontage = (roadId: number) => gs.state.lots.filter((l) => l.road === roadId && l.state !== 'vacant').length

/** 统计：各用途的地块（自动 / 手动）、各种路（只在「属性」页时算：每长一步都要数一遍地块） */
let lastStats: ReturnType<typeof countStats> | null = null
// 长的时候不数（每一步都换状态）：停下来再数
const stats = computed(() => (gs.run !== 'idle' && lastStats ? lastStats : (lastStats = countStats())))
function countStats() {
  const s = gs.state
  const uses = ['center', 'home', 'field', 'shop', 'yard', 'public'].map((u) => {
    const ls = s.lots.filter((l) => l.use === u && l.state !== 'vacant')
    return { use: u, grown: ls.filter((l) => l.ref !== undefined).length, hand: ls.filter((l) => l.ref === undefined).length }
  })
  const roads = G.ROAD_KINDS.map((k) => {
    const rs = s.roads.filter((r) => r.kind === k)
    return { kind: k, n: rs.length, hand: rs.filter((r) => !G.planned(r.id)).length, m: rs.reduce((a, r) => a + roadLength(r.pts), 0) }
  })
  return { uses, roads }
}
const terrainName = computed(() => {
  if (G.isBlank(gs.state.terrain)) return t('空白平地')
  return `${t('按种子生成')} · ${gs.state.seed}`
})
</script>

<template>
  <div class="panel-body">
    <Section v-show="gs.tab === 'info'">
      <div class="grow-read">
        <div><dt>{{ t('人口') }}</dt><dd>≈ {{ picture.population.toLocaleString() }}</dd></div>
        <div><dt>{{ t('住户') }}</dt><dd>{{ picture.households.toLocaleString() }}</dd></div>
      </div>

      <div v-if="sel" class="inspector">
        <template v-if="sel.kind === 'lot'">
          <dl class="grow-rows">
            <div v-for="[k, v] in G.lotRows(sel.lot)" :key="k"><dt>{{ t(k) }}</dt><dd>{{ v }}</dd></div>
          </dl>
          <button type="button" class="wide" :title="t('拆掉这块地（Delete）')" @click="G.removeSel()"><Icon :icon="IconTrash" :size="14" />{{ t('拆掉') }}</button>
        </template>
        <template v-else-if="sel.kind === 'road'">
          <dl class="grow-rows">
            <div><dt>{{ t('路') }}</dt><dd>{{ t(ROAD_NAME[sel.road.kind]) }}</dd></div>
            <div><dt>{{ t('来历') }}</dt><dd>{{ t(G.planned(sel.road.id) ? '自动' : '手动') }}</dd></div>
            <div><dt>{{ t('长度') }}</dt><dd>{{ roadLength(sel.road.pts) }} m</dd></div>
            <div><dt>{{ t('临街的地块') }}</dt><dd>{{ frontage(sel.road.id) }}</dd></div>
          </dl>
          <button v-if="!G.planned(sel.road.id)" type="button" class="wide" :title="t('连同临街的手动地块一起拆（Delete）')" @click="G.removeSel()"><Icon :icon="IconTrash" :size="14" />{{ t('拆掉这条路') }}</button>
        </template>
      </div>
      <p v-else class="counter-note">{{ t('点选地图上的地块、路查看详情。') }}</p>

      <div class="tool-group">
        <h3>{{ t('统计') }}</h3>
        <dl v-if="gs.tab === 'info'" class="grow-rows">
          <div v-for="u in stats.uses" :key="u.use">
            <dt><i class="sw" :style="{ background: USE_COLOR[u.use] }"></i>{{ t(USE_NAME[u.use]) }}</dt>
            <dd>{{ u.grown + u.hand }}<small v-if="u.hand"> ({{ u.hand }} {{ t('手动') }})</small></dd>
          </div>
          <div v-for="r in stats.roads" :key="r.kind">
            <dt>{{ t(ROAD_NAME[r.kind]) }}</dt>
            <dd>{{ r.n }}<small v-if="r.hand"> ({{ r.hand }} {{ t('手动') }})</small> · {{ r.m.toLocaleString() }} m</dd>
          </div>
        </dl>
      </div>
    </Section>

    <Section v-show="gs.tab === 'map'">
      <dl class="grow-rows">
        <div><dt>{{ t('地形') }}</dt><dd>{{ terrainName }}</dd></div>
        <div><dt>{{ t('地图大小') }}</dt><dd>{{ t(G.sizeName(gs.state.plan!.horizon)) }} · {{ t('约 {n} 人', { n: gs.state.plan!.horizon.toLocaleString() }) }}</dd></div>
      </dl>
      <button type="button" class="wide" :title="t('换一张地图从头来：当前这张清空（可撤销）')" @click="G.openNewMap()"><Icon :icon="IconPlus" :size="14" />{{ t('新建地图') }}</button>
      <div class="tool-group">
        <h3>{{ t('绘图风格') }}</h3>
        <Swatches :items="swatches" :model-value="gs.style" @update:model-value="G.setStyle" />
      </div>
    </Section>
  </div>
</template>

<style scoped>
.grow-read {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.grow-read dt,
.grow-rows dt {
  font-size: 11px;
  color: var(--ink-3);
}
.grow-read dd {
  margin: 2px 0 0;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.grow-rows {
  margin: 0;
}
.grow-rows > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--rule);
}
.grow-rows dt {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-2);
}
.grow-rows dd {
  margin: 0;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.grow-rows small {
  color: var(--ink-3);
}
.sw {
  display: inline-block;
  width: 9px;
  height: 9px;
}
.inspector .wide,
.grow-rows + .wide {
  margin-top: 10px;
}
.inspector {
  margin-bottom: 4px;
}
</style>
