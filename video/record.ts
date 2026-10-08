/**
 * 录制视频页（video/<名称>/index.html，逐帧约定见 shared/page.ts）：3840×2160，帧率与时长由页面给出。
 * 字体用鸿蒙字体（HarmonyOS_Sans_SC_{Regular,Medium,Bold}.ttf），默认取 Windows 用户字体目录。
 *
 *   pnpm tsx video/record.ts <名称> <out.mp4> [--audio=配乐.wav] [--query=theme=red] [--fonts=鸿蒙字体目录] [--from=帧] [--to=帧]
 *   pnpm tsx video/record.ts <名称> <目录> --stills=帧,帧,…    # 只截这几帧（JPEG），检查用
 *
 * 脚本自己起一个 Vite 开发服务器，用本机的 Chrome（puppeteer-core，GPU 渲染）打开视频页，
 * 逐帧调用 window.__video.frame(i) 后截图，JPEG 直接喂给 ffmpeg（需要系统里有 ffmpeg；有 NVIDIA 显卡时用 NVENC 编码）。
 * --query 原样加在页面地址后面（各视频页自己的参数，例如主题色）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const [PAGE, OUT] = args.filter((a) => !a.startsWith('--'))
if (!PAGE || !OUT || !existsSync(`video/${PAGE}/index.html`)) throw new Error('用法：tsx video/record.ts <视频名称（video/ 下的目录）> <输出>')
const AUDIO = flag('audio')
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
if (!CHROME) throw new Error('找不到 Chrome')

const FONTS = (flag('fonts') ?? `${process.env.LOCALAPPDATA}/Microsoft/Windows/Fonts`).replace(/\\/g, '/')
if (!existsSync(`${FONTS}/HarmonyOS_Sans_SC_Regular.ttf`)) throw new Error(`字体目录里没有鸿蒙字体：${FONTS}`)
const server = await createServer({ server: { port: 5198, strictPort: false }, logLevel: 'warn' })
await server.listen()
const query = flag('query')
const url = `${server.resolvedUrls!.local[0]}video/${PAGE}/index.html${query ? `?${query}` : ''}`
console.log('录制页', url)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--window-size=1920,1080'],
  // 页面按 2 倍像素比渲染：截出 3840×2160
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
  protocolTimeout: 600_000,
})
const page = await browser.newPage()
page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()))
// 录制页的字体请求（/__fonts/<文件名>）由本机的字体目录回
await page.setRequestInterception(true)
page.on('request', (req) => {
  const m = /\/__fonts\/([^/?#]+)$/.exec(req.url())
  if (!m) return void req.continue()
  const file = `${FONTS}/${decodeURIComponent(m[1])}`
  if (!existsSync(file)) return void req.respond({ status: 404 })
  void req.respond({ status: 200, contentType: 'font/ttf', body: readFileSync(file) })
})
await page.goto(url, { waitUntil: 'load' })
await page.waitForFunction(() => window.__video?.ready || window.__video?.error, { timeout: 600_000, polling: 500 })
const err = await page.evaluate(() => window.__video.error)
if (err) throw new Error(err)
const { frames, fps } = await page.evaluate(() => ({ frames: window.__video.frames, fps: window.__video.fps }))
const stills = flag('stills')
if (stills) {
  mkdirSync(OUT, { recursive: true })
  for (const i of stills.split(',').map(Number)) {
    await page.evaluate((k) => window.__video.frame(k), i)
    writeFileSync(`${OUT}/${String(i).padStart(4, '0')}.jpg`, await page.screenshot({ type: 'jpeg', quality: 92 }))
    console.log('截图', i)
  }
  await browser.close()
  await server.close()
  process.exit(0)
}
const from = Number(flag('from') ?? 0)
const to = Math.min(frames, Number(flag('to') ?? frames))
console.log(`共 ${frames} 帧，录制 ${from}–${to - 1}`)

const nvenc = await new Promise<boolean>((resolve) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-encoders'])
  let s = ''
  p.stdout.on('data', (d) => (s += d))
  p.on('close', () => resolve(s.includes('h264_nvenc')))
})
const enc = nvenc ? ['-c:v', 'h264_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '16', '-b:v', '0', '-maxrate', '120M'] : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16']
const ff = spawn(
  'ffmpeg',
  [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
    ...(AUDIO ? ['-i', AUDIO, '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    ...enc, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
)
const t0 = performance.now()
for (let i = from; i < to; i++) {
  await page.evaluate((k) => window.__video.frame(k), i)
  const jpg = await page.screenshot({ type: 'jpeg', quality: 97, clip: { x: 0, y: 0, width: 1920, height: 1080 } })
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r))
  if (i % 30 === 0) {
    const done = i - from + 1
    const eta = ((performance.now() - t0) / done) * (to - from - done)
    console.log(`帧 ${i}/${to - 1}（约剩 ${Math.round(eta / 1000)} 秒）`)
  }
}
ff.stdin.end()
await new Promise((r) => ff.on('close', r))
await browser.close()
await server.close()
console.log(`完成：${OUT}（${((performance.now() - t0) / 1000).toFixed(0)} 秒）`)
