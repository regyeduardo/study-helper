import type { FileMeta, FolderMeta, Snapshot } from '@/types/domain'
import { ApiError } from '@/controllers/api.controller'
import { getMap, hierarchyBackup, hierarchyDone, putItem } from '@/controllers/library-api.controller'
import type { Blocker } from '@/lib/blocking'
import { nowIso } from '@/lib/ids'
import { mapMeta } from '@/lib/storage/app-repository'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { fileFields, folderFields } from '@/lib/storage/hierarchy-repository'
import { MapCache, type MigrationState } from '@/lib/storage/map-cache'

/**
 * Takes the hierarchy of today to the account's map, once per account (spec 005, história 2, FR-013 a FR-016, R8):
 *   1. a copy of the hierarchy of today (folders and notes of every place, with no content) goes to `hierarchy_backups`;
 *   2. every folder (they have no place) and every note in the Google Drive or in the App goes to the map, by id: a second run
 *      never duplicates, and what the map already has (the App's) stays;
 *   3. the server counts the live folders and notes and only then marks `hierarchyAt`.
 * Notes in Local stay only in this browser (FR-020). No content is copied or moved (FR-015). Until the end the library works as
 * before: nothing of the way of today is deleted, so a failure leaves everything as it was, and opening again goes on from the step kept.
 */

export interface MigrationCount {
  folders: number
  files: number
}

export class MigrationCountError extends Error {}

const AT_ONCE = 6

/** Folders before the folders inside them, so the map always has the folder above. */
function byDepth(folders: FolderMeta[]): FolderMeta[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const depth = (folder: FolderMeta) => {
    let level = 0
    const seen = new Set<string>()
    for (let current = folder.parentId ? byId.get(folder.parentId) : undefined; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
      seen.add(current.id)
      level++
    }
    return level
  }
  return [...folders].sort((a, b) => depth(a) - depth(b))
}

/** Mother notes before their children (the map checks a mother has no cycle). */
function mothersFirst(files: FileMeta[]): FileMeta[] {
  const ids = new Set(files.map(file => file.id))
  return [...files].sort((a, b) => Number(Boolean(a.parentFileId && ids.has(a.parentFileId))) - Number(Boolean(b.parentFileId && ids.has(b.parentFileId))))
}

/** Runs `work` over the items, a few at a time, in order of start. */
async function inTurns<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runner = async () => {
    while (next < items.length) await work(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, runner))
}

/** What goes to the map: every folder, and the notes that are not in Local. */
export function whatGoes(repo: CombinedRepository, snapshot: Pick<Snapshot, 'folders' | 'files'>): { folders: FolderMeta[]; files: { meta: FileMeta; place: 'app' | 'drive' }[] } {
  const folders = [...new Map(snapshot.folders.map(folder => [folder.id, folder])).values()]
  const files = snapshot.files.flatMap(meta => {
    const side = repo.sideOf(meta.id) ?? 'drive'
    return side === 'local' ? [] : [{ meta, place: side }]
  })
  return { folders, files }
}

export async function migrateHierarchy(repo: CombinedRepository, snapshot: Pick<Snapshot, 'folders' | 'files'>, blocker?: Blocker): Promise<MigrationCount> {
  const cache = new MapCache(repo.accountId)
  const { folders, files } = whatGoes(repo, snapshot)
  const total = folders.length + files.length
  const kept = await cache.migration()
  const save = (state: Omit<MigrationState, 'at'>) => cache.setMigration({ ...state, at: nowIso() })

  // 1) the copy of today
  blocker?.progress({ phase: 'Guardando uma cópia', done: undefined, total: undefined })
  let backupId = kept?.backupId
  if (!backupId) {
    const copy = { folders: folders.map(folder => ({ ...folder, courseMaterial: null })), files: files.map(({ meta }) => mapMeta(meta)) }
    backupId = (await hierarchyBackup(copy)).id
    await save({ step: 'enviando', backupId, sent: [] })
  }

  // 2) what the map does not have yet, folders first; the App's notes are already there
  const sent = new Set(kept?.sent ?? [])
  const onMap = new Set((await getMap(0)).rows.filter(row => !row.removedAt).map(row => row.id))
  const drive = repo.drive instanceof DriveRepository ? repo.drive : null
  const rows = [
    ...byDepth(folders).map(folder => ({ id: folder.id, name: folder.name, fields: () => folderFields(folder) })),
    ...mothersFirst(files.map(item => item.meta)).map(meta => {
      const place = files.find(item => item.meta.id === meta.id)!.place
      return { id: meta.id, name: meta.name, fields: () => fileFields(meta, place, place === 'drive' ? (drive?.driveRefOf(meta.id) ?? null) : null) }
    }),
  ]
  let done = rows.filter(row => onMap.has(row.id) || sent.has(row.id)).length
  blocker?.progress({ phase: 'Levando as pastas e as notas', done, total })
  const missing = rows.filter(row => !onMap.has(row.id) && !sent.has(row.id))
  // folders go one level at a time (the folder above first); notes after them
  const folderIds = new Set(folders.map(folder => folder.id))
  const sendOne = async (row: (typeof rows)[number]) => {
    try {
      await putItem(row.id, 0, row.fields())
    } catch (error) {
      // already on the map (a run that stopped after sending it): nothing to do
      if (!(error instanceof ApiError && error.status === 409)) throw error
    }
    sent.add(row.id)
    done++
    blocker?.progress({ phase: 'Levando as pastas e as notas', done, total, current: row.name })
  }
  for (const row of missing.filter(item => folderIds.has(item.id))) await sendOne(row)
  await save({ step: 'enviando', backupId, sent: [...sent] })
  const notes = missing.filter(item => !folderIds.has(item.id))
  const mothers = notes.filter(item => !files.find(file => file.meta.id === item.id)?.meta.parentFileId)
  const children = notes.filter(item => !mothers.includes(item))
  for (const turn of [mothers, children]) {
    await inTurns(turn, sendOne)
    await save({ step: 'enviando', backupId, sent: [...sent] })
  }

  // 3) the server counts, and only then the hierarchy is the account's
  blocker?.progress({ phase: 'Conferindo', done: undefined, total: undefined, current: undefined })
  try {
    await hierarchyDone(backupId, folders.length, files.length)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'count_mismatch') {
      const server = error.data as { folders?: number; files?: number }
      throw new MigrationCountError(`A contagem não bateu: aqui há ${folders.length} pastas e ${files.length} notas; na conta, ${server.folders ?? '?'} e ${server.files ?? '?'}. Nada mudou de lugar.`)
    }
    throw error
  }
  await save({ step: 'feita', backupId, sent: [] })
  return { folders: folders.length, files: files.length }
}
