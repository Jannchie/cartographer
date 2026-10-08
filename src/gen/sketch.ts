import { highlandField, RANGE_HI } from './areas'
import type { SketchRange, WorldSketch } from './types'
import { edt, signedDistance, simplifyLine } from './util'
import * as dmath from './dmath'

/**
 * 从零规划的草图：陆地意图掩码 + 山脉折线。
 * 生成时把草图换算成两类场：到草图海岸线的有符号距离（决定海陆，海岸细节再叠噪声），
 * 与沿山脉折线的隆起（决定造山带走向，峰谷细节再叠脊状噪声）。
 */

export const RANGE_DEFAULT = { height: 1, width: 140 }

export interface SketchFields {
  /** 到草图海岸线的有符号距离（格），陆地为正 */
  coast: Float32Array
  /** 主脊：各山脉 height·exp(-(d/w)²) 的最大值 */
  ridge: Float32Array
  /** 山体两侧的高原：同上，宽度放大 3.2 倍 */
  plateau: Float32Array
}

export function sketchFields(s: WorldSketch, W: number, H: number, kmPerCell: number): SketchFields {
  const N = W * H
  const land = new Uint8Array(N)
  for (let i = 0; i < N; i++) land[i] = s.land[i] >= 0.5 ? 1 : 0
  const coast = signedDistance(land, W, H)
  const ridge = new Float32Array(N)
  const plateau = new Float32Array(N)
  for (const r of s.ranges) {
    if (r.pts.length < 2) continue
    const w = Math.max(1.5, r.width / kmPerCell)
    // 高原项在 2.2 倍宽度处已小于 1%
    const R = Math.ceil(w * 3.2 * 2.2)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let k = 0; k < r.pts.length; k += 2) {
      x0 = Math.min(x0, r.pts[k])
      x1 = Math.max(x1, r.pts[k])
      y0 = Math.min(y0, r.pts[k + 1])
      y1 = Math.max(y1, r.pts[k + 1])
    }
    const bx0 = Math.max(0, Math.floor(x0 - R)), bx1 = Math.min(W - 1, Math.ceil(x1 + R))
    const by0 = Math.max(0, Math.floor(y0 - R)), by1 = Math.min(H - 1, Math.ceil(y1 + R))
    if (bx1 < bx0 || by1 < by0) continue
    const bw = bx1 - bx0 + 1
    const bh = by1 - by0 + 1
    // 在包围盒里栅格化折线，再求到折线的距离
    const m = new Uint8Array(bw * bh)
    const mark = (x: number, y: number) => {
      const cx = Math.round(x) - bx0
      const cy = Math.round(y) - by0
      if (cx >= 0 && cy >= 0 && cx < bw && cy < bh) m[cy * bw + cx] = 1
    }
    mark(r.pts[0], r.pts[1])
    for (let k = 2; k < r.pts.length; k += 2) {
      const ax = r.pts[k - 2], ay = r.pts[k - 1], bx = r.pts[k], by = r.pts[k + 1]
      const n = Math.max(1, Math.ceil(dmath.hypot(bx - ax, by - ay) * 2))
      for (let j = 1; j <= n; j++) mark(ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n)
    }
    const d = edt(m, bw, bh)
    const h = r.height
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const dd = d[y * bw + x]
        const i = (y + by0) * W + x + bx0
        const a = dd / w
        const b = dd / (w * 3.2)
        const g = h * dmath.exp(-(a * a))
        const p = h * dmath.exp(-(b * b))
        if (g > ridge[i]) ridge[i] = g
        if (p > plateau[i]) plateau[i] = p
      }
    }
  }
  return { coast, ridge, plateau }
}

/** 场的双线性采样（越界取边缘） */
export function sampleField(f: Float32Array, W: number, H: number, x: number, y: number) {
  x = Math.min(W - 1.001, Math.max(0, x))
  y = Math.min(H - 1.001, Math.max(0, y))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  const i = y0 * W + x0
  return (f[i] * (1 - tx) + f[i + 1] * tx) * (1 - ty) + (f[i + W] * (1 - tx) + f[i + W + 1] * tx) * ty
}

/** 圆形软画笔：把陆地意图推向 target（1 陆地、0 海洋） */
export function paintLand(land: Float32Array, W: number, H: number, cx: number, cy: number, R: number, target: number, amount: number) {
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R))
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (R * R)
      if (d2 >= 1) continue
      // 中心实、边缘软：画笔内大半径范围直接到位，边缘过渡
      const f = Math.min(1, (1 - d2) * 3) * amount
      const i = y * W + x
      land[i] += (target - land[i]) * f
    }
  }
  return { x0, y0, x1, y1 }
}

/** 套索：多边形（交替存储的格坐标）内部按奇偶规则填成 value */
export function fillPolygon(land: Float32Array, W: number, H: number, poly: number[], value: number) {
  const n = poly.length / 2
  if (n < 3) return null
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity
  for (let k = 0; k < n; k++) {
    x0 = Math.min(x0, poly[k * 2])
    x1 = Math.max(x1, poly[k * 2])
    y0 = Math.min(y0, poly[k * 2 + 1])
    y1 = Math.max(y1, poly[k * 2 + 1])
  }
  const ys = Math.max(0, Math.floor(y0)), ye = Math.min(H - 1, Math.ceil(y1))
  const xs: number[] = []
  for (let y = ys; y <= ye; y++) {
    const cy = y + 0.5
    xs.length = 0
    for (let k = 0; k < n; k++) {
      const ax = poly[k * 2], ay = poly[k * 2 + 1]
      const bx = poly[((k + 1) % n) * 2], by = poly[((k + 1) % n) * 2 + 1]
      if ((ay <= cy) === (by <= cy)) continue
      xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5))
      for (let x = a; x <= b; x++) land[y * W + x] = value
    }
  }
  return { x0: Math.max(0, Math.floor(x0)), y0: ys, x1: Math.min(W - 1, Math.ceil(x1)), y1: ye }
}


/** 屏幕/格坐标下点到折线的最近距离与最近的顶点 */
export function nearestOnLine(pts: number[], x: number, y: number) {
  let dist = Infinity
  let vertex = -1
  let vd = Infinity
  for (let k = 0; k < pts.length; k += 2) {
    const d = dmath.hypot(pts[k] - x, pts[k + 1] - y)
    if (d < vd) {
      vd = d
      vertex = k / 2
    }
    if (k === 0) {
      dist = d
      continue
    }
    const ax = pts[k - 2], ay = pts[k - 1], bx = pts[k], by = pts[k + 1]
    const L2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay) || 1e-9
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2))
    dist = Math.min(dist, dmath.hypot(ax + (bx - ax) * t - x, ay + (by - ay) * t - y))
  }
  return { dist, vertex, vertexDist: vd }
}

/**
 * 以现有世界为底稿：海陆照搬；高地按连通块取出脊线（沿主轴分段求质心），
 * 宽度取自横向离散度、高度取自平均海拔，这样换成草图后山脉大致还在原处。
 */
export function sketchFromWorld(elev: Float32Array, W: number, H: number, kmPerCell: number): WorldSketch {
  const N = W * H
  const land = new Float32Array(N)
  for (let i = 0; i < N; i++) land[i] = elev[i] > 0 ? 1 : 0
  const hi = highlandField(elev, W, H)
  const seen = new Uint8Array(N)
  const ranges: SketchRange[] = []
  const comps: number[][] = []
  for (let s = 0; s < N; s++) {
    if (seen[s] || hi[s] <= RANGE_HI) continue
    const cells: number[] = []
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const c = stack.pop()!
      cells.push(c)
      const x = c % W
      for (const j of [c - 1, c + 1, c - W, c + W]) {
        if (j < 0 || j >= N || (j === c - 1 && x === 0) || (j === c + 1 && x === W - 1)) continue
        if (seen[j] || hi[j] <= RANGE_HI) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    if (cells.length >= 120) comps.push(cells)
  }
  comps.sort((a, b) => b.length - a.length)
  for (const cells of comps.slice(0, 16)) {
    let mx = 0, my = 0, mh = 0
    for (const c of cells) {
      mx += c % W
      my += Math.floor(c / W)
      mh += elev[c]
    }
    mx /= cells.length
    my /= cells.length
    mh /= cells.length
    let sxx = 0, syy = 0, sxy = 0
    for (const c of cells) {
      const x = (c % W) - mx
      const y = Math.floor(c / W) - my
      sxx += x * x
      syy += y * y
      sxy += x * y
    }
    const ang = 0.5 * dmath.atan2(2 * sxy, sxx - syy)
    const ux = dmath.cos(ang), uy = dmath.sin(ang)
    // 沿主轴分段，每段取质心连成脊线
    let lo = Infinity, hiT = -Infinity
    for (const c of cells) {
      const t = ((c % W) - mx) * ux + (Math.floor(c / W) - my) * uy
      lo = Math.min(lo, t)
      hiT = Math.max(hiT, t)
    }
    const segs = Math.max(2, Math.min(12, Math.round((hiT - lo) / 14)))
    const sx = new Float64Array(segs), sy = new Float64Array(segs), sn = new Float64Array(segs)
    let spread = 0
    for (const c of cells) {
      const x = c % W, y = Math.floor(c / W)
      const t = (x - mx) * ux + (y - my) * uy
      const k = Math.min(segs - 1, Math.floor(((t - lo) / (hiT - lo + 1e-9)) * segs))
      sx[k] += x
      sy[k] += y
      sn[k]++
      const v = -(x - mx) * uy + (y - my) * ux
      spread += v * v
    }
    const pts: number[] = []
    for (let k = 0; k < segs; k++) if (sn[k] > 0) pts.push(sx[k] / sn[k], sy[k] / sn[k])
    if (pts.length < 2) continue
    const sigma = Math.sqrt(spread / cells.length)
    ranges.push({
      pts: simplifyLine(pts, 1.5),
      height: Math.round(Math.min(2, Math.max(0.4, mh / 2.4)) * 20) / 20,
      width: Math.round(Math.max(40, Math.min(400, sigma * 1.2 * kmPerCell)) / 10) * 10,
    })
  }
  return { land, ranges }
}

let revSeq = 0
/**
 * 草图改过：换一个从未用过的版本号（生成线程按版本号缓存造山结果）。
 * 单调递增而不是在原值上加一：撤销回旧版本后再改，不会撞上缓存里另一份草图的版本号
 */
export function bumpSketch(e: { sketchRev?: number }) {
  revSeq = Math.max(revSeq, e.sketchRev ?? 0) + 1
  e.sketchRev = revSeq
}

