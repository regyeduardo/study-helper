import { useEffect, type RefObject } from 'react'

/**
 * Calls `onClickOutside` when a mousedown event occurs outside `ref.current`.
 *
 * Only attaches the listener when `active` is true, making it safe to use
 * in conditional UIs (popovers, modals, etc.).
 *
 * @example
 * ```ts
 * const ref = useRef<HTMLDivElement>(null)
 * useOutsideClick(ref, open, () => setOpen(false))
 * ```
 */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClickOutside: () => void,
) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClickOutside()
      }
    }
    if (active) {
      document.addEventListener('mousedown', handler)
    }
    return () => document.removeEventListener('mousedown', handler)
  }, [active, onClickOutside, ref])
}
