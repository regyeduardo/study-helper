import { create } from 'zustand'

import { ROUTED_CALLS, routeOf } from '@/lib/generation/account-routing'
import { runOnAccount } from '@/stores/account-jobs'
import type { AiSettings, AiStep, AiUse, Artifact, AtaModelId, AtaPart, AtaStepModels, CourseAnalysis, FileMeta, FileType, FolderMeta, GenerationChoice, GenerationMeta, MediaAnalysis, MeetingDocument, Place, RecordingData, RecordingMark, SourceMeta, SourceStorage, StageTime, StoredQuestion } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import { youtubeId, youtubeTitle } from '@/controllers/sources.controller'
import { artifactsOf, newCardsArtifact, newMapArtifact } from '@/lib/artifacts'
import { blocking } from '@/lib/blocking'
import { storedFromRaw } from '@/lib/exam'
import { aiConfigOf, modelByUid, providerById, targetFor, targetOf, transcriptionOf, uidFor } from '@/lib/ai/config'
import { modelOf } from '@/lib/ai/providers'
import { generateCards } from '@/lib/generation/cards'
import { analyzeCourse } from '@/lib/generation/course'
import { ATA_MODELS, buildAta, chosenParts, readVideoScreen } from '@/lib/generation/ata'
import { ataDocument, ataPrompt, type MediaParts, mediaParts, withTranscript } from '@/lib/generation/from-media'
import { type AtaModels, appAi } from '@/lib/generation/ata-ai'
import type { FrameSource } from '@/lib/generation/ata-types'
import { renderPrint } from '@/lib/generation/prints'
import { openVideoFrames, signatureDifference } from '@/lib/generation/video-source'
import { courseLessonInput, courseOf, explanationName, selectionInput, selectionTitle } from '@/lib/generation/course-lesson'
import { type ContentInput, mediaDuration, resolveInput, type ResolvedInput } from '@/lib/generation/inputs'
import { withInstruction } from '@/lib/generation/instruction'
import { buildMinutes, minutesFileName } from '@/lib/generation/minutes'
import { generateMap } from '@/lib/generation/mindmap'
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
import { isSourceNote, isYoutube, mediaOf, type NoteMedia, readsAsTranscript, recordingName, sourceTypeOf } from '@/lib/file-types'
import { entryOfSource, entryOriginOf, keptInNote, linkIn, noteSourceOf } from '@/lib/note-source'
import { cannotWatch, youtubeParts } from '@/lib/generation/youtube-video'
import { downloadStoredSource, sourceExpired, storeSource } from '@/lib/storage/source-storage'
import { keepLocalMedia, linkLocalMedia, listLocalMedia, readLocalMedia } from '@/lib/recording/media-library'
import { transcribe } from '@/lib/transcription'
import { StageClock } from '@/lib/transcription/types'
import { transcriptText } from '@/lib/transcription/export'
import { recorderName, useAccountStore } from '@/stores/account'
import { liveFolders, useLibraryStore } from '@/stores/library'
import { mediaOfModel, searchesWeb, useModelsStore } from '@/stores/models'
import { askOf } from '@/stores/retry'
import type { Overlay } from '@/stores/ui'

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
  kind: 'generation' | 'questions' | 'course' | 'transcription' | 'sync' | 'artifact'
  title: string
  fileId: string | null
  /** The note a map or a deck is made from: kept out of `fileId`, so the note itself does not read as being written (its banner, its buttons). */
  noteId?: string
  status: JobStatus
  message: string
  fraction: number | null
  error: string | null
  startedAt: number
  /** The window that asked for it, as it was filled in: a failure offers "Tentar de novo" with it. */
  retry?: Overlay
  /** What "Abrir" opens once it came out: the map or the deck made. */
  open?: Overlay
}

/** A map or a deck of a note: who makes it and what to focus on; `again`: the one made before ("Gerar de novo"), `replace`: the new one takes its place. */
export interface ArtifactRequest {
  fileId: string
  artifact: 'mapa' | 'cartoes'
  model?: string | null
  instruction?: string
  again?: string
  replace?: boolean
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
  /** Where the person wants the note and its media (App or Google Drive): the note's own place, whatever the folder (a folder has no place, spec 005). */
  place?: Place
  litterboxTime: LitterboxTime
  marks: RecordingMark[]
  transcribe: boolean
  /** The Transcrição model picked when saving (else the default). */
  transcriptionModel?: string | null
  /** A note to write from the recording right after saving it (Ata, Aula, Explicação). It transcribes first when it needs the text, so `transcribe` stays off. */
  write?: RecordingWrite
  /** Several notes to write at once (spec 007, "Gerar" with many marked): after the transcription, when it is marked, so it is made once. */
  writes?: RecordingWrite[]
  /** The name the person typed for the note (else the recording's file name). */
  name?: string
}

/** The note a recording starts as soon as it is saved: the entrada's child, in the entrada's folder, as "Gerar desta entrada" makes it. */
export interface RecordingWrite {
  agent: NoteAgent
  /** Who writes (the video model when it also writes); null: the default. */
  model: string | null
  instruction?: string
  /** Of a video, what the AI analyzes (FR-046); absent: as the model allows. */
  analyze?: MediaAnalysis
  /** Ata: the parts that go into the document. */
  parts?: AtaPart[]
  /** Ata: the "Modelo da ata", in place of the parts. */
  ataModel?: AtaModelId
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
  /** `retry`: the window as it was filled in, kept on the job for "Tentar de novo". */
  startNewContent(request: NewContentRequest, onJob?: (jobId: string) => void, retry?: Overlay): Promise<string | null>
  saveRecording(request: SaveRecordingRequest): Promise<string>
  /** `instruction`: what the person asks of the revision (names, words), as in "Refazer a transcrição". */
  transcribeNote(fileId: string, source?: File, transcriptionModel?: string | null, instruction?: string): Promise<void>
  acceptCourse(proposal: CourseProposal, folderId: string | null): Promise<string>
  declineCourse(proposal: CourseProposal): Promise<string>
  /** `instruction` absent: the one the note kept. */
  generatePending(fileId: string, model?: string | null, instruction?: string): Promise<void>
  generateSecondTab(fileId: string, agent: SecondTabAgent, model?: string | null, instruction?: string): Promise<void>
  redoTranscript(fileId: string, instruction: string, model?: string | null): Promise<void>
  /** `analyze`: of a video entrada, what the AI analyzes (FR-046); an audio entrada always goes by its transcription, made first when missing. */
  /** `steps`: the models of the Vídeo and the Contexto when the note of a video goes step by step (`analyze` "quadros", T177). */
  generateFromNote(fileId: string, agent: NoteAgent, model?: string | null, place?: Target, instruction?: string, analyze?: MediaAnalysis, steps?: AtaStepModels): Promise<string | null>
  /** `file`: the media in hand (Novo conteúdo), heard straight even when the entrada does not keep it. `analyze`: as in `generateFromNote`. */
  generateAta(fileId: string, parts: AtaPart[], model?: AtaModelId, ai?: AtaModels, place?: Target, instruction?: string, file?: File, analyze?: MediaAnalysis): Promise<string | undefined>
  suggestTags(fileId: string): Promise<void>
  /** Every lesson still to write in the course folder, all with the same model (and instruction, when given). */
  generateRemaining(folderId: string, model?: string | null, instruction?: string): Promise<void>
  regenerate(fileId: string): Promise<void>
  /** `place`: Gerar de novo of an explanation, over it (`replace`) or in a folder; absent, where the mode puts it. */
  explainSelection(fileId: string, excerpt: string, prompt: string, mode: 'concept' | 'context', model?: string | null, place?: Target): Promise<string>
  /**
   * "Gerar a partir disto": a link or a passage selected in a note. The new note is the note's child and keeps what was selected as its source;
   * a YouTube link becomes an entrada inside the note, and the new note is born of it (`analyze` as in `generateFromNote`).
   */
  generateFromSelection(fileId: string, excerpt: string, agent: NoteAgent, model?: string | null, place?: { folderId: string | null }, instruction?: string, analyze?: MediaAnalysis): Promise<string | null>
  /** "Virar entrada": the source the note keeps becomes an entrada, as Novo conteúdo made it before, and the note its child. Again, nothing new: the id of that entrada. */
  turnIntoEntry(fileId: string): Promise<string | null>
  explainGaps(target: { fileId: string | null; folderId: string | null }, notes: { title: string; excerpt: string }[], model?: string | null): Promise<string[]>
  createQuestions(fileId: string, wrong?: WrongQuestion[], model?: string | null, instruction?: string): Promise<{ count: number; web: WebOutcome }>
  readingExam(content: string, title: string): Promise<StoredQuestion[]>
  /** A map or a deck made under a job of its own (Gerações): the one saved; a failure or a cancel throws, after its job says so. */
  generateArtifact(request: ArtifactRequest): Promise<Artifact>
  cancel(jobId: string): void
  dismiss(jobId: string): void
  /** fileId: the note the task is about (a failure shows on it). */
  trackTask(title: string, fileId?: string | null): TrackedTask
}

export interface TrackedTask {
  /** `bytes`: how much of a file went (a window that holds the app shows it, with the time left). */
  update(message: string, fraction: number | null, bytes?: { done: number; total: number }): void
  done(message: string): void
  fail(error: string): void
  /** The line leaves the panel without a trace: whoever started it says the end another way (a toast). */
  drop?(): void
}

const controllers = new Map<string, AbortController>()

const AGENT_PROMPTS: Record<Exclude<Agent, 'reading' | 'meeting'>, string> = {
  lesson: PROMPTS.LESSON_PROMPT,
  explanation: PROMPTS.EXPLANATION_PROMPT,
}

const GAP_INSTRUCTION = 'Explique o que faltou aprender em cada tema, usando as questões erradas como exemplo do equívoco, sem repetir a prova.'

const FILE_TYPE: Record<Agent, FileType> = { lesson: 'class', explanation: 'explanation', meeting: 'meeting', reading: 'reading' }

const AGENT_LABEL: Record<Agent, string> = { lesson: 'Aula', explanation: 'Explicação', meeting: 'Ata', reading: 'Leitura' }

/** A map's or a deck's job: the start of its title (Gerações reads "O que" from it), what it says while it is made, and why it failed. */
const ARTIFACT_WORDS: Record<ArtifactRequest['artifact'], { label: string; busy: string; empty: string; failed: string }> = {
  mapa: { label: 'Mapa', busy: 'Desenhando o mapa da nota', empty: 'A IA não devolveu um mapa. Tente de novo.', failed: 'O mapa não saiu.' },
  cartoes: { label: 'Cartões', busy: 'Fazendo os cartões da nota', empty: 'A IA não devolveu nenhum cartão. Tente de novo.', failed: 'Os cartões não saíram.' },
}

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

/** What the person reads of a failure; without internet, that generating needs it (história 6, US6/AC4). */
export const OFFLINE_GENERATION = 'Gerar precisa de internet. Quando a conexão voltar, use “Tentar de novo” em Gerações.'

function failureText(error: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return OFFLINE_GENERATION
  return error instanceof Error ? error.message : String(error)
}

/** When the meeting started: from the recording's name ("Reunião 28-10-2026, 18-15-41"), else creation minus length. */
export function meetingStart(meta: FileMeta): Date {
  const found = /(\d{2})-(\d{2})-(\d{4}),?\s+(\d{2})-(\d{2})/.exec(meta.origin?.name ?? meta.name)
  if (found) return new Date(Number(found[3]), Number(found[2]) - 1, Number(found[1]), Number(found[4]), Number(found[5]))
  return new Date(new Date(meta.created.at).getTime() - (meta.origin?.durationSeconds ?? 0) * 1000)
}

/** The lessons still to write in a course folder and in the folders inside it. */
export function remainingIn(folderId: string, folders: FolderMeta[], files: FileMeta[]): FileMeta[] {
  const ids = new Set<string>([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders) if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) (ids.add(folder.id), (grew = true))
  }
  return files.filter(file => file.folderId && ids.has(file.folderId) && file.status === 'pending' && !file.deletedAt)
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

/**
 * T177: an Aula or an Explicação of a video, step by step: the screen read by the frames of the video, the way the Ata reads it (the
 * Vídeo model looks, the Contexto model finds where the speech points at the screen), as text the writer gets with the transcription.
 * A video that does not open, or a reading that fails, leaves the note written from the transcription alone.
 */
function lookAtVideo(video: () => Promise<Blob | null>, recording: RecordingData | undefined, chosen: AtaModels, startedAt: Date) {
  return async (progress: (message: string) => void, signal: AbortSignal): Promise<string> => {
    if (!recording?.blocks.length) return ''
    progress('Abrindo o vídeo da gravação')
    const blob = await video().catch(() => null)
    const frames = blob ? await openVideoFrames(blob).catch(() => null) : null
    if (!frames) return ''
    try {
      const ai = appAi(library().index.settings, signal, undefined, chosen)
      const screen = await readVideoScreen(recording, { ai, frames, difference: signatureDifference }, progress, startedAt)
      return screen ? `Leitura da tela (o que aparecia na tela do vídeo, lido pelos quadros):\n${screen}` : ''
    } catch (error) {
      if (error instanceof Cancelled || signal.aborted) throw error
      return ''
    } finally {
      frames.close?.()
    }
  }
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
const NO_MEDIA = 'A mídia desta nota não está mais guardada: use "Só a transcrição".'
const MEDIA_WONT_GO = 'Não deu para mandar a mídia ao modelo (longa demais ou sem áudio): use "Só a transcrição".'
const NOTHING_TO_READ = 'Esta nota não tem texto nem arquivo para a IA ler.'
const NO_TRANSCRIPT = 'Esta nota não tem transcrição, e a mídia não pôde ser transcrita.'

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

/** A YouTube link as video for ONE call to the use's model, only when the person chose it ("Só o vídeo", "Transcrição + vídeo"); a model that cannot watch it fails saying why. */
async function youtubeMedia(use: AiUse, pick: string | null | undefined, asked: MediaAnalysis | undefined, url: string): Promise<MediaParts | null> {
  if (asked !== 'video' && asked !== 'ambos') return null
  const config = aiConfigOf(library().index.settings)
  const uid = (pick && modelByUid(config, pick) ? pick : undefined) ?? uidFor(config, use)
  const provider = providerById(config, modelByUid(config, uid)?.pid)
  if (provider && useModelsStore.getState().live[provider.id]?.state !== 'ok') await useModelsStore.getState().read(provider, false)
  const { live, probes } = useModelsStore.getState()
  const reason = cannotWatch(config, uid, uid ? mediaOfModel(config, live, probes, uid) : null)
  if (reason) throw new Error(reason)
  return youtubeParts(url)
}

/** The YouTube link of a request, when it is one. */
const youtubeLink = (input: ContentInput): string | null => (input.kind === 'link' && youtubeId(input.url) ? input.url.trim() : null)

/** A YouTube link the writer watches ("Só o vídeo"): only its title is read, never the legenda. */
async function watchedInput(url: string, progress: (message: string) => void, signal: AbortSignal): Promise<ResolvedInput> {
  progress('Lendo o título do vídeo')
  const title = await youtubeTitle(url, signal)
  return { content: '', title, description: url, origin: { input: 'youtube', name: title, url, storage: 'none' }, transcription: null }
}

/** What the AI analyzes of a media (FR-046): of a video, what the person chose (absent: the media when the model hears it, else the transcription); of an audio, always the transcription. */
const analysisOf = (media: NoteMedia, analyze?: MediaAnalysis): MediaAnalysis | undefined => (media === 'audio' ? 'transcricao' : media === 'video' ? analyze : undefined)

/** What a note keeps of that choice for "Gerar de novo": only a video has one. */
const analyzedOf = (media: NoteMedia, analyze?: MediaAnalysis): Pick<GenerationChoice, 'analyze'> => (media === 'video' && analyze ? { analyze } : {})

const mediaOfFile = (file: File): NoteMedia => (file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'text')

/** The media of an entrada for the call, by what the AI analyzes; a choice that cannot be met fails saying why. `inHand`: without a choice, the media is only tried when it is there. */
const entryMedia = (use: AiUse, pick: string | null | undefined, asked: MediaAnalysis | undefined, inHand: boolean, open: () => Promise<File>): Promise<MediaParts | null> =>
  asked === 'transcricao' || asked === 'quadros' || (!asked && !inHand) ? Promise.resolve(null) : directMedia(use, pick, open, Boolean(asked))

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

/** What is read again of the source a note keeps in itself: its link, its text, its topic. */
function sourceInput(meta: FileMeta): ContentInput | null {
  const source = meta.source
  if (source?.kind === 'link' && source.url) return { kind: 'link', url: source.url }
  if (source?.kind === 'text' && source.text?.trim()) return { kind: 'text', text: source.text }
  if (source?.kind === 'topic' && source.text?.trim()) return { kind: 'topic', topic: source.text }
  return null
}

/** "Virar entrada" asked twice before the first ends: the same answer. */
const turning = new Map<string, Promise<string | null>>()

export const useJobsStore = create<JobsState>((set, get) => {
  const patchJob = (id: string, patch: Partial<Job>) => set(state => ({ jobs: state.jobs.map(job => (job.id === id ? { ...job, ...patch } : job)) }))

  /** `extra`: what the job starts with besides (a map's note, its own message and window). */
  const openJob = (kind: Job['kind'], title: string, fileId: string | null, extra: Partial<Job> = {}): { job: Job; controller: AbortController } => {
    // a generation asked in a window keeps it, for "Tentar de novo"
    const retry = kind === 'generation' || kind === 'transcription' ? askOf(fileId) : undefined
    const job: Job = { id: newId(), kind, title, fileId, status: 'running', message: 'Começando', fraction: null, error: null, startedAt: Date.now(), ...(retry ? { retry } : {}), ...extra }
    const controller = new AbortController()
    controllers.set(job.id, controller)
    set(state => ({ jobs: [job, ...state.jobs] }))
    return { job, controller }
  }

  const closeJob = (id: string, status: JobStatus, message: string, error: string | null = null) => {
    controllers.delete(id)
    patchJob(id, { status, message, error, fraction: status === 'done' ? 1 : null })
  }

  const dropJob = (id: string) => {
    controllers.delete(id)
    set(state => ({ jobs: state.jobs.filter(job => job.id !== id) }))
  }

  /**
   * From the click until the real job exists (models read, media opened, notes read) the person sees a "Preparando" line, so the wait never looks like a click that did nothing.
   * The line is the job of the generation: it turns into the failure if the preparation fails, and `stopped()` makes its "Cancelar" real.
   */
  const preparing = (title: string, fileId: string) => {
    let id: string | null = null
    let controller: AbortController | null = null
    const open = () => {
      const opened = openJob('generation', title, fileId)
      id = opened.job.id
      controller = opened.controller
      patchJob(id, { message: 'Preparando' })
    }
    const end = () => {
      if (id) dropJob(id)
      id = null
    }
    open()
    return {
      /** The person pressed "Cancelar": the line says so and the generation does not go on. */
      stopped: (): boolean => {
        if (!id || !controller?.signal.aborted) return false
        closeJob(id, 'cancelled', 'Cancelado por você.')
        id = null
        return true
      },
      /** The preparation failed: the same line turns into the error (or into "Cancelado", if she cancelled meanwhile). */
      refuse: (message: string, error: unknown) => {
        if (!id) return
        const cancelled = controller?.signal.aborted
        closeJob(id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : message, cancelled ? null : failureText(error))
        id = null
      },
      /** Another job (the transcription) takes the file for a while: the line steps aside and comes back after. */
      around: async <T>(run: () => Promise<T>): Promise<T> => {
        const cancelled = Boolean(controller?.signal.aborted)
        end()
        try {
          return await run()
        } finally {
          open()
          if (cancelled) (controller as AbortController | null)?.abort()
        }
      },
      /** The real job starts (or nothing will): the line leaves. */
      end,
    }
  }

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

  /** The material of a link, a text or a topic, read under a job of its own; null when it cannot be read, with the failed job saying why. */
  const readInput = async (fileId: string, title: string, input: ContentInput | null): Promise<ResolvedInput | null> => {
    const { job, controller } = openJob('generation', title, fileId)
    try {
      if (!input) throw new Error('Esta nota não guardou de onde veio: não há o que a IA ler.')
      const resolved = await resolveInput(input, library().index.settings, '', (message, fraction) => patchJob(job.id, { message, fraction: fraction ?? null }), controller.signal)
      closeJob(job.id, 'done', 'Material lido.')
      return resolved
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
    /** T177: the screen of the video read step by step, added to the text before writing (empty: nothing read). */
    look?: (progress: (message: string) => void, signal: AbortSignal) => Promise<string>,
  ): Promise<void> => {
    const { job, controller } = openJob('generation', meta.name, meta.id)
    const activityId = await library().startActivity({ kind: agent, label: `${label}: ${meta.name}`, origin, destination: destinationName(meta.folderId), fileId: meta.id })
    await library().updateFile(meta.id, { status: 'generating' })
    const session = sessionFor(AGENT_USE[agent], controller.signal, pick)
    try {
      const recording = heard ?? resolved?.transcription?.recording ?? (await library().openFile(meta.id).catch(() => null))?.sidecar.recording
      const clock = new StageClock()
      clock.add(resolved?.transcription?.stages)
      const seen = look ? await clock.run('Ler a tela do vídeo', () => look(message => patchJob(job.id, { message }), controller.signal)) : ''
      const material = seen ? `${content}\n\n${seen}` : content
      const { markdown, name } = await clock.run(media ? 'Escrever direto da mídia' : 'Escrever', () => writeDocument(meta.id, agent, material, session, job.id, systemPrompt, recording, media, instruction))
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
  const requestChoice = (request: NewContentRequest): Pick<GenerationChoice, 'analyze'> =>
    request.input.kind === 'file' || request.input.kind === 'recording' ? analyzedOf(mediaOfFile(request.input.file), request.analyze) : youtubeLink(request.input) ? analyzedOf('video', request.analyze) : {}

  /** Kept for "Tentar de novo" and "Gerar de novo": the instruction and what the AI analyzed, when there is one. */
  const madeOf = (request: NewContentRequest, agent: Agent): { made?: GenerationChoice } =>
    agent !== 'reading' ? { made: choiceOf(AGENT_USE[agent], request.models?.write, { ...instructionOf(request.prompt), ...requestChoice(request) }) } : {}

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
        // the note that keeps the source has the type of the source (no more entradas); with "Sem rastro", the type of what is written
        type: traceless ? FILE_TYPE[agent] : sourceTypeOf(resolved.origin),
        description: request.description.trim() || resolved.description,
        folderId: request.folderId,
        status: agent === 'reading' ? 'ready' : 'generating',
        pendingExcerpt: agent === 'reading' ? null : resolved.content,
        origin: traceless ? null : resolved.origin,
        ...(traceless ? {} : { kept: 'registro' as const }),
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
    if (keepOf(request) !== 'arquivo' || !isSourceNote(entry)) return
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
    const found = library().files.find(file => isSourceNote(file) && !file.deletedAt && file.origin && sourceKey(file.origin) === key)
    if (found) return found
    const pasted = request.input.kind === 'text' ? request.input.text.trim() : ''
    return library().createFile(
      { name: pasted ? resolved.title : resolved.origin.name, kept: 'registro', type: sourceTypeOf(resolved.origin), description: resolved.description, folderId: request.folderId, status: 'ready', origin: resolved.origin },
      pasted,
    )
  }

  /** The entrada of the request: for media, a new one that keeps the transcription; else `entryFor`. */
  const sourceEntry = (request: NewContentRequest, resolved: ResolvedInput): Promise<FileMeta | null> =>
    keepOf(request) !== 'sem-rastro' && isMedia(resolved.origin) ? createHolder(request, resolved, 'reading', resolved.title) : entryFor(request, resolved)

  /** Of a link, a text or a topic, the note keeps where it came from in itself (no entrada); null for what becomes an entrada. */
  const keptSource = (request: NewContentRequest, resolved: ResolvedInput): Pick<FileMeta, 'origin' | 'source'> | null =>
    keptInNote(request.input) ? { origin: { ...resolved.origin }, source: noteSourceOf(request.input, resolved, nowIso()) } : null

  /** The note made of the source: the entrada's child; of a link, a text or a topic, a note that keeps it; with "Sem rastro", a note without mother and origin. */
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
        ...(keptSource(request, resolved) ?? { origin: entry ? noteOrigin(resolved.origin, entry) : null }),
        // kept for "Tentar de novo"
        ...madeOf(request, agent),
      },
      agent === 'reading' ? resolved.content.replace(/^# Conteúdo\n\n/, '') : '',
    )

  /** The note of a request whose material is already read: under its entrada, which keeps the file when asked. Transcribed media with "Só a transcrição" is the entrada alone. A link, a text or a topic: the note alone, keeping it. */
  const createForRequest = async (request: NewContentRequest, resolved: ResolvedInput, agent: Agent): Promise<FileMeta> => {
    if (keptInNote(request.input)) return createChild(request, resolved, agent, null)
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
    const entry = isSourceNote(meta) ? meta : null
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
      // T177: a video in hand, step by step: the screen read by its frames goes with the transcription to the writer
      const inHand = request.input.kind === 'file' || request.input.kind === 'recording' ? request.input.file : null
      const stepped =
        inHand && inHand.type.startsWith('video/') && request.analyze === 'quadros' && !makesAta && agent !== 'reading'
          ? lookAtVideo(async () => inHand, resolved.transcription?.recording, { model: request.models?.write || uidFor(aiConfigOf(library().index.settings), AGENT_USE[agent]) || null, ...request.models?.steps }, new Date())
          : undefined
      if (agent === 'reading' || makesAta || entry) {
        const polishing = polishSessions.get(resolved.transcription!)
        await library().saveContent(meta.id, resolved.content.replace(/^# Conteúdo\n\n/, ''), { name, description, pendingExcerpt: null, ...(makesAta || entry ? { ...(entry ? {} : { type: 'reading' as const }), status: 'ready' as const } : {}), ...(polishing ? { generation: generationMeta(polishing, resolved, resolved.transcription?.stages) } : {}) })
        closeJob(job.id, 'done', 'Material lido.')
        if (entry && !makesAta && agent !== 'reading') {
          // the text written of the transcription is a note of its own, under the entrada
          const note = await createChild(request, { ...resolved, title: name, description }, agent, { ...entry, name })
          await runOnFile(note, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name, undefined, undefined, request.models?.write, false, withMaterial(both, resolved.content), request.prompt, stepped)
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
      await runOnFile(fresh, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name, undefined, undefined, request.models?.write, false, withMaterial(both, resolved.content), request.prompt, stepped)
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

  const polished = async (resolved: ResolvedInput, marks: RecordingMark[], progress: (message: string) => void, signal: AbortSignal, source: File | null, instruction = ''): Promise<ResolvedInput> => {
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
    const finished = await clock.run('Acabamento: título, nomes e revisão', () => polishTranscript(seen, session, library().index.settings.transcription.terms ?? '', instruction))
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

  /**
   * "Gerar" of a note still to write ("Gerar agora", "Tentar de novo", "Refazer"); null when it is gone or already running.
   * `start` writes the choice to the note and opens its job; `generation` (wrapped, so whoever starts it need not wait for it) is the writing itself.
   */
  const pendingOf = (fileId: string, model?: string | null, instruction?: string) => {
    const { files, folders } = library()
    const meta = files.find(file => file.id === fileId)
    if (!meta || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return null
    const course = Boolean(courseOf(folders, meta.folderId))
    const agent: Agent = course ? 'lesson' : meta.type === 'explanation' ? 'explanation' : meta.type === 'meeting' ? 'meeting' : 'lesson'
    // what this time asks stays with the note, for the next "Tentar de novo" and "Gerar de novo"
    const said = instruction ?? meta.made?.instruction ?? ''
    const made = choiceOf(AGENT_USE[agent], model, instructionOf(said))
    const write = async (): Promise<void> => {
      if (course) {
        await runOnFile({ ...meta, made }, 'lesson', courseLessonInput(meta, folders, files), null, 'Aula', meta.description || meta.name, undefined, undefined, model, false, undefined, said)
        return
      }
      // written again ("Refazer"), a note that keeps its link, text or topic reads it again
      const material = meta.pendingExcerpt ?? (meta.source ? (await readInput(meta.id, meta.name, sourceInput(meta)))?.content : undefined)
      if (meta.source && material === undefined) return
      await runOnFile({ ...meta, made }, agent, material ?? `# ${meta.name}`, null, 'Nova tentativa', meta.origin?.url ?? meta.origin?.name ?? meta.name, undefined, undefined, model, false, undefined, said)
    }
    return {
      title: `${AGENT_LABEL[agent]}: ${meta.name}`,
      start: async (): Promise<{ generation: Promise<void> }> => {
        await library().updateFile(meta.id, { made })
        return { generation: write() }
      },
    }
  }

  return {
    jobs: [],
    live: {},
    proposals: [],

    startNewContent: async (request, onJob, retry) => {
      const agent: Agent = request.input.kind === 'topic' && request.agent === 'lesson' ? 'explanation' : request.agent
      const { job, controller } = openJob('generation', request.name || AGENT_LABEL[agent], null)
      if (retry) patchJob(job.id, { retry })
      onJob?.(job.id)
      let resolved: ResolvedInput
      // "Transcrição + vídeo": the media waits for the transcription, to go with it in the same call
      let both: MediaParts | null = null
      // "Só o vídeo" of a YouTube link: the writer watches it, and the legenda is not read
      let watched: MediaParts | null = null
      try {
        const progress = (message: string, fraction?: number) => patchJob(job.id, { message, fraction: fraction ?? null })
        const heardBy = request.models?.transcription
        const file = request.input.kind === 'recording' || request.input.kind === 'file' ? request.input.file : null
        if (file && agent !== 'reading' && /^(audio|video)\//.test(file.type)) {
          const makesAta = agent === 'meeting' && (Boolean(request.ataModel) || chosenParts(request.ataParts ?? []).length > 0)
          const asked = analysisOf(mediaOfFile(file), request.analyze)
          const media = asked === 'transcricao' || asked === 'quadros' ? null : await directMedia(makesAta ? 'ata' : AGENT_USE[agent], request.models?.write, async () => file, Boolean(asked))
          if (asked === 'ambos') both = media
          else if (media) return await startFromMedia(request, agent, file, media, makesAta, job)
        }
        const link = youtubeLink(request.input)
        const seen = link && agent !== 'reading' ? await youtubeMedia(AGENT_USE[agent], request.models?.write, request.analyze, link) : null
        if (seen && request.analyze === 'ambos') both = seen
        else if (seen) watched = seen
        // the instruction goes as its own block when writing, not inside the material
        const read = link && watched ? await watchedInput(link, progress, controller.signal) : request.input.kind === 'recording' ? await resolveRecording(request.input.file, progress, controller.signal, heardBy) : await resolveInput(request.input, library().index.settings, '', progress, controller.signal, heardBy)
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
      if (agent === 'lesson' && !both && !watched) {
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
      // T177: a video in hand, step by step (the Aula comes here): the screen read by its frames goes with the transcription
      const inHand = request.input.kind === 'file' || request.input.kind === 'recording' ? request.input.file : null
      const stepped =
        inHand && inHand.type.startsWith('video/') && request.analyze === 'quadros'
          ? lookAtVideo(async () => inHand, resolved.transcription?.recording, { model: request.models?.write || uidFor(aiConfigOf(library().index.settings), AGENT_USE[agent]) || null, ...request.models?.steps }, new Date())
          : undefined
      void runOnFile(meta, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name, undefined, undefined, request.models?.write, false, watched ?? withMaterial(both, resolved.content), request.prompt, stepped)
      return meta.id
    },

    saveRecording: async request => {
      const { file } = request
      const origin: SourceMeta = { input: 'recording', name: file.name, sizeBytes: file.size, mime: file.type || 'application/octet-stream', durationSeconds: request.durationSeconds, storage: 'none' }
      // the recording is a media note (Vídeo or Áudio): the transcription and what is generated from it live under it
      // the choice is kept as the note's own: without it, a note made now is born in the App with the structure on, even with "Google Drive" chosen
      const own = request.place ? { place: request.place } : {}
      const meta = await library().createFile({ name: request.name?.trim() || recordingName(file.name), kept: 'registro', type: sourceTypeOf(origin), description: '', folderId: request.folderId, status: 'ready', pendingExcerpt: null, origin, ...own }, '')
      if (request.marks.length) await library().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: { blocks: [], speakers: [], marks: request.marks } }))
      // T181: the recording kept in this browser (Mídias) is the copy that stays if the upload fails
      let keptHere = false
      if (request.storedName)
        await linkLocalMedia(request.storedName, meta.id).then(
          () => ((keptHere = true), library().updateFile(meta.id, { kept: 'arquivo' })),
          () => undefined,
        )
      const failed = (error: unknown, place: 'app' | 'drive') =>
        keptHere ? `${failureText(error).replace(/\.?$/, '.')} A gravação continua salva neste navegador, em Mídias: abra a nota e use "${place === 'app' ? 'Salvar no App' : 'Salvar no meu Drive'}" para enviar de novo.` : failureText(error)
      const writes = [...(request.write ? [request.write] : []), ...(request.writes ?? [])]
      // spec 007 (FR-027, FR-031): the media goes up to the App with the structure on, so what was asked goes to the account once it is
      // there, without the file in hand (the account reads the media it has); there the Ata runs after the transcription of the note
      const repo = library().repo as { sideOf?: (id: string) => string | undefined } | null
      const toAccount = request.storage === 'drive' && library().appOn && repo?.sideOf?.(meta.id) === 'app' && Boolean(request.transcribe || writes.length)
      let uploaded: Promise<boolean> = Promise.resolve(true)
      if (toAccount) {
        uploaded = blocking(
          'Guardando a mídia no App…',
          async blocker => {
            const stored = await library().repo!.putSource(meta.id, file, file.name, { onProgress: (doneBytes, totalBytes) => blocker.progress({ doneBytes, totalBytes }) })
            await library().updateFile(meta.id, { origin: { ...origin, storage: 'drive', storedFileId: stored.ref, expiresAt: null } as SourceMeta, kept: 'arquivo' })
          },
          { phase: 'O que você pediu começa na conta depois do envio; depois, pode fechar a aba', doneBytes: 0, totalBytes: file.size },
        ).then(
          () => true,
          error => {
            get().trackTask(`Guardar a mídia: ${meta.name}`).fail(failed(error, 'app'))
            return false
          },
        )
      } else if (request.storage !== 'none') {
        // the window holds the app until the upload ends, saying how much went (to the App and the Drive; a host says nothing)
        void blocking(request.storage !== 'drive' ? 'Guardando a mídia…' : request.place === 'app' ? 'Guardando a mídia no App…' : 'Guardando a mídia no Drive…', blocker =>
          storeSource(file, request.storage, meta.id, library().repo!, request.litterboxTime, { onProgress: (done, total) => blocker.progress({ phase: 'Enviando a mídia', doneBytes: done, totalBytes: total }) }).then(stored =>
            library().updateFile(meta.id, { origin: { ...origin, ...stored } as SourceMeta, kept: 'arquivo' }),
          ),
        ).catch(error => get().trackTask(`Guardar a mídia: ${meta.name}`).fail(failed(error, request.storage === 'drive' && request.place === 'app' ? 'app' : 'drive')))
      }
      // the upload failed: the work runs here with the file in hand, as before, and nothing asked is lost
      const sourceOf = (ok: boolean) => (toAccount && ok ? undefined : file)
      const place = { folderId: request.folderId }
      const runWrite = (write: RecordingWrite, source: File | undefined) =>
        (write.agent === 'meeting'
          ? get().generateAta(meta.id, write.ataModel ? [] : (write.parts ?? []), write.ataModel, { model: write.model }, place, write.instruction, source, write.analyze)
          : get().generateFromNote(meta.id, write.agent, write.model, place, write.instruction, write.analyze)
        ).then(
          () => undefined,
          error => get().trackTask(`${AGENT_LABEL[write.agent]}: ${meta.name}`).fail(failureText(error)),
        )
      // the transcription first, when marked; then the notes, which find it made and do not transcribe again. Without it, the first
      // note transcribes when it needs the text, and the others wait for it so as not to transcribe twice. In the account, everything is
      // asked at once, in this order: the service runs the jobs of the same note in turn
      void (async () => {
        const ok = await uploaded
        const source = sourceOf(ok)
        const inAccount = toAccount && ok
        if (request.transcribe) {
          const heard = get().transcribeNote(meta.id, source, request.transcriptionModel).catch(error => get().trackTask(`Transcrição: ${meta.name}`).fail(failureText(error)))
          if (!inAccount) await heard
        }
        if (!writes.length) return
        // the media just linked has to be known as kept here before the note asks for it
        useLibraryStore.setState({ localMedia: await listLocalMedia().catch(() => library().localMedia) })
        if (inAccount || request.transcribe) await Promise.all(writes.map(write => runWrite(write, source)))
        else for (const write of writes) await runWrite(write, source)
      })()
      return meta.id
    },

    transcribeNote: async (fileId, source, transcriptionModel, instruction) => {
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
        const resolved = await polished(read, marks, progress, controller.signal, file, instruction)
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
      // a link or a text stays in each lesson, with no entrada
      const kept = keptSource(proposal.request, resolved)
      const entry = kept ? null : await sourceEntry(proposal.request, resolved)
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
              { name: plan.title, type: 'class', folderId: parent.id, description: plan.covers, pendingExcerpt: plan.excerpt || null, status: 'pending', position: module.lessons.length ? position : index, parentFileId: entry?.id ?? null, ...(kept ?? { origin: entry ? noteOrigin(resolved.origin, entry) : null }), ...(proposal.request.prompt.trim() ? { made: choiceOf('aula', proposal.request.models?.write, instructionOf(proposal.request.prompt)) } : {}) },
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

    generatePending: async (fileId, model, instruction) => {
      const pending = pendingOf(fileId, model, instruction)
      if (!pending) return
      // from the click until its job opens (the choice written to the note in the Drive) the app is held in the window
      const { generation } = await blocking(pending.title, pending.start, { phase: 'Preparando' })
      await generation
    },

    generateSecondTab: async (fileId, agent, model, instruction) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      // from the click until its job opens (the note read, the choice written in the Drive) the app is held in the window
      const started = await blocking(
        `${AGENT_LABEL[agent]}: ${meta.name}`,
        async () => {
          const recording = (await library().openFile(fileId)).sidecar.recording
          if (!recording) return null
          const made = choiceOf(AGENT_USE[agent], model, instructionOf(instruction))
          await library().updateFile(fileId, { type: FILE_TYPE[agent], made })
          return { generation: runOnFile({ ...meta, type: FILE_TYPE[agent], made }, agent, `${CONTENT_HEADER}${transcriptText(recording)}`, null, AGENT_LABEL[agent], meta.origin?.name ?? meta.name, undefined, undefined, model, false, undefined, instruction) }
        },
        { phase: 'Preparando' },
      )
      await started?.generation
    },

    generateFromNote: async (fileId, agent, model, place = 'home', instruction, analyze, steps) => {
      const source = library().files.find(file => file.id === fileId)
      if (!source) return null
      // from here to the real job, a "Preparando" line shows that the click worked
      const prep = preparing(`${AGENT_LABEL[agent]}: ${source.name}`, fileId)
      try {
        // a YouTube entrada is a video seen by its link
        const kind: NoteMedia = isYoutube(source) ? 'video' : mediaOf(source)
        const asked = analysisOf(kind, analyze)
        let media: MediaParts | null
        try {
          media = isYoutube(source) ? await youtubeMedia(AGENT_USE[agent], model, asked, source.origin!.url!) : await entryMedia(AGENT_USE[agent], model, asked, keptMedia(source), () => mediaFileOf(source))
        } catch (error) {
          prep.refuse('A geração não começou.', error)
          return null
        }
        if (prep.stopped()) return null
        const needsText = !media || asked === 'ambos'
        // the transcription is needed and missing: made first, and it stays in the entrada
        const before = (await library().openFile(fileId)).sidecar
        if (needsText && keptMedia(source) && !before.recording?.blocks.length && !before.transcript?.trim()) await prep.around(() => get().transcribeNote(fileId))
        if (prep.stopped()) return null
        const { content, sidecar } = await library().openFile(fileId)
        const recording = sidecar.recording?.blocks.length ? sidecar.recording : undefined
        const held = recording ? transcriptText(recording) : content || (sidecar.transcript ?? '')
        const material = needsText && !held.trim() ? await prep.around(() => readEntrySource(source, `${AGENT_LABEL[agent]}: ${source.name}`)) : `${CONTENT_HEADER}${held}`
        if (material === null || prep.stopped()) return null
        const parts = asked === 'ambos' ? withMaterial(media, material) : (media ?? undefined)
        // step by step (T177): the screen of the video read with the models of the steps; the Escrita is the note's model
        const chosen: AtaModels = { model: model || uidFor(aiConfigOf(library().index.settings), AGENT_USE[agent]) || null, ...steps }
        const look = kind === 'video' && asked === 'quadros' && !isYoutube(source) ? lookAtVideo(() => mediaFileOf(source), recording, chosen, meetingStart(source)) : undefined
        const made = choiceOf(AGENT_USE[agent], model, { ...instructionOf(instruction), ...analyzedOf(kind, asked), ...(look ? { steps: stepsOf(chosen) } : {}) })
        if (typeof place === 'object' && 'replace' in place) {
          const meta = library().files.find(file => file.id === place.replace)
          if (!meta || get().jobs.some(job => job.fileId === meta.id && job.status === 'running')) return null
          await library().updateFile(meta.id, { made })
          void runOnFile(meta, agent, material, null, AGENT_LABEL[agent], source.name, undefined, recording, model, true, parts, instruction, look)
          return meta.id
        }
        const meta = await library().createFile(
          { name: `${AGENT_LABEL[agent]}: ${source.name}`, type: FILE_TYPE[agent], description: `gerado de ${source.name}`, folderId: await folderFor(source, place), parentFileId: source.id, status: 'generating', pendingExcerpt: material, origin: { input: 'text', name: source.name, storage: 'none' }, made },
          '',
        )
        void runOnFile(meta, agent, material, null, AGENT_LABEL[agent], source.name, undefined, recording, model, false, parts, instruction, look)
        return meta.id
      } catch (error) {
        prep.refuse('A geração não começou.', error)
        return null
      } finally {
        // the writing job (opened in the same turn) takes the line's place
        prep.end()
      }
    },

    generateAta: async (fileId, parts, model, chosen, place = 'home', instruction, file, analyze) => {
      const source = library().files.find(file => file.id === fileId)
      const replaced = typeof place === 'object' && 'replace' in place ? library().files.find(file => file.id === place.replace) : undefined
      // The job shows in the note being replaced, else in the recording until the new note exists.
      const at = replaced?.id ?? fileId
      // a transcription running beside it no longer holds the Ata
      if (!source || !(model || chosenParts(parts).length) || get().jobs.some(job => job.fileId === at && job.status === 'running' && job.kind !== 'transcription')) return
      // from here to the real job, a "Preparando" line shows that the click worked
      const prep = preparing(`Ata: ${source.name}`, at)
      const asked = analysisOf(mediaOf(source), analyze)
      let media: MediaParts | null
      let heard: RecordingData | undefined
      try {
        media = await entryMedia('ata', chosen?.model, asked, Boolean(file) || keptMedia(source), async () => file ?? mediaFileOf(source))
        if (prep.stopped()) return
        const needsText = !media || asked === 'ambos'
        // the transcription is needed and missing: made first, and it stays in the entrada
        if (needsText && keptMedia(source) && !(await library().openFile(fileId)).sidecar.recording?.blocks.length) await prep.around(() => get().transcribeNote(fileId))
        if (prep.stopped()) return
        heard = (await library().openFile(fileId)).sidecar.recording
        if (needsText && !heard?.blocks.length) return
      } catch (error) {
        prep.refuse('A ata não saiu.', error)
        return
      } finally {
        // the real job opens in the same turn and takes the line's place
        prep.end()
      }
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
        if (mediaOf(source) === 'video' && asked !== 'transcricao') {
          progress('Abrindo o vídeo da gravação')
          const video = file ?? (await mediaFileOf(source).catch(() => null))
          frames = video ? await openVideoFrames(video).catch(() => null) : null
        }
        const done = await buildAta({ recording: heard!, parts, model, startedAt: meetingStart(source), instruction, onProgress: progress }, { ai, frames, difference: signatureDifference, renderPrint: (image, marks, caption) => renderPrint(image, marks, caption) })
        if (done.recording !== heard) {
          await library().updateSidecar(fileId, sidecar => (sidecar.recording ? { ...sidecar, recording: { ...sidecar.recording, speakers: done.recording.speakers }, transcript: transcriptText({ ...sidecar.recording, speakers: done.recording.speakers }) } : sidecar))
          if (readsAsTranscript(source)) await library().saveContent(fileId, transcriptText(done.recording).trim())
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
        const made = choiceOf('ata', chosen?.model, { ...(!media && mediaOf(source!) === 'video' && asked !== 'transcricao' ? { steps: stepsOf(chosen) } : {}), ...(model ? { ataModel: model } : { parts: chosenParts(parts) }), ...instructionOf(instruction), ...analyzedOf(mediaOf(source!), asked) })
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

    redoTranscript: async (fileId, instruction, model) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      const recording = (await library().openFile(fileId)).sidecar.recording
      if (!recording) return
      const { job, controller } = openJob('transcription', `Refazer a transcrição: ${meta.name}`, fileId)
      try {
        patchJob(job.id, { message: 'Refazendo a transcrição' })
        const session = sessionFor('estudo', controller.signal, model)
        const redone = await redoTranscript(recording, instruction, session, library().index.settings.transcription.terms ?? '')
        await library().updateSidecar(fileId, sidecar => ({ ...sidecar, recording: redone }))
        if (readsAsTranscript(meta)) await library().saveContent(fileId, transcriptText(redone).trim())
        closeJob(job.id, 'done', 'Transcrição refeita.')
      } catch (error) {
        const cancelled = error instanceof Cancelled || controller.signal.aborted
        closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A transcrição não foi refeita.', cancelled ? null : failureText(error))
      }
    },

    generateRemaining: async (folderId, model, instruction) => {
      const { folders, files } = library()
      const pendings = remainingIn(folderId, folders, files).flatMap(file => pendingOf(file.id, model, instruction) ?? [])
      if (!pendings.length) return
      // one window for all, counting the lessons whose job already opened ("Preparando as aulas · 3 de 7")
      let opened = 0
      const started = await blocking(
        'Gerando as aulas que faltam',
        blocker =>
          Promise.all(
            pendings.map(async pending => {
              const started = await pending.start()
              blocker.progress({ done: ++opened })
              return started
            }),
          ),
        { phase: 'Preparando as aulas', total: pendings.length },
      )
      await Promise.all(started.map(item => item.generation))
    },

    regenerate: async fileId => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta) return
      if (meta.pendingExcerpt || (meta.status === 'pending' && !meta.origin)) return get().generatePending(fileId)
      const { content } = await library().openFile(fileId)
      const prompt = meta.type === 'explanation' ? PROMPTS.EXPLANATION_PROMPT : meta.type === 'meeting' ? PROMPTS.MEETING_PROMPT : PROMPTS.LESSON_PROMPT
      await runOnFile(meta, meta.type === 'explanation' ? 'explanation' : 'lesson', `# ${meta.name}\n\n${content}`, null, 'Nova versão', meta.name, prompt)
    },

    explainSelection: async (fileId, excerpt, prompt, mode, model, place) => {
      const source = library().files.find(file => file.id === fileId)
      if (!source) throw new Error('Arquivo de origem não encontrado.')
      const { content } = await library().openFile(fileId)
      // the model and the question stay with the explanation, for "Gerar de novo"
      const made = choiceOf('explicacao', model, instructionOf(prompt))
      const replaced = typeof place === 'object' && 'replace' in place ? library().files.find(file => file.id === place.replace) : undefined
      let folderId: string | null = null
      if (typeof place === 'object' && 'folderId' in place) folderId = place.folderId
      else if (place === 'home') folderId = await folderFor(source, 'home')
      else if (mode === 'context') {
        folderId = source.folderId
        if (!folderId) {
          const home = await library().createFolder({ name: source.name })
          await library().updateFile(source.id, { folderId: home.id })
          folderId = home.id
        }
      }
      if (replaced) await library().updateFile(replaced.id, { made })
      const meta =
        replaced ??
        (await library().createFile(
          { name: `${AGENT_LABEL.explanation}: ${selectionTitle(excerpt)}`, type: 'explanation', description: source.name, folderId, parentFileId: source.id, sourceExcerpt: excerpt, status: 'generating', origin: { input: 'text', name: `trecho de "${source.name}"`, storage: 'none' }, made },
          '',
        ))
      const input = selectionInput(source, content, library().files, excerpt, prompt, mode)
      void (async () => {
        await runOnFile(meta, 'explanation', input, null, 'Explicação', `trecho de "${source.name}"`, undefined, undefined, model, true)
        const saved = useLibraryStore.getState().opened[meta.id]?.content
        // replaced: the same name, the text new
        if (saved && !replaced) await library().updateFile(meta.id, { name: `${AGENT_LABEL.explanation}: ${explanationName(saved, excerpt)}` })
      })()
      return meta.id
    },

    generateFromSelection: async (fileId, excerpt, agent, model, place, instruction = '', analyze) => {
      const note = library().files.find(file => file.id === fileId)
      if (!note) return null
      const folderId = place ? place.folderId : note.folderId
      const url = linkIn(excerpt)
      if (url && youtubeId(url)) {
        // the video is an entrada of its own, inside the note; the new note is born of it, as from any YouTube entrada
        const origin: SourceMeta = { input: 'youtube', name: '', url, storage: 'none' }
        const key = sourceKey(origin)
        const known = library().files.find(file => isSourceNote(file) && !file.deletedAt && file.parentFileId === note.id && file.origin && sourceKey(file.origin) === key)
        // from the click until the "Preparando" line of the new note opens (the title read, the entrada made) the app is held in the window
        const started = await blocking(
          `${AGENT_LABEL[agent]}: ${url}`,
          async blocker => {
            const title = known ? known.name : await youtubeTitle(url)
            blocker.progress({ phase: 'Preparando' })
            const entry = known ?? (await library().createFile({ name: title, kept: 'registro', type: 'video', description: url, folderId, parentFileId: note.id, status: 'ready', origin: { ...origin, name: title } }, ''))
            return { generation: get().generateFromNote(entry.id, agent, model, { folderId }, instruction, analyze) }
          },
          { phase: 'Lendo o título do vídeo' },
        )
        return started.generation
      }
      const input: ContentInput = url ? { kind: 'link', url } : { kind: 'text', text: excerpt }
      const passage = `trecho de "${note.name}"`
      // a link's page is read; a passage is the material as it is
      const resolved = url
        ? await readInput(note.id, `${AGENT_LABEL[agent]}: ${url}`, input)
        : { content: `${CONTENT_HEADER}${excerpt.trim()}`, title: selectionTitle(excerpt), description: passage, origin: { input: 'text' as const, name: passage, sizeBytes: new Blob([excerpt.trim()]).size, mime: 'text/plain', storage: 'none' as const }, transcription: null }
      if (!resolved) return null
      // from here until its job opens (the new note made in the Drive) the app is held in the window
      return blocking(
        `${AGENT_LABEL[agent]}: ${resolved.title}`,
        async () => {
          const meta = await library().createFile(
            {
              name: `${AGENT_LABEL[agent]}: ${resolved.title}`,
              type: FILE_TYPE[agent],
              description: `gerado de ${note.name}`,
              folderId,
              parentFileId: note.id,
              status: 'generating',
              pendingExcerpt: resolved.content,
              origin: { ...resolved.origin },
              source: noteSourceOf(input, resolved, nowIso()),
              made: choiceOf(AGENT_USE[agent], model, instructionOf(instruction)),
            },
            '',
          )
          void runOnFile(meta, agent, resolved.content, resolved, AGENT_LABEL[agent], url ?? passage, undefined, undefined, model, false, undefined, instruction)
          return meta.id
        },
        { phase: 'Preparando' },
      )
    },

    turnIntoEntry: fileId => {
      const running = turning.get(fileId)
      if (running) return running
      const turn = (async (): Promise<string | null> => {
        const note = library().files.find(file => file.id === fileId)
        const origin = note && entryOriginOf(note)
        if (!note?.source || !origin) return null
        const made = entryOfSource(library().files, note)
        if (made) return made.id
        // as Novo conteúdo made it: the entrada of the same source already in the library, or a new one ("Só o registro")
        const key = sourceKey(origin)
        const text = note.source.kind === 'text' ? (note.source.text ?? '').trim() : ''
        const entry =
          library().files.find(file => isSourceNote(file) && !file.deletedAt && file.origin && sourceKey(file.origin) === key) ??
          (await library().createFile(
            {
              name: text ? note.source.title || 'Texto colado' : origin.name,
              kept: 'registro',
              type: sourceTypeOf(origin),
              description: note.source.kind === 'link' ? (note.source.url ?? '') : origin.name,
              folderId: note.folderId,
              // a note born of another: the entrada stays inside that one
              parentFileId: note.parentFileId,
              status: 'ready',
              origin,
            },
            text,
          ))
        await library().updateFile(note.id, { parentFileId: entry.id })
        return entry.id
      })()
      turning.set(fileId, turn)
      return turn.finally(() => turning.delete(fileId))
    },

    explainGaps: async (target, notes, model) => {
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
        void runOnFile(meta, 'explanation', input, null, 'Explicação', origin, undefined, undefined, model)
        ids.push(meta.id)
      }
      return ids
    },

    createQuestions: async (fileId, wrong, model, instruction) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta) return { count: 0, web: { found: 0, note: '' } }
      const { content } = await library().openFile(fileId)
      const { job, controller } = openJob('questions', wrong?.length ? `Reforço: ${meta.name}` : `Prova: ${meta.name}`, fileId)
      const activityId = await library().startActivity({ kind: 'exam', label: `${wrong?.length ? 'Reforço' : 'Prova'}: ${meta.name}`, origin: meta.name, destination: 'questões do próprio arquivo', fileId })
      try {
        patchJob(job.id, { message: 'Preparando as questões' })
        const session = sessionFor('prova', controller.signal, model)
        const { questions, web } = await generateQuestions(content, meta.name, meta.type, session, wrong, webTarget(), instruction)
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

    generateArtifact: async ({ fileId, artifact, model, instruction = '', again, replace = false }) => {
      const words = ARTIFACT_WORDS[artifact]
      const title = `${words.label}: ${library().files.find(file => file.id === fileId)?.name ?? ''}`
      const said = instruction.trim()
      const retry: Overlay = {
        kind: 'generate-artifact',
        fileId,
        artifact,
        ...(again ? { again } : {}),
        prefill: { ...(model ? { model } : {}), ...(said ? { instruction: said } : {}), ...(again && replace ? { replace } : {}) },
      }
      // a new try of the same takes the failure before it off Gerações
      set(state => ({ jobs: state.jobs.filter(job => !(job.kind === 'artifact' && job.noteId === fileId && job.title === title && job.status === 'error')) }))
      const { job, controller } = openJob('artifact', title, null, { noteId: fileId, message: words.busy, retry })
      try {
        const { content, sidecar } = await library().openFile(fileId)
        const text = sidecar.recording?.blocks.length ? transcriptText(sidecar.recording) : content
        const before = again ? artifactsOf(sidecar).find(item => item.id === again && item.kind === artifact) : undefined
        const session = sessionFor(artifact, controller.signal, model)
        const made: GenerationChoice = { ...(model ? { model } : {}), ...(said ? { instruction: said } : {}), at: nowIso() }
        // "Substituir este": same name, unless it still has the placeholder
        const kept = replace && before && !before.provisionalName ? before.name : null
        let next: Artifact
        if (artifact === 'mapa') {
          const map = await generateMap(text, session, said)
          if (!map) throw new Error(words.empty)
          next = newMapArtifact({ name: kept ?? map.name, diagram: map.diagram, made })
        } else {
          const deck = await generateCards(text, session, said)
          if (!deck.cards.length) throw new Error(words.empty)
          next = newCardsArtifact({ name: kept ?? deck.name, cards: deck.cards, made })
        }
        if (controller.signal.aborted) throw new Cancelled()
        const saved = await library().saveArtifact(fileId, next, replace && before ? before.id : undefined)
        patchJob(job.id, { open: artifact === 'mapa' ? { kind: 'mindmap', fileId, artifactId: saved.id } : { kind: 'cards', fileId, deckId: saved.id } })
        closeJob(job.id, 'done', `Pronto: “${saved.name}”.`)
        return saved
      } catch (error) {
        const cancelled = controller.signal.aborted
        closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : words.failed, cancelled ? null : failureText(error))
        throw error
      }
    },

    trackTask: (title, fileId = null) => {
      const { job } = openJob('sync', title, fileId)
      return {
        update: (message, fraction) => patchJob(job.id, { message, fraction }),
        done: message => closeJob(job.id, 'done', message),
        fail: error => closeJob(job.id, 'error', 'Não terminou', error),
        drop: () => dropJob(job.id),
      }
    },
    cancel: jobId => {
      controllers.get(jobId)?.abort()
    },

    dismiss: jobId => set(state => ({ jobs: state.jobs.filter(job => job.id !== jobId) })),
  }
})

// spec 007, história 2 (research R10b): with the structure on and the note in the App, these calls run in the account (the app itself in
// a Chromium on the server); whoever called gets the same value back. Otherwise they run here, as before.
{
  const here = useJobsStore.getState() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const routed: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const call of Object.keys(ROUTED_CALLS)) {
    const original = here[call]
    if (typeof original !== 'function') continue
    routed[call] = (...args: unknown[]) => {
      const route = routeOf(call, args)
      return route ? runOnAccount(call, args, route.fileId, route.title, () => original(...args)) : original(...args)
    }
  }
  useJobsStore.setState(routed as unknown as Partial<JobsState>)
}
