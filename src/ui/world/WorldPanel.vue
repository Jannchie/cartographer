<script setup lang="ts">
import {
  IconBrush,
  IconCloudRain,
  IconContinent,
  IconCursor,
  IconDices,
  IconDropletOff,
  IconEraser,
  IconMapPinPlus,
  IconReset,
  IconSnowflake,
  IconSun,
  IconTerrainLower,
  IconTerrainRaise,
  IconTerrainSmooth,
  IconTrash,
  IconUndo,
  IconWand,
  type Icon as IconDef,
} from '@jannchie/icons'
import { computed } from 'vue'
import type { EditTool, EditView } from '../../editor/editor'
import type { Label, WorldParams } from '../../gen/types'
import { DEFAULT_PARAMS, isGlobe } from '../../gen/types'
import { NAMING_STYLES } from '../../gen/naming'
import { THEMES } from '../../render/atlas'
import { LOOKS, QUALITIES, type Look } from '../../render/aerial/looks'
import { HOLO_PALETTES } from '../../render/holo/palettes'
import { DEFAULT_TIME, fmtTime } from '../../render/aerial/daylight'
import { langRef, t } from '../i18n'
import Dropdown from '../kit/Dropdown.vue'
import Field from '../kit/Field.vue'
import Fold from '../kit/Fold.vue'
import Icon from '../kit/Icon.vue'
import Legend from '../kit/Legend.vue'
import Scale from '../kit/Scale.vue'
import Section from '../kit/Section.vue'
import Seg from '../kit/Seg.vue'
import Swatches from '../kit/Swatches.vue'
import AreaPanel from './AreaPanel.vue'
import * as W from './world'
import { latFmt, pct, ws } from './world'

const p = ws.params
const x100 = (v: number) => v.toFixed(2)
const signed = (d: number) => (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`

type NumKey = Exclude<keyof WorldParams, 'seed' | 'naming' | 'width' | 'height' | 'globe' | 'earth'>
const worldScales: { key: NumKey; label: string; min: number; max: number; step: number; fmt: (v: number) => string; inputScale?: number }[] = [
  { key: 'landRatio', label: '陆地比例', min: 0.12, max: 0.65, step: 0.01, fmt: pct, inputScale: 100 },
  { key: 'plates', label: '板块数量', min: 4, max: 30, step: 1, fmt: (v) => String(v) },
  { key: 'mountains', label: '造山强度', min: 0, max: 2, step: 0.05, fmt: x100 },
  { key: 'coastRoughness', label: '海岸破碎', min: 0, max: 1, step: 0.05, fmt: x100 },
  { key: 'erosion', label: '侵蚀风化', min: 0, max: 2, step: 0.05, fmt: x100 },
  { key: 'rainfall', label: '降水倍率', min: 0.3, max: 2, step: 0.05, fmt: x100 },
  { key: 'temperature', label: '气温偏移', min: -15, max: 12, step: 0.5, fmt: (v) => `${v > 0 ? '+' : ''}${v}°` },
  { key: 'latNorth', label: '北缘纬度', min: -60, max: 88, step: 1, fmt: latFmt },
  { key: 'latSouth', label: '南缘纬度', min: -88, max: 60, step: 1, fmt: latFmt },
]
const RES = [
  { value: '768x480', label: '快', title: '768 × 480' },
  { value: '1024x640', label: '标准', title: '1024 × 640' },
  { value: '1536x960', label: '精细', title: '1536 × 960' },
]
// 分辨率只定宽度，高度随之推导（全球图还随纬度范围，见 normalizeParams）
const res = computed({
  get: () => `${p.width}x${Math.round(p.width * 0.625)}`,
  set: (v: string) => W.setParam('width', Number(v.split('x')[0])),
})

const v = ws.view3d
const toggles3d = computed(() => [
  { label: '云层', on: v.clouds },
  { label: '空气感', on: v.haze },
  { label: '道路', on: v.roads },
  { label: '展台', on: v.stage },
  { label: '地名', on: v.labels },
])
const toggleKeys = ['clouds', 'haze', 'roads', 'stage', 'labels'] as const
const lookScales: { key: keyof Look; label: string; min: number; max: number; step: number; fmt: (v: number) => string; inputScale?: number }[] = [
  { label: '曝光', key: 'ev', min: -2, max: 2, step: 0.05, fmt: (x) => `${signed(2)(x)} EV` },
  { label: '色温', key: 'temp', min: -1, max: 1, step: 0.05, fmt: signed(2) },
  { label: '饱和度', key: 'saturation', min: 0, max: 2, step: 0.01, fmt: pct, inputScale: 100 },
  { label: '对比度', key: 'contrast', min: 0.5, max: 2, step: 0.01, fmt: pct, inputScale: 100 },
  { label: '褪色', key: 'fade', min: 0, max: 0.15, step: 0.005, fmt: (x) => pct(x / 0.15) },
  { label: '泛光', key: 'bloom', min: 0, max: 0.4, step: 0.01, fmt: (x) => pct(x / 0.4) },
  { label: '光晕', key: 'halation', min: 0, max: 1, step: 0.01, fmt: pct, inputScale: 100 },
  { label: '色差', key: 'aberration', min: 0, max: 4, step: 0.1, fmt: (x) => `${x.toFixed(1)} px` },
  { label: '暗角', key: 'vignette', min: 0, max: 1, step: 0.01, fmt: pct, inputScale: 100 },
  { label: '颗粒', key: 'grain', min: 0, max: 0.15, step: 0.005, fmt: (x) => pct(x / 0.15) },
  { label: '颗粒大小', key: 'grainSize', min: 1, max: 3, step: 0.1, fmt: (x) => `${x.toFixed(1)} px` },
]
const h = ws.holo
const holoToggles = computed(() => [
  { label: '地名', on: h.labels },
  { label: '读数界面', on: h.hud, title: '屏幕四周的任务读数与目标卡片' },
])
const holoKeys = ['labels', 'hud'] as const
const holoSwatches = HOLO_PALETTES.map((p) => ({ value: p.id, label: p.name }))
const lookBase = computed(() => LOOKS.find((l) => l.id === ws.lookId)?.look ?? LOOKS[0].look)

const atlasSwatches = THEMES.map((th) => ({ id: th.id, name: th.name, desc: th.desc, paper: `rgb(${th.paper.join(',')})`, ink: th.ink }))
const atlasToggles = computed(() => [
  { label: '注记', on: ws.atlasOpts.labels },
  { label: '等高线', on: ws.atlasOpts.contours },
  { label: '经纬网', on: ws.atlasOpts.graticule },
  { label: '图饰', on: ws.ornaments, title: '标题框、指北针与图例（导出的图总是带着）' },
])
const atlasKeys = ['labels', 'contours', 'graticule'] as const

// 编辑工具：三列的图标工具栏（选取 · 地形 · 气候 · 大洲）
const TOOLS: { value: EditTool; label: string; title: string; icon: IconDef<string> }[] = [
  { value: 'select', label: '选取', title: '选取、拖动地点；空白处拖动平移', icon: IconCursor },
  { value: 'place', label: '新增地点', title: '点击地图添加城镇', icon: IconMapPinPlus },
  { value: 'raise', label: '抬升', title: '抬高地形：海里画出陆地、平原上堆出山', icon: IconTerrainRaise },
  { value: 'lower', label: '下沉', title: '压低地形：挖出海湾、湖盆', icon: IconTerrainLower },
  { value: 'smooth', label: '抹平', title: '让地形变平缓', icon: IconTerrainSmooth },
  { value: 'warm', label: '升温', title: '提高气温', icon: IconSun },
  { value: 'cool', label: '降温', title: '降低气温', icon: IconSnowflake },
  { value: 'wet', label: '增雨', title: '增加降水', icon: IconCloudRain },
  { value: 'dry', label: '减雨', title: '减少降水', icon: IconDropletOff },
  { value: 'region', label: '大洲', title: '点选陆块建立大洲，或选中已有大洲', icon: IconContinent },
  { value: 'regionAdd', label: '划入', title: '画笔把陆地划入选中的大洲', icon: IconBrush },
  { value: 'regionErase', label: '移出', title: '画笔把陆地移出选中的大洲', icon: IconEraser },
]
const EDIT_VIEWS: { value: 'auto' | EditView; label: string }[] = [
  { value: 'auto', label: '随画笔切换' },
  { value: 'relief', label: '地貌' },
  { value: 'elevation', label: '海拔 · 等高线' },
  { value: 'temperature', label: '气温' },
  { value: 'rain', label: '降水' },
  { value: 'regions', label: '大洲' },
]
const KINDS: [Label['kind'], string][] = [
  ['capital', '首都'],
  ['city', '城镇'],
  ['continent', '大陆'],
  ['island', '岛屿'],
  ['ocean', '大洋'],
  ['sea', '海'],
  ['lake', '湖泊'],
  ['range', '山脉'],
  ['basin', '盆地'],
  ['desert', '沙漠'],
  ['forest', '森林'],
]
const brushTool = computed(() => !['select', 'place', 'region'].includes(ws.tool))
const regionTool = computed(() => ws.tool.startsWith('region'))
const val = (e: Event) => (e.target as HTMLInputElement).value
</script>

<template>
  <div class="panel-body">
    <Section v-show="ws.tab === 'gen'">
      <div class="seed">
        <input
          :value="p.seed"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('输入种子')"
          :title="t('同一种子总是生成同一个世界')"
          @input="p.seed = val($event); W.markDirty()"
          @keydown.enter="W.generate()"
        />
        <button type="button" class="dice" :title="t('随机种子并生成（R）')" @click="W.randomSeed()"><Icon :icon="IconDices" :size="14" />{{ t('随机') }}</button>
      </div>
      <Field label="地形预设" title="一键换一类世界的参数，点「生成」后生效">
        <Dropdown :options="W.PRESETS.map((x, i) => ({ value: i, label: x.name, desc: x.desc }))" :model-value="ws.preset" placeholder="自定义" @update:model-value="W.applyPreset" />
      </Field>
      <Field label="命名" title="地名的世界观：同一个地名在中英日三种语言里意思一致">
        <Dropdown :options="NAMING_STYLES.map((n) => ({ value: n.id, label: n.label, desc: n.tip }))" :model-value="p.naming ?? 'auto'" @update:model-value="(n) => W.setParam('naming', n)" />
      </Field>
      <Fold label="高级参数" id="advanced">
        <Field label="分辨率"><Seg v-model="res" :options="RES" /></Field>
        <Legend
          :items="[
            { label: '全球图', on: isGlobe(p), title: '横跨 360° 经度的世界全图：比例尺按赤道，高度随纬度范围' },
            { label: '地球底图', on: !!p.earth, title: '大陆、山脉与海深取自真实地球（ETOPO1）；陆地比例、板块数不再起作用' },
          ]"
          @toggle="(i) => (i ? W.setParam('earth', !p.earth) : W.setParam('globe', !isGlobe(p)))"
        />
        <Scale
          v-for="s in worldScales"
          :key="s.key"
          v-bind="s"
          :model-value="p[s.key]"
          :reset="(ws.applied ?? DEFAULT_PARAMS)[s.key]"
          reset-tip="双击回到当前生成的值"
          @update:model-value="(x) => W.setParam(s.key, x)"
        />
        <button type="button" class="link" @click="W.resetParams()">{{ t('恢复默认参数') }}</button>
      </Fold>
    </Section>

    <div v-if="ws.info" v-show="ws.tab === 'stats'" class="cartouche">
      <div class="cartouche-title">
        <span>{{ ws.info.title }}</span><small>{{ ws.info.time }}</small>
      </div>
      <dl>
        <div v-for="[k, x] in ws.info.tiles" :key="k"><dt>{{ t(k) }}</dt><dd>{{ x }}</dd></div>
      </dl>
    </div>

    <Section v-if="ws.mode === '3d'" v-show="ws.tab === 'view'">
      <Legend :items="toggles3d" @toggle="(i) => W.set3d({ [toggleKeys[i]]: !v[toggleKeys[i]] })" />
      <Scale label="垂直夸张" :min="4" :max="60" :step="1" :reset="28" :fmt="(x) => `×${x}`" :model-value="v.exaggeration" @update:model-value="(x) => W.set3d({ exaggeration: x })" />
      <Scale
        label="移轴景深"
        :min="0"
        :max="100"
        :step="1"
        :reset="25"
        :fmt="(x) => (x ? `${x}%` : t('关'))"
        :model-value="Math.round(v.dof * 100)"
        @update:model-value="(x) => W.set3d({ dof: x / 100 })"
      />
      <Scale
        label="时间"
        title="一天中的时刻：12:00 为正午，入夜后城镇亮起灯火"
        :min="0"
        :max="24"
        :step="0.1"
        :reset="DEFAULT_TIME"
        :fmt="fmtTime"
        :model-value="v.timeOfDay"
        @update:model-value="(x) => W.set3d({ timeOfDay: x })"
      />
      <Legend :items="[{ label: '昼夜循环', on: v.dayCycle, title: '时间自动流逝，约一分钟过完一天' }]" @toggle="W.set3d({ dayCycle: !v.dayCycle })" />
      <Scale label="太阳方位" title="正午时太阳所在的方位：日出、日落的方向随之转动" :min="0" :max="360" :step="1" :reset="225" :fmt="(x) => `${x}°`" :model-value="v.sunAzimuth" @update:model-value="(x) => W.set3d({ sunAzimuth: x })" />
      <Scale label="正午高度" title="太阳一天中升到的最高角度（夜里月亮也升到这么高）" :min="2" :max="88" :step="1" :reset="32" :fmt="(x) => `${x}°`" :model-value="v.sunElevation" @update:model-value="(x) => W.set3d({ sunElevation: x })" />
      <Field label="画质">
        <Seg :options="QUALITIES.map((q) => ({ value: q.id, label: q.name }))" :model-value="v.quality" @update:model-value="(q) => W.set3d({ quality: q })" />
      </Field>
      <Scale label="阴影柔和" :min="0" :max="10" :step="0.5" :reset="3" :fmt="(x) => x.toFixed(1)" :model-value="v.shadowSoftness" @update:model-value="(x) => W.set3d({ shadowSoftness: x })" />
      <Fold label="滤镜" id="lookOpen">
        <!-- 滤镜名称：中文四列放得下，英文、日文的长名称（Cine tungsten、シネ タングステン）用两列 -->
        <Seg :cols="langRef === 'zh' ? 4 : 2" :options="LOOKS.map((l) => ({ value: l.id, label: l.name }))" :model-value="ws.lookId" @update:model-value="W.pickLook" />
        <Scale
          v-for="s in lookScales"
          :key="s.key"
          v-bind="s"
          :model-value="v.look[s.key] as number"
          :reset="lookBase[s.key] as number"
          @update:model-value="(x) => W.setLook({ [s.key]: x })"
        />
      </Fold>
    </Section>

    <Section v-if="ws.mode === 'holo'" v-show="ws.tab === 'view'">
      <Field label="配色">
        <Seg :cols="holoSwatches.length" :options="holoSwatches" :model-value="h.palette" @update:model-value="(id) => W.setHolo({ palette: id })" />
      </Field>
      <Legend :items="holoToggles" @toggle="(i) => W.setHolo({ [holoKeys[i]]: !h[holoKeys[i]] })" />
      <Scale label="垂直夸张" :min="0" :max="40" :step="1" :reset="W.HOLO_DEFAULTS.exaggeration" :fmt="(x) => `×${x}`" :model-value="h.exaggeration" @update:model-value="(x) => W.setHolo({ exaggeration: x })" />
      <Scale
        label="立面高度"
        title="四周线框立面上地形侧视轮廓的高度；顶面随之升降"
        :min="0"
        :max="15"
        :step="0.25"
        :reset="W.HOLO_DEFAULTS.sectionHeight"
        :fmt="(x) => x.toFixed(1)"
        :model-value="h.sectionHeight"
        @update:model-value="(x) => W.setHolo({ sectionHeight: x })"
      />
      <button type="button" class="link" @click="W.resetHoloView()">{{ t('复位视角') }}</button>
    </Section>

    <Section v-if="ws.mode === '2d'" v-show="ws.tab === 'view'">
      <Swatches :items="atlasSwatches" :model-value="ws.atlasStyle" @update:model-value="W.setAtlasStyle" />
      <Legend :items="atlasToggles" @toggle="(i) => (i < atlasKeys.length ? W.setAtlasOpt(atlasKeys[i], !ws.atlasOpts[atlasKeys[i]]) : W.setOrnaments(!ws.ornaments))" />
    </Section>

    <Section v-if="ws.mode === 'areas'" v-show="ws.tab === 'view'">
      <AreaPanel />
    </Section>

    <Section v-if="ws.mode === 'edit'" v-show="ws.tab === 'view'">
      <Seg :cols="3" :options="TOOLS" :model-value="ws.tool" @update:model-value="W.setTool" />
      <Field label="底图">
        <Dropdown :options="EDIT_VIEWS" :model-value="ws.editView" @update:model-value="W.setEditView" />
      </Field>
      <div class="brush" :class="{ dim: !brushTool }">
        <Scale label="画笔大小" :min="3" :max="100" :step="1" :fmt="(x) => `${Math.round(x)}`" :model-value="ws.brush.radius" @update:model-value="(x) => W.setBrush({ radius: x })" />
        <Scale label="画笔强度" :min="0.05" :max="1" :step="0.05" :fmt="x100" :model-value="ws.brush.strength" @update:model-value="(x) => W.setBrush({ strength: x })" />
      </div>
      <div v-if="regionTool" class="sub">
        <Scale label="地峡宽度" :min="2" :max="40" :step="1" :fmt="(x) => t('{n} 格', { n: Math.round(x) })" v-model="ws.neck" />
        <button type="button" class="wide" :title="t('在窄于「地峡宽度」的地方把陆地切开，每块大陆核心各成一洲')" @click="W.autoRegions()"><Icon :icon="IconWand" :size="14" />{{ t('自动划分大洲') }}</button>
        <div v-if="ws.region" class="inspector">
          <Field label="原名"><input :value="ws.region.name" spellcheck="false" @input="W.editRegionName('name', val($event))" /></Field>
          <Field label="中文名"><input :value="ws.region.zh" spellcheck="false" @input="W.editRegionName('zh', val($event))" /></Field>
          <Field label="日文名"><input :value="ws.region.ja" spellcheck="false" @input="W.editRegionName('ja', val($event))" /></Field>
          <button type="button" class="danger" @click="W.deleteRegion()"><Icon :icon="IconTrash" :size="14" />{{ t('删除这个大洲') }}</button>
        </div>
      </div>
      <Legend :items="[{ label: '显示地名', on: ws.showNames }]" @toggle="W.setShowNames(!ws.showNames)" />
      <div class="pair">
        <button type="button" :title="t('撤销（Ctrl+Z）')" @click="W.undo()"><Icon :icon="IconUndo" :size="14" />{{ t('撤销') }}</button>
        <button type="button" :title="t('清除全部编辑')" @click="W.clearEdits()"><Icon :icon="IconReset" :size="14" />{{ t('清除编辑') }}</button>
      </div>
      <div v-if="ws.insp" class="inspector">
        <h3>{{ t('地点') }}</h3>
        <Field label="原名"><input :value="ws.insp.name" spellcheck="false" @input="W.editLabelName('name', val($event))" @change="W.endLabelEdit()" /></Field>
        <Field label="中文名"><input :value="ws.insp.zh" spellcheck="false" @input="W.editLabelName('zh', val($event))" @change="W.endLabelEdit()" /></Field>
        <Field label="日文名"><input :value="ws.insp.ja" spellcheck="false" @input="W.editLabelName('ja', val($event))" @change="W.endLabelEdit()" /></Field>
        <Field label="类型">
          <Dropdown :options="KINDS.map(([k, n]) => ({ value: k, label: n }))" :model-value="ws.insp.kind" @update:model-value="W.setLabelKind" />
        </Field>
        <button type="button" class="danger" :title="t('删除（Delete）')" @click="W.deleteSelected()"><Icon :icon="IconTrash" :size="14" />{{ t('删除地点') }}</button>
      </div>
    </Section>
  </div>
</template>
