import { listLocalMedia } from '@/lib/recording/media-library'
import { WHISPER_MODEL } from '@/lib/transcription/whisper'

export type ModelId = 'whisper' | 'parakeet' | 'speakers'

export interface InstalledModel {
  id: ModelId
  name: string
  bytes: number
}

export interface StorageBreakdown {
  models: InstalledModel[]
  mediaBytes: number
  appBytes: number
  totalBytes: number | null
}

const WHISPER_CACHE = 'transformers-cache'
const SPEAKERS_CACHE = 'study-helper-models'
const PARAKEET_DB = 'parakeet-cache-db'
const PARAKEET_STORE = 'file-store'

const MODEL_NAMES: Record<ModelId, string> = {
  whisper: 'Whisper',
  parakeet: 'Parakeet',
  speakers: 'Separação de quem falou',
}

const isWhisper = (url: string) => url.includes(WHISPER_MODEL) || url.includes('onnxruntime-web')

async function openCache(name: string): Promise<Cache | null> {
  if (typeof caches === 'undefined' || !(await caches.has(name))) return null
  return caches.open(name)
}

async function cacheBytes(name: string, keep: (url: string) => boolean = () => true): Promise<number> {
  const cache = await openCache(name)
  if (!cache) return 0
  let total = 0
  for (const request of await cache.keys()) {
    if (!keep(request.url)) continue
    const response = await cache.match(request)
    if (!response) continue
    const length = Number(response.headers.get('content-length'))
    total += length > 0 ? length : (await response.blob()).size
  }
  return total
}

async function openParakeet(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  if (indexedDB.databases && !(await indexedDB.databases()).some(database => database.name === PARAKEET_DB)) return null
  return new Promise(resolve => {
    const request = indexedDB.open(PARAKEET_DB, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PARAKEET_STORE)) request.result.createObjectStore(PARAKEET_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

async function parakeetBytes(): Promise<number> {
  const db = await openParakeet()
  if (!db) return 0
  return new Promise(resolve => {
    let total = 0
    const cursor = db.transaction(PARAKEET_STORE, 'readonly').objectStore(PARAKEET_STORE).openCursor()
    cursor.onsuccess = () => {
      const current = cursor.result
      if (!current) {
        db.close()
        resolve(total)
        return
      }
      const value = current.value as { size?: unknown; byteLength?: unknown } | null
      total += typeof value?.size === 'number' ? value.size : typeof value?.byteLength === 'number' ? value.byteLength : 0
      current.continue()
    }
    cursor.onerror = () => {
      db.close()
      resolve(total)
    }
  })
}

async function clearParakeet(): Promise<void> {
  const db = await openParakeet()
  if (!db) return
  await new Promise<void>(resolve => {
    const transaction = db.transaction(PARAKEET_STORE, 'readwrite')
    transaction.objectStore(PARAKEET_STORE).clear()
    transaction.oncomplete = transaction.onerror = () => resolve()
  })
  db.close()
}

export async function installedModels(): Promise<InstalledModel[]> {
  const [whisper, parakeet, speakers] = await Promise.all([cacheBytes(WHISPER_CACHE, isWhisper).catch(() => 0), parakeetBytes().catch(() => 0), cacheBytes(SPEAKERS_CACHE).catch(() => 0)])
  const sizes: [ModelId, number][] = [
    ['whisper', whisper],
    ['parakeet', parakeet],
    ['speakers', speakers],
  ]
  return sizes.filter(([, bytes]) => bytes > 0).map(([id, bytes]) => ({ id, name: MODEL_NAMES[id], bytes }))
}

export async function deleteModel(id: ModelId): Promise<void> {
  if (id === 'parakeet') return clearParakeet()
  if (id === 'speakers') {
    if (typeof caches !== 'undefined') await caches.delete(SPEAKERS_CACHE)
    return
  }
  const cache = await openCache(WHISPER_CACHE)
  if (!cache) return
  for (const request of await cache.keys()) if (isWhisper(request.url)) await cache.delete(request)
}

export async function storageBreakdown(): Promise<StorageBreakdown> {
  const [models, media, estimate] = await Promise.all([
    installedModels(),
    listLocalMedia().catch(() => []),
    navigator.storage?.estimate ? navigator.storage.estimate().catch(() => null) : Promise.resolve(null),
  ])
  const modelBytes = models.reduce((sum, model) => sum + model.bytes, 0)
  const mediaBytes = media.reduce((sum, item) => sum + item.size, 0)
  const measured = estimate?.usage ?? null
  const totalBytes = measured === null ? null : Math.max(measured, modelBytes + mediaBytes)
  return { models, mediaBytes, appBytes: totalBytes === null ? 0 : totalBytes - modelBytes - mediaBytes, totalBytes }
}
