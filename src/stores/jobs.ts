import { create } from 'zustand'

import type { CourseAnalysis, FileMeta, FileType, GenerationMeta, RecordingData, RecordingMark, SourceMeta, SourceStorage, StageTime, StoredQuestion } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import { storedFromRaw } from '@/lib/exam'
import { analyzeCourse } from '@/lib/generation/course'
import { courseLessonInput, courseOf, explanationName, selectionInput, selectionTitle } from '@/lib/generation/course-lesson'
import { type ContentInput, resolveInput, type ResolvedInput } from '@/lib/generation/inputs'
import { buildMinutes, minutesFileName } from '@/lib/generation/minutes'
import { generateContent, type GenerationEvent } from '@/lib/generation/pipeline'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { generateQuestions, generateReadingExam, type WrongQuestion } from '@/lib/generation/questions'
import { lookAtScreen, visionSettingsOf } from '@/lib/generation/frames'
import { polishTranscript } from '@/lib/generation/polish'
import { redoTranscript } from '@/lib/generation/reviewer'
import { GenerationSession } from '@/lib/generation/session'
import { suggestTags } from '@/lib/generation/tags'
import { newId } from '@/lib/ids'
import { recordingName } from '@/lib/file-types'
import { downloadStoredSource, storeSource } from '@/lib/storage/source-storage'
import { keepLocalMedia, linkLocalMedia, readLocalMedia } from '@/lib/recording/media-library'
import { transcribe } from '@/lib/transcription'
import { StageClock } from '@/lib/transcription/types'
import { transcriptText } from '@/lib/transcription/export'
import { useLibraryStore } from '@/stores/library'

export type Agent = 'lesson' | 'explanation' | 'meeting' | 'reading'

export type SecondTabAgent = 'meeting' | 'lesson'

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

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
  storage: SourceStorage
  litterboxTime: LitterboxTime
  marks?: RecordingMark[]
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
  transcribeNote(fileId: string, source?: File): Promise<void>
  acceptCourse(proposal: CourseProposal, folderId: string | null): Promise<string>
  declineCourse(proposal: CourseProposal): Promise<string>
  generatePending(fileId: string): Promise<void>
  generateSecondTab(fileId: string, agent: SecondTabAgent): Promise<void>
  redoTranscript(fileId: string, instruction: string): Promise<void>
  generateFromNote(fileId: string, agent: SecondTabAgent): Promise<string | null>
  suggestTags(fileId: string): Promise<void>
  generateRemaining(folderId: string): Promise<void>
  regenerate(fileId: string): Promise<void>
  explainSelection(fileId: string, excerpt: string, prompt: string, mode: 'concept' | 'context'): Promise<string>
  explainGaps(target: { fileId: string | null; folderId: string | null }, notes: { title: string; excerpt: string }[]): Promise<string[]>
  createQuestions(fileId: string, wrong?: WrongQuestion[]): Promise<number>
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

async function mediaFileOf(meta: FileMeta): Promise<File> {
  const origin = meta.origin!
  const local = library().localMedia.find(item => item.fileIds.includes(meta.id))
  if (local) return readLocalMedia(local)
  if (!library().repo || !(origin.storedFileId || origin.storedUrl)) throw new Error('A mídia desta nota não está mais guardada: não dá para transcrever.')
  const stored = await downloadStoredSource(origin, library().repo!)
  const blob = typeof stored === 'string' ? await (await fetch(stored)).blob() : stored
  return new File([blob], origin.name, { type: origin.mime || blob.type })
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
  ): Promise<{ markdown: string; name?: string }> => {
    if (agent === 'meeting' && !systemPrompt) {
      patchJob(jobId, { message: 'Escrevendo a ata (duas passadas)' })
      const { markdown, subject } = await buildMinutes(content, session, liveEmit(fileId), recording)
      return { markdown, name: minutesFileName(subject) }
    }
    patchJob(jobId, { message: agent === 'lesson' ? 'Escrevendo a aula' : 'Escrevendo a explicação' })
    const markdown = await generateContent(content, systemPrompt ?? AGENT_PROMPTS[agent as 'lesson' | 'explanation'], session, event => {
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
  ): Promise<void> => {
    const { job, controller } = openJob('generation', meta.name, meta.id)
    const activityId = await library().startActivity({ kind: agent, label: `${label}: ${meta.name}`, origin, destination: destinationName(meta.folderId), fileId: meta.id })
    await library().updateFile(meta.id, { status: 'generating' })
    const session = new GenerationSession(library().index.settings.ai, controller.signal)
    try {
      const recording = heard ?? resolved?.transcription?.recording ?? (await library().openFile(meta.id).catch(() => null))?.sidecar.recording
      const clock = new StageClock()
      clock.add(resolved?.transcription?.stages)
      const { markdown, name } = await clock.run('Escrever', () => writeDocument(meta.id, agent, content, session, job.id, systemPrompt, recording))
      patchJob(job.id, { message: 'Salvando' })
      await library().saveContent(meta.id, markdown, { status: 'ready', pendingExcerpt: null, generation: generationMeta(session, resolved, clock.stages), ...(name ? { name } : {}) })
      closeJob(job.id, 'done', 'Pronta e salva na Biblioteca.')
      await library().finishActivity(activityId, 'done', 'Pronta e salva na Biblioteca.')
      void suggestTagsFor(meta.id, session)
    } catch (error) {
      const cancelled = error instanceof Cancelled || controller.signal.aborted
      await library().updateFile(meta.id, { status: 'pending', pendingExcerpt: meta.pendingExcerpt ?? content }).catch(() => undefined)
      closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A geração falhou.', cancelled ? null : failureText(error))
      await library().finishActivity(activityId, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : failureText(error))
    } finally {
      dropLive(meta.id)
    }
  }

  const suggestTagsFor = async (fileId: string, session?: GenerationSession): Promise<void> => {
    const meta = library().files.find(file => file.id === fileId)
    if (!meta) return
    const { content, sidecar } = await library().openFile(fileId)
    const text = content.trim() || (sidecar.recording ? transcriptText(sidecar.recording) : '')
    const known = [...new Set(library().files.flatMap(file => file.tags))]
    const suggested = (await suggestTags(text, known, session ?? new GenerationSession(library().index.settings.ai)).catch(() => [] as string[])).filter(tag => !meta.tags.includes(tag))
    if (suggested.length) await library().updateFile(fileId, { suggestedTags: suggested })
  }

  const createForRequest = async (request: NewContentRequest, resolved: ResolvedInput, agent: Agent): Promise<FileMeta> => {
    const meta = await createNote(request, resolved, agent)
    await keepSource(request, resolved, meta)
    return meta
  }

  const createNote = async (request: NewContentRequest, resolved: ResolvedInput, agent: Agent): Promise<FileMeta> => {
    const meta = await library().createFile(
      {
        name: request.name.trim() || resolved.title || AGENT_LABEL[agent],
        type: FILE_TYPE[agent],
        description: request.description.trim() || resolved.description,
        folderId: request.folderId,
        status: agent === 'reading' ? 'ready' : 'generating',
        pendingExcerpt: agent === 'reading' ? null : resolved.content,
        origin: resolved.origin,
      },
      agent === 'reading' ? resolved.content.replace(/^# Conteúdo\n\n/, '') : '',
    )
    if (resolved.transcription) {
      const { text: transcript, recording } = resolved.transcription
      await library()
        .updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript, ...(recording ? { recording } : {}) }))
        .catch(() => undefined)
    }
    if (request.input.kind === 'file' && resolved.transcription) await keepLocalMedia(request.input.file, meta.id, resolved.transcription.durationSeconds).catch(() => undefined)
    return meta
  }

  const keepSource = async (request: NewContentRequest, resolved: ResolvedInput, meta: FileMeta): Promise<void> => {
    if (request.input.kind === 'file' || request.input.kind === 'recording') {
      try {
        const keeping = new StageClock()
        const file = request.input.file
        const stored = await keeping.run('Guardar a mídia', () => storeSource(file, request.storage, meta.id, library().repo!, request.litterboxTime))
        resolved.transcription?.stages?.push(...keeping.stages)
        await library().updateFile(meta.id, { origin: { ...resolved.origin, ...stored } as SourceMeta })
      } catch (error) {
        await library().updateFile(meta.id, { status: 'pending', origin: { ...resolved.origin, storage: 'none' } })
        throw new Error(`A aula não foi gerada porque a fonte não pôde ser guardada: ${failureText(error)}`)
      }
    }
  }

  const finishEarlyNote = async (request: NewContentRequest, read: ResolvedInput, meta: FileMeta, agent: Agent, job: Job, signal: AbortSignal): Promise<void> => {
    const progress = (message: string, fraction?: number) => patchJob(job.id, { message, fraction: fraction ?? null })
    try {
      await keepSource(request, read, meta)
      const resolved = await polished(read, request.marks ?? [], progress, signal, request.input.kind === 'recording' || request.input.kind === 'file' ? request.input.file : null)
      const { text: transcript, recording } = resolved.transcription!
      await library().updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript, ...(recording ? { recording } : {}) }))
      const name = request.name.trim() || resolved.title || meta.name
      const description = request.description.trim() || resolved.description
      if (agent === 'reading') {
        const polishing = polishSessions.get(resolved.transcription!)
        await library().saveContent(meta.id, resolved.content.replace(/^# Conteúdo\n\n/, ''), { name, description, pendingExcerpt: null, ...(polishing ? { generation: generationMeta(polishing, resolved, resolved.transcription?.stages) } : {}) })
        closeJob(job.id, 'done', 'Material lido.')
        return
      }
      await library().updateFile(meta.id, { name, description, pendingExcerpt: resolved.content })
      closeJob(job.id, 'done', 'Material lido.')
      const fresh = library().files.find(file => file.id === meta.id) ?? { ...meta, name, description }
      await runOnFile(fresh, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name)
    } catch (error) {
      const cancelled = signal.aborted
      await library().updateFile(meta.id, { status: 'pending' }).catch(() => undefined)
      closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A nota não terminou.', cancelled ? null : failureText(error))
    }
  }

  const resolveRecording = async (file: File, progress: (message: string, fraction?: number) => void, signal: AbortSignal): Promise<ResolvedInput> => {
    progress('Transcrevendo a gravação')
    const transcription = await transcribe(file, library().index.settings.transcription, progress, signal, { microphoneOnLeft: true })
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
    const session = new GenerationSession(library().index.settings.ai, signal)
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

  return {
    jobs: [],
    live: {},
    proposals: [],

    startNewContent: async (request, onJob) => {
      const agent: Agent = request.input.kind === 'topic' && request.agent === 'lesson' ? 'explanation' : request.agent
      const { job, controller } = openJob('generation', request.name || AGENT_LABEL[agent], null)
      onJob?.(job.id)
      let resolved: ResolvedInput
      try {
        const progress = (message: string, fraction?: number) => patchJob(job.id, { message, fraction: fraction ?? null })
        const read = request.input.kind === 'recording' ? await resolveRecording(request.input.file, progress, controller.signal) : await resolveInput(request.input, library().index.settings, request.prompt, progress, controller.signal)
        if (read.transcription?.recording && agent !== 'lesson') {
          patchJob(job.id, { title: request.name || read.title })
          const meta = await createNote(request, read, agent)
          patchJob(job.id, { fileId: meta.id })
          void finishEarlyNote(request, read, meta, agent, job, controller.signal)
          return meta.id
        }
        resolved = await polished(read, request.marks ?? [], progress, controller.signal, request.input.kind === 'recording' || request.input.kind === 'file' ? request.input.file : null)
      } catch (error) {
        const cancelled = controller.signal.aborted
        closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'Não deu pra ler o material.', cancelled ? null : failureText(error))
        return null
      }
      patchJob(job.id, { title: request.name || resolved.title })

      if (agent === 'lesson') {
        patchJob(job.id, { message: 'Vendo se cabe numa aula ou se é um curso' })
        try {
          const analysis = await analyzeCourse(resolved.content, new GenerationSession(library().index.settings.ai, controller.signal))
          if (analysis.isCourse) {
            closeJob(job.id, 'done', 'Virou proposta de curso.')
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
      void runOnFile(meta, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name)
      return meta.id
    },

    saveRecording: async request => {
      const { file } = request
      const origin: SourceMeta = { input: 'recording', name: file.name, sizeBytes: file.size, mime: file.type || 'application/octet-stream', durationSeconds: request.durationSeconds, storage: 'none' }
      const meta = await library().createFile({ name: recordingName(file.name), type: 'reading', description: '', folderId: request.folderId, status: 'ready', pendingExcerpt: null, origin }, '')
      if (request.marks.length) await library().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: { blocks: [], speakers: [], marks: request.marks } }))
      if (request.storedName) await linkLocalMedia(request.storedName, meta.id).catch(() => undefined)
      if (request.storage !== 'none') {
        void storeSource(file, request.storage, meta.id, library().repo!, request.litterboxTime)
          .then(stored => library().updateFile(meta.id, { origin: { ...origin, ...stored } as SourceMeta }))
          .catch(error => get().trackTask(`Guardar a mídia: ${meta.name}`).fail(failureText(error)))
      }
      if (request.transcribe) void get().transcribeNote(meta.id, file)
      return meta.id
    },

    transcribeNote: async (fileId, source) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta?.origin || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      const origin = meta.origin
      const { job, controller } = openJob('transcription', meta.name, fileId)
      const progress = (message: string, fraction?: number) => patchJob(job.id, { message, fraction: fraction ?? null })
      try {
        progress('Abrindo a mídia')
        const file = source ?? (await mediaFileOf(meta))
        progress('Transcrevendo a gravação')
        const transcription = await transcribe(file, library().index.settings.transcription, progress, controller.signal, { microphoneOnLeft: origin.input === 'recording' })
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
      const root = await library().createFolder({
        name: analysis.name || 'Curso',
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
              { name: plan.title, type: 'class', folderId: parent.id, description: plan.covers, pendingExcerpt: plan.excerpt || null, status: 'pending', position: module.lessons.length ? position : index, origin: resolved.origin },
              '',
            ),
          )
        }
        if (index === 0) firstModule.push(...created)
      }
      for (const file of firstModule) void get().generatePending(file.id)
      return root.id
    },

    declineCourse: async proposal => {
      set(state => ({ proposals: state.proposals.filter(item => item !== proposal) }))
      const meta = await createForRequest(proposal.request, proposal.resolved, 'lesson')
      void runOnFile(meta, 'lesson', proposal.resolved.content, proposal.resolved, 'Aula', proposal.resolved.origin.url ?? proposal.resolved.origin.name)
      return meta.id
    },

    generatePending: async fileId => {
      const { files, folders } = library()
      const meta = files.find(file => file.id === fileId)
      if (!meta || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      if (courseOf(folders, meta.folderId)) {
        await runOnFile(meta, 'lesson', courseLessonInput(meta, folders, files), null, 'Aula do curso', meta.description || meta.name)
        return
      }
      const agent: Agent = meta.type === 'explanation' ? 'explanation' : meta.type === 'meeting' ? 'meeting' : 'lesson'
      await runOnFile(meta, agent, meta.pendingExcerpt ?? `# ${meta.name}`, null, 'Nova tentativa', meta.origin?.url ?? meta.origin?.name ?? meta.name)
    },

    generateSecondTab: async (fileId, agent) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta || get().jobs.some(job => job.fileId === fileId && job.status === 'running')) return
      const recording = (await library().openFile(fileId)).sidecar.recording
      if (!recording) return
      await library().updateFile(fileId, { type: FILE_TYPE[agent] })
      await runOnFile({ ...meta, type: FILE_TYPE[agent] }, agent, `${CONTENT_HEADER}${transcriptText(recording)}`, null, AGENT_LABEL[agent], meta.origin?.name ?? meta.name)
    },

    generateFromNote: async (fileId, agent) => {
      const source = library().files.find(file => file.id === fileId)
      if (!source) return null
      const { content, sidecar } = await library().openFile(fileId)
      const recording = sidecar.recording?.blocks.length ? sidecar.recording : undefined
      if (recording) {
        void get().generateSecondTab(fileId, agent)
        return fileId
      }
      const material = `${CONTENT_HEADER}${recording ? transcriptText(recording) : content}`
      if (!material.replace(CONTENT_HEADER, '').trim()) return null
      const meta = await library().createFile(
        { name: `${AGENT_LABEL[agent]}: ${source.name}`, type: FILE_TYPE[agent], description: `gerado de ${source.name}`, folderId: source.folderId, parentFileId: source.id, status: 'generating', pendingExcerpt: material, origin: { input: 'text', name: source.name, storage: 'none' } },
        '',
      )
      void runOnFile(meta, agent, material, null, AGENT_LABEL[agent], source.name, undefined, recording)
      return meta.id
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
        const session = new GenerationSession(library().index.settings.ai, controller.signal)
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

    explainSelection: async (fileId, excerpt, prompt, mode) => {
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
        await runOnFile(meta, 'explanation', input, null, 'Explicação', `trecho de "${source.name}"`)
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

    createQuestions: async (fileId, wrong) => {
      const meta = library().files.find(file => file.id === fileId)
      if (!meta) return 0
      const { content } = await library().openFile(fileId)
      const { job, controller } = openJob('questions', wrong?.length ? `Reforço: ${meta.name}` : `Prova: ${meta.name}`, fileId)
      const activityId = await library().startActivity({ kind: 'exam', label: `${wrong?.length ? 'Reforço' : 'Prova'}: ${meta.name}`, origin: meta.name, destination: 'questões do próprio arquivo', fileId })
      try {
        patchJob(job.id, { message: 'Preparando as questões' })
        const session = new GenerationSession(library().index.settings.ai, controller.signal)
        const { questions } = await generateQuestions(content, meta.name, meta.type, session, wrong)
        if (!questions.length) throw new Error('A IA não devolveu nenhuma questão válida. Tente de novo.')
        await library().setQuestions(fileId, questions.map(storedFromRaw), Boolean(wrong?.length))
        closeJob(job.id, 'done', `${questions.length} questões geradas.`)
        await library().finishActivity(activityId, 'done', `${questions.length} questões geradas.`)
        return questions.length
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
        const session = new GenerationSession(library().index.settings.ai, controller.signal)
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
