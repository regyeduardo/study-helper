import { startTransition, useEffect, useState } from 'react'

/** The rows a long table draws on its first frame: about two screens. */
export const FIRST_ROWS = 30

/** After the frame is painted (a test's jsdom may have no frames). */
function afterFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(run, 0)
    return () => clearTimeout(timer)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const frame = requestAnimationFrame(() => (timer = setTimeout(run, 0)))
  return () => {
    cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
}

/**
 * How many of a table's `total` rows to draw (spec 007, T047): first what fills the screen, and the rest right after that frame, as a
 * transition (a tap or the scroll go first). Drawing 100 or 120 rows at once held a screen for about 1 s on the phone; what ends
 * drawn is the same as before. `list` names the list: another one (another folder) starts again from the first rows.
 */
export function useDrawnRows(total: number, list: string): number {
  const [state, setState] = useState({ list, drawn: FIRST_ROWS })
  const drawn = state.list === list ? state.drawn : FIRST_ROWS
  useEffect(() => {
    if (drawn >= total) return
    return afterFrame(() => startTransition(() => setState({ list, drawn: Infinity })))
  }, [drawn, total, list])
  return Math.min(drawn, total)
}
