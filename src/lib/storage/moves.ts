import type { FileMeta, FileSidecar, FolderMeta } from '@/types/domain'
import { apiMessage } from '@/controllers/api.controller'
import type { CombinedRepository, Side } from '@/lib/storage/combined-repository'
import { KeyValueStore } from '@/lib/storage/idb'
import { filePlaceOf, folderPlaceOf } from '@/lib/storage/place'

/** pendente → copiando → conferido → apagando-da-origem → feito; falhou keeps the reason, and "Tentar de novo" goes back to pendente (data-model, história 9). */
export type MoveState = 'pendente' | 'copiando' | 'conferido' | 'apagando-da-origem' | 'feito' | 'falhou'

export interface MoveRecord {
  /** The item's id: it never changes, so a move started again never duplicates. */
  id: string
  kind: 'file' | 'folder'
  name: string
  from: Side
  to: Side
  state: MoveState
  reason?: string
  /** One choice of the person (a folder with all inside it, or a "Sincronizar"). */
  batch: string
  order: number
  bytes: number
  /** Counted when the note is copied, for the summary of what came (FR-043). */
  artifacts?: number
  /** The note's media file went with it. */
  media?: boolean
  /** The media was in a temporary service and had expired: the note arrives as "Só o registro" (FR-043). */
  expired?: boolean
}

export interface MoveProgress {
  done: number
  total: number
  doneBytes: number
  totalBytes: number
  current?: string
}

/** The journal lives in this browser, one per account (`study-helper-mudancas-<conta>`): it survives a closed tab. */
export class MoveJournal {
  private readonly db: KeyValueStore

  constructor(accountId: string) {
    this.db = new KeyValueStore(`study-helper-mudancas-${accountId}`)
  }

  async all(): Promise<MoveRecord[]> {
    return (await this.db.all<MoveRecord>('files')).sort((a, b) => a.order - b.order)
  }

  async put(record: MoveRecord): Promise<void> {
    await this.db.put('files', record.id, record)
  }

  /** A move the person cancelled before it started: it leaves the journal, so the next opening does not take it up again. */
  async remove(id: string): Promise<void> {
    await this.db.delete('files', id)
  }

  async clearDone(): Promise<void> {
    for (const record of await this.all()) if (record.state === 'feito') await this.db.delete('files', record.id)
  }
}

/** A note as it was before it went to the App, kept in this browser (FR-041: the original is never deleted). */
export interface OriginalCopy {
  id: string
  name: string
  from: Side
  at: string
  content: string
  sidecar: FileSidecar
}

/** The originals of what went to the App from this browser, one store per account (`study-helper-copias-<conta>`). */
export class OriginalCopies {
  private readonly db: KeyValueStore

  constructor(accountId: string) {
    this.db = new KeyValueStore(`study-helper-copias-${accountId}`)
  }

  async all(): Promise<OriginalCopy[]> {
    return this.db.all<OriginalCopy>('files')
  }

  async put(copy: OriginalCopy): Promise<void> {
    await this.db.put('files', copy.id, copy)
  }
}

/** While a move runs the item is on both sides: until it is checked at the destination, the library shows the origin. */
export function showingOf(records: MoveRecord[]): (id: string) => Side | undefined {
  const open = new Map(records.filter(record => record.state !== 'feito').map(record => [record.id, record]))
  return id => {
    const record = open.get(id)
    if (!record) return undefined
    return record.state === 'apagando-da-origem' ? record.to : record.from
  }
}

interface Tree {
  folders: FolderMeta[]
  files: FileMeta[]
}

/**
 * What a choice moves: the item and, for a folder, every folder and note inside it that follows it (no own choice, or the same choice),
 * in the order a move needs (folders from the top, then notes). Only what is on the other side moves. The Lixeira moves with its folder.
 */
export function planMoves(repo: CombinedRepository, tree: Tree, ids: string[], to: Side, batch: string, sizeOf: (file: FileMeta) => number): MoveRecord[] {
  const folders: FolderMeta[] = []
  const files: FileMeta[] = []
  const follows = (place: FolderMeta['place']) => !place || place === to || (place === 'app' && to === 'drive')
  const visit = (folder: FolderMeta) => {
    if (folders.some(item => item.id === folder.id)) return
    folders.push(folder)
    for (const child of tree.folders.filter(item => item.parentId === folder.id && follows(item.place))) visit(child)
    for (const file of tree.files.filter(item => item.folderId === folder.id && follows(item.place))) if (!files.some(item => item.id === file.id)) files.push(file)
  }
  for (const id of ids) {
    const folder = tree.folders.find(item => item.id === id)
    if (folder) visit(folder)
    const file = tree.files.find(item => item.id === id)
    if (file && !files.some(item => item.id === file.id)) files.push(file)
  }
  const on = (id: string) => repo.sideOf(id)
  const records: MoveRecord[] = []
  for (const folder of folders) if (on(folder.id) && on(folder.id) !== to) records.push({ id: folder.id, kind: 'folder', name: folder.name, from: on(folder.id)!, to, state: 'pendente', batch, order: records.length, bytes: 0 })
  for (const file of files) if (on(file.id) && on(file.id) !== to) records.push({ id: file.id, kind: 'file', name: file.name, from: on(file.id)!, to, state: 'pendente', batch, order: records.length, bytes: sizeOf(file) })
  return records
}

/** JSON with the keys in order: a place that stores JSON (the App's server) may give the same fields back in another order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The parts of a note that must arrive the same: its text and everything in its sidecar but the stamp of the write and its place (what a move changes). */
function sameNote(a: { content: string; sidecar: FileSidecar }, b: { content: string; sidecar: FileSidecar }): boolean {
  const plain = ({ meta: { updated: _updated, awayFolderId: _away, folderId: _folder, place: _place, ...meta }, ...rest }: FileSidecar) => stable({ ...rest, meta })
  return a.content === b.content && plain(a.sidecar) === plain(b.sidecar)
}

/** The media of the note in hand on its way: brought from the origin ('down'), then sent to the destination ('up'). */
export interface MediaProgress {
  step: 'down' | 'up'
  from: Side
  to: Side
  name: string
  doneBytes: number
  totalBytes: number
}

export interface RunOptions {
  /** Called after each step, with the journal as it is now (the window shows the progress). */
  onProgress?: (progress: MoveProgress) => void
  /** Tests stop a move in the middle to prove it picks up where it stopped. */
  stopAfter?: (record: MoveRecord) => boolean
  /**
   * "Cancelar": from then on, no move that did not start yet starts. It leaves the journal and comes back still `pendente` (the item
   * stays whole where it is); one already under way ends first, and a folder already made at the destination ends as always.
   */
  cancelled?: () => boolean
  /**
   * Bringing the library to the App (FR-041) never deletes the original: a note of the Google Drive stays there (with the account's
   * hierarchy the Drive only keeps content, so it does not show twice); any other original is kept in these copies before it leaves.
   */
  copies?: OriginalCopies
  /** Cancelar of the window: the media in hand stops at once and its note stays whole where it was. */
  signal?: AbortSignal
  /** How much of the media in hand went (a media of hundreds of MB is most of the time of a move). */
  onMedia?: (progress: MediaProgress) => void
}

export class MoveStopped extends Error {}

/**
 * Runs every open move of the journal, from where each one stopped (FR-054): copy to the destination, check that the same note arrived,
 * take it out of the origin, done. A note's file kept in the library goes with it. A folder is taken out of the origin only after
 * everything inside it moved; a Drive folder that still holds something is never deleted. A failure keeps the origin intact.
 */
export async function runMoves(repo: CombinedRepository, journal: MoveJournal, tree: Tree, options: RunOptions = {}): Promise<MoveRecord[]> {
  const records = await journal.all()
  // with the account's hierarchy a folder has no place (spec 005): a folder's move left from before has nothing to do, failed or not
  if (repo.hierarchy) {
    for (const record of records) {
      if (record.kind !== 'folder' || record.state === 'feito') continue
      Object.assign(record, { state: 'feito' })
      delete record.reason
      await journal.put(record)
    }
  }
  const open = records.filter(record => record.state !== 'feito' && record.state !== 'falhou')
  const total = open.length
  const totalBytes = open.reduce((sum, record) => sum + record.bytes, 0)
  let done = 0
  let doneBytes = 0
  const save = async (record: MoveRecord, state: MoveState, reason?: string) => {
    Object.assign(record, { state, ...(reason ? { reason } : {}) })
    if (!reason) delete record.reason
    await journal.put(record)
    repo.setShowing(showingOf(records))
    options.onProgress?.({ done, total, doneBytes, totalBytes, current: record.name })
    if (options.stopAfter?.(record)) throw new MoveStopped()
  }
  const folderOf = (id: string) => tree.folders.find(folder => folder.id === id)
  const folderRecords = open.filter(record => record.kind === 'folder')
  const dropped = async (record: MoveRecord) => {
    if (record.state !== 'pendente' || !options.cancelled?.()) return false
    await journal.remove(record.id)
    return true
  }
  try {
    // 1) folders are made at the destination from the top, so the notes have where to go
    for (const record of folderRecords) {
      if (record.state === 'pendente' || record.state === 'copiando') {
        if (await dropped(record)) continue
        const folder = folderOf(record.id)
        if (!folder) {
          await save(record, 'falhou', 'A pasta não existe mais.')
          continue
        }
        await save(record, 'copiando')
        await repo.writeFolderTo(record.to, folder)
        repo.adopt(record.id, record.to)
        await save(record, 'conferido')
      } else repo.adopt(record.id, record.to)
    }
    // 2) notes, one by one
    for (const record of open.filter(item => item.kind === 'file')) {
      try {
        if (await dropped(record)) continue
        if (record.state === 'pendente' || record.state === 'copiando') {
          await save(record, 'copiando')
          const from = await repo.readFrom(record.from, record.id)
          let sidecar = from.sidecar
          const origin = sidecar.meta.origin
          record.artifacts = sidecar.artifacts?.length ?? 0
          record.expired = Boolean(origin?.storedUrl && origin.storage !== 'none' && origin.storage !== 'drive' && !origin.removedAt && origin.expiresAt && Date.parse(origin.expiresAt) < Date.now())
          // the file is gone from the temporary service: at the destination the note is "Só o registro" (FR-043)
          if (record.expired && sidecar.meta.kept === 'arquivo') sidecar = { ...sidecar, meta: { ...sidecar.meta, kept: 'registro' } }
          // the note's file kept in the library goes with it, under a new address at the destination
          if (origin?.storage === 'drive' && origin.storedFileId && !origin.removedAt && !(record.from === 'drive' && record.to === 'drive')) {
            const media = (step: MediaProgress['step']) => (doneBytes: number, totalBytes: number) =>
              options.onMedia?.({ step, from: record.from, to: record.to, name: record.name, doneBytes, totalBytes })
            const blob = await repo.repoFor(record.from).getSource(origin.storedFileId, { signal: options.signal, onProgress: media('down'), sizeBytes: origin.sizeBytes })
            const stored = await repo.repoFor(record.to).putSource(record.id, blob, origin.name, { signal: options.signal, onProgress: media('up') })
            sidecar = { ...sidecar, meta: { ...sidecar.meta, origin: { ...origin, storedFileId: stored.ref } } }
            record.media = true
          }
          await repo.writeFileTo(record.to, sidecar, from.content)
          const arrived = await repo.readFrom(record.to, record.id)
          if (!sameNote({ content: from.content, sidecar }, arrived)) throw new Error('A cópia no destino não bateu com a original; nada foi apagado.')
          await save(record, 'conferido')
        }
        if (record.state === 'conferido' || record.state === 'apagando-da-origem') {
          await save(record, 'apagando-da-origem')
          const old = await repo.readFrom(record.from, record.id).catch(() => null)
          const bringing = record.to === 'app'
          // FR-041: a note of the Google Drive stays whole there, as content the account's hierarchy no longer points to
          const keepInDrive = bringing && record.from === 'drive' && Boolean(repo.hierarchy)
          if (!keepInDrive) {
            if (bringing && old) await options.copies?.put({ id: record.id, name: record.name, from: record.from, at: new Date().toISOString(), content: old.content, sidecar: old.sidecar })
            await repo.removeFrom(record.from, record.id)
            const kept = old?.sidecar.meta.origin
            const arrived = (await repo.readFrom(record.to, record.id)).sidecar.meta.origin
            // the original's media file stays too when the note came to the App
            if (!bringing && kept?.storedFileId && kept.storedFileId !== arrived?.storedFileId) await repo.repoFor(record.from).removeSource(kept.storedFileId).catch(() => undefined)
          }
          repo.adopt(record.id, record.to)
          done++
          doneBytes += record.bytes
          await save(record, 'feito')
        }
      } catch (error) {
        if (error instanceof MoveStopped) throw error
        // Cancelar in the middle of its media: the note never left the origin, so it stays there whole, as one that did not start
        if (options.signal?.aborted && (record.state === 'copiando' || record.state === 'pendente')) {
          record.state = 'pendente'
          await journal.remove(record.id)
          repo.setShowing(showingOf(records))
          continue
        }
        await save(record, 'falhou', apiMessage(error))
      }
    }
    // 3) a folder leaves the origin last, when nothing of the library is left in it there
    for (const record of [...folderRecords].reverse()) {
      if (record.state !== 'conferido' && record.state !== 'apagando-da-origem') continue
      const stillThere = open.some(item => item.kind === 'file' && item.state === 'falhou' && tree.files.find(file => file.id === item.id)?.folderId === record.id)
      if (stillThere) {
        await save(record, 'falhou', 'Uma nota dela não mudou de lugar; a pasta ficou nos dois lugares até tentar de novo.')
        continue
      }
      try {
        await save(record, 'apagando-da-origem')
        // notes and folders that stay where they were (an own choice) leave the old folder first, so nothing is deleted with it
        for (const folder of tree.folders.filter(item => item.parentId === record.id && repo.sideOf(item.id) === record.from)) await repo.writeFolderTo(record.from, folder)
        for (const file of tree.files.filter(item => item.folderId === record.id && repo.sideOf(item.id) === record.from)) {
          const kept = await repo.readFrom(record.from, file.id)
          await repo.writeFileTo(record.from, kept.sidecar)
        }
        await repo.removeFolderFrom(record.from, record.id)
        done++
        await save(record, 'feito')
      } catch (error) {
        if (error instanceof MoveStopped) throw error
        await save(record, 'falhou', apiMessage(error))
      }
    }
  } catch (error) {
    if (!(error instanceof MoveStopped)) throw error
  }
  repo.setShowing(showingOf(records))
  return records
}

/** "Tentar de novo": a failed move goes back to the start; what already arrived is checked again, never copied twice. */
export async function retryFailed(journal: MoveJournal): Promise<void> {
  for (const record of await journal.all()) if (record.state === 'falhou') await journal.put({ ...record, state: 'pendente', reason: undefined })
}

/** The place a note or folder would have with the tree as it is (a new choice shows where it goes before the move). */
export function sideOfItem(tree: Tree, id: string): Side {
  const folder = tree.folders.find(item => item.id === id)
  const place = folder ? folderPlaceOf(folder.id, tree.folders, 'drive') : filePlaceOf(tree.files.find(item => item.id === id)!, tree.folders, 'drive')
  return place === 'local' ? 'local' : place === 'app' ? 'app' : 'drive'
}
