/**
 * 聚落沙盘的几何写入器与参数化构件（墙体、勒脚、平顶、两坡、四坡、歇山、攒尖、单坡、旋转体）。
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
  /** 每顶点的立面坐标：墙面为 (沿墙米数, 墙长 + 1024 × 立面样式 STYLE, 墙顶高度)，其余为 0 */
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
 * 改这里要同步改 buildingShader.ts。16 ~ 23 留给城防与构筑物（works.ts）
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
  /** 东亚殿堂的木构立面：柱、额枋与槅扇（东方朱柱、和式素木） */
  hall: 11,
  /** 斗拱层：檐下一圈出挑的斗拱 */
  dougong: 12,
  /** 金属皮（铜绿、铅皮的穹顶与尖塔，竖向咬口） */
  metal: 13,
  /** 茅草顶 */
  thatch: 14,
  /** 釉面砖（伊斯兰的门墙、穹顶、檐下饰带） */
  glaze: 15,
  /** 露椽的檐底（椽子顺坡排列） */
  rafter: 24,
  /** 木瓦、桧皮葺 */
  shingle: 25,
  /** 白石台基与栏杆（须弥座、望柱栏板） */
  marble: 26,
  /** 土坯、夯土 */
  adobe: 27,
  /** 鎏金（塔刹、宝顶） */
  gilt: 28,
} as const
/** 材质字节里的开窗标记：墙面按层高、开间排窗，底层居中开门 */
export const WIN = 128
/** 材质字节的开门位：这面墙在底层居中的开间开门 */
export const DOOR = 64

/**
 * 立面样式（0 ~ 15，编进立面坐标的墙长里）：开窗的墙面上洞口怎么排。
 * 改这里要同步改 buildingShader.ts
 */
export const STYLE = {
  /** 民居：按层、按开间排窗，随文明 */
  house: 0,
  /** 山墙尖：居中一扇阁楼窗 */
  attic: 1,
  /** 临街铺面：底层是宽大的铺面口，楼上照常开窗 */
  shop: 2,
  /** 教堂的长窗：每开间一扇尖拱高窗，自墙身中段到檐下 */
  lancet: 3,
  /** 高侧窗：只在墙顶一带开一排尖拱窗（下段被侧廊挡住） */
  clerestory: 4,
  /** 正立面：居中的大门洞与其上的玫瑰窗 */
  portal: 5,
  /** 钟楼：顶层每面成对的百叶钟窗，塔身零星的小窗 */
  belfry: 6,
  /** 敞廊：每开间一个落地的拱洞（回廊、市场的拱廊、清真寺的回廊） */
  arcade: 7,
  /** 殿堂的槅扇：每开间落地的格扇门窗 */
  lattice: 8,
  /** 射孔与小窗：稀疏的窄窗（主楼、塔、天守） */
  slit: 9,
  /** 伊旺：整面墙一个尖拱大龛 */
  iwan: 10,
  /** 只在楼上开小窗（伊斯兰内向的宅子、仓房） */
  upper: 11,
} as const

/** 每块的缓冲：各属性按顶点数一起增长 */
class Buf {
  /** 顶点数与容量 */
  n = 0
  cap = 768
  pos = new Float32Array(this.cap * 3)
  nrm = new Int8Array(this.cap * 3)
  col = new Uint8Array(this.cap * 4)
  life = new Float32Array(this.cap * 3)
  uv = new Float32Array(this.cap * 3)
  ids = new Int32Array(this.cap / 3)
  box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  grow() {
    const cap = this.cap * 2
    const f = (a: Float32Array, k: number) => {
      const b = new Float32Array(cap * k)
      b.set(a)
      return b
    }
    this.pos = f(this.pos, 3)
    this.life = f(this.life, 3)
    this.uv = f(this.uv, 3)
    const nrm = new Int8Array(cap * 3)
    nrm.set(this.nrm)
    this.nrm = nrm
    const col = new Uint8Array(cap * 4)
    col.set(this.col)
    this.col = col
    const ids = new Int32Array(cap / 3)
    ids.set(this.ids)
    this.ids = ids
    this.cap = cap
  }
}

/**
 * 写入器：先用 at() 选块、设好颜色 c 与生卒，再写三角形。
 * 三角形逆时针（从外侧看）为正面；tri 的法线按三角形求出（平面），triN 逐顶点给法线（圆柱、穹顶这类光滑表面）
 */
export class Writer {
  private bufs: Buf[]
  private cur: Buf
  /** 当前颜色（sRGB 0~255）与材质字节（MAT，开窗的墙面再加 WIN、开门的墙面加 DOOR） */
  c: RGB = [255, 255, 255]
  face = 0
  /** 立面样式（STYLE）：walls 写墙面时编进立面坐标 */
  style = 0
  /** 当前三角形各顶点的立面坐标（墙面：沿墙米数、墙长与墙顶高度）；不给为 0 */
  uvOf: ((p: V3) => readonly [number, number, number]) | null = null
  /** 屋顶构件用的材质：屋面、山墙面、屋面板厚（米）、檐底 */
  roofFace: number = MAT.tile
  gableFace: number = MAT.plaster
  roofTh = 0.18
  soffit: number = MAT.plain
  /** 山墙尖开一扇阁楼窗（gable 写山墙时带上立面坐标与开窗位） */
  gableWin = false
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
    this.style = 0
    this.roofFace = MAT.tile
    this.gableFace = MAT.plaster
    this.roofTh = 0.18
    this.soffit = MAT.plain
    this.gableWin = false
    this.uvOf = null
  }

  /** 选定点 (x, z) 所在的块 */
  at(x: number, z: number) {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x / this.width) * this.nx)))
    const j = Math.min(this.nz - 1, Math.max(0, Math.floor((z / this.height) * this.nz)))
    this.cur = this.bufs[j * this.nx + i]
  }

  private vert(B: Buf, p: V3, nx: number, ny: number, nz: number) {
    const k = B.n * 3
    const x = p[0]
    const y = p[1]
    const z = p[2]
    B.pos[k] = x
    B.pos[k + 1] = y
    B.pos[k + 2] = z
    B.nrm[k] = nx
    B.nrm[k + 1] = ny
    B.nrm[k + 2] = nz
    B.life[k] = this.born
    B.life[k + 1] = this.died
    B.life[k + 2] = this.base
    const q = B.n * 4
    const c = this.c
    B.col[q] = c[0]
    B.col[q + 1] = c[1]
    B.col[q + 2] = c[2]
    B.col[q + 3] = this.face
    if (this.uvOf) {
      const uv = this.uvOf(p)
      B.uv[k] = uv[0]
      B.uv[k + 1] = uv[1]
      B.uv[k + 2] = uv[2]
    }
    const box = B.box
    if (x < box[0]) box[0] = x
    if (y < box[1]) box[1] = y
    if (z < box[2]) box[2] = z
    if (x > box[3]) box[3] = x
    if (y > box[4]) box[4] = y
    if (z > box[5]) box[5] = z
    B.n++
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
    if (B.n + 3 > B.cap) B.grow()
    B.ids[B.n / 3] = this.id
    this.vert(B, a, nx, ny, nz)
    this.vert(B, b, nx, ny, nz)
    this.vert(B, c, nx, ny, nz)
  }

  /**
   * 逐顶点给法线的三角形（法线不必归一）；绕向按法线自动决定，退化的不写
   */
  triN(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3) {
    const ux = b[0] - a[0]
    const uy = b[1] - a[1]
    const uz = b[2] - a[2]
    const vx = c[0] - a[0]
    const vy = c[1] - a[1]
    const vz = c[2] - a[2]
    const gx = uy * vz - uz * vy
    const gy = uz * vx - ux * vz
    const gz = ux * vy - uy * vx
    if (gx * gx + gy * gy + gz * gz < 1e-18) return
    const B = this.cur
    if (B.n + 3 > B.cap) B.grow()
    B.ids[B.n / 3] = this.id
    const put = (p: V3, n: V3) => {
      const l = Math.hypot(n[0], n[1], n[2]) || 1
      this.vert(B, p, Math.round((n[0] / l) * 127), Math.round((n[1] / l) * 127), Math.round((n[2] / l) * 127))
    }
    put(a, na)
    if (gx * (na[0] + nb[0] + nc[0]) + gy * (na[1] + nb[1] + nc[1]) + gz * (na[2] + nb[2] + nc[2]) >= 0) {
      put(b, nb)
      put(c, nc)
    } else {
      put(c, nc)
      put(b, nb)
    }
  }

  /** 四边形 abcd（逆时针） */
  quad(a: V3, b: V3, c: V3, d: V3) {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }

  /** 逐顶点给法线的四边形 */
  quadN(a: V3, b: V3, c: V3, d: V3, na: V3, nb: V3, nc: V3, nd: V3) {
    this.triN(a, b, c, na, nb, nc)
    this.triN(a, c, d, na, nc, nd)
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
   * 屋面板的一块：上表面 abcd（当前颜色与材质），下面压低 th 的底板（颜色 under、檐底材质，朝下）
   */
  slabQuad(a: V3, b: V3, c: V3, d: V3, th: number, under: RGB) {
    this.quadOut(a, b, c, d, UP)
    const lo = (p: V3): V3 => [p[0], p[1] - th, p[2]]
    const col = this.c
    const face = this.face
    this.c = under
    this.face = this.soffit
    this.quadOut(lo(a), lo(b), lo(c), lo(d), DOWN)
    this.c = col
    this.face = face
  }

  /** 板的一条边：边 ab 与压低 th 后的边围成的竖条，朝向 out */
  edgeStrip(a: V3, b: V3, th: number, out: V3) {
    this.quadOut(a, b, [b[0], b[1] - th, b[2]], [a[0], a[1] - th, a[2]], out)
  }

  /** 已写的三角形数 */
  get tris() {
    let s = 0
    for (const b of this.bufs) s += b.n / 3
    return s
  }

  finish(): TownChunk[] {
    return this.bufs
      .filter((b) => b.n > 0)
      .map((b) => ({ pos: b.pos.slice(0, b.n * 3), nrm: b.nrm.slice(0, b.n * 3), col: b.col.slice(0, b.n * 4), uv: b.uv.slice(0, b.n * 3), life: b.life.slice(0, b.n * 3), ids: b.ids.slice(0, b.n / 3), box: b.box }))
  }
}

export type V3 = [number, number, number]
const DOWN: V3 = [0, -1, 0]
const UP: V3 = [0, 1, 0]
/** 颜色按比例压暗（屋面底板、脊瓦） */
export const shade = (c: RGB, k: number): RGB => [Math.min(255, Math.round(c[0] * k)), Math.min(255, Math.round(c[1] * k)), Math.min(255, Math.round(c[2] * k))]
/** 两色相混 */
export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]

/** 屋面板的侧边与底板的颜色：屋面色压暗、偏向木色（封檐板、望板） */
export const underOf = (roof: RGB): RGB => mixRGB(shade(roof, 0.62), [98, 82, 66], 0.35)

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
 * 逐面墙的开窗与开门（facade.ts 的分析结果）；alt 给某一面墙另换材质字节、立面样式与颜色（临街的铺面、教堂的正立面）
 */
export interface WallFac {
  win: boolean[]
  door: number
  alt?: (k: number) => { face: number; style: number; c?: RGB } | null | undefined
}

/** 墙面的立面坐标：沿墙米数自起点量起，墙长里编进立面样式 */
const wallUv = (w: Writer, ax: number, az: number, dx: number, dz: number, L: number, top: number) => {
  const uv: [number, number, number] = [0, Math.min(1000, Math.max(0.25, L)) + 1024 * w.style, top]
  w.uvOf = (p) => ((uv[0] = ((p[0] - ax) * dx + (p[2] - az) * dz) / L), uv)
}

/**
 * 竖直外墙：环从 y0 拉到 y1（y1 可逐点给出，随地形起伏的墙顶）。
 * 当前材质带 WIN 位（可开窗的立面）时，fac 给出逐面墙（ring[k] → ring[k + 1]）开不开窗、门开在哪面：
 * 不开窗的墙去掉 WIN 位，开门的墙加 DOOR 位。
 * smooth 为折角的余弦阈值：相邻两面墙的夹角小于它时共用顶点法线（圆塔、半圆后殿的弧面），缺省全是平面
 */
export function walls(w: Writer, ring: P[], y0: number, y1: number | number[], fac?: WallFac, smooth = 2) {
  const flip = area2(ring) >= 0
  const r = flip ? [...ring].reverse() : ring
  const tops = Array.isArray(y1) ? (flip ? [...y1].reverse() : y1) : null
  const face = w.face
  const style = w.style
  const col = w.c
  const n = r.length
  // 各面墙的外法线
  let nrm: V3[] | null = null
  if (smooth < 1) {
    nrm = r.map((a, i) => {
      const b = r[(i + 1) % n]
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      return [-(b[1] - a[1]) / L, 0, (b[0] - a[0]) / L] as V3
    })
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
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
    w.face = fac && face & WIN ? (face & ~WIN) | (fac.win[k] ? WIN : 0) | (fac.door === k ? DOOR : 0) : face
    const alt = fac?.alt?.(k)
    if (alt) {
      w.face = alt.face
      w.style = alt.style
      if (alt.c) w.c = alt.c
    }
    wallUv(w, ax, az, dx, dz, L, Math.min(tp, tq))
    const a = v3(r[i], y0)
    const b = v3(r[j], y0)
    const c = v3(r[j], tq)
    const d = v3(r[i], tp)
    if (nrm) {
      const m = nrm[i]
      const p = nrm[(i - 1 + n) % n]
      const q = nrm[j]
      const na: V3 = p[0] * m[0] + p[2] * m[2] > smooth ? [p[0] + m[0], 0, p[2] + m[2]] : m
      const nb: V3 = q[0] * m[0] + q[2] * m[2] > smooth ? [q[0] + m[0], 0, q[2] + m[2]] : m
      w.quadN(a, b, c, d, na, nb, nb, na)
    } else w.quad(a, b, c, d)
    if (alt) {
      w.style = style
      w.c = col
    }
  }
  w.face = face
  w.uvOf = null
}

/**
 * 单独的一面墙：自 a 到 b，y0 到 y1，朝 out 一侧（平面向量，只用来定朝向）；带立面坐标，用当前材质与立面样式
 */
export function wall1(w: Writer, a: P, b: P, y0: number, y1: number, out: P) {
  let dx = b[0] - a[0]
  let dz = b[1] - a[1]
  // 外法线取 (−dz, dx)：与 out 反向时两端对调
  if (-dz * out[0] + dx * out[1] < 0) {
    const t = a
    a = b
    b = t
    dx = -dx
    dz = -dz
  }
  const L = Math.hypot(dx, dz) || 1
  wallUv(w, a[0], a[1], dx, dz, L, y1)
  w.quad(v3(a, y0), v3(b, y0), v3(b, y1), v3(a, y1))
  w.uvOf = null
}

/**
 * 收分的墙：下环 lo（y0）到上环 hi（y1），两环点数相同、逐点对应（石垣、斜收的塔身、台基的斜面）
 */
export function taper(w: Writer, lo: P[], hi: P[], y0: number, y1: number) {
  const flip = area2(lo) >= 0
  const a = flip ? [...lo].reverse() : lo
  const b = flip ? [...hi].reverse() : hi
  const n = a.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = a[j][0] - a[i][0]
    const dz = a[j][1] - a[i][1]
    const L = Math.hypot(dx, dz) || 1
    wallUv(w, a[i][0], a[i][1], dx, dz, L, y1)
    w.quad(v3(a[i], y0), v3(a[j], y0), v3(b[j], y1), v3(b[i], y1))
  }
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

/** 环整体外扩 d（负数内收），绕向不限，顶点次序与原环一致 */
export function grow(ring: P[], d: number): P[] {
  if (area2(ring) < 0) return offsetRing(ring, d)
  return offsetRing([...ring].reverse(), d).reverse()
}

/**
 * 环的各边分别外扩 d[k]（第 k 边为 ring[k] → ring[k + 1]），顶点次序与原环一致：出挑的楼层只在临空的几面挑出
 */
export function growEdges(ring: P[], d: number[]): P[] {
  const n = ring.length
  const sg = area2(ring) < 0 ? 1 : -1
  const nrm = ring.map((a, i) => {
    const b = ring[(i + 1) % n]
    const u = unit([-(b[1] - a[1]), b[0] - a[0]])
    return [u[0] * sg, u[1] * sg] as P
  })
  return ring.map((b, i) => {
    const k0 = (i - 1 + n) % n
    const n1 = nrm[k0]
    const n2 = nrm[i]
    const d1 = d[k0]
    const d2 = d[i]
    const det = n1[0] * n2[1] - n1[1] * n2[0]
    // 两边近乎平行：沿平均法线移
    if (Math.abs(det) < 0.2) return [b[0] + ((n1[0] + n2[0]) / 2) * ((d1 + d2) / 2), b[1] + ((n1[1] + n2[1]) / 2) * ((d1 + d2) / 2)] as P
    // 解 p·n1 = d1、p·n2 = d2
    return [b[0] + (d1 * n2[1] - d2 * n1[1]) / det, b[1] + (d2 * n1[0] - d1 * n2[0]) / det] as P
  })
}

/** 凸多边形的水平面（扇形三角化），朝上 */
export function cap(w: Writer, ring: P[], y: number) {
  const r = upward(ring)
  for (let i = 1; i < r.length - 1; i++) w.tri(v3(r[0], y), v3(r[i], y), v3(r[i + 1], y))
}

/** 凸多边形的水平面，朝下（出挑的楼层、门洞顶、檐下） */
export function capDown(w: Writer, ring: P[], y: number) {
  const r = upward(ring)
  for (let i = 1; i < r.length - 1; i++) w.tri(v3(r[0], y), v3(r[i + 1], y), v3(r[i], y))
}

/** 实心棱柱：墙 + 顶 */
export function prism(w: Writer, ring: P[], y0: number, y1: number) {
  walls(w, ring, y0, y1)
  cap(w, ring, y1)
}

/** 悬空的棱柱：墙 + 顶 + 底（挑出的阳台、梁、枋） */
export function block(w: Writer, ring: P[], y0: number, y1: number) {
  walls(w, ring, y0, y1)
  cap(w, ring, y1)
  capDown(w, ring, y0)
}

/** 两个环之间的水平环带（朝上或朝下）：台基的台面、出挑楼层的底 */
export function annulus(w: Writer, outer: P[], inner: P[], y: number, up = true) {
  const o = upward(outer)
  const i = upward(inner)
  const dir = up ? UP : DOWN
  for (let k = 0; k < o.length; k++) {
    const l = (k + 1) % o.length
    w.quadOut(v3(o[k], y), v3(o[l], y), v3(i[l], y), v3(i[k], y), dir)
  }
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
/** 框里的一个子框：中心在 (s, t)，半长 a、半宽 b，轴向不变 */
export const sub = (f: Frame, s: number, t: number, a: number, b: number): Frame => ({ c: at(f, s, t), u: f.u, v: f.v, a, b })
/** 转 90 度的框（屋脊改沿原来的横向） */
export const turned = (f: Frame): Frame => ({ c: f.c, u: f.v, v: [-f.u[0], -f.u[1]], a: f.b, b: f.a })

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

/** 屋顶的附加做法（东亚的殿堂） */
export interface RoofOpt {
  /** 翼角起翘（米）：檐口到转角处逐渐抬高并略向外伸 */
  upturn?: number
  /** 垂脊 / 戗脊：沿屋角线的脊（宽度，米） */
  ribs?: number
}

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
 * 正脊：沿屋脊的一道矮墙似的脊（东亚殿堂），两端各一只高起的吻兽；h 为脊高（米）
 */
export function ridgeBar(w: Writer, f: Frame, r: number, y: number, h: number, col: RGB) {
  if (r <= 0.1) return
  w.c = col
  w.face = MAT.plain
  const t = h * 0.42
  block(w, [at(f, -r, -t), at(f, r, -t), at(f, r, t), at(f, -r, t)], y - h * 0.9, y + h * 0.75)
  // 吻兽：向内卷起的一块，上小下大
  for (const s of [-1, 1]) {
    const c = at(f, s * (r - h * 0.55), 0)
    const lo = rectOf({ c, u: f.u, v: f.v, a: h * 0.75, b: t * 1.25 })
    const hi = rectOf({ c: at(f, s * (r - h * 0.95), 0), u: f.u, v: f.v, a: h * 0.3, b: t * 0.8 })
    taper(w, lo, hi, y + h * 0.6, y + h * 2.3)
    cap(w, hi, y + h * 2.3)
  }
}

/**
 * 四坡（庑殿 / 寄栋）；屋脊短于 0 时成攒尖。
 * 由檐口一圈逐段收到屋脊：每段四个梯形（两端在屋脊处退化为三角形）；屋面有厚度，檐口一圈封檐板，屋脊加脊瓦
 */
export function hip(w: Writer, f: Frame, y: number, k: number, o: number, roof: RGB, p: Profile = 'straight', opt: RoofOpt = {}) {
  const { ye, yr } = roofLevels(f, y, k, o, p)
  const A = f.a + o
  const B = f.b + o
  const r = Math.max(0, f.a - f.b)
  hipRing(
    w,
    f,
    roof,
    bandsOf(p, f.b),
    (u) => {
      const s = A + (r - A) * u
      const t = B * (1 - u)
      const h = ye + (yr - ye) * lift(p, u)
      return [v3(at(f, -s, -t), h), v3(at(f, s, -t), h), v3(at(f, s, t), h), v3(at(f, -s, t), h)]
    },
    opt,
  )
  if (!opt.ribs) ridgeCap(w, f, r, yr, (yr - ye) / B, roof)
  return { ye, yr, r }
}

/**
 * 四坡的一圈屋面板：ring(u) 给出第 u 道（0 为檐口）的各个角，逐段连成梯形，檐口一圈封檐板。
 * 有翼角起翘时最下一段沿檐口细分：近角处逐渐抬高、沿屋角线外伸
 */
function hipRing(w: Writer, f: Frame, roof: RGB, bands: number[], ring: (u: number) => V3[], opt: RoofOpt = {}) {
  const th = thOf(w, f)
  const under = underOf(roof)
  const rf = w.roofFace
  const up = opt.upturn ?? 0
  const rings = bands.map(ring)
  const n = rings[0].length
  // 檐口的转角：抬高并沿屋角线外伸
  const eave = rings[0]
  const diag = eave.map((p): V3 => {
    const dx = p[0] - f.c[0]
    const dz = p[2] - f.c[1]
    const l = Math.hypot(dx, dz) || 1
    return [dx / l, 0, dz / l]
  })
  const corner = eave.map((p, e): V3 => (up > 0 ? [p[0] + diag[e][0] * up * 0.45, p[1] + up, p[2] + diag[e][2] * up * 0.45] : p))
  w.c = roof
  w.face = rf
  for (let i = 0; i < bands.length - 1; i++) {
    const lo = rings[i]
    const hi = rings[i + 1]
    for (let e = 0; e < n; e++) {
      const m = (e + 1) % n
      if (i > 0 || up <= 0) {
        w.slabQuad(lo[m], lo[e], hi[e], hi[m], th, under)
        continue
      }
      // 沿檐口细分：两端各两段起翘，当中平直
      const len = Math.hypot(lo[m][0] - lo[e][0], lo[m][2] - lo[e][2]) || 1
      const zone = Math.min(len * 0.34, Math.max(1.6, up * 5.5))
      const z = zone / len
      const xs = [0, z * 0.38, z, 1 - z, 1 - z * 0.38, 1]
      const pt = (x: number): V3 => {
        if (x <= 0) return corner[e]
        if (x >= 1) return corner[m]
        const d = Math.min(x, 1 - x) * len
        const q = Math.max(0, 1 - d / zone)
        const g = q * q
        const dg = x < 0.5 ? diag[e] : diag[m]
        return [lo[e][0] + (lo[m][0] - lo[e][0]) * x + dg[0] * up * 0.45 * g, lo[e][1] + (lo[m][1] - lo[e][1]) * x + up * g, lo[e][2] + (lo[m][2] - lo[e][2]) * x + dg[2] * up * 0.45 * g]
      }
      const top = (x: number): V3 => [hi[e][0] + (hi[m][0] - hi[e][0]) * x, hi[e][1] + (hi[m][1] - hi[e][1]) * x, hi[e][2] + (hi[m][2] - hi[e][2]) * x]
      const out: V3 = [(lo[e][0] + lo[m][0]) / 2 - f.c[0], 0, (lo[e][2] + lo[m][2]) / 2 - f.c[1]]
      for (let s = 0; s < xs.length - 1; s++) {
        const a = pt(xs[s])
        const b = pt(xs[s + 1])
        w.c = roof
        w.face = rf
        w.slabQuad(b, a, top(xs[s]), top(xs[s + 1]), th, under)
        w.c = under
        w.face = MAT.plain
        w.edgeStrip(a, b, th, out)
      }
      w.c = roof
      w.face = rf
    }
  }
  if (up <= 0) eaveFascia(w, f, eave, th, under)
  // 屋角线上的脊
  if (opt.ribs) {
    const rw = opt.ribs
    w.c = shade(roof, 0.72)
    w.face = MAT.plain
    for (let e = 0; e < n; e++)
      for (let i = 0; i < bands.length - 1; i++) {
        const a = i === 0 ? corner[e] : rings[i][e]
        const b = rings[i + 1][e]
        const dx = b[0] - a[0]
        const dz = b[2] - a[2]
        const L = Math.hypot(dx, dz)
        if (L < 0.05) continue
        const sx = (-dz / L) * rw
        const sz = (dx / L) * rw
        const rh = rw * 1.5
        const at_: V3 = [a[0], a[1] + rh, a[2]]
        const bt: V3 = [b[0], b[1] + rh, b[2]]
        w.quadOut(at_, bt, [b[0] + sx, b[1] - 0.03, b[2] + sz], [a[0] + sx, a[1] - 0.03, a[2] + sz], [sx, 0.5, sz])
        w.quadOut(at_, bt, [b[0] - sx, b[1] - 0.03, b[2] - sz], [a[0] - sx, a[1] - 0.03, a[2] - sz], [-sx, 0.5, -sz])
        if (i === 0) w.triOut(at_, [a[0] + sx, a[1] - 0.03, a[2] + sz], [a[0] - sx, a[1] - 0.03, a[2] - sz], [-dx, 0, -dz])
      }
  }
}

/** 檐口一圈的封檐板（四坡与歇山的下半） */
function eaveFascia(w: Writer, f: Frame, lo: V3[], th: number, col: RGB) {
  w.c = col
  w.face = MAT.plain
  const n = lo.length
  for (let e = 0; e < n; e++) {
    const a = lo[e]
    const b = lo[(e + 1) % n]
    w.edgeStrip(a, b, th, [(a[0] + b[0]) / 2 - f.c[0], 0, (a[2] + b[2]) / 2 - f.c[1]])
  }
}

/**
 * 两坡（硬山 / 悬山 / 切妻）：屋脊沿 u；山墙在墙线 ±a 处，跟着屋面剖面。
 * 屋面是有厚度的板：两侧檐口的封檐板、山面一侧的博风边、底板；直坡屋顶加脊瓦。
 * side 为山面出际相对出檐的比例
 */
export function gable(w: Writer, f: Frame, y: number, k: number, o: number, roof: RGB, wall: RGB, p: Profile = 'straight', side = 0.6) {
  const { ye, yr } = roofLevels(f, y, k, o, p)
  const A = f.a + o * side
  const B = f.b + o
  const bands = bandsOf(p, f.b)
  const th = thOf(w, f)
  const under = underOf(roof)
  const rf = w.roofFace
  const hAt = (u: number) => ye + (yr - ye) * lift(p, u)
  const P = (s: number, t: number, h: number) => v3(at(f, s, t), h)
  for (const s of [-1, 1]) {
    w.c = roof
    w.face = rf
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
  const tb = (t: number) => ye + (yr - ye) * lift(p, 1 - Math.abs(t) / B) - th * 0.5
  const cols: number[] = [f.b]
  for (const u of bands) {
    const t = B * (1 - u)
    if (t < f.b) cols.push(t)
  }
  const ts = [...cols.map((t) => -t), ...cols.slice(0, -1).reverse()]
  const style = w.style
  for (const s of [-1, 1]) {
    w.face = w.gableFace
    if (w.gableWin) {
      // 山墙尖带立面坐标：沿墙自一侧檐角量起，墙顶记山墙的底边高度（阁楼窗按它定位）
      w.style = STYLE.attic
      // 沿墙方向与 walls 一致（外法线的右手侧），洞口的视差才对
      const o2 = at(f, f.a * s, f.b * s)
      wallUv(w, o2[0], o2[1], -f.v[0] * 2 * f.b * s, -f.v[1] * 2 * f.b * s, 2 * f.b, y)
      w.face = w.gableFace | WIN
    }
    const o3 = P(f.a * s, 0, y)
    for (let i = 0; i < ts.length - 1; i++) w.triOut(o3, P(f.a * s, ts[i + 1], tb(ts[i + 1])), P(f.a * s, ts[i], tb(ts[i])), h3(f.u, s))
  }
  w.uvOf = null
  w.style = style
  return { ye, yr }
}

/**
 * 歇山 / 入母屋：下半是四坡的一圈，上半是两坡（山面竖直，略收进）。
 * d 为山面收进的比例（相对半宽）
 */
export function irimoya(w: Writer, f: Frame, y: number, k: number, o: number, roof: RGB, gableWall: RGB, p: Profile = 'curved', opt: RoofOpt = {}, din = 0.45) {
  const d = f.b * din
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
  hipRing(w, f, roof, [...bandsOf(p, f.b).filter((u) => u < u1 - 0.02), u1], ring, opt)
  // 上半两坡：接在一圈的内沿上，屋面继续按剖面上升
  const top = ring(u1)
  const tIn = B * (1 - u1)
  const sIn = A - (B - tIn)
  const yIn = top[0][1]
  const inner: Frame = { ...f, a: sIn, b: tIn }
  const gw = w.gableWin
  w.gableWin = false
  gable(w, inner, yIn, (yr - yIn) / Math.max(0.01, tIn), 0, roof, gableWall, 'straight')
  w.gableWin = gw
  return { ye, yr, r: sIn }
}

/**
 * 一圈披檐（重檐的下檐、腰檐、塔的各层出檐）：自檐口（墙线 f 外出檐 o）向里收进 din、升到 yIn；
 * 屋面在墙线处与 yWall 齐平。返回檐口高度
 */
export function skirt(w: Writer, f: Frame, yWall: number, o: number, din: number, yIn: number, roof: RGB, p: Profile = 'curved', opt: RoofOpt = {}) {
  const g = lift(p, o / (o + din))
  const ye = (yWall - yIn * g) / (1 - g)
  hipRing(
    w,
    f,
    roof,
    p === 'curved' ? [0, 0.5, 1] : [0, 1],
    (u) => {
      const s = f.a + o - (o + din) * u
      const t = f.b + o - (o + din) * u
      const h = ye + (yIn - ye) * lift(p, u)
      return [v3(at(f, -s, -t), h), v3(at(f, s, -t), h), v3(at(f, s, t), h), v3(at(f, -s, t), h)]
    },
    opt,
  )
  return ye
}

/**
 * 单坡（披檐、侧廊、庇）：高的一边在 −v 侧（t = −b，贴着主体的墙），低的一边在 +v 侧出檐 o；
 * yHi、yLo 为两侧墙线处的屋面高度。两端出际 side，板有厚度；高的一边不封（贴墙）
 */
export function leanTo(w: Writer, f: Frame, yHi: number, yLo: number, o: number, roof: RGB, side = 0.3) {
  const th = thOf(w, f)
  const under = underOf(roof)
  const A = f.a + side
  const k = (yHi - yLo) / (2 * f.b)
  const ye = yLo - o * k
  const P = (s: number, t: number, h: number) => v3(at(f, s, t), h)
  w.c = roof
  w.face = w.roofFace
  w.slabQuad(P(-A, -f.b, yHi), P(A, -f.b, yHi), P(A, f.b + o, ye), P(-A, f.b + o, ye), th, under)
  w.c = under
  w.face = MAT.plain
  w.edgeStrip(P(-A, f.b + o, ye), P(A, f.b + o, ye), th, h3(f.v, 1))
  for (const e of [-1, 1]) w.edgeStrip(P(A * e, -f.b, yHi), P(A * e, f.b + o, ye), th, h3(f.u, e))
}

/**
 * 单坡屋顶下的两片三角形山墙（墙线 ±a 处，自墙顶 y 到屋面）
 */
export function leanToEnds(w: Writer, f: Frame, y: number, yHi: number, yLo: number, wall: RGB, face: number) {
  w.c = wall
  w.face = face
  const P = (s: number, t: number, h: number) => v3(at(f, s, t), h)
  for (const e of [-1, 1]) {
    w.triOut(P(f.a * e, -f.b, y), P(f.a * e, f.b, y), P(f.a * e, -f.b, yHi), h3(f.u, e))
    if (yLo > y + 0.01) w.triOut(P(f.a * e, f.b, y), P(f.a * e, f.b, yLo), P(f.a * e, -f.b, yHi), h3(f.u, e))
  }
}

/**
 * 正多边形的攒尖 / 一圈披檐：n 边，檐口外接圆半径 r0（高 y0），收到半径 r1（高 y1）；
 * r1 为 0 时成尖顶。phase 为第一个角的方位角。屋面有厚度，可带翼角起翘与屋角的脊
 */
export function tent(w: Writer, c: P, n: number, phase: number, r0: number, y0: number, r1: number, y1: number, roof: RGB, p: Profile = 'straight', opt: RoofOpt = {}) {
  const f: Frame = { c, u: [1, 0], v: [0, 1], a: r0, b: r0 }
  const bands = p === 'curved' ? (r0 - r1 < 2.5 ? [0, 0.55, 1] : [0, 0.4, 0.72, 1]) : [0, 1]
  hipRing(
    w,
    f,
    roof,
    bands,
    (u) => {
      const r = r0 + (r1 - r0) * u
      const h = y0 + (y1 - y0) * lift(p, u)
      // 从上方看逆时针（与 rectOf 的绕向一致）
      return Array.from({ length: n }, (_, i): V3 => [c[0] + Math.cos(phase - (i / n) * Math.PI * 2) * r, h, c[1] + Math.sin(phase - (i / n) * Math.PI * 2) * r])
    },
    opt,
  )
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

/** 任意凸环上的女儿墙：外墙面、内墙面与墙顶（厚 t，高 h） */
export function parapet(w: Writer, ring: P[], y: number, h: number, t: number) {
  const o = upward(ring)
  const i = offsetRing(o, -t)
  walls(w, o, y, y + h)
  for (let k = 0; k < o.length; k++) {
    const l = (k + 1) % o.length
    w.quad(v3(i[l], y), v3(i[k], y), v3(i[k], y + h), v3(i[l], y + h))
    w.quadOut(v3(o[k], y + h), v3(o[l], y + h), v3(i[l], y + h), v3(i[k], y + h), UP)
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

/** 矩形框四边的雉堞（垛立在外沿、向内厚 depth） */
export function crenels(w: Writer, f: Frame, y: number, depth: number, h: number, step: number) {
  const r = rectOf(f)
  for (let i = 0; i < 4; i++) {
    const a = r[i]
    const b = r[(i + 1) % 4]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    // rectOf 的绕向使左手法线朝内
    merlons(w, a, b, y, y, [-(b[1] - a[1]) / L, (b[0] - a[0]) / L], depth, h, step)
  }
}

/**
 * 旋转体：剖面 prof 为自下而上的 (半径, 高度) 折线，绕过 c 的竖轴转一圈（n 段），顶点法线光滑。
 * 相邻两段的折角大于约 50 度时不共用法线（保留棱线）。arc 给出起止方位角时只转一段（半圆后殿的半锥顶）。
 * 用当前颜色与材质
 */
export function lathe(w: Writer, c: P, y: number, prof: readonly (readonly [number, number])[], n: number, arc?: readonly [number, number]) {
  const m = prof.length
  if (m < 2) return
  // 各段在 (r, y) 平面里的外法线
  const sn: [number, number][] = []
  for (let j = 0; j < m - 1; j++) {
    const dr = prof[j + 1][0] - prof[j][0]
    const dy = prof[j + 1][1] - prof[j][1]
    const l = Math.hypot(dr, dy) || 1
    sn.push([dy / l, -dr / l])
  }
  const a0 = arc ? arc[0] : 0
  const a1 = arc ? arc[1] : Math.PI * 2
  const cs: [number, number][] = Array.from({ length: n + 1 }, (_, i) => {
    const b = a0 + ((a1 - a0) * i) / n
    return [Math.cos(b), Math.sin(b)]
  })
  // 立面坐标：(方位角 × 最大半径, −1, 0)。着色器在旋转体上用它当横向坐标（按世界坐标量的横向坐标随法线转动，近顶处出摩尔纹）
  const own = !w.uvOf
  let R = 0
  for (const q of prof) R = Math.max(R, q[0])
  let bm = 0
  const uv: [number, number, number] = [0, -1, 0]
  if (own)
    w.uvOf = (p) => {
      const dx = p[0] - c[0]
      const dz = p[2] - c[1]
      let t = bm
      if (dx * dx + dz * dz > 1e-8) {
        t = Math.atan2(dz, dx) - bm
        t = bm + t - Math.round(t / (Math.PI * 2)) * Math.PI * 2
      }
      uv[0] = t * R
      return uv
    }
  for (let j = 0; j < m - 1; j++) {
    const [r0, h0] = prof[j]
    const [r1, h1] = prof[j + 1]
    const cur = sn[j]
    const prev = j > 0 ? sn[j - 1] : cur
    const next = j < m - 2 ? sn[j + 1] : cur
    const lo: [number, number] = prev[0] * cur[0] + prev[1] * cur[1] > 0.64 ? [prev[0] + cur[0], prev[1] + cur[1]] : cur
    const hi: [number, number] = next[0] * cur[0] + next[1] * cur[1] > 0.64 ? [next[0] + cur[0], next[1] + cur[1]] : cur
    for (let i = 0; i < n; i++) {
      const [c0, s0] = cs[i]
      const [c1, s1] = cs[i + 1]
      bm = a0 + ((a1 - a0) * (i + 0.5)) / n
      const p00: V3 = [c[0] + c0 * r0, y + h0, c[1] + s0 * r0]
      const p01: V3 = [c[0] + c1 * r0, y + h0, c[1] + s1 * r0]
      const p10: V3 = [c[0] + c0 * r1, y + h1, c[1] + s0 * r1]
      const p11: V3 = [c[0] + c1 * r1, y + h1, c[1] + s1 * r1]
      const n00: V3 = [c0 * lo[0], lo[1], s0 * lo[0]]
      const n01: V3 = [c1 * lo[0], lo[1], s1 * lo[0]]
      const n10: V3 = [c0 * hi[0], hi[1], s0 * hi[0]]
      const n11: V3 = [c1 * hi[0], hi[1], s1 * hi[0]]
      w.triN(p00, p01, p11, n00, n01, n11)
      w.triN(p00, p11, p10, n00, n11, n10)
    }
  }
  if (own) w.uvOf = null
}

/** 圆柱（或圆台）：自 y0 到 y1，半径 r0 → r1，光滑法线；top 为真时封顶 */
export function tube(w: Writer, c: P, r0: number, r1: number, y0: number, y1: number, n = 12, top = false) {
  lathe(w, c, y0, top ? [[r0, 0], [r1, y1 - y0], [0, y1 - y0]] : [[r0, 0], [r1, y1 - y0]], n)
}

/** 半球穹顶（光滑法线），k 为竖向拉伸（洋葱顶、尖顶 > 1） */
export function dome(w: Writer, c: P, r: number, y: number, col: RGB, n = 16, rings = 6, k = 1) {
  w.c = col
  w.face = w.face === MAT.metal || w.face === MAT.glaze || w.face === MAT.gilt ? w.face : 0
  const prof: [number, number][] = []
  for (let j = 0; j <= rings; j++) {
    const a = (j / rings) * Math.PI * 0.5
    prof.push([j === rings ? 0 : Math.cos(a) * r, Math.sin(a) * r * k])
  }
  lathe(w, c, y, prof, n)
}

/** 圆锥顶（侧面光滑） */
export function cone(w: Writer, c: P, r: number, y: number, h: number, col: RGB, n = 12) {
  w.c = col
  w.face = w.roofFace
  lathe(w, c, y, [[r, 0], [0, h]], n)
  // 檐口的底面：出檐下朝下的一圈
  w.c = shade(col, 0.5)
  w.face = MAT.plain
  lathe(w, c, y, [[r * 0.72, 0], [r, 0]], n)
}

export const circle = (c: P, r: number, n: number, phase = 0): P[] => Array.from({ length: n }, (_, i) => [c[0] + Math.cos(phase + (i / n) * Math.PI * 2) * r, c[1] + Math.sin(phase + (i / n) * Math.PI * 2) * r] as P)

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

/** 斜板：沿 a→b 的条，两端顶面高 ya、yb，厚 th（桥面、飞扶壁） */
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
