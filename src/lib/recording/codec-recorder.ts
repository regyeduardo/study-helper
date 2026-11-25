import { WebmWriter } from '@/lib/recording/webm-writer'

/**
 * The optimized recording encoded with WebCodecs (spec 007, research R18, T174), in place of MediaRecorder: in Firefox, whose recorder
 * only has VP8 and spends its whole ceiling, half the size with the text sharp (Waterfox 153: 63 against 117 MB an hour of video,
 * SSIM 0.996 to 0.998 against 0.973 to 0.989); in Chrome, as its recorder (44 against 40). The screen hands each frame it decided on
 * (ScreenCanvas.handTo), VP9 encodes it with the time of the sound's clock, the mix comes through an AudioWorklet into Opus, and
 * WebmWriter makes the file. It answers as much of MediaRecorder as MeetingRecorder uses.
 */

export interface FrameSource {
  handTo(sink: ((canvas: HTMLCanvasElement) => void) | null): void
}

export interface CodecRecorderOptions {
  videoBitsPerSecond: number
  audioBitsPerSecond: number
  keyFrameIntervalMs: number
}

export const CODEC_MIME = 'video/webm;codecs=vp9,opus'
const VP9 = 'vp09.00.10.08'
/** Frames waiting in the encoder before the next one is skipped: the screen keeps coming faster than a slow computer encodes. */
const MAX_QUEUE = 4
/** Sound goes to the encoder in blocks of 20 ms. */
const BLOCKS_PER_SECOND = 50

const TAP_PROCESSOR = `
class StudyHelperTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.size = options.processorOptions.size
    this.channels = [new Float32Array(this.size), new Float32Array(this.size)]
    this.filled = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input.length) return true
    const left = input[0]
    const right = input[1] || input[0]
    for (let at = 0; at < left.length;) {
      const take = Math.min(left.length - at, this.size - this.filled)
      this.channels[0].set(left.subarray(at, at + take), this.filled)
      this.channels[1].set(right.subarray(at, at + take), this.filled)
      this.filled += take
      at += take
      if (this.filled === this.size) {
        this.port.postMessage(this.channels, [this.channels[0].buffer, this.channels[1].buffer])
        this.channels = [new Float32Array(this.size), new Float32Array(this.size)]
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('study-helper-tap', StudyHelperTap)
`

function videoConfig(width: number, height: number, bitrate: number): VideoEncoderConfig {
  return { codec: VP9, width, height, bitrate, bitrateMode: 'variable', framerate: 30, latencyMode: 'realtime', contentHint: 'text' } as VideoEncoderConfig
}

function audioConfig(sampleRate: number, bitrate: number): AudioEncoderConfig {
  return { codec: 'opus', sampleRate, numberOfChannels: 2, bitrate, bitrateMode: 'constant' } as AudioEncoderConfig
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice() : new Uint8Array(source).slice()
}

export class CodecRecorder {
  state: RecordingState = 'inactive'
  readonly mimeType = CODEC_MIME
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  private readonly writer = new WebmWriter(bytes => void this.parts.push(bytes))
  private parts: Uint8Array[] = []
  private readonly videoEncoder: VideoEncoder
  private readonly audioEncoder: AudioEncoder
  private size: { width: number; height: number } | null = null
  private keyDue = true
  private lastKeyAt = 0
  private samples = 0
  private headWritten = false
  private startedAt = 0
  private pausedAt = 0
  private pausedFor = 0
  private timer = 0
  private ending = false

  /** Null where the browser lacks something (WebCodecs, VP9, Opus, AudioWorklet): then MediaRecorder records, as before. */
  static async open(screen: FrameSource, context: AudioContext, sound: AudioNode, options: CodecRecorderOptions): Promise<CodecRecorder | null> {
    if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof VideoFrame === 'undefined' || typeof AudioData === 'undefined' || typeof AudioWorkletNode === 'undefined' || !context.audioWorklet) return null
    try {
      const [video, audio] = await Promise.all([VideoEncoder.isConfigSupported(videoConfig(1920, 1080, options.videoBitsPerSecond)), AudioEncoder.isConfigSupported(audioConfig(context.sampleRate, options.audioBitsPerSecond))])
      if (!video.supported || !audio.supported) return null
      const url = URL.createObjectURL(new Blob([TAP_PROCESSOR], { type: 'text/javascript' }))
      try {
        await context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const tap = new AudioWorkletNode(context, 'study-helper-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', processorOptions: { size: Math.round(context.sampleRate / BLOCKS_PER_SECOND) } })
      return new CodecRecorder(screen, context, sound, tap, options)
    } catch {
      return null
    }
  }

  private constructor(
    private readonly screen: FrameSource,
    private readonly context: AudioContext,
    private readonly sound: AudioNode,
    private readonly tap: AudioWorkletNode,
    private readonly options: CodecRecorderOptions,
  ) {
    const failed = (error: unknown) => {
      console.error('A gravação otimizada parou:', error)
      this.stop()
    }
    this.videoEncoder = new VideoEncoder({
      output: chunk => this.writer.add({ track: 'video', timestamp: chunk.timestamp, key: chunk.type === 'key', data: this.copy(chunk) }),
      error: failed,
    })
    this.audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (!this.headWritten) {
          this.headWritten = true
          const description = metadata?.decoderConfig?.description
          this.writer.audio(context.sampleRate, 2, description ? bytesOf(description) : undefined)
        }
        this.writer.add({ track: 'audio', timestamp: chunk.timestamp, key: true, data: this.copy(chunk) })
      },
      error: failed,
    })
    this.audioEncoder.configure(audioConfig(context.sampleRate, options.audioBitsPerSecond))
  }

  start(timeslice = 1000): void {
    if (this.state !== 'inactive' || this.ending) return
    this.state = 'recording'
    this.startedAt = this.context.currentTime
    this.tap.port.onmessage = (event: MessageEvent<Float32Array[]>) => this.hear(event.data)
    this.sound.connect(this.tap)
    this.screen.handTo(canvas => this.see(canvas))
    this.timer = window.setInterval(() => this.emit(), timeslice)
  }

  pause(): void {
    if (this.state !== 'recording') return
    this.state = 'paused'
    this.pausedAt = this.context.currentTime
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.pausedFor += this.context.currentTime - this.pausedAt
    this.state = 'recording'
  }

  /** Inactive at once, as MediaRecorder; onstop comes once the encoders are empty and the whole file was handed. */
  stop(): void {
    if (this.ending) return
    this.ending = true
    this.state = 'inactive'
    this.screen.handTo(null)
    this.tap.port.onmessage = null
    try {
      this.sound.disconnect(this.tap)
    } catch {
      // already apart
    }
    void this.end()
  }

  private async end(): Promise<void> {
    await Promise.allSettled([this.videoEncoder.flush(), this.audioEncoder.flush()])
    for (const encoder of [this.videoEncoder, this.audioEncoder]) {
      try {
        encoder.close()
      } catch {
        // closed by its error
      }
    }
    this.writer.finish()
    window.clearInterval(this.timer)
    this.emit()
    this.onstop?.()
  }

  /** Microseconds of recording at this moment of the sound's clock, without the paused time. */
  private now(): number {
    return Math.round((this.context.currentTime - this.startedAt - this.pausedFor) * 1e6)
  }

  private see(canvas: HTMLCanvasElement): void {
    if (this.state !== 'recording') return
    const { width, height } = canvas
    if (!width || !height) return
    if (this.size?.width !== width || this.size?.height !== height) {
      this.videoEncoder.configure(videoConfig(width, height, this.options.videoBitsPerSecond))
      this.size = { width, height }
      this.keyDue = true
      this.writer.video(width, height)
    }
    const timestamp = this.now()
    if (timestamp - this.lastKeyAt >= this.options.keyFrameIntervalMs * 1000) this.keyDue = true
    if (this.videoEncoder.encodeQueueSize > MAX_QUEUE) return
    const frame = new VideoFrame(canvas, { timestamp })
    try {
      this.videoEncoder.encode(frame, { keyFrame: this.keyDue })
    } finally {
      frame.close()
    }
    if (this.keyDue) {
      this.keyDue = false
      this.lastKeyAt = timestamp
    }
  }

  private hear(channels: Float32Array[]): void {
    if (this.state !== 'recording') return
    const frames = channels[0].length
    const planar = new Float32Array(frames * 2)
    planar.set(channels[0], 0)
    planar.set(channels[1] ?? channels[0], frames)
    const rate = this.context.sampleRate
    const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: frames, numberOfChannels: 2, timestamp: Math.round((this.samples / rate) * 1e6), data: planar })
    this.samples += frames
    try {
      this.audioEncoder.encode(data)
    } finally {
      data.close()
    }
  }

  private copy(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    return data
  }

  private emit(): void {
    if (!this.parts.length) return
    const data = new Blob(this.parts as BlobPart[], { type: this.mimeType })
    this.parts = []
    this.ondataavailable?.({ data })
  }
}
