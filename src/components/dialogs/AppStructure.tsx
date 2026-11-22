import { type FormEvent, useEffect, useRef, useState } from 'react'

import { SignInDialog } from '@/components/dialogs/SignIn'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { ApiError, apiMessage, type ServerMe } from '@/controllers/api.controller'
import { useNestedEscape } from '@/hooks/use-nested-escape'
import { blocking } from '@/lib/blocking'
import { useAccountStore } from '@/stores/account'
import { appItems, placeSizeOf, usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { formatBytes } from '@/utils/format'

import '@/styles/account.css'

const OFFLINE = 'Não deu para falar com o servidor. Confira a internet e tente de novo.'

const notesOf = (count: number) => `${count.toLocaleString('pt-BR')} ${count === 1 ? 'nota' : 'notas'}`

/** Whether the structure of the app is on for the account signed in on the server (FR-032 hides the AI section then). */
export function useStructureOn(): boolean {
  return useServerAccount(state => state.status !== 'signed-out' && !!state.me?.user.appEnabled)
}

/**
 * Configurações › Outros › "Usar a estrutura do app" (spec 003, entrega 3, opção A): o interruptor, quem está conectado e as
 * janelas que ele abre (Entrar, o código, desligar).
 */
export function AppStructureSection() {
  const me = useServerAccount(state => state.me)
  const status = useServerAccount(state => state.status)
  const refresh = useServerAccount(state => state.refresh)
  const setStructure = useServerAccount(state => state.setStructure)
  const signOut = useServerAccount(state => state.signOut)
  const on = useStructureOn()
  const [step, setStep] = useState<null | 'sign-in' | 'code' | 'off'>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (status === 'unknown') void refresh().catch(() => undefined)
  }, [status, refresh])

  /** Already signed in with Google in the app (the Drive account)? That sign-in opens the server session, with no second screen. */
  const withAppGoogle = async (): Promise<ServerMe | null> => {
    const account = useAccountStore.getState().active()
    if (account.kind !== 'google') return null
    setBusy(true)
    try {
      const token = await useAccountStore.getState().tokenFor(account.id)
      return (await useServerAccount.getState().signInWithGoogleToken(token)) ? useServerAccount.getState().me : null
    } catch {
      return null
    } finally {
      setBusy(false)
    }
  }

  /** Turning on: sign in first (with the app's Google when there is one), then the code if the account still needs one, else just on. */
  const turnOn = async (current: ServerMe | null) => {
    setProblem(null)
    setNote(null)
    // from the click until the server answers the app is held in the window; a step that needs the person opens after it
    const next = await blocking('Ligando a estrutura do app…', async () => {
      if (!current) {
        const signedIn = await withAppGoogle()
        if (!signedIn) return 'sign-in' as const
        current = signedIn
      }
      if (current.user.status !== 'enabled' && current.requireCode) return 'code' as const
      setBusy(true)
      try {
        await setStructure(true)
        setNote('A estrutura do app está ligada nesta conta.')
      } catch (failure) {
        if (failure instanceof Error && failure.cause instanceof ApiError && failure.cause.code === 'code_required') return 'code' as const
        setProblem(failure instanceof Error ? failure.message : apiMessage(failure))
      } finally {
        setBusy(false)
      }
      return null
    })
    if (next) setStep(next)
  }

  /** Turning off (FR-066): what is in the App goes first to the place chosen, and the structure goes off only when nothing is left there. */
  const turnOff = async (place?: 'local' | 'drive') => {
    setStep(null)
    setBusy(true)
    setNote(null)
    setProblem(null)
    try {
      if (place) {
        await usePlacesStore.getState().choosePlace(appItems().tops.map(top => top.id), place)
        const left = appItems().notes.length
        if (left) return setProblem(`Ainda há ${notesOf(left)} no App: a estrutura continua ligada. Nada foi apagado.`)
      }
      await blocking('Desligando a estrutura do app…', () => setStructure(false))
      setNote(place ? `A estrutura do app está desligada. As notas do App ${place === 'local' ? 'vieram para Local' : 'foram para o Google Drive'}.` : 'A estrutura do app está desligada. Nada foi apagado.')
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : apiMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const blocked = status === 'unknown' || status === 'offline' || busy
  return (
    <div className="field acc-structure">
      <div className="acc-row">
        <div className="acc-row-text">
          <span className="acc-title" id="acc-structure-title">
            Usar a estrutura do app
          </span>
          <span className="faint">Biblioteca, mídia e geração na sua conta do Estudo</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="acc-structure-title"
          className="acc-toggle"
          disabled={blocked}
          onClick={() => (on ? setStep('off') : void turnOn(useServerAccount.getState().status === 'signed-in' ? useServerAccount.getState().me : null))}
        >
          <span className="acc-track" aria-hidden="true">
            <span className="acc-knob" />
          </span>
          <span>{on ? 'Ligado' : 'Desligado'}</span>
        </button>
      </div>
      {status === 'signed-in' && me && (
        <div className="acc-who">
          <span className="faint">
            Conectado como <b>{me.user.email}</b>
          </span>
          <button
            type="button"
            className="btn quiet"
            onClick={() => {
              setNote(null)
              void signOut().catch(failure => setProblem(failure instanceof Error ? failure.message : apiMessage(failure)))
            }}
          >
            Sair
          </button>
        </div>
      )}
      {status === 'signed-out' && <span className="faint">Ao ligar, você entra na sua conta do Estudo primeiro.</span>}
      {status === 'unknown' && <span className="faint">Verificando a sua conta…</span>}
      {status === 'offline' && <span className="acc-error">{OFFLINE}</span>}
      {on && (
        <div className="banner info">
          <Icon name="info" />
          <span>Com a estrutura ligada, o app fornece a IA: você não precisa configurar provedor, modelo nem chave.</span>
        </div>
      )}
      {note && (
        <span className="acc-note" role="status">
          {note}
        </span>
      )}
      {problem && (
        <span className="acc-error" role="alert">
          {problem}
        </span>
      )}

      {step === 'sign-in' && (
        <SignInDialog
          onClose={() => setStep(null)}
          onDone={() => {
            setStep(null)
            void turnOn(useServerAccount.getState().me)
          }}
        />
      )}
      {step === 'code' && (
        <CodeDialog
          onClose={() => setStep(null)}
          onDone={() => {
            setStep(null)
            setNote('A estrutura do app está ligada nesta conta.')
          }}
        />
      )}
      {step === 'off' &&
        (appItems().notes.length ? (
          <TakeOutDialog onClose={() => setStep(null)} onConfirm={place => void turnOff(place)} />
        ) : (
          <TurnOffDialog onClose={() => setStep(null)} onConfirm={() => void turnOff()} />
        ))}
    </div>
  )
}

/** The short window that says what the structure gives and asks for the invitation code. */
function CodeDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const redeemCode = useServerAccount(state => state.redeemCode)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  useNestedEscape(onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!code.trim()) return
    setBusy(true)
    setError(null)
    try {
      await redeemCode(code.trim())
      onDone()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : apiMessage(failure))
      field.current?.focus()
      field.current?.select()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Usar a estrutura do app"
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={onClose}>
            Agora não
          </button>
          <button type="submit" form="acc-code-form" className="btn primary" disabled={!code.trim() || busy}>
            {busy ? 'Liberando…' : 'Liberar'}
          </button>
        </>
      }
    >
      <form id="acc-code-form" className="db acc-form" onSubmit={event => void submit(event)} noValidate>
        <ul className="acc-gives">
          <li>A biblioteca fica na sua conta e abre igual em todos os aparelhos.</li>
          <li>A mídia não ocupa este aparelho; a geração segue com a aba fechada.</li>
          <li>Por enquanto o acesso é por convite: digite o código que você recebeu.</li>
        </ul>
        <div className="field">
          <label htmlFor="acc-code">Código</label>
          <input
            ref={field}
            autoFocus
            className="input acc-code"
            id="acc-code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ex.: K7QM 3XRT 9PWD"
            aria-describedby={error ? 'acc-code-error' : undefined}
            aria-invalid={error ? true : undefined}
            value={code}
            onChange={event => setCode(event.target.value)}
          />
          {error && (
            <span id="acc-code-error" className="acc-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </form>
    </Dialog>
  )
}

function TurnOffDialog({ onClose, onConfirm }: { onClose(): void; onConfirm(): void }) {
  useNestedEscape(onClose)
  return (
    <Dialog
      title="Desligar a estrutura do app?"
      size="narrow"
      role="alertdialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            Desligar
          </button>
        </>
      }
    >
      <div className="db">
        <span className="muted">
          Nada é apagado: o que está na sua conta do Estudo continua lá, e você pode ligar de novo quando quiser. Neste aparelho, a biblioteca volta a usar Google Drive e Local, e a IA volta a usar as
          suas configurações.
        </span>
      </div>
    </Dialog>
  )
}

/**
 * Turning off with notes in the App (FR-066, owner's choice A): nothing leaves the library. The window says how much is in the App and
 * asks where it goes (Local first; Google Drive with a Google sign-in), says whether it fits in this browser, and only then turns off.
 */
function TakeOutDialog({ onClose, onConfirm }: { onClose(): void; onConfirm(place: 'local' | 'drive'): void }) {
  useNestedEscape(onClose)
  const signedIn = useAccountStore(state => state.active().kind === 'google')
  const [{ notes, bytes }] = useState(() => {
    const { notes: inApp } = appItems()
    return { notes: inApp.length, bytes: inApp.reduce((sum, file) => sum + placeSizeOf(file), 0) }
  })
  const [free, setFree] = useState<number | null>(null)
  const [choice, setChoice] = useState<'local' | 'drive'>('local')
  // how much this browser still takes; unknown when the browser does not say
  useEffect(() => {
    let alive = true
    void navigator.storage
      ?.estimate?.()
      .then(({ quota, usage }) => {
        if (!alive || quota === undefined) return
        const left = Math.max(0, quota - (usage ?? 0))
        setFree(left)
        if (bytes > left && signedIn) setChoice('drive')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [bytes, signedIn])
  const fits = free === null || bytes <= free
  const ready = choice === 'local' ? fits : signedIn

  return (
    <Dialog
      title="Desligar a estrutura do app"
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!ready} onClick={() => onConfirm(choice)}>
            Levar e desligar
          </button>
        </>
      }
    >
      <div className="db acc-takeout">
        {/* the fact on one line, the question on the next (wireframe A) */}
        <p className="acc-takeout-lead">
          <b>{`${notesOf(notes)} e ${formatBytes(bytes)} estão no App.`}</b> Para onde levar antes de desligar?
        </p>
        <fieldset className="acc-places">
          <legend className="sr-only">Para onde levar</legend>
          <label className="acc-place">
            <input
              type="radio"
              name="acc-takeout"
              value="local"
              checked={choice === 'local'}
              disabled={!fits}
              aria-describedby={free === null ? undefined : 'acc-takeout-room'}
              onChange={() => setChoice('local')}
            />
            <span>
              <b>Local (só neste navegador)</b>
              <span className="muted">Não aparece nos outros aparelhos; limpar os dados do navegador apaga.</span>
            </span>
          </label>
          <label className="acc-place">
            <input type="radio" name="acc-takeout" value="drive" checked={choice === 'drive'} disabled={!signedIn} onChange={() => setChoice('drive')} />
            <span>
              <b>Google Drive</b>
              {signedIn ? <span className="muted">Aparece em todos os aparelhos com esta conta Google.</span> : <span className="acc-place-why">Entre com o Google para guardar no Drive.</span>}
            </span>
          </label>
        </fieldset>
        {/* the room in this browser is about Local: a limit (amber, like the app's other "não cabe"), not an error; "Escolha o Google Drive" only when it can be chosen */}
        {free !== null && (
          <p id="acc-takeout-room" className={fits ? 'acc-takeout-room' : 'acc-takeout-room short'}>
            {fits ? `Espaço neste navegador: ${formatBytes(bytes)} de ${formatBytes(free)} livres` : `Não cabe neste navegador: faltam ${formatBytes(bytes - free)}.${signedIn ? ' Escolha o Google Drive.' : ''}`}
          </p>
        )}
      </div>
    </Dialog>
  )
}
