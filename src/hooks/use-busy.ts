import { useCallback, useRef, useState } from 'react'

/**
 * A button that waits for something slow: `busy` is true from the click until the work ends,
 * and a second click while it is busy does nothing (not even in the same instant, before the screen is drawn again).
 * `run` gives back what the work gave, or undefined when it did not start (already busy). The work handles its own errors;
 * if it throws, `busy` still goes back to false.
 */
export function useBusy(): [boolean, <T>(work: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const run = useCallback(async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined
    running.current = true
    setBusy(true)
    try {
      return await work()
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [])
  return [busy, run]
}
