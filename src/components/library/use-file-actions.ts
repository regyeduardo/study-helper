import { useNavigate } from 'react-router-dom'

import type { FileMeta } from '@/types/domain'
import { courseOf as courseOfFolders } from '@/lib/generation/course-lesson'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export const DRAG_FILE = 'application/x-study-file'
export const DRAG_FOLDER = 'application/x-study-folder'

export function useFileActions() {
  const navigate = useNavigate()
  const ui = useUiStore()
  const library = useLibraryStore()
  const jobs = useJobsStore()

  const openFile = (file: FileMeta) => {
    if (file.status === 'pending' && courseOfFolders(library.folders, file.folderId)) {
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
    navigate(paths.file(file.id))
  }

  const toggleFavorite = async (file: FileMeta) => {
    await library.updateFile(file.id, { favorite: !file.favorite })
    ui.toast(file.favorite ? 'Tirado dos favoritos' : 'Adicionado aos favoritos')
  }

  const dropOn = async (event: React.DragEvent, folderId: string | null) => {
    event.preventDefault()
    const fileId = event.dataTransfer.getData(DRAG_FILE)
    const folderDragged = event.dataTransfer.getData(DRAG_FOLDER)
    const target = library.folders.find(folder => folder.id === folderId)
    if (fileId) {
      const ids = ui.selection.has(fileId) ? [...ui.selection] : [fileId]
      await library.moveFiles(ids, folderId)
      ui.clearSelection()
      ui.toast(`Movido para ${target?.name ?? 'Biblioteca'}`)
    } else if (folderDragged && folderDragged !== folderId) {
      const ancestors = new Set<string>()
      let current = target
      while (current) {
        ancestors.add(current.id)
        current = library.folders.find(folder => folder.id === current!.parentId)
      }
      if (ancestors.has(folderDragged)) {
        ui.toast('Uma pasta não pode entrar nela mesma.')
        return
      }
      await library.updateFolder(folderDragged, { parentId: folderId })
      ui.toast(`Pasta movida para ${target?.name ?? 'Biblioteca'}`)
    }
  }

  const dropTarget = (folderId: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault()
      event.currentTarget.classList.add('drop-on')
    },
    onDragLeave: (event: React.DragEvent) => event.currentTarget.classList.remove('drop-on'),
    onDrop: (event: React.DragEvent) => {
      event.currentTarget.classList.remove('drop-on')
      void dropOn(event, folderId)
    },
  })

  const dragFile = (file: FileMeta) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => event.dataTransfer.setData(DRAG_FILE, file.id),
  })

  return { openFile, toggleFavorite, dropTarget, dragFile }
}
