import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { AiUse } from '@/types/domain'
import { FolderWindow, lastModel, madeLine, MoreOptions, ReplaceOrNew, SaveIn, useNoteFolder } from '@/components/dialogs/FromNoteFields'
import { useGoToNew } from '@/components/dialogs/go-to-new'
import { type ModelChoice, ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { useDocument } from '@/hooks/use-document'
import { blocking } from '@/lib/blocking'
import { mediaOf } from '@/lib/file-types'
import { courseOf } from '@/lib/generation/course-lesson'
import { paths } from '@/lib/paths'
import { type NoteAgent, remainingIn, type Target, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { asking } from '@/stores/retry'
import { type GenerationPrefill, type Overlay, useUiStore } from '@/stores/ui'
import { analyzedBefore } from '@/components/dialogs/MediaAnalysisField'

const LABEL: Record<NoteAgent, string> = { meeting: 'Ata', lesson: 'Aula', explanation: 'Explicação' }
const USE: Record<NoteAgent, AiUse> = { meeting: 'ata', lesson: 'aula', explanation: 'explicacao' }
const PLACEHOLDER: Record<NoteAgent, string> = { meeting: 'Ex.: foque nas decisões e nas tarefas', lesson: 'Ex.: foque na parte prática', explanation: 'Ex.: com um exemplo do dia a dia' }

/** What comes chosen when the window comes back after a failure. */
const lastOf = (prefill: GenerationPrefill) => ({ ...(prefill.model ? { pick: prefill.model } : {}), ...(prefill.videoWrites ? { videoWrites: true } : {}) })

/** The model as the window had it: kept only when the person (or the last time) chose it. */
const pickedOf = (choice: ModelChoice): Pick<GenerationPrefill, 'model' | 'videoWrites'> => ({ ...(choice.touched && choice.pick ? { model: choice.pick } : {}), ...(choice.videoWrites ? { videoWrites: true } : {}) })

/**
 * Gerar (or Refazer) the Aula, the Ata or the Explicação of a note: the model selector is always there, with the default preselected.
 * A new note says where it goes ("Salvar em", Trocar); `again`: the note made before, whose model and instruction come back (Gerar de novo). An explanation of a passage is written again from the same passage.
 * `prefill`: the window as it was when that generation failed.
 */
export function GenerateDialog({ fileId, agent, redo = false, again, prefill }: { fileId: string; agent: NoteAgent; redo?: boolean; again?: string; prefill?: GenerationPrefill }) {
  const close = useUiStore(state => state.close)
  const goToNew = useGoToNew()
  const file = useLibraryStore(state => state.files.find(item => item.id === fileId))
  const before = useLibraryStore(state => state.files.find(item => item.id === again))
  const settings = useLibraryStore(state => state.index.settings)
  const generateFromNote = useJobsStore(state => state.generateFromNote)
  const generateSecondTab = useJobsStore(state => state.generateSecondTab)
  const explainSelection = useJobsStore(state => state.explainSelection)
  const choice = useModelChoice(USE[agent], agent !== 'meeting' && Boolean(file) && mediaOf(file!) !== 'text', prefill ? lastOf(prefill) : lastModel(before, settings))
  const folder = useNoteFolder(fileId, prefill?.folderId)
  const [replace, setReplace] = useState(prefill?.replace ?? Boolean(before))
  const [instruction, setInstruction] = useState(prefill?.instruction ?? before?.made?.instruction ?? '')
  // redoing, the instruction is what changes: it comes in sight
  const [inSight] = useState(redo || Boolean(before) || Boolean(instruction))
  const label = LABEL[agent]
  const excerpt = agent === 'explanation' ? before?.sourceExcerpt : undefined
  const start = () => {
    close()
    const model = choice.model || null
    const over = replace && before ? before : null
    const place: Target = over ? { replace: over.id } : folder.place
    const analyze = prefill?.analyze ?? analyzedBefore(before?.made)
    // a note made step by step comes back step by step, with the models of each step (T177)
    const steps = analyze === 'quadros' ? (prefill?.steps ?? before?.made?.steps ?? {}) : undefined
    const retry: Overlay = {
      kind: 'generate',
      fileId,
      agent,
      ...(redo ? { redo } : {}),
      ...(again ? { again } : {}),
      prefill: { ...pickedOf(choice), instruction, ...(analyze ? { analyze } : {}), ...(steps ? { steps } : {}), ...(before ? { replace } : {}), ...(typeof folder.place === 'object' ? { folderId: folder.place.folderId } : {}) },
    }
    const ids = over ? [fileId, over.id] : [fileId]
    const open = (id: string | null | undefined) => id && goToNew(paths.file(id), `Gerando a ${label}`)
    if (redo && agent !== 'explanation') return void asking(ids, retry, () => generateSecondTab(fileId, agent, model, instruction))
    // the same passage, asked again; a new note goes where it was put (absent: where it went the first time).
    // Until its job opens (the note read, the explanation made in the Drive) the app is held in the window.
    if (excerpt && before)
      return void asking(ids, retry, () => blocking(`${label}: ${file?.name ?? ''}`, () => explainSelection(fileId, excerpt, instruction, before.folderId === null ? 'concept' : 'context', model, place), { phase: 'Preparando' })).then(open)
    void asking(ids, retry, () => generateFromNote(fileId, agent, model, place, instruction, analyze, ...(steps ? [steps] : []))).then(open)
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
          {excerpt && (
            <div className="note">
              <q>{excerpt}</q>
            </div>
          )}
          {before && (
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              {`Da última vez: ${madeLine(before, settings)}`}
            </p>
          )}
          <ModelPick choice={choice} />
          {before && <ReplaceOrNew replace={replace} onReplace={choice => (setReplace(choice), choice || folder.setOpen(true))} />}
          {!redo && !replace && <SaveIn folder={folder} />}
          <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder={PLACEHOLDER[agent]} open={inSight} />
        </div>
      </Dialog>
      {folder.open && <FolderWindow folder={folder} noteName={`${label}: ${file?.name ?? ''}`} />}
    </>
  )
}

/** Transcrever (or Refazer a transcrição) a note that is only the media: the Transcrição selector, with the default preselected, and what the revision must fix. */
export function TranscribeDialog({ fileId, prefill }: { fileId: string; prefill?: GenerationPrefill }) {
  const close = useUiStore(state => state.close)
  const { meta: file, opened } = useDocument(fileId)
  const transcribeNote = useJobsStore(state => state.transcribeNote)
  const choice = useModelChoice('transcricao', false, prefill ? lastOf(prefill) : {})
  const [instruction, setInstruction] = useState(prefill?.instruction ?? '')
  const redo = Boolean(opened?.sidecar.recording?.blocks.length || opened?.sidecar.transcript?.trim())
  const [asked] = useState(Boolean(instruction))
  const start = () => {
    close()
    const retry: Overlay = { kind: 'transcribe', fileId, prefill: { ...pickedOf(choice), instruction } }
    void asking([fileId], retry, () => transcribeNote(fileId, undefined, choice.model || null, instruction))
  }
  return (
    <Dialog
      title={redo ? 'Refazer a transcrição' : 'Transcrever'}
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
            {redo ? `De "${file.name}". A transcrição de hoje é trocada pela nova.` : `De "${file.name}".`}
          </p>
        )}
        <ModelPick choice={choice} label="Transcrição" />
        <MoreOptions key={String(redo)} instruction={instruction} onInstruction={setInstruction} placeholder="Ex.: o nome certo é João Vitor; é PIX, não pics" open={redo || asked} />
      </div>
    </Dialog>
  )
}

/**
 * "Gerar agora" of a lesson still to write, "Tentar de novo" of a note that failed, "Refazer" of a lesson of a course, and "Gerar as aulas que faltam" of a course folder (one choice for all):
 * the model and the instruction are chosen here before anything starts. `go`: the note opens once it starts (she clicked it to open it).
 */
export function PendingDialog({ fileId, folderId, go = false, prefill }: { fileId?: string; folderId?: string; go?: boolean; prefill?: GenerationPrefill }) {
  const close = useUiStore(state => state.close)
  const navigate = useNavigate()
  const files = useLibraryStore(state => state.files)
  const folders = useLibraryStore(state => state.folders)
  const settings = useLibraryStore(state => state.index.settings)
  const generatePending = useJobsStore(state => state.generatePending)
  const generateRemaining = useJobsStore(state => state.generateRemaining)
  const notes = useMemo(() => (folderId ? remainingIn(folderId, folders, files) : files.filter(file => file.id === fileId && !file.deletedAt)), [folderId, fileId, folders, files])
  const first = notes[0]
  const course = Boolean(first && courseOf(folders, first.folderId))
  const agent: NoteAgent = !course && first?.type === 'explanation' ? 'explanation' : !course && first?.type === 'meeting' ? 'meeting' : 'lesson'
  const choice = useModelChoice(USE[agent], false, prefill ? lastOf(prefill) : lastModel(first, settings))
  const [instruction, setInstruction] = useState(prefill?.instruction ?? first?.made?.instruction ?? '')
  const ready = first?.status === 'ready'
  // a note written again (or tried again) has the instruction in sight
  const [inSight] = useState(ready || (!course && !folderId) || Boolean(instruction))
  const label = LABEL[agent]
  const folder = folderId ? folders.find(item => item.id === folderId) : undefined
  const title = folderId ? 'Gerar as aulas que faltam' : ready ? `Refazer a ${label}` : course ? `Gerar a ${label}` : 'Tentar de novo'
  const said = folderId
    ? notes.length
      ? `${notes.length} ${notes.length === 1 ? 'aula ainda não escrita' : 'aulas ainda não escritas'} em “${folder?.name ?? 'Pasta'}”.`
      : 'Nenhuma aula falta escrever aqui.'
    : ready
      ? `De “${first.name}”. O texto de hoje é trocado pelo novo.`
      : course
        ? 'Esta aula ainda não foi escrita. O recorte do material já está guardado.'
        : 'A geração não terminou. O material ficou guardado para tentar de novo.'
  const start = () => {
    close()
    const model = choice.model || null
    const retry: Overlay = { kind: 'pending', ...(fileId ? { fileId } : {}), ...(folderId ? { folderId } : {}), prefill: { ...pickedOf(choice), instruction } }
    if (folderId) return void asking(notes.map(note => note.id), retry, () => generateRemaining(folderId, model, instruction))
    if (!fileId) return
    void asking([fileId], retry, () => generatePending(fileId, model, instruction))
    if (go) navigate(paths.file(fileId))
  }
  return (
    <Dialog
      title={title}
      size="narrow"
      onClose={close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!choice.ready || !notes.length} onClick={start}>
            Gerar
          </button>
        </>
      }
    >
      <div className="db">
        <p className="muted" style={{ marginTop: 0 }}>
          {said}
        </p>
        {!folderId && first && !ready && <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>{`“${first.name}”`}</p>}
        <ModelPick choice={choice} />
        <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder={PLACEHOLDER[agent]} open={inSight} />
      </div>
    </Dialog>
  )
}
