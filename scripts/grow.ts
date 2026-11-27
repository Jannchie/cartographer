// 生长引擎的离线演示与自检：pnpm tsx scripts/grow.ts [种子] [输出目录] [key=value ...]（覆盖地形参数，如 hills=true relief=0.4 culture=western）
// 从一片空地起，按一串需求（一个村子从 12 人长到 200 人：住处、田、料场、作坊、公所……）一步步 place，
// 在第 10、40、120 步和最后各出一张 PNG（color、kiriezu 两套，900 像素宽，裁到有东西的范围），打印每次 place 的用时。
// 再来一遍「先规划后生长」：手动铺一条主路、划一块农田区和一块住宅区，再按同一串需求自动生长，出一套对比图（分区画虚线框）。
// 同时自检：同一串需求跑两遍逐位相同；中途存档读回来接着跑也逐位相同；最后没有两块地相交、没有地压在路上或水里；
// 手动的路 place 会用上、田落在农田区里、住处不进农田区；跨水、压地块的路拒绝，还有临街地块的路不让拆；
// 点选的查询（lotAtPoint、zoneAtPoint）点得到、unzone 取消得掉。有一项不成立，退出码是 1。
// 最后一个参数写 --dump=目录 时，把两份最终状态的 JSON 写进去：改引擎前后各跑一次、逐位比对，确认只改了写法没改结果。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createCanvas } from '@napi-rs/canvas'
import './lib/canvas'
const { place, release, seedState, setState, growHash, lotCenter, lotAtPoint, addRoad, removeRoad, zone, unzone, zoneAtPoint } = await import('../src/settlement/grow')
const { LOT_OVERLAP_TOL, ROAD_WIDTH, terrainOf } = await import('../src/settlement/grow/core')
const { bootPaint, drawGrow } = await import('../src/settlement/grow/paint')
const { convexOverlap, pointInPoly, segPolyDist } = await import('../src/settlement/geom')
type GrowState = import('../src/settlement/grow').GrowState
type GrowP = import('../src/settlement/grow').GrowP
type PlaceReq = import('../src/settlement/grow').PlaceReq

const seed = process.argv[2] ?? 'aki'
const outDir = process.argv[3] ?? 'exports/grow'
const SHOTS = [10, 40, 120]
const STYLES = ['color', 'kiriezu']
/** 在建几步之后盖好 */
const LAG = 3

/** 一个村子从 12 人长到 200 人的需求（只由人数推出来，不用随机数）：每来一个人一处住处；每 4 人添一个农场岗位（4 块田）…… */
type Op = { kind: 'place'; req: PlaceReq } | { kind: 'release'; owner: string }
function demands(): Op[] {
  const ops: Op[] = [
    { kind: 'place', req: { use: 'public', area: 1, owner: 'office' } },
    { kind: 'place', req: { use: 'yard', area: 1, owner: 'builders' } },
  ]
  let farmSlots = 0
  for (let n = 1; n <= 200; n++) {
    ops.push({ kind: 'place', req: { use: 'home', area: 1, owner: `p${n}` } })
    if (n % 4 === 0) ops.push({ kind: 'place', req: { use: 'field', area: 1, owner: `farm${Math.floor(farmSlots++ / 7)}`, count: 4 } })
    if (n % 8 === 0) ops.push({ kind: 'place', req: { use: 'yard', area: 1, owner: `quarry${Math.floor(n / 64)}`, count: 2 } })
    if (n % 10 === 0) ops.push({ kind: 'place', req: { use: 'shop', area: 1, owner: `shop${Math.floor(n / 50)}` } })
    if (n % 40 === 0) ops.push({ kind: 'place', req: { use: 'public', area: 1, owner: 'office' } })
    // 翻盖：早来的人住处多占一块
    if (n % 15 === 0) ops.push({ kind: 'place', req: { use: 'home', area: 1, owner: `p${n / 15}` } })
    // 有人走了：住处空出来
    if (n % 25 === 0) ops.push({ kind: 'release', owner: `p${n / 25 + 1}` })
  }
  return ops
}

const extra: Record<string, unknown> = {}
/** --dump=目录：把两份最终状态（自动生长、先规划后生长）的 JSON 写进去（改引擎前后各跑一次比对，结果该逐位相同） */
let dumpDir = ''
for (const kv of process.argv.slice(4)) {
  if (kv.startsWith('--dump=')) {
    dumpDir = kv.slice(7)
    continue
  }
  const [k, v] = kv.split('=')
  extra[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v)
}
const params = { seed, culture: 'wa', river: true, coast: false, hills: false, relief: 0.3, coastDir: null, riverDir: null, hillDir: null, size: [1600, 1600] as [number, number], ...extra }

/** 跑一串需求；每步之后调用 onStep。saveAt 给了就在那一步存档、读回来接着跑 */
function run(start: GrowState, ops: Op[], onStep?: (s: GrowState, k: number, ms: number) => void, saveAt = -1, quiet = false) {
  let s = start
  const pending: { id: number; at: number }[] = []
  let fails = 0
  ops.forEach((op, k) => {
    if (k === saveAt) s = JSON.parse(JSON.stringify(s))
    const t = performance.now()
    let ms = 0
    if (op.kind === 'place') {
      const got = place(s, { ...op.req, state: 'building' }, growHash(`${s.seed}|${s.nextId}`))
      ms = performance.now() - t
      if (got) {
        s = got.state
        for (const l of got.lots) pending.push({ id: l.id, at: k + LAG })
      } else {
        fails++
        if (!quiet) console.log(`第 ${k} 步摆不下：${JSON.stringify(op.req)}`)
      }
    } else {
      const lot = s.lots.find((l) => l.owner === op.owner)
      if (lot) s = release(s, lot.id)
    }
    while (pending.length && pending[0].at <= k) s = setState(s, pending.shift()!.id, 'built')
    onStep?.(s, k + 1, ms)
  })
  return { s, fails }
}

let bad = 0
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? '✓' : '✗'} ${what}`)
  if (!cond) bad++
}

// —— 一：从空地自动生长 ——
const ops = demands()
const times: { ms: number; lots: number }[] = []
const shots = new Map<string, GrowState>()
const t0 = performance.now()
const { s: final, fails } = run(seedState(params), ops, (s, k, ms) => {
  if (ms) times.push({ ms, lots: s.lots.length })
  if (SHOTS.includes(k)) shots.set(`auto-${String(k).padStart(3, '0')}`, s)
})
console.log(`${ops.length} 步，${(performance.now() - t0).toFixed(0)} 毫秒；地块 ${final.lots.length}（空着 ${final.lots.filter((l) => l.state === 'vacant').length}），路 ${final.roads.length} 条，摆不下 ${fails} 次`)
shots.set(`auto-${ops.length}`, final)

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return `中位 ${s[Math.floor(s.length / 2)]?.toFixed(2)} 毫秒，最大 ${s.at(-1)?.toFixed(2)} 毫秒（${s.length} 次）`
}
console.log(`place 用时  全程：${stat(times.map((t) => t.ms))}`)
console.log(`            地块 180 ~ 220 块时：${stat(times.filter((t) => t.lots >= 180 && t.lots <= 220).map((t) => t.ms))}`)
console.log(`            地块 400 块以上：${stat(times.filter((t) => t.lots >= 400).map((t) => t.ms))}`)

const json = JSON.stringify(final)
ok(JSON.stringify(run(seedState(params), ops, undefined, -1, true).s) === json, '同一串需求再跑一遍，最终状态逐位相同')
ok(JSON.stringify(run(seedState(params), ops, undefined, 100, true).s) === json, '第 100 步存档读回来接着跑，逐位相同')

function tidy(s: GrowState, label: string) {
  const T = terrainOf(s)
  let overlap = 0
  let onRoad = 0
  let wet = 0
  for (let i = 0; i < s.lots.length; i++) for (let j = i + 1; j < s.lots.length; j++) if (convexOverlap(s.lots[i].poly, s.lots[j].poly, LOT_OVERLAP_TOL)) overlap++
  for (const l of s.lots) {
    for (const r of s.roads) for (let i = 0; i + 1 < r.pts.length; i++) if (segPolyDist(r.pts[i], r.pts[i + 1], l.poly) < ROAD_WIDTH[r.kind] / 2) onRoad++
    if (l.poly.some((q) => T.waterAt(q) < 0)) wet++
  }
  ok(overlap + onRoad + wet === 0, `${label}：${s.lots.length} 块地，相交 ${overlap} 对，压在路上 ${onRoad} 处，压在水里 ${wet} 块`)
}
tidy(final, '自动生长')

// —— 二：先规划后生长 ——
// 主路：从村心往外 400 米，方向先试和第一条对外的路垂直的两边，不行再每 30 度试一个
const base = seedState(params)
const c = base.center
const h = base.roads[0].pts
const a0 = Math.atan2(h[Math.min(5, h.length - 1)][1] - h[0][1], h[Math.min(5, h.length - 1)][0] - h[0][0])
let planned: GrowState | null = null
let u: GrowP = [1, 0]
const tries = [a0 + Math.PI / 2, a0 - Math.PI / 2, ...Array.from({ length: 12 }, (_, k) => a0 + (k * Math.PI) / 6)]
for (const a of tries) {
  u = [Math.cos(a), Math.sin(a)]
  const got = addRoad(base, [c, [c[0] + u[0] * 30, c[1] + u[1] * 30], [c[0] + u[0] * 400, c[1] + u[1] * 400]], 'street')
  if ('state' in got) {
    planned = got.state
    break
  }
}
if (!planned) throw new Error('主路铺不下')
const n: GrowP = [-u[1], u[0]]
const at = (s: number, t: number): GrowP => [c[0] + u[0] * s + n[0] * t, c[1] + u[1] * s + n[1] * t]
const homeZone = [at(20, -70), at(200, -70), at(200, 70), at(20, 70)]
const farmZone = [at(220, 0), at(420, 0), at(420, 180), at(220, 180)]
let zoned = zone(planned, homeZone, 'home')
if ('error' in zoned) throw new Error(zoned.error)
zoned = zone(zoned.state, farmZone, 'field')
if ('error' in zoned) throw new Error(zoned.error)
const plannedStart = zoned.state
const mainRoad = plannedStart.roads.at(-1)!
const { s: plannedFinal } = run(plannedStart, ops, (s, k) => {
  if (SHOTS.includes(k)) shots.set(`planned-${String(k).padStart(3, '0')}`, s)
}, -1, true)
shots.set(`planned-${ops.length}`, plannedFinal)
tidy(plannedFinal, '先规划后生长')

// 三条规则（在规划好的那一份上，按需求的前一段跑）
const early = run(plannedStart, ops.slice(0, 80), undefined, -1, true).s
const inZone = (l: { poly: GrowP[] }, z: GrowP[]) => pointInPoly(lotCenter(l as never), z)
ok(early.lots.some((l) => l.road === mainRoad.id), `手动铺的主路 place 会用上（前 80 步里临主路的地块 ${early.lots.filter((l) => l.road === mainRoad.id).length} 块）`)
// 田先落在农田区里（区里摆满了、或者剩下的是陡坡水边，才往外摆）：头 16 块都在区里
const fields = early.lots.filter((l) => l.use === 'field').sort((a, b) => a.id - b.id)
ok(fields.length >= 16 && fields.slice(0, 16).every((l) => inZone(l, farmZone)), `划了农田区，田先落在里面（头 16 块都在区里；前 80 步里一共 ${fields.filter((l) => inZone(l, farmZone)).length} / ${fields.length}）`)
const homes = plannedFinal.lots.filter((l) => l.use === 'home')
ok(!homes.some((l) => inZone(l, farmZone)), `住处不进农田区（住处 ${homes.length} 块，落在农田区里 ${homes.filter((l) => inZone(l, farmZone)).length} 块）`)
ok(homes.filter((l) => inZone(l, homeZone)).length > 10,`住宅区里有住处（${homes.filter((l) => inZone(l, homeZone)).length} 块）`)
// 拒绝的情形
const T = terrainOf(base)
let wetLine: GrowP[] | null = null
for (let a = 0; a < 2 * Math.PI && !wetLine; a += Math.PI / 12) {
  const far: GrowP = [c[0] + Math.cos(a) * 600, c[1] + Math.sin(a) * 600]
  for (let t = 0; t <= 1; t += 0.01) if (T.waterAt([c[0] + (far[0] - c[0]) * t, c[1] + (far[1] - c[1]) * t]) < 0) { wetLine = [c, far]; break }
}
if (wetLine) {
  const r = addRoad(base, wetLine, 'lane')
  ok('error' in r, `跨水的路被拒绝：${'error' in r ? r.error : '没拒绝'}`)
}
const lot = early.lots.find((l) => l.use === 'home')!
const across = addRoad(early, [lot.poly[0], lot.poly[2]], 'lane')
ok('error' in across, `压到地块的路被拒绝：${'error' in across ? across.error : '没拒绝'}`)
const rm = removeRoad(early, mainRoad.id)
ok('error' in rm, `还有临街地块的路不让拆：${'error' in rm ? rm.error : '拆了'}`)
// 给以后的手动操作界面用的几个查询（点哪块地、点哪片区、取消分区）
ok(lotAtPoint(early, lotCenter(lot))?.id === lot.id, `点一块地的中心，点到的就是它（#${lot.id}）`)
const farmZ = plannedStart.zones.find((z) => z.use === 'field')!
ok(zoneAtPoint(plannedStart, at(320, 90))?.id === farmZ.id && !zoneAtPoint(plannedStart, at(-300, 0)), '点农田区里面点到农田区，点区外什么也点不到')
const unz = unzone(plannedStart, farmZ.id)
ok(unz.zones.length === plannedStart.zones.length - 1 && !zoneAtPoint(unz, at(320, 90)) && unzone(unz, farmZ.id) === unz, '取消农田区之后点不到它；再取消一次原样返回')

if (dumpDir) {
  mkdirSync(dumpDir, { recursive: true })
  writeFileSync(`${dumpDir}/grow-${seed}-auto.json`, json)
  writeFileSync(`${dumpDir}/grow-${seed}-planned.json`, JSON.stringify(plannedFinal))
  console.log(`最终状态 → ${dumpDir}`)
}

// —— 出图 ——
mkdirSync(outDir, { recursive: true })
await bootPaint({ cultures: [params.culture as string], styles: STYLES })
const measurer = createCanvas(10, 10).getContext('2d') as unknown as CanvasRenderingContext2D
const WIDTH = 900
for (const [k, s] of shots) {
  // 裁到有东西的范围（四周多留 60 米，至少 320 米见方）；规划的那一套把分区也算进去
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const poly of [...s.lots.map((l) => l.poly), ...s.zones.map((z) => z.poly)])
    for (const [x, y] of poly) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const half = Math.max(160, (x1 - x0) / 2 + 60, (y1 - y0) / 2 + 60)
  const bx = Math.max(0, cx - half)
  const by = Math.max(0, cy - half)
  const bw = Math.min(s.size[0], cx + half) - bx
  const bh = Math.min(s.size[1], cy + half) - by
  for (const style of STYLES) {
    const pic = drawGrow(s, { style, fieldKind: 'paddy' }, measurer)
    const k2 = WIDTH / (bw * pic.S)
    const cv = createCanvas(WIDTH, Math.round(bh * pic.S * k2))
    const g = cv.getContext('2d') as unknown as CanvasRenderingContext2D
    pic.render(g, k2, -(pic.M + bx * pic.S) * k2, -(pic.M + by * pic.S) * k2)
    const px = (x: number, y: number): [number, number] => [(x - bx) * pic.S * k2, (y - by) * pic.S * k2]
    const outline = (poly: GrowP[], color: string, dash: number[], width: number) => {
      g.save()
      g.strokeStyle = color
      g.lineWidth = width
      g.setLineDash(dash)
      g.beginPath()
      poly.forEach(([x, y], i) => (i ? g.lineTo(...px(x, y)) : g.moveTo(...px(x, y))))
      g.closePath()
      g.stroke()
      g.restore()
    }
    // 分区：住宅区、农田区各一种颜色的长虚线；在建的地块：短虚线
    for (const z of s.zones) outline(z.poly, z.use === 'field' ? '#3f7a3a' : '#7a3a5a', [10, 6], 2)
    for (const l of s.lots.filter((q) => q.state === 'building')) outline(l.poly, '#b4532a', [4, 3], 1.5)
    const file = `${outDir}/grow-${seed}-${k}-${style}.png`
    writeFileSync(file, (cv as unknown as { toBuffer(t: string): Buffer }).toBuffer('image/png'))
    console.log(`${k}  ${s.lots.filter((l) => l.state !== 'vacant').length} 块地  → ${file}`)
  }
}
if (bad) {
  console.log(`\n${bad} 项自检没过`)
  process.exit(1)
}
