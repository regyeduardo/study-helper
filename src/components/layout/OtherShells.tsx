import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { Avatar, AvatarButton, RecentList, SyncPill, UsageLine } from '@/components/layout/Chrome'
import { useCounts } from '@/components/layout/ReaderShell'
import { Crumbs, UpButton } from '@/components/library/Crumbs'
import { useViewRoute } from '@/hooks/use-view-route'
import { paths, type View } from '@/lib/paths'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function ColumnsShell({ children }: { children: ReactNode }) {
  const { view, fileId } = useViewRoute()
  const navigate = useNavigate()
  const ui = useUiStore()
  const counts = useCounts()
  const account = useAccountStore(state => state.active())
  const pane = view === 'doc' ? ui.columnsPane : ui.columnsPane === 'doc' ? 'list' : ui.columnsPane
  const nav = (target: View, icon: Parameters<typeof Icon>[0]['name'], label: string, to: string, count?: number) => (
    <button className="nv" aria-current={view === target} onClick={() => (navigate(to), ui.set({ columnsPane: 'list' }))}>
      <Icon name={icon} />
      {label}
      <span className="n">{count ?? ''}</span>
    </button>
  )
  return (
    <div className={`app c2 pane-${pane}`}>
      <aside className="col-nav" aria-label="Coleções">
        <button className="who" onClick={() => ui.open({ kind: 'account' })}>
          <Avatar />
          <div>
            <b>{account.name}</b>
            <small>{account.email}</small>
          </div>
          <Icon name="chev" />
        </button>
        <nav className="nav">
          {nav('folder', 'book', 'Biblioteca', paths.library, counts.library)}
          {nav('review', 'warn', 'Para revisar', paths.review, counts.review)}
          {nav('favorites', 'star', 'Favoritos', paths.favorites, counts.favorites)}
          {nav('trash', 'trash', 'Lixeira', paths.trash, counts.trash)}
          <div className="nh">Recentes</div>
          <RecentList currentId={fileId} />
        </nav>
        <div className="foot">
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => ui.open({ kind: 'new' })}>
              <Icon name="plus" />
              Novo
            </button>
            <button className="btn" onClick={() => ui.open({ kind: 'record' })} aria-label="Gravar reunião">
              <Icon name="rec" />
            </button>
            <button className="btn" onClick={() => ui.open({ kind: 'settings' })} aria-label="Configurações">
              <Icon name="gear" />
            </button>
          </div>
          <SyncPill />
          <UsageLine />
        </div>
      </aside>
      {children}
    </div>
  )
}

export function CommandsShell({ children }: { children: ReactNode }) {
  const { view, folderId, fileId } = useViewRoute()
  const navigate = useNavigate()
  const ui = useUiStore()
  const account = useAccountStore(state => state.active())
  const doc = useLibraryStore(state => (fileId ? state.files.find(file => file.id === fileId) : undefined))
  return (
    <div className="app c3">
      <header className="top">
        <button className="ws" onClick={() => ui.open({ kind: 'account' })}>
          <Avatar />
          {account.name}
          <Icon name="chev" />
        </button>
        <button className="ibtn" onClick={() => navigate(-1)} aria-label="Voltar">
          <Icon name="back" />
        </button>
        {view === 'folder' && <UpButton folderId={folderId} />}
        {view === 'doc' && doc ? <Crumbs folderId={doc.folderId} tail={doc.name} /> : view === 'folder' ? <Crumbs folderId={folderId} /> : <div className="crumbs"><span className="cur">Biblioteca</span></div>}
        <button className="cmdk" onClick={() => ui.open({ kind: 'palette' })}>
          <Icon name="search" />
          <span className="t">Buscar, abrir ou fazer algo</span>
          <span className="kbd">Ctrl K</span>
        </button>
        <SyncPill />
        <button className="btn" onClick={() => ui.open({ kind: 'record' })} aria-label="Gravar reunião">
          <Icon name="rec" />
        </button>
        <button className="btn primary" onClick={() => ui.open({ kind: 'new', folderId: view === 'folder' ? folderId : doc?.folderId })}>
          <Icon name="plus" />
          Novo
        </button>
      </header>
      {children}
    </div>
  )
}

export function FocusShell({ children, dock }: { children: ReactNode; dock?: ReactNode }) {
  const { view } = useViewRoute()
  const navigate = useNavigate()
  const ui = useUiStore()
  const top = view === 'doc' ? 'doc' : view === 'home' ? 'home' : 'lib'
  return (
    <div className="app c4">
      <header className="top">
        <span className="brand">estudo</span>
        <nav>
          <button aria-current={top === 'home'} onClick={() => navigate(paths.home)}>
            Hoje
          </button>
          <button aria-current={top === 'lib'} onClick={() => navigate(paths.library)}>
            Biblioteca
          </button>
        </nav>
        <span className="spacer" />
        <button className="ibtn" onClick={() => ui.open({ kind: 'palette' })} aria-label="Buscar ou fazer algo" title="Ctrl K">
          <Icon name="search" />
        </button>
        <button className="ibtn" onClick={() => ui.open({ kind: 'new' })} aria-label="Novo conteúdo">
          <Icon name="plus" />
        </button>
        <button className="ibtn" onClick={() => ui.open({ kind: 'record' })} aria-label="Gravar reunião">
          <Icon name="rec" />
        </button>
        <button className="ibtn" onClick={() => ui.open({ kind: 'settings' })} aria-label="Configurações">
          <Icon name="gear" />
        </button>
        <SyncPill />
        <AvatarButton />
      </header>
      {children}
      {dock}
    </div>
  )
}
