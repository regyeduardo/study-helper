import { useState, useCallback } from 'react'

const STORAGE_KEY = 'dock_position'

export type DockPosition = 'left' | 'right'

function readPosition(): DockPosition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'left' || raw === 'right') return raw
  } catch {
    // localStorage unavailable — return default
  }
  return 'left'
}

export function useDockPosition(): [DockPosition, (pos: DockPosition) => void] {
  const [position, setPosition] = useState<DockPosition>(readPosition)

  const setAndPersist = useCallback((pos: DockPosition) => {
    setPosition(pos)
    try {
      localStorage.setItem(STORAGE_KEY, pos)
    } catch {
      // silently ignore storage errors
    }
  }, [])

  return [position, setAndPersist]
}
