import { listLocalMedia } from '@/lib/recording/media-library'
import { bytesOf } from '@/lib/storage/repository'

export interface StorageBreakdown {
  mediaBytes: number
  appBytes: number
  totalBytes: number
}

const APP_DATABASE_PREFIX = 'study-helper'

function valueBytes(value: unknown): number {
  if (typeof value === 'string') return bytesOf(value)
  if (value instanceof Blob) return value.size
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength
  return bytesOf(JSON.stringify(value) ?? '')
}

function databaseBytes(name: string): Promise<number> {
  return new Promise(resolve => {
    const request = indexedDB.open(name)
    request.onerror = () => resolve(0)
    request.onsuccess = () => {
      const db = request.result
      const stores = [...db.objectStoreNames]
      if (!stores.length) {
        db.close()
        resolve(0)
        return
      }
      let total = 0
      const transaction = db.transaction(stores, 'readonly')
      for (const store of stores) {
        const cursor = transaction.objectStore(store).openCursor()
        cursor.onsuccess = () => {
          if (!cursor.result) return
          total += valueBytes(cursor.result.value)
          cursor.result.continue()
        }
      }
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => {
        db.close()
        resolve(total)
      }
    }
  })
}

async function appDataBytes(): Promise<number> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return 0
  const names = (await indexedDB.databases()).map(database => database.name ?? '').filter(name => name.startsWith(APP_DATABASE_PREFIX))
  const sizes = await Promise.all(names.map(databaseBytes))
  return sizes.reduce((sum, bytes) => sum + bytes, 0)
}

export async function storageBreakdown(): Promise<StorageBreakdown> {
  const [media, appBytes] = await Promise.all([listLocalMedia().catch(() => []), appDataBytes().catch(() => 0)])
  const mediaBytes = media.reduce((sum, item) => sum + item.size, 0)
  return { mediaBytes, appBytes, totalBytes: mediaBytes + appBytes }
}
