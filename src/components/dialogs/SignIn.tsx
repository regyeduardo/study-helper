import { type FormEvent, useRef, useState } from 'react'

import { Dialog } from '@/components/ui/Dialog'
import { ApiError } from '@/controllers/api.controller'
import { useNestedEscape } from '@/hooks/use-nested-escape'
import { useServerAccount } from '@/stores/server-account'

import '@/styles/account.css'

/**
 * "Entrar no Estudo" (spec 003, entrega 3, opção C: tudo à vista): Google em cima, "ou", e-mail e senha abertos, e embaixo o
 * caminho para criar a conta com e-mail e senha.
 */
export function SignInDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const signInWithGoogle = useServerAccount(state => state.signInWithGoogle)
  const signInWithPassword = useServerAccount(state => state.signInWithPassword)
  const register = useServerAccount(state => state.register)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  useNestedEscape(onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (creating) await register(email.trim(), password, name.trim())
      else await signInWithPassword(email.trim(), password)
      onDone()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu certo. Tente de novo.')
      // the focus goes back to the field to fix
      const code = failure instanceof Error && failure.cause instanceof ApiError ? failure.cause.code : ''
      ;(code === 'invalid_email' || code === 'email_taken' ? emailRef : passwordRef).current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const ready = email.trim() !== '' && password !== '' && (!creating || name.trim() !== '')
  return (
    <Dialog title="Entrar no Estudo" size="narrow" onClose={onClose}>
      <form className="db acc-form" onSubmit={event => void submit(event)} noValidate>
        <button type="button" className="btn acc-google" onClick={signInWithGoogle}>
          <svg className="acc-g" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          Entrar com o Google
        </button>
        <div className="acc-or" aria-hidden="false">
          <span>ou</span>
        </div>
        {creating && (
          <div className="field">
            <label htmlFor="acc-name">Nome</label>
            <input className="input" id="acc-name" autoComplete="name" value={name} onChange={event => setName(event.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="acc-email">E-mail</label>
          <input ref={emailRef} className="input" id="acc-email" type="email" inputMode="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="acc-password">Senha</label>
          <div className="acc-password">
            <input
              ref={passwordRef}
              className="input"
              id="acc-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete={creating ? 'new-password' : 'current-password'}
              aria-describedby={creating ? 'acc-password-hint' : undefined}
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
            <button type="button" className="acc-peek" aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>
              {showPassword ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
          {creating && (
            <span id="acc-password-hint" className="faint acc-hint">
              Pelo menos 8 caracteres.
            </span>
          )}
        </div>
        {error && (
          <p className="acc-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary acc-submit" disabled={!ready || busy}>
          {busy ? (creating ? 'Criando…' : 'Entrando…') : creating ? 'Criar conta' : 'Entrar'}
        </button>
        <button
          type="button"
          className="acc-switch"
          onClick={() => {
            setCreating(value => !value)
            setError(null)
          }}
        >
          {creating ? 'Já tem conta? Entrar' : 'Não tem conta? Criar com e-mail e senha'}
        </button>
      </form>
    </Dialog>
  )
}
