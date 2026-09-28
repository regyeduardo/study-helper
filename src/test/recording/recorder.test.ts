import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPUTER_AUDIO_NONE, discardRecording, isComputerInput, listAudioInputs, MeetingRecorder, type RecorderCallbacks, type RecordingResult, systemAudioNotice } from '@/lib/recording/recorder'
import { useRecorderStore } from '@/stores/recorder'
import { blobText, COMPUTER_INPUT, FakeAudioContext, MICROPHONE_INPUT, FakeMediaRecorder, installMediaEnvironment, type MediaEnvironment } from '@/test/recording/media-fakes'

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
    expect(context.sources[0].connect).toHaveBeenCalledWith(context.sourceGain)
    expect(context.sources[1].connect).toHaveBeenCalledWith(context.microphoneGain)
    expect(context.microphoneGain.connect).toHaveBeenCalledWith(context.destination)
    expect(context.sourceGain.connect).toHaveBeenCalledWith(context.destination)
    const recorded = lastRecorder().stream.getTracks().map(track => track.label)
    expect(recorded).toEqual(['mix'])
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

  it('microphone mode records the computer input on automatic and leaves it out when turned off', async () => {
    env = installMediaEnvironment({ computerInput: true })
    await new MeetingRecorder(callbacks()).start('microphone')
    expect(FakeAudioContext.instances[0].sources.map(source => source.stream)).toEqual([env.microphoneStream, env.computerStream])
    await new MeetingRecorder(callbacks()).start('microphone', COMPUTER_AUDIO_NONE)
    expect(FakeAudioContext.instances[1].sources.map(source => source.stream)).toEqual([env.microphoneStream])
  })

  it('mixes every computer output on automatic, so the sound comes in whichever output is playing', async () => {
    env = installMediaEnvironment({ computerInput: true })
    const hdmiStream = new MediaStream()
    env.enumerateDevices.mockResolvedValue([MICROPHONE_INPUT, { kind: 'audioinput', deviceId: 'monitor-hdmi', label: 'Monitor of HDMI Audio', groupId: 'g3' }, COMPUTER_INPUT])
    const original = env.getUserMedia.getMockImplementation()!
    env.getUserMedia.mockImplementation(async (constraints: { audio: { deviceId?: { exact: string } } }) => (constraints.audio.deviceId?.exact === 'monitor-hdmi' ? hdmiStream : original(constraints)))
    const handlers = callbacks()
    await new MeetingRecorder(handlers).start('microphone')
    expect(FakeAudioContext.instances[0].sources.map(source => source.stream)).toEqual([env.microphoneStream, hdmiStream, env.computerStream])
    expect(handlers.onLive).toHaveBeenCalledWith(expect.objectContaining({ computerAudio: `Monitor of HDMI Audio + ${COMPUTER_INPUT.label}` }))
  })

  it('records only the microphone without asking for the screen', async () => {
    await new MeetingRecorder(callbacks()).start('microphone')
    expect(env.getDisplayMedia).not.toHaveBeenCalled()
    expect(lastRecorder().options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })
    expect(lastRecorder().stream.getTracks().map(track => track.label)).toEqual(['mix'])
  })
})

describe('MeetingRecorder through the integration', () => {
  it('records the microphone and the chosen source the integration streams, and lets it go when finished', async () => {
    const context = new FakeAudioContext()
    const capture = { context, microphone: { connect: vi.fn() }, source: { connect: vi.fn() }, meters: { microphone: {}, computer: {} }, label: 'SoWork - Google Chrome', choice: { source: { kind: 'window', pid: 7 }, microphone: null }, stop: vi.fn(async () => undefined), switchTo: vi.fn(async () => undefined) }
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.startIntegration(capture as never)
    expect(env.getDisplayMedia).not.toHaveBeenCalled()
    expect(env.getUserMedia).not.toHaveBeenCalled()
    expect(capture.microphone.connect).toHaveBeenCalledWith(context.microphoneGain)
    expect(capture.source.connect).toHaveBeenCalledWith(context.sourceGain)
    expect(lastRecorder().options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })
    expect(handlers.onLive).toHaveBeenCalledWith(expect.objectContaining({ computerAudio: 'SoWork - Google Chrome', sourceChoice: 'pid:7', hasSource: true, hasMicrophone: true }))
    recorder.finish()
    await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalledTimes(1))
    expect(capture.stop).toHaveBeenCalled()
  })
})

describe('MeetingRecorder format', () => {
  it('records light mono audio, about 14 MB an hour', async () => {
    await new MeetingRecorder(callbacks()).start('tab')
    expect(lastRecorder().options?.audioBitsPerSecond).toBe(32000)
    expect(FakeAudioContext.instances[0].destination).toMatchObject({ channelCount: 1, channelCountMode: 'explicit' })
  })

  it('records only the audio when sharing a tab or the screen', async () => {
    await new MeetingRecorder(callbacks()).start('tab')
    expect(lastRecorder().options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })
    expect(lastRecorder().stream.getTracks().map(track => track.kind)).toEqual(['audio'])
    expect([...env.directory.files.keys()][0]).toMatch(/^gravacao-\d+\.webm$/)
  })

  it('falls back to MP4 audio when WebM is not supported', async () => {
    FakeMediaRecorder.supported = new Set(['video/mp4;codecs=avc1,opus', 'video/mp4', 'audio/mp4;codecs=opus'])
    await new MeetingRecorder(callbacks()).start('tab')
    expect(lastRecorder().options).toEqual({ mimeType: 'audio/mp4;codecs=opus', audioBitsPerSecond: 32000 })
    expect([...env.directory.files.keys()][0]).toMatch(/\.mp4$/)
  })

  it('lets the browser pick when nothing listed is supported', async () => {
    FakeMediaRecorder.supported = new Set()
    await new MeetingRecorder(callbacks()).start('tab')
    expect(lastRecorder().options).toEqual({ audioBitsPerSecond: 32000 })
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
    expect(result.mime).toBe('audio/webm;codecs=opus')
    expect(result.file.name).toMatch(/^Reunião .+\.webm$/)
    expect(result.file.name).not.toMatch(/[/:]/)
    expect(result.file.type).toBe('audio/webm;codecs=opus')
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

  it('opens a floating window with the app styles, and keeps it open after finishing so the choices show there', async () => {
    const style = document.head.appendChild(document.createElement('style'))
    style.textContent = '.mini-rec{color:red}'
    const pipDocument = document.implementation.createHTMLDocument('pip')
    const pipWindow = Object.assign(new EventTarget(), { document: pipDocument, close: vi.fn(), focus: vi.fn() })
    const requestWindow = vi.fn(async () => pipWindow)
    ;(window as { documentPictureInPicture?: unknown }).documentPictureInPicture = { requestWindow }
    const handlers = { ...callbacks(), onFloating: vi.fn() }
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    expect(requestWindow).toHaveBeenCalledWith({ width: 340, height: 360 })
    expect(handlers.onFloating).toHaveBeenCalledWith(pipWindow)
    expect(pipDocument.head.textContent).toContain('.mini-rec{color:red}')
    expect(pipDocument.body.className).toBe('floating-recorder')
    recorder.finish()
    await vi.waitFor(() => expect(handlers.onFinished).toHaveBeenCalled())
    expect(pipWindow.close).not.toHaveBeenCalled()
    style.remove()
  })

  it('closes the floating window when the recording is discarded', async () => {
    const pipWindow = Object.assign(new EventTarget(), { document: document.implementation.createHTMLDocument('pip'), close: vi.fn(), focus: vi.fn() })
    ;(window as { documentPictureInPicture?: unknown }).documentPictureInPicture = { requestWindow: vi.fn(async () => pipWindow) }
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    recorder.cancel()
    await vi.waitFor(() => expect(handlers.onCancelled).toHaveBeenCalled())
    expect(pipWindow.close).toHaveBeenCalled()
  })
})

describe('MeetingRecorder freedom while recording', () => {
  it('turns the microphone and the computer sound off and on, which silences only that sound', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    const context = FakeAudioContext.instances[0]
    recorder.setEnabled('microphone', false)
    expect(context.microphoneGain.gain.value).toBe(0)
    expect(context.sourceGain.gain.value).toBe(1)
    expect(handlers.onLive).toHaveBeenLastCalledWith(expect.objectContaining({ microphoneOn: false, sourceOn: true }))
    recorder.setEnabled('source', false)
    recorder.setEnabled('microphone', true)
    expect(context.microphoneGain.gain.value).toBe(1)
    expect(context.sourceGain.gain.value).toBe(0)
    expect(recorder.active).toBe(true)
  })

  it('starts with the microphone off when unchecked, and it can be turned on later', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab', undefined, { microphoneOn: false })
    const context = FakeAudioContext.instances[0]
    expect(context.sources.map(source => source.stream)).toContain(env.microphoneStream)
    expect(context.microphoneGain.gain.value).toBe(0)
    recorder.setEnabled('microphone', true)
    expect(context.microphoneGain.gain.value).toBe(1)
  })

  it('refuses to start with nothing to record', async () => {
    env.getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await expect(new MeetingRecorder(callbacks()).start('microphone', COMPUTER_AUDIO_NONE, { microphoneOn: false })).rejects.toThrow('Não há som para gravar')
  })

  it('pauses without recording and stops the clock, then continues in the same file', async () => {
    vi.useFakeTimers()
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    vi.advanceTimersByTime(2000)
    recorder.pause()
    expect(lastRecorder().state).toBe('paused')
    expect(handlers.onLive).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true }))
    vi.advanceTimersByTime(5000)
    expect(handlers.onTick).toHaveBeenLastCalledWith(2)
    recorder.resume()
    vi.advanceTimersByTime(1000)
    expect(handlers.onTick).toHaveBeenLastCalledWith(3)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    vi.useRealTimers()
  })

  it('switches to another microphone in the middle, keeping the recording', async () => {
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    const headset = new MediaStream()
    env.getUserMedia.mockResolvedValueOnce(headset)
    await recorder.switchMicrophone('headset-1')
    expect(env.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'headset-1' }, echoCancellation: true, noiseSuppression: true } })
    const context = FakeAudioContext.instances[0]
    const oldMicrophone = context.sources.find(source => source.stream === env.microphoneStream)!
    expect(oldMicrophone.disconnect).toHaveBeenCalled()
    expect(context.sources.at(-1)!.stream).toBe(headset)
    expect(context.sources.at(-1)!.connect).toHaveBeenCalledWith(context.microphoneGain)
    expect(handlers.onLive).toHaveBeenLastCalledWith(expect.objectContaining({ microphoneId: 'headset-1' }))
    expect(FakeMediaRecorder.instances).toHaveLength(1)
  })

  it('switches the computer sound to a system input and back to none', async () => {
    env = installMediaEnvironment({ computerInput: true })
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.start('tab')
    await recorder.switchComputerInput(COMPUTER_INPUT.deviceId)
    expect(handlers.onLive).toHaveBeenLastCalledWith(expect.objectContaining({ computerAudio: COMPUTER_INPUT.label, sourceChoice: COMPUTER_INPUT.deviceId, hasSource: true }))
    await recorder.switchComputerInput(COMPUTER_AUDIO_NONE)
    expect(handlers.onLive).toHaveBeenLastCalledWith(expect.objectContaining({ hasSource: false, sourceChoice: COMPUTER_AUDIO_NONE }))
    expect(recorder.active).toBe(true)
  })

  it('asks the integration to switch the source without stopping', async () => {
    const context = new FakeAudioContext()
    const capture = { context, microphone: { connect: vi.fn() }, source: { connect: vi.fn() }, meters: { microphone: {}, computer: {} }, label: 'Sistema', choice: { source: { kind: 'system' }, microphone: null }, stop: vi.fn(async () => undefined) } as Record<string, unknown>
    capture.switchTo = vi.fn(async (next: { source?: unknown; label?: string }) => {
      capture.choice = { source: next.source, microphone: null }
      capture.label = next.label
    })
    const handlers = callbacks()
    const recorder = new MeetingRecorder(handlers)
    await recorder.startIntegration(capture as never)
    await recorder.switchIntegrationSource({ source: { kind: 'window', pid: 9 }, label: 'SoWork' })
    expect(capture.switchTo).toHaveBeenCalledWith({ source: { kind: 'window', pid: 9 }, label: 'SoWork' })
    expect(handlers.onLive).toHaveBeenLastCalledWith(expect.objectContaining({ computerAudio: 'SoWork', sourceChoice: 'pid:9' }))
    expect(capture.stop).not.toHaveBeenCalled()
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
