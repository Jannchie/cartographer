import genHash from 'virtual:gen-hash'
import type { World, WorldParams } from './types'

/**
 * 塑造完的世界缓存在 IndexedDB 里：同样的参数再打开直接读出，不再演算。
 * 键里带生成器源码的哈希，改了生成算法旧缓存自动作废；最多保留最近 MAX 个世界。
 * 世界本体（几十 MB）与最近使用时间分表存放：命中时只改 meta，淘汰时只按时间索引读键。
 */
const DB = 'cartographer'
const WORLDS = 'worlds'
const META = 'meta'
const MAX = 12

let dbp: Promise<IDBDatabase | null> | null = null
function open() {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 2)
      req.onupgradeneeded = () => {
        const db = req.result
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name)
        db.createObjectStore(WORLDS)
        db.createObjectStore(META, { keyPath: 'key' }).createIndex('t', 't')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}

export function worldKey(p: WorldParams) {
  const sorted = Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)))
  return `${genHash}:${JSON.stringify(sorted)}`
}

export async function loadWorld(key: string): Promise<World | null> {
  const db = await open()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction([WORLDS, META], 'readwrite')
    const req = tx.objectStore(WORLDS).get(key)
    req.onsuccess = () => {
      const world = (req.result as World | undefined) ?? null
      // 刷新最近使用时间
      if (world) tx.objectStore(META).put({ key, t: Date.now() })
      resolve(world)
    }
    req.onerror = () => resolve(null)
  })
}

/** 写入（在把数组转移给主线程之前调用：put 会当场复制一份） */
export async function saveWorld(key: string, world: World) {
  const db = await open()
  if (!db) return
  try {
    const tx = db.transaction([WORLDS, META], 'readwrite')
    const worlds = tx.objectStore(WORLDS)
    const meta = tx.objectStore(META)
    worlds.put(world, key)
    meta.put({ key, t: Date.now() })
    // 按最近使用时间从旧到新：旧版本生成器留下的条目、以及超出上限的最旧条目都删掉
    const keys = meta.index('t').getAllKeys()
    keys.onsuccess = () => {
      const rest = (keys.result as string[]).filter((k) => k !== key)
      let n = rest.length + 1
      for (const k of rest) {
        if (!k.startsWith(genHash + ':') || n > MAX) {
          worlds.delete(k)
          meta.delete(k)
          n--
        }
      }
    }
  } catch {
    // 配额不足等：缓存只是锦上添花
  }
}
