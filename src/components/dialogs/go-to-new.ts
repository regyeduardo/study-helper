// Where the person goes when something new is made: with a note or an entrada open she is reading, she stays; else the app goes to it.
import { useLocation, useNavigate } from 'react-router-dom'

import { useUiStore } from '@/stores/ui'

/** A note or an entrada is open on screen (also a shared note). */
export const readingAt = (pathname: string): boolean => /\/(arquivo|entrada)\/[^/]+\/?$/.test(pathname)

/** With something open, a notice says what started, with "Abrir"; with nothing open (or already there), it goes. */
export function goToNew(to: string, said: string, pathname: string, go: (to: string) => void): void {
  if (!readingAt(pathname) || pathname === to) return go(to)
  useUiStore.getState().toast(`${said}. Você continua aqui.`, { label: 'Abrir', to })
}

/** `goToNew` from where the person is now. */
export function useGoToNew(): (to: string, said: string) => void {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return (to, said) => goToNew(to, said, pathname, navigate)
}
