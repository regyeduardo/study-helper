import { useEffect, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'

import { Overlays } from '@/components/dialogs/Overlays'
import { ItemMenu } from '@/components/library/ItemMenu'
import { Toasts } from '@/components/ui/Toasts'
import { paths } from '@/lib/paths'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'

function useShortcuts() {
  const ui = useUiStore()
  const navigate = useNavigate()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"]')
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        ui.open({ kind: 'palette' })
        return
      }
      if (typing || ui.overlay) return
      if (event.key === 'Escape') {
        if (ui.selection.size) ui.clearSelection()
        else if (ui.peekId) ui.set({ peekId: null })
      }
      if (event.key === '[') ui.set({ leftOpen: !ui.leftOpen })
      if (event.key === ']') ui.set({ rightOpen: !ui.rightOpen })
      if (event.key === 'n') ui.open({ kind: 'new' })
      if (event.key === 'r') ui.open({ kind: 'record' })
      if (event.key === ',') ui.open({ kind: 'settings' })
      if (event.key === 'g') navigate(paths.library)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui, navigate])
}

export default function App() {
  const account = useAccountStore(state => state.active())
  const tokenFor = useAccountStore(state => state.tokenFor)
  const { ready, loadError, connect } = useLibraryStore()
  const reauthorize = useAccountStore(state => state.reauthorize)
  const [reauthError, setReauthError] = useState<string | null>(null)
  const startSync = useSyncStore(state => state.start)
  const stopSync = useSyncStore(state => state.stop)
  useShortcuts()

  useEffect(() => {
    let current = true
    stopSync()
    void connect(account.id, account.kind === 'google' ? () => tokenFor(account.id) : undefined).then(() => {
      if (current) startSync()
    })
    return () => {
      current = false
    }
  }, [account.id])

  return (
    <div className="app-root">
      {ready ? (
        loadError ? (
          <div className="welcome">
            <h1>Não consegui abrir a biblioteca</h1>
            <p className="muted">{loadError}</p>
            {reauthError && <p style={{ color: 'var(--bad)' }}>{reauthError}</p>}
            <button className="btn primary" onClick={() => void connect(account.id, account.kind === 'google' ? () => tokenFor(account.id) : undefined).then(startSync)}>
              Tentar de novo
            </button>
            {account.kind === 'google' && (
              <button
                className="btn"
                onClick={async () => {
                  setReauthError(null)
                  try {
                    await reauthorize(account.id)
                    await connect(account.id, () => tokenFor(account.id))
                    startSync()
                  } catch (error) {
                    setReauthError(error instanceof Error ? error.message : 'O login falhou.')
                  }
                }}
              >
                Entrar de novo no Google
              </button>
            )}
            <button className="btn" onClick={() => useAccountStore.getState().switchTo('local')}>
              Usar o perfil Local
            </button>
          </div>
        ) : (
          <Outlet />
        )
      ) : (
        <div className="welcome" role="status">
          <span className="muted">Abrindo a biblioteca{account.kind === 'google' ? ' no Google Drive' : ''}…</span>
        </div>
      )}
      <Overlays />
      <ItemMenu />
      <Toasts />
    </div>
  )
}
