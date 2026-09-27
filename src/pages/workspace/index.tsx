import { useViewRoute } from '@/hooks/use-view-route'
import { useLibraryStore } from '@/stores/library'
import { ColumnsWorkspace } from '@/pages/workspace/container/columns'
import { CommandsWorkspace } from '@/pages/workspace/container/commands'
import { FocusWorkspace } from '@/pages/workspace/container/focus'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'

export default function WorkspacePage() {
  const route = useViewRoute()
  const layout = useLibraryStore(state => state.index.settings.layout)
  if (layout === 'columns') return <ColumnsWorkspace route={route} />
  if (layout === 'commands') return <CommandsWorkspace route={route} />
  if (layout === 'focus') return <FocusWorkspace route={route} />
  return <ReaderWorkspace route={route} />
}
