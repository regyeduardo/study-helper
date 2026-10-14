import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { AvatarButton, SyncPill, UsageLine } from '@/components/layout/Chrome'
import { Crumbs } from '@/components/library/Crumbs'
import { FolderTree } from '@/components/library/FolderTree'
import { SHARING_TITLES } from '@/components/library/SharingLists'
import { folderHitCounts, useLiveLibrary, useSearchHits } from '@/hooks/use-library-view'
import { useViewRoute } from '@/hooks/use-view-route'
import { REVIEW_BELOW } from '@/lib/file-types'
import { paths, type View } from '@/lib/paths'
import { activeLinks } from '@/lib/share'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const VIEW_NAME: Record<View, string> = { home: 'Início', folder: 'Biblioteca', review: 'Para revisar', favorites: 'Favoritos', trash: 'Lixeira', doc: 'Documento', ...SHARING_TITLES }

export function useCounts() {
  const { files } = useLiveLibrary()
  const trashCount = useLibraryStore(state => state.files.filter(file => file.deletedAt).length + state.folders.filter(folder => folder.deletedAt).length)
  const index = useLibraryStore(state => state.index)
  return {
    shares: index.shares.length,
    sharedWithMe: activeLinks(index.sharedWithMe).length,
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
  const { files, folders } = useLiveLibrary()
  const hits = useSearchHits(ui.query)
  const hitCounts = folderHitCounts(hits, files, folders)
  const tagCounts = new Map<string, number>()
  for (const file of files) for (const tag of file.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'))

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
        <nav className="nav">
          {nav('home', 'home', 'Início', paths.home)}
          {nav('review', 'warn', 'Para revisar', paths.review, counts.review)}
          <div className="nh">Pastas</div>
          <FolderTree folders={folders} current={view === 'folder' ? folderId : view === 'doc' ? (doc?.folderId ?? null) : undefined} hits={hitCounts} onGo={() => ui.set({ drawer: false })} />
          {tags.length > 0 && (
            <>
              <div className="nh">Etiquetas</div>
              <ul className="tag-nav" aria-label="Etiquetas">
                {tags.map(([tag, count]) => (
                  <li key={tag}>
                    <button
                      className="nv"
                      aria-pressed={ui.tag === tag}
                      onClick={() => {
                        if (ui.tag !== tag) ui.setTag(tag)
                        navigate(paths.library)
                        ui.set({ drawer: false })
                      }}
                    >
                      {tag}
                      <span className="n">{count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="nav-end">
            {nav('favorites', 'star', 'Favoritos', paths.favorites, counts.favorites)}
            {nav('shares', 'link', SHARING_TITLES.shares, paths.shares, counts.shares)}
            {nav('sharedWithMe', 'user', SHARING_TITLES.sharedWithMe, paths.sharedWithMe, counts.sharedWithMe)}
            <button className="nv" onClick={() => ui.open({ kind: 'media' })}>
              <Icon name="mic" />
              Mídias
            </button>
            {nav('trash', 'trash', 'Lixeira', paths.trash, counts.trash)}
            <button className="nv" onClick={() => ui.open({ kind: 'settings' })}>
              <Icon name="gear" />
              Configurações
            </button>
          </div>
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
