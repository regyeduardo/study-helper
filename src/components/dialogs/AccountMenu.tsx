import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { GooglePopupError, isGoogleLoginConfigured, preloadGoogleAccounts } from '@/controllers/google-auth.controller'
import { LocalRepository } from '@/lib/storage/local-repository'
import { applyTheme, savedTheme, type ThemeChoice } from '@/lib/theme'
import { working } from '@/lib/working'
import { type Account, initialsOf, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'

/** Only for the admin account (spec 003, FR-058); it uses the router, so it is rendered only when that account is signed in. */
function AdminLink({ onGo }: { onGo(): void }) {
  const navigate = useNavigate()
  return (
    <button
      className="mi"
      onClick={() => {
        onGo()
        navigate('/administracao')
      }}
    >
      <Icon name="key" />
      Administração
    </button>
  )
}

function Mini({ account }: { account: Account }) {
  if (account.picture) return <img className="avatar" src={account.picture} alt="" style={{ width: 22, height: 22 }} referrerPolicy="no-referrer" />
  return (
    <span className={`avatar ${account.kind === 'local' ? 'local' : ''}`} style={{ width: 22, height: 22, fontSize: 10 }}>
      {initialsOf(account)}
    </span>
  )
}

async function localHasContent(): Promise<boolean> {
  const snapshot = await new LocalRepository().load()
  return snapshot.files.length > 0 || snapshot.folders.length > 0
}

export function AccountMenu() {
  const ui = useUiStore()
  const anchor = ui.overlay?.kind === 'account' ? ui.overlay : null
  const accounts = useAccountStore(state => state.accounts)
  const active = useAccountStore(state => state.active())
  const { addGoogleAccount, switchTo, forgetAccount } = useAccountStore()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(savedTheme)
  const [popupClosed, setPopupClosed] = useState(false)
  const isAdmin = useServerAccount(state => !!state.me?.user.admin)
  const configured = isGoogleLoginConfigured()
  // The Google window has to open inside the tap: the script is brought in before it.
  useEffect(() => {
    preloadGoogleAccounts()
  }, [])
  const add = async (redirect = false) => {
    setBusy(true)
    setError(null)
    setPopupClosed(false)
    try {
      // Started now and read after the sign-in: nothing may be awaited before the Google window opens.
      const hadLocal = active.kind === 'local' ? localHasContent().catch(() => false) : Promise.resolve(false)
      await addGoogleAccount({ redirect, sendLocal: hadLocal })
      ui.close()
      if (await hadLocal) ui.open({ kind: 'send-local' })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'O login falhou.')
      setPopupClosed(failure instanceof GooglePopupError && failure.reason === 'closed')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    // the app is held in the window until the login and the cache are gone; a failure stays there with its reason
    const ok = await working('Saindo da conta…', async () => {
      await useSyncStore.getState().removeThisDevice()
      await useLibraryStore.getState().forgetCurrent()
      await forgetAccount(active.id)
    })
    setBusy(false)
    if (!ok) return
    ui.close()
    ui.toast('Saiu da conta; o login e o cache dela foram apagados deste navegador')
  }

  return (
    <Popover x={anchor?.x ?? window.innerWidth - 300} y={anchor?.y ?? 52} onClose={ui.close} label="Conta">
      <div className="who">
        <Mini account={active} />
        <div>
          <b>{active.name}</b>
          <small>{active.email}</small>
        </div>
      </div>
      <div className="hr" />
      <div className="mh">Trocar de conta</div>
      {accounts.map(account => (
        <button
          key={account.id}
          className={`mi ${account.id === active.id ? 'on' : ''}`}
          onClick={() => {
            switchTo(account.id)
            ui.close()
          }}
        >
          <Mini account={account} />
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            {account.name}
            <br />
            <small className="faint">{account.email}</small>
          </span>
          {account.id === active.id && <Icon name="check" />}
        </button>
      ))}
      <button className="mi" onClick={() => void add()} disabled={busy || !configured} title={configured ? undefined : 'Falta configurar VITE_GOOGLE_CLIENT_ID no build'}>
        <Icon name="plus" />
        {busy ? 'Abrindo o Google…' : 'Adicionar conta Google'}
      </button>
      {!configured && (
        <span className="faint" style={{ fontSize: 11.5, padding: '0 9px 6px' }}>
          O login do Google precisa do ID do cliente no build (VITE_GOOGLE_CLIENT_ID).
        </span>
      )}
      {error && (
        <span style={{ color: 'var(--bad)', fontSize: 12, padding: '0 9px 6px' }} role="alert">
          {error}
        </span>
      )}
      {popupClosed && (
        <button className="mi" onClick={() => void add(true)} disabled={busy}>
          <Icon name="plus" />
          Entrar nesta aba
        </button>
      )}
      <div className="hr" />
      <label className="mi mi-theme">
        <Icon name="contrast" />
        <span>Tema</span>
        <select
          className="input"
          aria-label="Tema"
          value={theme}
          onChange={event => {
            const choice = event.target.value as ThemeChoice
            setTheme(choice)
            applyTheme(choice)
          }}
        >
          <option value="system">Igual ao sistema</option>
          <option value="light">Claro</option>
          <option value="dark">Escuro</option>
        </select>
      </label>
      <button className="mi" onClick={() => ui.open({ kind: 'settings' })}>
        <Icon name="gear" />
        Configurações
      </button>
      {isAdmin && <AdminLink onGo={ui.close} />}
      {active.kind === 'google' && (
        <button className="mi" onClick={() => void signOut()} disabled={busy}>
          <Icon name="logout" />
          Sair desta conta
        </button>
      )}
    </Popover>
  )
}
