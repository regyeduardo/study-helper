import { Icon } from '@/components/ui/Icon'
import { exportFilesAsZip } from '@/lib/exports/library-export'
import { filesInside, useLiveLibrary } from '@/hooks/use-library-view'
import { descendantsOf } from '@/lib/family'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function SelectionBar({ hideSingle = false }: { hideSingle?: boolean }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const live = useLiveLibrary()
  const ids = [...ui.selection]
  if (!ids.length || (hideSingle && ids.length === 1)) return null
  const count = ids.length
  const folderSet = new Set(library.folders.map(folder => folder.id))
  const folderIds = ids.filter(id => folderSet.has(id))
  const fileIds = ids.filter(id => !folderSet.has(id))
  // Prova and Exportar work on notes: a checked folder counts for what is inside it
  const notes = [...new Set([...fileIds, ...filesInside(live.files, live.folders, folderIds).map(file => file.id)])]
  return (
    <div className="selbar" role="toolbar" aria-label="Seleção">
      <strong>
        {count} selecionado{count > 1 ? 's' : ''}
      </strong>
      <button className="btn sel-move" onClick={() => ui.open({ kind: 'move', fileIds, folderIds })}>
        <Icon name="move" />
        Mover para…
      </button>
      {notes.length > 0 && (
        <button className="btn" onClick={() => ui.open({ kind: 'folder-exam', folderId: null, fileIds: notes })}>
          <Icon name="exam" />
          Prova da seleção
        </button>
      )}
      <button
        className="btn"
        onClick={async () => {
          for (const id of fileIds) await library.updateFile(id, { favorite: true })
          for (const id of folderIds) await library.updateFolder(id, { favorite: true })
          ui.toast(`${count} nos favoritos`)
        }}
      >
        <Icon name="star" />
        Favoritar
      </button>
      {notes.length > 0 && (
        <button className="btn" onClick={() => void exportFilesAsZip(notes)}>
          <Icon name="download" />
          Exportar
        </button>
      )}
      <button
        className="btn sel-danger"
        onClick={async () => {
          const withFamily = fileIds.find(id => descendantsOf(library.files, id).length)
          if (withFamily) {
            // that window only knows files: the checked folders go first
            for (const id of folderIds) await library.trashFolder(id)
            return ui.open({ kind: 'delete-family', fileId: withFamily, fileIds })
          }
          const trash = async (media: boolean) => {
            await library.trashFiles(fileIds, { media })
            for (const id of folderIds) await library.trashFolder(id)
            ui.clearSelection()
            ui.toast(`${count} na lixeira${media ? ', com a mídia' : ''}`)
          }
          if (!fileIds.some(id => library.hasMedia(id))) return void trash(false)
          const one = count === 1
          ui.open({
            kind: 'confirm',
            title: folderIds.length ? `Apagar ${count} itens?` : `Apagar ${count} nota${one ? '' : 's'}?`,
            text: `${one ? 'A nota vai' : 'As notas vão'} para a lixeira e dá para restaurar. A mídia (áudio ou vídeo) pode ir junto, mas aí não volta.`,
            ok: one ? 'Apagar a nota e a mídia' : 'Apagar as notas e as mídias',
            danger: true,
            onConfirm: () => trash(true),
            alt: { label: one ? 'Apagar só a nota' : 'Apagar só as notas', onConfirm: () => trash(false) },
          })
        }}
      >
        <Icon name="trash" />
        Apagar
      </button>
      <button className="btn" onClick={ui.clearSelection} style={{ marginLeft: 'auto' }}>
        <Icon name="x" />
        Limpar seleção <span className="kbd">Esc</span>
      </button>
    </div>
  )
}
