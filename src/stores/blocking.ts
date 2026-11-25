import { create } from 'zustand'

import { newId } from '@/lib/ids'

/** Where an operation is: what it does now, how many of how many, and the item it is on. */
export interface BlockingProgress {
  /** The step it is on, when an operation has more than one ("Gravando a escolha", "Copiando as notas"). */
  phase?: string
  done?: number
  total?: number
  doneBytes?: number
  totalBytes?: number
  /** The item it is on now (a note's name). */
  current?: string
}

/**
 * One operation the person waits for (owner's choice F, 2026-11-21): a window in the middle of the screen, with the bar, how many and
 * how long is left, and Cancelar when it can stop. While one is open the app does not take clicks nor keys.
 */
export interface BlockingOp extends BlockingProgress {
  id: string
  title: string
  startedAt: number
  /** The estimate counts from here: the start of the step in view (a new step, or a new total, starts it again). */
  countedAt: number
  countedFrom: number
  countedBytesFrom: number
  cancellable: boolean
  cancelling: boolean
  /** The operation ended in a failure: the window says why and waits for "Fechar". */
  failure?: string
  /** When something last moved (a count, the bytes, the step, the item in hand): "sem travar: última parte há N s" (spec 007, FR-060). */
  movedAt?: number
}

interface BlockingState {
  ops: BlockingOp[]
  open(title: string, options?: { cancellable?: boolean; onCancel?: () => void } & BlockingProgress): string
  progress(id: string, update: BlockingProgress): void
  close(id: string): void
  /** "Cancelar": the operation stops after the item it is on. */
  cancel(id: string): void
  /** Shows the reason of a failure in the window, until the person closes it. */
  fail(title: string, reason: string): void
}

const cancels = new Map<string, () => void>()

export const useBlockingStore = create<BlockingState>((set, get) => ({
  ops: [],

  open: (title, { cancellable = false, onCancel, ...progress } = {}) => {
    const id = newId()
    const now = Date.now()
    if (onCancel) cancels.set(id, onCancel)
    set(state => ({ ops: [...state.ops, { id, title, startedAt: now, countedAt: now, countedFrom: progress.done ?? 0, countedBytesFrom: progress.doneBytes ?? 0, cancellable, cancelling: false, movedAt: now, ...progress }] }))
    return id
  },

  progress: (id, update) =>
    set(state => ({
      ops: state.ops.map(op => {
        if (op.id !== id) return op
        const moved = (['done', 'doneBytes', 'phase', 'current', 'total'] as const).some(key => update[key] !== undefined && update[key] !== op[key])
        const next = { ...op, ...update, ...(moved ? { movedAt: Date.now() } : {}) }
        // a new step or a new total: the estimate starts over from here
        const restart = (update.phase !== undefined && update.phase !== op.phase) || (update.total !== undefined && update.total !== op.total)
        return restart ? { ...next, countedAt: Date.now(), countedFrom: next.done ?? 0, countedBytesFrom: next.doneBytes ?? 0 } : next
      }),
    })),

  close: id => {
    cancels.delete(id)
    set(state => ({ ops: state.ops.filter(op => op.id !== id) }))
  },

  cancel: id => {
    const op = get().ops.find(item => item.id === id)
    if (!op?.cancellable || op.cancelling) return
    set(state => ({ ops: state.ops.map(item => (item.id === id ? { ...item, cancelling: true } : item)) }))
    cancels.get(id)?.()
  },

  fail: (title, reason) => {
    const now = Date.now()
    set(state => ({ ops: [...state.ops, { id: newId(), title, startedAt: now, countedAt: now, countedFrom: 0, countedBytesFrom: 0, cancellable: false, cancelling: false, failure: reason }] }))
  },
}))

/** When the step in view should end (spec 007, FR-060: a clock time, redone at each part), by the same pace as `timeLeft`; null while there is too little to tell. */
export function endsAt(op: BlockingOp, now = Date.now()): number | null {
  const elapsed = now - op.countedAt
  if (elapsed < 3000) return null
  const byBytes = (op.totalBytes ?? 0) > 0 && (op.doneBytes ?? 0) > op.countedBytesFrom
  const done = byBytes ? (op.doneBytes ?? 0) - op.countedBytesFrom : (op.done ?? 0) - op.countedFrom
  const rest = byBytes ? (op.totalBytes ?? 0) - (op.doneBytes ?? 0) : (op.total ?? 0) - (op.done ?? 0)
  if ((!byBytes && !op.total) || rest <= 0 || done < (byBytes ? 1 : 2)) return null
  return now + (rest * elapsed) / done
}

/** How long a step of an operation of the window normally goes without moving (the Inventory of waits: 15 to 30 s); past twice this, it says so. */
export const BLOCKING_NORMAL_MS = 30_000

/** "faltam ~6 min": from the pace of the step in view; nothing while there is too little to tell (under 2 items or 3 seconds). */
export function timeLeft(op: BlockingOp, now = Date.now()): string | null {
  const elapsed = now - op.countedAt
  if (elapsed < 3000) return null
  const byBytes = (op.totalBytes ?? 0) > 0 && (op.doneBytes ?? 0) > op.countedBytesFrom
  const done = byBytes ? (op.doneBytes ?? 0) - op.countedBytesFrom : (op.done ?? 0) - op.countedFrom
  const rest = byBytes ? (op.totalBytes ?? 0) - (op.doneBytes ?? 0) : (op.total ?? 0) - (op.done ?? 0)
  // by bytes it needs no count of items (a media going whole is one step of its own)
  if ((!byBytes && !op.total) || rest <= 0 || done < (byBytes ? 1 : 2)) return null
  const seconds = (rest * elapsed) / done / 1000
  if (seconds < 45) return 'faltam alguns segundos'
  const minutes = Math.round(seconds / 60)
  if (minutes <= 1) return 'falta ~1 min'
  if (minutes < 60) return `faltam ~${minutes} min`
  const hours = Math.floor(minutes / 60)
  const left = minutes % 60
  return `faltam ~${hours} h${left ? ` ${left} min` : ''}`
}
