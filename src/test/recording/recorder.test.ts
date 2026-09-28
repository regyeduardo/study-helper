import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPUTER_AUDIO_NONE, discardRecording, isComputerInput, listAudioInputs, MeetingRecorder, type RecorderCallbacks, type RecordingResult, systemAudioNotice } from '@/lib/recording/recorder'
import { useRecorderStore } from '@/stores/recorder'
import { blobText, COMPUTER_INPUT, FakeAudioContext, FakeMediaRecorder, installMediaEnvironment, type MediaEnvironment } from '@/test/recording/media-fakes'

const UA = {
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
}

function callbacks(): RecorderCallbacks & { [key in keyof RecorderCallbacks]: ReturnType<typeof vi.fn> } {
  return { onLive: vi.fn(), onTick: vi.fn(), onFinished: vi.fn(), onCancelled: vi.fn(), onError: vi.fn() }
}

function lastRecorder(): FakeMediaRecorder {
  return FakeMediaRecorder.instances.at(-1)!
}

let env: MediaEnvironment

beforeEach(() => {
  document.title = 'Study Helper'
  env = installMediaEnvironment()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { documentPictureInPicture?: unknown }).documentPictureInPicture
})

describe('MeetingRecorder capture', () => {
  it('asks for the tab with its audio and mixes it with the microphone', async () => {
    const handlers = callbacks()
    await new MeetingRecorder(handlers).start('tab')
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: true, audio: true, systemAudio: 'include', monitorTypeSurfaces: 'exclude', selfBrowserSurface: 'exclude' }))
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true } })
    const context = FakeAudioContext.instances[0]
    expect(context.sources).toHaveLength(2)
    expect(context.sources[0].stream.getAudioTracks().map(track => track.label)).toEqual(['tab-audio'])
    expect(context.sources[1].stream).toBe(env.microphoneStream)
    for (const source of context.sources) expect(source.connect).toHaveBeenCalledWith(context.destination)
    const recorded = lastRecorder().stream.getTracks().map(track => track.label)
    expect(recorded).toEqual(['screen', 'mix'])
  })

  it('allows whole monitors in screen mode', async () => {
    await new MeetingRecorder(callbacks()).start('screen')
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ monitorTypeSurfaces: 'include', systemAudio: 'include' }))
  })

  it('still records when the shared surface has no audio', async () => {
    env = installMediaEnvironment({ displayAudio: false })
    await new MeetingRecorder(callbacks()).start('screen')
    expect(FakeAudioContext.instances[0].sources.map(source => source.stream)).toEqual([env.microphoneStream])
  })

  it('keeps recording the tab when the microphone is denied', async () => {
    env.getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const recorder = new MeetingRecorder(callbacks())
    await recorder.start('tab')
    expect(recorder.active).toBe(true)
  })

  it('fails in microphone mode when the microphone is denied', async () => {
    env.getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await expect(new MeetingRecorder(callbacks()).start('microphone')).rejects.toThrow('O navegador não deixou usar o microfone.')
  })

  it('records the computer input when the shared surface brings no audio, in any browser', async () => {
    env = installMediaEnvironment({ displayAudio: false, computerInput: true })
    const handlers = callbacks()
    await new MeetingRecorder(handlers).start('screen')
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: COMPUTER_INPUT.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    expect(FakeAudioContext.instances[0].sources.map(source => source.stream)).toEqual([env.microphoneStream, env.computerStream])
    expect(handlers.onLive).toHaveBeenCalledWith(expect.objectContaining({ computerAudio: COMPUTER_INPUT.label }))
    const live = handlers.onLive!.mock.calls[0][0]
    expect(live.meters.microphone).not.toBeNull()
    expect(live.meters.computer).not.toBeNull()
    expect(live.preview.getVideoTracks().map((track: { label: string }) => track.label)).toEqual(['screen'])
  })

  it('prefers the audio the shared surface brings over the computer input on automatic', async () => {
    env = installMediaEnvironment({ computerInput: true })
    const handlers = callbacks()
    await new MeetingRecorder(handlers).start('tab')
    expect(FakeAudioContext.instances[0].sources).toHaveLength(2)
    expect(handlers.onLive).toHaveBeenCalledWith(expect.objectContaining({ computerAudio: 'som da aba' }))
  })

  it('uses the input the person picked even when the surface has audio', async () => {
    env = installMediaEnvironment({ computerInput: true })
    await new MeetingRecorder(callbacks()).start('tab', COMPUTER_INPUT.deviceId)
    expect(FakeAudioContext.instances[0].sources.map(source => source.stream)).toEqual([env.microphoneStream, env.computerStream])
  })

  it('records no computer audio when the person turns it off', async () => {
    env = installMediaEnvironment({ displayAudio: false, computerInput: true })
    const handlers = callbacks()
    await new MeetingRecorder(handlers).start('screen', COMPUTER_AUDIO_NONE)
    expect(FakeAudioContext.instances[0].sources.map(source => source.stream)).toEqual([env.microphoneStream])
    expect(handlers.onLive!.mock.calls[0][0].meters.computer).toBeNull()
  })

  it('microphone mode adds the computer input only when picked', async () => {
    env = installMediaEnvironment({ computerInput: true })
    await new MeetingRecorder(callbacks()).start('microphone')
    expect(FakeAudioContext.instances[0].sources.map(source => source.stream)).toEqual([env.microphoneStream])
    await new MeetingRecorder(callbacks()).start('microphone', COMPUTER_INPUT.deviceId)
    expect(FakeAudioContext.instances[1].sources.map(source => source.stream)).toEqual([env.microphoneStream, env.computerStream])
  })

  it('records only the microphone without asking for the screen', async () => {
    await new MeetingRecorder(callbacks()).start('microphone')
    expect(env.getDisplayMedia).not.toHaveBeenCalled()
    expect(lastRecorder().options).toEqual({ mimeType: 'audio/webm;codecs=opus' })
    expect(lastRecorder().stream.getTracks().map(track => track.label)).toEqual(['mix'])
  })
})

describe('MeetingRecorder format', () => {
  it('prefers WebM with VP8 and Opus, encoded by the browser itself, over the video card H.264', async () => {
    await new MeetingRecorder(callbacks()).start('tab')
    expect(lastRecorder().options).toEqual({ mimeType: 'video/webm;codecs=vp8,opus' })
    expect([...env.directory.files.keys()][0]).toMatch(/^gravacao-\d+\.webm$/)
  })

  it('falls back to MP4 when WebM is not supported', async () => {
    FakeMediaRecorder.supported = new Set(['video/mp4;codecs=avc1,opus', 'video/mp4', 'audio/mp4;codecs=opus'])
    await new MeetingRecorder(callbacks()).start('tab')
    expect(lastRecorder().options).toEqual({ mimeType: 'video/mp4;codecs=avc1,opus' })
    expect([...env.directory.files.keys()][0]).toMatch(/\.mp4$/)
  })

  it('lets the browser pick when nothing listed is supported', async () => {
    FakeMediaRecorder.supported = new Set()
    await new MeetingRecorder(callbacks()).start('tab')
    expect(lastRecorder().options).toBeUndefined()
  })
})

describe('MeetingRecorder saving', () => {
  it('writes one-second chunks to OPFS and hands back the finished file', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    const media = lastRecorder()
    expect(media.timeslice).toBe(1000)
    media.emit('chunk-1|')
    media.emit('chunk-2|')
    const handle = [...env.directory.files.values()][0]
    recorder.finish()
    await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalledTimes(1))
    expect(handle.chunks).toHaveLength(2)
    expect(handle.closed).toBe(true)
    const result = handlers.onFinished.mock.calls[0][0] as RecordingResult
    expect(await blobText(result.file)).toBe('chunk-1|chunk-2|')
    expect(result.mime).toBe('video/webm;codecs=vp8,opus')
    expect(result.file.name).toMatch(/^Reunião .+\.webm$/)
    expect(result.file.name).not.toMatch(/[/:]/)
    expect(result.file.type).toBe('video/webm;codecs=vp8,opus')
    expect(handlers.onError).not.toHaveBeenCalled()
  })

  it('stops every captured track and closes the audio context', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    recorder.finish()
    await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalled())
    for (const track of [...env.displayStream.getTracks(), ...env.microphoneStream.getTracks()]) expect(track.stop).toHaveBeenCalled()
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled()
    expect(recorder.active).toBe(false)
  })

  it('discards the OPFS file when cancelled', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    lastRecorder().emit('data')
    const name = [...env.directory.files.keys()][0]
    recorder.cancel()
    await vi.waitFor(() => expect(handlers.onCancelled).toHaveBeenCalledTimes(1))
    expect(env.directory.removeEntry).toHaveBeenCalledWith(name)
    expect(handlers.onFinished).not.toHaveBeenCalled()
  })

  it('finishes when sharing is stopped from the browser bar', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    lastRecorder().emit('bar')
    env.displayStream.getVideoTracks()[0].end()
    await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalledTimes(1))
    expect(handlers.onCancelled).not.toHaveBeenCalled()
  })

  it('reports an error when the file cannot be saved', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    const handle = [...env.directory.files.values()][0]
    handle.getFile = async () => {
      throw new Error('quota exceeded')
    }
    recorder.finish()
    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalledWith('quota exceeded'))
  })

  it('removes a leftover recording by name', async () => {
    await env.directory.getFileHandle('gravacao-1.webm')
    await discardRecording('gravacao-1.webm')
    expect(env.directory.files.has('gravacao-1.webm')).toBe(false)
  })
})

describe('MeetingRecorder status', () => {
  it('marks the document title while recording and restores it after', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    expect(document.title).toBe('● Gravando — Study Helper')
    recorder.finish()
    await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalled())
    expect(document.title).toBe('Study Helper')
  })

  it('ticks every second and reports the duration', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const handlers = callbacks()
      const recorder = new MeetingRecorder(handlers)
      await recorder.start('microphone')
      vi.advanceTimersByTime(3000)
      expect(handlers.onTick.mock.calls.map(call => call[0])).toEqual([1, 2, 3])
      recorder.finish()
      await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalled())
      expect((handlers.onFinished.mock.calls[0][0] as RecordingResult).durationSeconds).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens a floating window whose buttons finish the recording', async () => {
    const pipDocument = document.implementation.createHTMLDocument('pip')
    const pipWindow = Object.assign(new EventTarget(), { document: pipDocument, close: vi.fn() })
    const requestWindow = vi.fn(async () => pipWindow)
    ;(window as { documentPictureInPicture?: unknown }).documentPictureInPicture = { requestWindow }
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    expect(requestWindow).toHaveBeenCalledWith({ width: 320, height: 250 })
    expect(pipDocument.querySelector('#player [data-miniplayer] video')).not.toBeNull()
    expect(pipDocument.getElementById('timer')?.textContent).toContain('00:00')
    ;(pipDocument.getElementById('finish') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalled())
    expect(pipWindow.close).toHaveBeenCalled()
  })
})

describe('computer audio notice and inputs', () => {
  it('points every browser to the system input, named per system, never to a single browser', () => {
    expect(systemAudioNotice(UA.firefox)).toMatch(/Monitor of/)
    expect(systemAudioNotice(UA.chromeLinux)).toMatch(/Monitor of/)
    expect(systemAudioNotice(UA.chromeWindows)).toMatch(/Mixagem estéreo/)
    expect(systemAudioNotice(UA.safari)).toMatch(/BlackHole/)
    for (const agent of Object.values(UA)) expect(systemAudioNotice(agent)).not.toMatch(/Chrome|Firefox|Safari|Edge/)
  })

  it('recognizes system inputs by name', () => {
    for (const label of ['Monitor of Built-in Audio Analog Stereo', 'Mixagem estéreo (Realtek)', 'Stereo Mix', 'BlackHole 2ch', 'CABLE Output (VB-Audio)']) expect(isComputerInput(label)).toBe(true)
    expect(isComputerInput('Microfone interno')).toBe(false)
  })

  it('lists audio inputs without the default aliases and asks permission only when told', async () => {
    env = installMediaEnvironment({ computerInput: true })
    expect(await listAudioInputs()).toEqual([
      { deviceId: 'mic-1', label: 'Microfone interno', computer: false },
      { deviceId: COMPUTER_INPUT.deviceId, label: COMPUTER_INPUT.label, computer: true },
    ])
    expect(env.getUserMedia).not.toHaveBeenCalled()
    await listAudioInputs(true)
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(env.microphoneStream.getTracks()[0].stop).toHaveBeenCalled()
  })
})

describe('recorder store', () => {
  afterEach(() => {
    useRecorderStore.setState({ active: false, seconds: 0, mode: null, result: null, error: null })
  })

  it('becomes active on start and exposes the result on finish', async () => {
    await useRecorderStore.getState().start('tab')
    expect(useRecorderStore.getState()).toMatchObject({ active: true, mode: 'tab', result: null })
    lastRecorder().emit('x')
    useRecorderStore.getState().finish()
    await vi.waitFor(() => expect(useRecorderStore.getState().result).not.toBeNull())
    expect(useRecorderStore.getState()).toMatchObject({ active: false, mode: null })
  })

  it('also finishes when stopped from the browser bar', async () => {
    await useRecorderStore.getState().start('screen')
    env.displayStream.getVideoTracks()[0].end()
    await vi.waitFor(() => expect(useRecorderStore.getState().result).not.toBeNull())
    expect(useRecorderStore.getState().active).toBe(false)
  })

  it('stores the error and rethrows when the browser refuses', async () => {
    env.getDisplayMedia.mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
    await expect(useRecorderStore.getState().start('tab')).rejects.toThrow()
    expect(useRecorderStore.getState()).toMatchObject({ active: false, mode: null, error: 'no' })
  })
})
