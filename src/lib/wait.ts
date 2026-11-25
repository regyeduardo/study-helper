import { formatBytes } from '@/utils/format'

/**
 * One model for every wait the person sees (constitution IV; spec 007, FR-060 to FR-063, research R15): what is happening, how much
 * is done (counted parts or real bytes, never an invented percentage), when it should end (a clock time, redone at each part) and that
 * it did not freeze (the last thing that moved, and when). A server job brings its own estimate and "stalled" (the device clock may be
 * wrong); a wait of this device computes them here.
 */

export interface WaitOutcome {
  ok: boolean
  /** The result ("Ata pronta") or, on a failure, the reason in plain words. */
  text: string
  /** On a failure, what the person can do. */
  next?: string
}

export interface Wait {
  /** What is happening now, in the person's words ("Escrevendo a Ata"). */
  what: string
  /** What a part is called, in the plural ("pedaços", "quadros", "páginas lidas"). */
  unit?: string
  done?: number
  total?: number
  doneBytes?: number
  totalBytes?: number
  startedAt: number
  /** When something last moved. */
  lastProgressAt: number
  /** The last thing that moved ("pedaço 5 de 6 pronto"). */
  lastProgress?: string
  /** How long this step normally goes without moving; past twice that, the wait is stalled. */
  normalStepMs?: number
  /** How long the last similar waits took, before the first part: the only base of an estimate then. */
  history?: { ms: number; label: string }
  /** Per-part durations seen so far (ms per part, or per byte), oldest first: the base of the estimate. */
  paces: number[]
  /** A server job's own estimate and stall, when it sends them. */
  etaAt?: number
  etaBasis?: 'parts' | 'history'
  stalledSince?: number
  outcome?: WaitOutcome
}

export interface StartOptions {
  unit?: string
  total?: number
  totalBytes?: number
  normalStepMs?: number
  history?: { ms: number; label: string }
  now?: number
}

export interface Progress {
  done?: number
  total?: number
  doneBytes?: number
  totalBytes?: number
  /** The last thing that moved. */
  label?: string
  /** A new step: what is happening now changes, and the pace starts over. */
  what?: string
  normalStepMs?: number
}

/** Weight of the newest part in the running average: recent parts count more. */
const RECENT = 0.5

export function startWait(what: string, options: StartOptions = {}): Wait {
  const now = options.now ?? Date.now()
  return {
    what,
    unit: options.unit,
    total: options.total,
    totalBytes: options.totalBytes,
    normalStepMs: options.normalStepMs,
    history: options.history,
    startedAt: now,
    lastProgressAt: now,
    paces: [],
  }
}

/** A part moved (or the step changed). */
export function advance(wait: Wait, progress: Progress, now = Date.now()): Wait {
  const next: Wait = { ...wait }
  if (progress.total !== undefined) next.total = progress.total
  if (progress.totalBytes !== undefined) next.totalBytes = progress.totalBytes
  if (progress.normalStepMs !== undefined) next.normalStepMs = progress.normalStepMs
  if (progress.what !== undefined && progress.what !== wait.what) {
    next.what = progress.what
    next.paces = []
    next.done = progress.done ?? 0
    next.doneBytes = progress.doneBytes
    next.lastProgressAt = now
    next.lastProgress = progress.label
    return next
  }
  const elapsed = now - wait.lastProgressAt
  const moved = (progress.done ?? wait.done ?? 0) - (wait.done ?? 0)
  const movedBytes = (progress.doneBytes ?? wait.doneBytes ?? 0) - (wait.doneBytes ?? 0)
  if (progress.done !== undefined) next.done = progress.done
  if (progress.doneBytes !== undefined) next.doneBytes = progress.doneBytes
  if (moved > 0 || movedBytes > 0 || (progress.label !== undefined && progress.label !== wait.lastProgress)) {
    if (moved > 0) next.paces = [...wait.paces, elapsed / moved]
    else if (movedBytes > 0) next.paces = [...wait.paces, elapsed / movedBytes]
    next.lastProgressAt = now
    if (progress.label !== undefined) next.lastProgress = progress.label
  }
  return next
}

function pace(paces: number[]): number | null {
  if (!paces.length) return null
  return paces.slice(1).reduce((average, current) => RECENT * current + (1 - RECENT) * average, paces[0])
}

/** When it should end, and from what; null while there is no honest base (no total, or no part and no history). */
export function estimate(wait: Wait, now = Date.now()): { etaAt: number; basis: 'parts' | 'history' } | null {
  if (wait.etaAt !== undefined) return wait.etaAt >= now ? { etaAt: wait.etaAt, basis: wait.etaBasis ?? 'parts' } : null
  const byBytes = (wait.totalBytes ?? 0) > 0
  const rest = byBytes ? (wait.totalBytes ?? 0) - (wait.doneBytes ?? 0) : wait.total !== undefined ? wait.total - (wait.done ?? 0) : null
  if (rest === null || rest < 0) return null
  const perPart = pace(wait.paces)
  if (perPart !== null) return { etaAt: Math.max(now, wait.lastProgressAt + rest * perPart), basis: 'parts' }
  if (wait.history) {
    const etaAt = wait.startedAt + wait.history.ms
    return etaAt >= now ? { etaAt, basis: 'history' } : null
  }
  return null
}

export function isStalled(wait: Wait, now = Date.now()): boolean {
  if (wait.outcome) return false
  if (wait.stalledSince !== undefined) return wait.stalledSince <= now
  return wait.normalStepMs !== undefined && now - wait.lastProgressAt > 2 * wait.normalStepMs
}

/** "01:45", in the person's own clock. */
export function clockOf(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** "5 de 6 pedaços", "120 MB de 480 MB", or "3 páginas lidas · o total ainda não se sabe". */
export function progressText(wait: Wait): string {
  if ((wait.totalBytes ?? 0) > 0) return `${formatBytes(wait.doneBytes ?? 0)} de ${formatBytes(wait.totalBytes)}`
  // a percentage counted from the parts (the generations report a fraction of their parts)
  if (wait.unit === '%') return wait.done === undefined ? '' : `${wait.done}%`
  const unit = wait.unit ? ` ${wait.unit}` : ''
  if (wait.total !== undefined) return `${wait.done ?? 0} de ${wait.total}${unit}`
  if (wait.doneBytes !== undefined) return `${formatBytes(wait.doneBytes)} · o total ainda não se sabe`
  if (wait.done !== undefined) return `${wait.done}${unit} · o total ainda não se sabe`
  return ''
}

/** "há 12 s", "há 3 min". */
export function agoShort(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `há ${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `há ${minutes} min`
  return `há ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/** "1 min", "30 s": how long a step normally takes. */
export function durationShort(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** The owner's sentence: "Ainda está gerando, sem travar: 5 dos 6 pedaços já saíram, e deve terminar por volta de 01:45". */
export function sentence(wait: Wait, now = Date.now()): string {
  if (wait.outcome) return wait.outcome.ok ? wait.outcome.text : `${wait.outcome.text}${wait.outcome.next ? ` ${wait.outcome.next}` : ''}`
  if (isStalled(wait, now)) return `Nada andou desde ${clockOf(wait.stalledSince !== undefined && wait.lastProgressAt > wait.stalledSince ? wait.stalledSince : wait.lastProgressAt)}.`
  const guess = estimate(wait, now)
  const end = guess ? `, e deve terminar por volta de ${clockOf(guess.etaAt)}` : ''
  if (wait.unit === '%' && wait.done !== undefined) return `Ainda está ${lowerFirst(wait.what)}, sem travar: ${wait.done}% já foi${end}`
  if (wait.total !== undefined && !(wait.totalBytes ?? 0)) {
    return `Ainda está ${lowerFirst(wait.what)}, sem travar: ${wait.done ?? 0} dos ${wait.total}${wait.unit ? ` ${wait.unit}` : ''} já saíram${end}`
  }
  const counted = progressText(wait)
  return `Ainda está ${lowerFirst(wait.what)}, sem travar${counted ? `: ${counted}` : ''}${end}`
}
