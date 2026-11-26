import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Notes of a YouTube link from the transcription, from the video, or from both: with "Só o vídeo" and "Transcrição + vídeo"
// the writing model gets the link AS VIDEO (it watches the speech and the screen); "Só a transcrição" is the path of before.
// Only Gemini watches a YouTube link: by Google's own API (file_data.file_uri) or through OpenRouter (video_url).

import { GenerateEntryDialog } from '@/components/dialogs/GenerateEntryDialog'
import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { defaultIndex, newFileMeta, newSidecar } from '@/lib/defaults'
import { isYoutube, mediaOf } from '@/lib/file-types'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { watchesYoutube } from '@/lib/generation/youtube-video'
import type { Repository } from '@/lib/storage/repository'
import { type NewContentRequest, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { type CapturedRequest, installFetch, jsonResponse, openAiStream, sseResponse, systemPromptOf } from '@/test/ai/fake-provider'
import type { AiConfig, FileSidecar, MediaAnalysis, SourceMeta } from '@/types/domain'
import { isSourceNote } from '@/lib/file-types'

const URL_ = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const SAID = 'O professor explica a derivada como a inclinação da reta tangente.'
const TITLE = 'Aula de Cálculo'
const LESSON = JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Derivadas' }, { type: 'paragraph', text: 'No slide, a fórmula do limite.' }], diagrams: [] } })

const OR_GEMINI = { uid: 'or::google/gemini-2.5-flash', pid: 'or', mid: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
const OR_TEXT = { uid: 'or::deepseek/deepseek-chat', pid: 'or', mid: 'deepseek/deepseek-chat', name: 'DeepSeek V3' }
const GOOGLE = { uid: 'gg::gemini-2.5-pro', pid: 'gg', mid: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }

type Part = Record<string, unknown> & { type: string; text?: string }

const partsOf = (call: CapturedRequest): Part[] => {
  const user = ((call.body?.messages ?? []) as { role: string; content: string | Part[] }[]).find(message => message.role === 'user')?.content ?? ''
  return Array.isArray(user) ? user : [{ type: 'text', text: user }]
}
const textOf = (call: CapturedRequest) => partsOf(call).map(part => part.text ?? '').join('\n')
const videoOf = (call: CapturedRequest) => partsOf(call).find(part => part.type === 'video_url')
const writers = new Set<string>([PROMPTS.LESSON_PROMPT, PROMPTS.EXPLANATION_PROMPT, PROMPTS.MEETING_PROMPT])
const writing = (calls: CapturedRequest[]) => calls.filter(call => writers.has(systemPromptOf(call)))
const captions = (calls: CapturedRequest[]) => calls.filter(call => call.url.startsWith('https://youtube-transcript.ai/'))
const native = (calls: CapturedRequest[]) => calls.filter(call => call.url.includes(':streamGenerateContent'))

/** Gemini's own API answers in its SSE format. */
function geminiStream(text: string): Response {
  const half = Math.ceil(text.length / 2)
  return sseResponse([
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: text.slice(0, half) }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: text.slice(half) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80 } })}\n\n`,
  ])
}

function provider(request: CapturedRequest): Response {
  if (request.url.startsWith('https://youtube-transcript.ai/')) return new Response(SAID)
  if (request.url.startsWith('https://www.youtube.com/oembed')) return jsonResponse({ title: TITLE })
  if (request.url.includes(':streamGenerateContent')) return geminiStream(LESSON)
  const system = systemPromptOf(request)
  if (writers.has(system)) return openAiStream(LESSON)
  if (system === PROMPTS.COURSE_ANALYSIS_PROMPT) return openAiStream(JSON.stringify({ is_course: false, modules: [] }))
  if (system.startsWith('Você sugere')) return openAiStream('{"tags":[]}')
  return openAiStream('{}')
}

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  return {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    saveFolder: async () => undefined,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
}

function config(defaultModel: string): AiConfig {
  return {
    providers: [
      { id: 'or', type: 'openrouter', name: 'OpenRouter', key: 'k-or', base: '' },
      { id: 'gg', type: 'gemini', name: 'Google Gemini', key: 'k-gg', base: '' },
    ],
    models: [OR_GEMINI, OR_TEXT, GOOGLE],
    defaults: { estudo: defaultModel, ata: defaultModel },
    steps: {},
  }
}

/** OpenRouter's list says who takes video; Google's list says nothing (the name of a Gemini is enough). */
function catalogs() {
  const or = [
    { id: OR_GEMINI.mid, name: OR_GEMINI.name, media: { texto: true, imagem: true, audio: true, video: true, pdf: true } },
    { id: OR_TEXT.mid, name: OR_TEXT.name, media: { texto: true, imagem: false, audio: false, video: false, pdf: false } },
  ]
  const gg = [{ id: GOOGLE.mid, name: GOOGLE.name, media: null }]
  const ok = (list: typeof or | typeof gg) => ({ state: 'ok' as const, token: 1, at: Date.now(), list, byId: new Map(list.map(model => [model.id, model])) })
  useModelsStore.setState({ live: { or: ok(or), gg: ok(gg) }, probes: {} })
}

function seed(defaultModel: string, files: FileSidecar[] = [], repo: Repository = memoryRepository()) {
  const index = defaultIndex()
  index.settings.aiConfig = config(defaultModel)
  for (const sidecar of files) void repo.saveFile(sidecar, '')
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: files.map(sidecar => sidecar.meta), index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
}

const files = () => useLibraryStore.getState().files
const fileOf = (id: string) => files().find(file => file.id === id)!

function request(analyze?: MediaAnalysis, fields: Partial<NewContentRequest> = {}): NewContentRequest {
  return { agent: 'lesson', input: { kind: 'link', url: URL_ }, name: '', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'], ...(analyze ? { analyze } : {}), ...fields }
}

async function written(id: string | null): Promise<string> {
  expect(id).toBeTruthy()
  await waitFor(() => expect(fileOf(id!)?.status).toBe('ready'))
  return id!
}

const YOUTUBE: SourceMeta = { input: 'youtube', name: TITLE, url: URL_, storage: 'none' }
const stamp = { at: '2026-11-12T12:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }
const entrada = () => newSidecar(newFileMeta({ id: 'e', name: TITLE, role: 'entrada', kept: 'registro', type: 'reading', origin: YOUTUBE, created: stamp, updated: stamp }))

let calls: CapturedRequest[]

beforeEach(() => {
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  catalogs()
  calls = installFetch(provider).calls
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('quem assiste um link do YouTube', () => {
  it('só um Gemini, pelo Google Gemini ou pelo OpenRouter', () => {
    expect(watchesYoutube('gemini', 'gemini-2.5-pro', null)).toBe(true)
    expect(watchesYoutube('gemini', 'gemini-flash-latest', null)).toBe(true)
    expect(watchesYoutube('openrouter', 'google/gemini-2.5-flash', { texto: true, imagem: true, audio: true, video: true, pdf: true })).toBe(true)
    expect(watchesYoutube('openrouter', 'deepseek/deepseek-chat', null)).toBe(false)
    expect(watchesYoutube('openrouter', 'openai/gpt-4o', { texto: true, imagem: true, audio: false, video: false, pdf: false })).toBe(false)
    expect(watchesYoutube('gemini', 'gemini-embedding-001', null)).toBe(false)
    expect(watchesYoutube('gemini', 'gemma-3-27b-it', null)).toBe(false)
    expect(watchesYoutube('anthropic', 'claude-sonnet-4-5', null)).toBe(false)
    expect(watchesYoutube('vercel', 'google/gemini-2.5-flash', null)).toBe(false)
    // the list (or "Testar") says it takes no video
    expect(watchesYoutube('gemini', 'gemini-2.5-pro', { texto: true, imagem: true, audio: true, video: false, pdf: true })).toBe(false)
  })

  it('a entrada do YouTube conta como vídeo, mas não tem mídia aqui para tocar', () => {
    const meta = entrada().meta
    expect(isYoutube(meta)).toBe(true)
    expect(mediaOf(meta)).toBe('text')
    expect(isYoutube({ origin: { input: 'url', name: 'site', url: 'https://exemplo.com', storage: 'none' } })).toBe(false)
  })
})

describe('Novo conteúdo de um link do YouTube', () => {
  beforeEach(() => seed(OR_GEMINI.uid))

  it('"Só o vídeo": o modelo recebe o link como vídeo, com o pedido de olhar a tela, e a legenda nem é lida', async () => {
    const id = await written(await useJobsStore.getState().startNewContent(request('video')))
    const [call] = writing(calls)
    expect(writing(calls)).toHaveLength(1)
    expect(videoOf(call)).toEqual({ type: 'video_url', video_url: { url: URL_ } })
    expect(textOf(call)).toMatch(/tela/)
    expect(textOf(call)).toMatch(/slides/)
    expect(textOf(call)).not.toContain(SAID)
    expect(captions(calls)).toHaveLength(0)
    const entry = files().find(file => isSourceNote(file))!
    expect(entry.origin).toMatchObject({ input: 'youtube', url: URL_, name: TITLE })
    // the note of the video already has the title in this folder: the Aula gets " (2)" (FR-021, spec 005, 25/11)
    expect(entry.name).toBe(TITLE)
    expect(fileOf(id)).toMatchObject({ type: 'class', name: `${TITLE} (2)`, parentFileId: entry.id, made: { analyze: 'video' } })
  })

  it('"Transcrição + vídeo": o link como vídeo e a legenda na mesma chamada', async () => {
    const id = await written(await useJobsStore.getState().startNewContent(request('ambos')))
    expect(writing(calls)).toHaveLength(1)
    const [call] = writing(calls)
    expect(videoOf(call)).toEqual({ type: 'video_url', video_url: { url: URL_ } })
    expect(textOf(call)).toContain(SAID)
    expect(textOf(call)).toMatch(/tela/)
    expect(fileOf(id)).toMatchObject({ made: { analyze: 'ambos' } })
  })

  it.each([['"Só a transcrição"', 'transcricao' as const], ['sem escolha', undefined]])('%s: como antes, só o texto da legenda, sem vídeo', async (_name, analyze) => {
    await written(await useJobsStore.getState().startNewContent(request(analyze)))
    expect(captions(calls).length).toBeGreaterThan(0)
    expect(calls.some(call => videoOf(call))).toBe(false)
    expect(calls.some(call => JSON.stringify(call.body ?? {}).includes('file_uri'))).toBe(false)
    expect(textOf(writing(calls)[0])).toContain(SAID)
  })

  it('a Ata e a Explicação também assistem', async () => {
    await written(await useJobsStore.getState().startNewContent(request('video', { agent: 'meeting' })))
    await written(await useJobsStore.getState().startNewContent(request('video', { agent: 'explanation' })))
    const sent = writing(calls)
    expect(sent.map(systemPromptOf)).toEqual([PROMPTS.MEETING_PROMPT, PROMPTS.EXPLANATION_PROMPT])
    for (const call of sent) expect(videoOf(call)).toEqual({ type: 'video_url', video_url: { url: URL_ } })
  })

  it('um modelo que não assiste YouTube falha dizendo por quê, sem mandar nada nem criar notas', async () => {
    seed(OR_TEXT.uid)
    const id = await useJobsStore.getState().startNewContent(request('video'))
    expect(id).toBeNull()
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'error', error: expect.stringContaining('não assiste vídeo do YouTube') })
    expect(writing(calls)).toHaveLength(0)
    expect(files()).toHaveLength(0)
  })

  it('no Google Gemini direto o vídeo vai pela API do próprio Google, com file_data e a chave do provedor', async () => {
    seed(GOOGLE.uid)
    await written(await useJobsStore.getState().startNewContent(request('ambos', { prompt: 'foque nos exemplos' })))
    const [call] = native(calls)
    expect(native(calls)).toHaveLength(1)
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
    expect(call.headers['x-goog-api-key']).toBe('k-gg')
    const body = call.body as { system_instruction: { parts: { text: string }[] }; contents: { role: string; parts: Record<string, unknown>[] }[] }
    expect(body.system_instruction.parts[0].text).toBe(PROMPTS.LESSON_PROMPT)
    const parts = body.contents[0].parts
    expect(parts[0]).toEqual({ file_data: { file_uri: URL_ } })
    const text = parts.map(part => String(part.text ?? '')).join('\n')
    expect(text).toContain(SAID)
    expect(text).toContain('foque nos exemplos')
    // nothing of the video went by the OpenAI-compatible door
    expect(writing(calls)).toHaveLength(0)
  })
})

describe('"Gerar desta nota" de um vídeo do YouTube', () => {
  const generate = (analyze?: MediaAnalysis) => useJobsStore.getState().generateFromNote('e', 'lesson', null, { folderId: null }, '', analyze)

  beforeEach(() => seed(OR_GEMINI.uid, [entrada()]))

  it('"Só o vídeo": o link como vídeo, sem ler a legenda; a escolha fica para "Gerar de novo"', async () => {
    const id = await written(await generate('video'))
    const [call] = writing(calls)
    expect(videoOf(call)).toEqual({ type: 'video_url', video_url: { url: URL_ } })
    expect(textOf(call)).not.toContain(SAID)
    expect(captions(calls)).toHaveLength(0)
    expect(fileOf(id)).toMatchObject({ parentFileId: 'e', made: { analyze: 'video' } })
  })

  it('"Transcrição + vídeo": os dois', async () => {
    await written(await generate('ambos'))
    const [call] = writing(calls)
    expect(videoOf(call)).toEqual({ type: 'video_url', video_url: { url: URL_ } })
    expect(textOf(call)).toContain(SAID)
  })

  it('"Só a transcrição": só o texto, como antes', async () => {
    await written(await generate('transcricao'))
    expect(calls.some(call => videoOf(call))).toBe(false)
    expect(textOf(writing(calls)[0])).toContain(SAID)
  })

  it('um modelo que não assiste YouTube: a geração não começa e diz por quê', async () => {
    seed(OR_TEXT.uid, [entrada()])
    expect(await generate('video')).toBeNull()
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'error', error: expect.stringContaining('não assiste vídeo do YouTube') })
    expect(writing(calls)).toHaveLength(0)
  })
})

describe('as janelas', () => {
  const field = () => screen.getByRole('radiogroup', { name: 'O que a IA analisa' })
  const noField = () => expect(screen.queryByRole('radiogroup', { name: 'O que a IA analisa' })).not.toBeInTheDocument()
  const radio = (name: string) => within(field()).getByRole('radio', { name: new RegExp(`^${name.replace('+', '\\+')}`) })
  const labels = () =>
    within(field())
      .getAllByRole('radio')
      .map(item => item.querySelector('b')!.textContent)
  const checked = () =>
    within(field())
      .getAllByRole('radio')
      .filter(item => item.getAttribute('aria-checked') === 'true')
      .map(item => item.querySelector('b')!.textContent)
  const startNewContent = vi.fn(async (..._args: unknown[]) => null)
  const generateFromNote = vi.fn(async (..._args: unknown[]) => 'nota')
  const REAL = useJobsStore.getState()

  beforeEach(() => {
    startNewContent.mockClear()
    generateFromNote.mockClear()
    useJobsStore.setState({ jobs: [], startNewContent, generateFromNote } as never)
  })

  afterEach(() => {
    useJobsStore.setState({ startNewContent: REAL.startNewContent, generateFromNote: REAL.generateFromNote })
  })

  describe('Novo conteúdo', () => {
    function open(defaultModel: string, url = URL_) {
      seed(defaultModel)
      render(
        <MemoryRouter>
          <NewContentDialog />
        </MemoryRouter>,
      )
      fireEvent.change(screen.getByLabelText('Link'), { target: { value: url } })
    }

    it('um link do YouTube pergunta o que a IA analisa; vem "Só a transcrição", como antes, e o que se marca vai no pedido', async () => {
      open(OR_GEMINI.uid)
      expect(labels()).toEqual(['Só o vídeo', 'Só a transcrição', 'Transcrição + vídeo'])
      expect(checked()).toEqual(['Só a transcrição'])
      expect(radio('Só o vídeo')).toHaveAttribute('aria-disabled', 'false')
      expect(radio('Só o vídeo')).toHaveTextContent(/tela/)
      fireEvent.click(radio('Só o vídeo'))
      fireEvent.click(screen.getByRole('button', { name: 'Gerar aula' }))
      await waitFor(() => expect(startNewContent).toHaveBeenCalled())
      expect(startNewContent.mock.calls[0][0]).toMatchObject({ agent: 'lesson', input: { kind: 'link', url: URL_ }, analyze: 'video', models: { write: OR_GEMINI.uid } })
    })

    it('sem marcar, o pedido vai como antes (sem escolha)', async () => {
      open(OR_GEMINI.uid)
      fireEvent.click(screen.getByRole('button', { name: 'Gerar aula' }))
      await waitFor(() => expect(startNewContent).toHaveBeenCalled())
      expect(startNewContent.mock.calls[0][0]).not.toHaveProperty('analyze')
    })

    it('um modelo que não assiste YouTube deixa as opções de vídeo desligadas, dizendo por quê; trocar para um Gemini abre', async () => {
      open(OR_TEXT.uid)
      for (const name of ['Só o vídeo', 'Transcrição + vídeo']) {
        expect(radio(name)).toHaveAttribute('aria-disabled', 'true')
        expect(radio(name)).toHaveTextContent('não assiste vídeo do YouTube')
        fireEvent.click(radio(name))
      }
      expect(checked()).toEqual(['Só a transcrição'])
      fireEvent.change(screen.getByLabelText('Modelo da IA'), { target: { value: GOOGLE.uid } })
      expect(radio('Transcrição + vídeo')).toHaveAttribute('aria-disabled', 'false')
      fireEvent.click(radio('Transcrição + vídeo'))
      expect(checked()).toEqual(['Transcrição + vídeo'])
    })

    it('a Ata de um link do YouTube tem as mesmas três opções, não as da Ata de um arquivo', () => {
      open(OR_GEMINI.uid)
      fireEvent.click(screen.getByRole('radio', { name: /^Ata/ }))
      expect(labels()).toEqual(['Só o vídeo', 'Só a transcrição', 'Transcrição + vídeo'])
      expect(screen.queryByRole('group', { name: 'Modelos por passo' })).not.toBeInTheDocument()
    })

    it('um link de site não pergunta', () => {
      open(OR_GEMINI.uid, 'https://exemplo.com/artigo')
      noField()
    })
  })

  describe('"Gerar desta nota"', () => {
    async function open(defaultModel: string) {
      seed(defaultModel, [entrada()])
      render(
        <MemoryRouter>
          <GenerateEntryDialog fileId="e" />
        </MemoryRouter>,
      )
      await screen.findByRole('radiogroup', { name: 'O que gerar' })
    }

    it('numa entrada do YouTube pergunta, vem "Só a transcrição", e a escolha vai no pedido', async () => {
      await open(OR_GEMINI.uid)
      fireEvent.click(screen.getByRole('radio', { name: /^Aula/ }))
      expect(labels()).toEqual(['Só o vídeo', 'Só a transcrição', 'Transcrição + vídeo'])
      expect(checked()).toEqual(['Só a transcrição'])
      fireEvent.click(radio('Transcrição + vídeo'))
      fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
      expect(generateFromNote).toHaveBeenCalledWith('e', 'lesson', OR_GEMINI.uid, { folderId: null }, '', 'ambos')
    })

    it('com um modelo que não assiste YouTube as opções de vídeo ficam desligadas, dizendo por quê', async () => {
      await open(OR_TEXT.uid)
      fireEvent.click(screen.getByRole('radio', { name: /^Ata/ }))
      expect(radio('Só o vídeo')).toHaveAttribute('aria-disabled', 'true')
      expect(radio('Só o vídeo')).toHaveTextContent('não assiste vídeo do YouTube')
      expect(checked()).toEqual(['Só a transcrição'])
    })
  })
})
