import { ApiError, apiCall } from '@/controllers/api.controller'

/**
 * The jobs of generating in the account (spec 007, história 2, research R10b; contracts/api-jobs.md): a call of the generations store
 * that the server runs with the app itself in a headless Chromium. The device creates and follows them; the job page reports progress,
 * the end and the value the call gave back.
 */

export type AccountJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'dismissed'

export interface AccountJob {
  id: string
  call: string
  kind: string
  fileId: string | null
  title: string
  state: AccountJobState
  queuePosition: number | null
  stage: string | null
  fraction: number | null
  etaAt: string | null
  etaBasis: 'parts' | 'history' | null
  lastProgress: string | null
  lastProgressAt: string | null
  stalledSince: string | null
  args: unknown[]
  result: unknown
  error: string | null
  errorCode: string | null
  attempt: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface NewAccountJob {
  call: string
  args: unknown[]
  fileId: string | null
  title: string
}

const path = (id: string, action = '') => `/v1/jobs/${encodeURIComponent(id)}${action}`

/** A new job; the same call of the same note already queued or running gives back that one. */
export async function createJob(job: NewAccountJob): Promise<AccountJob> {
  try {
    return await apiCall<AccountJob>('POST', '/v1/jobs', job)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'already_running' && error.data.job) return error.data.job as AccountJob
    throw error
  }
}

export const listJobs = async (): Promise<AccountJob[]> => (await apiCall<{ jobs: AccountJob[] }>('GET', '/v1/jobs')).jobs
export const getJob = (id: string) => apiCall<AccountJob>('GET', path(id))
export const cancelJob = (id: string) => apiCall<AccountJob>('POST', path(id, '/cancel'))
export const retryJob = (id: string) => apiCall<AccountJob>('POST', path(id, '/retry'))
export const dismissJob = (id: string) => apiCall<AccountJob>('POST', path(id, '/dismiss'))

// the job page (on the server)
export const reportProgress = (id: string, message: string, fraction: number | null) => apiCall<{ ok: true }>('POST', path(id, '/progress'), { message, fraction })
export const reportFinish = (id: string, result: unknown) => apiCall<{ ok: true }>('POST', path(id, '/finish'), { result: result === undefined ? null : result })
export const reportFailure = (id: string, error: string, code = 'internal') => apiCall<{ ok: true }>('POST', path(id, '/fail'), { error, code })
