import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
const mocks = vi.hoisted(() => ({
  pipeline: vi.fn(),
  recognizer: vi.fn(),
  fromUrls: vi.fn(),
  fromHub: vi.fn(),
  transcribeLongAudio: vi.fn(),
  speech2txt: vi.fn(),
}))

vi.mock('@huggingface/transformers', () => ({ pipeline: mocks.pipeline }))
vi.mock('parakeet.js', () => ({ fromUrls: mocks.fromUrls, fromHub: mocks.fromHub }))
vi.mock('@heyputer/puter.js', () => ({ default: { ai: { speech2txt: mocks.speech2txt } } }))

const setGpu = (adapter: unknown) => Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: vi.fn(async () => adapter) } })
const clearGpu = () => Reflect.deleteProperty(navigator, 'gpu')

const loud = (seconds: number) => new Float32Array(Math.round(seconds * 16000)).fill(0.3)

let decodedSamples = loud(3)

class FakeOfflineAudioContext {
  destination = {}
  decodeAudioData = async () => ({ duration: decodedSamples.length / 16000 })
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => {} }
  }
  startRendering = async () => ({ getChannelData: () => decodedSamples })
}

const audioBlob = () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Blob

beforeEach(() => {
  vi.resetModules()
  Object.values(mocks).forEach(mock => mock.mockReset())
  mocks.pipeline.mockResolvedValue(mocks.recognizer)
  mocks.recognizer.mockResolvedValue({ text: ' olá mundo', chunks: [{ timestamp: [0, 1.5], text: ' olá' }, { timestamp: [1.5, null], text: ' mundo ' }] })
  mocks.transcribeLongAudio.mockResolvedValue({ text: 'bom dia', chunks: [{ timestamp: [0, 0.8], text: ' bom ' }, { timestamp: [0.8, 1.2], text: 'dia' }] })
  mocks.fromUrls.mockResolvedValue({ transcribeLongAudio: mocks.transcribeLongAudio })
  mocks.fromHub.mockResolvedValue({ transcribeLongAudio: mocks.transcribeLongAudio })
  mocks.speech2txt.mockResolvedValue({ text: ' pelo puter ' })
  decodedSamples = loud(3)
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  clearGpu()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearGpu()
})

describe('Whisper via transformers.js', () => {
  it('without WebGPU loads whisper-small with the full-precision encoder and q8 decoder on single-thread-safe WASM and fixes the language', async () => {
    const { transcribeWithWhisper, WHISPER_MODEL } = await import('@/lib/transcription/whisper')
    const samples = loud(2)
    const segments = await transcribeWithWhisper(samples, 'pt', () => {})
    expect(WHISPER_MODEL).toBe('onnx-community/whisper-small')
    expect(mocks.pipeline).toHaveBeenCalledWith('automatic-speech-recognition', 'onnx-community/whisper-small', expect.objectContaining({ device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } }))
    expect(mocks.recognizer).toHaveBeenCalledWith(samples, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, language: 'pt', task: 'transcribe' })
    expect(segments).toEqual([
      { start: 0, end: 1.5, text: 'olá' },
      { start: 1.5, end: 1.5, text: 'mundo' },
    ])
  })

  it('WebGPU adapter switches to webgpu with fp32 encoder and q4 decoder', async () => {
    setGpu({})
    const { transcribeWithWhisper } = await import('@/lib/transcription/whisper')
    await transcribeWithWhisper(loud(1), 'pt', () => {})
    expect(mocks.pipeline.mock.calls[0][2]).toMatchObject({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } })
  })

  it('navigator.gpu without adapter or with a throwing adapter falls back to wasm', async () => {
    setGpu(null)
    const first = await import('@/lib/transcription/whisper')
    await first.transcribeWithWhisper(loud(1), 'pt', () => {})
    expect(mocks.pipeline.mock.calls[0][2].device).toBe('wasm')
    vi.resetModules()
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: vi.fn(async () => Promise.reject(new Error('blocked'))) } })
    const second = await import('@/lib/transcription/whisper')
    await second.transcribeWithWhisper(loud(1), 'pt', () => {})
    expect(mocks.pipeline.mock.calls[1][2].device).toBe('wasm')
  })

  it('auto language passes undefined, and text without chunks becomes one segment', async () => {
    mocks.recognizer.mockResolvedValue({ text: '  tudo junto ' })
    const { transcribeWithWhisper } = await import('@/lib/transcription/whisper')
    expect(await transcribeWithWhisper(loud(4), '', () => {})).toEqual([{ start: 0, end: 4, text: 'tudo junto' }])
    expect(mocks.recognizer.mock.calls[0][1].language).toBeUndefined()
    mocks.recognizer.mockResolvedValue({ text: '   ' })
    expect(await transcribeWithWhisper(loud(4), '', () => {})).toEqual([])
  })

  it('reports download progress and loads the model once, retrying after a failure', async () => {
    mocks.pipeline.mockRejectedValueOnce(new Error('offline'))
    const { transcribeWithWhisper } = await import('@/lib/transcription/whisper')
    await expect(transcribeWithWhisper(loud(1), 'pt', () => {})).rejects.toThrow('offline')
    const progress = vi.fn()
    mocks.pipeline.mockImplementation(async (_task: string, _model: string, options: { progress_callback: (event: object) => void }) => {
      options.progress_callback({ status: 'progress', progress: 40, file: 'encoder.onnx' })
      options.progress_callback({ status: 'initiate' })
      return mocks.recognizer
    })
    await transcribeWithWhisper(loud(1), 'pt', progress)
    await transcribeWithWhisper(loud(1), 'pt', progress)
    expect(mocks.pipeline).toHaveBeenCalledTimes(2)
    expect(progress).toHaveBeenCalledWith('Baixando o Whisper (encoder.onnx)', 0.4)
  })
})

describe('Parakeet via parakeet.js', () => {
  const PT = 'https://huggingface.co/calneymgp/parakeet-tdt-0.6b-v3-ptBR-TAGARELA-onnx-int8/resolve/main'

  it('Portuguese loads the pt-BR int8 model on wasm with the JS preprocessor', async () => {
    const { transcribeWithParakeet } = await import('@/lib/transcription/parakeet')
    const samples = loud(2)
    const segments = await transcribeWithParakeet(samples, 'pt', () => {})
    expect(mocks.fromUrls).toHaveBeenCalledWith({
      encoderUrl: `${PT}/encoder-model.int8.onnx`,
      decoderUrl: `${PT}/decoder_joint-model.int8.onnx`,
      tokenizerUrl: `${PT}/vocab.txt`,
      preprocessorBackend: 'js',
      backend: 'wasm',
    })
    expect(mocks.fromHub).not.toHaveBeenCalled()
    expect(mocks.transcribeLongAudio).toHaveBeenCalledWith(samples, 16000, { returnTimestamps: true })
    expect(segments).toEqual([
      { start: 0, end: 0.8, text: 'bom' },
      { start: 0.8, end: 1.2, text: 'dia' },
    ])
  })

  it('pt-BR also picks the Portuguese model, and it stays wasm even with WebGPU', async () => {
    setGpu({})
    const { transcribeWithParakeet } = await import('@/lib/transcription/parakeet')
    await transcribeWithParakeet(loud(1), 'pt-BR', () => {})
    expect(mocks.fromUrls.mock.calls[0][0].backend).toBe('wasm')
  })

  it('pt-BR model failure falls back to the multilingual model with a message', async () => {
    mocks.fromUrls.mockRejectedValue(new Error('onnx'))
    const progress = vi.fn()
    const { transcribeWithParakeet } = await import('@/lib/transcription/parakeet')
    await transcribeWithParakeet(loud(1), 'pt', progress)
    expect(progress).toHaveBeenCalledWith('O Parakeet pt-BR não carregou no navegador; usando o Parakeet multilíngue')
    expect(mocks.fromHub).toHaveBeenCalledWith('parakeet-tdt-0.6b-v3', { backend: 'wasm', encoderQuant: 'int8', decoderQuant: 'int8' })
  })

  it('other languages use the multilingual model: int8 on wasm, fp32 encoder on WebGPU', async () => {
    const first = await import('@/lib/transcription/parakeet')
    await first.transcribeWithParakeet(loud(1), 'en', () => {})
    expect(mocks.fromHub).toHaveBeenLastCalledWith('parakeet-tdt-0.6b-v3', { backend: 'wasm', encoderQuant: 'int8', decoderQuant: 'int8' })
    vi.resetModules()
    setGpu({})
    const second = await import('@/lib/transcription/parakeet')
    await second.transcribeWithParakeet(loud(1), 'es', () => {})
    expect(mocks.fromHub).toHaveBeenLastCalledWith('parakeet-tdt-0.6b-v3', { backend: 'webgpu', encoderQuant: 'fp32', decoderQuant: 'int8' })
  })

  it('auto-detect language (empty) uses the multilingual model, not pt-BR', async () => {
    const { transcribeWithParakeet } = await import('@/lib/transcription/parakeet')
    await transcribeWithParakeet(loud(1), '', () => {})
    expect(mocks.fromUrls).not.toHaveBeenCalled()
    expect(mocks.fromHub).toHaveBeenCalledTimes(1)
  })

  it('caches one model per language family and retries after a load failure', async () => {
    mocks.fromUrls.mockRejectedValueOnce(new Error('x'))
    mocks.fromHub.mockRejectedValueOnce(new Error('y'))
    const { transcribeWithParakeet } = await import('@/lib/transcription/parakeet')
    await expect(transcribeWithParakeet(loud(1), 'pt', () => {})).rejects.toThrow('y')
    await transcribeWithParakeet(loud(1), 'pt', () => {})
    await transcribeWithParakeet(loud(1), 'pt', () => {})
    expect(mocks.fromUrls).toHaveBeenCalledTimes(2)
  })

  it('text without chunks becomes one segment; empty result gives none', async () => {
    const { transcribeWithParakeet } = await import('@/lib/transcription/parakeet')
    mocks.transcribeLongAudio.mockResolvedValueOnce({ text: ' só texto ' })
    expect(await transcribeWithParakeet(loud(5), 'pt', () => {})).toEqual([{ start: 0, end: 5, text: 'só texto' }])
    mocks.transcribeLongAudio.mockResolvedValueOnce({ text: '', chunks: [] })
    expect(await transcribeWithParakeet(loud(5), 'pt', () => {})).toEqual([])
  })
})

describe('Puter', () => {
  it('returns the whole text as one segment, accepting string or object results', async () => {
    const { transcribeWithPuter } = await import('@/lib/transcription/puter')
    const blob = new Blob(['x'])
    expect(await transcribeWithPuter(blob, 'pt', 7, () => {})).toEqual([{ start: 0, end: 7, text: 'pelo puter' }])
    expect(mocks.speech2txt).toHaveBeenCalledWith(blob, { language: 'pt' })
    mocks.speech2txt.mockResolvedValueOnce(' texto cru ')
    expect(await transcribeWithPuter(blob, '', 3, () => {})).toEqual([{ start: 0, end: 3, text: 'texto cru' }])
    expect(mocks.speech2txt.mock.calls[1][1]).toBeUndefined()
    mocks.speech2txt.mockResolvedValueOnce({})
    expect(await transcribeWithPuter(blob, '', 3, () => {})).toEqual([])
  })
})

describe('transcribe() picks the engine from settings', () => {
  const settings = (engine: 'whisper' | 'parakeet' | 'groq' | 'puter') => ({ engine, groqApiKey: 'gsk_x', language: 'pt', separateSpeakers: false })

  it.each([
    ['whisper', 'olá mundo'],
    ['parakeet', 'bom dia'],
    ['puter', 'pelo puter'],
  ] as const)('%s', async (engine, text) => {
    const { transcribe } = await import('@/lib/transcription')
    const outcome = await transcribe(audioBlob(), settings(engine))
    expect(outcome).toEqual({ text, engine, language: 'pt', durationSeconds: 3, speakers: 0 })
    expect(mocks.pipeline).toHaveBeenCalledTimes(engine === 'whisper' ? 1 : 0)
    expect(mocks.fromUrls).toHaveBeenCalledTimes(engine === 'parakeet' ? 1 : 0)
    expect(mocks.speech2txt).toHaveBeenCalledTimes(engine === 'puter' ? 1 : 0)
  })

  it('groq sends 10-minute WAV parts in order', async () => {
    decodedSamples = loud(1300)
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: 'x', segments: [{ start: 1, end: 2, text: ' parte ' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { transcribe } = await import('@/lib/transcription')
    const outcome = await transcribe(audioBlob(), settings('groq'))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(outcome.text).toBe('parte parte parte')
    expect(outcome.durationSeconds).toBe(1300)
    const sizes = fetch.mock.calls.map(call => ((call as unknown as [string, { body: FormData }])[1].body.get('file') as Blob).size)
    expect(sizes).toEqual([44 + 600 * 16000 * 2, 44 + 600 * 16000 * 2, 44 + 100 * 16000 * 2])
  })

  it('unknown engine falls back to Whisper', async () => {
    const { transcribe } = await import('@/lib/transcription')
    await transcribe(audioBlob(), { ...settings('whisper'), engine: 'other' as 'whisper' })
    expect(mocks.pipeline).toHaveBeenCalledTimes(1)
  })

  it('silence is trimmed before the engine but the reported duration is the original', async () => {
    decodedSamples = new Float32Array(16000 * 10)
    decodedSamples.fill(0.3, 0, 16000 * 2)
    const { transcribe } = await import('@/lib/transcription')
    const outcome = await transcribe(audioBlob(), settings('parakeet'))
    expect(outcome.durationSeconds).toBe(10)
    expect((mocks.transcribeLongAudio.mock.calls[0][0] as Float32Array).length).toBe(16000 * 3)
  })
})
