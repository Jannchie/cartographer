/**
 * 生成"中国"区域模板的数据：public/china/grid.bin（地形与覆盖栅格）与 public/china/admin.bin（行政区划）。
 *
 * 原始数据（放在同一个目录 <src> 下）：
 *   etopo/ETOPO_2022_v1_60s_N90W180_surface.tif   NOAA ETOPO 2022，60″ 地表高程
 *     https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif
 *   ne/ne_10m_{land,minor_islands,lakes,playas,glaciated_areas}.geojson   Natural Earth 10m
 *     https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
 *   ne/ne_10m_geography_regions_elevation_points.geojson   Natural Earth 山峰点（名称与高程）
 *   datav/china_city.json   DataV.GeoAtlas 全国地级行政区（含台湾省、港澳、南海断续线）
 *     https://geo.datav.aliyun.com/areas_v3/bound/100000_full_city.json
 *
 *   pnpm tsx scripts/china-real.ts <src>
 *
 * 栅格：等经纬度 1′，覆盖地图范围（兰勃特投影的图框反算到经纬度再留边）。各层：
 *   高程 int16（米，逐行差分）· 覆盖 uint8（位：1 陆地 2 湖泊 4 盐沼 8 冰川）
 *   文件头：魔数 "CHN1"、W、H（uint32）、西缘经度、北缘纬度（float64，格的外缘），格距 1/60°；整个文件 gzip。
 *
 * 行政区划：DataV 的坐标是 GCJ-02，这里转回 WGS-84。省界、地级界与陆地国界取自同一套地级多边形的拓扑：
 *   两个地级单位共用的边——分属两省为省界，同省为地级界；只属于一个单位的边，外侧是陆地为国界、是海为海岸（不画）。
 *   直辖市、特别行政区与台湾省在地级上按一个整体处理（不画区界）。界线与断续线的立场与 DataV 一致（即国内标准地图的立场）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fromFile } from 'geotiff'
import * as OpenCC from 'opencc-js'
import { pinyin } from 'pinyin-pro'
import { fillRings, type LonLatGrid } from '../src/gen/earth/raster'
import { regionPlane } from '../src/gen/earth/region'
import { geojson as readGeojson, ringsOf, timedLog } from './natural-earth'

const SRC = process.argv[2]
if (!SRC) throw new Error('用法：tsx scripts/china-real.ts <原始数据目录>')
const OUT = 'public/china'
const log = timedLog()

// —— GCJ-02 → WGS-84（迭代求逆，误差远小于 1 米） ——
const A = 6378245.0
const EE = 0.00669342162296594323
const outOfChina = (lon: number, lat: number) => lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
function tLat(x: number, y: number) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return r
}
function tLon(x: number, y: number) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  return r
}
function wgsToGcj(lon: number, lat: number): [number, number] {
  if (outOfChina(lon, lat)) return [lon, lat]
  let dLat = tLat(lon - 105, lat - 35)
  let dLon = tLon(lon - 105, lat - 35)
  const rad = (lat / 180) * Math.PI
  let m = Math.sin(rad)
  m = 1 - EE * m * m
  const s = Math.sqrt(m)
  dLat = (dLat * 180) / (((A * (1 - EE)) / (m * s)) * Math.PI)
  dLon = (dLon * 180) / ((A / s) * Math.cos(rad) * Math.PI)
  return [lon + dLon, lat + dLat]
}
function gcjToWgs(lon: number, lat: number): [number, number] {
  let x = lon
  let y = lat
  for (let k = 0; k < 4; k++) {
    const [gx, gy] = wgsToGcj(x, y)
    x -= gx - lon
    y -= gy - lat
  }
  return [x, y]
}

// —— DataV ——
type Ring = number[]
interface Unit {
  /** 地级单位的编码（直辖市、特区、台湾为省级编码） */
  code: number
  province: number
  zh: string
  seat: [number, number]
  rings: Ring[]
}
const MERGED = new Set([110000, 120000, 310000, 500000, 810000, 820000, 710000])
const city = JSON.parse(readFileSync(`${SRC}/datav/china_city.json`, 'utf8')).features as { properties: any; geometry: any }[]
const full = JSON.parse(readFileSync(`${SRC}/datav/china_full.json`, 'utf8')).features as { properties: any; geometry: any }[]
const toRings = (g: any): Ring[] => {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  const out: Ring[] = []
  for (const poly of polys)
    for (const r of poly) {
      const flat: number[] = []
      for (const [lon, lat] of r) flat.push(...gcjToWgs(lon, lat))
      // 首尾重复的点去掉
      if (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1]) flat.length -= 2
      out.push(flat)
    }
  return out
}
const provinces = full.filter((f) => f.properties.level === 'province')
const dashes = toRings(full.find((f) => f.properties.adcode === '100000_JD')!.geometry)
const units = new Map<number, Unit>()
for (const f of city) {
  const pr = f.properties
  if (!pr.name) continue
  const prov = pr.level === 'province' ? pr.adcode : pr.parent.adcode
  const code = MERGED.has(prov) ? prov : pr.adcode
  const u = units.get(code)
  const rings = toRings(f.geometry)
  if (u) u.rings.push(...rings)
  else {
    const pf = provinces.find((x) => x.properties.adcode === prov)!
    const merged = MERGED.has(prov)
    units.set(code, {
      code,
      province: prov,
      // 台湾省在地级上没有细分：驻地即省会台北
      zh: prov === 710000 ? '台北市' : merged ? pf.properties.name : pr.name,
      seat: gcjToWgs(...((merged ? pf.properties.center : pr.center) as [number, number])),
      rings,
    })
  }
}
log(`省级 ${provinces.length}，地级单位 ${units.size}，断续线 ${dashes.length} 段`)

// —— 地图范围：国界与断续线的外包框（投影平面）再留 250 公里 ——
const plane = regionPlane('china')
{
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  const add = (r: Ring) => {
    for (let k = 0; k < r.length; k += 2) {
      const [x, y] = plane.forward(r[k], r[k + 1])
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  }
  for (const u of units.values()) u.rings.forEach(add)
  dashes.forEach(add)
  log(`投影外包框（公里）：x ${x0.toFixed(0)} ~ ${x1.toFixed(0)}，y ${y0.toFixed(0)} ~ ${y1.toFixed(0)}`)
  const want = { x0: Math.floor((x0 - 250) / 50) * 50, x1: Math.ceil((x1 + 250) / 50) * 50, y0: Math.floor((y0 - 250) / 50) * 50, y1: Math.ceil((y1 + 250) / 50) * 50 }
  const d = plane.def
  if (want.x0 !== d.x0 || want.x1 !== d.x1 || want.y0 !== d.y0 || want.y1 !== d.y1) console.warn(`⚠ src/gen/earth/region.ts 的范围应改为 ${JSON.stringify(want)}（现为 ${JSON.stringify({ x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1 })}）`)
}

// —— 栅格窗口：图框边上逐点反算经纬度，取外包再留 0.3° ——
const D = 1 / 60
let lonW = Infinity, lonE = -Infinity, latS = Infinity, latN = -Infinity
{
  const d = plane.def
  const STEPS = 400
  for (let s = 0; s <= STEPS; s++) {
    const t = s / STEPS
    for (const [x, y] of [
      [d.x0 + (d.x1 - d.x0) * t, d.y0],
      [d.x0 + (d.x1 - d.x0) * t, d.y1],
      [d.x0, d.y0 + (d.y1 - d.y0) * t],
      [d.x1, d.y0 + (d.y1 - d.y0) * t],
    ]) {
      const [lon, lat] = plane.inverse(x, y)
      lonW = Math.min(lonW, lon)
      lonE = Math.max(lonE, lon)
      latS = Math.min(latS, lat)
      latN = Math.max(latN, lat)
    }
  }
}
// 对齐到 ETOPO 60″ 的格（外缘在整分上）
lonW = Math.floor((lonW - 0.3) / D) * D
lonE = Math.ceil((lonE + 0.3) / D) * D
latS = Math.floor((latS - 0.3) / D) * D
latN = Math.ceil((latN + 0.3) / D) * D
const GW = Math.round((lonE - lonW) / D)
const GH = Math.round((latN - latS) / D)
const GN = GW * GH
const grid: LonLatGrid = { W: GW, H: GH, lon0: lonW, lat0: latN, dLon: D, dLat: D }
log(`栅格 ${GW} × ${GH}：经度 ${lonW.toFixed(2)} ~ ${lonE.toFixed(2)}，纬度 ${latS.toFixed(2)} ~ ${latN.toFixed(2)}`)

// —— 高程 ——
async function loadElevation() {
  const tif = await fromFile(`${SRC}/etopo/ETOPO_2022_v1_60s_N90W180_surface.tif`)
  const im = await tif.getImage()
  if (im.getWidth() !== 21600 || im.getHeight() !== 10800) throw new Error('ETOPO 尺寸不对')
  const c0 = Math.round((lonW + 180) / D)
  const r0 = Math.round((90 - latN) / D)
  const out = new Float32Array(GN)
  // 跨过 180° 经线的部分从左边绕回来
  const parts: [number, number, number][] = []
  if (c0 + GW <= 21600) parts.push([c0, c0 + GW, 0])
  else parts.push([c0, 21600, 0], [0, c0 + GW - 21600, 21600 - c0])
  for (const [a, b, off] of parts) {
    const r = (await im.readRasters({ window: [a, r0, b, r0 + GH] }))[0] as Float32Array
    const w = b - a
    for (let y = 0; y < GH; y++) for (let x = 0; x < w; x++) out[y * GW + off + x] = r[y * w + x]
  }
  return out
}

// —— 覆盖 ——
const geojson = (name: string) => readGeojson(SRC, name)
function rasterizeCover() {
  const cover = new Uint8Array(GN)
  const paint = (names: string[], bit: number) => {
    for (const n of names) for (const f of geojson(n)) fillRings(ringsOf(f), grid, (i) => (cover[i] |= bit))
  }
  paint(['ne_10m_land', 'ne_10m_minor_islands'], 1)
  paint(['ne_10m_lakes'], 2)
  paint(['ne_10m_playas'], 4)
  paint(['ne_10m_glaciated_areas'], 8)
  return cover
}

function encodeGrid(elev: Float32Array, cover: Uint8Array) {
  const e = new Int16Array(GN)
  for (let y = 0; y < GH; y++) {
    let prev = 0
    for (let x = 0; x < GW; x++) {
      const v = Math.max(-32768, Math.min(32767, Math.round(elev[y * GW + x])))
      e[y * GW + x] = v - prev
      prev = v
    }
  }
  const head = Buffer.alloc(28)
  head.write('CHN1', 0, 'latin1')
  head.writeUInt32LE(GW, 4)
  head.writeUInt32LE(GH, 8)
  head.writeDoubleLE(lonW, 12)
  head.writeDoubleLE(latN, 20)
  return gzipSync(Buffer.concat([head, Buffer.from(e.buffer), Buffer.from(cover)]), { level: 9 })
}

// —— 行政区划的拓扑：边 → 所属的地级单位 ——
const unitList = [...units.values()]
const keyOf = (ax: number, ay: number, bx: number, by: number) => {
  const a = `${ax.toFixed(7)},${ay.toFixed(7)}`
  const b = `${bx.toFixed(7)},${by.toFixed(7)}`
  return a < b ? `${a}|${b}` : `${b}|${a}`
}
function edgeOwners() {
  const owners = new Map<string, number[]>()
  unitList.forEach((u, ui) => {
    for (const r of u.rings) {
      const n = r.length / 2
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n
        const key = keyOf(r[2 * k], r[2 * k + 1], r[2 * k2], r[2 * k2 + 1])
        const o = owners.get(key)
        if (!o) owners.set(key, [ui])
        else if (!o.includes(ui)) o.push(ui)
      }
    }
  })
  return owners
}

/** 地级单位栅格（判断边的外侧）：-1 为不属于任何单位 */
function rasterizeUnits() {
  const id = new Int16Array(GN).fill(-1)
  unitList.forEach((u, ui) => fillRings(u.rings, grid, (i) => (id[i] = ui)))
  return id
}

type LineKind = 'national' | 'province' | 'prefecture'
function borderLines(cover: Uint8Array, unitId: Int16Array) {
  const owners = edgeOwners()
  let shared = 0
  let single = 0
  for (const o of owners.values()) o.length >= 2 ? shared++ : single++
  log(`边：共用 ${shared}，单属 ${single}`)
  const at = (lon: number, lat: number, a: Uint8Array | Int16Array, miss: number) => {
    const x = Math.floor((lon - lonW) / D)
    const y = Math.floor((latN - lat) / D)
    return x < 0 || y < 0 || x >= GW || y >= GH ? miss : a[y * GW + x]
  }
  // 各省的多边形分别简化过，跨省的边顶点并不重合：单属边沿法线两侧各探 3 公里，看外侧落在哪里——
  // 另一个地级单位（省界或地级界，由编号较小的一侧画）、陆地（国界）、海（海岸，不画）
  const OFF = 0.03
  const between = (ui: number, other: number): LineKind | null => {
    if (other < ui) return null
    return unitList[other].province === unitList[ui].province ? 'prefecture' : 'province'
  }
  const classify = (ui: number, ax: number, ay: number, bx: number, by: number, o: number[]): LineKind | null => {
    if (o.length >= 2) return between(ui, o.find((j) => j !== ui)!)
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    for (const s of [1, -1]) {
      const px = mx + (-dy / len) * OFF * s
      const py = my + (dx / len) * OFF * s
      const id = at(px, py, unitId, -1)
      if (id === ui) continue
      if (id >= 0) return between(ui, id)
      return at(px, py, cover, 0) & 1 ? 'national' : null
    }
    return null
  }
  const out: { k: LineKind; c: number[] }[] = []
  unitList.forEach((u, ui) => {
    for (const r of u.rings) {
      const n = r.length / 2
      const cls: (LineKind | null)[] = []
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n
        cls.push(classify(ui, r[2 * k], r[2 * k + 1], r[2 * k2], r[2 * k2 + 1], owners.get(keyOf(r[2 * k], r[2 * k + 1], r[2 * k2], r[2 * k2 + 1]))!))
      }
      // 从一个类别变化处开始绕一圈，同类的连续边连成一条线
      let start = cls.findIndex((c, k) => c !== cls[(k + n - 1) % n])
      if (start < 0) start = 0
      let cur: number[] | null = null
      let kind: LineKind | null = null
      for (let s = 0; s < n; s++) {
        const k = (start + s) % n
        const c = cls[k]
        if (c !== kind) {
          if (cur && kind) out.push({ k: kind, c: cur })
          cur = c ? [r[2 * k], r[2 * k + 1]] : null
          kind = c
        }
        if (cur) {
          const k2 = (k + 1) % n
          cur.push(r[2 * k2], r[2 * k2 + 1])
        }
      }
      if (cur && kind) out.push({ k: kind, c: cur })
    }
  })
  return out
}

// —— 名称 ——
const toJa = OpenCC.Converter({ from: 'cn', to: 'jp' })
const PROVINCE_EN: Record<number, string> = {
  110000: 'Beijing', 120000: 'Tianjin', 130000: 'Hebei', 140000: 'Shanxi', 150000: 'Inner Mongolia', 210000: 'Liaoning', 220000: 'Jilin', 230000: 'Heilongjiang',
  310000: 'Shanghai', 320000: 'Jiangsu', 330000: 'Zhejiang', 340000: 'Anhui', 350000: 'Fujian', 360000: 'Jiangxi', 370000: 'Shandong', 410000: 'Henan', 420000: 'Hubei',
  430000: 'Hunan', 440000: 'Guangdong', 450000: 'Guangxi', 460000: 'Hainan', 500000: 'Chongqing', 510000: 'Sichuan', 520000: 'Guizhou', 530000: 'Yunnan', 540000: 'Xizang',
  610000: 'Shaanxi', 620000: 'Gansu', 630000: 'Qinghai', 640000: 'Ningxia', 650000: 'Xinjiang', 710000: 'Taiwan', 810000: 'Hong Kong', 820000: 'Macao',
}
/** 省级简称：去掉"省""市""自治区""特别行政区"与民族名 */
const provinceShort = (zh: string) => zh.replace(/特别行政区$|维吾尔自治区$|壮族自治区$|回族自治区$|自治区$|省$|市$/, '')
const ETHNIC =
  '蒙古|回|藏|维吾尔|苗|彝|壮|布依|朝鲜|满|侗|瑶|白|土家|哈尼|哈萨克|傣|黎|傈僳|佤|畲|高山|拉祜|水|东乡|纳西|景颇|柯尔克孜|土|达斡尔|仫佬|羌|布朗|撒拉|毛南|仡佬|锡伯|阿昌|普米|塔吉克|怒|乌孜别克|俄罗斯|鄂温克|德昂|保安|裕固|京|塔塔尔|独龙|鄂伦春|赫哲|门巴|珞巴|基诺'
const ETHNIC_TAIL = new RegExp(`(?:(?:${ETHNIC})族)+自治(?:州|县)$`)
/** 地级简称：去掉"市""地区""盟""自治州"及其前的民族名；县级只去"县""市" */
const cityShort = (zh: string) => {
  const s = zh.replace(ETHNIC_TAIL, '').replace(/地区$|盟$|林区$|市$|县$/, '')
  return s.length >= 2 ? s : zh
}
const en = (zh: string) =>
  pinyin(zh, { toneType: 'none', type: 'array', v: true })
    .join('')
    .replace(/^./, (c) => c.toUpperCase())

/**
 * 山峰：栅格的格是 1′ 见方的平均高程，山顶被削低（珠峰一格只有约 7.5 km）。
 * 标注最高峰用实测高程：Natural Earth 的山峰点，珠穆朗玛峰取 2020 年中尼两国联合公布的 8848.86 米
 */
function peaks() {
  const OFFICIAL: Record<string, number> = { 'Mount Everest': 8848.86 }
  return geojson('ne_10m_geography_regions_elevation_points')
    .filter((f) => {
      const [lon, lat] = f.geometry!.coordinates as [number, number]
      return !!f.properties.name && lon >= lonW && lon <= lonE && lat >= latS && lat <= latN && f.properties.elevation > 0
    })
    .map((f) => {
      const p = f.properties
      const [lon, lat] = f.geometry!.coordinates as [number, number]
      const zh = toHans(p.name_zh || p.name_zht || p.name)
      return { n: p.name as string, zh, ja: (p.name_ja as string) || zh, lon: q(lon), lat: q(lat), e: OFFICIAL[p.name] ?? p.elevation }
    })
}
const toHans = OpenCC.Converter({ from: 'tw', to: 'cn' })

// —— 主流程 ——
const [elev] = await Promise.all([loadElevation()])
log('高程读完')
const cover = rasterizeCover()
log('覆盖栅格化完')
const unitId = rasterizeUnits()
const lines = borderLines(cover, unitId)
const count = (k: LineKind) => lines.filter((l) => l.k === k).length
log(`界线：国界 ${count('national')} 条，省界 ${count('province')} 条，地级界 ${count('prefecture')} 条`)

const q = (v: number) => Math.round(v * 1e5)
const provinceIndex = new Map(provinces.map((f, i) => [f.properties.adcode as number, i]))
const admin = {
  provinces: provinces.map((f) => {
    const p = f.properties
    const zh = provinceShort(p.name)
    return { code: p.adcode, zh, full: p.name, en: PROVINCE_EN[p.adcode], ja: toJa(zh), seat: gcjToWgs(...(p.center as [number, number])).map(q) }
  }),
  units: unitList.map((u) => {
    const whole = MERGED.has(u.province) && u.province !== 710000
    const zh = whole ? provinceShort(u.zh) : cityShort(u.zh)
    return {
      code: u.code,
      province: provinceIndex.get(u.province)!,
      zh,
      full: u.zh,
      en: whole ? PROVINCE_EN[u.province] : en(zh),
      ja: toJa(zh),
      seat: u.seat.map(q),
      rings: u.rings.map((r) => r.map(q)),
    }
  }),
  lines: lines.map((l) => ({ k: l.k, c: l.c.map(q) })),
  dashes: dashes.map((r) => r.map(q)),
  peaks: peaks(),
}

mkdirSync(OUT, { recursive: true })
const gbin = encodeGrid(elev, cover)
writeFileSync(`${OUT}/grid.bin`, gbin)
const abin = gzipSync(Buffer.from(JSON.stringify(admin)), { level: 9 })
writeFileSync(`${OUT}/admin.bin`, abin)
log(`grid.bin ${(gbin.length / 1048576).toFixed(1)} MB，admin.bin ${(abin.length / 1048576).toFixed(1)} MB`)
