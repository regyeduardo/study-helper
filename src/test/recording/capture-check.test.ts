import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureCheck, type CheckStatus, COMPUTER_AUDIO_AUTO, COMPUTER_AUDIO_NONE, MeetingRecorder } from '@/lib/recording/recorder'
import { COMPUTER_INPUT, FakeAudioContext, type FakeMediaStream, installMediaEnvironment, MICROPHONE_INPUT, type MediaEnvironment } from '@/test/recording/media-fakes'

const HDMI_INPUT = { kind: 'audioinput', deviceId: 'monitor-2', label: 'Monitor of HDMI Audio', groupId: 'g3' }
const LISTENING = { microphoneOn: true, microphoneId: null, computerAudio: COMPUTER_AUDIO_AUTO }

let env: MediaEnvironment
let seen: CheckStatus[]

function refuse(deviceId: string): void {
  const open = env.getUserMedia.getMockImplementation()!
  env.getUserMedia.mockImplementation(async (constraints: { audio: { deviceId?: { exact: string } } | boolean }) => {
    if (typeof constraints.audio === 'object' && constraints.audio.deviceId?.exact === deviceId) throw new DOMException('refused', 'NotAllowedError')
    return open(constraints)
  })
}

beforeEach(() => {
  env = installMediaEnvironment({ computerInput: true })
  seen = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('CaptureCheck before recording', () => {
  it('opens the microphone and the computer inputs with a meter on each side, and names the input the browser refused', async () => {
    env.enumerateDevices.mockResolvedValue([MICROPHONE_INPUT, COMPUTER_INPUT, HDMI_INPUT])
    refuse(HDMI_INPUT.deviceId)
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    const context = FakeAudioContext.instances[0]
    const status = seen.at(-1)!
    expect(status.microphone).toBe('open')
    expect(status.computerAudio).toBe(COMPUTER_INPUT.label)
    expect(status.refused).toEqual([HDMI_INPUT.label])
    expect(status.meters.microphone).toBe(context.analysers[0])
    expect(status.meters.computer).toBe(context.analysers[1])
    expect(context.sources.map(source => source.stream)).toEqual([env.microphoneStream, env.computerStream])
    expect(context.sources[0].connect).toHaveBeenCalledWith(context.analysers[0])
    expect(context.sources[1].connect).toHaveBeenCalledWith(context.analysers[1])
  })

  it('says the microphone was refused instead of going quiet', async () => {
    env.getUserMedia.mockImplementation(async (constraints: { audio: { deviceId?: { exact: string } } | boolean }) => {
      if (typeof constraints.audio === 'object' && constraints.audio.deviceId?.exact === COMPUTER_INPUT.deviceId) return env.computerStream
      throw new DOMException('refused', 'NotAllowedError')
    })
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    expect(seen.at(-1)).toMatchObject({ microphone: 'refused', computerAudio: COMPUTER_INPUT.label })
    expect(seen.at(-1)!.meters.microphone).toBeNull()
  })

  it('leaves out what the person turned off', async () => {
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen({ microphoneOn: false, microphoneId: null, computerAudio: COMPUTER_AUDIO_NONE })
    expect(env.getUserMedia).not.toHaveBeenCalled()
    expect(seen.at(-1)).toMatchObject({ microphone: 'off', computerAudio: '', refused: [] })
    expect(seen.at(-1)!.meters).toEqual({ microphone: null, computer: null })
  })

  it('plays a test sound and tells that the computer side heard it', async () => {
    vi.useFakeTimers()
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    const context = FakeAudioContext.instances[0]
    const heard = check.testSound()
    await vi.advanceTimersByTimeAsync(100)
    expect(context.oscillators[0].start).toHaveBeenCalled()
    expect(context.oscillators[0].stop).not.toHaveBeenCalled()
    context.analysers[1].level = 0.04
    await vi.advanceTimersByTimeAsync(200)
    expect(await heard).toBe(true)
    expect(context.resume).toHaveBeenCalled()
    expect(context.oscillators[0].stop).toHaveBeenCalled()
  })

  it('tells that the test sound did not arrive when the computer side stays silent', async () => {
    vi.useFakeTimers()
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    const heard = check.testSound()
    await vi.advanceTimersByTimeAsync(3000)
    expect(await heard).toBe(false)
    expect(FakeAudioContext.instances[0].oscillators[0].stop).toHaveBeenCalled()
  })

  it('has no test sound to play without a computer sound to listen to', async () => {
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen({ ...LISTENING, computerAudio: COMPUTER_AUDIO_NONE })
    expect(await check.testSound()).toBe(false)
    expect(FakeAudioContext.instances[0].oscillators).toHaveLength(0)
  })

  it('shows the chosen window before recording and listens to the sound it brings', async () => {
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    await check.pickDisplay('tab', null)
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: true, audio: true, monitorTypeSurfaces: 'exclude' }))
    const status = seen.at(-1)!
    const context = FakeAudioContext.instances[0]
    expect((status.preview as unknown as FakeMediaStream).getTracks().map(track => track.label)).toEqual(['screen'])
    expect(status).toMatchObject({ computerAudio: 'som da aba', fromDisplay: true })
    expect(context.sources.at(-1)!.stream.getTracks().map(track => track.label)).toEqual(['tab-audio'])
    expect(context.sources.at(-1)!.connect).toHaveBeenCalledWith(context.analysers[1])
    expect(env.computerStream.getTracks()[0].stop).toHaveBeenCalled()
    await check.listen({ ...LISTENING, microphoneId: MICROPHONE_INPUT.deviceId })
    expect(env.displayStream.getAudioTracks()[0].stop).not.toHaveBeenCalled()
  })

  it('keeps the computer input when the chosen window brings no sound, as in Firefox', async () => {
    env = installMediaEnvironment({ computerInput: true, displayAudio: false })
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    await check.pickDisplay('screen', 5)
    expect(env.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: { frameRate: 5 }, monitorTypeSurfaces: 'include' }))
    expect(seen.at(-1)).toMatchObject({ computerAudio: COMPUTER_INPUT.label, fromDisplay: false })
    expect(seen.at(-1)!.preview).not.toBeNull()
  })

  it('forgets the window when sharing is stopped from the browser bar', async () => {
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    await check.pickDisplay('tab', null)
    env.displayStream.getVideoTracks()[0].end()
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ preview: null, fromDisplay: false, computerAudio: COMPUTER_INPUT.label }))
    expect(check.handDisplay()).toBeNull()
  })

  it('hands the chosen window to the recording, which does not ask for it again', async () => {
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    await check.pickDisplay('tab', null)
    const display = check.handDisplay()
    await check.stop()
    expect(display).toBe(env.displayStream)
    expect(env.displayStream.getTracks().some(track => track.stop.mock.calls.length > 0)).toBe(false)
    env.getDisplayMedia.mockClear()
    const recorder = new MeetingRecorder({ onTick: vi.fn(), onFinished: vi.fn(), onCancelled: vi.fn(), onError: vi.fn() })
    await recorder.start('tab', COMPUTER_AUDIO_AUTO, { display: display as unknown as MediaStream })
    expect(env.getDisplayMedia).not.toHaveBeenCalled()
    expect(FakeAudioContext.instances.at(-1)!.sources[0].stream.getTracks().map(track => track.label)).toEqual(['tab-audio'])
  })

  it('closes a window nobody took when the check ends', async () => {
    const check = new CaptureCheck(status => seen.push(status))
    await check.pickDisplay('tab', null)
    await check.stop()
    expect(env.displayStream.getTracks().every(track => track.stop.mock.calls.length > 0)).toBe(true)
  })

  it('releases every device when the check ends', async () => {
    const check = new CaptureCheck(status => seen.push(status))
    await check.listen(LISTENING)
    await check.stop()
    expect(env.microphoneStream.getTracks()[0].stop).toHaveBeenCalled()
    expect(env.computerStream.getTracks()[0].stop).toHaveBeenCalled()
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled()
  })
})
