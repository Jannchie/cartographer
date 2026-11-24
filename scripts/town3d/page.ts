/**
 * 沙盘检查页（scripts/town3d.ts 用无头浏览器打开）：不经界面，直接由地址里的聚落参数推演成长史、搭沙盘。
 * 地址参数同聚落模块（seed、population、culture、capital=1 …，见 ui/settlement/route.ts），另有
 * time（时刻）、quality、dof、haze、stage、labels、ground（地面风格）、pop（时间轴上的人口，缺省为终态）、
 * specimen=x,z（植被换成各树种的陈列，中心在该处）。
 * 截图脚本经 window.__shot 摆镜头、取画面、测帧耗时。
 */
import '../../src/style.css'
import { generateHistory } from '../../src/settlement/generate'
import { snapshot } from '../../src/settlement/history'
import { scaleOf } from '../../src/settlement/scale'
import { DEFAULT_SETTLEMENT, type Settlement, type SettlementParams } from '../../src/settlement/types'
import type { SettleStyleId } from '../../src/settlement/themes'
import { decodeSettlement } from '../../src/ui/settlement/route'
import { buildTown, heightSampler } from '../../src/render/town3d/massing'
import { treeSpecimens } from '../../src/render/town3d/vegetation'
import { TownScene } from '../../src/render/town3d/townScene'
import { LOOKS, type QualityId } from '../../src/render/aerial/looks'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d)
const flag = (k: string, d: boolean) => (q.has(k) ? q.get(k) !== '0' : d)

/** 植被的看点（供脚本挑机位）：树最密的一处、最大的果园 / 葡萄园、最大的园林 / 墓地、离水最近的一棵树 */
function spots(st: Settlement) {
  const out: Record<string, number[]> = {}
  const cell = 60
  const count = new Map<number, number>()
  let best = 0
  for (const t of st.trees) {
    // 野地的树冠径大，果园、行道树小：只数大的
    if (t.r < 3) continue
    const k = Math.floor(t.p[1] / cell) * 4096 + Math.floor(t.p[0] / cell)
    const n = (count.get(k) ?? 0) + 1
    count.set(k, n)
    if (n > best) {
      best = n
      out.forest = [(k % 4096) * cell + cell / 2, Math.floor(k / 4096) * cell + cell / 2]
    }
  }
  const mid = (poly: number[][]) => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length]
  const size = (poly: number[][]) => Math.abs(poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1], 0))
  const largest = (polys: number[][][]) => polys.sort((a, b) => size(b) - size(a))[0]
  for (const k of ['orchard', 'vineyard']) {
    const p = largest(st.fields.filter((f) => f.kind === k).map((f) => f.poly))
    if (p) out[k] = mid(p)
  }
  for (const k of ['park', 'garden', 'cemetery', 'courtyard']) {
    const p = largest(st.greens.filter((g) => g.kind === k).map((g) => g.poly))
    if (p) out[k] = mid(p)
  }
  const T = st.terrain
  let wd = Infinity
  for (const t of st.trees) {
    const d = T.water[Math.min(T.H - 1, Math.max(0, Math.round(t.p[1] / T.cell))) * T.W + Math.min(T.W - 1, Math.max(0, Math.round(t.p[0] / T.cell)))]
    if (d > 2 && d < wd) {
      wd = d
      out.bank = [t.p[0], t.p[1]]
    }
  }
  return out
}

const api: Record<string, unknown> = { ready: false, error: '' }
;(window as unknown as { __shot: typeof api }).__shot = api

try {
  const params: SettlementParams = { ...DEFAULT_SETTLEMENT, ...decodeSettlement(q).params }
  params.size = scaleOf(params.population).size
  const t0 = performance.now()
  const hist = generateHistory(params)
  const t1 = performance.now()
  const build = buildTown(hist.st, hist.life)
  // specimen=x,z：把植被换成各树种的陈列（见 vegetation.ts 的 treeSpecimens）
  if (q.has('specimen')) {
    const [sx, sz] = q.get('specimen')!.split(',').map(Number)
    build.trees = treeSpecimens(hist.st, heightSampler(hist.st.terrain), sx, sz)
  }
  const t2 = performance.now()
  const pop = num('pop', hist.until)
  const st = snapshot(hist, pop)
  const town = new TownScene(document.getElementById('stage')!, {
    timeOfDay: num('time', 14.5),
    sunAzimuth: num('sunAzimuth', 225),
    sunElevation: num('sunElevation', 42),
    haze: flag('haze', true),
    dof: num('dof', 0.2),
    stage: flag('stage', true),
    labels: flag('labels', false),
    quality: (q.get('quality') ?? 'high') as QualityId,
    shadowSoftness: num('shadowSoftness', 2),
    look: (LOOKS.find((l) => l.id === q.get('look')) ?? LOOKS[0]).look,
  })
  town.setActive(true)
  await town.setTown(hist, build, st, pop, (q.get('ground') ?? 'color') as SettleStyleId, { name: st.nameZh, sub: `${(st.width / 1000).toFixed(1)} 公里 · 种子 ${params.seed}` })
  const t3 = performance.now()
  // 建筑的细节着色器在后台编译，换上之后再截图
  while (!town.detailed) await new Promise((r) => setTimeout(r, 50))
  const t4 = performance.now()
  // 成长回放时的地面重画：换几个相邻的快照各重画一次，取耗时（首次含显示列表的构建，另记）
  const tp = town as unknown as { paintGround(pop: number, st: unknown): void; paint: { cost: number } }
  const paint: number[] = [tp.paint.cost]
  for (const f of [0.96, 0.98, 1]) {
    tp.paintGround(pop * f, snapshot(hist, pop * f))
    paint.push(tp.paint.cost)
  }
  const H = (x: number, z: number) => {
    const T = hist.st.terrain
    const i = Math.min(T.W - 1, Math.max(0, Math.round(x / T.cell)))
    const j = Math.min(T.H - 1, Math.max(0, Math.round(z / T.cell)))
    return T.height[j * T.W + i]
  }
  Object.assign(api, {
    town,
    hist,
    /** 概况：画幅（米）、各类要素的数量与位置（供脚本挑机位） */
    info: {
      name: st.nameZh,
      width: st.width,
      height: st.height,
      pop,
      until: hist.until,
      ms: { history: t1 - t0, build: t2 - t1, scene: t3 - t2, detail: t4 - t2, paint },
      tris: build.tris,
      trees: build.trees.species,
      buildings: st.buildings.length,
      kinds: st.buildings.reduce((m: Record<string, number>, b) => ((m[b.kind] = (m[b.kind] ?? 0) + 1), m), {}),
      landmarks: st.landmarks.map((l) => ({ kind: l.kind, p: l.p, major: !!l.major })),
      gates: st.walls.flatMap((w) => w.gates.map((g) => g.p)),
      bridges: st.crossings.filter((c) => c.kind === 'bridge').map((c) => [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]),
      piers: st.piers.map((p) => p[0]),
      /** 构筑物与小品的位置（城门连同朝向与墙的种类、各类过水处、墓地、奇观、园林小品、船） */
      works: {
        gates: st.walls.flatMap((w) => {
          const cx = w.loop.reduce((s, q) => s + q[0], 0) / w.loop.length
          const cz = w.loop.reduce((s, q) => s + q[1], 0) / w.loop.length
          // out：自墙圈中心指向城门的方位角（度，镜头转到这个方位就是从城外看门）
          return w.gates.map((g) => ({ p: g.p, out: (Math.atan2(g.p[0] - cx, g.p[1] - cz) * 180) / Math.PI, kind: w.kind, thickness: w.thickness }))
        }),
        towers: st.walls.flatMap((w) => w.towers.slice(0, 3)),
        crossings: st.crossings.map((c) => ({ a: c.a, b: c.b, kind: c.kind, sacred: !!c.sacred })),
        moatBridges: st.walls.flatMap((w) => w.moat?.bridges.map((b) => b.p) ?? []),
        cemeteries: st.greens.filter((g) => g.kind === 'cemetery').map((g) => g.poly[0]),
        wonders: st.wonders.map((w) => ({ p: w.p, kind: w.kind })),
        rocks: st.parkParts.filter((q) => q.kind === 'rock').slice(0, 6).map((q) => q.poly[0]),
        boats: st.boats.map((b) => ({ p: b.p, len: b.len })),
      },
      /** 各类建筑里最大的几栋（中心与面积） */
      big: Object.fromEntries(
        ['temple', 'keep', 'tower', 'pagoda', 'hall', 'civic', 'large', 'torii', 'house'].map((k) => [
          k,
          st.buildings
            .filter((b) => b.kind === k)
            .map((b) => {
              let x = 0
              let z = 0
              let a = 0
              b.poly.forEach((p, i) => {
                const n = b.poly[(i + 1) % b.poly.length]
                x += p[0]
                z += p[1]
                a += p[0] * n[1] - n[0] * p[1]
              })
              return { p: [x / b.poly.length, z / b.poly.length], area: Math.abs(a) / 2 }
            })
            .sort((a, b) => b.area - a.area)
            .slice(0, 4),
        ]),
      ),
      center: st.center,
      heightAt: null,
      spots: spots(st),
    },
    heightAt: H,
    ready: true,
  })
} catch (err) {
  console.error(err)
  api.error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
}
