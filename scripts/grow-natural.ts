// 自然生长（src/settlement/grow/natural.ts）的自检与演示：pnpm tsx scripts/grow-natural.ts [种子] [规划的人口] [输出目录]
// 按 3000 人规划一片地，照村子的需求序列（scripts/grow.ts 用的同一串）一步步 place，在几个时刻各出一张 PNG，打印每次 place 的用时。
// 自检：同一串需求跑两遍逐位相同；中途存档读回来接着跑也逐位相同；每块在用的地都对着规划里眼下还在的房子、田，
// 一栋房子住的户数不超过它的户数、一块田只有一个主人；手动的路、地块和规划混在一起、手动的优先（压到的住户挪走、压到的房子不画），
// 规划的路不能拆；改了地形，规划的地块按新的规划重新落、id 不变；小规划住满以后 place 返回 null。有一项不成立，退出码是 1。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createCanvas } from '@napi-rs/canvas'
import './lib/canvas'
// 先启动插件（文明等内容由插件登记）：自然生长要整套生成器
import '../src/packs/all'
const { addRoad, lotAtPoint, lotCenter, paintTerrain, place, placeAt, removeRoad, route } = await import('../src/settlement/grow')
const { WAY_ID, manualBlocker, terrainOf } = await import('../src/settlement/grow/core')
const { seedNatural, settleNatural } = await import('../src/settlement/grow/natural')
const { advance, newDriver } = await import('../src/settlement/grow/demands')
const { toSettlement } = await import('../src/settlement/grow/draw')
const { segDist } = await import('../src/settlement/geom')
const { buildSettlementVector } = await import('../src/settlement/render')
type GrowState = import('../src/settlement/grow').GrowState
type GrowP = import('../src/settlement/grow').GrowP
type GrowDriver = import('../src/settlement/grow/demands').GrowDriver

const seed = process.argv[2] ?? 'aki'
const horizon = Number(process.argv[3] ?? 3000)
const outDir = process.argv[4] ?? 'exports/grow'
const SHOTS = [0, 40, 150, 400, 900]
let bad = 0
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? '✓' : '✗'} ${what}`)
  if (!cond) bad++
}
const params = { seed, culture: 'wa', river: true, coast: false, hills: false, relief: 0.3, coastDir: null, riverDir: null, hillDir: null, size: [0, 0] as [number, number] }

let t0 = performance.now()
const start = seedNatural(params, horizon)
console.log(`规划 ${horizon} 人：${(performance.now() - t0).toFixed(0)} 毫秒，画幅 ${start.size.join(' × ')} 米`)
ok(start.plan?.pop === 0 && start.lots.length === 0, '开局：还没有人，没有地块')

/** 照需求序列走 n 步；saveAt 给了就在那一步存档、读回来接着走 */
function run(n: number, onStep?: (s: GrowState, k: number, ms: number) => void, saveAt = -1) {
  let s = start
  let d: GrowDriver = newDriver()
  for (let k = 0; k < n; k++) {
    if (k === saveAt) {
      s = JSON.parse(JSON.stringify(s))
      d = JSON.parse(JSON.stringify(d))
    }
    const t = performance.now()
    const r = advance(s, d)
    s = r.state
    d = r.driver
    onStep?.(s, k + 1, performance.now() - t)
  }
  return { s, d }
}

mkdirSync(outDir, { recursive: true })
const measurer = createCanvas(10, 10).getContext('2d') as never
const shot = (s: GrowState, tag: string) => {
  const list = buildSettlementVector(toSettlement(s), 'color', { labels: true, contours: true }, measurer)
  const k = 1400 / list.width
  const c = createCanvas(Math.round(list.width * k), Math.round(list.height * k))
  list.render(c.getContext('2d') as never, k, 0, 0)
  const file = `${outDir}/natural-${seed}-${tag}.png`
  writeFileSync(file, c.toBuffer('image/png'))
  console.log(`${tag}  人口时刻 ${Math.round(s.plan!.pop)}  地块 ${s.lots.length}  路 ${s.roads.length}  → ${file}`)
}
const N = SHOTS[SHOTS.length - 1]
const times: number[] = []
shot(start, '000')
t0 = performance.now()
const { s: final, d: driver } = run(N, (s, k, ms) => {
  times.push(ms)
  if (SHOTS.includes(k)) shot(s, String(k).padStart(3, '0'))
})
const sorted = [...times].sort((a, b) => a - b)
console.log(`${N} 步，${(performance.now() - t0).toFixed(0)} 毫秒（含出图）；place 中位 ${sorted[sorted.length >> 1].toFixed(2)} 毫秒，最大 ${sorted.at(-1)!.toFixed(2)} 毫秒；摆不下 ${driver.fails} 次`)

const json = JSON.stringify(final)
ok(JSON.stringify(run(N).s) === json, '同一串需求再跑一遍，最终状态逐位相同')
ok(JSON.stringify(run(N, undefined, 300).s) === json, '第 300 步存档读回来接着跑，逐位相同')

// 每块地都对着规划里还在的东西：画出来的那一刻的房子、田里找得到同样的轮廓
const st = toSettlement(final)
const key = (poly: number[][]) => poly.map((q) => `${Math.round(q[0] * 100)},${Math.round(q[1] * 100)}`).join(';')
const houses = new Map<string, number>()
for (const b of st.buildings) houses.set(key(b.poly), b.units ?? 1)
const fields = new Set(st.fields.map((f) => key(f.poly)))
const homeLots = final.lots.filter((l) => l.use !== 'field')
const fieldLots = final.lots.filter((l) => l.use === 'field')
ok(homeLots.every((l) => houses.has(key(l.poly))), `住处一类的 ${homeLots.length} 块地都对着眼下还在的房子`)
ok(fieldLots.every((l) => fields.has(key(l.poly))), `田的 ${fieldLots.length} 块地都对着眼下还在的田`)
const per = new Map<string, number>()
for (const l of homeLots) per.set(key(l.poly), (per.get(key(l.poly)) ?? 0) + 1)
ok([...per].every(([k, n]) => n <= houses.get(k)!), '一栋房子住的户数不超过它的户数')
ok(new Set(fieldLots.map((l) => l.ref)).size === fieldLots.length, '一块田只有一个主人')
const some = homeLots.find((l) => l.state !== 'vacant')!
ok(lotAtPoint(final, lotCenter(some))?.poly.join() === some.poly.join(), '点一块地的中心点得到它')
const far = homeLots.at(-1)!
ok(route(final, lotCenter(some), lotCenter(far)).length >= 2, '两块地之间走得出一条路线')

// 手动的东西和规划混在一起，手动的优先（用还没住满的中途状态）：一条手动的路从一户人家的房子上穿过去
const mid = run(400).s
const T0 = terrainOf(mid)
// 挑一户离水远的（要在它上面铺路、摆地块、挖水）
const site = mid.lots.find((l) => l.use !== 'field' && l.state !== 'vacant' && [-60, 0, 60].every((dx) => T0.waterAt([lotCenter(l)[0] + dx, lotCenter(l)[1]]) > 30))!
const c = lotCenter(site)
const through = addRoad(mid, [[c[0] - 45, c[1]], [c[0] + 45, c[1]]], 'street', { bridge: true })
ok(!('error' in through), `手动的路可以从规划的房子上穿过去${'error' in through ? `（${through.error}）` : ''}`)
if (!('error' in through)) {
  const got = place(through.state, { use: 'home', area: 1, owner: 'newcomer' }, 0)!
  const after = got.state
  // 摆新地块时规划把手动的路当骨架重算：记进 plan.guides，规划的地块照原来的先后重新落，画出来的路里没有规划自己的那一份
  ok(after.plan!.guides?.length === 1 && through.state.plan!.guides === undefined, '摆新地块时规划认下了这条手动的路（铺路的当时不认）')
  ok(after.lots.filter((l) => l.ref !== undefined).length === through.state.lots.filter((l) => l.ref !== undefined).length + 1, '规划重算后规划的地块一块不少（多了新来的一户）')
  ok(toSettlement(after).roads.every((r) => !r.given) && after.roads.filter((r) => r.id < WAY_ID).length === 1, '认下的路不重复出现在规划的路里')
  ok(JSON.stringify(place(JSON.parse(JSON.stringify(through.state)), { use: 'home', area: 1, owner: 'newcomer' }, 0)!.state) === JSON.stringify(after), '存档读回来再摆，逐位相同')
  const block = manualBlocker(after)!
  const moved = after.lots.find((l) => l.id === site.id)!
  ok(moved.poly.join() !== site.poly.join() && after.lots.filter((l) => l.ref !== undefined).every((l) => !block.poly(l.poly)), '下一次 place：被路压到的住户挪走了，没有规划的地块还压在手动的路上')
  const drawn = toSettlement(after)
  ok(drawn.buildings.every((bd) => !block.poly(bd.poly as never)) && drawn.roads.some((r) => r.roundEnds), '画出来：路压到的房子不画，多了这条手动的路')
  const hand = placeAt(after, { use: 'shop' }, [c[0] + 20, c[1] + 16])
  ok(!('error' in hand) && hand.lot.ref === undefined, `路边可以手动摆一块地（没有 ref）${'error' in hand ? `：${hand.error}` : ''}`)
  ok('error' in removeRoad(after, after.roads.find((r) => r.id >= WAY_ID)!.id) && !('error' in removeRoad(after, through.road.id)), '规划的路不能拆，手动的路可以拆')
  // 规划的地块记的 road 只是离它最近的路（可能就是这条手动的）：拆手动的路不动它们
  const cut = removeRoad(after, through.road.id, { lots: true })
  ok(!('error' in cut) && cut.state.lots.filter((l) => l.ref !== undefined).length === after.lots.filter((l) => l.ref !== undefined).length, '连地块拆手动的路：规划的地块一块不少')
  // 手动改完当场理一遍：被压到的规划地块挪到眼下空着的位置上（没有空位的先留着，等下一批房子）
  const under = (st: GrowState) => st.lots.filter((l) => l.ref !== undefined && manualBlocker(st)!.poly(l.poly)).length
  const tidy = settleNatural(through.state)
  ok(under(through.state) > 0 && under(tidy) <= under(through.state) && tidy.step === through.state.step && tidy.lots.length === through.state.lots.length, `settleNatural：压在手动的路底下的规划地块 ${under(through.state)} → ${under(tidy)}，不走步、不丢地块`)
  // 改地形：在村子中间挖一片水，规划的地块按新的规划重新落
  t0 = performance.now()
  const dug = paintTerrain(after, { tool: 'water', r: 60, pts: [[c[0], c[1] - 60], [c[0], c[1] + 60]] }).state
  console.log(`改地形后重新规划、重新落地块：${(performance.now() - t0).toFixed(0)} 毫秒；规划的地块 ${after.lots.filter((l) => l.ref !== undefined).length} → ${dug.lots.filter((l) => l.ref !== undefined).length}`)
  const T = terrainOf(dug)
  const st2 = toSettlement(dug)
  const houses2 = new Set(st2.buildings.map((bd) => key(bd.poly)))
  const fields2 = new Set(st2.fields.map((f) => key(f.poly)))
  const planned = dug.lots.filter((l) => l.ref !== undefined)
  ok(planned.length > 0 && planned.every((l) => (l.use === 'field' ? fields2 : houses2).has(key(l.poly))), '改地形后：规划的地块都对着新规划里眼下还在的房子、田')
  ok(planned.every((l) => T.waterAt(lotCenter(l)) > 0), '改地形后：没有规划的地块落在水里')
  const ids = new Map(after.lots.map((l) => [l.id, l]))
  ok(planned.every((l) => ids.get(l.id)?.owner === l.owner && ids.get(l.id)?.use === l.use), '改地形后：地块的 id、主人、用途不变')
  ok(JSON.stringify(paintTerrain(JSON.parse(JSON.stringify(after)), { tool: 'water', r: 60, pts: [[c[0], c[1] - 60], [c[0], c[1] + 60]] }).state) === JSON.stringify(dug), '改地形：存档读回来再改，逐位相同')
}

// 贴着规划的路并排铺一条手动的路：规划的那一段让开（状态里、画出来都没有），横着穿过去的不动
{
  const near = (st: GrowState, a: GrowP, b: GrowP) => {
    let n = 0
    for (const r of st.roads) if (r.id >= WAY_ID) for (const q of r.pts) if (segDist(q, a, b).d < 12) n++
    return n
  }
  let done = false
  for (const r of mid.roads) {
    if (done || r.id < WAY_ID) continue
    for (let i = 0; i + 1 < r.pts.length && !done; i++) {
      // 找一段 60 米以上的直路，在它旁边 8 米处并排铺
      const a = r.pts[i]
      let j = i + 1
      while (j + 1 < r.pts.length && Math.hypot(r.pts[j][0] - a[0], r.pts[j][1] - a[1]) < 60) j++
      const b = r.pts[j]
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (L < 60 || L > 90) continue
      const n: GrowP = [(-(b[1] - a[1]) / L) * 8, ((b[0] - a[0]) / L) * 8]
      const line: GrowP[] = [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]]]
      if (line.some((q) => T0.waterAt(q) < 20)) continue
      const beside = addRoad(mid, line, 'street', { bridge: true })
      if ('error' in beside) continue
      // 端点会吸到规划的路上：按实际铺下的线量
      const [p0, p1] = [beside.road.pts[0], beside.road.pts[beside.road.pts.length - 1]]
      const inner: [GrowP, GrowP] = [[p0[0] + (p1[0] - p0[0]) * 0.25, p0[1] + (p1[1] - p0[1]) * 0.25], [p0[0] + (p1[0] - p0[0]) * 0.75, p0[1] + (p1[1] - p0[1]) * 0.75]]
      const was = near(beside.state, ...inner)
      const tidy = settleNatural(beside.state)
      const drawn = toSettlement(tidy).roads.filter((x) => !x.roundEnds).reduce((c, x) => c + x.line.filter((q) => segDist(q as GrowP, ...inner).d < 12).length, 0)
      // 横着、斜着穿过去的规划的路留着（那是路口），所以不是一个点都不剩
      ok(was > 0 && near(tidy, ...inner) <= was / 3 && drawn <= was / 3, `并排铺一条手动的路：旁边 12 米以内规划的路的点 ${was} → ${near(tidy, ...inner)}，画出来 ${drawn}`)
      ok(tidy.roads.filter((x) => x.id >= WAY_ID).length >= mid.roads.length - 3, '别处规划的路都还在')
      done = true
    }
  }
  ok(done, '找得到一段可以并排铺路的规划的路')
}

// 小规划住满：place 返回 null
let small = seedNatural(params, 60)
let n = 0
for (; n < 500; n++) {
  const got = place(small, { use: 'home', area: 1, owner: `q${n}` }, 0)
  if (!got) break
  small = got.state
}
ok(n > 5 && n < 500, `按 60 人规划：住进 ${n} 户之后住满，place 返回 null`)

console.log(bad ? `${bad} 项不成立` : '全部成立')
process.exit(bad ? 1 : 0)
