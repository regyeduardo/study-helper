import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useUiStore } from '@/stores/ui'

const DONE_VISIBLE_MS = 5000

export function JobsPanel() {
  const { jobs, cancel, dismiss } = useJobsStore()
  const toast = useUiStore(state => state.toast)
  const navigate = useNavigate()

  useEffect(() => {
    const finished = jobs.filter(job => job.status === 'done' || job.status === 'cancelled')
    if (!finished.length) return
    const timer = window.setTimeout(() => finished.forEach(job => dismiss(job.id)), DONE_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [jobs, dismiss])

  useEffect(() => {
    for (const job of jobs) if (job.status === 'done' && job.kind === 'generation' && job.fileId && job.message.startsWith('Pronta')) toast(`“${job.title}” ficou pronta`)
  }, [jobs.filter(job => job.status === 'done').length])

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
              <button className="btn quiet danger" onClick={() => cancel(job.id)}>
                Cancelar
              </button>
            ) : (
              <button className="ibtn" onClick={() => dismiss(job.id)} aria-label="Dispensar">
                <Icon name="x" />
              </button>
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
