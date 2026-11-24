/**
 * 组合地标的部件分组：生成器把教堂、清真寺、天守拆成互相重叠的矩形，各带部件名（Building.part）；
 * 沙盘按"平面相接"把它们并成一组，部件的高度、朝向由整组推出（侧廊按中殿定高，穹顶坐在礼拜殿的屋面上）。
 * 纯函数，在 Worker 中运行；每座聚落只算一遍
 */
import { bboxOf, type P } from '../../settlement/geom'
import type { Building, Settlement } from '../../settlement/types'

export interface Group {
  /** 组里的全部部件 */
  all: Building[]
  /** 按部件名取（没有时为空数组） */
  of: (part: string) => Building[]
  /** 由位置派生的随机数（同组的部件取同一个：双塔同高、同一种塔顶） */
  seed: number
  /** 各模块在组上缓存的推导结果（中殿的框、檐高之类） */
  memo: Map<string, unknown>
}

const cache = new WeakMap<Settlement, Map<Building, Group>>()

/** 相接的余量（米）：部件之间隔着扶壁、回廊也算一组 */
const PAD = 2.5

function build(st: Settlement): Map<Building, Group> {
  const list = st.buildings.filter((b) => b.part)
  const boxes = list.map((b) => bboxOf(b.poly))
  const parent = list.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  // 按网格找包围盒相接的部件
  const CELL = 40
  const grid = new Map<number, number[]>()
  boxes.forEach(([x0, y0, x1, y1], i) => {
    for (let gy = Math.floor((y0 - PAD) / CELL); gy <= Math.floor((y1 + PAD) / CELL); gy++)
      for (let gx = Math.floor((x0 - PAD) / CELL); gx <= Math.floor((x1 + PAD) / CELL); gx++) {
        const k = gy * 65536 + gx
        const cell = grid.get(k)
        if (!cell) {
          grid.set(k, [i])
          continue
        }
        for (const j of cell) {
          const o = boxes[j]
          if (x0 - PAD < o[2] && o[0] - PAD < x1 && y0 - PAD < o[3] && o[1] - PAD < y1) parent[find(i)] = find(j)
        }
        cell.push(i)
      }
  })
  const groups = new Map<number, Building[]>()
  list.forEach((b, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(b)
    else groups.set(r, [b])
  })
  const out = new Map<Building, Group>()
  for (const all of groups.values()) {
    const byPart = new Map<string, Building[]>()
    let sx = 0
    let sy = 0
    for (const b of all) {
      const a = byPart.get(b.part!)
      if (a) a.push(b)
      else byPart.set(b.part!, [b])
      sx += b.poly[0][0]
      sy += b.poly[0][1]
    }
    const s = Math.sin(sx * 12.9898 + sy * 78.233) * 43758.5453
    const g: Group = { all, of: (p) => byPart.get(p) ?? NONE, seed: s - Math.floor(s), memo: new Map() }
    for (const b of all) out.set(b, g)
  }
  return out
}
const NONE: Building[] = []

/** 这栋建筑所在的部件组（没有部件名的返回 null） */
export function groupOf(st: Settlement, b: Building): Group | null {
  if (!b.part) return null
  let m = cache.get(st)
  if (!m) cache.set(st, (m = build(st)))
  return m.get(b) ?? null
}

/** 多边形的顶点平均（部件的大致位置） */
export function mid(poly: P[]): P {
  let x = 0
  let y = 0
  for (const p of poly) {
    x += p[0]
    y += p[1]
  }
  return [x / poly.length, y / poly.length]
}
