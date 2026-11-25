import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { comeca, type OpId, termina } from '@/lib/perf'

/**
 * Marks of changing screens and opening a folder (spec 007, T016): the measure starts when the address changes (the click on a link
 * changes it in the same task) and ends at the frame after the new screen rendered.
 */

export function opDaRota(pathname: string): OpId | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/' || path === '/biblioteca') return 'tela-biblioteca'
  if (path.startsWith('/biblioteca/')) return 'abrir-pasta'
  if (path.startsWith('/gravacoes')) return 'tela-gravacoes'
  if (path.startsWith('/geracoes')) return 'tela-geracoes'
  if (path === '/idiomas') return 'tela-idiomas'
  if (path.startsWith('/administracao')) return 'tela-admin'
  return null
}

interface RouterLike {
  state: { location: { pathname: string } }
  subscribe(listener: (state: { location: { pathname: string } }) => void): () => void
}

/** Starts a measure at every change of the address; gives back the function that stops. */
export function marcarRotas(router: RouterLike): () => void {
  let last = router.state.location.pathname
  return router.subscribe(state => {
    const path = state.location.pathname
    if (path === last) return
    last = path
    const op = opDaRota(path)
    if (op) comeca(op)
  })
}

/** In the screen that holds the routes: ends the measure once the new screen rendered. */
export function useFimDaRota(): void {
  const { pathname } = useLocation()
  useEffect(() => {
    const op = opDaRota(pathname)
    if (op) termina(op)
  }, [pathname])
}
