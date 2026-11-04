// FrameSource over a recorded video Blob, in the browser: seeks a hidden <video> and draws to canvas.
import type { Box, FrameSource, Shot } from './ata-types'

const FRAME_WIDTH = 1280
const SIGNATURE_WIDTH = 48
const SIGNATURE_HEIGHT = 36
const DURATION_PROBE_MS = 2000
const THUMB_VIDEOS = 4
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
        // A MediaRecorder webm can open at 1280x720 and grow to 1920x1080 after the first frame: the box is in the opening size
        const frameWidth = element.videoWidth || width
        const frameHeight = element.videoHeight || height
        const sx = width ? frameWidth / width : 1
        const sy = height ? frameHeight / height : 1
        const x1 = clamp(box.x * sx, 0, Math.max(0, frameWidth - 1))
        const y1 = clamp(box.y * sy, 0, Math.max(0, frameHeight - 1))
        const x2 = clamp((box.x + box.w) * sx, x1 + 1, Math.max(x1 + 1, frameWidth))
        const y2 = clamp((box.y + box.h) * sy, y1 + 1, Math.max(y1 + 1, frameHeight))
        const sourceWidth = x2 - x1
        const sourceHeight = y2 - y1
        const canvas = document.createElement('canvas')
        canvas.width = FRAME_WIDTH
        canvas.height = Math.max(1, Math.round((FRAME_WIDTH * sourceHeight) / sourceWidth))
        context2d(canvas).drawImage(element, x1, y1, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        return shot(at, canvas, 0.9)
      }),
    // Seeks cost ~85 ms each in a MediaRecorder webm: a few hidden videos share the times, and the one used for crops stays put.
    thumbs: async (times: number[], thumbWidth: number, thumbHeight: number) => {
      const out: Uint8Array[] = new Array(times.length)
      const videos = Math.max(1, Math.min(THUMB_VIDEOS, times.length))
      await Promise.all(
        Array.from({ length: videos }, async (_, part) => {
          const helper = document.createElement('video')
          helper.muted = true
          helper.preload = 'auto'
          const opened = once(helper, 'loadeddata')
          helper.src = url
          try {
            await opened
            const canvas = document.createElement('canvas')
            canvas.width = thumbWidth
            canvas.height = thumbHeight
            const context = context2d(canvas, { willReadFrequently: true })
            for (let index = Math.floor((part * times.length) / videos); index < Math.floor(((part + 1) * times.length) / videos); index++) {
              const seeked = once(helper, 'seeked')
              helper.currentTime = duration > 0 ? clamp(times[index], 0, duration) : Math.max(0, times[index])
              await seeked
              context.drawImage(helper, 0, 0, thumbWidth, thumbHeight)
              const pixels = context.getImageData(0, 0, thumbWidth, thumbHeight).data
              const gray = new Uint8Array(thumbWidth * thumbHeight)
              for (let pixel = 0; pixel < gray.length; pixel++) gray[pixel] = (pixels[pixel * 4] + pixels[pixel * 4 + 1] + pixels[pixel * 4 + 2]) / 3
              out[index] = gray
            }
          } finally {
            helper.removeAttribute('src')
          }
        }),
      )
      return out
    },
    close: release,
  }
}
