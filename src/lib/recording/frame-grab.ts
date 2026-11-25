import { makeSeekable } from '@/lib/recording/seekable'
import { videoEvent } from '@/lib/recording/video-wait'

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

/**
 * What the optimized recording calls a change (T173): a person moving in a camera, with nothing of the content changing, used to keep it
 * at 30 frames a second. The screen is looked at in a small copy, at most every LOOK_MS, in a grid of cells. A cell that moved in
 * nearly every look for about 5 s (busy ≥ CAMERA_BUSY) moves like a camera: while it keeps moving, and for CAMERA_KEEP_MS after, what
 * it changes waits for the frame of each second. Anything else that changes (a slide, a letter typed, the mouse, a scroll) calls for
 * frames at once, as before. And when what moves like a camera covers a third of the screen or more (a video shown, a demonstration,
 * the cameras filling the screen), nothing waits: what moves may be the content. The edges of a camera move less (the wall behind the
 * person, a cell half over the picture, measured 0.55 to 0.82 busy in Chromium): a cell that keeps some motion next to a camera is part
 * of it, and next to a camera only a big change (a slide, not the picture's noise) counts as content.
 */
export const LOOK_WIDTH = 256
export const LOOK_HEIGHT = 144
const LOOK_MS = 100
const COLUMNS = 32
const ROWS = 18
const CELL = LOOK_WIDTH / COLUMNS
const CELLS = COLUMNS * ROWS
/** Time constant of how busy a cell is: about 5 s moving without a stop to reach CAMERA_BUSY. */
const BUSY_TAU_MS = 2200
/** How long a move counts for: a look long after the one before does not make the whole gap busy. */
const MOVE_SPAN_MS = 250
const CAMERA_BUSY = 0.9
/** A camera stays a camera while it keeps this busy, and for CAMERA_KEEP_MS after (a person stops for a while and moves again). */
const CAMERA_KEEP_BUSY = 0.6
const CAMERA_KEEP_MS = 10_000
const CAMERA_AREA_LIMIT = 1 / 3
const EDGE_BUSY = 0.3
/** Mean difference of a cell's pixels (0 to 255) from the look before that counts as moving, and from the frame sent that counts as a change. */
const MOVED = 1.5
const CHANGED = 3
const CHANGED_NEXT_TO_CAMERA = 10

export type ScreenChange = 'content' | 'camera' | 'none'

function nextTo(cells: Uint8Array, cell: number): boolean {
  const column = cell % COLUMNS
  const row = Math.floor(cell / COLUMNS)
  for (let y = Math.max(0, row - 1); y <= Math.min(ROWS - 1, row + 1); y++) {
    for (let x = Math.max(0, column - 1); x <= Math.min(COLUMNS - 1, column + 1); x++) if (cells[y * COLUMNS + x] && y * COLUMNS + x !== cell) return true
  }
  return false
}

export class ChangeGate {
  private last: Float32Array | null = null
  private shown: Float32Array | null = null
  private lookedAt = 0
  private readonly busy = new Float32Array(CELLS)
  private readonly cameraUntil = new Float64Array(CELLS)
  private readonly changes = new Float32Array(CELLS)
  private readonly cameras = new Uint8Array(CELLS)

  /** pixels: RGBA of the small copy (LOOK_WIDTH × LOOK_HEIGHT). */
  look(pixels: ArrayLike<number>, now: number): ScreenChange {
    const luma = new Float32Array(LOOK_WIDTH * LOOK_HEIGHT)
    for (let index = 0; index < luma.length; index++) luma[index] = (pixels[index * 4] * 2 + pixels[index * 4 + 1] * 5 + pixels[index * 4 + 2]) / 8
    const last = this.last
    const shown = this.shown
    const gap = Math.max(0, now - this.lookedAt)
    this.last = luma
    this.lookedAt = now
    if (!last || !shown) {
      this.shown = luma
      return 'content'
    }
    const decay = Math.exp(-gap / BUSY_TAU_MS)
    const moving = 1 - Math.exp(-Math.min(gap, MOVE_SPAN_MS) / BUSY_TAU_MS)
    for (let cell = 0; cell < CELLS; cell++) {
      const left = (cell % COLUMNS) * CELL
      const top = Math.floor(cell / COLUMNS) * CELL
      let moved = 0
      let changed = 0
      for (let y = top; y < top + CELL; y++) {
        for (let at = y * LOOK_WIDTH + left, end = at + CELL; at < end; at++) {
          moved += Math.abs(luma[at] - last[at])
          changed += Math.abs(luma[at] - shown[at])
        }
      }
      const busy = (this.busy[cell] = this.busy[cell] * decay + (moved / (CELL * CELL) >= MOVED ? moving : 0))
      this.changes[cell] = changed / (CELL * CELL)
      if (busy >= CAMERA_BUSY || (now < this.cameraUntil[cell] && busy >= CAMERA_KEEP_BUSY)) this.cameraUntil[cell] = now + CAMERA_KEEP_MS
      this.cameras[cell] = now < this.cameraUntil[cell] ? 1 : 0
    }
    // one ring around each camera: its edges keep some motion
    for (let cell = 0; cell < CELLS; cell++) if (!this.cameras[cell] && this.busy[cell] >= EDGE_BUSY && nextTo(this.cameras, cell)) this.cameraUntil[cell] = now + CAMERA_KEEP_MS
    let content = false
    let camera = false
    let cameraCells = 0
    for (let cell = 0; cell < CELLS; cell++) {
      if (now < this.cameraUntil[cell]) {
        cameraCells++
        camera ||= this.changes[cell] >= CHANGED
      } else content ||= this.changes[cell] >= (nextTo(this.cameras, cell) ? CHANGED_NEXT_TO_CAMERA : CHANGED)
    }
    if (content || (camera && cameraCells >= CELLS * CAMERA_AREA_LIMIT)) return 'content'
    return camera ? 'camera' : 'none'
  }

  /** The frame just sent shows the last look. */
  sent(): void {
    if (this.last) this.shown = this.last
  }
}

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
  /** The small copy of the screen the optimized recording looks at (T173); null where it cannot be read: every new frame counts. */
  private looking: CanvasRenderingContext2D | null = null
  private gate = new ChangeGate()
  private lookedAt = 0
  /** Until when a camera is held back: the last look that held one, and a second more (a screen that hands nothing more stops it). */
  private holdingUntil = 0
  /**
   * Firefox (requestFrame on the stream) keeps the pace while a camera is held back: its encoder (VP8) loses itself when the pace
   * drops, with a key frame every ~25 frames once they come back to 30 a second and a frame of 140 to 230 KB after each stop; the file
   * came out 20% bigger than before T173, and with the pace kept, 5 to 6% smaller (Waterfox 153). It still spends its 250 kb/s.
   */
  private readonly keepsPace: boolean
  /** Who encodes each frame (WebCodecs, T174): the frame goes to it instead of the canvas's track. */
  private sink: ((canvas: HTMLCanvasElement) => void) | null = null

  constructor(fps: number, onlyChanges = false) {
    this.onlyChanges = onlyChanges
    this.canvas.width = 1280
    this.canvas.height = 720
    this.context = this.canvas.getContext('2d')
    if (onlyChanges) {
      const copy = document.createElement('canvas')
      copy.width = LOOK_WIDTH
      copy.height = LOOK_HEIGHT
      this.looking = copy.getContext('2d', { willReadFrequently: true })
      if (this.looking) this.looking.imageSmoothingQuality = 'high'
    }
    this.video.muted = true
    this.video.playsInline = true
    this.stream = this.canvas.captureStream(onlyChanges ? 0 : fps)
    this.track = this.stream.getVideoTracks()[0]
    this.keepsPace = !('requestFrame' in this.track) && 'requestFrame' in this.stream
    this.ticker = startTicker(1000 / fps, () => this.draw())
  }

  show(stream: MediaStream | null): void {
    this.video.srcObject = stream
    this.fresh = true
    // another screen: where its cameras are is learned again
    this.gate = new ChangeGate()
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
    if ((this.fresh || !(this.told || this.counted)) && now - this.lookedAt >= LOOK_MS) {
      this.fresh = false
      this.lookedAt = now
      const seen = this.look(now)
      if (seen === null || seen === 'content') this.changedAt = now
      this.holdingUntil = seen === 'camera' ? now + BEAT_MS : 0
    }
    if (now - this.changedAt >= SETTLE_MS && now - this.sentAt < BEAT_MS) {
      if (now < this.holdingUntil && this.keepsPace && !this.sink) this.repeat()
      return
    }
    this.paint()
    this.sentAt = now
    this.gate.sent()
    this.requestFrame()
  }

  /** The same picture again: the canvas drawn on itself, so the browser hands one more frame. */
  private repeat(): void {
    this.context?.drawImage(this.canvas, 0, 0, 1, 1, 0, 0, 1, 1)
    this.requestFrame()
  }

  /** What changed since the frame sent (T173), or null when the screen cannot be looked at: then every new frame counts, as before. */
  private look(now: number): ScreenChange | null {
    const looking = this.looking
    if (!looking || !this.video.srcObject || !this.video.videoWidth) return null
    try {
      looking.drawImage(this.video, 0, 0, LOOK_WIDTH, LOOK_HEIGHT)
      return this.gate.look(looking.getImageData(0, 0, LOOK_WIDTH, LOOK_HEIGHT).data, now)
    } catch {
      this.looking = null
      return null
    }
  }

  /**
   * Chrome and Safari ask on the track (the spec), Firefox only on the stream. Asking only the track, in Firefox the one frame recorded
   * was the black one painted before the screen came, and the optimized video came out all dark (T171, measured in Waterfox 153).
   */
  handTo(sink: ((canvas: HTMLCanvasElement) => void) | null): void {
    this.sink = sink
  }

  private requestFrame(): void {
    if (this.sink) return this.sink(this.canvas)
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

// never forever: an error the video already has, a new one, or the limit end the wait (T180)
const once = (target: HTMLMediaElement, event: string) => videoEvent(target, event)

/** A WebM of before has its index made again: the old one pointed at frames a jump cannot start from (T180, PIPELINE_ERROR_DECODE). */
export const jumpable = (video: Blob) => (/webm/i.test(video.type) ? makeSeekable(video, { redo: true }) : Promise.resolve(video))

export async function grabFrames(video: Blob, times: number[]): Promise<GrabbedFrame[]> {
  const element = document.createElement('video')
  element.muted = true
  element.preload = 'auto'
  const url = URL.createObjectURL(await jumpable(video))
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
