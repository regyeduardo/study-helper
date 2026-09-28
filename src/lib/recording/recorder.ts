import type { IntegrationCapture } from '@/lib/recording/integration'
import { integrationSourceKey, type IntegrationSourceChoice } from '@/lib/recording/integration'
import type { Meters } from '@/lib/recording/miniplayer'

export type CaptureMode = 'tab' | 'screen' | 'microphone' | 'integration'

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
}

export interface StartOptions {
  microphoneOn?: boolean
  microphoneId?: string | null
}

export interface RecordingResult {
  file: File
  mime: string
  durationSeconds: number
  storedName: string
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

function supportedMime(): string {
  return MIME_OPTIONS.find(mime => MediaRecorder.isTypeSupported(mime)) ?? ''
}

function extensionOf(mime: string): string {
  return mime.includes('mp4') ? 'mp4' : 'webm'
}

function emptyLive(): LiveCapture {
  return { preview: null, meters: { microphone: null, computer: null }, computerAudio: '', hasMicrophone: false, hasSource: false, microphoneOn: true, sourceOn: true, microphoneId: null, sourceChoice: '', paused: false }
}

export class MeetingRecorder {
  private recorder: MediaRecorder | null = null
  private audioContext: AudioContext | null = null
  private integration: IntegrationCapture | null = null
  private writable: FileSystemWritableFileStream | null = null
  private handle: FileSystemFileHandle | null = null
  private timer = 0
  private seconds = 0
  private cancelled = false
  private pip: Window | null = null
  private live: LiveCapture = emptyLive()
  private originalTitle = ''
  private mime = ''
  private writing: Promise<void> = Promise.resolve()
  private mode: CaptureMode = 'microphone'
  private display: MediaStream | null = null
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
      const mix = this.prepare(capture.context)
      capture.microphone.connect(this.gains.microphone!)
      capture.source.connect(this.gains.source!)
      this.live = { ...this.live, computerAudio: capture.label, hasMicrophone: true, hasSource: capture.choice.source.kind !== 'none', microphoneId: capture.choice.microphone, sourceChoice: integrationSourceKey(capture.choice.source) }
      this.applyMeters()
      this.setEnabled('microphone', options.microphoneOn !== false)
      await this.record(mix)
    } catch (error) {
      await this.releaseDevices()
      throw error
    }
  }

  private prepare(context: AudioContext): MediaStreamAudioDestinationNode {
    const mix = context.createMediaStreamDestination()
    mix.channelCount = 1
    mix.channelCountMode = 'explicit'
    for (const kind of ['microphone', 'source'] as const) {
      const gain = context.createGain()
      gain.connect(mix)
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
    return navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true } })
  }

  private async share(mode: 'tab' | 'screen'): Promise<MediaStream | null> {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      systemAudio: 'include',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: mode === 'screen' ? 'include' : 'exclude',
    } as DisplayMediaStreamOptions)
    const previous = this.display
    this.display = display
    previous?.getTracks().forEach(track => track.stop())
    this.live = { ...this.live, preview: display.getVideoTracks().length ? new MediaStream(display.getVideoTracks()) : null }
    display.getVideoTracks()[0]?.addEventListener('ended', () => this.display === display && this.finish())
    return display.getAudioTracks().length ? new MediaStream(display.getAudioTracks()) : null
  }

  private async computerInput(choice: string): Promise<{ streams: MediaStream[]; label: string } | null> {
    if (choice === COMPUTER_AUDIO_NONE) return null
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
    return found.length ? { streams: found.map(item => item.stream), label: found.map(item => item.label).join(' + ') } : null
  }

  private async begin(mode: CaptureMode, computerAudio: string, options: StartOptions): Promise<void> {
    this.mode = mode
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
    this.mime = supportedMime()
    const root = await navigator.storage.getDirectory()
    this.handle = await root.getFileHandle(`gravacao-${Date.now()}.${extensionOf(this.mime)}`, { create: true })
    this.writable = await this.handle.createWritable()

    this.recorder = new MediaRecorder(new MediaStream(mix.stream.getAudioTracks()), { ...(this.mime ? { mimeType: this.mime } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
    this.recorder.ondataavailable = event => {
      if (!event.data.size || !this.writable) return
      const writable = this.writable
      this.writing = this.writing.then(() => writable.write(event.data))
    }
    this.recorder.onstop = () => void this.close()
    this.recorder.start(CHUNK_MS)
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
    window.clearInterval(this.timer)
    this.live = { ...this.live, paused: true }
    this.emit()
  }

  resume(): void {
    if (this.recorder?.state !== 'paused') return
    this.recorder.resume()
    this.startTimer()
    this.live = { ...this.live, paused: false }
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
    if (api) floating = await api.requestWindow({ width: 340, height: 360 }).catch(() => null)
    if (!floating) floating = window.open('', 'study-helper-gravacao', 'popup,width=360,height=420')
    if (!floating) return false
    this.pip = floating
    const doc = floating.document
    doc.title = 'Gravação'
    for (const sheet of document.querySelectorAll('link[rel="stylesheet"], style')) doc.head.appendChild(sheet.cloneNode(true))
    doc.documentElement.dataset.theme = document.documentElement.dataset.theme ?? ''
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
    for (const kind of ['microphone', 'source'] as const) this.plugged[kind].streams.forEach(stream => stream.getTracks().forEach(track => track.stop()))
    this.display?.getTracks().forEach(track => track.stop())
    this.display = null
    if (this.integration) await this.integration.stop()
    else await this.audioContext?.close().catch(() => undefined)
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
      const stored = await handle.getFile()
      const name = `Reunião ${new Date().toLocaleString('pt-BR').replace(/[/:]/g, '-')}.${extensionOf(this.mime)}`
      this.callbacks.onFinished({ file: new File([stored], name, { type: this.mime || stored.type }), mime: this.mime, durationSeconds: this.seconds, storedName: handle.name })
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
