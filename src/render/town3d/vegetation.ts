/**
 * 沙盘的树：按树形分组的实例数据。纯函数，可在 Worker 中运行。
 * 生成器只给出树的位置与冠径，树形按文明、气候与位置哈希推定：
 * 阔叶（团状树冠）、针叶（锥形，和式与寒冷地方多）、柱形（意大利柏、白杨，伊斯兰与西式的行道树）。
 */
import type { Life } from '../../settlement/history'
import type { Culture, Settlement } from '../../settlement/types'
import { NEVER } from './mesh'

export type TreeKind = 'broadleaf' | 'conifer' | 'columnar'
export const TREE_KINDS: TreeKind[] = ['broadleaf', 'conifer', 'columnar']

/** 一种树形的实例：每棵 (x, 地面高, z, 冠径, 出生人口, 消亡人口) */
export interface TreeSet {
  kind: TreeKind
  data: Float32Array
  count: number
}

/** 各文明的针叶、柱形比例 */
const MIX: Record<Culture, { conifer: number; columnar: number }> = {
  western: { conifer: 0.14, columnar: 0.07 },
  eastern: { conifer: 0.22, columnar: 0.03 },
  wa: { conifer: 0.45, columnar: 0.02 },
  islamic: { conifer: 0.04, columnar: 0.3 },
}

/** 位置哈希（0 ~ 1） */
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

export function treeInstances(st: Settlement, life: Map<object, Life>, H: (x: number, z: number) => number): TreeSet[] {
  const mix = MIX[st.params.culture]
  // 寒冷地方针叶多，炎热干燥处柱形（柏）多
  const temp = st.params.climate?.temp ?? 12
  const conifer = Math.min(0.85, mix.conifer + Math.max(0, (6 - temp) * 0.06))
  const columnar = mix.columnar * (temp > 18 ? 1.4 : 1)
  const buf = TREE_KINDS.map(() => [] as number[])
  for (const t of st.trees) {
    const [x, z] = t.p
    // 画幅以外的野地植被不上沙盘（会悬在底座边缘之外）
    const m = t.r * 0.6
    if (x < m || z < m || x > st.width - m || z > st.height - m) continue
    const h = hash(x, z)
    const k = h < conifer ? 1 : h < conifer + columnar ? 2 : 0
    const l = life.get(t)
    buf[k].push(x, H(x, z), z, t.r, l?.born ?? 0, l && l.died !== Infinity ? l.died : NEVER)
  }
  return TREE_KINDS.map((kind, i) => ({ kind, data: new Float32Array(buf[i]), count: buf[i].length / 6 }))
}
