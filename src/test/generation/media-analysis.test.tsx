import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

// FR-046: from a video, the person chooses what the AI analyzes ("Só o vídeo", "Só a transcrição", "Transcrição + vídeo");
// from an audio there is no choice: always the transcription, made first when missing and kept in the entrada.

const { SAID, heard, kept } = vi.hoisted(() => {
  const SAID = 'A fotossíntese transforma a luz do sol em açúcar.'
  return {
    SAID,
    heard: { blocks: [{ speaker: 'mic', start: 0, end: 6, text: SAID }], speakers: [{ id: 'mic', name: 'Professora', suggested: false }], marks: [] },
    kept: new Map<string, File>(),
  }
})

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({ text: `Professora: ${SAID}`, engine: 'groq', language: 'pt', durationSeconds: 30, speakers: 1, recording: heard })),
}))
// the light audio of the media: a few bytes stand for the Opus track
vi.mock('@/lib/transcription/opus', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/transcription/opus')>()), opusOgg: vi.fn(async () => new Blob([new Uint8Array([79, 103, 103, 83])], { type: 'audio/ogg' })) }))
vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  keepLocalMedia: vi.fn(async (file: File, fileId: string) => {
    kept.set(fileId, file)
    const { useLibraryStore } = await import('@/stores/library')
    useLibraryStore.setState(state => ({ localMedia: [...state.localMedia, { storedName: `envio-${fileId}`, name: file.name, mime: file.type, durationSeconds: 30, size: file.size, createdAt: '', fileIds: [fileId] }] }))
  }),
  readLocalMedia: vi.fn(async (item: { fileIds: string[] }) => kept.get(item.fileIds[0])!),
}))
vi.mock('@/lib/generation/inputs', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/inputs')>()), mediaDuration: async () => 30 }))
// no screen to look at in a few bytes
vi.mock('@/lib/generation/frames', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/frames')>()), lookAtScreen: vi.fn(async (recording: unknown) => recording) }))
vi.mock('@/lib/generation/video-source', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/video-source')>()), openVideoFrames: vi.fn(async () => Promise.reject(new Error('sem quadros no teste'))) }))

import { defaultIndex } from '@/lib/defaults'
import * as P from '@/lib/generation/ata-prompts'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { transcribe } from '@/lib/transcription'
import { opusOgg } from '@/lib/transcription/opus'
import { type NewContentRequest, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { meeting, textAnswer } from '@/test/generation/ata-fixture'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { FileSidecar, MediaAnalysis } from '@/types/domain'

const UID = 'openrouter::google/gemini-2.5-flash-lite'
const LESSON = JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Fotossíntese' }, { type: 'paragraph', text: 'A planta faz açúcar com a luz.' }], diagrams: [] } })
const DIRECT_ATA = '# Ata: Tabela de Vendas\n\n## Resumo\n\nNatália ajusta a tabela [▸ 00:30].\n'

type Part = { type: string; text?: string }

const partsOf = (call: CapturedRequest): Part[] => {
  const user = ((call.body?.messages ?? []) as { role: string; content: string | Part[] }[]).find(message => message.role === 'user')?.content ?? ''
  return Array.isArray(user) ? user : [{ type: 'text', text: user }]
}
const hasMedia = (call: CapturedRequest) => partsOf(call).some(part => part.type !== 'text')
const textOf = (call: CapturedRequest) => partsOf(call).map(part => part.text ?? '').join('\n')
/** Only text and the light audio ever go: no video, no file. */
const kinds = (call: CapturedRequest) => [...new Set(partsOf(call).map(part => part.type))].sort()

function provider(request: CapturedRequest): Response {
  const system = systemPromptOf(request)
  if (system === PROMPTS.LESSON_PROMPT || system === PROMPTS.EXPLANATION_PROMPT) return openAiStream(LESSON)
  if (system === PROMPTS.COURSE_ANALYSIS_PROMPT) return openAiStream(JSON.stringify({ is_course: false, modules: [] }))
  if (system === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Fotossíntese', nomes: [], correcoes: [] }))
  if (system === PROMPTS.SPEAKER_NAMES_PROMPT) return openAiStream(JSON.stringify({ nomes: [] }))
  if (system === PROMPTS.TITLE_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Fotossíntese' }))
  if (system === PROMPTS.TRANSCRIPT_REVIEW_PROMPT) return openAiStream(JSON.stringify({ correcoes: [] }))
  if (system.startsWith('Você sugere')) return openAiStream('{"tags":[]}')
  if (hasMedia(request)) return openAiStream(DIRECT_ATA)
  return openAiStream(textAnswer(system, textOf(request)))
}

const writing = (calls: CapturedRequest[]) => calls.filter(call => systemPromptOf(call) === PROMPTS.LESSON_PROMPT || systemPromptOf(call) === PROMPTS.EXPLANATION_PROMPT)

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const repo = {
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
  return { repo, sidecars, contents }
}

let memory: ReturnType<typeof memoryRepository>
let calls: CapturedRequest[]

function hears(audio: boolean) {
  const model = { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', media: { texto: true, imagem: true, audio, video: audio, pdf: null } }
  useModelsStore.setState({ live: { openrouter: { state: 'ok', token: 1, at: Date.now(), list: [model], byId: new Map([[model.id, model]]) } }, probes: {} })
}

const VIDEO = 'video/webm'
const AUDIO = 'audio/mpeg'
const mediaFile = (mime: string) => new File([new Uint8Array([26, 69, 223, 163, 1, 2, 3, 4])], mime === VIDEO ? 'aula.webm' : 'aula.mp3', { type: mime })

const files = () => useLibraryStore.getState().files
const fileOf = (id: string) => files().find(file => file.id === id)!
const entradas = () => files().filter(file => file.role === 'entrada')

function request(mime: string, analyze?: MediaAnalysis, fields: Partial<NewContentRequest> = {}): NewContentRequest {
  return { agent: 'lesson', input: { kind: 'file', file: mediaFile(mime) }, name: '', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'], ...(analyze ? { analyze } : {}), ...fields }
}

async function written(id: string | null): Promise<string> {
  expect(id).toBeTruthy()
  await waitFor(() => expect(fileOf(id!)?.status).toBe('ready'))
  return id!
}

/** An entrada of media kept here; `transcribed`: it already has its transcription. */
async function entrada(mime: string, transcribed: boolean): Promise<string> {
  const file = mediaFile(mime)
  const meta = await useLibraryStore.getState().createFile({ name: 'Aula de biologia', role: 'entrada', kept: 'arquivo', type: 'reading', status: 'ready', folderId: null, origin: { input: 'file', name: file.name, mime, durationSeconds: 30, storage: 'none' } }, transcribed ? `Professora: ${SAID}` : '')
  if (transcribed) await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript: `Professora: ${SAID}`, recording: heard }))
  const { keepLocalMedia } = await import('@/lib/recording/media-library')
  await keepLocalMedia(file, meta.id, 30)
  return meta.id
}

beforeEach(() => {
  installBlobShim()
  kept.clear()
  vi.mocked(transcribe).mockClear()
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.aiConfig = { providers: [{ id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }], models: [{ uid: UID, pid: 'openrouter', mid: 'google/gemini-2.5-flash-lite', name: 'Gemini' }], defaults: { estudo: UID, ata: UID }, steps: {} }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  hears(true)
  calls = installFetch(provider).calls
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Novo conteúdo de um vídeo: a pessoa escolhe o que a IA analisa', () => {
  it('"Só o vídeo" manda só a mídia, sem transcrever; a nota é filha da entrada', async () => {
    const id = await written(await useJobsStore.getState().startNewContent(request(VIDEO, 'video')))
    const [call] = writing(calls)
    expect(writing(calls)).toHaveLength(1)
    expect(kinds(call)).toEqual(['input_audio', 'text'])
    expect(textOf(call)).not.toContain(SAID)
    expect(transcribe).not.toHaveBeenCalled()
    const [entry] = entradas()
    expect(fileOf(id)).toMatchObject({ type: 'class', parentFileId: entry.id })
  })

  it('"Só a transcrição" transcreve antes, manda só o texto e guarda a transcrição na entrada', async () => {
    const id = await written(await useJobsStore.getState().startNewContent(request(VIDEO, 'transcricao')))
    expect(calls.some(hasMedia)).toBe(false)
    expect(textOf(writing(calls)[0])).toContain(SAID)
    const [entry] = entradas()
    expect(fileOf(id).parentFileId).toBe(entry.id)
    expect(memory.sidecars.get(entry.id)).toMatchObject({ transcript: expect.stringContaining(SAID), recording: { blocks: [expect.objectContaining({ text: SAID })] } })
  })

  it('"Transcrição + vídeo" manda os dois na mesma chamada', async () => {
    const id = await written(await useJobsStore.getState().startNewContent(request(VIDEO, 'ambos')))
    expect(writing(calls)).toHaveLength(1)
    const [call] = writing(calls)
    expect(kinds(call)).toEqual(['input_audio', 'text'])
    expect(textOf(call)).toContain(SAID)
    const [entry] = entradas()
    expect(fileOf(id).parentFileId).toBe(entry.id)
    expect(memory.sidecars.get(entry.id)?.transcript).toContain(SAID)
  })

  it('"Transcrição + vídeo" numa Explicação (a nota sai depois da transcrição) também manda os dois', async () => {
    await useJobsStore.getState().startNewContent(request(VIDEO, 'ambos', { agent: 'explanation' }))
    await waitFor(() => expect(files().find(file => file.type === 'explanation')?.status).toBe('ready'))
    const [entry] = entradas()
    expect(files().find(file => file.type === 'explanation')?.parentFileId).toBe(entry.id)
    expect(writing(calls)).toHaveLength(1)
    expect(kinds(writing(calls)[0])).toEqual(['input_audio', 'text'])
    expect(textOf(writing(calls)[0])).toContain(SAID)
  })

  it('"Só o vídeo" com um modelo que não ouve a mídia falha dizendo por quê, sem mandar nada nem criar notas', async () => {
    hears(false)
    const id = await useJobsStore.getState().startNewContent(request(VIDEO, 'video'))
    expect(id).toBeNull()
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'error', error: expect.stringContaining('não ouve') })
    expect(writing(calls)).toHaveLength(0)
    expect(transcribe).not.toHaveBeenCalled()
    expect(files()).toHaveLength(0)
  })
})

describe('Novo conteúdo de um vídeo: a Ata com as partes', () => {
  const ata = (id: string) => files().find(file => file.parentFileId === id && file.type === 'meeting')

  it('"Transcrição + vídeo" usa a mídia em mãos, mesmo sem guardá-la, e a transcrição, na mesma chamada', async () => {
    vi.mocked(transcribe).mockResolvedValueOnce({ text: 'reunião', engine: 'groq', language: 'pt', durationSeconds: 300, speakers: 3, recording: meeting } as never)
    const id = (await useJobsStore.getState().startNewContent(request(VIDEO, 'ambos', { agent: 'meeting', ataParts: ['resumo'] })))!
    await waitFor(() => expect(ata(id)).toBeDefined())
    const sent = calls.filter(hasMedia)
    expect(sent).toHaveLength(1)
    expect(textOf(sent[0])).toContain(meeting.blocks[1].text)
    expect(fileOf(id)).toMatchObject({ role: 'entrada', kept: 'registro' })
    expect(ata(id)).toMatchObject({ made: { analyze: 'ambos', parts: ['resumo'] } })
  })

  it('"Só a transcrição" não manda a mídia, mesmo com um modelo que ouve', async () => {
    vi.mocked(transcribe).mockResolvedValueOnce({ text: 'reunião', engine: 'groq', language: 'pt', durationSeconds: 300, speakers: 3, recording: meeting } as never)
    const id = (await useJobsStore.getState().startNewContent(request(VIDEO, 'transcricao', { agent: 'meeting', ataParts: ['resumo'] })))!
    await waitFor(() => expect(ata(id)).toBeDefined())
    expect(calls.some(hasMedia)).toBe(false)
    expect(calls.some(call => systemPromptOf(call) === P.ENTENDER)).toBe(true)
    expect(ata(id)).toMatchObject({ made: { analyze: 'transcricao' } })
  })

  it('"Só o vídeo" manda só a mídia e guarda a escolha', async () => {
    const id = (await useJobsStore.getState().startNewContent(request(VIDEO, 'video', { agent: 'meeting', ataParts: ['resumo'] })))!
    await waitFor(() => expect(ata(id)).toBeDefined())
    await waitFor(() => expect(useJobsStore.getState().jobs.find(job => job.kind === 'transcription')?.status).toBe('done'))
    const sent = calls.filter(hasMedia)
    expect(sent).toHaveLength(1)
    expect(textOf(sent[0])).not.toContain(SAID)
    expect(ata(id)).toMatchObject({ made: { analyze: 'video' } })
  })
})

describe('Novo conteúdo de um áudio: sempre a transcrição', () => {
  it('mesmo com um modelo que ouve, e mesmo pedindo "Só o vídeo", transcreve antes, manda o texto e guarda a transcrição na entrada', async () => {
    const id = await written(await useJobsStore.getState().startNewContent(request(AUDIO, 'video')))
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(calls.some(hasMedia)).toBe(false)
    expect(textOf(writing(calls)[0])).toContain(SAID)
    const [entry] = entradas()
    expect(fileOf(id).parentFileId).toBe(entry.id)
    expect(memory.sidecars.get(entry.id)).toMatchObject({ transcript: expect.stringContaining(SAID), recording: { blocks: [expect.objectContaining({ text: SAID })] } })
  })

  it('sem escolha também', async () => {
    await written(await useJobsStore.getState().startNewContent(request(AUDIO)))
    expect(calls.some(hasMedia)).toBe(false)
    expect(textOf(writing(calls)[0])).toContain(SAID)
  })
})

describe('Gerar de uma entrada de vídeo', () => {
  it('"Só o vídeo" manda só a mídia, mesmo com a transcrição pronta; a escolha fica para "Gerar de novo"', async () => {
    const source = await entrada(VIDEO, true)
    const id = await written(await useJobsStore.getState().generateFromNote(source, 'lesson', null, 'home', '', 'video'))
    const [call] = writing(calls)
    expect(kinds(call)).toEqual(['input_audio', 'text'])
    expect(textOf(call)).not.toContain(SAID)
    expect(fileOf(id)).toMatchObject({ parentFileId: source, made: { analyze: 'video' } })
  })

  it('"Só a transcrição" sem transcrição: transcreve antes, guarda na entrada e manda só o texto', async () => {
    const source = await entrada(VIDEO, false)
    const id = await written(await useJobsStore.getState().generateFromNote(source, 'lesson', null, 'home', '', 'transcricao'))
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(memory.sidecars.get(source)).toMatchObject({ transcript: expect.stringContaining(SAID), recording: { blocks: [expect.objectContaining({ text: SAID })] } })
    expect(calls.some(hasMedia)).toBe(false)
    expect(textOf(writing(calls)[0])).toContain(SAID)
    expect(fileOf(id)).toMatchObject({ parentFileId: source, made: { analyze: 'transcricao' } })
  })

  it('"Transcrição + vídeo" sem transcrição: transcreve antes e manda os dois na mesma chamada', async () => {
    const source = await entrada(VIDEO, false)
    const id = await written(await useJobsStore.getState().generateFromNote(source, 'lesson', null, 'home', '', 'ambos'))
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(memory.sidecars.get(source)?.transcript).toContain(SAID)
    expect(writing(calls)).toHaveLength(1)
    expect(kinds(writing(calls)[0])).toEqual(['input_audio', 'text'])
    expect(textOf(writing(calls)[0])).toContain(SAID)
    expect(fileOf(id).parentFileId).toBe(source)
  })

  it('a Ata com "Transcrição + vídeo" vai numa chamada só, com a mídia e a transcrição', async () => {
    vi.mocked(transcribe).mockResolvedValueOnce({ text: 'reunião', engine: 'groq', language: 'pt', durationSeconds: 300, speakers: 3, recording: meeting } as never)
    const source = await entrada(VIDEO, false)
    const ata = (await useJobsStore.getState().generateAta(source, ['resumo'], undefined, undefined, 'home', undefined, undefined, 'ambos'))!
    const heardCalls = calls.filter(hasMedia)
    expect(heardCalls).toHaveLength(1)
    expect(kinds(heardCalls[0])).toEqual(['input_audio', 'text'])
    expect(textOf(heardCalls[0])).toContain(meeting.blocks[1].text)
    expect(calls.some(call => systemPromptOf(call) === P.ENTENDER)).toBe(false)
    expect(fileOf(ata)).toMatchObject({ type: 'meeting', parentFileId: source, made: { analyze: 'ambos', parts: ['resumo'] } })
  })

  it('a Ata com "Só a transcrição" segue o caminho da transcrição, sem a mídia', async () => {
    vi.mocked(transcribe).mockResolvedValueOnce({ text: 'reunião', engine: 'groq', language: 'pt', durationSeconds: 300, speakers: 3, recording: meeting } as never)
    const source = await entrada(VIDEO, false)
    const ata = (await useJobsStore.getState().generateAta(source, ['resumo'], undefined, undefined, 'home', undefined, undefined, 'transcricao'))!
    expect(calls.some(hasMedia)).toBe(false)
    expect(calls.some(call => systemPromptOf(call) === P.ENTENDER)).toBe(true)
    expect(fileOf(ata)).toMatchObject({ type: 'meeting', parentFileId: source })
  })
})

describe('a mídia escolhida não pode ir', () => {
  it('"Só o vídeo" de uma entrada sem a mídia guardada falha dizendo por quê', async () => {
    const source = await entrada(VIDEO, true)
    useLibraryStore.setState({ localMedia: [] })
    expect(await useJobsStore.getState().generateFromNote(source, 'lesson', null, 'home', '', 'video')).toBeNull()
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'error', fileId: source, error: expect.stringContaining('não está mais guardada') })
    expect(writing(calls)).toHaveLength(0)
    expect(files()).toHaveLength(1)
  })

  it('a Ata com "Só o vídeo" que não vai na chamada falha dizendo por quê, sem criar a nota', async () => {
    vi.mocked(opusOgg).mockResolvedValueOnce(null)
    const source = await entrada(VIDEO, true)
    expect(await useJobsStore.getState().generateAta(source, ['resumo'], undefined, undefined, 'home', undefined, undefined, 'video')).toBeUndefined()
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'error', fileId: source, error: expect.stringContaining('longa demais') })
    expect(calls.some(call => systemPromptOf(call) === P.ENTENDER)).toBe(false)
    expect(files()).toHaveLength(1)
  })
})

describe('Gerar de uma entrada de áudio: sempre a transcrição', () => {
  it('sem transcrição e com um modelo que ouve: transcreve antes, guarda na entrada e manda só o texto', async () => {
    const source = await entrada(AUDIO, false)
    const id = await written(await useJobsStore.getState().generateFromNote(source, 'lesson', null, 'home', '', 'video'))
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(memory.sidecars.get(source)).toMatchObject({ transcript: expect.stringContaining(SAID), recording: { blocks: [expect.objectContaining({ text: SAID })] } })
    expect(calls.some(hasMedia)).toBe(false)
    expect(textOf(writing(calls)[0])).toContain(SAID)
    expect(fileOf(id).parentFileId).toBe(source)
    expect(fileOf(id).made?.analyze).toBeUndefined()
  })

  it('com a transcrição pronta não transcreve de novo', async () => {
    const source = await entrada(AUDIO, true)
    await written(await useJobsStore.getState().generateFromNote(source, 'lesson'))
    expect(transcribe).not.toHaveBeenCalled()
    expect(calls.some(hasMedia)).toBe(false)
  })

  it('a Ata de um áudio sem transcrição: transcreve antes e segue o caminho da transcrição', async () => {
    vi.mocked(transcribe).mockResolvedValueOnce({ text: 'reunião', engine: 'groq', language: 'pt', durationSeconds: 300, speakers: 3, recording: meeting } as never)
    const source = await entrada(AUDIO, false)
    const ata = (await useJobsStore.getState().generateAta(source, ['resumo']))!
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(memory.sidecars.get(source)?.recording?.blocks).toHaveLength(meeting.blocks.length)
    expect(calls.some(hasMedia)).toBe(false)
    expect(calls.some(call => systemPromptOf(call) === P.ENTENDER)).toBe(true)
    expect(fileOf(ata)).toMatchObject({ type: 'meeting', parentFileId: source })
  })
})
