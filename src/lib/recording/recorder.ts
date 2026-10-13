import type { RecordingMark, SourceStorage } from '@/types/domain'
import type { IntegrationCapture } from '@/lib/recording/integration'
import { integrationSourceKey, type IntegrationSourceChoice } from '@/lib/recording/integration'
import type { Meters } from '@/lib/recording/miniplayer'
import { ScreenCanvas } from '@/lib/recording/frame-grab'
import { makeSeekable } from '@/lib/recording/seekable'

export type CaptureMode = 'tab' | 'screen' | 'microphone' | 'integration'

export type VideoFps = 5 | 30

export const COMPUTER_AUDIO_AUTO = 'auto'
export const COMPUTER_AUDIO_NONE = 'none'

export interface AudioInput {
  deviceId: string
  label: string
  computer: boolean
}

export interface LiveCapture {
  preview: MediaStream | null
  meters: Meters
  computerAudio: string
  hasMicrophone: boolean
  hasSource: boolean
  microphoneOn: boolean
  sourceOn: boolean
  microphoneId: string | null
  sourceChoice: string
  paused: boolean
  screenOn: boolean
}

export interface StartOptions {
  microphoneOn?: boolean
  microphoneId?: string | null
  video?: { fps: VideoFps } | null
  destination?: SourceStorage
  display?: MediaStream | null
}

export interface RecordingResult {
  file: File
  mime: string
  durationSeconds: number
  storedName: string
  marks?: RecordingMark[]
  destination?: SourceStorage
}

export interface RecorderCallbacks {
  onLive?(live: LiveCapture): void
  onFloating?(floating: Window | null): void
  onTick(seconds: number): void
  onFinished(result: RecordingResult): void
  onCancelled(): void
  onError(message: string): void
}

const MIME_OPTIONS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=opus']
const VIDEO_MIME_OPTIONS = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
const VIDEO_BITS_PER_SECOND: Record<VideoFps, number> = { 5: 600_000, 30: 2_500_000 }
const RECORDING_TITLE = '● Gravando — '
const COMPUTER_INPUT = /monitor|stereo mix|mixagem|what u hear|loopback|blackhole|soundflower|vb-audio|cable output/i
const CHUNK_MS = 1000
const AUDIO_BITS_PER_SECOND = 32000

interface PictureInPictureApi {
  requestWindow(options: { width: number; height: number }): Promise<Window>
}

export function systemAudioNotice(agent: string = navigator.userAgent): string {
  const mac = /Mac OS X/.test(agent) && !/iPhone|iPad/.test(agent)
  const windows = /Windows/.test(agent)
  const input = mac ? 'um cabo virtual de áudio, como o BlackHole' : windows ? 'a entrada "Mixagem estéreo"' : 'a entrada "Monitor of…"'
  return `O som do computador vem junto com a tela quando o navegador entrega; quando não entrega, o app grava ${input} como som do computador. Escolha abaixo.`
}

export function isComputerInput(label: string): boolean {
  return COMPUTER_INPUT.test(label)
}

export async function listAudioInputs(askPermission = false): Promise<AudioInput[]> {
  if (askPermission) {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach(track => track.stop())
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
    .map(device => ({ deviceId: device.deviceId, label: device.label, computer: isComputerInput(device.label) }))
}

function supportedMime(video: boolean): string {
  return (video ? VIDEO_MIME_OPTIONS : MIME_OPTIONS).find(mime => MediaRecorder.isTypeSupported(mime)) ?? ''
}

function extensionOf(mime: string): string {
  return mime.includes('mp4') ? 'mp4' : 'webm'
}

function openMicrophone(id: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true } })
}

async function openComputerInputs(choice: string): Promise<{ streams: MediaStream[]; label: string; refused: string[] }> {
  if (choice === COMPUTER_AUDIO_NONE) return { streams: [], label: '', refused: [] }
  const inputs = await listAudioInputs().catch(() => [])
  const picked = choice === COMPUTER_AUDIO_AUTO ? inputs.filter(item => item.computer) : inputs.filter(item => item.deviceId === choice)
  const opened = await Promise.all(
    picked.map(input =>
      navigator.mediaDevices
        .getUserMedia({ audio: { deviceId: { exact: input.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then(stream => ({ stream, label: input.label }))
        .catch(() => null),
    ),
  )
  const found = opened.filter(item => item !== null)
  return { streams: found.map(item => item.stream), label: found.map(item => item.label).join(' + '), refused: picked.filter((_, index) => !opened[index]).map(input => input.label) }
}

const TEST_SOUND_VOLUME = 0.1
const TEST_SOUND_MS = 1500
const TEST_SOUND_STEP_MS = 100
export const SOUND_LEVEL = 0.01
export const VOICE_LEVEL = 0.02

export function hears(analyser: AnalyserNode, level: number): boolean {
  const samples = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(samples)
  let sum = 0
  for (const sample of samples) sum += ((sample - 128) / 128) ** 2
  return Math.sqrt(sum / samples.length) > level
}

export async function playTestSound(context: AudioContext, analyser: AnalyserNode): Promise<boolean> {
  await context.resume()
  const tone = context.createOscillator()
  tone.frequency.value = 660
  const volume = context.createGain()
  volume.gain.value = TEST_SOUND_VOLUME
  tone.connect(volume)
  volume.connect(context.destination)
  tone.start()
  let heard = false
  for (let waited = 0; waited < TEST_SOUND_MS && !heard; waited += TEST_SOUND_STEP_MS) {
    await new Promise(resolve => setTimeout(resolve, TEST_SOUND_STEP_MS))
    heard = hears(analyser, SOUND_LEVEL)
  }
  tone.stop()
  volume.disconnect()
  return heard
}

export interface CheckChoice {
  microphoneOn: boolean
  microphoneId: string | null
  computerAudio: string
}

export interface CheckStatus {
  preview: MediaStream | null
  meters: Meters
  microphone: 'off' | 'open' | 'refused'
  computerAudio: string
  refused: string[]
  fromDisplay: boolean
}

type CheckSide = 'microphone' | 'computer'

function displayRequest(mode: CaptureMode, fps: VideoFps | null): DisplayMediaStreamOptions {
  const video = fps ? { frameRate: fps } : true
  if (mode !== 'tab' && mode !== 'screen') return { video, audio: false }
  return {
    video,
    audio: true,
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    systemAudio: 'include',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: mode === 'screen' ? 'include' : 'exclude',
  } as DisplayMediaStreamOptions
}

function displayAudioLabel(mode: CaptureMode): string {
  return mode === 'tab' ? 'som da aba' : 'som da tela'
}

export class CaptureCheck {
  private context: AudioContext | null = null
  private analysers: Record<CheckSide, AnalyserNode> | null = null
  private plugged: Record<CheckSide, { nodes: AudioNode[]; streams: MediaStream[] }> = { microphone: { nodes: [], streams: [] }, computer: { nodes: [], streams: [] } }
  private turn = 0
  private choice: CheckChoice = { microphoneOn: false, microphoneId: null, computerAudio: COMPUTER_AUDIO_NONE }
  private display: MediaStream | null = null
  private displayMode: CaptureMode = 'tab'
  private handed = false
  private status: CheckStatus = { preview: null, meters: { microphone: null, computer: null }, microphone: 'off', computerAudio: '', refused: [], fromDisplay: false }

  constructor(private readonly onChange: (status: CheckStatus) => void) {}

  async listen(choice: CheckChoice): Promise<void> {
    const turn = ++this.turn
    this.choice = choice
    const microphone = choice.microphoneOn ? await openMicrophone(choice.microphoneId).catch(() => null) : null
    const shared = this.display?.getAudioTracks().length && choice.computerAudio === COMPUTER_AUDIO_AUTO ? this.display : null
    const computer = shared ? { streams: [new MediaStream(shared.getAudioTracks())], label: displayAudioLabel(this.displayMode), refused: [] } : await openComputerInputs(choice.computerAudio)
    if (turn !== this.turn) {
      this.release([...(microphone ? [microphone] : []), ...computer.streams])
      return
    }
    this.plug('microphone', microphone ? [microphone] : [])
    this.plug('computer', computer.streams)
    this.status = { ...this.status, microphone: !choice.microphoneOn ? 'off' : microphone ? 'open' : 'refused', computerAudio: computer.label, refused: computer.refused, fromDisplay: shared !== null }
    this.emit()
  }

  async pickDisplay(mode: CaptureMode, fps: VideoFps | null): Promise<void> {
    const display = await navigator.mediaDevices.getDisplayMedia(displayRequest(mode, fps))
    this.dropDisplay()
    this.display = display
    this.displayMode = mode
    this.status = { ...this.status, preview: display.getVideoTracks().length ? new MediaStream(display.getVideoTracks()) : null }
    display.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.display !== display) return
      this.dropDisplay()
      void this.listen(this.choice)
    })
    await this.listen(this.choice)
  }

  dropDisplay(): void {
    const display = this.display
    this.display = null
    display?.getTracks().forEach(track => track.stop())
    this.status = { ...this.status, preview: null }
  }

  handDisplay(): MediaStream | null {
    this.handed = this.display !== null
    return this.display
  }

  async testSound(): Promise<boolean> {
    const analyser = this.status.meters.computer
    return this.context && analyser ? playTestSound(this.context, analyser) : false
  }

  async stop(): Promise<void> {
    this.turn++
    this.plug('microphone', [])
    this.plug('computer', [])
    if (this.handed) this.display = null
    else this.dropDisplay()
    this.handed = false
    this.status = { ...this.status, preview: null }
    await this.context?.close().catch(() => undefined)
    this.context = null
    this.analysers = null
  }

  private release(streams: MediaStream[]): void {
    const shared = this.display?.getTracks() ?? []
    for (const stream of streams) stream.getTracks().filter(track => !shared.includes(track)).forEach(track => track.stop())
  }

  private sides(): Record<CheckSide, AnalyserNode> {
    this.context ??= new AudioContext()
    if (!this.analysers) {
      const microphone = this.context.createAnalyser()
      const computer = this.context.createAnalyser()
      microphone.fftSize = computer.fftSize = 1024
      this.analysers = { microphone, computer }
    }
    return this.analysers
  }

  private plug(side: CheckSide, streams: MediaStream[]): void {
    const previous = this.plugged[side]
    previous.nodes.forEach(node => node.disconnect())
    this.release(previous.streams)
    if (!streams.length) {
      this.plugged[side] = { nodes: [], streams: [] }
      return
    }
    const analyser = this.sides()[side]
    const context = this.context!
    const nodes = streams.map(stream => {
      const node = context.createMediaStreamSource(stream)
      node.connect(analyser)
      return node
    })
    this.plugged[side] = { nodes, streams }
  }

  private emit(): void {
    const on = (side: CheckSide) => (this.plugged[side].streams.length ? (this.analysers?.[side] ?? null) : null)
    this.status = { ...this.status, meters: { microphone: on('microphone'), computer: on('computer') } }
    this.onChange({ ...this.status })
  }
}

function emptyLive(): LiveCapture {
  return { preview: null, meters: { microphone: null, computer: null }, computerAudio: '', hasMicrophone: false, hasSource: false, microphoneOn: true, sourceOn: true, microphoneId: null, sourceChoice: '', paused: false, screenOn: false }
}

export class MeetingRecorder {
  private recorder: MediaRecorder | null = null
  private audioContext: AudioContext | null = null
  private integration: IntegrationCapture | null = null
  private writable: FileSystemWritableFileStream | null = null
  private handle: FileSystemFileHandle | null = null
  private timer = 0
  private seconds = 0
  private runningSince: number | null = null
  private recordedMs = 0
  private cancelled = false
  private pip: Window | null = null
  private early: Promise<Window | null> | null = null
  private live: LiveCapture = emptyLive()
  private originalTitle = ''
  private mime = ''
  private writing: Promise<void> = Promise.resolve()
  private mode: CaptureMode = 'microphone'
  private display: MediaStream | null = null
  private handed: MediaStream | null = null
  private screen: MediaStream | null = null
  private fps: VideoFps | null = null
  private canvas: ScreenCanvas | null = null
  private gains: Record<'microphone' | 'source', GainNode | null> = { microphone: null, source: null }
  private analysers: Record<'microphone' | 'source', AnalyserNode | null> = { microphone: null, source: null }
  private plugged: Record<'microphone' | 'source', { nodes: AudioNode[]; streams: MediaStream[] }> = { microphone: { nodes: [], streams: [] }, source: { nodes: [], streams: [] } }

  constructor(private readonly callbacks: RecorderCallbacks) {}

  get active(): boolean {
    return this.recorder !== null && this.recorder.state !== 'inactive'
  }

  async start(mode: CaptureMode, computerAudio: string = COMPUTER_AUDIO_AUTO, options: StartOptions = {}): Promise<void> {
    try {
      await this.begin(mode, computerAudio, options)
    } catch (error) {
      await this.releaseDevices()
      throw error
    }
  }

  async startIntegration(capture: IntegrationCapture, options: StartOptions = {}): Promise<void> {
    try {
      this.mode = 'integration'
      this.integration = capture
      this.audioContext = capture.context
      this.fps = options.video?.fps ?? null
      if (this.fps) this.canvas = new ScreenCanvas(this.fps)
      const mix = this.prepare(capture.context)
      capture.microphone.connect(this.gains.microphone!)
      capture.source.connect(this.gains.source!)
      this.live = { ...this.live, computerAudio: capture.label, hasMicrophone: true, hasSource: capture.choice.source.kind !== 'none', microphoneId: capture.choice.microphone, sourceChoice: integrationSourceKey(capture.choice.source) }
      this.applyMeters()
      this.setEnabled('microphone', options.microphoneOn !== false)
      if (this.fps) await this.pickScreen()
      await this.record(mix)
    } catch (error) {
      await this.releaseDevices()
      throw error
    }
  }

  private prepare(context: AudioContext): MediaStreamAudioDestinationNode {
    const mix = context.createMediaStreamDestination()
    mix.channelCount = 2
    mix.channelCountMode = 'explicit'
    const sides = context.createChannelMerger(2)
    sides.connect(mix)
    for (const [side, kind] of (['microphone', 'source'] as const).entries()) {
      const gain = context.createGain()
      gain.connect(sides, 0, side)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      gain.connect(analyser)
      this.gains[kind] = gain
      this.analysers[kind] = analyser
    }
    return mix
  }

  private applyMeters(): void {
    this.live = { ...this.live, meters: { microphone: this.live.hasMicrophone ? this.analysers.microphone : null, computer: this.live.hasSource ? this.analysers.source : null } }
  }

  private emit(): void {
    this.callbacks.onLive?.({ ...this.live })
  }

  private plug(kind: 'microphone' | 'source', streams: MediaStream[]): void {
    const previous = this.plugged[kind]
    previous.nodes.forEach(node => node.disconnect())
    previous.streams.filter(stream => !streams.includes(stream)).forEach(stream => stream.getTracks().forEach(track => track.stop()))
    const nodes = streams.map(stream => {
      const node = this.audioContext!.createMediaStreamSource(stream)
      node.connect(this.gains[kind]!)
      return node
    })
    this.plugged[kind] = { nodes, streams }
    this.live = kind === 'microphone' ? { ...this.live, hasMicrophone: streams.length > 0 } : { ...this.live, hasSource: streams.length > 0 }
    this.applyMeters()
  }

  private openMicrophone(id: string | null): Promise<MediaStream> {
    return openMicrophone(id)
  }

  private async share(mode: 'tab' | 'screen'): Promise<MediaStream | null> {
    const display = await this.requestDisplay(displayRequest(mode, this.fps))
    const previous = this.display
    this.display = display
    previous?.getTracks().forEach(track => track.stop())
    this.screen?.getTracks().forEach(track => track.stop())
    this.screen = null
    this.showScreen(display.getVideoTracks().length ? new MediaStream(display.getVideoTracks()) : null)
    display.getVideoTracks()[0]?.addEventListener('ended', () => this.display === display && this.finish())
    return display.getAudioTracks().length ? new MediaStream(display.getAudioTracks()) : null
  }

  private async computerInput(choice: string): Promise<{ streams: MediaStream[]; label: string } | null> {
    const opened = await openComputerInputs(choice)
    return opened.streams.length ? opened : null
  }

  private async begin(mode: CaptureMode, computerAudio: string, options: StartOptions): Promise<void> {
    this.mode = mode
    this.fps = options.video?.fps ?? null
    this.handed = options.display ?? null
    if (this.fps) this.canvas = new ScreenCanvas(this.fps)
    this.audioContext = new AudioContext()
    const mix = this.prepare(this.audioContext)
    const displayAudio = mode === 'tab' || mode === 'screen' ? await this.share(mode) : null

    const useDisplayAudio = displayAudio && computerAudio === COMPUTER_AUDIO_AUTO
    if (useDisplayAudio) {
      this.plug('source', [displayAudio])
      this.live = { ...this.live, computerAudio: mode === 'tab' ? 'som da aba' : 'som da tela', sourceChoice: 'display' }
    }

    try {
      this.plug('microphone', [await this.openMicrophone(options.microphoneId ?? null)])
      this.live = { ...this.live, microphoneId: options.microphoneId ?? null }
    } catch {
      if (mode === 'microphone' && options.microphoneOn !== false) throw new Error('O navegador não deixou usar o microfone.')
    }

    if (!useDisplayAudio) {
      const input = await this.computerInput(computerAudio)
      if (input) this.plug('source', input.streams)
      this.live = { ...this.live, computerAudio: input?.label ?? '', sourceChoice: input ? computerAudio : COMPUTER_AUDIO_NONE }
    }
    if (!this.live.hasMicrophone && !this.live.hasSource) throw new Error('Não há som para gravar: ligue o microfone ou escolha o som do computador.')
    if (this.fps && !this.live.screenOn) await this.pickScreen()
    this.setEnabled('microphone', options.microphoneOn !== false)
    await this.record(mix)
  }

  private startTimer(): void {
    window.clearInterval(this.timer)
    this.timer = window.setInterval(() => {
      this.seconds++
      this.callbacks.onTick(this.seconds)
    }, 1000)
  }

  private async record(mix: MediaStreamAudioDestinationNode): Promise<void> {
    this.mime = supportedMime(this.canvas !== null)
    const root = await navigator.storage.getDirectory()
    this.handle = await root.getFileHandle(`gravacao-${Date.now()}.${extensionOf(this.mime)}`, { create: true })
    this.writable = await this.handle.createWritable()

    const tracks = [...(this.canvas ? [this.canvas.track] : []), ...mix.stream.getAudioTracks()]
    this.recorder = new MediaRecorder(new MediaStream(tracks), { ...(this.mime ? { mimeType: this.mime } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND, ...(this.fps ? { videoBitsPerSecond: VIDEO_BITS_PER_SECOND[this.fps] } : {}) })
    this.recorder.ondataavailable = event => {
      if (!event.data.size || !this.writable) return
      const writable = this.writable
      this.writing = this.writing.then(() => writable.write(event.data))
    }
    this.recorder.onstop = () => void this.close()
    this.recorder.start(CHUNK_MS)
    this.recordedMs = 0
    this.runningSince = Date.now()
    this.emit()

    this.originalTitle = document.title
    document.title = `${RECORDING_TITLE}${this.originalTitle}`
    this.startTimer()
    if ((window as Window & { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture) await this.openFloating()
  }

  setEnabled(kind: 'microphone' | 'source', on: boolean): void {
    const gain = this.gains[kind]
    if (gain) gain.gain.value = on ? 1 : 0
    this.live = kind === 'microphone' ? { ...this.live, microphoneOn: on } : { ...this.live, sourceOn: on }
    this.emit()
  }

  pause(): void {
    if (this.recorder?.state !== 'recording') return
    this.recorder.pause()
    this.recordedMs = this.position() * 1000
    this.runningSince = null
    window.clearInterval(this.timer)
    this.live = { ...this.live, paused: true }
    this.emit()
  }

  resume(): void {
    if (this.recorder?.state !== 'paused') return
    this.recorder.resume()
    this.runningSince = Date.now()
    this.startTimer()
    this.live = { ...this.live, paused: false }
    this.emit()
  }

  position(): number {
    return (this.recordedMs + (this.runningSince === null ? 0 : Date.now() - this.runningSince)) / 1000
  }

  private dropScreen(): void {
    this.screen?.getVideoTracks().forEach(track => track.stop())
    this.screen = null
    this.display?.getVideoTracks().forEach(track => track.stop())
    this.showScreen(null)
  }

  private videoConstraint(): MediaTrackConstraints | true {
    return this.fps ? { frameRate: this.fps } : true
  }

  // The screen picker outlasts the click that allows the floating window, so ask for both in that same click.
  private requestDisplay(options: DisplayMediaStreamOptions): Promise<MediaStream> {
    if (this.handed) {
      const handed = this.handed
      this.handed = null
      return Promise.resolve(handed)
    }
    const request = navigator.mediaDevices.getDisplayMedia(options)
    const api = (window as Window & { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture
    if (api && !this.active && !this.pip && !this.early) {
      this.early = api.requestWindow({ width: 340, height: 360 }).catch(() => null)
      void this.early.then(floating => {
        if (!floating) return
        floating.document.title = 'Gravação'
        floating.document.body.textContent = 'Escolha o que gravar para começar.'
      })
    }
    return request
  }

  private showScreen(preview: MediaStream | null): void {
    this.live = { ...this.live, preview, screenOn: preview !== null }
    this.canvas?.show(preview)
  }

  private async pickScreen(): Promise<void> {
    const picked = await this.requestDisplay({ video: this.videoConstraint(), audio: false })
    this.dropScreen()
    this.screen = picked
    this.showScreen(new MediaStream(picked.getVideoTracks()))
    picked.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.screen !== picked) return
      this.dropScreen()
      this.emit()
    })
  }

  async setScreen(on: boolean): Promise<void> {
    if (on) await this.pickScreen()
    else this.dropScreen()
    this.emit()
  }

  async switchScreen(): Promise<void> {
    await this.pickScreen()
    this.emit()
  }

  async switchMicrophone(id: string | null): Promise<void> {
    if (this.integration) await this.integration.switchTo({ microphone: id })
    else this.plug('microphone', [await this.openMicrophone(id)])
    this.live = { ...this.live, microphoneId: id }
    this.emit()
  }

  async switchComputerInput(choice: string): Promise<void> {
    if (choice === COMPUTER_AUDIO_NONE) {
      this.plug('source', [])
      this.live = { ...this.live, computerAudio: '', sourceChoice: COMPUTER_AUDIO_NONE }
    } else {
      const input = await this.computerInput(choice)
      if (!input) throw new Error('Essa entrada de som não abriu.')
      this.plug('source', input.streams)
      this.live = { ...this.live, computerAudio: input.label, sourceChoice: choice }
    }
    this.emit()
  }

  async reshare(): Promise<void> {
    const mode = this.mode === 'screen' ? 'screen' : 'tab'
    const audio = await this.share(mode)
    this.plug('source', audio ? [audio] : [])
    this.live = { ...this.live, computerAudio: audio ? (mode === 'tab' ? 'som da aba' : 'som da tela') : '', sourceChoice: audio ? 'display' : COMPUTER_AUDIO_NONE }
    this.emit()
  }

  async switchIntegrationSource(choice: IntegrationSourceChoice): Promise<void> {
    if (!this.integration) return
    await this.integration.switchTo(choice)
    this.live = { ...this.live, hasSource: this.integration.choice.source.kind !== 'none', computerAudio: this.integration.label, sourceChoice: integrationSourceKey(this.integration.choice.source) }
    this.applyMeters()
    this.emit()
  }

  finish(): void {
    if (!this.active) return
    this.cancelled = false
    this.recorder!.stop()
  }

  cancel(): void {
    if (!this.active) return
    this.cancelled = true
    this.recorder!.stop()
  }

  async openFloating(): Promise<boolean> {
    if (!this.active) return false
    if (this.pip) {
      this.pip.focus()
      return true
    }
    const api = (window as Window & { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture
    let floating: Window | null = null
    const early = this.early
    this.early = null
    if (api) floating = await (early ?? api.requestWindow({ width: 340, height: 360 })).catch(() => null)
    if (floating?.closed) floating = null
    if (!floating) floating = window.open('', 'study-helper-gravacao', 'popup,width=360,height=420')
    if (!floating) return false
    this.pip = floating
    const doc = floating.document
    doc.title = 'Gravação'
    for (const sheet of document.querySelectorAll('link[rel="stylesheet"], style')) doc.head.appendChild(sheet.cloneNode(true))
    doc.documentElement.dataset.theme = document.documentElement.dataset.theme ?? ''
    doc.body.replaceChildren()
    doc.body.className = 'floating-recorder'
    floating.addEventListener('pagehide', () => {
      if (this.pip !== floating) return
      this.pip = null
      this.callbacks.onFloating?.(null)
    })
    this.callbacks.onFloating?.(floating)
    return true
  }

  private async releaseDevices(): Promise<void> {
    void this.early?.then(floating => floating?.close())
    this.early = null
    for (const kind of ['microphone', 'source'] as const) this.plugged[kind].streams.forEach(stream => stream.getTracks().forEach(track => track.stop()))
    this.display?.getTracks().forEach(track => track.stop())
    this.display = null
    this.handed?.getTracks().forEach(track => track.stop())
    this.handed = null
    this.screen?.getTracks().forEach(track => track.stop())
    this.screen = null
    this.canvas?.stop()
    this.canvas = null
    if (this.integration) await this.integration.stop()
    else await this.audioContext?.close().catch(() => undefined)
  }

  private async seekableCopy(root: FileSystemDirectoryHandle, handle: FileSystemFileHandle): Promise<{ file: File; name: string }> {
    const raw = await handle.getFile()
    const seekable = await makeSeekable(raw)
    if (seekable === raw) return { file: raw, name: handle.name }
    const copy = await root.getFileHandle(`s-${handle.name}`, { create: true })
    const writable = await copy.createWritable()
    await writable.write(seekable)
    await writable.close()
    await root.removeEntry(handle.name).catch(() => undefined)
    return { file: await copy.getFile(), name: copy.name }
  }

  private async close(): Promise<void> {
    window.clearInterval(this.timer)
    document.title = this.originalTitle
    if (this.cancelled) {
      this.pip?.close()
      this.pip = null
    }
    await this.releaseDevices()
    try {
      await this.writing
      await this.writable?.close()
      const handle = this.handle!
      const root = await navigator.storage.getDirectory()
      if (this.cancelled) {
        await root.removeEntry(handle.name).catch(() => undefined)
        this.callbacks.onCancelled()
        return
      }
      const saved = await this.seekableCopy(root, handle)
      const name = `Reunião ${new Date().toLocaleString('pt-BR').replace(/[/:]/g, '-')}.${extensionOf(this.mime)}`
      this.callbacks.onFinished({ file: new File([saved.file], name, { type: this.mime || saved.file.type }), mime: this.mime, durationSeconds: this.seconds, storedName: saved.name })
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : 'A gravação não pôde ser salva.')
    } finally {
      this.recorder = null
      this.writable = null
    }
  }
}

export async function discardRecording(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory()
  await root.removeEntry(name).catch(() => undefined)
}
