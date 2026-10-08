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
