import { create } from 'zustand'

import type { CourseAnalysis, FileMeta, FileType, GenerationMeta, SourceMeta, SourceStorage, StoredQuestion } from '@/types/domain'
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
import { GenerationSession } from '@/lib/generation/session'
import { newId } from '@/lib/ids'
import { storeSource } from '@/lib/storage/source-storage'
import { useLibraryStore } from '@/stores/library'

export type Agent = 'lesson' | 'explanation' | 'meeting' | 'reading'

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface Job {
  id: string
  kind: 'generation' | 'questions' | 'course' | 'transcription'
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
  acceptCourse(proposal: CourseProposal, folderId: string | null): Promise<string>
  declineCourse(proposal: CourseProposal): Promise<string>
  generatePending(fileId: string): Promise<void>
  generateRemaining(folderId: string): Promise<void>
  regenerate(fileId: string): Promise<void>
  explainSelection(fileId: string, excerpt: string, prompt: string, mode: 'concept' | 'context'): Promise<string>
  createQuestions(fileId: string, wrong?: WrongQuestion[]): Promise<number>
  readingExam(content: string, title: string): Promise<StoredQuestion[]>
  cancel(jobId: string): void
  dismiss(jobId: string): void
}

const controllers = new Map<string, AbortController>()

const AGENT_PROMPTS: Record<Exclude<Agent, 'reading' | 'meeting'>, string> = {
  lesson: PROMPTS.LESSON_PROMPT,
  explanation: PROMPTS.EXPLANATION_PROMPT,
}

const FILE_TYPE: Record<Agent, FileType> = { lesson: 'class', explanation: 'explanation', meeting: 'meeting', reading: 'reading' }

const AGENT_LABEL: Record<Agent, string> = { lesson: 'Aula', explanation: 'Explicação', meeting: 'Ata', reading: 'Leitura' }

function library() {
  return useLibraryStore.getState()
}

function generationMeta(session: GenerationSession, resolved: ResolvedInput | null): GenerationMeta {
  const usage = session.usage()
  return {
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
  ): Promise<{ markdown: string; name?: string }> => {
    if (agent === 'meeting' && !systemPrompt) {
      patchJob(jobId, { message: 'Escrevendo a ata (duas passadas)' })
      const { markdown, subject } = await buildMinutes(content, session, liveEmit(fileId))
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
  ): Promise<void> => {
    const { job, controller } = openJob('generation', meta.name, meta.id)
    const activityId = await library().startActivity({ kind: agent, label: `${label}: ${meta.name}`, origin, destination: destinationName(meta.folderId), fileId: meta.id })
    await library().updateFile(meta.id, { status: 'generating' })
    const session = new GenerationSession(library().index.settings.ai, controller.signal)
    try {
      const { markdown, name } = await writeDocument(meta.id, agent, content, session, job.id, systemPrompt)
      patchJob(job.id, { message: 'Salvando' })
      await library().saveContent(meta.id, markdown, { status: 'ready', pendingExcerpt: null, generation: generationMeta(session, resolved), ...(name ? { name } : {}) })
      closeJob(job.id, 'done', 'Pronta e salva na Biblioteca.')
      await library().finishActivity(activityId, 'done', 'Pronta e salva na Biblioteca.')
    } catch (error) {
      const cancelled = error instanceof Cancelled || controller.signal.aborted
      await library().updateFile(meta.id, { status: 'pending', pendingExcerpt: meta.pendingExcerpt ?? content }).catch(() => undefined)
      closeJob(job.id, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : 'A geração falhou.', cancelled ? null : failureText(error))
      await library().finishActivity(activityId, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelado por você.' : failureText(error))
    } finally {
      dropLive(meta.id)
    }
  }

  const createForRequest = async (request: NewContentRequest, resolved: ResolvedInput, agent: Agent): Promise<FileMeta> => {
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
    if (request.input.kind === 'file' || request.input.kind === 'recording') {
      try {
        const stored = await storeSource(request.input.file, request.storage, meta.id, library().repo!, request.litterboxTime)
        await library().updateFile(meta.id, { origin: { ...resolved.origin, ...stored } as SourceMeta })
      } catch (error) {
        await library().updateFile(meta.id, { origin: { ...resolved.origin, storage: 'none' } })
        throw new Error(`A aula não foi gerada porque a fonte não pôde ser guardada: ${failureText(error)}`)
      }
    }
    return meta
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
        resolved = await resolveInput(request.input, library().index.settings, request.prompt, (message, fraction) => patchJob(job.id, { message, fraction: fraction ?? null }), controller.signal)
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
      if (agent === 'reading') return meta.id
      void runOnFile(meta, agent, resolved.content, resolved, AGENT_LABEL[agent], resolved.origin.url ?? resolved.origin.name)
      return meta.id
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

    cancel: jobId => {
      controllers.get(jobId)?.abort()
    },

    dismiss: jobId => set(state => ({ jobs: state.jobs.filter(job => job.id !== jobId) })),
  }
})
