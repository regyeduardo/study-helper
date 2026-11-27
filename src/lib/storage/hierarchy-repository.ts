import type { FileMeta, FileSidecar, FolderMeta } from '@/types/domain'
import { ApiError } from '@/controllers/api.controller'
import { deleteItem, getItem, getMap, type LibraryRow, type LibraryRowFields, putItem } from '@/controllers/library-api.controller'
import { isRecording } from '@/lib/file-types'
import { nowIso } from '@/lib/ids'
import { mapMeta } from '@/lib/storage/app-repository'
import { MapCache, type OutboxChange } from '@/lib/storage/map-cache'
import type { ConflictResolver, FieldConflict } from '@/lib/storage/repository'
import { applyFieldChoices, mergeSidecar } from '@/lib/sync/merge'

/**
 * The hierarchy of an account (spec 005, R1, R7): its folders and the list of its notes (name, kind, folder, mother note, position,
 * Lixeira and the note's place), with no content, on the account's map, for every account with a session, with or without the
 * app structure. A folder has no place; a note is in the App or in the Google Drive (a note in Local never comes here, FR-020).
 *
 * This browser keeps a copy of the map and a queue (MapCache): it opens from the copy at once and brings what changed since its seq;
 * without a connection a change goes to the copy and to the queue, which goes up by itself when the connection is back (FR-011). A
 * 409 for the rev is merged from the common base with the merges of today (`mergeSidecar`); only the same field changed on both
 * sides goes to the conflict screen (FR-012).
 */

export interface HierarchySnapshot {
  folders: FolderMeta[]
  files: FileMeta[]
}

export type NotePlace = 'app' | 'drive'

/** The meta of a folder in the map: a folder has no place, and its course text is content (it goes to a place of its own). */
function folderRowMeta(folder: FolderMeta): Record<string, unknown> {
  const { place: _place, awayParentId: _away, courseDescription: _description, courseMaterial: _material, ...rest } = folder
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
}

export function folderFields(folder: FolderMeta): LibraryRowFields {
  return {
    itemKind: 'folder',
    noteType: null,
    name: folder.name,
    folderId: folder.parentId,
    parentFileId: null,
    place: null,
    recording: false,
    position: folder.position,
    meta: folderRowMeta(folder),
    driveRef: null,
    createdAt: folder.created.at,
    updatedAt: folder.updated.at,
    trashedAt: folder.deletedAt,
    trashedWith: null,
  }
}

export function fileFields(meta: FileMeta, place: NotePlace, driveRef: string | null): LibraryRowFields {
  const { awayFolderId: _away, ...rest } = meta
  return {
    itemKind: 'file',
    noteType: meta.type,
    name: meta.name,
    folderId: meta.folderId,
    parentFileId: meta.parentFileId,
    place,
    recording: isRecording(meta),
    position: meta.position,
    meta: mapMeta({ ...rest, place }),
    driveRef: place === 'drive' ? driveRef : null,
    createdAt: meta.created.at,
    updatedAt: meta.updated.at,
    trashedAt: meta.deletedAt,
    trashedWith: meta.trashedWith ?? null,
  }
}

/** A folder as the library shows it; the columns of the row are the truth of its name, folder, position and Lixeira. */
export function folderOfRow(row: LibraryRowFields & { id: string }): FolderMeta {
  const { place: _place, awayParentId: _away, ...meta } = row.meta as unknown as FolderMeta
  return { ...meta, id: row.id, name: row.name, parentId: row.folderId, position: row.position, deletedAt: row.trashedAt, courseDescription: meta.courseDescription ?? null, courseMaterial: meta.courseMaterial ?? null }
}

/** A note as the list shows it: the source text is not in the map (it opens with the note). */
export function fileOfRow(row: LibraryRowFields & { id: string }): FileMeta {
  const { trashedWith: _with, awayFolderId: _away, ...meta } = row.meta as unknown as FileMeta
  return {
    ...meta,
    id: row.id,
    name: row.name,
    folderId: row.folderId,
    parentFileId: row.parentFileId,
    position: row.position,
    deletedAt: row.trashedAt,
    ...(row.trashedWith ? { trashedWith: row.trashedWith } : {}),
    ...(row.place ? { place: row.place } : {}),
    sourceExcerpt: meta.sourceExcerpt ?? null,
    pendingExcerpt: meta.pendingExcerpt ?? null,
  }
}

function fieldsOf(row: LibraryRow): LibraryRowFields {
  const { id: _id, parts: _parts, media: _media, noteBytes: _note, mediaBytes: _bytes, removedAt: _removed, rev: _rev, seq: _seq, placeOwn: _own, ...fields } = row
  return fields
}

function emptyRow(id: string, fields: LibraryRowFields): LibraryRow {
  return { ...fields, id, parts: {}, media: null, noteBytes: 0, mediaBytes: 0, removedAt: null, rev: 0, seq: 0 }
}

/** An item of a row, in the shape the merges of today take (a sidecar with only the meta). */
function asSidecar(row: LibraryRowFields & { id: string }): FileSidecar {
  const meta = row.itemKind === 'folder' ? (folderOfRow(row) as unknown as FileMeta) : fileOfRow(row)
  return { meta, questions: [], attempts: [], highlights: [] }
}

const FOLDER_LABELS: Record<string, string> = { parentId: 'Pasta', color: 'Cor', deletedAt: 'Lixeira', isCourse: 'Curso' }

const isOffline = (error: unknown) => error instanceof ApiError && error.code === 'offline'

export class HierarchyRepository {
  /** What this device shows: the server's rows with this device's changes not sent yet on top (`rev` is always the server's). */
  private rows = new Map<string, LibraryRow>()
  private seq = 0
  private resolver: ConflictResolver | null = null
  private flushing: Promise<unknown> = Promise.resolve()
  /** The queued change being sent right now: a newer change of the same item goes in a new entry. */
  private sending: number | null = null
  /** False after the server did not answer; true again at the next answer. */
  online = true
  /** Told whenever the queue or the connection changes: the foot of the sidebar says it (FR-011). */
  onState: ((state: { pending: number; online: boolean }) => void) | null = null

  constructor(
    readonly accountId: string,
    private readonly cache = new MapCache(accountId),
  ) {}

  /** What this device already has of the map (the live channel says it to the server). */
  get currentSeq(): number {
    return this.seq
  }

  setConflictResolver(resolver: ConflictResolver): void {
    this.resolver = resolver
  }

  /** Changes made here and not on the server yet. */
  async pending(): Promise<number> {
    return (await this.cache.outbox()).length
  }

  /** The items with a change not on the server yet. */
  async pendingIds(): Promise<string[]> {
    return [...new Set((await this.cache.outbox()).map(entry => entry.change.id))]
  }

  rowOf(id: string): LibraryRow | undefined {
    return this.rows.get(id)
  }

  snapshot(): HierarchySnapshot {
    const live = [...this.rows.values()].filter(row => !row.removedAt)
    return { folders: live.filter(row => row.itemKind === 'folder').map(row => this.made(row, folderOfRow)), files: live.filter(row => row.itemKind === 'file').map(row => this.made(row, fileOfRow)) }
  }

  /** The note or folder of each row, made once per row (a change makes a new row): what did not change is the same object, and the
   * screen does not draw it again at each sync (spec 007, T047). */
  private madeOf = new WeakMap<LibraryRow, FileMeta | FolderMeta>()
  private made<T extends FileMeta | FolderMeta>(row: LibraryRow, make: (row: LibraryRow) => T): T {
    const known = this.madeOf.get(row) as T | undefined
    if (known) return known
    const item = make(row)
    this.madeOf.set(row, item)
    return item
  }

  /**
   * From the copy at once, without waiting for the network (spec 007, R3, T028): what changed since its seq comes right after, as any
   * change of another device (the live channel says this seq to the server; its polling, when it is down), with the queue going up
   * first (`pullChanges`). A new device (no copy) brings the whole map; with the server out and no copy, the refusal.
   * What asks for the library while it loads (the session turning on the hierarchy and the App, the first sync) waits for this same
   * load: on a new device the whole map came three times at once on the phone's network (spec 007, T047).
   */
  load(): Promise<HierarchySnapshot> {
    this.loading ??= this.loadNow().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private loading: Promise<HierarchySnapshot> | null = null

  private async loadNow(): Promise<HierarchySnapshot> {
    const copy = await this.cache.hasCopy()
    this.rows = new Map((await this.cache.rows()).map(row => [row.id, row]))
    this.seq = copy ? await this.cache.seq() : 0
    if (copy) {
      await this.tell()
      return this.snapshot()
    }
    // a change the server refused already left the queue and went back to the server's: opening goes on
    await this.flush().catch(() => undefined)
    await this.pull()
    await this.tell()
    return this.snapshot()
  }

  /** The queue goes up first, then what changed on the map since this device's seq. */
  async pullChanges(): Promise<{ snapshot: HierarchySnapshot; changedFileIds: string[] }> {
    // a load in flight first: then only what came after it
    if (this.loading) await this.loading.catch(() => undefined)
    await this.flush()
    const changedFileIds = await this.pull()
    return { snapshot: this.snapshot(), changedFileIds }
  }

  async saveFolder(folder: FolderMeta): Promise<void> {
    await this.change(folder.id, folderFields(folder))
  }

  async saveFile(meta: FileMeta, place: NotePlace, driveRef: string | null = null): Promise<void> {
    await this.change(meta.id, fileFields(meta, place, driveRef))
  }

  /** A row another part of the app wrote on the server (a note in the App): this device takes it as it is. */
  async adopt(row: LibraryRow): Promise<void> {
    if ((await this.cache.outbox()).some(entry => entry.change.id === row.id)) return
    this.rows.set(row.id, row)
    await this.cache.saveRows([row], this.seq)
  }

  /** Deleted for good (the Lixeira has its own field): the row leaves the map in every device. */
  async remove(id: string): Promise<void> {
    const shown = this.rows.get(id)
    if (!shown || shown.removedAt) return
    const queued = (await this.cache.outbox()).find(entry => entry.change.id === id && entry.key !== this.sending)
    // never reached the server: it just goes away here
    if (queued && queued.change.baseRev === 0 && !queued.change.base && shown.rev === 0) {
      await this.cache.dequeue(queued.key)
      this.rows.delete(id)
      await this.cache.dropRows([id])
      return
    }
    const removed: LibraryRow = { ...shown, removedAt: nowIso(), parts: {} }
    this.rows.set(id, removed)
    await this.cache.saveRows([removed], this.seq)
    const change: OutboxChange = { op: 'delete', id, baseRev: shown.rev, at: nowIso() }
    if (queued) await this.cache.replaceQueued(queued.key, { ...change, baseRev: queued.change.baseRev })
    else await this.cache.queue(change)
    await this.flush()
  }

  /** Sends the queue in order; without a connection it stays for later. A change the server refuses leaves the queue and its error is thrown. */
  flush(): Promise<void> {
    const run = this.flushing.then(() => this.sendQueued()).finally(() => this.tell())
    this.flushing = run.catch(() => undefined)
    return run
  }

  /** Says how many changes wait and whether the account answers. */
  private async tell(): Promise<void> {
    if (!this.onState) return
    this.onState({ pending: await this.pending(), online: this.online })
  }

  async forget(): Promise<void> {
    this.rows.clear()
    this.seq = 0
    await this.cache.forget()
  }

  // ---------- inside ----------

  private async change(id: string, fields: LibraryRowFields): Promise<void> {
    const shown = this.rows.get(id)
    const row: LibraryRow = { ...(shown ?? emptyRow(id, fields)), ...fields, id, removedAt: null }
    this.rows.set(id, row)
    await this.cache.saveRows([row], this.seq)
    const queued = (await this.cache.outbox()).find(entry => entry.change.id === id && entry.key !== this.sending)
    if (queued) await this.cache.replaceQueued(queued.key, { ...queued.change, op: 'put', row: fields, at: nowIso() })
    else await this.cache.queue({ op: 'put', id, row: fields, baseRev: shown?.rev ?? 0, base: shown && shown.rev ? fieldsOf(shown) : null, at: nowIso() })
    await this.flush()
  }

  private async pull(): Promise<string[]> {
    const map = await getMap(this.seq)
    this.online = true
    // an item with a change still in the queue keeps what this device shows; the merge happens when the change goes up
    const queued = new Set((await this.cache.outbox()).map(entry => entry.change.id))
    const fresh = map.rows.filter(row => !queued.has(row.id))
    for (const row of fresh) this.rows.set(row.id, row)
    this.seq = Math.max(this.seq, map.seq)
    await this.cache.saveRows(fresh, this.seq)
    return [...new Set(map.rows.filter(row => row.itemKind === 'file').map(row => row.id))]
  }

  private async sendQueued(): Promise<void> {
    for (const { key, change } of await this.cache.outbox()) {
      this.sending = key
      try {
        await (change.op === 'delete' ? this.sendDelete(change) : this.sendPut(key, change))
        this.online = true
        await this.cache.dequeue(key)
      } catch (error) {
        if (isOffline(error)) {
          this.online = false
          return
        }
        await this.cache.dequeue(key)
        await this.restore(change.id)
        throw error
      } finally {
        this.sending = null
      }
    }
  }

  private async sendPut(key: number, change: OutboxChange): Promise<void> {
    const id = change.id
    let mine = change.row!
    let base = change.base ?? null
    let rev = this.rows.get(id)?.rev ?? change.baseRev
    for (let round = 0; round < 4; round++) {
      try {
        const saved = await putItem(id, rev, mine)
        const later = (await this.cache.outbox()).some(entry => entry.change.id === id && entry.key !== key)
        const shown = this.rows.get(id) ?? emptyRow(id, mine)
        // a newer change of the same item waits in the queue: what this device shows stays, with the new rev
        const row: LibraryRow = { ...shown, ...(later ? {} : mine), rev: saved.rev, seq: saved.seq }
        this.rows.set(id, row)
        this.follow(saved.seq)
        await this.cache.saveRows([row], this.seq)
        return
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'conflict')) throw error
        const theirs = (error.data.current as LibraryRow | null | undefined) ?? (await this.current(id))
        if (!theirs) {
          rev = 0
          continue
        }
        // deleted for good in another device: that wins
        if (theirs.removedAt) {
          this.rows.set(id, theirs)
          await this.cache.saveRows([theirs], this.seq)
          return
        }
        mine = await this.merged(base ?? fieldsOf(theirs), mine, theirs)
        base = fieldsOf(theirs)
        rev = theirs.rev
      }
    }
    throw new Error('Este item mudou em outro aparelho várias vezes seguidas. Tente de novo.')
  }

  /**
   * This device's own write came right after the seq it has: nothing of another device in between, so the copy moves along with it and
   * opening again does not bring back its own changes (spec 007, T028). With a gap, the seq stays and the next pull brings what is missing.
   */
  private follow(seq: number): void {
    if (seq === this.seq + 1) this.seq = seq
  }

  private async sendDelete(change: OutboxChange): Promise<void> {
    const id = change.id
    let rev = this.rows.get(id)?.rev ?? change.baseRev
    for (let round = 0; round < 4; round++) {
      try {
        const done = await deleteItem(id, rev)
        const row = this.rows.get(id)
        if (row) {
          const removed = { ...row, removedAt: row.removedAt ?? nowIso(), parts: {}, seq: done.seq }
          this.rows.set(id, removed)
          this.follow(done.seq)
          await this.cache.saveRows([removed], this.seq)
        }
        return
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return
        if (!(error instanceof ApiError && error.code === 'conflict')) throw error
        const theirs = (error.data.current as LibraryRow | null | undefined) ?? (await this.current(id))
        if (!theirs || theirs.removedAt) return
        rev = theirs.rev
      }
    }
    throw new Error('Este item mudou em outro aparelho várias vezes seguidas. Tente de novo.')
  }

  private async current(id: string): Promise<LibraryRow | null> {
    try {
      return await getItem(id)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  }

  /** After a refused change: what the server has, or nothing when it never had the item. */
  private async restore(id: string): Promise<void> {
    const theirs = await this.current(id).catch(() => undefined)
    if (theirs === undefined) return
    if (theirs) {
      this.rows.set(id, theirs)
      await this.cache.saveRows([theirs], this.seq)
    } else {
      this.rows.delete(id)
      await this.cache.dropRows([id])
    }
  }

  /** Field by field from the common base (the merges of today); the same field changed on both sides asks the person (FR-012). */
  private async merged(base: LibraryRowFields, mine: LibraryRowFields, theirs: LibraryRow): Promise<LibraryRowFields> {
    const id = theirs.id
    const wrap = (fields: LibraryRowFields) => asSidecar({ ...fields, id })
    const mineSide = wrap(mine)
    const theirsSide = asSidecar(theirs)
    const { merged, conflicts: found } = mergeSidecar(wrap(base), mineSide, theirsSide)
    // a different position, the place (a row field) or the Lixeira on both sides is not worth a question: this device's stays
    const conflicts: FieldConflict[] = found
      .filter(conflict => conflict.path !== 'meta.position' && conflict.path !== 'meta.place' && !(conflict.path === 'meta.deletedAt' && conflict.mine && conflict.theirs))
      .map(conflict => ({ ...conflict, label: FOLDER_LABELS[conflict.path.slice(5)] ?? conflict.label }))
    let item = merged
    if (conflicts.length && this.resolver) {
      const resolved = await this.resolver({
        kind: 'json',
        fileId: id,
        fileName: mine.name,
        fields: conflicts,
        mineStamp: { at: mineSide.meta.updated.at, deviceName: mineSide.meta.updated.deviceName },
        theirsStamp: { at: theirsSide.meta.updated.at, deviceName: theirsSide.meta.updated.deviceName },
      })
      if (resolved.kind === 'json') item = applyFieldChoices(merged, conflicts, Object.fromEntries(resolved.fields.map(field => [field.path, field.choice ?? 'mine'])) as Record<string, 'mine' | 'theirs'>)
    }
    if (mine.itemKind === 'folder') return folderFields(item.meta as unknown as FolderMeta)
    const changed = <K extends 'place' | 'driveRef'>(key: K) => (JSON.stringify(mine[key]) === JSON.stringify(base[key]) ? theirs[key] : mine[key])
    const place = (changed('place') ?? 'drive') as NotePlace
    return fileFields(item.meta, place, changed('driveRef'))
  }
}
