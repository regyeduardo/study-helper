import { useEffect, useState } from 'react'

export const NARROW_QUERY = '(max-width: 760px)'

export function isNarrowScreen(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.(NARROW_QUERY).matches ?? false)
}

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(isNarrowScreen)
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_QUERY)
    if (!query) return
    const onChange = () => setNarrow(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return narrow
}
