/**
 * 立面分析：每栋建筑的每面外墙开不开窗、门开在哪面。
 * - 贴着邻屋的墙（共用墙、山墙相接）不开窗：在墙外 1 米处取三点，落进其他建筑的点多就算贴着。
 *   沙盘里是成长史上出现过的全部建筑，邻屋只算与自己同时存在过的（原地翻建的旧房不算）
 * - 太短的墙段不开窗
 * - 门开在露天的墙里离街最近的那面（同样近时取长的），面向街道
 * 纯函数，在 Worker 里运行；建筑与街道各按网格索引，整城一遍是线性的
 */
import { bboxOf, pointInPoly, segDist, signedArea, type P } from '../../settlement/geom'
import type { Life } from '../../settlement/history'
import type { Building, Settlement } from '../../settlement/types'

export interface Facade {
  /** 第 k 面墙（poly[k] → poly[k + 1]）开窗 */
  win: boolean[]
  /** 开门的墙（下标），-1 为不开门 */
  door: number
}

const CELL = 24
/** 开窗的最短墙段（米） */
const MIN_WALL = 1.6
/** 只有这些建筑开门（宗教建筑、塔、城堡另有大门，不按民居开） */
const DOORS = new Set<Building['kind']>(['house', 'large', 'civic', 'hall', 'shed'])
/** 判定贴邻的取样点（沿墙的比例） */
const SAMPLES = [0.2, 0.5, 0.8]

class Grid<T> {
  private cells = new Map<number, T[]>()
  add(x0: number, y0: number, x1: number, y1: number, v: T) {
    for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++)
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
        const k = j * 65536 + i
        let a = this.cells.get(k)
        if (!a) this.cells.set(k, (a = []))
        a.push(v)
      }
  }
  at(p: P): T[] {
    return this.cells.get(Math.floor(p[1] / CELL) * 65536 + Math.floor(p[0] / CELL)) ?? []
  }
}

export function facades(st: Settlement, life?: Map<object, Life>): Facade[] {
  const span = st.buildings.map((b) => {
    const l = life?.get(b)
    return [l?.born ?? 0, l?.died ?? Infinity]
  })
  // 两栋的存续期有重叠
  const together = (i: number, j: number) => span[i][0] < span[j][1] && span[j][0] < span[i][1]
  const bg = new Grid<number>()
  st.buildings.forEach((b, i) => {
    const [x0, y0, x1, y1] = bboxOf(b.poly)
    bg.add(x0 - 1, y0 - 1, x1 + 1, y1 + 1, i)
  })
  // 街道按线段索引（只算有路面的街，田间小径、台阶不算临街）
  const rg = new Grid<{ a: P; b: P; hw: number }>()
  for (const r of st.roads) {
    if (r.kind === 'path') continue
    for (let k = 0; k + 1 < r.line.length; k++) {
      const a = r.line[k]
      const b = r.line[k + 1]
      const hw = r.width / 2
      rg.add(Math.min(a[0], b[0]) - hw - 12, Math.min(a[1], b[1]) - hw - 12, Math.max(a[0], b[0]) + hw + 12, Math.max(a[1], b[1]) + hw + 12, { a, b, hw })
    }
  }
  const covered = (p: P, self: number) => bg.at(p).some((j) => j !== self && together(self, j) && pointInPoly(p, st.buildings[j].poly))
  const streetDist = (p: P) => {
    let best = Infinity
    for (const s of rg.at(p)) best = Math.min(best, segDist(p, s.a, s.b).d - s.hw)
    return best
  }

  return st.buildings.map((b, bi) => {
    const poly = b.poly
    const n = poly.length
    // 外法线：按环的绕向取边的左手或右手法线
    const sgn = signedArea(poly) > 0 ? 1 : -1
    const win: boolean[] = []
    let door = -1
    let doorScore = Infinity
    for (let k = 0; k < n; k++) {
      const p = poly[k]
      const q = poly[(k + 1) % n]
      const dx = q[0] - p[0]
      const dz = q[1] - p[1]
      const L = Math.hypot(dx, dz)
      if (L < MIN_WALL) {
        win.push(false)
        continue
      }
      const nx = (dz / L) * sgn
      const nz = (-dx / L) * sgn
      let hit = 0
      for (const t of SAMPLES) if (covered([p[0] + dx * t + nx, p[1] + dz * t + nz], bi)) hit++
      const open = hit < 2
      win.push(open)
      if (!open || !DOORS.has(b.kind)) continue
      const mid: P = [p[0] + dx * 0.5 + nx * 1.5, p[1] + dz * 0.5 + nz * 1.5]
      // 离街越近越好；同样近时取长的墙（主立面）
      const score = Math.min(40, streetDist(mid)) - L * 0.15
      if (score < doorScore) {
        doorScore = score
        door = k
      }
    }
    return { win, door }
  })
}
