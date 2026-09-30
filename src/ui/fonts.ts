// 地图字体（中日文衬线/无衬线、Cormorant、马善政等）的样式表体积大（上千条 @font-face），不放进 index.html 阻塞首屏：
// 模块加载时插入 <link>（index.html 里已 preload），量字、排注记之前 await mapFontsReady()。
// document.fonts.load 在 @font-face 规则还没到时会直接以空结果返回，所以必须先等样式表本身加载完。

const MAP_FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=IM+Fell+English+SC&family=Ma+Shan+Zheng&family=Noto+Serif+SC:wght@400;600&family=Noto+Sans+SC:wght@400;600&family=Noto+Serif+JP:wght@400;600&family=Noto+Sans+JP:wght@400;600&family=Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400&display=swap'

let ready: Promise<void> | null = null

/** 地图字体样式表加载完成（失败也放行，按回退字体排版） */
export function mapFontsReady(): Promise<void> {
  if (ready) return ready
  ready = new Promise<void>((resolve) => {
    if (typeof document === 'undefined') return resolve()
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = MAP_FONT_CSS
    link.onload = link.onerror = () => resolve()
    document.head.appendChild(link)
  })
  return ready
}

void mapFontsReady()
