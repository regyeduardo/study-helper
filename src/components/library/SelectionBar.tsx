import { Icon } from '@/components/ui/Icon'
import { exportFilesAsZip } from '@/lib/exports/library-export'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function SelectionBar({ hideSingle = false }: { hideSingle?: boolean }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const ids = [...ui.selection]
  if (!ids.length || (hideSingle && ids.length === 1)) return null
  const count = ids.length
  return (
    <div className="selbar" role="toolbar" aria-label="Seleção">
      <strong>
        {count} selecionado{count > 1 ? 's' : ''}
      </strong>
      <button className="btn" onClick={() => ui.open({ kind: 'folder-exam', folderId: null, fileIds: ids })}>
        <Icon name="exam" />
        Prova da seleção
      </button>
      <button className="btn" onClick={() => ui.open({ kind: 'move', fileIds: ids, folderIds: [] })}>
        <Icon name="move" />
        Mover
      </button>
      <button
        className="btn"
        onClick={async () => {
          for (const id of ids) await library.updateFile(id, { favorite: true })
          ui.toast(`${count} nos favoritos`)
        }}
      >
        <Icon name="star" />
        Favoritar
      </button>
      <button className="btn" onClick={() => void exportFilesAsZip(ids)}>
        <Icon name="download" />
        Exportar
      </button>
      <button
        className="btn"
        onClick={() => {
          const trash = async (media: boolean) => {
            await library.trashFiles(ids, { media })
            ui.clearSelection()
            ui.toast(`${count} na lixeira${media ? ', com a mídia' : ''}`)
          }
          if (!ids.some(id => library.hasMedia(id))) return void trash(false)
          const one = count === 1
          ui.open({
            kind: 'confirm',
            title: `Apagar ${count} nota${one ? '' : 's'}?`,
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
