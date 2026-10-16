/**
 * 生成区域图的地形栅格：public/<区域>/grid.bin（区域定义见 src/gen/earth/region.ts）。
 *
 * 原始数据（放在同一个目录 <src> 下）：
 *   etopo/ETOPO_2022_v1_60s_N90W180_surface.tif   NOAA ETOPO 2022，60″ 地表高程
 *     https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif
 *   ne/ne_10m_{land,minor_islands,lakes,playas,glaciated_areas}.geojson   Natural Earth 10m
 *     https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
 *
 *   pnpm tsx scripts/region-grid.ts <区域> <src>
 *
 * 栅格：等经纬度 1′，覆盖地图范围（投影图框反算到经纬度再留 0.3°）。各层：
 *   高程 int16（米，逐行差分）· 覆盖 uint8（位：1 陆地 2 湖泊 4 盐沼 8 冰川）
 *   文件头：魔数 "RGN1"、W、H（uint32）、西缘经度、北缘纬度（float64，格的外缘），格距 1/60°；整个文件 gzip。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { fromFile } from 'geotiff'
import { fillRings, type LonLatGrid } from '../src/gen/earth/raster'
import { regionPlane, type RegionId } from '../src/gen/earth/region'
import { geojson, ringsOf, timedLog } from './natural-earth'

const D = 1 / 60

/** 区域的 1′ 栅格窗口：图框边上逐点反算经纬度，取外包再留 0.3°，对齐到 ETOPO 60″ 的格（外缘在整分上） */
export function regionWindow(id: RegionId) {
  const plane = regionPlane(id)
  const d = plane.def
  let lonW = Infinity
  let lonE = -Infinity
  let latS = Infinity
  let latN = -Infinity
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
  lonW = Math.floor((lonW - 0.3) / D) * D
  lonE = Math.ceil((lonE + 0.3) / D) * D
  latS = Math.floor((latS - 0.3) / D) * D
  latN = Math.ceil((latN + 0.3) / D) * D
  const W = Math.round((lonE - lonW) / D)
  const H = Math.round((latN - latS) / D)
  const grid: LonLatGrid = { W, H, lon0: lonW, lat0: latN, dLon: D, dLat: D }
  return { lonW, lonE, latS, latN, W, H, grid }
}

/** ETOPO 60″ 在窗口内的高程（米）；跨过 180° 经线的部分从左边绕回来 */
async function loadElevation(src: string, w: ReturnType<typeof regionWindow>) {
  const tif = await fromFile(`${src}/etopo/ETOPO_2022_v1_60s_N90W180_surface.tif`)
  const im = await tif.getImage()
  if (im.getWidth() !== 21600 || im.getHeight() !== 10800) throw new Error('ETOPO 尺寸不对')
  const c0 = Math.round((w.lonW + 180) / D)
  const r0 = Math.round((90 - w.latN) / D)
  const out = new Float32Array(w.W * w.H)
  const parts: [number, number, number][] = []
  if (c0 + w.W <= 21600) parts.push([c0, c0 + w.W, 0])
  else parts.push([c0, 21600, 0], [0, c0 + w.W - 21600, 21600 - c0])
  for (const [a, b, off] of parts) {
    const r = (await im.readRasters({ window: [a, r0, b, r0 + w.H] }))[0] as Float32Array
    const n = b - a
    for (let y = 0; y < w.H; y++) for (let x = 0; x < n; x++) out[y * w.W + off + x] = r[y * n + x]
  }
  return out
}

/** Natural Earth 的陆地、湖泊、盐沼、冰川按位栅格化 */
function rasterizeCover(src: string, grid: LonLatGrid) {
  const cover = new Uint8Array(grid.W * grid.H)
  const paint = (names: string[], bit: number) => {
    for (const n of names) for (const f of geojson(src, n)) fillRings(ringsOf(f), grid, (i) => (cover[i] |= bit))
  }
  paint(['ne_10m_land', 'ne_10m_minor_islands'], 1)
  paint(['ne_10m_lakes'], 2)
  paint(['ne_10m_playas'], 4)
  paint(['ne_10m_glaciated_areas'], 8)
  return cover
}

function encodeGrid(w: ReturnType<typeof regionWindow>, elev: Float32Array, cover: Uint8Array) {
  const e = new Int16Array(w.W * w.H)
  for (let y = 0; y < w.H; y++) {
    let prev = 0
    for (let x = 0; x < w.W; x++) {
      const v = Math.max(-32768, Math.min(32767, Math.round(elev[y * w.W + x])))
      e[y * w.W + x] = v - prev
      prev = v
    }
  }
  const head = Buffer.alloc(28)
  head.write('RGN1', 0, 'latin1')
  head.writeUInt32LE(w.W, 4)
  head.writeUInt32LE(w.H, 8)
  head.writeDoubleLE(w.lonW, 12)
  head.writeDoubleLE(w.latN, 20)
  return gzipSync(Buffer.concat([head, Buffer.from(e.buffer), Buffer.from(cover)]), { level: 9 })
}

/** 生成并写出 public/<区域>/grid.bin，返回栅格窗口与覆盖栅格（区域专属的数据脚本还要用它们栅格化、判断别的图层） */
export async function buildRegionGrid(id: RegionId, src: string, log: (s: string) => void) {
  const w = regionWindow(id)
  log(`栅格 ${w.W} × ${w.H}：经度 ${w.lonW.toFixed(2)} ~ ${w.lonE.toFixed(2)}，纬度 ${w.latS.toFixed(2)} ~ ${w.latN.toFixed(2)}`)
  log('读取高程')
  const elev = await loadElevation(src, w)
  log('栅格化覆盖')
  const cover = rasterizeCover(src, w.grid)
  const bin = encodeGrid(w, elev, cover)
  mkdirSync(`public/${id}`, { recursive: true })
  writeFileSync(`public/${id}/grid.bin`, bin)
  log(`public/${id}/grid.bin ${(bin.length / 1048576).toFixed(1)} MB`)
  return { ...w, cover }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [id, src] = process.argv.slice(2) as [RegionId, string]
  if (!id || !src) throw new Error('用法：tsx scripts/region-grid.ts <区域> <原始数据目录>')
  await buildRegionGrid(id, src, timedLog())
}
