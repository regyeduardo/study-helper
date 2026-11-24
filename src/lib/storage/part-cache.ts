import type { FileSidecar } from '@/types/domain'
import { KeyValueStore } from '@/lib/storage/idb'

/**
 * This browser's copy of the content of the App's notes (spec 003, história 6): each part (`<item>/<part>`) at the last version this
 * device read or wrote, in IndexedDB, so a note opens at once and without internet after a reload. It has a limit: full, what was used
 * longest ago leaves first. What was written without internet waits apart, whole, until it goes up: the limit never takes it.
 */

/** About 200 MB of text: notes, transcriptions and Atas, never the media. */
export const PART_CACHE_LIMIT = 200 * 1024 * 1024

interface Entry {
  version: string
  bytes: number
  usedAt: number
}

/** A note written here without internet, as it was saved: it goes up when the internet comes back. */
export interface HeldNote {
  id: string
  sidecar: FileSidecar
  /** Absent when only the sidecar changed (a highlight, the cards). */
  content?: string
  at: string
}

/** A note the server refused for good after it waited (deleted on another device, the structure off): what was written here, kept apart. */
export interface RefusedNote extends HeldNote {
  /** The server's code: `not_found`, `app_off`… */
  reason: string
  refusedAt: string
}

const sizeOf = (content: string) => new TextEncoder().encode(content).length

export function partCacheName(accountId: string): string {
  return `study-helper-partes-${accountId}`
}

export class PartCache {
  private readonly db: KeyValueStore
  /** Apart from the copy, so clearing it never takes what the server refused. */
  private readonly refusedDb: KeyValueStore
  private readonly limitBytes: number
  private last = 0

  constructor(
    readonly accountId: string,
    options: { limitBytes?: number } = {},
  ) {
    this.db = new KeyValueStore(partCacheName(accountId))
    this.refusedDb = new KeyValueStore(`study-helper-recusadas-${accountId}`)
    this.limitBytes = options.limitBytes ?? PART_CACHE_LIMIT
  }

  /** The content of the part at exactly that version, or undefined; reading it counts as a use. */
  async get(item: string, part: string, version: string): Promise<string | undefined> {
    const key = `${item}/${part}`
    const entry = await this.db.get<Entry>('cache', key)
    if (!entry || entry.version !== version) return undefined
    const content = await this.db.get<string>('contents', key)
    if (content === undefined) return undefined
    await this.db.put('cache', key, { ...entry, usedAt: this.now() })
    return content
  }

  /** Keeps the part at that version (an older one of the same part goes), then makes room if the cache passed its limit. */
  async put(item: string, part: string, version: string, content: string): Promise<void> {
    const key = `${item}/${part}`
    await this.db.put('contents', key, content)
    await this.db.put('cache', key, { version, bytes: sizeOf(content), usedAt: this.now() } satisfies Entry)
    await this.makeRoom()
  }

  /** Keeps a note written without internet; a newer write of the same note takes its place (and keeps the text it did not bring). */
  async hold(note: HeldNote): Promise<HeldNote> {
    const before = await this.db.get<HeldNote>('files', note.id)
    const held = { ...note, ...(note.content === undefined && before?.content !== undefined ? { content: before.content } : {}) }
    await this.db.put('files', note.id, held)
    return held
  }

  /** What waits to go up, oldest first. */
  async held(): Promise<HeldNote[]> {
    return (await this.db.all<HeldNote>('files')).sort((a, b) => a.at.localeCompare(b.at))
  }

  async release(id: string): Promise<void> {
    await this.db.delete('files', id)
  }

  /** Keeps a version the server refused for good; a later refusal of the same note is kept too. */
  async keepRefused(note: HeldNote, reason: string): Promise<void> {
    const refusedAt = new Date().toISOString()
    await this.refusedDb.put('files', `${note.id}@${refusedAt}`, { ...note, reason, refusedAt } satisfies RefusedNote)
  }

  async refused(): Promise<RefusedNote[]> {
    return (await this.refusedDb.all<RefusedNote>('files')).sort((a, b) => a.refusedAt.localeCompare(b.refusedAt))
  }

  /** Every part of an item (deleted for good). */
  async dropItem(item: string): Promise<void> {
    for (const key of await this.db.keys('cache')) {
      if (!key.startsWith(`${item}/`)) continue
      await this.db.delete('cache', key)
      await this.db.delete('contents', key)
    }
  }

  /** How much the cache keeps now. */
  async bytes(): Promise<number> {
    return (await this.db.all<Entry>('cache')).reduce((sum, entry) => sum + entry.bytes, 0)
  }

  /** Clears the copy; what waits to go up has no copy anywhere else and stays. */
  async forget(): Promise<void> {
    await this.db.clear('cache')
    await this.db.clear('contents')
  }

  /** A clock that never repeats, so two uses in the same millisecond keep their order. */
  private now(): number {
    this.last = Math.max(Date.now(), this.last + 1)
    return this.last
  }

  private async makeRoom(): Promise<void> {
    const keys = await this.db.keys('cache')
    const entries = await this.db.all<Entry>('cache')
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    if (total <= this.limitBytes) return
    const leaving = keys.map((key, index) => ({ key, entry: entries[index] }))
    leaving.sort((a, b) => a.entry.usedAt - b.entry.usedAt)
    for (const { key, entry } of leaving) {
      if (total <= this.limitBytes) break
      await this.db.delete('cache', key)
      await this.db.delete('contents', key)
      total -= entry.bytes
    }
  }
}
