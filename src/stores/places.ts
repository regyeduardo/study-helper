import { create } from 'zustand'

import type { FileMeta, Place } from '@/types/domain'
import { type Blocker, blocking } from '@/lib/blocking'
import { newId } from '@/lib/ids'
import { CombinedRepository, type Side } from '@/lib/storage/combined-repository'
import { fileBytes } from '@/lib/storage/file-sizes'
import { MoveJournal, type MoveProgress, type MoveRecord, planMoves, retryFailed, runMoves } from '@/lib/storage/moves'
import { filePlaceOf, folderPlaceOf } from '@/lib/storage/place'
import { saveToDrive } from '@/lib/storage/source-storage'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

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

/** "o App", "o Google Drive", "Local": the place in a sentence. */
function placeName(side: Side): string {
  return side === 'app' ? 'o App' : side === 'local' ? 'Local' : 'o Google Drive'
}

const notesOf = (count: number) => `${count.toLocaleString('pt-BR')} ${count === 1 ? 'nota' : 'notas'}`

/** The item's own choice, written so that a choice equal to the folder above is no own choice (it goes back to following it). */
async function writeChoice(id: string, place: Place | undefined): Promise<void> {
  const library = useLibraryStore.getState()
  const folder = library.folders.find(item => item.id === id)
  const file = library.files.find(item => item.id === id)
  const above = folder ? folderPlaceOf(folder.parentId, library.folders, 'drive') : file ? folderPlaceOf(file.folderId, library.folders, 'drive') : 'drive'
  const own = place === above ? undefined : place
  if (folder) await library.updateFolder(id, { place: own })
  else if (file) await library.updateFile(id, { place: own })
}

export const usePlacesStore = create<PlacesState>((set, get) => {
  /**
   * Runs the journal inside the window of the operation (owner's choice F): each step with its count and the item in hand; Cancelar stops
   * before the next item, and what did not go stays where it is with that place as its own choice, so the screen tells the truth.
   */
  const run = async (blocker: Blocker) => {
    const repo = combined()
    const accountId = useLibraryStore.getState().accountId
    if (!repo || !accountId || get().running) return
    set({ running: true, failed: [] })
    const journal = new MoveJournal(accountId)
    try {
      const { folders, files } = useLibraryStore.getState()
      const records = await runMoves(repo, journal, { folders, files }, {
        onProgress: progress => {
          set({ progress })
          blocker.progress({ phase: 'Levando as notas', done: progress.done, total: progress.total, doneBytes: progress.doneBytes, totalBytes: progress.totalBytes, current: progress.current })
        },
        cancelled: () => blocker.cancelled,
      })
      blocker.progress({ phase: 'Atualizando a biblioteca', done: undefined, total: undefined, doneBytes: undefined, totalBytes: undefined, current: undefined })
      useLibraryStore.getState().applySnapshot(await repo.load())
      // a note that came from this browser takes its media from Mídias with it, to the Drive or to the App (FR-021)
      const library = useLibraryStore.getState()
      const media = records.filter(item => item.state === 'feito' && item.kind === 'file' && item.to !== 'local' && item.from === 'local').filter(record => {
        const file = library.files.find(item => item.id === record.id)
        return file?.origin && file.origin.storage !== 'drive' && library.localMedia.some(item => item.fileIds.includes(record.id))
      })
      for (const [index, record] of media.entries()) {
        blocker.progress({ phase: 'Enviando as mídias', done: index, total: media.length, current: record.name })
        await saveToDrive(record.id).catch(() => undefined)
      }
      // cancelled: what did not start stays whole where it is, and says so as its own choice
      const stayed = records.filter(record => record.state === 'pendente')
      for (const record of stayed) await writeChoice(record.id, record.from)
      const failed = records.filter(record => record.state === 'falhou')
      set({ failed })
      await journal.clearDone()
      const went = records.filter(record => record.state === 'feito' && record.kind === 'file')
      const to = records[0]?.to
      if (stayed.length) useUiStore.getState().toast(went.length ? `Parou: ${notesOf(went.length)} ${went.length === 1 ? 'foi' : 'foram'} para ${placeName(to!)}; o resto ficou onde estava.` : 'Parou: nada mudou de lugar.')
      else if (!failed.length && went.length) useUiStore.getState().toast(`Pronto: ${notesOf(went.length)} ${to === 'local' ? 'em Local' : to === 'app' ? 'no App' : 'no Google Drive'}`)
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
      if (place === 'app' && !repo.app) throw new Error('O App ainda não está liberado para esta conta.')
      const to = sideOfPlace(place)
      // the window holds the app from the click: writing the choice of each item is a Drive write, seconds each
      await blocking(
        `Levando para ${placeName(to)}`,
        async blocker => {
          const library = useLibraryStore.getState()
          const written: { id: string; before: Place | undefined }[] = []
          for (const [index, id] of ids.entries()) {
            if (blocker.cancelled) break
            const item = library.folders.find(folder => folder.id === id) ?? library.files.find(file => file.id === id)
            blocker.progress({ phase: 'Gravando a escolha', done: index, total: ids.length, current: item?.name })
            await writeChoice(id, place)
            written.push({ id, before: item?.place })
            blocker.progress({ done: index + 1 })
          }
          if (blocker.cancelled) {
            // nothing moved yet: the choices written go back to what they were
            blocker.progress({ phase: 'Desfazendo a escolha', done: undefined, total: undefined, current: undefined })
            for (const { id, before } of written.reverse()) await writeChoice(id, before)
            useUiStore.getState().toast('Parou: nada mudou de lugar.')
            return
          }
          const { folders, files, accountId } = useLibraryStore.getState()
          const journal = new MoveJournal(accountId!)
          for (const record of planMoves(repo, { folders, files }, ids, to, newId(), sizeOf)) await journal.put(record)
          await run(blocker)
        },
        { cancellable: true, phase: 'Gravando a escolha', total: ids.length },
      )
    },

    syncLocal: ids => get().choosePlace(ids, 'drive'),

    resume: async () => {
      const accountId = useLibraryStore.getState().accountId
      if (!combined() || !accountId) return
      const open = (await new MoveJournal(accountId).all()).filter(record => record.state !== 'feito' && record.state !== 'falhou')
      if (open.length) await blocking('Continuando a mudança de lugar', run, { cancellable: true })
    },

    retry: async () => {
      const accountId = useLibraryStore.getState().accountId
      if (!accountId) return
      await blocking(
        'Tentando de novo',
        async blocker => {
          await retryFailed(new MoveJournal(accountId))
          await run(blocker)
        },
        { cancellable: true },
      )
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
  const records = planMoves(repo, tree, ids, sideOfPlace(place), 'preview', sizeOf)
  const notes = records.filter(record => record.kind === 'file')
  return { notes: notes.length, bytes: notes.reduce((sum, record) => sum + record.bytes, 0), items: records.length }
}

/** The side a place means now: App only while the app structure is on (else it stays in the Drive). */
function sideOfPlace(place: Place): Side {
  if (place === 'local') return 'local'
  return place === 'app' && combined()?.app ? 'app' : 'drive'
}

/** Whether the App can be chosen as a place: the account was freed by a code and "Usar a estrutura do app" is on. */
export function appPlaceOn(): boolean {
  return Boolean(combined()?.app)
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

/** Every note kept in the App, and the topmost App items (what turning the structure off takes out first, FR-066). */
export function appItems(): { notes: FileMeta[]; tops: { id: string; kind: 'file' | 'folder' }[] } {
  const repo = combined()
  if (!repo?.app) return { notes: [], tops: [] }
  const { folders, files } = useLibraryStore.getState()
  const inApp = (id: string | null) => Boolean(id) && repo.sideOf(id!) === 'app'
  const notes = files.filter(file => !file.deletedAt && inApp(file.id))
  const tops = [
    ...folders.filter(folder => !folder.deletedAt && inApp(folder.id) && !inApp(folder.parentId)).map(folder => ({ id: folder.id, kind: 'folder' as const })),
    ...notes.filter(file => !inApp(file.folderId)).map(file => ({ id: file.id, kind: 'file' as const })),
  ]
  return { notes, tops }
}

export { sizeOf as placeSizeOf }
