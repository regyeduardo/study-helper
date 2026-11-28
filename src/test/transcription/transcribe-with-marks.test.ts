import { beforeEach, describe, expect, it, vi } from 'vitest'

// T203 (dono, 28/11: "Tudo em 1 min"; research R30): a gravação com as telas marcadas é transcrita sem abrir o vídeo para a tela: a
// conferência de T188 olha as fotos das telas, e a leitura usa as marcas. E o índice das telas nunca se perde da nota, nem quando a tela
// não é lida ("Só a transcrição").

const { heard, kept, INDEX } = vi.hoisted(() => ({
  heard: { blocks: [{ speaker: 'mic', start: 0, end: 6, text: 'O VGV fecha em maio.' }], speakers: [{ id: 'mic', name: 'Ana', suggested: false }], marks: [] },
  kept: new Map<string, File>(),
  INDEX: { width: 1920, height: 1080, area: { x: 0, y: 0, w: 1920, h: 1080 }, madeBy: 'gravacao' as const, screens: [{ at: 1, end: 30, texts: [{ text: 'VGV', confidence: 0.97 }] }] },
}))

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({ text: 'Ana: O VGV fecha em maio.', engine: 'deepinfra', language: 'pt', durationSeconds: 30, speakers: 1, recording: heard })),
}))
vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  readLocalMedia: vi.fn(async (item: { fileIds: string[] }) => kept.get(item.fileIds[0])!),
}))
vi.mock('@/lib/generation/frames', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/frames')>()), lookAtScreen: vi.fn(async (recording: unknown) => recording) }))
vi.mock('@/lib/generation/screen-check', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/screen-check')>()), checkScreen: vi.fn(async () => null) }))

import { defaultIndex } from '@/lib/defaults'
import { lookAtScreen } from '@/lib/generation/frames'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { checkScreen } from '@/lib/generation/screen-check'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { FileSidecar } from '@/types/domain'

function provider(request: CapturedRequest): Response {
  if (systemPromptOf(request) === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Reunião', nomes: [], correcoes: [] }))
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
    aside: async (_id: string, part: string) => (part === 'telas/000' ? JSON.stringify({ at: 1, image: 'data:image/jpeg;base64,VEVMQQ==' }) : undefined),
  } as unknown as Repository
  return { repo, sidecars }
}

let memory: ReturnType<typeof memoryRepository>

/** A recording of the App, with the screens marked while recording. */
async function recorded(): Promise<string> {
  const file = new File([new Uint8Array([26, 69, 223, 163])], 'reuniao.webm', { type: 'video/webm' })
  const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', kept: 'arquivo', type: 'video', status: 'ready', folderId: null, origin: { input: 'recording', name: file.name, mime: 'video/webm', durationSeconds: 30, storage: 'none' } }, '')
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: { blocks: [], speakers: [], marks: [], screenIndex: INDEX } }))
  kept.set(meta.id, file)
  useLibraryStore.setState(state => ({ localMedia: [...state.localMedia, { storedName: `m-${meta.id}`, name: file.name, mime: 'video/webm', durationSeconds: 30, size: file.size, createdAt: '', fileIds: [meta.id] }] }))
  return meta.id
}

beforeEach(() => {
  installBlobShim()
  kept.clear()
  vi.mocked(lookAtScreen).mockClear()
  vi.mocked(checkScreen).mockClear()
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.aiConfig = { providers: [{ id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }], models: [{ uid: 'openrouter::tela', pid: 'openrouter', mid: 'tela', name: 'Tela' }], defaults: { estudo: 'openrouter::tela', tela: 'openrouter::tela' }, steps: {} }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  installFetch(provider)
})

const done = async () => expect(useJobsStore.getState().jobs[0]?.status).toBe('done')

describe('a transcrição de uma gravação com as telas marcadas (T203)', () => {
  it('a conferência olha as fotos das telas (não o vídeo) e a leitura usa as marcas', async () => {
    const id = await recorded()
    await useJobsStore.getState().transcribeNote(id, undefined, null, '', { read: true })
    await done()
    const checked = vi.mocked(checkScreen).mock.calls[0]?.[0]
    expect(checked).toBeDefined()
    expect(checked instanceof Blob).toBe(false)
    expect(vi.mocked(lookAtScreen).mock.calls[0]?.[4]).toMatchObject({ marked: true })
  })

  it('"Só a transcrição": a tela não é lida, e o índice das telas continua na nota', async () => {
    const id = await recorded()
    await useJobsStore.getState().transcribeNote(id, undefined, null, '', { read: false })
    await done()
    expect(vi.mocked(lookAtScreen).mock.calls.filter(call => call[1] !== null || call[4]?.marked)).toHaveLength(0)
    expect(memory.sidecars.get(id)?.recording?.screenIndex).toEqual(INDEX)
  })
})
