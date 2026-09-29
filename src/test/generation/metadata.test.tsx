import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

import { ReaderRow } from '@/components/library/FileRows'
import { InfoPanel } from '@/components/reader/Inspector'
import { defaultIndex, newFileMeta } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore, type NewContentRequest } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import type { FileMeta, FileSidecar, FolderMeta } from '@/types/domain'

vi.mock('@/lib/transcription', () => ({
  ENGINES: [
    { id: 'whisper', name: 'Whisper (no navegador)', where: '', limits: '' },
    { id: 'groq', name: 'Groq Whisper', where: '', limits: '' },
  ],
  transcribe: vi.fn(async () => ({ text: 'Ana: vamos lançar em maio. Bruno: eu mando a proposta.', engine: 'groq', language: 'pt', durationSeconds: 125, speakers: 2 })),
}))

const JINA_BODY = 'Title: Fotossíntese explicada\n\nMarkdown Content:\n# Fotossíntese\n\nA planta usa luz.'

const LESSON = {
  markdown: {
    elements: [
      { type: 'heading', level: 1, text: 'Fotossíntese' },
      { type: 'paragraph', text: 'A planta transforma luz em energia química usando clorofila e água.' },
      { type: 'diagram', diagramIndex: 0 },
    ],
    diagrams: [{ type: 'flowchart', hint: 'luz vira glicose' }],
  },
}

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const sources = new Map<string, Blob>()
  const repo: Repository = {
    kind: 'local',
    accountId: 'local',
    load: async () => ({ folders: [], files: [], index: defaultIndex() }),
    readContent: async id => contents.get(id) ?? '',
    readSidecar: async id => {
      const sidecar = sidecars.get(id)
      if (!sidecar) throw new Error(`missing ${id}`)
      return sidecar
    },
    saveFile: async (sidecar, content) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    removeFile: async id => {
      sidecars.delete(id)
    },
    saveFolder: async () => undefined,
    removeFolder: async () => undefined,
    saveIndex: async () => undefined,
    putSource: async (fileId, blob) => {
      sources.set(`drive-${fileId}`, blob)
      return { ref: `drive-${fileId}` } as Awaited<ReturnType<Repository['putSource']>>
    },
    getSource: async ref => sources.get(ref)!,
    removeSource: async ref => {
      sources.delete(ref)
    },
    usage: async () => ({}) as Awaited<ReturnType<Repository['usage']>>,
    fileSizes: async () => ({}),
    pullChanges: async () => ({}) as Awaited<ReturnType<Repository['pullChanges']>>,
    setConflictResolver: () => undefined,
    forget: async () => undefined,
  }
  return { repo, sidecars, contents }
}

function provider(courseReply: unknown = { is_course: false, modules: [] }) {
  return (request: CapturedRequest): Response => {
    if (request.url.startsWith('https://r.jina.ai/')) return new Response(JINA_BODY)
    const system = systemPromptOf(request)
    if (system === PROMPTS.COURSE_ANALYSIS_PROMPT) return openAiStream(JSON.stringify(courseReply))
    if (system === PROMPTS.DIAGRAM_PROMPT) return openAiStream(JSON.stringify({ nodes: [{ id: 'L', text: 'Luz' }, { id: 'G', text: 'Glicose' }], links: [{ from: 'L', to: 'G' }] }), 2, { prompt_tokens: 30, completion_tokens: 10 })
    if (system === PROMPTS.LESSON_PROMPT) return openAiStream(JSON.stringify(LESSON), 3, { prompt_tokens: 200, completion_tokens: 80 })
    if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ itens: [{ tipo: 'decisao', texto: 'Lançar em maio', citacao: 'vamos lançar em maio' }] }), 2, { prompt_tokens: 50, completion_tokens: 20 })
    if (system === PROMPTS.MINUTES_VERIFY_PROMPT) return openAiStream(JSON.stringify({ assunto: 'Lançamento', resumo: 'Data definida.', itens: [{ tipo: 'decisao', texto: 'Lançar em maio', citacao: 'vamos lançar em maio' }] }), 2, { prompt_tokens: 40, completion_tokens: 30 })
    return new Response(`unexpected ${request.url}`, { status: 500 })
  }
}

function request(overrides: Partial<NewContentRequest>): NewContentRequest {
  return { agent: 'lesson', input: { kind: 'link', url: 'https://exemplo.com/fotossintese' }, name: '', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'], ...overrides }
}

async function readyFile(id: string): Promise<FileMeta> {
  await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.id === id)?.status).toBe('ready'))
  return useLibraryStore.getState().files.find(file => file.id === id)!
}

let memory: ReturnType<typeof memoryRepository>

beforeEach(() => {
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.ai = { provider: 'llm7', baseUrl: '', apiKey: 'llm7-test-key', model: 'default' }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {} })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generation fills metadata', () => {
  it('a lesson from a site link records origin, generation and note fields', async () => {
    installFetch(provider())
    const before = Date.now()
    const id = await useJobsStore.getState().startNewContent(request({}))
    expect(id).toBeTruthy()
    const meta = await readyFile(id!)

    expect(meta.name).toBe('Fotossíntese explicada')
    expect(meta.type).toBe('class')
    expect(meta.description).toBe('https://exemplo.com/fotossintese')
    expect(meta.origin).toEqual({ input: 'url', name: 'Fotossíntese explicada', url: 'https://exemplo.com/fotossintese', storage: 'none' })

    const generation = meta.generation!
    expect(generation.provider).toBe('llm7')
    expect(generation.model).toBe('default')
    expect(Date.parse(generation.startedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(generation.durationMs).toBeGreaterThanOrEqual(0)
    expect(generation.inputTokens).toBe(230)
    expect(generation.outputTokens).toBe(90)
    expect(generation.estimatedTokens).toBe(false)
    expect(generation.transcriptionEngine).toBeUndefined()

    const content = memory.contents.get(id!)!
    expect(content).toContain('```mermaid\nflowchart TD')
    expect(meta.words).toBe(content.split(/\s+/).filter(Boolean).length)
    expect(meta.readingMinutes).toBe(1)
    expect(meta.questionCount).toBe(0)
    expect(meta.created.deviceName).toMatch(/·/)
    expect(meta.updated.deviceId).toBe(meta.created.deviceId)
    expect(Date.parse(meta.updated.at)).toBeGreaterThanOrEqual(Date.parse(meta.created.at))
    expect(meta.pendingExcerpt).toBeNull()

    const job = useJobsStore.getState().jobs.find(item => item.fileId === id)!
    expect(job.status).toBe('done')
    const activity = useLibraryStore.getState().index.activities.find(item => item.fileId === id)!
    expect(activity).toMatchObject({ kind: 'lesson', origin: 'https://exemplo.com/fotossintese', destination: 'Biblioteca (raiz)', status: 'done' })
  })

  it('a meeting recording records duration, stored source, transcription engine and language', async () => {
    installFetch(provider())
    const file = new NodeFile([new Uint8Array(2048)], 'reuniao.webm', { type: 'audio/webm' }) as unknown as File
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file }, storage: 'drive' }))
    const meta = await readyFile(id!)

    expect(meta.type).toBe('meeting')
    expect(meta.name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2} - Lançamento$/)
    expect(meta.origin).toEqual({ input: 'recording', name: 'reuniao.webm', sizeBytes: 2048, mime: 'audio/webm', durationSeconds: 125, storage: 'drive', storedFileId: `drive-${id}`, expiresAt: null })
    expect(meta.generation).toMatchObject({ provider: 'llm7', model: 'default', inputTokens: 90, outputTokens: 50, estimatedTokens: false, transcriptionEngine: 'groq', language: 'pt' })
    expect(memory.contents.get(id!)).toContain('## Decisões\n- Lançar em maio')
  })

  it('keeps the meeting transcription next to the note and offers it for download in the note panel', async () => {
    installFetch(provider())
    const file = new NodeFile([new Uint8Array(2048)], 'reuniao.webm', { type: 'audio/webm' }) as unknown as File
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file }, storage: 'none' }))
    await readyFile(id!)
    expect(memory.sidecars.get(id!)?.transcript).toBe('Ana: vamos lançar em maio. Bruno: eu mando a proposta.')
    render(
      <MemoryRouter>
        <InfoPanel fileId={id!} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'Baixar a transcrição' })).toBeInTheDocument()
  })

  it('a recording whose source could not be stored becomes a pending note with the transcript kept for a retry', async () => {
    installFetch(provider())
    memory.repo.putSource = async () => {
      throw new Error('Failed to fetch')
    }
    const file = new NodeFile([new Uint8Array(2048)], 'reuniao.webm', { type: 'audio/webm' }) as unknown as File
    expect(await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file }, storage: 'drive' }))).toBeNull()

    const meta = useLibraryStore.getState().files[0]
    expect(meta).toMatchObject({ status: 'pending', origin: { storage: 'none' } })
    expect(meta.pendingExcerpt).toContain('vamos lançar em maio')
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'error' })
    render(
      <MemoryRouter>
        <ReaderRow file={meta} showWhere={false} />
      </MemoryRouter>,
    )
    expect(screen.getByText('pendente · gerar agora')).toBeInTheDocument()
    expect(screen.queryByText('gerando…')).not.toBeInTheDocument()
  })

  it('a lesson from a web link has no transcription to download', async () => {
    installFetch(provider())
    const id = await useJobsStore.getState().startNewContent(request({}))
    await readyFile(id!)
    expect(memory.sidecars.get(id!)?.transcript).toBeUndefined()
    render(
      <MemoryRouter>
        <InfoPanel fileId={id!} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('De onde veio')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Baixar a transcrição' })).not.toBeInTheDocument()
  })

  it('questions update the question count', async () => {
    installFetch(provider())
    const id = await useJobsStore.getState().startNewContent(request({}))
    await readyFile(id!)
    installFetch(request => {
      const system = systemPromptOf(request)
      if (system.startsWith(PROMPTS.EXAM_PROMPT)) return openAiStream(JSON.stringify({ questions: [{ tipo: 'certo_errado', enunciado: 'A luz participa?', certo: true, explicacao: 'sim' }, { tipo: 'ordenar', enunciado: 'Ordene', passos: ['a', 'b', 'c'], explicacao: 'e' }] }))
      if (system === PROMPTS.EXAM_REVIEW_PROMPT) return openAiStream('{"vereditos":[]}')
      return openAiStream('## Resumo')
    })
    expect(await useJobsStore.getState().createQuestions(id!)).toBe(2)
    expect(useLibraryStore.getState().files.find(file => file.id === id)!.questionCount).toBe(2)
  })
})

describe('course detection builds the hierarchy', () => {
  it('a course proposal becomes course folder, module folders and pending lessons', async () => {
    const material = '# Fotossíntese explicada\n\n# Fotossíntese\n\nA planta usa luz.'
    installFetch(
      provider({
        is_course: true,
        name: 'Curso de Botânica',
        description: 'Tudo sobre plantas',
        modules: [
          { title: 'Módulo 1', covers: 'luz', lessons: [{ title: 'Aula 1', covers: 'luz', start: '# Fotossíntese\n\nA planta', end: 'usa luz.' }, { title: 'Aula 2', covers: 'água' }] },
          { title: 'Módulo 2', covers: 'solo', start: 'A planta' },
        ],
      }),
    )
    expect(await useJobsStore.getState().startNewContent(request({}))).toBeNull()
    const proposal = useJobsStore.getState().proposals[0]
    expect(proposal.analysis).toMatchObject({ isCourse: true, name: 'Curso de Botânica', lessonCount: 3 })

    const rootId = await useJobsStore.getState().acceptCourse(proposal, null)
    const { folders, files } = useLibraryStore.getState()
    const root = folders.find(folder => folder.id === rootId) as FolderMeta
    expect(root).toMatchObject({ name: 'Curso de Botânica', isCourse: true, courseOrigin: 'https://exemplo.com/fotossintese', courseDescription: 'Tudo sobre plantas', courseMaterial: material })
    const moduleOne = folders.find(folder => folder.name === 'Módulo 1')!
    expect(moduleOne.parentId).toBe(rootId)
    expect(folders.find(folder => folder.name === 'Módulo 2')).toBeUndefined()
    const byName = Object.fromEntries(files.map(file => [file.name, file]))
    expect(byName['Aula 1']).toMatchObject({ folderId: moduleOne.id, type: 'class', position: 0, pendingExcerpt: '# Fotossíntese\n\nA planta usa luz.' })
    expect(byName['Aula 2']).toMatchObject({ folderId: moduleOne.id, position: 1 })
    expect(byName['Módulo 2']).toMatchObject({ folderId: rootId, status: 'pending', position: 1 })
    for (const file of files) expect(file.origin?.url).toBe('https://exemplo.com/fotossintese')
    await readyFile(byName['Aula 1'].id)
    await readyFile(byName['Aula 2'].id)
    expect(useLibraryStore.getState().files.find(file => file.name === 'Módulo 2')!.status).toBe('pending')
  })
})

describe('Inspector info panel', () => {
  function renderInfo(meta: FileMeta) {
    useLibraryStore.setState({ files: [meta] })
    return render(
      <MemoryRouter>
        <InfoPanel fileId={meta.id} />
      </MemoryRouter>,
    )
  }

  it('a note generated from a link links back to it in "De onde veio" and "Origem"', async () => {
    installFetch(provider())
    const id = await useJobsStore.getState().startNewContent(request({}))
    await readyFile(id!)
    render(
      <MemoryRouter>
        <InfoPanel fileId={id!} />
      </MemoryRouter>,
    )
    const fromSection = screen.getByRole('heading', { name: 'De onde veio' }).parentElement!
    const back = within(fromSection).getByRole('link', { name: 'Fotossíntese explicada' })
    expect(back).toHaveAttribute('href', 'https://exemplo.com/fotossintese')
    expect(back).toHaveAttribute('target', '_blank')
    expect(back).toHaveAttribute('rel', 'noopener noreferrer')
    expect(within(fromSection).getByText(/Link:/)).toBeInTheDocument()

    const originSection = screen.getByRole('heading', { name: 'Origem' }).parentElement!
    expect(within(originSection).getByText('Link')).toBeInTheDocument()
    expect(within(originSection).getByText('Endereço')).toBeInTheDocument()
    expect(within(originSection).getByRole('link', { name: 'https://exemplo.com/fotossintese' })).toHaveAttribute('href', 'https://exemplo.com/fotossintese')
    expect(within(originSection).getByText('Não guardada')).toBeInTheDocument()

    const generationSection = screen.getByRole('heading', { name: 'Geração' }).parentElement!
    expect(within(generationSection).getByText('LLM7 · default')).toBeInTheDocument()
    expect(within(generationSection).getByText(/320 \(230 de entrada, 90 de saída\)/)).toBeInTheDocument()
    expect(within(generationSection).getByText('o do material')).toBeInTheDocument()

    const noteSection = screen.getByRole('heading', { name: 'Nota' }).parentElement!
    for (const label of ['Criada', 'Alterada', 'Palavras', 'Leitura', 'Questões', 'Tags', 'Pasta']) expect(within(noteSection).getByText(label)).toBeInTheDocument()
    expect(within(noteSection).getByText('1 min')).toBeInTheDocument()
    expect(within(noteSection).getByText('Biblioteca')).toBeInTheDocument()
  })

  it('shows size, type, duration, storage with expiry, transcription and language', () => {
    const meta = newFileMeta({
      name: 'Ata',
      type: 'meeting',
      tags: ['trabalho'],
      origin: { input: 'recording', name: 'reuniao.webm', sizeBytes: 2 * 1024 * 1024, mime: 'audio/webm', durationSeconds: 3725, storage: 'litterbox', storedUrl: 'https://litter.catbox.moe/x.webm', expiresAt: '2999-01-02T03:04:00.000Z' },
      generation: { provider: 'anthropic', model: 'claude-x', startedAt: '2024-05-01T12:00:00.000Z', durationMs: 65000, inputTokens: 1000, outputTokens: 234, estimatedTokens: true, transcriptionEngine: 'groq', language: 'pt' },
      words: 1500,
      readingMinutes: 8,
      questionCount: 12,
    })
    renderInfo(meta)
    expect(screen.getByText('Gravação:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('2 MB')).toBeInTheDocument()
    expect(screen.getByText('audio/webm')).toBeInTheDocument()
    expect(screen.getByText('1 h 2 min')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Litterbox · até / })).toHaveAttribute('href', 'https://litter.catbox.moe/x.webm')
    expect(screen.getByText('Anthropic · claude-x')).toBeInTheDocument()
    expect(screen.getByText('1 min 5 s')).toBeInTheDocument()
    expect(screen.getByText(/1\.234 \(1\.000 de entrada, 234 de saída\) · estimado/)).toBeInTheDocument()
    expect(screen.getByText('Groq Whisper')).toBeInTheDocument()
    expect(screen.getByText('pt')).toBeInTheDocument()
    expect(screen.getByText('1.500')).toBeInTheDocument()
    expect(screen.getByText('8 min')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tirar a tag trabalho' })).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(meta.created.deviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThanOrEqual(2)
  })

  it('marks an expired stored source', () => {
    renderInfo(newFileMeta({ name: 'x', type: 'class', origin: { input: 'file', name: 'a.pdf', storage: 'tmpfiles', storedUrl: 'https://tmpfiles.org/a', expiresAt: '2000-01-01T00:00:00.000Z' } }))
    expect(screen.getByText(/tmpfiles · até .* \(expirou\)/)).toBeInTheDocument()
  })
})
