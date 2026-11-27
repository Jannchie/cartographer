<script setup lang="ts">
import {
  IconArrowDown, IconArrowUp, IconCursor, IconDices, IconDroplet, IconDropletOff, IconEqual, IconEraser, IconFastForward, IconHand, IconHome, IconMountain, IconPause, IconPlay, IconRedo, IconRoute, IconUndo,
  type Icon as IconDef,
} from '@jannchie/icons'
import { computed, onMounted, ref, watch } from 'vue'
import { cultures } from '../../settlement/culture'
import type { GrowBrush, GrowP } from '../../settlement/grow'
import { t } from '../i18n'
import Field from '../kit/Field.vue'
import Icon from '../kit/Icon.vue'
import Legend from '../kit/Legend.vue'
import Loading from '../kit/Loading.vue'
import Notices from '../kit/Notices.vue'
import Scale from '../kit/Scale.vue'
import Seg from '../kit/Seg.vue'
import * as G from './grow'
import { ROAD_WIDTH } from '../../settlement/grow/core'
import { BRUSH_COLOR, BRUSH_NAME, BRUSH_R, gs, picture, ROAD_NAME, TOOL_KEYS, USE_COLOR, USE_NAME, type GrowTool } from './grow'

const host = ref<HTMLElement>()
onMounted(() => G.mountGrow(host.value!))

// —— 工具栏 ——
const TOOLS: { id: GrowTool; label: string; icon: IconDef<string>; title: string }[] = [
  { id: 'look', label: '点选', icon: IconCursor, title: '点选地块、路；拖动平移' },
  { id: 'road', label: '道路', icon: IconRoute, title: '按住拖动随手画一条路，或一下一下点出折线' },
  { id: 'build', label: '建筑', icon: IconHome, title: '沿路摆地块：点一下摆一块，按住拖动摆一排' },
  { id: 'terrain', label: '地形', icon: IconMountain, title: '用笔刷改地形：抬高、压低、平整、挖水、填陆' },
  { id: 'erase', label: '拆除', icon: IconEraser, title: '点一下拆掉房子、田、手动的路；按住拖动连着拆' },
]
const BRUSH_ICON: Record<GrowBrush, IconDef<string>> = { raise: IconArrowUp, lower: IconArrowDown, flat: IconEqual, water: IconDroplet, land: IconDropletOff }
/** 当前工具的子选项（数字键选） */
const options = computed<{ id: string; label: string; on: boolean; color?: string; icon?: IconDef<string> }[]>(() => {
  if (gs.tool === 'road') return G.ROAD_KINDS.map((k) => ({ id: k, label: ROAD_NAME[k], on: gs.roadKind === k }))
  if (gs.tool === 'build') return G.BUILD_USES.map((u) => ({ id: u, label: USE_NAME[u], on: gs.buildUse === u, color: USE_COLOR[u] }))
  if (gs.tool === 'terrain') return G.BRUSHES.map((b) => ({ id: b, label: BRUSH_NAME[b], on: gs.brush === b, icon: BRUSH_ICON[b] }))
  return []
})

// —— 叠加层 ——
/** 米 → 舞台坐标 */
const at = (p: GrowP) => {
  const P = gs.paper
  return [P.x + (P.M + p[0] * P.S) * P.k, P.y + (P.M + p[1] * P.S) * P.k]
}
const pts = (ps: GrowP[]) => ps.map((p) => at(p).map((v) => v.toFixed(1)).join(',')).join(' ')
/** 米 → 屏幕像素 */
const px = (m: number) => m * gs.paper.S * gs.paper.k
/** 叠加层裁到图框里（图框外是纸边） */
const clip = computed(() => {
  const f = gs.paper.frame
  return f.w ? { clipPath: `inset(${f.y}px calc(100% - ${f.x + f.w}px) calc(100% - ${f.y + f.h}px) ${f.x}px)` } : undefined
})

const outline = (x: ReturnType<typeof G.selected>) => {
  if (x?.kind === 'plan') return { pts: pts(x.poly), closed: true }
  if (x?.kind === 'lot') return { pts: pts(x.lot.poly), closed: true }
  if (x?.kind === 'road') return { pts: pts(x.road.pts), closed: false }
  return null
}
/** 标出手动的东西：手动的路、手动摆的地块、拆空的地方。点按米记，平移、缩放只换外面的 transform（不重算这些点） */
const meters = (ps: GrowP[]) => ps.map((q) => `${q[0]},${q[1]}`).join(' ')
const hand = computed(() => {
  if (!gs.showHand) return null
  const s = gs.state
  return {
    roads: s.roads.filter((r) => !G.planned(r.id)).map((r) => ({ pts: meters(r.pts), w: ROAD_WIDTH[r.kind] + 2 })),
    lots: s.lots.filter((l) => l.ref === undefined && l.state !== 'vacant').map((l) => meters(l.poly)),
    cleared: (s.cleared ?? []).map(meters),
  }
})
const handTf = computed(() => {
  const P = gs.paper
  return `translate(${P.x + P.M * P.k} ${P.y + P.M * P.k}) scale(${P.S * P.k})`
})
const sel = computed(() => outline(G.selected()))
const hot = computed(() => outline(G.hovered()))
const preview = computed(() => gs.preview && { ...gs.preview, pts: pts(gs.preview.pts) })
const dots = computed(() => gs.draft.map(at))
const snap = computed(() => gs.snap && at(gs.snap))
const ghost = computed(() => gs.ghost && { pts: pts(gs.ghost.poly), ok: gs.ghost.ok, color: USE_COLOR[gs.buildUse] })
/** 地形笔刷：指针处的圈、画到一半的一笔 */
const brush = computed(() => {
  if (gs.tool !== 'terrain' || !gs.cursor) return null
  const [x, y] = at(gs.cursor)
  return { x, y, r: px(gs.brushR), color: BRUSH_COLOR[gs.brush] }
})
const stroke = computed(() => (gs.tool === 'terrain' && gs.free ? { pts: pts(gs.free), w: px(gs.brushR) * 2, color: BRUSH_COLOR[gs.brush], dot: gs.free.length === 1 ? at(gs.free[0]) : null } : null))
const tip = computed(() => {
  if (!gs.tip || !gs.cursor) return null
  const [x, y] = at(gs.cursor)
  return { ...gs.tip, style: { left: `${x + 16}px`, top: `${y + 18}px` } }
})

// —— 生成条 ——
/** 人口走到这张地图容量的几成 */
const progress = computed(() => Math.min(1, G.grownPop() / gs.state.plan!.horizon))
const stops = computed(() => G.targetStops())
/** 目标在刻度上的第几档（目标不在刻度上时取不小于它的那一档） */
const targetIdx = computed(() => {
  const i = stops.value.findIndex((v) => v >= gs.target)
  return i < 0 ? stops.value.length - 1 : i
})
const full = computed(() => G.full())
const targetLabel = computed(() => (targetIdx.value === stops.value.length - 1 ? t('长满') : `${stops.value[targetIdx.value].toLocaleString()} ${t('人')}`))
const onTarget = (e: Event, go: boolean) => G.setTarget(stops.value[Number((e.target as HTMLInputElement).value)], go)

const hint = computed(() => {
  if (gs.tool === 'road') return gs.draft.length ? '点下一个点 · 再点一下最后一个点或回车铺好 · 退格删点 · 右键取消' : '按住拖动随手画路，或一下一下点出折线 · 端点靠近已有的路会接上 · 过河自动架桥 · 生成时聚落从手画的路那儿长起'
  if (gs.tool === 'build') return '点一下摆一块，按住沿路拖动摆一排 · 地块自动贴到路边'
  if (gs.tool === 'terrain') return '按住拖动刷地形 · [ ] 调笔刷大小 · 松手后已长出的自动建筑按新地形重新布局'
  if (gs.tool === 'erase') return '点一下拆掉房子、田、手动的路 · 按住拖动连着拆 · 拆掉的地方空着，不再长回来 · 自动长出的路不能拆'
  return 'G 生成到目标人口 · 空格回放 · 点选地块、路 · 拖动平移 · 滚轮缩放 · Delete 拆掉选中的'
})
const pan = computed(() => (gs.tool === 'look' ? '' : '右键或中键拖动平移 · 右键点一下回到点选'))

// —— 新建地图 ——
const p = gs.setup
const SIZE_OPTS = computed(() =>
  G.SIZES.map(({ pop, name }) => ({ value: pop, label: `${t(name)} · ${t('约 {n} 人', { n: pop.toLocaleString() })}`, title: '地图越大，能长的人越多，规划也越久' })),
)
const CULTURE_OPTS = cultures.ids().map((c) => ({ value: c, label: cultures.get(c).name, title: cultures.get(c).desc }))
const LAND_OPTS = [
  { value: 'blank' as const, label: '空白平地', title: '没有河、海、山，也不起伏：从零画路、摆建筑，地形自己刷' },
  { value: 'random' as const, label: '按种子生成', title: '按种子生成的地形：河、海、山可选' },
]
const blankOf = () => (G.isBlank(p) ? 'blank' : 'random')
const land = ref<'blank' | 'random'>(blankOf())
watch(
  () => gs.creating,
  (v) => v && (land.value = blankOf()),
)
const envKeys = ['river', 'coast', 'hills'] as const
const envToggles = computed(() => [
  { label: '河流', on: p.river, title: '一条河穿过画幅' },
  { label: '临海', on: p.coast, title: '画幅一侧是海' },
  { label: '依山', on: p.hills, title: '画幅一侧是山' },
])
/** 头一回进来、还没有自己的一张时不给「取消」（当前这张是默认的那张，也照样能接着用） */
const canCancel = computed(() => gs.undoCount > 0 || gs.state.lots.length > 0 || gs.state.roads.some((r) => !G.planned(r.id)))
</script>

<template>
  <main class="stage">
    <div ref="host" class="view paper-view" :class="[`tool-${gs.tool}`]"></div>
    <svg class="grow-overlay" aria-hidden="true" :style="clip">
      <g v-if="hand" class="hand" :transform="handTf">
        <polyline v-for="(r, i) in hand.roads" :key="`r${i}`" :points="r.pts" :stroke-width="r.w" />
        <polygon v-for="(l, i) in hand.lots" :key="`l${i}`" :points="l" />
        <polygon v-for="(c, i) in hand.cleared" :key="`c${i}`" :points="c" class="cleared" />
      </g>
      <template v-if="sel">
        <polygon v-if="sel.closed" :points="sel.pts" class="sel" />
        <polyline v-else :points="sel.pts" class="sel" />
      </template>
      <template v-if="hot">
        <polygon v-if="hot.closed" :points="hot.pts" class="hot" :class="{ erase: gs.tool === 'erase' }" />
        <polyline v-else :points="hot.pts" class="hot" :class="{ erase: gs.tool === 'erase' }" />
      </template>
      <polyline v-if="preview" :points="preview.pts" class="draft" :class="{ bad: !preview.ok }" />
      <circle v-for="(d, i) in dots" :key="i" :cx="d[0]" :cy="d[1]" r="3.5" class="dot" />
      <circle v-if="snap" :cx="snap[0]" :cy="snap[1]" r="7" class="snap" />
      <polygon v-if="ghost" :points="ghost.pts" class="ghost" :class="{ bad: !ghost.ok }" :style="ghost.ok ? { fill: ghost.color, stroke: ghost.color } : undefined" />
      <template v-if="stroke">
        <circle v-if="stroke.dot" :cx="stroke.dot[0]" :cy="stroke.dot[1]" :r="stroke.w / 2" :fill="stroke.color" fill-opacity="0.35" />
        <polyline v-else :points="stroke.pts" fill="none" :stroke="stroke.color" :stroke-width="stroke.w" stroke-opacity="0.35" stroke-linecap="round" stroke-linejoin="round" />
      </template>
      <circle v-if="brush" :cx="brush.x" :cy="brush.y" :r="brush.r" class="brush" :stroke="brush.color" />
    </svg>
    <div v-if="tip" class="grow-tip" :class="{ bad: tip.bad }" :style="tip.style">{{ tip.text }}</div>
    <div class="neatline" aria-hidden="true"></div>

    <div v-if="gs.creating" class="grow-new-back" @pointerdown.self="canCancel && G.closeNewMap()">
      <form class="grow-new" @submit.prevent="G.createMap(land === 'blank')">
        <h3>{{ t('新建地图') }}</h3>
        <Field label="地形"><Seg :options="LAND_OPTS" :model-value="land" @update:model-value="(v) => (land = v)" /></Field>
        <template v-if="land === 'random'">
          <div class="seed">
            <input v-model="p.seed" spellcheck="false" autocomplete="off" :placeholder="t('输入种子')" :title="t('同一种子总是得到同一片地形')" />
            <button type="button" class="dice" :title="t('换一个随机种子')" @click="G.rollSeed()"><Icon :icon="IconDices" :size="14" />{{ t('随机') }}</button>
          </div>
          <Legend :items="envToggles" @toggle="(i) => (p[envKeys[i]] = !p[envKeys[i]])" />
          <Scale label="地形起伏" :min="0" :max="1" :step="0.05" :fmt="(x) => x.toFixed(2)" :reset="0.3" v-model="p.relief" />
        </template>
        <Field label="地图大小"><Seg :options="SIZE_OPTS" :model-value="p.horizon" @update:model-value="(v) => (p.horizon = v)" /></Field>
        <Field label="文明"><Seg :options="CULTURE_OPTS" :model-value="p.culture" @update:model-value="(v) => (p.culture = v)" /></Field>
        <p class="counter-note">{{ t('新建以后可以先画路、摆建筑、刷地形，再点「生成」让聚落从手画的路那儿长到目标人口；生成之后照样能手改，再接着生成。') }}</p>
        <div class="pair">
          <button type="submit" class="primary">{{ t('新建') }}</button>
          <button v-if="canCancel" type="button" @click="G.closeNewMap()">{{ t('继续当前这张') }}</button>
        </div>
      </form>
    </div>
    <div v-if="gs.msg" class="grow-msg" role="status" @click="gs.msg = ''">{{ gs.msg }}</div>
    <div v-else-if="gs.planning && !gs.loading" class="grow-msg grow-planning" role="status">{{ t('正在规划这片地：树林、田野稍后出现，现在就可以动手') }}</div>
    <Notices v-model="gs.notices" />

    <div class="grow-bar">
      <!-- 最上面一行：当前工具的选项（有的话） -->
      <div v-if="options.length" class="grow-opts" role="toolbar" :aria-label="t('选项')">
        <button v-for="(o, i) in options" :key="o.id" type="button" :class="{ on: o.on }" :aria-pressed="o.on" :title="`${t(o.label)}（${i + 1}）`" @click="G.pickOption(i)">
          <i v-if="o.color" :style="{ background: o.color }"></i><Icon v-if="o.icon" :icon="o.icon" :size="14" />{{ t(o.label) }}<kbd>{{ i + 1 }}</kbd>
        </button>
        <label v-if="gs.tool === 'terrain'" class="grow-size" :title="t('笔刷半径（[ ] 调节）')">
          <span>{{ t('大小') }}</span>
          <input type="range" :min="BRUSH_R.min" :max="BRUSH_R.max" :step="BRUSH_R.step" :value="gs.brushR" @input="G.setBrushR(Number(($event.target as HTMLInputElement).value))" />
          <output>{{ gs.brushR }} m</output>
        </label>
      </div>
      <!-- 生成条：任何工具下都在 -->
      <div class="grow-opts grow-gen" role="toolbar" :aria-label="t('生成')">
        <div class="grow-pop" :title="t('人口与这张地图能住下的人数')">
          <span><b>≈ {{ picture.population.toLocaleString() }}</b> / {{ gs.state.plan!.horizon.toLocaleString() }} {{ t('人') }}</span>
          <i><i :style="{ width: `${progress * 100}%` }"></i></i>
        </div>
        <label class="grow-size grow-target" :title="t('生成到多少人：拖到右边松手就接着长')">
          <span>{{ t('目标') }}</span>
          <input type="range" min="0" :max="stops.length - 1" step="1" :value="targetIdx" :disabled="gs.loading || gs.run === 'rush'" @input="onTarget($event, false)" @change="onTarget($event, true)" />
          <output>{{ targetLabel }}</output>
        </label>
        <button type="button" class="grow-go" :class="{ on: gs.run === 'rush' }" :disabled="gs.loading || (full && gs.run !== 'rush')" :title="t('一口气长到目标人口，记一步撤销（G）')" @click="G.generate()">
          <Icon :icon="gs.run === 'rush' ? IconPause : IconFastForward" :size="14" />{{ t(gs.run === 'rush' ? '停下' : '生成') }}<kbd>G</kbd>
        </button>
        <button type="button" :class="{ on: gs.run === 'replay' }" :disabled="gs.loading || gs.run === 'rush' || (full && gs.run !== 'replay')" :title="t('按步速一步步长，看它怎么长起来（空格）')" @click="G.toggle()">
          <Icon :icon="gs.run === 'replay' ? IconPause : IconPlay" :size="14" />{{ t(gs.run === 'replay' ? '暂停' : '回放') }}<kbd>␣</kbd>
        </button>
        <div v-if="gs.run === 'replay'" class="grow-speed" :title="t('每秒走几步')">
          <button v-for="v in G.SPEEDS" :key="v" type="button" :class="{ on: gs.speed === v }" :aria-pressed="gs.speed === v" @click="G.setSpeed(v)">{{ v }}</button>
          <span>{{ t('步/秒') }}</span>
        </div>
      </div>
      <div v-if="gs.run === 'idle' && G.reflow.value" class="grow-reflow" role="status">{{ t('手画的路会并入规划：再生成时已长出的 {n} 栋自动建筑会重新布局', { n: G.reflow.value }) }}</div>
      <div class="grow-tools" role="toolbar" :aria-label="t('工具')">
        <button v-for="tl in TOOLS" :key="tl.id" type="button" :class="{ on: gs.tool === tl.id }" :aria-pressed="gs.tool === tl.id" :title="`${t(tl.title)}（${TOOL_KEYS[tl.id]}）`" @click="G.setTool(tl.id)">
          <Icon :icon="tl.icon" :size="18" /><span>{{ t(tl.label) }}</span><kbd>{{ TOOL_KEYS[tl.id] }}</kbd>
        </button>
        <i class="sep" aria-hidden="true"></i>
        <button type="button" :class="{ on: gs.showHand }" :aria-pressed="gs.showHand" :title="t('标出手动画的路、摆的建筑和拆空的地方（H）')" @click="G.toggleHand()"><Icon :icon="IconHand" :size="18" /><span>{{ t('标出手动') }}</span><kbd>H</kbd></button>
        <i class="sep" aria-hidden="true"></i>
        <button type="button" :disabled="!gs.undoCount || gs.loading" :title="t('撤销（Ctrl+Z）')" @click="G.undo()"><Icon :icon="IconUndo" :size="18" /><span>{{ t('撤销') }}</span></button>
        <button type="button" :disabled="!gs.redoCount || gs.loading" :title="t('重做（Ctrl+Y）')" @click="G.redo()"><Icon :icon="IconRedo" :size="18" /><span>{{ t('重做') }}</span></button>
      </div>
      <div class="grow-hint">{{ t(hint) }}<template v-if="pan"> · {{ t(pan) }}</template></div>
    </div>
    <Loading :show="gs.loading" title="正在规划" stage="沿着地形和手画的路推演聚落怎么长" />
  </main>
</template>

<style scoped>
.paper-view.tool-road,
.paper-view.tool-build {
  cursor: crosshair;
}
.paper-view.tool-terrain {
  cursor: none;
}
.paper-view.tool-erase {
  cursor: pointer;
}
.grow-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
}
.sel {
  fill: none;
  stroke: var(--danger);
  stroke-width: 2.5;
  stroke-linejoin: round;
}
.hot {
  fill: rgba(30, 26, 21, 0.06);
  stroke: var(--ink);
  stroke-width: 1.5;
  stroke-linejoin: round;
}
polyline.hot {
  fill: none;
  stroke-width: 3;
  stroke-opacity: 0.55;
}
.hot.erase {
  fill: rgba(163, 65, 44, 0.22);
  stroke: var(--danger);
}
polyline.hot.erase {
  fill: none;
  stroke-width: 5;
}
/* 标出手动的东西：手动的路、地块描成强调色，拆空的地方画虚线 */
.hand polygon {
  vector-effect: non-scaling-stroke;
}
.hand polyline {
  fill: none;
  stroke: var(--accent);
  stroke-opacity: 0.45;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hand polygon {
  fill: var(--accent);
  fill-opacity: 0.22;
  stroke: var(--accent);
  stroke-width: 1.5;
}
.hand polygon.cleared {
  fill: none;
  stroke-dasharray: 3 3;
}
/* 路的预览：不行的时候是警示色 */
.draft {
  fill: none;
  stroke: var(--accent);
  stroke-width: 4;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-opacity: 0.85;
}
.draft.bad {
  stroke: var(--danger);
}
.dot {
  fill: var(--paper);
  stroke: var(--ink);
  stroke-width: 1.5;
}
.snap {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2.5;
}
.ghost {
  fill-opacity: 0.35;
  stroke-width: 2;
  stroke-linejoin: round;
}
.ghost.bad {
  fill: var(--danger);
  fill-opacity: 0.2;
  stroke: var(--danger);
  stroke-dasharray: 4 3;
}
.brush {
  fill: none;
  stroke-width: 2;
}
.grow-tip {
  position: absolute;
  z-index: 3;
  padding: 2px 7px;
  background: var(--paper);
  border: 1px solid var(--ink);
  color: var(--ink);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.grow-tip.bad {
  border-color: var(--danger);
  color: var(--danger);
}
.grow-msg {
  position: absolute;
  left: 50%;
  top: 24px;
  transform: translateX(-50%);
  z-index: 4;
  max-width: min(560px, 80%);
  padding: 6px 12px;
  background: var(--paper);
  border: 1px solid var(--ink);
  color: var(--ink);
  font-size: 12.5px;
  cursor: pointer;
}
.grow-planning {
  border-color: var(--rule-2);
  color: var(--ink-2);
  cursor: default;
  pointer-events: none;
}
/* 新建地图：盖住舞台的卡片 */
.grow-new-back {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(26, 24, 21, 0.35);
}
.grow-new {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(380px, 100%);
  max-height: 100%;
  overflow-y: auto;
  padding: 18px 20px 20px;
  background: var(--paper);
  border: 1px solid var(--ink);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.grow-new h3 {
  margin: 0;
  font-family: var(--cjk-serif);
  font-size: 17px;
  font-weight: 600;
}
.grow-new .counter-note {
  margin: 0;
}
.grow-new .pair {
  display: flex;
  gap: 8px;
}
.grow-new .pair button {
  flex: 1;
  padding: 8px 10px;
}
.grow-new .pair button:not(.primary) {
  border: 1px solid var(--rule-2);
}
/* 再生成会重新布局的提示 */
.grow-reflow {
  max-width: 100%;
  padding: 3px 10px;
  background: var(--paper);
  border: 1px solid var(--danger);
  color: var(--danger);
  font-size: 11.5px;
  pointer-events: auto;
}

/* 底部的工具栏：上面一行是当前工具的选项，中间是工具，下面一行是用法 */
.grow-bar {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: max-content;
  max-width: calc(100% - 24px);
  pointer-events: none;
}
.grow-tools,
.grow-opts {
  display: flex;
  align-items: stretch;
  max-width: 100%;
  background: var(--paper);
  border: 1px solid var(--ink);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  pointer-events: auto;
  overflow-x: auto;
}
.grow-tools button {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 62px;
  padding: 9px 10px 7px;
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
  transition:
    background 0.12s,
    color 0.12s;
}
.grow-tools button + button {
  border-left: 1px solid var(--rule);
}
.grow-tools button:hover:not(:disabled) {
  background: var(--paper-2);
  color: var(--ink);
}
.grow-tools button.on {
  background: var(--ink);
  color: var(--paper);
}
.grow-tools button:disabled {
  opacity: 0.35;
  cursor: default;
}
.grow-tools .sep {
  flex: none;
  width: 1px;
  background: var(--ink);
}
.grow-tools kbd {
  position: absolute;
  top: 3px;
  right: 5px;
  font-family: var(--ui);
  font-size: 9.5px;
  opacity: 0.5;
}
/* 生成条：人口进度、目标、生成、回放（回放时多出速度的几档） */
.grow-gen {
  align-items: center;
}
.grow-gen > button {
  align-self: stretch;
  border-left: 1px solid var(--rule);
}
.grow-gen > .grow-go {
  border-left-color: var(--ink);
  color: var(--ink);
  font-weight: 600;
}
.grow-gen > button:disabled {
  opacity: 0.35;
  cursor: default;
}
.grow-gen .grow-speed {
  align-self: stretch;
  border-left: 1px solid var(--rule);
}
.grow-gen .grow-pop {
  padding: 6px 12px;
  border-left: none;
}
.grow-target output {
  min-width: 64px;
}
.grow-speed,
.grow-pop {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
}
.grow-opts .grow-speed button {
  min-width: 34px;
  padding: 5px 6px;
  border: 1px solid var(--rule-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.grow-opts .grow-speed button + button {
  border-left: 1px solid var(--rule-2);
  margin-left: -1px;
}
.grow-opts .grow-speed button.on {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--paper);
}
.grow-speed span {
  margin-left: 8px;
}
.grow-pop {
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 5px;
  min-width: 150px;
  border-left: 1px solid var(--rule);
  font-variant-numeric: tabular-nums;
}
.grow-pop b {
  font-weight: 600;
  color: var(--ink);
}
.grow-pop > i {
  display: block;
  height: 4px;
  background: var(--paper-3);
}
.grow-pop > i > i {
  display: block;
  height: 100%;
  background: var(--accent);
}
.grow-opts button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  font-size: 12.5px;
  color: var(--ink-2);
  white-space: nowrap;
}
.grow-opts button + button {
  border-left: 1px solid var(--rule);
}
.grow-opts button:hover {
  background: var(--paper-2);
  color: var(--ink);
}
.grow-opts button.on {
  background: var(--ink);
  color: var(--paper);
}
.grow-opts button i {
  width: 9px;
  height: 9px;
  outline: 1px solid rgba(242, 236, 223, 0.5);
}
.grow-opts kbd {
  font-family: var(--ui);
  font-size: 9.5px;
  opacity: 0.5;
}
.grow-size {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-left: 1px solid var(--ink);
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
}
.grow-size input {
  width: 110px;
  accent-color: var(--ink);
}
.grow-size output {
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
/* 用法说明不撑宽工具栏：最宽和工具栏一样宽，放不下就折行 */
.grow-hint {
  box-sizing: border-box;
  width: 0;
  min-width: 100%;
  padding: 3px 10px;
  background: rgba(26, 24, 21, 0.72);
  color: rgba(242, 236, 223, 0.85);
  font-size: 11.5px;
  line-height: 1.5;
  text-align: center;
}
@media (max-width: 720px) {
  .grow-tools button {
    min-width: 50px;
    padding: 8px 6px 6px;
  }
  .grow-tools kbd,
  .grow-opts kbd {
    display: none;
  }
  .grow-hint {
    display: none;
  }
}
</style>
