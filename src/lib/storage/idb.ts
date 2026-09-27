export type StoreName = 'folders' | 'files' | 'contents' | 'index' | 'sources' | 'cache' | 'base'

const STORES: StoreName[] = ['folders', 'files', 'contents', 'index', 'sources', 'cache', 'base']
const VERSION = 1

const openings = new Map<string, Promise<IDBDatabase>>()

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function openDatabase(name: string): Promise<IDBDatabase> {
  const existing = openings.get(name)
  if (existing) return existing
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  openings.set(name, opening)
  return opening
}

export async function deleteDatabase(name: string): Promise<void> {
  const opening = openings.get(name)
  if (opening) {
    ;(await opening).close()
    openings.delete(name)
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}

export class KeyValueStore {
  constructor(private readonly databaseName: string) {}

  private async store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await openDatabase(this.databaseName)
    return db.transaction(name, mode).objectStore(name)
  }

  async get<T>(name: StoreName, key: string): Promise<T | undefined> {
    return request((await this.store(name, 'readonly')).get(key)) as Promise<T | undefined>
  }

  async put<T>(name: StoreName, key: string, value: T): Promise<void> {
    await request((await this.store(name, 'readwrite')).put(value, key))
  }

  async delete(name: StoreName, key: string): Promise<void> {
    await request((await this.store(name, 'readwrite')).delete(key))
  }

  async all<T>(name: StoreName): Promise<T[]> {
    return request((await this.store(name, 'readonly')).getAll()) as Promise<T[]>
  }

  async keys(name: StoreName): Promise<string[]> {
    return request((await this.store(name, 'readonly')).getAllKeys()) as Promise<string[]>
  }

  async clear(name: StoreName): Promise<void> {
    await request((await this.store(name, 'readwrite')).clear())
  }
}
