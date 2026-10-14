import type { StageTime, TranscriptionCredential } from '@/types/domain'

export class StageClock {
  readonly stages: StageTime[] = []

  async run<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      return await work()
    } finally {
      this.stages.push({ stage, ms: Date.now() - started })
    }
  }

  add(stages: StageTime[] = []): void {
    this.stages.push(...stages)
  }
}

export interface Segment {
  start: number
  end: number
  text: string
}

export interface Word {
  start: number
  end: number
  text: string
}

export interface SpeakerTurn {
  start: number
  end: number
  speaker: string
}

export type Progress = (message: string, fraction?: number) => void

export interface ProviderJob {
  audio: Blob
  parts: Blob[]
  partSeconds: number
  language: string
  credential: TranscriptionCredential
  progress: Progress
  signal?: AbortSignal
}

export async function sendParts<T>(job: ProviderJob, label: string, send: (part: Blob, index: number) => Promise<T>): Promise<T[]> {
  let done = 0
  job.progress(label, 0)
  return Promise.all(
    job.parts.map(async (part, index) => {
      const answer = await send(part, index)
      job.progress(label, ++done / job.parts.length)
      return answer
    }),
  )
}

export interface ProviderResult {
  words: Word[]
  turns: SpeakerTurn[]
}
