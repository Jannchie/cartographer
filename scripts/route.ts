// 沿路网寻路（route）的自检：pnpm tsx scripts/route.ts [种子]
// 一片空地长出一个村子（住处、田、料场、铺子，和 scripts/grow.ts 同一个思路但短一些），然后：
//   - 近处（不到一块地宽）、同一块地上：直线；
//   - 远处两块地的中心之间：首尾就是起终点，中间的点都落在路上（离某条路的中线不到 1 米），比直线长、但不离谱；
//   - 没有路：直线；在两条互不相连的路之间：直线；
//   - 同样的输入两次结果一样，换一个只改了地块的状态（roads 同一个数组）结果也一样；
// 打印一次 route 的用时（第一次含建图、之后的平均）。有一项不成立，退出码是 1。
const { place, seedState, lotCenter, route } = await import('../src/settlement/grow')
const { segDist } = await import('../src/settlement/geom')
type GrowState = import('../src/settlement/grow').GrowState
type GrowP = import('../src/settlement/grow').GrowP

const seed = process.argv[2] ?? 'aki'
let bad = 0
const ok = (cond: boolean, what: string) => {
  if (!cond) {
    bad++
    console.log(`不成立：${what}`)
  }
}

let s: GrowState = seedState({ seed, culture: 'wa', river: true, coast: false, hills: false, relief: 0.3, coastDir: null, riverDir: null, hillDir: null, size: [1600, 1600] })
let salt = 1
for (let n = 1; n <= 80; n++) {
  const reqs = [{ use: 'home', area: 1, owner: `p${n}` }]
  if (n % 4 === 0) reqs.push({ use: 'field', area: 1, owner: `farm${n >> 4}`, count: 4 } as never)
  if (n % 10 === 0) reqs.push({ use: 'shop', area: 1, owner: `shop${n}` })
  if (n % 8 === 0) reqs.push({ use: 'yard', area: 1, owner: `yard${n >> 5}`, count: 2 } as never)
  for (const r of reqs) {
    const got = place(s, r, salt++)
    if (got) s = got.state
  }
}
console.log(`种子 ${seed}：${s.roads.length} 条路、${s.lots.length} 块地`)

const onRoad = (p: GrowP) => s.roads.some((r) => r.pts.some((a, i) => i + 1 < r.pts.length && segDist(p, a, r.pts[i + 1]).d < 1))
const len = (l: GrowP[]) => l.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0)
const same = (a: GrowP[], b: GrowP[]) => JSON.stringify(a) === JSON.stringify(b)

const lots = s.lots.filter((l) => l.state !== 'vacant')
const c0 = lotCenter(lots[0])
// 近处、同一块地上
ok(same(route(s, c0, [c0[0] + 5, c0[1] + 3]), [c0, [c0[0] + 5, c0[1] + 3]]), '不到一块地宽时走直线')
// 远处：找离 lots[0] 最远的一块
const far = lots.reduce((m, l) => (Math.hypot(lotCenter(l)[0] - c0[0], lotCenter(l)[1] - c0[1]) > Math.hypot(lotCenter(m)[0] - c0[0], lotCenter(m)[1] - c0[1]) ? l : m))
const c1 = lotCenter(far)
const t0 = performance.now()
const path = route(s, c0, c1)
const first = performance.now() - t0
ok(path.length > 2, '远处两块地之间不是直线')
ok(same(path[0], c0) && same(path[path.length - 1], c1), '首尾是起终点')
ok(path.slice(1, -1).every(onRoad), '中间的点都在路上')
const straight = Math.hypot(c1[0] - c0[0], c1[1] - c0[1])
ok(len(path) >= straight - 1e-6 && len(path) < straight * 4 + 100, `路程 ${len(path).toFixed(0)} 米，直线 ${straight.toFixed(0)} 米`)
ok(same(route(s, c0, c1), path), '同样的输入结果一样')
ok(same(route({ ...s, lots: s.lots.slice(0, 3) }, c0, c1), path), '只换了地块（roads 同一个数组）结果一样')
// 没有路；两条互不相连的路
ok(same(route({ ...s, roads: [] }, c0, c1), [c0, c1]), '没有路时走直线')
const apart: GrowState = { ...s, lots: [], roads: [
  { id: 1, kind: 'lane', pts: [[100, 100], [200, 100]], born: 0 },
  { id: 2, kind: 'lane', pts: [[100, 400], [200, 400]], born: 0 },
] }
ok(same(route(apart, [150, 110], [150, 390]), [[150, 110], [150, 390]]), '两头的路不连通时走直线')
// 丁字路口：岔路的端点接在母路中间
const tee: GrowState = { ...apart, roads: [
  { id: 1, kind: 'street', pts: [[100, 100], [300, 100]], born: 0 },
  { id: 2, kind: 'lane', pts: [[200, 100], [200, 300]], born: 0 },
] }
const tp = route(tee, [110, 90], [210, 290])
ok(same(tp, [[110, 90], [110, 100], [200, 100], [200, 290], [210, 290]]), `丁字路口拐过去（得到 ${JSON.stringify(tp)}）`)

// 用时：所有地块两两随机取 2000 对
const N = 2000
const t1 = performance.now()
for (let i = 0; i < N; i++) route(s, lotCenter(lots[(i * 7) % lots.length]), lotCenter(lots[(i * 13 + 5) % lots.length]))
const avg = (performance.now() - t1) / N
console.log(`route：第一次（含建图）${first.toFixed(2)} 毫秒，之后平均 ${(avg * 1000).toFixed(1)} 微秒`)
if (bad) process.exit(1)
console.log('全部成立')
