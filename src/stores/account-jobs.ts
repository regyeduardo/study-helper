import { create } from 'zustand'

import { type AccountJob, cancelJob, createJob, dismissJob, getJob, listJobs, retryJob } from '@/controllers/jobs.controller'

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
  /** Resolves at the end of the job (done, failed or cancelled). */
  waitFor(id: string): Promise<AccountJob>
  cancel(id: string): Promise<void>
  retry(id: string): Promise<void>
  dismiss(id: string): Promise<void>
}

const waiting = new Map<string, ((job: AccountJob) => void)[]>()

export const useAccountJobsStore = create<AccountJobsState>((set, get) => ({
  jobs: [],

  load: async () => {
    const jobs = await listJobs()
    set({ jobs })
    for (const job of jobs) if (ENDED.has(job.state)) settle(job)
  },

  apply: job => {
    set(state => ({ jobs: state.jobs.some(item => item.id === job.id) ? state.jobs.map(item => (item.id === job.id ? job : item)) : [job, ...state.jobs] }))
    if (ENDED.has(job.state)) settle(job)
  },

  waitFor: id => {
    const known = get().jobs.find(job => job.id === id)
    if (known && ENDED.has(known.state)) return Promise.resolve(known)
    return new Promise(resolve => {
      waiting.set(id, [...(waiting.get(id) ?? []), resolve])
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

function settle(job: AccountJob) {
  const resolvers = waiting.get(job.id)
  if (!resolvers) return
  waiting.delete(job.id)
  for (const resolve of resolvers) resolve(job)
}

/** `undefined` survives the trip to the server and back (JSON has no `undefined`): an optional argument stays absent. */
export function packArgs(args: unknown[]): unknown[] {
  return args.map(arg => (arg === undefined ? { $indefinido: true } : arg))
}

export function unpackArgs(args: unknown[]): unknown[] {
  return args.map(arg => (arg && typeof arg === 'object' && (arg as { $indefinido?: boolean }).$indefinido === true ? undefined : arg))
}

/** A call of the generations store run by the account; gives back what the call gives back, or throws the reason it failed. */
export async function runOnAccount(call: string, args: unknown[], fileId: string | null, title: string): Promise<unknown> {
  const job = await createJob({ call, args: packArgs(args), fileId, title })
  useAccountJobsStore.getState().apply(job)
  const end = await useAccountJobsStore.getState().waitFor(job.id)
  if (end.state === 'done') return end.result
  if (end.state === 'cancelled') throw new Error('A geração foi cancelada.')
  throw new Error(end.error ?? 'A geração falhou na conta.')
}
