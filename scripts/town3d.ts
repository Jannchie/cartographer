/**
 * 聚落沙盘截图与帧耗时实测：用本机的 Chrome（GPU 渲染）打开检查页（scripts/town3d/），按机位逐张截图。
 *
 *   pnpm tsx scripts/town3d.ts <输出目录> [聚落参数 key=value ...] [--view=机位 ...] [--size=1600x1000] [--perf] [--port=5191]
 *
 * 聚落参数同聚落模块的地址参数（seed、population、culture、capital=1、coast=1、hills=1、plan=…），
 * 另有 time（时刻）、quality、dof、haze、stage、labels、ground、pop（时间轴上的人口）。
 * 机位：
 *   预设名   overview（整城斜俯）、north / east / south / west（四向低角度）、top（正俯视）、
 *            street（城心街巷近景）、roofs（城心屋顶中景）、landmark（最大的宗教建筑）、keep、gate、bridge、wall、edge（沙盘边缘）、trees、water
 *   自定     x,z,dist,azimuth,pitch（米与度；azimuth 0 为从南向北看，pitch 90 为正俯视），可加 :名字
 * 不给 --view 时截一组默认机位。--perf 另外实测每个机位移动中一帧的耗时。
 * 截图文件名：<文明>-<种子>-<机位>.png；同时打印聚落概况（建筑数、三角形数、各阶段耗时）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const rest = args.filter((a) => !a.startsWith('--'))
const flag = (k: string) => flags.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const OUT = rest[0]
if (!OUT) throw new Error('用法：tsx scripts/town3d.ts <输出目录> [key=value ...] [--view=…]')
const query = new URLSearchParams()
for (const kv of rest.slice(1)) {
  const i = kv.indexOf('=')
  query.set(kv.slice(0, i), kv.slice(i + 1))
}
if (!query.has('seed')) query.set('seed', 'thornwick')
const [VW, VH] = (flag('size') ?? '1600x1000').split('x').map(Number)
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
if (!CHROME) throw new Error('找不到 Chrome')

const server = await createServer({ server: { port: Number(flag('port') ?? 5191), strictPort: false }, logLevel: 'warn' })
await server.listen()
const url = `${server.resolvedUrls!.local[0]}scripts/town3d/index.html?${query}`
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', `--window-size=${VW},${VH}`],
  defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 },
  protocolTimeout: 600_000,
})
let code = 0
try {
  const page = await browser.newPage()
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && console.error(`[page ${m.type()}]`, m.text()))
  page.on('pageerror', (e) => console.error('[page error]', e))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__shot?.ready || window.__shot?.error', { timeout: 600_000, polling: 200 })
  const err = await page.evaluate('window.__shot.error')
  if (err) throw new Error(String(err))
  const info = (await page.evaluate('window.__shot.info')) as Info
  console.log(
    `${info.name} · ${info.width}×${info.height} 米 · 人口 ${info.pop} · 建筑 ${info.buildings} · 体块三角形 ${(info.tris / 1000).toFixed(0)}k · 树 ${info.trees.map((t) => `${t[0]} ${t[1]}`).join(' / ')}`,
  )
  console.log(`成长史 ${info.ms.history.toFixed(0)} ms · 体块 ${info.ms.build.toFixed(0)} ms · 场景 ${info.ms.scene.toFixed(0)} ms · 地面重画 ${info.ms.paint.map((x: number) => x.toFixed(0)).join(' / ')} ms · 类别 ${JSON.stringify(info.kinds)}`)

  const W = info.width
  const D = info.height
  const mid: [number, number] = [W / 2, D / 2]
  const of = (k: string, i = 0): [number, number] => (info.big[k]?.[i]?.p as [number, number]) ?? mid
  const core = info.landmarks.find((l) => l.kind === 'market')?.p ?? mid
  const first = (a: number[][], d: [number, number]) => (a[0] as [number, number]) ?? d
  type View = { name: string; x: number; z: number; dist: number; azimuth: number; pitch: number }
  const PRESET: Record<string, () => Omit<View, 'name'>> = {
    overview: () => ({ x: mid[0], z: mid[1], dist: W * 0.95, azimuth: 20, pitch: 38 }),
    north: () => ({ x: mid[0], z: mid[1], dist: W * 0.7, azimuth: 180, pitch: 16 }),
    east: () => ({ x: mid[0], z: mid[1], dist: W * 0.7, azimuth: 90, pitch: 16 }),
    south: () => ({ x: mid[0], z: mid[1], dist: W * 0.7, azimuth: 0, pitch: 16 }),
    west: () => ({ x: mid[0], z: mid[1], dist: W * 0.7, azimuth: 270, pitch: 16 }),
    top: () => ({ x: mid[0], z: mid[1], dist: W * 0.9, azimuth: 0, pitch: 89 }),
    street: () => ({ x: core[0], z: core[1], dist: 45, azimuth: 35, pitch: 14 }),
    roofs: () => ({ x: core[0], z: core[1], dist: 160, azimuth: 130, pitch: 32 }),
    landmark: () => ({ x: of('temple')[0], z: of('temple')[1], dist: 150, azimuth: 40, pitch: 22 }),
    keep: () => ({ x: of('keep')[0], z: of('keep')[1], dist: 170, azimuth: 300, pitch: 24 }),
    gate: () => ({ x: first(info.gates, mid)[0], z: first(info.gates, mid)[1], dist: 70, azimuth: 200, pitch: 15 }),
    bridge: () => ({ x: first(info.bridges, mid)[0], z: first(info.bridges, mid)[1], dist: 75, azimuth: 60, pitch: 18 }),
    wall: () => ({ x: first(info.gates, mid)[0], z: first(info.gates, mid)[1], dist: 220, azimuth: 110, pitch: 28 }),
    edge: () => ({ x: W * 0.06, z: D * 0.9, dist: 260, azimuth: 315, pitch: 12 }),
    trees: () => ({ x: W * 0.2, z: D * 0.25, dist: 90, azimuth: 70, pitch: 20 }),
    water: () => ({ x: first(info.piers, first(info.bridges, mid))[0], z: first(info.piers, first(info.bridges, mid))[1], dist: 110, azimuth: 150, pitch: 20 }),
  }
  // --info：打印构筑物与小品的位置（挑机位用）
  if (flags.includes('--info')) console.log(JSON.stringify({ works: info.works, landmarks: info.landmarks }, (_, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)))
  // 城门的机位：gateout#i 从城外正对第 i 座城门，gatein#i 从城里看，gatelow#i 贴近地面穿门洞看
  const gateView = (i: number, turn: number, dist: number, pitch: number) => {
    const g = info.works.gates[i] ?? { p: mid, out: 0 }
    return { x: g.p[0], z: g.p[1], dist, azimuth: g.out + turn, pitch }
  }
  const INDEXED: Record<string, (i: number) => Omit<View, 'name'>> = {
    gateout: (i) => gateView(i, 25, 62, 13),
    gatein: (i) => gateView(i, 205, 62, 16),
    gatelow: (i) => gateView(i, 4, 30, 4),
    gatetop: (i) => gateView(i, 40, 80, 50),
    cross: (i) => {
      const c = info.works.crossings[i]
      if (!c) return PRESET.bridge()
      const az = (Math.atan2(c.b[0] - c.a[0], c.b[1] - c.a[1]) * 180) / Math.PI
      return { x: (c.a[0] + c.b[0]) / 2, z: (c.a[1] + c.b[1]) / 2, dist: 28 + Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]) * 1.1, azimuth: az + 62, pitch: 12 }
    },
    crosslow: (i) => {
      const c = info.works.crossings[i]
      if (!c) return PRESET.bridge()
      const az = (Math.atan2(c.b[0] - c.a[0], c.b[1] - c.a[1]) * 180) / Math.PI
      return { x: (c.a[0] + c.b[0]) / 2, z: (c.a[1] + c.b[1]) / 2, dist: 16 + Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]) * 0.8, azimuth: az + 88, pitch: 3 }
    },
    boat: (i) => {
      const b = info.works.boats[i]
      return b ? { x: b.p[0], z: b.p[1], dist: 14 + b.len * 1.8, azimuth: 40 + i * 70, pitch: 16 } : PRESET.water()
    },
  }
  const wanted = flags.filter((a) => a.startsWith('--view=')).map((a) => a.slice(7))
  const names = wanted.length ? wanted : ['overview', 'north', 'east', 'south', 'west', 'top', 'roofs', 'street', 'landmark', 'gate', 'bridge', 'edge']
  const views: View[] = names.map((s, i) => {
    if (PRESET[s]) return { name: s, ...PRESET[s]() }
    const [head, far] = s.split('@')
    const [key, idx] = head.split('#')
    if (INDEXED[key]) return { name: `${key}${idx ?? 0}`, ...INDEXED[key](Number(idx ?? 0)) }
    // lm.<地标种类>#i、pt.<works 里的点列>#i：近景看第 i 个；后面可接 @距离
    const [group, what] = key.split('.')
    if (group === 'lm' || group === 'pt') {
      const list = group === 'lm' ? info.landmarks.filter((l) => l.kind === what).map((l) => l.p) : ((info.works as unknown as Record<string, unknown[]>)[what] ?? []).map((q) => (Array.isArray(q) ? q : (q as { p: number[] }).p) as number[])
      const q = list[Number(idx ?? 0)] ?? mid
      return { name: `${what}${idx ?? 0}`, x: q[0], z: q[1], dist: Number(far ?? 30), azimuth: 35 + Number(idx ?? 0) * 50, pitch: 16 }
    }
    const [nums, name] = s.split(':')
    const [x, z, dist, azimuth, pitch] = nums.split(',').map(Number)
    if (![x, z, dist, azimuth, pitch].every(Number.isFinite)) throw new Error(`机位不对：${s}`)
    return { name: name ?? `view${i}`, x, z, dist, azimuth, pitch }
  })
  mkdirSync(OUT, { recursive: true })
  const tag = `${query.get('culture') ?? 'western'}-${query.get('seed')}`
  for (const v of views) {
    await page.evaluate((v) => (window as any).__shot.town.setView(v), v)
    // 停稳后才栅格化地面高清块（见 TownScene 的 DETAIL_IDLE），再等时间累积收敛
    await new Promise((r) => setTimeout(r, 900))
    const data = (await page.evaluate('window.__shot.town.snapshot()')) as string
    const file = `${OUT}/${tag}-${v.name}.png`
    writeFileSync(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'))
    let perf = ''
    if (flags.includes('--perf')) {
      const m = (await page.evaluate('window.__shot.town.measure(40)')) as { ms: number; calls: number; triangles: number }
      perf = ` · 移动中每帧 ${m.ms.toFixed(2)} ms · 绘制 ${m.calls} 次 · ${(m.triangles / 1000).toFixed(0)}k 三角形`
    }
    console.log(`${file} · (${v.x.toFixed(0)}, ${v.z.toFixed(0)}) 距 ${v.dist.toFixed(0)} 米 方位 ${v.azimuth} 俯 ${v.pitch}${perf}`)
  }
} catch (e) {
  console.error(e)
  code = 1
} finally {
  await browser.close()
  await server.close()
}
process.exit(code)

interface Info {
  name: string
  width: number
  height: number
  pop: number
  until: number
  ms: { history: number; build: number; scene: number }
  tris: number
  trees: [string, number][]
  buildings: number
  kinds: Record<string, number>
  landmarks: { kind: string; p: [number, number]; major: boolean }[]
  gates: number[][]
  bridges: number[][]
  piers: number[][]
  big: Record<string, { p: number[]; area: number }[]>
  works: {
    gates: { p: [number, number]; out: number; kind: string; thickness: number }[]
    crossings: { a: [number, number]; b: [number, number]; kind: string; sacred: boolean }[]
    boats: { p: [number, number]; len: number }[]
  }
}
