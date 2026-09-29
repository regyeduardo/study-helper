import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

import type { SharedItem } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { fetchSharedItemController } from '@/controllers/share.controller'
import type { ViewRoute } from '@/hooks/use-view-route'
import { nowIso } from '@/lib/ids'
import { isExpired, readSharedAttempts } from '@/lib/share'
import { useLibraryStore } from '@/stores/library'

type LoadState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; item: SharedItem }

function sharedRoute(item: SharedItem, pathname: string): ViewRoute {
  const [, , , section, id] = pathname.split('/')
  if (section === 'arquivo' && id) return { view: 'doc', folderId: null, fileId: id }
  if (section === 'pasta' && id) return { view: 'folder', folderId: id, fileId: null }
  if (item.kind === 'file') return { view: 'doc', folderId: null, fileId: item.files[0].id }
  return { view: 'folder', folderId: item.folders.find(folder => folder.parentId === null)?.id ?? null, fileId: null }
}

export function useSharedRoute(shareId: string): ViewRoute {
  const { pathname } = useLocation()
  const enterShared = useLibraryStore(state => state.enterShared)
  const leaveShared = useLibraryStore(state => state.leaveShared)
  const ownShares = useLibraryStore(state => state.index.shares)
  const rememberSharedLink = useLibraryStore(state => state.rememberSharedLink)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    void fetchSharedItemController(shareId).then(item => {
      if (!alive) return
      if (!item || !item.files.length || isExpired(item.expiresAt)) {
        setState({ kind: 'unavailable' })
        return
      }
      enterShared(item, readSharedAttempts(item.id))
      document.documentElement.dataset.shared = 'true'
      setState({ kind: 'ready', item })
      if (!ownShares.some(share => share.id === item.id)) void rememberSharedLink({ id: item.id, kind: item.kind, title: item.title, openedAt: nowIso(), expiresAt: item.expiresAt }).catch(() => undefined)
    })
    return () => {
      alive = false
      delete document.documentElement.dataset.shared
      leaveShared()
    }
  }, [shareId])

  if (state.kind !== 'ready') return { view: 'shared', folderId: null, fileId: null, shareId, unavailable: state.kind === 'unavailable' }
  return sharedRoute(state.item, pathname)
}

export function SharedStatus({ unavailable }: { unavailable: boolean }) {
  if (!unavailable) {
    return (
      <div className="empty" role="status">
        Abrindo o compartilhamento…
      </div>
    )
  }
  return (
    <div className="empty" role="alert">
      <Icon name="warn" />
      <div>
        <b>Item indisponível</b>
        <div className="muted">O link expirou ou quem compartilhou apagou.</div>
      </div>
    </div>
  )
}
