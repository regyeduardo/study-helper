import { create } from 'zustand'

import type { FileMeta, Place } from '@/types/domain'
import { newId } from '@/lib/ids'
import { CombinedRepository, type Side } from '@/lib/storage/combined-repository'
import { fileBytes } from '@/lib/storage/file-sizes'
import { MoveJournal, type MoveProgress, type MoveRecord, planMoves, retryFailed, runMoves } from '@/lib/storage/moves'
import { filePlaceOf, folderPlaceOf } from '@/lib/storage/place'
import { saveToDrive } from '@/lib/storage/source-storage'
import { useLibraryStore } from '@/stores/library'

interface PlacesState {
  /** The move running now, for the window and the banner. */
  progress: MoveProgress | null
  running: boolean
  failed: MoveRecord[]
  /** "Onde fica cada coisa" (FR-052, FR-054): the item's own choice, then the move of it and of all inside it that follows it. */
  choosePlace(ids: string[], place: Place): Promise<void>
  /** "Sincronizar" (FR-056): what is only in this browser goes to the Google Drive. */
  syncLocal(ids: string[]): Promise<void>
  /** Opening the app again continues every move that stopped in the middle. */
  resume(): Promise<void>
  retry(): Promise<void>
}

function combined(): CombinedRepository | null {
  const repo = useLibraryStore.getState().repo
  return repo instanceof CombinedRepository ? repo : null
}

/** Where an item is kept right now: in a library without Google everything is in this browser. */
export function sideOfItem(id: string): Side {
  const repo = useLibraryStore.getState().repo
  if (repo instanceof CombinedRepository) return repo.sideOf(id) ?? 'drive'
  return repo?.kind === 'drive' ? 'drive' : 'local'
}

function sizeOf(file: FileMeta): number {
  const { sizes, localMedia } = useLibraryStore.getState()
  return fileBytes(file, sizes[file.id], localMedia)
}

export const usePlacesStore = create<PlacesState>((set, get) => {
  const run = async () => {
    const repo = combined()
    const accountId = useLibraryStore.getState().accountId
    if (!repo || !accountId || get().running) return
    set({ running: true, failed: [] })
    const journal = new MoveJournal(accountId)
    try {
      const { folders, files } = useLibraryStore.getState()
      const records = await runMoves(repo, journal, { folders, files }, { onProgress: progress => set({ progress }) })
      useLibraryStore.getState().applySnapshot(await repo.load())
      // a note that came from this browser takes its media from Mídias to the Drive too (FR-021)
      const library = useLibraryStore.getState()
      for (const record of records.filter(item => item.state === 'feito' && item.kind === 'file' && item.to === 'drive' && item.from === 'local')) {
        const file = library.files.find(item => item.id === record.id)
        const kept = library.localMedia.some(item => item.fileIds.includes(record.id))
        if (file?.origin && kept && file.origin.storage !== 'drive') await saveToDrive(record.id).catch(() => undefined)
      }
      set({ failed: records.filter(record => record.state === 'falhou') })
      await journal.clearDone()
    } finally {
      set({ running: false, progress: null })
    }
  }

  return {
    progress: null,
    running: false,
    failed: [],

    choosePlace: async (ids, place) => {
      const repo = combined()
      if (!repo) throw new Error('Entre com o Google para guardar no Google Drive.')
      if (place === 'app') throw new Error('O App ainda não está liberado para esta conta.')
      const library = useLibraryStore.getState()
      for (const id of ids) {
        const folder = library.folders.find(item => item.id === id)
        const file = library.files.find(item => item.id === id)
        // a choice equal to the folder above is no own choice: the item goes back to following it
        const above = folder ? folderPlaceOf(folder.parentId, library.folders, 'drive') : file ? folderPlaceOf(file.folderId, library.folders, 'drive') : 'drive'
        const own = place === above ? undefined : place
        if (folder) await library.updateFolder(id, { place: own })
        else if (file) await library.updateFile(id, { place: own })
      }
      const { folders, files, accountId } = useLibraryStore.getState()
      const journal = new MoveJournal(accountId!)
      const to: Side = place === 'local' ? 'local' : 'drive'
      for (const record of planMoves(repo, { folders, files }, ids, to, newId(), sizeOf)) await journal.put(record)
      await run()
    },

    syncLocal: ids => get().choosePlace(ids, 'drive'),

    resume: async () => {
      const accountId = useLibraryStore.getState().accountId
      if (!combined() || !accountId) return
      const open = (await new MoveJournal(accountId).all()).filter(record => record.state !== 'feito' && record.state !== 'falhou')
      if (open.length) await run()
    },

    retry: async () => {
      const accountId = useLibraryStore.getState().accountId
      if (!accountId) return
      await retryFailed(new MoveJournal(accountId))
      await run()
    },
  }
})

/** The place shown for an item: its own choice, else the folder's (a new choice shows before the move ends). */
export function shownPlace(id: string, kind: 'file' | 'folder'): Place {
  const { folders, files } = useLibraryStore.getState()
  const root: Place = combined() ? 'drive' : 'local'
  if (kind === 'folder') return folderPlaceOf(id, folders, root)
  const file = files.find(item => item.id === id)
  return file ? filePlaceOf(file, folders, root) : root
}

/** Before a change: how many notes and how much space move, and from where (the window says it before the button, FR-054). */
export function previewMove(ids: string[], place: Place): { notes: number; bytes: number; items: number } {
  const repo = combined()
  if (!repo) return { notes: 0, bytes: 0, items: 0 }
  const { folders, files } = useLibraryStore.getState()
  const chosen = new Set(ids)
  const tree = { folders: folders.filter(item => !item.deletedAt).map(item => (chosen.has(item.id) ? { ...item, place } : item)), files: files.filter(item => !item.deletedAt).map(item => (chosen.has(item.id) ? { ...item, place } : item)) }
  const records = planMoves(repo, tree, ids, place === 'local' ? 'local' : 'drive', 'preview', sizeOf)
  const notes = records.filter(record => record.kind === 'file')
  return { notes: notes.length, bytes: notes.reduce((sum, record) => sum + record.bytes, 0), items: records.length }
}

/** Whether the library mixes the Google Drive and this browser (a Google account): only then a place needs saying. */
export function placesApply(): boolean {
  return combined() !== null
}

/** Every note and folder kept only in this browser, and the topmost of them (what "Sincronizar" offers). */
export function localItems(): { notes: FileMeta[]; tops: { id: string; kind: 'file' | 'folder' }[] } {
  const repo = combined()
  if (!repo) return { notes: [], tops: [] }
  const { folders, files } = useLibraryStore.getState()
  const local = (id: string | null) => Boolean(id) && repo.sideOf(id!) === 'local'
  const liveFolders = folders.filter(folder => !folder.deletedAt)
  const notes = files.filter(file => !file.deletedAt && local(file.id))
  const tops = [
    ...liveFolders.filter(folder => local(folder.id) && !local(folder.parentId)).map(folder => ({ id: folder.id, kind: 'folder' as const })),
    ...notes.filter(file => !local(file.folderId)).map(file => ({ id: file.id, kind: 'file' as const })),
  ]
  return { notes, tops }
}

export { sizeOf as placeSizeOf }
