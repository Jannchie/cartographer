// 手动编辑（manual.ts、relief.ts、plan.ts 的架桥与连地块拆路）的自检：pnpm tsx scripts/grow-edit.ts [种子]
// 从什么都没有的空地起：没有路时 place、probeLot 都找不到地方；铺一条路之后沿路摆地块（吸附、挨着摆、压到别的地被拒绝、离路太远没有位置），
// 路的端点接到已有的路的端头或路身上，
// 拆地块、连地块拆路；改地形：抬高、平整、挖水（漫到的地块去掉）、填陆；挖出来的水面不架桥过不去、架桥过得去；
// 地形的缓存：接着上一份画出来的，和从头叠一遍的逐位相同；状态过一遍 JSON 也相同。有一项不成立，退出码是 1。
const { addRoad, blankState, lotAtPoint, lotCenter, paintTerrain, place, placeAt, probeLot, removeLot, removeRoad } = await import('../src/settlement/grow')
const { terrainOf } = await import('../src/settlement/grow/core')
const { convexOverlap, pointInPoly } = await import('../src/settlement/geom')
type GrowState = import('../src/settlement/grow').GrowState
type GrowP = import('../src/settlement/grow').GrowP

const seed = process.argv[2] ?? 'aki'
let bad = 0
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? '✓' : '✗'} ${what}`)
  if (!cond) bad++
}
const must = <T extends object>(r: T | { error: string }): T => {
  if ('error' in r) throw new Error(r.error)
  return r
}

// 平地：没有河、海、山，起伏为 0
const params = { seed, culture: 'wa', river: false, coast: false, hills: false, relief: 0, coastDir: null, riverDir: null, hillDir: null, size: [800, 800] as [number, number] }
let s: GrowState = blankState(params)
ok(s.roads.length === 0 && s.lots.length === 0, '空地：没有路、没有地块')
ok(place(s, { use: 'home', area: 1 }, 1) === null, '没有路时 place 找不到地方')
ok(probeLot(s, 'home', 1, [400, 400]) === null, '没有路时 probeLot 没有位置')

// —— 铺路、摆地块 ——
const main = must(addRoad(s, [[200, 400], [600, 400]], 'street'))
s = main.state
const pr = probeLot(s, 'home', 1, [400, 420])
ok(!!pr && !pr.fault && pr.road === main.road.id, '路边 20 米处有位置，临的是这条路')
ok(!!pr && pointInPoly([400, 420], pr.poly), '位置盖住指针')
ok(!!pr && pr.poly.every((q) => q[1] > 400), '位置在指针所在的一侧（路的南边）')
const a = must(placeAt(s, { use: 'home' }, [400, 420]))
s = a.state
ok(a.lot.state === 'built' && lotAtPoint(s, [400, 420])?.id === a.lot.id, '摆下的地块马上盖好，点得到')
const again = probeLot(s, 'home', 1, [400, 420])
ok(!!again && !again.fault && !convexOverlap(again.poly, a.lot.poly, 0.3), '同一处再试：给的是挨着的另一个位置')
// 沿路拖一遍（每 2 米一下，指针落在位置里才摆）：摆成不相交的一排
let row = 0
for (let x = 220; x <= 580; x += 2) {
  const p: GrowP = [x, 418]
  const q = probeLot(s, 'home', 1, p)
  if (!q || q.fault || !pointInPoly(p, q.poly)) continue
  s = must(placeAt(s, { use: 'home' }, p)).state
  row++
}
let overlap = 0
for (let i = 0; i < s.lots.length; i++) for (let j = i + 1; j < s.lots.length; j++) if (convexOverlap(s.lots[i].poly, s.lots[j].poly, 0.3)) overlap++
ok(row >= 12 && overlap === 0, `沿路拖一遍摆下 ${row} 块，相交 ${overlap} 对`)
ok(probeLot(s, 'home', 1, [400, 600]) === null, '离路 200 米没有位置')
const edge = probeLot(must(addRoad(s, [[14, 100], [14, 300]], 'lane')).state, 'home', 1, [6, 200])
ok(edge?.fault === 'edge', `贴着画幅边：${edge?.fault}`)
// 田接在田的背后
const f1 = must(placeAt(s, { use: 'field' }, [300, 380]))
const f2 = must(placeAt(f1.state, { use: 'field' }, [lotCenter(f1.lot)[0], lotCenter(f1.lot)[1] - 21]))
ok(Math.abs(lotCenter(f2.lot)[1] - lotCenter(f1.lot)[1]) > 19, '田可以接在田的背后')
s = f2.state
// 村心挪到新摆的村心上
const c = must(placeAt(s, { use: 'center' }, [500, 380]))
ok(Math.hypot(c.state.center[0] - lotCenter(c.lot)[0], c.state.center[1] - lotCenter(c.lot)[1]) < 0.02, '摆村心：state.center 挪到它上面')
s = c.state

// 路的端点：离已有的路的端头不到 8 米接在端头上（首尾相接），否则落在路身上
const tip = must(addRoad(s, [[605, 404], [700, 300]], 'street')).road
ok(tip.pts[0][0] === 600 && tip.pts[0][1] === 400, `端点离路的端头 6 米：接在端头上（${tip.pts[0]}）`)
const tee = must(addRoad(s, [[420, 395], [420, 300]], 'street')).road
ok(tee.pts[0][0] === 420 && tee.pts[0][1] === 400, `端点离路身 5 米、离端头远：落在路身上（${tee.pts[0]}）`)

// —— 拆 ——
const n0 = s.lots.length
ok(removeLot(s, a.lot.id).lots.length === n0 - 1 && removeLot(s, -5) === s, '拆地块：整块去掉；没有这块原样返回')
ok('error' in removeRoad(s, main.road.id), '路上还有地块，不让拆')
const gone = must(removeRoad(s, main.road.id, { lots: true }))
ok(gone.state.roads.length === 0 && gone.state.lots.length === 0, '连地块一起拆：路和临街的地块都没了')

// —— 改地形 ——
const T0 = terrainOf(s)
const up = paintTerrain(s, { tool: 'raise', r: 60, pts: [[650, 650]] }).state
ok(terrainOf(up).heightAt([650, 650]) > T0.heightAt([650, 650]) + 3 && terrainOf(up).heightAt([400, 400]) === T0.heightAt([400, 400]), '抬高：笔刷里高了，远处不变')
const flat = paintTerrain(up, { tool: 'flat', r: 40, pts: [[720, 650], [650, 650]] }).state
ok(Math.abs(terrainOf(flat).heightAt([660, 650]) - terrainOf(up).heightAt([720, 650])) < 0.3, '平整：压到起笔处的高程')
// 在一排住处中间横着挖一条水
const before = s.lots.length
const dug = paintTerrain(s, { tool: 'water', r: 14, pts: [[450, 300], [450, 500]] })
ok(dug.flooded > 0 && dug.state.lots.length === before - dug.flooded, `挖水：漫到的 ${dug.flooded} 块地去掉了`)
const Tw = terrainOf(dug.state)
ok(Tw.waterAt([450, 350]) < 0 && !Tw.seaAt([450, 350]) && Tw.waterAt([300, 350]) > 0, '挖出来的是水（不算海），远处还是陆地')
ok(dug.state.lots.every((l) => l.poly.every((q) => Tw.waterAt(q) >= 0.5)), '剩下的地块都不在水里')
const across: GrowP[] = [[330, 330], [570, 330]]
const no = addRoad(dug.state, across, 'street')
ok('error' in no && no.fault === 'water', '不架桥：跨水的路被拒绝')
ok(!('error' in addRoad(dug.state, across, 'street', { bridge: true })), '架桥：跨得过去')
const inWater = addRoad(dug.state, [[330, 330], [450, 330]], 'street', { bridge: true })
ok('error' in inWater && inWater.fault === 'water', '路的一头在水里：拒绝')
const filled = paintTerrain(dug.state, { tool: 'land', r: 30, pts: [[450, 300], [450, 500]] }).state
ok(terrainOf(filled).waterAt([450, 350]) > 0, '填陆：水面填回陆地')

// —— 缓存与存档 ——
const grids = (st: GrowState) => {
  const t = terrainOf(st).terrain
  return [Array.from(t.height), Array.from(t.water)]
}
const inc = JSON.stringify(grids(filled))
// 把缓存挤掉，再从头叠一遍
for (let k = 0; k < 8; k++) terrainOf(blankState({ ...params, seed: `evict${k}` }))
ok(JSON.stringify(grids(JSON.parse(JSON.stringify(filled)))) === inc, '地形：接着上一份画的，和读回存档从头叠一遍的逐位相同')
const replay = paintTerrain(paintTerrain(s, { tool: 'water', r: 14, pts: [[450, 300], [450, 500]] }).state, { tool: 'land', r: 30, pts: [[450, 300], [450, 500]] }).state
ok(JSON.stringify(replay) === JSON.stringify(filled), '同样的笔画再画一遍，状态逐位相同')

console.log(bad ? `${bad} 项不成立` : '全部成立')
process.exit(bad ? 1 : 0)
