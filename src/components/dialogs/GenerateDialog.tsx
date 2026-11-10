import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { FolderWindow, lastModel, madeLine, MoreOptions, ReplaceOrNew, SaveIn, useNoteFolder } from '@/components/dialogs/FromNoteFields'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { mediaOf } from '@/lib/file-types'
import { paths } from '@/lib/paths'
import { type SecondTabAgent, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

/**
 * Gerar (or Refazer) the Aula or the Ata of a note: the model selector is always there, with the default preselected.
 * A new note says where it goes ("Salvar em", Trocar); `again`: the note made before, whose model and instruction come back (Gerar de novo).
 */
export function GenerateDialog({ fileId, agent, redo = false, again }: { fileId: string; agent: SecondTabAgent; redo?: boolean; again?: string }) {
  const close = useUiStore(state => state.close)
  const navigate = useNavigate()
  const file = useLibraryStore(state => state.files.find(item => item.id === fileId))
  const before = useLibraryStore(state => state.files.find(item => item.id === again))
  const settings = useLibraryStore(state => state.index.settings)
  const generateFromNote = useJobsStore(state => state.generateFromNote)
  const generateSecondTab = useJobsStore(state => state.generateSecondTab)
  const choice = useModelChoice(agent === 'meeting' ? 'ata' : 'aula', agent !== 'meeting' && Boolean(file) && mediaOf(file!) !== 'text', lastModel(before, settings))
  const folder = useNoteFolder(fileId)
  const [replace, setReplace] = useState(Boolean(before))
  const [instruction, setInstruction] = useState(before?.made?.instruction ?? '')
  const label = agent === 'meeting' ? 'Ata' : 'Aula'
  const start = () => {
    close()
    const model = choice.model || null
    if (redo) void generateSecondTab(fileId, agent, model, instruction)
    else void generateFromNote(fileId, agent, model, replace && before ? { replace: before.id } : folder.place, instruction, before?.made?.analyze).then(id => id && navigate(paths.file(id)))
  }
  return (
    <>
      <Dialog
        title={before ? `Gerar de novo a ${label}` : `${redo ? 'Refazer' : 'Gerar'} a ${label}`}
        size="narrow"
        onClose={folder.open ? undefined : close}
        footer={
          <>
            <button className="btn quiet" onClick={close}>
              Cancelar
            </button>
            <button className="btn primary" disabled={!choice.ready} onClick={start}>
              Gerar
            </button>
          </>
        }
      >
        <div className="db">
          {file && (
            <p className="muted" style={{ marginTop: 0 }}>
              {`De "${file.name}".`}
            </p>
          )}
          {before && (
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              {`Da última vez: ${madeLine(before, settings)}`}
            </p>
          )}
          <ModelPick choice={choice} />
          {before && <ReplaceOrNew replace={replace} onReplace={choice => (setReplace(choice), choice || folder.setOpen(true))} />}
          {!redo && !replace && <SaveIn folder={folder} />}
          <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder={agent === 'meeting' ? 'Ex.: foque nas decisões e nas tarefas' : 'Ex.: foque na parte prática'} open={Boolean(before?.made?.instruction)} />
        </div>
      </Dialog>
      {folder.open && <FolderWindow folder={folder} noteName={`${label}: ${file?.name ?? ''}`} />}
    </>
  )
}

/** Transcrever a note that is only the media: the Transcrição selector, with the default preselected. */
export function TranscribeDialog({ fileId }: { fileId: string }) {
  const close = useUiStore(state => state.close)
  const file = useLibraryStore(state => state.files.find(item => item.id === fileId))
  const transcribeNote = useJobsStore(state => state.transcribeNote)
  const choice = useModelChoice('transcricao')
  const start = () => {
    close()
    void transcribeNote(fileId, undefined, choice.model || null)
  }
  return (
    <Dialog
      title="Transcrever"
      size="narrow"
      onClose={close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!choice.ready} onClick={start}>
            Transcrever
          </button>
        </>
      }
    >
      <div className="db">
        {file && (
          <p className="muted" style={{ marginTop: 0 }}>
            {`De "${file.name}".`}
          </p>
        )}
        <ModelPick choice={choice} label="Transcrição" />
      </div>
    </Dialog>
  )
}
