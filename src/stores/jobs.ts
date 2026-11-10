import { create } from 'zustand'

import type { AiSettings, AiStep, AiUse, AtaModelId, AtaPart, AtaStepModels, CourseAnalysis, FileMeta, FileType, FolderMeta, GenerationChoice, GenerationMeta, MediaAnalysis, MeetingDocument, RecordingData, RecordingMark, SourceMeta, SourceStorage, StageTime, StoredQuestion } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import { storedFromRaw } from '@/lib/exam'
import { aiConfigOf, modelByUid, providerById, targetFor, targetOf, transcriptionOf, uidFor } from '@/lib/ai/config'
import { modelOf } from '@/lib/ai/providers'
import { analyzeCourse } from '@/lib/generation/course'
import { ATA_MODELS, buildAta, chosenParts } from '@/lib/generation/ata'
import { ataDocument, ataPrompt, type MediaParts, mediaParts, withTranscript } from '@/lib/generation/from-media'
import { type AtaModels, appAi } from '@/lib/generation/ata-ai'
import type { FrameSource } from '@/lib/generation/ata-types'
import { renderPrint } from '@/lib/generation/prints'
import { openVideoFrames, signatureDifference } from '@/lib/generation/video-source'
import { courseLessonInput, courseOf, explanationName, selectionInput, selectionTitle } from '@/lib/generation/course-lesson'
import { type ContentInput, mediaDuration, resolveInput, type ResolvedInput } from '@/lib/generation/inputs'
import { withInstruction } from '@/lib/generation/instruction'
import { buildMinutes, minutesFileName } from '@/lib/generation/minutes'
import { generateContent, type GenerationEvent } from '@/lib/generation/pipeline'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { generateQuestions, generateReadingExam, type WrongQuestion } from '@/lib/generation/questions'
import type { WebOutcome } from '@/lib/generation/web-questions'
import { lookAtScreen, visionSettingsOf } from '@/lib/generation/frames'
import { polishTranscript } from '@/lib/generation/polish'
import { redoTranscript } from '@/lib/generation/reviewer'
import { GenerationSession } from '@/lib/generation/session'
import { suggestTags } from '@/lib/generation/tags'
import { newId, nowIso } from '@/lib/ids'
import { sourceKey } from '@/lib/entry-migration'
import { mediaOf, type NoteMedia, recordingName } from '@/lib/file-types'
import { downloadStoredSource, sourceExpired, storeSource } from '@/lib/storage/source-storage'
import { keepLocalMedia, linkLocalMedia, readLocalMedia } from '@/lib/recording/media-library'
import { transcribe } from '@/lib/transcription'
import { StageClock } from '@/lib/transcription/types'
import { transcriptText } from '@/lib/transcription/export'
import { recorderName, useAccountStore } from '@/stores/account'
import { liveFolders, useLibraryStore } from '@/stores/library'
import { mediaOfModel, searchesWeb, useModelsStore } from '@/stores/models'

export type Agent = 'lesson' | 'explanation' | 'meeting' | 'reading'

export type SecondTabAgent = 'meeting' | 'lesson'

/** What a note made from another can be. */
export type NoteAgent = SecondTabAgent | 'explanation'

/** Where a note made from another goes: 'home', the folder named after the source (made if missing; the source moves in), or the folder picked. */
export type Placement = 'home' | { folderId: string | null }

/** A new note, placed; or `replace`: the note made before from the same source gets the new text. */
export type Target = Placement | { replace: string }

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

/** What stays of the source (FR-023): nothing ("Sem rastro"), its name, link and origin ("Só o registro"), or also the file, in `storage` ("Registro e arquivo"). */
export type KeepLevel = 'sem-rastro' | 'registro' | 'arquivo'

/** Text, topic and link start at "Só o registro"; a file and media, at "Registro e arquivo"; an Ata, always at "Só o registro". */
export function defaultKeep(kind: ContentInput['kind'], agent?: Agent): KeepLevel {
  return agent !== 'meeting' && (kind === 'file' || kind === 'recording') ? 'arquivo' : 'registro'
}

export interface Job {
  id: string
  kind: 'generation' | 'questions' | 'course' | 'transcription' | 'sync'
  title: string
  fileId: string | null
  status: JobStatus
  message: string
  fraction: number | null
  error: string | null
  startedAt: number
}

export interface NewContentRequest {
  agent: Agent
  input: ContentInput
  name: string
  description: string
  folderId: string | null
  prompt: string
  /** Absent: the level the input starts at (`defaultKeep`). */
  keep?: KeepLevel
  /** Where the file goes with "Registro e arquivo". */
  storage: SourceStorage
  litterboxTime: LitterboxTime
  marks?: RecordingMark[]
  ataParts?: AtaPart[]
  /** "Modelo da ata": the Ata in that model instead of the parts. */
  ataModel?: AtaModelId
  /** Models picked in the dialog (the default comes preselected there). */
  models?: GenerationModels
  /** Of a video, what the AI analyzes (FR-046); absent: the media when the model hears it, else the transcription. An audio always goes by its transcription. */
  analyze?: MediaAnalysis
}

/** What the generation dialog picked: who writes, who transcribes; `everyStep`: the video model writes the document (Aula and Explicação); `steps`: what was picked in "Modelos por passo" for the Ata of a video. */
export interface GenerationModels {
  write?: string | null
  transcription?: string | null
  everyStep?: boolean
  steps?: Omit<AtaModels, 'model'>
}

export interface SaveRecordingRequest {
  file: File
  storedName: string | null
  durationSeconds: number
  folderId: string | null
  storage: SourceStorage
  litterboxTime: LitterboxTime
  marks: RecordingMark[]
  transcribe: boolean
  /** The Transcrição model picked when saving (else the default). */
  transcriptionModel?: string | null
}

export interface CourseProposal {
  analysis: CourseAnalysis
  request: NewContentRequest
  resolved: ResolvedInput
}

interface JobsState {
  jobs: Job[]
  live: Record<string, string>
  proposals: CourseProposal[]
  startNewContent(request: NewContentRequest, onJob?: (jobId: string) => void): Promise<string | null>
  saveRecording(request: SaveRecordingRequest): Promise<string>
  transcribeNote(fileId: string, source?: File, transcriptionModel?: string | null): Promise<void>
  acceptCourse(proposal: CourseProposal, folderId: string | null): Promise<string>
  declineCourse(proposal: CourseProposal): Promise<string>
  generatePending(fileId: string, model?: string | null): Promise<void>
  generateSecondTab(fileId: string, agent: SecondTabAgent, model?: string | null, instruction?: string): Promise<void>
  redoTranscript(fileId: string, instruction: string): Promise<void>
  /** `analyze`: of a video entrada, what the AI analyzes (FR-046); an audio entrada always goes by its transcription, made first when missing. */
  generateFromNote(fileId: string, agent: NoteAgent, model?: string | null, place?: Target, instruction?: string, analyze?: MediaAnalysis): Promise<string | null>
  /** `file`: the media in hand (Novo conteúdo), heard straight even when the entrada does not keep it. `analyze`: as in `generateFromNote`. */
  generateAta(fileId: string, parts: AtaPart[], model?: AtaModelId, ai?: AtaModels, place?: Target, instruction?: string, file?: File, analyze?: MediaAnalysis): Promise<string | undefined>
  suggestTags(fileId: string): Promise<void>
  generateRemaining(folderId: string): Promise<void>
  regenerate(fileId: string): Promise<void>
  explainSelection(fileId: string, excerpt: string, prompt: string, mode: 'concept' | 'context', model?: string | null): Promise<string>
  explainGaps(target: { fileId: string | null; folderId: string | null }, notes: { title: string; excerpt: string }[]): Promise<string[]>
  createQuestions(fileId: string, wrong?: WrongQuestion[], model?: string | null): Promise<{ count: number; web: WebOutcome }>
  readingExam(content: string, title: string): Promise<StoredQuestion[]>
  cancel(jobId: string): void
  dismiss(jobId: string): void
  trackTask(title: string): TrackedTask
}

export interface TrackedTask {
  update(message: string, fraction: number | null): void
  done(message: string): void
  fail(error: string): void
}

const controllers = new Map<string, AbortController>()

const AGENT_PROMPTS: Record<Exclude<Agent, 'reading' | 'meeting'>, string> = {
  lesson: PROMPTS.LESSON_PROMPT,
  explanation: PROMPTS.EXPLANATION_PROMPT,
}

const GAP_INSTRUCTION = 'Explique o que faltou aprender em cada tema, usando as questões erradas como exemplo do equívoco, sem repetir a prova.'

const FILE_TYPE: Record<Agent, FileType> = { lesson: 'class', explanation: 'explanation', meeting: 'meeting', reading: 'reading' }

const AGENT_LABEL: Record<Agent, string> = { lesson: 'Aula', explanation: 'Explicação', meeting: 'Ata', reading: 'Leitura' }

const CONTENT_HEADER = '# Conteúdo\n\n'
const polishSessions = new WeakMap<object, GenerationSession>()

function library() {
  return useLibraryStore.getState()
}

const AGENT_USE: Record<Agent, AiUse> = { lesson: 'aula', explanation: 'explicacao', meeting: 'ata', reading: 'estudo' }

/** A session with the model of that use: the one picked at generation time, else the default of Padrões por uso. */
function sessionFor(use: AiUse | AiStep, signal?: AbortSignal, pick?: string | null): GenerationSession {
  return new GenerationSession(targetFor(library().index.settings, use, pick), signal)
}

/** The Questões da web model: its own default, else Estudo's when the app knows it searches the web; none → the Prova goes without. */
function webTarget(): AiSettings | null {
  const config = aiConfigOf(library().index.settings)
  const { live, probes } = useModelsStore.getState()
  return targetOf(config, uidFor(config, 'web', uid => searchesWeb(config, live, probes, uid)))
}

function generationMeta(session: GenerationSession, resolved: ResolvedInput | null, stages: StageTime[] = []): GenerationMeta {
  const usage = session.usage()
  return {
    ...(stages.length ? { stages } : {}),
    provider: usage.provider,
    model: usage.model,
    startedAt: usage.startedAt,
    durationMs: usage.durationMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedTokens: usage.estimated,
    transcriptionEngine: resolved?.transcription?.engine,
    language: resolved?.transcription?.language || undefined,
  }
}

function destinationName(folderId: string | null): string {
  const folder = library().folders.find(item => item.id === folderId)
  return folder ? `pasta "${folder.name}"` : 'Biblioteca (raiz)'
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** When the meeting started: from the recording's name ("Reunião 28-10-2026, 18-15-41"), else creation minus length. */
export function meetingStart(meta: FileMeta): Date {
  const found = /(\d{2})-(\d{2})-(\d{4}),?\s+(\d{2})-(\d{2})/.exec(meta.origin?.name ?? meta.name)
  if (found) return new Date(Number(found[3]), Number(found[2]) - 1, Number(found[1]), Number(found[4]), Number(found[5]))
  return new Date(new Date(meta.created.at).getTime() - (meta.origin?.durationSeconds ?? 0) * 1000)
}

/** The folder named after a note: the one it is in, one beside it with that name, or (id null) the one to make beside it. */
export function homeFolderOf(source: FileMeta, folders: FolderMeta[]): Pick<FolderMeta, 'name' | 'parentId'> & { id: string | null } {
  const live = liveFolders(folders)
  const own = live.find(folder => folder.id === source.folderId)
  if (own?.name === source.name) return own
  return live.find(folder => folder.parentId === source.folderId && folder.name === source.name) ?? { id: null, name: source.name, parentId: source.folderId }
}

/** The "Instrução extra para a IA" a note keeps for the next time; none when it was empty. */
const instructionOf = (instruction?: string): Pick<GenerationChoice, 'instruction'> => (instruction?.trim() ? { instruction: instruction.trim() } : {})

/** What a note made from another keeps of its generation: the model picked, else the default of that moment. */
function choiceOf(use: AiUse, model: string | null | undefined, rest: Omit<GenerationChoice, 'model' | 'at'> = {}): GenerationChoice {
  const uid = model || uidFor(aiConfigOf(library().index.settings), use)
  return { ...rest, ...(uid ? { model: uid } : {}), at: nowIso() }
}

/** What the Ata of a video kept of "Modelos por passo": the model each step used, the picked one or the default it had. The Escrita is the `model` of the note. */
function stepsOf(chosen: AtaModels | undefined): AtaStepModels {
  const config = aiConfigOf(library().index.settings)
  const own = config.models.some(model => model.uid === config.steps.contexto) ? config.steps.contexto : undefined
  const video = chosen?.video || uidFor(config, 'tela')
  const context = chosen?.context || own || chosen?.model || uidFor(config, 'ata')
  return { ...(video ? { video } : {}), ...(context ? { context } : {}) }
}

/** The use's model hears audio: the provider's list says so, or "Testar" saw it (unknown is not enough). */
/** The provider of the use's model when that model hears audio; null when it does not. */
async function hearsAudio(use: AiUse, pick?: string | null): Promise<string | null> {
  const config = aiConfigOf(library().index.settings)
  const model = modelByUid(config, (pick && modelByUid(config, pick) ? pick : undefined) ?? uidFor(config, use))
  const provider = providerById(config, model?.pid)
  if (!model || !provider) return null
  if (useModelsStore.getState().live[provider.id]?.state !== 'ok') await useModelsStore.getState().read(provider, false)
  const { live, probes } = useModelsStore.getState()
  return mediaOfModel(config, live, probes, model.uid)?.audio === true ? provider.type : null
}

const NOT_HEARD = 'O modelo escolhido não ouve a mídia: escolha um que ouça áudio, ou "Só a transcrição".'
const NO_MEDIA = 'A mídia desta entrada não está mais guardada: use "Só a transcrição".'
const MEDIA_WONT_GO = 'Não deu para mandar a mídia ao modelo (longa demais ou sem áudio): use "Só a transcrição".'
const NOTHING_TO_READ = 'Esta entrada não tem texto nem arquivo para a IA ler.'
const NO_TRANSCRIPT = 'Esta entrada não tem transcrição, e a mídia não pôde ser transcrita.'

/** The media for ONE call to the use's model, when it hears audio and the light audio fits; null keeps the transcription path. `required` (the person chose the media): it fails saying why instead. */
async function directMedia(use: AiUse, pick: string | null | undefined, open: () => Promise<File>, required = false): Promise<MediaParts | null> {
  const refuse = (reason: string) => {
    if (required) throw new Error(reason)
    return null
  }
  const provider = await hearsAudio(use, pick)
  if (!provider) return refuse(NOT_HEARD)
  const file = await open().catch(() => null)
  if (!file) return refuse(NO_MEDIA)
  return (await mediaParts(file, provider)) ?? refuse(MEDIA_WONT_GO)
}

/** What the AI analyzes of a media (FR-046): of a video, what the person chose (absent: the media when the model hears it, else the transcription); of an audio, always the transcription. */
const analysisOf = (media: NoteMedia, analyze?: MediaAnalysis): MediaAnalysis | undefined => (media === 'audio' ? 'transcricao' : media === 'video' ? analyze : undefined)

/** What a note keeps of that choice for "Gerar de novo": only a video has one. */
const analyzedOf = (media: NoteMedia, analyze?: MediaAnalysis): Pick<GenerationChoice, 'analyze'> => (media === 'video' && analyze ? { analyze } : {})

const mediaOfFile = (file: File): NoteMedia => (file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'text')

/** The media of an entrada for the call, by what the AI analyzes; a choice that cannot be met fails saying why. `inHand`: without a choice, the media is only tried when it is there. */
const entryMedia = (use: AiUse, pick: string | null | undefined, asked: MediaAnalysis | undefined, inHand: boolean, open: () => Promise<File>): Promise<MediaParts | null> =>
  asked === 'transcricao' || (!asked && !inHand) ? Promise.resolve(null) : directMedia(use, pick, open, Boolean(asked))

/** "Transcrição + vídeo": the one call with the media and the material already read; without the media chosen, nothing. */
const withMaterial = (both: MediaParts | null, material: string): MediaParts | undefined => (both ? withTranscript(both, material.replace(CONTENT_HEADER, '')) : undefined)

/** The note has its media at hand (kept here or stored). */
const keptMedia = (meta: FileMeta) => mediaOf(meta) !== 'text' && (library().localMedia.some(item => item.fileIds.includes(meta.id)) || Boolean(meta.origin?.storedFileId || meta.origin?.storedUrl))

async function mediaFileOf(meta: FileMeta): Promise<File> {
  const origin = meta.origin!
  const local = library().localMedia.find(item => item.fileIds.includes(meta.id))
  if (local) return readLocalMedia(local)
  if (!library().repo || !(origin.storedFileId || origin.storedUrl)) throw new Error('A mídia desta nota não está mais guardada: não dá para transcrever.')
  const stored = await downloadStoredSource(origin, library().repo!)
  const blob = typeof stored === 'string' ? await (await fetch(stored)).blob() : stored
  return new File([blob], origin.name, { type: origin.mime || blob.type })
}

/** What is read again of a source the entrada does not hold as text: a link, a topic, a document still stored. */
async function entryInput(meta: FileMeta): Promise<ContentInput | null> {
  const origin = meta.origin
  if (!origin || mediaOf(meta) !== 'text') return null
  if ((origin.input === 'url' || origin.input === 'youtube') && origin.url) return { kind: 'link', url: origin.url }
  if (origin.input === 'topic') return { kind: 'topic', topic: origin.name }
  if (origin.input !== 'file' || origin.removedAt || sourceExpired(origin) || !(origin.storedFileId || origin.storedUrl)) return null
  return { kind: 'file', file: await mediaFileOf(meta) }
}

export const useJobsStore = create<JobsState>((set, get) => {
  const patchJob = (id: string, patch: Partial<Job>) => set(state => ({ jobs: state.jobs.map(job => (job.id === id ? { ...job, ...patch } : job)) }))

  const openJob = (kind: Job['kind'], title: string, fileId: string | null): { job: Job; controller: AbortController } => {
    const job: Job = { id: newId(), kind, title, fileId, status: 'running', message: 'Começando', fraction: null, error: null, startedAt: Date.now() }
    const controller = new AbortController()
    controllers.set(job.id, controller)
    set(state => ({ jobs: [job, ...state.jobs] }))
    return { job, controller }
  }

  const closeJob = (id: string, status: JobStatus, message: string, error: string | null = null) => {
    controllers.delete(id)
    patchJob(id, { status, message, error, fraction: status === 'done' ? 1 : null })
  }

  /** A generation refused before it started: a failed job says why. */
  const refuseJob = (title: string, fileId: string, message: string, error: unknown) => closeJob(openJob('generation', title, fileId).job.id, 'error', message, failureText(error))

  /** The material of a source the entrada does not hold as text; null when it cannot be read, with a failed job saying why. */
  const readEntrySource = async (source: FileMeta, title: string): Promise<string | null> => {
    const { job, controller } = openJob('generation', title, source.id)
    try {
      const input = await entryInput(source)
      if (!input) throw new Error(mediaOf(source) === 'text' ? NOTHING_TO_READ : NO_TRANSCRIPT)
      const { content } = await resolveInput(input, library().index.settings, '', (message, fraction) => patchJob(job.id, { message, fraction: fraction ?? null }), controller.signal)
      closeJob(job.id, 'done', 'Material lido.')
      return content
    } catch (error) {
      const cancelled = controller.signal.aborted
      closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A geração não começou.', cancelled ? null : failureText(error))
      return null
    }
  }

  const liveEmit = (fileId: string) => (event: GenerationEvent) => {
    if (event.type === 'phase1_complete' || event.type === 'lesson_complete') set(state => ({ live: { ...state.live, [fileId]: event.markdown } }))
  }

  const dropLive = (fileId: string) =>
    set(state => {
      const live = { ...state.live }
      delete live[fileId]
      return { live }
    })

  const writeDocument = async (
    fileId: string,
    agent: Agent,
    content: string,
    session: GenerationSession,
    jobId: string,
    systemPrompt?: string,
    recording?: RecordingData,
    media?: MediaParts,
    instruction = '',
  ): Promise<{ markdown: string; name?: string }> => {
    if (media) {
      // straight from the audio: one call writes it, like the text path's first pass
      patchJob(jobId, { message: 'Escrevendo direto da mídia' })
      return { markdown: await generateContent(withInstruction(media, instruction), systemPrompt ?? (agent === 'meeting' ? PROMPTS.MEETING_PROMPT : AGENT_PROMPTS[agent as 'lesson' | 'explanation']), session, liveEmit(fileId)) }
    }
    if (agent === 'meeting' && !systemPrompt) {
      patchJob(jobId, { message: 'Escrevendo a ata (duas passadas)' })
      const { markdown, subject } = await buildMinutes(content, session, liveEmit(fileId), recording, instruction)
      return { markdown, name: minutesFileName(subject) }
    }
    patchJob(jobId, { message: agent === 'lesson' ? 'Escrevendo a aula' : 'Escrevendo a explicação' })
    const markdown = await generateContent(withInstruction(content, instruction), systemPrompt ?? AGENT_PROMPTS[agent as 'lesson' | 'explanation'], session, event => {
      liveEmit(fileId)(event)
      if (event.type === 'phase1_complete') patchJob(jobId, { message: 'Desenhando os diagramas' })
    })
    return { markdown }
  }

  const runOnFile = async (
    meta: FileMeta,
    agent: Agent,
    content: string,
    resolved: ResolvedInput | null,
    label: string,
    origin: string,
    systemPrompt?: string,
    heard?: RecordingData,
    pick?: string | null,
    keepName = false,
    media?: MediaParts,
    instruction = '',
  ): Promise<void> => {
    const { job, controller } = openJob('generation', meta.name, meta.id)
    const activityId = await library().startActivity({ kind: agent, label: `${label}: ${meta.name}`, origin, destination: destinationName(meta.folderId), fileId: meta.id })
    await library().updateFile(meta.id, { status: 'generating' })
    const session = sessionFor(AGENT_USE[agent], controller.signal, pick)
    try {
      const recording = heard ?? resolved?.transcription?.recording ?? (await library().openFile(meta.id).catch(() => null))?.sidecar.recording
      const clock = new StageClock()
      clock.add(resolved?.transcription?.stages)
      const { markdown, name } = await clock.run(media ? 'Escrever direto da mídia' : 'Escrever', () => writeDocument(meta.id, agent, content, session, job.id, systemPrompt, recording, media, instruction))
      patchJob(job.id, { message: 'Salvando' })
      await library().saveContent(meta.id, markdown, { status: 'ready', pendingExcerpt: null, generation: generationMeta(session, resolved, clock.stages), ...(name && !keepName ? { name } : {}) })
      closeJob(job.id, 'done', 'Pronta e salva na Biblioteca.')
      await library().finishActivity(activityId, 'done', 'Pronta e salva na Biblioteca.')
      void suggestTagsFor(meta.id)
    } catch (error) {
      const cancelled = error instanceof Cancelled || controller.signal.aborted
      await library().updateFile(meta.id, { status: 'pending', pendingExcerpt: meta.pendingExcerpt ?? content }).catch(() => undefined)
      closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A geração falhou.', cancelled ? null : failureText(error))
      await library().finishActivity(activityId, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : failureText(error))
    } finally {
      dropLive(meta.id)
    }
  }

  const suggestTagsFor = async (fileId: string): Promise<void> => {
    const meta = library().files.find(file => file.id === fileId)
    if (!meta) return
    const { content, sidecar } = await library().openFile(fileId)
    const text = content.trim() || (sidecar.recording ? transcriptText(sidecar.recording) : '')
    const known = [...new Set(library().files.flatMap(file => file.tags))]
    const suggested = (await suggestTags(text, known, sessionFor('titulo')).catch(() => [] as string[])).filter(tag => !meta.tags.includes(tag))
    if (suggested.length) await library().updateFile(fileId, { suggestedTags: suggested })
  }

  const folderFor = async (source: FileMeta, place: Placement): Promise<string | null> => {
    if (place !== 'home') return place.folderId
    const home = homeFolderOf(source, library().folders)
    const id = home.id ?? (await library().createFolder({ name: home.name, parentId: home.parentId })).id
    if (source.folderId !== id) await library().updateFile(source.id, { folderId: id })
    return id
  }

  /**
   * The level asked; absent (the windows before the level existed), a place chosen for the file means "Registro e arquivo".
   * An Ata always has an entrada (FR-055): "Sem rastro" counts as "Só o registro".
   */
  const keepOf = (request: NewContentRequest): KeepLevel => {
    const file = request.input.kind === 'file' || request.input.kind === 'recording'
    const level = request.keep ?? (file && request.storage !== 'none' ? 'arquivo' : defaultKeep(request.input.kind, request.agent))
    return request.agent === 'meeting' && level === 'sem-rastro' ? 'registro' : level
  }

  const isMedia = (origin: SourceMeta) => mediaOf({ origin }) !== 'text'

  /** What a request says of a video's analysis, when it is about a video. */
  const requestChoice = (request: NewContentRequest): Pick<GenerationChoice, 'analyze'> => (request.input.kind === 'file' || request.input.kind === 'recording' ? analyzedOf(mediaOfFile(request.input.file), request.analyze) : {})

  /** Kept for "Tentar de novo" and "Gerar de novo": the instruction and what the AI analyzed, when there is one. */
  const madeOf = (request: NewContentRequest, agent: Agent): { made?: GenerationChoice } => {
    const kept = { ...instructionOf(request.prompt), ...requestChoice(request) }
    return agent !== 'reading' && Object.keys(kept).length ? { made: choiceOf(AGENT_USE[agent], request.models?.write, kept) } : {}
  }

  /** What a note made from an entrada says of where it came from: the source of a link or document; for media, the entrada (the media lives there). */
  const noteOrigin = (origin: SourceMeta, entry: FileMeta): SourceMeta => (isMedia(origin) ? { input: 'text', name: entry.name, storage: 'none' } : { ...origin })

  /**
   * The item that keeps the media and its transcription: the entrada; with "Sem rastro", a note without origin.
   * With "Sem rastro" and a writing agent, it is also the note that gets the text (as before entradas).
   */
  const createHolder = async (request: NewContentRequest, resolved: ResolvedInput, agent: Agent, name?: string): Promise<FileMeta> => {
    const traceless = keepOf(request) === 'sem-rastro'
    const meta = await library().createFile(
      {
        name: name || request.name.trim() || resolved.title || AGENT_LABEL[agent],
        type: FILE_TYPE[agent],
        description: request.description.trim() || resolved.description,
        folderId: request.folderId,
        status: agent === 'reading' ? 'ready' : 'generating',
        pendingExcerpt: agent === 'reading' ? null : resolved.content,
        origin: traceless ? null : resolved.origin,
        ...(traceless ? {} : { role: 'entrada' as const, kept: 'registro' as const }),
        // kept for "Tentar de novo"
        ...(traceless ? madeOf(request, agent) : {}),
      },
      agent === 'reading' ? resolved.content.replace(/^# Conteúdo\n\n/, '') : '',
    )
    if (resolved.transcription) {
      const { text: transcript, recording } = resolved.transcription
      await library()
        .updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript, ...(recording ? { recording } : {}) }))
        .catch(() => undefined)
    }
    if (request.input.kind === 'file' && resolved.transcription) await keepMedia(request, request.input.file, meta, resolved.transcription.durationSeconds)
    return meta
  }

  /** "Registro e arquivo" keeps the media in Mídias, linked to the entrada. */
  const keepMedia = async (request: NewContentRequest, file: File, entry: FileMeta, durationSeconds: number): Promise<void> => {
    if (keepOf(request) !== 'arquivo' || entry.role !== 'entrada') return
    const kept = await keepLocalMedia(file, entry.id, durationSeconds).then(
      () => true,
      () => false,
    )
    if (kept) await library().updateFile(entry.id, { kept: 'arquivo' })
  }

  /** The entrada of a link, text, topic or document: the one of the same source already in the library, or a new one; none with "Sem rastro". */
  const entryFor = async (request: NewContentRequest, resolved: ResolvedInput): Promise<FileMeta | null> => {
    if (keepOf(request) === 'sem-rastro') return null
    const key = sourceKey(resolved.origin)
    const found = library().files.find(file => file.role === 'entrada' && !file.deletedAt && file.origin && sourceKey(file.origin) === key)
    if (found) return found
    const pasted = request.input.kind === 'text' ? request.input.text.trim() : ''
    return library().createFile(
      { name: pasted ? resolved.title : resolved.origin.name, role: 'entrada', kept: 'registro', type: 'reading', description: resolved.description, folderId: request.folderId, status: 'ready', origin: resolved.origin },
      pasted,
    )
  }

  /** The entrada of the request: for media, a new one that keeps the transcription; else `entryFor`. */
  const sourceEntry = (request: NewContentRequest, resolved: ResolvedInput): Promise<FileMeta | null> =>
    keepOf(request) !== 'sem-rastro' && isMedia(resolved.origin) ? createHolder(request, resolved, 'reading', resolved.title) : entryFor(request, resolved)

  /** The note made of the source: the entrada's child, or (with "Sem rastro") a note without mother and origin. */
  const createChild = (request: NewContentRequest, resolved: ResolvedInput, agent: Agent, entry: FileMeta | null): Promise<FileMeta> =>
    library().createFile(
      {
        name: request.name.trim() || resolved.title || AGENT_LABEL[agent],
        type: FILE_TYPE[agent],
        description: request.description.trim() || resolved.description,
        folderId: request.folderId,
        parentFileId: entry?.id ?? null,
        status: agent === 'reading' ? 'ready' : 'generating',
        pendingExcerpt: agent === 'reading' ? null : resolved.content,
        origin: entry ? noteOrigin(resolved.origin, entry) : null,
        // kept for "Tentar de novo"
        ...madeOf(request, agent),
      },
      agent === 'reading' ? resolved.content.replace(/^# Conteúdo\n\n/, '') : '',
    )

  /** The note of a request whose material is already read: under its entrada, which keeps the file when asked. Transcribed media with "Só a transcrição" is the entrada alone. */
  const createForRequest = async (request: NewContentRequest, resolved: ResolvedInput, agent: Agent): Promise<FileMeta> => {
    if (keepOf(request) === 'sem-rastro') return createHolder(request, resolved, agent)
    if (agent === 'reading' && isMedia(resolved.origin)) {
      const entry = await createHolder(request, resolved, agent)
      await keepSource(request, resolved, entry, null)
      return entry
    }
    const entry = await sourceEntry(request, resolved)
    const note = await createChild(request, resolved, agent, entry)
    await keepSource(request, resolved, entry, note)
    return note
  }

  /** "Registro e arquivo": the file is stored with the entrada, where the person chose (an entrada that already keeps it is left as is). */
  const keepSource = async (request: NewContentRequest, resolved: ResolvedInput, entry: FileMeta | null, note: FileMeta | null): Promise<void> => {
    if (!entry || keepOf(request) !== 'arquivo' || request.storage === 'none' || (request.input.kind !== 'file' && request.input.kind !== 'recording')) return
    if (entry.origin?.storedFileId || entry.origin?.storedUrl) return
    try {
      const keeping = new StageClock()
      const file = request.input.file
      const stored = await keeping.run('Guardar a mídia', () => storeSource(file, request.storage, entry.id, library().repo!, request.litterboxTime))
      resolved.transcription?.stages?.push(...keeping.stages)
      await library().updateFile(entry.id, { origin: { ...resolved.origin, ...stored } as SourceMeta, kept: 'arquivo' })
    } catch (error) {
      if (note) await library().updateFile(note.id, { status: 'pending' })
      throw new Error(`A aula não foi gerada porque a fonte não pôde ser guardada: ${failureText(error)}`)
    }
  }

  const finishEarlyNote = async (request: NewContentRequest, read: ResolvedInput, meta: FileMeta, agent: Agent, job: Job, signal: AbortSignal, both: MediaParts | null): Promise<void> => {
    const progress = (message: string, fraction?: number) => patchJob(job.id, { message, fraction: fraction ?? null })
    // the entrada keeps the transcription; with "Sem rastro", the note itself does
    const entry = meta.role === 'entrada' ? meta : null
    try {
      await keepSource(request, read, entry, null)
      const resolved = await polished(read, request.marks ?? [], progress, signal, request.input.kind === 'recording' || request.input.kind === 'file' ? request.input.file : null)
      const { text: transcript, recording } = resolved.transcription!
      await library().updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript, ...(recording ? { recording } : {}) }))
      const name = request.name.trim() || resolved.title || meta.name
      const description = request.description.trim() || resolved.description
      const ataParts = agent === 'meeting' ? chosenParts(request.ataParts ?? []) : []
      const ataModel = agent === 'meeting' ? request.ataModel : undefined
      const makesAta = Boolean(ataModel) || ataParts.length > 0
      if (agent === 'reading' || makesAta || entry) {
        const polishing = polishSessions.get(resolved.transcription!)
        await library().saveContent(meta.id, resolved.content.replace(/^# Conteúdo\n\n/, ''), { name, description, pendingExcerpt: null, ...(makesAta || entry ? { type: 'reading' as const, status: 'ready' as const } : {}), ...(polishing ? { generation: generationMeta(polishing, resolved, resolved.transcription?.stages) } : {}) })
        closeJob(job.id, 'done', 'Material lido.')
        if (entry && !makesAta && agent !== 'reading') {
          // the text written of the transcription is a note of its own, under the entrada
          const note = await createChild(request, { ...resolved, title: name, description }, agent, { ...entry, name })
          await runOnFile(note, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name, undefined, undefined, request.models?.write, false, withMaterial(both, resolved.content), request.prompt)
          return
        }
        const picked = request.models?.write
        const ai: AtaModels | undefined = picked || request.models?.steps ? { model: picked, ...request.models?.steps } : undefined
        const { analyze } = requestChoice(request)
        // the choice goes with the media in hand: an Ata may not keep it
        if (analyze && makesAta) await get().generateAta(meta.id, ataModel ? [] : ataParts, ataModel, ai, 'home', request.prompt, request.input.kind === 'file' || request.input.kind === 'recording' ? request.input.file : undefined, analyze)
        else if (request.prompt.trim()) await get().generateAta(meta.id, ataModel ? [] : ataParts, ataModel, ai, 'home', request.prompt)
        else if (ataModel) await (ai ? get().generateAta(meta.id, [], ataModel, ai) : get().generateAta(meta.id, [], ataModel))
        else if (ataParts.length) await (ai ? get().generateAta(meta.id, ataParts, undefined, ai) : get().generateAta(meta.id, ataParts))
        return
      }
      await library().updateFile(meta.id, { name, description, pendingExcerpt: resolved.content })
      closeJob(job.id, 'done', 'Material lido.')
      const fresh = library().files.find(file => file.id === meta.id) ?? { ...meta, name, description }
      await runOnFile(fresh, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name, undefined, undefined, request.models?.write, false, withMaterial(both, resolved.content), request.prompt)
    } catch (error) {
      const cancelled = signal.aborted
      await library().updateFile(meta.id, { status: 'pending' }).catch(() => undefined)
      closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A nota não terminou.', cancelled ? null : failureText(error))
    }
  }

  const resolveRecording = async (file: File, progress: (message: string, fraction?: number) => void, signal: AbortSignal, transcriptionModel?: string | null): Promise<ResolvedInput> => {
    progress('Transcrevendo a gravação')
    const transcription = await transcribe(file, transcriptionOf(library().index.settings, transcriptionModel), progress, signal, { microphoneOnLeft: true, recorder: recorderName(useAccountStore.getState().active()) })
    return {
      content: `${CONTENT_HEADER}${transcription.text}`,
      title: file.name,
      description: file.name,
      origin: { input: 'recording', name: file.name, sizeBytes: file.size, mime: file.type || 'application/octet-stream', durationSeconds: transcription.durationSeconds, storage: 'none' },
      transcription,
    }
  }

  const polished = async (resolved: ResolvedInput, marks: RecordingMark[], progress: (message: string) => void, signal: AbortSignal, source: File | null): Promise<ResolvedInput> => {
    const heard = resolved.transcription?.recording
    if (!resolved.transcription || !heard) return resolved
    const session = sessionFor('titulo', signal)
    const clock = new StageClock()
    clock.add(resolved.transcription.stages)
    const video = source?.type.startsWith('video/') ? source : null
    if (video) progress('Olhando a tela gravada')
    const look = () => lookAtScreen(heard, video, visionSettingsOf(library().index.settings), session)
    const seen = await (video ? clock.run('Olhar a tela gravada', look) : look())
    progress('Dando título, nomes e revisando a transcrição')
    const finished = await clock.run('Acabamento: título, nomes e revisão', () => polishTranscript(seen, session, library().index.settings.transcription.terms ?? ''))
    const recording = { ...finished.recording, marks }
    const text = transcriptText(recording).trim()
    const transcription = { ...resolved.transcription, text, recording, stages: clock.stages }
    polishSessions.set(transcription, session)
    const title = finished.title
    return { ...resolved, ...(title ? { title } : {}), content: `${CONTENT_HEADER}${text}`, transcription }
  }

  /** Novo conteúdo straight from the media: the note now, the writing in one call; the recording of an Ata is transcribed beside it. */
  const startFromMedia = async (request: NewContentRequest, agent: Agent, file: File, media: MediaParts, makesAta: boolean, job: Job): Promise<string> => {
    const durationSeconds = await mediaDuration(file).catch(() => undefined)
    const origin: SourceMeta = { input: request.input.kind === 'recording' ? 'recording' : 'file', name: file.name, sizeBytes: file.size, mime: file.type || 'application/octet-stream', ...(durationSeconds ? { durationSeconds } : {}), storage: 'none' }
    const resolved: ResolvedInput = { content: '', title: file.name, description: file.name, origin, transcription: null }
    const traceless = keepOf(request) === 'sem-rastro'
    // the entrada keeps the media; the text written from it is its child (with "Sem rastro", only that note)
    const holder = await createHolder(request, resolved, makesAta || !traceless ? 'reading' : agent, makesAta || traceless ? undefined : file.name)
    await keepMedia(request, file, holder, durationSeconds ?? 0)
    const note = !makesAta && !traceless ? await createChild(request, resolved, agent, holder) : null
    patchJob(job.id, { fileId: (note ?? holder).id })
    await keepSource(request, resolved, traceless ? null : holder, note)
    closeJob(job.id, 'done', 'Material lido.')
    if (!makesAta) {
      void runOnFile(note ?? holder, agent, '', resolved, AGENT_LABEL[agent], file.name, undefined, undefined, request.models?.write, false, media, request.prompt)
      return (note ?? holder).id
    }
    const picked = request.models?.write
    const ai: AtaModels | undefined = picked || request.models?.steps ? { model: picked, ...request.models?.steps } : undefined
    void get().transcribeNote(holder.id, file, request.models?.transcription)
    // the media in hand: the Ata hears it now, kept or not ("Só o registro")
    void get().generateAta(holder.id, request.ataModel ? [] : chosenParts(request.ataParts ?? []), request.ataModel, ai, 'home', request.prompt, file, requestChoice(request).analyze)
    return holder.id
  }

  return {
    jobs: [],
    live: {},
    proposals: [],

    startNewContent: async (request, onJob) => {
      const agent: Agent = request.input.kind === 'topic' && request.agent === 'lesson' ? 'explanation' : request.agent
      const { job, controller } = openJob('generation', request.name || AGENT_LABEL[agent], null)
      onJob?.(job.id)
      let resolved: ResolvedInput
      // "Transcrição + vídeo": the media waits for the transcription, to go with it in the same call
      let both: MediaParts | null = null
      try {
        const progress = (message: string, fraction?: number) => patchJob(job.id, { message, fraction: fraction ?? null })
        const heardBy = request.models?.transcription
        const file = request.input.kind === 'recording' || request.input.kind === 'file' ? request.input.file : null
        if (file && agent !== 'reading' && /^(audio|video)\//.test(file.type)) {
          const makesAta = agent === 'meeting' && (Boolean(request.ataModel) || chosenParts(request.ataParts ?? []).length > 0)
          const asked = analysisOf(mediaOfFile(file), request.analyze)
          const media = asked === 'transcricao' ? null : await directMedia(makesAta ? 'ata' : AGENT_USE[agent], request.models?.write, async () => file, Boolean(asked))
          if (asked === 'ambos') both = media
          else if (media) return await startFromMedia(request, agent, file, media, makesAta, job)
        }
        // the instruction goes as its own block when writing, not inside the material
        const read = request.input.kind === 'recording' ? await resolveRecording(request.input.file, progress, controller.signal, heardBy) : await resolveInput(request.input, library().index.settings, '', progress, controller.signal, heardBy)
        if (read.transcription?.recording && agent !== 'lesson') {
          patchJob(job.id, { title: request.name || read.title })
          const meta = await createHolder(request, read, agent)
          patchJob(job.id, { fileId: meta.id })
          void finishEarlyNote(request, read, meta, agent, job, controller.signal, both)
          return meta.id
        }
        resolved = await polished(read, request.marks ?? [], progress, controller.signal, request.input.kind === 'recording' || request.input.kind === 'file' ? request.input.file : null)
      } catch (error) {
        const cancelled = controller.signal.aborted
        closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'Não deu pra ler o material.', cancelled ? null : failureText(error))
        return null
      }
      patchJob(job.id, { title: request.name || resolved.title })

      // with the media in the call it is one note: the lessons of a course are written from text
      if (agent === 'lesson' && !both) {
        patchJob(job.id, { message: 'Vendo se cabe numa aula ou se rende várias, em módulos' })
        try {
          const analysis = await analyzeCourse(resolved.content, sessionFor('curso', controller.signal))
          if (analysis.isCourse) {
            closeJob(job.id, 'done', 'Virou proposta de pasta com aulas.')
            set(state => ({ proposals: [...state.proposals, { analysis, request, resolved }] }))
            return null
          }
        } catch (error) {
          if (controller.signal.aborted) {
            closeJob(job.id, 'cancelled', 'Cancelado por você.')
            return null
          }
        }
      }

      let meta: FileMeta
      try {
        meta = await createForRequest(request, resolved, agent)
      } catch (error) {
        closeJob(job.id, 'error', 'A geração não começou.', failureText(error))
        return null
      }
      closeJob(job.id, 'done', 'Material lido.')
      if (agent === 'reading') {
        const polishing = resolved.transcription && polishSessions.get(resolved.transcription)
        if (polishing) await library().updateFile(meta.id, { generation: generationMeta(polishing, resolved, resolved.transcription?.stages) })
        return meta.id
      }
      void runOnFile(meta, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name, undefined, undefined, request.models?.write, false, withMaterial(both, resolved.content), request.prompt)
      return meta.id
    },

    saveRecording: async request => {
      const { file } = request
      const origin: SourceMeta = { input: 'recording', name: file.name, sizeBytes: file.size, mime: file.type || 'application/octet-stream', durationSeconds: request.durationSeconds, storage: 'none' }
      // the recording is an entrada: the transcription and what is generated from it live under it
      const meta = await library().createFile({ name: recordingName(file.name), role: 'entrada', kept: 'registro', type: 'reading', description: '', folderId: request.folderId, status: 'ready', pendingExcerpt: null, origin }, '')
      if (request.marks.length) await library().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: { blocks: [], speakers: [], marks: request.marks } }))
      if (request.storedName)
        await linkLocalMedia(request.storedName, meta.id).then(
          () => library().updateFile(meta.id, { kept: 'arquivo' }),
          () => undefined,
        )
      if (request.storage !== 'none') {
        void storeSource(file, request.storage, meta.id, library().repo!, request.litterboxTime)
          .then(stored => library().updateFile(meta.id, { origin: { ...origin, ...stored } as SourceMeta, kept: 'arquivo' }))
          .catch(error => get().trackTask(`Guardar a mídia: ${meta.name}`).fail(failureText(error)))
      }
      if (request.transcribe) void get().transcribeNote(meta.id, file, request.transcriptionModel)
      return meta.id
    },

    transcribeNote: async (fileId, source, transcriptionModel) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta?.origin || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      const origin = meta.origin
      const { job, controller } = openJob('transcription', meta.name, fileId)
      const progress = (message: string, fraction?: number) => patchJob(job.id, { message, fraction: fraction ?? null })
      try {
        progress('Abrindo a mídia')
        const file = source ?? (await mediaFileOf(meta))
        progress('Transcrevendo a gravação')
        const transcription = await transcribe(file, transcriptionOf(library().index.settings, transcriptionModel), progress, controller.signal, { microphoneOnLeft: origin.input === 'recording', recorder: recorderName(useAccountStore.getState().active()) })
        const read: ResolvedInput = { content: `${CONTENT_HEADER}${transcription.text}`, title: meta.name, description: meta.description, origin, transcription }
        const marks = (await library().openFile(fileId)).sidecar.recording?.marks ?? []
        const resolved = await polished(read, marks, progress, controller.signal, file)
        const done = resolved.transcription!
        await library().updateSidecar(fileId, sidecar => ({ ...sidecar, transcript: done.text, ...(done.recording ? { recording: done.recording } : {}) }))
        const fresh = library().files.find(file => file.id === fileId) ?? meta
        const polishing = polishSessions.get(done)
        await library().saveContent(fileId, done.text, {
          ...(fresh.name === recordingName(origin.name) && resolved.title !== meta.name ? { name: resolved.title } : {}),
          ...(polishing ? { generation: generationMeta(polishing, resolved, done.stages) } : {}),
        })
        closeJob(job.id, 'done', 'Transcrição pronta.')
      } catch (error) {
        const cancelled = error instanceof Cancelled || controller.signal.aborted
        closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A transcrição não saiu.', cancelled ? null : failureText(error))
      }
    },

    acceptCourse: async (proposal, folderId) => {
      set(state => ({ proposals: state.proposals.filter(item => item !== proposal) }))
      const { analysis, resolved } = proposal
      const entry = await sourceEntry(proposal.request, resolved)
      await keepSource(proposal.request, resolved, entry, null).catch(() => undefined)
      const root = await library().createFolder({
        name: analysis.name || 'Aulas',
        parentId: folderId,
        isCourse: true,
        courseOrigin: resolved.origin.url ?? resolved.origin.name,
        courseDescription: analysis.description,
        courseMaterial: resolved.content,
      })
      const firstModule: FileMeta[] = []
      for (const [index, module] of analysis.modules.entries()) {
        const parent = module.lessons.length ? await library().createFolder({ name: module.title, parentId: root.id, position: index }) : root
        const plans = module.lessons.length ? module.lessons : [module]
        const created: FileMeta[] = []
        for (const [position, plan] of plans.entries()) {
          created.push(
            await library().createFile(
              { name: plan.title, type: 'class', folderId: parent.id, description: plan.covers, pendingExcerpt: plan.excerpt || null, status: 'pending', position: module.lessons.length ? position : index, parentFileId: entry?.id ?? null, origin: entry ? noteOrigin(resolved.origin, entry) : null, ...(proposal.request.prompt.trim() ? { made: choiceOf('aula', proposal.request.models?.write, instructionOf(proposal.request.prompt)) } : {}) },
              '',
            ),
          )
        }
        if (index === 0) firstModule.push(...created)
      }
      for (const file of firstModule) void get().generatePending(file.id, proposal.request.models?.write)
      return root.id
    },

    declineCourse: async proposal => {
      set(state => ({ proposals: state.proposals.filter(item => item !== proposal) }))
      const meta = await createForRequest(proposal.request, proposal.resolved, 'lesson')
      void runOnFile(meta, 'lesson', proposal.resolved.content, proposal.resolved, 'Aula', proposal.resolved.origin.url ?? proposal.resolved.origin.name, undefined, undefined, proposal.request.models?.write, false, undefined, proposal.request.prompt)
      return meta.id
    },

    generatePending: async (fileId, model) => {
      const { files, folders } = library()
      const meta = files.find(file => file.id === fileId)
      if (!meta || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      if (courseOf(folders, meta.folderId)) {
        await runOnFile(meta, 'lesson', courseLessonInput(meta, folders, files), null, 'Aula', meta.description || meta.name, undefined, undefined, model, false, undefined, meta.made?.instruction)
        return
      }
      const agent: Agent = meta.type === 'explanation' ? 'explanation' : meta.type === 'meeting' ? 'meeting' : 'lesson'
      await runOnFile(meta, agent, meta.pendingExcerpt ?? `# ${meta.name}`, null, 'Nova tentativa', meta.origin?.url ?? meta.origin?.name ?? meta.name, undefined, undefined, undefined, false, undefined, meta.made?.instruction)
    },

    generateSecondTab: async (fileId, agent, model, instruction) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      const recording = (await library().openFile(fileId)).sidecar.recording
      if (!recording) return
      await library().updateFile(fileId, { type: FILE_TYPE[agent] })
      await runOnFile({ ...meta, type: FILE_TYPE[agent] }, agent, `${CONTENT_HEADER}${transcriptText(recording)}`, null, AGENT_LABEL[agent], meta.origin?.name ?? meta.name, undefined, undefined, model, false, undefined, instruction)
    },

    generateFromNote: async (fileId, agent, model, place = 'home', instruction, analyze) => {
      const source = library().files.find(file => file.id === fileId)
      if (!source) return null
      const asked = analysisOf(mediaOf(source), analyze)
      let media: MediaParts | null
      try {
        media = await entryMedia(AGENT_USE[agent], model, asked, keptMedia(source), () => mediaFileOf(source))
      } catch (error) {
        refuseJob(`${AGENT_LABEL[agent]}: ${source.name}`, fileId, 'A geração não começou.', error)
        return null
      }
      const needsText = !media || asked === 'ambos'
      // the transcription is needed and missing: made first, and it stays in the entrada
      const before = (await library().openFile(fileId)).sidecar
      if (needsText && keptMedia(source) && !before.recording?.blocks.length && !before.transcript?.trim()) await get().transcribeNote(fileId)
      const { content, sidecar } = await library().openFile(fileId)
      const recording = sidecar.recording?.blocks.length ? sidecar.recording : undefined
      const held = recording ? transcriptText(recording) : content || (sidecar.transcript ?? '')
      const material = needsText && !held.trim() ? await readEntrySource(source, `${AGENT_LABEL[agent]}: ${source.name}`) : `${CONTENT_HEADER}${held}`
      if (material === null) return null
      const parts = asked === 'ambos' ? withMaterial(media, material) : (media ?? undefined)
      const made = choiceOf(AGENT_USE[agent], model, { ...instructionOf(instruction), ...analyzedOf(mediaOf(source), asked) })
      if (typeof place === 'object' && 'replace' in place) {
        const meta = library().files.find(file => file.id === place.replace)
        if (!meta || get().jobs.some(job => job.fileId === meta.id && job.status === 'running')) return null
        await library().updateFile(meta.id, { made })
        void runOnFile(meta, agent, material, null, AGENT_LABEL[agent], source.name, undefined, recording, model, true, parts, instruction)
        return meta.id
      }
      const meta = await library().createFile(
        { name: `${AGENT_LABEL[agent]}: ${source.name}`, type: FILE_TYPE[agent], description: `gerado de ${source.name}`, folderId: await folderFor(source, place), parentFileId: source.id, status: 'generating', pendingExcerpt: material, origin: { input: 'text', name: source.name, storage: 'none' }, made },
        '',
      )
      void runOnFile(meta, agent, material, null, AGENT_LABEL[agent], source.name, undefined, recording, model, false, parts, instruction)
      return meta.id
    },

    generateAta: async (fileId, parts, model, chosen, place = 'home', instruction, file, analyze) => {
      const source = library().files.find(file => file.id === fileId)
      const replaced = typeof place === 'object' && 'replace' in place ? library().files.find(file => file.id === place.replace) : undefined
      // The job shows in the note being replaced, else in the recording until the new note exists.
      const at = replaced?.id ?? fileId
      // a transcription running beside it no longer holds the Ata
      if (!source || !(model || chosenParts(parts).length) || get().jobs.some(job => job.fileId === at && job.status === 'running' && job.kind !== 'transcription')) return
      const asked = analysisOf(mediaOf(source), analyze)
      let media: MediaParts | null
      try {
        media = await entryMedia('ata', chosen?.model, asked, Boolean(file) || keptMedia(source), async () => file ?? mediaFileOf(source))
      } catch (error) {
        refuseJob(`Ata: ${source.name}`, at, 'A ata não saiu.', error)
        return
      }
      const needsText = !media || asked === 'ambos'
      // the transcription is needed and missing: made first, and it stays in the entrada
      if (needsText && keptMedia(source) && !(await library().openFile(fileId)).sidecar.recording?.blocks.length) await get().transcribeNote(fileId)
      const heard = (await library().openFile(fileId)).sidecar.recording
      if (needsText && !heard?.blocks.length) return
      const { job, controller } = openJob('generation', `Ata: ${source.name}`, at)
      const activityId = await library().startActivity({ kind: 'meeting', label: `Ata: ${source.name}`, origin: source.origin?.name ?? source.name, destination: replaced ? `nota "${replaced.name}"` : 'nota nova', fileId: at })
      const progress = (message: string) => patchJob(job.id, { message })
      const settings = library().index.settings
      const ai = appAi(settings, controller.signal, undefined, chosen)
      let frames: FrameSource | null = null
      try {
        if (media) {
          const session = sessionFor('ata', controller.signal, chosen?.model)
          const clock = new StageClock()
          progress('Escrevendo a ata direto da mídia')
          // the date and length the audio does not say (a model left alone invents them)
          const when = meetingStart(source).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          const facts = { type: 'text', text: `Dados da reunião: ${when}${source.origin?.durationSeconds ? `, ${Math.round(source.origin.durationSeconds / 60)} min` : ''}.` }
          const sent = asked === 'ambos' ? withTranscript(media, transcriptText(heard!)) : media
          const raw = await clock.run('Ata direto da mídia', () => session.chat([...sent, facts], ataPrompt(model, parts, instruction)))
          if (!raw.trim()) throw new Error('A IA respondeu vazio.')
          return await saveAta({ markdown: ataDocument(raw, model), images: [], models: { write: modelOf(session.settings) }, stages: clock.stages })
        }
        // A video opens even without a vision model: the local OCR still reads the exact terms on screen
        if (mediaOf(source) === 'video') {
          progress('Abrindo o vídeo da gravação')
          const video = file ?? (await mediaFileOf(source).catch(() => null))
          frames = video ? await openVideoFrames(video).catch(() => null) : null
        }
        const done = await buildAta({ recording: heard!, parts, model, startedAt: meetingStart(source), instruction, onProgress: progress }, { ai, frames, difference: signatureDifference, renderPrint: (image, marks, caption) => renderPrint(image, marks, caption) })
        if (done.recording !== heard) {
          await library().updateSidecar(fileId, sidecar => (sidecar.recording ? { ...sidecar, recording: { ...sidecar.recording, speakers: done.recording.speakers }, transcript: transcriptText({ ...sidecar.recording, speakers: done.recording.speakers }) } : sidecar))
          if (source.type === 'reading') await library().saveContent(fileId, transcriptText(done.recording).trim())
        }
        return await saveAta(done)
      } catch (error) {
        const cancelled = error instanceof Cancelled || controller.signal.aborted
        closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A ata não saiu.', cancelled ? null : failureText(error))
        await library().finishActivity(activityId, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : failureText(error))
      } finally {
        frames?.close?.()
      }

      async function saveAta(done: Pick<MeetingDocument, 'markdown' | 'images' | 'models' | 'costUsd' | 'stages'>): Promise<string> {
        progress('Salvando')
        const document: MeetingDocument = { id: newId(), kind: 'ata', parts: model ? [] : chosenParts(parts), ...(model ? { ataModel: { id: model, name: ATA_MODELS[model].name } } : {}), markdown: done.markdown, images: done.images, createdAt: new Date().toISOString(), models: done.models, ...(done.costUsd !== undefined ? { costUsd: done.costUsd } : {}), stages: done.stages }
        const made = choiceOf('ata', chosen?.model, { ...(!media && mediaOf(source!) === 'video' ? { steps: stepsOf(chosen) } : {}), ...(model ? { ataModel: model } : { parts: chosenParts(parts) }), ...instructionOf(instruction), ...analyzedOf(mediaOf(source!), asked) })
        const fresh = library().files.find(file => file.id === fileId) ?? source!
        const note =
          replaced ??
          (await library().createFile(
            { name: `Ata: ${fresh.name}`, type: 'meeting', description: `gerado de ${fresh.name}`, folderId: await folderFor(fresh, place as Placement), parentFileId: fileId, status: 'ready', origin: { input: 'text', name: fresh.name, storage: 'none' } },
            '',
          ))
        // The note is the Ata; its document keeps the prints and how it was made.
        await library().updateSidecar(note.id, sidecar => ({ ...sidecar, documents: [document] }))
        await library().saveContent(note.id, done.markdown, { made })
        patchJob(job.id, { fileId: note.id })
        closeJob(job.id, 'done', 'Pronta e salva na Biblioteca.')
        await library().finishActivity(activityId, 'done', 'Ata pronta.')
        return note.id
      }
    },

    suggestTags: fileId => suggestTagsFor(fileId),

    redoTranscript: async (fileId, instruction) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      const recording = (await library().openFile(fileId)).sidecar.recording
      if (!recording) return
      const { job, controller } = openJob('transcription', `Refazer a transcrição: ${meta.name}`, fileId)
      try {
        patchJob(job.id, { message: 'Refazendo a transcrição' })
        const session = sessionFor('estudo', controller.signal)
        const redone = await redoTranscript(recording, instruction, session, library().index.settings.transcription.terms ?? '')
        await library().updateSidecar(fileId, sidecar => ({ ...sidecar, recording: redone }))
        if (meta.type === 'reading') await library().saveContent(fileId, transcriptText(redone).trim())
        closeJob(job.id, 'done', 'Transcrição refeita.')
      } catch (error) {
        const cancelled = error instanceof Cancelled || controller.signal.aborted
        closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A transcrição não foi refeita.', cancelled ? null : failureText(error))
      }
    },

    generateRemaining: async folderId => {
      const { folders, files } = library()
      const ids = new Set<string>([folderId])
      let grew = true
      while (grew) {
        grew = false
        for (const folder of folders) if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) (ids.add(folder.id), (grew = true))
      }
      await Promise.all(files.filter(file => file.folderId && ids.has(file.folderId) && file.status === 'pending' && !file.deletedAt).map(file => get().generatePending(file.id)))
    },

    regenerate: async fileId => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta) return
      if (meta.pendingExcerpt || (meta.status === 'pending' && !meta.origin)) return get().generatePending(fileId)
      const { content } = await library().openFile(fileId)
      const prompt = meta.type === 'explanation' ? PROMPTS.EXPLANATION_PROMPT : meta.type === 'meeting' ? PROMPTS.MEETING_PROMPT : PROMPTS.LESSON_PROMPT
      await runOnFile(meta, meta.type === 'explanation' ? 'explanation' : 'lesson', `# ${meta.name}\n\n${content}`, null, 'Nova versão', meta.name, prompt)
    },

    explainSelection: async (fileId, excerpt, prompt, mode, model) => {
      const source = library().files.find(file => file.id === fileId)
      if (!source) throw new Error('Arquivo de origem não encontrado.')
      const { content } = await library().openFile(fileId)
      let folderId: string | null = null
      if (mode === 'context') {
        folderId = source.folderId
        if (!folderId) {
          const home = await library().createFolder({ name: source.name })
          await library().updateFile(source.id, { folderId: home.id })
          folderId = home.id
        }
      }
      const meta = await library().createFile(
        { name: selectionTitle(excerpt), type: 'explanation', description: source.name, folderId, parentFileId: source.id, sourceExcerpt: excerpt, status: 'generating', origin: { input: 'text', name: `trecho de "${source.name}"`, storage: 'none' } },
        '',
      )
      const input = selectionInput(source, content, library().files, excerpt, prompt, mode)
      void (async () => {
        await runOnFile(meta, 'explanation', input, null, 'Explicação', `trecho de "${source.name}"`, undefined, undefined, model)
        const saved = useLibraryStore.getState().opened[meta.id]?.content
        if (saved) await library().updateFile(meta.id, { name: explanationName(saved, excerpt) })
      })()
      return meta.id
    },

    explainGaps: async (target, notes) => {
      const source = target.fileId ? (library().files.find(file => file.id === target.fileId) ?? null) : null
      let folderId = target.folderId
      let context = ''
      if (source) {
        folderId = source.folderId
        if (!folderId) {
          const home = await library().createFolder({ name: source.name })
          await library().updateFile(source.id, { folderId: home.id })
          folderId = home.id
        }
        context = (await library().openFile(source.id)).content
      }
      const origin = source ? `diagnóstico da prova de "${source.name}"` : 'diagnóstico da prova da pasta'
      const ids: string[] = []
      for (const note of notes) {
        const meta = await library().createFile(
          { name: note.title, type: 'explanation', description: origin, folderId, parentFileId: source?.id ?? null, status: 'generating', origin: { input: 'text', name: origin, storage: 'none' } },
          '',
        )
        const input = source ? selectionInput(source, context, library().files, note.excerpt, '', 'context') : `Trecho selecionado:\n\n${note.excerpt}\n\nInstrução:\n\n${GAP_INSTRUCTION}`
        void runOnFile(meta, 'explanation', input, null, 'Explicação', origin)
        ids.push(meta.id)
      }
      return ids
    },

    createQuestions: async (fileId, wrong, model) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta) return { count: 0, web: { found: 0, note: '' } }
      const { content } = await library().openFile(fileId)
      const { job, controller } = openJob('questions', wrong?.length ? `Reforço: ${meta.name}` : `Prova: ${meta.name}`, fileId)
      const activityId = await library().startActivity({ kind: 'exam', label: `${wrong?.length ? 'Reforço' : 'Prova'}: ${meta.name}`, origin: meta.name, destination: 'questões do próprio arquivo', fileId })
      try {
        patchJob(job.id, { message: 'Preparando as questões' })
        const session = sessionFor('prova', controller.signal, model)
        const { questions, web } = await generateQuestions(content, meta.name, meta.type, session, wrong, webTarget())
        if (!questions.length) throw new Error('A IA não devolveu nenhuma questão válida. Tente de novo.')
        await library().setQuestions(fileId, questions.map(storedFromRaw), Boolean(wrong?.length))
        const done = `${questions.length} questões geradas. ${web.note}`
        closeJob(job.id, 'done', done)
        await library().finishActivity(activityId, 'done', done)
        return { count: questions.length, web }
      } catch (error) {
        const cancelled = controller.signal.aborted
        closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A prova não saiu.', cancelled ? null : failureText(error))
        await library().finishActivity(activityId, cancelled ? 'cancelled' : 'error', failureText(error))
        throw error
      }
    },

    readingExam: async (content, title) => {
      const { job, controller } = openJob('questions', `Prova de leitura: ${title}`, null)
      try {
        const session = sessionFor('prova', controller.signal)
        const { questions } = await generateReadingExam(content, title, session)
        closeJob(job.id, 'done', `${questions.length} questões geradas.`)
        return questions.map(storedFromRaw)
      } catch (error) {
        closeJob(job.id, controller.signal.aborted ? 'cancelled' : 'error', 'A prova não saiu.', failureText(error))
        throw error
      }
    },

    trackTask: title => {
      const { job } = openJob('sync', title, null)
      return {
        update: (message, fraction) => patchJob(job.id, { message, fraction }),
        done: message => closeJob(job.id, 'done', message),
        fail: error => closeJob(job.id, 'error', 'Não terminou', error),
      }
    },
    cancel: jobId => {
      controllers.get(jobId)?.abort()
    },

    dismiss: jobId => set(state => ({ jobs: state.jobs.filter(job => job.id !== jobId) })),
  }
})
