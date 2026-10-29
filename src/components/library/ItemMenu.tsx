import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { exportFileAsMarkdown, exportFileAsZip } from '@/lib/exports/library-export'
import { mediaOf } from '@/lib/file-types'
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
  const hasText = mediaOf(file) === 'text' || file.words > 0
  const needs = hasText ? undefined : 'transcrever antes'
  const generate = (agent: 'meeting' | 'lesson') =>
    act(async () => {
      const id = await jobs.generateFromNote(file.id, agent)
      if (id) navigate(paths.file(id))
    })
  const tools: [string, Parameters<typeof Icon>[0]['name'], (() => void) | null][] = [
    ['Mapa mental', 'layers', act(() => ui.open({ kind: 'mindmap', fileId: file.id }))],
    ['Cartões', 'note', act(() => ui.open({ kind: 'cards', fileId: file.id }))],
    ['Tutor', 'bulb', act(() => ui.open({ kind: 'tutor', fileId: file.id }))],
    ['Prova', 'exam', act(() => ui.open({ kind: 'exam', fileId: file.id }))],
    ['Ata', 'file', mediaOf(file) === 'text' ? generate('meeting') : act(() => ui.open({ kind: 'ata-parts', fileId: file.id }))],
    ['Aula', 'book', generate('lesson')],
  ]
  return (
    <Popover x={menu.x} y={menu.y} onClose={close} label={`Opções de ${file.name}`}>
      <div className="mh">{file.name}</div>
      <div className="mg" role="presentation">
        Gerar{needs ? ' (precisa de transcrição)' : ''}
      </div>
      {tools.map(([label, icon, run]) => (
        <button key={label} className="mi" disabled={Boolean(needs) || !run} onClick={run ?? undefined}>
          <Icon name={icon} />
          {label}
          {(needs || !run) && <span className="mi-hint">{needs ?? 'em breve'}</span>}
        </button>
      ))}
      <div className="sep" />
      <button className="mi" disabled={!hasText} onClick={act(() => jobs.suggestTags(file.id))}>
        <Icon name="bulb" />
        Sugerir etiquetas
      </button>
      <button
        className="mi"
        onClick={act(() => {
          ui.set({ inspectorTab: 'info', rightOpen: true, panelAsked: true, columnsSheet: true, focusPop: 'info' })
          navigate(paths.file(file.id))
        })}
      >
        <Icon name="info" />
        Detalhes
      </button>
      <button className="mi" onClick={act(() => ui.open({ kind: 'move', fileIds: [file.id], folderIds: [] }))}>
        <Icon name="move" />
        Mover
      </button>
      <button className="mi" onClick={act(() => ui.open({ kind: 'rename', target: 'file', id: file.id }))}>
        <Icon name="pen" />
        Renomear
      </button>
      <button className="mi" onClick={act(() => library.updateFile(file.id, { favorite: !file.favorite }))}>
        <Icon name="star" />
        {file.favorite ? 'Tirar dos favoritos' : 'Favoritar'}
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
          await printMarkdownAsPdf(content, file.name)
        })}
      >
        <Icon name="download" />
        Exportar PDF
      </button>
      <div className="sep" />
      <button
        className="mi danger"
        onClick={act(() => {
          const trash = async (media: boolean) => {
            await library.trashFiles([file.id], { media })
            ui.toast(`"${file.name}" foi para a lixeira${media ? ', com a mídia' : ''}`)
          }
          if (!library.hasMedia(file.id)) return trash(false)
          ui.open({
            kind: 'confirm',
            title: `Apagar "${file.name}"?`,
            text: `A nota vai para a lixeira e dá para restaurar. ${mediaOf(file) === 'video' ? 'O vídeo' : 'O áudio'} pode ir junto, mas aí não volta.`,
            ok: 'Apagar a nota e a mídia',
            danger: true,
            onConfirm: () => trash(true),
            alt: { label: 'Apagar só a nota', onConfirm: () => trash(false) },
          })
        })}
      >
        <Icon name="trash" />
        Apagar
      </button>
    </Popover>
  )
}
