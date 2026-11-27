import { env } from '@/lib/env'

/**
 * The live channel of the App (spec 003, entrega 4, contract api-biblioteca.md): the server says when the map changed, so another
 * device's change shows in seconds (SC-004). Without the channel, the app asks every 15 s and keeps trying to open it again.
 */

export interface LiveHandlers {
  /** What this device already has: the server answers "map" at once when it has more. */
  seq: () => number
  onMap: () => void
  onSpace?: (space: { notes: number; media: number; reserved: number }) => void
  onAccess?: (access: { status: string; deleteAt?: string }) => void
  /** A job of generating in the account changed (spec 007, história 2). */
  onJob?: (job: unknown) => void
}

const POLL_MS = 15_000
const RETRY_MS = [2_000, 5_000, 15_000, 30_000]

/** Opens the channel; returns the function that closes it for good. */
export function openLive(handlers: LiveHandlers): () => void {
  let socket: WebSocket | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let tries = 0
  let stopped = false
  const url = `${env.apiUrl.replace(/^http/, 'ws')}/v1/live`

  // without the channel, what changed is asked at once (the library opens from this device's copy without asking, spec 007 T028),
  // then every 15 s
  const startPolling = () => {
    if (poll) return
    handlers.onMap()
    poll = setInterval(() => handlers.onMap(), POLL_MS)
  }
  const stopPolling = () => {
    if (poll) clearInterval(poll)
    poll = null
  }

  const connect = () => {
    if (stopped) return
    try {
      socket = new WebSocket(url)
    } catch {
      startPolling()
      return scheduleRetry()
    }
    socket.onopen = () => {
      tries = 0
      stopPolling()
      socket?.send(JSON.stringify({ type: 'hello', seq: handlers.seq() }))
    }
    socket.onmessage = event => {
      let message: { type?: string; [field: string]: unknown }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.type === 'map') handlers.onMap()
      else if (message.type === 'space') handlers.onSpace?.({ notes: Number(message.notes) || 0, media: Number(message.media) || 0, reserved: Number(message.reserved) || 0 })
      else if (message.type === 'access') handlers.onAccess?.({ status: String(message.status), ...(message.deleteAt ? { deleteAt: String(message.deleteAt) } : {}) })
      else if (message.type === 'job' && message.job) handlers.onJob?.(message.job)
    }
    socket.onclose = () => {
      socket = null
      if (stopped) return
      startPolling()
      scheduleRetry()
    }
  }

  const scheduleRetry = () => {
    if (stopped || retry) return
    retry = setTimeout(() => {
      retry = null
      tries += 1
      connect()
    }, RETRY_MS[Math.min(tries, RETRY_MS.length - 1)])
  }

  connect()
  return () => {
    stopped = true
    stopPolling()
    if (retry) clearTimeout(retry)
    retry = null
    socket?.close()
    socket = null
  }
}
