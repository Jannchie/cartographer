<script setup lang="ts">
import { computed } from 'vue'
import { SETTLE_THEMES } from '../../settlement/themes'
import { FEATURES, FUNCTIONS, GROUPS, featureEnv, featureName as nameOf, resolveCounts, type FeatureDef } from '../../settlement/features'
import { PLAN_INFO, planLabel } from '../../settlement/plans'
import { CULTURE_INFO, CULTURES, planFits } from '../../settlement/culture'
import { POP_MAX, POP_MIN, sizeLabel } from '../../settlement/scale'
import { LAND_USES } from '../../settlement/landuse'
import { DEFAULT_SETTLEMENT, type SettlementParams } from '../../settlement/types'
import { LOOKS, QUALITIES } from '../../render/aerial/looks'
import { DEFAULT_TIME, fmtTime } from '../../render/aerial/daylight'
import { placeName } from '../../i18n'
import { langRef, t } from '../i18n'
import Counter from '../kit/Counter.vue'
import Dropdown from '../kit/Dropdown.vue'
import Field from '../kit/Field.vue'
import LayoutPicker from '../kit/LayoutPicker.vue'
import Legend from '../kit/Legend.vue'
import Scale from '../kit/Scale.vue'
import Section from '../kit/Section.vue'
import Seg from '../kit/Seg.vue'
import Swatches from '../kit/Swatches.vue'
import RegionPanel from './RegionPanel.vue'
import * as S from './settlement'
import { ss } from './settlement'

const p = ss.params
/** 当前这座城生成时的参数：生成参数的滑杆双击回到这里 */
const gen = computed(() => ss.applied ?? DEFAULT_SETTLEMENT)
const CULTURE_OPTS = CULTURES.map((c) => ({ value: c, label: CULTURE_INFO[c].name[0], title: CULTURE_INFO[c].desc }))
// 形制跟着文明：只列本文明的
const planOpts = computed(() =>
  PLAN_INFO.filter((f) => planFits(p.culture, f.id)).map((f) => {
    const l = planLabel(f, p.culture)
    return { value: f.id, label: l.name, desc: l.desc }
  }),
)
const MAGIC: { value: SettlementParams['magic']; label: string; title?: string }[] = [
  { value: 0, label: '写实' },
  { value: 1, label: '奇幻', title: '法师塔与魔法阵 / 宗门与仙阁' },
  { value: 2, label: '高魔', title: '再加浮空岛与灵脉' },
]
const WALLS: { value: SettlementParams['walls']; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'none', label: '无' },
  { value: 'palisade', label: '木栅' },
  { value: 'stone', label: '石墙' },
]
const envKeys = ['river', 'coast', 'hills', 'farms', 'capital'] as const
const envToggles = computed(() => [
  { label: '河流', on: p.river, title: '一条河穿城而过：桥梁、码头、渡口' },
  { label: '临海', on: p.coast, title: '城在海湾边：港口、栈桥与船' },
  { label: '依山', on: p.hills, title: '地图一侧是山' },
  { label: '农田', on: p.farms, title: '城外的条田、水田、果园与牧场' },
  { label: '都城', on: !!p.capital, title: '一国之都：皇宫、王宫、御所这类宫殿' },
])
// 规模：人口滑块；滑块名称随档位变化（小村 / 村镇 / 城镇 / 城市 / 大都会）
const sizeName = computed(() => sizeLabel(p.population))
const popFmt = (x: number) => x.toLocaleString()

// 要素：按分组列出，数量自动推算（灰字），可手动覆盖
const env = computed(() => featureEnv(p))
// 副中心：有副中心（自动或手动）时才显示距离滑块
const subCount = computed(() => (env.value.big ? resolveCounts(p, env.value).subcenter : 0))
const spreadFmt = (x: number) => t(x < 0.5 ? '连成一片' : x < 0.8 ? '城郊相望' : '卫星城')
const featureName = (f: FeatureDef) => nameOf(f, p.culture)
const groups = computed(() =>
  GROUPS.map((g) => ({ ...g, items: FEATURES.filter((f) => f.group === g.id) })).filter((g) => g.items.length),
)
const manualCount = computed(() => Object.values(p.counts).filter((v) => v !== null && v !== undefined).length)
// 世界地点：第一项是"不继承"，其余是世界地图上的城镇。地名按界面语言写，中文、日文界面后面附原名（便于与英文地图对照）
const places = computed(() => [
  { value: -1, label: t('不继承（独立生成）') },
  ...ss.places.map((pl) => {
    const name = placeName(pl, langRef.value)
    return { value: pl.i, label: `${pl.capital ? '★ ' : ''}${name}${name !== pl.name ? ` · ${pl.name}` : ''}` }
  }),
])
const swatches = SETTLE_THEMES.map((th) => ({ id: th.id, name: th.name, desc: th.desc, paper: th.ground, ink: th.ink }))
const RANDOM_MODE = [
  { value: 'all', label: '全部参数', title: '种子、规模、文明、功效、布局与环境都随机' },
  { value: 'keep', label: '保留配置', title: '只换种子，其余参数不变' },
] as const
const RANDOM_TERRAIN = [
  { value: 'random', label: '随机地形', title: '山、河、海岸跟着新种子变' },
  { value: 'fixed', label: '固定地形', title: '保持现在的山、河、海岸，只换上面的城' },
] as const
const optKeys = ['labels', 'contours', 'ornaments'] as const
// 沙盘选项（与世界沙盘同名同义）
const tv = ss.town
const townToggles = computed(() => [
  { label: '空气感', on: tv.haze },
  { label: '展台', on: tv.stage },
  { label: '注记', on: tv.labels, title: '片区名与地标名' },
])
const townKeys = ['haze', 'stage', 'labels'] as const
const opts = computed(() => [
  { label: '注记', on: ss.opts.labels },
  { label: '等高线', on: ss.opts.contours },
  { label: '图饰', on: ss.opts.ornaments, title: '标题框、指北针与区划图例（导出的图总是带着）' },
])
const VIEWS = [
  { value: 'map', label: '地图' },
  { value: 'zoning', label: '区划', title: '普通地图，或按用地性质给片区着色的区划图' },
] as const
// 职业表：各大类的人口与占全城的比例（条形），点开列出细分的行当
const occupations = computed(() => {
  const total = ss.people.reduce((s, g) => s + g.people, 0) || 1
  return ss.people.map((g) => ({ ...g, share: g.people / total }))
})
// 区划图例：各类的颜色与占城区面积的比例（城郊农田给公顷数），点一项开关它的着色
const zoningLegend = computed(() =>
  ss.landUse.map((s) => {
    const d = LAND_USES.find((x) => x.id === s.id)!
    return {
      id: s.id,
      label: d.name,
      color: d.light,
      on: !ss.opts.hidden.includes(s.id),
      title: '点图例开关各类的着色',
      note: s.id === 'rural' ? `${s.ha < 10 ? s.ha.toFixed(1) : Math.round(s.ha)} ha` : s.share < 0.01 ? '<1%' : `${Math.round(s.share * 100)}%`,
    }
  }),
)
</script>

<template>
  <div class="panel-body">
    <Section v-show="ss.tab === 'gen'">
      <div class="seed">
        <input
          v-model="p.seed"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('输入种子')"
          :title="t('同一种子总是生成同一座聚落')"
          @keydown.enter="S.run()"
        />
        <button type="button" class="dice" :title="t('按下面的方式随机一座聚落（R）')" @click="S.randomSeed()">{{ t('随机') }}</button>
      </div>
      <Field label="随机" title="点「随机」或按 R 时换掉哪些">
        <Seg :options="[...RANDOM_MODE]" :model-value="ss.random.mode" @update:model-value="(v) => S.setRandom('mode', v)" />
      </Field>
      <Field label="地形">
        <Seg :options="[...RANDOM_TERRAIN]" :model-value="ss.random.terrain" @update:model-value="(v) => S.setRandom('terrain', v)" />
      </Field>
      <p v-if="p.terrainSeed" class="counter-note">
        {{ t('地形已固定：换种子、换文明，山河海岸都不变') }} ·
        <button type="button" class="link" @click="S.unpinTerrain()">{{ t('解除') }}</button>
      </p>
      <Scale
        :label="sizeName"
        title="目标人口：小村几十人，大都会数万人；地图范围、片区数、街宽与各要素的默认数量都随之变化"
        :min="POP_MIN"
        :max="POP_MAX"
        :step="1"
        log
        :fmt="popFmt"
        :reset="gen.population"
        reset-tip="双击回到当前生成的值"
        :model-value="p.population"
        v-model="p.population"
      />
      <Field label="功效" title="城市的主要功能：改变各要素的默认数量与城墙样式">
        <Dropdown :options="FUNCTIONS.map((f) => ({ value: f.id, label: f.name, desc: f.desc }))" :model-value="p.function" @update:model-value="(v) => S.setParam('function', v)" />
      </Field>
      <Field label="文明"><Seg :options="CULTURE_OPTS" :model-value="p.culture" @update:model-value="(v) => S.setCulture(v)" /></Field>
      <Field label="布局" title="有机生长、方格、放射三种街道格局的混合比例（与文明无关）">
        <LayoutPicker :regularity="p.regularity" :radial="p.radial" :reset="{ regularity: gen.regularity, radial: gen.radial }" @update="S.setLayout" />
      </Field>
      <Field label="形制" title="城市的规划形制：规划的核心按形制铺开，外面照旧有机生长">
        <Dropdown :options="planOpts" :model-value="p.plan ?? 'organic'" @update:model-value="(v) => S.setParam('plan', v)" />
      </Field>
      <Scale
        v-if="p.plan && p.plan !== 'organic'"
        label="规划强度"
        title="规划区住得下多少人口：少则只有规划的老城、外面有机生长，多则整座城都按规划铺开"
        :min="0.1"
        :max="1"
        :step="0.05"
        :fmt="(x) => `${Math.round(x * 100)}%`"
        :reset="gen.planStrength ?? DEFAULT_SETTLEMENT.planStrength"
        reset-tip="双击回到当前生成的值"
        :model-value="p.planStrength ?? 0.6"
        @update:model-value="(v) => (p.planStrength = v)"
      />
      <Scale
        v-if="subCount > 0"
        label="副中心距离"
        title="副中心离主城多远：近则连成一片城市圈，远则是隔着田野、有干道相连的卫星城"
        :min="0"
        :max="1"
        :step="0.05"
        :fmt="spreadFmt"
        :reset="gen.spread"
        reset-tip="双击回到当前生成的值"
        v-model="p.spread"
      />
      <Field label="奇幻"><Seg :options="MAGIC" :model-value="p.magic" @update:model-value="(x) => S.setParam('magic', x)" /></Field>
      <Field label="城防"><Seg :options="WALLS" :model-value="p.walls" @update:model-value="(x) => S.setParam('walls', x)" /></Field>
      <Scale
        v-if="p.walls !== 'none'"
        label="城墙曲折"
        title="城墙走得多曲折：少则一圈平顺的墙，多则贴着城边的街坊曲曲折折地走"
        :min="0"
        :max="1"
        :step="0.05"
        :fmt="(x) => `${Math.round(x * 100)}%`"
        :reset="gen.wallBend"
        reset-tip="双击回到当前生成的值"
        v-model="p.wallBend"
      />
      <Legend :items="envToggles" @toggle="(i) => S.setParam(envKeys[i], !p[envKeys[i]])" />
      <Scale v-if="p.farms" label="农田范围" title="城外农田铺多远：少则城边一圈，多则一直到地图边缘；其余是草地与林地" :min="0" :max="1" :step="0.05" :fmt="(x) => `${Math.round(x * 100)}%`" :reset="gen.farmland" reset-tip="双击回到当前生成的值" v-model="p.farmland" />
      <Scale label="地形起伏" :min="0" :max="1" :step="0.05" :fmt="(x) => x.toFixed(2)" :reset="gen.relief" reset-tip="双击回到当前生成的值" v-model="p.relief" />
      <Field label="世界地点" title="从当前世界地图选一座城镇：继承名字、规模、河流、海岸、山地与气候">
        <Dropdown raw :options="places" :model-value="ss.from" @open="S.refreshPlaces()" @update:model-value="S.inheritFrom" />
      </Field>
    </Section>

    <div v-if="ss.info" v-show="ss.tab === 'stats'" class="cartouche">
      <div class="cartouche-title">
        <span>{{ ss.info.title }}</span><small>{{ ss.info.sub }}</small>
      </div>
      <dl>
        <div v-for="[k, x] in ss.info.tiles" :key="k"><dt>{{ t(k) }}</dt><dd>{{ x }}</dd></div>
      </dl>
      <div v-if="occupations.length" class="occupations" :title="t('按户主的营生：家人连未成年人随户，学徒、伙计随行当，仆役另算；点开看细分')">
        <h4>{{ t('职业') }}</h4>
        <details v-for="g in occupations" :key="g.name">
          <summary>
            <span class="occ-name">{{ t(g.name) }}</span>
            <i class="occ-bar"><b :style="{ width: `${g.share * 100}%` }"></b></i>
            <span class="occ-num">{{ g.people.toLocaleString() }} {{ t('人') }}</span>
          </summary>
          <ul>
            <li v-for="x in g.trades" :key="x.name">
              <span>{{ t(x.name) }}</span><span class="occ-num">{{ x.people.toLocaleString() }} {{ t('人') }}<template v-if="x.households"> · {{ x.households.toLocaleString() }} {{ t('户') }}</template></span>
            </li>
          </ul>
        </details>
      </div>
    </div>

    <Section v-show="ss.tab === 'features'">
      <div v-for="g in groups" :key="g.id" class="feature-group">
        <h3>{{ t(g.name) }}</h3>
        <template v-for="f in g.items" :key="f.id">
          <div v-if="f.form === 'filler'" class="counter filler" :title="t(f.desc)">
            <span class="counter-name">{{ t(featureName(f)) }}</span><i class="counter-lead"></i><span class="counter-note">{{ t('填满其余') }}</span>
          </div>
          <Counter
            v-else
            :label="featureName(f)"
            :model-value="p.counts[f.id] ?? null"
            :auto="f.auto(env)"
            :max="f.max"
            :disabled="(f.magic ?? 0) > env.magic && p.counts[f.id] == null"
            @update:model-value="(n) => S.setCount(f.id, n)"
          />
        </template>
      </div>
      <button v-if="manualCount" type="button" class="link" @click="S.resetCounts()">{{ t('全部恢复自动') }}（{{ manualCount }}）</button>
    </Section>

    <Section v-if="ss.mode === 'areas'" v-show="ss.tab === 'areas'">
      <RegionPanel />
    </Section>

    <Section v-if="ss.mode === 'sandbox'" v-show="ss.tab === 'style'">
      <Field label="地面" title="地面贴图用哪种地图风格画（道路、田地、绿地、水面）" />
      <Swatches :items="swatches" :model-value="tv.ground" @update:model-value="(g) => S.setTown3d({ ground: g })" />
      <Legend :items="townToggles" @toggle="(i) => S.setTown3d({ [townKeys[i]]: !tv[townKeys[i]] })" />
      <Scale
        label="移轴景深"
        :min="0"
        :max="100"
        :step="1"
        :reset="20"
        :fmt="(x) => (x ? `${x}%` : t('关'))"
        :model-value="Math.round(tv.dof * 100)"
        @update:model-value="(x) => S.setTown3d({ dof: x / 100 })"
      />
      <Scale
        label="时间"
        title="一天中的时刻：12:00 为正午，入夜后窗户亮起灯火"
        :min="0"
        :max="24"
        :step="0.1"
        :reset="DEFAULT_TIME + 2.5"
        :fmt="fmtTime"
        :model-value="tv.timeOfDay"
        @update:model-value="(x) => S.setTown3d({ timeOfDay: x })"
      />
      <Scale label="太阳方位" title="正午时太阳所在的方位：日出、日落的方向随之转动" :min="0" :max="360" :step="1" :reset="225" :fmt="(x) => `${x}°`" :model-value="tv.sunAzimuth" @update:model-value="(x) => S.setTown3d({ sunAzimuth: x })" />
      <Scale label="正午高度" title="太阳一天中升到的最高角度（夜里月亮也升到这么高）" :min="2" :max="88" :step="1" :reset="42" :fmt="(x) => `${x}°`" :model-value="tv.sunElevation" @update:model-value="(x) => S.setTown3d({ sunElevation: x })" />
      <Field label="画质">
        <Seg :options="QUALITIES.map((q) => ({ value: q.id, label: q.name }))" :model-value="tv.quality" @update:model-value="(q) => S.setTown3d({ quality: q })" />
      </Field>
      <Scale label="阴影柔和" :min="0" :max="10" :step="0.5" :reset="2" :fmt="(x) => x.toFixed(1)" :model-value="tv.shadowSoftness" @update:model-value="(x) => S.setTown3d({ shadowSoftness: x })" />
      <Field label="滤镜">
        <Seg :cols="langRef === 'zh' ? 4 : 2" :options="LOOKS.map((l) => ({ value: l.id, label: l.name }))" :model-value="tv.lookId" @update:model-value="S.pickTownLook" />
      </Field>
    </Section>

    <Section v-else v-show="ss.tab === 'style'">
      <Field label="视图" title="普通地图，或按用地性质给片区着色的区划图">
        <Seg :options="[...VIEWS]" :model-value="ss.opts.view" @update:model-value="(v) => S.setView(v)" />
      </Field>
      <Legend v-if="ss.opts.view === 'zoning'" :items="zoningLegend" @toggle="(i) => S.toggleLandUse(zoningLegend[i].id)" />
      <Swatches :items="swatches" :model-value="ss.style" @update:model-value="S.setStyle" />
      <Legend :items="opts" @toggle="(i) => S.setOpt(optKeys[i], !ss.opts[optKeys[i]])" />
    </Section>
  </div>
</template>
