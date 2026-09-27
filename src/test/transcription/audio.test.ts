import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SAMPLE_RATE, decodeToMono16k, durationOf, encodeWav, splitSamples, withoutSilence } from '@/lib/transcription/audio'

const seconds = (value: number, level = 0.5) => new Float32Array(Math.round(value * SAMPLE_RATE)).fill(level)

const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('durationOf and splitSamples', () => {
  it('duration is samples over 16 kHz', () => {
    expect(SAMPLE_RATE).toBe(16000)
    expect(durationOf(new Float32Array(16000 * 3))).toBe(3)
    expect(durationOf(new Float32Array(8000))).toBe(0.5)
  })

  it('splits into fixed windows with a shorter tail and covers every sample', () => {
    const samples = Float32Array.from({ length: SAMPLE_RATE * 25 }, (_, index) => index)
    const parts = splitSamples(samples, 10)
    expect(parts.map(part => part.length)).toEqual([160000, 160000, 80000])
    expect(parts[1][0]).toBe(160000)
    expect(parts[2][parts[2].length - 1]).toBe(samples.length - 1)
  })

  it('exact multiple gives no empty tail and empty input gives no parts', () => {
    expect(splitSamples(new Float32Array(SAMPLE_RATE * 1200), 600).map(part => part.length)).toEqual([9600000, 9600000])
    expect(splitSamples(new Float32Array(0), 600)).toEqual([])
  })

  it('fractional window size is rounded to whole samples', () => {
    expect(splitSamples(new Float32Array(100), 0.00031).map(part => part.length)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5])
  })
})

describe('withoutSilence', () => {
  it('keeps speech and up to one second of each pause', () => {
    const out = withoutSilence(join(seconds(2), seconds(5, 0), seconds(2)))
    expect(durationOf(out)).toBeCloseTo(5, 2)
  })

  it('short pauses stay whole', () => {
    const input = join(seconds(1), seconds(0.8, 0), seconds(1))
    expect(withoutSilence(input).length).toBe(input.length)
  })

  it('signal just above -40 dBFS counts as loud, just below counts as quiet', () => {
    const loud = seconds(3, 0.0101)
    expect(withoutSilence(loud).length).toBe(loud.length)
    const quiet = join(seconds(1), seconds(3, 0.0099))
    expect(durationOf(withoutSilence(quiet))).toBeCloseTo(2, 2)
  })

  it('all silence returns the first second only', () => {
    expect(durationOf(withoutSilence(seconds(4, 0)))).toBeCloseTo(1, 2)
  })

  it('empty input returns the same array', () => {
    const empty = new Float32Array(0)
    expect(withoutSilence(empty)).toBe(empty)
  })
})

describe('encodeWav', () => {
  const readBlob = (blob: Blob) =>
    new Promise<ArrayBuffer>(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(blob)
    })
  it('writes a 16-bit mono PCM header and clamps samples', async () => {
    const blob = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]))
    expect(blob.type).toBe('audio/wav')
    const view = new DataView(await readBlob(blob))
    const text = (offset: number) => String.fromCharCode(...[0, 1, 2, 3].map(index => view.getUint8(offset + index)))
    expect(blob.size).toBe(44 + 12)
    expect(text(0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 12)
    expect(text(8)).toBe('WAVE')
    expect(text(12)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(12)
    expect([0, 1, 2, 3, 4, 5].map(index => view.getInt16(44 + index * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16383])
  })

  it('honours a custom sample rate', async () => {
    const view = new DataView(await readBlob(encodeWav(new Float32Array(4), 44100)))
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint32(28, true)).toBe(88200)
  })
})

describe('decodeToMono16k', () => {
  const bytesBlob = (size: number) => ({ arrayBuffer: async () => new ArrayBuffer(size) }) as unknown as Blob
  const contexts: { channels: number; length: number; rate: number }[] = []
  const rendered = Float32Array.from([0.1, 0.2, 0.3])

  class FakeOfflineAudioContext {
    destination = {}
    constructor(channels: number, length: number, rate: number) {
      contexts.push({ channels, length, rate })
    }
    decodeAudioData = vi.fn(async () => ({ duration: 2.00003, sampleRate: 44100, numberOfChannels: 2 }))
    createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: vi.fn() }
    }
    startRendering = vi.fn(async () => ({ getChannelData: () => rendered }))
  }

  beforeEach(() => {
    contexts.length = 0
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('renders into a mono 16 kHz context sized by the decoded duration', async () => {
    const out = await decodeToMono16k(bytesBlob(8))
    expect(contexts).toEqual([
      { channels: 1, length: 1, rate: 16000 },
      { channels: 1, length: 32001, rate: 16000 },
    ])
    expect(Array.from(out)).toEqual(Array.from(rendered))
    expect(out).not.toBe(rendered)
  })

  it('zero-length audio still gets a one-sample context', async () => {
    vi.stubGlobal(
      'OfflineAudioContext',
      class extends FakeOfflineAudioContext {
        decodeAudioData = vi.fn(async () => ({ duration: 0, sampleRate: 16000, numberOfChannels: 1 }))
      },
    )
    await decodeToMono16k(bytesBlob(0))
    expect(contexts[1]).toEqual({ channels: 1, length: 1, rate: 16000 })
  })
})
