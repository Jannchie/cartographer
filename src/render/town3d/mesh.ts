/**
 * 聚落沙盘的几何写入器与参数化构件（墙体、勒脚、平顶、两坡、四坡、歇山、穹顶、圆锥）。
 * 屋面是有厚度的板：屋面、底板（出檐下可见）、檐口封檐板与山面的博风边；墙面带沿墙坐标，窗与门在着色器里按墙居中排布。
 * 纯函数，不依赖 three.js 与 DOM，可在 Worker 里运行。坐标单位为米：x 向东、y 向上、z 向南（聚落平面的 y）。
 * 三角形按所在的块写进各自的缓冲（块供视锥裁剪），每个顶点带生卒与地基高度：
 * 成长回放只改着色器里的人口，不重建几何。
 */
import { unit, type P, type Poly } from '../../settlement/geom'

export type RGB = readonly [number, number, number]

/** 一块网格（可转移的类型化数组） */
export interface TownChunk {
  /** 顶点位置（米） */
  pos: Float32Array
  /** 法线（Int8 归一化） */
  nrm: Int8Array
  /** sRGB 颜色 + 材质字节（a：低 6 位为材质 MAT，WIN 位为开窗的墙面，DOOR 位为开门的墙面） */
  col: Uint8Array
  /** 每顶点的立面坐标：墙面为 (沿墙米数, 墙长, 墙顶高度)，其余为 0 */
  uv: Float32Array
  /** 每顶点 (出生人口, 消亡人口, 地基高度) */
  life: Float32Array
  /** 每个三角形所属建筑在 st.buildings 中的下标（城墙、桥、码头等为 -1） */
  ids: Int32Array
  /** 包围盒 [x0, y0, z0, x1, y1, z1]（米） */
  box: number[]
}

/** 不会消亡：Infinity 进不了顶点属性的部分驱动，用一个大数 */
export const NEVER = 1e9

/**
 * 表面材质（顶点的材质字节低 6 位）：着色器按它画墙面与屋面的纹理和凹凸。
 * 改这里要同步改 buildingShader.ts
 */
export const MAT = {
  /** 素面：只有轻微的斑驳 */
  plain: 0,
  /** 西式黏土瓦（筒板瓦一垄一垄） */
  tile: 1,
  /** 东亚筒瓦（板瓦沟与筒瓦垄顺坡而下） */
  tileEast: 2,
  /** 抹灰墙 */
  plaster: 3,
  /** 方整石砌 */
  stone: 4,
  /** 砖砌（东亚青砖、烟囱） */
  brick: 5,
  /** 西式木构架（底层石砌、楼层露明木骨架） */
  timber: 6,
  /** 和式真壁（柱、贯与白壁，下段腰板） */
  wa: 7,
  /** 平屋顶（灰泥） */
  flatRoof: 8,
  /** 石板瓦（错缝的矩形薄片） */
  slate: 9,
  /** 木板（船、码头、棚屋） */
  board: 10,
} as const
/** 材质字节里的开窗标记：墙面按层高、开间排窗，底层居中开门 */
export const WIN = 128
/** 材质字节的开门位：这面墙在底层居中的开间开门 */
export const DOOR = 64

/** 可增长的类型化数组 */
class Grow<T extends Float32Array | Int8Array | Uint8Array | Int32Array> {
  n = 0
  constructor(
    public a: T,
    private make: (n: number) => T,
  ) {}
  reserve(k: number) {
    if (this.n + k <= this.a.length) return
    const b = this.make(Math.max(this.a.length * 2, this.n + k))
    b.set(this.a)
    this.a = b
  }
  done(): T {
    return this.a.slice(0, this.n) as T
  }
}

class Buf {
  pos = new Grow(new Float32Array(3 * 3 * 256), (n) => new Float32Array(n))
  nrm = new Grow(new Int8Array(3 * 3 * 256), (n) => new Int8Array(n))
  col = new Grow(new Uint8Array(4 * 3 * 256), (n) => new Uint8Array(n))
  life = new Grow(new Float32Array(3 * 3 * 256), (n) => new Float32Array(n))
  uv = new Grow(new Float32Array(3 * 3 * 256), (n) => new Float32Array(n))
  ids = new Grow(new Int32Array(256), (n) => new Int32Array(n))
  box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
}

/**
 * 写入器：先用 at() 选块、设好颜色 c 与生卒，再写三角形。
 * 三角形逆时针（从外侧看）为正面，法线按三角形求出。
 */
export class Writer {
  private bufs: Buf[]
  private cur: Buf
  /** 当前颜色（sRGB 0~255）与材质字节（MAT，开窗的墙面再加 WIN、开门的墙面加 DOOR） */
  c: RGB = [255, 255, 255]
  face = 0
  /** 当前三角形各顶点的立面坐标（墙面：沿墙米数、墙长与墙顶高度）；不给为 0 */
  uvOf: ((p: V3) => readonly [number, number, number]) | null = null
  /** 屋顶构件用的材质：屋面、山墙面、屋面板厚（米） */
  roofFace: number = MAT.tile
  gableFace: number = MAT.plaster
  roofTh = 0.18
  born = 0
  died = NEVER
  base = 0
  id = -1

  constructor(
    private width: number,
    private height: number,
    private nx: number,
    private nz: number,
  ) {
    this.bufs = Array.from({ length: nx * nz }, () => new Buf())
    this.cur = this.bufs[0]
  }

  /** 新的一个实体：材质与屋顶样式恢复默认（免得沿用上一个实体留下的） */
  begin(born: number, died: number) {
    this.born = born
    this.died = died
    this.face = 0
    this.roofFace = MAT.tile
    this.gableFace = MAT.plaster
    this.roofTh = 0.18
  }

  /** 选定点 (x, z) 所在的块 */
  at(x: number, z: number) {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x / this.width) * this.nx)))
    const j = Math.min(this.nz - 1, Math.max(0, Math.floor((z / this.height) * this.nz)))
    this.cur = this.bufs[j * this.nx + i]
  }

  tri(a: V3, b: V3, c: V3) {
    const ux = b[0] - a[0]
    const uy = b[1] - a[1]
    const uz = b[2] - a[2]
    const vx = c[0] - a[0]
    const vy = c[1] - a[1]
    const vz = c[2] - a[2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    // 退化的三角形（收成一点的屋脊端）不写
    if (l < 1e-9) return
    nx = Math.round((nx / l) * 127)
    ny = Math.round((ny / l) * 127)
    nz = Math.round((nz / l) * 127)
    const B = this.cur
    B.pos.reserve(9)
    B.nrm.reserve(9)
    B.col.reserve(12)
    B.life.reserve(9)
    B.uv.reserve(9)
    B.ids.reserve(1)
    const box = B.box
    for (const p of [a, b, c]) {
      const k = B.pos.n
      B.pos.a[k] = p[0]
      B.pos.a[k + 1] = p[1]
      B.pos.a[k + 2] = p[2]
      B.pos.n += 3
      B.nrm.a[k] = nx
      B.nrm.a[k + 1] = ny
      B.nrm.a[k + 2] = nz
      B.nrm.n += 3
      B.life.a[k] = this.born
      B.life.a[k + 1] = this.died
      B.life.a[k + 2] = this.base
      B.life.n += 3
      const q = B.col.n
      B.col.a[q] = this.c[0]
      B.col.a[q + 1] = this.c[1]
      B.col.a[q + 2] = this.c[2]
      B.col.a[q + 3] = this.face
      B.col.n += 4
      const uv = this.uvOf ? this.uvOf(p) : ZERO2
      B.uv.a[B.uv.n] = uv[0]
      B.uv.a[B.uv.n + 1] = uv[1]
      B.uv.a[B.uv.n + 2] = uv[2]
      B.uv.n += 3
      if (p[0] < box[0]) box[0] = p[0]
      if (p[1] < box[1]) box[1] = p[1]
      if (p[2] < box[2]) box[2] = p[2]
      if (p[0] > box[3]) box[3] = p[0]
      if (p[1] > box[4]) box[4] = p[1]
      if (p[2] > box[5]) box[5] = p[2]
    }
    B.ids.a[B.ids.n++] = this.id
  }

  /** 四边形 abcd（逆时针） */
  quad(a: V3, b: V3, c: V3, d: V3) {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }

  /** 朝向 out 一侧的三角形（绕向按 out 自动决定，免得山墙这类拼出来的面被背面剔除） */
  triOut(a: V3, b: V3, c: V3, out: V3) {
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1])
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) this.tri(a, b, c)
    else this.tri(a, c, b)
  }
  /** 朝向 out 一侧的平面四边形 */
  quadOut(a: V3, b: V3, c: V3, d: V3, out: V3) {
    this.triOut(a, b, c, out)
    this.triOut(a, c, d, out)
  }

  /**
   * 屋面板的一块：上表面 abcd（当前颜色与材质），下面压低 th 的底板（颜色 under、素面，朝下）
   */
  slabQuad(a: V3, b: V3, c: V3, d: V3, th: number, under: RGB) {
    this.quadOut(a, b, c, d, UP)
    const lo = (p: V3): V3 => [p[0], p[1] - th, p[2]]
    const col = this.c
    const face = this.face
    this.c = under
    this.face = MAT.plain
    this.quadOut(lo(a), lo(b), lo(c), lo(d), DOWN)
    this.c = col
    this.face = face
  }

  /** 板的一条边：边 ab 与压低 th 后的边围成的竖条，朝向 out */
  edgeStrip(a: V3, b: V3, th: number, out: V3) {
    this.quadOut(a, b, [b[0], b[1] - th, b[2]], [a[0], a[1] - th, a[2]], out)
  }

  finish(): TownChunk[] {
    return this.bufs
      .filter((b) => b.ids.n > 0)
      .map((b) => ({ pos: b.pos.done(), nrm: b.nrm.done(), col: b.col.done(), uv: b.uv.done(), life: b.life.done(), ids: b.ids.done(), box: b.box }))
  }
}

export type V3 = [number, number, number]
const ZERO2 = [0, 0, 0] as const
const DOWN: V3 = [0, -1, 0]
const UP: V3 = [0, 1, 0]
/** 颜色按比例压暗（屋面底板、脊瓦） */
export const shade = (c: RGB, k: number): RGB => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]

/** 平面点 + 高度 → 三维点 */
export const v3 = (p: P, y: number): V3 => [p[0], y, p[1]]

/** 环的有向面积的两倍（平面 y 向南；正值时从上方看为顺时针，即三维右手系里朝上的逆时针） */
function area2(ring: P[]) {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const q = ring[(i + 1) % ring.length]
    a += ring[i][0] * q[1] - q[0] * ring[i][1]
  }
  return a
}

/** 统一成从上方看为逆时针（三维中外法线朝外、顶面朝上的绕向） */
function upward(ring: P[]): P[] {
  return area2(ring) < 0 ? ring : [...ring].reverse()
}

/**
 * 竖直外墙：环从 y0 拉到 y1（y1 可逐点给出，随地形起伏的墙顶）。
 * 当前材质带 WIN 位（可开窗的立面）时，fac 给出逐面墙（ring[k] → ring[k + 1]）开不开窗、门开在哪面：
 * 不开窗的墙去掉 WIN 位，开门的墙加 DOOR 位
 */
export function walls(w: Writer, ring: P[], y0: number, y1: number | number[], fac?: { win: boolean[]; door: number }) {
  const flip = area2(ring) >= 0
  const r = flip ? [...ring].reverse() : ring
  const tops = Array.isArray(y1) ? (flip ? [...y1].reverse() : y1) : null
  const face = w.face
  const n = r.length
  for (let i = 0; i < r.length; i++) {
    const j = (i + 1) % r.length
    // 反转后的第 i 段对应原环的第 n − 2 − i 段
    const k = flip ? (2 * n - 2 - i) % n : i
    const tp = tops ? tops[i] : (y1 as number)
    const tq = tops ? tops[j] : (y1 as number)
    // 沿墙坐标：从这面墙的起点量起（米），连同墙长与墙顶（取两端低的一端），着色器据此让窗居中排布、放不下整扇的不画
    const ax = r[i][0]
    const az = r[i][1]
    const dx = r[j][0] - ax
    const dz = r[j][1] - az
    const L = Math.hypot(dx, dz) || 1
    const uv: [number, number, number] = [0, L, Math.min(tp, tq)]
    w.uvOf = (p) => ((uv[0] = ((p[0] - ax) * dx + (p[2] - az) * dz) / L), uv)
    w.face = fac && face & WIN ? (face & ~WIN) | (fac.win[k] ? WIN : 0) | (fac.door === k ? DOOR : 0) : face
    w.quad(v3(r[i], y0), v3(r[j], y0), v3(r[j], tq), v3(r[i], tp))
  }
  w.face = face
  w.uvOf = null
}

/**
 * 勒脚：墙脚外凸 d 的一圈（y0 到 y1），顶上一道朝上的窄台。环按逐点的角平分线外扩（尖角限长）
 */
export function plinth(w: Writer, ring: P[], y0: number, y1: number, d: number) {
  const r = upward(ring)
  const out = offsetRing(r, d)
  walls(w, out, y0, y1)
  for (let i = 0; i < r.length; i++) {
    const j = (i + 1) % r.length
    w.quadOut(v3(out[i], y1), v3(out[j], y1), v3(r[j], y1), v3(r[i], y1), UP)
  }
}

/**
 * 环（upward 绕向）整体外扩 d（负数内收）：每个顶点沿两条边外法线的角平分线移动，
 * 转角处斜接（两条边的偏移线交于一点），尖角处限长免得刺出去
 */
function offsetRing(r: P[], d: number): P[] {
  const n = r.length
  return r.map((b, i) => {
    const a = r[(i - 1 + n) % n]
    const c = r[(i + 1) % n]
    // 两条边的外法线（与 walls 的墙面法线一致：(−dz, dx)）
    const n1 = unit([-(b[1] - a[1]), b[0] - a[0]])
    const n2 = unit([-(c[1] - b[1]), c[0] - b[0]])
    const m = unit([n1[0] + n2[0], n1[1] + n2[1]])
    const k = Math.min(3, 1 / Math.max(0.3, m[0] * n1[0] + m[1] * n1[1]))
    return [b[0] + m[0] * d * k, b[1] + m[1] * d * k]
  })
}

/** 凸多边形的水平面（扇形三角化），朝上 */
export function cap(w: Writer, ring: P[], y: number) {
  const r = upward(ring)
  for (let i = 1; i < r.length - 1; i++) w.tri(v3(r[0], y), v3(r[i], y), v3(r[i + 1], y))
}

/** 实心棱柱：墙 + 顶 */
export function prism(w: Writer, ring: P[], y0: number, y1: number) {
  walls(w, ring, y0, y1)
  cap(w, ring, y1)
}

/** 屋顶的局部框：中心 c，屋脊方向 u，横向 v，半长 a（沿 u）、半宽 b */
export interface Frame {
  c: P
  u: P
  v: P
  a: number
  b: number
}
export const at = (f: Frame, s: number, t: number): P => [f.c[0] + f.u[0] * s + f.v[0] * t, f.c[1] + f.u[1] * s + f.v[1] * t]
/** 框的矩形（可外扩 d） */
export const rectOf = (f: Frame, d = 0): P[] => [at(f, -f.a - d, -f.b - d), at(f, f.a + d, -f.b - d), at(f, f.a + d, f.b + d), at(f, -f.a - d, f.b + d)]

/** 平面多边形在屋脊方向上的最小外接矩形 */
export function frameOf(poly: Poly, ridge: number): Frame {
  const u: P = [Math.cos(ridge), Math.sin(ridge)]
  const v: P = [-u[1], u[0]]
  let s0 = Infinity
  let s1 = -Infinity
  let t0 = Infinity
  let t1 = -Infinity
  for (const p of poly) {
    const s = p[0] * u[0] + p[1] * u[1]
    const t = p[0] * v[0] + p[1] * v[1]
    s0 = Math.min(s0, s)
    s1 = Math.max(s1, s)
    t0 = Math.min(t0, t)
    t1 = Math.max(t1, t)
  }
  const sc = (s0 + s1) / 2
  const tc = (t0 + t1) / 2
  // 半长不小于半宽：屋脊总沿长边
  const f: Frame = { c: [u[0] * sc + v[0] * tc, u[1] * sc + v[1] * tc], u, v, a: (s1 - s0) / 2, b: (t1 - t0) / 2 }
  return f.a >= f.b ? f : { c: f.c, u: v, v: [-u[0], -u[1]], a: f.b, b: f.a }
}

/**
 * 屋面剖面：u ∈ [0, 1] 从檐口到屋脊的高度比例。
 * 西式为直坡；东亚为下凹的曲面（近脊陡、近檐缓，即举折 / 反り），分三段折线近似。
 */
export type Profile = 'straight' | 'curved'
const BANDS: Record<Profile, number[]> = { straight: [0, 1], curved: [0, 0.4, 0.72, 1] }
/** 小屋顶的曲面只分两段 */
const bandsOf = (p: Profile, b: number) => (p === 'curved' && b < 4 ? [0, 0.55, 1] : BANDS[p])
const lift = (p: Profile, u: number) => (p === 'curved' ? Math.pow(u, 1.55) : u)

/**
 * 屋顶的基本参数：墙顶高度 y，坡度 k（tan，按直坡计的脊高 = 半宽 × k），出檐 o。
 * 曲面屋顶在墙线处与墙顶齐平，檐口与屋脊按剖面反推。
 */
interface Roof {
  /** 檐口高度、脊高 */
  ye: number
  yr: number
}
function roofLevels(f: Frame, y: number, k: number, o: number, p: Profile): Roof {
  const B = f.b + o
  const yr = y + f.b * k
  // 墙线处（距檐口 o）的高度比例
  const g = lift(p, o / B)
  // ye + (yr − ye)·g = y
  const ye = g >= 1 ? y : (y - yr * g) / (1 - g)
  return { ye, yr }
}

/** 屋面板厚：不超过半宽的一成（小棚子的屋面不至于成一块厚板） */
const thOf = (w: Writer, f: Frame) => Math.min(w.roofTh, 0.04 + f.b * 0.09)
/** 水平方向的单位向量（平面 → 三维） */
const h3 = (p: P, k = 1): V3 => [p[0] * k, 0, p[1] * k]

/**
 * 屋脊的脊瓦：沿 u 从 −r 到 r、架在脊高 yr 上的三角棱（坡度 kk 的两坡上），两端封口
 */
function ridgeCap(w: Writer, f: Frame, r: number, yr: number, kk: number, roof: RGB) {
  if (r <= 0.05) return
  const rw = Math.min(0.22, 0.1 + f.b * 0.02)
  const rc = rw * 0.7
  const P = (s: number, t: number, h: number) => v3(at(f, s, t), h)
  const yb = yr - rw * kk + 0.015
  w.c = shade(roof, 0.8)
  w.face = MAT.plain
  for (const t of [-1, 1]) w.quadOut(P(-r, 0, yr + rc), P(r, 0, yr + rc), P(r, rw * t, yb), P(-r, rw * t, yb), [f.v[0] * t, 1, f.v[1] * t])
  for (const e of [-1, 1]) w.triOut(P(r * e, 0, yr + rc), P(r * e, rw, yb), P(r * e, -rw, yb), h3(f.u, e))
}

/**
 * 四坡（庑殿 / 寄栋）；屋脊短于 0 时成攒尖。
 * 由檐口一圈逐段收到屋脊：每段四个梯形（两端在屋脊处退化为三角形）；屋面有厚度，檐口一圈封檐板，屋脊加脊瓦
 */
export function hip(w: Writer, f: Frame, y: number, k: number, o: number, roof: RGB, p: Profile = 'straight') {
  const { ye, yr } = roofLevels(f, y, k, o, p)
  const A = f.a + o
  const B = f.b + o
  const r = Math.max(0, f.a - f.b)
  hipRing(w, f, roof, bandsOf(p, f.b), (u) => {
    const s = A + (r - A) * u
    const t = B * (1 - u)
    const h = ye + (yr - ye) * lift(p, u)
    return [v3(at(f, -s, -t), h), v3(at(f, s, -t), h), v3(at(f, s, t), h), v3(at(f, -s, t), h)]
  })
  ridgeCap(w, f, r, yr, (yr - ye) / B, roof)
}

/** 四坡的一圈屋面板：ring(u) 给出第 u 道（0 为檐口）的四个角，逐段连成四个梯形，檐口一圈封檐板 */
function hipRing(w: Writer, f: Frame, roof: RGB, bands: number[], ring: (u: number) => V3[]) {
  const th = thOf(w, f)
  const under = shade(roof, 0.5)
  w.c = roof
  w.face = w.roofFace
  for (let i = 0; i < bands.length - 1; i++) {
    const lo = ring(bands[i])
    const hi = ring(bands[i + 1])
    for (let e = 0; e < 4; e++) {
      const n = (e + 1) % 4
      w.slabQuad(lo[n], lo[e], hi[e], hi[n], th, under)
    }
  }
  eaveFascia(w, f, ring(0), th, under)
}

/** 檐口一圈的封檐板（四坡与歇山的下半） */
function eaveFascia(w: Writer, f: Frame, lo: V3[], th: number, col: RGB) {
  w.c = col
  w.face = MAT.plain
  for (let e = 0; e < 4; e++) {
    const a = lo[e]
    const b = lo[(e + 1) % 4]
    w.edgeStrip(a, b, th, [(a[0] + b[0]) / 2 - f.c[0], 0, (a[2] + b[2]) / 2 - f.c[1]])
  }
}

/**
 * 两坡（硬山 / 悬山 / 切妻）：屋脊沿 u；山墙在墙线 ±a 处，跟着屋面剖面。
 * 屋面是有厚度的板：两侧檐口的封檐板、山面一侧的博风边、底板；直坡屋顶加脊瓦
 */
export function gable(w: Writer, f: Frame, y: number, k: number, o: number, roof: RGB, wall: RGB, p: Profile = 'straight', side = 0.6) {
  const { ye, yr } = roofLevels(f, y, k, o, p)
  const A = f.a + o * side
  const B = f.b + o
  const bands = bandsOf(p, f.b)
  const th = thOf(w, f)
  const under = shade(roof, 0.5)
  const hAt = (u: number) => ye + (yr - ye) * lift(p, u)
  const P = (s: number, t: number, h: number) => v3(at(f, s, t), h)
  for (const s of [-1, 1]) {
    w.c = roof
    w.face = w.roofFace
    for (let i = 0; i < bands.length - 1; i++) {
      const t0 = B * (1 - bands[i]) * s
      const t1 = B * (1 - bands[i + 1]) * s
      const h0 = hAt(bands[i])
      const h1 = hAt(bands[i + 1])
      w.slabQuad(P(-A, t0, h0), P(A, t0, h0), P(A, t1, h1), P(-A, t1, h1), th, under)
    }
    // 板边：檐口封檐板、山面的博风边
    w.c = under
    w.face = MAT.plain
    w.edgeStrip(P(-A, B * s, ye), P(A, B * s, ye), th, h3(f.v, s))
    for (let i = 0; i < bands.length - 1; i++) {
      const t0 = B * (1 - bands[i]) * s
      const t1 = B * (1 - bands[i + 1]) * s
      for (const e of [-1, 1]) w.edgeStrip(P(A * e, t0, hAt(bands[i])), P(A * e, t1, hAt(bands[i + 1])), th, h3(f.u, e))
    }
  }
  // 脊瓦（曲面屋顶近脊处更陡）
  ridgeCap(w, f, A, yr, ((yr - ye) / B) * (p === 'curved' ? 1.55 : 1), roof)
  // 山墙：以墙线底边中点为心的扇形（屋面自脊向两侧单调下降，扇形总在山墙之内），朝外
  w.c = wall
  w.face = w.gableFace
  const tb = (t: number) => ye + (yr - ye) * lift(p, 1 - Math.abs(t) / B) - th * 0.5
  const cols: number[] = [f.b]
  for (const u of bands) {
    const t = B * (1 - u)
    if (t < f.b) cols.push(t)
  }
  const ts = [...cols.map((t) => -t), ...cols.slice(0, -1).reverse()]
  for (const s of [-1, 1]) {
    const o3 = P(f.a * s, 0, y)
    for (let i = 0; i < ts.length - 1; i++) w.triOut(o3, P(f.a * s, ts[i + 1], tb(ts[i + 1])), P(f.a * s, ts[i], tb(ts[i])), h3(f.u, s))
  }
}

/** 歇山 / 入母屋：下半是四坡的一圈，上半是两坡（山面竖直，略收进） */
export function irimoya(w: Writer, f: Frame, y: number, k: number, o: number, roof: RGB, gableWall: RGB, p: Profile = 'curved') {
  const d = f.b * 0.45
  const { ye, yr } = roofLevels(f, y, k, o, p)
  const A = f.a + o
  const B = f.b + o
  // 下半一圈：从檐口收到 u1（对应向内 d）
  const u1 = (o + d) / B
  const ring = (u: number) => {
    const t = B * (1 - u)
    const s = A - (B - t)
    const h = ye + (yr - ye) * lift(p, u)
    return [v3(at(f, -s, -t), h), v3(at(f, s, -t), h), v3(at(f, s, t), h), v3(at(f, -s, t), h)]
  }
  hipRing(w, f, roof, [...bandsOf(p, f.b).filter((u) => u < u1), u1], ring)
  // 上半两坡：接在一圈的内沿上，屋面继续按剖面上升
  const top = ring(u1)
  const tIn = B * (1 - u1)
  const sIn = A - (B - tIn)
  const yIn = top[0][1]
  const inner: Frame = { ...f, a: sIn, b: tIn }
  gable(w, inner, yIn, (yr - yIn) / Math.max(0.01, tIn), 0, roof, gableWall, 'straight')
}

/** 平顶加女儿墙（伊斯兰的土坯房、西式城堡与塔的顶） */
export function flat(w: Writer, f: Frame, y: number, roof: RGB, wall: RGB, parapet = 0.7) {
  w.c = roof
  w.face = MAT.flatRoof
  cap(w, rectOf(f), y)
  if (parapet <= 0) return
  w.c = wall
  w.face = w.gableFace
  const t = Math.min(0.35, f.b * 0.2)
  const outer = rectOf(f)
  const inner = rectOf(f, -t)
  walls(w, outer, y, y + parapet)
  // 内侧墙面与墙顶
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    w.quad(v3(inner[i], y), v3(inner[j], y), v3(inner[j], y + parapet), v3(inner[i], y + parapet))
    w.quad(v3(outer[j], y + parapet), v3(outer[i], y + parapet), v3(inner[i], y + parapet), v3(inner[j], y + parapet))
  }
}

/** 雉堞：沿 a→b 的墙沿每隔 step 米立一个垛，向 inward（单位向量）一侧厚 depth */
export function merlons(w: Writer, a: P, b: P, ya: number, yb: number, inward: P, depth: number, h: number, step = 3) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  const n = Math.floor(L / step)
  if (n < 1) return
  const ux = (b[0] - a[0]) / L
  const uz = (b[1] - a[1]) / L
  const half = step * 0.28
  const ix = inward[0] * depth
  const iz = inward[1] * depth
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * (L / n)
    const cx = a[0] + ux * s
    const cz = a[1] + uz * s
    const y = ya + ((yb - ya) * s) / L
    const ring: P[] = [
      [cx - ux * half, cz - uz * half],
      [cx + ux * half, cz + uz * half],
      [cx + ux * half + ix, cz + uz * half + iz],
      [cx - ux * half + ix, cz - uz * half + iz],
    ]
    prism(w, ring, y - 0.05, y + h)
  }
}

/** 半球穹顶（经纬网），k 为竖向拉伸（洋葱顶、尖顶 > 1） */
export function dome(w: Writer, c: P, r: number, y: number, col: RGB, n = 16, rings = 6, k = 1) {
  w.c = col
  w.face = 0
  const p = (a: number, b: number): V3 => [c[0] + Math.cos(b) * Math.cos(a) * r, y + Math.sin(a) * r * k, c[1] + Math.sin(b) * Math.cos(a) * r]
  for (let j = 0; j < rings; j++) {
    const a0 = (j / rings) * Math.PI * 0.5
    const a1 = ((j + 1) / rings) * Math.PI * 0.5
    for (let i = 0; i < n; i++) {
      const b0 = (i / n) * Math.PI * 2
      const b1 = ((i + 1) / n) * Math.PI * 2
      if (j === rings - 1) w.tri(p(a0, b0), p(a1, b0), p(a0, b1))
      else w.quad(p(a0, b0), p(a1, b0), p(a1, b1), p(a0, b1))
    }
  }
}

/** 圆锥顶 */
export function cone(w: Writer, c: P, r: number, y: number, h: number, col: RGB, n = 12) {
  w.c = col
  w.face = w.roofFace
  const apex: V3 = [c[0], y + h, c[1]]
  for (let i = 0; i < n; i++) {
    const b0 = (i / n) * Math.PI * 2
    const b1 = ((i + 1) / n) * Math.PI * 2
    w.tri([c[0] + Math.cos(b0) * r, y, c[1] + Math.sin(b0) * r], apex, [c[0] + Math.cos(b1) * r, y, c[1] + Math.sin(b1) * r])
  }
}

export const circle = (c: P, r: number, n: number): P[] => Array.from({ length: n }, (_, i) => [c[0] + Math.cos((i / n) * Math.PI * 2) * r, c[1] + Math.sin((i / n) * Math.PI * 2) * r] as P)

/** 沿两点拉出一段有厚度的条（城墙、院墙、桥栏）：返回四角（从上方看逆时针，即 cap 的朝上绕向） */
export function strip(a: P, b: P, half: number): P[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const nx = (-(b[1] - a[1]) / L) * half
  const nz = ((b[0] - a[0]) / L) * half
  return [
    [a[0] + nx, a[1] + nz],
    [b[0] + nx, b[1] + nz],
    [b[0] - nx, b[1] - nz],
    [a[0] - nx, a[1] - nz],
  ]
}

/** 墙段：两端各自的墙顶高度（随地形），连同顶面 */
export function wallSegment(w: Writer, a: P, b: P, half: number, y0: number, ya: number, yb: number) {
  const r = strip(a, b, half)
  walls(w, r, y0, [ya, yb, yb, ya])
  w.quad(v3(r[0], ya), v3(r[1], yb), v3(r[2], yb), v3(r[3], ya))
}

/** 斜板：沿 a→b 的条，两端顶面高 ya、yb，厚 th（桥面） */
export function slab(w: Writer, a: P, b: P, half: number, ya: number, yb: number, th: number) {
  const r = strip(a, b, half)
  const top = [v3(r[0], ya), v3(r[1], yb), v3(r[2], yb), v3(r[3], ya)]
  const bot = [v3(r[0], ya - th), v3(r[1], yb - th), v3(r[2], yb - th), v3(r[3], ya - th)]
  w.quad(top[0], top[1], top[2], top[3])
  w.quad(bot[0], bot[3], bot[2], bot[1])
  w.quad(bot[0], bot[1], top[1], top[0])
  w.quad(bot[2], bot[3], top[3], top[2])
}

/** 闭合环按 step 米加密（随地形起伏的墙顶逐点取高），去掉过近的点 */
function densify(ring: P[], step: number): P[] {
  const out: P[] = []
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 0.3) return
    const segs = Math.max(1, Math.ceil(L / step))
    for (let s = 0; s < segs; s++) out.push([a[0] + ((b[0] - a[0]) * s) / segs, a[1] + ((b[1] - a[1]) * s) / segs])
  })
  return out
}

/**
 * 围墙：沿闭合环拉成厚 2·half 的墙（内外两面 + 顶），转角斜接。
 * top(p) 给出该点的墙顶高度，y0 为埋入地下的墙脚；返回加密后的环（upward 绕向）供墙帽沿用
 */
export function fence(w: Writer, ring: P[], half: number, y0: (p: P) => number, top: (p: P) => number, step = 40): P[] {
  const r = upward(densify(ring, step))
  if (r.length < 3) return r
  const o = offsetRing(r, half)
  const i = offsetRing(r, -half)
  r.forEach((c, k) => {
    const l = (k + 1) % r.length
    const d = r[l]
    w.at(c[0], c[1])
    const t0 = top(c)
    const t1 = top(d)
    const b0 = y0(c)
    const b1 = y0(d)
    const nx = -(d[1] - c[1])
    const nz = d[0] - c[0]
    w.quadOut(v3(o[k], t0), v3(o[l], t1), v3(i[l], t1), v3(i[k], t0), UP)
    w.quadOut(v3(o[k], b0), v3(o[l], b1), v3(o[l], t1), v3(o[k], t0), [nx, 0, nz])
    w.quadOut(v3(i[k], b0), v3(i[l], b1), v3(i[l], t1), v3(i[k], t0), [-nx, 0, -nz])
  })
  return r
}

/**
 * 墙帽：骑在围墙上的小两坡瓦顶，屋脊沿墙中线，两侧出檐 half 到墙外，转角斜接。
 * r 为 fence 返回的环；y(p) 为檐口高度，rise 为脊高于檐口，th 为瓦面厚（檐口的封檐板与底板）
 */
export function coping(w: Writer, r: P[], half: number, y: (p: P) => number, rise: number, th: number, under: RGB) {
  if (r.length < 3) return
  const o = offsetRing(r, half)
  const i = offsetRing(r, -half)
  // 脊瓦：压在屋脊上的一道三角棱，两侧落在坡面上
  const rw = Math.min(0.12, half * 0.3)
  const ro = offsetRing(r, rw)
  const ri = offsetRing(r, -rw)
  const drop = (rw / half) * rise - 0.01
  const roof = w.c
  const face = w.face
  const ridge = shade(roof, 0.8)
  r.forEach((c, k) => {
    const l = (k + 1) % r.length
    const d = r[l]
    const e0 = y(c)
    const e1 = y(d)
    const out: V3 = [-(d[1] - c[1]), 0, d[0] - c[0]]
    const inn: V3 = [-out[0], 0, -out[2]]
    w.at(c[0], c[1])
    w.c = roof
    w.face = face
    w.slabQuad(v3(c, e0 + rise), v3(d, e1 + rise), v3(o[l], e1), v3(o[k], e0), th, under)
    w.slabQuad(v3(c, e0 + rise), v3(d, e1 + rise), v3(i[l], e1), v3(i[k], e0), th, under)
    w.c = under
    w.face = MAT.plain
    w.edgeStrip(v3(o[k], e0), v3(o[l], e1), th, out)
    w.edgeStrip(v3(i[k], e0), v3(i[l], e1), th, inn)
    w.c = ridge
    const t0 = e0 + rise + rw * 0.6
    const t1 = e1 + rise + rw * 0.6
    w.quadOut(v3(c, t0), v3(d, t1), v3(ro[l], e1 + rise - drop), v3(ro[k], e0 + rise - drop), [out[0], 1, out[2]])
    w.quadOut(v3(c, t0), v3(d, t1), v3(ri[l], e1 + rise - drop), v3(ri[k], e0 + rise - drop), [inn[0], 1, inn[2]])
  })
  w.c = roof
  w.face = face
}
