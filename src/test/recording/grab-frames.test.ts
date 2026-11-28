// T180 (25/11): "Olhando a tela gravada" parada 26 minutos no servidor. grabFrames esperava o "seeked" de cada quadro sem limite e sem
// olhar o erro que o vídeo já tinha: um erro de decodificação entre dois quadros deixava a espera sem fim.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { makeSeekable } = vi.hoisted(() => ({ makeSeekable: vi.fn(async (blob: Blob) => new Blob([blob], { type: blob.type })) }))
vi.mock('@/lib/recording/seekable', () => ({ makeSeekable }))
// T191: the pass of WebCodecs, off by default (no VideoDecoder in jsdom); the tests of the pass turn it on
const passing = vi.hoisted(() => ({ on: false, fail: false, asked: [] as number[][] }))
vi.mock('@/lib/recording/video-pass', () => ({
  openPass: vi.fn(async () =>
    passing.on
      ? {
          each: async (times: number[], use: (at: number, frame: unknown) => void) => {
            passing.asked.push([...times])
            if (passing.fail) throw new Error('o decodificador parou')
            for (const at of times) use(at, { width: 1920, height: 1080, draw: vi.fn() })
          },
          close: vi.fn(),
        }
      : null,
  ),
}))

import { grabFrames, jumpable } from '@/lib/recording/frame-grab'
import { SEEK_LIMIT_MS } from '@/lib/recording/video-wait'

class FakeVideo extends EventTarget {
  static breakAfter: number | null = null
  static silent = false
  /** Seeks to these times never end (a frame the decoder does not hand). */
  static lateAt = new Set<number>()
  muted = false
  preload = ''
  videoWidth = 1280
  videoHeight = 720
  duration = 600
  error: { code: number } | null = null
  seeks: number[] = []
  private source = ''
  private time = 0
  get src() {
    return this.source
  }
  set src(value: string) {
    this.source = value
    setTimeout(() => this.dispatchEvent(new Event('loadeddata')), 0)
  }
  removeAttribute() {
    this.source = ''
  }
  get currentTime() {
    return this.time
  }
  set currentTime(value: number) {
    this.time = value
    this.seeks.push(value)
    if (FakeVideo.silent || this.error || FakeVideo.lateAt.has(value)) return
    setTimeout(() => {
      this.dispatchEvent(new Event('seeked'))
      if (FakeVideo.breakAfter !== null && this.seeks.length >= FakeVideo.breakAfter) {
        this.error = { code: 3 }
        this.dispatchEvent(new Event('error'))
      }
    }, 0)
  }
}

const originalCreate = document.createElement.bind(document)
const urlApi = URL as unknown as Record<string, unknown>
const saved = { create: urlApi.createObjectURL, revoke: urlApi.revokeObjectURL }

beforeEach(() => {
  Object.assign(passing, { on: false, fail: false, asked: [] })
  FakeVideo.breakAfter = null
  FakeVideo.silent = false
  FakeVideo.lateAt = new Set()
  makeSeekable.mockClear()
  urlApi.createObjectURL = vi.fn(() => 'blob:video')
  urlApi.revokeObjectURL = vi.fn()
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) =>
    tag === 'video' ? (new FakeVideo() as unknown as HTMLVideoElement) : originalCreate(tag, options)) as typeof document.createElement)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(16 * 9 * 4) }) })) as unknown as HTMLCanvasElement['getContext'])
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/jpeg;base64,AAAA')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  urlApi.createObjectURL = saved.create
  urlApi.revokeObjectURL = saved.revoke
})

describe('grabFrames nunca espera para sempre', () => {
  it('lê os quadros pedidos', async () => {
    const frames = await grabFrames(new Blob(['x']), [5, 10])
    expect(frames.map(frame => frame.at)).toEqual([5, 10])
  })

  it('um WebM de antes tem o índice refeito antes de pular (o índice velho apontava quadros que não começam o vídeo)', async () => {
    const video = new Blob(['x'], { type: 'video/webm' })
    await grabFrames(video, [5])
    expect(makeSeekable).toHaveBeenCalledWith(video, { redo: true })
  })

  it('o vídeo que quebrou entre dois quadros: falha na hora, dizendo por quê', async () => {
    FakeVideo.breakAfter = 1
    await expect(grabFrames(new Blob(['x']), [5, 10, 15])).rejects.toThrow('O vídeo da gravação não abriu.')
  })

  it('um quadro que não vem: falha depois do limite', async () => {
    FakeVideo.silent = true
    vi.useFakeTimers()
    const grabbing = grabFrames(new Blob(['x']), [5])
    const failed = expect(grabbing).rejects.toThrow(/não veio/)
    await vi.advanceTimersByTimeAsync(SEEK_LIMIT_MS + 1)
    await failed
  })
})

// T188 (dono, 27/11): a leitura da tela que demorou e no fim disse que não viu a tela. Um quadro atrasado derrubava todos (a mensagem
// dizia "segui sem ele", e não seguia).
describe('um quadro atrasado não derruba os outros (T188)', () => {
  it('o quadro que não vem é pulado e os outros saem', async () => {
    FakeVideo.lateAt = new Set([10])
    vi.useFakeTimers()
    const grabbing = grabFrames(new Blob(['x']), [5, 10, 15])
    await vi.advanceTimersByTimeAsync(SEEK_LIMIT_MS + 50)
    expect((await grabbing).map(frame => frame.at)).toEqual([5, 15])
  })

  it('três quadros seguidos que não vêm: o vídeo parou de entregar, e a leitura falha dizendo por quê (sem esperar o resto)', async () => {
    FakeVideo.lateAt = new Set([10, 15, 20, 25, 30])
    vi.useFakeTimers()
    const grabbing = grabFrames(new Blob(['x']), [5, 10, 15, 20, 25, 30])
    const failed = expect(grabbing).rejects.toThrow(/não veio/)
    await vi.advanceTimersByTimeAsync(3 * SEEK_LIMIT_MS + 50)
    await failed
  })
})

describe('o índice do WebM é refeito uma vez por vídeo (T188)', () => {
  it('a conferência, os quadros e o índice do mesmo vídeo refazem o índice uma vez só', async () => {
    const video = new Blob(['x'], { type: 'video/webm' })
    await jumpable(video)
    await grabFrames(video, [5])
    await jumpable(video)
    expect(makeSeekable).toHaveBeenCalledTimes(1)
  })
})

describe('os quadros da transcrição numa passada só (T191)', () => {
  it('com a passada, nenhum <video> escondido pula: os quadros saem na ordem pedida, em JPEG de até 1280 px', async () => {
    passing.on = true
    const created = vi.mocked(document.createElement).mock.calls.filter(([tag]) => tag === 'video').length
    const frames = await grabFrames(new Blob(['x']), [5, 10, 15])
    expect(frames.map(frame => frame.at)).toEqual([5, 10, 15])
    expect(frames.every(frame => frame.image.startsWith('data:image/jpeg') && frame.signature.length === 16 * 9)).toBe(true)
    expect(vi.mocked(document.createElement).mock.calls.filter(([tag]) => tag === 'video').length).toBe(created)
    expect(passing.asked).toEqual([[5, 10, 15]])
  })

  it('a passada que falha: os quadros saem pelos pulos, como antes', async () => {
    passing.on = true
    passing.fail = true
    const frames = await grabFrames(new Blob(['x']), [5, 10])
    expect(frames.map(frame => frame.at)).toEqual([5, 10])
  })
})

