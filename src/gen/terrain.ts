import { Noise } from './noise'
import { RNG } from './rng'
import type { WorldParams } from './types'
import { edt, quantile, smoothstep, clamp } from './util'

interface Plate {
  x: number
  y: number
  vx: number
  vy: number
  bias: number
  continental: boolean
}

export interface TerrainResult {
  /** 海拔 km */
  elev: Float32Array
  /** 构造抬升（km），侵蚀阶段用作持续抬升源 */
  uplift: Float32Array
  /** 主动大陆边缘程度 0~1 */
  active: Float32Array
  basins: { x: number; y: number; r: number }[]
}

/**
 * 板块构造 + 分形噪声 → 原始地形。
 * 大陆由扭曲的低频噪声与板块偏置共同决定；山脉出现在汇聚板块边界，
 * 离散边界在陆上形成裂谷、在洋底形成洋中脊；洋-洋汇聚产生岛弧。
 */
export function buildTerrain(p: WorldParams, rng: RNG, kmPerCell: number): TerrainResult {
  const { width: W, height: H } = p
  const N = W * H
  const A = W / H
  const nCont = new Noise(rng.fork())
  const nWarp = new Noise(rng.fork())
  const nMnt = new Noise(rng.fork())
  const nDet = new Noise(rng.fork())

  // —— 板块：最佳候选采样，让板块中心分布均匀 ——
  const plates: Plate[] = []
  const K = Math.max(3, Math.round(p.plates))
  for (let i = 0; i < K; i++) {
    let best = { x: 0, y: 0 }
    let bestD = -1
    for (let c = 0; c < 12; c++) {
      const x = rng.range(-0.1, A + 0.1)
      const y = rng.range(-0.1, 1.1)
      let md = Infinity
      for (const q of plates) md = Math.min(md, (q.x - x) ** 2 + (q.y - y) ** 2)
      if (md > bestD) {
        bestD = md
        best = { x, y }
      }
    }
    const ang = rng.range(0, Math.PI * 2)
    const sp = rng.range(0.25, 1)
    plates.push({ x: best.x, y: best.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, bias: 0, continental: false })
  }
  // 挑选大陆板块：数量与陆地比例相当
  const order = plates.map((_, i) => i).sort(() => rng.next() - 0.5)
  const nc = Math.max(1, Math.round(K * clamp(p.landRatio * 1.15, 0.1, 0.8)))
  for (let i = 0; i < K; i++) {
    const pl = plates[order[i]]
    pl.continental = i < nc
    pl.bias = (pl.continental ? 0.2 : -0.22) + rng.normal() * 0.06
  }

  const raw = new Float32Array(N)
  const tect = new Float32Array(N)
  const activeRaw = new Float32Array(N)
  const d2 = new Float64Array(K)
  const gain = 0.44 + 0.14 * p.coastRoughness
  const mStr = p.mountains

  for (let y = 0; y < H; y++) {
    const v = y / H
    for (let x = 0; x < W; x++) {
      const u = x / H
      // 两级域扭曲：大尺度弯曲 + 小尺度破碎，海岸线呈分形
      const w1x = nWarp.fbm(u * 1.2, v * 1.2, 4)
      const w1y = nWarp.fbm(u * 1.2 + 5.2, v * 1.2 + 1.3, 4)
      const qu = u + 0.28 * w1x
      const qv = v + 0.28 * w1y
      const w2x = nWarp.fbm(qu * 4 + 11.1, qv * 4 - 3.3, 3)
      const w2y = nWarp.fbm(qu * 4 - 7.7, qv * 4 + 9.9, 3)
      const su = qu + 0.05 * w2x * (0.4 + p.coastRoughness)
      const sv = qv + 0.05 * w2y * (0.4 + p.coastRoughness)

      // 板块：最近与次近
      let i1 = 0
      let i2 = 1
      for (let k = 0; k < K; k++) {
        const pl = plates[k]
        d2[k] = (pl.x - qu) ** 2 + (pl.y - qv) ** 2
      }
      if (d2[1] < d2[0]) {
        i1 = 1
        i2 = 0
      }
      for (let k = 2; k < K; k++) {
        if (d2[k] < d2[i1]) {
          i2 = i1
          i1 = k
        } else if (d2[k] < d2[i2]) i2 = k
      }
      // 软分配的板块偏置
      let bs = 0
      let ws = 0
      for (let k = 0; k < K; k++) {
        const w = Math.exp(-(d2[k] - d2[i1]) / 0.012)
        bs += w * plates[k].bias
        ws += w
      }
      const bias = bs / ws

      const P1 = plates[i1]
      const P2 = plates[i2]
      const cx = P2.x - P1.x
      const cy = P2.y - P1.y
      const cl = Math.sqrt(cx * cx + cy * cy) + 1e-9
      // 到 Voronoi 平分线的精确距离
      const bd = (d2[i2] - d2[i1]) / (2 * cl)
      const conv = ((P1.vx - P2.vx) * cx + (P1.vy - P2.vy) * cy) / cl

      const cont = 0.62 * nCont.fbm(su * 1.7, sv * 1.7, 8, 2, gain) + bias
      const landF = smoothstep(-0.2, 0.15, cont)

      // 汇聚边界 → 造山带
      const bw = 0.04 * (0.75 + 0.5 * (nMnt.fbm(u * 3, v * 3, 2) * 0.5 + 0.5))
      const g = Math.exp(-((bd / bw) ** 2))
      const gw = Math.exp(-((bd / (bw * 3.2)) ** 2))
      const up = smoothstep(0.05, 1.1, conv)
      const chain = 0.35 + 0.65 * smoothstep(-0.35, 0.45, nMnt.fbm(u * 4.2 + 3, v * 4.2, 3))
      const r = nMnt.ridged(su * 7, sv * 7, 7)
      let t = g * up * chain * (0.3 + 0.7 * landF) * (0.25 + 1.05 * r)
      // 造山带后方的高原
      t += gw * up * landF * 0.16 * chain
      // 离散边界：陆上裂谷、洋底洋中脊
      const div = smoothstep(0.1, 1, -conv)
      const rg = Math.exp(-((bd / 0.022) ** 2)) * div
      t += rg * (landF > 0.5 ? -0.1 : 0.08 * (0.5 + r))
      // 板块内部的古老褶皱山地（如阿巴拉契亚）
      const old = nDet.ridged(su * 5, sv * 5, 5) * smoothstep(0.15, 0.55, nDet.fbm(u * 1.3 + 9, v * 1.3, 3)) * 0.3 * landF
      t += old
      t *= mStr

      const hills = nDet.fbm(su * 11, sv * 11, 5) * (0.035 + 0.05 * landF)
      // 丘陵高地：内陆的脊状起伏，远离海岸更明显，交给侵蚀雕刻成水系
      const inland = smoothstep(0.02, 0.4, cont)
      const upMask = smoothstep(-0.3, 0.4, nDet.fbm(u * 2.2 - 4, v * 2.2 + 8, 3))
      const upland = nDet.ridged(su * 9, sv * 9, 5) * 0.16 * inland * (0.25 + 0.75 * upMask)

      const i = y * W + x
      // 边缘渐沉入海
      const ed = Math.min(u, A - u, v, 1 - v)
      const fall = 1 - smoothstep(0.0, 0.14, ed)
      raw[i] = cont + t * 0.95 + hills + upland - 0.75 * fall * fall
      tect[i] = t
      activeRaw[i] = g * up
    }
  }

  // —— 海平面：按陆地比例取分位数 ——
  const sea = quantile(raw, 1 - p.landRatio)
  const elev = new Float32Array(N)
  const uplift = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const h = raw[i] - sea
    elev[i] = h > 0 ? 4.4 * Math.pow(h, 1.25) : 4.8 * h
    uplift[i] = Math.max(0, tect[i]) * 4.4
  }

  // —— 盆地：陆地腹地的凹陷 + 山地边缘 ——
  const basins: TerrainResult['basins'] = []
  const nb = rng.int(1, 3)
  for (let b = 0, tries = 0; b < nb && tries < 400; tries++) {
    const x = rng.int(0, W - 1)
    const y = rng.int(0, H - 1)
    const i = y * W + x
    if (elev[i] < 0.3 || raw[i] - sea < 0.25) continue
    const r = rng.range(0.05, 0.1) * H
    if (basins.some((q) => Math.hypot(q.x - x, q.y - y) < (q.r + r) * 1.4)) continue
    basins.push({ x, y, r })
    b++
  }
  const nB = new Noise(rng.fork())
  for (const b of basins) {
    const floor = rng.range(0.25, 0.7)
    const rim = rng.range(1.4, 2.6) * mStr
    const R = b.r * 1.7
    const x0 = Math.max(0, Math.floor(b.x - R)), x1 = Math.min(W - 1, Math.ceil(b.x + R))
    const y0 = Math.max(0, Math.floor(b.y - R)), y1 = Math.min(H - 1, Math.ceil(b.y + R))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x
        if (elev[i] <= 0) continue
        const u = x / H, v = y / H
        let d = Math.hypot(x - b.x, y - b.y) / b.r
        d *= 1 + 0.35 * nB.fbm(u * 6, v * 6, 3)
        const inner = 1 - smoothstep(0.55, 1.0, d)
        const ring = Math.exp(-(((d - 1.1) / 0.28) ** 2))
        const rr = nB.ridged(u * 9, v * 9, 5)
        const floorH = floor + 0.08 * nB.fbm(u * 14, v * 14, 3)
        elev[i] = elev[i] + (floorH - elev[i]) * inner + rim * ring * (0.35 + 0.9 * rr)
        uplift[i] += rim * ring * rr * 0.6
      }
    }
  }

  // —— 大陆架：按离岸距离塑造海底剖面 ——
  const land = new Uint8Array(N)
  for (let i = 0; i < N; i++) land[i] = elev[i] > 0 ? 1 : 0
  const dist = edt(land, W, H)
  const act = new Float32Array(N)
  // 主动边缘：近岸有汇聚造山 → 窄陆架
  for (let i = 0; i < N; i++) act[i] = activeRaw[i]
  const nS = new Noise(rng.fork())
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (land[i]) continue
      const dk = dist[i] * kmPerCell
      const u = x / H, v = y / H
      const shelfW = (60 + 170 * (nS.fbm(u * 2.5, v * 2.5, 3) * 0.5 + 0.5)) * (1 - 0.75 * act[i])
      const abyss = 4.3 + 0.6 * nS.fbm(u * 3 + 7, v * 3, 4)
      let depth: number
      if (dk < shelfW) depth = 0.015 + 0.13 * Math.pow(dk / shelfW, 1.6)
      else depth = 0.145 + (abyss - 0.145) * (1 - Math.exp(-(dk - shelfW) / 260))
      // 海沟：主动边缘外侧
      depth += act[i] * 2.2 * Math.exp(-(((dk - shelfW - 120) / 90) ** 2))
      const relief = uplift[i] * smoothstep(0, 1, dk / (shelfW + 140))
      let h = -depth + relief + 0.06 * nS.fbm(u * 20, v * 20, 3)
      if (dist[i] <= 1.5 && h > -0.004) h = -0.004
      elev[i] = h
    }
  }

  // —— 热点火山岛链（如夏威夷）：沿板块运动方向逐渐老化下沉 ——
  const hotspots = rng.int(2, 5)
  for (let s = 0, tries = 0; s < hotspots && tries < 500; tries++) {
    const x = rng.int(0, W - 1)
    const y = rng.int(0, H - 1)
    if (land[y * W + x] || dist[y * W + x] < 35) continue
    s++
    const ang = rng.range(0, Math.PI * 2)
    const n = rng.int(4, 9)
    const step = rng.range(5, 11)
    let px = x, py = y
    for (let k = 0; k < n; k++) {
      const age = k / n
      const rad = rng.range(2.5, 5.5) * (1 + age * 0.6)
      const summit = lerpN(rng.range(0.4, 2.2), -0.6 - age * 1.2, Math.pow(age, 0.9))
      const x0 = Math.max(0, Math.floor(px - rad * 3)), x1 = Math.min(W - 1, Math.ceil(px + rad * 3))
      const y0 = Math.max(0, Math.floor(py - rad * 3)), y1 = Math.min(H - 1, Math.ceil(py + rad * 3))
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const i = yy * W + xx
          const r = Math.hypot(xx - px, yy - py) / rad
          const base = elev[i]
          const cone = base + (summit - base) * Math.exp(-Math.pow(r, 1.4))
          // 老火山顶被削平（平顶海山）
          const c = age > 0.5 ? Math.min(cone, summit - 0.05) : cone
          if (c > elev[i]) elev[i] = c
        }
      }
      px += Math.cos(ang + rng.normal() * 0.25) * step
      py += Math.sin(ang + rng.normal() * 0.25) * step
      if (px < 0 || py < 0 || px >= W || py >= H) break
    }
  }

  return { elev, uplift, active: act, basins }
}

function lerpN(a: number, b: number, t: number) {
  return a + (b - a) * t
}
