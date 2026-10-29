// FrameSource over a recorded video Blob, in the browser: seeks a hidden <video> and draws to canvas.
import type { Box, FrameSource, Shot } from './ata-types'

const FRAME_WIDTH = 1280
const SIGNATURE_WIDTH = 48
const SIGNATURE_HEIGHT = 36
const DURATION_PROBE_MS = 2000
const OPEN_ERROR = 'O vídeo da gravação não abriu.'
const DRAW_ERROR = 'Não foi possível desenhar o quadro do vídeo.'

function once(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      target.removeEventListener('error', fail)
      resolve()
    }
    const fail = () => {
      target.removeEventListener(event, done)
      reject(new Error(OPEN_ERROR))
    }
    target.addEventListener(event, done, { once: true })
    target.addEventListener('error', fail, { once: true })
  })
}

function settle(target: HTMLMediaElement, events: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer)
      for (const event of events) target.removeEventListener(event, finish)
      target.removeEventListener('error', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, timeoutMs)
    for (const event of events) target.addEventListener(event, finish)
    target.addEventListener('error', finish)
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Some recordings (MediaRecorder webm) report Infinity until the end is reached once. */
async function probeDuration(element: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(element.duration)) return element.duration
  const probed = settle(element, ['seeked', 'durationchange'], DURATION_PROBE_MS)
  element.currentTime = 1e9
  await probed
  const duration = element.duration
  const back = settle(element, ['seeked'], DURATION_PROBE_MS)
  element.currentTime = 0
  await back
  return Number.isFinite(duration) && duration > 0 ? duration : 0
}

function context2d(canvas: HTMLCanvasElement, options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', options) as CanvasRenderingContext2D | null
  if (!context) throw new Error(DRAW_ERROR)
  return context
}

export function signatureDifference(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (!length) return Infinity
  let total = 0
  for (let index = 0; index < length; index += 1) total += Math.abs(a[index] - b[index])
  return total / length
}

export async function openVideoFrames(video: Blob): Promise<FrameSource> {
  const url = URL.createObjectURL(video)
  const element = document.createElement('video')
  element.muted = true
  element.preload = 'auto'
  const loaded = once(element, 'loadeddata')
  element.src = url

  const release = () => {
    element.removeAttribute('src')
    URL.revokeObjectURL(url)
  }

  let width = 0
  let height = 0
  let duration = 0
  try {
    await loaded
    width = element.videoWidth
    height = element.videoHeight
    duration = await probeDuration(element)
  } catch (error) {
    release()
    throw error
  }

  const small = document.createElement('canvas')
  small.width = SIGNATURE_WIDTH
  small.height = SIGNATURE_HEIGHT
  let tiny: CanvasRenderingContext2D | null = null

  let queue: Promise<unknown> = Promise.resolve()
  let lastSeek: number | null = Number.isFinite(element.currentTime) && element.currentTime === 0 ? 0 : null

  function run<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  async function seek(at: number): Promise<void> {
    const target = duration > 0 ? clamp(at, 0, duration) : Math.max(0, at)
    if (lastSeek === target) return
    lastSeek = null
    const seeked = once(element, 'seeked')
    element.currentTime = target
    await seeked
    lastSeek = target
  }

  function signature(canvas: HTMLCanvasElement): number[] {
    tiny ??= context2d(small, { willReadFrequently: true })
    tiny.drawImage(canvas, 0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT)
    const pixels = tiny.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT).data
    const values: number[] = []
    for (let index = 0; index < pixels.length; index += 4) values.push((pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3)
    return values
  }

  function shot(at: number, canvas: HTMLCanvasElement, quality: number): Shot {
    return {
      at,
      image: canvas.toDataURL('image/jpeg', quality),
      width: canvas.width,
      height: canvas.height,
      signature: signature(canvas),
    }
  }

  return {
    width,
    height,
    duration,
    full: (at: number) =>
      run(async () => {
        await seek(at)
        const scale = Math.min(1, FRAME_WIDTH / (width || FRAME_WIDTH))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round((width || FRAME_WIDTH) * scale))
        canvas.height = Math.max(1, Math.round((height || 720) * scale))
        context2d(canvas).drawImage(element, 0, 0, canvas.width, canvas.height)
        return shot(at, canvas, 0.85)
      }),
    crop: (at: number, box: Box) =>
      run(async () => {
        await seek(at)
        const x1 = clamp(box.x, 0, Math.max(0, width - 1))
        const y1 = clamp(box.y, 0, Math.max(0, height - 1))
        const x2 = clamp(box.x + box.w, x1 + 1, Math.max(x1 + 1, width))
        const y2 = clamp(box.y + box.h, y1 + 1, Math.max(y1 + 1, height))
        const sourceWidth = x2 - x1
        const sourceHeight = y2 - y1
        const canvas = document.createElement('canvas')
        canvas.width = FRAME_WIDTH
        canvas.height = Math.max(1, Math.round((FRAME_WIDTH * sourceHeight) / sourceWidth))
        context2d(canvas).drawImage(element, x1, y1, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        return shot(at, canvas, 0.9)
      }),
    close: release,
  }
}
