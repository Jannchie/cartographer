/**
 * 快捷键是否该让位：焦点在输入框、下拉、滑块这类自己处理按键的控件上时，全局快捷键不响应。
 * （界面里的滑块、下拉是自绘的，用 role 标注）
 */
export function isTypingTarget(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  return !!el?.matches?.('input, select, textarea, [contenteditable], [role="slider"], [role="combobox"], [role="spinbutton"], [role="listbox"]')
}
