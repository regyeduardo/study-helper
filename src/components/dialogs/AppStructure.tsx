import { type FormEvent, useEffect, useRef, useState } from 'react'

import { SignInDialog } from '@/components/dialogs/SignIn'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { ApiError, apiMessage, type ServerMe } from '@/controllers/api.controller'
import { useNestedEscape } from '@/hooks/use-nested-escape'
import { useServerAccount } from '@/stores/server-account'

import '@/styles/account.css'

const OFFLINE = 'Não deu para falar com o servidor. Confira a internet e tente de novo.'

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

  /** Turning on: sign in first, then the code if the account still needs one, else just on. */
  const turnOn = async (current: ServerMe | null) => {
    setProblem(null)
    setNote(null)
    if (!current) return setStep('sign-in')
    if (current.user.status !== 'enabled' && current.requireCode) return setStep('code')
    setBusy(true)
    try {
      await setStructure(true)
      setNote('A estrutura do app está ligada nesta conta.')
    } catch (failure) {
      if (failure instanceof Error && failure.cause instanceof ApiError && failure.cause.code === 'code_required') setStep('code')
      else setProblem(failure instanceof Error ? failure.message : apiMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const turnOff = async () => {
    setStep(null)
    setBusy(true)
    setNote(null)
    try {
      await setStructure(false)
      setNote('A estrutura do app está desligada. Nada foi apagado.')
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
      {step === 'off' && <TurnOffDialog onClose={() => setStep(null)} onConfirm={() => void turnOff()} />}
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
