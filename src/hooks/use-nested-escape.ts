import { useEffect } from 'react'

/**
 * Esc in a window opened over Configurações closes only that window: it is caught first (capture) and marked as handled, so the
 * Configurações behind it stays open.
 */
export function useNestedEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
}
