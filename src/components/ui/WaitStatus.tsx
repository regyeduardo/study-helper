import { type CSSProperties, useEffect, useRef, useState } from 'react'

import { Icon } from '@/components/ui/Icon'
import { agoShort, clockOf, durationShort, estimate, isStalled, progressText, type Wait } from '@/lib/wait'

import '@/styles/wait.css'

/** How often the screen reader hears the progress: at most once in this time (contracts/ui.md, WaitStatus). */
const SPEAK_EVERY_MS = 10_000
/** "Esperar" with no normal time known keeps the warning away this long. */
const SNOOZE_FALLBACK_MS = 60_000

interface WaitStatusProps {
  wait: Wait
  onCancel?: () => void
  onRetry?: () => void
  /** At the end, opens what came out. */
  onOpen?: () => void
}

/**
 * Every wait the person sees, the same way (constitution IV; spec 007, FR-060 to FR-065): what is happening, how much is done, when it
 * should end and that it did not freeze; stalled, since when and what can be done; at the end, the result or the reason.
 */
export function WaitStatus({ wait, onCancel, onRetry, onOpen }: WaitStatusProps) {
  const [now, setNow] = useState(() => Date.now())
  const [snoozedUntil, setSnoozedUntil] = useState(0)
  const counted = progressText(wait)
  const spoken = counted ? `${wait.what} · ${counted}` : wait.what
  const [heard, setHeard] = useState(spoken)
  const heardAt = useRef(Date.now())

  // the "há N s" and the stall are redone every second
  useEffect(() => {
    if (wait.outcome) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [wait.outcome])

  useEffect(() => {
    if (spoken === heard || Date.now() - heardAt.current < SPEAK_EVERY_MS) return
    heardAt.current = Date.now()
    setHeard(spoken)
  }, [spoken, heard, now])

  if (wait.outcome) {
    const { ok, text, next } = wait.outcome
    return (
      <div className={`wait-status ${ok ? 'done' : 'failed'}`}>
        <p className="wait-outcome" role={ok ? 'status' : 'alert'}>
          {!ok && <Icon name="warn" />}
          <span>{text}</span>
        </p>
        {next && <p className="wait-next">{next}</p>}
        {((ok && onOpen) || (!ok && onRetry)) && (
          <div className="wait-act">
            {ok && onOpen && (
              <button className="btn" onClick={onOpen}>
                Abrir
              </button>
            )}
            {!ok && onRetry && (
              <button className="btn" onClick={onRetry}>
                Tentar de novo
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const byBytes = (wait.totalBytes ?? 0) > 0
  const determinate = byBytes || wait.total !== undefined
  const share = byBytes ? (wait.doneBytes ?? 0) / wait.totalBytes! : (wait.done ?? 0) / (wait.total || 1)
  const percent = Math.max(0, Math.min(100, Math.floor(share * 100)))
  const guess = estimate(wait, now)
  const stalled = isStalled(wait, now) && now >= snoozedUntil
  const moved = wait.paces.length > 0 || (wait.done ?? 0) > 0 || (wait.doneBytes ?? 0) > 0
  const stalledFrom = wait.stalledSince !== undefined && wait.stalledSince < wait.lastProgressAt ? wait.stalledSince : wait.lastProgressAt

  return (
    <div className={`wait-status${stalled ? ' stalled' : ''}`}>
      <p className="wait-what">{wait.what}</p>
      <div
        className={`wait-bar${determinate ? '' : ' loose'}`}
        role="progressbar"
        aria-label={wait.what}
        {...(determinate ? { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent, 'aria-valuetext': counted } : {})}
      >
        <i style={determinate ? ({ '--p': share } as CSSProperties) : undefined} />
      </div>
      <div className="wait-meta">
        {counted && <p className="wait-count">{counted}</p>}
        {guess && <p className="wait-eta">{`deve terminar por volta de ${clockOf(guess.etaAt)}${guess.basis === 'history' && wait.history ? `, pelas últimas ${wait.history.label} parecidas` : ''}`}</p>}
        {!stalled && <p className="wait-alive">{`sem travar: ${moved ? 'última parte' : 'começou'} ${agoShort(now - (moved ? wait.lastProgressAt : wait.startedAt))}`}</p>}
      </div>
      {stalled && (
        <div className="wait-stalled" role="alert">
          <p>
            <Icon name="warn" />
            <span>{`Nada andou desde ${clockOf(stalledFrom)}.${wait.normalStepMs ? ` Normal para esta etapa é até ${durationShort(wait.normalStepMs)}.` : ''}`}</span>
          </p>
          <div className="wait-act">
            <button className="btn" onClick={() => setSnoozedUntil(Date.now() + (wait.normalStepMs ?? SNOOZE_FALLBACK_MS))}>
              Esperar
            </button>
            {onRetry && (
              <button className="btn" onClick={onRetry}>
                Tentar de novo
              </button>
            )}
            {onCancel && (
              <button className="btn quiet" onClick={onCancel}>
                Cancelar
              </button>
            )}
          </div>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {heard}
      </p>
    </div>
  )
}
