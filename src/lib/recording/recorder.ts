export type CaptureMode = 'tab' | 'screen' | 'microphone'

export interface RecordingResult {
  file: File
  mime: string
  durationSeconds: number
  storedName: string
}

export interface RecorderCallbacks {
  onTick(seconds: number): void
  onFinished(result: RecordingResult): void
  onCancelled(): void
  onError(message: string): void
}

const MIME_OPTIONS = ['video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
const AUDIO_MIME_OPTIONS = ['audio/mp4;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm']
const RECORDING_TITLE = '● Gravando — '
const CHUNK_MS = 1000

interface PictureInPictureApi {
  requestWindow(options: { width: number; height: number }): Promise<Window>
}

export function systemAudioNotice(agent: string = navigator.userAgent): string {
  const firefox = /Firefox\//.test(agent)
  const safari = /Safari\//.test(agent) && !/Chrome\//.test(agent)
  const linux = /Linux/.test(agent) && !/Android/.test(agent)
  if (firefox) return 'O Firefox não grava o som do sistema nem de outra aba: grava só o microfone e a imagem.'
  if (safari) return 'O Safari não grava o som do sistema nem de outra aba: grava só o microfone e a imagem.'
  if (linux) return 'Neste navegador no Linux, o som só vem se você escolher uma ABA (marque "Compartilhar áudio da guia"); a tela inteira grava sem o som do sistema.'
  return 'Escolha a aba da reunião e marque "Compartilhar áudio da guia". Tela inteira com o som do sistema só funciona no Chrome/Edge do Windows, ChromeOS e macOS 14.2+.'
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
  private originalTitle = ''
  private mime = ''
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly callbacks: RecorderCallbacks) {}

  get active(): boolean {
    return this.recorder !== null && this.recorder.state !== 'inactive'
  }

  async start(mode: CaptureMode): Promise<void> {
    try {
      await this.begin(mode)
    } catch (error) {
      await this.releaseDevices()
      throw error
    }
  }

  private async begin(mode: CaptureMode): Promise<void> {
    const tracks: MediaStreamTrack[] = []
    this.audioContext = new AudioContext()
    const mix = this.audioContext.createMediaStreamDestination()

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
      if (display.getAudioTracks().length) this.audioContext.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(mix)
      display.getVideoTracks()[0]?.addEventListener('ended', () => this.finish())
    }

    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      this.streams.push(microphone)
      this.audioContext.createMediaStreamSource(microphone).connect(mix)
    } catch {
      if (mode === 'microphone') throw new Error('O navegador não deixou usar o microfone.')
    }

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
    await this.openPip()
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

  private async openPip(): Promise<void> {
    const api = (window as Window & { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture
    if (!api) return
    try {
      this.pip = await api.requestWindow({ width: 280, height: 96 })
    } catch {
      this.pip = null
      return
    }
    const doc = this.pip.document
    doc.title = 'Gravando'
    doc.body.style.cssText = 'margin:0;font:14px system-ui,sans-serif;background:#111827;color:#f9fafb;display:flex;align-items:center;gap:8px;padding:12px;box-sizing:border-box;height:100vh'
    doc.body.innerHTML = `<span id="timer" style="flex:1;font-variant-numeric:tabular-nums"><span style="color:#ef4444">●</span> 00:00</span>
      <button id="finish" style="font:inherit;padding:6px 10px;border-radius:6px;border:0;background:#2563eb;color:#fff;cursor:pointer">Terminar</button>
      <button id="cancel" style="font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#f9fafb;cursor:pointer">Cancelar</button>`
    doc.getElementById('finish')!.addEventListener('click', () => this.finish())
    doc.getElementById('cancel')!.addEventListener('click', () => this.cancel())
    this.pip.addEventListener('pagehide', () => (this.pip = null))
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
