/**
 * 【实验】森林（成片林地）的六种画法：云冠、鳞林、点叶、铜版林、阴刻林、几何林。
 * 每种画法自己处理三种规模（十来棵的小林、中等林地、大片森林的林缘与内部）与三种林型（阔叶、针叶、雨林）。
 * 不成林的小块与林缘外的散树在 Terrain.trees 里，由树木画法（./trees.ts）画。
 */
import { blur, sampleField } from '../../../gen/util'
import { fnoise, hash } from '../fields'
import type { Pen } from '../glyphBatch'
import { contours, ringArea, simplify } from '../svg/contour'
import { addDab, addEllipse, addTaper, chaikin, mixColor, resample, rnd, type P } from './brush'
import type { SymbolStyle } from './index'
import type { ForestSpot, Terrain, TerrainInput, TreeKind } from './terrain'

// ———————————————————————— 林区：按林型分开的轮廓 ————————————————————————

type Box = [number, number, number, number]

/** 一条闭合环：林地（场值高的一侧）在行进方向的左手边，于是外环与内环绕向相反，按非零规则填充即得带洞的区域 */
interface Ring {
  pts: P[]
  hole: boolean
  area: number
  box: Box
}

/** 一块林区：同一种林型连成的一片（外环 + 林间空地的内环） */
interface Zone {
  kind: TreeKind
  outer: Ring
  holes: Ring[]
}

const boxOf = (pts: P[]): Box => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

function inside(pts: P[], x: number, y: number) {
  let c = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** 追"场 ≥ level"的边界，转成像素坐标并统一绕向（场值高的一侧在左） */
function orientedRings(field: Float32Array, W: number, H: number, S: number, level: number, minArea: number): Ring[] {
  const out: Ring[] = []
  for (const raw of contours(field, W, H, level, true)) {
    const area = ringArea(raw) * S * S
    if (area < minArea) continue
    const r = simplify(raw, 0.3)
    let pts: P[] = []
    for (let i = 0; i < r.length; i += 2) pts.push([(r[i] + 0.5) * S, (r[i + 1] + 0.5) * S])
    if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.01) pts.pop()
    if (pts.length < 3) continue
    // 取几条边，比较左右两侧的场值与多边形内外
    let highLeft = 0
    let inLeft = 0
    const n = pts.length
    const step = Math.max(1, Math.floor(n / 9))
    for (let i = 0; i < n; i += step) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const d = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (d < 0.2) continue
      const nx = -(b[1] - a[1]) / d
      const ny = (b[0] - a[0]) / d
      const mx = (a[0] + b[0]) / 2
      const my = (a[1] + b[1]) / 2
      const e = S * 0.6
      const l = sampleField(field, W, H, (mx + nx * e) / S - 0.5, (my + ny * e) / S - 0.5)
      const rr = sampleField(field, W, H, (mx - nx * e) / S - 0.5, (my - ny * e) / S - 0.5)
      highLeft += l > rr ? 1 : -1
      inLeft += inside(pts, mx + nx * 0.3, my + ny * 0.3) ? 1 : -1
    }
    const hole = highLeft > 0 !== inLeft > 0
    if (highLeft < 0) pts = pts.reverse()
    out.push({ pts, hole, area, box: boxOf(pts) })
  }
  return out
}

interface ZoneData {
  zones: Zone[]
  /** 到林缘的距离场（格，羽化过）：追深处的轮廓用 */
  depth: Float32Array
  deep: Map<number, Ring[]>
}
const zoneCache = new WeakMap<TerrainInput, ZoneData>()
const KINDS: TreeKind[] = ['leaf', 'pine', 'jungle']

/**
 * 把林地按林型划成大块：各林型的指示场先做一次大半径的平滑再取最大者，零星夹杂的异种格并入周围的林型，
 * 于是针叶林、阔叶林、雨林各成一片，交界处各有自己的轮廓。
 */
function zoneData(T: Terrain): ZoneData {
  const input = T.input
  let data = zoneCache.get(input)
  if (data) return data
  const { W, H, S } = input
  const N = W * H
  const forest = new Uint8Array(N)
  const ind = KINDS.map(() => new Float32Array(N))
  const depth = new Float32Array(N)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) * S
      const py = (y + 0.5) * S
      const kind = T.kindAt(px, py)
      if (!kind || T.forestAt(px, py) < 0.15) continue
      const i = y * W + x
      forest[i] = 1
      ind[KINDS.indexOf(kind)][i] = 1
      depth[i] = T.depthAt(px, py)
    }
  }
  for (const f of ind) blur(f, W, H, 3, 2)
  const zones: Zone[] = []
  KINDS.forEach((kind, t) => {
    const m = new Float32Array(N)
    let any = false
    for (let i = 0; i < N; i++) {
      if (!forest[i]) continue
      const v = ind[t][i]
      if (v >= ind[(t + 1) % 3][i] && v >= ind[(t + 2) % 3][i] && (t === 0 || v > ind[0][i])) {
        m[i] = 1
        any = true
      }
    }
    if (!any) return
    blur(m, W, H, 1, 1)
    const rings = orientedRings(m, W, H, S, 0.5, 40 * T.k * T.k)
    const outers = rings.filter((r) => !r.hole).sort((a, b) => a.area - b.area)
    const made = outers.map((outer) => ({ kind, outer, holes: [] as Ring[] }))
    for (const h of rings) {
      if (!h.hole) continue
      const [x, y] = h.pts[0]
      const z = made.find((q) => q.outer.area > h.area && x >= q.outer.box[0] && x <= q.outer.box[2] && y >= q.outer.box[1] && y <= q.outer.box[3] && inside(q.outer.pts, x, y))
      z?.holes.push(h)
    }
    zones.push(...made)
  })
  blur(depth, W, H, 1, 1)
  data = { zones, depth, deep: new Map() }
  zoneCache.set(input, data)
  return data
}

/** 当前要画的范围（比较图只画一小块时，Terrain 里的地物已按范围筛过） */
function extentOf(T: Terrain): Box {
  let b: Box = [Infinity, Infinity, -Infinity, -Infinity]
  const add = (x: number, y: number) => {
    b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]
  }
  for (const s of T.spots) add(s.x, s.y)
  for (const r of T.rings) for (const p of r.pts) add(p[0], p[1])
  const pad = 12 * T.k
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]
}
const hit = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

function zonesOf(T: Terrain): Zone[] {
  const ext = extentOf(T)
  return zoneData(T).zones.filter((z) => hit(z.outer.box, ext))
}

/** 林地深处（到林缘超过 level 格）的轮廓 */
function deepRings(T: Terrain, level: number): Ring[] {
  const d = zoneData(T)
  let r = d.deep.get(level)
  if (!r) d.deep.set(level, (r = orientedRings(d.depth, T.input.W, T.input.H, T.input.S, level, 60 * T.k * T.k)))
  const ext = extentOf(T)
  return r.filter((q) => hit(q.box, ext))
}

// ———————————————————————— 扇贝边 ————————————————————————

/** 扇贝边的一个节点：位置与朝外（背离林地）的法向 */
interface Anchor {
  p: P
  out: P
}

/**
 * 沿闭合环取扇贝边的节点：间距在 step 上下浮动（按位置派生），小环至少分成五段。
 * 环先切角圆顺一次，去掉格点的折角
 */
function anchorsOf(ring: Ring, step: number, seed: number): Anchor[] {
  const smooth = chaikin(ring.pts, 1, true)
  let per = 0
  for (let i = 0; i < smooth.length; i++) {
    const a = smooth[i]
    const b = smooth[(i + 1) % smooth.length]
    per += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  const st = Math.min(step, per / 5)
  const pts = resample(smooth, st / 2, true)
  const out: Anchor[] = []
  for (let i = 0; i < pts.length; ) {
    const q = pts[i]
    out.push({ p: q.p, out: [q.t[1], -q.t[0]] })
    const h = hash(seed + i * 7, Math.round(q.p[0] * 3 + q.p[1] * 5))
    i += h < 0.25 ? 1 : h < 0.8 ? 2 : 3
  }
  // 末段太短时并入首段
  if (out.length > 4) {
    const a = out[out.length - 1].p
    const b = out[0].p
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < st * 0.45) out.pop()
  }
  return out
}

/** 相邻两节点之间向外鼓一个弧（pointed 时为尖角）；bulge 是弧高与弦长之比 */
function addScallops(pen: Pen, an: Anchor[], bulge: number, pointed: boolean, dx = 0, dy = 0, seed = 0) {
  const n = an.length
  if (n < 3) return
  pen.moveTo(an[0].p[0] + dx, an[0].p[1] + dy)
  for (let i = 0; i < n; i++) {
    const a = an[i].p
    const b = an[(i + 1) % n].p
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const ox = (b[1] - a[1]) / L
    const oy = -(b[0] - a[0]) / L
    const h = L * bulge * (0.8 + 0.4 * hash(seed + i, 91))
    const mx = (a[0] + b[0]) / 2 + dx
    const my = (a[1] + b[1]) / 2 + dy
    if (pointed) {
      // 针叶：尖顶略向上偏，像一排树梢
      pen.lineTo(mx + ox * h * 1.5, my + oy * h * 1.5 - h * 0.35)
      pen.lineTo(b[0] + dx, b[1] + dy)
    } else pen.quadraticCurveTo(mx + ox * h * 2, my + oy * h * 2, b[0] + dx, b[1] + dy)
  }
  pen.closePath()
}

const zoneAnchors = new WeakMap<Ring, Map<string, Anchor[]>>()
function ringAnchors(ring: Ring, step: number): Anchor[] {
  let m = zoneAnchors.get(ring)
  if (!m) zoneAnchors.set(ring, (m = new Map()))
  const key = step.toFixed(2)
  let a = m.get(key)
  if (!a) m.set(key, (a = anchorsOf(ring, step, Math.round(ring.box[0] * 13 + ring.box[1] * 7))))
  return a
}

/** 南缘（外法线朝下）的节点处露出的树干：位置列表 */
function trunkSpots(an: Anchor[], every: number): P[] {
  const out: P[] = []
  an.forEach((a, i) => {
    if (a.out[1] < 0.5 || i % every) return
    out.push(a.p)
  })
  return out
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// ———————————————————————— 1 云冠 ————————————————————————

const cloud: SymbolStyle = {
  id: 'cloud',
  name: '云冠',
  desc: '整片林地画成一朵有厚度的云：扇贝形的林冠轮廓，针叶林是一排树梢；深处另起一层更深的林冠，南缘露出树干。',
  draw(T, o, out) {
    const k = T.k
    const zones = zonesOf(T)
    const light = { leaf: o.leaf, pine: o.pine, jungle: mixColor(o.leaf, o.leafDark, 0.3) } as Record<TreeKind, string>
    const dark = { leaf: o.leafDark, pine: o.pineDark, jungle: mixColor(o.leafDark, o.pineDark, 0.6) } as Record<TreeKind, string>
    const stepOf = (kind: TreeKind) => (kind === 'pine' ? 4.2 : kind === 'jungle' ? 6.4 : 5) * k
    const bulgeOf = (kind: TreeKind) => (kind === 'pine' ? 0.5 : kind === 'jungle' ? 0.44 : 0.4)
    // 南缘的树干：先画，林冠压住上半截
    out.under((pen) => {
      pen.strokeStyle = o.ink
      pen.lineWidth = 0.75 * k
      pen.beginPath()
      for (const z of zones) {
        for (const r of [z.outer, ...z.holes]) {
          for (const [x, y] of trunkSpots(ringAnchors(r, stepOf(z.kind)), 1)) {
            pen.moveTo(x, y - 1 * k)
            pen.lineTo(x, y + 4.6 * k)
          }
        }
      }
      pen.stroke()
    })
    for (const z of zones) {
      const pointed = z.kind === 'pine'
      const rings = [z.outer, ...z.holes]
      const path = (pen: Pen, dx: number, dy: number) => {
        pen.beginPath()
        for (const r of rings) addScallops(pen, ringAnchors(r, stepOf(z.kind)), bulgeOf(z.kind), pointed, dx, dy, r.pts.length)
      }
      out.under((pen) => {
        // 厚度：向右下偏移的暗色副本
        path(pen, 1.1 * k, 1.7 * k)
        pen.fillStyle = dark[z.kind]
        pen.fill()
        pen.strokeStyle = o.ink
        pen.lineWidth = 0.7 * k
        pen.stroke()
        path(pen, 0, 0)
        pen.fillStyle = light[z.kind]
        pen.fill()
        pen.lineWidth = 0.85 * k
        pen.stroke()
      })
    }
    // 深处：再叠一层更深的林冠，有自己的扇贝边
    for (const [level, alpha] of [
      [3.6, 0.3],
      [8, 0.28],
    ] as const) {
      const deep = deepRings(T, level)
      if (!deep.length) continue
      out.under((pen) => {
        pen.beginPath()
        for (const r of deep) addScallops(pen, ringAnchors(r, 5.5 * k), 0.34, false, 0, 0, r.pts.length)
        pen.fillStyle = o.pineDark
        pen.globalAlpha = alpha
        pen.fill()
        pen.globalAlpha = 1
      })
    }
    // 林冠的起伏：每个鼓包右下垫一小块暗色，再勾一个云头式的卷（针叶为叠的人字）
    const marked = T.spots.filter((s) => s.depth >= 1.3 && hash(s.seed, 17) < 0.8 && T.forestAt(s.x, s.y - s.s * 0.5) > 0.74)
    out.under((pen) => {
      pen.beginPath()
      for (const s of marked) {
        if (s.kind === 'pine') continue
        const a = s.s * (0.5 + 0.3 * hash(s.seed, 18))
        addDab(pen, s.x + a * 0.35, s.y - s.s * 0.5 + a * 0.3, a * 2, a * 0.8, 0.25)
      }
      pen.fillStyle = o.leafDark
      pen.globalAlpha = 0.55
      pen.fill()
      pen.globalAlpha = 1
    })
    out.under((pen) => {
      pen.strokeStyle = o.ink
      pen.lineWidth = 0.55 * k
      pen.globalAlpha = 0.72
      pen.beginPath()
      for (const s of marked) {
        const a = s.s * (0.5 + 0.3 * hash(s.seed, 18))
        const x = s.x
        const y = s.y - s.s * 0.5
        if (s.kind === 'pine') {
          for (let q = 0; q < 2; q++) {
            const yy = y - q * a * 0.8
            const w = a * (0.8 - q * 0.22)
            pen.moveTo(x - w, yy + a * 0.55)
            pen.lineTo(x, yy - a * 0.45)
            pen.lineTo(x + w, yy + a * 0.55)
          }
        } else {
          // 云头卷：左起一道拱弧，右端向里收成小钩
          const flip = hash(s.seed, 19) > 0.5 ? 1 : -1
          pen.moveTo(x - flip * a, y + a * 0.2)
          pen.quadraticCurveTo(x - flip * a * 0.9, y - a * 0.85, x, y - a * 0.8)
          pen.quadraticCurveTo(x + flip * a * 0.95, y - a * 0.75, x + flip * a * 0.9, y - a * 0.05)
          pen.quadraticCurveTo(x + flip * a * 0.8, y + a * 0.4, x + flip * a * 0.3, y + a * 0.15)
        }
      }
      pen.stroke()
      pen.globalAlpha = 1
    })
  },
}

// ———————————————————————— 2 鳞林 ————————————————————————

const scale: SymbolStyle = {
  id: 'scale',
  name: '鳞林',
  desc: '青海波式的鳞片错位铺满林地，自北向南逐排遮叠：阔叶是圆弧鳞，针叶是尖顶鳞；色调成片深浅变化，南缘一排带树干。',
  draw(T, o, out) {
    const k = T.k
    if (!T.spots.length) return
    const ext = extentOf(T)
    const dx = 5.8 * k
    const dy = 3.1 * k
    const tones: Record<TreeKind, string[]> = {
      leaf: [o.leaf, mixColor(o.leaf, o.leafDark, 0.5), o.leafDark],
      pine: [o.pine, mixColor(o.pine, o.pineDark, 0.5), o.pineDark],
      jungle: [mixColor(o.leaf, o.leafDark, 0.3), mixColor(o.leafDark, o.pineDark, 0.3), mixColor(o.leafDark, o.pineDark, 0.75)],
      acacia: [o.leaf],
      bush: [o.leaf],
    }
    const j0 = Math.floor(ext[1] / dy)
    const j1 = Math.ceil(ext[3] / dy)
    const i0 = Math.floor(ext[0] / dx) - 1
    const i1 = Math.ceil(ext[2] / dx) + 1
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const gx = (i + (j & 1 ? 0.5 : 0)) * dx
        const gy = j * dy
        if (T.forestAt(gx, gy - 1.2 * k) < 0.5) continue
        const kind = T.kindAt(gx, gy - 1.2 * k) ?? T.kindAt(gx, gy - 3 * k) ?? 'leaf'
        const x = gx + (hash(i * 3 + 1, j * 5) - 0.5) * 1.1 * k
        const y = gy + (hash(i * 5, j * 3 + 2) - 0.5) * 0.8 * k
        const depth = T.depthAt(gx, gy - 1.2 * k)
        const front = T.forestAt(gx, gy + dy * 1.25) < 0.5
        const rim = depth < 2.6
        // 色调：低频噪声成片变化，深处整体偏深
        const nz = fnoise(gx + 311, gy * 1.6 + 97, 46 * k) + (depth > 5 ? 0.12 : 0) + (hash(i, j) - 0.5) * 0.1
        const tone = tones[kind][nz < 0.44 ? 0 : nz < 0.58 ? 1 : 2]
        const a = dx * (kind === 'jungle' ? 0.68 : 0.62)
        const h = (kind === 'pine' ? 5.6 : kind === 'jungle' ? 5 : 4.5) * k
        const dome = (pen: Pen, f: number) => {
          const w = a * f
          const t = h * f
          if (kind === 'pine') {
            pen.moveTo(x - w, y)
            pen.quadraticCurveTo(x - w * 0.3, y - t * 0.3, x, y - t)
            pen.quadraticCurveTo(x + w * 0.3, y - t * 0.3, x + w, y)
          } else {
            pen.moveTo(x - w, y)
            pen.quadraticCurveTo(x - w, y - t, x, y - t)
            pen.quadraticCurveTo(x + w, y - t, x + w, y)
          }
        }
        // 排序按整排的纵坐标（不含抖动），同排先偶数列后奇数列：同层的鳞互不相叠，合批后路径元素少得多
        // 每片鳞只有一笔填色、一笔描线（轮廓、鳞心、树干并在同一条路径里），合批后每层只多出几条路径
        out.item(gy + (i & 1) * 0.01, (pen) => {
          pen.beginPath()
          dome(pen, 1)
          // 底边微鼓：南缘最后一排露出完整的鳞
          pen.quadraticCurveTo(x, y + 1.1 * k, x - a, y)
          pen.closePath()
          pen.fillStyle = tone
          pen.fill()
          pen.strokeStyle = o.ink
          pen.lineWidth = 0.55 * k
          pen.beginPath()
          dome(pen, 1)
          if (front) {
            pen.quadraticCurveTo(x, y + 1.1 * k, x - a, y)
            pen.moveTo(x, y + 0.6 * k)
            pen.lineTo(x, y + 3.2 * k)
          }
          // 鳞心：阔叶近林缘的一道同心弧，雨林两道，针叶一根中脉
          if (kind === 'pine') {
            if (rim || hash(i * 7, j) < 0.35) {
              pen.moveTo(x, y - h * 0.82)
              pen.lineTo(x, y - h * 0.3)
            }
          } else if (rim || kind === 'jungle') {
            dome(pen, 0.58)
            if (kind === 'jungle' && rim) dome(pen, 0.28)
          }
          pen.stroke()
        })
      }
    }
  },
}

// ———————————————————————— 3 点叶 ————————————————————————

const dab: SymbolStyle = {
  id: 'dab',
  name: '点叶',
  desc: '山水画的点叶法：每棵树是几笔横点叠成的一簇，没有轮廓线，淡墨在下、浓墨压上；林缘的树带一根微弯的细干，深处只剩墨点与淡晕，针叶改用介字点（叠起来的人字短笔）。',
  draw(T, o, out) {
    const k = T.k
    const zones = zonesOf(T)
    const washOf = { leaf: mixColor(o.leaf, o.leafDark, 0.15), pine: mixColor(o.pine, o.pineDark, 0.1), jungle: mixColor(o.leaf, o.leafDark, 0.35) } as Record<TreeKind, string>
    const tint = mixColor(o.leaf, o.leafDark, 0.45)
    const tintPine = mixColor(o.pine, o.pineDark, 0.35)
    const mid = mixColor(o.leafDark, o.pineDark, 0.35)
    const deepInk = mixColor(o.ink, o.pineDark, 0.4)
    // 底下一层淡色，把整片连成一体
    for (const kind of KINDS) {
      const zs = zones.filter((z) => z.kind === kind)
      if (!zs.length) continue
      out.under((pen) => {
        pen.beginPath()
        for (const z of zs) {
          for (const r of [z.outer, ...z.holes]) {
            const pts = chaikin(r.pts, 2, true)
            pts.forEach(([x, y], i) => (i ? pen.lineTo(x, y) : pen.moveTo(x, y)))
            pen.closePath()
          }
        }
        pen.fillStyle = washOf[kind]
        pen.globalAlpha = 0.6
        pen.fill()
        pen.globalAlpha = 1
      })
    }
    // 深处的大块淡晕
    out.under((pen) => {
      pen.beginPath()
      for (const s of T.spots) {
        if (s.depth < 3 || hash(s.seed, 41) > 0.3) continue
        const r = rnd(s.seed)
        addDab(pen, s.x + (r(42) - 0.5) * 4 * k, s.y - s.s * 0.6, (10 + r(43) * 8) * k, (5 + r(44) * 3) * k, (r(45) - 0.5) * 0.3)
      }
      pen.fillStyle = mid
      pen.globalAlpha = 0.28
      pen.fill()
      pen.globalAlpha = 1
    })
    for (const s of T.spots) {
      const r = rnd(s.seed)
      const rim = s.depth < 1.8 || s.front
      // 深处留气口：按低频噪声成片地略去一些
      const air = fnoise(s.x + 57, s.y + 913, 30 * k)
      if (!rim && s.depth > 3 && air < 0.38 && r(50) < 0.6) continue
      const dense = air > 0.55
      const m = s.s * (rim ? 1.12 : 1)
      const trunk = rim || r(49) < 0.3
      out.item(s.y, (pen) => {
        const x = s.x
        const y = s.y
        const lean = s.kind === 'pine' ? (r(51) - 0.5) * m * 0.2 : (r(51) - 0.5) * m * 0.8
        if (trunk) {
          // 细干：微弯，上细下粗
          pen.beginPath()
          addTaper(
            pen,
            [
              [x, y + m * 0.4],
              [x + lean * 0.2, y - m * 0.2],
              [x + lean, y - m * (s.kind === 'pine' ? 1.9 : 0.9)],
            ],
            (u) => (1 - 0.6 * u) * k,
          )
          pen.fillStyle = o.ink
          pen.fill()
        }
        if (s.kind === 'pine') {
          // 介字点：三层向下撇的人字短笔，底下各垫一点淡墨
          pen.beginPath()
          for (let tier = 0; tier < 3; tier++) addDab(pen, x + (lean * tier) / 3, y - m * (0.25 + tier * 0.6), m * (1.75 - tier * 0.4), m * (0.95 - tier * 0.1), 0)
          pen.fillStyle = tintPine
          pen.globalAlpha = 0.92
          pen.fill()
          pen.globalAlpha = 1
          pen.beginPath()
          for (let tier = 0; tier < 3; tier++) {
            const cx = x + (lean * tier) / 3
            const cy = y - m * (0.55 + tier * 0.6)
            const w = m * (0.82 - tier * 0.2)
            const d = m * (0.42 + r(60 + tier) * 0.12)
            addTaper(
              pen,
              [
                [cx - w, cy + d],
                [cx, cy - d * 0.25],
                [cx + w, cy + d],
              ],
              (u) => (0.35 + 0.75 * Math.sin(u * Math.PI)) * k,
            )
          }
          pen.fillStyle = dense || rim ? deepInk : o.pineDark
          pen.fill()
          return
        }
        const jungle = s.kind === 'jungle'
        const cx = x + lean
        const g = jungle ? 1.18 : 1
        const jit = (q: number) => (r(q) - 0.5) * m * 0.3
        const tl = (q: number) => (r(q) - 0.5) * (jungle ? 0.9 : 0.3)
        // 淡墨：三点铺出树冠
        pen.beginPath()
        addDab(pen, cx - m * 0.55 * g + jit(52), y - m * 0.78 + jit(53), m * 1.3 * g, m * 0.85, tl(54))
        addDab(pen, cx + m * 0.5 * g + jit(55), y - m * 0.85 + jit(56), m * 1.25 * g, m * 0.85, tl(57))
        addDab(pen, cx + jit(58), y - m * 1.32 * g + jit(59), m * 1.2 * g, m * 0.8, tl(60))
        pen.fillStyle = tint
        pen.globalAlpha = 0.95
        pen.fill()
        // 中墨：两点
        pen.beginPath()
        addDab(pen, cx - m * 0.2 + jit(61), y - m * 0.6 + jit(62), m * 0.95 * g, m * 0.6, tl(63))
        addDab(pen, cx + m * 0.4 + jit(64), y - m * 1.12 * g + jit(65), m * 0.9 * g, m * 0.55, tl(66))
        pen.fillStyle = mid
        pen.fill()
        pen.globalAlpha = 1
        // 浓墨：一两点压在右下
        pen.beginPath()
        addDab(pen, cx + m * 0.42 + jit(67), y - m * 0.5 + jit(68), m * 0.8, m * 0.45, tl(69))
        if (dense || rim) addDab(pen, cx - m * 0.5 + jit(70), y - m * 1.02 + jit(71), m * 0.7, m * 0.42, tl(72))
        pen.fillStyle = deepInk
        pen.globalAlpha = 0.88
        pen.fill()
        pen.globalAlpha = 1
      })
    }
  },
}

// ———————————————————————— 4 铜版林 ————————————————————————

/** 俯视的花形树冠：n 瓣 */
function addRosette(pen: Pen, cx: number, cy: number, r: number, n: number, rot: number) {
  for (let j = 0; j <= n; j++) {
    const a = rot + (j / n) * Math.PI * 2
    const px = cx + Math.cos(a) * r * 0.78
    const py = cy + Math.sin(a) * r * 0.78
    if (j === 0) pen.moveTo(px, py)
    else {
      const c = a - Math.PI / n
      pen.quadraticCurveTo(cx + Math.cos(c) * r * 1.38, cy + Math.sin(c) * r * 1.38, px, py)
    }
  }
  pen.closePath()
}

/** 俯视的星形树冠（针叶）：n 个尖 */
function addStar(pen: Pen, cx: number, cy: number, r: number, n: number, rot: number) {
  for (let q = 0; q < n * 2; q++) {
    const a = rot + (q / (n * 2)) * Math.PI * 2
    const rr = r * (q & 1 ? 0.5 : 1.15)
    if (q) pen.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
    else pen.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
  }
  pen.closePath()
}

const rosette: SymbolStyle = {
  id: 'rosette',
  name: '铜版林',
  desc: '铜版地形图的平面树：俯视的花形树冠（针叶为星形），向东南落一块投影，林缘的树另加几道递减的短线；疏密成簇、留出林窗，深处合成大团，林界一圈细点。',
  draw(T, o, out) {
    const k = T.k
    const zones = zonesOf(T)
    const fill = { leaf: mixColor(o.leaf, o.snow, 0.12), pine: o.pine, jungle: mixColor(o.leaf, o.leafDark, 0.25) } as Record<TreeKind, string>
    const shade = mixColor(o.ink, o.pineDark, 0.3)
    // 一层很淡的底色：不放大时仍读得出林地的范围
    out.under((pen) => {
      pen.beginPath()
      for (const z of zones) {
        for (const r of [z.outer, ...z.holes]) {
          const pts = chaikin(r.pts, 2, true)
          pts.forEach(([x, y], i) => (i ? pen.lineTo(x, y) : pen.moveTo(x, y)))
          pen.closePath()
        }
      }
      pen.fillStyle = o.leafDark
      pen.globalAlpha = 0.28
      pen.fill()
      pen.globalAlpha = 1
    })
    // 林界：一圈细点（极短的圆头线段）
    out.under((pen) => {
      pen.beginPath()
      for (const ring of T.rings) {
        for (const q of resample(chaikin(ring.pts, 2, true), 3.1 * k, true)) {
          const nx = q.t[1]
          const ny = -q.t[0]
          // 点线画在林地外侧一点
          const sgn = T.forestAt(q.p[0] + nx * 3 * k, q.p[1] + ny * 3 * k) < T.forestAt(q.p[0] - nx * 3 * k, q.p[1] - ny * 3 * k) ? 1 : -1
          const x = q.p[0] + nx * sgn * 3 * k
          const y = q.p[1] + ny * sgn * 3 * k
          pen.moveTo(x, y)
          pen.lineTo(x + 0.05 * k, y)
        }
      }
      pen.strokeStyle = o.ink
      pen.lineWidth = 0.8 * k
      pen.globalAlpha = 0.75
      pen.stroke()
      pen.globalAlpha = 1
    })
    // 深处的大团：每个粗格里取一个树位当团心
    const cellOf = (s: ForestSpot) => `${Math.floor(s.x / (11 * k))},${Math.floor((s.y + (Math.floor(s.x / (11 * k)) & 1) * 4.5 * k) / (9 * k))}`
    const heads = new Map<string, ForestSpot>()
    for (const s of T.spots) if (s.depth > 3.2 && !heads.has(cellOf(s))) heads.set(cellOf(s), s)
    for (const s of T.spots) {
      const r = rnd(s.seed)
      const big = heads.get(cellOf(s)) === s
      const rim = s.depth < 1.8
      if (!big) {
        // 成簇：低频噪声的低处是林窗；大团周围也让开一些
        const gap = fnoise(s.x + 733, s.y + 129, 20 * k)
        if (s.depth > 1.6 && gap < 0.38) continue
        if (s.depth > 3.2 && r(81) < 0.45) continue
      }
      const R = s.s * (big ? 1.45 : s.kind === 'jungle' ? 0.86 : 0.64 + r(82) * 0.3)
      const x = s.x
      const y = s.y - s.s * 0.6
      const lobes = big ? 7 + Math.floor(r(84) * 2) : s.kind === 'jungle' ? 7 : 5 + Math.floor(r(84) * 2.4)
      const rot = r(83) * Math.PI
      const crown = (pen: Pen, dx: number, dy: number) => {
        if (s.kind === 'pine') addStar(pen, x + dx, y + dy, R * (big ? 1 : 1.08), big ? 9 : 6, rot)
        else addRosette(pen, x + dx, y + dy, R, lobes, rot)
      }
      out.item(s.y + (big ? 1.5 * k : 0), (pen) => {
        // 投影：向东南偏移的一块暗色
        const off = (big ? 1.5 : 1.05) * k
        pen.beginPath()
        crown(pen, off, off)
        pen.fillStyle = shade
        pen.globalAlpha = 0.66
        pen.fill()
        pen.globalAlpha = 1
        pen.strokeStyle = o.ink
        if (rim) {
          // 林缘的树：东侧另加几道递减的短横线
          pen.lineWidth = 0.42 * k
          pen.beginPath()
          for (let q = 0; q < 3; q++) {
            const yy = y + R * (0.5 + q * 0.42)
            pen.moveTo(x + R * (1.05 - q * 0.12), yy)
            pen.lineTo(x + R * (2.3 - q * 0.42), yy)
          }
          pen.stroke()
        }
        pen.beginPath()
        crown(pen, 0, 0)
        pen.fillStyle = fill[s.kind] ?? fill.leaf
        pen.fill()
        pen.lineWidth = 0.5 * k
        pen.stroke()
        if (big && s.kind !== 'pine') {
          // 大团里的三道小弧：几棵树冠挤在一起
          pen.beginPath()
          for (let q = 0; q < 3; q++) {
            const a = rot + q * 2.1 + 0.4
            const cx = x + Math.cos(a) * R * 0.36
            const cy = y + Math.sin(a) * R * 0.36
            pen.moveTo(cx - R * 0.3, cy + R * 0.08)
            pen.quadraticCurveTo(cx, cy - R * 0.42, cx + R * 0.3, cy + R * 0.08)
          }
          pen.lineWidth = 0.42 * k
          pen.stroke()
        } else if (s.kind === 'pine') {
          // 星心一点
          pen.beginPath()
          pen.moveTo(x, y)
          pen.lineTo(x + 0.05 * k, y)
          pen.lineWidth = (big ? 1.3 : 0.9) * k
          pen.stroke()
        }
      })
    }
  },
}

// ———————————————————————— 5 阴刻林 ————————————————————————

const carved: SymbolStyle = {
  id: 'carved',
  name: '阴刻林',
  desc: '木刻的阴刻：整片林地是一块深色的版面，树冠用亮色的刻痕刻出来，林缘刻得大而清楚、深处小而稀，于是林缘亮、深处暗；南缘露出粗短的树干。',
  draw(T, o, out) {
    const k = T.k
    const zones = zonesOf(T)
    const mass = {
      leaf: mixColor(o.ink, o.leafDark, 0.52),
      pine: mixColor(o.ink, o.pineDark, 0.42),
      jungle: mixColor(o.ink, o.pineDark, 0.6),
    } as Record<TreeKind, string>
    const cut = mixColor(o.leaf, o.snow, 0.35)
    const stepOf = (kind: TreeKind) => (kind === 'pine' ? 4.4 : 5.6) * k
    out.under((pen) => {
      pen.strokeStyle = o.ink
      pen.lineWidth = 1.5 * k
      pen.beginPath()
      for (const z of zones) {
        for (const r of [z.outer, ...z.holes]) {
          for (const [x, y] of trunkSpots(ringAnchors(r, stepOf(z.kind)), 1)) {
            pen.moveTo(x, y - 1 * k)
            pen.lineTo(x, y + 4.2 * k)
          }
        }
      }
      pen.stroke()
    })
    for (const z of zones) {
      out.under((pen) => {
        pen.beginPath()
        for (const r of [z.outer, ...z.holes]) addScallops(pen, ringAnchors(r, stepOf(z.kind)), z.kind === 'pine' ? 0.55 : 0.46, z.kind === 'pine', 0, 0, r.pts.length)
        pen.fillStyle = mass[z.kind]
        pen.fill()
        pen.strokeStyle = o.ink
        pen.lineWidth = 1.1 * k
        pen.stroke()
      })
    }
    // 刻痕：林缘大而清楚，深处小而稀
    out.under((pen) => {
      pen.beginPath()
      for (const s of T.spots) {
        const r = rnd(s.seed)
        const t = smooth(1.5, 6, s.depth)
        if (r(90) < t * 0.5) continue
        if (T.forestAt(s.x, s.y - s.s * 0.7) < 0.62) continue
        const a = s.s * (1.05 - 0.5 * t)
        const x = s.x
        const y = s.y - s.s * 0.7
        const w = (1.25 - 0.55 * t) * k
        if (s.kind === 'pine') {
          // 人字纹：两道叠起来
          for (let q = 0; q < 2; q++) {
            const yy = y + (q - 0.5) * a * 0.85
            addTaper(
              pen,
              [
                [x - a * 0.62, yy + a * 0.45],
                [x, yy - a * 0.4],
                [x + a * 0.62, yy + a * 0.45],
              ],
              (u) => w * (0.25 + 0.75 * Math.sin(u * Math.PI)),
            )
          }
        } else {
          // 新月：一道向上拱的刻痕，中间宽两头尖
          const tilt = (r(91) - 0.5) * 0.5
          const pts: P[] = []
          for (let q = 0; q <= 4; q++) {
            const u = q / 4 - 0.5
            const px = u * 2 * a
            const py = -(1 - (u * 2) ** 2) * a * 0.75
            pts.push([x + px * Math.cos(tilt) - py * Math.sin(tilt), y + a * 0.3 + px * Math.sin(tilt) + py * Math.cos(tilt)])
          }
          addTaper(pen, pts, (u) => w * 1.2 * Math.sin(u * Math.PI))
          if (s.kind === 'jungle') addEllipse(pen, x, y + a * 0.25, 0.55 * k)
        }
      }
      // 深处偶尔一道长刻痕，像木纹
      for (const s of T.spots) {
        if (s.depth < 4.5 || hash(s.seed, 95) > 0.06) continue
        const len = (5 + hash(s.seed, 96) * 6) * k
        addTaper(
          pen,
          [
            [s.x - len, s.y + 0.4 * k],
            [s.x, s.y - 0.5 * k],
            [s.x + len, s.y + 0.2 * k],
          ],
          (u) => 0.7 * k * Math.sin(u * Math.PI),
        )
      }
      pen.fillStyle = cut
      pen.fill()
    })
  },
}

// ———————————————————————— 6 几何林 ————————————————————————

const halftone: SymbolStyle = {
  id: 'halftone',
  name: '几何林',
  desc: '几何化的网点：每棵树一个平涂的形（阔叶圆、针叶三角、雨林半圆），不描轮廓；林缘小而疏，越往深处越大，直到叠成一片，像印刷的半调网点。',
  draw(T, o, out) {
    const k = T.k
    const tones: Record<TreeKind, string[]> = {
      leaf: [mixColor(o.leaf, o.leafDark, 0.2), mixColor(o.leaf, o.leafDark, 0.65), mixColor(o.leafDark, o.pineDark, 0.45)],
      pine: [mixColor(o.pine, o.pineDark, 0.15), mixColor(o.pine, o.pineDark, 0.6), mixColor(o.pineDark, o.ink, 0.18)],
      jungle: [mixColor(o.leaf, o.leafDark, 0.4), o.leafDark, mixColor(o.leafDark, o.pineDark, 0.8)],
      acacia: [o.leaf],
      bush: [o.leaf],
    }
    const hollow = mixColor(o.leaf, o.paper, 0.25)
    const dot = mixColor(o.leaf, o.snow, 0.5)
    for (const s of T.spots) {
      const r = rnd(s.seed)
      const t = smooth(1, 4.6, s.depth)
      const R = s.s * (0.56 + 0.56 * t) * (0.9 + 0.2 * r(100))
      const x = s.x
      const y = s.y
      // 色调：低频噪声成带，另加一点逐棵的跳动
      const nz = fnoise(s.x * 0.8 + 41, s.y * 1.5 + 577, 38 * k) + (r(101) - 0.5) * 0.22
      const tone = tones[s.kind][nz < 0.42 ? 0 : nz < 0.56 ? 1 : 2]
      const ring = r(102) < 0.1 && t > 0.15
      const pupil = !ring && t > 0.8 && r(103) < 0.22
      const shape = (pen: Pen, f: number) => {
        const q = R * f
        if (s.kind === 'pine') {
          pen.moveTo(x, y - R * 2.3 + (R - q) * 1.2)
          pen.lineTo(x + q * 0.95, y - (R - q) * 0.6)
          pen.lineTo(x - q * 0.95, y - (R - q) * 0.6)
          pen.closePath()
        } else if (s.kind === 'jungle') {
          pen.moveTo(x - q * 1.1, y - (R - q))
          pen.quadraticCurveTo(x - q * 1.1, y - R * 1.7 + (R - q), x, y - R * 1.7 + (R - q))
          pen.quadraticCurveTo(x + q * 1.1, y - R * 1.7 + (R - q), x + q * 1.1, y - (R - q))
          pen.closePath()
        } else addEllipse(pen, x, y - R, q)
      }
      out.item(s.y, (pen) => {
        if (t < 0.3 || s.front) {
          // 林缘：小形下面一根细干
          pen.strokeStyle = o.ink
          pen.lineWidth = 0.5 * k
          pen.beginPath()
          pen.moveTo(x, y - R * 0.5)
          pen.lineTo(x, y + 1.9 * k)
          pen.stroke()
        }
        pen.beginPath()
        shape(pen, 1)
        pen.fillStyle = ring ? hollow : tone
        pen.fill()
        if (ring) {
          pen.strokeStyle = o.leafDark
          pen.lineWidth = 0.7 * k
          pen.stroke()
        } else if (pupil) {
          pen.beginPath()
          addEllipse(pen, x - R * 0.2, y - R * (s.kind === 'pine' ? 0.8 : 1.15), R * 0.3)
          pen.fillStyle = dot
          pen.fill()
        }
      })
    }
  },
}

export const FOREST_STYLES: SymbolStyle[] = [cloud, scale, dab, rosette, carved, halftone]
