import type { TokenProvider } from '@/controllers/drive.controller'
import { env } from '@/lib/env'

/**
 * Streaming of a media kept in the Google Drive (owner's "Sim, um streaming"): the player plays `/media-stream/<Drive id>` on the app's
 * own address and the app's service worker (public/media-stream-sw.js) asks the Drive for the parts with the token, which this page
 * gives on each request through the worker's channel. The token never goes in an address, and the worker keeps none.
 * Where the worker cannot do it there is no address, and the player downloads the media whole as before.
 */

const WORKER = 'media-stream-sw.js'
const STREAM = 'media-stream/'
/** Firefox before 153 hides the Range of a media request from the worker (bugzilla 1465074): jumps would start over from the top. */
const FIRST_FIREFOX = 153
/** How long the first time waits for the worker to take this page. */
const TAKE_MS = 4000

let tokens: TokenProvider | null = null
let taking: Promise<boolean> | null = null
let listening = false

/** The address the player streams a Drive media from, or null where this browser cannot (the media is downloaded whole). */
export async function driveStreamUrl(ref: string, token: TokenProvider): Promise<string | null> {
  const workers = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  if (!workers || !fitsWorker(navigator.userAgent)) return null
  tokens = token
  taking ??= take(workers).then(taken => {
    // a worker that did not come this time may come next time
    if (!taken) taking = null
    return taken
  })
  return (await taking) ? `${import.meta.env.BASE_URL}${STREAM}${encodeURIComponent(ref)}` : null
}

/** The app opens without internet (história 6): the worker that keeps the app's files is registered as soon as the app opens. */
export function keepAppOffline(built = import.meta.env.PROD): void {
  const workers = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  // while the app is being written (Vite's server), nothing is kept
  if (!workers || !built) return
  void workers.register(`${import.meta.env.BASE_URL}${WORKER}`, { scope: import.meta.env.BASE_URL }).catch(() => undefined)
}

function fitsWorker(userAgent: string): boolean {
  const firefox = /Firefox\/(\d+)/.exec(userAgent)
  return !firefox || Number(firefox[1]) >= FIRST_FIREFOX
}

async function take(workers: ServiceWorkerContainer): Promise<boolean> {
  if (!listening) {
    listening = true
    workers.addEventListener('message', answer)
  }
  try {
    await workers.register(`${import.meta.env.BASE_URL}${WORKER}`, { scope: import.meta.env.BASE_URL })
    if (workers.controller) return true
    const taken = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(Boolean(workers.controller)), TAKE_MS)
      workers.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer)
          resolve(true)
        },
        { once: true },
      )
    })
    // a page opened without the worker (a hard reload) is taken when it asks
    ;(await workers.ready).active?.postMessage({ type: 'claim' })
    return await taken
  } catch {
    return false
  }
}

/** The worker asks the token for each request it streams (`force` after the Drive refused the last one). */
async function answer(event: MessageEvent): Promise<void> {
  const port = event.ports?.[0]
  if (event.data?.type !== 'media-stream-token' || !port || !tokens) return
  try {
    port.postMessage({ token: await tokens(event.data.force ? { force: true } : undefined), base: env.googleApiBase })
  } catch {
    port.postMessage({ token: null })
  }
}
