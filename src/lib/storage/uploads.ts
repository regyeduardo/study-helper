import { ApiError } from '@/controllers/api.controller'
import { completeUpload, putUploadPart, startUpload } from '@/controllers/library-api.controller'
import { StorageLimitError } from '@/lib/storage/repository'

/**
 * Sending a file or media to the App (spec 003, FR-019, FR-044): in parts of the size the server says (10 MiB), so a dropped
 * connection costs only the part that was going. The server keeps the parts already received, so sending the same media again
 * continues where it stopped; until "complete" the note's media is `uploading`, never shown as kept.
 */

export interface UploadProgress {
  state: 'uploading' | 'stored'
  sentBytes: number
  totalBytes: number
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void
  /** How many times a part that failed for the connection is sent again before stopping (default 3). */
  retries?: number
  /** The pause between tries; tests pass a no-op. */
  wait?: (ms: number) => Promise<void>
  /** How long one part may take before it is given up and sent again (3 min: the server gives up on the storage at 2). */
  partTimeout?: number
  /** Cancelar of the window it runs in: the part going stops at once, and nothing more is sent. */
  signal?: AbortSignal
}

/**
 * The upload the person is waiting for in the window right now (23/11, the owner: "não tem um botão de cancelar"): Cancelar stops it
 * between parts, and the bar shows how much went. The parts already sent stay on the server, so sending again goes on from there.
 */
export const watchedUpload: { cancelled?: () => boolean; onProgress?: (progress: UploadProgress) => void } = {}

/** Cancelar in the window: nothing more is sent; what went stays for a next try. */
export class UploadCancelled extends Error {
  constructor() {
    super('Envio cancelado. O que já subiu fica guardado: mandar de novo continua de onde parou.')
  }
}

/** The connection fell and the tries ran out: the parts already sent stay on the server for the next try. */
export class UploadInterrupted extends Error {
  constructor(
    readonly upload: string,
    readonly sentBytes: number,
    readonly totalBytes: number,
  ) {
    super('A conexão caiu no meio do envio. Ele continua de onde parou quando a internet voltar.')
    this.name = 'UploadInterrupted'
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** Worth trying again: no connection, or the server failing for a moment. */
const transient = (error: unknown) => error instanceof ApiError && (error.code === 'offline' || error.status >= 500)

export async function uploadMedia(job: { item: string; media: string; file: Blob; name: string; mime?: string }, options: UploadOptions = {}): Promise<{ upload: string; key: string; bytes: number; mime: string }> {
  const { onProgress, retries = 3, wait = sleep, partTimeout = 180_000, signal } = options
  const totalBytes = job.file.size
  const mime = job.mime || job.file.type || 'application/octet-stream'
  let start
  try {
    start = await startUpload({ item: job.item, media: job.media, name: job.name, mime, bytes: totalBytes })
  } catch (error) {
    if (error instanceof ApiError && error.code === 'no_space') throw new StorageLimitError(totalBytes, Number(error.data.missing) || totalBytes)
    throw error
  }
  const size = start.partSize
  const count = Math.max(1, Math.ceil(totalBytes / size))
  const done = new Set(start.parts.map(part => part.n))
  const sizeOf = (n: number) => Math.min(n * size, totalBytes) - (n - 1) * size
  let sentBytes = [...done].reduce((sum, n) => sum + sizeOf(n), 0)
  const tell = (progress: UploadProgress) => {
    onProgress?.(progress)
    watchedUpload.onProgress?.(progress)
  }
  tell({ state: 'uploading', sentBytes, totalBytes })
  for (let n = 1; n <= count; n++) {
    if (done.has(n)) continue
    if (watchedUpload.cancelled?.() || signal?.aborted) throw new UploadCancelled()
    const blob = job.file.slice((n - 1) * size, Math.min(n * size, totalBytes))
    for (let attempt = 0; ; attempt++) {
      try {
        // never waits forever (23/11, an upload looked stuck): past the limit the part counts as no connection and goes again
        const limit = AbortSignal.timeout(partTimeout)
        // a browser without AbortSignal.any stops between parts instead
        await putUploadPart(start.upload, n, blob, signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([limit, signal]) : limit, sent => tell({ state: 'uploading', sentBytes: sentBytes + sent, totalBytes }))
        break
      } catch (error) {
        if (signal?.aborted) throw new UploadCancelled()
        if (!transient(error)) throw error
        if (attempt >= retries) throw new UploadInterrupted(start.upload, sentBytes, totalBytes)
        await wait(1000 * 2 ** attempt)
      }
    }
    sentBytes += blob.size
    tell({ state: 'uploading', sentBytes, totalBytes })
  }
  const result = await completeUpload(start.upload)
  tell({ state: 'stored', sentBytes: totalBytes, totalBytes })
  return { upload: start.upload, ...result }
}

export interface UploadJob {
  item: string
  media: string
  name: string
  mime: string
  bytes: number
}

/**
 * The uploads that have not finished, per account, kept in this browser so they survive a reload; `resumeAll` (and the browser
 * coming back online, with `listen`) sends them again, and the server takes only the missing parts.
 */
export class UploadQueue {
  private readonly key: string

  constructor(
    accountId: string,
    private readonly blobOf: (item: string, media: string) => Promise<Blob | null>,
    private readonly options: UploadOptions = {},
  ) {
    this.key = `estudo-uploads-${accountId}`
  }

  pending(): UploadJob[] {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? '[]') as UploadJob[]
    } catch {
      return []
    }
  }

  private keep(jobs: UploadJob[]): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(jobs))
    } catch {
      // private window or full storage: the upload still runs, it just does not survive a reload
    }
  }

  private drop(job: UploadJob): void {
    this.keep(this.pending().filter(other => other.item !== job.item || other.media !== job.media))
  }

  /** Queues and sends; a dropped connection leaves it queued (no error), a refusal (no space, wrong type) takes it out and throws. */
  async add(job: UploadJob): Promise<void> {
    this.keep([...this.pending().filter(other => other.item !== job.item || other.media !== job.media), job])
    await this.run(job)
  }

  async resumeAll(): Promise<void> {
    for (const job of this.pending()) await this.run(job)
  }

  /** Resumes when the browser comes back online; returns the function that stops listening. */
  listen(): () => void {
    const resume = () => void this.resumeAll().catch(() => {})
    window.addEventListener('online', resume)
    return () => window.removeEventListener('online', resume)
  }

  private async run(job: UploadJob): Promise<void> {
    const file = await this.blobOf(job.item, job.media)
    if (!file) return this.drop(job)
    try {
      await uploadMedia({ ...job, file }, this.options)
      this.drop(job)
    } catch (error) {
      if (error instanceof UploadInterrupted) return
      this.drop(job)
      throw error
    }
  }
}
