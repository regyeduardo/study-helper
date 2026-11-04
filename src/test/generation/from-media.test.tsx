import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

const kept = vi.hoisted(() => new Map<string, File>())

vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  keepLocalMedia: vi.fn(async (file: File, fileId: string) => {
    kept.set(fileId, file)
    const { useLibraryStore } = await import('@/stores/library')
    useLibraryStore.setState(state => ({ localMedia: [...state.localMedia, { storedName: `envio-${fileId}`, name: file.name, mime: file.type, durationSeconds: 90, size: file.size, createdAt: '', fileIds: [fileId] }] }))
  }),
  readLocalMedia: vi.fn(async (item: { fileIds: string[] }) => kept.get(item.fileIds[0])!),
}))
vi.mock('@/lib/generation/inputs', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/inputs')>()), mediaDuration: async () => 90 }))
// a transcription that never ends: the Ata must not wait for it
vi.mock('@/lib/transcription/audio', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/transcription/audio')>()), decodeChannels16k: vi.fn(async () => [new Float32Array(16000).map((_, at) => Math.sin(at / 8) * 0.3)]) }))
vi.mock('@/lib/transcription', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/transcription')>()), transcribe: vi.fn(() => new Promise(() => undefined)) }))

import { defaultIndex } from '@/lib/defaults'
import * as P from '@/lib/generation/ata-prompts'
import type { Repository } from '@/lib/storage/repository'
import { opusOgg } from '@/lib/transcription/opus'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { meeting, textAnswer } from '@/test/generation/ata-fixture'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { FileSidecar } from '@/types/domain'

const element = (id: number[], payload: number[]) => [...id, 0x80 | payload.length, ...payload]
const text = (value: string) => [...value].map(letter => letter.charCodeAt(0))
const OPUS_HEAD = [...text('OpusHead'), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]
// CELT 20 ms frame (TOC 0xfc): 960 samples a packet
const block = (track: number, at: number) => element([0xa3], [0x80 | track, at >> 8, at & 0xff, 0x80, track === 1 ? 0xfc : 0xee, 0x11, 0x22])

/** A browser recording: VP8 video (track 2) and Opus sound (track 1) with its OpusHead, two clusters. */
function recordedVideo(): Uint8Array {
  const track = (number: number, type: number, codec: string, extra: number[] = []) => element([0xae], [...element([0xd7], [number]), ...element([0x83], [type]), ...element([0x86], text(codec)), ...extra])
  const cluster = (time: number) => [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...element([0xe7], [time >> 8, time & 0xff]), ...[0, 20, 40].flatMap(at => [...block(1, at), ...block(2, at)])]
  return new Uint8Array([
    ...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], text('webm'))),
    ...[0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    ...element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])),
    ...element([0x16, 0x54, 0xae, 0x6b], [...track(1, 2, 'A_OPUS', element([0x63, 0xa2], OPUS_HEAD)), ...track(2, 1, 'V_VP8')]),
    ...cluster(0),
    ...cluster(60),
  ])
}

const UID = 'openrouter::google/gemini-2.5-flash-lite'
const DIRECT = '# Ata: Tabela de Vendas\n\n## Resumo\n\nNatália ajusta a tabela [▸ 00:30].\n{{print 00:40 | campo}}\n'

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

const audioOf = (call: CapturedRequest) => {
  const user = ((call.body?.messages ?? []) as { role: string; content: unknown }[]).find(message => message.role === 'user')?.content
  return Array.isArray(user) ? (user.find(part => part.type === 'input_audio')?.input_audio as { data: string; format: string } | undefined) : undefined
}

let memory: ReturnType<typeof memoryRepository>

function hears(audio: boolean) {
  const model = { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', media: { texto: true, imagem: true, audio, video: audio, pdf: null } }
  useModelsStore.setState({ live: { openrouter: { state: 'ok', token: 1, at: Date.now(), list: [model], byId: new Map([[model.id, model]]) } }, probes: {} })
}

async function recordingNote(transcribed: boolean): Promise<string> {
  const meta = await useLibraryStore.getState().createFile({ name: 'Reunião 28-10-2026, 18-15-41', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião.webm', mime: 'video/webm', durationSeconds: 90, storage: 'none' } }, '')
  if (transcribed) await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: { ...meeting, speakers: [{ id: 'mic', name: 'Regy Niles', suggested: false }, { id: 'speaker_0', name: 'Henrique Souza', suggested: false }, { id: 'speaker_1', name: 'Natália Lenza', suggested: false }] } }))
  const { keepLocalMedia } = await import('@/lib/recording/media-library')
  await keepLocalMedia(new File([recordedVideo()], 'Reunião.webm', { type: 'video/webm' }), meta.id, 90)
  return meta.id
}

beforeEach(() => {
  installBlobShim()
  kept.clear()
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.aiConfig = { providers: [{ id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }], models: [{ uid: UID, pid: 'openrouter', mid: 'google/gemini-2.5-flash-lite', name: 'Gemini' }], defaults: { estudo: UID, ata: UID }, steps: {} }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generation straight from the media', () => {
  it('the light audio is the Opus track remuxed to Ogg: no video, nothing re-encoded', async () => {
    installBlobShim()
    const ogg = new Uint8Array(await (await opusOgg(new Blob([recordedVideo()])))!.arrayBuffer())
    const pages = [...ogg.keys()].filter(at => ogg[at] === 0x4f && String.fromCharCode(...ogg.subarray(at, at + 4)) === 'OggS')
    expect(pages).toHaveLength(3)
    expect(String.fromCharCode(...ogg.subarray(28, 36))).toBe('OpusHead')
    const last = pages[2]
    // 6 packets of 960 samples, the video frames left out
    expect(new DataView(ogg.buffer).getUint32(last + 6, true)).toBe(6 * 960)
    expect(ogg[last + 5]).toBe(0x04)
    expect([...ogg.subarray(last + 27 + 6)]).toEqual(Array<number[]>(6).fill([0xfc, 0x11, 0x22]).flat())
  })

  it('DeepInfra gets the audio as MP3: it refuses Ogg with 422 "Input should be a valid string"', async () => {
    const DI = 'deepinfra::google/gemini-2.5-flash'
    const index = useLibraryStore.getState().index
    useLibraryStore.setState({ index: { ...index, settings: { ...index.settings, aiConfig: { providers: [{ id: 'deepinfra', type: 'deepinfra', name: 'DeepInfra', key: 'k', base: '' }], models: [{ uid: DI, pid: 'deepinfra', mid: 'google/gemini-2.5-flash', name: 'Gemini' }], defaults: { estudo: DI, ata: DI }, steps: {} } } } })
    const model = { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', media: { texto: true, imagem: true, audio: true, video: false, pdf: null } }
    useModelsStore.setState({ live: { deepinfra: { state: 'ok', token: 1, at: Date.now(), list: [model], byId: new Map([[model.id, model]]) } }, probes: {} })
    const { calls } = installFetch(() => openAiStream(DIRECT))
    const id = await recordingNote(false)
    await useJobsStore.getState().generateAta(id, ['resumo'])
    const audio = audioOf(calls[0])!
    expect(audio.format).toBe('mp3')
    const bytes = Uint8Array.from(atob(audio.data), letter => letter.charCodeAt(0))
    // an MPEG audio frame: sync 0xFFE
    expect(bytes.some((byte, at) => byte === 0xff && (bytes[at + 1] & 0xe0) === 0xe0)).toBe(true)
  })

  it('a model that hears audio writes the Ata in ONE call with the light audio: no video, no transcription, the minutes play the media', async () => {
    hears(true)
    const { calls } = installFetch(() => openAiStream(DIRECT))
    const id = await recordingNote(false)
    const ataId = (await useJobsStore.getState().generateAta(id, ['resumo']))!
    expect(calls).toHaveLength(1)
    expect(audioOf(calls[0])?.format).toBe('ogg')
    expect(JSON.stringify(calls[0].body)).not.toMatch(/video_url|video\/webm/)
    expect(calls.some(call => call.url.includes('/audio/'))).toBe(false)
    const saved = memory.sidecars.get(ataId)!.documents![0]
    expect(saved).toMatchObject({ kind: 'ata', parts: ['resumo'], images: [], models: { write: 'google/gemini-2.5-flash-lite' } })
    expect(saved.markdown).toContain('[▸ 00:30](#t=30)')
    expect(saved.markdown).not.toContain('{{')
    expect(useLibraryStore.getState().files.find(file => file.id === ataId)).toMatchObject({ type: 'meeting', parentFileId: id, made: { model: UID, parts: ['resumo'] } })
  })

  it('a model that does not hear audio keeps the transcription path', async () => {
    hears(false)
    const { calls } = installFetch(request => openAiStream(textAnswer(systemPromptOf(request), userContentOf(request))))
    const id = await recordingNote(true)
    await useJobsStore.getState().generateAta(id, ['resumo'])
    expect(calls.some(call => audioOf(call))).toBe(false)
    expect(calls.some(call => systemPromptOf(call) === P.ENTENDER)).toBe(true)
  })

  it('Novo conteúdo: the Ata is made while the transcription is still running', async () => {
    hears(true)
    const { calls } = installFetch(() => openAiStream(DIRECT))
    const file = new File([recordedVideo()], 'Reunião 28-10-2026, 18-15-41.webm', { type: 'video/webm' })
    const id = (await useJobsStore.getState().startNewContent({ agent: 'meeting', input: { kind: 'recording', file }, name: '', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '1h', ataModel: 'fathom' }))!
    await waitFor(() => expect(useLibraryStore.getState().files.find(note => note.parentFileId === id)?.type).toBe('meeting'))
    expect(calls.filter(call => audioOf(call))).toHaveLength(1)
    expect(useJobsStore.getState().jobs.find(job => job.kind === 'transcription')).toMatchObject({ fileId: id, status: 'running' })
  })

  it('Aula from a recording note goes straight from the media when the Aula model hears audio', async () => {
    hears(true)
    const lesson = JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Tabela de Vendas' }, { type: 'paragraph', text: 'Campos alinhados.' }], diagrams: [] } })
    const { calls } = installFetch(() => openAiStream(lesson))
    const id = await recordingNote(false)
    const lessonId = (await useJobsStore.getState().generateFromNote(id, 'lesson'))!
    await waitFor(() => expect(memory.contents.get(lessonId)).toContain('Tabela de Vendas'))
    // one call hears the audio; the tags after it read the text
    expect(calls.filter(call => audioOf(call)?.format === 'ogg')).toHaveLength(1)
    expect(audioOf(calls[0])?.format).toBe('ogg')
  })
})
