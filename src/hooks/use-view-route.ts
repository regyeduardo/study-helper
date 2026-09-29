import { useLocation, useParams } from 'react-router-dom'

import type { View } from '@/lib/paths'

export interface ViewRoute {
  view: View
  folderId: string | null
  fileId: string | null
  shareId?: string
  unavailable?: boolean
}

export function useViewRoute(): ViewRoute {
  const { folderId = null, fileId = null, shareId } = useParams()
  const { pathname } = useLocation()
  if (pathname.startsWith('/shared/')) return { view: 'shared', folderId: null, fileId, shareId }
  if (pathname.startsWith('/arquivo/')) return { view: 'doc', folderId: null, fileId }
  if (pathname.startsWith('/biblioteca')) return { view: 'folder', folderId, fileId: null }
  if (pathname.startsWith('/revisar')) return { view: 'review', folderId: null, fileId: null }
  if (pathname.startsWith('/favoritos')) return { view: 'favorites', folderId: null, fileId: null }
  if (pathname.startsWith('/lixeira')) return { view: 'trash', folderId: null, fileId: null }
  if (pathname.startsWith('/compartilhados-comigo')) return { view: 'sharedWithMe', folderId: null, fileId: null }
  if (pathname.startsWith('/compartilhados')) return { view: 'shares', folderId: null, fileId: null }
  return { view: 'home', folderId: null, fileId: null }
}
