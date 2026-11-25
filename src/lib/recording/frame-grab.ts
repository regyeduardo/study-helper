const MAX_WIDTH = 1920
const TICKER_SOURCE = 'let timer;onmessage=event=>{clearInterval(timer);if(event.data>0)timer=setInterval(()=>postMessage(0),event.data)}'

interface Ticker {
  stop(): void
}

function startTicker(intervalMs: number, tick: () => void): Ticker {
  if (typeof Worker !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(new Blob([TICKER_SOURCE], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.onmessage = tick
    worker.postMessage(intervalMs)
    return {
      stop: () => {
        worker.terminate()
        URL.revokeObjectURL(url)
      },
    }
  }
  const timer = window.setInterval(tick, intervalMs)
  return { stop: () => window.clearInterval(timer) }
}

// The optimized recording (spec 007, FR-023, research R17): after the screen changes, frames go on for this long so the encoder settles
// the picture (the text gets sharp), and a still screen still hands one frame this often.
const SETTLE_MS = 1000
const BEAT_MS = 1000

export class ScreenCanvas {
  readonly track: MediaStreamTrack
  /** The canvas's stream: Firefox has requestFrame here (CanvasCaptureMediaStream), not on the track. */
  private readonly stream: MediaStream
  private readonly canvas = document.createElement('canvas')
  private readonly context: CanvasRenderingContext2D | null
  private readonly video = document.createElement('video')
  private readonly ticker: Ticker
  /** A frame only when the screen changed: the canvas has no rate of its own and is asked for each frame. */
  private readonly onlyChanges: boolean
  /** The browser tells each new frame of the screen; without it, every tick counts as a change. */
  private readonly told = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype
  /**
   * How many frames of the screen the video received: it grows with the app's tab hidden too (the person in the meeting's tab), where
   * requestVideoFrameCallback stops and the optimized recording fell to one frame a second (T170, measured 0 callbacks against 20
   * frames a second hidden). Null where the browser does not count.
   */
  private readonly counted = typeof HTMLVideoElement !== 'undefined' && 'getVideoPlaybackQuality' in HTMLVideoElement.prototype
  private framesSeen = -1
  private watching = false
  private stopped = false
  private fresh = true
  private changedAt = 0
  private sentAt = 0

  constructor(fps: number, onlyChanges = false) {
    this.onlyChanges = onlyChanges
    this.canvas.width = 1280
    this.canvas.height = 720
    this.context = this.canvas.getContext('2d')
    this.video.muted = true
    this.video.playsInline = true
    this.stream = this.canvas.captureStream(onlyChanges ? 0 : fps)
    this.track = this.stream.getVideoTracks()[0]
    this.ticker = startTicker(1000 / fps, () => this.draw())
  }

  show(stream: MediaStream | null): void {
    this.video.srcObject = stream
    this.fresh = true
    if (stream) void this.video.play().catch(() => undefined)
    if (this.onlyChanges && this.told && !this.watching) {
      this.watching = true
      this.video.requestVideoFrameCallback(this.watch)
    }
  }

  private readonly watch = (): void => {
    this.fresh = true
    if (!this.stopped) this.video.requestVideoFrameCallback(this.watch)
  }

  private draw(): void {
    if (!this.onlyChanges) return this.paint()
    const now = Date.now()
    if (this.counted && this.video.srcObject) {
      const frames = this.video.getVideoPlaybackQuality().totalVideoFrames
      if (frames !== this.framesSeen) this.fresh = true
      this.framesSeen = frames
    }
    if (this.fresh || !(this.told || this.counted)) {
      this.fresh = false
      this.changedAt = now
    }
    if (now - this.changedAt >= SETTLE_MS && now - this.sentAt < BEAT_MS) return
    this.paint()
    this.sentAt = now
    this.requestFrame()
  }

  /**
   * Chrome and Safari ask on the track (the spec), Firefox only on the stream. Asking only the track, in Firefox the one frame recorded
   * was the black one painted before the screen came, and the optimized video came out all dark (T171, measured in Waterfox 153).
   */
  private requestFrame(): void {
    const owner = 'requestFrame' in this.track ? this.track : 'requestFrame' in this.stream ? this.stream : null
    ;(owner as { requestFrame(): void } | null)?.requestFrame()
  }

  private paint(): void {
    const context = this.context
    if (!context) return
    if (!this.video.srcObject) {
      context.fillStyle = '#000'
      context.fillRect(0, 0, this.canvas.width, this.canvas.height)
      return
    }
    const { videoWidth, videoHeight } = this.video
    if (videoWidth && videoHeight) {
      const scale = Math.min(1, MAX_WIDTH / videoWidth)
      const width = Math.round(videoWidth * scale)
      const height = Math.round(videoHeight * scale)
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width
        this.canvas.height = height
      }
    }
    context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)
  }

  stop(): void {
    this.stopped = true
    this.ticker.stop()
    this.track.stop()
    this.video.srcObject = null
  }
}

export interface GrabbedFrame {
  at: number
  image: string
  signature: number[]
}

const FRAME_WIDTH = 1280
const SIGNATURE_WIDTH = 16
const SIGNATURE_HEIGHT = 9

function once(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true })
    target.addEventListener('error', () => reject(new Error('O vídeo da gravação não abriu.')), { once: true })
  })
}

export async function grabFrames(video: Blob, times: number[]): Promise<GrabbedFrame[]> {
  const url = URL.createObjectURL(video)
  const element = document.createElement('video')
  element.muted = true
  element.preload = 'auto'
  const loaded = once(element, 'loadeddata')
  element.src = url
  try {
    await loaded
    const scale = Math.min(1, FRAME_WIDTH / (element.videoWidth || FRAME_WIDTH))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round((element.videoWidth || FRAME_WIDTH) * scale)
    canvas.height = Math.round((element.videoHeight || 720) * scale)
    const small = document.createElement('canvas')
    small.width = SIGNATURE_WIDTH
    small.height = SIGNATURE_HEIGHT
    const context = canvas.getContext('2d')
    const tiny = small.getContext('2d', { willReadFrequently: true })
    if (!context || !tiny) return []
    const frames: GrabbedFrame[] = []
    for (const at of times) {
      const seeked = once(element, 'seeked')
      element.currentTime = Math.min(at, Number.isFinite(element.duration) ? element.duration : at)
      await seeked
      context.drawImage(element, 0, 0, canvas.width, canvas.height)
      tiny.drawImage(canvas, 0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT)
      const pixels = tiny.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT).data
      const signature: number[] = []
      for (let index = 0; index < pixels.length; index += 4) signature.push((pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3)
      frames.push({ at, image: canvas.toDataURL('image/jpeg', 0.75), signature })
    }
    return frames
  } finally {
    element.removeAttribute('src')
    URL.revokeObjectURL(url)
  }
}
