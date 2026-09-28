import { type LocalJob, runLocalJob } from '@/lib/transcription/local-work'

interface Request {
  id: number
  job: LocalJob
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, job } = event.data
  try {
    const result = await runLocalJob(job, (message, fraction) => self.postMessage({ id, kind: 'progress', message, fraction }))
    self.postMessage({ id, kind: 'done', result })
  } catch (error) {
    self.postMessage({ id, kind: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
