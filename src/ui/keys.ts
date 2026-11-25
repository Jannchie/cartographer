/**
 * 快捷键是否该让位：焦点在输入框、下拉、滑块这类自己处理按键的控件上时，全局快捷键不响应。
 * （界面里的滑块、下拉是自绘的，用 role 标注）
 */
export function isTypingTarget(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  return !!el?.matches?.('input, select, textarea, [contenteditable], [role="slider"], [role="combobox"], [role="spinbutton"], [role="listbox"]')
}

/** 3D 视图的导航键 → 动作（大小写、Shift 改出的 + / _ 都算同一个键） */
const NAV_KEYS: Record<string, string> = {
  ArrowUp: 'forward',
  w: 'forward',
  ArrowDown: 'back',
  s: 'back',
  ArrowLeft: 'left',
  a: 'left',
  ArrowRight: 'right',
  d: 'right',
  q: 'turnLeft',
  e: 'turnRight',
  PageUp: 'tiltUp',
  PageDown: 'tiltDown',
  '+': 'zoomIn',
  '=': 'zoomIn',
  '-': 'zoomOut',
  _: 'zoomOut',
}
export const navKey = (e: KeyboardEvent): string | undefined => NAV_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key]
