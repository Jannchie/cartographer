/**
 * 聚落 → 沙盘体块：建筑（按文明与类别的屋顶）、城墙与塔楼城门、院墙、桥、码头、船。
 * 纯函数，不依赖 three.js 与 DOM，在 Worker 中运行（见 ui/settlement/history.worker.ts）。
 *
 * 生成器只给出平面、类别、屋脊方向与民居层数，高度与屋顶形式在这里按"文明 × 类别 × 尺寸"推导：
 * 组合地标（教堂、寺院、清真寺）被拆成互相重叠的矩形，体块叠加后即得到高低错落的剖面。
 */
import { centroid, type P } from '../../settlement/geom'
import type { Life } from '../../settlement/history'
import { eastAsian } from '../../settlement/culture'
import { settleTheme } from '../../settlement/themes'
import type { Building, Culture, Settlement, Wall } from '../../settlement/types'
import { MAT, NEVER, WIN, Writer, at, cap, circle, cone, coping, dome, fence, flat, frameOf, gable, hip, irimoya, merlons, plinth, prism, rectOf, shade, slab, strip, v3, wallSegment, walls, type Frame, type RGB, type TownChunk } from './mesh'
import { facades, type Facade } from './facade'
import { treeInstances, type TreeSet } from './vegetation'
import { terrainMesh, type TerrainMesh } from './relief'

/** Worker 回传的沙盘数据（数组均可转移） */
export interface TownBuild {
  chunks: TownChunk[]
  trees: TreeSet[]
  terrain: TerrainMesh
  /** 三角形总数 */
  tris: number
  /** 构建耗时（毫秒） */
  ms: number
}

type Height = (x: number, z: number) => number

/** 地面高程：地形格网双线性插值（米） */
export function heightSampler(t: Settlement['terrain']): Height {
  const { W, H, cell, height } = t
  return (x, z) => {
    const fx = Math.min(W - 1.001, Math.max(0, x / cell))
    const fz = Math.min(H - 1.001, Math.max(0, z / cell))
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const u = fx - i
    const v = fz - j
    const k = j * W + i
    return (height[k] * (1 - u) + height[k + 1] * u) * (1 - v) + (height[k + W] * (1 - u) + height[k + W + 1] * u) * v
  }
}

const hex = (s: string): RGB => {
  const n = parseInt(s.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const pick = <T>(arr: readonly T[], t: number) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))]
/** 由色调派生的第二个随机数 */
const frac = (x: number) => x - Math.floor(x)

/** 各文明的墙色（抹灰、石、土坯、白壁） */
const WALL: Record<Culture, RGB[]> = {
  western: ['#e9dfc8', '#ddd0b4', '#cdbf9f', '#efe6d2', '#d9c7a8'].map(hex),
  eastern: ['#b9b2a6', '#c6bfb2', '#a9a196', '#cfc6b6'].map(hex),
  wa: ['#ece6d8', '#e4dccb', '#8d6f52', '#7a5f45'].map(hex),
  islamic: ['#e3d3b1', '#dccaa4', '#e8dbbd', '#d6c39b'].map(hex),
}
const STONE = hex('#a69f94')
const STONE_DARK = hex('#7f786f')
const STONE_EAST = hex('#8e8d88')
const ADOBE = hex('#c9a77a')
const TIMBER = hex('#6b5a48')
const TIMBER_DARK = hex('#4a3d31')
const VERMILION = hex('#c8412a')
const LACQUER = hex('#9b2f22')
const PLASTER = hex('#f1ede3')
const TILE_DARK = hex('#565a60')
const COPPER = hex('#7f9a8a')
const BRICK = hex('#8a5a44')
const GOLD = hex('#c9a24a')

type Palette = ReturnType<ReturnType<typeof settleTheme>['buildings']>

interface Ctx {
  w: Writer
  culture: Culture
  east: boolean
  pal: Palette
  H: Height
  storey: number
  capital: boolean
}

/**
 * 由成长史构建全部体块、树与地形网格（历史上出现过的一切，每样带生卒）。
 * 网格按块（约 8 × 8）切分，供视锥裁剪；块的大小不随城市规模变化太多
 */
export function buildTown(st: Settlement, life: Map<object, Life>): TownBuild {
  const t0 = performance.now()
  const culture = st.params.culture
  const nx = Math.max(1, Math.min(10, Math.round(st.width / 400)))
  const nz = Math.max(1, Math.min(10, Math.round(st.height / 400)))
  const w = new Writer(st.width, st.height, nx, nz)
  const c: Ctx = {
    w,
    culture,
    east: eastAsian(culture),
    pal: settleTheme('color').buildings(culture),
    H: heightSampler(st.terrain),
    storey: eastAsian(culture) ? 3.4 : 3.1,
    capital: !!st.params.capital,
  }
  const setLife = (x: object) => {
    const l = life.get(x)
    w.begin(l?.born ?? 0, l && l.died !== Infinity ? l.died : NEVER)
  }
  const fac = facades(st, life)
  st.buildings.forEach((b, i) => {
    setLife(b)
    const ct = centroid(b.poly)
    w.at(ct[0], ct[1])
    w.id = i
    building(c, b, fac[i])
  })
  w.id = -1
  for (const wall of st.walls) {
    setLife(wall)
    cityWall(c, wall)
  }
  for (const e of st.enclosures) {
    setLife(e)
    enclosure(c, e)
  }
  for (const x of st.crossings) {
    setLife(x)
    crossing(c, x)
  }
  for (const p of st.piers) {
    setLife(p)
    const ct = centroid(p)
    w.at(ct[0], ct[1])
    w.base = -1
    w.c = culture === 'wa' || culture === 'eastern' ? TIMBER : STONE
    w.face = culture === 'wa' || culture === 'eastern' ? MAT.board : MAT.stone
    prism(w, p, -1.2, 0.9)
  }
  for (const b of st.boats) {
    setLife(b)
    boat(c, b)
  }
  const chunks = w.finish()
  const trees = treeInstances(st, life, c.H)
  return { chunks, trees, terrain: terrainMesh(st), tris: chunks.reduce((s, k) => s + k.ids.length, 0), ms: performance.now() - t0 }
}

/** 颜色的明度（0~1）：深色屋面用石板瓦 */
const lum = (c: RGB) => (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255

/**
 * 墙面材质：西式民居多为抹灰或露明木构架，少数石砌；公共建筑、大宅石砌；
 * 东方青砖，和式真壁，伊斯兰抹灰（土坯外抹一层）
 */
function wallMat(culture: Culture, kind: Building['kind'], t: number): number {
  if (culture === 'western') {
    if (kind === 'house') return t < 0.38 ? MAT.timber : t < 0.86 ? MAT.plaster : MAT.stone
    if (kind === 'large') return t < 0.5 ? MAT.stone : MAT.plaster
    if (kind === 'shed') return MAT.board
    return MAT.stone
  }
  if (kind === 'shed') return culture === 'islamic' ? MAT.plaster : MAT.board
  return culture === 'eastern' ? MAT.brick : culture === 'wa' ? MAT.wa : MAT.plaster
}

function building(c: Ctx, b: Building, fac: Facade) {
  const { w, culture, east, pal, H, storey } = c
  const poly = b.poly
  // 地基：脚下最低处往下埋 0.6 米，墙顶按最高处算（坡地上的房子不悬空）
  let g0 = Infinity
  let g1 = -Infinity
  for (const p of poly) {
    const h = H(p[0], p[1])
    g0 = Math.min(g0, h)
    g1 = Math.max(g1, h)
  }
  const base = g0 - 0.6
  w.base = base
  const tone = b.tone
  const tone2 = frac(tone * 7.31 + 0.17)
  const roofCol = b.kind === 'torii' ? VERMILION : hex(pick(pal[b.kind], tone))
  const wallCol = pick(WALL[culture], tone2)
  const round = poly.length >= 8
  const f = frameOf(poly, b.ridge)
  const floors = b.floors ?? 1
  const k = culture === 'western' ? 0.82 + tone2 * 0.28 : culture === 'wa' ? 0.55 : culture === 'eastern' ? 0.6 : 0
  const over = east ? 0.9 : 0.35
  const prof = east ? 'curved' : 'straight'
  const wm = wallMat(culture, b.kind, tone2)
  w.face = 0
  w.roofFace = east ? MAT.tileEast : lum(roofCol) < 0.3 ? MAT.slate : MAT.tile
  w.gableFace = wm
  w.roofTh = east ? 0.32 : 0.16

  switch (b.kind) {
    case 'torii': {
      w.c = VERMILION
      const top = g1 + 4.5
      for (const s of [-0.36, 0.36]) walls(w, circle(at(f, s * f.a * 2, 0), 0.25, 6), base, top)
      const beam = [at(f, -f.a * 1.1, -0.3), at(f, f.a * 1.1, -0.3), at(f, f.a * 1.1, 0.3), at(f, -f.a * 1.1, 0.3)]
      w.c = TIMBER_DARK
      prism(w, beam, top - 0.45, top)
      w.c = VERMILION
      const tie = [at(f, -f.a * 0.9, -0.2), at(f, f.a * 0.9, -0.2), at(f, f.a * 0.9, 0.2), at(f, -f.a * 0.9, 0.2)]
      prism(w, tie, top - 1.4, top - 1.0)
      return
    }
    case 'shed': {
      const y = g1 + 2.4
      const col = wm === MAT.board ? TIMBER : wallCol
      w.c = col
      w.face = wm | WIN
      walls(w, poly, base, y, { win: [], door: fac.door })
      w.face = 0
      w.roofTh = 0.1
      if (culture === 'islamic') flat(w, f, y, roofCol, wallCol, 0.3)
      else gable(w, f, y, Math.max(0.35, k * 0.7), 0.25, roofCol, col)
      return
    }
    case 'pagoda':
      return pagoda(c, f, base, g1, roofCol, wallCol)
    case 'keep':
      return keep(c, b, f, base, g1, roofCol, wallCol)
    case 'tower':
      return tower(c, b, f, base, g1, roofCol, wallCol)
    case 'magic': {
      const ct = centroid(poly)
      const r = Math.max(f.a, f.b)
      const top = g1 + 30
      w.c = hex('#cfc7e6')
      walls(w, poly, base, top)
      cone(w, ct, r * 1.2, top, r * 3, roofCol)
      return
    }
  }

  // 民居、大宅、厅堂、公共建筑、宗教建筑
  let top: number
  if (b.kind === 'temple') {
    // 西式教堂按部件宽窄定高（宽的中殿高、窄的侧廊低）；东亚寺社是台基上的单层大屋顶；伊斯兰礼拜殿平顶
    top = g1 + (culture === 'western' ? Math.min(28, 6 + f.b * 1.2) : culture === 'islamic' ? 9 : 5 + f.b * 0.22)
  } else if (b.kind === 'hall' || b.kind === 'civic' || b.kind === 'large') top = g1 + Math.max(1, floors) * storey + (b.kind === 'hall' ? 2 : 0.5)
  else top = g1 + Math.max(1, floors) * storey

  // 东亚的殿堂立在台基上
  let foot = base
  if (east && (b.kind === 'temple' || b.kind === 'hall')) {
    const plinth = Math.min(1.6, 0.5 + f.b * 0.08)
    w.c = STONE
    prism(w, rectOf(f, 1.2), base, g1 + plinth)
    foot = g1 + plinth
    top += plinth
  }
  // 勒脚：墙脚外凸的一圈石砌（东亚殿堂已在台基上）
  if (!round && foot === base) {
    w.c = culture === 'islamic' ? shade(wallCol, 0.82) : culture === 'eastern' ? STONE_EAST : STONE
    w.face = MAT.stone
    plinth(w, poly, base, g0 + (culture === 'wa' ? 0.35 : 0.5), 0.07)
  }
  w.c = b.kind === 'temple' && east ? LACQUER : wallCol
  // 开窗的立面：民居、大宅、厅堂、公共建筑（窗与门在着色器里按层高、开间排，哪面开窗、哪面开门见 facade.ts）
  w.face = b.kind === 'temple' ? (east ? MAT.plain : MAT.stone) : wm | WIN
  walls(w, poly, foot, top, fac)
  w.face = 0
  if (round) {
    const ct = centroid(poly)
    const r = Math.max(f.a, f.b)
    if (culture === 'islamic') dome(w, ct, r, top, roofCol)
    else cone(w, ct, r * 1.05, top, r * (b.kind === 'temple' ? 0.9 : 0.8), roofCol, 16)
    return
  }
  if (culture === 'islamic') {
    flat(w, f, top, wallCol, wallCol, b.kind === 'temple' ? 1 : 0.7)
    return
  }
  const sq = Math.abs(f.a - f.b) < 0.6
  if (culture === 'western') {
    if (b.kind === 'house' || b.kind === 'civic') {
      gable(w, f, top, k, over, roofCol, wallCol)
      // 烟囱：多数民居有一个，落在屋脊一侧
      if (tone2 > 0.35 && f.a > 2.5) {
        const ct = at(f, f.a * (tone > 0.5 ? 0.55 : -0.55), f.b * 0.35)
        const ch = top + f.b * k + 0.9
        w.c = BRICK
        w.face = MAT.brick
        walls(w, rectOf({ ...f, c: ct, a: 0.45, b: 0.45 }), top, ch)
        // 烟囱帽：外挑的一圈压顶，上面两个烟囱管
        w.c = STONE
        w.face = MAT.plain
        prism(w, rectOf({ ...f, c: ct, a: 0.55, b: 0.55 }), ch, ch + 0.14)
        w.c = shade(BRICK, 0.75)
        for (const s of [-0.18, 0.18]) prism(w, rectOf({ ...f, c: at({ ...f, c: ct }, s, 0), a: 0.11, b: 0.11 }), ch + 0.14, ch + 0.42)
        w.face = 0
      }
    } else if (sq) hip(w, f, top, b.kind === 'temple' ? 1.6 : k, over, roofCol)
    else if (b.kind === 'temple') gable(w, f, top, 1.05, over, roofCol, wallCol)
    else hip(w, f, top, k, over, roofCol)
    return
  }
  // 东亚：民居两坡（曲面），大宅、殿堂歇山 / 入母屋，屋脊加脊
  if (b.kind === 'house' || b.kind === 'civic' || (b.kind === 'large' && culture === 'eastern' && f.b < 5)) {
    gable(w, f, top, k, over, roofCol, wallCol, prof)
    return
  }
  const kk = k * 1.1
  const oo = over * (b.kind === 'temple' ? 1.8 : 1.4)
  irimoya(w, f, top, kk, oo, roofCol, culture === 'wa' ? PLASTER : wallCol, prof)
  ridgeBeam(w, f, top + f.b * kk, Math.max(0.35, f.b * 0.06), roofCol)
}

/** 屋脊：沿屋脊的一道矮条（东亚殿堂的正脊），两端略高（鸱吻） */
function ridgeBeam(w: Writer, f: Frame, y: number, h: number, col: RGB) {
  const d: RGB = [Math.round(col[0] * 0.7), Math.round(col[1] * 0.7), Math.round(col[2] * 0.7)]
  w.c = d
  const r = Math.max(0.5, f.a - f.b * 0.55)
  const bar = [at(f, -r, -h * 0.5), at(f, r, -h * 0.5), at(f, r, h * 0.5), at(f, -r, h * 0.5)]
  prism(w, bar, y - h, y + h * 0.6)
  for (const s of [-1, 1]) prism(w, rectOf({ ...f, c: at(f, s * r, 0), a: h * 0.6, b: h * 0.5 }), y, y + h * 1.8)
}

/** 层塔：东方七层、和式五层，逐层收分，每层一圈四坡出檐，塔刹 */
function pagoda(c: Ctx, f: Frame, base: number, g1: number, roof: RGB, wall: RGB) {
  const { w, culture } = c
  w.roofFace = MAT.tileEast
  w.roofTh = 0.35
  const tiers = culture === 'wa' ? 5 : 7
  const r0 = Math.min(f.a, f.b)
  const sq: Frame = { ...f, a: r0, b: r0 }
  w.c = STONE
  prism(w, rectOf(sq, r0 * 0.15), base, g1 + 1)
  let y = g1 + 1
  for (let i = 0; i < tiers; i++) {
    const s = 1 - (i / tiers) * 0.45
    const t: Frame = { ...sq, a: r0 * s * 0.8, b: r0 * s * 0.8 }
    const hgt = i === 0 ? 4 : 2.6
    w.c = culture === 'wa' ? PLASTER : wall
    walls(w, rectOf(t), y, y + hgt)
    y += hgt
    hip(w, { ...t, a: t.a + 1.2, b: t.b + 1.2 }, y, 0.35, 0.5, roof, 'curved')
    y += 0.6
  }
  w.c = GOLD
  walls(w, circle(sq.c, 0.25, 6), y, y + r0 * 1.2)
}

/** 天守：石垣 + 逐层收分的白壁层 + 每层出檐，顶层入母屋 */
function tenshu(c: Ctx, f: Frame, base: number, g1: number, roof: RGB) {
  const { w } = c
  const ish = 8
  w.roofFace = MAT.tileEast
  w.gableFace = MAT.plaster
  w.roofTh = 0.35
  w.c = STONE
  w.face = MAT.stone
  // 石垣：上小下大
  const lo = rectOf(f, Math.max(f.a, f.b) * 0.2)
  const hi = rectOf(f, Math.max(f.a, f.b) * 0.08)
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    w.quad(v3(lo[j], base), v3(lo[i], base), v3(hi[i], g1 + ish), v3(hi[j], g1 + ish))
  }
  cap(w, hi, g1 + ish)
  let y = g1 + ish
  const tiers = 5
  for (let i = 0; i < tiers; i++) {
    const s = 1 - (i / tiers) * 0.55
    const t: Frame = { ...f, a: f.a * s, b: f.b * s }
    w.c = PLASTER
    w.face = MAT.plaster | WIN
    walls(w, rectOf(t), y, y + 3.6)
    w.face = MAT.plaster
    y += 3.6
    if (i === tiers - 1) irimoya(w, t, y, 0.6, 1.2, roof, PLASTER, 'curved')
    else hip(w, { ...t, a: t.a + 1, b: t.b + 1 }, y, 0.45, 0.5, roof, 'curved')
    y += 0.4
  }
}

function keep(c: Ctx, b: Building, f: Frame, base: number, g1: number, roof: RGB, wall: RGB) {
  const { w, culture, east } = c
  if (culture === 'wa') return tenshu(c, f, base, g1, roof)
  w.face = culture === 'western' ? MAT.stone : east ? MAT.plain : MAT.plaster
  w.gableFace = w.face
  const poly = b.poly
  if (poly.length >= 8 && (culture === 'islamic' || culture === 'western')) {
    // 十字交叉处的穹顶、圆塔
    const ct = centroid(poly)
    const r = Math.max(f.a, f.b)
    const top = g1 + (culture === 'western' ? 26 : 14)
    w.c = wall
    walls(w, poly, base, top)
    dome(w, ct, r, top, culture === 'western' ? COPPER : roof, 18, 6, culture === 'islamic' ? 1.15 : 1)
    if (culture === 'western') {
      w.c = wall
      walls(w, circle(ct, r * 0.22, 8), top + r * 0.95, top + r * 1.35)
      cone(w, ct, r * 0.28, top + r * 1.35, r * 0.6, COPPER, 8)
    }
    return
  }
  const tall = culture === 'western' ? 24 : culture === 'islamic' ? 15 : 8
  const top = g1 + tall
  if (east) {
    // 宫殿正殿：两层台基 + 重檐庑殿
    w.c = STONE
    prism(w, rectOf(f, 4), base, g1 + 1.2)
    prism(w, rectOf(f, 2), g1 + 1.2, g1 + 2.4)
    w.c = LACQUER
    walls(w, poly, g1 + 2.4, top)
    hip(w, { ...f, a: f.a + 1.5, b: f.b + 1.5 }, top - 3, 0.3, 0.9, roof, 'curved')
    w.c = LACQUER
    walls(w, rectOf(f, -0.8), top - 3 + 0.4, top + 0.6)
    hip(w, { ...f, a: f.a - 0.8, b: f.b - 0.8 }, top + 0.6, 0.62, 1.4, roof, 'curved')
    ridgeBeam(w, { ...f, a: f.a - 0.8, b: f.b - 0.8 }, top + 0.6 + (f.b - 0.8) * 0.62, Math.max(0.4, f.b * 0.05), roof)
    return
  }
  // 西式城堡主楼、伊斯兰的城堡：方楼平顶加雉堞
  w.c = culture === 'western' ? STONE : wall
  walls(w, poly, base, top)
  const crown = culture === 'western' ? STONE : wall
  flat(w, f, top, STONE_DARK, crown, 0.9)
  const r = rectOf(f)
  for (let i = 0; i < 4; i++) {
    const a = r[i]
    const bb = r[(i + 1) % 4]
    const L = Math.hypot(bb[0] - a[0], bb[1] - a[1]) || 1
    // rectOf 的绕向使左手法线朝内
    const inward: P = [-(bb[1] - a[1]) / L, (bb[0] - a[0]) / L]
    merlons(w, a, bb, top + 0.9, top + 0.9, inward, 0.35, 0.8, 2.2)
  }
}

function tower(c: Ctx, b: Building, f: Frame, base: number, g1: number, roof: RGB, wall: RGB) {
  const { w, culture, east } = c
  w.face = culture === 'western' ? MAT.stone : culture === 'eastern' ? MAT.brick : MAT.plaster
  w.gableFace = culture === 'wa' ? MAT.plaster : w.face
  if (culture === 'western') w.roofFace = MAT.slate
  const poly = b.poly
  const round = poly.length >= 8
  if (culture === 'islamic') {
    // 宣礼塔：细高的柱身 + 阳台 + 小穹顶
    const ct = f.c
    const r = Math.min(f.a, f.b)
    const top = g1 + Math.max(18, r * 9)
    w.c = wall
    walls(w, poly, base, top)
    cap(w, poly, top)
    w.c = wall
    prism(w, circle(ct, r * 1.25, 10), top - 3, top - 2.4)
    walls(w, circle(ct, r * 0.6, 8), top, top + 1.4)
    dome(w, ct, r * 0.7, top + 1.4, roof, 10, 4, 1.3)
    return
  }
  const top = g1 + (east ? 9 : 16 + frac(b.tone * 3.7) * 8)
  w.c = culture === 'western' ? STONE : wall
  walls(w, poly, base, top)
  if (round) cone(w, centroid(poly), Math.max(f.a, f.b) * 1.15, top, Math.max(f.a, f.b) * 2.4, roof)
  else if (culture === 'western') hip(w, { ...f, a: Math.max(f.a, f.b), b: Math.max(f.a, f.b) }, top, 2.4, 0.3, roof)
  else if (culture === 'wa') irimoya(w, f, top, 0.6, 1.0, roof, PLASTER, 'curved')
  else hip(w, f, top, 0.6, 0.9, roof, 'curved')
}

/** 城墙：按段拉成墙体（城门处断开、墙顶随地形、雉堞），塔楼，门楼 */
function cityWall(c: Ctx, wall: Wall) {
  const { w, culture, H } = c
  const stone = wall.kind === 'stone'
  const hgt = stone ? (culture === 'eastern' ? 11 : culture === 'wa' ? 7 : 9) : 4.5
  const th = wall.thickness
  const col = stone ? (culture === 'eastern' ? STONE_EAST : culture === 'islamic' ? ADOBE : STONE) : TIMBER
  const n = wall.loop.length
  const gap = stone ? 7 : 5
  const near = (p: P) => wall.gates.some((g) => Math.hypot(g.p[0] - p[0], g.p[1] - p[1]) < 0.5)
  // 环的绕向：左手法线朝外还是朝内（雉堞立在外沿）
  let a2 = 0
  for (let i = 0; i < n; i++) {
    const q = wall.loop[(i + 1) % n]
    a2 += wall.loop[i][0] * q[1] - q[0] * wall.loop[i][1]
  }
  const outSign = a2 > 0 ? -1 : 1
  const crenel = stone && culture !== 'wa'
  w.face = !stone ? MAT.board : culture === 'islamic' ? MAT.plaster : culture === 'eastern' ? MAT.brick : MAT.stone
  w.roofFace = culture === 'western' ? MAT.slate : MAT.tileEast
  w.gableFace = culture === 'wa' ? MAT.plaster : w.face
  w.base = -1.5
  for (let i = 0; i < n; i++) {
    if (!wall.solid[i]) continue
    let a = wall.loop[i]
    let b = wall.loop[(i + 1) % n]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 0.1) continue
    const cut = Math.min(0.45, gap / L)
    if (near(a)) a = [a[0] + (b[0] - a[0]) * cut, a[1] + (b[1] - a[1]) * cut]
    if (near(b)) b = [b[0] + (a[0] - b[0]) * cut, b[1] + (a[1] - b[1]) * cut]
    const ux = (b[0] - a[0]) / L
    const uz = (b[1] - a[1]) / L
    // 外沿方向
    const ox = -uz * outSign
    const oz = ux * outSign
    // 长段按 12 米切开，墙顶跟着地形走
    const segs = Math.max(1, Math.ceil(L / 12))
    for (let s = 0; s < segs; s++) {
      const p: P = [a[0] + (b[0] - a[0]) * (s / segs), a[1] + (b[1] - a[1]) * (s / segs)]
      const q: P = [a[0] + (b[0] - a[0]) * ((s + 1) / segs), a[1] + (b[1] - a[1]) * ((s + 1) / segs)]
      w.at(p[0], p[1])
      const hp = H(p[0], p[1])
      const hq = H(q[0], q[1])
      w.c = col
      wallSegment(w, p, q, th / 2, Math.min(hp, hq) - 1.5, hp + hgt, hq + hgt)
      if (crenel) {
        const e = th / 2
        merlons(w, [p[0] + ox * e, p[1] + oz * e], [q[0] + ox * e, q[1] + oz * e], hp + hgt, hq + hgt, [-ox, -oz], 0.6, 1.1, 3)
      }
    }
  }
  const tr = stone ? th * 1.25 : th * 1.3
  for (const t of wall.towers) {
    w.at(t[0], t[1])
    const g = H(t[0], t[1])
    w.c = col
    if (stone && culture === 'western') {
      const ring = circle(t, tr, 12)
      walls(w, ring, g - 1.5, g + hgt + 3)
      cone(w, t, tr * 1.15, g + hgt + 3, tr * 2, hex('#7d6a5c'), 12)
    } else if (stone && (culture === 'eastern' || culture === 'wa')) {
      // 敌台（马面）上的小楼
      const ring = circle(t, tr * 1.2, 4)
      prism(w, ring, g - 1.5, g + hgt + 0.5)
      const f: Frame = { c: t, u: [1, 0], v: [0, 1], a: tr * 0.6, b: tr * 0.6 }
      w.c = culture === 'wa' ? PLASTER : LACQUER
      walls(w, rectOf(f), g + hgt + 0.5, g + hgt + 3.5)
      hip(w, f, g + hgt + 3.5, 0.55, 0.9, TILE_DARK, 'curved')
    } else {
      const ring = circle(t, tr * 1.2, 4)
      prism(w, ring, g - 1.5, g + hgt + 3)
    }
  }
  for (const gt of wall.gates) {
    w.at(gt.p[0], gt.p[1])
    const g = H(gt.p[0], gt.p[1])
    const u: P = [Math.cos(gt.angle), Math.sin(gt.angle)]
    const v: P = [-u[1], u[0]]
    const s = stone ? 1 : 0.7
    // 门楼：门洞两侧的墩 + 跨过门洞的楼
    w.c = col
    for (const side of [-1, 1]) {
      const ct: P = [gt.p[0] + v[0] * (gap + 2.5 * s) * side, gt.p[1] + v[1] * (gap + 2.5 * s) * side]
      prism(w, rectOf({ c: ct, u, v, a: 5 * s, b: 3 * s }), g - 1.5, g + hgt + 2)
    }
    if (!stone) continue
    const f: Frame = { c: gt.p, u: v, v: [-u[0], -u[1]], a: gap + 5 * s, b: 5 * s }
    const ring = rectOf(f)
    w.c = col
    walls(w, ring, g + 5, g + hgt + 2)
    // 门洞顶
    const under = [...ring].reverse()
    for (let i = 1; i < 3; i++) w.tri(v3(under[0], g + 5), v3(under[i], g + 5), v3(under[i + 1], g + 5))
    if (culture === 'eastern' || culture === 'wa') {
      // 城楼：重檐歇山
      cap(w, ring, g + hgt + 2)
      const hall: Frame = { ...f, a: f.a * 0.8, b: f.b * 0.75 }
      w.c = culture === 'wa' ? PLASTER : LACQUER
      walls(w, rectOf(hall), g + hgt + 2, g + hgt + 6)
      irimoya(w, hall, g + hgt + 6, 0.6, 1.6, TILE_DARK, culture === 'wa' ? PLASTER : LACQUER, 'curved')
    } else {
      flat(w, f, g + hgt + 2, STONE_DARK, col, 1)
      if (culture === 'western') for (const sg of [-1, 1]) merlons(w, at(f, -f.a, f.b * sg), at(f, f.a, f.b * sg), g + hgt + 3, g + hgt + 3, [-f.v[0] * sg, -f.v[1] * sg], 0.35, 0.8, 2.2)
    }
  }
}

/** 院墙：沿环拉成矮墙（东亚加墙帽瓦） */
function enclosure(c: Ctx, ring: P[]) {
  const { w, culture, H } = c
  if (ring.length < 3) return
  const hgt = culture === 'eastern' ? 2.6 : culture === 'islamic' ? 2.8 : culture === 'wa' ? 2.1 : 1.8
  w.face = culture === 'wa' || culture === 'islamic' ? MAT.plaster : culture === 'eastern' ? MAT.brick : MAT.stone
  w.base = -0.5
  w.c = culture === 'wa' ? PLASTER : culture === 'eastern' ? hex('#b8b0a2') : culture === 'islamic' ? hex('#dccaa4') : STONE
  const r = fence(w, ring, 0.3, (p) => H(p[0], p[1]) - 0.5, (p) => H(p[0], p[1]) + hgt)
  // 东亚院墙的墙帽：出檐的小两坡瓦顶
  if (culture === 'wa' || culture === 'eastern') {
    w.c = TILE_DARK
    w.face = MAT.tileEast
    coping(w, r, 0.6, (p) => H(p[0], p[1]) + hgt - 0.05, 0.32, 0.06, shade(TILE_DARK, 0.55))
  }
}

/** 桥：桥面按跨度起拱，两侧栏杆，长桥加桥墩；神桥为朱漆拱桥；渡口放一条渡船 */
function crossing(c: Ctx, x: Settlement['crossings'][number]) {
  const { w, culture, H } = c
  const L = Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1])
  if (L < 1) return
  const mid: P = [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2]
  w.at(mid[0], mid[1])
  w.face = x.sacred || culture === 'wa' ? MAT.board : culture === 'islamic' ? MAT.plaster : MAT.stone
  if (x.kind === 'ford') return
  if (x.kind === 'ferry') {
    boat(c, { p: mid, angle: Math.atan2(x.b[1] - x.a[1], x.b[0] - x.a[0]) + Math.PI / 2, len: 9 })
    return
  }
  const ya = Math.max(H(x.a[0], x.a[1]), 0.3) + 0.5
  const yb = Math.max(H(x.b[0], x.b[1]), 0.3) + 0.5
  const rise = Math.min(x.sacred ? L * 0.22 : L * 0.08, x.sacred ? 5 : 3.5)
  const half = Math.max(1.2, x.width / 2)
  const col = x.sacred ? VERMILION : culture === 'wa' ? TIMBER : culture === 'eastern' ? STONE_EAST : culture === 'islamic' ? ADOBE : STONE
  const n = Math.max(4, Math.min(16, Math.ceil(L / 4)))
  const yAt = (t: number) => ya + (yb - ya) * t + rise * 4 * t * (1 - t)
  const pt = (t: number): P => [x.a[0] + (x.b[0] - x.a[0]) * t, x.a[1] + (x.b[1] - x.a[1]) * t]
  w.base = Math.min(ya, yb) - 2
  const dx = (x.b[0] - x.a[0]) / L
  const dz = (x.b[1] - x.a[1]) / L
  for (let i = 0; i < n; i++) {
    const t0 = i / n
    const t1 = (i + 1) / n
    const p = pt(t0)
    const q = pt(t1)
    const y0 = yAt(t0)
    const y1 = yAt(t1)
    w.c = col
    slab(w, p, q, half, y0, y1, 0.8)
    // 栏杆
    for (const sgn of [-1, 1]) {
      const o = (half - 0.15) * sgn
      const off = (r: P): P => [r[0] - dz * o, r[1] + dx * o]
      wallSegment(w, off(p), off(q), 0.15, Math.min(y0, y1) - 0.1, y0 + 0.9, y1 + 0.9)
    }
  }
  // 桥墩：长桥每 15 米一个
  if (L > 24 && !x.sacred) {
    const piers = Math.floor(L / 15)
    w.c = col
    for (let i = 1; i <= piers; i++) {
      const t = i / (piers + 1)
      const p = pt(t)
      const f = frameOf(strip(pt(t - 0.5 / L), pt(t + 0.5 / L), half * 0.9), Math.atan2(x.b[1] - x.a[1], x.b[0] - x.a[0]))
      prism(w, rectOf(f), Math.min(H(p[0], p[1]), -1) - 1, yAt(t) - 0.8)
    }
  }
}

/** 船：尖头的船体 + 甲板，长船加桅杆 */
function boat(c: Ctx, b: { p: P; angle: number; len: number }) {
  const { w, culture } = c
  w.at(b.p[0], b.p[1])
  w.base = -0.4
  w.face = MAT.board
  const L = b.len / 2
  const Wd = Math.max(0.8, b.len * 0.16)
  const u: P = [Math.cos(b.angle), Math.sin(b.angle)]
  const f: Frame = { c: b.p, u, v: [-u[1], u[0]], a: L, b: Wd }
  const hull: P[] = [at(f, L, 0), at(f, L * 0.55, Wd), at(f, -L * 0.85, Wd * 0.9), at(f, -L, Wd * 0.5), at(f, -L, -Wd * 0.5), at(f, -L * 0.85, -Wd * 0.9), at(f, L * 0.55, -Wd)]
  w.c = culture === 'islamic' ? hex('#8a6a48') : TIMBER_DARK
  walls(w, hull, -0.4, 0.5)
  w.c = hex('#a08560')
  cap(w, hull, 0.5)
  if (b.len > 10) {
    w.c = TIMBER_DARK
    prism(w, circle(at(f, L * 0.1, 0), 0.15, 4), 0.5, 0.5 + b.len * 0.7)
  }
}
