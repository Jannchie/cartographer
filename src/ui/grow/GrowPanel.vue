<script setup lang="ts">
import { IconDices, IconSquare, IconTrash } from '@jannchie/icons'
import { computed } from 'vue'
import { cultures } from '../../settlement/culture'
import { polylineLength } from '../../settlement/geom'
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
const HORIZON_NAME: Record<number, string> = { 600: '村', 3000: '镇', 8000: '城' }
const horizonOpts = computed(() => G.HORIZONS.map((v) => ({ value: v, label: `${t(HORIZON_NAME[v])} ${v.toLocaleString()}` })))
const envKeys = ['river', 'coast', 'hills'] as const
const envToggles = computed(() => [
  { label: '河流', on: p.river, title: '一条河穿过画幅' },
  { label: '临海', on: p.coast, title: '画幅一侧是海' },
  { label: '依山', on: p.hills, title: '画幅一侧是山' },
])
const swatches = settleThemes.all().map((th) => ({ id: th.id, name: th.name, desc: th.desc, paper: th.ground, ink: th.ink }))

const sel = computed(() => G.selected())
const roadLength = (pts: [number, number][]) => Math.round(polylineLength(pts))
const frontage = (roadId: number) => gs.state.lots.filter((l) => l.road === roadId && l.state !== 'vacant').length

/** 统计：各用途的地块（按规划长的 / 手动摆的）、各种路 */
const stats = computed(() => {
  const s = gs.state
  const uses = ['center', 'home', 'field', 'shop', 'yard', 'public'].map((u) => {
    const ls = s.lots.filter((l) => l.use === u && l.state !== 'vacant')
    return { use: u, grown: ls.filter((l) => l.ref !== undefined).length, hand: ls.filter((l) => l.ref === undefined).length }
  })
  const vacant = s.lots.filter((l) => l.state === 'vacant').length
  const roads = G.ROAD_KINDS.map((k) => {
    const rs = s.roads.filter((r) => r.kind === k)
    return { kind: k, n: rs.length, hand: rs.filter((r) => !G.planned(r.id)).length, m: rs.reduce((a, r) => a + roadLength(r.pts), 0) }
  })
  return { uses, vacant, roads, strokes: s.strokes?.length ?? 0 }
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
          <button v-if="sel.lot.ref !== undefined" type="button" class="wide" :title="t('地块空出来，以后的需求接着用（Delete）')" @click="G.removeSel()"><Icon :icon="IconTrash" :size="14" />{{ t('退掉') }}</button>
          <button v-else type="button" class="wide" :title="t('拆掉这块地（Delete）')" @click="G.removeSel()"><Icon :icon="IconTrash" :size="14" />{{ t('拆掉') }}</button>
        </template>
        <template v-else>
          <dl class="grow-rows">
            <div><dt>{{ t('路') }}</dt><dd>{{ t(ROAD_NAME[sel.road.kind]) }}</dd></div>
            <div><dt>{{ t('来历') }}</dt><dd>{{ t(G.planned(sel.road.id) ? '按规划长的' : '手动铺的') }}</dd></div>
            <div><dt>{{ t('长度') }}</dt><dd>{{ roadLength(sel.road.pts) }} m</dd></div>
            <div><dt>{{ t('临街的地块') }}</dt><dd>{{ frontage(sel.road.id) }}</dd></div>
          </dl>
          <button v-if="!G.planned(sel.road.id)" type="button" class="wide" :title="t('连同临街的手动地块一起拆（Delete）')" @click="G.removeSel()"><Icon :icon="IconTrash" :size="14" />{{ t('拆掉这条路') }}</button>
        </template>
      </div>
      <p v-else class="counter-note">{{ t('聚落按规划的成长史长，和聚落地图里一键生成的是同一种。同时可以用舞台下方的工具栏动手：画路、摆建筑、刷地形、拆除——手动的优先，规划的东西会让开。') }}</p>

      <div class="tool-group">
        <h3>{{ t('自动生长') }}</h3>
        <p class="counter-note">{{ t('播放、走一步、速度在舞台下方的工具栏上。') }}</p>
        <p class="counter-note">{{ t('需求序列：每来一户一处住处；每 4 户认领一片田、每 8 户两处料场、每 10 户一间铺子；偶尔有人多占一处、搬走。住处是规划里的一户，田是已经开出来的田块。') }}</p>
      </div>

      <div class="tool-group">
        <h3>{{ t('按规划摆一样') }}</h3>
        <div class="grow-demands">
          <button v-for="m in G.MANUAL" :key="m.use" type="button" :disabled="gs.loading" :title="t('位置由规划定：规划里下一处空着的')" @click="G.addDemand(m.use)">
            <i :style="{ background: USE_COLOR[m.use] }"></i>{{ t(USE_NAME[m.use]) }}<small v-if="m.count > 1">×{{ m.count }}</small>
          </button>
        </div>
      </div>
    </Section>

    <Section v-show="gs.tab === 'land'">
      <div class="seed">
        <input v-model="p.seed" spellcheck="false" autocomplete="off" :placeholder="t('输入种子')" :title="t('同一种子总是得到同一片地形、同一份规划')" @keydown.enter="G.restart()" />
        <button type="button" class="dice" :title="t('换一个随机种子，重新开局')" @click="G.randomSeed()"><Icon :icon="IconDices" :size="14" />{{ t('随机') }}</button>
      </div>
      <Field label="规划规模" title="这片地最多长到多少人：聚落沿着按这个规模规划好的成长史长，住满以后不再长。规模越大，画幅越大、规划得越久">
        <Seg :options="horizonOpts" :model-value="p.horizon" @update:model-value="(v) => (p.horizon = v)" />
      </Field>
      <Field label="文明"><Seg :options="CULTURE_OPTS" :model-value="p.culture" @update:model-value="(v) => (p.culture = v)" /></Field>
      <Legend :items="envToggles" @toggle="(i) => (p[envKeys[i]] = !p[envKeys[i]])" />
      <Scale label="地形起伏" :min="0" :max="1" :step="0.05" :fmt="(x) => x.toFixed(2)" :reset="gs.state.terrain.relief" reset-tip="双击回到当前这一局的值" v-model="p.relief" />
      <button type="button" class="wide" :title="t('没有河、海、山的平地：地形从头自己刷（当前这一局会清空，可撤销）')" @click="G.blankSlate()">
        <Icon :icon="IconSquare" :size="14" />{{ t('换成空白平地') }}
      </button>
      <p class="counter-note">{{ t('改了这里的参数要点下面的「重新开局」才生效，当前这一局会清空（可撤销）。开局之后的地形用工具栏的「地形」笔刷改。') }}</p>
      <div class="tool-group">
        <h3>{{ t('绘图风格') }}</h3>
        <Swatches :items="swatches" :model-value="gs.style" @update:model-value="G.setStyle" />
      </div>
    </Section>

    <Section v-show="gs.tab === 'stats'">
      <!-- 不在这一页时不算（每走一步都要数一遍地块） -->
      <dl v-if="gs.tab === 'stats'" class="grow-rows">
        <div><dt>{{ t('规划规模') }}</dt><dd>{{ gs.state.plan!.horizon.toLocaleString() }}</dd></div>
        <div><dt>{{ t('来过的户') }}</dt><dd>{{ gs.driver.n.toLocaleString() }}</dd></div>
        <div v-for="u in stats.uses" :key="u.use">
          <dt><i class="sw" :style="{ background: USE_COLOR[u.use] }"></i>{{ t(USE_NAME[u.use]) }}</dt>
          <dd>{{ u.grown }}<small v-if="u.hand"> + {{ u.hand }} {{ t('手动') }}</small></dd>
        </div>
        <div><dt>{{ t('空出来的地') }}</dt><dd>{{ stats.vacant }}</dd></div>
        <div v-for="r in stats.roads" :key="r.kind">
          <dt>{{ t(ROAD_NAME[r.kind]) }}</dt>
          <dd>{{ r.n }}<small v-if="r.hand"> ({{ r.hand }} {{ t('手动') }})</small> · {{ r.m.toLocaleString() }} m</dd>
        </div>
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
.inspector .wide {
  margin-top: 10px;
}
.inspector {
  margin-bottom: 4px;
}
.grow-demands button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
