import { useState } from 'react'

import { Icon } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { isGoogleLoginConfigured } from '@/controllers/google-auth.controller'
import { LocalRepository } from '@/lib/storage/local-repository'
import { type Account, initialsOf, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'

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
  const accounts = useAccountStore(state => state.accounts)
  const active = useAccountStore(state => state.active())
  const { addGoogleAccount, switchTo, forgetAccount } = useAccountStore()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const configured = isGoogleLoginConfigured()

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const hadLocal = active.kind === 'local' && (await localHasContent())
      await addGoogleAccount()
      ui.close()
      if (hadLocal) ui.open({ kind: 'send-local' })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'O login falhou.')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    await useSyncStore.getState().removeThisDevice()
    await useLibraryStore.getState().forgetCurrent()
    await forgetAccount(active.id)
    setBusy(false)
    ui.close()
    ui.toast('Saiu da conta; o login e o cache dela foram apagados deste navegador')
  }

  return (
    <Popover x={window.innerWidth - 300} y={52} onClose={ui.close} label="Conta">
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
      <div className="hr" />
      <button className="mi" onClick={() => ui.open({ kind: 'settings' })}>
        <Icon name="gear" />
        Configurações
      </button>
      {active.kind === 'google' && (
        <button className="mi" onClick={() => void signOut()} disabled={busy}>
          <Icon name="logout" />
          Sair desta conta
        </button>
      )}
    </Popover>
  )
}
