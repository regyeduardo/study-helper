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
  partStarts?: number[]
  partSeconds: number
  language: string
  terms?: string
  credential: TranscriptionCredential
  progress: Progress
  signal?: AbortSignal
}

export function termsHint(terms: string): string {
  const list = terms
    .split(/[\n,;]/)
    .map(term => term.trim())
    .filter(Boolean)
  return list.length ? `Termos que aparecem nesta gravação: ${list.join(', ')}.` : ''
}

export function withTerms(form: FormData, job: ProviderJob): FormData {
  const hint = termsHint(job.terms ?? '')
  if (hint) form.append('prompt', hint)
  return form
}

export function partStart(job: ProviderJob, index: number): number {
  return job.partStarts?.[index] ?? index * job.partSeconds
}

export function partName(part: Blob): string {
  return part.type.includes('webm') ? 'trecho.webm' : 'trecho.wav'
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
  inSpeech?: boolean
}
