<script setup lang="ts">
import { IconPlay, IconStop } from '@jannchie/icons'
import { computed, ref } from 'vue'
import { sizeLabel } from '../../settlement/scale'
import { t } from '../i18n'
import Icon from '../kit/Icon.vue'
import { playGrowth, seek, ss } from './settlement'

/**
 * 成长时间轴：当前这座城的成长史，横轴是对数人口（从几十人到生成时的目标人口）。
 * 点击或拖动穿梭到那个时刻；← → 一步，Shift 十步，Home / End 到两端；播放键（或空格）从当前时刻播到最后。
 * 刻度标出规模档位的分界（村镇、城镇、城市、大都会从哪里开始）。
 */
const tl = ss.timeline
const lmin = computed(() => Math.log(tl.from))
const lspan = computed(() => Math.log(tl.until) - lmin.value || 1)
const frac = (pop: number) => Math.min(1, Math.max(0, (Math.log(pop) - lmin.value) / lspan.value))
const popAt = (f: number) => Math.exp(lmin.value + f * lspan.value)
const pos = computed(() => frac(tl.at) * 100)
/** 档位分界：只列落在这段历史里的 */
const MARKS = [80, 1500, 7000, 30000]
const marks = computed(() => MARKS.filter((p) => p > tl.from && p < tl.until).map((p) => ({ pos: frac(p) * 100, label: sizeLabel(p) })))
const reading = computed(() => `${tl.at.toLocaleString()} ${t('人')} · ${t(sizeLabel(tl.at))}`)

const track = ref<HTMLElement>()
const dragging = ref(false)
function seekAt(clientX: number) {
  const r = track.value!.getBoundingClientRect()
  void seek(popAt((clientX - r.left) / r.width))
}
function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  ss.growing = false
  track.value!.setPointerCapture(e.pointerId)
  track.value!.focus({ preventScroll: true })
  dragging.value = true
  seekAt(e.clientX)
}
function onMove(e: PointerEvent) {
  if (dragging.value) seekAt(e.clientX)
}
function onUp() {
  dragging.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === ' ') {
    e.preventDefault()
    void playGrowth()
    return
  }
  const step = e.shiftKey ? 0.1 : 0.01
  const f = frac(tl.at)
  const to: Record<string, number> = { ArrowLeft: popAt(f - step), ArrowDown: popAt(f - step), ArrowRight: popAt(f + step), ArrowUp: popAt(f + step), Home: tl.from, End: tl.until }
  if (!(e.key in to)) return
  e.preventDefault()
  ss.growing = false
  void seek(to[e.key])
}
</script>

<template>
  <div v-if="tl.until > tl.from" class="timeline" :class="{ dragging }">
    <button type="button" class="tl-play" :class="{ on: ss.growing }" :title="t(ss.growing ? '停止' : '从时间轴上的当前时刻播放城市的成长')" @click="playGrowth()">
      <Icon :icon="ss.growing ? IconStop : IconPlay" :size="14" />
    </button>
    <div
      ref="track"
      class="tl-track"
      role="slider"
      tabindex="0"
      :aria-label="t('成长时间轴')"
      :aria-valuemin="tl.from"
      :aria-valuemax="tl.until"
      :aria-valuenow="tl.at"
      :aria-valuetext="reading"
      :title="t('点击或拖动，回到城市成长的那个时刻')"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @lostpointercapture="onUp"
      @keydown="onKey"
    >
      <i class="tl-rail"></i>
      <i class="tl-fill" :style="{ width: `${pos}%` }"></i>
      <span v-for="m in marks" :key="m.label" class="tl-mark" :style="{ left: `${m.pos}%` }">{{ t(m.label) }}</span>
      <i class="tl-thumb" :style="{ left: `${pos}%` }"></i>
    </div>
    <output class="tl-read">{{ reading }}</output>
  </div>
</template>
