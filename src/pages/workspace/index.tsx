import { useViewRoute, type ViewRoute } from '@/hooks/use-view-route'
import { useSharedRoute } from '@/pages/shared'
import { useLibraryStore } from '@/stores/library'
import { ColumnsWorkspace } from '@/pages/workspace/container/columns'
import { CommandsWorkspace } from '@/pages/workspace/container/commands'
import { FocusWorkspace } from '@/pages/workspace/container/focus'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'

function Layout({ route }: { route: ViewRoute }) {
  const layout = useLibraryStore(state => state.index.settings.layout)
  if (layout === 'columns') return <ColumnsWorkspace route={route} />
  if (layout === 'commands') return <CommandsWorkspace route={route} />
  if (layout === 'focus') return <FocusWorkspace route={route} />
  return <ReaderWorkspace route={route} />
}

function SharedWorkspace({ shareId }: { shareId: string }) {
  return <Layout route={useSharedRoute(shareId)} />
}

export default function WorkspacePage() {
  const route = useViewRoute()
  return route.view === 'shared' && route.shareId ? <SharedWorkspace key={route.shareId} shareId={route.shareId} /> : <Layout route={route} />
}
