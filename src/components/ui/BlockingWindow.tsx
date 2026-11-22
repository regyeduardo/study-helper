import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon } from '@/components/ui/Icon'
import { timeLeft, useBlockingStore } from '@/stores/blocking'
import { useSyncStore } from '@/stores/sync'
import { formatBytes } from '@/utils/format'

import '@/styles/blocking.css'

/** A quick operation does not blink: the app is held from the click, and the window shows only after this. */
const SHOW_AFTER_MS = 300

/**
 * The window of an operation the person waits for (owner's choice F, 2026-11-21): in the middle of the screen, with the bar, how many of
 * how many, how much space, how long is left and the item in hand; "Cancelar" when the operation can stop. From the click the rest of the
 * page is inert and no key reaches the app (Esc cancels when Cancelar is there). A failure stays with its reason until "Fechar".
 */
export function BlockingWindow() {
  const ops = useBlockingStore(state => state.ops)
  const cancel = useBlockingStore(state => state.cancel)
  const close = useBlockingStore(state => state.close)
  const top = ops.at(-1)
  // a write in the operation may ask which version stays (the conflict window): the window steps aside until it is answered
  const asking = useSyncStore(state => state.conflicts.length > 0 && !state.conflictsHidden)
  const waiting = useSyncStore(state => state.conflicts.length > 0 && state.conflictsHidden)
  const showConflicts = useSyncStore(state => state.showConflicts)
  const active = Boolean(top) && !asking
  const [host] = useState(() => document.createElement('div'))
  const [now, setNow] = useState(() => Date.now())
  const layer = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const before = useRef<Element | null>(null)

  useEffect(() => {
    host.className = 'blk-host'
    document.body.appendChild(host)
    return () => host.remove()
  }, [host])

  // the window comes in a moment after the click; the estimate is redone every second
  useEffect(() => {
    if (!top || top.failure) return
    const wait = SHOW_AFTER_MS - (Date.now() - top.startedAt)
    if (wait <= 0) return setNow(Date.now())
    const timer = window.setTimeout(() => setNow(Date.now()), wait)
    return () => window.clearTimeout(timer)
  }, [top?.id])
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  // the rest of the page goes inert while an operation runs, and the focus waits in the window
  useLayoutEffect(() => {
    if (!active) return
    before.current = document.activeElement
    const held = [...document.body.children].filter(element => element !== host && !element.hasAttribute('inert'))
    for (const element of held) element.setAttribute('inert', '')
    layer.current?.focus()
    return () => {
      for (const element of held) element.removeAttribute('inert')
      if (before.current instanceof HTMLElement && before.current.isConnected) before.current.focus()
    }
  }, [active, host])

  // no key reaches the app: Tab stays in the window, Esc is Cancelar (or Fechar, on a failure)
  useEffect(() => {
    if (!active) return
    const hold = (event: KeyboardEvent) => {
      const current = useBlockingStore.getState().ops.at(-1)
      if (!current) return
      const button = panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      if (event.key === 'Tab') {
        event.preventDefault()
        ;(button ?? panel.current ?? layer.current)?.focus()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        if (current.failure) useBlockingStore.getState().close(current.id)
        else useBlockingStore.getState().cancel(current.id)
      } else if (!(event.target instanceof Node && host.contains(event.target) && (event.key === 'Enter' || event.key === ' '))) event.preventDefault()
      event.stopImmediatePropagation()
    }
    const quiet = (event: KeyboardEvent) => event.stopImmediatePropagation()
    window.addEventListener('keydown', hold, true)
    window.addEventListener('keyup', quiet, true)
    return () => {
      window.removeEventListener('keydown', hold, true)
      window.removeEventListener('keyup', quiet, true)
    }
  }, [active, host])

  const visible = Boolean(top && (top.failure || now - top.startedAt >= SHOW_AFTER_MS))
  // at "Cancelar" the button turns disabled: the focus goes to the window (and its note is read) instead of being lost
  useEffect(() => {
    if (!visible) return
    ;(panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? panel.current)?.focus()
  }, [visible, top?.id, top?.failure, top?.cancelling])

  if (!top || !active) return createPortal(null, host)
  const byBytes = (top.totalBytes ?? 0) > 0
  const determinate = Boolean(top.total) || byBytes
  const share = byBytes ? (top.doneBytes ?? 0) / top.totalBytes! : (top.done ?? 0) / (top.total || 1)
  const percent = Math.max(0, Math.min(100, Math.floor(share * 100)))
  const count = top.total ? `${(top.done ?? 0).toLocaleString('pt-BR')} de ${top.total.toLocaleString('pt-BR')}` : null
  const size = byBytes ? `${formatBytes(top.doneBytes ?? 0)} de ${formatBytes(top.totalBytes!)}` : null
  // each piece stays whole: on a narrow phone the line breaks after a "·", never inside "1,1 GB de 3,2 GB"
  const parts = [count, size, timeLeft(top, now)].filter((part): part is string => Boolean(part))
  const described = top.failure ? 'blk-reason' : [top.phase && 'blk-phase', top.cancelling && 'blk-note'].filter(Boolean).join(' ') || undefined

  return createPortal(
    <div className={`blk-layer${visible ? ' on' : ''}`} ref={layer} tabIndex={-1}>
      {visible && (
        <div
          className="blk-window"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="blk-title"
          aria-describedby={described}
          aria-busy={top.failure ? undefined : 'true'}
          ref={panel}
          tabIndex={-1}
        >
          <h2 id="blk-title">{top.title}</h2>
          {top.failure ? (
            <>
              <p className="blk-failure" id="blk-reason">
                <Icon name="warn" />
                <span>{top.failure}</span>
              </p>
              <div className="blk-act">
                <button className="btn primary" onClick={() => close(top.id)}>
                  Fechar
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="blk-progress">
                {(top.phase || determinate) && (
                  <div className="blk-step">
                    {top.phase && (
                      <p className="blk-phase" id="blk-phase">
                        {top.phase}
                      </p>
                    )}
                    {determinate && (
                      <span className="blk-pct" aria-hidden="true">
                        {percent}%
                      </span>
                    )}
                  </div>
                )}
                <div
                  className={`blk-bar${determinate ? '' : ' loose'}`}
                  role="progressbar"
                  aria-label={top.title}
                  {...(determinate ? { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent, 'aria-valuetext': count ?? `${percent}%` } : {})}
                >
                  <i style={{ '--p': determinate ? percent / 100 : 1 } as React.CSSProperties} />
                </div>
                {(parts.length > 0 || top.current) && (
                  <div className="blk-meta">
                    {parts.length > 0 && (
                      <p className="blk-count">
                        {parts.map((part, index) => (
                          <Fragment key={index}>
                            {index > 0 && ' '}
                            <span>{index < parts.length - 1 ? `${part} ·` : part}</span>
                          </Fragment>
                        ))}
                      </p>
                    )}
                    {top.current && (
                      <p className="blk-current" title={top.current}>
                        {top.current}
                      </p>
                    )}
                  </div>
                )}
              </div>
              {waiting && (
                <div className="blk-wait">
                  <p className="blk-note">Esperando você resolver um conflito de edição.</p>
                  <button className="btn" onClick={showConflicts}>
                    Resolver o conflito
                  </button>
                </div>
              )}
              {top.cancelling && (
                <p className="blk-note" id="blk-note">
                  Parando depois do item da vez. O que já foi fica onde chegou.
                </p>
              )}
              {top.cancellable && (
                <div className="blk-act">
                  <button className="btn" disabled={top.cancelling} onClick={() => cancel(top.id)}>
                    {top.cancelling ? 'Cancelando…' : 'Cancelar'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>,
    host,
  )
}
