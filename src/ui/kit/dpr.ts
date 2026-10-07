import { ref } from 'vue'

/** 设备像素比：浏览器缩放或拖到别的显示器时会变，图标据此重新做像素对齐 */
export const dpr = ref(window.devicePixelRatio || 1)

function watchDpr() {
  const mq = window.matchMedia(`(resolution: ${dpr.value}dppx)`)
  mq.addEventListener(
    'change',
    () => {
      dpr.value = window.devicePixelRatio || 1
      watchDpr()
    },
    { once: true },
  )
}
watchDpr()
