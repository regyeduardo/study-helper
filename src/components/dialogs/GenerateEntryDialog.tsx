import { useState } from 'react'

import type { AtaModelId, AtaPart, FileMeta } from '@/types/domain'
import { AtaPartsFields, toggledPart } from '@/components/dialogs/AtaPartsDialog'
import { AtaStepsField, useAtaSteps } from '@/components/dialogs/AtaSteps'
import { FolderField } from '@/components/dialogs/FolderChooser'
import { lastModel, lastSteps, MoreOptions } from '@/components/dialogs/FromNoteFields'
import { MediaAnalysisField, useMediaAnalysis } from '@/components/dialogs/MediaAnalysisField'
import { type ModelChoice, ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { useDocument } from '@/hooks/use-document'
import { mediaOf } from '@/lib/file-types'
import { ATA_MODELS, PART_ORDER } from '@/lib/generation/ata'
import { sourceExpired } from '@/lib/storage/source-storage'
import { type NoteAgent, useJobsStore } from '@/stores/jobs'
import { type OpenedFile, useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

type Goal = NoteAgent | 'transcribe'

const WRITES: { id: NoteAgent; label: string; hint: string }[] = [
  { id: 'meeting', label: 'Ata', hint: 'Pontos relevantes e tarefas' },
  { id: 'lesson', label: 'Aula', hint: 'Para aprender o conteúdo' },
  { id: 'explanation', label: 'Explicação', hint: 'Direto ao ponto' },
]

const NOTHING_HELD = 'não há o que a IA ler.'

function missingFile({ origin, kept }: FileMeta): string {
  if (origin?.removedAt) return 'O arquivo foi apagado'
  if (sourceExpired(origin)) return 'O arquivo temporário expirou'
  return kept === 'arquivo' ? 'O arquivo não está neste aparelho' : 'Guardado só como registro, sem o arquivo'
}

/** Why nothing can be made of the entrada, or null. `file`: its media or document can be opened now. */
function nothingToRead(entry: FileMeta, opened: OpenedFile, file: boolean): string | null {
  const origin = entry.origin
  if (opened.content.trim() || opened.sidecar.transcript?.trim() || opened.sidecar.recording?.blocks.length) return null
  if (mediaOf(entry) !== 'text') return file ? null : `${missingFile(entry)} e não há transcrição: ${NOTHING_HELD}`
  if (origin?.input === 'topic' || ((origin?.input === 'url' || origin?.input === 'youtube') && origin.url)) return null
  if (origin?.input === 'file') return file ? null : `${missingFile(entry)}: ${NOTHING_HELD}`
  return `O texto desta entrada não foi guardado: ${NOTHING_HELD}`
}

/** "Modelo da ata" and parts of the last time: the newest Ata made from this entrada, else the newest made from any entrada; Padrão with the Resumo when there is none. `note`: the Ata of this entrada, whose models and analysis also come back. */
function lastAta(files: FileMeta[], fileId: string): { model: AtaModelId | null; parts: AtaPart[]; note: FileMeta | null } {
  const atas = files.filter(file => !file.deletedAt && (file.made?.ataModel || file.made?.parts?.length))
  const newest = (list: FileMeta[]) => list.reduce<FileMeta | null>((best, file) => (!best || file.made!.at > best.made!.at ? file : best), null)
  const own = newest(atas.filter(file => file.parentFileId === fileId))
  const last = own ?? newest(atas)
  return { model: last?.made?.ataModel ?? null, parts: last?.made?.parts?.length ? last.made.parts : ['resumo'], note: own }
}

/** "Gerar desta entrada": only what makes sense for its kind and for what it keeps; the note is the entrada's child, and the page stays open. */
export function GenerateEntryDialog({ fileId }: { fileId: string }) {
  const close = useUiStore(state => state.close)
  const { meta: entry, opened } = useDocument(fileId)
  const inBrowser = useLibraryStore(state => state.localMedia.some(item => item.fileIds.includes(fileId)))
  const generateFromNote = useJobsStore(state => state.generateFromNote)
  const generateAta = useJobsStore(state => state.generateAta)
  const transcribeNote = useJobsStore(state => state.transcribeNote)
  const running = useJobsStore(state => state.jobs.some(job => job.fileId === fileId && job.status === 'running'))
  const writing = useJobsStore(state => state.jobs.some(job => job.fileId === fileId && job.status === 'running' && job.kind !== 'transcription'))
  const isMedia = Boolean(entry) && mediaOf(entry!) !== 'text'
  const files = useLibraryStore(state => state.files)
  const settings = useLibraryStore(state => state.index.settings)
  const [ata, setAta] = useState(() => lastAta(files, fileId))
  // the Escrita of the Ata comes back as it was the last time ("Gerar de novo")
  const choices: Record<Goal, ModelChoice> = { meeting: useModelChoice('ata', false, lastModel(ata.note ?? undefined, settings)), lesson: useModelChoice('aula', isMedia), explanation: useModelChoice('explicacao', isMedia), transcribe: useModelChoice('transcricao') }
  const [picked, setPicked] = useState<Goal | null>(null)
  const [folderId, setFolderId] = useState<string | null | undefined>(undefined)
  const [choosing, setChoosing] = useState(false)
  const [instruction, setInstruction] = useState('')

  const origin = entry?.origin ?? null
  const hasFile = Boolean(origin && !origin.removedAt && (inBrowser || ((origin.storedFileId || origin.storedUrl) && !sourceExpired(origin))))
  const canHear = isMedia && hasFile && entry?.kept !== 'registro'
  const spoken = Boolean(opened?.sidecar.recording?.blocks.length)
  const transcribed = spoken || Boolean(opened?.sidecar.transcript?.trim())
  const redo = { id: 'transcribe' as const, label: transcribed ? 'Refazer a transcrição' : 'Transcrever', hint: transcribed ? 'Substitui a de hoje' : 'Fica junto da mídia' }
  const goals = canHear ? (transcribed ? [...WRITES, redo] : [redo, ...WRITES]) : WRITES
  const goal: Goal = goals.find(item => item.id === picked)?.id ?? goals[0].id
  const choice = choices[goal]
  const writes = goal !== 'transcribe'
  const ataOfMedia = goal === 'meeting' && isMedia && (spoken || !transcribed)
  // the Ata of a video goes step by step, each step with its model, or all in one call (FR-072)
  const ataOfVideo = ataOfMedia && Boolean(entry) && mediaOf(entry!) === 'video'
  // a video chooses what the AI analyzes; an audio always goes by its transcription
  const analysis = useMediaAnalysis(choice, writes && Boolean(entry) && mediaOf(entry!) === 'video', canHear || !entry ? null : `${missingFile(entry)}.`, { ata: ataOfVideo, initial: ataOfVideo ? ata.note?.made?.analyze : undefined })
  const steps = useAtaSteps(choices.meeting, ataOfVideo, lastSteps(ata.note ?? undefined, settings), ata.model ? ATA_MODELS[ata.model].name : undefined)
  const stepByStep = ataOfVideo && analysis.value === 'transcricao'

  if (!entry) return null

  const blocked = opened && nothingToRead(entry, opened, canHear || (!isMedia && hasFile))
  // the Ata of a media needs a model or at least one part
  const ataEmpty = ataOfMedia && !ata.model && !ata.parts.length
  // the store ignores these, so the window says it instead of doing nothing
  const busy = writes ? (!transcribed && isMedia && running) || (ataOfMedia && writing) : running
  const destination = folderId === undefined ? entry.folderId : folderId

  const start = () => {
    close()
    if (goal === 'transcribe') return void transcribeNote(fileId, undefined, choice.model || null)
    const place = { folderId: destination }
    if (ataOfMedia) return void generateAta(fileId, ata.model ? [] : PART_ORDER.filter(part => ata.parts.includes(part)), ata.model ?? undefined, { model: choice.model || null, ...(stepByStep ? steps.sent : {}) }, place, instruction, undefined, analysis.sent)
    void generateFromNote(fileId, goal, choice.model || null, place, instruction, analysis.sent)
  }

  return (
    <Dialog
      title="Gerar desta entrada"
      size="narrow"
      onClose={choosing ? undefined : close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!opened || Boolean(blocked) || !choice.ready || busy || ataEmpty} onClick={start}>
            Gerar
          </button>
        </>
      }
    >
      <div className="db">
        <p className="muted" style={{ marginTop: 0 }}>
          {`De “${entry.name}”.`}
        </p>
        {!opened && <div className="muted">Abrindo…</div>}
        {blocked && (
          <div className="banner" role="status">
            <Icon name="warn" />
            <span>{blocked}</span>
          </div>
        )}
        {opened && !blocked && (
          <>
            <div className="field">
              <span className="lab">O que gerar</span>
              <div className="opts cols2" role="radiogroup" aria-label="O que gerar">
                {goals.map(item => (
                  <button key={item.id} className="opt" role="radio" aria-checked={goal === item.id} onClick={() => setPicked(item.id)}>
                    <span className="radio" />
                    <span>
                      <b>{item.label}</b>
                      <span>{item.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {ataOfMedia && <AtaPartsFields parts={ata.parts} onToggle={part => setAta(current => ({ ...current, parts: toggledPart(current.parts, part) }))} model={ata.model} onModel={model => setAta(current => ({ ...current, model }))} />}
            <ModelPick choice={choice} />
            {writes && mediaOf(entry) === 'video' && <MediaAnalysisField analysis={analysis} />}
            {stepByStep && <AtaStepsField steps={steps} />}
            {writes && (
              <div className="field">
                <span className="lab">Salvar em</span>
                <FolderField value={destination} onChange={setFolderId} label="Salvar em" title="Onde salvar a nota nova" leaf={`${WRITES.find(item => item.id === goal)?.label}: ${entry.name}`} open={choosing} onOpenChange={setChoosing} />
              </div>
            )}
            {writes && <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder="Ex.: foque nas decisões e nas tarefas" />}
            {busy && (
              <div className="banner" role="status">
                <Icon name="info" />
                <span>Já há um trabalho em andamento nesta entrada: espere terminar para pedir este.</span>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
