/**
 * 录制页的通用部分。每个视频是一个页面（video/<name>/index.html），画面全部只取决于帧号，约定如下：
 *   window.__video.ready     数据与场景准备好之后为 true
 *   window.__video.frame(i)  画第 i 帧；video/record.ts 逐帧调用后截图，交给 ffmpeg 编码
 * 画面固定为 1920×1080（CSS 像素）：#stage 放全息沙盘，#overlay 为其上的 2D 叠加层。
 * 录制时页面的像素比为 2，截出 3840×2160。
 * 地址带 ?preview 时为浏览器里的实时预览：画面缩放到窗口里居中，底部有播放控制
 */

/** 画面尺寸（CSS 像素） */
export const W = 1920
export const H = 1080
export const SANS = '"HarmonyOS Sans SC", sans-serif'
export const MONO = '"Berkeley Mono", "HarmonyOS Sans SC", monospace'
export const PREVIEW = new URLSearchParams(location.search).has('preview')

declare global {
  interface Window {
    __video: { ready: boolean; frames: number; fps: number; frame: (i: number) => void; error?: string }
  }
}

/**
 * 启动录制页：加载字体，执行 setup（准备数据与场景，返回逐帧绘制函数），挂到 window.__video 上；
 * 预览模式下再加上播放控制。label 给出预览进度条旁显示的说明（例如当前年份）
 */
export function runVideo(opts: { fps: number; duration: number; setup: () => Promise<(i: number) => void>; label?: (sec: number) => string }) {
  const { fps, duration } = opts
  window.__video = { ready: false, frames: Math.round(duration * fps), fps, frame: () => {} }
  ;(async () => {
    await loadFonts()
    window.__video.frame = await opts.setup()
    window.__video.ready = true
    if (PREVIEW) startPreview(fps, duration, opts.label)
  })().catch((e) => {
    window.__video.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
    console.error(e)
  })
}

/** 全息沙盘的像素比：录制时至少 2（页面本身就是 2 倍，截出 4K，海面的点阵与等深线不闪）；预览时按屏幕 */
export function stagePixelRatio() {
  const dpr = window.devicePixelRatio || 1
  return PREVIEW ? dpr : Math.max(2, dpr)
}

/** 叠加层画布：按页面的像素比分配像素，绘制坐标仍是 CSS 像素 */
export function overlayContext() {
  const dpr = window.devicePixelRatio || 1
  const canvas = document.getElementById('overlay') as HTMLCanvasElement
  canvas.width = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  return { ctx, dpr }
}

/**
 * 字体：鸿蒙字体。先找本机已安装的字体（预览时用），找不到再从 /__fonts/ 读（录制脚本拦下这些请求，从本机的字体目录回文件）。
 * 全息沙盘里的地名与标注写的是 "Archivo" 与 "Noto Sans SC"，同样指到鸿蒙字体，整片字体统一。
 * 地名贴图在建场景时就画好了，字体要在那之前加载完
 */
async function loadFonts() {
  const faces: Promise<FontFace>[] = []
  for (const [name, weight] of [
    ['Regular', '400'],
    ['Medium', '500'],
    ['Bold', '700'],
  ]) {
    const src = [`local("HarmonyOS Sans SC ${name}")`, `local("HarmonyOS_Sans_SC_${name}")`, ...(name === 'Regular' ? ['local("HarmonyOS Sans SC")'] : []), `url("/__fonts/HarmonyOS_Sans_SC_${name}.ttf")`].join(', ')
    for (const fam of ['HarmonyOS Sans SC', 'Noto Sans SC', 'Archivo']) faces.push(new FontFace(fam, src, { weight }).load())
  }
  for (const f of await Promise.all(faces)) document.fonts.add(f)
  await Promise.all(['400 20px "Berkeley Mono"', '700 20px "Berkeley Mono"'].map((f) => document.fonts.load(f, '0123456789')))
}

/**
 * 浏览器里的实时预览：16:9 的画面缩放到窗口里居中，四周留黑，细框标出画面边界；底部一条播放控制。
 * 按墙上时间推进，渲染跟不上时跳帧。空格播放/暂停，←/→ 前后 5 秒，, / . 逐帧
 */
function startPreview(fps: number, duration: number, label?: (sec: number) => string) {
  const stage = document.getElementById('stage')!
  const overlay = document.getElementById('overlay')!
  const fit = () => {
    const k = Math.min(window.innerWidth / W, (window.innerHeight - 48) / H)
    const dx = (window.innerWidth - W * k) / 2
    const dy = (window.innerHeight - 48 - H * k) / 2
    for (const el of [stage, overlay]) {
      el.style.transformOrigin = '0 0'
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`
    }
    overlay.style.outline = `${1 / k}px solid #2a3a4e`
  }
  fit()
  window.addEventListener('resize', fit)
  const bar = document.createElement('div')
  bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;background:#05090f;color:#cfe0f2;font:13px ${MONO};z-index:10`
  const btn = document.createElement('button')
  btn.style.cssText = 'background:none;border:1px solid #4a6280;color:inherit;font:inherit;padding:4px 10px;cursor:pointer'
  const range = document.createElement('input')
  range.type = 'range'
  range.min = '0'
  range.max = String(Math.round(duration * fps) - 1)
  range.style.cssText = 'flex:1'
  const time = document.createElement('span')
  bar.append(btn, range, time)
  document.body.append(bar)
  const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
  let playing = true
  let cur = 0
  let last = performance.now()
  const show = () => {
    const i = Math.min(Math.round(duration * fps) - 1, Math.floor(cur * fps))
    window.__video.frame(i)
    range.value = String(i)
    btn.textContent = playing ? 'PAUSE' : 'PLAY'
    time.textContent = `${clock(cur)} / ${clock(duration)}${label ? `  ·  ${label(cur)}` : ''}`
  }
  btn.onclick = () => {
    playing = !playing
    last = performance.now()
    show()
  }
  range.oninput = () => {
    cur = Number(range.value) / fps
    show()
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault()
      btn.click()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') cur = Math.min(duration - 0.01, Math.max(0, cur + (e.key === 'ArrowLeft' ? -5 : 5)))
    else if (e.key === ',' || e.key === '.') {
      playing = false
      cur = Math.min(duration - 0.01, Math.max(0, cur + (e.key === ',' ? -1 : 1) / fps))
    } else return
    show()
  })
  const loop = (now: number) => {
    if (playing) {
      cur += (now - last) / 1000
      if (cur >= duration) cur = 0
      show()
    }
    last = now
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}
