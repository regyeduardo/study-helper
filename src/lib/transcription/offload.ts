import type { LocalJob, LocalResult } from '@/lib/transcription/local-work'
import type { Progress } from '@/lib/transcription/types'

type Reply = { id: number; kind: 'progress'; message: string; fraction?: number } | { id: number; kind: 'done'; result: LocalResult } | { id: number; kind: 'error'; message: string }

interface Pending {
  progress: Progress
  resolve(result: LocalResult): void
  reject(error: Error): void
}

let worker: Worker | null = null
let sequence = 0
const pending = new Map<number, Pending>()

function transcriptionWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./transcription.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data
    const waiting = pending.get(reply.id)
    if (!waiting) return
    if (reply.kind === 'progress') return waiting.progress(reply.message, reply.fraction)
    pending.delete(reply.id)
    if (reply.kind === 'done') waiting.resolve(reply.result)
    else waiting.reject(new Error(reply.message))
  }
  worker.onerror = event => {
    event.preventDefault()
    for (const waiting of pending.values()) waiting.reject(new Error(event.message || 'o segundo plano do navegador parou'))
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

async function onThisPage(job: LocalJob, progress: Progress): Promise<LocalResult> {
  const { runLocalJob } = await import('@/lib/transcription/local-work')
  return runLocalJob(job, progress)
}

function inWorker(job: LocalJob, progress: Progress): Promise<LocalResult> {
  const id = ++sequence
  return new Promise<LocalResult>((resolve, reject) => {
    pending.set(id, { progress, resolve, reject })
    try {
      transcriptionWorker().postMessage({ id, job })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function runOffThread(job: LocalJob, progress: Progress): Promise<LocalResult> {
  if (typeof Worker === 'undefined') return onThisPage(job, progress)
  try {
    return await inWorker(job, progress)
  } catch (error) {
    console.warn('Transcrição em segundo plano falhou; seguindo nesta aba:', error)
    progress('Transcrevendo nesta aba (o segundo plano do navegador falhou; o app pode ficar lento até terminar)')
    return onThisPage(job, progress)
  }
}
