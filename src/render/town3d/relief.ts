/**
 * 沙盘的地形网格与水岸数据（纯数据，在 Worker 中与体块一起构建）。
 *
 * 网格：地形格网（5 米）的高程，大城隔格取样（粗网格约 20 万顶点以内）；岸线、护城河与池塘附近的粗格
 * 再细分到约 1.25 米（顶点多时 2.5 米），细格的高程由格网三次插值。粗细交界处的粗格改成绕中心的扇形，
 * 把邻格边上的细顶点都接上，没有裂缝。
 *
 * 岸线：陆上的顶点不低于水面、水里的顶点不高于水面，分界取到水距离场（先抹平格网的阶梯）的零线，
 * 细网格上水面与地形的交线就是一条顺滑的岸线。水面网格与地形共用顶点（只取可能有水的三角形），
 * 水深在顶点着色器里由"水面高度 − 地面高度"得到，岸线、深浅与几何完全一致。
 *
 * 下刻：护城河沿河道、池塘按轮廓把地面刻下去，各有自己的水面高度（就近地面略低）。
 * 下刻量带生卒（跟随城墙、园林），着色器按人口收放。
 */
import type { P, Poly } from '../../settlement/geom'
import type { Life } from '../../settlement/history'
import type { Settlement } from '../../settlement/types'
import { NEVER } from './mesh'

/** 水面高度（米）：河、海都在海平面附近，河床刻在地形里 */
export const WATER_LEVEL = -0.1

export interface TerrainMesh {
  /** 顶点位置（米，未下刻）、法线（Int8 归一化）、三角形下标 */
  pos: Float32Array
  nrm: Int8Array
  idx: Uint32Array
  /** 每顶点 (下刻的高度差 ≤ 0, 出生人口, 消亡人口, 就近的水面高度) */
  carve: Float32Array
  /** 下刻生效时的法线（没有下刻的顶点与 nrm 相同） */
  nrm2: Int8Array
  /** 可能有水的三角形（有顶点低于就近水面，或带下刻）：水面网格的下标 */
  wet: Uint32Array
  /** 四周的边缘顶点（x, y, z 交错）：从西北角起沿北、东、南、西各边走一圈，首尾是同一点 */
  rim: Float32Array
  /**
   * 水岸贴图（RGBA，尺寸同地形格网）：R 到水距离（米，水中为负）：岸上与离岸 16 米以内为 128 − 4·距离（0.25 米一级），
   * 再往水里为 192 + 0.6·(离岸 − 16)，到约 120 米（海面的涌浪带要知道离岸多远）；
   * G 开阔水面（海、湖）的远近，1 为海边；B、A 水流方向的倍角 (cos 2φ, sin 2φ) × 0.5 + 0.5
   */
  shore: Uint8Array
}

/** 粗网格的顶点上限、细分顶点的上限 */
const COARSE_MAX = 200000
const FINE_MAX = 160000
/** 护城河：水面在两岸地面以下多少、河底在水面以下多少（米） */
const MOAT_FREEBOARD = 0.6
const MOAT_DEPTH = 1.1
const POND_FREEBOARD = 0.3
const POND_DEPTH = 0.7

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 3 × 3 二项式平滑（可分离的 1-2-1），边上取边值；tmp 为同样大小的暂存，结果写回 f */
function smooth(f: Float32Array, tmp: Float32Array, W: number, H: number) {
  for (let j = 0; j < H; j++) {
    const o = j * W
    tmp[o] = (3 * f[o] + f[o + 1]) / 4
    for (let k = o + 1, e = o + W - 1; k < e; k++) tmp[k] = (f[k - 1] + 2 * f[k] + f[k + 1]) / 4
    tmp[o + W - 1] = (f[o + W - 2] + 3 * f[o + W - 1]) / 4
  }
  for (let i = 0; i < W; i++) {
    f[i] = (3 * tmp[i] + tmp[i + W]) / 4
    const o = (H - 1) * W + i
    f[o] = (tmp[o - W] + 3 * tmp[o]) / 4
  }
  for (let j = 1; j < H - 1; j++) for (let k = j * W, e = k + W; k < e; k++) f[k] = (tmp[k - W] + 2 * tmp[k] + tmp[k + W]) / 4
}

/**
 * 格网上的三次（Catmull-Rom）插值：格点处等于格点值，格间连续可导。
 * 高程与到水距离同一点一起取（权重只算一遍），结果放在 out 里
 */
function cubicPair(f: Float32Array, g: Float32Array, W: number, H: number, cell: number, out: Float64Array) {
  const inv = 1 / cell
  return (x: number, z: number) => {
    let gx = x * inv
    let gz = z * inv
    if (gx < 0) gx = 0
    else if (gx > W - 1) gx = W - 1
    if (gz < 0) gz = 0
    else if (gz > H - 1) gz = H - 1
    const i = gx >= W - 1 ? W - 2 : Math.floor(gx)
    const j = gz >= H - 1 ? H - 2 : Math.floor(gz)
    const u = gx - i
    const v = gz - j
    const u2 = u * u
    const u3 = u2 * u
    const v2 = v * v
    const v3 = v2 * v
    const a0 = -0.5 * u3 + u2 - 0.5 * u
    const a1 = 1.5 * u3 - 2.5 * u2 + 1
    const a2 = -1.5 * u3 + 2 * u2 + 0.5 * u
    const a3 = 0.5 * u3 - 0.5 * u2
    const b0 = -0.5 * v3 + v2 - 0.5 * v
    const b1 = 1.5 * v3 - 2.5 * v2 + 1
    const b2 = -1.5 * v3 + 2 * v2 + 0.5 * v
    const b3 = 0.5 * v3 - 0.5 * v2
    const i0 = i > 0 ? i - 1 : 0
    const i3 = i < W - 2 ? i + 2 : W - 1
    const r0 = (j > 0 ? j - 1 : 0) * W
    const r1 = j * W
    const r2 = r1 + W
    const r3 = (j < H - 2 ? j + 2 : H - 1) * W
    out[0] =
      b0 * (a0 * f[r0 + i0] + a1 * f[r0 + i] + a2 * f[r0 + i + 1] + a3 * f[r0 + i3]) +
      b1 * (a0 * f[r1 + i0] + a1 * f[r1 + i] + a2 * f[r1 + i + 1] + a3 * f[r1 + i3]) +
      b2 * (a0 * f[r2 + i0] + a1 * f[r2 + i] + a2 * f[r2 + i + 1] + a3 * f[r2 + i3]) +
      b3 * (a0 * f[r3 + i0] + a1 * f[r3 + i] + a2 * f[r3 + i + 1] + a3 * f[r3 + i3])
    out[1] =
      b0 * (a0 * g[r0 + i0] + a1 * g[r0 + i] + a2 * g[r0 + i + 1] + a3 * g[r0 + i3]) +
      b1 * (a0 * g[r1 + i0] + a1 * g[r1 + i] + a2 * g[r1 + i + 1] + a3 * g[r1 + i3]) +
      b2 * (a0 * g[r2 + i0] + a1 * g[r2 + i] + a2 * g[r2 + i + 1] + a3 * g[r2 + i3]) +
      b3 * (a0 * g[r3 + i0] + a1 * g[r3 + i] + a2 * g[r3 + i + 1] + a3 * g[r3 + i3])
  }
}

/** 点到线段的距离；垂足参数（未截断）、线段长与到所在直线的垂距留在 seg 里 */
const seg = { t: 0, L: 0, perp: 0 }
function segDist(px: number, pz: number, a: P, b: P) {
  const ex = b[0] - a[0]
  const ez = b[1] - a[1]
  const L2 = ex * ex + ez * ez || 1e-9
  const t = ((px - a[0]) * ex + (pz - a[1]) * ez) / L2
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = px - a[0] - ex * c
  const dz = pz - a[1] - ez * c
  seg.t = t
  seg.L = Math.sqrt(L2)
  seg.perp = Math.abs((px - a[0]) * ez - (pz - a[1]) * ex) / seg.L
  return Math.sqrt(dx * dx + dz * dz)
}

/** 折线抽稀：每段不超过 span 米，略去的点离所在的弦不超过 tol 米 */
function thin(line: P[], span: number, tol: number): P[] {
  const out: P[] = [line[0]]
  let a = 0
  for (let c = 2; c <= line.length; c++) {
    let ok = c < line.length && Math.hypot(line[c][0] - line[a][0], line[c][1] - line[a][1]) <= span
    for (let k = a + 1; ok && k < c; k++) {
      segDist(line[k][0], line[k][1], line[a], line[c])
      if (seg.perp > tol) ok = false
    }
    if (ok) continue
    out.push(line[c - 1])
    a = c - 1
  }
  return out
}

function densify(line: P[], step: number): P[] {
  const out: P[] = [line[0]]
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1]
    const b = line[k]
    const m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let q = 1; q <= m; q++) out.push([a[0] + ((b[0] - a[0]) * q) / m, a[1] + ((b[1] - a[1]) * q) / m])
  }
  return out
}

function inPoly(px: number, pz: number, poly: Poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a[1] > pz !== b[1] > pz && px < ((b[0] - a[0]) * (pz - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** 到多边形边界的有向距离（内部为正） */
function polyDepth(px: number, pz: number, poly: Poly) {
  let d = Infinity
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(px, pz, poly[i], poly[(i + 1) % poly.length]))
  return inPoly(px, pz, poly) ? d : -d
}

function polyArea(poly: Poly) {
  let a = 0
  let per = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    a += p[0] * q[1] - q[0] * p[1]
    per += Math.hypot(q[0] - p[0], q[1] - p[1])
  }
  return { area: Math.abs(a) / 2, per }
}

export function terrainMesh(st: Settlement, life: Map<object, Life>): TerrainMesh {
  const T = st.terrain
  const { W, H, cell } = T
  const sdf = T.water.slice()
  smooth(sdf, new Float32Array(W * H), W, H)
  const hd = new Float64Array(2)
  const sample = cubicPair(T.height, sdf, W, H, cell, hd)
  /**
   * 地面高程：陆上不低于水面（岸边至少略高出一点，随离岸渐高），水里不高于水面（河床离岸渐深）。
   * 别处就是格网高程，房屋、城墙按格网高程落地，与地面对得上
   */
  const ground = (x: number, z: number) => {
    sample(x, z)
    return shaped(hd[0], hd[1])
  }
  const shaped = (t: number, d: number) => {
    if (d >= 0) return Math.max(t, WATER_LEVEL + 0.05 + 0.12 * Math.min(d, 4))
    const x1 = -d
    return Math.min(t, WATER_LEVEL - (0.12 + 0.28 * Math.min(x1, 4) + 0.035 * Math.min(Math.max(0, x1 - 4), 45)))
  }

  // —— 粗网格 ——
  const s = Math.max(1, Math.ceil(Math.sqrt((W * H) / COARSE_MAX)))
  const GW = Math.ceil((W - 1) / s) + 1
  const GH = Math.ceil((H - 1) / s) + 1
  const gx = new Float32Array(GW)
  const gz = new Float32Array(GH)
  for (let i = 0; i < GW; i++) gx[i] = Math.min(st.width, Math.min(W - 1, i * s) * cell)
  for (let j = 0; j < GH; j++) gz[j] = Math.min(st.height, Math.min(H - 1, j * s) * cell)
  const CW = GW - 1
  const CH = GH - 1
  const step = s * cell

  // —— 要细分的粗格：岸线两侧、护城河、池塘 ——
  const ref = new Uint8Array(CW * CH)
  const markNode = (a: number, b: number) => {
    const i0 = Math.max(0, Math.ceil(a / s) - 1)
    const i1 = Math.min(CW - 1, Math.floor(a / s))
    const j0 = Math.max(0, Math.ceil(b / s) - 1)
    const j1 = Math.min(CH - 1, Math.floor(b / s))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) ref[j * CW + i] = 1
  }
  for (let b = 0; b < H; b++)
    for (let a = 0; a < W; a++) {
      const d = sdf[b * W + a]
      if (d > -6 && d < 4) markNode(a, b)
    }
  /** 以 (x0, z0)-(x1, z1) 为界的粗格里，中心满足 near 的标为细分 */
  const markCells = (x0: number, z0: number, x1: number, z1: number, near: (cx: number, cz: number) => boolean) => {
    const i0 = Math.max(0, Math.floor(x0 / step))
    const i1 = Math.min(CW - 1, Math.floor(x1 / step))
    const j0 = Math.max(0, Math.floor(z0 / step))
    const j1 = Math.min(CH - 1, Math.floor(z1 / step))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!ref[j * CW + i] && near((gx[i] + gx[i + 1]) / 2, (gz[j] + gz[j + 1]) / 2)) ref[j * CW + i] = 1
  }
  const reach = step * 0.71
  const lifeOf = (x: object): [number, number] => {
    const l = life.get(x)
    return [l?.born ?? 0, l && l.died !== Infinity ? l.died : NEVER]
  }
  // 河道重新分段：每段约 10 米（生成器给的折线有的三米一点、有的百米一段），水面高度逐点取，跟得上地面的起伏
  const moats = st.walls.filter((w) => w.moat && w.moat.runs.length).map((w) => ({ runs: w.moat!.runs.filter((r) => r.length > 1).map((r) => densify(thin(r, 10, 0.2), 10)), hw: w.moat!.width / 2, life: lifeOf(w) }))
  for (const m of moats)
    for (const run of m.runs)
      for (let k = 0; k < run.length - 1; k++) {
        const a = run[k]
        const b = run[k + 1]
        const r = m.hw + 2 + reach
        markCells(Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, (cx, cz) => segDist(cx, cz, a, b) < r)
      }
  // 池塘：够大的才下刻（窄的水渠在细网格上刻不出来，由地面材质画成水面）
  const isles = st.parkParts.filter((q) => q.kind === 'isle')
  const ponds = st.parkParts
    .filter((q) => q.kind === 'pond' && q.poly.length > 2)
    .map((q) => ({ poly: q.poly, life: lifeOf(q), ...polyArea(q.poly) }))
    .filter((q) => q.area > 90 && q.area / q.per > 1.6)
  const boxOf = (poly: Poly) => {
    let x0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let z1 = -Infinity
    for (const p of poly) {
      x0 = Math.min(x0, p[0])
      z0 = Math.min(z0, p[1])
      x1 = Math.max(x1, p[0])
      z1 = Math.max(z1, p[1])
    }
    return [x0, z0, x1, z1]
  }
  for (const q of ponds) {
    const [x0, z0, x1, z1] = boxOf(q.poly)
    const r = 2 + reach
    markCells(x0 - r, z0 - r, x1 + r, z1 + r, (cx, cz) => polyDepth(cx, cz, q.poly) > -r)
  }
  let nRef = 0
  for (let k = 0; k < ref.length; k++) nRef += ref[k]
  // 细分倍数：尽量到 1.25 米，顶点太多就退一档
  let n = 1
  for (const c of [Math.round(step / 1.25), Math.round(step / 2.5), Math.round(step / 5)]) {
    if (c > 1 && nRef * c * c <= FINE_MAX) {
      n = c
      break
    }
  }
  if (n === 1) ref.fill(0)
  const fs = step / n
  const FW = CW * n + 1
  const FH = CH * n + 1

  // —— 顶点 ——
  let trans = 0
  const isRef = (i: number, j: number) => i >= 0 && j >= 0 && i < CW && j < CH && ref[j * CW + i] === 1
  for (let j = 0; j < CH; j++) for (let i = 0; i < CW; i++) if (!ref[j * CW + i] && (isRef(i - 1, j) || isRef(i + 1, j) || isRef(i, j - 1) || isRef(i, j + 1))) trans++
  if (n === 1) nRef = 0
  const maxV = GW * GH + nRef * (n * n + 2 * n - 3) + trans
  const pos = new Float32Array(maxV * 3)
  let nv = GW * GH
  for (let j = 0; j < GH; j++)
    for (let i = 0; i < GW; i++) {
      const k = j * GW + i
      pos[k * 3] = gx[i]
      // 落在格点上的直接取格网值（最后一列、一行贴着图边，不一定在格点上）
      const ci = i * s
      const cj = j * s
      pos[k * 3 + 1] = ci < W && cj < H && ci * cell === gx[i] && cj * cell === gz[j] ? shaped(T.height[cj * W + ci], sdf[cj * W + ci]) : ground(gx[i], gz[j])
      pos[k * 3 + 2] = gz[j]
    }
  // 细顶点的编号：粗格的每条边上 n − 1 个（相邻的细分格共用），格内 (n − 1)² 个；各记第一个的下标
  const hEdge = new Int32Array(CW * GH).fill(-1)
  const vEdge = new Int32Array(GW * CH).fill(-1)
  const inner = new Int32Array(CW * CH).fill(-1)
  const n1 = n - 1
  /** 细格点阵 (I, J) 处的顶点；没有（不在细分格里）时为 −1 */
  const vertAt = (I: number, J: number) => {
    if (I < 0 || J < 0 || I >= FW || J >= FH) return -1
    const i = (I / n) | 0
    const j = (J / n) | 0
    const a = I - i * n
    const b = J - j * n
    if (a === 0) {
      if (b === 0) return j * GW + i
      const e = vEdge[j * GW + i]
      return e < 0 ? -1 : e + b - 1
    }
    if (b === 0) {
      const e = hEdge[j * CW + i]
      return e < 0 ? -1 : e + a - 1
    }
    const c = inner[j * CW + i]
    return c < 0 ? -1 : c + (b - 1) * n1 + a - 1
  }
  const put = (x: number, z: number) => {
    pos[nv * 3] = x
    pos[nv * 3 + 1] = ground(x, z)
    pos[nv * 3 + 2] = z
    nv++
  }
  const N1 = n + 1
  const cellVerts = new Int32Array(N1 * N1)
  const idx = new Uint32Array((CW * CH - nRef - trans) * 6 + nRef * n * n * 6 + trans * 12 * n)
  let ni = 0
  const tri = (a: number, b: number, c: number) => {
    idx[ni++] = a
    idx[ni++] = b
    idx[ni++] = c
  }
  for (let j = 0; j < CH; j++)
    for (let i = 0; i < CW; i++) {
      if (!ref[j * CW + i]) continue
      const x0 = gx[i]
      const z0 = gz[j]
      const dx = (gx[i + 1] - x0) / n
      const dz = (gz[j + 1] - z0) / n
      for (const jj of [j, j + 1]) {
        if (hEdge[jj * CW + i] >= 0) continue
        hEdge[jj * CW + i] = nv
        for (let a = 1; a < n; a++) put(x0 + dx * a, gz[jj])
      }
      for (const ii of [i, i + 1]) {
        if (vEdge[j * GW + ii] >= 0) continue
        vEdge[j * GW + ii] = nv
        for (let b = 1; b < n; b++) put(gx[ii], z0 + dz * b)
      }
      inner[j * CW + i] = nv
      for (let b = 1; b < n; b++) for (let a = 1; a < n; a++) put(x0 + dx * a, z0 + dz * b)
      for (let b = 0; b <= n; b++) for (let a = 0; a <= n; a++) cellVerts[b * N1 + a] = vertAt(i * n + a, j * n + b)
      // 细格的对角线取高差小的那条：岸线、沟沿不出锯齿
      for (let b = 0; b < n; b++)
        for (let a = 0; a < n; a++) {
          const v00 = cellVerts[b * N1 + a]
          const v10 = cellVerts[b * N1 + a + 1]
          const v01 = cellVerts[(b + 1) * N1 + a]
          const v11 = cellVerts[(b + 1) * N1 + a + 1]
          if (Math.abs(pos[v00 * 3 + 1] - pos[v11 * 3 + 1]) < Math.abs(pos[v10 * 3 + 1] - pos[v01 * 3 + 1])) {
            tri(v00, v01, v11)
            tri(v00, v11, v10)
          } else {
            tri(v00, v01, v10)
            tri(v10, v01, v11)
          }
        }
    }
  // 没细分的粗格：两个三角形；挨着细分格的改成绕中心的扇形，接上邻格边上的细顶点
  const ring: number[] = []
  for (let j = 0; j < CH; j++)
    for (let i = 0; i < CW; i++) {
      if (ref[j * CW + i]) continue
      const a = j * GW + i
      const L = isRef(i - 1, j)
      const R = isRef(i + 1, j)
      const U = isRef(i, j - 1)
      const D = isRef(i, j + 1)
      if (!L && !R && !U && !D) {
        tri(a, a + GW, a + 1)
        tri(a + 1, a + GW, a + GW + 1)
        continue
      }
      ring.length = 0
      ring.push(a)
      if (L) for (let k = 1; k < n; k++) ring.push(vertAt(i * n, j * n + k))
      ring.push(a + GW)
      if (D) for (let k = 1; k < n; k++) ring.push(vertAt(i * n + k, (j + 1) * n))
      ring.push(a + GW + 1)
      if (R) for (let k = 1; k < n; k++) ring.push(vertAt((i + 1) * n, (j + 1) * n - k))
      ring.push(a + 1)
      if (U) for (let k = 1; k < n; k++) ring.push(vertAt((i + 1) * n - k, j * n))
      const c = nv++
      const cx = (gx[i] + gx[i + 1]) / 2
      const cz = (gz[j] + gz[j + 1]) / 2
      pos[c * 3] = cx
      pos[c * 3 + 1] = ground(cx, cz)
      pos[c * 3 + 2] = cz
      for (let k = 0; k < ring.length; k++) tri(c, ring[k], ring[(k + 1) % ring.length])
    }

  // —— 法线：各三角形的面法线按面积累加到顶点（粗格、细格、扇形一视同仁，岸坡的台阶也算在内） ——
  const acc = new Float32Array(nv * 3)
  /** dy：各顶点高度的修正（下刻量，每顶点 4 个数的第一个）；only：只算有标记的顶点 */
  const normals = (out: Int8Array, dy: Float32Array | null, only: Uint8Array | null) => {
    acc.fill(0)
    for (let k = 0; k < ni; k += 3) {
      const a = idx[k]
      const b = idx[k + 1]
      const c = idx[k + 2]
      if (only && !only[a] && !only[b] && !only[c]) continue
      const ay = pos[a * 3 + 1] + (dy ? dy[a * 4] : 0)
      const ux = pos[b * 3] - pos[a * 3]
      const uy = pos[b * 3 + 1] + (dy ? dy[b * 4] : 0) - ay
      const uz = pos[b * 3 + 2] - pos[a * 3 + 2]
      const vx = pos[c * 3] - pos[a * 3]
      const vy = pos[c * 3 + 1] + (dy ? dy[c * 4] : 0) - ay
      const vz = pos[c * 3 + 2] - pos[a * 3 + 2]
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      acc[a * 3] += nx
      acc[a * 3 + 1] += ny
      acc[a * 3 + 2] += nz
      acc[b * 3] += nx
      acc[b * 3 + 1] += ny
      acc[b * 3 + 2] += nz
      acc[c * 3] += nx
      acc[c * 3 + 1] += ny
      acc[c * 3 + 2] += nz
    }
    for (let v = 0; v < nv; v++) {
      if (only && !only[v]) continue
      const l = Math.sqrt(acc[v * 3] * acc[v * 3] + acc[v * 3 + 1] * acc[v * 3 + 1] + acc[v * 3 + 2] * acc[v * 3 + 2]) || 1
      out[v * 3] = Math.round((acc[v * 3] / l) * 127)
      out[v * 3 + 1] = Math.round((acc[v * 3 + 1] / l) * 127)
      out[v * 3 + 2] = Math.round((acc[v * 3 + 2] / l) * 127)
    }
  }
  const nrm = new Int8Array(nv * 3)
  normals(nrm, null, null)

  // —— 下刻：护城河与池塘 ——
  const carve = new Float32Array(nv * 4)
  for (let v = 0; v < nv; v++) {
    carve[v * 4 + 2] = NEVER
    carve[v * 4 + 3] = WATER_LEVEL
  }
  const carved: number[] = []
  /** 把顶点 v 刻到 floor（覆盖度 c），水面 level；同一顶点取刻得深的那个 */
  const dig = (v: number, c: number, floor: number, level: number, lf: [number, number]) => {
    const y = pos[v * 3 + 1]
    const delta = Math.min(0, floor - y) * c
    if (delta < carve[v * 4] - 1e-4) {
      if (carve[v * 4] === 0) carved.push(v)
      carve[v * 4] = delta
      carve[v * 4 + 1] = lf[0]
      carve[v * 4 + 2] = lf[1]
      carve[v * 4 + 3] = level
    } else if (carve[v * 4] === 0 && y > level && y > WATER_LEVEL + 0.4) {
      // 沟沿外的一圈：水面高度跟着沟里走（水面网格在这里收边），不动天然水体岸边的顶点
      carve[v * 4 + 3] = level
    }
  }
  const eachNode = (x0: number, z0: number, x1: number, z1: number, f: (v: number, x: number, z: number) => void) => {
    // 图边上的一圈不刻（剖面的上沿不随人口变）
    const I0 = Math.max(1, Math.floor(x0 / fs) - 1)
    const I1 = Math.min(FW - 2, Math.ceil(x1 / fs) + 1)
    const J0 = Math.max(1, Math.floor(z0 / fs) - 1)
    const J1 = Math.min(FH - 2, Math.ceil(z1 / fs) + 1)
    for (let J = J0; J <= J1; J++)
      for (let I = I0; I <= I1; I++) {
        const v = vertAt(I, J)
        if (v >= 0) f(v, pos[v * 3], pos[v * 3 + 2])
      }
  }
  if (n > 1) {
    for (const m of moats) {
      const hw = m.hw
      const bank = Math.min(2.4, hw * 0.5)
      for (const run of m.runs) {
        // 水面：沿河道取两岸与中线地面的最低处再降一截，顺着河道抹平（不高于各处的岸）
        const cap = run.map((p, k) => {
          const a = run[Math.max(0, k - 1)]
          const b = run[Math.min(run.length - 1, k + 1)]
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
          const nx = (-(b[1] - a[1]) / L) * hw
          const nz = ((b[0] - a[0]) / L) * hw
          return Math.min(ground(p[0], p[1]), ground(p[0] + nx, p[1] + nz), ground(p[0] - nx, p[1] - nz)) - MOAT_FREEBOARD
        })
        let level = cap.slice()
        for (let pass = 0; pass < 6; pass++) {
          const next = level.slice()
          for (let k = 0; k < level.length; k++) next[k] = Math.min(cap[k] + 0.25, (level[Math.max(0, k - 1)] + 2 * level[k] + level[Math.min(level.length - 1, k + 1)]) / 4)
          level = next
        }
        // 接近天然水面的并到同一高度（护城河通到河边时水面相接）
        level = level.map((y) => (y < WATER_LEVEL + 0.2 ? WATER_LEVEL : y))
        for (let k = 0; k < run.length - 1; k++) {
          const a = run[k]
          const b = run[k + 1]
          const r = hw + 2 * fs + 0.6
          eachNode(Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, (v, x, z) => {
            // 河道两头是平头：越过端点的部分按垂距算，再沿轴向收掉
            let d = segDist(x, z, a, b)
            let end = 1
            if (k === 0 && seg.t < 0) {
              d = seg.perp
              end = 1 - sm(0, 1.2, -seg.t * seg.L)
            } else if (k === run.length - 2 && seg.t > 1) {
              d = seg.perp
              end = 1 - sm(0, 1.2, (seg.t - 1) * seg.L)
            }
            if (d > r) return
            const t = Math.min(1, Math.max(0, seg.t))
            const lv = level[k] + (level[k + 1] - level[k]) * t
            dig(v, (1 - sm(hw - bank, hw + 0.3, d)) * end, lv - MOAT_DEPTH, lv, m.life)
          })
        }
      }
    }
    for (const q of ponds) {
      const [x0, z0, x1, z1] = boxOf(q.poly)
      let rim = Infinity
      for (let k = 0; k < q.poly.length; k++) {
        const a = q.poly[k]
        const b = q.poly[(k + 1) % q.poly.length]
        rim = Math.min(rim, ground(a[0], a[1]), ground((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
      }
      const level = rim - POND_FREEBOARD
      const near = isles.filter((s) => {
        const [a0, b0, a1, b1] = boxOf(s.poly)
        return a0 < x1 && a1 > x0 && b0 < z1 && b1 > z0
      })
      const r = 2 * fs + 0.6
      eachNode(x0 - r, z0 - r, x1 + r, z1 + r, (v, x, z) => {
        const d = polyDepth(x, z, q.poly)
        if (d < -r) return
        let c = sm(-0.2, 1.0, d)
        for (const s of near) c *= 1 - sm(-0.6, 0.5, polyDepth(x, z, s.poly))
        dig(v, c, level - POND_DEPTH, level, q.life)
      })
    }
  }
  // 下刻处（连同相邻的顶点）的法线按刻下去之后的高度重算
  const nrm2 = nrm.slice()
  if (carved.length) {
    const near = new Uint8Array(nv)
    for (let k = 0; k < ni; k += 3) {
      if (carve[idx[k] * 4] < 0 || carve[idx[k + 1] * 4] < 0 || carve[idx[k + 2] * 4] < 0) near[idx[k]] = near[idx[k + 1]] = near[idx[k + 2]] = 1
    }
    normals(nrm2, carve, near)
  }

  // —— 可能有水的三角形 ——
  const wetV = new Uint8Array(nv)
  for (let v = 0; v < nv; v++) wetV[v] = pos[v * 3 + 1] < carve[v * 4 + 3] || carve[v * 4] < 0 ? 1 : 0
  let nw = 0
  for (let k = 0; k < ni; k += 3) if (wetV[idx[k]] || wetV[idx[k + 1]] || wetV[idx[k + 2]]) nw += 3
  const wet = new Uint32Array(nw)
  nw = 0
  for (let k = 0; k < ni; k += 3)
    if (wetV[idx[k]] || wetV[idx[k + 1]] || wetV[idx[k + 2]]) {
      wet[nw++] = idx[k]
      wet[nw++] = idx[k + 1]
      wet[nw++] = idx[k + 2]
    }

  // —— 边缘一圈 ——
  const loop: number[] = []
  for (let i = 0; i < CW; i++) {
    loop.push(i)
    if (isRef(i, 0)) for (let k = 1; k < n; k++) loop.push(vertAt(i * n + k, 0))
  }
  for (let j = 0; j < CH; j++) {
    loop.push(j * GW + CW)
    if (isRef(CW - 1, j)) for (let k = 1; k < n; k++) loop.push(vertAt(CW * n, j * n + k))
  }
  for (let i = CW; i > 0; i--) {
    loop.push(CH * GW + i)
    if (isRef(i - 1, CH - 1)) for (let k = 1; k < n; k++) loop.push(vertAt(i * n - k, CH * n))
  }
  for (let j = CH; j > 0; j--) {
    loop.push(j * GW)
    if (isRef(0, j - 1)) for (let k = 1; k < n; k++) loop.push(vertAt(0, j * n - k))
  }
  loop.push(0)
  const rim = new Float32Array(loop.length * 3)
  loop.forEach((v, k) => {
    rim[k * 3] = pos[v * 3]
    rim[k * 3 + 1] = pos[v * 3 + 1]
    rim[k * 3 + 2] = pos[v * 3 + 2]
  })

  return { pos: pos.slice(0, nv * 3), nrm, idx: idx.slice(0, ni), carve, nrm2, wet, rim, shore: shoreField(sdf, W, H, cell) }
}

/** 水岸贴图（见 TerrainMesh.shore） */
function shoreField(sdf: Float32Array, W: number, H: number, cell: number): Uint8Array {
  const N = W * H
  // 开阔水面的远近：到"离岸够远的水"的距离（两遍倒角距离变换，以格为单位），河道窄，够不上
  const far = new Float32Array(N)
  let any = false
  for (let k = 0; k < N; k++) {
    if (sdf[k] < -26) any = true
    else far[k] = 1e6
  }
  if (any) {
    const D = Math.SQRT2
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i
        let d = far[k]
        if (d === 0) continue
        let x: number
        if (i > 0 && (x = far[k - 1] + 1) < d) d = x
        if (j > 0) {
          if ((x = far[k - W] + 1) < d) d = x
          if (i > 0 && (x = far[k - W - 1] + D) < d) d = x
          if (i < W - 1 && (x = far[k - W + 1] + D) < d) d = x
        }
        far[k] = d
      }
    for (let j = H - 1; j >= 0; j--)
      for (let i = W - 1; i >= 0; i--) {
        const k = j * W + i
        let d = far[k]
        if (d === 0) continue
        let x: number
        if (i < W - 1 && (x = far[k + 1] + 1) < d) d = x
        if (j < H - 1) {
          if ((x = far[k + W] + 1) < d) d = x
          if (i < W - 1 && (x = far[k + W + 1] + D) < d) d = x
          if (i > 0 && (x = far[k + W - 1] + D) < d) d = x
        }
        far[k] = d
      }
  }
  // 水流方向：沿岸（垂直于距离场的梯度），用倍角表示（不分正反），再抹平河心梯度不定的地方。
  // 只在水里与水边求（离岸远的陆地用不到）
  const c2 = new Float32Array(N)
  const s2 = new Float32Array(N)
  for (let j = 1; j < H - 1; j++)
    for (let k = j * W + 1, e = j * W + W - 1; k < e; k++) {
      if (sdf[k] > 25) continue
      const gx = sdf[k + 1] - sdf[k - 1]
      const gz = sdf[k + W] - sdf[k - W]
      const l2 = gx * gx + gz * gz
      if (l2 < 1e-12) continue
      c2[k] = (gz * gz - gx * gx) / l2
      s2[k] = (-2 * gz * gx) / l2
    }
  const tmp = new Float32Array(N)
  for (let pass = 0; pass < 2; pass++) {
    smooth(c2, tmp, W, H)
    smooth(s2, tmp, W, H)
  }
  // 写进 Uint8ClampedArray：取整与截断由它来做
  const out = new Uint8ClampedArray(N * 4)
  for (let k = 0; k < N; k++) {
    const o = k * 4
    const d = sdf[k]
    out[o] = d >= -16 ? 128 - d * 4 : 192 + (-16 - d) * 0.6
    if (any) {
      const d = far[k] * cell
      out[o + 1] = d < 40 ? 255 : d > 110 ? 0 : 255 * (1 - sm(40, 110, d))
    }
    out[o + 2] = 127.5 + 127.5 * c2[k]
    out[o + 3] = 127.5 + 127.5 * s2[k]
  }
  return new Uint8Array(out.buffer)
}
