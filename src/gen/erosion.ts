import { RNG } from './rng'
import { priorityFlood } from './hydrology'
import { neighbors8 } from './util'
import * as dmath from './dmath'

/**
 * 河流侵蚀：流水功率定律 dh/dt = U - K·A^m·S （Braun & Willett 2013 的隐式解法）。
 * 汇水面积大的地方下切成谷，分水岭保持为山脊，形成树枝状水系地貌。
 */
export function streamPowerErosion(
  elev: Float32Array,
  uplift: Float32Array,
  W: number,
  H: number,
  iterations: number,
  opts: { kf: number; m: number; upliftRate: number; diffusion: number },
  onIter?: (i: number) => void,
  /** 物理尺度参照宽度（粗网格时传原分辨率宽度） */
  refW = W,
) {
  const N = W * H
  const { off, dist } = neighbors8(W)
  const rec = new Int32Array(N)
  const recD = new Float32Array(N)
  const start = new Int32Array(N + 1)
  const donors = new Int32Array(N)
  const fillPos = new Int32Array(N)
  const stack = new Int32Array(N)
  const area = new Float32Array(N)
  const tmp = new Float32Array(N)
  // 分辨率无关：以 1024 宽为基准换算面积和步长
  const s = (1024 / refW) * (refW / W)
  const areaScale = s * s

  for (let it = 0; it < iterations; it++) {
    // 1. 受水点：在填洼后的表面上取最陡下降（严格下降 → 无环）。
    //    洼地内的格因此流向溢出口，隐式更新会把洼地逐渐淤平，不会留下"陨石坑"。
    const { filled: F, dir: pfDir } = priorityFlood(elev, W, H, 1e-5)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        rec[i] = i
        recD[i] = s
        const h = F[i]
        if (elev[i] <= 0 || x === 0 || y === 0 || x === W - 1 || y === H - 1) continue
        let best = 0
        for (let k = 0; k < 8; k++) {
          const j = i + off[k]
          const sl = (h - F[j]) / dist[k]
          if (sl > best) {
            best = sl
            rec[i] = j
            recD[i] = dist[k] * s
          }
        }
        if (rec[i] === i && pfDir[i] >= 0) rec[i] = pfDir[i]
      }
    }
    // 2. 供水者 CSR
    start.fill(0)
    for (let i = 0; i < N; i++) if (rec[i] !== i) start[rec[i] + 1]++
    for (let i = 0; i < N; i++) start[i + 1] += start[i]
    fillPos.set(start.subarray(0, N))
    for (let i = 0; i < N; i++) if (rec[i] !== i) donors[fillPos[rec[i]]++] = i
    // 3. 拓扑序：从基准面向上游广度优先
    let n = 0
    for (let i = 0; i < N; i++) if (rec[i] === i) stack[n++] = i
    for (let q = 0; q < n; q++) {
      const c = stack[q]
      for (let k = start[c]; k < start[c + 1]; k++) stack[n++] = donors[k]
    }
    // 4. 汇水面积
    area.fill(areaScale)
    for (let q = N - 1; q >= 0; q--) {
      const i = stack[q]
      const r = rec[i]
      if (r !== i) area[r] += area[i]
    }
    // 5. 隐式更新：下游先解，上游用已更新的受水点高度
    const { kf, m, upliftRate } = opts
    const sqrtM = m === 0.5
    for (let q = 0; q < N; q++) {
      const i = stack[q]
      const r = rec[i]
      if (r === i) continue
      const f = (kf * (sqrtM ? Math.sqrt(area[i]) : dmath.pow(area[i], m))) / recD[i]
      const hi = elev[i] + upliftRate * uplift[i]
      const hr = elev[r]
      elev[i] = (hi + f * hr) / (1 + f)
    }
    // 6. 坡面扩散（风化、蠕移）
    if (opts.diffusion > 0) {
      const kd = opts.diffusion
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x
          const h = elev[i]
          if (h <= 0) {
            tmp[i] = h
            continue
          }
          let lap = 0
          for (let k = 0; k < 4; k++) lap += elev[i + off[k]]
          lap = lap * 0.25 - h
          tmp[i] = h + kd * lap
        }
      }
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x
          // 不让扩散把陆地抹进海里
          if (elev[i] > 0) elev[i] = Math.max(0.001, tmp[i])
        }
      }
    }
    onIter?.(it)
  }
}

/**
 * 粒子水力侵蚀：模拟雨滴沿坡面流动、冲刷与沉积，
 * 在大尺度水系之上叠加细小的冲沟、冲积扇与河口三角洲。
 */
export function dropletErosion(
  elev: Float32Array,
  W: number,
  H: number,
  count: number,
  rng: RNG,
  hScale: number,
  onProgress?: (f: number) => void,
) {
  const inertia = 0.06
  const capacityF = 5
  const minCap = 0.005
  const erodeSpeed = 0.35
  const depositSpeed = 0.25
  const evaporate = 0.018
  const gravity = 4
  const maxSteps = 56
  const radius = 2

  // 侵蚀刷子
  const bOffA: number[] = []
  const bWA: number[] = []
  let wsum = 0
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const d = dmath.hypot(x, y)
      if (d > radius) continue
      const w = radius - d + 0.2
      bOffA.push(y * W + x)
      bWA.push(w)
      wsum += w
    }
  }
  const bOff = Int32Array.from(bOffA)
  const bW = Float64Array.from(bWA, (w) => w / wsum)
  const nb = bW.length

  const h = elev
  const inv = 1 / hScale
  const sc = hScale

  // 只在陆地上撒雨滴
  const landIdx: number[] = []
  for (let i = 0; i < W * H; i++) if (h[i] > 0) landIdx.push(i)
  if (landIdx.length === 0) return
  // 雨滴总数按全图格数给：陆地极少时（草图几乎全是海）同几格会被反复冲刷而发散，按每格 8 滴封顶
  //（侵蚀强度 ≤ 2、陆地比例 ≥ 0.12 时达不到上限）
  count = Math.min(count, landIdx.length * 8)

  for (let d = 0; d < count; d++) {
    if (onProgress && (d & 16383) === 0) onProgress(d / count)
    const c = landIdx[Math.floor(rng.next() * landIdx.length)]
    let px = (c % W) + rng.next()
    let py = Math.floor(c / W) + rng.next()
    let dirX = 0
    let dirY = 0
    let speed = 1
    let water = 1
    let sed = 0

    for (let step = 0; step < maxSteps; step++) {
      const nx = Math.floor(px)
      const ny = Math.floor(py)
      if (nx < radius || ny < radius || nx >= W - radius - 1 || ny >= H - radius - 1) break
      const fx = px - nx
      const fy = py - ny
      const i = ny * W + nx
      const h00 = h[i] * sc, h10 = h[i + 1] * sc, h01 = h[i + W] * sc, h11 = h[i + W + 1] * sc
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx
      const hOld = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy

      // 入海：泥沙堆积在近岸浅海（陆架），但不越出海面
      if (hOld <= 0) {
        if (sed > 0) {
          const amt = sed * inv * 0.5
          for (const t of [i, i + 1, i + W, i + W + 1]) addSed(h, t, amt * 0.25)
        }
        break
      }

      dirX = dirX * inertia - gx * (1 - inertia)
      dirY = dirY * inertia - gy * (1 - inertia)
      const len = Math.sqrt(dirX * dirX + dirY * dirY)
      if (len < 1e-9) {
        const a = rng.next() * Math.PI * 2
        dirX = dmath.cos(a)
        dirY = dmath.sin(a)
      } else {
        dirX /= len
        dirY /= len
      }
      px += dirX
      py += dirY
      const mx = Math.floor(px)
      const my = Math.floor(py)
      if (mx < 0 || my < 0 || mx >= W - 1 || my >= H - 1) break
      const gx2 = px - mx
      const gy2 = py - my
      const j = my * W + mx
      const hNew =
        (h[j] * (1 - gx2) * (1 - gy2) + h[j + 1] * gx2 * (1 - gy2) + h[j + W] * (1 - gx2) * gy2 + h[j + W + 1] * gx2 * gy2) * sc
      const dh = hNew - hOld

      const cap = Math.max(-dh * speed * water * capacityF, minCap)
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depositSpeed
        sed -= amt
        depositBilinear(h, i, W, fx, fy, amt * inv)
      } else {
        const amt = Math.min((cap - sed) * erodeSpeed, -dh)
        for (let k = 0; k < nb; k++) {
          const t = i + bOff[k]
          const e = amt * bW[k] * inv
          // 不把陆地挖到海平面以下
          const nh = h[t] - e
          h[t] = h[t] > 0 && nh < 0.002 ? Math.min(h[t], 0.002) : nh
        }
        sed += amt
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * gravity))
      water *= 1 - evaporate
    }
  }
}

function depositBilinear(h: Float32Array, i: number, W: number, fx: number, fy: number, amt: number) {
  addSed(h, i, amt * (1 - fx) * (1 - fy))
  addSed(h, i + 1, amt * fx * (1 - fy))
  addSed(h, i + W, amt * (1 - fx) * fy)
  addSed(h, i + W + 1, amt * fx * fy)
}

/** 沉积：海底可以被抬高，但不会堆出海面，海岸线由构造与侵蚀决定 */
function addSed(h: Float32Array, t: number, a: number) {
  const v = h[t] + a
  h[t] = h[t] <= 0 ? Math.min(v, -0.0015) : v
}

/** 热力风化：超过休止角的坡面物质向下坡滑落，形成碎石坡 */
export function thermalErosion(elev: Float32Array, W: number, H: number, iterations: number, talus: number, rate = 0.25) {
  const N = W * H
  const delta = new Float32Array(N)
  const { off, dist } = neighbors8(W)
  for (let it = 0; it < iterations; it++) {
    delta.fill(0)
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        const h = elev[i]
        if (h <= 0) continue
        let maxD = 0
        let total = 0
        for (let k = 0; k < 8; k++) {
          const d = (h - elev[i + off[k]]) / dist[k]
          if (d > talus) {
            total += d - talus
            if (d > maxD) maxD = d
          }
        }
        if (total <= 0) continue
        const move = rate * (maxD - talus) * 0.5
        for (let k = 0; k < 8; k++) {
          const d = (h - elev[i + off[k]]) / dist[k]
          if (d > talus) {
            const m = (move * (d - talus)) / total
            delta[i] -= m
            delta[i + off[k]] += m
          }
        }
      }
    }
    for (let i = 0; i < N; i++) elev[i] += delta[i]
  }
}

/**
 * 多分辨率流水侵蚀：在粗网格上带构造抬升迭代到准稳态，
 * 山脉在"抬升 vs 下切"的平衡中长出宽阔的树枝状山谷与山脊，
 * 再把粗网格的地形变化量双线性叠加回原分辨率，保留细部。
 */
export function coarseErosion(
  elev: Float32Array,
  uplift: Float32Array,
  W: number,
  H: number,
  factor: number,
  iterations: number,
  opts: { kf: number; m: number; upliftRate: number; diffusion: number },
  onIter?: (i: number) => void,
) {
  const CW = Math.ceil(W / factor)
  const CH = Math.ceil(H / factor)
  const ce = new Float32Array(CW * CH)
  const cu = new Float32Array(CW * CH)
  const cnt = new Float32Array(CW * CH)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = Math.floor(y / factor) * CW + Math.floor(x / factor)
      ce[c] += elev[y * W + x]
      cu[c] += uplift[y * W + x]
      cnt[c]++
    }
  }
  for (let c = 0; c < ce.length; c++) {
    ce[c] /= cnt[c]
    cu[c] /= cnt[c]
  }
  const c0 = Float32Array.from(ce)
  // 粗网格按原分辨率的物理尺度换算
  streamPowerErosion(ce, cu, CW, CH, iterations, opts, onIter, W)
  for (let c = 0; c < ce.length; c++) ce[c] -= c0[c]
  for (let y = 0; y < H; y++) {
    const gy = Math.min(CH - 1.001, Math.max(0, (y + 0.5) / factor - 0.5))
    const y0 = Math.floor(gy)
    const fy = gy - y0
    const y1 = Math.min(CH - 1, y0 + 1)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (elev[i] <= 0) continue
      const gx = Math.min(CW - 1.001, Math.max(0, (x + 0.5) / factor - 0.5))
      const x0 = Math.floor(gx)
      const fx = gx - x0
      const x1 = Math.min(CW - 1, x0 + 1)
      const d =
        (ce[y0 * CW + x0] * (1 - fx) + ce[y0 * CW + x1] * fx) * (1 - fy) + (ce[y1 * CW + x0] * (1 - fx) + ce[y1 * CW + x1] * fx) * fy
      elev[i] = Math.max(0.002, elev[i] + d)
    }
  }
}
