import { create } from 'zustand'

import { ApiError } from '@/controllers/api.controller'
import { type AccountJob, cancelJob, createJob, dismissJob, getJob, listJobs, retryJob } from '@/controllers/jobs.controller'
import type { Job } from '@/stores/jobs'

/**
 * The jobs of generating in the account (spec 007, história 2), as this device sees them: the list for Gerações, kept up to date by
 * the live channel (and by asking the server while someone waits, in case the channel is down), and the wait of a call that went to
 * the account.
 */

const ENDED = new Set(['done', 'failed', 'cancelled', 'dismissed'])
/** While someone waits for a job, the server is asked this often (the live channel usually tells first). */
export const WAIT_POLL_MS = 3000

interface AccountJobsState {
  jobs: AccountJob[]
  load(): Promise<void>
  apply(job: AccountJob): void
  /**
   * Resolves at the end of the job (done, failed or cancelled); `early`: also when the job gives its result while it goes on (the note a
   * call gives back at once and writes after, 25/11).
   */
  waitFor(id: string, early?: boolean): Promise<AccountJob>
  cancel(id: string): Promise<void>
  retry(id: string): Promise<void>
  dismiss(id: string): Promise<void>
}

const waiting = new Map<string, { resolve: (job: AccountJob) => void; early: boolean }[]>()

const givesEarly = (job: AccountJob) => job.state === 'running' && job.result !== null && job.result !== undefined

export const useAccountJobsStore = create<AccountJobsState>((set, get) => ({
  jobs: [],

  load: async () => {
    const jobs = await listJobs()
    set({ jobs })
    for (const job of jobs) if (ENDED.has(job.state) || givesEarly(job)) settle(job)
  },

  apply: job => {
    set(state => ({ jobs: state.jobs.some(item => item.id === job.id) ? state.jobs.map(item => (item.id === job.id ? job : item)) : [job, ...state.jobs] }))
    if (ENDED.has(job.state) || givesEarly(job)) settle(job)
  },

  waitFor: (id, early = false) => {
    const known = get().jobs.find(job => job.id === id)
    if (known && (ENDED.has(known.state) || (early && givesEarly(known)))) return Promise.resolve(known)
    return new Promise(resolve => {
      waiting.set(id, [...(waiting.get(id) ?? []), { resolve, early }])
      const poll = setInterval(() => {
        if (!waiting.has(id)) return clearInterval(poll)
        void getJob(id).then(job => get().apply(job), () => undefined)
      }, WAIT_POLL_MS)
    })
  },

  cancel: async id => get().apply(await cancelJob(id)),
  retry: async id => get().apply(await retryJob(id)),
  dismiss: async id => get().apply(await dismissJob(id)),
}))

/** The waits this state of the job ends: all at the end; at a result given while it goes on, only the ones that take it early. */
function settle(job: AccountJob) {
  const waits = waiting.get(job.id)
  if (!waits) return
  const ending = ENDED.has(job.state)
  const now = waits.filter(wait => ending || wait.early)
  const later = waits.filter(wait => !now.includes(wait))
  if (later.length) waiting.set(job.id, later)
  else waiting.delete(job.id)
  for (const wait of now) wait.resolve(job)
}

// a job that ends in the account changed notes there: this device reads the library again, so what it wrote shows (the note, the mark of
// an explained passage) even if the live channel missed the change (25/11: "Explicação: handshake" pronta em Gerações, não escrita na nota)
useAccountJobsStore.subscribe((state, before) => {
  const ended = state.jobs.some(job => job.state === 'done' && before.jobs.some(item => item.id === job.id && item.state !== 'done'))
  if (ended) void import('@/stores/sync').then(({ useSyncStore }) => useSyncStore.getState().syncNow()).catch(() => undefined)
})

/** The calls that transcribe a note: their job in the account shows on the note's page as a transcription made here does (24/11). */
export const TRANSCRIBING = new Set(['transcribeNote', 'redoTranscript'])

/** The account job of these calls on a note, as its page shows it: the one waiting or running, else the last one that failed. */
export function noteAccountJob(jobs: AccountJob[], fileId: string, calls: Set<string>): AccountJob | null {
  const mine = jobs.filter(job => job.fileId === fileId && calls.has(job.call))
  return mine.find(job => job.state === 'queued' || job.state === 'running') ?? mine.find(job => job.state === 'failed') ?? null
}

/** The calls that write the note they start from; the others make a new note and give it back as their result. */
const WRITES_ITSELF = new Set(['generatePending', 'regenerate', 'generateSecondTab'])

/**
 * The account's job writing this note, waiting or running (25/11: the note said "ainda não foi escrita" while the account wrote it): on
 * the note itself ("Gerar agora", "Gerar de novo"), or the note a call gave back at once and writes after ("Explicar", "Gerar desta nota").
 */
export function writingJob(jobs: AccountJob[], fileId: string): AccountJob | null {
  return jobs.find(job => (job.state === 'queued' || job.state === 'running') && ((WRITES_ITSELF.has(job.call) && job.fileId === fileId) || job.result === fileId)) ?? null
}

/** An account job in the shape of a job made here, for the same progress and failure on the note's page. */
export function asNoteJob(job: AccountJob, kind: Job['kind']): Job {
  const queued = job.state === 'queued'
  return {
    id: job.id,
    kind,
    title: job.title,
    fileId: job.fileId,
    status: job.state === 'failed' ? 'error' : 'running',
    message: queued ? (job.queuePosition ? `Na fila da conta (${job.queuePosition}º)` : 'Na fila da conta') : (job.stage ?? 'Começando na conta'),
    fraction: queued ? null : job.fraction,
    error: job.state === 'failed' ? (job.error ?? 'Não terminou na conta.') : null,
    startedAt: Date.parse(job.startedAt ?? job.createdAt),
  }
}

/** `undefined` survives the trip to the server and back (JSON has no `undefined`): an optional argument stays absent. */
export function packArgs(args: unknown[]): unknown[] {
  return args.map(arg => (arg === undefined ? { $indefinido: true } : arg))
}

export function unpackArgs(args: unknown[]): unknown[] {
  return args.map(arg => (arg && typeof arg === 'object' && (arg as { $indefinido?: boolean }).$indefinido === true ? undefined : arg))
}

/**
 * The account cannot take the job: a service without the jobs (404: the app published before the service), no internet, or the
 * structure off there. Then the call runs here, as before ("Mando transcrever e não acontece nada", 24/11).
 */
function cannotTake(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === 'offline' || error.code === 'structure_off')
}

/**
 * A call of the generations store run by the account; gives back what the call gives back, or throws the reason it failed. `here` runs
 * the call on this device when the account cannot take it; any other refusal shows as a failed job with its reason, never silent.
 */
export async function runOnAccount(call: string, args: unknown[], fileId: string | null, title: string, here?: () => Promise<unknown>): Promise<unknown> {
  let job: AccountJob
  try {
    job = await createJob({ call, args: packArgs(args), fileId, title })
  } catch (error) {
    if (here && cannotTake(error)) return here()
    const { useJobsStore } = await import('@/stores/jobs')
    useJobsStore.getState().trackTask(title, fileId).fail(`Não deu para pedir à conta: ${error instanceof Error ? error.message : String(error)}.`)
    throw error
  }
  useAccountJobsStore.getState().apply(job)
  // the note a call gives back at once comes while the account still writes it: whoever asked gets it then, as when it runs here
  const end = await useAccountJobsStore.getState().waitFor(job.id, true)
  if (end.state === 'done' || givesEarly(end)) return end.result
  if (end.state === 'cancelled') throw new Error('A geração foi cancelada.')
  throw new Error(end.error ?? 'A geração falhou na conta.')
}
