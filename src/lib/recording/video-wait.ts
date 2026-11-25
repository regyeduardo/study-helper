/**
 * Waiting on a hidden <video> that reads the frames of a recording (T180, 25/11): a decode error of the video (the server's Chromium said
 * PIPELINE_ERROR_DECODE) fires its "error" only once, and a wait that starts after it never ends. Every wait here looks at the error the
 * video already has, listens for a new one, and has a limit: the step fails with the reason and the work goes on without the frames.
 */

/** Plenty for a seek in a long video decoded without a GPU; past it, the frame is not coming. */
export const SEEK_LIMIT_MS = 20_000
export const VIDEO_BROKEN = 'O vídeo da gravação não abriu.'
export const FRAME_LATE = 'Um quadro do vídeo não veio em 20 s; segui sem ele.'

export function videoEvent(target: HTMLMediaElement, event: string, limitMs = SEEK_LIMIT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (target.error) return reject(new Error(VIDEO_BROKEN))
    const stop = () => {
      clearTimeout(timer)
      target.removeEventListener(event, done)
      target.removeEventListener('error', fail)
    }
    const done = () => {
      stop()
      resolve()
    }
    const fail = () => {
      stop()
      reject(new Error(VIDEO_BROKEN))
    }
    const timer = setTimeout(() => {
      stop()
      reject(new Error(FRAME_LATE))
    }, limitMs)
    target.addEventListener(event, done)
    target.addEventListener('error', fail)
  })
}
