// Gerações (003, FR-065): what the AI is making for the account, what failed and what came out, followed from Tarefas (the jobs store).
// A failure stays on this device, per account, until "Tentar de novo" or "Dispensar", even after a reload; what was running when the tab closed comes back failed.
import { create } from 'zustand'

import { useAccountStore } from '@/stores/account'
import { type AccountJob } from '@/controllers/jobs.controller'
import { advance, startWait, type Wait } from '@/lib/wait'
import { useAccountJobsStore } from '@/stores/account-jobs'
import { type Job, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'
import type { FileMeta } from '@/types/domain'

export type GenerationState = 'running' | 'failed' | 'ready'

export interface Generation {
  /** The id of the job it follows. */
  id: string
  kind: Job['kind']
  title: string
  fileId: string | null
  state: GenerationState
  message: string
  fraction: number | null
  error: string | null
  startedAt: number
  /** When it failed or came out; null while it runs. */
  endedAt: number | null
  /** The window that asked for it, as it was filled in. */
  retry?: Overlay
  /** What "Abrir" opens besides the note: the map or the deck made. */
  open?: Overlay
  /** What the line shows while it runs (spec 007, FR-060): what happens, how much, when it ends, that it did not freeze. */
  wait?: Wait
  /** A job of the account (spec 007, história 2): its id on the server; the line comes from the server, not from this device. */
  accountJob?: string
}

interface GenerationsState {
  accountId: string
  items: Generation[]
  cancel(id: string): void
  /** Opens what was asked again and takes the failure off the list. */
  retry(id: string): void
  dismiss(id: string): void
}

const KEY = 'study-helper:generations'
export const TAB_CLOSED = 'A aba fechou antes de terminar.'
/** A job that only read the material for the next one: not a note that came out. */
const STEP_DONE = 'Material lido.'
const READY_KEPT = 50
const READY_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

const keyOf = (accountId: string) => `${KEY}:${accountId}`

/** What "Tentar de novo" opens: the window that asked, as it was filled in; a note kept to write again, its own choice of model. */
export function retryOf(item: Generation, files: FileMeta[]): Overlay | undefined {
  if (item.state !== 'failed') return undefined
  if (item.retry) return item.retry
  return item.kind === 'generation' && item.fileId && files.find(file => file.id === item.fileId && !file.deletedAt)?.status === 'pending' ? { kind: 'pending', fileId: item.fileId } : undefined
}

/** Only plain data goes to the device: a window holding a file (or a function) is kept for this tab only. */
function plain(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(plain)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value as object).every(item => item === undefined || plain(item))
  return false
}

/** The ready ones of the last days, the newest first, up to the limit; running and failed always stay. */
function pruned(items: Generation[], now = Date.now()): Generation[] {
  const ready = items
    .filter(item => item.state === 'ready' && now - (item.endedAt ?? item.startedAt) <= READY_DAYS * DAY_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, READY_KEPT)
  const kept = new Set(ready.map(item => item.id))
  return items.filter(item => item.state !== 'ready' || kept.has(item.id))
}

/** The wait of a job of this device, moved at each change of its message or fraction. */
function waitOf(job: Job, before: Wait | undefined): Wait {
  const percent = job.fraction === null ? undefined : Math.round(job.fraction * 100)
  const start = before ?? startWait(job.message || job.title, { unit: '%', total: percent === undefined ? undefined : 100, normalStepMs: NORMAL_STEP_MS, now: job.startedAt })
  return advance(start, { done: percent, ...(percent !== undefined ? { total: 100 } : {}), label: job.message, ...(job.message && job.message !== start.what ? { what: job.message, done: percent } : {}) })
}

const NORMAL_STEP_MS = 3 * 60_000
const ACCOUNT = 'conta:'

/** A job of the account as a line of Gerações (spec 007, história 2). */
function fromAccountJob(job: AccountJob): Generation | null {
  if (job.state === 'cancelled' || job.state === 'dismissed') return null
  const state: GenerationState = job.state === 'queued' || job.state === 'running' ? 'running' : job.state === 'failed' ? 'failed' : 'ready'
  const at = (value: string | null) => (value ? Date.parse(value) : undefined)
  const startedAt = at(job.startedAt) ?? at(job.createdAt) ?? Date.now()
  const percent = job.fraction === null ? undefined : Math.round(job.fraction * 100)
  const queued = job.state === 'queued'
  const wait: Wait = {
    what: queued ? `Na fila da conta: ${job.queuePosition ?? 1}º` : (job.stage ?? job.title),
    unit: queued ? undefined : '%',
    ...(queued || percent === undefined ? {} : { total: 100, done: percent }),
    startedAt,
    lastProgressAt: at(job.lastProgressAt) ?? startedAt,
    lastProgress: job.lastProgress ?? undefined,
    normalStepMs: queued ? undefined : NORMAL_STEP_MS,
    paces: [],
    ...(job.etaAt ? { etaAt: Date.parse(job.etaAt), etaBasis: job.etaBasis ?? 'parts' } : {}),
    ...(job.stalledSince ? { stalledSince: Date.parse(job.stalledSince) } : {}),
  }
  return {
    id: `${ACCOUNT}${job.id}`,
    accountJob: job.id,
    kind: 'generation',
    title: job.title,
    // what came out opens: the new note the call gave back, or the note it started from
    fileId: typeof job.result === 'string' ? job.result : job.fileId,
    state,
    message: queued ? wait.what : (job.stage ?? ''),
    fraction: job.fraction,
    error: job.error,
    startedAt,
    endedAt: at(job.finishedAt) ?? null,
    wait,
  }
}

function fromJob(job: Job, before: Generation | undefined): Generation | null {
  // a map or a deck keeps its note apart from `fileId`
  const fileId = job.fileId ?? job.noteId ?? null
  if (job.status === 'cancelled') return null
  if (job.status === 'done' && (!fileId || job.message === STEP_DONE)) return null
  const state: GenerationState = job.status === 'running' ? 'running' : job.status === 'error' ? 'failed' : 'ready'
  const retry = job.retry ?? before?.retry
  const open = job.open ?? before?.open
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    fileId,
    state,
    message: job.message,
    fraction: job.fraction,
    error: job.error,
    startedAt: job.startedAt,
    endedAt: state === 'running' ? null : before && before.state === state ? before.endedAt : Date.now(),
    ...(state === 'running' ? { wait: waitOf(job, before?.wait) } : {}),
    ...(retry ? { retry } : {}),
    ...(open ? { open } : {}),
  }
}

function isGeneration(value: unknown): value is Generation {
  const item = value as Generation
  return Boolean(item) && typeof item.id === 'string' && typeof item.title === 'string' && (item.state === 'running' || item.state === 'failed' || item.state === 'ready')
}

/** What was kept for the account; a line still "running" whose job is not in this tab stopped when the tab closed. */
function load(accountId: string): Generation[] {
  let stored: unknown = []
  try {
    stored = JSON.parse(localStorage.getItem(keyOf(accountId)) ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(stored)) return []
  const live = new Set(useJobsStore.getState().jobs.map(job => job.id))
  return pruned(
    stored.filter(isGeneration).map(item =>
      item.state === 'running' && !live.has(item.id) ? { ...item, state: 'failed', message: 'Não terminou.', error: TAB_CLOSED, fraction: null, endedAt: Date.now() } : { ...item, fraction: item.state === 'running' ? item.fraction : null },
    ),
  )
}

/** What goes to the device: a running line without its passing progress (no write at every percent), and the window only when it is plain data. */
function stored(items: Generation[]): string {
  return JSON.stringify(
    items.filter(item => !item.accountJob).map(({ retry, wait: _wait, ...item }) => ({
      ...item,
      ...(item.state === 'running' ? { message: '', fraction: null } : {}),
      ...(retry && plain(retry) ? { retry } : {}),
    })),
  )
}

let written = ''

function save(accountId: string, items: Generation[]) {
  const text = stored(items)
  if (text === written) return
  written = text
  try {
    localStorage.setItem(keyOf(accountId), text)
  } catch {
    // no room or no storage: the list still works in this tab
  }
}

export const useGenerationsStore = create<GenerationsState>((set, get) => ({
  accountId: useAccountStore.getState().activeId,
  items: load(useAccountStore.getState().activeId),

  cancel: id => {
    const account = get().items.find(entry => entry.id === id)?.accountJob
    if (account) return void useAccountJobsStore.getState().cancel(account).catch(() => undefined)
    useJobsStore.getState().cancel(id)
  },

  retry: id => {
    const item = get().items.find(entry => entry.id === id)
    // a job of the account runs again there, with what was asked
    if (item?.accountJob) return void useAccountJobsStore.getState().retry(item.accountJob).catch(() => undefined)
    const overlay = item && retryOf(item, useLibraryStore.getState().files)
    if (!overlay) return
    get().dismiss(id)
    useUiStore.getState().open(overlay)
  },

  dismiss: id => {
    const account = get().items.find(entry => entry.id === id)?.accountJob
    if (account) void useAccountJobsStore.getState().dismiss(account).catch(() => undefined)
    set(state => ({ items: state.items.filter(item => item.id !== id) }))
    if (useJobsStore.getState().jobs.some(job => job.id === id)) useJobsStore.getState().dismiss(id)
  },
}))

/** Tarefas changed: each job becomes (or stops being) a line. A job that left Tarefas takes its line along, unless it came out:
 *  a "Preparando" line gives way to the real job, and a failure dismissed elsewhere (the note's own "Tentar de novo") is handled. */
function follow(jobs: Job[], previous: Job[]) {
  useGenerationsStore.setState(state => {
    const lines = new Map(state.items.map(item => [item.id, item]))
    for (const job of jobs) {
      const line = fromJob(job, lines.get(job.id))
      if (line) lines.set(job.id, line)
      else lines.delete(job.id)
    }
    const now = new Set(jobs.map(job => job.id))
    for (const job of previous) if (!now.has(job.id) && lines.get(job.id)?.state !== 'ready') lines.delete(job.id)
    return { items: pruned([...lines.values()]) }
  })
}

follow(useJobsStore.getState().jobs, [])
save(useGenerationsStore.getState().accountId, useGenerationsStore.getState().items)

useJobsStore.subscribe((state, previous) => {
  if (state.jobs !== previous.jobs) follow(state.jobs, previous.jobs)
})

/** The jobs of the account (spec 007, história 2): their lines come and go with the server's list, on every device. */
function followAccount(jobs: AccountJob[]) {
  useGenerationsStore.setState(state => {
    const mine = state.items.filter(item => !item.accountJob)
    const account = jobs.map(fromAccountJob).filter((line): line is Generation => line !== null)
    return { items: pruned([...account, ...mine]) }
  })
}

useAccountJobsStore.subscribe((state, previous) => {
  if (state.jobs !== previous.jobs) followAccount(state.jobs)
})

// with the structure on, the list of the account comes when the library opens (and the live channel keeps it)
useLibraryStore.subscribe((state, previous) => {
  if (state.appOn && state.ready && !(previous.appOn && previous.ready)) void useAccountJobsStore.getState().load().catch(() => undefined)
})

useGenerationsStore.subscribe((state, previous) => {
  if (state.items !== previous.items && state.accountId === previous.accountId) save(state.accountId, state.items)
})

// another account: its own list
useAccountStore.subscribe((state, previous) => {
  if (state.activeId === previous.activeId) return
  written = ''
  useGenerationsStore.setState({ accountId: state.activeId, items: load(state.activeId) })
})

/** How many are generating and how many failed: the number and the red dot of the side bar (and of the menu button on a phone). */
export function useGenerationCounts(): { running: number; failed: number } {
  const running = useGenerationsStore(state => state.items.filter(item => item.state === 'running').length)
  const failed = useGenerationsStore(state => state.items.filter(item => item.state === 'failed').length)
  return { running, failed }
}
