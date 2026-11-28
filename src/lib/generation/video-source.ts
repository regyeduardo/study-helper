// FrameSource over a recorded video Blob, in the browser: seeks a hidden <video> and draws to canvas.
import type { Box, FrameSource, Shot } from './ata-types'
import { getMediaThumbs } from '@/controllers/library-api.controller'
import { jumpable } from '@/lib/recording/frame-grab'
import { openPass, type PassFrame, type VideoPass } from '@/lib/recording/video-pass'
import { FRAME_LATE, VIDEO_BROKEN, videoEvent } from '@/lib/recording/video-wait'
import { appMediaOf } from '@/lib/storage/media-ref'

const FRAME_WIDTH = 1280
const SIGNATURE_WIDTH = 48
const SIGNATURE_HEIGHT = 36
const DURATION_PROBE_MS = 2000
const THUMB_VIDEOS = 4
/** Thumbnails in a row that did not come: the video stopped handing them (T188). */
const LATE_IN_A_ROW = 3
const DRAW_ERROR = 'Não foi possível desenhar o quadro do vídeo.'

// never forever: an error the video already has, a new one, or the limit end the wait (T180)
const once = (target: HTMLMediaElement, event: string) => videoEvent(target, event)

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

/** One gray byte per pixel of RGBA data. */
function grayOf(pixels: Uint8ClampedArray, count: number): Uint8Array {
  const gray = new Uint8Array(count)
  for (let pixel = 0; pixel < count; pixel++) gray[pixel] = (pixels[pixel * 4] + pixels[pixel * 4 + 1] + pixels[pixel * 4 + 2]) / 3
  return gray
}

export function signatureDifference(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (!length) return Infinity
  let total = 0
  for (let index = 0; index < length; index += 1) total += Math.abs(a[index] - b[index])
  return total / length
}

/**
 * Where the box (in the opening size of the video) lies in a frame of `frameWidth`×`frameHeight`: a MediaRecorder webm can open at 1280x720
 * and grow to 1920x1080 after the first frame. The same cut for a jump of the <video> and for the frames of the pass (T191).
 */
export function cropArea(box: Box, opening: { width: number; height: number }, frameWidth: number, frameHeight: number) {
  const sx = opening.width ? frameWidth / opening.width : 1
  const sy = opening.height ? frameHeight / opening.height : 1
  const x1 = clamp(box.x * sx, 0, Math.max(0, frameWidth - 1))
  const y1 = clamp(box.y * sy, 0, Math.max(0, frameHeight - 1))
  const x2 = clamp((box.x + box.w) * sx, x1 + 1, Math.max(x1 + 1, frameWidth))
  const y2 = clamp((box.y + box.h) * sy, y1 + 1, Math.max(y1 + 1, frameHeight))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export async function openVideoFrames(video: Blob): Promise<FrameSource> {
  const element = document.createElement('video')
  element.muted = true
  element.preload = 'auto'
  const seekable = await jumpable(video)
  const url = URL.createObjectURL(seekable)
  const loaded = once(element, 'loadeddata')
  element.src = url
  // T191: the frames of many times in one pass, where WebCodecs decodes this video; opened at the first batch, never for one frame
  let passing: Promise<VideoPass | null> | null = null
  const pass = () => (passing ??= openPass(seekable))

  const release = () => {
    element.removeAttribute('src')
    URL.revokeObjectURL(url)
    void passing?.then(opened => opened?.close())
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

  // the whole frame at most 1280 px wide (`full`), or the box at 1280 px wide (`crop`), drawn from a jump or from a frame of the pass
  const fullCanvas = (draw: (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void) => {
    const scale = Math.min(1, FRAME_WIDTH / (width || FRAME_WIDTH))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round((width || FRAME_WIDTH) * scale))
    canvas.height = Math.max(1, Math.round((height || 720) * scale))
    draw(context2d(canvas), canvas)
    return canvas
  }
  const cropCanvas = (box: Box, frameWidth: number, frameHeight: number, draw: (context: CanvasRenderingContext2D, area: Box, canvas: HTMLCanvasElement) => void) => {
    const area = cropArea(box, { width, height }, frameWidth, frameHeight)
    const canvas = document.createElement('canvas')
    canvas.width = FRAME_WIDTH
    canvas.height = Math.max(1, Math.round((FRAME_WIDTH * area.h) / area.w))
    draw(context2d(canvas), area, canvas)
    return canvas
  }
  const fromFrame = (at: number, frame: PassFrame, box?: Box): Shot =>
    box
      ? shot(at, cropCanvas(box, frame.width || width, frame.height || height, (context, area, canvas) => frame.draw(context, area.x, area.y, area.w, area.h, 0, 0, canvas.width, canvas.height)), 0.9)
      : shot(at, fullCanvas((context, canvas) => frame.draw(context, 0, 0, frame.width || width, frame.height || height, 0, 0, canvas.width, canvas.height)), 0.85)
  const crop = (at: number, box: Box) =>
    run(async () => {
      await seek(at)
      const canvas = cropCanvas(box, element.videoWidth || width, element.videoHeight || height, (context, area, target) =>
        context.drawImage(element, area.x, area.y, area.w, area.h, 0, 0, target.width, target.height),
      )
      return shot(at, canvas, 0.9)
    })
  const full = (at: number) =>
    run(async () => {
      await seek(at)
      return shot(at, fullCanvas((context, canvas) => context.drawImage(element, 0, 0, canvas.width, canvas.height)), 0.85)
    })

  return {
    width,
    height,
    duration,
    full,
    crop,
    // T191: many frames in one pass; a pass that fails mid-way leaves the rest to the jumps, as before, and a frame that does not come is null
    shots: async (times: number[], box?: Box) => {
      const out = new Map<number, Shot | null>()
      const one = await pass()
      if (one) {
        try {
          await one.each(
            times.map(at => (duration > 0 ? clamp(at, 0, duration) : Math.max(0, at))),
            (at, frame) => void out.set(at, frame ? fromFrame(at, frame, box) : null),
          )
        } catch {
          // the jumps below read what the pass did not
        }
      }
      const result: (Shot | null)[] = []
      for (const at of times) {
        const target = duration > 0 ? clamp(at, 0, duration) : Math.max(0, at)
        let found = out.get(target)
        if (found === undefined) {
          found = await (box ? crop(at, box) : full(at)).catch(error => {
            if (error instanceof Error && error.message === VIDEO_BROKEN) throw error
            return null
          })
          out.set(target, found)
        }
        result.push(found && found.at !== at ? { ...found, at } : found)
      }
      return result
    },
    // Seeks cost ~85 ms each in a MediaRecorder webm: a few hidden videos share the times, and the one used for crops stays put.
    // T188: no more of them than the cores (on the server's 2 vCPU, 4 decoders made each jump slower, up to the 20 s limit), and a
    // thumbnail that does not come repeats the one before it (one late jump used to throw the whole index away); a few in a row fail.
    thumbs: async (times: number[], thumbWidth: number, thumbHeight: number) => {
      // T197: a media of the App has them made by the server's ffmpeg, once, where it is kept (the index asks for times one step apart)
      const kept = appMediaOf(video)
      const step = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 0
      if (kept && step >= 0.5 && times.every((at, index) => Math.abs(at - (times[0] + index * step)) < 0.11)) {
        try {
          const made = await getMediaThumbs(kept.item, kept.media, { from: times[0], step: Math.round(step * 1000) / 1000, count: times.length, width: thumbWidth, height: thumbHeight })
          if (made.length) return times.map((_, index) => made[Math.min(index, made.length - 1)])
        } catch {
          // the pass, or the hidden videos, as before
        }
      }
      const out: (Uint8Array | undefined)[] = new Array(times.length)
      // T191: one pass where it can (8 times faster than jumping, measured); the hidden videos below otherwise, or if the pass fails
      const one = await pass()
      if (one) {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = thumbWidth
          canvas.height = thumbHeight
          const context = context2d(canvas, { willReadFrequently: true })
          const byTime = new Map<number, Uint8Array>()
          await one.each(times.map(at => (duration > 0 ? clamp(at, 0, duration) : Math.max(0, at))), (at, frame) => {
            if (!frame) return
            frame.draw(context, 0, 0, frame.width || width, frame.height || height, 0, 0, thumbWidth, thumbHeight)
            byTime.set(at, grayOf(context.getImageData(0, 0, thumbWidth, thumbHeight).data, thumbWidth * thumbHeight))
          })
          if (byTime.size) {
            const shown = times.map(at => byTime.get(duration > 0 ? clamp(at, 0, duration) : Math.max(0, at)))
            const first = shown.find(Boolean)!
            let before = first
            return shown.map(gray => (before = gray ?? before))
          }
        } catch {
          // the hidden videos below, as before
        }
      }
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || THUMB_VIDEOS
      const videos = Math.max(1, Math.min(THUMB_VIDEOS, times.length, cores))
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
            let late = 0
            for (let index = Math.floor((part * times.length) / videos); index < Math.floor(((part + 1) * times.length) / videos); index++) {
              const seeked = once(helper, 'seeked')
              helper.currentTime = duration > 0 ? clamp(times[index], 0, duration) : Math.max(0, times[index])
              try {
                await seeked
              } catch (error) {
                if (!(error instanceof Error) || error.message !== FRAME_LATE || ++late >= LATE_IN_A_ROW) throw error
                continue
              }
              late = 0
              context.drawImage(helper, 0, 0, thumbWidth, thumbHeight)
              out[index] = grayOf(context.getImageData(0, 0, thumbWidth, thumbHeight).data, thumbWidth * thumbHeight)
            }
          } finally {
            helper.removeAttribute('src')
          }
        }),
      )
      // the thumbnails that did not come show the screen of the one before (no change there), or of the first that came
      const first = out.find(Boolean) ?? new Uint8Array(thumbWidth * thumbHeight)
      let before = first
      return Array.from({ length: times.length }, (_, index) => (before = out[index] ?? before))
    },
    close: release,
  }
}
