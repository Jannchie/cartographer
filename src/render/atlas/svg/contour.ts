/**
 * Marching squares：从格点标量场追踪等值线。
 * 场先外扩两圈（一圈复制边缘值、一圈极小值），保证所有等值线闭合，
 * 这样"场 ≥ level"的区域边界就是若干闭合环，用 evenodd 填充即得正确的区域（含洞）。
 */

export type Ring = Float32Array // 交替 x, y（格坐标，格中心为整数）

// 网格边 → 交点编号的表，跨调用复用（同一张场要追几十个等级）；空闲时全为 -1
let edgeBuf = new Int32Array(0)
function edgeMap(n: number) {
  if (edgeBuf.length < n) edgeBuf = new Int32Array(n).fill(-1)
  return edgeBuf
}

/**
 * 为同一张场追多个等级时预先准备的网格：外扩只做一次，并按 B×B 格分块记下角点的最小/最大值，
 * 追踪时整块跳过不跨越等级的区域。场在网格的生命期内不能被改写。
 */
export interface ContourGrid {
  field: ArrayLike<number>
  W: number
  H: number
  closed: boolean
  g: Float32Array
  /** 每块角点的最小/最大值；块内有 NaN 时为 ±Infinity（不跳过） */
  bmin: Float32Array
  bmax: Float32Array
  BW: number
}
const B = 16

export function contourGrid(field: ArrayLike<number>, W: number, H: number, closed = true): ContourGrid {
  const g = padded(field, W, H, closed)
  const P = closed ? 2 : 0
  const GW = W + P * 2
  const GH = H + P * 2
  // 块 (bx, by) 覆盖格 [bx*B, bx*B+B)，用到的角点是 [bx*B, bx*B+B]
  const BW = Math.ceil((GW - 1) / B)
  const BH = Math.ceil((GH - 1) / B)
  const bmin = new Float32Array(BW * BH)
  const bmax = new Float32Array(BW * BH)
  for (let by = 0; by < BH; by++) {
    const y1 = Math.min(GH - 1, by * B + B)
    for (let bx = 0; bx < BW; bx++) {
      const x1 = Math.min(GW - 1, bx * B + B)
      let mn = Infinity
      let mx = -Infinity
      let nan = false
      for (let y = by * B; y <= y1; y++) {
        for (let i = y * GW + bx * B, e = y * GW + x1; i <= e; i++) {
          const v = g[i]
          if (v < mn) mn = v
          if (v > mx) mx = v
          if (v !== v) nan = true
        }
      }
      bmin[by * BW + bx] = nan ? -Infinity : mn
      bmax[by * BW + bx] = nan ? Infinity : mx
    }
  }
  return { field, W, H, closed, g, bmin, bmax, BW }
}

function padded(field: ArrayLike<number>, W: number, H: number, closed: boolean): Float32Array {
  const P = closed ? 2 : 0
  const GW = W + P * 2
  const GH = H + P * 2
  const g = new Float32Array(GW * GH)
  const LOW = -1e9
  if (closed && ArrayBuffer.isView(field)) {
    // 按行整段拷贝：外圈 LOW，内圈复制边缘值
    const src = field as unknown as Float32Array
    for (let y = 0; y < GH; y++) {
      const row = y * GW
      if (y === 0 || y === GH - 1) {
        g.fill(LOW, row, row + GW)
        continue
      }
      const s = Math.min(H - 1, Math.max(0, y - P)) * W
      g[row] = LOW
      g[row + 1] = src[s]
      g.set(src.subarray(s, s + W), row + P)
      g[row + P + W] = src[s + W - 1]
      g[row + GW - 1] = LOW
    }
  } else {
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        let v: number
        if (closed && (x === 0 || y === 0 || x === GW - 1 || y === GH - 1)) v = LOW
        else {
          const sx = Math.min(W - 1, Math.max(0, x - P))
          const sy = Math.min(H - 1, Math.max(0, y - P))
          v = field[sy * W + sx]
        }
        g[y * GW + x] = v
      }
    }
  }
  return g
}

export function contours(field: ArrayLike<number>, W: number, H: number, level: number, closed = true, grid?: ContourGrid): Ring[] {
  if (grid && (grid.field !== field || grid.W !== W || grid.H !== H || grid.closed !== closed)) grid = undefined
  const P = closed ? 2 : 0
  const GW = W + P * 2
  const GH = H + P * 2
  const g = grid ? grid.g : padded(field, W, H, closed)
  // 每条网格边上的交点：水平边 id = (y*GW+x)*2，竖直边 +1。
  // 交点按首次出现的顺序编号，坐标与邻接（每个交点最多连两个）存在按编号增长的类型化数组里
  const ptOf = edgeMap(GW * GH * 2)
  let cap = 1024
  let ptX = new Float64Array(cap)
  let ptY = new Float64Array(cap)
  let nb0 = new Int32Array(cap)
  let nb1 = new Int32Array(cap)
  let eid = new Int32Array(cap)
  let np = 0
  const edgePoint = (id: number, x0: number, y0: number, x1: number, y1: number, a: number, b: number) => {
    let p = ptOf[id]
    if (p < 0) {
      if (np === cap) {
        cap *= 2
        const grow = <T extends Float64Array | Int32Array>(src: T, dst: T) => (dst.set(src), dst)
        ptX = grow(ptX, new Float64Array(cap))
        ptY = grow(ptY, new Float64Array(cap))
        nb0 = grow(nb0, new Int32Array(cap))
        nb1 = grow(nb1, new Int32Array(cap))
        eid = grow(eid, new Int32Array(cap))
      }
      p = ptOf[id] = np++
      eid[p] = id
      const t = (level - a) / (b - a)
      ptX[p] = x0 + (x1 - x0) * t - P
      ptY[p] = y0 + (y1 - y0) * t - P
      nb0[p] = nb1[p] = -1
    }
    return p
  }
  const link = (a: number, b: number) => {
    if (nb0[a] < 0) nb0[a] = b
    else nb1[a] = b
  }
  const addSeg = (a: number, b: number) => {
    link(a, b)
    link(b, a)
  }
  for (let y = 0; y < GH - 1; y++) {
    const brow = grid ? ((y / B) | 0) * grid.BW : 0
    for (let x = 0; x < GW - 1; x++) {
      // 仍按行优先扫描（交点编号顺序不变），只是整段跳过全在等级之上或之下的块
      if (grid && (x & (B - 1)) === 0) {
        const b = brow + ((x / B) | 0)
        if (grid.bmax[b] < level || grid.bmin[b] >= level) {
          x += B - 1
          continue
        }
      }
      const i = y * GW + x
      const tl = g[i]
      const tr = g[i + 1]
      const bl = g[i + GW]
      const br = g[i + GW + 1]
      const c = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0)
      if (c === 0 || c === 15) continue
      switch (c) {
        case 1:
        case 14:
          addSeg(edgePoint(i * 2 + 1, x, y, x, y + 1, tl, bl), edgePoint((i + GW) * 2, x, y + 1, x + 1, y + 1, bl, br))
          break
        case 2:
        case 13:
          addSeg(edgePoint((i + GW) * 2, x, y + 1, x + 1, y + 1, bl, br), edgePoint((i + 1) * 2 + 1, x + 1, y, x + 1, y + 1, tr, br))
          break
        case 3:
        case 12:
          addSeg(edgePoint(i * 2 + 1, x, y, x, y + 1, tl, bl), edgePoint((i + 1) * 2 + 1, x + 1, y, x + 1, y + 1, tr, br))
          break
        case 4:
        case 11:
          addSeg(edgePoint(i * 2, x, y, x + 1, y, tl, tr), edgePoint((i + 1) * 2 + 1, x + 1, y, x + 1, y + 1, tr, br))
          break
        case 6:
        case 9:
          addSeg(edgePoint(i * 2, x, y, x + 1, y, tl, tr), edgePoint((i + GW) * 2, x, y + 1, x + 1, y + 1, bl, br))
          break
        case 7:
        case 8:
          addSeg(edgePoint(i * 2 + 1, x, y, x, y + 1, tl, bl), edgePoint(i * 2, x, y, x + 1, y, tl, tr))
          break
        case 5:
        case 10: {
          // 鞍点：按中心均值消歧（交点按连线顺序创建，保持编号顺序）
          const center = (tl + tr + bl + br) / 4 >= level
          const left = edgePoint(i * 2 + 1, x, y, x, y + 1, tl, bl)
          if ((c === 5) === center) {
            addSeg(left, edgePoint(i * 2, x, y, x + 1, y, tl, tr))
            addSeg(edgePoint((i + GW) * 2, x, y + 1, x + 1, y + 1, bl, br), edgePoint((i + 1) * 2 + 1, x + 1, y, x + 1, y + 1, tr, br))
          } else {
            addSeg(left, edgePoint((i + GW) * 2, x, y + 1, x + 1, y + 1, bl, br))
            addSeg(edgePoint(i * 2, x, y, x + 1, y, tl, tr), edgePoint((i + 1) * 2 + 1, x + 1, y, x + 1, y + 1, tr, br))
          }
          break
        }
      }
    }
  }
  // 复用的边表只复位用过的项
  for (let p = 0; p < np; p++) ptOf[eid[p]] = -1
  // 串成折线
  const rings: Ring[] = []
  const used = new Uint8Array(np)
  const walk = (start: number) => {
    const pts: number[] = []
    let prev = -1
    let cur = start
    for (;;) {
      used[cur] = 1
      pts.push(ptX[cur], ptY[cur])
      let next = -1
      const a = nb0[cur]
      const b = nb1[cur]
      if (a >= 0 && a !== prev && !used[a]) next = a
      if (b >= 0 && b !== prev && !used[b]) next = b
      if (next < 0) break
      prev = cur
      cur = next
    }
    return Float32Array.from(pts)
  }
  // 先从端点（只有一个邻居）出发走开放折线，再处理闭合环
  for (let p = 0; p < np; p++) if (nb1[p] < 0 && !used[p]) rings.push(walk(p))
  for (let p = 0; p < np; p++) if (!used[p]) rings.push(walk(p))
  return rings
}

/** Douglas–Peucker 简化（格单位容差） */
export function simplify(r: Ring, tol: number): Ring {
  const n = r.length / 2
  if (n < 4) return r
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  const t2 = tol * tol
  while (stack.length) {
    const [a, b] = stack.pop()!
    const ax = r[a * 2], ay = r[a * 2 + 1]
    const bx = r[b * 2], by = r[b * 2 + 1]
    const dx = bx - ax, dy = by - ay
    const L = dx * dx + dy * dy
    let best = -1
    let bd = t2
    for (let i = a + 1; i < b; i++) {
      const px = r[i * 2] - ax, py = r[i * 2 + 1] - ay
      let d: number
      if (L === 0) d = px * px + py * py
      else {
        const c = px * dy - py * dx
        d = (c * c) / L
      }
      if (d > bd) {
        bd = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[i * 2], r[i * 2 + 1])
  return Float32Array.from(out)
}

/** 环的有向面积绝对值（格²） */
export function ringArea(r: Ring) {
  let a = 0
  const n = r.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1]
  }
  return Math.abs(a / 2)
}

/** 平滑时拐角最多削掉多少（格）：更长的线段两头各削这么多，中间直连 */
const SMOOTH_CUT = 3

/**
 * 转成 SVG path 数据。格坐标 → 画布像素：px = (g + 0.5) * S。
 * 用二次贝塞尔经过各边中点，让折线变成平滑曲线。
 */
export function pathData(rings: Ring[], S: number, opt: { closed: boolean; tol?: number; minArea?: number; smooth?: boolean } = { closed: true }): string {
  const tol = opt.tol ?? 0.3
  const parts: string[] = []
  const f = (v: number) => (Math.round(((v + 0.5) * S) * 10) / 10).toString()
  for (const raw of rings) {
    if (opt.minArea && opt.closed && ringArea(raw) < opt.minArea) continue
    const rs = simplify(raw, tol)
    const ns = rs.length / 2
    if (ns < 2) continue
    const isClosed = opt.closed && Math.hypot(rs[0] - rs[(ns - 1) * 2], rs[1] - rs[(ns - 1) * 2 + 1]) < 1.01
    if (opt.smooth === false || ns < 3) {
      let d = `M${f(rs[0])} ${f(rs[1])}`
      for (let i = 1; i < ns; i++) d += `L${f(rs[i * 2])} ${f(rs[i * 2 + 1])}`
      parts.push(isClosed ? d + 'Z' : d)
      continue
    }
    // 中点二次贝塞尔平滑：拐角处从上一段的中点经拐点画到下一段的中点。
    // 长线段（超过 2·SMOOTH_CUT 格）两头各只削 SMOOTH_CUT 格、中间直连——否则贴着图框走的长直边在图角一拐弯，
    // 曲线从长边的中点连到长边的中点，斜穿半张地图（奇偶填充下成了一道交叉的楔形）
    const r = rs
    const n = ns
    const px = (i: number) => r[i * 2]
    const py = (i: number) => r[i * 2 + 1]
    /** 线段 i→j 上离 i 端 min(半段, SMOOTH_CUT) 处的点 */
    const near = (i: number, j: number): [number, number] => {
      const dx = px(j) - px(i)
      const dy = py(j) - py(i)
      const L = Math.sqrt(dx * dx + dy * dy)
      const t = L > SMOOTH_CUT * 2 ? SMOOTH_CUT / L : 0.5
      return [px(i) + dx * t, py(i) + dy * t]
    }
    const long = (i: number, j: number) => Math.hypot(px(j) - px(i), py(j) - py(i)) > SMOOTH_CUT * 2
    const P = (p: [number, number]) => `${f(p[0])} ${f(p[1])}`
    if (isClosed) {
      let d = `M${P(near(0, 1))}`
      for (let i = 1; i <= n; i++) {
        const a = i % n
        const prev = i - 1
        const b = (i + 1) % n
        if (long(prev, a)) d += `L${P(near(a, prev))}`
        d += `Q${f(px(a))} ${f(py(a))} ${P(near(a, b))}`
      }
      parts.push(d + 'Z')
    } else {
      let d = `M${f(px(0))} ${f(py(0))}`
      for (let i = 1; i < n - 1; i++) {
        if (long(i - 1, i)) d += `L${P(near(i, i - 1))}`
        d += `Q${f(px(i))} ${f(py(i))} ${P(near(i, i + 1))}`
      }
      d += `L${f(px(n - 1))} ${f(py(n - 1))}`
      parts.push(d)
    }
  }
  return parts.join('')
}

/**
 * 分类栅格的分界线：取相邻两格类别不同（且都 ≥ 0）的公共边，
 * 在格角点处串联成折线，三国交界点处断开。适合画国界（止于海岸，不会绕岸一圈）。
 */
export function categoryBorders(cat: ArrayLike<number>, W: number, H: number): Ring[] {
  const CW = W + 1
  const adj = new Map<number, number[]>()
  const add = (a: number, b: number) => {
    let l = adj.get(a)
    if (!l) adj.set(a, (l = []))
    l.push(b)
    let m = adj.get(b)
    if (!m) adj.set(b, (m = []))
    m.push(a)
  }
  // 角点 (cx, cy) 位于格 (cx-0.5, cy-0.5)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = cat[y * W + x]
      if (a < 0) continue
      if (x + 1 < W) {
        const b = cat[y * W + x + 1]
        if (b >= 0 && b !== a) add(y * CW + x + 1, (y + 1) * CW + x + 1)
      }
      if (y + 1 < H) {
        const b = cat[(y + 1) * W + x]
        if (b >= 0 && b !== a) add((y + 1) * CW + x, (y + 1) * CW + x + 1)
      }
    }
  }
  const usedEdge = new Set<string>()
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)
  const out: Ring[] = []
  const toXY = (c: number, pts: number[]) => pts.push((c % CW) - 0.5, Math.floor(c / CW) - 0.5)
  const walk = (start: number, next: number) => {
    const pts: number[] = []
    toXY(start, pts)
    let prev = start
    let cur = next
    usedEdge.add(key(prev, cur))
    for (;;) {
      toXY(cur, pts)
      const nb = adj.get(cur)!
      if (nb.length !== 2) break
      const n = nb[0] === prev ? nb[1] : nb[0]
      if (usedEdge.has(key(cur, n))) break
      usedEdge.add(key(cur, n))
      prev = cur
      cur = n
    }
    out.push(Float32Array.from(pts))
  }
  for (const [c, nb] of adj) if (nb.length !== 2) for (const n of nb) if (!usedEdge.has(key(c, n))) walk(c, n)
  for (const [c, nb] of adj) for (const n of nb) if (!usedEdge.has(key(c, n))) walk(c, n)
  return out
}
