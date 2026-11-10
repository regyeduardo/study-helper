import { useNavigate } from 'react-router-dom'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { courseOf as courseOfFolders } from '@/lib/generation/course-lesson'
import { paths } from '@/lib/paths'
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

export function useFileActions() {
  const navigate = useNavigate()
  const ui = useUiStore()
  const library = useLibraryStore()
  const jobs = useJobsStore()

  /** `found`: the words of the search that led to it, marked in the note (FR-074). */
  const openFile = (file: FileMeta, found?: string) => {
    if (file.status === 'pending' && courseOfFolders(library.folders, file.folderId) && !library.sharedView) {
      ui.open({
        kind: 'confirm',
        title: file.name,
        text: 'Esta aula ainda não foi escrita. O recorte do material já está guardado. Gerar agora?',
        ok: 'Gerar agora',
        onConfirm: () => {
          void jobs.generatePending(file.id)
          navigate(paths.file(file.id))
        },
      })
      return
    }
    library.markOpened(file.id)
    ui.set({ peekId: null, columnsPane: 'doc', columnsSheet: false, focusPop: null })
    navigate(found ? `${paths.file(file.id)}?busca=${encodeURIComponent(found)}` : paths.file(file.id))
  }

  const toggleFavorite = async (file: FileMeta) => {
    await library.updateFile(file.id, { favorite: !file.favorite })
    ui.toast(file.favorite ? 'Tirado dos favoritos' : 'Adicionado aos favoritos')
  }

  const dropOn = async (event: React.DragEvent, folderId: string | null) => {
    event.preventDefault()
    ui.set({ drag: null })
    const fileId = event.dataTransfer.getData(DRAG_FILE)
    const folderDragged = event.dataTransfer.getData(DRAG_FOLDER)
    const dragged = fileId || folderDragged
    if (!dragged || folderDragged === folderId) return
    const { fileIds, folderIds } = carried(dragged, !fileId)
    if (!canEnter(folderIds, folderId)) {
      ui.toast('Uma pasta não pode entrar nela mesma.')
      return
    }
    // what is already there stays untouched, or its "Atualizado" would change for nothing
    const files = fileIds.filter(id => library.files.find(file => file.id === id)?.folderId !== folderId)
    const moving = folderIds.filter(id => library.folders.find(folder => folder.id === id)?.parentId !== folderId)
    if (!files.length && !moving.length) return
    const wasChecked = useUiStore.getState().selection.has(dragged)
    await library.moveFiles(files, folderId)
    for (const id of moving) await library.updateFolder(id, { parentId: folderId })
    if (wasChecked) ui.clearSelection()
    const name = library.folders.find(folder => folder.id === folderId)?.name ?? 'Biblioteca'
    ui.toast(`${!fileIds.length && folderIds.length === 1 ? 'Pasta movida' : 'Movido'} para ${name}`)
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
}
