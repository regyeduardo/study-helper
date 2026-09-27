import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  pipeline: vi.fn(),
  fromUrls: vi.fn(),
  fromHub: vi.fn(),
  speakerTurns: vi.fn(),
}))

vi.mock('@huggingface/transformers', () => ({ pipeline: mocks.pipeline }))
vi.mock('parakeet.js', () => ({ fromUrls: mocks.fromUrls, fromHub: mocks.fromHub }))
vi.mock('@/lib/transcription/diarization', () => ({ speakerTurns: mocks.speakerTurns }))

const root = path.resolve(__dirname, '../../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

const decoded = new Float32Array(16000 * 4).fill(0.3)

class FakeOfflineAudioContext {
  destination = {}
  decodeAudioData = async () => ({ duration: 4 })
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => {} }
  }
  startRendering = async () => ({ getChannelData: () => decoded })
}

const audio = () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Blob

beforeEach(() => {
  vi.resetModules()
  Object.values(mocks).forEach(mock => mock.mockReset())
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  vi.stubGlobal('SharedArrayBuffer', undefined)
  vi.stubGlobal('crossOriginIsolated', false)
  Reflect.deleteProperty(navigator, 'gpu')
  const recognizer = vi.fn(async () => ({ text: 'a b', chunks: [{ timestamp: [0, 2], text: 'primeira' }, { timestamp: [2, 4], text: 'segunda' }] }))
  mocks.pipeline.mockResolvedValue(recognizer)
  mocks.fromUrls.mockResolvedValue({ transcribeLongAudio: async () => ({ text: 'x', chunks: [{ timestamp: [0, 2], text: 'um' }, { timestamp: [2, 4], text: 'dois' }] }) })
})

afterEach(() => vi.unstubAllGlobals())

describe('no COOP/COEP requirement', () => {
  it('dev server, preview and page set no cross-origin isolation headers', () => {
    const sources = [read('vite.config.ts'), read('index.html')].join('\n')
    expect(sources).not.toMatch(/Cross-Origin-(Opener|Embedder)-Policy/i)
    expect(sources).not.toMatch(/coi-serviceworker|require-corp|credentialless/i)
  })

  it('engines and diarization never ask for threads or WebGPU-only paths', () => {
    const code = ['whisper.ts', 'parakeet.ts', 'diarization.ts', 'audio.ts', 'index.ts'].map(file => read(`src/lib/transcription/${file}`)).join('\n')
    expect(code).not.toMatch(/numThreads|SharedArrayBuffer|crossOriginIsolated|proxy\s*:/)
    expect(read('src/lib/transcription/diarization.ts')).toContain("executionProviders: ['wasm']")
  })

  it.each(['whisper', 'parakeet'] as const)('%s transcribes and separates speakers without SharedArrayBuffer or WebGPU', async engine => {
    mocks.speakerTurns.mockResolvedValue([
      { start: 0, end: 2, speaker: 'Falante 1' },
      { start: 2, end: 4, speaker: 'Falante 2' },
    ])
    const { transcribe } = await import('@/lib/transcription')
    const outcome = await transcribe(audio(), { engine, groqApiKey: '', language: 'pt', separateSpeakers: true })
    expect(typeof SharedArrayBuffer).toBe('undefined')
    expect(outcome.speakers).toBe(2)
    expect(outcome.text).toBe(engine === 'whisper' ? 'Falante 1: primeira\nFalante 2: segunda' : 'Falante 1: um\nFalante 2: dois')
    if (engine === 'whisper') expect(mocks.pipeline.mock.calls[0][2]).toMatchObject({ device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } })
    else expect(mocks.fromUrls.mock.calls[0][0].backend).toBe('wasm')
  })

  it('diarization failure is swallowed and the plain transcript survives', async () => {
    mocks.speakerTurns.mockRejectedValue(new Error('ort wasm failed'))
    const { transcribe } = await import('@/lib/transcription')
    const outcome = await transcribe(audio(), { engine: 'whisper', groqApiKey: '', language: 'pt', separateSpeakers: true })
    expect(outcome).toMatchObject({ text: 'primeira segunda', speakers: 0 })
  })

  it('separateSpeakers off never loads the diarization models', async () => {
    const { transcribe } = await import('@/lib/transcription')
    await transcribe(audio(), { engine: 'parakeet', groqApiKey: '', language: 'pt', separateSpeakers: false })
    expect(mocks.speakerTurns).not.toHaveBeenCalled()
  })
})
