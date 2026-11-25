/**
 * How long the last waits of each kind took on this device, per account (spec 007, research R15): the only honest base of an
 * estimate before the first part of a wait that is not a server job. The last 20 of each kind; the median is the guess.
 */

const KEY = 'study-helper:waits'
const KEPT = 20
/** One wait alone is not a base. */
const MIN_SAMPLES = 2

type Store = Record<string, number[]>

const keyOf = (accountId: string) => `${KEY}:${accountId || 'sem-conta'}`

function read(accountId: string): Store {
  try {
    const raw = localStorage.getItem(keyOf(accountId))
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

export function recordWait(accountId: string, kind: string, ms: number): void {
  if (!(ms > 0)) return
  const store = read(accountId)
  store[kind] = [...(store[kind] ?? []), Math.round(ms)].slice(-KEPT)
  try {
    localStorage.setItem(keyOf(accountId), JSON.stringify(store))
  } catch {
    // a full storage only loses the guess, never the wait
  }
}

/** The median of the last waits of this kind, or null with too few to tell. */
export function historyOf(accountId: string, kind: string): number | null {
  const list = read(accountId)[kind] ?? []
  if (list.length < MIN_SAMPLES) return null
  const sorted = [...list].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}
