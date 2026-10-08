import type { Area } from '../gen/areas'
import { bumpSketch } from '../gen/sketch'
import type { Label, Realm, River, Road, SketchRange, World, WorldEdits, WorldParams } from '../gen/types'

/**
 * 项目文档：一份可保存、可重放的世界——种子与参数 + 用户的全部编辑。
 * 增量图用 deflate 压缩后以 base64 存进 JSON（大部分是 0，压缩后很小）。
 * 第 2 版起可带定稿地形与整个世界的数据（snapshot）：打开时直接显示，不再按种子演算
 */
export interface ProjectDoc {
  app: 'cartographer'
  version: 1 | 2
  /** 世界库里的名字 */
  name?: string
  world: {
    params: WorldParams
    edits: {
      terrain?: string
      temp?: string
      rain?: string
      labels?: Label[]
      regions?: string
      regionMeta?: { name: string; zh: string }[]
      worldName?: string
      worldNameZh?: string
      worldNameJa?: string
      areas?: Area[]
      /** 规划草图：陆地意图（压缩）与山脉折线 */
      sketch?: { land: string; ranges: SketchRange[] }
      /** 定稿地形（侵蚀后、河道下切前的高度）与盆地 */
      frozen?: { elev: string; basins: { x: number; y: number; r: number }[]; seed: string; terrainVariant?: number }
      planTerrain?: string
      realmNames?: WorldEdits['realmNames']
    }
    snapshot?: PackedWorld
  }
}

/** 世界的全部数据：场按类型压缩，河流折线首尾相接存成一条，用 offsets 切开 */
interface PackedWorld {
  W: number
  H: number
  kmPerCell: number
  fields: Record<string, Packed>
  rivers: { points: Packed; flow: Packed; offsets: number[] }
  labels: Label[]
  realms: Realm[]
  roads: Road[]
  worldName: string
  worldNameZh: string
  worldNameJa: string
  stats: World['stats']
}

type Packed = { t: 'f32' | 'u8' | 'i16'; d: string }
type TA = Float32Array | Uint8Array | Int16Array

async function packBytes(a: ArrayBufferView): Promise<string> {
  const stream = new Blob([new Uint8Array(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function unpackBytes(b64: string): Promise<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).arrayBuffer()
}

const packF32 = (a: Float32Array) => packBytes(a)
const unpackF32 = async (b64: string) => new Float32Array(await unpackBytes(b64))

async function packTA(a: TA): Promise<Packed> {
  return { t: a instanceof Float32Array ? 'f32' : a instanceof Int16Array ? 'i16' : 'u8', d: await packBytes(a) }
}
async function unpackTA(p: Packed): Promise<TA> {
  const b = await unpackBytes(p.d)
  return p.t === 'f32' ? new Float32Array(b) : p.t === 'i16' ? new Int16Array(b) : new Uint8Array(b)
}

const FIELDS = ['elevation', 'water', 'temperature', 'precipitation', 'flow', 'biome', 'coastDist', 'realm'] as const

async function packWorld(w: World): Promise<PackedWorld> {
  // 各场独立压缩，并发进行
  const fields: Record<string, Packed> = Object.fromEntries(await Promise.all(FIELDS.map(async (k) => [k, await packTA(w[k])] as const)))
  const n = w.rivers.reduce((s, r) => s + r.flow.length, 0)
  const pts = new Float32Array(n * 2)
  const flow = new Float32Array(n)
  const offsets: number[] = []
  let o = 0
  for (const r of w.rivers) {
    offsets.push(o)
    pts.set(r.points, o * 2)
    flow.set(r.flow, o)
    o += r.flow.length
  }
  const [packedPts, packedFlow] = await Promise.all([packTA(pts), packTA(flow)])
  return {
    W: w.W,
    H: w.H,
    kmPerCell: w.kmPerCell,
    fields,
    rivers: { points: packedPts, flow: packedFlow, offsets },
    labels: w.labels,
    realms: w.realms,
    roads: w.roads,
    worldName: w.worldName,
    worldNameZh: w.worldNameZh,
    worldNameJa: w.worldNameJa,
    stats: w.stats,
  }
}

async function unpackWorld(p: PackedWorld, params: WorldParams): Promise<World> {
  const f: Record<string, TA> = Object.fromEntries(await Promise.all(FIELDS.map(async (k) => [k, await unpackTA(p.fields[k])] as const)))
  const [pts, flow] = (await Promise.all([unpackTA(p.rivers.points), unpackTA(p.rivers.flow)])) as Float32Array[]
  const rivers: River[] = p.rivers.offsets.map((s, i) => {
    const e = p.rivers.offsets[i + 1] ?? flow.length
    return { points: pts.slice(s * 2, e * 2), flow: flow.slice(s, e) }
  })
  return {
    params,
    W: p.W,
    H: p.H,
    kmPerCell: p.kmPerCell,
    elevation: f.elevation as Float32Array,
    water: f.water as Float32Array,
    temperature: f.temperature as Float32Array,
    precipitation: f.precipitation as Float32Array,
    flow: f.flow as Float32Array,
    biome: f.biome as Uint8Array,
    coastDist: f.coastDist as Float32Array,
    realm: f.realm as Int16Array,
    rivers,
    labels: p.labels,
    realms: p.realms,
    roads: p.roads,
    worldName: p.worldName,
    worldNameZh: p.worldNameZh,
    worldNameJa: p.worldNameJa,
    stats: p.stats,
  }
}

/** world 给了就连同整个世界的数据一起存（第 2 版） */
export async function serializeProject(params: WorldParams, edits: WorldEdits, world?: World, name?: string): Promise<string> {
  const doc: ProjectDoc = { app: 'cartographer', version: world || edits.frozen ? 2 : 1, world: { params: { ...params }, edits: {} } }
  if (name) doc.name = name
  const e = doc.world.edits
  if (edits.terrain) e.terrain = await packF32(edits.terrain)
  if (edits.temp) e.temp = await packF32(edits.temp)
  if (edits.rain) e.rain = await packF32(edits.rain)
  if (edits.labels) e.labels = edits.labels.map((l) => ({ ...l }))
  if (edits.regions) e.regions = await packF32(Float32Array.from(edits.regions))
  e.regionMeta = edits.regionMeta
  e.worldName = edits.worldName
  e.worldNameZh = edits.worldNameZh
  e.worldNameJa = edits.worldNameJa
  if (edits.areas) e.areas = edits.areas
  if (edits.sketch) e.sketch = { land: await packF32(edits.sketch.land), ranges: edits.sketch.ranges }
  if (edits.frozen) e.frozen = { ...edits.frozen, elev: await packF32(edits.frozen.elev) }
  if (edits.planTerrain) e.planTerrain = await packF32(edits.planTerrain)
  if (edits.realmNames) e.realmNames = edits.realmNames
  if (world) doc.world.snapshot = await packWorld(world)
  return JSON.stringify(doc)
}

export async function parseProject(text: string): Promise<{ params: WorldParams; edits: WorldEdits; world?: World; name?: string }> {
  const doc = JSON.parse(text) as ProjectDoc
  if (doc.app !== 'cartographer' || !doc.world?.params) throw new Error('不是 Cartographer 项目文件')
  const e = doc.world.edits ?? {}
  const edits: WorldEdits = {}
  if (e.terrain) {
    edits.terrain = await unpackF32(e.terrain)
    edits.terrainRev = 1
  }
  if (e.temp) edits.temp = await unpackF32(e.temp)
  if (e.rain) edits.rain = await unpackF32(e.rain)
  if (e.labels) edits.labels = e.labels
  if (e.regions) edits.regions = Int16Array.from(await unpackF32(e.regions))
  edits.regionMeta = e.regionMeta
  edits.worldName = e.worldName
  edits.worldNameZh = e.worldNameZh
  edits.worldNameJa = e.worldNameJa
  if (e.areas) edits.areas = e.areas
  if (e.sketch) {
    edits.sketch = { land: await unpackF32(e.sketch.land), ranges: e.sketch.ranges }
    bumpSketch(edits)
  }
  if (e.frozen) {
    edits.frozen = { ...e.frozen, elev: await unpackF32(e.frozen.elev) }
    edits.frozenRev = Date.now()
  }
  if (e.planTerrain) edits.planTerrain = await unpackF32(e.planTerrain)
  if (e.realmNames) edits.realmNames = e.realmNames
  const params = doc.world.params
  const world = doc.world.snapshot ? await unpackWorld(doc.world.snapshot, params) : undefined
  return { params, edits, world, name: doc.name }
}

/** 分辨率变了：增量图双线性重采样，地点坐标等比缩放 */
export function resampleEdits(edits: WorldEdits, W0: number, H0: number, W: number, H: number): WorldEdits {
  const rs = (a?: Float32Array) => {
    if (!a || a.length !== W0 * H0) return undefined
    const out = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      const fy = Math.min(H0 - 1.001, (y / (H - 1)) * (H0 - 1))
      const y0 = Math.floor(fy)
      const ty = fy - y0
      for (let x = 0; x < W; x++) {
        const fx = Math.min(W0 - 1.001, (x / (W - 1)) * (W0 - 1))
        const x0 = Math.floor(fx)
        const tx = fx - x0
        const i = y0 * W0 + x0
        out[y * W + x] = (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + W0] * (1 - tx) + a[i + W0 + 1] * tx) * ty
      }
    }
    return out
  }
  const sx = (W - 1) / (W0 - 1)
  const sy = (H - 1) / (H0 - 1)
  const out: WorldEdits = {
    terrain: rs(edits.terrain),
    temp: rs(edits.temp),
    rain: rs(edits.rain),
    labels: edits.labels?.map((l) => ({ ...l, x: l.x * sx, y: l.y * sy, span: l.span * sx })),
    regions: edits.regions && edits.regions.length === W0 * H0 ? resampleNearest(edits.regions, W0, H0, W, H) : undefined,
    regionMeta: edits.regionMeta,
    worldName: edits.worldName,
    worldNameZh: edits.worldNameZh,
    worldNameJa: edits.worldNameJa,
    terrainRev: (edits.terrainRev ?? 0) + 1,
    areas: edits.areas?.map((a) => ({ ...a, poly: a.poly.map(([x, y]) => [x * sx, y * sy] as [number, number]), at: [a.at[0] * sx, a.at[1] * sy] as [number, number] })),
    sketch: edits.sketch && {
      land: rs(edits.sketch.land) ?? new Float32Array(W * H),
      ranges: edits.sketch.ranges.map((r) => ({ ...r, pts: r.pts.map((v, j) => v * (j % 2 ? sy : sx)) })),
    },
  }
  if (out.sketch) bumpSketch(out)
  return out
}

export function hasEdits(e: WorldEdits) {
  return !!(e.terrain || e.temp || e.rain || e.labels || e.regions || e.areas || e.sketch || e.frozen)
}

/**
 * 撤销用的快照：会被原地修改的数组与列表复制一份，其余（标量、定稿地形这类不再改动的数据）直接共用。
 * 草图的陆地掩码写时复制：快照与当前共用同一份，编辑器动笔改陆地前先换成副本（见 EditorView.ownLand）
 */
export function snapshotEdits(e: WorldEdits): WorldEdits {
  return {
    ...e,
    terrain: e.terrain && Float32Array.from(e.terrain),
    temp: e.temp && Float32Array.from(e.temp),
    rain: e.rain && Float32Array.from(e.rain),
    labels: e.labels?.map((l) => ({ ...l })),
    regions: e.regions && Int16Array.from(e.regions),
    regionMeta: e.regionMeta?.map((m) => ({ ...m })),
    areas: e.areas?.map((a) => ({ ...a, poly: a.poly.map((p) => [p[0], p[1]] as [number, number]), at: [a.at[0], a.at[1]] as [number, number] })),
    sketch: e.sketch && { land: e.sketch.land, ranges: e.sketch.ranges.map((r) => ({ ...r, pts: r.pts.slice() })) },
  }
}

function resampleNearest(a: Int16Array, W0: number, H0: number, W: number, H: number) {
  const out = new Int16Array(W * H)
  for (let y = 0; y < H; y++) {
    const sy = Math.min(H0 - 1, Math.round((y / (H - 1)) * (H0 - 1)))
    for (let x = 0; x < W; x++) out[y * W + x] = a[sy * W0 + Math.min(W0 - 1, Math.round((x / (W - 1)) * (W0 - 1)))]
  }
  return out
}
