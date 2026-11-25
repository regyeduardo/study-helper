import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { type Blocker, blocking } from '@/lib/blocking'
import { courseOf as courseOfFolders } from '@/lib/generation/course-lesson'
import { paths } from '@/lib/paths'
import { itemsOf } from '@/lib/working'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type DragState, useUiStore } from '@/stores/ui'

export const DRAG_FILE = 'application/x-study-file'
export const DRAG_FOLDER = 'application/x-study-folder'

/** On touch there is no drag: moving goes through "Mover para…". */
export function isTouchScreen(): boolean {
  return ['(pointer: coarse)', '(hover: none)'].some(query => window.matchMedia?.(query).matches)
}

/** What a drag from this item carries: everything checked when it is checked, else only it. */
function carried(id: string, isFolder: boolean): Pick<DragState, 'fileIds' | 'folderIds'> {
  const { selection } = useUiStore.getState()
  if (!selection.has(id)) return isFolder ? { fileIds: [], folderIds: [id] } : { fileIds: [id], folderIds: [] }
  const folders = new Set(useLibraryStore.getState().folders.map(folder => folder.id))
  const ids = [...selection]
  return { fileIds: ids.filter(item => !folders.has(item)), folderIds: ids.filter(item => folders.has(item)) }
}

/** A folder does not go into itself, nor below itself. */
function canEnter(folderIds: string[], target: string | null): boolean {
  const { folders } = useLibraryStore.getState()
  for (let current = target, steps = 0; current && steps < 64; steps++) {
    if (folderIds.includes(current)) return false
    const parent: string | null = folders.find(folder => folder.id === current)?.parentId ?? null
    current = parent
  }
  return true
}

/**
 * Moves one item at a time inside the window that holds the app, saying how many of how many and the one in hand; at "Cancelar" it
 * stops after the item in hand. Returns how many moved.
 */
export async function moveItems(blocker: Blocker, fileIds: string[], folderIds: string[], target: string | null): Promise<number> {
  const { files, folders, moveFiles, updateFolder } = useLibraryStore.getState()
  const items = [
    ...fileIds.map(id => ({ name: files.find(file => file.id === id)?.name ?? '', move: () => moveFiles([id], target) })),
    ...folderIds.map(id => ({ name: folders.find(folder => folder.id === id)?.name ?? '', move: () => updateFolder(id, { parentId: target }) })),
  ]
  let moved = 0
  for (const item of items) {
    if (blocker.cancelled) break
    blocker.progress({ done: moved, total: items.length, current: item.name })
    await item.move()
    moved++
  }
  return moved
}

export function useFileActions() {
  const navigate = useNavigate()
  // the same object between draws: the rows of a list are memoized on it
  return useMemo(() => {
    // spec 007 (research R7): every row of a list uses these actions; reading the stores at the click, instead of subscribing to them,
    // keeps a change anywhere in the library from drawing every row again (1,000 rows in a big folder)
    const ui = useUiStore.getState
    const library = useLibraryStore.getState
    const jobs = useJobsStore.getState

    /** `found`: the words of the search that led to it, marked in the note (FR-074). */
    const openFile = (file: FileMeta, found?: string) => {
      // a lesson still to write: who writes it is chosen first, then it opens
      if (file.status === 'pending' && courseOfFolders(library().folders, file.folderId) && !library().sharedView && !jobs().jobs.some(job => job.fileId === file.id && job.status === 'running')) {
        ui().open({ kind: 'pending', fileId: file.id, go: true })
        return
      }
      library().markOpened(file.id)
      ui().set({ peekId: null, columnsPane: 'doc', columnsSheet: false, focusPop: null })
      navigate(found ? `${paths.file(file.id)}?busca=${encodeURIComponent(found)}` : paths.file(file.id))
    }

    const toggleFavorite = async (file: FileMeta) => {
      await library().updateFile(file.id, { favorite: !file.favorite })
      ui().toast(file.favorite ? 'Tirado dos favoritos' : 'Adicionado aos favoritos')
    }

    const dropOn = async (event: React.DragEvent, folderId: string | null) => {
      event.preventDefault()
      ui().set({ drag: null })
      const fileId = event.dataTransfer.getData(DRAG_FILE)
      const folderDragged = event.dataTransfer.getData(DRAG_FOLDER)
      const dragged = fileId || folderDragged
      if (!dragged || folderDragged === folderId) return
      const { fileIds, folderIds } = carried(dragged, !fileId)
      if (!canEnter(folderIds, folderId)) {
        ui().toast('Uma pasta não pode entrar nela mesma.')
        return
      }
      // what is already there stays untouched, or its "Atualizado" would change for nothing
      const files = fileIds.filter(id => library().files.find(file => file.id === id)?.folderId !== folderId)
      const moving = folderIds.filter(id => library().folders.find(folder => folder.id === id)?.parentId !== folderId)
      if (!files.length && !moving.length) return
      const wasChecked = useUiStore.getState().selection.has(dragged)
      const name = library().folders.find(folder => folder.id === folderId)?.name ?? 'Biblioteca'
      const total = files.length + moving.length
      const only = library().files.find(file => file.id === files[0])?.name ?? library().folders.find(folder => folder.id === moving[0])?.name
      // one Drive write per item: the window holds the app and counts them, from the drop until the last one
      try {
        const moved = await blocking(total === 1 ? `Movendo "${only}"…` : `Movendo ${itemsOf(total)}…`, blocker => moveItems(blocker, files, moving, folderId), { phase: `Levando para ${name}`, cancellable: true })
        if (wasChecked) ui().clearSelection()
        if (moved < total) return ui().toast(`${moved} de ${total} movidos para ${name}`)
        ui().toast(`${!fileIds.length && folderIds.length === 1 ? 'Pasta movida' : 'Movido'} para ${name}`)
      } catch (error) {
        ui().toast(`Não deu para mover: ${error instanceof Error ? error.message : 'tente de novo.'}`)
      }
    }

    const dropTarget = (folderId: string | null) => ({
      onDragOver: (event: React.DragEvent) => {
        const { drag, set } = useUiStore.getState()
        if (drag && !canEnter(drag.folderIds, folderId)) return
        event.preventDefault()
        event.currentTarget.classList.add('drop-on')
        if (drag && drag.over !== folderId) set({ drag: { ...drag, over: folderId } })
      },
      onDragLeave: (event: React.DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        event.currentTarget.classList.remove('drop-on')
        const { drag, set } = useUiStore.getState()
        if (drag && drag.over === folderId) set({ drag: { fileIds: drag.fileIds, folderIds: drag.folderIds } })
      },
      onDrop: (event: React.DragEvent) => {
        event.currentTarget.classList.remove('drop-on')
        void dropOn(event, folderId)
      },
    })

    const startDrag = (type: string, id: string) => (event: React.DragEvent) => {
      event.dataTransfer.setData(type, id)
      useUiStore.getState().set({ drag: carried(id, type === DRAG_FOLDER) })
    }
    const endDrag = () => useUiStore.getState().set({ drag: null })

    const dragFile = (file: FileMeta) => ({ draggable: true, onDragStart: startDrag(DRAG_FILE, file.id), onDragEnd: endDrag })
    const dragFolder = (folder: FolderMeta) => ({ draggable: true, onDragStart: startDrag(DRAG_FOLDER, folder.id), onDragEnd: endDrag })

    return { openFile, toggleFavorite, dropTarget, dragFile, dragFolder }
  }, [navigate])
}
