import { useEffect, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'

import type { SharedItem } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { OpeningWait } from '@/components/ui/OpeningWait'
import { fetchLiveContent } from '@/controllers/live-share.controller'
import { fetchSharedItemController } from '@/controllers/share.controller'
import type { ViewRoute } from '@/hooks/use-view-route'
import { nowIso } from '@/lib/ids'
import { isExpired, linkMediaState, liveSharedItem, readSharedAttempts } from '@/lib/share'
import { useLibraryStore } from '@/stores/library'

/** How often a link whose media is still going up is read again, to show the media as soon as it is there. */
export const sharedPoll = { ms: 5000 }

type LoadState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; item: SharedItem }

/** Why the last link of each address did not open (spec 007): the page says it in words. */
const refusals = new Map<string, string>()

/** A link of the App first (read as it is now, spec 003, história 7); one the App does not know is a link of the share-worker, as before. */
async function openLink(shareId: string): Promise<SharedItem | null> {
  const live = await fetchLiveContent(shareId)
  if (live && 'gone' in live) {
    refusals.set(shareId, live.gone)
    return null
  }
  if (live) return liveSharedItem(live).catch(() => null)
  return fetchSharedItemController(shareId)
}

function sharedRoute(item: SharedItem, pathname: string): ViewRoute {
  const [, , , section, id] = pathname.split('/')
  // the entrada of the link opens its page, as in one's own library (FR-067)
  const isEntry = (fileId: string) => item.files.some(file => file.id === fileId && file.meta?.role === 'entrada')
  if (section === 'arquivo' && id) return { view: isEntry(id) ? 'entry' : 'doc', folderId: null, fileId: id }
  if (section === 'pasta' && id) return { view: 'folder', folderId: id, fileId: null }
  if (item.kind === 'entrada') return { view: 'entry', folderId: null, fileId: (item.files.find(file => isEntry(file.id)) ?? item.files[0]).id }
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
    void openLink(shareId).then(item => {
      if (!alive) return
      if (!item || !item.files.length || isExpired(item.expiresAt)) {
        setState({ kind: 'unavailable' })
        return
      }
      enterShared(item, readSharedAttempts(item.id))
      document.documentElement.dataset.shared = 'true'
      setState({ kind: 'ready', item })
      if (!ownShares.some(share => share.id === item.id)) void rememberSharedLink({ id: item.id, kind: item.kind, title: item.title, openedAt: nowIso(), expiresAt: item.expiresAt, ...(item.live ? { live: true } : {}) }).catch(() => undefined)
    })
    return () => {
      alive = false
      delete document.documentElement.dataset.shared
      leaveShared()
    }
  }, [shareId])

  // the sharer is still sending the media: the page asks again until it is there (or past its days), instead of staying as it was when opened
  const waiting = state.kind === 'ready' && linkMediaState(state.item).kind === 'pending'
  useEffect(() => {
    if (!waiting) return
    let alive = true
    const timer = window.setInterval(() => {
      void fetchSharedItemController(shareId).then(item => {
        if (!alive || !item) return
        if (linkMediaState(item).kind === 'pending') return
        enterShared(item, readSharedAttempts(item.id))
        setState({ kind: 'ready', item })
      })
    }, sharedPoll.ms)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [waiting, shareId])

  if (state.kind !== 'ready') return { view: 'shared', folderId: null, fileId: null, shareId, unavailable: state.kind === 'unavailable' }
  return sharedRoute(state.item, pathname)
}

const REFUSALS: Record<string, { title: string; text: string }> = {
  link_expired: { title: 'Este link venceu', text: 'Peça um link novo a quem compartilhou.' },
  share_stopped: { title: 'Este item deixou de ser compartilhado', text: 'Quem compartilhou parou de compartilhar. Peça um link novo.' },
  item_removed: { title: 'O item foi removido', text: 'Quem compartilhou tirou este item da biblioteca.' },
}

export function SharedStatus({ unavailable }: { unavailable: boolean }) {
  const { shareId = '' } = useParams()
  if (!unavailable) {
    return (
      <div className="empty">
        <OpeningWait kind="abrir-link" what="Abrindo o compartilhamento" history="aberturas de link" />
      </div>
    )
  }
  return (
    <div className="empty" role="alert">
      <Icon name="warn" />
      <div>
        <b>{REFUSALS[refusals.get(shareId) ?? '']?.title ?? 'Item indisponível'}</b>
        <div className="muted">{REFUSALS[refusals.get(shareId) ?? '']?.text ?? 'O link expirou ou quem compartilhou apagou.'}</div>
      </div>
    </div>
  )
}
