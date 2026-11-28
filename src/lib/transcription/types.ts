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
  /** T199: the model that hears each part and writes its text (on the times of Whisper); none, the engine's own way. */
  listener?: TranscriptionCredential
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

/**
 * The person's terms as a hint to a transcription model, never to Whisper (T199, measured 28/11, research R28): with the list as "prompt",
 * the turbo skipped nearly everything (122.6% of words wrong) and the large-v3 went from 3.7% to 6.6%. The terms go to the model that
 * hears instead (`listenerInstruction`).
 */
export function withTerms(form: FormData, job: ProviderJob): FormData {
  if (/whisper/i.test(String(form.get('model') ?? job.credential.model ?? ''))) return form
  const hint = termsHint(job.terms ?? '')
  if (hint) form.append('prompt', hint)
  return form
}

/** What the model that hears is asked for each part (the instruction measured in R28), with the terms as context. */
export function listenerInstruction(language: string, terms = ''): string {
  const spoken = !language || language.startsWith('pt') ? 'em português do Brasil' : 'no idioma em que é falado'
  const list = terms
    .split(/[\n,;]/)
    .map(term => term.trim())
    .filter(Boolean)
  const known = list.length ? ` Se forem ditos, escreva estes termos assim: ${list.join(', ')}.` : ''
  return `Transcreva exatamente o que é dito neste áudio, ${spoken}, palavra por palavra, do começo ao fim, sem resumir, sem traduzir, sem nomes de quem fala e sem comentários. Responda só com o texto falado.${known}`
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

/**
 * T200 (research R28): a part still without an answer this long after it went is asked again, once: twice the median of the parts that
 * answered, 20 s at least (on the meeting of 27/11 one part of the turbo held the whole transcription 94 s; the median was 15 s). The
 * first answer wins and the other request stops.
 */
const LATE_FACTOR = 2
const LATE_MIN_MS = 20_000
const LATE_CHECK_MS = 1000

/**
 * Sends every part at once. The message names the first part still without an answer, and the bar counts the ones that came back. `send`
 * gets the signal of its request: the one asked again too late stops by it.
 */
export async function sendParts<T>(job: ProviderJob, label: string, send: (part: Blob, index: number, signal?: AbortSignal) => Promise<T>): Promise<T[]> {
  const total = job.parts.length
  const finished = new Set<number>()
  const took: number[] = []
  const said = () => {
    const first = job.parts.findIndex((_, index) => !finished.has(index))
    return first < 0 || total < 2 ? label : `${label} · parte ${first + 1} de ${total}`
  }
  const lateAfter = (): number | null => {
    if (!took.length) return null
    const sorted = [...took].sort((a, b) => a - b)
    return Math.max(LATE_FACTOR * sorted[Math.floor(sorted.length / 2)], LATE_MIN_MS)
  }
  const attempt = (part: Blob, index: number) => {
    const controller = new AbortController()
    const stop = () => controller.abort()
    if (job.signal?.aborted) controller.abort()
    else job.signal?.addEventListener('abort', stop, { once: true })
    const promise = send(part, index, controller.signal)
    promise.then(
      () => job.signal?.removeEventListener('abort', stop),
      () => job.signal?.removeEventListener('abort', stop),
    )
    return { promise, stop }
  }
  const raced = (part: Blob, index: number) =>
    new Promise<T>((resolve, reject) => {
      const started = Date.now()
      const attempts: ReturnType<typeof attempt>[] = []
      let settled = false
      let failed = 0
      let firstError: unknown
      let watch: ReturnType<typeof setInterval> | undefined
      const end = () => {
        settled = true
        clearInterval(watch)
      }
      const follow = (current: ReturnType<typeof attempt>) => {
        attempts.push(current)
        current.promise.then(
          value => {
            if (settled) return
            end()
            for (const other of attempts) if (other !== current) other.stop()
            took.push(Date.now() - started)
            resolve(value)
          },
          error => {
            if (settled) return
            if (!failed) firstError = error
            failed++
            if (failed < attempts.length) return
            end()
            reject(firstError)
          },
        )
      }
      follow(attempt(part, index))
      watch = setInterval(() => {
        const limit = lateAfter()
        if (settled || limit === null || Date.now() - started < limit) return
        clearInterval(watch)
        follow(attempt(part, index))
      }, LATE_CHECK_MS)
    })
  job.progress(said(), 0)
  return Promise.all(
    job.parts.map(async (part, index) => {
      const answer = await raced(part, index)
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
  /** T200: what the transcription cost (US$): what each service said, or its price per hour by the length heard. */
  cost?: number
  /** Why the speaker split did not come, when the provider tried and failed. */
  speakersError?: string
}
