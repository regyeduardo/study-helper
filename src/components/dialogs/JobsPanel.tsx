import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { paths } from '@/lib/paths'
import { type Job, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'

const DONE_VISIBLE_MS = 5000

export function JobsPanel() {
  const { jobs, cancel, dismiss } = useJobsStore()
  const toast = useUiStore(state => state.toast)
  const open = useUiStore(state => state.open)
  const files = useLibraryStore(state => state.files)
  const navigate = useNavigate()
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

  /** What "Tentar de novo" opens: the window that asked, as it was filled in; a note kept to write again, its own choice of model. */
  const retryOf = (job: Job): Overlay | undefined => {
    if (job.status !== 'error') return undefined
    if (job.retry) return job.retry
    return job.kind === 'generation' && job.fileId && files.find(file => file.id === job.fileId && !file.deletedAt)?.status === 'pending' ? { kind: 'pending', fileId: job.fileId } : undefined
  }

  const visible = jobs.slice(0, 4)
  if (!visible.length) return null
  return (
    <div className="jobs" aria-live="polite">
      {visible.map(job => (
        <div key={job.id} className={`job ${job.status === 'error' ? 'error' : ''}`} role="status">
          <div className="jh">
            {job.status === 'running' ? <Icon name="sync" className="spinning" /> : job.status === 'done' ? <Icon name="check" /> : <Icon name={job.status === 'error' ? 'warn' : 'x'} />}
            <b>{job.title}</b>
            {job.fileId && (
              <button className="ibtn" onClick={() => navigate(paths.file(job.fileId!))} aria-label="Abrir">
                <Icon name="fwd" />
              </button>
            )}
            {job.status === 'running' ? (
              // a plain task of the app (saving, exporting, deleting) has nothing to cancel
              job.kind !== 'sync' && (
                <button className="btn quiet danger" onClick={() => cancel(job.id)}>
                  Cancelar
                </button>
              )
            ) : (
              <>
                {retryOf(job) && (
                  <button
                    className="btn quiet"
                    onClick={() => {
                      const retry = retryOf(job)!
                      dismiss(job.id)
                      open(retry)
                    }}
                  >
                    Tentar de novo
                  </button>
                )}
                <button className="ibtn" onClick={() => dismiss(job.id)} aria-label="Dispensar">
                  <Icon name="x" />
                </button>
              </>
            )}
          </div>
          <div className="jm">{job.message}</div>
          {job.fraction !== null && job.status === 'running' && (
            <div className="bar">
              <i style={{ '--v': `${Math.round(job.fraction * 100)}%` } as React.CSSProperties} />
            </div>
          )}
          {job.error && <div className="err">{job.error}</div>}
        </div>
      ))}
    </div>
  )
}
