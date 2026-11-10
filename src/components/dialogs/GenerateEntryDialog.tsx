import { useEffect, useMemo, useState } from 'react'

import type { AtaModelId, AtaPart, FileMeta, MediaAnalysis } from '@/types/domain'
import { AtaPartsFields, toggledPart } from '@/components/dialogs/AtaPartsDialog'
import { FolderField } from '@/components/dialogs/FolderChooser'
import { MoreOptions } from '@/components/dialogs/FromNoteFields'
import { type ModelChoice, ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { useDocument } from '@/hooks/use-document'
import { aiConfigOf } from '@/lib/ai/config'
import { mediaOf } from '@/lib/file-types'
import { PART_ORDER } from '@/lib/generation/ata'
import { sourceExpired } from '@/lib/storage/source-storage'
import { type NoteAgent, useJobsStore } from '@/stores/jobs'
import { type OpenedFile, useLibraryStore } from '@/stores/library'
import { mediaOfModel, useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'

type Goal = NoteAgent | 'transcribe'

const WRITES: { id: NoteAgent; label: string; hint: string }[] = [
  { id: 'meeting', label: 'Ata', hint: 'Pontos relevantes e tarefas' },
  { id: 'lesson', label: 'Aula', hint: 'Para aprender o conteúdo' },
  { id: 'explanation', label: 'Explicação', hint: 'Direto ao ponto' },
]

const ANALYSES: { id: MediaAnalysis; label: string; hint: string }[] = [
  { id: 'video', label: 'Só o vídeo', hint: 'A mídia vai direto ao modelo.' },
  { id: 'transcricao', label: 'Só a transcrição', hint: 'Só o texto; se faltar, ela é feita antes.' },
  { id: 'ambos', label: 'Transcrição + vídeo', hint: 'Os dois na mesma chamada.' },
]

const NOT_HEARD = 'O modelo escolhido não ouve a mídia.'
const NOTHING_HELD = 'não há o que a IA ler.'

/** "O que a IA analisa" (FR-046): comes with the media when the model hears it, else the transcription. `unavailable`: why the media cannot go. `sent`: only what the person marked, so that untouched the request stays as today. */
export function useMediaAnalysis(choice: ModelChoice | null, on: boolean, unavailable: string | null = null) {
  const settings = useLibraryStore(state => state.index.settings)
  const live = useModelsStore(state => state.live)
  const probes = useModelsStore(state => state.probes)
  const readStale = useModelsStore(state => state.readStale)
  const config = useMemo(() => aiConfigOf(settings), [settings])
  const [picked, setPicked] = useState<MediaAnalysis | null>(null)
  useEffect(() => {
    if (on) readStale(config.providers.filter(provider => config.models.some(model => model.pid === provider.id)))
  }, [config, on, readStale])
  const hears = Boolean(choice?.model) && mediaOfModel(config, live, probes, choice!.model)?.audio === true
  const reason = unavailable ?? (hears ? null : NOT_HEARD)
  const value: MediaAnalysis = picked && (picked === 'transcricao' || !reason) ? picked : reason ? 'transcricao' : 'video'
  return { value, reason, pick: setPicked, sent: picked === value ? value : undefined }
}

/** Options the model or the entrada cannot do stay visible, disabled, saying why. */
export function MediaAnalysisField({ analysis }: { analysis: ReturnType<typeof useMediaAnalysis> }) {
  return (
    <div className="field">
      <span className="lab">O que a IA analisa</span>
      <div className="opts says-why" role="radiogroup" aria-label="O que a IA analisa">
        {ANALYSES.map(item => {
          const blocked = item.id === 'transcricao' ? null : analysis.reason
          return (
            <button key={item.id} className="opt" role="radio" aria-checked={analysis.value === item.id} aria-disabled={Boolean(blocked)} onClick={() => !blocked && analysis.pick(item.id)}>
              <span className="radio" />
              <span>
                <b>{item.label}</b>
                <span>
                  {item.hint}
                  {blocked && <> <span className="lim">{blocked}</span></>}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

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

/** "Modelo da ata" of the last time: the newest Ata made from this entrada, else the newest made from any entrada; Padrão with the Resumo when there is none. */
function lastAta(files: FileMeta[], fileId: string): { model: AtaModelId | null; parts: AtaPart[] } {
  const atas = files.filter(file => !file.deletedAt && (file.made?.ataModel || file.made?.parts?.length))
  const newest = (list: FileMeta[]) => list.reduce<FileMeta | null>((best, file) => (!best || file.made!.at > best.made!.at ? file : best), null)
  const last = newest(atas.filter(file => file.parentFileId === fileId)) ?? newest(atas)
  return { model: last?.made?.ataModel ?? null, parts: last?.made?.parts?.length ? last.made.parts : ['resumo'] }
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
  const choices: Record<Goal, ModelChoice> = { meeting: useModelChoice('ata', isMedia), lesson: useModelChoice('aula', isMedia), explanation: useModelChoice('explicacao', isMedia), transcribe: useModelChoice('transcricao') }
  const [picked, setPicked] = useState<Goal | null>(null)
  const [folderId, setFolderId] = useState<string | null | undefined>(undefined)
  const [choosing, setChoosing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const files = useLibraryStore(state => state.files)
  const [ata, setAta] = useState(() => lastAta(files, fileId))

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
  // a video chooses what the AI analyzes; an audio always goes by its transcription
  const analysis = useMediaAnalysis(choice, writes && Boolean(entry) && mediaOf(entry!) === 'video', canHear || !entry ? null : `${missingFile(entry)}.`)

  if (!entry) return null

  const blocked = opened && nothingToRead(entry, opened, canHear || (!isMedia && hasFile))
  const ataOfMedia = goal === 'meeting' && isMedia && (spoken || !transcribed)
  // the Ata of a media needs a model or at least one part
  const ataEmpty = ataOfMedia && !ata.model && !ata.parts.length
  // the store ignores these, so the window says it instead of doing nothing
  const busy = writes ? (!transcribed && isMedia && running) || (ataOfMedia && writing) : running
  const destination = folderId === undefined ? entry.folderId : folderId

  const start = () => {
    close()
    if (goal === 'transcribe') return void transcribeNote(fileId, undefined, choice.model || null)
    const place = { folderId: destination }
    if (ataOfMedia) return void generateAta(fileId, ata.model ? [] : PART_ORDER.filter(part => ata.parts.includes(part)), ata.model ?? undefined, { model: choice.model || null, everyStep: choice.videoWrites }, place, instruction, undefined, analysis.sent)
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
