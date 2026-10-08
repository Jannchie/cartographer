import type { World, WorldEdits, WorldParams } from '../gen/types'

/**
 * 世界库：用户手动保存的世界，存在浏览器的 IndexedDB 里。
 * 每条存整个世界（定稿地形 + 全部场数据 + 编辑），打开时直接显示，不再按种子演算。
 * 列表信息（名字、缩略图、时间）与世界本体（几 MB）分表存放：列表只读小表。
 * 与生成缓存（gen/cache.ts）用不同的数据库：缓存升级时会清空自己的表，不能波及用户的世界
 */
const DB = 'cartographer-library'
const WORLDS = 'worlds'
const META = 'meta'

export interface LibraryMeta {
  id: string
  name: string
  /** 保存时间（毫秒） */
  savedAt: number
  /** 缩略图 data URL */
  thumb: string
  seed: string
  W: number
  H: number
}

export interface LibraryEntry {
  params: WorldParams
  edits: WorldEdits
  world: World
}

let dbp: Promise<IDBDatabase> | null = null
function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(WORLDS)) db.createObjectStore(WORLDS)
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbp = null
      reject(req.error ?? new Error('无法打开世界库'))
    }
  })
  return dbp
}

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('世界库写入失败'))
  })
}

function result<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 按保存时间从新到旧 */
export async function listWorlds(): Promise<LibraryMeta[]> {
  const db = await open()
  const all = await result(db.transaction(META).objectStore(META).getAll() as IDBRequest<LibraryMeta[]>)
  return all.sort((a, b) => b.savedAt - a.savedAt)
}

export async function putWorld(meta: LibraryMeta, entry: LibraryEntry) {
  const db = await open()
  const tx = db.transaction([WORLDS, META], 'readwrite')
  tx.objectStore(WORLDS).put(entry, meta.id)
  tx.objectStore(META).put(meta)
  await done(tx)
}

/** 只改列表信息（缩略图、名字），不碰世界本体 */
export async function putMeta(meta: LibraryMeta) {
  const db = await open()
  const tx = db.transaction(META, 'readwrite')
  tx.objectStore(META).put(meta)
  await done(tx)
}

export async function getWorld(id: string): Promise<LibraryEntry | null> {
  const db = await open()
  return (await result(db.transaction(WORLDS).objectStore(WORLDS).get(id))) ?? null
}

export async function getMeta(id: string): Promise<LibraryMeta | null> {
  const db = await open()
  return (await result(db.transaction(META).objectStore(META).get(id))) ?? null
}

export async function renameWorld(id: string, name: string) {
  const m = await getMeta(id)
  if (m) await putMeta({ ...m, name })
}

export async function deleteWorld(id: string) {
  const db = await open()
  const tx = db.transaction([WORLDS, META], 'readwrite')
  tx.objectStore(WORLDS).delete(id)
  tx.objectStore(META).delete(id)
  await done(tx)
}

export const newWorldId = () => `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
