import { Noise } from './noise'
import { RNG } from './rng'
import type { WorldParams, WorldSketch } from './types'
import { edt, quantile, smoothstep, clamp } from './util'
import * as dmath from './dmath'
import { earthElevation } from './earth/index'
import { latitudeOf } from './climate'
import { sampleField, sketchFields } from './sketch'

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
 * 有规划草图时：海陆取自草图的海岸线（再叠扭曲与噪声做出分形海岸），造山带沿草图的山脉折线，
 * 板块汇聚只留下三成作为次级山地；海平面固定在草图海岸线上，不再按陆地比例取分位数。
 */
export function buildTerrain(p: WorldParams, rng: RNG, kmPerCell: number, sketch?: WorldSketch): TerrainResult {
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
      for (const q of plates) md = Math.min(md, dmath.pow(q.x - x, 2) + dmath.pow(q.y - y, 2))
      if (md > bestD) {
        bestD = md
        best = { x, y }
      }
    }
    const ang = rng.range(0, Math.PI * 2)
    const sp = rng.range(0.25, 1)
    plates.push({ x: best.x, y: best.y, vx: dmath.cos(ang) * sp, vy: dmath.sin(ang) * sp, bias: 0, continental: false })
  }
  // 挑选大陆板块：数量与陆地比例相当。先把板块洗牌（Fisher–Yates：只取决于随机数序列；
  // 用 sort 配随机比较函数的话，结果与抽签次数都随引擎的排序实现而变，同一个种子在不同浏览器里就成了不同的世界）
  const order = plates.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
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
  const sf = sketch && sketch.land.length === N ? sketchFields(sketch, W, H, kmPerCell) : null
  // 草图海岸线的扭曲幅度（格）与海岸噪声幅度
  const warpCells = 0.035 * H * (0.4 + p.coastRoughness)
  const coastAmp = 0.06 + 0.16 * p.coastRoughness
  const plateMtn = sf ? 0.3 : 1

  // 低频噪声（域扭曲、各种掩码，最短周期约 H/17 格）在粗网格上求值再双线性插值，
  // 省掉每格一半的 simplex 调用
  const S = Math.max(1, Math.round(H / 160))
  const CW = Math.ceil((W - 1) / S) + 2
  const CH = Math.ceil((H - 1) / S) + 2
  const LF = 8
  const low = new Float32Array(CW * CH * LF)
  for (let gy = 0; gy < CH; gy++) {
    const v = (gy * S) / H
    for (let gx = 0; gx < CW; gx++) {
      const u = (gx * S) / H
      const o = (gy * CW + gx) * LF
      // 两级域扭曲：大尺度弯曲 + 小尺度破碎，海岸线呈分形
      const w1x = nWarp.fbm(u * 1.2, v * 1.2, 4)
      const w1y = nWarp.fbm(u * 1.2 + 5.2, v * 1.2 + 1.3, 4)
      const qu = u + 0.28 * w1x
      const qv = v + 0.28 * w1y
      low[o] = w1x
      low[o + 1] = w1y
      low[o + 2] = nWarp.fbm(qu * 4 + 11.1, qv * 4 - 3.3, 3)
      low[o + 3] = nWarp.fbm(qu * 4 - 7.7, qv * 4 + 9.9, 3)
      low[o + 4] = nMnt.fbm(u * 3, v * 3, 2)
      low[o + 5] = nMnt.fbm(u * 4.2 + 3, v * 4.2, 3)
      low[o + 6] = nDet.fbm(u * 1.3 + 9, v * 1.3, 3)
      low[o + 7] = nDet.fbm(u * 2.2 - 4, v * 2.2 + 8, 3)
    }
  }
  const lf = new Float32Array(LF)
  // 板块软分配里权重小于 e^-24 的项忽略不计
  const softCut = 0.012 * 24

  for (let y = 0; y < H; y++) {
    const v = y / H
    const gy = Math.floor(y / S)
    const fy = y / S - gy
    for (let x = 0; x < W; x++) {
      const u = x / H
      const gx = Math.floor(x / S)
      const fx = x / S - gx
      const o00 = (gy * CW + gx) * LF
      const o10 = o00 + LF
      const o01 = o00 + CW * LF
      const o11 = o01 + LF
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
      for (let c = 0; c < LF; c++) lf[c] = low[o00 + c] * w00 + low[o10 + c] * w10 + low[o01 + c] * w01 + low[o11 + c] * w11
      const qu = u + 0.28 * lf[0]
      const qv = v + 0.28 * lf[1]
      const su = qu + 0.05 * lf[2] * (0.4 + p.coastRoughness)
      const sv = qv + 0.05 * lf[3] * (0.4 + p.coastRoughness)

      // 板块：最近与次近
      let i1 = 0
      let i2 = 1
      for (let k = 0; k < K; k++) {
        const pl = plates[k]
        const ex = pl.x - qu
        const ey = pl.y - qv
        d2[k] = ex * ex + ey * ey
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
        const dd = d2[k] - d2[i1]
        if (dd > softCut) continue
        const w = dmath.exp(-dd / 0.012)
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

      let cont: number
      let rgv = 0
      let plv = 0
      if (sf) {
        // 草图：在扭曲后的位置查海岸距离与山脉隆起，山脉也跟着弯折，不是笔直的管子
        const wx = x + warpCells * (lf[0] + 0.6 * lf[2])
        const wy = y + warpCells * (lf[1] + 0.6 * lf[3])
        const sd = sampleField(sf.coast, W, H, wx, wy) / (0.05 * H)
        cont = (0.22 * sd) / (1 + Math.abs(sd)) + coastAmp * nCont.fbm(su * 1.7, sv * 1.7, 8, 2, gain)
        rgv = sampleField(sf.ridge, W, H, wx, wy)
        plv = sampleField(sf.plateau, W, H, wx, wy)
      } else cont = 0.62 * nCont.fbm(su * 1.7, sv * 1.7, 8, 2, gain) + bias
      const landF = smoothstep(-0.2, 0.15, cont)

      // 汇聚边界 → 造山带
      const bw = 0.04 * (0.75 + 0.5 * (lf[4] * 0.5 + 0.5))
      // dmath.pow(x, 2) 即 x * x，此处直接展开
      const bg = bd / bw
      const bgw = bd / (bw * 3.2)
      const g = dmath.exp(-(bg * bg))
      const gw = dmath.exp(-(bgw * bgw))
      const up = smoothstep(0.05, 1.1, conv)
      const chain = 0.35 + 0.65 * smoothstep(-0.35, 0.45, lf[5])
      // 离散边界：陆上裂谷、洋底洋中脊
      const div = smoothstep(0.1, 1, -conv)
      // ridged ≥ 0：权重恰为 0 的噪声项不求值，结果逐位不变
      const r = g * up !== 0 || rgv > 0.004 || (div !== 0 && landF <= 0.5) ? nMnt.ridged(su * 7, sv * 7, 7) : 0
      let t = g * up * chain * (0.3 + 0.7 * landF) * (0.25 + 1.05 * r)
      // 造山带后方的高原
      t += gw * up * landF * 0.16 * chain
      t *= plateMtn
      // 草图山脉：沿折线的主脊（起伏比板块造山带小一些，用户画的走向不会被断成几截）+ 两侧高原
      if (rgv > 0.004) t += rgv * (0.55 + 0.45 * chain) * (0.3 + 0.7 * landF) * (0.25 + 1.05 * r)
      if (plv > 0.004) t += plv * landF * 0.16 * (0.55 + 0.45 * chain)
      const br = bd / 0.022
      const rg = dmath.exp(-(br * br)) * div
      t += rg * (landF > 0.5 ? -0.1 : 0.08 * (0.5 + r))
      // 板块内部的古老褶皱山地（如阿巴拉契亚）
      const oldM = smoothstep(0.15, 0.55, lf[6])
      const old = oldM === 0 || landF === 0 ? 0 : nDet.ridged(su * 5, sv * 5, 5) * oldM * 0.3 * landF
      t += old
      t *= mStr

      const hills = nDet.fbm(su * 11, sv * 11, 5) * (0.035 + 0.05 * landF)
      // 丘陵高地：内陆的脊状起伏，远离海岸更明显，交给侵蚀雕刻成水系
      const inland = smoothstep(0.02, 0.4, cont)
      const upMask = smoothstep(-0.3, 0.4, lf[7])
      const upland = inland === 0 ? 0 : nDet.ridged(su * 9, sv * 9, 5) * 0.16 * inland * (0.25 + 0.75 * upMask)

      const i = y * W + x
      // 边缘渐沉入海
      const ed = Math.min(u, A - u, v, 1 - v)
      // 草图的海陆由用户决定，图边不强制沉入海
      const fall = sf ? 0 : 1 - smoothstep(0.0, 0.14, ed)
      raw[i] = cont + t * 0.95 + hills + upland - 0.75 * fall * fall
      tect[i] = t
      activeRaw[i] = Math.max(g * up * plateMtn, Math.min(1, rgv))
    }
  }

  // —— 海平面：按陆地比例取分位数 ——
  // 草图：海平面取在使陆地面积与草图相同的分位数上（丘陵、山脉让海岸附近整体偏高，固定取 0 会让陆地向海外扩）
  const sea = sf ? sketchSeaLevel(raw, sketch!.land) : quantile(raw, 1 - p.landRatio)
  const elev = new Float32Array(N)
  const uplift = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const h = raw[i] - sea
    elev[i] = h > 0 ? 4.4 * dmath.pow(h, 1.25) : 4.8 * h
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
    if (basins.some((q) => dmath.hypot(q.x - x, q.y - y) < (q.r + r) * 1.4)) continue
    basins.push({ x, y, r })
    b++
  }
  const nB = new Noise(rng.fork())
  for (const b of basins) {
    const floor = rng.range(0.25, 0.7)
    const rim = rng.range(1.4, 2.6) * mStr * (sf ? 0.5 : 1)
    const R = b.r * 1.7
    const x0 = Math.max(0, Math.floor(b.x - R)), x1 = Math.min(W - 1, Math.ceil(b.x + R))
    const y0 = Math.max(0, Math.floor(b.y - R)), y1 = Math.min(H - 1, Math.ceil(b.y + R))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x
        if (elev[i] <= 0) continue
        const u = x / H, v = y / H
        let d = dmath.hypot(x - b.x, y - b.y) / b.r
        d *= 1 + 0.35 * nB.fbm(u * 6, v * 6, 3)
        const inner = 1 - smoothstep(0.55, 1.0, d)
        const ring = dmath.exp(-dmath.pow((d - 1.1) / 0.28, 2))
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
      if (dk < shelfW) depth = 0.015 + 0.13 * dmath.pow(dk / shelfW, 1.6)
      else depth = 0.145 + (abyss - 0.145) * (1 - dmath.exp(-(dk - shelfW) / 260))
      // 海沟：主动边缘外侧
      depth += act[i] * 2.2 * dmath.exp(-dmath.pow((dk - shelfW - 120) / 90, 2))
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
      const summit = lerpN(rng.range(0.4, 2.2), -0.6 - age * 1.2, dmath.pow(age, 0.9))
      const x0 = Math.max(0, Math.floor(px - rad * 3)), x1 = Math.min(W - 1, Math.ceil(px + rad * 3))
      const y0 = Math.max(0, Math.floor(py - rad * 3)), y1 = Math.min(H - 1, Math.ceil(py + rad * 3))
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const i = yy * W + xx
          const r = dmath.hypot(xx - px, yy - py) / rad
          const base = elev[i]
          const cone = base + (summit - base) * dmath.exp(-dmath.pow(r, 1.4))
          // 老火山顶被削平（平顶海山）
          const c = age > 0.5 ? Math.min(cone, summit - 0.05) : cone
          if (c > elev[i]) elev[i] = c
        }
      }
      px += dmath.cos(ang + rng.normal() * 0.25) * step
      py += dmath.sin(ang + rng.normal() * 0.25) * step
      if (px < 0 || py < 0 || px >= W || py >= H) break
    }
  }

  return { elev, uplift, active: act, basins }
}

/**
 * 地球底图的地形：按每格的经纬度（全球图，横向 360°）从 ETOPO 网格插值出高程，再补上网格分辨不出的细节——
 * 海平面附近的分形起伏（海岸线不是插值出的光滑曲线）、山地的脊状起伏与低地的小丘（交给侵蚀雕刻成水系）。
 * 抬升量按海拔给：侵蚀之后山体仍保持原来的高度。没有盆地记录、主动边缘（海沟已在海深数据里）
 */
export function buildEarthTerrain(p: WorldParams, rng: RNG): TerrainResult {
  const { width: W, height: H } = p
  const N = W * H
  const nDet = new Noise(rng.fork())
  const nCoast = new Noise(rng.fork())
  const elev = new Float32Array(N)
  const uplift = new Float32Array(N)
  for (let y = 0; y < H; y++) {
    const lat = latitudeOf(p, y, H)
    for (let x = 0; x < W; x++) elev[y * W + x] = earthElevation(lat, -180 + ((x + 0.5) * 360) / W)
  }
  // 离海岸线的格数（陆地量到海、海量到陆地）：海岸的分形起伏只加在岸边，内陆低地（亚马孙、西西伯利亚）不会被扰动到海平面以下
  const land = new Uint8Array(N)
  const sea = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    land[i] = elev[i] > 0 ? 1 : 0
    sea[i] = 1 - land[i]
  }
  const toLand = edt(land, W, H)
  const toSea = edt(sea, W, H)
  for (let y = 0; y < H; y++) {
    const v = y / H
    for (let x = 0; x < W; x++) {
      const u = x / H
      const i = y * W + x
      let h = elev[i]
      const d = land[i] ? toSea[i] : toLand[i]
      const near = 1 - smoothstep(1, 4, d)
      // 噪声只在权重非零处求值（离岸远、海拔低的格占大多数）
      if (near > 0) h += near * 0.12 * (0.4 + p.coastRoughness) * nCoast.fbm(u * 14, v * 14, 5)
      if (land[i]) {
        const mt = smoothstep(0.4, 2.5, h)
        // 山地的脊状起伏（只在高处，不会低于海面）；低地的小丘只往上加
        if (mt > 0) h += (nDet.ridged(u * 10, v * 10, 5) - 0.45) * 0.5 * mt * p.mountains
        h += (nDet.fbm(u * 24, v * 24, 4) * 0.5 + 0.5) * 0.05
        if (near === 0) h = Math.max(h, 0.002)
        uplift[i] = Math.max(0, h - 0.3) * 0.5 * p.mountains
      } else h += 0.04 * nDet.fbm(u * 20 + 3, v * 20, 3)
      elev[i] = h
    }
  }
  return { elev, uplift, active: new Float32Array(N), basins: [] }
}

function sketchSeaLevel(raw: Float32Array, land: Float32Array) {
  let n = 0
  for (let i = 0; i < land.length; i++) if (land[i] >= 0.5) n++
  if (n === 0) {
    // 全是海：海平面略高于最高点
    let mx = -Infinity
    for (let i = 0; i < raw.length; i++) mx = Math.max(mx, raw[i])
    return mx + 1e-3
  }
  return quantile(raw, 1 - n / land.length)
}

function lerpN(a: number, b: number, t: number) {
  return a + (b - a) * t
}
