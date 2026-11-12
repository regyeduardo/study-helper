import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { useViewRoute, type ViewRoute } from '@/hooks/use-view-route'
import { paths } from '@/lib/paths'
import { useSharedRoute } from '@/pages/shared'
import { useLibraryStore } from '@/stores/library'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'

/** The app has one layout, the Leitor; a layout saved before (Colunas, Comandos, Foco) is ignored. */
function Layout({ route }: { route: ViewRoute }) {
  return <ReaderWorkspace route={route} />
}

function SharedWorkspace({ shareId }: { shareId: string }) {
  return <Layout route={useSharedRoute(shareId)} />
}

export default function WorkspacePage() {
  const route = useViewRoute()
  const navigate = useNavigate()
  const trashed = useLibraryStore(state => (route.view === 'doc' || route.view === 'entry') && Boolean(state.files.find(file => file.id === route.fileId)?.deletedAt))
  useEffect(() => {
    if (trashed) navigate(paths.library, { replace: true })
  }, [trashed])
  return route.view === 'shared' && route.shareId ? <SharedWorkspace key={route.shareId} shareId={route.shareId} /> : <Layout route={route} />
}
