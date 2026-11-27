<script setup lang="ts">
import {
  IconArrowDown, IconArrowUp, IconCursor, IconDroplet, IconDropletOff, IconEqual, IconEraser, IconHome, IconMountain, IconPause, IconPlay, IconRedo, IconRoute, IconSkipForward, IconUndo,
  type Icon as IconDef,
} from '@jannchie/icons'
import { computed, onMounted, ref } from 'vue'
import type { GrowBrush, GrowP } from '../../settlement/grow'
import { t } from '../i18n'
import Icon from '../kit/Icon.vue'
import Loading from '../kit/Loading.vue'
import Notices from '../kit/Notices.vue'
import * as G from './grow'
import { BRUSH_COLOR, BRUSH_NAME, BRUSH_R, gs, picture, ROAD_NAME, TOOL_KEYS, USE_COLOR, USE_NAME, type GrowTool } from './grow'

const host = ref<HTMLElement>()
onMounted(() => G.mountGrow(host.value!))

// —— 工具栏 ——
const TOOLS: { id: GrowTool; label: string; icon: IconDef<string>; title: string }[] = [
  { id: 'look', label: '点选', icon: IconCursor, title: '点选地块、路；拖动平移' },
  { id: 'road', label: '道路', icon: IconRoute, title: '按住拖动随手画一条路，或一下一下点出折线' },
  { id: 'build', label: '建筑', icon: IconHome, title: '沿路摆地块：点一下摆一块，按住拖动摆一排' },
  { id: 'terrain', label: '地形', icon: IconMountain, title: '用笔刷改地形：抬高、压低、平整、挖水、填陆；聚落按改过的地形重新规划' },
  { id: 'erase', label: '拆除', icon: IconEraser, title: '点一下拆掉手动的地块、路，退掉规划的地块；按住拖动连着拆' },
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
  if (x?.kind === 'lot') return { pts: pts(x.lot.poly), closed: true }
  if (x?.kind === 'road') return { pts: pts(x.road.pts), closed: false }
  return null
}
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

/** 人口走到规划规模的几成 */
const progress = computed(() => Math.min(1, gs.state.plan!.pop / gs.state.plan!.horizon))
const hint = computed(() => {
  if (gs.tool === 'road') return gs.draft.length ? '点下一个点 · 再点一下最后一个点或回车铺好 · 退格删点 · 右键取消' : '按住拖动随手画路，或一下一下点出折线 · 端点靠近已有的路会接上 · 过河自动架桥 · 路压到的规划的房子会让开'
  if (gs.tool === 'build') return '点一下摆一块，按住沿路拖动摆一排 · 地块自动贴到路边（规划的路、手动的路都行）'
  if (gs.tool === 'terrain') return '按住拖动刷地形 · [ ] 调笔刷大小 · 松手后聚落按改过的地形重新规划'
  if (gs.tool === 'erase') return '点一下拆掉手动的地块、路，退掉规划的地块 · 按住拖动连着拆 · 规划的路不能拆'
  return '空格播放，聚落按规划一步步长 · 点选地块、路 · 拖动平移 · 滚轮缩放 · N 走一步 · Delete 拆掉选中的'
})
const pan = computed(() => (gs.tool === 'look' ? '' : '右键或中键拖动平移 · 右键点一下回到点选'))
/** 刚开局、还没有人也没动过手的时候的引导 */
const wild = computed(() => !gs.loading && !gs.playing && gs.tool === 'look' && !gs.state.lots.length && gs.state.roads.every((r) => G.planned(r.id)))
</script>

<template>
  <main class="stage">
    <div ref="host" class="view paper-view" :class="[`tool-${gs.tool}`]"></div>
    <svg class="grow-overlay" aria-hidden="true" :style="clip">
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

    <div v-if="wild" class="grow-empty">
      <h3>{{ t('一片荒地') }}</h3>
      <p>{{ t('这片地已经按 {n} 人的规模规划好了。点「播放」，住户一户户搬来，田野、街巷、地标随着人口出现；也可以先自己画路、摆建筑、改地形。', { n: gs.state.plan!.horizon.toLocaleString() }) }}</p>
      <div class="pair">
        <button type="button" @click="G.play()"><Icon :icon="IconPlay" :size="14" />{{ t('播放') }}</button>
        <button type="button" @click="G.setTool('road')"><Icon :icon="IconRoute" :size="14" />{{ t('开始画路') }}</button>
      </div>
    </div>
    <div v-if="gs.msg" class="grow-msg" role="status" @click="gs.msg = ''">{{ gs.msg }}</div>
    <Notices v-model="gs.notices" />

    <div class="grow-bar">
      <!-- 上面一行：当前工具的选项；点选工具下是播放的速度与人口的进度 -->
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
      <div v-else-if="gs.tool === 'look'" class="grow-opts grow-time">
        <div class="grow-speed" :title="t('每秒走几步')">
          <button v-for="v in G.SPEEDS" :key="v" type="button" :class="{ on: gs.speed === v }" :aria-pressed="gs.speed === v" @click="G.setSpeed(v)">{{ v }}</button>
          <span>{{ t('步/秒') }}</span>
        </div>
        <div class="grow-pop" :title="t('人口走到规划规模的几成：住满以后不再长')">
          <span><b>≈ {{ picture.population.toLocaleString() }}</b> / {{ gs.state.plan!.horizon.toLocaleString() }} {{ t('人') }}</span>
          <i><i :style="{ width: `${progress * 100}%` }"></i></i>
        </div>
      </div>
      <div class="grow-tools" role="toolbar" :aria-label="t('工具')">
        <button v-for="tl in TOOLS" :key="tl.id" type="button" :class="{ on: gs.tool === tl.id }" :aria-pressed="gs.tool === tl.id" :title="`${t(tl.title)}（${TOOL_KEYS[tl.id]}）`" @click="G.setTool(tl.id)">
          <Icon :icon="tl.icon" :size="18" /><span>{{ t(tl.label) }}</span><kbd>{{ TOOL_KEYS[tl.id] }}</kbd>
        </button>
        <i class="sep" aria-hidden="true"></i>
        <button type="button" :class="{ on: gs.playing }" :disabled="gs.loading" :title="t('按需求序列连续生长（空格）')" @click="G.toggle()">
          <Icon :icon="gs.playing ? IconPause : IconPlay" :size="18" /><span>{{ t(gs.playing ? '暂停' : '播放') }}</span><kbd>␣</kbd>
        </button>
        <button type="button" :disabled="gs.loading" :title="t('按需求序列走一步（N）')" @click="G.step()"><Icon :icon="IconSkipForward" :size="18" /><span>{{ t('走一步') }}</span><kbd>N</kbd></button>
        <i class="sep" aria-hidden="true"></i>
        <button type="button" :disabled="!gs.undoCount || gs.loading" :title="t('撤销（Ctrl+Z）')" @click="G.undo()"><Icon :icon="IconUndo" :size="18" /><span>{{ t('撤销') }}</span></button>
        <button type="button" :disabled="!gs.redoCount || gs.loading" :title="t('重做（Ctrl+Y）')" @click="G.redo()"><Icon :icon="IconRedo" :size="18" /><span>{{ t('重做') }}</span></button>
      </div>
      <div class="grow-hint">{{ t(hint) }}<template v-if="pan"> · {{ t(pan) }}</template></div>
    </div>
    <Loading :show="gs.loading" title="正在规划" stage="这片地按规划的规模推演一遍成长史" />
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
.grow-empty {
  position: absolute;
  left: 50%;
  top: 38%;
  transform: translate(-50%, -50%);
  z-index: 3;
  width: min(320px, 80%);
  padding: 18px 20px 20px;
  background: var(--paper);
  border: 1px solid var(--ink);
  text-align: center;
}
.grow-empty h3 {
  margin: 0 0 6px;
  font-family: var(--cjk-serif);
  font-size: 17px;
  font-weight: 600;
}
.grow-empty p {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
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
/* 点选工具下的选项行：播放速度的几档、人口走到规划规模的进度 */
.grow-time {
  padding: 5px 0;
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
