import { useEffect, useState } from 'react'

import type { FileMeta } from '@/types/domain'
import { type OpenedFile, useLibraryStore } from '@/stores/library'

export interface DocumentData {
  meta: FileMeta | null
  opened: OpenedFile | null
  error: string | null
}

export function useDocument(fileId: string | null): DocumentData {
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId) ?? null)
  const opened = useLibraryStore(state => (fileId ? state.opened[fileId] ?? null : null))
  const openFile = useLibraryStore(state => state.openFile)
  const [error, setError] = useState<string | null>(null)
  const updatedAt = meta?.updated.at

  useEffect(() => {
    if (!fileId || !meta) return
    setError(null)
    openFile(fileId).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
  }, [fileId, Boolean(meta), updatedAt, opened === null])

  return { meta, opened, error }
}
