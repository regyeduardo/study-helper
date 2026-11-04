// The app's local OCR: a few Web Workers side by side (one wasm thread each), started only when a video is read.
// The first worker downloads the models and the wasm once; the others start after it, from the browser cache.
import type { OcrText, ScreenOcr } from '@/lib/generation/ata-types'

const MAX_WORKERS = 4
const BROKEN = 'O OCR local não abriu neste navegador.'

interface Job {
  id: number
  image: string
  resolve(texts: OcrText[]): void
  reject(error: Error): void
}

/** null where there are no workers (tests, Node scripts). */
export function browserOcr(): ScreenOcr | null {
  if (typeof Worker === 'undefined') return null
  const size = Math.max(1, Math.min(MAX_WORKERS, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
  const queue: Job[] = []
  const running = new Map<Worker, Job>()
  const workers: Worker[] = []
  const free: Worker[] = []
  let made = 0
  let next = 0
  let broken: Error | null = null

  const fail = (error: Error) => {
    broken = error
    for (const worker of workers) worker.terminate()
    for (const job of [...queue.splice(0), ...running.values()]) job.reject(error)
    running.clear()
  }

  const pump = () => {
    while (free.length && queue.length) {
      const worker = free.pop()!
      const job = queue.shift()!
      running.set(worker, job)
      worker.postMessage({ id: job.id, image: job.image })
    }
  }

  const spawn = async () => {
    made++
    const { default: OcrWorker } = await import('./ocr.worker?worker')
    if (broken) return
    const worker = new OcrWorker()
    workers.push(worker)
    worker.onerror = event => fail(new Error(event.message || BROKEN))
    worker.onmessage = ({ data }) => {
      if (data.fatal) return fail(new Error(`${BROKEN} ${data.fatal}`))
      if (data.ready) {
        if (made === 1) for (let more = 1; more < size; more++) void spawn()
      } else {
        const job = running.get(worker)
        running.delete(worker)
        if (data.error) job?.reject(new Error(data.error))
        else job?.resolve(data.texts)
      }
      free.push(worker)
      pump()
    }
  }

  return {
    read: image =>
      new Promise<OcrText[]>((resolve, reject) => {
        if (broken) return reject(broken)
        queue.push({ id: next++, image, resolve, reject })
        if (!made) void spawn().catch(error => fail(error instanceof Error ? error : new Error(BROKEN)))
        pump()
      }),
    close: () => {
      for (const worker of workers) worker.terminate()
      for (const job of [...queue.splice(0), ...running.values()]) job.reject(new Error('O OCR local foi fechado.'))
      running.clear()
      broken = new Error('O OCR local foi fechado.')
    },
  }
}
