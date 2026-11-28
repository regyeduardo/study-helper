import type { Box, FrameSource, Shot } from '@/lib/generation/ata-types'
import type { ScreenTools } from '@/lib/generation/frames'
import type { GrabbedFrame } from '@/lib/recording/frame-grab'
import type { ScreenIndex } from '@/types/domain'

/**
 * T203 (dono, 28/11: "Tudo em 1 min"; research R30): the screens the recording marked as the tools of the screen reading. No video is
 * opened: the frame of a moment is the photo of the screen marked last before it, the terms come from the text the OCR read while
 * recording (only a screen left without text is read now), and the index is the recording's.
 */
export interface MarkedScreensSource {
  /** The recording's index (`madeBy: 'gravacao'`). */
  index: ScreenIndex
  /** The photo of screen `n` (the part `telas/<n>`), or null when it did not come. */
  image(n: number): Promise<string | null>
}

/** The screen showing at `at`: the last marked at or before it (before the first, the first). */
export function screenAt(index: ScreenIndex, at: number): number {
  let found = 0
  for (let n = 0; n < index.screens.length; n++) if (index.screens[n].at <= at) found = n
  return found
}

/** The same screen gives the same signature, another screen one far from it (16 bits of `n` spread over the 144 values). */
function signatureOf(n: number): number[] {
  return Array.from({ length: 144 }, (_, at) => ((n >> (at % 16)) & 1) * 255)
}

export function markedTools(source: MarkedScreensSource, base: ScreenTools): ScreenTools {
  const photos = new Map<number, Promise<string | null>>()
  const screenOf = new Map<string, number>()
  const photo = (n: number) => {
    let found = photos.get(n)
    if (!found) {
      found = source
        .image(n)
        .catch(() => null)
        .then(image => {
          if (image) screenOf.set(image, n)
          return image
        })
      photos.set(n, found)
    }
    return found
  }
  return {
    marked: true,
    see: base.see,
    grab: async (_video, times) => {
      const frames = await Promise.all(
        times.map(async (at): Promise<GrabbedFrame | null> => {
          const n = screenAt(source.index, at)
          const image = await photo(n)
          return image ? { at, image, signature: signatureOf(n) } : null
        }),
      )
      return frames.filter((frame): frame is GrabbedFrame => frame !== null)
    },
    index: async () => source.index,
    ocr: () => {
      const now = base.ocr?.() ?? null
      return {
        read: async (image: string) => {
          const n = screenOf.get(image)
          const texts = n === undefined ? undefined : source.index.screens[n]?.texts
          if (texts) return texts
          return now ? now.read(image) : []
        },
        close: () => now?.close?.(),
      }
    },
  }
}

const SIGNATURE_WIDTH = 48
const SIGNATURE_HEIGHT = 36
/** A photo that cannot be measured here (no canvas: tests, the server) is taken as a plain gray picture, never as a dark one. */
const UNMEASURED = Array.from({ length: SIGNATURE_WIDTH * SIGNATURE_HEIGHT }, (_, at) => (at % 2 ? 96 : 160))

async function pictureOf(image: string): Promise<CanvasImageSource | null> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null
  const picture = new Image()
  picture.src = image
  try {
    await picture.decode()
    return picture
  } catch {
    return null
  }
}

/** The 48x36 gray signature of a photo (as `Shot.signature`), or a plain gray one where there is no canvas to draw it. */
async function signatureOfImage(image: string): Promise<number[]> {
  const picture = await pictureOf(image)
  const context = picture ? document.createElement('canvas').getContext('2d', { willReadFrequently: true }) : null
  if (!picture || !context) return UNMEASURED
  context.canvas.width = SIGNATURE_WIDTH
  context.canvas.height = SIGNATURE_HEIGHT
  context.drawImage(picture, 0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT)
  const pixels = context.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT).data
  return Array.from({ length: SIGNATURE_WIDTH * SIGNATURE_HEIGHT }, (_, at) => Math.round((pixels[at * 4] + pixels[at * 4 + 1] + pixels[at * 4 + 2]) / 3))
}

/** The box of the photo, as a JPEG data URL 1280 px wide at most; the whole photo where there is no canvas. */
async function cropOf(image: string, box: Box, width: number, height: number): Promise<string> {
  const picture = await pictureOf(image)
  const context = picture ? document.createElement('canvas').getContext('2d') : null
  if (!picture || !context) return image
  // the photo is 1280 px wide; the box is in pixels of the video
  const shown = picture as HTMLImageElement
  const scaleX = (shown.naturalWidth || width) / width
  const scaleY = (shown.naturalHeight || height) / height
  context.canvas.width = Math.min(1280, Math.round(box.w * scaleX))
  context.canvas.height = Math.round((context.canvas.width * box.h) / box.w)
  context.drawImage(picture, box.x * scaleX, box.y * scaleY, box.w * scaleX, box.h * scaleY, 0, 0, context.canvas.width, context.canvas.height)
  return context.canvas.toDataURL('image/jpeg', 0.85)
}

/**
 * The screens the recording marked as a source of frames (the check of T188, the Ata, the Aula and the Explicação step by step): the size
 * and the length of the index, and the frame of a moment is the photo of the screen of that moment. No video is opened.
 */
export function markedFrameSource(source: MarkedScreensSource): FrameSource {
  const { index } = source
  const duration = index.screens.length ? index.screens[index.screens.length - 1].end : 0
  const photoAt = async (at: number) => {
    const n = screenAt(index, at)
    const image = await source.image(n)
    if (!image) throw new Error(`A foto da tela marcada ${n + 1} da gravação não veio.`)
    return image
  }
  const full = async (at: number): Promise<Shot> => {
    const image = await photoAt(at)
    return { at, image, width: index.width, height: index.height, signature: await signatureOfImage(image) }
  }
  const crop = async (at: number, box: Box): Promise<Shot> => {
    const image = await cropOf(await photoAt(at), box, index.width, index.height)
    return { at, image, width: box.w, height: box.h, signature: await signatureOfImage(image) }
  }
  return {
    width: index.width,
    height: index.height,
    duration,
    scenes: index.screens.map(screen => screen.at),
    full,
    crop,
    shots: (times, box) => Promise.all(times.map(at => (box ? crop(at, box) : full(at)).catch(() => null))),
  }
}
