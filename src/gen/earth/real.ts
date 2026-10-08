/**
 * 真实地球模板的数据（由 scripts/earth-real.ts 生成，放在 public/earth/）：用到时才加载，加载后同步取用。
 * - 栅格 {15m,5m}/grid.bin：高程、年均温、年降水、生物群系、海陆湖覆盖，等经纬度覆盖全球
 * - 矢量 features.bin：河流折线与自然地物（名称 + 轮廓）
 */
export type EarthRes = '15m' | '5m'
export const EARTH_RES: EarthRes[] = ['15m', '5m']

/** 覆盖层的位 */
export const COVER = { land: 1, lake: 2, playa: 4, glacier: 8 } as const

export interface EarthGrid {
  W: number
  H: number
  /** 高程（公里，海面以下为负） */
  elev: Float32Array
  /** 年均温（°C），没有观测（海洋、小岛）为 NaN */
  temp: Float32Array
  /** 年降水（mm），没有观测为 NaN */
  rain: Float32Array
  /** RESOLVE 生物群系编号 1–14，15 为岩石与冰，0 为没有 */
  biome: Uint8Array
  cover: Uint8Array
}

export type EarthPlaceKind = 'continent' | 'island' | 'range' | 'basin' | 'desert' | 'ocean' | 'sea' | 'bay' | 'lake'
export interface EarthFeatures {
  /** 河段：c 为交替存储的经纬度 ×100，从源头到河口；r 为 Natural Earth 的等级（越小越重要） */
  rivers: { n?: string; zh?: string; ja?: string; r: number; c: number[] }[]
  /** 自然地物：rings 为若干环（经纬度 ×100），按奇偶规则围出范围 */
  places: { k: EarthPlaceKind; n: string; zh?: string; ja?: string; r: number; rings: number[][] }[]
}

const grids = new Map<EarthRes, EarthGrid>()
let features: EarthFeatures | null = null

/** 读 public/earth 下的文件并解 gzip */
const readGz = (path: string) => readPublicGz(`earth/${path}`)

/** 读 public 下的 gzip 文件并解压：浏览器（含 Worker）走 fetch，Node 脚本直接读文件 */
export async function readPublicGz(path: string): Promise<ArrayBuffer> {
  let body: BodyInit
  const nodeProcess = (globalThis as { process?: { versions?: { node?: string } } }).process
  if (typeof window === 'undefined' && nodeProcess?.versions?.node) {
    const fs = 'node:fs/promises'
    const { readFile } = (await import(/* @vite-ignore */ fs)) as { readFile: (u: URL) => Promise<Uint8Array> }
    body = new Uint8Array(await readFile(new URL(`../../../public/${path}`, import.meta.url)))
  } else {
    const res = await fetch(`${import.meta.env.BASE_URL}${path}`)
    if (!res.ok) throw new Error(`真实地球数据加载失败：${path}（${res.status}）`)
    body = await res.blob()
  }
  const stream = new Response(body).body!.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

/** 年降水的对数刻度（与生成脚本一致） */
const LOG_RAIN = 36

export async function loadEarthGrid(res: EarthRes): Promise<EarthGrid> {
  const have = grids.get(res)
  if (have) return have
  const buf = await readGz(`${res}/grid.bin`)
  const head = new DataView(buf, 0, 12)
  if (String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3)) !== 'EAR1') throw new Error('真实地球数据格式不对')
  const W = head.getUint32(4, true)
  const H = head.getUint32(8, true)
  const N = W * H
  let off = 12
  const de = new Int16Array(buf, off, N)
  off += 2 * N
  const t8 = new Int8Array(buf, off, N)
  off += N
  const p8 = new Uint8Array(buf, off, N)
  off += N
  const biome = new Uint8Array(buf, off, N)
  off += N
  const cover = new Uint8Array(buf, off, N)
  const elev = new Float32Array(N)
  for (let y = 0; y < H; y++) {
    let v = 0
    for (let x = 0; x < W; x++) {
      v += de[y * W + x]
      elev[y * W + x] = v / 100
    }
  }
  const temp = new Float32Array(N)
  const rain = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    temp[i] = t8[i] === -128 ? NaN : t8[i] / 2
    rain[i] = p8[i] === 255 ? NaN : 10 * Math.expm1(p8[i] / LOG_RAIN)
  }
  const g = { W, H, elev, temp, rain, biome, cover }
  grids.set(res, g)
  return g
}

export async function loadEarthFeatures(): Promise<EarthFeatures> {
  if (features) return features
  features = JSON.parse(new TextDecoder().decode(await readGz('features.bin'))) as EarthFeatures
  return features
}

export const earthGridLoaded = (res: EarthRes) => grids.has(res)
export const earthFeaturesLoaded = () => features !== null
export const earthGrid = (res: EarthRes) => {
  const g = grids.get(res)
  if (!g) throw new Error('真实地球数据还没加载（先 await loadEarthGrid()）')
  return g
}
export const earthFeatures = () => {
  if (!features) throw new Error('真实地球矢量还没加载（先 await loadEarthFeatures()）')
  return features
}
