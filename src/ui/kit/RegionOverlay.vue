<script setup lang="ts" generic="R extends EditRegion">
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from 'vue'
import { inPoly } from '../../gen/areas'
import type { EditRegion } from './region'

/**
 * 区域编辑的叠加层（世界地图的海、大陆，聚落的命名区域共用）：挂在矢量查看器的宿主里，平移缩放照常由宿主处理。
 * - 全部区域画成细轮廓 + 很淡的填充（水域偏蓝、陆地偏绿），悬停加深；点一下选中（重叠处取最小的那个）
 * - 选中的区域：方块是顶点（拖动改形状，双击删除），圆点是边的中点（拖出一个新顶点），带名字的手柄是注记位置
 * 多边形按页面坐标画在随视图变换的组里（平移缩放只改变换）；手柄按屏幕坐标画，大小不随缩放变。
 * 区域的顶点与注记位置直接在传进来的对象上改；改动前后分别发 checkpoint（改动前的原样，供撤销）与 commit。
 */
const props = defineProps<{
  regions: R[]
  /** 名字、大小（重叠时先选小的）、是否水域、是否叠在陆地上的地形区（山脉、森林……，虚线描） */
  info: (r: R) => { label: string; size: number; water?: boolean; feature?: boolean }
  selected: string | null
  /** 视图：页面坐标 → 屏幕 = (x + 页面·k)；区域坐标 → 页面 = M + (坐标 + half)·S；frame 是露出地图的内框 */
  view: { x: number; y: number; k: number; M: number; S: number; half: number; frame: { x: number; y: number; w: number; h: number } }
}>()
const emit = defineEmits<{ select: [id: string | null]; checkpoint: [before: R[]]; commit: [] }>()

const root = ref<SVGSVGElement>()
const hover = ref<string | null>(null)
const V = computed(() => props.view)

const pg = (c: number) => V.value.M + (c + V.value.half) * V.value.S
const toLocal = (sx: number, sy: number): [number, number] => {
  const v = V.value
  return [(sx - v.x) / v.k / v.S - v.M / v.S - v.half, (sy - v.y) / v.k / v.S - v.M / v.S - v.half]
}
const toScreen = (c: [number, number]): [number, number] => [V.value.x + pg(c[0]) * V.value.k, V.value.y + pg(c[1]) * V.value.k]

// 多边形的点串只取决于顶点与 M、S、half（平移缩放只改组的变换，不重算）；区域信息（名字、大小）每个区域取一次
const pts = computed(() => {
  const { M, S, half } = V.value
  const at = (c: number) => (M + (c + half) * S).toFixed(1)
  return new Map(props.regions.map((a) => [a.id, a.poly.map(([x, y]) => `${at(x)},${at(y)}`).join(' ')]))
})
const infos = computed(() => new Map(props.regions.map((a) => [a.id, props.info(a)])))
const points = (a: R) => pts.value.get(a.id) ?? ''
const infoOf = (a: R) => infos.value.get(a.id) ?? props.info(a)
const sel = computed(() => props.regions.find((a) => a.id === props.selected) ?? null)
const ordered = computed(() => [...props.regions].sort((a, b) => +(a.id === props.selected) - +(b.id === props.selected) || infoOf(b).size - infoOf(a).size))
const clip = computed(() => {
  const f = V.value.frame
  const el = root.value
  const w = el?.clientWidth ?? 0
  const h = el?.clientHeight ?? 0
  return f.w ? `inset(${f.y}px ${Math.max(0, w - f.x - f.w)}px ${Math.max(0, h - f.y - f.h)}px ${f.x}px)` : 'none'
})
const handles = computed(() => (sel.value ? sel.value.poly.map((p) => toScreen(p)) : []))
const mids = computed(() => {
  const h = handles.value
  return h.map((p, i) => {
    const q = h[(i + 1) % h.length]
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number]
  })
})
const labelAt = computed(() => (sel.value ? toScreen(sel.value.at) : null))

function hit(sx: number, sy: number): string | null {
  const [x, y] = toLocal(sx, sy)
  let best: R | null = null
  let bs = Infinity
  for (const a of props.regions) {
    if (!inPoly(a.poly, x, y)) continue
    const s = infoOf(a).size
    if (s < bs) {
      best = a
      bs = s
    }
  }
  return best?.id ?? null
}
const local = (e: PointerEvent | MouseEvent) => {
  const r = root.value!.getBoundingClientRect()
  return [e.clientX - r.left, e.clientY - r.top] as const
}

// —— 点选（在宿主上听：拖动平移的照常平移，没拖动的算点击） ——
let down: { x: number; y: number } | null = null
function onHostDown(e: PointerEvent) {
  if (e.button !== 0) return
  down = { x: e.clientX, y: e.clientY }
}
function onHostUp(e: PointerEvent) {
  if (!down || drag) return
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
  down = null
  if (moved > 4) return
  const [sx, sy] = local(e)
  emit('select', hit(sx, sy))
}
let hoverRaf = 0
function onHostMove(e: PointerEvent) {
  cancelAnimationFrame(hoverRaf)
  hoverRaf = requestAnimationFrame(() => {
    if (!root.value) return
    const [sx, sy] = local(e)
    hover.value = hit(sx, sy)
  })
}

// —— 拖动手柄：顶点、新顶点（从边中点拖出）、注记位置 ——
const snapshot = () => structuredClone(toRaw(props.regions).map((r) => toRaw(r))) as R[]
let drag: { kind: 'vertex' | 'label'; i: number; changed: boolean; before: R[] } | null = null
function start(e: PointerEvent, kind: 'vertex' | 'mid' | 'label', i: number) {
  if (e.button !== 0 || !sel.value) return
  e.stopPropagation()
  e.preventDefault()
  // 原样先存着：真的拖动了才记进撤销（双击删顶点的第一下不算一次改动）
  const before = snapshot()
  const a = sel.value
  let idx = i
  if (kind === 'mid') {
    const p = a.poly[i]
    const q = a.poly[(i + 1) % a.poly.length]
    a.poly.splice(i + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])
    idx = i + 1
  }
  // 捕获指针：拖出手柄范围也继续跟着（合成的事件没有活动指针，捕获会抛错，照样能拖）
  try {
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  } catch {
    /* 没有活动指针 */
  }
  drag = { kind: kind === 'label' ? 'label' : 'vertex', i: idx, changed: kind === 'mid', before }
}
function move(e: PointerEvent) {
  if (!drag || !sel.value) return
  const [sx, sy] = local(e)
  const c = toLocal(sx, sy)
  if (drag.kind === 'label') sel.value.at = c
  else sel.value.poly[drag.i] = c
  drag.changed = true
}
function end() {
  if (!drag) return
  const { changed, before } = drag
  drag = null
  if (!changed) return
  emit('checkpoint', before)
  emit('commit')
}
/** 双击顶点删掉它（至少留三个） */
function removeVertex(i: number) {
  const a = sel.value
  if (!a || a.poly.length <= 3) return
  emit('checkpoint', snapshot())
  a.poly.splice(i, 1)
  emit('commit')
}

let host: HTMLElement | null = null
onMounted(() => {
  host = root.value!.parentElement
  host?.addEventListener('pointerdown', onHostDown)
  host?.addEventListener('pointerup', onHostUp)
  host?.addEventListener('pointermove', onHostMove)
})
onBeforeUnmount(() => {
  host?.removeEventListener('pointerdown', onHostDown)
  host?.removeEventListener('pointerup', onHostUp)
  host?.removeEventListener('pointermove', onHostMove)
  cancelAnimationFrame(hoverRaf)
})
</script>

<template>
  <svg ref="root" class="area-overlay" :style="{ clipPath: clip }">
    <g :transform="`translate(${V.x} ${V.y}) scale(${V.k})`">
      <polygon
        v-for="a in ordered"
        :key="a.id"
        :points="points(a)"
        class="area-poly"
        :class="{ water: infoOf(a).water, feature: infoOf(a).feature, sel: a.id === selected, hover: a.id === hover }"
        vector-effect="non-scaling-stroke"
      />
      <!-- 选中的区域再描一遍：纸色衬底 + 强调色粗线，压在任何底色上都看得清 -->
      <template v-if="sel">
        <polygon :points="points(sel)" class="area-sel-halo" vector-effect="non-scaling-stroke" />
        <polygon :points="points(sel)" class="area-sel-line" vector-effect="non-scaling-stroke" />
      </template>
    </g>
    <template v-if="sel">
      <circle v-for="(m, i) in mids" :key="'m' + i" class="area-mid" :cx="m[0]" :cy="m[1]" r="3.5" @pointerdown="start($event, 'mid', i)" @pointermove="move" @pointerup="end" @pointercancel="end" />
      <rect
        v-for="(h, i) in handles"
        :key="'v' + i"
        class="area-vertex"
        :x="h[0] - 4.5"
        :y="h[1] - 4.5"
        width="9"
        height="9"
        @pointerdown="start($event, 'vertex', i)"
        @pointermove="move"
        @pointerup="end"
        @pointercancel="end"
        @dblclick.stop="removeVertex(i)"
      />
      <g v-if="labelAt" class="area-label" :transform="`translate(${labelAt[0]} ${labelAt[1]})`" @pointerdown="start($event, 'label', 0)" @pointermove="move" @pointerup="end" @pointercancel="end">
        <circle r="6" />
        <text x="10" y="4">{{ infoOf(sel!).label }}</text>
      </g>
    </template>
  </svg>
</template>
