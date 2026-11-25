// T180 (25/11): "Olhando a tela gravada" parada 26 minutos no servidor. grabFrames esperava o "seeked" de cada quadro sem limite e sem
// olhar o erro que o vídeo já tinha: um erro de decodificação entre dois quadros deixava a espera sem fim.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { makeSeekable } = vi.hoisted(() => ({ makeSeekable: vi.fn(async (blob: Blob) => new Blob([blob], { type: blob.type })) }))
vi.mock('@/lib/recording/seekable', () => ({ makeSeekable }))

import { grabFrames } from '@/lib/recording/frame-grab'
import { SEEK_LIMIT_MS } from '@/lib/recording/video-wait'

class FakeVideo extends EventTarget {
  static breakAfter: number | null = null
  static silent = false
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
    if (FakeVideo.silent || this.error) return
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
  FakeVideo.breakAfter = null
  FakeVideo.silent = false
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
