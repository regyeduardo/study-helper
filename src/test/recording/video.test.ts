import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MeetingRecorder, type RecorderCallbacks, type RecordingResult } from '@/lib/recording/recorder'
import type { IntegrationCapture } from '@/lib/recording/integration'
import { FakeAudioContext, FakeMediaRecorder, FakeMediaStream, FakeTrack, installMediaEnvironment, type MediaEnvironment } from '@/test/recording/media-fakes'

function callbacks(): RecorderCallbacks & { onFinished: ReturnType<typeof vi.fn> } {
  return { onLive: vi.fn(), onTick: vi.fn(), onFinished: vi.fn(), onCancelled: vi.fn(), onError: vi.fn() }
}

function lastRecorder(): FakeMediaRecorder {
  return FakeMediaRecorder.instances.at(-1)!
}

let env: MediaEnvironment
let captureStream: ReturnType<typeof vi.fn>
let drawn: unknown[]

beforeEach(() => {
  document.title = 'Study Helper'
  env = installMediaEnvironment()
  drawn = []
  captureStream = vi.fn(() => new FakeMediaStream([new FakeTrack('video', 'canvas')]))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: (source: unknown) => void drawn.push(source), fillRect: vi.fn(), fillStyle: '' })) as never)
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: captureStream })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream
})

describe('recording the screen as video', () => {
  for (const fps of [5, 30] as const) {
    it(`asks the screen at ${fps} fps and records video and audio in one file`, async () => {
      await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps } })
      expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: { frameRate: fps }, audio: true }))
      expect(captureStream).toHaveBeenCalledWith(fps)
      const recorder = lastRecorder()
      expect(recorder.stream.getVideoTracks().map(track => track.label)).toEqual(['canvas'])
      expect(recorder.stream.getAudioTracks().map(track => track.label)).toEqual(['mix'])
      expect(recorder.options?.mimeType).toMatch(/^video\//)
    })
  }

  it('the finished file is a video', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab', undefined, { video: { fps: 5 } })
    lastRecorder().emit('quadro')
    recorder.finish()
    await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalled())
    const result = handlers.onFinished.mock.calls[0][0] as RecordingResult
    expect(result.mime).toMatch(/^video\//)
    expect(result.file.type).toMatch(/^video\//)
  })

  it('the screen keeps being drawn at the chosen rate', async () => {
    vi.useFakeTimers()
    await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps: 5 } })
    drawn = []
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawn.length).toBeGreaterThanOrEqual(5)
    expect(drawn.length).toBeLessThanOrEqual(6)
  })

  it('without video it records only the sound, as before', async () => {
    await new MeetingRecorder(callbacks()).start('tab')
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: true }))
    expect(captureStream).not.toHaveBeenCalled()
    expect(lastRecorder().stream.getVideoTracks()).toEqual([])
    expect(lastRecorder().options?.mimeType).toMatch(/^audio\//)
  })

  it('recording only the microphone, turning the screen on asks the screen at the chosen rate', async () => {
    await new MeetingRecorder(callbacks()).start('microphone', undefined, { video: { fps: 30 } })
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: { frameRate: 30 } }))
    expect(lastRecorder().stream.getVideoTracks().map(track => track.label)).toEqual(['canvas'])
  })

  it('with the integration, the screen is asked at the chosen rate and recorded with its sound', async () => {
    const capture = { context: new FakeAudioContext(), microphone: { connect: vi.fn() }, source: { connect: vi.fn() }, label: 'Sistema inteiro', choice: { microphone: null, source: { kind: 'system' } }, stop: vi.fn(async () => undefined) }
    await new MeetingRecorder(callbacks()).startIntegration(capture as unknown as IntegrationCapture, { video: { fps: 5 } })
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: { frameRate: 5 } }))
    expect(lastRecorder().stream.getVideoTracks().map(track => track.label)).toEqual(['canvas'])
    expect(lastRecorder().options?.mimeType).toMatch(/^video\//)
  })
})

// Spec 007, FR-023 (research R17, T152): a gravação otimizada grava a 30 fps, mas o canvas só manda quadro quando a tela muda.
describe('a gravação otimizada', () => {
  let screenFrames: (() => void)[]
  let canvasTrack: FakeTrack & { requestFrame: ReturnType<typeof vi.fn>; contentHint?: string }

  beforeEach(() => {
    screenFrames = []
    canvasTrack = Object.assign(new FakeTrack('video', 'canvas'), { requestFrame: vi.fn() })
    captureStream.mockImplementation(() => new FakeMediaStream([canvasTrack]))
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value(callback: () => void) {
        screenFrames.push(callback)
        return screenFrames.length
      },
    })
  })

  afterEach(() => {
    delete (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback
  })

  // the screen hands a new frame: the callbacks waiting run, as the browser does
  const newScreenFrame = () => screenFrames.splice(0).forEach(callback => callback())

  // T170 (vídeo da gravação, 24/11): com a aba do app escondida (a pessoa na aba da reunião), o aviso de quadro novo não roda e a
  // otimizada caía para 1 quadro por segundo; o contador de quadros recebidos pelo vídeo continua andando com a aba escondida
  it('com a aba do app escondida, o contador de quadros do vídeo mantém os 30 por segundo enquanto a tela muda', async () => {
    let received = 0
    Object.defineProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality', { configurable: true, value: () => ({ totalVideoFrames: received }) })
    try {
      vi.useFakeTimers()
      await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps: 30, optimized: true } })
      await vi.advanceTimersByTimeAsync(1500)
      // the screen changes every frame and no callback runs (hidden page): only the counter grows
      canvasTrack.requestFrame.mockClear()
      for (let tick = 0; tick < 30; tick++) {
        received++
        await vi.advanceTimersByTimeAsync(1000 / 30)
      }
      expect(canvasTrack.requestFrame.mock.calls.length).toBeGreaterThanOrEqual(28)
      // the screen stops: the second that settles the picture, then one frame a second
      await vi.advanceTimersByTimeAsync(1100)
      canvasTrack.requestFrame.mockClear()
      await vi.advanceTimersByTimeAsync(3000)
      expect(canvasTrack.requestFrame.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(canvasTrack.requestFrame.mock.calls.length).toBeLessThanOrEqual(4)
    } finally {
      delete (HTMLVideoElement.prototype as { getVideoPlaybackQuality?: unknown }).getVideoPlaybackQuality
    }
  })

  // T171 ("gravações otimizadas ainda ficam 100% com tela escura", dono, 24/11, no Firefox): lá o requestFrame fica no stream do canvas
  // (CanvasCaptureMediaStream), não na trilha; pedindo só à trilha, o único quadro gravado era o preto de antes da tela chegar
  // (medido no Waterfox 153: brilho 16 de 255 no vídeo inteiro, contra a tela acompanhada na de 30 fps)
  it('no Firefox, pede o quadro ao stream do canvas, onde fica o requestFrame', async () => {
    const firefoxStream = Object.assign(new FakeMediaStream([new FakeTrack('video', 'canvas')]), { requestFrame: vi.fn() })
    captureStream.mockImplementation(() => firefoxStream)
    vi.useFakeTimers()
    await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps: 30, optimized: true } })
    newScreenFrame()
    await vi.advanceTimersByTimeAsync(1000)
    expect(firefoxStream.requestFrame.mock.calls.length).toBeGreaterThanOrEqual(28)
    firefoxStream.requestFrame.mockClear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(firefoxStream.requestFrame.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(firefoxStream.requestFrame.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('pede a tela a 30 fps e grava o canvas sem taxa fixa, com a dica de texto', async () => {
    await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps: 30, optimized: true } })
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: { frameRate: 30 }, audio: true }))
    expect(captureStream).toHaveBeenCalledWith(0)
    expect(canvasTrack.contentHint).toBe('text')
    expect(lastRecorder().options?.mimeType).toMatch(/^video\//)
  })

  it('tela parada: um quadro por segundo depois de firmar a imagem; tela mudando: 30 por segundo', async () => {
    vi.useFakeTimers()
    await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps: 30, optimized: true } })
    newScreenFrame()
    // the second after a change, the picture settles at 30 fps
    await vi.advanceTimersByTimeAsync(1000)
    expect(canvasTrack.requestFrame.mock.calls.length).toBeGreaterThanOrEqual(28)
    // still screen: only the frame of each second
    canvasTrack.requestFrame.mockClear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(canvasTrack.requestFrame.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(canvasTrack.requestFrame.mock.calls.length).toBeLessThanOrEqual(4)
    // the screen changes every frame: 30 per second
    canvasTrack.requestFrame.mockClear()
    for (let tick = 0; tick < 30; tick++) {
      newScreenFrame()
      await vi.advanceTimersByTimeAsync(1000 / 30)
    }
    expect(canvasTrack.requestFrame.mock.calls.length).toBeGreaterThanOrEqual(28)
  })

  it('tela parada não é desenhada de novo a cada quadro', async () => {
    vi.useFakeTimers()
    await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps: 30, optimized: true } })
    newScreenFrame()
    await vi.advanceTimersByTimeAsync(1500)
    drawn = []
    await vi.advanceTimersByTimeAsync(3000)
    expect(drawn.length).toBeLessThanOrEqual(4)
  })

  it('onde o navegador não avisa o quadro novo da tela, grava a 30 fps como a de 30', async () => {
    delete (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback
    vi.useFakeTimers()
    await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps: 30, optimized: true } })
    canvasTrack.requestFrame.mockClear()
    await vi.advanceTimersByTimeAsync(2000)
    expect(canvasTrack.requestFrame.mock.calls.length).toBeGreaterThanOrEqual(56)
  })

  it('a de 30 fps continua com taxa fixa e sem pedir quadro', async () => {
    vi.useFakeTimers()
    await new MeetingRecorder(callbacks()).start('tab', undefined, { video: { fps: 30 } })
    expect(captureStream).toHaveBeenCalledWith(30)
    await vi.advanceTimersByTimeAsync(1000)
    expect(canvasTrack.requestFrame).not.toHaveBeenCalled()
  })

  it('com a integração, também só manda quadro quando a tela muda', async () => {
    const capture = { context: new FakeAudioContext(), microphone: { connect: vi.fn() }, source: { connect: vi.fn() }, label: 'Sistema inteiro', choice: { microphone: null, source: { kind: 'system' } }, stop: vi.fn(async () => undefined) }
    await new MeetingRecorder(callbacks()).startIntegration(capture as unknown as IntegrationCapture, { video: { fps: 30, optimized: true } })
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: { frameRate: 30 } }))
    expect(captureStream).toHaveBeenCalledWith(0)
  })
})
