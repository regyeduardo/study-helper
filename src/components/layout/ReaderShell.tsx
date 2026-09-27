import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { AvatarButton, RecentList, SyncPill, UsageLine } from '@/components/layout/Chrome'
import { Crumbs } from '@/components/library/Crumbs'
import { useLiveLibrary } from '@/hooks/use-library-view'
import { useViewRoute } from '@/hooks/use-view-route'
import { REVIEW_BELOW } from '@/lib/file-types'
import { paths, type View } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const VIEW_NAME: Record<View, string> = { home: 'Início', folder: 'Biblioteca', review: 'Para revisar', favorites: 'Favoritos', trash: 'Lixeira', doc: 'Documento' }

export function useCounts() {
  const { files } = useLiveLibrary()
  const trashCount = useLibraryStore(state => state.files.filter(file => file.deletedAt).length + state.folders.filter(folder => folder.deletedAt).length)
  return {
    library: files.length,
    review: files.filter(file => file.mastery !== null && file.mastery < REVIEW_BELOW).length,
    favorites: files.filter(file => file.favorite).length,
    trash: trashCount,
  }
}

export function ReaderShell({ children, docActions }: { children: ReactNode; docActions?: ReactNode }) {
  const { view, folderId, fileId } = useViewRoute()
  const navigate = useNavigate()
  const ui = useUiStore()
  const counts = useCounts()
  const doc = useLibraryStore(state => (fileId ? state.files.find(file => file.id === fileId) : undefined))

  const nav = (target: View, icon: Parameters<typeof Icon>[0]['name'], label: string, to: string, count?: number) => (
    <button className="nv" aria-current={view === target} onClick={() => (navigate(to), ui.set({ drawer: false }))}>
      <Icon name={icon} />
      {label}
      <span className="n">{count ?? ''}</span>
    </button>
  )

  return (
    <div className={`app c1 ${ui.leftOpen ? '' : 'no-left'} ${ui.drawer ? 'drawer' : ''}`}>
      <aside className="sb" aria-label="Navegação">
        <div className="brand">
          <span className="mark">E</span>Estudo
          <button className="ibtn" onClick={() => ui.set({ leftOpen: false, drawer: false })} aria-label="Recolher a lateral" title="Recolher a lateral ( [ )">
            <Icon name="sidebar" />
          </button>
        </div>
        <button className="srch" onClick={() => ui.open({ kind: 'palette' })}>
          <Icon name="search" />
          <span className="t">Buscar ou fazer algo</span>
          <span className="kbd">Ctrl K</span>
        </button>
        <nav className="nav">
          {nav('home', 'home', 'Início', paths.home)}
          {nav('folder', 'book', 'Biblioteca', paths.library, counts.library)}
          {nav('review', 'warn', 'Para revisar', paths.review, counts.review)}
          {nav('favorites', 'star', 'Favoritos', paths.favorites, counts.favorites)}
          {nav('trash', 'trash', 'Lixeira', paths.trash, counts.trash)}
          <button className="nv" onClick={() => ui.open({ kind: 'settings' })}>
            <Icon name="gear" />
            Configurações
          </button>
          <div className="nh">Recentes</div>
          <RecentList currentId={fileId} />
        </nav>
        <div className="foot">
          <SyncPill />
          <UsageLine />
        </div>
      </aside>
      <main onClickCapture={() => ui.drawer && ui.set({ drawer: false })}>
        <header className="top">
          {!ui.leftOpen && (
            <button className="ibtn" onClick={() => ui.set({ leftOpen: true })} aria-label="Mostrar a lateral">
              <Icon name="sidebar" />
            </button>
          )}
          <button className="ibtn mob-only" onClick={() => ui.set({ drawer: !ui.drawer })} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <button className="ibtn" onClick={() => navigate(-1)} aria-label="Voltar">
            <Icon name="back" />
          </button>
          <button className="ibtn hide-narrow" onClick={() => navigate(1)} aria-label="Avançar">
            <Icon name="fwd" />
          </button>
          {view === 'doc' && doc ? <Crumbs folderId={doc.folderId} tail={doc.name} /> : view === 'folder' ? <Crumbs folderId={folderId} /> : <div className="crumbs"><span className="cur">{VIEW_NAME[view]}</span></div>}
          <div className="spacer" />
          {docActions}
          <button className={`btn ${view === 'doc' ? 'hide-narrow-doc' : ''}`} onClick={() => ui.open({ kind: 'record' })}>
            <Icon name="rec" />
            <span className="lbl">Gravar</span>
          </button>
          <button className="btn primary" onClick={() => ui.open({ kind: 'new', folderId: view === 'folder' ? folderId : doc?.folderId })}>
            <Icon name="plus" />
            <span className="lbl">Novo</span>
          </button>
          <AvatarButton />
        </header>
        <div className="body">{children}</div>
      </main>
    </div>
  )
}
