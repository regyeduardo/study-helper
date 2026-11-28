import { beforeEach, describe, expect, it, vi } from 'vitest'

// T188 (dono, 27/11): "Demorou um século pra gerar a transcrição analisando a tela pra depois falar que não foi possível ver a tela
// gravada. Não quero que isso repita… se marcar pra ver a tela é pra ver a tela, e quando houver problemas semelhantes já avisar antes
// de iniciar qualquer gasto". Transcrever um vídeo lendo a tela confere primeiro se a tela pode ser lida; o que impede para tudo antes
// da transcrição, e a tela pedida é lida ou o trabalho diz por que não, sem trocar a transcrição de antes por uma só com o som.

const { heard, kept, order } = vi.hoisted(() => ({
  heard: { blocks: [{ speaker: 'mic', start: 0, end: 6, text: 'O VGV fecha em maio.' }], speakers: [{ id: 'mic', name: 'Ana', suggested: false }], marks: [] },
  kept: new Map<string, File>(),
  order: [] as string[],
}))

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => (order.push('transcrever'), { text: 'Ana: O VGV fecha em maio.', engine: 'groq', language: 'pt', durationSeconds: 30, speakers: 1, recording: heard })),
}))
vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  readLocalMedia: vi.fn(async (item: { fileIds: string[] }) => kept.get(item.fileIds[0])!),
}))
vi.mock('@/lib/generation/screen-check', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/screen-check')>()), checkScreen: vi.fn(async () => (order.push('conferir'), null)) }))
vi.mock('@/lib/generation/frames', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/frames')>()), lookAtScreen: vi.fn(async (recording: unknown) => (order.push('ler a tela'), recording)) }))

import { defaultIndex } from '@/lib/defaults'
import { lookAtScreen, ScreenUnread } from '@/lib/generation/frames'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { checkScreen, DARK_VIDEO } from '@/lib/generation/screen-check'
import type { Repository } from '@/lib/storage/repository'
import { transcribe } from '@/lib/transcription'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { FileSidecar } from '@/types/domain'

const TELA = 'openrouter::tela'
const BEFORE = 'Ana: O VGV fecha em maio. (a de antes, com a tela lida)'

function provider(request: CapturedRequest): Response {
  if (systemPromptOf(request) === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Reunião', nomes: [], correcoes: [] }))
  return openAiStream('{}')
}

const sidecars = new Map<string, FileSidecar>()
const repo = {
  kind: 'local',
  accountId: 'local',
  readContent: async () => '',
  readSidecar: async (id: string) => sidecars.get(id)!,
  saveFile: async (sidecar: FileSidecar) => (sidecars.set(sidecar.meta.id, sidecar), sidecar),
  saveFolder: async () => undefined,
  saveIndex: async () => undefined,
  fileSizes: async () => ({}),
} as unknown as Repository

/** An entrada of a media kept here, already transcribed (with the screen read). */
async function entrada(mime: string): Promise<string> {
  const file = new File([new Uint8Array([26, 69, 223, 163])], mime.startsWith('video/') ? 'reuniao.webm' : 'reuniao.mp3', { type: mime })
  const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', role: 'entrada', kept: 'arquivo', type: 'reading', status: 'ready', folderId: null, origin: { input: 'file', name: file.name, mime, durationSeconds: 30, storage: 'none' } }, BEFORE)
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript: BEFORE, recording: heard }))
  kept.set(meta.id, file)
  useLibraryStore.setState(state => ({ localMedia: [...state.localMedia, { storedName: `m-${meta.id}`, name: file.name, mime, durationSeconds: 30, size: file.size, createdAt: '', fileIds: [meta.id] }] }))
  return meta.id
}

const job = () => useJobsStore.getState().jobs[0]
const transcriptOf = (id: string) => sidecars.get(id)?.transcript

beforeEach(() => {
  installBlobShim()
  kept.clear()
  sidecars.clear()
  order.length = 0
  vi.mocked(transcribe).mockClear()
  vi.mocked(lookAtScreen).mockClear()
  vi.mocked(checkScreen).mockClear()
  const index = defaultIndex()
  index.settings.aiConfig = { providers: [{ id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }], models: [{ uid: TELA, pid: 'openrouter', mid: 'tela', name: 'Tela' }], defaults: { estudo: TELA, tela: TELA }, steps: {} }
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  installFetch(provider)
})

describe('transcrever um vídeo lendo a tela: confere antes de gastar (T188)', () => {
  it('a conferência roda antes da transcrição, com o modelo escolhido no passo Vídeo, e a tela pedida é lida sem cair para "só o som"', async () => {
    const id = await entrada('video/webm')
    await useJobsStore.getState().transcribeNote(id, undefined, null, '', { read: true, model: TELA })
    expect(job()?.status).toBe('done')
    expect(order).toEqual(['conferir', 'transcrever', 'ler a tela'])
    expect(vi.mocked(checkScreen).mock.calls[0][1]).toMatchObject({ model: 'tela' })
    expect(vi.mocked(lookAtScreen).mock.calls[0][5]).toEqual({ strict: true })
  })

  it('a tela pedida não pode ser lida: nada é transcrito nem gasto, o trabalho diz por quê e o que fazer, e a transcrição de antes fica', async () => {
    vi.mocked(checkScreen).mockResolvedValueOnce(DARK_VIDEO)
    const id = await entrada('video/webm')
    await useJobsStore.getState().transcribeNote(id, undefined, null, '', { read: true })
    expect(job()?.status).toBe('error')
    expect(job()?.error).toContain(DARK_VIDEO)
    expect(job()?.error).toMatch(/Nada foi gasto/)
    expect(job()?.error).toContain('Só a transcrição')
    expect(transcribe).not.toHaveBeenCalled()
    expect(lookAtScreen).not.toHaveBeenCalled()
    expect(transcriptOf(id)).toBe(BEFORE)
  })

  it('a leitura da tela pedida falha no meio: o trabalho falha com o motivo e a transcrição de antes não vira uma só com o som', async () => {
    vi.mocked(lookAtScreen).mockRejectedValueOnce(new ScreenUnread('A tela não foi lida: fora do ar (503)'))
    const id = await entrada('video/webm')
    await useJobsStore.getState().transcribeNote(id, undefined, null, '', { read: true })
    expect(job()?.status).toBe('error')
    expect(job()?.error).toContain('fora do ar (503)')
    expect(job()?.error).toContain('Só a transcrição')
    expect(transcriptOf(id)).toBe(BEFORE)
  })

  it('sem escolha (de dentro do app, como antes): o que impede a tela é dito na hora, e a transcrição segue sem gastar tempo com a tela', async () => {
    vi.mocked(checkScreen).mockResolvedValueOnce(DARK_VIDEO)
    const id = await entrada('video/webm')
    await useJobsStore.getState().transcribeNote(id)
    expect(job()?.status).toBe('done')
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(vi.mocked(lookAtScreen).mock.calls.every(call => call[1] === null)).toBe(true)
    expect(sidecars.get(id)?.recording?.warning).toContain(DARK_VIDEO)
    expect(sidecars.get(id)?.recording?.heard).toEqual({ screen: false })
  })

  it('"Só a transcrição" e um áudio nem conferem', async () => {
    const video = await entrada('video/webm')
    await useJobsStore.getState().transcribeNote(video, undefined, null, '', { read: false })
    const audio = await entrada('audio/mpeg')
    await useJobsStore.getState().transcribeNote(audio, undefined, null, '', { read: true })
    expect(checkScreen).not.toHaveBeenCalled()
    expect(transcribe).toHaveBeenCalledTimes(2)
  })
})
