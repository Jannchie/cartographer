/**
 * 树的近景网格：每种树形三级（近、中、低），程序化搭出树干、枝与分团的树冠。不依赖 three.js。
 *
 * 做法取自建筑沙盘上的模型树：一根带分枝的树干，树冠是二三十个大小不一、表面起伏的团块（植绒海绵），
 * 大枝的梢头各一簇（一个大团带几个小团）。三级用同一套团块，只是细分不同（二十面体细分 2、1、0 次），轮廓一致。
 * - 团块：细分二十面体按三维噪声起伏；整团埋在别的团块里的三角形剔掉
 * - 法线：团块自身的法线向"自冠心向外"的方向靠拢，整棵树冠的明暗是一个体积而不是一堆小球
 * - 遮蔽：每个顶点向外打一组射线，被别的团块挡住的比例烘进顶点（团块之间的缝、冠底、内侧压暗）
 * 每顶点 8 字节：颜色 RGB 与是否自带颜色（树皮、叶鞘、果穗用顶点色，叶簇用实例的叶色）| 遮蔽、变化量、部位、梢度
 *（见 KIND 与 treeShader.ts）。
 * 尺寸以冠径为 1，外形与 treeSpecies.ts 的远景轮廓一致。
 */
import { SP, SPECIES } from './treeSpecies'

type V3 = [number, number, number]
type RGB = [number, number, number]

/** 部位（顶点字节）：树皮、条形叶（芦苇）、羽状叶（椰枣，片元里镂出小叶）、叶簇 */
export const KIND = { bark: 0, blade: 64, frond: 128, leaf: 255 } as const

/** 细节级：0 近、1 中、2 低 */
export type TreeLod = 0 | 1 | 2

export interface TreeMeshData {
  pos: Float32Array
  nrm: Int8Array
  /** 每顶点 8 字节，见文件头 */
  aux: Uint8Array
  idx: Uint16Array | Uint32Array
}

// —— 随机数与噪声 ——
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ihash = (x: number, y: number, z: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const fade = (t: number) => t * t * (3 - 2 * t)
/** 三维值噪声（0 ~ 1） */
function noise3(x: number, y: number, z: number) {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const k = Math.floor(z)
  const u = fade(x - i)
  const v = fade(y - j)
  const w = fade(z - k)
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  return l(
    l(l(ihash(i, j, k), ihash(i + 1, j, k), u), l(ihash(i, j + 1, k), ihash(i + 1, j + 1, k), u), v),
    l(l(ihash(i, j, k + 1), ihash(i + 1, j, k + 1), u), l(ihash(i, j + 1, k + 1), ihash(i + 1, j + 1, k + 1), u), v),
    w,
  )
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (a: number, b: number, x: number) => fade(clamp01((x - a) / (b - a)))
const hexRGB = (s: string): RGB => {
  const n = parseInt(s.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const WHITE: RGB = [255, 255, 255]

// —— 细分二十面体（单位球） ——
const ICO: { v: V3[]; f: number[] }[] = []
function icosphere(level: number) {
  if (ICO[level]) return ICO[level]
  const t = (1 + Math.sqrt(5)) / 2
  let v: V3[] = (
    [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ] as V3[]
  ).map(norm)
  let f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1]
  for (let l = 0; l < level; l++) {
    const mid = new Map<number, number>()
    const nv = v.slice()
    const nf: number[] = []
    const m = (a: number, b: number) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a
      let i = mid.get(key)
      if (i === undefined) {
        i = nv.length
        nv.push(norm(add(v[a], v[b])))
        mid.set(key, i)
      }
      return i
    }
    for (let i = 0; i < f.length; i += 3) {
      const a = f[i]
      const b = f[i + 1]
      const c = f[i + 2]
      const ab = m(a, b)
      const bc = m(b, c)
      const ca = m(c, a)
      nf.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca)
    }
    v = nv
    f = nf
  }
  return (ICO[level] = { v, f })
}

/** 半球上的一组方向（余弦分布），遮蔽射线用 */
const HEMI: V3[] = (() => {
  const out: V3[] = []
  const n = 12
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n
    const r = Math.sqrt(u)
    const a = i * 2.399963
    out.push([r * Math.cos(a), Math.sqrt(1 - u), r * Math.sin(a)])
  }
  return out
})()

/** 一组要在收尾时求平滑法线的顶点：团块（另算遮蔽与梢度、参与互相遮挡与剔除）或针叶的一层枝 */
interface Group {
  lump: boolean
  c: V3
  r: V3
  /** 法线靠拢的"向外"以它为中心（团块是冠心，针叶的一层枝是它下方轴上的一点） */
  o: V3
  v0: number
  v1: number
  i0: number
  i1: number
  /** 法线向"自中心向外"靠拢的比例、向正上方靠拢的量 */
  round: number
  up: number
}

interface LumpOpt {
  amp?: number
  /** 各细节级的细分次数的偏移（缺省 0：近 2、中 1、低 0） */
  level?: number
  round?: number
  up?: number
  tone?: number
  /** 下半截向内收（垂柳的枝条：上圆下尖） */
  taper?: number
  col?: RGB
  /** 卫星小团（低模一级不细分） */
  minor?: boolean
  /** 法线靠拢用的冠心（缺省为整棵树的） */
  origin?: V3
}

class Builder {
  P: number[] = []
  N: number[] = []
  /** 每顶点 8 个数：r, g, b, 自带颜色（叶簇不用实例的叶色：叶鞘、果穗）, 遮蔽, 变化量, 部位, 梢度（0 ~ 255） */
  A: number[] = []
  I: number[] = []
  groups: Group[] = []
  /** 结构用的随机数：各细节级的调用次序必须相同（团块的位置、大小才一致） */
  rnd: () => number
  /** 冠心：团块的法线向"自它向外"靠拢 */
  centre: V3 = [0, 1, 0]
  constructor(
    seed: number,
    readonly lod: TreeLod,
  ) {
    this.rnd = mulberry(seed)
  }
  get nv() {
    return this.P.length / 3
  }
  r(a: number, b: number) {
    return a + (b - a) * this.rnd()
  }
  /** 按细节级取值 */
  by<T>(hi: T, mid: T, low: T): T {
    return this.lod === 0 ? hi : this.lod === 1 ? mid : low
  }
  vert(p: V3, n: V3, col: RGB, ao: number, v: number, kind: number, tip: number, own = 0) {
    this.P.push(p[0], p[1], p[2])
    this.N.push(n[0], n[1], n[2])
    this.A.push(col[0], col[1], col[2], own, Math.round(clamp01(ao) * 255), Math.round(clamp01(v) * 255), kind, Math.round(clamp01(tip) * 255))
    return this.nv - 1
  }

  /** 一团树冠：椭球按噪声起伏，amp 为起伏幅度。skip 时只消耗随机数、不出几何（低细节级省掉的小团） */
  lump(c: V3, r: V3, o: LumpOpt = {}, skip = false) {
    const off = [this.r(0, 50), this.r(0, 50), this.r(0, 50)]
    const tone = o.tone ?? this.rnd()
    if (skip) return
    // 低模一级的大团仍细分一次：不细分的二十面体在 90 ~ 260 米处看得出棱面；小团与本就降过级的（垂柳枝条、竹叶团）不加
    const level = Math.max(0, 2 - this.lod + (o.level ?? 0) + (this.lod === 2 && !o.minor && !o.level ? 1 : 0))
    const ico = icosphere(level)
    const amp = o.amp ?? 0.22
    const v0 = this.nv
    for (const d of ico.v) {
      // 两个倍频：大的定团块的不规则外形，小的是表面的疙瘩（只有近景的细分够得着）
      let s = 1 + amp * (noise3(d[0] * 1.4 + off[0], d[1] * 1.4 + off[1], d[2] * 1.4 + off[2]) * 2 - 1)
      if (level >= 2) s += amp * 0.5 * (noise3(d[0] * 3.7 + off[1], d[1] * 3.7 + off[2], d[2] * 3.7 + off[0]) * 2 - 1)
      let x = d[0] * r[0] * s
      const y = d[1] * r[1] * s
      let z = d[2] * r[2] * s
      if (o.taper) {
        const k = 1 - o.taper * smooth(0.3, -1, d[1])
        x *= k
        z *= k
      }
      this.vert([c[0] + x, c[1] + y, c[2] + z], d, o.col ?? WHITE, 1, tone, KIND.leaf, 1, o.col ? 255 : 0)
    }
    const i0 = this.I.length
    for (const i of ico.f) this.I.push(v0 + i)
    this.groups.push({ lump: true, c, r, o: o.origin ?? this.centre, v0, v1: this.nv, i0, i1: this.I.length, round: o.round ?? 0.4, up: o.up ?? 0 })
  }

  /**
   * 一簇：梢头的一个大团带 sat 个小团（朝外、略朝上散开）。centre 为冠心，flat 为团块的扁度。
   * 低细节级省掉一半小团
   */
  cluster(c: V3, r: number, sat: number, o: LumpOpt & { flat?: number } = {}) {
    const flat = o.flat ?? 0.85
    this.lump(c, [r, r * flat, r], o)
    const out = norm(sub(c, o.origin ?? this.centre))
    for (let k = 0; k < sat; k++) {
      const a = this.r(0, 6.28)
      const e = this.r(-0.5, 0.9)
      const d = norm([Math.cos(a) * Math.cos(e) + out[0] * 0.8, Math.sin(e) * flat + out[1] * 0.8 + 0.1, Math.sin(a) * Math.cos(e) + out[2] * 0.8])
      const rr = r * this.r(0.48, 0.7)
      this.lump(add(c, d, r * this.r(0.6, 0.85)), [rr, rr * flat, rr], { ...o, amp: (o.amp ?? 0.22) * 1.15, minor: true }, this.lod === 2 && k % 2 === 1)
    }
  }

  /**
   * 沿折线的管（树干、枝）：各点的半径 radii，sides 边。flare：根部外扩并带几道板根。
   * ao：按沿程比例（0 根 ~ 1 梢）与位置给遮蔽
   */
  tube(path: V3[], radii: number[], sides: number, col: RGB, o: { flare?: number; ao?: (t: number, p: V3) => number; cap?: boolean; kind?: number; phase?: number } = {}) {
    const n = path.length
    let nrm: V3 = [1, 0, 0]
    const t0 = norm(sub(path[1], path[0]))
    if (Math.abs(t0[0]) > 0.9) nrm = [0, 0, 1]
    const phase = o.phase ?? 0
    const base = this.nv
    const kind = o.kind ?? KIND.bark
    for (let k = 0; k < n; k++) {
      const tg = norm(sub(path[Math.min(n - 1, k + 1)], path[Math.max(0, k - 1)]))
      nrm = norm(add(nrm, tg, -dot(nrm, tg)))
      const bn = cross(tg, nrm)
      const t = k / (n - 1)
      const ao = o.ao ? o.ao(t, path[k]) : 1
      for (let j = 0; j < sides; j++) {
        const a = (j / sides) * Math.PI * 2
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        let rr = radii[k]
        if (o.flare && k === 0) rr *= 1 + o.flare * (0.75 + 0.35 * Math.sin(a * 3 + phase))
        const d: V3 = [nrm[0] * ca + bn[0] * sa, nrm[1] * ca + bn[1] * sa, nrm[2] * ca + bn[2] * sa]
        this.vert(add(path[k], d, rr), d, col, ao, t, kind, 0)
      }
    }
    for (let k = 0; k < n - 1; k++)
      for (let j = 0; j < sides; j++) {
        const a = base + k * sides + j
        const b = base + k * sides + ((j + 1) % sides)
        this.I.push(a, b, a + sides, b, b + sides, a + sides)
      }
    if (o.cap) {
      const dir = norm(sub(path[n - 1], path[n - 2]))
      const tip = this.vert(add(path[n - 1], dir, radii[n - 1] * 0.6), dir, col, o.ao ? o.ao(1, path[n - 1]) : 1, 1, kind, 0)
      const ring = base + (n - 1) * sides
      for (let j = 0; j < sides; j++) this.I.push(ring + j, ring + ((j + 1) % sides), tip)
    }
  }

  /** Catmull-Rom 加密折线（近景的树干弯得圆顺） */
  curve(path: V3[], radii: number[], per: number): { path: V3[]; radii: number[] } {
    if (per <= 1) return { path, radii }
    const out: V3[] = []
    const rr: number[] = []
    const g = (i: number) => path[Math.min(path.length - 1, Math.max(0, i))]
    for (let i = 0; i < path.length - 1; i++)
      for (let s = 0; s < per; s++) {
        const t = s / per
        const p0 = g(i - 1)
        const p1 = g(i)
        const p2 = g(i + 1)
        const p3 = g(i + 2)
        const q = [0, 1, 2].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t)) as V3
        out.push(q)
        rr.push(radii[i] + (radii[i + 1] - radii[i]) * t)
      }
    out.push(path[path.length - 1])
    rr.push(radii[radii.length - 1])
    return { path: out, radii: rr }
  }

  /** 树干：自地下 0.35 起，近景加密、带板根；canopyY 以上在冠里，压暗 */
  trunk(path: V3[], radii: number[], col: RGB, canopyY: number) {
    const phase = this.r(0, 6.28)
    const c = this.curve(path, radii, this.by(4, 2, 1))
    this.tube(c.path, c.radii, this.by(10, 6, 4), col, {
      flare: this.by(0.6, 0.45, 0.3),
      phase,
      // 贴地一圈与冠下压暗
      ao: (_t, p) => (0.6 + 0.4 * smooth(0, 0.25, p[1])) * (1 - 0.45 * smooth(canopyY * 0.6, canopyY, p[1])),
    })
  }

  /** 枝：从 a 到 b，中段略向上拱。低细节级省掉细枝（skip） */
  branch(a: V3, b: V3, r0: number, r1: number, col: RGB, ao = 0.55, skip = false) {
    if (skip) return
    const m = lerp3(a, b, 0.5)
    m[1] += Math.hypot(b[0] - a[0], b[2] - a[2]) * 0.12
    const c = this.curve([a, m, b], [r0, (r0 + r1) / 2, r1], this.by(3, 2, 1))
    this.tube(c.path, c.radii, this.by(6, 4, 3), col, { ao: (t) => ao * (1 - 0.3 * t) })
  }

  /**
   * 针叶树的一层枝：自上沿（半径 r0、高 y1）斜披到下沿（半径 r1、高 y0），下沿是一圈枝梢（lobes 个），底面向内收到树干。
   * 每个枝梢 per 段
   */
  skirt(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, lobes: number, per: number, tone: number, seed: number) {
    const rnd = mulberry(seed)
    const segs = lobes * per
    const phase = rnd() * 6.28
    const jit = Array.from({ length: lobes }, () => 0.8 + 0.28 * rnd())
    const droop = Array.from({ length: lobes }, () => -0.06 + 0.12 * rnd())
    const v0 = this.nv
    const h = y1 - y0
    // 四个环：上沿、披面中段、枝梢、底面内圈
    const rings = [
      { r: r0, y: y1, ao: 0.5, tip: 0.1 },
      { r: r0 + (r1 - r0) * 0.62, y: y1 - h * 0.5, ao: 0.82, tip: 0.6 },
      { r: r1, y: y0, ao: 1, tip: 1 },
      { r: r1 * 0.3, y: y0 + h * 0.22, ao: 0.3, tip: 0 },
    ]
    rings.forEach((g, gi) => {
      for (let j = 0; j < segs; j++) {
        const a = (j / segs) * Math.PI * 2 + phase
        const li = Math.floor(j / per)
        const u = (j % per) / per
        // 枝梢处外伸，梢与梢之间内凹
        const lobe = per > 1 ? 0.5 - 0.5 * Math.cos(u * Math.PI * 2) : 0
        const k = gi === 2 ? (0.7 + 0.3 * (1 - lobe)) * jit[li] : gi === 1 ? 0.9 + 0.1 * (1 - lobe) * jit[li] : 1
        const yy = g.y + (gi === 2 ? droop[li] * h - lobe * h * 0.14 : 0)
        const rr = g.r * k
        this.vert([cx + Math.cos(a) * rr, yy, cz + Math.sin(a) * rr], [0, 1, 0], WHITE, g.ao, tone, KIND.leaf, g.tip)
      }
    })
    const i0 = this.I.length
    for (let gi = 0; gi < 3; gi++)
      for (let j = 0; j < segs; j++) {
        const a = v0 + gi * segs + j
        const b = v0 + gi * segs + ((j + 1) % segs)
        this.I.push(a, b, a + segs, b, b + segs, a + segs)
      }
    this.groups.push({ lump: false, c: [cx, y0, cz], r: [r1, h, r1], o: [cx, y0 - r1 * 0.5, cz], v0, v1: this.nv, i0, i1: this.I.length, round: 0.5, up: 0 })
  }

  /**
   * 一片长叶（椰枣的羽状叶、芦苇的条形叶）：沿抛物线下垂的带子，材质两面都画。
   * kind 为 frond 时截面是 V 形（中肋两侧各一片），片元里按 (沿程, 横向) 镂出小叶
   */
  blade(s: V3, dir: V3, len: number, wid: number, droop: number, segs: number, kind: number, ao0: number, ao1: number) {
    const side = norm(cross(dir, [0, 1, 0]))
    const pts: V3[] = []
    for (let k = 0; k <= segs; k++) {
      const t = k / segs
      pts.push([s[0] + dir[0] * len * t, s[1] + dir[1] * len * t - droop * len * t * t, s[2] + dir[2] * len * t])
    }
    const v = kind === KIND.frond ? 0.34 : 0
    const base = this.nv
    for (let k = 0; k <= segs; k++) {
      const t = k / segs
      const tg = norm(sub(pts[Math.min(segs, k + 1)], pts[Math.max(0, k - 1)]))
      const up = norm(cross(side, tg))
      const w = wid * Math.pow(Math.sin(Math.PI * (0.06 + 0.9 * t)), 0.55)
      const ao = ao0 + (ao1 - ao0) * t
      // 左缘、中肋、右缘
      this.vert(add(add(pts[k], side, -w), up, -w * v), up, WHITE, ao, t, kind, 1)
      this.vert(pts[k], up, WHITE, ao, t, kind, 0)
      this.vert(add(add(pts[k], side, w), up, -w * v), up, WHITE, ao, t, kind, 1)
    }
    for (let k = 0; k < segs; k++)
      for (let j = 0; j < 2; j++) {
        const a = base + k * 3 + j
        const b = a + 3
        this.I.push(a, a + 1, b, a + 1, b + 1, b)
      }
  }

  /**
   * 收尾：各组的平滑法线（由三角形求，再向外、向上靠拢）；团块的遮蔽与梢度；剔掉埋在别的团块里的三角形
   */
  finish(): TreeMeshData {
    const { P, N, A, I, groups } = this
    const lumps = groups.filter((g) => g.lump)
    const reach = lumps.map((g) => Math.max(g.r[0], g.r[1], g.r[2]) * 1.3)
    for (const L of groups) {
      for (let v = L.v0; v < L.v1; v++) N[v * 3] = N[v * 3 + 1] = N[v * 3 + 2] = 0
      for (let i = L.i0; i < L.i1; i += 3) {
        const a = I[i]
        const b = I[i + 1]
        const c = I[i + 2]
        const pa: V3 = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]]
        const n = cross(sub([P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], pa), sub([P[c * 3], P[c * 3 + 1], P[c * 3 + 2]], pa))
        for (const v of [a, b, c]) {
          N[v * 3] += n[0]
          N[v * 3 + 1] += n[1]
          N[v * 3 + 2] += n[2]
        }
      }
      for (let v = L.v0; v < L.v1; v++) {
        const p: V3 = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]
        const n = norm([N[v * 3], N[v * 3 + 1], N[v * 3 + 2]])
        const out = norm(sub(p, L.o))
        const m = norm([n[0] + (out[0] - n[0]) * L.round, n[1] + (out[1] - n[1]) * L.round + L.up, n[2] + (out[2] - n[2]) * L.round])
        N[v * 3] = m[0]
        N[v * 3 + 1] = m[1]
        N[v * 3 + 2] = m[2]
        if (!L.lump) continue
        // 遮蔽：沿法线半球打射线，数被别的团块挡住的（略缩小，免得相贴的团块互相全挡）；朝下的射线按离地高度算半挡
        const t1 = norm(Math.abs(n[1]) < 0.9 ? cross(n, [0, 1, 0]) : cross(n, [1, 0, 0]))
        const t2 = cross(n, t1)
        let occ = 0
        for (const h of HEMI) {
          const d: V3 = [t1[0] * h[0] + n[0] * h[1] + t2[0] * h[2], t1[1] * h[0] + n[1] * h[1] + t2[1] * h[2], t1[2] * h[0] + n[2] * h[1] + t2[2] * h[2]]
          let hit = 0
          for (let mi = 0; mi < lumps.length; mi++) {
            const M = lumps[mi]
            if (M === L) continue
            const cx = M.c[0] - p[0]
            const cy = M.c[1] - p[1]
            const cz = M.c[2] - p[2]
            // 团块在射线背后或离射线太远
            const along = cx * d[0] + cy * d[1] + cz * d[2]
            if (along < -reach[mi] || cx * cx + cy * cy + cz * cz - along * along > reach[mi] * reach[mi]) continue
            const ox = -cx / (M.r[0] * 0.9)
            const oy = -cy / (M.r[1] * 0.9)
            const oz = -cz / (M.r[2] * 0.9)
            const dx = d[0] / (M.r[0] * 0.9)
            const dy = d[1] / (M.r[1] * 0.9)
            const dz = d[2] / (M.r[2] * 0.9)
            const qa = dx * dx + dy * dy + dz * dz
            const qb = ox * dx + oy * dy + oz * dz
            const qc = ox * ox + oy * oy + oz * oz - 1
            if (qc < 0 || (qb < 0 && qb * qb - qa * qc > 0)) {
              hit = 1
              break
            }
          }
          if (!hit && d[1] < -0.15) hit = 0.5 * (1 - smooth(0.6, 2.2, p[1] / Math.max(0.05, -d[1])))
          occ += hit
        }
        occ /= HEMI.length
        A[v * 8 + 4] = Math.round(255 * clamp01(1 - 0.9 * occ))
        // 梢度：没被挡住的是树冠的外层
        A[v * 8 + 7] = Math.round(255 * clamp01(1 - 1.25 * occ))
      }
    }
    // 剔掉整个埋在别的团块里的三角形
    const keep: number[] = []
    const inside = (v: number, M: Group) => {
      const x = (P[v * 3] - M.c[0]) / M.r[0]
      const y = (P[v * 3 + 1] - M.c[1]) / M.r[1]
      const z = (P[v * 3 + 2] - M.c[2]) / M.r[2]
      return x * x + y * y + z * z < 0.3
    }
    let gi = 0
    for (let i = 0; i < I.length; i += 3) {
      while (gi < groups.length && i >= groups[gi].i1) gi++
      const L = gi < groups.length && i >= groups[gi].i0 && groups[gi].lump ? groups[gi] : null
      let hidden = false
      if (L) for (const M of lumps) if (M !== L && inside(I[i], M) && inside(I[i + 1], M) && inside(I[i + 2], M)) hidden = true
      if (!hidden) keep.push(I[i], I[i + 1], I[i + 2])
    }
    // 压紧：去掉不再被引用的顶点
    const map = new Int32Array(this.nv).fill(-1)
    let n = 0
    for (const v of keep) if (map[v] < 0) map[v] = n++
    const pos = new Float32Array(n * 3)
    const nrm = new Int8Array(n * 3)
    const aux = new Uint8Array(n * 8)
    for (let v = 0; v < map.length; v++) {
      const k = map[v]
      if (k < 0) continue
      const nn = norm([N[v * 3], N[v * 3 + 1], N[v * 3 + 2]])
      for (let c = 0; c < 3; c++) {
        pos[k * 3 + c] = P[v * 3 + c]
        nrm[k * 3 + c] = Math.round(nn[c] * 127)
      }
      for (let c = 0; c < 8; c++) aux[k * 8 + c] = A[v * 8 + c]
    }
    const idx = n > 65535 ? new Uint32Array(keep.length) : new Uint16Array(keep.length)
    for (let i = 0; i < keep.length; i++) idx[i] = map[keep[i]]
    return { pos, nrm, aux, idx }
  }
}

const polar = (r: number, a: number, y: number): V3 => [Math.cos(a) * r, y, Math.sin(a) * r]

// —— 各树形 ——
type Make = (b: Builder, bark: RGB) => void

/** 橡、椴、槐：粗干，四五根大枝各托一簇，冠顶再两簇 */
const oak: Make = (b, bark) => {
  b.trunk([[0, -0.35, 0], [0.025, 0.3, 0.01], [-0.02, 0.7, 0.02], [0.02, 1.1, 0]], [0.15, 0.125, 0.11, 0.07], bark, 0.95)
  b.centre = [0, 1.4, 0]
  const a0 = b.r(0, 6.28)
  const n = 5
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + b.r(-0.28, 0.28)
    const d = b.r(0.5, 0.7)
    const y = b.r(1.08, 1.45)
    const c = polar(d, a, y)
    b.cluster(c, b.r(0.36, 0.46), 3)
    b.branch([0, 0.66 + i * 0.04, 0], polar(d * 0.8, a, y - 0.1), 0.075, 0.03, bark, 0.55, b.lod === 2 && i % 2 === 1)
  }
  b.cluster([b.r(-0.1, 0.1), 1.92, b.r(-0.1, 0.1)], 0.46, 3)
  b.cluster(polar(0.3, a0 + 1.1, 1.66), 0.42, 2)
  b.cluster(polar(0.34, a0 + 4.0, 1.6), 0.4, 2)
}

/** 杨、榆、银杏：直干，树冠是沿主干叠上去的几层 */
const poplar: Make = (b, bark) => {
  b.trunk([[0, -0.35, 0], [0.01, 0.5, 0], [0, 1.3, 0.01], [0, 2.4, 0]], [0.11, 0.09, 0.07, 0.03], bark, 0.9)
  b.centre = [0, 1.9, 0]
  const ys = [1.02, 1.5, 2.0, 2.48, 2.92]
  const rs = [0.34, 0.4, 0.4, 0.34, 0.25]
  const a0 = b.r(0, 6.28)
  ys.forEach((y, i) => {
    const last = i === ys.length - 1
    const a = a0 + i * 2.2
    b.cluster(polar(last ? 0.03 : 0.2, a, y), rs[i], last ? 1 : 2, { flat: last ? 1.5 : 1.05, round: 0.3 })
    if (!last) b.cluster(polar(0.22, a + 2.8, y + 0.2), rs[i] * 0.9, 1, { flat: 1.05, round: 0.3 })
    if (i < 3) b.branch([0, y - 0.25, 0], polar(0.22, a, y), 0.045, 0.02, bark, 0.5, b.lod === 2)
  })
}

/** 柏、紫杉：贴地起冠的纺锤，一圈竖长的团块拧着中轴 */
const cypress: Make = (b, bark) => {
  b.trunk([[0, -0.35, 0], [0, 0.2, 0], [0, 0.7, 0]], [0.085, 0.07, 0.045], bark, 0.3)
  b.centre = [0, 1.7, 0]
  const o: LumpOpt = { amp: 0.16, round: 0.25 }
  b.lump([0, 1.5, 0], [0.33, 1.25, 0.33], o)
  b.lump([0, 3.0, 0], [0.2, 0.98, 0.2], o)
  const a0 = b.r(0, 6.28)
  const n = 9
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const a = a0 + i * 2.399963
    const y = 0.72 + t * 2.3
    // 中段最粗
    const w = 0.24 * Math.sin(Math.PI * (0.18 + 0.72 * t))
    b.lump(polar(0.1 + w * 0.75, a, y), [0.14 + w * 0.5, b.r(0.42, 0.6), 0.14 + w * 0.5], { amp: 0.2, round: 0.25 }, b.lod === 2 && i % 2 === 1)
  }
}

/** 云杉、冷杉、柳杉：直干，自下而上一层层收窄的枝 */
const spruce: Make = (b, bark) => {
  b.trunk([[0, -0.35, 0], [0, 0.6, 0], [0, 2.4, 0], [0, 4.0, 0]], [0.095, 0.08, 0.05, 0.012], bark, 0.5)
  const tiers = b.by(8, 6, 4)
  const y0 = 0.42
  const top = 4.02
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers
    const t1 = (i + 1) / tiers
    const lo = y0 + (top - y0) * Math.pow(t, 0.9)
    const hi = y0 + (top - y0) * Math.pow(t1, 0.9)
    const r1 = 0.8 * Math.pow(1 - t, 0.85) + 0.05
    // 上沿伸进上一层里面
    b.skirt(0, 0, lo, hi + (hi - lo) * 0.45, 0.05 + 0.1 * (1 - t1), r1, b.by(9, 7, 5), b.by(4, 2, 2), ihash(i, 3, 9), 100 + i)
  }
  // 顶梢
  b.tube([[0, 3.85, 0], [0, 4.15, 0]], [0.05, 0.004], b.by(5, 4, 3), WHITE, { kind: KIND.leaf, ao: () => 1 })
}

/** 松：弯干，几片平展的层云状树冠 */
const pine: Make = (b, bark) => {
  const path: V3[] = [[0, -0.35, 0], [0.07, 0.5, 0.02], [-0.06, 1.1, 0.06], [0.08, 1.7, -0.02], [0.02, 2.3, 0.02]]
  b.trunk(path, [0.125, 0.105, 0.09, 0.07, 0.03], bark, 1.7)
  b.centre = [0, 1.7, 0]
  const o = { flat: 0.42, round: 0.15, up: 0.5, amp: 0.26 }
  b.cluster([0.03, 2.42, 0.02], 0.44, 4, { ...o, origin: [0, 2.3, 0] })
  const a0 = b.r(0, 6.28)
  for (let i = 0; i < 4; i++) {
    const a = a0 + i * 1.75 + b.r(-0.2, 0.2)
    const d = b.r(0.52, 0.7)
    const c = polar(d, a, 1.68 + i * 0.17 + b.r(-0.05, 0.05))
    b.cluster(c, b.r(0.3, 0.36), 3, o)
    b.branch(lerp3(path[2], path[3], (i + 1) / 4), add(c, [0, -0.06, 0]), 0.05, 0.022, bark, 0.65, b.lod === 2 && i % 2 === 1)
  }
}

/** 垂柳：矮粗的干，圆顶，四周垂下两圈长短不一的枝条 */
const willow: Make = (b, bark) => {
  b.trunk([[0, -0.35, 0], [0.03, 0.35, 0.02], [-0.02, 0.8, 0], [0.02, 1.25, 0.02]], [0.19, 0.15, 0.13, 0.08], bark, 1.0)
  b.centre = [0, 1.3, 0]
  b.cluster([0, 1.8, 0], 0.52, 3)
  const a0 = b.r(0, 6.28)
  for (let i = 0; i < 4; i++) {
    const a = a0 + i * 1.6 + b.r(-0.2, 0.2)
    b.cluster(polar(0.5, a, 1.55), 0.4, 2)
    b.branch([0, 0.95 + i * 0.05, 0], polar(0.45, a, 1.5), 0.07, 0.03, bark, 0.55, b.lod === 2 && i % 2 === 1)
  }
  // 枝条：竖长、下端收尖；外圈垂得低，内圈短
  const n = 26
  for (let i = 0; i < n; i++) {
    const outer = i % 2 === 0
    const a = a0 + (i / n) * Math.PI * 2 + b.r(-0.14, 0.14)
    const d = outer ? b.r(0.84, 0.98) : b.r(0.52, 0.7)
    const len = outer ? b.r(0.5, 0.74) : b.r(0.36, 0.5)
    const top = outer ? 1.52 : 1.3
    const w = b.r(0.12, 0.18)
    b.lump(polar(d, a, top - len * 0.8), [w, len, w * 0.85], { amp: 0.22, round: 0.3, taper: 0.75, level: -1 }, b.lod === 2 && !outer)
  }
}

/** 椰枣：细高微弯的干，顶上一蓬下垂的羽状叶，叶下挂着果穗 */
const palm: Make = (b, bark) => {
  const path: V3[] = [[0, -0.35, 0], [0.04, 0.9, 0], [0.1, 2.0, 0.02], [0.14, 3.02, 0.04]]
  const c = b.curve(path, [0.105, 0.088, 0.08, 0.085], b.by(4, 2, 1))
  b.tube(c.path, c.radii, b.by(9, 6, 4), bark, { flare: 0.35, ao: (t, p) => (0.6 + 0.4 * smooth(0, 0.3, p[1])) * (1 - 0.3 * smooth(0.8, 1, t)) })
  const top: V3 = [0.14, 3.02, 0.04]
  b.centre = top
  // 叶鞘：干顶的一团（枯叶柄）
  b.lump(add(top, [0, 0.06, 0]), [0.15, 0.2, 0.15], { amp: 0.15, level: -1, col: [140, 120, 92], tone: 0.3 })
  const n = b.by(19, 13, 9)
  const a0 = b.r(0, 6.28)
  const rnd = mulberry(4421)
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    // 自下而上：老叶下垂，新叶上举
    const el = -0.4 + 1.4 * Math.pow(t, 0.8) + (rnd() - 0.5) * 0.16
    const a = a0 + i * 2.399963
    const dir = norm([Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)])
    const len = (1.15 + 0.25 * rnd()) * (1 - 0.25 * Math.max(0, t - 0.6))
    b.blade(add(top, [0, 0.1, 0]), dir, len, 0.2, 0.55 - 0.25 * t, b.by(8, 4, 2), KIND.frond, 0.45, 0.75 + 0.25 * t)
  }
  for (let i = 0; i < 3; i++) b.lump(add(top, polar(0.2, a0 + i * 2.1, -0.16)), [0.09, 0.15, 0.09], { amp: 0.1, level: -1, col: [196, 132, 62], tone: 0.5 }, b.lod === 2)
}

/** 果树：矮干三叉，圆冠 */
const fruit: Make = (b, bark) => {
  b.trunk([[0, -0.35, 0], [0.02, 0.25, 0], [-0.01, 0.58, 0.01]], [0.105, 0.085, 0.065], bark, 0.55)
  b.centre = [0, 0.9, 0]
  b.cluster([b.r(-0.05, 0.05), 1.14, b.r(-0.05, 0.05)], 0.4, 3)
  const a0 = b.r(0, 6.28)
  for (let i = 0; i < 4; i++) {
    const a = a0 + (i / 4) * Math.PI * 2 + b.r(-0.25, 0.25)
    const d = b.r(0.42, 0.54)
    const y = b.r(0.8, 0.98)
    b.cluster(polar(d, a, y), b.r(0.32, 0.38), 2)
    b.branch([0, 0.46, 0], polar(d * 0.75, a, y - 0.08), 0.05, 0.024, bark, 0.55, b.lod === 2 && i % 2 === 1)
  }
}

/** 樱、枫、梅：低分枝，几根长枝斜伸出去，枝头是一层层扁平的冠 */
const ornamental: Make = (b, bark) => {
  b.trunk([[0, -0.35, 0], [0.03, 0.25, 0.01], [-0.02, 0.52, 0]], [0.11, 0.09, 0.075], bark, 0.6)
  b.centre = [0, 1.05, 0]
  const o = { flat: 0.6, round: 0.25, up: 0.25, amp: 0.26 }
  const a0 = b.r(0, 6.28)
  const n = 5
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + b.r(-0.28, 0.28)
    const d = b.r(0.56, 0.78)
    const y = b.r(1.0, 1.3)
    const c = polar(d, a, y)
    b.cluster(c, b.r(0.3, 0.38), 3, o)
    b.branch([0, 0.44, 0], add(c, [0, -0.08, 0]), 0.055, 0.022, bark, 0.6, b.lod === 2 && i % 2 === 1)
  }
  b.cluster([b.r(-0.1, 0.1), 1.6, b.r(-0.1, 0.1)], 0.4, 3, o)
  b.cluster(polar(0.28, a0 + 1.0, 1.4), 0.34, 2, o)
}

/** 竹丛：一丛细秆向外散开，上半截一路挂着小叶团，秆梢弯垂 */
const bamboo: Make = (b) => {
  b.centre = [0, 2.4, 0]
  const n = 13
  const a0 = b.r(0, 6.28)
  const culm: RGB = [150, 168, 96]
  for (let i = 0; i < n; i++) {
    const a = a0 + i * 2.399963
    const d = 0.05 + 0.3 * Math.sqrt((i + 0.5) / n)
    const h = b.r(2.9, 4.0)
    const lean = b.r(0.08, 0.2)
    const skip = b.lod === 2 && i % 2 === 1
    const base = polar(d, a, -0.3)
    const mid = polar(d + lean * h * 0.4, a, h * 0.58)
    // 秆梢弯下来
    const tip = polar(d + lean * h * 1.5, a + b.r(-0.3, 0.3), h * 0.94)
    const c = b.curve([base, mid, tip], [0.032, 0.026, 0.006], b.by(4, 2, 1))
    if (!skip) b.tube(c.path, c.radii, b.by(5, 4, 3), culm, { ao: (t) => 0.6 + 0.4 * t })
    const tufts = 7
    for (let k = 0; k < tufts; k++) {
      const t = 0.36 + (0.64 * (k + 0.6)) / tufts
      const p = t < 0.58 ? lerp3(base, mid, t / 0.58) : lerp3(mid, tip, (t - 0.58) / 0.42)
      // 叶团挂在秆的一侧，越往梢越小
      const r = b.r(0.18, 0.27) * (1.15 - 0.4 * t)
      const sa = a + b.r(-1.6, 1.6)
      b.lump(add(p, [Math.cos(sa) * r * 0.7, b.r(-0.08, 0.02), Math.sin(sa) * r * 0.7]), [r * 1.25, r * 0.6, r * 1.25], { amp: 0.32, round: 0.15, up: 0.3, level: -1 }, skip || (b.lod === 2 && k % 2 === 1))
    }
  }
}

/** 灌木：贴地的几簇 */
const shrub: Make = (b) => {
  b.centre = [0, 0.15, 0]
  const a0 = b.r(0, 6.28)
  b.cluster([0, 0.5, 0], 0.5, 3, { amp: 0.26 })
  for (let i = 0; i < 3; i++) {
    const a = a0 + i * 2.1 + b.r(-0.3, 0.3)
    const r = b.r(0.36, 0.46)
    b.cluster(polar(0.46, a, r * 0.7), r, 2, { amp: 0.28 })
  }
}

/** 芦苇丛：一丛向外散开的长叶，几枝带穗 */
const reed: Make = (b) => {
  const n = 18
  const a0 = b.r(0, 6.28)
  for (let i = 0; i < n; i++) {
    const a = a0 + i * 2.399963
    const el = b.r(0.95, 1.42)
    const dir = norm([Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)])
    const s = polar(0.05 + 0.25 * Math.sqrt((i + 0.5) / n), a, -0.1)
    const len = b.r(1.3, 2.0)
    const droop = b.r(0.05, 0.22)
    if (b.lod === 2 && i % 2 === 1) continue
    b.blade(s, dir, len, 0.05, droop, b.by(4, 3, 2), KIND.blade, 0.5, 1)
    // 穗
    if (b.lod === 0 && i % 4 === 0) b.tube([add(s, dir, len * 0.86), add(s, dir, len * 1.0)], [0.035, 0.012], 4, [176, 150, 112], { cap: true })
  }
}

/** 绿篱段：沿 x 方向一段修剪过的矮篱（半长 1），顶面略圆，表面有起伏 */
const hedge: Make = (b) => {
  b.centre = [0, 0.2, 0]
  const n = 3
  for (let i = 0; i < n; i++) {
    const x = -1 + ((i + 0.5) / n) * 2
    b.lump([x, 0.46, 0], [1.25 / n + 0.12, 0.54, 0.42], { amp: 0.1, round: 0, up: 0.1 })
  }
}

/** 藤架段：两根木桩，之间一道藤叶 */
const vine: Make = (b, bark) => {
  for (const x of [-0.98, 0.98]) b.tube([[x, -0.2, 0], [x, 1.02, 0]], [0.035, 0.03], b.by(5, 4, 3), bark, { ao: () => 0.85, cap: true })
  b.centre = [0, 0.5, 0]
  const n = 4
  for (let i = 0; i < n; i++) {
    const x = -1 + ((i + 0.5) / n) * 2 + b.r(-0.06, 0.06)
    b.lump([x, b.r(0.62, 0.78), b.r(-0.04, 0.04)], [2.3 / n / 2 + 0.1, b.r(0.3, 0.4), b.r(0.24, 0.32)], { amp: 0.3, round: 0, up: 0.15 })
  }
  // 藤干：桩间拉着的老藤
  if (b.lod < 2) b.tube([[-0.98, 0.5, 0], [0, 0.42, 0.02], [0.98, 0.5, 0]], [0.022, 0.03, 0.022], 3, bark, { ao: () => 0.65 })
}

const MAKERS: Make[] = []
MAKERS[SP.oak] = oak
MAKERS[SP.poplar] = poplar
MAKERS[SP.cypress] = cypress
MAKERS[SP.spruce] = spruce
MAKERS[SP.pine] = pine
MAKERS[SP.willow] = willow
MAKERS[SP.palm] = palm
MAKERS[SP.fruit] = fruit
MAKERS[SP.ornamental] = ornamental
MAKERS[SP.bamboo] = bamboo
MAKERS[SP.shrub] = shrub
MAKERS[SP.reed] = reed
MAKERS[SP.hedge] = hedge
MAKERS[SP.vine] = vine

const CACHE = new Map<number, TreeMeshData>()

/** 树形 species 的网格。结果有缓存（换城时不重搭） */
export function treeMesh(species: number, lod: TreeLod): TreeMeshData {
  const key = species * 3 + lod
  let m = CACHE.get(key)
  if (!m) {
    // 各级用同一个种子：团块的位置、大小一致，只是细分不同
    const b = new Builder(977 + species * 131, lod)
    MAKERS[species](b, hexRGB(SPECIES[species].bark))
    m = b.finish()
    CACHE.set(key, m)
  }
  return m
}
