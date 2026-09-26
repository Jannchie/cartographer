import type { Label, WorldEdits, WorldParams } from '../gen/types'

/**
 * 项目文档：一份可保存、可重放的世界——种子与参数 + 用户的全部编辑。
 * 增量图用 deflate 压缩后以 base64 存进 JSON（大部分是 0，压缩后很小）。
 */
export interface ProjectDoc {
  app: 'cartographer'
  version: 1
  world: {
    params: WorldParams
    edits: {
      terrain?: string
      temp?: string
      rain?: string
      labels?: Label[]
      worldName?: string
      worldNameZh?: string
    }
  }
}

async function packF32(a: Float32Array): Promise<string> {
  const stream = new Blob([a.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function unpackF32(b64: string): Promise<Float32Array> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Float32Array(await new Response(stream).arrayBuffer())
}

export async function serializeProject(params: WorldParams, edits: WorldEdits): Promise<string> {
  const doc: ProjectDoc = { app: 'cartographer', version: 1, world: { params: { ...params }, edits: {} } }
  const e = doc.world.edits
  if (edits.terrain) e.terrain = await packF32(edits.terrain)
  if (edits.temp) e.temp = await packF32(edits.temp)
  if (edits.rain) e.rain = await packF32(edits.rain)
  if (edits.labels) e.labels = edits.labels.map((l) => ({ ...l }))
  e.worldName = edits.worldName
  e.worldNameZh = edits.worldNameZh
  return JSON.stringify(doc)
}

export async function parseProject(text: string): Promise<{ params: WorldParams; edits: WorldEdits }> {
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
  edits.worldName = e.worldName
  edits.worldNameZh = e.worldNameZh
  return { params: doc.world.params, edits }
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
  return {
    terrain: rs(edits.terrain),
    temp: rs(edits.temp),
    rain: rs(edits.rain),
    labels: edits.labels?.map((l) => ({ ...l, x: l.x * sx, y: l.y * sy, span: l.span * sx })),
    worldName: edits.worldName,
    worldNameZh: edits.worldNameZh,
    terrainRev: (edits.terrainRev ?? 0) + 1,
  }
}

export function hasEdits(e: WorldEdits) {
  return !!(e.terrain || e.temp || e.rain || e.labels)
}

/** 撤销用的快照（数组复制一份） */
export function snapshotEdits(e: WorldEdits): WorldEdits {
  return {
    terrain: e.terrain && Float32Array.from(e.terrain),
    temp: e.temp && Float32Array.from(e.temp),
    rain: e.rain && Float32Array.from(e.rain),
    labels: e.labels?.map((l) => ({ ...l })),
    worldName: e.worldName,
    worldNameZh: e.worldNameZh,
    terrainRev: e.terrainRev,
  }
}
