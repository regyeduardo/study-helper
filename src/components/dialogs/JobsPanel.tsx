import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useUiStore } from '@/stores/ui'

const DONE_VISIBLE_MS = 5000

/** Tarefas without the corner cards (FR-065: the page Gerações follows them): the "ficou pronta" notice, and what ended leaves Tarefas after a while. */
export function JobsPanel() {
  const { jobs, dismiss } = useJobsStore()
  const toast = useUiStore(state => state.toast)
  const { pathname } = useLocation()
  const told = useRef(new Set<string>())

  useEffect(() => {
    const finished = jobs.filter(job => job.status === 'done' || job.status === 'cancelled')
    if (!finished.length) return
    const timer = window.setTimeout(() => finished.forEach(job => dismiss(job.id)), DONE_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [jobs, dismiss])

  // each note said once; away from it, the notice opens it
  useEffect(() => {
    for (const job of jobs) {
      if (job.status !== 'done' || job.kind !== 'generation' || !job.fileId || !job.message.startsWith('Pronta') || told.current.has(job.id)) continue
      told.current.add(job.id)
      const to = paths.file(job.fileId)
      toast(`“${job.title}” ficou pronta`, pathname === to ? undefined : { label: 'Abrir', to })
    }
  }, [jobs.filter(job => job.status === 'done').length])

  return null
}
