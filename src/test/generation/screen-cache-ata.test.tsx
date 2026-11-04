import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultIndex } from '@/lib/defaults'
import { openVideoFrames } from '@/lib/generation/video-source'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { meeting, textAnswer } from '@/test/generation/ata-fixture'
import { fakeOcr, OCR, recordedCall } from '@/test/generation/screen-fixture'
import type { AiConfig, FileSidecar, RecordingData, ScreenIndex } from '@/types/domain'

const ocr = vi.hoisted(() => ({ reader: null as unknown as { read: ReturnType<typeof vi.fn>; close?: () => void } }))

// The app's OCR starts its workers on the first read: counting reads counts workers.
vi.mock('@/lib/generation/screen-ocr', () => ({ browserOcr: () => ocr.reader }))
vi.mock('@/lib/generation/video-source', async () => ({ ...(await vi.importActual<object>('@/lib/generation/video-source')), openVideoFrames: vi.fn() }))
vi.mock('@/lib/recording/media-library', async () => ({ ...(await vi.importActual<object>('@/lib/recording/media-library')), readLocalMedia: vi.fn(async () => new File(['v'], 'Reunião.webm', { type: 'video/webm' })) }))

// No vision model on purpose: only the text one.
const CONFIG: AiConfig = {
  providers: [{ id: 'custom', type: 'custom', name: 'Exemplo', key: 'k', base: 'https://ia.exemplo.dev/v1' }],
  models: [{ uid: 'custom::geral', pid: 'custom', mid: 'geral', name: 'Geral' }],
  defaults: { estudo: 'custom::geral' },
  steps: {},
}
const SAVED: ScreenIndex = {
  width: 1920,
  height: 1080,
  area: { x: 480, y: 240, w: 960, h: 600 },
  screens: [
    { at: 1, end: 51, texts: OCR[0] },
    { at: 51, end: 151, texts: OCR[1] },
    { at: 151, end: 251, texts: OCR[2] },
    { at: 251, end: 320, texts: OCR[3] },
  ],
}

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

beforeEach(() => {
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.aiConfig = CONFIG
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ menu: null, overlay: null })
  calls = installFetch(request => openAiStream(textAnswer(systemPromptOf(request), userContentOf(request)))).calls
  ocr.reader = fakeOcr()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A video note of a recording; `recording` is what its transcription kept. */
async function videoNote(recording: RecordingData): Promise<string> {
  const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião 28-10-2026, 18-15-41.webm', mime: 'video/webm', durationSeconds: 320, storage: 'none' } }, 'Regy Niles [00:10]: Boa tarde')
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording }))
  useLibraryStore.setState({ localMedia: [{ storedName: 'reuniao.webm', name: 'Reunião.webm', mime: 'video/webm', durationSeconds: 320, size: 8, createdAt: '2026-10-28T21:15:00Z', fileIds: [meta.id] }] })
  return meta.id
}

const withImages = () => calls.filter(call => JSON.stringify(call.body ?? {}).includes('image_url'))

describe('the Ata of a video note', () => {
  it('opens the video even without a vision model: the local OCR still reads the screen', async () => {
    const frames = recordedCall()
    vi.mocked(openVideoFrames).mockResolvedValue(frames)
    const id = await videoNote(meeting)
    const ataId = await useJobsStore.getState().generateAta(id, ['resumo'])
    expect(ataId).toBeTruthy()
    expect(openVideoFrames).toHaveBeenCalledTimes(1)
    expect(ocr.reader.read).toHaveBeenCalledTimes(4)
    expect(withImages()).toHaveLength(0)
    expect(calls.some(call => userContentOf(call).includes('Painel de Controle'))).toBe(true)
  })

  it('with the index the transcription saved nothing is looked for again: no thumbnails, no OCR worker, same Ata', async () => {
    const fresh = await (async () => {
      vi.mocked(openVideoFrames).mockResolvedValue(recordedCall())
      return memory.contents.get((await useJobsStore.getState().generateAta(await videoNote(meeting), ['resumo']))!)
    })()
    ocr.reader = fakeOcr()
    const frames = recordedCall()
    const thumbs = vi.fn(frames.thumbs!)
    frames.thumbs = thumbs
    vi.mocked(openVideoFrames).mockResolvedValue(frames)
    const id = await videoNote({ ...meeting, screenIndex: SAVED })
    const ataId = (await useJobsStore.getState().generateAta(id, ['resumo']))!
    expect(openVideoFrames).toHaveBeenCalledTimes(2)
    expect(thumbs).not.toHaveBeenCalled()
    expect(ocr.reader.read).not.toHaveBeenCalled()
    expect(frames.crops).toHaveLength(0)
    expect(memory.contents.get(ataId)).toBe(fresh)
    // what was kept stays with the recording
    expect(memory.sidecars.get(id)!.recording?.screenIndex).toEqual(SAVED)
  })
})
