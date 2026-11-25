import { vi } from 'vitest'

/** The OpusHead an Opus encoder hands with its first chunk: two channels, 312 samples of pre-skip, 48 kHz. */
export const OPUS_HEAD = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])

interface Chunk {
  type: 'key' | 'delta'
  timestamp: number
  byteLength: number
  copyTo(destination: Uint8Array): void
}

function chunk(type: 'key' | 'delta', timestamp: number, size: number): Chunk {
  return { type, timestamp, byteLength: size, copyTo: destination => void destination.fill(type === 'key' ? 1 : 2) }
}

export class FakeVideoFrame {
  readonly timestamp: number
  readonly codedWidth: number
  readonly codedHeight: number
  closed = false
  static made: FakeVideoFrame[] = []

  constructor(source: { width: number; height: number }, init: { timestamp: number }) {
    this.timestamp = init.timestamp
    this.codedWidth = source.width
    this.codedHeight = source.height
    FakeVideoFrame.made.push(this)
  }

  close(): void {
    this.closed = true
  }
}

export class FakeVideoEncoder {
  static instances: FakeVideoEncoder[] = []
  static supported = true
  static isConfigSupported = vi.fn(async (config: VideoEncoderConfig) => ({ supported: FakeVideoEncoder.supported, config }))
  readonly configs: VideoEncoderConfig[] = []
  readonly encoded: { timestamp: number; keyFrame: boolean; width: number; height: number }[] = []
  /** Frames the encoder still holds: encodeQueueSize, until release(). */
  holding = false
  private held: { timestamp: number; keyFrame: boolean }[] = []
  readonly close = vi.fn()

  constructor(private readonly init: { output(chunk: Chunk, metadata?: unknown): void; error(error: Error): void }) {
    FakeVideoEncoder.instances.push(this)
  }

  get encodeQueueSize(): number {
    return this.held.length
  }

  configure(config: VideoEncoderConfig): void {
    this.configs.push(config)
  }

  encode(frame: FakeVideoFrame, options?: { keyFrame?: boolean }): void {
    const keyFrame = Boolean(options?.keyFrame)
    this.encoded.push({ timestamp: frame.timestamp, keyFrame, width: frame.codedWidth, height: frame.codedHeight })
    if (this.holding) this.held.push({ timestamp: frame.timestamp, keyFrame })
    else this.init.output(chunk(keyFrame ? 'key' : 'delta', frame.timestamp, keyFrame ? 50 : 10))
  }

  release(): void {
    for (const frame of this.held.splice(0)) this.init.output(chunk(frame.keyFrame ? 'key' : 'delta', frame.timestamp, frame.keyFrame ? 50 : 10))
  }

  readonly flush = vi.fn(async () => this.release())

  fail(message: string): void {
    this.init.error(new Error(message))
  }
}

export class FakeAudioData {
  readonly timestamp: number
  readonly numberOfFrames: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  readonly format: string
  closed = false

  constructor(init: { timestamp: number; numberOfFrames: number; numberOfChannels: number; sampleRate: number; format: string }) {
    this.timestamp = init.timestamp
    this.numberOfFrames = init.numberOfFrames
    this.numberOfChannels = init.numberOfChannels
    this.sampleRate = init.sampleRate
    this.format = init.format
  }

  close(): void {
    this.closed = true
  }
}

export class FakeAudioEncoder {
  static instances: FakeAudioEncoder[] = []
  static supported = true
  static isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({ supported: FakeAudioEncoder.supported, config }))
  readonly configs: AudioEncoderConfig[] = []
  readonly encoded: { timestamp: number; frames: number; channels: number; rate: number }[] = []
  readonly close = vi.fn()
  readonly flush = vi.fn(async () => undefined)

  constructor(private readonly init: { output(chunk: Chunk, metadata?: unknown): void; error(error: Error): void }) {
    FakeAudioEncoder.instances.push(this)
  }

  configure(config: AudioEncoderConfig): void {
    this.configs.push(config)
  }

  encode(data: FakeAudioData): void {
    this.encoded.push({ timestamp: data.timestamp, frames: data.numberOfFrames, channels: data.numberOfChannels, rate: data.sampleRate })
    const first = this.encoded.length === 1
    this.init.output(chunk('key', data.timestamp, 4), first ? { decoderConfig: { codec: 'opus', sampleRate: data.sampleRate, numberOfChannels: 2, description: OPUS_HEAD } } : undefined)
  }
}

export class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = []
  readonly port: { onmessage: ((event: { data: Float32Array[] }) => void) | null; postMessage: ReturnType<typeof vi.fn> } = { onmessage: null, postMessage: vi.fn() }

  constructor(
    readonly context: unknown,
    readonly name: string,
    readonly options: unknown,
  ) {
    FakeAudioWorkletNode.instances.push(this)
  }

  /** The worklet hands a block of sound (two channels). */
  hand(frames: number): void {
    this.port.onmessage?.({ data: [new Float32Array(frames), new Float32Array(frames)] })
  }
}

/** WebCodecs and AudioWorklet as in Chrome and Firefox; returns what takes away the URL functions jsdom lacks. */
export function installCodecEnvironment(): () => void {
  FakeVideoEncoder.instances = []
  FakeAudioEncoder.instances = []
  FakeAudioWorkletNode.instances = []
  FakeVideoFrame.made = []
  FakeVideoEncoder.supported = true
  FakeAudioEncoder.supported = true
  vi.stubGlobal('VideoEncoder', FakeVideoEncoder)
  vi.stubGlobal('AudioEncoder', FakeAudioEncoder)
  vi.stubGlobal('VideoFrame', FakeVideoFrame)
  vi.stubGlobal('AudioData', FakeAudioData)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  const added = !('createObjectURL' in URL)
  if (added) {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:tap') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  }
  return () => {
    if (!added) return
    delete (URL as unknown as Record<string, unknown>).createObjectURL
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL
  }
}

/** A context with the clock and the worklet the codec recorder needs. */
export function codecContext(sampleRate = 48000) {
  return {
    sampleRate,
    currentTime: 0,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
  }
}
