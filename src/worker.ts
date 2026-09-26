import { generateWorld, type TerrainStage } from './gen/world'
import type { World, WorldEdits, WorldParams } from './gen/types'

export type WorkerIn = { id: number; params: WorldParams; edits?: WorldEdits }
export type WorkerOut =
  | { id: number; type: 'progress'; stage: string; frac: number }
  | { id: number; type: 'done'; world: World }
  | { id: number; type: 'error'; message: string }

/** 侵蚀结束时的地形缓存：只改气候或地点时直接沿用 */
const cache: { stage?: TerrainStage } = {}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const { id, params, edits } = ev.data
  const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
  try {
    const world = generateWorld(params, (stage, frac) => post({ id, type: 'progress', stage, frac }), edits ?? {}, cache)
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
    post({ id, type: 'done', world }, transfer)
  } catch (e) {
    post({ id, type: 'error', message: e instanceof Error ? e.stack ?? e.message : String(e) })
  }
}
