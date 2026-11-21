import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { Icon } from '@/components/ui/Icon'
import { loginOutcome, useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import '@/styles/admin.css'

/** "Seguir com Google Drive e Local" closes the screen until the app is opened again (this tab's session). */
const SEEN_KEY = 'estudo-acesso-retirado-visto'

function localDay(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR')
}

interface RevokedScreenProps {
  deleteAt: string | null
  /** Whether the account keeps anything on the server; with nothing there, there is nothing to take out. */
  hasData: boolean
  onToDrive(): void
  onDownload(): void
  onContinue(): void
}

/**
 * Acesso retirado (spec 003, história 1, cenário 11; layout 5·A): shown on opening the app, it says what happened, the day the account's
 * data goes, and the ways out: take the library out (Drive or a file) or go on with Google Drive and Local as before.
 */
export function RevokedScreen({ deleteAt, hasData, onToDrive, onDownload, onContinue }: RevokedScreenProps) {
  const day = localDay(deleteAt)
  // Focus goes into the screen (its title), so a screen reader reads it first; no button is focused for the person.
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus(), [])
  // The app behind stays out of reach: Tab goes around the screen's buttons.
  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const [first, last] = [buttons[0], buttons[buttons.length - 1]]
    if (!first) return
    const at = document.activeElement
    if (event.shiftKey ? at === first || at === title.current : at === last) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
  return (
    <div className="revoked" role="dialog" aria-modal="true" aria-labelledby="revoked-title" onKeyDown={keepFocusInside}>
      <div className="revoked-card">
        <span className="revoked-mark" aria-hidden="true">
          <Icon name="warn" />
        </span>
        <h1 id="revoked-title" ref={title} tabIndex={-1}>O acesso desta conta à estrutura do app foi retirado</h1>
        {hasData ? (
          <p>
            O que está na sua conta do Estudo será apagado em <b>{day}</b>. Até lá, você pode levar tudo para fora.
          </p>
        ) : (
          <p>
            Nada da sua biblioteca está guardado na conta do Estudo: ela continua no Google Drive e neste navegador. A conta do Estudo será apagada em <b>{day}</b>.
          </p>
        )}
        <div className="revoked-actions">
          {hasData && (
            <>
              <button className="btn primary" onClick={onToDrive}>
                <Icon name="cloud" />
                Levar a biblioteca para o Google Drive
              </button>
              <button className="btn" onClick={onDownload}>
                <Icon name="download" />
                Baixar tudo num arquivo
              </button>
            </>
          )}
          <button className={hasData ? 'btn quiet' : 'btn primary'} onClick={onContinue}>
            Seguir com Google Drive e Local
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * On opening the app: asks the server who is signed in (nothing happens without a server), tells why a sign-in with Google came back
 * refused, and puts the Acesso retirado screen in front of everything when the owner took the access away.
 */
export function ServerAccountGate() {
  const me = useServerAccount(state => state.me)
  const toast = useUiStore(state => state.toast)
  const [seen, setSeen] = useState(() => {
    try {
      return sessionStorage.getItem(SEEN_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    const outcome = loginOutcome()
    if (outcome) toast(outcome)
    // An answer the app cannot read (the server down, a 500) only leaves things as they were.
    void useServerAccount
      .getState()
      .refresh()
      .catch(() => undefined)
  }, [toast])

  if (seen || me?.user.status !== 'revoked') return null

  const later = () => toast('Levar a biblioteca para fora ainda não está disponível nesta versão do app.')
  const goOn = () => {
    try {
      sessionStorage.setItem(SEEN_KEY, '1')
    } catch {
      // without session storage, it simply comes back on the next opening
    }
    setSeen(true)
  }
  return <RevokedScreen deleteAt={me.user.deleteAt} hasData={me.space.notes + me.space.media > 0} onToDrive={later} onDownload={later} onContinue={goOn} />
}
