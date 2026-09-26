import { generateWorld } from './gen/world'
import type { World, WorldParams } from './gen/types'

export type WorkerIn = { id: number; params: WorldParams }
export type WorkerOut =
  | { id: number; type: 'progress'; stage: string; frac: number }
  | { id: number; type: 'done'; world: World }
  | { id: number; type: 'error'; message: string }

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const { id, params } = ev.data
  const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
  try {
    const world = generateWorld(params, (stage, frac) => post({ id, type: 'progress', stage, frac }))
    const transfer = [
      world.elevation.buffer,
      world.water.buffer,
      world.temperature.buffer,
      world.precipitation.buffer,
      world.flow.buffer,
      world.biome.buffer,
      world.coastDist.buffer,
    ]
    post({ id, type: 'done', world }, transfer)
  } catch (e) {
    post({ id, type: 'error', message: e instanceof Error ? e.stack ?? e.message : String(e) })
  }
}
