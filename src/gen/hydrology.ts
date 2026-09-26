import { MinHeap, neighbors8 } from './util'

export interface FloodResult {
  /** 填洼后的表面 */
  filled: Float32Array
  /** 流向：下游格索引，-1 表示汇（海洋） */
  dir: Int32Array
  /** 弹出顺序（下游在前） */
  order: Int32Array
}

/**
 * Priority-Flood + ε（Barnes 2014）：从海洋向内陆淹没，
 * 得到无洼地表面，同时记录每格的排水方向——保证所有水都能流到海里。
 */
export function priorityFlood(elev: Float32Array, W: number, H: number, eps = 1e-5): FloodResult {
  const N = W * H
  const filled = new Float32Array(elev)
  const dir = new Int32Array(N).fill(-2)
  const order = new Int32Array(N)
  const heap = new MinHeap(1 << 16)
  const { off, dx, dy } = neighbors8(W)
  let n = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (elev[i] <= 0 || x === 0 || y === 0 || x === W - 1 || y === H - 1) {
        dir[i] = -1
        heap.push(elev[i], i)
      }
    }
  }
  while (heap.size > 0) {
    const c = heap.pop()
    order[n++] = c
    const cx = c % W
    const cy = (c - cx) / W
    const hc = filled[c]
    for (let k = 0; k < 8; k++) {
      const x = cx + dx[k]
      const y = cy + dy[k]
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const j = c + off[k]
      if (dir[j] !== -2) continue
      dir[j] = c
      const hj = elev[j]
      filled[j] = hj > hc + eps ? hj : hc + eps
      heap.push(filled[j], j)
    }
  }
  return { filled, dir, order }
}

export interface Depression {
  cells: Int32Array
  /** 溢出口高度（填满时的水面） */
  spill: number
  maxDepth: number
}

/** 连通的洼地区域（填洼深度 > minDepth） */
export function findDepressions(elev: Float32Array, filled: Float32Array, W: number, H: number, minDepth: number) {
  const N = W * H
  const label = new Int32Array(N).fill(-1)
  const list: Depression[] = []
  const { off, dx, dy } = neighbors8(W)
  const queue = new Int32Array(N)
  for (let s = 0; s < N; s++) {
    if (label[s] !== -1 || filled[s] - elev[s] <= minDepth || elev[s] <= 0) continue
    const id = list.length
    let qh = 0
    let qt = 0
    queue[qt++] = s
    label[s] = id
    let spill = -Infinity
    let maxDepth = 0
    while (qh < qt) {
      const c = queue[qh++]
      spill = Math.max(spill, filled[c])
      maxDepth = Math.max(maxDepth, filled[c] - elev[c])
      const cx = c % W
      const cy = (c - cx) / W
      for (let k = 0; k < 8; k++) {
        const x = cx + dx[k]
        const y = cy + dy[k]
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const j = c + off[k]
        if (label[j] !== -1 || filled[j] - elev[j] <= minDepth || elev[j] <= 0) continue
        label[j] = id
        queue[qt++] = j
      }
    }
    list.push({ cells: queue.slice(0, qt), spill, maxDepth })
  }
  return { label, list }
}

/**
 * 部分填洼：小而浅的洼地（噪声造成的坑）直接填平，
 * 大而深的洼地保留下来，之后成为湖泊或内流盆地。
 */
export function fillSmallDepressions(elev: Float32Array, W: number, H: number, minArea: number, minDepth: number) {
  const { filled } = priorityFlood(elev, W, H, 1e-5)
  const { list } = findDepressions(elev, filled, W, H, 1e-6)
  let kept = 0
  for (const d of list) {
    if (d.cells.length >= minArea && d.maxDepth >= minDepth) {
      kept++
      continue
    }
    for (const c of d.cells) elev[c] = filled[c]
  }
  return kept
}

export interface Lake {
  cells: Int32Array
  level: number
  /** 内流湖（无出口，蒸发平衡） */
  endorheic: boolean
  /** 水量平衡后干涸的洼地底部 */
  dryCells: Int32Array
}

export interface HydroResult {
  dir: Int32Array
  flow: Float32Array
  lakes: Lake[]
  /** 每格的湖泊编号，-1 为非湖 */
  lakeId: Int32Array
  /** 水面高度（湖面），非湖 NaN */
  lakeLevel: Float32Array
}

/**
 * 水文：径流汇流 + 湖泊水量平衡。
 * 进入洼地的水量若小于湖面蒸发，湖泊退缩到能平衡的面积（内流湖/盐湖），
 * 否则注满并从溢出口流出。
 */
export function hydrology(
  elev: Float32Array,
  runoff: Float32Array,
  lakeEvap: Float32Array,
  W: number,
  H: number,
): HydroResult {
  const N = W * H
  const { filled, dir, order } = priorityFlood(elev, W, H, 1e-6)
  const { label, list } = findDepressions(elev, filled, W, H, 0.004)
  // 过小的洼地不成湖
  const isLake = list.map((d) => d.cells.length >= 4)

  // 每个洼地的出口格：流向指出洼地的那一格
  const outlet = new Int32Array(list.length).fill(-1)
  list.forEach((d, id) => {
    for (const c of d.cells) {
      const t = dir[c]
      if (t < 0 || label[t] !== id) {
        outlet[id] = c
        break
      }
    }
  })
  const outletOf = new Int32Array(N).fill(-1)
  outlet.forEach((c, id) => {
    if (c >= 0 && isLake[id]) outletOf[c] = id
  })
  const evapTotal = list.map((d) => {
    let s = 0
    for (const c of d.cells) s += lakeEvap[c]
    return s
  })

  // 第一遍：按拓扑逆序汇流，在湖泊出口扣除湖面蒸发
  const flow = new Float32Array(N)
  const inflow = new Float32Array(list.length)
  const accumulate = (dirArr: Int32Array, ord: Int32Array | null) => {
    for (let i = 0; i < N; i++) flow[i] = runoff[i]
    const seq = ord ?? topoOrder(dirArr, N)
    for (let q = seq.length - 1; q >= 0; q--) {
      const c = seq[q]
      const id = outletOf[c]
      if (id >= 0) {
        inflow[id] = flow[c]
        flow[c] = Math.max(0, flow[c] - evapTotal[id])
      }
      const t = dirArr[c]
      if (t >= 0) flow[t] += flow[c]
    }
  }
  accumulate(dir, order)

  // 湖泊水量平衡
  const lakes: Lake[] = []
  const lakeId = new Int32Array(N).fill(-1)
  const lakeLevel = new Float32Array(N).fill(NaN)
  const newDir = new Int32Array(dir)
  let rerouted = false
  list.forEach((d, id) => {
    if (!isLake[id]) return
    const Q = inflow[id]
    const E = evapTotal[id]
    if (Q >= E || E <= 0) {
      const lk: Lake = { cells: d.cells, level: d.spill, endorheic: false, dryCells: new Int32Array(0) }
      for (const c of d.cells) {
        lakeId[c] = lakes.length
        lakeLevel[c] = d.spill
      }
      lakes.push(lk)
      return
    }
    // 退缩：从最低处开始注水，直到蒸发面积等于来水
    const cells = Array.from(d.cells).sort((a, b) => elev[a] - elev[b])
    const meanE = E / cells.length
    const k = Math.floor(Q / meanE)
    rerouted = true
    if (k < 3) {
      // 完全干涸：盐沼 / 干盆地，最低点作为汇
      const sink = cells[0]
      rerouteToward(newDir, elev, [sink], W, H, label, id)
      newDir[sink] = -1
      lakes.push({ cells: new Int32Array(0), level: elev[sink], endorheic: true, dryCells: Int32Array.from(cells) })
      return
    }
    const wet = cells.slice(0, k)
    const level = elev[wet[wet.length - 1]]
    const lk: Lake = {
      cells: Int32Array.from(wet),
      level,
      endorheic: true,
      dryCells: Int32Array.from(cells.slice(k)),
    }
    for (const c of wet) {
      lakeId[c] = lakes.length
      lakeLevel[c] = level
    }
    rerouteToward(newDir, elev, wet, W, H, label, id)
    for (const c of wet) newDir[c] = -1
    lakes.push(lk)
  })

  if (rerouted) {
    // 内流盆地重新定向后再汇流一次（内流湖不再向外输出）
    for (let i = 0; i < N; i++) if (lakeId[i] >= 0 && lakes[lakeId[i]].endorheic) newDir[i] = -1
    outletOf.fill(-1)
    outlet.forEach((c, id) => {
      if (c >= 0 && isLake[id] && newDir[c] !== -1) outletOf[c] = id
    })
    accumulate(newDir, null)
  }
  return { dir: newDir, flow, lakes, lakeId, lakeLevel }
}

/** 在洼地内部，从湖（汇）向外按高度淹没，使干涸的盆地底部流向湖泊 */
function rerouteToward(
  dir: Int32Array,
  elev: Float32Array,
  seeds: number[],
  W: number,
  H: number,
  label: Int32Array,
  id: number,
) {
  const { off, dx, dy } = neighbors8(W)
  const heap = new MinHeap(1024)
  const seen = new Set<number>()
  for (const s of seeds) {
    heap.push(elev[s], s)
    seen.add(s)
  }
  while (heap.size > 0) {
    const c = heap.pop()
    const cx = c % W
    const cy = (c - cx) / W
    for (let k = 0; k < 8; k++) {
      const x = cx + dx[k]
      const y = cy + dy[k]
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const j = c + off[k]
      if (seen.has(j) || label[j] !== id) continue
      seen.add(j)
      dir[j] = c
      heap.push(elev[j], j)
    }
  }
}

/** 拓扑序：下游在前 */
function topoOrder(dir: Int32Array, N: number): Int32Array {
  // 从汇开始沿供水者广度优先扩展
  const start = new Int32Array(N + 1)
  for (let i = 0; i < N; i++) if (dir[i] >= 0) start[dir[i] + 1]++
  for (let i = 0; i < N; i++) start[i + 1] += start[i]
  const pos = start.slice(0, N)
  const donors = new Int32Array(N)
  for (let i = 0; i < N; i++) if (dir[i] >= 0) donors[pos[dir[i]]++] = i
  const out = new Int32Array(N)
  let n = 0
  for (let i = 0; i < N; i++) if (dir[i] < 0) out[n++] = i
  for (let q = 0; q < n; q++) {
    const c = out[q]
    for (let k = start[c]; k < start[c + 1]; k++) out[n++] = donors[k]
  }
  return out.subarray(0, n)
}
