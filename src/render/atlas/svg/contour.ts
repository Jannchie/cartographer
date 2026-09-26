/**
 * Marching squares：从格点标量场追踪等值线。
 * 场先外扩两圈（一圈复制边缘值、一圈极小值），保证所有等值线闭合，
 * 这样"场 ≥ level"的区域边界就是若干闭合环，用 evenodd 填充即得正确的区域（含洞）。
 */

export type Ring = Float32Array // 交替 x, y（格坐标，格中心为整数）

export function contours(field: ArrayLike<number>, W: number, H: number, level: number, closed = true): Ring[] {
  // 外扩
  const P = closed ? 2 : 0
  const GW = W + P * 2
  const GH = H + P * 2
  const g = new Float32Array(GW * GH)
  const LOW = -1e9
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
  // 每条网格边上的交点：水平边 id = (y*GW+x)*2，竖直边 +1
  const ptX = new Map<number, number>()
  const ptY = new Map<number, number>()
  const edgePoint = (id: number, x0: number, y0: number, x1: number, y1: number, a: number, b: number) => {
    if (!ptX.has(id)) {
      const t = (level - a) / (b - a)
      ptX.set(id, x0 + (x1 - x0) * t - P)
      ptY.set(id, y0 + (y1 - y0) * t - P)
    }
    return id
  }
  // 线段邻接：每个交点最多连两个
  const link = new Map<number, number[]>()
  const addSeg = (a: number, b: number) => {
    let la = link.get(a)
    if (!la) link.set(a, (la = []))
    la.push(b)
    let lb = link.get(b)
    if (!lb) link.set(b, (lb = []))
    lb.push(a)
  }
  for (let y = 0; y < GH - 1; y++) {
    for (let x = 0; x < GW - 1; x++) {
      const i = y * GW + x
      const tl = g[i]
      const tr = g[i + 1]
      const bl = g[i + GW]
      const br = g[i + GW + 1]
      const c = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0)
      if (c === 0 || c === 15) continue
      const top = () => edgePoint(i * 2, x, y, x + 1, y, tl, tr)
      const bottom = () => edgePoint((i + GW) * 2, x, y + 1, x + 1, y + 1, bl, br)
      const left = () => edgePoint(i * 2 + 1, x, y, x, y + 1, tl, bl)
      const right = () => edgePoint((i + 1) * 2 + 1, x + 1, y, x + 1, y + 1, tr, br)
      switch (c) {
        case 1:
        case 14:
          addSeg(left(), bottom())
          break
        case 2:
        case 13:
          addSeg(bottom(), right())
          break
        case 3:
        case 12:
          addSeg(left(), right())
          break
        case 4:
        case 11:
          addSeg(top(), right())
          break
        case 6:
        case 9:
          addSeg(top(), bottom())
          break
        case 7:
        case 8:
          addSeg(left(), top())
          break
        case 5:
        case 10: {
          // 鞍点：按中心均值消歧
          const center = (tl + tr + bl + br) / 4 >= level
          if ((c === 5) === center) {
            addSeg(left(), top())
            addSeg(bottom(), right())
          } else {
            addSeg(left(), bottom())
            addSeg(top(), right())
          }
          break
        }
      }
    }
  }
  // 串成折线
  const rings: Ring[] = []
  const used = new Set<number>()
  const walk = (start: number) => {
    const pts: number[] = []
    let prev = -1
    let cur = start
    for (;;) {
      used.add(cur)
      pts.push(ptX.get(cur)!, ptY.get(cur)!)
      const nb = link.get(cur)!
      let next = -1
      for (const n of nb) if (n !== prev && !used.has(n)) next = n
      if (next < 0) break
      prev = cur
      cur = next
    }
    return pts
  }
  // 先从端点（只有一个邻居）出发走开放折线，再处理闭合环
  for (const [id, nb] of link) if (nb.length === 1 && !used.has(id)) rings.push(Float32Array.from(walk(id)))
  for (const id of link.keys()) if (!used.has(id)) rings.push(Float32Array.from(walk(id)))
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
    const r = simplify(raw, tol)
    const n = r.length / 2
    if (n < 2) continue
    const isClosed = opt.closed && Math.hypot(r[0] - r[(n - 1) * 2], r[1] - r[(n - 1) * 2 + 1]) < 1.01
    if (opt.smooth === false || n < 3) {
      let d = `M${f(r[0])} ${f(r[1])}`
      for (let i = 1; i < n; i++) d += `L${f(r[i * 2])} ${f(r[i * 2 + 1])}`
      parts.push(isClosed ? d + 'Z' : d)
      continue
    }
    // 中点二次贝塞尔平滑
    const mid = (i: number, j: number, k: 0 | 1) => (r[i * 2 + k] + r[j * 2 + k]) / 2
    if (isClosed) {
      let d = `M${f(mid(0, 1, 0))} ${f(mid(0, 1, 1))}`
      for (let i = 1; i <= n; i++) {
        const a = i % n
        const b = (i + 1) % n
        d += `Q${f(r[a * 2])} ${f(r[a * 2 + 1])} ${f(mid(a, b, 0))} ${f(mid(a, b, 1))}`
      }
      parts.push(d + 'Z')
    } else {
      let d = `M${f(r[0])} ${f(r[1])}`
      for (let i = 1; i < n - 1; i++) d += `Q${f(r[i * 2])} ${f(r[i * 2 + 1])} ${f(mid(i, i + 1, 0))} ${f(mid(i, i + 1, 1))}`
      d += `L${f(r[(n - 1) * 2])} ${f(r[(n - 1) * 2 + 1])}`
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
