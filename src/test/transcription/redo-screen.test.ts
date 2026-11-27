import { beforeEach, describe, expect, it, vi } from 'vitest'

// T187 (dono, 27/11: "No refazer permita selecionar as opções assim como é no criar"): transcrever de novo um vídeo escolhe se a tela
// é lida e por qual modelo; a transcrição guarda o que foi usado, e o próximo "Refazer a transcrição" vem com isso.

const { heard, kept } = vi.hoisted(() => ({
  heard: { blocks: [{ speaker: 'mic', start: 0, end: 6, text: 'O VGV fecha em maio.' }], speakers: [{ id: 'mic', name: 'Ana', suggested: false }], marks: [] },
  kept: new Map<string, File>(),
}))

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({ text: 'Ana: O VGV fecha em maio.', engine: 'groq', language: 'pt', durationSeconds: 30, speakers: 1, recording: heard })),
}))
vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  readLocalMedia: vi.fn(async (item: { fileIds: string[] }) => kept.get(item.fileIds[0])!),
}))
// the look itself is tested in frames.test.ts: here, only whether it is asked and with which model
vi.mock('@/lib/generation/frames', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/frames')>()), lookAtScreen: vi.fn(async (recording: unknown) => recording) }))

import { defaultIndex } from '@/lib/defaults'
import { lookAtScreen } from '@/lib/generation/frames'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { FileSidecar } from '@/types/domain'

const TELA = 'openrouter::tela'
const OUTRA = 'openrouter::outra'

function provider(request: CapturedRequest): Response {
  const system = systemPromptOf(request)
  if (system === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Reunião', nomes: [], correcoes: [] }))
  return openAiStream('{}')
}

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: async (sidecar: FileSidecar) => {
      sidecars.set(sidecar.meta.id, sidecar)
      return sidecar
    },
    saveFolder: async () => undefined,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  return { repo, sidecars }
}

let memory: ReturnType<typeof memoryRepository>

/** An entrada of a media kept here, already transcribed. */
async function entrada(mime: string): Promise<string> {
  const file = new File([new Uint8Array([26, 69, 223, 163])], mime.startsWith('video/') ? 'reuniao.webm' : 'reuniao.mp3', { type: mime })
  const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', role: 'entrada', kept: 'arquivo', type: 'reading', status: 'ready', folderId: null, origin: { input: 'file', name: file.name, mime, durationSeconds: 30, storage: 'none' } }, 'Ana: O VGV fecha em maio.')
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript: 'Ana: O VGV fecha em maio.', recording: heard }))
  kept.set(meta.id, file)
  useLibraryStore.setState(state => ({ localMedia: [...state.localMedia, { storedName: `m-${meta.id}`, name: file.name, mime, durationSeconds: 30, size: file.size, createdAt: '', fileIds: [meta.id] }] }))
  return meta.id
}

const looked = () => vi.mocked(lookAtScreen).mock.calls.filter(call => call[1] !== null)
const recordingOf = (id: string) => memory.sidecars.get(id)?.recording

beforeEach(() => {
  installBlobShim()
  kept.clear()
  vi.mocked(lookAtScreen).mockClear()
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.aiConfig = {
    providers: [{ id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }],
    models: [
      { uid: TELA, pid: 'openrouter', mid: 'tela', name: 'Tela' },
      { uid: OUTRA, pid: 'openrouter', mid: 'outra', name: 'Outra' },
    ],
    defaults: { estudo: TELA, tela: TELA },
    steps: {},
  }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  installFetch(provider)
})

const done = async () => expect(useJobsStore.getState().jobs[0]?.status).toBe('done')

describe('Refazer a transcrição de um vídeo: ler a tela e com qual modelo', () => {
  it('"Só a transcrição" não lê a tela, e a transcrição guarda que foi assim', async () => {
    const id = await entrada('video/webm')
    await useJobsStore.getState().transcribeNote(id, undefined, null, '', { read: false })
    await done()
    expect(looked()).toHaveLength(0)
    expect(recordingOf(id)?.heard).toEqual({ screen: false })
  })

  it('lendo a tela, vai o modelo escolhido no passo Vídeo, e ele fica guardado com o modelo da transcrição', async () => {
    const id = await entrada('video/webm')
    await useJobsStore.getState().transcribeNote(id, undefined, TELA, '', { read: true, model: OUTRA })
    await done()
    expect(looked()).toHaveLength(1)
    expect(looked()[0][2]).toMatchObject({ model: 'outra' })
    expect(recordingOf(id)?.heard).toEqual({ model: TELA, screen: true, vision: OUTRA })
  })

  it('sem escolha (como antes), um vídeo tem a tela lida pelo modelo de Leitura de tela', async () => {
    const id = await entrada('video/webm')
    await useJobsStore.getState().transcribeNote(id)
    await done()
    expect(looked()).toHaveLength(1)
    expect(looked()[0][2]).toMatchObject({ model: 'tela' })
    expect(recordingOf(id)?.heard).toEqual({ screen: true })
  })

  it('um áudio não tem tela: nada é lido, nem pedindo', async () => {
    const id = await entrada('audio/mpeg')
    await useJobsStore.getState().transcribeNote(id, undefined, null, '', { read: true, model: OUTRA })
    await done()
    expect(looked()).toHaveLength(0)
    expect(recordingOf(id)?.heard).toEqual({ screen: false })
  })
})
