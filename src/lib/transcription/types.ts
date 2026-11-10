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

/** How much audio the whole job carries, counting the last part as full (the parts are the only length the job knows). */
export function wholeSeconds(job: ProviderJob): number {
  return job.parts.length ? partStart(job, job.parts.length - 1) + job.partSeconds : job.partSeconds
}

const STILL_WAITING_SECONDS = 60

/** Wraps `progress` so that a step with no news for 60 s says it is still waiting for `waitingFor`. Call `stop` when the work ends. */
export function watchProgress(progress: Progress, waitingFor: string): { progress: Progress; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => clearTimeout(timer)
  const say = (message: string, fraction?: number) => (fraction === undefined ? progress(message) : progress(message, fraction))
  return {
    progress: (message, fraction) => {
      stop()
      say(message, fraction)
      timer = setTimeout(() => say(`${message} · ainda esperando ${waitingFor}…`, fraction), STILL_WAITING_SECONDS * 1000)
    },
    stop,
  }
}

/** Sends every part at once. The message names the first part still without an answer, and the bar counts the ones that came back. */
export async function sendParts<T>(job: ProviderJob, label: string, send: (part: Blob, index: number) => Promise<T>): Promise<T[]> {
  const total = job.parts.length
  const finished = new Set<number>()
  const said = () => {
    const first = job.parts.findIndex((_, index) => !finished.has(index))
    return first < 0 || total < 2 ? label : `${label} · parte ${first + 1} de ${total}`
  }
  job.progress(said(), 0)
  return Promise.all(
    job.parts.map(async (part, index) => {
      const answer = await send(part, index)
      finished.add(index)
      job.progress(said(), finished.size / total)
      return answer
    }),
  )
}

export interface ProviderResult {
  words: Word[]
  turns: SpeakerTurn[]
  inSpeech?: boolean
  /** Why the speaker split did not come, when the provider tried and failed. */
  speakersError?: string
}
