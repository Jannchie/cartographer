/**
 * 聚落 → 沙盘数据：建筑（buildings.ts）、城防与院墙（works.ts、gates.ts）、桥（bridges.ts）、码头与船（harbor.ts）、
 * 小品（props.ts）、树（vegetation.ts）与地形网格（relief.ts）。
 * 纯函数，不依赖 three.js 与 DOM，在 Worker 中运行（见 ui/settlement/history.worker.ts）。
 */
import { centroid, clipConvex, type P } from '../../settlement/geom'
import type { Life } from '../../settlement/history'
import { settleTheme } from '../../settlement/themes'
import type { Settlement, Wall } from '../../settlement/types'
import { NEVER, Writer, type TownChunk } from './mesh'
import { facades } from './facade'
import { building } from './buildings'
import { cityWall, enclosure, roadIndex, type WCtx } from './works'
import { crossing, moatBridge } from './bridges'
import { boat, pier } from './harbor'
import { fieldProps, landmarkProp, propBuilding, propIndex, rock, wonder } from './props'
import { heightSampler, hex, waterSampler } from './shared'
import { treeInstances, type TreeBuild } from './vegetation'
import { terrainMesh, type TerrainMesh } from './relief'
import { townKit } from './kits'

/** Worker 回传的沙盘数据（数组均可转移） */
export interface TownBuild {
  chunks: TownChunk[]
  trees: TreeBuild
  terrain: TerrainMesh
  /** 三角形总数 */
  tris: number
  /** 构建耗时（毫秒） */
  ms: number
}

/**
 * 由成长史构建全部体块、树与地形网格（历史上出现过的一切，每样带生卒）。
 * 网格按块（约 8 × 8）切分，供视锥裁剪；块的大小不随城市规模变化太多。
 * 生成器会在画幅以外留下东西（画幅外的农家、院墙、野地）：沙盘只到画幅为止，越界的体块整个不建，
 * 城墙在画幅边上断开，码头按画幅裁切——底座之外不悬着任何几何
 */
export function buildTown(st: Settlement, life: Map<object, Life>): TownBuild {
  const t0 = performance.now()
  const culture = st.params.culture
  const nx = Math.max(1, Math.min(10, Math.round(st.width / 400)))
  const nz = Math.max(1, Math.min(10, Math.round(st.height / 400)))
  const w = new Writer(st.width, st.height, nx, nz)
  const kit = townKit(culture)
  const c: WCtx = {
    w,
    kit,
    pal: settleTheme('color').buildings(culture),
    H: heightSampler(st.terrain),
    capital: !!st.params.capital,
    st,
    water: waterSampler(st.terrain),
    road: roadIndex(st),
  }
  const setLife = (x: object) => {
    const l = life.get(x)
    w.begin(l?.born ?? 0, l && l.died !== Infinity ? l.died : NEVER)
  }
  // 画幅：点、多边形是否整个落在画幅内（留出 m 米：出檐、墙厚）
  const W = st.width
  const D = st.height
  const inside = (p: P, m: number) => p[0] >= m && p[1] >= m && p[0] <= W - m && p[1] <= D - m
  const within = (poly: P[], m: number) => poly.every((p) => inside(p, m))
  const frame: P[] = [[0.3, 0.3], [W - 0.3, 0.3], [W - 0.3, D - 0.3], [0.3, D - 0.3]]

  const fac = facades(st, life)
  // 墓、摊棚、风车这类"建筑"不按房子盖（见 props.ts）
  const props = propIndex(st)
  st.buildings.forEach((b, i) => {
    if (!within(b.poly, 1.6)) return
    setLife(b)
    const ct = centroid(b.poly)
    w.at(ct[0], ct[1])
    w.id = i
    const prop = props.of(b)
    if (prop) propBuilding(c, b, prop)
    else building(c, b, fac[i], st)
  })
  w.id = -1
  for (const wall of st.walls) {
    setLife(wall)
    cityWall(c, framed(wall, (p) => inside(p, wall.thickness + 3)))
    for (const b of wall.moat?.bridges ?? []) if (inside(b.p, wall.moat!.width + 6)) moatBridge(c, wall, b)
  }
  for (const e of st.enclosures) {
    if (!within(e, 0.8)) continue
    setLife(e)
    enclosure(c, e)
  }
  for (const x of st.crossings) {
    if (!inside(x.a, 4) || !inside(x.b, 4)) continue
    setLife(x)
    crossing(c, x)
  }
  for (const p of st.piers) {
    const q = within(p, 0.3) ? p : clipConvex(p, frame)
    if (q.length < 3) continue
    setLife(p)
    pier(c, q)
  }
  for (const b of st.boats) {
    if (!inside(b.p, b.len * 0.6)) continue
    setLife(b)
    boat(c, b)
  }
  // 小品：地标点（井、喷泉、雕像、水车）、置石、奇观、田里的草垛
  for (const l of st.landmarks) {
    if (!inside(l.p, 5)) continue
    setLife(l)
    landmarkProp(c, l)
  }
  for (const q of st.parkParts) {
    if (q.kind !== 'rock' || !within(q.poly, 1)) continue
    setLife(q)
    rock(c, q)
  }
  const magic = hex(settleTheme('color').magic)
  for (const x of st.wonders) {
    if (x.kind !== 'leyline' && !inside(x.p, x.r * 1.3 + 3)) continue
    setLife(x)
    wonder(c, x, magic)
  }
  for (const f of st.fields) {
    setLife(f)
    fieldProps(c, f)
  }
  const chunks = w.finish()
  const trees = treeInstances(st, life, c.H)
  return { chunks, trees, terrain: terrainMesh(st, life), tris: chunks.reduce((s, k) => s + k.ids.length, 0), ms: performance.now() - t0 }
}

/** 城墙按画幅收住：画幅外的墙段不建（当作断开），画幅外的塔与城门去掉 */
function framed(wall: Wall, ok: (p: P) => boolean): Wall {
  if (wall.loop.every(ok)) return wall
  const n = wall.loop.length
  return {
    ...wall,
    solid: wall.solid.map((s, i) => s && ok(wall.loop[i]) && ok(wall.loop[(i + 1) % n])),
    towers: wall.towers.filter(ok),
    gates: wall.gates.filter((g) => ok(g.p)),
  }
}
