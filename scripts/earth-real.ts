/**
 * 生成"真实地球"模板的数据：public/earth/{15m,5m}/grid.bin（栅格）与 public/earth/features.bin（矢量：河流与自然地物名称）。
 *
 * 原始数据（放在同一个目录 <src> 下）：
 *   etopo/ETOPO_2022_v1_60s_N90W180_surface.tif   NOAA ETOPO 2022，60″ 地表高程（冰盖取冰面）
 *     https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif
 *   wc/wc2.1_5m_bio_1.tif、wc/wc2.1_5m_bio_12.tif  WorldClim 2.1，5′ 年均温（°C）与年降水（mm），1970–2000 年
 *     https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_5m_bio.zip
 *   eco/Ecoregions2017.shp/.dbf                   RESOLVE Ecoregions 2017 的生物群系（BIOME_NUM）
 *     https://storage.googleapis.com/teow2016/Ecoregions2017.zip
 *   ne/*.geojson                                  Natural Earth 10m：陆地、湖泊、盐沼、冰川、河流、自然地物名称
 *     https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
 *
 *   pnpm tsx scripts/earth-real.ts <src>
 *
 * 栅格（等经纬度，覆盖全球）：5′ 为 4320 × 2160，0.25° 为 1440 × 720，后者由前者按 3 × 3 合并。各层依次存放：
 *   高程 int16（10 米，逐行差分）· 年均温 int8（0.5 °C，-128 无数据）· 年降水 uint8（对数刻度，255 无数据）·
 *   群系 uint8（RESOLVE BIOME_NUM 1–14，15 岩石与冰，0 无）· 覆盖 uint8（位：1 陆地 2 湖泊 4 盐沼 8 冰川）
 * 文件头：魔数 "EAR1"、W、H（uint32，小端），其后各层；整个文件 gzip。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fromFile } from 'geotiff'
import * as OpenCC from 'opencc-js'
import { fillRings, lonLatGrid, simplifyLine } from '../src/gen/earth/raster'
import { RIVER_NAMES } from './earth-river-names'
import { type Feature, geojson as readGeojson, linesOf, ringsOf, timedLog } from './natural-earth'

const SRC = process.argv[2]
if (!SRC) throw new Error('用法：tsx scripts/earth-real.ts <原始数据目录>')
const OUT = 'public/earth'
const toHans = OpenCC.Converter({ from: 'tw', to: 'cn' })

const W5 = 4320
const H5 = 2160
const N5 = W5 * H5
const g5 = lonLatGrid(W5, H5)
const log = timedLog()

// —— 高程：60″ → 5′，5 × 5 块平均 ——
async function loadElevation() {
  const tif = await fromFile(`${SRC}/etopo/ETOPO_2022_v1_60s_N90W180_surface.tif`)
  const im = await tif.getImage()
  const SW = im.getWidth()
  const SH = im.getHeight()
  if (SW !== W5 * 5 || SH !== H5 * 5) throw new Error(`ETOPO 尺寸不对：${SW} × ${SH}`)
  const out = new Float32Array(N5)
  const BAND = 360
  for (let y0 = 0; y0 < SH; y0 += BAND) {
    const r = (await im.readRasters({ window: [0, y0, SW, y0 + BAND] }))[0] as Float32Array
    for (let ry = 0; ry < BAND; ry++) {
      const oy = (y0 + ry) / 5 | 0
      const row = ry * SW
      for (let x = 0; x < SW; x++) out[oy * W5 + ((x / 5) | 0)] += r[row + x]
    }
  }
  for (let i = 0; i < N5; i++) out[i] /= 25
  return out
}

// —— WorldClim：本身就是 5′ ——
async function loadWorldClim(name: string) {
  const tif = await fromFile(`${SRC}/wc/${name}`)
  const im = await tif.getImage()
  if (im.getWidth() !== W5 || im.getHeight() !== H5) throw new Error(`${name} 尺寸不对`)
  const r = (await im.readRasters())[0] as Float32Array
  const out = new Float32Array(N5)
  for (let i = 0; i < N5; i++) out[i] = r[i] < -1e30 ? NaN : r[i]
  return out
}

// —— Shapefile（只读多边形）与 dbf ——
function readDbf(path: string) {
  const b = readFileSync(path)
  const n = b.readUInt32LE(4)
  const hl = b.readUInt16LE(8)
  const rl = b.readUInt16LE(10)
  const fields: { name: string; pos: number; len: number }[] = []
  let off = 32
  let pos = 1
  while (b[off] !== 0x0d) {
    const len = b[off + 16]
    fields.push({ name: b.toString('latin1', off, off + 11).replace(/\0.*/, ''), pos, len })
    pos += len
    off += 32
  }
  return (r: number, name: string) => {
    const f = fields.find((x) => x.name === name)!
    const s = hl + r * rl + f.pos
    return b.toString('latin1', s, s + f.len).trim()
  }
}
function* readShpPolygons(path: string): Generator<number[][]> {
  const b = readFileSync(path)
  let off = 100
  while (off < b.length) {
    const len = b.readInt32BE(off + 4) * 2
    const c = off + 8
    const type = b.readInt32LE(c)
    const rings: number[][] = []
    if (type === 5) {
      const np = b.readInt32LE(c + 36)
      const nPts = b.readInt32LE(c + 40)
      const parts: number[] = []
      for (let k = 0; k < np; k++) parts.push(b.readInt32LE(c + 44 + 4 * k))
      const p0 = c + 44 + 4 * np
      for (let k = 0; k < np; k++) {
        const a = parts[k]
        const e = k + 1 < np ? parts[k + 1] : nPts
        const ring = new Array<number>((e - a) * 2)
        for (let j = a; j < e; j++) {
          ring[(j - a) * 2] = b.readDoubleLE(p0 + j * 16)
          ring[(j - a) * 2 + 1] = b.readDoubleLE(p0 + j * 16 + 8)
        }
        rings.push(ring)
      }
    }
    yield rings
    off = c + len
  }
}

// —— GeoJSON ——
const geojson = (name: string) => readGeojson(SRC, name)

// —— 覆盖与群系（5′ 栅格化） ——
const ENDORHEIC_SEAS = ['Caspian Sea']
function rasterizeCover() {
  const cover = new Uint8Array(N5)
  const paint = (names: string[], bit: number) => {
    for (const n of names) for (const f of geojson(n)) fillRings(ringsOf(f), g5, (i) => (cover[i] |= bit))
  }
  paint(['ne_10m_land', 'ne_10m_minor_islands', 'ne_10m_antarctic_ice_shelves_polys'], 1)
  paint(['ne_10m_lakes', 'ne_10m_lakes_europe', 'ne_10m_lakes_north_america'], 2)
  // 里海在 Natural Earth 里归在"海"：它是内陆湖，按湖处理（湖面高度、湖泊群系）
  for (const f of geojson('ne_10m_geography_marine_polys')) if (ENDORHEIC_SEAS.includes(f.properties.name)) fillRings(ringsOf(f), g5, (i) => (cover[i] |= 2))
  paint(['ne_10m_playas'], 4)
  paint(['ne_10m_glaciated_areas'], 8)
  return cover
}
function rasterizeBiomes() {
  const biome = new Uint8Array(N5)
  const dbf = readDbf(`${SRC}/eco/Ecoregions2017.dbf`)
  let r = 0
  for (const rings of readShpPolygons(`${SRC}/eco/Ecoregions2017.shp`)) {
    const num = Math.round(Number(dbf(r, 'BIOME_NUM')))
    const name = dbf(r, 'BIOME_NAME')
    // "N/A" 的那条是岩石与冰（南极、格陵兰内陆）
    const v = name === 'N/A' ? 15 : num
    if (v >= 1 && v <= 15) fillRings(rings, g5, (i) => (biome[i] = v))
    r++
  }
  return biome
}

// —— 编码 ——
const LOG_RAIN = 36
const encRain = (mm: number) => (Number.isNaN(mm) ? 255 : Math.min(254, Math.round(LOG_RAIN * Math.log1p(Math.max(0, mm) / 10))))
const encTemp = (c: number) => (Number.isNaN(c) ? -128 : Math.max(-127, Math.min(127, Math.round(c * 2))))

function encodeGrid(W: number, H: number, elev: Float32Array, temp: Float32Array, rain: Float32Array, biome: Uint8Array, cover: Uint8Array) {
  const N = W * H
  const e = new Int16Array(N)
  for (let y = 0; y < H; y++) {
    let prev = 0
    for (let x = 0; x < W; x++) {
      const v = Math.round(elev[y * W + x] / 10)
      e[y * W + x] = v - prev
      prev = v
    }
  }
  const t = new Int8Array(N)
  const p = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    t[i] = encTemp(temp[i])
    p[i] = encRain(rain[i])
  }
  const head = Buffer.alloc(12)
  head.write('EAR1', 0, 'latin1')
  head.writeUInt32LE(W, 4)
  head.writeUInt32LE(H, 8)
  return gzipSync(Buffer.concat([head, Buffer.from(e.buffer), Buffer.from(t.buffer), Buffer.from(p.buffer), Buffer.from(biome), Buffer.from(cover)]), { level: 9 })
}

/** 5′ → 0.25°：3 × 3 合并。连续量取平均（气候只平均有数据的格），覆盖取过半，群系取陆地格里最多的 */
function downsample(elev: Float32Array, temp: Float32Array, rain: Float32Array, biome: Uint8Array, cover: Uint8Array) {
  const W = W5 / 3
  const H = H5 / 3
  const N = W * H
  const e = new Float32Array(N)
  const t = new Float32Array(N)
  const p = new Float32Array(N)
  const b = new Uint8Array(N)
  const c = new Uint8Array(N)
  const votes = new Uint8Array(16)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let se = 0
      let st = 0
      let nt = 0
      let sp = 0
      let np = 0
      const bits = [0, 0, 0, 0]
      votes.fill(0)
      for (let dy = 0; dy < 3; dy++)
        for (let dx = 0; dx < 3; dx++) {
          const i = (y * 3 + dy) * W5 + x * 3 + dx
          se += elev[i]
          if (!Number.isNaN(temp[i])) {
            st += temp[i]
            nt++
          }
          if (!Number.isNaN(rain[i])) {
            sp += rain[i]
            np++
          }
          for (let k = 0; k < 4; k++) if (cover[i] & (1 << k)) bits[k]++
          if (cover[i] & 1) votes[biome[i]]++
        }
      const o = y * W + x
      e[o] = se / 9
      t[o] = nt ? st / nt : NaN
      p[o] = np ? sp / np : NaN
      for (let k = 0; k < 4; k++) if (bits[k] >= 5) c[o] |= 1 << k
      let best = 0
      for (let v = 1; v < 16; v++) if (votes[v] > votes[best]) best = v
      b[o] = best
    }
  return { W, H, e, t, p, b, c }
}

// —— 矢量：河流与自然地物 ——
/** 全大写的英文名转成首字母大写（"KARAKORAM RA." → "Karakoram Ra."） */
function titleCase(s: string) {
  if (s !== s.toUpperCase()) return s
  return s.toLowerCase().replace(/(^|[\s\-'(/])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
}
const q = (v: number) => Math.round(v * 100)

function buildFeatures(elev: Float32Array) {
  const elevAt = (lon: number, lat: number) => {
    const x = Math.min(W5 - 1, Math.max(0, Math.floor((lon + 180) * 12)))
    const y = Math.min(H5 - 1, Math.max(0, Math.floor((90 - lat) * 12)))
    return elev[y * W5 + x]
  }
  // 河流：只取河道（湖中心线不画），按高程把方向理顺成从源头到河口
  const rivers: { n?: string; zh?: string; ja?: string; r: number; c: number[] }[] = []
  for (const f of geojson('ne_10m_rivers_lake_centerlines')) {
    const pr = f.properties
    if (pr.featurecla !== 'River') continue
    for (const line of linesOf(f)) {
      let pts = simplifyLine(line, 0.02)
      if (pts.length < 4) continue
      const n = pts.length
      if (elevAt(pts[0], pts[1]) < elevAt(pts[n - 2], pts[n - 1]) - 20) {
        const rev: number[] = []
        for (let k = n - 2; k >= 0; k -= 2) rev.push(pts[k], pts[k + 1])
        pts = rev
      }
      const name: string | undefined = pr.name || undefined
      const tr = name ? RIVER_NAMES[name] : undefined
      rivers.push({ n: name, zh: tr?.[0], ja: tr?.[1], r: pr.scalerank, c: pts.map(q) })
    }
  }

  // 自然地物：名称 + 轮廓（化简后的环）
  type Kind = 'continent' | 'island' | 'range' | 'basin' | 'desert' | 'ocean' | 'sea' | 'bay' | 'lake'
  const REGION: Record<string, Kind> = {
    Continent: 'continent',
    Island: 'island',
    'Island group': 'island',
    'Pen/cape': 'island',
    Peninsula: 'island',
    'Range/mtn': 'range',
    Plateau: 'range',
    Foothills: 'range',
    Desert: 'desert',
    Basin: 'basin',
    Depression: 'basin',
    Plain: 'basin',
    Lowland: 'basin',
    Valley: 'basin',
    Delta: 'basin',
    Wetlands: 'basin',
    Tundra: 'basin',
    Geoarea: 'basin',
  }
  const MARINE: Record<string, Kind> = {
    ocean: 'ocean',
    sea: 'sea',
    bay: 'bay',
    gulf: 'bay',
    inlet: 'bay',
    fjord: 'bay',
    lagoon: 'bay',
    sound: 'bay',
    channel: 'bay',
    strait: 'bay',
  }
  const places: { k: Kind; n: string; zh?: string; ja?: string; r: number; rings: number[][] }[] = []
  const add = (k: Kind | undefined, pr: Record<string, any>, f: Feature, rank: number, zhKey: string, jaKey: string, enKeys: string[]) => {
    if (!k) return
    const en = enKeys.map((key) => pr[key]).find((v) => typeof v === 'string' && v.trim())
    if (!en) return
    const rings = ringsOf(f)
      .map((r) => simplifyLine(r, 0.04))
      .filter((r) => r.length >= 6)
      .map((r) => r.map(q))
    if (!rings.length) return
    const zh = pr[zhKey] ? toHans(pr[zhKey]) : undefined
    places.push({ k, n: titleCase(en.trim()), zh, ja: pr[jaKey] || undefined, r: Number(rank) || 9, rings })
  }
  for (const f of geojson('ne_10m_geography_regions_polys')) add(REGION[f.properties.FEATURECLA], f.properties, f, f.properties.SCALERANK, 'NAME_ZH', 'NAME_JA', ['NAME_EN', 'NAME'])
  for (const f of geojson('ne_10m_geography_marine_polys')) {
    const k = ENDORHEIC_SEAS.includes(f.properties.name) ? 'lake' : MARINE[f.properties.featurecla]
    add(k, f.properties, f, f.properties.scalerank, 'name_zh', 'name_ja', ['name_en', 'name'])
  }
  for (const f of geojson('ne_10m_lakes')) if (f.properties.scalerank <= 8) add('lake', f.properties, f, f.properties.scalerank, 'name_zh', 'name_ja', ['name_en', 'name'])
  return { rivers, places }
}

// —— 主流程 ——
mkdirSync(`${OUT}/5m`, { recursive: true })
mkdirSync(`${OUT}/15m`, { recursive: true })
log('读取高程')
const elev = await loadElevation()
log('读取气候')
const temp = await loadWorldClim('wc2.1_5m_bio_1.tif')
const rain = await loadWorldClim('wc2.1_5m_bio_12.tif')
log('栅格化陆地、湖泊、盐沼、冰川')
const cover = rasterizeCover()
log('栅格化生物群系')
const biome = rasterizeBiomes()

const g5bin = encodeGrid(W5, H5, elev, temp, rain, biome, cover)
writeFileSync(`${OUT}/5m/grid.bin`, g5bin)
log(`5′ 栅格 ${(g5bin.length / 1048576).toFixed(1)} MB`)
const d = downsample(elev, temp, rain, biome, cover)
const g15bin = encodeGrid(d.W, d.H, d.e, d.t, d.p, d.b, d.c)
writeFileSync(`${OUT}/15m/grid.bin`, g15bin)
log(`0.25° 栅格 ${(g15bin.length / 1048576).toFixed(1)} MB`)

const feats = buildFeatures(elev)
const fbin = gzipSync(Buffer.from(JSON.stringify(feats)), { level: 9 })
writeFileSync(`${OUT}/features.bin`, fbin)
log(`矢量：河流 ${feats.rivers.length} 段，地物 ${feats.places.length} 个，${(fbin.length / 1024).toFixed(0)} KB`)
