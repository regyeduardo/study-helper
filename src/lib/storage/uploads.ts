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
  const { onProgress, retries = 3, wait = sleep } = options
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
  onProgress?.({ state: 'uploading', sentBytes, totalBytes })
  for (let n = 1; n <= count; n++) {
    if (done.has(n)) continue
    const blob = job.file.slice((n - 1) * size, Math.min(n * size, totalBytes))
    for (let attempt = 0; ; attempt++) {
      try {
        await putUploadPart(start.upload, n, blob)
        break
      } catch (error) {
        if (!transient(error)) throw error
        if (attempt >= retries) throw new UploadInterrupted(start.upload, sentBytes, totalBytes)
        await wait(1000 * 2 ** attempt)
      }
    }
    sentBytes += blob.size
    onProgress?.({ state: 'uploading', sentBytes, totalBytes })
  }
  const result = await completeUpload(start.upload)
  onProgress?.({ state: 'stored', sentBytes: totalBytes, totalBytes })
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
