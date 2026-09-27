import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
const ort = vi.hoisted(() => {
  class Tensor {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  }
  return { Tensor, create: vi.fn(), sessions: [] as unknown[] }
})

vi.mock('onnxruntime-web', () => ({ Tensor: ort.Tensor, InferenceSession: { create: ort.create } }))

const RATE = 16000
const FRAMES = 40
const FRAME_SECONDS = 10 / FRAMES
const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]]
const VOICES = [Float32Array.from([1, 0, 0, 0]), Float32Array.from([0, 1, 0, 0]), Float32Array.from([0, 0, 1, 0])]

type Timeline = (seconds: number) => number[]

function install(timeline: Timeline, rotate = true) {
  let windowIndex = 0
  const queue: number[] = []
  const segmentation = {
    inputNames: ['chunk'],
    outputNames: ['scores'],
    run: vi.fn(async () => {
      const start = windowIndex * 2.5
      const shift = rotate ? windowIndex : 0
      windowIndex++
      const data = new Float32Array(FRAMES * POWERSET.length)
      const perLocal = [0, 0, 0]
      for (let frame = 0; frame < FRAMES; frame++) {
        const locals = timeline(start + frame * FRAME_SECONDS)
          .map(speaker => (speaker + shift) % 3)
          .sort()
        const klass = POWERSET.findIndex(set => set.length === locals.length && set.every((value, index) => value === locals[index]))
        data[frame * POWERSET.length + klass] = 1
        locals.forEach(local => perLocal[local]++)
      }
      for (let local = 0; local < 3; local++) if (perLocal[local] * FRAME_SECONDS >= 0.3) queue.push((local - shift + 3 * 10) % 3)
      return { scores: { dims: [1, FRAMES, POWERSET.length], data } }
    }),
  }
  const embedding = {
    inputNames: ['feats'],
    outputNames: ['embs'],
    run: vi.fn(async (inputs: Record<string, { dims: number[] }>) => {
      expect(inputs.feats.dims[0]).toBe(1)
      expect(inputs.feats.dims[2]).toBe(80)
      const voice = VOICES[queue.shift()!]
      return { embs: { data: voice.map(value => value * 3 + 0.01) } }
    }),
  }
  ort.create.mockReset()
  ort.create.mockResolvedValueOnce(segmentation).mockResolvedValueOnce(embedding)
  return { segmentation, embedding }
}

const bytes = () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4), clone() { return this } })

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', vi.fn(async () => bytes()))
})

afterEach(() => vi.unstubAllGlobals())

const between = (from: number, to: number, speaker: number) => (seconds: number) => (seconds >= from && seconds < to ? [speaker] : [])
const combine =
  (...parts: Timeline[]): Timeline =>
  seconds =>
    parts.flatMap(part => part(seconds))

describe('clusterEmbeddings', () => {
  it('same voice collapses, different voices stay apart, labels follow first appearance', async () => {
    const { clusterEmbeddings } = await import('@/lib/transcription/diarization')
    const near = (voice: Float32Array, noise: number) => {
      const vector = voice.map((value, index) => value + (index === 3 ? noise : 0))
      const norm = Math.hypot(...vector)
      return vector.map(value => value / norm)
    }
    expect(clusterEmbeddings([near(VOICES[1], 0.1), near(VOICES[0], 0.05), near(VOICES[1], -0.1), near(VOICES[0], 0.2)])).toEqual([0, 1, 0, 1])
    expect(clusterEmbeddings([VOICES[0]])).toEqual([0])
    expect(clusterEmbeddings([VOICES[0], VOICES[1], VOICES[2]])).toEqual([0, 1, 2])
  })

  it('threshold is a cosine distance: 0.9 default merges only above 0.1 similarity', async () => {
    const { clusterEmbeddings } = await import('@/lib/transcription/diarization')
    const angled = (similarity: number) => Float32Array.from([similarity, Math.sqrt(1 - similarity ** 2), 0, 0])
    expect(clusterEmbeddings([VOICES[0], angled(0.2)])).toEqual([0, 0])
    expect(clusterEmbeddings([VOICES[0], angled(0.05)])).toEqual([0, 1])
    expect(clusterEmbeddings([VOICES[0], angled(0.2)], 0.5)).toEqual([0, 1])
    expect(clusterEmbeddings([VOICES[0], VOICES[1]], 1)).toEqual([0, 0])
  })

  it('merges closest pair first and compares against the averaged centroid', async () => {
    const { clusterEmbeddings } = await import('@/lib/transcription/diarization')
    const unit = (x: number, y: number) => {
      const norm = Math.hypot(x, y)
      return Float32Array.from([x / norm, y / norm, 0, 0])
    }
    expect(clusterEmbeddings([unit(1, 0), unit(1, 0.05), unit(0, 1)], 0.5)).toEqual([0, 0, 1])
    expect(clusterEmbeddings([unit(1, 0), unit(1, 1), unit(0, 1)], 0.6)).toEqual([0, 0, 1])
    expect(clusterEmbeddings([unit(1, 0), unit(1, 1), unit(0, 1)], 0.65)).toEqual([0, 0, 0])
  })
})

describe('fbank', () => {
  it('frame count is 25 ms windows every 10 ms, 80 bins, mean-normalised per bin', async () => {
    const { fbank } = await import('@/lib/transcription/diarization')
    expect(fbank(new Float32Array(399)).frames).toBe(0)
    expect(fbank(new Float32Array(400)).frames).toBe(1)
    const noise = Float32Array.from({ length: RATE }, (_, index) => Math.sin(index * 0.3) * 0.2 + Math.sin(index * 1.7) * 0.05 * ((index % 97) / 97))
    const { data, frames } = fbank(noise)
    expect(frames).toBe(98)
    expect(data.length).toBe(98 * 80)
    for (const bin of [0, 40, 79]) {
      let sum = 0
      for (let frame = 0; frame < frames; frame++) sum += data[frame * 80 + bin]
      expect(Math.abs(sum / frames)).toBeLessThan(1e-3)
    }
    expect(data.every(Number.isFinite)).toBe(true)
  })
})

describe('speakerTurns', () => {
  const silence = (seconds: number) => new Float32Array(seconds * RATE)

  it('two speakers across overlapping windows become two turns', async () => {
    const { segmentation, embedding } = install(combine(between(0, 10, 0), between(10, 20, 1)))
    const { speakerTurns } = await import('@/lib/transcription/diarization')
    const turns = await speakerTurns(silence(20), () => {})
    expect(segmentation.run).toHaveBeenCalledTimes(5)
    expect(embedding.run).toHaveBeenCalledTimes(8)
    expect(turns).toEqual([
      { start: 0, end: 10, speaker: 'Falante 1' },
      { start: 10, end: 20, speaker: 'Falante 2' },
    ])
  })

  it('a returning speaker keeps the same label even when the model swaps local slots', async () => {
    install(combine(between(0, 5, 0), between(5, 15, 1), between(15, 20, 0)))
    const { speakerTurns } = await import('@/lib/transcription/diarization')
    expect(await speakerTurns(silence(20), () => {})).toEqual([
      { start: 0, end: 5, speaker: 'Falante 1' },
      { start: 5, end: 15, speaker: 'Falante 2' },
      { start: 15, end: 20, speaker: 'Falante 1' },
    ])
  })

  it('pauses shorter than 0.5 s are bridged, longer ones split the turn', async () => {
    install(combine(between(0, 4, 0), between(4.25, 8, 0), between(9, 12, 0), between(12, 20, 1)), false)
    const { speakerTurns } = await import('@/lib/transcription/diarization')
    expect(await speakerTurns(silence(20), () => {})).toEqual([
      { start: 0, end: 8, speaker: 'Falante 1' },
      { start: 9, end: 12, speaker: 'Falante 1' },
      { start: 12, end: 20, speaker: 'Falante 2' },
    ])
  })

  it('overlapping speech yields turns for both speakers', async () => {
    install(combine(between(0, 12, 0), between(8, 20, 1)))
    const { speakerTurns } = await import('@/lib/transcription/diarization')
    expect(await speakerTurns(silence(20), () => {})).toEqual([
      { start: 0, end: 12, speaker: 'Falante 1' },
      { start: 8, end: 20, speaker: 'Falante 2' },
    ])
  })

  it('blips under 0.3 s and pure silence give no speakers', async () => {
    install(between(3, 3.25, 0))
    const { speakerTurns } = await import('@/lib/transcription/diarization')
    expect(await speakerTurns(silence(20), () => {})).toEqual([])
  })

  it('audio shorter than one window is zero-padded to a single 10 s window', async () => {
    const { segmentation } = install(between(0, 4, 0))
    const { speakerTurns } = await import('@/lib/transcription/diarization')
    expect(await speakerTurns(silence(4), () => {})).toEqual([{ start: 0, end: 4, speaker: 'Falante 1' }])
    const input = (segmentation.run.mock.calls[0] as unknown as [Record<string, { dims: number[] }>])[0].chunk
    expect(input.dims).toEqual([1, 1, 160000])
  })

  it('reports progress per window and loads both models once on wasm', async () => {
    install(between(0, 20, 0))
    const progress = vi.fn()
    const { speakerTurns } = await import('@/lib/transcription/diarization')
    await speakerTurns(silence(20), progress)
    expect(progress).toHaveBeenCalledWith('Baixando o separador de vozes (só na primeira vez)')
    expect(progress).toHaveBeenCalledWith('Separando quem fala', 0)
    expect(progress).toHaveBeenCalledWith('Separando quem fala', 0.8)
    expect(ort.create).toHaveBeenCalledTimes(2)
    for (const call of ort.create.mock.calls) expect(call[1]).toEqual({ executionProviders: ['wasm'] })
    const urls = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map(call => call[0])
    expect(urls).toEqual([
      'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
      'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/wespeaker_en_voxceleb_CAM%2B%2B.onnx',
    ])
    install(between(0, 20, 0))
    await speakerTurns(silence(20), progress)
    expect(ort.create).toHaveBeenCalledTimes(0)
  })

  it('models come from Cache Storage when present and are stored on first download', async () => {
    const store = new Map<string, unknown>()
    const cache = { match: vi.fn(async (url: string) => store.get(url)), put: vi.fn(async (url: string, response: unknown) => void store.set(url, response)) }
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) })
    install(between(0, 20, 0))
    const first = await import('@/lib/transcription/diarization')
    await first.speakerTurns(silence(20), () => {})
    expect(cache.put).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.resetModules()
    install(between(0, 20, 0))
    const second = await import('@/lib/transcription/diarization')
    await second.speakerTurns(silence(20), () => {})
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('a failed model download is not cached and the next call retries', async () => {
    const cache = { match: vi.fn(async () => undefined), put: vi.fn() }
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ...bytes(), ok: false, status: 503 })))
    install(between(0, 20, 0))
    const { speakerTurns } = await import('@/lib/transcription/diarization')
    await expect(speakerTurns(silence(20), () => {})).rejects.toThrow('modelo não baixou (503)')
    expect(cache.put).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => bytes()))
    await expect(speakerTurns(silence(20), () => {})).resolves.toEqual([{ start: 0, end: 20, speaker: 'Falante 1' }])
  })
})
