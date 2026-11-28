import { useNavigate } from 'react-router-dom'

import type { FolderColor } from '@/types/domain'
import { mediaChoice } from '@/components/dialogs/DeleteFamilyDialog'
import { madeLine, redoOf } from '@/components/dialogs/FromNoteFields'
import { Icon } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { exportWithFeedback } from '@/components/library/slow-actions'
import { descendantsOf } from '@/lib/family'
import { isSourceNote, mediaOf } from '@/lib/file-types'
import { isCourseFolder } from '@/lib/generation/course-lesson'
import { paths } from '@/lib/paths'
import { unheld, working } from '@/lib/working'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const FOLDER_COLORS: [FolderColor, string][] = [
  ['vermelho', 'Vermelho'],
  ['laranja', 'Laranja'],
  ['amarelo', 'Amarelo'],
  ['verde', 'Verde'],
  ['azul', 'Azul'],
  ['roxo', 'Roxo'],
  ['cinza', 'Cinza'],
]

export function ItemMenu() {
  const ui = useUiStore()
  const library = useLibraryStore()
  const jobs = useJobsStore()
  const navigate = useNavigate()
  const menu = ui.menu
  if (!menu) return null
  const close = () => ui.openMenu(null)
  // an action that fails (the Drive is off) says so; what the list already showed goes back
  const act = (run: () => unknown) => () => {
    close()
    void (async () => {
      try {
        await run()
      } catch (error) {
        ui.toast(`Não deu certo: ${error instanceof Error ? error.message : 'tente de novo.'}`)
      }
    })()
  }

  // the AI reads the note while the app goes on (T194): the corner says it is running, and the end says what came out
  const suggestTags = (fileId: string) =>
    unheld(
      'Sugerindo etiquetas…',
      async () => {
        await jobs.suggestTags(fileId)
        const found = useLibraryStore.getState().files.find(item => item.id === fileId)?.suggestedTags?.length ?? 0
        if (found) ui.toast(`${found} ${found === 1 ? 'etiqueta sugerida' : 'etiquetas sugeridas'}.`, { label: 'Ver na nota', to: paths.file(fileId) })
        else ui.toast('Não saíram etiquetas novas para esta nota.')
      },
      { failed: 'Não deu para sugerir etiquetas' },
    )

  if (menu.kind === 'folder') {
    const folder = library.folders.find(item => item.id === menu.id)
    if (!folder) return null
    const course = isCourseFolder(library.folders, folder.id)
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
        <button className="mi" onClick={act(() => ui.open({ kind: 'settings', tab: 'storage', focusId: folder.id }))}>
          <Icon name="cloud" />
          Onde fica…
        </button>
        <button className="mi" onClick={act(() => library.updateFolder(folder.id, { favorite: !folder.favorite }))}>
          <Icon name="star" />
          {folder.favorite ? 'Tirar dos favoritos' : 'Favoritar'}
        </button>
        <div className="mi-colors" role="group" aria-label="Cor da pasta">
          {FOLDER_COLORS.map(([color, label]) => (
            <button key={color} className="swatch" aria-label={label} title={label} aria-pressed={folder.color === color} style={{ background: `var(--folder-${color})` }} onClick={act(() => library.updateFolder(folder.id, { color }))}>
              {folder.color === color && <Icon name="check" />}
            </button>
          ))}
          <button className="swatch none" aria-label="Sem cor" title="Sem cor" aria-pressed={!folder.color} onClick={act(() => library.updateFolder(folder.id, { color: undefined }))}>
            {!folder.color && <Icon name="check" />}
          </button>
        </div>
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
          Compartilhar a pasta
        </button>
        {course && (
          <>
            <button className="mi" onClick={act(() => ui.open({ kind: 'order', folderId: folder.id }))}>
              <Icon name="sort" />
              Ordenar aulas e módulos
            </button>
            <button className="mi" onClick={act(() => ui.open({ kind: 'pending', folderId: folder.id }))}>
              <Icon name="sync" />
              Gerar as aulas que faltam…
            </button>
          </>
        )}
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
  // Ata and Aula go straight from the media (or transcribe it first)
  const fromMedia = library.localMedia.some(item => item.fileIds.includes(file.id)) || Boolean(file.origin?.storedFileId || file.origin?.storedUrl)
  const gate = (label: string) => (fromMedia && (label === 'Ata' || label === 'Aula') ? undefined : needs)
  const generate = (agent: 'meeting' | 'lesson') => act(() => ui.open({ kind: 'generate', fileId: file.id, agent }))
  // the window that writes it again, with what it was made with
  const again = redoOf(file, library.files, library.folders)
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
      {again && (
        <button
          className="mi"
          onClick={act(() => ui.open(again))}
        >
          <Icon name="sync" />
          <span className="mi-two">
            Gerar de novo…
            <small>{madeLine(file, library.index.settings)}</small>
          </span>
        </button>
      )}
      <div className="mg" role="presentation">
        Gerar{needs ? ' (precisa de transcrição)' : ''}
      </div>
      {tools.map(([label, icon, run]) => (
        <button key={label} className="mi" disabled={Boolean(gate(label)) || !run} onClick={run ?? undefined}>
          <Icon name={icon} />
          {label}
          {(gate(label) || !run) && <span className="mi-hint">{gate(label) ?? 'em breve'}</span>}
        </button>
      ))}
      <div className="sep" />
      <button className="mi" disabled={!hasText} onClick={act(() => suggestTags(file.id))}>
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
      <button className="mi" onClick={act(() => ui.open({ kind: 'settings', tab: 'storage', focusId: file.id }))}>
        <Icon name="cloud" />
        Onde fica…
      </button>
      <button className="mi" onClick={act(() => ui.open({ kind: 'rename', target: 'file', id: file.id }))}>
        <Icon name="pen" />
        Renomear
      </button>
      <button className="mi" onClick={act(() => library.updateFile(file.id, { favorite: !file.favorite }))}>
        <Icon name="star" />
        {file.favorite ? 'Tirar dos favoritos' : 'Favoritar'}
      </button>
      <button className="mi" onClick={act(() => ui.open({ kind: 'share', target: isSourceNote(file) ? 'entrada' : 'file', id: file.id }))}>
        <Icon name="link" />
        Compartilhar
      </button>
      <div className="sep" />
      <button className="mi" onClick={act(() => exportWithFeedback('md', file.id))}>
        <Icon name="download" />
        Exportar .md
      </button>
      <button className="mi" onClick={act(() => exportWithFeedback('zip', file.id))}>
        <Icon name="download" />
        Exportar .zip (com a prova)
      </button>
      <button className="mi" onClick={act(() => exportWithFeedback('pdf', file.id))}>
        <Icon name="download" />
        Exportar PDF
      </button>
      <div className="sep" />
      <button
        className="mi danger"
        onClick={act(() => {
          if (descendantsOf(library.files, file.id).length) return ui.open({ kind: 'delete-family', fileId: file.id })
          // the note leaves the list at once; to the Lixeira, the app goes on (T194: a slow write says so in the corner, a failure brings it
          // back, saying why); with the media, which does not come back, the window holds the app until it is done, as before
          const trash = async (media: boolean) => {
            const done = `"${file.name}" foi para a lixeira${media ? ', com a mídia' : ''}`
            if (!media) return void unheld(`Apagando "${file.name}"…`, () => library.trashFiles([file.id], { media }), { done, failed: `Não deu para apagar "${file.name}"` })
            if (await working(`Apagando "${file.name}"…`, () => library.trashFiles([file.id], { media }), { message: 'Apagando a nota e a mídia' })) ui.toast(done)
          }
          if (!library.hasMedia(file.id)) return trash(false)
          ui.open(mediaChoice(file, trash))
        })}
      >
        <Icon name="trash" />
        Apagar
      </button>
    </Popover>
  )
}
