import { generateWorld, groundKey, terrainKey, type WorldCache } from './gen/world'
import type { World, WorldEdits, WorldParams } from './gen/types'
import { loadWorld, saveWorld, worldKey } from './gen/cache'
import { loadEarth } from './gen/earth/index'
import { loadEarthFeatures, loadEarthGrid } from './gen/earth/real'
import { earthAreas, earthResOf } from './gen/earth/realWorld'
import { inferAreas, type Area } from './gen/areas'
import { smoothRivers, type SmoothRiver } from './render/rivers'
import { physicalTexturePixels, type TexturePixels } from './render/texture'

/**
 * ground：主线程已有贴图的地面版本；与这次相同时不再算贴图。
 * world：打开世界库里存的世界——不演算，只补主线程要用的派生数据（平滑河流、贴图、区域）。
 * want 为 stage：只要当前世界侵蚀结束时的地形（定稿用），没有缓存就先演算一遍
 */
export type WorkerIn = { id: number; params: WorldParams; edits?: WorldEdits; ground?: string; world?: World; want?: 'stage' }
export type WorkerOut =
  | { id: number; type: 'progress'; stage: string; frac: number }
  | { id: number; type: 'stage'; elev: Float32Array; basins: { x: number; y: number; r: number }[] }
  | {
      id: number
      type: 'done'
      world: World
      cached: boolean
      ground: string
      /** 平滑后的河流、自动推断的区域（按这次的地名）、地表贴图像素（地面没变时省略，主线程沿用旧贴图） */
      rivers: SmoothRiver[]
      areas: Area[]
      tex?: TexturePixels
    }
  | { id: number; type: 'error'; message: string }

const cache: WorldCache = {}

/** 没有任何编辑：结果只由参数决定，可以整份缓存 */
const pristine = (e?: WorldEdits) => !e || Object.values(e).every((v) => v === undefined)

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const { id, params, edits, ground: have, world: opened, want } = ev.data
  const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
  try {
    if (want === 'stage') {
      const tk = terrainKey(params, edits)
      if (cache.stage?.key !== tk) generateWorld(params, (stage, frac) => post({ id, type: 'progress', stage, frac }), edits ?? {}, cache)
      const elev = cache.stage!.elev.slice()
      post({ id, type: 'stage', elev, basins: cache.stage!.basins.map((b) => ({ ...b })) }, [elev.buffer])
      return
    }
    const key = !opened && pristine(edits) ? worldKey(params) : null
    let world = key ? await loadWorld(key) : null
    // 打开的世界与缓存一样没有演算：统计里不显示演算耗时
    const cached = !!world || !!opened
    if (opened) {
      world = opened
      post({ id, type: 'progress', stage: '读取世界库', frac: 1 })
    } else if (world) post({ id, type: 'progress', stage: '读取缓存', frac: 1 })
    else {
      if (params.earthReal) await Promise.all([loadEarthGrid(earthResOf(params)), loadEarthFeatures()])
      else if (params.earth) await loadEarth()
      world = generateWorld(params, (stage, frac) => post({ id, type: 'progress', stage, frac }), edits ?? {}, cache)
      // 先写缓存再转移数组（转移后缓冲区就被清空了）
      if (key) await saveWorld(key, world)
    }
    // ground：地面（高度、气候、水文、群系）的版本；与上次相同时主线程只需换地名
    const ground = groundKey(params, edits)
    // 主线程要用的派生数据也在这里算好（缓存命中时同样现算，不占主线程）
    post({ id, type: 'progress', stage: '绘制地表', frac: 1 })
    const rivers = smoothRivers(world)
    const tex = ground === have ? undefined : physicalTexturePixels(world, 2)
    if (world.params.earthReal) await loadEarthFeatures()
    const areas = world.params.earthReal ? earthAreas(world) : inferAreas(world)
    const transfer: Transferable[] = [
      world.elevation.buffer,
      world.water.buffer,
      world.temperature.buffer,
      world.precipitation.buffer,
      world.flow.buffer,
      world.biome.buffer,
      world.coastDist.buffer,
      world.realm.buffer,
      ...new Set(rivers.flatMap((r) => [r.xs.buffer, r.ys.buffer, r.fl.buffer])),
    ]
    if (tex) transfer.push(tex.color.buffer, tex.roughness.buffer)
    // 从持久缓存读出时 Worker 里还没有地形与地面缓存：不预热，等之后的请求真用到时由 generateWorld 按需补算
    post({ id, type: 'done', world, cached, ground, rivers, areas, tex }, transfer)
  } catch (e) {
    post({ id, type: 'error', message: e instanceof Error ? e.stack ?? e.message : String(e) })
  }
}
