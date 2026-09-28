import { generateWorld, groundKey, type WorldCache } from './gen/world'
import type { World, WorldEdits, WorldParams } from './gen/types'
import { loadWorld, saveWorld, worldKey } from './gen/cache'

export type WorkerIn = { id: number; params: WorldParams; edits?: WorldEdits }
export type WorkerOut =
  | { id: number; type: 'progress'; stage: string; frac: number }
  | { id: number; type: 'done'; world: World; cached: boolean; ground: string }
  | { id: number; type: 'error'; message: string }

const cache: WorldCache = {}

/** 没有任何编辑：结果只由参数决定，可以整份缓存 */
const pristine = (e?: WorldEdits) => !e || Object.values(e).every((v) => v === undefined)

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const { id, params, edits } = ev.data
  const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
  try {
    const key = pristine(edits) ? worldKey(params) : null
    let world = key ? await loadWorld(key) : null
    const cached = !!world
    if (world) post({ id, type: 'progress', stage: '读取缓存', frac: 1 })
    else {
      world = generateWorld(params, (stage, frac) => post({ id, type: 'progress', stage, frac }), edits ?? {}, cache)
      // 先写缓存再转移数组（转移后缓冲区就被清空了）
      if (key) await saveWorld(key, world)
    }
    const transfer = [
      world.elevation.buffer,
      world.water.buffer,
      world.temperature.buffer,
      world.precipitation.buffer,
      world.flow.buffer,
      world.biome.buffer,
      world.coastDist.buffer,
      world.realm.buffer,
    ]
    // ground：地面（高度、气候、水文、群系）的版本；与上次相同时主线程只需换地名
    const ground = groundKey(params, edits)
    // 从持久缓存读出时 Worker 里还没有地形与地面缓存：不预热，等之后的请求真用到时由 generateWorld 按需补算
    post({ id, type: 'done', world, cached, ground }, transfer)
  } catch (e) {
    post({ id, type: 'error', message: e instanceof Error ? e.stack ?? e.message : String(e) })
  }
}
