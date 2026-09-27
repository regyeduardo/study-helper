import type { FolderMeta } from '@/types/domain'
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

export async function transferLocalToCurrent(): Promise<number> {
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

  for (const folder of ordered) {
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

  for (const meta of snapshot.files.filter(file => !file.deletedAt)) {
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
