/**
 * "中国"区域模板的数据（由 scripts/china-real.ts 生成，放在 public/china/）：
 * - grid.bin：等经纬度 1′ 的高程与海陆湖覆盖（ETOPO 2022、Natural Earth）
 * - admin.bin：省级与地级行政区、界线与海上断续线（DataV.GeoAtlas，已转为 WGS-84）
 * 气温、降水与生物群系仍取全球 5′ 栅格（real.ts）。
 */
import type { AdminBorder, AdminLayer, Label, Peak, Realm } from '../types'
import { fillRings, simplifyLine, type LonLatGrid } from './raster'
import { readPublicGz } from './real'
import type { MapProjection } from './region'

export interface ChinaGrid {
  W: number
  H: number
  /** 西缘经度、北缘纬度（格的外缘），格距 1′ */
  lonW: number
  latN: number
  /** 高程（公里） */
  elev: Float32Array
  cover: Uint8Array
}

interface AdminUnit {
  code: number
  province: number
  zh: string
  full: string
  en: string
  ja: string
  seat: [number, number]
  rings: number[][]
}
export interface ChinaAdmin {
  provinces: { code: number; zh: string; full: string; en: string; ja: string; seat: [number, number] }[]
  units: AdminUnit[]
  lines: { k: AdminBorder['kind']; c: number[] }[]
  dashes: number[][]
  /** 山峰：经纬度 ×10⁵，高程（米） */
  peaks: { n: string; zh: string; ja: string; lon: number; lat: number; e: number }[]
}

let grid: ChinaGrid | null = null
let admin: ChinaAdmin | null = null

export async function loadChinaGrid(): Promise<ChinaGrid> {
  if (grid) return grid
  const buf = await readPublicGz('china/grid.bin')
  const head = new DataView(buf, 0, 28)
  if (String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3)) !== 'CHN1') throw new Error('中国区域数据格式不对')
  const W = head.getUint32(4, true)
  const H = head.getUint32(8, true)
  const N = W * H
  const de = new Int16Array(buf, 28, N)
  const elev = new Float32Array(N)
  for (let y = 0; y < H; y++) {
    let v = 0
    for (let x = 0; x < W; x++) {
      v += de[y * W + x]
      elev[y * W + x] = v / 1000
    }
  }
  grid = { W, H, lonW: head.getFloat64(12, true), latN: head.getFloat64(20, true), elev, cover: new Uint8Array(buf, 28 + 2 * N, N) }
  return grid
}

/** 坐标在文件里是经纬度 ×10⁵ 的整数 */
export async function loadChinaAdmin(): Promise<ChinaAdmin> {
  if (admin) return admin
  admin = JSON.parse(new TextDecoder().decode(await readPublicGz('china/admin.bin'))) as ChinaAdmin
  return admin
}

export const chinaGrid = () => {
  if (!grid) throw new Error('中国区域数据还没加载（先 await loadChinaGrid()）')
  return grid
}
export const chinaAdmin = () => {
  if (!admin) throw new Error('中国行政区划还没加载（先 await loadChinaAdmin()）')
  return admin
}

/** 1′ 栅格在 (lon, lat) 处的高程（双线性）与覆盖（最近格） */
export function sampleChina(g: ChinaGrid, lon: number, lat: number): { elev: number; cover: number } | null {
  const fx = (lon - g.lonW) * 60 - 0.5
  const fy = (g.latN - lat) * 60 - 0.5
  if (fx < 0 || fy < 0 || fx >= g.W - 1 || fy >= g.H - 1) return null
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const i = y0 * g.W + x0
  const e = g.elev
  const a = e[i] + (e[i + 1] - e[i]) * tx
  const b = e[i + g.W] + (e[i + g.W + 1] - e[i + g.W]) * tx
  return { elev: a + (b - a) * ty, cover: g.cover[Math.round(fy) * g.W + Math.round(fx)] }
}

/** 地图格坐标系下的"网格"：fillRings 按格心填充投影后的环 */
const cellGrid = (W: number, H: number): LonLatGrid => ({ W, H, lon0: -0.5, lat0: -0.5, dLon: 1, dLat: -1 })

/** 经纬度 ×10⁵ 的环 → 地图格坐标 */
const projectRing = (proj: MapProjection, r: number[]) => {
  const out = new Array<number>(r.length)
  for (let k = 0; k < r.length; k += 2) {
    const [x, y] = proj.toCell(r[k] / 1e5, r[k + 1] / 1e5)
    out[k] = x
    out[k + 1] = y
  }
  return out
}

/** 区域里离边最远的一格（标注省名用） */
function poleOf(mask: (i: number) => boolean, cells: number[], W: number): { x: number; y: number; room: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (const c of cells) {
    const x = c % W
    const y = (c - x) / W
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  const bw = x1 - x0 + 3
  const bh = y1 - y0 + 3
  const inside = new Uint8Array(bw * bh)
  for (const c of cells) if (mask(c)) inside[(Math.floor(c / W) - y0 + 1) * bw + (c % W) - x0 + 1] = 1
  const d = new Int32Array(bw * bh).fill(-1)
  const q: number[] = []
  for (let i = 0; i < inside.length; i++)
    if (inside[i] && (!inside[i - 1] || !inside[i + 1] || !inside[i - bw] || !inside[i + bw])) {
      d[i] = 0
      q.push(i)
    }
  let best = q[0] ?? 0
  for (let k = 0; k < q.length; k++) {
    const c = q[k]
    if (d[c] > d[best]) best = c
    for (const j of [c - 1, c + 1, c - bw, c + bw])
      if (inside[j] && d[j] < 0) {
        d[j] = d[c] + 1
        q.push(j)
      }
  }
  return { x: (best % bw) + x0 - 1, y: Math.floor(best / bw) + y0 - 1, room: Math.max(0, d[best]) }
}

/** 直辖市 */
const MUNICIPALITIES = new Set([110000, 120000, 310000, 500000])
/** 直辖市与特别行政区：城市注记已经写了同一个名字，省级区域不再标注 */
const CITY_PROVINCES = new Set([110000, 120000, 310000, 500000, 810000, 820000])

/**
 * 行政区划落到地图上：地级单位与省级行政区的栅格（陆地格里没被多边形盖住的——海岸线两套数据对不齐——
 * 归给 3 格以内最近的单位）、界线与断续线、省名（realms）与城市注记（省会、地级驻地）
 */
export function chinaAdminLayer(proj: MapProjection, W: number, H: number, elev: Float32Array): { admin: AdminLayer; realm: Int16Array; realms: Realm[]; labels: Label[]; peaks: Peak[] } {
  const a = chinaAdmin()
  const N = W * H
  const g = cellGrid(W, H)
  const unit = new Int16Array(N).fill(-1)
  a.units.forEach((u, ui) =>
    fillRings(
      u.rings.map((r) => projectRing(proj, r)),
      g,
      (i) => (unit[i] = ui),
    ),
  )
  // 海岸附近的陆地格：多源 BFS 从已归属的格向外扩 3 格（只扩到陆地上）
  {
    let front: number[] = []
    for (let i = 0; i < N; i++) if (unit[i] >= 0) front.push(i)
    for (let step = 0; step < 3 && front.length; step++) {
      const next: number[] = []
      for (const c of front) {
        const x = c % W
        for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
          if (j < 0 || j >= N || unit[j] >= 0 || elev[j] <= 0) continue
          unit[j] = unit[c]
          next.push(j)
        }
      }
      front = next
    }
  }
  const realm = new Int16Array(N).fill(-1)
  const cellsOf: number[][] = a.provinces.map(() => [])
  for (let i = 0; i < N; i++) {
    const u = unit[i]
    if (u < 0) continue
    const p = a.units[u].province
    realm[i] = p
    if (elev[i] > 0) cellsOf[p].push(i)
  }

  // 界线：投影后按 0.3 格化简
  const borders: AdminBorder[] = []
  for (const l of a.lines) {
    const pts = simplifyLine(projectRing(proj, l.c), 0.3)
    if (pts.length >= 4) borders.push({ kind: l.k, pts })
  }
  const claims = a.dashes.map((r) => projectRing(proj, r))

  // 城市注记：首都、省会、地级驻地（省直辖的县级单位权重更低）
  const labels: Label[] = []
  const capitalOf = new Map<number, number>()
  a.units.forEach((u) => {
    const [x, y] = proj.toCell(u.seat[0] / 1e5, u.seat[1] / 1e5)
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const pv = a.provinces[u.province]
    const isCap = Math.hypot(u.seat[0] - pv.seat[0], u.seat[1] - pv.seat[1]) < 5000
    const county = /县$/.test(u.full) || (/市$/.test(u.full) && Math.floor(u.code / 100) % 100 === 90)
    if (isCap) capitalOf.set(u.province, labels.length)
    // 首都与直辖市排在省会之前；全息沙盘上只给它们带引线标注
    const municipality = MUNICIPALITIES.has(pv.code)
    labels.push({
      kind: pv.code === 110000 ? 'capital' : 'city',
      name: u.en,
      zh: u.zh,
      ja: u.ja,
      x,
      y,
      angle: 0,
      weight: pv.code === 110000 ? 5e5 : municipality ? 1.5e5 : isCap ? 6e4 : county ? 1.5e3 : 4e3,
      span: 0,
      anno: municipality || undefined,
    })
  })

  // 省级行政区（realms）：省名放在离省界最远处；相邻省份配不同的颜色
  const adj = a.provinces.map(() => new Set<number>())
  for (let i = 0; i < N; i++) {
    const r = realm[i]
    if (r < 0) continue
    const x = i % W
    if (x < W - 1 && realm[i + 1] >= 0 && realm[i + 1] !== r) {
      adj[r].add(realm[i + 1])
      adj[realm[i + 1]].add(r)
    }
    if (i + W < N && realm[i + W] >= 0 && realm[i + W] !== r) {
      adj[r].add(realm[i + W])
      adj[realm[i + W]].add(r)
    }
  }
  const color: number[] = []
  const order = a.provinces.map((_, i) => i).sort((p, q) => cellsOf[q].length - cellsOf[p].length)
  for (const p of order) {
    const used = new Set([...adj[p]].map((q) => color[q]))
    let c = 0
    while (used.has(c)) c++
    color[p] = c % 8
  }
  const realms: Realm[] = a.provinces.map((pv, i) => {
    const cells = cellsOf[i]
    const pole = cells.length ? poleOf((c) => realm[c] === i && elev[c] > 0, cells, W) : { x: 0, y: 0, room: 0 }
    return {
      name: pv.en,
      zh: pv.zh,
      ja: pv.ja,
      color: color[i] ?? 0,
      x: pole.x,
      y: pole.y,
      capital: capitalOf.get(i) ?? -1,
      area: cells.length,
      room: pole.room,
      noLabel: CITY_PROVINCES.has(pv.code) || cells.length === 0,
    }
  })

  const peaks: Peak[] = []
  for (const p of a.peaks) {
    const [x, y] = proj.toCell(p.lon / 1e5, p.lat / 1e5)
    if (x >= 0 && y >= 0 && x < W && y < H) peaks.push({ name: p.n, zh: p.zh, ja: p.ja, x, y, elev: p.e / 1000 })
  }

  return {
    peaks,
    admin: {
      borders,
      claims,
      unit,
      units: a.units.map((u) => ({ name: u.en, zh: u.zh, ja: u.ja, full: u.full, province: u.province })),
      provinceFull: a.provinces.map((p) => p.full),
    },
    realm,
    realms,
    labels,
  }
}
