import { useEffect, useState } from 'react'

import { useLibraryStore } from '@/stores/library'

const PROGRESS_KEY = 'study-helper:progress'

function key(accountId: string | null): string {
  return `${PROGRESS_KEY}:${accountId ?? 'local'}`
}

export function readProgress(accountId: string | null): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(key(accountId)) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function saveProgress(accountId: string | null, fileId: string, ratio: number): void {
  try {
    localStorage.setItem(key(accountId), JSON.stringify({ ...readProgress(accountId), [fileId]: ratio }))
  } catch {
    return
  }
}

export function useTrackReading(scroller: HTMLElement | null, fileId: string | null): void {
  const accountId = useLibraryStore(state => state.accountId)
  useEffect(() => {
    if (!scroller || !fileId) return
    let timer = 0
    const onScroll = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const room = scroller.scrollHeight - scroller.clientHeight
        if (room > 0) saveProgress(accountId, fileId, Math.min(1, scroller.scrollTop / room))
      }, 400)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.clearTimeout(timer)
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [scroller, fileId, accountId])
}

export function useReadingProgress(fileId: string | null): number | null {
  const accountId = useLibraryStore(state => state.accountId)
  const [ratio, setRatio] = useState<number | null>(null)
  useEffect(() => {
    setRatio(fileId ? (readProgress(accountId)[fileId] ?? null) : null)
  }, [fileId, accountId])
  return ratio
}
