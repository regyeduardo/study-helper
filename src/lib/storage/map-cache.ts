import type { LibraryRow, LibraryRowFields } from '@/controllers/library-api.controller'

/**
 * This browser's copy of the account's map (spec 005, R7, data-model "Navegador"): the rows as the server sent them, the last seq,
 * the changes not sent yet (in order) and where the migration stopped. The hierarchy opens from it at once and works without internet.
 */

/** A change made on this device and not on the server yet. `base`: the row as the server had it before the change (the merge's base). */
export interface OutboxChange {
  op: 'put' | 'delete'
  id: string
  row?: LibraryRowFields
  baseRev: number
  base?: LibraryRowFields | null
  at: string
}

export interface MigrationState {
  step: string
  backupId?: string
  sent: string[]
  at: string
}

type Store = 'rows' | 'meta' | 'outbox' | 'migration'

const VERSION = 1
const openings = new Map<string, Promise<IDBDatabase>>()

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function open(name: string): Promise<IDBDatabase> {
  const existing = openings.get(name)
  if (existing) return existing
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('rows')) db.createObjectStore('rows', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { autoIncrement: true })
      if (!db.objectStoreNames.contains('migration')) db.createObjectStore('migration')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  openings.set(name, opening)
  return opening
}

export function mapCacheName(accountId: string): string {
  return `study-helper-map-${accountId}`
}

export class MapCache {
  private readonly name: string

  constructor(readonly accountId: string) {
    this.name = mapCacheName(accountId)
  }

  private async store(name: Store, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await open(this.name)).transaction(name, mode).objectStore(name)
  }

  /** Whether the map was ever received here (an empty hierarchy is a copy too). */
  async hasCopy(): Promise<boolean> {
    return (await request((await this.store('meta', 'readonly')).get('seq'))) !== undefined
  }

  async seq(): Promise<number> {
    return Number((await request((await this.store('meta', 'readonly')).get('seq'))) ?? 0)
  }

  async rows(): Promise<LibraryRow[]> {
    return request((await this.store('rows', 'readonly')).getAll()) as Promise<LibraryRow[]>
  }

  /** Rows (each replaces the one with its id) and the seq they bring, in one go; the seq never goes back. */
  async saveRows(rows: LibraryRow[], seq: number): Promise<void> {
    const transaction = (await open(this.name)).transaction(['rows', 'meta'], 'readwrite')
    const meta = transaction.objectStore('meta')
    const store = transaction.objectStore('rows')
    for (const row of rows) store.put(row)
    const known = meta.get('seq')
    known.onsuccess = () => meta.put(Math.max(Number(known.result ?? 0), seq), 'seq')
    await done(transaction)
  }

  /** Rows that never reached the server (a change refused or undone before it went up). */
  async dropRows(ids: string[]): Promise<void> {
    const transaction = (await open(this.name)).transaction('rows', 'readwrite')
    for (const id of ids) transaction.objectStore('rows').delete(id)
    await done(transaction)
  }

  async queue(change: OutboxChange): Promise<number> {
    return Number(await request((await this.store('outbox', 'readwrite')).add(change)))
  }

  /** The changes not sent yet, in the order they were made. */
  async outbox(): Promise<{ key: number; change: OutboxChange }[]> {
    const store = await this.store('outbox', 'readonly')
    const [keys, changes] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    return keys.map((key, index) => ({ key: Number(key), change: changes[index] as OutboxChange }))
  }

  /** A newer change of the same item takes the place of the queued one. */
  async replaceQueued(key: number, change: OutboxChange): Promise<void> {
    await request((await this.store('outbox', 'readwrite')).put(change, key))
  }

  async dequeue(key: number): Promise<void> {
    await request((await this.store('outbox', 'readwrite')).delete(key))
  }

  async migration(): Promise<MigrationState | null> {
    return ((await request((await this.store('migration', 'readonly')).get('state'))) as MigrationState | undefined) ?? null
  }

  async setMigration(state: MigrationState): Promise<void> {
    await request((await this.store('migration', 'readwrite')).put(state, 'state'))
  }

  async forget(): Promise<void> {
    const opening = openings.get(this.name)
    if (opening) {
      ;(await opening).close()
      openings.delete(this.name)
    }
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this.name)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => resolve()
    })
  }
}
