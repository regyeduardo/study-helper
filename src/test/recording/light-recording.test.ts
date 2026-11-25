// Spec 007, história 3 (T095, research R12): as variantes medidas montam as opções certas do gravador, e o app grava com a escolhida.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MeetingRecorder } from '@/lib/recording/recorder'
import { AUDIO_BITS_PER_SECOND, CHOSEN, recorderOptions, VARIANTS } from '@/lib/recording/variants'
import { FakeMediaRecorder, FakeMediaStream, FakeTrack, installMediaEnvironment } from '@/test/recording/media-fakes'

const everything = () => true
const noAv1 = (mime: string) => !mime.includes('av01') && !mime.includes('av1')

describe('as variantes do gravador', () => {
  it('a de hoje (A) é a de antes: 600 kb/s a 5 quadros, sem quadro-chave nem dica', () => {
    expect(recorderOptions(VARIANTS.A, 5, everything)).toEqual({ mimeType: 'video/webm;codecs=vp9,opus', audioBitsPerSecond: 32_000, videoBitsPerSecond: 600_000 })
  })

  it('B: VP9 a 350 kb/s com quadro-chave a cada 5 s', () => {
    expect(recorderOptions(VARIANTS.B, 5, everything)).toEqual({ mimeType: 'video/webm;codecs=vp9,opus', audioBitsPerSecond: 32_000, videoBitsPerSecond: 350_000, videoKeyFrameIntervalDuration: 5000 })
    expect(VARIANTS.B.contentHint).toBe('detail')
  })

  it('D grava AV1 onde o navegador grava, e cai para VP9 onde não', () => {
    expect(recorderOptions(VARIANTS.D, 5, everything).mimeType).toBe('video/webm;codecs=av01,opus')
    expect(recorderOptions(VARIANTS.D, 5, noAv1).mimeType).toBe('video/webm;codecs=vp9,opus')
  })

  it('só áudio: o Opus a 32 kb/s, sem vídeo', () => {
    expect(recorderOptions(VARIANTS[CHOSEN], null, everything)).toEqual({ audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
  })

  it('a escolhida (medidas-gravacao.md) é a F: VP9 até 300 kb/s, sem quadro-chave forçado, com a dica de detalhe', () => {
    expect(CHOSEN).toBe('F')
    expect(recorderOptions(VARIANTS[CHOSEN], 5, everything)).toEqual({ mimeType: 'video/webm;codecs=vp9,opus', audioBitsPerSecond: 32_000, videoBitsPerSecond: 300_000 })
    expect(VARIANTS[CHOSEN].contentHint).toBe('detail')
  })
})

describe('o gravador grava com a escolhida', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream
  })

  it('a tela a 5 quadros: a taxa, o quadro-chave e a dica de detalhe da escolhida', async () => {
    installMediaEnvironment()
    const canvasTrack = new FakeTrack('video', 'canvas')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' })) as never)
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => new FakeMediaStream([canvasTrack]) })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
    const callbacks = { onLive: vi.fn(), onTick: vi.fn(), onFinished: vi.fn(), onCancelled: vi.fn(), onError: vi.fn() }
    await new MeetingRecorder(callbacks).start('tab', undefined, { video: { fps: 5 } })
    const recorder = FakeMediaRecorder.instances.at(-1)!
    expect(recorder.options).toEqual(recorderOptions(VARIANTS[CHOSEN], 5, mime => FakeMediaRecorder.supported.has(mime)))
    expect((canvasTrack as unknown as { contentHint?: string }).contentHint).toBe(VARIANTS[CHOSEN].contentHint)
  })
})
