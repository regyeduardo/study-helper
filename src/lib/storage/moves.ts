import type { FileMeta, FileSidecar, FolderMeta } from '@/types/domain'
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

  async clearDone(): Promise<void> {
    for (const record of await this.all()) if (record.state === 'feito') await this.db.delete('files', record.id)
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

/** The parts of a note that must arrive the same: its text and everything in its sidecar but the stamp of the write. */
function sameNote(a: { content: string; sidecar: FileSidecar }, b: { content: string; sidecar: FileSidecar }): boolean {
  const plain = ({ meta: { updated: _updated, awayFolderId: _away, folderId: _folder, ...meta }, ...rest }: FileSidecar) => stable({ ...rest, meta })
  return a.content === b.content && plain(a.sidecar) === plain(b.sidecar)
}

export interface RunOptions {
  /** Called after each step, with the journal as it is now (the window shows the progress). */
  onProgress?: (progress: MoveProgress) => void
  /** Tests stop a move in the middle to prove it picks up where it stopped. */
  stopAfter?: (record: MoveRecord) => boolean
}

export class MoveStopped extends Error {}

/**
 * Runs every open move of the journal, from where each one stopped (FR-054): copy to the destination, check that the same note arrived,
 * take it out of the origin, done. A note's file kept in the library goes with it. A folder is taken out of the origin only after
 * everything inside it moved; a Drive folder that still holds something is never deleted. A failure keeps the origin intact.
 */
export async function runMoves(repo: CombinedRepository, journal: MoveJournal, tree: Tree, options: RunOptions = {}): Promise<MoveRecord[]> {
  const records = await journal.all()
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
  try {
    // 1) folders are made at the destination from the top, so the notes have where to go
    for (const record of folderRecords) {
      if (record.state === 'pendente' || record.state === 'copiando') {
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
        if (record.state === 'pendente' || record.state === 'copiando') {
          await save(record, 'copiando')
          const from = await repo.readFrom(record.from, record.id)
          let sidecar = from.sidecar
          const origin = sidecar.meta.origin
          // the note's file kept in the library goes with it, under a new address at the destination
          if (origin?.storage === 'drive' && origin.storedFileId && !origin.removedAt && !(record.from === 'drive' && record.to === 'drive')) {
            const blob = await repo.repoFor(record.from).getSource(origin.storedFileId)
            const stored = await repo.repoFor(record.to).putSource(record.id, blob, origin.name)
            sidecar = { ...sidecar, meta: { ...sidecar.meta, origin: { ...origin, storedFileId: stored.ref } } }
          }
          await repo.writeFileTo(record.to, sidecar, from.content)
          const arrived = await repo.readFrom(record.to, record.id)
          if (!sameNote({ content: from.content, sidecar }, arrived)) throw new Error('A cópia no destino não bateu com a original; nada foi apagado.')
          await save(record, 'conferido')
        }
        if (record.state === 'conferido' || record.state === 'apagando-da-origem') {
          await save(record, 'apagando-da-origem')
          const old = await repo.readFrom(record.from, record.id).catch(() => null)
          await repo.removeFrom(record.from, record.id)
          const kept = old?.sidecar.meta.origin
          const arrived = (await repo.readFrom(record.to, record.id)).sidecar.meta.origin
          if (kept?.storedFileId && kept.storedFileId !== arrived?.storedFileId) await repo.repoFor(record.from).removeSource(kept.storedFileId).catch(() => undefined)
          repo.adopt(record.id, record.to)
          done++
          doneBytes += record.bytes
          await save(record, 'feito')
        }
      } catch (error) {
        if (error instanceof MoveStopped) throw error
        await save(record, 'falhou', error instanceof Error ? error.message : String(error))
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
        await save(record, 'falhou', error instanceof Error ? error.message : String(error))
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
