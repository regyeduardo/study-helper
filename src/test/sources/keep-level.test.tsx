import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'

import type { FileMeta, FileSidecar } from '@/types/domain'
import { defaultIndex } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { transcribe } from '@/lib/transcription'
import { defaultKeep, type NewContentRequest, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'

// The level of what stays of the source (T044/T051): "Sem rastro", "Só o registro", "Registro e arquivo". The choice in the window is a screen of its own.

const { heard } = vi.hoisted(() => ({
  heard: {
    blocks: [
      { speaker: 'mic', start: 0, end: 3, text: 'Vamos lançar em maio?' },
      { speaker: 'speaker_0', start: 4, end: 8, text: 'Sim, eu mando a proposta.' },
    ],
    speakers: [
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_0', name: 'Falante 2', suggested: false },
    ],
    marks: [],
  },
}))

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({ text: 'Você: vamos lançar em maio?', engine: 'groq', language: 'pt', durationSeconds: 8, speakers: 2, recording: heard })),
}))

const JINA_BODY = 'Title: Fotossíntese explicada\n\nMarkdown Content:\n# Fotossíntese\n\nA planta usa luz.'
const LESSON = { markdown: { elements: [{ type: 'heading', level: 1, text: 'Fotossíntese' }, { type: 'paragraph', text: 'A planta transforma luz em energia.' }], diagrams: [] } }

function provider(request: CapturedRequest): Response {
  if (request.url.startsWith('https://r.jina.ai/')) return new Response(JINA_BODY)
  const system = systemPromptOf(request)
  if (system === PROMPTS.COURSE_ANALYSIS_PROMPT) return openAiStream(JSON.stringify({ is_course: false, modules: [] }))
  if (system === PROMPTS.LESSON_PROMPT || system === PROMPTS.EXPLANATION_PROMPT) return openAiStream(JSON.stringify(LESSON))
  if (system === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Lançamento em maio', nomes: [], correcoes: [] }))
  if (system === PROMPTS.SPEAKER_NAMES_PROMPT) return openAiStream(JSON.stringify({ nomes: [] }))
  if (system === PROMPTS.TITLE_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Lançamento em maio' }))
  if (system === PROMPTS.TRANSCRIPT_REVIEW_PROMPT) return openAiStream(JSON.stringify({ correcoes: [] }))
  if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ assunto: 'Lançamento', temas: [{ tema: 'Data', pontos: [{ texto: 'Lançar em maio', citacao: 'Vamos lançar em maio', hora: '00:00' }] }], passos: [] }))
  if (system.startsWith('Você sugere')) return openAiStream('{"tags":[]}')
  return openAiStream('{}')
}

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const putSource = vi.fn(async (fileId: string, _blob: Blob, _name: string) => ({ ref: `drive-${fileId}` }))
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => {
      const sidecar = sidecars.get(id)
      if (!sidecar) throw new Error(`missing ${id}`)
      return sidecar
    },
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    saveFolder: async () => undefined,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
    putSource,
  } as unknown as Repository
  return { repo, sidecars, contents, putSource }
}

let memory: ReturnType<typeof memoryRepository>

function request(fields: Partial<NewContentRequest>): NewContentRequest {
  return { agent: 'lesson', input: { kind: 'link', url: 'https://exemplo.com/fotossintese' }, name: '', description: '', folderId: 'biologia', prompt: '', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'], ...fields }
}

const textFile = () => new NodeFile(['A planta usa luz para fazer glicose.'], 'fotossintese.txt', { type: 'text/plain' }) as unknown as File
const recording = () => new NodeFile([new Uint8Array(4)], 'Reunião 14-10-2026.webm', { type: 'audio/webm' }) as unknown as File

const files = () => useLibraryStore.getState().files
const fileOf = (id: string) => files().find(file => file.id === id)!
const entradas = () => files().filter(file => file.role === 'entrada')

async function ready(id: string): Promise<FileMeta> {
  await waitFor(() => expect(fileOf(id)?.status).toBe('ready'))
  return fileOf(id)
}

beforeEach(() => {
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.exemplo.dev/v1', apiKey: 'test-key', model: 'default' }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  installFetch(provider)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('o nível com que cada tipo começa', () => {
  it('texto, tema e link começam em "Só o registro"; arquivo e mídia, em "Registro e arquivo"', () => {
    expect(defaultKeep('text')).toBe('registro')
    expect(defaultKeep('topic')).toBe('registro')
    expect(defaultKeep('link')).toBe('registro')
    expect(defaultKeep('file')).toBe('arquivo')
    expect(defaultKeep('recording')).toBe('arquivo')
  })
})

describe('"Só o registro"', () => {
  it('um link vira entrada com nome, link e origem, e a nota gerada é filha dela', async () => {
    const id = await useJobsStore.getState().startNewContent(request({}))
    const note = await ready(id!)
    const [entry] = entradas()
    expect(entry).toMatchObject({ role: 'entrada', kept: 'registro', name: 'Fotossíntese explicada', folderId: 'biologia', parentFileId: null, origin: { input: 'url', url: 'https://exemplo.com/fotossintese', storage: 'none' } })
    expect(note).toMatchObject({ type: 'class', parentFileId: entry.id, folderId: 'biologia', origin: { input: 'url', url: 'https://exemplo.com/fotossintese' } })
    expect(note.role).toBeUndefined()
    expect(memory.putSource).not.toHaveBeenCalled()
  })

  it('gerar de novo do mesmo link reaproveita a entrada', async () => {
    const first = await useJobsStore.getState().startNewContent(request({}))
    await ready(first!)
    const second = await useJobsStore.getState().startNewContent(request({ agent: 'explanation' }))
    await ready(second!)
    expect(entradas()).toHaveLength(1)
    expect(fileOf(second!).parentFileId).toBe(entradas()[0].id)
  })

  it('o texto colado vira entrada, com o texto dentro dela', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ input: { kind: 'text', text: 'Fotossíntese\n\nA planta usa luz.' } }))
    await ready(id!)
    const [entry] = entradas()
    expect(entry).toMatchObject({ kept: 'registro', name: 'Fotossíntese', origin: { input: 'text' } })
    expect(memory.contents.get(entry.id)).toBe('Fotossíntese\n\nA planta usa luz.')
    expect(fileOf(id!).parentFileId).toBe(entry.id)
  })

  it('o tema vira entrada, e a explicação é filha dela', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ input: { kind: 'topic', topic: 'Fotossíntese' } }))
    await ready(id!)
    const [entry] = entradas()
    expect(entry).toMatchObject({ kept: 'registro', name: 'Fotossíntese', origin: { input: 'topic' } })
    expect(fileOf(id!)).toMatchObject({ type: 'explanation', parentFileId: entry.id })
  })

  it('um arquivo em "Só o registro" não é guardado, mesmo com o Drive escolhido', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ input: { kind: 'file', file: textFile() }, keep: 'registro', storage: 'drive' }))
    await ready(id!)
    expect(entradas()[0]).toMatchObject({ kept: 'registro', origin: { name: 'fotossintese.txt', storage: 'none' } })
    expect(memory.putSource).not.toHaveBeenCalled()
  })
})

describe('"Registro e arquivo"', () => {
  it('o arquivo fica guardado na entrada, onde a pessoa escolheu; a nota só diz de onde veio', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ input: { kind: 'file', file: textFile() }, storage: 'drive' }))
    const note = await ready(id!)
    const [entry] = entradas()
    expect(entry).toMatchObject({ kept: 'arquivo', origin: { name: 'fotossintese.txt', storage: 'drive', storedFileId: `drive-${entry.id}` } })
    expect(memory.putSource).toHaveBeenCalledWith(entry.id, expect.anything(), 'fotossintese.txt')
    expect(note).toMatchObject({ parentFileId: entry.id, origin: { name: 'fotossintese.txt', storage: 'none' } })
    expect(note.origin?.storedFileId).toBeUndefined()
  })
})

describe('"Sem rastro"', () => {
  it('fica só a nota, sem mãe e sem origem, e nada é guardado', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ input: { kind: 'file', file: textFile() }, keep: 'sem-rastro', storage: 'drive' }))
    const note = await ready(id!)
    expect(files()).toHaveLength(1)
    expect(note).toMatchObject({ parentFileId: null, origin: null, type: 'class' })
    expect(memory.putSource).not.toHaveBeenCalled()
  })

  it('de um link também', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ keep: 'sem-rastro' }))
    await ready(id!)
    expect(files()).toHaveLength(1)
    expect(fileOf(id!)).toMatchObject({ parentFileId: null, origin: null })
  })

  it('uma gravação só transcrita vira uma nota com a transcrição, sem origem', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'reading', input: { kind: 'recording', file: recording() }, keep: 'sem-rastro', storage: 'drive' }))
    await waitFor(() => expect(useJobsStore.getState().jobs[0].status).toBe('done'))
    expect(files()).toHaveLength(1)
    expect(fileOf(id!)).toMatchObject({ origin: null, parentFileId: null })
    expect(fileOf(id!).role).toBeUndefined()
    expect(memory.sidecars.get(id!)?.recording?.blocks).toHaveLength(2)
    expect(memory.putSource).not.toHaveBeenCalled()
  })
})

describe('mídia: a transcrição faz parte da entrada', () => {
  it('"Só a transcrição" dá só a entrada, com a transcrição e a mídia guardada', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'reading', input: { kind: 'recording', file: recording() }, storage: 'drive' }))
    await waitFor(() => expect(memory.contents.get(id!)).toContain('Vamos lançar em maio?'))
    expect(files()).toHaveLength(1)
    expect(fileOf(id!)).toMatchObject({ role: 'entrada', kept: 'arquivo', parentFileId: null, origin: { input: 'recording', storedFileId: `drive-${id}` } })
    expect(memory.sidecars.get(id!)?.recording?.blocks).toHaveLength(2)
  })

  it('a Ata pedida com as partes é gerada da entrada, que guarda a transcrição', async () => {
    const generateAta = vi.fn(async () => undefined)
    useJobsStore.setState({ generateAta })
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file: recording() }, ataParts: ['resumo'], storage: 'drive' }))
    await waitFor(() => expect(generateAta).toHaveBeenCalledWith(id, ['resumo']))
    expect(fileOf(id!)).toMatchObject({ role: 'entrada', kept: 'arquivo' })
  })

  it('a Ata em duas passadas (sem partes) vai para uma nota filha; a entrada fica com a transcrição', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file: recording() }, storage: 'drive' }))
    await waitFor(() => expect(files().find(file => file.parentFileId === id)?.status).toBe('ready'))
    const ata = files().find(file => file.parentFileId === id)!
    expect(fileOf(id!)).toMatchObject({ role: 'entrada', kept: 'arquivo', status: 'ready' })
    expect(memory.contents.get(id!)).toContain('Vamos lançar em maio?')
    expect(ata).toMatchObject({ type: 'meeting', folderId: 'biologia', origin: { input: 'text', name: fileOf(id!).name, storage: 'none' } })
    expect(memory.contents.get(ata.id)).toContain('Lançar em maio')
    expect(memory.sidecars.get(ata.id)?.recording).toBeUndefined()
  })

  it('a Aula de uma mídia é filha da entrada; a transcrição fica na entrada', async () => {
    vi.mocked(transcribe).mockResolvedValueOnce({ text: 'Professor: a planta usa luz.', engine: 'groq', language: 'pt', durationSeconds: 8, speakers: 1 } as never)
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'lesson', input: { kind: 'recording', file: recording() }, storage: 'drive' }))
    const lesson = await ready(id!)
    const [entry] = entradas()
    expect(lesson).toMatchObject({ type: 'class', parentFileId: entry.id, origin: { input: 'text', name: entry.name } })
    expect(lesson.generation?.transcriptionEngine).toBe('groq')
    expect(entry).toMatchObject({ kept: 'arquivo', origin: { input: 'recording', storedFileId: `drive-${entry.id}` } })
    expect(memory.sidecars.get(entry.id)?.transcript).toBe('Professor: a planta usa luz.')
    expect(memory.sidecars.get(id!)?.transcript).toBeUndefined()
  })
})

describe('"Gravar reunião"', () => {
  it('a gravação salva é uma entrada, como as que já existiam, com o arquivo guardado onde a pessoa escolheu', async () => {
    const id = await useJobsStore.getState().saveRecording({ file: recording(), storedName: null, durationSeconds: 8, folderId: 'biologia', storage: 'drive', litterboxTime: '72h' as NewContentRequest['litterboxTime'], marks: [], transcribe: false })
    expect(fileOf(id)).toMatchObject({ role: 'entrada', parentFileId: null, folderId: 'biologia', origin: { input: 'recording' } })
    await waitFor(() => expect(fileOf(id)).toMatchObject({ kept: 'arquivo', origin: { storedFileId: `drive-${id}` } }))
  })

  it('sem guardar em lugar nenhum, fica só o registro', async () => {
    const id = await useJobsStore.getState().saveRecording({ file: recording(), storedName: null, durationSeconds: 8, folderId: null, storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'], marks: [], transcribe: false })
    expect(fileOf(id)).toMatchObject({ role: 'entrada', kept: 'registro' })
  })
})

describe('a Ata sempre tem entrada (FR-055)', () => {
  it('o nível da Ata começa em "Só o registro", mesmo de mídia', () => {
    expect(defaultKeep('recording', 'meeting')).toBe('registro')
    expect(defaultKeep('file', 'meeting')).toBe('registro')
    expect(defaultKeep('file', 'lesson')).toBe('arquivo')
  })

  it('"Sem rastro" numa Ata vale como "Só o registro": entrada com nome e origem, sem o arquivo, e a Ata é gerada dela', async () => {
    const generateAta = vi.fn(async () => undefined)
    useJobsStore.setState({ generateAta })
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file: recording() }, ataParts: ['resumo'], keep: 'sem-rastro', storage: 'drive' }))
    await waitFor(() => expect(generateAta).toHaveBeenCalledWith(id, ['resumo']))
    expect(fileOf(id!)).toMatchObject({ role: 'entrada', kept: 'registro', origin: { input: 'recording', name: 'Reunião 14-10-2026.webm', storage: 'none' } })
    expect(memory.putSource).not.toHaveBeenCalled()
  })

  it('a Ata em duas passadas, pedida "Sem rastro", também é filha de uma entrada; a transcrição não vira nota', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file: recording() }, keep: 'sem-rastro', storage: 'drive' }))
    await waitFor(() => expect(files().find(file => file.parentFileId === id)?.status).toBe('ready'))
    expect(fileOf(id!)).toMatchObject({ role: 'entrada', kept: 'registro' })
    expect(files().filter(file => file.role !== 'entrada')).toEqual([expect.objectContaining({ type: 'meeting', parentFileId: id })])
    expect(memory.putSource).not.toHaveBeenCalled()
  })

  it('sem nível escolhido e sem lugar para o arquivo, a Ata fica em "Só o registro"', async () => {
    const generateAta = vi.fn(async () => undefined)
    useJobsStore.setState({ generateAta })
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file: recording() }, ataParts: ['resumo'], storage: 'none' }))
    await waitFor(() => expect(generateAta).toHaveBeenCalled())
    expect(fileOf(id!)).toMatchObject({ role: 'entrada', kept: 'registro' })
  })
})
