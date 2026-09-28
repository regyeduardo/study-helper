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

export function useShortcuts() {
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
      if (typing || ui.overlay || event.ctrlKey || event.metaKey || event.altKey) return
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
  const reconnectId = useAccountStore(state => state.reconnectId)
  const reconnectMessage = useAccountStore(state => state.reconnectMessage)
  const [reauthError, setReauthError] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const startSync = useSyncStore(state => state.start)
  const stopSync = useSyncStore(state => state.stop)
  useShortcuts()

  const tokenProvider = account.kind === 'google' ? (options?: { force?: boolean }) => tokenFor(account.id, options) : undefined
  const needsReconnect = account.kind === 'google' && reconnectId === account.id

  useEffect(() => {
    let current = true
    stopSync()
    void connect(account.id, tokenProvider).then(() => {
      if (current) startSync()
    })
    return () => {
      current = false
    }
  }, [account.id])

  const reconnect = async () => {
    setReauthError(null)
    setReconnecting(true)
    try {
      await reauthorize(account.id)
      if (useLibraryStore.getState().loadError) await connect(account.id, tokenProvider)
      startSync()
    } catch (error) {
      setReauthError(error instanceof Error ? error.message : 'O login falhou.')
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <div className="app-root">
      {ready ? (
        loadError ? (
          <div className="welcome">
            <h1>Não consegui abrir a biblioteca</h1>
            <p className="muted">{loadError}</p>
            {reauthError && <p style={{ color: 'var(--bad)' }}>{reauthError}</p>}
            {needsReconnect ? (
              <button className="btn primary" disabled={reconnecting} onClick={() => void reconnect()}>
                Reconectar
              </button>
            ) : (
              <button className="btn primary" onClick={() => void connect(account.id, tokenProvider).then(startSync)}>
                Tentar de novo
              </button>
            )}
            {account.kind === 'google' && !needsReconnect && (
              <button className="btn" disabled={reconnecting} onClick={() => void reconnect()}>
                Entrar de novo no Google
              </button>
            )}
            <button className="btn" onClick={() => useAccountStore.getState().switchTo('local')}>
              Usar o perfil Local
            </button>
          </div>
        ) : (
          <>
            {needsReconnect && (
              <div className="reconnect-bar" role="alert">
                <span>{reauthError ?? reconnectMessage}</span>
                <button className="btn primary" disabled={reconnecting} onClick={() => void reconnect()}>
                  Reconectar
                </button>
              </div>
            )}
            <Outlet />
          </>
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
