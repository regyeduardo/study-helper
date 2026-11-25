// Spec 007, história 3 (T095, research R12): as variantes medidas montam as opções certas do gravador, e o app grava com a escolhida.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MeetingRecorder } from '@/lib/recording/recorder'
import { AUDIO_BITS_PER_SECOND, CHOSEN, OPTIMIZED, recorderOptions, VARIANTS } from '@/lib/recording/variants'
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

// Spec 007, FR-023 (T151/T152): a escolhida na medida a 30 fps (medidas-gravacao.md): VP9 até 250 kb/s, quadro só quando a tela muda e
// quadro-chave a cada 30 s (a cada 2 min, pular um trecho de movimento passava de 2 s).
describe('a gravação otimizada', () => {
  it('VP9 até 250 kb/s a 30 fps, quadro-chave a cada 30 s, dica de texto, quadro só quando a tela muda', () => {
    expect(recorderOptions(OPTIMIZED, 30, everything)).toEqual({ mimeType: 'video/webm;codecs=vp9,opus', audioBitsPerSecond: 32_000, videoBitsPerSecond: 250_000, videoKeyFrameIntervalDuration: 30_000 })
    expect(OPTIMIZED.contentHint).toBe('text')
    expect(OPTIMIZED.onlyChanges).toBe(true)
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

  it('a gravação otimizada grava com as opções dela', async () => {
    installMediaEnvironment()
    const canvasTrack = Object.assign(new FakeTrack('video', 'canvas'), { requestFrame: vi.fn() })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' })) as never)
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => new FakeMediaStream([canvasTrack]) })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
    const callbacks = { onLive: vi.fn(), onTick: vi.fn(), onFinished: vi.fn(), onCancelled: vi.fn(), onError: vi.fn() }
    await new MeetingRecorder(callbacks).start('tab', undefined, { video: { fps: 30, optimized: true } })
    expect(FakeMediaRecorder.instances.at(-1)!.options).toEqual(recorderOptions(OPTIMIZED, 30, mime => FakeMediaRecorder.supported.has(mime)))
    expect((canvasTrack as unknown as { contentHint?: string }).contentHint).toBe('text')
  })
})
