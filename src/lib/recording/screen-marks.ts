import type { OcrText, ScreenOcr } from '@/lib/generation/ata-types'
import type { ScreenChange } from '@/lib/recording/frame-grab'
import type { ScreenIndex } from '@/types/domain'

/**
 * T201 (dono, 28/11: "Tudo em 1 min"; research R30): the recording marks each new screen while it records: the moment, a photo and the
 * text the browser's OCR read on it. The transcription and the Ata then read the screens from the marks instead of decoding the whole
 * video afterwards (403 s on the server for 1h30, 20 min in the job's Chromium).
 */

/** A screen is new once its content changed and then kept still this long (the same second the optimized recording waits to firm it). */
export const MARK_SETTLE_MS = 1000

export interface ScreenMark {
  /** Seconds of recording when the screen settled (the pauses do not count). */
  at: number
  /** The screen as a JPEG data URL, 1280 px wide. */
  image: string
  texts?: OcrText[]
}

export interface MarkTools {
  /** Seconds of recording now, without the pauses; null while paused. */
  clock(): number | null
  /** The screen now as a JPEG data URL, or null when it cannot be taken. */
  snapshot(): string | null
  /** The browser's OCR (one screen at a time); null where there is none. */
  ocr: Pick<ScreenOcr, 'read'> | null
}

export interface MarkedScreens {
  /** The index as the transcription keeps it (`recording.screenIndex`). */
  index: ScreenIndex
  /** The photo of each screen, in the order of the index (the parts `telas/<n>`). */
  images: { at: number; image: string }[]
}

export class ScreenMarks {
  private readonly marks: ScreenMark[] = []
  private started = false
  /** When the content last changed (wall clock, ms) while the screen is not marked yet. */
  private changedAt: number | null = null
  private reading: Promise<void> = Promise.resolve()

  constructor(private readonly tools: MarkTools) {}

  get count(): number {
    return this.marks.length
  }

  /** Each look at the screen (the `ChangeGate`): only content counts as a change; the camera of who speaks does not. */
  look(seen: ScreenChange | null, now: number): void {
    if (seen === null) return
    if (!this.started) {
      this.started = true
      this.changedAt = now
    }
    if (seen === 'content') this.changedAt = now
  }

  /** Every tick of the recording (a still screen hands few frames, so the settling is checked here, not only on the looks). */
  tick(now: number): void {
    if (this.changedAt === null || now - this.changedAt < MARK_SETTLE_MS) return
    const at = this.tools.clock()
    if (at === null) return
    this.changedAt = null
    const image = this.tools.snapshot()
    if (!image) return
    const mark: ScreenMark = { at, image }
    this.marks.push(mark)
    this.read(mark)
  }

  private read(mark: ScreenMark): void {
    const ocr = this.tools.ocr
    if (!ocr) return
    this.reading = this.reading
      .then(() => ocr.read(mark.image))
      .then(
        texts => {
          mark.texts = texts
        },
        () => undefined,
      )
  }

  /** What was marked so far; a screen whose OCR did not finish comes without text (it is read later). Null without any mark. */
  result(duration: number, width: number, height: number): MarkedScreens | null {
    if (!this.marks.length) return null
    const screens = this.marks.map((mark, index) => ({ at: mark.at, end: index + 1 < this.marks.length ? this.marks[index + 1].at : Math.max(duration, mark.at), ...(mark.texts ? { texts: mark.texts } : {}) }))
    return { index: { width, height, area: { x: 0, y: 0, w: width, h: height }, madeBy: 'gravacao', screens }, images: this.marks.map(({ at, image }) => ({ at, image })) }
  }
}
