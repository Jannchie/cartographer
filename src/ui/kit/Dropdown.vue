<script setup lang="ts" generic="V extends string | number">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'

/**
 * 下拉选择（自绘）：触发器是一条下划线式的字段；弹层挂到 body 上（不被面板的滚动区裁掉），
 * 下方空间不够时向上展开。每个选项可以带一行说明。
 * 键盘：↑ ↓ 移动，Home / End，Enter / Space 选中，Esc / Tab 关闭，按字母跳到首字母相同的项。
 * 当前值不在选项里时显示 placeholder（例如预设被手动改过参数后显示"自定义"）。
 */
const props = defineProps<{
  options: { value: V; label: string; desc?: string }[]
  modelValue: V | null
  placeholder?: string
  /** 选项文字已经是最终文本（例如地名列表），不再过翻译 */
  raw?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [v: V]; open: [] }>()

const trigger = ref<HTMLButtonElement>()
const list = ref<HTMLElement>()
const open = ref(false)
const active = ref(-1)
const pos = ref({ left: 0, top: 0, width: 0, up: false, maxH: 320 })
const uid = `dd-${Math.random().toString(36).slice(2, 8)}`

const tx = (s: string) => (props.raw ? s : t(s))
const current = computed(() => props.options.find((o) => o.value === props.modelValue))

function place() {
  const r = trigger.value!.getBoundingClientRect()
  const below = window.innerHeight - r.bottom - 12
  const above = r.top - 12
  const up = below < 220 && above > below
  pos.value = { left: r.left, top: up ? r.top - 4 : r.bottom + 4, width: Math.max(r.width, 200), up, maxH: Math.min(360, up ? above : below) }
}
function show() {
  if (open.value) return
  emit('open')
  place()
  open.value = true
  active.value = Math.max(0, props.options.findIndex((o) => o.value === props.modelValue))
  nextTick(scrollActive)
}
function hide(refocus = true) {
  if (!open.value) return
  open.value = false
  if (refocus) trigger.value?.focus({ preventScroll: true })
}
function choose(i: number) {
  const o = props.options[i]
  if (!o) return
  if (o.value !== props.modelValue) emit('update:modelValue', o.value)
  hide()
}
function scrollActive() {
  list.value?.querySelector<HTMLElement>(`[data-i="${active.value}"]`)?.scrollIntoView({ block: 'nearest' })
}
function move(d: number) {
  const n = props.options.length
  if (!n) return
  active.value = (active.value + d + n) % n
  nextTick(scrollActive)
}
let typed = ''
let typedAt = 0
function onKey(e: KeyboardEvent) {
  if (!open.value) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault()
      show()
    }
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      move(1)
      break
    case 'ArrowUp':
      move(-1)
      break
    case 'Home':
      active.value = 0
      nextTick(scrollActive)
      break
    case 'End':
      active.value = props.options.length - 1
      nextTick(scrollActive)
      break
    case 'Enter':
    case ' ':
      choose(active.value)
      break
    case 'Escape':
      hide()
      break
    case 'Tab':
      hide(false)
      return
    default:
      // 首字母跳转（连续输入可以拼成前缀）
      if (e.key.length === 1) {
        const now = performance.now()
        typed = now - typedAt < 700 ? typed + e.key.toLowerCase() : e.key.toLowerCase()
        typedAt = now
        const i = props.options.findIndex((o) => tx(o.label).toLowerCase().startsWith(typed))
        if (i >= 0) {
          active.value = i
          nextTick(scrollActive)
        }
      }
      return
  }
  e.preventDefault()
}

// 点在外面、窗口变化、面板滚动时收起
function outside(e: PointerEvent) {
  const el = e.target as Node
  if (trigger.value?.contains(el) || list.value?.contains(el)) return
  hide(false)
}
function onScroll(e: Event) {
  if (list.value?.contains(e.target as Node)) return
  hide(false)
}
watch(open, (v) => {
  if (v) {
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
  } else {
    window.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('resize', onScroll)
    window.removeEventListener('scroll', onScroll, true)
  }
})
onBeforeUnmount(() => (open.value = false))
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="dd"
    :class="{ open, empty: !current }"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="uid"
    :aria-activedescendant="open && active >= 0 ? `${uid}-${active}` : undefined"
    @click="open ? hide() : show()"
    @keydown="onKey"
  >
    <span>{{ current ? tx(current.label) : placeholder ? t(placeholder) : '' }}</span><i aria-hidden="true"></i>
  </button>
  <Teleport to="body">
    <Transition name="dd">
      <div
        v-if="open"
        :id="uid"
        ref="list"
        class="dd-list"
        :class="{ up: pos.up }"
        role="listbox"
        :style="{ left: `${pos.left}px`, top: `${pos.top}px`, minWidth: `${pos.width}px`, maxHeight: `${pos.maxH}px` }"
      >
        <div
          v-for="(o, i) in options"
          :id="`${uid}-${i}`"
          :key="o.value"
          :data-i="i"
          class="dd-item"
          :class="{ active: i === active, on: o.value === modelValue }"
          role="option"
          :aria-selected="o.value === modelValue"
          @pointerenter="active = i"
          @click="choose(i)"
        >
          <span class="dd-label">{{ tx(o.label) }}</span>
          <span v-if="o.desc" class="dd-desc">{{ tx(o.desc) }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
