/**
 * Frames of a video at many times in one pass (T191, dono 27/11: "Corrija tudo… quero 0 problemas"). Jumping a hidden <video> to each time
 * decodes again from the key frame before it (one every 30 s in the app's recordings): measured on 2 cores without a GPU, 150 thumbnails took
 * 125 s that way and 15 s in one pass, and 60 frames of a transcription 34 s against 6 s. WebCodecs (through Mediabunny, which reads the file
 * in ranges) decodes each packet at most once, the times in order. The same frames come out (measured: shifting the jump by one frame only
 * makes the difference grow); only the scaling filter differs, by about 1 gray level in 255 on a screen.
 */

/** One decoded frame, drawn like a canvas image; its size can change in the middle of a recording. */
export interface PassFrame {
  readonly width: number
  readonly height: number
  draw(context: CanvasRenderingContext2D, sx: number, sy: number, sWidth: number, sHeight: number, dx: number, dy: number, dWidth: number, dHeight: number): void
}

export interface VideoPass {
  /** `use` gets each time asked, in time order (once per distinct time), with the frame shown then, or null before the first frame. */
  each(times: number[], use: (at: number, frame: PassFrame | null) => void | Promise<void>): Promise<void>
  close(): void
}

/** A pass that hands no frame for this long stopped (T180: no wait is forever); the caller goes on with the jumps. */
export const PASS_STALL_MS = 20_000
export const PASS_STALLED = 'A leitura do vídeo numa passada parou.'

/**
 * Null where WebCodecs cannot decode this video here (no VideoDecoder, a codec the browser lacks), or where the file asks for a rotation
 * (the hidden <video> turns it, and the boxes are measured on that): the caller jumps with the hidden <video>, as before.
 */
export async function openPass(video: Blob, { stallMs = PASS_STALL_MS }: { stallMs?: number } = {}): Promise<VideoPass | null> {
  if (typeof VideoDecoder === 'undefined' || !VideoDecoder) return null
  try {
    const { ALL_FORMATS, BlobSource, Input, VideoSampleSink } = await import('mediabunny')
    const input = new Input({ source: new BlobSource(video), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track || track.rotation !== 0 || !(await track.canDecode())) {
      input.dispose()
      return null
    }
    return {
      async each(times, use) {
        const sorted = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b)
        if (!sorted.length) return
        let index = 0
        const frames = new VideoSampleSink(track).samplesAtTimestamps(sorted, { verifyKeyPackets: true })[Symbol.asyncIterator]()
        try {
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined
            const stalled = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(PASS_STALLED)), stallMs)))
            const step = await Promise.race([frames.next(), stalled]).finally(() => clearTimeout(timer))
            if (step.done) break
            const sample = step.value
            const at = sorted[index++]
            try {
              await use(
                at,
                sample
                  ? {
                      width: sample.displayWidth,
                      height: sample.displayHeight,
                      draw: (context, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight) => sample.draw(context, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight),
                    }
                  : null,
              )
            } finally {
              sample?.close()
            }
          }
        } finally {
          // ends the decoding (and closes what it still held), also when the pass stopped or the caller failed
          void frames.return?.(undefined)
        }
      },
      close: () => input.dispose(),
    }
  } catch {
    return null
  }
}
