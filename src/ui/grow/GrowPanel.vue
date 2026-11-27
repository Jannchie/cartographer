<script setup lang="ts">
import { IconCheck, IconDices, IconPause, IconPlay, IconSkipForward, IconSquare, IconTrash } from '@jannchie/icons'
import { computed } from 'vue'
import { cultures } from '../../settlement/culture'
import type { GrowRoadKind } from '../../settlement/grow'
import { settleThemes } from '../../settlement/themes'
import { t } from '../i18n'
import Field from '../kit/Field.vue'
import Icon from '../kit/Icon.vue'
import Legend from '../kit/Legend.vue'
import Scale from '../kit/Scale.vue'
import Section from '../kit/Section.vue'
import Seg from '../kit/Seg.vue'
import Swatches from '../kit/Swatches.vue'
import * as G from './grow'
import { gs, picture, ROAD_NAME, USE_COLOR, USE_NAME } from './grow'

const p = gs.setup
const CULTURE_OPTS = cultures.ids().map((c) => ({ value: c, label: cultures.get(c).name, title: cultures.get(c).desc }))
const START_OPTS = [
  { value: 'village' as const, label: '生成的村子', title: '一两条对外的路和一处村心，接着长或者接着改' },
  { value: 'blank' as const, label: '空地', title: '只有地形，没有路也没有地块：从零开始自己建' },
]
const SIZE_OPTS = G.SIZES.map((v) => ({ value: v, label: `${(v / 1000).toFixed(1)} km` }))
const envKeys = ['river', 'coast', 'hills'] as const
const envToggles = computed(() => [
  { label: '河流', on: p.river, title: '一条河穿过画幅' },
  { label: '临海', on: p.coast, title: '画幅一侧是海' },
  { label: '依山', on: p.hills, title: '画幅一侧是山' },
])
const swatches = settleThemes.all().map((th) => ({ id: th.id, name: th.name, desc: th.desc, paper: th.ground, ink: th.ink }))
const speeds = computed(() => [2, 8, 30].map((v) => ({ value: v, label: t('{n} 步/秒', { n: v }) })))

const sel = computed(() => {
  void gs.state
  void gs.sel
  return G.selected()
})
const roadLength = (pts: [number, number][]) => Math.round(pts.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0))
const frontage = (roadId: number) => gs.state.lots.filter((l) => l.road === roadId && l.state !== 'vacant').length

/** 统计：各用途的地块（盖好 / 在建）、各种路、分区 */
const stats = computed(() => {
  const s = gs.state
  const uses = ['center', 'home', 'field', 'shop', 'yard', 'public'].map((u) => {
    const ls = s.lots.filter((l) => l.use === u)
    return { use: u, built: ls.filter((l) => l.state === 'built').length, building: ls.filter((l) => l.state === 'building').length }
  })
  const vacant = s.lots.filter((l) => l.state === 'vacant').length
  const roads = (['highway', 'street', 'lane'] as GrowRoadKind[]).map((k) => {
    const rs = s.roads.filter((r) => r.kind === k)
    return { kind: k, n: rs.length, m: rs.reduce((a, r) => a + roadLength(r.pts), 0) }
  })
  return { uses, vacant, roads, zones: s.zones.length, strokes: s.strokes?.length ?? 0 }
})
</script>

<template>
  <div class="panel-body">
    <Section v-show="gs.tab === 'grow'">
      <div class="grow-read">
        <div><dt>{{ t('人口') }}</dt><dd>≈ {{ picture.population.toLocaleString() }}</dd></div>
        <div><dt>{{ t('住户') }}</dt><dd>{{ picture.households.toLocaleString() }}</dd></div>
        <div><dt>{{ t('步数') }}</dt><dd>{{ gs.driver.tick.toLocaleString() }}</dd></div>
      </div>

      <div v-if="sel" class="inspector">
        <template v-if="sel.kind === 'lot'">
          <dl class="grow-rows">
            <div v-for="[k, v] in G.lotRows(sel.lot)" :key="k"><dt>{{ t(k) }}</dt><dd>{{ v }}</dd></div>
          </dl>
          <div class="pair">
            <button type="button" :disabled="sel.lot.state !== 'building'" @click="G.buildSel()"><Icon :icon="IconCheck" :size="14" />{{ t('马上盖好') }}</button>
            <button type="button" :title="t('拆掉这块地（Delete）')" @click="G.removeSel()"><Icon :icon="IconTrash" :size="14" />{{ t('拆掉') }}</button>
          </div>
        </template>
        <template v-else-if="sel.kind === 'road'">
          <dl class="grow-rows">
            <div><dt>{{ t('路') }}</dt><dd>{{ t(ROAD_NAME[sel.road.kind]) }}</dd></div>
            <div><dt>{{ t('长度') }}</dt><dd>{{ roadLength(sel.road.pts) }} m</dd></div>
            <div><dt>{{ t('临街的地块') }}</dt><dd>{{ frontage(sel.road.id) }}</dd></div>
          </dl>
          <button type="button" class="wide" :title="t('连同临街的地块一起拆（Delete）')" @click="G.removeSel()"><Icon :icon="IconTrash" :size="14" />{{ t('拆掉这条路') }}</button>
        </template>
        <template v-else>
          <dl class="grow-rows">
            <div><dt>{{ t('分区') }}</dt><dd>{{ t(USE_NAME[sel.zone.use] ?? sel.zone.use) }}</dd></div>
          </dl>
          <button type="button" class="wide" :title="t('已经盖在里面的不动（Delete）')" @click="G.removeSel()"><Icon :icon="IconTrash" :size="14" />{{ t('取消分区') }}</button>
        </template>
      </div>
      <p v-else class="counter-note">{{ t('用舞台下方的工具栏自己建：画路、摆建筑、划分区、刷地形、拆除。也可以让它按需求自己长。') }}</p>

      <div class="tool-group">
        <h3>{{ t('自动生长') }}</h3>
        <div class="pair">
          <button type="button" :title="t('按需求序列连续生长（空格）')" @click="G.toggle()">
            <Icon :icon="gs.playing ? IconPause : IconPlay" :size="14" />{{ t(gs.playing ? '暂停' : '播放') }}
          </button>
          <button type="button" :title="t('按需求序列走一步（N）')" @click="G.step()"><Icon :icon="IconSkipForward" :size="14" />{{ t('走一步') }}</button>
        </div>
        <Field label="速度"><Seg :options="speeds" :model-value="gs.speed" @update:model-value="G.setSpeed" /></Field>
        <button type="button" class="wide" :disabled="!gs.driver.pending.length" :title="t('在建的地块马上盖好')" @click="G.finishBuilding()"><Icon :icon="IconCheck" :size="14" />{{ t('全部盖好') }}</button>
        <p class="counter-note">{{ t('需求序列：每来一个人一处住处；每 4 人一片田、每 8 人两块料场、每 10 人一间铺子；偶尔有人翻盖、搬走。新地块先在建，过 3 步盖好。') }}</p>
      </div>

      <div class="tool-group">
        <h3>{{ t('让引擎挑地方摆') }}</h3>
        <div class="grow-demands">
          <button v-for="m in G.MANUAL" :key="m.use" type="button" :title="t('由引擎挑地方摆下')" @click="G.addDemand(m.use)">
            <i :style="{ background: USE_COLOR[m.use] }"></i>{{ t(USE_NAME[m.use]) }}<small v-if="m.count > 1">×{{ m.count }}</small>
          </button>
        </div>
      </div>
    </Section>

    <Section v-show="gs.tab === 'land'">
      <button type="button" class="wide" :title="t('没有河、海、山的平地，什么都没有：从零开始自己建（当前这一局会清空，可撤销）')" @click="G.blankSlate()">
        <Icon :icon="IconSquare" :size="14" />{{ t('一张白纸：空白平地') }}
      </button>
      <div class="seed">
        <input v-model="p.seed" spellcheck="false" autocomplete="off" :placeholder="t('输入种子')" :title="t('同一种子总是得到同一片地形')" @keydown.enter="G.restart()" />
        <button type="button" class="dice" :title="t('换一个随机种子，重新开局')" @click="G.randomSeed()"><Icon :icon="IconDices" :size="14" />{{ t('随机') }}</button>
      </div>
      <Field label="起始"><Seg :options="START_OPTS" :model-value="p.start" @update:model-value="(v) => (p.start = v)" /></Field>
      <Field label="画幅" title="地图的边长"><Seg :options="SIZE_OPTS" :model-value="p.size" @update:model-value="(v) => (p.size = v)" /></Field>
      <Field label="文明"><Seg :options="CULTURE_OPTS" :model-value="p.culture" @update:model-value="(v) => (p.culture = v)" /></Field>
      <Legend :items="envToggles" @toggle="(i) => (p[envKeys[i]] = !p[envKeys[i]])" />
      <Scale label="地形起伏" :min="0" :max="1" :step="0.05" :fmt="(x) => x.toFixed(2)" :reset="gs.applied.relief" reset-tip="双击回到当前这一局的值" v-model="p.relief" />
      <p class="counter-note">{{ t('改了这里的参数要点下面的「重新开局」才生效，当前这一局会清空（可撤销）。开局之后的地形用工具栏的「地形」笔刷改。') }}</p>
      <Field label="绘图风格"><Swatches :items="swatches" :model-value="gs.style" @update:model-value="G.setStyle" /></Field>
    </Section>

    <Section v-show="gs.tab === 'stats'">
      <dl class="grow-rows">
        <div><dt>{{ t('来过的人') }}</dt><dd>{{ gs.driver.n.toLocaleString() }}</dd></div>
        <div><dt>{{ t('摆不下') }}</dt><dd>{{ gs.driver.fails }}</dd></div>
        <div v-for="u in stats.uses" :key="u.use">
          <dt><i class="sw" :style="{ background: USE_COLOR[u.use] }"></i>{{ t(USE_NAME[u.use]) }}</dt>
          <dd>{{ u.built }}<small v-if="u.building"> + {{ u.building }} {{ t('在建') }}</small></dd>
        </div>
        <div><dt>{{ t('空出来的地') }}</dt><dd>{{ stats.vacant }}</dd></div>
        <div v-for="r in stats.roads" :key="r.kind"><dt>{{ t(ROAD_NAME[r.kind]) }}</dt><dd>{{ r.n }} · {{ r.m.toLocaleString() }} m</dd></div>
        <div><dt>{{ t('分区') }}</dt><dd>{{ stats.zones }}</dd></div>
        <div><dt>{{ t('地形笔画') }}</dt><dd>{{ stats.strokes }}</dd></div>
      </dl>
    </Section>
  </div>
</template>

<style scoped>
.grow-read {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
.sw,
.grow-demands i {
  display: inline-block;
  width: 9px;
  height: 9px;
}
.grow-demands {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.grow-demands button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 6px;
  border: 1px solid var(--rule-2);
  font-size: 12.5px;
}
.grow-demands button:hover {
  border-color: var(--ink);
}
.grow-demands small {
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.inspector .pair,
.inspector .wide {
  margin-top: 10px;
}
.inspector {
  margin-bottom: 4px;
}
.wide:disabled,
.pair button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
