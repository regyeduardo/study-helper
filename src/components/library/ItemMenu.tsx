import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { exportFileAsMarkdown, exportFileAsZip } from '@/lib/exports/library-export'
import { printMarkdownAsPdf } from '@/lib/exports/pdf'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function ItemMenu() {
  const ui = useUiStore()
  const library = useLibraryStore()
  const jobs = useJobsStore()
  const navigate = useNavigate()
  const menu = ui.menu
  if (!menu) return null
  const close = () => ui.openMenu(null)
  const act = (run: () => unknown) => () => {
    close()
    void run()
  }

  if (menu.kind === 'folder') {
    const folder = library.folders.find(item => item.id === menu.id)
    if (!folder) return null
    return (
      <Popover x={menu.x} y={menu.y} onClose={close} label={`Opções de ${folder.name}`}>
        <div className="mh">{folder.name}</div>
        <button className="mi" onClick={act(() => navigate(paths.folder(folder.id)))}>
          <Icon name="folder" />
          Abrir
        </button>
        <button className="mi" onClick={act(() => ui.open({ kind: 'rename', target: 'folder', id: folder.id }))}>
          <Icon name="pen" />
          Renomear
        </button>
        <button className="mi" onClick={act(() => ui.open({ kind: 'move', fileIds: [], folderIds: [folder.id] }))}>
          <Icon name="move" />
          Mover para…
        </button>
        <button className="mi" onClick={act(() => ui.open({ kind: 'new-folder', parentId: folder.id }))}>
          <Icon name="plus" />
          Nova pasta dentro
        </button>
        <button className="mi" onClick={act(() => ui.open({ kind: 'folder-exam', folderId: folder.id }))}>
          <Icon name="exam" />
          Prova da pasta
        </button>
        <button className="mi" onClick={act(() => ui.open({ kind: 'share', target: 'folder', id: folder.id }))}>
          <Icon name="link" />
          {folder.isCourse ? 'Compartilhar o curso' : 'Compartilhar a pasta'}
        </button>
        {folder.isCourse && (
          <>
            <button className="mi" onClick={act(() => ui.open({ kind: 'order', folderId: folder.id }))}>
              <Icon name="sort" />
              Ordenar aulas e módulos
            </button>
            <button className="mi" onClick={act(() => jobs.generateRemaining(folder.id))}>
              <Icon name="sync" />
              Gerar as aulas que faltam
            </button>
          </>
        )}
        <button className="mi" onClick={act(() => library.updateFolder(folder.id, { isCourse: !folder.isCourse }))}>
          <Icon name="layers" />
          {folder.isCourse ? 'Deixar de ser curso' : 'Marcar como curso'}
        </button>
        <div className="sep" />
        <button
          className="mi danger"
          onClick={act(async () => {
            await library.trashFolder(folder.id)
            ui.toast(`"${folder.name}" foi para a lixeira`)
          })}
        >
          <Icon name="trash" />
          Mandar para a lixeira
        </button>
      </Popover>
    )
  }

  const file = library.files.find(item => item.id === menu.id)
  if (!file) return null
  return (
    <Popover x={menu.x} y={menu.y} onClose={close} label={`Opções de ${file.name}`}>
      <div className="mh">{file.name}</div>
      <button className="mi" onClick={act(() => navigate(paths.file(file.id)))}>
        <Icon name="book" />
        Abrir
      </button>
      <button className="mi" onClick={act(() => ui.open({ kind: 'rename', target: 'file', id: file.id }))}>
        <Icon name="pen" />
        Renomear
      </button>
      <button className="mi" onClick={act(() => ui.open({ kind: 'move', fileIds: [file.id], folderIds: [] }))}>
        <Icon name="move" />
        Mover para…
      </button>
      <button className="mi" onClick={act(() => library.updateFile(file.id, { favorite: !file.favorite }))}>
        <Icon name="star" />
        {file.favorite ? 'Tirar dos favoritos' : 'Favoritar'}
      </button>
      <button className="mi" onClick={act(() => ui.open({ kind: 'exam', fileId: file.id }))}>
        <Icon name="exam" />
        Fazer a prova
      </button>
      <button
        className="mi"
        onClick={act(() => {
          ui.set({ inspectorTab: 'info', rightOpen: true, columnsSheet: true, focusPop: 'info' })
          navigate(paths.file(file.id))
        })}
      >
        <Icon name="info" />
        Informações
      </button>
      <button className="mi" onClick={act(() => ui.open({ kind: 'share', target: 'file', id: file.id }))}>
        <Icon name="link" />
        Compartilhar
      </button>
      <div className="sep" />
      <button className="mi" onClick={act(() => exportFileAsMarkdown(file.id))}>
        <Icon name="download" />
        Exportar .md
      </button>
      <button className="mi" onClick={act(() => exportFileAsZip(file.id))}>
        <Icon name="download" />
        Exportar .zip (com a prova)
      </button>
      <button
        className="mi"
        onClick={act(async () => {
          const { content } = await library.openFile(file.id)
          await printMarkdownAsPdf(content, file.name, library.index.settings.githubToken)
        })}
      >
        <Icon name="download" />
        Exportar PDF
      </button>
      <div className="sep" />
      <button
        className="mi danger"
        onClick={act(async () => {
          await library.trashFiles([file.id])
          ui.toast(`"${file.name}" foi para a lixeira`)
        })}
      >
        <Icon name="trash" />
        Mandar para a lixeira
      </button>
    </Popover>
  )
}
