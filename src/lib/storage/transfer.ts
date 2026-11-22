import type { FolderMeta } from '@/types/domain'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { hasTextConflict, joinHunks, mergeText } from '@/lib/sync/merge'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'

function pathKey(folders: FolderMeta[], folderId: string | null): string {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const names: string[] = []
  let current = folderId ? byId.get(folderId) : undefined
  while (current && names.length < 64) {
    names.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return names.join('/')
}

/** How far a copy is, item by item (folders, then notes): `done` of `total`, and the one in hand. */
export type TransferProgress = (update: { done: number; total: number; current: string }) => void

export async function transferLocalToCurrent(progress?: TransferProgress): Promise<number> {
  const local = new LocalRepository()
  const snapshot = await local.load()
  const library = useLibraryStore.getState()
  if (!library.repo || library.repo.kind !== 'drive') throw new Error('Entre com o Google antes de enviar.')

  const folderMap = new Map<string, string>()
  const byPath = new Map(library.folders.map(folder => [pathKey(library.folders, folder.id), folder.id]))
  let moved = 0

  const ordered: FolderMeta[] = []
  const visit = (parentId: string | null) => {
    for (const folder of snapshot.folders.filter(item => item.parentId === parentId && !item.deletedAt)) {
      ordered.push(folder)
      visit(folder.id)
    }
  }
  visit(null)
  const notes = snapshot.files.filter(file => !file.deletedAt)
  const total = ordered.length + notes.length
  let step = 0

  for (const folder of ordered) {
    progress?.({ done: step++, total, current: folder.name })
    const key = pathKey(snapshot.folders, folder.id)
    const existing = byPath.get(key)
    if (existing) {
      folderMap.set(folder.id, existing)
      continue
    }
    const created = await useLibraryStore.getState().createFolder({ ...folder, parentId: folder.parentId ? (folderMap.get(folder.parentId) ?? null) : null })
    folderMap.set(folder.id, created.id)
    byPath.set(key, created.id)
    moved++
  }

  for (const meta of notes) {
    progress?.({ done: step++, total, current: meta.name })
    const sidecar = await local.readSidecar(meta.id)
    const content = await local.readContent(meta.id)
    const folderId = meta.folderId ? (folderMap.get(meta.folderId) ?? null) : null
    const state = useLibraryStore.getState()
    const twin = state.files.find(file => file.name === meta.name && file.folderId === folderId && !file.deletedAt)
    if (twin) {
      const theirs = (await state.openFile(twin.id)).content
      const hunks = mergeText('', content, theirs)
      let merged = theirs
      if (theirs !== content) {
        if (hasTextConflict(hunks)) {
          const resolved = await useSyncStore.getState().askConflict({
            kind: 'text',
            fileId: twin.id,
            fileName: twin.name,
            base: '',
            mine: content,
            theirs,
            mineStamp: { at: meta.updated.at, deviceName: 'perfil Local' },
            theirsStamp: { at: twin.updated.at, deviceName: 'Google Drive' },
          })
          merged = resolved.kind === 'text' ? (resolved.resolved ?? theirs) : theirs
        } else merged = joinHunks(hunks)
        await state.saveContent(twin.id, merged)
      }
      moved++
      continue
    }
    let origin = meta.origin
    if (origin?.storage === 'drive' && origin.storedFileId) {
      try {
        const blob = await local.getSource(origin.storedFileId)
        const stored = await state.repo!.putSource(meta.id, blob, origin.name)
        origin = { ...origin, storedFileId: stored.ref }
      } catch {
        origin = { ...origin, storage: 'none', storedFileId: undefined }
      }
    }
    await state.repo!.saveFile({ ...sidecar, meta: { ...sidecar.meta, folderId, origin } }, content)
    moved++
  }
  const { snapshot: fresh } = await library.repo.pullChanges()
  useLibraryStore.getState().applySnapshot(fresh)
  return moved
}

/**
 * T029 (spec 003, R16): the profile without login (`study-helper-local`) becomes this account's Local, without sending anything to the
 * Drive. It is a copy: the profile stays as it was. What was at the top of the profile gets "Local" as its own choice, so what is made in
 * it later stays in this browser too. Returns how many folders and notes came.
 */
export async function bringLocalToAccount(progress?: TransferProgress): Promise<number> {
  const repo = useLibraryStore.getState().repo
  if (!(repo instanceof CombinedRepository)) throw new Error('Entre com o Google antes.')
  const profile = new LocalRepository()
  const snapshot = await profile.load()
  const folderIds = new Set(snapshot.folders.map(folder => folder.id))
  const top = (parentId: string | null) => !parentId || !folderIds.has(parentId)
  let count = 0
  const total = snapshot.folders.length + snapshot.files.length
  for (const folder of snapshot.folders) {
    progress?.({ done: count, total, current: folder.name })
    await repo.local.saveFolder({ ...folder, ...(top(folder.parentId) ? { place: 'local' as const } : {}) })
    count++
  }
  for (const meta of snapshot.files) {
    progress?.({ done: count, total, current: meta.name })
    const [sidecar, content] = await Promise.all([profile.readSidecar(meta.id), profile.readContent(meta.id)])
    let next = { ...sidecar, meta: { ...sidecar.meta, ...(top(meta.folderId) ? { place: 'local' as const } : {}) } }
    const origin = sidecar.meta.origin
    // the file kept with the note in the profile is copied with it
    if (origin?.storage === 'drive' && origin.storedFileId && !origin.removedAt) {
      const blob = await profile.getSource(origin.storedFileId).catch(() => null)
      if (blob) {
        const stored = await repo.local.putSource(meta.id, blob, origin.name)
        next = { ...next, meta: { ...next.meta, origin: { ...origin, storedFileId: stored.ref } } }
      }
    }
    await repo.local.saveFile(next, content)
    count++
  }
  useLibraryStore.getState().applySnapshot(await repo.load())
  return count
}
