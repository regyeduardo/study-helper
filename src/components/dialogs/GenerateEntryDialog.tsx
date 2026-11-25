import { useState } from 'react'

import type { AtaModelId, AtaPart, FileMeta } from '@/types/domain'
import { AtaPartsFields, toggledPart } from '@/components/dialogs/AtaPartsDialog'
import { AtaStepsField, useAtaSteps } from '@/components/dialogs/AtaSteps'
import { FolderField } from '@/components/dialogs/FolderChooser'
import { lastModel, lastSteps, MoreOptions } from '@/components/dialogs/FromNoteFields'
import { analyzedBefore, MediaAnalysisField, useMediaAnalysis } from '@/components/dialogs/MediaAnalysisField'
import { type ModelChoice, ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { useDocument } from '@/hooks/use-document'
import { isYoutube, mediaOf } from '@/lib/file-types'
import { ATA_MODELS, PART_ORDER } from '@/lib/generation/ata'
import { sourceExpired } from '@/lib/storage/source-storage'
import { type NoteAgent, useJobsStore } from '@/stores/jobs'
import { type OpenedFile, useLibraryStore } from '@/stores/library'
import { asking } from '@/stores/retry'
import { type GenerationPrefill, useUiStore } from '@/stores/ui'

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
  return `O texto desta nota não foi guardado: ${NOTHING_HELD}`
}

/** "Modelo da ata" and parts of the last time: the newest Ata made from this entrada, else the newest made from any entrada; Padrão with the Resumo when there is none. `note`: the Ata of this entrada, whose models and analysis also come back. */
export function lastAta(files: FileMeta[], fileId: string): { model: AtaModelId | null; parts: AtaPart[]; note: FileMeta | null } {
  const atas = files.filter(file => !file.deletedAt && (file.made?.ataModel || file.made?.parts?.length))
  const newest = (list: FileMeta[]) => list.reduce<FileMeta | null>((best, file) => (!best || file.made!.at > best.made!.at ? file : best), null)
  const own = newest(atas.filter(file => file.parentFileId === fileId))
  const last = own ?? newest(atas)
  return { model: last?.made?.ataModel ?? null, parts: last?.made?.parts?.length ? last.made.parts : ['resumo'], note: own }
}

/** "Gerar desta entrada": only what makes sense for its kind and for what it keeps; the note is the entrada's child, and the page stays open. `prefill`: the window as it was when that generation failed. */
export function GenerateEntryDialog({ fileId, prefill }: { fileId: string; prefill?: GenerationPrefill }) {
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
  const [ata, setAta] = useState(() => (prefill?.goal === 'meeting' ? { ...lastAta(files, fileId), model: prefill.ataModel ?? null, parts: prefill.parts ?? ['resumo'] } : lastAta(files, fileId)))
  // after a failure, the model of what was asked comes back as it was
  const asked = (goal: Goal) => (prefill?.goal === goal ? { ...(prefill.model ? { pick: prefill.model } : {}), ...(prefill.videoWrites ? { videoWrites: true } : {}) } : undefined)
  // the Escrita of the Ata comes back as it was the last time ("Gerar de novo")
  const choices: Record<Goal, ModelChoice> = {
    meeting: useModelChoice('ata', false, asked('meeting') ?? lastModel(ata.note ?? undefined, settings)),
    lesson: useModelChoice('aula', isMedia, asked('lesson')),
    explanation: useModelChoice('explicacao', isMedia, asked('explanation')),
    transcribe: useModelChoice('transcricao', false, asked('transcribe')),
  }
  const [picked, setPicked] = useState<Goal | null>(prefill?.goal ?? null)
  const [folderId, setFolderId] = useState<string | null | undefined>(prefill && 'folderId' in prefill ? prefill.folderId : undefined)
  const [choosing, setChoosing] = useState(false)
  const [instruction, setInstruction] = useState(prefill?.instruction ?? '')

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
  // a video chooses what the AI analyzes (a YouTube one by its link); an audio always goes by its transcription
  const youtube = Boolean(entry) && isYoutube(entry!)
  const isVideo = Boolean(entry) && (mediaOf(entry!) === 'video' || youtube)
  // an Ata written from the transcription in text (no speech to follow) does not look at the video
  const analyzes = writes && isVideo && (goal !== 'meeting' || ataOfMedia || youtube)
  const analysis = useMediaAnalysis(choice, analyzes, canHear || youtube || !entry ? null : `${missingFile(entry)}.`, { ata: ataOfVideo, initial: prefill ? prefill.analyze : ataOfVideo ? analyzedBefore(ata.note?.made) : undefined, youtube })
  // every note of a video goes step by step with the models of its steps (T177): the Ata, the Aula and the Explicação
  const stepByStep = analyzes && !youtube && analysis.value === 'quadros'
  const steps = useAtaSteps(choice, stepByStep, prefill?.steps ?? lastSteps(ata.note ?? undefined, settings), goal === 'meeting' && ata.model ? ATA_MODELS[ata.model].name : undefined, goal === 'lesson' ? 'aula' : goal === 'explanation' ? 'explicacao' : undefined)
  // an instruction that comes back (after a failure) is in sight
  const [inSight] = useState(Boolean(instruction))

  if (!entry) return null

  const blocked = opened && nothingToRead(entry, opened, canHear || (!isMedia && hasFile))
  // the Ata of a media needs a model or at least one part
  const ataEmpty = ataOfMedia && !ata.model && !ata.parts.length
  // the store ignores these, so the window says it instead of doing nothing
  const busy = writes ? (!transcribed && isMedia && running) || (ataOfMedia && writing) : running
  const destination = folderId === undefined ? entry.folderId : folderId

  const start = () => {
    close()
    // a failure brings this window back as it is now
    const retry = {
      kind: 'generate-entry' as const,
      fileId,
      prefill: {
        goal,
        ...(choice.touched && choice.pick ? { model: choice.pick } : {}),
        ...(choice.videoWrites ? { videoWrites: true } : {}),
        instruction,
        ...(folderId !== undefined ? { folderId } : {}),
        ...(analysis.sent ? { analyze: analysis.sent } : {}),
        ...(goal === 'meeting' ? { ataModel: ata.model, parts: ata.parts } : {}),
        ...(stepByStep ? { steps: steps.sent } : {}),
      },
    }
    if (goal === 'transcribe') return void asking([fileId], retry, () => transcribeNote(fileId, undefined, choice.model || null, instruction))
    const place = { folderId: destination }
    if (ataOfMedia) return void asking([fileId], retry, () => generateAta(fileId, ata.model ? [] : PART_ORDER.filter(part => ata.parts.includes(part)), ata.model ?? undefined, { model: choice.model || null, ...(stepByStep ? steps.sent : {}) }, place, instruction, undefined, analysis.sent))
    void asking([fileId], retry, () => generateFromNote(fileId, goal, choice.model || null, place, instruction, analysis.sent, ...(stepByStep ? [steps.sent] : [])))
  }

  return (
    <Dialog
      title="Gerar desta nota"
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
            {analyzes && <MediaAnalysisField analysis={analysis} />}
            {stepByStep && <AtaStepsField steps={steps} />}
            {writes && (
              <div className="field">
                <span className="lab">Salvar em</span>
                <FolderField value={destination} onChange={setFolderId} label="Salvar em" title="Onde salvar a nota nova" leaf={`${WRITES.find(item => item.id === goal)?.label}: ${entry.name}`} open={choosing} onOpenChange={setChoosing} />
              </div>
            )}
            {/* redoing the transcription, what to fix is in sight; it goes to the revision of the transcription */}
            <MoreOptions key={writes ? 'nota' : 'transcricao'} instruction={instruction} onInstruction={setInstruction} placeholder={writes ? 'Ex.: foque nas decisões e nas tarefas' : 'Ex.: o nome certo é João Vitor; é PIX, não pics'} open={inSight || (!writes && transcribed)} />
            {busy && (
              <div className="banner" role="status">
                <Icon name="info" />
                <span>Já há um trabalho em andamento nesta nota: espere terminar para pedir este.</span>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
