/**
 * 聚落 → 沙盘数据：建筑（buildings.ts）、城墙与桥等构筑物（works.ts）、树（vegetation.ts）与地形网格（relief.ts）。
 * 纯函数，不依赖 three.js 与 DOM，在 Worker 中运行（见 ui/settlement/history.worker.ts）。
 */
import { centroid } from '../../settlement/geom'
import type { Life } from '../../settlement/history'
import { eastAsian } from '../../settlement/culture'
import { settleTheme } from '../../settlement/themes'
import type { Settlement } from '../../settlement/types'
import { NEVER, Writer, type TownChunk } from './mesh'
import { facades } from './facade'
import { building } from './buildings'
import { boat, cityWall, crossing, enclosure, pier } from './works'
import { heightSampler, type Ctx } from './shared'
import { treeInstances, type TreeSet } from './vegetation'
import { terrainMesh, type TerrainMesh } from './relief'

export { heightSampler }

/** Worker 回传的沙盘数据（数组均可转移） */
export interface TownBuild {
  chunks: TownChunk[]
  trees: TreeSet[]
  terrain: TerrainMesh
  /** 三角形总数 */
  tris: number
  /** 构建耗时（毫秒） */
  ms: number
}

/**
 * 由成长史构建全部体块、树与地形网格（历史上出现过的一切，每样带生卒）。
 * 网格按块（约 8 × 8）切分，供视锥裁剪；块的大小不随城市规模变化太多
 */
export function buildTown(st: Settlement, life: Map<object, Life>): TownBuild {
  const t0 = performance.now()
  const culture = st.params.culture
  const nx = Math.max(1, Math.min(10, Math.round(st.width / 400)))
  const nz = Math.max(1, Math.min(10, Math.round(st.height / 400)))
  const w = new Writer(st.width, st.height, nx, nz)
  const c: Ctx = {
    w,
    culture,
    east: eastAsian(culture),
    pal: settleTheme('color').buildings(culture),
    H: heightSampler(st.terrain),
    storey: eastAsian(culture) ? 3.4 : 3.1,
    capital: !!st.params.capital,
  }
  const setLife = (x: object) => {
    const l = life.get(x)
    w.begin(l?.born ?? 0, l && l.died !== Infinity ? l.died : NEVER)
  }
  const fac = facades(st, life)
  st.buildings.forEach((b, i) => {
    setLife(b)
    const ct = centroid(b.poly)
    w.at(ct[0], ct[1])
    w.id = i
    building(c, b, fac[i])
  })
  w.id = -1
  for (const wall of st.walls) {
    setLife(wall)
    cityWall(c, wall)
  }
  for (const e of st.enclosures) {
    setLife(e)
    enclosure(c, e)
  }
  for (const x of st.crossings) {
    setLife(x)
    crossing(c, x)
  }
  for (const p of st.piers) {
    setLife(p)
    pier(c, p)
  }
  for (const b of st.boats) {
    setLife(b)
    boat(c, b)
  }
  const chunks = w.finish()
  const trees = treeInstances(st, life, c.H)
  return { chunks, trees, terrain: terrainMesh(st, life), tris: chunks.reduce((s, k) => s + k.ids.length, 0), ms: performance.now() - t0 }
}
