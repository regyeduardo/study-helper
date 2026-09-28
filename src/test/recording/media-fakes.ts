import { vi } from 'vitest'

export class FakeTrack extends EventTarget {
  readonly stop = vi.fn()

  constructor(
    readonly kind: 'audio' | 'video',
    readonly label: string,
  ) {
    super()
  }

  end(): void {
    this.dispatchEvent(new Event('ended'))
  }
}

export class FakeMediaStream {
  private readonly tracks: FakeTrack[]

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks]
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks]
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter(track => track.kind === 'audio')
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter(track => track.kind === 'video')
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  readonly mixTrack = new FakeTrack('audio', 'mix')
  readonly destination: { stream: FakeMediaStream; channelCount?: number; channelCountMode?: string } = { stream: new FakeMediaStream([this.mixTrack]) }
  readonly sources: { stream: FakeMediaStream; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
  readonly gains: { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
  readonly close = vi.fn(async () => undefined)

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamDestination() {
    return this.destination
  }

  createMediaStreamSource(stream: FakeMediaStream) {
    const source = { stream, connect: vi.fn(), disconnect: vi.fn() }
    this.sources.push(source)
    return source
  }

  createGain() {
    const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
    this.gains.push(gain)
    return gain
  }

  get microphoneGain() {
    return this.gains[0]
  }

  get sourceGain() {
    return this.gains[1]
  }

  createAnalyser() {
    return { fftSize: 2048, getByteTimeDomainData: vi.fn() }
  }
}

export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static supported = new Set<string>()
  static isTypeSupported = vi.fn((mime: string) => FakeMediaRecorder.supported.has(mime))
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  timeslice: number | undefined
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(
    readonly stream: FakeMediaStream,
    readonly options?: { mimeType?: string; audioBitsPerSecond?: number },
  ) {
    FakeMediaRecorder.instances.push(this)
  }

  start(timeslice?: number): void {
    this.timeslice = timeslice
    this.state = 'recording'
  }

  emit(text: string): void {
    this.ondataavailable?.({ data: new Blob([text]) })
  }

  pause(): void {
    this.state = 'paused'
  }

  resume(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([]) })
    this.onstop?.()
  }
}

export interface FakeFileHandle {
  name: string
  chunks: Blob[]
  closed: boolean
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>
  getFile(): Promise<File>
}

export class FakeDirectory {
  readonly files = new Map<string, FakeFileHandle>()
  readonly removeEntry = vi.fn(async (name: string) => {
    this.files.delete(name)
  })

  async getFileHandle(name: string): Promise<FakeFileHandle> {
    const handle: FakeFileHandle = {
      name,
      chunks: [],
      closed: false,
      createWritable: async () => ({
        write: async (data: Blob) => {
          handle.chunks.push(data)
        },
        close: async () => {
          handle.closed = true
        },
      }),
      getFile: async () => new File(handle.chunks, name),
    }
    this.files.set(name, handle)
    return handle
  }
}

export interface MediaEnvironment {
  directory: FakeDirectory
  displayStream: FakeMediaStream
  microphoneStream: FakeMediaStream
  computerStream: FakeMediaStream
  getDisplayMedia: ReturnType<typeof vi.fn>
  getUserMedia: ReturnType<typeof vi.fn>
  enumerateDevices: ReturnType<typeof vi.fn>
}

export const MICROPHONE_INPUT = { kind: 'audioinput', deviceId: 'mic-1', label: 'Microfone interno', groupId: 'g1' }
export const COMPUTER_INPUT = { kind: 'audioinput', deviceId: 'monitor-1', label: 'Monitor of Built-in Audio Analog Stereo', groupId: 'g1' }

export function installMediaEnvironment(options: { displayAudio?: boolean; computerInput?: boolean } = {}): MediaEnvironment {
  FakeAudioContext.instances = []
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.supported = new Set(['video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'audio/mp4;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'])
  const directory = new FakeDirectory()
  const displayTracks = [new FakeTrack('video', 'screen')]
  if (options.displayAudio !== false) displayTracks.push(new FakeTrack('audio', 'tab-audio'))
  const displayStream = new FakeMediaStream(displayTracks)
  const microphoneStream = new FakeMediaStream([new FakeTrack('audio', 'mic')])
  const getDisplayMedia = vi.fn(async () => displayStream)
  const computerStream = new FakeMediaStream([new FakeTrack('audio', 'computer')])
  const getUserMedia = vi.fn(async (constraints: { audio: { deviceId?: { exact: string } } | boolean }) =>
    typeof constraints.audio === 'object' && constraints.audio.deviceId?.exact === COMPUTER_INPUT.deviceId ? computerStream : microphoneStream,
  )
  const devices = [{ kind: 'videoinput', deviceId: 'cam', label: 'Câmera', groupId: 'g2' }, { kind: 'audioinput', deviceId: 'default', label: 'Padrão', groupId: 'g1' }, MICROPHONE_INPUT]
  if (options.computerInput) devices.push(COMPUTER_INPUT)
  const enumerateDevices = vi.fn(async () => devices)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('MediaStream', FakeMediaStream)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia, getUserMedia, enumerateDevices } })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => directory } })
  return { directory, displayStream, microphoneStream, computerStream, getDisplayMedia, getUserMedia, enumerateDevices }
}

export function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}
