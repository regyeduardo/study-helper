import { mountMiniplayer, type Meters } from '@/lib/recording/miniplayer'

export type CaptureMode = 'tab' | 'screen' | 'microphone'

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
}

export interface RecordingResult {
  file: File
  mime: string
  durationSeconds: number
  storedName: string
}

export interface RecorderCallbacks {
  onLive?(live: LiveCapture): void
  onFloating?(open: boolean): void
  onTick(seconds: number): void
  onFinished(result: RecordingResult): void
  onCancelled(): void
  onError(message: string): void
}

const MIME_OPTIONS = ['video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
const AUDIO_MIME_OPTIONS = ['audio/mp4;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm']
const RECORDING_TITLE = '● Gravando — '
const COMPUTER_INPUT = /monitor|stereo mix|mixagem|what u hear|loopback|blackhole|soundflower|vb-audio|cable output/i
const CHUNK_MS = 1000

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
  const options = video ? MIME_OPTIONS : AUDIO_MIME_OPTIONS
  return options.find(mime => MediaRecorder.isTypeSupported(mime)) ?? ''
}

function extensionOf(mime: string): string {
  return mime.includes('mp4') ? 'mp4' : 'webm'
}

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`
}

export class MeetingRecorder {
  private recorder: MediaRecorder | null = null
  private streams: MediaStream[] = []
  private audioContext: AudioContext | null = null
  private writable: FileSystemWritableFileStream | null = null
  private handle: FileSystemFileHandle | null = null
  private timer = 0
  private seconds = 0
  private cancelled = false
  private pip: Window | null = null
  private unmountPip: (() => void) | null = null
  private live: LiveCapture = { preview: null, meters: { microphone: null, computer: null }, computerAudio: '' }
  private originalTitle = ''
  private mime = ''
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly callbacks: RecorderCallbacks) {}

  get active(): boolean {
    return this.recorder !== null && this.recorder.state !== 'inactive'
  }

  async start(mode: CaptureMode, computerAudio: string = COMPUTER_AUDIO_AUTO): Promise<void> {
    try {
      await this.begin(mode, computerAudio)
    } catch (error) {
      await this.releaseDevices()
      throw error
    }
  }

  private meter(stream: MediaStream, mix: MediaStreamAudioDestinationNode): AnalyserNode {
    const source = this.audioContext!.createMediaStreamSource(stream)
    source.connect(mix)
    const analyser = this.audioContext!.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    return analyser
  }

  private async computerInput(choice: string, mode: CaptureMode): Promise<{ stream: MediaStream; label: string } | null> {
    if (choice === COMPUTER_AUDIO_NONE || (choice === COMPUTER_AUDIO_AUTO && mode === 'microphone')) return null
    const inputs = await listAudioInputs().catch(() => [])
    const input = choice === COMPUTER_AUDIO_AUTO ? inputs.find(item => item.computer) : inputs.find(item => item.deviceId === choice)
    if (!input) return null
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: { exact: input.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .catch(() => null)
    return stream ? { stream, label: input.label } : null
  }

  private async begin(mode: CaptureMode, computerAudio: string): Promise<void> {
    const tracks: MediaStreamTrack[] = []
    this.audioContext = new AudioContext()
    const mix = this.audioContext.createMediaStreamDestination()
    let displayAudio: MediaStream | null = null

    if (mode !== 'microphone') {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: mode === 'screen' ? 'include' : 'exclude',
      } as DisplayMediaStreamOptions)
      this.streams.push(display)
      tracks.push(...display.getVideoTracks())
      if (display.getVideoTracks().length) this.live.preview = new MediaStream(display.getVideoTracks())
      if (display.getAudioTracks().length) displayAudio = new MediaStream(display.getAudioTracks())
      display.getVideoTracks()[0]?.addEventListener('ended', () => this.finish())
    }

    const useDisplayAudio = displayAudio && computerAudio === COMPUTER_AUDIO_AUTO
    if (useDisplayAudio) {
      this.live.meters.computer = this.meter(displayAudio!, mix)
      this.live.computerAudio = mode === 'tab' ? 'som da aba' : 'som da tela'
    }

    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      this.streams.push(microphone)
      this.live.meters.microphone = this.meter(microphone, mix)
    } catch {
      if (mode === 'microphone') throw new Error('O navegador não deixou usar o microfone.')
    }

    if (!useDisplayAudio) {
      const input = await this.computerInput(computerAudio, mode)
      if (input) {
        this.streams.push(input.stream)
        this.live.meters.computer = this.meter(input.stream, mix)
        this.live.computerAudio = input.label
      }
    }
    this.callbacks.onLive?.(this.live)

    tracks.push(...mix.stream.getAudioTracks())
    this.mime = supportedMime(mode !== 'microphone')
    const root = await navigator.storage.getDirectory()
    this.handle = await root.getFileHandle(`gravacao-${Date.now()}.${extensionOf(this.mime)}`, { create: true })
    this.writable = await this.handle.createWritable()

    this.recorder = new MediaRecorder(new MediaStream(tracks), this.mime ? { mimeType: this.mime } : undefined)
    this.recorder.ondataavailable = event => {
      if (!event.data.size || !this.writable) return
      const writable = this.writable
      this.writing = this.writing.then(() => writable.write(event.data))
    }
    this.recorder.onstop = () => void this.close()
    this.recorder.start(CHUNK_MS)

    this.originalTitle = document.title
    document.title = `${RECORDING_TITLE}${this.originalTitle}`
    this.timer = window.setInterval(() => {
      this.seconds++
      this.callbacks.onTick(this.seconds)
      this.paintPip()
    }, 1000)
    if ((window as Window & { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture) await this.openFloating()
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
    if (api) floating = await api.requestWindow({ width: 320, height: 250 }).catch(() => null)
    if (!floating) floating = window.open('', 'study-helper-gravacao', 'popup,width=340,height=300')
    if (!floating) return false
    this.pip = floating
    const doc = floating.document
    doc.title = 'Gravando'
    doc.body.style.cssText = 'margin:0;font:14px system-ui,sans-serif;background:#111827;color:#f9fafb;display:flex;flex-direction:column;box-sizing:border-box;height:100vh'
    doc.body.innerHTML = `<div id="player" style="flex:1;min-height:0"></div>
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px">
      <span id="timer" style="flex:1;font-variant-numeric:tabular-nums"><span style="color:#ef4444">●</span> 00:00</span>
      <button id="finish" style="font:inherit;padding:6px 10px;border-radius:6px;border:0;background:#2563eb;color:#fff;cursor:pointer">Terminar</button>
      <button id="cancel" style="font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#f9fafb;cursor:pointer">Cancelar</button>
      </div>`
    this.unmountPip = mountMiniplayer(doc.getElementById('player')!, this.live)
    doc.getElementById('finish')!.addEventListener('click', () => this.finish())
    doc.getElementById('cancel')!.addEventListener('click', () => this.cancel())
    floating.addEventListener('pagehide', () => {
      this.unmountPip?.()
      this.unmountPip = null
      this.pip = null
      this.callbacks.onFloating?.(false)
    })
    this.paintPip()
    this.callbacks.onFloating?.(true)
    return true
  }

  private paintPip(): void {
    const timer = this.pip?.document.getElementById('timer')
    if (timer) timer.innerHTML = `<span style="color:#ef4444">●</span> ${clock(this.seconds)}`
  }

  private async releaseDevices(): Promise<void> {
    this.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()))
    this.streams = []
    await this.audioContext?.close().catch(() => undefined)
  }

  private async close(): Promise<void> {
    window.clearInterval(this.timer)
    document.title = this.originalTitle
    this.unmountPip?.()
    this.unmountPip = null
    this.pip?.close()
    this.pip = null
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
