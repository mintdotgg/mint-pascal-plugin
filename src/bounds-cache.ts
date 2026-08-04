import type { GlbBounds } from './types'

const DB_NAME = 'mint-pascal-plugin'
const STORE_NAME = 'glb-bounds'
const DB_VERSION = 1

export function boundsCacheKey(modelId: string, updatedAt: string | null) {
  return `${modelId}:${updatedAt ?? 'unknown'}`
}

export function isGlbBounds(value: unknown): value is GlbBounds {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return ['min', 'max', 'size', 'center'].every((key) => {
    const tuple = record[key]
    return (
      Array.isArray(tuple) &&
      tuple.length === 3 &&
      tuple.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    )
  })
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readCachedBounds(key: string): Promise<GlbBounds | null> {
  const database = await openDatabase()
  if (!database) return null
  return await new Promise<GlbBounds | null>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(isGlbBounds(request.result) ? request.result : null)
    request.onerror = () => reject(request.error)
  }).finally(() => database.close())
}

export async function writeCachedBounds(key: string, bounds: GlbBounds): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(bounds, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  }).finally(() => database.close())
}
