import { agora, comeca, type OpId, termina } from '@/lib/perf'

/**
 * Marks the actions of a store as operations of the Lista de operações (spec 007, T015): from the start of the action to the frame
 * after it ends, failure included. The op can come from the call (`args`) or from what the action gave (`result`), for actions that
 * are more than one operation (an update that renames or moves; a note opened, by its type). An action called inside another of the
 * same operation is measured once, from the outer start to the outer end.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any

export type OpOf =
  | OpId
  | {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args?: (...args: any[]) => OpId | null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result?: (result: any) => OpId | null
    }

interface StoreLike<T> {
  getState(): T
  setState(partial: Partial<T>): void
}

const depth = new Map<OpId, number>()

function enter(op: OpId) {
  const level = depth.get(op) ?? 0
  depth.set(op, level + 1)
  if (level === 0) comeca(op)
}

function leave(op: OpId) {
  const level = (depth.get(op) ?? 1) - 1
  if (level > 0) return void depth.set(op, level)
  depth.delete(op)
  termina(op)
}

function measured(original: AnyFn, opOf: OpOf): AnyFn {
  const wrapped = (...args: unknown[]) => {
    const byArgs = typeof opOf === 'string' ? opOf : (opOf.args?.(...args) ?? null)
    const byResult = typeof opOf === 'string' ? undefined : opOf.result
    const startedAt = agora()
    if (byArgs) enter(byArgs)
    const close = (result: unknown) => {
      if (byArgs) leave(byArgs)
      const op = byResult?.(result) ?? null
      // known only now: it starts back at the call's own start
      if (op && !depth.has(op)) {
        comeca(op, startedAt)
        termina(op)
      }
    }
    let out: unknown
    try {
      out = original(...args)
    } catch (error) {
      close(undefined)
      throw error
    }
    if (out instanceof Promise)
      return out.then(
        value => {
          close(value)
          return value
        },
        error => {
          close(undefined)
          throw error
        },
      )
    close(out)
    return out
  }
  return Object.assign(wrapped, { medida: opOf })
}

export function medirAcoes<T extends object>(store: StoreLike<T>, map: Partial<Record<keyof T, OpOf>>): void {
  const state = store.getState() as Record<string, unknown>
  const patch: Record<string, AnyFn> = {}
  for (const [action, opOf] of Object.entries(map) as [string, OpOf][]) {
    const original = state[action]
    if (typeof original === 'function') patch[action] = measured(original as AnyFn, opOf)
  }
  store.setState(patch as Partial<T>)
}
